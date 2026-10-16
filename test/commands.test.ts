import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { backtestCommits, EVALUATION_MAX_FILES } from '../src/commands/backtest.js';
import { diff } from '../src/commands/diff.js';
import { fileReport } from '../src/commands/file.js';
import { buildMapData } from '../src/commands/map.js';
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
 *  - billing.ts and invoice-template.html always change together (ghost wire)
 *  - api.test.ts tests api.ts (test link)
 */
let repo: FixtureRepo;
before(() => {
  repo = new FixtureRepo();
  repo.write('src/db.ts', 'export const db = 1\n');
  repo.write('src/api.ts', "import { db } from './db'\n");
  repo.write('src/api.test.ts', "import './api'\n");
  repo.write('src/billing.ts', 'export const bill = 1\n');
  repo.write('templates/invoice-template.html', '<p></p>\n');
  repo.write('src/other.ts', 'export {}\n');
  repo.git('add', '.');
  repo.commit({ message: 'initial' });
  for (let i = 0; i < 6; i++) {
    repo.touch(['src/billing.ts', 'templates/invoice-template.html'], `billing change ${i}`);
    repo.commit({ message: `api change ${i}`, write: { 'src/api.ts': `import { db } from './db'\n// ${i}\n`, 'src/db.ts': `export const db = ${i}\n`, 'src/api.test.ts': `import './api'\n// ${i}\n` } });
    repo.touch(['src/other.ts'], `other ${i}`);
  }
});
after(() => repo.cleanup());

const flags = { minShared: 3, minConfidence: 0.4 };

describe('scan', () => {
  it('finds the ghost wire and classifies the other relationships', async () => {
    const ctx = await loadContext(repo.dir, flags);
    const result = scan(ctx, { limit: 10, kinds: ['ghost', 'unknown', 'direct', 'test'] });
    const kinds = new Map(result.relationships.map((r) => [[r.from, r.to].sort().join(' + '), r.relationship]));
    assert.equal(kinds.get('src/billing.ts + templates/invoice-template.html'), 'ghost');
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
      assert.deepEqual(result.suggestions.map((s) => [s.to, s.relationship]), [['templates/invoice-template.html', 'ghost']]);

      repo.write('templates/invoice-template.html', '<p>changed</p>\n');
      repo.git('add', 'templates/invoice-template.html');
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
      assert.deepEqual(result.suggestions.map((s) => s.to), ['templates/invoice-template.html']);
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
      assert.equal(result.suggestions[0]?.to, 'templates/invoice-template.html');
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
    assert.equal(result.companions[0]?.to, 'templates/invoice-template.html');
    assert.equal(result.companions[0]?.wouldAlert, true);
    assert.throws(() => fileReport(ctx, '../nope.ts', { limit: 5 }), /Nothing to show/);
  });
});

describe('map', () => {
  it('builds nodes and edges for the strongest relationships', async () => {
    const ctx = await loadContext(repo.dir, flags);
    const data = buildMapData(ctx, { edges: 2, kinds: ['ghost', 'direct', 'test', 'unknown'] });
    assert.equal(data.edges.length, 2);
    for (const e of data.edges) {
      assert.ok(data.nodes[e.source] && data.nodes[e.target]);
    }
  });
});

describe('backtest', () => {
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
    assert.ok(cleanResult.relationships.some((r: { to: string }) => r.to === 'templates/invoice-template.html'));
    assert.match(runCli(['--min-shared', '2'], repo.dir).stdout, /repo-archaeology map/);

    writeFileSync(join(repo.dir, 'src/billing.ts'), 'changed\n');
    try {
      const dirty = runCli(['--min-shared', '2', '--json'], repo.dir);
      assert.equal(dirty.code, 0, dirty.stderr);
      const dirtyResult = JSON.parse(dirty.stdout);
      assert.equal(dirtyResult.mode, 'diff');
      assert.deepEqual(dirtyResult.changed.map((f: { path: string }) => f.path), ['src/billing.ts']);
      assert.equal(dirtyResult.suggestions[0]?.to, 'templates/invoice-template.html');
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
