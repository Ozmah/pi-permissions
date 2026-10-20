/**
 * Configuration loading, validation and merging.
 *
 * The config is about what must not happen: rules `halt`, `deny` or `ask`.
 * Anything without a rule asks, and "stfu pi" grants can silence that for a
 * folder. Allowing without asking takes a deliberate `yes-i-am-very-sure`.
 */
import * as fs from "node:fs";

/** What a rule does, as written in the config, from loosest to strictest. */
export type Rule = "yes-i-am-very-sure" | "ask" | "deny" | "halt";

/** The outcome of a decision: `halt` is a `deny` that also alerts the user. */
export type Verdict = "allow" | "ask" | "deny" | "halt";

/** The phrase that allows without asking. Long and odd on purpose: it cannot be typed by accident. */
export const VERY_SURE = "yes-i-am-very-sure";

/** Rules by pattern, in file order. Keys come from the config file. */
export interface RuleMap {
	[pattern: string]: Rule;
}

/**
 * Where the permission prompt appears:
 * - `editor`: replaces the input editor until answered (nothing else can be typed)
 * - `center`: floating box centered over the transcript, grows with its content
 * - `top`:    floating box anchored to the top of the screen
 */
export type PromptPosition = "editor" | "center" | "top";

export interface PermissionConfig {
	/** Bash command segments, e.g. `"sudo *": "halt"`. */
	commands: RuleMap;
	/** Paths read or written by any tool, e.g. `"~/.ssh/**": "deny"`. */
	paths: RuleMap;
	/** Tools by name, e.g. `"webfetch": "deny"`. */
	tools: RuleMap;
	/** Reading inside the project (file tools and read-only bash commands) runs without asking. */
	readonly: boolean;
	ui: {
		position: PromptPosition;
		/** Ask the agent for a short description of each bash command, shown in the prompt. Needs /reload. */
		describe_commands: boolean;
	};
}

export type PartialConfig = Partial<Omit<PermissionConfig, "ui">> & { ui?: Partial<PermissionConfig["ui"]> };

/** A parsed JSON value: what `JSON.parse` produces, before validation. */
export type Json = string | number | boolean | null | Json[] | JsonObject;

export interface JsonObject {
	[key: string]: Json;
}

const RULES: ReadonlySet<string> = new Set<Rule>([VERY_SURE, "ask", "deny", "halt"]);
const POSITIONS: ReadonlySet<string> = new Set<PromptPosition>(["editor", "center", "top"]);

/** Keys of the pre-0.5 format, reported so an old config is not silently ignored. */
const LEGACY_KEYS = ["default", "external_directory", "bash", "readonly_commands"];

export function isRule(value: unknown): value is Rule {
	return typeof value === "string" && RULES.has(value);
}

/** The verdict a rule produces. */
export function ruleVerdict(rule: Rule): Verdict {
	return rule === VERY_SURE ? "allow" : rule;
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
	return { commands: {}, paths: {}, tools: {}, readonly: true, ui: { position: "editor", describe_commands: false } };
}

function invalidRule(value: Json): string {
	if (value === "allow") return `"allow" is not accepted; to allow without asking, write "${VERY_SURE}"`;

	return `invalid value ${JSON.stringify(value)} (use halt/deny/ask/${VERY_SURE})`;
}

function parseRules(raw: Json | undefined, where: string, errors: string[]): RuleMap {
	const out: RuleMap = {};

	if (raw === undefined) return out;

	if (!isJsonObject(raw)) {
		errors.push(`${where}: must be an object`);

		return out;
	}

	for (const [pattern, value] of Object.entries(raw)) {
		if (isRule(value)) out[pattern] = value;
		else errors.push(`${where}.${pattern}: ${invalidRule(value)}`);
	}

	return out;
}

/** Validates a parsed config object. Invalid entries are dropped and reported in `errors`. */
export function parseConfig(raw: Json, source: string, errors: string[]): PartialConfig {
	if (!isJsonObject(raw)) {
		errors.push(`${source}: must be a JSON object`);

		return {};
	}

	const legacy = LEGACY_KEYS.filter((k) => raw[k] !== undefined);

	if (legacy.length) {
		const keys = legacy.join(", ");
		errors.push(`${source}: ${keys}: old format, ignored. Rules are now "commands", "paths" and "tools" (see README)`);
	}

	const cfg: PartialConfig = {
		commands: parseRules(raw.commands, `${source}: commands`, errors),
		paths: parseRules(raw.paths, `${source}: paths`, errors),
		tools: parseRules(raw.tools, `${source}: tools`, errors),
	};

	if (raw.readonly !== undefined) {
		if (raw.readonly === true || raw.readonly === false) cfg.readonly = raw.readonly;
		else errors.push(`${source}: readonly must be true or false`);
	}

	if (raw.ui !== undefined) {
		if (!isJsonObject(raw.ui)) errors.push(`${source}: ui must be an object`);
		else {
			const ui: Partial<PermissionConfig["ui"]> = {};
			const { position, describe_commands: describe } = raw.ui;

			if (position !== undefined) {
				if (isPosition(position)) ui.position = position;
				else errors.push(`${source}: invalid ui.position ${JSON.stringify(position)} (use editor/center/top)`);
			}

			if (describe !== undefined) {
				if (describe === true || describe === false) ui.describe_commands = describe;
				else errors.push(`${source}: ui.describe_commands must be true or false`);
			}

			if (Object.keys(ui).length) cfg.ui = ui;
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

		Object.assign(out.commands, c.commands);
		Object.assign(out.paths, c.paths);
		Object.assign(out.tools, c.tools);

		if (c.readonly !== undefined) out.readonly = c.readonly;

		if (c.ui?.position) out.ui.position = c.ui.position;

		if (c.ui?.describe_commands !== undefined) out.ui.describe_commands = c.ui.describe_commands;
	}

	return out;
}
