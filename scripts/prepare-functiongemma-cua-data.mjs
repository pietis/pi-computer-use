#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage(message) {
	if (message) console.error(message);
	console.error(`Usage:
  node scripts/prepare-functiongemma-cua-data.mjs \\
    --metadata .bench/agentnet/meta_data_merged.jsonl \\
    --trajectories .bench/agentnet/agentnet_win_mac_18k.jsonl \\
    --output .bench/cua-sft \\
    [--system Darwin] [--max-examples 20000] [--sample-rate 1] \\
    [--click-sample-rate 1] [--synthetic-examples 1000]`);
	process.exitCode = 2;
}

const args = process.argv.slice(2);
let metadataPath = path.join(packageRoot, ".bench", "agentnet", "meta_data_merged.jsonl");
let trajectoriesPath = path.join(packageRoot, ".bench", "agentnet", "agentnet_win_mac_18k.jsonl");
let outputPath = path.join(packageRoot, ".bench", "cua-sft");
let selectedSystem = "Darwin";
let maxExamples = Number.POSITIVE_INFINITY;
let sampleRate = 1;
let clickSampleRate = 1;
let syntheticExamples = 1_000;

for (let index = 0; index < args.length;) {
	const option = args[index];
	const value = args[index + 1];
	if (option === "--metadata" && value) metadataPath = path.resolve(packageRoot, value);
	else if (option === "--trajectories" && value) trajectoriesPath = path.resolve(packageRoot, value);
	else if (option === "--output" && value) outputPath = path.resolve(packageRoot, value);
	else if (option === "--system" && value) selectedSystem = value;
	else if (option === "--max-examples" && Number.isFinite(Number(value))) maxExamples = Math.max(1, Math.trunc(Number(value)));
	else if (option === "--sample-rate" && Number.isFinite(Number(value))) sampleRate = Math.min(1, Math.max(0, Number(value)));
	else if (option === "--click-sample-rate" && Number.isFinite(Number(value))) clickSampleRate = Math.min(1, Math.max(0, Number(value)));
	else if (option === "--synthetic-examples" && Number.isFinite(Number(value))) syntheticExamples = Math.max(0, Math.trunc(Number(value)));
	else {
		usage(`Unknown or incomplete option '${option}'.`);
		process.exit();
	}
	index += 2;
}

const DEVELOPER_PROMPT = "You are a model that can do function calling with the following functions";

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
];

const TOOL_NAMES = TOOLS.map((tool) => tool.function.name);
const metadataByTask = new Map();
for (const line of readFileSync(metadataPath, "utf8").split(/\r?\n/)) {
	if (!line.trim()) continue;
	const record = JSON.parse(line);
	if (record.system === selectedSystem) metadataByTask.set(record.task_id, record);
}

mkdirSync(outputPath, { recursive: true });
const writers = Object.fromEntries(["train", "valid", "test"].map((split) => [
	split,
	createWriteStream(path.join(outputPath, `${split}.jsonl`), { encoding: "utf8" }),
]));
const stats = {
	system: selectedSystem,
	eligibleTasks: metadataByTask.size,
	seenTrajectories: 0,
	selectedTrajectories: 0,
	emitted: { train: 0, valid: 0, test: 0 },
	synthetic: { train: 0, valid: 0, test: 0 },
	skipped: {},
	actions: {},
};

function increment(record, key) {
	record[key] = (record[key] ?? 0) + 1;
}

function splitFor(key) {
	const bucket = Number.parseInt(createHash("sha256").update(key).digest("hex").slice(0, 8), 16) % 100;
	if (bucket < 80) return "train";
	if (bucket < 90) return "valid";
	return "test";
}

function sampled(key, actionName) {
	const effectiveRate = actionName === "click_point" ? clickSampleRate : sampleRate;
	if (effectiveRate >= 1) return true;
	const bucket = Number.parseInt(createHash("sha256").update(`sample:${key}`).digest("hex").slice(0, 8), 16);
	return bucket / 0xffff_ffff < effectiveRate;
}

