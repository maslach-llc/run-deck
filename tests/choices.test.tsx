import { expect, mock, test } from 'claude-code/testing'

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

test('a lone pick-one question sends on the pick and shrinks to its answer', async ($, on) => {
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
  expect(await ui.find({ key: 'c1-send' })).toBeUndefined()

  await ui.press({ key: 'c1-o2' })
  expect(seen.prompts).toEqual(['Default for Ideas: On in Ideas'])
  // the manual step is still to do, so the deck stays, the question one sent line
  expect((await ui.find({ type: 'Text', text: /✓ sent.*On in Ideas/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^Default for Ideas/ }))?.text).toBe('Default for Ideas · sent')
  // and no option is a button any more
  expect(await ui.find({ key: 'c1-o1', type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('checkboxes toggle, radios replace, and each question sends on its own', async ($, on) => {
  const seen = stubEngine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__run-deck__request_user_action',
    choices: [
      { question: 'Ship to', multi: true, options: ['staging', 'prod', 'preview'] },
      { question: 'Tag', options: [{ label: 'patch' }, { label: 'minor' }] },
      { question: 'Notes', options: [{ label: 'short' }, { label: 'long' }] },
    ],
  })

  const ui = await $.ui.mount(BAND)
  // nothing picked: send sends nothing
  await ui.press({ key: 'c1-send' })
  expect(seen.prompts).toEqual([])
  expect((await ui.find({ key: 'c1-send' }))?.text).toContain('pick an answer first')

  await ui.press({ key: 'c1-o1' })
  await ui.press({ key: 'c1-o3' })
  await ui.press({ key: 'c1-o1' })
  expect((await ui.find({ key: 'c1-o1' }))?.text).toContain('[ ]')
  expect((await ui.find({ key: 'c1-o3' }))?.text).toContain('[x]')
  await ui.press({ key: 'c2-o1' })
  await ui.press({ key: 'c2-o2' })
  expect((await ui.find({ key: 'c2-o1' }))?.text).toContain('( )')
  expect((await ui.find({ key: 'c2-o2' }))?.text).toContain('(•)')
  // a pick-one question among others waits for its send rather than sending
  expect(seen.prompts).toEqual([])

  // Tag's send sends Tag alone; Ship to stays answered and open
  await ui.press({ key: 'c2-send' })
  expect(seen.prompts).toEqual(['Tag: minor'])
  expect((await ui.find({ type: 'Text', text: /✓ sent.*minor/ }))?.text).toBeDefined()
  expect((await ui.find({ key: 'c1-o3' }))?.text).toContain('[x]')

  await ui.press({ key: 'c1-send' })
  expect(seen.prompts).toEqual(['Tag: minor', 'Ship to: preview'])
  expect((await ui.find({ key: 'c3-o1' }))?.props.hotkey).toBe('1')
  // the last open pick-one question keeps its send: rows do not change mid-deck
  expect((await ui.find({ type: 'Text', text: /^Notes/ }))?.text).toBe('Notes · pick one')
  await ui.press({ key: 'c3-o2' })
  expect(seen.prompts).toEqual(['Tag: minor', 'Ship to: preview'])
  await ui.press({ key: 'c3-send' })
  expect(seen.prompts).toEqual(['Tag: minor', 'Ship to: preview', 'Notes: long'])
  expect(await ui.find({ type: 'Text', text: /^Notes/ })).toBeUndefined()
  await ui.unmount()
})

test('digits number the options after the actions, each question followed by its send', async ($, on) => {
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
  expect((await ui.find({ key: 'c1-send' }))?.props.hotkey).toBe('4')
  await ui.unmount()
})

test('pressing one reply leaves the others to press, and the deck clears when all are sent', async ($, on) => {
  const seen = stubEngine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__run-deck__request_user_action',
    actions: [
      { label: 'Back up the env', command: 'yes: back up the env', kind: 'reply' },
      { label: 'Set the recipients', command: 'yes: set the recipients', kind: 'reply' },
    ],
    choices: [{ question: 'Commit', multi: true, options: ['docs', 'code'] }],
  })
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 't2' })
  expect(seen.prompts).toEqual(['yes: set the recipients'])
  expect((await ui.find({ key: 't2' }))?.text).toContain('sent')
  // the other reply and the question are still there to answer
  expect((await ui.find({ key: 't1' }))?.text).not.toContain('sent')
  expect((await ui.find({ key: 'c1-o1' }))?.props.hotkey).toBeDefined()

  // a typed prompt in between does not take them away
  await $.prompt.submit({ text: 'what does the second one do?' })
  expect((await ui.find({ key: 't1' }))?.text).toContain('Back up the env')

  await ui.press({ key: 't1' })
  expect(seen.prompts.at(-1)).toBe('yes: back up the env')
  expect((await ui.find({ key: 'c1-o1' }))?.props.hotkey).toBeDefined()
  await ui.press({ key: 'c1-o1' })
  await ui.press({ key: 'c1-send' })
  expect(seen.prompts.at(-1)).toBe('Commit: docs')
  // everything answered: the deck is gone
  expect(await ui.find({ key: 't1' })).toBeUndefined()
  await ui.unmount()
})

test('related rows sit under headings, replies after commands, and run all counts what it runs', async ($, on) => {
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
  expect((await ui.find({ type: 'Text', text: /^Reply/ }))?.text).toBe('Reply · one press sends it')
  expect((await ui.find({ type: 'Text', text: /^Also/ }))?.text).toBe('Also · pick any')
  // numbered in the order drawn: commands, replies, options, send
  expect((await ui.find({ key: 't2' }))?.props.hotkey).toBe('1')
  expect((await ui.find({ key: 't3' }))?.props.hotkey).toBe('2')
  expect((await ui.find({ key: 't1' }))?.props.hotkey).toBe('3')
  expect((await ui.find({ key: 't4' }))?.props.hotkey).toBe('4')
  expect((await ui.find({ key: 'c1-o1' }))?.props.hotkey).toBe('5')
  expect((await ui.find({ key: 'c1-send' }))?.props.hotkey).toBe('7')
  expect((await ui.find({ key: 'all' }))?.text).toContain('run all (2)')
  await ui.unmount()
})

test('the digit shortcuts send the answers and a reply, outside the command hook', async ($, on) => {
  const seen = stubEngine(on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__run-deck__request_user_action',
    choices: [{ question: 'Next', multi: true, options: ['consent', 'fix the link'] }],
  })

  // options 1-2, send 3: the press comes in as /deck-N, a command.run hook
  await $.command.run({ command: 'deck-1', args: '' })
  await $.command.run({ command: 'deck-2', args: '' })
  await $.command.run({ command: 'deck-3', args: '' })
  await clock.advance(0)
  expect(seen.prompts).toEqual(['Next: consent, fix the link'])

  await $.tool.call({
    tool: 'mcp__run-deck__request_user_action',
    actions: [{ label: 'Yes: commit it', command: 'yes: commit it', kind: 'reply' }],
  })
  await $.command.run({ command: 'deck-1', args: '' })
  await clock.advance(0)
  expect(seen.prompts).toEqual(['Next: consent, fix the link', 'yes: commit it'])
})
