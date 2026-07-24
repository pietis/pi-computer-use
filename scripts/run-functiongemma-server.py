#!/usr/bin/env python3

"""Run MLX-LM with local compatibility fixes for adapted tool-call models.

MLX-LM 0.31.3 records the CLI adapter under ``default_model`` and then
resolves that alias before looking up the adapter. Requests consequently load
the base model without LoRA. Keep the existing server implementation while
adding the resolved model ID to its adapter map.

Qwen 3.5 emits ``<tool_call><function=...>...</function></tool_call>``. The
MLX Qwen parser expects its input to end exactly at ``</function>``, while the
server sometimes passes the enclosing ``</tool_call>`` too. In that case the
server silently drops the otherwise valid tool call and returns an empty
assistant message. Normalize that parser input after the tokenizer is loaded.
"""

import re
import json
import logging

from mlx_lm import server


_original_init = server.ModelProvider.__init__
_original_load = server.ModelProvider._load


def _init_with_resolved_adapter(self, cli_args):
    _original_init(self, cli_args)
    if cli_args.model and cli_args.adapter_path:
        self._adapter_map[cli_args.model] = cli_args.adapter_path


def _load_with_robust_tool_parser(
    self, model_path, adapter_path=None, draft_model_path=None
):
    _original_load(self, model_path, adapter_path, draft_model_path)
    parser = getattr(self.tokenizer, "tool_parser", None)
    if parser is None or getattr(parser, "_pi_outer_tool_call_compatible", False):
        return

    def normalize_to_available_tool(parsed, tools):
        functions = [
            tool.get("function", {})
            for tool in (tools or [])
            if tool.get("type") == "function"
        ]
        if len(functions) == 1:
            parsed["name"] = functions[0].get("name", parsed.get("name"))
        selected = next(
            (function for function in functions if function.get("name") == parsed.get("name")),
            None,
        )
        properties = (selected or {}).get("parameters", {}).get("properties", {})
        arguments = parsed.setdefault("arguments", {})
        for key, schema in properties.items():
            if isinstance(schema, dict) and "const" in schema:
                arguments[key] = schema["const"]
        actions_schema = properties.get("actions", {})
        action_properties = actions_schema.get("items", {}).get("properties", {})
        if isinstance(arguments.get("actions"), list):
            for action in arguments["actions"]:
                if not isinstance(action, dict):
                    continue
                for key, schema in action_properties.items():
                    if isinstance(schema, dict) and "const" in schema:
                        action[key] = schema["const"]
        return parsed

    def parse_inner_function(model_output, tools=None):
        match = re.search(r"<function=.*?</function>", model_output, re.DOTALL)
        normalized = match.group(0) if match else model_output
        try:
            return normalize_to_available_tool(parser(normalized, tools), tools)
        except Exception as error:
            # LoRA checkpoints can occasionally mix the canonical JSON value
            # for a nested parameter with nested XML parameter tags. Recover
            # the common act_ui fields rather than crashing the HTTP request.
            name_match = re.search(r"<function=([^>]+)>", normalized)
            if not name_match:
                raise ValueError("No recoverable function name.") from error

            arguments = {}
            for key in ("stateId", "rootId", "query", "ref", "text"):
                value_match = re.search(
                    rf"<parameter={key}>\s*(.*?)\s*</parameter>",
                    normalized,
                    re.DOTALL,
                )
                if value_match:
                    arguments[key] = value_match.group(1)

            actions_match = re.search(
                r"<parameter=actions>\s*(.*?)\s*</parameter>",
                normalized,
                re.DOTALL,
            )
            if actions_match:
                actions_text = actions_match.group(1).strip()
                try:
                    arguments["actions"] = json.loads(actions_text)
                except json.JSONDecodeError:
                    try:
                        arguments["actions"], _ = json.JSONDecoder().raw_decode(
                            actions_text
                        )
                    except json.JSONDecodeError:
                        action_match = re.search(
                            r"(?:<parameter=action>|parameter=action[=>\"']+)"
                            r"\s*([A-Za-z]+)",
                            actions_text,
                        )
                        ref_match = re.search(
                            r"(?:<parameter=ref>|parameter=ref[=>\"']+)"
                            r"\s*(@[A-Za-z0-9_-]+)",
                            actions_text,
                        )
                        if action_match:
                            action = {"action": action_match.group(1)}
                            if ref_match:
                                action["ref"] = ref_match.group(1)
                            arguments["actions"] = [action]

            logging.warning(
                "Recovered noncanonical tool call after %s: %r",
                type(error).__name__,
                model_output[:400],
            )
            return normalize_to_available_tool(
                {"name": name_match.group(1), "arguments": arguments}, tools
            )

    parse_inner_function._pi_outer_tool_call_compatible = True
    self.tokenizer._tool_parser = parse_inner_function


server.ModelProvider.__init__ = _init_with_resolved_adapter
server.ModelProvider._load = _load_with_robust_tool_parser


if __name__ == "__main__":
    server.main()
