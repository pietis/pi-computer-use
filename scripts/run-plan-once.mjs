import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const piExecutable = path.join(packageRoot, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");

function usage(message) {
	if (message) console.error(message);
	console.error("Usage: npm run cua -- [--app TextEdit] [--bundle-id com.apple.TextEdit] -- <task>");
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
		"/computer-use-run",
		app ? `--app "${app}"` : undefined,
		bundleId ? `--bundle-id "${bundleId}"` : undefined,
		"--",
		task,
	].filter(Boolean).join(" ");
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
			PI_COMPUTER_USE_OBSERVATION_MODE: process.env.PI_COMPUTER_USE_OBSERVATION_MODE ?? "semantic",
			PI_COMPUTER_USE_EXCEPTION_HANDLER: process.env.PI_COMPUTER_USE_EXCEPTION_HANDLER ?? "1",
		},
	});
	child.once("error", (error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
	child.once("close", (code, signal) => {
		process.exitCode = signal ? 1 : (code ?? 1);
	});
}
