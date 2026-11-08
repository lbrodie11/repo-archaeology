#!/usr/bin/env node
/**
 * RA-17 Part 1 — Design Concepts Generator (`scripts/design-concepts.mjs`)
 *
 * Usage:
 *   node --import tsx scripts/design-concepts.mjs --repo /path/to/hono
 *   node scripts/design-concepts.mjs --repo /path/to/hono
 *
 * 1. Runs `buildMapData` on `--repo` using default `map` options (`edges: 150`,
 *    `kinds: ['ghost', 'unknown', 'indirect', 'direct']`, `uncheckedCap: 15`).
 * 2. Writes `docs/design/ra-17/hono.mapdata.json`.
 * 3. Renders static HTML concepts using ONLY real `MapData` fields and `src/map/copy.ts` templates:
 *    - `docs/design/ra-17/concept-a.html` (Concept A: Investigation Board)
 *    - `docs/design/ra-17/concept-b.html` (Concept B: Storyboard)
 *    - `docs/design/ra-17/concept-empty.html` (First-class Empty State)
 * 4. Renders Playwright screenshots (`deviceScaleFactor: 2`) at:
 *    - `1440×900` light and dark for Concept A and Concept B
 *    - `390×844` mobile light for Concept A and Concept B
 *    - `1440×900` light for the Empty State (`concept-empty-desktop-light.png`)
 *    - Side-by-side comparison sheets (`side-by-side-concept-a.png`, `side-by-side-concept-b.png`,
 *      and `side-by-side-comparison.png`) comparing RA-16 rich, the concept, and FRAME/12's `social-hero.png`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Auto-bootstrap with `--import tsx` if invoked via plain `node scripts/design-concepts.mjs`
const hasTsx =
  process.execArgv.some((arg) => arg.includes('tsx')) ||
  (process.env.NODE_OPTIONS ?? '').includes('tsx');
if (!hasTsx) {
  const res = spawnSync(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
  process.exit(res.status ?? 1);
}

const { chromium } = await import('playwright');
const { loadContext } = await import('../src/context.js');
const { buildMapData } = await import('../src/commands/map.js');
const { sanitizeHtmlDisplayText } = await import('../src/style/frame12.js');
const {
  buildRankedFindings,
  computeFeaturedPlateLayout,
  formatBalloonCallout,
  formatDirectionMetric,
  formatEmptyStateCopy,
  formatEvidencePanelCopy,
  formatFamilyHeadline,
  formatPairHeadline,
  HOW_TO_READ_BODY,
  HOW_TO_READ_SUMMARY,
  resolveStrongerDirection,
  selectFeaturedFinding,
  STATUS_CHIP_EVIDENCE,
} = await import('../src/map/copy.js');

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT_DIR, 'docs', 'design', 'ra-17');
const FONTS_DIR = join(ROOT_DIR, 'assets', 'fonts');

function parseArgs(argv) {
  let repo = '/tmp/hono-ra17';
  let skipScreenshots = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo' && argv[i + 1]) {
      repo = resolve(argv[++i]);
    } else if (arg.startsWith('--repo=')) {
      repo = resolve(arg.slice('--repo='.length));
    } else if (arg === '--no-screenshots') {
      skipScreenshots = true;
    }
  }
  return { repo, skipScreenshots };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function loadEmbeddedFontsCss() {
  const delaB64 = readFileSync(join(FONTS_DIR, 'dela-gothic-one-400.woff2')).toString('base64');
  const mono500B64 = readFileSync(join(FONTS_DIR, 'm-plus-1-code-500.woff2')).toString('base64');
  const mono700B64 = readFileSync(join(FONTS_DIR, 'm-plus-1-code-700.woff2')).toString('base64');

  return `
@font-face {
  font-family: "Dela Gothic One";
  font-style: normal;
  font-weight: 400;
  font-display: block;
  src: url("data:font/woff2;base64,${delaB64}") format("woff2");
}
@font-face {
  font-family: "M PLUS 1 Code";
  font-style: normal;
  font-weight: 500;
  font-display: block;
  src: url("data:font/woff2;base64,${mono500B64}") format("woff2");
}
@font-face {
  font-family: "M PLUS 1 Code";
  font-style: normal;
  font-weight: 700;
  font-display: block;
  src: url("data:font/woff2;base64,${mono700B64}") format("woff2");
}
@font-face {
  font-family: "f12DisplayFallback";
  src: local("Arial"), local("Helvetica Neue"), local("Helvetica"), local("Liberation Sans"), local("Roboto");
  font-weight: 400;
  size-adjust: 131.74%;
  ascent-override: 88.05%;
  descent-override: 21.86%;
  line-gap-override: 0%;
}
@font-face {
  font-family: "f12MonoFallback";
  src: local("Menlo"), local("DejaVu Sans Mono"), local("Courier New"), local("Consolas");
  font-weight: 400;
  size-adjust: 83.19%;
  ascent-override: 120.21%;
  descent-override: 28.25%;
  line-gap-override: 0%;
}
`;
}

function getOflComment() {
  const oflText = readFileSync(join(FONTS_DIR, 'OFL.txt'), 'utf8').trim();
  const firstParagraphs = oflText.split('\n').slice(0, 18).join('\n');
  return `<!--
  Embedded typefaces (SIL Open Font License 1.1 — see assets/fonts/OFL.txt):
${firstParagraphs
  .split('\n')
  .map((l) => `  ${l}`)
  .join('\n')}
-->`;
}

function buildSharedStyles(fontsCss) {
  return `
${fontsCss}
:root,
:root[data-theme="light"] {
  --font-f-display: "Dela Gothic One", "f12DisplayFallback", "Arial Black", sans-serif;
  --font-f-body: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-f-mono: "M PLUS 1 Code", "f12MonoFallback", ui-monospace, "SF Mono", Menlo, Consolas, monospace;

  --f-gutter-pair: 12px;
  --f-gutter-scene: 20px;
  --f-gutter-change: 32px;
  --f-stroke: 2.5px;
  --f-pose: 83.33ms;

  --f-desk: #e2e3e5;
  --f-sheet: #ffffff;
  --f-panel: #ffffff;
  --f-ink: #121212;
  --f-ink-2: #4b4b4b;
  --f-rule: #121212;
  --f-tone: #121212;
  --f-grid: #e3e3e3;
  --f-marker: #ffd60a;
  --f-marker-ink: #121212;
  --f-hole: #e2e3e5;

  /* Repo Archaeology Cyanotype Plate tokens */
  --plate-ground: #13304f;
  --plate-ground-deep: #0e2540;
  --plate-grid-major: rgba(159, 180, 204, 0.12);
  --plate-grid-minor: rgba(159, 180, 204, 0.05);
  --plate-chalk: #fffef9;
  --plate-chalk-faded: #b8cde3;
  --plate-tape: #ff4f9a;
  --plate-unchecked: #8fa6c0;
  --plate-indirect: #a0c8f0;
  --plate-import: rgba(232, 238, 245, 0.62);
  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --f-desk: #000000;
    --f-sheet: #050505;
    --f-panel: #19191a;
    --f-ink: #f1f0ea;
    --f-ink-2: #b9b8b1;
    --f-rule: #f1f0ea;
    --f-tone: #f1f0ea;
    --f-grid: #2c2c2d;
    --f-marker: #ffd60a;
    --f-marker-ink: #121212;
    --f-hole: #000000;
    --plate-ground: #0e2540;
    --plate-ground-deep: #09192c;
    color-scheme: dark;
  }
}

:root[data-theme="dark"] {
  --f-desk: #000000;
  --f-sheet: #050505;
  --f-panel: #19191a;
  --f-ink: #f1f0ea;
  --f-ink-2: #b9b8b1;
  --f-rule: #f1f0ea;
  --f-tone: #f1f0ea;
  --f-grid: #2c2c2d;
  --f-marker: #ffd60a;
  --f-marker-ink: #121212;
  --f-hole: #000000;
  --plate-ground: #0e2540;
  --plate-ground-deep: #09192c;
  color-scheme: dark;
}

*, *::before, *::after {
  box-sizing: border-box;
}

html, body {
  margin: 0;
  padding: 0;
  background: var(--f-desk);
  color: var(--f-ink);
  font-family: var(--font-f-body);
  font-size: 14px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}

.f12-desk {
  min-height: 100vh;
  padding: 8px 14px 24px;
}

.f12-sheet {
  max-width: 1408px;
  margin: 0 auto;
  background: var(--f-sheet);
  border: var(--f-stroke) solid var(--f-rule);
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.05), 0 18px 40px -26px rgba(0, 0, 0, 0.5);
  padding: 6px 18px 20px;
  position: relative;
}

