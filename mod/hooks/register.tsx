import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, RenderElement } from 'claude-code'

import type {
  AgentRow,
  BrainGraph,
  ConnectorMode,
  NodeDetail,
  SearchHit,
  ServerRow,
  TurnRecord,
  Usage,
  ViewName,
  VitalsView,
} from '../types'
import {
  bar,
  barColor,
  barWidth,
  cacheHitRate,
  colorOf,
  fmtDuration,
  fmtReset,
  fmtTokens,
  fmtUsd,
  parseMcpName,
  sparkline,
  svgFor,
  tierOf,
  visible,
} from './draw'

const PANE = 'second-brain'
const VITALS = 'second-brain-vitals'
const NODE_LIMIT = 60
const TURN_CAP = 60
const AGENT_CAP = 40

const graph = atom({ plugin: 'second-brain', key: 'graph' } as const, null)
const status = atom({ plugin: 'second-brain', key: 'status' } as const, '')
const view = atom({ plugin: 'second-brain', key: 'view' } as const, 'graph')
const hidden = atom({ plugin: 'second-brain', key: 'hidden' } as const, [])
const selected = atom({ plugin: 'second-brain', key: 'selected' } as const, null)
const detail = atom({ plugin: 'second-brain', key: 'detail' } as const, null)
const hits = atom({ plugin: 'second-brain', key: 'hits' } as const, [])
const query = atom({ plugin: 'second-brain', key: 'query' } as const, '')
const prefs = atom({ plugin: 'second-brain', key: 'prefs' } as const, {
  captions: true,
  edges: true,
  dots: 1,
  spread: 1,
  zoom: 1,
})
const isOpen = atom({ plugin: 'second-brain', key: 'isOpen' } as const, false)

const usage = atom({ plugin: 'second-brain', key: 'usage' } as const, null)
const live = atom({ plugin: 'second-brain', key: 'live' } as const, null)
const turns = atom({ plugin: 'second-brain', key: 'turns' } as const, [])
const agents = atom({ plugin: 'second-brain', key: 'agents' } as const, [])
const servers = atom({ plugin: 'second-brain', key: 'servers' } as const, [])
const connectorMode = atom({ plugin: 'second-brain', key: 'connectorMode' } as const, 'unknown')
const connectorNote = atom({ plugin: 'second-brain', key: 'connectorNote' } as const, '')
const vitalsView = atom({ plugin: 'second-brain', key: 'vitalsView' } as const, 'usage')
const vitalsOpen = atom({ plugin: 'second-brain', key: 'vitalsOpen' } as const, false)
const popped = atom({ plugin: 'second-brain', key: 'popped' } as const, [])
const liveOn = atom({ plugin: 'second-brain', key: 'liveOn' } as const, false)
const seenVersion = atom({ plugin: 'second-brain', key: 'seenVersion' } as const, -1)
const serverUp = atom({ plugin: 'second-brain', key: 'serverUp' } as const, false)
const bandOn = atom({ plugin: 'second-brain', key: 'bandOn' } as const, {
  context: true,
  progress: true,
  cost: true,
  limits: true,
})

/**
 * ccmod lives in the person's home, and the module has no `process`, so the
 * path is resolved by the shell rather than baked in — the mod then works for
 * anyone who has ccmod installed, not just the machine it was written on.
 */
const ccmod = (args: readonly string[]) => [
  '/bin/sh',
  '-c',
  `exec "$HOME/.claude/mods/bin/ccmod" ${args.join(' ')}`,
]

// ---------------------------------------------------------------- the actions
// Every one takes `$` first and is declared here, at the top of the file: the
// engine refuses a module that hands `$` to anything else.

/** Read a snapshot out of ccmod. Runs only when something asks it to. */
async function refresh($: EngineInterface): Promise<void> {
  try {
    const run = await $.process.run(ccmod(['pane', '--limit', String(NODE_LIMIT)]), {
      timeoutMs: 15_000,
    })
    if (run.exitCode !== 0) {
      await update($, status, () => `ccmod exited ${run.exitCode}`)
      return
    }
    await update($, graph, () => JSON.parse(run.stdout) as BrainGraph)
    await update($, status, () => '')
  } catch (err) {
    await update($, status, () => `could not read the graph: ${String(err)}`)
  }
}

/** Re-ingest every source, then redraw. The only slow action in the pane. */
async function rescan($: EngineInterface): Promise<void> {
  await update($, status, () => 'updating the brain…')
  try {
    const run = await $.process.run(ccmod(['brain', 'ingest']), { timeoutMs: 180_000 })
    if (run.exitCode !== 0) {
      await update($, status, () => `update failed (exit ${run.exitCode})`)
      return
    }
  } catch (err) {
    await update($, status, () => `update failed: ${String(err)}`)
    return
  }
  await refresh($)
}

/** Bring the pane back, from the band or the command. */
async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Second brain' })
  await update($, isOpen, () => true)
}

/** The drawing is sized from the pane, times this; cycled when it reads wrong. */
async function cycleZoom($: EngineInterface): Promise<void> {
  await update($, prefs, p => ({ ...p, zoom: p.zoom >= 1.9 ? 0.7 : p.zoom + 0.3 }))
}

async function setView($: EngineInterface, next: ViewName): Promise<void> {
  await update($, view, () => next)
}

/** Open one node: its properties and everything it connects to. */
async function selectNode($: EngineInterface, id: string): Promise<void> {
  await update($, selected, () => id)
  await update($, view, () => 'detail')
  await update($, status, () => 'opening…')
  try {
    const run = await $.process.run(ccmod(['node', `'${id.replace(/'/g, "'\\''")}'`]), {
      timeoutMs: 15_000,
    })
    if (run.exitCode !== 0) {
      await update($, status, () => `ccmod exited ${run.exitCode}`)
      return
    }
    await update($, detail, () => JSON.parse(run.stdout) as NodeDetail)
    await update($, status, () => '')
  } catch (err) {
    await update($, status, () => `could not open that node: ${String(err)}`)
  }
}

