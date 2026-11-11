import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { importGraph } from '../src/commands/imports.js';
import { loadContext } from '../src/context.js';
import { AnalysisSession, analyzeFile, type FileAnalysis } from '../src/imports/analysis.js';
import { buildGoIndex, extractGoImports, goPathWithin, MAX_GO_PACKAGE_FAN_OUT, parseGoModFile } from '../src/imports/go.js';
import type { RepoFiles } from '../src/imports/resolve.js';
import { FixtureRepo, memoryFiles } from './helpers.js';


function analyze(files: Record<string, string>, path: string): { analysis: FileAnalysis; session: AnalysisSession } {
  const repo = memoryFiles(files);
  const session = new AnalysisSession(repo);
  return { analysis: analyzeFile(path, repo, session), session };
}

const targetsOf = (analysis: FileAnalysis) => analysis.edges.flatMap((edge) => edge.targets.map((target) => target.path)).sort();

async function withRepo<T>(files: Record<string, string>, run: (repo: FixtureRepo) => Promise<T>): Promise<T> {
  const repo = new FixtureRepo();
  try {
    repo.commit({ message: 'initial', write: files });
    return await run(repo);
  } finally {
    repo.cleanup();
  }
}

describe('Go import extraction', () => {
  it('reads single, grouped, aliased and multiple import blocks', () => {
    const parsed = extractGoImports(`// Package app.
//go:build linux
package app

import "fmt"
import (
\tstr "strings"
\t_ "embed"
\t. "math"
\t"example.com/app/db"; "example.com/app/api"
)
import /* inline */ alias \`example.com/app/raw\`

func main() {}
`);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.packageName, 'app');
    assert.deepEqual(parsed.imports, [
      { path: 'fmt' },
      { path: 'strings', name: 'str' },
      { path: 'embed', name: '_' },
      { path: 'math', name: '.' },
      { path: 'example.com/app/db' },
      { path: 'example.com/app/api' },
      { path: 'example.com/app/raw', name: 'alias' },
    ]);
  });

  it('ignores import-looking text in comments, raw strings and code after the imports', () => {
    const parsed = extractGoImports(`package app
// import "fake/comment"
/* import "fake/block" */
import "real/one"
var x = \`
import "fake/raw"
\`
import "fake/after-declaration"
`);
    assert.deepEqual(parsed.imports, [{ path: 'real/one' }]);
    assert.equal(parsed.error, undefined);
  });

  it('decodes escapes in interpreted strings', () => {
    assert.deepEqual(extractGoImports('package a\nimport "ex\\x61mple.com/\\u0062"\n').imports, [{ path: 'example.com/b' }]);
  });

  it('reports malformed headers instead of guessing', () => {
    for (const source of [
      'package a\nimport (\n\t"fmt"\n\tfoo bar\n)\n',
      'package a\nimport (\n\t"fmt"\n',
      'package a\nimport "unterminated\n',
      'package a\n/* never closed\nimport "x"\n',
      'import "fmt"\n',
      'package a\nimport ("x" "y")\n',
    ]) {
      const parsed = extractGoImports(source);
      if (source.includes('("x" "y")')) {
        assert.equal(parsed.error, undefined, 'two specs in one group are valid');
        continue;
      }
      assert.ok(parsed.error, `expected an error for ${JSON.stringify(source)}`);
    }
  });

  it('parses go.mod and go.work directives', () => {
    const mod = parseGoModFile(`module example.com/app // comment

go 1.22

require (
\tgithub.com/x/y v1.0.0
)

replace example.com/lib => ./lib
replace (
\texample.com/tool v1.2.3 => ../tool
\texample.com/remote => example.com/fork v1.0.0
)
`);
    assert.equal(mod.error, undefined);
    assert.equal(mod.module, 'example.com/app');
    assert.deepEqual(mod.replaces, [
      { from: 'example.com/lib', to: './lib' },
      { from: 'example.com/tool', to: '../tool' },
      { from: 'example.com/remote', to: 'example.com/fork' },
    ]);
    assert.deepEqual(parseGoModFile('go 1.22\nuse (\n\t./a\n\t./b\n)\nuse ./c\n').uses, ['./a', './b', './c']);
    assert.ok(parseGoModFile('module a\nreplace (\n').error);
  });

  it('matches module paths on complete segments only', () => {
    assert.ok(goPathWithin('example.com/app', 'example.com/app'));
    assert.ok(goPathWithin('example.com/app/db', 'example.com/app'));
    assert.ok(!goPathWithin('example.com/application', 'example.com/app'));
    assert.ok(!goPathWithin('example.com/application/db', 'example.com/app'));
  });
});

