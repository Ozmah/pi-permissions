import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isJson, mergeConfigs, parseConfig } from "../src/config.ts";

describe("parseConfig", () => {
	it("accepts valid rules and ui.position", () => {
		const errors: string[] = [];

		const cfg = parseConfig(
			{ default: "deny", tools: { read: "allow" }, bash: { "git *": "ask" }, ui: { position: "top" } },
			"f",
			errors,
		);

		assert.deepEqual(errors, []);
		assert.equal(cfg.default, "deny");
		assert.deepEqual(cfg.tools, { read: "allow" });
		assert.deepEqual(cfg.ui, { position: "top" });
	});

	it("drops invalid entries and reports them", () => {
		const errors: string[] = [];

		const cfg = parseConfig(
			{ default: "maybe", tools: { read: "yes", ls: "allow" }, bash: [], ui: { position: "left" } },
			"f",
			errors,
		);

		assert.equal(cfg.default, undefined);
		assert.deepEqual(cfg.tools, { ls: "allow" });
		assert.deepEqual(cfg.bash, {});
		assert.equal(cfg.ui, undefined);
		assert.equal(errors.length, 4);
	});

	it("rejects a non-object root", () => {
		const errors: string[] = [];
		assert.deepEqual(parseConfig([1], "f", errors), {});
		assert.equal(errors.length, 1);
	});
});

describe("mergeConfigs", () => {
	it("defaults to ask and the editor position", () => {
		const cfg = mergeConfigs();
		assert.equal(cfg.default, "ask");
		assert.equal(cfg.ui.position, "editor");
	});

	it("lets later layers override key by key", () => {
		const cfg = mergeConfigs(
			{ tools: { read: "allow", edit: "ask" }, ui: { position: "center" } },
			{ tools: { edit: "allow" } },
		);

		assert.deepEqual(cfg.tools, { read: "allow", edit: "allow" });
		assert.equal(cfg.ui.position, "center");
	});

	it("returns independent objects", () => {
		const a = mergeConfigs();
		a.tools.read = "allow";
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