/* Registration peg holes at top of sheet */
.f12-pegs {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 56px;
  height: 10px;
  margin-bottom: 4px;
}
.f12-peg {
  background: var(--f-hole);
  border: 1.5px solid var(--f-rule);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.25);
}
.f12-peg.round {
  width: 9px;
  height: 9px;
  border-radius: 999px;
}
.f12-peg.slot {
  width: 24px;
  height: 7px;
  border-radius: 4px;
}

/* Compact Masthead & Toolbar */
.f12-masthead {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding-bottom: 7px;
  border-bottom: var(--f-stroke) solid var(--f-rule);
  margin-bottom: 10px;
}
.f12-brand-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.f12-case-tag {
  font-family: var(--font-f-mono);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--f-ink);
}
.f12-repo-pill {
  font-family: var(--font-f-mono);
  font-size: 12px;
  font-weight: 700;
  padding: 2px 8px;
  border: 1.5px solid var(--f-rule);
  background: var(--f-panel);
  color: var(--f-ink);
}
.f12-status-kicker {
  font-family: var(--font-f-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 3px 8px;
  background: var(--f-marker);
  color: var(--f-marker-ink);
  border: 1.5px solid var(--f-rule);
}

.f12-how-to-read {
  font-family: var(--font-f-mono);
  font-size: 11.5px;
  color: var(--f-ink-2);
  position: relative;
}
.f12-how-to-read summary {
  cursor: pointer;
  list-style: none;
  padding: 3px 8px;
  border: 1px dashed var(--f-rule);
  font-weight: 700;
  color: var(--f-ink);
  min-height: 24px;
  display: inline-flex;
  align-items: center;
}
.f12-how-to-read summary::-webkit-details-marker {
  display: none;
}
.f12-how-to-read-pop {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 40;
  width: min(460px, 90vw);
  padding: 10px 12px;
  background: var(--f-panel);
  border: 2px solid var(--f-rule);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.24);
  font-family: var(--font-f-body);
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--f-ink);
}

.f12-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.f12-search-input {
  font-family: var(--font-f-mono);
  font-size: 12px;
  padding: 4px 10px;
  min-height: 28px;
  width: 170px;
  border: 1.5px solid var(--f-rule);
  background: var(--f-panel);
  color: var(--f-ink);
}
.f12-seg {
  display: inline-flex;
  flex-wrap: wrap;
  border: 1.5px solid var(--f-rule);
  background: var(--f-panel);
  max-width: 100%;
}
.f12-seg-btn {
  font-family: var(--font-f-mono);
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  padding: 4px 9px;
  min-height: 26px;
  min-width: 24px;
  border: 0;
  background: transparent;
  color: var(--f-ink-2);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.f12-seg-btn + .f12-seg-btn {
  border-left: 1.5px solid var(--f-rule);
}
.f12-seg-btn[aria-pressed="true"],
.f12-seg-btn[aria-selected="true"] {
  background: var(--f-ink);
  color: var(--f-sheet);
}

/* Panels & SVG Polygon Borders */
.f12-panel {
  position: relative;
  background: var(--f-panel);
  padding: 12px 14px;
  min-width: 0;
}
.f12-panel.f12-slant-bottom {
  padding-bottom: 20px;
}
.f12-panel.f12-slant-top {
  padding-top: 20px;
}
.f12-panel-frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  display: block;
  overflow: visible;
}
.f12-panel-frame polygon {
  fill: none;
  stroke: var(--f-rule);
  stroke-width: 2.5px;
  stroke-linejoin: miter;
  vector-effect: non-scaling-stroke;
}
.f12-cut {
  position: absolute;
  top: -8px;
  left: 16px;
  padding: 0 6px;
  background: var(--f-sheet);
  font-family: var(--font-f-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  line-height: 1.2;
  color: var(--f-ink);
  z-index: 4;
}
.f12-panel.f12-slant-top > .f12-cut {
  top: 4px;
}
.f12-panel-body {
  position: relative;
  z-index: 2;
  min-width: 0;
}

/* Kicker chips & headings */
.f12-kicker-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  margin-bottom: 6px;
}
.f12-kicker-left {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.f12-kicker-chip {
  font-family: var(--font-f-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 3px 8px;
  background: var(--f-marker);
  color: var(--f-marker-ink);
  border: 1.5px solid var(--f-rule);
}
.f12-tag {
  font-family: var(--font-f-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 2px 7px;
  border: 1.5px solid var(--f-rule);
  background: var(--f-sheet);
  color: var(--f-ink);
}
.f12-last-date {
  font-family: var(--font-f-mono);
  font-size: 11.5px;
  font-weight: 700;
  color: var(--f-ink-2);
}

.f12-headline {
  font-family: var(--font-f-display);
  font-weight: 400;
  font-size: clamp(20px, 2.05vw, 27px);
  line-height: 1.12;
  letter-spacing: 0.01em;
  margin: 0 0 4px;
  color: var(--f-ink);
  overflow-wrap: anywhere;
  word-break: break-word;
}
.f12-headline code,
.f12-mono-token {
  font-family: var(--font-f-mono);
  font-weight: 700;
  font-size: 0.9em;
  padding: 1px 6px;
  border: 1.5px solid var(--f-rule);
  background: var(--f-sheet);
}
.f12-subhead {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.4;
  color: var(--f-ink-2);
  max-width: 95ch;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.f12-subhead code {
  font-family: var(--font-f-mono);
  font-weight: 700;
  font-size: 12.5px;
  color: var(--f-ink);
}

/* Big-number Metric strip (Concept A) */
.f12-stat-band {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--f-gutter-pair);
  margin-bottom: 10px;
}
.f12-stat-card {
  position: relative;
  border: 2px solid var(--f-rule);
  background: var(--f-panel);
  padding: 6px 12px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  min-width: 0;
}
.f12-stat-card.f12-stat-featured::before {
  content: "";
  position: absolute;
  inset: 0 0 auto 0;
  height: 6px;
  background-image: repeating-linear-gradient(
    -45deg,
    var(--f-tone) 0,
    var(--f-tone) 1.25px,
    transparent 1.25px,
    transparent 5px
  );
  border-bottom: 1.5px solid var(--f-rule);
}
.f12-stat-card.f12-stat-featured {
  padding-top: 11px;
}
.f12-m-label {
  font-family: var(--font-f-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--f-ink-2);
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.f12-ink-sq {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  background: var(--f-ink);
  color: var(--f-sheet);
  border: 1.5px solid var(--f-rule);
  font-size: 11px;
  line-height: 1;
}
.f12-m-value {
  font-family: var(--font-f-display);
  font-size: 26px;
  line-height: 1.06;
  margin: 2px 0 1px;
  color: var(--f-ink);
  font-variant-numeric: tabular-nums;
}
.f12-m-note {
  font-family: var(--font-f-mono);
  font-size: 11px;
  color: var(--f-ink-2);
  margin: 0;
}

/* Cyanotype Plate */
.f12-plate-wrap {
  position: relative;
  border: 2.5px solid var(--f-rule);
  background: var(--plate-ground);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.f12-plate-canvas-box {
  position: relative;
  width: 100%;
  height: 274px;
}
.f12-plate-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
.f12-plate-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
  padding: 5px 10px;
  background: var(--plate-ground-deep);
  border-top: 1.5px solid rgba(159, 180, 204, 0.25);
  color: var(--plate-chalk-faded);
  font-family: var(--font-f-mono);
  font-size: 11px;
}
.f12-plate-legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.f12-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--plate-chalk);
  font-size: 11px;
}

/* Speech Balloon Callout on the Plate (ported from balloon.tsx) */
.f12-balloon-standalone {
  position: absolute;
  z-index: 10;
  pointer-events: none;
  transform: translate(-50%, -100%);
  display: flex;
  flex-direction: column;
  align-items: center;
}
.f12-balloon {
  position: relative;
  background: #ffffff;
  color: #121212;
  border: 2.5px solid #121212;
  padding: 4px 10px;
  font-family: var(--font-f-mono);
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
  white-space: nowrap;
  box-shadow: 3px 3px 0 rgba(0, 0, 0, 0.35);
}
.f12-balloon-gap {
  position: absolute;
  bottom: -3px;
  width: 10px;
  height: 4px;
  background: #ffffff;
}
.f12-balloon-standalone-svg {
  display: block;
  margin-top: -2px;
  overflow: visible;
}
.f12-tail {
  fill: #ffffff;
  stroke: #121212;
  stroke-width: 2.5px;
  stroke-linejoin: miter;
}
.f12-peak-dot {
  fill: var(--f-marker);
  stroke: #121212;
  stroke-width: 2px;
}

/* Evidence Panel Inside / Beside Hero */
.f12-dir-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 8px;
}
.f12-dir-card {
  border: 2px solid var(--f-rule);
  background: var(--f-sheet);
  padding: 7px 10px;
}
.f12-dir-route {
  font-family: var(--font-f-mono);
  font-size: 11px;
  font-weight: 700;
  color: var(--f-ink-2);
  margin: 0 0 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.f12-dir-pct {
  font-family: var(--font-f-display);
  font-size: 24px;
  line-height: 1.08;
  color: var(--f-ink);
  margin: 0 0 2px;
}
.f12-dir-detail {
  font-family: var(--font-f-mono);
  font-size: 11px;
  color: var(--f-ink-2);
  margin: 0;
}

.f12-meta-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.f12-meta-pill {
  font-family: var(--font-f-mono);
  font-size: 11px;
  padding: 2px 7px;
  border: 1px solid var(--f-rule);
  background: var(--f-sheet);
  color: var(--f-ink);
}

.f12-cx-details {
  border: 1.5px solid var(--f-rule);
  background: var(--f-sheet);
  padding: 4px 8px;
  margin-bottom: 8px;
  font-family: var(--font-f-mono);
  font-size: 11px;
}
.f12-cx-details summary {
  cursor: pointer;
  font-weight: 700;
  color: var(--f-ink);
}
.f12-cx-list {
  margin: 6px 0 2px;
  padding-left: 16px;
  color: var(--f-ink-2);
}

/* Receipts List (ported from receipt.tsx) */
.f12-receipts-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}
.f12-receipts-title {
  font-family: var(--font-f-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--f-ink-2);
  margin: 0;
}
.f12-receipt-list {
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
  border-top: 1.5px solid var(--f-rule);
}
.f12-receipt-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: baseline;
  gap: 8px;
  padding: 4px 0;
  border-bottom: 1px solid var(--f-grid);
  font-size: 12px;
  min-width: 0;
}
.f12-receipt-sha {
  font-family: var(--font-f-mono);
  font-size: 11px;
  font-weight: 700;
  padding: 1px 5px;
  border: 1px solid var(--f-rule);
  background: var(--f-sheet);
  color: var(--f-ink);
}
.f12-receipt-subj {
  font-family: var(--font-f-body);
  font-size: 12px;
  color: var(--f-ink);
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.f12-receipt-date {
  font-family: var(--font-f-mono);
  font-size: 11px;
  color: var(--f-ink-2);
  white-space: nowrap;
}

.f12-cli-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 8px;
  border: 1.5px solid var(--f-rule);
  background: var(--f-sheet);
  min-width: 0;
}
.f12-cli-code {
  font-family: var(--font-f-mono);
  font-size: 11px;
  color: var(--f-ink);
  min-width: 0;
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.f12-cli-btn {
  font-family: var(--font-f-mono);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  padding: 3px 8px;
  min-height: 24px;
  border: 1.5px solid var(--f-rule);
  background: var(--f-ink);
  color: var(--f-sheet);
  cursor: pointer;
  white-space: nowrap;
}

/* Tone Range Bars (ported from tone-bar-list.tsx) */
.f12-range-track {
  position: relative;
  display: block;
  width: 100%;
  height: 16px;
  border: 2px solid var(--f-rule);
  background: var(--f-sheet);
}
.f12-range-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  background-image: repeating-linear-gradient(
    -45deg,
    var(--f-tone) 0,
    var(--f-tone) 1.35px,
    transparent 1.35px,
    transparent 5px
  );
  border-left: 1.5px solid var(--f-rule);
  border-right: 1.5px solid var(--f-rule);
}
.f12-range-tick {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 3px;
  transform: translateX(-1.5px);
  background: var(--f-ink);
}

