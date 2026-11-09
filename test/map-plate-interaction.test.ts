import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { computeRichLayout } from '../src/map/layout.js';
import { renderMapHtml } from '../src/map/template.js';
import { generateSyntheticMapData } from './fixtures/map-synthetic.js';
import { FixtureRepo } from './helpers.js';

const require = createRequire(import.meta.url);

type PlaywrightModule = {
  chromium: { executablePath(): string; launch(options?: { headless?: boolean }): Promise<any> };
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
const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');

const repos: FixtureRepo[] = [];
const tmpDirs: string[] = [];
after(() => {
  repos.forEach((r) => r.cleanup());
  tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const PICKERS = [
  'accent', 'menu', 'font', 'radius', 'style', 'theme', 'base', 'base-color', 'icon-library', 'chart-color',
].map((v) => `src/components/${v}-picker.tsx`);
const EXTRAS = ['src/components/picker.tsx', 'src/hooks/use-random.tsx'];
/** Sole human author, so every file crosses the single-contributor threshold. */
const AUTHOR = 'Riley Quartermaine';

/**
 * Builds a dense same-suffix family (like shadcn-ui's *-picker.tsx) whose 12-file Briefing plate
 * needs chord pruning, then renders it through the real `map --style rich` CLI.
 */
function buildDensePickerMap(): string {
  const repo = new FixtureRepo();
  repos.push(repo);
  // Deterministic LCG so every run produces the same co-change history
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let c = 0; c < 26; c++) {
    const files = PICKERS.filter(() => rand() < 0.6);
    if (c % 3 === 0) files.push(EXTRAS[0]!);
    if (c % 4 === 0) files.push(EXTRAS[1]!);
    if (files.length < 2) files.push(PICKERS[0]!, PICKERS[1]!);
    repo.touch([...new Set(files)], `feat(create): update customizer ${c}`, { author: AUTHOR });
  }
  const outDir = mkdtempSync(join(tmpdir(), 'ra-plate-'));
  tmpDirs.push(outDir);
  const out = join(outDir, 'map.html');
  const res = spawnSync(
    process.execPath,
    ['--import', TSX, CLI, 'map', '--style', 'rich', '--no-open', '--no-cache', '-o', out],
    { cwd: repo.dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
  );
  assert.equal(res.status, 0, res.stderr);
  return out;
}

/** Reads plate geometry in viewBox units: label boxes, node dots, wires and the balloon. */
const MEASURE_PLATE = () => {
  const svg = document.getElementById('featured-plate-svg') as unknown as SVGSVGElement;
  const vb = svg.viewBox.baseVal;
  const groups = Array.from(svg.querySelectorAll('.f12-plate-node')).filter(
    (g) => (g as SVGGElement).style.display !== 'none',
  );
  const num = (el: Element, a: string) => Number(el.getAttribute(a));
  const nodes = groups.map((g) => {
    const idx = g.getAttribute('data-node-idx')!;
    const dot = g.querySelector('.f12-plate-node-dot')!;
    const lg = svg.querySelector(`.f12-plate-node-label[data-node-idx="${idx}"]`);
    const pill = lg?.querySelector('rect');
    return {
      idx,
      text: lg?.querySelector('text')?.textContent ?? '',
      x: num(dot, 'cx'),
      y: num(dot, 'cy'),
      r: num(dot, 'r'),
      label: pill ? { x: num(pill, 'x'), y: num(pill, 'y'), w: num(pill, 'width'), h: num(pill, 'height') } : null,
    };
  });
  // Sample each rendered wire (straight or curved) along its actual SVG path
  const wires = Array.from(svg.querySelectorAll('.f12-plate-wire'))
    .filter((w) => (w as SVGPathElement).style.display !== 'none')
    .map((w) => {
      const path = w as SVGPathElement;
      const len = path.getTotalLength();
      const points: [number, number][] = [];
      for (let k = 0; k <= 60; k++) {
        const pt = path.getPointAtLength((len * k) / 60);
        points.push([pt.x, pt.y]);
      }
      return { source: w.getAttribute('data-source')!, target: w.getAttribute('data-target')!, points };
    });
  const balloonRect = svg.querySelectorAll('.f12-plate-balloon rect')[1];
  const tail = svg.querySelector('.f12-plate-balloon polygon');
  let balloon = null as null | { x: number; y: number; w: number; h: number; tipX: number; tipY: number };
  if (balloonRect && tail) {
    const pts = tail.getAttribute('points')!.trim().split(/\s+/).map((p) => p.split(',').map(Number));
    balloon = {
      x: num(balloonRect, 'x'), y: num(balloonRect, 'y'), w: num(balloonRect, 'width'), h: num(balloonRect, 'height'),
      tipX: pts[2]![0]!, tipY: pts[2]![1]!,
    };
  }
  return { width: vb.width, height: vb.height, nodes, wires, balloon };
};

type PlateMeasure = ReturnType<typeof MEASURE_PLATE>;

function plateProblems(m: PlateMeasure, opts: { strict: boolean }): string[] {
  const problems: string[] = [];
  const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  m.nodes.forEach((n, i) => {
    const deg = m.wires.filter((w) => w.source === n.idx || w.target === n.idx).length;
    if (deg === 0) problems.push(`${n.text}: no visible wire (orphan)`);
    const L = n.label;
    if (!L) {
      problems.push(`${n.idx}: no label`);
      return;
    }
    if (L.x < 0 || L.y < 0 || L.x + L.w > m.width || L.y + L.h > m.height) problems.push(`${n.text}: label outside plate`);
    m.nodes.forEach((o, j) => {
      if (j > i && o.label && overlap(L, o.label)) problems.push(`${n.text} label overlaps ${o.text} label`);
    });
    if (!opts.strict) return;
    m.nodes.forEach((o, j) => {
      if (j === i) return;
      const nx = Math.max(L.x, Math.min(o.x, L.x + L.w));
      const ny = Math.max(L.y, Math.min(o.y, L.y + L.h));
      if (Math.hypot(o.x - nx, o.y - ny) < o.r) problems.push(`${n.text} label covers ${o.text} dot`);
    });
    const b = m.balloon;
    if (b && overlap(L, b)) problems.push(`${n.text} label under balloon`);
    if (b && b.tipX > L.x && b.tipX < L.x + L.w && L.y < b.tipY && L.y + L.h > b.y + b.h) {
      problems.push(`${n.text} label crossed by balloon pointer`);
    }
  });
  for (const w of m.wires) {
    if (w.points.some(([x, y]) => x < -0.5 || y < -0.5 || x > m.width + 0.5 || y > m.height + 0.5)) {
      problems.push(`wire ${w.source}-${w.target} leaves the plate`);
    }
    if (!opts.strict) continue;
    for (const n of m.nodes) {
      if (n.idx === w.source || n.idx === w.target) continue;
      if (w.points.some(([x, y]) => Math.hypot(x - n.x, y - n.y) < n.r + 2)) {
        problems.push(`wire ${w.source}-${w.target} runs through ${n.text}`);
      }
    }
    const b = m.balloon;
    if (b && w.points.some(([x, y]) => x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h)) {
      problems.push(`wire ${w.source}-${w.target} runs under the balloon`);
    }
  }
  if (opts.strict && m.balloon) {
    for (const n of m.nodes) {
      const b = m.balloon;
      if (n.x + n.r > b.x && n.x - n.r < b.x + b.w && n.y + n.r > b.y && n.y - n.r < b.y + b.h) {
        problems.push(`${n.text} dot hidden under balloon`);
      }
    }
  }
  return problems;
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
