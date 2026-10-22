/** ccmod — one entry point for the relay, the brain, the dashboard, the router. */
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODS, CONFIG, GRAPH_DB, readJSON, writeJSON } from './paths.mjs';
import * as g from './graph.mjs';
import * as relay from './relay.mjs';
import { ingestAll, brainConfig } from './ingest.mjs';
import { snapshot, dashConfig, saveDashConfig, widgetIds, DEFAULT_DASH, paneSnapshot, nodeDetail, searchNodes } from './dash.mjs';
import { classify, routeConfig, routerStats, recentDecisions } from './router.mjs';

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', b: '\x1b[1m', r: '\x1b[0m', cy: '\x1b[36m', gr: '\x1b[32m', yl: '\x1b[33m', mg: '\x1b[35m', rd: '\x1b[31m' }
  : { dim: '', b: '', r: '', cy: '', gr: '', yl: '', mg: '', rd: '' };

const out = (...a) => console.log(...a);
const pad = (s, n) => String(s ?? '').length > n ? String(s).slice(0, n - 1) + '…' : String(s ?? '').padEnd(n);
const ago = (iso) => {
  if (!iso) return '–';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

function flags(argv) {
  const f = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      f[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    } else rest.push(a);
  }
  return { f, rest };
}

const env = () => ({
  sessionId: process.env.CLAUDE_SESSION_ID || process.env.CC_SESSION_ID || null,
  cwd: process.cwd(),
});

// ----------------------------------------------------------------- relay verbs

function cmdRelay(argv) {
  const { f, rest } = flags(argv);
  const sub = rest[0] || 'peers';
  const me = f.session || env().sessionId;

  if (sub === 'register') {
    const peer = relay.register({ sessionId: me || `anon-${process.pid}`, name: f.name, cwd: f.cwd || process.cwd(), title: f.title, pid: process.pid });
    out(`${C.gr}registered${C.r} ${peer.name || peer.sessionId.slice(0, 8)}${peer.role ? ` (${peer.role})` : ''}`);
    return;
  }
  if (sub === 'name') {
    if (!me) return out(`${C.rd}no session id — pass --session${C.r}`);
    const peer = relay.register({ sessionId: me, name: rest[1], cwd: process.cwd() });
    return out(`this session is now ${C.b}${peer.name}${C.r}`);
  }
  if (sub === 'role') {
    if (!me) return out(`${C.rd}no session id — pass --session${C.r}`);
    relay.register({ sessionId: me, cwd: process.cwd() });
    const peer = relay.setRole(me, rest.slice(1).join(' '));
    return out(`role set: ${C.b}${peer?.role}${C.r}`);
  }
  if (sub === 'send') {
    const to = rest[1];
    const body = rest.slice(2).join(' ') || (f.body === true ? '' : f.body) || '';
    if (!to || !body) return out(`usage: ccmod relay send <peer|role|all> "<message>" [--kind handoff] [--payload '{}']`);
    const payload = f.payload && f.payload !== true ? (() => { try { return JSON.parse(f.payload); } catch { return { note: f.payload }; } })() : null;
    const self = me ? relay.peers({ includeStale: true }).find((p) => p.sessionId === me) : null;
    const res = relay.send({ to, body, from: me || `cli-${process.pid}`, fromName: self?.name || f.from || null, kind: f.kind === true ? 'message' : (f.kind || 'message'), payload });
    if (res.parked) return out(`${C.yl}parked${C.r} for "${to}" — delivered when a session claims that name (${res.parked})`);
    if (!res.delivered.length) return out(`${C.yl}nobody to deliver to${C.r} (target "${to}" resolved to just you)`);
    for (const d of res.delivered) out(`${C.gr}→${C.r} ${d.name || d.sessionId.slice(0, 8)} ${C.dim}[${d.state}]${C.r}`);
    return;
  }
  if (sub === 'inbox') {
    if (!me) return out(`${C.rd}no session id — pass --session${C.r}`);
    const peer = relay.peers({ includeStale: true }).find((p) => p.sessionId === me) || { sessionId: me };
    const msgs = f.peek ? relay.pending(peer) : relay.drain(peer);
    if (!msgs.length) return out(`${C.dim}inbox empty${C.r}`);
    out(relay.formatForContext(msgs));
    return;
  }
  if (sub === 'history') {
    const h = relay.history(Number(f.limit) || 20);
    if (!h.length) return out(`${C.dim}no messages yet${C.r}`);
    for (const m of h) out(`${C.dim}${ago(m.sentAt).padStart(4)}${C.r}  ${C.cy}${pad(m.fromName || m.from?.slice(0, 8), 14)}${C.r} → ${pad((m.to || '').slice(0, 8), 10)} ${C.dim}${m.kind}${C.r}  ${pad(m.body.replace(/\s+/g, ' '), 60)}`);
    return;
  }
  // default: peers
  const list = relay.peers({ includeStale: true });
  if (!list.length) return out(`${C.dim}no sessions registered yet${C.r}`);
  out(`${C.b}${pad('NAME', 16)}${pad('ROLE', 14)}${pad('STATE', 8)}${pad('SEEN', 6)}${pad('UNREAD', 7)}CWD${C.r}`);
  for (const p of list) {
    const col = p.state === 'active' ? C.gr : C.dim;
    out(`${col}${pad(p.name || p.sessionId.slice(0, 8), 16)}${C.r}${pad(p.role || '–', 14)}${col}${pad(p.state, 8)}${C.r}${pad(ago(p.lastSeen), 6)}${pad(p.pending || 0, 7)}${C.dim}${p.cwd || ''}${C.r}`);
  }
}

// ----------------------------------------------------------------- brain verbs

function cmdBrain(argv) {
  const { f, rest } = flags(argv);
  const sub = rest[0] || 'stats';

  if (sub === 'ingest' || sub === 'scan') {
    const t0 = Date.now();
    const r = ingestAll({ quiet: true });
    const s = g.stats();
    out(`${C.gr}scanned${C.r} in ${Date.now() - t0}ms — memories ${r.memories}, docs ${r.docs}, sessions ${r.sessions}, notes ${r.notes}`);
    out(`graph now ${C.b}${s.nodes}${C.r} nodes / ${C.b}${s.edges}${C.r} edges`);
    return;
  }
  if (sub === 'add') {
    const id = f.id || rest[1];
    if (!id) return out(`usage: ccmod brain add <id> --label Note --title "..." --body "..."`);
    const props = {};
    for (const [k, v] of Object.entries(f)) if (!['id', 'label', 'labels'].includes(k)) props[k] = v === true ? '' : v;
    const labels = String(f.labels || f.label || 'Note').split(',').map((s) => s.trim()).filter(Boolean);
    const n = g.upsertNode({ id, labels, props });
    return out(`${C.gr}upserted${C.r} ${n.id} ${C.dim}[${n.labels.join(', ')}]${C.r}`);
  }
  if (sub === 'link') {
    const [, src, type, dst] = rest;
    if (!src || !type || !dst) return out(`usage: ccmod brain link <src> <TYPE> <dst>`);
    g.addEdge({ src, dst, type: type.toUpperCase() });
    return out(`${C.gr}linked${C.r} ${src} ${C.cy}-[:${type.toUpperCase()}]->${C.r} ${dst}`);
  }
  if (sub === 'rm') {
    const id = rest[1];
    return out(g.deleteNode(id) ? `${C.gr}deleted${C.r} ${id}` : `${C.yl}no such node${C.r} ${id}`);
  }
  if (sub === 'search') {
    const q = rest.slice(1).join(' ');
    const hits = g.search(q, Number(f.limit) || 15);
    if (!hits.length) return out(`${C.dim}no matches${C.r}`);
    for (const n of hits) out(`${C.cy}${pad(n.labels.join(','), 14)}${C.r}${pad(n.props.title || n.id, 42)}${C.dim}${n.id}${C.r}`);
    return;
  }
  if (sub === 'find') {
    const where = {};
    for (const [k, v] of Object.entries(f)) if (!['label', 'limit'].includes(k)) where[k] = v;
    const hits = g.find({ label: f.label === true ? undefined : f.label, where, limit: Number(f.limit) || 25 });
    if (!hits.length) return out(`${C.dim}no matches${C.r}`);
    for (const n of hits) out(`${C.cy}${pad(n.labels.join(','), 14)}${C.r}${pad(n.props.title || n.id, 42)}${C.dim}${n.id}${C.r}`);
    return;
  }
  if (sub === 'query' || sub === 'cypher') {
    const q = rest.slice(1).join(' ') || (typeof f.q === 'string' ? f.q : '');
    try {
      const rows = g.cypher(q);
      if (!rows.length) return out(`${C.dim}0 rows${C.r}`);
      for (const row of rows) {
        const parts = Object.entries(row).map(([k, v]) =>
          v && v.id ? `${C.dim}${k}=${C.r}${v.props?.title || v.id}` : `${C.dim}${k}=${C.r}${C.cy}${v}${C.r}`);
        out(parts.join('  '));
      }
      out(`${C.dim}${rows.length} row(s)${C.r}`);
    } catch (err) { out(`${C.rd}${err.message}${C.r}`); }
    return;
  }
  if (sub === 'neighbors' || sub === 'n') {
    const id = rest[1];
    const ns = g.neighbors(id, { dir: f.dir || 'both' });
    const node = g.getNode(id);
    if (!node) return out(`${C.yl}no such node${C.r} ${id}`);
    out(`${C.b}${node.props.title || node.id}${C.r} ${C.dim}[${node.labels.join(', ')}]${C.r}`);
    if (!ns.length) return out(`${C.dim}  (no connections)${C.r}`);
    for (const n of ns) out(`  ${n.dir === 'out' ? '→' : '←'} ${C.cy}${pad(n.type, 14)}${C.r}${pad(n.other?.props?.title || n.other?.id, 44)}${C.dim}${n.other?.id}${C.r}`);
    return;
  }
  if (sub === 'path') {
    const p = g.path(rest[1], rest[2], Number(f.depth) || 6);
    if (!p) return out(`${C.yl}no path found${C.r}`);
    return out(p.map((id) => g.getNode(id)?.props?.title || id).join(`${C.cy} → ${C.r}`));
  }
  if (sub === 'export') {
    const data = g.dump({ limit: Number(f.limit) || 100000 });
    const file = f.out && f.out !== true ? f.out : null;
    if (file) { writeFileSync(file, JSON.stringify(data, null, 2)); return out(`${C.gr}wrote${C.r} ${file} (${data.nodes.length} nodes)`); }
    return out(JSON.stringify(data, null, 2));
  }
  if (sub === 'sources') {
    const cfg = brainConfig();
    out(JSON.stringify(cfg, null, 2));
    out(`${C.dim}edit ${join(CONFIG, 'brain.json')} — add markdown vaults to "vaults"${C.r}`);
    return;
  }
  if (sub === 'vault') {
    const p = rest[1];
    if (!p) return out('usage: ccmod brain vault <path-to-markdown-folder>');
    const file = join(CONFIG, 'brain.json');
    const cfg = brainConfig();
    cfg.vaults = [...new Set([...(cfg.vaults || []), p])];
    writeJSON(file, cfg);
    return out(`${C.gr}added vault${C.r} ${p} — run ${C.b}ccmod brain ingest${C.r}`);
  }

  // default: stats
  const s = g.stats();
  out(`${C.b}graph${C.r}  ${s.nodes} nodes  ${s.edges} edges  ${C.dim}${s.orphans} unlinked${C.r}  ${C.dim}${GRAPH_DB}${C.r}`);
  if (s.byLabel.length) {
    out(`\n${C.b}labels${C.r}`);
    for (const l of s.byLabel) out(`  ${pad(l.label, 18)}${C.cy}${l.c}${C.r}`);
  }
  if (s.byType.length) {
    out(`\n${C.b}relationships${C.r}`);
    for (const t of s.byType) out(`  ${pad(t.type, 18)}${C.cy}${t.c}${C.r}`);
  }
  if (s.hubs.length) {
    out(`\n${C.b}most connected${C.r}`);
    for (const h of s.hubs) out(`  ${String(h.degree).padStart(3)}  ${pad(h.node?.props?.title || h.id, 46)}${C.dim}${h.id}${C.r}`);
  }
}

// ------------------------------------------------------------------ dash verbs

async function cmdDash(argv) {
  const { f, rest } = flags(argv);

  if (f.serve || rest[0] === 'serve') {
    const { serve } = await import('./server.mjs');
    const { url } = await serve({ port: Number(f.port) || 7717 });
    out(`${C.gr}dashboard${C.r} ${C.b}${url}${C.r}  ${C.dim}(ctrl-c to stop)${C.r}`);
    if (f.open) { const { spawn } = await import('node:child_process'); spawn('open', [url], { stdio: 'ignore', detached: true }).unref(); }
    return new Promise(() => {});
  }
  if (f.config || rest[0] === 'config') {
    if (f.reset) { saveDashConfig(structuredClone(DEFAULT_DASH)); return out(`${C.gr}reset${C.r} to defaults`); }
    if (f.enable || f.disable) {
      const cfg = dashConfig();
      const target = String(f.enable === true ? f.disable : f.enable);
      const w = cfg.widgets.find((x) => x.id === target);
      if (!w) return out(`${C.rd}unknown panel${C.r} — try: ${widgetIds().join(', ')}`);
      w.enabled = Boolean(f.enable) && f.enable !== true ? true : !f.disable;
      if (f.disable) w.enabled = false;
      saveDashConfig(cfg);
      return out(`${C.gr}${w.id}${C.r} ${w.enabled ? 'enabled' : 'disabled'}`);
    }
    out(JSON.stringify(dashConfig(), null, 2));
    out(`${C.dim}panels available: ${widgetIds().join(', ')}${C.r}`);
    return;
  }
  if (f.html) {
    const file = f.html === true ? join(MODS, 'dashboard.html') : f.html;
    const html = readFileSync(join(MODS, 'web', 'index.html'), 'utf8');
    const app = readFileSync(join(MODS, 'web', 'app.js'), 'utf8');
    const snap = snapshot();
    const graph = g.dump({ limit: 1500 });
    const inlined = html
      .replace('<script src="app.js"></script>', [
        '<script>',
        `const __SNAPSHOT__ = ${JSON.stringify(snap)};`,
        `const __GRAPH__ = ${JSON.stringify(graph)};`,
        'window.fetch = async (path, opts) => {',
        '  const body = opts?.body ? JSON.parse(opts.body) : null;',
        '  const reply = (o) => ({ ok: true, status: 200, json: async () => o });',
        '  if (path === "/api/state") return reply(__SNAPSHOT__);',
        '  if (path === "/api/graph") return reply(__GRAPH__);',
        '  if (path.startsWith("/api/node")) {',
        '    const id = decodeURIComponent(new URL(path, "http://x").searchParams.get("id"));',
        '    const node = __GRAPH__.nodes.find(n => n.id === id) || null;',
        '    const neighbors = __GRAPH__.edges.filter(e => e.src === id || e.dst === id).map(e => ({',
        '      type: e.type, dir: e.src === id ? "out" : "in",',
        '      other: __GRAPH__.nodes.find(n => n.id === (e.src === id ? e.dst : e.src)) || null }));',
        '    return reply({ node, neighbors });',
        '  }',
        '  if (path === "/api/config") return reply({ ...__SNAPSHOT__.config, ...(body || {}) });',
        '  return reply({ rows: [], error: "static snapshot — run `ccmod dash --serve` for live queries" });',
        '};',
        '</script>',
        `<script>${app}</script>`,
      ].join('\n'));
    writeFileSync(file, inlined);
    return out(`${C.gr}wrote${C.r} ${file} ${C.dim}(self-contained snapshot)${C.r}`);
  }

  // default: render the dashboard in the terminal
  const snap = snapshot();
  const cfg = snap.config;
  const W = Math.min(process.stdout.columns || 92, 110);
  const rule = (label) => out(`\n${C.mg}${'─'.repeat(2)}${C.r} ${C.b}${label}${C.r} ${C.mg}${'─'.repeat(Math.max(0, W - label.length - 5))}${C.r}`);

  out(`\n${C.b}${cfg.title}${C.r} ${C.dim}· ${new Date(snap.at).toLocaleString()}${C.r}`);
  const gd = snap.data.graph, rd = snap.data.relay;
  if (gd) out(`${C.dim}brain${C.r} ${C.b}${gd.nodes}${C.r} nodes ${C.b}${gd.edges}${C.r} edges   ${C.dim}relay${C.r} ${C.b}${rd?.active ?? 0}${C.r} active ${C.b}${rd?.pending ?? 0}${C.r} unread`);

  for (const w of cfg.widgets) {
    if (!w.enabled) continue;
    const d = snap.data[w.id];
    if (d == null) continue;
    if (w.id === 'graph') continue;
    rule(w.title);
    if (d.error) { out(`  ${C.rd}${d.error}${C.r}`); continue; }
    if (w.id === 'sessions') {
      if (!d.length) { out(`  ${C.dim}none${C.r}`); continue; }
      for (const s of d) {
        const dot = s.relayState === 'active' ? `${C.gr}●${C.r}` : s.relayState ? `${C.dim}●${C.r}` : ' ';
        out(`  ${dot} ${pad(s.title, 46)}${C.dim}${pad(s.project, 18)}${pad(s.turns + 't', 5)}${pad(ago(s.updated), 5)}${C.r}${s.pending ? ` ${C.yl}${s.pending} unread${C.r}` : ''}`);
      }
    } else if (w.id === 'relay') {
      if (!d.peers.length) { out(`  ${C.dim}no sessions registered${C.r}`); continue; }
      for (const p of d.peers) {
        const col = p.state === 'active' ? C.gr : C.dim;
        out(`  ${col}●${C.r} ${pad(p.name || p.sessionId.slice(0, 8), 18)}${pad(p.role || '–', 16)}${C.dim}${pad(ago(p.lastSeen), 5)}${C.r}${p.pending ? ` ${C.yl}${p.pending} unread${C.r}` : ''}`);
      }
    } else if (w.id === 'router') {
      const share = Math.round((d.lightShare || 0) * 100);
      const filled = Math.round(share / 4);
      out(`  ${C.gr}${'█'.repeat(filled)}${C.dim}${'░'.repeat(25 - filled)}${C.r} ${C.b}${share}%${C.r} to the cheap model ${C.dim}(${d.light} light / ${d.heavy} heavy of ${d.total})${C.r}`);
      for (const r of (d.recent || []).slice(0, 5)) {
        const col = r.tier === 'light' ? C.gr : C.yl;
        out(`  ${col}${pad(r.tier, 6)}${C.r}${pad(r.prompt, 52)}${C.dim}${pad(ago(r.at), 4)}${C.r}`);
      }
    } else if (w.id === 'labels') {
      const max = Math.max(1, ...d.map((l) => l.c));
      for (const l of d) out(`  ${pad(l.label, 18)}${C.cy}${'▇'.repeat(Math.max(1, Math.round((l.c / max) * 28)))}${C.r} ${l.c}`);
    } else if (w.id === 'hubs') {
      for (const h of d) out(`  ${String(h.degree).padStart(3)}  ${pad(h.title, 44)}${C.dim}${h.labels.join(',')}${C.r}`);
    } else if (w.id === 'tools') {
      const max = Math.max(1, ...d.map((t) => t.count));
      for (const t of d) out(`  ${pad(t.name, 18)}${C.cy}${'▇'.repeat(Math.max(1, Math.round((t.count / max) * 28)))}${C.r} ${t.count}`);
    }
  }
  out(`\n${C.dim}ccmod dash --serve    open the interactive graph · ccmod dash --config    rearrange panels${C.r}`);
}

// ----------------------------------------------------------------- route verbs

function cmdRoute(argv) {
  const { f, rest } = flags(argv);
  const sub = rest[0] || 'stats';
  if (sub === 'test') {
    const prompt = rest.slice(1).join(' ');
    const d = classify(prompt);
    const col = d.tier === 'light' ? C.gr : C.yl;
    out(`${col}${d.tier.toUpperCase()}${C.r}  ${d.reason}`);
    if (d.agent) out(`${C.dim}would delegate to subagent:${C.r} ${C.b}${d.agent}${C.r}`);
    return;
  }
  if (sub === 'config') {
    out(JSON.stringify(routeConfig(), null, 2));
    out(`${C.dim}edit ${join(CONFIG, 'route.json')}${C.r}`);
    return;
  }
  if (sub === 'log') {
    for (const d of recentDecisions(Number(f.limit) || 25)) {
      const col = d.tier === 'light' ? C.gr : C.yl;
      out(`${C.dim}${pad(ago(d.at), 5)}${C.r}${col}${pad(d.tier, 6)}${C.r}${pad(d.prompt, 54)}${C.dim}${d.reason}${C.r}`);
    }
    return;
  }
  const s = routerStats();
  const share = Math.round(s.lightShare * 100);
  out(`${C.b}routing${C.r} ${s.total} prompts  ${C.gr}${s.light} light${C.r} / ${C.yl}${s.heavy} heavy${C.r}  ${C.b}${share}%${C.r} eligible for the cheap model`);
  const cfg = routeConfig();
  out(`${C.dim}enabled: ${cfg.enabled} · light agent: ${cfg.lightAgent}${C.r}`);
}

// ------------------------------------------------------------------ entrypoint

const HELP = `
${C.b}ccmod${C.r} — Claude Code mods: session relay · knowledge graph · dashboard · model routing

${C.b}relay${C.r}   talk between sessions
  ccmod relay peers                        who is running right now
  ccmod relay name <alias>                 claim a name for this session
  ccmod relay role <text>                  describe what this session is doing
  ccmod relay send <peer|role|all> "..."   hand work to another session
  ccmod relay send planner "..." --kind handoff --payload '{"files":[...]}'
  ccmod relay inbox [--peek]               read (and clear) your messages
  ccmod relay history                      recent traffic

${C.b}brain${C.r}   the knowledge graph
  ccmod brain ingest                       (re)build from memories, docs, sessions, vaults
  ccmod brain stats                        labels, relationships, hubs
  ccmod brain search <text>                full-text search
  ccmod brain find --label Memory          filter by label/props
  ccmod brain query 'MATCH (a:Memory)-[:LINKS_TO]->(b) RETURN a,b'
  ccmod brain neighbors <id>               one hop out
  ccmod brain path <idA> <idB>             how two things connect
  ccmod brain add <id> --label Note --title "..." --body "..."
  ccmod brain link <src> LINKS_TO <dst>
  ccmod brain rm <id>                      delete a node and its edges
  ccmod brain vault ~/Notes                index a markdown folder
  ccmod brain export --out graph.json

${C.b}dash${C.r}    the interface
  ccmod dash                               render it in the terminal
  ccmod dash --serve [--port 7717] [--open]  interactive graph in a browser
  ccmod dash --html [file]                 self-contained snapshot
  ccmod dash --config                      show layout · --config --reset to restore

${C.b}route${C.r}   send cheap work to a cheap model
  ccmod route test "fix the typo in README"
  ccmod route stats | log | config

${C.b}setup${C.r}
  ccmod install                            copy the subagent and skills into ~/.claude
  ccmod doctor                             check what is wired and what is not

${C.b}hook${C.r}    wiring used by settings.json (you don't call these by hand)
  ccmod hook session-start | user-prompt-submit | stop
`;

export async function main(argv) {
  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case 'relay': return cmdRelay(rest);
    case 'brain': return cmdBrain(rest);
    case 'dash': case 'dashboard': return cmdDash(rest);
    case 'pane': {
      const { f } = flags(rest);
      return out(JSON.stringify(paneSnapshot({ limit: Number(f.limit) || 60 })));
    }
    case 'node': {
      const { rest: r } = flags(rest);
      return out(JSON.stringify(nodeDetail(r[0])));
    }
    case 'lookup': {
      const { f, rest: r } = flags(rest);
      return out(JSON.stringify(searchNodes(r.join(' '), Number(f.limit) || 40)));
    }
    case 'route': case 'router': return cmdRoute(rest);
    case 'hook': {
      const { runHook } = await import('./hooks.mjs');
      return runHook(rest[0], rest.slice(1));
    }
    case 'install': {
      const { f } = flags(rest);
      const { install } = await import('./install.mjs');
      return install({ force: Boolean(f.force) });
    }
    case 'doctor': {
      const { doctor } = await import('./doctor.mjs');
      return doctor();
    }
    case 'help': case '--help': case '-h': case undefined: return out(HELP);
    default: out(`${C.rd}unknown command${C.r} "${cmd}"`); out(HELP); process.exitCode = 1;
  }
}
