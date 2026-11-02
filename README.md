# run-deck

Buttons above the Claude Code prompt for the commands Claude asks you to run yourself.

When a reply ends with a ```bash block, or when Claude calls the `request_user_action` tool, each command becomes a numbered row above the prompt. Press its digit at an empty prompt and the command runs on your machine; the exit code shows on the row, the output streams into a pane, and the result rides along with your next prompt so Claude sees what happened without you pasting anything.

```
 Run deck  3 commands from the last reply · 1/3 done
 1: gh auth login                                tmux
 2: npm run build                                ✓ exit 0
 3: git push origin main                         risky
 0: run all   c: copy   o: output   x: dismiss
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install run-deck --marketplace maslach-llc/run-deck
```

Answer `y` to add the marketplace, then pick a scope (user is the usual one).

## How it works

- `turn.complete`: the last fenced `bash`/`sh` block of a reply is parsed into actions. A `# comment` line above a command is its label, a bare `cd <dir>` sets the directory for the commands after it, and `\` continuations and heredocs stay one command.
- `request_user_action`: a tool Claude can call with `{ summary, actions: [{ label, command, kind, risk, why, cwd }] }`. When the tool was used in a turn, the reply's block is not parsed again.
- Three kinds. `shell` runs in the background with the output captured. `interactive` (logins, editors, anything that needs the keyboard) opens a tmux split with the command typed, or copies the command when there is no tmux. `manual` is a step outside the terminal; pressing it ticks it off.
- Risky commands (`rm -r`, `git push`, `sudo`, anything with `prod` in it, force flags, destroy/deploy verbs and the like) need a second press. The `confirm` option makes that always or never.
- `run all` runs the pending shell commands in order and stops at the first failure or the first risky one.
- On your next prompt, finished actions are attached as context for Claude: the command, the exit code and the last 30 lines of output. With `auto_continue` on, the mod sends that prompt itself as soon as every command has run.

## Keys

Digits `1`–`9` run a command and `0` runs them all, from an empty prompt. The letter keys (`c` copy the block, `o` output pane, `x` dismiss) need the band focused: `ctrl+x tab`, or a click. `/deck show` brings a dismissed deck back, `/deck clear` drops it, `/deck` toggles the output pane.

## Options

Set in `/config` or at install time:

| Option | Values | Default |
| --- | --- | --- |
| `confirm` | `risky`, `always`, `never` | `risky` |
| `output` | `pane`, `toast`, `quiet` | `pane` |
| `copy` | copy the whole block to the clipboard too | `false` |
| `auto_continue` | send the results to Claude without waiting for your next prompt | `false` |

## Teaching Claude to use the tool

The tool is listed to Claude in every session, but a line in your `CLAUDE.md` makes it reliable:

```
When you need me to run something myself, call request_user_action with every command in order, and still write the commands in the reply.
```

## Who wrote this

Parts of this mod were written with the help of a superintelligence. Or at
least something that types faster than we do and never needs coffee. A human
steered it, tested it and answers the issues, so the bugs are a joint effort.

## License

MIT for the code; the Maslach™ name and logo are not part of it. See
[`NOTICE.md`](NOTICE.md).
