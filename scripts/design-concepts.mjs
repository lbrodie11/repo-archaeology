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
  formatCounterexamplesLine,
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

/* Compact Masthead & Toolbar */
.f12-masthead {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding-bottom: 7px;
  border-bottom: var(--f-stroke) solid var(--f-rule);
  margin-bottom: 8px;
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
  white-space: nowrap;
}
.f12-status-calm {
  font-family: var(--font-f-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 3px 8px;
  background: var(--f-panel);
  color: var(--f-ink);
  border: 1.5px solid var(--f-rule);
  white-space: nowrap;
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
  white-space: nowrap;
}
.f12-seg-btn + .f12-seg-btn {
  border-left: 1.5px solid var(--f-rule);
}
.f12-seg-btn[aria-pressed="true"],
.f12-seg-btn[aria-selected="true"] {
  background: var(--f-ink);
  color: var(--f-sheet);
}

/* Compact Inline Stat Strip (shared by Concept A & B) */
.f12-stat-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
  padding: 5px 10px;
  margin-bottom: 10px;
  border: 1.5px solid var(--f-rule);
  background: var(--f-panel);
}
.f12-stat-strip-items {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 14px;
}
.f12-stat-inline {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  font-family: var(--font-f-mono);
  font-size: 11.5px;
  color: var(--f-ink-2);
}
.f12-stat-inline strong {
  font-family: var(--font-f-display);
  font-size: 16px;
  font-weight: 400;
  line-height: 1;
  color: var(--f-ink);
  font-variant-numeric: tabular-nums;
}
.f12-stat-sep {
  color: var(--f-grid);
  font-weight: 700;
}
.f12-stat-window {
  font-family: var(--font-f-mono);
  font-size: 11px;
  color: var(--f-ink-2);
}

/* Panels & SVG Polygon Borders */
.f12-panel {
  position: relative;
  background: var(--f-panel);
  padding: 10px 14px;
  min-width: 0;
}
.f12-panel.f12-slant-bottom {
  padding-bottom: 18px;
}
.f12-panel.f12-slant-top {
  padding-top: 18px;
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
  gap: 6px 12px;
  margin-bottom: 5px;
}
.f12-kicker-left {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
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
  white-space: nowrap;
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
  white-space: nowrap;
}
.f12-tag-weak {
  border-style: dashed;
  color: var(--f-ink-2);
}
.f12-last-date {
  font-family: var(--font-f-mono);
  font-size: 11.5px;
  font-weight: 700;
  color: var(--f-ink-2);
  white-space: nowrap;
}

.f12-headline {
  font-family: var(--font-f-display);
  font-weight: 400;
  font-size: clamp(19px, 1.95vw, 25px);
  line-height: 1.14;
  letter-spacing: 0.01em;
  margin: 0 0 4px;
  color: var(--f-ink);
  overflow-wrap: anywhere;
  word-break: break-word;
}
.f12-headline code.f12-headline-path,
.f12-mono-token {
  font-family: var(--font-f-mono);
  font-weight: 700;
  font-size: 0.94em;
  letter-spacing: -0.02em;
  padding: 0 2px;
  border: 0;
  background: transparent;
}
.f12-subhead {
  margin: 0 0 7px;
  font-size: 12.5px;
  line-height: 1.38;
  color: var(--f-ink-2);
  max-width: 95ch;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.f12-subhead code {
  font-family: var(--font-f-mono);
  font-weight: 700;
  font-size: 12px;
  color: var(--f-ink);
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
  height: 266px;
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
  gap: 5px 12px;
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
  gap: 10px;
}
.f12-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--plate-chalk);
  font-size: 11px;
  white-space: nowrap;
}
.f12-dir-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  border: 1.5px solid #fffef9;
  display: inline-block;
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
  fill: #fffef9;
  stroke: #121212;
  stroke-width: 2.2px;
}

/* Family Pairwise Summary Table inside Evidence Panel */
.f12-family-pairs-box {
  border: 1.5px solid var(--f-rule);
  background: var(--f-sheet);
  margin-bottom: 7px;
}
.f12-family-pairs-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 8px;
  border-bottom: 1px solid var(--f-grid);
  font-family: var(--font-f-mono);
  font-size: 11px;
  font-weight: 700;
  color: var(--f-ink-2);
}
.f12-family-pair-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  padding: 3px 8px;
  font-family: var(--font-f-mono);
  font-size: 11px;
  border-bottom: 1px solid var(--f-grid);
}
.f12-family-pair-row:last-child {
  border-bottom: 0;
}
.f12-family-pair-row.is-lead {
  background: rgba(18, 18, 18, 0.05);
  font-weight: 700;
}
:root[data-theme="dark"] .f12-family-pair-row.is-lead {
  background: rgba(241, 240, 234, 0.08);
}