/* Ranked Findings List */
.f12-ranked-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 2px solid var(--f-rule);
}
.f12-ranked-row {
  display: grid;
  grid-template-columns: 54px minmax(200px, 1.5fr) 120px 76px minmax(140px, 1.4fr) 92px;
  align-items: center;
  gap: 12px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--f-grid);
  font-family: var(--font-f-mono);
  font-size: 12px;
}
.f12-ranked-row.f12-ranked-active {
  background-image: repeating-linear-gradient(
    -45deg,
    rgba(18, 18, 18, 0.04) 0,
    rgba(18, 18, 18, 0.04) 2px,
    transparent 2px,
    transparent 7px
  );
  border-left: 4px solid var(--f-rule);
}
.f12-ranked-cut {
  font-family: var(--font-f-mono);
  font-size: 11px;
  font-weight: 700;
  padding: 2px 6px;
  border: 1.5px solid var(--f-rule);
  text-align: center;
  background: var(--f-sheet);
}
.f12-ranked-row.f12-ranked-active .f12-ranked-cut {
  background: var(--f-ink);
  color: var(--f-sheet);
}
.f12-ranked-path {
  font-weight: 700;
  color: var(--f-ink);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.f12-ranked-ratio {
  font-weight: 700;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.f12-ranked-range-col {
  display: flex;
  align-items: center;
  gap: 8px;
}
.f12-ranked-ci-label {
  font-size: 11px;
  color: var(--f-ink-2);
  min-width: 64px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.f12-ranked-date {
  font-size: 11px;
  color: var(--f-ink-2);
  text-align: right;
}

/* Concept A Layout */
.concept-a-hero-grid {
  display: grid;
  grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
  gap: var(--f-gutter-pair);
  margin-bottom: 14px;
  align-items: stretch;
}
.concept-a-secondary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--f-gutter-pair);
  margin-bottom: 42px;
}

/* Concept B Storyboard Layout */
.concept-b-top-grid {
  display: grid;
  grid-template-columns: minmax(0, 8fr) minmax(0, 4fr);
  gap: var(--f-gutter-pair);
  margin-bottom: 18px;
  align-items: stretch;
}
.concept-b-hero-split {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
  gap: var(--f-gutter-pair);
  align-items: start;
}
.concept-b-hero-evidence {
  min-width: 0;
}
.f12-pair {
  display: flex;
  flex-direction: column;
  gap: var(--f-gutter-pair);
  height: 100%;
  min-width: 0;
}
.f12-pair > .f12-panel {
  flex: 1;
}
.concept-b-chip-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1.5px solid var(--f-grid);
}
.concept-b-stat-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 3px 9px;
  border: 1.5px solid var(--f-rule);
  background: var(--f-sheet);
}
.concept-b-stat-num {
  font-family: var(--font-f-display);
  font-size: 18px;
  line-height: 1;
  color: var(--f-ink);
}
.concept-b-stat-lbl {
  font-family: var(--font-f-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--f-ink-2);
}

