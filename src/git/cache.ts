import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DIFF_ARGS, FORMAT, MAX_TRAILERS_PER_COMMIT, type RawCommit } from './log.js';
import { CONFIG_OVERRIDES, runGit, type GitRunOptions } from './run.js';

/**
 * Version of the on-disk record format. Bump it whenever `RawCommit`, `RawChange`,
 * `RawTrailer`, `FORMAT`, `logArgs`/`logByHashArgs`, or `LogParser` change (see the note
 * next to `FORMAT` in `src/git/log.ts`). A mismatch discards and rebuilds the cache.
 */
export const CACHE_VERSION = 1;
/**
 * Deterministic fingerprint of the Git log format, diff flags, trailer cap, and Git config
 * overrides that determine `RawCommit` contents. Any change to these inputs invalidates
 * existing caches automatically without relying solely on manual `CACHE_VERSION` bumps,
 * while `raVersion` patch bumps that do not alter raw parsing keep the cache warm.
 */
export const CACHE_FORMAT_SIGNATURE = createHash('sha256')
  .update(
    JSON.stringify({
      cacheVersion: CACHE_VERSION,
      format: FORMAT,
      diffArgs: DIFF_ARGS,
      maxTrailers: MAX_TRAILERS_PER_COMMIT,
      configOverrides: CONFIG_OVERRIDES,
    }),
  )
  .digest('hex')
  .slice(0, 16);

export const CACHE_DIR_ENV = 'REPO_ARCHAEOLOGY_CACHE_DIR';
/** Shown in `meta.cache.dir` instead of the (absolute) directory when set by the env var. */
export const CACHE_DIR_ENV_DISPLAY = '$REPO_ARCHAEOLOGY_CACHE_DIR';
export const MAX_CACHE_SEGMENTS = 20;
export const MAX_CACHE_BYTES = 200 * 1024 * 1024;
export const CACHE_LOCK_STALE_MS = 60_000;
export const MAX_INDEX_BYTES = 1024 * 1024;
export const MAX_INDEX_SEGMENTS = 1000;
export const MAX_SEGMENT_RECORDS = 500_000;
export const MAX_SEGMENT_BYTES = 512 * 1024 * 1024;
const HEADER_CHECKSUM_BYTES = 64 * 1024;
const PREFIX_READ_THRESHOLD_BYTES = 512 * 1024;
const PREFIX_READ_CHUNK_BYTES = 256 * 1024;

export const CACHE_INDEX_FILE = 'index.json';
export const CACHE_LOCK_FILE = 'lock';
export const CACHE_GITIGNORE_FILE = '.gitignore';
const CACHE_GITIGNORE_CONTENT = '*\n';
/**
 * Cache Directory Tagging Specification marker (https://bford.info/cachedir/). The cache only
 * creates, overwrites, or deletes files in a directory that carries this tag (or that it
 * created empty), so a mistyped `cache.dir` can never clobber unrelated files.
 */
export const CACHE_TAG_FILE = 'CACHEDIR.TAG';
const CACHE_TAG_SIGNATURE = 'Signature: 8a477f597d28d172789f06886806bc55';
const CACHE_TAG_CONTENT =
  `${CACHE_TAG_SIGNATURE}\n` +
  '# This file is a cache directory tag created by repo-archaeology (history cache).\n' +
  '# For information about cache directory tags see https://bford.info/cachedir/\n';

const SEGMENT_FILE = /^commits-(\d+)\.jsonl$/;
const HASH = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RECORD_PREFIX = '{"hash":"';
const RECORD_PREFIX_BYTES = Buffer.from(RECORD_PREFIX, 'latin1');

export interface CacheSettings {
  /** Cache directory. Relative paths resolve against the repository root. */
  dir?: string;
  /** Set to false to neither read nor write the cache. */
  enabled?: boolean;
}

export interface CacheSegment {
  file: string;
  count: number;
  sha256: string;
  /** Byte length of the segment file (for O(1) truncation checks during partial prefix reads). */
  bytes?: number;
  /** SHA-256 of the first 64 KB of the segment file (verified during partial prefix reads). */
  headSha256?: string;
}

export interface CacheIndex {
  cacheVersion: number;
  raVersion: string;
  /** `git --version` that produced the records; rename detection can differ between versions. */
  gitVersion: string;
  /** Fingerprint of `FORMAT`, `DIFF_ARGS`, `MAX_TRAILERS_PER_COMMIT`, and `CONFIG_OVERRIDES`. */
  formatSignature?: string;
  createdAt: string;
  segments: CacheSegment[];
}

export interface CacheLocation {
  enabled: boolean;
  /** Absolute cache directory (never serialized). */
  dir?: string;
  /** Repo-relative POSIX path, or `$REPO_ARCHAEOLOGY_CACHE_DIR`; omitted when neither is possible. */
  display?: string;
  /** Repo-relative POSIX path when the cache directory is inside the working tree outside `.git`. */
  inRepoDir?: string;
}

