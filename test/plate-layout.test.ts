import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  COMPACT_CONTEXT_NODES,
  computePlateLayout,
  disambiguateLabels,
  MAX_EGO_NODES,
  measureLabelWidth,
  truncateLabel,
  type FeaturedPlateLayout,
  type PlateGraph,
} from '../src/map/plate-layout.js';

type Rel = PlateGraph['edges'][number]['relationship'];
type EdgeSpec = [source: number, target: number, shared?: number, rel?: Rel];

/** Builds a graph of `count` files under `src/` and the given relationships (index = edge id). */
function graph(paths: number | string[], specs: EdgeSpec[]): PlateGraph {
  const list = typeof paths === 'number' ? Array.from({ length: paths }, (_, i) => `src/f${i}.ts`) : paths;
  return {
    nodes: list.map((path, i) => ({ path, dir: path.split('/').slice(0, -1).join('/') || '.', changes: 10 + i })),
    edges: specs.map(([source, target, shared = 5, relationship = 'ghost']) => ({
      source,
      target,
      relationship,
      interval: { low: shared / 20 },
      reverseInterval: { low: shared / 22 },
      score: shared / 10,
      overviewPriority: relationship === 'ghost' ? 1 : 0,
      shared,
    })),
  };
}

const pair = (g: PlateGraph, lead = 0) => ({
  seeds: [g.edges[lead]!.source, g.edges[lead]!.target],
  leadEdge: lead,
  featuredEdges: [lead],
});

/** Geometry problems a reader would see; every plate must be free of these. */
function problems(p: FeaturedPlateLayout): string[] {
  const out: string[] = [];
  const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const values = [p.width, p.height];
  for (const n of p.nodes) values.push(n.x, n.y, n.r, n.label.x, n.label.y, n.label.w, n.label.h, n.label.anchorX, n.label.anchorY);
  for (const e of p.edges) values.push(e.x1, e.y1, e.x2, e.y2, e.strokeWidth);
  if (!values.every(Number.isFinite)) out.push('non-finite coordinate');
  p.nodes.forEach((n, i) => {
    const L = n.label;
    if (L.x < 0 || L.y < 0 || L.x + L.w > p.width || L.y + L.h > p.height) out.push(`${n.shortLabel}: label outside plate`);
    if (n.x - n.r < 0 || n.x + n.r > p.width || n.y - n.r < 0 || n.y + n.r > p.height) out.push(`${n.shortLabel}: dot outside plate`);
    if (!p.edges.some((e) => e.sourceNodeIndex === n.nodeIndex || e.targetNodeIndex === n.nodeIndex)) {
      out.push(`${n.shortLabel}: no wire`);
    }
    if (p.balloonBox && overlap(L, p.balloonBox)) out.push(`${n.shortLabel}: label under balloon`);
    p.nodes.forEach((o, j) => {
      if (j > i && overlap(L, o.label)) out.push(`${n.shortLabel} label overlaps ${o.shortLabel} label`);
      if (j === i) return;
      const nx = Math.max(L.x, Math.min(o.x, L.x + L.w));
      const ny = Math.max(L.y, Math.min(o.y, L.y + L.h));
      if (Math.hypot(o.x - nx, o.y - ny) < o.r) out.push(`${n.shortLabel} label covers ${o.shortLabel} dot`);
    });
  });
  return out;
}

const byId = (p: FeaturedPlateLayout, id: number) => p.nodes.find((n) => n.nodeIndex === id)!;

