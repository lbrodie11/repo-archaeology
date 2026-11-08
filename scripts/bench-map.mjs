#!/usr/bin/env node
/**
 * Map engine benchmark (`npm run bench:map`).
 *
 * Loads deterministic synthetic fixtures (50, 150, 500, and 1,000 edges), plus a
 * real repository map when `RA_BENCH_REPO` is set, in headless Chromium via Playwright.
 *
 * All page instrumentation happens exclusively through `page.addInitScript`;
 * product code has zero benchmark hooks.
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { buildMapData } from '../src/commands/map.js';
import { loadContext } from '../src/context.js';
import { RELATIONSHIPS } from '../src/imports/classify.js';
import { renderMapHtml } from '../src/map/template.js';
import { generateSyntheticMapData, SYNTHETIC_EDGE_COUNTS } from '../test/fixtures/map-synthetic.js';

const INIT_SCRIPT = `
(() => {
  const state = {
    phase: 'load',
    rafTotal: 0,
    idleRafCount: 0,
    draws: [],
    currentArcHash: null,
    currentDrawStartMs: 0,
    longTasksLoad: [],
    longTasksToggles: [],
    longTasksReducedMotionToggles: [],
    flushLongTasks: () => {},
  };
  window.__raBench = state;

  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const handleEntries = (entries) => {
        for (const entry of entries) {
          if (entry.duration > 50) {
            const rec = { startTime: Math.round(entry.startTime * 10) / 10, duration: Math.round(entry.duration * 10) / 10 };
            if (state.phase === 'toggles') {
              state.longTasksToggles.push(rec);
            } else if (state.phase === 'toggles-reduced') {
              state.longTasksReducedMotionToggles.push(rec);
            } else if (state.phase === 'load') {
              state.longTasksLoad.push(rec);
            }
          }
        }
      };
      const obs = new PerformanceObserver((list) => {
        handleEntries(list.getEntries());
      });
      obs.observe({ type: 'longtask', buffered: true });
      state.flushLongTasks = () => {
        handleEntries(obs.takeRecords());
      };
    } catch {
      // ignore if longtask observer unsupported
    }
  }

  const origRAF = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    return origRAF(function (ts) {
      state.rafTotal++;
      if (state.phase === 'idle') {
        state.idleRafCount++;
      }
      return cb(ts);
    });
  };

  const proto = CanvasRenderingContext2D.prototype;
  const origFillRect = proto.fillRect;
  const origArc = proto.arc;

  proto.fillRect = function (x, y, w, h) {
    if (x === 0 && y === 0 && w > 0 && h > 0) {
      const now = performance.now();
      if (state.currentArcHash !== null && state.phase === 'load') {
        state.draws.push({ ms: state.currentDrawStartMs, hash: state.currentArcHash });
      }
      state.currentDrawStartMs = now;
      state.currentArcHash = 2166136261;
    }
    return origFillRect.call(this, x, y, w, h);
  };

  proto.arc = function (x, y, r, startAngle, endAngle, counterclockwise) {
    if (state.currentArcHash !== null) {
      const xi = Math.round(x * 10) | 0;
      const yi = Math.round(y * 10) | 0;
      let h = state.currentArcHash;
      h = Math.imul(h ^ (xi & 0xffff), 16777619) >>> 0;
      h = Math.imul(h ^ ((xi >>> 16) & 0xffff), 16777619) >>> 0;
      h = Math.imul(h ^ (yi & 0xffff), 16777619) >>> 0;
      h = Math.imul(h ^ ((yi >>> 16) & 0xffff), 16777619) >>> 0;
      state.currentArcHash = h;
    }
    return origArc.call(this, x, y, r, startAngle, endAngle, counterclockwise);
  };
})();
`;

async function waitForSettle(page) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const status = await page.evaluate(() => {
      const s = window.__raBench;
      const now = performance.now();
      const draws = s.currentArcHash !== null
        ? [...s.draws, { ms: s.currentDrawStartMs, hash: s.currentArcHash }]
        : s.draws;
      if (draws.length === 0) return { settled: false };
      const last = draws[draws.length - 1];
      // Settled if no draw in the last 220ms
      if (now - last.ms >= 220) {
        return { settled: true, draws };
      }
      // Or settled if the last 6 draws had identical node positions (e.g. marching while layout is settled)
      if (draws.length >= 6) {
        const targetHash = last.hash;
        let sameCount = 0;
        for (let i = draws.length - 1; i >= 0; i--) {
          if (draws[i].hash === targetHash) sameCount++;
          else break;
        }
        if (sameCount >= 6) {
          return { settled: true, draws };
        }
      }
      return { settled: false };
    });
    if (status.settled) {
      const draws = status.draws;
      const firstDrawMs = draws[0].ms;
      const finalHash = draws[draws.length - 1].hash;
      let settleIdx = draws.length - 1;
      while (settleIdx > 0 && draws[settleIdx - 1].hash === finalHash) {
        settleIdx--;
      }
      const settleMs = draws[settleIdx].ms;
      return {
        firstDrawMs: Math.round(firstDrawMs * 10) / 10,
        settleMs: Math.round(settleMs * 10) / 10,
      };
    }
    await page.waitForTimeout(60);
  }
  throw new Error('Timed out waiting for map layout to settle');
}

async function benchmarkFixture(browser, label, htmlPath, fileBytes) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(INIT_SCRIPT);

  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
  const { firstDrawMs, settleMs } = await waitForSettle(page);
  await page.waitForTimeout(80);
  await page.evaluate(() => {
    window.__raBench.flushLongTasks();
    window.__raBench.phase = 'idle';
    window.__raBench.idleRafCount = 0;
  });

  // Measure rAF callbacks over 5 seconds of idle with ghost wires visible
  await page.waitForTimeout(5000);
  const idleRafCount = await page.evaluate(() => window.__raBench.idleRafCount);

  // Switch to toggles phase and perform 10 scripted kind toggles
  await page.evaluate(() => {
    window.__raBench.phase = 'toggles';
  });

  const toggleCount = await page.locator('#toggles .toggle').count();
  for (let i = 0; i < 10; i++) {
    const idx = i % Math.max(1, toggleCount);
    await page.locator('#toggles .toggle').nth(idx).click();
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(250);

  const metrics = await page.evaluate(() => {
    window.__raBench.flushLongTasks();
    const mem = performance.memory ? performance.memory.usedJSHeapSize : null;
    return {
      longTasksLoad: window.__raBench.longTasksLoad,
      longTasksToggles: window.__raBench.longTasksToggles,
      usedJSHeapSize: mem,
    };
  });

  await context.close();

  // Also measure 10 scripted kind toggles under prefers-reduced-motion: reduce
  const rmContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  });
  const rmPage = await rmContext.newPage();
  await rmPage.addInitScript(INIT_SCRIPT);
  await rmPage.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
  await waitForSettle(rmPage);
  await rmPage.waitForTimeout(80);
  await rmPage.evaluate(() => {
    window.__raBench.flushLongTasks();
    window.__raBench.phase = 'toggles-reduced';
  });
  const rmToggleCount = await rmPage.locator('#toggles .toggle').count();
  for (let i = 0; i < 10; i++) {
    const idx = i % Math.max(1, rmToggleCount);
    await rmPage.locator('#toggles .toggle').nth(idx).click();
    await rmPage.waitForTimeout(40);
  }
  await rmPage.waitForTimeout(150);
  const rmMetrics = await rmPage.evaluate(() => {
    window.__raBench.flushLongTasks();
    return window.__raBench.longTasksReducedMotionToggles;
  });
  await rmContext.close();

  const maxLoadLongTask = metrics.longTasksLoad.reduce((m, t) => Math.max(m, t.duration), 0);
  const maxToggleLongTask = metrics.longTasksToggles.reduce((m, t) => Math.max(m, t.duration), 0);
  const maxRmToggleLongTask = rmMetrics.reduce((m, t) => Math.max(m, t.duration), 0);

  return {
    label,
    fileKiB: Math.round((fileBytes / 1024) * 10) / 10,
    firstDrawMs,
    settleMs,
    longTasksLoadCount: metrics.longTasksLoad.length,
    maxLoadLongTaskMs: Math.round(maxLoadLongTask * 10) / 10,
    longTasksTogglesCount: metrics.longTasksToggles.length,
    maxToggleLongTaskMs: Math.round(maxToggleLongTask * 10) / 10,
    longTasksRmTogglesCount: rmMetrics.length,
    maxRmToggleLongTaskMs: Math.round(maxRmToggleLongTask * 10) / 10,
    idleRaf5s: idleRafCount,
    heapMiB: metrics.usedJSHeapSize !== null ? Math.round((metrics.usedJSHeapSize / (1024 * 1024)) * 10) / 10 : null,
  };
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'ra-bench-map-'));
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-precise-memory-info'],
  });

  try {
    // Warm up Chromium renderer/V8/Canvas2D pipeline once so the first fixture is not penalized by cold startup
    const warmPath = join(tmp, 'warmup.html');
    writeFileSync(warmPath, renderMapHtml(generateSyntheticMapData(10)), 'utf8');
    const warmCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const warmPage = await warmCtx.newPage();
    await warmPage.goto(pathToFileURL(warmPath).href, { waitUntil: 'load' });
    await warmPage.waitForTimeout(100);
    await warmCtx.close();

    const fixtures = [];
    for (const edgeCount of SYNTHETIC_EDGE_COUNTS) {
      const data = generateSyntheticMapData(edgeCount);
      const html = renderMapHtml(data);
      const htmlPath = join(tmp, `synthetic-${edgeCount}.html`);
      writeFileSync(htmlPath, html, 'utf8');
      fixtures.push({
        label: `${edgeCount} edges (${data.nodes.length} nodes)`,
        htmlPath,
        fileBytes: statSync(htmlPath).size,
      });
    }

    if (process.env.RA_BENCH_REPO) {
      const repoPath = resolve(process.env.RA_BENCH_REPO);
      const ctx = await loadContext(repoPath, {});
      const data = buildMapData(ctx, { edges: 150, kinds: [...RELATIONSHIPS], uncheckedCap: 10 });
      const html = renderMapHtml(data);
      const htmlPath = join(tmp, 'real-repo.html');
      writeFileSync(htmlPath, html, 'utf8');
      fixtures.push({
        label: `repo:${data.repoName} (${data.edges.length} edges, ${data.nodes.length} nodes)`,
        htmlPath,
        fileBytes: statSync(htmlPath).size,
      });
    }

    const results = [];
    for (const f of fixtures) {
      const res = await benchmarkFixture(browser, f.label, f.htmlPath, f.fileBytes);
      results.push(res);
    }

    console.log('\n| Fixture | HTML Size | First Draw | Settle | Load Long Tasks (>50ms) | Toggle Long Tasks (10x / reduced-motion) | Idle rAF (5s) | JS Heap |');
    console.log('| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const r of results) {
      const loadLT = r.longTasksLoadCount > 0 ? `${r.longTasksLoadCount} (max ${r.maxLoadLongTaskMs} ms)` : '0';
      const toggleLT = r.longTasksTogglesCount > 0 ? `${r.longTasksTogglesCount} (max ${r.maxToggleLongTaskMs} ms)` : '0';
      const rmToggleLT = r.longTasksRmTogglesCount > 0 ? `${r.longTasksRmTogglesCount} (max ${r.maxRmToggleLongTaskMs} ms)` : '0';
      const heap = r.heapMiB !== null ? `${r.heapMiB} MiB` : 'n/a';
      console.log(
        `| ${r.label} | ${r.fileKiB} KiB | ${r.firstDrawMs} ms | ${r.settleMs} ms | ${loadLT} | ${toggleLT} / ${rmToggleLT} | ${r.idleRaf5s} | ${heap} |`,
      );
    }
    console.log('');

    if (process.env.RA_BENCH_JSON) {
      console.log(JSON.stringify(results, null, 2));
    }
  } finally {
    await browser.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
