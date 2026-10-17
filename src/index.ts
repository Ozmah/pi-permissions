/**
 * pi-permissions: allow / ask / deny rules for Pi tool calls.
 *
 * Config: ~/.pi/agent/permissions.json, plus <project>/.pi/permissions.json when
 * the project is trusted (overrides the global file key by key).
 */
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildBody, plainBody } from "./body.ts";
import { type PermissionConfig, type PromptPosition, defaultConfig, mergeConfigs, readConfigFile } from "./config.ts";
import { decide, resolvePath } from "./policy.ts";
import { type BodyLine, type Choice, PermissionPrompt, sanitize } from "./prompt-ui.ts";

const GLOBAL_CONFIG = path.join(os.homedir(), ".pi", "agent", "permissions.json");
const PROJECT_CONFIG = path.join(".pi", "permissions.json");

/** Package root (parent of src/), protected from writes like the config files. */
const EXTENSION_ROOT = packageRoot();

function packageRoot(): string | undefined {
	try {
		return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	} catch {
		return undefined; // loader without a file: URL; config files stay protected
	}
}

/** Max body lines in the plain select() fallback used by non-TUI clients. */
const FALLBACK_MAX_LINES = 40;

const DENIED_REASON = "The user denied this action. Do not retry it; ask the user how to proceed.";

interface LoadedConfig {
	cfg: PermissionConfig;
	files: string[];
	errors: string[];
}

function loadConfig(cwd: string, trusted: boolean): LoadedConfig {
	const errors: string[] = [];
	const files: string[] = [];
	const layers = [];
	const candidates = trusted ? [GLOBAL_CONFIG, path.join(cwd, PROJECT_CONFIG)] : [GLOBAL_CONFIG];
	for (const file of candidates) {
		try {
			const layer = readConfigFile(file, errors);
			if (layer) {
				layers.push(layer);
				files.push(file);
			}
		} catch (e) {
			// Unreadable or invalid JSON: ignore all files, so every call asks.
			errors.push(`${file}: ${(e as Error).message}`);
			return { cfg: defaultConfig(), files, errors };
		}
	}
	return { cfg: mergeConfigs(...layers), files, errors };
}

function grantKey(toolName: string, input: Record<string, unknown>, absPath: string | undefined): string {
	if (toolName === "bash") return `bash:${String(input.command ?? "")}`;
	return absPath ? `${toolName}:${absPath}` : `tool:${toolName}`;
}

export default function (pi: ExtensionAPI) {
	/** Grants from "Always this session". Exact command or tool + path. */
	const sessionGrants = new Set<string>();
	let lastErrors = "";

	pi.on("session_start", async () => {
		sessionGrants.clear();
	});

	pi.on("tool_call", async (event, ctx) => {
		const cwd = resolvePath(ctx.cwd, ctx.cwd);
		const { cfg, errors } = loadConfig(cwd, ctx.isProjectTrusted());

		const errorText = errors.join("\n");
		if (errorText && errorText !== lastErrors && ctx.hasUI) {
			lastErrors = errorText;
			ctx.ui.notify(sanitize(`permissions: configuration errors\n${errorText}`), "warning");
		}

		const input = event.input as Record<string, unknown>;
		const protectedPaths = [GLOBAL_CONFIG, path.join(cwd, PROJECT_CONFIG)];
		if (EXTENSION_ROOT) protectedPaths.push(EXTENSION_ROOT);
		const d = decide(cfg, event.toolName, input, { cwd, protectedPaths });
		if (d.action === "allow") return undefined;

		const why = d.reasons.join("\n");
		if (d.action === "deny") {
			if (ctx.hasUI) ctx.ui.notify(sanitize(`⛔ Blocked: ${event.toolName}\n${why}`), "warning");
			return { block: true, reason: `Blocked by permission policy:\n${why}` };
		}

		const key = grantKey(event.toolName, input, d.absPath);
		if (sessionGrants.has(key)) return undefined;
		if (!ctx.hasUI) return { block: true, reason: `Requires confirmation but no UI is available:\n${why}` };

		const body = buildBody(event.toolName, input, d.absPath, d.reasons);
		const choice = await ask(ctx, `🔐 ${event.toolName} requires permission`, body, cfg.ui.position);
		if (choice === "always") sessionGrants.add(key);
		if (choice === "no") return { block: true, reason: DENIED_REASON };
		return undefined;
	});

	pi.registerCommand("permissions", {
		description: "Show the active permission config (/permissions reset clears session grants)",
		handler: async (args, ctx) => {
			if (args.trim() === "reset") {
				sessionGrants.clear();
				ctx.ui.notify("Session grants cleared", "info");
				return;
			}
			const { cfg, files, errors } = loadConfig(resolvePath(ctx.cwd, ctx.cwd), ctx.isProjectTrusted());
			const lines = [
				`Files: ${files.length ? files.join(", ") : "(none, everything asks)"}`,
				`default: ${cfg.default}`,
				`tools: ${JSON.stringify(cfg.tools)}`,
				`external_directory: ${JSON.stringify(cfg.external_directory)}`,
				`bash: ${JSON.stringify(cfg.bash)}`,
				`ui.position: ${cfg.ui.position}`,
				`Session grants: ${sessionGrants.size ? [...sessionGrants].join(" | ") : "(none)"}`,
			];
			if (errors.length) lines.push(`Errors:\n${errors.join("\n")}`);
			ctx.ui.notify(sanitize(lines.join("\n")), errors.length ? "warning" : "info");
		},
	});
}

/** Where and how large the prompt is for each position. */
const LAYOUTS = {
	editor: { overlay: false, maxHeightRatio: 0.6 },
	center: {
		overlay: true,
		maxHeightRatio: 0.85,
		overlayOptions: { width: "90%", minWidth: 40, maxHeight: "85%", anchor: "center" },
	},
	top: {
		overlay: true,
		maxHeightRatio: 0.85,
		overlayOptions: { width: "100%", maxHeight: "85%", anchor: "top-center" },
	},
} as const;

async function ask(ctx: ExtensionContext, title: string, body: BodyLine[], position: PromptPosition): Promise<Choice> {
	if (ctx.mode !== "tui") {
		const yes = "Yes";
		const always = "Yes, always this session";
		const picked = await ctx.ui.select(sanitize(`${title}\n\n${plainBody(body, FALLBACK_MAX_LINES)}`), [
			yes,
			"No",
			always,
		]);
		return picked === yes ? "yes" : picked === always ? "always" : "no";
	}

	const signal = ctx.signal;
	if (signal?.aborted) return "no";
	const layout = LAYOUTS[position];

	return ctx.ui.custom<Choice>(
		(tui, theme, _keybindings, done) => {
			let finished = false;
			const finish = (choice: Choice) => {
				if (finished) return;
				finished = true;
				signal?.removeEventListener("abort", onAbort);
				done(choice);
			};
			// An aborted agent run closes the prompt as a denial.
			const onAbort = () => finish("no");
			signal?.addEventListener("abort", onAbort, { once: true });
			return new PermissionPrompt(tui, theme, title, body, { maxHeightRatio: layout.maxHeightRatio }, finish);
		},
		layout.overlay ? { overlay: true, overlayOptions: layout.overlayOptions } : undefined,
	);
}
