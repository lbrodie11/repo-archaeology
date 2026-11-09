import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MapData, MapEdge, MapFamily, MapNode } from '../src/commands/map.js';
import { DEFAULT_SETTINGS } from '../src/config.js';
import { RELATIONSHIPS } from '../src/imports/classify.js';
import { computeLayout } from '../src/map/layout.js';
import { renderMapHtml } from '../src/map/template.js';
import {
  buildAnalysisProvenance,
  formatReadingFindingGuide,
  getGlossaryEntry,
  GLOSSARY_TERMS,
  redactFilesystemPaths,
} from '../src/report/glossary.js';
import {
  buildRankedFindings,
  computeFeaturedPlateLayout,
  disambiguatePairPaths,
  formatBalloonCallout,
  formatCounterexamplesLine,
  formatDirectionMetric,
  formatEmptyStateCopy,
  formatEvidencePanelCopy,
  formatFamilyHeadline,
  formatFindingHash,
  formatOriginShareNote,
  formatOwnerNote,
  formatPairHeadline,
  formatVerdictNote,
  HOW_TO_READ_SUMMARY,
  KICKER_MOST_INTERESTING,
  middleTruncatePath,
  resolveFindingFromHash,
  selectFeaturedFinding,
  STATUS_CHIP_EVIDENCE,
} from '../src/map/copy.js';

function makeBaseData(overrides?: Partial<MapData>): MapData {
  const nodes: MapNode[] = [
    {
      path: 'src/preset/tiny.ts',
      dir: 'src/preset',
      changes: 8,
      topAuthor: 'Alice',
      topAuthorShare: 0.75,
    },
    {
      path: 'src/preset/quick.ts',
      dir: 'src/preset',
      changes: 10,
      topAuthor: 'Bob',
      topAuthorShare: 0.3,
    },
    {
      path: 'src/adapter/bun/serve-static.ts',
      dir: 'src/adapter/bun',
      changes: 20,
      topAuthor: 'Yusuke Wada',
      topAuthorShare: 0.75,
    },
    {
      path: 'src/adapter/deno/serve-static.ts',
      dir: 'src/adapter/deno',
      changes: 24,
      topAuthor: 'Yusuke Wada',
      topAuthorShare: 0.58,
    },
    {
      path: 'src/adapter/cloudflare-workers/serve-static.ts',
      dir: 'src/adapter/cloudflare-workers',
      changes: 27,
      topAuthor: 'Yusuke Wada',
      topAuthorShare: 0.74,
    },
  ];

  const edges: MapEdge[] = [
    {
      source: 0,
      target: 1,
      relationship: 'ghost',
      why: 'no import link detected in the current code',
      shared: 8,
      fromChanges: 8,
      toChanges: 10,
      confidence: 1,
      reverseConfidence: 0.8,
      interval: { low: 0.6756, high: 1 },
      reverseInterval: { low: 0.4902, high: 0.9433 },
      score: 0.6756,
      overviewPriority: 1,
      weighted: false,
      lastTogether: '2026-04-12',
      crossesDirectories: false,
      originShare: { human: 0.875, agent: 0.125, bot: 0 },
      evidence: [
        { hash: 'a1b2c3d4e5f60001', date: '2026-04-12', subject: 'feat: sync presets', origin: 'human' },
        { hash: 'b2c3d4e5f6a10002', date: '2026-03-10', subject: 'fix: preset exports', origin: 'agent' },
        { hash: 'c3d4e5f6a1b20003', date: '2026-02-01', subject: 'refactor: router preset', origin: 'human' },
        { hash: 'd4e5f6a1b2c30004', date: '2026-01-15', subject: 'chore: initial preset', origin: 'human' },
      ],
      counterexamples: {
        fromOnlyTotal: 0,
        toOnlyTotal: 2,
        fromOnly: [],
        toOnly: [
          { hash: 'e5f6a1b2c3d40005', date: '2026-03-20', subject: 'fix(quick): quick-only tweak', origin: 'human' },
        ],
      },
      explainCommand: 'npx repo-archaeology explain src/preset/tiny.ts src/preset/quick.ts',
    },
  ];

  return {
    meta: {
      tool: 'repo-archaeology',
      root: 'demo-repo',
      commitsRead: 2769,
      commitsAnalyzed: 2757,
      sweepsSkipped: 12,
      subjectSkipped: 0,
      renamesFollowed: 4,
      files: 180,
      oldestCommit: '2021-12-14',
      newestCommit: '2026-10-16',
      settings: {
        maxCommits: 5000,
        maxFilesPerCommit: 25,
        minShared: 3,
        minConfidence: 0.4,
        ignore: [],
        useDefaultIgnores: true,
      },
      warnings: [],
    },
    repoName: 'demo-repo',
    generatedAt: '2026-10-16T00:00:00.000Z',
    counts: { ghost: 1, unknown: 0, indirect: 0, direct: 0, test: 0 },
    classificationTruncated: false,
    nodes,
    edges,
    families: [],
    ...overrides,
  };
}

