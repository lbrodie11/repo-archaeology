import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function readPackageVersion(): string {
  try {
    const pkgPath = new URL('../../package.json', import.meta.url);
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim() !== '') {
      return parsed.version.trim();
    }
  } catch {
    // Fallback if package.json cannot be read relative to runner
  }
  return '0.8.0';
}

export const PINNED_ACTION_PACKAGE = `repo-archaeology@${readPackageVersion()}`;

export type AnalysisStatus = 'analyzed' | 'insufficient-history' | 'skipped';

export interface ActionRunResult {
  exitCode: number;
  suggestionCount: number;
  uncommittedFilesCount: number;
  jsonPath: string;
  analysisStatus: AnalysisStatus;
  summaryMarkdown: string;
  stdout: string;
  stderr: string;
}

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const ACTION_CONTROL_AND_BIDI_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Bidi_Control}/gu;
const VALID_KINDS = new Set(['ghost', 'unknown', 'indirect', 'direct', 'test', 'all']);

function stripLeadingErrorPrefix(message: string): string {
  return message.trim().replace(/^(?:error:\s*)+/i, '');
}

function sanitizeActionControlChars(value: string, maxChars = 360): string {
  const cleaned = value.replace(ACTION_CONTROL_AND_BIDI_RE, (ch) => {
    if (ch === '\n' || ch === '\r' || ch === '\t') return ' ';
    const code = ch.codePointAt(0)!;
    return code <= 0xff
      ? `\\x${code.toString(16).padStart(2, '0')}`
      : `\\u${code.toString(16).padStart(4, '0')}`;
  });
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 1))}…`;
}

function sanitizeActionCodeChars(value: string, maxChars = 240): string {
  const cleaned = value.replace(ACTION_CONTROL_AND_BIDI_RE, (ch) => {
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    if (ch === '\t') return '\\t';
    const code = ch.codePointAt(0)!;
    return code <= 0xff
      ? `\\x${code.toString(16).padStart(2, '0')}`
      : `\\u${code.toString(16).padStart(4, '0')}`;
  });
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 1))}…`;
}

function formatActionCodeSpan(value: string, maxChars = 240): string {
  const sanitized = sanitizeActionCodeChars(value, maxChars);
  if (sanitized.length === 0) {
    return '` `';
  }
  let fence = '`';
  while (sanitized.includes(fence)) {
    fence += '`';
  }
  const needsSpacePadding =
    sanitized.startsWith('`') ||
    sanitized.endsWith('`') ||
    sanitized.startsWith(' ') ||
    sanitized.endsWith(' ');
  const pad = needsSpacePadding ? ' ' : '';
  return `${fence}${pad}${sanitized}${pad}${fence}`;
}

export function escapeWorkflowCommand(value: string): string {
  return value
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(ACTION_CONTROL_AND_BIDI_RE, (ch) => {
      const code = ch.codePointAt(0)!;
      return code <= 0xff
        ? `\\x${code.toString(16).padStart(2, '0')}`
        : `\\u${code.toString(16).padStart(4, '0')}`;
    });
}

function escapeActionMarkdownInline(value: string, maxChars = 360): string {
  const sanitized = sanitizeActionControlChars(value, maxChars);
  return sanitized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@([a-zA-Z0-9_-]+)/g, '@\u200B$1')
    .replace(/#(\d+)/g, '#\u200B$1')
    .replace(/\b(GH)-(\d+)\b/gi, '$1-\u200B$2')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/~/g, '\\~')
    .replace(/!/g, '\\!')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\|/g, '\\|')
    .replace(/\b(https?):\/\//gi, '$1&#58;//');
}

