/* Claude second-brain dashboard: widget renderer + force-directed graph. */
'use strict';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString() : n ?? '–');

let STATE = null;
let CONFIG = null;
let GRAPH = { nodes: [], edges: [] };
let timer = null;

const LABEL_COLORS = ['#7c6cf0', '#19b3a6', '#e0894c', '#d9566f', '#5aa0e8', '#9b59d0', '#52a65b', '#c9a227', '#8a8f98'];
const labelColor = (() => {
  const seen = new Map();
  return (label) => {
    if (!seen.has(label)) seen.set(label, LABEL_COLORS[seen.size % LABEL_COLORS.length]);
    return seen.get(label);
  };
})();
const primaryLabel = (n) => (n.labels || []).find((l) => l !== 'Stub') || 'Node';

const ago = (iso) => {
  if (!iso) return '–';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return `${Math.max(0, Math.round(s))}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

// ---------------------------------------------------------------- data plumbing

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

async function refresh({ graph = false } = {}) {
  STATE = await api('/api/state');
  CONFIG = STATE.config;
  applyTheme();
  renderHeader();
  renderGrid({ rebuildGraph: graph });
  if (graph || !GRAPH.nodes.length) await loadGraph();
  $('#stamp').textContent = `updated ${new Date(STATE.at).toLocaleTimeString()}`;
  scheduleRefresh();
}

let seenVersion = -1;

/**
 * Live mode watches a counter the server bumps on every write, so an idle
 * graph costs one tiny request per tick instead of a full dump.
 */
async function pollVersion() {
  try {
    const { version } = await api('/api/version');
    if (seenVersion === -1) { seenVersion = version; return; }
    if (version !== seenVersion) {
      seenVersion = version;
      await refresh({ graph: true });
      $('#stamp').textContent = `updated · v${version}`;
    }
  } catch { /* server gone; the next tick retries */ }
}

function scheduleRefresh() {
  clearTimeout(timer);
  const secs = Number(CONFIG?.refreshSeconds || 0);
  if (secs > 0) timer = setTimeout(() => pollVersion().then(scheduleRefresh).catch(() => scheduleRefresh()), secs * 1000);
}

async function loadGraph() {
  GRAPH = await api('/api/graph');
  initSim();
}

function applyTheme() {
  document.documentElement.style.setProperty('--accent', CONFIG.accent || '#7c6cf0');
  const t = CONFIG.theme || 'auto';
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  document.title = `${CONFIG.title || 'Second Brain'} · Claude`;
  $('#title').textContent = CONFIG.title || 'Second Brain';
}

function renderHeader() {
  const g = STATE.data.graph || {};
  const r = STATE.data.relay || {};
  $('#s-nodes').textContent = fmt(g.nodes ?? '–');
  $('#s-edges').textContent = fmt(g.edges ?? '–');
  $('#s-sessions').textContent = fmt(r.peers?.length ?? '–');
  $('#s-pending').textContent = fmt(r.pending ?? 0);
}

// ------------------------------------------------------------------- rendering

const RENDERERS = {
  graph: renderGraphCard,
  sessions: renderSessions,
  relay: renderRelay,
  router: renderRouter,
  labels: renderLabels,
  hubs: renderHubs,
  tools: renderTools,
};

function renderGrid({ rebuildGraph = false } = {}) {
  const grid = $('#grid');
  // The graph card holds live state the user is in the middle of using — a typed
  // query, a search term, an open inspector, a dragged layout. A periodic
  // refresh must not throw that away, so it is detached and reused.
  const keptGraph = rebuildGraph ? null : grid.querySelector('[data-widget="graph"]');
  if (keptGraph) keptGraph.remove();
  grid.innerHTML = '';

  for (const w of CONFIG.widgets) {
    if (!w.enabled) continue;
    const data = STATE.data[w.id];
    if (data === undefined) continue;

    if (w.id === 'graph' && keptGraph) {
      keptGraph.className = 'card' + (w.span === 'full' ? ' full' : '');
      const h2 = keptGraph.querySelector('h2');
      if (h2) h2.innerHTML = `${esc(w.title)}<span class="count">${fmt(data.nodes)} nodes · ${fmt(data.edges)} edges · ${fmt(data.orphans)} orphan</span>`;
      grid.appendChild(keptGraph);
      continue;
    }

    const card = document.createElement('section');
    card.className = 'card' + (w.span === 'full' ? ' full' : '');
    card.dataset.widget = w.id;
    if (data && data.error) {
      card.innerHTML = `<h2>${esc(w.title)}</h2><div class="body"><div class="err">${esc(data.error)}</div></div>`;
    } else {
      const fn = RENDERERS[w.id];
      card.innerHTML = fn ? fn(data, w) : `<h2>${esc(w.title)}</h2><div class="body"><pre>${esc(JSON.stringify(data, null, 2))}</pre></div>`;
    }
    grid.appendChild(card);
  }
  wireGraphCard();
}

function renderSessions(rows, w) {
  if (!rows.length) return `<h2>${esc(w.title)}</h2><div class="body"><div class="empty">No sessions recorded yet.</div></div>`;
  const body = rows.map((s) => `
    <tr>
      <td>${s.relayState ? `<span class="pill ${esc(s.relayState)}" title="${esc(s.relayState)}"></span> ` : ''}<span class="trunc" title="${esc(s.title)}">${esc(s.title)}</span>
        <div style="color:var(--muted);font-size:11px">${esc(s.project)} · ${esc(s.short)}${s.relayName ? ` · <b>${esc(s.relayName)}</b>` : ''}${s.relayRole ? ` · ${esc(s.relayRole)}` : ''}${s.pending ? ` · <span style="color:var(--warn)">${s.pending} unread</span>` : ''}</div>
      </td>
      <td class="num">${fmt(s.turns)}</td>
      <td class="num" style="color:var(--muted)">${esc(ago(s.updated))}</td>
    </tr>`).join('');
  return `<h2>${esc(w.title)}<span class="count">${rows.length}</span></h2>
    <div class="body flush"><table><thead><tr><th>Session</th><th class="num">Turns</th><th class="num">Updated</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderRelay(d, w) {
  const peers = d.peers || [];
  const peerRows = peers.length ? peers.map((p) => `
    <tr>
      <td><span class="pill ${esc(p.state)}"></span> <b>${esc(p.name || p.sessionId.slice(0, 8))}</b>
        <div style="color:var(--muted);font-size:11px">${esc(p.role || 'no role')} · ${esc(ago(p.lastSeen))}</div></td>
      <td class="num">${p.pending ? `<span style="color:var(--warn)">${p.pending}</span>` : '0'}</td>
    </tr>`).join('') : `<tr><td colspan="2" class="empty">No sessions registered. They register themselves on start.</td></tr>`;
  const hist = (d.history || []).slice(0, 6).map((m) => `
    <li style="padding:6px 0;border-top:1px solid var(--line)">
      <div style="font-size:11px;color:var(--muted)">${esc(m.fromName || (m.from || '').slice(0, 8))} → ${esc((m.to || '').slice(0, 8))} · ${esc(m.kind)} · ${esc(ago(m.sentAt))}</div>
      <div class="trunc" title="${esc(m.body)}">${esc(m.body)}</div>
    </li>`).join('');
  return `<h2>${esc(w.title)}<span class="count">${d.active || 0} active</span></h2>
    <div class="body flush"><table><tbody>${peerRows}</tbody></table></div>
    ${hist ? `<div class="body" style="border-top:1px solid var(--line)"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:4px">Recent handoffs</div><ul style="margin:0;padding:0;list-style:none">${hist}</ul></div>` : ''}`;
}

function renderRouter(d, w) {
  const share = Math.round((d.lightShare || 0) * 100);
  const rows = (d.recent || []).map((r) => `
    <tr>
      <td><span class="chip ${r.tier === 'light' ? 'on' : ''}">${esc(r.tier)}</span></td>
      <td class="trunc" title="${esc(r.prompt || '')}">${esc(r.prompt || '')}
        <div style="color:var(--muted);font-size:11px" class="trunc">${esc(r.reason || '')}</div></td>
      <td class="num" style="color:var(--muted)">${esc(ago(r.at))}</td>
    </tr>`).join('');
  return `<h2>${esc(w.title)}<span class="count">${fmt(d.total || 0)} routed</span></h2>
    <div class="body">
      <div style="display:flex;gap:18px;align-items:baseline;margin-bottom:8px">
        <div class="stat"><b>${share}%</b><span>sent to cheap model</span></div>
        <div class="stat"><b>${fmt(d.light || 0)}</b><span>light</span></div>
        <div class="stat"><b>${fmt(d.heavy || 0)}</b><span>heavy</span></div>
      </div>
      <div class="bar"><i style="width:${share}%"></i></div>
    </div>
    ${rows ? `<div class="body flush" style="border-top:1px solid var(--line)"><table><tbody>${rows}</tbody></table></div>`
            : `<div class="body" style="border-top:1px solid var(--line)"><div class="empty">No routing decisions logged yet — send a prompt and this fills in.</div></div>`}`;
}

function renderLabels(rows, w) {
  if (!rows.length) return `<h2>${esc(w.title)}</h2><div class="body"><div class="empty">Graph is empty. Hit “Re-scan brain”.</div></div>`;
  const max = Math.max(...rows.map((r) => r.c));
  return `<h2>${esc(w.title)}<span class="count">${rows.length} labels</span></h2>
    <div class="body">${rows.map((r) => `
      <div style="display:flex;align-items:center;gap:10px;margin:7px 0">
        <span class="pill" style="background:${labelColor(r.label)}"></span>
        <span style="flex:1">${esc(r.label)}</span>
        <span style="font-variant-numeric:tabular-nums;color:var(--muted)">${fmt(r.c)}</span>
        <span class="bar" style="width:90px"><i style="width:${(r.c / max) * 100}%;background:${labelColor(r.label)}"></i></span>
      </div>`).join('')}</div>`;
}

function renderHubs(rows, w) {
  if (!rows.length) return `<h2>${esc(w.title)}</h2><div class="body"><div class="empty">No connections yet.</div></div>`;
  return `<h2>${esc(w.title)}<span class="count">by degree</span></h2>
    <div class="body flush"><table><tbody>${rows.map((h) => `
      <tr><td><button class="link-btn" data-focus="${esc(h.id)}">${esc(h.title)}</button>
        <div style="font-size:11px;color:var(--muted)">${esc((h.labels || []).join(', '))}</div></td>
        <td class="num">${fmt(h.degree)}</td></tr>`).join('')}</tbody></table></div>`;
}

function renderTools(rows, w) {
  if (!rows.length) return `<h2>${esc(w.title)}</h2><div class="body"><div class="empty">No tool usage indexed.</div></div>`;
  const max = Math.max(...rows.map((r) => r.count));
  return `<h2>${esc(w.title)}<span class="count">across sessions</span></h2>
    <div class="body">${rows.map((r) => `
      <div style="display:flex;align-items:center;gap:10px;margin:7px 0">
        <span style="flex:1">${esc(r.name)}</span>
        <span style="color:var(--muted);font-variant-numeric:tabular-nums">${fmt(r.count)}</span>
        <span class="bar" style="width:110px"><i style="width:${(r.count / max) * 100}%"></i></span>
      </div>`).join('')}</div>`;
}

function renderGraphCard(d, w) {
  const labels = (d.labels || []).map((l) =>
    `<button class="tpill on" data-label="${esc(l.label)}" style="--pc:${labelColor(l.label)}"><b>${l.c}</b><span class="sep">/</span><b>${l.c}</b>&nbsp;${esc(l.label)}</button>`).join('');
  return `<h2>${esc(w.title)}<span class="count">${fmt(d.nodes)} nodes · ${fmt(d.edges)} edges · ${fmt(d.orphans)} orphan</span></h2>
    <div class="graph-toolbar">
      <input type="search" id="g-search" placeholder="Search nodes (title, body, id)…">
      <input type="text" id="g-cypher" placeholder='MATCH (a:Memory)-[:LINKS_TO]->(b) RETURN a,b'>
      <button class="btn" id="g-run">Run query</button>
      <button class="btn" id="g-new">+ Node</button>
      <button class="btn" id="g-link">+ Link</button>
      <button class="btn" id="g-reset">Reset</button>
    </div>
    <!-- Inline, because the embedded pane this often runs in has no
         window.prompt(): a prompt-based flow throws there. -->
    <div class="graph-toolbar makerow" id="g-make" hidden>
      <input type="text" id="mk-title" placeholder="name">
      <input type="text" id="mk-label" placeholder="label (Note)">
      <button class="btn primary" id="mk-go">Create node</button>
      <button class="btn" id="mk-cancel">Cancel</button>
    </div>
    <div class="graph-toolbar makerow" id="g-linkrow" hidden>
      <input type="text" id="lk-to" placeholder="link to node id">
      <input type="text" id="lk-type" placeholder="LINKS_TO">
      <button class="btn primary" id="lk-go">Create link</button>
      <button class="btn" id="lk-cancel">Cancel</button>
    </div>
    <div class="legend">${labels}</div>
    <div class="graph-wrap">
      <canvas id="graph"></canvas>
      <div class="inspector" id="inspector"><button class="close" id="insp-close">×</button><div id="insp-body"></div></div>
    </div>`;
}

// ------------------------------------------------------------------ force graph

let sim = { nodes: [], edges: [], byId: new Map(), raf: null, alpha: 1 };
let view = { x: 0, y: 0, k: 1 };
let hidden = new Set();
let highlight = new Set();
let selected = null;
let hover = null;
let drag = null;
let panning = null;

function initSim() {
  const canvas = $('#graph');
  const seed = { w: (canvas?.clientWidth || 900) * 0.8, h: (canvas?.clientHeight || 500) * 0.8 };
  const nodes = GRAPH.nodes.map((n) => ({
    ...n,
    // A node the person dragged keeps the place they put it, on every client.
    x: n.props?.pinX ?? (Math.random() - 0.5) * seed.w,
    y: n.props?.pinY ?? (Math.random() - 0.5) * seed.h,
    pinned: n.props?.pinX !== undefined && n.props?.pinY !== undefined,
    vx: 0, vy: 0,
    r: Math.min(14, 4 + Math.sqrt(n.degree || 0) * 2.2),
    color: labelColor(primaryLabel(n)),
    label: n.props?.title || n.id,
  }));
  sim.byId = new Map(nodes.map((n) => [n.id, n]));
  sim.nodes = nodes;
  sim.edges = GRAPH.edges.filter((e) => sim.byId.has(e.src) && sim.byId.has(e.dst));
  sim.alpha = 1;
  view = { x: 0, y: 0, k: 1 };
  tick();
}

function visibleNodes() { return sim.nodes.filter((n) => !hidden.has(primaryLabel(n))); }

/**
 * The ideal distance between two nodes, Fruchterman-Reingold's `k`: spread the
 * nodes over the canvas we actually have rather than over fixed constants. A
 * small graph on a wide canvas used to collapse into a blob in the middle,
 * because the spring length and repulsion ignored both the area and the count.
 */
function idealDistance(n) {
  const canvas = $('#graph');
  const w = canvas?.clientWidth || 900;
  const h = canvas?.clientHeight || 500;
  // 0.55 keeps a margin so labels near the edge stay inside the canvas.
  return Math.max(45, Math.min(190, 0.55 * Math.sqrt((w * h) / Math.max(1, n))));
}

function step() {
  const nodes = visibleNodes();
  const n = nodes.length;
  if (!n) return;
  const k = idealDistance(n);
  // Repulsion falls off as 1/d², so it scales with k² to stay in balance with
  // the springs; the cap keeps very large graphs from going slack.
  const repel = (n > 400 ? 0.5 : 1) * k * k * 0.5;
  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < n; j++) {
      const b = nodes[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.01; }
      // Ignore pairs far enough apart to contribute almost nothing.
      if (d2 > (6 * k) * (6 * k)) continue;
      const f = repel / d2;
      const d = Math.sqrt(d2);
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
    }
  }
  for (const e of sim.edges) {
    const a = sim.byId.get(e.src), b = sim.byId.get(e.dst);
    if (!a || !b || hidden.has(primaryLabel(a)) || hidden.has(primaryLabel(b))) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 0.01;
    const f = (d - k) * 0.012;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
  }
  for (const node of nodes) {
    if (node.pinned) { node.vx = node.vy = 0; continue; }
    // Pull toward the origin, weak enough that it centres the drawing
    // without undoing the spread k just bought us.
    const pull = 0.16 / k;
    node.vx -= node.x * pull;
    node.vy -= node.y * pull;
    if (drag && drag.node === node) { node.vx = node.vy = 0; continue; }
    node.vx *= 0.86; node.vy *= 0.86;
    node.x += node.vx * sim.alpha;
    node.y += node.vy * sim.alpha;
  }
  sim.alpha = Math.max(0.18, sim.alpha * 0.995);
}

