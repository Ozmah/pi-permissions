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
const edit = (absPath: string, isProtected = false): CallTarget => ({
	tool: "edit",
	input: { path: absPath },
	absPath,
	protected: isProtected,
});
const choice = (target: CallTarget, key: string) => grantChoices(target).find((c) => c.key === key);

describe("grantChoices", () => {
	it("offers exact command only for bash", () => {
		const choices = grantChoices({ tool: "bash", input: { command: "ls" } });
		assert.deepEqual(choices.map((c) => [c.key, c.label]), [["a", "Always: this exact command"]]);
	});

	it("offers any-input for tools without a path", () => {
		assert.deepEqual(grantChoices({ tool: "mcp__x", input: {} }).map((c) => c.label), ["Always: mcp__x (any input)"]);
	});

	it("offers directory and directory+subfolders for read-only tools", () => {
		const labels = grantChoices(read(shot("paste-1.png"))).map((c) => c.label);
		assert.deepEqual(labels, [
			`Always: read in ${shortPath(clipboard)}/`,
			`Always: read in ${shortPath(clipboard)}/ and subfolders`,
		]);
	});

	it("offers exact file and directory+subfolders for write tools", () => {
		const labels = grantChoices(edit(shot("a.ts"))).map((c) => c.label);
		assert.deepEqual(labels, [
			`Always: edit ${shortPath(shot("a.ts"))}`,
			`Always: edit in ${shortPath(clipboard)}/ and subfolders`,
		]);
	});

	it("uses the directory itself when the target is a directory (ls, find, grep)", () => {
		const grant = choice({ tool: "ls", input: {}, absPath: clipboard }, "a")?.grant;
		assert.deepEqual(grant, { kind: "dir", tool: "ls", dir: clipboard, recursive: false });
	});

	it("offers no directory option for protected files", () => {
		assert.deepEqual(grantChoices(edit(shot("permissions.json"), true)).map((c) => c.key), ["a"]);
	});
});

describe("grantMatches", () => {
	it("[a] on read covers the next screenshot in the same directory", () => {
		const grant = choice(read(shot("paste-1.png")), "a")?.grant;
		assert.ok(grant);
		assert.ok(grantMatches(grant, read(shot("paste-2.png"))));
		assert.ok(!grantMatches(grant, read(shot("nested/paste-3.png"))));
		assert.ok(!grantMatches(grant, read(path.join(root, "other.png"))));
	});

	it("[d] covers subfolders too", () => {
		const grant = choice(read(shot("paste-1.png")), "d")?.grant;
		assert.ok(grant);
		assert.ok(grantMatches(grant, read(shot("nested/paste-3.png"))));
		assert.ok(!grantMatches(grant, read(path.join(root, "other.png"))));
	});

	it("is limited to the same tool", () => {
		const grant = choice(read(shot("paste-1.png")), "d")?.grant;
		assert.ok(grant);
		assert.ok(!grantMatches(grant, edit(shot("paste-1.png"))));
	});

	it("[a] on edit covers only that file", () => {
		const grant = choice(edit(shot("a.ts")), "a")?.grant;
		assert.ok(grant);
		assert.ok(grantMatches(grant, edit(shot("a.ts"))));
		assert.ok(!grantMatches(grant, edit(shot("b.ts"))));
	});

	it("directory grants never cover protected files", () => {
		const grant = choice(edit(shot("a.ts")), "d")?.grant;
		assert.ok(grant);
		assert.ok(grantMatches(grant, edit(shot("b.ts"))));
		assert.ok(!grantMatches(grant, edit(shot("permissions.json"), true)));
	});

	it("matches bash commands exactly", () => {
		const grant = { kind: "command", command: "ls" } as const;
		assert.ok(grantMatches(grant, { tool: "bash", input: { command: "ls" } }));
		assert.ok(!grantMatches(grant, { tool: "bash", input: { command: "ls " } }));
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
		assert.equal(describeGrant({ kind: "dir", tool: "read", dir, recursive: false }), `read: in ${dir}/`);
		assert.equal(describeGrant({ kind: "dir", tool: "read", dir, recursive: true }), `read: in ${dir}/ and subfolders`);
		assert.equal(describeGrant({ kind: "command", command: "ls -la" }), "bash: ls -la");
	});
});
