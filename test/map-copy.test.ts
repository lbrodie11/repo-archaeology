import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { MapData, MapEdge, MapFamily, MapNode } from '../src/commands/map.js';
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
      'No import connects them. 8 of 8 commits that changed tiny.ts also changed quick.ts.',
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
      'No import connects them. 8 of 9 commits that changed quick.ts also changed tiny.ts.',
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

  it('disambiguates colliding basenames and middle-truncates long paths with …', () => {
    const [a, b] = disambiguatePairPaths(
      'src/adapter/bun/serve-static.ts',
      'src/adapter/deno/serve-static.ts',
    );
    assert.equal(a, 'bun/serve-static.ts');
    assert.equal(b, 'deno/serve-static.ts');

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
      'No import connects these 3 parallel implementations of serve-static.ts. All 3 pairwise links passed thresholds across 16 supporting commits (9 touched all 3).',
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

    assert.equal(formatBalloonCallout(data, edge), '8 of 8 commits together · no import');
    assert.equal(formatCounterexamplesLine(0), 'Changed alone: 0 times');
    assert.equal(formatCounterexamplesLine(1), 'Changed alone: 1 time');
    assert.equal(formatCounterexamplesLine(5), 'Changed alone: 5 times');

    const metric = formatDirectionMetric('tiny.ts', 'quick.ts', 8, 8, 1, { low: 0.6756, high: 1 });
    assert.equal(metric.pctText, '100%');
    assert.equal(metric.detailText, '8 of 8 commits · 95% range 68–100%');

    assert.equal(
      formatOwnerNote(data.nodes[0]!, 'tiny.ts'),
      'Usually changed by Alice (75% of tiny.ts)',
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
    assert.equal(panel.receiptsTotal, 4);
    assert.equal(panel.receiptsOverflowCount, 1);
    assert.equal(panel.howToReadSummary, HOW_TO_READ_SUMMARY);
    assert.equal(
      panel.explainCommand,
      'npx repo-archaeology explain src/preset/tiny.ts src/preset/quick.ts',
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

  it('encodes and resolves #f=<sourcePath>..<targetPath> hashes safely and ignores invalid or tampered hashes', () => {
    const data = makeBaseData();
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
    assert.equal(ranked[0]?.cutLabel, 'C-01');
  });

  it('verifies Hono design concepts trace every number to docs/design/ra-17/hono.mapdata.json with zero label overlaps', () => {
    const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const ra17Dir = join(rootDir, 'docs', 'design', 'ra-17');
    const mapDataPath = join(ra17Dir, 'hono.mapdata.json');
    assert.ok(existsSync(mapDataPath), 'expected hono.mapdata.json to exist');

    const honoData = JSON.parse(readFileSync(mapDataPath, 'utf8')) as MapData;
    const featured = selectFeaturedFinding(honoData);
    assert.equal(featured.kind, 'family');
    if (featured.kind !== 'family') return;

    const evCopy = formatEvidencePanelCopy(honoData, featured, 'C-01');
    const plate = computeFeaturedPlateLayout(honoData, featured, { width: 760, height: 274 });
    assert.equal(plate.nodes.length, 6);

    for (let i = 0; i < plate.nodes.length; i++) {
      const a = plate.nodes[i]!.label;
      for (let j = i + 1; j < plate.nodes.length; j++) {
        const b = plate.nodes[j]!.label;
        const overlaps =
          a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        assert.equal(overlaps, false, `Hono plate label overlap between ${a.text} and ${b.text}`);
      }
    }

    for (const htmlFile of ['concept-a.html', 'concept-b.html']) {
      const html = readFileSync(join(ra17Dir, htmlFile), 'utf8');
      assert.ok(html.includes(evCopy.headline));
      assert.ok(html.includes(evCopy.subhead));
      assert.ok(html.includes(evCopy.primaryDirection.pctText));
      assert.ok(html.includes(evCopy.reverseDirection.pctText));
      assert.ok(html.includes(honoData.meta.commitsAnalyzed.toLocaleString('en-US')));
      for (const r of evCopy.receiptsShown) {
        assert.ok(html.includes(r.hash.slice(0, 7)), `expected commit hash ${r.hash.slice(0, 7)} in ${htmlFile}`);
      }
    }
  });

  it('verifies Concept A, Concept B, and Empty State meet first-viewport, >=11px font-size, zero horizontal scroll, and marker budget in Chromium', async (t) => {
    let chromium: typeof import('playwright').chromium | undefined;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      t.skip('Playwright not installed');
      return;
    }

    let browser: import('playwright').Browser | undefined;
    try {
      browser = await chromium.launch();
    } catch {
      t.skip('Playwright Chromium browser binary not available');
      return;
    }

    const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const ra17Dir = join(rootDir, 'docs', 'design', 'ra-17');

    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();

      for (const file of ['concept-a.html', 'concept-b.html']) {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(pathToFileURL(join(ra17Dir, file)).href, { waitUntil: 'load' });
        await page.evaluate(() => document.fonts && document.fonts.ready);

        const audit = await page.evaluate(() => {
          const headline = document.querySelector('.f12-headline')?.getBoundingClientRect();
          const dirCards = Array.from(document.querySelectorAll('.f12-dir-card')).map((el) =>
            el.getBoundingClientRect(),
          );
          const plate = document.getElementById('featured-plate-canvas')?.getBoundingClientRect();
          const balloon = document.querySelector('.f12-balloon')?.getBoundingClientRect();
          const firstReceipt = document.querySelector('.f12-receipt-item')?.getBoundingClientRect();
          const horizOverflow = document.documentElement.scrollWidth > window.innerWidth;

          let minFontSize = Infinity;
          let minFontSelector = '';
          let markerTextColorUsed = false;
          let markerBgCount = 0;

          const all = Array.from(document.querySelectorAll('body *'));
          for (const el of all) {
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const fs = parseFloat(style.fontSize);
            if (el.textContent && el.textContent.trim().length > 0 && fs < minFontSize) {
              minFontSize = fs;
              minFontSelector = `${el.tagName.toLowerCase()}.${el.className}`;
            }
            if (style.color === 'rgb(255, 214, 10)') {
              markerTextColorUsed = true;
            }
            if (style.backgroundColor === 'rgb(255, 214, 10)') {
              markerBgCount += 1;
            }
          }

          return {
            headlineBottom: headline?.bottom ?? 9999,
            dirCardsCountInView: dirCards.filter((r) => r.bottom <= 900).length,
            plateBottom: plate?.bottom ?? 9999,
            balloonBottom: balloon?.bottom ?? 9999,
            firstReceiptBottom: firstReceipt?.bottom ?? 9999,
            horizOverflow,
            minFontSize,
            minFontSelector,
            markerTextColorUsed,
            markerBgCount,
          };
        });

        assert.ok(audit.headlineBottom <= 900, `${file}: headline bottom ${audit.headlineBottom} > 900`);
        assert.ok(audit.dirCardsCountInView >= 2, `${file}: expected >=2 directional metrics in first viewport`);
        assert.ok(audit.plateBottom <= 900, `${file}: plate bottom ${audit.plateBottom} > 900`);
        assert.ok(audit.balloonBottom <= 900, `${file}: balloon bottom ${audit.balloonBottom} > 900`);
        assert.ok(audit.firstReceiptBottom <= 900, `${file}: first receipt bottom ${audit.firstReceiptBottom} > 900`);
        assert.equal(audit.horizOverflow, false, `${file}: unexpected horizontal overflow at 1440x900`);
        assert.ok(
          audit.minFontSize >= 11,
          `${file}: found font-size ${audit.minFontSize}px on ${audit.minFontSelector} (< 11px)`,
        );
        assert.equal(audit.markerTextColorUsed, false, `${file}: marker yellow used as text color`);
        // Only masthead status chip + C-01 kicker chip have marker yellow background
        assert.equal(audit.markerBgCount, 2, `${file}: expected 2 marker-yellow chips (masthead + C-01), got ${audit.markerBgCount}`);

        // Check mobile 390x844 and 200% zoom (720x450) for zero horizontal overflow
        for (const vp of [
          { width: 390, height: 844 },
          { width: 720, height: 450 },
        ]) {
          await page.setViewportSize(vp);
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth,
          );
          assert.equal(
            overflow,
            false,
            `${file}: unexpected horizontal overflow at ${vp.width}x${vp.height}`,
          );
        }
      }

      await context.close();
    } finally {
      await browser.close();
    }
  });
});
