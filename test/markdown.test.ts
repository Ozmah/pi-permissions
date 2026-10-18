import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type MarkdownTheme, highlightMarkdown } from "../src/markdown.ts";

/** Marks colors as <color:text> and bold as *text* so tests can check them. */
const t: MarkdownTheme = { fg: (c, s) => `<${c}:${s}>`, bold: (s) => `*${s}*` };

const hl = (text: string, fence?: (code: string, lang: string) => string[] | undefined) =>
	highlightMarkdown(text, t, fence);

describe("highlightMarkdown", () => {
	it("returns one line per input line", () => {
		const text = "# T\n\n- a\n```ts\nconst a = 1;\n```\n> q\nend";
		assert.equal(hl(text).length, text.split("\n").length);
	});

	it("colors headings, rules, quotes and bullets", () => {
		assert.deepEqual(hl("## Title\n---\n> quoted\n- item\n1. first"), [
			"*<mdHeading:## Title>*",
			"<mdHr:--->",
			"<mdQuoteBorder:> ><mdQuote:quoted>", // marker is "> "
			"<mdListBullet:-> item",
			"<mdListBullet:1.> first",
		]);
	});

	it("colors inline code, bold and links", () => {
		assert.equal(
			hl("use `x`, **this** and [docs](https://pi.dev)")[0],
			"use <mdCode:`x`>, ***this*** and <mdLink:[docs]><mdLinkUrl:(https://pi.dev)>",
		);
	});

	it("highlights fenced code with its language", () => {
		const fence = (code: string, lang: string) => code.split("\n").map((l) => `${lang}(${l})`);
		assert.deepEqual(hl("```ts\na\nb\n```", fence), [
			"<mdCodeBlockBorder:```ts>",
			"ts(a)",
			"ts(b)",
			"<mdCodeBlockBorder:```>",
		]);
	});

	it("does not treat fenced content as Markdown", () => {
		assert.deepEqual(hl("```\n# not a heading\n```"), [
			"<mdCodeBlockBorder:```>",
			"<mdCodeBlock:# not a heading>",
			"<mdCodeBlockBorder:```>",
		]);
	});

	it("handles an unclosed fence", () => {
		assert.deepEqual(hl("```sh\nls"), ["<mdCodeBlockBorder:```sh>", "<mdCodeBlock:ls>"]);
	});

	it("falls back to the code block color when the fence highlighter misaligns", () => {
		assert.deepEqual(hl("```ts\na\nb\n```", () => ["one"]).slice(1, 3), ["<mdCodeBlock:a>", "<mdCodeBlock:b>"]);
	});
});
