import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  buildDensePickerMap,
  loadPlaywright,
  MEASURE_PLATE,
  plateProblems,
  type PlateMeasure,
} from './fixtures/plate-fixture.js';

const pw = loadPlaywright();
const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

/** Everything a reader could notice is wrong with the Briefing after an interaction. */
const SNAPSHOT = () => {
  const svg = document.getElementById('featured-plate-svg') as unknown as SVGSVGElement | null;
  const plates = document.querySelectorAll('#featured-plate-svg').length;
  const reset = document.getElementById('reset-plate-btn') as HTMLButtonElement | null;
  const numericAttrs = ['cx', 'cy', 'r', 'x', 'y', 'width', 'height', 'd', 'viewBox', 'points'];
  const badAttrs: string[] = [];
  if (svg) {
    for (const el of Array.from(svg.querySelectorAll('*')).concat([svg])) {
      for (const a of numericAttrs) {
        const v = el.getAttribute(a);
        if (v !== null && /NaN|undefined|Infinity/.test(v)) badAttrs.push(`${el.tagName}.${a}=${v}`);
      }
    }
  }
  const focusPaths = svg
    ? Array.from(svg.querySelectorAll('.f12-plate-node[data-group="focus"]')).map((g) => {
        const m = /^Inspect (.+) \(\d+ connections? shown\)$/.exec(g.getAttribute('aria-label') ?? '');
        return m ? m[1]! : '';
      })
    : [];
  const ids = Array.from(document.querySelectorAll('[id]')).map((e) => e.id);
  const duplicateIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  const meta = document.querySelector('.f12-plate-meta')?.textContent ?? '';
  const drawn = svg ? svg.querySelectorAll('.f12-plate-node').length : 0;
  const m = /(?:Ego network \(|Showing )(\d+) of/.exec(meta);
  return {
    view: document.querySelector('.app')?.getAttribute('data-view') ?? '',
    headline: document.getElementById('briefing-headline')?.textContent ?? '',
    plates,
    dirty: reset ? !reset.hidden : false,
    badAttrs,
    focusPaths,
    duplicateIds: Array.from(new Set(duplicateIds)),
    drawn,
    footerDrawn: m ? Number(m[1]) : -1,
    hints: svg?.parentElement?.querySelectorAll('.f12-plate-zoom-hint').length ?? 0,
    domSize: document.getElementById('briefing-view')?.getElementsByTagName('*').length ?? 0,
    viewBox: svg?.getAttribute('viewBox') ?? '',
    scrollY: window.scrollY,
  };
};
type Snapshot = ReturnType<typeof SNAPSHOT>;

describe('Briefing plate stress test: seeded random interactions', { skip: !pw ? 'Playwright is not installed' : false }, () => {
  it('survives 300 mixed interactions with every invariant intact after each one', async () => {
    // RA_STRESS_HTML points the same walk at any generated rich map (for example a real repository)
    const built = process.env.RA_STRESS_HTML ? { htmlPath: process.env.RA_STRESS_HTML, cleanup: () => {} } : buildDensePickerMap();
    cleanups.push(built.cleanup);
    const browser = await pw!.chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', (err: Error) => errors.push(String(err)));
      page.on('console', (msg: { type(): string; text(): string }) => {
        if (msg.type() === 'error') errors.push(msg.text());
      });
      await page.addInitScript(() => {
        (window as unknown as { __name: (fn: unknown) => unknown }).__name = (fn) => fn;
      });
      await page.goto(pathToFileURL(built.htmlPath).href);
      await page.waitForSelector('#featured-plate-svg .f12-plate-node');

      // RA_STRESS_SEED / RA_STRESS_STEPS explore other walks locally; CI uses the fixed defaults
      let seed = Number(process.env.RA_STRESS_SEED) || 424242;
      const steps = Number(process.env.RA_STRESS_STEPS) || 300;
      const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
      const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
      const log: string[] = [];
      const visible = async (sel: string) => (await page.locator(sel).count()) > 0 && (await page.locator(sel).first().isVisible());

      const hashes: string[] = await page.evaluate(() => {
        const data = JSON.parse(document.getElementById('ra-data')!.textContent!);
        return data.edges.map(
          (e: { source: number; target: number }) =>
            '#f=' + encodeURIComponent(data.nodes[e.source].path) + '..' + encodeURIComponent(data.nodes[e.target].path),
        );
      });

      const actions: Record<string, () => Promise<string | null>> = {
        async clickNode() {
          const n = await page.locator('#featured-plate-svg .f12-plate-node').count();
          if (n === 0) return null;
          const i = Math.floor(rand() * n);
          await page.locator('#featured-plate-svg .f12-plate-node .f12-plate-node-dot').nth(i).click({ force: true });
          return `click node #${i}`;
        },
        async clickLabel() {
          const n = await page.locator('#featured-plate-svg .f12-plate-node-label text').count();
          if (n === 0) return null;
          const i = Math.floor(rand() * n);
          await page.locator('#featured-plate-svg .f12-plate-node-label text').nth(i).click({ force: true });
          return `click label #${i}`;
        },
        async clickWire() {
          const pt = await page.evaluate((r: number) => {
            const svg = document.getElementById('featured-plate-svg') as unknown as SVGSVGElement | null;
            if (!svg) return null;
            const hits = Array.from(svg.querySelectorAll('.f12-plate-edge-hit')) as SVGPathElement[];
            if (hits.length === 0) return null;
            const l = hits[Math.floor(r * hits.length)]!;
            const len = l.getTotalLength();
            for (const t of [0.5, 0.35, 0.65]) {
              const a = l.getPointAtLength(len * t);
              const q = svg.createSVGPoint();
              q.x = a.x;
              q.y = a.y;
              const s = q.matrixTransform(svg.getScreenCTM()!);
              if (s.y > 0 && s.y < window.innerHeight && document.elementFromPoint(s.x, s.y) === l) return { x: s.x, y: s.y };
            }
            return null;
          }, rand());
          if (!pt) return null;
          await page.mouse.click(pt.x, pt.y);
          return 'click wire';
        },
        async back() {
          if (!(await visible('#back-to-family-btn'))) return null;
          await page.locator('#back-to-family-btn').click();
          return 'back to family';
        },
        async keyboard() {
          const n = await page.locator('#featured-plate-svg .f12-plate-node').count();
          if (n === 0) return null;
          const i = Math.floor(rand() * n);
          await page.locator('#featured-plate-svg .f12-plate-node').nth(i).focus();
          await page.keyboard.press(rand() < 0.5 ? 'Enter' : ' ');
          return `keyboard select #${i}`;
        },
        async drag() {
          const n = await page.locator('#featured-plate-svg .f12-plate-node').count();
          if (n === 0) return null;
          const box = await page.locator('#featured-plate-svg .f12-plate-node .f12-plate-node-dot').nth(Math.floor(rand() * n)).boundingBox();
          if (!box) return null;
          const x = box.x + box.width / 2, y = box.y + box.height / 2;
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(x + (rand() - 0.5) * 160, y + (rand() - 0.5) * 120, { steps: 4 });
          await page.mouse.up();
          return 'drag node';
        },
        async zoom() {
          if ((await page.locator('#featured-plate-svg').count()) === 0) return null;
          const box = await page.locator('#featured-plate-svg').boundingBox();
          if (!box) return null;
          await page.mouse.move(box.x + box.width * rand(), box.y + Math.min(box.height, 300) * rand());
          await page.keyboard.down('Control');
          await page.mouse.wheel(0, (rand() - 0.5) * 400);
          await page.keyboard.up('Control');
          return 'ctrl+wheel zoom';
        },
        async plainWheel() {
          if ((await page.locator('#featured-plate-svg').count()) === 0) return null;
          const box = await page.locator('#featured-plate-svg').boundingBox();
          if (!box) return null;
          const before = (await page.evaluate(SNAPSHOT)) as Snapshot;
          await page.mouse.move(box.x + box.width / 2, Math.max(box.y + 20, Math.min(box.y + box.height - 20, 400)));
          await page.mouse.wheel(0, 240);
          await page.waitForTimeout(60);
          const after = (await page.evaluate(SNAPSHOT)) as Snapshot;
          assert.equal(after.viewBox, before.viewBox, `A plain wheel over the plate must not zoom it (${log.slice(-3).join(' > ')})`);
          return 'plain wheel over plate';
        },
        async reset() {
          if (!(await visible('#reset-plate-btn'))) return null;
          await page.locator('#reset-plate-btn').click();
          return 'reset plate';
        },
        async focusPair() {
          if (!(await visible('#focus-pair-btn'))) return null;
          await page.locator('#focus-pair-btn').click();
          return 'focus pair toggle';
        },
        async filter() {
          const n = await page.locator('#toggles .toggle').count();
          if (n === 0) return null;
          await page.locator('#toggles .toggle').nth(Math.floor(rand() * n)).click();
          return 'toggle relationship filter';
        },
        async rankRow() {
          const n = await page.locator('.f12-rank-row').count();
          if (n === 0) return null;
          const row = page.locator('.f12-rank-row').nth(Math.floor(rand() * Math.min(n, 6)));
          if (!(await row.isVisible())) return null;
          await row.click();
          return 'ranked finding row';
        },
        async deepLink() {
          const h = pick(hashes);
          await page.evaluate((hh: string) => {
            location.hash = hh;
            window.dispatchEvent(new HashChangeEvent('hashchange'));
          }, h);
          return `deep link ${decodeURIComponent(h).slice(-40)}`;
        },
        async resize() {
          const w = pick([1440, 1280, 1024, 820, 700, 600, 430, 390, 360]);
          await page.setViewportSize({ width: w, height: 900 });
          await page.waitForTimeout(160);
          return `resize ${w}`;
        },
        async view() {
          const atlas = (await page.locator('#view-atlas').count()) > 0;
          if (!atlas) return null;
          await page.locator('#view-atlas').click();
          await page.waitForTimeout(30);
          await page.locator('#view-briefing').click();
          return 'atlas and back';
        },
      };
      const weights: [keyof typeof actions, number][] = [
        ['clickNode', 6], ['clickLabel', 3], ['clickWire', 4], ['back', 4], ['keyboard', 3], ['drag', 3], ['zoom', 2],
        ['plainWheel', 2], ['reset', 2], ['focusPair', 2], ['filter', 2], ['rankRow', 3], ['deepLink', 3], ['resize', 2], ['view', 1],
      ];
      const total = weights.reduce((s, [, w]) => s + w, 0);
      const choose = (): keyof typeof actions => {
        let r = rand() * total;
        for (const [name, w] of weights) if ((r -= w) < 0) return name;
        return 'clickNode';
      };

      let executed = 0;
      let maxDom = 0;
      for (let step = 0; step < steps; step++) {
        const name = choose();
        const did = await actions[name]!();
        if (!did) continue;
        executed++;
        log.push(did);
        await page.waitForTimeout(25);
        const where = `step ${step} (${log.slice(-4).join(' > ')})`;
        assert.deepEqual(errors, [], `Page errors after ${where}`);
        const snap = (await page.evaluate(SNAPSHOT)) as Snapshot;
        if (snap.view === 'atlas') continue;
        assert.ok(snap.headline.length > 0, `Headline missing after ${where}`);
        assert.ok(snap.plates <= 1, `More than one plate after ${where}`);
        assert.deepEqual(snap.badAttrs, [], `Non-finite SVG geometry after ${where}`);
        assert.deepEqual(snap.duplicateIds, [], `Duplicate element ids after ${where}`);
        assert.ok(snap.hints <= 1, `Zoom hints pile up after ${where}`);
        maxDom = Math.max(maxDom, snap.domSize);
        if (snap.plates === 0) continue;
        assert.ok(snap.drawn <= 12, `Too many files drawn after ${where}`);
        if (snap.footerDrawn >= 0) assert.equal(snap.footerDrawn, snap.drawn, `Footer count disagrees with the plate after ${where}`);
        // The plate shows the pair the headline names
        const pairMatch = /^(.+) and (.+) keep changing together$/.exec(snap.headline);
        if (pairMatch && snap.focusPaths.length === 2) {
          const names = snap.focusPaths.map((p) => p.split('/').pop()!);
          assert.ok(
            names.every((n) => snap.headline.includes(n)),
            `Plate pair ${names.join(' + ')} does not match "${snap.headline}" after ${where}`,
          );
        }
        // Untouched plates (no drag/pan/zoom) must keep every layout guarantee
        if (!snap.dirty) {
          const m = (await page.evaluate(MEASURE_PLATE)) as PlateMeasure;
          assert.deepEqual(plateProblems(m, { strict: true }), [], `Plate geometry after ${where}`);
        }
      }
      assert.ok(executed >= steps * 0.6, `Expected a long run, executed ${executed} actions`);
      assert.ok(maxDom < 6000, `Briefing DOM grew to ${maxDom} elements`);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
});
