/**
 * Dashboard data layer. Every widget is a named collector, so the interface
 * is whatever subset config/dash.json asks for, in whatever order.
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { PROJECTS, CONFIG, readJSON, writeJSON, decodeProjectDir } from './paths.mjs';
import * as g from './graph.mjs';
import * as relay from './relay.mjs';
const relayPeers = (...a) => relay.peers(...a);
import { routerStats } from './router.mjs';
import { summarizeTranscript, brainConfig } from './ingest.mjs';

const DASH_CONFIG = join(CONFIG, 'dash.json');

export const DEFAULT_DASH = {
  title: 'Second Brain',
  accent: '#7c6cf0',
  theme: 'auto',
  refreshSeconds: 10,
  widgets: [
    { id: 'graph',    title: 'Knowledge graph', enabled: true, span: 'full' },
    { id: 'sessions', title: 'Sessions',        enabled: true, span: 'half' },
    { id: 'relay',    title: 'Session relay',   enabled: true, span: 'half' },
    { id: 'router',   title: 'Model routing',   enabled: true, span: 'half' },
    { id: 'labels',   title: 'Graph breakdown', enabled: true, span: 'half' },
    { id: 'hubs',     title: 'Most connected',  enabled: true, span: 'half' },
    { id: 'tools',    title: 'Tool usage',      enabled: true, span: 'half' },
  ],
};

export function dashConfig() {
  const user = readJSON(DASH_CONFIG, null);
  if (!user) return structuredClone(DEFAULT_DASH);
  // Keep any widget the user has not seen yet, so upgrades don't hide features.
  const known = new Set((user.widgets || []).map((w) => w.id));
  const widgets = [...(user.widgets || [])];
  for (const w of DEFAULT_DASH.widgets) if (!known.has(w.id)) widgets.push({ ...w, enabled: false });
  return { ...DEFAULT_DASH, ...user, widgets };
}

export function saveDashConfig(cfg) {
  const merged = { ...dashConfig(), ...cfg };
  writeJSON(DASH_CONFIG, merged);
  return merged;
}

// --- collectors -------------------------------------------------------------

function collectSessions({ limit = 12 } = {}) {
  if (!existsSync(PROJECTS)) return [];
  const live = new Map(relay.peers({ includeStale: true }).map((p) => [p.sessionId, p]));
  const rows = [];
  for (const projDir of readdirSync(PROJECTS)) {
    const dir = join(PROJECTS, projDir);
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const full = join(dir, f);
      const mtime = statSync(full).mtimeMs;
      rows.push({ full, projDir, mtime });
    }
  }
  return rows
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map(({ full, projDir, mtime }) => {
      const meta = summarizeTranscript(full) || {};
      const peer = live.get(meta.sessionId);
      return {
        sessionId: meta.sessionId,
        short: (meta.sessionId || '').slice(0, 8),
        title: meta.title || meta.lastPrompt?.slice(0, 70) || '(untitled)',
        project: basename(decodeProjectDir(projDir)) || projDir,
        turns: meta.turns || 0,
        tools: meta.tools || [],
        mode: meta.mode || null,
        updated: new Date(mtime).toISOString(),
        relayState: peer?.state || null,
        relayName: peer?.name || null,
        relayRole: peer?.role || null,
        pending: peer ? peer.pending : 0,
      };
    });
}

function collectRelay() {
  const list = relay.peers({ includeStale: true });
  return {
    peers: list,
    active: list.filter((p) => p.state === 'active').length,
    pending: list.reduce((n, p) => n + (p.pending || 0), 0),
    history: relay.history(15),
    config: relay.relayConfig(),
  };
}

function collectGraph() {
  const s = g.stats();
  return {
    nodes: s.nodes,
    edges: s.edges,
    orphans: s.orphans,
    labels: s.byLabel,
    types: s.byType,
    recent: g.find({ limit: 8 }).map((n) => ({
      id: n.id, title: n.props.title || n.id, labels: n.labels, updated: n.updated,
    })),
    sources: brainConfig(),
  };
}

function collectHubs() {
  return g.stats().hubs.map((h) => ({
    id: h.id,
    degree: h.degree,
    title: h.node?.props?.title || h.id,
    labels: h.node?.labels || [],
  }));
}

function collectTools() {
  const counts = {};
  for (const n of g.find({ label: 'Session', limit: 400 })) {
    for (const t of String(n.props.tools || '').split(',').filter(Boolean)) {
      counts[t] = (counts[t] || 0) + 1;
    }
  }
  // mcp__some__long__server__prefix__tool all truncate to the same string in a
  // narrow column, so show the tool name and keep the server as a hint.
  const shorten = (n) => {
    const m = n.match(/^mcp__(.+?)__(.+)$/);
    return m ? `${m[2]} (${m[1].slice(0, 8)})` : n;
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([name, count]) => ({ name: shorten(name), count, raw: name }));
}

const COLLECTORS = {
  sessions: collectSessions,
  relay: collectRelay,
  graph: collectGraph,
  labels: () => g.stats().byLabel,
  hubs: collectHubs,
  router: routerStats,
  tools: collectTools,
};

/** Gather data for the enabled widgets only. */
export function snapshot({ widgets } = {}) {
  const cfg = dashConfig();
  const wanted = widgets || cfg.widgets.filter((w) => w.enabled).map((w) => w.id);
  const data = {};
  for (const id of wanted) {
    const fn = COLLECTORS[id];
    if (!fn) continue;
    try { data[id] = fn(); } catch (err) { data[id] = { error: String(err.message || err) }; }
  }
  return { config: cfg, at: new Date().toISOString(), data };
}


