# pi-permissions

Permission prompts for [Pi](https://pi.dev), for the slightly paranoid.

Every tool call is checked against your rules before it runs: allowed calls run, denied calls are blocked, everything else asks.

## Install

```sh
pi install git:github.com/Ozmah/pi-permissions
```

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

| Key | Applies to |
|---|---|
| `default` | Anything no rule matches. Default `ask`. |
| `tools` | Tools by name: `read`, `write`, `edit`, `ls`, `find`, `grep`, MCP and extension tools. |
| `external_directory` | Paths outside the working directory. Unmatched paths ask. |
| `bash` | Each segment of a bash command. |
| `ui.position` | `editor` (replaces the input), `center` or `top`. |

Values: `allow`, `ask`, `deny`.

`~/.pi/agent/permissions.json` is global. `<project>/.pi/permissions.json` applies to that project, only if it is trusted, and overrides the global file key by key. Both are read on every call; no `/reload` needed.

**Patterns.** `*` matches anything, including `/` and spaces; `?` one character. A trailing ` *` or `/*` also matches the bare prefix (`git status *` matches `git status`). `~/` is the home directory.

**Precedence.** The most specific pattern wins; on a tie, the strictest action. File tools take the strictest of their `tools` and `external_directory` rules.

**Bash.** Commands are split on `&&`, `||`, `|`, `;`, `&` and newlines, outside quotes, and every segment is checked. Command substitution, process substitution, redirection to a file and unclosed quotes always ask.

**Protected files.** Writing the permission files or the extension's own files always asks, whatever the rules.

## Prompt

| Key | Action |
|---|---|
| `Enter` | Selected option (`Yes` by default) |
| `y` / `n` | Yes / No |
| `t` | No, and tell pi what to do instead (one line, `Esc` goes back) |
| `a` / `d` | Always, for the rest of the session |
| `←` `→` `Tab` | Change selection |
| `↑` `↓` `PgUp` `PgDn` `Home` `End`, wheel | Scroll |
| `Esc` | No |

Each "always" option states what it covers:

| Tool | `a` | `d` |
|---|---|---|
| `read`, `ls`, `find`, `grep` | That directory | That directory and subfolders |
| `write`, `edit` | That file | That directory and subfolders |
| `bash` | That exact command | - |
| Tools without a path | Any input | - |

Grants live in memory and end with the session. They never cover protected files, and `deny` rules still apply.

## Turning it off

`/permissions off` disables the extension for the current working directory: tool calls run without checks, as in Pi without it. `/permissions off --session` lasts until the session ends. `/permissions on` re-enables it. The status bar shows `⚠ permissions off` while disabled.

## Limitations

- It is not a sandbox. It decides whether a call runs, not what the call can reach.
- Bash can touch paths that cannot be detected from the command text. Keep `"*": "ask"` in `bash`.
- A trailing `*` allows any argument, and some read-only commands can write through options (`git log --output=<file>`).
- The bash scanner is not a full shell parser. When unsure, it asks.
- While disabled, the agent can write any file, including the permission files.

## Development

Requires Node.js 22.18 or later.

```sh
npm install
npm run check   # typecheck + tests
pi -e ./        # try a local checkout without installing
```

## Contributing

Ok to use AI, just read your agent's crap and make sure it's good, or be forever banned if it looks vibed.

`npm run check` must pass.

## License

[MIT](LICENSE) © [Ozmah](https://ozmah.dev)
