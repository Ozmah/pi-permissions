/**
 * Rule matching and permission decisions. Pure logic, no Pi imports.
 *
 * Every matching rule counts and the strictest wins: halt > deny > ask >
 * yes-i-am-very-sure. Without a rule, reading inside the project runs (when
 * `readonly` is on) and anything else asks.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type JsonObject,
	type PermissionConfig,
	type Rule,
	type RuleMap,
	type Verdict,
	isString,
	ruleVerdict,
} from "./config.ts";
import { type PathArg, analyzeReadonly, cdEffect } from "./readonly.ts";
import { type Token, normalizeSegment, parseShell, tokenize } from "./shell.ts";

export type Section = "commands" | "paths" | "tools";

/** Why a verdict was reached. `note` and `skipped` explain, they match no rule. */
export type Reason =
	| { kind: "rule"; subject: string; section: Section; pattern: string; rule: Rule; action: Verdict }
	| { kind: "default"; subject: string; action: "ask" }
	| { kind: "outside"; subject: string; action: "ask" }
	| { kind: "inside"; subject: string; action: "allow" }
	| { kind: "readonly"; subject: string; action: Verdict }
	| { kind: "note"; subject: string; action: "ask" }
	| { kind: "skipped"; subject: string; why: string };

export function formatReason(r: Reason): string {
	switch (r.kind) {
		case "rule":
			return `${r.subject} → ${r.section} "${r.pattern}": ${r.rule}`;
		case "default":
			return `${r.subject} → no rule: ask`;
		case "outside":
			return `${r.subject} → outside the project, no rule: ask`;
		case "inside":
			return `${r.subject} → read inside the project: allow`;
		case "readonly":
			return `${r.subject} → read-only command: ${r.action}`;
		case "note":
			return `${r.subject} → requires confirmation`;
		case "skipped":
			return `${r.subject} → not read-only: ${r.why}`;
	}
}

/** Reasons the user has to weigh: anything not plainly allowed. Allowed ones are context. */
export function needsDecision(r: Reason): boolean {
	return r.kind === "skipped" || r.action !== "allow";
}

