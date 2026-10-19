import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { before, beforeEach, describe, it } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import type { JsonObject } from "../src/config.ts";
import type { PromptHost, PromptTheme } from "../src/prompt-ui.ts";
import type { Summary } from "../src/summary.ts";

// Isolate from the real ~/.pi: point HOME at a temp dir before loading the extension.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permissions-home-"));

process.env.HOME = home;

const agentDir = path.join(home, ".pi", "agent");
const configFile = path.join(agentDir, "permissions.json");
const stateFile = path.join(agentDir, "permissions-state.json");

fs.mkdirSync(path.join(home, "project"));

fs.mkdirSync(agentDir, { recursive: true });

// Resolved like the extension does (e.g. /tmp is a symlink on macOS).
const project = fs.realpathSync(path.join(home, "project"));

const baseConfig = {
	commands: { "git status *": "yes-i-am-very-sure", "sudo *": "deny", "rm -rf /*": "halt", "git push *": "ask" },
};

const writeConfig = (extra: JsonObject = {}) =>
	fs.writeFileSync(configFile, JSON.stringify({ ...baseConfig, ...extra }));

/** What the tool_call handler resolves with. */
interface ToolResult {
	block?: boolean;
	reason?: string;
}

interface ToolEvent {
	toolCallId: string;
	toolName: string;
	input: JsonObject;
}

/** A tool's output, as the tool_result handler sees and returns it. */
interface ResultContent {
	content: { type: "text"; text: string }[];
	structuredContent?: JsonObject;
}

type ResultHandler = (event: ResultContent & { toolCallId: string }) => ResultContent | undefined;

/** The prompt's answer: the chosen key, plus the text for MESSAGE and "tell pi". */
interface Answer {
	key: string;
	text?: string;
}

interface CustomOptions {
	overlay?: boolean;
}

type FakeContext = ReturnType<typeof ctx>;

type Handler = (event: ToolEvent | Record<string, never>, ctx: FakeContext) => Promise<ToolResult | undefined>;

type Factory = (
	host: PromptHost,
	theme: PromptTheme,
	keybindings: Record<string, never>,
	done: (answer: Answer) => void,
) => Component;

type EntryRenderer = (
	entry: { data?: Summary },
	options: { expanded: boolean },
	theme: PromptTheme,
) => Component | undefined;

interface Command {
	handler: (args: string, ctx: FakeContext) => Promise<void>;
	getArgumentCompletions: (prefix: string) => { value: string }[];
}

const handlers = new Map<string, Handler>();
const resultHandlers = new Map<string, ResultHandler>();
const commands = new Map<string, Command>();
const renderers = new Map<string, EntryRenderer>();
const entries: { type: string; data: Summary }[] = [];
const theme: PromptTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t };

function registered<T>(map: Map<string, T>, name: string): T {
	const value = map.get(name);

	assert.ok(value, `${name} is registered`);

	return value;
}

before(async () => {
	const { default: extension } = await import("../src/index.ts");

	const fakePi = {
		on: (name: string, handler: Handler & ResultHandler) => {
			handlers.set(name, handler);
			resultHandlers.set(name, handler);
		},
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		registerEntryRenderer: (type: string, renderer: EntryRenderer) => renderers.set(type, renderer),
		appendEntry: (type: string, data: Summary) => entries.push({ type, data }),
	};

	// SAFETY: the fake implements every ExtensionAPI member the extension calls; anything else it touched would throw and fail the tests.
	extension(fakePi as never);
});

const startSession = () => registered(handlers, "session_start")({}, ctx());

beforeEach(async () => {
	writeConfig();
	fs.rmSync(stateFile, { force: true });
	await startSession(); // clears session state
});

interface FakeCtxOptions {
	mode?: string;
	hasUI?: boolean;
	key?: string;
	/** Keys sent in order (e.g. "t", typed text, Enter). */
	keys?: string[];
	/** What ui.input() returns in non-TUI mode. */
	inputText?: string;
	selectIndex?: number;
	signal?: AbortSignal;
	confirm?: boolean;
	onCustom?: (options: CustomOptions | undefined) => void;
}

const status = new Map<string, string | undefined>();
const notes: string[] = [];

