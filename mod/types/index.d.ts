export type BrainNode = {
  id: string
  title: string
  label: string
  degree: number
}

export type BrainEdge = { s: number; t: number; type: string }

export type BrainGraph = {
  at: string
  stats: { nodes: number; edges: number; orphans: number }
  labels: { label: string; c: number }[]
  nodes: BrainNode[]
  edges: BrainEdge[]
  relay: { active: number; pending: number }
  router: { total: number; lightShare: number }
  truncated: boolean
}

export type Connection = {
  type: string
  dir: 'in' | 'out'
  id: string
  title: string
  label: string
}

export type NodeDetail = {
  node: {
    id: string
    title: string
    labels: string[]
    props: Record<string, string>
    body: string
    updated: string
  } | null
  neighbors: Connection[]
}

export type SearchHit = { id: string; title: string; label: string }

export type ViewName = 'graph' | 'list' | 'detail' | 'settings'

export type Prefs = {
  captions: boolean
  edges: boolean
  dots: number
  spread: number
  /** Multiplier on the drawing's size, cycled from the settings tab. */
  zoom: number
}

export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type Usage = {
  tokens?: number
  window: number
  percent?: number
  costUsd?: number
  limits: RateLimit[]
  startedAt: number
  updatedAt: number
}

/** The turn in flight, if any. `tool` is whatever last started running. */
export type LiveTurn = {
  turnId: string
  startedAt: number
  tool: string | null
}

export type TurnRecord = {
  turnId: string
  at: number
  durationMs: number
  model: string
  reason: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  ctxTokens?: number
  compacted?: boolean
}

/**
 * One subagent run. The model is captured at spawn because AgentInfo from
 * $.agent.list() carries no model field.
 */
export type AgentRow = {
  agentId: string
  type: string
  description: string
  status: string
  requestedModel?: string
  resolvedModel?: string
  parentModel?: string
  at: number
  input: number
  output: number
}

export type ServerRow = {
  name: string
  tools: number
  calls: number
  state: string
}

/** How much control the connectors tab actually has, decided by a runtime probe. */
export type ConnectorMode = 'unknown' | 'live' | 'settings' | 'read-only'

export type VitalsView = 'usage' | 'turns' | 'agents' | 'limits' | 'connectors'

export type BandOn = {
  context: boolean
  progress: boolean
  cost: boolean
  limits: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'second-brain': {
      graph: BrainGraph | null
      status: string
      view: ViewName
      hidden: string[]
      selected: string | null
      detail: NodeDetail | null
      hits: SearchHit[]
      query: string
      prefs: Prefs
      /** Whether the pane is up, so the band can offer to bring it back. */
      isOpen: boolean
      usage: Usage | null
      live: LiveTurn | null
      turns: TurnRecord[]
      agents: AgentRow[]
      servers: ServerRow[]
      connectorMode: ConnectorMode
      connectorNote: string
      vitalsView: VitalsView
      vitalsOpen: boolean
      bandOn: BandOn
      /** Modules the person has pulled out into panels of their own. */
      popped: VitalsView[]
      /** Live mode polls the server's write counter; off by default. */
      liveOn: boolean
      /** Last write-counter value seen, so a poll knows when to redraw. */
      seenVersion: number
      /** Whether the explorer server answered the last time we tried it. */
      serverUp: boolean
    }
  }
}
