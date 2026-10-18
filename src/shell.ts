/**
 * Quote-aware shell command analysis.
 *
 * One pass produces both the segments that rules are evaluated against and the
 * structure shown to the user, so what is displayed is always what was evaluated.
 * This is a conservative scanner, not a shell parser: when in doubt it flags the
 * command as risky so it requires confirmation.
 */

/** Operator that precedes a segment. `"\n"` is a plain newline separator. */
export type Operator = "&&" | "||" | "|" | ";" | "&" | "\n";

export interface Segment {
	/** Segment text, trimmed, original spacing preserved. */
	text: string;
	/** Operator before this segment (undefined for the first one). */
	op?: Operator;
}

export interface ShellAnalysis {
	segments: Segment[];
	/** Constructs that can hide commands or write files. Forces at least "ask". */
	risky: string[];
}

/** Matches `>&N`, `>&-` (fd duplication / closing), which write no file. */
const FD_DUP = /^&(\d+|-)(?![\w./~])/;

/** Matches `/dev/null` as a complete word. */
const DEV_NULL = /^\/dev\/null(?=$|[\s;&|)])/;

/**
 * Inspects the target of a `>` at index `i`. Harmless targets are fd duplication
 * (`2>&1`, `>&-`) and `/dev/null`; anything else writes a file.
 */
function isFileRedirect(command: string, i: number): boolean {
	let rest = command.slice(i + 1);

	if (rest.startsWith(">") || rest.startsWith("|")) rest = rest.slice(1); // >> and >|

	if (rest.startsWith("&")) return !FD_DUP.test(rest); // `>&file` redirects to a file

	return !DEV_NULL.test(rest.trimStart());
}

export function parseShell(command: string): ShellAnalysis {
	const segments: Segment[] = [];
	const risky = new Set<string>();
	let cur = "";
	let op: Operator | undefined;
	let quote: "'" | '"' | null = null;

	const push = (nextOp: Operator) => {
		const text = cur.trim();

		if (text) segments.push(op ? { text, op } : { text });
		cur = "";
		op = nextOp;
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const next = command[i + 1];
		const prev = command[i - 1];

		if (quote === "'") {
			cur += ch;

			if (ch === "'") quote = null;
			continue;
		}

		if (ch === "\\" && next !== undefined) {
			// Line continuation joins lines; any other escape is kept literally.
			cur += next === "\n" ? " " : ch + next;
			i++;
			continue;
		}

		if (quote === '"') {
			if (ch === '"') quote = null;
			else if (ch === "`" || (ch === "$" && next === "(")) risky.add("command substitution");
			cur += ch;
			continue;
		}

		// Unquoted
		if (ch === "'" || ch === '"') {
			quote = ch;
			cur += ch;
			continue;
		}

		if (ch === "`" || (ch === "$" && next === "(")) risky.add("command substitution");

		if ((ch === "<" || ch === ">") && next === "(") risky.add("process substitution");

		if (ch === ">" && next !== "(" && isFileRedirect(command, i)) risky.add("redirection to file");

		if (ch === "&" && next === "&") {
			push("&&");
			i++;
		} else if (ch === "|" && next === "|") {
			push("||");
			i++;
		} else if (ch === "|") {
			push("|");

			if (next === "&") i++; // |& pipes stderr too
		} else if (ch === ";") {
			push(";");
		} else if (ch === "\n") {
			push("\n");
		} else if (ch === "&" && prev !== ">" && prev !== "<" && next !== ">") {
			push("&"); // background operator
		} else {
			cur += ch;
		}
	}

	if (quote) risky.add("unclosed quote");
	push("\n");

	return { segments, risky: [...risky] };
}

/** Collapses whitespace for rule matching. */
export function normalizeSegment(text: string): string {
	return text.replace(/\s+/g, " ");
}

/** Display lines: the first segment as-is, each following one led by its operator. */
export function displayLines(analysis: ShellAnalysis): string[] {
	return analysis.segments.map((s) => (s.op && s.op !== "\n" ? `${s.op} ${s.text}` : s.text));
}
