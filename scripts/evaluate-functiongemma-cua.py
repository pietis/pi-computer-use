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
from mlx_lm.tool_parsers.function_gemma import parse_tool_call


def percentile(values, fraction):
    ordered = sorted(values)
    index = min(len(ordered) - 1, round((len(ordered) - 1) * fraction))
    return ordered[index]


def rendered_call(text):
    match = re.search(r"<start_function_call>.*?<end_function_call>", text, re.DOTALL)
    return match.group(0) if match else None


def call_name(text):
    match = re.search(r"<start_function_call>call:([A-Za-z_]\w*)\{", text)
    return match.group(1) if match else None


parser = argparse.ArgumentParser(description="Evaluate FunctionGemma next-action tool calls.")
parser.add_argument("--model", default="mlx-community/functiongemma-270m-it-4bit")
parser.add_argument("--adapter-path")
parser.add_argument("--data", default=".bench/cua-sft/test.jsonl")
parser.add_argument("--source", choices=["agentnet", "synthetic_ax"])
parser.add_argument("--samples-per-action", type=int, default=5)
parser.add_argument("--max-tokens", type=int, default=96)
parser.add_argument("--seed", type=int, default=42)
args = parser.parse_args()

rows_by_action = defaultdict(list)
with Path(args.data).open() as source:
    for line in source:
        row = json.loads(line)
        if args.source and row.get("metadata", {}).get("source") != args.source:
            continue
        action = row["messages"][-1]["tool_calls"][0]["function"]["name"]
        rows_by_action[action].append(row)

rng = random.Random(args.seed)
selected = []
for action in sorted(rows_by_action):
    candidates = rows_by_action[action]
    selected.extend(rng.sample(candidates, min(args.samples_per_action, len(candidates))))
rng.shuffle(selected)

load_started = time.perf_counter()
model, tokenizer = load(args.model, adapter_path=args.adapter_path)
load_seconds = time.perf_counter() - load_started

if selected:
    warmup_row = selected[0]
    warmup_prompt = tokenizer.apply_chat_template(
        warmup_row["messages"][:-1],
        tools=warmup_row["tools"],
        tokenize=False,
        add_generation_prompt=True,
    )
    generate(model, tokenizer, prompt=warmup_prompt, max_tokens=4, verbose=False)

latencies = []
results = []
per_action = defaultdict(lambda: {
    "count": 0,
    "syntax_valid": 0,
    "schema_valid": 0,
    "name_correct": 0,
    "normalized_exact": 0,
    "exact": 0,
})
for index, row in enumerate(selected, start=1):
    expected_function = row["messages"][-1]["tool_calls"][0]["function"]
    expected_name = expected_function["name"]
    prompt = tokenizer.apply_chat_template(
        row["messages"][:-1],
        tools=row["tools"],
        tokenize=False,
        add_generation_prompt=True,
    )
    full = tokenizer.apply_chat_template(row["messages"], tools=row["tools"], tokenize=False)
    expected_suffix = full[len(prompt):] if full.startswith(prompt) else full
    expected_call = rendered_call(expected_suffix)

    started = time.perf_counter()
    output = generate(
        model,
        tokenizer,
        prompt=prompt,
        max_tokens=args.max_tokens,
        verbose=False,
    )
    latency = time.perf_counter() - started
    latencies.append(latency)

    predicted_call = rendered_call(output)
    parsed_call = None
    if predicted_call:
        try:
            parsed_call = parse_tool_call(predicted_call)
        except (ValueError, IndexError):
            pass
    predicted_name = parsed_call["name"] if parsed_call else call_name(output)
    syntax_valid = parsed_call is not None
    name_correct = predicted_name == expected_name
    tool_schemas = {tool["function"]["name"]: tool["function"] for tool in row["tools"]}
    predicted_schema = tool_schemas.get(predicted_name)
    predicted_arguments = parsed_call["arguments"] if parsed_call else {}
    allowed_arguments = set(predicted_schema["parameters"].get("properties", {})) if predicted_schema else set()
    required_arguments = set(predicted_schema["parameters"].get("required", [])) if predicted_schema else set()
    normalized_arguments = {
        key: value for key, value in predicted_arguments.items() if key in allowed_arguments
    }
    schema_valid = bool(
        syntax_valid
        and predicted_schema
        and required_arguments.issubset(normalized_arguments)
    )
    normalized_exact = bool(
        name_correct
        and normalized_arguments == expected_function["arguments"]
    )
    exact = syntax_valid and predicted_call == expected_call
    metrics = per_action[expected_name]
    metrics["count"] += 1
    metrics["syntax_valid"] += int(syntax_valid)
    metrics["schema_valid"] += int(schema_valid)
    metrics["name_correct"] += int(name_correct)
    metrics["normalized_exact"] += int(normalized_exact)
    metrics["exact"] += int(exact)
    if len(results) < 8 or not name_correct:
        results.append({
            "expected": expected_function,
            "predicted_name": predicted_name,
            "syntax_valid": syntax_valid,
            "schema_valid": schema_valid,
            "normalized_arguments": normalized_arguments,
            "normalized_exact": normalized_exact,
            "exact": exact,
            "latency_ms": round(latency * 1000, 2),
            "output": output[:400],
        })
    print(
        f"[{index}/{len(selected)}] expected={expected_name} predicted={predicted_name} "
        f"latency={latency:.3f}s",
        file=sys.stderr,
    )

total = len(selected)
syntax_valid_total = sum(value["syntax_valid"] for value in per_action.values())
schema_valid_total = sum(value["schema_valid"] for value in per_action.values())
name_total = sum(value["name_correct"] for value in per_action.values())
normalized_exact_total = sum(value["normalized_exact"] for value in per_action.values())
exact_total = sum(value["exact"] for value in per_action.values())
summary = {
    "model": args.model,
    "adapter_path": args.adapter_path,
    "data": args.data,
    "source": args.source,
    "samples": total,
    "load_seconds": round(load_seconds, 3),
    "syntax_valid_rate": round(syntax_valid_total / total, 4) if total else 0,
    "schema_valid_rate": round(schema_valid_total / total, 4) if total else 0,
    "tool_name_accuracy": round(name_total / total, 4) if total else 0,
    "normalized_exact_accuracy": round(normalized_exact_total / total, 4) if total else 0,
    "exact_call_accuracy": round(exact_total / total, 4) if total else 0,
    "latency_ms": {
        "mean": round(statistics.mean(latencies) * 1000, 2) if latencies else 0,
        "p50": round(statistics.median(latencies) * 1000, 2) if latencies else 0,
        "p95": round(percentile(latencies, 0.95) * 1000, 2) if latencies else 0,
    },
    "per_action": {
        action: {
            **metrics,
            "name_accuracy": round(metrics["name_correct"] / metrics["count"], 4),
            "normalized_exact_accuracy": round(metrics["normalized_exact"] / metrics["count"], 4),
            "exact_accuracy": round(metrics["exact"] / metrics["count"], 4),
        }
        for action, metrics in sorted(per_action.items())
    },
    "examples": results,
}
print(json.dumps(summary, ensure_ascii=False, indent=2))