describe('pair-centered plate layout engine (src/map/plate-layout.ts)', () => {
  it('draws a lone pair centred, side by side, under the balloon, with no tiers', () => {
    const g = graph(2, [[0, 1, 9]]);
    const p = computePlateLayout(g, pair(g));
    assert.deepEqual(problems(p), []);
    assert.equal(p.nodes.length, 2);
    const [a, b] = [byId(p, 0), byId(p, 1)];
    assert.equal(a.group, 'focus');
    assert.equal(a.y, b.y);
    assert.ok(a.x < b.x, 'A sits left of B');
    assert.ok(Math.abs(a.x + b.x - p.width) < 2, 'pair is centred');
    assert.equal(a.label.position, 'N', 'focus labels sit above their dots');
    assert.equal(p.height, 220, 'a lone pair uses the minimum height');
    assert.ok(p.balloonBox && p.balloonTarget);
    assert.ok(p.balloonBox.y + p.balloonBox.h < a.label.y, 'balloon sits above the focus labels');
    assert.equal(p.balloonTarget.x, (a.x + b.x) / 2);
  });

  it('groups three and four file plates by their relationship to the pair without wasted space', () => {
    // 2 is linked to both, 3 only to A (0), 4 only to B (1)
    const g = graph(5, [[0, 1, 9], [2, 0], [2, 1], [3, 0], [4, 1]]);
    const p = computePlateLayout(g, pair(g));
    assert.deepEqual(problems(p), []);
    assert.equal(byId(p, 2).group, 'shared');
    assert.equal(byId(p, 3).group, 'a-only');
    assert.equal(byId(p, 4).group, 'b-only');
    assert.ok(byId(p, 3).x < byId(p, 2).x && byId(p, 2).x < byId(p, 4).x, 'A-only left, shared middle, B-only right');
    assert.ok(byId(p, 2).y < byId(p, 3).y, 'shared files sit above one-sided files');
    assert.ok(p.height <= 420, `compact composition expected, got height ${p.height}`);
    assert.equal(p.metrics.crossings, 0);
    assert.equal(p.metrics.wiresThroughDots, 0);
  });

  it('keeps a dense 12-file clique legible: lead kept, every omission disclosed, every file wired', () => {
    const specs: EdgeSpec[] = [[0, 1, 12]];
    for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) if (i + j > 1) specs.push([i, j, 3 + ((i * 7 + j) % 6)]);
    const g = graph(12, specs);
    const family = { seeds: Array.from({ length: 12 }, (_, i) => i), leadEdge: 0, featuredEdges: specs.map((_, i) => i) };
    const p = computePlateLayout(g, family);
    assert.deepEqual(problems(p), []);
    assert.equal(p.nodes.length, MAX_EGO_NODES);
    assert.ok(p.leadEdge && p.leadEdge.edgeIndex === 0, 'the selected relationship is always drawn');
    const drawn = new Set(p.edges.map((e) => e.edgeIndex));
    assert.equal(p.hiddenEdgeIndices.length, p.hiddenContextEdges);
    assert.ok(p.hiddenEdgeIndices.every((id) => !drawn.has(id)), 'hidden and drawn wires are disjoint');
    assert.equal(drawn.size + p.hiddenContextEdges, specs.length, 'every relationship is drawn or counted as hidden');
    for (const n of p.nodes.filter((x) => x.group !== 'focus')) {
      assert.equal(n.group, 'shared');
      const toA = p.edges.some((e) => [e.sourceNodeIndex, e.targetNodeIndex].includes(n.nodeIndex) && [e.sourceNodeIndex, e.targetNodeIndex].includes(0));
      const toB = p.edges.some((e) => [e.sourceNodeIndex, e.targetNodeIndex].includes(n.nodeIndex) && [e.sourceNodeIndex, e.targetNodeIndex].includes(1));
      assert.ok(toA && toB, `${n.shortLabel} is grouped as shared, so both of its wires to the pair are drawn`);
    }
    assert.equal(p.metrics.labelOverlaps + p.metrics.labelNodeOverlaps, 0);
  });

  it('wraps many shared neighbours into well-spaced rows', () => {
    const paths = Array.from({ length: 11 }, (_, i) => `src/components/settings/customizer-panel-${i}-picker.tsx`);
    const g = graph(paths, [[0, 1, 9], ...Array.from({ length: 9 }, (_, k) => [[k + 2, 0], [k + 2, 1]] as EdgeSpec[]).flat()]);
    const p = computePlateLayout(g, pair(g));
    assert.deepEqual(problems(p), []);
    const shared = p.nodes.filter((n) => n.group === 'shared');
    const rows = new Set(shared.map((n) => n.y));
    assert.ok(rows.size >= 2, `expected several shared rows, got ${rows.size}`);
    for (const y of rows) {
      const row = shared.filter((n) => n.y === y).sort((a, b) => a.x - b.x);
      for (let i = 1; i < row.length; i++) {
        assert.ok(row[i]!.label.x >= row[i - 1]!.label.x + row[i - 1]!.label.w, 'labels in a row never touch');
      }
    }
  });

  it('balances a one-sided plate without inventing the missing side', () => {
    const g = graph(9, [[0, 1, 9], ...Array.from({ length: 7 }, (_, k) => [k + 2, 0] as EdgeSpec)]);
    const p = computePlateLayout(g, pair(g));
    assert.deepEqual(problems(p), []);
    const context = p.nodes.filter((n) => n.group !== 'focus');
    assert.ok(context.every((n) => n.group === 'a-only'));
    const centroid = context.reduce((s, n) => s + n.x, 0) / context.length;
    assert.ok(centroid < p.width / 2, `A-only files lean toward A (centroid ${centroid})`);
    assert.equal(p.metrics.wiresThroughDots, 0);
  });

  it('keeps a family file reached only through another member, wired to that member, below the rest', () => {
    // 0-1 lead, 2 shared, 3 linked only to 2
    const g = graph(4, [[0, 1, 9], [2, 0], [2, 1], [3, 2, 4]]);
    const p = computePlateLayout(g, { seeds: [0, 1, 2, 3], leadEdge: 0, featuredEdges: [0, 1, 2, 3] });
    assert.deepEqual(problems(p), []);
    assert.equal(byId(p, 3).group, 'other');
    assert.ok(p.edges.some((e) => e.edgeIndex === 3), 'its only connection is drawn');
    assert.ok(byId(p, 3).y > byId(p, 2).y);
  });

  it('disambiguates identical basenames and keeps the full path for each file', () => {
    const paths = ['src/a/index.ts', 'src/b/index.ts', 'lib/a/index.ts', 'src/c/util.ts'];
    assert.deepEqual(disambiguateLabels(paths), ['src/a/index.ts', 'b/index.ts', 'lib/a/index.ts', 'util.ts']);
    const g = graph(paths, [[0, 1, 9], [2, 0], [2, 1], [3, 0]]);
    const p = computePlateLayout(g, pair(g));
    assert.deepEqual(problems(p), []);
    const labels = p.nodes.map((n) => n.shortLabel);
    assert.equal(new Set(labels).size, labels.length, 'labels are distinct');
    assert.deepEqual(p.nodes.map((n) => n.path).sort(), [...paths].sort());
  });

  it('measures and truncates multilingual labels without breaking characters', () => {
    assert.ok(measureLabelWidth('日本語', 12.5) - 10 > (measureLabelWidth('abc', 12.5) - 10) * 1.8, 'CJK glyphs are full width');
    assert.equal(measureLabelWidth('é', 12.5), measureLabelWidth('e', 12.5), 'combining marks add no width');
    const long = 'コンポーネント/設定/日本語のとても長いファイル名-😀😀😀-é́-final-name.tsx';
    const cut = truncateLabel(long, 20);
    assert.match(cut, /…/);
    assert.doesNotMatch(cut, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'no lone surrogates');
    assert.doesNotMatch(cut, /…́|^́/, 'combining marks stay with their base character');
    assert.equal(truncateLabel('short.ts', 20), 'short.ts');
    const g = graph(['src/日本語/コンポーネント設定ファイル.tsx', 'src/😀/emoji-heavy-😀😀😀-name.tsx', 'src/x.ts'], [[0, 1, 9], [2, 0], [2, 1]]);
    for (const mode of ['desktop', 'compact'] as const) {
      assert.deepEqual(problems(computePlateLayout(g, pair(g), { mode })), [], mode);
    }
  });

  it('composes compact plates as the pair plus the closest neighbours, listing the rest', () => {
    const g = graph(9, [[0, 1, 9], [2, 0, 8], [2, 1, 8], [3, 0, 7], [3, 1, 7], [4, 0, 6], [5, 1, 5], [6, 0], [7, 1], [8, 0]]);
    const p = computePlateLayout(g, pair(g), { mode: 'compact' });
    assert.deepEqual(problems(p), []);
    assert.equal(p.mode, 'compact');
    assert.equal(p.width, 340);
    assert.equal(p.nodes.length, 2 + COMPACT_CONTEXT_NODES);
    assert.equal(p.balloonBox, null, 'the callout moves under the plate on phones');
    assert.deepEqual(p.nodes.filter((n) => n.group !== 'focus').map((n) => n.nodeIndex), [2, 3], 'shared files come first');
    assert.deepEqual(p.overflow.map((o) => o.nodeIndex), [4, 5, 6, 7, 8], 'the rest are listed strongest first');
    assert.deepEqual(p.overflow.map((o) => o.group), ['a-only', 'b-only', 'a-only', 'b-only', 'a-only']);
    assert.ok(p.overflow.every((o) => o.path.startsWith('src/') && o.shortLabel.length > 0));
  });

  it('survives invalid input without NaN geometry', () => {
    const g = graph(4, [[0, 1, 9], [2, 0], [2, 2], [0, 1, 3], [7, 1]]);
    const bad = {
      nodes: [...g.nodes.slice(0, 3), { path: 'src/f3.ts', dir: 'src', changes: Number.NaN }],
      edges: g.edges.map((e, i) =>
        i === 1 ? { ...e, score: Number.NaN, interval: { low: Number.POSITIVE_INFINITY }, overviewPriority: Number.NaN } : e,
      ),
    } as PlateGraph;
    const p = computePlateLayout(bad, { seeds: [0, 1, 2, 3, -4, 99, 1.5], leadEdge: 0, featuredEdges: [0, 1, 42] });
    assert.deepEqual(problems(p), []);
    assert.equal(p.edges.filter((e) => e.sourceNodeIndex === e.targetNodeIndex).length, 0, 'self loops are ignored');
    assert.equal(p.edges.filter((e) => e.edgeIndex === 3).length, 0, 'duplicate relationships are ignored');
    assert.deepEqual(p.disconnectedNodeIndices, [3], 'a seed without any visible relationship is disclosed, not drawn');
    const empty = computePlateLayout({ nodes: [], edges: [] }, { seeds: [], leadEdge: 5, featuredEdges: [] });
    assert.equal(empty.nodes.length, 0);
    assert.ok(Number.isFinite(empty.height));
  });

  it('is deterministic and independent of seed and featured-edge order', () => {
    const specs: EdgeSpec[] = [[0, 1, 9], [2, 0], [2, 1], [3, 0], [4, 1], [5, 2], [3, 4, 2]];
    const g = graph(6, specs);
    const a = computePlateLayout(g, { seeds: [0, 1, 2, 3, 4, 5], leadEdge: 0, featuredEdges: [0, 1, 2, 3, 4, 5, 6] });
    const b = computePlateLayout(g, { seeds: [5, 3, 1, 4, 0, 2], leadEdge: 0, featuredEdges: [6, 5, 4, 3, 2, 1, 0] });
    assert.deepEqual(a, b);
    assert.deepEqual(computePlateLayout(g, pair(g)), computePlateLayout(g, pair(g)));
  });

  it('honours relationship filters while always keeping the selected relationship', () => {
    const g = graph(5, [[0, 1, 9, 'unknown'], [2, 0, 5, 'direct'], [2, 1, 5, 'ghost'], [3, 0, 5, 'direct'], [4, 3, 5, 'ghost']]);
    const p = computePlateLayout(
      g,
      { seeds: [0, 1, 2, 3, 4], leadEdge: 0, featuredEdges: [0, 1, 2, 3, 4] },
      { visible: { ghost: true, direct: false, unknown: false } },
    );
    assert.deepEqual(p.edges.map((e) => e.edgeIndex).sort(), [0, 2, 4], 'hidden kinds are not drawn, the lead always is');
    assert.equal(byId(p, 2).group, 'b-only', 'grouping follows the visible relationships only');
    assert.ok(p.edges.every((e) => e.relationship !== 'direct'));
    assert.deepEqual(problems(p), []);
  });

  it('keeps shared files where the reader last saw them when the order is otherwise a tie', () => {
    const g = graph(6, [[0, 1, 9], [2, 0], [2, 1], [3, 0], [3, 1], [4, 0], [4, 1], [5, 0], [5, 1]]);
    const first = computePlateLayout(g, pair(g));
    const order = (p: FeaturedPlateLayout) => p.nodes.filter((n) => n.group === 'shared').sort((a, b) => a.x - b.x).map((n) => n.nodeIndex);
    const reversed = order(first).reverse();
    const previous = reversed.map((nodeIndex, i) => ({ nodeIndex, x: 100 + i * 150 }));
    assert.deepEqual(order(computePlateLayout(g, pair(g), { previous })), reversed);
  });

  it('keeps crossings to the unavoidable minimum and never runs a wire through an unrelated file', () => {
    // Pair with two shared files, one A-only and one B-only file, and a chain between the shared files
    const g = graph(6, [[0, 1, 9], [2, 0], [2, 1], [3, 0], [3, 1], [2, 3], [4, 0], [5, 1]]);
    const p = computePlateLayout(g, pair(g));
    assert.deepEqual(problems(p), []);
    assert.equal(p.metrics.crossings, 1, 'with the pair on top, the fans to two shared files must cross exactly once');
    assert.equal(p.metrics.wiresThroughDots, 0);
  });

  it('draws the context view without a pair: every file, no balloon, no grouping', () => {
    const g = graph(4, [[0, 1], [2, 3]]);
    const p = computePlateLayout(g, { seeds: [0, 1, 2, 3], leadEdge: null, featuredEdges: [] });
    assert.deepEqual(problems(p), []);
    assert.equal(p.nodes.length, 4);
    assert.ok(p.nodes.every((n) => n.group === 'other'));
    assert.equal(p.balloonBox, null);
    assert.equal(p.leadEdge, null);
  });

  it('keeps unlinked files in the context view, where there is no pair to relate them to', () => {
    const g = graph(5, [[0, 1]]);
    const p = computePlateLayout(g, { seeds: [0, 1, 2, 3, 4], leadEdge: null, featuredEdges: [] });
    assert.deepEqual(p.nodes.map((n) => n.nodeIndex).sort(), [0, 1, 2, 3, 4]);
    assert.deepEqual(p.disconnectedNodeIndices, []);
    const compact = computePlateLayout(g, { seeds: [0, 1, 2, 3, 4], leadEdge: null, featuredEdges: [] }, { mode: 'compact' });
    assert.equal(compact.nodes.length + compact.overflow.length, 5, 'compact context views draw some files and list the rest');
    assert.ok(compact.nodes.length >= 2);
    const lone = computePlateLayout(graph(3, []), { seeds: [0, 1, 2], leadEdge: null, featuredEdges: [] });
    assert.equal(lone.nodes.length, 3, 'a context view with no relationships still shows its files');
    const layout = problems(lone).filter((x) => !x.endsWith('no wire'));
    assert.deepEqual(layout, []);
  });

  it('never draws a phone-plate file whose only links are to listed files', () => {
    // Lead 0-1, one shared file (2), and family files 3-4 reachable only through each other and 2
    const g = graph(5, [[0, 1, 9], [2, 0], [2, 1], [3, 4, 8], [4, 2, 2]]);
    const p = computePlateLayout(g, { seeds: [0, 1, 2, 3, 4], leadEdge: 0, featuredEdges: [0, 1, 2, 3, 4] }, { mode: 'compact' });
    assert.deepEqual(problems(p), []);
    assert.ok(p.nodes.every((n) => n.group !== 'other'), 'files reached only through other files are listed, not drawn');
    assert.deepEqual(p.overflow.map((o) => [o.nodeIndex, o.group]), [[3, 'other'], [4, 'other']]);
  });

  it('draws one wire per pair, keeping the selected relationship over a duplicate', () => {
    const g = graph(3, [[0, 1, 4], [2, 0], [1, 0, 9]]);
    const p = computePlateLayout(g, { seeds: [0, 1], leadEdge: 2, featuredEdges: [2] });
    const between = p.edges.filter((e) => [e.sourceNodeIndex, e.targetNodeIndex].sort().join() === '0,1');
    assert.equal(between.length, 1);
    assert.equal(between[0]!.edgeIndex, 2);
    assert.equal(between[0]!.isLeadEdge, true);
  });

  it('lays plates out for the width they are shown at, within each mode range', () => {
    const paths = Array.from({ length: 10 }, (_, i) => `src/components/customizer/panel-${i}-picker.tsx`);
    const g = graph(paths, [[0, 1, 9], ...Array.from({ length: 8 }, (_, k) => [[k + 2, 0], [k + 2, k % 2]] as EdgeSpec[]).flat()]);
    for (const [mode, width, expected] of [
      ['desktop', 560, 560], ['desktop', 640, 640], ['desktop', 760, 760], ['desktop', 2000, 760], ['desktop', 100, 560],
      ['compact', 300, 300], ['compact', 390, 390], ['compact', 440, 440], ['compact', 900, 440], ['compact', Number.NaN, 340],
    ] as const) {
      const p = computePlateLayout(g, pair(g), { mode, width });
      assert.equal(p.width, expected, `${mode} at ${width}`);
      assert.deepEqual(problems(p), [], `${mode} at ${width}`);
    }
  });

  it('lays out a dense plate in a few milliseconds', () => {
    const specs: EdgeSpec[] = [[0, 1, 12]];
    for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) if (i + j > 1) specs.push([i, j, 3 + ((i + j) % 5)]);
    const g = graph(12, specs);
    const family = { seeds: Array.from({ length: 12 }, (_, i) => i), leadEdge: 0, featuredEdges: specs.map((_, i) => i) };
    const start = process.hrtime.bigint();
    for (let k = 0; k < 20; k++) computePlateLayout(g, family);
    const avgMs = Number(process.hrtime.bigint() - start) / 1e6 / 20;
    assert.ok(avgMs < 60, `average layout time ${avgMs.toFixed(2)}ms`);
  });
});
