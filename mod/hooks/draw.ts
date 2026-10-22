/**
 * Pure drawing helpers. Nothing here takes `$` or touches the engine, so it
 * all unit-tests directly and keeps register.tsx down to hooks and trees.
 */
import type { BrainEdge, BrainGraph, BrainNode, Prefs } from '../types'

// --- numbers --------------------------------------------------------------

export function fmtTokens(n?: number): string {
  if (n === undefined || !Number.isFinite(n)) return '—'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function fmtUsd(n?: number): string {
  if (n === undefined || !Number.isFinite(n)) return '—'
  return n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** "resets in 2h 14m", or a plain dash when the stamp is missing or unparseable. */
export function fmtReset(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at)) return ''
  const left = at - now
  if (left <= 0) return 'resetting'
  return `resets in ${fmtDuration(left)}`
}

/**
 * Share of input that came from cache. Undefined rather than zero when there
 * is no input at all, so the UI can say "—" instead of implying a 0% hit rate.
 */
export function cacheHitRate(u: { input: number; cacheRead: number; cacheWrite: number }): number | undefined {
  const total = u.input + u.cacheRead + u.cacheWrite
  return total > 0 ? u.cacheRead / total : undefined
}

export function tierOf(model?: string): 'haiku' | 'sonnet' | 'opus' | 'other' {
  const m = (model || '').toLowerCase()
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('opus')) return 'opus'
  return 'other'
}

/** `mcp__linear__create_issue` -> { server: 'linear', tool: 'create_issue' }. */
export function parseMcpName(name: string): { server: string; tool: string } | null {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name)
  if (!m || !m[1] || !m[2]) return null
  return { server: m[1], tool: m[2] }
}

// --- bars -----------------------------------------------------------------

/**
 * A meter drawn from text, since the API has no progress or meter element.
 * Rounding never lets a partial bar read as full or empty: anything above zero
 * keeps one filled cell, anything below one keeps one empty cell.
 */
export function bar(frac: number | undefined, width: number): string {
  const w = Math.max(1, Math.floor(width))
  if (frac === undefined || !Number.isFinite(frac)) return '░'.repeat(w)
  const clamped = Math.min(1, Math.max(0, frac))
  let filled = Math.round(clamped * w)
  if (clamped > 0 && filled === 0) filled = 1
  if (clamped < 1 && filled === w) filled = w - 1
  return '█'.repeat(filled) + '░'.repeat(w - filled)
}

export function barWidth(bodyColumns: number): number {
  return Math.max(6, Math.min(24, Math.floor(bodyColumns * 0.14)))
}

export function barColor(frac: number | undefined): string {
  if (frac === undefined) return 'subtle'
  if (frac < 0.6) return 'success'
  if (frac < 0.85) return 'warning'
  return 'error'
}

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

/** Sparkline over a series; gaps render as `·` rather than dropping out. */
export function sparkline(values: readonly (number | undefined)[], width: number): string {
  const tail = values.slice(-Math.max(1, width))
  const known = tail.filter((v): v is number => v !== undefined && Number.isFinite(v))
  if (known.length === 0) return ''
  const lo = Math.min(...known)
  const hi = Math.max(...known)
  const span = hi - lo
  return tail
    .map(v => {
      if (v === undefined || !Number.isFinite(v)) return '·'
      if (span === 0) return SPARK[0] ?? '▁'
      const i = Math.round(((v - lo) / span) * (SPARK.length - 1))
      return SPARK[Math.min(SPARK.length - 1, Math.max(0, i))] ?? '▁'
    })
    .join('')
}

// --- the knowledge graph drawing -----------------------------------------

const PALETTE = [
  '#7c6cf0', '#19b3a6', '#e0894c', '#d9566f',
  '#5aa0e8', '#9b59d0', '#52a65b', '#c9a227', '#8a8f98',
]

export function colorOf(label: string, order: readonly string[]): string {
  const at = order.indexOf(label)
  return PALETTE[(at < 0 ? order.length : at) % PALETTE.length] ?? '#8a8f98'
}

