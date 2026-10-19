import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { buildBody, reasonSpans } from "../src/body.ts";
import { formatReason, type Reason } from "../src/policy.ts";
import { PermissionPrompt, type PromptHost, type PromptTheme, wrapPlain } from "../src/prompt-ui.ts";
import { onlySgr, sanitize } from "../src/text.ts";

const theme: PromptTheme = { fg: (_c, t) => t, bg: (_c, t) => `<${t}>`, bold: (t) => t };

function tui(rows = 20): PromptHost {
	return { terminal: { rows }, requestRender() {} };
}

function wheel(wheelDelta: number): TuiMouseEvent {
	const position = { x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 20 };

	return { type: "wheel", button: "none", ...position, shift: false, alt: false, ctrl: false, wheelDelta };
}

function prompt(lines: number, rows = 20) {
	let result: string | undefined;
	const body = Array.from({ length: lines }, (_, i) => ({ text: `line ${i}` }));

	const p = new PermissionPrompt(
		tui(rows),
		theme,
		"🔐 bash requires permission",
		body,
		{ maxHeightRatio: 0.85, choices: ALWAYS },
		(c) => {
			result = c;
		},
	);

	return { p, result: () => result };
}

const KEY = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	shiftUp: "\x1b[1;2A",
	shiftDown: "\x1b[1;2B",
	pageDown: "\x1b[6~",
	end: "\x1b[F",
	enter: "\r",
	esc: "\x1b",
};

const ALWAYS = [{ key: "a", label: "Always: this exact command" }];

describe("sanitize", () => {
	it("makes control characters visible", () => {
		assert.equal(sanitize("a\x1b[31mb\x07"), "a␛[31mb\\x07");
	});

	it("expands tabs and drops carriage returns", () => {
		assert.equal(sanitize("a\tb\r"), "a    b");
	});
});

describe("onlySgr", () => {
	it("keeps color codes and neutralizes other escape sequences", () => {
		assert.equal(onlySgr("\x1b[31mred\x1b[0m"), "\x1b[31mred\x1b[0m");
		assert.equal(onlySgr("\x1b[2Jx\x1b]0;t\x07"), "\u241b[2Jx\u241b]0;t\x07");
	});
});

/** Fake highlighter: wraps each line in a color code so tests can see it was used. */
const fakeHighlight = (code: string, lang: string) => code.split("\n").map((l) => `\x1b[35m${lang}:${l}\x1b[0m`);
const deps = { highlight: fakeHighlight, languageOf: (p: string) => (p.endsWith(".ts") ? "typescript" : undefined) };

