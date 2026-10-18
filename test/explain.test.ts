import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import vm from 'node:vm';
import { explain, formatExplainCommand, MAX_EXPLAIN_COMMITS, printExplain } from '../src/commands/explain.js';
import { attachMapPatches, buildMapData, writeMap } from '../src/commands/map.js';
import { loadContext, UsageError } from '../src/context.js';
import { fetchPairCommitPatches, fetchSingleFilePatch, parseSingleFileDiff } from '../src/git/patch.js';
import { runGitBounded } from '../src/git/run.js';
import { renderMapHtml } from '../src/map/template.js';
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
after(() => repos.forEach((r) => r.cleanup()));
function createRepo(): FixtureRepo {
  const r = new FixtureRepo();
  repos.push(r);
  return r;
}

const flags = { minShared: 2, minConfidence: 0.3 };

describe('explain command & verifiable change evidence', () => {
  it('resolves historical file paths across chained renames and isolates deleted/recreated lifetimes', async () => {
    const r = createRepo();

    // Lifetime 1 of src/recreated.ts (later deleted) co-changes with src/partner.ts
    r.commit({
      message: 'early lifetime 1',
      write: {
        'src/recreated.ts': 'export const oldLifetime = "LEAK_GUARD_OLD_LIFETIME";\n',
        'src/partner.ts': 'export const partner = 1;\n',
      },
    });
    r.commit({
      message: 'early lifetime 2',
      write: {
        'src/recreated.ts': 'export const oldLifetime = "LEAK_GUARD_OLD_LIFETIME_2";\n',
        'src/partner.ts': 'export const partner = 2;\n',
      },
    });
    r.commit({
      message: 'delete old recreated.ts',
      write: { 'src/recreated.ts': null },
    });

    // Chained rename: legacy/v1/auth.ts -> src/v2/auth.ts -> src/auth/service.ts
    // while co-changing with src/partner.ts (and new lifetime of src/recreated.ts)
    const authHeader = '// Shared auth module header\nexport interface AuthSession { id: string; }\nexport function verifySession(s: AuthSession): boolean { return Boolean(s.id); }\n';
    r.commit({
      message: 'step 1: create legacy auth and recreated v2',
      write: {
        'legacy/v1/auth.ts': `${authHeader}export const tokenVersion = 1;\n`,
        'src/partner.ts': 'export const partner = 10;\n',
        'src/recreated.ts': 'export const freshLifetime = "FRESH_LIFETIME_V1";\n',
      },
    });
    r.commit({
      message: 'step 2: rename to v2 and edit',
      move: [['legacy/v1/auth.ts', 'src/v2/auth.ts']],
      write: {
        'src/v2/auth.ts': `${authHeader}export const tokenVersion = 2;\n`,
        'src/partner.ts': 'export const partner = 20;\n',
        'src/recreated.ts': 'export const freshLifetime = "FRESH_LIFETIME_V2";\n',
      },
    });
    r.commit({
      message: 'step 3: rename to service.ts without content changes',
      move: [['src/v2/auth.ts', 'src/auth/service.ts']],
      write: {
        'src/partner.ts': 'export const partner = 30;\n',
      },
    });
    r.commit({
      message: 'step 4: edit under final name',
      write: {
        'src/auth/service.ts': `${authHeader}export const tokenVersion = 4;\n`,
        'src/partner.ts': 'export const partner = 40;\n',
      },
    });

    // Solo commits to create counterexamples in both directions
    r.commit({
      message: 'solo auth edit',
      write: { 'src/auth/service.ts': `${authHeader}export const tokenVersion = 5;\n` },
    });
    r.commit({
      message: 'solo partner edit',
      write: { 'src/partner.ts': 'export const partner = 50;\n' },
    });

    const ctx = await loadContext(r.dir, flags);
    const res = await explain(ctx, 'src/auth/service.ts', 'src/partner.ts', { commits: 5 });

    assert.equal(res.from, 'src/auth/service.ts');
    assert.equal(res.to, 'src/partner.ts');
    assert.equal(res.shared, 4);
    assert.equal(res.sharedCommits.length, 4);
    assert.match(res.disclaimer, /not proof of why/i);

    // Commit order is newest first: step 4 -> step 3 -> step 2 -> step 1
    const [c4, c3, c2, c1] = res.sharedCommits;
    assert.equal(c4!.fileA.path, 'src/auth/service.ts');
    assert.equal(c4!.fileA.status, 'M');
    assert.ok(c4!.fileA.hunks.some((h) => h.lines.some((l) => l.includes('+export const tokenVersion = 4;'))));

    // step 3 was a pure 100% rename from src/v2/auth.ts -> src/auth/service.ts
    assert.equal(c3!.fileA.status, 'R');
    assert.equal(c3!.fileA.oldPath, 'src/v2/auth.ts');
    assert.equal(c3!.fileA.path, 'src/auth/service.ts');
    assert.equal(c3!.fileA.hunks.length, 0);
    assert.match(c3!.fileA.statusNote ?? '', /Renamed from src\/v2\/auth\.ts to src\/auth\/service\.ts/);

    // step 2 was a rename with content edit from legacy/v1/auth.ts -> src/v2/auth.ts
    assert.equal(c2!.fileA.status, 'R');
    assert.equal(c2!.fileA.oldPath, 'legacy/v1/auth.ts');
    assert.equal(c2!.fileA.path, 'src/v2/auth.ts');
    assert.ok(c2!.fileA.hunks.some((h) => h.lines.some((l) => l.includes('+export const tokenVersion = 2;'))));

    // step 1 was added under legacy/v1/auth.ts
    assert.equal(c1!.fileA.status, 'A');
    assert.equal(c1!.fileA.path, 'legacy/v1/auth.ts');
    assert.ok(c1!.fileA.hunks.some((h) => h.lines.some((l) => l.includes('+export const tokenVersion = 1;'))));

    // Counterexamples in both directions are populated (metadata only by default)
    assert.equal(res.counterexamples.fromWithoutToTotal, 1);
    assert.equal(res.counterexamples.fromWithoutTo[0]?.subject, 'solo auth edit');
    assert.equal(res.counterexamples.fromWithoutTo[0]?.patch, undefined);
    assert.equal(res.counterexamples.toWithoutFromTotal, 3); // 2 early + 1 solo
    assert.equal(res.counterexamples.toWithoutFrom.length, 3);

    // With counterexamples: true, patch hunks are fetched for counterexamples too
    const withCxPatches = await explain(ctx, 'src/auth/service.ts', 'src/partner.ts', {
      commits: 1,
      counterexamples: true,
    });
    assert.ok(
      withCxPatches.counterexamples.fromWithoutTo[0]?.patch?.hunks.some((h) =>
        h.lines.some((l) => l.includes('+export const tokenVersion = 5;')),
      ),
    );

    // Deleted and recreated file (`src/recreated.ts`) must ONLY show the fresh lifetime (2 shared commits),
    // never leaking `LEAK_GUARD_OLD_LIFETIME` from the earlier deleted file at the same path.
    const recreatedRes = await explain(ctx, 'src/recreated.ts', 'src/partner.ts', { commits: 5 });
    assert.equal(recreatedRes.shared, 2);
    const serializedRecreated = JSON.stringify(recreatedRes);
    assert.ok(serializedRecreated.includes('FRESH_LIFETIME_V1'));
    assert.ok(serializedRecreated.includes('FRESH_LIFETIME_V2'));
    assert.ok(!serializedRecreated.includes('LEAK_GUARD_OLD_LIFETIME'));
  });

  it('handles binary files, initial commits, empty files, deleted files, and unsupported paths gracefully', async () => {
    const r = createRepo();

    // Initial commit (root commit in repo): empty file + normal file + binary file
    const writeRaw = (rel: string, content: Buffer | string) => {
      const full = join(r.dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    };
    writeRaw('src/init.ts', 'export const init = 1;\n');
    writeRaw('src/empty.ts', '');
    writeRaw('assets/logo.bin', Buffer.from([0x00, 0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
    r.git('add', '-A');
    r.git('commit', '-qm', 'initial root commit');
    const rootSha = r.git('rev-parse', 'HEAD').trim();

    // Second commit: modify binary + init + empty (still empty via mode or touch)
    writeRaw('src/init.ts', 'export const init = 2;\n');
    writeRaw('assets/logo.bin', Buffer.from([0x00, 0x89, 0x50, 0x4e, 0x47, 0x01, 0xfe]));
    r.git('add', '-A');
    r.git('commit', '-qm', 'update binary and init');

    const ctx = await loadContext(r.dir, { minShared: 1, minConfidence: 0 });
    const binExplain = await explain(ctx, 'src/init.ts', 'assets/logo.bin', { commits: 5 });
    assert.equal(binExplain.sharedCommits.length, 2);

    // Root commit is inspected with --root and binary file is flagged as binary without crashing
    const rootCommitEv = binExplain.sharedCommits.find((c) => c.hash === rootSha)!;
    assert.ok(rootCommitEv);
    assert.equal(rootCommitEv.fileA.status, 'A');
    assert.ok(rootCommitEv.fileA.hunks.length > 0);
    assert.equal(rootCommitEv.fileB.binary, true);
    assert.equal(rootCommitEv.fileB.hunks.length, 0);
    assert.match(rootCommitEv.fileB.statusNote ?? '', /Binary file changed/);

    // Empty file in root commit reports emptyDiff = true and a clear statusNote
    const emptyExplain = await explain(ctx, 'src/init.ts', 'src/empty.ts', { commits: 5 });
    assert.equal(emptyExplain.sharedCommits.length, 1);
    assert.equal(emptyExplain.sharedCommits[0]?.fileB.emptyDiff, true);
    assert.match(emptyExplain.sharedCommits[0]?.fileB.statusNote ?? '', /Empty file added/);

    // Unsupported path containing control characters (newline or NUL) is handled gracefully without running git
    const unsupported = await fetchSingleFilePatch(r.dir, rootSha, 'bad\npath.ts', {
      status: 'M',
      path: 'bad\npath.ts',
    });
    assert.equal(unsupported.unsupportedPath, true);
    assert.equal(unsupported.hunks.length, 0);
    assert.match(unsupported.statusNote ?? '', /control characters/i);
  });

  it('enforces bounds on commit count, hunk count, lines per hunk, line length, patch bytes, and total output lines', async () => {
    const r = createRepo();

    // Create 12 shared commits (exceeding MAX_EXPLAIN_COMMITS = 10) with multi-hunk / long-line content
    const baseLines = Array.from({ length: 60 }, (_, i) => `export const line${i} = ${i};`);
    for (let c = 1; c <= 12; c++) {
      const updatedA = [...baseLines];
      updatedA[0] = `export const line0 = "${'X'.repeat(300)}_${c}";`;
      updatedA[20] = `export const line20 = ${c * 100};`;
      updatedA[40] = `export const line40 = ${c * 200};`;
      updatedA[58] = `export const line58 = ${c * 300};`;
      const bigBlockB = Array.from({ length: 40 }, (_, j) => `export const bLine${j} = "${c}_${j}";`).join('\n') + '\n';
      r.commit({
        message: `shared commit ${c}`,
        write: {
          'src/heavyA.ts': updatedA.join('\n') + '\n',
          'src/heavyB.ts': bigBlockB,
        },
      });
    }

    const ctx = await loadContext(r.dir, flags);

    // 1. Commit cap (MAX_EXPLAIN_COMMITS = 10) + hunk count (max 2) + lines per hunk (max 4) + line length (max 80)
    const bounded = await explain(ctx, 'src/heavyA.ts', 'src/heavyB.ts', {
      commits: 25,
      maxHunksPerFile: 2,
      maxLinesPerHunk: 4,
      maxLineLength: 80,
      maxTotalPatchLines: 500,
    });
    assert.equal(bounded.sharedCommits.length, MAX_EXPLAIN_COMMITS);
    assert.equal(bounded.bounds.commitsTruncated, true);

    const latest = bounded.sharedCommits[0]!;
    assert.ok(latest.fileA.hunks.length <= 2);
    assert.ok(latest.fileA.omittedHunks >= 1);
    assert.equal(latest.fileA.truncated, true);
    assert.equal(latest.fileA.hunks[0]?.lines.length, 4);
    assert.equal(latest.fileA.hunks[0]?.lineClipped, true);
    assert.ok(latest.fileA.hunks[0]!.lines.every((l) => l.length <= 80));
    assert.ok(latest.fileB.hunks[0]!.lines.length <= 4);
    assert.ok(latest.fileB.omittedLines > 0);

    // 2. Total output line cap across the whole explain result
    const totalCapped = await explain(ctx, 'src/heavyA.ts', 'src/heavyB.ts', {
      commits: 3,
      maxTotalPatchLines: 6,
    });
    assert.equal(totalCapped.bounds.outputTruncated, true);
    const totalEmittedLines = totalCapped.sharedCommits.reduce(
      (sum, sc) =>
        sum +
        sc.fileA.hunks.reduce((s, h) => s + 1 + h.lines.length, 0) +
        sc.fileB.hunks.reduce((s, h) => s + 1 + h.lines.length, 0),
      0,
    );
    assert.ok(totalEmittedLines <= 6, `Expected <= 6 total patch lines, got ${totalEmittedLines}`);

    // 3. Raw patch byte cap per git subprocess call
    const byteCapped = await explain(ctx, 'src/heavyA.ts', 'src/heavyB.ts', {
      commits: 1,
      maxPatchBytes: 180,
    });
    assert.ok(byteCapped.sharedCommits[0]!.fileA.truncated || byteCapped.sharedCommits[0]!.fileB.truncated);
  });

  it('safely handles malformed/adversarial filenames and escapes control/bidi/script sequences', async () => {
    const r = createRepo();

    // Filenames with leading dash, spaces, quotes, and git pathspec glob characters
    // (Windows NTFS forbids double quotes in filenames, so use single quotes on win32)
    const dashFile = '-leading-dash.ts';
    const globFile = process.platform === 'win32' ? "src/[glob] 'quoted' file.ts" : 'src/[glob] "quoted" file.ts';

    for (let i = 1; i <= 3; i++) {
      r.commit({
        message: `commit ${i} with \u001b[31mANSI\u001b[0m and \u202ebidi and </script><script>alert(1)</script>`,
        write: {
          [dashFile]: `export const d = ${i}; // \u001b[32mTERM_ESC\u001b[0m \u202eBIDI\n`,
          [globFile]: `export const g = "${i} </script><script>alert(1)</script>";\n`,
        },
      });
    }

    const ctx = await loadContext(r.dir, flags);
    const res = await explain(ctx, dashFile, globFile, { commits: 2 });
    assert.equal(res.shared, 3);
    assert.equal(res.sharedCommits.length, 2);
    assert.ok(res.sharedCommits[0]!.fileA.hunks.length > 0);
    assert.ok(res.sharedCommits[0]!.fileB.hunks.length > 0);

    // CLI command includes `--` when a filename starts with `-` and quotes special characters
    const cmdStr = formatExplainCommand(dashFile, globFile);
    assert.match(cmdStr, /^npx repo-archaeology explain -- /);

    // Verify CLI terminal output escapes raw ESC (\x1b) and bidi (\u202e) characters in both commit subjects and diff lines
    const cliRun = runCli(['explain', '--', dashFile, globFile], r.dir);
    assert.equal(cliRun.code, 0, cliRun.stderr);
    assert.ok(!cliRun.stdout.includes('\u001b[31m'));
    assert.ok(!cliRun.stdout.includes('\u001b[32m'));
    assert.ok(!cliRun.stdout.includes('\u202e'));
    assert.ok(cliRun.stdout.includes('\\x1b[32mTERM_ESC'));
    assert.ok(cliRun.stdout.includes('\\u202e'));

    // Rejects identical files or unknown files with exit code 2
    await assert.rejects(() => explain(ctx, dashFile, dashFile), UsageError);
    const badCli = runCli(['explain', 'no-such-file.ts', globFile], r.dir);
    assert.equal(badCli.code, 2);
  });

  it('keeps source-code snippets out of map HTML by default and embeds bounded patches only with --include-patches', async () => {
    const r = createRepo();
    const secretSentinel = 'SUPER_SECRET_PROPRIETARY_TOKEN_987654321';

    for (let i = 1; i <= 4; i++) {
      r.commit({
        message: `coupled change ${i}`,
        write: {
          'src/serviceA.ts': `export const secretA = "${secretSentinel}_${i}";\n`,
          'src/serviceB.ts': `export const secretB = "${secretSentinel}_${i} </script><script>evil()</script>";\n`,
        },
      });
    }
    r.commit({
      message: 'solo serviceA change',
      write: { 'src/serviceA.ts': `export const secretA = "solo";\n` },
    });

    const ctx = await loadContext(r.dir, flags);

    // 1. Default map: zero source patches embedded, zero `git show` calls, secret sentinel never appears in HTML
    const defaultData = buildMapData(ctx, { edges: 50, kinds: ['ghost', 'unknown', 'indirect', 'direct'] });
    assert.equal(defaultData.patchesIncluded, false);
    assert.equal(defaultData.edges.length, 1);
    assert.equal(defaultData.edges[0]?.evidence[0]?.patches, undefined);
    assert.equal(
      defaultData.edges[0]?.explainCommand,
      'npx repo-archaeology explain src/serviceB.ts src/serviceA.ts',
    );
    assert.equal(defaultData.edges[0]?.counterexamples?.toOnly.length, 1);
    assert.equal(defaultData.edges[0]?.counterexamples?.toOnlyTotal, 1);
    assert.equal(defaultData.edges[0]?.counterexamples?.fromOnlyTotal, 0);

    if (process.platform !== 'win32') {
      const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
      const logBinDir = join(r.dir, '.git-log-bin');
      const gitLogFile = join(r.dir, 'git-calls.log');
      mkdirSync(logBinDir, { recursive: true });
      writeFileSync(gitLogFile, '', 'utf8');
      const wrapper = join(logBinDir, 'git');
      writeFileSync(
        wrapper,
        `#!/bin/sh\necho "$@" >> "${gitLogFile}"\nexec "${realGit}" "$@"\n`,
        'utf8',
      );
      chmodSync(wrapper, 0o755);
      const origPath = process.env.PATH;
      process.env.PATH = `${logBinDir}${delimiter}${origPath ?? ''}`;
      try {
        await writeMap(ctx, {
          edges: 50,
          kinds: ['ghost', 'unknown', 'indirect', 'direct'],
          out: join(r.dir, 'default-map.html'),
          open: false,
        });
      } finally {
        process.env.PATH = origPath;
      }
      const gitCalls = readFileSync(gitLogFile, 'utf8')
        .split('\n')
        .filter((line) => line.includes(' show '));
      assert.equal(gitCalls.length, 0, `Expected 0 git show calls during default map, got: ${gitCalls.join('; ')}`);
    }

    const defaultHtml = renderMapHtml(defaultData);
    assert.ok(!defaultHtml.includes(secretSentinel), 'Default map HTML must not contain source code');
    assert.ok(defaultHtml.includes('npx repo-archaeology explain src/serviceB.ts src/serviceA.ts'));
    assert.ok(
      defaultHtml.includes('This file still contains file paths, commit subjects and author names.'),
      'Default map HTML should include honest privacy note about metadata',
    );

    // Non-default history settings (--since, --half-life, --ignore, --no-default-ignores) are propagated into explainCommand,
    // while config-file ignores are not duplicated.
    writeFileSync(join(r.dir, '.repo-archaeology.json'), JSON.stringify({ ignore: ['from-config/**'] }), 'utf8');
    const customCtx = await loadContext(r.dir, {
      ...flags,
      since: '2024-01-01',
      halfLifeDays: 60,
      useDefaultIgnores: false,
      ignore: ['docs/**'],
    });
    const customMapData = buildMapData(customCtx, { edges: 50, kinds: ['ghost', 'unknown', 'indirect', 'direct'] });
    assert.equal(
      customMapData.edges[0]?.explainCommand,
      "npx repo-archaeology explain --since 2024-01-01 --half-life 60 --no-default-ignores --ignore 'docs/**' src/serviceB.ts src/serviceA.ts",
    );

    // 2. Opt-in map (--include-patches): embeds bounded patches, escapes </script>, and adds warning
    const optInOut = join(r.dir, 'map-with-patches.html');
    const { data: optInData } = await writeMap(ctx, {
      edges: 50,
      kinds: ['ghost', 'unknown', 'indirect', 'direct'],
      includePatches: true,
      out: optInOut,
      open: false,
    });
    assert.equal(optInData.patchesIncluded, true);
    assert.ok(optInData.edges[0]?.evidence[0]?.patches?.source.hunks.length);
    assert.ok(optInData.meta.warnings.some((w) => /--include-patches/i.test(w)));

    const optInHtml = readFileSync(optInOut, 'utf8');
    assert.ok(optInHtml.includes(secretSentinel), 'Opt-in map HTML should include bounded patch lines');
    assert.ok(!optInHtml.includes('</script><script>evil()'), 'Embedded patches must escape </script>');
  });

  it('reproduces map findings via explainCommand when --ignore excludes sweep files', async () => {
    const r = createRepo();
    // Create 4 commits, each touching a.ts, b.ts, and 24 files under docs/ (26 files total > default maxFilesPerCommit=25).
    // Without --ignore 'docs/**', all 4 commits are skipped as sweeps; with --ignore 'docs/**', they are kept.
    for (let c = 1; c <= 4; c++) {
      const files: Record<string, string> = {
        'a.ts': `export const a = ${c};\n`,
        'b.ts': `export const b = ${c};\n`,
      };
      for (let d = 1; d <= 24; d++) {
        files[`docs/doc${d}.md`] = `# doc ${d} v${c}\n`;
      }
      r.commit({ message: `commit ${c} with docs`, write: files });
    }

    const ctx = await loadContext(r.dir, { ...flags, ignore: ['docs/**'] });
    const mapData = buildMapData(ctx, { edges: 50, kinds: ['ghost', 'unknown', 'indirect', 'direct'] });
    assert.equal(mapData.edges.length, 1);
    const explainCmd = mapData.edges[0]!.explainCommand!;
    assert.equal(explainCmd, "npx repo-archaeology explain --ignore 'docs/**' a.ts b.ts");

    // Running the CLI with the flags emitted in explainCommand succeeds instead of failing with "no usable history"
    const cliRun = runCli(['explain', '--ignore', 'docs/**', 'a.ts', 'b.ts'], r.dir);
    assert.equal(cliRun.code, 0, cliRun.stderr);
    assert.match(cliRun.stdout, /Shared commits \(3 most recent of 4 shared commits\)/);
  });

  it('T1: attributes raw byte truncation to the last section output by git (sorted path order) and renders truncation notices in CLI and HTML', async () => {
    const r = createRepo();

    for (let i = 1; i <= 2; i++) {
      r.commit({
        message: `pair commit ${i}`,
        write: {
          'src/a.ts': `export const a = ${i};\n`,
          'src/z.ts': [
            `export const z1 = "${'Z'.repeat(80)}_${i}";`,
            `export const z2 = "${'Z'.repeat(80)}_${i}";`,
            `export const z3 = "${'Z'.repeat(80)}_${i}";`,
            `export const z4 = "${'Z'.repeat(80)}_${i}";`,
          ].join('\n') + '\n',
        },
      });
    }

    const ctx = await loadContext(r.dir, flags);
    // Request ('src/z.ts', 'src/a.ts') where git outputs a/src/a.ts first (~130 bytes) and a/src/z.ts second (~450 bytes).
    // Setting maxPatchBytes = 280 allows src/a.ts to finish completely while cutting mid-stream inside src/z.ts's first hunk.
    const res = await explain(ctx, 'src/z.ts', 'src/a.ts', {
      commits: 1,
      maxPatchBytes: 280,
      contextLines: 99, // also verify context clamping disclosure
    });

    assert.equal(res.bounds.contextLines, 10);
    assert.equal(res.bounds.contextClamped, true);

    const sc = res.sharedCommits[0]!;
    assert.equal(sc.fileB.canonicalPath, 'src/a.ts');
    assert.equal(sc.fileB.truncated, false, 'src/a.ts was output first and completely before the byte limit');
    assert.equal(sc.fileB.rawTruncated, undefined);
    assert.equal(sc.fileA.canonicalPath, 'src/z.ts');
    assert.equal(sc.fileA.truncated, true, 'src/z.ts was output last and cut off by maxPatchBytes');
    assert.equal(sc.fileA.rawTruncated, true);
    assert.equal(sc.fileA.omittedHunks, 0);
    assert.equal(sc.fileA.omittedLines, 0);

    // Verify printExplain renders the per-file truncation notice even when omittedHunks === 0 && omittedLines === 0
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    try {
      printExplain(res);
    } finally {
      console.log = origLog;
    }
    const printed = lines.join('\n');
    assert.match(printed, /patch truncated due to byte\/time limit/);
    assert.match(printed, /context lines clamped to 10/);

    // Also test when rawTruncated=true AND omittedHunks > 0 (e.g. 6 hunks parsed before byte limit cut off the stream, with maxHunksPerFile: 4):
    // Both the "2+ additional hunks omitted" notice AND the "patch truncated due to byte/time limit" notice must appear in CLI and HTML!
    const sixHunksDiff = [
      'diff --git a/src/z.ts b/src/z.ts',
      '--- a/src/z.ts',
      '+++ b/src/z.ts',
      ...Array.from({ length: 6 }, (_, i) => `@@ -${i * 10 + 1},1 +${i * 10 + 1},1 @@\n-old${i}\n+new${i}`),
    ].join('\n');
    const multiHunkRawCut = parseSingleFileDiff(
      sixHunksDiff,
      'src/z.ts',
      { status: 'M', path: 'src/z.ts' },
      { maxHunksPerFile: 4 },
      true,
      false,
    );
    assert.equal(multiHunkRawCut.truncated, true);
    assert.equal(multiHunkRawCut.rawTruncated, true);
    assert.equal(multiHunkRawCut.omittedHunks, 2);

    const syntheticRes = {
      ...res,
      sharedCommits: [{ ...sc, fileA: multiHunkRawCut }],
    };
    const multiLines: string[] = [];
    console.log = (...args: unknown[]) => multiLines.push(args.map(String).join(' '));
    try {
      printExplain(syntheticRes);
    } finally {
      console.log = origLog;
    }
    const multiPrinted = multiLines.join('\n');
    assert.match(multiPrinted, /2\+ additional hunks omitted for this file/);
    assert.match(multiPrinted, /patch truncated due to byte\/time limit/);

    // Verify the map HTML client script renders both notices in renderFilePatchBlock when an edge is selected
    const mapData = buildMapData(ctx, { edges: 50, kinds: ['ghost', 'unknown', 'indirect', 'direct'] });
    mapData.patchesIncluded = true;
    mapData.edges[0]!.evidence[0]!.patches = {
      source: multiHunkRawCut,
      target: sc.fileB,
    };
    const html = renderMapHtml(mapData);
    const dataMatch = html.match(/<script type="application\/json" id="ra-data">([\s\S]*?)<\/script>/);
    const scriptMatch = html.match(/<script>\s*(\(function \(\) \{[\s\S]*?\}\)\(\);)\s*<\/script>/);
    assert.ok(dataMatch && scriptMatch, 'Expected embedded JSON and client script in map HTML');

    class FakeElement {
      tag: string;
      className = '';
      _text = '';
      children: FakeElement[] = [];
      listeners: Record<string, Array<(ev?: unknown) => void>> = {};
      style: Record<string, string> = {};
      dataset: Record<string, string> = {};
      attributes: Record<string, string> = {};
      type = '';
      title = '';
      value = '';
      open = false;
      constructor(tag: string) {
        this.tag = tag;
      }
      get textContent(): string {
        if (this.children.length === 0) return this._text;
        return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join('\n');
      }
      set textContent(v: string) {
        this._text = String(v);
        this.children = [];
      }
      appendChild(child: FakeElement): FakeElement {
        this.children.push(child);
        return child;
      }
      addEventListener(type: string, fn: (ev?: unknown) => void): void {
        (this.listeners[type] ??= []).push(fn);
      }
      setAttribute(k: string, v: string): void {
        this.attributes[k] = v;
      }
      getBoundingClientRect() {
        return { left: 0, top: 0, width: 800, height: 600 };
      }
      getContext() {
        return new Proxy({}, { get: () => () => ({ width: 10 }) });
      }
      findAll(pred: (el: FakeElement) => boolean): FakeElement[] {
        const out: FakeElement[] = [];
        if (pred(this)) out.push(this);
        for (const c of this.children) out.push(...c.findAll(pred));
        return out;
      }
    }

    const elementsById: Record<string, FakeElement> = {
      'ra-data': new FakeElement('script'),
      map: new FakeElement('canvas'),
      tooltip: new FakeElement('div'),
      panel: new FakeElement('div'),
      search: new FakeElement('input'),
      'reset-view': new FakeElement('button'),
      'toggle-anim': new FakeElement('button'),
      summary: new FakeElement('div'),
      toggles: new FakeElement('div'),
    };
    elementsById['ra-data']!.textContent = dataMatch[1]!;

    const sandboxWindow: Record<string, unknown> = {
      devicePixelRatio: 1,
      matchMedia: () => ({ matches: true }),
      addEventListener: () => {},
    };
    const sandboxDocument = {
      hidden: false,
      body: new FakeElement('body'),
      getElementById: (id: string) => elementsById[id] ?? new FakeElement('div'),
      createElement: (tag: string) => new FakeElement(tag),
      addEventListener: () => {},
    };
    vm.runInNewContext(scriptMatch[1]!, {
      window: sandboxWindow,
      document: sandboxDocument,
      navigator: {},
      performance: { now: () => 0 },
      requestAnimationFrame: () => 0,
      setTimeout,
      clearTimeout,
    });

    // Click the first relationship card in the overview panel to trigger selectEdge -> renderSelectedEdge -> renderFilePatchBlock
    const cards = elementsById.panel!.findAll((el) => el.className.includes('card interactive'));
    assert.ok(cards.length > 0, 'Expected relationship card in overview panel');
    cards[0]!.listeners.click?.[0]?.();

    const panelText = elementsById.panel!.textContent;
    assert.match(panelText, /2\+ additional hunks omitted/);
    assert.match(panelText, /patch truncated due to byte\/time limit/);
  });

  it('T2: handles C0/bidi characters in paths, color.diff=always, and custom diff prefixes in a single git show call', async () => {
    const r = createRepo();
    const escFile = 'src/w\x1bx.ts';
    const normalFile = 'src/normal.ts';
    const normalFile2 = 'src/normal2.ts';

    for (let i = 1; i <= 2; i++) {
      r.commit({
        message: `custom prefix commit ${i}`,
        write: {
          [normalFile]: `export const normVal = ${i};\n`,
          [normalFile2]: `export const normVal2 = ${i};\n`,
          ...(process.platform !== 'win32' ? { [escFile]: `export const escVal = ${i};\n` } : {}),
        },
      });
    }
    // Configure settings that would break unguarded diff parsing across all Git versions:
    // - color.diff=always and color.ui=always (injects ANSI escape sequences unless --no-color / color.diff=false is passed)
    // - diff.mnemonicPrefix=true and diff.noprefix=true (supported on all Git versions; changes a/ and b/ prefixes)
    // - diff.srcPrefix and diff.dstPrefix (Git 2.45+ custom prefixes)
    r.git('config', 'color.diff', 'always');
    r.git('config', 'color.ui', 'always');
    r.git('config', 'diff.mnemonicPrefix', 'true');
    r.git('config', 'diff.noprefix', 'true');
    r.git('config', 'diff.srcPrefix', 'custom-src/');
    r.git('config', 'diff.dstPrefix', 'custom-dst/');

    const headSha = r.git('rev-parse', 'HEAD').trim();

    if (process.platform !== 'win32') {
      const singleEsc = await fetchSingleFilePatch(r.dir, headSha, escFile, { status: 'M', path: escFile });
      const pairRes = await fetchPairCommitPatches(
        r.dir,
        headSha,
        escFile,
        { status: 'M', path: escFile },
        normalFile,
        { status: 'M', path: normalFile },
      );

      assert.equal(singleEsc.emptyDiff, false);
      assert.ok(singleEsc.hunks.length > 0);
      assert.deepEqual(pairRes.patchA.hunks, singleEsc.hunks);
      assert.ok(pairRes.patchB.hunks.length > 0);

      // Verify combined git show for normalFile + normalFile2 succeeds in a SINGLE git show process
      // (without falling back to per-file fetches) even when mnemonicPrefix/noprefix/srcPrefix/color.diff=always are set.
      const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
      const countBinDir = join(r.dir, '.git-count-bin');
      const countLogFile = join(r.dir, 'git-prefix-calls.log');
      mkdirSync(countBinDir, { recursive: true });
      writeFileSync(countLogFile, '', 'utf8');
      const wrapper = join(countBinDir, 'git');
      writeFileSync(
        wrapper,
        `#!/bin/sh\necho "$@" >> "${countLogFile}"\nexec "${realGit}" "$@"\n`,
        'utf8',
      );
      chmodSync(wrapper, 0o755);
      const origPath = process.env.PATH;
      process.env.PATH = `${countBinDir}${delimiter}${origPath ?? ''}`;
      try {
        const normalPair = await fetchPairCommitPatches(
          r.dir,
          headSha,
          normalFile,
          { status: 'M', path: normalFile },
          normalFile2,
          { status: 'M', path: normalFile2 },
        );
        assert.ok(normalPair.patchA.hunks.length > 0);
        assert.ok(normalPair.patchB.hunks.length > 0);
      } finally {
        process.env.PATH = origPath;
      }
      const showCalls = readFileSync(countLogFile, 'utf8')
        .split('\n')
        .filter((line) => line.includes(' show '));
      assert.equal(
        showCalls.length,
        1,
        `Expected combined git show to match both files in 1 call without fallback, got ${showCalls.length} calls`,
      );
    } else {
      const normalPair = await fetchPairCommitPatches(
        r.dir,
        headSha,
        normalFile,
        { status: 'M', path: normalFile },
        normalFile2,
        { status: 'M', path: normalFile2 },
      );
      assert.ok(normalPair.patchA.hunks.length > 0);
      assert.ok(normalPair.patchB.hunks.length > 0);
    }

    // formatExplainCommand uses ANSI-C $'...' quoting for paths with C0 control characters or any Bidi_Control (including U+061C)
    const cmd = formatExplainCommand(escFile, 'src/a\u061Cb.ts');
    assert.ok(cmd.includes("$'src/w\\x1bx.ts'"), `Expected ANSI-C escaped ESC in: ${cmd}`);
    assert.ok(cmd.includes("$'src/a\\u061cb.ts'"), `Expected ANSI-C escaped U+061C in: ${cmd}`);
  });

  it('enforces runGitBounded byte/timeout bounds and prevents 3x fallback timeout overruns', async () => {
    const r = createRepo();
    r.commit({
      message: 'init',
      write: {
        'src/one.ts': 'export const one = 1;\n',
        'src/two.ts': 'export const two = 2;\n',
      },
    });
    const headSha = r.git('rev-parse', 'HEAD').trim();

    // 1. Direct runGitBounded byte limit test
    const byteRes = await runGitBounded(r.dir, ['show', '--format=', '--patch', headSha], {
      maxBytes: 25,
      timeoutMs: 2000,
    });
    assert.equal(byteRes.truncated, true);
    assert.equal(byteRes.timedOut, false);
    assert.ok(Buffer.byteLength(byteRes.stdout, 'utf8') <= 25);

    // 2. Slow git wrapper on PATH to test timeout and shared deadlineMs across fallback calls (POSIX)
    if (process.platform !== 'win32') {
      const binDir = join(r.dir, '.fake-bin');
      const invocationsFile = join(r.dir, 'slow-git-invocations.log');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(invocationsFile, '', 'utf8');
      const wrapperPath = join(binDir, 'git');
      writeFileSync(
        wrapperPath,
        `#!/bin/sh\necho "call" >> "${invocationsFile}"\nsleep 2\n`,
        'utf8',
      );
      chmodSync(wrapperPath, 0o755);

      const origPath = process.env.PATH;
      process.env.PATH = `${binDir}${delimiter}${origPath ?? ''}`;
      try {
        const t0 = Date.now();
        const pairTimedOut = await fetchPairCommitPatches(
          r.dir,
          headSha,
          'src/w\x1bx.ts', // forces per-file fetchSingleFilePatch path
          { status: 'M', path: 'src/w\x1bx.ts' },
          'src/two.ts',
          { status: 'M', path: 'src/two.ts' },
          { timeoutMs: 120 },
        );
        const elapsed = Date.now() - t0;
        assert.equal(pairTimedOut.timedOut, true);
        assert.equal(pairTimedOut.patchA.timedOut, true);
        assert.equal(pairTimedOut.patchA.truncated, true);
        assert.equal(pairTimedOut.patchB.timedOut, true);
        assert.equal(pairTimedOut.patchB.truncated, true);

        // Because patchA exhausted the 120ms shared deadline, patchB must skip spawning git altogether (only 1 invocation)
        // and total elapsed time must be < 2 * timeoutMs (240ms).
        const invocations = readFileSync(invocationsFile, 'utf8').trim().split('\n').filter(Boolean);
        assert.equal(
          invocations.length,
          1,
          `Expected shared deadline to skip the second git call after the first timed out, got ${invocations.length} calls`,
        );
        assert.ok(elapsed < 230, `Expected shared deadline to finish under 2x timeoutMs (230ms), took ${elapsed}ms`);
      } finally {
        process.env.PATH = origPath;
      }
    }
  });
});
