/**
 * End-to-end checks against the real CLI, run as a subprocess with HOME
 * pointed at a throwaway directory — so these touch nothing of yours and
 * prove the documented commands work on a clean install.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CCMOD = join(ROOT, 'bin', 'ccmod');
let HOME;

/** Run ccmod with a sandboxed HOME and no colour, returning stdout. */
const run = (...argv) =>
  execFileSync(CCMOD, argv, {
    encoding: 'utf8',
    env: { ...process.env, HOME, NO_COLOR: '1', CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID || 'test-session' },
  }).replace(/\x1b\[[0-9;]*m/g, '');

const withSession = (id, ...argv) => {
  const prev = process.env.CLAUDE_SESSION_ID;
  process.env.CLAUDE_SESSION_ID = id;
  try { return run(...argv); } finally { process.env.CLAUDE_SESSION_ID = prev; }
};

before(() => { HOME = mkdtempSync(join(tmpdir(), 'ccmod-test-')); });
after(() => { if (HOME) rmSync(HOME, { recursive: true, force: true }); });

test('help lists the four areas', () => {
  const out = run('help');
  for (const word of ['relay', 'brain', 'dash', 'route']) assert.match(out, new RegExp(word));
});

test('a node round-trips through add, search and read', () => {
  run('brain', 'add', 'note:alpha', '--label', 'Note', '--title', 'Alpha note', '--body', 'graph theory basics');
  assert.match(run('brain', 'search', 'graph theory'), /Alpha note/);

  const detail = JSON.parse(run('node', 'note:alpha'));
  assert.equal(detail.node.id, 'note:alpha');
  assert.equal(detail.node.title, 'Alpha note');
});

test('edges make a path between two nodes', () => {
  run('brain', 'add', 'note:beta', '--label', 'Note', '--title', 'Beta note');
  run('brain', 'link', 'note:alpha', 'LINKS_TO', 'note:beta');

  assert.match(run('brain', 'neighbors', 'note:alpha'), /Beta note/);
  assert.match(run('brain', 'path', 'note:alpha', 'note:beta'), /Alpha note.*Beta note/s);
});

test('cypher handles a single node, a hop and a WHERE', () => {
  assert.match(run('brain', 'query', 'MATCH (a:Note) RETURN a'), /row\(s\)/);
  assert.match(run('brain', 'query', 'MATCH (a:Note)-[:LINKS_TO]->(b) RETURN a,b'), /Beta note/);
  assert.match(run('brain', 'query', 'MATCH (a:Note) WHERE a.title CONTAINS "Alpha" RETURN a'), /Alpha note/);
});

test('a deleted node stops resolving', () => {
  run('brain', 'add', 'note:gamma', '--label', 'Note', '--title', 'Gamma');
  assert.match(run('brain', 'rm', 'note:gamma'), /deleted/);
  assert.equal(JSON.parse(run('node', 'note:gamma')).node, null);
});

test('the router separates mechanical work from work needing judgement', () => {
  assert.match(run('route', 'test', 'fix the typo in README'), /LIGHT/);
  assert.match(run('route', 'test', 'design the auth system and weigh the tradeoffs'), /HEAVY/);
  // A question is not an instruction, however short.
  assert.match(run('route', 'test', 'ok what should I work on'), /HEAVY/);
});

test('the relay carries a message from one session to another, once', () => {
  withSession('sess-planner', 'relay', 'name', 'planner');
  withSession('sess-builder', 'relay', 'name', 'builder');
  withSession('sess-planner', 'relay', 'send', 'builder', 'schema is settled');

  assert.match(withSession('sess-builder', 'relay', 'peers'), /planner/);
  assert.match(withSession('sess-builder', 'relay', 'inbox'), /schema is settled/);
  // Delivery clears it: the same mail must not arrive twice.
  assert.match(withSession('sess-builder', 'relay', 'inbox'), /empty/);
});

test('the pane snapshot the mod reads is valid JSON with counters', () => {
  const snap = JSON.parse(run('pane'));
  assert.ok(snap.stats.nodes >= 2, 'expected the nodes added above');
  assert.ok(Array.isArray(snap.nodes));
});

test('install copies the subagent and skills, and says what it kept', () => {
  assert.match(run('install'), /haiku-worker\.md/);
  assert.ok(existsSync(join(HOME, '.claude', 'agents', 'haiku-worker.md')));
  assert.ok(existsSync(join(HOME, '.claude', 'skills', 'brain')));
  assert.match(run('install'), /already there/);
});

test('doctor reports the checkout it is actually running from', () => {
  assert.match(run('doctor'), new RegExp(join(ROOT, 'bin', 'ccmod').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('an unknown command fails loudly', () => {
  assert.throws(() => run('nonsense-command'), /unknown command|Command failed/);
});