function isInsideDir(childPath: string, parentDir: string): boolean {
  const rel = relative(parentDir, childPath);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function nearestExistingAncestor(targetPath: string): string {
  let current = targetPath;
  while (true) {
    const st = lstatSync(current, { throwIfNoEntry: false });
    if (st) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function resolveCanonicalPath(rawPath: string, baseDir: string): string {
  const resolved = resolve(baseDir, rawPath);
  const ancestor = nearestExistingAncestor(resolved);
  try {
    const ancestorReal = realpathSync.native(ancestor);
    const rel = relative(ancestor, resolved);
    return rel ? resolve(ancestorReal, rel) : ancestorReal;
  } catch {
    return resolved;
  }
}

function isInsideWorkspacePath(candidatePath: string, workspaceReal: string): boolean {
  if (isInsideDir(candidatePath, workspaceReal)) return true;
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return isInsideDir(candidatePath.toLowerCase(), workspaceReal.toLowerCase());
  }
  return false;
}

function sanitizeNpmConfigVar(
  envObj: NodeJS.ProcessEnv,
  canonicalName: 'NPM_CONFIG_USERCONFIG' | 'NPM_CONFIG_GLOBALCONFIG',
  workspaceReal: string,
  emptyNpmrc: string,
): void {
  const matchingKeys = Object.keys(envObj).filter(
    (k) => k.toLowerCase() === canonicalName.toLowerCase(),
  );
  let rawVal: string | undefined;
  for (const k of matchingKeys) {
    const v = envObj[k];
    if (typeof v === 'string' && v.trim() !== '') {
      rawVal = v.trim();
    }
    delete envObj[k];
  }
  if (rawVal === undefined) {
    return;
  }
  const resolvedTarget = resolve(workspaceReal, rawVal);
  const canonicalTarget = resolveCanonicalPath(rawVal, workspaceReal);
  if (isInsideWorkspacePath(canonicalTarget, workspaceReal)) {
    envObj[canonicalName] = emptyNpmrc;
  } else {
    envObj[canonicalName] = resolvedTarget;
  }
}

function writeGitHubOutputs(outputFile: string | undefined, entries: Record<string, string>): void {
  if (!outputFile || outputFile.trim() === '') return;
  const lines: string[] = [];
  for (const [key, rawValue] of Object.entries(entries)) {
    const value = String(rawValue ?? '').replace(/[\r\n]+/g, ' ');
    const delim = `ghadelim_${randomBytes(12).toString('hex')}`;
    lines.push(`${key}<<${delim}`);
    lines.push(value);
    lines.push(delim);
  }
  appendFileSync(outputFile, `${lines.join('\n')}\n`, 'utf8');
}

function writeStepSummary(summaryFile: string | undefined, markdown: string, mirrorFile?: string): void {
  const normalized = markdown.endsWith('\n') ? markdown : `${markdown}\n`;
  if (summaryFile && summaryFile.trim() !== '') {
    mkdirSync(dirname(resolve(summaryFile)), { recursive: true });
    appendFileSync(summaryFile, normalized, 'utf8');
  }
  if (mirrorFile && mirrorFile.trim() !== '') {
    mkdirSync(dirname(resolve(mirrorFile)), { recursive: true });
    writeFileSync(resolve(mirrorFile), normalized, 'utf8');
  }
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

function buildInsufficientCommitsMarkdown(commitCount: number): string {
  return [
    '## Repo Archaeology',
    '',
    `> **Skipped (insufficient commit history):** Repo Archaeology requires at least 2 commits in repository history to compare changes against a baseline, but only ${commitCount} commit${commitCount === 1 ? ' was' : 's were'} found at \`HEAD\`.`,
    '',
  ].join('\n');
}

function buildErrorMarkdown(message: string): string {
  const safeMsg = escapeActionMarkdownInline(stripLeadingErrorPrefix(message), 360);
  return ['## Repo Archaeology', '', `> **Error:** ${safeMsg}`, ''].join('\n');
}

/**
 * Resolves the absolute path to Node/npm's `npx-cli.js` entry point so external
 * package execution can be launched directly via `process.execPath` (`shell: false`)
 * across Windows, macOS, and Linux without invoking `.cmd` batch scripts.
 */
export function resolveNpxCliJs(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicitOverride = env.REPO_ARCHAEOLOGY_NPX_CLI_JS?.trim();
  if (explicitOverride && existsSync(explicitOverride)) {
    return resolve(explicitOverride);
  }

  const execDir = dirname(process.execPath);
  const candidates: string[] = [
    join(execDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    join(execDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ];

  if (env.npm_execpath && env.npm_execpath.trim() !== '') {
    candidates.push(join(dirname(env.npm_execpath.trim()), 'npx-cli.js'));
  }

  const pathVar = env.PATH ?? env.Path ?? '';
  for (const dir of pathVar.split(delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    candidates.push(join(trimmed, 'node_modules', 'npm', 'bin', 'npx-cli.js'));
    candidates.push(join(trimmed, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'));
  }

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && lstatSync(candidate).isFile()) {
        return realpathSync.native(candidate);
      }
    } catch {
      // continue searching
    }
  }
  return undefined;
}

export function runGitHubAction(env: NodeJS.ProcessEnv = process.env): ActionRunResult {
  const summaryFile = env.GITHUB_STEP_SUMMARY;
  // Optional smoke-test hook: mirrors the rendered step summary to a caller-specified file
  // because GitHub Actions clears/isolates $GITHUB_STEP_SUMMARY between composite action steps.
  const summaryMirrorFile = env.REPO_ARCHAEOLOGY_SUMMARY_OUT;
  const outputFile = env.GITHUB_OUTPUT;

  const failWith = (message: string, exitCode = 2): ActionRunResult => {
    const normalized = stripLeadingErrorPrefix(message);
    const cleanMsg = `error: ${normalized}`;
    const errMd = buildErrorMarkdown(normalized);
    writeStepSummary(summaryFile, errMd, summaryMirrorFile);
    writeGitHubOutputs(outputFile, {
      'suggestion-count': '0',
      'uncommitted-files-count': '0',
      'json-path': '',
      'analysis-status': 'skipped',
    });
    return {
      exitCode,
      suggestionCount: 0,
      uncommittedFilesCount: 0,
      jsonPath: '',
      analysisStatus: 'skipped',
      summaryMarkdown: errMd,
      stdout: '',
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
      writeStepSummary(summaryFile, md, summaryMirrorFile);
      writeGitHubOutputs(outputFile, {
        'suggestion-count': '0',
        'uncommitted-files-count': '0',
        'json-path': '',
        'analysis-status': 'insufficient-history',
      });
      return {
        exitCode: 0,
        suggestionCount: 0,
        uncommittedFilesCount: 0,
        jsonPath: '',
        analysisStatus: 'insufficient-history',
        summaryMarkdown: md,
        stdout: '',
        stderr: '',
      };
    }

    // Check bounded commit count at HEAD (< 2 commits -> insufficient-history, exit code 0).
    const commitCountCheck = runGitSync(workingDirReal, ['rev-list', '--count', '-n', '2', 'HEAD']);
    const commitCount = commitCountCheck.status === 0 ? Number.parseInt(commitCountCheck.stdout, 10) : 0;
    if (!Number.isFinite(commitCount) || commitCount < 2) {
      const md = buildInsufficientCommitsMarkdown(Number.isFinite(commitCount) ? commitCount : 0);
      writeStepSummary(summaryFile, md, summaryMirrorFile);
      writeGitHubOutputs(outputFile, {
        'suggestion-count': '0',
        'uncommitted-files-count': '0',
        'json-path': '',
        'analysis-status': 'insufficient-history',
      });
      return {
        exitCode: 0,
        suggestionCount: 0,
        uncommittedFilesCount: 0,
        jsonPath: '',
        analysisStatus: 'insufficient-history',
        summaryMarkdown: md,
        stdout: '',
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
    if (!env.REPO_ARCHAEOLOGY_CACHE_DIR?.trim()) {
      cliArgs.push('--no-cache');
    }

    // Determine CLI entrypoint:
    // - When running from src/action/runner.ts (e.g. during `npm test`), prefer src/cli.ts via tsx so a stale dist/ build is never used.
    // - When running from dist/action/runner.js (or when dist/cli.js is built), use dist/cli.js.
    // - Otherwise execute the pinned npm package in an isolated temporary directory outside GITHUB_WORKSPACE.
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

    let execResult: ReturnType<typeof spawnSync>;
    if (runningFromTs && hasSrcCliWithTsx) {
      execResult = spawnSync(
        process.execPath,
        ['--import', localTsxLoaderUrl, localSrcCli, ...cliArgs],
        {
          cwd: workingDirReal,
          env: childEnv,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 120_000,
        },
      );
    } else if (hasBuiltCli) {
      execResult = spawnSync(process.execPath, [localBuiltCli, ...cliArgs], {
        cwd: workingDirReal,
        env: childEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      });
    } else if (hasSrcCliWithTsx) {
      execResult = spawnSync(
        process.execPath,
        ['--import', localTsxLoaderUrl, localSrcCli, ...cliArgs],
        {
          cwd: workingDirReal,
          env: childEnv,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 120_000,
        },
      );
    } else {
      // External consumer path: execute in a clean, isolated temp directory outside GITHUB_WORKSPACE
      // so the target repository's package.json, node_modules/.bin, or .npmrc can never hijack resolution.
      const isolatedExecDir = join(
        tempReal,
        `repo-arch-exec-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`,
      );
      mkdirSync(isolatedExecDir, { recursive: true });
      const emptyProjectNpmrc = join(isolatedExecDir, '.npmrc');
      const emptyUserNpmrc = join(isolatedExecDir, 'user.npmrc');
      const emptyGlobalNpmrc = join(isolatedExecDir, 'global.npmrc');
      writeFileSync(join(isolatedExecDir, 'package.json'), '{"private":true}\n', 'utf8');
      writeFileSync(emptyProjectNpmrc, '', 'utf8');
      writeFileSync(emptyUserNpmrc, '', 'utf8');
      writeFileSync(emptyGlobalNpmrc, '', 'utf8');

      const isolatedEnv: NodeJS.ProcessEnv = {
        ...childEnv,
      };
      sanitizeNpmConfigVar(isolatedEnv, 'NPM_CONFIG_USERCONFIG', workspaceReal, emptyUserNpmrc);
      sanitizeNpmConfigVar(isolatedEnv, 'NPM_CONFIG_GLOBALCONFIG', workspaceReal, emptyGlobalNpmrc);
      delete isolatedEnv.NODE_OPTIONS;

      const npxCliJs = resolveNpxCliJs(env);
      try {
        execResult = npxCliJs
          ? spawnSync(
              process.execPath,
              [npxCliJs, '--yes', `--prefix=${isolatedExecDir}`, PINNED_ACTION_PACKAGE, ...cliArgs],
              {
                cwd: isolatedExecDir,
                env: isolatedEnv,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 180_000,
              },
            )
          : spawnSync(
              'npx',
              ['--yes', `--prefix=${isolatedExecDir}`, PINNED_ACTION_PACKAGE, ...cliArgs],
              {
                cwd: isolatedExecDir,
                env: isolatedEnv,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 180_000,
              },
            );
      } finally {
        try {
          rmSync(isolatedExecDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup failure
        }
      }
    }

    const cliStatus = execResult.status ?? 1;
    const cliStdout = String(execResult.stdout ?? '');
    const cliStderr = String(execResult.stderr ?? '').trim();

    if (cliStatus !== 0) {
      return failWith(cliStderr || `repo-archaeology diff exited with status ${cliStatus}`, cliStatus);
    }

    if (!existsSync(jsonPath)) {
      return failWith('repo-archaeology diff did not produce the expected JSON output file.');
    }

    const parsedJson = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
      schemaVersion?: unknown;
      changed?: unknown[];
      totalSuggestions?: unknown;
      suggestions?: unknown[];
    };
    if (parsedJson.schemaVersion !== 1 || !Array.isArray(parsedJson.suggestions)) {
      return failWith('Generated JSON output did not match schemaVersion 1.');
    }

    const uncommittedFiles: string[] = [];
    if (Array.isArray(parsedJson.changed)) {
      for (const entry of parsedJson.changed) {
        if (entry && typeof entry === 'object') {
          const rec = entry as { path?: unknown; sources?: unknown };
          if (
            typeof rec.path === 'string' &&
            Array.isArray(rec.sources) &&
            rec.sources.some((s) => typeof s === 'string' && s !== 'branch')
          ) {
            uncommittedFiles.push(rec.path);
          }
        }
      }
    }

    const uncommittedFilesCount = uncommittedFiles.length;
    let finalSummaryMarkdown = cliStdout;
    let actionStdout = '';
    if (uncommittedFilesCount > 0) {
      const shownMd = uncommittedFiles.slice(0, 2).map((p) => formatActionCodeSpan(p));
      const extraCount = uncommittedFilesCount - shownMd.length;
      if (extraCount > 0) {
        shownMd.push(`+${extraCount} more`);
      }
      const warningMd =
        `> **Warning:** ${uncommittedFilesCount} uncommitted file(s) in the runner's working tree were included in this analysis (${shownMd.join(', ')}). An earlier workflow step may have modified or created files.`;
      const headingPrefix = '## Repo Archaeology\n\n';
      finalSummaryMarkdown = cliStdout.startsWith(headingPrefix)
        ? `${headingPrefix}${warningMd}\n\n${cliStdout.slice(headingPrefix.length)}`
        : `${warningMd}\n\n${cliStdout}`;

      const shownPlain = uncommittedFiles.slice(0, 2);
      if (extraCount > 0) {
        shownPlain.push(`+${extraCount} more`);
      }
      const annotationMsg =
        `${uncommittedFilesCount} uncommitted file(s) in the runner's working tree were included in this analysis (${shownPlain.join(', ')}). An earlier workflow step may have modified or created files.`;
      actionStdout = `::warning::${escapeWorkflowCommand(annotationMsg)}\n`;
    }

    const suggestionCount =
      typeof parsedJson.totalSuggestions === 'number' && Number.isFinite(parsedJson.totalSuggestions)
        ? Math.max(parsedJson.totalSuggestions, parsedJson.suggestions.length)
        : parsedJson.suggestions.length;
    writeStepSummary(summaryFile, finalSummaryMarkdown, summaryMirrorFile);
    writeGitHubOutputs(outputFile, {
      'suggestion-count': String(suggestionCount),
      'uncommitted-files-count': String(uncommittedFilesCount),
      'json-path': jsonPath,
      'analysis-status': 'analyzed',
    });

    if (failOnSuggestions && suggestionCount > 0) {
      return {
        exitCode: 1,
        suggestionCount,
        uncommittedFilesCount,
        jsonPath,
        analysisStatus: 'analyzed',
        summaryMarkdown: finalSummaryMarkdown,
        stdout: actionStdout,
        stderr: `Repo Archaeology found ${suggestionCount} companion suggestion${suggestionCount === 1 ? '' : 's'} (fail-on-suggestions is enabled).`,
      };
    }

    return {
      exitCode: 0,
      suggestionCount,
      uncommittedFilesCount,
      jsonPath,
      analysisStatus: 'analyzed',
      summaryMarkdown: finalSummaryMarkdown,
      stdout: actionStdout,
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
  if (result.stdout) {
    process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  }
  if (result.stderr) {
    process.stderr.write(`${result.stderr}\n`);
  }
  process.exitCode = result.exitCode;
}
