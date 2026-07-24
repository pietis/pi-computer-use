#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inputPath = path.resolve(packageRoot, process.argv[2] ?? ".bench/public-cua/sft-public-merged24");
const outputPath = path.resolve(packageRoot, process.argv[3] ?? ".bench/public-cua/sft-public-balanced");
const targetPerAction = Math.max(1, Math.trunc(Number(process.argv[4] ?? 700)));
const maxRepeats = Math.max(1, Math.trunc(Number(process.argv[5] ?? 8)));
mkdirSync(outputPath, { recursive: true });

function hash(value) {
	return createHash("sha256").update(String(value)).digest("hex");
}

async function readRows(filePath) {
	const rows = [];
	const reader = readline.createInterface({
		input: createReadStream(filePath, { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of reader) if (line.trim()) rows.push(JSON.parse(line));
	return rows;
}

const trainRows = await readRows(path.join(inputPath, "train.jsonl"));
const groups = new Map();
for (const row of trainRows) {
	const action = row.messages.at(-1).tool_calls[0].function.arguments.actions[0].action;
	const group = groups.get(action) ?? [];
	group.push(row);
	groups.set(action, group);
}

const selected = [];
const report = {};
for (const [action, rows] of [...groups.entries()].sort()) {
	rows.sort((a, b) => hash(a.metadata.sample_id).localeCompare(hash(b.metadata.sample_id)));
	const repeats = Math.min(maxRepeats, Math.max(1, Math.ceil(targetPerAction / rows.length)));
	const wanted = Math.min(targetPerAction, rows.length * repeats);
	for (let index = 0; index < wanted; index += 1) selected.push(rows[index % rows.length]);
	report[action] = { available: rows.length, repeats, emitted: wanted };
}
selected.sort((a, b) => hash(`balanced:${a.metadata.sample_id}`).localeCompare(hash(`balanced:${b.metadata.sample_id}`)));

const trainWriter = createWriteStream(path.join(outputPath, "train.jsonl"), { encoding: "utf8" });
for (const row of selected) trainWriter.write(`${JSON.stringify(row)}\n`);
await new Promise((resolve, reject) => {
	trainWriter.once("error", reject);
	trainWriter.end(resolve);
});

for (const split of ["valid", "test"]) {
	const rows = await readRows(path.join(inputPath, `${split}.jsonl`));
	const writer = createWriteStream(path.join(outputPath, `${split}.jsonl`), { encoding: "utf8" });
	for (const row of rows) writer.write(`${JSON.stringify(row)}\n`);
	await new Promise((resolve, reject) => {
		writer.once("error", reject);
		writer.end(resolve);
	});
}

console.log(JSON.stringify({
	inputPath,
	outputPath,
	targetPerAction,
	maxRepeats,
	trainRows: selected.length,
	actions: report,
}, null, 2));
