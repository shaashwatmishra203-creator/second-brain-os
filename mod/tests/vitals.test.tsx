import { expect, test } from 'claude-code/testing'

import { bar, cacheHitRate, parseMcpName, sparkline, tierOf } from '../hooks/draw'

const PANE = {
  plugin: 'second-brain',
  component: 'Pane',
  requestId: 'second-brain-vitals',
  props: {
    title: 'Vitals',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'second-brain',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    bodyColumns: 120,
    maxRows: 8,
    scroll: { offset: 0, bodyRows: 8 },
    view: {},
  },
} as const

const MEASURE = {
  context: { tokens: 124_000, window: 200_000, percent: 62 },
  rateLimits: [{ kind: 'five_hour', percentUsed: 31, resetsAt: '2099-01-01T00:00:00Z' }],
  cost: { usd: 1.27 },
  changed: ['context' as const],
}

const base = (on: any, skip: { process?: boolean } = {}) => {
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  // the harness has no clock of its own; without this every `$.clock.now()` throws
  let t = 1_700_000_000_000
  on('clock.now', () => ({ value: (t += 1000) }))
  on('session.measure', (_: unknown, e: any) => ({ changed: e.changed }))
  on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'ag1' }))
  if (!skip.process) on('process.run', () => ({ value: { exitCode: 0, stdout: '{}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
}

// ---------------------------------------------------------------- pure maths

test('the text bar never reads full below 100% nor empty above 0%', () => {
  expect(bar(0, 10)).toBe('░░░░░░░░░░')
  expect(bar(1, 10)).toBe('██████████')
  expect(bar(0.001, 10)).toBe('█░░░░░░░░░')   // a sliver still shows
  expect(bar(0.999, 10)).toBe('█████████░')   // not yet full
  expect(bar(0.5, 10)).toBe('█████░░░░░')
  expect(bar(undefined, 4)).toBe('░░░░')      // unknown, not zero
})

test('sparkline handles flat, gapped and empty series', () => {
  expect(sparkline([1, 1, 1], 8)).toBe('▁▁▁')
  expect(sparkline([0, 100], 8)).toBe('▁█')
  expect(sparkline([1, undefined, 3], 8)).toBe('▁·█')
  expect(sparkline([], 8)).toBe('')
})

test('mcp tool names split into server and tool', () => {
  expect(parseMcpName('mcp__linear__create_issue')).toEqual({ server: 'linear', tool: 'create_issue' })
  expect(parseMcpName('Bash')).toBeNull()
})

test('tier and cache rate', () => {
  expect(tierOf('claude-haiku-4-5')).toBe('haiku')
  expect(tierOf(undefined)).toBe('other')
  expect(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined()
  expect(cacheHitRate({ input: 50, cacheRead: 150, cacheWrite: 0 })).toBe(0.75)
})

// ------------------------------------------------------------------ the band

test('a measure fills the band bar, and the numbers reach the pane', async ($, on) => {
  base(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure(MEASURE)

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /62%/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /124k\/200k/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /\$1\.27/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /5h/ })).toBeDefined()
  await band.unmount()
})

test('a narrow band drops segments instead of overflowing', async ($, on) => {
  base(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure(MEASURE)

  const narrow = await $.ui.mount({
    ...BAND,
    props: { ...BAND.props, bodyColumns: 50 },
    surface: 'desktop',
  })
  expect(await narrow.find({ type: 'Text', text: /62%/ })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: /\$1\.27/ })).toBeUndefined()
  expect(await narrow.find({ type: 'Text', text: /5h/ })).toBeUndefined()
  await narrow.unmount()
})

test('mid-turn the band shows elapsed time and the running tool', async ($, on) => {
  base(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure(MEASURE)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })

  const working = await $.ui.mount({
    ...BAND,
    props: { ...BAND.props, isWorking: true },
    surface: 'desktop',
  })
  expect(await working.find({ type: 'Text', text: /Bash/ })).toBeDefined()
  // the static figures stand down so the row cannot grow mid-turn
  expect(await working.find({ type: 'Text', text: /\$1\.27/ })).toBeUndefined()
  await working.unmount()
})

