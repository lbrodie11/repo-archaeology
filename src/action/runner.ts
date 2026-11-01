import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PINNED_ACTION_PACKAGE = 'repo-archaeology@0.3.0';

export type AnalysisStatus = 'analyzed' | 'insufficient-history' | 'skipped';

export interface ActionRunResult {
  exitCode: number;
  suggestionCount: number;
  jsonPath: string;
  analysisStatus: AnalysisStatus;
  summaryMarkdown: string;
  stderr: string;
}

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const VALID_KINDS = new Set(['ghost', 'unknown', 'indirect', 'direct', 'test', 'all']);

function isInsideDir(childPath: string, parentDir: string): boolean {
  const rel = relative(parentDir, childPath);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function writeGitHubOutputs(outputFile: string | undefined, entries: Record<string, string>): void {
  if (!outputFile || outputFile.trim() === '') return;
  const lines: string[] = [];
  for (const [key, rawValue] of Object.entries(entries)) {
    const value = String(rawValue ?? '').replace(/[\r\n]+/g, ' ');
    const delimiter = `ghadelim_${randomBytes(12).toString('hex')}`;
    lines.push(`${key}<<${delimiter}`);
    lines.push(value);
    lines.push(delimiter);
  }
  appendFileSync(outputFile, `${lines.join('\n')}\n`, 'utf8');
}

function writeStepSummary(summaryFile: string | undefined, markdown: string): void {
  if (!summaryFile || summaryFile.trim() === '') return;
  mkdirSync(dirname(resolve(summaryFile)), { recursive: true });
  appendFileSync(summaryFile, markdown.endsWith('\n') ? markdown : `${markdown}\n`, 'utf8');
}

function runGitSync(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  return {
    status: res.status ?? 1,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
  };
}

function validateRefInput(name: string, value: string): void {
  if (CONTROL_CHAR_RE.test(value)) {
    throw new Error(`Invalid '${name}' input: contains control characters.`);
  }
  if (value.startsWith('-')) {
    throw new Error(`Invalid '${name}' input: must not start with '-'.`);
  }
}

function parsePositiveIntInput(name: string, raw: string): number {
  if (CONTROL_CHAR_RE.test(raw) || !/^\d+$/.test(raw)) {
    throw new Error(`Invalid '${name}' input '${raw}': expected a positive integer.`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(`Invalid '${name}' input '${raw}': expected a positive integer.`);
  }
  return n;
}

function parseConfidenceInput(name: string, raw: string): string {
  if (CONTROL_CHAR_RE.test(raw)) {
    throw new Error(`Invalid '${name}' input: contains control characters.`);
  }
  const trimmed = raw.trim();
  const isPercent = trimmed.endsWith('%');
  const numStr = isPercent ? trimmed.slice(0, -1).trim() : trimmed;
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(numStr)) {
    throw new Error(`Invalid '${name}' input '${raw}': expected a number between 0 and 1 (or 0% to 100%).`);
  }
  const num = isPercent ? Number(numStr) / 100 : Number(numStr);
  if (!Number.isFinite(num) || num < 0 || num > 1) {
    throw new Error(`Invalid '${name}' input '${raw}': expected a number between 0 and 1 (or 0% to 100%).`);
  }
  return trimmed;
}

function parseKindsInput(raw: string): string {
  if (CONTROL_CHAR_RE.test(raw)) {
    throw new Error(`Invalid 'kinds' input: contains control characters.`);
  }
  const parts = raw
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`Invalid 'kinds' input '${raw}': expected comma-separated relationship kinds.`);
  }
  for (const part of parts) {
    if (!VALID_KINDS.has(part)) {
      throw new Error(
        `Invalid 'kinds' input '${raw}': unknown kind '${part}' (expected ghost, unknown, indirect, direct, test, or all).`,
      );
    }
  }
  return parts.join(',');
}

function parseBooleanInput(name: string, raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false' || normalized === '') return false;
  throw new Error(`Invalid '${name}' input '${raw}': expected 'true' or 'false'.`);
}

