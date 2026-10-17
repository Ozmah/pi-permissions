# Changelog

## Unreleased

- Syntax highlighting with Pi's highlighter and theme: bash commands, `write` content, both sides of `edit` diffs. Diff signs keep their red/green.
- Markdown files use Pi's Markdown colors (headings, code, links, bullets, quotes); fenced code blocks are highlighted in their own language.
- `/permissions off` disables the extension for the current working directory (persistent); `/permissions off --session` until the session ends; `/permissions on` re-enables.
- Status bar shows `⚠ permissions off` while disabled.
- Argument completion for `/permissions`.
- `/permissions` shows a colored summary card in the transcript (not sent to the model).
- Prompt reasons are colored: action by meaning (allow / ask / deny), matched pattern highlighted.
- "Always" grants by scope, each labeled explicitly: `a` covers the directory for read-only tools and the exact file for `write`/`edit`; `d` covers the directory and subfolders. Directory grants never cover protected files.
- Prompt options stack one per row when they do not fit on one.
- When a path goes through a symlink, the prompt shows both: `Path: /etc/os-release → /usr/lib/os-release (symlink)`. Rules and grants keep using the real path.

## 0.2.0

- Scrollable prompt: fixed options, full command visible regardless of length.
- `ui.position`: `editor` (default, replaces the input editor), `center`, `top`.
- Bash commands shown split by operator, exactly as evaluated.
- `edit` prompts show a diff; `write` prompts show the content.
- Reasons state which rule matched, and report `"*"` as the fallback.
- Control characters in prompts are shown as placeholders instead of being interpreted.
- Writes to permission files and the extension's own files always ask.
- `>&file` and `> /dev/null…` are no longer treated as harmless redirections.
- An aborted agent run closes an open prompt as a denial.
- Packaged as a Pi package, with tests.

## 0.1.0

- `allow` / `ask` / `deny` rules for tools, external directories and bash commands.
- Global and per-project (trusted) configuration.
- Bash commands split into segments; each segment is evaluated.
- "Always this session" grants and the `/permissions` command.
