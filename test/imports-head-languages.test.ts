import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { importGraph } from '../src/commands/imports.js';
import { loadContext } from '../src/context.js';
import { FixtureRepo } from './helpers.js';

describe('--head reads Go and Python manifests from the selected revision', () => {
  it('analysis at an older ref uses that ref’s go.mod, pyproject.toml and sources', async () => {
    const repo = new FixtureRepo();
    try {
      repo.commit({
        message: 'old layout',
        write: {
          'go.mod': 'module example.com/old\n',
          'db/db.go': 'package db\n',
          'main.go': 'package main\nimport "example.com/old/db"\n',
          'pyproject.toml': '[tool.setuptools.packages.find]\nwhere = ["lib"]\n',
          'lib/pkg/__init__.py': '',
          'lib/pkg/mod.py': '',
          'app.py': 'import pkg.mod\n',
        },
      });
      const oldSha = repo.git('rev-parse', 'HEAD').trim();
      repo.commit({
        message: 'new layout',
        write: {
          'go.mod': 'module example.com/new\n',
          'pyproject.toml': '[tool.setuptools.packages.find]\nwhere = ["src"]\n',
          'src/other/__init__.py': '',
          'app.py': 'import pkg\n',
        },
      });
      // An uncommitted working-tree go.mod must not leak into either analysis.
      repo.write('go.mod', 'module example.com/dirty\n');

      const edgesAt = async (head?: string) => {
        const ctx = await loadContext(repo.dir, { cache: false } as never, { silent: true, ...(head ? { head } : {}) });
        try {
          const graph = importGraph(ctx);
          return {
            edges: graph.edges.map((edge) => `${edge.from} -> ${edge.to} (${edge.via})`),
            unresolved: graph.unresolved.map((item) => `${item.from}: ${item.specifier} ${item.reasonCode}`),
            warnings: graph.meta.warnings,
          };
        } finally {
          ctx.close?.();
        }
      };

      const old = await edgesAt(oldSha);
      assert.deepEqual(old.edges, [
        'app.py -> lib/pkg/__init__.py (python-module)',
        'app.py -> lib/pkg/mod.py (python-module)',
        'main.go -> db/db.go (go-package)',
      ]);
      assert.deepEqual(old.unresolved, []);

      const head = await edgesAt('HEAD');
      // At HEAD the module is example.com/new, so example.com/old/db is an external dependency,
      // and lib/ is no longer a declared root, so `pkg` is an in-repo package of unknown layout.
      assert.deepEqual(head.edges, []);
      assert.deepEqual(head.unresolved, ['app.py: pkg unknown-package']);
    } finally {
      repo.cleanup();
    }
  });

  it('go.work replacements come from the analyzed revision', async () => {
    const repo = new FixtureRepo();
    try {
      repo.commit({
        message: 'workspace with a replacement',
        write: {
          'go.work': 'go 1.22\nuse ./app\nreplace example.com/lib => ./lib\n',
          'app/go.mod': 'module example.com/app\nrequire example.com/lib v0.0.0\n',
          'app/main.go': 'package main\nimport "example.com/lib/util"\n',
          'lib/go.mod': 'module example.com/lib\n',
          'lib/util/u.go': 'package util\n',
        },
      });
      const oldSha = repo.git('rev-parse', 'HEAD').trim();
      repo.commit({ message: 'drop the replacement', write: { 'go.work': 'go 1.22\nuse ./app\n' } });
      const graphAt = async (head: string) => {
        const ctx = await loadContext(repo.dir, { cache: false } as never, { silent: true, head });
        try {
          ctx.open?.();
          const relationship = ctx.classifier.classify('app/main.go', 'lib/util/u.go');
          return { graph: importGraph(ctx), relationship };
        } finally {
          ctx.close?.();
        }
      };
      const old = await graphAt(oldSha);
      assert.deepEqual(old.graph.edges.map((edge) => `${edge.from} -> ${edge.to}`), ['app/main.go -> lib/util/u.go']);
      assert.equal(old.relationship, 'direct');
      const head = await graphAt('HEAD');
      assert.deepEqual(head.graph.edges, []);
      // Without the replacement the require is a versioned dependency on an in-repo module.
      assert.ok(head.graph.meta.warnings.some((warning) => warning.includes('imports in-repo module example.com/lib')));
    } finally {
      repo.cleanup();
    }
  });
});
