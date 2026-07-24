import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const piExecutable = path.join(packageRoot, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
const systemPrompt = path.join(packageRoot, "prompts", "low-latency-loop.md");

function usage(message) {
	if (message) console.error(message);
	console.error("Usage: npm run cua:loop -- [--model provider/model] [--system-prompt path] [--tools names] [--extension path] [--max-rounds n] [--stop-on-text text] -- <task>");
	process.exitCode = 2;
}

const argv = process.argv.slice(2);
let model;
let selectedSystemPrompt = systemPrompt;
let selectedTools = "bash,find_roots,observe_ui,search_ui,expand_ui,inspect_ui,act_ui,wait_for,read_text";
const extraExtensions = [];
let maxRounds = Number.POSITIVE_INFINITY;
let stopOnText;
let taskStart = -1;
for (let index = 0; index < argv.length;) {
	if (argv[index] === "--") {
		taskStart = index + 1;
		break;
	}
	if (argv[index] === "--model" && argv[index + 1] && argv[index + 1] !== "--") {
		model = argv[index + 1];
		index += 2;
		continue;
	}
	if (argv[index].startsWith("--model=")) {
		model = argv[index].slice("--model=".length);
		index += 1;
		continue;
	}
	if (argv[index] === "--system-prompt" && argv[index + 1] && argv[index + 1] !== "--") {
		selectedSystemPrompt = path.resolve(packageRoot, argv[index + 1]);
		index += 2;
		continue;
	}
	if (argv[index].startsWith("--system-prompt=")) {
		selectedSystemPrompt = path.resolve(packageRoot, argv[index].slice("--system-prompt=".length));
		index += 1;
		continue;
	}
	if (argv[index] === "--tools" && argv[index + 1] && argv[index + 1] !== "--") {
		selectedTools = argv[index + 1];
		index += 2;
		continue;
	}
	if (argv[index].startsWith("--tools=")) {
		selectedTools = argv[index].slice("--tools=".length);
		index += 1;
		continue;
	}
	if (argv[index] === "--extension" && argv[index + 1] && argv[index + 1] !== "--") {
		extraExtensions.push(path.resolve(packageRoot, argv[index + 1]));
		index += 2;
		continue;
	}
	if (argv[index].startsWith("--extension=")) {
		extraExtensions.push(path.resolve(packageRoot, argv[index].slice("--extension=".length)));
		index += 1;
		continue;
	}
	if (argv[index] === "--max-rounds" && Number.isFinite(Number(argv[index + 1]))) {
		maxRounds = Math.max(1, Math.trunc(Number(argv[index + 1])));
		index += 2;
		continue;
	}
	if (argv[index].startsWith("--max-rounds=") && Number.isFinite(Number(argv[index].slice("--max-rounds=".length)))) {
		maxRounds = Math.max(1, Math.trunc(Number(argv[index].slice("--max-rounds=".length))));
		index += 1;
		continue;
	}
	if (argv[index] === "--stop-on-text" && argv[index + 1] && argv[index + 1] !== "--") {
		stopOnText = argv[index + 1];
		index += 2;
		continue;
	}
	if (argv[index].startsWith("--stop-on-text=")) {
		stopOnText = argv[index].slice("--stop-on-text=".length);
		index += 1;
		continue;
	}
	usage(`Unknown option '${argv[index]}'.`);
	process.exit();
}

const task = taskStart >= 0 ? argv.slice(taskStart).join(" ").trim() : "";
if (!task) {
	usage();
} else {
	const startedAt = performance.now();
	const rounds = [];
	const tools = new Map();
	const errors = [];
	let currentRound;
	let firstTurnAt;
	let finalText = "";
	let stoppedOnSuccess = false;
	let completionSignal;

	const piArgs = [
		"--mode", "json",
		"--no-session",
		"--no-extensions",
		"-e", packageRoot,
	];
	for (const extension of extraExtensions) piArgs.push("-e", extension);
	piArgs.push(
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--system-prompt", selectedSystemPrompt,
		"--thinking", "off",
		"--tools", selectedTools,
		"--approve",
	);
	if (model) piArgs.push("--model", model);
	piArgs.push(task);

	const child = spawn(piExecutable, piArgs, {
		cwd: packageRoot,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			PI_COMPUTER_USE_OBSERVATION_MODE: "semantic",
			PI_COMPUTER_USE_EXCEPTION_HANDLER: "0",
		},
	});

	child.stderr.pipe(process.stderr);
	const lines = readline.createInterface({ input: child.stdout });
	lines.on("line", (line) => {
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		const at = performance.now() - startedAt;
		if (event.type === "turn_start") {
			if (rounds.length >= maxRounds) {
				const message = `Stopped after reaching the configured ${maxRounds}-round limit.`;
				errors.push({ type: "runner", round: rounds.length, message });
				console.error(`[cua:loop] ${message}`);
				child.kill("SIGTERM");
				return;
			}
			firstTurnAt ??= at;
			currentRound = {
				index: typeof event.turnIndex === "number" ? event.turnIndex : rounds.length,
				startMs: at,
				ttftMs: undefined,
				decisionMs: undefined,
				totalMs: undefined,
				tools: [],
			};
			rounds.push(currentRound);
			console.error(`[cua:loop] LLM round ${currentRound.index + 1} started`);
			return;
		}
		if (event.type === "message_update" && currentRound && currentRound.ttftMs === undefined) {
			const kind = event.assistantMessageEvent?.type;
			if (kind === "text_delta" || kind === "toolcall_delta" || kind === "thinking_delta") {
				currentRound.ttftMs = at - currentRound.startMs;
			}
			return;
		}
		if (event.type === "tool_execution_start") {
			if (currentRound && currentRound.decisionMs === undefined) currentRound.decisionMs = at - currentRound.startMs;
			const timing = { name: event.toolName, arguments: event.args, startMs: at, durationMs: undefined, isError: undefined };
			tools.set(event.toolCallId, timing);
			currentRound?.tools.push(timing);
			const serializedArgs = JSON.stringify(event.args ?? {});
			console.error(`[cua:loop] tool ${event.toolName} started ${serializedArgs.slice(0, 1_000)}`);
			return;
		}
		if (event.type === "tool_execution_end") {
			const timing = tools.get(event.toolCallId);
			const result = event.result;
			const contentText = Array.isArray(result?.content)
				? result.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n")
				: "";
			if (timing) {
				timing.durationMs = at - timing.startMs;
				timing.isError = event.isError === true;
				const duration = Math.round(timing.durationMs * 100) / 100;
				if (timing.isError) {
					const message = String(result?.error?.message ?? result?.error ?? contentText ?? "Unknown tool error").slice(0, 2_000);
					timing.error = message;
					errors.push({ type: "tool", round: currentRound?.index, tool: timing.name, message });
					console.error(`[cua:loop] tool ${timing.name} failed after ${duration}ms: ${message}`);
				} else {
					console.error(`[cua:loop] tool ${timing.name} completed in ${duration}ms`);
				}
			}
			const normalizedTarget = stopOnText?.normalize("NFC");
			const matchingTextAction = timing?.name === "act_ui"
				&& Array.isArray(timing.arguments?.actions)
				&& timing.arguments.actions.some((action) =>
					(action?.action === "typeText" || action?.action === "setText")
					&& String(action?.text ?? "").normalize("NFC") === normalizedTarget);
			const matchingResult = normalizedTarget && contentText.normalize("NFC").includes(normalizedTarget);
			if (!stoppedOnSuccess && event.isError !== true && stopOnText && (matchingResult || matchingTextAction)) {
				stoppedOnSuccess = true;
				completionSignal = matchingResult ? "tool-result-text" : "successful-text-action";
				finalText = `Completed target text action: ${stopOnText}`;
				console.error(`[cua:loop] completed target text action; stopping before any follow-up action`);
				child.kill("SIGTERM");
			}
			return;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const stopReason = event.message.stopReason;
			if (stopReason === "error" || stopReason === "aborted") {
				const message = String(event.message.errorMessage ?? `Assistant stopped with ${stopReason}`).slice(0, 2_000);
				errors.push({ type: "model", round: currentRound?.index, message });
				console.error(`[cua:loop] model ${stopReason}: ${message}`);
			}
			return;
		}
		if (event.type === "turn_end" && currentRound) {
			currentRound.totalMs = at - currentRound.startMs;
			if (currentRound.decisionMs === undefined) currentRound.decisionMs = currentRound.totalMs;
			const parts = event.message?.role === "assistant"
				? event.message.content?.filter((part) => part.type === "text").map((part) => part.text)
				: undefined;
			if (parts?.length) finalText = parts.join("\n");
			currentRound = undefined;
			return;
		}
		if (event.type === "agent_end" && Array.isArray(event.messages)) {
			const assistant = [...event.messages].reverse().find((message) => message?.role === "assistant");
			const parts = assistant?.content?.filter((part) => part.type === "text").map((part) => part.text);
			if (parts?.length) finalText = parts.join("\n");
		}
	});

	child.once("error", (error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
	child.once("close", (code, signal) => {
		const wallMs = performance.now() - startedAt;
		const succeeded = stopOnText ? stoppedOnSuccess : (!signal && code === 0);
		if (currentRound && currentRound.totalMs === undefined) {
			currentRound.totalMs = wallMs - currentRound.startMs;
			if (currentRound.decisionMs === undefined) currentRound.decisionMs = currentRound.totalMs;
		}
		if (finalText) console.log(`\nResult: ${finalText}`);
		const roundedRounds = rounds.map((round) => ({
			index: round.index,
			ttftMs: round.ttftMs === undefined ? undefined : Math.round(round.ttftMs * 100) / 100,
			decisionMs: round.decisionMs === undefined ? undefined : Math.round(round.decisionMs * 100) / 100,
			totalMs: round.totalMs === undefined ? undefined : Math.round(round.totalMs * 100) / 100,
			tools: round.tools.map((tool) => ({
				name: tool.name,
				arguments: tool.arguments,
				durationMs: tool.durationMs === undefined ? undefined : Math.round(tool.durationMs * 100) / 100,
				isError: tool.isError,
				error: tool.error,
			})),
		}));
		console.log("\nLatency:");
		console.log(JSON.stringify({
			ok: succeeded,
			completedTargetText: stoppedOnSuccess ? stopOnText : undefined,
			completionSignal,
			wallMs: Math.round(wallMs * 100) / 100,
			startupToFirstTurnMs: firstTurnAt === undefined ? undefined : Math.round(firstTurnAt * 100) / 100,
			llmRounds: roundedRounds.length,
			errors,
			rounds: roundedRounds,
		}, null, 2));
		process.exitCode = succeeded ? 0 : 1;
	});
}
