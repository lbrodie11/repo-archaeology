import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { compileSkipPattern, ignorePatterns, loadConfigFile, resolveSettings, type Settings } from './config.js';
import { GitError } from './git/run.js';
import { findRepoRoot, hasCommits, isShallow, listCurrentFiles } from './git/repo.js';
import { RelationshipClassifier, workingTreeFiles } from './imports/classify.js';
import { CoChangeModel, type Thresholds } from './model/cochange.js';
import { loadHistory, type History } from './model/history.js';
import { progress } from './util/term.js';

export class UsageError extends Error {
  override name = 'UsageError';
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
}

export async function loadContext(cwdOption: string | undefined, flags: Partial<Settings>): Promise<Context> {
  const cwd = resolve(cwdOption ?? process.cwd());
  const root = await findRepoRoot(cwd);
  if (!(await hasCommits(root))) throw new GitError('This repository has no commits yet, so there is no history to analyze.');
  const settings = resolveSettings(loadConfigFile(root), flags);
  compileSkipPattern(settings.skipCommits); // fail fast on a bad pattern, before reading history

  const warnings: string[] = [];
  if (await isShallow(root)) {
    warnings.push('This is a shallow clone, so only part of the history is available. Run `git fetch --unshallow` for complete results.');
  }

  progress('Reading git history…');
  const [history, currentFiles] = await Promise.all([
    loadHistory(root, {
      maxCommits: settings.maxCommits,
      since: settings.since,
      maxFilesPerCommit: settings.maxFilesPerCommit,
      ignore: ignorePatterns(settings),
      skipCommits: compileSkipPattern(settings.skipCommits),
    }),
    listCurrentFiles(root),
  ]);
  if (history.commits.length === 0) {
    warnings.push('No usable commits were found (check --since, --max-files and your ignore patterns).');
  } else if (history.commits.length < 50) {
    warnings.push(`Only ${history.commits.length} usable commits: results will be thin until the project has more history.`);
  }

  const model = new CoChangeModel(history.commits, { halfLifeDays: settings.halfLifeDays });
  const classifier = new RelationshipClassifier(workingTreeFiles(root, currentFiles));
  return {
    cwd,
    root,
    settings,
    history,
    model,
    currentFiles,
    classifier,
    thresholds: { minShared: settings.minShared, minConfidence: settings.minConfidence },
    warnings,
  };
}

/** Converts a user-supplied path (relative to cwd, or absolute) to a repo-relative POSIX path. */
export function toRepoPath(ctx: Pick<Context, 'cwd' | 'root'>, input: string): string {
  const absolute = realpathLenient(isAbsolute(input) ? input : resolve(ctx.cwd, input));
  const rel = relative(realpathLenient(ctx.root), absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
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
