import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  compileSkipPattern,
  CONFIG_FILE,
  ConfigError,
  ignorePatterns,
  loadConfigFile,
  MAX_CONFIG_BYTES,
  parseConfigText,
  resolveSettings,
  type Settings,
} from './config.js';
import { workingTreeChanges } from './git/changes.js';
import {
  findRepoRoot,
  hasCommits,
  isRegularTreeMode,
  isShallow,
  listCurrentFiles,
  listTreeFiles,
  mergeBases,
  refExists,
  resolveCommit,
  type TreeFileSet,
} from './git/repo.js';
import { GitError, runGit } from './git/run.js';
import { gitTreeFiles, RelationshipClassifier, workingTreeFiles, type GitTreeFilesOptions } from './imports/classify.js';
import { CoChangeModel, type Thresholds } from './model/cochange.js';
import { loadHistory, type History } from './model/history.js';
import { PathMatcher } from './util/glob.js';
import { progress } from './util/term.js';

export class UsageError extends Error {
  override name = 'UsageError';
}

export interface ContextOptions {
  /** Isolate history training to the unique merge-base of `<base>` and `HEAD` (or `<head>`). */
  base?: string;
  /** Analyze the repository as of `<head>` without checking it out or reading the working tree. */
  head?: string;
  /** Optional overrides for `gitTreeFiles` when `head` is set (for testing). */
  treeFilesOptions?: GitTreeFilesOptions;
}

export interface Context {
  cwd: string;
  root: string;
  settings: Settings;
  /** Command-line flag overrides passed to loadContext (excluding config-file defaults). */
  flagSettings?: Partial<Settings>;
  history: History;
  model: CoChangeModel;
  /** Files that exist now (tracked + untracked, not ignored; or files in `<head>`'s tree). */
  currentFiles: Set<string>;
  classifier: RelationshipClassifier;
  thresholds: Thresholds;
  warnings: string[];
  /** True when the repository is a shallow clone. */
  shallow?: boolean;
  /** Base ref used to isolate history, when loaded for a branch comparison. */
  base?: string;
  /** Commit SHA of the unique merge-base, only set when `base` is provided. */
  mergeBaseSha?: string;
  /** Commit SHA of `HEAD` (or resolved `<head>` when `--head` is used). */
  headSha?: string;
  /** Head ref and resolved commit SHA when `--head <ref>` was explicitly provided. */
  head?: { ref: string; sha: string };
  /** Starts any long-lived background process (e.g. `git cat-file --batch`) associated with this context. */
  open?: () => void;
  /** Closes any long-lived background process (e.g. `git cat-file --batch`) associated with this context. */
  close?: () => void;
}

export const MIN_FULL_HISTORY_COMMITS = 50;

export const SHALLOW_WARNING =
  'This is a shallow clone, so only part of the history is available. Run `git fetch --unshallow` for complete results.';

export const DIRTY_WORKTREE_HEAD_WARNING =
  'Working tree has uncommitted changes; uncommitted changes were ignored because --head was specified.';

/**
 * Validates and resolves `--head <ref>` to a commit SHA.
 * Rejects values starting with `-`, missing refs, and non-commit objects (e.g. tree or blob SHAs) with UsageError.
 */
export async function resolveHead(root: string, head: string): Promise<string> {
  const trimmed = head.trim();
  if (trimmed === '' || trimmed.startsWith('-')) {
    throw new UsageError(`Invalid --head revision "${head}": revision cannot be empty or start with "-".`);
  }
  try {
    return await resolveCommit(root, trimmed);
  } catch {
    throw new UsageError(`"${head}" is not a branch, tag or commit in this repository.`);
  }
}

/**
 * Resolves the unique merge-base between `base` and `head` (defaults to `HEAD`).
 * Fails with a clear UsageError when `base` is invalid, shares no history with `head`,
 * or has multiple ambiguous merge bases (criss-cross merges).
 */