/* Evidence Panel Inside / Beside Hero */
.f12-dir-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 7px;
}
.f12-dir-card {
  border: 2px solid var(--f-rule);
  background: var(--f-sheet);
  padding: 6px 9px;
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
.f12-dir-metric-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  margin: 0 0 2px;
}
.f12-dir-pct {
  font-family: var(--font-f-display);
  font-size: 21px;
  line-height: 1.05;
  color: var(--f-ink);
  margin: 0;
}
.f12-dir-lb {
  font-family: var(--font-f-mono);
  font-size: 11px;
  font-weight: 700;
  color: var(--f-ink);
  padding: 1px 5px;
  border: 1px solid var(--f-rule);
  background: var(--f-panel);
}
.f12-dir-detail {
  font-family: var(--font-f-mono);
  font-size: 11px;
  color: var(--f-ink-2);
  margin: 0;
}

/* Plain Definition List for Evidence Metadata (no fake buttons) */
.f12-evidence-dl {
  margin: 0 0 7px;
  padding: 4px 0;
  border-top: 1px solid var(--f-grid);
  border-bottom: 1px solid var(--f-grid);
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 2px 10px;
  font-family: var(--font-f-mono);
  font-size: 11px;
}
.f12-evidence-dl dt {
  color: var(--f-ink-2);
  font-weight: 700;
  white-space: nowrap;
}
.f12-evidence-dl dd {
  margin: 0;
  color: var(--f-ink);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.f12-cx-details {
  padding: 3px 0;
  margin-bottom: 6px;
  font-family: var(--font-f-mono);
  font-size: 11px;
  border-bottom: 1px solid var(--f-grid);
}
.f12-cx-details summary {
  cursor: pointer;
  font-weight: 700;
  color: var(--f-ink-2);
}
.f12-cx-list {
  margin: 4px 0 2px;
  padding-left: 16px;
  color: var(--f-ink-2);
}

/* Receipts List (ported from receipt.tsx) */
.f12-receipts-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 3px;
}
.f12-receipts-title {
  font-family: var(--font-f-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--f-ink-2);
  margin: 0;
}
.f12-receipt-list {
  list-style: none;
  margin: 0 0 7px;
  padding: 0;
  border-top: 1.5px solid var(--f-rule);
}
.f12-receipt-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: baseline;
  gap: 8px;
  padding: 3px 0;
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
  padding: 4px 8px;
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

