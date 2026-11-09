import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CACHE_INDEX_FILE,
  CacheRecordError,
  decodeScannedLine,
  gitVersion,
  listReachable,
  parseCachedRecord,
  scanCachedCommits,
  writeCache,
} from '../git/cache.js';
import { listLogHashes, readCommitsByHash, readLog, type LogOptions, type RawCommit } from '../git/log.js';
import { hasParentCommit } from '../git/repo.js';
import { GitError } from '../git/run.js';
import { PathMatcher } from '../util/glob.js';
import {
  createOriginClassifier,
  isHumanAuthorIdentity,
  type CommitOrigin,
  type OriginClassifier,
  type OriginConfig,
} from './origin.js';
import {
  loadCommitTreeMailmap,
  loadWorkingTreeMailmap,
  type Mailmap,
} from './owners.js';

export interface CommitFileChange {
  /** First letter of git's name-status code in this commit (A, M, D, R, C, T, etc.). */
  status: string;
  /** Historical path in this commit (the post-change path for renames and copies). */
  path: string;
  /** Previous path in this commit when status is R or C. */
  oldPath?: string;
}

export interface HistoryCommit {
  hash: string;
  /** Position in git log output (0 is newest), used when timestamps tie. */
  logOrder?: number;
  author: string;
  /** Normalized author email when present in git log, used for same-author matching. */
  authorEmail?: string;
  /** Raw unmapped git author name (`%an`), preserved for ownership attribution. */
  rawAuthorName?: string;
  /** Raw unmapped git author email (`%ae`, lower-cased), preserved for GitHub noreply login inference. */
  rawAuthorEmail?: string;
  /** Mailmap-canonicalized author name at the analyzed revision, used for contributor aggregation. */
  canonicalAuthor?: string;
  /** Mailmap-canonicalized author email (lower-cased) at the analyzed revision, used for contributor aggregation. */
  canonicalEmail?: string;
  /** True when the commit's author identity (raw and mailmapped) is human rather than a bot or non-human coding agent. */
  humanAuthor?: boolean;
  /** Author time, for display ("last changed together 18 days ago"). */
  time: number;
  /** Committer time, for chronological ordering (backtests). */
  commitTime: number;
  subject: string;
  /** Commit origin classification ("human" | "agent" | "bot"). */
  origin?: CommitOrigin;
  /**
   * Files in this commit, under their current (latest) names, after ignores.
   * Files that were later deleted and replaced carry a lifetime suffix (see pathOf).
   */
  files: string[];
  /** File identities deleted by this commit, used to replay historical availability. */
  deleted?: string[];
  /** Per-identity historical path and change status in this commit. */
  changesByIdentity?: Record<string, CommitFileChange>;
}

export interface HistoryStats {
  /** Non-merge commits git returned. */
  commitsRead: number;
  /** Commits skipped because they touched more than maxFilesPerCommit files (sweeps). */
  sweepsSkipped: number;
  /** Commits skipped because their subject matched skipCommits. */
  subjectSkipped: number;
  /** Commits skipped because their subject matched a mechanical git revert or reapply pattern. */
  revertsSkipped: number;
  /** Commits skipped because every file they touched was ignored. */
  emptyAfterIgnores: number;
  renamesFollowed: number;
  /** True when git had additional older commits beyond `maxCommits`. */
  truncated?: boolean;
  /** True when `since` excluded older commits in the repository. */
  truncatedBySince?: boolean;
  oldestTime?: number;
  newestTime?: number;
  /** Committer timestamp of the analyzed head/baseline tip commit (used as the lookback reference time). */
  referenceCommitTime?: number;
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
  /** Historical rename paths mapped to their latest live canonical path. */
  renames?: Record<string, string>;
  /** History cache usage for this load (absent when the caller did not configure caching). */
  cache?: HistoryCacheInfo;
}

export interface HistoryCacheInfo {
  enabled: boolean;
  /** Needed commits served from the cache. */
  hits: number;
  /** Needed commits parsed from `git log` in this run. */
  misses: number;
  /** Display path (repo-relative or `$REPO_ARCHAEOLOGY_CACHE_DIR`); never absolute. */
  dir?: string;
  /** Cache problems worth surfacing in `meta.warnings` (rebuilds, read-only shallow clones). */
  warnings: string[];
}

