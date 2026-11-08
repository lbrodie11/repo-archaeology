import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { sanitizeGitEnv } from '../scripts/schema-validator.mjs';
import {
  CACHE_DIR_ENV,
  CACHE_FORMAT_SIGNATURE,
  CACHE_INDEX_FILE,
  CACHE_LOCK_FILE,
  CACHE_TAG_FILE,
  CACHE_VERSION,
  gitVersion,
  loadCache,
  writeCache,
  type CacheIndex,
} from '../src/git/cache.js';
import { FORMAT, type RawCommit } from '../src/git/log.js';
import { CACHE_SHALLOW_WARNING } from '../src/model/history.js';
import { FixtureRepo } from './helpers.js';

const ROOT_DIR = join(import.meta.dirname, '..');
const CLI = join(ROOT_DIR, 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');

interface Envelope {
  meta: {
    commitsRead: number;
    warnings: string[];
    cache?: { enabled: boolean; hits: number; misses: number; dir?: string };
  };
  [key: string]: unknown;
}

function cliEnv(extraEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = sanitizeGitEnv(process.env, { NO_COLOR: '1', ...extraEnv });
  if (!(CACHE_DIR_ENV in extraEnv)) delete env[CACHE_DIR_ENV];
  return env;
}

function runCli(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, ['--import', TSX, CLI, ...args], { cwd, encoding: 'utf8', env: cliEnv(extraEnv) });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runJson(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): Envelope {
  const result = runCli([...args, '--json'], cwd, extraEnv);
  assert.equal(result.code, 0, `repo-archaeology ${args.join(' ')} failed:\n${result.stderr}`);
  return JSON.parse(result.stdout) as Envelope;
}

/** Equivalence ignores only the per-run cache counters. */
function withoutCache(payload: Envelope): Envelope {
  const clone = structuredClone(payload);
  delete clone.meta.cache;
  return clone;
}

function cacheDirOf(repo: FixtureRepo): string {
  return join(repo.dir, '.git', 'repo-archaeology', 'cache');
}

function readIndex(dir: string): CacheIndex {
  return JSON.parse(readFileSync(join(dir, CACHE_INDEX_FILE), 'utf8')) as CacheIndex;
}

/** Builds a small history with co-change clusters, a sweep, and renames. */
function buildFixture(repo: FixtureRepo, rounds = 8): void {
  repo.commit({ message: 'init', write: { 'src/a.ts': 'a\n', 'src/b.ts': 'b\n', 'src/c.ts': 'c\n', 'lib/x.ts': 'x\n', 'lib/y.ts': 'y\n', 'docs/readme.md': 'r\n' } });
  for (let i = 0; i < rounds; i++) {
    repo.touch(['src/a.ts', 'src/b.ts'], `feat: a+b ${i}`);
    repo.touch(['lib/x.ts', 'lib/y.ts', 'docs/readme.md'], `feat: x+y ${i}`);
    if (i % 3 === 0) repo.touch(['src/a.ts', 'src/c.ts'], `fix: a+c ${i}`);
    if (i === 4) repo.commit({ message: 'refactor: rename b', move: [['src/b.ts', 'src/b2.ts']] });
  }
  repo.touch(['src/a.ts', 'src/b2.ts', 'src/c.ts', 'lib/x.ts', 'lib/y.ts', 'docs/readme.md'], 'chore: sweep');
}

const COMMANDS: string[][] = [['scan', '--kinds', 'ghost,unknown,indirect,direct,test'], ['diff'], ['backtest']];

/** Runs every command cached and with --no-cache and asserts deep equality (excluding meta.cache). */
function assertEquivalent(cwd: string, extra: string[] = [], env: NodeJS.ProcessEnv = {}): Envelope[] {
  const cachedRuns: Envelope[] = [];
  for (const command of COMMANDS) {
    const cached = runJson([...extra, ...command], cwd, env);
    const uncached = runJson([...extra, '--no-cache', ...command], cwd, env);
    assert.equal(cached.meta.cache?.enabled, true, `${command[0]}: cache should be enabled`);
    assert.equal(uncached.meta.cache?.enabled, false, `${command[0]}: --no-cache should disable the cache`);
    assert.equal(uncached.meta.cache?.hits, 0);
    assert.equal(uncached.meta.cache?.misses, uncached.meta.commitsRead);
    assert.deepEqual(withoutCache(cached), withoutCache(uncached), `${command[0]} ${extra.join(' ')}: cached and --no-cache differ`);
    cachedRuns.push(cached);
  }
  return cachedRuns;
}

describe('RA-04 history cache: cached and --no-cache results are identical', () => {
  let repo: FixtureRepo;

  before(() => {
    repo = new FixtureRepo();
    buildFixture(repo, 15); // backtest needs >= 30 usable commits even at HEAD~6
    // An uncommitted edit gives `diff` something to report.
    repo.write('src/a.ts', 'edited\n');
  });

  after(() => repo.cleanup());

  it('fresh cache: the first run fills it (all misses), the second is all hits', () => {
    const cold = runJson(['scan'], repo.dir);
    assert.deepEqual(cold.meta.cache, { enabled: true, hits: 0, misses: cold.meta.commitsRead, dir: '.git/repo-archaeology/cache' });
    const warm = runJson(['scan'], repo.dir);
    assert.deepEqual(warm.meta.cache, { enabled: true, hits: warm.meta.commitsRead, misses: 0, dir: '.git/repo-archaeology/cache' });
    assert.ok(existsSync(join(cacheDirOf(repo), CACHE_TAG_FILE)));
    const index = readIndex(cacheDirOf(repo));
    assert.equal(index.cacheVersion, CACHE_VERSION);
    assert.equal(index.segments.length, 1);
    assert.equal(index.segments[0]!.count, cold.meta.commitsRead);
    assertEquivalent(repo.dir);
  });

  it('new commits appended: only the new commits are parsed, as a new segment', () => {
    const before = runJson(['scan'], repo.dir).meta.commitsRead;
    repo.touch(['src/a.ts', 'src/b2.ts'], 'feat: a+b after cache');
    repo.touch(['lib/x.ts', 'lib/y.ts'], 'feat: x+y after cache');
    repo.write('src/a.ts', 'edited\n'); // restore the uncommitted edit for `diff`
    const after = runJson(['scan'], repo.dir);
    assert.equal(after.meta.commitsRead, before + 2);
    assert.equal(after.meta.cache?.hits, before);
    assert.equal(after.meta.cache?.misses, 2);
    assert.equal(readIndex(cacheDirOf(repo)).segments.length, 2);
    assertEquivalent(repo.dir);
  });

  it('renames recorded after the cache was filled are followed identically', () => {
    repo.commit({ message: 'refactor: move c', move: [['src/c.ts', 'src/core/c.ts']] });
    repo.touch(['src/a.ts', 'src/core/c.ts'], 'fix: a+c after move');
    repo.write('src/a.ts', 'edited\n'); // restore the uncommitted edit for `diff`
    const runs = assertEquivalent(repo.dir);
    assert.ok(runs[0]!.meta.cache!.hits > 0);
  });

  it('settings changes between runs (maxFiles, ignore) reuse the same cache', () => {
    runJson(['scan'], repo.dir); // make sure every needed commit is cached
    const runs = assertEquivalent(repo.dir, ['--max-files', '2', '--ignore', 'docs/**', '--skip-commits', '^chore']);
    for (const run of runs) assert.equal(run.meta.cache?.misses, 0, 'settings must not change what is cached');
  });

  it('--head at an old commit is served from the same cache', () => {
    const old = repo.git('rev-list', '--max-count=1', '--skip=6', 'HEAD').trim();
    for (const command of [['scan'], ['backtest']]) {
      const cached = runJson(['--head', old, ...command], repo.dir);
      const uncached = runJson(['--head', old, '--no-cache', ...command], repo.dir);
      assert.equal(cached.meta.cache?.misses, 0);
      assert.deepEqual(withoutCache(cached), withoutCache(uncached));
    }
  });

  it('force-pushed history: rewritten commits are parsed, vanished ones are simply never needed', () => {
    repo.git('reset', '-q', '--hard', 'HEAD~3');
    repo.touch(['src/a.ts', 'lib/y.ts'], 'feat: rewritten 1');
    repo.touch(['src/a.ts', 'src/b2.ts'], 'feat: rewritten 2');
    repo.write('src/a.ts', 'edited\n'); // restore the uncommitted edit for `diff`
    const after = runJson(['scan'], repo.dir);
    assert.equal(after.meta.cache?.misses, 2);
    assertEquivalent(repo.dir);
  });

  it('preserves exact ordering and truncation warnings across merges, diverged branches, diff --base, and --max-commits', () => {
    repo.git('checkout', '-q', '--', '.');
    const baseSha = repo.git('rev-parse', 'HEAD~4').trim();
    repo.git('checkout', '-q', '-b', 'feature', baseSha);
    repo.touch(['src/a.ts', 'src/b2.ts'], 'feat: feature branch 1');
    repo.git('checkout', '-q', 'main');
    repo.git('merge', '-q', '--no-ff', '-X', 'ours', 'feature', '-m', 'Merge branch feature');
    repo.write('src/a.ts', 'edited\n');

    // Warm the cache on main (which now contains a merge commit; --no-merges skips the merge itself)
    runJson(['scan'], repo.dir);
    assertEquivalent(repo.dir);

    // diff --base <sha> trains at merge-base and bridges branch changes identically
    const cachedBaseDiff = runJson(['diff', '--base', baseSha], repo.dir);
    const uncachedBaseDiff = runJson(['--no-cache', 'diff', '--base', baseSha], repo.dir);
    assert.equal(cachedBaseDiff.meta.cache?.misses, 0);
    assert.deepEqual(withoutCache(cachedBaseDiff), withoutCache(uncachedBaseDiff));

    // --max-commits truncation (maxCommits + 1 sentinel) produces identical limited-history warnings
    const cachedTruncated = runJson(['--max-commits', '15', 'scan'], repo.dir);
    const uncachedTruncated = runJson(['--no-cache', '--max-commits', '15', 'scan'], repo.dir);
    assert.equal(cachedTruncated.meta.cache?.misses, 0);
    assert.equal(cachedTruncated.meta.commitsRead, 15);
    assert.deepEqual(withoutCache(cachedTruncated), withoutCache(uncachedTruncated));
  });
});

describe('RA-04 history cache: integrity, versioning, shallow clones, concurrency, and location', () => {
  const repos: FixtureRepo[] = [];
  const tmpDirs: string[] = [];

  function freshRepo(rounds = 3): FixtureRepo {
    const repo = new FixtureRepo();
    buildFixture(repo, rounds);
    repos.push(repo);
    return repo;
  }

  after(() => {
    for (const repo of repos) repo.cleanup();
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('a truncated segment triggers a rebuild with a warning, and results stay identical', () => {
    const repo = freshRepo();
    const reference = runJson(['--no-cache', 'scan'], repo.dir);
    runJson(['scan'], repo.dir);
    const segment = join(cacheDirOf(repo), readIndex(cacheDirOf(repo)).segments[0]!.file);
    truncateSync(segment, Math.floor(readFileSync(segment).length / 2));

    const rebuilt = runJson(['scan'], repo.dir);
    const warning = rebuilt.meta.warnings.find((w) => w.startsWith('History cache at .git/repo-archaeology/cache was discarded and rebuilt'));
    assert.ok(warning, `expected a rebuild warning, got ${JSON.stringify(rebuilt.meta.warnings)}`);
    assert.match(warning, /checksum mismatch/);
    assert.equal(rebuilt.meta.cache?.hits, 0);
    const comparable = withoutCache(rebuilt);
    comparable.meta.warnings = comparable.meta.warnings.filter((w) => w !== warning);
    assert.deepEqual(comparable, withoutCache(reference), 'a rebuild must not change results');

    const healthy = runJson(['scan'], repo.dir);
    assert.deepEqual(healthy.meta.warnings, reference.meta.warnings, 'the rebuilt cache must be valid on the next run');
    assert.equal(healthy.meta.cache?.misses, 0);
  });

  it('a bad checksum in index.json triggers a rebuild with a warning', () => {
    const repo = freshRepo();
    runJson(['scan'], repo.dir);
    const indexPath = join(cacheDirOf(repo), CACHE_INDEX_FILE);
    const index = readIndex(cacheDirOf(repo));
    index.segments[0]!.sha256 = '0'.repeat(64);
    writeFileSync(indexPath, JSON.stringify(index));
    const rebuilt = runJson(['scan'], repo.dir);
    assert.ok(rebuilt.meta.warnings.some((w) => /discarded and rebuilt \(checksum mismatch in commits-1\.jsonl\)/.test(w)), JSON.stringify(rebuilt.meta.warnings));
    assert.notEqual(readIndex(cacheDirOf(repo)).segments[0]!.sha256, '0'.repeat(64));
    assert.equal(runJson(['scan'], repo.dir).meta.cache?.misses, 0);
  });

  it('a changed cacheVersion or formatSignature triggers a rebuild, while an raVersion patch bump keeps the cache warm', () => {
    const repo = freshRepo();
    runJson(['scan'], repo.dir);
    const indexPath = join(cacheDirOf(repo), CACHE_INDEX_FILE);
    writeFileSync(indexPath, JSON.stringify({ ...readIndex(cacheDirOf(repo)), cacheVersion: CACHE_VERSION + 1 }));
    const rebuilt = runJson(['scan'], repo.dir);
    assert.ok(rebuilt.meta.warnings.some((w) => w.includes(`cache version ${CACHE_VERSION + 1} does not match ${CACHE_VERSION}`)), JSON.stringify(rebuilt.meta.warnings));
    assert.equal(readIndex(cacheDirOf(repo)).cacheVersion, CACHE_VERSION);
    assert.equal(readIndex(cacheDirOf(repo)).formatSignature, CACHE_FORMAT_SIGNATURE);

    // Changing formatSignature invalidates automatically even when cacheVersion is unchanged
    writeFileSync(indexPath, JSON.stringify({ ...readIndex(cacheDirOf(repo)), formatSignature: 'deadbeef00000000' }));
    const rebuiltSig = runJson(['scan'], repo.dir);
    assert.ok(rebuiltSig.meta.warnings.some((w) => w.includes('the log parser format or git diff configuration changed')), JSON.stringify(rebuiltSig.meta.warnings));
    assert.equal(readIndex(cacheDirOf(repo)).formatSignature, CACHE_FORMAT_SIGNATURE);

    // Changing raVersion alone does NOT invalidate cached raw records
    writeFileSync(indexPath, JSON.stringify({ ...readIndex(cacheDirOf(repo)), raVersion: '0.3.99' }));
    const warmAfterPatch = runJson(['scan'], repo.dir);
    assert.equal(warmAfterPatch.meta.cache?.misses, 0);
  });

  it('guards the record format: changing FORMAT requires bumping CACHE_VERSION', () => {
    // If this assertion fails you changed what `git log` prints: bump CACHE_VERSION in src/git/cache.ts
    // (and update both values here) so stale records are discarded instead of served.
    assert.equal(FORMAT, '--format=\u001e%H\u001f%an\u001f%ae\u001f%at\u001f%ct\u001d%(trailers:only,unfold,separator=%x1d)\u001f%s');
    assert.equal(CACHE_VERSION, 1);
  });

  it('a shallow clone never writes the cache, re-parses boundary commits, and adds a warning', () => {
    const repo = freshRepo(14);
    const shallowDir = mkdtempSync(join(tmpdir(), 'repo-archaeology-shallow-'));
    tmpDirs.push(shallowDir);
    const clone = join(shallowDir, 'clone');
    const gitEnv = sanitizeGitEnv(process.env);
    spawnSync('git', ['clone', '-q', '--depth', '36', `file://${repo.dir}`, clone], { env: gitEnv, encoding: 'utf8' });
    assert.equal(spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: clone, encoding: 'utf8' }).stdout.trim(), 'true');

    const shallowRun = runJson(['scan'], clone);
    assert.ok(shallowRun.meta.warnings.includes(CACHE_SHALLOW_WARNING));
    assert.equal(shallowRun.meta.cache?.hits, 0);
    assert.equal(existsSync(join(clone, '.git', 'repo-archaeology', 'cache', CACHE_INDEX_FILE)), false, 'shallow clones must not write');

    // A valid cache filled from the full repository is read, but the shallow-boundary commit
    // (which git reports as a root commit here) is re-parsed, so results match --no-cache.
    const shared = mkdtempSync(join(tmpdir(), 'repo-archaeology-shared-cache-'));
    tmpDirs.push(shared);
    runJson(['scan'], repo.dir, { [CACHE_DIR_ENV]: shared });
    const indexBefore = readFileSync(join(shared, CACHE_INDEX_FILE), 'utf8');
    for (const command of COMMANDS) {
      const cached = runJson(command, clone, { [CACHE_DIR_ENV]: shared });
      const uncached = runJson(['--no-cache', ...command], clone, { [CACHE_DIR_ENV]: shared });
      assert.ok(cached.meta.cache!.hits > 0, 'valid records should be read in a shallow clone');
      assert.ok(cached.meta.cache!.misses >= 1, 'the shallow boundary commit must be re-parsed');
      const cachedComparable = withoutCache(cached);
      cachedComparable.meta.warnings = cachedComparable.meta.warnings.filter((w) => w !== CACHE_SHALLOW_WARNING);
      assert.deepEqual(cachedComparable, withoutCache(uncached), `${command[0]}: shallow cached and --no-cache differ`);
    }
    assert.equal(readFileSync(join(shared, CACHE_INDEX_FILE), 'utf8'), indexBefore, 'shallow clones must not modify a shared cache');
  });

  it('two simultaneous runs both succeed and leave a valid cache', async () => {
    const repo = freshRepo();
    const runAsync = () =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, ['--import', TSX, CLI, 'scan', '--json'], { cwd: repo.dir, env: cliEnv() });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
        child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
        child.on('close', (code) => resolve({ code, stdout, stderr }));
      });
    const results = await Promise.all([runAsync(), runAsync(), runAsync()]);
    const outputs = results.map((r) => {
      assert.equal(r.code, 0, r.stderr);
      return withoutCache(JSON.parse(r.stdout) as Envelope);
    });
    assert.deepEqual(outputs[1], outputs[0]);
    assert.deepEqual(outputs[2], outputs[0]);
    const loaded = loadCache(cacheDirOf(repo), await gitVersion(repo.dir));
    assert.equal(loaded.kind, 'ok', JSON.stringify(loaded));
    assert.equal(existsSync(join(cacheDirOf(repo), CACHE_LOCK_FILE)), false, 'the lock must be released');
    const next = runJson(['scan'], repo.dir);
    assert.equal(next.meta.cache?.misses, 0);
    assert.deepEqual(next.meta.warnings, outputs[0]!.meta.warnings);
  });

  it('honors REPO_ARCHAEOLOGY_CACHE_DIR and never prints the absolute path', () => {
    const repo = freshRepo();
    const base = mkdtempSync(join(tmpdir(), 'repo-archaeology-env-cache-'));
    tmpDirs.push(base);
    const dir = join(base, 'nested', 'cache');
    const out = runCli(['scan', '--json'], repo.dir, { [CACHE_DIR_ENV]: dir });
    assert.equal(out.code, 0, out.stderr);
    const json = JSON.parse(out.stdout) as Envelope;
    assert.equal(json.meta.cache?.dir, '$REPO_ARCHAEOLOGY_CACHE_DIR');
    assert.ok(existsSync(join(dir, CACHE_INDEX_FILE)), 'the cache must be written to the env directory');
    assert.equal(existsSync(cacheDirOf(repo)), false, 'the default directory must not be used');
    for (const variant of [dir, realpathSync.native(dir), base, realpathSync.native(base)]) {
      assert.equal(out.stdout.includes(variant), false, `JSON must not contain ${variant}`);
      assert.equal(out.stderr.includes(variant), false, `stderr must not contain ${variant}`);
    }
    assert.equal(runJson(['scan'], repo.dir, { [CACHE_DIR_ENV]: dir }).meta.cache?.misses, 0);
  });

  it('refuses to write into a non-empty directory that is not a cache, without failing the run', () => {
    const repo = freshRepo();
    const foreign = mkdtempSync(join(tmpdir(), 'repo-archaeology-foreign-'));
    tmpDirs.push(foreign);
    writeFileSync(join(foreign, 'index.json'), '{"mine":true}');
    const json = runJson(['scan'], repo.dir, { [CACHE_DIR_ENV]: foreign });
    assert.ok(json.meta.warnings.some((w) => w.includes('could not be updated (the directory is not empty and is not a repo-archaeology cache)')));
    assert.equal(readFileSync(join(foreign, 'index.json'), 'utf8'), '{"mine":true}');
  });

  it('honors cache settings in .repo-archaeology.json and rejects paths outside the repository', () => {
    const repo = freshRepo();
    repo.write('.repo-archaeology.json', JSON.stringify({ cache: { dir: '.cache/ra' } }));
    const custom = runJson(['scan'], repo.dir);
    assert.equal(custom.meta.cache?.dir, '.cache/ra');
    assert.ok(existsSync(join(repo.dir, '.cache', 'ra', CACHE_INDEX_FILE)));

    repo.write('.repo-archaeology.json', JSON.stringify({ cache: { enabled: false } }));
    assert.equal(runJson(['scan'], repo.dir).meta.cache?.enabled, false);

    for (const dir of ['../outside', '/tmp/outside']) {
      repo.write('.repo-archaeology.json', JSON.stringify({ cache: { dir } }));
      const rejected = runCli(['scan', '--json'], repo.dir);
      assert.notEqual(rejected.code, 0);
      assert.match(rejected.stderr, /"cache\.dir" must be a relative path inside the repository/);
    }

    // Rejects symlink traversal inside the repository for .repo-archaeology.json cache.dir
    const outsideTarget = mkdtempSync(join(tmpdir(), 'repo-archaeology-symlink-out-'));
    tmpDirs.push(outsideTarget);
    symlinkSync(outsideTarget, join(repo.dir, '.linked-cache'));
    repo.write('.repo-archaeology.json', JSON.stringify({ cache: { dir: '.linked-cache/ra' } }));
    const symlinkRejected = runCli(['scan', '--json'], repo.dir);
    assert.notEqual(symlinkRejected.code, 0);
    assert.match(symlinkRejected.stderr, /"cache\.dir" must not traverse a symbolic link/);

    repo.write('.repo-archaeology.json', JSON.stringify({ cache: { size: 1 } }));
    assert.match(runCli(['scan', '--json'], repo.dir).stderr, /unknown setting "cache\.size"/);
  });

  it('cleans up orphaned .tmp-* files on write and falls back gracefully when the cache directory is read-only', () => {
    const repo = freshRepo();
    runJson(['scan'], repo.dir);
    const dir = cacheDirOf(repo);
    const strayTmp = join(dir, '.commits-99.jsonl.tmp-99999-deadbeef');
    writeFileSync(strayTmp, 'partial crash data');
    repo.touch(['src/a.ts', 'src/b2.ts'], 'feat: trigger append after stray tmp');
    const afterAppend = runJson(['scan'], repo.dir);
    assert.equal(afterAppend.meta.cache?.misses, 1);
    assert.equal(existsSync(strayTmp), false, 'orphaned .tmp-* file must be cleaned up');

    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const roBase = mkdtempSync(join(tmpdir(), 'repo-archaeology-ro-'));
      tmpDirs.push(roBase);
      const roParent = join(roBase, 'locked');
      mkdirSync(roParent, { mode: 0o500 });
      try {
        const roRun = runJson(['scan'], repo.dir, { [CACHE_DIR_ENV]: join(roParent, 'cache') });
        assert.ok(roRun.meta.warnings.some((w) => w.includes('could not be updated')));
      } finally {
        chmodSync(roParent, 0o700);
      }
    }
  });
});

