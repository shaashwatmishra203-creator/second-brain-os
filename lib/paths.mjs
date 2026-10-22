import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

export const HOME = homedir();
export const CLAUDE = join(HOME, '.claude');
export const MODS = join(CLAUDE, 'mods');
export const DATA = join(MODS, 'data');
export const CONFIG = join(MODS, 'config');
export const RELAY_DIR = join(DATA, 'relay');
export const GRAPH_DB = join(DATA, 'graph.db');
export const ROUTER_LOG = join(DATA, 'router.jsonl');
export const PROJECTS = join(CLAUDE, 'projects');

export function ensureDirs() {
  for (const d of [MODS, DATA, CONFIG, RELAY_DIR, join(RELAY_DIR, 'inbox'), join(RELAY_DIR, 'peers')]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

export function readJSON(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}

export function writeJSON(p, obj) {
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

/** Decode ~/.claude/projects dir name back to a best-effort cwd. */
export function decodeProjectDir(name) {
  return name.replace(/^-/, '/').replace(/-/g, '/');
}