/* Responsive Mobile (390px) */
@media (max-width: 900px) {
  .f12-desk {
    padding: 4px;
  }
  .f12-sheet {
    padding: 6px 10px 16px;
  }
  .f12-stat-band {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .concept-a-hero-grid,
  .concept-a-secondary-grid,
  .concept-b-top-grid,
  .concept-b-hero-split,
  .f12-dir-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .f12-plate-canvas-box {
    height: 260px !important;
  }
  .f12-balloon {
    font-size: 11px;
    padding: 3px 7px;
  }
  .f12-ranked-row {
    grid-template-columns: 48px minmax(0, 1fr) auto;
    gap: 6px 8px;
  }
  .f12-ranked-range-col {
    grid-column: 1 / -1;
  }
  .f12-ranked-date {
    display: none;
  }
}
`;
}

function renderSvgBorder(shape = 'rect') {
  const pts =
    shape === 'slant-bottom'
      ? '0.35,0.35 99.65,0.35 99.65,93.2 0.35,99.65'
      : shape === 'slant-top'
        ? '0.35,6.8 99.65,0.35 99.65,99.65 0.35,99.65'
        : '0.35,0.35 99.65,0.35 99.65,99.65 0.35,99.65';
  return `<svg class="f12-panel-frame" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polygon vector-effect="non-scaling-stroke" points="${pts}"></polygon></svg>`;
}

function renderBalloonHtml(calloutText, targetX, targetY, plateW, plateH) {
  const pctLeft = Math.max(16, Math.min(84, (targetX / plateW) * 100));
  const pctTop = Math.max(18, Math.min(82, (targetY / plateH) * 100));
  const svgW = 120;
  const svgH = 26;
  const tailX = svgW / 2;
  const px = svgW / 2;
  const py = svgH - 5;

  return `
<div class="f12-balloon-standalone" style="left: ${pctLeft.toFixed(2)}%; top: ${pctTop.toFixed(2)}%;">
  <div class="f12-balloon">
    <span class="f12-balloon-gap" aria-hidden="true" style="left: calc(50% - 5px);"></span>
    ${escapeHtml(calloutText)}
  </div>
  <svg width="${svgW}" height="${svgH}" class="f12-balloon-standalone-svg" aria-hidden="true">
    <path class="f12-tail" d="M${tailX - 6},0 L${px},${py - 7} L${tailX + 6},0"></path>
    <circle class="f12-peak-dot" cx="${px}" cy="${py}" r="4"></circle>
  </svg>
</div>`;
}

function renderToneRangeBar(lowPct, highPct, pointPct) {
  const left = Math.max(0, Math.min(100, lowPct));
  const right = Math.max(left, Math.min(100, highPct));
  const width = Math.max(2, right - left);
  const tick = Math.max(0, Math.min(100, pointPct));
  return `
<span class="f12-range-track" aria-hidden="true">
  <span class="f12-range-fill" style="left: ${left}%; width: ${width}%;"></span>
  <span class="f12-range-tick" style="left: ${tick}%;"></span>
</span>`;
}

function renderMastheadHtml(data, activeConceptLabel) {
  const safeRepo = sanitizeHtmlDisplayText(data.repoName);
  const ghostCount = data.edges.filter((e) => e.relationship === 'ghost').length;
  const unknownCount = data.edges.filter((e) => e.relationship === 'unknown').length;
  const indirectCount = data.edges.filter((e) => e.relationship === 'indirect').length;
  const directCount = data.edges.filter((e) => e.relationship === 'direct').length;

  return `
<div class="f12-pegs" aria-hidden="true">
  <span class="f12-peg round"></span>
  <span class="f12-peg slot"></span>
  <span class="f12-peg round"></span>
</div>
<header class="f12-masthead">
  <div class="f12-brand-row">
    <span class="f12-case-tag">REPO ARCHAEOLOGY // ${escapeHtml(activeConceptLabel)}</span>
    <span class="f12-repo-pill">${escapeHtml(safeRepo)}</span>
    <span class="f12-status-kicker">${escapeHtml(STATUS_CHIP_EVIDENCE)}</span>
    <details class="f12-how-to-read">
      <summary>${escapeHtml(HOW_TO_READ_SUMMARY)}</summary>
      <div class="f12-how-to-read-pop">${escapeHtml(HOW_TO_READ_BODY)}</div>
    </details>
  </div>
  <div class="f12-toolbar" role="toolbar" aria-label="Map controls">
    <input class="f12-search-input" type="search" placeholder="Find a file ( / )" aria-label="Find a file">
    <div class="f12-seg" role="tablist" aria-label="Rich map view">
      <button type="button" class="f12-seg-btn" role="tab" aria-selected="true">Briefing</button>
      <button type="button" class="f12-seg-btn" role="tab" aria-selected="false">Atlas</button>
    </div>
    <div class="f12-seg" role="group" aria-label="Relationship kinds">
      <button type="button" class="f12-seg-btn" aria-pressed="true">Ghost ${ghostCount}</button>
      <button type="button" class="f12-seg-btn" aria-pressed="false">Unchecked ${unknownCount}</button>
      <button type="button" class="f12-seg-btn" aria-pressed="true">Indirect ${indirectCount}</button>
      <button type="button" class="f12-seg-btn" aria-pressed="true">Imports ${directCount}</button>
    </div>
    <button type="button" id="theme-toggle" class="f12-seg-btn" style="border: 1.5px solid var(--f-rule);">Theme</button>
  </div>
</header>`;
}

function renderEvidenceBodyHtml(evCopy) {
  const cxTotal = evCopy.fromOnlyTotal + evCopy.toOnlyTotal;
  const cxItems = [...evCopy.fromOnly, ...evCopy.toOnly].slice(0, 3);

  return `
<div class="f12-dir-grid">
  <div class="f12-dir-card">
    <p class="f12-dir-route" title="${escapeHtml(evCopy.primaryDirection.fromLabel)} → ${escapeHtml(evCopy.primaryDirection.toLabel)}">
      ${escapeHtml(evCopy.primaryDirection.fromLabel)} → ${escapeHtml(evCopy.primaryDirection.toLabel)}
    </p>
    <p class="f12-dir-pct">${escapeHtml(evCopy.primaryDirection.pctText)}</p>
    <p class="f12-dir-detail">${escapeHtml(evCopy.primaryDirection.detailText)}</p>
  </div>
  <div class="f12-dir-card">
    <p class="f12-dir-route" title="${escapeHtml(evCopy.reverseDirection.fromLabel)} → ${escapeHtml(evCopy.reverseDirection.toLabel)}">
      ${escapeHtml(evCopy.reverseDirection.fromLabel)} → ${escapeHtml(evCopy.reverseDirection.toLabel)}
    </p>
    <p class="f12-dir-pct">${escapeHtml(evCopy.reverseDirection.pctText)}</p>
    <p class="f12-dir-detail">${escapeHtml(evCopy.reverseDirection.detailText)}</p>
  </div>
</div>

<div class="f12-meta-pills">
  <span class="f12-meta-pill"><strong>${escapeHtml(evCopy.lastTogetherText)}</strong></span>
  ${
    evCopy.familySummary
      ? `<span class="f12-meta-pill">${evCopy.familySummary.commitsTouchingTwoOrMore} family commits (2+ files) · ${evCopy.familySummary.commitsTouchingAll} touched all ${evCopy.familySummary.members.length}</span>`
      : ''
  }
  ${evCopy.ownerNotes[0] ? `<span class="f12-meta-pill">${escapeHtml(evCopy.ownerNotes[0])}</span>` : ''}
  ${evCopy.originShareNote ? `<span class="f12-meta-pill">${escapeHtml(evCopy.originShareNote)}</span>` : ''}
  ${evCopy.verdictNote ? `<span class="f12-meta-pill">${escapeHtml(evCopy.verdictNote)}</span>` : ''}
</div>

<details class="f12-cx-details">
  <summary>${escapeHtml(evCopy.counterexamplesSummary)} (${escapeHtml(evCopy.primaryDirection.fromLabel)}) · ${escapeHtml(evCopy.reverseCounterexamplesSummary)} (${escapeHtml(evCopy.reverseDirection.fromLabel)}) — ${cxTotal} counterexample commits ▸</summary>
  <ul class="f12-cx-list">
    ${cxItems
      .map(
        (cx) =>
          `<li><code>${escapeHtml(cx.hash.slice(0, 7))}</code> (${escapeHtml(cx.date)}): ${escapeHtml(sanitizeHtmlDisplayText(cx.subject))}</li>`,
      )
      .join('')}
  </ul>
</details>

<div class="f12-receipts-hd">
  <h3 class="f12-receipts-title">Supporting Commit Receipts (${evCopy.receiptsShown.length} of ${evCopy.receiptsTotal})</h3>
</div>
<ul class="f12-receipt-list" aria-label="Supporting commit receipts">
  ${evCopy.receiptsShown
    .map(
      (r) => `
    <li class="f12-receipt-item">
      <code class="f12-receipt-sha" title="${escapeHtml(r.hash)}">${escapeHtml(r.hash.slice(0, 7))}</code>
      <span class="f12-receipt-subj" title="${escapeHtml(sanitizeHtmlDisplayText(r.subject))}">${escapeHtml(sanitizeHtmlDisplayText(r.subject))}</span>
      <span class="f12-receipt-date">${escapeHtml(r.date)}</span>
    </li>`,
    )
    .join('')}
</ul>

<div class="f12-cli-bar">
  <code class="f12-cli-code" title="${escapeHtml(evCopy.explainCommand)}">${escapeHtml(evCopy.explainCommand)}</code>
  <button type="button" class="f12-cli-btn">Copy CLI command</button>
</div>`;
}

function renderSecondaryFindingCard(data, item, cutLabel, shape = 'rect', extraReceipts = false) {
  const edge = data.edges[item.edgeIndex];
  const dir = resolveStrongerDirection(data, edge);
  const receipts = edge.evidence.slice(0, extraReceipts ? 2 : 1);
  return `
<section class="f12-panel f12-${shape}" aria-label="${escapeHtml(cutLabel)} ${escapeHtml(item.title)}">
  ${renderSvgBorder(shape)}
  <span class="f12-cut" aria-hidden="true">${escapeHtml(cutLabel)}</span>
  <div class="f12-panel-body">
    <div class="f12-kicker-row">
      <span class="f12-tag">${item.kind === 'family' ? 'FINDING FAMILY' : 'GHOST WIRE'}</span>
      <span class="f12-last-date">Last together ${escapeHtml(item.lastTogether)}</span>
    </div>
    <h2 style="font-family: var(--font-f-mono); font-size: 14.5px; font-weight: 700; margin: 2px 0 4px; color: var(--f-ink); overflow-wrap: anywhere;">
      ${escapeHtml(item.title)}
    </h2>
    <p style="font-family: var(--font-f-body); font-size: 12px; color: var(--f-ink-2); margin: 0 0 6px;">
      ${escapeHtml(item.subtitle)}
    </p>
    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 6px;">
      <span style="font-family: var(--font-f-display); font-size: 20px; line-height: 1;">${item.pointPct}%</span>
      <div style="flex: 1;">
        ${renderToneRangeBar(item.rangeLowPct, item.rangeHighPct, item.pointPct)}
      </div>
      <span style="font-family: var(--font-f-mono); font-size: 11px; color: var(--f-ink-2);">${item.rangeLowPct}–${item.rangeHighPct}%</span>
    </div>
    ${
      extraReceipts
        ? `<div style="font-family: var(--font-f-mono); font-size: 11px; color: var(--f-ink-2); margin-bottom: 6px;">
            Reverse (${escapeHtml(dir.shortTo)} → ${escapeHtml(dir.shortFrom)}): ${dir.shared} of ${dir.toChanges} (${Math.round(dir.reverseConfidence * 100)}%) · Changed alone: ${dir.fromOnlyTotal + dir.toOnlyTotal} times
          </div>`
        : ''
    }
    ${receipts
      .map(
        (r) =>
          `<div style="font-family: var(--font-f-mono); font-size: 11px; color: var(--f-ink-2); border-top: 1px solid var(--f-grid); padding-top: 4px; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
            <code>${escapeHtml(r.hash.slice(0, 7))}</code> · ${escapeHtml(r.date)} · ${escapeHtml(sanitizeHtmlDisplayText(r.subject))}
          </div>`,
      )
      .join('')}
  </div>
</section>`;
}

function renderRankedListSection(rankedItems, cutLabel = 'C-05') {
  const shown = rankedItems.slice(0, 14);
  return `
<section class="f12-panel f12-rect" aria-label="${escapeHtml(cutLabel)} Ranked Findings">
  ${renderSvgBorder('rect')}
  <span class="f12-cut" aria-hidden="true">${escapeHtml(cutLabel)}</span>
  <div class="f12-panel-body">
    <div class="f12-kicker-row" style="margin-bottom: 10px;">
      <div class="f12-kicker-left">
        <h2 style="font-family: var(--font-f-display); font-size: 18px; margin: 0;">RANKED FINDINGS (${rankedItems.length})</h2>
        <span class="f12-tag">45° SCREENTONE = 95% CONFIDENCE RANGE · TICK = POINT ESTIMATE</span>
      </div>
      <span class="f12-last-date">Ordered by overview priority &amp; Wilson lower bound</span>
    </div>
    <ul class="f12-ranked-list" role="list">
      ${shown
        .map(
          (item, idx) => `
        <li class="f12-ranked-row${idx === 0 ? ' f12-ranked-active' : ''}">
          <span class="f12-ranked-cut">${escapeHtml(item.cutLabel)}</span>
          <span class="f12-ranked-path" title="${escapeHtml(item.fromPath)} ⇢ ${escapeHtml(item.toPath)}">${escapeHtml(item.title)}</span>
          <span class="f12-tag" style="justify-self: start;">${
            item.kind === 'family'
              ? 'FAMILY'
              : item.relationship === 'ghost'
                ? 'GHOST WIRE'
                : item.relationship.toUpperCase()
          }${item.weak ? ' · WEAK' : ''}</span>
          <span class="f12-ranked-ratio">${escapeHtml(item.ratioText)}</span>
          <span class="f12-ranked-range-col">
            ${renderToneRangeBar(item.rangeLowPct, item.rangeHighPct, item.pointPct)}
            <span class="f12-ranked-ci-label">${item.rangeLowPct}–${item.rangeHighPct}%</span>
          </span>
          <span class="f12-ranked-date">${escapeHtml(item.lastTogether)}</span>
        </li>`,
        )
        .join('')}
    </ul>
  </div>
</section>`;
}

function buildPlateDrawScript(plateLayout) {
  return `
<script>
(() => {
  const plate = ${JSON.stringify(plateLayout)};
  const canvas = document.getElementById('featured-plate-canvas');
  if (!canvas) return;

  function hashHue(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return ((h % 360) + 360) % 360;
  }

  function drawPlate() {
    const rect = canvas.getBoundingClientRect();
    const w = rect.width > 0 ? rect.width : plate.width;
    const h = rect.height > 0 ? rect.height : plate.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    ctx.fillStyle = isDark ? '#0e2540' : '#13304f';
    ctx.fillRect(0, 0, w, h);

    // Blueprint survey grid
    ctx.strokeStyle = 'rgba(159, 180, 204, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 20; x < w; x += 20) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
    }
    for (let y = 20; y < h; y += 20) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(159, 180, 204, 0.13)';
    ctx.beginPath();
    for (let x = 80; x < w; x += 80) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
    }
    for (let y = 80; y < h; y += 80) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
    }
    ctx.stroke();

    const scaleX = w / plate.width;
    const scaleY = h / plate.height;
    const nodeByIdx = new Map(plate.nodes.map((n) => [n.nodeIndex, n]));

    // Draw edges (non-featured first, featured on top)
    const orderedEdges = [...plate.edges].sort((a, b) => (a.isFeatured ? 1 : 0) - (b.isFeatured ? 1 : 0));
    for (const e of orderedEdges) {
      const x1 = e.x1 * scaleX;
      const y1 = e.y1 * scaleY;
      const x2 = e.x2 * scaleX;
      const y2 = e.y2 * scaleY;

      if (e.isFeatured) {
        // Marker yellow casing under the featured relationship line
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = '#ffd60a';
        ctx.lineWidth = e.strokeWidth + 4.5;
        ctx.lineCap = 'round';
        ctx.setLineDash([]);
        ctx.stroke();
        ctx.restore();
      }

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.lineWidth = e.isFeatured ? e.strokeWidth + 0.8 : e.strokeWidth;
      ctx.lineCap = 'round';

      if (e.relationship === 'ghost') {
        ctx.strokeStyle = '#ff4f9a';
        ctx.setLineDash([10, 6]);
      } else if (e.relationship === 'unknown') {
        ctx.strokeStyle = '#8fa6c0';
        ctx.setLineDash([2, 5]);
      } else if (e.relationship === 'indirect') {
        ctx.strokeStyle = '#a0c8f0';
        ctx.setLineDash([9, 5]);
      } else {
        ctx.strokeStyle = 'rgba(232, 238, 245, 0.65)';
        ctx.setLineDash([]);
      }
      ctx.stroke();
      ctx.restore();
    }

    // Draw nodes with directory hue fill and paper-colored outline
    for (const n of plate.nodes) {
      const nx = n.x * scaleX;
      const ny = n.y * scaleY;
      const hue = hashHue(n.dir);
      ctx.save();
      ctx.beginPath();
      ctx.arc(nx, ny, n.r, 0, Math.PI * 2);
      ctx.fillStyle = 'hsl(' + hue + ', 64%, 66%)';
      ctx.fill();
      ctx.lineWidth = n.isFeaturedEndpoint ? 2.5 : 1.8;
      ctx.strokeStyle = '#fffef9';
      ctx.stroke();
      ctx.restore();
    }

    // Draw collision-free node labels with 3px halo stroke at >= 12px mono
    ctx.save();
    ctx.font = '700 12.5px "M PLUS 1 Code", ui-monospace, monospace';
    ctx.lineJoin = 'round';
    const placedMobileBoxes = [];
    const balloonEl = document.querySelector('.f12-balloon');
    if (balloonEl) {
      const cRect = canvas.getBoundingClientRect();
      const bRect = balloonEl.getBoundingClientRect();
      if (cRect.width > 0 && bRect.width > 0) {
        placedMobileBoxes.push({
          x: bRect.left - cRect.left - 4,
          y: bRect.top - cRect.top - 4,
          w: bRect.width + 8,
          h: bRect.height + 22,
        });
      }
    }
    for (const n of plate.nodes) {
      const lbl = n.label;
      const nx = n.x * scaleX;
      const ny = n.y * scaleY;
      const textW = ctx.measureText(lbl.text).width;
      const textH = 15;
      let ax = lbl.anchorX * scaleX;
      let ay = lbl.anchorY * scaleY;
      let align = lbl.textAlign;

      let left = align === 'center' ? ax - textW / 2 : align === 'right' ? ax - textW : ax;
      const pad = 8;
      if (left < pad || left + textW > w - pad) {
        // Re-anchor centered above or below the node on narrow viewports so it never clips the canvas border
        align = 'center';
        ax = Math.max(pad + textW / 2, Math.min(w - pad - textW / 2, nx));
        const candYs = [ny + n.r + 15, ny + n.r + 31, ny - n.r - 8, ny - n.r - 24, ny + n.r + 47];
        ay = candYs[0];
        for (const cy of candYs) {
          if (cy < 16 || cy > h - 6) continue;
          const cBox = { x: ax - textW / 2, y: cy - 12, w: textW, h: textH };
          const hit = placedMobileBoxes.some(
            (b) =>
              cBox.x < b.x + b.w + 4 &&
              cBox.x + cBox.w + 4 > b.x &&
              cBox.y < b.y + b.h + 2 &&
              cBox.y + cBox.h + 2 > b.y,
          );
          if (!hit) {
            ay = cy;
            break;
          }
        }
      }
      const finalLeft = align === 'center' ? ax - textW / 2 : align === 'right' ? ax - textW : ax;
      placedMobileBoxes.push({ x: finalLeft, y: ay - 12, w: textW, h: textH });

      ctx.textAlign = align;
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = isDark ? '#09192c' : '#0e2540';
      ctx.strokeText(lbl.text, ax, ay);
      ctx.fillStyle = '#fffef9';
      ctx.fillText(lbl.text, ax, ay);
    }
    ctx.restore();
  }

  drawPlate();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(drawPlate);
  }
  window.addEventListener('resize', drawPlate);
  const themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      document.documentElement.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark');
      drawPlate();
    });
  }
})();
</script>`;
}

function renderConceptAHtml(data, fontsCss, oflComment) {
  const featured = selectFeaturedFinding(data);
  if (featured.kind === 'empty') {
    throw new Error('Expected non-empty featured finding for Concept A on Hono');
  }
  const evCopy = formatEvidencePanelCopy(data, featured, 'C-01');
  const plate = computeFeaturedPlateLayout(data, featured, { width: 760, height: 274 });
  const leadEdge = featured.kind === 'family' ? featured.leadEdge : featured.edge;
  const balloonText = formatBalloonCallout(data, leadEdge);
  const ranked = buildRankedFindings(data);
  const secondary = ranked.slice(1, 4);

  const ghostCount = data.edges.filter((e) => e.relationship === 'ghost').length;
  const uncheckedShown = data.edges.filter((e) => e.relationship === 'unknown').length;
  const uncheckedTotal = data.counts.unknown;
  const familyCount = (data.families ?? []).length;
  const commitsAnalyzed = data.meta.commitsAnalyzed;

  const ariaPlate = `${evCopy.headline}. ${evCopy.subhead}`;

  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="ra-style" content="rich">
<meta name="ra-concept" content="concept-a">
<title>REPO ARCHAEOLOGY // Concept A (Investigation Board) — ${escapeHtml(data.repoName)}</title>
${oflComment}
<style>${buildSharedStyles(fontsCss)}</style>
</head>
<body>
<div class="f12-desk">
  <main class="f12-sheet">
    ${renderMastheadHtml(data, 'CONCEPT A · INVESTIGATION BOARD')}

    <!-- Top Masthead Big-Number Stat Band -->
    <section class="f12-stat-band" aria-label="Repository summary statistics">
      <div class="f12-stat-card f12-stat-featured">
        <h2 class="f12-m-label"><span class="f12-ink-sq" aria-hidden="true">▲</span> GHOST WIRES</h2>
        <p class="f12-m-value">${ghostCount}</p>
        <p class="f12-m-note">co-changing pairs with no import link</p>
      </div>
      <div class="f12-stat-card">
        <h2 class="f12-m-label">FINDING FAMILIES</h2>
        <p class="f12-m-value">${familyCount}</p>
        <p class="f12-m-note">parallel implementation groups (3+ files)</p>
      </div>
      <div class="f12-stat-card">
        <h2 class="f12-m-label">UNCHECKED LINKS</h2>
        <p class="f12-m-value">${uncheckedShown}</p>
        <p class="f12-m-note">${uncheckedTotal} total in repo · ${data.edges.length} links drawn</p>
      </div>
      <div class="f12-stat-card">
        <h2 class="f12-m-label">COMMITS ANALYSED</h2>
        <p class="f12-m-value">${commitsAnalyzed.toLocaleString('en-US')}</p>
        <p class="f12-m-note">${escapeHtml(data.meta.oldestCommit ?? '')} to ${escapeHtml(data.meta.newestCommit ?? '')} · ${data.nodes.length} files</p>
      </div>
    </section>

    <!-- C-01 Featured Investigation Hero + Slanted-Bottom Evidence Panel -->
    <div class="concept-a-hero-grid">
      <section class="f12-panel f12-rect" aria-label="C-01 Most interesting finding">
        ${renderSvgBorder('rect')}
        <span class="f12-cut" aria-hidden="true">C-01</span>
        <div class="f12-panel-body">
          <div class="f12-kicker-row">
            <div class="f12-kicker-left">
              <span class="f12-kicker-chip">${escapeHtml(evCopy.kicker)}</span>
              ${
                evCopy.familySummary
                  ? `<span class="f12-tag">FAMILY · ${evCopy.familySummary.members.length} FILES · ${evCopy.familySummary.qualifyingPairs}/${evCopy.familySummary.possiblePairs} PAIRS</span>`
                  : `<span class="f12-tag">GHOST WIRE</span>`
              }
            </div>
            <span class="f12-last-date">${escapeHtml(evCopy.lastTogetherText)}</span>
          </div>
          <h1 class="f12-headline">${escapeHtml(evCopy.headline)}</h1>
          <p class="f12-subhead">${escapeHtml(evCopy.subhead)}</p>

          <div class="f12-plate-wrap">
            <div class="f12-plate-canvas-box">
              <canvas id="featured-plate-canvas" class="f12-plate-canvas" role="img" aria-label="${escapeHtml(ariaPlate)}"></canvas>
              ${
                plate.balloonTarget
                  ? renderBalloonHtml(
                      balloonText,
                      plate.balloonTarget.x,
                      plate.balloonTarget.y,
                      plate.width,
                      plate.height,
                    )
                  : ''
              }
            </div>
            <div class="f12-plate-footer">
              <div class="f12-plate-legend">
                <span class="f12-legend-item">
                  <svg width="24" height="8" aria-hidden="true"><line x1="0" y1="4" x2="24" y2="4" stroke="#ffd60a" stroke-width="5"/><line x1="0" y1="4" x2="24" y2="4" stroke="#ff4f9a" stroke-width="2.2" stroke-dasharray="6 4"/></svg>
                  Featured ghost wire
                </span>
                <span class="f12-legend-item">
                  <svg width="22" height="8" aria-hidden="true"><line x1="0" y1="4" x2="22" y2="4" stroke="#ff4f9a" stroke-width="2" stroke-dasharray="6 4"/></svg>
                  Ghost wire (long dash)
                </span>
                <span class="f12-legend-item">
                  <svg width="22" height="8" aria-hidden="true"><line x1="0" y1="4" x2="22" y2="4" stroke="#8fa6c0" stroke-width="2" stroke-dasharray="2 4"/></svg>
                  Unchecked (dotted)
                </span>
                <span class="f12-legend-item">
                  <svg width="22" height="8" aria-hidden="true"><line x1="0" y1="4" x2="22" y2="4" stroke="rgba(232,238,245,0.75)" stroke-width="2"/></svg>
                  Import (solid)
                </span>
              </div>
              <span>Ego network (${plate.nodes.length} of ${plate.fullComponentNodeCount} files in component)</span>
            </div>
          </div>
        </div>
      </section>

      <section class="f12-panel f12-slant-bottom" aria-label="Supporting evidence for C-01">
        ${renderSvgBorder('slant-bottom')}
        <span class="f12-cut" aria-hidden="true">EVIDENCE</span>
        <div class="f12-panel-body">
          <div class="f12-kicker-row">
            <span class="f12-tag">DIRECTIONAL CO-CHANGE &amp; RECEIPTS</span>
            <span class="f12-last-date">Lead pair: ${escapeHtml(evCopy.primaryDirection.fromLabel)} ↔ ${escapeHtml(evCopy.primaryDirection.toLabel)}</span>
          </div>
          ${renderEvidenceBodyHtml(evCopy)}
        </div>
      </section>
    </div>

    <!-- Secondary Findings (C-02, C-03, C-04) -->
    <div class="concept-a-secondary-grid">
      ${secondary
        .map((item, idx) => renderSecondaryFindingCard(data, item, `C-0${idx + 2}`, 'rect'))
        .join('')}
    </div>

    <!-- Ranked List (C-05) -->
    ${renderRankedListSection(ranked, 'C-05')}
  </main>
</div>
${buildPlateDrawScript(plate)}
</body>
</html>`;
}

