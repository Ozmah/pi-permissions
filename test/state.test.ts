import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { emptyState, readState, setDisabled, writeState } from "../src/state.ts";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-permissions-state-")), "state.json");

describe("state", () => {
	it("reads a missing file as empty", () => {
		const errors: string[] = [];
		assert.deepEqual(readState(tmp(), errors), emptyState());
		assert.deepEqual(errors, []);
	});

	it("round-trips disabled projects", () => {
		const file = tmp();
		const now = new Date("2026-01-02T03:04:05.000Z");
		writeState(file, setDisabled(emptyState(), "/a", true, now));
		assert.deepEqual(readState(file, []).disabled, { "/a": { since: "2026-01-02T03:04:05.000Z" } });
		writeState(file, setDisabled(readState(file, []), "/a", false));
		assert.deepEqual(readState(file, []).disabled, {});
	});

	it("writes owner-only and leaves no temp files", () => {
		const file = tmp();
		writeState(file, emptyState());
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.deepEqual(fs.readdirSync(path.dirname(file)), ["state.json"]);
	});

	it("treats an invalid file as empty and reports it", () => {
		const file = tmp();
		fs.writeFileSync(file, "{ nope");
		const errors: string[] = [];
		assert.deepEqual(readState(file, errors), emptyState());
		assert.equal(errors.length, 1);
	});

	it("ignores relative project paths", () => {
		const file = tmp();
		fs.writeFileSync(file, JSON.stringify({ version: 1, disabled: { "rel/dir": {}, "/abs": {} } }));
		assert.deepEqual(Object.keys(readState(file, []).disabled), ["/abs"]);
	});

	it("does not mutate the previous state", () => {
		const before = emptyState();
		setDisabled(before, "/a", true);
		assert.deepEqual(before.disabled, {});
	});
});
