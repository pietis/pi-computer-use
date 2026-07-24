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
	resolveSelector,
	type ResolvedAppTarget,
	type RootSnapshot,
} from "./plan-once.ts";

type LocalActionName =
	| "click_point"
	| "press_element"
	| "set_text"
	| "type_text"
	| "keypress"
	| "scroll"
	| "drag_point"
	| "observe_root"
	| "stop";

interface LocalFunctionCall {
	name: LocalActionName;
	arguments: Record<string, unknown>;
}

interface LocalRoundTiming {
	index: number;
	source?: "explicit_native" | "functiongemma";
	modelMs: number;
	promptTokens?: number;
	completionTokens?: number;
	action?: LocalFunctionCall;
	nativeMs?: number;
	outcome?: string;
}

export interface FunctionGemmaCuaReport {
	ok: boolean;
	app: string;
	bundleId?: string;
	task: string;
	model: string;
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
		rounds: LocalRoundTiming[];
	};
}

const MODEL_ID = "mlx-community/functiongemma-270m-it-4bit";
const DEVELOPER_PROMPT = "You are a model that can do function calling with the following functions";
const ACTION_NAMES: LocalActionName[] = [
	"click_point",
	"press_element",
	"set_text",
	"type_text",
	"keypress",
	"scroll",
	"drag_point",
	"observe_root",
	"stop",
];

