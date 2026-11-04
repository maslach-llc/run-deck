import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, UiPressArgument } from 'claude-code'

import type { Action, ActionKind, ActionRisk, Choice, Deck } from '../types'
import { classifyKind, classifyRisk, lastShellBlock, parseBlock, shorten, stepKey } from './parse'

const PANE = 'run-deck'
const TOOL = 'request_user_action'
const TOOL_NAME = 'mcp__run-deck__request_user_action'
const OUTPUT_LINES = 300
const TAIL_LINES = 40
const TAIL_CHARS = 6000

const deck = atom({ plugin: 'run-deck', key: 'deck' } as const, null, { shape: 'deck-2' })
const selected = atom({ plugin: 'run-deck', key: 'selected' } as const, null, { shape: 'selected-1' })

type Surface = UiPressArgument['surface']

type Options = {
  confirm: 'risky' | 'always' | 'never'
  output: 'on-demand' | 'always'
  onError: 'fix' | 'show' | 'wait'
  copy: boolean
  autoContinue: boolean
  background: string
  /** Context fill, in percent, at which a finished turn offers /clear; 0 never. */
  suggestClear: number
  /** j / k move the band's focus ring between rows while the band is focused. */
  vimKeys: boolean
}

// Module state: set again by register and session.start after a hot reload.
let options: Options = {
  confirm: 'risky',
  output: 'on-demand',
  onError: 'fix',
  copy: false,
  autoContinue: false,
  background: '',
  suggestClear: 60,
  vimKeys: false,
}
let sessionCwd = '.'
let hasToolDeckThisTurn = false
let isRunningAll = false
// Actions started and not yet finished. Checked synchronously so a second
// press (or run all) during the awaits before the state says "running"
// cannot start the same command twice.
const inFlight = new Set<string>()
// The transcript rows of recent assistant text, by render instance, so the
// start of the final answer can be scrolled to.
let replyRows: { id: string; head: string }[] = []
let answerRow: string | null = null
// The key the person bound to `command:deck-hide`, for the hidden deck's row.
let hideKey: string | null = null
// The band's render instance and the row its focus ring is on, for j / k.
let bandId: string | null = null
let bandFocus: string | null = null

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const

