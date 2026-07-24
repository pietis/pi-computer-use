#!/usr/bin/env node

import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inputPath = path.resolve(packageRoot, process.argv[2] ?? ".bench/public-cua/sft-public-protocol");
const outputPath = path.resolve(packageRoot, process.argv[3] ?? ".bench/public-cua/sft-public-launch");
mkdirSync(outputPath, { recursive: true });

function variants(app, task) {
	return [
		`Open ${app} and complete this task: ${task}`,
		`Launch application ${app}, then do the following: ${task}`,
		`${app}를 열고 다음 작업을 수행하세요: ${task}`,
		`다음 작업을 위해 ${app} 앱을 실행하세요: ${task}`,
		`${app}を開いて、次の作業を実行してください: ${task}`,
		`打开 ${app} 并执行以下任务：${task}`,
	];
}

async function convert(split) {
	const reader = readline.createInterface({
		input: createReadStream(path.join(inputPath, `${split}.jsonl`), { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	const writer = createWriteStream(path.join(outputPath, `${split}.jsonl`), { encoding: "utf8" });
	let rows = 0;
	for await (const line of reader) {
		if (!line.trim()) continue;
		const source = JSON.parse(line);
		if (source.metadata?.stage !== "launch") continue;
		const original = String(source.messages?.[1]?.content ?? "");
		const match = original.match(/^In application (.*?),\s*(.*)$/s);
		if (!match) continue;
		const [, app, task] = match;
		for (const [index, content] of variants(app, task).entries()) {
			const row = structuredClone(source);
			row.metadata.sample_id = `launch-${index}:${row.metadata.sample_id}`;
			row.metadata.augmentation = ["en-open", "en-launch", "ko-open", "ko-launch", "ja-open", "zh-open"][index];
			row.messages[1].content = content;
			writer.write(`${JSON.stringify(row)}\n`);
			rows += 1;
		}
	}
	await new Promise((resolve, reject) => {
		writer.once("error", reject);
		writer.end(resolve);
	});
	return rows;
}

const report = {};
for (const split of ["train", "valid", "test"]) report[split] = await convert(split);
console.log(JSON.stringify({ inputPath, outputPath, rows: report }, null, 2));
