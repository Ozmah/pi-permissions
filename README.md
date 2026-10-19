# pi-permissions

Permission prompts for [Pi](https://pi.dev), for the slightly paranoid.

Every tool call is checked against your rules before it runs: allowed calls run, denied calls are blocked, everything else asks.

## Install

```sh
pi install git:github.com/Ozmah/pi-permissions@v0.3.0
```

The `@v0.3.0` tag pins the version. Without it you get the latest commit of the default branch.

Create `~/.pi/agent/permissions.json` (start from [`permissions.example.json`](permissions.example.json)) and run `/reload`. Without it, every tool call asks.

## Usage

Run `/permissions` to see the active rules, session grants and available commands.

![/permissions](docs/permissions.jpg)

## Configuration

```json
{
  "default": "ask",
  "tools": { "read": "allow", "edit": "ask", "write": "ask" },
  "external_directory": { "~/projects/*": "allow", "*": "ask" },
  "bash": { "git status *": "allow", "sudo *": "deny", "*": "ask" },
  "ui": { "position": "editor" }
}
```

| Key                  | Applies to                                                                             |
| -------------------- | -------------------------------------------------------------------------------------- |
| `default`            | Anything no rule matches. Default `ask`.                                               |
| `tools`              | Tools by name: `read`, `write`, `edit`, `ls`, `find`, `grep`, MCP and extension tools. |
| `external_directory` | Paths outside the working directory. Unmatched paths ask.                              |
| `bash`               | Each segment of a bash command.                                                        |
| `readonly_commands`  | Bash segments that only read, see below. Unset: off.                                   |
| `ui.position`        | `editor` (replaces the input), `center` or `top`.                                      |

Values: `allow`, `ask`, `deny`.

`~/.pi/agent/permissions.json` is global. `<project>/.pi/permissions.json` applies to that project, only if it is trusted, and overrides the global file key by key. Both are read on every call; no `/reload` needed.

**Patterns.** `*` matches anything, including `/` and spaces; `?` one character. A trailing ` *` or `/*` also matches the bare prefix (`git status *` matches `git status`). `~/` is the home directory.

**Precedence.** The most specific pattern wins; on a tie, the strictest action. File tools take the strictest of their `tools` and `external_directory` rules.

**Bash.** Commands are split on `&&`, `||`, `|`, `;`, `&` and newlines, outside quotes, and every segment is checked. Command substitution, process substitution, redirection to a file and unclosed quotes always ask. Here-document bodies (`<<EOF`, `<<'EOF'`, `<<-EOF`) are data for their command, not segments: the prompt shows them as a block under it. A substitution in an unquoted here-document asks, and so does a missing delimiter.

Inline scripts (`python3 - <<'EOF'`, `python3 -c`, `node -e`, `bash -c`, `ruby -e`, `perl -e`, `php -r`) are labeled and highlighted in their language. They are arbitrary code: they always go through the bash rules, and their content is shown, never interpreted.

The prompt lists first what needs a decision, then folds what is already allowed into one line.

**Read-only commands.** With `"readonly_commands": "allow"`, a segment that only reads gets that action when every path it reads is inside the project or allowed by `external_directory`, so `cd apps/server && grep -n foo src/*.ts | head -20` runs without asking. Explicit `bash` rules still win; it only replaces the `"*"` fallback or the default, and never makes them stricter.

- Commands: `cat`, `head`, `tail`, `wc`, `ls`, `cut`, `grep`, `egrep`, `fgrep`, `rg`, `find`, `sort`, `uniq`, `echo`, `pwd`, `cd`.
- Flags that write, run programs or follow symlinks disqualify the segment: `find -exec/-delete/-fprint/-L`, `rg --pre/-L`, `grep -R`, `sort -o`, `tail -f`, `uniq in out`. So do output redirections other than `/dev/null` or an fd, and here-documents.
- Every operand is checked as a path, patterns included. `grep "/api" src` asks for `/api` when it is outside the project: a wrong guess adds a prompt, never skips one. Input redirections (`< file`) are checked too.
- `cd` is followed: later relative paths are checked against every directory the command may be in. `cd -`, `cd $VAR`, `pushd`, `builtin`, `eval`, assignments, and `cd name` with `$CDPATH` set lose track, and later relative paths ask.
- Variables, `~user`, subshells, brace expansion and comments are not resolved: the segment asks. A glob is checked by its fixed directory (`src/*.ts` → `src`); `..` after a wildcard asks.

**Protected files.** Writing the permission files or the extension's own files always asks, whatever the rules. A bash command that mentions them asks too, unless every segment is a read-only command.

## Prompt

| Key                                       | Action                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `Enter`                                   | Selected option (`Yes` by default)                                             |
| `y` / `n`                                 | Yes / No                                                                       |
| `m`                                       | Yes, and add a message to the tool result (one line, `Esc` goes back)          |
| `t`                                       | No, and tell pi what to do instead (one line, `Esc` goes back)                 |
| `a` / `d`                                 | Always, for the rest of the session                                            |
| `←` `→` `Tab`                             | Change selection (also `↑` `↓` when options are one per row)                   |
| Click an option                           | Select it; click it again to confirm (fullscreen mode only)                    |
| `↑` `↓` `PgUp` `PgDn` `Home` `End`, wheel | Scroll (`↑` `↓` select instead when options are one per row)                   |
| `Shift+↑` `Shift+↓`                       | Scroll, in any layout. In fullscreen Pi keeps `PgUp` `PgDn` for the transcript |
| `Esc`                                     | No                                                                             |

Each "always" option states what it covers:

| Tool                         | `a`                | `d`                           |
| ---------------------------- | ------------------ | ----------------------------- |
| `read`, `ls`, `find`, `grep` | That directory     | That directory and subfolders |
| `write`, `edit`              | That file          | That directory and subfolders |
| `bash`                       | That exact command | -                             |
| Tools without a path         | Any input          | -                             |

Grants live in memory and end with the session. They never cover protected files, and `deny` rules still apply.

## Turning it off

`/permissions off` disables the extension for the current working directory: tool calls run without checks, as in Pi without it. `/permissions off --session` lasts until the session ends. `/permissions on` re-enables it. The status bar shows `⚠ permissions off` while disabled.

## Limitations

- It is not a sandbox. It decides whether a call runs, not what the call can reach.
- Bash can touch paths that cannot be detected from the command text. Keep `"*": "ask"` in `bash`.
- A trailing `*` allows any argument, and some read-only commands can write through options (`git log --output=<file>`).
- The bash scanner is not a full shell parser. When unsure, it asks.
- Read-only commands: a glob that matches a symlink inside the project can read where the symlink points.
- While disabled, the agent can write any file, including the permission files.

## Development

Requires Node.js 22.18 or later.

```sh
npm install
npm run check          # format, lint (incl. anti-slop), typecheck, tests
npm run format         # apply formatting
npm run lint -- --fix  # apply spacing fixes
pi -e ./               # try a local checkout without installing
```

## Contributing

Ok to use AI, just read your agent's crap and make sure it's good, or be forever banned if it looks vibed.

`npm run check` must pass.

## License

[MIT](LICENSE) © [Ozmah](https://ozmah.dev)