function draw() {
  const canvas = $('#graph');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w / 2 + view.x, h / 2 + view.y);
  ctx.scale(view.k, view.k);

  const dim = highlight.size > 0;
  const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#000';
  const line = getComputedStyle(document.documentElement).getPropertyValue('--line').trim() || 'rgba(0,0,0,.1)';

  ctx.lineWidth = 1 / view.k;
  for (const e of sim.edges) {
    const a = sim.byId.get(e.src), b = sim.byId.get(e.dst);
    if (!a || !b || hidden.has(primaryLabel(a)) || hidden.has(primaryLabel(b))) continue;
    const lit = !dim || highlight.has(a.id) || highlight.has(b.id);
    const near = selected && (a.id === selected || b.id === selected);
    ctx.strokeStyle = near ? a.color : line;
    ctx.globalAlpha = near ? 0.9 : lit ? 0.5 : 0.08;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.globalAlpha = 1;

  for (const node of visibleNodes()) {
    const lit = !dim || highlight.has(node.id);
    const isSel = node.id === selected, isHov = node === hover;
    ctx.globalAlpha = lit ? 1 : 0.16;
    ctx.beginPath();
    ctx.arc(node.x, node.y, node.r + (isSel || isHov ? 2.5 : 0), 0, Math.PI * 2);
    ctx.fillStyle = node.color;
    ctx.fill();
    if (isSel || isHov) { ctx.lineWidth = 2 / view.k; ctx.strokeStyle = ink; ctx.globalAlpha = lit ? 0.85 : 0.2; ctx.stroke(); }
    const showLabel = isSel || isHov || (highlight.has(node.id) && highlight.size < 40) || (node.degree >= 4 && view.k > 0.75);
    if (showLabel) {
      ctx.globalAlpha = lit ? 1 : 0.25;
      ctx.fillStyle = ink;
      ctx.font = `${Math.max(9, 11 / view.k)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(String(node.label).slice(0, 34), node.x, node.y - node.r - 5 / view.k);
    }
  }
  ctx.restore();
}

function tick() {
  cancelAnimationFrame(sim.raf);
  const loop = () => { step(); draw(); sim.raf = requestAnimationFrame(loop); };
  sim.raf = requestAnimationFrame(loop);
}

function toLocal(evt) {
  const canvas = $('#graph');
  const rect = canvas.getBoundingClientRect();
  return {
    x: (evt.clientX - rect.left - rect.width / 2 - view.x) / view.k,
    y: (evt.clientY - rect.top - rect.height / 2 - view.y) / view.k,
  };
}

function hitTest(pt) {
  let best = null, bestD = Infinity;
  for (const n of visibleNodes()) {
    const d = Math.hypot(n.x - pt.x, n.y - pt.y);
    if (d < Math.max(n.r + 4, 9) && d < bestD) { best = n; bestD = d; }
  }
  return best;
}

function wireGraphCard() {
  const canvas = $('#graph');
  if (!canvas) return;
  if (sim.nodes.length) tick();

  canvas.onmousedown = (e) => {
    const pt = toLocal(e);
    const node = hitTest(pt);
    if (node) { drag = { node }; sim.alpha = Math.max(sim.alpha, 0.5); }
    else { panning = { x: e.clientX - view.x, y: e.clientY - view.y }; canvas.classList.add('dragging'); }
  };
  canvas.onmousemove = (e) => {
    const pt = toLocal(e);
    if (drag) { drag.node.x = pt.x; drag.node.y = pt.y; return; }
    if (panning) { view.x = e.clientX - panning.x; view.y = e.clientY - panning.y; return; }
    const was = hover;
    hover = hitTest(pt);
    canvas.style.cursor = hover ? 'pointer' : 'grab';
    if (was !== hover) draw();
  };
  const release = async () => {
    const dropped = drag?.node;
    drag = null; panning = null;
    canvas.classList.remove('dragging');
    if (dropped) {
      dropped.pinned = true;
      try {
        await api('/api/position', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: dropped.id, x: Math.round(dropped.x), y: Math.round(dropped.y) }),
        });
        $('#stamp').textContent = `pinned ${dropped.label || dropped.id}`;
      } catch { $('#stamp').textContent = 'could not save that position'; }
    }
  };
  canvas.onmouseup = release;
  canvas.onmouseleave = () => { release(); hover = null; };
  canvas.onclick = (e) => {
    const node = hitTest(toLocal(e));
    if (node) selectNode(node.id); else closeInspector();
  };
  canvas.onwheel = (e) => {
    e.preventDefault();
    const k = Math.min(3.5, Math.max(0.25, view.k * (e.deltaY < 0 ? 1.12 : 0.89)));
    view.k = k;
  };
  canvas.ondblclick = async (e) => {
    const node = hitTest(toLocal(e));
    if (!node) { view = { x: 0, y: 0, k: 1 }; sim.alpha = 1; return; }
    // Expand: pull in everything one hop out, the way a graph browser does.
    try {
      const { neighbors } = await api(`/api/expand?id=${encodeURIComponent(node.id)}`);
      let added = 0;
      for (const n of neighbors) {
        const other = n.other;
        if (!other || sim.byId.has(other.id)) continue;
        const seed = {
          ...other,
          degree: 1,
          x: node.x + (Math.random() - 0.5) * 120,
          y: node.y + (Math.random() - 0.5) * 120,
          vx: 0, vy: 0, pinned: false,
          r: 6,
          color: labelColor(primaryLabel(other)),
          label: other.props?.title || other.id,
        };
        sim.nodes.push(seed);
        sim.byId.set(other.id, seed);
        added += 1;
      }
      for (const n of neighbors) {
        const other = n.other;
        if (!other) continue;
        const pair = n.dir === 'out' ? { src: node.id, dst: other.id } : { src: other.id, dst: node.id };
        if (!sim.edges.some((x) => x.src === pair.src && x.dst === pair.dst && x.type === n.type)) {
          sim.edges.push({ ...pair, type: n.type });
        }
      }
      sim.alpha = 1;
      $('#stamp').textContent = added ? `expanded ${added} more` : 'nothing new to expand';
    } catch (err) { $('#stamp').textContent = `expand failed: ${err.message}`; }
  };

  $('#g-search').oninput = (e) => {
    const q = e.target.value.trim().toLowerCase();
    highlight = new Set();
    if (q.length >= 2) {
      for (const n of sim.nodes) {
        const hay = `${n.id} ${n.props?.title || ''} ${n.props?.description || ''} ${n.props?.body || ''}`.toLowerCase();
        if (hay.includes(q)) highlight.add(n.id);
      }
    }
    draw();
  };
  $('#g-run').onclick = runCypher;
  const showRow = (which) => {
    $('#g-make').hidden = which !== 'node';
    $('#g-linkrow').hidden = which !== 'link';
    if (which === 'node') $('#mk-title').focus();
    if (which === 'link') $('#lk-to').focus();
  };

  $('#g-new').onclick = () => showRow($('#g-make').hidden ? 'node' : null);
  $('#mk-cancel').onclick = () => showRow(null);
  $('#mk-go').onclick = async () => {
    const title = $('#mk-title').value.trim();
    if (!title) { $('#stamp').textContent = 'a name is required'; return; }
    const label = ($('#mk-label').value.trim() || 'Note').replace(/\s+/g, '');
    const id = `${label.toLowerCase()}:${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    try {
      await api('/api/node', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, labels: [label], props: { title } }),
      });
      $('#mk-title').value = '';
      showRow(null);
      await refresh({ graph: true });
      await selectNode(id);
      $('#stamp').textContent = `created ${id}`;
    } catch (err) { $('#stamp').textContent = `create failed: ${err.message}`; }
  };

  $('#g-link').onclick = () => {
    if (!selected) { $('#stamp').textContent = 'select a node first, then press + Link'; return; }
    showRow($('#g-linkrow').hidden ? 'link' : null);
  };
  $('#lk-cancel').onclick = () => showRow(null);
  $('#lk-go').onclick = async () => {
    const to = $('#lk-to').value.trim();
    if (!selected || !to) { $('#stamp').textContent = 'pick a node and a target id'; return; }
    const type = ($('#lk-type').value.trim() || 'LINKS_TO').toUpperCase().replace(/\s+/g, '_');
    try {
      await api('/api/edge', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ src: selected, dst: to, type }),
      });
      $('#lk-to').value = '';
      showRow(null);
      await refresh({ graph: true });
      await selectNode(selected);
      $('#stamp').textContent = `linked -[:${type}]-> ${to}`;
    } catch (err) { $('#stamp').textContent = `link failed: ${err.message}`; }
  };

  $('#g-reset').onclick = () => {
    highlight = new Set(); hidden = new Set(); selected = null;
    $('#g-search').value = ''; $('#g-cypher').value = '';
    document.querySelectorAll('[data-label]').forEach((b) => b.classList.add('on'));
    closeInspector(); view = { x: 0, y: 0, k: 1 }; sim.alpha = 1;
  };
  $('#insp-close').onclick = closeInspector;

  document.querySelectorAll('[data-label]').forEach((btn) => {
    btn.onclick = () => {
      const label = btn.dataset.label;
      if (hidden.has(label)) { hidden.delete(label); btn.classList.add('on'); }
      else { hidden.add(label); btn.classList.remove('on'); }
      sim.alpha = Math.max(sim.alpha, 0.5);
    };
  });

  document.querySelectorAll('[data-focus]').forEach((btn) => {
    btn.onclick = () => selectNode(btn.dataset.focus);
  });
}

