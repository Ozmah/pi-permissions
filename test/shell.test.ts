import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayLines, parseShell } from "../src/shell.ts";

const texts = (cmd: string) => parseShell(cmd).segments.map((s) => s.text);
const risky = (cmd: string) => parseShell(cmd).risky;

describe("parseShell: segments", () => {
	it("splits on control operators", () => {
		assert.deepEqual(texts("a && b || c | d ; e & f\ng"), ["a", "b", "c", "d", "e", "f", "g"]);
	});

	it("records the operator before each segment", () => {
		assert.deepEqual(
			parseShell("a && b | c").segments.map((s) => s.op),
			[undefined, "&&", "|"],
		);
	});

	it("does not split inside quotes", () => {
		assert.deepEqual(texts(`git log 'a;b' "c|d && e"`), [`git log 'a;b' "c|d && e"`]);
	});

	it("keeps escaped operators", () => {
		assert.deepEqual(texts("echo a\\;b"), ["echo a\\;b"]);
	});

	it("joins line continuations into one segment", () => {
		assert.deepEqual(texts("docker run \\\n  --rm img"), ["docker run    --rm img"]);
	});

	it("treats |& as a pipe", () => {
		assert.deepEqual(texts("make |& tee log"), ["make", "tee log"]);
	});

	it("does not split on & that belongs to a redirection", () => {
		assert.deepEqual(texts("cmd 2>&1"), ["cmd 2>&1"]);
		assert.deepEqual(texts("cmd &>/dev/null"), ["cmd &>/dev/null"]);
		assert.deepEqual(texts("cmd <&3"), ["cmd <&3"]);
	});

	it("returns no segments for an empty command", () => {
		assert.deepEqual(texts("   "), []);
	});
});

describe("parseShell: risky constructs", () => {
	it("flags command substitution, also inside double quotes", () => {
		assert.deepEqual(risky("echo $(id)"), ["command substitution"]);
		assert.deepEqual(risky("echo `id`"), ["command substitution"]);
		assert.deepEqual(risky(`echo "$(id)"`), ["command substitution"]);
	});

	it("ignores substitution syntax inside single quotes", () => {
		assert.deepEqual(risky("echo '$(id)'"), []);
	});

	it("flags process substitution", () => {
		assert.deepEqual(risky("diff <(a) b"), ["process substitution"]);
	});

	it("flags redirection to a file", () => {
		for (const cmd of [
			"echo x > f",
			"echo x >> f",
			"echo x >| f",
			"echo x 2> f",
			"echo x &> f",
			"echo x >&f",
			"echo x >& f",
		]) {
			assert.deepEqual(risky(cmd), ["redirection to file"], cmd);
		}
	});

	it("does not flag fd duplication or /dev/null", () => {
		for (const cmd of ["cmd 2>&1", "cmd >&2", "cmd 2>&-", "cmd > /dev/null", "cmd 2>/dev/null", "cmd &>/dev/null; x"]) {
			assert.deepEqual(risky(cmd), [], cmd);
		}
	});

	it("flags paths that only start with /dev/null", () => {
		assert.deepEqual(risky("cmd > /dev/null_x"), ["redirection to file"]);
	});

	it("flags unclosed quotes", () => {
		assert.deepEqual(risky(`echo "abc`), ["unclosed quote"]);
	});
});

describe("displayLines", () => {
	it("leads continuation lines with their operator", () => {
		assert.deepEqual(displayLines(parseShell("a && b | c; d\ne")), ["a", "&& b", "| c", "; d", "e"]);
	});

	it("shows exactly the segments that are evaluated", () => {
		const cmd = `psql -c "UPDATE t; DELETE x" && pg_dump app | gzip > /b/x.gz`;
		const analysis = parseShell(cmd);
		assert.equal(displayLines(analysis).length, analysis.segments.length);
	});
});
