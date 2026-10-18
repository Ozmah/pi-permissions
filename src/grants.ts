/**
 * "Always this session" grants. In memory only; never written to disk.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isInside } from "./policy.ts";

export type Grant =
	| { kind: "command"; command: string }
	| { kind: "tool"; tool: string }
	| { kind: "file"; tool: string; path: string }
	| { kind: "dir"; tool: string; dir: string; recursive: boolean };

export interface GrantChoice {
	key: string;
	label: string;
	grant: Grant;
}

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "ls", "find", "grep"]);

/** Path segments kept when shortening a path for a button label. */
const LABEL_SEGMENTS = 2;

export interface CallTarget {
	tool: string;
	input: Record<string, unknown>;
	/** Resolved path for file tools. */
	absPath?: string;
	/** The target is a protected permission file: only exact-file grants apply. */
	protected?: boolean;
}

/** The directory a file-tool call works in: the target itself if it is a directory. */
function scopeDir(absPath: string): string {
	try {
		if (fs.statSync(absPath).isDirectory()) return absPath;
	} catch {
		// does not exist yet (e.g. a new file)
	}

	return path.dirname(absPath);
}

export function grantMatches(grant: Grant, target: CallTarget): boolean {
	switch (grant.kind) {
		case "command":
			return target.tool === "bash" && grant.command === String(target.input.command ?? "");
		case "tool":
			return grant.tool === target.tool;
		case "file":
			return grant.tool === target.tool && grant.path === target.absPath;
		case "dir": {
			if (grant.tool !== target.tool || !target.absPath || target.protected) return false;
			const p = target.absPath;

			return grant.recursive ? isInside(p, grant.dir) : p === grant.dir || path.dirname(p) === grant.dir;
		}
	}
}

/** Home as `~`, and long paths reduced to their last segments: `…/Temp/soloterm-clipboard`. */
export function shortPath(p: string): string {
	const home = os.homedir();
	const short = p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
	const parts = short.split("/").filter(Boolean);

	if (parts.length <= LABEL_SEGMENTS + 1) return short;

	return `…/${parts.slice(-LABEL_SEGMENTS).join("/")}`;
}

/** Full, explicit description for the /permissions card. */
export function describeGrant(grant: Grant): string {
	const home = os.homedir();
	const tilde = (p: string) => (p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);

	switch (grant.kind) {
		case "command":
			return `bash: ${grant.command}`;
		case "tool":
			return `${grant.tool}: any input`;
		case "file":
			return `${grant.tool}: ${tilde(grant.path)}`;
		case "dir":
			return `${grant.tool}: in ${tilde(grant.dir)}/${grant.recursive ? " and subfolders" : ""}`;
	}
}

/** The "always" options offered for a call, each with an explicit label. */
export function grantChoices(target: CallTarget): GrantChoice[] {
	const { tool, absPath } = target;

	if (tool === "bash") {
		const command = String(target.input.command ?? "");

		return [{ key: "a", label: "Always: this exact command", grant: { kind: "command", command } }];
	}

	if (!absPath) return [{ key: "a", label: `Always: ${tool} (any input)`, grant: { kind: "tool", tool } }];

	const dir = scopeDir(absPath);

	const recursive: GrantChoice = {
		key: "d",
		label: `Always: ${tool} in ${shortPath(dir)}/ and subfolders`,
		grant: { kind: "dir", tool, dir, recursive: true },
	};

	const narrow: GrantChoice = READ_ONLY_TOOLS.has(tool)
		? { key: "a", label: `Always: ${tool} in ${shortPath(dir)}/`, grant: { kind: "dir", tool, dir, recursive: false } }
		: { key: "a", label: `Always: ${tool} ${shortPath(absPath)}`, grant: { kind: "file", tool, path: absPath } };

	// Directory grants never cover protected files, so do not offer one for them.
	return target.protected ? [narrow] : [narrow, recursive];
}
