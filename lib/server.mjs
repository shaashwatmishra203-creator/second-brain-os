/** Loopback-only HTTP server behind the dashboard. */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { ROOT } from './paths.mjs';
import * as g from './graph.mjs';
import * as relay from './relay.mjs';
import { snapshot, saveDashConfig } from './dash.mjs';
import { ingestAll } from './ingest.mjs';

// The explorer's files are code, so they sit beside this module in the
// checkout — not under ~/.claude/mods, which is where DATA lives. Resolving
// them from there broke every clone that was not at the documented path.
const WEB = join(ROOT, 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
};

const readBody = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
});

export function serve({ port = 7717, host = '127.0.0.1' } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}`);
    const p = url.pathname;
    try {
      // Cheap poll target: clients watch this number instead of diffing graphs.
      const GET = req.method === 'GET';
      if (p === '/api/version' && GET) return json(res, 200, { version: g.version() });
      if (p === '/api/state' && GET) return json(res, 200, snapshot());
      if (p === '/api/graph' && GET) return json(res, 200, g.dump({ limit: 1500 }));
      // Method-guarded: without it this read would also answer the POST,
      // PATCH and DELETE defined below, since it is matched first.
      if (p === '/api/node' && GET) {
        const id = url.searchParams.get('id');
        return json(res, 200, { node: g.getNode(id), neighbors: id ? g.neighbors(id) : [] });
      }
      if (p === '/api/query' && req.method === 'POST') {
        const { query, q } = await readBody(req);
        try { return json(res, 200, { rows: g.cypher(String(query ?? q ?? '')) }); }
        catch (err) { return json(res, 200, { rows: [], error: String(err.message || err) }); }
      }
      if (p === '/api/config' && req.method === 'POST') {
        return json(res, 200, saveDashConfig(await readBody(req)));
      }
      if (p === '/api/ingest' && req.method === 'POST') {
        return json(res, 200, ingestAll({ quiet: true }));
      }
      // --- mutations -------------------------------------------------------
      if (p === '/api/node' && req.method === 'POST') {
        const { id, labels = [], props = {} } = await readBody(req);
        if (!id) return json(res, 400, { error: 'id is required' });
        return json(res, 200, g.upsertNode({ id, labels, props }));
      }
      if (p === '/api/node' && req.method === 'PATCH') {
        const { id, props = {}, labels, remove = [] } = await readBody(req);
        if (!id || !g.getNode(id)) return json(res, 404, { error: 'no such node' });
        if (Object.keys(props).length) g.upsertNode({ id, props });
        if (Array.isArray(labels)) g.setLabels(id, labels);
        if (remove.length) g.removeProps(id, remove);
        return json(res, 200, { node: g.getNode(id) });
      }
      if (p === '/api/node' && req.method === 'DELETE') {
        const { id } = await readBody(req);
        return json(res, 200, { deleted: g.deleteNode(id) });
      }
      if (p === '/api/position' && req.method === 'POST') {
        const { id, x, y } = await readBody(req);
        return json(res, 200, { pinned: g.setPosition(id, x ?? null, y ?? null) });
      }
      if (p === '/api/positions' && req.method === 'POST') {
        const { positions = [] } = await readBody(req);
        let n = 0;
        for (const q of positions) if (g.setPosition(q.id, q.x, q.y)) n += 1;
        return json(res, 200, { pinned: n });
      }
      if (p === '/api/edge' && req.method === 'POST') {
        const { src, dst, type, props = {} } = await readBody(req);
        if (!src || !dst || !type) return json(res, 400, { error: 'src, dst and type are required' });
        return json(res, 200, g.addEdge({ src, dst, type: String(type).toUpperCase(), props }));
      }
      if (p === '/api/edge' && req.method === 'DELETE') {
        const { src, dst, type } = await readBody(req);
        return json(res, 200, { deleted: g.deleteEdge(src, dst, String(type || '').toUpperCase()) });
      }
      if (p === '/api/expand' && GET) {
        const id = url.searchParams.get('id');
        return json(res, 200, { neighbors: id ? g.neighbors(id, { limit: 200 }) : [] });
      }

      if (p === '/api/relay/send' && req.method === 'POST') {
        const { to, body, from = 'dashboard', fromName = 'dashboard', kind = 'message' } = await readBody(req);
        return json(res, 200, relay.send({ to, body, from, fromName, kind }));
      }

      const file = p === '/' ? 'index.html' : p.replace(/^\/+/, '').replace(/\.\./g, '');
      const full = join(WEB, file);
      if (full.startsWith(WEB) && existsSync(full)) {
        const buf = readFileSync(full);
        res.writeHead(200, { 'content-type': MIME[extname(full)] || 'application/octet-stream', 'cache-control': 'no-store' });
        return res.end(buf);
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, 500, { error: String(err.message || err) });
    }
  });

  return new Promise((resolve, reject) => {
    const attempt = (tryPort, left) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && left > 0) { server.removeAllListeners('listening'); attempt(tryPort + 1, left - 1); }
        else reject(err);
      });
      server.once('listening', () => resolve({ server, url: `http://${host}:${tryPort}`, port: tryPort }));
      server.listen(tryPort, host);
    };
    attempt(port, 20);
  });
}
