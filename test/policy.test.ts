import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { type JsonObject, mergeConfigs } from "../src/config.ts";
import { decide, formatReason, matches, resolvePath, resolveRules } from "../src/policy.ts";

const home = os.homedir();

// Resolved like the extension does (e.g. /tmp is a symlink on macOS).
const cwd = resolvePath(path.join(os.tmpdir(), "pi-permissions-test-project"), "/");

const cfg = mergeConfigs({
	default: "ask",
	tools: { read: "allow", ls: "allow", find: "allow", grep: "allow", edit: "ask", write: "ask" },
	external_directory: { "~/work/*": "allow", "*": "ask" },
	bash: { "git log *": "allow", "git status *": "allow", "git diff *": "allow", "sudo *": "deny", "*": "ask" },
});

const action = (toolName: string, input: JsonObject, protectedPaths?: string[]) =>
	decide(cfg, toolName, input, { cwd, protectedPaths }).action;

describe("matches", () => {
	it("treats * as any characters, including / and spaces", () => {
		assert.ok(matches("git *", "git log --oneline"));
		assert.ok(matches("/a/*", "/a/b/c"));
	});

	it("lets a trailing ' *' or '/*' match the bare prefix", () => {
		assert.ok(matches("git status *", "git status"));
		assert.ok(matches("/a/*", "/a"));
		assert.ok(!matches("git status *", "git statusx"));
	});
});

describe("resolveRules", () => {
	it("prefers the most specific pattern", () => {
		assert.equal(resolveRules({ "*": "ask", "git *": "allow" }, "git log")?.pattern, "git *");
	});

	it("breaks ties with the strictest action", () => {
		assert.equal(resolveRules({ "a*": "allow", "*a": "deny" }, "aa")?.action, "deny");
	});
});

describe("decide: file tools", () => {
	it("allows reads inside the project", () => {
		assert.equal(action("read", { path: "src/a.ts" }), "allow");
		assert.equal(action("ls", {}), "allow");
	});

	it("asks for paths outside the project without a rule", () => {
		assert.equal(action("read", { path: "/etc/hosts" }), "ask");
		assert.equal(action("grep", { pattern: "x", path: "../.." }), "ask");
	});

	it("applies external_directory rules", () => {
		assert.equal(action("read", { path: "~/work/x/y.md" }), "allow");
	});

	it("uses the strictest of tool and path rules", () => {
		assert.equal(action("edit", { path: "~/work/a.ts" }), "ask");
	});

	it("falls back to default for unlisted tools", () => {
		assert.equal(action("mcp__server__tool", {}), "ask");
	});
});

describe("decide: bash", () => {
	it("allows commands whose every segment is allowed", () => {
		assert.equal(action("bash", { command: "git status" }), "allow");
		assert.equal(action("bash", { command: "git log --oneline -5 && git diff" }), "allow");
		assert.equal(action("bash", { command: "git status 2>&1" }), "allow");
	});

	it("asks when any segment is not allowed", () => {
		assert.equal(action("bash", { command: "git log; rm -rf ~" }), "ask");
		assert.equal(action("bash", { command: "git status & rm x" }), "ask");
		assert.equal(action("bash", { command: "git logx" }), "ask");
	});

	it("denies when any segment is denied", () => {
		assert.equal(action("bash", { command: "git log && sudo rm x" }), "deny");
	});

	it("asks for risky constructs even if every segment is allowed", () => {
		assert.equal(action("bash", { command: "git log $(rm -rf ~)" }), "ask");
		assert.equal(action("bash", { command: "git diff > out.txt" }), "ask");
		assert.equal(action("bash", { command: "git diff >& out.txt" }), "ask");
	});
});

describe("decide: protected paths", () => {
	const allowAll = mergeConfigs({ default: "allow", tools: { "*": "allow" }, bash: { "*": "allow" } });
	const config = path.join(cwd, ".pi", "permissions.json");
	const extensionRoot = path.join(home, ".pi", "agent", "extensions", "pi-permissions");
	const protectedPaths = [config, extensionRoot];

	const run = (toolName: string, input: JsonObject) =>
		decide(allowAll, toolName, input, { cwd, protectedPaths }).action;

	it("asks before writing a permission file, whatever the rules", () => {
		assert.equal(run("write", { path: ".pi/permissions.json", content: "{}" }), "ask");
		assert.equal(run("edit", { path: config, edits: [] }), "ask");
	});

	it("asks before writing the extension's own files", () => {
		assert.equal(run("write", { path: path.join(extensionRoot, "src", "index.ts"), content: "" }), "ask");
	});

	it("still allows reading them", () => {
		assert.equal(run("read", { path: ".pi/permissions.json" }), "allow");
	});

	it("asks when bash mentions a permission file", () => {
		assert.equal(run("bash", { command: "cp x .pi/permissions.json" }), "ask");
		assert.equal(run("bash", { command: `sed -i s/a/b/ ${extensionRoot}/src/index.ts` }), "ask");
		assert.equal(run("bash", { command: "ls" }), "allow");
	});
});

describe("decide: reasons", () => {
	const reasons = (command: string) => decide(cfg, "bash", { command }, { cwd }).reasons.map(formatReason);

	it("reports the fallback rule as a fallback", () => {
		assert.deepEqual(reasons("ls -la"), [`"ls -la" → no matching bash rule (fallback "*": ask)`]);
	});

	it("reports a specific match", () => {
		assert.deepEqual(reasons("git status"), [`"git status" → matched bash "git status *": allow`]);
	});

	it("reports the config default when nothing matches", () => {
		const r = decide(mergeConfigs(), "bash", { command: "ls" }, { cwd }).reasons.map(formatReason);
		assert.deepEqual(r, [`"ls" → no matching bash rule (default: ask)`]);
	});

	it("reports forced confirmations as notes", () => {
		assert.deepEqual(reasons("git diff > out.txt").at(-1), "contains redirection to file \u2192 requires confirmation");
	});

	it("truncates long segments", () => {
		const [reason] = reasons(`echo ${"x".repeat(200)}`);
		assert.ok(reason.length < 160);
		assert.ok(reason.includes("…"));
	});
});

describe("decide: symlinks", () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-permissions-link-")));
	fs.mkdirSync(path.join(dir, "real"));
	fs.writeFileSync(path.join(dir, "real", "os-release"), "x");
	fs.mkdirSync(path.join(dir, "etc"));
	fs.symlinkSync(path.join(dir, "real", "os-release"), path.join(dir, "etc", "os-release"));

	it("decides on the real path and keeps the requested one", () => {
		const d = decide(cfg, "read", { path: path.join(dir, "etc", "os-release") }, { cwd });
		assert.equal(d.absPath, path.join(dir, "real", "os-release"));
		assert.equal(d.requestedPath, path.join(dir, "etc", "os-release"));
	});

	it("reports the same path twice when there is no symlink", () => {
		const d = decide(cfg, "read", { path: path.join(dir, "real", "os-release") }, { cwd });
		assert.equal(d.absPath, d.requestedPath);
	});
});
