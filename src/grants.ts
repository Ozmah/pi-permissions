/**
 * "Always this session" grants. In memory only; never written to disk.
 *
 * Agents chain `cd`, pipes and inline scripts into one huge command, so a grant
 * on an exact command never matches twice. Grants are by folder instead: total
 * access to a folder lets every tool, bash included, work there for the session.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { JsonObject } from "./config.ts";
import { isInside } from "./policy.ts";

export type Grant =
	/** Any input, for tools without a path (MCP and extension tools). */
	| { kind: "tool"; tool: string }
	/** Every tool, bash included, inside `dir` (and its subfolders when `recursive`). */
	| { kind: "access"; dir: string; recursive: boolean };

export interface GrantChoice {
	key: string;
	label: string;
	grant: Grant;
}

/** Path segments kept when shortening a path for a button label. */
const LABEL_SEGMENTS = 2;

export interface CallTarget {
	tool: string;
	input: JsonObject;
	/** Resolved path for file tools. */
	absPath?: string;
	/** Every directory a bash command may run in; undefined when that cannot be known. */
	dirs?: string[];
	/** Asks every time (an `ask` rule, a protected file, a mentioned strict rule): no grant covers it. */
	firm?: boolean;
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

/** Deepest directory containing all of `dirs`. */
function commonDir(dirs: string[]): string {
	return dirs.reduce((common, d) => {
		let c = common;

		while (!isInside(d, c)) c = path.dirname(c);

		return c;
	});
}

/** Folders too broad to silence: one stray keypress would grant the whole home or disk. */
function tooBroad(dir: string): boolean {
	return dir === os.homedir() || dir === path.parse(dir).root;
}

/** The folder a call works in, which is what a grant is offered for. Never home or the root. */
function folderOf(target: CallTarget): string | undefined {
	const folder = target.absPath ? scopeDir(target.absPath) : target.dirs?.length ? commonDir(target.dirs) : undefined;

	return folder && !tooBroad(folder) ? folder : undefined;
}

function covers(grant: { dir: string; recursive: boolean }, p: string, isDir: boolean): boolean {
	if (grant.recursive) return isInside(p, grant.dir);

	return p === grant.dir || (!isDir && path.dirname(p) === grant.dir);
}

export function grantMatches(grant: Grant, target: CallTarget): boolean {
	if (grant.kind === "tool") return grant.tool === target.tool && !target.absPath;

	if (target.firm) return false;

	if (target.absPath) return covers(grant, target.absPath, false);

	return target.dirs !== undefined && target.dirs.every((d) => covers(grant, d, true));
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
	if (grant.kind === "tool") return `${grant.tool}: any input`;
	const home = os.homedir();
	const dir = grant.dir === home || grant.dir.startsWith(`${home}/`) ? `~${grant.dir.slice(home.length)}` : grant.dir;

	return `stfu pi on ${dir}/${grant.recursive ? " and subfolders" : ""}`;
}

/** The "always" options offered for a call, each with an explicit label. */
export function grantChoices(target: CallTarget): GrantChoice[] {
	const folder = folderOf(target);

	if (!folder) {
		// No folder to offer (unknown, home or root): file tools and bash get no grant.
		if (target.tool === "bash" || target.absPath) return [];
		const { tool } = target;

		return [{ key: "a", label: `Always: ${tool} (any input)`, grant: { kind: "tool", tool } }];
	}

	// A firm question is never covered by a grant, so none is offered.
	if (target.firm) return [];
	const short = shortPath(folder);

	return [
		{ key: "a", label: `stfu pi on ${short}/`, grant: { kind: "access", dir: folder, recursive: false } },
		{
			key: "d",
			label: `stfu pi on ${short}/ and subfolders`,
			grant: { kind: "access", dir: folder, recursive: true },
		},
	];
}
