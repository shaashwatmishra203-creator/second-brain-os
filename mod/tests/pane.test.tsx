import { expect, test } from 'claude-code/testing'

const RUN = { args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

const SNAPSHOT = {
  at: '2026-10-22T14:00:00.000Z',
  stats: { nodes: 37, edges: 42, orphans: 0 },
  labels: [
    { label: 'Tool', c: 21 },
    { label: 'Memory', c: 5 },
  ],
  nodes: [
    { id: 'mem:layout', title: 'api-conventions', label: 'Memory', degree: 6 },
    { id: 'tool:Bash', title: 'Bash', label: 'Tool', degree: 5 },
    { id: 'mem:data', title: 'cache-tradeoff', label: 'Memory', degree: 3 },
  ],
  edges: [
    { s: 0, t: 1, type: 'USED' },
    { s: 1, t: 2, type: 'USED' },
  ],
  relay: { active: 2, pending: 1 },
  router: { total: 10, lightShare: 0.4 },
  truncated: false,
}

const DETAIL = {
  node: {
    id: 'tool:Bash',
    title: 'Bash',
    labels: ['Tool'],
    props: { path: '/somewhere/bash' },
    body: 'the shell tool',
    updated: '2026-10-22T14:00:00.000Z',
  },
  neighbors: [
    { type: 'USED', dir: 'in', id: 'mem:layout', title: 'api-conventions', label: 'Memory' },
  ],
}

const HITS = [{ id: 'mem:data', title: 'cache-tradeoff', label: 'Memory' }]

const PANE = {
  plugin: 'second-brain',
  component: 'Pane',
  requestId: 'second-brain',
  props: {
    title: 'Second brain',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

/** Stands in for ccmod: answers each subcommand the pane shells out to. */
const engine = (on: any, calls?: string[]) => {
  on('command.register', () => ({ value: { command: 'second-brain' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('process.run', (_: unknown, e: any) => {
    const argv = (e.argv ?? []).join(' ')
    calls?.push(argv)
    if (argv.includes(' node ')) {
      return { value: { exitCode: 0, stdout: JSON.stringify(DETAIL), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (argv.includes(' lookup ')) {
      return { value: { exitCode: 0, stdout: JSON.stringify(HITS), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (argv.includes('brain ingest')) {
      return { value: { exitCode: 0, stdout: 'scanned', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 0, stdout: JSON.stringify(SNAPSHOT), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

test('the pane reports the graph counters on every surface', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'second-brain', ...RUN })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /37/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /42/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 peer/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /40% . haiku/ })).toBeDefined()

    await ui.unmount()
  }
})

test('surfaces with Svg draw the graph; the terminal lists it instead', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'second-brain', ...RUN })

  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const drawing = await ui.find({ type: 'Svg' })

    expect(drawing).toBeDefined()
    expect(drawing?.props?.alt).toBe('Knowledge graph: 3 nodes, 2 edges')
    await ui.unmount()
  }

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await terminal.find({ type: 'Svg' })).toBeUndefined()
  expect(await terminal.find({ type: 'Text', text: /api-conventions/ })).toBeDefined()
  await terminal.unmount()
})

test('nothing runs on a timer: ccmod is only shelled out to when asked', async ($, on) => {
  const calls: string[] = []
  let timers = 0
  on('clock.every', () => {
    timers += 1
    return { value: undefined }
  })
  engine(on, calls)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // session start alone must not read the graph, and must arm no interval
  expect(timers).toBe(0)
  expect(calls.length).toBe(0)

  await $.command.run({ command: 'second-brain', ...RUN })
  expect(timers).toBe(0)
  expect(calls.length).toBe(1)
})

test('the list tab opens a node, and the node walks to its connections', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'second-brain', ...RUN })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-list' })
  expect(await ui.find({ key: 'open-tool:Bash' })).toBeDefined()

  await ui.press({ key: 'open-tool:Bash' })
  expect(await ui.find({ type: 'Text', text: /the shell tool/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 connection/ })).toBeDefined()

  // walking a connection loads that node instead
  expect(await ui.find({ key: 'hop-mem:layout-USED' })).toBeDefined()
  await ui.unmount()
})

test('hiding a label drops it from the drawing', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'second-brain', ...RUN })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Svg' }))?.props?.alt).toBe('Knowledge graph: 3 nodes, 2 edges')

  await ui.press({ key: 'chip-Memory' })
  // the two Memory nodes and both their edges go with them
  expect((await ui.find({ type: 'Svg' }))?.props?.alt).toBe('Knowledge graph: 1 nodes, 0 edges')

  await ui.press({ key: 'chip-Memory' })
  expect((await ui.find({ type: 'Svg' }))?.props?.alt).toBe('Knowledge graph: 3 nodes, 2 edges')
  await ui.unmount()
})

test('search finds nodes and the settings tab changes the drawing', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'second-brain', ...RUN })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-list' })
  await ui.input({ key: 'search', text: 'pyro' })
  expect(await ui.find({ type: 'Text', text: /1 match/ })).toBeDefined()
  expect(await ui.find({ key: 'open-mem:data' })).toBeDefined()

  await ui.press({ key: 'tab-settings' })
  const captions = await ui.find({ key: 'cap' })
  expect(captions?.text).toBe('captions on')
  await ui.press({ key: 'cap' })
  expect((await ui.find({ key: 'cap' }))?.text).toBe('captions off')

  await ui.press({ key: 'dot' })
  expect((await ui.find({ key: 'dot' }))?.text).toBe('dot size 1.5×')
  await ui.unmount()
})

test('the update button re-ingests, then re-reads', async ($, on) => {
  const calls: string[] = []
  engine(on, calls)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'second-brain', ...RUN })
  calls.length = 0

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'update' })

  expect(calls.length).toBe(2)
  expect(calls[0]).toContain('brain ingest')
  expect(calls[1]).toContain('pane --limit')
  await ui.unmount()
})

test('a refresh that fails leaves a readable note, not an empty pane', async ($, on) => {
  on('command.register', () => ({ value: { command: 'second-brain' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 127, stdout: '', stderr: 'not found', isStdoutTruncated: false, isStderrTruncated: false } }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'second-brain', ...RUN })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /ccmod exited 127/ })).toBeDefined()
  await ui.unmount()
})


const BAND = {
  plugin: 'second-brain',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    bodyColumns: 60,
    maxRows: 8,
    scroll: { offset: 0, bodyRows: 8 },
    view: {},
  },
} as const

test('the band carries figures only — no buttons above the prompt', async ($, on) => {
  engine(on)
  // with nothing of its own to say, the band hands the row back
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  const empty = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await empty.find({ key: 'reopen-brain' })).toBeUndefined()
  expect(await empty.find({ key: 'reopen-vitals' })).toBeUndefined()
  expect((await empty.find({ type: 'Text' }))?.text).toBe('engine')
  await empty.unmount()
})

test('the size control grows the drawing', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'second-brain', ...RUN })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const before = (await ui.find({ type: 'Svg' }))?.props?.width as number
  expect(before).toBeGreaterThan(400)

  await ui.press({ key: 'tab-settings' })
  await ui.press({ key: 'zoom' })
  await ui.press({ key: 'tab-graph' })

  const after = (await ui.find({ type: 'Svg' }))?.props?.width as number
  expect(after).toBeGreaterThan(before)
  await ui.unmount()
})
