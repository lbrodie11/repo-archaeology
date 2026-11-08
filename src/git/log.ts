import { runGit, streamGitNulTokens, type GitSpawnObserver } from './run.js';

export interface RawChange {
  /** First letter of git's name-status code: A, M, D, R, C, T, U, X, B. */
  status: string;
  /** Path after the change (the new path for renames and copies). */
  path: string;
  /** Source path for renames (R) and copies (C). */
  oldPath?: string;
}

export interface RawTrailer {
  key: string;
  value: string;
}

export interface RawCommit {
  hash: string;
  authorName: string;
  authorEmail: string;
  /** Mailmap-canonicalized author name (`%aN`), when present in `git log`. */
  mailmapName?: string;
  /** Mailmap-canonicalized author email (`%aE`), when present in `git log`. */
  mailmapEmail?: string;
  /** Author timestamp (unix seconds): when the change was written. */
  authorTime: number;
  /** Committer timestamp (unix seconds): when it landed on this branch. */
  commitTime: number;
  subject: string;
  /** Lower-cased commit trailers (at most 20 per commit). */
  trailers: RawTrailer[];
  changes: RawChange[];
}

export interface LogOptions {
  maxCommits?: number;
  since?: string;
  rev?: string;
  topoOrder?: boolean;
  reverse?: boolean;
  signal?: AbortSignal;
  onSpawn?: GitSpawnObserver;
}

const RS = '\u001e';
const US = '\u001f';
const GS = '\u001d';
const FS = '\u001c';
export const MAX_TRAILERS_PER_COMMIT = 20;
/**
 * `%(trailers:only,unfold,separator=%x1d)` requires Git >= 2.22.0 (released June 2019).
 * Trailers are placed before `%s` so commit subjects containing control separators remain intact.
 *
 * CACHE INVARIANT: parsed `RawCommit` records are persisted by the history cache
 * (`src/git/cache.ts`). `CACHE_FORMAT_SIGNATURE` hashes `CACHE_VERSION`, `FORMAT`,
 * `DIFF_ARGS`, `MAX_TRAILERS_PER_COMMIT`, and `CONFIG_OVERRIDES` so flag/format edits
 * invalidate automatically, and any change to `LogParser` or the shape of `RawCommit` /
 * `RawChange` / `RawTrailer` MUST also bump `CACHE_VERSION` in `src/git/cache.ts`.
 * `FORMAT` uses raw `%an` / `%ae`; `.mailmap` canonicalization is applied post-cache
 * in `HistoryBuilder` so cached commit records remain immutable and working-tree-independent.
 */
export const FORMAT = `--format=${RS}%H${US}%an${US}%ae${US}%at${US}%ct${GS}%(trailers:only,unfold,separator=%x1d)${US}%s`;

/** Diff flags shared by every history read, so cached and freshly parsed records match. */
export const DIFF_ARGS: readonly string[] = Object.freeze(['-z', '-M', '--name-status', '--no-ext-diff', FORMAT]);

/**
 * Builds the `git log` arguments. Merge commits are skipped (their diffs repeat
 * work already counted on the branch), and `-M` turns delete+add pairs into renames.
 */
export function logArgs(options: LogOptions): string[] {
  const args = ['log', '--no-merges', ...DIFF_ARGS];
  if (options.topoOrder) args.push('--topo-order');
  if (options.reverse) args.push('--reverse');
  if (options.maxCommits && options.maxCommits > 0) args.push(`--max-count=${Math.floor(options.maxCommits)}`);
  if (options.since) args.push(`--since=${options.since}`);
  args.push('--end-of-options', options.rev ?? 'HEAD', '--');
  return args;
}

/**
 * Builds `git rev-list` arguments that walk exactly the commits (and order) `logArgs`
 * would print for the same options, without computing any diffs.
 */
export function revListArgs(options: LogOptions): string[] {
  const args = ['rev-list', '--no-merges'];
  if (options.topoOrder) args.push('--topo-order');
  if (options.reverse) args.push('--reverse');
  if (options.maxCommits && options.maxCommits > 0) args.push(`--max-count=${Math.floor(options.maxCommits)}`);
  if (options.since) args.push(`--since=${options.since}`);
  args.push('--end-of-options', options.rev ?? 'HEAD', '--');
  return args;
}

/**
 * `git log` arguments that print the listed commits (one hash per stdin line) with the same
 * format and diff options as `logArgs`, without walking their history. `--no-walk` shows each
 * commit against its first parent, exactly as it appears inside a normal walk.
 */