function clampText(value, limit) {
	const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
	return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function parsePythonString(source, start = 0) {
	const quote = source[start];
	if (quote !== "'" && quote !== "\"") return undefined;
	let output = "";
	for (let index = start + 1; index < source.length; index += 1) {
		const character = source[index];
		if (character === quote) return { value: output, end: index + 1 };
		if (character !== "\\") {
			output += character;
			continue;
		}
		const next = source[index + 1];
		if (next === undefined) return undefined;
		const escapes = { n: "\n", r: "\r", t: "\t", "\\": "\\", "'": "'", "\"": "\"" };
		output += escapes[next] ?? next;
		index += 1;
	}
	return undefined;
}

function allStringLiterals(source) {
	const values = [];
	for (let index = 0; index < source.length; index += 1) {
		if (source[index] !== "'" && source[index] !== "\"") continue;
		const parsed = parsePythonString(source, index);
		if (!parsed) continue;
		values.push(parsed.value);
		index = parsed.end - 1;
	}
	return values;
}

function namedNumber(source, name) {
	const match = source.match(new RegExp(`(?:^|[,\\s])${name}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)`));
	return match ? Number(match[1]) : undefined;
}

function positionalNumbers(source) {
	return [...source.matchAll(/(?:^|[,(]\s*)(-?\d+(?:\.\d+)?)(?=\s*[,)]|$)/g)].map((match) => Number(match[1]));
}

function normalizeKey(key) {
	const normalized = key.toLowerCase().trim();
	const aliases = {
		command: "cmd",
		cmdleft: "cmd",
		cmdright: "cmd",
		control: "ctrl",
		option: "alt",
		return: "enter",
		esc: "escape",
	};
	return aliases[normalized] ?? normalized;
}

function parseSingleAction(compact) {
	const call = compact.match(/^(?:pyautogui|computer)\.([A-Za-z_]\w*)\(([\s\S]*)\)$/);
	if (!call) return undefined;
	const method = call[1];
	const source = call[2];
	const strings = allStringLiterals(source);
	const numbers = positionalNumbers(source);

	if (method === "write" || method === "typewrite") {
		if (strings[0] === undefined) return undefined;
		return { name: "type_text", arguments: { text: strings[0] } };
	}
	if (method === "hotkey" || method === "press" || method === "keyDown") {
		const keys = strings.map(normalizeKey);
		if (keys.length === 0) return undefined;
		return { name: "keypress", arguments: { keys } };
	}
	if (method === "click" || method === "doubleClick" || method === "tripleClick" || method === "rightClick") {
		const x = namedNumber(source, "x") ?? numbers[0];
		const y = namedNumber(source, "y") ?? numbers[1];
		if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
		const count = method === "doubleClick" ? 2 : method === "tripleClick" ? 3 : 1;
		return {
			name: "click_point",
			arguments: {
				x,
				y,
				button: method === "rightClick" ? "right" : "left",
				count,
			},
		};
	}
	if (method === "scroll" || method === "hscroll") {
		const amount = numbers[0];
		if (!Number.isFinite(amount)) return undefined;
		return { name: "scroll", arguments: method === "scroll" ? { dx: 0, dy: amount } : { dx: amount, dy: 0 } };
	}
	if (method === "dragTo") {
		const x = namedNumber(source, "x") ?? numbers[0];
		const y = namedNumber(source, "y") ?? numbers[1];
		const duration = namedNumber(source, "duration");
		if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
		return { name: "drag_point", arguments: { x, y, ...(Number.isFinite(duration) ? { duration } : {}) } };
	}
	if (method === "terminate") {
		const statusMatch = source.match(/status\s*=\s*(['"])(success|failure)\1/i);
		const status = statusMatch?.[2]?.toLowerCase() ?? "failure";
		return { name: "stop", arguments: { status } };
	}
	return undefined;
}

function parseAction(code) {
	const lines = String(code ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const actions = [];
	for (const line of lines) {
		if (/^pyautogui\.moveTo\(/.test(line)) continue;
		const action = parseSingleAction(line);
		if (!action) return undefined;
		actions.push(action);
	}
	if (actions.length === 1) return actions[0];
	if (actions.length > 1 && actions.every((action) => action.name === "scroll")) {
		return {
			name: "scroll",
			arguments: actions.reduce((total, action) => ({
				dx: total.dx + action.arguments.dx,
				dy: total.dy + action.arguments.dy,
			}), { dx: 0, dy: 0 }),
		};
	}
	return undefined;
}

function sampleFor({ goal, observation, previousActions, action, sampleId, platform = selectedSystem, current, source = "agentnet" }) {
	let outputAction = action;
	let literals;
	if ((action.name === "set_text" || action.name === "type_text") && typeof action.arguments.text === "string") {
		literals = { l0: action.arguments.text };
		const { text: _text, ...otherArguments } = action.arguments;
		outputAction = { name: action.name, arguments: { ...otherArguments, value_ref: "l0" } };
	}
	const userState = {
		goal: clampText(goal, 1_500),
		platform,
		...(current ? { current } : {}),
		...(literals ? { literals } : {}),
		observation: clampText(observation, 3_000),
		previous_actions: previousActions.slice(-2).map((value) => clampText(value, 300)),
		allowed_actions: TOOL_NAMES,
	};
	return {
		metadata: { source, sample_id: sampleId },
		messages: [
			{ role: "developer", content: DEVELOPER_PROMPT },
			{ role: "user", content: JSON.stringify(userState) },
			{
				role: "assistant",
				tool_calls: [{
					id: `call_${createHash("sha1").update(sampleId).digest("hex").slice(0, 12)}`,
					type: "function",
					function: outputAction,
				}],
			},
		],
		tools: TOOLS,
	};
}

function writeSample(split, sample, synthetic = false) {
	writers[split].write(`${JSON.stringify(sample)}\n`);
	stats.emitted[split] += 1;
	if (synthetic) stats.synthetic[split] += 1;
}

const lineReader = readline.createInterface({
	input: createReadStream(trajectoriesPath, { encoding: "utf8" }),
	crlfDelay: Number.POSITIVE_INFINITY,
});

let emittedPublic = 0;
for await (const line of lineReader) {
	if (!line.trim()) continue;
	stats.seenTrajectories += 1;
	let trajectory;
	try {
		trajectory = JSON.parse(line);
	} catch {
		increment(stats.skipped, "invalid_json");
		continue;
	}
	const metadata = metadataByTask.get(trajectory.task_id);
	if (!metadata) continue;
	stats.selectedTrajectories += 1;
	const split = splitFor(trajectory.task_id);
	const previousActions = [];
	const goal = trajectory.actual_task || trajectory.natural_language_task || trajectory.instruction || metadata.instruction;
	for (const step of trajectory.traj ?? []) {
		if (emittedPublic >= maxExamples) break;
		const value = step?.value ?? {};
		if (value.last_step_correct === false) {
			increment(stats.skipped, "incorrect_step");
			continue;
		}
		if (value.last_step_redundant === true) {
			increment(stats.skipped, "redundant_step");
			continue;
		}
		const action = parseAction(value.code);
		if (!action) {
			increment(stats.skipped, "unsupported_code");
			continue;
		}
		const sampleId = `${trajectory.task_id}:${step.index ?? previousActions.length}`;
		if (!sampled(sampleId, action.name)) {
			increment(stats.skipped, "sampled_out");
			previousActions.push(value.action || value.code);
			continue;
		}
		writeSample(split, sampleFor({
			goal,
			observation: value.observation,
			previousActions,
			action,
			sampleId,
		}));
		increment(stats.actions, action.name);
		emittedPublic += 1;
		previousActions.push(value.action || value.code);
	}
	if (emittedPublic >= maxExamples) break;
}

const SYNTHETIC_TEXTS = [
	"pi-computer-use 테스트",
	"회의 메모",
	"hello world",
	"분기별 보고서",
	"Do not save this document.",
	"검색어를 입력하세요",
];
const SYNTHETIC_APPS = ["TextEdit", "Notes", "Safari", "Finder", "System Settings"];
for (let index = 0; index < syntheticExamples; index += 1) {
	const variant = index % 9;
	const refNumber = 3 + (index % 27);
	const ref = `@e${refNumber}`;
	const app = SYNTHETIC_APPS[index % SYNTHETIC_APPS.length];
	const text = SYNTHETIC_TEXTS[index % SYNTHETIC_TEXTS.length];
	let action;
	let observation;
	let goal;
	let current;
	if (variant === 0) {
		action = { name: "set_text", arguments: { ref, text } };
		observation = `The current AX outline contains ${ref} AXTextArea value=\"\" with setText capability.`;
		goal = `Enter the exact text ${JSON.stringify(text)} in the current document without saving.`;
		current = { app, elements: [{ ref, role: "AXTextArea", value: "", capabilities: ["setText"] }] };
	} else if (variant === 1) {
		action = { name: "press_element", arguments: { ref } };
		observation = `The current AX outline contains ${ref} AXButton titled \"Continue\" with press capability.`;
		goal = "Press the Continue button.";
		current = { app, elements: [{ ref, role: "AXButton", title: "Continue", capabilities: ["press"] }] };
	} else if (variant === 2) {
		action = { name: "keypress", arguments: { ref, keys: ["cmd", "n"] } };
		observation = `The current AX outline contains ${ref} AXWindow and the task requires a new document.`;
		goal = `Create a new document in ${app}.`;
		current = { app, elements: [{ ref, role: "AXWindow", capabilities: ["keypress"] }] };
	} else if (variant === 3) {
		action = { name: "observe_root", arguments: { root: `@r${1 + (index % 5)}` } };
		observation = `The last action created a new root @r${1 + (index % 5)}. Existing element refs belong to the previous root.`;
		goal = "Continue safely in the newly created window.";
		current = { app, root_changed: true };
	} else if (variant === 4) {
		action = { name: "stop", arguments: { status: "success" } };
		observation = `The target AXTextArea now has the exact expected value ${JSON.stringify(text)}.`;
		goal = `Enter the exact text ${JSON.stringify(text)} and stop without saving.`;
		current = { app, elements: [{ ref, role: "AXTextArea", value: text }] };
	} else if (variant === 5) {
		action = { name: "type_text", arguments: { text } };
		observation = `The insertion point is active in the focused text field. Type the requested text exactly.`;
		goal = `Type the exact text ${JSON.stringify(text)} in the focused field.`;
		current = { app, focused: { role: "AXTextField", value: "" } };
	} else if (variant === 6) {
		const x = Number((0.2 + (index % 6) * 0.1).toFixed(2));
		const y = Number((0.3 + (index % 5) * 0.1).toFixed(2));
		action = { name: "click_point", arguments: { x, y, button: "left", count: 1 } };
		observation = `No actionable AX ref is available. The visual target center is explicitly (${x}, ${y}) in normalized coordinates.`;
		goal = "Click the identified visual target once.";
		current = { app, visual_target: { x, y } };
	} else if (variant === 7) {
		const dy = index % 2 === 0 ? -6 : 6;
		action = { name: "scroll", arguments: { dx: 0, dy } };
		observation = dy < 0 ? "The requested content is below the visible viewport." : "The requested content is above the visible viewport.";
		goal = dy < 0 ? "Scroll down to reveal more content." : "Scroll up to reveal earlier content.";
		current = { app, scrollable: true };
	} else {
		const x = Number((0.25 + (index % 5) * 0.1).toFixed(2));
		const y = Number((0.35 + (index % 4) * 0.1).toFixed(2));
		action = { name: "drag_point", arguments: { x, y, duration: 0.2 } };
		observation = `A drag is active and its normalized destination is explicitly (${x}, ${y}).`;
		goal = "Complete the drag at the identified destination.";
		current = { app, drag_destination: { x, y } };
	}
	const sampleId = `synthetic:${index}`;
	const split = splitFor(sampleId);
	writeSample(split, sampleFor({
		goal,
		observation,
		previousActions: [],
		action,
		sampleId,
		platform: "Darwin",
		current,
		source: "synthetic_ax",
	}), true);
	increment(stats.actions, action.name);
}

await Promise.all(Object.values(writers).map((writer) => new Promise((resolve, reject) => {
	writer.once("error", reject);
	writer.end(resolve);
})));

console.log(JSON.stringify(stats, null, 2));
