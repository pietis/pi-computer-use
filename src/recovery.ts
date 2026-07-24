import { completeSimple, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UiAction, UiCondition } from "./contract.ts";
import { getComputerUseConfig } from "./config.ts";

const MAX_RECOVERY_ACTIONS = 3;
const MAX_RECOVERY_REASON_CHARS = 500;
const MAX_RECOVERY_TIMEOUT_MS = 5_000;

export interface RecoveryFailurePacket {
	app: string;
	windowTitle: string;
	stateId: string;
	outcome: "worked" | "didnt" | "unknown";
	error?: { code?: string; message?: string };
	verification?: {
		status: "verified" | "preexisting" | "failed";
		text?: string;
		role?: string;
		value?: string;
		gone?: boolean;
		timeoutMs: number;
	};
	failedActions: UiAction[];
	outline: string;
	validRefs: ReadonlySet<string>;
}

export interface RecoveryExecuteDecision {
	decision: "execute";
	confidence: number;
	reason: string;
	actions: UiAction[];
	expect: UiCondition;
}

export interface RecoveryEscalateDecision {
	decision: "escalate";
	confidence: number;
	reason: string;
}

export type RecoveryDecision = RecoveryExecuteDecision | RecoveryEscalateDecision;

export interface RecoveryRequestResult {
	decision?: RecoveryDecision;
	model?: string;
	latencyMs: number;
	error?: string;
}

function finiteConfidence(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function boundedReason(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const reason = value.trim();
	return reason ? reason.slice(0, MAX_RECOVERY_REASON_CHARS) : undefined;
}

function jsonCandidate(text: string): unknown {
	const trimmed = text.trim();
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1];
	const candidate = fenced ?? trimmed;
	try {
		return JSON.parse(candidate);
	} catch {
		const start = candidate.indexOf("{");
		const end = candidate.lastIndexOf("}");
		if (start < 0 || end <= start) return undefined;
		try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return undefined; }
	}
}

function validCondition(raw: unknown, validRefs: ReadonlySet<string>): UiCondition | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const source = raw as Record<string, unknown>;
	const ref = typeof source.ref === "string" ? source.ref.trim() : undefined;
	const scopeRef = typeof source.scopeRef === "string" ? source.scopeRef.trim() : undefined;
	if (ref && scopeRef) return undefined;
	if ((ref && !validRefs.has(ref)) || (scopeRef && !validRefs.has(scopeRef))) return undefined;
	const text = typeof source.text === "string" && source.text.trim() ? source.text.trim().slice(0, 512) : undefined;
	const role = typeof source.role === "string" && source.role.trim() ? source.role.trim().slice(0, 128) : undefined;
	const value = typeof source.value === "string" ? source.value : undefined;
	if (!text && !role && value === undefined) return undefined;
	if (value !== undefined && !ref) return undefined;
	if (role && !text && value === undefined && !ref && !scopeRef) return undefined;
	const until = source.until === "absent" ? "absent" as const : "present" as const;
	const timeoutValue = typeof source.timeoutMs === "number" && Number.isFinite(source.timeoutMs) ? source.timeoutMs : 2_000;
	const timeoutMs = Math.max(100, Math.min(MAX_RECOVERY_TIMEOUT_MS, Math.trunc(timeoutValue)));
	return { ref, scopeRef, text, role, value, until, timeoutMs };
}

function validAction(raw: unknown, validRefs: ReadonlySet<string>, allowedText: ReadonlySet<string>): UiAction | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const source = raw as Record<string, unknown>;
	const ref = typeof source.ref === "string" ? source.ref.trim() : undefined;
	if (!ref || !validRefs.has(ref)) return undefined;
	if (source.action === "press") return { action: "press", ref };
	if (source.action === "click") {
		if (source.button !== undefined && source.button !== "left") return undefined;
		if (source.clickCount !== undefined && source.clickCount !== 1) return undefined;
		return { action: "click", ref };
	}
	if (source.action === "setText") {
		if (typeof source.text !== "string" || !allowedText.has(source.text)) return undefined;
		return { action: "setText", ref, text: source.text };
	}
	return undefined;
}