export interface Decision {
	action: Verdict;
	/** The rules that produced the decision. */
	reasons: Reason[];
	/** Resolved target path for file tools, symlinks followed. Rules and grants use this one. */
	absPath?: string;
	/** The path as requested (absolute, symlinks not followed). Differs from `absPath` through a symlink. */
	requestedPath?: string;
	/**
	 * Asks every time: an `ask` rule, a protected file, or a strict rule mentioned
	 * somewhere in a command. No grant covers it.
	 */
	firm?: boolean;
	/** Bash: every directory the command may run in, following its `cd`s. Undefined when unknown. */
	workingDirs?: string[];
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

const RANK: Record<Verdict, number> = { allow: 0, ask: 1, deny: 2, halt: 3 };

/** Tools whose `path` argument is checked against `paths`. */
const FILE_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit", "ls", "find", "grep"]);
const WRITE_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

const CONFIG_NAME = "permissions.json";

/** Max length of a command segment quoted inside a reason (the full command is shown separately). */
const REASON_SNIPPET = 80;

export function strictest(...verdicts: Verdict[]): Verdict {
	return verdicts.reduce<Verdict>((a, b) => (RANK[b] > RANK[a] ? b : a), "allow");
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
 * `*` matches anything (including `/` and spaces), `?` one character, so `**`
 * is the same as `*`. A trailing ` *`, `/*` or `/**` also matches the bare
 * prefix: `git status *` matches `git status`, `~/.ssh/**` matches `~/.ssh`.
 */
export function matches(pattern: string, value: string): boolean {
	if (globToRegex(pattern).test(value)) return true;

	const bare = pattern.replace(/(?: \*|\/\*\*?)$/, "");

	return bare !== pattern && value === bare;
}

export interface RuleHit {
	pattern: string;
	rule: Rule;
}

/** Every rule whose pattern matches `value`. */
export function matchRules(
	rules: RuleMap,
	value: string,
	normalizePattern: (p: string) => string = (p) => p,
): RuleHit[] {
	return Object.entries(rules).flatMap(([pattern, rule]) =>
		matches(normalizePattern(pattern), value) ? [{ pattern, rule }] : [],
	);
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
// Judgements: a verdict and its reasons
// ---------------------------------------------------------------------------

interface Judgement {
	action: Verdict;
	reasons: Reason[];
	/** An `ask` rule matched: the question cannot be skipped by a grant. */
	firm: boolean;
}

function snippet(s: string): string {
	return s.length > REASON_SNIPPET ? `${s.slice(0, REASON_SNIPPET - 1)}…` : s;
}

function note(subject: string): Reason {
	return { kind: "note", subject, action: "ask" };
}

function fromRules(subject: string, section: Section, hits: RuleHit[]): Judgement {
	const reasons: Reason[] = hits.map((h) => ({ kind: "rule", subject, section, ...h, action: ruleVerdict(h.rule) }));

	return {
		action: strictest(...hits.map((h) => ruleVerdict(h.rule))),
		reasons,
		firm: hits.some((h) => h.rule === "ask"),
	};
}

/** Path rules match the real path and the requested one, so a symlink cannot dodge either. */
function pathHits(cfg: PermissionConfig, real: string, requested: string): RuleHit[] {
	const hits = matchRules(cfg.paths, real, expandHome);

	for (const h of matchRules(cfg.paths, requested, expandHome)) {
		if (!hits.some((x) => x.pattern === h.pattern)) hits.push(h);
	}

	return hits;
}

/** A path as shown in reasons: both forms when a symlink makes them differ. */
function pathSubject(real: string, requested: string): string {
	return real === requested ? real : `${real} (symlink from ${requested})`;
}

/**
 * A path read or written. Rules decide when they match; otherwise reading inside
 * the project runs (with `readonly`) and anything else asks.
 */
function judgePath(cfg: PermissionConfig, real: string, requested: string, project: string, read: boolean): Judgement {
	const subject = pathSubject(real, requested);
	const hits = pathHits(cfg, real, requested);

	if (hits.length) return fromRules(subject, "paths", hits);

	if (!isInside(real, project))
		return { action: "ask", reasons: [{ kind: "outside", subject, action: "ask" }], firm: false };

	if (read && cfg.readonly)
		return { action: "allow", reasons: [{ kind: "inside", subject, action: "allow" }], firm: false };

	return { action: "ask", reasons: [{ kind: "default", subject, action: "ask" }], firm: false };
}

// ---------------------------------------------------------------------------
// Bash
// ---------------------------------------------------------------------------

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

/**
 * The paths a read-only segment reads, resolved; why it is not read-only; or
 * undefined when it is not one of the known read-only commands at all.
 */
function readonlyPaths(
	tokens: Token[],
	wd: WorkingDirs,
	opts: DecideOptions,
): ResolvedArg[] | { why: string } | undefined {
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

	// Without operands, `ls`, `grep -r` or `find` read the working directory itself.
	if (!wd.known) return { why: "the working directory is unknown after an earlier command" };
	const resolved: ResolvedArg[] = [];

	for (const arg of paths) {
		for (const r of argPaths(arg, wd, opts.cwd)) if (!resolved.some((x) => x.real === r.real)) resolved.push(r);
	}

	return resolved;
}

/** Characters that end a command or path name in shell text. */
const BOUNDARY = "\\s;&|()<>`'\"";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `phrase` as whole words in `text`, any spacing between them; `/` before it
 * too, so `/usr/bin/sudo` is `sudo`.
 */
function mentions(text: string, phrase: string): boolean {
	const words = phrase.split(/\s+/).map(escape).join("\\s+");

	return new RegExp(`(^|[${BOUNDARY}/$=])${words}(?=$|[${BOUNDARY}])`).test(text);
}

/**
 * The command a `commands` pattern names, when it names one: `git push` for
 * `git push *` or `git push`. Undefined when a wildcard filters the arguments
 * (`cat *secret*`): mentioning `cat` alone says nothing about that rule.
 */
function commandPhrase(pattern: string): string | undefined {
	const phrase = pattern.replace(/ \*$/, "");

	return phrase && !/[*?]/.test(phrase) ? phrase : undefined;
}

/** How a `paths` pattern can be written in a command: `~/.ssh`, `/home/u/.ssh`, `$HOME/.ssh`, `.env`. */
function pathNeedles(pattern: string): string[] {
	const pieces = pattern.split(/[*?]+/).map((p) => p.replace(/^\/|\/$/g, ""));
	const literal = pattern.search(/[*?]/) === 0 ? (pieces.at(-1) ?? "") : (pieces[0] ?? "");

	if (literal.length < 3 || literal === "~") return [];

	if (!literal.startsWith("~/")) return [literal];
	const rest = literal.slice(1);

	return [literal, `${os.homedir()}${rest}`, `$HOME${rest}`, `\${HOME}${rest}`];
}

const isStrict = (rule: Rule) => rule === "ask" || rule === "deny" || rule === "halt";

/**
 * The safety net: a strict rule whose command or path appears anywhere in the
 * text (`$(sudo …)`, `bash -c "sudo …"`, a script) asks, firmly. It does not
 * block: the text may only mention it (`grep sudo log`).
 */
function mentionedRules(cfg: PermissionConfig, command: string, matched: Set<string>): Reason[] {
	const reasons: Reason[] = [];

	for (const [pattern, rule] of Object.entries(cfg.commands)) {
		const phrase = commandPhrase(pattern);

		if (!isStrict(rule) || matched.has(`commands:${pattern}`) || !phrase || !mentions(command, phrase)) continue;
		reasons.push(note(`mentions "${phrase}" (commands "${pattern}": ${rule})`));
	}

	for (const [pattern, rule] of Object.entries(cfg.paths)) {
		if (!isStrict(rule) || matched.has(`paths:${pattern}`)) continue;
		const needle = pathNeedles(pattern).find((n) => mentions(command, n) || command.includes(`${n}/`));

		if (needle) reasons.push(note(`mentions "${needle}" (paths "${pattern}": ${rule})`));
	}

	return reasons;
}

function decideBash(cfg: PermissionConfig, command: string, opts: DecideOptions): Decision {
	const protectedPaths = opts.protectedPaths ?? [];
	const { segments, risky } = parseShell(command);

	if (segments.length === 0) return { action: "ask", reasons: [note("empty command")] };

	let action: Verdict = "allow";
	let firm = false;
	const reasons: Reason[] = [];
	const wd: WorkingDirs = { dirs: [opts.cwd], known: true };
	/** Rules matched by a segment or a path, as `section:pattern`, so the safety net skips them. */
	const matched = new Set<string>();
	/** Every segment passed the read-only analysis, so none of them can write. */
	let onlyReads = true;

	for (const seg of segments) {
		const text = normalizeSegment(seg.text);
		const subject = `"${snippet(text)}"`;
		const tokens = tokenize(seg.text);
		const cmdHits = matchRules(cfg.commands, text);
		const ro = cfg.readonly && tokens ? readonlyPaths(tokens, wd, opts) : undefined;
		const paths = Array.isArray(ro) ? ro.map((r) => judgePath(cfg, r.real, r.requested, opts.cwd, true)) : [];
		const ruledPaths = paths.filter((p) => p.reasons.some((r) => r.kind === "rule"));
		let judged: Judgement;

		for (const h of cmdHits) matched.add(`commands:${h.pattern}`);

		for (const r of ruledPaths.flatMap((p) => p.reasons)) if (r.kind === "rule") matched.add(`paths:${r.pattern}`);

		if (cmdHits.length) {
			// A command rule decides, made stricter by any path rule it reads through.
			const cmd = fromRules(subject, "commands", cmdHits);
			const all = [cmd, ...ruledPaths];
			judged = {
				action: strictest(...all.map((j) => j.action)),
				reasons: all.flatMap((j) => j.reasons),
				firm: all.some((j) => j.firm),
			};
		} else if (Array.isArray(ro)) {
			const verdict = strictest(...paths.map((p) => p.action));
			const shown = paths.flatMap((p) => p.reasons).filter((r) => r.kind !== "inside");
			judged = {
				action: verdict,
				reasons: [{ kind: "readonly", subject, action: verdict }, ...shown],
				firm: paths.some((p) => p.firm),
			};
		} else {
			judged = { action: "ask", reasons: [{ kind: "default", subject, action: "ask" }], firm: false };

			// The same cause (e.g. an unknown working directory) is reported once, not per segment.
			if (ro && !Array.isArray(ro) && !reasons.some((r) => r.kind === "skipped" && r.why === ro.why)) {
				judged.reasons.push({ kind: "skipped", subject, why: ro.why });
			}
		}

		if (!Array.isArray(ro)) onlyReads = false;
		reasons.push(...judged.reasons);
		action = strictest(action, judged.action);
		firm ||= judged.firm;
		followCd(tokens, wd, opts);
	}

	if (risky.length) {
		action = strictest(action, "ask");
		reasons.push(note(`contains ${risky.join(", ")}`));
	}

	const net = mentionedRules(cfg, command, matched);

	if (net.length) {
		action = strictest(action, "ask");
		firm = true;
		reasons.push(...net);
	}

	// Best effort: bash can write anywhere, so mentioning a protected path (absolute, or
	// any `permissions.json`, which covers relative forms) requires confirmation. The
	// protection is against writes: a command made only of read-only segments is exempt.
	const mentionsConfig = protectedPaths.some((p) => p.endsWith(CONFIG_NAME)) && command.includes(CONFIG_NAME);
	const mentionsProtected = mentionsConfig || protectedPaths.some((p) => command.includes(p));

	if (mentionsProtected && !(onlyReads && risky.length === 0)) {
		action = strictest(action, "ask");
		firm = true;
		reasons.push(note("mentions a protected permission file"));
	}

	const decision: Decision = { action, reasons };

	if (wd.known) decision.workingDirs = wd.dirs;

	if (firm) decision.firm = true;

	return decision;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function decide(cfg: PermissionConfig, toolName: string, input: JsonObject, opts: DecideOptions): Decision {
	if (toolName === "bash") return decideBash(cfg, isString(input.command) ? input.command : "", opts);

	const toolHits = matchRules(cfg.tools, toolName);
	const tool = fromRules(toolName, "tools", toolHits);

	if (!FILE_TOOLS.has(toolName)) {
		if (toolHits.length) return withFirm({ action: tool.action, reasons: tool.reasons }, tool.firm);

		return { action: "ask", reasons: [{ kind: "default", subject: toolName, action: "ask" }] };
	}

	const rawPath = isString(input.path) ? input.path : undefined;
	const absPath = resolvePath(rawPath, opts.cwd);
	const requestedPath = path.resolve(opts.cwd, expandHome(rawPath ?? "."));
	const isWrite = WRITE_TOOLS.has(toolName);
	const target = judgePath(cfg, absPath, requestedPath, opts.cwd, !isWrite);
	const ruledPath = target.reasons.some((r) => r.kind === "rule");

	// Rules decide when any matches (tool or path); otherwise the path's default does.
	const ruled: Judgement[] = [];

	if (toolHits.length) ruled.push(tool);

	if (ruledPath) ruled.push(target);
	const parts = ruled.length ? ruled : [target];
	let action = strictest(...parts.map((j) => j.action));
	let firm = parts.some((j) => j.firm);
	const reasons = parts.flatMap((j) => j.reasons);

	const isProtected = isWrite && (opts.protectedPaths ?? []).some((p) => isInside(absPath, p));

	if (isProtected) {
		action = strictest(action, "ask");
		firm = true;
		reasons.push(note("protected permission file"));
	}

	return withFirm({ action, reasons, absPath, requestedPath }, firm);
}

function withFirm(d: Decision, firm: boolean): Decision {
	if (firm) d.firm = true;

	return d;
}
