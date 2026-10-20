/**
 * Read-only bash commands: which segments only read files, and which paths they read.
 *
 * Conservative by design. Every operand is treated as a path, even when it is a
 * pattern or a number: a wrong guess can only add a confirmation, never skip one.
 * Anything not modeled (variables, unknown flags that write, here-documents)
 * disqualifies the segment, which then goes through the normal bash rules.
 */
import type { Token, Word } from "./shell.ts";

interface CommandSpec {
	/** Flags that disqualify: exact word, or `--flag=value`. */
	deny?: readonly string[];
	/** Short flag letters that disqualify anywhere in a cluster (`-ro` contains `o`). */
	denyShort?: string;
	/** Short flags are single-dash words, not clusters (`find -name`). */
	noClusters?: boolean;
	/** More operands than this disqualify (`uniq in out` writes `out`). */
	maxOperands?: number;
	/** Operands are text, not files (`echo`). */
	noPaths?: boolean;
}

const GREP: CommandSpec = { deny: ["--dereference-recursive"], denyShort: "R" };

/** The commands treated as read-only, with what disqualifies them. */
const COMMANDS: ReadonlyMap<string, CommandSpec> = new Map<string, CommandSpec>([
	["cat", {}],
	["head", {}],
	["tail", { deny: ["--follow", "--retry"], denyShort: "fF" }], // -f never ends
	["wc", { deny: ["--files0-from"] }], // reads file names from a file
	["ls", {}],
	["cut", {}],
	["pwd", { noPaths: true }],
	["echo", { noPaths: true }],
	["grep", GREP],
	["egrep", GREP],
	["fgrep", GREP],
	// --pre runs a program on every file; -L/--follow leaves the checked directories through symlinks.
	["rg", { deny: ["--pre", "--pre-glob", "--follow"], denyShort: "L" }],
	[
		"find",
		{
			// -follow/-L/-H leave the checked directories through symlinks.
			deny: [
				"-exec",
				"-execdir",
				"-ok",
				"-okdir",
				"-delete",
				"-fprint",
				"-fprint0",
				"-fprintf",
				"-fls",
				"-files0-from",
				"-follow",
				"-L",
				"-H",
			],
			noClusters: true,
		},
	],
	["sort", { deny: ["--output", "--compress-program", "--files0-from"], denyShort: "o" }],
	["uniq", { maxOperands: 1 }],
]);

/** Commands that can change the working directory or the environment `cd` depends on. */
const CWD_CHANGERS: ReadonlySet<string> = new Set([
	"pushd",
	"popd",
	"builtin",
	"command",
	"eval",
	"source",
	".",
	"exec",
	"export",
	"set",
	"shopt",
	"unset",
	"declare",
	"typeset",
	"local",
	"alias",
	"enable",
	"hash",
]);

/** A path a command reads, as written. */
export interface PathArg {
	value: string;
	/** Unquoted leading `~`: expands to the home directory. */
	tilde: boolean;
}

export type ReadonlyResult = { ok: true; paths: PathArg[] } | { ok: false; why: string };

/** What a `cd` segment does to the working directory. */
export type CdEffect = { kind: "none" } | { kind: "dir"; target: PathArg } | { kind: "unknown" };

const isWord = (t: Token | undefined): t is Word => t?.kind === "word";

/** A path to check, or why the word disqualifies the segment. */
type PathCheck = { path: PathArg } | { why: string };

/**
 * The path a word stands for. A glob stands for its fixed directory prefix, since
 * its matches stay inside it; `..` after a glob could leave it, so it disqualifies.
 */
