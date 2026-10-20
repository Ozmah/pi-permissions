# Changelog

## Unreleased

- `codemode` (default `false`): codemode scripts run without asking, since every tool they call is checked on its own. A prompt for one of those calls says it was called by codemode. When codemode asks, its script is shown as highlighted JavaScript instead of an escaped JSON string.

## 0.5.0

The config format changed and the old one is ignored. Rules now list what must not happen (`halt`, `deny`, `ask`), anything without a rule asks, and "stfu pi" grants silence the prompts for a folder you trust. Read the Configuration section of the README before upgrading.

- A comment hides nothing. A `#` that starts a word comments out the rest of the line, as in bash, so a quote or `<<` in it no longer opens a fake quote or here-document that swallowed the next lines into an allowed command (`git status # it's` followed by `rm -rf ~`). The quote case also affected 0.3.0.
- An abbreviated long flag counts as the flag it abbreviates (`sort --o=file`, `grep --dereference`, `tail --fol`): GNU tools accept any unambiguous prefix, so these wrote or followed symlinks as read-only commands.
- A wildcard component that starts with a dot (`.*`, `.?`, `.[.]`) is not read-only: bash before 5.2, or with `globskipdots` off, expands it to `..` and could read outside the project.
- `ui.describe_commands` (default `false`): the bash tool gets an optional `description` argument where the agent says what the command does, shown in the prompt as `Agent says: …`. The description never reaches the shell and plays no part in the decision. It replaces Pi's `bash` registration, so another extension that does the same conflicts with it; it is read from the global config and needs `/reload`.
- `/permissions stfu` removes one session grant, picked from a list or named by its folder (`/permissions stfu ~/dev/app`, with completion). `/permissions reset` still clears them all.
- When an active "stfu pi" grant touches a call but does not cover it, the prompt says why: a subfolder of a folder-only grant, a `cd` that leaves the folder, or a call that always asks.
- `sed -n` printing line ranges (`sed -n 1,60p index.ts`) is a read-only command. Only that exact shape counts: `-i`, `-f` and any other script ask.
- A `$` that expands nothing (`grep "^$"`, `a$ b`) is a literal `$`, no longer taken for a variable. Such commands were not recognized as read-only.
- "stfu pi" is never offered for your home, a folder containing it (`/home`) or the root. A `cd` that widened the command's folder to `~` or above used to offer it.
- A read-only command that asks says why: "reads outside the project" or "a path rule applies". Operands that are no file (a `grep` pattern) are marked "no such file, checked as a path".
- Breaking: rules now list what must not happen. They live in `commands` (bash segments), `paths` (any tool) and `tools`, and take one of four values. `halt` blocks and alerts you, `deny` blocks, `ask` asks every time even under stfu, and `yes-i-am-very-sure` runs without asking. `"allow"` is no longer accepted. Anything without a rule asks, and the strictest matching rule wins. The old keys (`default`, `external_directory`, `bash`, `readonly_commands`) are reported as an error and ignored.
- `readonly` (default `true`): reads inside the project run without asking. That covers file tools and bash commands that only read (`cat`, `grep`, `head`, `rg`, `find`, `cd`...) when every path they read is inside the project or allowed by a path rule. Operands, `--flag=value` values and `< file` count as paths, `cd` is followed, and flags that write or run programs disqualify the command.
- Safety net: a `halt`, `deny` or `ask` command or path that appears anywhere in a bash command (`$(sudo …)`, `bash -c "sudo …"`, `/usr/bin/sudo`, a script) asks, and stfu does not skip it.
- The status bar shows `🤫 stfu pi on <folder>/` while a folder grant is active.
- Session grants are now "stfu pi on <folder>/": total access to a folder for every tool, bash included, with `a` for the folder and `d` for its subfolders too. For bash the folder is the one the command runs in, following its `cd`s. This replaces "Always: this exact command" and the per-tool directory and file grants. Agents today send endless one-liners chaining `cd`, pipes and inline scripts (blame Opus 5.5 and Sol 6.1), and an exact command never comes back twice. Grants stay in memory and never cover protected files or `halt`, `deny` and `ask` rules.
- Inline scripts (`python3 - <<'EOF'`, `python3 -c`, `node -e`, `bash -c`/`-s`, `ruby -e`, `perl -e`, `php -r`) are labeled in the prompt ("Python script, 12 lines") and highlighted in their language. This only changes the display: they still go through the command rules.
- Here-documents: the body is data for its command, no longer split into segments. Shown as a block under the command. Substitutions in an unquoted body and a missing delimiter ask. A here-document or here-string feeding a read-only command is allowed.
- Reasons are grouped: what needs a decision first, what is already allowed folded into one line. The same cause is reported once. A blocked call tells the agent only what was refused.
- Read-only reasons show both paths when a read goes through a symlink.
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