describe('Go import resolution', () => {
  const base = {
    'go.mod': 'module example.com/app\n',
    'db/db.go': 'package db\n',
    'db/conn.go': 'package db\n',
    'db/db_test.go': 'package db\n',
    'db/gen.go': '//go:build ignore\n\npackage main\n',
    'db/linux.go': '//go:build linux\n\npackage db\n',
    'db/db_windows.go': 'package db\n',
  };

  it('resolves an import to the non-test files of the package (package-level edge)', () => {
    const { analysis } = analyze({ ...base, 'cmd/main.go': 'package main\nimport (\n\t"fmt"\n\t"example.com/app/db"\n)\n' }, 'cmd/main.go');
    assert.equal(analysis.language, 'go');
    assert.equal(analysis.incomplete, false);
    assert.equal(analysis.external, 1);
    assert.deepEqual(analysis.edges, [
      {
        specifier: 'example.com/app/db',
        kind: 'static',
        targets: [
          // Build-tagged and _os-suffixed files are included (a conservative union);
          // _test.go and a different package clause (the ignore-tagged generator) are not.
          { path: 'db/conn.go', via: 'go-package', role: 'module' },
          { path: 'db/db.go', via: 'go-package', role: 'module' },
          { path: 'db/db_windows.go', via: 'go-package', role: 'module' },
          { path: 'db/linux.go', via: 'go-package', role: 'module' },
        ],
      },
    ]);
  });

  it('never matches example.com/app against example.com/application', () => {
    const files = {
      'go.mod': 'module example.com/app\n',
      'x/x.go': 'package x\n',
      'main.go': 'package main\nimport "example.com/application/x"\n',
    };
    const { analysis } = analyze(files, 'main.go');
    assert.deepEqual(analysis.edges, []);
    assert.equal(analysis.external, 1);
    assert.equal(analysis.incomplete, false);
  });

  it('treats a cross-module import without replace/go.work as external, with a warning', () => {
    const files = {
      'go.mod': 'module example.com/app\n',
      'main.go': 'package main\nimport "example.com/lib/util"\n',
      'lib/go.mod': 'module example.com/lib\n',
      'lib/util/util.go': 'package util\n',
    };
    const { analysis, session } = analyze(files, 'main.go');
    assert.deepEqual(analysis.edges, []);
    assert.equal(analysis.external, 1);
    assert.equal(analysis.incomplete, false);
    assert.deepEqual(analysis.warnings, ['Go: imports in-repo module example.com/lib without a local replace/go.work (resolved as an external dependency).']);
    assert.deepEqual(session.indexWarnings(), []);
  });

  it('a nested module directory under the importing module is a different module', () => {
    const files = {
      'go.mod': 'module example.com/app\n',
      'main.go': 'package main\nimport "example.com/app/tools/gen"\n',
      'tools/go.mod': 'module example.com/app/tools\n',
      'tools/gen/gen.go': 'package gen\n',
    };
    const { analysis } = analyze(files, 'main.go');
    assert.deepEqual(analysis.edges, []);
    assert.equal(analysis.external, 1);
    assert.match(analysis.warnings?.[0] ?? '', /in-repo module example\.com\/app\/tools/);
  });

  it('resolves a cross-module import through a local replace or go.work', () => {
    const lib = { 'lib/go.mod': 'module example.com/lib\n', 'lib/util/util.go': 'package util\n' };
    const viaReplace = analyze(
      { ...lib, 'go.mod': 'module example.com/app\nreplace example.com/lib => ./lib\n', 'main.go': 'package main\nimport "example.com/lib/util"\n' },
      'main.go',
    ).analysis;
    assert.deepEqual(targetsOf(viaReplace), ['lib/util/util.go']);
    const viaWork = analyze(
      { ...lib, 'go.work': 'go 1.22\nuse (\n\t.\n\t./lib\n)\n', 'go.mod': 'module example.com/app\n', 'main.go': 'package main\nimport "example.com/lib/util"\n' },
      'main.go',
    ).analysis;
    assert.deepEqual(targetsOf(viaWork), ['lib/util/util.go']);
    // go.work only applies to its members.
    const outsider = analyze(
      {
        ...lib,
        'go.work': 'go 1.22\nuse ./lib\n',
        'go.mod': 'module example.com/app\n',
        'main.go': 'package main\nimport "example.com/lib/util"\n',
      },
      'main.go',
    ).analysis;
    assert.deepEqual(targetsOf(outsider), []);
    assert.equal(outsider.external, 1);
  });

  it('a duplicate module path gets a warning and no mapping', () => {
    const files = {
      'a/go.mod': 'module example.com/dup\n',
      'b/go.mod': 'module example.com/dup\n',
      'a/x/x.go': 'package x\n',
      'b/x/x.go': 'package x\n',
      'go.mod': 'module example.com/app\nreplace example.com/other => ./a\n',
      'main.go': 'package main\nimport "example.com/dup/x"\n',
    };
    const { analysis, session } = analyze(files, 'main.go');
    assert.deepEqual(analysis.edges, []);
    assert.deepEqual(analysis.unresolved, [{ specifier: 'example.com/dup/x', reasonCode: 'ambiguous-package' }]);
    assert.equal(analysis.incomplete, true);
    assert.ok(session.indexWarnings().some((warning) => warning.includes('module path example.com/dup is declared by more than one go.mod (a, b)')));
  });

  it('records replace targets outside the repository (or using ..) as warnings with no mapping', () => {
    const files = {
      'go.mod': 'module example.com/app\nreplace example.com/x => ../outside\nreplace example.com/y => ./sub/../../escape\nreplace example.com/z => /abs/path\n',
      'main.go': 'package main\nimport "example.com/x/pkg"\n',
    };
    const { analysis, session } = analyze(files, 'main.go');
    assert.equal(analysis.external, 1);
    assert.deepEqual(analysis.edges, []);
    const warnings = session.indexWarnings();
    for (const target of ['../outside', './sub/../../escape', '/abs/path']) {
      assert.ok(warnings.some((warning) => warning.includes(`with ${target}, which is outside the repository`)), target);
    }
  });

  it('an oversized or unparseable go.mod makes its files incomplete, never ghost material', () => {
    const big = `module example.com/app\n${'// padding\n'.repeat(7000)}`;
    const { analysis, session } = analyze({ 'go.mod': big, 'main.go': 'package main\nimport "fmt"\n' }, 'main.go');
    assert.equal(analysis.incomplete, true);
    assert.match(analysis.incompleteReason ?? '', /larger than 64 KiB/);
    assert.ok(session.indexWarnings().some((warning) => warning.includes('go.mod is larger than 64 KiB')));
    const outside = analyze({ 'main.go': 'package main\nimport "fmt"\n' }, 'main.go').analysis;
    assert.equal(outside.incomplete, true);
    assert.match(outside.incompleteReason ?? '', /outside any go\.mod/);
  });

  it('_test.go files are extracted but never targets, and package x_test imports its package', () => {
    const files = {
      'go.mod': 'module example.com/app\n',
      'db/db.go': 'package db\n',
      'db/db_test.go': 'package db\nimport "testing"\n',
      'db/export_test.go': 'package db_test\nimport (\n\t"testing"\n\t"example.com/app/db"\n)\n',
    };
    const { analysis } = analyze(files, 'db/export_test.go');
    assert.deepEqual(targetsOf(analysis), ['db/db.go']);
    assert.equal(analysis.external, 1);
  });

  it('an import of a directory without non-test Go files is target-missing', () => {
    const files = {
      'go.mod': 'module example.com/app\n',
      'empty/only_test.go': 'package empty\n',
      'empty/README.md': '# nothing\n',
      'main.go': 'package main\nimport (\n\t"example.com/app/empty"\n\t"example.com/app/nowhere"\n)\n',
    };
    const { analysis } = analyze(files, 'main.go');
    assert.deepEqual(analysis.unresolved, [
      { specifier: 'example.com/app/empty', reasonCode: 'target-missing' },
      { specifier: 'example.com/app/nowhere', reasonCode: 'target-missing' },
    ]);
    assert.equal(analysis.incomplete, true);
  });

  it('cgo is external; invalid paths are unresolved', () => {
    const files = { 'go.mod': 'module example.com/app\n', 'main.go': 'package main\nimport "C"\nimport "example.com/app/../etc"\n' };
    const { analysis } = analyze(files, 'main.go');
    assert.equal(analysis.external, 1);
    assert.deepEqual(analysis.unresolved, [{ specifier: 'example.com/app/../etc', reasonCode: 'invalid-target' }]);
  });

  it('self-imports and package cycles terminate', async () => {
    await withRepo(
      {
        'go.mod': 'module example.com/app\n',
        'a/a.go': 'package a\nimport "example.com/app/b"\nimport "example.com/app/a"\n',
        'b/b.go': 'package b\nimport "example.com/app/a"\n',
      },
      async (repo) => {
        const ctx = await loadContext(repo.dir, { cache: false } as never, { silent: true });
        try {
          assert.equal(ctx.classifier.classify('a/a.go', 'b/b.go'), 'direct');
          const graph = importGraph(ctx);
          assert.deepEqual(
            graph.edges.map((edge) => `${edge.from}->${edge.to}`),
            ['a/a.go->b/b.go', 'b/b.go->a/a.go'],
          );
        } finally {
          ctx.close?.();
        }
      },
    );
  });

  it('truncates package fan-out deterministically; the files past the cap are uncertain, not the whole importer', () => {
    const files: Record<string, string> = { 'go.mod': 'module example.com/app\n' };
    for (let n = 0; n < MAX_GO_PACKAGE_FAN_OUT + 50; n++) files[`big/f${String(n).padStart(3, '0')}.go`] = 'package big\n';
    files['main.go'] = 'package main\nimport "example.com/app/big"\n';
    const first = analyze(files, 'main.go').analysis;
    const second = analyze(files, 'main.go').analysis;
    assert.equal(first.edges[0]!.targets.length, MAX_GO_PACKAGE_FAN_OUT);
    assert.deepEqual(first.edges, second.edges);
    assert.equal(first.edges[0]!.targets[0]!.path, 'big/f000.go');
    assert.equal(first.edges[0]!.targets.at(-1)!.path, 'big/f199.go');
    assert.equal(first.incomplete, false);
    assert.deepEqual(first.uncertain?.map((item) => item.path), Array.from({ length: 50 }, (_, n) => `big/f${String(n + 200).padStart(3, '0')}.go`));
    assert.match(first.warnings?.[0] ?? '', /package example\.com\/app\/big has 250 files/);
  });

  it('stops at the session internal-edge budget and marks later files incomplete', () => {
    const files: Record<string, string> = { 'go.mod': 'module example.com/app\n', 'p/a.go': 'package p\n', 'p/b.go': 'package p\n' };
    for (let n = 0; n < 5; n++) files[`c${n}.go`] = 'package main\nimport "example.com/app/p"\n';
    const repo = memoryFiles(files);
    const session = new AnalysisSession(repo);
    session.edgeBudget = 5;
    const results = [0, 1, 2, 3, 4].map((n) => analyzeFile(`c${n}.go`, repo, session));
    assert.deepEqual(results.map((result) => targetsOf(result).length), [2, 2, 1, 0, 0]);
    assert.deepEqual(results.map((result) => result.incomplete), [false, false, true, true, true]);
  });

  it('ignores symlinked package files for package membership', async () => {
    const repo = new FixtureRepo();
    try {
      repo.write('go.mod', 'module example.com/app\n');
      repo.write('real/real.go', 'package real\n');
      repo.write('main.go', 'package main\nimport (\n\t"example.com/app/linked"\n\t"example.com/app/real"\n)\n');
      symlinkSync(join(repo.dir, 'real'), join(repo.dir, 'linked'));
      symlinkSync(join(repo.dir, 'real', 'real.go'), join(repo.dir, 'real', 'alias.go'));
      repo.git('add', '.');
      repo.commit({ message: 'initial' });
      const ctx = await loadContext(repo.dir, { cache: false } as never, { silent: true });
      try {
        const graph = importGraph(ctx);
        assert.deepEqual(graph.edges.map((edge) => edge.to), ['real/real.go']);
        assert.deepEqual(
          graph.unresolved.map((item) => `${item.specifier}:${item.reasonCode}`),
          ['example.com/app/linked:target-missing'],
        );
      } finally {
        ctx.close?.();
      }
    } finally {
      repo.cleanup();
    }
  });

  it('builds the index from the reader only (no filesystem, no toolchain)', () => {
    const index = buildGoIndex(memoryFiles({ 'go.mod': 'module m\n', 'x/a.go': 'package x\n' }));
    assert.deepEqual([...index.goFilesByDir.keys()], ['x']);
    assert.equal(index.moduleByPath.get('m')?.dir, '');
  });
});

