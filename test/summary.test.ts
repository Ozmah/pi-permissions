import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { COMMANDS, type Summary, type SummaryTheme, renderSummary } from "../src/summary.ts";

/** Marks colors as <color:text> so tests can check them. */
const theme: SummaryTheme = { fg: (c, t) => `<${c}:${t}>`, bold: (t) => t };
const plain: SummaryTheme = { fg: (_c, t) => t, bold: (t) => t };
const home = os.homedir();

const base: Summary = {
	dir: path.join(home, "dev"),
	files: [path.join(home, ".pi", "agent", "permissions.json")],
	position: "editor",
	commands: { "git status *": "yes-i-am-very-sure", "git push *": "ask", "sudo *": "halt" },
	paths: { "~/.ssh/**": "deny" },
	tools: {},
	readonly: true,
	codemode: false,
	grants: [],
	disabled: [],
	errors: [],
};

describe("renderSummary", () => {
	it("colors rules by meaning, the allow phrase as a warning", () => {
		const text = renderSummary(base, theme).join("\n");
		assert.ok(text.includes("<warning:yes-i-am-very-sure>"));
		assert.ok(text.includes("<accent:ask>"));
		assert.ok(text.includes("<error:deny>"));
		assert.ok(text.includes("<error:halt>"));
	});

	it("states that anything without a rule asks, and whether reads run", () => {
		const text = renderSummary(base, plain).join("\n");
		assert.ok(text.includes("No rule   asks"));
		assert.ok(text.includes("Codemode  asks"));
		assert.ok(
			renderSummary({ ...base, codemode: true }, plain)
				.join("\n")
				.includes("Codemode  runs, each tool it calls is checked"),
		);
		assert.ok(text.includes("Read-only on, reading inside the project runs"));
	});

	it("shows the on/off status", () => {
		assert.ok(renderSummary(base, theme)[0].includes("<success:● on>"));
		assert.ok(renderSummary({ ...base, off: "session" }, theme)[0].includes("<error:● off (this session)>"));
	});

	it("shortens the home directory", () => {
		const text = renderSummary(base, plain).join("\n");
		assert.ok(text.includes("~/dev"));
		assert.ok(text.includes("~/.pi/agent/permissions.json"));
		assert.ok(!text.includes(home + "/"));
	});

	it("aligns rule actions in a column", () => {
		const lines = renderSummary(base, plain);
		const rules = lines.filter((l) => l.startsWith("  git status *") || l.startsWith("  sudo *"));
		assert.equal(rules.length, 2);
		assert.equal(rules[0].indexOf("yes-i-am-very-sure"), rules[1].indexOf("halt"));
	});

	it("says none for empty sections and warns when no config file exists", () => {
		const text = renderSummary({ ...base, files: [] }, plain).join("\n");
		assert.ok(text.includes("Tool rules\n  none"));
		assert.ok(text.includes("none, defaults apply"));
	});

	it("neutralizes control characters from config values", () => {
		const text = renderSummary({ ...base, commands: { "evil\x1b[2J *": "deny" } }, plain).join("\n");
		assert.ok(!text.includes("\x1b"));
		assert.ok(text.includes("evil\u241b[2J *"));
	});

	it("ends with the full usage of every command, aligned", () => {
		const lines = renderSummary(base, plain);
		const start = lines.indexOf("Commands");
		const usage = lines.slice(start + 1);
		assert.equal(usage.length, COMMANDS.length);
		assert.ok(usage[0].startsWith("  /permissions "));
		assert.ok(usage.some((l) => l.startsWith("  /permissions off --session")));
		const column = usage.map((l, i) => l.indexOf(COMMANDS[i].description));
		assert.ok(column.every((c) => c === column[0]));
	});

	it("lists errors", () => {
		const text = renderSummary({ ...base, errors: ["bad file"] }, theme).join("\n");
		assert.ok(text.includes("<error:bad file>"));
	});
});