export const register: Register = (on, rawOptions) => {
  options = {
    confirm: pick(rawOptions.confirm, ['risky', 'always', 'never'], 'risky'),
    output: pick(rawOptions.output, ['on-demand', 'always'], 'on-demand'),
    onError: pick(rawOptions.on_error, ['fix', 'show', 'wait'], 'fix'),
    copy: rawOptions.copy === true,
    autoContinue: rawOptions.auto_continue === true,
    background: typeof rawOptions.background === 'string' ? rawOptions.background.trim() : '',
    suggestClear: typeof rawOptions.suggest_clear === 'number' ? Math.max(0, Math.min(100, rawOptions.suggest_clear)) : 60,
    vimKeys: rawOptions.vim_keys === true,
  }

  // ---------------------------------------------------------------- session

  on('session.start', async ($, e, next) => {
    sessionCwd = e.cwd
    hideKey = await boundKey($, 'command:deck-hide')
    await $.tool.register({
      name: TOOL,
      isDeferred: false,
      description:
        'Queue commands the user must run themselves (interactive logins, steps you cannot or should not run, manual steps) as numbered rows in the run deck. ' +
        'Results reach you with the user\'s next prompt; a failed command usually comes back right away, so fix the cause and re-queue only what is still needed. ' +
        'Call it at most once per reply, with every command in execution order. Commands may also appear in the reply text; the deck is not parsed from the text when the tool was called. ' +
        'Optional: `choices` for a decision the user must make (radio when answers exclude each other, checkboxes when several may apply) and `reply` actions for a one-press go-ahead. ' +
        'Use them when they save the user typing, not for every question. Keep labels short; the reply text carries the explanation. Refer to it as "the run deck".',
      inputSchema: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'One line saying what the commands are for, shown above the buttons.',
          },
          actions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Short label, e.g. "Log in to GitHub".' },
                command: {
                  type: 'string',
                  description:
                    'The shell command; for kind "manual" the step to take; for kind "slash" the slash command with its arguments; for kind "reply" the prompt text it sends.',
                },
                kind: {
                  type: 'string',
                  enum: ['shell', 'interactive', 'manual', 'slash', 'reply'],
                  description:
                    'shell: run in the background, output captured. interactive: needs the keyboard (logins, editors), opened in a tmux split. manual: a step outside the terminal (a restart, a dashboard click, a command on another machine), the full step as its command; the user ticks it off. ' +
                    'slash: a Claude Code slash command run in this session, such as /clear when the work is finished and what comes next is unrelated, or /compact with what to keep; list it last. ' +
                    "reply: a go-ahead the user can send with one press, e.g. 'yes: fix the blintz bug'; the command is the prompt text.",
                },
                risk: {
                  type: 'string',
                  enum: ['safe', 'risky'],
                  description: 'risky needs a second press before it runs (deletes, pushes, production).',
                },
                why: { type: 'string', description: 'One line on why this is needed.' },
                cwd: { type: 'string', description: 'Directory to run in; the session directory when left out.' },
              },
              required: ['label', 'command'],
            },
          },
          choices: {
            type: 'array',
            description:
              'Questions the user answers by picking options, shown under the actions and sent together as the user\'s next prompt. ' +
              'Use them for decisions; keep `reply` actions for a single go-ahead.',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', description: 'The question, short, e.g. "Default for the Ideas tab".' },
                multi: {
                  type: 'boolean',
                  description: 'false (default): radio, exactly one answer. true: checkboxes, any number of answers.',
                },
                options: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: 'The answer as the user would say it, e.g. "Keep it off by default".' },
                      description: { type: 'string', description: 'Optional: one short line on what it means.' },
                    },
                    required: ['label'],
                  },
                },
              },
              required: ['question', 'options'],
            },
          },
        },
      },
    })
    await $.command.register({
      name: 'deck',
      description: 'Run deck: show the buttons again, clear them, or toggle the output pane',
      argumentHint: '[show|clear|output]',
    })
    // One command per shortcut, so a keybinding (`command:deck-1`) can press a
    // row while the prompt holds a draft, where a bare digit types instead.
    for (const d of DIGITS) {
      await $.command.register({ name: `deck-${d}`, description: `Run deck: press row ${d}`, immediate: true })
    }
    await $.command.register({ name: 'deck-all', description: 'Run deck: run all pending commands', immediate: true })
    await $.command.register({ name: 'deck-answer', description: 'Scroll to the start of the last answer', immediate: true })
    await $.command.register({ name: 'deck-hide', description: 'Run deck: hide the band, or show it again', immediate: true })

    return next(e)
  })

  // ------------------------------------------------------------ the sources

  on('tool.call', { tool: TOOL_NAME }, async ($, e) => {
    const given = Array.isArray(e.actions) ? (e.actions as unknown[]) : []
    const actions = given.map((raw, i) => fromTool(raw, i)).filter((a): a is Action => a !== null)
    const asked = Array.isArray(e.choices) ? (e.choices as unknown[]) : []
    const choices = asked.map((raw, i) => choiceFromTool(raw, i)).filter((c): c is Choice => c !== null)
    if (actions.length === 0 && choices.length === 0) {
      return {
        deny: 'request_user_action needs a non-empty "actions" list with a "command" on each, or "choices" with a question and at least two options each.',
      }
    }

    hasToolDeckThisTurn = true
    const summary =
      typeof e.summary === 'string' && e.summary.trim()
        ? e.summary.trim()
        : actions.length > 0
          ? `${actions.length} to run`
          : `${choices.length} to answer`
    await replaceDeck($, { source: 'tool', summary, actions, ...(choices.length > 0 ? { choices } : {}), isHidden: false })

    const parts = [actions.length > 0 ? `${actions.length} action(s)` : '', choices.length > 0 ? `${choices.length} choice(s)` : ''].filter(Boolean)
    return {
      result: `Queued ${parts.join(' and ')} in the run deck. Their results and answers will arrive with the user's next prompt; do not wait for them now. Refer to it as the run deck, never "above the prompt".`,
    }
  })

  on('turn.start', ($, e, next) => {
    if (!e.agentId) hasToolDeckThisTurn = false

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId || e.isAborted) return next(e)
    if (e.answer.trim()) {
      const head = headOf(e.answer)
      answerRow = [...replyRows].reverse().find(r => head.startsWith(r.head) || r.head.startsWith(head))?.id ?? null
    }
    if (!hasToolDeckThisTurn) await deckFromReply($, e.answer)
    await suggestClear($)

    return next(e)
  })

  // --------------------------------------------------------- results back

  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)
    // A new prompt instead of /clear: the offer is withdrawn, and made again
    // at the end of the turn while the context is still that full.
    let current = await update($, deck, d => (d ? { ...d, actions: d.actions.filter(a => a.id !== CLEAR_ID) } : d))
    if (current && current.actions.length === 0 && !hasOpenChoices(current)) {
      await clearDeck($)
      current = null
    }
    if (!current) return next(e)

    const finished = current.actions.filter(a => !a.isReported && (a.status === 'done' || a.status === 'failed'))
    if (finished.length === 0) return next(e)

    const report = reportOf(current, finished)
    const entered = await next({ ...e, context: [...(e.context ?? []), report] })
    if (!entered.drop) {
      const after = await update($, deck, d =>
        d ? { ...d, actions: d.actions.map(a => (finished.some(f => f.id === a.id) ? { ...a, isReported: true } : a)) } : d,
      )
      // Everything ran and Claude has it: the deck has done its job.
      if (after && isSettled(after)) await clearDeck($)
    }

    return entered
  })

  // --------------------------------------------------------------- command

  on('command.run', { command: 'deck' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'clear') {
      await clearDeck($)
      return { text: 'Run deck cleared.' }
    }
    if (arg === 'show') {
      await update($, deck, d => (d ? { ...d, isHidden: false } : d))
      return { text: 'Run deck shown.' }
    }
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    if (isOpen) await $.ui.close({ id: PANE })
    else await openPane($, { focus: false })
    return { text: isOpen ? 'Output pane closed.' : 'Output pane opened.' }
  })

  // ------------------------------------------------------- the answer rows

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    if (!e.props.isSummary) {
      const head = headOf(e.props.text)
      if (head) {
        replyRows = [...replyRows.filter(r => r.id !== e.requestId), { id: e.requestId, head }].slice(-50)
      }
    }
    return next(e)
  })

  // ------------------------------------------------------------ shortcuts

  on('command.run', async ($, e, next) => {
    const name = e.command
    if (name === 'deck-all') {
      await runAll($, undefined)
      return {}
    }
    if (name === 'deck-hide') {
      const current = await read($, deck)
      if (!current) return { text: 'No run deck to hide.' }
      if (current.isHidden) await update($, deck, d => (d ? { ...d, isHidden: false } : d))
      else await dismiss($)
      return {}
    }
    if (name === 'deck-answer') {
      if (!answerRow) return { text: 'No answer to jump to yet.' }
      const moved = await $.ui.scroll({ to: { requestId: answerRow }, block: 'start' })
      return moved.deny ? { text: `Could not scroll: ${moved.deny}` } : {}
    }
    const row = /^deck-([1-9])$/.exec(name)
    if (row) {
      const current = await read($, deck)
      const target = current ? rowsOf(current)[Number(row[1]) - 1] : undefined
      if (!target || !current) return {}
      // A row that submits a prompt (the send row, a reply, a pick-one option
      // that sends on the pick) runs after this hook returns: the engine
      // refuses $.prompt.submit from a command.run hook, whose turn it holds.
      if (submitsOnPress(current, target)) $.clock.after(0, () => void pressRow($, target, undefined))
      else await pressRow($, target, undefined)
      return {}
    }
    return next(e)
  })

  // ------------------------------------------------------------ the band

  // Where the band's focus ring is, so j / k know which row to move from. The j / k
  // buttons themselves are not rows: a press on one leaves the last row recorded.
  on('ui.focus', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.element !== MOVE_DOWN && e.element !== MOVE_UP) bandFocus = e.element ?? null
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    bandId = e.requestId
    const current = await read($, deck)
    if (e.props.hasSurvey || !current || (current.actions.length === 0 && !hasOpenChoices(current))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)

    if (current.isHidden) {
      const left = current.actions.filter(a => a.status === 'pending' || a.status === 'armed' || a.status === 'running').length
      const failed = current.actions.filter(a => a.status === 'failed').length
      const asking = openChoices(current).length
      const counts = [left > 0 ? `${left} to run` : '', failed > 0 ? `${failed} failed` : '', asking > 0 ? `${asking} to answer` : '']
        .filter(Boolean)
        .join(', ')
      return (
        <Box paddingX={1} backgroundColor={options.background || undefined}>
          <Button key="unhide" plain dimColor onPress={() => void update($, deck, d => (d ? { ...d, isHidden: false } : d))}>
            Run deck hidden{counts ? ` · ${counts}` : ''} · {hideKey ? `${hideKey} shows it` : '/deck-hide shows it'}
          </Button>
        </Box>
      )
    }

    // Room for a row's text: the band less its padding, the `1: ` hotkey mark,
    // the space and the status chip, so nothing wraps onto a second line.
    const room = Math.max(12, e.props.bodyColumns - 2 - 3 - STATUS_WIDTH - 1)
    const done = current.actions.filter(a => a.status === 'done').length
    const hasPending = current.actions.some(a => a.status === 'pending' || a.status === 'armed')
    const hasRisky = current.actions.some(a => (a.status === 'pending' || a.status === 'armed') && isRunnable(a) && needsConfirm(a))
    const rows = rowsOf(current)
    const hotkeyOf = (row: Row): string | undefined => {
      const i = rows.findIndex(r => sameRow(r, row))
      return i >= 0 && i < 9 ? String(i + 1) : undefined
    }
    const pendingRunnable = current.actions.filter(a => (a.status === 'pending' || a.status === 'armed') && isRunnable(a)).length
    const nCommands = pendingRunnable === 1 ? 'the 1 command' : `the ${pendingRunnable} commands`

    const actionRow = (a: Action, mark?: string) => (
      <Button
        key={a.id}
        plain
        hotkey={hotkeyOf({ type: 'action', id: a.id })}
        dimColor={a.status === 'done' || a.status === 'skipped'}
        onPress={p => void press($, a.id, p.surface)}
      >
        <Text color={chipColor(a)} dimColor={a.status === 'pending' && a.risk === 'safe' && a.kind === 'shell'}>
          {(mark ?? chip(a)).padEnd(STATUS_WIDTH)}
        </Text>{' '}
        {rowText(a, room)}
      </Button>
    )

    // Related rows sit together under a heading: the commands, the replies (each its own go-ahead: one
    // press sends it, the others stay), and each question with its options.
    type Group = { key: string; head: string; note?: string; rows: RenderChildren[] }
    const groups: Group[] = []
    const commands = current.actions.filter(a => a.kind !== 'reply')
    if (commands.length > 0) {
      groups.push({
        key: 'commands',
        head: 'Commands',
        rows: commands.map(a => actionRow(a)),
      })
    }
    const replies = current.actions.filter(a => a.kind === 'reply')
    if (replies.length > 0) {
      groups.push({
        key: 'replies',
        head: 'Reply',
        note: 'one press sends it',
        rows: replies.map(a => actionRow(a)),
      })
    }
    for (const c of current.choices ?? []) {
      if (c.isSent) {
        // sent: one dim line with the answer, so the rest of the deck reads as what is left
        const labels = c.options.filter(o => c.picked.includes(o.id)).map(o => o.label)
        groups.push({
          key: c.id,
          head: c.question,
          note: 'sent',
          rows: [
            <Text key={`${c.id}-sent`} dimColor wrap="truncate-end">
              <Text color="success">{'✓ sent'.padEnd(STATUS_WIDTH)}</Text> {shorten(labels.join(', ') || 'none of them', room)}
            </Text>,
          ],
        })
        continue
      }
      groups.push({
        key: c.id,
        head: c.question,
        note: c.isMulti ? 'pick any' : sendsOnPick(current) ? 'pick one, it sends' : 'pick one',
        rows: c.options.map(o => {
          const isPicked = c.picked.includes(o.id)
          const mark = c.isMulti ? (isPicked ? '[x]' : '[ ]') : isPicked ? '(•)' : '( )'
          const text = o.description ? `${o.label} · ${o.description}` : o.label
          return (
            <Button
              key={`${c.id}-${o.id}`}
              plain
              hotkey={hotkeyOf({ type: 'option', choiceId: c.id, optionId: o.id })}
              onPress={() => void pickOption($, c.id, o.id)}
            >
              <Text color={isPicked ? 'success' : undefined}>{mark.padEnd(STATUS_WIDTH)}</Text>{' '}
              <Text dimColor={!isPicked}>{shorten(text, room)}</Text>
            </Button>
          )
        }),
      })
      if (!sendsOnPick(current)) {
        // each question sends on its own, so they can be answered one at a time
        const isAnswered = c.picked.length > 0
        groups[groups.length - 1]!.rows.push(
          <Button key={sendKey(c.id)} plain hotkey={hotkeyOf({ type: 'send', choiceId: c.id })} onPress={() => void sendAnswers($, c.id)}>
            <Text color={isAnswered ? 'success' : undefined} dimColor={!isAnswered}>
              {'send'.padEnd(STATUS_WIDTH)}
            </Text>{' '}
            <Text dimColor={!isAnswered}>{isAnswered ? 'send this answer' : 'pick an answer first'}</Text>
          </Button>,
        )
      }
    }
    const hasHeads = groups.length > 1

    return (
      <Box flexDirection="column" paddingX={1} backgroundColor={options.background || undefined}>
        <Text wrap="truncate-end">
          <Text bold>Run deck</Text>
          <Text dimColor>
            {' · '}
            {current.summary}
            {done > 0 ? ` · ${done}/${current.actions.length} done` : ''}
          </Text>
        </Text>
        {groups.map(g => (
          <Box key={`g-${g.key}`} flexDirection="column">
            {hasHeads && (
              <Text wrap="truncate-end">
                <Text bold>{g.head}</Text>
                {g.note && <Text dimColor>{` · ${g.note}`}</Text>}
              </Text>
            )}
            <Box flexDirection="column" paddingLeft={hasHeads ? 2 : 0}>
              {g.rows}
            </Box>
          </Box>
        ))}
        <Box gap={2}>
          {hasPending && pendingRunnable > 0 && (
            // run all leads the bottom row: it runs only the commands, never a reply or a question
            <Button key="all" plain hotkey="0" onPress={p => void runAll($, p.surface)}>
              {current.isAllArmed ? (
                <Text color="warning">press again: run {nCommands}</Text>
              ) : hasRisky ? (
                <Text color="warning">run all ⚠ ({pendingRunnable})</Text>
              ) : (
                <Text>run all ({pendingRunnable})</Text>
              )}
            </Button>
          )}
          <Button key="details" plain hotkey="i" onPress={() => void showDetails($)}>
            details
          </Button>
          <Button key="copy" plain hotkey="c" onPress={p => void $.ui.copy({ text: blockOf(current), surface: p.surface })}>
            copy
          </Button>
          <Button key="dismiss" plain hotkey="x" role="dismiss" onPress={() => void dismiss($)}>
            dismiss
          </Button>
          {options.vimKeys && (
            <Button key={MOVE_DOWN} plain hotkey="j" onPress={() => void moveFocus($, 1)}>
              down
            </Button>
          )}
          {options.vimKeys && (
            <Button key={MOVE_UP} plain hotkey="k" onPress={() => void moveFocus($, -1)}>
              up
            </Button>
          )}
        </Box>
      </Box>
    )
  })

  // ------------------------------------------------------------ the pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const current = await read($, deck)
    const id = await read($, selected)
    const action = current?.actions.find(a => a.id === id) ?? lastStarted(current) ?? current?.actions[0]

    if (!current || !action) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No commands yet. Esc closes this pane.</Text>
        </Box>
      )
    }

    // The details: the whole command (or manual step, or reply) and its why, wrapped, never cut.
    const at = indexOf(current, action.id)
    const cols = Math.max(20, e.props.bodyColumns)
    const isManual = action.kind === 'manual'
    const isText = isManual || action.kind === 'reply'
    const head = isText ? action.label : `$ ${action.command}`
    const body = isText && action.command !== action.label ? action.command : ''
    const headRows = [head, body, action.why ?? '', action.cwd ? `in ${action.cwd}` : ''].reduce((n, t) => n + (t ? Math.ceil((t.length + 4) / cols) : 0), 0)
    const lines = action.output ?? (action.tail ? action.tail.split('\n') : [])
    const hasRun = action.status === 'running' || action.status === 'done' || action.status === 'failed'
    const room = Math.max(1, e.props.scroll.bodyRows - 2 - headRows)
    const shown = lines.slice(-room)
    const hasSiblings = current.actions.length > 1

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text bold wrap="wrap">
            {at + 1}. {head}
          </Text>
          <Text color={chipColor(action)}>{chip(action)}</Text>
        </Box>
        {body && <Text wrap="wrap">{body}</Text>}
        {action.why && (
          <Text dimColor wrap="wrap">
            why: {action.why}
          </Text>
        )}
        {action.cwd && <Text dimColor wrap="wrap">in {action.cwd}</Text>}
        {!isText && hasRun && shown.length === 0 && <Text dimColor>{action.status === 'running' ? 'waiting for output…' : 'no output'}</Text>}
        {!isText && hasRun && shown.map(line => <Text wrap="truncate-end">{line || ' '}</Text>)}
        <Box gap={2}>
          {isManual && (
            <Button key="tick" plain hotkey="d" onPress={() => void tick($, action.id)}>
              {action.status === 'done' ? 'mark not done' : 'mark done'}
            </Button>
          )}
          {isRunnable(action) && hasRun && action.status !== 'running' && (
            <Button key="rerun" plain hotkey="r" onPress={p => void rerun($, action.id, p.surface)}>
              run again
            </Button>
          )}
          {action.status === 'failed' && (
            <Button key="fix" plain hotkey="f" onPress={() => void askToFix($, action.id)}>
              ask Claude to fix
            </Button>
          )}
          {hasSiblings && (
            <Button key="prev" plain hotkey="p" onPress={() => void step($, -1)}>
              previous
            </Button>
          )}
          {hasSiblings && (
            <Button key="next" plain hotkey="n" onPress={() => void step($, 1)}>
              next
            </Button>
          )}
          <Button key="close" plain hotkey="q" role="dismiss" onPress={() => void $.ui.close({ id: PANE })}>
            close
          </Button>
          <Text dimColor>Esc closes</Text>
        </Box>
      </Box>
    )
  })
}

