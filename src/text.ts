/** Everything shown in a prompt comes from the agent and is untrusted. */

/**
 * Replaces control characters (including ESC) with visible placeholders so that
 * untrusted text cannot move the cursor, recolor, or hide parts of itself.
 */
export function sanitize(text: string): string {
	return (
		text
			.replace(/\t/g, "    ")
			.replace(/\r/g, "")
			// oxlint-disable-next-line no-control-regex -- matching control characters is the point: they get neutralized.
			.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (c) =>
				c === "\x1b" ? "␛" : `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
			)
	);
}

/**
 * Keeps only SGR color/style sequences (`ESC[...m`) in highlighter output and
 * neutralizes any other escape sequence. Input must already be sanitized; this
 * is defense in depth against the highlighter itself.
 */
export function onlySgr(text: string): string {
	// oxlint-disable-next-line no-control-regex -- ESC is matched on purpose to neutralize non-color sequences.
	return text.replace(/\x1b(?!\[[0-9;]*m)/g, "␛");
}
