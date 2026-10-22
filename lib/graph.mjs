/**
 * Neo4j-shaped property graph over SQLite (zero deps, node:sqlite).
 * Nodes carry labels + JSON props; edges are typed and directed.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { GRAPH_DB, ensureDirs } from './paths.mjs';

let db = null;

export function open() {
  if (db) return db;
  ensureDirs();
  db = new DatabaseSync(GRAPH_DB);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS nodes (
      id      TEXT PRIMARY KEY,
      labels  TEXT NOT NULL DEFAULT '[]',
      props   TEXT NOT NULL DEFAULT '{}',
      created TEXT NOT NULL,
      updated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS edges (
      id      TEXT PRIMARY KEY,
      src     TEXT NOT NULL,
      dst     TEXT NOT NULL,
      type    TEXT NOT NULL,
      props   TEXT NOT NULL DEFAULT '{}',
      created TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_edges_src  ON edges(src, type);
    CREATE INDEX IF NOT EXISTS idx_edges_dst  ON edges(dst, type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_triple ON edges(src, dst, type);
  `);
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(id UNINDEXED, title, body)`);
  } catch { /* fts5 unavailable; search() falls back to LIKE */ }
  return db;
}

const now = () => new Date().toISOString();

/**
 * A counter bumped by every write. Readers poll this instead of diffing the
 * whole graph, so a live view costs one tiny query rather than a full dump.
 */
export function version() {
  const d = open();
  const row = d.prepare(`SELECT value FROM meta WHERE key = 'version'`).get();
  return row ? Number(row.value) : 0;
}

function bump() {
  const d = open();
  const next = version() + 1;
  d.prepare(`INSERT INTO meta (key, value) VALUES ('version', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(next));
  return next;
}
const asArr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    labels: JSON.parse(row.labels),
    props: JSON.parse(row.props),
    created: row.created,
    updated: row.updated,
  };
}

function hasFts() {
  const d = open();
  try {
    d.prepare(`SELECT 1 FROM node_fts LIMIT 1`).all();
    return true;
  } catch { return false; }
}

/** Create or merge a node. Existing labels/props are merged, not clobbered. */
export function upsertNode({ id, labels = [], props = {} }) {
  const d = open();
  id = id || randomUUID();
  const existing = hydrate(d.prepare(`SELECT * FROM nodes WHERE id = ?`).get(id));
  const mergedLabels = [...new Set([...(existing?.labels || []), ...asArr(labels)])];
  const mergedProps = { ...(existing?.props || {}), ...props };
  const t = now();
  if (existing) {
    d.prepare(`UPDATE nodes SET labels = ?, props = ?, updated = ? WHERE id = ?`)
      .run(JSON.stringify(mergedLabels), JSON.stringify(mergedProps), t, id);
  } else {
    d.prepare(`INSERT INTO nodes (id, labels, props, created, updated) VALUES (?, ?, ?, ?, ?)`)
      .run(id, JSON.stringify(mergedLabels), JSON.stringify(mergedProps), t, t);
  }
  if (hasFts()) {
    const title = String(mergedProps.title ?? mergedProps.name ?? id);
    const body = String(mergedProps.body ?? mergedProps.description ?? mergedProps.text ?? '');
    d.prepare(`DELETE FROM node_fts WHERE id = ?`).run(id);
    d.prepare(`INSERT INTO node_fts (id, title, body) VALUES (?, ?, ?)`).run(id, title, body);
  }
  bump();
  return { id, labels: mergedLabels, props: mergedProps };
}

/** Create an edge. Duplicate (src,dst,type) triples merge their props. */
export function addEdge({ src, dst, type, props = {} }) {
  const d = open();
  if (!src || !dst || !type) throw new Error('addEdge needs src, dst, type');
  // Autovivify endpoints so imports never fail on ordering.
  for (const n of [src, dst]) {
    if (!d.prepare(`SELECT 1 FROM nodes WHERE id = ?`).get(n)) upsertNode({ id: n, labels: ['Stub'] });
  }
  const existing = d.prepare(`SELECT * FROM edges WHERE src = ? AND dst = ? AND type = ?`).get(src, dst, type);
  if (existing) {
    const merged = { ...JSON.parse(existing.props), ...props };
    d.prepare(`UPDATE edges SET props = ? WHERE id = ?`).run(JSON.stringify(merged), existing.id);
    return { id: existing.id, src, dst, type, props: merged };
  }
  const id = randomUUID();
  d.prepare(`INSERT INTO edges (id, src, dst, type, props, created) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, src, dst, type, JSON.stringify(props), now());
  bump();
  return { id, src, dst, type, props };
}