export type CacheLoad =
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'unusable'; reason: string }
  | { kind: 'ok'; index: CacheIndex; lines: Map<string, string>; bytes: number };

/**
 * Verifies that no existing path component of `relDir` under `root` is a symbolic link,
 * preventing an untrusted `.repo-archaeology.json` from redirecting cache reads/writes
 * outside the repository via a committed symlink.
 */
export function hasSymlinkInRepoPath(root: string, relDir: string): boolean {
  const cleanRoot = resolve(root);
  const parts = relDir.split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
  let cursor = cleanRoot;
  for (const part of parts) {
    cursor = join(cursor, part);
    const stat = lstatSync(cursor, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) return true;
  }
  return false;
}

function inWorkingTreeRelative(root: string, dir: string): string | undefined {
  const rel = displayPath(root, dir);
  if (!rel || rel === '.' || rel.startsWith('../') || rel === '..' || rel === '.git' || rel.startsWith('.git/')) {
    return undefined;
  }
  return rel;
}

/**
 * Checks whether Git tracks any file inside `relDir` (in the index or `HEAD`), so committed
 * files inside a repo-configured `cache.dir` can never be trusted as cache records.
 */
export async function hasTrackedCacheFiles(root: string, relDir: string, options?: GitRunOptions): Promise<boolean> {
  const [inIndex, inHead] = await Promise.all([
    runGit(root, ['ls-files', '-z', '--', relDir], options).catch(() => ''),
    runGit(root, ['ls-tree', '-r', '-z', 'HEAD', '--', relDir], options).catch(() => ''),
  ]);
  return inIndex.length > 0 || inHead.length > 0;
}

/**
 * Resolves the cache directory. Precedence: explicit flag/API `dir` > `REPO_ARCHAEOLOGY_CACHE_DIR`
 * > `.repo-archaeology.json` `cache.dir` > `<git-common-dir>/repo-archaeology/cache/`.
 * `enabled: false` from flags (`--no-cache`) or the config file disables the cache.
 */
export async function resolveCacheLocation(
  root: string,
  input: { file?: CacheSettings; flags?: CacheSettings; env?: Record<string, string | undefined>; signal?: AbortSignal },
): Promise<CacheLocation> {
  const enabled = input.flags?.enabled ?? input.file?.enabled ?? true;
  if (enabled === false) return { enabled: false };
  if (input.flags?.dir) {
    const dir = resolve(root, input.flags.dir);
    return { enabled: true, dir, display: displayPath(root, dir), inRepoDir: inWorkingTreeRelative(root, dir) };
  }
  const envDir = input.env?.[CACHE_DIR_ENV]?.trim();
  if (envDir) {
    const dir = resolve(envDir);
    return { enabled: true, dir, display: CACHE_DIR_ENV_DISPLAY, inRepoDir: inWorkingTreeRelative(root, dir) };
  }
  if (input.file?.dir && !hasSymlinkInRepoPath(root, input.file.dir)) {
    const dir = resolve(root, input.file.dir);
    return { enabled: true, dir, display: displayPath(root, dir), inRepoDir: inWorkingTreeRelative(root, dir) };
  }
  // Fast path for standard repositories where `<root>/.git` is a directory (no worktree `commondir`).
  const dotGit = join(resolve(root), '.git');
  const dotGitStat = lstatSync(dotGit, { throwIfNoEntry: false });
  if (dotGitStat?.isDirectory() && !existsSync(join(dotGit, 'commondir'))) {
    const dir = join(dotGit, 'repo-archaeology', 'cache');
    return { enabled: true, dir, display: displayPath(root, dir) };
  }
  // Linked worktrees use `--git-common-dir` so every worktree shares one cache.
  const common = (await runGit(root, ['rev-parse', '--git-common-dir'], { signal: input.signal })).trim();
  const dir = join(resolve(root, common), 'repo-archaeology', 'cache');
  return { enabled: true, dir, display: displayPath(root, dir) };
}

function displayPath(root: string, dir: string): string | undefined {
  const rel = relative(root, dir);
  if (rel === '') return '.';
  if (isAbsolute(rel)) return undefined; // e.g. another drive on Windows: never leak an absolute path
  return rel.split(sep).join('/');
}

/** Commits listed in `$GIT_DIR/shallow`: git reports them as root commits, so their diffs are incomplete. */
export async function readShallowBoundary(root: string, options?: GitRunOptions): Promise<Set<string>> {
  try {
    const file = resolve(root, (await runGit(root, ['rev-parse', '--git-path', 'shallow'], options)).trim());
    return new Set(readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => HASH.test(l)));
  } catch {
    return new Set();
  }
}

const gitVersions = new Map<string, Promise<string>>();
export function gitVersion(root: string, options?: GitRunOptions): Promise<string> {
  // One git binary per process in practice; keyed by root only to stay correct if PATH differs.
  let pending = gitVersions.get(root);
  if (!pending) {
    pending = runGit(root, ['--version'], options).then((v) => v.trim());
    pending.catch(() => gitVersions.delete(root));
    gitVersions.set(root, pending);
  }
  return pending;
}