// ------------------------------------------------------------------ helpers

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

function fromTool(raw: unknown, i: number): Action | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const command = typeof r.command === 'string' ? r.command.trim() : ''
  if (!command) return null
  const kinds: ActionKind[] = ['shell', 'interactive', 'manual', 'slash', 'reply']
  const risks: ActionRisk[] = ['safe', 'risky']
  const kind = kinds.includes(r.kind as ActionKind) ? (r.kind as ActionKind) : classifyKind(command)
  // /clear throws the conversation away, so it always takes a second press.
  const isClear = kind === 'slash' && /^\/clear\b/.test(command)
  const risk = isClear ? 'risky' : risks.includes(r.risk as ActionRisk) ? (r.risk as ActionRisk) : classifyRisk(command)

  return {
    id: `t${i + 1}`,
    label: typeof r.label === 'string' && r.label.trim() ? r.label.trim() : shorten(command),
    command,
    kind,
    risk,
    why: typeof r.why === 'string' && r.why.trim() ? r.why.trim() : undefined,
    cwd: typeof r.cwd === 'string' && r.cwd.trim() ? r.cwd.trim() : undefined,
    status: 'pending',
    isReported: false,
  }
}

function choiceFromTool(raw: unknown, i: number): Choice | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const question = typeof r.question === 'string' ? r.question.trim() : ''
  const given = Array.isArray(r.options) ? (r.options as unknown[]) : []
  const options = given
    .map((o, j) => {
      const opt = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>
      const label = typeof o === 'string' ? o.trim() : typeof opt.label === 'string' ? opt.label.trim() : ''
      if (!label) return null
      const description = typeof opt.description === 'string' && opt.description.trim() ? opt.description.trim() : undefined
      return description ? { id: `o${j + 1}`, label, description } : { id: `o${j + 1}`, label }
    })
    .filter((o): o is { id: string; label: string; description?: string } => o !== null)
  if (!question || options.length < 2) return null
  return { id: `c${i + 1}`, question, isMulti: r.multi === true, options, picked: [] }
}

