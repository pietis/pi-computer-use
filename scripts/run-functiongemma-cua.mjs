#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const piExecutable = path.join(packageRoot, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
const defaultServerUrl = "http://127.0.0.1:18080/v1";

async function serverReady(serverUrl) {
	try {
		const response = await fetch(`${serverUrl.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(500) });
		return response.ok;
	} catch {
		return false;
	}
}

async function startServerIfNeeded(serverUrl) {
	if (await serverReady(serverUrl)) return undefined;
	if (serverUrl !== defaultServerUrl) throw new Error(`Local model server is unavailable at ${serverUrl}.`);
	const configuredPython = process.env.PI_COMPUTER_USE_MLX_PYTHON;
	const temporaryPython = "/tmp/pi-local-cua-models-venv/bin/python";
	const python = configuredPython ?? (existsSync(temporaryPython) ? temporaryPython : "python3");
	const adapterPath = path.join(packageRoot, ".bench", "adapters", "functiongemma-cua-literal-150");
	if (!existsSync(path.join(adapterPath, "adapters.safetensors"))) {
		throw new Error(`FunctionGemma adapter is missing at ${adapterPath}.`);
	}
	const server = spawn(python, [
		path.join(packageRoot, "scripts", "run-functiongemma-server.py"),
		"--model", "mlx-community/functiongemma-270m-it-4bit",
		"--adapter-path", adapterPath,
		"--host", "127.0.0.1",
		"--port", "18080",
		"--max-tokens", "96",
		"--prompt-cache-size", "4",
		"--log-level", "WARNING",
	], {
		cwd: packageRoot,
		stdio: ["ignore", "ignore", "pipe"],
	});
	let serverError = "";
	server.stderr.on("data", (chunk) => {
		serverError = `${serverError}${String(chunk)}`.slice(-4_000);
	});
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (await serverReady(serverUrl)) {
			console.error("[cua:local] FunctionGemma server started with the CUA LoRA adapter.");
			return server;
		}
		if (server.exitCode !== null) throw new Error(`FunctionGemma server exited during startup.\n${serverError}`.trim());
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	server.kill("SIGTERM");
	throw new Error(`Timed out starting FunctionGemma server.\n${serverError}`.trim());
}

function usage(message) {
	if (message) console.error(message);
	console.error("Usage: npm run cua:local -- [--app TextEdit] [--bundle-id com.apple.TextEdit] -- <task>");
	process.exitCode = 2;
}

function optionValue(args, index, name) {
	const current = args[index];
	if (current === name) {
		const value = args[index + 1];
		if (!value || value === "--") return undefined;
		return { value, consumed: 2 };
	}
	if (current.startsWith(`${name}=`)) {
		const value = current.slice(name.length + 1);
		return value ? { value, consumed: 1 } : undefined;
	}
	return null;
}

const argv = process.argv.slice(2);
let app;
let bundleId;
let taskStart = -1;
for (let index = 0; index < argv.length;) {
	if (argv[index] === "--") {
		taskStart = index + 1;
		break;
	}
	const appOption = optionValue(argv, index, "--app");
	if (appOption) {
		app = appOption.value;
		index += appOption.consumed;
		continue;
	}
	const bundleOption = optionValue(argv, index, "--bundle-id");
	if (bundleOption) {
		bundleId = bundleOption.value;
		index += bundleOption.consumed;
		continue;
	}
	usage(`Unknown option '${argv[index]}'.`);
	process.exit();
}

const task = taskStart >= 0 ? argv.slice(taskStart).join(" ").trim() : "";
if (!task) {
	usage();
} else if ((app && /["'\r\n]/.test(app)) || (bundleId && /["'\r\n]/.test(bundleId))) {
	usage("App and bundle id cannot contain quotes or newlines.");
} else {
	const command = [
		"/computer-use-local",
		app ? `--app "${app}"` : undefined,
		bundleId ? `--bundle-id "${bundleId}"` : undefined,
		"--",
		task,
	].filter(Boolean).join(" ");
	const serverUrl = process.env.PI_COMPUTER_USE_LOCAL_URL ?? defaultServerUrl;
	let managedServer;
	try {
		managedServer = await startServerIfNeeded(serverUrl);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
		process.exit();
	}
	const child = spawn(piExecutable, [
		"--print",
		"--no-session",
		"--no-extensions",
		"-e",
		packageRoot,
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--thinking",
		"off",
		command,
	], {
		cwd: packageRoot,
		stdio: "inherit",
		env: {
			...process.env,
			PI_COMPUTER_USE_LOCAL_URL: serverUrl,
			PI_COMPUTER_USE_OBSERVATION_MODE: "semantic",
			PI_COMPUTER_USE_EXCEPTION_HANDLER: "0",
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
