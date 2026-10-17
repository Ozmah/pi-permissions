import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { before, describe, it } from "node:test";

// Isolate from the real ~/.pi: point HOME at a temp dir before loading the extension.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permissions-home-"));
process.env.HOME = home;
const project = path.join(home, "project");
fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
fs.mkdirSync(project);
fs.writeFileSync(
	path.join(home, ".pi", "agent", "permissions.json"),
	JSON.stringify({ tools: { read: "allow" }, bash: { "git status *": "allow", "sudo *": "deny", "*": "ask" } }),
);

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
const handlers: Record<string, Handler> = {};
const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };

before(async () => {
	const { default: extension } = await import("../src/index.ts");
	extension({
		on: (name: string, handler: Handler) => {
			handlers[name] = handler;
		},
		registerCommand() {},
	} as never);
});

interface FakeCtxOptions {
	mode?: string;
	hasUI?: boolean;
	key?: string;
	signal?: AbortSignal;
	onCustom?: (options: unknown) => void;
}

function ctx({ mode = "tui", hasUI = true, key, signal, onCustom }: FakeCtxOptions = {}) {
	return {
		mode,
		hasUI,
		cwd: project,
		signal,
		isProjectTrusted: () => false,
		ui: {
			notify() {},
			select: async (_title: string, options: string[]) => options[0],
			custom: (factory: Function, options: unknown) =>
				new Promise((resolve) => {
					onCustom?.(options);
					const component = factory({ terminal: { rows: 30 }, requestRender() {} }, theme, {}, resolve);
					component.render(80);
					if (key) component.handleInput(key);
				}),
		},
	};
}

const bash = (command: string, c = ctx()) => handlers.tool_call({ toolName: "bash", input: { command } }, c);
const blocked = (result: unknown) => (result as { block?: boolean } | undefined)?.block === true;

describe("extension flow", () => {
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

	it("replaces the editor by default (no overlay)", async () => {
		let options: unknown = "unset";
		await bash("echo g", ctx({ key: "y", onCustom: (o) => (options = o) }));
		assert.equal(options, undefined);
	});

	it("uses an overlay for the center and top positions", async () => {
		for (const position of ["center", "top"]) {
			const file = path.join(home, ".pi", "agent", "permissions.json");
			const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
			fs.writeFileSync(file, JSON.stringify({ ...cfg, ui: { position } }));
			let options: { overlay?: boolean } | undefined;
			await bash(`echo ${position}`, ctx({ key: "y", onCustom: (o) => (options = o as typeof options) }));
			assert.equal(options?.overlay, true, position);
		}
	});
});
