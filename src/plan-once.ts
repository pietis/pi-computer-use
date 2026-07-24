import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { streamSimple } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	executeAct,
	executeFind,
	executeObserve,
	executeSearchUi,
	executeTransitionAct,
	executeWaitFor,
	type ActParams,
	type UiAction,
} from "./bridge.ts";

export interface PlanSelector {
	text?: string;
	role?: string;
	capability?: string;
}

export interface PlanAction {
	action: "press" | "click" | "setText" | "typeText" | "keypress" | "scroll";
	selector: PlanSelector;
	text?: string;
	keys?: string[];
	clickCount?: number;
	scrollX?: number;
	scrollY?: number;
}

export interface PlanCondition {
	selector?: PlanSelector;
	text?: string;
	role?: string;
	value?: string;
	until?: "present" | "absent";
	timeoutMs?: number;
}

export interface PlanPhase {
	actions: PlanAction[];
	expect?: PlanCondition;
	refreshRootAfter?: boolean;
}

export interface PlanOncePlan {
	version: 1;
	phases: PlanPhase[];
}

export interface RootSnapshot {
	rootRef: string;
	stateId: string;
	outline: string;
	windowTitle: string;
	framePoints?: { x: number; y: number; w: number; h: number };
}

export interface RootTimings {
	rootAcquireMs: number;
	rootSelectionMs: number;
	rootSelectionMode: "single" | "deterministic" | "model";
	rootCandidateCount: number;
	observeMs: number;
}

export interface RootCandidate {
	app: string;
	bundleId?: string;
	kind: string;
	windowTitle: string;
	windowRef: string;
	isMain: boolean;
	isFocused: boolean;
	isModal: boolean;
	isOnscreen: boolean;
	isMinimized: boolean;
}

export type RootCandidateSelector = (candidates: RootCandidate[]) => Promise<string>;

export interface ResolvedAppTarget {
	app: string;
	bundleId?: string;
	appPath?: string;
}

export interface PlanPhaseTiming {
	index: number;
	selectorResolutionMs: number;
	actionTotalMs: number;
	deliveryMs?: number;
	verificationMs?: number;
	settleMs?: number;
	successorObservationMs?: number;
	resultBuildMs?: number;
	refreshRootMs: number;
	postRefreshVerificationMs: number;
	outcome?: string;
}

export interface PlanOnceReport {
	ok: boolean;
	app: string;
	bundleId?: string;
	task: string;
	model: string;
	plan: PlanOncePlan;
	windowTitle: string;
	finalStateId?: string;
	error?: string;
	timings: {
		totalMs: number;
		targetResolutionMs: number;
		setupMs: number;
		launchMs: number;
		rootAcquireMs: number;
		initialObservationMs: number;
		authMs: number;
		planningMs: number;
		planningTtftMs?: number;
		planParseMs: number;
		nativeExecutionMs: number;
		phases: PlanPhaseTiming[];
	};
}

const PLANNER_SYSTEM_PROMPT = `You are a fast macOS accessibility execution planner.
Return exactly one compact JSON object, with no markdown and no prose.
The runtime has already launched and semantically observed the one target app. It will execute every phase itself without another model call.

Schema:
{"version":1,"phases":[{"actions":[{"action":"press|click|setText|typeText|keypress|scroll","selector":{"text":"optional label/value","role":"optional AX role","capability":"optional capability"},"text":"for setText/typeText","keys":["for keypress"],"clickCount":1,"scrollX":0,"scrollY":500}],"expect":{"selector":{"text":"optional","role":"optional","capability":"optional"},"text":"optional observed text","role":"optional exact role","value":"optional exact value","until":"present|absent","timeoutMs":2000},"refreshRootAfter":false}]}

Rules:
- Use only the supplied schema and 1-6 phases.
- Every action needs a semantic selector that matches an element already present in the supplied outline.
- Copy role names from the outline exactly. Never use a subrole such as AXStandardWindow as a role.
- Put predictable actions that keep the same root in one phase.
- If an action creates or replaces a window, end that phase and set refreshRootAfter=true.
- A postcondition for refreshRootAfter may describe an element that only exists in the successor root.
- Keyboard shortcuts that replace a root should target a currently available, safely focusable element in the current root.
- When the final expected value exactly equals the text being entered, use setText rather than focus-dependent typeText.
- The final phase must have a concrete observable expect condition.
- Preserve exact user-provided text.
- Do not save, close, quit, or touch another app unless the user explicitly requests it.
- Do not include reasoning.`;

