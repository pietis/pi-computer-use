#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let outputPath = path.join(packageRoot, ".bench", "public-cua", "sft");
let gui360ProcessedPath = path.join(packageRoot, ".bench", "public-cua", "raw", "gui360-action-a11y.json");
let guirillaExamples = 4_000;
let gui360TrajectoriesPerApp = 60;
let gui360ProcessedExamples = 2_000;

function usage(message) {
	if (message) console.error(message);
	console.error(`Usage:
  node scripts/prepare-public-ax-cua-data.mjs
    [--output .bench/public-cua/sft]
    [--guirilla-examples 4000]
    [--gui360-trajectories-per-app 60]
    [--gui360-processed .bench/public-cua/raw/gui360-action-a11y.json]
    [--gui360-processed-examples 2000]`);
	process.exitCode = 2;
}

for (let index = 0; index < args.length;) {
	const option = args[index];
	const value = args[index + 1];
	if (option === "--output" && value) outputPath = path.resolve(packageRoot, value);
	else if (option === "--guirilla-examples" && Number.isFinite(Number(value))) guirillaExamples = Math.max(0, Math.trunc(Number(value)));
	else if (option === "--gui360-trajectories-per-app" && Number.isFinite(Number(value))) gui360TrajectoriesPerApp = Math.max(0, Math.trunc(Number(value)));
	else if (option === "--gui360-processed" && value) gui360ProcessedPath = path.resolve(packageRoot, value);
	else if (option === "--gui360-processed-examples" && Number.isFinite(Number(value))) gui360ProcessedExamples = Math.max(0, Math.trunc(Number(value)));
	else {
		usage(`Unknown or incomplete option '${option}'.`);
		process.exit();
	}
	index += 2;
}

const SYSTEM_PROMPT = `You are a low-latency closed-loop desktop UI agent.
Return exactly one tool call and no narration. Use the current stateId and only
refs from the latest UI outline. Perform one state-changing action per act_ui
call. Never invent a successor screen.`;

const TOOLS = [
	{
		type: "function",
		function: {
			name: "act_ui",
			description: "Perform one precisely targeted checked action and return the successor state.",
			parameters: {
				type: "object",
				properties: {
					stateId: { type: "string" },
					actions: {
						type: "array",
						minItems: 1,
						maxItems: 1,
						items: {
							type: "object",
							properties: {
								action: { type: "string", enum: ["press", "click", "setText", "typeText", "keypress", "scroll", "drag"] },
								ref: { type: "string" },
								x: { type: "number" },
								y: { type: "number" },
								text: { type: "string" },
								keys: { type: "array", items: { type: "string" } },
								scrollX: { type: "number" },
								scrollY: { type: "number" },
								path: {
									type: "array",
									items: {
										type: "object",
										properties: { x: { type: "number" }, y: { type: "number" } },
										required: ["x", "y"],
									},
								},
								button: { type: "string", enum: ["left", "right", "middle"] },
								clickCount: { type: "number" },
							},
							required: ["action"],
						},
					},
				},
				required: ["stateId", "actions"],
			},
		},
	},
];

const stats = {
	sources: {},
	emitted: { train: 0, valid: 0, test: 0 },
	actions: {},
	skipped: {},
};

function increment(record, key) {
	record[key] = (record[key] ?? 0) + 1;
}

function hashHex(value) {
	return createHash("sha256").update(String(value)).digest("hex");
}

function splitFor(value) {
	const bucket = Number.parseInt(hashHex(value).slice(0, 8), 16) % 100;
	if (bucket < 90) return "train";
	if (bucket < 95) return "valid";
	return "test";
}

