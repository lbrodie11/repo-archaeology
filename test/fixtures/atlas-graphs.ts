// Deterministic graph shapes for Atlas tests: each builder returns MapData with a known structure
// (star, clique, chain, giant component, many components, unchecked-only groups, awkward names).
import type { MapData, MapEdge, MapNode } from '../../src/commands/map.js';
import type { Relationship } from '../../src/imports/classify.js';
import { wilsonInterval } from '../../src/util/stats.js';
import { generateSyntheticMapData } from './map-synthetic.js';

export type EdgeSpec = [source: number, target: number, relationship?: Relationship, shared?: number];

function prng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
}

function edge(nodes: readonly MapNode[], [source, target, relationship = 'ghost', shared = 5]: EdgeSpec): MapEdge {
  const fromChanges = Math.max(shared, shared + 2);
  const toChanges = Math.max(shared, shared + 4);
  const interval = wilsonInterval(shared, fromChanges);
  const reverseInterval = wilsonInterval(shared, toChanges);
  const crossesDirectories = nodes[source]!.dir !== nodes[target]!.dir;
  return {
    source,
    target,
    relationship,
    why: relationship === 'ghost' ? 'changed together without a direct or indirect import' : `connected via ${relationship} relationship`,
    shared,
    fromChanges,
    toChanges,
    confidence: shared / fromChanges,
    reverseConfidence: shared / toChanges,
    interval: { low: Math.round(interval.low * 1000) / 1000, high: Math.round(interval.high * 1000) / 1000 },
    reverseInterval: { low: Math.round(reverseInterval.low * 1000) / 1000, high: Math.round(reverseInterval.high * 1000) / 1000 },
    score: Math.round((shared / fromChanges) * Math.log2(shared + 1) * 1000) / 1000,
    overviewPriority: relationship === 'ghost' ? (crossesDirectories ? 2 : 1) : 0,
    weighted: false,
    lastTogether: '2026-03-20',
    crossesDirectories,
    originShare: { human: 1, agent: 0, bot: 0 },
    evidence: [{ hash: 'abc1234', date: '2026-03-20', subject: 'change both files' }],
  };
}

/** Builds MapData from file paths and edge specs (edge index = position in `specs`). */
export function atlasGraph(name: string, paths: readonly string[], specs: readonly EdgeSpec[]): MapData {
  const nodes: MapNode[] = paths.map((path, i) => ({
    path,
    dir: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '(root)',
    changes: 6 + (i % 9),
  }));
  const edges = specs.map((s) => edge(nodes, s));
  const counts: Record<Relationship, number> = { ghost: 0, unknown: 0, indirect: 0, direct: 0, test: 0 };
  for (const e of edges) counts[e.relationship]++;
  const base = generateSyntheticMapData(1, { repoName: name });
  return {
    ...base,
    meta: { ...base.meta, root: name },
    repoName: name,
    generatedAt: '2026-04-01T12:00:00.000Z',
    counts,
    classificationTruncated: false,
    patchesIncluded: false,
    nodes,
    edges,
    families: [],
  };
}

const DIRS = ['src/commands', 'src/utils', 'src/registry', 'src/mcp', 'apps/web/components', 'apps/web/hooks', 'packages/core/src', 'packages/cli/src', 'docs', 'scripts/build'];
const filePath = (i: number, dirCount = DIRS.length): string => `${DIRS[i % dirCount]}/file-${i}.ts`;
const filePaths = (n: number, dirCount?: number): string[] => Array.from({ length: n }, (_, i) => filePath(i, dirCount));

export const emptyGraph = (): MapData => atlasGraph('atlas-empty', [], []);

/** `count` disconnected pairs: one frame each. Every `uncheckedEvery`-th pair is unchecked-only. */
export function pairsGraph(count: number, uncheckedEvery = 0): MapData {
  const specs: EdgeSpec[] = [];
  for (let i = 0; i < count; i++) {
    const unchecked = uncheckedEvery > 0 && i % uncheckedEvery === uncheckedEvery - 1;
    specs.push([2 * i, 2 * i + 1, unchecked ? 'unknown' : i % 3 === 0 ? 'ghost' : 'direct', 3 + (i % 5)]);
  }
  return atlasGraph(`atlas-pairs-${count}`, filePaths(2 * count), specs);
}

