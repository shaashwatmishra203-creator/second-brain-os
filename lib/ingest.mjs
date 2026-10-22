/**
 * Builds the knowledge graph from what you already have on disk:
 * Claude memories, CLAUDE.md files, session transcripts, and any
 * markdown vaults you list in config/brain.json.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, basename, extname, relative } from 'node:path';
import { CLAUDE, PROJECTS, CONFIG, HOME, readJSON, decodeProjectDir } from './paths.mjs';
import * as g from './graph.mjs';

const BRAIN_CONFIG = join(CONFIG, 'brain.json');

export function brainConfig() {
  return readJSON(BRAIN_CONFIG, {
    vaults: [],
    includeTranscripts: true,
    includeMemories: true,
    includeClaudeMd: true,
    maxTranscriptsPerProject: 25,
  });
}

function walk(dir, { exts = ['.md'], depth = 6, skip = /node_modules|\.git|\.venv|__pycache__|dist|build/ } = {}) {
  const out = [];
  const rec = (d, left) => {
    if (left < 0) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.test(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) rec(p, left - 1);
      else if (exts.includes(extname(e.name).toLowerCase())) out.push(p);
    }
  };
  rec(dir, depth);
  return out;
}

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  let currentKey = null;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) { meta[kv[1]] = kv[2].trim(); currentKey = kv[1]; continue; }
    const nested = line.match(/^\s+(\w[\w-]*):\s*(.*)$/);
    if (nested && currentKey) meta[`${currentKey}.${nested[1]}`] = nested[2].trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

const wikilinks = (text) => [...text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((m) => m[1].trim());

const CODE_WORDS = new Set(['id', 'class', 'include', 'define', 'ifdef', 'ifndef', 'endif', 'pragma', 'import', 'else', 'elif', 'main', 'root', 'app', 'container', 'wrapper', 'header', 'footer', 'content', 'panel', 'overlay', 'fff', 'ffffff', '000', '000000']);

/**
 * Hashtags, but only real ones. Markdown docs are full of things that look like
 * tags and aren't: CSS selectors, hex colours, shell comments, C preprocessor
 * directives. Those produced 100+ junk nodes from a single file before this.
 */