function renderConceptBHtml(data, fontsCss, oflComment) {
  const featured = selectFeaturedFinding(data);
  if (featured.kind === 'empty') {
    throw new Error('Expected non-empty featured finding for Concept B on Hono');
  }
  const evCopy = formatEvidencePanelCopy(data, featured, 'C-01');
  const plate = computeFeaturedPlateLayout(data, featured, { width: 520, height: 274 });
  const leadEdge = featured.kind === 'family' ? featured.leadEdge : featured.edge;
  const balloonText = formatBalloonCallout(data, leadEdge);
  const ranked = buildRankedFindings(data);
  const secondFinding = ranked[1];
  const thirdFinding = ranked[2];

  const ghostCount = data.edges.filter((e) => e.relationship === 'ghost').length;
  const uncheckedShown = data.edges.filter((e) => e.relationship === 'unknown').length;
  const familyCount = (data.families ?? []).length;
  const commitsAnalyzed = data.meta.commitsAnalyzed;
  const ariaPlate = `${evCopy.headline}. ${evCopy.subhead}`;

  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="ra-style" content="rich">
<meta name="ra-concept" content="concept-b">
<title>REPO ARCHAEOLOGY // Concept B (Storyboard) — ${escapeHtml(data.repoName)}</title>
${oflComment}
<style>${buildSharedStyles(fontsCss)}</style>
</head>
<body>
<div class="f12-desk">
  <main class="f12-sheet">
    ${renderMastheadHtml(data, 'CONCEPT B · STORYBOARD')}

    <!-- Asymmetric Comic Page Top: Tall C-01 Hero (8 cols) + Slanted C-02/C-03 Pair (4 cols) -->
    <div class="concept-b-top-grid">
      <section class="f12-panel f12-rect" aria-label="C-01 Hero Investigation Panel">
        ${renderSvgBorder('rect')}
        <span class="f12-cut" aria-hidden="true">C-01</span>
        <div class="f12-panel-body">
          <!-- Stats inside the hero panel as metric chips -->
          <div class="concept-b-chip-strip" aria-label="Repository metrics">
            <div class="concept-b-stat-chip">
              <span class="f12-ink-sq" aria-hidden="true">▲</span>
              <span class="concept-b-stat-num">${ghostCount}</span>
              <span class="concept-b-stat-lbl">GHOST WIRES</span>
            </div>
            <div class="concept-b-stat-chip">
              <span class="concept-b-stat-num">${familyCount}</span>
              <span class="concept-b-stat-lbl">FAMILIES</span>
            </div>
            <div class="concept-b-stat-chip">
              <span class="concept-b-stat-num">${uncheckedShown}</span>
              <span class="concept-b-stat-lbl">UNCHECKED (${data.counts.unknown} TOTAL)</span>
            </div>
            <div class="concept-b-stat-chip">
              <span class="concept-b-stat-num">${commitsAnalyzed.toLocaleString('en-US')}</span>
              <span class="concept-b-stat-lbl">COMMITS ANALYSED</span>
            </div>
          </div>

          <div class="f12-kicker-row">
            <div class="f12-kicker-left">
              <span class="f12-kicker-chip">${escapeHtml(evCopy.kicker)}</span>
              ${
                evCopy.familySummary
                  ? `<span class="f12-tag">FAMILY · ${evCopy.familySummary.members.length} FILES · ${evCopy.familySummary.qualifyingPairs}/${evCopy.familySummary.possiblePairs} PAIRS</span>`
                  : `<span class="f12-tag">GHOST WIRE</span>`
              }
            </div>
            <span class="f12-last-date">${escapeHtml(evCopy.lastTogetherText)}</span>
          </div>
          <h1 class="f12-headline">${escapeHtml(evCopy.headline)}</h1>
          <p class="f12-subhead">${escapeHtml(evCopy.subhead)}</p>

          <div class="concept-b-hero-split">
            <div class="f12-plate-wrap">
              <div class="f12-plate-canvas-box" style="height: 274px;">
                <canvas id="featured-plate-canvas" class="f12-plate-canvas" role="img" aria-label="${escapeHtml(ariaPlate)}"></canvas>
                ${
                  plate.balloonTarget
                    ? renderBalloonHtml(
                        balloonText,
                        plate.balloonTarget.x,
                        plate.balloonTarget.y,
                        plate.width,
                        plate.height,
                      )
                    : ''
                }
              </div>
              <div class="f12-plate-footer">
                <div class="f12-plate-legend">
                  <span class="f12-legend-item">
                    <svg width="20" height="8" aria-hidden="true"><line x1="0" y1="4" x2="20" y2="4" stroke="#ffd60a" stroke-width="5"/><line x1="0" y1="4" x2="20" y2="4" stroke="#ff4f9a" stroke-width="2" stroke-dasharray="5 3"/></svg>
                    Featured
                  </span>
                  <span class="f12-legend-item">
                    <svg width="18" height="8" aria-hidden="true"><line x1="0" y1="4" x2="18" y2="4" stroke="#ff4f9a" stroke-width="2" stroke-dasharray="5 3"/></svg>
                    Ghost
                  </span>
                  <span class="f12-legend-item">
                    <svg width="18" height="8" aria-hidden="true"><line x1="0" y1="4" x2="18" y2="4" stroke="rgba(232,238,245,0.75)" stroke-width="2"/></svg>
                    Import
                  </span>
                </div>
                <span>${plate.nodes.length} files on plate</span>
              </div>
            </div>

            <div class="concept-b-hero-evidence">
              ${renderEvidenceBodyHtml(evCopy)}
            </div>
          </div>
        </div>
      </section>

      <!-- Slanted C-02 / C-03 PanelPair -->
      <div class="f12-pair" aria-label="Next findings C-02 and C-03">
        ${secondFinding ? renderSecondaryFindingCard(data, secondFinding, 'C-02', 'slant-bottom', true) : ''}
        ${thirdFinding ? renderSecondaryFindingCard(data, thirdFinding, 'C-03', 'slant-top', true) : ''}
      </div>
    </div>

    <!-- Full-Width C-04 Ranked List -->
    ${renderRankedListSection(ranked, 'C-04')}
  </main>
</div>
${buildPlateDrawScript(plate)}
</body>
</html>`;
}

function renderConceptEmptyHtml(baseData, fontsCss, oflComment) {
  // Derive a real-data empty-ghost state from Hono's MapData by keeping only import links
  const importEdges = baseData.edges.filter(
    (e) => e.relationship === 'direct' || e.relationship === 'indirect',
  );
  const emptyData = {
    ...baseData,
    counts: {
      ...baseData.counts,
      ghost: 0,
      unknown: 0,
    },
    edges: importEdges,
    families: [],
  };

  const featured = selectFeaturedFinding(emptyData);
  const plate = computeFeaturedPlateLayout(emptyData, featured, { width: 760, height: 320 });
  const emptyCopy = formatEmptyStateCopy(emptyData, {
    nodeCount: plate.nodes.length,
    edgeCount: plate.edges.length,
  });

  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="ra-style" content="rich">
<meta name="ra-concept" content="concept-empty">
<title>REPO ARCHAEOLOGY // Empty State — ${escapeHtml(emptyData.repoName)}</title>
${oflComment}
<style>${buildSharedStyles(fontsCss)}</style>
</head>
<body>
<div class="f12-desk">
  <main class="f12-sheet">
    ${renderMastheadHtml(emptyData, 'EMPTY STATE · NO GHOST WIRES')}

    <section class="f12-stat-band" aria-label="Repository summary statistics">
      <div class="f12-stat-card">
        <h2 class="f12-m-label">GHOST WIRES</h2>
        <p class="f12-m-value">0</p>
        <p class="f12-m-note">none above configured thresholds</p>
      </div>
      <div class="f12-stat-card">
        <h2 class="f12-m-label">IMPORT LINKS</h2>
        <p class="f12-m-value">${importEdges.length}</p>
        <p class="f12-m-note">co-changing files explained by imports</p>
      </div>
      <div class="f12-stat-card">
        <h2 class="f12-m-label">MIN THRESHOLDS</h2>
        <p class="f12-m-value">≥${emptyCopy.minShared} · ${emptyCopy.minConfidencePct}%</p>
        <p class="f12-m-note">shared commits &amp; directional confidence</p>
      </div>
      <div class="f12-stat-card">
        <h2 class="f12-m-label">COMMITS ANALYSED</h2>
        <p class="f12-m-value">${emptyCopy.commits.toLocaleString('en-US')}</p>
        <p class="f12-m-note">${escapeHtml(emptyData.meta.oldestCommit ?? '')} to ${escapeHtml(emptyData.meta.newestCommit ?? '')}</p>
      </div>
    </section>

    <section class="f12-panel f12-rect" aria-label="C-01 Empty state and strongest import cluster">
      ${renderSvgBorder('rect')}
      <span class="f12-cut" aria-hidden="true">C-01</span>
      <div class="f12-panel-body">
        <div class="f12-kicker-row">
          <div class="f12-kicker-left">
            <span class="f12-tag">C-01 / CLEAN DIG · ZERO GHOST WIRES</span>
            <span class="f12-tag">CONTEXT: STRONGEST IMPORT CLUSTER</span>
          </div>
          <span class="f12-last-date">Latest commit ${escapeHtml(emptyData.meta.newestCommit ?? '')}</span>
        </div>
        <h1 class="f12-headline">${escapeHtml(emptyCopy.headline)}</h1>
        <p class="f12-subhead">
          ${escapeHtml(emptyCopy.subhead)}
          ${emptyCopy.contextNote ? ` ${escapeHtml(emptyCopy.contextNote)}` : ''}
        </p>

        <div class="f12-plate-wrap">
          <div class="f12-plate-canvas-box" style="height: 320px;">
            <canvas id="featured-plate-canvas" class="f12-plate-canvas" role="img" aria-label="${escapeHtml(emptyCopy.headline)}. ${escapeHtml(emptyCopy.subhead)}"></canvas>
          </div>
          <div class="f12-plate-footer">
            <div class="f12-plate-legend">
              <span class="f12-legend-item">
                <svg width="22" height="8" aria-hidden="true"><line x1="0" y1="4" x2="22" y2="4" stroke="rgba(232,238,245,0.75)" stroke-width="2"/></svg>
                Direct import link (solid)
              </span>
              <span class="f12-legend-item">
                <svg width="22" height="8" aria-hidden="true"><line x1="0" y1="4" x2="22" y2="4" stroke="#a0c8f0" stroke-width="2" stroke-dasharray="6 4"/></svg>
                Indirect import link (dashed)
              </span>
            </div>
            <span>Try <code>--min-shared 2</code> or <code>--min-confidence 0.3</code> to widen discovery</span>
          </div>
        </div>
      </div>
    </section>
  </main>
</div>
${buildPlateDrawScript(plate)}
</body>
</html>`;
}