function ctx({
	mode = "tui",
	hasUI = true,
	key,
	keys,
	inputText,
	selectIndex = 0,
	signal,
	confirm = true,
	onCustom,
}: FakeCtxOptions = {}) {
	return {
		mode,
		hasUI,
		cwd: project,
		signal,
		isProjectTrusted: () => false,
		ui: {
			theme,
			notify: (msg: string) => notes.push(msg),
			setStatus: (k: string, v: string | undefined) => status.set(k, v),
			confirm: async () => confirm,
			select: async (_title: string, options: string[]) => options[selectIndex],
			input: async () => inputText,
			custom: (factory: Factory, options?: CustomOptions) =>
				new Promise<Answer>((resolve) => {
					onCustom?.(options);
					const component = factory({ terminal: { rows: 30 }, requestRender() {} }, theme, {}, resolve);

					component.render(80);

					for (const k of [...(key ? [key] : []), ...(keys ?? [])]) component.handleInput?.(k);
				}),
		},
	};
}

const call = (toolName: string, input: JsonObject, c = ctx(), toolCallId = "call-1") =>
	registered(handlers, "tool_call")({ toolCallId, toolName, input }, c);

/** Runs the tool_result handler on a fake output of call `toolCallId`. */
const result = (toolCallId = "call-1") =>
	registered(
		resultHandlers,
		"tool_result",
	)({
		toolCallId,
		content: [{ type: "text", text: "output" }],
		structuredContent: { ok: true },
	});

const bash = (command: string, c = ctx()) => call("bash", { command }, c);
const blocked = (result: ToolResult | undefined) => result?.block === true;
const run = (args: string, c = ctx()) => registered(commands, "permissions").handler(args, c);

const lastCard = () => {
	const entry = entries.at(-1);

	assert.ok(entry, "a card was added");

	return entry;
};

