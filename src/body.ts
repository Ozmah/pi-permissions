/**
 * Builds the prompt body for a tool call. The body is unbounded; the prompt scrolls it.
 */
import type { BodyLine } from "./prompt-ui.ts";
import { displayLines, parseShell } from "./shell.ts";

const BLANK: BodyLine = { text: "" };

function heading(text: string): BodyLine {
	return { text, color: "accent", heading: true };
}

function bashBody(input: Record<string, unknown>): BodyLine[] {
	const lines: BodyLine[] = [heading("Command")];
	displayLines(parseShell(String(input.command ?? ""))).forEach((text, i) => {
		lines.push({ text, prefix: i === 0 ? "$ " : "  ", prefixColor: "dim", contPrefix: "    " });
	});
	if (typeof input.timeout === "number") lines.push({ text: `timeout: ${input.timeout}s`, color: "dim" });
	return lines;
}

function writeBody(content: string): BodyLine[] {
	const lines = content.split("\n");
	const width = String(lines.length).length;
	return [
		BLANK,
		heading(`Content (${lines.length} lines)`),
		...lines.map((text, i): BodyLine => ({ text, prefix: `${String(i + 1).padStart(width)} │ `, prefixColor: "dim" })),
	];
}

function editBody(edits: unknown[]): BodyLine[] {
	const lines: BodyLine[] = [];
	edits.forEach((edit, i) => {
		const e = (typeof edit === "object" && edit !== null ? edit : {}) as { oldText?: unknown; newText?: unknown };
		lines.push(BLANK, heading(`Edit ${i + 1}/${edits.length}`));
		for (const text of String(e.oldText ?? "").split("\n")) {
			lines.push({ text, prefix: "- ", contPrefix: "- ", color: "toolDiffRemoved" });
		}
		for (const text of String(e.newText ?? "").split("\n")) {
			lines.push({ text, prefix: "+ ", contPrefix: "+ ", color: "toolDiffAdded" });
		}
	});
	return lines;
}

export function buildBody(
	toolName: string,
	input: Record<string, unknown>,
	absPath: string | undefined,
	reasons: string[],
): BodyLine[] {
	const body: BodyLine[] = [];

	if (toolName === "bash") {
		body.push(...bashBody(input));
	} else if (absPath) {
		body.push({ text: absPath, prefix: "Path: ", prefixColor: "dim" });
		if (toolName === "write" && typeof input.content === "string") {
			body.push(...writeBody(input.content));
		} else if (toolName === "edit" && Array.isArray(input.edits)) {
			body.push(...editBody(input.edits));
		} else {
			const { path: _path, ...rest } = input;
			if (Object.keys(rest).length) body.push({ text: JSON.stringify(rest), color: "muted" });
		}
	} else {
		body.push(heading("Input"), { text: JSON.stringify(input, null, 2), color: "muted" });
	}

	body.push(BLANK, heading("Why"));
	for (const text of reasons) body.push({ text, prefix: "• ", prefixColor: "dim", color: "muted" });
	return body;
}

/** Plain-text rendering for clients without the TUI (e.g. RPC), capped at `maxLines`. */
export function plainBody(body: BodyLine[], maxLines: number): string {
	const lines = body.flatMap((l) => `${l.prefix ?? ""}${l.text}`.split("\n"));
	if (lines.length <= maxLines) return lines.join("\n");
	return [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`].join("\n");
}
