import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { PINNED_ACTION_PACKAGE, resolveNpxCliJs, runGitHubAction } from '../src/action/runner.js';
import { FixtureRepo } from './helpers.js';

const ROOT_DIR = join(import.meta.dirname, '..');

function parseGitHubOutputFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const heredocMatch = /^([^=<]+)<<(.+)$/.exec(line);
    if (heredocMatch) {
      const key = heredocMatch[1]!;
      const delim = heredocMatch[2]!;
      i++;
      const valueLines: string[] = [];
      while (i < lines.length && lines[i] !== delim) {
        valueLines.push(lines[i]!);
        i++;
      }
      result[key] = valueLines.join('\n');
      i++;
    } else {
      const eqIdx = line.indexOf('=');
      if (eqIdx !== -1) {
        result[line.slice(0, eqIdx)] = line.slice(eqIdx + 1);
      }
      i++;
    }
  }
  return result;
}

function createActionHarness(workspaceDir: string) {
  const tempDir = mkdtempSync(join(tmpdir(), 'repo-arch-action-harness-'));
  const summaryFile = join(tempDir, 'step_summary.md');
  const outputFile = join(tempDir, 'github_output.txt');
  const runnerTemp = join(tempDir, 'runner_temp');
  mkdirSync(runnerTemp, { recursive: true });
  writeFileSync(summaryFile, '', 'utf8');
  writeFileSync(outputFile, '', 'utf8');

  const run = (inputs: Record<string, string | undefined>) => {
    writeFileSync(summaryFile, '', 'utf8');
    writeFileSync(outputFile, '', 'utf8');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NO_COLOR: '1',
      GITHUB_WORKSPACE: workspaceDir,
      GITHUB_ACTION_PATH: ROOT_DIR,
      GITHUB_STEP_SUMMARY: summaryFile,
      GITHUB_OUTPUT: outputFile,
      RUNNER_TEMP: runnerTemp,
      ...inputs,
    };
    const res = runGitHubAction(env);
    const summary = readFileSync(summaryFile, 'utf8');
    const outputs = parseGitHubOutputFile(readFileSync(outputFile, 'utf8'));
    return { res, summary, outputs };
  };

  const cleanup = () => {
    rmSync(tempDir, { recursive: true, force: true });
  };

  return { run, cleanup, summaryFile, outputFile, runnerTemp };
}

