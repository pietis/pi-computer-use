import { completeSimple } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	ensureComputerUseSetup,
	executeAct,
	executeTransitionAct,
	type ActParams,
	type UiAction,
} from "./bridge.ts";
import {
	acquireRoot,
	launchApp,
	resolveAppTarget,
	type RootCandidate,
	type ResolvedAppTarget,
	type RootSnapshot,
} from "./plan-once.ts";

type HybridAction = Omit<UiAction, "action"> & {
	action: "press" | "click" | "setText" | "typeText" | "keypress" | "scroll";
};

interface CheckedDecision {
	action: HybridAction;
	expect?: {
		ref?: string;
		text?: string;
		role?: string;
		value?: string;
		until?: "present" | "absent";
		timeoutMs?: number;
	};
	refreshRootAfter: boolean;
	reason: string;
}

interface HybridRound {
	index: number;
	gptMs: number;
	action?: HybridAction;
	nativeMs?: number;
	outcome?: string;
}

export interface HybridCuaReport {
	ok: boolean;
	app: string;
	bundleId?: string;
	task: string;
	gptModel: string;
	windowTitle: string;
	finalStateId?: string;
	completionEvidence?: string;
	error?: string;
	timings: {
		totalMs: number;
		targetResolutionMs: number;
		setupMs: number;
		launchMs: number;
		rootAcquireMs: number;
		rootSelectionMode: "single" | "deterministic" | "model";
		rootCandidateCount: number;
		rootSelectionGptCalls: number;
		rootSelectionGptMs: number;
		initialObservationMs: number;
		gptCalls: number;
		gptTotalMs: number;
		nativeTotalMs: number;
		rounds: HybridRound[];
	};
}

const MAX_ROUNDS = 8;

const GPT_SYSTEM_PROMPT = `You are the semantic controller for a fast macOS accessibility agent.
Return exactly one compact JSON object and no markdown or narration.

Execute schema:
{"decision":"execute","confidence":0.0,"reason":"short","action":{"action":"press|click|setText|typeText|keypress|scroll","ref":"@eN","text":"exact task text","keys":["cmd","n"],"scrollX":0,"scrollY":500},"refreshRootAfter":false}

Done schema:
{"decision":"done","confidence":0.0,"reason":"short","evidence":"exact text copied from the current outline"}

Rules:
- Choose one state transition only.
- Use only refs in the current outline.
- Preserve exact user-provided text. Only compose new text when the task explicitly asks you to write or generate content.
- Use refreshRootAfter=true when an action creates, replaces, or closes a root.
- Do not save, close, quit, delete, send, purchase, or touch another app unless positively requested.
- Never repeat an action listed in blockedActions; it already produced no semantic state change.
- Choose done only when the entire task is complete, not merely one sub-step, and exact current-outline evidence proves the resulting state.
- Report honest confidence; deterministic ref, content, and risk checks independently gate every action.`;

const ROOT_SELECTION_SYSTEM_PROMPT = `You select exactly one current macOS accessibility root.
Return exactly one compact JSON object and no markdown:
{"rootRef":"@rN","reason":"short"}

Rules:
- Use only a rootRef from candidates.
- Select the root that best matches the complete task and target app.
- Prefer a blocking modal root when it belongs to the target app.
- When candidates are semantically interchangeable, prefer focused, then main, then onscreen.
- Never select another app unless the task explicitly requires it.`;

function now(): number {
	return performance.now();
}

function roundMs(value: number): number {
	return Math.round(value * 100) / 100;
}

function boundedOutline(outline: string): string {
	const trimmed = outline.trim();
	return trimmed.length <= 8_000 ? trimmed : `${trimmed.slice(0, 7_999)}…`;
}

function taskLiterals(task: string): string[] {
	const values: string[] = [];
	for (const pattern of [/"([^"\r\n]+)"/g, /“([^”\r\n]+)”/g, /'([^'\r\n]+)'/g, /‘([^’\r\n]+)’/g]) {
		for (const match of task.matchAll(pattern)) {
			const value = match[1]?.trim();
			if (value && !values.includes(value)) values.push(value);
		}
	}
	return values.slice(0, 16);
}

