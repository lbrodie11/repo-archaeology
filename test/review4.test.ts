/**
 * Regression tests for the fourth external code review & release hardening (v0.1.3).
 * Covers:
 * 1. Scoped npm packages treated as external rather than unresolved aliases.
 * 2. Files renamed on a feature branch preserving history in diff --base.
 * 3. Child tsconfig path mappings properly overriding parent patterns.
 * 4. Conditional package exports respecting import vs require (ESM vs CJS).
 * 5. Interactive map accessibility, keyboard buttons, hover highlighting, and sanitization.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { RelationshipClassifier } from '../src/imports/classify.js';
import { ImportResolver, type RepoFiles } from '../src/imports/resolve.js';
import { renderMapHtml } from '../src/map/template.js';
import { FixtureRepo } from './helpers.js';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((fn) => fn()));

function fixture(): FixtureRepo {
  const r = new FixtureRepo();
  cleanups.push(() => r.cleanup());
  return r;
}

function memoryRepo(files: Record<string, string | undefined>): RepoFiles & { list(): Iterable<string> } {
  return {
    exists: (p) => p in files && files[p] !== undefined,
    read: (p) => files[p],
    list: () => Object.keys(files),
  };
}

describe('review 4: scoped npm packages resolution', () => {
  it('treats scoped npm packages as external when no alias or local package claims them', () => {
    const files = memoryRepo({
      'src/app.ts': 'export const app = 1;\n',
    });
    const resolver = new ImportResolver(files);

    // Scoped npm packages
    assert.deepEqual(resolver.resolve('src/app.ts', '@tanstack/react-query'), { kind: 'external' });
    assert.deepEqual(resolver.resolve('src/app.ts', '@radix-ui/react-dialog'), { kind: 'external' });
    assert.deepEqual(resolver.resolve('src/app.ts', '@prisma/client'), { kind: 'external' });
    assert.deepEqual(resolver.resolve('src/app.ts', '@aws-sdk/client-s3'), { kind: 'external' });

    // Local alias-like specifiers with no config should still be unresolved
    assert.deepEqual(resolver.resolve('src/app.ts', '@/components/Button'), { kind: 'unresolved' });
    assert.deepEqual(resolver.resolve('src/app.ts', '~/utils/format'), { kind: 'unresolved' });
    assert.deepEqual(resolver.resolve('src/app.ts', '$lib/server'), { kind: 'unresolved' });
    assert.deepEqual(resolver.resolve('src/app.ts', '#internal/helper'), { kind: 'unresolved' });
  });

  it('files importing scoped packages are classified as ghost wires if coupled and unimported', () => {
    const files = memoryRepo({
      'src/view.ts': 'import { useQuery } from "@tanstack/react-query";\nexport const V = 1;\n',
      'src/api.ts': 'export const A = 1;\n',
    });
    const classifier = new RelationshipClassifier(files);

    const rel = classifier.classify('src/view.ts', 'src/api.ts');
    // Before fix, @tanstack/react-query made src/view.ts have an unresolved local import,
    // so rel became 'unknown' (unchecked). With the fix, it is correctly 'ghost'!
    assert.equal(rel, 'ghost');
  });
});

describe('review 4: branch renames in diff --base', () => {
  it('preserves history and finds companions for files renamed on a feature branch', async () => {
    const r = fixture();
    // 4 commits coupling a.ts and b.ts
    for (let i = 0; i < 4; i++) {
      r.touch(['a.ts', 'b.ts'], `commit ${i}`);
    }

    // Create a feature branch and rename a.ts to renamed.ts
    r.git('checkout', '-b', 'feature-rename');
    r.commit({
      message: 'rename a.ts to renamed.ts',
      move: [['a.ts', 'renamed.ts']],
    });

    const res = spawnSync(process.execPath, ['--import', TSX, CLI, 'diff', '--base', 'main'], {
      cwd: r.dir,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });

    assert.equal(res.status, 0);
    // Should NOT say "none of the changed files have usable history"
    assert.doesNotMatch(res.stdout, /none of the changed files have usable history/i);
    // Should find b.ts as companion for renamed.ts
    assert.match(res.stdout, /renamed\.ts/);
    assert.match(res.stdout, /b\.ts/);
  });
});

describe('review 4: tsconfig paths inheritance and overrides', () => {
  it('allows child tsconfig to override parent pattern mappings', () => {
    const files = memoryRepo({
      'tsconfig.base.json': JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@/*': ['legacy/*'],
          },
        },
      }),
      'tsconfig.json': JSON.stringify({
        extends: './tsconfig.base.json',
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@/*': ['src/*'],
          },
        },
      }),
      'legacy/utils.ts': 'export const legacy = true;\n',
      'src/utils.ts': 'export const modern = true;\n',
      'src/app.ts': 'import { modern } from "@/utils";\n',
    });

    const resolver = new ImportResolver(files);

    const res = resolver.resolve('src/app.ts', '@/utils');
    assert.equal(res.kind, 'file');
    if (res.kind === 'file') {
      assert.equal(res.path, 'src/utils.ts');
    }
  });
});

describe('review 4: conditional package exports by import mode', () => {
  it('selects import condition for ESM and require condition for CJS when both are defined', () => {
    const files = memoryRepo({
      'packages/lib/package.json': JSON.stringify({
        name: '@my/lib',
        exports: {
          '.': {
            require: './dist/cjs/index.js',
            import: './dist/esm/index.js',
          },
        },
      }),
      'packages/lib/dist/cjs/index.js': 'module.exports = { cjs: true };\n',
      'packages/lib/dist/esm/index.js': 'export const esm = true;\n',
      'apps/web/main.ts': 'import { esm } from "@my/lib";\n',
      'apps/web/main.cjs': 'const { cjs } = require("@my/lib");\n',
    });

    const resolver = new ImportResolver(files);

    const esmRes = resolver.resolve('apps/web/main.ts', '@my/lib');
    assert.equal(esmRes.kind, 'file');
    if (esmRes.kind === 'file') {
      assert.equal(esmRes.path, 'packages/lib/dist/esm/index.js');
    }

    const cjsRes = resolver.resolve('apps/web/main.cjs', '@my/lib');
    assert.equal(cjsRes.kind, 'file');
    if (cjsRes.kind === 'file') {
      assert.equal(cjsRes.path, 'packages/lib/dist/cjs/index.js');
    }
  });
});

describe('review 4: map HTML features & accessibility', () => {
  it('renders pause animation button, warning banner, button cards, and sanitizes markdown export', () => {
    const html = renderMapHtml({
      meta: {
        tool: 'repo-archaeology',
        root: 'test-repo',
        commitsRead: 19,
        commitsAnalyzed: 19,
        sweepsSkipped: 0,
        subjectSkipped: 0,
        renamesFollowed: 0,
        files: 2,
        settings: { maxCommits: 50, maxFilesPerCommit: 20, minShared: 3, minConfidence: 0.2, ignore: [], useDefaultIgnores: true },
        warnings: ['Only 19 commits available: co-change detection needs history to be reliable.'],
      },
      repoName: 'test-repo',
      generatedAt: '2026-10-16T12:00:00Z',
      counts: { ghost: 1, unknown: 0, indirect: 0, direct: 0, test: 0 },
      classificationTruncated: false,
      nodes: [
        { path: 'src/a.ts', dir: 'src', changes: 10 },
        { path: 'src/b.ts', dir: 'src', changes: 8 },
      ],
      edges: [
        {
          source: 0,
          target: 1,
          relationship: 'ghost',
          why: 'no import link detected in current code',
          shared: 8,
          fromChanges: 10,
          toChanges: 8,
          confidence: 0.8,
          reverseConfidence: 1,
          score: 0.9,
          overviewPriority: 2,
          weighted: true,
          lastTogether: '2026-09-01T00:00:00Z',
          crossesDirectories: false,
          evidence: [{ hash: 'abcdef1234567890', date: '2026-09-01', subject: 'fix(#123): update @alice code' }],
        },
      ],
    });

    // 1. Pause animation button
    assert.match(html, /<button id="toggle-anim" class="map-btn"/);

    // 2. Banner warning
    assert.match(html, /class="banner-warning"/);
    assert.match(html, /Only 19 commits available/);

    // 3. Accessible button cards
    assert.match(html, /el\('button', 'card interactive'\)/);

    // 4. Hover edge highlighting logic
    assert.match(html, /hoverEdge/);

    // 5. Markdown sanitization for @ and #
    assert.match(html, /sanitizeMarkdown/);
  });
});
