import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { type CallTarget, describeGrant, grantChoices, grantMatches, shortPath } from "../src/grants.ts";

// Real directories so "is this path a directory" checks behave like in use.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-permissions-grants-")));
const clipboard = path.join(root, "soloterm-clipboard");

fs.mkdirSync(path.join(clipboard, "nested"), { recursive: true });

const shot = (name: string) => path.join(clipboard, name);

const read = (absPath: string): CallTarget => ({ tool: "read", input: { path: absPath }, absPath });

const edit = (absPath: string, firm = false): CallTarget => ({
	tool: "edit",
	input: { path: absPath },
	absPath,
	firm,
});

const bash = (dirs: string[] | undefined, firm = false): CallTarget => ({
	tool: "bash",
	input: { command: "x" },
	dirs,
	firm,
});

const choice = (target: CallTarget, key: string) => grantChoices(target).find((c) => c.key === key);

describe("grantChoices", () => {
	it("offers total access to the folder, and to its subfolders", () => {
		assert.deepEqual(
			grantChoices(read(shot("paste-1.png"))).map((c) => [c.key, c.label]),
			[
				["a", `stfu pi on ${shortPath(clipboard)}/`],
				["d", `stfu pi on ${shortPath(clipboard)}/ and subfolders`],
			],
		);
	});

	it("offers the same for every file tool", () => {
		assert.deepEqual(
			grantChoices(edit(shot("a.ts"))).map((c) => c.grant),
			[
				{ kind: "access", dir: clipboard, recursive: false },
				{ kind: "access", dir: clipboard, recursive: true },
			],
		);
	});

	it("uses the directory itself when the target is a directory (ls, find, grep)", () => {
		assert.deepEqual(choice({ tool: "ls", input: {}, absPath: clipboard }, "a")?.grant, {
			kind: "access",
			dir: clipboard,
			recursive: false,
		});
	});

	it("offers bash the folder its command runs in, the common one after a cd", () => {
		assert.equal(choice(bash([clipboard]), "a")?.label, `stfu pi on ${shortPath(clipboard)}/`);
		assert.deepEqual(choice(bash([clipboard, shot("nested")]), "d")?.grant, {
			kind: "access",
			dir: clipboard,
			recursive: true,
		});
	});

	it("offers nothing for bash when its directory is unknown, or for firm questions", () => {
		assert.deepEqual(grantChoices(bash(undefined)), []);
		assert.deepEqual(grantChoices(bash([clipboard], true)), []);
		assert.deepEqual(grantChoices(edit(shot("permissions.json"), true)), []);
	});

	it("offers any-input for tools without a path", () => {
		assert.deepEqual(
			grantChoices({ tool: "mcp__x", input: {} }).map((c) => c.label),
			["Always: mcp__x (any input)"],
		);
	});
});

describe("grantMatches", () => {
	const folder = { kind: "access", dir: clipboard, recursive: false } as const;
	const tree = { kind: "access", dir: clipboard, recursive: true } as const;

	it("folder access covers every tool in that folder, not deeper", () => {
		assert.ok(grantMatches(folder, read(shot("paste-2.png"))));
		assert.ok(grantMatches(folder, edit(shot("a.ts"))));
		assert.ok(grantMatches(folder, bash([clipboard])));
		assert.ok(!grantMatches(folder, read(shot("nested/paste-3.png"))));
		assert.ok(!grantMatches(folder, bash([shot("nested")])));
		assert.ok(!grantMatches(folder, read(path.join(root, "other.png"))));
	});

	it("subfolder access covers the whole tree", () => {
		assert.ok(grantMatches(tree, read(shot("nested/paste-3.png"))));
		assert.ok(grantMatches(tree, bash([clipboard, shot("nested")])));
		assert.ok(!grantMatches(tree, read(path.join(root, "other.png"))));
	});

	it("covers bash only when every directory it may run in is covered", () => {
		assert.ok(!grantMatches(tree, bash([clipboard, root])));
		assert.ok(!grantMatches(tree, bash(undefined)));
	});

	it("never covers firm questions (ask rules, protected files)", () => {
		assert.ok(!grantMatches(tree, edit(shot("permissions.json"), true)));
		assert.ok(!grantMatches(tree, bash([clipboard], true)));
	});

	it("any-input grants cover only their tool", () => {
		const grant = { kind: "tool", tool: "mcp__x" } as const;
		assert.ok(grantMatches(grant, { tool: "mcp__x", input: { a: 1 } }));
		assert.ok(!grantMatches(grant, { tool: "mcp__y", input: {} }));
	});
});

describe("shortPath and describeGrant", () => {
	it("keeps short paths and shortens long ones to their last segments", () => {
		assert.equal(shortPath("/a/b"), "/a/b");
		assert.equal(shortPath("/mnt/c/Users/x/AppData/Local/Temp/soloterm-clipboard"), "…/Temp/soloterm-clipboard");
		assert.equal(shortPath(path.join(os.homedir(), "dev")), "~/dev");
	});

	it("describes grants explicitly with the full path", () => {
		const dir = "/mnt/c/Temp/soloterm-clipboard";
		assert.equal(describeGrant({ kind: "access", dir, recursive: false }), `stfu pi on ${dir}/`);
		assert.equal(describeGrant({ kind: "access", dir, recursive: true }), `stfu pi on ${dir}/ and subfolders`);
		assert.equal(describeGrant({ kind: "tool", tool: "mcp__x" }), "mcp__x: any input");
	});
});
