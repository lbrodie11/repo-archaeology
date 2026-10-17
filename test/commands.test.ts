import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { backtest, backtestCommits, EVALUATION_MAX_FILES } from '../src/commands/backtest.js';
import { collectChanges, diff } from '../src/commands/diff.js';
import { fileReport } from '../src/commands/file.js';
import { followUpBenchmark, followUpBenchmarkCommits, printFollowUpBenchmarkSection } from '../src/commands/followup-benchmark.js';
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

describe('explain my silence (diff diagnostics when 0 suggestions are produced)', () => {
  it('distinguishes all six silence categories without claiming a change is safe', async () => {
    const r = new FixtureRepo();
    const extraDirs: string[] = [];
    try {
      for (let i = 0; i < 5; i++) {
        r.touch(['src/billing.ts', 'templates/invoice-template.ts'], `billing ${i}`);
        r.commit({
          message: `api ${i}`,
          write: {
            'src/db.ts': `export const db = ${i + 1};\n`,
            'src/api.ts': `import { db } from './db';\nexport const api = ${i + 1};\n`,
          },
        });
      }
      // File that only ever changed in solo commits (0 co-change partners)
      for (let i = 0; i < 4; i++) {
        r.touch(['src/isolated.ts'], `isolated ${i}`);
      }

      // 1. No files changed
      const cleanCtx = await loadContext(r.dir, flags);
      const noChanges = await diff(cleanCtx, { limit: 10, kinds: ['ghost', 'direct', 'indirect', 'test', 'unknown'] });
      assert.equal(noChanges.suggestions.length, 0);
      assert.equal(noChanges.silence?.primaryReason, 'no_changed_files');
      assert.equal(noChanges.silence?.changedFiles, 0);

      // 2. Changed files lack usable history
      r.write('src/brand-new.ts', 'export const fresh = 1;\n');
      const noHistoryRes = await diff(await loadContext(r.dir, flags), { limit: 10, kinds: ['ghost'] });
      assert.equal(noHistoryRes.silence?.primaryReason, 'no_history_for_changed_files');
      assert.equal(noHistoryRes.silence?.changedFiles, 1);
      assert.equal(noHistoryRes.silence?.changedWithHistory, 0);
      const cliNoHistory = runCli(['diff'], r.dir);
      assert.match(cliNoHistory.stdout, /none of the changed files have usable history/);
      assert.doesNotMatch(cliNoHistory.stdout, /Nothing obviously missing|safe/i);
      rmSync(join(r.dir, 'src/brand-new.ts'));

      // 3. No qualifying historical relationships exist (0 co-change partners)
      r.write('src/isolated.ts', 'export const isolated = "edited";\n');
      const isolatedRes = await diff(await loadContext(r.dir, flags), { limit: 10, kinds: ['ghost', 'direct', 'unknown'] });
      assert.equal(isolatedRes.silence?.primaryReason, 'no_cochange_partners');
      assert.equal(isolatedRes.silence?.rawCompanions, 0);
      const cliIsolated = runCli(['diff'], r.dir);
      assert.match(cliIsolated.stdout, /no other live file in the baseline model ever co-changed/);
      assert.match(cliIsolated.stdout, /does not guarantee the change is complete/);
      assert.doesNotMatch(cliIsolated.stdout, /Nothing obviously missing/);
      r.git('checkout', '-q', '--', 'src/isolated.ts');

      // 4. Companions exist but are already included in the changeset
      r.write('src/billing.ts', 'export const bill = 99;\n');
      r.write('templates/invoice-template.ts', 'export const tpl = 99;\n');
      const touchedRes = await diff(await loadContext(r.dir, flags), { limit: 10, kinds: ['ghost'] });
      assert.equal(touchedRes.silence?.primaryReason, 'all_companions_touched');
      assert.ok((touchedRes.silence?.touchedCompanions ?? 0) >= 1);
      assert.match(touchedRes.silence?.details[0] ?? '', /already included in this changeset/);
      const cliTouched = runCli(['diff'], r.dir);
      assert.match(cliTouched.stdout, /already included in this changeset/);
      assert.doesNotMatch(cliTouched.stdout, /Nothing obviously missing/);
      r.git('checkout', '-q', '--', 'src/billing.ts', 'templates/invoice-template.ts');

      // 5a. Excluded by configured relationship kind filter (--kinds)
      r.write('src/api.ts', "import { db } from './db';\nexport const api = 999;\n");
      const kindFilteredRes = await diff(await loadContext(r.dir, flags), { limit: 10, kinds: ['ghost'] });
      assert.equal(kindFilteredRes.silence?.primaryReason, 'filtered_by_kinds');
      assert.equal(kindFilteredRes.silence?.filteredByKind, 1);
      assert.match(kindFilteredRes.silence?.details[0] ?? '', /excluded by --kinds \(direct\)/);
      r.git('checkout', '-q', '--', 'src/api.ts');

      // 5b. Excluded by configured thresholds (--min-shared / --min-confidence)
      r.write('src/billing.ts', 'export const bill = 100;\n');
      const thresholdFilteredRes = await diff(
        await loadContext(r.dir, { minShared: 20, minConfidence: 0.95 }),
        { limit: 10, kinds: ['ghost', 'direct', 'unknown'] },
      );
      assert.equal(thresholdFilteredRes.silence?.primaryReason, 'filtered_by_thresholds');
      assert.ok((thresholdFilteredRes.silence?.filteredByThreshold ?? 0) >= 1);
      assert.match(thresholdFilteredRes.silence?.details[0] ?? '', /fell below thresholds/);
      r.git('checkout', '-q', '--', 'src/billing.ts');

      // 6. Analysis limited by shallow or insufficient Git history
      const shallowDir = mkdtempSync(join(tmpdir(), 'ra-silence-shallow-'));
      extraDirs.push(shallowDir);
      spawnSync('git', ['clone', '-q', '--depth', '1', `file://${r.dir}`, shallowDir]);
      writeFileSync(join(shallowDir, 'src/billing.ts'), 'export const shallowEdit = 1;\n');
      const shallowCtx = await loadContext(shallowDir, { minShared: 3, minConfidence: 0.4 });
      const shallowRes = await diff(shallowCtx, { limit: 10, kinds: ['ghost'] });
      assert.equal(shallowRes.silence?.shallowHistory, true);
      assert.ok(shallowRes.silence?.reasons.includes('limited_repo_history'));
      assert.equal(shallowRes.silence?.primaryReason, 'limited_repo_history');
      assert.ok(shallowRes.silence?.details.some((d) => /shallow|insufficient/i.test(d)));
    } finally {
      r.cleanup();
      extraDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    }
  });

  it('flags partial history truncated by --max-commits or --since via structured flags (S1)', async () => {
    const r = new FixtureRepo();
    try {
      for (let i = 0; i < 60; i++) {
        r.touch(['src/solo.ts'], `solo ${i}`, { day: i });
      }
      r.write('src/solo.ts', 'export const edited = true;\n');

      // Full 60-commit history is not limited
      const fullCtx = await loadContext(r.dir, { minShared: 3, minConfidence: 0.4, maxCommits: 5000 });
      const fullRes = await diff(fullCtx, { limit: 10, kinds: ['ghost'] });
      assert.equal(fullRes.silence?.limitedHistory, false);
      assert.ok(!fullRes.silence?.reasons.includes('limited_repo_history'));

      // Truncated by --max-commits (55 < 60 actual commits, even though 55 >= 50)
      const truncatedCtx = await loadContext(r.dir, { minShared: 3, minConfidence: 0.4, maxCommits: 55 });
      assert.equal(truncatedCtx.history.stats.truncated, true);
      const truncatedRes = await diff(truncatedCtx, { limit: 10, kinds: ['ghost'] });
      assert.equal(truncatedRes.silence?.limitedHistory, true);
      assert.ok(truncatedRes.silence?.reasons.includes('limited_repo_history'));
      assert.ok(truncatedRes.silence?.details.some((d) => /--max-commits/i.test(d)));

      // --since before repo root excludes 0 commits -> not limited
      const unTruncatedSinceCtx = await loadContext(r.dir, { minShared: 3, minConfidence: 0.4, since: '2020-01-01' });
      assert.equal(unTruncatedSinceCtx.history.stats.truncatedBySince, false);
      const unTruncatedSinceRes = await diff(unTruncatedSinceCtx, { limit: 10, kinds: ['ghost'] });
      assert.equal(unTruncatedSinceRes.silence?.limitedHistory, false);

      // --since after repo root excludes earlier commits -> limitedHistory = true
      const sinceCtx = await loadContext(r.dir, { minShared: 3, minConfidence: 0.4, since: '2024-02-01' });
      assert.equal(sinceCtx.history.stats.truncatedBySince, true);
      const sinceRes = await diff(sinceCtx, { limit: 10, kinds: ['ghost'] });
      assert.equal(sinceRes.silence?.limitedHistory, true);
      assert.ok(sinceRes.silence?.reasons.includes('limited_repo_history'));
      assert.ok(sinceRes.silence?.details.some((d) => /--since/i.test(d)));
    } finally {
      r.cleanup();
    }
  });

  it('recognizes a companion renamed in the active branch changeset as touched rather than deleted (S2) and preserves caller warnings (C1)', async () => {
    const r = new FixtureRepo();
    try {
      for (let i = 0; i < 5; i++) {
        r.touch(['src/a.ts', 'src/c.ts'], `pair ${i}`);
      }
      r.git('checkout', '-qb', 'feature');
      r.git('mv', 'src/c.ts', 'src/d.ts');
      r.git('commit', '-qm', 'rename c -> d');
      r.write('src/a.ts', 'export const a = "edited";\n');

      const ctx = await loadContext(r.dir, flags, { base: 'main' });
      const res = await diff(ctx, { base: 'main', limit: 10, kinds: ['ghost'] });
      assert.equal(res.suggestions.length, 0);
      assert.equal(res.silence?.deletedCompanions, 0);
      assert.equal(res.silence?.primaryReason, 'all_companions_touched');
      assert.ok((res.silence?.touchedCompanions ?? 0) >= 1);

      // C1: merge commit on branch does not mutate caller's ctx.warnings when calling collectChanges or diff
      r.git('checkout', '-q', 'main');
      r.touch(['src/side.ts'], 'main advance');
      r.git('checkout', '-q', 'feature');
      r.git('merge', '--no-ff', '-qm', 'merge main into feature', 'main');

      const callerCtx = await loadContext(r.dir, flags, { base: 'main' });
      const beforeWarnings = [...callerCtx.warnings];
      await collectChanges(callerCtx, 'main');
      assert.deepEqual(callerCtx.warnings, beforeWarnings);
      const mergeDiff = await diff(callerCtx, { base: 'main', limit: 10, kinds: ['ghost'] });
      assert.deepEqual(callerCtx.warnings, beforeWarnings);
      assert.ok(mergeDiff.meta.warnings.some((w) => /merge commits/i.test(w)));
    } finally {
      r.cleanup();
    }
  });

  it('prioritizes no_cochange_partners when 0 partners exist and filtered_by_thresholds when untouched partners were filtered (S3)', async () => {
    const r = new FixtureRepo();
    try {
      // 10 filler commits so total repo history >= minShared (5)
      for (let i = 0; i < 10; i++) {
        r.touch(['src/a.ts', 'src/b.ts'], `pair ${i}`);
      }
      // lonely.ts has only 1 commit (< minShared=5) and 0 co-change partners
      r.touch(['src/lonely.ts'], 'lonely commit');
      // weak.ts co-changes with a.ts only once (below minShared=5)
      r.touch(['src/a.ts', 'src/weak.ts'], 'weak link');

      // Finding 1: lonely.ts has < minShared commits AND 0 partners -> primaryReason is no_cochange_partners
      r.write('src/lonely.ts', 'export const lonely = 2;\n');
      const lonelyRes = await diff(
        await loadContext(r.dir, { minShared: 5, minConfidence: 0.4 }),
        { limit: 10, kinds: ['ghost'] },
      );
      assert.equal(lonelyRes.silence?.rawCompanions, 0);
      assert.equal(lonelyRes.silence?.primaryReason, 'no_cochange_partners');
      assert.ok(!lonelyRes.silence?.reasons.includes('filtered_by_thresholds'));
      r.git('checkout', '-q', '--', 'src/lonely.ts');

      // Finding 2: touching a.ts + b.ts while weak.ts is untouched and below thresholds ->
      // primaryReason is filtered_by_thresholds, with all_companions_touched secondary
      r.write('src/a.ts', 'export const a = 999;\n');
      r.write('src/b.ts', 'export const b = 999;\n');
      const mixedRes = await diff(
        await loadContext(r.dir, { minShared: 5, minConfidence: 0.4 }),
        { limit: 10, kinds: ['ghost'] },
      );
      assert.equal(mixedRes.silence?.primaryReason, 'filtered_by_thresholds');
      assert.deepEqual(mixedRes.silence?.reasons.slice(0, 2), ['filtered_by_thresholds', 'all_companions_touched']);
    } finally {
      r.cleanup();
    }
  });
});

