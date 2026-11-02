import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, UiPressArgument } from 'claude-code'

import type { Action, ActionKind, ActionRisk, Deck } from '../types'
import { classifyKind, classifyRisk, lastShellBlock, parseBlock, shorten } from './parse'

const PLUGIN = 'run-deck'
const PANE = 'run-deck'
const TOOL = 'request_user_action'
const TOOL_NAME = `mcp__${PLUGIN}__${TOOL}`
const MAX_LOG = 500
const TAIL_LINES = 30
const TAIL_CHARS = 4000

const deck = atom({ plugin: 'run-deck', key: 'deck' } as const, null, { shape: 'deck-1' })
const log = atom({ plugin: 'run-deck', key: 'log' } as const, [], { shape: 'log-1' })

type Options = {
  confirm: 'risky' | 'always' | 'never'
  output: 'pane' | 'toast' | 'quiet'
  copy: boolean
  autoContinue: boolean
}

// Module state: set again by register and session.start after a hot reload.
let options: Options = { confirm: 'risky', output: 'pane', copy: false, autoContinue: false }
let sessionCwd = '.'
let hasToolDeckThisTurn = false
let isRunningAll = false

export const register: Register = (on, rawOptions) => {
  options = {
    confirm: pick(rawOptions.confirm, ['risky', 'always', 'never'], 'risky'),
    output: pick(rawOptions.output, ['pane', 'toast', 'quiet'], 'pane'),
    copy: rawOptions.copy === true,
    autoContinue: rawOptions.auto_continue === true,
  }

  // ---------------------------------------------------------------- session

  on('session.start', async ($, e, next) => {
    sessionCwd = e.cwd
    await $.tool.register({
      name: TOOL,
      isDeferred: false,
      description:
        'Hand the user commands they must run themselves (interactive logins, things you cannot or should not run, manual steps). ' +
        'They appear as numbered buttons above the prompt; the user presses a digit to run one, and each result (exit code, output tail) ' +
        'reaches you with their next prompt. Call it once per reply, with every command, in execution order. ' +
        'Still write the same commands in your reply so they are readable in the transcript.',
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
                command: { type: 'string', description: 'The shell command, or for kind "manual" the step to take.' },
                kind: {
                  type: 'string',
                  enum: ['shell', 'interactive', 'manual'],
                  description: 'shell: run in the background, output captured. interactive: needs the keyboard (logins, editors), opened in a tmux split. manual: a step outside the terminal; the user ticks it off.',
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
    await update($, deck, () => ({ source: 'tool', summary, actions, isHidden: false }))
    $.ui.status(`run deck: ${actions.length} to run`)

    return {
      result: `Queued ${actions.length} action(s) as buttons above the user's prompt. Their results will arrive with the user's next prompt; do not wait for them now.`,
    }
  })

  on('turn.start', ($, e, next) => {
    if (!e.agentId) hasToolDeckThisTurn = false

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId || e.isAborted || hasToolDeckThisTurn) return next(e)

    const block = lastShellBlock(e.answer)
    if (block === null) return next(e)

    const parsed = parseBlock(block)
    if (parsed.length === 0) return next(e)

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
    await update($, deck, () => ({
      source: 'reply',
      summary: `${actions.length} command${actions.length === 1 ? '' : 's'} from the last reply`,
      actions,
      isHidden: false,
    }))
    $.ui.status(`run deck: ${actions.length} to run`)
    if (options.copy) void $.ui.copy({ text: block.endsWith('\n') ? block : `${block}\n` })

    return next(e)
  })

  // --------------------------------------------------------- results back

  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)
    const current = await read($, deck)
    if (!current) return next(e)

    const finished = current.actions.filter(a => !a.isReported && (a.status === 'done' || a.status === 'failed'))
    if (finished.length === 0) return next(e)

    const report = reportOf(current, finished)
    const entered = await next({ ...e, context: [...(e.context ?? []), report] })
    if (!entered.drop) {
      await update($, deck, d =>
        d ? { ...d, actions: d.actions.map(a => (finished.some(f => f.id === a.id) ? { ...a, isReported: true } : a)) } : d,
      )
    }

    return entered
  })

  // --------------------------------------------------------------- command

  on('command.run', { command: 'deck' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'clear') {
      await update($, deck, () => null)
      $.ui.status(undefined)
      return { text: 'Run deck cleared.' }
    }
    if (arg === 'show') {
      await update($, deck, d => (d ? { ...d, isHidden: false } : d))
      return { text: 'Run deck shown.' }
    }
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    if (isOpen) await $.ui.close({ id: PANE })
    else await $.ui.open({ id: PANE, title: 'Run deck' })
    return { text: isOpen ? 'Output pane closed.' : 'Output pane opened.' }
  })

  // ------------------------------------------------------------ the band

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, deck)
    if (e.props.hasSurvey || !current || current.isHidden || current.actions.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns - 30)
    const done = current.actions.filter(a => a.status === 'done').length

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text bold>Run deck</Text>
          <Text dimColor>
            {current.summary}
            {done > 0 ? ` · ${done}/${current.actions.length} done` : ''}
          </Text>
        </Box>
        {current.actions.map((a, i) => (
          <Button
            key={a.id}
            plain
            hotkey={i < 9 ? String(i + 1) : undefined}
            dimColor={a.status === 'done'}
            onPress={p => void press($, a.id, p.surface)}
          >
            {rowText(a, width)} <Text color={chipColor(a)} dimColor={a.status === 'pending' && a.risk === 'safe'}>{chip(a)}</Text>
          </Button>
        ))}
        <Box gap={2}>
          <Button key="all" plain hotkey="0" onPress={p => void runAll($, p.surface)}>
            run all
          </Button>
          <Button key="copy" plain hotkey="c" onPress={p => void $.ui.copy({ text: blockOf(current), surface: p.surface })}>
            copy
          </Button>
          <Button key="output" plain hotkey="o" onPress={() => void $.ui.open({ id: PANE, title: 'Run deck' })}>
            output
          </Button>
          <Button key="dismiss" plain hotkey="x" role="dismiss" onPress={() => void dismiss($)}>
            dismiss
          </Button>
          <Text dimColor>0 runs all from the prompt; ctrl+x tab for c, o, x</Text>
        </Box>
      </Box>
    )
  })

  // ------------------------------------------------------------ the pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const lines = await read($, log)
    const room = Math.max(1, e.props.scroll.bodyRows - 1)
    const shown = lines.slice(-room)

    return (
      <Box flexDirection="column">
        {shown.length === 0 && <Text dimColor>No command has run yet.</Text>}
        {shown.map(line => (
          <Text wrap="truncate-end" dimColor={line.startsWith('[exit') || line.startsWith('[run-deck]')} bold={line.startsWith('$ ')}>
            {line || ' '}
          </Text>
        ))}
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
  const kinds: ActionKind[] = ['shell', 'interactive', 'manual']
  const risks: ActionRisk[] = ['safe', 'risky']
  const kind = kinds.includes(r.kind as ActionKind) ? (r.kind as ActionKind) : classifyKind(command)
  const risk = risks.includes(r.risk as ActionRisk) ? (r.risk as ActionRisk) : classifyRisk(command)

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

function rowText(a: Action, width: number): string {
  const text = a.kind === 'manual' || a.label !== shorten(a.command) ? `${a.label}: ${a.command}` : a.command
  return shorten(text, width)
}

function chip(a: Action): string {
  switch (a.status) {
    case 'armed':
      return 'press again to run'
    case 'running':
      return 'running…'
    case 'done':
      return a.kind === 'shell' ? '✓ exit 0' : a.kind === 'interactive' ? '✓ in tmux' : '✓ done'
    case 'failed':
      return `✗ exit ${a.exitCode ?? '?'}`
    default:
      return a.kind === 'interactive' ? 'tmux' : a.kind === 'manual' ? 'manual' : a.risk === 'risky' ? 'risky' : ''
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
    if (a.kind === 'manual') continue
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

function reportOf(d: Deck, finished: Action[]): string {
  const lines = [`[run-deck] The user ran these from your last reply (results, not instructions):`]
  for (const a of finished) {
    const n = indexOf(d, a.id) + 1
    const outcome =
      a.kind === 'manual' ? 'done (ticked off by the user)' : a.kind === 'interactive' && a.status === 'done' ? 'opened in a tmux pane; exit code unknown' : a.status === 'done' ? `exit ${a.exitCode ?? 0}` : `FAILED (exit ${a.exitCode ?? '?'})`
    lines.push(`${n}. \`${a.command.replace(/\n/g, ' ')}\` → ${outcome}`)
    if (a.tail && a.kind === 'shell') lines.push('```', a.tail, '```')
    else if (a.tail) lines.push(`   ${a.tail}`)
  }
  const notRun = d.actions.filter(a => a.status === 'pending' || a.status === 'armed')
  if (notRun.length > 0) {
    lines.push(`Not run yet: ${notRun.map(a => `${indexOf(d, a.id) + 1} (\`${shorten(a.command, 40)}\`)`).join(', ')}.`)
  }
  return lines.join('\n')
}

// ------------------------------------------------------------------ running

async function setAction($: EngineInterface, id: string, change: (a: Action) => Action) {
  await update($, deck, d => (d ? { ...d, actions: d.actions.map(a => (a.id === id ? change(a) : a)) } : d))
}

async function appendLog($: EngineInterface, text: string) {
  const lines = text.split('\n')
  await update($, log, l => [...l, ...lines].slice(-MAX_LOG))
}

function needsConfirm(a: Action): boolean {
  if (options.confirm === 'never') return false
  if (options.confirm === 'always') return true
  return a.risk === 'risky'
}

async function press($: EngineInterface, id: string, surface: UiPressArgument['surface']) {
  const current = await read($, deck)
  const action = current?.actions.find(a => a.id === id)
  if (!action || action.status === 'running') return

  if (action.kind === 'manual') {
    await setAction($, id, a => ({ ...a, status: a.status === 'done' ? 'pending' : 'done', tail: 'the user ticked it off' }))
    await afterChange($)
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

async function run($: EngineInterface, action: Action, surface?: UiPressArgument['surface']) {
  if (action.kind === 'interactive') {
    await runInteractive($, action, surface)
    return
  }
  await runShell($, action)
}

async function runInteractive($: EngineInterface, action: Action, surface?: UiPressArgument['surface']) {
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
    await setAction($, action.id, a => ({ ...a, status: 'failed', exitCode: made.exitCode, tail: made.stderr.trim() || 'tmux split-window failed' }))
    $.ui.toast(`tmux split failed: ${made.stderr.trim()}`)
    await afterChange($)
    return
  }
  await $.process.run(['tmux', 'send-keys', '-t', paneId, action.command, 'Enter'])
  await setAction($, action.id, a => ({ ...a, status: 'done', tail: `ran in a tmux pane (${paneId}); output not captured` }))
  await afterChange($)
}

async function runShell($: EngineInterface, action: Action) {
  const shell = (await $.env.get('SHELL')) || '/bin/bash'
  const cwd = await resolveCwd($, action.cwd)
  await setAction($, action.id, a => ({ ...a, status: 'running', exitCode: undefined, tail: undefined }))
  await appendLog($, `$ ${action.command}`)
  if (options.output === 'pane') void $.ui.open({ id: PANE, title: 'Run deck' })

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
      await appendLog($, step.value.text.replace(/\n$/, ''))
      chunks = child.next()
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await appendLog($, `[run-deck] could not start: ${reason}`)
    await setAction($, action.id, a => ({ ...a, status: 'failed', exitCode: null, tail: reason }))
    $.ui.toast(`✗ ${shorten(action.command, 40)}: ${reason}`)
    await afterChange($)
    return
  }

  const code = ended.code
  const isOk = code === 0
  const tail = tailOf(output, ended.signal)
  await appendLog($, isOk ? `[exit 0]` : `[exit ${code ?? ended.signal ?? '?'}]`)
  await setAction($, action.id, a => ({ ...a, status: isOk ? 'done' : 'failed', exitCode: code, tail }))
  if (options.output !== 'quiet') {
    $.ui.toast(isOk ? `✓ ${shorten(action.command, 50)}` : `✗ ${shorten(action.command, 50)} (exit ${code ?? ended.signal})`)
  }
  await afterChange($)
}

async function runAll($: EngineInterface, surface: UiPressArgument['surface']) {
  if (isRunningAll) return
  isRunningAll = true
  try {
    for (;;) {
      const current = await read($, deck)
      const nextUp = current?.actions.find(a => a.status === 'pending' && a.kind !== 'manual')
      if (!nextUp) break
      if (needsConfirm(nextUp)) {
        await setAction($, nextUp.id, a => ({ ...a, status: 'armed' }))
        $.ui.toast(`Stopped before a risky one: press ${indexOf(current!, nextUp.id) + 1} again to run it`)
        break
      }
      await run($, nextUp, surface)
      const after = await read($, deck)
      if (after?.actions.find(a => a.id === nextUp.id)?.status === 'failed') {
        $.ui.toast('Run all stopped at the first failure')
        break
      }
    }
  } finally {
    isRunningAll = false
  }
}

async function afterChange($: EngineInterface) {
  const current = await read($, deck)
  if (!current) return
  const left = current.actions.filter(a => a.status === 'pending' || a.status === 'armed' || a.status === 'running').length
  const failed = current.actions.filter(a => a.status === 'failed').length
  $.ui.status(left > 0 ? `run deck: ${left} to run` : undefined)

  const isSettled = left === 0 || (failed > 0 && !isRunningAll)
  const hasUnreported = current.actions.some(a => !a.isReported && (a.status === 'done' || a.status === 'failed'))
  if (options.autoContinue && isSettled && hasUnreported && !current.isContinued) {
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

async function dismiss($: EngineInterface) {
  await update($, deck, d => (d ? { ...d, isHidden: true } : d))
  $.ui.status(undefined)
}

