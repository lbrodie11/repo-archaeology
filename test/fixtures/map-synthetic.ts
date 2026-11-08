import type { MapData, MapEdge, MapFamily, MapNode } from '../../src/commands/map.js';
import type { Relationship } from '../../src/imports/classify.js';
import { wilsonInterval } from '../../src/util/stats.js';

export const SYNTHETIC_EDGE_COUNTS = [50, 150, 500, 1000] as const;

function createPrng(seedInit: number): () => number {
  let seed = seedInit | 0;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLUSTER_DIRS = [
  'src/core',
  'src/api',
  'src/db',
  'src/auth',
  'src/billing',
  'src/events',
  'src/worker',
  'src/ui',
];

const COMPONENT_DIRS = [
  'src/routes',
  'src/adapters/bun',
  'src/adapters/deno',
  'src/adapters/cloudflare',
  'src/adapters/node',
  'src/middleware/cors',
  'src/middleware/jwt',
  'src/middleware/csrf',
  'src/utils',
  'src/client',
  'src/ cli',
  'templates/invoice',
  'templates/receipt',
  'packages/sdk/src',
  'packages/shared/src',
  'test/integration',
];

const AUTHORS = ['Alice', 'Bob', 'Carol', 'Dan', 'Eve'];

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Deterministic `MapData` generator for benchmark and unit tests.
 * Mixes one dense cluster of 40+ nodes with disconnected triangles and pairs
 * to match real repository co-change graphs.
 */
export function generateSyntheticMapData(
  edgeCount: number,
  options?: { repoName?: string; seed?: number },
): MapData {
  const repoName = options?.repoName ?? `synthetic-${edgeCount}`;
  const rand = createPrng(options?.seed ?? edgeCount * 1009 + 42);

  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const pairSeen = new Set<string>();

  const addNode = (dir: string, name: string): number => {
    const idx = nodes.length;
    const changes = 4 + Math.floor(rand() * 45);
    const topAuthor = AUTHORS[idx % AUTHORS.length]!;
    const topAuthorShare = Math.round((0.35 + rand() * 0.6) * 100) / 100;
    nodes.push({
      path: dir === '(root)' ? name : `${dir}/${name}`,
      dir,
      changes,
      topAuthor,
      topAuthorShare,
    });
    return idx;
  };

  const counts: Record<Relationship, number> = {
    ghost: 0,
    unknown: 0,
    indirect: 0,
    direct: 0,
    test: 0,
  };

  const pickRelationship = (edgeIdx: number, crossesDirs: boolean): Relationship => {
    const r = rand();
    if (edgeIdx % 11 === 0) return 'unknown';
    if (edgeIdx % 7 === 0) return 'test';
    if (r < 0.42) return 'ghost';
    if (r < 0.72) return crossesDirs ? 'indirect' : 'direct';
    return 'direct';
  };

  const addEdge = (u: number, v: number, forcedRel?: Relationship): number | undefined => {
    if (u === v) return undefined;
    const lo = Math.min(u, v);
    const hi = Math.max(u, v);
    const key = `${lo}:${hi}`;
    if (pairSeen.has(key)) return undefined;
    pairSeen.add(key);

    const nodeU = nodes[u]!;
    const nodeV = nodes[v]!;
    const crossesDirectories = nodeU.dir !== nodeV.dir;
    const edgeIdx = edges.length;
    const relationship = forcedRel ?? pickRelationship(edgeIdx, crossesDirectories);
    counts[relationship]++;

    const minChanges = Math.min(nodeU.changes, nodeV.changes);
    const shared = Math.max(3, Math.min(minChanges, 3 + Math.floor(rand() * (minChanges - 2))));
    const fromChanges = Math.max(shared, nodeU.changes);
    const toChanges = Math.max(shared, nodeV.changes);
    const confidence = round4(shared / fromChanges);
    const reverseConfidence = round4(shared / toChanges);
    const rawIv = wilsonInterval(shared, fromChanges);
    const revIv = wilsonInterval(shared, toChanges);
    const interval = {
      low: Math.floor(rawIv.low * 10000) / 10000,
      high: Math.ceil(rawIv.high * 10000) / 10000,
    };
    const reverseInterval = {
      low: Math.floor(revIv.low * 10000) / 10000,
      high: Math.ceil(revIv.high * 10000) / 10000,
    };
    const score = round4(Math.max(interval.low, reverseInterval.low));
    const overviewPriority =
      relationship === 'ghost' ? (crossesDirectories && edgeIdx % 3 === 0 ? 2 : 1) : 0;
    const day = 1 + (edgeIdx % 28);
    const month = 1 + ((edgeIdx >>> 2) % 9);
    const lastTogether = `2026-0${month}-${String(day).padStart(2, '0')}`;

    const why =
      relationship === 'ghost'
        ? 'no import link found between these files'
        : relationship === 'direct'
          ? `${nodeU.path} imports ${nodeV.path}`
          : relationship === 'indirect'
            ? `connected through ${CLUSTER_DIRS[0]}/index.ts`
            : relationship === 'test'
              ? 'test and implementation pair'
              : 'import status could not be verified';

    const hashBase = (edgeIdx + 1).toString(16).padStart(7, '0');
    edges.push({
      source: u,
      target: v,
      relationship,
      why,
      shared,
      fromChanges,
      toChanges,
      confidence,
      reverseConfidence,
      interval,
      reverseInterval,
      score,
      overviewPriority,
      weighted: false,
      lastTogether,
      crossesDirectories,
      originShare: { human: 1, agent: 0, bot: 0 },
      evidence: [
        {
          hash: `${hashBase}a1b2c3d4e5f60123456789abcdef012345`,
          date: lastTogether,
          subject: `feat: update ${nodeU.path} and ${nodeV.path}`,
          origin: 'human',
        },
        {
          hash: `${hashBase}b2c3d4e5f60123456789abcdef01234567`,
          date: '2026-01-15',
          subject: `fix: sync companion state (${edgeIdx})`,
          origin: 'human',
        },
      ],
      counterexamples: {
        fromOnlyTotal: 1,
        toOnlyTotal: 1,
        fromOnly: [
          {
            hash: `${hashBase}c3d4e5f60123456789abcdef0123456789`,
            date: '2026-01-05',
            subject: `chore: touch ${nodeU.path} alone`,
            origin: 'human',
          },
        ],
        toOnly: [
          {
            hash: `${hashBase}d4e5f60123456789abcdef0123456789ab`,
            date: '2026-01-03',
            subject: `chore: touch ${nodeV.path} alone`,
            origin: 'human',
          },
        ],
      },
      explainCommand: `npx repo-archaeology explain ${nodeU.path} ${nodeV.path}`,
    });
    return edgeIdx;
  };

  // 1. Dense cluster of 42 nodes
  const clusterNodeCount = 42;
  const clusterNodes: number[] = [];
  for (let i = 0; i < clusterNodeCount; i++) {
    const dir = CLUSTER_DIRS[i % CLUSTER_DIRS.length]!;
    clusterNodes.push(addNode(dir, `module-${i}.ts`));
  }

  // Ensure every node in the 42-node cluster has at least one edge:
  // For edgeCount === 50, pair up the 42 nodes into 21 pairs + 13 cross-links = 34 cluster edges,
  // leaving 16 edges for triangles and disconnected pairs.
  // For larger edgeCounts, connect a spanning tree (41 edges) + dense chords.
  if (edgeCount <= 60) {
    for (let i = 0; i < clusterNodeCount; i += 2) {
      addEdge(clusterNodes[i]!, clusterNodes[i + 1]!);
    }
    const extraClusterEdges = Math.min(13, Math.max(4, edgeCount - 35));
    for (let k = 0; k < extraClusterEdges; k++) {
      const a = clusterNodes[(k * 3) % clusterNodeCount]!;
      const b = clusterNodes[(k * 7 + 5) % clusterNodeCount]!;
      addEdge(a, b);
    }
  } else {
    for (let i = 1; i < clusterNodeCount; i++) {
      const target = clusterNodes[Math.floor(rand() * i)]!;
      addEdge(clusterNodes[i]!, target);
    }
    const targetClusterEdges = Math.min(
      Math.floor(edgeCount * 0.28),
      (clusterNodeCount * (clusterNodeCount - 1)) / 4,
    );
    while (edges.length < targetClusterEdges) {
      const u = clusterNodes[Math.floor(rand() * clusterNodeCount)]!;
      const v = clusterNodes[Math.floor(rand() * clusterNodeCount)]!;
      addEdge(u, v);
    }
  }

  // 2. One parallel-implementation family (triangle of 3 adapter files)
  const famVariants = ['bun', 'deno', 'node'];
  const famNodes = famVariants.map((v) => addNode(`src/adapters/${v}`, 'ssg.ts'));
  const famEdges: number[] = [];
  for (let i = 0; i < famNodes.length; i++) {
    for (let j = i + 1; j < famNodes.length; j++) {
      if (edges.length < edgeCount) {
        const eIdx = addEdge(famNodes[i]!, famNodes[j]!, 'ghost');
        if (eIdx !== undefined) {
          edges[eIdx]!.hiddenBridge = {
            signal: 'parallel-implementation',
            value: 'ssg.ts',
            filesUsing: 3,
          };
          famEdges.push(eIdx);
        }
      }
    }
  }

  // 3. Fill the remaining budget with a mix of disconnected triangles (3 edges) and pairs (1 edge)
  let compCounter = 0;
  while (edges.length < edgeCount) {
    const remaining = edgeCount - edges.length;
    const dirA = COMPONENT_DIRS[compCounter % COMPONENT_DIRS.length]!;
    const dirB = COMPONENT_DIRS[(compCounter + 3) % COMPONENT_DIRS.length]!;
    if (remaining >= 3 && compCounter % 3 === 0) {
      const n1 = addNode(dirA, `tri-${compCounter}-a.ts`);
      const n2 = addNode(dirB, `tri-${compCounter}-b.ts`);
      const n3 = addNode(dirA, `tri-${compCounter}-c.ts`);
      addEdge(n1, n2);
      addEdge(n2, n3);
      addEdge(n1, n3);
    } else {
      const n1 = addNode(dirA, `pair-${compCounter}-a.ts`);
      const n2 = addNode(dirB, `pair-${compCounter}-b.ts`);
      addEdge(n1, n2);
    }
    compCounter++;
  }

  // Guarantee all 5 relationship kinds appear at least once so all 5 filter toggles render
  const allKinds: Relationship[] = ['ghost', 'unknown', 'indirect', 'direct', 'test'];
  for (let k = 0; k < allKinds.length && k < edges.length; k++) {
    const want = allKinds[k]!;
    if (counts[want] === 0) {
      const prev = edges[k]!.relationship;
      counts[prev]--;
      edges[k]!.relationship = want;
      counts[want]++;
    }
  }

  const families: MapFamily[] =
    famEdges.length >= 2
      ? [
          {
            id: 'src/adapters/*/ssg.ts',
            stem: 'ssg.ts',
            parentDir: 'src/adapters',
            label: 'src/adapters/*/ssg.ts',
            members: famNodes.map((nIdx, mIdx) => ({
              path: nodes[nIdx]!.path,
              variant: famVariants[mIdx]!,
              directory: nodes[nIdx]!.dir,
              changes: nodes[nIdx]!.changes,
              topAuthor: nodes[nIdx]!.topAuthor,
              topAuthorShare: nodes[nIdx]!.topAuthorShare,
            })),
            nodeIndices: famNodes,
            edgeIndices: famEdges,
            qualifyingPairs: famEdges.length,
            possiblePairs: 3,
            commitsTouchingTwoOrMore: 8,
            commitsTouchingAll: 5,
            lastTogether: '2026-09-18',
            evidence: [
              {
                hash: 'f00baa1234567890abcdef1234567890abcdef12',
                date: '2026-09-18',
                author: 'Alice',
                subject: 'feat(ssg): update ssg adapters together',
                origin: 'human',
                membersTouched: 3,
                totalMembers: 3,
                touchesAllMembers: true,
                memberPaths: famNodes.map((idx) => nodes[idx]!.path),
              },
            ],
            overviewPriority: 1,
          },
        ]
      : [];

  return {
    meta: {
      root: repoName,
      commitsAnalyzed: edgeCount * 4,
      commitsSkippedAsSweeps: 2,
      commitsSkippedByFilter: 0,
      filesSeen: nodes.length,
      oldestCommit: '2025-01-01',
      newestCommit: '2026-10-01',
      settings: {
        minShared: 3,
        minConfidence: 0.4,
        maxFilesPerCommit: 25,
      },
      warnings: [],
      origins: {
        human: edgeCount * 4,
        agent: 0,
        bot: 0,
      },
    },
    repoName,
    generatedAt: '2026-10-15T00:00:00.000Z',
    counts,
    classificationTruncated: false,
    patchesIncluded: false,
    nodes,
    edges,
    families,
  };
}
