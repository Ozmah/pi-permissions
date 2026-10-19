# Changelog

## Unreleased

- The status bar shows `🤫 stfu pi on <folder>/` while a folder grant is active.
- Session grants are now **"stfu pi on <folder>/"**, total access to a folder: `a` that folder, `d` it and its subfolders, for every tool, bash included (the folder a command runs in, following its `cd`s). Replaces "Always: this exact command" and the per-tool directory and file grants. Agents today send endless one-liners chaining `cd`, pipes and inline scripts (blame Opus 5.5 and Sol 6.1): an exact command never comes back, a trusted folder does. Grants stay in memory, never cover protected files, and `deny` rules still apply.
- Inline scripts (`python3 - <<'EOF'`, `python3 -c`, `node -e`, `bash -c`/`-s`, `ruby -e`, `perl -e`, `php -r`) are labeled in the prompt ("Python script, 12 lines") and highlighted in their language. Display only: they still go through the bash rules.
- Here-documents: the body is data for its command, no longer split into segments. Shown as a block under the command. Substitutions in an unquoted body and a missing delimiter ask. A here-document or here-string feeding a read-only command is allowed.
- Reasons are grouped: what needs a decision first, what is already allowed folded into one line. The same cause is reported once. A blocked call tells the agent only what was refused.
- Read-only reasons show both paths when a read goes through a symlink.
- `readonly_commands`: bash segments that only read (`cat`, `grep`, `head`, `rg`, `find`, `cd`...) take this action when every path they read is inside the project or allowed by `external_directory`. Off unless set; explicit `bash` rules still win. Operands, `--flag=value` values and `< file` are checked as paths; `cd` is followed; flags that write or run programs disqualify the segment.
- A bash command made only of read-only segments may mention the permission files and the extension's own files without asking: the protection is against writes.
- `m`: "Yes, with a message". Approves the call and appends one line from the user to its result, so the agent reads it with the output. An empty message is a plain Yes.
- When the options are stacked one per row, `↑` `↓` change the selection instead of scrolling; `PgUp` `PgDn` `Home` `End` and the wheel still scroll. The hint shows the keys for the current layout.
- Options are clickable in fullscreen mode: the first click selects, a second click on the same option confirms. A single stray click never approves.
- `Shift+↑` `Shift+↓` scroll the prompt in any layout. In fullscreen Pi keeps `PgUp` `PgDn` for the transcript, which left stacked options with no keyboard scroll.

## 0.3.0

- Development: oxlint with vendored anti-slop rules, oxfmt formatting, and CI on GitHub Actions.
- Tool calls whose input is not JSON are blocked, since they cannot be inspected.
- `t`: "No, tell pi what to do". Denies and sends one line of instructions to the agent, typed inside the prompt while the command stays visible.
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
