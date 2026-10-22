# The HTTP API

`ccmod dash --serve` puts a JSON API on `127.0.0.1:7717`. The web explorer is
written against it, the Claude Code pane polls it in live mode, and anything
else on your machine can use it too.

**It binds loopback and has no authentication.** Anyone who can reach the port
can rewrite your graph, so keep it on `127.0.0.1`. Don't put it behind a
reverse proxy, don't change the host, don't forward the port.

```bash
ccmod dash --serve            # 127.0.0.1:7717
ccmod dash --serve --port 8080 --open
```

## Reads

| | | |
|---|---|---|
| `GET` | `/api/version` | `{ version }` — a counter bumped on every write. Poll this instead of diffing graphs; live mode asks for it every four seconds. |
| `GET` | `/api/state` | The dashboard snapshot: graph counters, relay peers, routing stats, recent sessions. |
| `GET` | `/api/graph` | `{ nodes, edges }`, up to 1500 nodes, each node carrying its `degree`. |
| `GET` | `/api/node?id=<id>` | `{ node, neighbors }`, or `{ node: null }` when there is no such id. |
| `GET` | `/api/expand?id=<id>` | `{ neighbors }`, up to 200 — one hop out, what a double-click in the explorer asks for. |

## Writes

Every write bumps `/api/version`, so other clients notice.

| | | Body |
|---|---|---|
| `POST` | `/api/node` | `{ id, labels?, props? }` — upsert. `400` without an `id`. |
| `PATCH` | `/api/node` | `{ id, props?, labels?, remove? }` — merge props, replace labels, drop the prop names in `remove`. `404` when the node is unknown. |
| `DELETE` | `/api/node` | `{ id }` → `{ deleted: boolean }`. Takes its edges with it. |
| `POST` | `/api/edge` | `{ src, dst, type, props? }`. `type` is upper-cased. `400` if any of the three is missing. |
| `DELETE` | `/api/edge` | `{ src, dst, type }` → `{ deleted: boolean }`. |
| `POST` | `/api/position` | `{ id, x, y }` pins a node where you dropped it; omit `x`/`y` to unpin. |
| `POST` | `/api/positions` | `{ positions: [{ id, x, y }] }` → `{ pinned: n }`. One call after a drag of many. |
| `POST` | `/api/query` | `{ query }` (or `{ q }`) → `{ rows }`, or `{ rows: [], error }` for a query the parser rejects — a bad query is answered `200` with the message, not an exception. |
| `POST` | `/api/ingest` | Re-reads memories, docs, sessions and vaults. Takes no body. |
| `POST` | `/api/config` | Saves the dashboard layout. |

## The Cypher subset

`/api/query` and `ccmod brain query` share one small parser. It is not Cypher;
it handles the shapes the explorer needs:

```cypher
MATCH (a:Note) RETURN a LIMIT 10
MATCH (a:Memory)-[:LINKS_TO]->(b) RETURN a,b
MATCH (a:Note) WHERE a.title CONTAINS "graph" RETURN a
MATCH (a) WHERE a.id STARTS WITH "mem:" RETURN a
```

Supported: one node pattern or one hop, an optional relationship type, `WHERE`
with `=`, `CONTAINS` or `STARTS WITH` on a property, and `LIMIT`. Anything
else — multi-hop, `OPTIONAL MATCH`, aggregation, `CREATE`, `SET`, `DELETE` —
is refused with a message saying so. Writes go through the endpoints above.

## Example

```bash
# What is in there?
curl -s 127.0.0.1:7717/api/graph | jq '.nodes | length'

# Record something and link it to a project.
curl -s -X POST 127.0.0.1:7717/api/node \
  -H 'content-type: application/json' \
  -d '{"id":"note:ranking","labels":["Note"],"props":{"title":"Ranking rewrite","body":"BM25 first, then rerank"}}'

curl -s -X POST 127.0.0.1:7717/api/edge \
  -H 'content-type: application/json' \
  -d '{"src":"note:ranking","dst":"project:search","type":"BELONGS_TO"}'

# Find it again.
curl -s -X POST 127.0.0.1:7717/api/query \
  -H 'content-type: application/json' \
  -d '{"query":"MATCH (a:Note) WHERE a.title CONTAINS \"Ranking\" RETURN a"}' | jq
```