async function runCypher() {
  const q = $('#g-cypher').value.trim();
  if (!q) return;
  try {
    const { rows, error } = await api('/api/query', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }),
    });
    if (error) { $('#stamp').textContent = `query error: ${error}`; return; }
    highlight = new Set();
    for (const row of rows) for (const v of Object.values(row)) if (v && v.id) highlight.add(v.id);
    $('#stamp').textContent = `query matched ${highlight.size} node${highlight.size === 1 ? '' : 's'}`;
    draw();
  } catch (err) { $('#stamp').textContent = `query failed: ${err.message}`; }
}

async function patchNode(id, patch) {
  try {
    await api('/api/node', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, ...patch }),
    });
    $('#stamp').textContent = 'saved';
    await refresh({ graph: true });
    await selectNode(id);
  } catch (err) { $('#stamp').textContent = `save failed: ${err.message}`; }
}

async function selectNode(id) {
  selected = id;
  const node = sim.byId.get(id);
  if (node) { view.x = -node.x * view.k; view.y = -node.y * view.k; }
  const insp = $('#inspector');
  if (!insp) return;
  insp.classList.add('open');
  $('#insp-body').innerHTML = '<div class="empty">loading…</div>';
  try {
    const { node: full, neighbors } = await api(`/api/node?id=${encodeURIComponent(id)}`);
    if (!full) { $('#insp-body').innerHTML = '<div class="empty">Node not found.</div>'; return; }
    const p = full.props || {};
    const snippet = (p.body || p.description || '').slice(0, 400);
    $('#insp-body').innerHTML = `
      <h3 contenteditable="true" id="insp-title" spellcheck="false">${esc(p.title || full.id)}</h3>
      <div class="meta">${(full.labels || []).map((l) => `<span class="chip" style="background:color-mix(in oklab, ${labelColor(l)} 20%, transparent);color:${labelColor(l)}">${esc(l)}</span>`).join(' ')}</div>
      <div class="meta"><code>${esc(full.id)}</code></div>
      ${p.path ? `<div class="meta">${esc(p.path)}</div>` : ''}
      <div class="editrow">
        <input id="insp-key" placeholder="property" spellcheck="false">
        <input id="insp-val" placeholder="value" spellcheck="false">
        <button class="btn" id="insp-set">Set</button>
      </div>
      <div class="editrow">
        <button class="btn" id="insp-unpin">Unpin</button>
        <button class="btn danger" id="insp-del">Delete node</button>
      </div>
      ${snippet ? `<div class="snippet">${esc(snippet)}</div>` : ''}
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-top:10px">${neighbors.length} connection${neighbors.length === 1 ? '' : 's'}</div>
      <ul>${neighbors.slice(0, 40).map((n) => `
        <li><span style="color:var(--muted);font-size:11px">${n.dir === 'out' ? '→' : '←'} ${esc(n.type)}</span><br>
          <button class="link-btn" data-focus="${esc(n.other?.id)}">${esc(n.other?.props?.title || n.other?.id)}</button>
          <button class="link-btn danger" data-unlink="${esc(n.other?.id)}" data-type="${esc(n.type)}" data-dir="${esc(n.dir)}">unlink</button></li>`).join('')}</ul>`;

    // rename on blur
    const titleEl = document.getElementById('insp-title');
    titleEl.onblur = async () => {
      const next = titleEl.textContent.trim();
      if (!next || next === (p.title || full.id)) return;
      await patchNode(full.id, { props: { title: next } });
    };
    titleEl.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); titleEl.blur(); } };

    document.getElementById('insp-set').onclick = async () => {
      const k = document.getElementById('insp-key').value.trim();
      const v = document.getElementById('insp-val').value;
      if (!k) return;
      await patchNode(full.id, { props: { [k]: v } });
    };
    document.getElementById('insp-unpin').onclick = async () => {
      await api('/api/position', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: full.id, x: null, y: null }),
      });
      await refresh({ graph: true });
    };
    const delBtn = document.getElementById('insp-del');
    delBtn.onclick = async () => {
      // Two presses instead of confirm(), which this pane does not support.
      if (delBtn.dataset.armed !== '1') {
        delBtn.dataset.armed = '1';
        delBtn.textContent = 'Press again to delete';
        setTimeout(() => {
          if (!delBtn.isConnected) return;
          delBtn.dataset.armed = '0';
          delBtn.textContent = 'Delete node';
        }, 4000);
        return;
      }
      await api('/api/node', {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: full.id }),
      });
      closeInspector();
      await refresh({ graph: true });
    };
    $('#insp-body').querySelectorAll('[data-unlink]').forEach((b) => {
      b.onclick = async () => {
        const other = b.dataset.unlink;
        const pair = b.dataset.dir === 'out' ? { src: full.id, dst: other } : { src: other, dst: full.id };
        await api('/api/edge', {
          method: 'DELETE', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...pair, type: b.dataset.type }),
        });
        await selectNode(full.id);
        await refresh({ graph: true });
      };
    });
    $('#insp-body').querySelectorAll('[data-focus]').forEach((b) => { b.onclick = () => selectNode(b.dataset.focus); });
  } catch (err) {
    $('#insp-body').innerHTML = `<div class="err">${esc(err.message)}</div>`;
  }
  draw();
}

