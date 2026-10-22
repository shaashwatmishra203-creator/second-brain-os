# Second Brain OS

A knowledge graph of everything Claude Code already knows about your work, with
three ways to use it: a **CLI**, a **Claude Code mod** that draws it beside the
chat, and a **web explorer** in the shape of a graph browser.

It ships three things that work together:

| | What it does |
|---|---|
| **Second brain** | A Neo4j-shaped property graph over SQLite, built from your Claude memories, `CLAUDE.md` files and session history. Labels, typed directed edges, full-text search, shortest paths, and a practical subset of Cypher. |
| **Session relay** | A file-backed mailbox so separate Claude Code sessions hand work to each other. One session plans, another builds, and a handoff wakes an idle session up. |
| **Model routing** | Classifies every prompt with regex heuristics — no extra API call — and nudges mechanical work onto a cheap-model subagent instead of the expensive one. |

No dependencies. Node 22+ (it uses the built-in `node:sqlite`), nothing to
build, nothing to install from npm.

## Install

```bash
git clone https://github.com/<you>/second-brain-os.git ~/.claude/mods
~/.claude/mods/bin/ccmod brain ingest
~/.claude/mods/bin/ccmod doctor
```

Add `~/.claude/mods/bin` to your `PATH` to type `ccmod` instead of the full path.

To wire the hooks (relay delivery, model routing, status line), see
[`docs/hooks.md`](docs/hooks.md). To install the Claude Code mod:

```bash
/plugin marketplace add <you>/second-brain-os
/plugin install second-brain@second-brain-os
```

## The CLI

```bash
ccmod brain ingest                  # (re)build from memories, docs, sessions, vaults
ccmod brain search "footprint extraction"
ccmod brain query 'MATCH (a:Memory)-[:LINKS_TO]->(b) RETURN a,b'
ccmod brain path mem:alpha session:a1b2c3d4
ccmod brain vault ~/Notes           # index a markdown folder, then re-ingest

ccmod relay peers                   # which sessions are live
ccmod relay name planner            # claim a name for this session
ccmod relay send builder "schema is settled — implement src/db.ts"

ccmod route test "fix the typo in README"
ccmod dash                          # the dashboard, in the terminal
ccmod dash --serve --open           # the web explorer
```

## The web explorer

```bash
ccmod dash --serve --open
```

Loopback only, on `127.0.0.1:7717`. A force-directed view of the whole graph:

- **Drag** a node to pin it. The position is saved and every client — the web
  view and the Claude Code pane — opens on the same arrangement.
- **Double-click** a node to expand one hop out, the way a graph browser does.
- **Click** a node to open an inspector: rename it in place, set or remove
  properties, unlink a connection, unpin, or delete it.
- **+ Node** and **+ Link** create them.
- Filter by label with the legend pills, search full-text, or run Cypher.
- Panels are rearrangeable and the layout is saved to `config/dash.json`.

`ccmod dash --html out.html` writes a self-contained snapshot with the data
inlined — no server, no network.

## The Claude Code mod

Two panes beside the chat and a strip above the prompt.

**`/second-brain`** draws the graph as inline SVG on desktop, a ranked list on
the terminal. Tabs for the graph, a searchable node list, a detail view, and
settings. From the detail view you can rename a node, nudge its pinned
position, unpin it or delete it — the same writes the web explorer makes.

**`/vitals`** reports context-window fill, session cost, rate-limit windows,
per-turn token splits, and a **delegation log** showing every subagent with the
model it actually ran on — which is how you see the routing actually working.

Any module can be **pulled out** into a panel of its own, which the surface
stacks as a switchable tab (`ctrl+x tab`).

**Live mode** is a toggle, off by default. When on, the pane polls the
explorer's write counter every four seconds and redraws when the graph changes.
It costs no tokens — drawing and HTTP are free — but it only works while
`ccmod dash --serve` is running. With the server down the pane says so and the
manual Refresh still works.

## How the graph is built

| Label | What it is | Edges |
|---|---|---|
| `Memory` | a Claude memory file | `BELONGS_TO` → Project, `LINKS_TO` → Memory |
| `Session` | one Claude Code session | `RAN_IN` → Project, `USED` → Tool |
| `Project` | a working directory | |
| `Note` | a file from an indexed vault | `IN_VAULT` → Vault, `LINKS_TO` → Note |
| `Doc` | a `CLAUDE.md` instruction file | |

`[[wikilinks]]` become `LINKS_TO` edges and `#hashtags` become `TAGGED` edges,
so an Obsidian or Logseq vault keeps its structure. Hashtags are read from
vault notes only — in generated prose they are nearly all CSS ids and hex
colours rather than tags.

## Your data stays yours

The graph indexes your own memories, session titles and project paths. The
`data/` directory is gitignored and nothing in it is ever published. The web
server binds `127.0.0.1` and has no auth, because it is not meant to leave your
machine — don't expose it to a network.

## Licence

MIT.