/** Remove one edge by its triple. */
export function deleteEdge(src, dst, type) {
  const d = open();
  const r = d.prepare(`DELETE FROM edges WHERE src = ? AND dst = ? AND type = ?`).run(src, dst, type);
  bump();
  return r.changes > 0;
}

/**
 * Pin a node where the person dragged it. Stored on the node so every client
 * — the web explorer and the pane alike — opens on the same arrangement.
 */
export function setPosition(id, x, y) {
  const d = open();
  const node = getNode(id);
  if (!node) return false;
  const props = { ...node.props };
  if (x === null || y === null) { delete props.pinX; delete props.pinY; }
  else { props.pinX = Math.round(x); props.pinY = Math.round(y); }
  d.prepare(`UPDATE nodes SET props = ?, updated = ? WHERE id = ?`)
    .run(JSON.stringify(props), now(), id);
  bump();
  return true;
}

/** Replace a node's labels outright, unlike upsertNode which merges them. */
export function setLabels(id, labels) {
  const d = open();
  if (!getNode(id)) return false;
  d.prepare(`UPDATE nodes SET labels = ?, updated = ? WHERE id = ?`)
    .run(JSON.stringify([...new Set(labels)]), now(), id);
  bump();
  return true;
}

/** Drop named props from a node (upsertNode can only add or overwrite). */
export function removeProps(id, keys) {
  const d = open();
  const node = getNode(id);
  if (!node) return false;
  const props = { ...node.props };
  for (const k of keys) delete props[k];
  d.prepare(`UPDATE nodes SET props = ?, updated = ? WHERE id = ?`)
    .run(JSON.stringify(props), now(), id);
  bump();
  return true;
}

export function getNode(id) {
  return hydrate(open().prepare(`SELECT * FROM nodes WHERE id = ?`).get(id));
}

export function deleteNode(id) {
  const d = open();
  d.prepare(`DELETE FROM edges WHERE src = ? OR dst = ?`).run(id, id);
  if (hasFts()) d.prepare(`DELETE FROM node_fts WHERE id = ?`).run(id);
  const r = d.prepare(`DELETE FROM nodes WHERE id = ?`).run(id);
  bump();
  return r.changes > 0;
}

/** Filter nodes by label and prop equality/substring. where: {k: v} or {k: {contains: v}} */
export function find({ label, where = {}, limit = 50 } = {}) {
  const d = open();
  const clauses = [];
  const args = [];
  if (label) { clauses.push(`EXISTS (SELECT 1 FROM json_each(nodes.labels) WHERE json_each.value = ?)`); args.push(label); }
  for (const [k, v] of Object.entries(where)) {
    if (v && typeof v === 'object' && 'contains' in v) {
      clauses.push(`LOWER(COALESCE(json_extract(props, '$."' || ? || '"'), '')) LIKE ?`);
      args.push(k, `%${String(v.contains).toLowerCase()}%`);
    } else {
      clauses.push(`json_extract(props, '$."' || ? || '"') = ?`);
      args.push(k, v);
    }
  }
  const sql = `SELECT * FROM nodes ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY updated DESC LIMIT ?`;
  return d.prepare(sql).all(...args, limit).map(hydrate);
}