/** Whether pressing `row` ends in $.prompt.submit. */
function submitsOnPress(d: Deck, row: Row): boolean {
  if (row.type === 'send') return true
  if (row.type === 'option') return sendsOnPick(d)
  return d.actions.find(a => a.id === row.id)?.kind === 'reply'
}

/** Questions not sent yet. */
function openChoices(d: Deck): Choice[] {
  return (d.choices ?? []).filter(c => !c.isSent)
}

function hasOpenChoices(d: Deck): boolean {
  return openChoices(d).length > 0
}

/**
 * Nothing left on the deck: every question sent, and every row either pressed and
 * reported or never to be pressed. A pending reply, a manual step not ticked off or a
 * result Claude has not had yet all keep it up. The /clear offer does not.
 */
function isSettled(d: Deck): boolean {
  if (hasOpenChoices(d)) return false
  return d.actions.every(
    a =>
      a.id === CLEAR_ID ||
      a.status === 'skipped' ||
      ((a.status === 'done' || a.status === 'failed') && a.isReported),
  )
}

const MOVE_DOWN = 'move-down'
const MOVE_UP = 'move-up'

/** The band Button key of a row, as the render draws it. */
function keyOfRow(row: Row): string {
  if (row.type === 'action') return row.id
  if (row.type === 'option') return `${row.choiceId}-${row.optionId}`
  return sendKey(row.choiceId)
}

/** The key of a question's send row. */
function sendKey(choiceId: string): string {
  return `${choiceId}-send`
}

/** j / k: move the band's focus ring one row down or up, stopping at the ends. */
async function moveFocus($: EngineInterface, by: 1 | -1): Promise<void> {
  const current = await read($, deck)
  if (!current || !bandId) return
  const to = stepKey(rowsOf(current).map(keyOfRow), bandFocus, by)
  if (!to) return
  const moved = await $.ui.focus({ requestId: bandId, key: to })
  if (!moved.deny) bandFocus = to
}

type Row = { type: 'action'; id: string } | { type: 'option'; choiceId: string; optionId: string } | { type: 'send'; choiceId: string }

