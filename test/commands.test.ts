import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { backtest, backtestCommits, EVALUATION_MAX_FILES } from '../src/commands/backtest.js';
import { diff } from '../src/commands/diff.js';
import { fileReport } from '../src/commands/file.js';
import { buildMapData, mapOverviewPriority } from '../src/commands/map.js';
import { classifiedPairs, scan } from '../src/commands/scan.js';
import { loadContext } from '../src/context.js';
import type { HistoryCommit } from '../src/model/history.js';
import { FixtureRepo } from './helpers.js';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
// Resolved here because the CLI runs with a fixture repository as its working directory.
const TSX = import.meta.resolve('tsx');

function runCli(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, ['--import', TSX, CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * A small app where:
 *  - api.ts imports db.ts and they change together (import link)
 *  - billing.ts and invoice-template.ts always change together (ghost wire)
 *  - api.test.ts tests api.ts (test link)
 */
let repo: FixtureRepo;
before(() => {
  repo = new FixtureRepo();
  repo.write('src/db.ts', 'export const db = 1\n');
  repo.write('src/api.ts', "import { db } from './db'\n");
  repo.write('src/api.test.ts', "import './api'\n");
  repo.write('src/billing.ts', 'export const bill = 1\n');
  repo.write('templates/invoice-template.ts', 'export const template = `<p></p>`\n');
  repo.write('src/other.ts', 'export {}\n');
  repo.git('add', '.');
  repo.commit({ message: 'initial' });
  for (let i = 0; i < 6; i++) {
    repo.touch(['src/billing.ts', 'templates/invoice-template.ts'], `billing change ${i}`);
    repo.commit({ message: `api change ${i}`, write: { 'src/api.ts': `import { db } from './db'\n// ${i}\n`, 'src/db.ts': `export const db = ${i}\n`, 'src/api.test.ts': `import './api'\n// ${i}\n` } });
    repo.touch(['src/other.ts'], `other ${i}`);
  }
});
after(() => repo.cleanup());

const flags = { minShared: 3, minConfidence: 0.4 };

describe('scan', () => {
  it('keeps a type-reference dependency out of ghost-only reports without hiding its history', async () => {
    const referencedRepo = new FixtureRepo();
    try {
      for (let index = 0; index < 3; index++) {
        referencedRepo.commit({
          message: `widget contract ${index}`, write: {
            'src/widget.js': `/// <reference path="./widget.types.d.ts" />\nexport const revision = ${index};`,
            'src/widget.types.d.ts': `interface WidgetConfig { revision: ${index} }`,
          }
        });
      }
      const ctx = await loadContext(referencedRepo.dir, flags);
      const ghosts = scan(ctx, { limit: 10, kinds: ['ghost'] });
      assert.deepEqual(ghosts.relationships, []);
      const direct = scan(ctx, { limit: 10, kinds: ['direct'] });
      assert.equal(direct.relationships.length, 1);
      assert.equal(direct.relationships[0]?.shared, 3);
      assert.match(direct.relationships[0]?.why ?? '', /triple-slash path/);
      referencedRepo.write('src/widget.js', '/// <reference path="./widget.types.d.ts" />\nexport const revision = 4;');
      const changes = await diff(await loadContext(referencedRepo.dir, flags), { limit: 10, kinds: ['direct'] });
      assert.equal(changes.suggestions[0]?.to, 'src/widget.types.d.ts');
      assert.match(changes.suggestions[0]?.why ?? '', /references/);
    } finally {
      referencedRepo.cleanup();
    }
  });

  it('distinguishes same-named files in the explanatory CLI sentence', () => {
    const scanRepo = new FixtureRepo();
    try {
      for (let index = 0; index < 3; index++) {
        scanRepo.touch(['src/bun/ssg.ts', 'src/deno/ssg.ts']);
      }
      const result = runCli(['scan'], scanRepo.dir);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /when src\/(bun|deno)\/ssg\.ts changed, src\/(bun|deno)\/ssg\.ts changed too/);
      assert.doesNotMatch(result.stdout, /when ssg\.ts changed, ssg\.ts changed too/);
    } finally {
      scanRepo.cleanup();
    }
  });

  it('finds the ghost wire and classifies the other relationships', async () => {
    const ctx = await loadContext(repo.dir, flags);
    const result = scan(ctx, { limit: 10, kinds: ['ghost', 'unknown', 'direct', 'test'] });
    const kinds = new Map(result.relationships.map((r) => [[r.from, r.to].sort().join(' + '), r.relationship]));
    assert.equal(kinds.get('src/billing.ts + templates/invoice-template.ts'), 'ghost');
    assert.equal(kinds.get('src/api.ts + src/db.ts'), 'direct');
    assert.equal(kinds.get('src/api.test.ts + src/api.ts'), 'test');
    const ghost = result.relationships.find((r) => r.relationship === 'ghost')!;
    assert.equal(ghost.shared, 7); // six billing changes plus the initial commit
    assert.equal(ghost.confidence, 1);
    assert.equal(ghost.evidence.length, 3);
    assert.equal(ghost.evidence[0]!.subject, 'billing change 5');
    assert.equal(result.counts.ghost, 1);
    const capped = classifiedPairs(ctx, 1);
    assert.equal(capped.entries.length, 1);
    assert.ok(capped.qualifying > capped.entries.length);
    assert.equal(capped.truncated, true);
  });
});

describe('diff', () => {
  it('flags the untouched partner of a staged, unstaged or untracked change', async () => {
    repo.write('src/billing.ts', 'export const bill = 2\n');
    try {
      const ctx = await loadContext(repo.dir, flags);
      const result = await diff(ctx, { limit: 10, kinds: ['ghost', 'unknown', 'direct', 'test'] });
      assert.deepEqual(result.changed.map((c) => c.path), ['src/billing.ts']);
      assert.deepEqual(result.suggestions.map((s) => [s.to, s.relationship]), [['templates/invoice-template.ts', 'ghost']]);

      repo.write('templates/invoice-template.ts', 'export const template = `<p>changed</p>`\n');
      repo.git('add', 'templates/invoice-template.ts');
      const both = await diff(await loadContext(repo.dir, flags), { limit: 10, kinds: ['ghost'] });
      assert.deepEqual(both.suggestions, []);
    } finally {
      repo.git('reset', '-q', '--hard');
    }
  });

  it('looks up history under the old name of an uncommitted rename', async () => {
    repo.git('mv', 'src/billing.ts', 'src/payments.ts');
    try {
      const ctx = await loadContext(repo.dir, flags);
      const result = await diff(ctx, { limit: 10, kinds: ['ghost', 'unknown', 'direct', 'test'] });
      const moved = result.changed.find((c) => c.path === 'src/payments.ts')!;
      assert.equal(moved.historyPath, 'src/billing.ts');
      assert.deepEqual(result.suggestions.map((s) => s.to), ['templates/invoice-template.ts']);
    } finally {
      repo.git('reset', '-q', '--hard');
    }
  });

  it('includes branch commits with --base', async () => {
    repo.git('checkout', '-q', '-b', 'feature');
    try {
      repo.touch(['src/billing.ts'], 'feature work');
      const ctx = await loadContext(repo.dir, flags);
      const result = await diff(ctx, { base: 'main', limit: 10, kinds: ['ghost'] });
      assert.deepEqual(result.changed.map((c) => [c.path, c.sources.join()]), [['src/billing.ts', 'branch']]);
      assert.equal(result.suggestions[0]?.to, 'templates/invoice-template.ts');
      await assert.rejects(diff(ctx, { base: 'no-such-branch', limit: 10, kinds: ['ghost'] }), /not a branch/);
    } finally {
      repo.git('checkout', '-q', 'main');
      repo.git('branch', '-q', '-D', 'feature');
    }
  });
});

describe('file', () => {
  it('reports churn, owners and companions for a path given relative to cwd', async () => {
    const ctx = await loadContext(join(repo.dir, 'src'), flags);
    const result = fileReport(ctx, 'billing.ts', { limit: 5 });
    assert.equal(result.path, 'src/billing.ts');
    assert.equal(result.changes, 7);
    assert.equal(result.companions[0]?.to, 'templates/invoice-template.ts');
    assert.equal(result.companions[0]?.wouldAlert, true);
    assert.throws(() => fileReport(ctx, '../nope.ts', { limit: 5 }), /Nothing to show/);
  });
});

describe('map', () => {
  it('promotes recent mutual links without treating parent folders or hubs as independent areas', () => {
    const now = Date.parse('2026-10-16T00:00:00Z');
    const view = { from: 'src/router/a.ts', to: 'src/adapter/b.ts', confidence: 0.8, reverseConfidence: 0.6, lastTogether: '2026-10-01' };
    const priority = (overrides: Partial<typeof view> = {}) => mapOverviewPriority({ ...view, ...overrides }, 0.4, now);
    assert.equal(priority(), 2);
    assert.equal(priority({ from: 'src/hono.ts', to: 'src/preset/tiny.ts' }), 1);
    assert.equal(priority({ from: 'src/preset/tiny.ts', to: 'src/hono.ts' }), 1);
    assert.equal(priority({ from: 'hono.ts' }), 1);
    assert.equal(priority({ reverseConfidence: 0.04 }), 0);
    assert.equal(priority({ lastTogether: '2024-01-01' }), 0);
    assert.equal(priority({ lastTogether: 'invalid' }), 0);
    assert.equal(mapOverviewPriority({ ...view, hiddenBridge: { signal: 'parallel-implementation', value: 'a.ts', filesUsing: 2 } }, 0.4, now), 1);
    assert.equal(priority({ from: 'src/routes/a.ts', to: 'src/routes-other/b.ts' }), 2);
  });

  it('builds nodes and edges for the strongest relationships', async () => {
    const ctx = await loadContext(repo.dir, flags);
    const data = buildMapData(ctx, { edges: 2, kinds: ['ghost', 'direct', 'test', 'unknown'] });
    assert.equal(data.edges.length, 2);
    for (const e of data.edges) {
      assert.ok(data.nodes[e.source] && data.nodes[e.target]);
      assert.ok(e.fromChanges >= e.shared);
      assert.ok(e.toChanges >= e.shared);
      assert.ok(e.score >= 0 && e.score <= 1);
      assert.equal(e.weighted, false);
    }
    const ghost = buildMapData(ctx, { edges: 1, kinds: ['ghost'] }).edges[0];
    assert.ok(ghost);
    assert.equal(ghost?.crossesDirectories, true);
  });

  it('caps unchecked links only when primary relationships are also requested', async () => {
    const mapRepo = new FixtureRepo();
    try {
      for (let i = 0; i < 3; i++) {
        mapRepo.touch(['src/a.ts', 'src/b.ts'], `code ${i}`);
        mapRepo.touch(['docs/a.md', 'docs/b.md'], `docs ${i}`);
      }
      const ctx = await loadContext(mapRepo.dir, flags);
      const mixed = buildMapData(ctx, { edges: 10, kinds: ['ghost', 'unknown'], uncheckedCap: 0 });
      assert.deepEqual(mixed.edges.map((edge) => edge.relationship), ['ghost']);

      const uncapped = buildMapData(ctx, { edges: 10, kinds: ['ghost', 'unknown'] });
      assert.deepEqual(new Set(uncapped.edges.map((edge) => edge.relationship)), new Set(['ghost', 'unknown']));

      const unknownOnly = buildMapData(ctx, { edges: 10, kinds: ['unknown'], uncheckedCap: 0 });
      assert.deepEqual(unknownOnly.edges.map((edge) => edge.relationship), ['unknown']);
    } finally {
      mapRepo.cleanup();
    }
  });
});

describe('backtest', () => {
  it('reports a current-code ghost subset without altering the default strategies', async () => {
    const historyRepo = new FixtureRepo();
    try {
      for (let index = 0; index < 40; index++) {
        historyRepo.commit({
          message: `update ${index}`, write: {
            'src/a.ts': `import './b'; export const value = ${index};`,
            'src/b.ts': `export const value = ${index};`,
            'src/c.ts': `export const value = ${index};`,
          }
        });
      }
      const ctx = await loadContext(historyRepo.dir, flags);
      const options = { k: 2, testFraction: 0.2 };
      const flat = backtest(ctx, options);
      const report = backtest(ctx, { ...options, ghosts: true });
      assert.equal(flat.ghostDiagnostics, undefined);
      assert.deepEqual(report.strategies, flat.strategies);
      assert.equal(report.ghostDiagnostics?.suggestions, 32);
      assert.equal(report.ghostDiagnostics?.correct, 32);
      assert.equal(report.ghostDiagnostics?.queries, 24);
      assert.equal(report.ghostDiagnostics?.precision, 1);
      assert.match(report.ghostDiagnostics?.caveat ?? '', /leaks future information/);
      const cli = runCli(['backtest', '--ghosts', '--json', '-k', '2'], historyRepo.dir);
      assert.equal(cli.code, 0, cli.stderr);
      assert.deepEqual(JSON.parse(cli.stdout).ghostDiagnostics, report.ghostDiagnostics);
    } finally {
      historyRepo.cleanup();
    }
  });

  const make = (n: number): HistoryCommit[] => {
    const commits: HistoryCommit[] = [];
    for (let i = 0; i < n; i++) {
      const files = i % 2 === 0 ? ['a.ts', 'b.ts'] : ['c.ts'];
      commits.push({ hash: `h${i}`, author: 'x', time: i, commitTime: i, subject: `s${i}`, files });
    }
    return commits;
  };

  it('scores a perfectly predictable history as perfect and beats the baseline', () => {
    const result = backtestCommits(make(100), { minShared: 3, minConfidence: 0.4 }, { testFraction: 0.2, k: 1 });
    const [model] = result.strategies;
    assert.equal(model!.hitRate, 1);
    assert.equal(model!.precision, 1);
    assert.equal(model!.falseAlarmRate, 0);
    assert.equal(result.test.commits, 20);
    assert.ok(result.queries > 0);
  });

  it('replays the same held-out commits whatever the filters', () => {
    const commits = make(100);
    const sweep: HistoryCommit = { hash: 'big', author: 'x', time: 99.5, commitTime: 99.5, subject: 'sweep', files: Array.from({ length: 10 }, (_, i) => `f${i}.ts`) };
    const huge: HistoryCommit = { ...sweep, hash: 'huge', commitTime: 99.6, files: Array.from({ length: EVALUATION_MAX_FILES + 1 }, (_, i) => `g${i}.ts`) };
    const a = backtestCommits(commits, { minShared: 3, minConfidence: 0.4 }, { testFraction: 0.2, k: 3 }, undefined, [sweep, huge]);
    const b = backtestCommits([...commits, sweep], { minShared: 3, minConfidence: 0.4 }, { testFraction: 0.2, k: 3 }, undefined, [huge]);
    assert.equal(a.test.commits, b.test.commits);
  });

  it('refuses tiny histories', () => {
    assert.throws(() => backtestCommits(make(10), { minShared: 3, minConfidence: 0.4 }, { testFraction: 0.2, k: 3 }), /at least/);
  });

  it('does not replace top-k suggestions when none are classified as ghosts', () => {
    const report = backtestCommits(make(100), flags, { testFraction: 0.2, k: 1, ghosts: true }, undefined, [], () => false);
    assert.equal(report.ghostDiagnostics?.fired, 0);
    assert.equal(report.ghostDiagnostics?.suggestions, 0);
    assert.equal(report.ghostDiagnostics?.hitRate, 0);
    assert.equal(report.strategies[0]?.hitRate, 1);
  });

  it('counts incorrect ghost suggestions as false alarms rather than abstentions', () => {
    const commits: HistoryCommit[] = Array.from({ length: 40 }, (_, index) => ({
      hash: `commit${index}`, author: 'Test', time: index, commitTime: index, subject: '',
      files: index < 30 ? ['a.ts', 'b.ts'] : ['a.ts'],
    }));
    const report = backtestCommits(commits, flags, { testFraction: 0.25, k: 1, ghosts: true }, undefined, [], () => true);
    assert.equal(report.ghostDiagnostics?.queries, 10);
    assert.equal(report.ghostDiagnostics?.fired, 10);
    assert.equal(report.ghostDiagnostics?.suggestions, 10);
    assert.equal(report.ghostDiagnostics?.correct, 0);
    assert.equal(report.ghostDiagnostics?.coverage, 1);
    assert.equal(report.ghostDiagnostics?.falseAlarmRate, 1);
    assert.equal(report.ghostDiagnostics?.hitRate, 0);
    assert.equal(report.ghostDiagnostics?.precision, 0);
  });

  it('stops recommending a file after its deletion', () => {
    const commits: HistoryCommit[] = [];
    for (let i = 0; i < 30; i++) commits.push({ hash: `pair${i}`, author: 'x', time: i, commitTime: i, subject: '', files: ['a.ts', 'b.ts'] });
    commits.push({ hash: 'delete', author: 'x', time: 30, commitTime: 30, subject: '', files: ['b.ts'], deleted: ['b.ts'] });
    for (let i = 31; i < 40; i++) commits.push({ hash: `solo${i}`, author: 'x', time: i, commitTime: i, subject: '', files: ['a.ts'] });
    commits.forEach((commit, index) => {
      commit.commitTime = 1;
      commit.logOrder = commits.length - index - 1;
    });

    const result = backtestCommits(commits, { minShared: 3, minConfidence: 0.4 }, { testFraction: 0.25, k: 1 });
    assert.equal(result.strategies[0]!.fired, 1); // deletion commit only; later a.ts changes do not suggest b.ts
  });
});

describe('cli', () => {
  it('prints JSON for every command', () => {
    for (const args of [['scan'], ['diff'], ['file', 'src/billing.ts'], ['map', '--no-open', '-o', join(repo.dir, '..', `map-${process.pid}.html`)]]) {
      const out = runCli([...args, '--json'], repo.dir);
      assert.equal(out.code, 0, `${args.join(' ')}: ${out.stderr}`);
      assert.doesNotThrow(() => JSON.parse(out.stdout), args.join(' '));
    }
    const mapFile = join(repo.dir, '..', `map-${process.pid}.html`);
    assert.ok(existsSync(mapFile));
    assert.ok(readFileSync(mapFile, 'utf8').includes('Ghost wires in'));
    rmSync(mapFile);
  });

  it('shows scan when clean and diff when dirty, while honouring global flags', () => {
    const clean = runCli(['--min-shared', '2', '--json'], repo.dir);
    assert.equal(clean.code, 0, clean.stderr);
    const cleanResult = JSON.parse(clean.stdout);
    assert.equal(cleanResult.mode, 'scan');
    assert.equal(cleanResult.meta.settings.minShared, 2);
    assert.ok(cleanResult.relationships.some((r: { to: string }) => r.to === 'templates/invoice-template.ts'));
    assert.match(runCli(['--min-shared', '2'], repo.dir).stdout, /repo-archaeology map/);

    writeFileSync(join(repo.dir, 'src/billing.ts'), 'changed\n');
    try {
      const dirty = runCli(['--min-shared', '2', '--json'], repo.dir);
      assert.equal(dirty.code, 0, dirty.stderr);
      const dirtyResult = JSON.parse(dirty.stdout);
      assert.equal(dirtyResult.mode, 'diff');
      assert.deepEqual(dirtyResult.changed.map((f: { path: string }) => f.path), ['src/billing.ts']);
      assert.equal(dirtyResult.suggestions[0]?.to, 'templates/invoice-template.ts');
    } finally {
      repo.git('checkout', '-q', '--', 'src/billing.ts');
    }

    writeFileSync(join(repo.dir, 'package-lock.json'), '{}\n');
    try {
      const noHistory = JSON.parse(runCli(['--json'], repo.dir).stdout);
      assert.equal(noHistory.mode, 'scan');
      assert.equal(noHistory.changedWithoutHistory, 1);
    } finally {
      rmSync(join(repo.dir, 'package-lock.json'));
    }

    const explicit = runCli(['scan', '--min-shared', '2', '--json'], repo.dir);
    assert.equal(JSON.parse(explicit.stdout).meta.settings.minShared, 2);
  });

  it('exits 1 from diff --exit-code only when something looks missed', () => {
    assert.equal(runCli(['diff', '--exit-code'], repo.dir).code, 0);
    writeFileSync(join(repo.dir, 'src/billing.ts'), 'changed\n');
    try {
      assert.equal(runCli(['diff', '--exit-code'], repo.dir).code, 1);
    } finally {
      repo.git('checkout', '-q', '--', 'src/billing.ts');
    }
  });

  it('explains environment problems with exit code 2', () => {
    const empty = mkdtempSync(join(tmpdir(), 'ra-empty-'));
    try {
      const notRepo = runCli(['scan'], empty);
      assert.equal(notRepo.code, 2);
      assert.match(notRepo.stderr, /not inside a git repository/);
      spawnSync('git', ['init', '-q'], { cwd: empty });
      const noCommits = runCli(['scan'], empty);
      assert.equal(noCommits.code, 2);
      assert.match(noCommits.stderr, /no commits yet/);
      assert.equal(runCli(['scan', '--min-confidence', '7'], repo.dir).code, 1); // commander rejects bad flags
      writeFileSync(join(empty, '.repo-archaeology.json'), '{ "minShared": "lots" }');
      spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'x'], { cwd: empty, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
      const badConfig = runCli(['scan'], empty);
      assert.equal(badConfig.code, 2);
      assert.match(badConfig.stderr, /minShared/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