export interface HistoryCacheOptions {
  /** Absolute cache directory. */
  dir: string;
  /** Display path for `meta.cache.dir` and warnings. */
  display?: string;
  /** Repo-relative POSIX path when `dir` is inside the working tree outside `.git`. */
  inRepoDir?: string;
  /** When set (e.g. git-tracked files inside `inRepoDir`), the cache directory is neither read nor written. */
  unusableReason?: string;
  /** False in shallow clones: valid cached records are read, but nothing is written. */
  writable: boolean;
  /** Shallow-boundary commits (listed in `$GIT_DIR/shallow`) are always parsed fresh. */
  shallowBoundary?: ReadonlySet<string>;
  /** Tool version recorded in `index.json`. */
  raVersion: string;
}

export interface HistoryOptions extends LogOptions {
  maxFilesPerCommit: number;
  ignore: readonly string[];
  /** Commits whose subject matches are left out (e.g. formatting or release commits). */
  skipCommits?: RegExp;
  /** Leave out mechanical Revert/Reapply commits (default: true). */
  skipReverts?: boolean;
  /** Commit origin classification overrides. */
  origin?: OriginConfig;
  /** Revision-specific `.mailmap` resolver for canonical contributor identity aggregation. */
  mailmap?: Mailmap;
  /** Optional callback invoked as commits are streamed from git log. */
  onProgress?: (commitsRead: number) => void;
  /**
   * Persistent raw-commit cache. `false` disables it explicitly (reported as
   * `cache.enabled: false`); `undefined` disables it without reporting.
   */
  cache?: HistoryCacheOptions | false;
}

type BuilderOptions = Pick<
  HistoryOptions,
  'maxFilesPerCommit' | 'ignore' | 'skipCommits' | 'skipReverts' | 'origin' | 'mailmap'
>;

/** Separates a path from the lifetime marker of an earlier, deleted file at that path. */
const LIFETIME_SEPARATOR = '\u0000';

/**
 * Matches mechanical `git revert` (`Revert "<subject>"`) and `git revert` of a revert
 * (`Reapply "<subject>"`, Git 2.43+) commit subjects so a change, its revert, and a
 * subsequent reapply are not double-counted.
 */
