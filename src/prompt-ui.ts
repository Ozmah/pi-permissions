/**
 * Scrollable permission prompt.
 *
 * Layout: fixed title row, scrollable body, fixed options and hint rows. The
 * options never scroll out of view, whatever the body length.
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component, Focusable, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { sanitize } from "./text.ts";

/** An answer option. `key` is both its shortcut and the value the prompt resolves with. */
export interface PromptChoice {
	key: string;
	label: string;
}

/** Always offered first: Enter on open means Yes. */
export const YES: PromptChoice = { key: "y", label: "Yes" };
export const NO: PromptChoice = { key: "n", label: "No" };

/** Denies and opens a one-line input; the prompt resolves with the typed text. */
export const TELL: PromptChoice = { key: "t", label: "No, tell pi what to do" };

/** The subset of Pi's Theme the prompt uses. */
export type PromptTheme = Pick<Theme, "fg" | "bg" | "bold">;

/** Theme color for each action, shared by the prompt and the summary card. */
export const ACTION_COLOR = { allow: "success", ask: "warning", deny: "error" } as const satisfies Record<
	string,
	ThemeColor
>;

/** A run of text with its own color. Text is sanitized when rendered. */
export interface Span {
	text: string;
	color: ThemeColor;
}

export interface BodyLine {
	/** Plain text. Also used as-is by non-TUI fallbacks when `spans` is set. */
	text: string;
	/** Colored runs that replace `text` in the TUI. */
	spans?: Span[];
	/**
	 * `text` is already sanitized and colored (syntax highlighting): it is wrapped
	 * ANSI-aware and `color` is ignored. Only `body.ts` produces these lines.
	 */
	styled?: boolean;
	/** Defaults to "text". */
	color?: ThemeColor;
	/** Printed before the first wrapped row, e.g. "$ ", "+ ", "12 │ ". */
	prefix?: string;
	/** Printed before continuation rows. Defaults to spaces as wide as `prefix`. */
	contPrefix?: string;
	prefixColor?: ThemeColor;
	heading?: boolean;
}

export interface PromptOptions {
	/** Maximum height as a fraction of the terminal rows. */
	maxHeightRatio: number;
	/** Options after Yes and No (e.g. "always" grants). */
	choices: PromptChoice[];
}

/** Fixed rows besides the options: top border, separator, hint, bottom border. */
const FRAME_ROWS = 4;

/** Smallest body height worth showing. */
const MIN_BODY_ROWS = 3;
const FALLBACK_TERMINAL_ROWS = 40;

/** Greedy wrap by visible width. Breaks at spaces when possible, hard-cuts otherwise. */
export function wrapPlain(text: string, width: number): string[] {
	if (width < 1 || visibleWidth(text) <= width) return [text];
	const out: string[] = [];
	let line = "";
	let lineWidth = 0;
	let lastSpace = -1;

	for (const ch of text) {
		const w = visibleWidth(ch);

		if (lineWidth + w > width) {
			if (ch === " ") {
				// Overflow lands on a space: break here and drop it.
				out.push(line);
				line = "";
				lineWidth = 0;
				lastSpace = -1;
				continue;
			}

			if (lastSpace > 0) {
				out.push(line.slice(0, lastSpace));
				line = line.slice(lastSpace + 1);
			} else {
				out.push(line);
				line = "";
			}

			lineWidth = visibleWidth(line);
			lastSpace = -1;
		}

		if (ch === " ") lastSpace = line.length;
		line += ch;
		lineWidth += w;
	}

	if (line) out.push(line);

	return out;
}

/** What the prompt needs from Pi's TUI: re-rendering and the terminal height. */
export interface PromptHost {
	requestRender(): void;
	terminal?: { readonly rows: number };
}