const execFileAsync = promisify(execFile);

function normalizedAppText(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function mdlsValue(output: string, key: string): string | undefined {
	const match = new RegExp(`^${key}\\s+=\\s+(?:\"([\\s\\S]*?)\"|([^\\n]+))$`, "m").exec(output);
	const value = (match?.[1] ?? match?.[2] ?? "").trim();
	return value && value !== "(null)" ? value : undefined;
}

async function macApplicationCatalog(): Promise<Array<ResolvedAppTarget & { aliases: string[] }>> {
	const { stdout } = await execFileAsync("mdfind", ['kMDItemContentType == "com.apple.application-bundle"'], { maxBuffer: 4 * 1024 * 1024 });
	const roots = ["/Applications/", "/System/Applications/", "/System/Library/CoreServices/"];
	if (process.env.HOME) roots.push(`${process.env.HOME}/Applications/`);
	const paths = [...new Set(stdout.split("\n")
		.map((entry) => entry.trim())
		.filter((entry) => entry.endsWith(".app") && roots.some((root) => entry.startsWith(root)))
		.filter((entry) => !entry.includes("/Contents/") && !entry.includes("/Resources/")))];
	const entries = await Promise.all(paths.map(async (appPath) => {
		const canonical = path.basename(appPath, ".app");
		try {
			const metadata = await execFileAsync("mdls", ["-name", "kMDItemDisplayName", "-name", "kMDItemCFBundleIdentifier", appPath], { maxBuffer: 64 * 1024 });
			const display = mdlsValue(metadata.stdout, "kMDItemDisplayName");
			const bundleId = mdlsValue(metadata.stdout, "kMDItemCFBundleIdentifier");
			if (bundleId === "com.injaneity.pi-computer-use") return undefined;
			const aliases = [...new Set([canonical, display].filter((value): value is string => Boolean(value)))];
			return { app: canonical, bundleId, appPath, aliases };
		} catch {
			if (canonical === "pi-computer-use") return undefined;
			return { app: canonical, appPath, aliases: [canonical] };
		}
	}));
	return entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
}

export async function resolveAppTarget(input: { app: string; bundleId?: string; task: string }): Promise<ResolvedAppTarget> {
	if (process.platform !== "darwin") {
		if (!input.app) throw new Error("Automatic app resolution currently requires macOS; pass --app.");
		return { app: input.app, bundleId: input.bundleId };
	}
	if (input.app.trim() && input.bundleId?.trim()) {
		return { app: input.app.trim(), bundleId: input.bundleId.trim() };
	}
	const catalog = await macApplicationCatalog();
	const requested = normalizedAppText(input.app);
	if (requested) {
		const match = catalog.find((entry) => entry.aliases.some((alias) => normalizedAppText(alias) === requested))
			?? catalog.find((entry) => normalizedAppText(entry.bundleId ?? "") === normalizedAppText(input.bundleId ?? ""));
		return match
			? { app: match.app, bundleId: input.bundleId ?? match.bundleId, appPath: match.appPath }
			: { app: input.app, bundleId: input.bundleId };
	}
	const task = normalizedAppText(input.task
		.replace(/"[^"]*"/g, " ")
		.replace(/'[^']*'/g, " ")
		.replace(/[“‘][^”’]*[”’]/g, " "));
	const candidates = catalog.flatMap((entry) => entry.aliases
		.map((alias) => ({ entry, alias: normalizedAppText(alias) }))
		.filter(({ alias }) => alias.length >= 2 && task.includes(alias)))
		.sort((a, b) => b.alias.length - a.alias.length);
	const best = candidates[0]?.entry;
	if (!best) {
		throw new Error("Could not identify one installed target app from the task. Name the app in the prompt or pass --app.");
	}
	return { app: best.app, bundleId: best.bundleId, appPath: best.appPath };
}

function now(): number {
	return performance.now();
}

function roundMs(value: number): number {
	return Math.round(value * 100) / 100;
}

function textFromResponse(response: Awaited<ReturnType<ReturnType<typeof streamSimple>["result"]>>): string {
	return response.content
		.filter((part): part is Extract<(typeof response.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function nonEmptyString(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function parseSelector(value: unknown): PlanSelector {
	if (!value || typeof value !== "object") throw new Error("Every planned action requires a selector.");
	const raw = value as Record<string, unknown>;
	const selector = {
		text: nonEmptyString(raw.text, 256),
		role: nonEmptyString(raw.role, 128),
		capability: nonEmptyString(raw.capability, 128),
	};
	if (!selector.text && !selector.role && !selector.capability) throw new Error("A plan selector must contain text, role, or capability.");
	return selector;
}

function parsePlanAction(value: unknown): PlanAction {
	if (!value || typeof value !== "object") throw new Error("Plan actions must be objects.");
	const raw = value as Record<string, unknown>;
	if (!["press", "click", "setText", "typeText", "keypress", "scroll"].includes(String(raw.action))) throw new Error(`Unsupported planned action '${String(raw.action)}'.`);
	const action = raw.action as PlanAction["action"];
	const text = action === "setText" || action === "typeText" ? (typeof raw.text === "string" ? raw.text : undefined) : undefined;
	if ((action === "setText" || action === "typeText") && text === undefined) throw new Error(`${action} requires text.`);
	if (text && text.length > 10_000) throw new Error(`${action} text exceeds 10000 characters.`);
	const keys = action === "keypress" && Array.isArray(raw.keys)
		? raw.keys.map((key) => String(key).trim()).filter(Boolean).slice(0, 8)
		: undefined;
	if (action === "keypress" && (!keys || keys.length === 0)) throw new Error("keypress requires keys.");
	const scrollX = action === "scroll" && Number.isFinite(raw.scrollX) ? Number(raw.scrollX) : undefined;
	const scrollY = action === "scroll" && Number.isFinite(raw.scrollY) ? Number(raw.scrollY) : undefined;
	if (action === "scroll" && !scrollX && !scrollY) throw new Error("scroll requires a non-zero scrollX or scrollY.");
	return {
		action,
		selector: parseSelector(raw.selector),
		text,
		keys,
		clickCount: action === "click" && Number.isFinite(raw.clickCount) ? Math.max(1, Math.min(3, Math.trunc(raw.clickCount as number))) : undefined,
		scrollX,
		scrollY,
	};
}

function parseCondition(value: unknown): PlanCondition | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object") throw new Error("Plan expect must be an object.");
	const raw = value as Record<string, unknown>;
	const condition: PlanCondition = {
		selector: raw.selector === undefined ? undefined : parseSelector(raw.selector),
		text: nonEmptyString(raw.text, 512),
		role: nonEmptyString(raw.role, 128),
		value: typeof raw.value === "string" ? raw.value : undefined,
		until: raw.until === "absent" ? "absent" : "present",
		timeoutMs: Number.isFinite(raw.timeoutMs) ? Math.max(100, Math.min(60_000, Math.trunc(raw.timeoutMs as number))) : 2_000,
	};
	if (!condition.selector && !condition.text && !condition.role && condition.value === undefined) throw new Error("Plan expect needs a selector, text, role, or value.");
	return condition;
}

export function parsePlanOnceJson(text: string): PlanOncePlan {
	const trimmed = text.trim();
	const unfenced = trimmed.startsWith("```")
		? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
		: trimmed;
	const raw = JSON.parse(unfenced) as Record<string, unknown>;
	if (raw.version !== 1 || !Array.isArray(raw.phases) || raw.phases.length < 1 || raw.phases.length > 6) {
		throw new Error("Planner must return version 1 with 1-6 phases.");
	}
	const phases = raw.phases.map((phaseValue, index): PlanPhase => {
		if (!phaseValue || typeof phaseValue !== "object") throw new Error(`Phase ${index + 1} must be an object.`);
		const phase = phaseValue as Record<string, unknown>;
		if (!Array.isArray(phase.actions) || phase.actions.length < 1 || phase.actions.length > 20) throw new Error(`Phase ${index + 1} requires 1-20 actions.`);
		return {
			actions: phase.actions.map(parsePlanAction),
			expect: parseCondition(phase.expect),
			refreshRootAfter: phase.refreshRootAfter === true,
		};
	});
	if (!phases.at(-1)?.expect) throw new Error("The final plan phase must include an observable expect condition.");
	return { version: 1, phases };
}

export function parsePlanOnceCommandArgs(args: string): { app: string; bundleId?: string; task: string } {
	const divider = /(?:^|\s)--\s/.exec(args);
	if (!divider) throw new Error("Usage: /computer-use-run [--app TextEdit] [--bundle-id com.apple.TextEdit] -- <task>");
	const options = args.slice(0, divider.index);
	const task = args.slice(divider.index + divider[0].length).trim();
	const appMatch = /(?:^|\s)--app(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))(?=\s|$)/.exec(options);
	const bundleMatch = /(?:^|\s)--bundle-id(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))(?=\s|$)/.exec(options);
	const app = (appMatch?.[1] ?? appMatch?.[2] ?? appMatch?.[3] ?? "").trim();
	const bundleId = (bundleMatch?.[1] ?? bundleMatch?.[2] ?? bundleMatch?.[3] ?? "").trim() || undefined;
	if (!task) throw new Error("A task is required.");
	return { app: app || "", bundleId, task };
}

async function runProcess(command: string, args: string[], signal?: AbortSignal): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { stdio: "ignore" });
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error(`App launch timed out: ${command}`));
		}, 10_000);
		const onAbort = () => {
			child.kill("SIGTERM");
			reject(new Error("Operation aborted."));
		};
		const finish = (error?: Error) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			error ? reject(error) : resolve();
		};
		child.once("error", (error) => finish(error));
		child.once("close", (code) => finish(code === 0 ? undefined : new Error(`App launch exited with code ${code}.`)));
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function launchApp(app: string, bundleId?: string, appPath?: string, signal?: AbortSignal): Promise<void> {
	if (process.platform === "darwin") return await runProcess("open", appPath ? [appPath] : bundleId ? ["-b", bundleId] : ["-a", app], signal);
	if (process.platform === "win32") return await runProcess("powershell.exe", ["-NoProfile", "-Command", "Start-Process", "-FilePath", app], signal);
	return await runProcess(app, [], signal);
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

export async function acquireRoot(
	app: string,
	bundleId: string | undefined,
	ctx: ExtensionContext,
	signal?: AbortSignal,
	selectRoot?: RootCandidateSelector,
): Promise<{ snapshot: RootSnapshot; timings: RootTimings }> {
	const acquireStartedAt = now();
	let root: any;
	let rootCandidateCount = 0;
	let rootSelectionMs = 0;
	let rootSelectionMode: RootTimings["rootSelectionMode"] = "deterministic";
	let lastResult: Awaited<ReturnType<typeof executeFind>> | undefined;
	const deadline = Date.now() + 6_000;
	do {
		lastResult = await executeFind("plan-once-find", bundleId ? { bundleId } : { app }, signal, undefined, ctx);
		let windows = (lastResult.details as any)?.windows as any[] | undefined;
		const candidates = (windows ?? []).filter((candidate) => typeof candidate.windowRef === "string") as RootCandidate[];
		rootCandidateCount = candidates.length;
		if (candidates.length === 1) {
			root = candidates[0];
			rootSelectionMode = "single";
		} else if (candidates.length > 1 && selectRoot) {
			const selectionStartedAt = now();
			const selectedRef = await selectRoot(candidates);
			rootSelectionMs += now() - selectionStartedAt;
			root = candidates.find((candidate) => candidate.windowRef === selectedRef);
			if (!root) throw new Error(`Root selector returned unavailable ref '${selectedRef}'.`);
			rootSelectionMode = "model";
		} else {
			root = candidates.find((candidate) => candidate.isFocused)
				?? candidates.find((candidate) => candidate.isMain)
				?? candidates[0];
			rootSelectionMode = "deterministic";
		}
		if (!root?.windowRef) {
			// macOS may localize appName (for example TextEdit) even though
			// `open -a` accepts the unlocalized product name. The app was just
			// activated, so a focused broad root is the safe identity fallback.
			lastResult = await executeFind("plan-once-find-focused", {}, signal, undefined, ctx);
			windows = (lastResult.details as any)?.windows as any[] | undefined;
			const candidates = (windows ?? []).filter((candidate) => typeof candidate.windowRef === "string") as RootCandidate[];
			rootCandidateCount = candidates.length;
			if (candidates.length > 1 && selectRoot) {
				const selectionStartedAt = now();
				const selectedRef = await selectRoot(candidates);
				rootSelectionMs += now() - selectionStartedAt;
				root = candidates.find((candidate) => candidate.windowRef === selectedRef);
				if (!root) throw new Error(`Root selector returned unavailable ref '${selectedRef}'.`);
				rootSelectionMode = "model";
			} else {
				root = candidates.find((candidate) => candidate.isFocused) ?? candidates[0];
				rootSelectionMode = candidates.length === 1 ? "single" : "deterministic";
			}
		}
		if (root?.windowRef) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	if (!root?.windowRef) throw new Error(`No controllable root appeared for '${app}'. ${lastResult ? resultText(lastResult as any) : ""}`.trim());
	const rootAcquireMs = now() - acquireStartedAt - rootSelectionMs;
	const observeStartedAt = now();
	const observed = await executeObserve("plan-once-observe", { root: root.windowRef, mode: "semantic", readText: "never" }, signal, undefined, ctx);
	const details = observed.details as any;
	const stateId = details?.capture?.stateId;
	if (typeof stateId !== "string") throw new Error(`Failed to obtain a desktop state for '${app}'.`);
	return {
		snapshot: {
			rootRef: root.windowRef,
			stateId,
			outline: typeof details.renderedOutline === "string" ? details.renderedOutline : resultText(observed as any),
			windowTitle: typeof details.target?.windowTitle === "string" ? details.target.windowTitle : String(root.windowTitle ?? "(untitled)"),
			framePoints: root.framePoints && Number.isFinite(root.framePoints.x) && Number.isFinite(root.framePoints.y)
				&& Number.isFinite(root.framePoints.w) && Number.isFinite(root.framePoints.h)
				? {
					x: Number(root.framePoints.x),
					y: Number(root.framePoints.y),
					w: Number(root.framePoints.w),
					h: Number(root.framePoints.h),
				}
				: undefined,
		},
		timings: {
			rootAcquireMs,
			rootSelectionMs,
			rootSelectionMode,
			rootCandidateCount,
			observeMs: now() - observeStartedAt,
		},
	};
}

export async function resolveSelector(selector: PlanSelector, stateId: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<string> {
	const findRef = async (candidate: PlanSelector): Promise<string | undefined> => {
		const result = await executeSearchUi("plan-once-search", { ...candidate, stateId }, signal, undefined, ctx);
		const matches = (result.details as any)?.matches as Array<{ ref?: string }> | undefined;
		return matches?.find((match) => typeof match.ref === "string")?.ref;
	};
	const canonicalRole = (() => {
		const role = selector.role?.replace(/^AX/, "").toLowerCase();
		if (role === "standardwindow" || role === "dialog" || role === "sheet") return "window";
		if (role === "textview" || role === "editabletext") return "textArea";
		return undefined;
	})();
	const candidates: PlanSelector[] = [
		selector,
		canonicalRole ? { ...selector, role: canonicalRole } : {},
		selector.text ? { text: selector.text } : {},
		selector.role || selector.capability ? { role: canonicalRole ?? selector.role, capability: selector.capability } : {},
	].filter((candidate) => candidate.text || candidate.role || candidate.capability);
	let ref: string | undefined;
	for (const candidate of candidates) {
		ref = await findRef(candidate);
		if (ref) break;
	}
	if (!ref) throw new Error(`No UI element matched selector ${JSON.stringify(selector)}.`);
	return ref;
}

async function executePhases(plan: PlanOncePlan, initial: RootSnapshot, app: string, bundleId: string | undefined, ctx: ExtensionContext, signal?: AbortSignal): Promise<{
	finalStateId: string;
	windowTitle: string;
	phases: PlanPhaseTiming[];
}> {
	let snapshot = initial;
	const timings: PlanPhaseTiming[] = [];
	for (const [index, phase] of plan.phases.entries()) {
		const selectorStartedAt = now();
		const refs = new Map<string, string>();
		const refFor = async (selector: PlanSelector): Promise<string> => {
			const key = JSON.stringify(selector);
			const cached = refs.get(key);
			if (cached) return cached;
			const ref = await resolveSelector(selector, snapshot.stateId, ctx, signal);
			refs.set(key, ref);
			return ref;
		};
		const actions: UiAction[] = [];
		for (const action of phase.actions) {
			const ref = await refFor(action.selector);
			const normalizedAction = action.action === "typeText"
				&& phase.expect?.value !== undefined
				&& phase.expect.value === action.text
				? "setText"
				: action.action;
			actions.push({
				action: normalizedAction,
				ref,
				text: action.text,
				keys: action.keys,
				clickCount: action.clickCount,
				scrollX: action.scrollX,
				scrollY: action.scrollY,
			});
		}
		const expect = phase.expect && !phase.refreshRootAfter
			? {
				ref: phase.expect.selector ? await refFor(phase.expect.selector) : undefined,
				text: phase.expect.text,
				role: phase.expect.role ?? phase.expect.selector?.role,
				value: phase.expect.value,
				until: phase.expect.until,
				timeoutMs: phase.expect.timeoutMs,
			}
			: undefined;
		const selectorResolutionMs = now() - selectorStartedAt;
		const actionStartedAt = now();
		const result = phase.refreshRootAfter
			? await executeTransitionAct({ stateId: snapshot.stateId, actions } satisfies ActParams, signal, ctx)
			: await executeAct(
				`plan-once-act-${index + 1}`,
				{ stateId: snapshot.stateId, actions, expect } satisfies ActParams,
				signal,
				undefined,
				ctx,
			);
		const actionTotalMs = now() - actionStartedAt;
		const details = phase.refreshRootAfter ? undefined : (result as Awaited<ReturnType<typeof executeAct>>).details as any;
		const transition = phase.refreshRootAfter ? result as Awaited<ReturnType<typeof executeTransitionAct>> : undefined;
		const executionTimings = phase.refreshRootAfter
			? transition?.timings
			: details?.execution?.timings as Record<string, number> | undefined;
		const outcome = phase.refreshRootAfter ? transition?.outcome : details?.execution?.outcome as string | undefined;
		if (!phase.refreshRootAfter) {
			const stateId = details?.capture?.stateId;
			if (typeof stateId !== "string") throw new Error(`Phase ${index + 1} did not return a successor state.`);
			snapshot = {
				...snapshot,
				stateId,
				windowTitle: typeof details.target?.windowTitle === "string" ? details.target.windowTitle : snapshot.windowTitle,
				outline: typeof details.renderedOutline === "string" ? details.renderedOutline : snapshot.outline,
			};
		}
		let refreshRootMs = 0;
		let postRefreshVerificationMs = 0;
		if (phase.refreshRootAfter) {
			const refreshStartedAt = now();
			const refreshed = await acquireRoot(app, bundleId, ctx, signal);
			snapshot = refreshed.snapshot;
			refreshRootMs = now() - refreshStartedAt;
			if (phase.expect) {
				const verificationStartedAt = now();
				const ref = phase.expect.selector
					? await resolveSelector(phase.expect.selector, snapshot.stateId, ctx, signal)
					: undefined;
				if (phase.expect.text || phase.expect.role || phase.expect.value !== undefined) {
					const verified = await executeWaitFor(
						"plan-once-post-refresh-verify",
						{
							stateId: snapshot.stateId,
							ref,
							text: phase.expect.text,
							role: phase.expect.role ?? phase.expect.selector?.role,
							value: phase.expect.value,
							until: phase.expect.until,
							timeoutMs: phase.expect.timeoutMs,
						},
						signal,
						undefined,
						ctx,
					);
					if ((verified.details as any)?.found !== true) throw new Error(`Phase ${index + 1} post-refresh condition was not satisfied.`);
				}
				postRefreshVerificationMs = now() - verificationStartedAt;
			}
		}
		timings.push({
			index: index + 1,
			selectorResolutionMs: roundMs(selectorResolutionMs),
			actionTotalMs: roundMs(actionTotalMs),
			deliveryMs: executionTimings ? roundMs(executionTimings.deliveryMs) : undefined,
			verificationMs: executionTimings && "verificationMs" in executionTimings ? roundMs(executionTimings.verificationMs) : undefined,
			settleMs: executionTimings ? roundMs(executionTimings.settleMs) : undefined,
			successorObservationMs: executionTimings && "successorObservationMs" in executionTimings ? roundMs(executionTimings.successorObservationMs) : undefined,
			resultBuildMs: executionTimings && "resultBuildMs" in executionTimings ? roundMs(executionTimings.resultBuildMs) : undefined,
			refreshRootMs: roundMs(refreshRootMs),
			postRefreshVerificationMs: roundMs(postRefreshVerificationMs),
			outcome,
		});
		if (outcome === "didnt") throw new Error(`Phase ${index + 1} failed its checked action or postcondition.`);
	}
	return { finalStateId: snapshot.stateId, windowTitle: snapshot.windowTitle, phases: timings };
}

export async function runPlanOnceTask(
	input: { app: string; bundleId?: string; task: string },
	ctx: ExtensionCommandContext,
): Promise<PlanOnceReport> {
	const totalStartedAt = now();
	let targetResolutionMs = 0;
	let setupMs = 0;
	let launchMs = 0;
	let rootAcquireMs = 0;
	let initialObservationMs = 0;
	let authMs = 0;
	let planningMs = 0;
	let planningTtftMs: number | undefined;
	let planParseMs = 0;
	let nativeExecutionMs = 0;
	let plan: PlanOncePlan = { version: 1, phases: [] };
	let initial: RootSnapshot | undefined;
	let phases: PlanPhaseTiming[] = [];
	let target: ResolvedAppTarget = { app: input.app || "(auto)", bundleId: input.bundleId };
	try {
		if (!ctx.model) throw new Error("No model is selected.");
		const targetResolutionStartedAt = now();
		target = await resolveAppTarget(input);
		targetResolutionMs = now() - targetResolutionStartedAt;

		const setupStartedAt = now();
		const { ensureComputerUseSetup } = await import("./bridge.ts");
		await ensureComputerUseSetup(ctx, ctx.signal);
		setupMs = now() - setupStartedAt;

		const launchStartedAt = now();
		await launchApp(target.app, target.bundleId, target.appPath, ctx.signal);
		launchMs = now() - launchStartedAt;

		const acquired = await acquireRoot(target.app, target.bundleId, ctx, ctx.signal);
		initial = acquired.snapshot;
		rootAcquireMs = acquired.timings.rootAcquireMs;
		initialObservationMs = acquired.timings.observeMs;

		const authStartedAt = now();
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${ctx.model.provider}.` : auth.error);
		authMs = now() - authStartedAt;

		const planningStartedAt = now();
		const stream = streamSimple(
			ctx.model,
			{
				systemPrompt: PLANNER_SYSTEM_PROMPT,
				messages: [{
					role: "user",
					content: `Task:\n${input.task}\n\nTarget app: ${target.app}${target.bundleId ? ` (${target.bundleId})` : ""}\nInitial semantic AX outline:\n${initial.outline}`,
					timestamp: Date.now(),
				}],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				maxTokens: 1_200,
				maxRetries: 0,
				timeoutMs: 30_000,
				signal: ctx.signal,
			},
		);
		for await (const event of stream) {
			if (planningTtftMs === undefined && event.type === "text_delta" && event.delta) planningTtftMs = now() - planningStartedAt;
		}
		const response = await stream.result();
		planningMs = now() - planningStartedAt;
		if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage ?? `Planner stopped with ${response.stopReason}.`);

		const parseStartedAt = now();
		plan = parsePlanOnceJson(textFromResponse(response));
		planParseMs = now() - parseStartedAt;

		const nativeStartedAt = now();
		const executed = await executePhases(plan, initial, target.app, target.bundleId, ctx, ctx.signal);
		nativeExecutionMs = now() - nativeStartedAt;
		phases = executed.phases;
		return {
			ok: true,
			app: target.app,
			bundleId: target.bundleId,
			task: input.task,
			model: `${ctx.model.provider}/${ctx.model.id}`,
			plan,
			windowTitle: executed.windowTitle,
			finalStateId: executed.finalStateId,
			timings: {
				totalMs: roundMs(now() - totalStartedAt),
				targetResolutionMs: roundMs(targetResolutionMs),
				setupMs: roundMs(setupMs),
				launchMs: roundMs(launchMs),
				rootAcquireMs: roundMs(rootAcquireMs),
				initialObservationMs: roundMs(initialObservationMs),
				authMs: roundMs(authMs),
				planningMs: roundMs(planningMs),
				planningTtftMs: planningTtftMs === undefined ? undefined : roundMs(planningTtftMs),
				planParseMs: roundMs(planParseMs),
				nativeExecutionMs: roundMs(nativeExecutionMs),
				phases,
			},
		};
	} catch (error) {
		return {
			ok: false,
			app: target.app,
			bundleId: target.bundleId,
			task: input.task,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)",
			plan,
			windowTitle: initial?.windowTitle ?? "(unknown)",
			error: error instanceof Error ? error.message : String(error),
			timings: {
				totalMs: roundMs(now() - totalStartedAt),
				targetResolutionMs: roundMs(targetResolutionMs),
				setupMs: roundMs(setupMs),
				launchMs: roundMs(launchMs),
				rootAcquireMs: roundMs(rootAcquireMs),
				initialObservationMs: roundMs(initialObservationMs),
				authMs: roundMs(authMs),
				planningMs: roundMs(planningMs),
				planningTtftMs: planningTtftMs === undefined ? undefined : roundMs(planningTtftMs),
				planParseMs: roundMs(planParseMs),
				nativeExecutionMs: roundMs(nativeExecutionMs),
				phases,
			},
		};
	}
}

export function formatPlanOnceReport(report: PlanOnceReport): string {
	return JSON.stringify(report, null, 2);
}
