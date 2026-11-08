import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, devices } from 'playwright';
import {
  applyRepulsionForces,
  computeLayout,
  createSeededRandom,
  type SimNode,
} from '../src/map/layout.js';
import { renderMapHtml } from '../src/map/template.js';
import { generateSyntheticMapData, SYNTHETIC_EDGE_COUNTS } from './fixtures/map-synthetic.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function extractScriptTag(html: string, id: string): string | null {
  const re = new RegExp(`<script type="application/json" id="${id}">[\\s\\S]*?<\\/script>`);
  const match = html.match(re);
  return match ? match[0] : null;
}

function hasChromiumInstalled(): boolean {
  try {
    const execPath = chromium.executablePath();
    return Boolean(execPath && existsSync(execPath));
  } catch {
    return false;
  }
}

describe('RA-15 map engine: contract, layout determinism, and spatial grid equivalence', () => {
  it('keeps the #ra-data script block byte-identical to the pre-RA-15 golden snapshot', () => {
    const goldenPath = join(__dirname, 'fixtures', 'map-ra-data-golden.txt');
    const expected = readFileSync(goldenPath, 'utf8');
    const data = generateSyntheticMapData(50);
    const html = renderMapHtml(data);

    const raDataBlock = extractScriptTag(html, 'ra-data');
    assert.ok(raDataBlock, 'Expected <script type="application/json" id="ra-data"> in HTML');
    assert.equal(raDataBlock, expected);

    const raLayoutBlock = extractScriptTag(html, 'ra-layout');
    assert.ok(raLayoutBlock, 'Expected <script type="application/json" id="ra-layout"> in HTML');
  });

  it('produces deterministic layouts for identical input and different layouts for different repoName', () => {
    const dataA1 = generateSyntheticMapData(150, { repoName: 'repo-alpha' });
    const dataA2 = generateSyntheticMapData(150, { repoName: 'repo-alpha' });
    const dataB = generateSyntheticMapData(150, { repoName: 'repo-bravo' });

    const layoutA1 = computeLayout(dataA1);
    const layoutA2 = computeLayout(dataA2);
    const layoutB = computeLayout(dataB);

    assert.deepEqual(layoutA1, layoutA2);
    assert.equal(layoutA1.x.length, dataA1.nodes.length);
    assert.equal(layoutA1.y.length, dataA1.nodes.length);
    assert.notDeepEqual(layoutA1, layoutB);
  });

  it('matches pairwise repulsion forces within 1e-9 across all synthetic fixtures (50, 150, 500, 1000 edges)', () => {
    for (const edgeCount of SYNTHETIC_EDGE_COUNTS) {
      const data = generateSyntheticMapData(edgeCount);
      const rand = createSeededRandom(data.repoName);
      const dirs: Record<string, { x: number; y: number }> = Object.create(null);
      const dirNames: string[] = [];
      for (const n of data.nodes) {
        if (!dirs[n.dir]) {
          dirs[n.dir] = { x: 0, y: 0 };
          dirNames.push(n.dir);
        }
      }
      dirNames.forEach((name, idx) => {
        const angle = (idx / Math.max(1, dirNames.length)) * Math.PI * 2;
        const radius = 120 + 40 * Math.sqrt(dirNames.length);
        const dirEntry = dirs[name]!;
        dirEntry.x = Math.cos(angle) * radius;
        dirEntry.y = Math.sin(angle) * radius;
      });

      const baseNodes: SimNode[] = data.nodes.map((n, i) => {
        const d = dirs[n.dir]!;
        return {
          i,
          dir: n.dir,
          r: 4 + Math.min(14, Math.sqrt(n.changes) * 1.25),
          x: d.x + (rand() - 0.5) * 80,
          y: d.y + (rand() - 0.5) * 80,
          vx: 0,
          vy: 0,
          pinned: false,
        };
      });
      // Include a coincident pair to verify deterministic pairJitter(a.i, b.i)
      if (baseNodes.length >= 2) {
        baseNodes[1]!.x = baseNodes[0]!.x;
        baseNodes[1]!.y = baseNodes[0]!.y;
      }

      const nodesGrid = baseNodes.map((n) => ({ ...n }));
      const nodesPairwise = baseNodes.map((n) => ({ ...n }));

      applyRepulsionForces(nodesGrid, 0.85, 'grid');
      applyRepulsionForces(nodesPairwise, 0.85, 'pairwise');

      let maxForceDiff = 0;
      for (let i = 0; i < baseNodes.length; i++) {
        maxForceDiff = Math.max(
          maxForceDiff,
          Math.abs(nodesGrid[i]!.vx - nodesPairwise[i]!.vx),
          Math.abs(nodesGrid[i]!.vy - nodesPairwise[i]!.vy),
        );
      }
      assert.ok(
        maxForceDiff <= 1e-9,
        `Expected grid vs pairwise force diff <= 1e-9 for ${edgeCount} edges, got ${maxForceDiff}`,
      );

      // Also verify forces on the settled layout configuration match within <= 1e-9
      const settled = computeLayout(data, { round: false });
      const settledNodesGrid: SimNode[] = baseNodes.map((n, idx) => ({
        ...n,
        x: settled.x[idx]!,
        y: settled.y[idx]!,
        vx: 0,
        vy: 0,
      }));
      const settledNodesPairwise: SimNode[] = settledNodesGrid.map((n) => ({ ...n }));
      applyRepulsionForces(settledNodesGrid, 0.5, 'grid');
      applyRepulsionForces(settledNodesPairwise, 0.5, 'pairwise');
      let maxSettledForceDiff = 0;
      for (let i = 0; i < baseNodes.length; i++) {
        maxSettledForceDiff = Math.max(
          maxSettledForceDiff,
          Math.abs(settledNodesGrid[i]!.vx - settledNodesPairwise[i]!.vx),
          Math.abs(settledNodesGrid[i]!.vy - settledNodesPairwise[i]!.vy),
        );
      }
      assert.ok(
        maxSettledForceDiff <= 1e-9,
        `Expected settled grid vs pairwise force diff <= 1e-9 for ${edgeCount} edges, got ${maxSettledForceDiff}`,
      );
    }
  });

  it('computes the 1,000-edge layout in under 200 ms in Node (median of 10 runs)', () => {
    const data1000 = generateSyntheticMapData(1000);
    // Warm up V8 JIT across 3 runs before timing
    for (let w = 0; w < 3; w++) {
      computeLayout(data1000);
    }
    const durations: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      computeLayout(data1000);
      durations.push(performance.now() - t0);
    }
    durations.sort((a, b) => a - b);
    const medianMs = (durations[4]! + durations[5]!) / 2;
    assert.ok(
      medianMs < 200,
      `Expected median 1,000-edge computeLayout < 200 ms, got ${medianMs.toFixed(1)} ms`,
    );
  });
});