/** Full-text search across title/body, with a LIKE fallback. */
export function search(q, limit = 25) {
  const d = open();
  if (hasFts()) {
    try {
      const rows = d.prepare(
        `SELECT n.* FROM node_fts f JOIN nodes n ON n.id = f.id
         WHERE node_fts MATCH ? ORDER BY rank LIMIT ?`
      ).all(q, limit);
      if (rows.length) return rows.map(hydrate);
    } catch { /* fall through to LIKE on malformed MATCH syntax */ }
  }
  const like = `%${q.toLowerCase()}%`;
  return d.prepare(
    `SELECT * FROM nodes WHERE LOWER(props) LIKE ? OR LOWER(id) LIKE ? ORDER BY updated DESC LIMIT ?`
  ).all(like, like, limit).map(hydrate);
}

/** Edges touching a node, with the node on the far end hydrated. */
export function neighbors(id, { dir = 'both', type = null, limit = 100 } = {}) {
  const d = open();
  const out = [];
  if (dir === 'out' || dir === 'both') {
    const sql = `SELECT e.*, 'out' AS dirn FROM edges e WHERE e.src = ? ${type ? 'AND e.type = ?' : ''} LIMIT ?`;
    out.push(...(type ? d.prepare(sql).all(id, type, limit) : d.prepare(sql).all(id, limit)));
  }
  if (dir === 'in' || dir === 'both') {
    const sql = `SELECT e.*, 'in' AS dirn FROM edges e WHERE e.dst = ? ${type ? 'AND e.type = ?' : ''} LIMIT ?`;
    out.push(...(type ? d.prepare(sql).all(id, type, limit) : d.prepare(sql).all(id, limit)));
  }
  return out.map((e) => ({
    type: e.type,
    dir: e.dirn,
    props: JSON.parse(e.props),
    other: getNode(e.dirn === 'out' ? e.dst : e.src),
  }));
}

/** Shortest path (BFS, undirected) between two nodes. */
export function path(a, b, maxDepth = 6) {
  if (a === b) return [a];
  const seen = new Set([a]);
  let frontier = [[a]];
  for (let depth = 0; depth < maxDepth; depth++) {
    const next = [];
    for (const trail of frontier) {
      const tip = trail[trail.length - 1];
      for (const n of neighbors(tip, { limit: 500 })) {
        const nid = n.other?.id;
        if (!nid || seen.has(nid)) continue;
        const extended = [...trail, nid];
        if (nid === b) return extended;
        seen.add(nid);
        next.push(extended);
      }
    }
    if (!next.length) break;
    frontier = next;
  }
  return null;
}

export function stats() {
  const d = open();
  const nodes = d.prepare(`SELECT COUNT(*) c FROM nodes`).get().c;
  const edges = d.prepare(`SELECT COUNT(*) c FROM edges`).get().c;
  const byLabel = d.prepare(
    `SELECT json_each.value AS label, COUNT(*) c FROM nodes, json_each(nodes.labels)
     GROUP BY label ORDER BY c DESC`
  ).all();
  const byType = d.prepare(`SELECT type, COUNT(*) c FROM edges GROUP BY type ORDER BY c DESC`).all();
  const hubs = d.prepare(
    `SELECT id, COUNT(*) degree FROM (
       SELECT src AS id FROM edges UNION ALL SELECT dst AS id FROM edges
     ) GROUP BY id ORDER BY degree DESC LIMIT 10`
  ).all().map((r) => ({ ...r, node: getNode(r.id) }));
  const orphans = d.prepare(
    `SELECT COUNT(*) c FROM nodes WHERE id NOT IN (SELECT src FROM edges UNION SELECT dst FROM edges)`
  ).get().c;
  return { nodes, edges, byLabel, byType, hubs, orphans };
}

/** Whole graph, shaped for the force-directed view. */
export function dump({ limit = 2000 } = {}) {
  const d = open();
  const nodes = d.prepare(`SELECT * FROM nodes ORDER BY updated DESC LIMIT ?`).all(limit).map(hydrate);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = d.prepare(`SELECT * FROM edges`).all()
    .filter((e) => ids.has(e.src) && ids.has(e.dst))
    .map((e) => ({ src: e.src, dst: e.dst, type: e.type }));
  const degree = {};
  for (const e of edges) { degree[e.src] = (degree[e.src] || 0) + 1; degree[e.dst] = (degree[e.dst] || 0) + 1; }
  return { nodes: nodes.map((n) => ({ ...n, degree: degree[n.id] || 0 })), edges };
}

