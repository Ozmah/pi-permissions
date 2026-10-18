/**
 * Builds the prompt body for a tool call. The body is unbounded; the prompt scrolls it.
 */
import { formatReason, type Reason } from "./policy.ts";
import { ACTION_COLOR, type BodyLine, type Span } from "./prompt-ui.ts";
import { displayLines, parseShell } from "./shell.ts";
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

function bashBody(input: Record<string, unknown>, deps: BodyDeps): BodyLine[] {
	const lines: BodyLine[] = [heading("Command")];
	let first = true;

	for (const text of displayLines(parseShell(String(input.command ?? "")))) {
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
	}

	if (typeof input.timeout === "number") lines.push({ text: `timeout: ${input.timeout}s`, color: "dim" });

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

function editBody(edits: unknown[], lang: string | undefined, deps: BodyDeps): BodyLine[] {
	const lines: BodyLine[] = [];
	edits.forEach((edit, i) => {
		const e = (typeof edit === "object" && edit !== null ? edit : {}) as { oldText?: unknown; newText?: unknown };
		lines.push(BLANK, heading(`Edit ${i + 1}/${edits.length}`));
		// Each side is highlighted as a whole so multi-line strings and comments color correctly.
		lines.push(...diffLines(String(e.oldText ?? ""), "-", lang, deps));
		lines.push(...diffLines(String(e.newText ?? ""), "+", lang, deps));
	});

	return lines;
}

/** Colored runs for a reason. Joined, their text equals `formatReason(r)`. */
export function reasonSpans(r: Reason): Span[] {
	const action: Span = { text: r.action, color: ACTION_COLOR[r.action] };
	const muted = (text: string): Span => ({ text, color: "muted" });

	const head: Span[] = [
		{ text: r.subject, color: r.kind === "note" ? "warning" : "text" },
		{ text: " → ", color: "dim" },
	];

	switch (r.kind) {
		case "match":
			return [
				...head,
				muted(`matched ${r.section} `),
				{ text: `"${r.pattern}"`, color: "accent" },
				muted(": "),
				action,
			];
		case "fallback":
			return [
				...head,
				muted(`no matching ${r.section} rule (fallback `),
				{ text: '"*"', color: "accent" },
				muted(": "),
				action,
				muted(")"),
			];
		case "default":
			return [...head, muted(`no matching ${r.section} rule (default: `), action, muted(")")];
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
	input: Record<string, unknown>,
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

		if (toolName === "write" && typeof input.content === "string") {
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

	for (const r of reasons)
		body.push({ text: formatReason(r), spans: reasonSpans(r), prefix: "• ", prefixColor: "dim" });

	return body;
}

const SGR = /\x1b\[[0-9;]*m/g;

/** Plain-text rendering for clients without the TUI (e.g. RPC), capped at `maxLines`. */
export function plainBody(body: BodyLine[], maxLines: number): string {
	const lines = body.flatMap((l) => `${l.prefix ?? ""}${l.styled ? l.text.replace(SGR, "") : l.text}`.split("\n"));

	if (lines.length <= maxLines) return lines.join("\n");

	return [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`].join("\n");
}
