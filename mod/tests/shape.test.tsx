import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'second-brain', component: 'Pane', requestId: 'second-brain-vitals',
  props: { title: 'Vitals', isFocused: false, bodyColumns: 70, placement: 'dock',
           scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const BAND = {
  plugin: 'second-brain', component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, bodyColumns: 120, maxRows: 8,
           scroll: { offset: 0, bodyRows: 8 }, view: {} },
} as const

const base = (on: any) => {
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  let t = 1_700_000_000_000
  on('clock.now', () => ({ value: (t += 1000) }))
  on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '{}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
}

const walk = (node: any, out: any[] = []): any[] => {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) walk(n, out); return out }
  out.push(node)
  for (const c of node.children ?? []) walk(c, out)
  return out
}

test('the band separates its groups instead of running them together', async ($, on) => {
  base(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({
    context: { tokens: 503_000, window: 1_000_000, percent: 50 },
    rateLimits: [], cost: { usd: 31.11 }, changed: ['context' as const],
  })

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const tree = await band.drawn()
  const boxes = walk(tree).filter(n => n.type === 'Box')
  // the groups each carry a gap, which is what stops the figures touching
  expect(boxes.some(b => b.props?.gap === 2)).toBe(true)
  expect(boxes.some(b => b.props?.gap === 1)).toBe(true)
  // and nothing pressable sits above the prompt any more
  expect(walk(tree).some(n => n.type === 'Button')).toBe(false)
  await band.unmount()
})

test('the vitals pane is built from spaced, bordered sections', async ($, on) => {
  base(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({
    context: { tokens: 503_000, window: 1_000_000, percent: 50 },
    rateLimits: [], cost: { usd: 31.11 }, changed: ['context' as const],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const nodes = walk(await ui.drawn())
  const boxes = nodes.filter(n => n.type === 'Box')

  // every section is a rounded card with inner padding
  const cards = boxes.filter(b => b.props?.borderStyle === 'round')
  expect(cards.length).toBeGreaterThan(1)
  expect(cards.every((c: any) => c.props?.paddingX === 1)).toBe(true)

  // the tab strip is spaced, and each tab is its own button
  const tabButtons = nodes.filter(n => n.type === 'Button' && String(n.props?.key).startsWith('vt-'))
  expect(tabButtons.length).toBe(5)
  // the active tab is marked rather than bracketed
  expect(tabButtons.find((b: any) => b.props.key === 'vt-usage')?.props.label).toBe('● usage')
  expect(tabButtons.find((b: any) => b.props.key === 'vt-turns')?.props.label).toBe('turns')

  // label/value rows are justified apart, not concatenated
  expect(boxes.some(b => b.props?.justifyContent === 'space-between')).toBe(true)
  await ui.unmount()
})

test('a module can be pulled out into a panel of its own and put back', async ($, on) => {
  base(on)
  on('ui.close', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({
    context: { tokens: 503_000, window: 1_000_000, percent: 50 },
    rateLimits: [], cost: { usd: 31.11 }, changed: ['context' as const],
  })

  // the usage tab offers to pull itself out
  const vitals = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await vitals.find({ key: 'v-pop' })).toBeDefined()
  await vitals.press({ key: 'v-pop' })

  // once out, the tab says so and offers the way back instead of the body
  expect(await vitals.find({ type: 'Text', text: /pulled out into a panel/ })).toBeDefined()
  expect(await vitals.find({ key: 'v-pop' })).toBeUndefined()
  await vitals.unmount()

  // the module now draws in its own pane, with the same content
  const panel = await $.ui.mount({
    plugin: 'second-brain', component: 'Pane', requestId: 'sb-usage', surface: 'desktop',
    props: { title: 'Context', isFocused: false, bodyColumns: 48, placement: 'dock',
             scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  expect(await panel.find({ type: 'Text', text: /503k of 1\.0M/ })).toBeDefined()
  expect(await panel.find({ key: 'p-usage-back' })).toBeDefined()

  // putting it back restores the tab body
  await panel.press({ key: 'p-usage-back' })
  await panel.unmount()

  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await again.find({ type: 'Text', text: /pulled out into a panel/ })).toBeUndefined()
  expect(await again.find({ key: 'v-pop' })).toBeDefined()
  expect(await again.find({ type: 'Text', text: /503k of 1\.0M/ })).toBeDefined()
  await again.unmount()
})

test('every module has a panel of its own', async ($, on) => {
  base(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const [id, probe] of [
    ['sb-usage', /Context/], ['sb-turns', /Turns/], ['sb-agents', /Delegation/],
    ['sb-limits', /Rate limits/], ['sb-connectors', /Connectors/],
  ] as const) {
    const panel = await $.ui.mount({
      plugin: 'second-brain', component: 'Pane', requestId: id, surface: 'desktop',
      props: { title: id, isFocused: false, bodyColumns: 48, placement: 'dock',
               scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    expect(await panel.find({ type: 'Text', text: probe })).toBeDefined()
    await panel.unmount()
  }
})