// ---------------------------------------------------------------------------
// Cypher-lite: MATCH (a:L {k:"v"})-[:TYPE]->(b:L) WHERE a.k CONTAINS "x" RETURN a,b LIMIT n
// ---------------------------------------------------------------------------

const NODE_PAT = /\(\s*(\w+)?\s*(?::\s*(\w+))?\s*(\{[^}]*\})?\s*\)/;

function parseInline(blob) {
  if (!blob) return {};
  const out = {};
  for (const m of blob.slice(1, -1).matchAll(/(\w+)\s*:\s*("([^"]*)"|'([^']*)'|[\w.-]+)/g)) {
    out[m[1]] = m[3] ?? m[4] ?? m[2];
  }
  return out;
}

export function cypher(query) {
  const q = query.trim();
  const limitMatch = q.match(/\bLIMIT\s+(\d+)/i);
  const limit = limitMatch ? Number(limitMatch[1]) : 50;

  const matchBody = q.match(/\bMATCH\b([\s\S]*?)(?:\bWHERE\b|\bRETURN\b|\bLIMIT\b|$)/i)?.[1]?.trim();
  if (!matchBody) throw new Error('cypher-lite: expected a MATCH clause');

  const whereBody = q.match(/\bWHERE\b([\s\S]*?)(?:\bRETURN\b|\bLIMIT\b|$)/i)?.[1]?.trim() || '';
  const wherePreds = [...whereBody.matchAll(/(\w+)\.(\w+)\s*(=|CONTAINS|STARTS WITH)\s*("([^"]*)"|'([^']*)')/gi)]
    .map((m) => ({ alias: m[1], key: m[2], op: m[3].toUpperCase(), val: m[5] ?? m[6] }));

  const rel = matchBody.match(
    /\(\s*(\w+)?\s*(?::\s*(\w+))?\s*(\{[^}]*\})?\s*\)\s*(<-|-)\s*\[\s*(\w+)?\s*(?::\s*(\w+))?\s*\]\s*(->|-)\s*\(\s*(\w+)?\s*(?::\s*(\w+))?\s*(\{[^}]*\})?\s*\)/
  );

  const predsFor = (alias) => {
    const where = {};
    for (const p of wherePreds) {
      if (p.alias !== alias) continue;
      where[p.key] = p.op === '=' ? p.val : { contains: p.val };
    }
    return where;
  };

  if (rel) {
    const [, aAlias = 'a', aLabel, aInline, leftArrow, , relType, rightArrow, bAlias = 'b', bLabel, bInline] = rel;
    const direction = leftArrow === '<-' ? 'in' : rightArrow === '->' ? 'out' : 'both';
    const seeds = find({ label: aLabel, where: { ...parseInline(aInline), ...predsFor(aAlias) }, limit: 500 });
    const bWhere = { ...parseInline(bInline), ...predsFor(bAlias) };
    const rows = [];
    for (const seed of seeds) {
      for (const n of neighbors(seed.id, { dir: direction, type: relType || null, limit: 200 })) {
        const other = n.other;
        if (!other) continue;
        if (bLabel && !other.labels.includes(bLabel)) continue;
        if (!Object.entries(bWhere).every(([k, v]) =>
          v && typeof v === 'object' && 'contains' in v
            ? String(other.props[k] ?? '').toLowerCase().includes(String(v.contains).toLowerCase())
            : String(other.props[k] ?? '') === String(v))) continue;
        rows.push({ [aAlias]: seed, rel: n.type, [bAlias]: other });
        if (rows.length >= limit) return rows;
      }
    }
    return rows;
  }

  const single = matchBody.match(NODE_PAT);
  if (!single) throw new Error('cypher-lite: could not parse node pattern');
  const [, alias = 'n', label, inline] = single;
  return find({ label, where: { ...parseInline(inline), ...predsFor(alias) }, limit })
    .map((n) => ({ [alias]: n }));
}
