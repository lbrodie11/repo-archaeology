import type { MapData } from '../commands/map.js';

/**
 * Serializes data for embedding inside a <script> element. Escaping `<` keeps a
 * commit subject such as "</script><script>…" from ending the element early.
 */
export function embedJson(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/**
 * A single self-contained HTML file: no network requests, no external fonts or
 * libraries, so it works offline and can be attached to an issue or shared as-is.
 * Visual idea: a cyanotype survey sheet of the dig site, with ghost wires marked
 * in the fluorescent pink flagging tape archaeologists use to mark finds.
 */
export function renderMapHtml(data: MapData): string {
  const title = `Ghost wires in ${data.repoName}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="app">
  <header class="bar">
    <div class="heading">
      <h1>${escapeHtml(title)}</h1>
      <p id="summary" class="summary"></p>
    </div>
    <div class="controls">
      <label class="search"><span class="visually-hidden">Find a file</span>
        <input id="search" type="search" placeholder="Find a file  ( / )" autocomplete="off" spellcheck="false">
      </label>
      <div id="toggles" class="toggles" role="group" aria-label="Relationship types"></div>
    </div>
  </header>
  <main class="stage">
    <canvas id="map" role="img" aria-label="Map of files that change together. The panel lists the same relationships as text."></canvas>
    <div id="tooltip" class="tooltip" hidden></div>
    <p class="hint">Drag to pan, scroll to zoom, drag a file to pin it.</p>
  </main>
  <aside id="panel" class="panel" aria-live="polite"></aside>
</div>
<script type="application/json" id="ra-data">${embedJson(data)}</script>
<script>${CLIENT}</script>
</body>
</html>
`;
}

const STYLES = String.raw`
:root {
  --ground: #13304f;
  --ground-deep: #0e2540;
  --chalk: #e8eef5;
  --chalk-faded: #9fb4cc;
  --grid: rgba(159, 180, 204, 0.08);
  --tape: #ff4f9a;
  --ochre: #e3b65b;
  --lichen: #7fd1b0;
  --import: rgba(232, 238, 245, 0.55);
  --condensed: "Avenir Next Condensed", "Roboto Condensed", "Arial Narrow", "Helvetica Neue", sans-serif;
  --text: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --code: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--ground); color: var(--chalk); font: 15px/1.5 var(--text); }
button, input { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--tape); outline-offset: 2px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

.app { display: grid; grid-template-columns: minmax(0, 1fr) 380px; grid-template-rows: auto minmax(0, 1fr); height: 100vh; }
.bar { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 12px 32px; align-items: flex-end; justify-content: space-between; padding: 18px 24px 14px; border-bottom: 1px solid rgba(159, 180, 204, 0.18); }
h1 { margin: 0; font: 600 30px/1.1 var(--condensed); letter-spacing: 0.01em; font-stretch: condensed; }
.summary { margin: 4px 0 0; color: var(--chalk-faded); font-size: 14px; max-width: 70ch; }
.controls { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; }
.search input { width: 240px; padding: 7px 10px; border: 1px solid rgba(159, 180, 204, 0.35); border-radius: 6px; background: var(--ground-deep); }
.search input::placeholder { color: var(--chalk-faded); }
.toggles { display: flex; flex-wrap: wrap; gap: 6px; }
.toggle { display: inline-flex; align-items: center; gap: 8px; padding: 5px 10px; border: 1px solid rgba(159, 180, 204, 0.3); border-radius: 999px; background: transparent; cursor: pointer; font-size: 13px; }
.toggle[aria-pressed="false"] { opacity: 0.45; }
.toggle .count { color: var(--chalk-faded); font-variant-numeric: tabular-nums; }
.swatch { width: 22px; height: 0; border-top: 2px solid; }
.swatch.ghost { border-top: 2px dashed var(--tape); filter: drop-shadow(0 0 3px var(--tape)); }
.swatch.unknown { border-top: 2px dotted var(--ochre); }
.swatch.direct { border-top-color: var(--import); }
.swatch.test { border-top-color: var(--lichen); }

.stage { position: relative; min-height: 0; overflow: hidden; }
canvas { display: block; width: 100%; height: 100%; cursor: grab; touch-action: none; }
canvas.dragging { cursor: grabbing; }
canvas.pointing { cursor: pointer; }
.hint { position: absolute; left: 16px; bottom: 10px; margin: 0; font-size: 12px; color: var(--chalk-faded); pointer-events: none; }
.tooltip { position: absolute; pointer-events: none; max-width: 420px; padding: 6px 9px; border-radius: 6px; background: var(--ground-deep); border: 1px solid rgba(159, 180, 204, 0.35); font-size: 13px; }
.tooltip code { font-family: var(--code); font-size: 12.5px; word-break: break-all; }

.panel { overflow-y: auto; padding: 20px 22px 32px; background: var(--ground-deep); border-left: 1px solid rgba(159, 180, 204, 0.18); }
.panel h2 { margin: 0 0 6px; font: 600 21px/1.2 var(--condensed); font-stretch: condensed; }
.panel p { margin: 0 0 12px; color: var(--chalk-faded); }
.panel .path { font-family: var(--code); font-size: 13px; word-break: break-all; color: var(--chalk); }
.panel ol, .panel ul { list-style: none; margin: 0; padding: 0; }
.rel { padding: 12px 0; border-top: 1px solid rgba(159, 180, 204, 0.14); }
.rel-head { display: flex; gap: 10px; align-items: baseline; }
.rel-head .swatch { flex: none; transform: translateY(-4px); }
.file-link { padding: 0; border: 0; background: none; text-align: left; cursor: pointer; font-family: var(--code); font-size: 13px; word-break: break-all; text-decoration: underline; text-decoration-color: rgba(159, 180, 204, 0.4); text-underline-offset: 3px; }
.file-link:hover { text-decoration-color: var(--tape); }
.pair { display: grid; gap: 2px; }
.pair .file-link + .file-link::before { content: "and "; font-family: var(--text); color: var(--chalk-faded); text-decoration: none; display: inline-block; margin-right: 4px; }
.rel-body { margin: 4px 0 0 32px; font-size: 13.5px; color: var(--chalk-faded); }
.evidence { margin: 6px 0 0 32px; font-size: 12.5px; color: var(--chalk-faded); }
.evidence li { display: grid; grid-template-columns: auto 1fr; gap: 0 8px; padding: 2px 0; }
.evidence .hash { font-family: var(--code); color: var(--chalk); opacity: 0.8; }
.clear { margin-top: 18px; padding: 6px 12px; border: 1px solid rgba(159, 180, 204, 0.35); border-radius: 6px; background: transparent; cursor: pointer; }
.empty { padding: 40px 24px; max-width: 46ch; }

@media (max-width: 860px) {
  .app { grid-template-columns: 1fr; grid-template-rows: auto 62vh auto; height: auto; }
  .panel { border-left: 0; border-top: 1px solid rgba(159, 180, 204, 0.18); }
  .search input { width: 100%; }
  .controls, .search { width: 100%; }
}
`;

const CLIENT = String.raw`
(function () {
  'use strict';
  var data = JSON.parse(document.getElementById('ra-data').textContent);
  var KINDS = {
    ghost: { label: 'Ghost wires', color: '#ff4f9a' },
    unknown: { label: 'Unchecked', color: '#e3b65b' },
    direct: { label: 'Import links', color: 'rgba(232, 238, 245, 0.55)' },
    test: { label: 'Test links', color: '#7fd1b0' }
  };
  var ORDER = ['ghost', 'unknown', 'direct', 'test'];
  var visible = { ghost: true, unknown: true, direct: true, test: false };
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var canvas = document.getElementById('map');
  var ctx = canvas.getContext('2d');
  var tooltip = document.getElementById('tooltip');
  var panel = document.getElementById('panel');
  var search = document.getElementById('search');

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function pct(x) { return Math.round(x * 100) + '%'; }
  function base(p) { var i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); }
  function plural(n, w) { return n.toLocaleString('en-US') + ' ' + w + (n === 1 ? '' : 's'); }

  // Deterministic layout: the same repo produces the same picture every time.
  var seed = 7;
  for (var s = 0; s < data.repoName.length; s++) seed = (seed * 31 + data.repoName.charCodeAt(s)) | 0;
  function random() {
    seed = (seed + 0x6d2b79f5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function hashHue(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = (h * 33 + str.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  // ---- data ----------------------------------------------------------------
  var dirs = {};
  var dirList = [];
  var nodes = data.nodes.map(function (n, i) {
    if (!dirs[n.dir]) { dirs[n.dir] = { name: n.dir, x: 0, y: 0, count: 0 }; dirList.push(dirs[n.dir]); }
    return {
      i: i, path: n.path, dir: n.dir, changes: n.changes, author: n.topAuthor, share: n.topAuthorShare,
      r: 4 + Math.min(14, Math.sqrt(n.changes) * 1.25),
      color: 'hsl(' + hashHue(n.dir) + ', 46%, 74%)',
      x: 0, y: 0, vx: 0, vy: 0, pinned: false, edges: []
    };
  });
  var edges = data.edges.map(function (e) {
    var edge = { s: nodes[e.source], t: nodes[e.target], d: e };
    edge.s.edges.push(edge);
    edge.t.edges.push(edge);
    return edge;
  });
  dirList.forEach(function (d, i) {
    var angle = (i / Math.max(1, dirList.length)) * Math.PI * 2;
    var radius = 120 + 40 * Math.sqrt(dirList.length);
    d.x = Math.cos(angle) * radius;
    d.y = Math.sin(angle) * radius;
  });
  nodes.forEach(function (n) {
    var d = dirs[n.dir];
    n.x = d.x + (random() - 0.5) * 80;
    n.y = d.y + (random() - 0.5) * 80;
  });

  // ---- header --------------------------------------------------------------
  var m = data.meta;
  var span = m.oldestCommit && m.newestCommit ? ' between ' + m.oldestCommit + ' and ' + m.newestCommit : '';
  document.getElementById('summary').textContent =
    'Built from ' + plural(m.commitsAnalyzed, 'commit') + span + '. Showing the ' + plural(edges.length, 'strongest relationship') +
    ' (each at least ' + m.settings.minShared + ' shared commits and ' + pct(m.settings.minConfidence) + ' confidence).';

  var toggles = document.getElementById('toggles');
  ORDER.forEach(function (kind) {
    var shown = edges.filter(function (e) { return e.d.relationship === kind; }).length;
    if (shown === 0) return;
    var b = el('button', 'toggle');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(visible[kind]));
    b.appendChild(el('span', 'swatch ' + kind));
    b.appendChild(el('span', '', KINDS[kind].label));
    b.appendChild(el('span', 'count', String(shown)));
    b.addEventListener('click', function () {
      visible[kind] = !visible[kind];
      b.setAttribute('aria-pressed', String(visible[kind]));
      if (selectedEdge && !visible[selectedEdge.d.relationship]) selectedEdge = null;
      renderPanel();
      requestDraw();
    });
    toggles.appendChild(b);
  });

  // ---- layout simulation ---------------------------------------------------
  var alpha = 1;
  function tick() {
    var i, j, a, b, dx, dy, d2, f;
    for (i = 0; i < nodes.length; i++) {
      a = nodes[i];
      for (j = i + 1; j < nodes.length; j++) {
        b = nodes[j];
        dx = b.x - a.x; dy = b.y - a.y;
        d2 = dx * dx + dy * dy;
        if (d2 > 90000) continue;
        if (d2 < 1) { dx = random() - 0.5; dy = random() - 0.5; d2 = 1; }
        f = (1400 * alpha) / d2;
        a.vx -= dx * f; a.vy -= dy * f;
        b.vx += dx * f; b.vy += dy * f;
      }
    }
    edges.forEach(function (e) {
      dx = e.t.x - e.s.x; dy = e.t.y - e.s.y;
      var d = Math.sqrt(dx * dx + dy * dy) || 1;
      var strength = Math.max(e.d.confidence, e.d.reverseConfidence);
      var rest = 50 + (1 - strength) * 90 + e.s.r + e.t.r;
      f = ((d - rest) / d) * 0.05 * alpha * (0.4 + strength);
      e.s.vx += dx * f; e.s.vy += dy * f;
      e.t.vx -= dx * f; e.t.vy -= dy * f;
    });
    dirList.forEach(function (d) { d.cx = 0; d.cy = 0; d.count = 0; });
    nodes.forEach(function (n) { var d = dirs[n.dir]; d.cx += n.x; d.cy += n.y; d.count++; });
    nodes.forEach(function (n) {
      var d = dirs[n.dir];
      n.vx += (d.cx / d.count - n.x) * 0.012 * alpha - n.x * 0.012 * alpha;
      n.vy += (d.cy / d.count - n.y) * 0.012 * alpha - n.y * 0.012 * alpha;
      if (n.pinned) { n.vx = 0; n.vy = 0; return; }
      n.vx *= 0.62; n.vy *= 0.62;
      n.x += n.vx; n.y += n.vy;
    });
    alpha *= 0.985;
  }

  // ---- camera --------------------------------------------------------------
  var cam = { x: 0, y: 0, scale: 1 };
  var size = { w: 0, h: 0, dpr: 1 };
  function resize() {
    var rect = canvas.getBoundingClientRect();
    size.dpr = window.devicePixelRatio || 1;
    size.w = rect.width; size.h = rect.height;
    canvas.width = Math.round(rect.width * size.dpr);
    canvas.height = Math.round(rect.height * size.dpr);
    requestDraw();
  }
  function bounds(list) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    list.forEach(function (n) {
      minX = Math.min(minX, n.x - n.r); maxX = Math.max(maxX, n.x + n.r);
      minY = Math.min(minY, n.y - n.r); maxY = Math.max(maxY, n.y + n.r);
    });
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, scale: Math.max(0.2, Math.min(2.2, Math.min(size.w / (maxX - minX + 160), size.h / (maxY - minY + 160)))) };
  }
  function fit() {
    var list = nodes.filter(isActive);
    if (list.length === 0) return;
    var b = bounds(list);
    cam.x = b.x; cam.y = b.y; cam.scale = b.scale;
  }
  // Smoothly frames a set of files (used when one is selected).
  var flight = null;
  function flyTo(list) {
    if (list.length === 0) return;
    var b = bounds(list);
    b.scale = Math.min(b.scale, 2);
    if (reduceMotion) { cam.x = b.x; cam.y = b.y; cam.scale = b.scale; requestDraw(); return; }
    flight = { from: { x: cam.x, y: cam.y, scale: cam.scale }, to: b, start: performance.now() };
    requestDraw();
  }
  function stepFlight(now) {
    if (!flight) return false;
    var t = Math.min(1, (now - flight.start) / 450);
    var e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    cam.x = flight.from.x + (flight.to.x - flight.from.x) * e;
    cam.y = flight.from.y + (flight.to.y - flight.from.y) * e;
    cam.scale = flight.from.scale + (flight.to.scale - flight.from.scale) * e;
    if (t >= 1) flight = null;
    return true;
  }
  var userMoved = false;
  function toWorld(px, py) {
    return { x: (px - size.w / 2) / cam.scale + cam.x, y: (py - size.h / 2) / cam.scale + cam.y };
  }

  // ---- selection -----------------------------------------------------------
  var selectedNode = null, selectedEdge = null, hoverNode = null, matches = null;
  function isVisible(e) { return visible[e.d.relationship]; }
  function isActive(n) { return n.edges.some(isVisible); }
  function hasGhost(n) { return visible.ghost && n.edges.some(function (e) { return e.d.relationship === 'ghost'; }); }
  function focusEdge(e) {
    if (selectedEdge) return e === selectedEdge;
    if (selectedNode) return e.s === selectedNode || e.t === selectedNode;
    return true;
  }
  function focusNode(n) {
    if (selectedEdge) return n === selectedEdge.s || n === selectedEdge.t;
    if (selectedNode) return n === selectedNode || n.edges.some(function (e) { return isVisible(e) && (e.s === selectedNode || e.t === selectedNode); });
    if (matches) return matches.indexOf(n) >= 0;
    return true;
  }

  // ---- drawing -------------------------------------------------------------
  var dashPhase = 0, drawQueued = false;
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(frame);
  }
  function frame(now) {
    drawQueued = false;
    if (alpha > 0.02) {
      tick(); tick();
      if (alpha <= 0.02 && !userMoved && !selectedNode && !selectedEdge) fit();
    }
    var flying = stepFlight(now || performance.now());
    var marching = !reduceMotion && visible.ghost && edges.some(function (e) { return e.d.relationship === 'ghost'; });
    if (marching) dashPhase = (dashPhase + 0.35) % 1100;
    draw();
    if (alpha > 0.02 || marching || flying) requestDraw();
  }

  function draw() {
    var dpr = size.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#13304f';
    ctx.fillRect(0, 0, size.w, size.h);

    // survey grid in world space, so it moves with the map
    var step = 80 * cam.scale;
    if (step > 14) {
      var origin = { x: size.w / 2 - cam.x * cam.scale, y: size.h / 2 - cam.y * cam.scale };
      ctx.strokeStyle = 'rgba(159, 180, 204, 0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var gx = ((origin.x % step) + step) % step; gx < size.w; gx += step) { ctx.moveTo(Math.round(gx) + 0.5, 0); ctx.lineTo(Math.round(gx) + 0.5, size.h); }
      for (var gy = ((origin.y % step) + step) % step; gy < size.h; gy += step) { ctx.moveTo(0, Math.round(gy) + 0.5); ctx.lineTo(size.w, Math.round(gy) + 0.5); }
      ctx.stroke();
    }

    var k = cam.scale;
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (size.w / 2 - cam.x * k), dpr * (size.h / 2 - cam.y * k));

    ['test', 'direct', 'unknown', 'ghost'].forEach(function (kind) {
      if (!visible[kind]) return;
      edges.forEach(function (e) {
        if (e.d.relationship !== kind) return;
        var focused = focusEdge(e);
        ctx.globalAlpha = focused ? 1 : 0.07;
        ctx.strokeStyle = KINDS[kind].color;
        // Widths and dashes are in screen pixels, so zooming does not make lines bloated.
        ctx.lineWidth = (0.8 + Math.max(e.d.confidence, e.d.reverseConfidence) * 2.2) / k;
        ctx.setLineDash([]);
        ctx.shadowBlur = 0;
        if (kind === 'ghost') {
          ctx.setLineDash([7 / k, 6 / k]);
          ctx.lineDashOffset = -dashPhase / k;
          if (focused) { ctx.shadowColor = '#ff4f9a'; ctx.shadowBlur = 10 * dpr; }
        } else if (kind === 'unknown') {
          ctx.setLineDash([2 / k, 5 / k]);
        } else if (kind === 'test') {
          ctx.globalAlpha *= 0.7;
        }
        ctx.beginPath();
        ctx.moveTo(e.s.x, e.s.y);
        ctx.lineTo(e.t.x, e.t.y);
        ctx.stroke();
      });
    });
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;

    nodes.forEach(function (n) {
      if (!isActive(n)) return;
      var focused = focusNode(n);
      ctx.globalAlpha = focused ? 1 : 0.18;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = n.color;
      ctx.fill();
      ctx.lineWidth = Math.max(1 / k, 1.2);
      ctx.strokeStyle = n === selectedNode ? '#ff4f9a' : 'rgba(14, 37, 64, 0.9)';
      if (n === selectedNode) ctx.lineWidth = 3 / Math.sqrt(k);
      ctx.stroke();
    });

    ctx.globalAlpha = 1;
    ctx.font = (12 / k) + 'px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    nodes.forEach(function (n) {
      var overview = !selectedNode && !selectedEdge && !matches;
      var wanted = n === hoverNode || n === selectedNode || (matches && matches.indexOf(n) >= 0) ||
        ((selectedNode || selectedEdge) && focusNode(n)) || (overview && (n.r * k > 9 || (hasGhost(n) && k >= 0.5)));
      if (!wanted || !isActive(n)) return;
      var label = base(n.path);
      var x = n.x + n.r + 5 / k;
      ctx.lineWidth = 4 / k;
      ctx.strokeStyle = 'rgba(19, 48, 79, 0.92)';
      ctx.strokeText(label, x, n.y);
      ctx.fillStyle = '#e8eef5';
      ctx.fillText(label, x, n.y);
    });

    if (nodes.length === 0) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#9fb4cc';
      ctx.font = '15px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Nothing passed the thresholds yet. Re-run with --min-shared 2 to see weaker links.', size.w / 2, size.h / 2);
      ctx.textAlign = 'start';
    }
  }

  // ---- hit testing ---------------------------------------------------------
  function nodeAt(p) {
    for (var i = nodes.length - 1; i >= 0; i--) {
      var n = nodes[i];
      if (!isActive(n)) continue;
      var dx = p.x - n.x, dy = p.y - n.y, r = n.r + 3 / cam.scale;
      if (dx * dx + dy * dy <= r * r) return n;
    }
    return null;
  }
  function edgeAt(p) {
    var best = null, bestD = 6 / cam.scale;
    edges.forEach(function (e) {
      if (!isVisible(e)) return;
      var ax = e.s.x, ay = e.s.y, bx = e.t.x, by = e.t.y;
      var vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy || 1;
      var t = Math.max(0, Math.min(1, ((p.x - ax) * vx + (p.y - ay) * vy) / len2));
      var dx = p.x - (ax + t * vx), dy = p.y - (ay + t * vy), d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestD) { bestD = d; best = e; }
    });
    return best;
  }

  // ---- pointer interaction -------------------------------------------------
  var drag = null;
  canvas.addEventListener('pointerdown', function (ev) {
    var rect = canvas.getBoundingClientRect();
    var px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    var n = nodeAt(toWorld(px, py));
    drag = { node: n, startX: px, startY: py, lastX: px, lastY: py, moved: false };
    canvas.setPointerCapture(ev.pointerId);
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', function (ev) {
    var rect = canvas.getBoundingClientRect();
    var px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    if (drag) {
      if (Math.abs(px - drag.startX) + Math.abs(py - drag.startY) > 4) drag.moved = true;
      if (drag.node && drag.moved) {
        var w = toWorld(px, py);
        drag.node.x = w.x; drag.node.y = w.y; drag.node.pinned = true;
        alpha = Math.max(alpha, 0.25);
      } else if (drag.moved) {
        userMoved = true; flight = null;
        cam.x -= (px - drag.lastX) / cam.scale;
        cam.y -= (py - drag.lastY) / cam.scale;
      }
      drag.lastX = px; drag.lastY = py;
      tooltip.hidden = true;
      requestDraw();
      return;
    }
    var p = toWorld(px, py);
    var n = nodeAt(p);
    var e = n ? null : edgeAt(p);
    canvas.classList.toggle('pointing', Boolean(n || e));
    if (n !== hoverNode) { hoverNode = n; requestDraw(); }
    if (n || e) {
      tooltip.textContent = '';
      if (n) {
        tooltip.appendChild(el('code', '', n.path));
        tooltip.appendChild(el('div', '', 'Changed in ' + plural(n.changes, 'commit')));
      } else {
        tooltip.appendChild(el('div', '', KINDS[e.d.relationship].label.replace(/s$/, '') + ': ' + base(e.s.path) + ' and ' + base(e.t.path)));
        tooltip.appendChild(el('div', '', plural(e.d.shared, 'shared commit')));
      }
      tooltip.hidden = false;
      var left = Math.min(px + 14, size.w - tooltip.offsetWidth - 8);
      tooltip.style.left = Math.max(8, left) + 'px';
      tooltip.style.top = (py + 14) + 'px';
    } else {
      tooltip.hidden = true;
    }
  });
  function endDrag(ev) {
    if (!drag) return;
    canvas.classList.remove('dragging');
    if (!drag.moved) {
      var rect = canvas.getBoundingClientRect();
      var p = toWorld(ev.clientX - rect.left, ev.clientY - rect.top);
      var n = nodeAt(p);
      if (n) selectNode(n);
      else {
        var e = edgeAt(p);
        if (e) selectEdge(e); else clearSelection();
      }
    }
    drag = null;
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', function () { drag = null; canvas.classList.remove('dragging'); });
  canvas.addEventListener('pointerleave', function () { if (!drag) { tooltip.hidden = true; if (hoverNode) { hoverNode = null; requestDraw(); } } });
  canvas.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    userMoved = true; flight = null;
    var rect = canvas.getBoundingClientRect();
    var px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    var before = toWorld(px, py);
    cam.scale = Math.max(0.15, Math.min(6, cam.scale * Math.exp(-ev.deltaY * 0.0015)));
    var after = toWorld(px, py);
    cam.x += before.x - after.x; cam.y += before.y - after.y;
    requestDraw();
  }, { passive: false });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { clearSelection(); search.blur(); }
    if (ev.key === '/' && document.activeElement !== search) { ev.preventDefault(); search.focus(); }
  });
  search.addEventListener('input', function () {
    var q = search.value.trim().toLowerCase();
    matches = q ? nodes.filter(function (n) { return n.path.toLowerCase().indexOf(q) >= 0; }) : null;
    requestDraw();
  });
  search.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && matches && matches.length > 0) { selectNode(matches[0]); }
  });

  function selectNode(n) {
    selectedNode = n; selectedEdge = null; matches = null; search.value = '';
    var group = [n];
    n.edges.forEach(function (e) { if (isVisible(e)) group.push(e.s === n ? e.t : e.s); });
    flyTo(group);
    renderPanel(); requestDraw();
  }
  function selectEdge(e) {
    selectedEdge = e; selectedNode = null;
    flyTo([e.s, e.t]);
    renderPanel(); requestDraw();
  }
  function clearSelection() {
    selectedNode = null; selectedEdge = null;
    renderPanel(); requestDraw();
  }

  // ---- panel ---------------------------------------------------------------
  function fileButton(n) {
    var b = el('button', 'file-link', n.path);
    b.type = 'button';
    b.addEventListener('click', function () { selectNode(n); });
    return b;
  }
  function evidenceList(e) {
    var list = el('ul', 'evidence');
    e.d.evidence.forEach(function (ev) {
      var li = el('li');
      li.appendChild(el('span', 'hash', ev.hash.slice(0, 7)));
      li.appendChild(el('span', '', ev.date + '  ' + ev.subject));
      list.appendChild(li);
    });
    return list;
  }
  /** One relationship, described from the point of view of 'from'. */
  function relationshipItem(e, from, showBoth) {
    var other = e.s === from ? e.t : e.s;
    var forward = e.s === from ? e.d.confidence : e.d.reverseConfidence;
    var backward = e.s === from ? e.d.reverseConfidence : e.d.confidence;
    var li = el('li', 'rel');
    var head = el('div', 'rel-head');
    head.appendChild(el('span', 'swatch ' + e.d.relationship));
    if (showBoth) {
      var pair = el('div', 'pair');
      pair.appendChild(fileButton(from));
      pair.appendChild(fileButton(other));
      head.appendChild(pair);
    } else {
      head.appendChild(fileButton(other));
    }
    li.appendChild(head);
    li.appendChild(el('p', 'rel-body',
      KINDS[e.d.relationship].label.replace(/s$/, '') + ', ' + e.d.why + '. Changed together in ' + plural(e.d.shared, 'commit') +
      ': when ' + base(from.path) + ' changes, ' + base(other.path) + ' changes ' + pct(forward) + ' of the time (' + pct(backward) + ' the other way). Last together ' + e.d.lastTogether + '.'));
    li.appendChild(evidenceList(e));
    return li;
  }

  function renderPanel() {
    panel.textContent = '';
    if (selectedNode) {
      var n = selectedNode;
      panel.appendChild(el('h2', '', base(n.path)));
      panel.appendChild(el('p', 'path', n.path));
      var who = n.author ? ' Most commits by ' + n.author + ' (' + pct(n.share || 0) + ').' : '';
      panel.appendChild(el('p', '', 'Changed in ' + plural(n.changes, 'commit') + '.' + who));
      var rels = n.edges.filter(isVisible).sort(function (a, b) { return b.d.shared - a.d.shared; });
      var list = el('ol');
      rels.forEach(function (e) { list.appendChild(relationshipItem(e, n)); });
      panel.appendChild(list);
      if (rels.length === 0) panel.appendChild(el('p', '', 'Its relationships are hidden by the filters above.'));
    } else if (selectedEdge) {
      var e = selectedEdge;
      panel.appendChild(el('h2', '', KINDS[e.d.relationship].label.replace(/s$/, '')));
      var list2 = el('ol');
      list2.appendChild(relationshipItem(e, e.s, true));
      panel.appendChild(list2);
    } else {
      panel.appendChild(el('h2', '', 'What moves together'));
      panel.appendChild(el('p', '', 'Each dot is a file, sized by how often it changes and coloured by folder. Lines join files that keep changing in the same commits. Pink dashed lines are ghost wires: no import connects the two files, yet history says they move together.'));
      var ghosts = edges.filter(function (e) { return e.d.relationship === 'ghost'; }).slice(0, 10);
      if (ghosts.length > 0) {
        panel.appendChild(el('h2', '', 'Strongest ghost wires'));
        var list3 = el('ol');
        ghosts.forEach(function (e) { list3.appendChild(relationshipItem(e, e.s, true)); });
        panel.appendChild(list3);
      } else if (edges.length > 0) {
        panel.appendChild(el('p', '', 'No ghost wires among these relationships: everything that changes together here is explained by imports or tests.'));
      }
      return;
    }
    var clear = el('button', 'clear', 'Show overview');
    clear.type = 'button';
    clear.addEventListener('click', clearSelection);
    panel.appendChild(clear);
  }

  // ---- start ---------------------------------------------------------------
  if (reduceMotion) { while (alpha > 0.02) tick(); }
  else { for (var w = 0; w < 120; w++) tick(); }
  window.addEventListener('resize', resize);
  resize();
  fit();
  renderPanel();
  requestDraw();
})();
`;
