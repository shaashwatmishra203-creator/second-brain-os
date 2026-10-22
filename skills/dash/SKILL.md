---
name: dash
description: Show the user's customizable Claude Code dashboard — knowledge graph, live sessions, relay traffic, model-routing stats. Use when the user asks to see the dashboard, "what's going on", an overview of their agents or second brain, or wants to change which panels appear or how the interface looks.
---

# Dashboard

One interface over everything the mods track. Two surfaces, same config.

## In the terminal

```bash
ccmod dash
```

Renders every enabled panel as text. Fast, no browser. Use this by default when
the user asks what's going on — show them the output.

## In a browser (interactive graph)

```bash
ccmod dash --serve --open
```

Starts a loopback-only server (127.0.0.1, default port 7717) with the
force-directed graph: drag nodes, scroll to zoom, click for an inspector with
connections, filter by label, full-text search, and a live query box that takes
the same Cypher subset as `ccmod brain query`.

It runs in the foreground. Start it with `run_in_background: true` and give the
user the URL — don't block the session on it. If a port is busy it walks up to
the next free one, so read the URL from the output rather than assuming 7717.

To show it inline in this conversation instead, prefer the Artifact path below.

## As a shareable snapshot

```bash
ccmod dash --html /tmp/brain.html
```

Writes a self-contained file — graph data inlined, no server, no network. Good
for sending to the user with `SendUserFile`, or publishing with the `Artifact`
tool. Queries fall back to client-side highlighting in this mode.

## Customize it

The user asked for a customizable interface — treat the layout as theirs.

```bash
ccmod dash --config                      # current layout + available panels
ccmod dash --config --disable tools      # hide a panel
ccmod dash --config --enable tools
ccmod dash --config --reset
```

Everything lives in `~/.claude/mods/config/dash.json`: `title`, `accent`,
`theme` (`auto`/`dark`/`light`), `refreshSeconds`, and a `widgets` array whose
**order is the render order**. Each widget has `id`, `title` (rename freely),
`enabled`, and `span` (`half` or `full`).

Panels: `graph`, `sessions`, `relay`, `router`, `labels`, `hubs`, `tools`.

In the browser view, the **Customize** button does all of this with a drawer —
reorder, rename, resize, toggle, recolor — and writes back to the same file. If
the user wants to rearrange things, point them there rather than editing JSON by
hand.

## Status line

A compact strip of this dashboard lives inside Claude Code itself — graph size,
active peers, unread relay messages, routing share. It's wired via `statusLine`
in `~/.claude/settings.json` and rendered by `~/.claude/mods/bin/statusline`.
Add `statusLineExtra` to `dash.json` to append your own text.

## Health check

```bash
ccmod doctor
```

Confirms the hooks, subagent, configs, and graph are all actually in place. Run
this first if any part of the dashboard looks stale or empty.
