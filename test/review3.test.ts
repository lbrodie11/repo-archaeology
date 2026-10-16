/**
 * Regression tests for the third external code review (October 2026).
 * Each test verifies one of the reviewer-reported issues and edge cases.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { suggestMissing } from '../src/commands/diff.js';
import {
  compileSkipPattern,
  ConfigError,
  DEFAULT_IGNORES,
  loadConfigFile,
  riskySkipPattern,
  validatePartial,
} from '../src/config.js';
import { RelationshipClassifier } from '../src/imports/classify.js';
import { ImportResolver, type RepoFiles } from '../src/imports/resolve.js';
import { countNonLiteralLoads } from '../src/imports/typescript.js';
import { renderMapHtml } from '../src/map/template.js';
import { CoChangeModel } from '../src/model/cochange.js';
import { loadHistory } from '../src/model/history.js';
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

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repo-archaeology-review3-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function memoryRepo(files: Record<string, string | undefined>): RepoFiles & { list(): Iterable<string> } {
  return {
    exists: (p) => p in files && files[p] !== undefined,
    read: (p) => files[p],
    list: () => Object.keys(files),
  };
}

describe('review 3, CLI argument validation', () => {
  it('refuses excess arguments on subcommands like diff and file', () => {
    const r = fixture();
    r.touch(['a.ts']);
    const diffRes = spawnSync(process.execPath, ['--import', TSX, CLI, 'diff', 'main'], {
      cwd: r.dir,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    assert.equal(diffRes.status, 1);
    assert.match(diffRes.stderr, /too many arguments for 'diff'/);

    const fileRes = spawnSync(process.execPath, ['--import', TSX, CLI, 'file', 'a.ts', 'b.ts'], {
      cwd: r.dir,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    assert.equal(fileRes.status, 1);
    assert.match(fileRes.stderr, /too many arguments for 'file'/);
  });

  it('still suggests closest command on mistyped root command', () => {
    const r = fixture();
    r.touch(['a.ts']);
    const res = spawnSync(process.execPath, ['--import', TSX, CLI, 'scna'], {
      cwd: r.dir,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /unknown command 'scna'/);
    assert.match(res.stderr, /Did you mean scan\?/);
  });
});

describe('review 3, regex ReDoS guard and skipCommitPrefixes', () => {
  it('refuses patterns with repeated quantifiers vulnerable to polynomial/exponential ReDoS', () => {
    // Polynomial / exponential backtracking attack
    const evil = '^a*a*a*a*a*a*a*a*a*a*a*a*b$';
    assert.ok(riskySkipPattern(evil) !== undefined);

    const nested = '(a+)+';
    assert.ok(riskySkipPattern(nested) !== undefined);

    // Safe typical patterns
    assert.equal(riskySkipPattern('^chore\\(deps\\):'), undefined);
    assert.equal(riskySkipPattern('^(chore|style|docs):'), undefined);
    assert.equal(riskySkipPattern('^[a-z0-9_-]+$'), undefined);
  });

  it('validates and compiles skipCommitPrefixes safely', () => {
    const valid = validatePartial({ skipCommitPrefixes: ['chore', 'deps', 'release/'] }, 'test');
    assert.deepEqual(valid.skipCommitPrefixes, ['chore', 'deps', 'release/']);

    assert.throws(() => validatePartial({ skipCommitPrefixes: 'chore' as unknown as string[] }, 'test'), ConfigError);
    assert.throws(() => validatePartial({ skipCommitPrefixes: [123] as unknown as string[] }, 'test'), ConfigError);

    const regex = compileSkipPattern(undefined, 'test', ['deps', 'chore']);
    assert.ok(regex !== undefined);
    assert.ok(regex!.test('deps: upgrade lodash'));
    assert.ok(regex!.test('chore(release): v1.0.0'));
    assert.ok(regex!.test('chore: update readme'));
    assert.ok(!regex!.test('fix: critical bug in chore service'));
  });

  it('skips commits matching skipCommitPrefixes in history loading', async () => {
    const r = fixture();
    r.touch(['a.ts', 'b.ts'], 'feat: initial');
    r.touch(['a.ts', 'b.ts'], 'chore: bump dependencies');
    r.touch(['a.ts', 'b.ts'], 'docs: fix typo');
    const regex = compileSkipPattern(undefined, 'test', ['chore', 'docs']);
    const history = await loadHistory(r.dir, {
      maxFilesPerCommit: 25,
      ignore: DEFAULT_IGNORES,
      skipCommits: regex,
    });
    assert.equal(history.commits.length, 1);
    assert.equal(history.commits[0]?.subject, 'feat: initial');
  });
});

describe('review 3, diff branch additions and history isolation', () => {
  it('does not attribute deleted file history to a freshly added file on a branch', () => {
    const commits = [
      { hash: '1', author: 'a', time: 100, commitTime: 100, subject: '1', files: ['old.ts', 'companion.ts'] },
      { hash: '2', author: 'a', time: 200, commitTime: 200, subject: '2', files: ['old.ts', 'companion.ts'] },
      { hash: '3', author: 'a', time: 300, commitTime: 300, subject: '3', files: ['old.ts', 'companion.ts'] },
    ];
    const model = new CoChangeModel(commits);
    const classifier = new RelationshipClassifier(memoryRepo({
      'old.ts': 'export const x = 1;',
      'companion.ts': 'export const y = 2;',
    }));

    const ctx = {
      model,
      classifier,
      currentFiles: new Set(['old.ts', 'companion.ts']),
      thresholds: { minShared: 3, minConfidence: 0.4 },
      root: '/repo',
      settings: {},
    } as any;

    // A file newly added on a branch: file.added is true
    const { changed, suggestions } = suggestMissing(
      ctx,
      [{ path: 'old.ts', added: true, deleted: false, sources: ['branch'] }],
      {
        limit: 10,
        kinds: ['ghost', 'unknown', 'indirect', 'direct', 'test'],
      },
    );

    assert.equal(changed[0]?.hasHistory, false);
    assert.equal(changed[0]?.historyPath, undefined);
    assert.equal(suggestions.length, 0);
  });
});

describe('review 3, indirect uncertainty and barrel reachability', () => {
  it('treats an intermediate with incomplete reachability as uncertain, not ghost', () => {
    // a.ts imports barrel.ts
    // barrel.ts imports other stuff dynamically or has unresolvable imports (incomplete)
    // b.ts is unconnected to barrel.ts
    const files = memoryRepo({
      'src/a.ts': "import { x } from './barrel';\nexport const a = x;\n",
      'src/barrel.ts': "const mod = 'dyn'; import(mod);\nexport const x = 1;\n",
      'src/b.ts': 'export const b = 2;\n',
    });
    const classifier = new RelationshipClassifier(files);
    const rel = classifier.classify('src/a.ts', 'src/b.ts');
    assert.equal(rel, 'unknown', 'uncertain reachability in intermediate barrel must prevent false ghost wires');
  });
});

describe('review 3, tsconfig project references and alias patterns', () => {
  it('resolves paths through tsconfig references (e.g. Vite tsconfig.app.json)', () => {
    const files = memoryRepo({
      'tsconfig.json': JSON.stringify({
        references: [{ path: './tsconfig.app.json' }],
      }),
      'tsconfig.app.json': JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@/*': ['src/*'],
          },
        },
      }),
      'src/components/Button.tsx': "import { add } from '@/utils/math';\nexport const Button = add(1, 2);\n",
      'src/utils/math.ts': 'export function add(a: number, b: number) { return a + b; }\n',
    });
    const resolver = new ImportResolver(files);
    const res = resolver.resolve('src/components/Button.tsx', '@/utils/math');
    assert.equal(res.kind, 'file');
    assert.equal((res as any).path, 'src/utils/math.ts');
  });

  it('marks scoped package aliases and $lib prefixes as unresolved if not found', () => {
    const files = memoryRepo({
      'src/index.ts': "import { x } from '$lib/utils';\nimport { y } from '@custom-scope/helper';\n",
    });
    const resolver = new ImportResolver(files);
    assert.equal(resolver.resolve('src/index.ts', '$lib/utils').kind, 'unresolved');
    assert.equal(resolver.resolve('src/index.ts', '@custom-scope/helper').kind, 'unresolved');
  });
});

describe('review 3, dynamic import syntax variations', () => {
  it('detects comments, type arguments, and globEager in dynamic imports', () => {
    assert.equal(countNonLiteralLoads("const mod = import/* comment */(getMod());"), 1);
    assert.equal(countNonLiteralLoads("const mod = import<typeof import('./mod')>(getMod());"), 1);
    assert.equal(countNonLiteralLoads("const mods = import.meta.globEager('./modules/*.ts');"), 1);
    assert.equal(countNonLiteralLoads("const mods = import.meta.glob('./modules/*.ts');"), 1);
  });
});

