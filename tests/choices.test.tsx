import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'run-deck',
  component: 'AbovePrompt',
  requestId: 'band',
  surface: 'terminal',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 16,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

type Seen = { prompts: string[] }

// Every hook beneath the plugin is registered before the first call on `$`.
function stubEngine(on: any): Seen {
  const seen: Seen = { prompts: [] }
  on('tool.register', () => ({ value: { tool: 'mcp__run-deck__request_user_action' } }))
  on('command.register', () => ({ value: { command: 'deck' } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('turn.start', () => ({}))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))
  on('ui.status', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 20000, percent: 10 }, rateLimits: [] } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.copy', () => ({ value: { isCopied: true } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('env.get', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))
  on('prompt.submit', (_: any, e: any) => {
    seen.prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return seen
}

test('a lone pick-one question sends on the pick and marks every option', async ($, on) => {
  const seen = stubEngine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__run-deck__request_user_action',
    summary: 'Check, then pick',
    actions: [{ label: 'Check the lane', command: 'Toggle the lane on Ideas', kind: 'manual' }],
    choices: [{ question: 'Default for Ideas', options: [{ label: 'Off by default' }, { label: 'On in Ideas' }] }],
  })

  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ key: 'c1-o1' }))?.text).toContain('( )')
  expect((await ui.find({ type: 'Text', text: /Default for Ideas/ }))?.text).toContain('pick one')
  // the lone radio needs no send row
  expect(await ui.find({ key: 'send' })).toBeUndefined()

  await ui.press({ key: 'c1-o2' })
  expect(seen.prompts).toEqual(['Default for Ideas: On in Ideas'])
  // the manual step is still to do, so the deck stays, every option marked
  expect((await ui.find({ type: 'Text', text: /\(•\) sent/ }))?.text).toContain('On in Ideas')
  expect((await ui.find({ type: 'Text', text: /\( \) skip/ }))?.text).toContain('Off by default')
  // and none is a button any more
  expect(await ui.find({ key: 'c1-o1', type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('checkboxes toggle, radios replace, and the send row sends every answer once', async ($, on) => {
  const seen = stubEngine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__run-deck__request_user_action',
    choices: [
      { question: 'Ship to', multi: true, options: ['staging', 'prod', 'preview'] },
      { question: 'Tag', options: [{ label: 'patch' }, { label: 'minor' }] },
    ],
  })

  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'c1-o1' })
  await ui.press({ key: 'c1-o3' })
  await ui.press({ key: 'c1-o1' })
  expect((await ui.find({ key: 'c1-o1' }))?.text).toContain('[ ]')
  expect((await ui.find({ key: 'c1-o3' }))?.text).toContain('[x]')

  // send with the pick-one question open arms first and sends nothing
  await ui.press({ key: 'send' })
  expect(seen.prompts).toEqual([])
  expect((await ui.find({ key: 'send' }))?.text).toContain('press again')

  await ui.press({ key: 'c2-o1' })
  await ui.press({ key: 'c2-o2' })
  expect((await ui.find({ key: 'c2-o1' }))?.text).toContain('( )')
  expect((await ui.find({ key: 'c2-o2' }))?.text).toContain('(•)')
  // a pick-one question among others waits for send rather than sending
  expect(seen.prompts).toEqual([])

  await ui.press({ key: 'send' })
  expect(seen.prompts).toEqual(['Ship to: preview\nTag: minor'])
  await ui.unmount()
})

test('digits number the options after the actions, and the send row last', async ($, on) => {
  stubEngine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__run-deck__request_user_action',
    actions: [{ label: 'npm test', command: 'npm test', kind: 'shell' }],
    choices: [{ question: 'Also', multi: true, options: ['lint', 'build'] }],
  })
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ key: 'c1-o1' }))?.props.hotkey).toBe('2')
  expect((await ui.find({ key: 'c1-o2' }))?.props.hotkey).toBe('3')
  expect((await ui.find({ key: 'send' }))?.props.hotkey).toBe('4')
  await ui.unmount()
})

test('pressing one reply marks the other replies not picked', async ($, on) => {
  const seen = stubEngine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__run-deck__request_user_action',
    actions: [
      { label: 'npm test', command: 'npm test', kind: 'shell' },
      { label: 'Yes', command: 'yes: do it', kind: 'reply' },
      { label: 'No', command: 'no: leave it', kind: 'reply' },
    ],
  })
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 't3' })
  expect(seen.prompts).toEqual(['no: leave it'])
  expect((await ui.find({ key: 't2' }))?.text).toContain('( ) skip')
  expect((await ui.find({ key: 't3' }))?.text).toContain('(•) sent')
  // a not-picked reply never sends
  await ui.press({ key: 't2' })
  expect(seen.prompts).toEqual(['no: leave it'])
  await ui.unmount()
})

test('related rows sit under headings, replies after commands, and run all names what it runs', async ($, on) => {
  stubEngine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__run-deck__request_user_action',
    actions: [
      { label: 'Yes', command: 'yes: do it', kind: 'reply' },
      { label: 'npm test', command: 'npm test', kind: 'shell' },
      { label: 'npm run build', command: 'npm run build', kind: 'shell' },
      { label: 'No', command: 'no: leave it', kind: 'reply' },
    ],
    choices: [{ question: 'Also', multi: true, options: ['lint', 'docs'] }],
  })
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /^Commands/ }))?.text).toBe('Commands')
  expect((await ui.find({ type: 'Text', text: /^Reply/ }))?.text).toBe('Reply · pick one, it sends')
  expect((await ui.find({ type: 'Text', text: /^Also/ }))?.text).toBe('Also · pick any')
  // numbered in the order drawn: commands, replies, options, send
  expect((await ui.find({ key: 't2' }))?.props.hotkey).toBe('1')
  expect((await ui.find({ key: 't3' }))?.props.hotkey).toBe('2')
  expect((await ui.find({ key: 't1' }))?.props.hotkey).toBe('3')
  expect((await ui.find({ key: 't1' }))?.text).toContain('( )')
  expect((await ui.find({ key: 't4' }))?.props.hotkey).toBe('4')
  expect((await ui.find({ key: 'c1-o1' }))?.props.hotkey).toBe('5')
  expect((await ui.find({ key: 'send' }))?.props.hotkey).toBe('7')
  expect((await ui.find({ key: 'all' }))?.text).toContain('the 2 commands above')
  await ui.unmount()
})