test('the band yields to a survey', async ($, on) => {
  base(on)
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure(MEASURE)

  const survey = await $.ui.mount({
    ...BAND,
    props: { ...BAND.props, hasSurvey: true },
    surface: 'desktop',
  })
  expect((await survey.find({ type: 'Text' }))?.text).toBe('engine')
  await survey.unmount()
})

// ------------------------------------------------------------- the turn trail

test('a completed turn is recorded and the live state is cleared', async ($, on) => {
  base(on)
  // the band yields when it has no figures, so give the chain a bottom
  on('ui.render', ($$: any, e: any) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({
    answer: 'done', durationMs: 4200, isAborted: false, turnId: 't1', reason: 'answer',
    usage: {
      model: 'claude-opus-5', input_tokens: 900, output_tokens: 300,
      cache_read_input_tokens: 7000, cache_creation_input_tokens: 100,
    },
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /900/ })).toBeDefined()
  await ui.press({ key: 'vt-turns' })
  expect(await ui.find({ type: 'Text', text: /4s/ })).toBeDefined()
  await ui.unmount()

  // and the band is back to its idle form
  const band = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: false }, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /Bash/ })).toBeUndefined()
  await band.unmount()
})

// --------------------------------------------------------- the delegation log

test('a spawned subagent lands in the delegation log with its model', async ($, on) => {
  base(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({
    tool_use_id: 'tu1', prompt: 'fix the typo', description: 'fix the typo',
    subagentType: 'haiku-worker', model: 'haiku', parentModel: 'claude-opus-5',
    provider: { plugin: 'engine', tier: 'core' as const }, background: false, fork: false,
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'vt-agents' })
  expect(await ui.find({ type: 'Text', text: /haiku-worker/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 subagent this session/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^haiku$/ })).toBeDefined()

  // its tokens are attributed when that subagent's turn ends
  await $.turn.complete({
    answer: 'ok', durationMs: 800, isAborted: false, turnId: 't2', agentId: 'ag1', reason: 'answer',
    usage: {
      model: 'claude-haiku-4-5', input_tokens: 40, output_tokens: 120,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    },
  })
  expect(await ui.find({ type: 'Text', text: /120/ })).toBeDefined()
  await ui.unmount()
})

// ------------------------------------------------------------- empty states

test('each tab says what it has rather than drawing blank', async ($, on) => {
  base(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /nothing read yet/ })).toBeDefined()

  await ui.press({ key: 'vt-limits' })
  expect(await ui.find({ type: 'Text', text: /none reported/ })).toBeDefined()

  await ui.press({ key: 'vt-agents' })
  expect(await ui.find({ type: 'Text', text: /none yet/ })).toBeDefined()

  await ui.press({ key: 'vt-turns' })
  expect(await ui.find({ type: 'Text', text: /nothing recorded yet/ })).toBeDefined()
  await ui.unmount()
})

test('context reads as awaiting, not 0%, before the first response', async ($, on) => {
  base(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context' as const] })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /awaiting the first response/ })).toBeDefined()
  await ui.unmount()
})

// -------------------------------------------------------------- connectors

test('connectors fall back to tool names when the host cannot be asked', async ($, on) => {
  base(on)
  on('mcp.call', () => { throw new Error('no such server') })
  on('tool.list', () => ({
    value: [
      { name: 'Bash', description: '', mcp: false },
      { name: 'mcp__linear__create_issue', description: '', mcp: true },
      { name: 'mcp__linear__list_issues', description: '', mcp: true },
      { name: 'mcp__notion__search', description: '', mcp: true },
    ],
  }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'vt-connectors' })
  await ui.press({ key: 'conn-check' })

  expect(await ui.find({ type: 'Text', text: /linear/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2 tools/ })).toBeDefined()
  // and it is honest about what that list cannot tell you
  expect(await ui.find({ type: 'Text', text: /will not appear/ })).toBeDefined()
  await ui.unmount()
})

// ------------------------------------------------------------- the cost guard

test('a whole turn runs without shelling out even once', async ($, on) => {
  const spawned: string[] = []
  base(on, { process: true })
  on('process.run', (_: unknown, e: any) => {
    spawned.push((e.argv ?? []).join(' '))
    return { value: { exitCode: 0, stdout: '{}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure(MEASURE)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/x' })
  await $.turn.complete({
    answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer',
  })

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.unmount()

  expect(spawned).toEqual([])
})
