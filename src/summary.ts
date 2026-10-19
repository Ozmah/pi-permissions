/**
 * The `/permissions` summary card: a snapshot rendered with theme colors.
 */
import * as os from "node:os";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Rule, RuleMap } from "./config.ts";
import { RULE_COLOR } from "./prompt-ui.ts";
import { sanitize } from "./text.ts";

export const SUMMARY_ENTRY = "pi-permissions-summary";

/** `/permissions` subcommands: one list for the card and for argument completion. */
export const COMMANDS: readonly { args: string; description: string }[] = [
	{ args: "", description: "Show this summary" },
	{ args: "reset", description: "Clear session grants (stfu pi)" },
	{ args: "off", description: "Disable for this project (persistent)" },
	{ args: "off --session", description: "Disable for this project until the session ends" },
	{ args: "on", description: "Enable for this project" },
];

/** Plain data stored in the session entry; colors are applied at render time. */
export interface Summary {
	dir: string;
	off?: "session" | "persistent";
	files: string[];
	position: string;
	commands: RuleMap;
	paths: RuleMap;
	tools: RuleMap;
	/** Reading inside the project runs without asking. */
	readonly: boolean;
	grants: string[];
	disabled: string[];
	errors: string[];
}

export type SummaryTheme = Pick<Theme, "fg" | "bold">;

const LABEL_WIDTH = 10;

/** Shortens the home directory to `~` and neutralizes control characters. */
function display(text: string): string {
	const home = os.homedir();
	const short = text === home || text.startsWith(`${home}/`) ? `~${text.slice(home.length)}` : text;

	return sanitize(short);
}

function pad(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

export function renderSummary(s: Summary, t: SummaryTheme): string[] {
	const label = (text: string) => t.fg("muted", pad(text, LABEL_WIDTH));
	const none = t.fg("dim", "none");
	const rule = (r: Rule) => t.fg(RULE_COLOR[r], r);
	const heading = (text: string) => t.bold(t.fg("accent", text));

	const status = s.off
		? t.bold(t.fg("error", s.off === "session" ? "● off (this session)" : "● off"))
		: t.bold(t.fg("success", "● on"));

	const lines = [`${heading("pi-permissions")}  ${status}  ${t.fg("dim", display(s.dir))}`, ""];

	if (s.off) {
		lines.push(t.fg("warning", "Tool calls run without checks in this directory. /permissions on to enable."), "");
	}

	const files = s.files.length ? s.files.map(display) : [];
	lines.push(`${label("Config")}${files[0] ?? t.fg("warning", "none, defaults apply")}`);

	for (const f of files.slice(1)) lines.push(`${" ".repeat(LABEL_WIDTH)}${f}`);
	lines.push(`${label("Prompt")}${s.position}`);
	lines.push(
		`${label("Read-only")}${s.readonly ? t.fg("success", "on, reading inside the project runs") : t.fg("dim", "off")}`,
	);
	lines.push(`${label("No rule")}${t.fg("warning", "asks")}`);

	const section = (title: string, rules: RuleMap) => {
		lines.push("", heading(title));
		const entries = Object.entries(rules);

		if (!entries.length) {
			lines.push(`  ${none}`);

			return;
		}

		const width = Math.max(...entries.map(([p]) => visibleWidth(display(p)))) + 2;

		for (const [pattern, r] of entries) lines.push(`  ${pad(display(pattern), width)}${rule(r)}`);
	};

	section("Command rules", s.commands);
	section("Path rules", s.paths);
	section("Tool rules", s.tools);

	const list = (title: string, items: string[]) => {
		lines.push("", heading(title));

		if (!items.length) lines.push(`  ${none}`);

		for (const item of items) lines.push(`  ${display(item)}`);
	};

	list("Session grants", s.grants);
	list("Disabled projects", s.disabled);

	if (s.errors.length) {
		lines.push("", t.bold(t.fg("error", "Errors")));

		for (const e of s.errors) lines.push(`  ${t.fg("error", display(e))}`);
	}

	lines.push("", heading("Commands"));
	const usages = COMMANDS.map((c) => (c.args ? `/permissions ${c.args}` : "/permissions"));
	const width = Math.max(...usages.map((u) => u.length)) + 3;
	COMMANDS.forEach((c, i) => lines.push(`  ${t.fg("accent", pad(usages[i], width))}${t.fg("muted", c.description)}`));

	return lines;
}
