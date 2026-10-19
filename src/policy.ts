/**
 * Rule matching and permission decisions. Pure logic, no Pi imports.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Action, type JsonObject, type PermissionConfig, type RuleMap, isString } from "./config.ts";
import { type PathArg, analyzeReadonly, cdEffect } from "./readonly.ts";
import { type Token, normalizeSegment, parseShell, tokenize } from "./shell.ts";

/**
 * Why an action was reached. `fallback` is a `"*"` rule, reported apart so it
 * never reads like something being granted. `note` forces confirmation.
 */
export type Reason =
	| { kind: "match"; subject: string; section: string; pattern: string; action: Action }
	| { kind: "fallback" | "default"; subject: string; section: string; action: Action }
	| { kind: "note"; subject: string; action: "ask" }
	| { kind: "readonly"; subject: string; action: Action }
	| { kind: "skipped"; subject: string; why: string };

export function formatReason(r: Reason): string {
	switch (r.kind) {
		case "match":
			return `${r.subject} → matched ${r.section} "${r.pattern}": ${r.action}`;
		case "fallback":
			return `${r.subject} → no matching ${r.section} rule (fallback "*": ${r.action})`;
		case "default":
			return `${r.subject} → no matching ${r.section} rule (default: ${r.action})`;
		case "note":
			return `${r.subject} → requires confirmation`;
		case "readonly":
			return `${r.subject} → read-only command: ${r.action}`;
		case "skipped":
			return `${r.subject} → not read-only: ${r.why}`;
	}
}

/** Reasons the user has to weigh: anything not plainly allowed. Allowed ones are context. */
export function needsDecision(r: Reason): boolean {
	return r.kind === "skipped" || r.action !== "allow";
}

export interface Decision {
	action: Action;
	/** The rules that produced the decision. */
	reasons: Reason[];
	/** Resolved target path for file tools, symlinks followed. Rules and grants use this one. */
	absPath?: string;
	/** The path as requested (absolute, symlinks not followed). Differs from `absPath` through a symlink. */
	requestedPath?: string;
	/** A write tool targets a protected permission file. */
	protected?: boolean;
}