function buildShallowCloneMarkdown(): string {
  return [
    '## Repo Archaeology',
    '',
    '> **Skipped (shallow Git clone detected):** Repo Archaeology requires full commit history to compute accurate pre-change baselines (`git merge-base`), but this checkout is shallow (`git rev-parse --is-shallow-repository` returned `true`).',
    '>',
    '> To enable PR companion analysis, configure `actions/checkout` with `fetch-depth: 0` and check out the pull request head commit:',
    '> ```yaml',
    '> - uses: actions/checkout@v5',
    '>   with:',
    '>     ref: ${{ github.event.pull_request.head.sha }}',
    '>     fetch-depth: 0',
    '> ```',
    '',
  ].join('\n');
}

export function runGitHubAction(env: NodeJS.ProcessEnv = process.env): ActionRunResult {
  const summaryFile = env.GITHUB_STEP_SUMMARY;
  const outputFile = env.GITHUB_OUTPUT;

  const failWith = (message: string, exitCode = 2): ActionRunResult => {
    const cleanMsg = `error: ${message}`;
    writeGitHubOutputs(outputFile, {
      'suggestion-count': '0',
      'json-path': '',
      'analysis-status': 'skipped',
    });
    return {
      exitCode,
      suggestionCount: 0,
      jsonPath: '',
      analysisStatus: 'skipped',
      summaryMarkdown: '',
      stderr: cleanMsg,
    };
  };

  try {
    const workspaceRaw = env.GITHUB_WORKSPACE && env.GITHUB_WORKSPACE.trim() !== ''
      ? env.GITHUB_WORKSPACE.trim()
      : process.cwd();
    if (!existsSync(workspaceRaw)) {
      return failWith(`GITHUB_WORKSPACE does not exist: ${workspaceRaw}`);
    }
    const workspaceReal = realpathSync.native(resolve(workspaceRaw));

    const workingDirInput = (env.INPUT_WORKING_DIRECTORY ?? '.').trim() || '.';
    if (CONTROL_CHAR_RE.test(workingDirInput)) {
      return failWith("Invalid 'working-directory' input: contains control characters.");
    }
    const candidateWorkingDir = resolve(workspaceReal, workingDirInput);
    const workingDirStat = lstatSync(candidateWorkingDir, { throwIfNoEntry: false });
    if (!workingDirStat) {
      return failWith(`working-directory '${workingDirInput}' does not exist inside GITHUB_WORKSPACE.`);
    }
    if (workingDirStat.isSymbolicLink()) {
      return failWith(`working-directory '${workingDirInput}' must not be a symbolic link.`);
    }
    if (!workingDirStat.isDirectory()) {
      return failWith(`working-directory '${workingDirInput}' is not a directory.`);
    }
    const workingDirReal = realpathSync.native(candidateWorkingDir);
    if (!isInsideDir(workingDirReal, workspaceReal)) {
      return failWith(`working-directory '${workingDirInput}' escapes GITHUB_WORKSPACE.`);
    }

    // Parse and validate scalar inputs early.
    const limitRaw = (env.INPUT_LIMIT ?? '5').trim() || '5';
    const limit = parsePositiveIntInput('limit', limitRaw);

    const minSharedRaw = (env.INPUT_MIN_SHARED ?? '').trim();
    const minShared = minSharedRaw !== '' ? parsePositiveIntInput('min-shared', minSharedRaw) : undefined;

    const minConfidenceRaw = (env.INPUT_MIN_CONFIDENCE ?? '').trim();
    const minConfidence =
      minConfidenceRaw !== '' ? parseConfidenceInput('min-confidence', minConfidenceRaw) : undefined;

    const kindsRaw = (env.INPUT_KINDS ?? '').trim();
    const kinds = kindsRaw !== '' ? parseKindsInput(kindsRaw) : undefined;

    const failOnSuggestions = parseBooleanInput(
      'fail-on-suggestions',
      env.INPUT_FAIL_ON_SUGGESTIONS ?? 'false',
    );

    const baseInput = (env.INPUT_BASE ?? '').trim();
    const headInput = (env.INPUT_HEAD ?? '').trim();

    if (baseInput !== '') validateRefInput('base', baseInput);
    if (headInput !== '') validateRefInput('head', headInput);

    // Confirm workingDirReal is inside a Git working tree contained within workspaceReal.
    const insideWorkTree = runGitSync(workingDirReal, ['rev-parse', '--is-inside-work-tree']);
    if (insideWorkTree.status !== 0 || insideWorkTree.stdout !== 'true') {
      return failWith(`working-directory '${workingDirInput}' is not inside a Git working tree.`);
    }
    const topLevel = runGitSync(workingDirReal, ['rev-parse', '--show-toplevel']);
    if (topLevel.status !== 0 || !topLevel.stdout) {
      return failWith('Unable to resolve Git repository top-level directory.');
    }
    const topLevelReal = realpathSync.native(resolve(workingDirReal, topLevel.stdout));
    if (!isInsideDir(topLevelReal, workspaceReal)) {
      return failWith('Git repository root resolves outside GITHUB_WORKSPACE.');
    }

    // Check for shallow clone first: degrade gracefully with exit code 0 and analysis-status=insufficient-history.
    const shallowCheck = runGitSync(workingDirReal, ['rev-parse', '--is-shallow-repository']);
    if (shallowCheck.status === 0 && shallowCheck.stdout === 'true') {
      const md = buildShallowCloneMarkdown();
      writeStepSummary(summaryFile, md);
      writeGitHubOutputs(outputFile, {
        'suggestion-count': '0',
        'json-path': '',
        'analysis-status': 'insufficient-history',
      });
      return {
        exitCode: 0,
        suggestionCount: 0,
        jsonPath: '',
        analysisStatus: 'insufficient-history',
        summaryMarkdown: md,
        stderr: '',
      };
    }

    if (baseInput === '') {
      return failWith(
        "Missing required 'base' input. On non-pull_request events, pass 'with: base: main' (or a base commit SHA).",
      );
    }

    // Verify HEAD exists.
    const actualHeadRes = runGitSync(workingDirReal, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (actualHeadRes.status !== 0 || !actualHeadRes.stdout) {
      return failWith('Unable to resolve HEAD commit in the checked-out repository.');
    }
    const actualHeadSha = actualHeadRes.stdout;

    // When `head` is provided, verify the checked-out commit matches `head` (preventing silent analysis of refs/pull/:id/merge).
    if (headInput !== '') {
      const expectedHeadRes = runGitSync(workingDirReal, [
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${headInput}^{commit}`,
      ]);
      if (expectedHeadRes.status !== 0 || !expectedHeadRes.stdout) {
        return failWith(
          `Expected head commit '${headInput}' is not present locally. Configure actions/checkout with 'ref: \${{ github.event.pull_request.head.sha }}' and 'fetch-depth: 0'.`,
        );
      }
      const expectedHeadSha = expectedHeadRes.stdout;
      if (actualHeadSha !== expectedHeadSha) {
        const secondParentRes = runGitSync(workingDirReal, [
          'rev-parse',
          '--verify',
          '--quiet',
          'HEAD^2^{commit}',
        ]);
        const isSyntheticMerge =
          secondParentRes.status === 0 && secondParentRes.stdout === expectedHeadSha;
        const mergeDetail = isSyntheticMerge
          ? ' (HEAD appears to be GitHub Actions’ synthetic pull_request merge commit refs/pull/:id/merge)'
          : '';
        return failWith(
          `Checked-out HEAD (${actualHeadSha.slice(0, 12)}) does not match expected head (${expectedHeadSha.slice(0, 12)})${mergeDetail}. Configure actions/checkout with 'ref: \${{ github.event.pull_request.head.sha }}' and 'fetch-depth: 0' so Repo Archaeology evaluates the exact PR head commit.`,
        );
      }
    }

    // Verify `base` resolves to a local commit (falling back to `origin/<base>` for detached CI checkouts)
    // and shares a merge-base with HEAD.
    let effectiveBase = baseInput;
    let baseCommitRes = runGitSync(workingDirReal, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${effectiveBase}^{commit}`,
    ]);
    if ((baseCommitRes.status !== 0 || !baseCommitRes.stdout) && !effectiveBase.startsWith('origin/')) {
      const originCandidate = `origin/${effectiveBase}`;
      const originRes = runGitSync(workingDirReal, [
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${originCandidate}^{commit}`,
      ]);
      if (originRes.status === 0 && originRes.stdout) {
        effectiveBase = originCandidate;
        baseCommitRes = originRes;
      }
    }
    if (baseCommitRes.status !== 0 || !baseCommitRes.stdout) {
      return failWith(
        `Base commit or ref '${baseInput}' is not present in the local Git repository. Ensure actions/checkout is configured with 'fetch-depth: 0'.`,
      );
    }
    const mergeBaseRes = runGitSync(workingDirReal, [
      'merge-base',
      '--end-of-options',
      baseCommitRes.stdout,
      actualHeadSha,
    ]);
    if (mergeBaseRes.status !== 0 || !mergeBaseRes.stdout) {
      return failWith(
        `Unable to compute a git merge-base between base '${baseInput}' (${baseCommitRes.stdout.slice(0, 12)}) and HEAD (${actualHeadSha.slice(0, 12)}). Ensure full history is fetched ('fetch-depth: 0').`,
      );
    }

    // Prepare temporary JSON output path in RUNNER_TEMP (or os.tmpdir()).
    const tempBase =
      env.RUNNER_TEMP && env.RUNNER_TEMP.trim() !== '' ? resolve(env.RUNNER_TEMP.trim()) : tmpdir();
    mkdirSync(tempBase, { recursive: true });
    const tempReal = realpathSync.native(tempBase);
    const jsonPath = join(
      tempReal,
      `repo-archaeology-diff-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}.json`,
    );

    const cliArgs: string[] = [
      '-C',
      workingDirReal,
      'diff',
      '--base',
      effectiveBase,
      '--limit',
      String(limit),
      '--format',
      'markdown',
      '--json-out',
      jsonPath,
    ];
    if (minShared !== undefined) {
      cliArgs.push('--min-shared', String(minShared));
    }
    if (minConfidence !== undefined) {
      cliArgs.push('--min-confidence', minConfidence);
    }
    if (kinds !== undefined) {
      cliArgs.push('--kinds', kinds);
    }

    // Determine CLI entrypoint:
    // - When running from src/action/runner.ts (e.g. during `npm test`), prefer src/cli.ts via tsx so a stale dist/ build is never used.
    // - When running from dist/action/runner.js (or when dist/cli.js is built), use dist/cli.js.
    // - Otherwise execute the pinned npm package repo-archaeology@0.3.0 in external repositories.
    const selfPath = fileURLToPath(import.meta.url);
    const runningFromTs = selfPath.endsWith('.ts');
    const defaultActionRoot = resolve(dirname(selfPath), '..', '..');
    const actionPathRaw =
      env.GITHUB_ACTION_PATH && env.GITHUB_ACTION_PATH.trim() !== ''
        ? resolve(env.GITHUB_ACTION_PATH.trim())
        : defaultActionRoot;
    const actionPathReal = existsSync(actionPathRaw) ? realpathSync.native(actionPathRaw) : '';
    const localBuiltCli = actionPathReal ? join(actionPathReal, 'dist', 'cli.js') : '';
    const localSrcCli = actionPathReal ? join(actionPathReal, 'src', 'cli.ts') : '';
    const localTsxLoader = actionPathReal
      ? join(actionPathReal, 'node_modules', 'tsx', 'dist', 'loader.mjs')
      : '';

    const hasBuiltCli =
      Boolean(localBuiltCli) && existsSync(localBuiltCli) && lstatSync(localBuiltCli).isFile();
    const hasSrcCliWithTsx =
      Boolean(localSrcCli) &&
      Boolean(localTsxLoader) &&
      existsSync(localSrcCli) &&
      existsSync(localTsxLoader) &&
      lstatSync(localSrcCli).isFile();
    const localTsxLoaderUrl = hasSrcCliWithTsx ? pathToFileURL(localTsxLoader).href : '';

    const childEnv: NodeJS.ProcessEnv = {
      ...env,
      REPO_ARCHAEOLOGY_JSON_OUT_ROOT: tempReal,
    };

    const execResult =
      runningFromTs && hasSrcCliWithTsx
        ? spawnSync(process.execPath, ['--import', localTsxLoaderUrl, localSrcCli, ...cliArgs], {
            cwd: workingDirReal,
            env: childEnv,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 120_000,
          })
        : hasBuiltCli
          ? spawnSync(process.execPath, [localBuiltCli, ...cliArgs], {
              cwd: workingDirReal,
              env: childEnv,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
              timeout: 120_000,
            })
          : hasSrcCliWithTsx
            ? spawnSync(process.execPath, ['--import', localTsxLoaderUrl, localSrcCli, ...cliArgs], {
                cwd: workingDirReal,
                env: childEnv,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 120_000,
              })
            : spawnSync(
                process.platform === 'win32' ? 'npx.cmd' : 'npx',
                ['--yes', PINNED_ACTION_PACKAGE, ...cliArgs],
                {
                  cwd: workingDirReal,
                  env: childEnv,
                  encoding: 'utf8',
                  stdio: ['ignore', 'pipe', 'pipe'],
                  timeout: 180_000,
                },
              );

    const cliStatus = execResult.status ?? 1;
    const cliStdout = execResult.stdout ?? '';
    const cliStderr = (execResult.stderr ?? '').trim();

    if (cliStatus !== 0) {
      return failWith(cliStderr || `repo-archaeology diff exited with status ${cliStatus}`, cliStatus);
    }

    if (!existsSync(jsonPath)) {
      return failWith('repo-archaeology diff did not produce the expected JSON output file.');
    }

    const parsedJson = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
      schemaVersion?: unknown;
      suggestions?: unknown[];
    };
    if (parsedJson.schemaVersion !== 1 || !Array.isArray(parsedJson.suggestions)) {
      return failWith('Generated JSON output did not match schemaVersion 1.');
    }

    const suggestionCount = parsedJson.suggestions.length;
    writeStepSummary(summaryFile, cliStdout);
    writeGitHubOutputs(outputFile, {
      'suggestion-count': String(suggestionCount),
      'json-path': jsonPath,
      'analysis-status': 'analyzed',
    });

    if (failOnSuggestions && suggestionCount > 0) {
      return {
        exitCode: 1,
        suggestionCount,
        jsonPath,
        analysisStatus: 'analyzed',
        summaryMarkdown: cliStdout,
        stderr: `Repo Archaeology found ${suggestionCount} companion suggestion${suggestionCount === 1 ? '' : 's'} (fail-on-suggestions is enabled).`,
      };
    }

    return {
      exitCode: 0,
      suggestionCount,
      jsonPath,
      analysisStatus: 'analyzed',
      summaryMarkdown: cliStdout,
      stderr: cliStderr,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failWith(message, 2);
  }
}

const isMain =
  process.argv[1] !== undefined &&
  (() => {
    try {
      return realpathSync.native(resolve(process.argv[1])) === realpathSync.native(fileURLToPath(import.meta.url));
    } catch {
      return false;
    }
  })();

if (isMain) {
  const result = runGitHubAction(process.env);
  if (result.stderr) {
    process.stderr.write(`${result.stderr}\n`);
  }
  process.exitCode = result.exitCode;
}