/** Every numbered row of the band, in order: actions, then each question's options and its send. */
function rowsOf(d: Deck): Row[] {
  // the band's order: commands, then replies, then each question's options
  const ordered = [...d.actions.filter(a => a.kind !== 'reply'), ...d.actions.filter(a => a.kind === 'reply')]
  const rows: Row[] = ordered.map(a => ({ type: 'action', id: a.id }))
  if (!hasOpenChoices(d)) return rows
  for (const c of openChoices(d)) {
    for (const o of c.options) rows.push({ type: 'option', choiceId: c.id, optionId: o.id })
    if (!sendsOnPick(d)) rows.push({ type: 'send', choiceId: c.id })
  }
  return rows
}

function sameRow(a: Row, b: Row): boolean {
  if (a.type === 'action' && b.type === 'action') return a.id === b.id
  if (a.type === 'option' && b.type === 'option') return a.choiceId === b.choiceId && a.optionId === b.optionId
  if (a.type === 'send' && b.type === 'send') return a.choiceId === b.choiceId
  return false
}

/** One pick-one question and nothing else open: the pick is the answer. */
function sendsOnPick(d: Deck): boolean {
  const open = openChoices(d)
  return open.length === 1 && open[0]?.isMulti === false
}

function answersOf(choices: Choice[]): string {
  return choices
    .map(c => {
      const labels = c.options.filter(o => c.picked.includes(o.id)).map(o => o.label)
      return `${c.question}: ${labels.length > 0 ? labels.join(', ') : c.isMulti ? 'none of them' : 'no answer'}`
    })
    .join('\n')
}

function indexOf(d: Deck, id: string): number {
  return d.actions.findIndex(a => a.id === id)
}

function lastStarted(d: Deck | null): Action | undefined {
  return d ? [...d.actions].reverse().find(a => a.status === 'running' || a.status === 'done' || a.status === 'failed') : undefined
}

// Shell and interactive commands run on the machine; manual steps, slash
// commands and replies are pressed one by one, never by run all.
function isRunnable(a: Action): boolean {
  return a.kind === 'shell' || a.kind === 'interactive'
}

function rowText(a: Action, width: number): string {
  if (a.kind === 'reply') return shorten(a.label, width)
  const text = a.kind === 'manual' || a.label !== shorten(a.command) ? `${a.label}: ${a.command}` : a.command
  return shorten(text, width)
}

// The status column: every label fits in STATUS_WIDTH, so commands line up.
const STATUS_WIDTH = 11

function chip(a: Action): string {
  switch (a.status) {
    case 'armed':
      return 'press again'
    case 'running':
      return 'running…'
    case 'done':
      return a.kind === 'shell' ? '✓ exit 0' : a.kind === 'interactive' ? '✓ in tmux' : a.kind === 'slash' ? '✓ ran' : a.kind === 'reply' ? '✓ sent' : '✓ done'
    case 'skipped':
      return '– not picked'.slice(0, STATUS_WIDTH)
    case 'failed':
      return (a.kind === 'slash' ? '✗ failed' : `✗ exit ${a.exitCode ?? '?'}`).slice(0, STATUS_WIDTH)
    default:
      if (a.kind === 'interactive') return 'opens tmux'
      if (a.kind === 'manual') return 'to do'
      if (a.kind === 'reply') return 'sends it'
      return a.risk === 'risky' ? 'not run ⚠' : 'not run'
  }
}

function chipColor(a: Action): 'success' | 'error' | 'warning' | undefined {
  if (a.status === 'done') return 'success'
  if (a.status === 'failed') return 'error'
  if (a.status === 'armed' || a.risk === 'risky') return 'warning'
  return undefined
}

function blockOf(d: Deck): string {
  const lines: string[] = []
  let cwd: string | undefined
  for (const a of d.actions) {
    if (!isRunnable(a)) continue
    if (a.cwd !== cwd) {
      cwd = a.cwd
      if (cwd) lines.push(`cd ${cwd}`)
    }
    lines.push(a.command)
  }
  return `${lines.join('\n')}\n`
}

function tailOf(output: string, signal: string | null): string {
  const lines = output.replace(/\n+$/, '').split('\n')
  let tail = lines.slice(-TAIL_LINES).join('\n')
  if (tail.length > TAIL_CHARS) tail = `…${tail.slice(-TAIL_CHARS)}`
  if (lines.length > TAIL_LINES) tail = `… (${lines.length - TAIL_LINES} earlier lines not shown)\n${tail}`
  if (signal) tail += `\n[killed by ${signal}]`
  return tail
}

function outcomeOf(a: Action): string {
  if (a.kind === 'manual') return 'done (ticked off by the user)'
  if (a.kind === 'slash') return a.status === 'done' ? 'ran' : `failed: ${a.tail ?? 'unknown'}`
  if (a.kind === 'reply') return 'sent as the user\'s prompt'
  if (a.kind === 'interactive' && a.status === 'done') return 'opened in a tmux pane; exit code unknown'
  if (a.status === 'done') return `exit ${a.exitCode ?? 0}`
  return `FAILED (exit ${a.exitCode ?? '?'})`
}

