import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { sanitizeGitEnv } from '../scripts/schema-validator.mjs';
import { backtest } from '../src/commands/backtest.js';
import { diff } from '../src/commands/diff.js';
import { explain } from '../src/commands/explain.js';
import { fileReport } from '../src/commands/file.js';
import { writeMap } from '../src/commands/map.js';
import { scan } from '../src/commands/scan.js';
import { DIRTY_WORKTREE_HEAD_WARNING, loadContext, UsageError } from '../src/context.js';
import {
  getActiveCatFilePids,
  getCatFileSpawnCount,
  getLastCatFilePid,
  gitTreeFiles,
  MAX_SOURCE_BYTES,
  onCatFileSpawn,
  RelationshipClassifier,
  RELATIONSHIPS,
  resetCatFileStats,
} from '../src/imports/classify.js';
import { FixtureRepo } from './helpers.js';

const ROOT_DIR = join(import.meta.dirname, '..');
const CLI = join(ROOT_DIR, 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');

function runCli(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, ['--import', TSX, CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: sanitizeGitEnv(process.env, { NO_COLOR: '1' }),
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function stripHeadMeta<T extends { meta?: { head?: unknown } }>(payload: T): T {
  const clone = structuredClone(payload);
  if (clone.meta && 'head' in clone.meta) {
    delete clone.meta.head;
  }
  return clone;
}

describe('--head <ref>: analyze any commit without checking it out (RA-02)', () => {
  let repo: FixtureRepo;
  let baseCommitSha: string;
  let featureCommitSha: string;
  let headTagName: string;

  before(() => {
    repo = new FixtureRepo();
    repo.write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@core/*': ['src/core/*'],
          },
        },
      }),
    );
    repo.write('src/core/db.ts', 'export const db = 1;\n');
    repo.write('src/core/api.ts', "import { db } from '@core/db';\nexport const api = db;\n");
    repo.write('src/billing.ts', 'export const billing = 1;\n');
    repo.write('src/invoice.ts', 'export const invoice = 1;\n');
    repo.write('src/legacy.ts', 'export const legacy = 1;\n');
    repo.write('src/partner.ts', 'export const partner = 1;\n');
    repo.git('add', '.');
    repo.commit({ message: 'initial commit', author: 'Alice' });
    baseCommitSha = repo.git('rev-parse', 'HEAD').trim();

    // Build > 30 commits on main so backtest has sufficient history at feature fork point
    for (let i = 1; i <= 32; i++) {
      repo.commit({
        message: `feat(billing): update billing & invoice ${i}`,
        author: 'Alice',
        write: {
          'src/billing.ts': `export const billing = ${i};\n`,
          'src/invoice.ts': `export const invoice = ${i};\n`,
        },
      });
      if (i % 4 === 0) {
        repo.commit({
          message: `feat(core): update api & db ${i}`,
          author: 'Bob',
          write: {
            'src/core/db.ts': `export const db = ${i};\n`,
            'src/core/api.ts': `import { db } from '@core/db';\nexport const api = db + ${i};\n`,
          },
        });
      }
      if (i % 6 === 0) {
        repo.commit({
          message: `feat(legacy): sync legacy & partner ${i}`,
          author: 'Alice',
          write: {
            'src/legacy.ts': `export const legacy = ${i};\n`,
            'src/partner.ts': `export const partner = ${i};\n`,
          },
        });
      }
    }

    baseCommitSha = repo.git('rev-parse', 'HEAD').trim();

    // Create a feature branch with a rename and partial change (touching renamed billing, leaving invoice untouched)
    repo.git('checkout', '-q', '-b', 'feature-branch');
    repo.git('mv', 'src/billing.ts', 'src/billing-v2.ts');
    repo.commit({ message: 'refactor: rename billing.ts to billing-v2.ts', author: 'Alice' });
    repo.commit({
      message: 'feat(billing): change billing-v2 without invoice',
      author: 'Alice',
      write: {
        'src/billing-v2.ts': 'export const billing = 999;\n',
      },
    });
    featureCommitSha = repo.git('rev-parse', 'HEAD').trim();
    headTagName = 'v1.2.0-test';
    repo.git('tag', headTagName, featureCommitSha);

    // Return to main and advance main with future commits that must not leak into featureCommitSha
    repo.git('checkout', '-q', 'main');
    for (let j = 0; j < 6; j++) {
      repo.commit({
        message: `feat(future): couple future-a and future-b ${j}`,
        author: 'Carol',
        write: {
          'src/future-a.ts': `export const fa = ${j};\n`,
          'src/future-b.ts': `export const fb = ${j};\n`,
        },
      });
    }
  });

  after(() => {
    repo.cleanup();
  });

  it('equivalence: scan, diff, file, explain, and backtest with --head X match checking out X (deep-equal excluding meta.head)', () => {
    // 1. Run all 5 commands in --head mode while on `main`
    const headScanOut = JSON.parse(runCli(['scan', '--head', headTagName, '--json'], repo.dir).stdout);
    const headDiffOut = JSON.parse(
      runCli(['diff', '--head', featureCommitSha, '--base', baseCommitSha, '--json'], repo.dir).stdout,
    );
    const headFileOut = JSON.parse(
      runCli(['file', 'src/billing-v2.ts', '--head', featureCommitSha, '--json'], repo.dir).stdout,
    );
    const headExplainOut = JSON.parse(
      runCli(
        ['explain', 'src/billing-v2.ts', 'src/invoice.ts', '--head', featureCommitSha, '--base', baseCommitSha, '--json'],
        repo.dir,
      ).stdout,
    );
    const headBacktestOut = JSON.parse(
      runCli(['backtest', '--head', headTagName, '--ghosts', '--follow-ups', '--json'], repo.dir).stdout,
    );

    // Verify meta.head is present and accurate on every command
    assert.deepEqual(headScanOut.meta.head, { ref: headTagName, sha: featureCommitSha });
    assert.deepEqual(headDiffOut.meta.head, { ref: featureCommitSha, sha: featureCommitSha });
    assert.deepEqual(headFileOut.meta.head, { ref: featureCommitSha, sha: featureCommitSha });
    assert.deepEqual(headExplainOut.meta.head, { ref: featureCommitSha, sha: featureCommitSha });
    assert.deepEqual(headBacktestOut.meta.head, { ref: headTagName, sha: featureCommitSha });

    // Also verify `map --head` accepts `--head` and sets meta.head
    const mapOutPath = join(repo.dir, '.git', 'repo-archaeology', 'head-map.html');
    const headMapRes = runCli(['map', '--head', headTagName, '--no-open', '-o', mapOutPath, '--json'], repo.dir);
    assert.equal(headMapRes.code, 0, headMapRes.stderr);
    const headMapOut = JSON.parse(headMapRes.stdout);
    assert.deepEqual(headMapOut.meta.head, { ref: headTagName, sha: featureCommitSha });
    assert.ok(existsSync(mapOutPath));
    rmSync(mapOutPath, { force: true });

    // 2. Now check out featureCommitSha and run the exact same 5 commands without --head
    repo.git('checkout', '-q', featureCommitSha);
    try {
      const coScanOut = JSON.parse(runCli(['scan', '--json'], repo.dir).stdout);
      const coDiffOut = JSON.parse(runCli(['diff', '--base', baseCommitSha, '--json'], repo.dir).stdout);
      const coFileOut = JSON.parse(runCli(['file', 'src/billing-v2.ts', '--json'], repo.dir).stdout);
      const coExplainOut = JSON.parse(
        runCli(['explain', 'src/billing-v2.ts', 'src/invoice.ts', '--base', baseCommitSha, '--json'], repo.dir).stdout,
      );
      const coBacktestOut = JSON.parse(
        runCli(['backtest', '--ghosts', '--follow-ups', '--json'], repo.dir).stdout,
      );

      assert.equal(coScanOut.meta.head, undefined);
      assert.equal(coDiffOut.meta.head, undefined);
      assert.equal(coFileOut.meta.head, undefined);
      assert.equal(coExplainOut.meta.head, undefined);
      assert.equal(coBacktestOut.meta.head, undefined);

      assert.deepEqual(stripHeadMeta(headScanOut), coScanOut);
      assert.deepEqual(stripHeadMeta(headDiffOut), coDiffOut);
      assert.deepEqual(stripHeadMeta(headFileOut), coFileOut);
      assert.deepEqual(stripHeadMeta(headExplainOut), coExplainOut);
      assert.deepEqual(stripHeadMeta(headBacktestOut), coBacktestOut);
    } finally {
      repo.git('checkout', '-q', 'main');
    }
  });

  it('no leakage: commits after <head> that co-change A and B do not affect results at <head>', async () => {
    const leakRepo = new FixtureRepo();
    try {
      leakRepo.write('src/a.ts', 'export const a = 0;\n');
      leakRepo.write('src/b.ts', 'export const b = 0;\n');
      leakRepo.write('src/c.ts', 'export const c = 0;\n');
      leakRepo.write('src/d.ts', 'export const d = 0;\n');
      leakRepo.git('add', '.');
      leakRepo.commit({ message: 'root', author: 'Alice' });
      const rootSha = leakRepo.git('rev-parse', 'HEAD').trim();

      // Before `earlyHead`, only c.ts and d.ts co-change; a.ts and b.ts never co-change
      for (let i = 1; i <= 32; i++) {
        leakRepo.commit({
          message: `feat(cd): update c and d ${i}`,
          author: 'Alice',
          write: {
            'src/c.ts': `export const c = ${i};\n`,
            'src/d.ts': `export const d = ${i};\n`,
          },
        });
      }
      const preBranchSha = leakRepo.git('rev-parse', 'HEAD').trim();
      leakRepo.commit({
        message: 'feat(a): touch only a.ts at earlyHead',
        author: 'Alice',
        write: {
          'src/a.ts': 'export const a = 1;\n',
        },
      });
      const earlyHead = leakRepo.git('rev-parse', 'HEAD').trim();

      // After `earlyHead`, co-change a.ts and b.ts 10 times so they become a strong ghost wire at HEAD
      for (let j = 1; j <= 10; j++) {
        leakRepo.commit({
          message: `feat(ab): future co-change ${j}`,
          author: 'Alice',
          write: {
            'src/a.ts': `export const a = ${j + 10};\n`,
            'src/b.ts': `export const b = ${j + 10};\n`,
          },
        });
      }

      // At current HEAD, a.ts <-> b.ts is a strong ghost wire
      const headCtx = await loadContext(leakRepo.dir, { minShared: 3, minConfidence: 0.4 });
      const headScan = scan(headCtx, { limit: 10, kinds: [...RELATIONSHIPS] });
      assert.ok(
        headScan.relationships.some((r) => [r.from, r.to].sort().join(':') === 'src/a.ts:src/b.ts'),
        'expected src/a.ts <-> src/b.ts to appear at current HEAD',
      );

      // At --head earlyHead, a.ts <-> b.ts has 0 shared commits after root and must NOT appear
      const earlyCtx = await loadContext(
        leakRepo.dir,
        { minShared: 3, minConfidence: 0.4 },
        { head: earlyHead, base: preBranchSha },
      );
      const earlyScan = scan(
        await loadContext(leakRepo.dir, { minShared: 3, minConfidence: 0.4 }, { head: earlyHead }),
        { limit: 10, kinds: [...RELATIONSHIPS] },
      );
      assert.ok(
        !earlyScan.relationships.some((r) => [r.from, r.to].sort().join(':') === 'src/a.ts:src/b.ts'),
        'future co-changes of a.ts and b.ts must not leak into scan at earlyHead',
      );

      const earlyDiff = await diff(earlyCtx, { base: preBranchSha, limit: 10, kinds: [...RELATIONSHIPS] });
      assert.deepEqual(
        earlyDiff.suggestions.map((s) => s.to),
        [],
        'future co-changes of a.ts and b.ts must not leak into diff at earlyHead',
      );

      // Backtest at earlyHead only sees commits up to earlyHead (34 total commits, not 44)
      const earlyBtCtx = await loadContext(leakRepo.dir, { minShared: 3, minConfidence: 0.4 }, { head: earlyHead });
      const earlyBt = backtest(earlyBtCtx, { testFraction: 0.2, k: 3 });
      assert.equal(earlyBt.meta.commitsAnalyzed, 34);
      assert.ok(rootSha.length >= 40);
    } finally {
      leakRepo.cleanup();
    }
  });

  it('dirty tree: ignores uncommitted edits and untracked files in head mode and emits meta.warnings', async () => {
    // Modify a tracked file and create an untracked file in the working tree
    repo.write('src/legacy.ts', 'export const legacy = 99999;\n');
    repo.write('src/untracked-dirty.ts', 'export const dirty = true;\n');
    try {
      const ctx = await loadContext(repo.dir, { minShared: 3, minConfidence: 0.4 }, { head: featureCommitSha, base: baseCommitSha });
      assert.ok(
        ctx.warnings.includes(DIRTY_WORKTREE_HEAD_WARNING),
        `expected dirty working-tree warning in meta.warnings, got: ${JSON.stringify(ctx.warnings)}`,
      );
      assert.match(DIRTY_WORKTREE_HEAD_WARNING, /uncommitted changes were ignored/i);
      assert.ok(!ctx.currentFiles.has('src/untracked-dirty.ts'), 'untracked file must not appear in head currentFiles');

      const diffRes = await diff(ctx, { base: baseCommitSha, limit: 10, kinds: [...RELATIONSHIPS] });
      assert.ok(diffRes.meta.warnings.some((w) => /uncommitted changes were ignored/i.test(w)));
      assert.deepEqual(
        diffRes.changed.map((c) => c.path),
        ['src/billing-v2.ts'],
        'uncommitted edit to src/legacy.ts must not be included in head-mode diff',
      );
    } finally {
      repo.git('checkout', '-q', '--', '.');
      rmSync(join(repo.dir, 'src/untracked-dirty.ts'), { force: true });
    }
  });

  it('import classification: classifies direct and indirect imports using blobs at <head> even if removed later', async () => {
    const impRepo = new FixtureRepo();
    try {
      impRepo.write('src/a.ts', 'export const a = 1;\n');
      impRepo.write('src/b.ts', "import { a } from './a';\nexport const b = a + 1;\n");
      impRepo.write('src/via.ts', "import { a } from './a';\nexport const via = a;\n");
      impRepo.write('src/c.ts', "import { via } from './via';\nexport const c = via + 1;\n");
      impRepo.git('add', '.');
      impRepo.commit({ message: 'initial with imports', author: 'Alice' });

      for (let i = 1; i <= 5; i++) {
        impRepo.commit({
          message: `feat: co-change a, b, c ${i}`,
          author: 'Alice',
          write: {
            'src/a.ts': `export const a = ${i};\n`,
            'src/b.ts': `import { a } from './a';\nexport const b = a + ${i};\n`,
            'src/c.ts': `import { via } from './via';\nexport const c = via + ${i};\n`,
          },
        });
      }
      const oldHeadWithImports = impRepo.git('rev-parse', 'HEAD').trim();

      // Now remove the imports from b.ts and c.ts in later commits so at HEAD they are ghost wires
      for (let j = 1; j <= 4; j++) {
        impRepo.commit({
          message: `refactor: decouple imports ${j}`,
          author: 'Alice',
          write: {
            'src/a.ts': `export const a = ${j + 100};\n`,
            'src/b.ts': `export const b = ${j + 100};\n`,
            'src/c.ts': `export const c = ${j + 100};\n`,
          },
        });
      }

      // At current HEAD: a <-> b and a <-> c have no imports -> classified as 'ghost'
      const nowCtx = await loadContext(impRepo.dir, { minShared: 3, minConfidence: 0.4 });
      const nowScan = scan(nowCtx, { limit: 10, kinds: [...RELATIONSHIPS] });
      const nowKinds = new Map(nowScan.relationships.map((r) => [[r.from, r.to].sort().join(':'), r.relationship]));
      assert.equal(nowKinds.get('src/a.ts:src/b.ts'), 'ghost');
      assert.equal(nowKinds.get('src/a.ts:src/c.ts'), 'ghost');

      // At --head oldHeadWithImports: a <-> b is 'direct' and a <-> c is 'indirect'
      const oldCtx = await loadContext(impRepo.dir, { minShared: 3, minConfidence: 0.4 }, { head: oldHeadWithImports });
      const oldScan = scan(oldCtx, { limit: 10, kinds: [...RELATIONSHIPS] });
      const oldKinds = new Map(oldScan.relationships.map((r) => [[r.from, r.to].sort().join(':'), r.relationship]));
      assert.equal(oldKinds.get('src/a.ts:src/b.ts'), 'direct');
      assert.equal(oldKinds.get('src/a.ts:src/c.ts'), 'indirect');

      // Also verify blob size cap (MAX_SOURCE_BYTES) in gitTreeFiles
      const smallFiles = gitTreeFiles(impRepo.dir, oldHeadWithImports, new Set(['src/a.ts', 'src/b.ts']), {
        maxBytes: 5,
      });
      try {
        assert.equal(smallFiles.read('src/a.ts'), undefined, 'blobs larger than maxBytes must return undefined');
        assert.equal(MAX_SOURCE_BYTES, 1_000_000);
      } finally {
        smallFiles.close();
      }
    } finally {
      impRepo.cleanup();
    }
  });

  it('bad refs: --head -rf, --head doesnotexist, and --head <tree-sha> each fail with a clear UsageError', async () => {
    const treeSha = repo.git('rev-parse', 'HEAD^{tree}').trim();

    for (const badRef of ['-rf', 'doesnotexist', treeSha]) {
      await assert.rejects(
        () => loadContext(repo.dir, { minShared: 3, minConfidence: 0.4 }, { head: badRef }),
        (err: unknown) => {
          assert.ok(err instanceof UsageError, `expected UsageError for --head ${badRef}, got ${err}`);
          return true;
        },
      );

      const cliRes = runCli(['scan', '--head', badRef], repo.dir);
      assert.equal(cliRes.code, 2, `expected exit code 2 for --head ${badRef}`);
      assert.match(cliRes.stderr, /^error:/m);
    }
  });

  it('safety: leaves HEAD, working tree status, and .git/index mtime completely untouched', async () => {
    // Stage a change and leave an unstaged edit so .git/index exists and working tree is non-trivial
    repo.write('src/core/db.ts', 'export const db = 42;\n');
    repo.git('add', 'src/core/db.ts');
    repo.write('src/legacy.ts', 'export const legacy = 42;\n');

    try {
      const indexPath = join(repo.dir, '.git', 'index');
      const headBefore = repo.git('rev-parse', 'HEAD');
      const statusBefore = spawnSync('git', ['status', '--porcelain=v1', '-z'], {
        cwd: repo.dir,
        encoding: 'buffer',
        env: sanitizeGitEnv(process.env),
      }).stdout;
      const indexStatBefore = statSync(indexPath, { bigint: true });

      // Run all commands in head mode against featureCommitSha
      const ctx = await loadContext(
        repo.dir,
        { minShared: 3, minConfidence: 0.4 },
        { head: featureCommitSha },
      );
      scan(ctx, { limit: 10, kinds: [...RELATIONSHIPS] });
      await diff(ctx, { base: baseCommitSha, limit: 10, kinds: [...RELATIONSHIPS] });
      fileReport(ctx, 'src/billing-v2.ts', { limit: 5 });
      await explain(ctx, 'src/billing-v2.ts', 'src/invoice.ts');
      backtest(ctx, { testFraction: 0.2, k: 3, ghosts: true });
      const customMapPath = join(repo.dir, '.git', 'repo-archaeology', 'safety-map.html');
      await writeMap(ctx, { edges: 20, kinds: [...RELATIONSHIPS], open: false, out: customMapPath });
      rmSync(customMapPath, { force: true });

      const headAfter = repo.git('rev-parse', 'HEAD');
      const statusAfter = spawnSync('git', ['status', '--porcelain=v1', '-z'], {
        cwd: repo.dir,
        encoding: 'buffer',
        env: sanitizeGitEnv(process.env),
      }).stdout;
      const indexStatAfter = statSync(indexPath, { bigint: true });

      assert.equal(headAfter, headBefore, 'HEAD must not change');
      assert.deepEqual(statusAfter, statusBefore, 'git status --porcelain=v1 -z must not change');
      assert.equal(indexStatAfter.mtimeNs, indexStatBefore.mtimeNs, '.git/index mtimeNs must not change');
    } finally {
      repo.git('reset', '-q', '--hard');
    }
  });

  it('process cleanup: uses one cat-file --batch process per analysis and exits cleanly after success and thrown errors', async () => {
    resetCatFileStats();
    const spawnedPids: number[] = [];
    const unsubscribe = onCatFileSpawn((pid) => spawnedPids.push(pid));

    try {
      // 1. Success path: one long-lived cat-file --batch process across all file reads in scan, closed on exit
      const ctx = await loadContext(repo.dir, { minShared: 3, minConfidence: 0.4 }, { head: featureCommitSha });
      const res = scan(ctx, { limit: 15, kinds: [...RELATIONSHIPS] });
      assert.ok(res.relationships.length >= 1);
      assert.equal(getCatFileSpawnCount(), 1, 'must spawn exactly one git cat-file --batch process per analysis');
      assert.equal(spawnedPids.length, 1);
      const firstPid = getLastCatFilePid()!;
      assert.ok(firstPid > 0);
      assert.deepEqual(getActiveCatFilePids(), [], 'no active cat-file processes may remain after scan completes');
      assert.equal(isProcessAlive(firstPid), false, 'cat-file OS process must have exited after success');

      // 2. Thrown error inside a command (e.g. fileReport on a missing file)
      resetCatFileStats();
      const errCtx = await loadContext(repo.dir, { minShared: 3, minConfidence: 0.4 }, { head: featureCommitSha });
      assert.throws(
        () => fileReport(errCtx, 'src/does-not-exist.ts', { limit: 5 }),
        UsageError,
      );
      assert.equal(getCatFileSpawnCount(), 1, 'command opened cat-file process');
      const secondPid = getLastCatFilePid()!;
      assert.ok(secondPid > 0);
      assert.deepEqual(getActiveCatFilePids(), [], 'no active cat-file processes may remain after command throws');
      assert.equal(isProcessAlive(secondPid), false, 'cat-file OS process must have exited after command error');

      // 3. Thrown error mid-read / mid-classification while cat-file --batch is actively reading blobs
      resetCatFileStats();
      let readsSeen = 0;
      const throwingFiles = gitTreeFiles(
        repo.dir,
        featureCommitSha,
        new Set(['src/billing-v2.ts', 'src/invoice.ts']),
        {
          onRead: () => {
            readsSeen++;
            if (readsSeen === 1) {
              throw new Error('simulated failure mid-classification after reading from cat-file');
            }
          },
        },
      );
      const customClassifier = new RelationshipClassifier(throwingFiles);
      assert.throws(() => {
        try {
          customClassifier.classify('src/billing-v2.ts', 'src/invoice.ts');
        } finally {
          throwingFiles.close();
        }
      }, /simulated failure mid-classification/);
      assert.equal(getCatFileSpawnCount(), 1);
      const thirdPid = getLastCatFilePid()!;
      assert.ok(thirdPid > 0);
      assert.deepEqual(getActiveCatFilePids(), [], 'no active cat-file processes may remain after mid-read error');
      assert.equal(isProcessAlive(thirdPid), false, 'cat-file OS process must have exited after mid-read error');
    } finally {
      unsubscribe();
    }
  });
});
