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

describe("parseShell: here-documents", () => {
	const heredocs = (cmd: string) => parseShell(cmd).segments.map((s) => s.heredocs?.map((h) => h.body));

	it("keeps the body out of the segments and attaches it to its command", () => {
		const cmd = "cd x && python3 - <<'PY'\nimport os; os.remove('a')\nx = 1 && 2\nPY\ngrep a b | head -3";
		assert.deepEqual(texts(cmd), ["cd x", "python3 - <<'PY'", "grep a b", "head -3"]);
		assert.deepEqual(heredocs(cmd), [undefined, ["import os; os.remove('a')\nx = 1 && 2"], undefined, undefined]);
		assert.deepEqual(risky(cmd), []);
	});

	it("attaches the body to the segment that opened it, even inside a pipeline", () => {
		assert.deepEqual(heredocs("cat <<EOF | grep x\nhi\nEOF"), [["hi"], undefined]);
	});

	it("reads several here-documents of one line in order", () => {
		const cmd = "cat <<A <<B\na\nA\nb\nB\nls";
		assert.deepEqual(texts(cmd), ["cat <<A <<B", "ls"]);
		assert.deepEqual(heredocs(cmd)[0], ["a", "b"]);
	});

	it("strips leading tabs with <<-, also before the delimiter", () => {
		assert.deepEqual(texts("cat <<-EOF\n\tx\n\tEOF\nls"), ["cat <<-EOF", "ls"]);
	});

	it("flags substitutions only when the body is expanded (unquoted delimiter)", () => {
		assert.deepEqual(risky("cat <<EOF\n$(rm -rf ~)\nEOF"), ["command substitution"]);
		assert.deepEqual(risky("cat <<EOF\n`rm -rf ~`\nEOF"), ["command substitution"]);
		assert.deepEqual(risky("cat <<'EOF'\n$(rm -rf ~)\nEOF"), []);
		assert.deepEqual(risky('cat <<"EOF"\n$(x)\nEOF'), []);
		assert.deepEqual(risky("cat <<\\EOF\n$(x)\nEOF"), []);
	});

	it("flags a missing delimiter and hides nothing after it", () => {
		const cmd = "cat <<EOF\nx\nrm -rf ~";
		assert.deepEqual(risky(cmd), ["unclosed here-document"]);
		assert.deepEqual(texts(cmd), ["cat <<EOF"]);
	});

	it("does not take a here-string for a here-document", () => {
		assert.deepEqual(texts("cat <<< 'x'\nls"), ["cat <<< 'x'", "ls"]);
		assert.deepEqual(heredocs("cat <<< 'x'\nls"), [undefined, undefined]);
	});

	it("flags << without a delimiter", () => {
		assert.deepEqual(risky("cat << ;"), ["unsupported here-document"]);
	});
});

describe("parseShell: comments", () => {
	it("does not open a here-document inside a comment, so the next line stays a segment", () => {
		const cmd = "git status # <<EOF\nrm -rf ~\nEOF";
		assert.deepEqual(texts(cmd), ["git status # <<EOF", "rm -rf ~", "EOF"]);
		assert.equal(parseShell(cmd).segments[0].heredocs, undefined);
	});

	it("does not open a quote inside a comment, so lines are not merged", () => {
		const cmd = "git status # it's fine\nrm -rf ~\necho 'x'";
		assert.deepEqual(texts(cmd), ["git status # it's fine", "rm -rf ~", "echo 'x'"]);
		assert.deepEqual(risky(cmd), []);
	});

	it("does not split on operators inside a comment", () => {
		assert.deepEqual(texts("ls # a && b | c\npwd"), ["ls # a && b | c", "pwd"]);
	});

	it("only takes a # that starts a word", () => {
		assert.deepEqual(texts("echo a#b && echo $# && echo ${#x}"), ["echo a#b", "echo $#", "echo ${#x}"]);
		assert.deepEqual(texts("ls;# c && rm x\npwd"), ["ls", "# c && rm x", "pwd"]);
	});
});
