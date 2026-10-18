/**
 * Configuration loading, validation and merging.
 */
import * as fs from "node:fs";

export type Action = "allow" | "ask" | "deny";

/** Rules by pattern, in file order. Keys come from the config file. */
export interface RuleMap {
	[pattern: string]: Action;
}

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

/** A parsed JSON value: what `JSON.parse` produces, before validation. */
export type Json = string | number | boolean | null | Json[] | JsonObject;

export interface JsonObject {
	[key: string]: Json;
}

const ACTIONS: ReadonlySet<string> = new Set<Action>(["allow", "ask", "deny"]);
const POSITIONS: ReadonlySet<string> = new Set<PromptPosition>(["editor", "center", "top"]);

export function isAction(value: unknown): value is Action {
	return typeof value === "string" && ACTIONS.has(value);
}

function isPosition(value: unknown): value is PromptPosition {
	return typeof value === "string" && POSITIONS.has(value);
}

export function isString(value: unknown): value is string {
	return typeof value === "string";
}

export function isNumber(value: unknown): value is number {
	return typeof value === "number";
}

/** Deep check that a value is plain JSON data (what a tool call's arguments are). */
export function isJson(value: unknown): value is Json {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;

	if (typeof value === "number") return Number.isFinite(value);

	if (Array.isArray(value)) return value.every(isJson);

	return typeof value === "object" && Object.values(value).every(isJson);
}

/** Message of a caught error, whatever was thrown. */
export function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export function isJsonObject(value: Json | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function defaultConfig(): PermissionConfig {
	return { default: "ask", tools: {}, external_directory: {}, bash: {}, ui: { position: "editor" } };
}

function parseRules(raw: Json | undefined, where: string, errors: string[]): RuleMap {
	const out: RuleMap = {};

	if (raw === undefined) return out;

	if (!isJsonObject(raw)) {
		errors.push(`${where}: must be an object`);

		return out;
	}

	for (const [pattern, value] of Object.entries(raw)) {
		if (isAction(value)) out[pattern] = value;
		else errors.push(`${where}.${pattern}: invalid value ${JSON.stringify(value)} (use allow/ask/deny)`);
	}

	return out;
}

/** Validates a parsed config object. Invalid entries are dropped and reported in `errors`. */
export function parseConfig(raw: Json, source: string, errors: string[]): PartialConfig {
	if (!isJsonObject(raw)) {
		errors.push(`${source}: must be a JSON object`);

		return {};
	}

	const cfg: PartialConfig = {
		tools: parseRules(raw.tools, `${source}: tools`, errors),
		external_directory: parseRules(raw.external_directory, `${source}: external_directory`, errors),
		bash: parseRules(raw.bash, `${source}: bash`, errors),
	};

	if (raw.default !== undefined) {
		if (isAction(raw.default)) cfg.default = raw.default;
		else errors.push(`${source}: invalid default ${JSON.stringify(raw.default)}`);
	}

	if (raw.ui !== undefined) {
		if (!isJsonObject(raw.ui)) errors.push(`${source}: ui must be an object`);
		else if (raw.ui.position !== undefined) {
			const p = raw.ui.position;

			if (isPosition(p)) cfg.ui = { position: p };
			else errors.push(`${source}: invalid ui.position ${JSON.stringify(p)} (use editor/center/top)`);
		}
	}

	return cfg;
}

/** Reads one config file. Returns undefined if it does not exist. Throws on unreadable or invalid JSON. */
export function readConfigFile(file: string, errors: string[]): PartialConfig | undefined {
	if (!fs.existsSync(file)) return undefined;

	const raw: Json = JSON.parse(fs.readFileSync(file, "utf8"));

	return parseConfig(raw, file, errors);
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
