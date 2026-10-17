import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import { buildBody } from "../src/body.ts";
import { type Choice, PermissionPrompt, type PromptTheme, sanitize, wrapPlain } from "../src/prompt-ui.ts";

const theme: PromptTheme = { fg: (_c, t) => t, bg: (_c, t) => `<${t}>`, bold: (t) => t };

function tui(rows = 20): TUI {
	return { terminal: { rows }, requestRender() {} } as unknown as TUI;
}

function prompt(lines: number, rows = 20) {
	let result: Choice | undefined;
	const body = Array.from({ length: lines }, (_, i) => ({ text: `line ${i}` }));
	const p = new PermissionPrompt(tui(rows), theme, "🔐 bash requires permission", body, { maxHeightRatio: 0.85 }, (c) => {
		result = c;
	});
	return { p, result: () => result };
}

const KEY = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", pageDown: "\x1b[6~", end: "\x1b[F", enter: "\r", esc: "\x1b" };

describe("sanitize", () => {
	it("makes control characters visible", () => {
		assert.equal(sanitize("a\x1b[31mb\x07"), "a␛[31mb\\x07");
	});

	it("expands tabs and drops carriage returns", () => {
		assert.equal(sanitize("a\tb\r"), "a    b");
	});
});

describe("wrapPlain", () => {
	it("breaks at spaces", () => {
		assert.deepEqual(wrapPlain("aaa bbb ccc", 7), ["aaa bbb", "ccc"]);
	});

	it("hard-cuts words longer than the width", () => {
		assert.deepEqual(wrapPlain("abcdefghij", 4), ["abcd", "efgh", "ij"]);
	});
});

describe("PermissionPrompt rendering", () => {
	for (const width of [40, 70, 120]) {
		it(`fills exactly ${width} columns on every row`, () => {
			const rows = prompt(50).p.render(width);
			for (const row of rows) assert.equal(visibleWidth(row), width);
		});
	}

	it("caps its height and keeps the options visible", () => {
		const rows = prompt(200, 20).p.render(70);
		assert.equal(rows.length, Math.floor(20 * 0.85));
		assert.ok(rows.at(-3)?.includes("[y] Yes"));
	});

	it("shows the scroll position only when content overflows", () => {
		assert.ok(prompt(200).p.render(70).some((r) => r.includes("/ 200")));
		assert.ok(!prompt(3).p.render(70).some((r) => r.includes(" / ")));
	});

	it("wraps long lines instead of cutting them", () => {
		const body = buildBody("bash", { command: `echo ${"word ".repeat(40)}` }, undefined, []);
		const p = new PermissionPrompt(tui(60), theme, "t", body, { maxHeightRatio: 0.85 }, () => {});
		const text = p.render(40).join("\n");
		assert.equal(text.split("word").length - 1, 40);
	});
});

describe("PermissionPrompt input", () => {
	it("scrolls with keys", () => {
		const { p } = prompt(200);
		p.render(70);
		p.handleInput(KEY.pageDown);
		assert.ok(p.render(70)[1].includes("line 1"));
		p.handleInput(KEY.end);
		assert.ok(p.render(70).some((r) => r.includes("line 199")));
	});

	it("scrolls with the mouse wheel", () => {
		const { p } = prompt(200);
		p.render(70);
		assert.deepEqual(p.handleMouse({ type: "wheel", wheelDelta: 5 } as never), { handled: true });
		assert.ok(p.render(70)[1].includes("line 5"));
	});

	it("confirms Yes with Enter by default", () => {
		const { p, result } = prompt(3);
		p.handleInput(KEY.enter);
		assert.equal(result(), "yes");
	});

	it("moves the selection with arrows", () => {
		const { p, result } = prompt(3);
		p.handleInput(KEY.right);
		p.handleInput(KEY.right);
		p.handleInput(KEY.enter);
		assert.equal(result(), "always");
	});

	it("answers directly with y / n / a", () => {
		for (const [key, choice] of [["y", "yes"], ["N", "no"], ["a", "always"]] as const) {
			const { p, result } = prompt(3);
			p.handleInput(key);
			assert.equal(result(), choice);
		}
	});

	it("denies with Escape", () => {
		const { p, result } = prompt(3);
		p.handleInput(KEY.esc);
		assert.equal(result(), "no");
	});
});

describe("buildBody", () => {
	const texts = (lines: { text: string }[]) => lines.map((l) => l.text);

	it("shows a bash command split by operator, then the reasons", () => {
		const body = texts(buildBody("bash", { command: "a && b | c" }, undefined, ["r1"]));
		assert.deepEqual(body, ["Command", "a", "&& b", "| c", "", "Why", "r1"]);
	});

	it("shows an edit as a diff", () => {
		const body = buildBody("edit", { path: "x", edits: [{ oldText: "a", newText: "b" }] }, "/p/x", []);
		const diff = body.filter((l) => l.prefix === "- " || l.prefix === "+ ").map((l) => `${l.prefix}${l.text}`);
		assert.deepEqual(diff, ["- a", "+ b"]);
	});

	it("shows written content with line numbers", () => {
		const body = buildBody("write", { path: "x", content: "a\nb" }, "/p/x", []);
		assert.deepEqual(
			body.filter((l) => l.prefix?.includes("│")).map((l) => `${l.prefix}${l.text}`),
			["1 │ a", "2 │ b"],
		);
	});
});
