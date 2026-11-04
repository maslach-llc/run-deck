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

const ANSWER = 'Done.\n\n## Run\n\n```bash\ncd ~/app\nnpm run build\ngit push origin main\n```\n'

// Every hook beneath the plugin is registered before the first call on `$`.
function stubEngine(on: any, extra: (on: any) => void = () => {}) {
  on('tool.register', () => ({ value: { tool: 'mcp__run-deck__request_user_action' } }))
  on('command.register', () => ({ value: { command: 'deck' } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('turn.start', () => ({}))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))
  on('ui.status', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 20000, percent: 10 }, rateLimits: [] } }))
  on('env.get', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.copy', () => ({ value: { isCopied: true } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  extra(on)
}

test('a reply ending in a bash block becomes buttons on every surface', async ($, on) => {
  stubEngine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: ANSWER, durationMs: 10, isAborted: false, turnId: 't1', reason: 'answered' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const first = await ui.find({ key: 'r1' })
    const second = await ui.find({ key: 'r2' })
    expect(first?.text).toContain('npm run build')
    expect(second?.text).toContain('git push origin main')
    expect(second?.text).toContain('not run ⚠')
    await ui.unmount()
  }
})

const PANE = {
  plugin: 'run-deck',
  component: 'Pane',
  requestId: 'run-deck',
  surface: 'terminal',
  props: { title: 'Run deck', isFocused: true, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('a manual action opens its details on press, ticks off with d and is reported with the next prompt', async ($, on) => {
  let context: readonly string[] | undefined
  stubEngine(on, on => {
    on('prompt.submit', (_: any, e: any) => {
      context = e.context
      return { text: e.text }
    })
    on('tool.call', () => ({ result: {} }))
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.tool.call({
    tool: 'mcp__run-deck__request_user_action',
    summary: 'Finish the setup',
    actions: [{ label: 'Enable the API', command: 'Open the console and enable the Maps API', kind: 'manual' }],
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Finish the setup/ }))?.text).toContain('Finish the setup')
  await ui.press({ key: 't1' })
  expect((await ui.find({ key: 't1' }))?.text).toContain('to do')

  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ type: 'Text', text: /enable the Maps API/ }))?.text).toBe('Open the console and enable the Maps API')
  await pane.press({ key: 'tick' })
  await pane.unmount()

  expect((await ui.find({ key: 't1' }))?.text).toContain('done')
  await ui.unmount()

  await $.prompt.submit({ text: 'next' })
  expect(context?.length).toBe(1)
  expect(context?.[0]).toContain('Open the console and enable the Maps API')
  expect(context?.[0]).toContain('ticked off')
})

test('a dismissed deck shrinks to one row and /deck show brings it back', async ($, on) => {
  stubEngine(on, on => {
    on('ui.render', ($: any, e: any) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    on('command.run', () => ({ text: '' }))
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: ANSWER, durationMs: 10, isAborted: false, turnId: 't2', reason: 'answered' })

  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'dismiss' })
  await ui.unmount()

  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'r1' })).toBeUndefined()
  expect((await ui.find({ key: 'unhide' }))?.text).toContain('Run deck hidden')
  await ui.unmount()

  await $.command.run({ command: 'deck', args: 'show' })
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'r1' })).toBeDefined()
  await ui.unmount()
})

test('details shows the whole command and its why, and steps through the rows', async ($, on) => {
  stubEngine(on, on => on('tool.call', () => ({ result: {} })))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const long = 'glab api -X POST projects/cindev%2Fcindev.com/variables -f key=GH_READ_TOKEN -F masked=true -F masked_and_hidden=true -F protected=true'
  await $.tool.call({
    tool: 'mcp__run-deck__request_user_action',
    summary: 'Set the token',
    actions: [
      { label: 'Store the token', command: long, kind: 'shell', why: 'Release builds need it to fetch the UI library' },
      { label: 'Check it', command: 'glab api projects/cindev%2Fcindev.com/variables', kind: 'shell' },
    ],
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ key: 't1' }))?.text).not.toContain('masked_and_hidden=true -F protected=true')
  await ui.press({ key: 'details' })
  await ui.unmount()

  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ type: 'Text', text: /GH_READ_TOKEN/ }))?.text).toContain('-F protected=true')
  expect((await pane.find({ type: 'Text', text: /^why: / }))?.text).toBe('why: Release builds need it to fetch the UI library')
  expect(await pane.find({ key: 'rerun' })).toBeUndefined()
  await pane.press({ key: 'next' })
  expect((await pane.find({ type: 'Text', text: /variables$/ }))?.text).toContain('2. $ glab api projects/cindev%2Fcindev.com/variables')
  await pane.press({ key: 'next' })
  expect((await pane.find({ type: 'Text', text: /GH_READ_TOKEN/ }))?.text).toContain('1. $ ')
  await pane.unmount()
})

test('with vim_keys the band draws j / k buttons', { options: { vim_keys: true } }, async ($, on) => {
  stubEngine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: ANSWER, durationMs: 10, isAborted: false, turnId: 't1', reason: 'answered' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ key: 'move-down' }))?.text).toContain('down')
  expect((await ui.find({ key: 'move-up' }))?.text).toContain('up')
  await ui.unmount()
})

test('without vim_keys the band draws no j / k buttons', async ($, on) => {
  stubEngine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: ANSWER, durationMs: 10, isAborted: false, turnId: 't1', reason: 'answered' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'move-down' })).toBeUndefined()
  await ui.unmount()
})