describe('Go relationships', () => {
  const files = {
    'go.mod': 'module example.com/app\n',
    'store/store.go': 'package store\nimport "example.com/app/model"\n',
    'store/cache.go': 'package store\n',
    'model/model.go': 'package model\n',
    'billing/billing.go': 'package billing\nimport "fmt"\n',
    'invoice/invoice.go': 'package invoice\nimport "strings"\n',
    'broken/broken.go': 'package broken\nimport (\n\t"fmt"\n\tnot valid\n)\n',
  };

  it('same-package pairs are unknown, cross-package pairs are direct with an import, indirect via a package sibling, and ghost without', async () => {
    await withRepo(files, async (repo) => {
      const ctx = await loadContext(repo.dir, { cache: false } as never, { silent: true });
      try {
        const classifier = ctx.classifier;
        assert.equal(classifier.classify('store/store.go', 'store/cache.go'), 'unknown');
        assert.equal(classifier.explain('store/store.go', 'store/cache.go', 'unknown'), 'same Go package: files share scope without imports');
        assert.equal(classifier.classify('store/store.go', 'model/model.go'), 'direct');
        assert.equal(classifier.explain('store/store.go', 'model/model.go', 'direct'), 'store.go imports package example.com/app/model (which includes model.go)');
        // cache.go shares package store with store.go, which imports model: one step removed.
        assert.equal(classifier.classify('store/cache.go', 'model/model.go'), 'indirect');
        assert.equal(classifier.classify('billing/billing.go', 'invoice/invoice.go'), 'ghost');
        // A malformed import block can hide an import: the pair stays unknown.
        assert.equal(classifier.classify('broken/broken.go', 'invoice/invoice.go'), 'unknown');
        assert.match(classifier.explain('broken/broken.go', 'invoice/invoice.go', 'unknown'), /import analysis was incomplete \(Go import declarations could not be parsed/);
      } finally {
        ctx.close?.();
      }
    });
  });

  it('imports --json lists go-package edges, the go language and Go counters', async () => {
    await withRepo(files, async (repo) => {
      const ctx = await loadContext(repo.dir, { cache: false } as never, { silent: true });
      try {
        const graph = importGraph(ctx);
        assert.deepEqual(graph.languages, ['go']);
        assert.deepEqual(graph.edges, [{ from: 'store/store.go', to: 'model/model.go', specifier: 'example.com/app/model', kind: 'static', via: 'go-package', role: 'module' }]);
        assert.equal(graph.meta.imports?.filesScanned, 6);
        assert.equal(graph.meta.imports?.external, 3);
        assert.equal(graph.meta.imports?.internalEdges, 1);
      } finally {
        ctx.close?.();
      }
    });
  });

  it('a 400-file package imported by 300 files stays bounded, deterministic and fast', async () => {
    const write: Record<string, string> = { 'go.mod': 'module example.com/app\n' };
    for (let n = 0; n < 400; n++) write[`huge/f${String(n).padStart(3, '0')}.go`] = 'package huge\n';
    for (let n = 0; n < 300; n++) write[`users/u${String(n).padStart(3, '0')}/u.go`] = `package u${n}\nimport "example.com/app/huge"\n`;
    await withRepo(write, async (repo) => {
      const run = async () => {
        const ctx = await loadContext(repo.dir, { cache: false } as never, { silent: true });
        try {
          const started = performance.now();
          const graph = importGraph(ctx);
          return { graph, ms: performance.now() - started };
        } finally {
          ctx.close?.();
        }
      };
      const first = await run();
      const second = await run();
      assert.equal(first.graph.edges.length, 300 * MAX_GO_PACKAGE_FAN_OUT);
      assert.deepEqual(first.graph.edges, second.graph.edges);
      assert.ok(first.graph.meta.warnings.some((warning) => warning.includes('package example.com/app/huge has 400 files')));
      assert.ok(first.ms < 10_000, `took ${Math.round(first.ms)} ms`);
      const ctx = await loadContext(repo.dir, { cache: false } as never, { silent: true });
      try {
        // Importers are incomplete, so a pair with an untargeted package file is never a ghost.
        assert.equal(ctx.classifier.classify('users/u000/u.go', 'huge/f399.go'), 'unknown');
        assert.equal(ctx.classifier.classify('users/u000/u.go', 'huge/f000.go'), 'direct');
      } finally {
        ctx.close?.();
      }
    });
  });
});

describe('Go package scope and indirect links', () => {
  it('a file whose package sibling imports the partner is indirect, not ghost', async () => {
    await withRepo(
      {
        'go.mod': 'module example.com/app\n',
        'gin.go': 'package app\nimport "example.com/app/render"\n',
        'errors.go': 'package app\nimport "fmt"\n',
        'render/data.go': 'package render\n',
        'other/other.go': 'package other\n',
      },
      async (repo) => {
        const ctx = await loadContext(repo.dir, { cache: false } as never, { silent: true });
        try {
          const c = ctx.classifier;
          assert.equal(c.classify('errors.go', 'render/data.go'), 'indirect');
          assert.equal(
            c.explain('errors.go', 'render/data.go', 'indirect'),
            'connected through gin.go: errors.go shares a Go package with gin.go, which imports package example.com/app/render',
          );
          assert.equal(c.classify('errors.go', 'other/other.go'), 'ghost');
        } finally {
          ctx.close?.();
        }
      },
    );
  });

  it('an incomplete package sibling keeps the pair unknown', async () => {
    await withRepo(
      {
        'go.mod': 'module example.com/app\n',
        'a.go': 'package app\nimport (\n\t"fmt"\n\tnot valid\n)\n',
        'b.go': 'package app\n',
        'other/other.go': 'package other\n',
      },
      async (repo) => {
        const ctx = await loadContext(repo.dir, { cache: false } as never, { silent: true });
        try {
          assert.equal(ctx.classifier.classify('b.go', 'other/other.go'), 'unknown');
        } finally {
          ctx.close?.();
        }
      },
    );
  });
});

describe('Go workspaces (RA-10 review regressions)', () => {
  const lib = { 'lib/go.mod': 'module example.com/lib\n', 'lib/util/u.go': 'package util\n' };
  const app = { 'app/go.mod': 'module example.com/app\nrequire example.com/lib v0.0.0\n', 'app/main.go': 'package main\nimport "example.com/lib/util"\n' };

  it('applies go.work replacements whose target is not a use member', () => {
    const { analysis } = analyze({ ...lib, ...app, 'go.work': 'go 1.22\nuse ./app\nreplace example.com/lib => ./lib\n' }, 'app/main.go');
    assert.deepEqual(targetsOf(analysis), ['lib/util/u.go']);
    assert.equal(analysis.incomplete, false);
  });

  it('go.work replacements take precedence over a member go.mod replacement', () => {
    const files = {
      ...lib,
      'fork/go.mod': 'module example.com/lib\n',
      'fork/util/u.go': 'package util\n',
      'app/go.mod': 'module example.com/app\nreplace example.com/lib => ../fork\n',
      'app/main.go': 'package main\nimport "example.com/lib/util"\n',
      'go.work': 'go 1.22\nuse ./app\nreplace example.com/lib => ./lib\n',
    };
    assert.deepEqual(targetsOf(analyze(files, 'app/main.go').analysis), ['lib/util/u.go']);
    // Outside the workspace (no go.work), the module's own replacement applies.
    const { 'go.work': _work, ...noWork } = files;
    assert.deepEqual(targetsOf(analyze(noWork, 'app/main.go').analysis), ['fork/util/u.go']);
    // A versioned go.work replacement makes the import an external dependency.
    assert.equal(analyze({ ...files, 'go.work': 'go 1.22\nuse ./app\nreplace example.com/lib => example.com/lib v1.2.3\n' }, 'app/main.go').analysis.external, 1);
  });

  it('conflicting member replacements, replaced workspace modules and replace targets without go.mod are unresolved', () => {
    const conflict = {
      ...lib,
      'fork/go.mod': 'module example.com/lib\n',
      'fork/util/u.go': 'package util\n',
      ...app,
      'app/go.mod': 'module example.com/app\nreplace example.com/lib => ../lib\n',
      'tool/go.mod': 'module example.com/tool\nreplace example.com/lib => ../fork\n',
      'go.work': 'go 1.22\nuse (\n\t./app\n\t./tool\n)\n',
    };
    const conflicted = analyze(conflict, 'app/main.go').analysis;
    assert.deepEqual(conflicted.edges, []);
    assert.deepEqual(conflicted.unresolved, [{ specifier: 'example.com/lib/util', reasonCode: 'unsupported-config' }]);
    const memberReplaced = analyze({ ...lib, ...app, 'go.work': 'go 1.22\nuse (\n\t./app\n\t./lib\n)\nreplace example.com/lib => ./lib\n' }, 'app/main.go').analysis;
    assert.equal(memberReplaced.incomplete, true);
    const noGoMod = analyze({ 'lib/util/u.go': 'package util\n', ...app, 'go.work': 'go 1.22\nuse ./app\nreplace example.com/lib => ./lib\n' }, 'app/main.go').analysis;
    assert.deepEqual(noGoMod.unresolved, [{ specifier: 'example.com/lib/util', reasonCode: 'unsupported-config' }]);
  });

  it('an unusable or nested go.work keeps cross-module imports unresolved, never external', () => {
    const big = `go 1.22\nuse ./app\n${'// padding\n'.repeat(7000)}`;
    for (const [label, work] of [
      ['oversized', { 'go.work': big }],
      ['unparseable', { 'go.work': 'go 1.22\nuse (\n' }],
      ['use without go.mod', { 'go.work': 'go 1.22\nuse ./app\nuse ./missing\n' }],
      ['nested', { 'app/go.work': 'go 1.22\nuse .\nreplace example.com/lib => ../lib\n' }],
    ] as const) {
      const { analysis } = analyze({ ...lib, ...app, 'app/extra.go': 'package main\nimport "fmt"\n', ...work }, 'app/main.go');
      assert.deepEqual(analysis.unresolved, [{ specifier: 'example.com/lib/util', reasonCode: 'unsupported-config' }], label);
      assert.equal(analysis.incomplete, true, label);
      // The standard library stays external.
      assert.equal(analyze({ ...lib, ...app, 'app/extra.go': 'package main\nimport "fmt"\n', ...work }, 'app/extra.go').analysis.incomplete, false, label);
    }
  });
});

describe('Go package identity (RA-10 review regressions)', () => {
  it('ignore-tagged generators are never members, even when they outnumber the real files', () => {
    const files = {
      'go.mod': 'module example.com/app\n',
      'main.go': 'package main\nimport "example.com/app/pkg"\n',
      'pkg/real.go': 'package pkg\n',
      'pkg/gen1.go': '//go:build ignore\n\npackage main\n',
      'pkg/gen2.go': '// +build ignore\n\npackage main\n',
      'pkg/_scratch.go': 'package main\n',
    };
    const { analysis } = analyze(files, 'main.go');
    assert.deepEqual(targetsOf(analysis), ['pkg/real.go']);
    assert.equal(analysis.incomplete, false);
  });

  it('several package clauses without an ignore tag make every member uncertain (no edges, no guess)', () => {
    for (const [label, extra] of [
      ['tie', { 'pkg/other.go': 'package other\n' }],
      ['majority elsewhere', { 'pkg/m1.go': 'package main\n', 'pkg/m2.go': '//go:build tools\n\npackage main\n' }],
    ] as const) {
      const files = { 'go.mod': 'module example.com/app\n', 'main.go': 'package main\nimport "example.com/app/pkg"\n', 'pkg/real.go': 'package pkg\n', ...extra };
      const { analysis } = analyze(files, 'main.go');
      assert.deepEqual(analysis.edges, [], label);
      assert.ok(analysis.uncertain?.some((item) => item.path === 'pkg/real.go' && /holds files of several packages/.test(item.reason)), label);
      assert.equal(analysis.incomplete, false, label);
    }
  });

  it('a package name that differs from its folder, and build-tag alternatives, are one package', () => {
    const files = {
      'go.mod': 'module example.com/app\n',
      'main.go': 'package main\nimport "example.com/app/v2"\n',
      'v2/api.go': 'package api\n',
      'v2/api_linux.go': '//go:build linux\n\npackage api\n',
      'v2/api_other.go': '//go:build !linux\n\npackage api\n',
    };
    const { analysis } = analyze(files, 'main.go');
    assert.deepEqual(targetsOf(analysis), ['v2/api.go', 'v2/api_linux.go', 'v2/api_other.go']);
    assert.equal(analysis.incomplete, false);
  });

  it('same-package suppression and sibling reachability use the package clause, not just the folder', async () => {
    await withRepo(
      {
        'go.mod': 'module example.com/app\n',
        'pkg/gen.go': '//go:build ignore\n\npackage main\n',
        'pkg/real.go': 'package pkg\nimport "example.com/app/other"\n',
        'pkg/real2.go': 'package pkg\n',
        'other/o.go': 'package other\n',
      },
      async (repo) => {
        const ctx = await loadContext(repo.dir, { cache: false } as never, { silent: true });
        try {
          const c = ctx.classifier;
          // Positive: same package → unknown; a package sibling's import → indirect.
          assert.equal(c.classify('pkg/real.go', 'pkg/real2.go'), 'unknown');
          assert.equal(c.classify('pkg/real2.go', 'other/o.go'), 'indirect');
          // Negative: the ignore-tagged generator is not in package pkg.
          assert.equal(c.classify('pkg/gen.go', 'pkg/real.go'), 'ghost');
          assert.equal(c.classify('pkg/gen.go', 'other/o.go'), 'ghost');
        } finally {
          ctx.close?.();
        }
      },
    );
  });
});
