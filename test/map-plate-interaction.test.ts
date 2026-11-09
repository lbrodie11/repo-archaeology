import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { computeRichLayout } from '../src/map/layout.js';
import { renderMapHtml } from '../src/map/template.js';
import { generateSyntheticMapData } from './fixtures/map-synthetic.js';
import {
  buildDensePickerMap as buildFixture,
  loadPlaywright,
  MEASURE_PLATE,
  plateProblems,
  type PlateMeasure,
} from './fixtures/plate-fixture.js';

const pw = loadPlaywright();
const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

function buildDensePickerMap(): string {
  const built = buildFixture();
  cleanups.push(built.cleanup);
  return built.htmlPath;
}


describe('Briefing blueprint plate interaction (map --style rich)', { skip: !pw ? 'Playwright is not installed' : false }, () => {
  it('selects files and wires by click and keyboard, returns to the family, and lays out every plate cleanly', async () => {
    const htmlPath = buildDensePickerMap();
    const url = pathToFileURL(htmlPath).href;
    const browser = await pw!.chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
      const errors: string[] = [];
      page.on('pageerror', (err: Error) => errors.push(String(err)));
      // tsx wraps named functions passed to page.evaluate in a __name() helper
      await page.addInitScript(() => {
        (window as unknown as { __name: (fn: unknown) => unknown }).__name = (fn) => fn;
      });
      await page.goto(url);
      await page.waitForSelector('#featured-plate-svg .f12-plate-node');

      const headline = () => page.locator('#briefing-headline').textContent();
      const familyHeadline = (await headline()) ?? '';
      const familyBriefingText = (await page.locator('#briefing-view').innerText()) ?? '';
      assert.match(familyHeadline, /files sharing the -picker suffix/, `Expected a *-picker family lead, got: ${familyHeadline}`);

      const initial = (await page.evaluate(MEASURE_PLATE)) as PlateMeasure;
      assert.ok(initial.nodes.length >= 10, `Expected a dense plate, got ${initial.nodes.length} files`);
      assert.deepEqual(plateProblems(initial, { strict: true }), [], 'Initial (server-built) family plate');
      const footer = (await page.locator('.f12-plate-meta').textContent()) ?? '';
      assert.match(footer, /Click a file or wire to inspect/);

      // The report's plate and the in-page engine agree exactly for the same input
      const parity = await page.evaluate(() => {
        const data = JSON.parse(document.getElementById('ra-data')!.textContent!);
        const briefing = JSON.parse(document.getElementById('ra-briefing')!.textContent!);
        const famIdx = briefing.featured.familyIndex as number;
        const fam = data.families[famIdx];
        const prebuilt = briefing.families[famIdx].plate;
        const engine = (window as unknown as { RAPlateLayout: { computePlateLayout: Function } }).RAPlateLayout;
        const recomputed = engine.computePlateLayout(
          data,
          { seeds: fam.nodeIndices, leadEdge: briefing.families[famIdx].edgeIndex, featuredEdges: fam.edgeIndices },
          { mode: 'desktop', visible: { ghost: true, unknown: true, indirect: true, direct: true, test: true } },
        );
        return { same: JSON.stringify(recomputed) === JSON.stringify(prebuilt), nodes: prebuilt.nodes.length };
      });
      assert.equal(parity.same, true, 'Server-built and in-page plates must be identical for the same input');

      // Rows follow the relationship to the pair: pair on top, then shared, one-sided, other
      const groupRows = await page.evaluate(() => {
        const rows: Record<string, number[]> = {};
        for (const g of Array.from(document.querySelectorAll('#featured-plate-svg .f12-plate-node'))) {
          const dot = g.querySelector('.f12-plate-node-dot')!;
          (rows[g.getAttribute('data-group') ?? '?'] ??= []).push(Number(dot.getAttribute('cy')));
        }
        return rows;
      });
      const maxY = (k: string) => Math.max(...(groupRows[k] ?? [-Infinity]));
      const minY = (k: string) => Math.min(...(groupRows[k] ?? [Infinity]));
      assert.equal(groupRows['focus']?.length, 2);
      assert.ok(maxY('focus') < minY('shared'), 'shared files sit below the pair');
      assert.ok(maxY('shared') < Math.min(minY('a-only'), minY('b-only'), minY('other')), 'one-sided and other files sit below shared files');

      // The hidden-connection disclosure matches what the plate actually omits
      const disclosure = await page.evaluate(() => {
        const data = JSON.parse(document.getElementById('ra-data')!.textContent!);
        const drawn = new Set(
          Array.from(document.querySelectorAll('#featured-plate-svg .f12-plate-node')).map((g) => Number(g.getAttribute('data-node-idx'))),
        );
        const between = data.edges.filter((e: { source: number; target: number }) => drawn.has(e.source) && drawn.has(e.target)).length;
        const wires = document.querySelectorAll('#featured-plate-svg .f12-plate-edge-hit').length;
        const text = document.querySelector('.f12-plate-meta')!.textContent ?? '';
        const m = /(\d+) connections? between context files hidden/.exec(text);
        return { omitted: between - wires, disclosed: m ? Number(m[1]) : 0 };
      });
      assert.equal(disclosure.disclosed, disclosure.omitted, 'Every omitted connection is disclosed, and only those');

      // 1) Clicking every file on the family plate pivots C-01 to one of that file's pairs
      for (const n of initial.nodes) {
        const dot = page.locator(`#featured-plate-svg .f12-plate-node[data-node-idx="${n.idx}"] .f12-plate-node-dot`);
        await dot.click({ force: true });
        // The file under the pointer may stay traced (it is being pointed at), but once the pointer
        // leaves, nothing may stay faded: a mouse click must not leave a focus highlight behind
        await page.mouse.move(2, 2);
        assert.equal(
          await page.evaluate(() => document.getElementById('featured-plate-svg')!.classList.contains('has-hot')),
          false,
          'No highlight is left behind after a mouse click once the pointer moves away',
        );
        const pivoted = (await headline()) ?? '';
        assert.notEqual(pivoted, familyHeadline, `Clicking ${n.text} should select one of its pairs`);
        assert.ok(pivoted.includes(n.text), `Expected pair headline to mention ${n.text}, got: ${pivoted}`);
        assert.match(await page.evaluate(() => location.hash), /^#f=/, 'Selecting from the plate should update the deep link');

        const back = page.locator('#back-to-family-btn');
        assert.equal(await back.count(), 1, `Expected a Back to family button after selecting ${n.text}`);
        await back.click();
        assert.equal(await headline(), familyHeadline, 'Back to family should restore the family finding');
        assert.equal(await page.locator('#back-to-family-btn').count(), 0);
      }

      // Shared reports describe contributor concentration without naming the person
      const firstNode = initial.nodes[0]!;
      await page
        .locator(`#featured-plate-svg .f12-plate-node[data-node-idx="${firstNode.idx}"] .f12-plate-node-dot`)
        .click({ force: true });
      const pairText = (await page.locator('#briefing-view').innerText()) ?? '';
      assert.match(pairText, /One contributor made \d+% of /, 'Expected an unnamed contributor concentration note');
      for (const text of [familyBriefingText, pairText, (await page.locator('#panel').textContent()) ?? '']) {
        assert.equal(text.includes('Quartermaine'), false, 'Briefing and panel must not name the contributor');
      }
      await page.locator('#back-to-family-btn').click();

      // 2) Clicking a context wire selects that pair
      const wirePoint = await page.evaluate(() => {
        const svg = document.getElementById('featured-plate-svg') as unknown as SVGSVGElement;
        const hits = Array.from(svg.querySelectorAll('.f12-plate-edge-hit')) as SVGPathElement[];
        for (const l of hits) {
          const len = l.getTotalLength();
          for (const t of [0.35, 0.5, 0.65]) {
            const at = l.getPointAtLength(len * t);
            const p = svg.createSVGPoint();
            p.x = at.x;
            p.y = at.y;
            const s = p.matrixTransform(svg.getScreenCTM()!);
            if (document.elementFromPoint(s.x, s.y) === l) return { x: s.x, y: s.y };
          }
        }
        return null;
      });
      assert.ok(wirePoint, 'Expected at least one unobstructed wire on the plate');
      await page.mouse.click(wirePoint.x, wirePoint.y);
      assert.notEqual(await headline(), familyHeadline, 'Clicking a wire should select that pair');
      await page.locator('#back-to-family-btn').click();

      // 3) Keyboard: plate files are focusable buttons; Enter selects and keeps focus on that file
      const kbNode = initial.nodes[4]!;
      const kbLoc = page.locator(`#featured-plate-svg .f12-plate-node[data-node-idx="${kbNode.idx}"]`);
      assert.equal(await kbLoc.getAttribute('role'), 'button');
      assert.equal(await kbLoc.getAttribute('tabindex'), '0');
      await kbLoc.focus();
      await page.keyboard.press('Enter');
      assert.ok(((await headline()) ?? '').includes(kbNode.text), 'Enter on a plate file should select its pair');
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute('data-node-idx')),
        kbNode.idx,
        'Focus should stay on the selected file after the Briefing re-renders',
      );

      // 4) Dragging a file must not count as a click
      await page.locator('#back-to-family-btn').click();
      const dragDot = await page
        .locator(`#featured-plate-svg .f12-plate-node[data-node-idx="${initial.nodes[6]!.idx}"] .f12-plate-node-dot`)
        .boundingBox();
      await page.mouse.move(dragDot!.x + dragDot!.width / 2, dragDot!.y + dragDot!.height / 2);
      await page.mouse.down();
      await page.mouse.move(dragDot!.x + 70, dragDot!.y + 30, { steps: 5 });
      await page.mouse.up();
      assert.equal(await headline(), familyHeadline, 'Dragging a file should move it, not select a pair');
      const followsDrag = await page.evaluate((idx: string) => {
        const svg = document.getElementById('featured-plate-svg')!;
        const dot = svg.querySelector(`.f12-plate-node[data-node-idx="${idx}"] .f12-plate-node-dot`)!;
        const cx = Number(dot.getAttribute('cx')), cy = Number(dot.getAttribute('cy'));
        const wires = Array.from(svg.querySelectorAll('.f12-plate-wire')).filter(
          (w) => w.getAttribute('data-source') === idx || w.getAttribute('data-target') === idx,
        );
        return wires.length > 0 && wires.every((w) => {
          const n = (w.getAttribute('d') ?? '').match(/-?\d+(\.\d+)?/g)!.map(Number);
          const end = w.getAttribute('data-source') === idx ? [n[0], n[1]] : [n[4], n[5]];
          return Math.abs(end[0]! - cx) < 0.5 && Math.abs(end[1]! - cy) < 0.5;
        });
      }, initial.nodes[6]!.idx);
      assert.equal(followsDrag, true, 'Curved wires stay attached to a dragged file');

      // Pointing at a file lights up its wires and neighbours and steps the rest back; leaving restores it
      const hov = initial.nodes[3]!;
      await page.locator(`#featured-plate-svg .f12-plate-node[data-node-idx="${hov.idx}"] .f12-plate-node-dot`).hover({ force: true });
      await page.waitForTimeout(220);
      const hot = await page.evaluate((idx: string) => {
        const svg = document.getElementById('featured-plate-svg')!;
        const wires = Array.from(svg.querySelectorAll('.f12-plate-wire'));
        const incident = wires.filter((w) => w.getAttribute('data-source') === idx || w.getAttribute('data-target') === idx);
        const others = wires.filter((w) => !incident.includes(w));
        return {
          hasHot: svg.classList.contains('has-hot'),
          hotWires: wires.filter((w) => w.classList.contains('is-hot')).length,
          incident: incident.length,
          incidentHot: incident.every((w) => w.classList.contains('is-hot') && Number(getComputedStyle(w).opacity) === 1),
          othersDimmed: others.every((w) => Number(getComputedStyle(w).opacity) < 0.2),
          aria: svg.querySelector(`.f12-plate-node[data-node-idx="${idx}"]`)!.getAttribute('aria-label') ?? '',
        };
      }, hov.idx);
      assert.equal(hot.hasHot, true, 'Hovering a file highlights it');
      assert.ok(hot.incident > 0 && hot.hotWires === hot.incident && hot.incidentHot, `Its ${hot.incident} wires are lit`);
      assert.equal(hot.othersDimmed, true, 'Unrelated wires step back');
      assert.match(hot.aria, new RegExp(`\\(${hot.incident} connections? shown\\)$`), 'Accessible name says how many wires are shown');
      await page.mouse.move(2, 2);
      await page.waitForTimeout(220);
      assert.equal(await page.evaluate(() => document.getElementById('featured-plate-svg')!.classList.contains('has-hot')), false);
      // A plain wheel over the plate scrolls the page (and shows the zoom hint); Ctrl + wheel zooms
      const plateBox = (await page.locator('#featured-plate-svg').boundingBox())!;
      const vbBefore = await page.locator('#featured-plate-svg').getAttribute('viewBox');
      await page.mouse.move(plateBox.x + plateBox.width / 2, plateBox.y + 60);
      await page.mouse.wheel(0, 200);
      await page.waitForTimeout(80);
      assert.equal(await page.locator('#featured-plate-svg').getAttribute('viewBox'), vbBefore, 'Plain wheel must not zoom the plate');
      assert.equal(await page.locator('.f12-plate-zoom-hint.is-visible').count(), 1, 'Plain wheel shows how to zoom');
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -200);
      await page.keyboard.up('Control');
      assert.notEqual(await page.locator('#featured-plate-svg').getAttribute('viewBox'), vbBefore, 'Ctrl + wheel zooms the plate');
      assert.equal(await page.locator('#reset-plate-btn').isVisible(), true, 'Zooming offers Reset plate');
      await page.locator('#reset-plate-btn').click();
      assert.equal(await page.locator('#featured-plate-svg').getAttribute('viewBox'), vbBefore, 'Reset restores the view');

      // Pointing at a file's label traces it too
      await page.locator(`#featured-plate-svg .f12-plate-node-label[data-node-idx="${hov.idx}"] text`).hover({ force: true });
      assert.equal(await page.evaluate(() => document.getElementById('featured-plate-svg')!.classList.contains('has-hot')), true);
      await page.mouse.move(2, 2);
      // Keyboard focus highlights the same way (Tab into the plate) and clears on blur
      await page.locator('#briefing-headline').focus();
      await page.evaluate((idx: string) => {
        const nodes = Array.from(document.querySelectorAll('#featured-plate-svg .f12-plate-node'));
        const target = nodes.find((n) => n.getAttribute('data-node-idx') === idx)!;
        const before = nodes[nodes.indexOf(target) - 1] as HTMLElement | undefined;
        (before ?? (document.getElementById('briefing-headline') as HTMLElement)).focus();
      }, hov.idx);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-node-idx')), hov.idx);
      assert.equal(await page.evaluate(() => document.getElementById('featured-plate-svg')!.classList.contains('has-hot')), true);
      await page.locator('#briefing-headline').focus();
      assert.equal(await page.evaluate(() => document.getElementById('featured-plate-svg')!.classList.contains('has-hot')), false);

      // 5) Every pair plate (client-built) is free of orphans, clipped labels and overlapping labels
      const hashes: string[] = await page.evaluate(() => {
        const data = JSON.parse(document.getElementById('ra-data')!.textContent!);
        return data.edges.map(
          (e: { source: number; target: number }) =>
            '#f=' + encodeURIComponent(data.nodes[e.source].path) + '..' + encodeURIComponent(data.nodes[e.target].path),
        );
      });
      assert.ok(hashes.length >= 20, `Expected a dense fixture, got ${hashes.length} relationships`);
      const openHash = (hh: string) =>
        page.evaluate((h: string) => {
          location.hash = h;
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        }, hh);
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const h of hashes) {
          await openHash(h);
          const m = (await page.evaluate(MEASURE_PLATE)) as PlateMeasure;
          assert.deepEqual(plateProblems(m, { strict: true }), [], `Plate for ${decodeURIComponent(h)} at ${width}px`);
          const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert.ok(overflowX <= 0, `No horizontal page scroll at ${width}px (overflow ${overflowX}px)`);
        }
      }

      // Labels render at a readable size at every width: the plate is laid out for the width it is shown at
      for (const width of [1440, 1280, 1024, 900, 800, 700, 641, 640, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        await openHash(hashes[2]!);
        await page.waitForTimeout(30);
        const sizes = await page.evaluate(() => {
          const svg = document.getElementById('featured-plate-svg') as unknown as SVGSVGElement;
          const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
          return Array.from(svg.querySelectorAll('.f12-plate-node-label text')).map((t) => Number(t.getAttribute('font-size')) * scale);
        });
        assert.ok(sizes.length > 0);
        for (const px of sizes) assert.ok(px >= 11.5 && px <= 17, `Label renders at ${px.toFixed(1)}px at ${width}px wide`);
      }

      // 6) Phones: the pair plus the closest files, the callout under the plate, the rest as a list
      await page.setViewportSize({ width: 390, height: 1000 });
      await openHash(hashes[0]!);
      const compact = (await page.evaluate(MEASURE_PLATE)) as PlateMeasure;
      assert.ok(compact.nodes.length <= 4, `Compact plate draws at most 4 files, got ${compact.nodes.length}`);
      assert.equal(compact.balloon, null, 'No speech balloon inside the compact plate');
      assert.match((await page.locator('#plate-caption').textContent()) ?? '', /commits together/);
      const moreButtons = page.locator('.f12-plate-more-btn');
      assert.ok((await moreButtons.count()) > 0, 'Remaining files are listed under the plate');
      const listed = (await moreButtons.first().locator('span').first().textContent()) ?? '';
      const beforeList = (await headline()) ?? '';
      await moreButtons.first().click();
      const afterList = (await headline()) ?? '';
      assert.notEqual(afterList, beforeList, 'Choosing a listed file selects one of its relationships');
      assert.ok(afterList.includes(listed.split('/').pop()!), `Expected ${listed} in ${afterList}`);

      // 7) Print with reduced motion still renders a static, readable plate
      await page.emulateMedia({ media: 'print', reducedMotion: 'reduce' });
      await openHash(hashes[1]!);
      const printBox = await page.locator('#featured-plate-svg').boundingBox();
      assert.ok(printBox && printBox.width > 100 && printBox.height > 60, 'Plate is visible when printing');
      await page.emulateMedia({ media: 'screen', reducedMotion: 'no-preference' });

      assert.deepEqual(errors, [], 'Expected no page errors while interacting with the plate');

      // 8) Touch: tapping a file selects it, exactly like a click
      const touchContext = await browser.newContext({ viewport: { width: 390, height: 900 }, hasTouch: true, isMobile: true });
      const touchPage = await touchContext.newPage();
      const touchErrors: string[] = [];
      touchPage.on('pageerror', (err: Error) => touchErrors.push(String(err)));
      await touchPage.goto(url);
      await touchPage.waitForSelector('#featured-plate-svg .f12-plate-node');
      const touchBefore = (await touchPage.locator('#briefing-headline').textContent()) ?? '';
      const target = touchPage.locator('#featured-plate-svg .f12-plate-node[data-group]:not([data-group="focus"]) .f12-plate-node-dot').first();
      await target.tap({ force: true });
      await touchPage.waitForTimeout(50);
      assert.notEqual((await touchPage.locator('#briefing-headline').textContent()) ?? '', touchBefore, 'Tapping a file selects it');
      assert.deepEqual(touchErrors, []);
      await touchContext.close();

      // 9) Width changes re-lay the plate once, never in a loop (scrollbars change width as height changes)
      const loopPage = await browser.newPage({ viewport: { width: 1440, height: 700 } });
      await loopPage.goto(url);
      await loopPage.waitForSelector('#featured-plate-svg .f12-plate-node');
      const countPlateRenders = async (width: number) => {
        await loopPage.evaluate(() => {
          const w = window as unknown as { __plateRenders: number; __plateObserver?: MutationObserver };
          w.__plateRenders = 0;
          w.__plateObserver?.disconnect();
          w.__plateObserver = new MutationObserver((records) => {
            for (const r of records) {
              for (const n of Array.from(r.addedNodes)) {
                if (n instanceof Element && (n.id === 'featured-plate-svg' || n.querySelector?.('#featured-plate-svg'))) w.__plateRenders++;
              }
            }
          });
          w.__plateObserver.observe(document.getElementById('briefing-view')!, { childList: true, subtree: true });
        });
        await loopPage.setViewportSize({ width, height: 700 });
        await loopPage.waitForTimeout(700);
        return loopPage.evaluate(() => (window as unknown as { __plateRenders: number }).__plateRenders);
      };
      for (const width of [1100, 1024, 980, 760, 700, 600, 1440]) {
        const renders = await countPlateRenders(width);
        assert.ok(renders <= 2, `Resizing to ${width}px rendered the plate ${renders} times`);
      }
      await loopPage.close();

      // 10) The empty-state context plate is laid out for narrow screens too
      const emptyData = generateSyntheticMapData(12, { repoName: 'plate-empty-state' });
      emptyData.edges = emptyData.edges.map((e) => ({ ...e, relationship: 'direct' as const, overviewPriority: 0 }));
      emptyData.families = [];
      emptyData.counts = { ghost: 0, unknown: 0, indirect: 0, direct: emptyData.edges.length, test: 0 };
      const emptyHtml = renderMapHtml(emptyData, computeRichLayout(emptyData), { style: 'rich' });
      const emptyPage = await browser.newPage({ viewport: { width: 390, height: 900 } });
      const emptyErrors: string[] = [];
      emptyPage.on('pageerror', (err: Error) => emptyErrors.push(String(err)));
      await emptyPage.setContent(emptyHtml, { waitUntil: 'domcontentloaded' });
      await emptyPage.waitForSelector('#featured-plate-svg .f12-plate-node');
      await emptyPage.waitForTimeout(100);
      const emptySizes = await emptyPage.evaluate(() => {
        const svg = document.getElementById('featured-plate-svg') as unknown as SVGSVGElement;
        const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
        return Array.from(svg.querySelectorAll('.f12-plate-node-label text')).map((t) => Number(t.getAttribute('font-size')) * scale);
      });
      assert.ok(emptySizes.length > 0, 'Empty-state context plate draws files');
      assert.match((await emptyPage.locator('.f12-plate-meta').first().textContent()) ?? '', /^Context view:/);
      for (const px of emptySizes) assert.ok(px >= 11.5 && px <= 17, `Empty-state label renders at ${px.toFixed(1)}px`);
      assert.deepEqual(emptyErrors, []);
      await emptyPage.close();
    } finally {
      await browser.close();
    }
  });
});
