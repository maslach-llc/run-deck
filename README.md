# run-deck

Buttons above the Claude Code prompt for the commands Claude asks you to run yourself.

When a reply ends with a ```bash block, or when Claude calls the `request_user_action` tool, each command becomes a numbered row above the prompt. Press its digit at an empty prompt and the command runs on your machine; the exit code shows on the row and the result rides along with your next prompt, so Claude sees what happened without you pasting anything. When a command fails, its output goes to Claude straight away to fix. Nothing pops up when things work: press a finished row to see its output.

```
 Run deck · 3 commands from the last reply · 1/3 done
 1: opens tmux  gh auth login
 2: ✓ exit 0    npm run build
 3: not run ⚠   git push origin main
 0: run all   c: copy   x: dismiss   press a finished row for its output
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
- `run all` runs the pending commands in order and stops at the first failure. When a risky one is among them, the first `0` arms it (`press 0 again: run all`) and a second `0` within 8 seconds runs everything, the risky ones included.
- A failed command, with `on_error` at `fix` (the default), is sent to Claude at once with its output and a request to fix what it can and hand back only what you still need to run. `show` opens the output pane instead; `wait` marks the row and sends the result with your next prompt.
- Output stays out of the way: pressing a finished row opens a pane with that command's output, `r` runs it again, `f` asks Claude to fix it, and Esc closes it. With `output` at `always` the pane opens while every command runs.
- Once every result has reached Claude, the deck clears itself.
- On your next prompt, finished actions are attached as context for Claude: the command, the exit code and the last 30 lines of output. With `auto_continue` on, the mod sends that prompt itself as soon as every command has run.

## Keys

Digits `1`–`9` run a command (or, once it has run, open its output) and `0` runs them all, from an empty prompt. The letter keys (`c` copy the block, `x` dismiss) need the band focused: `ctrl+x tab`, or a click. In the output pane: `r` run again, `f` ask Claude to fix, `q` or Esc close. `/deck show` brings a dismissed deck back, `/deck clear` drops it, `/deck` toggles the output pane.

Bare digits only work while the prompt is empty. To press a row while you are typing, bind the mod's shortcut commands in `~/.claude/keybindings.json` (`/keybindings` opens it); Alt plus a digit is free in most terminals:

```json
{
  "bindings": [
    {
      "context": "Chat",
      "bindings": {
        "meta+1": "command:deck-1",
        "meta+2": "command:deck-2",
        "meta+3": "command:deck-3",
        "meta+0": "command:deck-all",
        "meta+d": "command:deck-hide",
        "meta+a": "command:deck-answer"
      }
    }
  ]
}
```

`deck-1` to `deck-9` press a row, `deck-all` runs everything pending, `deck-hide` folds the band to one row (naming the key that brings it back) or opens it again, and `deck-answer` scrolls the transcript to where the last answer starts. Each also works typed as a slash command.

## Options

Set in `/config` or at install time:

| Option | Values | Default |
| --- | --- | --- |
| `confirm` | `risky`, `always`, `never` | `risky` |
| `output` | `on-demand` (pane only when you open it), `always` | `on-demand` |
| `on_error` | `fix` (send to Claude now), `show` (open the output), `wait` | `fix` |
| `background` | a color for the band and pane (`#11111b`, a theme name), empty for none | empty |
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