describe('RA-15 map engine: browser runtime behavior (Playwright)', () => {
  const canRunBrowser = hasChromiumInstalled();

  it(
    'falls back to in-browser simulation when #ra-layout is missing, settles with 0 idle rAFs, marches focused ghost wires at <= 13 draws/s, avoids > 50 ms long tasks on 1,000-edge toggles, honors live reduced-motion, and supports keyboard & mobile touch',
    { skip: !canRunBrowser ? 'Playwright Chromium is not installed' : false },
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'ra-map-engine-test-'));
      const browser = await chromium.launch({ headless: true });
      try {
        const data50 = generateSyntheticMapData(50);
        const htmlWithLayout = renderMapHtml(data50);
        const htmlWithoutLayout = renderMapHtml(data50, null);
        assert.equal(extractScriptTag(htmlWithoutLayout, 'ra-layout'), null);

        const pathWithLayout = join(tmpDir, 'map-50.html');
        const pathWithoutLayout = join(tmpDir, 'map-50-fallback.html');
        writeFileSync(pathWithLayout, htmlWithLayout, 'utf8');
        writeFileSync(pathWithoutLayout, htmlWithoutLayout, 'utf8');

        // 1. Fallback when #ra-layout is removed still renders and settles
        {
          const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
          const page = await context.newPage();
          await page.addInitScript(() => {
            const win = window as unknown as { __testDraws: number };
            win.__testDraws = 0;
            const origFillRect = CanvasRenderingContext2D.prototype.fillRect;
            CanvasRenderingContext2D.prototype.fillRect = function (x, y, w, h) {
              if (x === 0 && y === 0 && w > 0 && h > 0) {
                win.__testDraws++;
              }
              return origFillRect.call(this, x, y, w, h);
            };
          });
          await page.goto(pathToFileURL(pathWithoutLayout).href, { waitUntil: 'load' });
          await page.waitForTimeout(1600);
          const drawsBeforeIdle = await page.evaluate(
            () => (window as unknown as { __testDraws: number }).__testDraws,
          );
          assert.ok(drawsBeforeIdle > 5, `Expected fallback simulation to draw multiple frames, got ${drawsBeforeIdle}`);
          // After settling, no further draws should occur when idle
          await page.waitForTimeout(400);
          const drawsAfterIdle = await page.evaluate(
            () => (window as unknown as { __testDraws: number }).__testDraws,
          );
          assert.equal(drawsAfterIdle, drawsBeforeIdle, 'Expected fallback simulation to stop drawing once settled');

          // Also verify corrupted #ra-layout with non-finite coordinates falls back cleanly without NaN arcs
          const pathCorruptLayout = join(tmpDir, 'map-50-corrupt.html');
          const corruptHtml = htmlWithLayout.replace(
            /<script type="application\/json" id="ra-layout">[\s\S]*?<\/script>/,
            `<script type="application/json" id="ra-layout">{"x":[${new Array(data50.nodes.length).fill('null').join(',')}],"y":[${new Array(data50.nodes.length).fill('0').join(',')}]}</script>`,
          );
          writeFileSync(pathCorruptLayout, corruptHtml, 'utf8');
          const pageCorrupt = await context.newPage();
          await pageCorrupt.addInitScript(() => {
            const win = window as unknown as { __testDraws: number; __nanArc: boolean };
            win.__testDraws = 0;
            win.__nanArc = false;
            const origFillRect = CanvasRenderingContext2D.prototype.fillRect;
            CanvasRenderingContext2D.prototype.fillRect = function (x, y, w, h) {
              if (x === 0 && y === 0 && w > 0 && h > 0) win.__testDraws++;
              return origFillRect.call(this, x, y, w, h);
            };
            const origArc = CanvasRenderingContext2D.prototype.arc;
            CanvasRenderingContext2D.prototype.arc = function (x, y, r, sa, ea, ccw) {
              if (!Number.isFinite(x) || !Number.isFinite(y)) win.__nanArc = true;
              return origArc.call(this, x, y, r, sa, ea, ccw);
            };
          });
          await pageCorrupt.goto(pathToFileURL(pathCorruptLayout).href, { waitUntil: 'load' });
          await pageCorrupt.waitForTimeout(400);
          const corruptState = await pageCorrupt.evaluate(() => {
            const win = window as unknown as { __testDraws: number; __nanArc: boolean };
            return { draws: win.__testDraws, nanArc: win.__nanArc };
          });
          assert.ok(corruptState.draws > 2, 'Expected corrupted #ra-layout to fall back to simulation');
          assert.equal(corruptState.nanArc, false, 'Expected no NaN canvas arc coordinates when #ra-layout is corrupted');
          await context.close();
        }

        // 2. Precomputed layout: zero rAF callbacks over 5s idle, focused ghost-wire marching <= 13 draws/s, live reduced-motion change, and keyboard navigation
        {
          const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
          const page = await context.newPage();
          await page.addInitScript(() => {
            const state = { rafCount: 0, drawCount: 0 };
            (window as unknown as Record<string, unknown>).__testMetrics = state;
            const origRAF = window.requestAnimationFrame.bind(window);
            window.requestAnimationFrame = (cb) =>
              origRAF((ts) => {
                state.rafCount++;
                return cb(ts);
              });
            const origFillRect = CanvasRenderingContext2D.prototype.fillRect;
            CanvasRenderingContext2D.prototype.fillRect = function (x, y, w, h) {
              if (x === 0 && y === 0 && w > 0 && h > 0) {
                state.drawCount++;
              }
              return origFillRect.call(this, x, y, w, h);
            };
          });
          await page.goto(pathToFileURL(pathWithLayout).href, { waitUntil: 'load' });
          await page.waitForTimeout(150);

          // Reset counters after initial settle and measure a full 5-second idle window
          await page.evaluate(() => {
            const m = (window as unknown as { __testMetrics: { rafCount: number; drawCount: number } }).__testMetrics;
            m.rafCount = 0;
            m.drawCount = 0;
          });
          await page.waitForTimeout(5000);
          const idleMetrics = await page.evaluate(
            () => (window as unknown as { __testMetrics: { rafCount: number; drawCount: number } }).__testMetrics,
          );
          assert.equal(idleMetrics.rafCount, 0, `Expected 0 rAF callbacks over 5s idle, got ${idleMetrics.rafCount}`);
          assert.equal(idleMetrics.drawCount, 0, `Expected 0 draws over 5s idle, got ${idleMetrics.drawCount}`);

          // Focused ghost-wire marching produces <= 13 draws per second
          // Click the first ghost-wire card in the panel and wait for the 450ms camera flight to complete
          await page.click('.panel .card.interactive');
          await page.waitForTimeout(550);
          await page.evaluate(() => {
            const m = (window as unknown as { __testMetrics: { rafCount: number; drawCount: number } }).__testMetrics;
            m.rafCount = 0;
            m.drawCount = 0;
          });
          await page.waitForTimeout(1000);
          const marchMetrics = await page.evaluate(
            () => (window as unknown as { __testMetrics: { rafCount: number; drawCount: number } }).__testMetrics,
          );
          assert.ok(
            marchMetrics.drawCount >= 8 && marchMetrics.drawCount <= 13,
            `Expected focused ghost-wire marching to produce 8..13 draws/sec, got ${marchMetrics.drawCount}`,
          );

          // Live reduced-motion change is honored immediately without reload
          await page.emulateMedia({ reducedMotion: 'reduce' });
          await page.waitForTimeout(100);
          await page.evaluate(() => {
            const m = (window as unknown as { __testMetrics: { rafCount: number; drawCount: number } }).__testMetrics;
            m.rafCount = 0;
            m.drawCount = 0;
          });
          await page.waitForTimeout(500);
          const reducedMarchMetrics = await page.evaluate(
            () => (window as unknown as { __testMetrics: { rafCount: number; drawCount: number } }).__testMetrics,
          );
          assert.equal(
            reducedMarchMetrics.drawCount,
            0,
            `Expected 0 marching draws after switching reducedMotion to 'reduce' live, got ${reducedMarchMetrics.drawCount}`,
          );
          await page.emulateMedia({ reducedMotion: 'no-preference' });

          // Keyboard: `/` focuses search, `Esc` clears selection & blurs search, `Tab` reaches first panel relationship
          await page.keyboard.press('/');
          const searchFocused = await page.evaluate(() => document.activeElement?.id === 'search');
          assert.equal(searchFocused, true, 'Expected `/` to focus #search');
          await page.keyboard.type('pkg-0');
          await page.keyboard.press('Escape');
          const afterEsc = await page.evaluate(() => ({
            activeId: document.activeElement?.id ?? '',
            searchValue: (document.getElementById('search') as HTMLInputElement).value,
            hasOverviewHeading: Boolean(document.querySelector('.panel h2')?.textContent?.includes('Explore file relationships')),
          }));
          assert.notEqual(afterEsc.activeId, 'search');
          assert.equal(afterEsc.searchValue, '');
          assert.equal(afterEsc.hasOverviewHeading, true, 'Expected Escape to clear selection back to overview');

          // Tab from the last stage button or through the page reaches the first panel relationship card
          await page.focus('#toggle-anim');
          let reachedPanelCard = false;
          for (let i = 0; i < 10; i++) {
            await page.keyboard.press('Tab');
            const isCard = await page.evaluate(() =>
              Boolean(document.activeElement?.classList.contains('card') && document.activeElement?.closest('#panel')),
            );
            if (isCard) {
              reachedPanelCard = true;
              break;
            }
          }
          assert.equal(reachedPanelCard, true, 'Expected Tab navigation to reach the first relationship card in #panel');

          await context.close();
        }

        // 3. No long task > 50 ms when loading or toggling kinds on the 1,000-edge fixture (with and without reducedMotion)
        {
          const data1000 = generateSyntheticMapData(1000);
          const path1000 = join(tmpDir, 'map-1000.html');
          writeFileSync(path1000, renderMapHtml(data1000), 'utf8');

          for (const motionMode of ['no-preference', 'reduce'] as const) {
            const context = await browser.newContext({
              viewport: { width: 1440, height: 900 },
              reducedMotion: motionMode,
            });
            const page = await context.newPage();
            await page.addInitScript(() => {
              const longTasks: number[] = [];
              (window as unknown as Record<string, unknown>).__longTasks = longTasks;
              const obs = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                  if (entry.duration > 50) longTasks.push(Math.round(entry.duration));
                }
              });
              obs.observe({ type: 'longtask', buffered: true });
              (window as unknown as Record<string, unknown>).__flushLongTasks = () => {
                for (const entry of obs.takeRecords()) {
                  if (entry.duration > 50) longTasks.push(Math.round(entry.duration));
                }
              };
            });

            await page.goto(pathToFileURL(path1000).href, { waitUntil: 'load' });
            await page.waitForTimeout(200);
            const toggles = await page.locator('#toggles .toggle').all();
            for (let i = 0; i < 10; i++) {
              await toggles[i % toggles.length]!.click();
              await page.waitForTimeout(60);
            }
            await page.waitForTimeout(300);
            const tasks = await page.evaluate(() => {
              (window as unknown as { __flushLongTasks: () => void }).__flushLongTasks();
              return (window as unknown as { __longTasks: number[] }).__longTasks;
            });
            assert.deepEqual(
              tasks,
              [],
              `Expected 0 long tasks (>50ms) on 1,000-edge fixture with reducedMotion=${motionMode}, got ${JSON.stringify(tasks)}`,
            );
            await context.close();
          }
        }

        // 4. Mobile emulation (iPhone 13): one-finger swipe over canvas scrolls the page, hint text matches touch, and interactive targets >= 24x24 CSS px
        {
          const iPhone13 = devices['iPhone 13'];
          const context = await browser.newContext({ ...iPhone13 });
          const page = await context.newPage();
          await page.goto(pathToFileURL(pathWithLayout).href, { waitUntil: 'load' });
          await page.waitForTimeout(150);

          const mobileChecks = await page.evaluate(() => {
            const canvas = document.getElementById('map')!;
            const touchAction = getComputedStyle(canvas).touchAction;
            const hint = document.querySelector('.hint')?.textContent ?? '';
            return { touchAction, hint };
          });
          assert.equal(mobileChecks.touchAction, 'pan-y');
          assert.equal(mobileChecks.hint, 'Two fingers to pan and zoom');

          // Dispatch a one-finger vertical touch swipe on the canvas
          await page.evaluate(() => {
            const canvas = document.getElementById('map')!;
            const rect = canvas.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const startY = rect.top + rect.height * 0.75;
            canvas.dispatchEvent(
              new PointerEvent('pointerdown', {
                bubbles: true,
                pointerId: 1,
                pointerType: 'touch',
                clientX: cx,
                clientY: startY,
              }),
            );
            for (let step = 1; step <= 5; step++) {
              canvas.dispatchEvent(
                new PointerEvent('pointermove', {
                  bubbles: true,
                  pointerId: 1,
                  pointerType: 'touch',
                  clientX: cx,
                  clientY: startY - step * 35,
                }),
              );
            }
            canvas.dispatchEvent(
              new PointerEvent('pointerup', {
                bubbles: true,
                pointerId: 1,
                pointerType: 'touch',
                clientX: cx,
                clientY: startY - 175,
              }),
            );
          });

          const scrollY = await page.evaluate(() => window.scrollY);
          assert.ok(scrollY > 0, `Expected one-finger swipe over mobile canvas to scroll page (scrollY=${scrollY})`);

          // Select a relationship card so .file-link and .evidence .hash are rendered, then verify >= 24x24 CSS px target sizes
          await page.click('.panel .card.interactive');
          await page.waitForTimeout(100);
          const targetSizes = await page.evaluate(() => {
            const selectors = ['.toggle', '.map-btn', '.file-link', '.evidence .hash'];
            const results: Record<string, { w: number; h: number }> = {};
            for (const sel of selectors) {
              const elem = document.querySelector(sel);
              if (elem) {
                const r = elem.getBoundingClientRect();
                results[sel] = { w: Math.round(r.width), h: Math.round(r.height) };
              }
            }
            return results;
          });
          for (const sel of ['.toggle', '.map-btn', '.file-link', '.evidence .hash']) {
            assert.ok(targetSizes[sel], `Expected ${sel} to be present in DOM`);
            assert.ok(
              targetSizes[sel].w >= 24 && targetSizes[sel].h >= 24,
              `Expected ${sel} to be at least 24x24 CSS px, got ${targetSizes[sel].w}x${targetSizes[sel].h}`,
            );
          }

          await context.close();
        }
      } finally {
        await browser.close();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