export async function resolveBaseline(root: string, base: string, head = 'HEAD'): Promise<string> {
  if (!(await refExists(root, base))) {
    throw new UsageError(`"${base}" is not a branch, tag or commit in this repository.`);
  }
  const bases = await mergeBases(root, base, head);
  if (bases.length === 0) {
    if (await isShallow(root)) {
      throw new UsageError(
        `Cannot establish a pre-change baseline: "${base}" and HEAD have no common ancestor in this shallow clone. Run \`git fetch --unshallow\` for complete history.`,
      );
    }
    throw new UsageError(`Cannot establish a pre-change baseline: "${base}" and HEAD have no common ancestor.`);
  }
  if (bases.length > 1) {
    const short = bases.map((b) => b.slice(0, 7)).join(', ');
    throw new UsageError(
      `Cannot establish a unique pre-change baseline: "${base}" and HEAD have multiple merge bases (${short}). Pass a specific commit with \`--base <sha>\` (e.g. \`--base ${bases[0]!.slice(0, 7)}\`).`,
    );
  }
  return bases[0]!;
}

async function trainBaseline(
  root: string,
  settings: Settings,
  rev: string,
  shallow = false,
  extraWarnings: readonly string[] = [],
): Promise<{ history: History; model: CoChangeModel; warnings: string[]; ignores: string[] }> {
  const skipFilter = compileSkipPattern(settings.skipCommits, '--skip-commits', settings.skipCommitPrefixes);
  const ignores = ignorePatterns(settings);
  const history = await loadHistory(root, {
    maxCommits: settings.maxCommits,
    since: settings.since,
    maxFilesPerCommit: settings.maxFilesPerCommit,
    ignore: ignores,
    skipCommits: skipFilter,
    origin: settings.origin,
    rev,
  });
  const warnings: string[] = [];
  if (shallow) warnings.push(SHALLOW_WARNING);
  for (const w of extraWarnings) {
    if (!warnings.includes(w)) warnings.push(w);
  }
  if (history.commits.length === 0) {
    warnings.push('No usable commits were found (check --since, --max-files and your ignore patterns).');
  } else if (history.commits.length < MIN_FULL_HISTORY_COMMITS) {
    warnings.push(`Only ${history.commits.length} usable commits: results will be thin until the project has more history.`);
  }
  const model = new CoChangeModel(history.commits, {
    halfLifeDays: settings.halfLifeDays,
    originWeights: settings.origin?.weights,
  });
  return { history, model, warnings, ignores };
}

async function loadConfigFromHeadTree(root: string, headSha: string, treeFiles: TreeFileSet): Promise<Partial<Settings>> {
  const mode = treeFiles.modes.get(CONFIG_FILE);
  if (mode === undefined) return {};
  if (!isRegularTreeMode(mode)) {
    throw new ConfigError(`${CONFIG_FILE} must be a regular file, not a symlink or device.`);
  }
  const spec = `${headSha}:${CONFIG_FILE}`;
  const sizeOut = (await runGit(root, ['cat-file', '-s', '--end-of-options', spec])).trim();
  if (Number(sizeOut) > MAX_CONFIG_BYTES) {
    throw new ConfigError(`${CONFIG_FILE} is larger than ${MAX_CONFIG_BYTES / 1024} KB.`);
  }
  const content = await runGit(root, ['cat-file', 'blob', '--end-of-options', spec]);
  return parseConfigText(content, CONFIG_FILE);
}

