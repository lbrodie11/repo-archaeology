import { readLog, type LogOptions, type RawCommit } from '../git/log.js';
import { PathMatcher } from '../util/glob.js';

export interface HistoryCommit {
  hash: string;
  author: string;
  /** Author time, for display ("last changed together 18 days ago"). */
  time: number;
  /** Committer time, for chronological ordering (backtests). */
  commitTime: number;
  subject: string;
  /** Files in this commit, under their current (latest) names, after ignores. */
  files: string[];
}

export interface HistoryStats {
  /** Non-merge commits git returned. */
  commitsRead: number;
  /** Commits skipped because they touched more than maxFilesPerCommit files (sweeps). */
  sweepsSkipped: number;
  /** Commits skipped because their subject matched skipCommits. */
  subjectSkipped: number;
  /** Commits skipped because every file they touched was ignored. */
  emptyAfterIgnores: number;
  renamesFollowed: number;
  oldestTime?: number;
  newestTime?: number;
}

export interface History {
  /** Commits used for analysis, newest first. */
  commits: HistoryCommit[];
  /**
   * Commits left out of the analysis (sweeps, skipped subjects), newest first.
   * Kept so a backtest can replay them: what counts as a test case must not
   * depend on the filters being evaluated.
   */
  excluded: HistoryCommit[];
  stats: HistoryStats;
}

export interface HistoryOptions extends LogOptions {
  maxFilesPerCommit: number;
  ignore: readonly string[];
  /** Commits whose subject matches are left out (e.g. formatting or release commits). */
  skipCommits?: RegExp;
}

type BuilderOptions = Pick<HistoryOptions, 'maxFilesPerCommit' | 'ignore' | 'skipCommits'>;

/**
 * Follows renames so a file keeps its identity across moves.
 *
 * Commits arrive newest first. When a commit renames OLD -> NEW, every *older*
 * commit that mentions OLD is really about the file now called NEW, so we record
 * OLD -> current(NEW). Newer commits were already processed, so a path that is
 * later reused for an unrelated file is not affected.
 */
export class RenameTracker {
  private readonly alias = new Map<string, string>();
  renames = 0;

  current(path: string): string {
    return this.alias.get(path) ?? path;
  }

  /** Returns the current names of the files in this commit and records its renames. */
  apply(commit: RawCommit): string[] {
    const files: string[] = [];
    for (const change of commit.changes) {
      const name = this.current(change.path);
      if (change.status === 'R' && change.oldPath !== undefined && change.oldPath !== change.path) {
        this.alias.set(change.oldPath, name);
        this.renames++;
      }
      files.push(name);
    }
    return files;
  }
}

/** Turns raw commits (fed newest first) into analysis-ready history. */
export class HistoryBuilder {
  private readonly ignore: PathMatcher;
  private readonly renames = new RenameTracker();
  private readonly commits: HistoryCommit[] = [];
  private readonly excluded: HistoryCommit[] = [];
  private readonly stats: HistoryStats = { commitsRead: 0, sweepsSkipped: 0, subjectSkipped: 0, emptyAfterIgnores: 0, renamesFollowed: 0 };

  constructor(private readonly options: BuilderOptions) {
    this.ignore = new PathMatcher(options.ignore);
  }

  add(commit: RawCommit): void {
    const stats = this.stats;
    stats.commitsRead++;
    // Renames must be tracked even for skipped commits, or older history would be orphaned.
    const names = this.renames.apply(commit);
    const files = [...new Set(names)].filter((f) => !this.ignore.matches(f));
    if (files.length === 0) {
      stats.emptyAfterIgnores++;
      return;
    }
    const entry: HistoryCommit = {
      hash: commit.hash,
      author: commit.authorName || commit.authorEmail,
      time: commit.authorTime,
      commitTime: commit.commitTime,
      subject: commit.subject,
      files,
    };
    if (files.length > this.options.maxFilesPerCommit) {
      stats.sweepsSkipped++;
      this.excluded.push(entry);
      return;
    }
    if (this.options.skipCommits?.test(commit.subject)) {
      stats.subjectSkipped++;
      this.excluded.push(entry);
      return;
    }
    this.commits.push(entry);
    stats.oldestTime = Math.min(stats.oldestTime ?? Infinity, commit.authorTime);
    stats.newestTime = Math.max(stats.newestTime ?? -Infinity, commit.authorTime);
  }

  finish(): History {
    this.stats.renamesFollowed = this.renames.renames;
    return { commits: this.commits, excluded: this.excluded, stats: this.stats };
  }
}

export function processCommits(raw: Iterable<RawCommit>, options: BuilderOptions): History {
  const builder = new HistoryBuilder(options);
  for (const commit of raw) builder.add(commit);
  return builder.finish();
}

export async function loadHistory(root: string, options: HistoryOptions): Promise<History> {
  const builder = new HistoryBuilder(options);
  await readLog(root, options, (commit) => builder.add(commit));
  return builder.finish();
}
