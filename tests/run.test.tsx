import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'run-deck',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const ANSWER = 'Done.\n\n## Run\n\n```bash\nnpm test\nnpm run build\n```\n'

type Seen = { prompts: { text: string; context?: readonly string[] }[]; spawns: string[]; opened: string[] }

// Every hook beneath the plugin is registered before the first call on `$`.
// `fail` names the commands the fake shell exits 1 on.
function stubEngine(on: any, fail: string[]): Seen {
  const seen: Seen = { prompts: [], spawns: [], opened: [] }
  on('tool.register', () => ({ value: { tool: 'mcp__run-deck__request_user_action' } }))
  on('command.register', () => ({ value: { command: 'deck' } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('turn.start', () => ({}))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.copy', () => ({ value: { isCopied: true } }))
  on('ui.open', (_: any, e: any) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('env.get', () => ({ value: undefined }))
  on('prompt.submit', (_: any, e: any) => {
    seen.prompts.push({ text: e.text, context: e.context })
    return { text: e.text }
  })
  on('process.spawn', async function* (_: any, e: any) {
    const command = e.argv[2] as string
    seen.spawns.push(command)
    if (fail.includes(command)) {
      yield { stream: 'stderr', text: `${command}: 3 tests failed\n` }
      return { value: { code: 1, signal: null } }
    }
    yield { stream: 'stdout', text: `${command}: ok\n` }
    return { value: { code: 0, signal: null } }
  })
  return seen
}

async function start($: any) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: ANSWER, durationMs: 10, isAborted: false, turnId: 't1', reason: 'answered' })
}

test('a failed command goes to Claude with its output, and no pane opens', async ($, on) => {
  const seen = stubEngine(on, ['npm test'])
  await start($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'r1' })
  expect((await ui.find({ key: 'r1' }))?.text).toContain('exit 1')
  await ui.unmount()

  expect(seen.opened).toEqual([])
  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]!.text).toContain('npm test')
  expect(seen.prompts[0]!.text).toContain('3 tests failed')
  expect(seen.prompts[0]!.text).toContain('FAILED (exit 1)')

  // Already sent: the next prompt does not carry it again.
  await $.prompt.submit({ text: 'ok' })
  expect(seen.prompts.at(-1)?.context).toBeUndefined()
})

test('a success shows no pane, and pressing the finished row opens its output', async ($, on) => {
  const seen = stubEngine(on, [])
  await start($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'r2' })
  expect(seen.opened).toEqual([])
  expect((await ui.find({ key: 'r2' }))?.text).toContain('exit 0')

  await ui.press({ key: 'r2' })
  expect(seen.opened).toEqual(['run-deck'])
  expect(seen.spawns).toEqual(['npm run build'])
  await ui.unmount()

  const pane = await $.ui.mount({
    plugin: 'run-deck',
    component: 'Pane',
    requestId: 'run-deck',
    surface: 'terminal',
    props: { title: 'Run deck', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  expect((await pane.find({ type: 'Text', text: /npm run build: ok/ }))?.text).toBe('npm run build: ok')
  await pane.press({ key: 'rerun' })
  expect(seen.spawns).toEqual(['npm run build', 'npm run build'])
  await pane.unmount()
})

test('run all runs each once and the deck clears after the results are sent', async ($, on) => {
  const seen = stubEngine(on, [])
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await start($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'all' })
  expect(seen.spawns).toEqual(['npm test', 'npm run build'])
  await ui.unmount()

  await $.prompt.submit({ text: 'thanks' })
  expect(seen.prompts.at(-1)?.context?.[0]).toContain('npm run build')

  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.find({ key: 'r1' })).toBeUndefined()
  await after.unmount()
})

test('a shortcut command presses its row while the prompt holds a draft', async ($, on) => {
  const seen = stubEngine(on, [])
  await start($)

  await $.command.run({ command: 'deck-2', args: '' })
  expect(seen.spawns).toEqual(['npm run build'])

  await $.command.run({ command: 'deck-all', args: '' })
  expect(seen.spawns).toEqual(['npm run build', 'npm test'])
})

test('deck-hide hides the band and brings it back', async ($, on) => {
  stubEngine(on, [])
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await start($)

  await $.command.run({ command: 'deck-hide', args: '' })
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'r1' })).toBeUndefined()
  await ui.unmount()

  await $.command.run({ command: 'deck-hide', args: '' })
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'r1' })).toBeDefined()
  await ui.unmount()
})