const REVERT_COMMIT_SUBJECT = /^\s*(?:Revert|Reapply)\s+["'].+["'](?:\s*\(#\d+\))?\s*$/i;

/** The path part of a file identity (identities of earlier, deleted files carry a suffix). */
export function pathOf(identity: string): string {
  const cut = identity.indexOf(LIFETIME_SEPARATOR);
  return cut === -1 ? identity : identity.slice(0, cut);
}

/** Resolves the historical path and status of `identity` at `commit`. */
export function resolveCommitFileChange(commit: HistoryCommit, identity: string): CommitFileChange {
  const map = commit.changesByIdentity;
  if (map && Object.prototype.hasOwnProperty.call(map, identity)) {
    return map[identity]!;
  }
  const status = commit.deleted?.includes(identity) ? 'D' : 'M';
  return { status, path: pathOf(identity) };
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
  /** Historical old paths mapped to their newest observed target identity. */
  private readonly renameTargets = new Map<string, string>();
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
        if (!this.renameTargets.has(change.oldPath) && !this.usedPlain.has(change.oldPath)) {
          this.renameTargets.set(change.oldPath, names[i]!);
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

  /** Returns a map of historical pre-rename paths to their latest live canonical path. */
  latestRenames(): Record<string, string> {
    const out: Record<string, string> = Object.create(null);
    for (const [oldPath, target] of this.renameTargets.entries()) {
      const resolved = this.resolve(target);
      if (!resolved.includes(LIFETIME_SEPARATOR) && resolved !== oldPath) {
        out[oldPath] = resolved;
      }
    }
    return out;
  }

  get hasRedirects(): boolean {
    return this.redirects.size > 0;
  }
}

/** Turns raw commits (fed newest first) into analysis-ready history. */
export class HistoryBuilder {
  private readonly ignore: PathMatcher;
  private readonly classifyOrigin: OriginClassifier;
  private readonly renames = new RenameTracker();
  private readonly commits: HistoryCommit[] = [];
  private readonly excluded: HistoryCommit[] = [];
  private readonly stats: HistoryStats = {
    commitsRead: 0,
    sweepsSkipped: 0,
    subjectSkipped: 0,
    revertsSkipped: 0,
    emptyAfterIgnores: 0,
    renamesFollowed: 0,
  };

  constructor(private readonly options: BuilderOptions) {
    this.ignore = new PathMatcher(options.ignore);
    this.classifyOrigin = createOriginClassifier(options.origin);
  }

  add(commit: RawCommit): void {
    const stats = this.stats;
    const logOrder = stats.commitsRead;
    if (stats.commitsRead === 0) {
      stats.referenceCommitTime = commit.commitTime;
    }
    stats.commitsRead++;
    // Renames must be tracked even for skipped commits, or older history would be orphaned.
    const names = this.renames.apply(commit);
    const files = [...new Set(names)].filter((f) => !this.ignore.matches(pathOf(f)));
    if (files.length === 0) {
      stats.emptyAfterIgnores++;
      return;
    }
    const fileSet = new Set(files);
    const changesByIdentity: Record<string, CommitFileChange> = Object.create(null);
    commit.changes.forEach((change, index) => {
      const id = names[index]!;
      if (!fileSet.has(id)) return;
      changesByIdentity[id] = {
        status: change.status,
        path: change.path,
        ...(change.oldPath !== undefined ? { oldPath: change.oldPath } : {}),
      };
    });
    const rawName = commit.authorName.trim();
    const email = commit.authorEmail.trim().toLowerCase();
    const resolvedMailmap = this.options.mailmap
      ? this.options.mailmap.resolve(commit.authorName, commit.authorEmail)
      : {
          name: (commit.mailmapName ?? commit.authorName).trim(),
          email: (commit.mailmapEmail ?? commit.authorEmail).trim().toLowerCase(),
        };
    const origin = this.classifyOrigin(commit);
    const humanAuthor =
      origin !== 'bot' &&
      isHumanAuthorIdentity({ authorName: rawName, authorEmail: email }, this.options.origin) &&
      isHumanAuthorIdentity(
        { authorName: resolvedMailmap.name, authorEmail: resolvedMailmap.email },
        this.options.origin,
      );
    const entry: HistoryCommit = {
      hash: commit.hash,
      logOrder,
      author: commit.authorName || commit.authorEmail,
      ...(email ? { authorEmail: email } : {}),
      rawAuthorName: rawName,
      ...(email ? { rawAuthorEmail: email } : {}),
      canonicalAuthor: resolvedMailmap.name,
      ...(resolvedMailmap.email ? { canonicalEmail: resolvedMailmap.email } : {}),
      humanAuthor,
      time: commit.authorTime,
      commitTime: commit.commitTime,
      subject: commit.subject,
      origin,
      files,
      deleted: [...new Set(commit.changes.flatMap((change, index) => change.status === 'D' && fileSet.has(names[index]!) ? [names[index]!] : []))],
      changesByIdentity,
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
    if (this.options.skipReverts !== false && REVERT_COMMIT_SUBJECT.test(commit.subject)) {
      stats.revertsSkipped++;
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
        if (commit.changesByIdentity) {
          const remapped: Record<string, CommitFileChange> = Object.create(null);
          for (const [id, info] of Object.entries(commit.changesByIdentity)) {
            const resolved = this.renames.resolve(id);
            if (!Object.prototype.hasOwnProperty.call(remapped, resolved)) {
              remapped[resolved] = info;
            }
          }
          commit.changesByIdentity = remapped;
        }
      }
    }
    return {
      commits: this.commits,
      excluded: this.excluded,
      stats: this.stats,
      renames: this.renames.latestRenames(),
    };
  }
}

export function processCommits(raw: Iterable<RawCommit>, options: BuilderOptions): History {
  const builder = new HistoryBuilder(options);
  for (const commit of raw) builder.add(commit);
  return builder.finish();
}

export async function loadHistory(root: string, options: HistoryOptions): Promise<History> {
  const resolvedOptions: HistoryOptions =
    options.mailmap !== undefined
      ? options
      : {
          ...options,
          mailmap:
            options.rev !== undefined && options.rev !== 'HEAD'
              ? await loadCommitTreeMailmap(root, options.rev, undefined, options.signal)
              : loadWorkingTreeMailmap(root),
        };
  if (resolvedOptions.cache) return loadHistoryCached(root, resolvedOptions, resolvedOptions.cache);
  const history = await loadHistoryFromLog(root, resolvedOptions);
  if (resolvedOptions.cache === false) {
    history.cache = { enabled: false, hits: 0, misses: history.stats.commitsRead, warnings: [] };
  }
  return history;
}

/** Uncached path: one streaming `git log` call (unchanged behavior, used by `--no-cache`). */
async function loadHistoryFromLog(root: string, options: HistoryOptions, onRaw?: (commit: RawCommit) => void): Promise<History> {
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
      onRaw?.(commit);
      builder.add(commit);
      if (options.onProgress && (seen === 1 || seen % 100 === 0)) {
        options.onProgress(seen);
      }
    },
  );
  if (options.onProgress && seen > 0 && seen !== 1 && seen % 100 !== 0) {
    options.onProgress(limit !== undefined ? Math.min(seen, limit) : seen);
  }
  if (options.since) {
    const truncatedBySince = seen === 0 || (oldestHash !== undefined && (await hasParentCommit(root, oldestHash)));
    builder.markTruncatedBySince(truncatedBySince);
  }
  return builder.finish();
}

