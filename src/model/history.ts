import { readLog, type LogOptions, type RawCommit } from '../git/log.js';
import { hasParentCommit } from '../git/repo.js';
import { PathMatcher } from '../util/glob.js';

export interface HistoryCommit {
  hash: string;
  /** Position in git log output (0 is newest), used when timestamps tie. */
  logOrder?: number;
  author: string;
  /** Normalized author email when present in git log, used for same-author matching. */
  authorEmail?: string;
  /** Author time, for display ("last changed together 18 days ago"). */
  time: number;
  /** Committer time, for chronological ordering (backtests). */
  commitTime: number;
  subject: string;
  /**
   * Files in this commit, under their current (latest) names, after ignores.
   * Files that were later deleted and replaced carry a lifetime suffix (see pathOf).
   */
  files: string[];
  /** File identities deleted by this commit, used to replay historical availability. */
  deleted?: string[];
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
  /** True when git had additional older commits beyond `maxCommits`. */
  truncated?: boolean;
  /** True when `since` excluded older commits in the repository. */
  truncatedBySince?: boolean;
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

/** Separates a path from the lifetime marker of an earlier, deleted file at that path. */
const LIFETIME_SEPARATOR = '\u0000';

/** The path part of a file identity (identities of earlier, deleted files carry a suffix). */
export function pathOf(identity: string): string {
  const cut = identity.indexOf(LIFETIME_SEPARATOR);
  return cut === -1 ? identity : identity.slice(0, cut);
}

/**
 * Gives every file a stable identity across its lifetime.
 *
 * Commits arrive newest first, so a change is seen before everything older than it:
 * - Rename OLD -> NEW: every older mention of OLD is the file now called NEW.
 * - A file created at PATH (added, copied, or renamed into place): every older
 *   mention of PATH is an earlier, unrelated file that was deleted, so it gets its
 *   own identity (`PATH` + NUL + n). That identity never exists in the working tree,
 *   so it never appears in results, and its history cannot leak into the new file.
 */
export class RenameTracker {
  private readonly alias = new Map<string, string>();
  /** Plain paths already used as identities, by commits newer than the current one. */
  private readonly usedPlain = new Set<string>();
  /** Identities to rewrite once the whole log has been read (see `apply`). */
  private readonly redirects = new Map<string, string>();
  private lifetimes = 0;
  renames = 0;

  current(path: string): string {
    return this.alias.get(path) ?? path;
  }

  /** Returns the identities of the files in this commit and records its renames and births. */
  apply(commit: RawCommit): string[] {
    // Resolve every name against the state *before* this commit, then update.
    const names = commit.changes.map((change) => this.current(change.path));
    commit.changes.forEach((change, i) => {
      if (names[i] === change.path) this.usedPlain.add(change.path);
    });
    for (const change of commit.changes) {
      const born = change.status === 'A' || change.status === 'C' || (change.status === 'R' && change.oldPath !== change.path);
      if (born) this.alias.set(change.path, `${change.path}${LIFETIME_SEPARATOR}${++this.lifetimes}`);
    }
    // Renames win over births: if OLD is renamed and a new OLD is added in the same
    // commit, older mentions of OLD are the file that moved.
    commit.changes.forEach((change, i) => {
      if (change.status === 'R' && change.oldPath !== undefined && change.oldPath !== change.path) {
        // Merged branches: the log is ordered by date, so a commit on a parallel branch can
        // modify OLD *after* (newer than) the rename on the main line. Git carries those
        // edits into NEW at the merge. If OLD was mentioned by newer commits and no newer
        // commit created a fresh OLD, those mentions are this file too.
        if (!this.alias.has(change.oldPath) && this.usedPlain.has(change.oldPath) && !this.redirects.has(change.oldPath)) {
          this.redirects.set(change.oldPath, names[i]!);
        }
        this.alias.set(change.oldPath, names[i]!);
        this.renames++;
      }
    });
    return names;
  }

  /** Maps identities recorded before a later-seen rename onto the renamed file. */
  resolve(identity: string): string {
    let current = identity;
    for (let hops = 0; hops < 100; hops++) {
      const next = this.redirects.get(current);
      if (next === undefined || next === current) return current;
      current = next;
    }
    return current;
  }

  get hasRedirects(): boolean {
    return this.redirects.size > 0;
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
    const logOrder = stats.commitsRead;
    stats.commitsRead++;
    // Renames must be tracked even for skipped commits, or older history would be orphaned.
    const names = this.renames.apply(commit);
    const files = [...new Set(names)].filter((f) => !this.ignore.matches(pathOf(f)));
    if (files.length === 0) {
      stats.emptyAfterIgnores++;
      return;
    }
    const email = commit.authorEmail.trim().toLowerCase();
    const entry: HistoryCommit = {
      hash: commit.hash,
      logOrder,
      author: commit.authorName || commit.authorEmail,
      ...(email ? { authorEmail: email } : {}),
      time: commit.authorTime,
      commitTime: commit.commitTime,
      subject: commit.subject,
      files,
      deleted: [...new Set(commit.changes.flatMap((change, index) => change.status === 'D' && files.includes(names[index]!) ? [names[index]!] : []))],
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

  markTruncated(): void {
    this.stats.truncated = true;
  }

  markTruncatedBySince(truncated = true): void {
    this.stats.truncatedBySince = truncated;
  }

  finish(): History {
    this.stats.renamesFollowed = this.renames.renames;
    if (this.renames.hasRedirects) {
      for (const commit of [...this.commits, ...this.excluded]) {
        commit.files = [...new Set(commit.files.map((f) => this.renames.resolve(f)))];
        // A branch-side deletion of the old path does not delete the renamed file.
        if (commit.deleted) commit.deleted = commit.deleted.filter((f) => this.renames.resolve(f) === f);
      }
    }
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
  const limit = options.maxCommits && options.maxCommits > 0 ? Math.floor(options.maxCommits) : undefined;
  let seen = 0;
  let oldestHash: string | undefined;
  await readLog(
    root,
    limit !== undefined ? { ...options, maxCommits: limit + 1 } : options,
    (commit) => {
      seen++;
      if (limit !== undefined && seen > limit) {
        builder.markTruncated();
        return;
      }
      oldestHash = commit.hash;
      builder.add(commit);
    },
  );
  if (options.since) {
    const truncatedBySince = seen === 0 || (oldestHash !== undefined && (await hasParentCommit(root, oldestHash)));
    builder.markTruncatedBySince(truncatedBySince);
  }
  return builder.finish();
}