function stateIdFor(value) {
	const hex = hashHex(`state:${value}`);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function clampText(value, limit = 1_000) {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function normalizeRole(role) {
	const text = String(role ?? "").replace(/\s+/g, "");
	if (!text) return "AXGroup";
	if (text.startsWith("AX")) return text;
	const aliases = {
		Button: "AXButton",
		CheckBox: "AXCheckBox",
		ComboBox: "AXComboBox",
		Edit: "AXTextField",
		Hyperlink: "AXLink",
		ListItem: "AXRow",
		MenuItem: "AXMenuItem",
		RadioButton: "AXRadioButton",
		TabItem: "AXRadioButton",
		Text: "AXStaticText",
		TitleBar: "AXToolbar",
		TreeItem: "AXRow",
		Window: "AXWindow",
	};
	return aliases[text] ?? `AX${text}`;
}

function nodeLabel(node) {
	for (const value of [node?.name, node?.description, node?.role_description, node?.value, node?.control_text]) {
		if (value !== undefined && value !== null && String(value).trim()) return clampText(value, 180);
	}
	return "";
}

function actionsForRole(role) {
	const normalized = normalizeRole(role);
	if (/TextField|TextArea|SearchField|ComboBox/.test(normalized)) return ["setText", "typeText", "click"];
	if (/Button|MenuItem|CheckBox|RadioButton|Link|Row|Cell|Tab/.test(normalized)) return ["press", "click"];
	if (/Window|Sheet|Dialog/.test(normalized)) return ["keypress"];
	if (/ScrollArea|List|Table|Outline/.test(normalized)) return ["scroll", "click"];
	return ["click"];
}

function flattenTree(root, targetId, limit = 36) {
	const all = [];
	const visit = (node, depth = 0) => {
		if (!node || typeof node !== "object") return;
		all.push({ node, depth });
		for (const child of Array.isArray(node.children) ? node.children : []) visit(child, depth + 1);
	};
	visit(root);
	const targetEntry = all.find((entry) => String(entry.node.id ?? "") === String(targetId ?? ""));
	const useful = all.filter((entry, index) => {
		const role = normalizeRole(entry.node.role ?? entry.node.control_type);
		return index === 0 || entry === targetEntry || nodeLabel(entry.node) || !/Group|Pane|StaticText/.test(role);
	});
	const selected = useful.slice(0, Math.max(1, limit - (targetEntry && !useful.slice(0, limit).includes(targetEntry) ? 1 : 0)));
	if (targetEntry && !selected.includes(targetEntry)) selected.push(targetEntry);
	const refs = new Map();
	for (const [index, entry] of selected.entries()) refs.set(String(entry.node.id ?? `node-${index}`), `@e${index + 1}`);
	const lines = selected.map((entry, index) => {
		const ref = `@e${index + 1}`;
		const role = normalizeRole(entry.node.role ?? entry.node.control_type);
		const label = nodeLabel(entry.node);
		const capabilities = actionsForRole(role).join(",");
		return `${ref} ${role}${label ? ` ${JSON.stringify(label)}` : ""} {${capabilities}}`;
	});
	return {
		lines,
		targetRef: targetEntry ? refs.get(String(targetEntry.node.id)) : undefined,
		targetRole: targetEntry ? normalizeRole(targetEntry.node.role ?? targetEntry.node.control_type) : undefined,
	};
}

function sampleFor({ source, sampleId, task, app, stateId, outline, previousActions = [], action }) {
	const latest = [
		`Task: ${clampText(task, 1_200)}`,
		app ? `Application: ${clampText(app, 200)}` : "",
		"Latest tool result:",
		`Observed semantic UI. Returned the latest outline state.`,
		`Outline (${outline.length} shown nodes, stateId ${stateId}):`,
		...outline,
		previousActions.length ? `Previous actions: ${previousActions.slice(-3).map((item) => clampText(item, 240)).join(" | ")}` : "",
	].filter(Boolean).join("\n");
	return {
		metadata: { source, sample_id: sampleId },
		messages: [
			{ role: "system", content: SYSTEM_PROMPT },
			{ role: "user", content: latest },
			{
				role: "assistant",
				tool_calls: [{
					id: `call_${hashHex(sampleId).slice(0, 12)}`,
					type: "function",
					function: {
						name: "act_ui",
						arguments: { stateId, actions: [action] },
					},
				}],
			},
		],
		tools: TOOLS,
	};
}

mkdirSync(outputPath, { recursive: true });
const writers = Object.fromEntries(["train", "valid", "test"].map((split) => [
	split,
	createWriteStream(path.join(outputPath, `${split}.jsonl`), { encoding: "utf8" }),
]));

function writeSample(sample) {
	const split = splitFor(sample.metadata.sample_id);
	writers[split].write(`${JSON.stringify(sample)}\n`);
	stats.emitted[split] += 1;
	const action = sample.messages.at(-1).tool_calls[0].function.arguments.actions[0].action;
	increment(stats.actions, action);
	increment(stats.sources, sample.metadata.source);
}

async function fetchJson(url, attempts = 4) {
	let lastError;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			const response = await fetch(url, { headers: { "user-agent": "pi-computer-use-public-cua-experiment" } });
			if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
			return await response.json();
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
		}
	}
	throw lastError;
}