/** Lists every commit reachable from any ref (used to prune the cache during compaction). */
export async function listReachable(root: string, options?: GitRunOptions): Promise<Set<string>> {
  const out = await runGit(root, ['rev-list', '--all'], options);
  return new Set(out.split('\n').map((l) => l.trim()).filter((l) => l !== ''));
}

// ---- reading -----------------------------------------------------------------

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code;
}

function parseIndex(text: string): CacheIndex | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return 'index.json is not valid JSON';
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'index.json is malformed';
  const obj = raw as Record<string, unknown>;
  if (obj.cacheVersion !== CACHE_VERSION) {
    return `cache version ${JSON.stringify(obj.cacheVersion)} does not match ${CACHE_VERSION}`;
  }
  if (obj.formatSignature !== undefined && obj.formatSignature !== CACHE_FORMAT_SIGNATURE) {
    return 'the log parser format or git diff configuration changed';
  }
  if (typeof obj.raVersion !== 'string' || typeof obj.gitVersion !== 'string' || typeof obj.createdAt !== 'string') {
    return 'index.json is malformed';
  }
  if (!Array.isArray(obj.segments)) return 'index.json is malformed';
  if (obj.segments.length > MAX_INDEX_SEGMENTS) return 'index.json has too many segments';
  const segments: CacheSegment[] = [];
  const seen = new Set<string>();
  for (const seg of obj.segments as unknown[]) {
    if (typeof seg !== 'object' || seg === null) return 'index.json is malformed';
    const s = seg as Record<string, unknown>;
    if (
      typeof s.file !== 'string' ||
      !SEGMENT_FILE.test(s.file) ||
      seen.has(s.file) ||
      typeof s.count !== 'number' ||
      !Number.isInteger(s.count) ||
      s.count < 0 ||
      s.count > MAX_SEGMENT_RECORDS ||
      typeof s.sha256 !== 'string' ||
      !SHA256.test(s.sha256) ||
      (s.bytes !== undefined &&
        (typeof s.bytes !== 'number' || !Number.isInteger(s.bytes) || s.bytes < 0 || s.bytes > MAX_SEGMENT_BYTES)) ||
      (s.headSha256 !== undefined && (typeof s.headSha256 !== 'string' || !SHA256.test(s.headSha256)))
    ) {
      return 'index.json is malformed';
    }
    seen.add(s.file);
    segments.push({
      file: s.file,
      count: s.count,
      sha256: s.sha256,
      ...(s.bytes !== undefined ? { bytes: s.bytes } : {}),
      ...(s.headSha256 !== undefined ? { headSha256: s.headSha256 } : {}),
    });
  }
  return {
    cacheVersion: CACHE_VERSION,
    raVersion: obj.raVersion,
    gitVersion: obj.gitVersion,
    formatSignature: CACHE_FORMAT_SIGNATURE,
    createdAt: obj.createdAt,
    segments,
  };
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function computeHeadSha256(fullSha256: string, data: Buffer): string {
  return createHash('sha256')
    .update(fullSha256)
    .update(data.subarray(0, Math.min(data.length, HEADER_CHECKSUM_BYTES)))
    .digest('hex');
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Extracts the hash from a record line without parsing the whole record. */
function lineHash(line: string): string | undefined {
  if (!line.startsWith(RECORD_PREFIX)) return undefined;
  const end = line.indexOf('"', RECORD_PREFIX.length);
  if (end === -1) return undefined;
  const hash = line.slice(RECORD_PREFIX.length, end);
  return HASH.test(hash) ? hash : undefined;
}

function isHexRange(buf: Buffer, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const b = buf[i]!;
    if (!((b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66))) return false;
  }
  return true;
}

/** Extracts and validates the commit hash at `lineStart..lineEnd` in `buf` without decoding the line. */
function bufferLineHashEnd(buf: Buffer, lineStart: number, lineEnd: number): number {
  const hashStart = lineStart + RECORD_PREFIX_BYTES.length;
  if (lineEnd <= hashStart + 40) return -1;
  if (buf.compare(RECORD_PREFIX_BYTES, 0, RECORD_PREFIX_BYTES.length, lineStart, hashStart) !== 0) return -1;
  const end40 = hashStart + 40;
  if (buf[end40] === 0x22 && isHexRange(buf, hashStart, end40)) return end40;
  const end64 = hashStart + 64;
  if (lineEnd > end64 && buf[end64] === 0x22 && isHexRange(buf, hashStart, end64)) return end64;
  return -1;
}

const TEMP_FILE = /^\.(commits-\d+\.jsonl|index\.json|CACHEDIR\.TAG|\.gitignore)\.tmp-/;

/**
 * Verifies that `dir` is a safe repo-archaeology cache directory before reading any files from it.
 * A non-empty directory without a regular, valid `CACHEDIR.TAG` or containing any symbolic link is
 * reported as `unusable` so untrusted or foreign files are never read as cache records.
 */
