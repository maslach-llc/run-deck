import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'run-deck',
  component: 'AbovePrompt',
  requestId: 'band',
  surface: 'terminal',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const BLOCK = 'Done.\n\n```bash\nnpm test\n```\n'

// Every hook beneath the plugin is registered before the first call on `$`.
function stubEngine(on: any, percent: number) {
  const ran: string[] = []
  on('tool.register', () => ({ value: { tool: 'mcp__run-deck__request_user_action' } }))
  on('command.register', () => ({ value: { command: 'deck' } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('turn.start', () => ({}))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))
  on('ui.status', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 2000 * percent, percent }, rateLimits: [] } }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.copy', () => ({ value: { isCopied: true } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('command.run', (_: any, e: any) => {
    ran.push(`/${e.command}`)
    return { text: '' }
  })
  return ran
}

test('a full context offers /clear once nothing is left, and two presses run it', async ($, on) => {
  const ran = stubEngine(on, 72)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: BLOCK, durationMs: 10, isAborted: false, turnId: 't1', reason: 'answered' })

  // A command still to run: no offer yet.
  let ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'clear' })).toBeUndefined()
  await ui.unmount()

  await $.turn.complete({ answer: 'All done.', durationMs: 10, isAborted: false, turnId: 't2', reason: 'answered' })
  ui = await $.ui.mount(BAND)
  await ui.press({ key: 'r1' })
  await ui.unmount()
  await $.prompt.submit({ text: 'thanks' })
  await $.turn.complete({ answer: 'All done.', durationMs: 10, isAborted: false, turnId: 't3', reason: 'answered' })

  ui = await $.ui.mount(BAND)
  const row = await ui.find({ key: 'clear' })
  expect(row?.text).toContain('Context 72% full: /clear')
  expect(row?.text).toContain('not run ⚠')
  await ui.press({ key: 'clear' })
  expect(ran).toEqual([])
  await ui.press({ key: 'clear' })
  expect(ran).toEqual(['/clear'])
  expect(await ui.find({ key: 'clear' })).toBeUndefined()
  await ui.unmount()
})

test('a new prompt withdraws the offer', async ($, on) => {
  stubEngine(on, 72)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: 'All done.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answered' })
  let ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'clear' })).toBeDefined()
  await ui.unmount()

  await $.prompt.submit({ text: 'one more thing' })
  ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'clear' })).toBeUndefined()
  await ui.unmount()
})

test('suggest_clear 0 turns the offer off', { options: { suggest_clear: 0 } }, async ($, on) => {
  stubEngine(on, 95)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: 'All done.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answered' })
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'clear' })).toBeUndefined()
  await ui.unmount()
})

test('a slash row pressed by its digit runs after the command hook returns', async ($, on) => {
  const ran = stubEngine(on, 10)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__run-deck__request_user_action',
    actions: [{ label: 'Update the plugin', command: '/plugin', kind: 'slash' }],
  })
  // the press comes in as /deck-1, a command.run hook: /plugin must wait for it to return
  await $.command.run({ command: 'deck-1', args: '' })
  expect(ran).toEqual([])
  await clock.advance(0)
  expect(ran).toEqual(['/plugin'])
})
