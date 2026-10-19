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

/** A here-document: the lines after the command, up to `delimiter`, fed to its stdin. */
export interface Heredoc {
	delimiter: string;
	body: string;
}

export interface Segment {
	/** Segment text, trimmed, original spacing preserved. Here-document bodies are not part of it. */
	text: string;
	/** Operator before this segment (undefined for the first one). */
	op?: Operator;
	/** Here-documents opened by this segment, in order. */
	heredocs?: Heredoc[];
}

/** A `<<` seen on the current line, waiting for its body after the newline. */
interface PendingHeredoc {
	delimiter: string;
	/** Any part of the delimiter was quoted: the body is literal, no expansion. */
	quoted: boolean;
	/** `<<-`: leading tabs are stripped, also from the delimiter line. */
	stripTabs: boolean;
	/** Index of the segment it belongs to. */
	owner: number;
}

/** Reads the delimiter after `<<` at `start`. Undefined when there is none. */
function readDelimiter(command: string, start: number): Omit<PendingHeredoc, "owner"> | undefined {
	let i = start;
	const stripTabs = command[i] === "-";

	if (stripTabs) i++;

	while (command[i] === " " || command[i] === "\t") i++;
	let delimiter = "";
	let quoted = false;

	for (; i < command.length && !/[\s;|&<>()]/.test(command[i]); i++) {
		const ch = command[i];

		if (ch === "'" || ch === '"') {
			const close = command.indexOf(ch, i + 1);

			if (close < 0) return undefined;
			delimiter += command.slice(i + 1, close);
			quoted = true;
			i = close;
		} else if (ch === "\\" && i + 1 < command.length) {
			delimiter += command[i + 1];
			quoted = true;
			i++;
		} else delimiter += ch;
	}

	return delimiter ? { delimiter, quoted, stripTabs } : undefined;
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
	let pending: PendingHeredoc[] = [];

	const push = (nextOp: Operator) => {
		const text = cur.trim();

		if (text) segments.push(op ? { text, op } : { text });
		cur = "";
		op = nextOp;
	};

	/**
	 * Consumes the bodies of the pending here-documents, starting at `pos` (the
	 * line after the command). Returns the index of the first character after them.
	 */
	const readBodies = (pos: number): number => {
		for (const h of pending) {
			const lines: string[] = [];
			let closed = false;

			while (pos < command.length) {
				const nl = command.indexOf("\n", pos);
				const line = command.slice(pos, nl < 0 ? command.length : nl);
				pos = nl < 0 ? command.length : nl + 1;

				if ((h.stripTabs ? line.replace(/^\t+/, "") : line) === h.delimiter) {
					closed = true;
					break;
				}

				lines.push(line);
			}

			// Without its delimiter, bash takes everything left as the body: nothing after it can be trusted.
			if (!closed) risky.add("unclosed here-document");
			const body = lines.join("\n");

			// An unquoted delimiter means the body is expanded: substitutions in it run.
			if (!h.quoted && /`|\$\(/.test(body)) risky.add("command substitution");
			const owner = segments[h.owner];

			if (owner) (owner.heredocs ??= []).push({ delimiter: h.delimiter, body });
		}

		pending = [];

		return pos;
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

		if (ch === "<" && next === "<" && command[i + 2] !== "<" && prev !== "<") {
			const h = readDelimiter(command, i + 2);

			if (h) pending.push({ ...h, owner: segments.length });
			else risky.add("unsupported here-document");
		}

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

			if (pending.length) i = readBodies(i + 1) - 1;
		} else if (ch === "&" && prev !== ">" && prev !== "<" && next !== ">") {
			push("&"); // background operator
		} else {
			cur += ch;
		}
	}

	if (quote) risky.add("unclosed quote");
	push("\n");

	if (pending.length) readBodies(command.length);

	return { segments, risky: [...risky] };
}

/** A shell word after quote removal. */
export interface Word {
	kind: "word";
	value: string;
	/** Contains `$` or a backquote: its value is only known at run time. */
	dynamic: boolean;
	/** Contains an unquoted `*`, `?` or `[`: the shell expands it to matching paths. */
	glob: boolean;
	/** Starts with an unquoted `~` or `~/`, which the shell expands to the home directory. */
	tilde: boolean;
	/** Some part of it was quoted or escaped. */
	quoted: boolean;
}

/** A redirection operator, with its fd prefix: `<`, `2>`, `>>`, `&>`, `<<`, `>&`. Its target is the next word. */
export interface Redirect {
	kind: "redirect";
	op: string;
}

export type Token = Word | Redirect;

const REDIRECT_OPS = ["<<<", "<<-", "<<", "<&", "<>", "<", ">>", ">|", ">&", ">"];

/**
 * Splits one segment (from `parseShell`) into words and redirections. Returns
 * undefined for syntax it does not model (subshells, groups, brace expansion,
 * comments, unclosed quotes): callers must then treat the segment as unknown.
 */
export function tokenize(text: string): Token[] | undefined {
	const tokens: Token[] = [];
	let word: Word | undefined;

	const current = (): Word => {
		word ??= { kind: "word", value: "", dynamic: false, glob: false, tilde: false, quoted: false };

		return word;
	};

	const end = () => {
		if (!word) return;

		// `~user`, `~+`, `~-` expand to directories that cannot be known here.
		if (word.tilde && word.value !== "~" && !word.value.startsWith("~/")) word.dynamic = true;
		tokens.push(word);
		word = undefined;
	};

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];

		if (ch === "'") {
			const close = text.indexOf("'", i + 1);

			if (close < 0) return undefined;
			const w = current();
			w.value += text.slice(i + 1, close);
			w.quoted = true;
			i = close;
			continue;
		}

		if (ch === '"') {
			const w = current();
			w.quoted = true;
			let j = i + 1;

			for (; j < text.length && text[j] !== '"'; j++) {
				const c = text[j];

				if (c === "\\" && '$`"\\'.includes(text[j + 1] ?? "")) {
					w.value += text[j + 1];
					j++;
					continue;
				}

				if (c === "$" || c === "`") w.dynamic = true;
				w.value += c;
			}

			if (j >= text.length) return undefined;
			i = j;
			continue;
		}

		if (ch === "\\") {
			if (i + 1 >= text.length) return undefined;
			const w = current();
			w.value += text[i + 1];
			w.quoted = true;
			i++;
			continue;
		}

		if (/\s/.test(ch)) {
			end();
			continue;
		}

		if (ch === "<" || ch === ">" || (ch === "&" && text[i + 1] === ">")) {
			// An unquoted all-digit word right before the operator is its fd (`2>`).
			let op = "";

			if (word && !word.quoted && /^\d+$/.test(word.value)) {
				op = word.value;
				word = undefined;
			} else end();

			if (ch === "&") {
				op += "&";
				i++;
			}

			const rest = text.slice(i);
			const found = REDIRECT_OPS.find((o) => rest.startsWith(o)) ?? text[i];
			tokens.push({ kind: "redirect", op: op + found });
			i += found.length - 1;
			continue;
		}

		// Subshells, groups, brace expansion, comments, stray operators.
		if ("(){}|;&".includes(ch) || (ch === "#" && !word)) return undefined;
		const w = current();

		if (ch === "$" || ch === "`") w.dynamic = true;

		if (ch === "*" || ch === "?" || ch === "[") w.glob = true;

		if (ch === "~" && w.value === "" && !w.quoted) w.tilde = true;
		w.value += ch;
	}

	end();

	return tokens;
}

/** Collapses whitespace for rule matching. */
export function normalizeSegment(text: string): string {
	return text.replace(/\s+/g, " ");
}

/** Display lines: the first segment as-is, each following one led by its operator. */
export function displayLines(analysis: ShellAnalysis): string[] {
	return analysis.segments.map((s) => (s.op && s.op !== "\n" ? `${s.op} ${s.text}` : s.text));
}
