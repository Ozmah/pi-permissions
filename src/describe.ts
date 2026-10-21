/**
 * Opt-in (`ui.describe_commands`): the agent says what each bash command does, shown in the prompt as its claim.
 * Off by default because it replaces the built-in `bash` registration, which conflicts with any other
 * extension that replaces it too (Pi reports the conflict).
 */
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

export const DESCRIPTION_ARG = "description";

const DESCRIPTION_HINT =
	"What this command does, in a few words (e.g. 'Count lines in each source file'). Shown to the user when it asks for permission.";

/**
 * Pi's bash tool plus the optional description. The description never reaches
 * the shell: it is removed before the original tool runs, in the session's cwd.
 */
export function describedBash(cwd: string) {
	const base = createBashToolDefinition(cwd);

	const parameters = Type.Object({
		...base.parameters.properties,
		[DESCRIPTION_ARG]: Type.Optional(Type.String({ description: DESCRIPTION_HINT })),
	});

	return {
		...base,
		parameters,
		execute(
			toolCallId: string,
			params: Static<typeof parameters>,
			signal: AbortSignal | undefined,
			onUpdate: Parameters<typeof base.execute>[3],
			ctx: ExtensionToolContext,
		) {
			const { [DESCRIPTION_ARG]: _description, ...args } = params;

			return createBashToolDefinition(ctx.cwd).execute(toolCallId, args, signal, onUpdate, ctx);
		},
	};
}