export async function loadContext(cwdOption: string | undefined, flags: Partial<Settings>, options?: ContextOptions): Promise<Context> {
  const cwd = resolve(cwdOption ?? process.cwd());
  const root = await findRepoRoot(cwd);
  if (!(await hasCommits(root))) throw new GitError('This repository has no commits yet, so there is no history to analyze.');

  const headRef = options?.head;
  if (headRef !== undefined) {
    const [headSha, checkedOutHeadSha] = await Promise.all([
      resolveHead(root, headRef),
      resolveCommit(root, 'HEAD'),
    ]);
    const [shallow, mergeBaseSha, currentFiles, wtChanges] = await Promise.all([
      isShallow(root),
      options?.base !== undefined ? resolveBaseline(root, options.base, headSha) : Promise.resolve(undefined),
      listTreeFiles(root, headSha),
      headSha === checkedOutHeadSha ? workingTreeChanges(root) : Promise.resolve([]),
    ]);
    let fileConfig: Partial<Settings>;
    let configWarning: string | undefined;
    try {
      fileConfig = await loadConfigFromHeadTree(root, headSha, currentFiles);
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      fileConfig = loadConfigFile(root);
      configWarning = `Ignoring invalid ${CONFIG_FILE} at ${headRef} (${err.message}); using working-tree configuration instead.`;
    }
    const settings = resolveSettings(fileConfig, flags);
    compileSkipPattern(settings.skipCommits, '--skip-commits', settings.skipCommitPrefixes);

    progress('Reading git history…');
    const extraWarnings: string[] = [];
    if (configWarning !== undefined) extraWarnings.push(configWarning);
    if (wtChanges.length > 0) extraWarnings.push(DIRTY_WORKTREE_HEAD_WARNING);
    const trained = await trainBaseline(root, settings, mergeBaseSha ?? headSha, shallow, extraWarnings);
    const bridgeIgnores = new PathMatcher(trained.ignores);
    const treeFiles = gitTreeFiles(root, headSha, currentFiles, options?.treeFilesOptions);
    const classifier = new RelationshipClassifier(treeFiles, (path) => !bridgeIgnores.matches(path));
    return {
      cwd,
      root,
      settings,
      flagSettings: flags,
      history: trained.history,
      model: trained.model,
      currentFiles,
      classifier,
      thresholds: { minShared: settings.minShared, minConfidence: settings.minConfidence },
      warnings: trained.warnings,
      shallow,
      base: options?.base,
      mergeBaseSha,
      headSha,
      head: { ref: headRef, sha: headSha },
      open: () => treeFiles.open(),
      close: () => treeFiles.close(),
    };
  }

  const settings = resolveSettings(loadConfigFile(root), flags);
  compileSkipPattern(settings.skipCommits, '--skip-commits', settings.skipCommitPrefixes); // fail fast on a bad pattern, before reading history

  const headSha = await resolveCommit(root, 'HEAD');
  const [shallow, mergeBaseSha] = await Promise.all([
    isShallow(root),
    options?.base !== undefined ? resolveBaseline(root, options.base, 'HEAD') : Promise.resolve(undefined),
  ]);

  progress('Reading git history…');
  const [trained, currentFiles] = await Promise.all([
    trainBaseline(root, settings, mergeBaseSha ?? 'HEAD', shallow),
    listCurrentFiles(root),
  ]);

  const bridgeIgnores = new PathMatcher(trained.ignores);
  const classifier = new RelationshipClassifier(workingTreeFiles(root, currentFiles), (path) => !bridgeIgnores.matches(path));
  return {
    cwd,
    root,
    settings,
    flagSettings: flags,
    history: trained.history,
    model: trained.model,
    currentFiles,
    classifier,
    thresholds: { minShared: settings.minShared, minConfidence: settings.minConfidence },
    warnings: trained.warnings,
    shallow,
    base: options?.base,
    mergeBaseSha,
    headSha,
  };
}

/**
 * Ensures `ctx` is trained on the appropriate pre-change baseline:
 * - When `base` is provided: isolates history to the unique `merge-base` of `base` and `HEAD` (or `<head>`).
 * - When `base` is omitted: ensures `ctx` is trained at `HEAD` (or `<head>`).
 */
