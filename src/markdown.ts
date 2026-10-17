/**
 * Line-based Markdown highlighting with Pi's `md*` theme colors, so Markdown in a
 * prompt looks like Markdown in the transcript. Pi's code highlighter has no colors
 * for Markdown's token classes (headings, bullets, code), so it is done here.
 *
 * Display only, best effort. Returns exactly one line per input line.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";

export type MarkdownTheme = Pick<Theme, "fg" | "bold">;
/** Highlights a fenced code block; undefined falls back to the code block color. */
export type FenceHighlighter = (code: string, lang: string) => string[] | undefined;

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+-]*)/;
const HEADING = /^#{1,6}\s/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^(\s*>+\s?)(.*)$/;
const BULLET = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/;
/** Inline code, bold, links. Applied left to right, no nesting. */
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\[[^\]]+\])(\([^)\s]+\))/g;

function inline(text: string, t: MarkdownTheme): string {
	return text.replace(INLINE, (match, code, bold, label, url) => {
		if (code) return t.fg("mdCode", match);
		if (bold) return t.bold(match);
		return t.fg("mdLink", label) + t.fg("mdLinkUrl", url);
	});
}

function line(text: string, t: MarkdownTheme): string {
	if (HEADING.test(text)) return t.bold(t.fg("mdHeading", text));
	if (RULE.test(text)) return t.fg("mdHr", text);
	const quote = QUOTE.exec(text);
	if (quote) return t.fg("mdQuoteBorder", quote[1]) + t.fg("mdQuote", inline(quote[2], t));
	const bullet = BULLET.exec(text);
	if (bullet) return bullet[1] + t.fg("mdListBullet", bullet[2]) + bullet[3] + inline(bullet[4], t);
	return inline(text, t);
}

export function highlightMarkdown(text: string, t: MarkdownTheme, fence?: FenceHighlighter): string[] {
	const lines = text.split("\n");
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const open = FENCE.exec(lines[i]);
		if (!open) {
			out.push(line(lines[i], t));
			continue;
		}
		// Fenced block: find the closing fence (same marker, at least as long).
		const marker = open[2];
		let end = i + 1;
		while (end < lines.length && !lines[end].trimStart().startsWith(marker)) end++;
		const body = lines.slice(i + 1, end);
		const colored = body.length && open[3] ? fence?.(body.join("\n"), open[3]) : undefined;
		out.push(t.fg("mdCodeBlockBorder", lines[i]));
		if (colored?.length === body.length) out.push(...colored);
		else out.push(...body.map((b) => t.fg("mdCodeBlock", b)));
		if (end < lines.length) out.push(t.fg("mdCodeBlockBorder", lines[end]));
		i = end;
	}
	return out;
}