export function logByHashArgs(): string[] {
  return ['log', '--no-walk=unsorted', ...DIFF_ARGS, '--stdin'];
}

/**
 * Incremental parser for `git log -z --name-status` output, fed one NUL-delimited
 * token at a time. Layout per commit:
 *   RS header NUL  ("\n" STATUS NUL PATH NUL | STATUS NUL OLD NUL NEW NUL)*
 */
export class LogParser {
  private current: RawCommit | null = null;
  private pending: { status: string; needed: number; paths: string[] } | null = null;

  constructor(private readonly onCommit: (commit: RawCommit) => void) {}

  push(token: string): void {
    if (this.pending) {
      this.pending.paths.push(token);
      if (this.pending.paths.length === this.pending.needed) this.flushChange();
      return;
    }
    const trimmed = token.replace(/^\n+/, '');
    if (trimmed.startsWith(RS)) {
      this.flushCommit();
      this.current = parseHeader(trimmed.slice(1));
      return;
    }
    if (trimmed === '' || !this.current) return;
    const status = trimmed[0]!;
    this.pending = { status, needed: status === 'R' || status === 'C' ? 2 : 1, paths: [] };
  }

  end(): void {
    this.pending = null;
    this.flushCommit();
  }

  private flushChange(): void {
    const p = this.pending!;
    this.pending = null;
    if (!this.current) return;
    if (p.needed === 2) {
      this.current.changes.push({ status: p.status, oldPath: p.paths[0]!, path: p.paths[1]! });
    } else {
      this.current.changes.push({ status: p.status, path: p.paths[0]! });
    }
  }

  private flushCommit(): void {
    if (this.current) this.onCommit(this.current);
    this.current = null;
  }
}

export function parseTrailers(rawTrailers: readonly string[]): RawTrailer[] {
  const trailers: RawTrailer[] = [];
  for (const raw of rawTrailers) {
    if (trailers.length >= MAX_TRAILERS_PER_COMMIT) break;
    const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ').trim();
    if (!unfolded) continue;
    for (const line of unfolded.split(/\r?\n/)) {
      if (trailers.length >= MAX_TRAILERS_PER_COMMIT) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      const colon = trimmed.indexOf(':');
      if (colon <= 0) continue;
      const key = trimmed.slice(0, colon).trim().toLowerCase();
      if (!key) continue;
      const value = trimmed.slice(colon + 1).trim();
      trailers.push({ key, value });
    }
  }
  return trailers;
}

function parseHeader(header: string): RawCommit {
  const [hash = '', rawNameField = '', rawEmailField = '', at = '0', ctAndTrailers = '0', ...subject] = header.split(US);
  const [authorName = '', mailmapName] = rawNameField.split(FS);
  const [authorEmail = '', mailmapEmail] = rawEmailField.split(FS);
  const [ct = '0', ...rawTrailerParts] = ctAndTrailers.split(GS);
  return {
    hash,
    authorName,
    authorEmail,
    ...(mailmapName !== undefined ? { mailmapName } : {}),
    ...(mailmapEmail !== undefined ? { mailmapEmail } : {}),
    authorTime: Number(at) || 0,
    commitTime: Number(ct) || Number(at) || 0,
    subject: subject.join(US),
    trailers: parseTrailers(rawTrailerParts),
    changes: [],
  };
}

/** Streams commits newest-first (git's default order). */
export async function readLog(root: string, options: LogOptions, onCommit: (commit: RawCommit) => void): Promise<void> {
  const parser = new LogParser(onCommit);
  await streamGitNulTokens(root, logArgs(options), (token) => parser.push(token), {
    signal: options.signal,
    onSpawn: options.onSpawn,
  });
  parser.end();
}

/** Lists the hashes `readLog` would visit for `options`, in the same order. */
export async function listLogHashes(root: string, options: LogOptions): Promise<string[]> {
  const out = await runGit(root, revListArgs(options), { signal: options.signal, onSpawn: options.onSpawn });
  return out.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

/** Parses specific commits by hash with one `git log --no-walk --stdin` call (order not guaranteed). */
export async function readCommitsByHash(
  root: string,
  hashes: readonly string[],
  onCommit: (commit: RawCommit) => void,
  options?: Pick<LogOptions, 'signal' | 'onSpawn'>,
): Promise<void> {
  if (hashes.length === 0) return;
  const parser = new LogParser(onCommit);
  await streamGitNulTokens(root, logByHashArgs(), (token) => parser.push(token), {
    signal: options?.signal,
    onSpawn: options?.onSpawn,
    input: `${hashes.join('\n')}\n`,
  });
  parser.end();
}
