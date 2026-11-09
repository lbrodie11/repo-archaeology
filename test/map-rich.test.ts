import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { MapData, MapEdge, MapNode } from '../src/commands/map.js';
import type { Relationship } from '../src/imports/classify.js';
import { getInvalidConfigStyle, parseConfigText, resolveSettings } from '../src/config.js';
import {
  computeLayout,
  computeRichLayout,
  computeRichLayoutWithTiming,
  type RichFrameLayout,
} from '../src/map/layout.js';
import { renderMapHtml } from '../src/map/template.js';
import {
  directoryFillHsl,
  FRAME12,
  FRAME12_ALLOWED_HEX,
  resolveStyleMode,
  sanitizeHtmlDisplayText,
  wcagContrastRatio,
} from '../src/style/frame12.js';
import { wilsonInterval } from '../src/util/stats.js';
import { generateSyntheticMapData } from './fixtures/map-synthetic.js';

const require = createRequire(import.meta.url);

type PlaywrightModule = {
  chromium: {
    executablePath(): string;
    launch(options?: { headless?: boolean }): Promise<any>;
  };
};

function loadPlaywright(): PlaywrightModule | null {
  try {
    const mod = require('playwright') as PlaywrightModule;
    const execPath = mod.chromium?.executablePath?.();
    if (!execPath || !existsSync(execPath)) return null;
    return mod;
  } catch {
    return null;
  }
}

const pw = loadPlaywright();

