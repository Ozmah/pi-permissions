/**
 * Builds the prompt body for a tool call. The body is unbounded; the prompt scrolls it.
 */
import { type Json, type JsonObject, isJsonObject, isNumber, isString } from "./config.ts";
import { formatReason, needsDecision, type Reason } from "./policy.ts";
import { ACTION_COLOR, type BodyLine, RULE_COLOR, type Span } from "./prompt-ui.ts";
import { inlineScript } from "./scripts.ts";
import { displayLines, parseShell } from "./shell.ts";
import { DESCRIPTION_ARG } from "./describe.ts";
import { onlySgr, sanitize } from "./text.ts";

/** Returns one ANSI-colored string per input line, or undefined to fall back to plain text. */
export type Highlighter = (code: string, lang: string) => string[] | undefined;

export interface BodyDeps {
	highlight?: Highlighter;
	/** Language id for a file path, e.g. "typescript" for `a.ts`. */
	languageOf?: (filePath: string) => string | undefined;
}

/** Larger contents are shown as plain text. */
const HIGHLIGHT_MAX_LINES = 5000;

const BLANK: BodyLine = { text: "" };

function heading(text: string): BodyLine {
	return { text, color: "accent", heading: true };
}

/**
 * Highlights untrusted code. Sanitizes first, so the only escape sequences in
 * the result are the highlighter's own color codes.
 */
function highlightLines(raw: string, lang: string | undefined, deps: BodyDeps): string[] | undefined {
	if (!lang || !deps.highlight) return undefined;
	const clean = sanitize(raw);
	const count = clean.split("\n").length;

	if (count > HIGHLIGHT_MAX_LINES) return undefined;
	let out: string[] | undefined;

	try {
		out = deps.highlight(clean, lang);
	} catch {
		return undefined;
	}

	// Only use output that maps 1:1 to input lines.
	return out?.length === count ? out.map(onlySgr) : undefined;
}

