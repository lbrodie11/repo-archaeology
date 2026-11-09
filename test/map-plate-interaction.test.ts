import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
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
  const wires = Array.from(svg.querySelectorAll('.f12-plate-edge-hit')).map((l) => ({
    x1: num(l, 'x1'), y1: num(l, 'y1'), x2: num(l, 'x2'), y2: num(l, 'y2'),
  }));
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
    const deg = m.wires.filter((w) => (w.x1 === n.x && w.y1 === n.y) || (w.x2 === n.x && w.y2 === n.y)).length;
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

      // 1) Clicking every file on the family plate pivots C-01 to one of that file's pairs
      for (const n of initial.nodes) {
        const dot = page.locator(`#featured-plate-svg .f12-plate-node[data-node-idx="${n.idx}"] .f12-plate-node-dot`);
        await dot.click({ force: true });
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
        const hits = Array.from(svg.querySelectorAll('.f12-plate-edge-hit'));
        for (const l of hits) {
          const x1 = Number(l.getAttribute('x1')), y1 = Number(l.getAttribute('y1'));
          const x2 = Number(l.getAttribute('x2')), y2 = Number(l.getAttribute('y2'));
          for (const t of [0.35, 0.5, 0.65]) {
            const p = svg.createSVGPoint();
            p.x = x1 + (x2 - x1) * t;
            p.y = y1 + (y2 - y1) * t;
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

      // 5) Every pair plate (client-built) is free of orphans, clipped labels and overlapping labels
      const hashes: string[] = await page.evaluate(() => {
        const data = JSON.parse(document.getElementById('ra-data')!.textContent!);
        return data.edges.map(
          (e: { source: number; target: number }) =>
            '#f=' + encodeURIComponent(data.nodes[e.source].path) + '..' + encodeURIComponent(data.nodes[e.target].path),
        );
      });
      assert.ok(hashes.length >= 20, `Expected a dense fixture, got ${hashes.length} relationships`);
      for (const [width, strict] of [[1440, true], [390, false]] as const) {
        await page.setViewportSize({ width, height: 1000 });
        for (const h of hashes) {
          await page.evaluate((hh: string) => {
            location.hash = hh;
            window.dispatchEvent(new HashChangeEvent('hashchange'));
          }, h);
          const m = (await page.evaluate(MEASURE_PLATE)) as PlateMeasure;
          assert.deepEqual(plateProblems(m, { strict }), [], `Plate for ${decodeURIComponent(h)} at ${width}px`);
        }
      }

      assert.deepEqual(errors, [], 'Expected no page errors while interacting with the plate');
    } finally {
      await browser.close();
    }
  });
});