function extractEmbeddedJson(html: string, id: string): string {
  const re = new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)<\\/script>`);
  const match = re.exec(html);
  assert.ok(match, `Expected <script id="${id}"> in HTML`);
  return match[1]!;
}

function buildCustomFixture(nodes: MapNode[], edges: MapEdge[], repoName = 'dig-sheet-fixture'): MapData {
  const counts: Record<Relationship, number> = {
    ghost: 0,
    unknown: 0,
    indirect: 0,
    direct: 0,
    test: 0,
  };
  for (const e of edges) {
    counts[e.relationship] = (counts[e.relationship] ?? 0) + 1;
  }
  const base = generateSyntheticMapData(1, { repoName });
  return {
    ...base,
    meta: {
      ...base.meta,
      root: repoName,
    },
    repoName,
    generatedAt: '2026-04-01T12:00:00.000Z',
    counts,
    classificationTruncated: false,
    patchesIncluded: false,
    nodes,
    edges,
    families: [],
  };
}

function makeEdge(
  source: number,
  target: number,
  opts: {
    relationship?: Relationship;
    shared: number;
    fromChanges: number;
    toChanges?: number;
    score?: number;
    overviewPriority?: number;
    crossesDirectories?: boolean;
  },
): MapEdge {
  const relationship = opts.relationship ?? 'ghost';
  const shared = opts.shared;
  const fromChanges = opts.fromChanges;
  const toChanges = opts.toChanges ?? fromChanges;
  const confidence = Math.round((shared / Math.max(1, fromChanges)) * 1000) / 1000;
  const reverseConfidence = Math.round((shared / Math.max(1, toChanges)) * 1000) / 1000;
  const interval = wilsonInterval(shared, fromChanges);
  const reverseInterval = wilsonInterval(shared, toChanges);
  const score = opts.score ?? Math.round(confidence * Math.log2(shared + 1) * 1000) / 1000;
  const crossesDirectories = opts.crossesDirectories ?? true;
  const overviewPriority = opts.overviewPriority ?? (relationship === 'ghost' ? (crossesDirectories ? 2 : 1) : 0);

  return {
    source,
    target,
    relationship,
    why:
      relationship === 'ghost'
        ? 'changed together without a direct or indirect import'
        : `connected via ${relationship} relationship`,
    shared,
    fromChanges,
    toChanges,
    confidence,
    reverseConfidence,
    interval: {
      low: Math.round(interval.low * 1000) / 1000,
      high: Math.round(interval.high * 1000) / 1000,
    },
    reverseInterval: {
      low: Math.round(reverseInterval.low * 1000) / 1000,
      high: Math.round(reverseInterval.high * 1000) / 1000,
    },
    score,
    overviewPriority,
    weighted: false,
    lastTogether: '2026-03-20',
    crossesDirectories,
    originShare: { human: 1, agent: 0, bot: 0 },
    evidence: [
      {
        hash: '1111111222222233333334444444555555566666',
        date: '2026-03-20',
        subject: 'feat: synchronized update across pair',
        origin: 'human',
      },
    ],
    counterexamples: {
      fromOnlyTotal: Math.max(0, fromChanges - shared),
      toOnlyTotal: Math.max(0, toChanges - shared),
      fromOnly: [],
      toOnly: [],
    },
    explainCommand: `repo-archaeology explain file-${source}.ts file-${target}.ts`,
  };
}

describe('RA-16 · Style option precedence & FRAME/12 tokens', () => {
  it('resolves style mode with precedence: flag > env > config > default "classic" and falls back on invalid env/config', () => {
    assert.equal(resolveStyleMode({}), 'classic');
    assert.equal(resolveStyleMode({ config: 'rich' }), 'rich');
    assert.equal(resolveStyleMode({ env: 'classic', config: 'rich' }), 'classic');
    assert.equal(resolveStyleMode({ flag: 'rich', env: 'classic', config: 'classic' }), 'rich');
    assert.throws(() => resolveStyleMode({ flag: 'neon' }), /Invalid style mode from --style/);

    const envWarnings: string[] = [];
    assert.equal(
      resolveStyleMode({ env: 'fancy', onWarning: (msg) => envWarnings.push(msg) }),
      'classic',
    );
    assert.equal(envWarnings.length, 1);
    assert.match(envWarnings[0]!, /REPO_ARCHAEOLOGY_STYLE.*"fancy"/);

    const parsed = parseConfigText(JSON.stringify({ style: 'rich' }));
    assert.equal(parsed.style, 'rich');
    const resolved = resolveSettings(parsed, {});
    assert.equal(resolved.style, 'rich');

    const invalidParsed = parseConfigText(JSON.stringify({ style: 'cyberpunk' }));
    assert.equal(invalidParsed.style, undefined);
    assert.equal(getInvalidConfigStyle(invalidParsed), 'cyberpunk');
    const invalidResolved = resolveSettings(invalidParsed, {});
    const cfgWarnings: string[] = [];
    assert.equal(
      resolveStyleMode({
        config: invalidResolved.style ?? getInvalidConfigStyle(invalidResolved),
        onWarning: (msg) => cfgWarnings.push(msg),
      }),
      'classic',
    );
    assert.equal(cfgWarnings.length, 1);
    assert.match(cfgWarnings[0]!, /config "style".*"cyberpunk"/);

    // Confirm REPO_ARCHAEOLOGY_STYLE=fancy repo-archaeology map --json does not error
    const tmpDir = mkdtempSync(join(tmpdir(), 'ra16-map-json-'));
    try {
      const outHtml = join(tmpDir, 'map.html');
      const stdout = execFileSync(
        process.execPath,
        ['--import', 'tsx', 'src/cli.ts', 'map', '--json', '--no-open', '--max-commits', '30', '-o', outHtml],
        {
          cwd: process.cwd(),
          env: { ...process.env, REPO_ARCHAEOLOGY_STYLE: 'fancy' },
          encoding: 'utf8',
        },
      );
      const parsedJson = JSON.parse(stdout) as { file: string; nodes: number; edges: number };
      assert.equal(parsedJson.file, outHtml);
      assert.equal(typeof parsedJson.nodes, 'number');
      const html = readFileSync(outHtml, 'utf8');
      assert.ok(html.includes('<meta name="ra-style" content="classic">'));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('matches upstream @frame12/tokens when present on disk', async () => {
    const upstreamDistPath = '/Users/brodie/Workspace/frame12/packages/tokens/dist/index.js';
    if (!existsSync(upstreamDistPath)) return;
    const upstreamMod = (await import(upstreamDistPath)) as { tokens: typeof FRAME12 };
    assert.deepEqual(FRAME12.light, upstreamMod.tokens.light);
    assert.deepEqual(FRAME12.dark, upstreamMod.tokens.dark);
    assert.deepEqual(FRAME12.gutters, upstreamMod.tokens.gutters);
    assert.equal(FRAME12.stroke.ink, upstreamMod.tokens.stroke.ink);
    assert.equal(FRAME12.motion.pose, upstreamMod.tokens.motion.pose);
    assert.equal(FRAME12.motion.fps, upstreamMod.tokens.motion.fps);
    assert.deepEqual(FRAME12.shadow, upstreamMod.tokens.shadow);
  });
});

describe('RA-16 · 1. Contract parity (classic vs rich)', () => {
  it('produces byte-identical #ra-data and records <meta name="ra-style"> without network URLs', () => {
    const data = generateSyntheticMapData(50, { repoName: 'ra16-contract' });
    const classicHtml = renderMapHtml(data, computeLayout(data, { style: 'classic' }), { style: 'classic' });
    const richHtml = renderMapHtml(data, computeLayout(data, { style: 'rich' }), { style: 'rich' });

    assert.ok(classicHtml.includes('<meta name="ra-style" content="classic">'));
    assert.ok(richHtml.includes('<meta name="ra-style" content="rich">'));

    const classicDataRaw = extractEmbeddedJson(classicHtml, 'ra-data');
    const richDataRaw = extractEmbeddedJson(richHtml, 'ra-data');
    assert.equal(richDataRaw, classicDataRaw, '#ra-data must be byte-identical between classic and rich styles');

    const forbiddenPatterns = [
      { label: '<link', pattern: /<link\b/i },
      { label: '@import', pattern: /@import\b/i },
      { label: 'url(http', pattern: /url\(\s*['"]?https?:/i },
      { label: 'src="http"', pattern: /\bsrc\s*=\s*['"]https?:/i },
    ];
    for (const { label, pattern } of forbiddenPatterns) {
      assert.equal(pattern.test(richHtml), false, `Expected rich map HTML not to contain ${label}`);
    }
  });
});

describe('RA-16 · 2 & 3. Contact-sheet layout and FRAME/12 gutters', () => {
  it('returns 5 non-overlapping priority-ordered frames for 4 disconnected pairs and 1 triangle, with all nodes inside padded bounds', () => {
    const nodes: MapNode[] = Array.from({ length: 11 }, (_, i) => ({
      path: `src/mod-${i}/file-${i}.ts`,
      dir: `src/mod-${i}`,
      changes: 12 + i * 2,
      topAuthor: 'Alice',
      topAuthorShare: 0.8,
    }));

    // 4 disconnected pairs + 1 triangle (nodes 8, 9, 10) with distinct priorities/scores
    const edges: MapEdge[] = [
      // Pair A (0-1): low priority direct link
      makeEdge(0, 1, { relationship: 'direct', shared: 4, fromChanges: 10, score: 0.9, overviewPriority: 0 }),
      // Pair B (2-3): ghost wire, priority 1, score 1.5
      makeEdge(2, 3, { relationship: 'ghost', shared: 5, fromChanges: 10, score: 1.5, overviewPriority: 1 }),
      // Triangle C (8-9-10): surprising ghost wires, priority 2, score 3.2 (9 of 12 commits)
      makeEdge(8, 9, { relationship: 'ghost', shared: 9, fromChanges: 12, score: 3.2, overviewPriority: 2 }),
      makeEdge(9, 10, { relationship: 'ghost', shared: 6, fromChanges: 12, score: 2.1, overviewPriority: 1 }),
      makeEdge(8, 10, { relationship: 'direct', shared: 5, fromChanges: 12, score: 1.4, overviewPriority: 0 }),
      // Pair D (4-5): surprising ghost wire, priority 2, score 2.4
      makeEdge(4, 5, { relationship: 'ghost', shared: 7, fromChanges: 10, score: 2.4, overviewPriority: 2 }),
      // Pair E (6-7): weak ghost wire (2 of 12 commits -> interval.low < 0.3), priority 1, score 1.1
      makeEdge(6, 7, { relationship: 'ghost', shared: 2, fromChanges: 12, score: 1.1, overviewPriority: 1 }),
    ];

    const data = buildCustomFixture(nodes, edges);
    const layout = computeRichLayout(data);
    const frames: RichFrameLayout[] = layout.frames ?? [];
    assert.equal(frames.length, 5, 'Expected 5 frames for 4 pairs + 1 triangle');

    // Verify cut labels C-01 .. C-05 and descending priority order
    assert.deepEqual(
      frames.map((f) => f.id),
      ['C-01', 'C-02', 'C-03', 'C-04', 'C-05'],
    );
    // C-01 must be the triangle (overviewPriority 2, score 3.2)
    assert.deepEqual(frames[0]!.nodeIndices, [8, 9, 10]);
    assert.equal(
      frames[0]!.caption,
      'C-01 · 3 files · 2 ghost wires · strongest 9 of 12 commits (in file-8.ts)',
    );
    assert.equal(
      frames[0]!.directionalSummary,
      'These files changed together in 9 of the 12 analyzed changes to file-8.ts',
    );
    assert.equal(frames[0]!.leadFile, 'file-8.ts');
    assert.equal(frames[0]!.width, frames[0]!.w);
    assert.equal(frames[0]!.height, frames[0]!.h);
    // C-02 is Pair D (overviewPriority 2, score 2.4)
    assert.deepEqual(frames[1]!.nodeIndices, [4, 5]);
    // C-03 is Pair B (overviewPriority 1, score 1.5)
    assert.deepEqual(frames[2]!.nodeIndices, [2, 3]);
    // C-04 is Pair E (overviewPriority 1, score 1.1, weak)
    assert.deepEqual(frames[3]!.nodeIndices, [6, 7]);
    assert.equal(frames[3]!.weak, true);
    assert.ok(frames[3]!.caption.endsWith('· weak'), `Expected weak caption marker, got: ${frames[3]!.caption}`);
    // C-05 is Pair A (overviewPriority 0, score 0.9)
    assert.deepEqual(frames[4]!.nodeIndices, [0, 1]);

    // Verify all 5 frame rectangles are non-overlapping
    for (let i = 0; i < frames.length; i++) {
      const frameA = frames[i]!;
      for (let j = i + 1; j < frames.length; j++) {
        const frameB = frames[j]!;
        const isOverlapping =
          frameA.x < frameB.x + frameB.w &&
          frameA.x + frameA.w > frameB.x &&
          frameA.y < frameB.y + frameB.h &&
          frameA.y + frameA.h > frameB.y;
        assert.equal(isOverlapping, false, `Frames ${frameA.id} and ${frameB.id} must not overlap`);
      }
    }

    // Verify every node is inside its frame's padded bounds
    for (const frame of frames) {
      const minX = frame.x + frame.pad.left;
      const maxX = frame.x + frame.w - frame.pad.right;
      const minY = frame.y + frame.pad.top;
      const maxY = frame.y + frame.h - frame.pad.bottom;
      for (const ni of frame.nodeIndices) {
        const nx = layout.x[ni]!;
        const ny = layout.y[ni]!;
        assert.ok(
          nx >= minX && nx <= maxX && ny >= minY && ny <= maxY,
          `Node ${ni} (${nx}, ${ny}) must lie inside ${frame.id} padded bounds [${minX}, ${maxX}] x [${minY}, ${maxY}]`,
        );
      }
    }
  });

  it('enforces exact FRAME/12 gutters (12 horizontal, 20 or 32 vertical) and full 12-column width for >40-node components', () => {
    const synData = generateSyntheticMapData(50, { repoName: 'ra16-gutters' });
    const layout = computeRichLayout(synData);
    const frames: RichFrameLayout[] = layout.frames ?? [];
    assert.ok(frames.length >= 4, 'Expected multiple frames');

    // Group frames by shelf row
    const rows = new Map<number, typeof frames>();
    for (const f of frames) {
      const list = rows.get(f.row) ?? [];
      list.push(f);
      rows.set(f.row, list);
    }

    const sortedRowIndices = Array.from(rows.keys()).sort((a, b) => a - b);
    for (let rIdx = 0; rIdx < sortedRowIndices.length; rIdx++) {
      const rowFrames = rows.get(sortedRowIndices[rIdx]!)!;
      for (let k = 0; k < rowFrames.length - 1; k++) {
        const left = rowFrames[k]!;
        const right = rowFrames[k + 1]!;
        const hGap = right.x - (left.x + left.w);
        assert.equal(hGap, 12, `Expected horizontal gap between ${left.id} and ${right.id} to be 12, got ${hGap}`);
      }
      if (rIdx > 0) {
        const prevRowFrames = rows.get(sortedRowIndices[rIdx - 1]!)!;
        const prevBottom = prevRowFrames[0]!.y + prevRowFrames[0]!.h;
        const currTop = rowFrames[0]!.y;
        const vGap = currTop - prevBottom;
        assert.ok(
          vGap === 20 || vGap === 32,
          `Expected vertical gap between row ${rIdx - 1} and row ${rIdx} to be 20 or 32, got ${vGap}`,
        );
        if (rowFrames[0]!.band !== prevRowFrames[0]!.band) {
          assert.equal(vGap, 32, 'Expected vertical gap before first frame of a lower priority band to be 32');
        } else {
          assert.equal(vGap, 20, 'Expected vertical gap between rows in the same priority band to be 20');
        }
      }
    }

    // Verify > 40 nodes component gets full 12-column sheet width
    const bigNodes: MapNode[] = Array.from({ length: 42 }, (_, i) => ({
      path: `src/big/file-${i}.ts`,
      dir: 'src/big',
      changes: 10,
    }));
    const bigEdges: MapEdge[] = Array.from({ length: 41 }, (_, i) =>
      makeEdge(i, i + 1, { relationship: 'ghost', shared: 5, fromChanges: 10 }),
    );
    const bigLayout = computeRichLayout(buildCustomFixture(bigNodes, bigEdges));
    assert.equal(bigLayout.frames![0]!.cols, 12);
    assert.equal(bigLayout.frames![0]!.w, bigLayout.sheet!.w);

    // Verify bridged ghost subgroups detection and timing breakdown
    const bridgedNodes: MapNode[] = Array.from({ length: 4 }, (_, i) => ({
      path: `src/group-${i}/file-${i}.ts`,
      dir: `src/group-${i}`,
      changes: 12,
    }));
    const bridgedEdges: MapEdge[] = [
      makeEdge(0, 1, { relationship: 'ghost', shared: 8, fromChanges: 12 }),
      makeEdge(2, 3, { relationship: 'ghost', shared: 7, fromChanges: 12 }),
      makeEdge(1, 2, { relationship: 'direct', shared: 4, fromChanges: 12 }),
    ];
    const { layout: bridgedLayout, timing } = computeRichLayoutWithTiming(
      buildCustomFixture(bridgedNodes, bridgedEdges),
    );
    assert.equal(bridgedLayout.frames!.length, 1);
    assert.equal(bridgedLayout.frames![0]!.bridgedSubgroups, 2);
    assert.ok(timing.totalMs >= 0 && timing.simulationMs >= 0);
  });
});

describe('RA-16 · 4, 5 & 6. Marker budget (static), Line grammar, and WCAG Contrast', () => {
  it('uses only FRAME/12 token hex colors in rich CSS/script and never uses #ffd60a as text color', () => {
    const data = generateSyntheticMapData(50, { repoName: 'ra16-tokens' });
    const html = renderMapHtml(data, computeLayout(data, { style: 'rich' }), { style: 'rich' });

    const styleMatch = /<style>([\s\S]*?)<\/style>/.exec(html);
    assert.ok(styleMatch, 'Expected <style> block');
    const css = styleMatch[1]!;

    // Extract client script (after #ra-data / #ra-layout)
    const scripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g)).map((m) => m[1]!);
    assert.equal(scripts.length, 1, 'Expected 1 executable client <script>');
    const clientJs = scripts[0]!;

    const hexRegex = /#[0-9a-fA-F]{3,8}\b/g;
    for (const [sourceName, text] of [['CSS', css], ['Client JS', clientJs]] as const) {
      const matches = text.match(hexRegex) ?? [];
      for (const hex of matches) {
        assert.ok(
          FRAME12_ALLOWED_HEX.has(hex.toLowerCase()),
          `Off-token hex color "${hex}" found in rich mode ${sourceName}`,
        );
      }
    }

    // Verify #ffd60a / var(--f-marker) never appears as a text `color:`
    assert.equal(/color\s*:\s*(#ffd60a|var\(--f-marker\))/i.test(css), false, '#ffd60a must never be used as text color');
    assert.equal(css.includes('--tape'), false, 'Legacy --tape token must not appear in rich mode');
    assert.equal(css.includes('--ochre'), false, 'Legacy --ochre token must not appear in rich mode');
  });

  it('computes >= 3:1 WCAG contrast for every rich-mode line/outline/fill and >= 4.5:1 for text in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const palette = FRAME12[theme];
      for (const bg of [palette.sheet, palette.panel]) {
        // Text tokens (ink and ink-2) must be >= 4.5:1 against sheet and panel
        const inkTextContrast = wcagContrastRatio(palette.ink, bg);
        const ink2TextContrast = wcagContrastRatio(palette['ink-2'], bg);
        assert.ok(
          inkTextContrast >= 4.5,
          `Expected ${theme} ink (${palette.ink}) vs ${bg} >= 4.5:1, got ${inkTextContrast.toFixed(2)}`,
        );
        assert.ok(
          ink2TextContrast >= 4.5,
          `Expected ${theme} ink-2 (${palette['ink-2']}) vs ${bg} >= 4.5:1, got ${ink2TextContrast.toFixed(2)}`,
        );

        // Line strokes & node outlines (ink and ink-2) must be >= 3:1
        assert.ok(inkTextContrast >= 3.0);
        assert.ok(ink2TextContrast >= 3.0);

        // Directory fills across all 360 hues must be >= 3:1 against frame background
        for (let hue = 0; hue < 360; hue += 5) {
          const fillHsl = directoryFillHsl(hue, theme);
          const ratio = wcagContrastRatio(fillHsl, bg);
          assert.ok(
            ratio >= 3.0,
            `Expected directory fill ${fillHsl} in ${theme} vs ${bg} >= 3:1, got ${ratio.toFixed(2)}`,
          );
        }
      }

      // Marker chip text (--f-marker-ink on --f-marker) must be >= 4.5:1
      const markerTextContrast = wcagContrastRatio(palette['marker-ink'], palette.marker);
      assert.ok(
        markerTextContrast >= 4.5,
        `Expected marker-ink (${palette['marker-ink']}) on marker (${palette.marker}) >= 4.5:1, got ${markerTextContrast.toFixed(2)}`,
      );
    }
  });
});

describe('RA-16 · 10. Sanitization (unit)', () => {
  it('neutralizes bidi overrides (\\u202e) and zero-width joiners (\\u200d) in sanitizeHtmlDisplayText', () => {
    const rawPath = 'src/auth/\u202eevil\u200dname.ts';
    const sanitized = sanitizeHtmlDisplayText(rawPath);
    assert.equal(sanitized.includes('\u202e'), false, 'Raw U+202E bidi override must be neutralized');
    assert.equal(sanitized.includes('\u200d'), false, 'Raw U+200D zero-width joiner must be neutralized');
    assert.ok(sanitized.includes('\\u202e'));
    assert.ok(sanitized.includes('\\u200d'));
  });
});

describe('RA-16 · Browser verification (Contract, Marker budget, Grammar, Themes, Responsive, Performance, Sanitization)', { skip: !pw ? 'Playwright is not installed' : false }, () => {
  it('verifies Markdown export parity, marker budget (<= 1), line grammar & Wilson width, themes, 360x640 responsive layout, zero idle rAF, and path sanitization', async () => {
    const browser = await pw!.chromium.launch({ headless: true });
    try {
      // 1. Markdown export byte-identity between classic and rich on the same fixture
      const syn50 = generateSyntheticMapData(50, { repoName: 'ra16-browser-50' });
      syn50.meta.root = '/Users/alice/secret-workspace/ra16-browser-50';
      const classicHtml = renderMapHtml(syn50, computeLayout(syn50, { style: 'classic' }), { style: 'classic' });
      const richHtml = renderMapHtml(syn50, computeLayout(syn50, { style: 'rich' }), { style: 'rich' });

      const canvasSpyHead = `<head><script>
        window.__name = function (fn) { return fn; };
        window.__copiedTexts = [];
        try {
          Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
              writeText: function (t) {
                window.__copiedTexts.push(String(t));
                return Promise.resolve();
              }
            }
          });
        } catch (_) {}
        window.__strokeLog = [];
        window.__fillRectLog = [];
        window.__fillTextLog = [];
        var origStroke = CanvasRenderingContext2D.prototype.stroke;
        CanvasRenderingContext2D.prototype.stroke = function () {
          window.__strokeLog.push({
            strokeStyle: String(this.strokeStyle).toLowerCase(),
            lineWidth: this.lineWidth,
            lineDash: this.getLineDash()
          });
          return origStroke.apply(this, arguments);
        };
        var origFillRect = CanvasRenderingContext2D.prototype.fillRect;
        CanvasRenderingContext2D.prototype.fillRect = function () {
          window.__fillRectLog.push({
            fillStyle: String(this.fillStyle).toLowerCase()
          });
          return origFillRect.apply(this, arguments);
        };
        var origFillText = CanvasRenderingContext2D.prototype.fillText;
        CanvasRenderingContext2D.prototype.fillText = function (text) {
          window.__fillTextLog.push(String(text));
          return origFillText.apply(this, arguments);
        };
      </script>`;

      const pageClassic = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await pageClassic.setContent(classicHtml.replace('<head>', canvasSpyHead), { waitUntil: 'domcontentloaded' });
      await pageClassic.locator('.card.interactive').first().click();
      const classicCopied: string[] = await pageClassic.evaluate(() => {
        (document.querySelector('.btn-export') as HTMLButtonElement).click();
        return (window as any).__copiedTexts as string[];
      });
      await pageClassic.close();

      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      page.on('pageerror', (err: Error) => {
        console.error('PAGEERROR in rich page:', err);
      });
      await page.setContent(richHtml.replace('<head>', canvasSpyHead), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(60);

      // 4. Marker budget on first render (0 #ffd60a strokes, <= 1 #ffd60a chip fill on canvas, <= 1 badge in DOM)
      const initialMarkerStats = await page.evaluate(() => {
        const strokes = (window as any).__strokeLog as Array<{ strokeStyle: string }>;
        const fills = (window as any).__fillRectLog as Array<{ fillStyle: string }>;
        const goldStrokes = strokes.filter((s) => s.strokeStyle === '#ffd60a');
        const goldFills = fills.filter((f) => f.fillStyle === '#ffd60a');
        const domMarkers = document.querySelectorAll('.marker-active').length;
        return { goldStrokeCount: goldStrokes.length, goldFillCount: goldFills.length, domMarkers };
      });
      assert.equal(
        initialMarkerStats.goldStrokeCount,
        0,
        `Expected 0 canvas stroke calls with #ffd60a (--f-marker is a chip fill, never a stroke), got ${initialMarkerStats.goldStrokeCount}`,
      );
      assert.ok(
        initialMarkerStats.goldFillCount <= 1,
        `Expected <= 1 canvas fillRect call with #ffd60a on first render, got ${initialMarkerStats.goldFillCount}`,
      );
      assert.ok(
        initialMarkerStats.domMarkers <= 1,
        `Expected <= 1 DOM element with .marker-active on first render, got ${initialMarkerStats.domMarkers}`,
      );

      // Verify RA-17 Briefing mode is active by default and renders C-01, E-01, featured plate SVG, help popovers, single <main>, and ranked findings
      const briefingCheck = await page.evaluate(() => {
        const appView = document.querySelector('.app')?.getAttribute('data-view');
        const c01 = document.getElementById('cut-c01');
        const c05 = document.getElementById('cut-c05');
        const svg = document.getElementById('featured-plate-svg');
        const ranked = document.getElementById('cut-ranked');
        const hasC01 = Boolean(c01 && c01.getBoundingClientRect().height > 0);
        const hasC05 = Boolean(c05 && c05.getBoundingClientRect().height > 0);
        const hasPlateSvg = Boolean(svg && svg.getBoundingClientRect().width >= 400);
        const hasRanked = Boolean(ranked && ranked.getBoundingClientRect().height > 0);
        const svgGoldStrokes = document.querySelectorAll('#featured-plate-svg [stroke="#ffd60a"]').length;
        const visibleMains = Array.from(document.querySelectorAll('main')).filter((m) => !m.hidden).length;
        const e01Label = c05?.querySelector('.f12-cut-label')?.textContent ?? '';
        const c05RankedLabel = ranked?.querySelector('.f12-cut-label')?.textContent ?? '';
        const hasThreeBeats =
          (c01?.textContent ?? '').includes('01 · WHAT WE FOUND') &&
          (c05?.textContent ?? '').includes('02 · WHAT THE HISTORY SHOWS') &&
          (c05?.textContent ?? '').includes('03 · WHAT TO DO NEXT');
        const initialRows = document.querySelectorAll('.f12-rank-row').length;
        const showAllBtn = document.getElementById('toggle-all-findings') as HTMLButtonElement | null;
        if (showAllBtn) showAllBtn.click();
        const expandedRows = document.querySelectorAll('.f12-rank-row').length;
        const collapseBtn = document.getElementById('toggle-all-findings') as HTMLButtonElement | null;
        if (collapseBtn) collapseBtn.click();
        return {
          appView,
          hasC01,
          hasC05,
          hasPlateSvg,
          hasRanked,
          svgGoldStrokes,
          visibleMains,
          e01Label,
          c05RankedLabel,
          hasThreeBeats,
          initialRows,
          expandedRows,
        };
      });
      assert.equal(briefingCheck.appView, 'briefing', 'Expected Briefing mode to be active by default');
      assert.equal(briefingCheck.hasC01, true, 'Expected C-01 featured finding panel to render');
      assert.equal(briefingCheck.hasC05, true, 'Expected E-01 evidence panel to render');
      assert.equal(briefingCheck.hasPlateSvg, true, 'Expected featured blueprint plate SVG >= 500px wide');
      assert.equal(briefingCheck.hasRanked, true, 'Expected C-05 ranked findings panel to render');
      assert.equal(briefingCheck.svgGoldStrokes, 0, 'Expected 0 SVG elements with stroke="#ffd60a"');
      assert.equal(briefingCheck.visibleMains, 1, 'Expected exactly 1 visible <main> landmark in Briefing mode');
      assert.equal(briefingCheck.e01Label, 'E-01 · EVIDENCE', 'Expected evidence panel cut label to be E-01 · EVIDENCE');
      assert.equal(briefingCheck.c05RankedLabel, 'C-05 · RANKED FINDINGS', 'Expected ranked findings cut label to be C-05 · RANKED FINDINGS');
      assert.equal(briefingCheck.hasThreeBeats, true, 'Expected 3-beat plain-language guide (01, 02, 03)');
      assert.equal(briefingCheck.initialRows, 10, 'Expected top 10 ranked findings visible initially');
      assert.ok(briefingCheck.expandedRows > 10, 'Expected Show all N findings toggle to expand all findings');

      // Verify contextual '?' help popover opens on click, 'Open in Field Guide' jumps to the glossary term, and Escape closes
      await page.locator('button[popovertarget="help-ghost-wire"]').click();
      await page.waitForTimeout(30);
      const helpOpen = await page.evaluate(() => {
        const pop = document.getElementById('help-ghost-wire')!;
        return pop.getBoundingClientRect().height > 0 && (pop.textContent ?? '').toLowerCase().includes('ghost wire');
      });
      assert.equal(helpOpen, true, 'Expected #help-ghost-wire popover to open on ? button click');

      // Click 'Open in Field Guide ▸' inside #help-ghost-wire and verify #field-guide-details + #glossary-ghost-wire open
      await page.locator('#help-ghost-wire .f12-help-more-btn').click();
      await page.waitForTimeout(30);
      const fieldGuideCheck = await page.evaluate(() => {
        const fg = document.getElementById('field-guide-details') as HTMLDetailsElement | null;
        const gw = document.getElementById('glossary-ghost-wire') as HTMLDetailsElement | null;
        const glossaryItems = document.querySelectorAll('#field-guide-details .f12-glossary-item[name="f12-glossary"]');
        const readingEl = document.getElementById('reading-this-finding') as HTMLDetailsElement | null;
        const readingSummaryText = readingEl?.querySelector('summary')?.textContent ?? '';
        const readingOpenBeforeClick = Boolean(readingEl?.open);
        readingEl?.querySelector('summary')?.click();
        const readingOpenAfterClick = Boolean(readingEl?.open);
        const dirHelpBtn = document.querySelector('#cut-c05 button[popovertarget="help-directional-pct"]') as HTMLButtonElement | null;
        const ciHelpBtn = document.querySelector('#cut-c05 button[popovertarget="help-confidence-range"]') as HTMLButtonElement | null;
        const aboutEl = document.getElementById('about-this-analysis');
        const footerEl = document.querySelector('.f12-report-footer');
        const rootPath = JSON.parse(document.getElementById('ra-data')!.textContent!).meta.root;
        const visibleText = document.body.innerText || '';
        return {
          fgOpen: Boolean(fg?.open),
          gwOpen: Boolean(gw?.open),
          glossaryCount: glossaryItems.length,
          readingSummaryText,
          readingOpenBeforeClick,
          readingOpenAfterClick,
          readingText: readingEl?.textContent ?? '',
          dirHelpText: dirHelpBtn?.textContent ?? '',
          dirHelpAria: dirHelpBtn?.getAttribute('aria-label') ?? '',
          ciHelpText: ciHelpBtn?.textContent ?? '',
          ciHelpAria: ciHelpBtn?.getAttribute('aria-label') ?? '',
          hasAbout: Boolean(aboutEl),
          hasFooter: Boolean(footerEl && (footerEl.textContent ?? '').includes('Repo Archaeology')),
          leaksRootInVisibleText: Boolean(rootPath && visibleText.includes(rootPath)),
        };
      });
      assert.equal(fieldGuideCheck.fgOpen, true, 'Expected #field-guide-details to open when clicking Open in Field Guide');
      assert.equal(fieldGuideCheck.gwOpen, true, 'Expected #glossary-ghost-wire to open when clicking Open in Field Guide');
      assert.equal(fieldGuideCheck.glossaryCount, 12, 'Expected 12 native <details name="f12-glossary"> glossary items');
      assert.equal(fieldGuideCheck.readingOpenBeforeClick, false, 'Expected #reading-this-finding to start collapsed with 1-line summary');
      assert.ok(
        fieldGuideCheck.readingSummaryText.includes('is historical co-change, not proof'),
        `Expected #reading-this-finding <summary> to show 1-line interpretation, got: ${fieldGuideCheck.readingSummaryText}`,
      );
      assert.equal(fieldGuideCheck.readingOpenAfterClick, true, 'Expected #reading-this-finding to expand on summary click');
      assert.ok(
        fieldGuideCheck.readingText.includes('Does that mean') && fieldGuideCheck.readingText.includes('What should I inspect next?'),
        'Expected #reading-this-finding to include worked 3-stage explanation',
      );
      assert.equal(fieldGuideCheck.dirHelpText, '% asymmetry ?', 'Expected E-01 directional help pill to show visible label');
      assert.ok(
        fieldGuideCheck.dirHelpAria.startsWith('% asymmetry ?'),
        `Expected E-01 directional help pill aria-label to start with visible text (WCAG 2.5.3), got: ${fieldGuideCheck.dirHelpAria}`,
      );
      assert.equal(fieldGuideCheck.ciHelpText, '95% range ?', 'Expected E-01 Wilson CI help pill to show visible label');
      assert.ok(
        fieldGuideCheck.ciHelpAria.startsWith('95% range ?'),
        `Expected E-01 Wilson CI help pill aria-label to start with visible text (WCAG 2.5.3), got: ${fieldGuideCheck.ciHelpAria}`,
      );
      assert.equal(fieldGuideCheck.hasAbout, true, 'Expected #about-this-analysis section in Briefing mode');
      assert.equal(fieldGuideCheck.hasFooter, true, 'Expected subtle .f12-report-footer with tool attribution');
      assert.equal(fieldGuideCheck.leaksRootInVisibleText, false, 'Visible report text must not leak local filesystem meta.root');

      // Close Field Guide before continuing selection checks
      await page.locator('#field-guide-details > summary').click();
      await page.waitForTimeout(20);

      // Select a card and verify marker budget on selection (<= 1 relationship) + Markdown export parity
      await page.evaluate(() => {
        (window as any).__strokeLog = [];
        (window as any).__fillRectLog = [];
      });
      await page.locator('.card.interactive').first().click();
      await page.waitForTimeout(50);

      const selectedMarkerStats = await page.evaluate(() => {
        const strokes = (window as any).__strokeLog as Array<{ strokeStyle: string }>;
        const domMarkers = document.querySelectorAll('.marker-active').length;
        return { domMarkers, strokesCount: strokes.length, hash: window.location.hash };
      });
      assert.ok(
        selectedMarkerStats.domMarkers <= 1,
        `Expected <= 1 DOM element with .marker-active on selection, got ${selectedMarkerStats.domMarkers}`,
      );
      assert.ok(
        selectedMarkerStats.hash.startsWith('#f='),
        `Expected selecting a finding in Briefing mode to update URL hash (#f=...), got ${selectedMarkerStats.hash}`,
      );

      // Force one settled draw and verify 0 #ffd60a strokes and <= 1 #ffd60a chip fill in that draw pass
      const settledGoldStats = await page.evaluate(() => {
        return new Promise<{ goldStrokes: number; goldFills: number }>((resolve) => {
          setTimeout(() => {
            (window as any).__strokeLog = [];
            (window as any).__fillRectLog = [];
            window.dispatchEvent(new Event('resize'));
            requestAnimationFrame(() => {
              const strokes = (window as any).__strokeLog as Array<{ strokeStyle: string }>;
              const fills = (window as any).__fillRectLog as Array<{ fillStyle: string }>;
              resolve({
                goldStrokes: strokes.filter((s) => s.strokeStyle === '#ffd60a').length,
                goldFills: fills.filter((f) => f.fillStyle === '#ffd60a').length,
              });
            });
          }, 480);
        });
      });
      assert.equal(
        settledGoldStats.goldStrokes,
        0,
        `Expected 0 #ffd60a strokes on settled selection draw, got ${settledGoldStats.goldStrokes}`,
      );
      assert.ok(
        settledGoldStats.goldFills <= 1,
        `Expected <= 1 #ffd60a chip fill on settled selection draw, got ${settledGoldStats.goldFills}`,
      );

      const richCopied: string[] = await page.evaluate(() => {
        (document.querySelector('.btn-export') as HTMLButtonElement).click();
        return (window as any).__copiedTexts as string[];
      });
      assert.equal(richCopied.length, 1);
      assert.equal(richCopied[0], classicCopied[0], 'Markdown export must be byte-identical between classic and rich');

      // 7. Themes: emulate prefers-color-scheme light & dark, cycle toggle, and test disabled localStorage
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForTimeout(30);
      const darkSheetBg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--f-sheet').trim());
      assert.equal(darkSheetBg, '#050505');

      await page.emulateMedia({ colorScheme: 'light' });
      await page.waitForTimeout(30);
      const lightSheetBg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--f-sheet').trim());
      assert.equal(lightSheetBg, '#ffffff');

      // Cycle Theme button when localStorage is disabled by default on about:blank (must not throw!)
      const themeBtn = page.locator('#theme-toggle');
      assert.equal(await themeBtn.textContent(), 'Theme: System');
      await themeBtn.click();
      assert.equal(await themeBtn.textContent(), 'Theme: Light');

      // Now provide a working localStorage mock and verify persistence across clicks
      await page.evaluate(() => {
        const store: Record<string, string> = {};
        Object.defineProperty(window, 'localStorage', {
          configurable: true,
          value: {
            getItem: (k: string) => store[k] ?? null,
            setItem: (k: string, v: string) => { store[k] = String(v); },
          },
        });
      });
      await themeBtn.click();
      assert.equal(await themeBtn.textContent(), 'Theme: Dark');
      assert.equal(await page.evaluate(() => window.localStorage.getItem('ra-theme')), 'dark');
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--f-sheet').trim()), '#050505');

      // Verify theme toggle does not throw when localStorage throws SecurityError
      await page.evaluate(() => {
        Object.defineProperty(window, 'localStorage', {
          configurable: true,
          get() {
            throw new Error('localStorage disabled');
          },
        });
      });
      await themeBtn.click();
      assert.equal(await themeBtn.textContent(), 'Theme: System');

      // 8a. Responsive in Briefing mode at 360x640: C-01 above C-05, no horizontal scroll, controls >= 24x24, SVG effective font-size >= 11px
      await page.setViewportSize({ width: 360, height: 640 });
      await page.waitForTimeout(80);
      const briefingMobileCheck = await page.evaluate(() => {
        const c01Rect = document.getElementById('cut-c01')!.getBoundingClientRect();
        const c05Rect = document.getElementById('cut-c05')!.getBoundingClientRect();
        const docScrollW = document.documentElement.scrollWidth;
        const docClientW = document.documentElement.clientWidth;
        const controls = Array.from(document.querySelectorAll('button, input'));
        const tooSmall = controls
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24);
          })
          .map((el) => el.id || el.className);
        const svgEl = document.getElementById('featured-plate-svg')!;
        const svgRect = svgEl.getBoundingClientRect();
        const vbParts = (svgEl.getAttribute('viewBox') || '0 0 340 240').split(/\s+/).map(Number);
        const vbW = vbParts[2] || 340;
        const scale = svgRect.width / vbW;
        const svgTexts = Array.from(svgEl.querySelectorAll('text'));
        const minEffectiveSvgPx = svgTexts.reduce((min, t) => {
          const rawFs = parseFloat(t.getAttribute('font-size') || '12');
          return Math.min(min, rawFs * scale);
        }, Infinity);
        return {
          c01Top: c01Rect.top,
          c05Top: c05Rect.top,
          docScrollW,
          docClientW,
          tooSmall,
          minEffectiveSvgPx,
        };
      });
      assert.ok(
        briefingMobileCheck.c01Top < briefingMobileCheck.c05Top,
        `Expected C-01 (${briefingMobileCheck.c01Top}) to stack above C-05 (${briefingMobileCheck.c05Top}) at 360x640`,
      );
      assert.ok(
        briefingMobileCheck.docScrollW <= briefingMobileCheck.docClientW,
        `Expected no horizontal overflow in Briefing mode at 360x640 (scrollWidth ${briefingMobileCheck.docScrollW} <= clientWidth ${briefingMobileCheck.docClientW})`,
      );
      assert.deepEqual(briefingMobileCheck.tooSmall, [], 'Expected all visible controls in Briefing mode at 360x640 to be >= 24x24 CSS px');
      assert.ok(
        briefingMobileCheck.minEffectiveSvgPx >= 11,
        `Expected mobile plate SVG text effective font-size >= 11px at 360px viewport, got ${briefingMobileCheck.minEffectiveSvgPx.toFixed(2)}px`,
      );

      // 8a-320. Verify WCAG 1.4.10 Reflow at 320 CSS pixels width (both closed and open Field Guide)
      await page.setViewportSize({ width: 320, height: 800 });
      await page.waitForTimeout(60);
      const reflow320Closed = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }));
      assert.ok(
        reflow320Closed.scrollW <= reflow320Closed.clientW,
        `Expected zero horizontal overflow at 320px viewport width (scrollWidth ${reflow320Closed.scrollW} <= clientWidth ${reflow320Closed.clientW})`,
      );
      await page.locator('#field-guide-details > summary').click();
      await page.waitForTimeout(30);
      const reflow320Open = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }));
      assert.ok(
        reflow320Open.scrollW <= reflow320Open.clientW,
        `Expected zero horizontal overflow at 320px viewport width with Field Guide open (scrollWidth ${reflow320Open.scrollW} <= clientWidth ${reflow320Open.clientW})`,
      );
      await page.locator('#field-guide-details > summary').click();
      await page.setViewportSize({ width: 360, height: 640 });
      await page.waitForTimeout(40);

      // 8b. Switch to Atlas mode and verify at 360x640: panel renders above canvas, no horizontal scroll, controls >= 24x24
      await page.locator('#view-atlas').click();
      await page.waitForTimeout(80);
      const responsiveCheck = await page.evaluate(() => {
        const panelRect = document.getElementById('panel')!.getBoundingClientRect();
        const stageRect = document.querySelector('.stage')!.getBoundingClientRect();
        const docScrollW = document.documentElement.scrollWidth;
        const docClientW = document.documentElement.clientWidth;
        const controls = Array.from(document.querySelectorAll('button, input'));
        const tooSmall = controls
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24);
          })
          .map((el) => el.id || el.className);
        return {
          panelTop: panelRect.top,
          stageTop: stageRect.top,
          docScrollW,
          docClientW,
          tooSmall,
        };
      });
      assert.ok(
        responsiveCheck.panelTop < responsiveCheck.stageTop,
        `Expected panel (${responsiveCheck.panelTop}) to render above canvas stage (${responsiveCheck.stageTop}) at 360x640`,
      );
      assert.ok(
        responsiveCheck.docScrollW <= responsiveCheck.docClientW,
        `Expected no horizontal overflow at 360x640 (scrollWidth ${responsiveCheck.docScrollW} <= clientWidth ${responsiveCheck.docClientW})`,
      );
      assert.deepEqual(responsiveCheck.tooSmall, [], 'Expected all visible controls at 360x640 to be >= 24x24 CSS px');

      // Reset selection, return to desktop, and verify 9. Performance (zero idle rAF & zero long tasks on kind toggle)
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.locator('#reset-view').click();
      await page.waitForTimeout(80);

      const idleRafAndToggle = await page.evaluate(async () => {
        let rafCount = 0;
        const origRaf = window.requestAnimationFrame;
        window.requestAnimationFrame = function (cb: FrameRequestCallback): number {
          rafCount++;
          return origRaf.call(window, cb);
        };
        await new Promise((r) => setTimeout(r, 350));
        const idleRafs = rafCount;
        window.requestAnimationFrame = origRaf;

        const t0 = performance.now();
        const toggleBtn = document.querySelector('#toggles .toggle') as HTMLButtonElement;
        if (toggleBtn) toggleBtn.click();
        const toggleElapsed = performance.now() - t0;
        return { idleRafs, toggleElapsed };
      });
      assert.equal(idleRafAndToggle.idleRafs, 0, `Expected 0 idle rAF calls over 350ms, got ${idleRafAndToggle.idleRafs}`);
      assert.ok(idleRafAndToggle.toggleElapsed < 50, `Expected kind toggle to take < 50ms, got ${idleRafAndToggle.toggleElapsed.toFixed(1)}ms`);

      await page.close();

      // 5 & 10. Grammar (9/10 wider than 2/2; distinct swatches) & Sanitization (\u202e, \u200d, and shell-quoted fallback explainCommand)
      const gNodes: MapNode[] = [
        { path: 'src/a/\u202eevil\u200d1.ts', dir: 'src/a', changes: 10 },
        { path: 'src/b/file-2.ts', dir: 'src/b', changes: 10 },
        { path: 'src/c/file-3.ts', dir: 'src/c', changes: 2 },
        { path: 'src/d/file-4.ts', dir: 'src/d', changes: 2 },
        { path: "src/e/my dir/it's-5.ts", dir: 'src/e/my dir', changes: 8 },
        { path: 'src/f/file-6.ts', dir: 'src/f', changes: 8 },
      ];
      const ghostWithoutExplain = makeEdge(4, 5, { relationship: 'ghost', shared: 5, fromChanges: 8 });
      delete ghostWithoutExplain.explainCommand;
      const gEdges: MapEdge[] = [
        // 9 of 10 commits (point confidence 0.90, Wilson low ≈ 0.596)
        makeEdge(0, 1, { relationship: 'direct', shared: 9, fromChanges: 10, toChanges: 10 }),
        // 2 of 2 commits (point confidence 1.00, Wilson low ≈ 0.342)
        makeEdge(2, 3, { relationship: 'direct', shared: 2, fromChanges: 2, toChanges: 2 }),
        ghostWithoutExplain,
        makeEdge(0, 4, { relationship: 'indirect', shared: 4, fromChanges: 8 }),
        makeEdge(1, 5, { relationship: 'unknown', shared: 2, fromChanges: 10 }),
        makeEdge(2, 4, { relationship: 'test', shared: 4, fromChanges: 8 }),
      ];
      const gData = buildCustomFixture(gNodes, gEdges);
      const gHtml = renderMapHtml(gData, computeRichLayout(gData), { style: 'rich' });

      const gPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await gPage.setContent(gHtml.replace('<head>', canvasSpyHead), { waitUntil: 'domcontentloaded' });
      await gPage.waitForTimeout(60);

      // Enable 'unknown' toggle so all 5 relationship kinds are visible (and Unchecked appears in Ranked Findings)
      const unknownToggle = gPage.locator('#toggles .toggle', { hasText: 'Unchecked' });
      await unknownToggle.click();
      await gPage.waitForTimeout(40);

      const grammarAndSanitization = await gPage.evaluate(() => {
        // Check legend swatch SVG line attributes across all 5 relationship kinds
        const swatches = Array.from(document.querySelectorAll('#toggles .swatch-svg')).map((svg) => {
          const line = svg.querySelector('line')!;
          return {
            cls: svg.getAttribute('class'),
            stroke: line.getAttribute('stroke'),
            width: line.getAttribute('stroke-width'),
            dash: line.getAttribute('stroke-dasharray') || 'solid',
          };
        });

        // Check sanitization of canvas fillText and rendered UI DOM text
        const texts = (window as any).__fillTextLog as string[];
        const hasRawBidi = texts.some((t) => t.includes('\u202e') || t.includes('\u200d'));
        const appHtml = document.querySelector('.app')!.innerHTML;
        const bodyHasRawBidi =
          appHtml.includes('\u202e') || appHtml.includes('\u200d');
        const cliCodeText = document.querySelector('.f12-cli-code')?.textContent ?? '';
        const rankedText = document.getElementById('ranked-findings-list')?.textContent ?? '';

        // Compare Wilson lower bound width for 9/10 vs 2/2
        const parsed = JSON.parse(document.getElementById('ra-data')!.textContent!);
        const e9of10 = parsed.edges[0];
        const e2of2 = parsed.edges[1];

        return {
          swatches,
          hasRawBidi,
          bodyHasRawBidi,
          cliCodeText,
          rankedHasUnchecked: rankedText.includes('UNCHECKED'),
          low9of10: e9of10.interval.low,
          conf9of10: e9of10.confidence,
          low2of2: e2of2.interval.low,
          conf2of2: e2of2.confidence,
        };
      });

      assert.equal(grammarAndSanitization.swatches.length, 5, 'Expected 5 relationship kind swatches');
      assert.equal(grammarAndSanitization.rankedHasUnchecked, true, 'Expected Unchecked toggle to reveal UNCHECKED row in Ranked Findings');
      assert.ok(
        grammarAndSanitization.conf2of2 > grammarAndSanitization.conf9of10,
        '2/2 has higher point confidence than 9/10',
      );
      assert.ok(
        grammarAndSanitization.low9of10 > grammarAndSanitization.low2of2,
        `Expected 9/10 Wilson lower bound (${grammarAndSanitization.low9of10}) > 2/2 (${grammarAndSanitization.low2of2})`,
      );
      assert.equal(grammarAndSanitization.hasRawBidi, false, 'Canvas labels must not contain raw bidi or ZWJ characters');
      assert.equal(grammarAndSanitization.bodyHasRawBidi, false, 'DOM/tooltips must not contain raw bidi or ZWJ characters');
      assert.ok(
        grammarAndSanitization.cliCodeText.includes("'src/e/my dir/it'\\''s-5.ts'"),
        `Expected fallback explainCommand to shell-quote paths with spaces/single quotes, got: ${grammarAndSanitization.cliCodeText}`,
      );

      // Also verify classic map shell-quotes fallback explainCommand on paths with spaces and single quotes
      const gClassicHtml = renderMapHtml(gData, computeLayout(gData, { style: 'classic' }), { style: 'classic' });
      const gClassicPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await gClassicPage.setContent(gClassicHtml, { waitUntil: 'domcontentloaded' });
      await gClassicPage.locator('.card.interactive').first().click();
      const classicFallbackCmd = await gClassicPage.locator('.cli-box code').textContent();
      assert.ok(
        (classicFallbackCmd ?? '').includes("'src/e/my dir/it'\\''s-5.ts'"),
        `Expected classic map fallbackExplainCommand to shell-quote paths with spaces and single quotes, got: ${classicFallbackCmd}`,
      );
      await gClassicPage.close();

      // Verify:
      // 1) clicking a non-default family row in Ranked Findings opens that specific family and preserves keyboard focus
      // 2) Briefing <-> Atlas selection sync works in both directions
      // 3) mixed-family filtering keeps a family when >= 2 member edges remain visible after toggling off Ghost wires
      // 4) #f=<from>..<to> deep link to an Unchecked edge auto-enables the Unchecked filter
      gData.families = [
        {
          id: 'src/adapter/*/serve-static',
          label: 'serve-static.ts across src/adapter/*',
          stem: 'serve-static',
          fileName: 'serve-static.ts',
          parentDir: 'src/adapter',
          why: '3 parallel implementations',
          members: [
            { path: 'src/adapter/bun/serve-static.ts', dir: 'src/adapter/bun', variant: 'bun', changes: 10, connections: 2 },
            { path: 'src/adapter/deno/serve-static.ts', dir: 'src/adapter/deno', variant: 'deno', changes: 10, connections: 2 },
            { path: 'src/adapter/cf/serve-static.ts', dir: 'src/adapter/cf', variant: 'cf', changes: 10, connections: 2 },
          ],
          commitsTouchingTwoOrMore: 9,
          commitsTouchingAll: 6,
          lastTogether: '2026-05-01',
          qualifyingPairs: 3,
          possiblePairs: 3,
          complete: true,
          relationshipKinds: ['ghost', 'direct'],
          peakScore: 2.5,
          maxPairShared: 9,
          evidence: [],
          allMemberEvidence: [],
          nodeIndices: [0, 1, 2],
          edgeIndices: [0, 1, 2],
          overviewPriority: 2,
        },
        {
          id: 'src/router/*/router',
          label: 'router.ts across src/router/*',
          stem: 'router',
          fileName: 'router.ts',
          parentDir: 'src/router',
          why: '3 parallel implementations',
          members: [
            { path: 'src/router/trie/router.ts', dir: 'src/router/trie', variant: 'trie', changes: 8, connections: 2 },
            { path: 'src/router/reg/router.ts', dir: 'src/router/reg', variant: 'reg', changes: 8, connections: 2 },
            { path: 'src/router/linear/router.ts', dir: 'src/router/linear', variant: 'linear', changes: 8, connections: 2 },
          ],
          commitsTouchingTwoOrMore: 6,
          commitsTouchingAll: 4,
          lastTogether: '2026-04-15',
          qualifyingPairs: 3,
          possiblePairs: 3,
          complete: true,
          relationshipKinds: ['ghost'],
          peakScore: 1.8,
          maxPairShared: 5,
          evidence: [],
          allMemberEvidence: [],
          nodeIndices: [3, 4, 5],
          edgeIndices: [2, 3],
          overviewPriority: 2,
        },
      ];
      const famHtml = renderMapHtml(gData, computeRichLayout(gData), { style: 'rich' });
      await gPage.setContent(famHtml, { waitUntil: 'domcontentloaded' });
      await gPage.waitForTimeout(40);

      // 1) Focus and activate the non-default family row in Ranked Findings and verify focus is preserved on the rebuilt row
      const routerRow = gPage.locator('#ranked-findings-list .f12-rank-row', { hasText: 'src/router/*' });
      await routerRow.focus();
      await routerRow.click();
      await gPage.waitForTimeout(30);
      const focusAndFamilyCheck = await gPage.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        return {
          headline: document.getElementById('briefing-headline')?.textContent ?? '',
          activeClass: active?.className ?? '',
          activeText: active?.textContent ?? '',
        };
      });
      assert.equal(
        focusAndFamilyCheck.headline,
        '3 files across src/router/* keep changing together',
        'Expected clicking non-default family row in Ranked Findings to open that specific family',
      );
      assert.ok(
        focusAndFamilyCheck.activeClass.includes('f12-rank-row') && focusAndFamilyCheck.activeText.includes('src/router/*'),
        `Expected keyboard focus to remain on the rebuilt .f12-rank-row for src/router/*, got: ${focusAndFamilyCheck.activeClass} (${focusAndFamilyCheck.activeText})`,
      );

      // 2) Switch to Atlas and verify the selected family is synchronized into the Atlas side panel
      await gPage.locator('#view-atlas').click();
      await gPage.waitForTimeout(30);
      const atlasPanelText = await gPage.locator('#panel').textContent();
      assert.ok(
        (atlasPanelText ?? '').includes('router.ts across src/router/*'),
        `Expected Briefing family selection to sync into Atlas side panel, got: ${atlasPanelText}`,
      );

      // Switch back to Briefing and test mixed-family filtering when Ghost wires is toggled off
      await gPage.locator('#view-briefing').click();
      await gPage.waitForTimeout(30);
      await gPage.locator('#toggles .toggle[data-kind="ghost"]').click();
      await gPage.waitForTimeout(30);
      const mixedFamilyAfterGhostOff = await gPage.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#ranked-findings-list .f12-rank-row')).map((r) => r.textContent ?? '');
        return {
          headline: document.getElementById('briefing-headline')?.textContent ?? '',
          hasAdapterFamily: rows.some((t) => t.includes('src/adapter/*')),
          hasRouterFamily: rows.some((t) => t.includes('src/router/*')),
        };
      });
      assert.equal(
        mixedFamilyAfterGhostOff.hasAdapterFamily,
        true,
        'Expected mixed family (2 direct edges + 1 ghost edge) to remain visible when Ghost wires is toggled off',
      );
      assert.equal(
        mixedFamilyAfterGhostOff.hasRouterFamily,
        false,
        'Expected family with < 2 visible edges to be filtered out when Ghost wires is toggled off',
      );

      // 4) Navigate via #f=<from>..<to> to an Unchecked edge (while Unchecked is off) and verify it auto-enables Unchecked and renders in C-01
      await gPage.evaluate(() => {
        window.location.hash = '#f=src%2Fb%2Ffile-2.ts..src%2Ff%2Ffile-6.ts';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      await gPage.waitForTimeout(40);
      const uncheckedDeepLinkCheck = await gPage.evaluate(() => {
        const unknownBtn = document.querySelector('#toggles .toggle[data-kind="unknown"]');
        return {
          headline: document.getElementById('briefing-headline')?.textContent ?? '',
          unknownPressed: unknownBtn?.getAttribute('aria-pressed'),
          unknownHasOffClass: unknownBtn?.classList.contains('off'),
        };
      });
      assert.equal(
        uncheckedDeepLinkCheck.unknownPressed,
        'true',
        'Expected #f= deep link to an unchecked edge to auto-enable the Unchecked filter toggle',
      );
      assert.equal(uncheckedDeepLinkCheck.unknownHasOffClass, false);
      assert.equal(
        uncheckedDeepLinkCheck.headline,
        'file-2.ts and file-6.ts keep changing together',
        'Expected #f= deep link to an unchecked edge to display that finding in C-01',
      );

      // 5) Interactive node dragging, wheel zoom, and reset on #featured-plate-svg in Briefing mode
      const beforeDrag = await gPage.evaluate(() => {
        const svg = document.getElementById('featured-plate-svg')!;
        const nodeG = svg.querySelector('.f12-plate-node[data-plate-idx="0"]') as SVGGElement;
        const circles = nodeG.querySelectorAll('circle');
        const visibleCircle = circles[1] ?? circles[0]!;
        const rect = visibleCircle.getBoundingClientRect();
        const resetBtn = document.getElementById('reset-plate-btn') as HTMLButtonElement;
        return {
          userSelect: getComputedStyle(svg).userSelect,
          cx: Number(visibleCircle.getAttribute('cx')),
          cy: Number(visibleCircle.getAttribute('cy')),
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          viewBox: svg.getAttribute('viewBox') ?? '',
          resetHidden: resetBtn.hidden,
        };
      });
      assert.equal(beforeDrag.userSelect, 'none', 'Expected #featured-plate-svg to disable text selection');
      assert.equal(beforeDrag.resetHidden, true, 'Expected #reset-plate-btn to be hidden before dragging');

      await gPage.mouse.move(beforeDrag.clientX, beforeDrag.clientY);
      await gPage.mouse.down();
      await gPage.mouse.move(beforeDrag.clientX + 60, beforeDrag.clientY + 40, { steps: 4 });
      await gPage.mouse.up();

      const afterDrag = await gPage.evaluate(() => {
        const svg = document.getElementById('featured-plate-svg')!;
        const nodeG = svg.querySelector('.f12-plate-node[data-plate-idx="0"]') as SVGGElement;
        const circles = nodeG.querySelectorAll('circle');
        const visibleCircle = circles[1] ?? circles[0]!;
        const resetBtn = document.getElementById('reset-plate-btn') as HTMLButtonElement;
        return {
          cx: Number(visibleCircle.getAttribute('cx')),
          cy: Number(visibleCircle.getAttribute('cy')),
          resetHidden: resetBtn.hidden,
        };
      });
      assert.equal(afterDrag.cx > beforeDrag.cx + 20, true, `Expected dragged node cx (${afterDrag.cx}) to move right from ${beforeDrag.cx}`);
      assert.equal(afterDrag.cy > beforeDrag.cy + 15, true, `Expected dragged node cy (${afterDrag.cy}) to move down from ${beforeDrag.cy}`);
      assert.equal(afterDrag.resetHidden, false, 'Expected #reset-plate-btn to appear after dragging a node');

      // Reset plate layout and verify original coordinates are restored
      await gPage.locator('#reset-plate-btn').click();
      const afterReset = await gPage.evaluate(() => {
        const svg = document.getElementById('featured-plate-svg')!;
        const nodeG = svg.querySelector('.f12-plate-node[data-plate-idx="0"]') as SVGGElement;
        const circles = nodeG.querySelectorAll('circle');
        const visibleCircle = circles[1] ?? circles[0]!;
        const resetBtn = document.getElementById('reset-plate-btn') as HTMLButtonElement;
        return {
          cx: Number(visibleCircle.getAttribute('cx')),
          cy: Number(visibleCircle.getAttribute('cy')),
          viewBox: svg.getAttribute('viewBox') ?? '',
          resetHidden: resetBtn.hidden,
        };
      });
      assert.equal(afterReset.cx, beforeDrag.cx, 'Expected #reset-plate-btn to restore initial node cx');
      assert.equal(afterReset.cy, beforeDrag.cy, 'Expected #reset-plate-btn to restore initial node cy');
      assert.equal(afterReset.viewBox, beforeDrag.viewBox, 'Expected #reset-plate-btn to restore initial viewBox');
      assert.equal(afterReset.resetHidden, true, 'Expected #reset-plate-btn to hide after reset');

      // 6) Verify Focus selected pair toggle (#focus-pair-btn), non-featured edge contrast (0.9), asymmetry summary, and 200% text / 320px reflow
      const focusToggleCheck = await gPage.evaluate(() => {
        const focusBtn = document.getElementById('focus-pair-btn') as HTMLButtonElement | null;
        const svg = document.getElementById('featured-plate-svg')!;
        const nonHitLines = Array.from(svg.querySelectorAll('line:not(.f12-plate-edge-hit)'));
        const hasDimmedContextEdges = nonHitLines.some((l) => l.getAttribute('stroke-opacity') === '0.9');
        const allNodesBefore = Array.from(svg.querySelectorAll('.f12-plate-node')).filter(
          (n) => (n as HTMLElement).style.display !== 'none',
        ).length;
        focusBtn?.click();
        const visibleNodesWhenFocused = Array.from(svg.querySelectorAll('.f12-plate-node')).filter(
          (n) => (n as HTMLElement).style.display !== 'none',
        ).length;
        const pressedWhenFocused = focusBtn?.getAttribute('aria-pressed');
        focusBtn?.click();
        const visibleNodesAfterUnfocus = Array.from(svg.querySelectorAll('.f12-plate-node')).filter(
          (n) => (n as HTMLElement).style.display !== 'none',
        ).length;
        const asymEl = document.querySelector('#cut-c05 .f12-dir-asymmetry');
        return {
          hasFocusBtn: Boolean(focusBtn),
          hasDimmedContextEdges,
          allNodesBefore,
          visibleNodesWhenFocused,
          pressedWhenFocused,
          visibleNodesAfterUnfocus,
          asymText: asymEl?.textContent ?? '',
        };
      });
      assert.equal(focusToggleCheck.hasFocusBtn, true, 'Expected #focus-pair-btn when plate has > 2 nodes');
      assert.equal(focusToggleCheck.hasDimmedContextEdges, true, 'Expected non-featured context edges to use stroke-opacity="0.9"');
      assert.equal(focusToggleCheck.visibleNodesWhenFocused, 2, 'Expected Focus selected pair toggle to isolate the 2 primary nodes');
      assert.equal(focusToggleCheck.pressedWhenFocused, 'true', 'Expected #focus-pair-btn aria-pressed="true" when focused');
      assert.equal(focusToggleCheck.visibleNodesAfterUnfocus, focusToggleCheck.allNodesBefore, 'Expected second click on #focus-pair-btn to restore full ego network');
      assert.ok(focusToggleCheck.asymText.length > 20, `Expected .f12-dir-asymmetry sentence in E-01, got: ${focusToggleCheck.asymText}`);

      // Verify 320px viewport reflow with 200% root font-size (WCAG 1.4.4 / 1.4.10) has no horizontal document overflow
      await gPage.setViewportSize({ width: 320, height: 640 });
      const reflow320Check = await gPage.evaluate(() => {
        document.documentElement.style.fontSize = '32px';
        const docOverflow = document.documentElement.scrollWidth > document.documentElement.clientWidth + 2;
        document.documentElement.style.fontSize = '';
        return { docOverflow };
      });
      assert.equal(reflow320Check.docOverflow, false, 'Expected no horizontal document overflow at 320px width with 200% font size');

      await gPage.close();
    } finally {
      await browser.close();
    }
  });
});