export async function isolateBaselineContext(ctx: Context, base?: string): Promise<Context> {
  const shallow = ctx.shallow ?? ctx.warnings.includes(SHALLOW_WARNING);
  const targetHead = ctx.head?.sha ?? 'HEAD';
  const isCommitCountWarning = (w: string): boolean =>
    w.startsWith('No usable commits were found') || w.startsWith('Only ');
  const extraWarnings = ctx.warnings.filter((w) => w !== SHALLOW_WARNING && !isCommitCountWarning(w));
  if (base === undefined) {
    if (ctx.base === undefined) return ctx;
    const headSha = ctx.headSha ?? (await resolveCommit(ctx.root, targetHead));
    const trained = await trainBaseline(ctx.root, ctx.settings, targetHead, shallow, extraWarnings);
    return {
      ...ctx,
      history: trained.history,
      model: trained.model,
      warnings: trained.warnings,
      shallow,
      base: undefined,
      mergeBaseSha: undefined,
      headSha,
    };
  }
  if (ctx.base === base && ctx.mergeBaseSha !== undefined) return ctx;
  const [mergeBaseSha, headSha] = await Promise.all([
    resolveBaseline(ctx.root, base, targetHead),
    ctx.headSha !== undefined ? Promise.resolve(ctx.headSha) : resolveCommit(ctx.root, targetHead),
  ]);
  if (ctx.base === undefined && mergeBaseSha === headSha) {
    return { ...ctx, shallow, base, mergeBaseSha, headSha };
  }
  const trained = await trainBaseline(ctx.root, ctx.settings, mergeBaseSha, shallow, extraWarnings);
  return {
    ...ctx,
    history: trained.history,
    model: trained.model,
    warnings: trained.warnings,
    shallow,
    base,
    mergeBaseSha,
    headSha,
  };
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Resolves symlink aliases at or above `realRoot` (such as `/var` -> `/private/var` or
 * `/tmp` -> `/private/tmp` on macOS) while preserving the lexical path beneath `realRoot`
 * so checkout symlinks inside the repository are never followed for historical `--head` paths.
 */
function normalizeAtRepoRoot(path: string, realRoot: string): string {
  const resolved = resolve(path);
  if (isWithinRoot(realRoot, resolved)) return resolved;

  const chain: { dir: string; suffix: string[] }[] = [];
  let cursor = resolved;
  const parts: string[] = [];
  while (true) {
    chain.push({ dir: cursor, suffix: [...parts] });
    const parent = dirname(cursor);
    if (parent === cursor) break;
    parts.unshift(basename(cursor));
    cursor = parent;
  }
  chain.reverse();

  for (const { dir, suffix } of chain) {
    try {
      if (realpathSync.native(dir) === realRoot) {
        return suffix.length > 0 ? resolve(realRoot, ...suffix) : realRoot;
      }
    } catch {
      // Non-existent path segment; cannot be the repository root on disk.
      break;
    }
  }
  return resolved;
}

/** Converts a user-supplied path (relative to cwd, or absolute) to a repo-relative POSIX path. */
export function toRepoPath(ctx: Pick<Context, 'cwd' | 'root' | 'head'>, input: string): string {
  const realRoot = realpathLenient(ctx.root);
  if (ctx.head !== undefined) {
    const normalizedCwd = normalizeAtRepoRoot(ctx.cwd, realRoot);
    const baseCwd = isWithinRoot(realRoot, normalizedCwd) ? normalizedCwd : realpathLenient(ctx.cwd);
    const rawTarget = isAbsolute(input) ? resolve(input) : resolve(baseCwd, input);
    const target = normalizeAtRepoRoot(rawTarget, realRoot);
    const rel = relative(realRoot, target);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new UsageError(`${input} is outside the repository at ${ctx.root}.`);
    }
    return rel.split(sep).join('/');
  }
  const absolute = realpathLenient(isAbsolute(input) ? input : resolve(ctx.cwd, input));
  const rel = relative(realRoot, absolute);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new UsageError(`${input} is outside the repository at ${ctx.root}.`);
  }
  return rel.split(sep).join('/');
}

/**
 * git reports the repository root with symlinks resolved (e.g. /private/var on macOS),
 * so user paths are resolved the same way. Deleted files fall back to their parent.
 */
function realpathLenient(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realpathLenient(parent), basename(path));
  }
}
