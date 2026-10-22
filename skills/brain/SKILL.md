---
name: brain
description: Query and extend the user's second brain — a Neo4j-shaped knowledge graph built from their Claude memories, CLAUDE.md files, session history, and any markdown vaults they've indexed. Use when the user asks what they know about something, how two things connect, "search my notes/brain", "what have I worked on", or wants to record a fact, link two ideas, or index a notes folder.
---

# Second brain

A property graph over SQLite at `~/.claude/mods/data/graph.db`. Nodes carry
labels and JSON props; edges are typed and directed — the Neo4j model, without
a server. Driven by `~/.claude/mods/bin/ccmod`.

## Shape of the graph

| Label | What it is | Typical edges |
|---|---|---|
| `Memory` | a Claude memory file | `BELONGS_TO` → Project, `LINKS_TO` → Memory, `TAGGED` → Tag |
| `Session` | one Claude Code session | `RAN_IN` → Project, `USED` → Tool |
| `Project` | a working directory | — |
| `Note` | a file from an indexed vault | `IN_VAULT` → Vault, `LINKS_TO` → Note |
| `Doc` | a CLAUDE.md instruction file | — |
| `Tag` / `Tool` / `Vault` | pivots | — |

## Read it

```bash
ccmod brain stats                    # labels, relationship types, hubs
ccmod brain search "footprint extraction"
ccmod brain find --label Memory --project -Users-me-Desktop-app
ccmod brain neighbors mem:cache-tradeoff
ccmod brain path mem:cache-tradeoff session:a1b2c3d4
```

`search` is full-text over titles and bodies. `path` answers "how are these two
things related" with the shortest chain of edges.

## Query it

A practical subset of Cypher — single-node and one-hop patterns, inline props,
`WHERE` with `=` / `CONTAINS` / `STARTS WITH`, and `LIMIT`:

```bash
ccmod brain query 'MATCH (n:Memory) RETURN n LIMIT 10'
ccmod brain query 'MATCH (a:Session)-[:USED]->(t:Tool) RETURN a,t'
ccmod brain query 'MATCH (a:Memory)-[:LINKS_TO]->(b) WHERE a.title CONTAINS "layout" RETURN a,b'
ccmod brain query 'MATCH (s:Session)-[:RAN_IN]->(p:Project) WHERE p.title = "app" RETURN s,p'
```

Multi-hop patterns and aggregation are not supported. For those, chain
`neighbors` calls or use `ccmod brain export --out /tmp/g.json` and work on the
JSON.

## Write to it

```bash
ccmod brain add insight:caching-tradeoff \
  --label Insight \
  --title "Cache invalidation is the real cost" \
  --body "Measured: 40ms saved on read, 300ms spent on fan-out invalidation."

ccmod brain link insight:caching-tradeoff INFORMS project:-Users-me-Desktop-app
```

Node ids are namespaced by convention (`mem:`, `session:`, `note:`, `insight:`).
Keep that pattern — it makes the graph readable and keeps ids stable across
re-ingests. `add` merges into an existing node rather than replacing it.

## Keep it current

```bash
ccmod brain ingest                   # re-scan everything
ccmod brain vault ~/Documents/Notes  # index a markdown folder, then ingest
ccmod brain sources                  # what's being scanned
```

Ingest is idempotent — safe to run any time. It picks up `[[wikilinks]]` as
`LINKS_TO` edges and `#hashtags` as `TAGGED` edges, so an Obsidian or Logseq
vault keeps its structure.

## When to reach for this

Before answering "what do I know about X", "have I done this before", or "what
was that decision about Y" — search the graph rather than guessing. Cite the
node id or file path you found, so the user can verify it.

The graph is visible in the dashboard (`dash` skill), where it renders as an
interactive force-directed view.