/** One hub connected to `leaves` files. */
export function starGraph(leaves: number): MapData {
  const specs: EdgeSpec[] = Array.from({ length: leaves }, (_, i) => [0, i + 1, i % 2 ? 'ghost' : 'direct', 3 + (i % 6)] as EdgeSpec);
  return atlasGraph(`atlas-star-${leaves}`, filePaths(leaves + 1), specs);
}

/** Every file connected to every other file. */
export function cliqueGraph(n: number): MapData {
  const specs: EdgeSpec[] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) specs.push([i, j, (i + j) % 3 === 0 ? 'direct' : 'ghost', 3 + ((i * 7 + j) % 6)]);
  return atlasGraph(`atlas-clique-${n}`, filePaths(n, 3), specs);
}

/** A single path of `n` files. */
export function chainGraph(n: number): MapData {
  const specs: EdgeSpec[] = Array.from({ length: n - 1 }, (_, i) => [i, i + 1, i % 4 === 0 ? 'ghost' : 'indirect', 4] as EdgeSpec);
  return atlasGraph(`atlas-chain-${n}`, filePaths(n), specs);
}

/** A random tree of `n` files plus `extra` random cross links: one large connected component. */
export function giantGraph(n: number, extra = Math.floor(n / 2), seed = 11): MapData {
  const rand = prng(seed);
  const specs: EdgeSpec[] = [];
  const seen = new Set<string>();
  const add = (a: number, b: number, rel: Relationship) => {
    const key = Math.min(a, b) + ':' + Math.max(a, b);
    if (a === b || seen.has(key)) return;
    seen.add(key);
    specs.push([a, b, rel, 3 + Math.floor(rand() * 8)]);
  };
  for (let i = 1; i < n; i++) add(Math.floor(rand() * i), i, rand() < 0.4 ? 'ghost' : 'direct');
  for (let k = 0; k < extra; k++) add(Math.floor(rand() * n), Math.floor(rand() * n), rand() < 0.6 ? 'ghost' : 'indirect');
  return atlasGraph(`atlas-giant-${n}`, filePaths(n), specs);
}

/**
 * A mixed sheet like a real repository: one big component, a few small ones, and groups whose links
 * are all unchecked (hidden by default because other kinds exist).
 */
export function mixedGraph(): MapData {
  const big = giantGraph(40, 30, 5);
  const paths = big.nodes.map((n) => n.path);
  const specs: EdgeSpec[] = big.edges.map((e) => [e.source, e.target, e.relationship, e.shared]);
  const addComponent = (size: number, rel: Relationship, dir: string) => {
    const start = paths.length;
    for (let i = 0; i < size; i++) paths.push(`${dir}/part-${start + i}.tsx`);
    for (let i = 1; i < size; i++) specs.push([start, start + i, rel, 4]);
  };
  addComponent(3, 'ghost', 'apps/web/fonts');
  addComponent(2, 'direct', 'apps/web/theme');
  addComponent(4, 'indirect', 'apps/web/directory');
  addComponent(3, 'unknown', 'legacy/a');
  addComponent(5, 'unknown', 'legacy/b');
  addComponent(2, 'unknown', 'legacy/c');
  return atlasGraph('atlas-mixed', paths, specs);
}

/** Long, duplicate, Unicode, emoji and control-character file names. */
export function awkwardNamesGraph(): MapData {
  const paths = [
    'src/a/index.ts',
    'src/b/index.ts',
    'src/コンポーネント/設定ファイルの非常に長い名前のテスト用ファイル.tsx',
    'src/emoji/😀-party-🎉-file.ts',
    'src/' + 'very-long-directory-name-'.repeat(4) + '/' + 'extremely-long-file-name-'.repeat(5) + 'end.ts',
    'src/rtl/‮evil‬.ts',
    'src/space dir/it\'s a file.ts',
    'README.md',
  ];
  return atlasGraph('atlas-awkward', paths, [[0, 1], [1, 2, 'direct'], [2, 3], [3, 4, 'indirect'], [4, 5], [5, 6, 'direct'], [6, 7]]);
}
