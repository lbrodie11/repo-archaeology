import { streamGitNulTokens } from './run.js';

export interface RawChange {
  /** First letter of git's name-status code: A, M, D, R, C, T, U, X, B. */
  status: string;
  /** Path after the change (the new path for renames and copies). */
  path: string;
  /** Source path for renames (R) and copies (C). */
  oldPath?: string;
}

export interface RawCommit {
  hash: string;
  authorName: string;
  authorEmail: string;
  /** Author timestamp (unix seconds): when the change was written. */
  authorTime: number;
  /** Committer timestamp (unix seconds): when it landed on this branch. */
  commitTime: number;
  subject: string;
  changes: RawChange[];
}

export interface LogOptions {
  maxCommits?: number;
  since?: string;
  rev?: string;
  topoOrder?: boolean;
  reverse?: boolean;
}

const RS = '\u001e';
const US = '\u001f';
const FORMAT = `--format=${RS}%H${US}%an${US}%ae${US}%at${US}%ct${US}%s`;

/**
 * Builds the `git log` arguments. Merge commits are skipped (their diffs repeat
 * work already counted on the branch), and `-M` turns delete+add pairs into renames.
 */
export function logArgs(options: LogOptions): string[] {
  const args = ['log', '--no-merges', '-z', '-M', '--name-status', '--no-ext-diff', FORMAT];
  if (options.topoOrder) args.push('--topo-order');
  if (options.reverse) args.push('--reverse');
  if (options.maxCommits && options.maxCommits > 0) args.push(`--max-count=${Math.floor(options.maxCommits)}`);
  if (options.since) args.push(`--since=${options.since}`);
  args.push('--end-of-options', options.rev ?? 'HEAD', '--');
  return args;
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

function parseHeader(header: string): RawCommit {
  const [hash = '', authorName = '', authorEmail = '', at = '0', ct = '0', ...subject] = header.split(US);
  return {
    hash,
    authorName,
    authorEmail,
    authorTime: Number(at) || 0,
    commitTime: Number(ct) || Number(at) || 0,
    subject: subject.join(US),
    changes: [],
  };
}

/** Streams commits newest-first (git's default order). */
export async function readLog(root: string, options: LogOptions, onCommit: (commit: RawCommit) => void): Promise<void> {
  const parser = new LogParser(onCommit);
  await streamGitNulTokens(root, logArgs(options), (token) => parser.push(token));
  parser.end();
}
