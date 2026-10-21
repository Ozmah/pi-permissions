/**
 * pi-permissions: allow / ask / deny rules for Pi tool calls.
 *
 * Config: ~/.pi/agent/permissions.json, plus <project>/.pi/permissions.json when
 * the project is trusted (overrides the global file key by key).
 * Opt-out state: ~/.pi/agent/permissions-state.json.
 */
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { type BodyDeps, buildBody, plainBody } from "./body.ts";
import { describedBash } from "./describe.ts";
import {
	type PermissionConfig,
	type PromptPosition,
	defaultConfig,
	errorMessage,
	isJson,
	isJsonObject,
	mergeConfigs,
	readConfigFile,
} from "./config.ts";
import { type MarkdownTheme, highlightMarkdown } from "./markdown.ts";
import { type Reason, decide, formatReason, needsDecision, resolvePath } from "./policy.ts";
import {
	type CallTarget,
	type Grant,
	type GrantChoice,
	describeGrant,
	grantChoices,
	grantMatches,
	shortPath,
	whyNotCovered,
} from "./grants.ts";
import { BASE_CHOICES, type BodyLine, MESSAGE, NO, PermissionPrompt, TELL, inputSpec } from "./prompt-ui.ts";
import { readState, setDisabled, writeState } from "./state.ts";
import { COMMANDS, SUMMARY_ENTRY, type Summary, renderSummary } from "./summary.ts";
import { sanitize } from "./text.ts";

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const GLOBAL_CONFIG = path.join(AGENT_DIR, "permissions.json");
const STATE_FILE = path.join(AGENT_DIR, "permissions-state.json");
const PROJECT_CONFIG = path.join(".pi", "permissions.json");

/** Package root (parent of src/), protected from writes like the config files. */
const EXTENSION_ROOT = packageRoot();

/** Max body lines in the plain select() fallback used by non-TUI clients. */
const FALLBACK_MAX_LINES = 40;

const STATUS_KEY = "permissions";

/** Separate from STATUS_KEY: "stfu" grants and "off" can show at the same time. */
const STFU_STATUS_KEY = "permissions-stfu";

const UNINSPECTABLE = "pi-permissions could not inspect this tool call: its input is not JSON.";

const HALTED_REASON =
	"Halted: the user's permission config sets this to halt, and the user has been alerted. Do not retry it or work around it.";

const DENIED_REASON = "The user denied this action. Do not retry it; ask the user how to proceed.";

const approvedMessage = (text: string) => `The user approved this tool call and added a message:\n${text}`;

const toldReason = (text: string) =>
	`The user denied this action and gave instructions instead:\n${text}\nFollow these instructions instead of retrying the same action.`;

const USAGE = "Usage: /permissions [reset | stfu [folder] | off [--session] | on]";

/** Pi's highlighter for code; Markdown uses Pi's `md*` colors, with fenced blocks back to Pi's highlighter. */
function bodyDeps(theme: MarkdownTheme): BodyDeps {
	const code = (text: string, lang: string) => highlightCode(text, lang);

	return {
		highlight: (text, lang) => (lang === "markdown" ? highlightMarkdown(text, theme, code) : code(text, lang)),
		languageOf: getLanguageFromPath,
	};
}

function packageRoot(): string | undefined {
	try {
		return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	} catch {
		return undefined; // loader without a file: URL; config files stay protected
	}
}

interface LoadedConfig {
	cfg: PermissionConfig;
	files: string[];
	errors: string[];
}

function loadConfig(cwd: string, trusted: boolean): LoadedConfig {
	const errors: string[] = [];
	const files: string[] = [];
	const layers = [];
	const candidates = trusted ? [GLOBAL_CONFIG, path.join(cwd, PROJECT_CONFIG)] : [GLOBAL_CONFIG];

	for (const file of candidates) {
		try {
			const layer = readConfigFile(file, errors);

			if (layer) {
				layers.push(layer);
				files.push(file);
			}
		} catch (e) {
			// Unreadable or invalid JSON: ignore all files, so every call asks.
			errors.push(`${file}: ${errorMessage(e)}`);

			return { cfg: defaultConfig(), files, errors };
		}
	}

	return { cfg: mergeConfigs(...layers), files, errors };
}

function projectDir(ctx: ExtensionContext): string {
	return resolvePath(ctx.cwd, ctx.cwd);
}

