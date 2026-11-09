// Shared fixtures for the Briefing plate browser tests: Playwright loading, a dense *-picker family
// rendered through the real CLI, and geometry checks on the rendered plate.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureRepo } from '../helpers.js';

const require = createRequire(import.meta.url);

type PlaywrightModule = {
  chromium: { executablePath(): string; launch(options?: { headless?: boolean }): Promise<any> };
};

export function loadPlaywright(): PlaywrightModule | null {
  try {
    const mod = require('playwright') as PlaywrightModule;
    const execPath = mod.chromium?.executablePath?.();
    if (!execPath || !existsSync(execPath)) return null;
    return mod;
  } catch {
    return null;
  }
}

const CLI = join(import.meta.dirname, '..', '..', 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');

const PICKERS = [
  'accent', 'menu', 'font', 'radius', 'style', 'theme', 'base', 'base-color', 'icon-library', 'chart-color',
].map((v) => `src/components/${v}-picker.tsx`);
const EXTRAS = ['src/components/picker.tsx', 'src/hooks/use-random.tsx'];
/** Sole human author, so every file crosses the single-contributor threshold. */
export const AUTHOR = 'Riley Quartermaine';

/**
 * Builds a dense same-suffix family (like shadcn-ui's *-picker.tsx) whose 12-file Briefing plate
 * needs chord pruning, then renders it through the real `map --style rich` CLI.
 */
export function buildDensePickerMap(): { htmlPath: string; cleanup(): void } {
  const repo = new FixtureRepo();
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
  const out = join(outDir, 'map.html');
  const cleanup = () => {
    repo.cleanup();
    rmSync(outDir, { recursive: true, force: true });
  };
  const res = spawnSync(
    process.execPath,
    ['--import', TSX, CLI, 'map', '--style', 'rich', '--no-open', '--no-cache', '-o', out],
    { cwd: repo.dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
  );
  if (res.status !== 0) {
    cleanup();
    throw new Error(`map --style rich failed: ${res.stderr}`);
  }
  return { htmlPath: out, cleanup };
}

/** Reads plate geometry in viewBox units: label boxes, node dots, wires and the balloon. */
export const MEASURE_PLATE = () => {
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

export type PlateMeasure = ReturnType<typeof MEASURE_PLATE>;

export function plateProblems(m: PlateMeasure, opts: { strict: boolean }): string[] {
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