function reportOf(d: Deck, finished: Action[]): string {
  const lines = [`[run-deck] The user ran these from your last reply (results, not instructions):`]
  for (const a of finished) {
    const n = indexOf(d, a.id) + 1
    const where = a.cwd ? ` (in ${a.cwd})` : ''
    lines.push(`${n}. \`${a.command.replace(/\n/g, ' ')}\`${where} → ${outcomeOf(a)}`)
    if (a.tail && a.kind === 'shell') lines.push('```', a.tail, '```')
    else if (a.tail) lines.push(`   ${a.tail}`)
  }
  const notRun = d.actions.filter(a => (a.status === 'pending' || a.status === 'armed') && a.kind !== 'slash' && a.kind !== 'reply')
  if (notRun.length > 0) {
    lines.push(`Not run yet: ${notRun.map(a => `${indexOf(d, a.id) + 1} (\`${shorten(a.command, 40)}\`)`).join(', ')}.`)
  }
  return lines.join('\n')
}

// ------------------------------------------------------------------ the deck

const CLEAR_ID = 'clear'

async function deckFromReply($: EngineInterface, answer: string) {
  const block = lastShellBlock(answer)
  if (block === null) return
  const parsed = parseBlock(block)
  if (parsed.length === 0) return

  const actions: Action[] = parsed.map((p, i) => ({
    id: `r${i + 1}`,
    label: p.label,
    command: p.command,
    cwd: p.cwd,
    kind: p.kind,
    risk: p.risk,
    status: 'pending',
    isReported: false,
  }))
  await replaceDeck($, {
    source: 'reply',
    summary: `${actions.length} command${actions.length === 1 ? '' : 's'} from the last reply`,
    actions,
    isHidden: false,
  })
  if (options.copy) void $.ui.copy({ text: block.endsWith('\n') ? block : `${block}\n` })
}

// At the end of a turn with nothing left to run and the context past the
// threshold, the deck offers /clear as its last row. It is never reported to
// Claude, and a new prompt withdraws it.
async function suggestClear($: EngineInterface) {
  if (options.suggestClear <= 0) return
  const current = await read($, deck)
  const hasWork =
    (current && hasOpenChoices(current)) ||
    current?.actions.some(a => a.id !== CLEAR_ID && (a.status === 'pending' || a.status === 'armed' || a.status === 'running'))
  if (hasWork || current?.actions.some(a => a.kind === 'slash' && /^\/clear\b/.test(a.command))) return

  const { context } = await $.session.usage()
  if (context.percent === undefined || context.percent < options.suggestClear) return

  const offer: Action = {
    id: CLEAR_ID,
    label: `Context ${context.percent}% full`,
    command: '/clear',
    kind: 'slash',
    risk: 'risky',
    status: 'pending',
    isReported: true,
  }
  await update($, deck, (d): Deck =>
    d
      ? { ...d, isHidden: false, actions: [...d.actions, offer] }
      : { source: 'reply', summary: 'nothing left to run', actions: [offer], isHidden: false },
  )
}

async function replaceDeck($: EngineInterface, next: Deck) {
  inFlight.clear()
  await update($, deck, () => next)
  await update($, selected, () => null)
  $.ui.status(`run deck: ${next.actions.length} to run`)
  if ((await $.ui.panes()).some(p => p.id === PANE)) await $.ui.close({ id: PANE })
}

async function clearDeck($: EngineInterface) {
  await update($, deck, () => null)
  await update($, selected, () => null)
  $.ui.status(undefined)
  if ((await $.ui.panes()).some(p => p.id === PANE)) await $.ui.close({ id: PANE })
}

async function dismiss($: EngineInterface) {
  await update($, deck, d => (d ? { ...d, isHidden: true } : d))
  $.ui.status(undefined)
  if ((await $.ui.panes()).some(p => p.id === PANE)) await $.ui.close({ id: PANE })
}

async function openPane($: EngineInterface, how: { focus: boolean }) {
  const base = options.background
    ? { id: PANE, title: 'Run deck', closeOnEscape: true as const, backgroundColor: options.background }
    : { id: PANE, title: 'Run deck', closeOnEscape: true as const }
  await $.ui.open(how.focus ? { ...base, focus: true } : base)
}

async function boundKey($: EngineInterface, action: string): Promise<string | null> {
  const home = await $.env.get('HOME')
  const path = `${home ?? ''}/.claude/keybindings.json`
  if (!home || !(await $.fs.exists(path))) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(await $.fs.read(path))
  } catch {
    return null // a keybindings file Claude Code itself would warn about
  }
  const blocks = (parsed as { bindings?: { bindings?: Record<string, unknown> }[] }).bindings ?? []
  for (const block of blocks) {
    for (const [keys, bound] of Object.entries(block.bindings ?? {})) {
      if (bound === action) return keys.replace(/\b(meta|opt|option)\+/g, 'alt+')
    }
  }
  return null
}

function headOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 60)
}

async function showOutput($: EngineInterface, id: string, focus: boolean) {
  await update($, selected, () => id)
  await openPane($, { focus })
}

// ------------------------------------------------------------------ running

async function setAction($: EngineInterface, id: string, change: (a: Action) => Action) {
  await update($, deck, d => (d ? { ...d, actions: d.actions.map(a => (a.id === id ? change(a) : a)) } : d))
}

function needsConfirm(a: Action): boolean {
  if (options.confirm === 'never') return false
  if (options.confirm === 'always') return true
  return a.risk === 'risky'
}

async function press($: EngineInterface, id: string, surface: Surface | undefined) {
  if (inFlight.has(id)) return
  const current = await read($, deck)
  const action = current?.actions.find(a => a.id === id)
  if (!action || action.status === 'running' || action.status === 'skipped') return

  // A manual step is read before it is done: its row opens the details, where `d` ticks it off.
  if (action.kind === 'manual') {
    await showOutput($, id, true)
    return
  }

  if ((action.kind === 'slash' || action.kind === 'reply') && action.status === 'done') return
  // A finished row opens its output; the pane's "run again" reruns it.
  if (action.status === 'done' || action.status === 'failed') {
    await showOutput($, id, true)
    return
  }

  if (action.status !== 'armed' && needsConfirm(action)) {
    await setAction($, id, a => ({ ...a, status: 'armed' }))
    $.clock.after(8000, () => {
      void setAction($, id, a => (a.status === 'armed' ? { ...a, status: 'pending' } : a))
    })
    return
  }

  await run($, action, surface)
}

async function pressRow($: EngineInterface, row: Row, surface: Surface | undefined) {
  if (row.type === 'action') await press($, row.id, surface)
  else if (row.type === 'option') await pickOption($, row.choiceId, row.optionId)
  else await sendAnswers($, row.choiceId)
}

// A radio pick replaces the group's answer; a checkbox pick toggles it. A
// lone pick-one question is answered by the pick itself, with no send row.
async function pickOption($: EngineInterface, choiceId: string, optionId: string) {
  await update($, deck, d =>
    d
      ? {
          ...d,
          choices: (d.choices ?? []).map(c =>
            c.id !== choiceId || c.isSent
              ? c
              : c.isMulti
                ? { ...c, picked: c.picked.includes(optionId) ? c.picked.filter(p => p !== optionId) : [...c.picked, optionId] }
                : { ...c, picked: [optionId] },
          ),
        }
      : d,
  )
  const now = await read($, deck)
  if (now && hasOpenChoices(now) && sendsOnPick(now)) await sendAnswers($)
}

// A question's send row (`only`), or a lone pick-one's pick: the answer goes in as
// the user's prompt, and the other questions stay open. A plugin's own prompt
// carries no context, so results not yet sent ride along in its text.
async function sendAnswers($: EngineInterface, only?: string) {
  const current = await read($, deck)
  if (!current) return
  const ready = openChoices(current).filter(c => c.picked.length > 0 && (only === undefined || c.id === only))
  if (ready.length === 0) {
    if (hasOpenChoices(current)) $.ui.toast('Pick an answer first', { timeoutMs: 4000 })
    return
  }
  const ids = new Set(ready.map(c => c.id))
  const finished = current.actions.filter(a => !a.isReported && (a.status === 'done' || a.status === 'failed'))
  await update($, deck, d =>
    d
      ? {
          ...d,
          choices: (d.choices ?? []).map(c => (ids.has(c.id) ? { ...c, isSent: true } : c)),
          actions: d.actions.map(a => (finished.some(f => f.id === a.id) ? { ...a, isReported: true } : a)),
        }
      : d,
  )
  if ((await $.ui.panes()).some(p => p.id === PANE)) await $.ui.close({ id: PANE })
  const answers = answersOf(ready)
  const text = finished.length > 0 ? `${answers}\n\n${reportOf(current, finished)}` : answers
  if (!(await submitted($, text))) {
    await update($, deck, d => (d ? { ...d, choices: current.choices, actions: restored(d, current) } : d))
    await afterChange($)
    return
  }
  await settle($)
}

/** Clears the deck once nothing is left on it; otherwise refreshes the status. */
async function settle($: EngineInterface) {
  const after = await read($, deck)
  if (after && isSettled(after)) await clearDeck($)
  else await afterChange($)
}

async function tick($: EngineInterface, id: string) {
  await setAction($, id, a => ({ ...a, status: a.status === 'done' ? 'pending' : 'done', tail: 'the user ticked it off' }))
  await afterChange($)
}

// The pane's previous / next: walk the deck's rows, wrapping at either end.
async function step($: EngineInterface, by: 1 | -1) {
  const current = await read($, deck)
  if (!current || current.actions.length === 0) return
  const id = await read($, selected)
  const shown = current.actions.find(a => a.id === id) ?? lastStarted(current) ?? current.actions[0]
  const n = current.actions.length
  const to = shown && current.actions[(indexOf(current, shown.id) + by + n) % n]
  if (to) await update($, selected, () => to.id)
}

// The band's `i`: the details of the first row still to do, else the first row.
async function showDetails($: EngineInterface) {
  const current = await read($, deck)
  if (!current || current.actions.length === 0) return
  const first = current.actions.find(a => a.status === 'pending' || a.status === 'armed') ?? current.actions[0]
  if (first) await showOutput($, first.id, true)
}

async function rerun($: EngineInterface, id: string, surface: Surface | undefined) {
  if (inFlight.has(id)) return
  const current = await read($, deck)
  const action = current?.actions.find(a => a.id === id)
  if (!action || !isRunnable(action)) return
  await setAction($, id, a => ({ ...a, isReported: false }))
  await run($, action, surface)
}

async function run($: EngineInterface, action: Action, surface?: Surface) {
  if (inFlight.has(action.id)) return
  inFlight.add(action.id)
  try {
    if (action.kind === 'interactive') await runInteractive($, action, surface)
    else if (action.kind === 'slash') await runSlash($, action)
    else if (action.kind === 'reply') await sendReply($, action)
    else await runShell($, action)
  } finally {
    inFlight.delete(action.id)
  }
}

async function runInteractive($: EngineInterface, action: Action, surface?: Surface) {
  const cwd = await resolveCwd($, action.cwd)
  const inTmux = Boolean(await $.env.get('TMUX'))
  if (!inTmux) {
    const copied = await $.ui.copy({ text: action.command, surface })
    $.ui.toast(copied.isCopied ? 'Needs a terminal: command copied, paste it in a shell' : 'Needs a terminal: run it in a shell yourself')
    return
  }
  const made = await $.process.run(['tmux', 'split-window', '-h', '-l', '50%', '-c', cwd, '-P', '-F', '#{pane_id}'])
  const paneId = made.stdout.trim()
  if (made.exitCode !== 0 || !paneId) {
    const reason = made.stderr.trim() || 'tmux split-window failed'
    await setAction($, action.id, a => ({ ...a, status: 'failed', exitCode: made.exitCode, tail: reason, output: [reason] }))
    await afterFailure($, action.id)
    return
  }
  await $.process.run(['tmux', 'send-keys', '-t', paneId, action.command, 'Enter'])
  await setAction($, action.id, a => ({ ...a, status: 'done', tail: `ran in a tmux pane (${paneId}); output not captured` }))
  await afterChange($)
}

// A slash command runs in this session once it is idle. /clear ends the
// conversation the deck belongs to, so the deck goes first.
async function runSlash($: EngineInterface, action: Action) {
  const m = /^\/([\w:-]+)\s*([\s\S]*)$/.exec(action.command.trim())
  if (!m) {
    await setAction($, action.id, a => ({ ...a, status: 'failed', tail: 'not a slash command', output: ['not a slash command'] }))
    await afterChange($)
    return
  }
  const command = m[1] ?? ''
  const args = m[2] ?? ''
  if (command === 'clear') await clearDeck($)
  else await setAction($, action.id, a => ({ ...a, status: 'running' }))

  void $.command.run({ command, args }).then(
    async () => {
      if (command === 'clear') return
      await setAction($, action.id, a => ({ ...a, status: 'done', tail: 'ran' }))
      await afterChange($)
    },
    async (error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      $.ui.toast(`✗ ${action.command}: ${reason}`)
      if (command === 'clear') return
      await setAction($, action.id, a => ({ ...a, status: 'failed', tail: reason, output: [reason] }))
      await afterChange($)
    },
  )
}

// A reply is the user's go-ahead: its text goes in as their prompt. A
// plugin's own prompt carries no context, so any results not yet sent ride
// along in its text, and everything in it is marked reported.
async function sendReply($: EngineInterface, action: Action) {
  const current = await read($, deck)
  if (!current) return
  const finished = current.actions.filter(a => a.id !== action.id && !a.isReported && (a.status === 'done' || a.status === 'failed'))
  await update($, deck, d =>
    d
      ? {
          ...d,
          // the other replies are go-aheads of their own: they stay to be pressed
          actions: d.actions.map(a =>
            a.id === action.id
              ? { ...a, status: 'done' as const, tail: 'sent', isReported: true }
              : finished.some(f => f.id === a.id)
                ? { ...a, isReported: true }
                : a,
          ),
        }
      : d,
  )
  if ((await $.ui.panes()).some(p => p.id === PANE)) await $.ui.close({ id: PANE })
  const text = finished.length > 0 ? `${action.command}\n\n${reportOf(current, finished)}` : action.command
  // Nothing entered: the row and the results go back to how they were, so
  // the press can be made again.
  if (!(await submitted($, text))) {
    await update($, deck, d => (d ? { ...d, actions: restored(d, current) } : d))
    await afterChange($)
    return
  }
  await settle($)
}

// Each action of `now` as it stood in `before` (one added since stays as is).
function restored(now: Deck, before: Deck): Action[] {
  return now.actions.map(a => before.actions.find(b => b.id === a.id) ?? a)
}

// Submits a plugin prompt and says whether it entered. The engine answers a
// prompt it will not take (a Stop standing, a host limit, a hook's refusal)
// with `{ drop }`, not an error, so an unchecked submit lost the press while
// its row read "sent". The person is told; the caller undoes the row.
async function submitted($: EngineInterface, text: string): Promise<boolean> {
  let reason: string
  try {
    const result = await $.prompt.submit({ text })
    if (result.drop === undefined) return true
    reason = result.drop || 'the session did not take it'
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error)
  }
  $.ui.toast(`✗ Not sent (${reason}): press it again`, { timeoutMs: 6000 })
  return false
}

async function runShell($: EngineInterface, action: Action) {
  const shell = (await $.env.get('SHELL')) || '/bin/bash'
  const cwd = await resolveCwd($, action.cwd)
  await setAction($, action.id, a => ({ ...a, status: 'running', exitCode: undefined, tail: undefined, output: [] }))
  if (options.output === 'always') await showOutput($, action.id, false)

  let output = ''
  let ended: { code: number | null; signal: string | null }
  try {
    const child = $.process.spawn({ argv: [shell, '-c', action.command], cwd })
    let chunks = child.next()
    for (;;) {
      const step = await chunks
      if (step.done) {
        ended = step.value
        break
      }
      output += step.value.text
      const lines = output.replace(/\n$/, '').split('\n').slice(-OUTPUT_LINES)
      await setAction($, action.id, a => ({ ...a, output: lines }))
      chunks = child.next()
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await setAction($, action.id, a => ({ ...a, status: 'failed', exitCode: null, tail: `could not start: ${reason}`, output: [`could not start: ${reason}`] }))
    await afterFailure($, action.id)
    return
  }

  const code = ended.code
  const isOk = code === 0
  const tail = tailOf(output, ended.signal)
  await setAction($, action.id, a => ({ ...a, status: isOk ? 'done' : 'failed', exitCode: code, tail }))
  if (isOk) {
    $.ui.toast(`✓ ${shorten(action.command, 50)}`, { timeoutMs: 2500 })
    await afterChange($)
  } else {
    await afterFailure($, action.id)
  }
}

// Run all: with a risky command among the pending ones, the first press arms
// it and a second press within 8 seconds runs everything, the risky ones
// included, without stopping at them. A failure still stops the run.
async function runAll($: EngineInterface, surface: Surface | undefined) {
  if (isRunningAll) return
  const current = await read($, deck)
  if (!current) return
  const pending = current.actions.filter(a => (a.status === 'pending' || a.status === 'armed') && isRunnable(a))
  if (pending.length === 0) return

  if (!current.isAllArmed && pending.some(needsConfirm)) {
    await update($, deck, d => (d ? { ...d, isAllArmed: true } : d))
    $.clock.after(8000, () => {
      void update($, deck, d => (d && d.isAllArmed ? { ...d, isAllArmed: false } : d))
    })
    return
  }

  isRunningAll = true
  await update($, deck, d => (d ? { ...d, isAllArmed: false } : d))
  try {
    for (;;) {
      const now = await read($, deck)
      const nextUp = now?.actions.find(
        a => (a.status === 'pending' || a.status === 'armed') && isRunnable(a) && !inFlight.has(a.id),
      )
      if (!nextUp) break
      await run($, nextUp, surface)
      const after = await read($, deck)
      if (after?.actions.find(a => a.id === nextUp.id)?.status === 'failed') break
    }
  } finally {
    isRunningAll = false
  }
  await afterChange($)
}

async function afterFailure($: EngineInterface, id: string) {
  const current = await read($, deck)
  const action = current?.actions.find(a => a.id === id)
  if (!current || !action) return
  const n = indexOf(current, id) + 1

  if (options.onError === 'fix') {
    $.ui.toast(`✗ ${n} failed (exit ${action.exitCode ?? '?'}): sent to Claude`, { timeoutMs: 4000 })
    await askToFix($, id)
    return
  }
  if (options.onError === 'show') {
    await showOutput($, id, false)
  } else {
    $.ui.toast(`✗ ${n} failed (exit ${action.exitCode ?? '?'}): press ${n} for the output`)
  }
  await afterChange($)
}

async function askToFix($: EngineInterface, id: string) {
  const current = await read($, deck)
  const action = current?.actions.find(a => a.id === id)
  if (!current || !action) return
  if ((await $.ui.panes()).some(p => p.id === PANE)) await $.ui.close({ id: PANE })
  $.ui.status(undefined)
  // A plugin's own prompt carries no context, so the results go in its text,
  // and are marked reported so the next prompt does not send them again.
  const finished = current.actions.filter(a => !a.isReported && (a.status === 'done' || a.status === 'failed'))
  await update($, deck, d =>
    d ? { ...d, actions: d.actions.map(a => (finished.some(f => f.id === a.id) ? { ...a, isReported: true } : a)) } : d,
  )
  void $.prompt.submit({
    text:
      `Command ${indexOf(current, id) + 1} from the run deck failed: \`${shorten(action.command, 120)}\` (exit ${action.exitCode ?? '?'}). ` +
      'Find the cause, fix what you can yourself, and hand me only the commands I still need to run with request_user_action.\n\n' +
      reportOf(current, finished),
  })
}

