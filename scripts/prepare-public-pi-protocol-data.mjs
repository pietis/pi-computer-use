#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inputPath = path.resolve(packageRoot, process.argv[2] ?? ".bench/public-cua/sft-public-balanced");
const outputPath = path.resolve(packageRoot, process.argv[3] ?? ".bench/public-cua/sft-public-protocol");
mkdirSync(outputPath, { recursive: true });

const SYSTEM_PROMPT = `You are a low-latency closed-loop desktop UI agent.
Return exactly one tool call per turn and no narration. Launch only the requested
application, find its root, observe it, then perform one checked UI action using
the latest stateId and refs. Never invent a successor screen.`;

const ACTION_PARAMETERS = {
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
};

const TOOLS = [
	{
		type: "function",
		function: {
			name: "bash",
			description: "Launch the one requested macOS application.",
			parameters: {
				type: "object",
				properties: { command: { type: "string" }, timeout: { type: "number" } },
				required: ["command"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "find_roots",
			description: "Find visible application roots and mint @r refs.",
			parameters: {
				type: "object",
				properties: {
					text: { type: "string" },
					app: { type: "string" },
					bundleId: { type: "string" },
					kind: { type: "string", enum: ["window", "menu", "sheet", "popover", "dialog", "browser_page"] },
				},
			},
		},
	},
	{
		type: "function",
		function: {
			name: "observe_ui",
			description: "Observe one selected root and return a stateId and @e refs.",
			parameters: {
				type: "object",
				properties: {
					root: { type: "string" },
					mode: { type: "string", enum: ["semantic"] },
				},
				required: ["root", "mode"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "act_ui",
			description: "Perform one precisely targeted checked action.",
			parameters: ACTION_PARAMETERS,
		},
	},
];

function hash(value) {
	return createHash("sha256").update(String(value)).digest("hex");
}

function call(id, name, args) {
	return {
		role: "assistant",
		tool_calls: [{
			id,
			type: "function",
			function: { name, arguments: args },
		}],
	};
}

function tool(id, name, content) {
	return { role: "tool", tool_call_id: id, name, content };
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function fields(content) {
	const text = String(content ?? "");
	const task = text.match(/^Task:\s*(.+)$/m)?.[1]?.trim();
	const app = text.match(/^Application:\s*(.+)$/m)?.[1]?.trim();
	const resultIndex = text.indexOf("Latest tool result:\n");
	const observation = resultIndex >= 0
		? text.slice(resultIndex + "Latest tool result:\n".length)
		: text;
	return { task, app, observation };
}

async function convert(split) {
	const reader = readline.createInterface({
		input: createReadStream(path.join(inputPath, `${split}.jsonl`), { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	const writer = createWriteStream(path.join(outputPath, `${split}.jsonl`), { encoding: "utf8" });
	let rows = 0;
	let skipped = 0;
	for await (const line of reader) {
		if (!line.trim()) continue;
		const source = JSON.parse(line);
		const { task, app, observation } = fields(source.messages?.[1]?.content);
		const actionCall = source.messages?.at(-1)?.tool_calls?.[0]?.function;
		if (!task || !app || actionCall?.name !== "act_ui") {
			skipped += 1;
			continue;
		}
		const seed = hash(source.metadata?.sample_id ?? line).slice(0, 10);
		const launchId = `call_launch_${seed}`;
		const rootsId = `call_roots_${seed}`;
		const observeId = `call_observe_${seed}`;
		const actId = `call_act_${seed}`;
		const title = task.length > 80 ? task.slice(0, 80) : task;
		const messages = [
			{ role: "system", content: SYSTEM_PROMPT },
			{ role: "user", content: `In application ${app}, ${task}` },
			call(launchId, "bash", { command: `open -a ${shellQuote(app)}` }),
			tool(launchId, "bash", "(command completed with no output)"),
			call(rootsId, "find_roots", { app }),
			tool(
				rootsId,
				"find_roots",
				`Found 1 matching root; returned 1. Use @r refs with observe_ui({ root: "@rN" }).\n- @r1 window ${app} pid 1000 — ${title} (z 0, windowId 1, frame 100,100 1000x700, focused, main, onscreen)`,
			),
			call(observeId, "observe_ui", { root: "@r1", mode: "semantic" }),
			tool(observeId, "observe_ui", observation),
			call(actId, "act_ui", actionCall.arguments),
		];
		for (const [stage, length] of [["launch", 3], ["roots", 5], ["observe", 7], ["act", 9]]) {
			const sample = {
				metadata: {
					...source.metadata,
					sample_id: `pi-protocol:${stage}:${source.metadata?.sample_id ?? seed}`,
					derived: "public-data protocol synthesis",
					stage,
				},
				messages: messages.slice(0, length),
				tools: TOOLS,
			};
			writer.write(`${JSON.stringify(sample)}\n`);
			rows += 1;
		}
	}
	await new Promise((resolve, reject) => {
		writer.once("error", reject);
		writer.end(resolve);
	});
	return { rows, skipped };
}

const report = {};
for (const split of ["train", "valid", "test"]) report[split] = await convert(split);
console.log(JSON.stringify({ inputPath, outputPath, splits: report }, null, 2));