function closeInspector() {
  selected = null;
  $('#inspector')?.classList.remove('open');
  draw();
}

// -------------------------------------------------------------------- customize

function openDrawer() {
  $('#f-title').value = CONFIG.title || '';
  $('#f-accent').value = CONFIG.accent || '';
  $('#f-theme').value = CONFIG.theme || 'auto';
  $('#f-refresh').value = CONFIG.refreshSeconds ?? 10;
  const list = $('#wlist');
  list.innerHTML = CONFIG.widgets.map((w, i) => `
    <div class="wrow" data-i="${i}">
      <span class="grab">${i + 1}</span>
      <input type="checkbox" ${w.enabled ? 'checked' : ''} data-k="enabled">
      <input type="text" class="nm" value="${esc(w.title)}" data-k="title">
      <select data-k="span"><option value="half" ${w.span !== 'full' ? 'selected' : ''}>½</option><option value="full" ${w.span === 'full' ? 'selected' : ''}>full</option></select>
      <button class="mv" data-mv="up">↑</button><button class="mv" data-mv="down">↓</button>
    </div>`).join('');
  list.querySelectorAll('[data-mv]').forEach((btn) => {
    btn.onclick = () => {
      const row = btn.closest('.wrow');
      const i = Number(row.dataset.i);
      const j = btn.dataset.mv === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= CONFIG.widgets.length) return;
      readDrawer();
      [CONFIG.widgets[i], CONFIG.widgets[j]] = [CONFIG.widgets[j], CONFIG.widgets[i]];
      openDrawer();
    };
  });
  $('#drawer').classList.add('open');
  $('#scrim').classList.add('open');
}