describe("buildBody: syntax highlighting", () => {
	it("highlights edits by file language and keeps colored diff signs", () => {
		const body = buildBody("edit", { path: "a.ts", edits: [{ oldText: "a\nb", newText: "c" }] }, "/p/a.ts", [], deps);
		const diff = body.filter((l) => l.prefix === "- " || l.prefix === "+ ");
		assert.deepEqual(
			diff.map((l) => [l.prefix, l.prefixColor, l.styled, l.text]),
			[
				["- ", "toolDiffRemoved", true, "\x1b[35mtypescript:a\x1b[0m"],
				["- ", "toolDiffRemoved", true, "\x1b[35mtypescript:b\x1b[0m"],
				["+ ", "toolDiffAdded", true, "\x1b[35mtypescript:c\x1b[0m"],
			],
		);
	});

	it("keeps plain red/green text when the language is unknown", () => {
		const body = buildBody("edit", { path: "x", edits: [{ oldText: "a", newText: "b" }] }, "/p/x.unknown", [], deps);
		const diff = body.filter((l) => l.prefix === "- " || l.prefix === "+ ");
		assert.deepEqual(
			diff.map((l) => [l.styled, l.color]),
			[
				[undefined, "toolDiffRemoved"],
				[undefined, "toolDiffAdded"],
			],
		);
	});

	it("highlights bash commands and written content", () => {
		const bash = buildBody("bash", { command: "ls && pwd" }, undefined, [], deps);
		assert.deepEqual(
			bash.filter((l) => l.styled).map((l) => l.text),
			["\x1b[35mbash:ls\x1b[0m", "\x1b[35mbash:&& pwd\x1b[0m"],
		);
		const write = buildBody("write", { path: "a.ts", content: "x" }, "/p/a.ts", [], deps);
		assert.ok(write.some((l) => l.styled && l.text.includes("typescript:x")));
	});

	it("sanitizes before highlighting, so input escapes never reach the terminal", () => {
		const body = buildBody("bash", { command: "echo \x1b[2J" }, undefined, [], deps);
		const line = body.find((l) => l.styled)?.text ?? "";
		assert.ok(line.includes("\u241b[2J"));
		assert.ok(!line.includes("\x1b[2J"));
	});

	it("falls back to plain text when the highlighter throws or misaligns", () => {
		const throwing = {
			highlight: () => {
				throw new Error("boom");
			},
		};

		assert.ok(!buildBody("bash", { command: "ls" }, undefined, [], throwing).some((l) => l.styled));
		const misaligned = { highlight: () => ["one", "two"] };
		assert.ok(!buildBody("bash", { command: "ls" }, undefined, [], misaligned).some((l) => l.styled));
	});

	it("renders highlighted lines within the width", () => {
		const body = buildBody("bash", { command: `echo ${"word ".repeat(40)}` }, undefined, [], deps);
		const p = new PermissionPrompt(tui(60), theme, "t", body, { maxHeightRatio: 0.85, choices: [] }, () => {});

		for (const row of p.render(40)) assert.equal(visibleWidth(row), 40);
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
		const yes = rows.findIndex((r) => r.includes("[y] Yes"));
		assert.ok(yes > 1, "options are drawn after the body");
		assert.ok(rows.some((r) => r.includes("[a] Always")));
	});

	it("shows the scroll position only when content overflows", () => {
		assert.ok(
			prompt(200)
				.p.render(70)
				.some((r) => r.includes("/ 200")),
		);
		assert.ok(
			!prompt(3)
				.p.render(70)
				.some((r) => r.includes(" / ")),
		);
	});

	it("wraps long lines instead of cutting them", () => {
		const body = buildBody("bash", { command: `echo ${"word ".repeat(40)}` }, undefined, []);
		const p = new PermissionPrompt(tui(60), theme, "t", body, { maxHeightRatio: 0.85, choices: [] }, () => {});
		const text = p.render(40).join("\n");
		assert.equal(text.split("word").length - 1, 40);
	});
});

