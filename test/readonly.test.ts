import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { mergeConfigs } from "../src/config.ts";
import { decide, formatReason, needsDecision, resolvePath } from "../src/policy.ts";
import { analyzeReadonly, cdEffect } from "../src/readonly.ts";
import { type Token, tokenize } from "../src/shell.ts";

const home = os.homedir();
const cwd = resolvePath(path.join(os.tmpdir(), "pi-permissions-test-project"), "/");

const cfg = mergeConfigs({
	commands: { "git log *": "yes-i-am-very-sure", "sudo *": "deny", "cat *secret*": "deny" },
	paths: { "~/work/**": "yes-i-am-very-sure" },
});

const bash = (command: string, cdpath?: string) => decide(cfg, "bash", { command }, { cwd, cdpath });
const action = (command: string, cdpath?: string) => bash(command, cdpath).action;

const words = (text: string) => tokenize(text)?.map((t) => (t.kind === "word" ? t.value : `<${t.op}>`));

const analyze = (text: string) => {
	const tokens: Token[] | undefined = tokenize(text);
	assert.ok(tokens, `"${text}" tokenizes`);

	return analyzeReadonly(tokens);
};

describe("tokenize", () => {
	it("removes quotes and keeps escaped characters", () => {
		assert.deepEqual(words(`grep -n "a\\|b" 'c d' e\\ f`), ["grep", "-n", "a\\|b", "c d", "e f"]);
	});

	it("splits redirections, with their fd, even without spaces", () => {
		assert.deepEqual(words("cat<in 2>/dev/null >&2 &>>log"), [
			"cat",
			"<<>",
			"in",
			"<2>>",
			"/dev/null",
			"<>&>",
			"2",
			"<&>>>",
			"log",
		]);
	});

	it("flags variables, globs and tilde", () => {
		const [, v, g, t, q] = tokenize(`cat "$HOME/x" src/*.ts ~/a "~/b"`) ?? [];
		assert.ok(v?.kind === "word" && v.dynamic);
		assert.ok(g?.kind === "word" && g.glob && !g.dynamic);
		assert.ok(t?.kind === "word" && t.tilde);
		assert.ok(q?.kind === "word" && !q.tilde, "a quoted ~ is literal");
	});

	it("takes a $ that expands nothing as a literal", () => {
		const dynamic = (text: string) => tokenize(`grep ${text}`)?.some((t) => t.kind === "word" && t.dynamic);
		assert.equal(dynamic(`"^ \\*\\|^$"`), false, "$ closing a double-quoted string");
		assert.equal(dynamic(`'^$'`), false);
		assert.equal(dynamic(`"a$ b"`), false);
		assert.equal(dynamic(`a$`), false);

		for (const text of [`"$HOME"`, `"\${x}"`, `"$(id)"`, `"$1"`, `"$@"`, `$x`, `$'\n'`]) {
			assert.equal(dynamic(text), true, text);
		}
	});

	it("treats ~user as dynamic", () => {
		const [, w] = tokenize("cat ~root/x") ?? [];
		assert.ok(w?.kind === "word" && w.dynamic);
	});

	it("gives up on subshells, groups, brace expansion, comments and unclosed quotes", () => {
		for (const text of ["(cd x)", "{ cat x; }", "cat {a,b}", "cat x # y", `cat "x`]) {
			assert.equal(tokenize(text), undefined, text);
		}
	});
});

