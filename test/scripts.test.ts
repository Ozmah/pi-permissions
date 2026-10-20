import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inlineScript } from "../src/scripts.ts";
import { parseShell } from "../src/shell.ts";

/** The inline script of the first segment of `command`. */
const script = (command: string) => {
	const [segment] = parseShell(command).segments;
	assert.ok(segment, "has a segment");

	return inlineScript(segment);
};

describe("inlineScript", () => {
	it("reads the script from a here-document on stdin", () => {
		assert.deepEqual(script("python3 - <<'EOF'\nprint(1)\nEOF"), {
			name: "Python",
			language: "python",
			code: "print(1)",
			from: "heredoc",
		});
		assert.equal(script("python3 <<EOF\nx\nEOF")?.from, "heredoc", "no - needed");
		assert.equal(script("bash -s arg <<EOF\nls\nEOF")?.language, "bash");
		assert.equal(script("python3.12 - <<EOF\nx\nEOF")?.name, "Python");
	});

	it("reads the code after a code flag", () => {
		assert.equal(script(`python3 -c "import os"`)?.code, "import os");
		assert.equal(script(`node -e 'console.log(1)'`)?.language, "javascript");
		assert.equal(script(`bash -c 'ls -la'`)?.code, "ls -la");
		assert.equal(script(`php -r 'echo 1;'`)?.name, "PHP");
	});

	it("does not take the here-document of a script file for code", () => {
		assert.equal(script("python3 tool.py <<EOF\ninput\nEOF"), undefined);
	});

	it("ignores other commands and scripts piped from elsewhere", () => {
		assert.equal(script("cat <<EOF\nx\nEOF"), undefined);
		assert.equal(script("python3 tool.py"), undefined);
		assert.equal(script("python3 -"), undefined, "stdin without a here-document is not visible");
	});
});
