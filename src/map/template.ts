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
 * in fluorescent pink flagging tape.
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
      ${data.meta.warnings && data.meta.warnings.length > 0 ? `<div class="banner-warning">${data.meta.warnings.map((w) => `! ${escapeHtml(w)}`).join('<br>')}</div>` : ''}
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
    <div class="stage-overlay">
      <button id="reset-view" class="map-btn" type="button" title="Fit all files in view">Reset view</button>
      <button id="toggle-anim" class="map-btn" type="button" title="Pause or resume line animation">Pause animation</button>
    </div>
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
  --ground-surface: #173b61;
  --ground-card: rgba(14, 37, 64, 0.75);
  --ground-card-hover: rgba(23, 59, 97, 0.9);
  --chalk: #e8eef5;
  --chalk-faded: #9fb4cc;
  --chalk-dim: #7189a5;
  --grid: rgba(159, 180, 204, 0.08);
  --tape: #ff4f9a;
  --tape-glow: rgba(255, 79, 154, 0.35);
  --ochre: #e3b65b;
  --lichen: #7fd1b0;
  --import: rgba(232, 238, 245, 0.55);
  --border-subtle: rgba(159, 180, 204, 0.18);
  --border-active: rgba(159, 180, 204, 0.35);
  --condensed: "Avenir Next Condensed", "Roboto Condensed", "Arial Narrow", "Helvetica Neue", sans-serif;
  --text: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --code: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--ground); color: var(--chalk); font: 15px/1.55 var(--text); }
button, input { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--tape); outline-offset: 2px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

.app { display: grid; grid-template-columns: minmax(0, 1fr) 420px; grid-template-rows: auto minmax(0, 1fr); height: 100vh; }
.bar { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 12px 32px; align-items: flex-end; justify-content: space-between; padding: 18px 24px 14px; border-bottom: 1px solid var(--border-subtle); background: var(--ground); }
h1 { margin: 0; font: 600 30px/1.1 var(--condensed); letter-spacing: 0.01em; font-stretch: condensed; }
.summary { margin: 4px 0 0; color: var(--chalk-faded); font-size: 14px; max-width: 75ch; }
.controls { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; }
.search input { width: 240px; padding: 7px 11px; border: 1px solid var(--border-active); border-radius: 6px; background: var(--ground-deep); font-size: 13.5px; }
.search input::placeholder { color: var(--chalk-faded); }
.banner-warning { display: inline-flex; align-items: center; gap: 8px; margin-top: 8px; padding: 6px 12px; background: rgba(227, 182, 91, 0.12); border: 1px solid rgba(227, 182, 91, 0.35); border-radius: 6px; font-size: 13px; color: var(--ochre); }
.toggles { display: flex; flex-wrap: wrap; gap: 6px; }
.toggle { display: inline-flex; align-items: center; gap: 8px; padding: 5px 11px; border: 1px solid rgba(159, 180, 204, 0.3); border-radius: 999px; background: transparent; cursor: pointer; font-size: 13px; font-weight: 500; color: var(--chalk); transition: all 0.15s ease; }
.toggle:hover { border-color: var(--chalk); }
.toggle[aria-pressed="false"] { border-style: dashed; border-color: rgba(159, 180, 204, 0.25); background: rgba(14, 37, 64, 0.4); color: var(--chalk-faded); }
.toggle[aria-pressed="false"] .count { color: var(--chalk-dim); }
.toggle[aria-pressed="true"] { background: rgba(23, 59, 97, 0.5); border-color: var(--border-active); color: var(--chalk); }
.toggle .count { color: var(--chalk-faded); font-variant-numeric: tabular-nums; }
.swatch { width: 22px; height: 0; border-top: 2px solid; }
.swatch.ghost { border-top: 2px dashed var(--tape); filter: drop-shadow(0 0 3px var(--tape)); }
.swatch.unknown { border-top: 2px dotted var(--ochre); }
.swatch.indirect { border-top: 2px dashed var(--import); opacity: 0.8; }
.swatch.direct { border-top-color: var(--import); }
.swatch.test { border-top-color: var(--lichen); }

.stage { position: relative; min-height: 0; overflow: hidden; }
canvas { display: block; width: 100%; height: 100%; cursor: grab; touch-action: none; }
canvas.dragging { cursor: grabbing; }
canvas.pointing { cursor: pointer; }
.stage-overlay { position: absolute; top: 14px; left: 14px; display: flex; gap: 8px; z-index: 10; }
.map-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; background: rgba(14, 37, 64, 0.88); backdrop-filter: blur(6px); border: 1px solid var(--border-active); border-radius: 6px; color: var(--chalk); font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.15s ease; box-shadow: 0 2px 8px rgba(0,0,0,0.25); }
.map-btn:hover { background: rgba(19, 48, 79, 0.98); border-color: var(--chalk); transform: translateY(-1px); }
.hint { position: absolute; left: 16px; bottom: 12px; margin: 0; font-size: 12.5px; color: var(--chalk-faded); pointer-events: none; }
.tooltip { position: absolute; pointer-events: none; max-width: 440px; padding: 7px 11px; border-radius: 6px; background: var(--ground-deep); border: 1px solid var(--border-active); font-size: 13.5px; box-shadow: 0 4px 14px rgba(0,0,0,0.4); z-index: 20; }
.tooltip code { font-family: var(--code); font-size: 13px; word-break: break-all; }

.panel { overflow-y: auto; padding: 22px 24px 36px; background: var(--ground-deep); border-left: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 14px; }
.panel h2 { margin: 0 0 6px; font: 600 22px/1.25 var(--condensed); font-stretch: condensed; }
.panel h3 { margin: 18px 0 8px; font: 600 13px/1.2 var(--text); text-transform: uppercase; letter-spacing: 0.05em; color: var(--chalk-faded); }
.panel p { margin: 0 0 10px; color: var(--chalk-faded); font-size: 14.5px; line-height: 1.55; }
.panel .path { font-family: var(--code); font-size: 13.5px; overflow-wrap: anywhere; color: var(--chalk); }
.panel ol, .panel ul { list-style: none; margin: 0; padding: 0; }