describe("analyzeReadonly", () => {
	it("ignores commands it does not know", () => {
		assert.equal(analyze("rm -rf x"), undefined);
		assert.equal(analyze("/bin/cat x"), undefined, "only bare names");
		assert.equal(analyze("FOO=1 cat x"), undefined, "environment assignments");
	});

	it("treats every operand as a path, including patterns", () => {
		assert.deepEqual(analyze("grep -n foo src"), {
			ok: true,
			paths: [
				{ value: "foo", tilde: false },
				{ value: "src", tilde: false },
			],
		});
	});

	it("checks input redirections and allows output only to /dev/null or an fd", () => {
		assert.deepEqual(analyze("head -20 < ~/x 2>/dev/null"), { ok: true, paths: [{ value: "~/x", tilde: true }] });
		assert.deepEqual(analyze("cat x 2>&1"), { ok: true, paths: [{ value: "x", tilde: false }] });
		assert.equal(analyze("cat x > out")?.ok, false);
		assert.equal(analyze("cat x >&out")?.ok, false);
		assert.equal(analyze("cat <> f")?.ok, false);
		assert.equal(analyze("cat <<'EOF'")?.ok, true, "a here-document is stdin data");
	});

	it("reduces a glob to its fixed directory", () => {
		assert.deepEqual(analyze("cat src/*.ts"), { ok: true, paths: [{ value: "src", tilde: false }] });
		assert.deepEqual(analyze("cat *.md"), { ok: true, paths: [{ value: ".", tilde: false }] });
		assert.equal(analyze("cat src/*/../../x")?.ok, false);
	});

	it("rejects a wildcard component that can match .. itself", () => {
		for (const text of [
			"cat .*/.*/etc/passwd",
			"cat .*/secret",
			"cat .?/x",
			"cat .[.]/x",
			"cat src/.*/x",
			"grep -r x .*",
		]) {
			assert.equal(analyze(text)?.ok, false, text);
		}
	});

	it("keeps dot folders without a wildcard, and wildcards without a leading dot", () => {
		assert.deepEqual(analyze("cat .git/*.ts"), { ok: true, paths: [{ value: ".git", tilde: false }] });
		assert.equal(analyze("cat src/*.ts")?.ok, true);
		assert.equal(analyze("cat '.*'")?.ok, true, "a quoted .* is a literal name");
	});

	it("checks --flag=value values as paths, both readings of ~", () => {
		const r = analyze("grep --exclude-from=~/x y");
		assert.ok(r?.ok);
		assert.deepEqual(r.paths.slice(0, 2), [
			{ value: "~/x", tilde: false },
			{ value: "~/x", tilde: true },
		]);
	});

	it("rejects flags that write, run programs or follow symlinks", () => {
		for (const text of [
			"find . -delete",
			"find . -exec rm x",
			"find -L .",
			"find -files0-from list",
			"rg --pre sh x",
			"rg --pre=sh x",
			"rg -L x",
			"grep -R x .",
			"sort -o out x",
			"sort -ro out x",
			"sort --output=out x",
			"tail -f log",
			"wc --files0-from=list",
			"uniq in out",
			// GNU getopt_long abbreviations of denied long flags
			"sort --o=src/index.ts x",
			"sort --outp src/index.ts x",
			"sort --compress-prog=sh x",
			"grep --dereference x .",
			"tail --fol log",
			"wc --files0=list",
		]) {
			assert.equal(analyze(text)?.ok, false, text);
		}
	});

	it("accepts sed -n printing line ranges, and only that", () => {
		assert.deepEqual(analyze("sed -n 1,60p index.ts"), { ok: true, paths: [{ value: "index.ts", tilde: false }] });
		assert.equal(analyze("sed -n '330,420p' a.ts")?.ok, true);
		assert.equal(analyze("sed -n '$p' a.ts")?.ok, true);
		assert.equal(analyze("sed -n 10,\\$p a.ts")?.ok, true);
		assert.equal(analyze("sed --quiet -E -e 5p -e 10,20p a.ts")?.ok, true);
		assert.equal(analyze("sed -n -e 5p first second")?.ok, true);

		for (const text of [
			"sed -n -i 1,5p f",
			"sed -ni 1,5p f",
			"sed -n --in-place 1p f",
			"sed -n -f script.sed f",
			"sed -n 1,5w out f",
			"sed -n '1e rm -rf ~' f",
			"sed -n 's/a/b/e' f",
			"sed -n '1,5p;w out' f",
			"sed -n '/foo/p' f",
			"sed -n 'r /etc/shadow' f",
			"sed 1,5p f",
			"sed -n $p f",
			"sed -n -e 's/x/y/w out' f",
		]) {
			assert.equal(analyze(text)?.ok, false, text);
		}
	});

	it("checks every sed operand as a file once -e gives the script", () => {
		const r = analyze("sed -n first -e 5p");
		assert.ok(r?.ok);
		assert.deepEqual(r.paths, [{ value: "first", tilde: false }]);
	});

	it("keeps long flags that abbreviate nothing denied, and find primaries exact", () => {
		assert.equal(analyze("sort --numeric-sort x")?.ok, true);
		assert.equal(analyze("grep --color=auto -rn x src")?.ok, true);
		assert.equal(analyze("tail --lines=5 log")?.ok, true);
		assert.equal(analyze("find . -name x -del")?.ok, true, "find does not abbreviate; -del is not -delete");
	});

	it("rejects paths attached to short flags", () => {
		assert.equal(analyze("grep -f/etc/patterns x")?.ok, false);
		assert.equal(analyze("grep -A3 x")?.ok, true);
	});

	it("does not treat echo and pwd operands as paths", () => {
		assert.deepEqual(analyze("echo /etc/passwd"), { ok: true, paths: [] });
	});
});