/**
 * Compact payload for the Claude Code pane mod: the busiest slice of the graph
 * plus the headline counters. Edges are index-based to keep the JSON small,
 * since this crosses a process boundary on every refresh.
 */
export function paneSnapshot({ limit = 60 } = {}) {
  const full = g.dump({ limit: 4000 });
  const ranked = [...full.nodes].sort((a, b) => (b.degree || 0) - (a.degree || 0)).slice(0, limit);
  const index = new Map(ranked.map((n, i) => [n.id, i]));
  const nodes = ranked.map((n) => ({
    id: n.id,
    title: String(n.props?.title || n.id).slice(0, 48),
    label: (n.labels || []).find((l) => l !== 'Stub') || 'Node',
    degree: n.degree || 0,
  }));
  const edges = full.edges
    .filter((e) => index.has(e.src) && index.has(e.dst))
    .map((e) => ({ s: index.get(e.src), t: index.get(e.dst), type: e.type }));

  const s = g.stats();
  let relay = { active: 0, pending: 0 };
  try {
    const peers = relayPeers({ includeStale: false });
    relay = {
      active: peers.filter((p) => p.state === 'active').length,
      pending: peers.reduce((n, p) => n + (p.pending || 0), 0),
    };
  } catch {}
  let router = { total: 0, lightShare: 0 };
  try { const r = routerStats(); router = { total: r.total, lightShare: r.lightShare }; } catch {}

  return {
    at: new Date().toISOString(),
    stats: { nodes: s.nodes, edges: s.edges, orphans: s.orphans },
    labels: s.byLabel.map((l) => ({ label: l.label, c: l.c })),
    nodes,
    edges,
    relay,
    router,
    truncated: full.nodes.length > ranked.length,
  };
}


/** One node with its connections, shaped for the pane's detail view. */
export function nodeDetail(id) {
  const node = g.getNode(id);
  if (!node) return { node: null, neighbors: [] };
  const props = {};
  for (const [k, v] of Object.entries(node.props || {})) {
    if (k === 'body') continue;
    const text = String(v);
    if (text) props[k] = text.slice(0, 300);
  }
  const body = String(node.props?.body || '').slice(0, 900);
  return {
    node: {
      id: node.id,
      title: String(node.props?.title || node.id),
      labels: node.labels || [],
      props,
      body,
      updated: node.updated,
    },
    neighbors: g.neighbors(id, { limit: 120 }).map((n) => ({
      type: n.type,
      dir: n.dir,
      id: n.other?.id || '',
      title: String(n.other?.props?.title || n.other?.id || ''),
      label: (n.other?.labels || []).find((l) => l !== 'Stub') || 'Node',
    })).filter((n) => n.id),
  };
}

/** Full-text search, shaped for the pane's result list. */
export function searchNodes(q, limit = 40) {
  return g.search(q, limit).map((n) => ({
    id: n.id,
    title: String(n.props?.title || n.id).slice(0, 64),
    label: (n.labels || []).find((l) => l !== 'Stub') || 'Node',
  }));
}

export const widgetIds = () => Object.keys(COLLECTORS);