function textFromResponse(response: Awaited<ReturnType<typeof completeSimple>>): string {
	return response.content
		.filter((part): part is Extract<(typeof response.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function jsonObject(text: string): Record<string, unknown> | undefined {
	const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	try {
		const value = JSON.parse(normalized);
		return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} catch {
		const start = normalized.indexOf("{");
		const end = normalized.lastIndexOf("}");
		if (start < 0 || end <= start) return undefined;
		try {
			const value = JSON.parse(normalized.slice(start, end + 1));
			return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
		} catch {
			return undefined;
		}
	}
}

async function requestGptRootSelection(
	ctx: ExtensionCommandContext,
	task: string,
	target: ResolvedAppTarget,
	candidates: RootCandidate[],
): Promise<{ rootRef: string; latencyMs: number }> {
	const startedAt = now();
	if (!ctx.model) throw new Error("No GPT root-selection model is selected.");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${ctx.model.provider}.` : auth.error);
	const response = await completeSimple(
		ctx.model,
		{
			systemPrompt: ROOT_SELECTION_SYSTEM_PROMPT,
			messages: [{
				role: "user",
				content: JSON.stringify({
					task,
					targetApp: target,
					candidates: candidates.map((candidate) => ({
						rootRef: candidate.windowRef,
						app: candidate.app,
						bundleId: candidate.bundleId,
						kind: candidate.kind,
						title: candidate.windowTitle,
						focused: candidate.isFocused,
						main: candidate.isMain,
						modal: candidate.isModal,
						onscreen: candidate.isOnscreen,
						minimized: candidate.isMinimized,
					})),
				}),
				timestamp: Date.now(),
			}],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			maxTokens: 160,
			maxRetries: 0,
			timeoutMs: 15_000,
			signal: ctx.signal,
		},
	);
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(response.errorMessage ?? `GPT root selection stopped with ${response.stopReason}.`);
	}
	const raw = jsonObject(textFromResponse(response));
	const rootRef = typeof raw?.rootRef === "string" ? raw.rootRef : "";
	if (!candidates.some((candidate) => candidate.windowRef === rootRef)) {
		throw new Error(`GPT root selection returned unavailable ref '${rootRef || "(empty)"}'.`);
	}
	return { rootRef, latencyMs: now() - startedAt };
}

function outlineLine(snapshot: RootSnapshot, ref: string | undefined): string | undefined {
	if (!ref || !/^@e\d+$/.test(ref)) return undefined;
	const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`);
	return snapshot.outline.split("\n").find((line) => pattern.test(line));
}

function capabilities(line: string | undefined): Set<string> {
	const raw = line?.match(/(?:\[([^\[\]]*)\]|\{([^{}]*)\})\s*$/)?.slice(1).find(Boolean) ?? "";
	const result = new Set<string>();
	for (const value of raw.split(",").map((item) => item.trim()).filter(Boolean)) {
		result.add(value);
		const lower = value.toLocaleLowerCase();
		if (lower === "axpress") result.add("press");
		if (lower === "axsetvalue") {
			result.add("setValue");
			result.add("setText");
		}
		if (lower === "axscroll") result.add("scroll");
	}
	return result;
}

function normalized(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function actionSignature(action: HybridAction): string {
	return JSON.stringify(action);
}

function semanticFingerprint(snapshot: RootSnapshot): string {
	return `${normalized(snapshot.windowTitle)}\n${snapshot.outline.normalize("NFC").trim()}`;
}

function taskExplicitlyAllowsRisk(task: string, kind: "save" | "close" | "quit" | "delete" | "send"): boolean {
	const text = normalized(task);
	const negatives: Record<typeof kind, RegExp> = {
		save: /저장하지|저장\s*하지|do not save|don't save|without saving/,
		close: /닫지|do not close|don't close/,
		quit: /종료하지|do not quit|don't quit/,
		delete: /삭제하지|do not delete|don't delete/,
		send: /전송하지|보내지|do not send|don't send/,
	};
	if (negatives[kind].test(text)) return false;
	const positives: Record<typeof kind, RegExp> = {
		save: /저장|save/,
		close: /닫|close/,
		quit: /종료|quit/,
		delete: /삭제|delete|remove/,
		send: /전송|보내|send/,
	};
	return positives[kind].test(text);
}

function riskReason(action: HybridAction, line: string | undefined, task: string): string | undefined {
	const keys = action.action === "keypress" ? new Set(action.keys?.map((key) => key.toLowerCase())) : new Set<string>();
	if (keys.has("cmd") && keys.has("s") && !taskExplicitlyAllowsRisk(task, "save")) return "saving was not positively requested";
	if (keys.has("cmd") && keys.has("w") && !taskExplicitlyAllowsRisk(task, "close")) return "closing was not positively requested";
	if (keys.has("cmd") && keys.has("q") && !taskExplicitlyAllowsRisk(task, "quit")) return "quitting was not positively requested";
	const target = normalized(line ?? "");
	if (/(save|저장)/.test(target) && !taskExplicitlyAllowsRisk(task, "save")) return "save target is blocked";
	if (/(close|닫기)/.test(target) && !taskExplicitlyAllowsRisk(task, "close")) return "close target is blocked";
	if (/(delete|remove|삭제)/.test(target) && !taskExplicitlyAllowsRisk(task, "delete")) return "delete target is blocked";
	if (/(send|submit|전송|보내기)/.test(target) && !taskExplicitlyAllowsRisk(task, "send")) return "send target is blocked";
	return undefined;
}

function sanitizeAction(raw: unknown): HybridAction | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const source = raw as Record<string, unknown>;
	const ref = typeof source.ref === "string" ? source.ref.trim() : undefined;
	if (source.action === "press" && ref) return { action: "press", ref };
	if (source.action === "click" && ref) {
		return {
			action: "click",
			ref,
			button: source.button === "right" || source.button === "middle" ? source.button : "left",
			clickCount: Number.isFinite(source.clickCount) ? Math.max(1, Math.min(3, Math.trunc(Number(source.clickCount)))) : 1,
		};
	}
	if (source.action === "setText" && ref && typeof source.text === "string") return { action: "setText", ref, text: source.text };
	if (source.action === "typeText" && typeof source.text === "string") return { action: "typeText", ref, text: source.text };
	if (source.action === "keypress" && Array.isArray(source.keys)) {
		const keys = source.keys.map(String).map((key) => key.trim()).filter(Boolean).slice(0, 8);
		return keys.length ? { action: "keypress", ref, keys } : undefined;
	}
	if (source.action === "scroll") {
		const scrollX = Number.isFinite(source.scrollX) ? Number(source.scrollX) : 0;
		const scrollY = Number.isFinite(source.scrollY) ? Number(source.scrollY) : 0;
		return scrollX || scrollY ? { action: "scroll", ref, scrollX, scrollY } : undefined;
	}
	return undefined;
}

function validateAction(
	action: HybridAction,
	snapshot: RootSnapshot,
	task: string,
	literals: string[],
	options: { blockedActions: Set<string> },
): { decision?: CheckedDecision; reason: string } {
	if (options.blockedActions.has(actionSignature(action))) {
		return { reason: "this action already produced no semantic state change" };
	}
	const line = "ref" in action ? outlineLine(snapshot, action.ref) : undefined;
	if ("ref" in action && action.ref && !line) return { reason: `ref ${action.ref} is not in the current outline` };
	const risk = riskReason(action, line, task);
	if (risk) return { reason: risk };
	const caps = capabilities(line);

	if (action.action === "setText" || action.action === "typeText") {
		const text = action.text ?? "";
		const exact = literals.includes(text) || (text.length > 0 && task.includes(text));
		if (!text.trim()) return { reason: "text action is empty" };
		if (!exact && literals.length > 0) return { reason: "text does not preserve an explicit task literal" };
		if (text.length > 4_000) return { reason: "text action exceeds the 4000-character safety limit" };
		const editableRole = /\bAX(?:TextArea|TextField|SearchField|ComboBox)\b/.test(line ?? "");
		if (action.action === "setText" && !caps.has("setText") && !caps.has("setValue") && !editableRole) {
			return { reason: "target is not editable by setText" };
		}
		return {
			decision: {
				action,
				expect: action.ref ? { ref: action.ref, value: text, until: "present", timeoutMs: 2_000 } : undefined,
				refreshRootAfter: false,
				reason: "exact literal and editable target passed the deterministic gate",
			},
			reason: "accepted exact text action",
		};
	}
	if (action.action === "keypress") {
		const keys = action.keys?.map((key) => key.toLowerCase()) ?? [];
		return {
			decision: {
				action,
				refreshRootAfter: keys.includes("cmd") && ["n", "w", "q"].some((key) => keys.includes(key)),
				reason: "shortcut passed ref and safety validation",
			},
			reason: "accepted keypress",
		};
	}
	if (action.action === "press" || action.action === "click") {
		return { decision: { action, refreshRootAfter: false, reason: "current semantic ref passed target and safety validation" }, reason: "accepted semantic action" };
	}
	if (action.action === "scroll") {
		return { decision: { action, refreshRootAfter: false, reason: "bounded scroll passed validation" }, reason: "accepted scroll" };
	}
	return { reason: "unsupported action" };
}

async function requestGptDecision(
	ctx: ExtensionCommandContext,
	task: string,
	target: ResolvedAppTarget,
	snapshot: RootSnapshot,
	history: HybridAction[],
	literals: string[],
	blockedActions: Set<string>,
): Promise<{ decision?: CheckedDecision; doneEvidence?: string; latencyMs: number; error?: string }> {
	const startedAt = now();
	try {
		if (!ctx.model) throw new Error("No GPT fallback model is selected.");
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${ctx.model.provider}.` : auth.error);
		const packet = {
			task,
			app: target.app,
			windowTitle: snapshot.windowTitle,
			stateId: snapshot.stateId,
			exactLiterals: literals,
			previousActions: history.slice(-4),
			blockedActions: [...blockedActions].map((value) => JSON.parse(value)),
			outline: boundedOutline(snapshot.outline),
		};
		const response = await completeSimple(
			ctx.model,
			{
				systemPrompt: GPT_SYSTEM_PROMPT,
				messages: [{ role: "user", content: JSON.stringify(packet), timestamp: Date.now() }],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				maxTokens: 700,
				maxRetries: 0,
				timeoutMs: 15_000,
				signal: ctx.signal,
			},
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage ?? `GPT stopped with ${response.stopReason}.`);
		const raw = jsonObject(textFromResponse(response));
		if (!raw) throw new Error("GPT returned invalid JSON.");
		if (raw.decision === "done") {
			const evidence = typeof raw.evidence === "string" ? raw.evidence : "";
			if (!evidence || !snapshot.outline.normalize("NFC").includes(evidence.normalize("NFC"))) throw new Error("GPT completion evidence is absent from the current outline.");
			return { doneEvidence: evidence, latencyMs: now() - startedAt };
		}
		if (raw.decision !== "execute") throw new Error("GPT returned an unsupported decision.");
		const action = sanitizeAction(raw.action);
		if (!action) throw new Error("GPT returned an invalid action.");
		const checked = validateAction(action, snapshot, task, literals, { blockedActions });
		if (!checked.decision) {
			const targetLine = "ref" in action ? outlineLine(snapshot, action.ref) : undefined;
			throw new Error(`GPT action failed safety validation: ${checked.reason}; action=${JSON.stringify(action)}; target=${JSON.stringify(targetLine)}.`);
		}
		checked.decision.refreshRootAfter = raw.refreshRootAfter === true || checked.decision.refreshRootAfter;
		checked.decision.reason = typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.trim().slice(0, 400) : checked.decision.reason;
		return { decision: checked.decision, latencyMs: now() - startedAt };
	} catch (error) {
		return { latencyMs: now() - startedAt, error: error instanceof Error ? error.message : String(error) };
	}
}

function updatedSnapshot(previous: RootSnapshot, details: Record<string, unknown>): RootSnapshot {
	const capture = details.capture as { stateId?: unknown } | undefined;
	const target = details.target as { windowTitle?: unknown } | undefined;
	return {
		...previous,
		stateId: typeof capture?.stateId === "string" ? capture.stateId : previous.stateId,
		windowTitle: typeof target?.windowTitle === "string" ? target.windowTitle : previous.windowTitle,
		outline: typeof details.renderedOutline === "string" ? details.renderedOutline : previous.outline,
	};
}

export async function runHybridCuaTask(
	input: { app: string; bundleId?: string; task: string },
	ctx: ExtensionCommandContext,
): Promise<HybridCuaReport> {
	const totalStartedAt = now();
	const rounds: HybridRound[] = [];
	const history: HybridAction[] = [];
	const blockedActions = new Set<string>();
	const literals = taskLiterals(input.task);
	let target: ResolvedAppTarget = { app: input.app || "(auto)", bundleId: input.bundleId };
	let snapshot: RootSnapshot | undefined;
	let targetResolutionMs = 0;
	let setupMs = 0;
	let launchMs = 0;
	let rootAcquireMs = 0;
	let rootSelectionMode: "single" | "deterministic" | "model" = "deterministic";
	let rootCandidateCount = 0;
	let rootSelectionGptCalls = 0;
	let rootSelectionGptMs = 0;
	let initialObservationMs = 0;
	let nativeTotalMs = 0;
	try {
		const targetStartedAt = now();
		target = await resolveAppTarget(input);
		targetResolutionMs = now() - targetStartedAt;

		const setupStartedAt = now();
		await ensureComputerUseSetup(ctx, ctx.signal);
		setupMs = now() - setupStartedAt;

		const launchStartedAt = now();
		await launchApp(target.app, target.bundleId, target.appPath, ctx.signal);
		launchMs = now() - launchStartedAt;

		const acquired = await acquireRoot(
			target.app,
			target.bundleId,
			ctx,
			ctx.signal,
			async (candidates) => {
				rootSelectionGptCalls += 1;
				const selectionStartedAt = now();
				try {
					const selected = await requestGptRootSelection(ctx, input.task, target, candidates);
					return selected.rootRef;
				} finally {
					rootSelectionGptMs += now() - selectionStartedAt;
				}
			},
		);
		snapshot = acquired.snapshot;
		rootAcquireMs = acquired.timings.rootAcquireMs;
		rootSelectionMode = acquired.timings.rootSelectionMode;
		rootCandidateCount = acquired.timings.rootCandidateCount;
		initialObservationMs = acquired.timings.observeMs;
		for (let index = 0; index < MAX_ROUNDS; index += 1) {
			const gpt = await requestGptDecision(
				ctx,
				input.task,
				target,
				snapshot,
				history,
				literals,
				blockedActions,
			);
			const round: HybridRound = {
				index: index + 1,
				gptMs: roundMs(gpt.latencyMs),
				action: gpt.decision?.action,
			};
			rounds.push(round);
			if (gpt.doneEvidence) {
				return buildReport(true, target, input.task, snapshot, rounds, {
					totalStartedAt,
					targetResolutionMs,
					setupMs,
						launchMs,
						rootAcquireMs,
						rootSelectionMode,
						rootCandidateCount,
						rootSelectionGptCalls,
						rootSelectionGptMs,
						initialObservationMs,
					nativeTotalMs,
					gptModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)",
					completionEvidence: gpt.doneEvidence,
				});
			}
			if (!gpt.decision) throw new Error(`GPT controller failed: ${gpt.error ?? "no safe decision"}`);
			const decision = gpt.decision;

			const previousFingerprint = semanticFingerprint(snapshot);
			const nativeStartedAt = now();
			if (decision.refreshRootAfter) {
				const transitioned = await executeTransitionAct({ stateId: snapshot.stateId, actions: [decision.action] } satisfies ActParams, ctx.signal, ctx);
				round.outcome = transitioned.outcome;
				if (transitioned.outcome === "didnt") throw new Error(`Round ${index + 1} transition action failed.`);
				snapshot = (await acquireRoot(target.app, target.bundleId, ctx, ctx.signal)).snapshot;
			} else {
				const result = await executeAct(
					`hybrid-act-${index + 1}`,
					{ stateId: snapshot.stateId, actions: [decision.action], expect: decision.expect } satisfies ActParams,
					ctx.signal,
					undefined,
					ctx,
				);
				const details = result.details as unknown as Record<string, unknown>;
				const execution = details.execution as { outcome?: unknown } | undefined;
				round.outcome = typeof execution?.outcome === "string" ? execution.outcome : undefined;
				if (round.outcome === "didnt") throw new Error(`Round ${index + 1} action failed delivery or verification.`);
				snapshot = updatedSnapshot(snapshot, details);
			}
			round.nativeMs = roundMs(now() - nativeStartedAt);
			nativeTotalMs += round.nativeMs;
			history.push(decision.action);
			if (semanticFingerprint(snapshot) === previousFingerprint) {
				blockedActions.add(actionSignature(decision.action));
			}
		}
		throw new Error(`Hybrid loop exceeded the ${MAX_ROUNDS}-round safety limit.`);
	} catch (error) {
		return buildReport(false, target, input.task, snapshot, rounds, {
			totalStartedAt,
			targetResolutionMs,
			setupMs,
				launchMs,
				rootAcquireMs,
				rootSelectionMode,
				rootCandidateCount,
				rootSelectionGptCalls,
				rootSelectionGptMs,
				initialObservationMs,
			nativeTotalMs,
			gptModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)",
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function buildReport(
	ok: boolean,
	target: ResolvedAppTarget,
	task: string,
	snapshot: RootSnapshot | undefined,
	rounds: HybridRound[],
	values: {
		totalStartedAt: number;
		targetResolutionMs: number;
		setupMs: number;
		launchMs: number;
		rootAcquireMs: number;
		rootSelectionMode: "single" | "deterministic" | "model";
		rootCandidateCount: number;
		rootSelectionGptCalls: number;
		rootSelectionGptMs: number;
		initialObservationMs: number;
		nativeTotalMs: number;
		gptModel: string;
		completionEvidence?: string;
		error?: string;
	},
): HybridCuaReport {
	const controllerGptMs = rounds.reduce((sum, round) => sum + round.gptMs, 0);
	const gptTotalMs = controllerGptMs + values.rootSelectionGptMs;
	return {
		ok,
		app: target.app,
		bundleId: target.bundleId,
		task,
		gptModel: values.gptModel,
		windowTitle: snapshot?.windowTitle ?? "(unknown)",
		finalStateId: snapshot?.stateId,
		completionEvidence: values.completionEvidence,
		error: values.error,
		timings: {
			totalMs: roundMs(now() - values.totalStartedAt),
			targetResolutionMs: roundMs(values.targetResolutionMs),
			setupMs: roundMs(values.setupMs),
			launchMs: roundMs(values.launchMs),
			rootAcquireMs: roundMs(values.rootAcquireMs),
			rootSelectionMode: values.rootSelectionMode,
			rootCandidateCount: values.rootCandidateCount,
			rootSelectionGptCalls: values.rootSelectionGptCalls,
			rootSelectionGptMs: roundMs(values.rootSelectionGptMs),
			initialObservationMs: roundMs(values.initialObservationMs),
			gptCalls: rounds.length + values.rootSelectionGptCalls,
			gptTotalMs: roundMs(gptTotalMs),
			nativeTotalMs: roundMs(values.nativeTotalMs),
			rounds,
		},
	};
}

export function formatHybridCuaReport(report: HybridCuaReport): string {
	return JSON.stringify(report, null, 2);
}
