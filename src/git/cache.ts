import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
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

export const CACHE_INDEX_FILE = 'index.json';
export const CACHE_LOCK_FILE = 'lock';
/**
 * Cache Directory Tagging Specification marker (https://bford.info/cachedir/). The cache only
 * creates, overwrites, or deletes files in a directory that carries this tag (or that it
 * created empty), so a mistyped `cache.dir` can never clobber unrelated files.
 */
export const CACHE_TAG_FILE = 'CACHEDIR.TAG';
const CACHE_TAG_CONTENT =
  'Signature: 8a477f597d28d172789f06886806bc55\n' +
  '# This file is a cache directory tag created by repo-archaeology (history cache).\n' +
  '# For information about cache directory tags see https://bford.info/cachedir/\n';

const SEGMENT_FILE = /^commits-(\d+)\.jsonl$/;
const HASH = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RECORD_PREFIX = '{"hash":"';

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
}

export type CacheLoad =
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: string }
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
    return { enabled: true, dir, display: displayPath(root, dir) };
  }
  const envDir = input.env?.[CACHE_DIR_ENV]?.trim();
  if (envDir) return { enabled: true, dir: resolve(envDir), display: CACHE_DIR_ENV_DISPLAY };
  if (input.file?.dir && !hasSymlinkInRepoPath(root, input.file.dir)) {
    const dir = resolve(root, input.file.dir);
    return { enabled: true, dir, display: displayPath(root, dir) };
  }
  // --git-common-dir (not --git-dir) so every worktree of a repository shares one cache.
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
      !SHA256.test(s.sha256)
    ) {
      return 'index.json is malformed';
    }
    seen.add(s.file);
    segments.push({ file: s.file, count: s.count, sha256: s.sha256 });
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

type LoadAttempt = CacheLoad | { kind: 'retry' };

function loadOnce(dir: string, expectedGitVersion: string): LoadAttempt {
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
  const lines = new Map<string, string>();
  let bytes = 0;
  for (const seg of index.segments) {
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

/** Loads and verifies every segment. Never throws for cache problems; reports them as `invalid`. */
export function loadCache(dir: string, expectedGitVersion: string): CacheLoad {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = loadOnce(dir, expectedGitVersion);
    if (result.kind !== 'retry') return result;
  }
  return { kind: 'invalid', reason: 'a cache segment is missing' };
}

export class CacheRecordError extends Error {
  override name = 'CacheRecordError';
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Parses and validates one cached record. Throws `CacheRecordError` when it is malformed. */
export function parseCachedRecord(line: string, expectedHash: string): RawCommit {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new CacheRecordError('record is not valid JSON');
  }
  const r = raw as Record<string, unknown>;
  const ok =
    typeof r === 'object' &&
    r !== null &&
    r.hash === expectedHash &&
    isString(r.authorName) &&
    isString(r.authorEmail) &&
    isFiniteNumber(r.authorTime) &&
    isFiniteNumber(r.commitTime) &&
    isString(r.subject) &&
    Array.isArray(r.trailers) &&
    r.trailers.every((t: unknown) => typeof t === 'object' && t !== null && isString((t as Record<string, unknown>).key) && isString((t as Record<string, unknown>).value)) &&
    Array.isArray(r.changes) &&
    r.changes.every((c: unknown) => {
      if (typeof c !== 'object' || c === null) return false;
      const ch = c as Record<string, unknown>;
      return isString(ch.status) && ch.status.length > 0 && isString(ch.path) && (ch.oldPath === undefined || isString(ch.oldPath));
    });
  if (!ok) throw new CacheRecordError('record is malformed');
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
function writeAtomic(dir: string, name: string, data: string): void {
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
 * Ensures `dir` exists and is ours to write into: it must be empty or already carry the
 * cache tag. Returns a reason string when the directory must not be used.
 */
function claimDirectory(dir: string): string | undefined {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tag = join(dir, CACHE_TAG_FILE);
  try {
    if (readFileSync(tag, 'utf8').startsWith('Signature: 8a477f597d28d172789f06886806bc55')) return undefined;
  } catch {
    // no tag yet
  }
  const entries = readdirSync(dir).filter((e) => e !== CACHE_TAG_FILE && e !== CACHE_LOCK_FILE);
  if (entries.length > 0) return 'the directory is not empty and is not a repo-archaeology cache';
  writeFileSync(tag, CACHE_TAG_CONTENT, { mode: 0o600 });
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
  const data = lines.length > 0 ? `${lines.join('\n')}\n` : '';
  writeAtomic(dir, file, data);
  index.segments.push({ file, count: lines.length, sha256: sha256(data) });
}

/** Deletes segment files and stray temp files that the index does not reference (lock held). */
function removeUnreferenced(dir: string, index: CacheIndex): void {
  const keep = new Set(index.segments.map((s) => s.file));
  for (const entry of readdirSync(dir)) {
    if ((SEGMENT_FILE.test(entry) && !keep.has(entry)) || /^\.(commits-\d+\.jsonl|index\.json)\.tmp-/.test(entry)) {
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
      const all = new Map(known);
      for (const line of newLines) {
        const hash = lineHash(line);
        if (hash !== undefined && !all.has(hash)) all.set(hash, line);
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