function tags(text) {
  const stripped = text
    .replace(/```[\s\S]*?```/g, ' ')   // fenced code
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');       // inline code
  const found = [];
  for (const line of stripped.split('\n')) {
    if (/[{};]/.test(line)) continue;             // CSS / code line
    if (/^\s{4,}\S/.test(line)) continue;        // indented code block
    if (/^\s*(#!|#\s)/.test(line)) continue;     // shebang or markdown heading
    for (const m of line.matchAll(/(?:^|[\s(\[,])#([A-Za-z][\w-]{1,30})\b/g)) {
      const tag = m[1];
      if (/^[0-9a-fA-F]{3,8}$/.test(tag)) continue;   // hex colour
      if (!/[a-zA-Z]{2}/.test(tag)) continue;         // needs real letters
      if (CODE_WORDS.has(tag.toLowerCase())) continue;
      found.push(tag);
      if (found.length >= 25) return found;           // cap per document
    }
  }
  return found;
}
const titleOf = (body, file) => body.match(/^#\s+(.+)$/m)?.[1]?.trim() || basename(file, extname(file));

/** Ingest one markdown file as a node, wiring [[links]] and #tags as edges. */
function ingestMarkdown(file, { label, extraProps = {}, slugPrefix, extractTags = false }) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch { return null; }
  const { meta, body } = parseFrontmatter(raw);
  const slug = meta.name || basename(file, extname(file));
  const id = `${slugPrefix}:${slug}`;
  const stat = statSync(file);

  g.upsertNode({
    id,
    // Suffix the frontmatter type so `type: project` can't collide with the
    // structural Project label (it did: memories showed up as Projects).
    labels: [label, ...(meta['metadata.type'] ? [`${cap(meta['metadata.type'])}${label}`] : [])],
    props: {
      title: meta.name || titleOf(body, file),
      description: meta.description || firstLine(body),
      body: body.slice(0, 4000),
      path: file,
      source: label,
      mtime: stat.mtime.toISOString(),
      words: body.split(/\s+/).length,
      ...extraProps,
    },
  });

  for (const link of wikilinks(body)) {
    g.upsertNode({ id: `${slugPrefix}:${link}`, labels: [label], props: { title: link } });
    g.addEdge({ src: id, dst: `${slugPrefix}:${link}`, type: 'LINKS_TO' });
  }
  // Only user-authored vaults really use #hashtags. Claude's memory files and
  // CLAUDE.md are prose that mentions CSS ids and flags, which produced pure
  // noise nodes (#floorBtn, #flow-overlay) when treated as tags.
  for (const tag of extractTags ? new Set(tags(body)) : []) {
    g.upsertNode({ id: `tag:${tag.toLowerCase()}`, labels: ['Tag'], props: { title: `#${tag}` } });
    g.addEdge({ src: id, dst: `tag:${tag.toLowerCase()}`, type: 'TAGGED' });
  }
  return id;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const firstLine = (body) =>
  body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#') && !l.startsWith('---'))?.slice(0, 200) || '';

/** Claude's own memory files — the most load-bearing part of the second brain. */
function ingestMemories(report) {
  if (!existsSync(PROJECTS)) return;
  for (const projDir of readdirSync(PROJECTS)) {
    const memDir = join(PROJECTS, projDir, 'memory');
    if (!existsSync(memDir)) continue;
    const projectId = `project:${projDir}`;
    g.upsertNode({
      id: projectId,
      labels: ['Project'],
      props: { title: basename(decodeProjectDir(projDir)) || projDir, path: decodeProjectDir(projDir) },
    });
    for (const file of walk(memDir, { depth: 2 })) {
      if (basename(file) === 'MEMORY.md') continue;
      const id = ingestMarkdown(file, { label: 'Memory', slugPrefix: 'mem', extraProps: { project: projDir } });
      if (id) { g.addEdge({ src: id, dst: projectId, type: 'BELONGS_TO' }); report.memories++; }
    }
  }
}

/** CLAUDE.md instruction files found near your projects. */
function ingestClaudeMd(report) {
  const roots = new Set([join(HOME, 'Desktop'), join(HOME, 'Documents'), join(HOME, 'code'), join(HOME, 'projects')]);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const file of walk(root, { exts: ['.md'], depth: 3 })) {
      if (basename(file) !== 'CLAUDE.md') continue;
      const id = ingestMarkdown(file, { label: 'Doc', slugPrefix: 'doc', extraProps: { kind: 'CLAUDE.md' } });
      if (id) report.docs++;
    }
  }
}

/** Session transcripts become first-class nodes so the graph records how work happened. */
function ingestTranscripts(report, maxPer) {
  if (!existsSync(PROJECTS)) return;
  for (const projDir of readdirSync(PROJECTS)) {
    const dir = join(PROJECTS, projDir);
    let files;
    try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    const projectId = `project:${projDir}`;
    g.upsertNode({
      id: projectId,
      labels: ['Project'],
      props: { title: basename(decodeProjectDir(projDir)) || projDir, path: decodeProjectDir(projDir) },
    });
    const recent = files
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, maxPer);

    for (const { f } of recent) {
      const meta = summarizeTranscript(join(dir, f));
      if (!meta) continue;
      const id = `session:${meta.sessionId}`;
      g.upsertNode({
        id,
        labels: ['Session'],
        props: {
          title: meta.title || meta.lastPrompt?.slice(0, 80) || meta.sessionId.slice(0, 8),
          body: meta.lastPrompt || '',
          sessionId: meta.sessionId,
          project: projDir,
          started: meta.started,
          ended: meta.ended,
          turns: meta.turns,
          tools: meta.tools.join(','),
          mode: meta.mode || '',
        },
      });
      g.addEdge({ src: id, dst: projectId, type: 'RAN_IN' });
      for (const tool of meta.tools.slice(0, 12)) {
        g.upsertNode({ id: `tool:${tool}`, labels: ['Tool'], props: { title: tool } });
        g.addEdge({ src: id, dst: `tool:${tool}`, type: 'USED' });
      }
      report.sessions++;
    }
  }
}

export function summarizeTranscript(file) {
  let lines;
  try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return null; }
  const meta = { sessionId: basename(file, '.jsonl'), turns: 0, tools: new Set(), title: null, lastPrompt: null, mode: null, started: null, ended: null };
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.sessionId) meta.sessionId = rec.sessionId;
    if (rec.timestamp) { meta.started ??= rec.timestamp; meta.ended = rec.timestamp; }
    if (rec.type === 'ai-title' && rec.aiTitle) meta.title = rec.aiTitle;
    if (rec.type === 'last-prompt' && rec.lastPrompt) meta.lastPrompt = rec.lastPrompt;
    if (rec.type === 'mode' && rec.mode) meta.mode = rec.mode;
    if (rec.type === 'user') meta.turns++;
    if (rec.cwd) meta.cwd = rec.cwd;
    const content = rec.message?.content;
    if (Array.isArray(content)) {
      for (const part of content) if (part?.type === 'tool_use' && part.name) meta.tools.add(part.name);
    }
  }
  return { ...meta, tools: [...meta.tools] };
}

/** Any markdown vault you point at — Obsidian, Logseq, a notes folder. */
function ingestVaults(report, vaults) {
  for (const vault of vaults) {
    const root = vault.replace(/^~/, HOME);
    if (!existsSync(root)) continue;
    const vaultId = `vault:${basename(root)}`;
    g.upsertNode({ id: vaultId, labels: ['Vault'], props: { title: basename(root), path: root } });
    for (const file of walk(root, { exts: ['.md', '.markdown', '.txt'], depth: 8 })) {
      const id = ingestMarkdown(file, {
        label: 'Note',
        slugPrefix: 'note',
        extractTags: true,
        extraProps: { vault: basename(root), rel: relative(root, file) },
      });
      if (id) { g.addEdge({ src: id, dst: vaultId, type: 'IN_VAULT' }); report.notes++; }
    }
  }
}

export function ingestAll({ quiet = false } = {}) {
  const cfg = brainConfig();
  const report = { memories: 0, docs: 0, sessions: 0, notes: 0 };
  if (cfg.includeMemories) ingestMemories(report);
  if (cfg.includeClaudeMd) ingestClaudeMd(report);
  if (cfg.includeTranscripts) ingestTranscripts(report, cfg.maxTranscriptsPerProject ?? 25);
  ingestVaults(report, cfg.vaults || []);
  if (!quiet) report.total = g.stats();
  return report;
}
