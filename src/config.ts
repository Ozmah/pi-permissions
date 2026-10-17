/**
 * Configuration loading, validation and merging.
 */
import * as fs from "node:fs";

export type Action = "allow" | "ask" | "deny";
export type RuleMap = Record<string, Action>;

/**
 * Where the permission prompt appears:
 * - `editor`: replaces the input editor until answered (nothing else can be typed)
 * - `center`: floating box centered over the transcript, grows with its content
 * - `top`:    floating box anchored to the top of the screen
 */
export type PromptPosition = "editor" | "center" | "top";

export interface PermissionConfig {
	default: Action;
	tools: RuleMap;
	external_directory: RuleMap;
	bash: RuleMap;
	ui: { position: PromptPosition };
}

export type PartialConfig = Partial<Omit<PermissionConfig, "ui">> & { ui?: Partial<PermissionConfig["ui"]> };

export const ACTIONS: ReadonlySet<string> = new Set<Action>(["allow", "ask", "deny"]);
const POSITIONS: ReadonlySet<string> = new Set<PromptPosition>(["editor", "center", "top"]);

export function defaultConfig(): PermissionConfig {
	return { default: "ask", tools: {}, external_directory: {}, bash: {}, ui: { position: "editor" } };
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseRules(raw: unknown, where: string, errors: string[]): RuleMap {
	const out: RuleMap = {};
	if (raw === undefined) return out;
	if (!isObject(raw)) {
		errors.push(`${where}: must be an object`);
		return out;
	}
	for (const [pattern, value] of Object.entries(raw)) {
		if (typeof value === "string" && ACTIONS.has(value)) out[pattern] = value as Action;
		else errors.push(`${where}.${pattern}: invalid value ${JSON.stringify(value)} (use allow/ask/deny)`);
	}
	return out;
}

/** Validates a parsed config object. Invalid entries are dropped and reported in `errors`. */
export function parseConfig(raw: unknown, source: string, errors: string[]): PartialConfig {
	if (!isObject(raw)) {
		errors.push(`${source}: must be a JSON object`);
		return {};
	}
	const cfg: PartialConfig = {
		tools: parseRules(raw.tools, `${source}: tools`, errors),
		external_directory: parseRules(raw.external_directory, `${source}: external_directory`, errors),
		bash: parseRules(raw.bash, `${source}: bash`, errors),
	};
	if (raw.default !== undefined) {
		if (typeof raw.default === "string" && ACTIONS.has(raw.default)) cfg.default = raw.default as Action;
		else errors.push(`${source}: invalid default ${JSON.stringify(raw.default)}`);
	}
	if (raw.ui !== undefined) {
		if (!isObject(raw.ui)) errors.push(`${source}: ui must be an object`);
		else if (raw.ui.position !== undefined) {
			const p = raw.ui.position;
			if (typeof p === "string" && POSITIONS.has(p)) cfg.ui = { position: p as PromptPosition };
			else errors.push(`${source}: invalid ui.position ${JSON.stringify(p)} (use editor/center/top)`);
		}
	}
	return cfg;
}

/** Reads one config file. Returns undefined if it does not exist. Throws on unreadable or invalid JSON. */
export function readConfigFile(file: string, errors: string[]): PartialConfig | undefined {
	if (!fs.existsSync(file)) return undefined;
	return parseConfig(JSON.parse(fs.readFileSync(file, "utf8")), file, errors);
}

/** Later configs override earlier ones key by key. */
export function mergeConfigs(...layers: (PartialConfig | undefined)[]): PermissionConfig {
	const out = defaultConfig();
	for (const c of layers) {
		if (!c) continue;
		if (c.default) out.default = c.default;
		Object.assign(out.tools, c.tools);
		Object.assign(out.external_directory, c.external_directory);
		Object.assign(out.bash, c.bash);
		if (c.ui?.position) out.ui.position = c.ui.position;
	}
	return out;
}