const TOOLS = [
	{
		type: "function",
		function: {
			name: "click_point",
			description: "Click a normalized point in the current controlled UI root.",
			parameters: {
				type: "object",
				properties: {
					x: { type: "number", description: "Normalized horizontal coordinate from 0 to 1." },
					y: { type: "number", description: "Normalized vertical coordinate from 0 to 1." },
					button: { type: "string", enum: ["left", "right"] },
					count: { type: "integer", minimum: 1, maximum: 3 },
				},
				required: ["x", "y", "button", "count"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "press_element",
			description: "Press an actionable accessibility element by its current ref.",
			parameters: {
				type: "object",
				properties: { ref: { type: "string" } },
				required: ["ref"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "set_text",
			description: "Set an editable accessibility element from an exact input literal.",
			parameters: {
				type: "object",
				properties: { ref: { type: "string" }, value_ref: { type: "string" } },
				required: ["ref", "value_ref"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "type_text",
			description: "Type an exact input literal into the currently focused control.",
			parameters: {
				type: "object",
				properties: { value_ref: { type: "string" } },
				required: ["value_ref"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "keypress",
			description: "Send a normalized keyboard shortcut to the current target.",
			parameters: {
				type: "object",
				properties: {
					keys: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 },
					ref: { type: "string", description: "Current target ref when one is available." },
				},
				required: ["keys"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "scroll",
			description: "Scroll the current controlled UI root.",
			parameters: {
				type: "object",
				properties: { dx: { type: "number" }, dy: { type: "number" } },
				required: ["dx", "dy"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "drag_point",
			description: "Drag the pointer to a normalized destination point.",
			parameters: {
				type: "object",
				properties: {
					x: { type: "number" },
					y: { type: "number" },
					duration: { type: "number", minimum: 0 },
				},
				required: ["x", "y"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "observe_root",
			description: "Observe a newly appeared or stale UI root before another semantic action.",
			parameters: {
				type: "object",
				properties: { root: { type: "string" } },
				required: [],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "stop",
			description: "Stop the task after success or when safe completion is impossible.",
			parameters: {
				type: "object",
				properties: {
					status: { type: "string", enum: ["success", "failure"] },
					reason: { type: "string" },
				},
				required: ["status"],
			},
		},
	},
] as const;

const ALLOWED_ARGUMENTS: Record<LocalActionName, ReadonlySet<string>> = {
	click_point: new Set(["x", "y", "button", "count"]),
	press_element: new Set(["ref"]),
	set_text: new Set(["ref", "value_ref"]),
	type_text: new Set(["value_ref"]),
	keypress: new Set(["keys", "ref"]),
	scroll: new Set(["dx", "dy"]),
	drag_point: new Set(["x", "y", "duration"]),
	observe_root: new Set(["root"]),
	stop: new Set(["status", "reason"]),
};

function now(): number {
	return performance.now();
}

function roundMs(value: number): number {
	return Math.round(value * 100) / 100;
}

function taskLiterals(task: string): Record<string, string> {
	const literals: string[] = [];
	const patterns = [/"([^"\r\n]+)"/g, /'([^'\r\n]+)'/g, /“([^”\r\n]+)”/g, /‘([^’\r\n]+)’/g];
	for (const pattern of patterns) {
		for (const match of task.matchAll(pattern)) {
			const value = match[1]?.trim();
			if (value && !literals.includes(value)) literals.push(value);
		}
	}
	return Object.fromEntries(literals.slice(0, 16).map((value, index) => [`l${index}`, value]));
}

function boundedObservation(outline: string): string {
	const normalized = outline.replace(/\s+$/gm, "").trim();
	return normalized.length <= 6_000 ? normalized : `${normalized.slice(0, 5_999)}…`;
}

function hasRef(snapshot: RootSnapshot, value: unknown): value is string {
	return typeof value === "string" && new RegExp(`(?:^|\\s)${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`, "m").test(snapshot.outline);
}

function finiteNumber(value: unknown): number | undefined {
	return Number.isFinite(value) ? Number(value) : undefined;
}

async function requestAction(
	serverUrl: string,
	goal: string,
	target: { app: string; bundleId?: string },
	snapshot: RootSnapshot,
	literals: Record<string, string>,
	previousActions: string[],
	allowedActions: LocalActionName[],
	semanticTarget: { ref: string; role: string; value: string; capabilities: string[] } | undefined,
	signal: AbortSignal,
): Promise<{ action: LocalFunctionCall; modelMs: number; promptTokens?: number; completionTokens?: number }> {
	const current = semanticTarget
		? { app: target.app, elements: [semanticTarget] }
		: {
			app: target.app,
			bundle_id: target.bundleId,
			window_title: snapshot.windowTitle,
			root: snapshot.rootRef,
			state_id: snapshot.stateId,
		};
	const state = {
		goal,
		platform: process.platform === "darwin" ? "Darwin" : process.platform,
		current,
		...(Object.keys(literals).length ? { literals } : {}),
		observation: semanticTarget
			? `The current AX outline contains ${semanticTarget.ref} ${semanticTarget.role} value=${JSON.stringify(semanticTarget.value)} with setText capability.`
			: boundedObservation(snapshot.outline),
		previous_actions: semanticTarget ? [] : previousActions.slice(-2),
		allowed_actions: ACTION_NAMES,
	};
	const startedAt = now();
	const response = await fetch(`${serverUrl.replace(/\/$/, "")}/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: "Bearer local",
		},
		body: JSON.stringify({
			model: MODEL_ID,
			messages: [
				{ role: "developer", content: DEVELOPER_PROMPT },
				{ role: "user", content: JSON.stringify(state) },
			],
			tools: TOOLS,
			temperature: 0,
			max_tokens: 96,
		}),
		signal,
	});
	const body = await response.json() as {
		error?: { message?: string };
		choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string | Record<string, unknown> } }> } }>;
		usage?: { prompt_tokens?: number; completion_tokens?: number };
	};
	const modelMs = now() - startedAt;
	if (!response.ok) throw new Error(body.error?.message ?? `Local model server returned HTTP ${response.status}.`);
	const fn = body.choices?.[0]?.message?.tool_calls?.[0]?.function;
	if (!fn?.name || !ACTION_NAMES.includes(fn.name as LocalActionName)) throw new Error("FunctionGemma did not return one supported tool call.");
	let parsedArguments: Record<string, unknown>;
	try {
		parsedArguments = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) as Record<string, unknown> : (fn.arguments ?? {});
	} catch {
		throw new Error(`FunctionGemma returned malformed arguments for '${fn.name}'.`);
	}
	const name = fn.name as LocalActionName;
	if (!allowedActions.includes(name)) throw new Error(`FunctionGemma selected out-of-stage action '${name}'.`);
	const allowed = ALLOWED_ARGUMENTS[name];
	const sanitized = Object.fromEntries(Object.entries(parsedArguments).filter(([key]) => allowed.has(key)));
	return {
		action: { name, arguments: sanitized },
		modelMs,
		promptTokens: body.usage?.prompt_tokens,
		completionTokens: body.usage?.completion_tokens,
	};
}

async function editableRef(snapshot: RootSnapshot, ctx: ExtensionCommandContext): Promise<string | undefined> {
	try {
		return await resolveSelector({ role: "textArea", capability: "setValue" }, snapshot.stateId, ctx, ctx.signal);
	} catch {
		try {
			return await resolveSelector({ capability: "setValue" }, snapshot.stateId, ctx, ctx.signal);
		} catch {
			return undefined;
		}
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

export async function runFunctionGemmaCuaTask(
	input: { app: string; bundleId?: string; task: string },
	ctx: ExtensionCommandContext,
): Promise<FunctionGemmaCuaReport> {
	const totalStartedAt = now();
	const serverUrl = process.env.PI_COMPUTER_USE_LOCAL_URL ?? "http://127.0.0.1:18080/v1";
	const rounds: LocalRoundTiming[] = [];
	let target: ResolvedAppTarget = { app: input.app || "(auto)", bundleId: input.bundleId };
	let snapshot: RootSnapshot | undefined;
	let targetResolutionMs = 0;
	let setupMs = 0;
	let launchMs = 0;
	let rootAcquireMs = 0;
	let initialObservationMs = 0;
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

		const acquired = await acquireRoot(target.app, target.bundleId, ctx, ctx.signal);
		snapshot = acquired.snapshot;
		rootAcquireMs = acquired.timings.rootAcquireMs;
		initialObservationMs = acquired.timings.observeMs;

		const literals = taskLiterals(input.task);
		const previousActions: string[] = [];
		const requiresNewDocument = /(?:command|cmd)[-\s]*n|새\s*문서|new\s+document/i.test(input.task);
		if (requiresNewDocument) {
			const ref = await editableRef(snapshot, ctx);
			if (!ref) throw new Error("Could not bind the explicit Command-N shortcut to a semantic AX ref.");
			const action: UiAction = { action: "keypress", ref, keys: ["cmd", "n"] };
			const nativeStartedAt = now();
			const transitioned = await executeTransitionAct({ stateId: snapshot.stateId, actions: [action] } satisfies ActParams, ctx.signal, ctx);
			const nativeMs = now() - nativeStartedAt;
			if (transitioned.outcome === "didnt") throw new Error("The explicit Command-N shortcut did not reach TextEdit.");
			snapshot = (await acquireRoot(target.app, target.bundleId, ctx, ctx.signal)).snapshot;
			previousActions.push('keypress {"keys":["cmd","n"]}');
			rounds.push({
				index: 1,
				source: "explicit_native",
				modelMs: 0,
				action: { name: "keypress", arguments: { keys: ["cmd", "n"], ref } },
				nativeMs: roundMs(nativeMs),
				outcome: transitioned.outcome,
			});
		}
		for (let index = 0; index < 6; index += 1) {
			const needsNewDocument = requiresNewDocument && !previousActions.some((action) => action.startsWith("keypress "));
			const hasPendingLiteral = Object.keys(literals).length > 0;
			const stageGoal = needsNewDocument
				? `Create a new document in ${target.app}.`
				: hasPendingLiteral
					? `Enter the exact text ${JSON.stringify(literals.l0)} in the current document without saving.`
					: input.task;
			const allowedActions: LocalActionName[] = needsNewDocument
				? ["keypress"]
				: hasPendingLiteral
					? ["set_text", "type_text"]
					: ACTION_NAMES;
			const liveEditableRef = hasPendingLiteral ? await editableRef(snapshot, ctx) : undefined;
			const semanticTarget = liveEditableRef
				? { ref: liveEditableRef, role: "AXTextArea", value: "", capabilities: ["setText"] }
				: undefined;
			const modelSignal = ctx.signal
				? AbortSignal.any([ctx.signal, AbortSignal.timeout(10_000)])
				: AbortSignal.timeout(10_000);
			const decision = await requestAction(serverUrl, stageGoal, target, snapshot, literals, previousActions, allowedActions, semanticTarget, modelSignal);
			const round: LocalRoundTiming = {
				index: rounds.length + 1,
				source: "functiongemma",
				modelMs: roundMs(decision.modelMs),
				promptTokens: decision.promptTokens,
				completionTokens: decision.completionTokens,
				action: decision.action,
			};
			rounds.push(round);
			const { name, arguments: args } = decision.action;
			previousActions.push(`${name} ${JSON.stringify(args)}`);

			if (name === "stop") {
				if (args.status === "failure") throw new Error(typeof args.reason === "string" ? args.reason : "FunctionGemma stopped with failure.");
				const literalValues = Object.values(literals);
				if (literalValues.length && !literalValues.every((value) => snapshot!.outline.normalize("NFC").includes(value.normalize("NFC")))) {
					throw new Error("FunctionGemma stopped before the requested literal was observable.");
				}
				return {
					ok: true,
					app: target.app,
					bundleId: target.bundleId,
					task: input.task,
					model: `${MODEL_ID} + functiongemma-cua-literal-150`,
					windowTitle: snapshot.windowTitle,
					finalStateId: snapshot.stateId,
					timings: {
						totalMs: roundMs(now() - totalStartedAt),
						targetResolutionMs: roundMs(targetResolutionMs),
						setupMs: roundMs(setupMs),
						launchMs: roundMs(launchMs),
						rootAcquireMs: roundMs(rootAcquireMs),
						initialObservationMs: roundMs(initialObservationMs),
						rounds,
					},
				};
			}

			if (name === "observe_root") {
				const refreshStartedAt = now();
				snapshot = (await acquireRoot(target.app, target.bundleId, ctx, ctx.signal)).snapshot;
				round.nativeMs = roundMs(now() - refreshStartedAt);
				round.outcome = "observed";
				continue;
			}

			let action: UiAction;
			let expectedLiteral: string | undefined;
			if (name === "set_text" || name === "type_text") {
				const valueRef = typeof args.value_ref === "string" ? args.value_ref : "";
				expectedLiteral = literals[valueRef];
				if (expectedLiteral === undefined) throw new Error(`${name} referenced unavailable literal '${valueRef}'.`);
				const modelRef = hasRef(snapshot, args.ref) ? args.ref : undefined;
				const ref = modelRef ?? await editableRef(snapshot, ctx);
				if (ref) action = { action: "setText", ref, text: expectedLiteral };
				else action = { action: "typeText", text: expectedLiteral };
			} else if (name === "keypress") {
				const keys = Array.isArray(args.keys) ? args.keys.map(String).filter(Boolean).slice(0, 8) : [];
				if (!keys.length) throw new Error("keypress did not provide keys.");
				const ref = hasRef(snapshot, args.ref) ? args.ref : await editableRef(snapshot, ctx);
				action = { action: "keypress", ref, keys };
			} else if (name === "press_element") {
				if (!hasRef(snapshot, args.ref)) throw new Error(`press_element referenced unavailable ref '${String(args.ref)}'.`);
				action = { action: "press", ref: args.ref };
			} else if (name === "click_point") {
				const x = finiteNumber(args.x);
				const y = finiteNumber(args.y);
				const frame = snapshot.framePoints;
				if (x === undefined || y === undefined || !frame || x < 0 || x > 1 || y < 0 || y > 1) throw new Error("click_point lacked a valid normalized target.");
				action = {
					action: "click",
					x: frame.x + frame.w * x,
					y: frame.y + frame.h * y,
					button: args.button === "right" ? "right" : "left",
					clickCount: Math.max(1, Math.min(3, Math.trunc(finiteNumber(args.count) ?? 1))),
				};
			} else if (name === "scroll") {
				const dx = finiteNumber(args.dx) ?? 0;
				const dy = finiteNumber(args.dy) ?? 0;
				if (!dx && !dy) throw new Error("scroll returned a zero delta.");
				const frame = snapshot.framePoints;
				if (!frame) throw new Error("scroll requires an observed root frame.");
				action = {
					action: "scroll",
					x: frame.x + frame.w / 2,
					y: frame.y + frame.h / 2,
					scrollX: dx * 60,
					scrollY: dy * 60,
				};
			} else {
				throw new Error("drag_point cannot be safely executed without an observed start point.");
			}

			const nativeStartedAt = now();
			const keys = action.action === "keypress" ? action.keys?.map((key) => key.toLowerCase()) : undefined;
			const replacesRoot = action.action === "keypress" && keys?.includes("cmd") && keys.includes("n");
			if (replacesRoot) {
				const transitioned = await executeTransitionAct({ stateId: snapshot.stateId, actions: [action] } satisfies ActParams, ctx.signal, ctx);
				round.outcome = transitioned.outcome;
				if (transitioned.outcome === "didnt") throw new Error("Native keypress did not reach the target app.");
				snapshot = (await acquireRoot(target.app, target.bundleId, ctx, ctx.signal)).snapshot;
			} else {
				const result = await executeAct(
					`functiongemma-act-${index + 1}`,
					{
						stateId: snapshot.stateId,
						actions: [action],
						expect: expectedLiteral && "ref" in action && typeof action.ref === "string"
							? { ref: action.ref, value: expectedLiteral, until: "present", timeoutMs: 2_000 }
							: undefined,
					} satisfies ActParams,
					ctx.signal,
					undefined,
					ctx,
				);
				const details = result.details as unknown as Record<string, unknown>;
				const execution = details.execution as { outcome?: unknown } | undefined;
				round.outcome = typeof execution?.outcome === "string" ? execution.outcome : undefined;
				if (round.outcome === "didnt") throw new Error(`${name} failed its native delivery or verification.`);
				snapshot = updatedSnapshot(snapshot, details);
			}
			round.nativeMs = roundMs(now() - nativeStartedAt);

			if (expectedLiteral) {
				return {
					ok: true,
					app: target.app,
					bundleId: target.bundleId,
					task: input.task,
					model: `${MODEL_ID} + functiongemma-cua-literal-150`,
					windowTitle: snapshot.windowTitle,
					finalStateId: snapshot.stateId,
					timings: {
						totalMs: roundMs(now() - totalStartedAt),
						targetResolutionMs: roundMs(targetResolutionMs),
						setupMs: roundMs(setupMs),
						launchMs: roundMs(launchMs),
						rootAcquireMs: roundMs(rootAcquireMs),
						initialObservationMs: roundMs(initialObservationMs),
						rounds,
					},
				};
			}
		}
		throw new Error("FunctionGemma exceeded the 6-round safety limit.");
	} catch (error) {
		return {
			ok: false,
			app: target.app,
			bundleId: target.bundleId,
			task: input.task,
			model: `${MODEL_ID} + functiongemma-cua-literal-150`,
			windowTitle: snapshot?.windowTitle ?? "(unknown)",
			finalStateId: snapshot?.stateId,
			error: error instanceof Error ? error.message : String(error),
			timings: {
				totalMs: roundMs(now() - totalStartedAt),
				targetResolutionMs: roundMs(targetResolutionMs),
				setupMs: roundMs(setupMs),
				launchMs: roundMs(launchMs),
				rootAcquireMs: roundMs(rootAcquireMs),
				initialObservationMs: roundMs(initialObservationMs),
				rounds,
			},
		};
	}
}

export function formatFunctionGemmaCuaReport(report: FunctionGemmaCuaReport): string {
	return JSON.stringify(report, null, 2);
}
