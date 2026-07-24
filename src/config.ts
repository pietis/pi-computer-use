import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type ComputerUseObservationMode = "semantic" | "fused" | "visual";

export interface ComputerUseConfig {
	browser_use: boolean;
	headless: boolean;
	cursor_overlay: boolean;
	managed_browser: "helium" | "chrome";
	observation_mode: ComputerUseObservationMode;
	exception_handler: boolean;
	exception_handler_model?: string;
	exception_handler_confidence: number;
}

export interface ComputerUseConfigSource {
	path: string;
	exists: boolean;
	values?: Partial<ComputerUseConfig>;
	error?: string;
}

export interface LoadedComputerUseConfig {
	config: ComputerUseConfig;
	sources: ComputerUseConfigSource[];
	env: Partial<ComputerUseConfig>;
}

const DEFAULT_CONFIG: ComputerUseConfig = {
	browser_use: true,
	headless: false,
	cursor_overlay: true,
	managed_browser: "chrome",
	observation_mode: "fused",
	exception_handler: false,
	exception_handler_confidence: 0.85,
};

let activeConfig: ComputerUseConfig = { ...DEFAULT_CONFIG };
let activeLoadedConfig: LoadedComputerUseConfig = { config: activeConfig, sources: [], env: {} };

function parseBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
	if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
	return undefined;
}

function parseUnitInterval(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : undefined;
}

function normalizePartial(raw: unknown): Partial<ComputerUseConfig> {
	if (!raw || typeof raw !== "object") return {};
	const source = (raw as any).computer_use && typeof (raw as any).computer_use === "object" ? (raw as any).computer_use : raw;
	const out: Partial<ComputerUseConfig> = {};
	const browserUse = parseBoolean((source as any).browser_use);
	const headless = parseBoolean((source as any).headless);
	const cursorOverlay = parseBoolean((source as any).cursor_overlay);
	const exceptionHandler = parseBoolean((source as any).exception_handler);
	if (browserUse !== undefined) out.browser_use = browserUse;
	if (headless !== undefined) out.headless = headless;
	if (cursorOverlay !== undefined) out.cursor_overlay = cursorOverlay;
	if (exceptionHandler !== undefined) out.exception_handler = exceptionHandler;
	const managedBrowser = (source as any).managed_browser;
	if (managedBrowser === "helium" || managedBrowser === "chrome") out.managed_browser = managedBrowser;
	const observationMode = (source as any).observation_mode;
	if (observationMode === "semantic" || observationMode === "fused" || observationMode === "visual") out.observation_mode = observationMode;
	const exceptionHandlerModel = (source as any).exception_handler_model;
	if (typeof exceptionHandlerModel === "string" && exceptionHandlerModel.trim()) out.exception_handler_model = exceptionHandlerModel.trim();
	const exceptionHandlerConfidence = parseUnitInterval((source as any).exception_handler_confidence);
	if (exceptionHandlerConfidence !== undefined) out.exception_handler_confidence = exceptionHandlerConfidence;
	return out;
}

function readConfigFile(filePath: string): ComputerUseConfigSource {
	if (!existsSync(filePath)) return { path: filePath, exists: false };
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
		return { path: filePath, exists: true, values: normalizePartial(parsed) };
	} catch (error) {
		return { path: filePath, exists: true, error: error instanceof Error ? error.message : String(error) };
	}
}

function readEnv(): Partial<ComputerUseConfig> {
	const out: Partial<ComputerUseConfig> = {};
	const browserUse = parseBoolean(process.env.PI_COMPUTER_USE_BROWSER_USE);
	const headless = parseBoolean(process.env.PI_COMPUTER_USE_HEADLESS);
	const cursorOverlay = parseBoolean(process.env.PI_COMPUTER_USE_CURSOR_OVERLAY);
	const exceptionHandler = parseBoolean(process.env.PI_COMPUTER_USE_EXCEPTION_HANDLER);
	if (browserUse !== undefined) out.browser_use = browserUse;
	if (headless !== undefined) out.headless = headless;
	if (cursorOverlay !== undefined) out.cursor_overlay = cursorOverlay;
	if (exceptionHandler !== undefined) out.exception_handler = exceptionHandler;
	const managedBrowser = process.env.PI_COMPUTER_USE_MANAGED_BROWSER;
	if (managedBrowser === "helium" || managedBrowser === "chrome") out.managed_browser = managedBrowser;
	const observationMode = process.env.PI_COMPUTER_USE_OBSERVATION_MODE;
	if (observationMode === "semantic" || observationMode === "fused" || observationMode === "visual") out.observation_mode = observationMode;
	const exceptionHandlerModel = process.env.PI_COMPUTER_USE_EXCEPTION_HANDLER_MODEL;
	if (exceptionHandlerModel?.trim()) out.exception_handler_model = exceptionHandlerModel.trim();
	const exceptionHandlerConfidence = parseUnitInterval(process.env.PI_COMPUTER_USE_EXCEPTION_HANDLER_CONFIDENCE);
	if (exceptionHandlerConfidence !== undefined) out.exception_handler_confidence = exceptionHandlerConfidence;
	return out;
}

export function loadComputerUseConfig(cwd: string): LoadedComputerUseConfig {
	const sources = [
		readConfigFile(path.join(getAgentDir(), "extensions", "pi-computer-use.json")),
		readConfigFile(path.join(cwd, ".pi", "computer-use.json")),
	];
	const env = readEnv();
	const config = { ...DEFAULT_CONFIG };
	for (const source of sources) {
		if (source.values) Object.assign(config, source.values);
	}
	Object.assign(config, env);
	activeConfig = config;
	activeLoadedConfig = { config, sources, env };
	return activeLoadedConfig;
}

export function getComputerUseConfig(): ComputerUseConfig {
	return activeConfig;
}

export function getLoadedComputerUseConfig(): LoadedComputerUseConfig {
	return activeLoadedConfig;
}

export function isHeadlessMode(): boolean {
	return activeConfig.headless;
}

export function isBrowserUseEnabled(): boolean {
	return activeConfig.browser_use;
}

export function observationPolicy(
	mode: ComputerUseObservationMode = activeConfig.observation_mode,
): {
	imageMode: "never" | "auto" | "always";
	readText: "never" | "auto" | "always";
	includeImage: boolean;
} {
	switch (mode) {
		case "semantic":
			return { imageMode: "never", readText: "never", includeImage: false };
		case "visual":
			return { imageMode: "always", readText: "always", includeImage: true };
		case "fused":
			return { imageMode: "auto", readText: "auto", includeImage: true };
	}
}