export default function (pi: ExtensionAPI) {
	// Registered at load, from the global config only, so Pi can report a conflict
	// with another extension that also replaces `bash`. Turning it on or off needs /reload.
	if (loadConfig(process.cwd(), false).cfg.ui.describe_commands) pi.registerTool(describedBash(process.cwd()));

	/** Grants from the "Always" options. In memory, cleared with the session. */
	let sessionGrants: Grant[] = [];
	/** Projects disabled with `/permissions off --session`. */
	const sessionOff = new Set<string>();
	let lastErrors = "";

	function notifyErrors(ctx: ExtensionContext, errors: string[]): void {
		const text = errors.join("\n");

		if (!text || text === lastErrors || !ctx.hasUI) return;
		lastErrors = text;
		ctx.ui.notify(sanitize(`permissions: configuration errors\n${text}`), "warning");
	}

	/** "session", "persistent", or undefined when the extension is active for `dir`. */
	function offMode(dir: string, errors: string[]): "session" | "persistent" | undefined {
		if (sessionOff.has(dir)) return "session";

		return readState(STATE_FILE, errors).disabled[dir] ? "persistent" : undefined;
	}

	function updateStatus(ctx: ExtensionContext, mode: "session" | "persistent" | undefined): void {
		if (!ctx.hasUI) return;
		const label = mode === "session" ? "⚠ permissions off (session)" : "⚠ permissions off";
		ctx.ui.setStatus(STATUS_KEY, mode ? ctx.ui.theme.fg("warning", label) : undefined);
	}

	/** Folders under "stfu pi", always on screen so a grant given hours ago is not forgotten. */
	function updateStfuStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		const folders = sessionGrants.flatMap((g) =>
			g.kind === "access" ? [`${shortPath(g.dir)}/${g.recursive ? "**" : ""}`] : [],
		);

		const label = `🤫 stfu pi on ${folders.join(", ")}`;
		ctx.ui.setStatus(STFU_STATUS_KEY, folders.length ? ctx.ui.theme.fg("warning", label) : undefined);
	}

	// The /permissions card: kept in the transcript, never sent to the model.
	pi.registerEntryRenderer<Summary>(SUMMARY_ENTRY, (entry, _options, theme) => {
		if (!entry.data) return undefined;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(renderSummary(entry.data, theme).join("\n"), 0, 0));

		return box;
	});

	/** Messages from "Yes, with a message", by tool call id, until the call's result arrives. */
	const messages = new Map<string, string>();
	/** Tool name by call id, so a call made from a script (codemode) can say which tool issued it. */
	const callNames = new Map<string, string>();

	pi.on("session_start", async (_event, ctx) => {
		sessionGrants = [];
		messages.clear();
		callNames.clear();
		sessionOff.clear();
		const errors: string[] = [];
		updateStatus(ctx, offMode(projectDir(ctx), errors));
		updateStfuStatus(ctx);
		notifyErrors(ctx, errors);
	});

	pi.on("tool_result", (event) => {
		const text = messages.get(event.toolCallId);

		if (text === undefined) return undefined;
		messages.delete(event.toolCallId);

		// Replacing content drops structuredContent unless it is passed along.
		return {
			content: [...event.content, { type: "text", text: approvedMessage(text) }],
			structuredContent: event.structuredContent,
		};
	});

	// A call blocked after approval (e.g. by another extension) never reaches tool_result.
	pi.on("agent_end", () => {
		messages.clear();
		callNames.clear();
	});

	pi.on("tool_call", async (event, ctx) => {
		callNames.set(event.toolCallId, event.toolName);
		const cwd = projectDir(ctx);
		const errors: string[] = [];

		const off = offMode(cwd, errors);
		updateStatus(ctx, off);

		if (off) return undefined; // classic Pi: no checks at all

		const { cfg, errors: configErrors } = loadConfig(cwd, ctx.isProjectTrusted());
		notifyErrors(ctx, [...errors, ...configErrors]);

		// Tool arguments are JSON from the model; anything else cannot be inspected, so it is blocked.
		const raw = event.input;
		const input = isJson(raw) && isJsonObject(raw) ? raw : undefined;

		if (!input) {
			if (ctx.hasUI) ctx.ui.notify(sanitize(`⛔ Blocked: ${event.toolName}\n${UNINSPECTABLE}`), "warning");

			return { block: true, reason: UNINSPECTABLE };
		}

		const protectedPaths = [GLOBAL_CONFIG, STATE_FILE, path.join(cwd, PROJECT_CONFIG)];

		if (EXTENSION_ROOT) protectedPaths.push(EXTENSION_ROOT);
		const d = decide(cfg, event.toolName, input, { cwd, protectedPaths, cdpath: process.env.CDPATH });

		if (d.action === "allow") return undefined;

		// Only what was not allowed: the agent needs to know which part was refused, not what passed.
		const why = d.reasons.filter(needsDecision).map(formatReason).join("\n");

		if (d.action === "halt") {
			// A deny the user wants to hear about: something tried what the config says must never run.
			if (ctx.hasUI)
				ctx.ui.notify(
					sanitize(`🛑 Halted: ${event.toolName} tried something set to halt in your permissions config\n${why}`),
					"error",
				);

			return { block: true, reason: `${HALTED_REASON}\n${why}` };
		}

		if (d.action === "deny") {
			if (ctx.hasUI) ctx.ui.notify(sanitize(`⛔ Blocked: ${event.toolName}\n${why}`), "warning");

			return { block: true, reason: `Blocked by permission policy:\n${why}` };
		}

		const target: CallTarget = {
			tool: event.toolName,
			input,
			absPath: d.absPath,
			dirs: d.workingDirs,
			firm: d.firm,
		};

		if (sessionGrants.some((g) => grantMatches(g, target))) return undefined;

		if (!ctx.hasUI) return { block: true, reason: `Requires confirmation but no UI is available:\n${why}` };

		// An active grant that touches this call but does not cover it is said first: it explains why it still asks.
		const uncovered: Reason[] = sessionGrants.flatMap((g) => {
			const reason = whyNotCovered(g, target);

			return reason ? [{ kind: "uncovered", subject: describeGrant(g), why: reason }] : [];
		});

		const reasons = [...uncovered, ...d.reasons];
		const body = buildBody(event.toolName, input, d.absPath, reasons, bodyDeps(ctx.ui.theme), d.requestedPath);
		const choices = grantChoices(target);
		const parent = event.parentToolCallId && (callNames.get(event.parentToolCallId) ?? "another tool");
		const title = `🔐 ${event.toolName} requires permission${parent ? ` (called by ${parent})` : ""}`;
		const choice = await ask(ctx, title, body, cfg.ui.position, choices);

		if (choice.key === NO.key) return { block: true, reason: DENIED_REASON };

		if (choice.key === TELL.key) return { block: true, reason: toldReason(choice.text ?? "") };

		if (choice.key === MESSAGE.key) {
			if (choice.text) messages.set(event.toolCallId, choice.text);

			return undefined;
		}

		const granted = choices.find((c) => c.key === choice.key)?.grant;

		if (granted) {
			sessionGrants.push(granted);
			updateStfuStatus(ctx);
		}

		return undefined;
	});

	async function turnOff(ctx: ExtensionContext, dir: string, sessionOnly: boolean): Promise<void> {
		const scope = sessionOnly ? "until this session ends" : "until you run /permissions on";

		const ok = await ctx.ui.confirm(
			"Disable pi-permissions for this project?",
			`${dir}\n\nEvery tool call will run without asking, like Pi without this extension, ${scope}.`,
		);

		if (!ok) return;

		if (sessionOnly) {
			sessionOff.add(dir);
		} else {
			const errors: string[] = [];
			writeState(STATE_FILE, setDisabled(readState(STATE_FILE, errors), dir, true));
		}

		updateStatus(ctx, sessionOnly ? "session" : "persistent");
		ctx.ui.notify(`pi-permissions disabled for ${dir} ${scope}`, "warning");
	}

	function turnOn(ctx: ExtensionContext, dir: string): void {
		sessionOff.delete(dir);
		const errors: string[] = [];
		const state = readState(STATE_FILE, errors);

		if (state.disabled[dir]) writeState(STATE_FILE, setDisabled(state, dir, false));
		updateStatus(ctx, undefined);
		ctx.ui.notify(`pi-permissions enabled for ${dir}`, "info");
	}

	/**
	 * Removes session grants: the ones on `folder` when given (`~` and the
	 * shortened `…/` form are accepted), otherwise the one picked from a list.
	 */
	async function revoke(ctx: ExtensionContext, folder: string, cwd: string): Promise<void> {
		if (!sessionGrants.length) {
			ctx.ui.notify("No session grants", "info");

			return;
		}

		let removed: Grant[];

		if (folder) {
			const wanted = resolvePath(folder, cwd);
			removed = sessionGrants.filter((g) => g.kind === "access" && (g.dir === wanted || shortPath(g.dir) === folder));
		} else {
			const labels = sessionGrants.map((g) => sanitize(describeGrant(g)));
			const picked = await ctx.ui.select("Remove a session grant", labels);
			const grant = sessionGrants[labels.indexOf(picked ?? "")];
			removed = grant ? [grant] : [];
		}

		if (!removed.length) {
			if (folder) ctx.ui.notify(sanitize(`No session grant on ${folder}`), "warning");

			return;
		}

		sessionGrants = sessionGrants.filter((g) => !removed.includes(g));
		updateStfuStatus(ctx);
		ctx.ui.notify(sanitize(`Removed: ${removed.map(describeGrant).join(", ")}`), "info");
	}

	function show(ctx: ExtensionContext, dir: string): void {
		const errors: string[] = [];
		const off = offMode(dir, errors);
		const disabled = Object.keys(readState(STATE_FILE, errors).disabled);
		const { cfg, files, errors: configErrors } = loadConfig(dir, ctx.isProjectTrusted());

		const summary: Summary = {
			dir,
			off,
			files,
			position: cfg.ui.position,
			commands: cfg.commands,
			paths: cfg.paths,
			tools: cfg.tools,
			readonly: cfg.readonly,
			codemode: cfg.codemode,
			grants: sessionGrants.map(describeGrant),
			disabled,
			errors: [...errors, ...configErrors],
		};

		pi.appendEntry<Summary>(SUMMARY_ENTRY, summary);
	}

	pi.registerCommand("permissions", {
		description: "Show permission config; reset grants; turn off/on for this project",
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trim();
			const options = COMMANDS.flatMap((c) => (c.args ? [{ value: c.args, description: c.description }] : []));

			// `stfu <folder>`: complete with the folders that have a grant.
			for (const g of sessionGrants) {
				const value = g.kind === "access" ? `stfu ${shortPath(g.dir)}` : undefined;

				if (value && !options.some((o) => o.value === value)) {
					options.push({ value, description: "Remove the grants on this folder" });
				}
			}

			return options.flatMap((o) =>
				o.value.startsWith(typed) ? [{ value: o.value, label: o.value, description: o.description }] : [],
			);
		},
		handler: async (args, ctx) => {
			const dir = projectDir(ctx);
			const [sub = "", ...flags] = args.trim().split(/\s+/).filter(Boolean);

			try {
				if (sub === "" && flags.length === 0) show(ctx, dir);
				else if (sub === "reset" && flags.length === 0) {
					sessionGrants = [];
					updateStfuStatus(ctx);
					ctx.ui.notify("Session grants cleared", "info");
				} else if (sub === "stfu") {
					await revoke(ctx, flags.join(" "), dir);
				} else if (sub === "off" && (flags.length === 0 || (flags.length === 1 && flags[0] === "--session"))) {
					await turnOff(ctx, dir, flags.length === 1);
				} else if (sub === "on" && flags.length === 0) turnOn(ctx, dir);
				else ctx.ui.notify(USAGE, "warning");
			} catch (e) {
				ctx.ui.notify(`permissions: ${errorMessage(e)}`, "error");
			}
		},
	});
}

