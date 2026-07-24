#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python = process.env.PI_COMPUTER_USE_MLX_PYTHON
	?? (existsSync("/tmp/pi-local-cua-models-venv/bin/python") ? "/tmp/pi-local-cua-models-venv/bin/python" : "python3");
const adapterPath = process.env.PI_COMPUTER_USE_PUBLIC_QWEN_ADAPTER
	?? path.join(packageRoot, ".bench", "public-cua", "adapters", "qwen-public-protocol-launch-132");
const serverUrl = "http://127.0.0.1:18081/v1";

async function installedAppNames() {
	const roots = [
		"/Applications",
		"/System/Applications",
		"/System/Applications/Utilities",
		path.join(process.env.HOME ?? "", "Applications"),
	];
	const names = new Set();
	for (const root of roots) {
		if (!root || !existsSync(root)) continue;
		for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
			if (entry.isDirectory() && entry.name.endsWith(".app")) names.add(entry.name.slice(0, -4));
		}
	}
	return [...names];
}

function normalized(value) {
	return String(value).normalize("NFKC").toLocaleLowerCase().replace(/[\s_-]+/g, "");
}

async function resolveRequestedApp(task) {
	const normalizedTask = normalized(task);
	const matches = (await installedAppNames())
		.map((name) => ({ name, index: normalizedTask.indexOf(normalized(name)) }))
		.filter((entry) => entry.index >= 0)
		.sort((a, b) => a.index - b.index || normalized(b.name).length - normalized(a.name).length || a.name.localeCompare(b.name));
	return matches[0]?.name;
}

async function launchApp(app) {
	if (!app) return;
	await new Promise((resolve, reject) => {
		const child = spawn("open", ["-a", app], { stdio: "ignore" });
		child.once("error", reject);
		child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`open -a ${JSON.stringify(app)} exited with ${code}`)));
	});
}

async function serverReady() {
	try {
		const response = await fetch(`${serverUrl}/models`, { signal: AbortSignal.timeout(600) });
		return response.ok;
	} catch {
		return false;
	}
}

async function startServer() {
	if (await serverReady()) return undefined;
	if (!existsSync(path.join(adapterPath, "adapters.safetensors"))) {
		throw new Error(`Public Qwen adapter is missing at ${adapterPath}. Run the public-data LoRA training first.`);
	}
	const server = spawn(python, [
		path.join(packageRoot, "scripts", "run-functiongemma-server.py"),
		"--model", "mlx-community/Qwen3.5-2B-4bit",
		"--adapter-path", adapterPath,
		"--host", "127.0.0.1",
		"--port", "18081",
		"--max-tokens", "256",
		"--prompt-cache-size", "8",
		"--chat-template-args", "{\"enable_thinking\":false}",
		"--log-level", "WARNING",
	], {
		cwd: packageRoot,
		stdio: ["ignore", "ignore", "pipe"],
	});
	let errorText = "";
	server.stderr.on("data", (chunk) => {
		errorText = `${errorText}${String(chunk)}`.slice(-4_000);
	});
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (await serverReady()) {
			console.error("[cua:public] Qwen public AX adapter server started.");
			return server;
		}
		if (server.exitCode !== null) throw new Error(`Local server exited during startup.\n${errorText}`.trim());
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	server.kill("SIGTERM");
	throw new Error(`Timed out starting the local model server.\n${errorText}`.trim());
}

const taskSeparator = process.argv.indexOf("--");
if (taskSeparator < 0 || taskSeparator === process.argv.length - 1) {
	console.error("Usage: npm run cua:public -- [--max-rounds N] [--stop-on-text TEXT] -- <task>");
	process.exitCode = 2;
} else {
	const task = process.argv.slice(taskSeparator + 1).join(" ");
	const prelaunchedApp = await resolveRequestedApp(task);
	if (prelaunchedApp) {
		await launchApp(prelaunchedApp);
		console.error(`[cua:public] Matched and launched installed app ${JSON.stringify(prelaunchedApp)}.`);
	}
	let managedServer;
	try {
		managedServer = await startServer();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
		process.exit();
	}
	const runnerArgs = [
		path.join(packageRoot, "scripts", "run-low-latency-loop.mjs"),
		"--model", "local-public-qwen/mlx-community/Qwen3.5-2B-4bit",
		"--system-prompt", "prompts/low-latency-loop.md",
		"--tools", "bash,find_roots,observe_ui,search_ui,expand_ui,inspect_ui,act_ui,wait_for,read_text",
		"--extension", ".bench/local-provider-compat.ts",
		...process.argv.slice(2),
	];
	const child = spawn(process.execPath, runnerArgs, {
		cwd: packageRoot,
		stdio: "inherit",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: path.join(packageRoot, ".bench", "public-cua", "local-agent"),
			PI_COMPUTER_USE_OBSERVATION_MODE: "semantic",
			PI_COMPUTER_USE_EXCEPTION_HANDLER: "0",
			...(prelaunchedApp ? { PI_COMPUTER_USE_PRELAUNCHED_APP: prelaunchedApp } : {}),
		},
	});
	child.once("error", (error) => {
		managedServer?.kill("SIGTERM");
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
	child.once("close", (code, signal) => {
		managedServer?.kill("SIGTERM");
		process.exitCode = signal ? 1 : (code ?? 1);
	});
}
