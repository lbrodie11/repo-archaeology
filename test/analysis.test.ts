import assert from 'node:assert/strict';
import { readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { getOrBuildImportGraphIndex, importGraph } from '../src/commands/imports.js';
import { loadContext } from '../src/context.js';
import { AnalysisSession, analyzeFile, isAnalyzablePath, LANGUAGE_ANALYZERS, setDefaultEdgeBudgetForTesting, type FileAnalysis } from '../src/imports/analysis.js';
import type { RepoFiles } from '../src/imports/resolve.js';
import { buildAppFixture, buildWorkspaceFixture } from './fixtures/import-fixtures.js';
import { FixtureRepo } from './helpers.js';

function memoryFiles(files: Record<string, string>): RepoFiles {
  return {
    exists: (path) => Object.hasOwn(files, path),
    read: (path) => (Object.hasOwn(files, path) ? files[path] : undefined),
    list: () => Object.keys(files),
  };
}

describe('shared import analysis pipeline', () => {
  it('registers TS/JS, Go and Python behind the LanguageAnalyzer registry', () => {
    assert.deepEqual(
      LANGUAGE_ANALYZERS.map((analyzer) => analyzer.id),
      ['typescript', 'go', 'python'],
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

describe('classifier and import graph agree (Go and Python)', () => {
  /** Go and Python files covering incomplete input, symlinks, package fan-out and initializers. */
  function buildPolyglotFixture(): { repo: FixtureRepo; oldSha: string } {
    const repo = new FixtureRepo();
    const write: Record<string, string> = {
      'go.mod': 'module example.com/app\n',
      'cmd/main.go': 'package main\nimport (\n\t"fmt"\n\t"example.com/app/big"\n\t"example.com/app/mixed"\n\t"example.com/app/store"\n)\n',
      'store/store.go': 'package store\nimport "example.com/app/model"\n',
      'store/cache.go': 'package store\n',
      'store/gen.go': '//go:build ignore\n\npackage main\nimport "example.com/app/model"\n',
      'model/model.go': 'package model\n',
      'mixed/a.go': 'package mixed\n',
      'mixed/b.go': 'package other\n',
      'broken/broken.go': 'package broken\nimport (\n\t"fmt"\n\tnot valid\n)\n',
      'linkuser/use.go': 'package linkuser\nimport "example.com/app/linked"\n',
      'src/shop/__init__.py': 'from . import pricing\ncart = None\n',
      'src/shop/pricing.py': 'RATE = 1\n',
      'src/shop/cart.py': 'from shop import pricing\nimport shop.tax\nimport requests\n',
      'src/shop/tax.py': '',
      'src/shop/ambiguous.py': 'from shop import cart\n',
      'src/shop/loader.py': 'import importlib as il\nil.import_module("shop.tax")\nvalue = f"{__import__(\'shop.cart\')}"\n',
      'src/shop/computed.py': 'from importlib import import_module as load\nload(name)\n',
      'src/shop/broken.py': 'x = """never closed\n',
    };
    for (let n = 0; n < 210; n++) write[`big/f${String(n).padStart(3, '0')}.go`] = 'package big\n';
    repo.commit({ message: 'old', write: { ...write, 'src/shop/cart.py': 'import shop.tax\n' } });
    const oldSha = repo.git('rev-parse', 'HEAD').trim();
    for (const [path, content] of Object.entries(write)) repo.write(path, content);
    symlinkSync(join(repo.dir, 'model'), join(repo.dir, 'linked'));
    symlinkSync(join(repo.dir, 'src', 'shop', 'tax.py'), join(repo.dir, 'src', 'shop', 'tax_alias.py'));
    repo.git('add', '.');
    repo.commit({ message: 'new' });
    return { repo, oldSha };
  }

  const summary = (analysis: FileAnalysis | undefined) =>
    analysis && {
      language: analysis.language,
      analyzable: analysis.analyzable,
      sourceUnavailable: analysis.sourceUnavailable,
      incomplete: analysis.incomplete,
      incompleteReason: analysis.incompleteReason,
      edges: analysis.edges,
      external: analysis.external,
      unresolved: analysis.unresolved,
      dynamicLoads: analysis.dynamicLoads,
      warnings: analysis.warnings,
    };

  /** Analyzes every candidate in sorted order (the graph's order) with both consumers and compares. */
  async function assertParity(repo: FixtureRepo, head?: string): Promise<{ incomplete: string[]; edges: number }> {
    const ctx = await loadContext(repo.dir, { cache: false } as never, { silent: true, ...(head ? { head } : {}) });
    try {
      ctx.open?.();
      const files = [...ctx.currentFiles].filter((file) => isAnalyzablePath(file)).sort();
      const classifier = files.map((file) => ctx.classifier.analyze(file).analysis);
      const index = getOrBuildImportGraphIndex(ctx);
      const incomplete: string[] = [];
      let edges = 0;
      files.forEach((file, n) => {
        assert.deepEqual(summary(classifier[n]), summary(index.analysisOf(file) ?? classifier[n]), `analysis of ${file}`);
        const graphEdges = (index.edgesByFrom.get(file) ?? []).map((edge) => edge.to);
        const info = ctx.classifier.analyze(file);
        assert.deepEqual([...new Set(graphEdges)].sort(), [...info.imports, ...info.references].sort(), `edges from ${file}`);
        if (classifier[n]!.incomplete) incomplete.push(file);
        edges += graphEdges.length;
      });
      return { incomplete, edges };
    } finally {
      ctx.close?.();
    }
  }

  let fixture: { repo: FixtureRepo; oldSha: string };
  before(() => {
    fixture = buildPolyglotFixture();
  });
  after(() => {
    setDefaultEdgeBudgetForTesting(undefined);
    fixture.repo.cleanup();
  });

  it('agree on every Go and Python file: incomplete input, symlinks, fan-out, initializers', async () => {
    const { incomplete } = await assertParity(fixture.repo);
    assert.deepEqual(incomplete, [
      'broken/broken.go',
      'cmd/main.go',
      'linkuser/use.go',
      'src/shop/ambiguous.py',
      'src/shop/broken.py',
      'src/shop/computed.py',
    ]);
  });

  it('agree at an older revision (--head)', async () => {
    await assertParity(fixture.repo, fixture.oldSha);
  });

  it('agree when the session edge budget runs out (same analysis order)', async () => {
    setDefaultEdgeBudgetForTesting(150);
    try {
      const { incomplete, edges } = await assertParity(fixture.repo);
      assert.equal(edges, 150);
      assert.ok(incomplete.includes('store/store.go'), 'files past the budget are incomplete');
    } finally {
      setDefaultEdgeBudgetForTesting(undefined);
    }
  });
});
