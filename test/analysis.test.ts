import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { importGraph } from '../src/commands/imports.js';
import { loadContext } from '../src/context.js';
import { AnalysisSession, analyzeFile, isAnalyzablePath, LANGUAGE_ANALYZERS } from '../src/imports/analysis.js';
import type { RepoFiles } from '../src/imports/resolve.js';
import { buildAppFixture, buildWorkspaceFixture } from './fixtures/import-fixtures.js';
import type { FixtureRepo } from './helpers.js';

function memoryFiles(files: Record<string, string>): RepoFiles {
  return {
    exists: (path) => Object.hasOwn(files, path),
    read: (path) => (Object.hasOwn(files, path) ? files[path] : undefined),
    list: () => Object.keys(files),
  };
}

describe('shared import analysis pipeline', () => {
  it('registers TS/JS behind the LanguageAnalyzer registry', () => {
    assert.deepEqual(
      LANGUAGE_ANALYZERS.map((analyzer) => analyzer.id),
      ['typescript'],
    );
    for (const path of ['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs']) assert.ok(isAnalyzablePath(path), path);
    for (const path of ['a.md', 'a.json', 'a.css']) assert.ok(!isAnalyzablePath(path), path);
  });

  it('summarizes one file: edges with targets, external, unresolved and dynamic loads', () => {
    const files = memoryFiles({
      'src/a.ts': "/// <reference path=\"./types.d.ts\" />\nimport { b } from './b';\nimport './b';\nimport x from 'react';\nimport './missing';\nexport const load = (n: string) => import(n);\n",
      'src/b.ts': 'export const b = 1;\n',
      'src/types.d.ts': 'declare const X: number;\n',
    });
    const session = new AnalysisSession(files);
    const analysis = analyzeFile('src/a.ts', files, session);
    assert.equal(analysis.language, 'typescript');
    assert.equal(analysis.analyzable, true);
    assert.equal(analysis.incomplete, true);
    assert.equal(analysis.external, 1);
    assert.equal(analysis.dynamicLoads, 1);
    assert.deepEqual(analysis.unresolved, [{ specifier: './missing', reasonCode: 'target-missing' }]);
    // The duplicate `./b` import with the same kind is deduplicated by (to, specifier, kind).
    assert.deepEqual(analysis.edges, [
      { specifier: './b', kind: 'static', targets: [{ path: 'src/b.ts', via: 'relative' }] },
      { specifier: './types.d.ts', kind: 'static', targets: [{ path: 'src/types.d.ts', via: 'relative' }], reference: true },
    ]);
  });

  it('reports unreadable sources and unsupported types without guessing', () => {
    const files = memoryFiles({});
    const session = new AnalysisSession(files);
    const missing = analyzeFile('src/gone.ts', files, session);
    assert.equal(missing.sourceUnavailable, true);
    assert.equal(missing.analyzable, false);
    const css = analyzeFile('styles/main.css', files, session);
    assert.equal(css.analyzable, false);
    assert.equal(css.sourceUnavailable, false);
    assert.equal(css.language, undefined);
  });

  it('neither the classifier nor the import graph calls a language extractor directly', () => {
    for (const file of ['src/imports/classify.ts', 'src/commands/imports.ts']) {
      const text = readFileSync(join(import.meta.dirname, '..', file), 'utf8');
      assert.doesNotMatch(text, /extractDetailedDependencies|extractDependencies|new ImportResolver/, file);
      assert.match(text, /analyzeFile\(/, file);
    }
  });
});

describe('classifier and import graph agree (every TS/JS fixture file)', () => {
  let fixtures: FixtureRepo[];
  before(() => {
    fixtures = [buildAppFixture(), buildWorkspaceFixture()];
  });
  after(() => {
    for (const fixture of fixtures) fixture.cleanup();
  });

  it('produces the same edge set, unresolved specifiers and external counts', async () => {
    for (const fixture of fixtures) {
      const ctx = await loadContext(fixture.dir, { cache: false } as never, { silent: true });
      try {
        const graph = importGraph(ctx);
        assert.ok(graph.files.length > 5);
        for (const file of graph.files) {
          const info = ctx.classifier.analyze(file);
          const classifierEdges = [...info.imports, ...info.references].sort();
          const graphEdges = [...new Set(graph.edges.filter((edge) => edge.from === file).map((edge) => edge.to))].sort();
          assert.deepEqual(classifierEdges, graphEdges, `edges from ${file}`);
          const graphUnresolved = graph.unresolved.filter((item) => item.from === file).map((item) => `${item.specifier}:${item.reasonCode}`).sort();
          const classifierUnresolved = info.analysis.unresolved.map((item) => `${item.specifier}:${item.reasonCode}`).sort();
          assert.deepEqual(classifierUnresolved, graphUnresolved, `unresolved from ${file}`);
          const edgeCount = graph.edges.filter((edge) => edge.from === file).length;
          assert.equal(info.internalEdges, edgeCount, `edge count from ${file}`);
        }
      } finally {
        ctx.close?.();
      }
    }
  });
});