/** Lines under a command, behind a `│` margin, highlighted when the language is known. */
function blockLines(code: string, lang: string | undefined, deps: BodyDeps): BodyLine[] {
	const highlighted = highlightLines(code, lang, deps);
	const rows = highlighted ?? code.split("\n");

	return rows.map((text) => ({
		text,
		styled: highlighted !== undefined,
		prefix: "  │ ",
		prefixColor: "dim",
		contPrefix: "  │   ",
	}));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function bashBody(input: JsonObject, deps: BodyDeps): BodyLine[] {
	const lines: BodyLine[] = [];
	const said = input[DESCRIPTION_ARG];

	// The agent's own words (ui.describe_commands): a claim, shown above what actually runs.
	if (isString(said) && said.trim())
		lines.push({ text: said.trim(), prefix: "Agent says: ", prefixColor: "dim" }, BLANK);

	lines.push(heading("Command"));
	let first = true;
	const analysis = parseShell(isString(input.command) ? input.command : "");
	const texts = displayLines(analysis);

	analysis.segments.forEach((segment, i) => {
		const text = texts[i];
		const highlighted = highlightLines(text, "bash", deps);

		for (const piece of highlighted ?? [text]) {
			lines.push({
				text: piece,
				styled: highlighted !== undefined,
				prefix: first ? "$ " : "  ",
				prefixColor: "dim",
				contPrefix: "    ",
			});
			first = false;
		}

		// An inline script is labeled and highlighted in its language, so the decision can be read.
		const script = inlineScript(segment);
		const label = (code: string) => `${script?.name} script, ${plural(code.split("\n").length, "line")}`;

		if (script?.from === "argument") {
			lines.push({ text: label(script.code), color: "accent", prefix: "  ┌ ", prefixColor: "dim" });
			lines.push(...blockLines(script.code, script.language, deps), { text: "", prefix: "  └", prefixColor: "dim" });
		}

		// Here-document bodies: data for the command, shown as a block under it.
		segment.heredocs?.forEach((h, n) => {
			const isScript = script?.from === "heredoc" && n === 0;

			if (isScript) lines.push({ text: label(h.body), color: "accent", prefix: "  ┌ ", prefixColor: "dim" });
			lines.push(...blockLines(h.body, isScript ? script.language : undefined, deps));
			lines.push({ text: h.delimiter, color: "dim", prefix: "  " });
		});
	});

	if (isNumber(input.timeout)) lines.push({ text: `timeout: ${input.timeout}s`, color: "dim" });

	return lines;
}

function writeBody(content: string, lang: string | undefined, deps: BodyDeps): BodyLine[] {
	const highlighted = highlightLines(content, lang, deps);
	const lines = highlighted ?? content.split("\n");
	const width = String(lines.length).length;

	return [
		BLANK,
		heading(`Content (${lines.length} lines)`),
		...lines.map((text, i): BodyLine => ({
			text,
			styled: highlighted !== undefined,
			prefix: `${String(i + 1).padStart(width)} │ `,
			prefixColor: "dim",
		})),
	];
}

function diffLines(raw: string, sign: "-" | "+", lang: string | undefined, deps: BodyDeps): BodyLine[] {
	const color = sign === "-" ? "toolDiffRemoved" : "toolDiffAdded";
	const prefix = `${sign} `;
	const highlighted = highlightLines(raw, lang, deps);

	if (highlighted) {
		return highlighted.map((text) => ({ text, styled: true, prefix, contPrefix: prefix, prefixColor: color }));
	}

	return raw.split("\n").map((text) => ({ text, prefix, contPrefix: prefix, color }));
}

/** Text of one side of an edit; anything that is not a string shows as empty. */
function side(edit: Json, key: "oldText" | "newText"): string {
	const value = isJsonObject(edit) ? edit[key] : undefined;

	return isString(value) ? value : "";
}

function editBody(edits: Json[], lang: string | undefined, deps: BodyDeps): BodyLine[] {
	const lines: BodyLine[] = [];

	edits.forEach((edit, i) => {
		lines.push(BLANK, heading(`Edit ${i + 1}/${edits.length}`));
		// Each side is highlighted as a whole so multi-line strings and comments color correctly.
		lines.push(...diffLines(side(edit, "oldText"), "-", lang, deps));
		lines.push(...diffLines(side(edit, "newText"), "+", lang, deps));
	});

	return lines;
}

/** Colored runs for a reason. Joined, their text equals `formatReason(r)`. */
export function reasonSpans(r: Reason): Span[] {
	const muted = (text: string): Span => ({ text, color: "muted" });

	const head: Span[] = [
		{ text: r.subject, color: r.kind === "note" ? "warning" : "text" },
		{ text: " → ", color: "dim" },
	];

	if (r.kind === "skipped") return [...head, muted(`not read-only: ${r.why}`)];

	if (r.kind === "uncovered") return [...head, muted(`does not cover this call: ${r.why}`)];
	const action: Span = { text: r.action, color: ACTION_COLOR[r.action] };

	switch (r.kind) {
		case "readonly":
			return [...head, muted(`read-only command${r.why ? `, ${r.why}` : ""}: `), action];
		case "rule":
			return [
				...head,
				muted(`${r.section} `),
				{ text: `"${r.pattern}"`, color: "accent" },
				muted(": "),
				{ text: r.rule, color: RULE_COLOR[r.rule] },
			];
		case "default":
			return [...head, muted("no rule: "), action];
		case "outside":
			return [...head, muted("outside the project, no rule: "), action];
		case "inside":
			return [...head, muted("read inside the project: "), action];
		case "note":
			return [...head, { text: "requires confirmation", color: ACTION_COLOR.ask }];
	}
}

/** `Path: /real`, or `Path: /requested → /real (symlink)` when they differ. */
function pathLine(absPath: string, requestedPath: string | undefined): BodyLine {
	const line: BodyLine = { text: absPath, prefix: "Path: ", prefixColor: "dim" };

	if (!requestedPath || requestedPath === absPath) return line;

	const spans: Span[] = [
		{ text: requestedPath, color: "text" },
		{ text: " \u2192 ", color: "dim" },
		{ text: absPath, color: "accent" },
		{ text: " (symlink)", color: "dim" },
	];

	return { ...line, text: spans.map((s) => s.text).join(""), spans };
}

export function buildBody(
	toolName: string,
	input: JsonObject,
	absPath: string | undefined,
	reasons: Reason[],
	deps: BodyDeps = {},
	/** The path as requested; shown next to `absPath` when a symlink makes them differ. */
	requestedPath?: string,
): BodyLine[] {
	const body: BodyLine[] = [];

	if (toolName === "bash") {
		body.push(...bashBody(input, deps));
	} else if (absPath) {
		const lang = deps.languageOf?.(absPath);
		body.push(pathLine(absPath, requestedPath));

		if (toolName === "write" && isString(input.content)) {
			body.push(...writeBody(input.content, lang, deps));
		} else if (toolName === "edit" && Array.isArray(input.edits)) {
			body.push(...editBody(input.edits, lang, deps));
		} else {
			const { path: _path, ...rest } = input;

			if (Object.keys(rest).length) body.push({ text: JSON.stringify(rest), color: "muted" });
		}
	} else {
		body.push(heading("Input"), { text: JSON.stringify(input, null, 2), color: "muted" });
	}

	body.push(BLANK, heading("Why"));

	// What needs a decision first; what is already allowed folded into one line.
	for (const r of reasons.filter(needsDecision)) {
		body.push({ text: formatReason(r), spans: reasonSpans(r), prefix: "• ", prefixColor: "dim" });
	}

	const allowed = reasons.filter((r) => !needsDecision(r));

	if (allowed.length) {
		const text = `${allowed.length} allowed: ${allowed.map((r) => r.subject).join(", ")}`;
		body.push({ text, color: "dim", prefix: "✓ ", prefixColor: "success" });
	}

	return body;
}

// oxlint-disable-next-line no-control-regex -- matches ANSI color codes to strip them for plain-text clients.
const SGR = /\x1b\[[0-9;]*m/g;

/** Plain-text rendering for clients without the TUI (e.g. RPC), capped at `maxLines`. */
export function plainBody(body: BodyLine[], maxLines: number): string {
	const lines = body.flatMap((l) => `${l.prefix ?? ""}${l.styled ? l.text.replace(SGR, "") : l.text}`.split("\n"));

	if (lines.length <= maxLines) return lines.join("\n");

	return [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`].join("\n");
}