describe("cdEffect", () => {
	const effect = (text: string, cdpath?: string) => cdEffect(tokenize(text), cdpath);

	it("follows cd to a known directory, and cd alone to home", () => {
		assert.deepEqual(effect("cd apps/server"), { kind: "dir", target: { value: "apps/server", tilde: false } });
		assert.deepEqual(effect("cd"), { kind: "dir", target: { value: "~", tilde: true } });
	});

	it("loses track of cd -, variables, CDPATH and directory-changing builtins", () => {
		for (const text of ["cd -", "cd $D", "pushd x", "builtin cd x", "eval cd x", "CDPATH=/ x", "(cd x)"]) {
			assert.equal(effect(text).kind, "unknown", text);
		}

		assert.equal(effect("cd src", "/etc").kind, "unknown");
		assert.equal(effect("cd ./src", "/etc").kind, "dir", "CDPATH is not used for ./ paths");
	});

	it("follows assignments: only CDPATH and HOME matter for later paths", () => {
		for (const text of ["d=1", "export d=1 e", "local x", "FOO=1 grep x"]) {
			assert.deepEqual(effect(text), { kind: "none" }, text);
		}

		for (const text of ["HOME=/etc", "export HOME=/x", "unset HOME"]) {
			assert.deepEqual(effect(text), { kind: "home" }, text);
		}

		for (const text of ["CDPATH=/", "export CDPATH=/", "declare -n x=y", "export $x=1", "CDPATH=/ cd etc"]) {
			assert.equal(effect(text).kind, "unknown", text);
		}

		assert.deepEqual(effect("FOO=1 cd /etc"), { kind: "dir", target: { value: "/etc", tilde: false } });
	});

	it("loses track of a command name only known at run time, which may be cd", () => {
		assert.equal(effect("$c /etc").kind, "unknown");
		assert.equal(effect('"$c" /etc').kind, "unknown");
	});

	it("leaves other commands alone", () => {
		assert.deepEqual(effect("grep x"), { kind: "none" });
	});
});

