import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { diff } from '../src/commands/diff.js';
import { DEFAULT_IGNORES } from '../src/config.js';
import { loadContext, UsageError } from '../src/context.js';
import { CoChangeModel } from '../src/model/cochange.js';
import { loadHistory } from '../src/model/history.js';
import { FixtureRepo } from './helpers.js';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');

function runCli(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, ['--import', TSX, CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const repos: FixtureRepo[] = [];
const extraDirs: string[] = [];
after(() => {
  repos.forEach((r) => r.cleanup());
  extraDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});
function repo(): FixtureRepo {
  const r = new FixtureRepo();
  repos.push(r);
  return r;
}

const options = { maxFilesPerCommit: 5, ignore: DEFAULT_IGNORES };

describe('history from real git repositories', () => {
  it('follows renames so pre-rename history counts for the current name', async () => {
    const r = repo();
    r.touch(['src/old.ts', 'src/partner.ts']);
    r.touch(['src/old.ts', 'src/partner.ts']);
    r.commit({ message: 'move', move: [['src/old.ts', 'lib/new.ts']] });
    r.touch(['lib/new.ts', 'src/partner.ts']);
    const history = await loadHistory(r.dir, options);
    const model = new CoChangeModel(history.commits);
    assert.equal(model.id('src/old.ts'), undefined);
    assert.equal(model.changeCount[model.id('lib/new.ts')!], 4);
    assert.equal(model.pair(model.id('lib/new.ts')!, model.id('src/partner.ts')!)!.count, 3);
    assert.equal(history.stats.renamesFollowed, 1);
  });

  it('does not merge a reused path into the file that moved away', async () => {
    const r = repo();
    r.touch(['a.ts', 'b.ts']);
    r.commit({ message: 'rename a to c', move: [['a.ts', 'c.ts']] });
    r.touch(['a.ts', 'z.ts'], 'brand new a.ts');
    const history = await loadHistory(r.dir, options);
    const model = new CoChangeModel(history.commits);
    assert.equal(model.changeCount[model.id('c.ts')!], 2); // original a.ts history + rename
    assert.equal(model.changeCount[model.id('a.ts')!], 1); // only the new file
    assert.equal(model.pair(model.id('a.ts')!, model.id('b.ts')!), undefined);
  });

  it('skips sweeps and ignored files, keeping sweeps aside for backtests', async () => {
    const r = repo();
    r.touch(['a.ts', 'b.ts', 'package-lock.json', 'dist/out.js']);
    r.touch(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'], 'format everything');
    r.touch(['yarn.lock'], 'only a lockfile');
    const history = await loadHistory(r.dir, options);
    assert.equal(history.commits.length, 1);
    assert.deepEqual([...history.commits[0]!.files].sort(), ['a.ts', 'b.ts']);
    assert.equal(history.stats.sweepsSkipped, 1);
    assert.equal(history.stats.emptyAfterIgnores, 1);
    assert.equal(history.excluded.length, 1);
    assert.equal(history.excluded[0]!.subject, 'format everything');
  });

  it('skips commits by subject when asked', async () => {
    const r = repo();
    r.touch(['a.ts', 'b.ts'], 'chore: bump');
    r.touch(['a.ts', 'b.ts'], 'feat: real work');
    const history = await loadHistory(r.dir, { ...options, skipCommits: /^chore\b/i });
    assert.deepEqual(history.commits.map((c) => c.subject), ['feat: real work']);
    assert.equal(history.stats.subjectSkipped, 1);
  });

  it('handles spaces, unicode and newlines in file names', async () => {
    const r = repo();
    // Windows does not allow newlines in file names.
    const names = ['docs/read me.md', 'src/ünï.ts', ...(process.platform === 'win32' ? [] : ['weird\nname.ts'])];
    r.touch(names);
    r.touch(names);
    const history = await loadHistory(r.dir, options);
    const model = new CoChangeModel(history.commits);
    for (const f of names) assert.equal(model.changeCount[model.id(f)!], 2, f);
  });

  it('respects maxCommits and records authors and times', async () => {
    const r = repo();
    r.touch(['a.ts'], 'one', { author: 'Ada' });
    r.touch(['a.ts'], 'two', { author: 'Grace' });
    r.touch(['a.ts'], 'three', { author: 'Grace' });
    const history = await loadHistory(r.dir, { ...options, maxCommits: 2 });
    assert.deepEqual(history.commits.map((c) => c.subject), ['three', 'two']);
    const model = new CoChangeModel(history.commits);
    assert.deepEqual(model.topAuthors(model.id('a.ts')!), [{ author: 'Grace', commits: 2, share: 1 }]);
  });
});

describe('pre-change baseline isolation (diff --base)', () => {
  it('prevents branch commits from diluting a relationship from above 50% to below 50%', async () => {
    const r = repo();
    // Baseline on main: a.ts and b.ts change together 4 times, a.ts alone once -> 4/5 = 80% confidence.
    for (let i = 0; i < 4; i++) r.touch(['src/a.ts', 'src/b.ts'], `baseline pair ${i}`);
    r.touch(['src/a.ts'], 'baseline solo');
    const mainSha = r.git('rev-parse', 'HEAD').trim();

    // Feature branch: 6 commits touching only src/a.ts.
    // Under HEAD training, confidence would drop to 4 / (5 + 6) = 36.4% (< 50% threshold).
    r.git('checkout', '-q', '-b', 'feature');
    for (let i = 0; i < 6; i++) r.touch(['src/a.ts'], `branch solo ${i}`);
    const headSha = r.git('rev-parse', 'HEAD').trim();

    // 1. Programmatic caller that loaded default HEAD context before passing base to diff()
    const headCtx = await loadContext(r.dir, { minShared: 3, minConfidence: 0.5 });
    const result = await diff(headCtx, { base: 'main', limit: 10, kinds: ['ghost'] });
    assert.equal(result.suggestions.length, 1);
    assert.equal(result.suggestions[0]!.to, 'src/b.ts');
    assert.equal(result.suggestions[0]!.shared, 4);
    assert.equal(result.suggestions[0]!.fromChanges, 5);
    assert.equal(result.suggestions[0]!.confidence, 0.8);
    assert.equal(result.meta.commitsAnalyzed, 5);
    assert.equal(result.evaluation?.targetBranchRef, 'main');
    assert.equal(result.evaluation?.mergeBaseSha, mainSha);
    assert.equal(result.evaluation?.baselineSha, mainSha);
    assert.equal(result.evaluation?.headSha, headSha);
    assert.equal(result.evaluation?.commitsAnalyzed, 5);

    // 2. CLI invocation with --base main --min-confidence 0.5 --json
    const cli = runCli(['diff', '--base', 'main', '--min-confidence', '0.5', '--json'], r.dir);
    assert.equal(cli.code, 0, cli.stderr);
    const parsed = JSON.parse(cli.stdout);
    assert.equal(parsed.suggestions.length, 1);
    assert.equal(parsed.suggestions[0].to, 'src/b.ts');
    assert.equal(parsed.suggestions[0].confidence, 0.8);
    assert.equal(parsed.evaluation.mergeBaseSha, mainSha);
    assert.equal(parsed.evaluation.headSha, headSha);
  });

  it('prevents branch commits from artificially strengthening a weak baseline relationship', async () => {
    const r = repo();
    // Baseline on main: a.ts changes 8 times alone and only 2 times with b.ts (2/10 = 20%, shared=2 < 3).
    for (let i = 0; i < 8; i++) r.touch(['src/a.ts'], `solo ${i}`);
    for (let i = 0; i < 2; i++) r.touch(['src/a.ts', 'src/b.ts'], `pair ${i}`);
    const baselineBContent = r.git('show', 'HEAD:src/b.ts');

    // Feature branch: 6 commits touching both a.ts and b.ts (which on HEAD would make shared=8, conf=8/16=50%),
    // followed by restoring b.ts to its baseline content so only a.ts has a net change vs main.
    r.git('checkout', '-q', '-b', 'feature');
    for (let i = 0; i < 6; i++) r.touch(['src/a.ts', 'src/b.ts'], `branch pair ${i}`);
    r.commit({ message: 'restore b.ts to main', write: { 'src/b.ts': baselineBContent } });

    const ctx = await loadContext(r.dir, { minShared: 3, minConfidence: 0.4 }, { base: 'main' });
    const result = await diff(ctx, { base: 'main', limit: 10, kinds: ['ghost'] });
    assert.deepEqual(result.changed.map((c) => c.path), ['src/a.ts']);
    assert.deepEqual(result.suggestions, []);
  });

  it('reconciles a renamed source file back to its baseline identity without picking up deleted-file history at the new path', async () => {
    const r = repo();
    // An unrelated file once lived at src/auth.ts and was deleted on main before branching.
    for (let i = 0; i < 5; i++) r.touch(['src/auth.ts', 'src/old-unrelated.ts'], `legacy ${i}`);
    r.commit({ message: 'delete old auth.ts', write: { 'src/auth.ts': null } });

    // The real file lived at src/login.ts and always changed with src/session.ts.
    for (let i = 0; i < 4; i++) r.touch(['src/login.ts', 'src/session.ts'], `login ${i}`);

    // On feature branch, src/login.ts is renamed to src/auth.ts and edited across multiple commits.
    r.git('checkout', '-q', '-b', 'feature');
    r.commit({ message: 'rename login to auth', move: [['src/login.ts', 'src/auth.ts']] });
    for (let i = 0; i < 4; i++) r.touch(['src/auth.ts'], `feature edit ${i}`);

    const ctx = await loadContext(r.dir, { minShared: 3, minConfidence: 0.5 }, { base: 'main' });
    const result = await diff(ctx, { base: 'main', limit: 10, kinds: ['ghost'] });
    assert.equal(result.changed.length, 1);
    assert.equal(result.changed[0]!.path, 'src/auth.ts');
    assert.equal(result.changed[0]!.oldPath, 'src/login.ts');
    assert.equal(result.changed[0]!.historyPath, 'src/login.ts');
    assert.equal(result.changed[0]!.hasHistory, true);
    assert.deepEqual(result.suggestions.map((s) => [s.from, s.to, s.shared, s.fromChanges]), [
      ['src/auth.ts', 'src/session.ts', 4, 4],
    ]);
  });

  it('handles a renamed companion file both before and across the branch boundary', async () => {
    const r = repo();
    // Companion renamed on main before merge-base: old-comp.ts -> comp.ts
    for (let i = 0; i < 3; i++) r.touch(['src/a.ts', 'src/old-comp.ts'], `pre-rename ${i}`);
    r.commit({ message: 'rename companion on main', move: [['src/old-comp.ts', 'src/comp.ts']] });
    r.touch(['src/a.ts', 'src/comp.ts'], 'post-rename on main');

    r.git('checkout', '-q', '-b', 'feature');
    for (let i = 0; i < 4; i++) r.touch(['src/a.ts'], `edit a ${i}`);

    // 1. Companion renamed before merge-base is suggested under its merge-base name with full history
    const beforeRenameResult = await diff(
      await loadContext(r.dir, { minShared: 3, minConfidence: 0.5 }, { base: 'main' }),
      { base: 'main', limit: 10, kinds: ['ghost'] },
    );
    assert.deepEqual(beforeRenameResult.suggestions.map((s) => [s.to, s.shared, s.fromChanges]), [
      ['src/comp.ts', 4, 4],
    ]);

    // 2. When the companion itself is renamed on the feature branch (even across multiple hops),
    // diff --base main recognizes it was already touched and does not suggest it as missing.
    r.commit({ message: 'move comp step 1', move: [['src/comp.ts', 'src/comp-mid.ts']] });
    r.commit({ message: 'move comp step 2', move: [['src/comp-mid.ts', 'src/comp-final.ts']] });
    const afterBranchRename = await diff(
      await loadContext(r.dir, { minShared: 3, minConfidence: 0.5 }, { base: 'main' }),
      { base: 'main', limit: 10, kinds: ['ghost'] },
    );
    assert.deepEqual(afterBranchRename.suggestions, []);
  });

  it('tracks chained renames across branch commits and working-tree renames even when net content completely changes', async () => {
    const r = repo();
    const block = (tag: string) => Array.from({ length: 10 }, (_, i) => `export const ${tag}_${i} = ${i};`).join('\n') + '\n';
    for (let i = 0; i < 4; i++) {
      const tag = `v${i}00`;
      r.commit({
        message: `base ${i}`,
        write: {
          'src/step1.ts': block(`${tag}_p1`) + block(`${tag}_p2`) + block(`${tag}_p3`),
          'src/companion.ts': `export const c = ${i};\n`,
        },
      });
    }

    r.git('checkout', '-q', '-b', 'feature');
    // Commit 1: rename step1.ts -> step2.ts and rewrite 1/3 of lines (~67% similar to step1.ts)
    r.commit({
      message: 'rename to step2',
      move: [['src/step1.ts', 'src/step2.ts']],
      write: { 'src/step2.ts': block('v300_p1') + block('v300_p2') + block(' edit_p3') },
    });
    // Commit 2: rename step2.ts -> step3.ts and rewrite another 1/3 (~67% similar to step2.ts,
    // but only ~33% similar to step1.ts at main, so raw `git diff -M main...HEAD` emits D + A!)
    r.commit({
      message: 'rename to step3',
      move: [['src/step2.ts', 'src/step3.ts']],
      write: { 'src/step3.ts': block('v300_p1') + block('edit_p2') + block(' edit_p3') },
    });
    // Working tree: rename step3.ts -> step4.ts
    r.git('mv', 'src/step3.ts', 'src/step4.ts');

    const ctx = await loadContext(r.dir, { minShared: 3, minConfidence: 0.5 }, { base: 'main' });
    const result = await diff(ctx, { base: 'main', limit: 10, kinds: ['ghost'] });
    assert.equal(result.changed.length, 1);
    assert.equal(result.changed[0]!.path, 'src/step4.ts');
    assert.equal(result.changed[0]!.oldPath, 'src/step1.ts');
    assert.equal(result.changed[0]!.historyPath, 'src/step1.ts');
    assert.equal(result.changed[0]!.hasHistory, true);
    assert.deepEqual(result.changed[0]!.sources, ['branch', 'staged']);
    assert.deepEqual(result.suggestions.map((s) => [s.from, s.to, s.shared]), [
      ['src/step4.ts', 'src/companion.ts', 4],
    ]);
  });

  it('preserves Git ancestry topology when branch commit timestamps are out of order', async () => {
    const r = repo();
    for (let i = 0; i < 4; i++) r.touch(['src/orig.ts', 'src/partner.ts'], `base ${i}`, { day: i });

    r.git('checkout', '-q', '-b', 'feature');
    // Parent commit on branch has a LATER timestamp (day 20) than its child commit (day 5).
    r.commit({ message: 'step 1 rename', move: [['src/orig.ts', 'src/mid.ts']], day: 20 });
    r.commit({ message: 'step 2 rename', move: [['src/mid.ts', 'src/final.ts']], day: 5 });

    const ctx = await loadContext(r.dir, { minShared: 3, minConfidence: 0.5 }, { base: 'main' });
    const result = await diff(ctx, { base: 'main', limit: 10, kinds: ['ghost'] });
    assert.equal(result.changed.length, 1);
    assert.equal(result.changed[0]!.path, 'src/final.ts');
    assert.equal(result.changed[0]!.oldPath, 'src/orig.ts');
    assert.equal(result.changed[0]!.historyPath, 'src/orig.ts');
    assert.equal(result.suggestions[0]?.to, 'src/partner.ts');
  });

  it('does not leak baseline history into files deleted and recreated on the branch or before the branch', async () => {
    const r = repo();
    for (let i = 0; i < 4; i++) {
      r.touch(['src/recreated-on-branch.ts', 'src/partner1.ts'], `p1 ${i}`);
      r.touch(['src/deleted-on-main.ts', 'src/partner2.ts'], `p2 ${i}`);
      r.touch(['src/moved-away.ts', 'src/partner3.ts'], `p3 ${i}`);
    }
    // Delete src/deleted-on-main.ts on main before branching.
    r.commit({ message: 'delete on main', write: { 'src/deleted-on-main.ts': null } });

    r.git('checkout', '-q', '-b', 'feature');
    // 1. Delete and recreate src/recreated-on-branch.ts on the branch
    r.commit({ message: 'delete on branch', write: { 'src/recreated-on-branch.ts': null } });
    r.commit({ message: 'recreate on branch', write: { 'src/recreated-on-branch.ts': 'export const fresh = 1;\n' } });
    // 2. Recreate src/deleted-on-main.ts on the branch
    r.commit({ message: 'recreate deleted-on-main', write: { 'src/deleted-on-main.ts': 'export const fresh2 = 1;\n' } });
    // 3. Rename src/moved-away.ts -> src/moved-dest.ts, then create a brand-new src/moved-away.ts
    r.commit({
      message: 'move away',
      move: [['src/moved-away.ts', 'src/moved-dest.ts']],
    });
    r.commit({
      message: 'replace old path with unrelated file',
      write: { 'src/moved-away.ts': 'export const replacement = 1;\n' },
    });

    const ctx = await loadContext(r.dir, { minShared: 3, minConfidence: 0.5 }, { base: 'main' });
    const result = await diff(ctx, { base: 'main', limit: 10, kinds: ['ghost'] });
    const byPath = new Map(result.changed.map((c) => [c.path, c]));

    assert.equal(byPath.get('src/recreated-on-branch.ts')?.hasHistory, false);
    assert.equal(byPath.get('src/recreated-on-branch.ts')?.historyPath, undefined);

    assert.equal(byPath.get('src/deleted-on-main.ts')?.hasHistory, false);
    assert.equal(byPath.get('src/deleted-on-main.ts')?.historyPath, undefined);

    assert.equal(byPath.get('src/moved-away.ts')?.hasHistory, false);
    assert.equal(byPath.get('src/moved-away.ts')?.historyPath, undefined);

    assert.equal(byPath.get('src/moved-dest.ts')?.hasHistory, true);
    assert.equal(byPath.get('src/moved-dest.ts')?.historyPath, 'src/moved-away.ts');

    // Only partner3.ts (linked from moved-dest.ts) should be suggested; partner1.ts and partner2.ts must not be!
    assert.deepEqual(result.suggestions.map((s) => [s.from, s.to]), [
      ['src/moved-dest.ts', 'src/partner3.ts'],
    ]);
  });

  it('combines branch changes with uncommitted working-tree edits and exclusions', async () => {
    const r = repo();
    for (let i = 0; i < 4; i++) r.touch(['src/a.ts', 'src/b.ts'], `pair ${i}`);

    r.git('checkout', '-q', '-b', 'feature');
    r.touch(['src/a.ts'], 'branch edit to a');

    // Touching the companion in the working tree suppresses the suggestion
    r.write('src/b.ts', 'export const b = "updated in working tree";\n');
    const bothChanged = await diff(
      await loadContext(r.dir, { minShared: 3, minConfidence: 0.5 }, { base: 'main' }),
      { base: 'main', limit: 10, kinds: ['ghost'] },
    );
    assert.deepEqual(bothChanged.suggestions, []);

    // Reverting working-tree edit to b.ts and deleting+recreating a.ts in working tree
    r.git('checkout', '-q', '--', 'src/b.ts');
    r.git('rm', '-q', 'src/a.ts');
    r.write('src/a.ts', 'export const brandNewUncommitted = 1;\n');
    const recreatedInWt = await diff(
      await loadContext(r.dir, { minShared: 3, minConfidence: 0.5 }, { base: 'main' }),
      { base: 'main', limit: 10, kinds: ['ghost'] },
    );
    assert.equal(recreatedInWt.changed.find((c) => c.path === 'src/a.ts')?.hasHistory, false);
    assert.deepEqual(recreatedInWt.suggestions, []);
  });

  it('fails clearly on invalid refs, orphan branches, and ambiguous criss-cross merge bases', async () => {
    const r = repo();
    for (let i = 0; i < 4; i++) r.touch(['src/a.ts', 'src/b.ts'], `pair ${i}`);

    // 1. Invalid ref and option-like ref
    await assert.rejects(
      loadContext(r.dir, {}, { base: 'nonexistent-ref' }),
      (err: unknown) => err instanceof UsageError && /not a branch, tag or commit/.test(err.message),
    );
    await assert.rejects(
      loadContext(r.dir, {}, { base: '--all' }),
      (err: unknown) => err instanceof UsageError && /not a branch, tag or commit/.test(err.message),
    );

    // 2. Orphan branch (no common ancestor with main)
    r.git('checkout', '-q', '--orphan', 'orphan-branch');
    r.git('rm', '-rf', '-q', '.');
    r.touch(['src/orphan.ts'], 'orphan root');
    await assert.rejects(
      loadContext(r.dir, {}, { base: 'main' }),
      (err: unknown) => err instanceof UsageError && /no common ancestor/.test(err.message),
    );

    // 3. Criss-cross merge producing multiple merge bases between branchA and branchB
    r.git('checkout', '-q', 'main');
    r.git('checkout', '-q', '-b', 'branch-a');
    r.touch(['src/a-only.ts'], 'A1');
    const a1 = r.git('rev-parse', 'HEAD').trim();

    r.git('checkout', '-q', 'main');
    r.git('checkout', '-q', '-b', 'branch-b');
    r.touch(['src/b-only.ts'], 'B1');
    const b1 = r.git('rev-parse', 'HEAD').trim();

    // A2 merges B1; B2 merges A1 -> A2 and B2 now have two merge bases (A1 and B1)
    r.git('checkout', '-q', 'branch-a');
    r.git('merge', '-q', '--no-edit', b1);
    r.touch(['src/a.ts'], 'A2 work');

    r.git('checkout', '-q', 'branch-b');
    r.git('merge', '-q', '--no-edit', a1);
    r.touch(['src/a.ts'], 'B2 work');

    await assert.rejects(
      loadContext(r.dir, {}, { base: 'branch-a' }),
      (err: unknown) => err instanceof UsageError && /multiple merge bases/.test(err.message) && /--base <sha>/.test(err.message),
    );
    const cli = runCli(['diff', '--base', 'branch-a'], r.dir);
    assert.equal(cli.code, 2);
    assert.match(cli.stderr, /multiple merge bases/);
    assert.match(cli.stderr, /--base <sha>/);

    // Passing one of the listed merge-base SHAs explicitly succeeds
    const explicitBaseCtx = await loadContext(r.dir, { minShared: 3, minConfidence: 0.5 }, { base: a1.slice(0, 7) });
    const explicitBaseDiff = await diff(explicitBaseCtx, { base: a1.slice(0, 7), limit: 10, kinds: ['ghost'] });
    assert.equal(explicitBaseDiff.evaluation?.mergeBaseSha, a1);
    assert.equal(explicitBaseDiff.suggestions[0]?.to, 'src/b.ts');
  });

  it('handles branches containing merge commits without phantom files (S1) or lost history (S2 in both parent orders)', async () => {
    // S1: Feature renames src/a.ts -> src/r.ts; side branch edits src/a.ts; clean merge leaves only r.ts, b.ts, c.ts
    const s1 = repo();
    const baseLines = Array.from({ length: 10 }, (_, i) => `export const line${i} = ${i};`).join('\n') + '\n';
    for (let i = 0; i < 4; i++) {
      s1.commit({
        message: `base ${i}`,
        write: {
          'src/a.ts': `${baseLines}// rev ${i}\n`,
          'src/b.ts': `export const b = ${i};\n`,
          'src/c.ts': `export const c = ${i};\n`,
        },
      });
    }
    s1.git('checkout', '-q', '-b', 'side');
    s1.commit({
      message: 'side edits a.ts',
      write: { 'src/a.ts': `${baseLines}// rev 3\nexport const sideEdit = true;\n` },
    });
    s1.git('checkout', '-q', 'main');
    s1.git('checkout', '-q', '-b', 'feature');
    s1.commit({ message: 'feature renames a.ts to r.ts', move: [['src/a.ts', 'src/r.ts']] });
    s1.git('merge', '-q', '--no-edit', 'side');

    const s1Ctx = await loadContext(s1.dir, { minShared: 3, minConfidence: 0.5 }, { base: 'main' });
    const s1Res = await diff(s1Ctx, { base: 'main', limit: 10, kinds: ['ghost'] });
    assert.deepEqual(
      s1Res.changed.map((c) => [c.path, c.oldPath, c.hasHistory, c.historyPath]),
      [['src/r.ts', 'src/a.ts', true, 'src/a.ts']],
    );
    assert.ok(s1Res.meta.warnings.some((w) => /merge commits/.test(w)));
    assert.deepEqual(s1Res.suggestions.map((s) => s.to).sort(), ['src/b.ts', 'src/c.ts']);

    // S2 (both parent orders): one parent deletes src/a.ts, the other edits src/a.ts, merge keeps src/a.ts
    for (const deleteFirstParent of [true, false]) {
      const s2 = repo();
      for (let i = 0; i < 4; i++) s2.touch(['src/a.ts', 'src/b.ts', 'src/c.ts'], `base ${i}`);
      s2.git('checkout', '-q', '-b', 'side');
      if (deleteFirstParent) {
        s2.touch(['src/a.ts'], 'side edits a.ts');
      } else {
        s2.commit({ message: 'side deletes a.ts', write: { 'src/a.ts': null } });
      }
      s2.git('checkout', '-q', 'main');
      s2.git('checkout', '-q', '-b', 'feature');
      if (deleteFirstParent) {
        s2.commit({ message: 'feature deletes a.ts', write: { 'src/a.ts': null } });
      } else {
        s2.touch(['src/a.ts'], 'feature edits a.ts');
      }
      // Merge `side` into `feature` and resolve the delete/modify conflict by keeping modified src/a.ts
      spawnSync('git', ['merge', '--no-commit', 'side'], { cwd: s2.dir });
      s2.write('src/a.ts', 'export const keptAfterMerge = 1;\n');
      s2.git('add', '--', 'src/a.ts');
      s2.git('commit', '-q', '-m', 'resolve conflict keeping a.ts');

      const s2Ctx = await loadContext(s2.dir, { minShared: 3, minConfidence: 0.5 }, { base: 'main' });
      const s2Res = await diff(s2Ctx, { base: 'main', limit: 10, kinds: ['ghost'] });
      assert.deepEqual(
        s2Res.changed.map((c) => [c.path, c.added, c.hasHistory, c.historyPath]),
        [['src/a.ts', false, true, 'src/a.ts']],
      );
      assert.ok(s2Res.meta.warnings.some((w) => /merge commits/.test(w)));
      assert.deepEqual(s2Res.suggestions.map((s) => s.to).sort(), ['src/b.ts', 'src/c.ts']);
    }
  });

  it('omits mergeBaseSha without --base and reloads at HEAD if a base-isolated context is passed to diff without --base', async () => {
    const r = repo();
    for (let i = 0; i < 2; i++) r.touch(['src/a.ts', 'src/b.ts'], `main pair ${i}`);
    const mainSha = r.git('rev-parse', 'HEAD').trim();

    r.git('checkout', '-q', '-b', 'feature');
    // Add 2 more co-changes on the branch so HEAD has 4 co-changes (meeting minShared=3) while main has only 2
    for (let i = 0; i < 2; i++) r.touch(['src/a.ts', 'src/b.ts'], `branch pair ${i}`);
    const headSha = r.git('rev-parse', 'HEAD').trim();

    // Working-tree edit to src/a.ts
    r.write('src/a.ts', 'export const workingEdit = 1;\n');

    // 1. Context loaded with { base: 'main' } has mergeBaseSha = mainSha and does NOT suggest b.ts under --base main
    const baseCtx = await loadContext(r.dir, { minShared: 3, minConfidence: 0.5 }, { base: 'main' });
    assert.equal(baseCtx.mergeBaseSha, mainSha);
    const withBase = await diff(baseCtx, { base: 'main', limit: 10, kinds: ['ghost'] });
    assert.equal(withBase.evaluation?.mergeBaseSha, mainSha);
    assert.equal(withBase.evaluation?.baselineSha, mainSha);
    assert.deepEqual(withBase.suggestions, []);

    // 2. Passing that base-isolated context to diff WITHOUT --base reloads at HEAD (4 co-changes) and omits mergeBaseSha
    const reloadedNoBase = await diff(baseCtx, { limit: 10, kinds: ['ghost'] });
    assert.equal(reloadedNoBase.evaluation?.mergeBaseSha, undefined);
    assert.equal(reloadedNoBase.evaluation?.baselineSha, headSha);
    assert.equal(reloadedNoBase.evaluation?.commitsAnalyzed, 4);
    assert.deepEqual(reloadedNoBase.suggestions.map((s) => [s.from, s.to, s.shared]), [
      ['src/a.ts', 'src/b.ts', 4],
    ]);

    // 3. Default loadContext without { base } also omits mergeBaseSha
    const headCtx = await loadContext(r.dir, { minShared: 3, minConfidence: 0.5 });
    assert.equal(headCtx.mergeBaseSha, undefined);
    const directNoBase = await diff(headCtx, { limit: 10, kinds: ['ghost'] });
    assert.equal(directNoBase.evaluation?.mergeBaseSha, undefined);
    assert.equal(directNoBase.evaluation?.baselineSha, headSha);
  });

  it('handles shallow history and unusual filenames on a branch', async () => {
    const r = repo();
    const names = [
      'docs/read me.md',
      'src/ünï.ts',
      'src/-leading-dash.ts',
      ...(process.platform === 'win32' ? [] : ['src/weird\nname.ts']),
    ];
    for (let i = 0; i < 4; i++) r.touch(names, `base ${i}`);

    r.git('checkout', '-q', '-b', 'feature');
    r.commit({ message: 'rename unusual file', move: [['docs/read me.md', 'docs/moved name.md']] });
    r.touch(['docs/moved name.md'], 'edit moved unusual file');

    const ctx = await loadContext(r.dir, { minShared: 3, minConfidence: 0.5 }, { base: 'main' });
    const result = await diff(ctx, { base: 'main', limit: 10, kinds: ['ghost', 'unknown'] });
    const moved = result.changed.find((c) => c.path === 'docs/moved name.md');
    assert.equal(moved?.oldPath, 'docs/read me.md');
    assert.equal(moved?.historyPath, 'docs/read me.md');
    assert.ok(result.suggestions.some((s) => s.to === 'src/ünï.ts'));
    assert.ok(result.suggestions.some((s) => s.to === 'src/-leading-dash.ts'));

    // Shallow clone where the merge-base was truncated beyond depth=1
    for (let i = 0; i < 3; i++) r.touch(['docs/moved name.md'], `deeper feature commit ${i}`);
    const shallowDir = mkdtempSync(join(tmpdir(), 'ra-shallow-'));
    extraDirs.push(shallowDir);
    execFileSync('git', ['clone', '-q', '--depth', '1', '--no-single-branch', `file://${r.dir}`, shallowDir]);
    await assert.rejects(
      loadContext(shallowDir, {}, { base: 'origin/main' }),
      (err: unknown) => err instanceof UsageError && /shallow clone/.test(err.message) && /--unshallow/.test(err.message),
    );
  });
});