async function renderSideBySideSheet(page, outPath, conceptScreenshotPath, conceptTitle) {
  const ra16Path = join(ROOT_DIR, 'docs', 'repo-archaeology-map-rich.png');
  const frame12HeroCandidates = [
    resolve(ROOT_DIR, '..', 'frame12', 'docs', 'images', 'social-hero.png'),
    '/Users/brodie/Workspace/frame12/docs/images/social-hero.png',
  ];
  const frame12HeroPath = frame12HeroCandidates.find((p) => existsSync(p));
  if (!existsSync(ra16Path) || !frame12HeroPath) {
    console.warn('Skipping side-by-side sheet: reference image missing.');
    return;
  }

  const ra16B64 = readFileSync(ra16Path).toString('base64');
  const conceptB64 = readFileSync(conceptScreenshotPath).toString('base64');
  const f12B64 = readFileSync(frame12HeroPath).toString('base64');

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    background: #121212;
    color: #f1f0ea;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    display: inline-block;
  }
  h1 {
    margin: 0 0 16px;
    font-size: 16px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .row {
    display: flex;
    align-items: flex-start;
    gap: 20px;
  }
  .col {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .lbl {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 4px 8px;
    background: #222;
    border: 1.5px solid #f1f0ea;
    display: flex;
    justify-content: space-between;
  }
  .lbl.highlight {
    background: #ffd60a;
    color: #121212;
  }
  img {
    height: 540px;
    width: auto;
    display: block;
    border: 2px solid #f1f0ea;
  }
</style>
</head>
<body>
  <h1>RA-17 DESIGN REVIEW COMPARISON · EQUAL HEIGHT (540 PX)</h1>
  <div class="row">
    <div class="col">
      <div class="lbl"><span>1. BEFORE: RA-16 CONTACT SHEET (v0.4.0)</span><span>25 MINI FRAMES</span></div>
      <img src="data:image/png;base64,${ra16B64}" alt="RA-16 rich map">
    </div>
    <div class="col">
      <div class="lbl highlight"><span>2. PROPOSED: ${escapeHtml(conceptTitle)}</span><span>HONO REAL DATA</span></div>
      <img src="data:image/png;base64,${conceptB64}" alt="${escapeHtml(conceptTitle)}">
    </div>
    <div class="col">
      <div class="lbl"><span>3. REFERENCE: FRAME/12 social-hero.png</span><span>VISUAL GRAMMAR</span></div>
      <img src="data:image/png;base64,${f12B64}" alt="FRAME/12 reference">
    </div>
  </div>
</body>
</html>`;

  await page.setViewportSize({ width: 2800, height: 700 });
  await page.setContent(html, { waitUntil: 'load' });
  const bodyBox = await page.locator('body').boundingBox();
  await page.screenshot({
    path: outPath,
    clip: {
      x: 0,
      y: 0,
      width: Math.ceil(bodyBox.width),
      height: Math.ceil(bodyBox.height),
    },
  });
}

async function main() {
  const { repo, skipScreenshots } = parseArgs(process.argv.slice(2));
  mkdirSync(OUT_DIR, { recursive: true });

  console.log(`Loading repository context from ${repo}…`);
  const ctx = await loadContext(repo, {});
  const data = buildMapData(ctx, {
    edges: 150,
    kinds: ['ghost', 'unknown', 'indirect', 'direct'],
    uncheckedCap: 15,
  });

  const pkgPath = join(repo, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (typeof pkg.name === 'string' && pkg.name.trim()) {
        data.repoName = pkg.name.trim().replace(/^@[^/]+\//, '');
      }
    } catch {
      // keep default repoName
    }
  }

  const mapDataPath = join(OUT_DIR, 'hono.mapdata.json');
  writeFileSync(mapDataPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${mapDataPath} (${data.edges.length} edges, ${data.nodes.length} nodes, ${(data.families ?? []).length} families)`);

  const fontsCss = loadEmbeddedFontsCss();
  const oflComment = getOflComment();

  const conceptAPath = join(OUT_DIR, 'concept-a.html');
  const conceptBPath = join(OUT_DIR, 'concept-b.html');
  const conceptEmptyPath = join(OUT_DIR, 'concept-empty.html');

  writeFileSync(conceptAPath, renderConceptAHtml(data, fontsCss, oflComment), 'utf8');
  writeFileSync(conceptBPath, renderConceptBHtml(data, fontsCss, oflComment), 'utf8');
  writeFileSync(conceptEmptyPath, renderConceptEmptyHtml(data, fontsCss, oflComment), 'utf8');
  console.log(`Wrote ${conceptAPath}, ${conceptBPath}, and ${conceptEmptyPath}`);

  if (skipScreenshots) return;

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();

    for (const [slug, htmlPath] of [
      ['concept-a', conceptAPath],
      ['concept-b', conceptBPath],
    ]) {
      // Desktop Light (1440x900)
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts && document.fonts.ready);
      await page.waitForTimeout(100);
      const lightPath = join(OUT_DIR, `${slug}-desktop-light.png`);
      await page.screenshot({ path: lightPath, fullPage: false });
      console.log(`Wrote ${lightPath}`);

      // Desktop Dark (1440x900)
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'dark');
        window.dispatchEvent(new Event('resize'));
      });
      await page.waitForTimeout(100);
      const darkPath = join(OUT_DIR, `${slug}-desktop-dark.png`);
      await page.screenshot({ path: darkPath, fullPage: false });
      console.log(`Wrote ${darkPath}`);

      // Mobile Light (390x844)
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'light');
        window.dispatchEvent(new Event('resize'));
      });
      await page.waitForTimeout(100);
      const mobilePath = join(OUT_DIR, `${slug}-mobile-light.png`);
      await page.screenshot({ path: mobilePath, fullPage: false });
      console.log(`Wrote ${mobilePath}`);
    }

    // Empty State Desktop Light (1440x900)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(pathToFileURL(conceptEmptyPath).href, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.waitForTimeout(100);
    const emptyLightPath = join(OUT_DIR, 'concept-empty-desktop-light.png');
    await page.screenshot({ path: emptyLightPath, fullPage: false });
    console.log(`Wrote ${emptyLightPath}`);

    // Side-by-side sheets
    const sbsAPath = join(OUT_DIR, 'side-by-side-concept-a.png');
    await renderSideBySideSheet(
      page,
      sbsAPath,
      join(OUT_DIR, 'concept-a-desktop-light.png'),
      'CONCEPT A · INVESTIGATION BOARD',
    );
    console.log(`Wrote ${sbsAPath}`);

    const sbsBPath = join(OUT_DIR, 'side-by-side-concept-b.png');
    await renderSideBySideSheet(
      page,
      sbsBPath,
      join(OUT_DIR, 'concept-b-desktop-light.png'),
      'CONCEPT B · STORYBOARD',
    );
    console.log(`Wrote ${sbsBPath}`);

    await context.close();
  } finally {
    await browser.close();
  }
}

await main();