function pathOf(w: Word): PathCheck {
	if (w.dynamic) return { why: `"${w.value}" depends on a variable or substitution` };

	if (!w.glob) return { path: { value: w.value, tilde: w.tilde } };
	const first = w.value.search(/[*?[]/);

	if (/(^|\/)\.\.(\/|$)/.test(w.value.slice(first))) return { why: `"${w.value}" uses .. after a wildcard` };

	// A component that starts with a literal `.` and holds a wildcard (`.*`, `.?`, `.[.]`) can match `..`
	// itself: bash before 5.2, or with globskipdots off. Only such a component can, since a leading dot
	// is never matched by `*`, `?` or a bracket expression.
	if (w.value.split("/").some((c) => c.startsWith(".") && /[*?[]/.test(c))) {
		return { why: `"${w.value}" has a wildcard that can match ..` };
	}

	const slash = w.value.lastIndexOf("/", first);

	return { path: { value: slash < 0 ? "." : w.value.slice(0, slash) || "/", tilde: w.tilde } };
}

/**
 * Checks a redirection. Input from a file is a path to read; output only to
 * /dev/null or another fd. Here-documents and read-write opens are not modeled.
 */
function redirectCheck(op: string, target: Word | undefined): PathCheck | { harmless: true } {
	if (!target) return { why: "a redirection has no target" };

	// Here-documents and here-strings are stdin data; substitutions in them are flagged by parseShell.
	if (op.endsWith("<<") || op.endsWith("<<-") || op.endsWith("<<<")) return { harmless: true };

	if (op.endsWith("<>")) return { why: `unsupported redirection ${op}` };
	const fdDup = op.endsWith("&") && !op.startsWith("&");
	const writes = { why: "writes a file" };

	if (fdDup) return /^(\d+|-)$/.test(target.value) && !target.quoted ? { harmless: true } : writes;

	if (op.includes(">")) return target.value === "/dev/null" && !target.dynamic ? { harmless: true } : writes;

	return pathOf(target);
}

/**
 * GNU getopt_long accepts any unambiguous prefix of a long option, so `--o` is
 * `--output`. A long flag whose name starts a denied `--` entry is denied too.
 * Single-dash entries stay exact: `find` primaries are never abbreviated.
 */
function abbreviates(flag: string, denied: string): boolean {
	const [name] = flag.split("=");

	return denied.startsWith("--") && name.startsWith("--") && name.length > 2 && denied.startsWith(name);
}

function deniedFlag(spec: CommandSpec, flag: string): string | undefined {
	const hit = spec.deny?.find((d) => flag === d || flag.startsWith(`${d}=`) || abbreviates(flag, d));

	if (hit) return hit;

	if (spec.noClusters || flag.startsWith("--") || !spec.denyShort) return undefined;
	const letter = [...spec.denyShort].find((c) => flag.slice(1).includes(c));

	return letter && `-${letter}`;
}

/**
 * Whether a tokenized segment is a read-only command, and the paths it reads.
 * Undefined when it is not one of the known commands at all.
 */
export function analyzeReadonly(tokens: Token[]): ReadonlyResult | undefined {
	const [head, ...rest] = tokens;

	if (!isWord(head) || head.dynamic || head.glob) return undefined;

	if (head.value === "sed") return analyzeSed(rest);
	const spec = COMMANDS.get(head.value);

	if (!spec) return undefined;
	const operands: PathArg[] = [];
	const inputs: PathArg[] = [];
	let afterDashes = false;

	for (let i = 0; i < rest.length; i++) {
		const t = rest[i];

		if (t.kind === "redirect") {
			const target = rest[i + 1];
			const r = redirectCheck(t.op, isWord(target) ? target : undefined);
			i++;

			if ("why" in r) return { ok: false, why: r.why };

			if ("path" in r) inputs.push(r.path);
			continue;
		}

		if (!afterDashes && t.value === "--" && !t.quoted) {
			afterDashes = true;
			continue;
		}

		if (afterDashes || !t.value.startsWith("-") || t.value === "-") {
			if (t.value === "-") continue; // stdin
			const p = pathOf(t);

			if ("why" in p) return { ok: false, why: p.why };
			operands.push(p.path);
			continue;
		}

		if (t.dynamic) return { ok: false, why: `"${t.value}" depends on a variable or substitution` };
		const denied = deniedFlag(spec, t.value);

		if (denied) return { ok: false, why: `${denied} is not read-only` };
		const eq = t.value.indexOf("=");

		if (eq > 0) {
			// `--file=VALUE`: VALUE may be a path. Bash may expand a `~` after `=`, so check both readings.
			const value = t.value.slice(eq + 1);
			const p = pathOf({ ...t, value, tilde: false });

			if ("why" in p) return { ok: false, why: p.why };
			operands.push(p.path);

			if (value === "~" || value.startsWith("~/")) operands.push({ value, tilde: true });
		} else if (!t.value.startsWith("--") && /[/~]/.test(t.value)) {
			return { ok: false, why: `"${t.value}" has a path attached to a short flag` };
		}
	}

	if (spec.maxOperands !== undefined && operands.length > spec.maxOperands) {
		return { ok: false, why: `more than ${spec.maxOperands} operand(s) means it writes a file` };
	}

	return { ok: true, paths: spec.noPaths ? inputs : [...operands, ...inputs] };
}

/** A sed script that only prints a line range: `5p`, `1,60p`, `$p`, `10,$p`. */
const SED_PRINT_RANGE = /^(\d+|\$)(,(\d+|\$))?p$/;

/** sed options that change neither what is read nor what is written. `-n` is required separately. */
const SED_HARMLESS = new Set(["-E", "-r", "-s", "-z", "-u", "--regexp-extended", "--separate", "--null-data"]);

const SED_QUIET = new Set(["-n", "--quiet", "--silent"]);

/**
 * `sed -n` printing line ranges, and nothing else. The script must be exactly a
 * range and `p`: `w` writes, `e` runs commands, `r` reads other files, and `-i`
 * rewrites the file, so anything else asks. No sed language is parsed: the
 * script either matches the fixed shape or the command is not read-only.
 */
function analyzeSed(rest: Token[]): ReadonlyResult {
	const operands: PathArg[] = [];
	const inputs: PathArg[] = [];
	let quiet = false;
	let script: Word | undefined;
	let afterDashes = false;
	const notReadonly = (why: string): ReadonlyResult => ({ ok: false, why });
	// With any -e, every operand is a file, even one written before it.
	const hasExpression = rest.some((t) => isWord(t) && (t.value === "-e" || t.value.startsWith("--expression=")));

	for (let i = 0; i < rest.length; i++) {
		const t = rest[i];

		if (t.kind === "redirect") {
			const target = rest[i + 1];
			const r = redirectCheck(t.op, isWord(target) ? target : undefined);
			i++;

			if ("why" in r) return notReadonly(r.why);

			if ("path" in r) inputs.push(r.path);
			continue;
		}

		if (t.dynamic) return notReadonly(`"${t.value}" depends on a variable or substitution`);

		if (!afterDashes && t.value === "--") {
			afterDashes = true;
			continue;
		}

		if (!afterDashes && t.value.startsWith("-") && t.value !== "-") {
			if (SED_QUIET.has(t.value)) quiet = true;
			else if (t.value === "-e" || t.value.startsWith("--expression=")) {
				const value = t.value === "-e" ? rest[++i] : { ...t, value: t.value.slice("--expression=".length) };

				if (!isWord(value) || value.dynamic || !SED_PRINT_RANGE.test(value.value)) {
					return notReadonly("the sed script does more than print a line range");
				}

				script = value;
			} else if (!SED_HARMLESS.has(t.value)) return notReadonly(`sed ${t.value} is not read-only`);
			continue;
		}

		if (t.value === "-") continue; // stdin

		// The first operand is the script, unless -e gives one.
		if (!hasExpression && !script) {
			if (!SED_PRINT_RANGE.test(t.value)) return notReadonly("the sed script does more than print a line range");
			script = t;
			continue;
		}

		const p = pathOf(t);

		if ("why" in p) return notReadonly(p.why);
		operands.push(p.path);
	}

	if (!quiet) return notReadonly("sed without -n");

	if (!script) return notReadonly("sed without a script");

	return { ok: true, paths: [...operands, ...inputs] };
}

/**
 * What a segment does to the working directory. `cdpath` is $CDPATH: when set,
 * `cd name` can go to a directory under it, so bare names become unknown.
 */
export function cdEffect(tokens: Token[] | undefined, cdpath: string | undefined): CdEffect {
	if (!tokens) return { kind: "unknown" }; // unmodeled syntax may hide a cd
	const [head, ...rest] = tokens;

	if (!isWord(head)) return { kind: "none" };

	if (head.value.includes("=") || CWD_CHANGERS.has(head.value)) return { kind: "unknown" };

	if (head.value !== "cd") return { kind: "none" };
	const operands: Word[] = [];

	for (const t of rest) {
		if (!isWord(t)) return { kind: "unknown" };

		if (operands.length === 0 && ["-L", "-P", "-e", "-@"].includes(t.value)) continue;
		operands.push(t);
	}

	if (operands.length === 0) return { kind: "dir", target: { value: "~", tilde: true } };
	const [dir] = operands;

	if (operands.length > 1 || dir.value === "-" || dir.dynamic || dir.glob) return { kind: "unknown" };

	if (cdpath && !/^[/.~]/.test(dir.value)) return { kind: "unknown" };

	return { kind: "dir", target: { value: dir.value, tilde: dir.tilde } };
}
