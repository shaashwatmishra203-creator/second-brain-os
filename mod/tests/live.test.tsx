import { expect, test } from 'claude-code/testing'

const RUN = { args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

const PANE = {
  plugin: 'second-brain', component: 'Pane', requestId: 'second-brain',
  props: { title: 'Second brain', isFocused: false, bodyColumns: 70, placement: 'dock',
           scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const SNAP = {
  at: 'x', stats: { nodes: 2, edges: 1, orphans: 0 },
  labels: [{ label: 'Note', c: 2 }],
  nodes: [{ id: 'note:a', title: 'Alpha', label: 'Note', degree: 1 },
          { id: 'note:b', title: 'Beta', label: 'Note', degree: 1 }],
  edges: [{ s: 0, t: 1, type: 'LINKS_TO' }],
  relay: { active: 0, pending: 0 }, router: { total: 0, lightShare: 0 }, truncated: false,
}

const DETAIL = {
  node: { id: 'note:a', title: 'Alpha', labels: ['Note'], props: { pinX: 100, pinY: 200 },
          body: '', updated: 'x' },
  neighbors: [],
}

/** Stands in for the explorer server plus the ccmod CLI. */
const wire = (on: any, opts: { server?: boolean } = {}) => {
  const calls: { url: string; method: string; body?: any }[] = []
  const up = opts.server !== false
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  let t = 1_700_000_000_000
  on('clock.now', () => ({ value: (t += 1000) }))
  on('clock.every', () => ({ value: undefined }))
  let version = 7
  on('http.fetch', (_: any, e: any) => {
    calls.push({ url: e.url, method: e.init?.method ?? 'GET', body: e.init?.body ? JSON.parse(e.init.body) : undefined })
    if (!up) throw new Error('connection refused')
    if (e.url.includes('/api/version')) {
      return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ version: version++ }) } }
    }
    if (e.url.includes('/api/node?')) {
      return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify(DETAIL) } }
    }
    return { value: { ok: true, status: 200, headers: {}, text: '{"ok":true}' } }
  })
  on('process.run', (_: any, e: any) => {
    const argv = (e.argv ?? []).join(' ')
    if (argv.includes(' node ')) return { value: { exitCode: 0, stdout: JSON.stringify(DETAIL), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stdout: JSON.stringify(SNAP), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return calls
}

test('live is off until asked, then polls the write counter', async ($, on) => {
  const calls = wire(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'second-brain', ...RUN })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // nothing has reached the server yet: live defaults off
  expect(calls.some(c => c.url.includes('/api/version'))).toBe(false)
  expect((await ui.find({ key: 'live' }))?.text).toBe('○ live')

  await ui.press({ key: 'live' })
  expect((await ui.find({ key: 'live' }))?.text).toBe('◉ live')
  expect(calls.some(c => c.url.includes('/api/version'))).toBe(true)

  await ui.press({ key: 'live' })
  expect((await ui.find({ key: 'live' }))?.text).toBe('○ live')
  await ui.unmount()
})

test('a node can be renamed and moved from the pane', async ($, on) => {
  const calls = wire(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'second-brain', ...RUN })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-list' })
  await ui.press({ key: 'open-note:a' })

  // rename goes out as a PATCH carrying the new title
  await ui.input({ key: 'rename', text: 'Alpha renamed' })
  const patch = calls.find(c => c.method === 'PATCH')
  expect(patch?.body).toEqual({ id: 'note:a', props: { title: 'Alpha renamed' } })

  // nudging writes a position relative to where the node already sits
  await ui.press({ key: 'nudge-r' })
  const moved = calls.find(c => c.url.includes('/api/position') && c.body?.x === 140)
  expect(moved?.body).toEqual({ id: 'note:a', x: 140, y: 200 })

  await ui.press({ key: 'unpin' })
  expect(calls.some(c => c.url.includes('/api/position') && c.body?.x === null)).toBe(true)
  await ui.unmount()
})

test('with no server the pane says so instead of failing silently', async ($, on) => {
  wire(on, { server: false })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'second-brain', ...RUN })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-list' })
  await ui.press({ key: 'open-note:a' })
  await ui.press({ key: 'nudge-r' })

  expect(await ui.find({ type: 'Text', text: /ccmod dash --serve/ })).toBeDefined()
  await ui.unmount()
})
