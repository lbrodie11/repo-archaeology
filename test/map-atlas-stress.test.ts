import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MapData } from '../src/commands/map.js';
import { computeRichLayout } from '../src/map/layout.js';
import { renderMapHtml } from '../src/map/template.js';
import {
  awkwardNamesGraph,
  chainGraph,
  cliqueGraph,
  emptyGraph,
  giantGraph,
  mixedGraph,
  pairsGraph,
  starGraph,
} from './fixtures/atlas-graphs.js';
import { loadPlaywright } from './fixtures/plate-fixture.js';

const pw = loadPlaywright();

interface AtlasFrameSnap {
  id: string;
  band: string;
  files: number;
  edges: number;
  visibleEdges: number;
  empty: boolean;
  aggregated: boolean;
  groups: { key: string; files: number; x: number; y: number; r: number }[];
  groupLinks: number;
  caption: string;
  captionPx: number;
  note: string;
  labels: number;
  rect: { x: number; y: number; w: number; h: number };
  nodes: { i: number; x: number; y: number; r: number }[];
}
interface AtlasSnap {
  cam: { x: number; y: number; scale: number };
  size: { w: number; h: number };
  fit: { shown: number; total: number };
  draw: { ms: number; labels: number; aggregated: number; empty: number; invalid: number };
  selectedFrameId: string | null;
  selectedEdgeIdx: number | null;
  frames: AtlasFrameSnap[];
}

// Records the on-screen size of every text the canvas draws, and stubs tsx's __name helper
const SPY_HEAD = `<head><script>
  window.__name = function (fn) { return fn; };
  window.__texts = [];
  (function () {
    var orig = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (t) {
      var m = /(\\d+(?:\\.\\d+)?)px/.exec(this.font);
      var a = this.getTransform().a;
      window.__texts.push({ text: String(t), px: (m ? parseFloat(m[1]) : 0) * a / (window.devicePixelRatio || 1) });
      return orig.apply(this, arguments);
    };
  })();
</script>`;

// Rendering a 300-file map takes a while, and every shape is opened in several browser contexts
const htmlCache = new WeakMap<MapData, string>();
function richHtml(data: MapData): string {
  let html = htmlCache.get(data);
  if (!html) {
    html = renderMapHtml(data, computeRichLayout(data), { style: 'rich' }).replace('<head>', SPY_HEAD);
    htmlCache.set(data, html);
  }
  return html;
}

const snapshot = (page: any): Promise<AtlasSnap> =>
  page.evaluate(() => (document.getElementById('map') as unknown as { __atlasSnapshot(): unknown }).__atlasSnapshot());