describe('RA-04 history cache: segment store unit behavior', () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const record = (n: number): RawCommit => ({
    hash: n.toString(16).padStart(40, '0'),
    authorName: `A${n}`,
    authorEmail: `a${n}@example.com`,
    authorTime: 1_700_000_000 + n,
    commitTime: 1_700_000_000 + n,
    subject: `commit ${n} \u001f with "quotes" and \u00e9`,
    trailers: n % 2 ? [{ key: 'co-authored-by', value: 'Bot <bot@example.com>' }] : [],
    changes: [{ status: 'M', path: `f${n}.ts` }, { status: 'R', oldPath: `old${n}.ts`, path: `new ${n}.ts` }],
  });

  function tempCache(): string {
    const dir = mkdtempSync(join(tmpdir(), 'repo-archaeology-cache-unit-'));
    dirs.push(dir);
    return join(dir, 'cache');
  }

  const write = (dir: string, records: RawCommit[], extra: Partial<Parameters<typeof writeCache>[1]> = {}) =>
    writeCache(dir, { mode: 'append', records, gitVersion: 'git version test', raVersion: 'test', reachable: async () => new Set(), ...extra });

  it('round-trips records exactly and deduplicates hashes across segments', async () => {
    const dir = tempCache();
    await write(dir, [record(1), record(2)]);
    await write(dir, [record(2), record(3)]);
    const loaded = loadCache(dir, 'git version test');
    assert.equal(loaded.kind, 'ok');
    if (loaded.kind !== 'ok') return;
    assert.equal(loaded.index.segments.length, 2);
    assert.equal(loaded.index.segments[1]!.count, 1, 'already cached hashes are not appended again');
    assert.deepEqual(JSON.parse(loaded.lines.get(record(3).hash)!), record(3));
    assert.equal(loadCache(dir, 'git version other').kind, 'invalid', 'a different git version invalidates the cache');
  });

  it('compacts above the segment limit and prunes unreachable commits', async () => {
    const dir = tempCache();
    for (let n = 1; n <= 3; n++) await write(dir, [record(n)], { maxSegments: 10 });
    const result = await write(dir, [record(4)], { maxSegments: 3, reachable: async () => new Set([record(2).hash, record(4).hash]) });
    assert.equal(result.compacted, true);
    const loaded = loadCache(dir, 'git version test');
    assert.equal(loaded.kind, 'ok');
    if (loaded.kind !== 'ok') return;
    assert.equal(loaded.index.segments.length, 1);
    assert.deepEqual([...loaded.lines.keys()].sort(), [record(2).hash, record(4).hash]);
    assert.deepEqual(
      [...new Set(readdirNames(dir).filter((f) => f.endsWith('.jsonl')))],
      [loaded.index.segments[0]!.file],
      'old segments are deleted after compaction',
    );
  });

  it('skips writing while another writer holds a fresh lock, and replaces a stale (> 60 s) lock', async () => {
    const dir = tempCache();
    await write(dir, [record(1)]);
    const lock = join(dir, CACHE_LOCK_FILE);
    writeFileSync(lock, 'held');
    const skipped = await write(dir, [record(2)]);
    assert.deepEqual(skipped, { written: false, compacted: false });
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    const written = await write(dir, [record(2)]);
    assert.equal(written.written, true);
    assert.equal(existsSync(lock), false);
  });
});

function readdirNames(dir: string): string[] {
  return readdirSync(dir);
}
