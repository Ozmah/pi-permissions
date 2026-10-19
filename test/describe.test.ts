import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildBody } from "../src/body.ts";
import { parseConfig } from "../src/config.ts";
import { DESCRIPTION_ARG, describedBash } from "../src/describe.ts";

const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-permissions-describe-")));

describe("describedBash", () => {
	it("keeps Pi's bash tool and adds an optional description", () => {
		const tool = describedBash(cwd);
		assert.equal(tool.name, "bash");
		assert.ok(tool.parameters.properties.command);
		assert.ok(tool.parameters.properties[DESCRIPTION_ARG]);
		assert.deepEqual(tool.parameters.required, ["command"]);
	});

	it("runs the command without the description, in the session's cwd", async () => {
		const tool = describedBash("/");
		const params = { command: 'pwd; echo "$#"', [DESCRIPTION_ARG]: "Print the directory" };
		const sessionManager = { getSessionId: () => "s", getSessionFile: () => undefined };
		// SAFETY: Pi's bash tool reads only cwd, model, thinkingLevel and these two session methods from the context.
		const ctx = { cwd, sessionManager } as never;
		const result = await tool.execute("call-1", params, undefined, undefined, ctx);
		const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		assert.ok(text.includes(cwd), "ran in ctx.cwd, not the cwd it was created with");
		assert.ok(!text.includes("Print the directory"));
	});
});

describe("the agent's description in the prompt", () => {
	const lines = (input: Record<string, string>) =>
		buildBody("bash", input, undefined, []).map((l) => `${l.prefix ?? ""}${l.text}`);

	it("comes first, labeled as what the agent says", () => {
		assert.deepEqual(lines({ command: "ls", [DESCRIPTION_ARG]: " List the files " }).slice(0, 3), [
			"Agent says: List the files",
			"",
			"Command",
		]);
	});

	it("is left out when empty or missing", () => {
		assert.equal(lines({ command: "ls" })[0], "Command");
		assert.equal(lines({ command: "ls", [DESCRIPTION_ARG]: "  " })[0], "Command");
	});
});

describe("ui.describe_commands", () => {
	it("is a boolean, reported otherwise", () => {
		const errors: string[] = [];
		assert.deepEqual(parseConfig({ ui: { describe_commands: true } }, "f", errors).ui, { describe_commands: true });
		assert.equal(parseConfig({ ui: { describe_commands: "yes" } }, "f", errors).ui, undefined);
		assert.equal(errors.length, 1);
	});
});