describe('review 3, explicit abstention when changes lack history', () => {
  it('explains that changed files lack history rather than claiming nothing is missing', async () => {
    const { printDiff } = await import('../src/commands/diff.js');
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    const mockMeta = {
      tool: 'repo-archaeology',
      root: '/repo',
      commitsRead: 10,
      commitsAnalyzed: 10,
      sweepsSkipped: 0,
      subjectSkipped: 0,
      renamesFollowed: 0,
      files: 5,
      warnings: [],
      settings: {} as any,
    } as any;
    try {
      printDiff({
        meta: mockMeta,
        changed: [{ path: 'new.ts', deleted: false, sources: ['unstaged'], hasHistory: false }],
        suggestions: [],
      });
      assert.ok(logs.some((line) => line.includes('No suggestions: none of the changed files have usable history')));
      assert.ok(!logs.some((line) => line.includes('Nothing obviously missing')));

      logs.length = 0;
      printDiff({
        meta: mockMeta,
        changed: [{ path: 'known.ts', deleted: false, sources: ['unstaged'], hasHistory: true, historyPath: 'known.ts' }],
        suggestions: [],
      });
      assert.ok(logs.some((line) => line.includes('Nothing obviously missing: evaluated 1 file')));
    } finally {
      console.log = origLog;
    }
  });
});