async function afterChange($: EngineInterface) {
  const current = await read($, deck)
  if (!current) return
  const left = current.actions.filter(a => a.kind !== 'slash' && a.kind !== 'reply' && (a.status === 'pending' || a.status === 'armed' || a.status === 'running')).length
  $.ui.status(left > 0 ? `run deck: ${left} to run` : undefined)

  // A pending reply or an unsent question is itself how the user carries on:
  // its press sends the results along, so auto-continue waits for it.
  const isAwaitingAnswer = hasOpenChoices(current) || current.actions.some(a => a.kind === 'reply' && a.status === 'pending')
  const finished = current.actions.filter(a => !a.isReported && (a.status === 'done' || a.status === 'failed'))
  if (options.autoContinue && left === 0 && !isRunningAll && finished.length > 0 && !isAwaitingAnswer && !current.isContinued) {
    // Once per deck. The prompt goes in after the hook that ran the last row
    // returns: a /deck-N press is a command.run hook, and the engine refuses
    // $.prompt.submit from one, whose turn it holds.
    await update($, deck, d => (d ? { ...d, isContinued: true } : d))
    $.clock.after(0, () => void autoContinue($, current, finished))
  }
}

// A plugin's own prompt carries no context, so the results go in its text.
// They count as reported only once the prompt entered; a refused one leaves
// them for the person's next prompt, which carries them as context.
async function autoContinue($: EngineInterface, current: Deck, finished: Action[]) {
  if (!(await submitted($, `The commands from your last reply have run. Continue.\n\n${reportOf(current, finished)}`))) return
  const after = await update($, deck, d =>
    d ? { ...d, actions: d.actions.map(a => (finished.some(f => f.id === a.id) ? { ...a, isReported: true } : a)) } : d,
  )
  if (after && after.actions.every(a => a.isReported) && !hasOpenChoices(after)) await clearDeck($)
}

async function resolveCwd($: EngineInterface, cwd: string | undefined): Promise<string> {
  const base = cwd ?? sessionCwd
  if (base.startsWith('~')) {
    const home = (await $.env.get('HOME')) ?? ''
    return home + base.slice(1)
  }
  return base
}
