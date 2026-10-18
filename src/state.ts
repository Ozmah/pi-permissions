/**
 * Per-project opt-out ("classic Pi"), persisted outside any repository.
 *
 * File: ~/.pi/agent/permissions-state.json
 * { "version": 1, "disabled": { "/abs/project": { "since": "2026-01-01T00:00:00.000Z" } } }
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface PermissionState {
	version: 1;
	/** Working directories where the extension is disabled. Exact match. */
	disabled: Record<string, { since: string }>;
}

export function emptyState(): PermissionState {
	return { version: 1, disabled: {} };
}

/**
 * Reads the state file. A missing file is an empty state. An invalid file is
 * reported in `errors` and treated as empty, so permissions stay enabled.
 */
export function readState(file: string, errors: string[]): PermissionState {
	if (!fs.existsSync(file)) return emptyState();

	try {
		const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		const disabled = (raw as { disabled?: unknown } | null)?.disabled;

		if (typeof disabled !== "object" || disabled === null || Array.isArray(disabled)) {
			throw new Error('missing or invalid "disabled" object');
		}

		const state = emptyState();

		for (const [dir, entry] of Object.entries(disabled)) {
			const since = (entry as { since?: unknown } | null)?.since;

			if (path.isAbsolute(dir)) state.disabled[dir] = { since: typeof since === "string" ? since : "" };
		}

		return state;
	} catch (e) {
		errors.push(`${file}: ${(e as Error).message} (ignored, permissions stay enabled)`);

		return emptyState();
	}
}

/** Writes atomically: a temp file in the same directory, then rename. */
export function writeState(file: string, state: PermissionState): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

export function setDisabled(state: PermissionState, dir: string, disabled: boolean, now = new Date()): PermissionState {
	const next: PermissionState = { version: 1, disabled: { ...state.disabled } };

	if (disabled) next.disabled[dir] = { since: now.toISOString() };
	else delete next.disabled[dir];

	return next;
}