export interface DecideOptions {
	cwd: string;
	/**
	 * Files and directories that always require confirmation to write, whatever the
	 * rules say (the permission config itself, the extension's own code).
	 */
	protectedPaths?: string[];
	/** $CDPATH, which changes where `cd name` goes. */
	cdpath?: string;
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

/** Explains which rule produced an action. */
function explain(subject: string, section: string, hit: RuleHit | undefined, action: Action): Reason {
	if (hit && hit.pattern !== "*") return { kind: "match", subject, section, pattern: hit.pattern, action };

	return { kind: hit ? "fallback" : "default", subject, section, action };
}

function note(subject: string): Reason {
	return { kind: "note", subject, action: "ask" };
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

/**
 * Directories a segment may run in. `cd` adds one and keeps the previous ones
 * (it can fail, or run in a pipeline subshell); anything that may change the
 * directory in a way that cannot be followed makes it unknown.
 */
interface WorkingDirs {
	dirs: string[];
	known: boolean;
}

/** A path argument resolved: `real` follows symlinks (rules use it), `requested` does not (shown to the user). */
interface ResolvedArg {
	real: string;
	requested: string;
}

/** Resolves a path argument. A quoted `~` is a literal name, not home. */
function argPath(arg: PathArg, dir: string): ResolvedArg {
	const value = !arg.tilde && arg.value.startsWith("~") ? `./${arg.value}` : arg.value;

	return { real: resolvePath(value, dir), requested: path.resolve(dir, expandHome(value)) };
}

function isAbsoluteArg(arg: PathArg): boolean {
	return arg.tilde || path.isAbsolute(arg.value);
}

/** Every path `arg` can resolve to: one if absolute, one per possible working directory otherwise. */
function argPaths(arg: PathArg, wd: WorkingDirs, project: string): ResolvedArg[] {
	return isAbsoluteArg(arg) ? [argPath(arg, project)] : wd.dirs.map((d) => argPath(arg, d));
}

function followCd(tokens: Token[] | undefined, wd: WorkingDirs, opts: DecideOptions): void {
	const effect = cdEffect(tokens, opts.cdpath);

	if (effect.kind === "unknown") wd.known = false;

	if (effect.kind !== "dir") return;

	for (const { real } of argPaths(effect.target, wd, opts.cwd)) if (!wd.dirs.includes(real)) wd.dirs.push(real);
}

type ReadonlyOutcome = { action: Action; reasons: Reason[] } | { why: string };

/**
 * A read-only segment takes `readonly_commands`, made stricter by every path it
 * reads outside the project, through `external_directory`.
 */
function decideReadonly(
	cfg: PermissionConfig,
	readonly: Action,
	tokens: Token[],
	wd: WorkingDirs,
	opts: DecideOptions,
): ReadonlyOutcome | undefined {
	// Without operands, `ls`, `grep -r` or `find` read the working directory itself.
	if (!wd.known) return { why: "the working directory is unknown after an earlier command" };
	const [head] = tokens;
	let paths: PathArg[];

	if (head?.kind === "word" && head.value === "cd") {
		const effect = cdEffect(tokens, opts.cdpath);

		if (effect.kind !== "dir") return { why: "the target directory cannot be known" };
		paths = [effect.target];
	} else {
		const result = analyzeReadonly(tokens);

		if (!result) return undefined;

		if (!result.ok) return { why: result.why };
		paths = result.paths;
	}

	let action = readonly;
	const reasons: Reason[] = [];
	const seen = new Set<string>();

	for (const arg of paths) {
		for (const { real, requested } of argPaths(arg, wd, opts.cwd)) {
			if (seen.has(real) || isInside(real, opts.cwd)) continue;
			seen.add(real);
			const hit = resolveRules(cfg.external_directory, real, expandHome);
			const a = hit?.action ?? "ask";
			const subject = real === requested ? real : `${real} (symlink from ${requested})`;
			reasons.push(explain(subject, "external_directory", hit, a));
			action = strictest(action, a);
		}
	}

	return { action, reasons };
}

function decideBash(cfg: PermissionConfig, command: string, opts: DecideOptions): Decision {
	const protectedPaths = opts.protectedPaths ?? [];
	const { segments, risky } = parseShell(command);

	if (segments.length === 0) return { action: "ask", reasons: [note("empty command")] };

	let action: Action = "allow";
	const reasons: Reason[] = [];
	const wd: WorkingDirs = { dirs: [opts.cwd], known: true };
	const readonly = cfg.readonly_commands;
	/** Every segment passed the read-only analysis, so none of them can write. */
	let onlyReads = true;

	for (const seg of segments) {
		const text = normalizeSegment(seg.text);
		const subject = `"${snippet(text)}"`;
		const tokens = tokenize(seg.text);
		const hit = resolveRules(cfg.bash, text);
		const ruleAction = hit?.action ?? cfg.default;
		let segAction = ruleAction;
		let segReasons = [explain(subject, "bash", hit, ruleAction)];

		// Read-only analysis can only loosen the "*" fallback or the default; explicit rules always win.
		const explicit = hit !== undefined && hit.pattern !== "*";
		const looser = readonly !== undefined && RANK[readonly] < RANK[ruleAction];
		const ro = readonly && looser && !explicit && tokens ? decideReadonly(cfg, readonly, tokens, wd, opts) : undefined;

		if (ro && "why" in ro) {
			// The same cause (e.g. an unknown working directory) is reported once, not per segment.
			if (!reasons.some((r) => r.kind === "skipped" && r.why === ro.why)) {
				segReasons.push({ kind: "skipped", subject, why: ro.why });
			}

			onlyReads = false;
		} else if (ro && readonly && RANK[ro.action] <= RANK[ruleAction]) {
			segAction = ro.action;
			segReasons = [{ kind: "readonly", subject, action: readonly }, ...ro.reasons];
		} else onlyReads = false;

		reasons.push(...segReasons);
		action = strictest(action, segAction);
		followCd(tokens, wd, opts);
	}

	if (risky.length) {
		action = strictest(action, "ask");
		reasons.push(note(`contains ${risky.join(", ")}`));
	}

	// Best effort: bash can write anywhere, so mentioning a protected path (absolute, or
	// any `permissions.json`, which covers relative forms) requires confirmation. The
	// protection is against writes: a command made only of read-only segments is exempt.
	const mentionsConfig = protectedPaths.some((p) => p.endsWith(CONFIG_NAME)) && command.includes(CONFIG_NAME);
	const mentions = mentionsConfig || protectedPaths.some((p) => command.includes(p));

	if (mentions && !(onlyReads && risky.length === 0)) {
		action = strictest(action, "ask");
		reasons.push(note("mentions a protected permission file"));
	}

	return { action, reasons };
}

export function decide(cfg: PermissionConfig, toolName: string, input: JsonObject, opts: DecideOptions): Decision {
	const protectedPaths = opts.protectedPaths ?? [];

	if (toolName === "bash") return decideBash(cfg, isString(input.command) ? input.command : "", opts);

	const tool = decideTool(cfg, toolName);

	if (!FILE_TOOLS.has(toolName)) return tool;

	const rawPath = isString(input.path) ? input.path : undefined;
	const absPath = resolvePath(rawPath, opts.cwd);
	const requestedPath = path.resolve(opts.cwd, expandHome(rawPath ?? "."));
	let action = tool.action;
	const reasons = [...tool.reasons];

	const outside = decidePath(cfg, absPath, opts.cwd);

	if (outside) {
		action = strictest(action, outside.action);
		reasons.push(...outside.reasons);
	}

	const isProtected = WRITE_TOOLS.has(toolName) && protectedPaths.some((p) => isInside(absPath, p));

	if (isProtected) {
		action = strictest(action, "ask");
		reasons.push(note("protected permission file"));
	}

	const result: Decision = { action, reasons, absPath, requestedPath };

	if (isProtected) result.protected = true;

	return result;
}