describe("decide: read-only commands", () => {
	it("allows the cd && grep | head pattern agents use inside the project", () => {
		const command = `cd ${cwd}/apps/server && grep -n "createRfc\\|readRfc" src/*.ts | head -20`;
		assert.equal(action(command), "allow");
	});

	it("allows reads in directories a path rule allows", () => {
		assert.equal(action("cat ~/work/notes.md"), "allow");
		assert.equal(action("cd ~/work/x && grep -rn todo ."), "allow");
	});

	it("asks for reads outside the project and allowed directories", () => {
		for (const command of [
			"grep -r token ~/.ssh",
			"head < ~/.ssh/id_rsa",
			"cat ~/.s*/id_rsa",
			"cat /etc/passwd",
			"cd ~ && cat .ssh/id_rsa",
			"cd .. && cat notes.txt",
			"cd /tmp || cat x",
			"cat ../outside",
		]) {
			assert.equal(action(command), "ask", command);
		}
	});

	it("keeps track of the directory across assignments that do not touch it", () => {
		assert.equal(action("d=1; sed -n 1,5p a.ts; cat b.ts | head -5"), "allow");
		assert.equal(action("export NODE_ENV=test && cat package.json"), "allow");
	});

	it("takes setting variables as harmless, but not a redirection in it", () => {
		assert.deepEqual(analyze("d=1"), { ok: true, paths: [] });
		assert.deepEqual(analyze("export NODE_ENV=test PATH"), { ok: true, paths: [] });
		assert.notEqual(analyze("d=1 > out")?.ok, true, "a redirection writes a file");
		assert.equal(analyze("export -n x")?.ok, undefined, "flags are not followed");
	});

	it("asks for ~ and a bare cd once HOME was set or unset", () => {
		for (const command of ["HOME=/etc; cat ~/passwd", "export HOME=/etc && cd && cat passwd", "unset HOME; cat ~/x"]) {
			assert.equal(action(command), "ask", command);
		}
	});

	it("asks after a command name only known at run time", () => {
		assert.equal(action("c=cd; $c /etc && cat passwd"), "ask");
	});

	it("asks when a path depends on something it cannot know", () => {
		for (const command of [
			"cat $HOME/.ssh/id_rsa",
			"cat ~root/x",
			"cd - && cat x",
			"cd $D && cat x",
			"pushd /etc && cat passwd",
			"builtin cd /etc && cat passwd",
			"pushd /etc && ls",
			"eval x && grep -r token",
		]) {
			assert.equal(action(command), "ask", command);
		}

		assert.equal(action("cd etc && cat passwd", "/"), "ask", "CDPATH");
	});

	it("allows the sed -n | grep | head reads agents send inside the project", () => {
		const command = `cd ${cwd}/src && sed -n 1,60p index.ts | grep -v "^ \\*\\|^$" | head -40; sed -n 330,420p index.ts`;
		assert.equal(action(command), "allow");
		assert.equal(action("sed -n 1,5p /etc/passwd"), "ask", "outside the project");
	});

	it("asks for read-only commands used to write or run programs", () => {
		for (const command of ["find . -delete", "rg --pre sh x", "sort -o out x", "cat x > out", "uniq a b"]) {
			assert.equal(action(command), "ask", command);
		}
	});

	it("lets command rules decide", () => {
		assert.equal(action("cat my-secret.txt"), "deny");
		assert.equal(action("sudo cat x"), "deny");
	});

	it("keeps path rules on reads a command rule allows", () => {
		const both = mergeConfigs({ commands: { "cat *": "yes-i-am-very-sure" }, paths: { "~/.ssh/**": "deny" } });
		assert.equal(decide(both, "bash", { command: "cat ~/.ssh/id_rsa" }, { cwd }).action, "deny");
	});

	it("asks for every read when readonly is off", () => {
		const off = mergeConfigs({ readonly: false });
		assert.equal(decide(off, "bash", { command: "cat x" }, { cwd }).action, "ask");
	});

	it("shows both paths when a read goes through a symlink", () => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-permissions-ro-link-")));
		fs.writeFileSync(path.join(dir, "target"), "x");
		fs.symlinkSync(path.join(dir, "target"), path.join(dir, "link"));
		const [, reason] = bash(`cat ${dir}/link`).reasons.map(formatReason);
		assert.equal(reason, `${dir}/target (symlink from ${dir}/link) → outside the project, no rule: ask`);
	});

	it("reduces an agent's cd + script + grep command to the one decision that matters", () => {
		const command = [
			`cd ${cwd} && python3 - <<'EOF'`,
			"p = 'src/policy.ts'",
			"def r(a, b):",
			"    global s",
			"open(p, 'w').write(s)",
			"EOF",
			'grep -n "describe" -A25 test/policy.test.ts | head -30',
		].join("\n");

		const d = bash(command);
		assert.equal(d.action, "ask");
		assert.deepEqual(d.reasons.filter(needsDecision).map(formatReason), [`"python3 - <<'EOF'" → no rule: ask`]);
		assert.equal(d.reasons.filter((r) => !needsDecision(r)).length, 3, "cd, grep and head are allowed");
	});

	it("reports the same cause once, not per segment", () => {
		const skipped = bash("eval x && cat a && cat b").reasons.filter((r) => r.kind === "skipped");
		assert.equal(skipped.length, 1);
	});

	describe("protected paths", () => {
		const ext = path.join(cwd, "ext");
		const run = (command: string) => decide(cfg, "bash", { command }, { cwd, protectedPaths: [ext] }).action;

		it("lets a command made only of reads mention them", () => {
			assert.equal(run(`cd ${ext}/src && grep -n x *.ts | head -5`), "allow");
			assert.equal(run("cat .pi/permissions.json"), "allow");
		});

		it("still asks when any segment is not a read", () => {
			assert.equal(run(`cat ${ext}/a && rm ${ext}/a`), "ask");
			assert.equal(run(`git log ${ext}`), "ask", "explicit allow rules are not proven read-only");
			assert.equal(run(`cat ${ext}/a > ${ext}/b`), "ask");
			assert.equal(run(`rg --pre sh x ${ext}`), "ask");
		});
	});

	it("still asks for risky constructs", () => {
		assert.equal(action("cat $(echo x)"), "ask");
	});

	it("says why a read-only command asks, and marks operands that are not files", () => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-permissions-ro-why-")));
		fs.writeFileSync(path.join(dir, "types.d.ts"), "x");
		const reasons = bash(`cd ${dir} && grep -n "execute(" types.d.ts`).reasons.map(formatReason);
		assert.ok(
			reasons.includes(`"grep -n \"execute(\" types.d.ts" → read-only command, reads outside the project: ask`),
		);
		assert.ok(
			reasons.includes(`${dir}/execute( (no such file, checked as a path) → outside the project, no rule: ask`),
		);
		assert.ok(reasons.includes(`${dir}/types.d.ts → outside the project, no rule: ask`), "a real file is not marked");

		const ruled = mergeConfigs({ paths: { "**/.env": "ask" } });
		const [head] = decide(ruled, "bash", { command: "cat .env" }, { cwd }).reasons.map(formatReason);
		assert.equal(head, `"cat .env" → read-only command, a path rule applies: ask`);
	});

	it("explains the decision", () => {
		assert.deepEqual(bash("cat x").reasons.map(formatReason), [`"cat x" → read-only command: allow`]);

		assert.deepEqual(bash("cat ~/.ssh/id_rsa").reasons.map(formatReason), [
			`"cat ~/.ssh/id_rsa" → read-only command, reads outside the project: ask`,
			`${home}/.ssh/id_rsa (no such file, checked as a path) → outside the project, no rule: ask`,
		]);

		assert.deepEqual(bash("rg --pre sh x").reasons.map(formatReason), [
			`"rg --pre sh x" → no rule: ask`,
			`"rg --pre sh x" → not read-only: --pre is not read-only`,
		]);
	});
});