describe("tool calls", () => {
	it("passes allowed calls without prompting", async () => {
		assert.equal(await bash("git status", ctx({ key: "n" })), undefined);
	});

	it("blocks denied calls without prompting", async () => {
		assert.ok(blocked(await bash("sudo ls", ctx({ key: "y" }))));
	});

	it("halts: blocks, alerts the user and tells the agent it is a config rule", async () => {
		const result = await bash("rm -rf /", ctx({ key: "y" }));
		assert.ok(blocked(result));
		assert.match(result?.reason ?? "", /^Halted: the user's permission config sets this to halt/);
		assert.ok(
			notes.at(-1)?.startsWith("\u{1F6D1} Halted: bash tried something set to halt in your permissions config"),
		);
	});

	it("an ask rule asks even with a stfu grant", async () => {
		assert.equal(await bash("make stfu", ctx({ key: "d" })), undefined);
		assert.equal(await bash("make covered", ctx({ key: "n" })), undefined);
		assert.ok(blocked(await bash("git push", ctx({ key: "n" }))));
	});

	it("reports a config in the old format", async () => {
		writeConfig({ default: "ask", bash: { "*": "ask" } });
		await bash("make old", ctx({ key: "y" }));
		assert.ok(notes.some((n) => n.includes("default, bash: old format")));
	});

	it("runs on Yes and blocks on No", async () => {
		assert.equal(await bash("make a", ctx({ key: "y" })), undefined);
		assert.ok(blocked(await bash("make b", ctx({ key: "n" }))));
	});

	it("[a] gives total access to the folder the command runs in, deny rules still apply", async () => {
		assert.equal(await bash("make c", ctx({ key: "a" })), undefined);
		assert.equal(await bash("touch x && make other", ctx({ key: "n" })), undefined);
		assert.ok(blocked(await bash("sudo ls", ctx({ key: "n" }))));
		assert.ok(blocked(await bash(`cd ${home} && ls -la`, ctx({ key: "n" }))), "the cd leaves the folder");
	});

	it("denies when the agent run is aborted while prompting", async () => {
		const controller = new AbortController();
		const pending = bash("make d", ctx({ signal: controller.signal }));
		controller.abort();
		assert.ok(blocked(await pending));
	});

	it("blocks 'ask' calls when there is no UI", async () => {
		assert.ok(blocked(await bash("make e", ctx({ hasUI: false }))));
	});

	it("falls back to select() outside the TUI", async () => {
		assert.equal(await bash("make f", ctx({ mode: "rpc" })), undefined);
	});

	it("protects the state file", async () => {
		writeConfig({ paths: { "/**": "yes-i-am-very-sure" }, tools: { "*": "yes-i-am-very-sure" } });
		assert.ok(blocked(await call("write", { path: stateFile, content: "{}" }, ctx({ key: "n" }))));
	});
});

describe("prompt position", () => {
	it("replaces the editor by default (no overlay)", async () => {
		let options: CustomOptions | undefined | "unset" = "unset";
		await bash("make g", ctx({ key: "y", onCustom: (o) => (options = o) }));
		assert.equal(options, undefined);
	});

	it("uses an overlay for center and top", async () => {
		for (const position of ["center", "top"]) {
			writeConfig({ ui: { position } });
			let options: CustomOptions | undefined;
			await bash(`make ${position}`, ctx({ key: "y", onCustom: (o) => (options = o) }));
			assert.equal(options?.overlay, true, position);
		}
	});
});

describe("/permissions off | on", () => {
	it("persists 'off' and runs everything without prompting, even denied calls", async () => {
		await run("off");
		assert.ok(JSON.parse(fs.readFileSync(stateFile, "utf8")).disabled[project]);
		assert.equal(await bash("sudo ls", ctx({ key: "n" })), undefined);
		assert.equal(await bash("make x", ctx({ key: "n" })), undefined);
		assert.match(status.get("permissions") ?? "", /permissions off$/);
	});

	it("survives a new session when persistent", async () => {
		await run("off");
		await startSession();
		assert.equal(await bash("sudo ls", ctx({ key: "n" })), undefined);
	});

	it("'off --session' is not persisted and ends with the session", async () => {
		await run("off --session");
		assert.equal(fs.existsSync(stateFile), false);
		assert.equal(await bash("sudo ls", ctx({ key: "n" })), undefined);
		assert.match(status.get("permissions") ?? "", /\(session\)/);
		await startSession();
		assert.ok(blocked(await bash("sudo ls", ctx({ key: "n" }))));
	});

	it("does nothing when the confirmation is declined", async () => {
		await run("off", ctx({ confirm: false }));
		assert.equal(fs.existsSync(stateFile), false);
		assert.ok(blocked(await bash("sudo ls", ctx({ key: "n" }))));
	});

	it("'on' re-enables and clears the status", async () => {
		await run("off");
		await run("on");
		assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")).disabled, {});
		assert.ok(blocked(await bash("sudo ls", ctx({ key: "n" }))));
		assert.equal(status.get("permissions"), undefined);
	});

	it("rejects unknown arguments", async () => {
		const before = notes.length;
		await run("off --forever");
		assert.match(notes.at(-1) ?? "", /^Usage/);
		assert.equal(notes.length, before + 1);
		assert.equal(fs.existsSync(stateFile), false);
	});

	it("/permissions adds a summary card that renders", async () => {
		await run("off --session");
		await run("");
		const entry = lastCard();
		assert.equal(entry.type, "pi-permissions-summary");
		assert.equal(entry.data.off, "session");
		const component = registered(renderers, "pi-permissions-summary")(entry, { expanded: false }, theme);
		assert.ok(component, "the card renders");
		const text = component.render(80).join("\n");
		assert.match(text, /pi-permissions/);
		assert.match(text, /off \(this session\)/);
		assert.match(text, /git status \*\s+yes-i-am-very-sure/);
	});

	it("completes subcommands", () => {
		assert.deepEqual(
			registered(commands, "permissions")
				.getArgumentCompletions("of")
				.map((i) => i.value),
			["off", "off --session"],
		);
	});
});

describe("always grants", () => {
	const clipboard = path.join(home, "outside", "soloterm-clipboard");
	fs.mkdirSync(path.join(clipboard, "nested"), { recursive: true });
	const shot = (name: string) => path.join(clipboard, name);
	const read = (p: string, c = ctx()) => call("read", { path: p }, c);

	it("[a] on one screenshot allows the next ones in the same directory", async () => {
		assert.equal(await read(shot("paste-1.png"), ctx({ key: "a" })), undefined);
		assert.equal(await read(shot("paste-2.png"), ctx({ key: "n" })), undefined);
		assert.ok(blocked(await read(shot("nested/paste-3.png"), ctx({ key: "n" }))));
	});

	it("[d] also allows subfolders", async () => {
		assert.equal(await read(shot("paste-1.png"), ctx({ key: "d" })), undefined);
		assert.equal(await read(shot("nested/paste-3.png"), ctx({ key: "n" })), undefined);
	});

	it("total access covers every tool in the folder, bash included", async () => {
		const edit = (p: string, key: string) => call("edit", { path: p, edits: [] }, ctx({ key }));
		assert.equal(await edit(path.join(project, "a.ts"), "a"), undefined);
		assert.equal(await edit(path.join(project, "b.ts"), "n"), undefined);
		assert.equal(await call("write", { path: path.join(project, "c.ts"), content: "" }, ctx({ key: "n" })), undefined);
		assert.equal(await bash("rm c.ts", ctx({ key: "n" })), undefined);
		assert.ok(blocked(await edit(path.join(project, "sub", "d.ts"), "n")), "[a] is not recursive");
	});

	it("shows active stfu grants in the status bar until reset", async () => {
		await read(shot("paste-1.png"), ctx({ key: "d" }));
		assert.ok(status.get("permissions-stfu")?.endsWith(`stfu pi on ${clipboard.replace(home, "~")}/**`));
		await run("reset");
		assert.equal(status.get("permissions-stfu"), undefined);
	});

	it("shows grants explicitly in the /permissions card", async () => {
		await read(shot("paste-1.png"), ctx({ key: "a" }));
		await run("");
		const { grants } = lastCard().data;
		assert.deepEqual(grants, [`stfu pi on ${clipboard.replace(home, "~")}/`]);
	});
});

describe("symlinks", () => {
	it("shows both paths in the prompt and grants the real directory", async () => {
		const real = path.join(home, "usr-lib");
		const etc = path.join(home, "etc-link");
		fs.mkdirSync(real);
		fs.mkdirSync(etc);
		fs.writeFileSync(path.join(real, "os-release"), "x");
		fs.symlinkSync(path.join(real, "os-release"), path.join(etc, "os-release"));

		let rendered = "";
		const c = ctx({ key: "a" });
		const custom = c.ui.custom;
		c.ui.custom = (factory, options) =>
			custom((host, th, kb, done) => {
				const component = factory(host, th, kb, done);
				rendered = component.render(200).join("\n");

				return component;
			}, options);
		assert.equal(await call("read", { path: path.join(etc, "os-release") }, c), undefined);
		assert.ok(rendered.includes(`${path.join(etc, "os-release")} → ${path.join(real, "os-release")} (symlink)`));
		assert.ok(rendered.includes("usr-lib/"), "the grant label names the real directory");

		await run("");
		const { grants } = lastCard().data;
		assert.ok(grants.includes(`stfu pi on ${real.replace(home, "~")}/`));
	});
});

describe("tell pi what to do", () => {
	const reason = (result: ToolResult | undefined) => result?.reason ?? "";

	it("blocks and passes the instructions to the agent", async () => {
		const result = await bash("rm -rf build", ctx({ keys: ["t", ..."use make clean instead", "\r"] }));
		assert.ok(blocked(result));
		assert.match(reason(result), /gave instructions instead:\nuse make clean instead\n/);
	});

	it("is a plain denial when the message is empty", async () => {
		const result = await bash("rm -rf build", ctx({ keys: ["t", "\r"] }));
		assert.match(reason(result), /ask the user how to proceed/);
	});

	it("works without the TUI through ui.input()", async () => {
		const tell = ctx({ mode: "rpc", selectIndex: 3, inputText: "  try git stash  " });
		assert.match(reason(await bash("git reset --hard", tell)), /instead:\ntry git stash\n/);
		const empty = ctx({ mode: "rpc", selectIndex: 3, inputText: "" });
		assert.match(reason(await bash("git reset --hard", empty)), /ask the user how to proceed/);
	});
});

describe("yes, with a message", () => {
	it("allows the call and appends the message to its result, once", async () => {
		assert.equal(await bash("rm -rf build", ctx({ keys: ["m", ..."also clean dist", "\r"] })), undefined);
		const changed = result();
		assert.deepEqual(
			changed?.content.map((c) => c.text),
			["output", "The user approved this tool call and added a message:\nalso clean dist"],
		);
		assert.deepEqual(changed?.structuredContent, { ok: true }, "structured output is kept");
		assert.equal(result(), undefined, "the message is delivered once");
	});

	it("only touches the result of the approved call", async () => {
		await bash("rm -rf build", ctx({ keys: ["m", ..."note", "\r"] }));
		assert.equal(result("other-call"), undefined);
	});

	it("is a plain Yes when the message is empty", async () => {
		assert.equal(await bash("rm -rf build", ctx({ keys: ["m", "\r"] })), undefined);
		assert.equal(result(), undefined);
	});

	it("is forgotten when the agent run ends", async () => {
		await bash("rm -rf build", ctx({ keys: ["m", ..."note", "\r"] }));
		await registered(handlers, "agent_end")({}, ctx());
		assert.equal(result(), undefined);
	});

	it("works without the TUI through ui.input()", async () => {
		assert.equal(await bash("rm -rf build", ctx({ mode: "rpc", selectIndex: 1, inputText: " note " })), undefined);
		assert.match(result()?.content.at(-1)?.text ?? "", /message:\nnote$/);
	});
});

describe("input that is not JSON", () => {
	it("is blocked, because it cannot be inspected", async () => {
		const result = await call("mcp__x__tool", { count: Number.NaN }, ctx({ key: "y" }));

		assert.ok(blocked(result));
		assert.match(result?.reason ?? "", /could not inspect/);
	});
});
