# pi-permissions

Allow / ask / deny rules for [Pi](https://pi.dev) tool calls.

Every tool call is checked against rules before it runs. Allowed calls run, denied calls are blocked, and the rest open a prompt.

## Install

```sh
pi install git:github.com/Ozmah/pi-permissions
```

Then create `~/.pi/agent/permissions.json` (see [`permissions.example.json`](permissions.example.json)) and run `/reload`.

Without a config file every tool call asks.

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
| `tools` | Tool names: `read`, `write`, `edit`, `ls`, `find`, `grep`, MCP and extension tools. `bash` is governed by the `bash` key only. |
| `external_directory` | Paths outside the working directory used by `read`, `write`, `edit`, `ls`, `find`, `grep`. Unmatched paths ask. |
| `bash` | Each segment of a bash command. |
| `ui.position` | Where the prompt appears: `editor`, `center` or `top`. |

Values are `allow`, `ask` or `deny`.

Files:

- `~/.pi/agent/permissions.json`: global.
- `<project>/.pi/permissions.json`: per project, loaded only if the project is trusted. Overrides the global file key by key.

Both are read on every tool call; changes apply without `/reload`.

### Patterns

- `*` matches any characters, including `/` and spaces. `?` matches one character.
- A trailing ` *` or `/*` also matches the bare prefix: `git status *` matches `git status`.
- `~/` expands to the home directory in `external_directory`.

### Precedence

- The most specific matching pattern wins (most non-wildcard characters). On a tie, the strictest action wins (`deny` > `ask` > `allow`).
- File tools use the strictest of the `tools` rule and the `external_directory` rule.

### Bash

A command is split on `&&`, `||`, `|`, `;`, `&` and newlines, outside quotes. Every segment is checked; the strictest result applies.

These always require at least `ask`:

- Command substitution: `$(...)`, backticks.
- Process substitution: `<(...)`, `>(...)`.
- Redirection to a file. `2>&1` and `> /dev/null` are not counted.
- Unclosed quotes.

### Protected files

Writing the permission files or the extension's own files always asks, whatever the rules. For bash this is best effort: any command mentioning `permissions.json` or those paths asks.

## Prompt

| Key | Action |
|---|---|
| `Enter` | Confirm the selected option (`Yes` by default) |
| `y` / `n` / `a` | Yes / No / Always this session |
| `←` `→` `Tab` | Change selection |
| `↑` `↓` `PgUp` `PgDn` `Home` `End`, mouse wheel | Scroll |
| `Esc` | No |

- **Always this session** remembers the exact command, or the tool and path, until the session ends.
- On **No**, the agent is told not to retry and to ask how to proceed.
- Without a TUI (e.g. RPC) a plain selection dialog is used, truncated to 40 lines. Without any UI, calls that ask are blocked.

Positions:

- `editor`: replaces the input editor until answered.
- `center`: floating box centered over the transcript, sized to its content.
- `top`: floating box at the top of the screen.

## Commands

- `/permissions`: show loaded files, merged rules and session grants.
- `/permissions reset`: clear session grants.

## Limitations

- This is not a sandbox. It decides whether a tool call runs; it does not isolate what runs.
- Bash can read and write paths that cannot be detected from the command text. Use `ask` for anything not explicitly allowed.
- A trailing `*` allows any arguments. Some read-only commands can write files through options, e.g. `git log --output=<file>`.
- The bash scanner is not a full shell parser. When it cannot tell, it errs towards `ask`.

## Development

Requires Node.js 22.18 or later.

```sh
npm install
npm run check   # typecheck + tests
```

Try a local checkout without installing it:

```sh
pi -e ./
```

## License

[MIT](LICENSE) © [Ozmah](https://ozmah.dev)