/**
 * Cached path. Raw commits are settings-independent, so filtering (ignores, `maxFiles`,
 * `skipCommits`) still happens in `HistoryBuilder`, after the cache.
 *
 * Cold (no usable cache): one streaming `git log` walk, exactly like `--no-cache`; the raw
 * records it yields are saved as the first segment.
 *
 * Warm:
 *   1. `git rev-list` lists the needed hashes, in exactly the order `git log` would print them.
 *   2. Hashes missing from the cache are parsed with one `git log --no-walk --stdin` call.
 *   3. Records are fed to the builder in rev-list order, then the misses are appended as a segment.
 * The cache is a content-addressed lookup, so commits that disappeared (force-push) are simply
 * never requested again.
 */
const EMPTY_SHALLOW_BOUNDARY: ReadonlySet<string> = new Set();

async function loadHistoryCached(root: string, options: HistoryOptions, cache: HistoryCacheOptions): Promise<History> {
  const gitOptions = { signal: options.signal, onSpawn: options.onSpawn };
  const warnings: string[] = [];
  const where = cache.display ? ` at ${cache.display}` : '';
  const rebuildWarning = (reason: string) =>
    cache.writable
      ? `History cache${where} was discarded and rebuilt (${reason}).`
      : `History cache${where} was ignored (${reason}).`;
  const finish = (history: History, hits: number, misses: number): History => {
    history.cache = { enabled: true, hits, misses, ...(cache.display !== undefined ? { dir: cache.display } : {}), warnings };
    return history;
  };

  if (cache.unusableReason) {
    warnings.push(`History cache${where} could not be updated (${cache.unusableReason}); results are unaffected.`);
    const history = await loadHistoryFromLog(root, options);
    return finish(history, 0, history.stats.commitsRead);
  }

  const save = async (
    version: string,
    mode: 'append' | 'rebuild',
    records: readonly RawCommit[],
    keepHashes?: readonly string[],
  ) => {
    if (options.signal?.aborted) return;
    if (!cache.writable) {
      if (records.length > 0 || mode === 'rebuild') warnings.push(CACHE_SHALLOW_WARNING);
      return;
    }
    const result = await writeCache(cache.dir, {
      mode,
      records,
      gitVersion: version,
      raVersion: cache.raVersion,
      reachable: async () => {
        const set = await listReachable(root, gitOptions);
        if (keepHashes) for (const h of keepHashes) set.add(h);
        return set;
      },
    });
    if (result.problem) warnings.push(`History cache${where} could not be updated (${result.problem}); results are unaffected.`);
  };

  // Cold fast-path: when index.json does not exist yet, run `git --version` and `git log` in parallel.
  if (!existsSync(join(cache.dir, CACHE_INDEX_FILE))) {
    const raw: RawCommit[] = [];
    const [version, history] = await Promise.all([
      gitVersion(root, gitOptions),
      loadHistoryFromLog(root, options, (commit) => raw.push(commit)),
    ]);
    await save(version, 'append', raw, raw.map((c) => c.hash));
    return finish(history, 0, raw.length);
  }

  const limit = options.maxCommits && options.maxCommits > 0 ? Math.floor(options.maxCommits) : undefined;
  const [version, listed] = await Promise.all([
    gitVersion(root, gitOptions),
    listLogHashes(root, limit !== undefined ? { ...options, maxCommits: limit + 1 } : options),
  ]);
  const seen = listed.length;
  const hashes = limit !== undefined && listed.length > limit ? listed.slice(0, limit) : listed;
  const shallowBoundary = cache.shallowBoundary ?? EMPTY_SHALLOW_BOUNDARY;

  const scanned = scanCachedCommits(cache.dir, version, hashes, shallowBoundary);
  if (scanned.kind === 'unusable') {
    warnings.push(`History cache${where} could not be updated (${scanned.reason}); results are unaffected.`);
    const history = await loadHistoryFromLog(root, options);
    return finish(history, 0, history.stats.commitsRead);
  }
  if (scanned.kind === 'invalid') warnings.push(rebuildWarning(scanned.reason));
  if (scanned.kind !== 'ok' || scanned.index.segments.every((s) => s.count === 0)) {
    const raw: RawCommit[] = [];
    const history = await loadHistoryFromLog(root, options, (commit) => raw.push(commit));
    await save(version, scanned.kind === 'invalid' ? 'rebuild' : 'append', raw, raw.map((c) => c.hash));
    return finish(history, 0, raw.length);
  }

  const missing: string[] = [];
  for (let i = 0; i < hashes.length; i++) {
    if (scanned.segOf[i] === -1) missing.push(hashes[i]!);
  }
  const parsed = new Map<string, RawCommit>();
  await readCommitsByHash(root, missing, (commit) => parsed.set(commit.hash, commit), gitOptions);

  const builder = new HistoryBuilder(options);
  let added = 0;
  try {
    for (let i = 0; i < hashes.length; i++) {
      const hash = hashes[i]!;
      const bufIdx = scanned.segOf[i]!;
      let commit: RawCommit | undefined;
      if (bufIdx >= 0) {
        const line = decodeScannedLine(scanned.buffers[bufIdx]!, scanned.startOf[i]!, scanned.endOf[i]!);
        commit = parseCachedRecord(line, hash);
      } else {
        commit = parsed.get(hash);
      }
      if (!commit) throw new GitError(`git log did not return commit ${hash.slice(0, 12)}.`);
      builder.add(commit);
      added++;
      if (options.onProgress && (added === 1 || added % 100 === 0)) options.onProgress(added);
    }
  } catch (err) {
    scanned.buffers.length = 0;
    if (!(err instanceof CacheRecordError)) throw err;
    warnings.push(rebuildWarning('a cached record is malformed'));
    const raw: RawCommit[] = [];
    const history = await loadHistoryFromLog(root, options, (commit) => raw.push(commit));
    await save(version, 'rebuild', raw, raw.map((c) => c.hash));
    return finish(history, 0, raw.length);
  }
  scanned.buffers.length = 0;

  if (limit !== undefined && seen > limit) builder.markTruncated();
  if (options.onProgress && seen > 0 && seen !== 1 && seen % 100 !== 0) {
    options.onProgress(limit !== undefined ? Math.min(seen, limit) : seen);
  }
  if (options.since) {
    const oldestHash = hashes[hashes.length - 1];
    const truncatedBySince = seen === 0 || (oldestHash !== undefined && (await hasParentCommit(root, oldestHash)));
    builder.markTruncatedBySince(truncatedBySince);
  }

  // Only commits git just parsed; in shallow clones `save` writes nothing.
  await save(version, 'append', missing.map((hash) => parsed.get(hash)!), hashes);
  return finish(builder.finish(), hashes.length - missing.length, missing.length);
}

export const CACHE_SHALLOW_WARNING =
  'History cache is read-only in a shallow clone: newly parsed commits were not saved.';