function pythonReprField(source, key) {
	const match = String(source ?? "").match(new RegExp(`['"]${key}['"]\\s*:\\s*(['"])(.*?)\\1`));
	return match?.[2];
}

function guirillaAction(row, targetRef, targetRole) {
	if (!targetRef) return undefined;
	if (row.action.startsWith("left click")) {
		const semantic = /Button|MenuItem|CheckBox|RadioButton|Link/.test(targetRole ?? "") ? "press" : "click";
		return { action: semantic, ref: targetRef };
	}
	if (row.action.startsWith("type ")) {
		return { action: "setText", ref: targetRef, text: row.action.slice(5) };
	}
	return undefined;
}

async function addGuirilla() {
	for (let offset = 0; offset < guirillaExamples; offset += 100) {
		const length = Math.min(100, guirillaExamples - offset);
		const url = `https://datasets-server.huggingface.co/rows?dataset=macpaw-research%2FGUIrilla-Task&config=default&split=train&offset=${offset}&length=${length}`;
		const page = await fetchJson(url);
		for (const entry of page.rows ?? []) {
			const row = entry.row;
			let root;
			try {
				root = JSON.parse(row.accessibility);
			} catch {
				increment(stats.skipped, "guirilla_invalid_ax");
				continue;
			}
			const targetId = pythonReprField(row.element_data, "id");
			const compact = flattenTree(root, targetId);
			if (!compact.targetRef) {
				const role = normalizeRole(pythonReprField(row.element_data, "role"));
				const label = pythonReprField(row.element_data, "name")
					|| pythonReprField(row.element_data, "description")
					|| row.task;
				compact.targetRef = `@e${compact.lines.length + 1}`;
				compact.targetRole = role;
				compact.lines.push(`${compact.targetRef} ${role} ${JSON.stringify(clampText(label, 180))} {${actionsForRole(role).join(",")}}`);
			}
			const action = guirillaAction(row, compact.targetRef, compact.targetRole);
			if (!action) {
				increment(stats.skipped, "guirilla_unsupported_action");
				continue;
			}
			const sampleId = `guirilla:${entry.row_idx}`;
			writeSample(sampleFor({
				source: "guirilla_task",
				sampleId,
				task: row.task,
				app: row.app_name,
				stateId: stateIdFor(sampleId),
				outline: compact.lines,
				action,
			}));
		}
		console.error(`[public-cua] GUIrilla ${Math.min(offset + length, guirillaExamples)}/${guirillaExamples}`);
	}
}

function overlapArea(a, b) {
	if (!a || !b) return 0;
	const left = Math.max(Number(a.left), Number(b.left));
	const top = Math.max(Number(a.top), Number(b.top));
	const right = Math.min(Number(a.right), Number(b.right));
	const bottom = Math.min(Number(a.bottom), Number(b.bottom));
	return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function findGui360Target(root, action) {
	const candidates = [];
	const visit = (node) => {
		if (!node || typeof node !== "object") return;
		const name = nodeLabel(node).toLowerCase();
		const wanted = String(action.control_test ?? "").trim().toLowerCase();
		const nameScore = wanted && name ? (name === wanted ? 1_000_000 : name.includes(wanted) || wanted.includes(name) ? 100_000 : 0) : 0;
		const geometryScore = overlapArea(node.rectangle, action.rectangle);
		candidates.push({ node, score: nameScore + geometryScore });
		for (const child of Array.isArray(node.children) ? node.children : []) visit(child);
	};
	visit(root);
	candidates.sort((a, b) => b.score - a.score);
	return candidates[0]?.score > 0 ? candidates[0].node : undefined;
}

function normalizedKeys(value) {
	const source = String(value ?? "");
	const keys = [];
	for (const match of source.matchAll(/\{(?:VK_)?([A-Z]+)(?:\s+\d+)?\}/gi)) {
		const aliases = { CONTROL: "ctrl", MENU: "alt", RETURN: "enter", ESCAPE: "escape" };
		keys.push(aliases[match[1].toUpperCase()] ?? match[1].toLowerCase());
	}
	const remainder = source.replace(/\{[^}]+\}/g, "");
	if (remainder.length === 1) keys.push(remainder.toLowerCase());
	return keys;
}

