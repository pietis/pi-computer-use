#!/usr/bin/env node

import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inputPath = path.resolve(packageRoot, process.argv[2] ?? ".bench/public-cua/sft");
const outputPath = path.resolve(packageRoot, process.argv[3] ?? ".bench/public-cua/sft-compact");
const maxOutlineLines = Math.max(8, Math.trunc(Number(process.argv[4] ?? 36)));
mkdirSync(outputPath, { recursive: true });

function compactUserContent(content, targetRef) {
	const lines = String(content ?? "").split("\n");
	const outlineStart = lines.findIndex((line) => line.startsWith("Outline ("));
	if (outlineStart < 0) return content;
	let outlineEnd = outlineStart + 1;
	while (outlineEnd < lines.length && /^@e\d+\s/.test(lines[outlineEnd])) outlineEnd += 1;
	const outline = lines.slice(outlineStart + 1, outlineEnd);
	const selected = outline.slice(0, maxOutlineLines);
	if (targetRef) {
		const target = outline.find((line) => line.startsWith(`${targetRef} `));
		if (target && !selected.includes(target)) {
			if (selected.length >= maxOutlineLines) selected.pop();
			selected.push(target);
		}
	}
	const heading = lines[outlineStart].replace(/Outline \(\d+ shown nodes,/, `Outline (${selected.length} shown nodes,`);
	return [...lines.slice(0, outlineStart), heading, ...selected, ...lines.slice(outlineEnd)].join("\n");
}

const report = {};
for (const split of ["train", "valid", "test"]) {
	const reader = readline.createInterface({
		input: createReadStream(path.join(inputPath, `${split}.jsonl`), { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	const writer = createWriteStream(path.join(outputPath, `${split}.jsonl`), { encoding: "utf8" });
	let count = 0;
	for await (const line of reader) {
		if (!line.trim()) continue;
		const row = JSON.parse(line);
		const functionCall = row.messages.at(-1).tool_calls[0].function;
		const targetRef = functionCall.arguments.actions[0].ref;
		row.messages[1].content = compactUserContent(row.messages[1].content, targetRef);
		row.tools = row.tools.filter((tool) => tool.function?.name === "act_ui");
		writer.write(`${JSON.stringify(row)}\n`);
		count += 1;
	}
	await new Promise((resolve, reject) => {
		writer.once("error", reject);
		writer.end(resolve);
	});
	report[split] = count;
}

console.log(JSON.stringify({ inputPath, outputPath, maxOutlineLines, rows: report }, null, 2));