/** Where and how large the prompt is for each position. */
const LAYOUTS = {
	editor: { overlay: false, maxHeightRatio: 0.6 },
	center: {
		overlay: true,
		maxHeightRatio: 0.85,
		overlayOptions: { width: "90%", minWidth: 40, maxHeight: "85%", anchor: "center" },
	},
	top: {
		overlay: true,
		maxHeightRatio: 0.85,
		overlayOptions: { width: "100%", maxHeight: "85%", anchor: "top-center" },
	},
} as const;

/** The chosen option's key (a base choice or a grant's key), plus the text for MESSAGE and TELL. */
interface Answer {
	key: string;
	text?: string;
}

const DENY: Answer = { key: NO.key };

async function ask(
	ctx: ExtensionContext,
	title: string,
	body: BodyLine[],
	position: PromptPosition,
	choices: GrantChoice[],
): Promise<Answer> {
	if (ctx.mode !== "tui") {
		const options = [...BASE_CHOICES, ...choices];
		const labels = options.map((o) => sanitize(o.label));
		const picked = await ctx.ui.select(sanitize(`${title}\n\n${plainBody(body, FALLBACK_MAX_LINES)}`), labels);
		const key = options[labels.indexOf(picked ?? "")]?.key ?? NO.key;
		const spec = inputSpec(key);

		if (!spec) return { key };
		const text = (await ctx.ui.input(spec.title, spec.placeholder))?.trim();

		// A dismissed input (undefined) is a denial; empty text is the plain answer.
		if (text === undefined) return DENY;

		return text ? { key, text } : { key: spec.empty };
	}

	const signal = ctx.signal;

	if (signal?.aborted) return DENY;
	const layout = LAYOUTS[position];

	return ctx.ui.custom<Answer>(
		(tui, theme, _keybindings, done) => {
			let finished = false;

			const finish = (key: string, text?: string) => {
				if (finished) return;
				finished = true;
				signal?.removeEventListener("abort", onAbort);
				done(text === undefined ? { key } : { key, text });
			};

			// An aborted agent run closes the prompt as a denial.
			const onAbort = () => finish(NO.key);
			signal?.addEventListener("abort", onAbort, { once: true });
			const options = { maxHeightRatio: layout.maxHeightRatio, choices };

			return new PermissionPrompt(tui, theme, title, body, options, finish);
		},
		layout.overlay ? { overlay: true, overlayOptions: layout.overlayOptions } : undefined,
	);
}