export const xml = (s: string): string =>
  s.replace(/[&<>"']/g, c =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;',
  )

type Placed = BrainNode & { x: number; y: number }
type Sim = Placed & { vx: number; vy: number }

/** The graph with hidden labels dropped and the edge indices remapped onto it. */
export function visible(g: BrainGraph, hiddenLabels: readonly string[]) {
  if (hiddenLabels.length === 0) return { nodes: g.nodes, edges: g.edges }
  const keep: BrainNode[] = []
  const moved = new Map<number, number>()
  g.nodes.forEach((node, i) => {
    if (hiddenLabels.includes(node.label)) return
    moved.set(i, keep.length)
    keep.push(node)
  })
  const edges: BrainEdge[] = []
  for (const edge of g.edges) {
    const s = moved.get(edge.s)
    const t = moved.get(edge.t)
    if (s === undefined || t === undefined) continue
    edges.push({ s, t, type: edge.type })
  }
  return { nodes: keep, edges }
}

/**
 * Force-directed layout, run to a fixed number of steps from a fixed starting
 * ring. No randomness anywhere: the same graph must land in the same shape on
 * every redraw, or the pane would jitter each time a hook re-renders it.
 *
 * Velocity rides on the node objects rather than in side arrays, so every read
 * is a property access and the loop needs no index guards.
 */
export function layout(
  nodes: readonly BrainNode[],
  edges: readonly BrainEdge[],
  w: number,
  h: number,
  spread: number,
): Placed[] {
  const n = nodes.length
  if (n === 0) return []

  const radius = Math.min(w, h) * 0.34
  const sim: Sim[] = nodes.map((node, i) => ({
    ...node,
    x: w / 2 + radius * Math.cos((2 * Math.PI * i) / n),
    y: h / 2 + radius * Math.sin((2 * Math.PI * i) / n),
    vx: 0,
    vy: 0,
  }))
  if (n === 1) return sim

  const repel = 5200 * spread
  const rest = Math.max(42, Math.min(96, 420 / Math.sqrt(n))) * spread

  for (let step = 0; step < 240; step++) {
    const cool = 1 - step / 260

    for (let i = 0; i < n; i++) {
      const a = sim[i]
      if (!a) continue
      for (let j = i + 1; j < n; j++) {
        const b = sim[j]
        if (!b) continue
        let dx = b.x - a.x
        let dy = b.y - a.y
        let d2 = dx * dx + dy * dy
        if (d2 < 1) { dx = (i - j) * 0.5; dy = (j - i) * 0.5; d2 = 1 }
        const d = Math.sqrt(d2)
        const f = repel / d2
        const fx = (dx / d) * f
        const fy = (dy / d) * f
        a.vx -= fx; a.vy -= fy
        b.vx += fx; b.vy += fy
      }
    }

    for (const edge of edges) {
      const a = sim[edge.s]
      const b = sim[edge.t]
      if (!a || !b) continue
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d = Math.hypot(dx, dy) || 0.01
      const f = (d - rest) * 0.05
      const fx = (dx / d) * f
      const fy = (dy / d) * f
      a.vx += fx; a.vy += fy
      b.vx -= fx; b.vy -= fy
    }

    for (const p of sim) {
      p.vx += (w / 2 - p.x) * 0.015
      p.vy += (h / 2 - p.y) * 0.015
      p.x += Math.max(-24, Math.min(24, p.vx * cool))
      p.y += Math.max(-24, Math.min(24, p.vy * cool))
      p.vx *= 0.82; p.vy *= 0.82
    }
  }

  // Fit the drawing to the frame so a sparse graph is not a dot in the middle.
  const pad = 26
  const xs = sim.map(p => p.x)
  const ys = sim.map(p => p.y)
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  const scale = Math.min(
    (w - pad * 2) / Math.max(1, maxX - minX),
    (h - pad * 2) / Math.max(1, maxY - minY),
    1.9,
  )
  for (const p of sim) {
    p.x = pad + (p.x - minX) * scale + (w - pad * 2 - (maxX - minX) * scale) / 2
    p.y = pad + (p.y - minY) * scale + (h - pad * 2 - (maxY - minY) * scale) / 2
  }
  return sim
}

export function svgFor(
  g: BrainGraph,
  hiddenLabels: readonly string[],
  look: Prefs,
  W: number,
  H: number,
  highlight: readonly string[],
): string {
  // The viewBox is the drawn size, so the layout spreads into the whole pane
  // instead of being computed small and scaled up into a corner of it.
  const order = g.labels.map(l => l.label)
  const { nodes, edges } = visible(g, hiddenLabels)
  if (nodes.length === 0) {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">` +
      `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13" fill="currentColor" fill-opacity="0.5">every label is hidden</text></svg>`
    )
  }

  const placed = layout(nodes, edges, W, H, look.spread)
  const maxDegree = Math.max(1, ...placed.map(p => p.degree))
  const lit = new Set(highlight)

  const lines = look.edges
    ? edges
        .map(edge => {
          const a = placed[edge.s]
          const b = placed[edge.t]
          if (!a || !b) return ''
          return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="currentColor" stroke-opacity="0.22" stroke-width="1"/>`
        })
        .join('')
    : ''

  const dots = placed
    .map(p => {
      const r = (4 + Math.sqrt(p.degree / maxDegree) * 9) * look.dots
      const dim = lit.size > 0 && !lit.has(p.id)
      return (
        `<g><title>${xml(p.title)} — ${xml(p.label)}, ${p.degree} link${p.degree === 1 ? '' : 's'}</title>` +
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}" fill="${colorOf(p.label, order)}" fill-opacity="${dim ? '0.18' : '0.92'}"/>` +
        (lit.has(p.id)
          ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${(r + 3.5).toFixed(1)}" fill="none" stroke="currentColor" stroke-opacity="0.75" stroke-width="1.5"/>`
          : '') +
        `</g>`
      )
    })
    .join('')

  // Captions collided into unreadable mush before this: each one claims a box,
  // and a later caption that would overlap a claimed box is simply dropped.
  const claimed: { x: number; y: number; half: number }[] = []
  const captions = look.captions
    ? placed
        .filter(p => p.degree >= 3 || lit.has(p.id))
        .sort((a, b) => b.degree - a.degree)
        .slice(0, 14)
        .map(p => {
          const text = p.title.slice(0, 26)
          const r = (4 + Math.sqrt(p.degree / maxDegree) * 9) * look.dots
          const y = p.y - r - 5
          const half = text.length * 3.1
          const clash = claimed.some(
            c => Math.abs(c.y - y) < 13 && Math.abs(c.x - p.x) < c.half + half,
          )
          if (clash) return ''
          claimed.push({ x: p.x, y, half })
          return `<text x="${p.x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="11" fill="currentColor" fill-opacity="0.8">${xml(text)}</text>`
        })
        .join('')
    : ''

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">` +
    `<g>${lines}${dots}${captions}</g></svg>`
  )
}