describe("PermissionPrompt input", () => {
	it("scrolls with keys", () => {
		const { p } = prompt(200);
		p.render(70);
		p.handleInput(KEY.pageDown);
		const first = Number(/line (\d+)/.exec(p.render(70)[1])?.[1]);
		assert.ok(first > 0, "the body scrolled");
		p.handleInput(KEY.end);
		assert.ok(p.render(70).some((r) => r.includes("line 199")));
	});

	describe("mouse clicks on options", () => {
		// bg must be zero-width here so rendered columns match the click areas.
		const flat: PromptTheme = { ...theme, bg: (_c, t) => t };

		const open = () => {
			let answer: { key: string; text?: string } | undefined;

			const p = new PermissionPrompt(
				tui(30),
				flat,
				"t",
				[{ text: "x" }],
				{ maxHeightRatio: 0.85, choices: ALWAYS },
				(key, text) => {
					answer = { key, text };
				},
			);

			return { p, answer: () => answer };
		};

		/** Press and click at the middle of option `key`, as rendered at `width`. */
		const clickOption = (p: PermissionPrompt, key: string, width: number) => {
			const rows = p.render(width);
			const y = rows.findIndex((r) => r.includes(`[${key}]`));
			assert.ok(y >= 0, `[${key}] is rendered`);
			const x = visibleWidth(rows[y].slice(0, rows[y].indexOf(`[${key}]`))) + 1;
			const at = { ...wheel(0), button: "left" as const, x, y };
			const pressed = p.handleMouse({ ...at, type: "press" });
			const clicked = p.handleMouse({ ...at, type: "click", clickCount: 1 });

			return { pressed, clicked };
		};

		for (const width of [120, 40]) {
			it(`selects on the first click and confirms on the second (${width} columns)`, () => {
				const { p, answer } = open();
				const first = clickOption(p, "a", width);
				assert.deepEqual(first.pressed, { handled: true }, "the press is taken, so the click follows");
				assert.equal(answer(), undefined, "one click only selects");
				clickOption(p, "a", width);
				assert.deepEqual(answer(), { key: "a", text: undefined });
			});
		}

		it("never approves with a single click on the default Yes", () => {
			const { p, answer } = open();
			clickOption(p, "y", 120);
			assert.equal(answer(), undefined);
		});

		it("needs two clicks again after the keyboard moves the selection", () => {
			const { p, answer } = open();
			clickOption(p, "n", 120);
			p.handleInput(KEY.right);
			p.handleInput(KEY.left); // back on No
			clickOption(p, "n", 120);
			assert.equal(answer(), undefined);
		});

		it("opens the input on the second click of m", () => {
			const { p, answer } = open();
			clickOption(p, "m", 120);
			clickOption(p, "m", 120);
			assert.equal(answer(), undefined);
			assert.ok(p.render(120).some((r) => r.includes("Message:")));
		});

		it("ignores clicks outside the options and on other buttons", () => {
			const { p } = open();
			p.render(120);
			assert.equal(p.handleMouse({ ...wheel(0), type: "click", button: "left", x: 5, y: 1 }), undefined);
			const y = p.render(120).findIndex((r) => r.includes("[y]"));
			assert.equal(p.handleMouse({ ...wheel(0), type: "click", button: "right", x: 4, y }), undefined);
		});
	});

	it("scrolls with the mouse wheel", () => {
		const { p } = prompt(200);
		p.render(70);
		assert.deepEqual(p.handleMouse(wheel(5)), { handled: true });
		assert.ok(p.render(70)[1].includes("line 5"));
	});

	it("confirms Yes with Enter by default", () => {
		const { p, result } = prompt(3);
		p.handleInput(KEY.enter);
		assert.equal(result(), "y");
	});

	it("moves the selection with arrows", () => {
		const { p, result } = prompt(3);
		p.handleInput(KEY.right); // Yes, with a message
		p.handleInput(KEY.right); // No
		p.handleInput(KEY.right); // No, tell pi
		p.handleInput(KEY.right); // Always
		p.handleInput(KEY.enter);
		assert.equal(result(), "a");
	});

	it("scrolls with ↑↓ when the options fit on one row", () => {
		const { p, result } = prompt(200);
		const rows = p.render(120);
		assert.ok(rows.some((r) => r.includes("←→ select")));
		p.handleInput(KEY.down);
		assert.ok(p.render(120)[1].includes("line 1"));
		p.handleInput(KEY.enter);
		assert.equal(result(), "y");
	});

	it("selects with ↑↓ when the options are stacked", () => {
		const { p, result } = prompt(200);
		const rows = p.render(40);
		assert.ok(rows.some((r) => r.includes("↑↓ select")));
		p.handleInput(KEY.down); // Yes, with a message
		p.handleInput(KEY.down); // No
		p.handleInput(KEY.down); // No, tell pi
		p.handleInput(KEY.down); // Always
		assert.ok(p.render(40)[1].includes("line 0"), "the body did not scroll");
		p.handleInput(KEY.up); // No, tell pi
		p.handleInput(KEY.up); // No
		p.handleInput(KEY.enter);
		assert.equal(result(), "n");
	});

	it("scrolls with Shift+↑↓ when the options are stacked", () => {
		const { p, result } = prompt(200);
		assert.ok(p.render(40).some((r) => r.includes("⇧↑↓ scroll")));
		p.handleInput(KEY.shiftDown);
		p.handleInput(KEY.shiftDown);
		assert.ok(p.render(40)[1].includes("line 2"));
		p.handleInput(KEY.shiftUp);
		assert.ok(p.render(40)[1].includes("line 1"));
		p.handleInput(KEY.enter);
		assert.equal(result(), "y", "the selection did not move");
	});

	it("answers directly with y / n / a", () => {
		for (const [key, choice] of [
			["y", "y"],
			["N", "n"],
			["a", "a"],
		] as const) {
			const { p, result } = prompt(3);
			p.handleInput(key);
			assert.equal(result(), choice);
		}
	});

	it("denies with Escape", () => {
		const { p, result } = prompt(3);
		p.handleInput(KEY.esc);
		assert.equal(result(), "n");
	});
});

