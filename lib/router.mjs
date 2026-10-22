/**
 * Model router: classifies each prompt as light or heavy work, and nudges
 * light work onto a cheap-model subagent so it stops burning the big model.
 * Classification is pure heuristics — no extra API call, no added latency.
 */
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG, ROUTER_LOG, readJSON, ensureDirs } from './paths.mjs';

const ROUTE_CONFIG = join(CONFIG, 'route.json');

const DEFAULTS = {
  enabled: true,
  lightAgent: 'haiku-worker',
  heavyAgent: null,
  minChars: 0,
  maxLightChars: 320,
  announce: true,
  light: [
    '\\b(typo|spelling|rename|reformat|format|prettier|lint|indent)\\b',
    '\\b(add|write|update|fix)\\b.{0,24}\\b(comment|comments|docstring|jsdoc|readme|changelog)\\b',
    '\\b(bump|pin|upgrade)\\b.{0,20}\\b(version|dep|dependency|deps)\\b',
    '\\b(list|show|print|cat|display|count)\\b.{0,40}\\b(files|dirs|folders|functions|exports|routes|tests|todos)\\b',
    '\\b(run|re-?run)\\b.{0,24}\\b(tests?|lint|build|typecheck)\\b',
    '\\b(git )?(status|diff|log|branch)\\b',
    '\\b(convert|translate)\\b.{0,30}\\b(json|yaml|csv|toml|markdown|md)\\b',
    '\\b(add|remove)\\b.{0,20}\\b(import|export|log|logging|console\\.log)\\b',
    '\\b(stub|scaffold|boilerplate|skeleton)\\b',
  ],
  heavy: [
    '\\b(architect|architecture|design|redesign|strategy|trade-?offs?)\\b',
    '\\b(debug|root ?cause|why is|why does|why did|investigate|diagnose)\\b',
    '\\b(refactor|migrate|migration|rewrite|port)\\b',
    '\\b(race condition|deadlock|memory leak|performance|optimi[sz]e|bottleneck)\\b',
    '\\b(security|auth|authentication|authorization|crypto|vulnerab)\\b',
    '\\b(plan|roadmap|spec|rfc|proposal)\\b',
    '\\b(review|audit|critique)\\b',
    '\\b(schema|data ?model|state machine|concurrency|distributed)\\b',
    '\\b(think|reason|consider|evaluate|compare)\\b.{0,40}\\b(options|approaches|tradeoffs|alternatives)\\b',
  ],
};

export function routeConfig() {
  const user = readJSON(ROUTE_CONFIG, {});
  return { ...DEFAULTS, ...user };
}

const anyMatch = (patterns, text) =>
  patterns.map((p) => { try { return new RegExp(p, 'i'); } catch { return null; } })
    .filter(Boolean)
    .find((re) => re.test(text));

/**
 * @returns {{tier:'light'|'heavy', reason:string, agent:string|null, score:number}}
 */
export function classify(prompt, cfg = routeConfig()) {
  const text = String(prompt || '').trim();
  if (!text) return { tier: 'heavy', reason: 'empty prompt', agent: null, score: 0 };

  // Explicit user override always wins.
  if (/\b(use|with)\s+(opus|sonnet)\b|\bthink (hard|deeply)\b|\bultrathink\b/i.test(text))
    return { tier: 'heavy', reason: 'user asked for the big model', agent: cfg.heavyAgent, score: 1 };
  if (/\b(use|with)\s+haiku\b|\bquick(ly)?\b.{0,12}\bcheap\b/i.test(text))
    return { tier: 'light', reason: 'user asked for the cheap model', agent: cfg.lightAgent, score: 1 };

  const heavyHit = anyMatch(cfg.heavy, text);
  if (heavyHit) return { tier: 'heavy', reason: `matched heavy signal ${heavyHit}`, agent: cfg.heavyAgent, score: 0.8 };

  const multiFile = (text.match(/[\w./-]+\.(ts|tsx|js|jsx|py|go|rs|java|rb|c|cpp|h|mjs|cjs|json|md)\b/g) || []).length;
  if (multiFile >= 3) return { tier: 'heavy', reason: `spans ${multiFile} files`, agent: cfg.heavyAgent, score: 0.6 };
  if (text.length > cfg.maxLightChars)
    return { tier: 'heavy', reason: `long prompt (${text.length} chars)`, agent: cfg.heavyAgent, score: 0.5 };

  const lightHit = anyMatch(cfg.light, text);
  if (lightHit) return { tier: 'light', reason: `matched light signal ${lightHit}`, agent: cfg.lightAgent, score: 0.8 };

  // A short prompt is only delegatable if it's actually an instruction. Questions
  // and open-ended asks ("what should I work on") need the capable model.
  const words = text.split(/\s+/).length;
  const imperative = /^\s*(?:please\s+)?(fix|add|remove|delete|rename|move|copy|update|change|replace|run|show|list|print|cat|format|reformat|bump|pin|stub|scaffold|generate|write|create|install|uninstall|commit|revert|undo|clean|sort|count)\b/i.test(text);
  const interrogative = /\?|^\s*(what|why|how|should|could|would|can|is|are|does|do|did|which|who|when|where)\b/i.test(text);
  if (words <= 10 && imperative && !interrogative)
    return { tier: 'light', reason: `terse instruction (${words} words)`, agent: cfg.lightAgent, score: 0.4 };

  return { tier: 'heavy', reason: 'no light signal; defaulting to the capable model', agent: cfg.heavyAgent, score: 0.3 };
}

export function logDecision(entry) {
  ensureDirs();
  try { appendFileSync(ROUTER_LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); } catch {}
}

export function recentDecisions(limit = 200) {
  if (!existsSync(ROUTER_LOG)) return [];
  try {
    return readFileSync(ROUTER_LOG, 'utf8').split('\n').filter(Boolean).slice(-limit)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch { return []; }
}

export function routerStats() {
  const all = recentDecisions(2000);
  const light = all.filter((d) => d.tier === 'light').length;
  const heavy = all.filter((d) => d.tier === 'heavy').length;
  return {
    total: all.length,
    light,
    heavy,
    lightShare: all.length ? light / all.length : 0,
    recent: all.slice(0, 12),
  };
}

/** The nudge injected into context when a prompt looks like cheap-model work. */
export function advisory(decision, cfg = routeConfig()) {
  if (decision.tier !== 'light' || !decision.agent) return '';
  return [
    `## Router: this looks like light work`,
    ``,
    `Signal: ${decision.reason}.`,
    ``,
    `Delegate it instead of doing it on the expensive model: call the \`Agent\` tool with`,
    `\`subagent_type: "${decision.agent}"\` and \`run_in_background: false\`, hand it the full task,`,
    `then report its result. Keep the work here only if it turns out to need judgment the`,
    `cheap model cannot supply (ambiguous requirements, cross-file design, anything risky) —`,
    `say so in one line if you override.`,
  ].join('\n');
}
