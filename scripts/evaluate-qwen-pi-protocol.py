#!/usr/bin/env python3

import argparse
import json
import random
import re
import statistics
import time
from collections import defaultdict
from pathlib import Path

from mlx_lm import generate, load
from mlx_lm.tool_parsers.qwen3_coder import parse_tool_call


parser = argparse.ArgumentParser(description="Evaluate the public-data Pi tool protocol adapter.")
parser.add_argument("--model", default="mlx-community/Qwen3.5-2B-4bit")
parser.add_argument("--adapter-path", required=True)
parser.add_argument("--data", default=".bench/public-cua/sft-public-protocol/test.jsonl")
parser.add_argument("--samples-per-stage", type=int, default=4)
parser.add_argument("--max-tokens", type=int, default=256)
parser.add_argument("--seed", type=int, default=42)
args = parser.parse_args()

groups = defaultdict(list)
with Path(args.data).open() as source:
    for line in source:
        row = json.loads(line)
        groups[row["metadata"]["stage"]].append(row)

rng = random.Random(args.seed)
selected = []
for stage, rows in sorted(groups.items()):
    selected.extend(rng.sample(rows, min(args.samples_per_stage, len(rows))))
rng.shuffle(selected)

load_started = time.perf_counter()
model, tokenizer = load(args.model, adapter_path=args.adapter_path)
load_seconds = time.perf_counter() - load_started

latencies = []
examples = []
by_stage = defaultdict(lambda: {"count": 0, "syntax": 0, "name": 0, "exact": 0})
for row in selected:
    expected = row["messages"][-1]["tool_calls"][0]["function"]
    prompt = tokenizer.apply_chat_template(
        row["messages"][:-1],
        tools=row["tools"],
        tokenize=False,
        add_generation_prompt=True,
        enable_thinking=False,
    )
    started = time.perf_counter()
    output = generate(model, tokenizer, prompt=prompt, max_tokens=args.max_tokens, verbose=False)
    latency = time.perf_counter() - started
    latencies.append(latency)
    parsed = None
    try:
        block = re.search(r"<function=.*?</function>", output, re.DOTALL)
        parsed = parse_tool_call(block.group(0) if block else output, row["tools"])
    except (ValueError, IndexError, TypeError, SyntaxError):
        pass

    stage = row["metadata"]["stage"]
    stats = by_stage[stage]
    stats["count"] += 1
    stats["syntax"] += int(parsed is not None)
    stats["name"] += int(bool(parsed and parsed["name"] == expected["name"]))
    stats["exact"] += int(bool(parsed and parsed["name"] == expected["name"] and parsed["arguments"] == expected["arguments"]))
    examples.append(
        {
            "stage": stage,
            "expected": expected,
            "predicted": parsed,
            "latency_ms": round(latency * 1000, 2),
            "output": output[:600],
        }
    )

def rate(value, count):
    return round(value / count, 4) if count else 0

summary = {
    "model": args.model,
    "adapter_path": args.adapter_path,
    "data": args.data,
    "samples": len(selected),
    "load_seconds": round(load_seconds, 3),
    "by_stage": {
        stage: {
            "samples": stats["count"],
            "syntax_valid_rate": rate(stats["syntax"], stats["count"]),
            "tool_name_accuracy": rate(stats["name"], stats["count"]),
            "exact_call_accuracy": rate(stats["exact"], stats["count"]),
        }
        for stage, stats in sorted(by_stage.items())
    },
    "latency_ms": {
        "mean": round(statistics.mean(latencies) * 1000, 2) if latencies else 0,
        "p50": round(statistics.median(latencies) * 1000, 2) if latencies else 0,
        "p95": round(sorted(latencies)[round((len(latencies) - 1) * 0.95)] * 1000, 2) if latencies else 0,
    },
    "examples": examples,
}
print(json.dumps(summary, ensure_ascii=False, indent=2))