async function openAtlas(page: any, data: MapData): Promise<void> {
  await page.setContent(richHtml(data), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(60);
  await page.locator('#view-atlas').click();
  await page.waitForTimeout(80);
}

/** Everything that must hold for the Atlas after any interaction. */
function atlasProblems(snap: AtlasSnap): string[] {
  const out: string[] = [];
  const nums = [snap.cam.x, snap.cam.y, snap.cam.scale, snap.size.w, snap.size.h, snap.draw.ms];
  for (const f of snap.frames) {
    nums.push(f.rect.x, f.rect.y, f.rect.w, f.rect.h);
    for (const n of f.nodes) nums.push(n.x, n.y, n.r);
    for (const g of f.groups) nums.push(g.x, g.y, g.r);
  }
  if (!nums.every(Number.isFinite)) out.push('non-finite geometry');
  if (snap.draw.invalid > 0) out.push(`${snap.draw.invalid} files with invalid coordinates`);
  if (!(snap.cam.scale >= 0.15 && snap.cam.scale <= 6)) out.push(`camera scale ${snap.cam.scale} out of range`);
  for (const f of snap.frames) {
    if (!f.caption.startsWith(f.id)) out.push(`${f.id}: caption "${f.caption}" does not name the frame`);
    if (f.captionPx < 11) out.push(`${f.id}: caption drawn at ${f.captionPx}px`);
    if (f.empty) {
      if (f.visibleEdges !== 0) out.push(`${f.id}: marked empty with visible relationships`);
      if (!/hidden/.test(f.note)) out.push(`${f.id}: blank frame without an explanation`);
    } else if (f.edges > 0) {
      if (f.aggregated) {
        if (f.files < 25) out.push(`${f.id}: small frame drawn as folder groups`);
        if (f.groups.length < 1 || f.groups.length > 7) out.push(`${f.id}: ${f.groups.length} folder groups`);
        if (f.groups.reduce((s, g) => s + g.files, 0) > f.files) out.push(`${f.id}: folder groups hold more files than the frame`);
      } else if (f.nodes.length === 0) {
        out.push(`${f.id}: visible relationships but nothing drawn`);
      }
    }
    if (snap.selectedFrameId === f.id && f.aggregated) out.push(`${f.id}: selected frame is hidden behind folder groups`);
  }
  if (snap.fit.total !== snap.frames.length) out.push('fit does not account for every frame');
  return out;
}

describe('Atlas overview (map --style rich)', { skip: !pw ? 'Playwright is not installed' : false }, () => {
  it('sorts default-hidden groups last, explains every empty frame, and offers a way to show them', async () => {
    const data = mixedGraph();
    const layout = computeRichLayout(data);
    const bands = layout.frames!.map((f) => f.band);
    const firstUnchecked = bands.indexOf('unchecked');
    assert.equal(bands.filter((b) => b === 'unchecked').length, 3);
    assert.ok(bands.slice(firstUnchecked).every((b) => b === 'unchecked'), `unchecked-only groups sort last: ${bands.join(',')}`);
    // When every relationship is unchecked nothing is hidden by default, so no group is demoted
    const allUnchecked = pairsGraph(4);
    allUnchecked.edges.forEach((e) => { e.relationship = 'unknown'; });
    assert.ok(computeRichLayout(allUnchecked).frames!.every((f) => f.band !== 'unchecked'));

    const browser = await pw!.chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', (err: Error) => errors.push(String(err)));
      await openAtlas(page, data);

      let snap = await snapshot(page);
      assert.deepEqual(atlasProblems(snap), []);
      const empties = snap.frames.filter((f) => f.empty);
      assert.equal(empties.length, 3);
      assert.ok(empties.every((f) => f.band === 'unchecked'));
      assert.ok(empties.every((f) => /unchecked link/.test(f.note) && /click/.test(f.note)), JSON.stringify(empties.map((f) => f.note)));
      assert.equal(snap.frames[0]!.empty, false, 'the sheet opens with a frame that has something to show');

      const summary = (await page.locator('#summary').textContent()) ?? '';
      assert.match(summary, /Showing \d+; the filter bar hides 7 unchecked links\./);
      const note = (await page.locator('#empty-frames-note').textContent()) ?? '';
      for (const f of empties) assert.ok(note.includes(f.id), `${note} should list ${f.id}`);
      assert.doesNotMatch((await page.locator('#panel').textContent()) ?? '', /C-0\d \/ (OVERVIEW|EVIDENCE)/);

      // Clicking an explained-empty frame shows its relationships
      const target = empties[0]!;
      const box = (await page.locator('#map').boundingBox())!;
      await page.mouse.click(box.x + target.rect.x + target.rect.w / 2, box.y + target.rect.y + target.rect.h / 2);
      await page.waitForTimeout(60);
      assert.equal(await page.locator('#toggles .toggle[data-kind="unknown"]').getAttribute('aria-pressed'), 'true');
      snap = await snapshot(page);
      assert.equal(snap.frames.filter((f) => f.empty).length, 0);
      assert.deepEqual(atlasProblems(snap), []);
      assert.match((await page.locator('#summary').textContent()) ?? '', /Showing all \d+\./);
      assert.equal(await page.locator('#empty-frames-note').count(), 0);

      // The same action is available without the canvas: a real button, usable from the keyboard
      await page.locator('#toggles .toggle[data-kind="unknown"]').click();
      await page.locator('#reset-view').click();
      await page.locator('#show-hidden-frames').focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(40);
      assert.equal((await snapshot(page)).frames.filter((f) => f.empty).length, 0);

      // With every filter off, every frame explains itself
      for (const kind of ['ghost', 'unknown', 'indirect', 'direct']) {
        const toggle = page.locator(`#toggles .toggle[data-kind="${kind}"]`);
        if ((await toggle.count()) > 0 && (await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click();
      }
      await page.waitForTimeout(40);
      snap = await snapshot(page);
      assert.ok(snap.frames.length > 0 && snap.frames.every((f) => f.empty));
      assert.deepEqual(atlasProblems(snap), []);
      assert.match((await page.locator('#summary').textContent()) ?? '', /Showing 0; the filter bar hides /);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });

  it('shows a big group as folder groups until it is opened, searched or zoomed in', async () => {
    const browser = await pw!.chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', (err: Error) => errors.push(String(err)));
      const data = giantGraph(120, 80);
      await openAtlas(page, data);

      let snap = await snapshot(page);
      assert.deepEqual(atlasProblems(snap), []);
      const big = snap.frames[0]!;
      assert.equal(big.aggregated, true, 'a 120-file frame is too dense for file-level detail at overview zoom');
      assert.ok(big.groups.length >= 3 && big.groups.length <= 7, `${big.groups.length} folder groups`);
      assert.equal(big.groups.reduce((s, g) => s + g.files, 0), 120, 'every file belongs to exactly one group');
      assert.ok(big.groupLinks > 0);
      assert.match(big.note, /Grouped by folder/);
      for (const g of big.groups) {
        assert.ok(g.x - g.r >= big.rect.x && g.x + g.r <= big.rect.x + big.rect.w && g.y - g.r >= big.rect.y && g.y + g.r <= big.rect.y + big.rect.h, `group ${g.key} inside its frame`);
      }
      const box = (await page.locator('#map').boundingBox())!;

      // Hovering a group explains it; clicking zooms to its files
      const group = big.groups.slice().sort((a, b) => b.files - a.files)[0]!;
      await page.mouse.move(box.x + group.x, box.y + group.y);
      await page.waitForTimeout(40);
      assert.match((await page.locator('#tooltip').textContent()) ?? '', /folder group.*files?.*Click to zoom in/s);
      await page.mouse.click(box.x + group.x, box.y + group.y);
      await page.waitForTimeout(650);
      snap = await snapshot(page);
      assert.equal(snap.frames[0]!.aggregated, false, 'zoomed-in frames show individual files');
      assert.ok(snap.cam.scale > big.rect.w / 1188 + 0.05, 'the camera zoomed in');
      assert.ok(snap.frames[0]!.labels > 0 && snap.frames[0]!.nodes.length === 120);
      assert.deepEqual(atlasProblems(snap), []);

      // Reset returns to the overview
      await page.locator('#reset-view').click();
      await page.waitForTimeout(60);
      assert.equal((await snapshot(page)).frames[0]!.aggregated, true);

      // Searching for a file opens its frame so the match is visible, and clearing closes it again
      await page.locator('#search').fill('file-17.ts');
      await page.waitForTimeout(60);
      snap = await snapshot(page);
      assert.equal(snap.frames[0]!.aggregated, false, 'a frame with search matches shows its files');
      await page.locator('#search').fill('');
      await page.waitForTimeout(60);
      assert.equal((await snapshot(page)).frames[0]!.aggregated, true);

      // Clicking the frame itself opens it on its lead relationship, and the inspector names that frame
      await page.mouse.click(box.x + big.rect.x + big.rect.w - 24, box.y + big.rect.y + big.rect.h - 40);
      await page.waitForTimeout(650);
      snap = await snapshot(page);
      assert.equal(snap.selectedFrameId, big.id);
      assert.equal(snap.frames[0]!.aggregated, false);
      const inspecting = (await page.locator('#inspecting-line').textContent()) ?? '';
      assert.ok(inspecting.startsWith(`Inspecting ${big.id} · `), inspecting);
      assert.equal(await page.locator('#panel .cut-section-label').first().textContent(), 'E-01 · EVIDENCE');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(60);
      assert.equal((await snapshot(page)).selectedFrameId, null);
      assert.equal(await page.locator('#panel .cut-section-label').first().textContent(), 'ATLAS · OVERVIEW');

      // A group with room to breathe keeps file-level detail: 30 files alone on a large screen
      await openAtlas(page, giantGraph(30, 10));
      assert.equal((await snapshot(page)).frames[0]!.aggregated, false);

      // A 300-file component stays cheap to draw at overview zoom
      await openAtlas(page, giantGraph(300, 200));
      snap = await snapshot(page);
      assert.deepEqual(atlasProblems(snap), []);
      assert.equal(snap.frames[0]!.aggregated, true);
      assert.equal(snap.draw.labels, 0, 'no file labels are drawn for an aggregated frame');
      assert.ok(snap.draw.ms < 50, `overview draw took ${snap.draw.ms.toFixed(1)}ms`);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });

  it('keeps every drawn text at a readable size at any zoom, and fit reaches every frame', async () => {
    const browser = await pw!.chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const errors: string[] = [];
      page.on('pageerror', (err: Error) => errors.push(String(err)));
      await openAtlas(page, mixedGraph());
      const box = (await page.locator('#map').boundingBox())!;
      for (const zoomOutTicks of [0, 3, 8, 30]) {
        await page.locator('#reset-view').click();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        for (let i = 0; i < zoomOutTicks; i++) await page.mouse.wheel(0, 240);
        await page.evaluate(() => { (window as unknown as { __texts: unknown[] }).__texts.length = 0; });
        await page.mouse.wheel(0, zoomOutTicks === 30 ? 1 : -1);
        await page.waitForTimeout(60);
        const texts: { text: string; px: number }[] = await page.evaluate(() => (window as unknown as { __texts: { text: string; px: number }[] }).__texts);
        assert.ok(texts.length > 0, 'the canvas drew text');
        for (const t of texts) {
          assert.ok(t.px >= 10.5 && t.px <= 14.5, `"${t.text}" drawn at ${t.px.toFixed(1)}px after ${zoomOutTicks} zoom-out ticks`);
        }
        assert.deepEqual(atlasProblems(await snapshot(page)), []);
      }

      // More than 12 frames: fit shows all of them, not just the first 12
      await openAtlas(page, pairsGraph(16));
      let snap = await snapshot(page);
      assert.equal(snap.frames.length, 16);
      assert.equal(snap.fit.shown, 16);
      for (const f of snap.frames) {
        assert.ok(f.rect.x >= 0 && f.rect.y >= 0 && f.rect.x + f.rect.w <= snap.size.w && f.rect.y + f.rect.h <= snap.size.h, `${f.id} is inside the canvas after fit`);
      }

      // Far too many frames to read at once: fit keeps a readable scale, starts at the top, and says so
      await openAtlas(page, pairsGraph(120, 4));
      snap = await snapshot(page);
      assert.equal(snap.frames.length, 120);
      assert.ok(snap.fit.shown < 120 && snap.fit.shown >= 1);
      assert.ok(snap.cam.scale >= 0.3, `fit scale ${snap.cam.scale}`);
      const fullyVisible = snap.frames.filter((f) => f.rect.y >= 0 && f.rect.y + f.rect.h <= snap.size.h).length;
      assert.equal(fullyVisible, snap.fit.shown);
      assert.equal(snap.frames[0]!.rect.y > 0 && snap.frames[0]!.rect.y < 140, true, 'the first row starts at the top');
      assert.match((await page.locator('.hint').textContent()) ?? '', new RegExp(`Showing the first ${snap.fit.shown} of 120 groups`));
      assert.deepEqual(atlasProblems(snap), []);
      // Zooming all the way out reaches the last frame
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 400);
      await page.waitForTimeout(60);
      snap = await snapshot(page);
      assert.deepEqual(atlasProblems(snap), []);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });

  it('survives seeded random interaction on every graph shape and viewport', async () => {
    const shapes: [string, MapData][] = [
      ['empty', emptyGraph()],
      ['one pair', pairsGraph(1)],
      ['three pairs', pairsGraph(3)],
      ['star', starGraph(30)],
      ['clique', cliqueGraph(12)],
      ['chain', chainGraph(20)],
      ['mixed', mixedGraph()],
      ['giant 300', giantGraph(300, 200)],
      ['awkward names', awkwardNamesGraph()],
      ['120 groups', pairsGraph(120, 4)],
    ];
    const contexts: [string, Record<string, unknown>, number][] = [
      ['desktop', { viewport: { width: 1440, height: 900 } }, 24],
      ['hidpi reduced-motion', { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2, reducedMotion: 'reduce' }, 8],
      ['forced-colors narrow', { viewport: { width: 820, height: 700 }, forcedColors: 'active' }, 8],
      ['phone touch', { viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true }, 8],
      ['small phone', { viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true }, 5],
    ];
    // RA_STRESS_SEED / RA_STRESS_STEPS explore other walks locally; CI uses the fixed defaults
    let seed = Number(process.env.RA_STRESS_SEED) || 20261109;
    const stepScale = Number(process.env.RA_STRESS_STEPS) || 1;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;

    const browser = await pw!.chromium.launch({ headless: true });
    try {
      for (const [contextName, contextOptions, steps] of contexts) {
        const context = await browser.newContext(contextOptions);
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (err: Error) => errors.push(String(err)));
        page.on('console', (msg: { type(): string; text(): string }) => {
          if (msg.type() === 'error') errors.push(msg.text());
        });
        const touch = Boolean(contextOptions.hasTouch);
        for (const [shapeName, data] of shapes) {
          const where = `${shapeName} / ${contextName}`;
          await openAtlas(page, data);
          let snap = await snapshot(page);
          assert.deepEqual(atlasProblems(snap), [], `${where}: initial`);
          assert.deepEqual(errors, [], `${where}: initial`);
          // On narrow screens the panel stacks above the canvas and changes height with the selection,
          // so the canvas is scrolled into view and measured again before every step
          const viewport = page.viewportSize()!;
          let box = { x: 0, y: 0, width: 0, height: 0 };
          const locateCanvas = async () => {
            await page.locator('#map').scrollIntoViewIfNeeded();
            box = (await page.locator('#map').boundingBox())!;
          };
          await locateCanvas();
          const clickAt = async (x: number, y: number) => {
            const px = box.x + x, py = box.y + y;
            if (x < 2 || y < 2 || x > box.width - 2 || y > box.height - 2 || py < 2 || py > viewport.height - 2) return false;
            if (touch) await page.touchscreen.tap(px, py);
            else await page.mouse.click(px, py);
            return true;
          };
          // Every viewport must be able to reach the canvas: open the first frame, then return to the overview
          if (snap.frames.length > 0) {
            const first = snap.frames[0]!;
            assert.equal(await clickAt(first.rect.x + first.rect.w / 2, first.rect.y + Math.min(first.rect.h - 6, first.rect.h * 0.8)), true, `${where}: first frame is clickable`);
            await page.waitForTimeout(30);
            assert.deepEqual(atlasProblems(await snapshot(page)), [], `${where}: after opening the first frame`);
            assert.deepEqual(errors, [], `${where}: after opening the first frame`);
            await page.locator('#reset-view').click();
          }
          const log: string[] = [];
          for (let step = 0; step < Math.ceil(steps * stepScale); step++) {
            await locateCanvas();
            snap = await snapshot(page);
            const r = rand();
            let did = '';
            if (r < 0.14 && snap.frames.length > 0) {
              const f = pick(snap.frames);
              if (await clickAt(f.rect.x + f.rect.w * (0.2 + rand() * 0.6), f.rect.y + f.rect.h * (0.3 + rand() * 0.6))) did = `click frame ${f.id}`;
            } else if (r < 0.26) {
              const withNodes = snap.frames.filter((f) => f.nodes.length > 0);
              if (withNodes.length > 0) {
                const n = pick(pick(withNodes).nodes);
                if (await clickAt(n.x, n.y)) did = `click file ${n.i}`;
              }
            } else if (r < 0.34) {
              const withGroups = snap.frames.filter((f) => f.groups.length > 0);
              if (withGroups.length > 0) {
                const g = pick(pick(withGroups).groups);
                if (await clickAt(g.x, g.y)) did = `click group ${g.key}`;
              }
            } else if (r < 0.5 && !touch) {
              await page.mouse.move(box.x + box.width * rand(), box.y + box.height * rand());
              await page.mouse.wheel(0, (rand() - 0.5) * 900);
              did = 'wheel zoom';
            } else if (r < 0.6 && !touch) {
              const x = box.x + box.width * (0.2 + rand() * 0.6), y = box.y + box.height * (0.2 + rand() * 0.6);
              await page.mouse.move(x, y);
              await page.mouse.down();
              await page.mouse.move(x + (rand() - 0.5) * 300, y + (rand() - 0.5) * 300, { steps: 3 });
              await page.mouse.up();
              did = 'drag';
            } else if (r < 0.7) {
              const toggles = page.locator('#toggles .toggle');
              const count = await toggles.count();
              if (count > 0) {
                await toggles.nth(Math.floor(rand() * count)).click();
                did = 'toggle filter';
              }
            } else if (r < 0.78 && data.nodes.length > 0) {
              const name = pick(data.nodes).path.split('/').pop()!.slice(0, 6);
              await page.locator('#search').fill(rand() < 0.3 ? '' : name);
              did = `search "${name}"`;
            } else if (r < 0.84) {
              await page.locator(pick(['#reset-view', '#fit-frame', '#focus-top'])).click();
              did = 'view button';
            } else if (r < 0.9) {
              await page.keyboard.press('Escape');
              did = 'escape';
            } else if (r < 0.96) {
              const cards = page.locator('#panel .card.interactive:visible, #panel .back-btn:visible');
              const count = await cards.count();
              if (count > 0) {
                await cards.nth(Math.floor(rand() * Math.min(count, 5))).click();
                did = 'panel control';
              }
            } else {
              await page.locator('#view-briefing').click();
              await page.locator('#view-atlas').click();
              did = 'briefing and back';
            }
            if (!did) continue;
            log.push(did);
            await page.waitForTimeout(20);
            const at = `${where}: step ${step} (${log.slice(-4).join(' > ')})`;
            assert.deepEqual(errors, [], at);
            snap = await snapshot(page);
            assert.deepEqual(atlasProblems(snap), [], at);
            // The inspector always names the frame of what is selected
            if (snap.selectedFrameId && (await page.locator('#inspecting-line').count()) > 0) {
              const line = (await page.locator('#inspecting-line').textContent()) ?? '';
              assert.ok(line.includes(snap.selectedFrameId), `${at}: inspector says "${line}" for ${snap.selectedFrameId}`);
            }
            const panelSize = await page.evaluate(() => document.getElementById('panel')!.getElementsByTagName('*').length);
            assert.ok(panelSize < 4000, `${at}: panel grew to ${panelSize} elements`);
          }
        }
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });
});
