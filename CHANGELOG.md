# Changelog

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
