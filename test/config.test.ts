import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isJson, mergeConfigs, parseConfig } from "../src/config.ts";

describe("parseConfig", () => {
	it("accepts commands, paths, tools, readonly and ui.position", () => {
		const errors: string[] = [];

		const cfg = parseConfig(
			{
				commands: { "sudo *": "halt", "git push *": "ask" },
				paths: { "~/.ssh/**": "deny", "~/dev/**": "yes-i-am-very-sure" },
				tools: { webfetch: "deny" },
				readonly: false,
				ui: { position: "top" },
			},
			"f",
			errors,
		);

		assert.deepEqual(errors, []);
		assert.deepEqual(cfg.commands, { "sudo *": "halt", "git push *": "ask" });
		assert.deepEqual(cfg.paths, { "~/.ssh/**": "deny", "~/dev/**": "yes-i-am-very-sure" });
		assert.deepEqual(cfg.tools, { webfetch: "deny" });
		assert.equal(cfg.readonly, false);
		assert.deepEqual(cfg.ui, { position: "top" });
	});

	it("refuses allow, pointing to the deliberate phrase", () => {
		const errors: string[] = [];
		const cfg = parseConfig({ commands: { "ls *": "allow", "rm *": "deny" } }, "f", errors);
		assert.deepEqual(cfg.commands, { "rm *": "deny" });
		assert.equal(errors.length, 1);
		assert.match(errors[0], /"allow" is not accepted; to allow without asking, write "yes-i-am-very-sure"/);
	});

	it("drops invalid entries and reports them", () => {
		const errors: string[] = [];

		const cfg = parseConfig(
			{ commands: { x: "maybe" }, paths: [], readonly: "yes", ui: { position: "left" } },
			"f",
			errors,
		);

		assert.deepEqual(cfg.commands, {});
		assert.deepEqual(cfg.paths, {});
		assert.equal(cfg.readonly, undefined);
		assert.equal(cfg.ui, undefined);
		assert.equal(errors.length, 4);
	});

	it("reports the old format instead of ignoring it silently", () => {
		const errors: string[] = [];
		parseConfig({ default: "ask", bash: { "*": "ask" }, external_directory: {} }, "f", errors);
		assert.equal(errors.length, 1);
		assert.match(errors[0], /default, external_directory, bash: old format/);
	});

	it("rejects a non-object root", () => {
		const errors: string[] = [];
		assert.deepEqual(parseConfig([1], "f", errors), {});
		assert.equal(errors.length, 1);
	});
});

describe("mergeConfigs", () => {
	it("defaults to no rules, readonly on and the editor position", () => {
		const cfg = mergeConfigs();
		assert.deepEqual([cfg.commands, cfg.paths, cfg.tools], [{}, {}, {}]);
		assert.equal(cfg.readonly, true);
		assert.equal(cfg.ui.position, "editor");
	});

	it("lets later layers override key by key", () => {
		const cfg = mergeConfigs(
			{ commands: { "sudo *": "deny", "rm *": "ask" }, ui: { position: "center" } },
			{ commands: { "sudo *": "halt" }, readonly: false },
		);

		assert.deepEqual(cfg.commands, { "sudo *": "halt", "rm *": "ask" });
		assert.equal(cfg.readonly, false);
		assert.equal(cfg.ui.position, "center");
	});

	it("returns independent objects", () => {
		const a = mergeConfigs();
		a.tools.read = "deny";
		assert.deepEqual(mergeConfigs().tools, {});
	});
});

describe("isJson", () => {
	it("accepts plain JSON data, nested", () => {
		assert.ok(isJson({ a: [1, "x", true, null, { b: 2.5 }] }));
	});

	it("rejects values JSON cannot carry", () => {
		for (const [index, value] of [
			undefined,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			() => 1,
			Symbol("s"),
			10n,
			{ a: undefined },
			[() => 1],
		].entries()) {
			assert.ok(!isJson(value), `case ${index}`);
		}
	});
});
