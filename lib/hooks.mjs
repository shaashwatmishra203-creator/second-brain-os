/**
 * Hook handlers wired into ~/.claude/settings.json.
 * Each reads the hook payload on stdin and prints a JSON control object.
 * Every path is defensive: a mod must never be able to wedge a session.
 */
import * as relay from './relay.mjs';
import { classify, advisory, logDecision, routeConfig } from './router.mjs';

const readStdin = () => new Promise((resolve) => {
  let raw = '';
  if (process.stdin.isTTY) return resolve({});
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  setTimeout(() => resolve((() => { try { return JSON.parse(raw || '{}'); } catch { return {}; } })()), 2500);
});

const emit = (obj) => { process.stdout.write(JSON.stringify(obj)); };

function peerFor(sessionId) {
  const all = relay.peers({ includeStale: true });
  return all.find((p) => p.sessionId === sessionId) || { sessionId };
}

/** SessionStart: announce this session, then hand it anything waiting. */
async function sessionStart(payload) {
  const sessionId = payload.session_id || payload.sessionId;
  if (!sessionId) return emit({});
  relay.register({ sessionId, cwd: payload.cwd || process.cwd(), pid: process.ppid });
  relay.resetWake(sessionId);

  const msgs = relay.drain(peerFor(sessionId));
  const parts = [];
  if (msgs.length) parts.push(relay.formatForContext(msgs));

  const peers = relay.peers().filter((p) => p.sessionId !== sessionId && p.state === 'active');
  if (peers.length) {
    parts.push([
      `## Relay: ${peers.length} peer session${peers.length > 1 ? 's' : ''} online`,
      '',
      ...peers.map((p) => `- \`${p.name || p.sessionId.slice(0, 8)}\`${p.role ? ` — ${p.role}` : ''}${p.cwd ? ` · ${p.cwd}` : ''}`),
      '',
      'Hand work to one with `ccmod relay send <name> "..."`. Name this session with `ccmod relay name <alias>`.',
    ].join('\n'));
  }

  if (!parts.length) return emit({});
  emit({
    suppressOutput: true,
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') },
  });
}

/** UserPromptSubmit: heartbeat, deliver relay mail, and route the prompt. */
async function userPromptSubmit(payload) {
  const sessionId = payload.session_id || payload.sessionId;
  const prompt = payload.prompt || payload.user_prompt || '';
  const parts = [];

  if (sessionId) {
    relay.register({ sessionId, cwd: payload.cwd || process.cwd(), pid: process.ppid });
    relay.resetWake(sessionId); // a real user turn clears the autonomous-wake budget
    const msgs = relay.drain(peerFor(sessionId));
    if (msgs.length) parts.push(relay.formatForContext(msgs));
  }

  const cfg = routeConfig();
  if (cfg.enabled && prompt) {
    const decision = classify(prompt, cfg);
    logDecision({
      sessionId,
      tier: decision.tier,
      reason: decision.reason,
      agent: decision.agent,
      prompt: String(prompt).replace(/\s+/g, ' ').slice(0, 160),
    });
    if (cfg.announce) {
      const note = advisory(decision, cfg);
      if (note) parts.push(note);
    }
  }

  if (!parts.length) return emit({});
  emit({
    suppressOutput: true,
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: parts.join('\n\n') },
  });
}

/**
 * Stop: if a peer sent work while this session was busy, wake it back up so the
 * handoff lands without the user having to prod it. Bounded, so no ping-pong.
 */
async function stop(payload) {
  const sessionId = payload.session_id || payload.sessionId;
  if (!sessionId) process.exit(0);
  relay.register({ sessionId, cwd: payload.cwd || process.cwd(), pid: process.ppid });

  const cfg = relay.relayConfig();
  const waiting = relay.pending(peerFor(sessionId));
  if (!waiting.length) { relay.resetWake(sessionId); process.exit(0); }
  if (!cfg.autoWake) process.exit(0);

  const used = relay.wakeCount(sessionId);
  if (used >= (cfg.maxConsecutiveWakes ?? 5)) {
    process.stdout.write(`relay: ${waiting.length} message(s) waiting, but the auto-wake budget for this session is spent. Run \`ccmod relay inbox\` to read them.`);
    process.exit(0);
  }
  relay.bumpWake(sessionId);

  // Exit 2 under asyncRewake tells Claude Code to resume the turn with this text.
  const msgs = relay.drain(peerFor(sessionId));
  process.stdout.write(relay.formatForContext(msgs));
  process.exit(2);
}

export async function runHook(name) {
  const payload = await readStdin();
  try {
    switch (name) {
      case 'session-start': return await sessionStart(payload);
      case 'user-prompt-submit': return await userPromptSubmit(payload);
      case 'stop': return await stop(payload);
      default: return emit({});
    }
  } catch {
    // Never let a mod break the session.
    return emit({});
  }
}