describe("buildBody", () => {
	const texts = (lines: { text: string }[]) => lines.map((l) => l.text);

	it("shows a bash command split by operator, then the reasons", () => {
		const reason: Reason = { kind: "note", subject: "r1", action: "ask" };
		const body = texts(buildBody("bash", { command: "a && b | c" }, undefined, [reason]));
		assert.deepEqual(body, ["Command", "a", "&& b", "| c", "", "Why", formatReason(reason)]);
	});

	it("shows a here-document body as a block under its command", () => {
		const body = buildBody("bash", { command: "cat <<'EOF'\nhello\nEOF\nls" }, undefined, []);
		const block = body.map((l) => `${l.prefix ?? ""}${l.text}`);
		assert.deepEqual(block.slice(0, 5), ["Command", "$ cat <<'EOF'", "  │ hello", "  EOF", "  ls"]);
	});

	it("labels an inline script and highlights it in its language", () => {
		const langs: string[] = [];

		const highlight = (code: string, lang: string) => {
			langs.push(lang);

			return code.split("\n");
		};

		const body = buildBody("bash", { command: "python3 - <<'PY'\nimport os\nprint(1)\nPY" }, undefined, [], {
			highlight,
		});

		const block = body.map((l) => `${l.prefix ?? ""}${l.text}`);
		const script = ["$ python3 - <<'PY'", "  ┌ Python script, 2 lines", "  │ import os", "  │ print(1)", "  PY"];
		assert.deepEqual(block.slice(1, 6), script);
		assert.ok(langs.includes("python"));
	});

	it("shows -c code as a labeled block", () => {
		const body = buildBody("bash", { command: `python3 -c "print(1)"` }, undefined, []);
		const block = body.map((l) => `${l.prefix ?? ""}${l.text}`);
		assert.deepEqual(block.slice(2, 5), ["  ┌ Python script, 1 line", "  │ print(1)", "  └"]);
	});

	it("lists what needs a decision, then folds what is allowed into one line", () => {
		const reasons: Reason[] = [
			{ kind: "readonly", subject: '"cd x"', action: "allow" },
			{ kind: "fallback", subject: '"python3 -"', section: "bash", action: "ask" },
			{ kind: "readonly", subject: '"grep a b"', action: "allow" },
		];

		const why = texts(buildBody("bash", { command: "x" }, undefined, reasons)).slice(-2);
		assert.deepEqual(why, [formatReason(reasons[1]), `2 allowed: "cd x", "grep a b"`]);
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

describe("reasonSpans", () => {
	const reasons: Reason[] = [
		{ kind: "match", subject: '"git status"', section: "bash", pattern: "git status *", action: "allow" },
		{ kind: "fallback", subject: '"ls -la"', section: "bash", action: "ask" },
		{ kind: "default", subject: "mcp__x", section: "tools", action: "deny" },
		{ kind: "note", subject: "contains redirection to file", action: "ask" },
	];

	it("joins to exactly the plain text the model receives", () => {
		for (const r of reasons)
			assert.equal(
				reasonSpans(r)
					.map((s) => s.text)
					.join(""),
				formatReason(r),
			);
	});

	it("colors the action by meaning and highlights the pattern", () => {
		const color = (r: Reason, text: string) => reasonSpans(r).find((s) => s.text === text)?.color;
		assert.equal(color(reasons[0], "allow"), "success");
		assert.equal(color(reasons[0], '"git status *"'), "accent");
		assert.equal(color(reasons[1], "ask"), "warning");
		assert.equal(color(reasons[1], '"*"'), "accent");
		assert.equal(color(reasons[2], "deny"), "error");
		assert.equal(color(reasons[3], "contains redirection to file"), "warning");
	});

	it("renders colored reasons within the width and sanitizes them", () => {
		const evil: Reason = {
			kind: "fallback",
			subject: `"echo \x1b[2J ${"x".repeat(80)}"`,
			section: "bash",
			action: "ask",
		};

		const colorTheme: PromptTheme = { fg: (_c, t) => `\x1b[33m${t}\x1b[0m`, bg: (_c, t) => t, bold: (t) => t };
		const body = buildBody("bash", { command: "ls" }, undefined, [evil]);

		const rows = new PermissionPrompt(
			tui(40),
			colorTheme,
			"t",
			body,
			{ maxHeightRatio: 0.85, choices: [] },
			() => {},
		).render(50);

		for (const row of rows) assert.equal(visibleWidth(row), 50);
		const text = rows.join("");
		assert.ok(text.includes("\u241b[2J"));
		assert.ok(!text.includes("\x1b[2J"));
	});
});

describe("PermissionPrompt options", () => {
	const four = [
		{ key: "a", label: "Always: read in …/Temp/soloterm-clipboard/" },
		{ key: "d", label: "Always: read in …/Temp/soloterm-clipboard/ and subfolders" },
	];

	const make = (width: number, choices = four) => {
		let result: string | undefined;
		const body = [{ text: "x" }];
		const p = new PermissionPrompt(tui(30), theme, "t", body, { maxHeightRatio: 0.85, choices }, (k) => (result = k));

		return { p, rows: p.render(width), result: () => result };
	};

	it("puts options on one row when they fit", () => {
		const { rows } = make(200);
		assert.equal(rows.filter((r) => r.includes("[y] Yes")).length, 1);
		assert.ok(rows.some((r) => r.includes("[y] Yes") && r.includes("[d] Always")));
	});

	it("stacks options one per row when they do not fit, without cutting them", () => {
		const { rows } = make(80);

		for (const label of ["[y] Yes", "[n] No", "[a] Always: read in", "and subfolders"]) {
			assert.ok(
				rows.some((r) => r.includes(label)),
				label,
			);
		}

		for (const row of rows) assert.equal(visibleWidth(row), 80);
	});

	it("selects the fourth option with d and by cycling", () => {
		const direct = make(200);
		direct.p.handleInput("d");
		assert.equal(direct.result(), "d");
		const cycled = make(200);
		cycled.p.handleInput(KEY.left);
		cycled.p.handleInput(KEY.enter);
		assert.equal(cycled.result(), "d");
	});

	it("ignores keys that are not options", () => {
		const { p, result } = make(200, []);
		p.handleInput("a");
		p.handleInput("d");
		assert.equal(result(), undefined);
	});

	it("sanitizes option labels", () => {
		const { rows } = make(200, [{ key: "a", label: "Always: read in \x1b[2J/" }]);
		assert.ok(!rows.join("").includes("\x1b[2J"));
	});
});

describe("buildBody: path line", () => {
	const pathLine = (absPath: string, requested?: string) =>
		buildBody("read", { path: "x" }, absPath, [], {}, requested).find((l) => l.prefix === "Path: ");

	it("shows only the path when it was not reached through a symlink", () => {
		const line = pathLine("/usr/lib/os-release", "/usr/lib/os-release");
		assert.equal(line?.text, "/usr/lib/os-release");
		assert.equal(line?.spans, undefined);
	});

	it("shows requested → real when a symlink was followed", () => {
		const line = pathLine("/usr/lib/os-release", "/etc/os-release");
		assert.equal(line?.text, "/etc/os-release → /usr/lib/os-release (symlink)");
		assert.equal(line?.spans?.find((s) => s.text === "/usr/lib/os-release")?.color, "accent");
	});
});

describe("PermissionPrompt: tell pi what to do", () => {
	const open = () => {
		let result: { key: string; text?: string } | undefined;

		const p = new PermissionPrompt(
			tui(30),
			theme,
			"t",
			[{ text: "x" }],
			{ maxHeightRatio: 0.85, choices: [] },
			(key, text) => {
				result = { key, text };
			},
		);

		return { p, result: () => result };
	};

	const type = (p: PermissionPrompt, text: string) => {
		for (const ch of text) p.handleInput(ch);
	};

	it("offers the option after No", () => {
		const { p } = open();
		const row = p.render(120).find((r) => r.includes("[y] Yes")) ?? "";
		assert.ok(row.indexOf("[n] No") < row.indexOf("[t] No, tell pi what to do"));
	});

	it("opens a one-line input with t and sends the typed text", () => {
		const { p, result } = open();
		p.handleInput("t");
		assert.equal(result(), undefined, "choosing t does not resolve yet");
		const rows = p.render(80);
		assert.ok(rows.some((r) => r.includes("Tell pi:")));
		assert.ok(!rows.some((r) => r.includes("[y] Yes")), "options are replaced by the input");
		type(p, "use rg instead");
		p.handleInput(KEY.enter);
		assert.deepEqual(result(), { key: "t", text: "use rg instead" });
	});

	it("does not treat typed letters as shortcuts while the input is open", () => {
		const { p, result } = open();
		p.handleInput("t");
		type(p, "yna");
		assert.equal(result(), undefined);
	});

	it("goes back to the options with Esc, without answering", () => {
		const { p, result } = open();
		p.handleInput("t");
		p.handleInput(KEY.esc);
		assert.equal(result(), undefined);
		assert.ok(p.render(120).some((r) => r.includes("[y] Yes")));
		p.handleInput("y");
		assert.deepEqual(result(), { key: "y", text: undefined });
	});

	it("treats an empty or blank message as a plain No", () => {
		const { p, result } = open();
		p.handleInput("t");
		type(p, "   ");
		p.handleInput(KEY.enter);
		assert.deepEqual(result(), { key: "n", text: undefined });
	});

	it("offers Yes, with a message, right after Yes", () => {
		const { p } = open();
		const row = p.render(120).find((r) => r.includes("[y] Yes")) ?? "";
		assert.ok(row.indexOf("[y] Yes") < row.indexOf("[m] Yes, with a message"));
		assert.ok(row.indexOf("[m] Yes, with a message") < row.indexOf("[n] No"));
	});

	it("opens the message input with m and sends the typed text", () => {
		const { p, result } = open();
		p.handleInput("m");
		assert.equal(result(), undefined);
		assert.ok(p.render(80).some((r) => r.includes("Message:")));
		type(p, "also run the tests");
		p.handleInput(KEY.enter);
		assert.deepEqual(result(), { key: "m", text: "also run the tests" });
	});

	it("treats an empty message as a plain Yes", () => {
		const { p, result } = open();
		p.handleInput("m");
		p.handleInput(KEY.enter);
		assert.deepEqual(result(), { key: "y", text: undefined });
	});

	it("keeps every row within the width while typing", () => {
		const { p } = open();
		p.handleInput("t");
		type(p, "x".repeat(200));

		for (const row of p.render(60)) assert.equal(visibleWidth(row), 60);
	});

	it("passes focus to the input, so the cursor is placed only when focused", () => {
		const focused = open();
		focused.p.focused = true;
		focused.p.handleInput("t");
		assert.ok(focused.p.render(80).join("").includes(CURSOR_MARKER));

		const unfocused = open();
		unfocused.p.handleInput("t");
		assert.ok(!unfocused.p.render(80).join("").includes(CURSOR_MARKER));
	});
});
