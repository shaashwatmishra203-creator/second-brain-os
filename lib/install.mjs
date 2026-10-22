/**
 * Copy the pieces that have to live in ~/.claude to be found: the cheap-model
 * subagent and the skills. Hooks are printed rather than written — settings.json
 * is the person's file, and a merge they can see beats one they cannot.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE, ROOT } from './paths.mjs';

const C = { gr: '\x1b[32m', yl: '\x1b[33m', dim: '\x1b[90m', b: '\x1b[1m', r: '\x1b[0m' };

export function install({ force = false } = {}) {
  const done = [];
  const skipped = [];

  const agentSrc = join(ROOT, 'agents', 'haiku-worker.md');
  const agentDst = join(CLAUDE, 'agents', 'haiku-worker.md');
  if (existsSync(agentSrc)) {
    mkdirSync(join(CLAUDE, 'agents'), { recursive: true });
    if (existsSync(agentDst) && !force) skipped.push(`agents/haiku-worker.md ${C.dim}(already there)${C.r}`);
    else { cpSync(agentSrc, agentDst); done.push('agents/haiku-worker.md'); }
  }

  const skillsSrc = join(ROOT, 'skills');
  if (existsSync(skillsSrc)) {
    mkdirSync(join(CLAUDE, 'skills'), { recursive: true });
    for (const name of readdirSync(skillsSrc)) {
      const dst = join(CLAUDE, 'skills', name);
      if (existsSync(dst) && !force) skipped.push(`skills/${name} ${C.dim}(already there)${C.r}`);
      else { cpSync(join(skillsSrc, name), dst, { recursive: true }); done.push(`skills/${name}`); }
    }
  }

  for (const d of done) console.log(`${C.gr}installed${C.r} ${d} ${C.dim}→ ~/.claude/${C.r}`);
  for (const s of skipped) console.log(`${C.yl}kept${C.r}      ${s}`);
  if (!done.length && !skipped.length) console.log(`${C.yl}nothing to install${C.r} — is this a full checkout?`);

  console.log(`\n${C.b}Still to do by hand:${C.r} add the hooks and status line to ~/.claude/settings.json.`);
  console.log(`${C.dim}The exact JSON to merge is in docs/hooks.md. Then run ${C.r}ccmod doctor${C.dim} to check it.${C.r}`);
  console.log(`${C.dim}Re-run with ${C.r}--force${C.dim} to overwrite files you already have.${C.r}`);
}