/** Full-text search across the graph. */
async function runSearch($: EngineInterface, text: string): Promise<void> {
  const q = text.trim()
  await update($, query, () => q)
  if (q === '') {
    await update($, hits, () => [])
    return
  }
  await update($, status, () => 'searching…')
  try {
    const run = await $.process.run(ccmod(['lookup', `'${q.replace(/'/g, "'\\''")}'`, '--limit', '40']), {
      timeoutMs: 15_000,
    })
    if (run.exitCode !== 0) {
      await update($, status, () => `ccmod exited ${run.exitCode}`)
      return
    }
    await update($, hits, () => JSON.parse(run.stdout) as SearchHit[])
    await update($, view, () => 'list')
    await update($, status, () => '')
  } catch (err) {
    await update($, status, () => `search failed: ${String(err)}`)
  }
}

async function clearSearch($: EngineInterface): Promise<void> {
  await update($, query, () => '')
  await update($, hits, () => [])
}

/** Show or hide every node carrying one label. */
async function toggleLabel($: EngineInterface, label: string): Promise<void> {
  await update($, hidden, list =>
    list.includes(label) ? list.filter(l => l !== label) : [...list, label],
  )
}

async function showEveryLabel($: EngineInterface): Promise<void> {
  await update($, hidden, () => [])
}

async function toggleCaptions($: EngineInterface): Promise<void> {
  await update($, prefs, p => ({ ...p, captions: !p.captions }))
}

async function toggleEdges($: EngineInterface): Promise<void> {
  await update($, prefs, p => ({ ...p, edges: !p.edges }))
}

/** Dot size and spread cycle through three steps rather than needing a slider. */
async function cycleDots($: EngineInterface): Promise<void> {
  await update($, prefs, p => ({ ...p, dots: p.dots >= 1.6 ? 0.6 : p.dots + 0.5 }))
}

async function cycleSpread($: EngineInterface): Promise<void> {
  await update($, prefs, p => ({ ...p, spread: p.spread >= 1.6 ? 0.6 : p.spread + 0.5 }))
}

async function resetLook($: EngineInterface): Promise<void> {
  await update($, prefs, () => ({ captions: true, edges: true, dots: 1, spread: 1, zoom: 1 }))
  await update($, hidden, () => [])
}

// ------------------------------------------------------------ vitals actions

/** The redraw ticker for the live turn timer. Only ever armed during a turn. */
let stopTick: (() => void) | null = null

async function openVitals($: EngineInterface): Promise<void> {
  await $.ui.open({ id: VITALS, title: 'Vitals' })
  await update($, vitalsOpen, () => true)
}

async function setVitalsView($: EngineInterface, next: VitalsView): Promise<void> {
  await update($, vitalsView, () => next)
}

/**
 * Every module can live either as a tab inside Vitals or as a panel of its
 * own. The surface stacks panels as switchable tabs beside the transcript,
 * so a pulled-out module keeps its own frame and title.
 */
export const MODULES = ['usage', 'turns', 'agents', 'limits', 'connectors'] as const

const paneIdFor = (name: VitalsView) => `sb-${name}`

const titleFor = (name: VitalsView) =>
  name === 'usage' ? 'Context'
  : name === 'turns' ? 'Turns'
  : name === 'agents' ? 'Delegation'
  : name === 'limits' ? 'Rate limits'
  : 'Connectors'

async function popOut($: EngineInterface, name: VitalsView): Promise<void> {
  await $.ui.open({ id: paneIdFor(name), title: titleFor(name) })
  await update($, popped, list => (list.includes(name) ? list : [...list, name]))
}

async function putBack($: EngineInterface, name: VitalsView): Promise<void> {
  await update($, popped, list => list.filter(n => n !== name))
  try {
    await $.ui.close({ id: paneIdFor(name) })
  } catch {
    // Already gone, or the surface closed it first.
  }
}

async function toggleBand($: EngineInterface, key: 'context' | 'progress' | 'cost' | 'limits'): Promise<void> {
  await update($, bandOn, b => ({ ...b, [key]: !b[key] }))
}

/**
 * Pushed usage, from `session.measure`. Writes only on a real change: an
 * identical measure would otherwise redraw the band for nothing.
 */
async function recordMeasure(
  $: EngineInterface,
  ctx: { tokens?: number; window?: number; percent?: number },
  limits: { kind: string; percentUsed: number; resetsAt?: string }[],
  costUsd: number | undefined,
): Promise<void> {
  const now = await $.clock.now()
  const prev = await read($, usage)
  const sameNumbers =
    prev !== null &&
    prev.tokens === ctx.tokens &&
    prev.percent === ctx.percent &&
    prev.costUsd === costUsd &&
    prev.limits.length === limits.length &&
    prev.limits.every((l, i) => l.kind === limits[i]?.kind && l.percentUsed === limits[i]?.percentUsed)
  if (sameNumbers) return

  await update($, usage, old => ({
    tokens: ctx.tokens,
    window: ctx.window ?? old?.window ?? 0,
    percent: ctx.percent,
    costUsd: costUsd ?? old?.costUsd,
    limits,
    startedAt: old?.startedAt ?? now,
    updatedAt: now,
  }))

  // `turn.complete` and `session.measure` can land in either order, so the
  // newest turn gets its context figure from whichever arrives second.
  if (ctx.tokens !== undefined) {
    await update($, turns, list => {
      const last = list[list.length - 1]
      if (!last || last.ctxTokens !== undefined) return list
      const patched = [...list]
      patched[patched.length - 1] = { ...last, ctxTokens: ctx.tokens }
      return patched
    })
  }
}

async function startTurn($: EngineInterface, turnId: string): Promise<void> {
  const now = await $.clock.now()
  await update($, live, () => ({ turnId, startedAt: now, tool: null }))
  stopTick?.()
  stopTick = null
  try {
    // Redraw once a second so the elapsed counter moves. This only invalidates
    // the drawing — it writes no state and costs no tokens.
    const timer = $.clock.every(1000, () => {
      $.ui.invalidate('ui.render')
    })
    if (typeof timer?.cancel === 'function') stopTick = timer.cancel
  } catch {
    // No ticker; the band falls back to updating on tool calls.
  }
}

async function noteTool($: EngineInterface, tool: string): Promise<void> {
  const current = await read($, live)
  if (!current || current.tool === tool) return
  await update($, live, l => (l ? { ...l, tool } : l))
}