export class PermissionPrompt implements Component, Focusable {
	private scroll = 0;
	private selected = 0; // "Yes"
	private bodyHeight = 1;
	/** Options were rendered one per row: ↑↓ select instead of scrolling. */
	private stacked = false;
	private wrapCache: { width: number; rows: string[] } | undefined;
	private readonly tui: PromptHost;
	private readonly theme: PromptTheme;
	private readonly title: string;
	private readonly body: BodyLine[];
	private readonly maxHeightRatio: number;
	private readonly choices: PromptChoice[];
	private readonly done: (key: string, text?: string) => void;
	/** The "tell pi" input while it is open. */
	private input: Input | undefined;
	private isFocused = false;

	constructor(
		tui: PromptHost,
		theme: PromptTheme,
		title: string,
		body: BodyLine[],
		options: PromptOptions,
		done: (key: string, text?: string) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.title = title;
		this.body = body;
		this.maxHeightRatio = options.maxHeightRatio;
		this.choices = [YES, NO, TELL, ...options.choices];
		this.done = done;
	}

	/** Focus is passed to the input so the cursor and IME land in the right place. */
	get focused(): boolean {
		return this.isFocused;
	}

	set focused(value: boolean) {
		this.isFocused = value;

		if (this.input) this.input.focused = value;
	}

	private openInput(): void {
		const input = new Input({ placeholder: "what should pi do instead?" });
		input.focused = this.isFocused;
		// Empty text is a plain No.
		input.onSubmit = (value) => (value.trim() ? this.done(TELL.key, value.trim()) : this.done(NO.key));
		this.input = input;
		this.tui.requestRender();
	}

	private closeInput(): void {
		this.input = undefined;
		this.tui.requestRender();
	}

	/** The input row, padded to the inner width (not truncated: it carries the cursor marker). */
	private inputRow(input: Input, inner: number): string {
		const label = this.theme.fg("accent", "Tell pi: ");
		const field = input.render(Math.max(1, inner - visibleWidth(label)))[0] ?? "";
		const content = label + field;

		return content + " ".repeat(Math.max(0, inner - visibleWidth(content)));
	}

	/** Option labels on one row when they fit, otherwise one per row. */
	private optionRows(inner: number): string[] {
		const t = this.theme;

		const labels = this.choices.map((c, i) => {
			const label = ` [${c.key}] ${sanitize(c.label)} `; // labels can contain agent-provided paths

			return i === this.selected ? t.bg("selectedBg", t.bold(t.fg("accent", label))) : t.fg("muted", label);
		});

		const single = labels.join("  ");

		return visibleWidth(single) <= inner ? [single] : labels;
	}

	invalidate(): void {
		this.wrapCache = undefined;
	}

	private wrapped(inner: number): string[] {
		if (this.wrapCache?.width === inner) return this.wrapCache.rows;
		const t = this.theme;
		const rows: string[] = [];

		for (const line of this.body) {
			const color = line.color ?? "text";
			const prefix = line.prefix ?? "";
			const cont = line.contPrefix ?? " ".repeat(visibleWidth(prefix));
			const prefixColor = line.prefixColor ?? color;
			const avail = Math.max(1, inner - Math.max(visibleWidth(prefix), visibleWidth(cont)));
			let first = true;
			// Colored lines (highlighted code, spans) wrap ANSI-aware; plain lines are colored per chunk.
			const colored = line.styled || line.spans !== undefined;

			const text = line.spans
				? line.spans.map((s) => t.fg(s.color, sanitize(s.text))).join("")
				: line.styled
					? line.text
					: sanitize(line.text);

			for (const piece of text.split("\n")) {
				const chunks = colored ? wrapTextWithAnsi(piece, avail) : wrapPlain(piece, avail);

				for (const chunk of chunks.length ? chunks : [""]) {
					const p = first ? prefix : cont;
					let content = chunk;

					if (!colored) content = line.heading ? t.bold(t.fg(color, chunk)) : t.fg(color, chunk);
					rows.push((p ? t.fg(prefixColor, p) : "") + content);
					first = false;
				}
			}
		}

		this.wrapCache = { width: inner, rows };

		return rows;
	}