describe('review 3, interactive map template and sidebar polish', () => {
  it('renders fit-view control, copy finding export, and deduplicates basenames', () => {
    const html = renderMapHtml({
      meta: {
        tool: 'repo-archaeology',
        root: 'test-repo',
        commitsRead: 5,
        commitsAnalyzed: 5,
        sweepsSkipped: 0,
        subjectSkipped: 0,
        renamesFollowed: 0,
        files: 2,
        settings: { maxCommits: 5, maxFilesPerCommit: 5, minShared: 1, minConfidence: 0.1, ignore: [], useDefaultIgnores: true },
        warnings: [],
      },
      repoName: 'test-repo',
      generatedAt: '2026-10-16T12:00:00Z',
      counts: { ghost: 1, unknown: 0, indirect: 0, direct: 0, test: 0 },
      classificationTruncated: false,
      nodes: [
        { path: 'app/waitlist/page.tsx', dir: 'app/waitlist', changes: 4 },
        { path: 'app/blog/page.tsx', dir: 'app/blog', changes: 3 },
      ],
      edges: [
        {
          source: 0,
          target: 1,
          relationship: 'ghost',
          why: 'no import link detected in the current code',
          shared: 3,
          fromChanges: 4,
          toChanges: 3,
          confidence: 0.75,
          reverseConfidence: 1,
          score: 0.8,
          overviewPriority: 2,
          weighted: false,
          lastTogether: '2026-09-01T00:00:00Z',
          crossesDirectories: true,
          evidence: [{ hash: 'abcdef1234567890', date: '2026-09-01', subject: 'feat: connect waitlist and blog' }],
        },
      ],
    });

    // 1. Stage overlay with reset-view button
    assert.match(html, /<button id="reset-view" class="map-btn"/);

    // 2. Client script disambiguates identical basenames
    assert.match(html, /getNodeLabel/);
    assert.match(html, /baseCounts/);

    // 3. Two-state inspector and tabs
    assert.match(html, /renderOverview/);
    assert.match(html, /renderSelectedEdge/);
    assert.match(html, /renderSelectedNode/);
    assert.match(html, /formatFindingMarkdown/);
    assert.match(html, /Copy finding for PR/);

    // 4. Directory color legend
    assert.match(html, /renderFolderLegend/);
  });
});