describe('Composite GitHub Action (action.yml & src/action/runner.ts)', () => {
  it('verifies action.yml metadata, pinned version, and zero direct input interpolations in run scripts', () => {
    const actionYml = readFileSync(join(ROOT_DIR, 'action.yml'), 'utf8');
    const pkg = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')) as { version: string };
    assert.equal(PINNED_ACTION_PACKAGE, `repo-archaeology@${pkg.version}`);
    assert.match(actionYml, /using:\s*'composite'/);
    assert.match(actionYml, /suggestion-count:/);
    assert.match(actionYml, /json-path:/);
    assert.match(actionYml, /analysis-status:/);

    const runBlockIndex = actionYml.indexOf('run: |');
    assert.ok(runBlockIndex !== -1, 'expected run: | block in action.yml');
    const runBlock = actionYml.slice(runBlockIndex);
    assert.doesNotMatch(
      runBlock,
      /\$\{\{\s*inputs\./,
      'action.yml run block must never interpolate ${{ inputs.* }} directly into shell commands',
    );
    assert.doesNotMatch(
      runBlock,
      /\bnpx\b|\btsx\b/,
      'action.yml run block must never invoke npx or tsx from the workspace before runner isolation',
    );
  });

  it('covers PR scenarios 1-4, 8, and 10: suggestions, all-companions-touched, new files, 0 changes, branch renames, and fail-on-suggestions', () => {
    const repo = new FixtureRepo();
    const harness = createActionHarness(repo.dir);
    try {
      repo.write('src/adapter/bun/serve-static.ts', 'export const bun = 0;\n');
      repo.write('src/adapter/deno/serve-static.ts', 'export const deno = 0;\n');
      repo.git('add', '.');
      repo.commit({ message: 'initial' });

      for (let i = 1; i <= 5; i++) {
        repo.commit({
          message: `sync adapters ${i}`,
          write: {
            'src/adapter/bun/serve-static.ts': `export const bun = ${i};\n`,
            'src/adapter/deno/serve-static.ts': `export const deno = ${i};\n`,
          },
        });
      }

      const baseSha = repo.git('rev-parse', 'HEAD').trim();

      // Scenario 4: 0 changed files (HEAD === base)
      const zeroDiff = harness.run({
        INPUT_BASE: baseSha,
        INPUT_HEAD: baseSha,
      });
      assert.equal(zeroDiff.res.exitCode, 0);
      assert.equal(zeroDiff.outputs['analysis-status'], 'analyzed');
      assert.equal(zeroDiff.outputs['suggestion-count'], '0');
      assert.match(zeroDiff.summary, /No changed files were detected in the evaluated range/);

      // Scenario 1: PR with qualifying companion suggestions
      repo.git('checkout', '-q', '-b', 'pr-partial');
      repo.commit({
        message: 'feat(bun): update serve-static',
        write: { 'src/adapter/bun/serve-static.ts': 'export const bun = 99;\n' },
      });
      const prPartialHead = repo.git('rev-parse', 'HEAD').trim();

      const withSuggestions = harness.run({
        INPUT_BASE: baseSha,
        INPUT_HEAD: prPartialHead,
        INPUT_LIMIT: '5',
      });
      assert.equal(withSuggestions.res.exitCode, 0, withSuggestions.res.stderr);
      assert.equal(withSuggestions.outputs['analysis-status'], 'analyzed');
      assert.equal(withSuggestions.outputs['suggestion-count'], '1');
      assert.ok(withSuggestions.outputs['json-path'] && existsSync(withSuggestions.outputs['json-path']));
      assert.match(withSuggestions.summary, /### Possibly missed \(1\)/);
      assert.match(withSuggestions.summary, /`src\/adapter\/deno\/serve-static\.ts`/);

      const jsonReport = JSON.parse(readFileSync(withSuggestions.outputs['json-path']!, 'utf8'));
      assert.equal(jsonReport.schemaVersion, 1);
      assert.equal(jsonReport.evaluation.mergeBaseSha, baseSha);
      assert.equal(jsonReport.evaluation.headSha, prPartialHead);

      // Scenario 10: fail-on-suggestions = 'true' writes summary & outputs first, then exits 1
      const failRun = harness.run({
        INPUT_BASE: baseSha,
        INPUT_HEAD: prPartialHead,
        INPUT_FAIL_ON_SUGGESTIONS: 'true',
      });
      assert.equal(failRun.res.exitCode, 1);
      assert.equal(failRun.outputs['suggestion-count'], '1');
      assert.equal(failRun.outputs['analysis-status'], 'analyzed');
      assert.match(failRun.summary, /### Possibly missed \(1\)/);
      assert.match(failRun.res.stderr, /fail-on-suggestions is enabled/);

      // Scenario 2: PR where all historical companions are already touched
      repo.commit({
        message: 'feat(deno): update companion adapter too',
        write: { 'src/adapter/deno/serve-static.ts': 'export const deno = 99;\n' },
      });
      const prCompleteHead = repo.git('rev-parse', 'HEAD').trim();
      const allTouched = harness.run({
        INPUT_BASE: baseSha,
        INPUT_HEAD: prCompleteHead,
        INPUT_FAIL_ON_SUGGESTIONS: 'true',
      });
      assert.equal(allTouched.res.exitCode, 0);
      assert.equal(allTouched.outputs['suggestion-count'], '0');
      assert.equal(allTouched.outputs['analysis-status'], 'analyzed');
      assert.match(allTouched.summary, /already included in this changeset/);

      // Scenario 3: PR touching only newly added files with no prior history
      repo.git('checkout', '-q', baseSha);
      repo.git('checkout', '-q', '-b', 'pr-new-files');
      repo.commit({
        message: 'feat: add brand new module',
        write: { 'src/brand-new.ts': 'export const brandNew = true;\n' },
      });
      const prNewHead = repo.git('rev-parse', 'HEAD').trim();
      const newFilesOnly = harness.run({
        INPUT_BASE: baseSha,
        INPUT_HEAD: prNewHead,
      });
      assert.equal(newFilesOnly.res.exitCode, 0);
      assert.equal(newFilesOnly.outputs['suggestion-count'], '0');
      assert.equal(newFilesOnly.outputs['analysis-status'], 'analyzed');
      assert.match(newFilesOnly.summary, /none of the changed files appear in the pre-change baseline history/);

      // Scenario 8: Branch rename across base -> head preserves baseline history and suggests companion
      repo.git('checkout', '-q', baseSha);
      repo.git('checkout', '-q', '-b', 'pr-rename');
      repo.commit({
        message: 'refactor: rename bun serve-static',
        move: [['src/adapter/bun/serve-static.ts', 'src/adapter/bun/static-handler.ts']],
        write: { 'src/adapter/bun/static-handler.ts': 'export const bun = 123;\n' },
      });
      const prRenameHead = repo.git('rev-parse', 'HEAD').trim();
      const renamedRun = harness.run({
        INPUT_BASE: baseSha,
        INPUT_HEAD: prRenameHead,
      });
      assert.equal(renamedRun.res.exitCode, 0, renamedRun.res.stderr);
      assert.equal(renamedRun.outputs['suggestion-count'], '1');
      assert.match(renamedRun.summary, /`src\/adapter\/deno\/serve-static\.ts`/);
    } finally {
      harness.cleanup();
      repo.cleanup();
    }
  });

  it('covers Scenario 5: detects shallow clones and <2-commit repositories and exits 0 with analysis-status=insufficient-history', () => {
    const originRepo = new FixtureRepo();
    const singleCommitRepo = new FixtureRepo();
    const shallowRoot = mkdtempSync(join(tmpdir(), 'repo-arch-shallow-'));
    const shallowCloneDir = join(shallowRoot, 'clone');
    try {
      for (let i = 0; i < 5; i++) {
        originRepo.touch(['src/a.ts', 'src/b.ts'], `commit ${i}`);
      }
      const headSha = originRepo.git('rev-parse', 'HEAD').trim();
      execFileSync('git', ['clone', '-q', '--depth', '1', `file://${originRepo.dir}`, shallowCloneDir]);

      const harness = createActionHarness(shallowCloneDir);
      try {
        const res = harness.run({
          INPUT_BASE: headSha,
          INPUT_HEAD: headSha,
          INPUT_FAIL_ON_SUGGESTIONS: 'true',
        });
        assert.equal(res.res.exitCode, 0);
        assert.equal(res.outputs['analysis-status'], 'insufficient-history');
        assert.equal(res.outputs['suggestion-count'], '0');
        assert.equal(res.outputs['json-path'], '');
        assert.match(res.summary, /Skipped \(shallow Git clone detected\)/);
        assert.match(res.summary, /fetch-depth: 0/);
      } finally {
        harness.cleanup();
      }

      // Non-shallow repository with only 1 commit -> also insufficient-history (exit 0)
      singleCommitRepo.touch(['src/only.ts'], 'initial single commit');
      const oneSha = singleCommitRepo.git('rev-parse', 'HEAD').trim();
      const singleHarness = createActionHarness(singleCommitRepo.dir);
      try {
        const oneRes = singleHarness.run({
          INPUT_BASE: oneSha,
          INPUT_HEAD: oneSha,
          INPUT_FAIL_ON_SUGGESTIONS: 'true',
        });
        assert.equal(oneRes.res.exitCode, 0);
        assert.equal(oneRes.outputs['analysis-status'], 'insufficient-history');
        assert.equal(oneRes.outputs['suggestion-count'], '0');
        assert.equal(oneRes.outputs['json-path'], '');
        assert.match(oneRes.summary, /Skipped \(insufficient commit history\)/);
      } finally {
        singleHarness.cleanup();
      }
    } finally {
      rmSync(shallowRoot, { recursive: true, force: true });
      singleCommitRepo.cleanup();
      originRepo.cleanup();
    }
  });

  it('covers Scenarios 6 & 7: detects synthetic merge commit mismatch (refs/pull/:id/merge) and missing base refs', () => {
    const repo = new FixtureRepo();
    const harness = createActionHarness(repo.dir);
    try {
      for (let i = 0; i < 4; i++) {
        repo.touch(['src/a.ts', 'src/b.ts'], `base ${i}`);
      }
      const forkSha = repo.git('rev-parse', 'HEAD').trim();

      // Create PR branch commit
      repo.git('checkout', '-q', '-b', 'pr-branch');
      repo.touch(['src/a.ts'], 'pr change');
      const prHeadSha = repo.git('rev-parse', 'HEAD').trim();

      // Advance main and create a synthetic merge commit like GitHub's refs/pull/:id/merge
      repo.git('checkout', '-q', 'main');
      repo.touch(['src/unconnected.ts'], 'main advance');
      const baseTipSha = repo.git('rev-parse', 'HEAD').trim();
      repo.git('checkout', '-q', '--detach', baseTipSha);
      repo.git('merge', '-q', '--no-ff', '-m', 'Merge pr-branch into main', prHeadSha);
      const syntheticMergeSha = repo.git('rev-parse', 'HEAD').trim();
      assert.notEqual(syntheticMergeSha, prHeadSha);

      // Scenario 7: HEAD is synthetic merge commit while INPUT_HEAD is prHeadSha -> must fail with actionable guidance and summary
      const mismatch = harness.run({
        INPUT_BASE: forkSha,
        INPUT_HEAD: prHeadSha,
      });
      assert.equal(mismatch.res.exitCode, 2);
      assert.equal(mismatch.outputs['analysis-status'], 'skipped');
      assert.match(mismatch.res.stderr, /Checked-out HEAD .* does not match expected head/);
      assert.match(mismatch.res.stderr, /synthetic pull_request merge commit/);
      assert.match(mismatch.res.stderr, /github\.event\.pull_request\.head\.sha/);
      assert.match(mismatch.summary, /Checked-out HEAD .* does not match expected head/);

      // Scenario 6: Missing base input or non-existent base SHA
      repo.git('checkout', '-q', prHeadSha);
      const missingBase = harness.run({
        INPUT_BASE: '',
        INPUT_HEAD: prHeadSha,
      });
      assert.equal(missingBase.res.exitCode, 2);
      assert.match(missingBase.res.stderr, /Missing required 'base' input/);

      const unknownBaseSha = harness.run({
        INPUT_BASE: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        INPUT_HEAD: prHeadSha,
      });
      assert.equal(unknownBaseSha.res.exitCode, 2);
      assert.match(unknownBaseSha.res.stderr, /Base commit or ref .* is not present/);
    } finally {
      harness.cleanup();
      repo.cleanup();
    }
  });

  it('covers Scenarios 9, 11 & 12: supports monorepo working-directory, rejects path/symlink escapes and hostile inputs, isolates external package resolution, and runs via action.yml shell step', () => {
    const repo = new FixtureRepo();
    const harness = createActionHarness(repo.dir);
    const outsideDir = mkdtempSync(join(tmpdir(), 'repo-arch-outside-'));
    try {
      for (let i = 0; i < 4; i++) {
        repo.touch(['packages/web/src/a.ts', 'packages/web/src/b.ts'], `monorepo ${i}`);
      }
      const baseSha = repo.git('rev-parse', 'HEAD').trim();
      repo.git('checkout', '-q', '-b', 'monorepo-pr');
      repo.touch(['packages/web/src/a.ts'], 'edit a');
      const headSha = repo.git('rev-parse', 'HEAD').trim();

      // Scenario 9a: Valid monorepo subdirectory
      const subDirRun = harness.run({
        INPUT_BASE: baseSha,
        INPUT_HEAD: headSha,
        INPUT_WORKING_DIRECTORY: 'packages/web',
      });
      assert.equal(subDirRun.res.exitCode, 0, subDirRun.res.stderr);
      assert.equal(subDirRun.outputs['suggestion-count'], '1');
      assert.equal(subDirRun.outputs['analysis-status'], 'analyzed');

      // Scenario 9b: Path traversal outside GITHUB_WORKSPACE
      const traversalRun = harness.run({
        INPUT_BASE: baseSha,
        INPUT_HEAD: headSha,
        INPUT_WORKING_DIRECTORY: '../../etc',
      });
      assert.equal(traversalRun.res.exitCode, 2);
      assert.match(traversalRun.res.stderr, /does not exist|escapes GITHUB_WORKSPACE/);

      // Scenario 9c: Symlink inside workspace pointing outside
      const symlinkPath = join(repo.dir, 'evil-link');
      symlinkSync(outsideDir, symlinkPath, 'dir');
      const symlinkRun = harness.run({
        INPUT_BASE: baseSha,
        INPUT_HEAD: headSha,
        INPUT_WORKING_DIRECTORY: 'evil-link',
      });
      assert.equal(symlinkRun.res.exitCode, 2);
      assert.match(symlinkRun.res.stderr, /must not be a symbolic link/);

      // Scenario 11: Hostile inputs (option injection, invalid numbers, control chars)
      assert.equal(
        harness.run({ INPUT_BASE: '--upload-pack=evil', INPUT_HEAD: headSha }).res.exitCode,
        2,
      );
      assert.equal(
        harness.run({ INPUT_BASE: baseSha, INPUT_HEAD: '--output=/tmp/pwn' }).res.exitCode,
        2,
      );
      assert.equal(
        harness.run({ INPUT_BASE: baseSha, INPUT_HEAD: headSha, INPUT_LIMIT: '0' }).res.exitCode,
        2,
      );
      assert.equal(
        harness.run({ INPUT_BASE: baseSha, INPUT_HEAD: headSha, INPUT_MIN_CONFIDENCE: '150%' }).res.exitCode,
        2,
      );
      assert.equal(
        harness.run({ INPUT_BASE: baseSha, INPUT_HEAD: headSha, INPUT_KINDS: 'ghost,malicious' }).res.exitCode,
        2,
      );
      assert.equal(
        harness.run({ INPUT_BASE: `${baseSha}\nmalicious`, INPUT_HEAD: headSha }).res.exitCode,
        2,
      );

      // External-consumer fallback & workspace-binary isolation test (Windows, macOS, Linux):
      // 1. Verify resolveNpxCliJs locates a real JS entrypoint on this OS.
      const detectedNpxCli = resolveNpxCliJs();
      assert.ok(detectedNpxCli && existsSync(detectedNpxCli), `expected resolveNpxCliJs() to find npx-cli.js, got: ${detectedNpxCli}`);

      // 2. Plant a malicious workspace binary & package.json inside GITHUB_WORKSPACE (repo.dir)
      const poisonMarker = join(outsideDir, 'workspace-binary-executed.txt');
      const fakeBinDir = join(repo.dir, 'node_modules', '.bin');
      mkdirSync(fakeBinDir, { recursive: true });
      writeFileSync(
        join(repo.dir, 'package.json'),
        JSON.stringify({ name: 'repo-archaeology', version: '0.3.0', bin: './evil.js' }),
        'utf8',
      );
      writeFileSync(
        join(fakeBinDir, 'repo-archaeology'),
        `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(poisonMarker)}, 'pwned');\nprocess.exit(0);\n`,
        { encoding: 'utf8', mode: 0o755 },
      );

      // 3. Point GITHUB_ACTION_PATH to an empty external action directory (no dist/, no node_modules/)
      const externalActionDir = join(outsideDir, 'external-action-checkout');
      mkdirSync(externalActionDir, { recursive: true });
      const launcherMetaFile = join(outsideDir, 'npx-launcher-meta.json');
      const mockNpxCliJs = join(outsideDir, 'mock-npx-cli.mjs');
      const tsxLoaderUrl = pathToFileURL(join(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
      const realSrcCli = join(ROOT_DIR, 'src', 'cli.ts');
      const realNpxCliJs = resolveNpxCliJs({});
      const realNpmCliJs = realNpxCliJs ? join(dirname(realNpxCliJs), 'npm-cli.js') : '';

      writeFileSync(
        mockNpxCliJs,
        [
          "import { spawnSync } from 'node:child_process';",
          "import { existsSync, writeFileSync } from 'node:fs';",
          `const npmCliJs = ${JSON.stringify(realNpmCliJs)};`,
          'let npmConfigStatus = 0;',
          'let npmConfigStdout = "";',
          'let npmConfigStderr = "";',
          'if (npmCliJs && existsSync(npmCliJs)) {',
          "  const cfg = spawnSync(process.execPath, [npmCliJs, 'config', 'get', 'registry'], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });",
          '  npmConfigStatus = cfg.status ?? 1;',
          '  npmConfigStdout = (cfg.stdout ?? "").trim();',
          '  npmConfigStderr = (cfg.stderr ?? "").trim();',
          '}',
          `writeFileSync(${JSON.stringify(launcherMetaFile)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), userconfig: process.env.NPM_CONFIG_USERCONFIG ?? null, globalconfig: process.env.NPM_CONFIG_GLOBALCONFIG ?? null, npmConfigStatus, npmConfigStdout, npmConfigStderr }));`,
          'const pkgIdx = process.argv.findIndex((a) => a.startsWith("repo-archaeology@"));',
          'const cliArgs = pkgIdx !== -1 ? process.argv.slice(pkgIdx + 1) : [];',
          `const r = spawnSync(process.execPath, ['--import', ${JSON.stringify(tsxLoaderUrl)}, ${JSON.stringify(realSrcCli)}, ...cliArgs], { encoding: 'utf8', env: process.env });`,
          'if (r.stdout) process.stdout.write(r.stdout);',
          'if (r.stderr) process.stderr.write(r.stderr);',
          'process.exit(r.status ?? 1);',
        ].join('\n'),
        'utf8',
      );

      // (a) External relative NPM_CONFIG_USERCONFIG under RUNNER_TEMP (outside workspace) is resolved to its absolute path and preserved
      const externalNpmrc = join(realpathSync.native(harness.runnerTemp), 'setup-node.npmrc');
      writeFileSync(externalNpmrc, 'registry=https://mirror.example.test/\n', 'utf8');
      const relativeExternalNpmrc = relative(realpathSync.native(repo.dir), externalNpmrc);
      const externalRun = harness.run({
        GITHUB_ACTION_PATH: externalActionDir,
        REPO_ARCHAEOLOGY_NPX_CLI_JS: mockNpxCliJs,
        NPM_CONFIG_USERCONFIG: relativeExternalNpmrc,
        NODE_OPTIONS: '--require ./nonexistent-workspace-hook.js',
        INPUT_BASE: baseSha,
        INPUT_HEAD: headSha,
        INPUT_WORKING_DIRECTORY: 'packages/web',
        INPUT_FAIL_ON_SUGGESTIONS: 'true',
      });
      assert.equal(externalRun.res.exitCode, 1, externalRun.res.stderr);
      assert.equal(externalRun.outputs['suggestion-count'], '1');
      assert.equal(externalRun.outputs['uncommitted-files-count'], '3');
      assert.equal(externalRun.outputs['analysis-status'], 'analyzed');
      assert.equal(existsSync(poisonMarker), false, 'workspace binary must never be executed');

      const launcherMeta = JSON.parse(readFileSync(launcherMetaFile, 'utf8')) as {
        cwd: string;
        argv: string[];
        userconfig: string | null;
        globalconfig: string | null;
        npmConfigStatus: number;
        npmConfigStdout: string;
        npmConfigStderr: string;
      };
      const relToWorkspace = relative(repo.dir, launcherMeta.cwd);
      assert.ok(
        relToWorkspace.startsWith('..') || dirname(relToWorkspace) !== '.',
        `external npx launcher must execute outside GITHUB_WORKSPACE, got cwd=${launcherMeta.cwd}`,
      );
      assert.ok(launcherMeta.argv.includes(PINNED_ACTION_PACKAGE));
      assert.equal(
        launcherMeta.userconfig,
        externalNpmrc,
        'relative external NPM_CONFIG_USERCONFIG must be forwarded as a resolved absolute path',
      );
      if (realNpmCliJs && existsSync(realNpmCliJs)) {
        assert.equal(launcherMeta.npmConfigStatus, 0, launcherMeta.npmConfigStderr);
        assert.equal(
          launcherMeta.npmConfigStdout,
          'https://mirror.example.test/',
          'real npm config loader must read external mirror setting after changing cwd to isolatedExecDir',
        );
      }

      // (b) Workspace .npmrc symlink targeting '..npmrc' inside GITHUB_WORKSPACE + workspace globalconfig:
      //     - '..npmrc' inside workspace must be recognized as inside GITHUB_WORKSPACE and replaced
      //     - userconfig and globalconfig must use distinct empty files so real npm never fails with 'double-loading config'
      const workspaceDoubleDotNpmrc = join(repo.dir, '..npmrc');
      const workspaceNpmrc = join(repo.dir, '.npmrc');
      writeFileSync(workspaceDoubleDotNpmrc, 'registry=https://evil.example/\n', 'utf8');
      symlinkSync('..npmrc', workspaceNpmrc);
      harness.run({
        GITHUB_ACTION_PATH: externalActionDir,
        REPO_ARCHAEOLOGY_NPX_CLI_JS: mockNpxCliJs,
        NPM_CONFIG_USERCONFIG: workspaceNpmrc,
        NPM_CONFIG_GLOBALCONFIG: join(repo.dir, 'global.npmrc'),
        INPUT_BASE: baseSha,
        INPUT_HEAD: headSha,
        INPUT_WORKING_DIRECTORY: 'packages/web',
      });
      const wsMeta = JSON.parse(readFileSync(launcherMetaFile, 'utf8')) as {
        userconfig: string | null;
        globalconfig: string | null;
        npmConfigStatus: number;
        npmConfigStdout: string;
        npmConfigStderr: string;
      };
      assert.ok(wsMeta.userconfig && wsMeta.userconfig !== workspaceNpmrc, 'workspace userconfig symlink to ..npmrc must be replaced');
      assert.ok(
        relative(repo.dir, wsMeta.userconfig!).startsWith('..'),
        `replaced userconfig must be outside workspace, got ${wsMeta.userconfig}`,
      );
      assert.ok(
        wsMeta.globalconfig && relative(repo.dir, wsMeta.globalconfig).startsWith('..'),
        'workspace globalconfig must also be replaced',
      );
      assert.notEqual(
        wsMeta.userconfig,
        wsMeta.globalconfig,
        'replaced userconfig and globalconfig must use distinct files',
      );
      if (realNpmCliJs && existsSync(realNpmCliJs)) {
        assert.equal(wsMeta.npmConfigStatus, 0, `real npm config failed: ${wsMeta.npmConfigStderr}`);
        assert.doesNotMatch(wsMeta.npmConfigStderr, /double-loading config/i);
        assert.notEqual(wsMeta.npmConfigStdout, 'https://evil.example/');
      }
      rmSync(workspaceNpmrc, { force: true });
      rmSync(workspaceDoubleDotNpmrc, { force: true });

      // (b2) Only NPM_CONFIG_GLOBALCONFIG inside workspace (with NPM_CONFIG_USERCONFIG unset) must not collide with project .npmrc
      harness.run({
        GITHUB_ACTION_PATH: externalActionDir,
        REPO_ARCHAEOLOGY_NPX_CLI_JS: mockNpxCliJs,
        NPM_CONFIG_USERCONFIG: undefined,
        npm_config_userconfig: undefined,
        NPM_CONFIG_GLOBALCONFIG: join(repo.dir, 'global.npmrc'),
        INPUT_BASE: baseSha,
        INPUT_HEAD: headSha,
        INPUT_WORKING_DIRECTORY: 'packages/web',
      });
      const globalOnlyMeta = JSON.parse(readFileSync(launcherMetaFile, 'utf8')) as {
        userconfig: string | null;
        globalconfig: string | null;
        npmConfigStatus: number;
        npmConfigStderr: string;
      };
      assert.equal(globalOnlyMeta.userconfig, null);
      assert.ok(globalOnlyMeta.globalconfig && relative(repo.dir, globalOnlyMeta.globalconfig).startsWith('..'));
      if (realNpmCliJs && existsSync(realNpmCliJs)) {
        assert.equal(globalOnlyMeta.npmConfigStatus, 0, `real npm config failed: ${globalOnlyMeta.npmConfigStderr}`);
        assert.doesNotMatch(globalOnlyMeta.npmConfigStderr, /double-loading config/i);
      }

      // (c) Unset NPM_CONFIG_USERCONFIG remains unset (null)
      harness.run({
        GITHUB_ACTION_PATH: externalActionDir,
        REPO_ARCHAEOLOGY_NPX_CLI_JS: mockNpxCliJs,
        NPM_CONFIG_USERCONFIG: undefined,
        npm_config_userconfig: undefined,
        INPUT_BASE: baseSha,
        INPUT_HEAD: headSha,
        INPUT_WORKING_DIRECTORY: 'packages/web',
      });
      const unsetMeta = JSON.parse(readFileSync(launcherMetaFile, 'utf8')) as {
        userconfig: string | null;
      };
      assert.equal(unsetMeta.userconfig, null, 'unset NPM_CONFIG_USERCONFIG must remain unset');

      // Clean up untracked files planted in repo.dir before uncommitted-files & invalid-config tests
      rmSync(symlinkPath, { force: true });
      rmSync(join(repo.dir, 'node_modules'), { recursive: true, force: true });
      rmSync(join(repo.dir, 'package.json'), { force: true });

      // Uncommitted working-tree changes warning & annotation test:
      // 1. Clean tree -> uncommitted-files-count == '0', no warning
      const cleanTreeRun = harness.run({
        INPUT_BASE: baseSha,
        INPUT_HEAD: headSha,
        INPUT_WORKING_DIRECTORY: 'packages/web',
      });
      assert.equal(cleanTreeRun.outputs['uncommitted-files-count'], '0');
      assert.equal(cleanTreeRun.res.stdout, '');
      assert.doesNotMatch(cleanTreeRun.summary, /uncommitted file\(s\) in the runner's working tree/);

      // 2. Gitignored build output (dist/, node_modules/) -> must NOT trigger uncommitted warning
      repo.write('.gitignore', 'dist/\nnode_modules/\n');
      repo.git('add', '.gitignore');
      repo.commit({ message: 'chore: add gitignore' });
      const headWithIgnoreSha = repo.git('rev-parse', 'HEAD').trim();
      repo.write('packages/web/dist/bundle.js', 'console.log("ignored");\n');
      repo.write('packages/web/node_modules/pkg/index.js', 'console.log("ignored");\n');
      const ignoredOnlyRun = harness.run({
        INPUT_BASE: baseSha,
        INPUT_HEAD: headWithIgnoreSha,
        INPUT_WORKING_DIRECTORY: 'packages/web',
      });
      assert.equal(ignoredOnlyRun.outputs['uncommitted-files-count'], '0');
      assert.equal(ignoredOnlyRun.res.stdout, '');
      assert.doesNotMatch(ignoredOnlyRun.summary, /uncommitted file\(s\) in the runner's working tree/);
      rmSync(join(repo.dir, 'packages', 'web', 'dist'), { recursive: true, force: true });
      rmSync(join(repo.dir, 'packages', 'web', 'node_modules'), { recursive: true, force: true });

      // 3. Modified tracked file + hostile untracked filenames -> summary warning, ::warning:: annotation, and count
      repo.write('packages/web/src/a.ts', '// modified by build step\n');
      repo.write('packages/web/src/hostile`100%`.ts', 'export const x = 1;\n');
      repo.write('packages/web/src/third-dirty.ts', 'export const y = 2;\n');
      const dirtyTreeRun = harness.run({
        INPUT_BASE: baseSha,
        INPUT_HEAD: headWithIgnoreSha,
        INPUT_WORKING_DIRECTORY: 'packages/web',
      });
      assert.equal(dirtyTreeRun.outputs['uncommitted-files-count'], '3');
      assert.match(
        dirtyTreeRun.summary,
        /^## Repo Archaeology\n\n> \*\*Warning:\*\* 3 uncommitted file\(s\) in the runner's working tree were included in this analysis \(.*, \+1 more\)\. An earlier workflow step may have modified or created files\./,
      );
      assert.ok(
        dirtyTreeRun.summary.includes('``packages/web/src/hostile`100%`.ts``'),
        'hostile path with backticks must be wrapped in multi-backtick fence in summary',
      );
      assert.match(
        dirtyTreeRun.res.stdout,
        /^::warning::3 uncommitted file\(s\) in the runner's working tree were included in this analysis \(.*hostile`100%25`\.ts, \+1 more\)\. An earlier workflow step may have modified or created files\.\n$/,
      );
      repo.git('checkout', '-q', '--', 'packages/web/src/a.ts');
      rmSync(join(repo.dir, 'packages', 'web', 'src', 'hostile`100%`.ts'), { force: true });
      rmSync(join(repo.dir, 'packages', 'web', 'src', 'third-dirty.ts'), { force: true });
      repo.git('checkout', '-q', headSha);

      // Invalid .repo-archaeology.json regression test:
      // 1. Escapes Markdown links, images, and @mentions (using U+200B zero-width spaces) in the error summary
      // 2. Renders '> **Error:**' (not 'Skipped:')
      // 3. Does not double-prefix 'error: error:' on stderr
      const hostileConfigKey = '![tracker](https://evil.example/p.png) [click](https://evil.example) @octocat #123 GH-7';
      writeFileSync(
        join(repo.dir, '.repo-archaeology.json'),
        JSON.stringify({ [hostileConfigKey]: true }),
        'utf8',
      );
      const invalidConfigRun = harness.run({
        INPUT_BASE: baseSha,
        INPUT_HEAD: headSha,
        INPUT_WORKING_DIRECTORY: 'packages/web',
      });
      rmSync(join(repo.dir, '.repo-archaeology.json'), { force: true });
      assert.equal(invalidConfigRun.res.exitCode, 2);
      assert.match(invalidConfigRun.res.stderr, /^error: \.repo-archaeology\.json:/);
      assert.doesNotMatch(invalidConfigRun.res.stderr, /^error:\s*error:/i);
      assert.match(invalidConfigRun.summary, /> \*\*Error:\*\*/);
      assert.doesNotMatch(invalidConfigRun.summary, /!\[tracker\]\(|\[click\]\(https:\/\/|@octocat|#123|GH-7/);
      assert.match(invalidConfigRun.summary, /\\!\\\[tracker\\\]\\\(https&#58;\/\/evil\.example\/p\.png\\\)/);
      assert.ok(invalidConfigRun.summary.includes('@\u200Boctocat'));
      assert.ok(invalidConfigRun.summary.includes('#\u200B123'));
      assert.ok(invalidConfigRun.summary.includes('GH-\u200B7'));

      // Scenario 12: Execute the actual bash snippet from action.yml end-to-end
      // even when a malicious node_modules/tsx is planted in GITHUB_WORKSPACE
      const tsxPoisonMarker = join(outsideDir, 'workspace-tsx-executed.txt');
      const fakeTsxDir = join(repo.dir, 'node_modules', 'tsx');
      mkdirSync(fakeTsxDir, { recursive: true });
      writeFileSync(
        join(fakeTsxDir, 'package.json'),
        JSON.stringify({ name: 'tsx', version: '4.19.0', bin: './cli.js' }),
        'utf8',
      );
      writeFileSync(
        join(fakeTsxDir, 'cli.js'),
        `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(tsxPoisonMarker)}, 'pwned');\nprocess.exit(0);\n`,
        { encoding: 'utf8', mode: 0o755 },
      );

      writeFileSync(harness.summaryFile, '', 'utf8');
      writeFileSync(harness.outputFile, '', 'utf8');
      const bashScript = [
        'if [ -f "$GITHUB_ACTION_PATH/dist/action/runner.js" ]; then',
        '  NODE_OPTIONS="" node "$GITHUB_ACTION_PATH/dist/action/runner.js"',
        'elif NODE_OPTIONS="" node --experimental-strip-types -e "" >/dev/null 2>&1; then',
        '  NODE_OPTIONS="" node --experimental-strip-types "$GITHUB_ACTION_PATH/src/action/runner.ts"',
        'else',
        '  echo "error: Repo Archaeology GitHub Action requires Node.js >= 22.6 on PATH." >&2',
        '  exit 2',
        'fi',
      ].join('\n');

      const gitBashWin = 'C:\\Program Files\\Git\\bin\\bash.exe';
      const bashBin =
        process.platform === 'win32' && existsSync(gitBashWin) ? gitBashWin : 'bash';
      const shellRes = spawnSync(bashBin, ['-e', '-c', bashScript], {
        cwd: repo.dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          NO_COLOR: '1',
          GITHUB_WORKSPACE: repo.dir,
          GITHUB_ACTION_PATH: ROOT_DIR,
          GITHUB_STEP_SUMMARY: harness.summaryFile,
          GITHUB_OUTPUT: harness.outputFile,
          RUNNER_TEMP: harness.runnerTemp,
          INPUT_BASE: baseSha,
          INPUT_HEAD: headSha,
          INPUT_LIMIT: '5',
          INPUT_WORKING_DIRECTORY: '.',
          INPUT_FAIL_ON_SUGGESTIONS: 'false',
        },
      });
      assert.equal(shellRes.status, 0, shellRes.stderr);
      assert.equal(existsSync(tsxPoisonMarker), false, 'workspace tsx package must never be executed');
      const shellOutputs = parseGitHubOutputFile(readFileSync(harness.outputFile, 'utf8'));
      assert.equal(shellOutputs['analysis-status'], 'analyzed');
      assert.equal(shellOutputs['suggestion-count'], '1');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
      harness.cleanup();
      repo.cleanup();
    }
  });
});