.badge { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.badge.ghost { background: rgba(255, 79, 154, 0.15); color: var(--tape); border: 1px solid rgba(255, 79, 154, 0.35); }
.badge.parallel { background: rgba(160, 200, 240, 0.12); color: #a0c8f0; border: 1px solid rgba(160, 200, 240, 0.3); }
.badge.unknown { background: rgba(227, 182, 91, 0.15); color: var(--ochre); border: 1px solid rgba(227, 182, 91, 0.35); }
.badge.indirect { background: rgba(160, 200, 240, 0.15); color: #a0c8f0; border: 1px solid rgba(160, 200, 240, 0.3); }
.badge.direct { background: rgba(232, 238, 245, 0.1); color: var(--chalk); border: 1px solid rgba(232, 238, 245, 0.25); }
.badge.test { background: rgba(127, 209, 176, 0.15); color: var(--lichen); border: 1px solid rgba(127, 209, 176, 0.35); }

.tab-group { display: flex; gap: 4px; margin-bottom: 8px; background: rgba(14, 37, 64, 0.7); padding: 3px; border-radius: 8px; border: 1px solid var(--border-subtle); }
.tab-btn { flex: 1; padding: 6px 8px; background: transparent; border: 0; border-radius: 6px; color: var(--chalk-faded); font-size: 12.5px; font-weight: 500; cursor: pointer; text-align: center; transition: all 0.15s ease; }
.tab-btn:hover { color: var(--chalk); }
.tab-btn.active { background: var(--ground-surface); color: var(--chalk); box-shadow: 0 1px 4px rgba(0,0,0,0.3); }

.card-hint { font-size: 12px; color: var(--chalk-dim); margin: -4px 0 8px; }
.card { background: var(--ground-card); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; transition: border-color 0.15s ease, background 0.15s ease, transform 0.15s ease; display: block; width: 100%; text-align: left; }
.card.interactive { cursor: pointer; font: inherit; }
.card.interactive:hover { border-color: rgba(255, 79, 154, 0.5); background: var(--ground-card-hover); transform: translateY(-1px); }
.card.selected { border-color: var(--tape); box-shadow: 0 0 14px var(--tape-glow); }

.card-header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 8px; }
.card-title { font-family: var(--code); font-size: 13.5px; font-weight: 600; color: var(--chalk); overflow-wrap: anywhere; }
.card-sub { font-size: 12.5px; color: var(--chalk-faded); margin-top: 4px; }

.file-link { padding: 0; border: 0; background: none; text-align: left; cursor: pointer; font-family: var(--code); font-size: 13.5px; overflow-wrap: anywhere; text-decoration: underline; text-decoration-color: rgba(159, 180, 204, 0.4); text-underline-offset: 3px; color: var(--chalk); }
.file-link:hover { text-decoration-color: var(--tape); color: #fff; }

.back-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; margin-bottom: 8px; background: rgba(14, 37, 64, 0.6); border: 1px solid var(--border-active); border-radius: 6px; color: var(--chalk); font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.15s ease; width: fit-content; }
.back-btn:hover { background: var(--ground-surface); border-color: var(--chalk); }

.pair-container { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; }
.pair-box { background: rgba(14, 37, 64, 0.85); border: 1px solid var(--border-subtle); border-radius: 6px; padding: 10px 12px; }
.pair-box-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.pair-dir { font-size: 12px; color: var(--chalk-dim); }
.pair-wire { display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 12.5px; color: var(--chalk-faded); padding: 2px 0; }

.cochange-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 12px 0; }
.cochange-card { background: rgba(14, 37, 64, 0.65); border: 1px solid var(--border-subtle); border-radius: 6px; padding: 10px 8px; text-align: center; }
.cochange-pct { font-size: 21px; font-weight: 700; color: var(--chalk); font-variant-numeric: tabular-nums; }
.cochange-label { font-size: 12px; color: var(--chalk-faded); margin-top: 4px; line-height: 1.3; }

.callout { background: rgba(19, 48, 79, 0.6); border-left: 3px solid var(--tape); border-radius: 0 6px 6px 0; padding: 12px 14px; margin: 12px 0; font-size: 14px; line-height: 1.55; color: var(--chalk); }
.callout.unknown { border-left-color: var(--ochre); }
.callout.indirect { border-left-color: #a0c8f0; }
.callout.direct { border-left-color: var(--chalk-faded); }
.callout.test { border-left-color: var(--lichen); }
.callout-title { font-weight: 600; font-size: 13.5px; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.04em; }

.evidence-wrap { margin: 12px 0 0; color: var(--chalk-faded); font-size: 13px; }
.evidence-wrap summary { width: fit-content; cursor: pointer; color: var(--chalk); font-weight: 500; padding: 4px 0; }
.evidence { margin: 8px 0 0; font-size: 13px; color: var(--chalk-faded); }
.evidence li { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; padding: 6px 0; border-top: 1px solid rgba(159, 180, 204, 0.1); }
.evidence .hash { padding: 2px 6px; border: 1px solid var(--border-subtle); border-radius: 4px; background: rgba(14, 37, 64, 0.6); cursor: pointer; font-family: var(--code); font-size: 12px; color: var(--chalk); height: fit-content; }
.evidence .hash:hover { border-color: var(--tape); color: var(--tape); }
.evidence-item-body { min-width: 0; }
.evidence-rename { font-family: var(--code); font-size: 11.5px; color: var(--chalk-dim); margin-top: 2px; overflow-wrap: anywhere; }

.patch-details { grid-column: 1 / -1; margin-top: 4px; background: rgba(10, 26, 46, 0.75); border: 1px solid var(--border-subtle); border-radius: 6px; padding: 6px 10px; }
.patch-details summary { font-size: 12px; color: #a0c8f0; cursor: pointer; font-weight: 500; padding: 2px 0; }
.patch-file { margin-top: 8px; border-top: 1px solid rgba(159, 180, 204, 0.12); padding-top: 6px; }
.patch-file-title { font-family: var(--code); font-size: 12px; font-weight: 600; color: var(--chalk); overflow-wrap: anywhere; }
.patch-note { font-size: 12px; color: var(--chalk-dim); margin-top: 3px; }
.patch-hunk { margin: 6px 0 0; padding: 6px 8px; background: rgba(7, 19, 34, 0.85); border-radius: 4px; overflow-x: auto; font: 11.5px/1.45 var(--code); }
.patch-hunk-hdr { color: #a0c8f0; margin-bottom: 2px; white-space: pre; }
.patch-line { white-space: pre; color: var(--chalk-faded); }
.patch-line.add { color: var(--lichen); background: rgba(127, 209, 176, 0.08); }
.patch-line.del { color: #ff8da1; background: rgba(255, 79, 154, 0.08); }

.counterexample-group { margin-top: 8px; }
.counterexample-title { font-size: 12px; font-weight: 600; color: var(--chalk); margin: 6px 0 4px; }

.cli-box { margin-top: 12px; padding: 10px 12px; background: rgba(14, 37, 64, 0.85); border: 1px solid var(--border-subtle); border-radius: 6px; }
.cli-box-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; }
.cli-box-label { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--chalk-faded); }
.btn-cli-copy { padding: 3px 9px; border: 1px solid var(--border-active); border-radius: 4px; background: rgba(23, 59, 97, 0.65); color: var(--chalk); font-size: 12px; font-weight: 500; cursor: pointer; transition: all 0.15s ease; }
.btn-cli-copy:hover { border-color: var(--tape); color: #fff; }
.btn-cli-copy.copied { background: rgba(127, 209, 176, 0.22); border-color: var(--lichen); color: var(--lichen); }
.cli-code { display: block; font: 12px/1.45 var(--code); color: var(--chalk); overflow-wrap: anywhere; user-select: all; }
.privacy-note { margin-top: 6px; font-size: 12px; line-height: 1.45; color: var(--chalk-dim); }

.btn-export { display: inline-flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 9px 16px; margin-top: 14px; background: rgba(255, 79, 154, 0.14); border: 1px solid rgba(255, 79, 154, 0.4); border-radius: 6px; color: var(--chalk); font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.15s ease; }
.btn-export:hover { background: rgba(255, 79, 154, 0.25); border-color: var(--tape); }
.btn-export.copied { background: rgba(127, 209, 176, 0.22); border-color: var(--lichen); color: var(--lichen); }

.view-all-btn { display: block; width: 100%; padding: 8px 12px; margin-top: 10px; background: transparent; border: 1px dashed var(--border-active); border-radius: 6px; color: var(--chalk-faded); font-size: 13px; font-weight: 500; cursor: pointer; text-align: center; }
.view-all-btn:hover { color: var(--chalk); border-color: var(--chalk); border-style: solid; }

.folder-legend { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-top: 8px; }
.legend-item { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--chalk-faded); }
.legend-dot { width: 9px; height: 9px; border-radius: 50%; }

@media (max-width: 960px) {
  .app { grid-template-columns: 1fr; grid-template-rows: auto 55vh auto; height: auto; }
  .panel { border-left: 0; border-top: 1px solid var(--border-subtle); }
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
    indirect: { label: 'Indirect imports', color: 'rgba(160, 200, 240, 0.6)' },
    direct: { label: 'Import links', color: 'rgba(232, 238, 245, 0.55)' },
    test: { label: 'Test links', color: '#7fd1b0' }
  };
  var ORDER = ['ghost', 'unknown', 'indirect', 'direct', 'test'];
  var hasPrimary = data.edges.some(function (e) { return e.relationship !== 'unknown'; });
  var visible = {
    ghost: data.edges.some(function (e) { return e.relationship === 'ghost'; }),
    unknown: !hasPrimary && data.edges.some(function (e) { return e.relationship === 'unknown'; }),
    indirect: data.edges.some(function (e) { return e.relationship === 'indirect'; }),
    direct: data.edges.some(function (e) { return e.relationship === 'direct'; }),
    test: data.edges.some(function (e) { return e.relationship === 'test'; })
  };
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var canvas = document.getElementById('map');
  var ctx = canvas.getContext('2d');
  var tooltip = document.getElementById('tooltip');
  var panel = document.getElementById('panel');
  var search = document.getElementById('search');
  var resetBtn = document.getElementById('reset-view');

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function pct(x) { return Math.floor(x * 100 + 1e-9) + '%'; }
  function base(p) { var i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); }
  function distinguishingPaths(a, b) {
    var aParts = a.split('/'), bParts = b.split('/');
    for (var depth = 1; depth <= Math.max(aParts.length, bParts.length); depth++) {
      var aLabel = aParts.slice(-depth).join('/');
      var bLabel = bParts.slice(-depth).join('/');
      if (aLabel !== bLabel) return [aLabel, bLabel];
    }
    return [a, b];
  }
  function plural(n, w) { return n.toLocaleString('en-US') + ' ' + w + (n === 1 ? '' : 's'); }
  function relativeDate(date) {
    var days = Math.max(0, Math.floor((Date.parse(data.generatedAt) - Date.parse(date)) / 86400000));
    if (days < 1) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 45) return days + ' days ago';
    var months = Math.round(days / 30.44);
    if (months < 18) return months + ' ' + (months === 1 ? 'month' : 'months') + ' ago';
    var years = (days / 365.25).toFixed(1).replace(/\.0$/, '');
    return years + ' years ago';
  }
  function capitalize(text) { return text.charAt(0).toUpperCase() + text.slice(1); }

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
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return Math.round((h * 137.508) % 360);
  }

  // ---- data ----------------------------------------------------------------
  // Null-prototype object: folders named "constructor" or "__proto__" must not hit Object.prototype.
  var dirs = Object.create(null);
  var dirList = [];
  var nodes = data.nodes.map(function (n, i) {
    if (!dirs[n.dir]) { dirs[n.dir] = { name: n.dir, x: 0, y: 0, count: 0 }; dirList.push(dirs[n.dir]); }
    return {
      i: i, path: n.path, dir: n.dir, changes: n.changes, author: n.topAuthor, share: n.topAuthorShare,
      r: 4 + Math.min(14, Math.sqrt(n.changes) * 1.25),
      color: 'hsl(' + hashHue(n.dir) + ', 58%, 72%)',
      x: 0, y: 0, vx: 0, vy: 0, pinned: false, edges: []
    };
  });
  var edges = data.edges.map(function (e) {
    var edge = { s: nodes[e.source], t: nodes[e.target], d: e };
    edge.s.edges.push(edge);
    edge.t.edges.push(edge);
    return edge;
  });

  // Disambiguate duplicate basenames (e.g. multiple page.tsx or route.ts)
  var baseCounts = Object.create(null);
  nodes.forEach(function (n) {
    var b = base(n.path);
    baseCounts[b] = (baseCounts[b] || 0) + 1;
  });
  function getNodeLabel(n) {
    var b = base(n.path);
    if (baseCounts[b] <= 1) return b;
    var parts = n.path.split('/');
    if (parts.length >= 2) return parts.slice(-2).join('/');
    return n.path;
  }

  var overviewGhosts = edges.filter(function (e) { return e.d.relationship === 'ghost'; }).sort(function (a, b) {
    return b.d.overviewPriority - a.d.overviewPriority || b.d.score - a.d.score || b.d.shared - a.d.shared;
  });
  var overviewLabelNodes = {};
  overviewGhosts.slice(0, 3).forEach(function (e) {
    var labels = distinguishingPaths(e.s.path, e.t.path);
    overviewLabelNodes[e.s.i] = labels[0];
    overviewLabelNodes[e.t.i] = labels[1];
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
  function updateSummary() {
    var shown = edges.filter(function (e) { return visible[e.d.relationship]; }).length;
    document.getElementById('summary').textContent =
      'Analyzed ' + plural(m.commitsAnalyzed, 'commit') + span + '. Loaded ' + plural(edges.length, 'relationship') +
      ' and showing ' + shown.toLocaleString('en-US') + ' (each at least ' + m.settings.minShared +
      ' shared commits and ' + pct(m.settings.minConfidence) + ' confidence).';
  }
  updateSummary();

  var toggles = document.getElementById('toggles');
  ORDER.forEach(function (kind) {
    var shown = edges.filter(function (e) { return e.d.relationship === kind; }).length;
    if (shown === 0) return;
    var b = el('button', 'toggle');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(visible[kind]));
    if (kind === 'unknown') b.title = 'Hidden by default when other links exist: import status could not be verified';
    b.appendChild(el('span', 'swatch ' + kind));
    b.appendChild(el('span', '', KINDS[kind].label));
    b.appendChild(el('span', 'count', String(shown)));
    b.addEventListener('click', function () {
      visible[kind] = !visible[kind];
      b.setAttribute('aria-pressed', String(visible[kind]));
      if (selectedEdge && !visible[selectedEdge.d.relationship]) selectedEdge = null;
      alpha = Math.max(alpha, 0.6);
      if (reduceMotion) { while (alpha > 0.02) tick(); }
      if (!selectedNode && !selectedEdge && !userMoved) { flight = null; fit(); }
      updateSummary();
      renderPanel();
      requestDraw();
    });
    toggles.appendChild(b);
  });

  // ---- layout simulation ---------------------------------------------------
  var alpha = 1;
  function tick() {
    var i, j, a, b, dx, dy, d2, f;
    var activeNodes = nodes.filter(isActive);
    nodes.forEach(function (n) { if (!isActive(n)) { n.vx = 0; n.vy = 0; } });
    for (i = 0; i < activeNodes.length; i++) {
      a = activeNodes[i];
      for (j = i + 1; j < activeNodes.length; j++) {
        b = activeNodes[j];
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
      if (!isVisible(e)) return;
      dx = e.t.x - e.s.x; dy = e.t.y - e.s.y;
      var d = Math.sqrt(dx * dx + dy * dy) || 1;
      var strength = Math.max(e.d.confidence, e.d.reverseConfidence);
      var rest = 50 + (1 - strength) * 90 + e.s.r + e.t.r;
      f = ((d - rest) / d) * 0.05 * alpha * (0.4 + strength);
      e.s.vx += dx * f; e.s.vy += dy * f;
      e.t.vx -= dx * f; e.t.vy -= dy * f;
    });
    dirList.forEach(function (d) { d.cx = 0; d.cy = 0; d.count = 0; });
    activeNodes.forEach(function (n) { var d = dirs[n.dir]; d.cx += n.x; d.cy += n.y; d.count++; });
    activeNodes.forEach(function (n) {
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
  var selectedNode = null, selectedEdge = null, hoverNode = null, hoverEdge = null, matches = null;
  var overviewTab = 'ghost';
  var overviewExpanded = false;
  var animPaused = false;

  function isVisible(e) { return visible[e.d.relationship]; }
  function isActive(n) { return n.edges.some(isVisible); }
  function focusEdge(e) {
    if (selectedEdge) return e === selectedEdge;
    if (hoverEdge) return e === hoverEdge;
    if (selectedNode) return e.s === selectedNode || e.t === selectedNode;
    return true;
  }
  function focusNode(n) {
    if (selectedEdge) return n === selectedEdge.s || n === selectedEdge.t;
    if (hoverEdge) return n === hoverEdge.s || n === hoverEdge.t;
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
    var marching = !animPaused && !reduceMotion && !document.hidden && visible.ghost && edges.some(function (e) { return e.d.relationship === 'ghost'; });
    if (marching) dashPhase = (dashPhase + 0.35) % 1100;
    draw();
    if (alpha > 0.02 || marching || flying) requestDraw();
  }

  function draw() {
    var dpr = size.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#13304f';
    ctx.fillRect(0, 0, size.w, size.h);

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

    ['test', 'direct', 'indirect', 'unknown', 'ghost'].forEach(function (kind) {
      if (!visible[kind]) return;
      edges.forEach(function (e) {
        if (e.d.relationship !== kind) return;
        var focused = focusEdge(e);
        ctx.globalAlpha = focused ? 1 : 0.06;
        ctx.strokeStyle = KINDS[kind].color;
        ctx.lineWidth = (0.8 + Math.max(e.d.confidence, e.d.reverseConfidence) * 2.2) / k;
        ctx.setLineDash([]);
        ctx.shadowBlur = 0;
        if (kind === 'ghost') {
          ctx.setLineDash([7 / k, 6 / k]);
          ctx.lineDashOffset = -dashPhase / k;
          if (focused && (selectedEdge || selectedNode || hoverEdge)) { ctx.shadowColor = '#ff4f9a'; ctx.shadowBlur = 10 * dpr; }
        } else if (kind === 'unknown') {
          ctx.setLineDash([2 / k, 5 / k]);
        } else if (kind === 'indirect') {
          ctx.setLineDash([10 / k, 4 / k]);
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
      ctx.globalAlpha = focused ? 1 : 0.14;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = n.color;
      ctx.fill();
      ctx.lineWidth = Math.max(1 / k, 1.2);
      var isTargetEndpoint = (selectedEdge && (n === selectedEdge.s || n === selectedEdge.t)) ||
                             (hoverEdge && (n === hoverEdge.s || n === hoverEdge.t));
      ctx.strokeStyle = n === selectedNode ? '#ff4f9a' : (isTargetEndpoint ? '#ff4f9a' : 'rgba(14, 37, 64, 0.9)');
      if (n === selectedNode || isTargetEndpoint) ctx.lineWidth = 3 / Math.sqrt(k);
      ctx.stroke();
    });

    ctx.globalAlpha = 1;
    ctx.font = (12.5 / k) + 'px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    var labelBoxes = [];
    nodes.forEach(function (n) {
      var overview = !selectedNode && !selectedEdge && !hoverEdge && !matches;
      var wanted = n === hoverNode || n === selectedNode || (matches && matches.indexOf(n) >= 0) ||
        ((selectedNode || selectedEdge || hoverEdge) && focusNode(n)) ||
        (overview && (n.r * k > 9 || (visible.ghost && overviewLabelNodes[n.i])));
      if (!wanted || !isActive(n)) return;
      var label = overviewLabelNodes[n.i] || getNodeLabel(n);
      var x = n.x + n.r + 5 / k;
      var labelBox = { left: x - 2 / k, right: x + ctx.measureText(label).width + 2 / k, top: n.y - 8 / k, bottom: n.y + 8 / k };
      if (overview && labelBoxes.some(function (box) {
        return labelBox.left < box.right && labelBox.right > box.left && labelBox.top < box.bottom && labelBox.bottom > box.top;
      })) return;
      labelBoxes.push(labelBox);
      ctx.lineWidth = 4 / k;
      ctx.strokeStyle = 'rgba(19, 48, 79, 0.94)';
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
        tooltip.appendChild(el('div', '', 'Folder: ' + n.dir));
        tooltip.appendChild(el('div', '', 'Changed in ' + plural(n.changes, 'commit')));
      } else {
        var labels = distinguishingPaths(e.s.path, e.t.path);
        tooltip.appendChild(el('div', '', KINDS[e.d.relationship].label.replace(/s$/, '') + ': ' + labels[0] + ' and ' + labels[1]));
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

  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      userMoved = false; flight = null;
      selectedNode = null; selectedEdge = null;
      fit(); renderPanel(); requestDraw();
    });
  }
  var toggleAnimBtn = document.getElementById('toggle-anim');
  if (toggleAnimBtn) {
    toggleAnimBtn.addEventListener('click', function () {
      animPaused = !animPaused;
      toggleAnimBtn.textContent = animPaused ? 'Resume animation' : 'Pause animation';
      requestDraw();
    });
  }

  function selectNode(n) {
    selectedNode = n; selectedEdge = null; matches = null; search.value = '';
    var group = [n];
    n.edges.forEach(function (e) { if (isVisible(e)) group.push(e.s === n ? e.t : e.s); });
    flyTo(group);
    renderPanel(); requestDraw();
  }
  function selectEdge(e) {
    selectedEdge = e; selectedNode = null; matches = null; search.value = '';
    flyTo([e.s, e.t]);
    renderPanel(); requestDraw();
  }
  function clearSelection() {
    selectedNode = null; selectedEdge = null;
    renderPanel(); requestDraw();
  }

  // ---- copy & clipboard helpers --------------------------------------------
  function copyText(text, button, successMsg) {
    var label = successMsg || 'Copied';
    function copied() {
      var original = button.dataset.origLabel || button.textContent;
      button.dataset.origLabel = original;
      if (button._copyTimer) clearTimeout(button._copyTimer);
      button.textContent = label;
      button.classList.add('copied');
      button._copyTimer = setTimeout(function () {
        button.textContent = original;
        button.classList.remove('copied');
        button._copyTimer = null;
      }, 1500);
    }
    function fallback() {
      var input = el('textarea');
      input.value = text; input.style.position = 'fixed'; input.style.opacity = '0';
      document.body.appendChild(input); input.select();
      try { if (document.execCommand('copy')) copied(); } catch (_) {}
      input.remove();
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(copied, fallback);
      return;
    }
    fallback();
  }

  function sanitizeMarkdown(text) {
    return String(text)
      .replace(/@([a-zA-Z0-9_-]+)/g, '@\u200B$1')
      .replace(/#([0-9]+)/g, '#\u200B$1');
  }

  function mdCode(text) {
    var q = String.fromCharCode(96);
    var s = sanitizeMarkdown(text).replace(/[\r\n]+/g, ' ');
    var fence = q;
    while (s.indexOf(fence) !== -1) fence += q;
    var needsPad = s.charAt(0) === q || s.charAt(s.length - 1) === q || s.charAt(0) === ' ' || s.charAt(s.length - 1) === ' ';
    var pad = needsPad ? ' ' : '';
    return fence + pad + s + pad + fence;
  }

  function formatFindingMarkdown(e) {
    var labels = distinguishingPaths(e.s.path, e.t.path);
    var kindName = findingLabel(e);
    var scope = e.d.crossesDirectories && !(e.d.hiddenBridge && e.d.hiddenBridge.signal === 'parallel-implementation')
      ? ' Connects different parts of the project (' + mdCode(e.s.dir) + ' and ' + mdCode(e.t.dir) + ').'
      : '';
    var lines = [
      '### 🔍 Repo Archaeology: File Relationship Finding',
      '',
      '**Files:** ' + mdCode(e.s.path) + ' ↔ ' + mdCode(e.t.path) + '  ',
      '**Relationship:** ' + kindName + ' (' + plural(e.d.shared, 'shared commit') + ')  ',
      '**Last Together:** ' + relativeDate(e.d.lastTogether) + '  ',
      '',
      '**Directional Co-Change:**',
      '- ' + mdCode(labels[0]) + ' → ' + mdCode(labels[1]) + ': ' + directionEvidence(e, true),
      '- ' + mdCode(labels[1]) + ' → ' + mdCode(labels[0]) + ': ' + directionEvidence(e, false),
      '',
      '**Why It Matters:**',
      '- ' + sanitizeMarkdown(capitalize(e.d.why)) + '.' + scope,
      (e.d.relationship === 'ghost' ? '- No direct or supported indirect import relationship found in current code.' : '')
    ];
    if (e.d.evidence && e.d.evidence.length > 0) {
      lines.push('', '**Supporting Commits:**');
      e.d.evidence.slice(0, 5).forEach(function (ev) {
        lines.push('- ' + mdCode(ev.hash.slice(0, 7)) + ' (' + ev.date + '): ' + sanitizeMarkdown(ev.subject));
      });
    }
    var cliCmd = e.d.explainCommand || ('npx repo-archaeology explain ' + e.s.path + ' ' + e.t.path);
    lines.push('', '**Inspect Diff Evidence:** ' + mdCode(cliCmd));
    return lines.filter(function (l) { return l !== undefined; }).join('\n');
  }

  function directionEvidence(e, fromSource) {
    var total = fromSource ? e.d.fromChanges : e.d.toChanges;
    var confidence = fromSource ? e.d.confidence : e.d.reverseConfidence;
    if (e.d.weighted) return pct(confidence) + ' recency-weighted co-change (' + e.d.shared + ' shared / ' + total + ' total commits)';
    return e.d.shared + ' of ' + total + ' commits (' + pct(confidence) + ')';
  }
  function findingLabel(e) {
    if (e.d.hiddenBridge && e.d.hiddenBridge.signal === 'parallel-implementation') return 'Related implementations';
    return KINDS[e.d.relationship].label.replace(/s$/, '');
  }

  // ---- panel rendering -----------------------------------------------------
  function getTopFindings(list, maxCount) {
    var result = [];
    var seenParallel = new Set();
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var isParallel = item.d.hiddenBridge && item.d.hiddenBridge.signal === 'parallel-implementation';
      if (isParallel) {
        var baseName = base(item.s.path);
        if (seenParallel.has(baseName)) continue;
        seenParallel.add(baseName);
      }
      result.push(item);
      if (result.length >= maxCount) break;
    }
    if (result.length < maxCount) {
      for (var j = 0; j < list.length; j++) {
        if (result.indexOf(list[j]) === -1) {
          result.push(list[j]);
          if (result.length >= maxCount) break;
        }
      }
    }
    return result;
  }

  function renderOverview() {
    var header = el('div');
    header.appendChild(el('h2', '', 'Explore file relationships'));
    header.appendChild(el('p', '', 'Each dot represents a file sized by commit frequency and colored by directory. Lines connect files that change together. Pink dashed lines are ghost wires: files with no direct or supported indirect import relationship in current code that repeatedly move together in git history.'));
    panel.appendChild(header);

    var visibleEdges = edges.filter(isVisible);
    var ghosts = visibleEdges.filter(function (e) { return e.d.relationship === 'ghost'; }).sort(function (a, b) {
      return b.d.overviewPriority - a.d.overviewPriority || b.d.score - a.d.score || b.d.shared - a.d.shared;
    });
    var surprising = ghosts.filter(function (e) {
      var isParallel = e.d.hiddenBridge && e.d.hiddenBridge.signal === 'parallel-implementation';
      if (isParallel) return false;
      var fromDir = e.s.dir, toDir = e.t.dir;
      var independent = fromDir !== toDir && fromDir !== '.' && toDir !== '.'
        && !fromDir.startsWith(toDir + '/') && !toDir.startsWith(fromDir + '/');
      return independent || e.d.overviewPriority >= 2;
    });
    var strongest = visibleEdges.slice().sort(function (a, b) { return b.d.shared - a.d.shared || b.d.score - a.d.score; });

    // Tabs
    var tabGroup = el('div', 'tab-group');
    var tabDefs = [
      { id: 'ghost', label: 'Ghost wires (' + ghosts.length + ')' },
      { id: 'surprising', label: 'Surprising (' + surprising.length + ')' },
      { id: 'all', label: 'All links (' + visibleEdges.length + ')' }
    ];
    tabDefs.forEach(function (t) {
      var btn = el('button', 'tab-btn' + (overviewTab === t.id ? ' active' : ''), t.label);
      btn.type = 'button';
      btn.addEventListener('click', function () {
        overviewTab = t.id;
        overviewExpanded = false;
        renderPanel();
      });
      tabGroup.appendChild(btn);
    });
    panel.appendChild(tabGroup);

    var listData = overviewTab === 'surprising' ? surprising : (overviewTab === 'all' ? strongest : ghosts);
    var titleText = overviewTab === 'surprising' ? 'Cross-folder connections worth exploring' : (overviewTab === 'all' ? 'Strongest co-changing files' : 'Connections worth exploring');

    panel.appendChild(el('h3', '', titleText));

    if (listData.length === 0) {
      panel.appendChild(el('p', '', 'No relationships found for this filter.'));
    } else {
      panel.appendChild(el('p', 'card-hint', 'Select a card or line to inspect directional stats & commits'));
      var displayCards = overviewExpanded ? listData : getTopFindings(listData, 3);
      var cardsContainer = el('div');
      for (var idx = 0; idx < displayCards.length; idx++) {
        cardsContainer.appendChild(relationshipCard(displayCards[idx]));
      }
      panel.appendChild(cardsContainer);

      if (listData.length > 3) {
        var viewAllBtn = el('button', 'view-all-btn', overviewExpanded ? 'Show top 3 findings' : 'View all ' + listData.length + ' findings');
        viewAllBtn.type = 'button';
        viewAllBtn.addEventListener('click', function () {
          overviewExpanded = !overviewExpanded;
          renderPanel();
        });
        panel.appendChild(viewAllBtn);
      }
    }

    // Folder Color Legend
    renderFolderLegend();
  }

  function renderFolderLegend() {
    var activeNodes = nodes.filter(isActive);
    var dirCounts = Object.create(null);
    activeNodes.forEach(function (n) {
      dirCounts[n.dir] = (dirCounts[n.dir] || 0) + 1;
    });
    var sortedDirs = Object.keys(dirCounts)
      .map(function (name) { return { name: name, count: dirCounts[name] }; })
      .sort(function (a, b) { return b.count - a.count; });
    if (sortedDirs.length === 0) return;
    var title = sortedDirs.length > 8
      ? 'Directory color legend (' + sortedDirs.slice(0, 8).length + ' of ' + sortedDirs.length + ' folders)'
      : 'Directory color legend';
    panel.appendChild(el('h3', '', title));
    var legend = el('div', 'folder-legend');
    sortedDirs.slice(0, 8).forEach(function (d) {
      var item = el('div', 'legend-item');
      var dot = el('span', 'legend-dot');
      dot.style.background = 'hsl(' + hashHue(d.name) + ', 58%, 72%)';
      item.appendChild(dot);
      item.appendChild(el('span', '', d.name + ' (' + d.count + ')'));
      legend.appendChild(item);
    });
    panel.appendChild(legend);
  }

  function relationshipCard(e) {
    var card = el('button', 'card interactive');
    card.type = 'button';
    var head = el('div', 'card-header');
    var isParallel = e.d.hiddenBridge && e.d.hiddenBridge.signal === 'parallel-implementation';
    var badgeClass = isParallel ? 'badge parallel' : 'badge ' + e.d.relationship;
    head.appendChild(el('span', badgeClass, findingLabel(e)));
    var peakPct = pct(Math.max(e.d.confidence, e.d.reverseConfidence));
    head.appendChild(el('span', 'card-sub', plural(e.d.shared, 'shared commit') + ' · ' + peakPct));
    card.appendChild(head);

    var pair = el('div', 'card-title');
    var labels = distinguishingPaths(e.s.path, e.t.path);
    pair.textContent = labels[0] + ' ↔ ' + labels[1];
    card.appendChild(pair);

    var note = el('div', 'card-sub');
    if (isParallel) {
      note.textContent = 'These files support related functionality across sibling directories and have been updated together in ' + plural(e.d.shared, 'commit') + '.';
    } else {
      var scope = e.d.crossesDirectories
        ? 'Connects different parts of the project (' + e.s.dir + ' and ' + e.t.dir + '). '
        : '';
      note.textContent = scope + capitalize(e.d.why) + '.';
    }
    card.appendChild(note);

    card.addEventListener('pointerenter', function () {
      hoverEdge = e;
      requestDraw();
    });
    card.addEventListener('pointerleave', function () {
      if (hoverEdge === e) {
        hoverEdge = null;
        requestDraw();
      }
    });
    card.addEventListener('click', function () {
      selectEdge(e);
    });
    return card;
  }

  function renderSelectedEdge(e) {
    var backBtn = el('button', 'back-btn', '← Back to overview');
    backBtn.type = 'button';
    backBtn.addEventListener('click', clearSelection);
    panel.appendChild(backBtn);

    var head = el('div');
    var isParallel = e.d.hiddenBridge && e.d.hiddenBridge.signal === 'parallel-implementation';
    var badgeClass = isParallel ? 'badge parallel' : 'badge ' + e.d.relationship;
    head.appendChild(el('span', badgeClass, findingLabel(e)));
    head.appendChild(el('h2', '', 'Connection worth checking'));
    head.appendChild(el('p', 'card-sub', 'Changed together in ' + plural(e.d.shared, 'commit') + ' · Last together ' + relativeDate(e.d.lastTogether)));
    panel.appendChild(head);

    var labels = distinguishingPaths(e.s.path, e.t.path);

    // Pair Boxes
    var pairContainer = el('div', 'pair-container');

    var boxA = el('div', 'pair-box');
    var boxAHead = el('div', 'pair-box-head');
    var linkA = el('button', 'file-link', e.s.path);
    linkA.type = 'button';
    linkA.addEventListener('click', function () { selectNode(e.s); });
    boxAHead.appendChild(linkA);
    boxA.appendChild(boxAHead);
    var subA = el('div', 'pair-dir', 'Folder: ' + e.s.dir + ' · Changed in ' + plural(e.s.changes, 'commit') + (e.s.author ? ' · Top author: ' + e.s.author : ''));
    boxA.appendChild(subA);
    pairContainer.appendChild(boxA);

    var wire = el('div', 'pair-wire');
    wire.appendChild(el('span', 'swatch ' + e.d.relationship));
    wire.appendChild(el('span', '', plural(e.d.shared, 'shared commit')));
    wire.appendChild(el('span', 'swatch ' + e.d.relationship));
    pairContainer.appendChild(wire);

    var boxB = el('div', 'pair-box');
    var boxBHead = el('div', 'pair-box-head');
    var linkB = el('button', 'file-link', e.t.path);
    linkB.type = 'button';
    linkB.addEventListener('click', function () { selectNode(e.t); });
    boxBHead.appendChild(linkB);
    boxB.appendChild(boxBHead);
    var subB = el('div', 'pair-dir', 'Folder: ' + e.t.dir + ' · Changed in ' + plural(e.t.changes, 'commit') + (e.t.author ? ' · Top author: ' + e.t.author : ''));
    boxB.appendChild(subB);
    pairContainer.appendChild(boxB);

    panel.appendChild(pairContainer);

    // Directional Co-Change Cards
    var grid = el('div', 'cochange-grid');
    var card1 = el('div', 'cochange-card');
    card1.appendChild(el('div', 'cochange-pct', pct(e.d.confidence)));
    var desc1 = (e.d.weighted ? '(recency-weighted) ' : '') + labels[0] + ' changes also modified ' + labels[1] + ' (' + e.d.shared + ' of ' + e.d.fromChanges + ' commits)';
    card1.appendChild(el('div', 'cochange-label', desc1));
    grid.appendChild(card1);

    var card2 = el('div', 'cochange-card');
    card2.appendChild(el('div', 'cochange-pct', pct(e.d.reverseConfidence)));
    var desc2 = (e.d.weighted ? '(recency-weighted) ' : '') + labels[1] + ' changes also modified ' + labels[0] + ' (' + e.d.shared + ' of ' + e.d.toChanges + ' commits)';
    card2.appendChild(el('div', 'cochange-label', desc2));
    grid.appendChild(card2);
    panel.appendChild(grid);

    // Why it matters
    var callout = el('div', 'callout ' + e.d.relationship);
    callout.appendChild(el('div', 'callout-title', 'Why it matters'));
    var p1 = el('p');
    p1.textContent = 'These files have been updated together before. If you\'re making changes to one, consider reviewing both.';
    callout.appendChild(p1);

    var p2 = el('p');
    if (e.d.relationship === 'ghost') {
      p2.textContent = 'No direct or supported indirect import relationship found in the current code. Based on ' + plural(e.d.shared, 'shared commit') + ', so this is an investigative clue rather than a confirmed compile-time dependency.';
    } else if (e.d.relationship === 'indirect') {
      p2.textContent = 'Connected indirectly through intermediate files in the dependency tree.';
    } else if (e.d.relationship === 'direct') {
      p2.textContent = 'Connected by a direct import link in the current codebase.';
    } else if (e.d.relationship === 'test') {
      p2.textContent = 'Recognized test and implementation pair.';
    } else {
      p2.textContent = 'Import relationship status could not be fully verified from static imports.';
    }
    callout.appendChild(p2);

    if (e.d.crossesDirectories && !(e.d.hiddenBridge && e.d.hiddenBridge.signal === 'parallel-implementation')) {
      var p3 = el('p');
      p3.textContent = 'Connects different parts of the project (' + e.s.dir + ' and ' + e.t.dir + ').';
      callout.appendChild(p3);
    }
    panel.appendChild(callout);

    function renderFilePatchBlock(patch) {
      var wrap = el('div', 'patch-file');
      var titleText = patch.canonicalPath;
      if (patch.oldPath && patch.oldPath !== patch.path) {
        titleText += ' [' + patch.status + ': ' + patch.oldPath + ' → ' + patch.path + ']';
      } else if (patch.path && patch.path !== patch.canonicalPath) {
        titleText += ' [' + patch.status + ' at ' + patch.path + ']';
      } else if (patch.status) {
        titleText += ' [' + patch.status + ']';
      }
      wrap.appendChild(el('div', 'patch-file-title', titleText));
      if (!patch.hunks || patch.hunks.length === 0) {
        wrap.appendChild(el('div', 'patch-note', patch.statusNote || 'No textual diff hunks'));
        return wrap;
      }
      var hasUnexplainedHunkTruncation = false;
      patch.hunks.forEach(function (hunk) {
        var box = el('div', 'patch-hunk');
        box.appendChild(el('div', 'patch-hunk-hdr', hunk.header));
        hunk.lines.forEach(function (line) {
          var cls = 'patch-line';
          if (line.charAt(0) === '+') cls += ' add';
          else if (line.charAt(0) === '-') cls += ' del';
          box.appendChild(el('div', cls, line));
        });
        if (hunk.omittedLines > 0) {
          box.appendChild(el('div', 'patch-note', '… (' + plural(hunk.omittedLines, 'line') + ' omitted in hunk)'));
        } else if (hunk.truncated) {
          hasUnexplainedHunkTruncation = true;
        }
        wrap.appendChild(box);
      });
      if (patch.omittedHunks > 0) {
        var hunkCountStr = patch.rawTruncated
          ? patch.omittedHunks.toLocaleString('en-US') + '+ additional hunk' + (patch.omittedHunks === 1 ? '' : 's')
          : plural(patch.omittedHunks, 'additional hunk');
        wrap.appendChild(el('div', 'patch-note', '… (' + hunkCountStr + ' omitted)'));
      }
      var unexplained = patch.timedOut || patch.rawTruncated || (patch.truncated && !patch.omittedHunks && (!patch.omittedLines || hasUnexplainedHunkTruncation));
      if (unexplained) {
        var reason = patch.timedOut ? 'time limit' : 'byte/time limit';
        wrap.appendChild(el('div', 'patch-note', '… (patch truncated due to ' + reason + ')'));
      }
      return wrap;
    }

    // Supporting Commits
    if (e.d.evidence && e.d.evidence.length > 0) {
      var details = el('details', 'evidence-wrap');
      details.open = true;
      details.appendChild(el('summary', '', 'View ' + e.d.evidence.length + ' supporting commit' + (e.d.evidence.length === 1 ? '' : 's')));
      var list = el('ul', 'evidence');
      e.d.evidence.forEach(function (ev) {
        var li = el('li');
        var hash = el('button', 'hash', ev.hash.slice(0, 7));
        hash.type = 'button'; hash.title = 'Copy full commit hash';
        hash.addEventListener('click', function () { copyText(ev.hash, hash, 'Copied'); });
        li.appendChild(hash);

        var body = el('div', 'evidence-item-body');
        body.appendChild(el('div', '', ev.date + '  ' + ev.subject));
        var renameParts = [];
        if (ev.sourcePath && ev.sourcePath !== e.s.path) renameParts.push(labels[0] + ' was ' + ev.sourcePath);
        if (ev.targetPath && ev.targetPath !== e.t.path) renameParts.push(labels[1] + ' was ' + ev.targetPath);
        if (renameParts.length > 0) {
          body.appendChild(el('div', 'evidence-rename', 'Historical path: ' + renameParts.join(' · ')));
        }
        li.appendChild(body);

        if (ev.patches && ev.patches.source && ev.patches.target) {
          var patchDetails = el('details', 'patch-details');
          patchDetails.appendChild(el('summary', '', 'Inspect bounded patch hunks'));
          patchDetails.appendChild(renderFilePatchBlock(ev.patches.source));
          patchDetails.appendChild(renderFilePatchBlock(ev.patches.target));
          patchDetails.appendChild(el('div', 'patch-note', 'Historical patches show what changed in the same commit, not proof of why the files changed together.'));
          li.appendChild(patchDetails);
        }
        list.appendChild(li);
      });
      details.appendChild(list);
      panel.appendChild(details);
    }

    // Counterexamples ("When one changed without the other")
    var cx = e.d.counterexamples;
    if (cx && ((cx.fromOnly && cx.fromOnly.length > 0) || (cx.toOnly && cx.toOnly.length > 0))) {
      var cxDetails = el('details', 'evidence-wrap');
      cxDetails.appendChild(el('summary', '', 'When one changed without the other'));
      var appendCounterSide = function (titleText, items, total) {
        if (!items || items.length === 0) return;
        var countNum = typeof total === 'number' && total >= items.length ? total : items.length;
        var suffix = countNum > items.length
          ? ' (showing ' + items.length + ' of ' + countNum + ')'
          : ' (' + plural(countNum, 'commit') + ')';
        var grp = el('div', 'counterexample-group');
        grp.appendChild(el('div', 'counterexample-title', titleText + suffix));
        var ul = el('ul', 'evidence');
        items.forEach(function (item) {
          var li = el('li');
          var hash = el('button', 'hash', item.hash.slice(0, 7));
          hash.type = 'button'; hash.title = 'Copy full commit hash';
          hash.addEventListener('click', function () { copyText(item.hash, hash, 'Copied'); });
          li.appendChild(hash);
          li.appendChild(el('span', '', item.date + '  ' + item.subject));
          ul.appendChild(li);
        });
        grp.appendChild(ul);
        cxDetails.appendChild(grp);
      };
      appendCounterSide(labels[0] + ' without ' + labels[1], cx.fromOnly, cx.fromOnlyTotal);
      appendCounterSide(labels[1] + ' without ' + labels[0], cx.toOnly, cx.toOnlyTotal);
      panel.appendChild(cxDetails);
    }

    // Copyable CLI explain command + privacy note
    var cliCmd = e.d.explainCommand || ('npx repo-archaeology explain ' + e.s.path + ' ' + e.t.path);
    var cliBox = el('div', 'cli-box');
    var cliHead = el('div', 'cli-box-head');
    cliHead.appendChild(el('span', 'cli-box-label', 'Inspect paired diffs locally'));
    var copyCliBtn = el('button', 'btn-cli-copy', 'Copy CLI command');
    copyCliBtn.type = 'button';
    copyCliBtn.addEventListener('click', function () {
      copyText(cliCmd, copyCliBtn, '✓ Copied');
    });
    cliHead.appendChild(copyCliBtn);
    cliBox.appendChild(cliHead);
    cliBox.appendChild(el('code', 'cli-code', cliCmd));
    var privacyText = data.patchesIncluded
      ? 'Historical patches show what changed in the same commit, not proof of why the files changed together.'
      : 'Source-code patches are omitted by default. This file still contains file paths, commit subjects and author names. Run the CLI command above locally, or pass --include-patches when generating the map.';
    cliBox.appendChild(el('div', 'privacy-note', privacyText));
    panel.appendChild(cliBox);

    // Export button
    var exportBtn = el('button', 'btn-export', '📋 Copy finding for PR / discussion');
    exportBtn.type = 'button';
    exportBtn.addEventListener('click', function () {
      var markdown = formatFindingMarkdown(e);
      copyText(markdown, exportBtn, '✓ Copied finding to clipboard');
    });
    panel.appendChild(exportBtn);
  }

  function renderSelectedNode(n) {
    var backBtn = el('button', 'back-btn', '← Back to overview');
    backBtn.type = 'button';
    backBtn.addEventListener('click', clearSelection);
    panel.appendChild(backBtn);

    panel.appendChild(el('h2', '', base(n.path)));
    panel.appendChild(el('p', 'path', n.path));
    var who = n.author ? ' Most commits by ' + n.author + ' (' + pct(n.share || 0) + ').' : '';
    panel.appendChild(el('p', '', 'Folder: ' + n.dir + ' · Changed in ' + plural(n.changes, 'commit') + '.' + who));

    var rels = n.edges.filter(isVisible).sort(function (a, b) { return b.d.shared - a.d.shared; });
    panel.appendChild(el('h3', '', 'Connected file relationships (' + rels.length + ')'));

    if (rels.length === 0) {
      panel.appendChild(el('p', '', 'Its relationships are hidden by the filters above.'));
    } else {
      var cardsContainer = el('div');
      rels.forEach(function (e) {
        cardsContainer.appendChild(relationshipCard(e));
      });
      panel.appendChild(cardsContainer);
    }
  }

  function renderPanel() {
    panel.textContent = '';
    if (selectedNode) {
      renderSelectedNode(selectedNode);
    } else if (selectedEdge) {
      renderSelectedEdge(selectedEdge);
    } else {
      renderOverview();
    }
  }

  // ---- start ---------------------------------------------------------------
  if (reduceMotion) { while (alpha > 0.02) tick(); }
  else { for (var w = 0; w < 120; w++) tick(); }
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) requestDraw(); });
  resize();
  fit();
  renderPanel();
  requestDraw();
})();
`;