function readDrawer() {
  CONFIG.title = $('#f-title').value || 'Second Brain';
  CONFIG.accent = $('#f-accent').value || '#7c6cf0';
  CONFIG.theme = $('#f-theme').value;
  CONFIG.refreshSeconds = Number($('#f-refresh').value || 0);
  $('#wlist').querySelectorAll('.wrow').forEach((row) => {
    const w = CONFIG.widgets[Number(row.dataset.i)];
    w.enabled = row.querySelector('[data-k=enabled]').checked;
    w.title = row.querySelector('[data-k=title]').value;
    w.span = row.querySelector('[data-k=span]').value;
  });
}

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#scrim').classList.remove('open');
}

// -------------------------------------------------------------------- bootstrap

$('#btn-customize').onclick = openDrawer;
$('#btn-close').onclick = () => { closeDrawer(); refresh().catch(console.error); };
$('#scrim').onclick = () => { closeDrawer(); refresh().catch(console.error); };
$('#btn-save').onclick = async () => {
  readDrawer();
  await api('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(CONFIG) });
  closeDrawer();
  await refresh();
};
$('#btn-theme').onclick = async () => {
  const order = ['auto', 'dark', 'light'];
  CONFIG.theme = order[(order.indexOf(CONFIG.theme || 'auto') + 1) % 3];
  applyTheme();
  await api('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(CONFIG) });
};
$('#btn-ingest').onclick = async (e) => {
  e.target.disabled = true; e.target.textContent = 'Scanning…';
  try { await api('/api/ingest', { method: 'POST' }); await refresh({ graph: true }); }
  finally { e.target.disabled = false; e.target.textContent = 'Re-scan brain'; }
};
window.addEventListener('resize', draw);

refresh({ graph: true }).catch((err) => { $('#stamp').textContent = `failed: ${err.message}`; });