function gui360Action(record, targetRef, targetRole) {
	const action = record.step?.action;
	if (!action || action.action_type !== "GUI") return undefined;
	const fn = String(action.function ?? "").toLowerCase();
	const argsValue = action.args ?? {};
	if (fn === "click") {
		if (targetRef) return { action: /Button|MenuItem|CheckBox|RadioButton|Link/.test(targetRole ?? "") ? "press" : "click", ref: targetRef };
		const x = Number(action.coordinate_x ?? argsValue.x);
		const y = Number(action.coordinate_y ?? argsValue.y);
		if (Number.isFinite(x) && Number.isFinite(y)) return { action: "click", x, y, button: argsValue.button ?? "left", clickCount: argsValue.double ? 2 : 1 };
	}
	if (fn === "type") {
		const text = argsValue.text ?? argsValue.keys;
		const keys = normalizedKeys(text);
		if (keys.length && /^\{/.test(String(text))) return { action: "keypress", ...(targetRef ? { ref: targetRef } : {}), keys };
		if (typeof text === "string") return { action: argsValue.clear_current_text ? "setText" : "typeText", ...(targetRef ? { ref: targetRef } : {}), text };
	}
	if (fn === "wheel_mouse_input") {
		return { action: "scroll", ...(targetRef ? { ref: targetRef } : {}), scrollY: Number(argsValue.wheel_dist ?? 0) };
	}
	return undefined;
}

async function gui360Paths(app) {
	const encoded = encodeURIComponent(`train/data/${app}`).replaceAll("%2F", "/");
	const url = `https://huggingface.co/api/datasets/vyokky/GUI-360/tree/main/${encoded}?recursive=true&expand=false&limit=1000`;
	const rows = await fetchJson(url);
	return rows.filter((entry) => entry.type === "file" && entry.path.endsWith(".jsonl")).map((entry) => entry.path);
}

async function addGui360Raw() {
	for (const app of ["excel", "word", "ppt"]) {
		const paths = await gui360Paths(app);
		const selected = [...paths]
			.sort((a, b) => hashHex(`${app}:${a}`).localeCompare(hashHex(`${app}:${b}`)))
			.slice(0, gui360TrajectoriesPerApp);
		let completed = 0;
		for (const filePath of selected) {
			const url = `https://huggingface.co/datasets/vyokky/GUI-360/resolve/main/${filePath.split("/").map(encodeURIComponent).join("/")}`;
			const response = await fetch(url);
			if (!response.ok) {
				increment(stats.skipped, "gui360_download_error");
				continue;
			}
			const text = await response.text();
			const previousActions = [];
			for (const line of text.split(/\r?\n/)) {
				if (!line.trim()) continue;
				let record;
				try {
					record = JSON.parse(line);
				} catch {
					increment(stats.skipped, "gui360_invalid_json");
					continue;
				}
				const target = findGui360Target(record.step?.ui_tree, record.step?.action ?? {});
				const compact = flattenTree(record.step?.ui_tree, target?.id);
				const action = gui360Action(record, compact.targetRef, compact.targetRole);
				if (!action) {
					increment(stats.skipped, "gui360_unsupported_action");
					continue;
				}
				const sampleId = `gui360:${record.execution_id}:${record.step_id}`;
				writeSample(sampleFor({
					source: "gui360_raw_a11y",
					sampleId,
					task: record.request,
					app: record.app_domain,
					stateId: stateIdFor(sampleId),
					outline: compact.lines,
					previousActions,
					action,
				}));
				previousActions.push(`${record.step?.thought ?? ""} ${JSON.stringify(record.step?.action ?? {})}`);
			}
			completed += 1;
			if (completed % 10 === 0 || completed === selected.length) {
				console.error(`[public-cua] GUI-360 ${app} ${completed}/${selected.length}`);
			}
		}
	}
}

async function* topLevelArrayObjects(filePath) {
	const stream = createReadStream(filePath, { encoding: "utf8" });
	let started = false;
	let depth = 0;
	let inString = false;
	let escaped = false;
	let current = "";
	for await (const chunk of stream) {
		for (const character of chunk) {
			if (!started) {
				if (character === "[") started = true;
				continue;
			}
			if (depth === 0) {
				if (character === "{") {
					depth = 1;
					current = "{";
				} else if (character === "]") {
					return;
				}
				continue;
			}
			current += character;
			if (inString) {
				if (escaped) escaped = false;
				else if (character === "\\") escaped = true;
				else if (character === "\"") inString = false;
				continue;
			}
			if (character === "\"") inString = true;
			else if (character === "{") depth += 1;
			else if (character === "}") {
				depth -= 1;
				if (depth === 0) {
					yield JSON.parse(current);
					current = "";
				}
			}
		}
	}
}

function processedPromptParts(value) {
	const text = String(value ?? "");
	const instruction = text.match(/The instruction is:\n([\s\S]*?)\n\nThe history of actions are:/)?.[1]?.trim();
	const history = text.match(/The history of actions are:\n([\s\S]*?)\n\nThe actions supported are:/)?.[1]?.trim();
	return { instruction, history };
}

function parseProcessedCall(value) {
	const match = String(value ?? "").match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/);
	if (!match) return undefined;
	try {
		return JSON.parse(match[1]);
	} catch {
		return undefined;
	}
}

