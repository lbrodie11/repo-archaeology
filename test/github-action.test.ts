import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PINNED_ACTION_PACKAGE, runGitHubAction } from '../src/action/runner.js';
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
    assert.equal(PINNED_ACTION_PACKAGE, 'repo-archaeology@0.3.0');
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

  it('covers Scenario 5: detects shallow clones and exits 0 with analysis-status=insufficient-history', () => {
    const originRepo = new FixtureRepo();
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
    } finally {
      rmSync(shallowRoot, { recursive: true, force: true });
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

      // Scenario 7: HEAD is synthetic merge commit while INPUT_HEAD is prHeadSha -> must fail with actionable guidance
      const mismatch = harness.run({
        INPUT_BASE: forkSha,
        INPUT_HEAD: prHeadSha,
      });
      assert.equal(mismatch.res.exitCode, 2);
      assert.equal(mismatch.outputs['analysis-status'], 'skipped');
      assert.match(mismatch.res.stderr, /Checked-out HEAD .* does not match expected head/);
      assert.match(mismatch.res.stderr, /synthetic pull_request merge commit/);
      assert.match(mismatch.res.stderr, /github\.event\.pull_request\.head\.sha/);

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

  it('covers Scenarios 9, 11 & 12: supports monorepo working-directory, rejects path/symlink escapes and hostile inputs, and runs via action.yml shell step', () => {
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

      // Scenario 12: Execute the actual bash snippet from action.yml end-to-end
      writeFileSync(harness.summaryFile, '', 'utf8');
      writeFileSync(harness.outputFile, '', 'utf8');
      const bashScript = [
        'if [ -f "$GITHUB_ACTION_PATH/dist/action/runner.js" ]; then',
        '  node "$GITHUB_ACTION_PATH/dist/action/runner.js"',
        'elif [ -f "$GITHUB_ACTION_PATH/node_modules/tsx/dist/cli.mjs" ]; then',
        '  node "$GITHUB_ACTION_PATH/node_modules/tsx/dist/cli.mjs" "$GITHUB_ACTION_PATH/src/action/runner.ts"',
        'elif node --experimental-strip-types -e "" >/dev/null 2>&1; then',
        '  node --experimental-strip-types "$GITHUB_ACTION_PATH/src/action/runner.ts"',
        'else',
        '  npx --yes tsx@4.19.0 "$GITHUB_ACTION_PATH/src/action/runner.ts"',
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
