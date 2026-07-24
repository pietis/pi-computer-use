#!/usr/bin/env node

import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const separator = process.argv.indexOf("--");
if (separator < 3 || separator === process.argv.length - 1) {
	console.error("Usage: node scripts/merge-public-cua-data.mjs <output-dir> -- <input-dir> [input-dir...]");
	process.exitCode = 2;
} else {
	const outputPath = path.resolve(packageRoot, process.argv[2]);
	const inputPaths = process.argv.slice(separator + 1).map((value) => path.resolve(packageRoot, value));
	mkdirSync(outputPath, { recursive: true });
	const report = {};
	for (const split of ["train", "valid", "test"]) {
		const writer = createWriteStream(path.join(outputPath, `${split}.jsonl`), { encoding: "utf8" });
		const seen = new Set();
		let count = 0;
		for (const inputPath of inputPaths) {
			const reader = readline.createInterface({
				input: createReadStream(path.join(inputPath, `${split}.jsonl`), { encoding: "utf8" }),
				crlfDelay: Number.POSITIVE_INFINITY,
			});
			for await (const line of reader) {
				if (!line.trim()) continue;
				const row = JSON.parse(line);
				const key = row.metadata?.sample_id ?? line;
				if (seen.has(key)) continue;
				seen.add(key);
				writer.write(`${JSON.stringify(row)}\n`);
				count += 1;
			}
		}
		await new Promise((resolve, reject) => {
			writer.once("error", reject);
			writer.end(resolve);
		});
		report[split] = count;
	}
	console.log(JSON.stringify({ outputPath, inputPaths, rows: report }, null, 2));
}