async function finishTurn($: EngineInterface, rec: TurnRecord): Promise<void> {
  stopTick?.()
  stopTick = null
  await update($, live, () => null)
  await update($, turns, list => [...list, rec].slice(-TURN_CAP))
}

async function noteAgentSpawn($: EngineInterface, row: AgentRow): Promise<void> {
  await update($, agents, list => [...list, row].slice(-AGENT_CAP))
}

/** A subagent finished: attribute its tokens and the model it actually ran on. */
async function noteAgentDone(
  $: EngineInterface,
  agentId: string,
  model: string | undefined,
  input: number,
  output: number,
): Promise<void> {
  await update($, agents, list =>
    list.map(a =>
      a.agentId === agentId
        ? {
            ...a,
            status: 'completed',
            resolvedModel: model ?? a.resolvedModel,
            input: a.input + input,
            output: a.output + output,
          }
        : a,
    ),
  )
}

async function refreshAgents($: EngineInterface): Promise<void> {
  try {
    const listed = await $.agent.list()
    await update($, agents, rows =>
      rows.map(r => {
        const found = listed.find(l => l.id === r.agentId)
        return found ? { ...r, status: found.status, description: found.description || r.description } : r
      }),
    )
  } catch {
    // The list is a nicety; the spawn records already carry the useful part.
  }
}

const textOf = (res: unknown): string => {
  const blocks = (res as { content?: { type?: string; text?: string }[] } | null)?.content
  if (!Array.isArray(blocks)) return ''
  return blocks.map(b => (typeof b?.text === 'string' ? b.text : '')).join('\n')
}

/**
 * Work out how much control we actually have over connectors, then list them.
 *
 * The host may expose a connectors server that reports real status and can
 * switch a connector on or off. When it does not, all we can see is the set of
 * MCP tools that happen to be loaded, which says nothing about a server that
 * failed or is switched off — so the tab says which of the two it is showing.
 */
async function probeConnectors($: EngineInterface): Promise<void> {
  try {
    const res = await $.mcp.call('ccd_connectors', 'session_connectors_status')
    const text = textOf(res)
    const parsed = JSON.parse(text) as unknown
    const rows = Array.isArray(parsed)
      ? parsed
      : ((parsed as { connectors?: unknown[]; servers?: unknown[] })?.connectors ??
         (parsed as { servers?: unknown[] })?.servers ?? [])
    if (Array.isArray(rows) && rows.length > 0) {
      const mapped: ServerRow[] = rows.map(r => {
        const row = r as Record<string, unknown>
        return {
          name: String(row.name ?? row.id ?? 'unknown'),
          tools: Number(row.tool_count ?? row.toolCount ?? 0),
          calls: 0,
          state: `${String(row.status ?? 'unknown')}${row.kind ? ` · ${String(row.kind)}` : ''}`,
        }
      })
      await update($, servers, () => mapped)
      await update($, connectorMode, () => 'live' as ConnectorMode)
      await update($, connectorNote, () => 'live status from the host')
      return
    }
  } catch {
    // No connectors server here; fall through to what the tool list shows.
  }

  try {
    const tools = await $.tool.list()
    const byServer = new Map<string, number>()
    for (const t of tools) {
      if (!t.mcp) continue
      const parsedName = parseMcpName(t.name)
      if (!parsedName) continue
      byServer.set(parsedName.server, (byServer.get(parsedName.server) ?? 0) + 1)
    }
    const mapped: ServerRow[] = [...byServer.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, tools: count, calls: 0, state: 'loaded' }))
    await update($, servers, () => mapped)
    await update($, connectorMode, () => 'read-only' as ConnectorMode)
    await update($, connectorNote, () => 'inferred from loaded tool names — a server that is off or failed does not appear')
  } catch (err) {
    await update($, connectorNote, () => `could not list tools: ${String(err)}`)
  }
}

/**
 * Switch a connector. Routed through an explicit confirm press in the UI,
 * because a plugin's `$.mcp.call` carries no permission prompt of its own —
 * the person pressing twice is what stands in for that approval.
 */
async function setConnector($: EngineInterface, name: string, enabled: boolean): Promise<void> {
  await update($, connectorNote, () => `${enabled ? 'enabling' : 'disabling'} ${name}…`)
  try {
    const res = await $.mcp.call('ccd_connectors', 'set_session_connector_enabled', {
      connector: name,
      enabled,
    })
    if ((res as { isError?: boolean })?.isError) {
      await update($, connectorNote, () => `host refused: ${textOf(res).slice(0, 160)}`)
      return
    }
    await update($, connectorNote, () => `${name} ${enabled ? 'on' : 'off'} — applies from the next turn`)
    await probeConnectors($)
  } catch (err) {
    await update($, connectorNote, () => `could not change ${name}: ${String(err)}`)
  }
}

const SERVER = 'http://127.0.0.1:7717'

/** Module-level handle for the live poller; a reload replaces it. */
let stopLive: (() => void) | null = null