describe('follow-up fix benchmark', () => {
  it('trains strictly on pre-change history before each candidate and reports matches, false positives, coverage, and baselines', () => {
    const commits: HistoryCommit[] = [];
    let t = 1_700_000_000;
    const pushCommit = (hash: string, files: string[], subject: string, deltaHours = 24, author = 'Alice') => {
      t += deltaHours * 3600;
      commits.push({ hash, author, authorEmail: `${author.toLowerCase()}@example.com`, time: t, commitTime: t, subject, files });
    };

    // Initial training history (24 commits):
    // - popular1.ts and popular2.ts change often so popularity baseline prefers them
    for (let i = 0; i < 10; i++) pushCommit(`pop-${i}`, ['src/popular1.ts', 'src/popular2.ts'], `popular work ${i}`);
    // - billing.ts and invoice.ts co-change 4 times (100% confidence, meets minShared=3)
    for (let i = 0; i < 4; i++) pushCommit(`bill-${i}`, ['src/billing.ts', 'templates/invoice.ts'], `billing pair ${i}`);
    // - earlyA.ts and earlyB.ts co-change ONLY TWICE before the held-out window (below minShared=3!)
    for (let i = 0; i < 2; i++) pushCommit(`early-${i}`, ['src/earlyA.ts', 'src/earlyB.ts'], `early pair ${i}`);
    // - filler solo commits so held-out 25% covers the candidate sequence below
    for (let i = 0; i < 8; i++) pushCommit(`solo-${i}`, ['src/unrelated.ts'], `solo ${i}`);

    // Held-out window (8 commits -> testFraction = 8 / 32 = 0.25):
    // Candidate 1: initial commit touches earlyA.ts, followed 1h later by fix touching earlyB.ts.
    // Because earlyA.ts + earlyB.ts only have 2 prior co-changes before `c1-init`, `co-change` (minShared=3)
    // MUST NOT trigger on Candidate 1, even though they co-change again later in the held-out window!
    pushCommit('c1-init', ['src/earlyA.ts'], 'feat: update earlyA', 24, 'Alice');
    pushCommit('c1-fix', ['src/earlyB.ts'], 'fix: forgot earlyB companion', 1, 'Alice');

    // Now earlyA.ts and earlyB.ts co-change twice more so they reach 4 shared commits BEFORE Candidate 2
    pushCommit('mid-pair-1', ['src/earlyA.ts', 'src/earlyB.ts'], 'pair update 1', 24, 'Alice');
    pushCommit('mid-pair-2', ['src/earlyA.ts', 'src/earlyB.ts'], 'pair update 2', 24, 'Alice');

    // Candidate 2: initial commit touches earlyA.ts, followed 2h later by follow-up touching earlyB.ts.
    // Now pre-candidate history has 4 shared commits, so `co-change` triggers and matches earlyB.ts!
    pushCommit('c2-init', ['src/earlyA.ts'], 'feat: second earlyA change', 24, 'Alice');
    pushCommit('c2-fix', ['src/earlyB.ts'], 'follow-up: sync earlyB', 2, 'Alice');

    // Candidate 3 (False positive): initial commit touches billing.ts, followed 1h later by same-author commit
    // touching unrelated.ts (NOT templates/invoice.ts). `co-change` recommends templates/invoice.ts -> false positive!
    pushCommit('c3-init', ['src/billing.ts'], 'feat: tweak billing', 24, 'Bob');
    pushCommit('c3-next', ['src/unrelated.ts'], 'chore: touch unrelated', 1, 'Bob');

    const report = followUpBenchmarkCommits(
      commits,
      { minShared: 3, minConfidence: 0.5 },
      { testFraction: 0.25, k: 1, windowHours: 12 },
    );

    assert.equal(report.modelsBuilt, 1);
    assert.equal(report.candidatesEvaluated, 3);
    assert.equal(report.totalLaterFiles, 3);

    // Verify Candidate 1 did NOT leak future co-changes from mid-pair-1 / mid-pair-2
    const case1 = report.cases.find((c) => c.initialCommit.hash === 'c1-init')!;
    assert.deepEqual(case1.recommended, []);
    assert.deepEqual(case1.matched, []);
    assert.ok(case1.signals.includes('subject-cue'));

    // Verify Candidate 2 trained on commits up to c2-init and matched src/earlyB.ts
    const case2 = report.cases.find((c) => c.initialCommit.hash === 'c2-init')!;
    assert.ok(case2.trainingCommitsBefore > case1.trainingCommitsBefore);
    assert.deepEqual(case2.recommended, ['src/earlyB.ts']);
    assert.deepEqual(case2.matched, ['src/earlyB.ts']);
    assert.deepEqual(case2.falsePositives, []);

    // Verify Candidate 3 recorded templates/invoice.ts as a false positive
    const case3 = report.cases.find((c) => c.initialCommit.hash === 'c3-init')!;
    assert.deepEqual(case3.recommended, ['templates/invoice.ts']);
    assert.deepEqual(case3.matched, []);
    assert.deepEqual(case3.falsePositives, ['templates/invoice.ts']);

    const [cochange, noThresholds, popularity, popularitySame] = report.strategies;
    assert.equal(cochange!.candidates, 3);
    assert.equal(cochange!.triggered, 2); // c2-init and c3-init
    assert.equal(cochange!.coverage, 2 / 3);
    assert.equal(cochange!.recommendations, 2);
    assert.equal(cochange!.correctMatches, 1); // c2-init
    assert.equal(cochange!.falsePositives, 1); // c3-init
    assert.equal(cochange!.hitCandidates, 1);
    assert.equal(cochange!.falseAlarmCandidates, 1);
    assert.equal(cochange!.hitRate, 0.5);
    assert.equal(cochange!.precision, 0.5);

    // No-thresholds strategy triggers on all 3 candidates and matches both c1-init and c2-init
    assert.equal(noThresholds!.triggered, 3);
    assert.equal(noThresholds!.correctMatches, 2);
    assert.equal(noThresholds!.falsePositives, 1);

    // Popularity baseline always guesses src/popular1.ts (0 matches)
    assert.equal(popularity!.triggered, 3);
    assert.equal(popularity!.correctMatches, 0);
    assert.equal(popularitySame!.triggered, 2);
    assert.equal(popularitySame!.correctMatches, 0);

    // Per-signal breakdown isolates subject-cue (c1 + c2 = 2 pairs) vs immediate-same-author (all 3)
    assert.equal(report.bySignal['subject-cue'].candidates, 2);
    assert.equal(report.bySignal['subject-cue'].strategies[0]?.triggered, 1);
    assert.equal(report.bySignal['subject-cue'].strategies[0]?.correctMatches, 1);
    assert.equal(report.bySignal['immediate-same-author'].candidates, 3);

    // Honest methodology and limitations are included
    assert.match(report.methodology, /committer timestamp/);
    assert.match(report.methodology, /strictly on commits preceding the initial commit/);
    assert.ok(report.limitations.some((l) => /not confirmed bug fixes or omissions/i.test(l)));
  });

  it('requires same author (B1), pairs two-pass without dropping valid candidates (B2), and matches recommendation budgets (B3)', () => {
    // B1: Alice's commit followed by Bob's "fix" commit inside the window -> 0 candidates
    const b1Commits: HistoryCommit[] = [];
    let t = 1_700_000_000;
    for (let i = 0; i < 8; i++) {
      t += 3600;
      b1Commits.push({
        hash: `train-${i}`,
        author: 'Alice',
        authorEmail: 'alice@example.com',
        time: t,
        commitTime: t,
        subject: `pair ${i}`,
        files: ['src/a.ts', 'src/b.ts'],
      });
    }
    t += 3600;
    b1Commits.push({
      hash: 'alice-init',
      author: 'Alice',
      authorEmail: 'alice@example.com',
      time: t,
      commitTime: t,
      subject: 'feat: touch a',
      files: ['src/a.ts'],
    });
    t += 600;
    b1Commits.push({
      hash: 'bob-fix',
      author: 'Bob',
      authorEmail: 'bob@example.com',
      time: t,
      commitTime: t,
      subject: 'fix: touch b',
      files: ['src/b.ts'],
    });
    const b1Report = followUpBenchmarkCommits(b1Commits, { minShared: 3, minConfidence: 0.5 }, { testFraction: 0.2, k: 3 });
    assert.equal(b1Report.candidatesEvaluated, 0);
    assert.equal(b1Report.strategies[0]?.coverage, null);
    assert.equal(b1Report.strategies[0]?.hitRate, null);
    assert.equal(b1Report.strategies[0]?.precision, null);

    // B2: Two initial commits I1, I2 followed by one follow-up F -> exactly 1 candidate (nearest initial I2 gets F)
    const b2Commits = b1Commits.slice(0, 8);
    t += 3600;
    b2Commits.push({
      hash: 'I1',
      author: 'Alice',
      authorEmail: 'alice@example.com',
      time: t,
      commitTime: t,
      subject: 'feat: step 1 on a',
      files: ['src/a.ts'],
    });
    t += 300;
    b2Commits.push({
      hash: 'I2',
      author: 'Alice',
      authorEmail: 'alice@example.com',
      time: t,
      commitTime: t,
      subject: 'feat: step 2 on a',
      files: ['src/a.ts'],
    });
    t += 300;
    b2Commits.push({
      hash: 'F',
      author: 'Alice',
      authorEmail: 'alice@example.com',
      time: t,
      commitTime: t,
      subject: 'fix: update b alongside a',
      files: ['src/a.ts', 'src/b.ts'],
    });
    const b2Report = followUpBenchmarkCommits(b2Commits, { minShared: 3, minConfidence: 0.5 }, { testFraction: 3 / 11, k: 3 });
    assert.equal(b2Report.candidatesEvaluated, 1);
    assert.equal(b2Report.cases[0]?.initialCommit.hash, 'I2');
    assert.equal(b2Report.cases[0]?.followUpCommit.hash, 'F');

    // Two-pass pairing regression (P1): when A[a,b,y] is followed by B[a,y], B2[z] (immediate-same-author for B),
    // X(Bob)[m], and C[y,w] (sharing y with both A and B), B claims B2 and A still pairs with C (2 candidates total).
    const p1Commits = b1Commits.slice(0, 8).map((c) => ({
      ...c,
      files: ['src/a.ts', 'src/b.ts', 'src/y.ts', 'src/z.ts', 'src/w.ts'],
    }));
    t += 3600;
    p1Commits.push({ hash: 'A', author: 'Alice', time: t, commitTime: t, subject: 'feat: A', files: ['src/a.ts', 'src/b.ts', 'src/y.ts'] });
    t += 60;
    p1Commits.push({ hash: 'B', author: 'Alice', time: t, commitTime: t, subject: 'feat: B', files: ['src/a.ts', 'src/y.ts'] });
    t += 60;
    p1Commits.push({ hash: 'B2', author: 'Alice', time: t, commitTime: t, subject: 'chore: B2', files: ['src/z.ts'] });
    t += 60;
    p1Commits.push({ hash: 'X', author: 'Bob', time: t, commitTime: t, subject: 'feat: X', files: ['src/m.ts'] });
    t += 60;
    p1Commits.push({ hash: 'C', author: 'Alice', time: t, commitTime: t, subject: 'feat: C', files: ['src/y.ts', 'src/w.ts'] });
    const p1Report = followUpBenchmarkCommits(p1Commits, { minShared: 3, minConfidence: 0.5 }, { testFraction: 5 / 13, k: 3 });
    assert.equal(p1Report.candidatesEvaluated, 2);
    assert.deepEqual(
      p1Report.cases.map((c) => `${c.initialCommit.hash}->${c.followUpCommit.hash}`),
      ['A->C', 'B->B2'],
    );

    // Weighted benchmark (--half-life): rebuilds model only when training history advances and discloses in limitations
    const weightedReport = followUpBenchmarkCommits(
      commitsWithTwoCandidates(),
      { minShared: 3, minConfidence: 0.5 },
      { testFraction: 4 / 12, k: 2 },
      30,
    );
    assert.equal(weightedReport.candidatesEvaluated, 2);
    assert.equal(weightedReport.modelsBuilt, 2);
    assert.ok(weightedReport.limitations.some((l) => /--half-life/i.test(l)));

    function commitsWithTwoCandidates(): HistoryCommit[] {
      const list: HistoryCommit[] = [];
      let ts = 1_700_000_000;
      for (let i = 0; i < 8; i++) {
        ts += 3600;
        list.push({ hash: `w-tr-${i}`, author: 'Alice', time: ts, commitTime: ts, subject: `tr ${i}`, files: ['src/a.ts', 'src/b.ts'] });
      }
      ts += 3600;
      list.push({ hash: 'w-i1', author: 'Alice', time: ts, commitTime: ts, subject: 'feat: 1', files: ['src/a.ts'] });
      ts += 300;
      list.push({ hash: 'w-f1', author: 'Alice', time: ts, commitTime: ts, subject: 'fix: 1', files: ['src/b.ts'] });
      ts += 86400 * 5;
      list.push({ hash: 'w-i2', author: 'Alice', time: ts, commitTime: ts, subject: 'feat: 2', files: ['src/a.ts'] });
      ts += 300;
      list.push({ hash: 'w-f2', author: 'Alice', time: ts, commitTime: ts, subject: 'fix: 2', files: ['src/b.ts'] });
      return list;
    }

    // B3 (F2 fixture): when k=3 and co-change makes 1 recommendation, `popularity, same changes`
    // is capped to 1 recommendation (not 3), so its precision equals its hit rate.
    const f2Commits: HistoryCommit[] = [];
    let t2 = 1_700_000_000;
    for (let i = 0; i < 6; i++) {
      t2 += 3600;
      f2Commits.push({
        hash: `pop-${i}`,
        author: 'Alice',
        time: t2,
        commitTime: t2,
        subject: `pop ${i}`,
        files: ['src/b.ts', 'src/p2.ts', 'src/p3.ts'],
      });
    }
    for (let i = 0; i < 4; i++) {
      t2 += 3600;
      f2Commits.push({
        hash: `ab-${i}`,
        author: 'Alice',
        time: t2,
        commitTime: t2,
        subject: `ab ${i}`,
        files: ['src/a.ts', 'src/b.ts'],
      });
    }
    t2 += 3600;
    f2Commits.push({ hash: 'f2-init', author: 'Alice', time: t2, commitTime: t2, subject: 'feat: a', files: ['src/a.ts'] });
    t2 += 300;
    f2Commits.push({ hash: 'f2-fix', author: 'Alice', time: t2, commitTime: t2, subject: 'fix: b', files: ['src/b.ts'] });

    const f2Report = followUpBenchmarkCommits(f2Commits, { minShared: 3, minConfidence: 0.5 }, { testFraction: 2 / 12, k: 3 });
    const [f2Cochange, , f2PopAll, f2PopSame] = f2Report.strategies;
    assert.equal(f2Cochange?.recommendations, 1);
    assert.equal(f2Cochange?.precision, 1);
    assert.equal(f2PopAll?.recommendations, 3);
    assert.equal(f2PopSame?.recommendations, 1);
    assert.equal(f2PopSame?.precision, f2PopSame?.hitRate);
  });

  it('never leaks future commits into earlier candidate recommendations, strips lifetime suffixes, and scales linearly (B4, B5)', () => {
    const baseCommits: HistoryCommit[] = [];
    let t = 1_700_000_000;
    for (let i = 0; i < 12; i++) {
      t += 3600;
      baseCommits.push({
        hash: `tr-${i}`,
        author: 'Alice',
        time: t,
        commitTime: t,
        subject: `train ${i}`,
        files: ['src/a.ts\u00001', 'src/b.ts\u00001'],
      });
    }
    // Held-out candidate pair at the same timestamp (0-second gap)
    t += 3600;
    baseCommits.push({
      hash: 'cand-init',
      logOrder: 1,
      author: 'Alice',
      time: t,
      commitTime: t,
      subject: 'feat: touch a',
      files: ['src/a.ts\u00001'],
    });
    baseCommits.push({
      hash: 'cand-follow',
      logOrder: 0,
      author: 'Alice',
      time: t,
      commitTime: t,
      subject: 'fix: touch b',
      files: ['src/b.ts\u00001'],
    });
    // Filler commits after the candidate
    for (let i = 0; i < 4; i++) {
      t += 86400 * 5;
      baseCommits.push({
        hash: `after-${i}`,
        author: 'Bob',
        time: t,
        commitTime: t,
        subject: `after ${i}`,
        files: ['src/other.ts'],
      });
    }

    const beforeFutureInjection = followUpBenchmarkCommits(
      baseCommits,
      { minShared: 3, minConfidence: 0.4 },
      { testFraction: 6 / 18, k: 2 },
    );
    const caseBefore = beforeFutureInjection.cases.find((c) => c.initialCommit.hash === 'cand-init')!;
    // Lifetime suffixes (\u00001) are stripped by pathOf in cases[]
    assert.deepEqual(caseBefore.initialCommit.files, ['src/a.ts']);
    assert.deepEqual(caseBefore.followUpCommit.laterFiles, ['src/b.ts']);
    assert.deepEqual(caseBefore.recommended, ['src/b.ts']);

    // Inject 20 future commits after `cand-follow` coupling `src/a.ts\u00001` with `src/future-trap.ts`
    const withFutureTrap: HistoryCommit[] = [
      ...baseCommits.slice(0, 14),
      ...Array.from({ length: 20 }, (_, idx) => ({
        hash: `trap-${idx}`,
        author: 'Carol',
        time: t + (idx + 1) * 86400 * 5,
        commitTime: t + (idx + 1) * 86400 * 5,
        subject: `trap ${idx}`,
        files: ['src/a.ts\u00001', 'src/future-trap.ts'],
      })),
    ];
    const afterFutureInjection = followUpBenchmarkCommits(
      withFutureTrap,
      { minShared: 3, minConfidence: 0.4 },
      { testFraction: 22 / 34, k: 2 },
    );
    const caseAfter = afterFutureInjection.cases.find((c) => c.initialCommit.hash === 'cand-init')!;
    assert.deepEqual(caseAfter.recommended, caseBefore.recommended);
    assert.ok(!caseAfter.recommended.includes('src/future-trap.ts'));

    // Scaling & model-count guard: 2,000 commits builds only 1 incremental model and caps cases[]
    const scaleCommits: HistoryCommit[] = [];
    let ts = 1_700_000_000;
    for (let i = 0; i < 2000; i++) {
      ts += 600;
      const fileA = `src/mod-${i % 20}.ts`;
      const fileB = `src/comp-${i % 20}.ts`;
      scaleCommits.push({
        hash: `s-${i}`,
        author: `dev-${i % 4}`,
        time: ts,
        commitTime: ts,
        subject: i % 2 === 0 ? `feat ${i}` : `fix ${i}`,
        files: i % 3 === 0 ? [fileA, fileB] : i % 2 === 0 ? [fileA] : [fileB],
      });
    }
    const startMs = Date.now();
    const scaleReport = followUpBenchmarkCommits(
      scaleCommits,
      { minShared: 3, minConfidence: 0.4 },
      { testFraction: 0.2, k: 3, maxCases: 10 },
    );
    const elapsedMs = Date.now() - startMs;
    assert.equal(scaleReport.modelsBuilt, 1);
    assert.ok(elapsedMs < 2000, `Expected 2,000-commit benchmark under 2000ms, took ${elapsedMs}ms`);
    assert.ok(scaleReport.cases.length <= 10);
    if (scaleReport.candidatesEvaluated > 10) {
      assert.equal(scaleReport.casesTruncated, scaleReport.candidatesEvaluated - 10);
    }

    // Print formatting renders "n/a" when a strategy has 0 triggered recommendations
    const zeroTriggerCommits: HistoryCommit[] = [];
    for (let i = 0; i < 10; i++) {
      zeroTriggerCommits.push({
        hash: `z-${i}`,
        author: 'Alice',
        time: 1000 + i * 3600,
        commitTime: 1000 + i * 3600,
        subject: `solo ${i}`,
        files: [i % 2 === 0 ? 'src/x.ts' : 'src/y.ts'],
      });
    }
    const zeroTriggerReport = followUpBenchmarkCommits(
      zeroTriggerCommits,
      { minShared: 5, minConfidence: 0.9 },
      { testFraction: 0.2, k: 2 },
    );
    assert.equal(zeroTriggerReport.strategies[0]?.triggered, 0);
    assert.equal(zeroTriggerReport.strategies[0]?.hitRate, null);
    assert.equal(zeroTriggerReport.strategies[0]?.precision, null);
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(' '));
    try {
      printFollowUpBenchmarkSection(zeroTriggerReport);
    } finally {
      console.log = origLog;
    }
    assert.ok(lines.some((l) => l.includes('co-change') && l.includes('n/a')));
  });

  it('integrates with `backtest --follow-ups` via API and CLI without altering standard backtest scores', async () => {
    const r = new FixtureRepo();
    try {
      for (let i = 0; i < 28; i++) {
        r.touch(['src/a.ts', 'src/b.ts'], `pair ${i}`, { day: i * 2 });
      }
      // Held-out candidate follow-up within the same day (delta = 0h <= 48h)
      r.touch(['src/a.ts'], 'feat: update a', { day: 60 });
      r.touch(['src/b.ts'], 'fix: forgot b', { day: 60 });

      const ctx = await loadContext(r.dir, flags);
      const standard = backtest(ctx, { testFraction: 0.2, k: 2 });
      const withFollowUps = backtest(ctx, { testFraction: 0.2, k: 2, followUps: true, followUpWindowHours: 48 });

      assert.equal(standard.followUpBenchmark, undefined);
      assert.deepEqual(withFollowUps.strategies, standard.strategies);
      assert.ok(withFollowUps.followUpBenchmark);
      assert.equal(withFollowUps.followUpBenchmark?.candidatesEvaluated, 1);
      assert.equal(withFollowUps.followUpBenchmark?.strategies[0]?.correctMatches, 1);

      const fbStandalone = followUpBenchmark(ctx, { testFraction: 0.2, k: 2, windowHours: 48 });
      assert.equal(fbStandalone.candidatesEvaluated, 1);

      const cliJson = runCli(['backtest', '--follow-ups', '--follow-up-window', '48', '--json'], r.dir);
      assert.equal(cliJson.code, 0, cliJson.stderr);
      const parsed = JSON.parse(cliJson.stdout);
      assert.equal(parsed.followUpBenchmark.candidatesEvaluated, 1);

      const cliText = runCli(['backtest', '--follow-ups'], r.dir);
      assert.equal(cliText.code, 0, cliText.stderr);
      assert.match(cliText.stdout, /Candidate follow-up benchmark/);
      assert.match(cliText.stdout, /not confirmed bug fixes or omissions/);

      // CLI validation: invalid --follow-up-window and --follow-up-window without --follow-ups
      const cliBadWindow = runCli(['backtest', '--follow-ups', '--follow-up-window', '0'], r.dir);
      assert.equal(cliBadWindow.code, 1);
      assert.match(cliBadWindow.stderr, /Expected a positive number/);

      const cliOrphanWindow = runCli(['backtest', '--follow-up-window', '24'], r.dir);
      assert.equal(cliOrphanWindow.code, 2);
      assert.match(cliOrphanWindow.stderr, /--follow-up-window requires --follow-ups/);
    } finally {
      r.cleanup();
    }
  });
});
