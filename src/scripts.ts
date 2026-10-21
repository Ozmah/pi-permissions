/**
 * Inline scripts: code an interpreter runs from a flag (`python3 -c "…"`) or a here-document (`python3 - <<'EOF'`).
 * Display only: a script is arbitrary code, always decided by the bash rules, and its code is never parsed.
 */
import { type Segment, type Word, tokenize } from "./shell.ts";

/**
 * How an interpreter takes inline code.
 *
 * - `name`: shown to the user ("Python").
 * - `language`: the highlighter's language id.
 * - `codeFlags`: flags whose next word is the code.
 * - `stdinFlags`: flags that make it read the script from stdin; `-` always does.
 */
interface Interpreter {
	name: string;
	language: string;
	codeFlags: readonly string[];
	stdinFlags?: readonly string[];
}

const PYTHON: Interpreter = { name: "Python", language: "python", codeFlags: ["-c"] };
const SHELL: Interpreter = { name: "Shell", language: "bash", codeFlags: ["-c"], stdinFlags: ["-s"] };

const INTERPRETERS: ReadonlyMap<string, Interpreter> = new Map([
	["python", PYTHON],
	["python3", PYTHON],
	["node", { name: "JavaScript", language: "javascript", codeFlags: ["-e", "--eval", "-p", "--print"] }],
	["bash", SHELL],
	["sh", SHELL],
	["zsh", SHELL],
	["ruby", { name: "Ruby", language: "ruby", codeFlags: ["-e"] }],
	["perl", { name: "Perl", language: "perl", codeFlags: ["-e", "-E"] }],
	["php", { name: "PHP", language: "php", codeFlags: ["-r"] }],
]);

/** An interpreter's inline code; `name` is for the user ("Python"). */
export interface InlineScript {
	name: string;
	language: string;
	code: string;
	from: "heredoc" | "argument";
}

/** `python3.12` is `python3`. */
function interpreterOf(command: string): Interpreter | undefined {
	return INTERPRETERS.get(command.replace(/^(python3?)(\.\d+)*$/, "$1"));
}

export function inlineScript(segment: Segment): InlineScript | undefined {
	const tokens = tokenize(segment.text);
	const [head, ...rest] = tokens ?? [];

	if (head?.kind !== "word") return undefined;
	const interpreter = interpreterOf(head.value);

	if (!interpreter) return undefined;
	const { name, language } = interpreter;
	// Arguments only: the word after a redirection is its target (`<<'EOF'`, `2>/dev/null`).
	const words = rest.filter((t, i): t is Word => t.kind === "word" && rest[i - 1]?.kind !== "redirect");
	const flag = words.findIndex((w) => interpreter.codeFlags.includes(w.value));
	const code = flag >= 0 ? words[flag + 1] : undefined;

	if (code) return { name, language, code: code.value, from: "argument" };

	const heredoc = segment.heredocs?.[0];

	if (!heredoc) return undefined;
	// A file operand means the script is that file; stdin is then its input, not code.
	const stdin = words.some((w) => w.value === "-" || interpreter.stdinFlags?.includes(w.value));
	const operands = words.filter((w) => !w.value.startsWith("-"));

	if (!stdin && operands.length > 0) return undefined;

	return { name, language, code: heredoc.body, from: "heredoc" };
}