/** A call to the explorer server. Resolves null when it is not running. */
async function callServer(
  $: EngineInterface,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<unknown | null> {
  try {
    const res = await $.http.fetch(`${SERVER}${path}`, {
      method: init?.method ?? 'GET',
      headers: { 'content-type': 'application/json' },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    if (!res.ok) return null
    return JSON.parse(res.text) as unknown
  } catch {
    return null
  }
}

/**
 * Live mode watches the server's write counter rather than re-reading the
 * graph, so an idle brain costs one tiny request per tick. It draws no tokens:
 * this is HTTP and a redraw, never a model call.
 */
async function pollGraph($: EngineInterface): Promise<void> {
  const res = (await callServer($, '/api/version')) as { version?: number } | null
  if (res === null) {
    await update($, serverUp, () => false)
    return
  }
  await update($, serverUp, () => true)
  const seen = await read($, seenVersion)
  if (res.version === undefined || res.version === seen) return
  await update($, seenVersion, () => res.version as number)
  if (seen !== -1) await refresh($)
}

async function toggleLive($: EngineInterface): Promise<void> {
  const on = !(await read($, liveOn))
  await update($, liveOn, () => on)
  stopLive?.()
  stopLive = null
  if (!on) {
    await update($, status, () => 'live off')
    return
  }
  await pollGraph($)
  try {
    const timer = $.clock.every(4000, () => {
      void pollGraph($)
    })
    if (typeof timer?.cancel === 'function') stopLive = timer.cancel
    await update($, status, () => '')
  } catch {
    await update($, liveOn, () => false)
    await update($, status, () => 'this session refused a timer; live is off')
  }
}

/** Edit a node through the server, then redraw both the pane and the web view. */
async function editNode(
  $: EngineInterface,
  id: string,
  patch: { props?: Record<string, string>; labels?: string[] },
): Promise<void> {
  const res = await callServer($, '/api/node', { method: 'PATCH', body: { id, ...patch } })
  if (res === null) {
    await update($, status, () => 'start the explorer first: ccmod dash --serve')
    return
  }
  await update($, status, () => 'saved')
  await selectNode($, id)
  await refresh($)
}

/** Shift a pinned node. Dragging lives in the browser; this is its keyboard twin. */
async function nudgeNode($: EngineInterface, id: string, dx: number, dy: number): Promise<void> {
  const current = (await callServer($, `/api/node?id=${encodeURIComponent(id)}`)) as
    | { node?: { props?: Record<string, unknown> } }
    | null
  if (current === null) {
    await update($, status, () => 'start the explorer first: ccmod dash --serve')
    return
  }
  const props = current.node?.props ?? {}
  const x = Number(props.pinX ?? 320) + dx
  const y = Number(props.pinY ?? 220) + dy
  await callServer($, '/api/position', { method: 'POST', body: { id, x, y } })
  await update($, status, () => `moved to ${x}, ${y}`)
  await selectNode($, id)
}

async function unpinNode($: EngineInterface, id: string): Promise<void> {
  await callServer($, '/api/position', { method: 'POST', body: { id, x: null, y: null } })
  await update($, status, () => 'unpinned — the layout decides again')
  await selectNode($, id)
}

async function deleteNode($: EngineInterface, id: string): Promise<void> {
  const res = await callServer($, '/api/node', { method: 'DELETE', body: { id } })
  if (res === null) {
    await update($, status, () => 'start the explorer first: ccmod dash --serve')
    return
  }
  await update($, selected, () => null)
  await update($, detail, () => null)
  await update($, view, () => 'list')
  await update($, status, () => 'deleted')
  await refresh($)
}

/** Plain usage read. Never pass a breakdown argument: that one costs tokens. */
async function pullUsage($: EngineInterface): Promise<void> {
  try {
    const u = await $.session.usage()
    await recordMeasure($, u.context, [...u.rateLimits], u.cost?.usd)
  } catch (err) {
    await update($, status, () => `could not read usage: ${String(err)}`)
  }
}

/** The surface's element table, as `$.ui.resolve` hands it back. */
type Els = ReturnType<EngineInterface['ui']['resolve']>

/**
 * One module's body, shared by the Vitals tabs and by the panel that module
 * becomes when it is pulled out — so a pulled-out panel is the same thing in
 * its own frame, never a second implementation that can drift.
 */
async function moduleTree(
  $: EngineInterface,
  els: Els,
  name: VitalsView,
  cols: number,
  rows: number,
): Promise<RenderElement> {
  const { Box, Text, Button } = els
  const u = await read($, usage)
  const history = await read($, turns)
  const runs = await read($, agents)
  const list = await read($, servers)
  const mode = await read($, connectorMode)
  const note = await read($, connectorNote)
  const wide = Math.max(10, Math.min(36, cols - 22))

  /** A bordered section, the shape the rest of the app uses for its panels. */
  const card = (title: string, sub: string | null, kids: RenderChildren) => (
    <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} gap={0}>
      <Text bold>{title}</Text>
      {sub !== null && <Text dimColor>{sub}</Text>}
      <Box flexDirection="column" marginTop={1} gap={0}>{kids}</Box>
    </Box>
  )

  /** Label left, value right — the row shape from the usage dashboard. */
  const stat = (label: string, value: string, tone?: string) => (
    <Box justifyContent="space-between" gap={2}>
      <Text dimColor>{label}</Text>
      <Text color={tone}>{value}</Text>
    </Box>
  )

  const meter = (label: string, frac: number | undefined, right: string) => (
    <Box flexDirection="column" gap={0}>
      <Box justifyContent="space-between" gap={2}>
        <Text dimColor>{label}</Text>
        <Text color={barColor(frac)}>{right}</Text>
      </Box>
      <Text color={barColor(frac)}>{bar(frac, wide)}</Text>
    </Box>
  )

  if (name === 'usage') {
    const frac = u?.percent !== undefined ? u.percent / 100 : undefined
    const last = history[history.length - 1]
    const hit = last ? cacheHitRate(last) : undefined
    return (
      <Box flexDirection="column" gap={1}>
        {u
          ? card(
              'Context',
              u.percent === undefined ? 'awaiting the first response' : `${fmtTokens(u.tokens)} of ${fmtTokens(u.window)}`,
              [
                meter('window', frac, u.percent === undefined ? '—' : `${Math.round(u.percent)}%`),
                stat('cost this session', fmtUsd(u.costUsd)),
              ],
            )
          : card('Context', 'nothing read yet', [<Text dimColor>Press Refresh below.</Text>])}
        {last
          ? card('Last turn', `${fmtDuration(last.durationMs)} · ${last.model}`, [
              stat('input', fmtTokens(last.input)),
              stat('output', fmtTokens(last.output)),
              stat('cache read', fmtTokens(last.cacheRead)),
              stat('cache write', fmtTokens(last.cacheWrite)),
              stat('cache hit', hit === undefined ? '—' : `${Math.round(hit * 100)}%`),
            ])
          : card('Last turn', 'no completed turn yet', [
              <Text dimColor>Figures appear when a turn finishes.</Text>,
            ])}
      </Box>
    )
  }

  if (name === 'turns') {
    const spark = sparkline(history.map(t => t.ctxTokens), Math.min(44, Math.max(8, cols - 12)))
    if (history.length === 0) {
      return card('Turns', 'nothing recorded yet', [
        <Text dimColor>Each finished turn adds a row here.</Text>,
      ])
    }
    return (
      <Box flexDirection="column" gap={1}>
        {card('Context over the session', `${history.length} turns`, [
          spark === '' ? <Text dimColor>no context figures yet</Text> : <Text color="claude">{spark}</Text>,
        ])}
        {card('Recent turns', null, [...history].reverse().slice(0, rows).map(t => (
          <Box justifyContent="space-between" gap={2}>
            <Text dimColor>{tierOf(t.model)} {t.reason === 'answer' ? '' : t.reason}</Text>
            <Text color={t.reason === 'answer' ? undefined : t.reason === 'aborted' ? 'warning' : 'error'}>
              {fmtDuration(t.durationMs)} · {fmtTokens(t.output)} out
            </Text>
          </Box>
        )))}
      </Box>
    )
  }

  if (name === 'agents') {
    const tally = { haiku: 0, sonnet: 0, opus: 0, other: 0 }
    for (const r of runs) tally[tierOf(r.resolvedModel ?? r.requestedModel)] += 1
    return (
      <Box flexDirection="column" gap={1}>
        {card('Delegation', `${runs.length} subagent${runs.length === 1 ? '' : 's'} this session`, [
          stat('haiku', String(tally.haiku), tally.haiku > 0 ? 'success' : undefined),
          stat('sonnet', String(tally.sonnet)),
          stat('opus', String(tally.opus)),
          stat('other', String(tally.other)),
        ])}
        {runs.length === 0
          ? card('Runs', 'none yet', [
              <Text dimColor>Send a simple prompt — the router</Text>,
              <Text dimColor>should delegate to haiku-worker.</Text>,
            ])
          : card('Runs', null, [...runs].reverse().slice(0, rows).map(r => {
              const ran = r.resolvedModel ?? r.requestedModel
              const drifted = r.requestedModel && r.resolvedModel && r.requestedModel !== r.resolvedModel
              return (
                <Box justifyContent="space-between" gap={2}>
                  <Box gap={1}>
                    <Text color={r.status === 'completed' ? 'success' : r.status === 'failed' ? 'error' : 'warning'}>
                      {r.status === 'completed' ? '✓' : r.status === 'failed' ? '✗' : '●'}
                    </Text>
                    <Text wrap="truncate-end">{r.type}</Text>
                  </Box>
                  <Text color={tierOf(ran) === 'haiku' ? 'success' : undefined}>
                    {ran ?? '?'}{drifted ? ` (asked ${r.requestedModel})` : ''}
                    {r.output > 0 ? ` · ${fmtTokens(r.output)}` : ''}
                  </Text>
                </Box>
              )
            }))}
        <Box gap={1}>
          <Button key="ag-refresh" label="Refresh statuses" onPress={() => refreshAgents($)} />
        </Box>
      </Box>
    )
  }

  if (name === 'limits') {
    const limits = u?.limits ?? []
    if (limits.length === 0) {
      return card('Rate limits', 'none reported', [
        <Text dimColor>Normal on API billing, or before</Text>,
        <Text dimColor>the first response of a session.</Text>,
      ])
    }
    return (
      <Box flexDirection="column" gap={1}>
        {limits.map(l =>
          card(
            l.kind === 'five_hour' ? '5-hour window' : l.kind === 'seven_day' ? 'Weekly' : l.kind,
            fmtReset(l.resetsAt, Date.now()) || null,
            [meter('used', l.percentUsed / 100, `${Math.round(l.percentUsed)}%`)],
          ),
        )}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      {card(
        'Connectors',
        mode === 'live' ? 'live status from the host' : mode === 'read-only' ? 'inferred from loaded tools' : 'not checked yet',
        [
          <Text dimColor wrap="truncate-end">
            {mode === 'live'
              ? 'Switching applies from the next turn.'
              : mode === 'read-only'
                ? 'One that is off or failed will not appear.'
                : 'Press Check below.'}
          </Text>,
          note !== '' ? <Text color="warning" wrap="truncate-end">{note}</Text> : null,
        ],
      )}
      {list.length === 0
        ? card('Servers', 'none seen', [<Text dimColor>No MCP servers loaded.</Text>])
        : card('Servers', `${list.length}`, list.slice(0, rows).map(srv => (
            <Box justifyContent="space-between" gap={2}>
              <Text wrap="truncate-end">{srv.name}</Text>
              <Box gap={1}>
                <Text dimColor>{srv.tools} tools</Text>
                {mode === 'live' && (
                  <Button
                    key={`conn-${srv.name}`}
                    label={srv.state.startsWith('connected') ? 'off' : 'on'}
                    onPress={() => setConnector($, srv.name, !srv.state.startsWith('connected'))}
                  />
                )}
              </Box>
            </Box>
          )))}
      <Box gap={1}>
        <Button key="conn-check" label="Check connectors" onPress={() => probeConnectors($)} />
      </Box>
    </Box>
  )
}

/** A pulled-out module, drawn in its own pane with a way back. */
async function panelFor(
  $: EngineInterface,
  els: Els,
  name: VitalsView,
  cols: number,
  rows: number,
): Promise<RenderElement> {
  const { Box, Button } = els

  return (
    <Box flexDirection="column" gap={1}>
      {await moduleTree($, els, name, cols, rows)}
      <Box gap={1}>
        <Button key={`p-${name}-refresh`} label="Refresh" onPress={() => pullUsage($)} />
        <Button key={`p-${name}-back`} label="Back to Vitals" onPress={() => putBack($, name)} />
      </Box>
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'second-brain',
      description: 'Open the knowledge-graph pane',
    })
    await $.command.register({
      name: 'vitals',
      description: 'Open the usage, progress and delegation pane',
    })
    void openPane($)

    return next(e)
  })

  on('command.run', { command: 'second-brain' }, async $ => {
    await openPane($)
    await refresh($)

    return { text: 'Second brain pane opened.' }
  })

  on('command.run', { command: 'vitals' }, async $ => {
    await openVitals($)
    await pullUsage($)
    await probeConnectors($)

    return { text: 'Vitals pane opened.' }
  })

  on('ui.close', { id: VITALS }, async ($, e, next) => {
    await update($, vitalsOpen, () => false)

    return next(e)
  })

  // --- observers. Each passes the event on first, then records inside a try,
  // so a fault in the dashboard can never break a turn. ---------------------

  on('session.measure', async ($, e, next) => {
    const passed = await next(e)
    try {
      await recordMeasure($, e.context, [...e.rateLimits], e.cost?.usd)
    } catch {}

    return passed
  })

  on('turn.start', async ($, e, next) => {
    const passed = await next(e)
    try {
      if (e.agentId === undefined) await startTurn($, e.turnId)
    } catch {}

    return passed
  })

  on('tool.call', async ($, e, next) => {
    try {
      if (e.agentId === undefined) await noteTool($, e.tool)
    } catch {}

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const passed = await next(e)
    try {
      const u = e.usage
      if (e.agentId !== undefined) {
        await noteAgentDone($, e.agentId, u?.model, u?.input_tokens ?? 0, u?.output_tokens ?? 0)
      } else {
        const at = await $.clock.now()
        await finishTurn($, {
          turnId: e.turnId,
          at,
          durationMs: e.durationMs,
          model: u?.model ?? '?',
          reason: e.reason,
          input: u?.input_tokens ?? 0,
          output: u?.output_tokens ?? 0,
          cacheRead: u?.cache_read_input_tokens ?? 0,
          cacheWrite: u?.cache_creation_input_tokens ?? 0,
        })
      }
    } catch {}

    return passed
  })

  // The delegation log. AgentInfo carries no model, so the model has to be
  // captured here, at the moment the subagent is spawned.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    try {
      const at = await $.clock.now()
      await noteAgentSpawn($, {
        agentId: started?.agentId ?? e.tool_use_id,
        type: e.subagentType,
        description: e.description,
        status: 'running',
        requestedModel: e.model,
        resolvedModel: started?.model,
        parentModel: e.parentModel,
        at,
        input: 0,
        output: 0,
      })
    } catch {}

    return started
  })

  // Remember that it went away, so the band can offer it back.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, isOpen, () => false)

    return next(e)
  })

  /**
   * The one row above the prompt. `AbovePrompt` is a single shared instance,
   * so everything this mod wants there is composed here rather than in a
   * second hook that would shadow this one.
   */
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const u = await read($, usage)
    const turn = await read($, live)
    const show = await read($, bandOn)
    const cols = e.props.bodyColumns ?? 80
    const working = e.props.isWorking === true

    const frac = u?.percent !== undefined ? u.percent / 100 : undefined
    const width = barWidth(cols)
    const worst = (u?.limits ?? [])
      .filter(l => l.kind !== 'spend_limit')
      .sort((a, b) => b.percentUsed - a.percentUsed)[0]

    // Mid-turn the static figures give way to the live ones, so the row never
    // grows and nothing below it shifts while work is running.
    const liveBits = []
    if (working && show.progress) {
      if (turn) {
        const secs = Math.max(0, Math.round(((await $.clock.now()) - turn.startedAt) / 1000))
        liveBits.push(
          <Text color="claude">{stopTick ? '⠿' : '~'} </Text>,
          <Text>{secs}s</Text>,
        )
        if (turn.tool) liveBits.push(<Text dimColor> · {turn.tool}</Text>)
      } else {
        liveBits.push(<Text dimColor>working…</Text>)
      }
    }

    // Each entry is a self-contained group, so the parent's `gap` separates
    // the groups while `ctx ███ 50%` stays tight as one unit.
    const idleBits = []
    if (!working && u) {
      if (show.context) {
        idleBits.push(
          <Box gap={1}>
            <Text dimColor>ctx</Text>
            {cols >= 45 && <Text color={barColor(frac)}>{bar(frac, width)}</Text>}
            <Text>{u.percent === undefined ? '—' : `${Math.round(u.percent)}%`}</Text>
            {cols >= 70 && <Text dimColor>{fmtTokens(u.tokens)}/{fmtTokens(u.window)}</Text>}
          </Box>,
        )
      }
      if (show.cost && u.costUsd !== undefined && cols >= 70) {
        idleBits.push(<Text>{fmtUsd(u.costUsd)}</Text>)
      }
      if (show.limits && worst && cols >= 100) {
        idleBits.push(
          <Box gap={1}>
            <Text dimColor>{worst.kind === 'five_hour' ? '5h' : worst.kind === 'seven_day' ? '7d' : worst.kind}</Text>
            <Text color={barColor(worst.percentUsed / 100)}>{Math.round(worst.percentUsed)}%</Text>
          </Box>,
        )
      }
    }

    // The band carries figures only. The panes are opened with `/vitals` and
    // `/second-brain`, so the row above the prompt stays free of chrome.
    if (liveBits.length === 0 && idleBits.length === 0) return next(e)

    // Grouped, not one flat row: `gap` separates the groups while each group
    // stays tight inside, so `ctx ███ 50%` reads as one unit.
    return (
      <Box gap={2} alignItems="center">
        {liveBits.length > 0 && <Box gap={1}>{liveBits}</Box>}
        {idleBits.length > 0 && <Box gap={2}>{idleBits}</Box>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // The resolved table answers for any name, so `'Svg' in elements` tests
    // nothing: on the terminal it yields an element the surface then drops,
    // leaving an empty box where the graph should be. Ask the surface instead,
    // and let a surface this build has never heard of take the text form.
    const drawsSvg =
      e.surface === 'desktop' || e.surface === 'vscode' || e.surface === 'mobile'
    const drawsInput =
      e.surface === 'desktop' || e.surface === 'vscode' || e.surface === 'terminal'
    const Svg = drawsSvg && 'Svg' in elements ? elements.Svg : null
    const Input = drawsInput && 'Input' in elements ? elements.Input : null

    const g = await read($, graph)
    const note = await read($, status)
    const live = await read($, liveOn)
    const up = await read($, serverUp)
    const where = await read($, view)
    const hiddenLabels = await read($, hidden)
    const look = await read($, prefs)
    const found = await read($, hits)
    const q = await read($, query)
    const open = await read($, detail)
    const pick = await read($, selected)

    const tabs = (
      <Box gap={1}>
        {(['graph', 'list', 'detail', 'settings'] as const).map(name => (
          <Button
            key={`tab-${name}`}
            label={where === name ? `● ${name}` : name}
            onPress={() => setView($, name)}
          />
        ))}
      </Box>
    )

    const actions = (
      <Box gap={1}>
        <Button key="refresh" label="Refresh" hotkey="r" onPress={() => refresh($)} />
        <Button key="update" label="Update brain" hotkey="u" onPress={() => rescan($)} />
        <Button key="vitals" label="Vitals" onPress={() => openVitals($)} />
        <Button
          key="live"
          label={live ? '◉ live' : '○ live'}
          onPress={() => toggleLive($)}
        />
      </Box>
    )

    if (!g) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{note || 'Nothing loaded yet — press Refresh.'}</Text>
          {actions}
        </Box>
      )
    }

    const order = g.labels.map(l => l.label)
    const share = Math.round(g.router.lightShare * 100)
    const rows = Math.max(4, (e.props.scroll?.bodyRows ?? 24) - 10)
    // A cell's pixel size differs per surface and font, so this is an estimate
    // the person can correct from the settings tab rather than one I can read.
    const drawW = Math.max(
      320,
      Math.min(1600, Math.round(e.props.bodyColumns * 11 * look.zoom)),
    )
    const drawH = Math.max(
      240,
      Math.min(1100, Math.round(((e.props.scroll?.bodyRows ?? 26) - 9) * 20 * look.zoom)),
    )

    const header = (
      <Box gap={1}>
        <Text bold>{g.stats.nodes}</Text>
        <Text dimColor> nodes </Text>
        <Text bold>{g.stats.edges}</Text>
        <Text dimColor> edges </Text>
        {g.relay.active > 0 && <Text color="green">{g.relay.active} peer </Text>}
        {g.relay.pending > 0 && <Text color="yellow">{g.relay.pending} unread </Text>}
        {g.router.total > 0 && <Text dimColor>{share}% → haiku</Text>}
        {live && <Text color={up ? 'success' : 'warning'}>{up ? '◉ live' : '◉ no server'}</Text>}
      </Box>
    )

    let body = <Text dimColor>…</Text>

    if (where === 'graph') {
      const shown = visible(g, hiddenLabels)
      const highlight = found.map(h => h.id)
      body = (
        <Box flexDirection="column">
          <Box gap={1}>
            {g.labels.slice(0, 8).map(l => (
              <Button
                key={`chip-${l.label}`}
                label={`${hiddenLabels.includes(l.label) ? '○' : '●'} ${l.label} ${l.c} `}
                onPress={() => toggleLabel($, l.label)}
              />
            ))}
          </Box>
          {Svg ? (
            <Svg
              source={svgFor(g, hiddenLabels, look, drawW, drawH, highlight)}
              alt={`Knowledge graph: ${shown.nodes.length} nodes, ${shown.edges.length} edges`}
              width={drawW}
              height={drawH}
              isInteractive
            />
          ) : (
            <Box flexDirection="column">
              {shown.nodes.slice(0, rows).map(node => (
                <Text>
                  {String(node.degree).padStart(3)} {node.title.slice(0, 32)}{' '}
                  <Text dimColor>{node.label}</Text>
                </Text>
              ))}
              {shown.nodes.length === 0 && <Text dimColor>every label is hidden</Text>}
            </Box>
          )}
        </Box>
      )
    }

    if (where === 'list') {
      const shown = visible(g, hiddenLabels)
      const listed: { id: string; title: string; label: string }[] =
        found.length > 0
          ? found
          : shown.nodes.map(n => ({ id: n.id, title: n.title, label: n.label }))
      body = (
        <Box flexDirection="column">
          {Input ? (
            <Input
              key="search"
              placeholder="search the brain…"
              value={q}
              submitLabel="search"
              onSubmit={(text: string) => runSearch($, text)}
            />
          ) : (
            <Text dimColor>{q ? `search: ${q}` : 'browsing every node'}</Text>
          )}
          {found.length > 0 && (
            <Box>
              <Text dimColor>{found.length} match{found.length === 1 ? '' : 'es'} </Text>
              <Button key="clear" label="clear" onPress={() => clearSearch($)} />
            </Box>
          )}
          {listed.slice(0, rows).map(node => (
            // A Button takes one string child or a label, never a mixed tree,
            // so the kind rides in the label rather than in a dim child.
            <Button
              key={`open-${node.id}`}
              label={`${node.title.slice(0, 34)}  ${node.label}`}
              onPress={() => selectNode($, node.id)}
            />
          ))}
          {listed.length === 0 && <Text dimColor>nothing to list</Text>}
        </Box>
      )
    }

    if (where === 'detail') {
      const node = open?.node
      body = !node ? (
        <Text dimColor>{pick ? note || 'opening…' : 'Pick a node in the list tab.'}</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
            <Text bold>{node.title}</Text>
            <Text dimColor>{node.labels.join(', ')}</Text>
            <Text dimColor>{node.id}</Text>
            {node.props.path !== undefined && <Text dimColor wrap="truncate-end">{node.props.path}</Text>}
            {node.props.pinX !== undefined && (
              <Text dimColor>pinned at {node.props.pinX}, {node.props.pinY}</Text>
            )}
          </Box>

          {node.body !== '' && <Text wrap="truncate-end">{node.body.slice(0, 220)}</Text>}

          {Input && (
            <Input
              key="rename"
              label="rename"
              placeholder={node.title}
              submitLabel="save"
              onSubmit={(text: string) => editNode($, node.id, { props: { title: text } })}
            />
          )}

          {/* Dragging belongs to the browser; these are its keyboard twin and
              write the same pinned position the explorer reads. */}
          <Box gap={1}>
            <Text dimColor>move</Text>
            <Button key="nudge-l" label="←" onPress={() => nudgeNode($, node.id, -40, 0)} />
            <Button key="nudge-u" label="↑" onPress={() => nudgeNode($, node.id, 0, -40)} />
            <Button key="nudge-d" label="↓" onPress={() => nudgeNode($, node.id, 0, 40)} />
            <Button key="nudge-r" label="→" onPress={() => nudgeNode($, node.id, 40, 0)} />
            <Button key="unpin" label="unpin" onPress={() => unpinNode($, node.id)} />
          </Box>

          <Box gap={1}>
            <Button key="del-node" label="Delete node" onPress={() => deleteNode($, node.id)} />
          </Box>

          <Text dimColor>
            {open.neighbors.length} connection{open.neighbors.length === 1 ? '' : 's'}
          </Text>
          {open.neighbors.slice(0, rows).map(n => (
            <Button
              key={`hop-${n.id}-${n.type}`}
              label={`${n.dir === 'out' ? '→' : '←'} ${n.type}  ${n.title.slice(0, 26)}`}
              onPress={() => selectNode($, n.id)}
            />
          ))}
        </Box>
      )
    }

    if (where === 'settings') {
      body = (
        <Box flexDirection="column">
          <Text dimColor>drawing</Text>
          <Box gap={1}>
            <Button
              key="cap"
              label={`captions ${look.captions ? 'on' : 'off'}`}
              onPress={() => toggleCaptions($)}
            />
            <Button
              key="edg"
              label={`links ${look.edges ? 'on' : 'off'}`}
              onPress={() => toggleEdges($)}
            />
          </Box>
          <Box gap={1}>
            <Button key="dot" label={`dot size ${look.dots.toFixed(1)}×`} onPress={() => cycleDots($)} />
            <Button key="spr" label={`spread ${look.spread.toFixed(1)}×`} onPress={() => cycleSpread($)} />
          </Box>
          <Box gap={1}>
            <Button key="zoom" label={`size ${look.zoom.toFixed(1)}×`} onPress={() => cycleZoom($)} />
            <Text dimColor> {drawW}×{drawH}px — grow it until it fills the pane</Text>
          </Box>
          <Text dimColor>labels</Text>
          {g.labels.map(l => (
            <Button
              key={`set-${l.label}`}
              label={`${hiddenLabels.includes(l.label) ? '○ hidden' : '● shown '}  ${l.label} (${l.c})`}
              onPress={() => toggleLabel($, l.label)}
            />
          ))}
          <Box gap={1}>
            <Button key="all" label="show all" onPress={() => showEveryLabel($)} />
            <Button key="reset" label="reset look" onPress={() => resetLook($)} />
          </Box>
          <Text dimColor>read {g.at.slice(11, 19)} · {g.nodes.length} of {g.stats.nodes} nodes drawn</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {tabs}
        {body}
        {note !== '' && <Text color="yellow">{note}</Text>}
        {actions}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: VITALS }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const tab = await read($, vitalsView)
    const out = await read($, popped)
    const cols = e.props.bodyColumns ?? 60
    const rows = Math.max(4, (e.props.scroll?.bodyRows ?? 24) - 14)

    const tabs = (
      <Box gap={1}>
        {MODULES.map(name => (
          <Button
            key={`vt-${name}`}
            label={tab === name ? `● ${name}` : name}
            onPress={() => setVitalsView($, name)}
          />
        ))}
      </Box>
    )

    const isOut = out.includes(tab)

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        {isOut ? (
          <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
            <Text bold>{titleFor(tab)}</Text>
            <Text dimColor>pulled out into a panel of its own</Text>
            <Box marginTop={1} gap={1}>
              <Button key="vt-goto" label="Show that panel" onPress={() => popOut($, tab)} />
              <Button key="vt-back" label="Put it back" onPress={() => putBack($, tab)} />
            </Box>
          </Box>
        ) : (
          await moduleTree($, $.ui.resolve(e), tab, cols, rows)
        )}
        <Box gap={1}>
          <Button key="v-refresh" label="Refresh" hotkey="r" onPress={() => pullUsage($)} />
          {!isOut && <Button key="v-pop" label="⇱ Pull out" onPress={() => popOut($, tab)} />}
          <Button key="v-brain" label="Second brain" onPress={() => openPane($)} />
        </Box>
      </Box>
    )
  })

  // One pane per module, so a pulled-out module keeps its own titled frame.
  // The surface stacks them as tabs beside the transcript.
  on('ui.render', { component: 'Pane', requestId: 'sb-usage' }, async ($, e) =>
    panelFor($, $.ui.resolve(e), 'usage', e.props.bodyColumns ?? 48,
      Math.max(4, (e.props.scroll?.bodyRows ?? 24) - 6)),
  )
  on('ui.render', { component: 'Pane', requestId: 'sb-turns' }, async ($, e) =>
    panelFor($, $.ui.resolve(e), 'turns', e.props.bodyColumns ?? 48,
      Math.max(4, (e.props.scroll?.bodyRows ?? 24) - 6)),
  )
  on('ui.render', { component: 'Pane', requestId: 'sb-agents' }, async ($, e) =>
    panelFor($, $.ui.resolve(e), 'agents', e.props.bodyColumns ?? 48,
      Math.max(4, (e.props.scroll?.bodyRows ?? 24) - 6)),
  )
  on('ui.render', { component: 'Pane', requestId: 'sb-limits' }, async ($, e) =>
    panelFor($, $.ui.resolve(e), 'limits', e.props.bodyColumns ?? 48,
      Math.max(4, (e.props.scroll?.bodyRows ?? 24) - 6)),
  )
  on('ui.render', { component: 'Pane', requestId: 'sb-connectors' }, async ($, e) =>
    panelFor($, $.ui.resolve(e), 'connectors', e.props.bodyColumns ?? 48,
      Math.max(4, (e.props.scroll?.bodyRows ?? 24) - 6)),
  )

  // Closing a pulled-out panel returns that module to the Vitals tabs.
  on('ui.close', { id: 'sb-usage' }, async ($, e, next) => {
    await update($, popped, l => l.filter(n => n !== 'usage'))
    return next(e)
  })
  on('ui.close', { id: 'sb-turns' }, async ($, e, next) => {
    await update($, popped, l => l.filter(n => n !== 'turns'))
    return next(e)
  })
  on('ui.close', { id: 'sb-agents' }, async ($, e, next) => {
    await update($, popped, l => l.filter(n => n !== 'agents'))
    return next(e)
  })
  on('ui.close', { id: 'sb-limits' }, async ($, e, next) => {
    await update($, popped, l => l.filter(n => n !== 'limits'))
    return next(e)
  })
  on('ui.close', { id: 'sb-connectors' }, async ($, e, next) => {
    await update($, popped, l => l.filter(n => n !== 'connectors'))
    return next(e)
  })
}
