import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { before, beforeEach, describe, it } from "node:test";

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

const baseConfig = { tools: { read: "allow" }, bash: { "git status *": "allow", "sudo *": "deny", "*": "ask" } };
const writeConfig = (extra: object = {}) => fs.writeFileSync(configFile, JSON.stringify({ ...baseConfig, ...extra }));

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
interface Command {
	handler: (args: string, ctx: unknown) => Promise<void>;
	getArgumentCompletions: (prefix: string) => { value: string }[];
}
const handlers: Record<string, Handler> = {};
const commands: Record<string, Command> = {};
const renderers: Record<string, Function> = {};
const entries: { type: string; data: unknown }[] = [];
const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };

before(async () => {
	const { default: extension } = await import("../src/index.ts");
	extension({
		on: (name: string, handler: Handler) => {
			handlers[name] = handler;
		},
		registerCommand: (name: string, command: Command) => {
			commands[name] = command;
		},
		registerEntryRenderer: (type: string, renderer: Function) => {
			renderers[type] = renderer;
		},
		appendEntry: (type: string, data: unknown) => {
			entries.push({ type, data });
		},
	} as never);
});

beforeEach(async () => {
	writeConfig();
	fs.rmSync(stateFile, { force: true });
	await handlers.session_start({}, ctx()); // clears session state
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
	onCustom?: (options: unknown) => void;
}

const status: Record<string, string | undefined> = {};
const notes: string[] = [];

function ctx({ mode = "tui", hasUI = true, key, keys, inputText, selectIndex = 0, signal, confirm = true, onCustom }: FakeCtxOptions = {}) {
	return {
		mode,
		hasUI,
		cwd: project,
		signal,
		isProjectTrusted: () => false,
		ui: {
			theme,
			notify: (msg: string) => notes.push(msg),
			setStatus: (k: string, v: string | undefined) => {
				status[k] = v;
			},
			confirm: async () => confirm,
			select: async (_title: string, options: string[]) => options[selectIndex],
			input: async () => inputText,
			custom: (factory: Function, options: unknown) =>
				new Promise((resolve) => {
					onCustom?.(options);
					const component = factory({ terminal: { rows: 30 }, requestRender() {} }, theme, {}, resolve);
					component.render(80);
					if (key) component.handleInput(key);
					for (const k of keys ?? []) component.handleInput(k);
				}),
		},
	};
}

const call = (toolName: string, input: object, c = ctx()) => handlers.tool_call({ toolName, input }, c);
const bash = (command: string, c = ctx()) => call("bash", { command }, c);
const blocked = (result: unknown) => (result as { block?: boolean } | undefined)?.block === true;
const run = (args: string, c = ctx()) => commands.permissions.handler(args, c);

describe("tool calls", () => {
	it("passes allowed calls without prompting", async () => {
		assert.equal(await bash("git status", ctx({ key: "n" })), undefined);
	});

	it("blocks denied calls without prompting", async () => {
		assert.ok(blocked(await bash("sudo ls", ctx({ key: "y" }))));
	});

	it("runs on Yes and blocks on No", async () => {
		assert.equal(await bash("echo a", ctx({ key: "y" })), undefined);
		assert.ok(blocked(await bash("echo b", ctx({ key: "n" }))));
	});

	it("remembers 'always' for the exact command", async () => {
		assert.equal(await bash("echo c", ctx({ key: "a" })), undefined);
		assert.equal(await bash("echo c", ctx({ key: "n" })), undefined);
		assert.ok(blocked(await bash("echo c ", ctx({ key: "n" }))));
	});

	it("denies when the agent run is aborted while prompting", async () => {
		const controller = new AbortController();
		const pending = bash("echo d", ctx({ signal: controller.signal }));
		controller.abort();
		assert.ok(blocked(await pending));
	});

	it("blocks 'ask' calls when there is no UI", async () => {
		assert.ok(blocked(await bash("echo e", ctx({ hasUI: false }))));
	});

	it("falls back to select() outside the TUI", async () => {
		assert.equal(await bash("echo f", ctx({ mode: "rpc" })), undefined);
	});

	it("protects the state file", async () => {
		writeConfig({ default: "allow", tools: { "*": "allow" } });
		assert.ok(blocked(await call("write", { path: stateFile, content: "{}" }, ctx({ key: "n" }))));
	});
});

describe("prompt position", () => {
	it("replaces the editor by default (no overlay)", async () => {
		let options: unknown = "unset";
		await bash("echo g", ctx({ key: "y", onCustom: (o) => (options = o) }));
		assert.equal(options, undefined);
	});

	it("uses an overlay for center and top", async () => {
		for (const position of ["center", "top"]) {
			writeConfig({ ui: { position } });
			let options: { overlay?: boolean } | undefined;
			await bash(`echo ${position}`, ctx({ key: "y", onCustom: (o) => (options = o as typeof options) }));
			assert.equal(options?.overlay, true, position);
		}
	});
});

describe("/permissions off | on", () => {
	it("persists 'off' and runs everything without prompting, even denied calls", async () => {
		await run("off");
		assert.ok(JSON.parse(fs.readFileSync(stateFile, "utf8")).disabled[project]);
		assert.equal(await bash("sudo ls", ctx({ key: "n" })), undefined);
		assert.equal(await bash("echo x", ctx({ key: "n" })), undefined);
		assert.match(status.permissions ?? "", /permissions off$/);
	});

	it("survives a new session when persistent", async () => {
		await run("off");
		await handlers.session_start({}, ctx());
		assert.equal(await bash("sudo ls", ctx({ key: "n" })), undefined);
	});

	it("'off --session' is not persisted and ends with the session", async () => {
		await run("off --session");
		assert.equal(fs.existsSync(stateFile), false);
		assert.equal(await bash("sudo ls", ctx({ key: "n" })), undefined);
		assert.match(status.permissions ?? "", /\(session\)/);
		await handlers.session_start({}, ctx());
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
		assert.equal(status.permissions, undefined);
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
		const entry = entries.at(-1);
		assert.equal(entry?.type, "pi-permissions-summary");
		assert.equal((entry?.data as { off?: string }).off, "session");
		const themeWithBg = { ...theme, bg: (_c: string, t: string) => t };
		const component = renderers["pi-permissions-summary"](entry, { expanded: false }, themeWithBg);
		const text = component.render(80).join("\n");
		assert.match(text, /pi-permissions/);
		assert.match(text, /off \(this session\)/);
		assert.match(text, /git status \*\s+allow/);
	});

	it("completes subcommands", () => {
		assert.deepEqual(
			commands.permissions.getArgumentCompletions("of").map((i) => i.value),
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

	it("[a] on edit allows only that file", async () => {
		const edit = (p: string, key: string) => call("edit", { path: p, edits: [] }, ctx({ key }));
		assert.equal(await edit(path.join(project, "a.ts"), "a"), undefined);
		assert.equal(await edit(path.join(project, "a.ts"), "n"), undefined);
		assert.ok(blocked(await edit(path.join(project, "b.ts"), "n")));
	});

	it("shows grants explicitly in the /permissions card", async () => {
		await read(shot("paste-1.png"), ctx({ key: "a" }));
		await run("");
		const grants = (entries.at(-1)?.data as { grants: string[] }).grants;
		assert.deepEqual(grants, [`read: in ${clipboard.replace(home, "~")}/`]);
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
		c.ui.custom = (factory: Function, options: unknown) =>
			custom((tui: unknown, th: unknown, kb: unknown, done: Function) => {
				const component = factory(tui, th, kb, done);
				rendered = component.render(200).join("\n");
				return component;
			}, options);
		assert.equal(await call("read", { path: path.join(etc, "os-release") }, c), undefined);
		assert.ok(rendered.includes(`${path.join(etc, "os-release")} → ${path.join(real, "os-release")} (symlink)`));
		assert.ok(rendered.includes("usr-lib/"), "the grant label names the real directory");

		await run("");
		const grants = (entries.at(-1)?.data as { grants: string[] }).grants;
		assert.ok(grants.includes(`read: in ${real.replace(home, "~")}/`));
	});
});

describe("tell pi what to do", () => {
	const reason = (result: unknown) => (result as { reason?: string } | undefined)?.reason ?? "";

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
		const tell = ctx({ mode: "rpc", selectIndex: 2, inputText: "  try git stash  " });
		assert.match(reason(await bash("git reset --hard", tell)), /instead:\ntry git stash\n/);
		const empty = ctx({ mode: "rpc", selectIndex: 2, inputText: "" });
		assert.match(reason(await bash("git reset --hard", empty)), /ask the user how to proceed/);
	});
});