function processedAction(call, bbox) {
	const fn = String(call?.function ?? "");
	const argsValue = call?.args ?? {};
	if (fn === "type") {
		const source = argsValue.text ?? argsValue.keys;
		const keys = normalizedKeys(source);
		if (keys.length && /^\{/.test(String(source))) return { action: "keypress", ref: "@e2", keys };
		if (typeof source === "string") return { action: argsValue.clear_current_text ? "setText" : "typeText", ref: "@e2", text: source };
	}
	if (fn === "wheel_mouse_input") return { action: "scroll", ref: "@e2", scrollY: Number(argsValue.wheel_dist ?? 0) };
	if (fn === "drag") {
		const start = argsValue.start_coordinate;
		const end = argsValue.end_coordinate;
		if (Array.isArray(start) && Array.isArray(end)) {
			return { action: "drag", path: [{ x: Number(start[0]), y: Number(start[1]) }, { x: Number(end[0]), y: Number(end[1]) }] };
		}
	}
	if (fn === "click" && Array.isArray(bbox)) {
		const centerX = (Number(bbox[0]) + Number(bbox[2])) / 2;
		const centerY = (Number(bbox[1]) + Number(bbox[3])) / 2;
		return { action: "click", ref: "@e2", ...(argsValue.double ? { clickCount: 2 } : {}) };
	}
	return undefined;
}

async function addGui360Processed() {
	let emitted = 0;
	for await (const row of topLevelArrayObjects(gui360ProcessedPath)) {
		if (emitted >= gui360ProcessedExamples) break;
		const human = row.conversation?.find((message) => message.from === "human")?.value;
		const assistant = row.conversation?.find((message) => message.from === "gpt")?.value;
		const prompt = processedPromptParts(human);
		const call = parseProcessedCall(assistant);
		const action = processedAction(call, row.bbox);
		if (!prompt.instruction || !action) {
			increment(stats.skipped, "gui360_processed_unsupported");
			continue;
		}
		const sampleId = `gui360-processed:${row.id}`;
		const role = action.action === "setText" || action.action === "typeText" || action.action === "keypress" ? "AXTextField" : "AXGroup";
		writeSample(sampleFor({
			source: "gui360_processed",
			sampleId,
			task: prompt.instruction,
			app: String(row.id ?? "").split("_")[0],
			stateId: stateIdFor(sampleId),
			outline: [
				"@e1 AXWindow {keypress}",
				`@e2 ${role} "current target" {${actionsForRole(role).join(",")}}`,
			],
			previousActions: prompt.history ? prompt.history.split(/\n+/).slice(-3) : [],
			action,
		}));
		emitted += 1;
	}
	console.error(`[public-cua] GUI-360 processed ${emitted}/${gui360ProcessedExamples}`);
}

await addGuirilla();
await addGui360Raw();
await addGui360Processed();

await Promise.all(Object.values(writers).map((writer) => new Promise((resolve, reject) => {
	writer.once("error", reject);
	writer.end(resolve);
})));

console.log(JSON.stringify(stats, null, 2));
