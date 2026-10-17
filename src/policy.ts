/**
 * Rule matching and permission decisions. Pure logic, no Pi imports.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Action, PermissionConfig, RuleMap } from "./config.ts";
import { normalizeSegment, parseShell } from "./shell.ts";

export interface Decision {
	action: Action;
	/** Human-readable explanation of the rules that produced the decision. */
	reasons: string[];
	/** Resolved target path for file tools. */
	absPath?: string;
}

export interface DecideOptions {
	cwd: string;
	/**
	 * Files and directories that always require confirmation to write, whatever the
	 * rules say (the permission config itself, the extension's own code).
	 */
	protectedPaths?: string[];
}

const RANK: Record<Action, number> = { allow: 0, ask: 1, deny: 2 };

/** Tools whose `path` argument is checked against `external_directory`. */
const FILE_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit", "ls", "find", "grep"]);
const WRITE_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

const CONFIG_NAME = "permissions.json";

/** Max length of a command segment quoted inside a reason (the full command is shown separately). */
const REASON_SNIPPET = 80;

export function strictest(...actions: Action[]): Action {
	return actions.reduce<Action>((a, b) => (RANK[b] > RANK[a] ? b : a), "allow");
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

export function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

function globToRegex(glob: string): RegExp {
	let re = "";
	for (const ch of glob) {
		if (ch === "*") re += ".*";
		else if (ch === "?") re += ".";
		else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`, "s");
}

/**
 * `*` matches anything (including `/` and spaces), `?` one character.
 * A trailing ` *` or `/*` also matches the bare prefix: `git status *` matches
 * `git status`, `~/dev/*` matches `~/dev`.
 */
export function matches(pattern: string, value: string): boolean {
	if (globToRegex(pattern).test(value)) return true;
	if (pattern.endsWith(" *") || pattern.endsWith("/*")) return value === pattern.slice(0, -2);
	return false;
}

/** Specificity = number of literal (non-wildcard) characters. */
function specificity(pattern: string): number {
	return pattern.replace(/[*?]/g, "").length;
}

export interface RuleHit {
	action: Action;
	pattern: string;
}

/** Most specific matching pattern wins; on ties the strictest action wins. */
export function resolveRules(
	rules: RuleMap,
	value: string,
	normalizePattern: (p: string) => string = (p) => p,
): RuleHit | undefined {
	let best: (RuleHit & { spec: number }) | undefined;
	for (const [pattern, action] of Object.entries(rules)) {
		if (!matches(normalizePattern(pattern), value)) continue;
		const spec = specificity(pattern);
		if (!best || spec > best.spec || (spec === best.spec && RANK[action] > RANK[best.action])) {
			best = { action, pattern, spec };
		}
	}
	return best && { action: best.action, pattern: best.pattern };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Resolves a path against cwd, following symlinks of the deepest existing ancestor. */
export function resolvePath(p: string | undefined, cwd: string): string {
	const abs = path.resolve(cwd, expandHome(p ?? "."));
	let existing = abs;
	const rest: string[] = [];
	while (!fs.existsSync(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) return abs;
		rest.unshift(path.basename(existing));
		existing = parent;
	}
	try {
		return path.join(fs.realpathSync(existing), ...rest);
	} catch {
		return abs;
	}
}

export function isInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

function snippet(s: string): string {
	return s.length > REASON_SNIPPET ? `${s.slice(0, REASON_SNIPPET - 1)}…` : s;
}

/**
 * Explains which rule produced an action. A `"*"` pattern is reported as the
 * fallback so it never reads like something being granted.
 */
export function explain(subject: string, section: string, hit: RuleHit | undefined, action: Action): string {
	if (hit && hit.pattern !== "*") return `${subject} → matched ${section} "${hit.pattern}": ${action}`;
	if (hit) return `${subject} → no matching ${section} rule (fallback "*": ${action})`;
	return `${subject} → no matching ${section} rule (default: ${action})`;
}

function decideTool(cfg: PermissionConfig, toolName: string): Decision {
	const hit = resolveRules(cfg.tools, toolName);
	const action = hit?.action ?? cfg.default;
	return { action, reasons: [explain(toolName, "tools", hit, action)] };
}

function decidePath(cfg: PermissionConfig, absPath: string, cwd: string): Decision | undefined {
	if (isInside(absPath, cwd)) return undefined;
	const hit = resolveRules(cfg.external_directory, absPath, expandHome);
	const action = hit?.action ?? "ask";
	return { action, reasons: [explain("outside project", "external_directory", hit, action)] };
}

function decideBash(cfg: PermissionConfig, command: string, protectedPaths: string[]): Decision {
	const { segments, risky } = parseShell(command);
	if (segments.length === 0) return { action: "ask", reasons: ["empty command"] };

	let action: Action = "allow";
	const reasons: string[] = [];
	for (const seg of segments) {
		const text = normalizeSegment(seg.text);
		const hit = resolveRules(cfg.bash, text);
		const a = hit?.action ?? cfg.default;
		reasons.push(explain(`"${snippet(text)}"`, "bash", hit, a));
		action = strictest(action, a);
	}
	if (risky.length) {
		action = strictest(action, "ask");
		reasons.push(`contains ${risky.join(", ")} → requires confirmation`);
	}
	// Best effort: bash can write anywhere, so mentioning a protected path (absolute, or
	// any `permissions.json`, which covers relative forms) requires confirmation.
	const mentionsConfig = protectedPaths.some((p) => p.endsWith(CONFIG_NAME)) && command.includes(CONFIG_NAME);
	if (mentionsConfig || protectedPaths.some((p) => command.includes(p))) {
		action = strictest(action, "ask");
		reasons.push("mentions a protected permission file → requires confirmation");
	}
	return { action, reasons };
}

export function decide(
	cfg: PermissionConfig,
	toolName: string,
	input: Record<string, unknown>,
	opts: DecideOptions,
): Decision {
	const protectedPaths = opts.protectedPaths ?? [];
	if (toolName === "bash") return decideBash(cfg, String(input.command ?? ""), protectedPaths);

	const tool = decideTool(cfg, toolName);
	if (!FILE_TOOLS.has(toolName)) return tool;

	const absPath = resolvePath(typeof input.path === "string" ? input.path : undefined, opts.cwd);
	let action = tool.action;
	const reasons = [...tool.reasons];

	const outside = decidePath(cfg, absPath, opts.cwd);
	if (outside) {
		action = strictest(action, outside.action);
		reasons.push(...outside.reasons);
	}
	if (WRITE_TOOLS.has(toolName) && protectedPaths.some((p) => isInside(absPath, p))) {
		action = strictest(action, "ask");
		reasons.push("protected permission file → requires confirmation");
	}
	return { action, reasons, absPath };
}
