/** Self-check: is every piece actually wired up? */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE, MODS, GRAPH_DB, ROUTER_LOG, CONFIG } from './paths.mjs';
import * as g from './graph.mjs';
import * as relay from './relay.mjs';
import { routeConfig } from './router.mjs';
import { dashConfig } from './dash.mjs';

const ok = (b) => (b ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m');

export function doctor() {
  const settingsPath = join(CLAUDE, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch {}
  const hooks = settings.hooks || {};
  const hookWired = (event) =>
    (hooks[event] || []).some((m) => (m.hooks || []).some((h) => String(h.command || '').includes('ccmod')));

  const lines = [];
  lines.push(`\x1b[1mccmod doctor\x1b[0m`);
  lines.push(`${ok(existsSync(join(MODS, 'bin', 'ccmod')))} cli installed            ${join(MODS, 'bin', 'ccmod')}`);
  lines.push(`${ok(existsSync(GRAPH_DB))} graph database           ${GRAPH_DB}`);
  const stats = existsSync(GRAPH_DB) ? g.stats() : { nodes: 0, edges: 0 };
  lines.push(`${ok(stats.nodes > 0)} graph populated          ${stats.nodes} nodes / ${stats.edges} edges`);
  lines.push(`${ok(hookWired('SessionStart'))} hook SessionStart        relay registration + inbox`);
  lines.push(`${ok(hookWired('UserPromptSubmit'))} hook UserPromptSubmit    relay delivery + model routing`);
  lines.push(`${ok(hookWired('Stop'))} hook Stop                autonomous handoff wake-up`);
  lines.push(`${ok(Boolean(settings.statusLine))} status line              in-terminal dashboard strip`);
  lines.push(`${ok(existsSync(join(CLAUDE, 'agents', 'haiku-worker.md')))} cheap-model subagent     ~/.claude/agents/haiku-worker.md`);
  lines.push(`${ok(routeConfig().enabled)} routing enabled          light agent: ${routeConfig().lightAgent}`);
  lines.push(`${ok(existsSync(ROUTER_LOG))} routing log              ${ROUTER_LOG}`);
  const peers = relay.peers({ includeStale: true });
  lines.push(`${ok(true)} peers registered         ${peers.length} (${peers.filter((p) => p.state === 'active').length} active)`);
  const cfg = dashConfig();
  lines.push(`${ok(true)} dashboard panels         ${cfg.widgets.filter((w) => w.enabled).length}/${cfg.widgets.length} enabled`);
  for (const f of ['brain.json', 'route.json', 'relay.json', 'dash.json']) {
    lines.push(`${ok(existsSync(join(CONFIG, f)))} config ${f.padEnd(18)} ${join(CONFIG, f)}`);
  }
  console.log(lines.join('\n'));
}
