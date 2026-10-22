/**
 * Status line: the one piece of the dashboard that lives inside the Claude Code
 * interface itself. Reads session context as JSON on stdin.
 */
import * as relay from './relay.mjs';
import * as g from './graph.mjs';
import { routerStats } from './router.mjs';
import { dashConfig } from './dash.mjs';
import { basename } from 'node:path';

const DIM = '\x1b[2m', R = '\x1b[0m', B = '\x1b[1m';
const GR = '\x1b[32m', YL = '\x1b[33m', CY = '\x1b[36m', MG = '\x1b[35m';

const read = () => new Promise((resolve) => {
  let raw = '';
  if (process.stdin.isTTY) return resolve({});
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  setTimeout(() => resolve({}), 1200);
});

const ctx = await read();
const cfg = dashConfig();
const parts = [];

const cwd = ctx.cwd || ctx.workspace?.current_dir || process.cwd();
parts.push(`${B}${basename(cwd)}${R}`);

const model = ctx.model?.display_name || ctx.model?.id;
if (model) parts.push(`${DIM}${model}${R}`);

try {
  const s = g.stats();
  parts.push(`${MG}◆${R} ${s.nodes}${DIM}n${R}/${s.edges}${DIM}e${R}`);
} catch {}

try {
  const sessionId = ctx.session_id || ctx.sessionId;
  const peers = relay.peers({ includeStale: false });
  const others = peers.filter((p) => p.sessionId !== sessionId);
  const active = others.filter((p) => p.state === 'active').length;
  const me = peers.find((p) => p.sessionId === sessionId);
  const unread = me ? me.pending : 0;
  if (active) parts.push(`${GR}◉${R} ${active} peer${active > 1 ? 's' : ''}`);
  if (unread) parts.push(`${YL}✉ ${unread}${R}`);
  if (me?.name) parts.push(`${DIM}as${R} ${CY}${me.name}${R}`);
} catch {}

try {
  const r = routerStats();
  if (r.total) parts.push(`${DIM}route${R} ${Math.round(r.lightShare * 100)}%${DIM}→haiku${R}`);
} catch {}

if (cfg.statusLineExtra) parts.push(`${DIM}${cfg.statusLineExtra}${R}`);

process.stdout.write(parts.join(`${DIM} · ${R}`));