function verifyCacheDirectory(dir: string): { kind: 'ok' } | { kind: 'missing' } | { kind: 'unusable'; reason: string } {
  const dirStat = lstatSync(dir, { throwIfNoEntry: false });
  if (!dirStat) return { kind: 'missing' };
  if (!dirStat.isDirectory()) return { kind: 'unusable', reason: 'the cache path is not a directory' };

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return { kind: 'missing' };
    return { kind: 'unusable', reason: `the cache directory could not be read (${(err as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  for (const entry of entries) {
    const entryStat = lstatSync(join(dir, entry), { throwIfNoEntry: false });
    if (entryStat?.isSymbolicLink()) {
      return { kind: 'unusable', reason: 'the cache directory contains a symbolic link' };
    }
  }

  const tagPath = join(dir, CACHE_TAG_FILE);
  const tagStat = lstatSync(tagPath, { throwIfNoEntry: false });
  if (!tagStat) {
    const nonMeta = entries.filter((e) => e !== CACHE_LOCK_FILE && e !== CACHE_GITIGNORE_FILE && !TEMP_FILE.test(e));
    if (nonMeta.length > 0) {
      return { kind: 'unusable', reason: 'the directory is not empty and is not a repo-archaeology cache' };
    }
    return { kind: 'missing' };
  }
  if (!tagStat.isFile()) {
    return { kind: 'unusable', reason: 'CACHEDIR.TAG is not a regular file' };
  }
  let tagText: string;
  try {
    tagText = readFileSync(tagPath, 'utf8');
  } catch {
    return { kind: 'unusable', reason: 'CACHEDIR.TAG could not be read' };
  }
  if (!tagText.startsWith(CACHE_TAG_SIGNATURE)) {
    return { kind: 'unusable', reason: 'the directory is not empty and is not a repo-archaeology cache' };
  }
  return { kind: 'ok' };
}

function readVerifiedIndex(
  dir: string,
  expectedGitVersion: string,
): { kind: 'ok'; index: CacheIndex } | { kind: 'missing' } | { kind: 'invalid'; reason: string } | { kind: 'unusable'; reason: string } {
  const dirCheck = verifyCacheDirectory(dir);
  if (dirCheck.kind !== 'ok') return dirCheck;

  const indexPath = join(dir, CACHE_INDEX_FILE);
  let indexText: string;
  try {
    const stat = lstatSync(indexPath);
    if (!stat.isFile()) return { kind: 'invalid', reason: 'index.json is not a regular file' };
    if (stat.size > MAX_INDEX_BYTES) return { kind: 'invalid', reason: 'index.json exceeds maximum size' };
    indexText = readFileSync(indexPath, 'utf8');
  } catch (err) {
    if (isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR')) return { kind: 'missing' };
    return { kind: 'invalid', reason: `index.json could not be read (${(err as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  const index = parseIndex(indexText);
  if (typeof index === 'string') return { kind: 'invalid', reason: index };
  if (index.gitVersion !== expectedGitVersion) return { kind: 'invalid', reason: 'the git version changed' };
  return { kind: 'ok', index };
}

type LoadAttempt = CacheLoad | { kind: 'retry' };

function loadOnce(dir: string, expectedGitVersion: string): LoadAttempt {
  const header = readVerifiedIndex(dir, expectedGitVersion);
  if (header.kind !== 'ok') return header;
  const { index } = header;
  const lines = new Map<string, string>();
  let bytes = 0;
  // Iterate newest-to-oldest so `lines` preserves newest-first order across segments.
  for (let s = index.segments.length - 1; s >= 0; s--) {
    const seg = index.segments[s]!;
    const segPath = join(dir, seg.file);
    let data: Buffer;
    try {
      const segStat = lstatSync(segPath);
      if (!segStat.isFile()) return { kind: 'invalid', reason: `${seg.file} is not a regular file` };
      if (segStat.size > MAX_SEGMENT_BYTES) return { kind: 'invalid', reason: `${seg.file} exceeds maximum segment size` };
      data = readFileSync(segPath);
    } catch (err) {
      // A concurrent compaction may have replaced the index after we read it: re-read once.
      if (isErrno(err, 'ENOENT')) return { kind: 'retry' };
      return { kind: 'invalid', reason: `${seg.file} could not be read` };
    }
    bytes += data.length;
    if (sha256(data) !== seg.sha256) return { kind: 'invalid', reason: `checksum mismatch in ${seg.file}` };
    const segLines = splitLines(data.toString('utf8'));
    if (segLines.length !== seg.count) return { kind: 'invalid', reason: `${seg.file} has the wrong number of records` };
    for (const line of segLines) {
      const hash = lineHash(line);
      if (hash === undefined) return { kind: 'invalid', reason: `${seg.file} contains a malformed record` };
      if (!lines.has(hash)) lines.set(hash, line); // duplicates across segments are harmless: first wins
    }
  }
  return { kind: 'ok', index, lines, bytes };
}

/** Loads and verifies every segment. Never throws for cache problems; reports them as `invalid` or `unusable`. */
export function loadCache(dir: string, expectedGitVersion: string): CacheLoad {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = loadOnce(dir, expectedGitVersion);
    if (result.kind !== 'retry') return result;
  }
  return { kind: 'invalid', reason: 'a cache segment is missing' };
}

export type CacheScanResult =
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'unusable'; reason: string }
  | {
      kind: 'ok';
      index: CacheIndex;
      buffers: Uint8Array[];
      segOf: Int32Array;
      startOf: Int32Array;
      endOf: Int32Array;
      hits: number;
    };

export function decodeScannedLine(buf: Uint8Array, start: number, end: number): string {
  return (buf as Buffer).toString('utf8', start, end);
}

type ScanAttempt = CacheScanResult | { kind: 'retry' };

function scanBufferLines(
  buf: Buffer,
  limit: number,
  bufIdx: number,
  indexByHash: ReadonlyMap<string, number>,
  segOf: Int32Array,
  startOf: Int32Array,
  endOf: Int32Array,
  currentHits: number,
  neededCount: number,
  stopEarly: boolean,
): { hits: number; linesSeen: number; malformed: boolean } {
  const hashOffset = RECORD_PREFIX_BYTES.length;
  let hits = currentHits;
  let linesSeen = 0;
  let lineStart = 0;
  while (lineStart < limit) {
    const nl = buf.indexOf(0x0a, lineStart);
    if (nl === -1 || nl >= limit) return { hits, linesSeen, malformed: true };
    const hashEnd = bufferLineHashEnd(buf, lineStart, nl);
    if (hashEnd === -1) return { hits, linesSeen, malformed: true };
    linesSeen++;
    const hash = buf.toString('latin1', lineStart + hashOffset, hashEnd);
    const idx = indexByHash.get(hash);
    if (idx !== undefined && segOf[idx] === -1) {
      segOf[idx] = bufIdx;
      startOf[idx] = lineStart;
      endOf[idx] = nl;
      hits++;
      if (stopEarly && hits === neededCount) {
        return { hits, linesSeen, malformed: false };
      }
    }
    lineStart = nl + 1;
  }
  return { hits, linesSeen, malformed: false };
}

function scanCachedCommitsOnce(
  dir: string,
  expectedGitVersion: string,
  hashes: readonly string[],
  shallowBoundary: ReadonlySet<string>,
): ScanAttempt {
  const header = readVerifiedIndex(dir, expectedGitVersion);
  if (header.kind !== 'ok') return header;
  const { index } = header;

  const segOf = new Int32Array(hashes.length).fill(-1);
  const startOf = new Int32Array(hashes.length);
  const endOf = new Int32Array(hashes.length);
  const buffers: Buffer[] = [];

  const indexByHash = new Map<string, number>();
  for (let i = 0; i < hashes.length; i++) {
    const h = hashes[i]!;
    if (!shallowBoundary.has(h)) indexByHash.set(h, i);
  }
  const neededCount = indexByHash.size;
  if (neededCount === 0) {
    return { kind: 'ok', index, buffers, segOf, startOf, endOf, hits: 0 };
  }

  let hits = 0;
  for (let s = index.segments.length - 1; s >= 0 && hits < neededCount; s--) {
    const seg = index.segments[s]!;
    const segPath = join(dir, seg.file);
    let segStat;
    try {
      segStat = lstatSync(segPath);
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return { kind: 'retry' };
      return { kind: 'invalid', reason: `${seg.file} could not be read` };
    }
    if (!segStat.isFile()) return { kind: 'invalid', reason: `${seg.file} is not a regular file` };
    if (segStat.size > MAX_SEGMENT_BYTES) return { kind: 'invalid', reason: `${seg.file} exceeds maximum segment size` };
    if (seg.bytes !== undefined && segStat.size !== seg.bytes) {
      return { kind: 'invalid', reason: `checksum mismatch in ${seg.file}` };
    }

    const canPrefixRead =
      seg.bytes !== undefined &&
      seg.headSha256 !== undefined &&
      segStat.size >= PREFIX_READ_THRESHOLD_BYTES &&
      neededCount - hits < seg.count;

    if (canPrefixRead) {
      let fd: number;
      try {
        fd = openSync(segPath, 'r');
      } catch (err) {
        if (isErrno(err, 'ENOENT')) return { kind: 'retry' };
        return { kind: 'invalid', reason: `${seg.file} could not be read` };
      }
      try {
        let fileOffset = 0;
        let chunkSize = PREFIX_READ_CHUNK_BYTES;
        let linesSeenTotal = 0;
        while (fileOffset < segStat.size && hits < neededCount) {
          const toRead = Math.min(chunkSize, segStat.size - fileOffset);
          const chunk = Buffer.allocUnsafe(toRead);
          let bytesRead = 0;
          while (bytesRead < toRead) {
            const n = readSync(fd, chunk, bytesRead, toRead - bytesRead, fileOffset + bytesRead);
            if (n === 0) break;
            bytesRead += n;
          }
          if (bytesRead !== toRead) return { kind: 'invalid', reason: `checksum mismatch in ${seg.file}` };
          if (fileOffset === 0) {
            if (computeHeadSha256(seg.sha256, chunk) !== seg.headSha256) {
              return { kind: 'invalid', reason: `checksum mismatch in ${seg.file}` };
            }
          }
          const isEof = fileOffset + bytesRead === segStat.size;
          const lastNl = isEof ? bytesRead - 1 : chunk.lastIndexOf(0x0a);
          if (lastNl === -1) {
            chunkSize *= 2;
            if (chunkSize > MAX_SEGMENT_BYTES) return { kind: 'invalid', reason: `${seg.file} contains a malformed record` };
            continue;
          }
          if (chunk[lastNl] !== 0x0a) return { kind: 'invalid', reason: `${seg.file} contains a malformed record` };
          const validEnd = lastNl + 1;
          const bufIdx = buffers.length;
          buffers.push(chunk);
          const scanned = scanBufferLines(chunk, validEnd, bufIdx, indexByHash, segOf, startOf, endOf, hits, neededCount, true);
          if (scanned.malformed) return { kind: 'invalid', reason: `${seg.file} contains a malformed record` };
          hits = scanned.hits;
          linesSeenTotal += scanned.linesSeen;
          fileOffset += validEnd;
        }
        if (fileOffset === segStat.size && hits < neededCount && linesSeenTotal !== seg.count) {
          return { kind: 'invalid', reason: `${seg.file} has the wrong number of records` };
        }
      } finally {
        closeSync(fd);
      }
      continue;
    }

    let data: Buffer;
    try {
      data = readFileSync(segPath);
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return { kind: 'retry' };
      return { kind: 'invalid', reason: `${seg.file} could not be read` };
    }
    if (sha256(data) !== seg.sha256) return { kind: 'invalid', reason: `checksum mismatch in ${seg.file}` };
    const bufIdx = buffers.length;
    buffers.push(data);
    const scanned = scanBufferLines(data, data.length, bufIdx, indexByHash, segOf, startOf, endOf, hits, neededCount, false);
    if (scanned.malformed) return { kind: 'invalid', reason: `${seg.file} contains a malformed record` };
    if (scanned.linesSeen !== seg.count) return { kind: 'invalid', reason: `${seg.file} has the wrong number of records` };
    hits = scanned.hits;
  }

  return { kind: 'ok', index, buffers, segOf, startOf, endOf, hits };
}

/**
 * Scans cached segments for `hashes` (newest segment first), recording byte offsets into segment
 * `Buffer`s so only the requested commits are decoded and JSON-parsed. Large segments (`>= 512 KB`)
 * use chunked prefix reads when `hashes.length < seg.count`, keeping warm runs `O(maxCommits)`.
 */
export function scanCachedCommits(
  dir: string,
  expectedGitVersion: string,
  hashes: readonly string[],
  shallowBoundary: ReadonlySet<string>,
): CacheScanResult {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = scanCachedCommitsOnce(dir, expectedGitVersion, hashes, shallowBoundary);
    if (result.kind !== 'retry') return result;
  }
  return { kind: 'invalid', reason: 'a cache segment is missing' };
}

export class CacheRecordError extends Error {
  override name = 'CacheRecordError';
}

/** Parses and validates one cached record. Throws `CacheRecordError` when it is malformed. */
export function parseCachedRecord(line: string, expectedHash: string): RawCommit {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new CacheRecordError('record is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null) throw new CacheRecordError('record is malformed');
  const r = raw as Record<string, unknown>;
  if (
    r.hash !== expectedHash ||
    typeof r.authorName !== 'string' ||
    typeof r.authorEmail !== 'string' ||
    typeof r.authorTime !== 'number' ||
    !Number.isFinite(r.authorTime) ||
    typeof r.commitTime !== 'number' ||
    !Number.isFinite(r.commitTime) ||
    typeof r.subject !== 'string' ||
    !Array.isArray(r.trailers) ||
    !Array.isArray(r.changes)
  ) {
    throw new CacheRecordError('record is malformed');
  }
  const trailers = r.trailers;
  for (let i = 0; i < trailers.length; i++) {
    const t = trailers[i] as Record<string, unknown> | null;
    if (typeof t !== 'object' || t === null || typeof t.key !== 'string' || typeof t.value !== 'string') {
      throw new CacheRecordError('record is malformed');
    }
  }
  const changes = r.changes;
  for (let i = 0; i < changes.length; i++) {
    const ch = changes[i] as Record<string, unknown> | null;
    if (
      typeof ch !== 'object' ||
      ch === null ||
      typeof ch.status !== 'string' ||
      ch.status.length === 0 ||
      typeof ch.path !== 'string' ||
      (ch.oldPath !== undefined && typeof ch.oldPath !== 'string')
    ) {
      throw new CacheRecordError('record is malformed');
    }
  }
  return raw as RawCommit;
}

/** Serializes a record with `hash` first so loads can index lines without parsing them. */
export function serializeRecord(commit: RawCommit): string {
  const { hash, ...rest } = commit;
  return JSON.stringify({ hash, ...rest });
}

// ---- writing -----------------------------------------------------------------

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Writes to a unique temp file, then renames it into place (atomic on POSIX and NTFS). */
function writeAtomic(dir: string, name: string, data: Buffer | string): void {
  const tmp = join(dir, `.${name}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  writeFileSync(tmp, data, { flag: 'wx', mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, join(dir, name));
      return;
    } catch (err) {
      // Windows refuses to replace a file another process has open for a moment.
      if (attempt < 5 && (isErrno(err, 'EPERM') || isErrno(err, 'EBUSY') || isErrno(err, 'EACCES'))) {
        sleepSync(20 * (attempt + 1));
        continue;
      }
      try {
        unlinkSync(tmp);
      } catch {
        // best effort
      }
      throw err;
    }
  }
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Missing files are fine; Windows may refuse to delete a file a reader has open.
  }
}

/**
 * Ensures `dir` exists and is ours to write into: it must contain no symbolic links, and must
 * either be empty or already carry a regular `CACHEDIR.TAG` file with the cache signature.
 * Also writes `.gitignore` (`*`) so an in-repository `cache.dir` never pollutes `git status`.
 * Returns a reason string when the directory must not be used.
 */
function claimDirectory(dir: string): string | undefined {
  const existingStat = lstatSync(dir, { throwIfNoEntry: false });
  if (existingStat && !existingStat.isDirectory()) {
    return 'the cache path is not a directory';
  }
  if (!existingStat) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const entryStat = lstatSync(join(dir, entry), { throwIfNoEntry: false });
    if (entryStat?.isSymbolicLink()) {
      return 'the cache directory contains a symbolic link';
    }
  }

  const tag = join(dir, CACHE_TAG_FILE);
  const tagStat = lstatSync(tag, { throwIfNoEntry: false });
  if (tagStat) {
    if (!tagStat.isFile()) return 'CACHEDIR.TAG is not a regular file';
    if (!readFileSync(tag, 'utf8').startsWith(CACHE_TAG_SIGNATURE)) {
      return 'the directory is not empty and is not a repo-archaeology cache';
    }
  } else {
    const other = entries.filter(
      (e) => e !== CACHE_TAG_FILE && e !== CACHE_LOCK_FILE && e !== CACHE_GITIGNORE_FILE && !TEMP_FILE.test(e),
    );
    if (other.length > 0) return 'the directory is not empty and is not a repo-archaeology cache';
    writeAtomic(dir, CACHE_TAG_FILE, CACHE_TAG_CONTENT);
  }

  const gitignore = join(dir, CACHE_GITIGNORE_FILE);
  const giStat = lstatSync(gitignore, { throwIfNoEntry: false });
  if (!giStat) {
    writeAtomic(dir, CACHE_GITIGNORE_FILE, CACHE_GITIGNORE_CONTENT);
  } else if (!giStat.isFile()) {
    return '.gitignore is not a regular file';
  }
  return undefined;
}

interface CacheLockHandle {
  ownsLock: () => boolean;
  release: () => void;
}

/**
 * Exclusive lock via `open(O_CREAT | O_EXCL)` with a unique ownership token. A lock older
 * than 60 s is treated as abandoned (crashed writer) and replaced, and `ownsLock()` verifies
 * that a slow writer whose lock was superseded never publishes a stale `index.json` or unlinks
 * the new owner's lock file. Returns `undefined` when another writer holds the lock.
 */
function acquireLock(dir: string): CacheLockHandle | undefined {
  const path = join(dir, CACHE_LOCK_FILE);
  const token = randomBytes(8).toString('hex');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeSync(fd, `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`);
      } finally {
        closeSync(fd);
      }
      const ownsLock = (): boolean => {
        try {
          const parsed = JSON.parse(readFileSync(path, 'utf8')) as { token?: string };
          return parsed.token === token;
        } catch {
          return false;
        }
      };
      return {
        ownsLock,
        release: () => {
          if (ownsLock()) tryUnlink(path);
        },
      };
    } catch (err) {
      if (!isErrno(err, 'EEXIST')) throw err;
      try {
        if (Date.now() - statSync(path).mtimeMs <= CACHE_LOCK_STALE_MS) return undefined;
        unlinkSync(path);
      } catch {
        // Lock vanished between open and stat: retry once.
      }
    }
  }
  return undefined;
}

export interface CacheWriteOptions {
  /** `rebuild` discards every existing segment first. */
  mode: 'append' | 'rebuild';
  records: readonly RawCommit[];
  gitVersion: string;
  raVersion: string;
  /** Commits reachable from any ref; only called when compaction runs. */
  reachable: () => Promise<Set<string>>;
  maxSegments?: number;
  maxBytes?: number;
}

export interface CacheWriteResult {
  written: boolean;
  compacted: boolean;
  /** Set when the cache could not be written; results are unaffected. */
  problem?: string;
}

function freshIndex(gitVersion: string, raVersion: string): CacheIndex {
  return {
    cacheVersion: CACHE_VERSION,
    raVersion,
    gitVersion,
    formatSignature: CACHE_FORMAT_SIGNATURE,
    createdAt: new Date().toISOString(),
    segments: [],
  };
}

function segmentNumber(file: string): number {
  return Number(SEGMENT_FILE.exec(file)?.[1] ?? 0);
}

function writeSegment(dir: string, index: CacheIndex, lines: readonly string[]): void {
  let next = 0;
  for (const seg of index.segments) next = Math.max(next, segmentNumber(seg.file));
  for (const entry of readdirSync(dir)) if (SEGMENT_FILE.test(entry)) next = Math.max(next, segmentNumber(entry));
  const file = `commits-${next + 1}.jsonl`;
  const data = Buffer.from(lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8');
  writeAtomic(dir, file, data);
  const fullSha256 = sha256(data);
  index.segments.push({
    file,
    count: lines.length,
    sha256: fullSha256,
    bytes: data.length,
    headSha256: computeHeadSha256(fullSha256, data),
  });
}

/** Deletes segment files and stray temp files that the index does not reference (lock held). */
function removeUnreferenced(dir: string, index: CacheIndex): void {
  const keep = new Set(index.segments.map((s) => s.file));
  for (const entry of readdirSync(dir)) {
    if ((SEGMENT_FILE.test(entry) && !keep.has(entry)) || TEMP_FILE.test(entry)) {
      tryUnlink(join(dir, entry));
    }
  }
}

/**
 * Appends `records` as a new segment (or rebuilds), then compacts when there are more than
 * `maxSegments` segments or more than `maxBytes` in total. Every file is written to a temp
 * name and renamed into place, and `index.json` is replaced last, so readers only ever see
 * complete segments. Writers serialize on the lock file; a writer that cannot take the lock
 * skips its write.
 */
export async function writeCache(dir: string, options: CacheWriteOptions): Promise<CacheWriteResult> {
  if (options.mode === 'append' && options.records.length === 0) return { written: false, compacted: false };
  let lock: CacheLockHandle | undefined;
  try {
    const claimProblem = claimDirectory(dir);
    if (claimProblem) return { written: false, compacted: false, problem: claimProblem };
    lock = acquireLock(dir);
    if (!lock) return { written: false, compacted: false };

    let current: CacheLoad = options.mode === 'rebuild' ? { kind: 'missing' } : loadCache(dir, options.gitVersion);
    let index: CacheIndex;
    if (current.kind === 'ok') {
      index = current.index;
    } else {
      index = freshIndex(options.gitVersion, options.raVersion);
      current = { kind: 'missing' };
    }
    index.raVersion = options.raVersion;
    index.formatSignature = CACHE_FORMAT_SIGNATURE;

    const known = current.kind === 'ok' ? current.lines : new Map<string, string>();
    const newLines: string[] = [];
    for (const record of options.records) {
      if (known.has(record.hash)) continue; // another writer cached it meanwhile
      newLines.push(serializeRecord(record));
    }
    if (newLines.length > 0) writeSegment(dir, index, newLines);

    const maxSegments = options.maxSegments ?? MAX_CACHE_SEGMENTS;
    const maxBytes = options.maxBytes ?? MAX_CACHE_BYTES;
    const totalBytes = (current.kind === 'ok' ? current.bytes : 0) + newLines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
    let compacted = false;
    if (index.segments.length > maxSegments || totalBytes > maxBytes) {
      const reachable = await options.reachable();
      const all = new Map<string, string>();
      for (const line of newLines) {
        const hash = lineHash(line);
        if (hash !== undefined && !all.has(hash)) all.set(hash, line);
      }
      for (const [hash, line] of known) {
        if (!all.has(hash)) all.set(hash, line);
      }
      const kept: string[] = [];
      for (const [hash, line] of all) if (reachable.has(hash)) kept.push(line);
      index = { ...index, segments: [] };
      writeSegment(dir, index, kept);
      compacted = true;
    }

    if (!lock.ownsLock()) return { written: false, compacted: false };
    for (const seg of index.segments) {
      if (!existsSync(join(dir, seg.file))) return { written: false, compacted: false };
    }

    writeAtomic(dir, CACHE_INDEX_FILE, `${JSON.stringify(index, null, 2)}\n`);
    if (lock.ownsLock()) removeUnreferenced(dir, index);
    return { written: newLines.length > 0 || compacted || options.mode === 'rebuild', compacted };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { written: false, compacted: false, problem: code ? `${code}` : 'unexpected error' };
  } finally {
    lock?.release();
  }
}