	render(width: number): string[] {
		const t = this.theme;
		const inner = Math.max(10, width - 4);
		const rows = this.wrapped(inner);

		const options = this.input ? [this.inputRow(this.input, inner)] : this.optionRows(inner);

		if (!this.input) this.stacked = options.length > 1;
		const chrome = FRAME_ROWS + options.length;
		const termRows = this.tui.terminal?.rows ?? FALLBACK_TERMINAL_ROWS;
		const maxRows = Math.max(chrome + MIN_BODY_ROWS, Math.floor(termRows * this.maxHeightRatio));
		this.bodyHeight = Math.max(1, Math.min(rows.length, maxRows - chrome));
		this.scrollTo(this.scroll);

		const border = (s: string) => t.fg("borderAccent", s);
		const row = (content: string) => `${border("│")} ${truncateToWidth(content, inner, "…", true)} ${border("│")}`;
		const out: string[] = [];

		const title = truncateToWidth(` ${this.title} `, width - 3);
		const fill = Math.max(0, width - 3 - visibleWidth(title));
		out.push(border("┌─") + t.bold(t.fg("accent", title)) + border(`${"─".repeat(fill)}┐`));

		for (let i = 0; i < this.bodyHeight; i++) out.push(row(rows[this.scroll + i] ?? ""));

		const overflow = rows.length > this.bodyHeight;
		const pos = overflow ? ` ${this.scroll + 1}-${this.scroll + this.bodyHeight} / ${rows.length} ` : "";
		out.push(border(`├${"─".repeat(Math.max(0, width - 3 - pos.length))}`) + t.fg("warning", pos) + border("─┤"));

		for (const option of options) out.push(this.input ? `${border("│")} ${option} ${border("│")}` : row(option));

		const select = this.stacked ? "↑↓ select" : "←→ select";
		const scroll = this.stacked ? "PgUp PgDn scroll" : "↑↓ PgUp PgDn scroll";

		const hint = this.input
			? "Enter send · Esc back to options"
			: `${overflow ? `${scroll} · ` : ""}${select} · Enter confirm · Esc deny`;

		out.push(row(t.fg("dim", hint)));

		out.push(border(`└${"─".repeat(Math.max(0, width - 2))}┘`));

		return out;
	}

	private scrollTo(top: number): void {
		const total = this.wrapCache?.rows.length ?? 0;
		this.scroll = Math.max(0, Math.min(top, total - this.bodyHeight));
	}

	private scrollBy(delta: number): void {
		this.scrollTo(this.scroll + delta);
		this.tui.requestRender();
	}

	private select(delta: number): void {
		this.selected = (this.selected + delta + this.choices.length) % this.choices.length;
		this.tui.requestRender();
	}

	/** Resolves with an option's key; the tell option opens the input instead. */
	private choose(key: string): void {
		if (key === TELL.key) this.openInput();
		else this.done(key);
	}

	handleInput(data: string): void {
		if (this.input) {
			if (matchesKey(data, Key.escape)) this.closeInput();
			else {
				this.input.handleInput(data);
				this.tui.requestRender();
			}

			return;
		}

		const page = Math.max(1, this.bodyHeight - 1);

		if (matchesKey(data, Key.up)) {
			if (this.stacked) this.select(-1);
			else this.scrollBy(-1);
		} else if (matchesKey(data, Key.down)) {
			if (this.stacked) this.select(1);
			else this.scrollBy(1);
		} else if (matchesKey(data, Key.pageUp)) this.scrollBy(-page);
		else if (matchesKey(data, Key.pageDown)) this.scrollBy(page);
		else if (matchesKey(data, Key.home)) this.scrollBy(-this.scroll);
		else if (matchesKey(data, Key.end)) this.scrollBy(Number.POSITIVE_INFINITY);
		else if (matchesKey(data, Key.left) || matchesKey(data, "shift+tab")) this.select(-1);
		else if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) this.select(1);
		else if (matchesKey(data, Key.enter)) this.choose(this.choices[this.selected].key);
		else if (matchesKey(data, Key.escape)) this.done(NO.key);
		else {
			const direct = this.choices.find((c) => data.toLowerCase() === c.key);

			if (direct) this.choose(direct.key);
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" || !event.wheelDelta) return undefined;
		this.scrollBy(event.wheelDelta);

		return { handled: true };
	}
}
