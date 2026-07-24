#!/usr/bin/env python3

import argparse
import json
import random
import re
import statistics
import sys
import time
from collections import defaultdict
from pathlib import Path

from mlx_lm import generate, load
from mlx_lm.tool_parsers.qwen3_coder import parse_tool_call


def percentile(values, fraction):
    ordered = sorted(values)
    index = min(len(ordered) - 1, round((len(ordered) - 1) * fraction))
    return ordered[index]


parser = argparse.ArgumentParser(description="Evaluate Qwen Pi act_ui calls on public CUA data.")
parser.add_argument("--model", default="mlx-community/Qwen3.5-2B-4bit")
parser.add_argument("--adapter-path")
parser.add_argument("--data", default=".bench/public-cua/sft/test.jsonl")
parser.add_argument("--samples-per-source-action", type=int, default=2)
parser.add_argument("--max-tokens", type=int, default=192)
parser.add_argument("--seed", type=int, default=42)
args = parser.parse_args()

groups = defaultdict(list)
with Path(args.data).open() as source:
    for line in source:
        row = json.loads(line)
        function = row["messages"][-1]["tool_calls"][0]["function"]
        action = function["arguments"]["actions"][0]["action"]
        groups[(row["metadata"]["source"], action)].append(row)

rng = random.Random(args.seed)
selected = []
for group in sorted(groups):
    candidates = groups[group]
    selected.extend(rng.sample(candidates, min(args.samples_per_source_action, len(candidates))))
rng.shuffle(selected)

load_started = time.perf_counter()
model, tokenizer = load(args.model, adapter_path=args.adapter_path)
load_seconds = time.perf_counter() - load_started

if selected:
    prompt = tokenizer.apply_chat_template(
        selected[0]["messages"][:-1],
        tools=selected[0]["tools"],
        tokenize=False,
        add_generation_prompt=True,
        enable_thinking=False,
    )
    generate(model, tokenizer, prompt=prompt, max_tokens=4, verbose=False)

latencies = []
results = []
totals = defaultdict(int)
for index, row in enumerate(selected, start=1):
    expected = row["messages"][-1]["tool_calls"][0]["function"]
    expected_arguments = expected["arguments"]
    expected_action = expected_arguments["actions"][0]
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
        function_block = re.search(r"<function=.*?</function>", output, re.DOTALL)
        parsed = parse_tool_call(function_block.group(0) if function_block else output, row["tools"])
    except (ValueError, IndexError, TypeError, SyntaxError):
        pass
    syntax_valid = parsed is not None
    name_correct = bool(parsed and parsed["name"] == expected["name"])
    predicted_arguments = parsed["arguments"] if parsed else {}
    state_copy = predicted_arguments.get("stateId") == expected_arguments["stateId"]
    predicted_actions = predicted_arguments.get("actions")
    predicted_action = predicted_actions[0] if isinstance(predicted_actions, list) and predicted_actions else {}
    action_correct = predicted_action.get("action") == expected_action["action"]
    ref_correct = expected_action.get("ref") is None or predicted_action.get("ref") == expected_action.get("ref")
    exact = bool(name_correct and predicted_arguments == expected_arguments)

    totals["count"] += 1
    totals["syntax_valid"] += int(syntax_valid)
    totals["name_correct"] += int(bool(name_correct))
    totals["state_copy"] += int(state_copy)
    totals["action_correct"] += int(action_correct)
    totals["ref_correct"] += int(ref_correct)
    totals["exact"] += int(exact)
    results.append(
        {
            "source": row["metadata"]["source"],
            "expected": expected,
            "predicted": parsed,
            "syntax_valid": syntax_valid,
            "state_copy": state_copy,
            "action_correct": action_correct,
            "ref_correct": ref_correct,
            "exact": exact,
            "latency_ms": round(latency * 1000, 2),
            "output": output[:600],
        }
    )
    print(
        f"[{index}/{len(selected)}] {row['metadata']['source']} "
        f"expected={expected_action['action']} predicted={predicted_action.get('action')} "
        f"latency={latency:.3f}s",
        file=sys.stderr,
        flush=True,
    )

count = totals["count"]
summary = {
    "model": args.model,
    "adapter_path": args.adapter_path,
    "data": args.data,
    "samples": count,
    "load_seconds": round(load_seconds, 3),
    "syntax_valid_rate": round(totals["syntax_valid"] / count, 4) if count else 0,
    "tool_name_accuracy": round(totals["name_correct"] / count, 4) if count else 0,
    "state_copy_accuracy": round(totals["state_copy"] / count, 4) if count else 0,
    "action_accuracy": round(totals["action_correct"] / count, 4) if count else 0,
    "ref_accuracy": round(totals["ref_correct"] / count, 4) if count else 0,
    "exact_call_accuracy": round(totals["exact"] / count, 4) if count else 0,
    "latency_ms": {
        "mean": round(statistics.mean(latencies) * 1000, 2) if latencies else 0,
        "p50": round(statistics.median(latencies) * 1000, 2) if latencies else 0,
        "p95": round(percentile(latencies, 0.95) * 1000, 2) if latencies else 0,
    },
    "examples": results,
}
print(json.dumps(summary, ensure_ascii=False, indent=2))
