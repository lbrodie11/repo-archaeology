import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, it } from 'node:test';
import {
  isPlateLayoutBundleCurrent,
  PLATE_LAYOUT_BUNDLE,
  PLATE_LAYOUT_SOURCE,
} from '../scripts/build-plate-layout.mjs';
import type { MapData } from '../src/commands/map.js';
import { computeFeaturedPlateLayout, selectFeaturedFinding } from '../src/map/copy.js';
import { computeRichLayout } from '../src/map/layout.js';
import { computePlateLayout, type PlateFocus, type PlateOptions } from '../src/map/plate-layout.js';
import { PLATE_LAYOUT_BROWSER_JS } from '../src/map/plate-layout.browser.js';
import { renderMapHtml } from '../src/map/template.js';
import { generateSyntheticMapData } from './fixtures/map-synthetic.js';

/** Runs the inlined browser bundle in an isolated context with no Node globals, as a page would. */
function loadBrowserEngine(): { computePlateLayout: typeof computePlateLayout } {
  const context = createContext({});
  runInContext(PLATE_LAYOUT_BROWSER_JS, context);
  return (context as { RAPlateLayout: { computePlateLayout: typeof computePlateLayout } }).RAPlateLayout;
}

describe('shared plate layout engine: one implementation, two environments', () => {
  it('ships a browser bundle generated from the current engine source', () => {
    assert.equal(
      isPlateLayoutBundleCurrent(),
      true,
      'src/map/plate-layout.browser.ts is stale; run `npm run build:plate-layout`',
    );
    assert.doesNotMatch(PLATE_LAYOUT_BROWSER_JS, /<\/script|\brequire\(|\bimport\s*\(|\beval\(|new Function/);
  });

  it('treats a CRLF checkout (Windows core.autocrlf) of a current bundle as current, and an edited engine as stale', () => {
    const root = join(import.meta.dirname, '..');
    const dir = mkdtempSync(join(tmpdir(), 'ra-plate-bundle-'));
    try {
      mkdirSync(join(dir, 'src', 'map'), { recursive: true });
      const crlf = (text: string) => text.replace(/\r?\n/g, '\r\n');
      const source = readFileSync(join(root, PLATE_LAYOUT_SOURCE), 'utf8');
      writeFileSync(join(dir, PLATE_LAYOUT_SOURCE), crlf(source));
      writeFileSync(join(dir, PLATE_LAYOUT_BUNDLE), crlf(readFileSync(join(root, PLATE_LAYOUT_BUNDLE), 'utf8')));
      assert.equal(isPlateLayoutBundleCurrent(dir), true);
      writeFileSync(join(dir, PLATE_LAYOUT_SOURCE), source.replace('labelOverlap: 10000', 'labelOverlap: 9999'));
      assert.equal(isPlateLayoutBundleCurrent(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('produces identical geometry in the browser bundle and on the server for every plate', () => {
    const browser = loadBrowserEngine();
    const data: MapData = generateSyntheticMapData(80, { repoName: 'plate-parity' });
    const focuses: PlateFocus[] = data.edges.map((e, i) => ({ seeds: [e.source, e.target], leadEdge: i, featuredEdges: [i] }));
    for (const fam of data.families ?? []) {
      focuses.push({ seeds: fam.nodeIndices, leadEdge: fam.edgeIndices[0] ?? null, featuredEdges: fam.edgeIndices });
    }
    focuses.push({ seeds: [0, 1, 2, 3, 4], leadEdge: null, featuredEdges: [] });
    const optionSets: PlateOptions[] = [
      { mode: 'desktop' },
      { mode: 'compact' },
      { mode: 'compact', width: 412 },
      { mode: 'desktop', width: 600 },
      { mode: 'desktop', visible: { ghost: true, direct: true, indirect: false, unknown: false, test: false } },
      { mode: 'desktop', previous: [{ nodeIndex: 3, x: 50 }, { nodeIndex: 7, x: 700 }] },
    ];
    let compared = 0;
    for (const focus of focuses) {
      for (const options of optionSets) {
        const server = JSON.stringify(computePlateLayout(data, focus, options));
        const inPage = JSON.stringify(browser.computePlateLayout(data, focus, options));
        assert.equal(inPage, server, `Parity mismatch for ${JSON.stringify(focus)} ${JSON.stringify(options)}`);
        compared++;
      }
    }
    assert.ok(compared > 100, `Expected a broad parity sweep, compared ${compared}`);
  });

  it('builds the report plate through the shared engine and inlines it exactly once in rich maps', () => {
    const data: MapData = generateSyntheticMapData(40, { repoName: 'plate-inline' });
    const featured = selectFeaturedFinding(data);
    const plate = computeFeaturedPlateLayout(data, featured, { width: 760 });
    const browser = loadBrowserEngine();
    const leadEdge = featured.kind === 'family' ? featured.leadEdgeIndex : featured.kind === 'pair' ? featured.edgeIndex : null;
    assert.notEqual(leadEdge, null);
    assert.ok(plate.nodes.length >= 2);
    assert.equal(plate.mode, 'desktop');

    const rich = renderMapHtml(data, computeRichLayout(data), { style: 'rich' });
    const scripts = Array.from(rich.matchAll(/<script>([\s\S]*?)<\/script>/g)).map((m) => m[1]!);
    assert.equal(scripts.filter((s) => s === PLATE_LAYOUT_BROWSER_JS).length, 1);
    assert.ok(scripts.indexOf(PLATE_LAYOUT_BROWSER_JS) < scripts.length - 1, 'engine loads before the client that calls it');
    assert.ok(browser.computePlateLayout(data, { seeds: [0, 1], leadEdge: 0, featuredEdges: [0] }).nodes.length >= 2);

    const classic = renderMapHtml(data, computeRichLayout(data), { style: 'classic' });
    assert.equal(classic.includes('RAPlateLayout'), false, 'classic maps do not need the plate engine');
  });
});
