import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, UiPressArgument } from 'claude-code'

import type { Action, ActionKind, ActionRisk, Deck } from '../types'
import { classifyKind, classifyRisk, lastShellBlock, parseBlock, shorten } from './parse'

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
  }

  // ---------------------------------------------------------------- session

  on('session.start', async ($, e, next) => {
    sessionCwd = e.cwd
    hideKey = await boundKey($, 'command:deck-hide')
    await $.tool.register({
      name: TOOL,
      isDeferred: false,
      description:
        'Hand the user commands they must run themselves (interactive logins, things you cannot or should not run, manual steps). ' +
        'They appear as numbered buttons above the prompt; the user presses a digit to run one. Results (exit code, output tail) reach you ' +
        'with the user\'s next prompt, and a failed command is usually sent to you right away so you can fix it: when one fails, find the ' +
        'cause, fix what you can yourself, and hand back only the commands still needed by calling this tool again. ' +
        'Call it once per reply, with every command, in execution order. Still write the same commands in your reply so they are readable in the transcript.',
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
                  description: 'The shell command; for kind "manual" the step to take; for kind "slash" the slash command with its arguments.',
                },
                kind: {
                  type: 'string',
                  enum: ['shell', 'interactive', 'manual', 'slash'],
                  description:
                    'shell: run in the background, output captured. interactive: needs the keyboard (logins, editors), opened in a tmux split. manual: a step outside the terminal; the user ticks it off. ' +
                    'slash: a Claude Code slash command run in this session, such as /clear when the work is finished and what comes next is unrelated, or /compact with what to keep; list it last.',
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
        },
        required: ['actions'],
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
    if (actions.length === 0) {
      return { deny: 'request_user_action needs a non-empty "actions" list with a "command" on each.' }
    }

    hasToolDeckThisTurn = true
    const summary = typeof e.summary === 'string' && e.summary.trim() ? e.summary.trim() : `${actions.length} to run`
    await replaceDeck($, { source: 'tool', summary, actions, isHidden: false })

    return {
      result: `Queued ${actions.length} action(s) as buttons above the user's prompt. Their results will arrive with the user's next prompt; do not wait for them now.`,
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
    if (current && current.actions.length === 0) {
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
      if (after && after.actions.every(a => a.isReported)) await clearDeck($)
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
      const action = current?.actions[Number(row[1]) - 1]
      if (action) await press($, action.id, undefined)
      return {}
    }
    return next(e)
  })

  // ------------------------------------------------------------ the band

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, deck)
    if (e.props.hasSurvey || !current || current.actions.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)

    if (current.isHidden) {
      const left = current.actions.filter(a => a.status === 'pending' || a.status === 'armed' || a.status === 'running').length
      const failed = current.actions.filter(a => a.status === 'failed').length
      const counts = [left > 0 ? `${left} to run` : '', failed > 0 ? `${failed} failed` : ''].filter(Boolean).join(', ')
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
    const hasFinished = current.actions.some(a => a.status === 'done' || a.status === 'failed')
    const hasRisky = current.actions.some(a => (a.status === 'pending' || a.status === 'armed') && a.kind !== 'manual' && a.kind !== 'slash' && needsConfirm(a))

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
        {current.actions.map((a, i) => (
          <Button
            key={a.id}
            plain
            hotkey={i < 9 ? String(i + 1) : undefined}
            dimColor={a.status === 'done'}
            onPress={p => void press($, a.id, p.surface)}
          >
            <Text color={chipColor(a)} dimColor={a.status === 'pending' && a.risk === 'safe' && a.kind === 'shell'}>
              {chip(a).padEnd(STATUS_WIDTH)}
            </Text>{' '}
            {rowText(a, room)}
          </Button>
        ))}
        <Box gap={2}>
          {hasPending && (
            <Button key="all" plain hotkey="0" onPress={p => void runAll($, p.surface)}>
              {current.isAllArmed ? (
                <Text color="warning">run all · press again</Text>
              ) : hasRisky ? (
                <Text color="warning">run all ⚠</Text>
              ) : (
                'run all'
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
          {hasFinished && (
            <Text dimColor wrap="truncate-end">
              finished row: its output
            </Text>
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

    // The details: the whole command (or manual step) and its why, wrapped, never cut.
    const at = indexOf(current, action.id)
    const cols = Math.max(20, e.props.bodyColumns)
    const isManual = action.kind === 'manual'
    const head = isManual ? action.label : `$ ${action.command}`
    const body = isManual && action.command !== action.label ? action.command : ''
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
        {!isManual && hasRun && shown.length === 0 && <Text dimColor>{action.status === 'running' ? 'waiting for output…' : 'no output'}</Text>}
        {!isManual && hasRun && shown.map(line => <Text wrap="truncate-end">{line || ' '}</Text>)}
        <Box gap={2}>
          {isManual && (
            <Button key="tick" plain hotkey="d" onPress={() => void tick($, action.id)}>
              {action.status === 'done' ? 'mark not done' : 'mark done'}
            </Button>
          )}
          {!isManual && action.kind !== 'slash' && hasRun && action.status !== 'running' && (
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
  const kinds: ActionKind[] = ['shell', 'interactive', 'manual', 'slash']
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

function indexOf(d: Deck, id: string): number {
  return d.actions.findIndex(a => a.id === id)
}

function lastStarted(d: Deck | null): Action | undefined {
  return d ? [...d.actions].reverse().find(a => a.status === 'running' || a.status === 'done' || a.status === 'failed') : undefined
}

function rowText(a: Action, width: number): string {
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
      return a.kind === 'shell' ? '✓ exit 0' : a.kind === 'interactive' ? '✓ in tmux' : a.kind === 'slash' ? '✓ ran' : '✓ done'
    case 'failed':
      return (a.kind === 'slash' ? '✗ failed' : `✗ exit ${a.exitCode ?? '?'}`).slice(0, STATUS_WIDTH)
    default:
      if (a.kind === 'interactive') return 'opens tmux'
      if (a.kind === 'manual') return 'to do'
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
    if (a.kind === 'manual' || a.kind === 'slash') continue
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
  const notRun = d.actions.filter(a => (a.status === 'pending' || a.status === 'armed') && a.kind !== 'slash')
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
  const hasWork = current?.actions.some(a => a.id !== CLEAR_ID && (a.status === 'pending' || a.status === 'armed' || a.status === 'running'))
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
  if (!action || action.status === 'running') return

  // A manual step is read before it is done: its row opens the details, where `d` ticks it off.
  if (action.kind === 'manual') {
    await showOutput($, id, true)
    return
  }

  if (action.kind === 'slash' && action.status === 'done') return
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
  if (!action || action.kind === 'manual' || action.kind === 'slash') return
  await setAction($, id, a => ({ ...a, isReported: false }))
  await run($, action, surface)
}

async function run($: EngineInterface, action: Action, surface?: Surface) {
  if (inFlight.has(action.id)) return
  inFlight.add(action.id)
  try {
    if (action.kind === 'interactive') await runInteractive($, action, surface)
    else if (action.kind === 'slash') await runSlash($, action)
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
  const made = await $.process.run(['tmux', 'split-window', '-v', '-l', '40%', '-c', cwd, '-P', '-F', '#{pane_id}'])
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
  const pending = current.actions.filter(a => (a.status === 'pending' || a.status === 'armed') && a.kind !== 'manual' && a.kind !== 'slash')
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
        a => (a.status === 'pending' || a.status === 'armed') && a.kind !== 'manual' && a.kind !== 'slash' && !inFlight.has(a.id),
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
  const left = current.actions.filter(a => a.kind !== 'slash' && (a.status === 'pending' || a.status === 'armed' || a.status === 'running')).length
  $.ui.status(left > 0 ? `run deck: ${left} to run` : undefined)

  const hasUnreported = current.actions.some(a => !a.isReported && (a.status === 'done' || a.status === 'failed'))
  if (options.autoContinue && left === 0 && !isRunningAll && hasUnreported && !current.isContinued) {
    await update($, deck, d => (d ? { ...d, isContinued: true } : d))
    void $.prompt.submit({ text: 'The commands from your last reply have run; the results are attached. Continue.' })
  }
}

async function resolveCwd($: EngineInterface, cwd: string | undefined): Promise<string> {
  const base = cwd ?? sessionCwd
  if (base.startsWith('~')) {
    const home = (await $.env.get('HOME')) ?? ''
    return home + base.slice(1)
  }
  return base
}