/* Tone Range Bars with 45° Halftone Dots (ported from tone-bar-list.tsx) */
.f12-range-track {
  position: relative;
  display: block;
  width: 100%;
  height: 15px;
  border: 2px solid var(--f-rule);
  background: var(--f-sheet);
}
.f12-range-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  background-image:
    radial-gradient(circle, var(--f-tone) 1.15px, transparent 1.35px),
    radial-gradient(circle, var(--f-tone) 1.15px, transparent 1.35px);
  background-position: 0 0, 3px 3px;
  background-size: 6px 6px;
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
  grid-template-columns: 54px minmax(190px, 1.45fr) auto 76px minmax(140px, 1.35fr) 92px;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--f-grid);
  font-family: var(--font-f-mono);
  font-size: 12px;
}
.f12-ranked-row[hidden] {
  display: none !important;
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
  white-space: nowrap;
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
.f12-ranked-badges {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.f12-ranked-ratio {
  font-weight: 700;
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
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
  white-space: nowrap;
}
.f12-ranked-date {
  font-size: 11px;
  color: var(--f-ink-2);
  text-align: right;
  white-space: nowrap;
}
.f12-ranked-more-bar {
  display: flex;
  justify-content: center;
  padding-top: 8px;
}

/* Concept A Layout */
.concept-a-hero-grid {
  display: grid;
  grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
  gap: var(--f-gutter-pair);
  margin-bottom: 12px;
  align-items: stretch;
}
.concept-a-secondary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--f-gutter-pair);
  margin-bottom: 36px;
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

/* Responsive Mobile (390px) */
@media (max-width: 900px) {
  .f12-desk {
    padding: 3px;
  }
  .f12-sheet {
    padding: 5px 8px 14px;
  }
  .f12-masthead {
    gap: 5px 8px;
    padding-bottom: 5px;
    margin-bottom: 6px;
  }
  .f12-search-input {
    width: 120px;
    min-height: 24px;
    padding: 2px 6px;
  }
  .f12-seg-btn {
    padding: 2px 6px;
    min-height: 24px;
    font-size: 11px;
  }
  .f12-stat-strip {
    padding: 4px 8px;
    margin-bottom: 8px;
  }
  .f12-stat-window {
    display: none;
  }
  .concept-a-hero-grid,
  .concept-a-secondary-grid,
  .concept-b-top-grid,
  .concept-b-hero-split,
  .f12-dir-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .f12-plate-canvas-box {
    height: 244px !important;
  }
  .f12-balloon {
    font-size: 11px;
    padding: 3px 7px;
  }
  .f12-last-date,
  .f12-kicker-left .f12-tag,
  .f12-kicker-chip {
    white-space: normal;
  }
  .f12-family-pair-row {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 2px 8px;
  }
  .f12-family-pair-row > span:first-child {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .f12-family-pair-row > span:nth-child(3) {
    grid-column: 1 / -1;
    color: var(--f-ink-2);
  }
  .f12-ranked-row {
    grid-template-columns: 48px minmax(0, 1fr) auto;
    gap: 5px 8px;
  }
  .f12-ranked-badges {
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .f12-ranked-ratio {
    grid-column: 1 / 2;
    text-align: left;
  }
  .f12-ranked-range-col {
    grid-column: 2 / -1;
    min-width: 0;
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
      ? '0.35,0.35 99.65,0.35 99.65,94.0 0.35,99.65'
      : shape === 'slant-top'
        ? '0.35,6.0 99.65,0.35 99.65,99.65 0.35,99.65'
        : '0.35,0.35 99.65,0.35 99.65,99.65 0.35,99.65';
  return `<svg class="f12-panel-frame" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polygon vector-effect="non-scaling-stroke" points="${pts}"></polygon></svg>`;
}

function renderHeadlineWithMonoPaths(headline, featured) {
  let html = escapeHtml(headline);
  const tokens = [];
  if (featured.kind === 'family') {
    const fam = formatFamilyHeadline(featured.family);
    tokens.push(fam.dirsPattern);
  } else if (featured.kind === 'pair') {
    const dir = resolveStrongerDirection({ nodes: [], edges: [] }, featured.edge);
    if (dir.shortFrom) tokens.push(dir.shortFrom);
    if (dir.shortTo) tokens.push(dir.shortTo);
  }
  for (const tok of tokens) {
    const esc = escapeHtml(tok);
    if (esc && html.includes(esc)) {
      html = html.replace(esc, `<code class="f12-headline-path">${esc}</code>`);
    }
  }
  return html;
}

function renderBalloonHtml(calloutText, targetX, targetY, plateW, plateH) {
  const pctLeft = Math.max(18, Math.min(82, (targetX / plateW) * 100));
  const pctTop = Math.max(18, Math.min(82, (targetY / plateH) * 100));
  const svgW = 120;
  const svgH = 24;
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
    <path class="f12-tail" d="M${tailX - 6},0 L${px},${py - 6} L${tailX + 6},0"></path>
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

function renderMastheadHtml(data, activeConceptLabel, options = {}) {
  const safeRepo = sanitizeHtmlDisplayText(data.repoName);
  const ghostCount = data.edges.filter((e) => e.relationship === 'ghost').length;
  const unknownCount = data.edges.filter((e) => e.relationship === 'unknown').length;
  const indirectCount = data.edges.filter((e) => e.relationship === 'indirect').length;
  const directCount = data.edges.filter((e) => e.relationship === 'direct').length;
  const isEmptyState = Boolean(options.isEmptyState);

  return `
<header class="f12-masthead">
  <div class="f12-brand-row">
    <span class="f12-case-tag">REPO ARCHAEOLOGY // ${escapeHtml(activeConceptLabel)}</span>
    <span class="f12-repo-pill">${escapeHtml(safeRepo)}</span>
    ${
      isEmptyState
        ? `<span class="f12-status-calm">CLEAN DIG · 0 GHOST WIRES</span>`
        : `<span class="f12-status-kicker">${escapeHtml(STATUS_CHIP_EVIDENCE)}</span>`
    }
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

function renderStatStripHtml(data) {
  const ghostCount = data.edges.filter((e) => e.relationship === 'ghost').length;
  const uncheckedShown = data.edges.filter((e) => e.relationship === 'unknown').length;
  const uncheckedTotal = data.counts.unknown;
  const familyCount = (data.families ?? []).length;
  const commitsAnalyzed = data.meta.commitsAnalyzed;

  return `
<section class="f12-stat-strip" aria-label="Repository summary statistics">
  <div class="f12-stat-strip-items">
    <span class="f12-stat-inline"><span class="f12-ink-sq" aria-hidden="true">▲</span> <strong>${ghostCount}</strong> GHOST WIRES</span>
    <span class="f12-stat-sep" aria-hidden="true">·</span>
    <span class="f12-stat-inline"><strong>${familyCount}</strong> FINDING FAMILIES</span>
    <span class="f12-stat-sep" aria-hidden="true">·</span>
    <span class="f12-stat-inline"><strong>${uncheckedShown}</strong> UNCHECKED (${uncheckedTotal} TOTAL)</span>
    <span class="f12-stat-sep" aria-hidden="true">·</span>
    <span class="f12-stat-inline"><strong>${commitsAnalyzed.toLocaleString('en-US')}</strong> COMMITS ANALYSED</span>
  </div>
  <span class="f12-stat-window">${escapeHtml(data.meta.oldestCommit ?? '')} → ${escapeHtml(data.meta.newestCommit ?? '')} · ${data.nodes.length} files</span>
</section>`;
}

function hashHueJs(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}

function renderPlateDirLegendHtml(plate, monochrome = false) {
  const seen = new Set();
  const dirs = [];
  for (const n of plate.nodes) {
    if (!seen.has(n.dir)) {
      seen.add(n.dir);
      dirs.push(n.dir);
    }
  }
  return dirs
    .slice(0, 4)
    .map((dir) => {
      const color = monochrome ? '#7eb3e0' : `hsl(${hashHueJs(dir)}, 64%, 66%)`;
      const shortDir = dir.length > 22 ? `…/${dir.split('/').slice(-2).join('/')}` : dir;
      return `<span class="f12-legend-item"><span class="f12-dir-dot" style="background:${color};"></span>${escapeHtml(shortDir)}</span>`;
    })
    .join('');
}

function renderEvidenceBodyHtml(evCopy) {
  const cxTotal = evCopy.fromOnlyTotal + evCopy.toOnlyTotal;
  const cxItems = [...evCopy.fromOnly, ...evCopy.toOnly].slice(0, 3);
  const famPairs = evCopy.familySummary?.pairs ?? [];

  return `
${
  famPairs.length > 0
    ? `<div class="f12-family-pairs-box" aria-label="Family pairwise links">
        <div class="f12-family-pairs-hd">
          <span>ALL ${famPairs.length} FAMILY PAIRS (${evCopy.familySummary.qualifyingPairs}/${evCopy.familySummary.possiblePairs} PASSED)</span>
          <span>RAW · 95% CI</span>
        </div>
        ${famPairs
          .map(
            (p) => `
          <div class="f12-family-pair-row${p.isLeadPair ? ' is-lead' : ''}">
            <span>${escapeHtml(p.shortFrom)} ↔ ${escapeHtml(p.shortTo)}${p.isLeadPair ? ' (lead)' : ''}</span>
            <span>${p.shared}/${p.fromChanges} (${escapeHtml(p.pctText)})</span>
            <span>${escapeHtml(p.lowerBoundText)} (${escapeHtml(p.rangeText)})</span>
          </div>`,
          )
          .join('')}
      </div>`
    : ''
}
<div class="f12-dir-grid">
  <div class="f12-dir-card">
    <p class="f12-dir-route" title="${escapeHtml(evCopy.primaryDirection.fromLabel)} → ${escapeHtml(evCopy.primaryDirection.toLabel)}">
      ${escapeHtml(evCopy.primaryDirection.fromLabel)} → ${escapeHtml(evCopy.primaryDirection.toLabel)}
    </p>
    <div class="f12-dir-metric-row">
      <p class="f12-dir-pct">${escapeHtml(evCopy.primaryDirection.pctText)}</p>
      <span class="f12-dir-lb">${escapeHtml(evCopy.primaryDirection.lowerBoundText)}</span>
    </div>
    <p class="f12-dir-detail">${escapeHtml(evCopy.primaryDirection.detailText)}</p>
  </div>
  <div class="f12-dir-card">
    <p class="f12-dir-route" title="${escapeHtml(evCopy.reverseDirection.fromLabel)} → ${escapeHtml(evCopy.reverseDirection.toLabel)}">
      ${escapeHtml(evCopy.reverseDirection.fromLabel)} → ${escapeHtml(evCopy.reverseDirection.toLabel)}
    </p>
    <div class="f12-dir-metric-row">
      <p class="f12-dir-pct">${escapeHtml(evCopy.reverseDirection.pctText)}</p>
      <span class="f12-dir-lb">${escapeHtml(evCopy.reverseDirection.lowerBoundText)}</span>
    </div>
    <p class="f12-dir-detail">${escapeHtml(evCopy.reverseDirection.detailText)}</p>
  </div>
</div>

<dl class="f12-evidence-dl">
  ${
    evCopy.familySummary
      ? `<dt>Family scope</dt><dd>${evCopy.familySummary.commitsTouchingTwoOrMore} supporting commits (2+ files) · ${evCopy.familySummary.commitsTouchingAll} touched all ${evCopy.familySummary.members.length}</dd>`
      : ''
  }
  ${evCopy.ownerNotes[0] ? `<dt>Attribution</dt><dd>${escapeHtml(evCopy.ownerNotes[0])}</dd>` : ''}
  ${evCopy.originShareNote ? `<dt>History</dt><dd>${escapeHtml(evCopy.originShareNote)}</dd>` : ''}
  ${evCopy.verdictNote ? `<dt>Verdict</dt><dd>${escapeHtml(evCopy.verdictNote)}</dd>` : ''}
</dl>

<details class="f12-cx-details">
  <summary>${escapeHtml(evCopy.counterexamplesSummary)} (${escapeHtml(evCopy.primaryDirection.fromLabel)}) · ${escapeHtml(evCopy.reverseCounterexamplesSummary)} (${escapeHtml(evCopy.reverseDirection.fromLabel)}) — ${cxTotal} counterexample ${cxTotal === 1 ? 'commit' : 'commits'} ▸</summary>
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
  <h3 class="f12-receipts-title">Sample Commit Receipts (showing ${evCopy.receiptsShown.length} of ${evCopy.receiptsTotal} supporting commits)</h3>
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

function renderSecondaryFindingCard(data, item, panelCutLabel, shape = 'rect', extraReceipts = false) {
  const edge = data.edges[item.edgeIndex];
  const dir = resolveStrongerDirection(data, edge);
  const receipts = edge.evidence.slice(0, extraReceipts ? 2 : 1);
  return `
<section class="f12-panel f12-${shape}" aria-label="${escapeHtml(panelCutLabel)} ${escapeHtml(item.findingId)} ${escapeHtml(item.title)}">
  ${renderSvgBorder(shape)}
  <span class="f12-cut" aria-hidden="true">${escapeHtml(panelCutLabel)}</span>
  <div class="f12-panel-body">
    <div class="f12-kicker-row">
      <div class="f12-kicker-left">
        <span class="f12-tag">${escapeHtml(item.findingId)}</span>
        <span class="f12-tag">${item.kind === 'family' ? 'FINDING FAMILY' : 'GHOST WIRE'}</span>
      </div>
      <span class="f12-last-date">Last together ${escapeHtml(item.lastTogether)}</span>
    </div>
    <h2 style="font-family: var(--font-f-mono); font-size: 14.5px; font-weight: 700; margin: 2px 0 4px; color: var(--f-ink); overflow-wrap: anywhere;">
      ${escapeHtml(item.title)}
    </h2>
    <div style="display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 5px;">
      <span style="font-family: var(--font-f-display); font-size: 18px; line-height: 1.05; color: var(--f-ink);">${escapeHtml(item.ratioText)} commits · ≥${item.rangeLowPct}% CI</span>
      <span style="font-family: var(--font-f-mono); font-size: 11px; color: var(--f-ink-2);">${item.pointPct}% raw (${item.rangeLowPct}–${item.rangeHighPct}%)</span>
    </div>
    <div style="margin-bottom: 6px;">
      ${renderToneRangeBar(item.rangeLowPct, item.rangeHighPct, item.pointPct)}
    </div>
    <div style="font-family: var(--font-f-mono); font-size: 11px; color: var(--f-ink-2); margin-bottom: 5px;">
      Reverse (${escapeHtml(dir.shortTo)} → ${escapeHtml(dir.shortFrom)}): ${dir.shared} of ${dir.toChanges} (${Math.round(dir.reverseConfidence * 100)}%) · ${escapeHtml(formatCounterexamplesLine(dir.fromOnlyTotal + dir.toOnlyTotal))}
    </div>
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

function renderRankedListSection(rankedItems, panelCutLabel = 'C-05') {
  const defaultVisibleCount = 15;
  const hiddenCount = Math.max(0, rankedItems.length - defaultVisibleCount);
  return `
<section class="f12-panel f12-rect" aria-label="${escapeHtml(panelCutLabel)} Ranked Findings">
  ${renderSvgBorder('rect')}
  <span class="f12-cut" aria-hidden="true">${escapeHtml(panelCutLabel)}</span>
  <div class="f12-panel-body">
    <div class="f12-kicker-row" style="margin-bottom: 10px;">
      <div class="f12-kicker-left">
        <h2 style="font-family: var(--font-f-display); font-size: 18px; margin: 0;">RANKED FINDINGS (${rankedItems.length})</h2>
        <span class="f12-tag">45° HALFTONE DOTS = 95% CONFIDENCE RANGE · TICK = POINT ESTIMATE</span>
      </div>
      <span class="f12-last-date">Ordered by overview priority &amp; 95% Wilson lower bound</span>
    </div>
    <ul id="ranked-findings-list" class="f12-ranked-list" role="list">
      ${rankedItems
        .map(
          (item, idx) => `
        <li class="f12-ranked-row${idx === 0 ? ' f12-ranked-active' : ''}"${idx >= defaultVisibleCount ? ' hidden data-extra-row="true"' : ''}>
          <span class="f12-ranked-cut">${escapeHtml(item.findingId)}</span>
          <span class="f12-ranked-path" title="${escapeHtml(item.fromPath)} ⇢ ${escapeHtml(item.toPath)}">${escapeHtml(item.title)}</span>
          <span class="f12-ranked-badges">
            <span class="f12-tag">${
              item.kind === 'family'
                ? 'FAMILY'
                : item.relationship === 'ghost'
                  ? 'GHOST WIRE'
                  : item.relationship.toUpperCase()
            }</span>
            ${item.weak ? '<span class="f12-tag f12-tag-weak">LOW CI</span>' : ''}
          </span>
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
    ${
      hiddenCount > 0
        ? `<div class="f12-ranked-more-bar">
            <button type="button" id="toggle-all-findings" class="f12-seg-btn" style="border: 1.5px solid var(--f-rule);" aria-expanded="false">
              Show all ${rankedItems.length} findings (${hiddenCount} more)
            </button>
          </div>`
        : ''
    }
  </div>
</section>`;
}

function buildPlateDrawScript(plateLayout, options = {}) {
  const monochrome = Boolean(options.monochrome);
  return `
<script>
(() => {
  const plate = ${JSON.stringify(plateLayout)};
  const monochrome = ${JSON.stringify(monochrome)};
  const canvas = document.getElementById('featured-plate-canvas');
  if (!canvas) return;

  function hashHue(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return ((h % 360) + 360) % 360;
  }

  function boxesOverlap(a, b, pad = 3) {
    return (
      a.x - pad < b.x + b.w &&
      a.x + a.w + pad > b.x &&
      a.y - pad < b.y + b.h &&
      a.y + a.h + pad > b.y
    );
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

    // Draw edges (non-lead first, lead edge on top with chalk-paper outer casing — never marker yellow)
    const orderedEdges = [...plate.edges].sort((a, b) => (a.isLeadEdge ? 1 : 0) - (b.isLeadEdge ? 1 : 0));
    for (const e of orderedEdges) {
      const x1 = e.x1 * scaleX;
      const y1 = e.y1 * scaleY;
      const x2 = e.x2 * scaleX;
      const y2 = e.y2 * scaleY;

      if (e.isLeadEdge && !monochrome) {
        // High-contrast chalk-paper outer casing + blueprint inner moat under the lead ghost wire
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = 'rgba(255, 254, 249, 0.92)';
        ctx.lineWidth = e.strokeWidth + 5;
        ctx.lineCap = 'round';
        ctx.setLineDash([]);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = isDark ? '#09192c' : '#0e2540';
        ctx.lineWidth = e.strokeWidth + 2.2;
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.restore();
      }

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.lineWidth = e.isLeadEdge ? e.strokeWidth + 1.1 : e.isFeatured ? e.strokeWidth + 0.4 : e.strokeWidth;
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

    // Draw nodes with directory hue fill (or calm blueprint chalk in empty state) and paper-colored outline
    const renderedNodes = [];
    for (const n of plate.nodes) {
      const nx = n.x * scaleX;
      const ny = n.y * scaleY;
      const hue = hashHue(n.dir);
      ctx.save();
      ctx.beginPath();
      ctx.arc(nx, ny, n.r, 0, Math.PI * 2);
      ctx.fillStyle = monochrome ? '#7eb3e0' : 'hsl(' + hue + ', 64%, 66%)';
      ctx.fill();
      ctx.lineWidth = n.isFeaturedEndpoint ? 2.5 : 1.8;
      ctx.strokeStyle = '#fffef9';
      ctx.stroke();
      ctx.restore();
      renderedNodes.push({ nodeIndex: n.nodeIndex, text: n.label.text, x: nx, y: ny, r: n.r, isFeaturedEndpoint: n.isFeaturedEndpoint });
    }

    // Draw collision-free node labels with 3.5px halo stroke at >= 12px mono.
    // On narrow mobile screens (< 480px), label featured endpoints by default and only place neighbor labels that fit with zero overlap.
    ctx.save();
    const isNarrow = w < 480;
    ctx.font = (isNarrow ? '700 11.5px ' : '700 12.5px ') + '"M PLUS 1 Code", ui-monospace, monospace';
    ctx.lineJoin = 'round';

    const obstacles = renderedNodes.map((rn) => ({
      nodeIndex: rn.nodeIndex,
      x: rn.x - rn.r - 6,
      y: rn.y - rn.r - 6,
      w: (rn.r + 6) * 2,
      h: (rn.r + 6) * 2,
    }));
    const balloonEl = document.querySelector('.f12-balloon');
    let balloonRectLocal = null;
    if (balloonEl) {
      const cRect = canvas.getBoundingClientRect();
      const bRect = balloonEl.getBoundingClientRect();
      if (cRect.width > 0 && bRect.width > 0) {
        balloonRectLocal = {
          x: bRect.left - cRect.left - 4,
          y: bRect.top - cRect.top - 4,
          w: bRect.width + 8,
          h: bRect.height + 22,
        };
        obstacles.push(balloonRectLocal);
      }
    }

    const renderedLabels = [];
    const pad = 6;
    const textH = 15;

    for (const n of plate.nodes) {
      if (isNarrow && !n.isFeaturedEndpoint) continue;
      const lbl = n.label;
      const nx = n.x * scaleX;
      const ny = n.y * scaleY;
      const textW = Math.ceil(ctx.measureText(lbl.text).width);

      // Build candidate boxes around (nx, ny)
      const prefAx = lbl.anchorX * scaleX;
      const prefAy = lbl.anchorY * scaleY;
      const prefAlign = lbl.textAlign;
      const prefLeft = prefAlign === 'center' ? prefAx - textW / 2 : prefAlign === 'right' ? prefAx - textW : prefAx;

      const leftFlankX = Math.max(pad, Math.min(w - pad - textW, nx - textW * 0.78));
      const rightFlankX = Math.max(pad, Math.min(w - pad - textW, nx - textW * 0.22));
      const centerClampedX = Math.max(pad, Math.min(w - pad - textW, nx - textW / 2));

      const makeCand = (leftX, baselineY) => ({
        ax: leftX,
        ay: baselineY,
        align: 'left',
        x: leftX,
        y: baselineY - 12,
        w: textW,
        h: textH,
      });

      const candidates = [];
      if (!isNarrow) {
        candidates.push({
          ax: prefAx,
          ay: prefAy,
          align: prefAlign,
          x: prefLeft,
          y: prefAy - 12,
          w: textW,
          h: textH,
        });
      }

      // Row offsets below and above the node
      for (const dy of [n.r + 16, n.r + 32, n.r + 48, -n.r - 8, -n.r - 24]) {
        const by = ny + dy;
        if (isNarrow && nx < w * 0.45) {
          candidates.push(makeCand(leftFlankX, by));
          candidates.push(makeCand(centerClampedX, by));
        } else if (isNarrow && nx > w * 0.55) {
          candidates.push(makeCand(rightFlankX, by));
          candidates.push(makeCand(centerClampedX, by));
          candidates.push(makeCand(Math.max(pad, nx - textW), by));
        } else {
          candidates.push(makeCand(centerClampedX, by));
          candidates.push(makeCand(leftFlankX, by));
          candidates.push(makeCand(rightFlankX, by));
        }
      }
      // E & W candidates
      candidates.push(makeCand(nx + n.r + 8, ny + 4));
      candidates.push(makeCand(nx - n.r - 8 - textW, ny + 4));

      let chosen = null;
      let bestFallback = null;
      for (const c of candidates) {
        if (c.x < pad || c.x + c.w > w - pad || c.y < pad || c.y + c.h > h - pad) {
          continue;
        }
        const hitsObstacle = obstacles.some((ob) => boxesOverlap(c, ob, 2));
        const hitsLabel = renderedLabels.some((rl) => boxesOverlap(c, rl, 4));
        if (!hitsObstacle && !hitsLabel) {
          chosen = c;
          break;
        }
        const dist = Math.hypot(c.x + c.w / 2 - nx, c.y + c.h / 2 - ny);
        const pen = (hitsLabel ? 1000 : 0) + (hitsObstacle ? 400 : 0) + dist;
        if (!bestFallback || pen < bestFallback.pen) {
          bestFallback = { c, pen };
        }
      }

      if (!chosen) {
        // Scan a deterministic grid of positions to guarantee a zero-overlap slot if one exists
        for (let gy = pad + 14; gy <= h - pad; gy += 14) {
          for (let gx = pad; gx <= w - pad - textW; gx += 16) {
            const c = makeCand(gx, gy);
            const hitsObstacle = obstacles.some((ob) => boxesOverlap(c, ob, 2));
            const hitsLabel = renderedLabels.some((rl) => boxesOverlap(c, rl, 4));
            const dist = Math.hypot(c.x + c.w / 2 - nx, c.y + c.h / 2 - ny);
            const pen = (hitsLabel ? 1000 : 0) + (hitsObstacle ? 400 : 0) + dist;
            if (!bestFallback || pen < bestFallback.pen) {
              bestFallback = { c, pen };
            }
          }
        }
        chosen = bestFallback ? bestFallback.c : makeCand(centerClampedX, Math.min(h - pad, ny + n.r + 16));
      }

      renderedLabels.push({ nodeIndex: n.nodeIndex, text: lbl.text, x: chosen.x, y: chosen.y, w: chosen.w, h: chosen.h });
      ctx.textAlign = chosen.align;
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = isDark ? '#09192c' : '#0e2540';
      ctx.strokeText(lbl.text, chosen.ax, chosen.ay);
      ctx.fillStyle = '#fffef9';
      ctx.fillText(lbl.text, chosen.ax, chosen.ay);
    }
    ctx.restore();

    window.__raPlateRenderedNodes = renderedNodes;
    window.__raPlateRenderedLabels = renderedLabels;
    window.__raPlateBalloonBox = balloonRectLocal;
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
  const moreBtn = document.getElementById('toggle-all-findings');
  if (moreBtn) {
    moreBtn.addEventListener('click', () => {
      const expanded = moreBtn.getAttribute('aria-expanded') === 'true';
      const next = !expanded;
      moreBtn.setAttribute('aria-expanded', String(next));
      const rows = document.querySelectorAll('#ranked-findings-list [data-extra-row="true"]');
      rows.forEach((r) => {
        if (next) r.removeAttribute('hidden');
        else r.setAttribute('hidden', '');
      });
      moreBtn.textContent = next
        ? 'Collapse to top 15 findings'
        : 'Show all ' + document.querySelectorAll('#ranked-findings-list .f12-ranked-row').length + ' findings (' + rows.length + ' more)';
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
  const evCopy = formatEvidencePanelCopy(data, featured, 'F-01');
  const plate = computeFeaturedPlateLayout(data, featured, { width: 760, height: 266 });
  const leadEdge = featured.kind === 'family' ? featured.leadEdge : featured.edge;
  const balloonText = formatBalloonCallout(data, leadEdge);
  const ranked = buildRankedFindings(data);
  const secondary = ranked.slice(1, 4);
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
    ${renderStatStripHtml(data)}

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
          <h1 class="f12-headline">${renderHeadlineWithMonoPaths(evCopy.headline, featured)}</h1>
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
                  <svg width="24" height="8" aria-hidden="true"><line x1="0" y1="4" x2="24" y2="4" stroke="#fffef9" stroke-width="5"/><line x1="0" y1="4" x2="24" y2="4" stroke="#0e2540" stroke-width="3"/><line x1="0" y1="4" x2="24" y2="4" stroke="#ff4f9a" stroke-width="2.2" stroke-dasharray="6 4"/></svg>
                  Lead pair
                </span>
                <span class="f12-legend-item">
                  <svg width="20" height="8" aria-hidden="true"><line x1="0" y1="4" x2="20" y2="4" stroke="#ff4f9a" stroke-width="2" stroke-dasharray="6 4"/></svg>
                  Ghost wire
                </span>
                <span class="f12-legend-item">
                  <svg width="20" height="8" aria-hidden="true"><line x1="0" y1="4" x2="20" y2="4" stroke="rgba(232,238,245,0.75)" stroke-width="2"/></svg>
                  Import
                </span>
                ${renderPlateDirLegendHtml(plate)}
              </div>
              <span>Ego network (${plate.nodes.length} of ${plate.fullComponentNodeCount} files in component)</span>
            </div>
          </div>
        </div>
      </section>

      <section class="f12-panel f12-slant-bottom" aria-label="Supporting evidence for F-01">
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

    <!-- Secondary Findings (Panels C-02, C-03, C-04 showing Findings F-02, F-03, F-04) -->
    <div class="concept-a-secondary-grid">
      ${secondary
        .map((item, idx) => renderSecondaryFindingCard(data, item, `C-0${idx + 2}`, 'rect', false))
        .join('')}
    </div>

    <!-- Ranked List (Panel C-05 showing Findings F-01..F-78) -->
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
  const evCopy = formatEvidencePanelCopy(data, featured, 'F-01');
  const plate = computeFeaturedPlateLayout(data, featured, { width: 760, height: 266 });
  const leadEdge = featured.kind === 'family' ? featured.leadEdge : featured.edge;
  const balloonText = formatBalloonCallout(data, leadEdge);
  const ranked = buildRankedFindings(data);
  const secondFinding = ranked[1];
  const thirdFinding = ranked[2];
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
    ${renderStatStripHtml(data)}

    <!-- Asymmetric Comic Page Top: Tall C-01 Hero (8 cols) + Slanted C-02/C-03 Pair (4 cols) -->
    <div class="concept-b-top-grid">
      <section class="f12-panel f12-rect" aria-label="C-01 Hero Investigation Panel">
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
          <h1 class="f12-headline">${renderHeadlineWithMonoPaths(evCopy.headline, featured)}</h1>
          <p class="f12-subhead">${escapeHtml(evCopy.subhead)}</p>

          <div class="concept-b-hero-split">
            <div class="f12-plate-wrap">
              <div class="f12-plate-canvas-box" style="height: 266px;">
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
                    <svg width="20" height="8" aria-hidden="true"><line x1="0" y1="4" x2="20" y2="4" stroke="#fffef9" stroke-width="5"/><line x1="0" y1="4" x2="20" y2="4" stroke="#0e2540" stroke-width="3"/><line x1="0" y1="4" x2="20" y2="4" stroke="#ff4f9a" stroke-width="2" stroke-dasharray="5 3"/></svg>
                    Lead
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
    ${renderMastheadHtml(emptyData, 'EMPTY STATE · NO GHOST WIRES', { isEmptyState: true })}
    ${renderStatStripHtml(emptyData)}

    <section class="f12-panel f12-rect" aria-label="C-01 Empty state and strongest import cluster">
      ${renderSvgBorder('rect')}
      <span class="f12-cut" aria-hidden="true">C-01</span>
      <div class="f12-panel-body">
        <div class="f12-kicker-row">
          <div class="f12-kicker-left">
            <span class="f12-tag">CLEAN DIG · ZERO GHOST WIRES</span>
            <span class="f12-tag">CONTEXT: STRONGEST IMPORT CLUSTER (${plate.nodes.length} FILES)</span>
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
                <span class="f12-dir-dot" style="background:#7eb3e0;"></span>
                Import cluster node
              </span>
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
${buildPlateDrawScript(plate, { monochrome: true })}
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