export function parseRecoveryDecision(
	text: string,
	options: {
		validRefs: ReadonlySet<string>;
		allowedText: ReadonlySet<string>;
		minConfidence: number;
	},
): RecoveryDecision | undefined {
	const raw = jsonCandidate(text);
	if (!raw || typeof raw !== "object") return undefined;
	const source = raw as Record<string, unknown>;
	const confidence = finiteConfidence(source.confidence);
	const reason = boundedReason(source.reason);
	if (confidence === undefined || !reason) return undefined;
	if (source.decision === "escalate") return { decision: "escalate", confidence, reason };
	if (source.decision !== "execute" || confidence < options.minConfidence) {
		return { decision: "escalate", confidence, reason };
	}
	if (!Array.isArray(source.actions) || source.actions.length < 1 || source.actions.length > MAX_RECOVERY_ACTIONS) return undefined;
	const actions = source.actions.map((action) => validAction(action, options.validRefs, options.allowedText));
	if (actions.some((action) => !action)) return undefined;
	const expect = validCondition(source.expect, options.validRefs);
	if (!expect) return undefined;
	return { decision: "execute", confidence, reason, actions: actions as UiAction[], expect };
}

function resolveRecoveryModel(ctx: ExtensionContext, selector?: string): Model<any> | undefined {
	if (!selector) return ctx.model;
	const slash = selector.indexOf("/");
	if (slash <= 0 || slash === selector.length - 1) return undefined;
	return ctx.modelRegistry.find(selector.slice(0, slash), selector.slice(slash + 1));
}

function textFromResponse(response: Awaited<ReturnType<typeof completeSimple>>): string {
	return response.content
		.filter((part): part is Extract<(typeof response.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

export async function requestLightweightRecovery(
	ctx: ExtensionContext,
	packet: RecoveryFailurePacket,
	signal?: AbortSignal,
	complete: typeof completeSimple = completeSimple,
): Promise<RecoveryRequestResult> {
	const startedAt = Date.now();
	const config = getComputerUseConfig();
	const model = resolveRecoveryModel(ctx, config.exception_handler_model);
	if (!model) {
		return { latencyMs: Date.now() - startedAt, error: config.exception_handler_model ? `Configured exception-handler model '${config.exception_handler_model}' is unavailable.` : "No active model is available." };
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return { model: `${model.provider}/${model.id}`, latencyMs: Date.now() - startedAt, error: auth.error };
	const allowedText = new Set(packet.failedActions.flatMap((action) => typeof action.text === "string" ? [action.text] : []));
	const failure = {
		app: packet.app,
		windowTitle: packet.windowTitle,
		stateId: packet.stateId,
		outcome: packet.outcome,
		error: packet.error,
		verification: packet.verification,
		failedActions: packet.failedActions,
		outline: packet.outline,
	};
	const systemPrompt = [
		"You are a fast GUI exception handler. Return one compact JSON object and no prose.",
		"Do not reason aloud. Choose execute only when the current accessibility outline proves a safe recovery.",
		'Allowed execute actions are {"action":"press","ref":"@eN"}, {"action":"click","ref":"@eN"}, and {"action":"setText","ref":"@eN","text":"..."} only.',
		"Every ref must appear in the supplied outline. setText may only reuse text from failedActions.",
		"execute requires 1-3 actions and an observable expect condition. Never use coordinates, drag, raw keys, or unguarded actions.",
		`If uncertain, confidence is below ${config.exception_handler_confidence}, or the recovery could be destructive, return {"decision":"escalate","confidence":0.0,"reason":"..."}.`,
		'Execute schema: {"decision":"execute","confidence":0.0,"reason":"...","actions":[...],"expect":{"ref":"@eN","text":"...","role":"...","value":"...","until":"present|absent","timeoutMs":2000}}',
	].join("\n");
	try {
		const response = await complete(
			model,
			{
				systemPrompt,
				messages: [{ role: "user", content: JSON.stringify(failure), timestamp: Date.now() }],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				// Omitting `reasoning` is pi-ai's provider-neutral "off" path.
				// Passing the literal string "off" would be truthy and enables
				// thinking in some provider adapters.
				temperature: 0,
				maxTokens: 700,
				maxRetries: 0,
				timeoutMs: 12_000,
				signal,
			},
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			return { model: `${model.provider}/${model.id}`, latencyMs: Date.now() - startedAt, error: response.errorMessage ?? `Exception handler stopped with ${response.stopReason}.` };
		}
		const decision = parseRecoveryDecision(textFromResponse(response), {
			validRefs: packet.validRefs,
			allowedText,
			minConfidence: config.exception_handler_confidence,
		});
		return {
			decision,
			model: `${model.provider}/${model.id}`,
			latencyMs: Date.now() - startedAt,
			error: decision ? undefined : "Exception handler returned invalid or unsafe JSON.",
		};
	} catch (error) {
		return {
			model: `${model.provider}/${model.id}`,
			latencyMs: Date.now() - startedAt,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