describe('RA-17 copy templates and featured finding selection (src/map/copy.ts)', () => {
  it('formats pair headlines, subheads, and stronger-direction numbers with exact field traceability', () => {
    const data = makeBaseData();
    const edge = data.edges[0]!;
    const copy = formatPairHeadline(data, edge);

    assert.equal(copy.headline, 'tiny.ts and quick.ts keep changing together');
    assert.equal(
      copy.subhead,
      'No direct or 2-hop import link was detected. 8 of 8 commits that changed tiny.ts also changed quick.ts.',
    );
    assert.equal(copy.shared, edge.shared);
    assert.equal(copy.fromChanges, edge.fromChanges);

    // When reverse direction is stronger, uses the reverse file as primary
    const reversedEdge: MapEdge = {
      ...edge,
      fromChanges: 20,
      toChanges: 9,
      confidence: 0.4,
      reverseConfidence: 8 / 9,
      interval: { low: 0.2188, high: 0.6134 },
      reverseInterval: { low: 0.565, high: 0.9801 },
    };
    const revCopy = formatPairHeadline(data, reversedEdge);
    assert.equal(revCopy.headline, 'quick.ts and tiny.ts keep changing together');
    assert.equal(
      revCopy.subhead,
      'No direct or 2-hop import link was detected. 8 of 9 commits that changed quick.ts also changed tiny.ts.',
    );
    assert.equal(revCopy.shared, reversedEdge.shared);
    assert.equal(revCopy.fromChanges, reversedEdge.toChanges);

    // Unknown relationship uses the required unchecked sentence + singular commit handling
    const unknownSingular: MapEdge = {
      ...edge,
      relationship: 'unknown',
      shared: 1,
      fromChanges: 1,
      toChanges: 2,
      confidence: 1,
      reverseConfidence: 0.5,
    };
    const unkCopy = formatPairHeadline(data, unknownSingular);
    assert.equal(
      unkCopy.subhead,
      "We couldn't check imports for these files. 1 of 1 commit that changed tiny.ts also changed quick.ts.",
    );
  });

  it('disambiguates colliding basenames without dropping intermediate segments and middle-truncates long paths with …', () => {
    const [a, b] = disambiguatePairPaths(
      'src/adapter/bun/serve-static.ts',
      'src/adapter/deno/serve-static.ts',
    );
    assert.equal(a, 'bun/serve-static.ts');
    assert.equal(b, 'deno/serve-static.ts');

    const [nestedA, nestedB] = disambiguatePairPaths('a/src/index.ts', 'b/src/index.ts');
    assert.equal(nestedA, 'a/src/index.ts');
    assert.equal(nestedB, 'b/src/index.ts');

    const [c, d] = disambiguatePairPaths('src/preset/tiny.ts', 'src/preset/quick.ts');
    assert.equal(c, 'tiny.ts');
    assert.equal(d, 'quick.ts');

    const truncated = middleTruncatePath(
      'packages/runtime/adapters/cloudflare-workers/middleware/serve-static.ts',
      30,
    );
    assert.ok(truncated.includes('…'), `expected ellipsis in "${truncated}"`);
    assert.ok(truncated.endsWith('/serve-static.ts'), `expected filename preserved in "${truncated}"`);
    assert.ok(truncated.length <= 30, `expected length <= 30, got ${truncated.length}`);
  });

  it('formats family headline and subhead from MapFamily counts', () => {
    const family: MapFamily = {
      id: 'src/adapter/*/serve-static',
      label: 'serve-static.ts across src/adapter/*',
      stem: 'serve-static',
      fileName: 'serve-static.ts',
      parentDir: 'src/adapter',
      why: '3 parallel implementations',
      members: [
        { path: 'src/adapter/bun/serve-static.ts', dir: 'src/adapter/bun', variant: 'bun', changes: 20, connections: 2 },
        { path: 'src/adapter/cloudflare-workers/serve-static.ts', dir: 'src/adapter/cloudflare-workers', variant: 'cloudflare-workers', changes: 27, connections: 2 },
        { path: 'src/adapter/deno/serve-static.ts', dir: 'src/adapter/deno', variant: 'deno', changes: 24, connections: 2 },
      ],
      commitsTouchingTwoOrMore: 16,
      commitsTouchingAll: 9,
      lastTogether: '2026-05-16',
      qualifyingPairs: 3,
      possiblePairs: 3,
      complete: true,
      relationshipKinds: ['ghost'],
      peakScore: 0.387,
      maxPairShared: 12,
      evidence: [],
      allMemberEvidence: [],
      nodeIndices: [2, 4, 3],
      edgeIndices: [0],
      overviewPriority: 1,
    };

    const copy = formatFamilyHeadline(family);
    assert.equal(copy.headline, '3 files across src/adapter/* keep changing together');
    assert.equal(
      copy.subhead,
      'No direct or 2-hop import link was detected between these 3 parallel implementations of serve-static.ts. All 3 pairwise links passed thresholds across 16 supporting commits (9 touched all 3).',
    );
    assert.equal(copy.memberCount, family.members.length);
    assert.equal(copy.commitsTouchingTwoOrMore, family.commitsTouchingTwoOrMore);
    assert.equal(copy.commitsTouchingAll, family.commitsTouchingAll);
  });

  it('formats balloon callout, directional metrics, counterexamples, owner note, originShare, verdict, and evidence panel copy', () => {
    const data = makeBaseData();
    const edge = data.edges[0]!;
    edge.verdict = {
      kind: 'confirmed',
      reason: 'Preset entrypoints must expose identical router bindings.',
    };

    assert.equal(formatBalloonCallout(data, edge), '8 of 8 commits together · no import detected');
    assert.equal(formatCounterexamplesLine(0), 'Changed alone: 0 times');
    assert.equal(formatCounterexamplesLine(1), 'Changed alone: 1 time');
    assert.equal(formatCounterexamplesLine(5), 'Changed alone: 5 times');

    const metric = formatDirectionMetric('tiny.ts', 'quick.ts', 8, 8, 1, { low: 0.6756, high: 1 });
    assert.equal(metric.pctText, '100%');
    assert.equal(metric.lowerBoundText, '≥68% CI');
    assert.equal(metric.detailText, '8 of 8 commits · 95% range 68–100%');

    assert.equal(
      formatOwnerNote(data.nodes[0]!, 'tiny.ts'),
      'Top historical contributor: Alice (75% of tiny.ts commits)',
    );
    // Below 0.4 threshold -> null
    assert.equal(formatOwnerNote(data.nodes[1]!, 'quick.ts'), null);

    assert.equal(
      formatOriginShareNote({ human: 0.875, agent: 0.125, bot: 0 }),
      'Commit origin: 13% agent, 88% human',
    );
    assert.equal(
      formatVerdictNote(edge.verdict),
      'Confirmed dependency: Preset entrypoints must expose identical router bindings.',
    );

    const panel = formatEvidencePanelCopy(data, { kind: 'pair', edgeIndex: 0, edge });
    assert.equal(panel.kicker, KICKER_MOST_INTERESTING);
    assert.equal(panel.statusChip, STATUS_CHIP_EVIDENCE);
    assert.equal(panel.primaryDirection.pctText, '100%');
    assert.equal(panel.reverseDirection.pctText, '80%');
    assert.equal(panel.lastTogetherText, 'Last together 2026-04-12');
    assert.equal(panel.receiptsShown.length, 3);
    assert.equal(panel.receiptsTotal, 8);
    assert.equal(panel.receiptsOverflowCount, 5);
    assert.equal(panel.howToReadSummary, HOW_TO_READ_SUMMARY);
    assert.equal(
      panel.explainCommand,
      'npx repo-archaeology explain src/preset/tiny.ts src/preset/quick.ts',
    );

    // Fallback explainCommand shell-quotes paths with spaces or shell metacharacters
    const spacedData = makeBaseData({
      nodes: [
        { path: 'src/my preset/tiny$(id).ts', dir: 'src/my preset', changes: 8 },
        { path: 'src/my preset/quick.ts', dir: 'src/my preset', changes: 10 },
      ],
      edges: [
        {
          ...edge,
          explainCommand: undefined,
        },
      ],
    });
    const spacedPanel = formatEvidencePanelCopy(spacedData, {
      kind: 'pair',
      edgeIndex: 0,
      edge: spacedData.edges[0]!,
    });
    assert.equal(
      spacedPanel.explainCommand,
      "npx repo-archaeology explain 'src/my preset/tiny$(id).ts' 'src/my preset/quick.ts'",
    );
  });

  it('deterministically selects featured finding across ghost pair, ghost family, no-ghost surprising, and empty state', () => {
    // 1. Standalone ghost pair
    const pairData = makeBaseData();
    const selPair = selectFeaturedFinding(pairData);
    assert.equal(selPair.kind, 'pair');
    if (selPair.kind === 'pair') {
      assert.equal(selPair.edgeIndex, 0);
    }

    // 2. Ghost family wins over pair when family's overviewPriority is highest
    const famEdge: MapEdge = {
      ...pairData.edges[0]!,
      source: 2,
      target: 3,
      shared: 12,
      fromChanges: 20,
      toChanges: 24,
      confidence: 0.6,
      reverseConfidence: 0.5,
      score: 0.387,
      overviewPriority: 1,
    };
    const fam: MapFamily = {
      id: 'src/adapter/*/serve-static',
      label: 'serve-static.ts across src/adapter/*',
      stem: 'serve-static',
      fileName: 'serve-static.ts',
      parentDir: 'src/adapter',
      why: 'parallel implementations',
      members: [
        { path: 'src/adapter/bun/serve-static.ts', dir: 'src/adapter/bun', variant: 'bun', changes: 20, connections: 2 },
        { path: 'src/adapter/cloudflare-workers/serve-static.ts', dir: 'src/adapter/cloudflare-workers', variant: 'cloudflare-workers', changes: 27, connections: 2 },
        { path: 'src/adapter/deno/serve-static.ts', dir: 'src/adapter/deno', variant: 'deno', changes: 24, connections: 2 },
      ],
      commitsTouchingTwoOrMore: 16,
      commitsTouchingAll: 9,
      lastTogether: '2026-05-16',
      qualifyingPairs: 3,
      possiblePairs: 3,
      complete: true,
      relationshipKinds: ['ghost'],
      peakScore: 0.387,
      maxPairShared: 12,
      evidence: [],
      allMemberEvidence: [],
      nodeIndices: [2, 4, 3],
      edgeIndices: [1],
      overviewPriority: 1,
    };
    const famData = makeBaseData({
      edges: [pairData.edges[0]!, famEdge],
      families: [fam],
    });
    const selFam = selectFeaturedFinding(famData);
    assert.equal(selFam.kind, 'family');
    if (selFam.kind === 'family') {
      assert.equal(selFam.family.id, 'src/adapter/*/serve-static');
    }

    // 3. No ghost wires -> top surprising link
    const noGhostSurprising = makeBaseData({
      counts: { ghost: 0, unknown: 1, indirect: 0, direct: 0, test: 0 },
      edges: [
        {
          ...pairData.edges[0]!,
          source: 0,
          target: 2,
          relationship: 'unknown',
          crossesDirectories: true,
          overviewPriority: 2,
        },
      ],
    });
    const selSurprising = selectFeaturedFinding(noGhostSurprising);
    assert.equal(selSurprising.kind, 'pair');
    if (selSurprising.kind === 'pair') {
      assert.equal(selSurprising.edge.relationship, 'unknown');
    }

    // 4. Only direct imports (or empty) -> first-class empty state with strongest import cluster context
    const onlyDirect = makeBaseData({
      counts: { ghost: 0, unknown: 0, indirect: 0, direct: 1, test: 0 },
      edges: [
        {
          ...pairData.edges[0]!,
          relationship: 'direct',
          overviewPriority: 0,
        },
      ],
    });
    const selEmpty = selectFeaturedFinding(onlyDirect);
    assert.equal(selEmpty.kind, 'empty');
    if (selEmpty.kind === 'empty') {
      assert.deepEqual(selEmpty.contextClusterNodeIndices, [0, 1]);
      assert.deepEqual(selEmpty.contextClusterEdgeIndices, [0]);
      const emptyCopy = formatEmptyStateCopy(onlyDirect, {
        nodeCount: selEmpty.contextClusterNodeIndices.length,
        edgeCount: selEmpty.contextClusterEdgeIndices.length,
      });
      assert.equal(emptyCopy.headline, 'No ghost wires in demo-repo');
      assert.equal(
        emptyCopy.subhead,
        'Checked 2,757 commits at ≥3 shared commits and ≥40% confidence.',
      );
      assert.ok(emptyCopy.contextNote?.includes('2 files, 1 import link'));
    }
  });

  it('encodes and resolves #f=<sourcePath>..<targetPath> hashes safely, including filenames with literal .., and ignores invalid or tampered hashes', () => {
    const data = makeBaseData({
      nodes: [
        ...makeBaseData().nodes,
        { path: 'src/preset/foo..bar.ts', dir: 'src/preset', changes: 5 },
        { path: 'src/preset/baz..qux.ts', dir: 'src/preset', changes: 5 },
      ],
      edges: [
        ...makeBaseData().edges,
        {
          source: 5,
          target: 6,
          relationship: 'ghost',
          why: 'no import',
          shared: 4,
          fromChanges: 5,
          toChanges: 5,
          confidence: 0.8,
          reverseConfidence: 0.8,
          interval: { low: 0.38, high: 0.96 },
          reverseInterval: { low: 0.38, high: 0.96 },
          score: 0.38,
          overviewPriority: 2,
          weighted: false,
          lastTogether: '2026-05-01',
          crossesDirectories: false,
          evidence: [],
        },
      ],
    });
    const hash = formatFindingHash('src/preset/tiny.ts', 'src/preset/quick.ts');
    assert.equal(hash, '#f=src%2Fpreset%2Ftiny.ts..src%2Fpreset%2Fquick.ts');

    const resolved = resolveFindingFromHash(hash, data);
    assert.ok(resolved && resolved.kind === 'pair' && resolved.edgeIndex === 0);

    // Reversed order still resolves the undirected pair
    const reversed = resolveFindingFromHash(
      formatFindingHash('src/preset/quick.ts', 'src/preset/tiny.ts'),
      data,
    );
    assert.ok(reversed && reversed.kind === 'pair' && reversed.edgeIndex === 0);

    // Paths containing literal '..' inside segments round-trip cleanly
    const dotDotHash = formatFindingHash('src/preset/foo..bar.ts', 'src/preset/baz..qux.ts');
    assert.equal(dotDotHash, '#f=src%2Fpreset%2Ffoo%2E%2Ebar.ts..src%2Fpreset%2Fbaz%2E%2Equx.ts');
    const resolvedDotDot = resolveFindingFromHash(dotDotHash, data);
    assert.ok(resolvedDotDot && resolvedDotDot.kind === 'pair' && resolvedDotDot.edgeIndex === 1);

    // Contiguous path suffix disambiguation preserves intermediate directories
    assert.deepEqual(disambiguatePairPaths('a/src/index.ts', 'b/src/index.ts'), [
      'a/src/index.ts',
      'b/src/index.ts',
    ]);
    assert.deepEqual(
      disambiguatePairPaths('packages/a/src/util/index.ts', 'packages/b/src/util/index.ts'),
      ['a/src/util/index.ts', 'b/src/util/index.ts'],
    );

    // Invalid / tampered / unknown paths return null
    assert.equal(resolveFindingFromHash('', data), null);
    assert.equal(resolveFindingFromHash('#view=atlas', data), null);
    assert.equal(resolveFindingFromHash('#f=only-one-side', data), null);
    assert.equal(resolveFindingFromHash('#f=%E0%A4%A..b', data), null);
    assert.equal(resolveFindingFromHash('#f=src/preset/tiny.ts..src/nonexistent.ts', data), null);
    assert.equal(resolveFindingFromHash('#f=src/preset/tiny.ts%00..src/preset/quick.ts', data), null);
  });

  it('places labels with zero bounding-box overlaps on synthetic 2, 3, 6, and 12-node fixtures', () => {
    for (const nodeCount of [2, 3, 6, 12, 16]) {
      const nodes: MapNode[] = Array.from({ length: nodeCount }, (_, i) => ({
        path: `src/module-${i % 4}/service-component-${i}.ts`,
        dir: `src/module-${i % 4}`,
        changes: 8 + i * 3,
      }));
      const edges: MapEdge[] = [];
      for (let i = 1; i < nodeCount; i++) {
        edges.push({
          source: 0,
          target: i,
          relationship: i === 1 ? 'ghost' : 'direct',
          why: 'test',
          shared: 6,
          fromChanges: 10,
          toChanges: 12,
          confidence: 0.6,
          reverseConfidence: 0.5,
          interval: { low: 0.35, high: 0.8 },
          reverseInterval: { low: 0.28, high: 0.72 },
          score: 0.35,
          overviewPriority: i === 1 ? 2 : 0,
          weighted: false,
          lastTogether: '2026-05-01',
          crossesDirectories: true,
          evidence: [],
        });
      }
      const data = makeBaseData({ nodes, edges, families: [] });
      const featured = selectFeaturedFinding(data);
      const plate = computeFeaturedPlateLayout(data, featured, { width: 760, height: 380 });

      assert.equal(plate.nodes.length, Math.min(12, nodeCount));
      assert.equal(plate.truncatedToEgoCap, nodeCount > 12);

      for (let i = 0; i < plate.nodes.length; i++) {
        const a = plate.nodes[i]!.label;
        for (let j = i + 1; j < plate.nodes.length; j++) {
          const b = plate.nodes[j]!.label;
          const overlaps =
            a.x < b.x + b.w &&
            a.x + a.w > b.x &&
            a.y < b.y + b.h &&
            a.y + a.h > b.y;
          assert.equal(
            overlaps,
            false,
            `Label collision in ${nodeCount}-node fixture between "${a.text}" (${JSON.stringify(a)}) and "${b.text}" (${JSON.stringify(b)})`,
          );
        }
      }
    }

    const ranked = buildRankedFindings(makeBaseData());
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0]?.findingId, 'F-01');
  });

  it('distinguishes weighted vs raw percentages, attributes reverse counterexamples to the reverse file, and adapts empty-state threshold suggestions', () => {
    const base = makeBaseData();
    const weightedEdge: MapEdge = {
      ...base.edges[0]!,
      shared: 5,
      fromChanges: 10,
      toChanges: 12,
      confidence: 0.72,
      reverseConfidence: 0.61,
      weighted: true,
      weighting: 'recency',
      counterexamples: {
        fromOnlyTotal: 5,
        toOnlyTotal: 7,
        fromOnly: [],
        toOnly: [],
      },
    };
    const weightedData = makeBaseData({ edges: [weightedEdge] });

    const metric = formatDirectionMetric('tiny.ts', 'quick.ts', 5, 10, 0.72, { low: 0.2366, high: 0.7634 }, true);
    assert.equal(metric.pctText, '72% weighted');
    assert.equal(metric.rawPctValue, 50);
    assert.equal(metric.detailText, 'Raw 5 of 10 commits (50%) · raw 95% range 24–76%');

    const pairCopy = formatPairHeadline(weightedData, weightedEdge);
    assert.ok(
      pairCopy.subhead.includes('72% weighted; 50% raw'),
      `expected weighted + raw rate in subhead, got: ${pairCopy.subhead}`,
    );

    const ranked = buildRankedFindings(weightedData);
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0]?.weighted, true);
    assert.equal(ranked[0]?.reverseCounterexampleLine, 'Changed alone: 7 times');

    // Dynamic empty-state threshold suggestions when current settings are already at or below 2 / 0.25
    const defaultEmpty = formatEmptyStateCopy(makeBaseData({ edges: [] }));
    assert.equal(
      defaultEmpty.looserCommand,
      'npx repo-archaeology map --style rich --min-shared 2 --min-confidence 0.2',
    );

    const alreadyLooseData = makeBaseData({
      edges: [],
      meta: {
        ...base.meta,
        settings: {
          ...base.meta.settings,
          minShared: 2,
          minConfidence: 0.25,
        },
      },
    });
    const looseEmpty = formatEmptyStateCopy(alreadyLooseData);
    assert.equal(
      looseEmpty.looserCommand,
      'npx repo-archaeology map --style rich --min-shared 1 --min-confidence 0.13',
    );
  });

  it('embeds complete multi-family, totalUnchecked, and collision-free plate payloads in production renderMapHtml', () => {
    const fam1: MapFamily = {
      id: 'src/adapter/*/serve-static',
      label: 'serve-static.ts across src/adapter/*',
      stem: 'serve-static',
      fileName: 'serve-static.ts',
      parentDir: 'src/adapter',
      why: '3 parallel implementations',
      members: [
        { path: 'src/adapter/bun/serve-static.ts', dir: 'src/adapter/bun', variant: 'bun', changes: 20, connections: 2 },
        { path: 'src/adapter/cloudflare-workers/serve-static.ts', dir: 'src/adapter/cloudflare-workers', variant: 'cloudflare-workers', changes: 27, connections: 2 },
        { path: 'src/adapter/deno/serve-static.ts', dir: 'src/adapter/deno', variant: 'deno', changes: 24, connections: 2 },
      ],
      commitsTouchingTwoOrMore: 16,
      commitsTouchingAll: 9,
      lastTogether: '2026-05-16',
      qualifyingPairs: 3,
      possiblePairs: 3,
      complete: true,
      relationshipKinds: ['ghost'],
      peakScore: 0.387,
      maxPairShared: 12,
      evidence: [],
      allMemberEvidence: [],
      nodeIndices: [2, 4, 3],
      edgeIndices: [0],
      overviewPriority: 2,
    };
    const fam2: MapFamily = {
      ...fam1,
      id: 'src/router/*/router',
      label: 'router.ts across src/router/*',
      stem: 'router',
      fileName: 'router.ts',
      parentDir: 'src/router',
      members: [
        { path: 'src/preset/tiny.ts', dir: 'src/preset', variant: 'tiny', changes: 8, connections: 1 },
        { path: 'src/preset/quick.ts', dir: 'src/preset', variant: 'quick', changes: 10, connections: 1 },
        { path: 'src/adapter/bun/serve-static.ts', dir: 'src/adapter/bun', variant: 'bun', changes: 20, connections: 1 },
      ],
      commitsTouchingTwoOrMore: 9,
      commitsTouchingAll: 5,
      lastTogether: '2026-04-01',
      peakScore: 0.31,
      overviewPriority: 1,
    };
    const base = makeBaseData();
    const unknownEdge: MapEdge = {
      ...base.edges[0]!,
      source: 2,
      target: 3,
      relationship: 'unknown',
      shared: 6,
      fromChanges: 20,
      toChanges: 24,
      confidence: 0.3,
      reverseConfidence: 0.25,
      overviewPriority: 1,
    };
    const multiData = makeBaseData({
      counts: { ghost: 1, unknown: 56, indirect: 0, direct: 0, test: 0 },
      edges: [base.edges[0]!, unknownEdge],
      families: [fam1, fam2],
    });

    const html = renderMapHtml(multiData, computeLayout(multiData, { style: 'rich' }), { style: 'rich' });
    const match = /<script type="application\/json" id="ra-briefing">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(match, 'expected #ra-briefing JSON script');
    const briefing = JSON.parse(match[1]!);

    // 1. totalUnchecked uses data.counts.unknown (56) while unknownCount is displayed unknown edges (1)
    assert.equal(briefing.stats.unknownCount, 1);
    assert.equal(briefing.stats.totalUnchecked, 56);

    // 2. Both families are precomputed with distinct headlines and findingIds
    assert.equal(briefing.families.length, 2);
    assert.equal(briefing.families[0].headline, '3 files across src/adapter/* keep changing together');
    assert.equal(briefing.families[1].headline, '3 files across src/router/* keep changing together');

    // 3. Unchecked edge is included in ranked findings so toggling Unchecked reveals it in Briefing mode
    assert.ok(
      briefing.ranked.some((r: { relationship: string }) => r.relationship === 'unknown'),
      'expected unknown relationship in briefing.ranked',
    );

    // 4. Featured plate has zero label-to-label or label-to-balloon collisions
    const plate = briefing.featured.plate;
    const bb = plate.balloonBox;
    for (let i = 0; i < plate.nodes.length; i++) {
      const a = plate.nodes[i].label;
      if (bb) {
        const hitsBalloon = a.x < bb.x + bb.w && a.x + a.w > bb.x && a.y < bb.y + bb.h && a.y + a.h > bb.y;
        assert.equal(hitsBalloon, false, `Label ${a.text} overlaps balloon`);
      }
      for (let j = i + 1; j < plate.nodes.length; j++) {
        const b = plate.nodes[j].label;
        const overlaps = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        assert.equal(overlaps, false, `Label ${a.text} overlaps ${b.text}`);
      }
    }
  });

  it('maintains a single canonical glossary aligned with codebase constants, worked finding explanations, and path-free provenance', () => {
    // 1. Glossary terms completeness & constant alignment
    assert.equal(GLOSSARY_TERMS.length, 12);
    const expectedIds = [
      'ghost-wire',
      'directional-cochange',
      'wilson-interval',
      'weighted-confidence',
      'file-family',
      'unchecked-link',
      'heuristic-import',
      'indirect-import',
      'direct-test-links',
      'counterexamples',
      'commit-origin',
      'verdicts',
    ] as const;
    for (const id of expectedIds) {
      const entry = getGlossaryEntry(id);
      assert.ok(entry.term.length > 0);
      assert.ok(entry.shortTitle.length > 3);
      assert.ok(entry.summary.length > 20);
      assert.ok(entry.detail.length > 30);
    }
    // Check alignment with DEFAULT_SETTINGS and RELATIONSHIPS
    const ghostEntry = getGlossaryEntry('ghost-wire');
    assert.ok(ghostEntry.detail.includes(String(DEFAULT_SETTINGS.minShared)));
    assert.ok(ghostEntry.detail.includes(String(Math.round(DEFAULT_SETTINGS.minConfidence * 100))));
    for (const rel of ['ghost', 'unknown', 'indirect', 'direct', 'test'] as const) {
      assert.ok(RELATIONSHIPS.includes(rel));
    }

    // 2. Worked finding guide (`formatReadingFindingGuide`): unweighted vs weighted, relationship kinds, verdict, family, sanitization
    const base = makeBaseData();
    const e0 = base.edges[0]!;
    const unweightedGuide = formatReadingFindingGuide({
      fromLabel: 'tiny.ts',
      toLabel: 'quick.ts',
      shared: 6,
      fromChanges: 8,
      toChanges: 10,
      confidence: 0.75,
      reverseConfidence: 0.6,
      interval: { low: 0.35, high: 0.97 },
      reverseInterval: e0.reverseInterval,
      relationship: e0.relationship,
    });
    assert.equal(unweightedGuide.heading, 'READING THIS FINDING · EXPLAIN THESE NUMBERS');
    assert.equal(unweightedGuide.whatItSaysLabel, 'What does 75% mean?');
    assert.ok(unweightedGuide.whatItSays.includes('Of the 8 analyzed commits that changed tiny.ts, 6 also changed quick.ts (75%, 95% Wilson confidence range 35–97%)'));
    assert.ok(unweightedGuide.whatItDoesNotSay.includes('does not establish a 75% probability of a bug'));
    assert.ok(unweightedGuide.whatToInspect.includes('6 shared commit receipts'));
    assert.ok(unweightedGuide.whatToInspect.includes('6 counterexample commits'));

    const weightedGuide = formatReadingFindingGuide({
      fromLabel: 'tiny.ts',
      toLabel: 'quick.ts',
      shared: 6,
      fromChanges: 8,
      toChanges: 10,
      confidence: 0.84,
      reverseConfidence: 0.6,
      interval: { low: 0.35, high: 0.97 },
      reverseInterval: e0.reverseInterval,
      relationship: 'ghost',
      weighted: true,
      weighting: 'recency+origin',
      verdict: {
        kind: 'expected',
        reason: 'Intentional preset parity\u202e',
      },
      isFamily: true,
      familyMemberCount: 3,
      familyQualifyingPairs: 3,
      familyPossiblePairs: 3,
    });
    assert.equal(weightedGuide.whatItSaysLabel, 'What does 84% weighted (75% raw) mean?');
    assert.ok(weightedGuide.whatItSays.includes('Across this 3-file family (3 of 3 pairs qualifying)'));
    assert.ok(weightedGuide.whatItSays.includes('recency+origin-weighted scoring active'));
    assert.ok(weightedGuide.whatItSays.includes('75% raw ratio; unweighted 95% Wilson range 35–97%'));
    assert.ok(weightedGuide.whatItDoesNotSay.includes('Recorded verdict (expected / silenced relationship): "Intentional preset parity'));
    assert.equal(weightedGuide.whatItDoesNotSay.includes('\u202e'), false);

    const unknownGuide = formatReadingFindingGuide({
      fromLabel: 'tiny.ts',
      toLabel: 'quick.ts',
      shared: e0.shared,
      fromChanges: e0.fromChanges,
      toChanges: e0.toChanges,
      confidence: e0.confidence,
      reverseConfidence: e0.reverseConfidence,
      interval: e0.interval,
      reverseInterval: e0.reverseInterval,
      relationship: 'unknown',
    });
    assert.ok(unknownGuide.whatItDoesNotSay.includes('Static import analysis could not verify'));

    // 3. Provenance (`buildAnalysisProvenance`) & path redaction (`redactFilesystemPaths`)
    const provenanceData = makeBaseData({
      meta: {
        ...base.meta,
        root: '/Users/alice/private-corp/secret-monorepo',
        head: { ref: 'main', sha: '14e0ee2abcdef1234567890' },
        imports: {
          scope: 'analyzed-files',
          filesScanned: 42,
          internalEdges: 88,
          external: 15,
          unresolved: 3,
          dynamicLoads: 1,
          unsupportedFiles: 4,
          sourceUnavailable: 0,
          heuristicEdges: 5,
          unresolvedByReason: { 'alias-unmatched': 3 },
        },
        warnings: [
          'Skipped unreadable config at /Users/alice/private-corp/secret-monorepo/tsconfig.json',
          'Temp path C:\\Users\\alice\\AppData\\Local\\Temp\\repo issue',
        ],
      },
    });
    const prov = buildAnalysisProvenance(provenanceData, '0.4.0');
    const serializedProv = JSON.stringify(prov);
    assert.equal(
      serializedProv.includes('/Users/alice'),
      false,
      'Provenance must never leak local absolute filesystem paths',
    );
    assert.equal(
      serializedProv.includes('C:\\Users\\alice'),
      false,
      'Provenance must redact Windows filesystem paths in warnings',
    );
    assert.ok(serializedProv.includes('main @ 14e0ee2abcde'));
    assert.ok(serializedProv.includes('5 heuristic'));
    assert.ok(serializedProv.includes('3 unresolved specifiers'));
    assert.ok(prov.footerText.includes('Repo Archaeology v0.4.0'));
    assert.equal(redactFilesystemPaths('Failed at /var/folders/99/abc/T/repo'), 'Failed at <repo-path>');
  });
});
