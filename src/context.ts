import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { compileSkipPattern, ignorePatterns, loadConfigFile, resolveSettings, type Settings } from './config.js';
import { GitError } from './git/run.js';
import { findRepoRoot, hasCommits, isShallow, listCurrentFiles, mergeBases, refExists, resolveCommit } from './git/repo.js';
import { RelationshipClassifier, workingTreeFiles } from './imports/classify.js';
import { CoChangeModel, type Thresholds } from './model/cochange.js';
import { loadHistory, type History } from './model/history.js';
import { PathMatcher } from './util/glob.js';
import { progress } from './util/term.js';

export class UsageError extends Error {
  override name = 'UsageError';
}

export interface ContextOptions {
  /** Isolate history training to the unique merge-base of `<base>` and `HEAD`. */
  base?: string;
}

export interface Context {
  cwd: string;
  root: string;
  settings: Settings;
  history: History;
  model: CoChangeModel;
  /** Files that exist now (tracked + untracked, not ignored). */
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
  /** Commit SHA of `HEAD`. */
  headSha?: string;
}

export const MIN_FULL_HISTORY_COMMITS = 50;

export const SHALLOW_WARNING =
  'This is a shallow clone, so only part of the history is available. Run `git fetch --unshallow` for complete results.';

/**
 * Resolves the unique merge-base between `base` and `HEAD`.
 * Fails with a clear UsageError when `base` is invalid, shares no history with `HEAD`,
 * or has multiple ambiguous merge bases (criss-cross merges).
 */
export async function resolveBaseline(root: string, base: string): Promise<string> {
  if (!(await refExists(root, base))) {
    throw new UsageError(`"${base}" is not a branch, tag or commit in this repository.`);
  }
  const bases = await mergeBases(root, base, 'HEAD');
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
): Promise<{ history: History; model: CoChangeModel; warnings: string[]; ignores: string[] }> {
  const skipFilter = compileSkipPattern(settings.skipCommits, '--skip-commits', settings.skipCommitPrefixes);
  const ignores = ignorePatterns(settings);
  const history = await loadHistory(root, {
    maxCommits: settings.maxCommits,
    since: settings.since,
    maxFilesPerCommit: settings.maxFilesPerCommit,
    ignore: ignores,
    skipCommits: skipFilter,
    rev,
  });
  const warnings: string[] = [];
  if (shallow) warnings.push(SHALLOW_WARNING);
  if (history.commits.length === 0) {
    warnings.push('No usable commits were found (check --since, --max-files and your ignore patterns).');
  } else if (history.commits.length < MIN_FULL_HISTORY_COMMITS) {
    warnings.push(`Only ${history.commits.length} usable commits: results will be thin until the project has more history.`);
  }
  const model = new CoChangeModel(history.commits, { halfLifeDays: settings.halfLifeDays });
  return { history, model, warnings, ignores };
}

export async function loadContext(cwdOption: string | undefined, flags: Partial<Settings>, options?: ContextOptions): Promise<Context> {
  const cwd = resolve(cwdOption ?? process.cwd());
  const root = await findRepoRoot(cwd);
  if (!(await hasCommits(root))) throw new GitError('This repository has no commits yet, so there is no history to analyze.');
  const settings = resolveSettings(loadConfigFile(root), flags);
  compileSkipPattern(settings.skipCommits, '--skip-commits', settings.skipCommitPrefixes); // fail fast on a bad pattern, before reading history

  const [shallow, headSha, mergeBaseSha] = await Promise.all([
    isShallow(root),
    resolveCommit(root, 'HEAD'),
    options?.base !== undefined ? resolveBaseline(root, options.base) : Promise.resolve(undefined),
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
 * - When `base` is provided: isolates history to the unique `merge-base` of `base` and `HEAD`.
 * - When `base` is omitted: ensures `ctx` is trained at `HEAD` (reloading if `ctx` was previously base-isolated).
 */
export async function isolateBaselineContext(ctx: Context, base?: string): Promise<Context> {
  const shallow = ctx.shallow ?? ctx.warnings.includes(SHALLOW_WARNING);
  if (base === undefined) {
    if (ctx.base === undefined) return ctx;
    const headSha = ctx.headSha ?? (await resolveCommit(ctx.root, 'HEAD'));
    const trained = await trainBaseline(ctx.root, ctx.settings, 'HEAD', shallow);
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
    resolveBaseline(ctx.root, base),
    ctx.headSha !== undefined ? Promise.resolve(ctx.headSha) : resolveCommit(ctx.root, 'HEAD'),
  ]);
  if (ctx.base === undefined && mergeBaseSha === headSha) {
    return { ...ctx, shallow, base, mergeBaseSha, headSha };
  }
  const trained = await trainBaseline(ctx.root, ctx.settings, mergeBaseSha, shallow);
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

/** Converts a user-supplied path (relative to cwd, or absolute) to a repo-relative POSIX path. */
export function toRepoPath(ctx: Pick<Context, 'cwd' | 'root'>, input: string): string {
  const absolute = realpathLenient(isAbsolute(input) ? input : resolve(ctx.cwd, input));
  const rel = relative(realpathLenient(ctx.root), absolute);
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
