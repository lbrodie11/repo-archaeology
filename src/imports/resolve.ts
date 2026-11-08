import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { posix } from 'node:path';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import { isRegularTreeMode, parseLsTree, type TreeFileSet } from '../git/repo.js';
import { CONFIG_OVERRIDES, GitError } from '../git/run.js';
import { globToRegExp } from '../util/glob.js';
import { typescript } from './typescript.js';

export const MAX_SOURCE_BYTES = 1_000_000;
const DEFAULT_CAT_FILE_TIMEOUT_MS = 10_000;

/** Read access to the repository, using repo-relative POSIX paths. */
export interface RepoFiles {
  exists(path: string): boolean;
  read(path: string): string | undefined;
  /** Every file that exists (used to discover the repo's own packages). */
  list(): Iterable<string>;
  /** Optional boundary check verifying that `path` does not escape `dir` via symlinks. */
  isWithinDir?(path: string, dir: string): boolean;
  /** Optional check returning true if `path` (or a candidate extension of it) is a symlink or escapes `dir`. */
  isInvalidTarget?(path: string, dir: string): boolean;
  /** Starts any underlying background process (e.g. `git cat-file --batch`) if not already open. */
  open?(): void;
  /** Closes any underlying background process (e.g. `git cat-file --batch`). */
  close?(): void;
}

export interface GitTreeFiles extends RepoFiles {
  open(): void;
  close(): void;
  readonly pid: number | undefined;
}

const CAT_FILE_WORKER_CODE = `
const { spawn } = require('node:child_process');
const { workerData } = require('node:worker_threads');

const { root, configOverrides, port, initLock } = workerData;

const child = spawn('git', [...configOverrides, 'cat-file', '--batch'], {
  cwd: root,
  env: {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_NO_REPLACE_OBJECTS: '1',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let childExited = false;
let stderrText = '';
const chunks = [];
let totalBuffered = 0;
let pendingStep = null;

function notifyWaiter(lock, value = 1) {
  Atomics.store(lock, 0, value);
  Atomics.notify(lock, 0, 1);
}

function consumeBytes(n) {
  const out = Buffer.allocUnsafe(n);
  let offset = 0;
  while (offset < n && chunks.length > 0) {
    const first = chunks[0];
    const take = Math.min(first.length, n - offset);
    first.copy(out, offset, 0, take);
    offset += take;
    if (take === first.length) {
      chunks.shift();
    } else {
      chunks[0] = first.subarray(take);
    }
  }
  totalBuffered -= offset;
  return out;
}

function discardFromBuffer(maxToDiscard) {
  let discarded = 0;
  while (discarded < maxToDiscard && chunks.length > 0) {
    const first = chunks[0];
    const take = Math.min(first.length, maxToDiscard - discarded);
    discarded += take;
    if (take === first.length) {
      chunks.shift();
    } else {
      chunks[0] = first.subarray(take);
    }
  }
  totalBuffered -= discarded;
  return discarded;
}

function findNewlineOffset() {
  let scanned = 0;
  for (let i = 0; i < chunks.length; i++) {
    const buf = chunks[i];
    const idx = buf.indexOf(0x0a);
    if (idx !== -1) return scanned + idx;
    scanned += buf.length;
  }
  return -1;
}

child.stdout.on('data', (chunk) => {
  chunks.push(chunk);
  totalBuffered += chunk.length;
  if (pendingStep) pendingStep();
});

child.stderr.on('data', (chunk) => {
  if (stderrText.length < 4096) {
    stderrText += chunk.toString('utf8');
  }
});

child.on('error', (err) => {
  if (stderrText.length < 4096 && err && err.message) {
    stderrText += err.message;
  }
  childExited = true;
  if (pendingStep) pendingStep();
});

child.on('close', () => {
  childExited = true;
  if (pendingStep) pendingStep();
});

port.on('message', (msg) => {
  if (msg.type === 'close') {
    const finishClose = () => {
      port.postMessage({ type: 'closed' });
      notifyWaiter(msg.lock, 1);
      port.close();
      process.exit(0);
    };
    if (childExited) {
      finishClose();
      return;
    }
    child.once('close', finishClose);
    try {
      child.stdin.end();
    } catch {}
    setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
    }, 30).unref();
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, 150).unref();
    return;
  }

  if (msg.type === 'read') {
    const { spec, maxBytes, lock } = msg;
    if (childExited || !child.stdin.writable) {
      port.postMessage({ content: undefined, dead: true, stderr: stderrText });
      notifyWaiter(lock, 1);
      return;
    }

    let phase = 'header';
    let bodySize = 0;
    let remainingToRead = 0;
    let discard = false;

    const finishRead = (content, dead = false) => {
      pendingStep = null;
      port.postMessage({ content, dead, stderr: dead ? stderrText : undefined });
      notifyWaiter(lock, 1);
    };

    pendingStep = () => {
      if (phase === 'header') {
        const nl = findNewlineOffset();
        if (nl === -1) {
          if (childExited) finishRead(undefined, true);
          return;
        }
        const headerLine = consumeBytes(nl + 1).subarray(0, nl).toString('utf8');
        const match = /^[0-9a-f]{40,64} (\\S+) (\\d+)$/.exec(headerLine);
        if (!match) {
          finishRead(undefined, false);
          return;
        }
        const objType = match[1];
        bodySize = Number(match[2]);
        remainingToRead = bodySize + 1;
        discard = objType !== 'blob' || bodySize > maxBytes;
        phase = 'body';
      }

      if (phase === 'body') {
        if (discard) {
          remainingToRead -= discardFromBuffer(remainingToRead);
          if (remainingToRead <= 0) {
            finishRead(undefined, false);
            return;
          }
          if (childExited) finishRead(undefined, true);
          return;
        }
        if (totalBuffered >= remainingToRead) {
          const payload = consumeBytes(remainingToRead);
          const content = payload.subarray(0, bodySize).toString('utf8');
          finishRead(content, false);
          return;
        }
        if (childExited) finishRead(undefined, true);
      }
    };

    try {
      child.stdin.write(spec + '\\n');
    } catch {
      finishRead(undefined, true);
    }
  }
});

port.postMessage({ type: 'init', pid: child.pid ?? null });
notifyWaiter(initLock, 1);
`;

export interface GitTreeFilesOptions {
  maxBytes?: number;
  timeoutMs?: number;
  /** Optional hook called inside `read(path)` after fetching blob content (for testing error handling). */
  onRead?: (path: string, content: string | undefined) => void;
  /** Optional hook called when a `git cat-file --batch` child process is spawned. */
  onSpawn?: (pid: number) => void;
  /** Optional hook called when a `git cat-file --batch` child process is closed. */
  onClose?: (pid: number) => void;
}

/**
 * Repository access backed by a commit tree (`<headSha>`) using a single long-lived
 * `git cat-file --batch` process per analysis.
 */
export function gitTreeFiles(
  root: string,
  headSha: string,
  existing: ReadonlySet<string>,
  options?: GitTreeFilesOptions,
): GitTreeFiles {
  if (headSha.startsWith('-') || /[\r\n\0]/.test(headSha)) {
    throw new GitError(`Invalid revision: ${headSha}`);
  }
  const maxBytes = options?.maxBytes ?? MAX_SOURCE_BYTES;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CAT_FILE_TIMEOUT_MS;
  const cache = new Map<string, string | undefined>();
  let treeModes: ReadonlyMap<string, string> | undefined = (existing as Partial<TreeFileSet>).modes;

  const ensureTreeModes = (): ReadonlyMap<string, string> => {
    if (treeModes !== undefined) return treeModes;
    const res = spawnSync('git', [...CONFIG_OVERRIDES, 'ls-tree', '-r', '-z', '--end-of-options', headSha], {
      cwd: root,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        GIT_NO_REPLACE_OBJECTS: '1',
      },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (res.status !== 0) {
      throw new GitError(`git ls-tree failed for ${headSha}`, res.stderr ?? '', res.status);
    }
    treeModes = parseLsTree(res.stdout ?? '').modes;
    return treeModes;
  };

  const hasNonRegularSegment = (path: string, modes: ReadonlyMap<string, string>): boolean => {
    const mode = modes.get(path);
    if (mode !== undefined && !isRegularTreeMode(mode)) return true;
    const parts = path.split('/');
    let prefix = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i] ?? '';
      prefix = prefix ? `${prefix}/${seg}` : seg;
      const prefixMode = modes.get(prefix);
      if (prefixMode !== undefined && !isRegularTreeMode(prefixMode)) return true;
    }
    return false;
  };

  let worker: Worker | undefined;
  let port: MessageChannel['port1'] | undefined;
  let lock: Int32Array | undefined;
  let currentPid: number | undefined;
  let exitListenerAttached = false;
  let explicitlyClosed = false;

  const closeInternal = (): void => {
    if (exitListenerAttached) {
      process.removeListener('exit', onProcessExit);
      exitListenerAttached = false;
    }
    const activeWorker = worker;
    const activePort = port;
    const activeLock = lock;
    const pid = currentPid;
    worker = undefined;
    port = undefined;
    lock = undefined;
    currentPid = undefined;

    if (!activeWorker || !activePort || !activeLock) {
      if (pid !== undefined) options?.onClose?.(pid);
      return;
    }
    try {
      Atomics.store(activeLock, 0, 0);
      activePort.postMessage({ type: 'close', lock: activeLock });
      Atomics.wait(activeLock, 0, 0, 2000);
      while (receiveMessageOnPort(activePort) !== undefined) {
        // drain
      }
    } catch {
      // ignore if worker already exited
    } finally {
      try {
        activePort.close();
      } catch {}
      void activeWorker.terminate();
      if (pid !== undefined) options?.onClose?.(pid);
    }
  };

  const onProcessExit = (): void => {
    closeInternal();
  };

  const open = (): void => {
    explicitlyClosed = false;
    if (worker) return;
    const channel = new MessageChannel();
    const sab = new SharedArrayBuffer(4);
    const syncLock = new Int32Array(sab);
    Atomics.store(syncLock, 0, 0);

    const w = new Worker(CAT_FILE_WORKER_CODE, {
      eval: true,
      workerData: {
        root,
        configOverrides: CONFIG_OVERRIDES,
        port: channel.port2,
        initLock: syncLock,
      },
      transferList: [channel.port2],
    });
    w.unref();
    channel.port1.unref();

    worker = w;
    port = channel.port1;
    lock = syncLock;

    Atomics.wait(syncLock, 0, 0, 5000);
    const initMsg = receiveMessageOnPort(channel.port1)?.message as { type?: string; pid?: number | null } | undefined;
    if (initMsg?.pid) {
      currentPid = initMsg.pid;
      options?.onSpawn?.(initMsg.pid);
    }
    if (!exitListenerAttached) {
      process.once('exit', onProcessExit);
      exitListenerAttached = true;
    }
  };

  const read = (path: string): string | undefined => {
    if (explicitlyClosed) {
      throw new GitError(`Cannot read "${path}" after gitTreeFiles has been closed; call open() before reading again.`);
    }
    if (!existing.has(path) || path.includes('\n') || path.includes('\r') || path.includes('\0')) {
      return undefined;
    }
    if (cache.has(path)) {
      const cached = cache.get(path);
      options?.onRead?.(path, cached);
      return cached;
    }
    // Only regular files (100644/100755) may be read as source; symlinks (120000) and gitlinks (160000) return undefined.
    const modes = ensureTreeModes();
    if (hasNonRegularSegment(path, modes)) {
      cache.set(path, undefined);
      options?.onRead?.(path, undefined);
      return undefined;
    }
    open();
    if (!port || !lock) {
      throw new GitError(`Failed to initialize git cat-file --batch worker for ${headSha}.`);
    }
    try {
      Atomics.store(lock, 0, 0);
      port.postMessage({
        type: 'read',
        spec: `${headSha}:${path}`,
        maxBytes,
        lock,
      });
      const waitRes = Atomics.wait(lock, 0, 0, timeoutMs);
      if (waitRes === 'timed-out') {
        closeInternal();
        throw new GitError(`Timed out reading ${headSha}:${path} from git cat-file --batch after ${timeoutMs}ms.`);
      }
      const msg = receiveMessageOnPort(port)?.message as { content?: string; dead?: boolean; stderr?: string } | undefined;
      if (!msg || msg.dead) {
        closeInternal();
        const detail = msg?.stderr?.trim();
        throw new GitError(
          `git cat-file --batch exited unexpectedly while reading ${headSha}:${path}.${detail ? ` ${detail}` : ''}`,
          msg?.stderr ?? '',
        );
      }
      const content = msg.content;
      cache.set(path, content);
      options?.onRead?.(path, content);
      return content;
    } catch (err) {
      closeInternal();
      throw err;
    }
  };

  return {
    exists: (path) => {
      if (!existing.has(path)) return false;
      if (treeModes !== undefined && hasNonRegularSegment(path, treeModes)) return false;
      return true;
    },
    isWithinDir: (path, dir) => {
      if (!existing.has(path)) return false;
      const modes = ensureTreeModes();
      if (hasNonRegularSegment(path, modes)) return false;
      if (!dir) return true;
      return path === dir || path.startsWith(`${dir}/`);
    },
    isInvalidTarget: (path, dir) => {
      const normalized = posix.normalize(path);
      if (normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized)) return true;
      if (dir && normalized !== dir && !normalized.startsWith(`${dir}/`)) return true;
      if (treeModes !== undefined) {
        for (const candidate of candidateFilePaths(normalized)) {
          if (hasNonRegularSegment(candidate, treeModes)) return true;
        }
      }
      return false;
    },
    list: () => existing,
    read,
    open,
    close: () => {
      explicitlyClosed = true;
      closeInternal();
    },
    get pid() {
      return currentPid;
    },
  };
}

export type ImportResolutionVia = 'relative' | 'paths' | 'workspace' | 'exports' | 'imports';

export type ImportUnresolvedReasonCode =
  | 'alias-unmatched'
  | 'unknown-package'
  | 'target-missing'
  | 'not-exported'
  | 'invalid-target'
  | 'unsupported-config'
  | 'ambiguous-package';

export type Resolution =
  | { kind: 'file'; path: string }
  /** A package from node_modules: not part of this repository. */
  | { kind: 'external' }
  /** Looks local (relative, alias, subpath import) but could not be resolved. */
  | { kind: 'unresolved' };

export type DetailedResolution =
  | {
      kind: 'file';
      path: string;
      via: ImportResolutionVia;
      heuristic?: boolean;
      typeOnlyTarget?: boolean;
    }
  | {
      kind: 'external';
      via?: ImportResolutionVia;
    }
  | {
      kind: 'unresolved';
      reason: 'unmatched';
      reasonCode: ImportUnresolvedReasonCode;
    };

export interface ResolveOptions {
  typeOnlyImport?: boolean;
}

// Implementation files before declaration files: `./foo` with foo.js and foo.d.ts is foo.js.
const APPEND_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts', '.d.mts', '.d.cts', '.json'];
const INDEX_FILES = APPEND_EXTENSIONS.filter((e) => !e.startsWith('.d.') && e !== '.json').map((e) => `index${e}`);
// TypeScript lets `./foo.js` refer to `./foo.ts` in ESM projects.
const EXTENSION_SWAPS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx', '.d.ts'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts', '.d.mts'],
  '.cjs': ['.cts', '.d.cts'],
};

/** Generates all candidate file paths that `resolveFile` probes for `base`. */
export function candidateFilePaths(base: string): string[] {
  const normalized = posix.normalize(base);
  if (normalized.startsWith('../') || normalized === '..' || posix.isAbsolute(normalized)) return [];
  const p = normalized === '.' ? '' : normalized.replace(/\/$/, '');
  const out: string[] = [];
  if (p) out.push(p);
  const ext = posix.extname(p);
  for (const swap of EXTENSION_SWAPS[ext] ?? []) {
    out.push(p.slice(0, -ext.length) + swap);
  }
  for (const e of APPEND_EXTENSIONS) {
    if (p) out.push(p + e);
  }
  for (const index of INDEX_FILES) {
    out.push(p ? `${p}/${index}` : index);
  }
  return out;
}

/** Resolves `base` (a repo-relative path without query/hash) to an existing file. */
export function resolveFile(base: string, files: RepoFiles): string | undefined {
  for (const candidate of candidateFilePaths(base)) {
    if (files.exists(candidate)) return candidate;
  }
  return undefined;
}

export interface PathEntry {
  pattern: string;
  targets: string[];
  base: string;
}

export interface SourceDirMapping {
  configDir: string;
  rootDir?: string;
  outDir?: string;
  declarationDir?: string;
}

export interface PathsConfig {
  baseUrl?: string;
  paths?: PathEntry[];
  /** Directory of the config that declared `paths`. */
  pathsDir?: string;
  /** Where `paths` targets resolve from: the effective baseUrl, else `pathsDir`. */
  pathsBase?: string;
  /** Custom export/import conditions from `compilerOptions.customConditions`. */
  customConditions?: string[];
  /** Source-to-output directory mapping from `compilerOptions`. */
  sourceMapping?: SourceDirMapping;
  /** True when the tsconfig file could not be parsed as valid JSONC. */
  malformed?: boolean;
}

const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json', 'tsconfig.app.json'];
const PKG_CONFIG_NAMES = ['tsconfig.build.json', 'tsconfig.json', 'tsconfig.app.json', 'jsconfig.json'];

/**
 * Reads `baseUrl`, `paths`, `customConditions`, and `outDir`/`declarationDir`/`rootDir`
 * from the nearest tsconfig/jsconfig, following relative `extends` and `references`.
 */
export class TsConfigPaths {
  private readonly byDir = new Map<string, PathsConfig | null>();
  private readonly byPkgDir = new Map<string, PathsConfig | null>();
  private readonly byFile = new Map<string, PathsConfig | null>();

  constructor(private readonly files: RepoFiles) {}

  forFile(filePath: string): PathsConfig | null {
    return this.forDir(posix.dirname(filePath));
  }

  forPackageDir(pkgDir: string): PathsConfig | null {
    const key = pkgDir === '.' ? '' : pkgDir;
    const cached = this.byPkgDir.get(key);
    if (cached !== undefined) return cached;
    let result: PathsConfig | null = null;
    for (const name of PKG_CONFIG_NAMES) {
      const candidate = key ? `${key}/${name}` : name;
      if (this.files.exists(candidate)) {
        result = this.load(candidate, 0);
        if (result?.sourceMapping?.outDir || result?.sourceMapping?.declarationDir) {
          break;
        }
      }
    }
    this.byPkgDir.set(key, result);
    return result;
  }

  private forDir(dir: string): PathsConfig | null {
    const key = dir === '.' ? '' : dir;
    const cached = this.byDir.get(key);
    if (cached !== undefined) return cached;
    let result: PathsConfig | null = null;
    for (const name of CONFIG_NAMES) {
      const candidate = key ? `${key}/${name}` : name;
      if (this.files.exists(candidate)) {
        result = this.load(candidate, 0);
        break;
      }
    }
    if (result === null && key !== '') result = this.forDir(posix.dirname(key));
    this.byDir.set(key, result);
    return result;
  }

  private load(configPath: string, depth: number): PathsConfig | null {
    const cached = this.byFile.get(configPath);
    if (cached !== undefined) return cached;
    this.byFile.set(configPath, null); // guards against `extends` cycles
    const text = this.files.read(configPath);
    if (text === undefined) return null;
    const parsed = typescript().parseConfigFileTextToJson(configPath, text);
    const json = parsed.config as
      | {
          extends?: string | string[];
          references?: { path?: string }[];
          compilerOptions?: {
            baseUrl?: string;
            paths?: Record<string, string[]>;
            customConditions?: unknown[];
            rootDir?: string;
            outDir?: string;
            declarationDir?: string;
          };
        }
      | undefined;
    if (parsed.error && (!json || Object.keys(json).length === 0)) {
      const malformed: PathsConfig = { malformed: true };
      this.byFile.set(configPath, malformed);
      return malformed;
    }
    if (!json || typeof json !== 'object') return null;

    const dir = posix.dirname(configPath) === '.' ? '' : posix.dirname(configPath);
    let result: PathsConfig = {};
    const parents =
      typeof json.extends === 'string' ? [json.extends] : Array.isArray(json.extends) ? json.extends : [];
    for (const parent of parents) {
      if (depth >= 5 || typeof parent !== 'string' || !(parent.startsWith('./') || parent.startsWith('../'))) continue;
      let parentPath = posix.normalize(dir ? posix.join(dir, parent) : parent);
      if (!this.files.exists(parentPath) && !parentPath.endsWith('.json')) {
        if (this.files.exists(`${parentPath}/tsconfig.json`)) {
          parentPath = `${parentPath}/tsconfig.json`;
        } else {
          parentPath += '.json';
        }
      }
      const inherited = this.load(parentPath, depth + 1);
      if (inherited) {
        result = {
          ...result,
          ...inherited,
          sourceMapping: inherited.sourceMapping ? { ...inherited.sourceMapping } : result.sourceMapping,
        };
      }
    }

    const references = Array.isArray(json.references) ? json.references : [];
    for (const ref of references) {
      if (depth >= 5 || typeof ref?.path !== 'string') continue;
      let refPath = posix.normalize(dir ? posix.join(dir, ref.path) : ref.path);
      if (this.files.exists(posix.join(refPath, 'tsconfig.json'))) refPath = posix.join(refPath, 'tsconfig.json');
      else if (!refPath.endsWith('.json')) refPath += '.json';
      const referenced = this.load(refPath, depth + 1);
      if (referenced) {
        result = {
          ...result,
          ...referenced,
          paths: [
            ...(referenced.paths ?? []),
            ...(result.paths ?? []).filter((ip) => !(referenced.paths ?? []).some((rp) => rp.pattern === ip.pattern)),
          ],
        };
      }
    }

    const options = json.compilerOptions ?? {};
    if (typeof options.baseUrl === 'string') {
      const resolvedBase = posix.normalize(dir ? posix.join(dir, options.baseUrl) : options.baseUrl);
      result.baseUrl = resolvedBase === '.' ? '' : resolvedBase;
    }
    if (Array.isArray(options.customConditions)) {
      result.customConditions = options.customConditions.filter((c): c is string => typeof c === 'string');
    }
    if (
      typeof options.rootDir === 'string' ||
      typeof options.outDir === 'string' ||
      typeof options.declarationDir === 'string'
    ) {
      const resolveRel = (val: string | undefined): string | undefined => {
        if (typeof val !== 'string') return undefined;
        const norm = posix.normalize(dir ? posix.join(dir, val) : val);
        return norm === '.' ? '' : norm.replace(/\/$/, '');
      };
      result.sourceMapping = {
        configDir: dir,
        rootDir: resolveRel(options.rootDir) ?? result.sourceMapping?.rootDir,
        outDir: resolveRel(options.outDir) ?? result.sourceMapping?.outDir,
        declarationDir: resolveRel(options.declarationDir) ?? result.sourceMapping?.declarationDir,
      };
    }
    if (options.paths !== undefined) {
      if (options.paths && typeof options.paths === 'object' && !Array.isArray(options.paths)) {
        const currentBase = result.baseUrl ?? dir;
        const declaredPaths: PathEntry[] = Object.entries(options.paths)
          .filter(([, targets]) => Array.isArray(targets))
          .map(([pattern, targets]) => ({
            pattern,
            targets: targets.filter((t): t is string => typeof t === 'string'),
            base: currentBase,
          }));
        // Child mappings override parent mappings for the same pattern, and come first.
        const inherited = (result.paths ?? []).filter((ip) => !declaredPaths.some((dp) => dp.pattern === ip.pattern));
        result.paths = [...declaredPaths, ...inherited];
        result.pathsDir = dir;
      } else {
        result.malformed = true;
      }
    }
    // Same rule as TypeScript: paths resolve against the effective baseUrl when there is one.
    result.pathsBase = result.baseUrl ?? result.pathsDir;
    this.byFile.set(configPath, result);
    return result;
  }
}

/**
 * Matches a pattern containing at most one `*` against `specifier`.
 * Returns the captured substring for `*`, `""` for exact match, or `undefined`.
 */
function matchPattern(pattern: string, specifier: string): string | undefined {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === specifier ? '' : undefined;
  // Multiple `*` wildcards in a single exports/imports pattern key are not supported by Node's PATTERN_KEY_COMPARE.
  if (pattern.indexOf('*', star + 1) !== -1) return undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (specifier.length < prefix.length + suffix.length) return undefined;
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

/**
 * Node.js `PATTERN_KEY_COMPARE`:
 * 1. Longer prefix before `*` (`baseLength`) wins.
 * 2. If tied, longer suffix after `*` (i.e. longer total key length) wins.
 */
export function patternKeyCompare(keyA: string, keyB: string): number {
  const starA = keyA.indexOf('*');
  const starB = keyB.indexOf('*');
  const baseLenA = starA === -1 ? keyA.length : starA + 1;
  const baseLenB = starB === -1 ? keyB.length : starB + 1;
  if (baseLenA !== baseLenB) return baseLenB - baseLenA;
  if (keyA.length !== keyB.length) return keyB.length - keyA.length;
  return 0;
}

/** Specifiers that look like local aliases even when no config explains them. */
const ALIAS_LIKE = /^(?:[@~#$]\/|~(?:\/|$)|#|\$(?:lib|app)?(?:\/|$))/;

const BUILTIN_MODULES = new Set<string>([
  ...builtinModules,
  ...builtinModules.map((m) => (m.startsWith('node:') ? m.slice(5) : `node:${m}`)),
]);

function isBuiltinModule(specifier: string): boolean {
  if (BUILTIN_MODULES.has(specifier)) return true;
  const slash = specifier.indexOf('/');
  if (slash !== -1 && BUILTIN_MODULES.has(specifier.slice(0, slash))) return true;
  return false;
}

function extractBarePackageName(specifier: string): string | undefined {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) {
    return undefined;
  }
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    const scope = parts[0];
    const name = parts[1];
    if (!scope || scope.length <= 1 || !name) return undefined;
    return `${scope}/${name}`;
  }
  const parts = specifier.split('/');
  return parts[0] || undefined;
}

export class ImportResolver {
  private readonly tsconfig: TsConfigPaths;
  private readonly packages: LocalPackages;

  constructor(private readonly files: RepoFiles) {
    this.tsconfig = new TsConfigPaths(files);
    this.packages = new LocalPackages(files, this.tsconfig);
  }

  resolve(fromFile: string, rawSpecifier: string, explicitMode?: 'import' | 'require'): Resolution {
    const detailed = this.resolveDetailed(fromFile, rawSpecifier, explicitMode);
    if (detailed.kind === 'file') return { kind: 'file', path: detailed.path };
    if (detailed.kind === 'external') return { kind: 'external' };
    return { kind: 'unresolved' };
  }

  resolveDetailed(
    fromFile: string,
    rawSpecifier: string,
    explicitMode?: 'import' | 'require',
    options?: ResolveOptions,
  ): DetailedResolution {
    // Drop query/hash suffixes (`./x.svg?raw`), but a leading `#` is a subpath alias (`#utils` or `#/utils`).
    const specifier = rawSpecifier.startsWith('#')
      ? rawSpecifier.replace(/\?.*$/, '')
      : rawSpecifier.replace(/[?#].*$/, '');
    if (specifier === '') {
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'invalid-target' };
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
      return { kind: 'external' }; // node:fs, https://, data:
    }

    const fromDir = posix.dirname(fromFile) === '.' ? '' : posix.dirname(fromFile);

    // 1. Relative specifiers (`./...`, `../...`, `.`, `..`)
    if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') {
      const joined = posix.normalize(fromDir ? posix.join(fromDir, specifier) : specifier);
      if (joined === '..' || joined.startsWith('../') || posix.isAbsolute(joined)) {
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'invalid-target' };
      }
      if (this.files.isInvalidTarget?.(joined, '')) {
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'invalid-target' };
      }
      const found = resolveFile(joined, this.files);
      if (found) {
        if (this.files.isWithinDir && !this.files.isWithinDir(found, '')) {
          return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'invalid-target' };
        }
        return { kind: 'file', path: found, via: 'relative' };
      }
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'target-missing' };
    }

    // 2. Absolute paths (`/foo/bar`) are invalid module specifiers in repo context
    if (specifier.startsWith('/')) {
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'invalid-target' };
    }

    const mode = explicitMode ?? (fromFile.endsWith('.cjs') || fromFile.endsWith('.cts') ? 'require' : 'import');
    const config = this.tsconfig.forFile(fromFile);
    const customConditions = config?.customConditions ?? [];
    const typeOnlyImport = options?.typeOnlyImport ?? false;

    // 3. Node.js subpath imports (`#...`) via nearest enclosing `package.json#imports`
    if (specifier.startsWith('#')) {
      const importsResult = this.packages.resolveSubpathImport(
        fromFile,
        specifier,
        mode,
        customConditions,
        typeOnlyImport,
      );
      if (importsResult !== undefined) {
        // If `#/foo` was not matched by `package.json#imports`, allow `tsconfig.paths` (e.g. `#/*`) to try before failing.
        if (importsResult.kind !== 'unresolved') {
          return importsResult;
        }
        const viaPaths = this.tryResolvePaths(config, specifier);
        if (viaPaths?.kind === 'file') return viaPaths;
        return importsResult;
      }
      const viaPaths = this.tryResolvePaths(config, specifier);
      if (viaPaths) {
        if (viaPaths.kind === 'file') return viaPaths;
        return {
          kind: 'unresolved',
          reason: 'unmatched',
          reasonCode: viaPaths.sawInvalidTarget ? 'invalid-target' : 'target-missing',
        };
      }
      if (config?.malformed) {
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'unsupported-config' };
      }
      if (specifier === '#') {
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'invalid-target' };
      }
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'alias-unmatched' };
    }

    // 4. TypeScript `paths` and `baseUrl`
    const pathsAttempt = this.tryResolvePaths(config, specifier);
    if (pathsAttempt?.kind === 'file') {
      return pathsAttempt;
    }

    if (config?.baseUrl !== undefined) {
      const baseCandidate = posix.normalize(config.baseUrl ? posix.join(config.baseUrl, specifier) : specifier);
      if (baseCandidate !== '..' && !baseCandidate.startsWith('../') && !posix.isAbsolute(baseCandidate)) {
        const found = resolveFile(baseCandidate, this.files);
        if (found) {
          if (this.files.isWithinDir && !this.files.isWithinDir(found, '')) {
            return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'invalid-target' };
          }
          return { kind: 'file', path: found, via: 'paths' };
        }
      }
    }

    // 5. Workspace / local packages (`package.json#exports` or workspace fallbacks)
    const local = this.packages.resolveDetailed(specifier, mode, customConditions, typeOnlyImport);
    if (local) return local;

    // 6. Built-in modules (e.g. `fs`, `path/posix`)
    if (isBuiltinModule(specifier)) {
      return { kind: 'external' };
    }

    // 7. If `tsconfig.paths` matched the specifier and pointed into `node_modules/` or an external package, check external
    if (this.packages.isDeclaredExternal(specifier, fromFile)) {
      return { kind: 'external' };
    }
    if (pathsAttempt?.sawNodeModulesTarget && extractBarePackageName(specifier) !== undefined) {
      return { kind: 'external' };
    }

    // 8. If `tsconfig.paths` matched the specifier but its target file was missing or invalid, report that
    if (pathsAttempt) {
      return {
        kind: 'unresolved',
        reason: 'unmatched',
        reasonCode: pathsAttempt.sawInvalidTarget ? 'invalid-target' : 'target-missing',
      };
    }

    if (config?.malformed) {
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'unsupported-config' };
    }

    // 9. Unmatched alias-like specifier (`@/foo`, `~/bar`, `$lib/baz`)
    if (ALIAS_LIKE.test(specifier)) {
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'alias-unmatched' };
    }

    // 10. Bare specifier that is neither a workspace package nor a declared external dependency
    const bareName = extractBarePackageName(specifier);
    if (!bareName) {
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'invalid-target' };
    }
    if (this.packages.hasWorkspaceConfigError()) {
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'unsupported-config' };
    }
    if (this.packages.isUnknownBarePackage(bareName)) {
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'unknown-package' };
    }
    return { kind: 'external' };
  }

  private tryResolvePaths(
    config: PathsConfig | null,
    specifier: string,
  ):
    | { kind: 'file'; path: string; via: 'paths' }
    | { kind: 'unmatched-paths'; sawInvalidTarget: boolean; sawNodeModulesTarget: boolean }
    | undefined {
    if (!config?.paths) return undefined;
    const matches = config.paths
      .map((entry) => ({ entry, capture: matchPattern(entry.pattern, specifier) }))
      .filter((m): m is { entry: PathEntry; capture: string } => m.capture !== undefined)
      .sort((x, y) => patternKeyCompare(x.entry.pattern, y.entry.pattern));

    if (matches.length === 0) return undefined;

    let sawInvalidTarget = false;
    let sawNodeModulesTarget = false;

    for (const { entry, capture } of matches) {
      for (const target of entry.targets) {
        const substituted = target.replace('*', capture);
        const joined = posix.normalize(entry.base ? posix.join(entry.base, substituted) : substituted);
        if (joined === '..' || joined.startsWith('../') || posix.isAbsolute(joined)) {
          sawInvalidTarget = true;
          continue;
        }
        if (joined.startsWith('node_modules/') || joined.includes('/node_modules/')) {
          sawNodeModulesTarget = true;
        }
        if (this.files.isInvalidTarget?.(joined, '')) {
          sawInvalidTarget = true;
          continue;
        }
        const found = resolveFile(joined, this.files);
        if (found) {
          if (this.files.isWithinDir && !this.files.isWithinDir(found, '')) {
            sawInvalidTarget = true;
            continue;
          }
          return { kind: 'file', path: found, via: 'paths' };
        }
      }
    }
    return { kind: 'unmatched-paths', sawInvalidTarget, sawNodeModulesTarget };
  }
}

interface LocalPackage {
  name: string;
  dir: string;
  json: Record<string, unknown>;
}

interface EnclosingPackageJson {
  dir: string;
  json?: Record<string, unknown>;
  malformed?: boolean;
}

type TargetEvalResult =
  | { status: 'resolved'; path: string; heuristic?: boolean; typeOnlyTarget?: boolean }
  | { status: 'external' }
  | { status: 'blocked' }
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'unsupported' }
  | { status: 'unknown-package' }
  | { status: 'ambiguous-package' }
  | { status: 'unmatched-condition' };

/**
 * Parses `pnpm-workspace.yaml` without external dependencies.
 * Supports `packages:` list items (`- 'packages/*'`, `- "!packages/ignored"`, inline `packages: [...]`)
 * and `catalog:` / `catalogs:` dependency keys.
 */
export function parsePnpmWorkspaceYaml(text: string): {
  packages: string[];
  catalogDeps: string[];
  malformed: boolean;
} {
  const packages: string[] = [];
  const catalogDeps: string[] = [];
  const lines = text.split(/\r?\n/);

  let section: 'none' | 'packages' | 'catalog' | 'catalogs' | 'other' = 'none';
  let sawPackagesKey = false;
  let malformed = false;

  const unquote = (raw: string): string => {
    const trimmed = raw.trim();
    if (
      (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))
    ) {
      return trimmed.slice(1, -1);
    }
    return trimmed.replace(/\s+#.*$/, '').trim();
  };

  for (const rawLine of lines) {
    const withoutComment = rawLine.replace(/^\s*#.*$/, '');
    if (withoutComment.trim() === '') continue;
    if (rawLine.startsWith('\t')) {
      malformed = true;
      continue;
    }

    const indent = rawLine.match(/^(\s*)/)?.[1]?.length ?? 0;
    const trimmed = rawLine.trim();

    if (indent === 0) {
      const topMatch = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(trimmed);
      if (!topMatch) {
        malformed = true;
        continue;
      }
      const key = topMatch[1] ?? '';
      const restRaw = topMatch[2] ?? '';
      const rest = restRaw.replace(/\s+#.*$/, '').trim();
      if (key === 'packages') {
        sawPackagesKey = true;
        section = 'packages';
        if (rest !== '') {
          if (rest.startsWith('[') && rest.endsWith(']')) {
            const inner = rest.slice(1, -1).trim();
            if (inner !== '') {
              for (const part of inner.split(',')) {
                const val = unquote(part);
                if (val) packages.push(val);
              }
            }
          } else {
            malformed = true;
          }
        }
      } else if (key === 'catalog') {
        section = 'catalog';
      } else if (key === 'catalogs') {
        section = 'catalogs';
      } else {
        section = 'other';
      }
      continue;
    }

    if (section === 'packages') {
      if (trimmed.startsWith('-')) {
        const item = unquote(trimmed.slice(1));
        if (item) {
          packages.push(item);
        } else {
          malformed = true;
        }
      } else {
        malformed = true;
      }
    } else if (section === 'catalog' || section === 'catalogs') {
      const depMatch = /^(['"]?[@A-Za-z0-9._/-]+['"]?)\s*:/.exec(trimmed);
      if (depMatch?.[1]) {
        const depName = unquote(depMatch[1]);
        if (depName && indent >= 2) catalogDeps.push(depName);
      }
    }
  }

  if (!sawPackagesKey && text.trim() !== '') {
    malformed = true;
  }

  return { packages, catalogDeps, malformed };
}

function matchWorkspaceDirectories(globs: readonly string[], candidateDirs: readonly string[]): Set<string> {
  const included = new Set<string>();
  const positiveGlobs: string[] = [];
  const negativeGlobs: string[] = [];

  for (const raw of globs) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const isNegated = trimmed.startsWith('!');
    const clean = (isNegated ? trimmed.slice(1) : trimmed)
      .trim()
      .replace(/^\.\//, '')
      .replace(/\/package\.json$/, '')
      .replace(/\/+$/, '');
    if (!clean) continue;
    if (isNegated) negativeGlobs.push(clean);
    else positiveGlobs.push(clean);
  }

  for (const pattern of positiveGlobs) {
    const regex = globToRegExp(pattern);
    for (const dir of candidateDirs) {
      if (!dir) continue;
      if (regex.test(dir)) {
        included.add(dir);
      }
    }
  }

  for (const pattern of negativeGlobs) {
    const regex = globToRegExp(pattern);
    const trimmedWildcard = pattern.endsWith('/**') ? pattern.slice(0, -3) : undefined;
    const trimmedRegex = trimmedWildcard ? globToRegExp(trimmedWildcard) : undefined;
    for (const dir of [...included]) {
      if (
        regex.test(dir) ||
        dir === pattern ||
        dir.startsWith(`${pattern}/`) ||
        (trimmedRegex !== undefined && trimmedRegex.test(dir))
      ) {
        included.delete(dir);
      }
    }
  }

  return included;
}

/**
 * Packages that live in this repository (the root package and monorepo workspaces declared
 * in `package.json#workspaces`, `pnpm-workspace.yaml`, or `lerna.json`).
 */
export class LocalPackages {
  private initialized = false;
  private readonly packagesByName = new Map<string, LocalPackage>();
  private readonly ambiguousNames = new Set<string>();
  private readonly unsupportedConfigNames = new Set<string>();
  private readonly nonWorkspaceNames = new Set<string>();
  private readonly workspaceScopes = new Set<string>();
  private readonly packageJsonByDir = new Map<string, EnclosingPackageJson>();
  private readonly declaredExternals = new Set<string>();
  private workspaceConfigError = false;
  private anyManifest = false;
  private hasAnyDependencyField = false;

  constructor(
    private readonly files: RepoFiles & { list(): Iterable<string> },
    private readonly tsconfig?: TsConfigPaths,
  ) {}

  hasWorkspaceConfigError(): boolean {
    this.ensureInitialized();
    return this.workspaceConfigError;
  }

  hasAnyManifest(): boolean {
    this.ensureInitialized();
    return this.anyManifest;
  }

  isDeclaredExternal(specifier: string, _fromFile?: string): boolean {
    this.ensureInitialized();
    const pkgName = extractBarePackageName(specifier);
    if (!pkgName) return false;
    return this.declaredExternals.has(pkgName);
  }

  isUnknownBarePackage(bareName: string): boolean {
    this.ensureInitialized();
    if (this.declaredExternals.has(bareName)) return false;
    if (this.nonWorkspaceNames.has(bareName)) return true;
    if (bareName.startsWith('@')) {
      const scope = bareName.split('/')[0];
      if (scope && this.workspaceScopes.has(scope)) return true;
    }
    return this.hasAnyDependencyField;
  }

  resolve(specifier: string, mode: 'import' | 'require' = 'import'): Resolution | undefined {
    const detailed = this.resolveDetailed(specifier, mode, [], false);
    if (!detailed) return undefined;
    if (detailed.kind === 'file') return { kind: 'file', path: detailed.path };
    if (detailed.kind === 'external') return { kind: 'external' };
    return { kind: 'unresolved' };
  }

  resolveDetailed(
    specifier: string,
    mode: 'import' | 'require' = 'import',
    customConditions: readonly string[] = [],
    typeOnlyImport = false,
  ): DetailedResolution | undefined {
    this.ensureInitialized();
    const matchedName = this.findMatchingPackageName(specifier);
    if (!matchedName) return undefined;

    if (this.unsupportedConfigNames.has(matchedName)) {
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'unsupported-config' };
    }
    if (this.ambiguousNames.has(matchedName)) {
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'ambiguous-package' };
    }

    const pkg = this.packagesByName.get(matchedName);
    if (!pkg) return undefined;

    const subpath = specifier === pkg.name ? '' : specifier.slice(pkg.name.length + 1);
    return this.resolvePackageSubpath(pkg, subpath, mode, customConditions, typeOnlyImport);
  }

  resolveSubpathImport(
    fromFile: string,
    specifier: string,
    mode: 'import' | 'require',
    customConditions: readonly string[],
    typeOnlyImport: boolean,
    visited: Set<string> = new Set(),
    depth = 0,
  ): DetailedResolution | undefined {
    this.ensureInitialized();
    if (depth > 10 || visited.has(specifier)) {
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'invalid-target' };
    }

    const enclosing = this.findEnclosingPackageWithImports(fromFile);
    if (!enclosing) return undefined;
    if (enclosing.malformed || !enclosing.json) {
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'unsupported-config' };
    }

    const importsField = enclosing.json.imports;
    if (importsField === undefined) return undefined;

    if (specifier === '#' || specifier.startsWith('#/')) {
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'invalid-target' };
    }
    if (importsField === null || typeof importsField !== 'object' || Array.isArray(importsField)) {
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'unsupported-config' };
    }

    const map = importsField as Record<string, unknown>;
    for (const key of Object.keys(map)) {
      if (!key.startsWith('#') || key === '#' || key.startsWith('#/')) {
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'invalid-target' };
      }
    }

    let matchedTargetValue: unknown;
    let matchedCapture: string | undefined;
    let hasMatch = false;

    if (!specifier.includes('*') && Object.prototype.hasOwnProperty.call(map, specifier)) {
      hasMatch = true;
      matchedTargetValue = map[specifier];
      matchedCapture = undefined;
    } else {
      const patternKeys = Object.keys(map)
        .filter((k) => k.includes('*') && matchPattern(k, specifier) !== undefined)
        .sort(patternKeyCompare);
      const bestKey = patternKeys[0];
      if (bestKey !== undefined) {
        hasMatch = true;
        matchedTargetValue = map[bestKey];
        matchedCapture = matchPattern(bestKey, specifier);
      }
    }

    if (!hasMatch) {
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'not-exported' };
    }

    const nextVisited = new Set(visited);
    nextVisited.add(specifier);

    const evalRes = this.evaluateImportsTarget(
       { name: typeof enclosing.json.name === 'string' ? enclosing.json.name : '', dir: enclosing.dir, json: enclosing.json },
      fromFile,
      matchedTargetValue,
      matchedCapture,
      mode,
      customConditions,
      typeOnlyImport,
      nextVisited,
      depth,
    );

    return this.targetEvalToResolution(evalRes, 'imports');
  }

  private findEnclosingPackageWithImports(fromFile: string): EnclosingPackageJson | undefined {
    let dir = posix.dirname(fromFile) === '.' ? '' : posix.dirname(fromFile);
    let nearestWithImports: EnclosingPackageJson | undefined;
    let nearestMalformed: EnclosingPackageJson | undefined;
    while (true) {
      const entry = this.packageJsonByDir.get(dir);
      if (entry) {
        if (entry.malformed) {
          nearestMalformed ??= entry;
        } else if (entry.json && entry.json.imports !== undefined) {
          nearestWithImports = entry;
          break;
        }
      }
      if (dir === '') break;
      const parent = posix.dirname(dir);
      dir = parent === '.' ? '' : parent;
    }
    return nearestWithImports ?? nearestMalformed;
  }

  private findMatchingPackageName(specifier: string): string | undefined {
    const allNames = [
      ...this.packagesByName.keys(),
      ...this.ambiguousNames.values(),
      ...this.unsupportedConfigNames.values(),
    ];
    return allNames
      .filter((name) => specifier === name || specifier.startsWith(`${name}/`))
      .sort((a, b) => b.length - a.length)[0];
  }

  private resolvePackageSubpath(
    pkg: LocalPackage,
    subpath: string,
    mode: 'import' | 'require',
    customConditions: readonly string[],
    typeOnlyImport: boolean,
  ): DetailedResolution {
    const exportsField = pkg.json.exports;

    // Strict encapsulation when `exports` is present on `package.json`
    if (exportsField !== undefined) {
      if (exportsField === null || exportsField === false) {
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'not-exported' };
      }
      const exportKey = subpath ? `./${subpath}` : '.';
      const evalRes = this.resolveExportsField(pkg, exportKey, exportsField, mode, customConditions, typeOnlyImport);
      return this.targetEvalToResolution(evalRes, 'exports');
    }

    // Legacy / workspace resolution when `exports` is not defined (`via: 'workspace'`)
    if (subpath) {
      const normSub = posix.normalize(subpath);
      if (normSub === '..' || normSub.startsWith('../') || posix.isAbsolute(normSub)) {
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'invalid-target' };
      }
    }

    const candidates: { rel: string; heuristic?: boolean }[] = [];
    const sourceConfigured = customConditions.includes('source');

    if (!subpath) {
      if (sourceConfigured && typeof pkg.json.source === 'string') {
        candidates.push({ rel: pkg.json.source, heuristic: false });
      }
      const fieldOrder =
        mode === 'require'
          ? (['main', 'module', 'browser'] as const)
          : (['module', 'main', 'browser'] as const);
      for (const field of fieldOrder) {
        if (typeof pkg.json[field] === 'string') {
          candidates.push({ rel: pkg.json[field] as string });
        }
      }
      if (typeOnlyImport) {
        for (const field of ['types', 'typings'] as const) {
          if (typeof pkg.json[field] === 'string') {
            candidates.push({ rel: pkg.json[field] as string });
          }
        }
      }
      if (!sourceConfigured && typeof pkg.json.source === 'string') {
        candidates.push({ rel: pkg.json.source as string, heuristic: true });
      }
      candidates.push({ rel: 'src/index' }, { rel: 'index' });
    } else {
      candidates.push({ rel: subpath }, { rel: `src/${subpath}` }, { rel: `lib/${subpath}` });
    }

    let sawInvalid = false;
    for (const candidate of candidates) {
      const res = this.resolvePackageFileTarget(pkg, candidate.rel, candidate.heuristic ?? false);
      if (res.status === 'resolved') {
        return {
          kind: 'file',
          path: res.path,
          via: 'workspace',
          ...(res.heuristic ? { heuristic: true } : {}),
        };
      }
      if (res.status === 'invalid') {
        sawInvalid = true;
      }
    }

    return {
      kind: 'unresolved',
      reason: 'unmatched',
      reasonCode: sawInvalid ? 'invalid-target' : 'target-missing',
    };
  }

  private resolveExportsField(
    pkg: LocalPackage,
    exportKey: string,
    exportsField: unknown,
    mode: 'import' | 'require',
    customConditions: readonly string[],
    typeOnlyImport: boolean,
  ): TargetEvalResult {
    if (typeof exportsField === 'string' || Array.isArray(exportsField)) {
      if (exportKey !== '.') return { status: 'blocked' };
      return this.evaluateExportTarget(pkg, exportsField, undefined, mode, customConditions, typeOnlyImport);
    }

    if (!exportsField || typeof exportsField !== 'object') {
      return { status: 'unsupported' };
    }

    const map = exportsField as Record<string, unknown>;
    const keys = Object.keys(map);
    if (keys.length === 0) return { status: 'blocked' };

    const dotKeys = keys.filter((k) => k.startsWith('.'));
    const condKeys = keys.filter((k) => !k.startsWith('.'));

    // Mixing `.` subpath keys and condition keys at top level of `exports` is invalid in Node.js
    if (dotKeys.length > 0 && condKeys.length > 0) {
      return { status: 'unsupported' };
    }

    // Conditions-only object shorthand for `"."`
    if (dotKeys.length === 0) {
      if (exportKey !== '.') return { status: 'blocked' };
      return this.evaluateExportTarget(pkg, map, undefined, mode, customConditions, typeOnlyImport);
    }

    // 1. Exact subpath key match
    if (!exportKey.includes('*') && Object.prototype.hasOwnProperty.call(map, exportKey)) {
      return this.evaluateExportTarget(pkg, map[exportKey], undefined, mode, customConditions, typeOnlyImport);
    }

    // 2. Wildcard pattern match sorted by Node's `PATTERN_KEY_COMPARE`
    const matchingPatterns = dotKeys
      .filter((k) => k.includes('*') && matchPattern(k, exportKey) !== undefined)
      .sort(patternKeyCompare);

    if (matchingPatterns.length === 0) {
      return { status: 'blocked' };
    }

    // Node evaluates the highest-specificity pattern key; if it maps to `null`, it blocks less-specific wildcards
    const bestPattern = matchingPatterns[0];
    if (bestPattern === undefined) {
      return { status: 'blocked' };
    }
    const capture = matchPattern(bestPattern, exportKey);
    return this.evaluateExportTarget(pkg, map[bestPattern], capture, mode, customConditions, typeOnlyImport);
  }

  private evaluateExportTarget(
    pkg: LocalPackage,
    targetValue: unknown,
    capture: string | undefined,
    mode: 'import' | 'require',
    customConditions: readonly string[],
    typeOnlyImport: boolean,
    inheritedHeuristic = false,
  ): TargetEvalResult {
    if (targetValue === null) {
      return { status: 'blocked' };
    }

    if (typeof targetValue === 'string') {
      if (!targetValue.startsWith('./')) {
        return { status: 'invalid' };
      }
      const substituted = capture !== undefined ? targetValue.replace(/\*/g, capture) : targetValue;
      return this.resolvePackageFileTarget(pkg, substituted, inheritedHeuristic);
    }

    if (Array.isArray(targetValue)) {
      if (targetValue.length === 0) return { status: 'blocked' };
      let firstFailure: TargetEvalResult | undefined;
      for (const item of targetValue) {
        const res = this.evaluateExportTarget(
          pkg,
          item,
          capture,
          mode,
          customConditions,
          typeOnlyImport,
          inheritedHeuristic,
        );
        if (res.status === 'resolved') return res;
        if (!firstFailure || (firstFailure.status === 'unmatched-condition' && res.status !== 'unmatched-condition')) {
          firstFailure = res;
        }
      }
      return firstFailure ?? { status: 'blocked' };
    }

    if (targetValue && typeof targetValue === 'object') {
      const conditions = targetValue as Record<string, unknown>;
      return this.evaluateConditionalObject(
        conditions,
        mode,
        customConditions,
        typeOnlyImport,
        (subTarget, isHeuristic) =>
          this.evaluateExportTarget(
            pkg,
            subTarget,
            capture,
            mode,
            customConditions,
            typeOnlyImport,
            inheritedHeuristic || isHeuristic,
          ),
      );
    }

    return { status: 'unsupported' };
  }

  private evaluateImportsTarget(
    pkg: LocalPackage,
    fromFile: string,
    targetValue: unknown,
    capture: string | undefined,
    mode: 'import' | 'require',
    customConditions: readonly string[],
    typeOnlyImport: boolean,
    visited: Set<string>,
    depth: number,
    inheritedHeuristic = false,
  ): TargetEvalResult {
    if (targetValue === null) {
      return { status: 'blocked' };
    }

    if (typeof targetValue === 'string') {
      const substituted = capture !== undefined ? targetValue.replace(/\*/g, capture) : targetValue;
      if (substituted.startsWith('./')) {
        return this.resolvePackageFileTarget(pkg, substituted, inheritedHeuristic);
      }
      if (substituted.startsWith('../') || substituted === '..' || substituted.startsWith('/')) {
        return { status: 'invalid' };
      }
      if (substituted.startsWith('#')) {
        if (substituted === '#' || substituted.startsWith('#/')) {
          return { status: 'invalid' };
        }
        const nested = this.resolveSubpathImport(
          fromFile,
          substituted,
          mode,
          customConditions,
          typeOnlyImport,
          visited,
          depth + 1,
        );
        if (!nested) return { status: 'blocked' };
        if (nested.kind === 'file') {
          return {
            status: 'resolved',
            path: nested.path,
            heuristic: inheritedHeuristic || Boolean(nested.heuristic),
          };
        }
        if (nested.kind === 'external') return { status: 'external' };
        return this.reasonCodeToTargetEval(nested.reasonCode);
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(substituted) || isBuiltinModule(substituted)) {
        return { status: 'external' };
      }
      const wsRes = this.resolveDetailed(substituted, mode, customConditions, typeOnlyImport);
      if (wsRes) {
        if (wsRes.kind === 'file') {
          return {
            status: 'resolved',
            path: wsRes.path,
            heuristic: inheritedHeuristic || Boolean(wsRes.heuristic),
          };
        }
        if (wsRes.kind === 'external') return { status: 'external' };
        return this.reasonCodeToTargetEval(wsRes.reasonCode);
      }
      if (this.isDeclaredExternal(substituted, fromFile)) {
        return { status: 'external' };
      }
      const bareSub = extractBarePackageName(substituted);
      if (bareSub !== undefined) {
        return this.isUnknownBarePackage(bareSub) ? { status: 'unknown-package' } : { status: 'external' };
      }
      return { status: 'invalid' };
    }

    if (Array.isArray(targetValue)) {
      if (targetValue.length === 0) return { status: 'blocked' };
      let firstFailure: TargetEvalResult | undefined;
      for (const item of targetValue) {
        const res = this.evaluateImportsTarget(
          pkg,
          fromFile,
          item,
          capture,
          mode,
          customConditions,
          typeOnlyImport,
          visited,
          depth,
          inheritedHeuristic,
        );
        if (res.status === 'resolved' || res.status === 'external') return res;
        if (!firstFailure || (firstFailure.status === 'unmatched-condition' && res.status !== 'unmatched-condition')) {
          firstFailure = res;
        }
      }
      return firstFailure ?? { status: 'blocked' };
    }

    if (targetValue && typeof targetValue === 'object') {
      const conditions = targetValue as Record<string, unknown>;
      return this.evaluateConditionalObject(
        conditions,
        mode,
        customConditions,
        typeOnlyImport,
        (subTarget, isHeuristic) =>
          this.evaluateImportsTarget(
            pkg,
            fromFile,
            subTarget,
            capture,
            mode,
            customConditions,
            typeOnlyImport,
            visited,
            depth,
            inheritedHeuristic || isHeuristic,
          ),
      );
    }

    return { status: 'unsupported' };
  }

  /**
   * Evaluates a conditional `exports` or `imports` object according to RA-09 Section 3:
   * - `import` and `require` are mutually exclusive (`mode === 'require'` vs `'import'`).
   * - `default` is evaluated last and never overrides a more specific matching condition.
   * - `types` is only matched when `typeOnlyImport` is true.
   * - `source` is a normal condition when present in `customConditions`, or a heuristic
   *   fallback (`heuristic: true`) when no standard condition resolves to an existing file.
   */
  private evaluateConditionalObject(
    conditions: Record<string, unknown>,
    mode: 'import' | 'require',
    customConditions: readonly string[],
    typeOnlyImport: boolean,
    recurse: (subTarget: unknown, isHeuristic: boolean) => TargetEvalResult,
  ): TargetEvalResult {
    const customSet = new Set(customConditions);
    const activeNonDefault = new Set<string>([
      ...customConditions,
      'node',
      mode === 'require' ? 'require' : 'import',
      ...(mode === 'import' ? ['module'] : []),
      'development',
      'browser',
      ...(typeOnlyImport ? ['types'] : []),
    ]);

    let missingResult: TargetEvalResult | undefined;
    let sawActiveBranch = false;

    // First pass: non-`default` active conditions in object key order (except if `types` is active, allow it)
    for (const [key, val] of Object.entries(conditions)) {
      if (key === 'default') continue;
      if (!activeNonDefault.has(key)) continue;
      sawActiveBranch = true;
      const res = recurse(val, false);
      if (res.status === 'resolved' || res.status === 'external' || res.status === 'blocked' || res.status === 'invalid' || res.status === 'unsupported' || res.status === 'ambiguous-package' || res.status === 'unknown-package') {
        return res;
      }
      if (res.status === 'missing') {
        missingResult ??= res;
      }
    }

    // Second pass: `default` condition (always last among standard conditions, only if no specific condition matched or resolved)
    if (!sawActiveBranch && Object.prototype.hasOwnProperty.call(conditions, 'default')) {
      sawActiveBranch = true;
      const res = recurse(conditions.default, false);
      if (res.status === 'resolved' || res.status === 'external' || res.status === 'blocked' || res.status === 'invalid' || res.status === 'unsupported' || res.status === 'ambiguous-package' || res.status === 'unknown-package') {
        return res;
      }
      if (res.status === 'missing') {
        missingResult ??= res;
      }
    }

    // Third pass: heuristic `source` condition fallback when `source` was not in `customConditions`
    if (!customSet.has('source') && Object.prototype.hasOwnProperty.call(conditions, 'source') && conditions.source !== null) {
      const res = recurse(conditions.source, true);
      if (res.status === 'resolved' || res.status === 'external') {
        return res;
      }
      if (res.status === 'missing') {
        missingResult ??= res;
      }
    }

    if (missingResult) return missingResult;
    return { status: 'unmatched-condition' };
  }

  /**
   * Resolves a package-relative file target (`./...` or `src/...`) with:
   * 1. Boundary validation (cannot escape `pkg.dir` or traverse symlinks out of `pkg.dir`)
   * 2. Direct target check (`heuristic: false` unless `inheritedHeuristic`)
   * 3. `tsconfig` `outDir`/`declarationDir` -> `rootDir` remapping (`heuristic: false`)
   * 4. Bounded `dist/`/`build/`/`lib/`/`out/` -> `src/` heuristic (`heuristic: true`)
   */
  private resolvePackageFileTarget(
    pkg: LocalPackage,
    rawCandidate: string,
    inheritedHeuristic: boolean,
  ): TargetEvalResult {
    if (rawCandidate.includes('\0') || posix.isAbsolute(rawCandidate)) {
      return { status: 'invalid' };
    }
    const cleanRel = rawCandidate.replace(/^\.\//, '');
    const normRel = posix.normalize(cleanRel);
    if (normRel === '..' || normRel.startsWith('../') || posix.isAbsolute(normRel)) {
      return { status: 'invalid' };
    }

    const targetInRepo = pkg.dir ? posix.join(pkg.dir, normRel) : normRel;
    if (pkg.dir && targetInRepo !== pkg.dir && !targetInRepo.startsWith(`${pkg.dir}/`)) {
      return { status: 'invalid' };
    }

    if (this.files.isInvalidTarget?.(targetInRepo, pkg.dir)) {
      return { status: 'invalid' };
    }

    const checkResolved = (found: string, heuristic: boolean): TargetEvalResult => {
      if (pkg.dir && found !== pkg.dir && !found.startsWith(`${pkg.dir}/`)) {
        return { status: 'invalid' };
      }
      if (this.files.isWithinDir && !this.files.isWithinDir(found, pkg.dir)) {
        return { status: 'invalid' };
      }
      return { status: 'resolved', path: found, heuristic: inheritedHeuristic || heuristic };
    };

    // 1. Direct target resolution (existing built/source file wins without rewriting)
    const direct = resolveFile(targetInRepo, this.files);
    if (direct !== undefined) {
      return checkResolved(direct, false);
    }

    // 2. Tsconfig-backed `outDir` / `declarationDir` -> `rootDir` remapping (`heuristic: false`)
    const pkgConfig = this.tsconfig?.forPackageDir(pkg.dir);
    const mapping = pkgConfig?.sourceMapping;
    if (mapping && mapping.rootDir !== undefined) {
      for (const buildDir of [mapping.outDir, mapping.declarationDir]) {
        if (buildDir !== undefined && (targetInRepo === buildDir || targetInRepo.startsWith(`${buildDir}/`))) {
          const suffix = targetInRepo.slice(buildDir.length).replace(/^\//, '');
          const swappedSuffix = stripDeclarationExt(suffix);
          const remapped = mapping.rootDir ? posix.join(mapping.rootDir, swappedSuffix) : swappedSuffix;
          if (this.files.isInvalidTarget?.(remapped, pkg.dir)) {
            return { status: 'invalid' };
          }
          const found = resolveFile(remapped, this.files);
          if (found !== undefined) {
            return checkResolved(found, false);
          }
        }
      }
    }

    // 3. Bounded `dist/` / `lib/` / `build/` / `out/` -> `src/` heuristic (`heuristic: true`)
    const heuristicTarget = sourceForBuildOutput(targetInRepo, pkg.dir);
    if (heuristicTarget !== targetInRepo) {
      if (this.files.isInvalidTarget?.(heuristicTarget, pkg.dir)) {
        return { status: 'invalid' };
      }
      const found = resolveFile(heuristicTarget, this.files);
      if (found !== undefined) {
        return checkResolved(found, true);
      }
    }

    return { status: 'missing' };
  }

  private targetEvalToResolution(evalRes: TargetEvalResult, via: 'exports' | 'imports'): DetailedResolution {
    switch (evalRes.status) {
      case 'resolved':
        return {
          kind: 'file',
          path: evalRes.path,
          via,
          ...(evalRes.heuristic ? { heuristic: true } : {}),
        };
      case 'external':
        return { kind: 'external', via };
      case 'blocked':
      case 'unmatched-condition':
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'not-exported' };
      case 'missing':
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'target-missing' };
      case 'invalid':
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'invalid-target' };
      case 'unsupported':
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'unsupported-config' };
      case 'unknown-package':
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'unknown-package' };
      case 'ambiguous-package':
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'ambiguous-package' };
    }
  }

  private reasonCodeToTargetEval(reasonCode: ImportUnresolvedReasonCode): TargetEvalResult {
    switch (reasonCode) {
      case 'not-exported':
        return { status: 'blocked' };
      case 'target-missing':
        return { status: 'missing' };
      case 'invalid-target':
      case 'alias-unmatched':
        return { status: 'invalid' };
      case 'unsupported-config':
        return { status: 'unsupported' };
      case 'unknown-package':
        return { status: 'unknown-package' };
      case 'ambiguous-package':
        return { status: 'ambiguous-package' };
    }
  }

  private ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;

    const allPackageJsonFiles: string[] = [];
    let hasPnpmWorkspace = false;
    let hasLernaJson = false;

    for (const file of this.files.list()) {
      if (file.includes('node_modules/') || file.startsWith('.git/')) continue;
      if (file === 'package.json' || file.endsWith('/package.json')) {
        allPackageJsonFiles.push(file);
        this.anyManifest = true;
      } else if (file === 'pnpm-workspace.yaml') {
        hasPnpmWorkspace = true;
        this.anyManifest = true;
      } else if (file === 'lerna.json') {
        hasLernaJson = true;
        this.anyManifest = true;
      }
    }

    const candidateDirs = allPackageJsonFiles
      .map((f) => (posix.dirname(f) === '.' ? '' : posix.dirname(f)))
      .filter((d) => d !== '');

    const manifestSources: { name: string; globs: string[]; matched: Set<string> }[] = [];

    // 1. Parse root `package.json` if present
    if (this.files.exists('package.json')) {
      const raw = this.files.read('package.json');
      try {
        const json = JSON.parse(raw ?? '') as Record<string, unknown>;
        if (!json || typeof json !== 'object' || Array.isArray(json)) {
          this.workspaceConfigError = true;
          this.packageJsonByDir.set('', { dir: '', malformed: true });
        } else {
          this.packageJsonByDir.set('', { dir: '', json });
          this.collectDeclaredDependencies(json);
          if (json.workspaces !== undefined) {
            const wsGlobs = extractPackageJsonWorkspaces(json.workspaces);
            if (!wsGlobs) {
              this.workspaceConfigError = true;
            } else {
              manifestSources.push({
                name: 'package.json',
                globs: wsGlobs,
                matched: matchWorkspaceDirectories(wsGlobs, candidateDirs),
              });
            }
          }
        }
      } catch {
        this.workspaceConfigError = true;
        this.packageJsonByDir.set('', { dir: '', malformed: true });
        const nameMatch = /["']name["']\s*:\s*["']([^"']+)["']/.exec(raw ?? '');
        if (nameMatch?.[1]) this.unsupportedConfigNames.add(nameMatch[1]);
      }
    }

    // 2. Parse `pnpm-workspace.yaml` if present
    if (hasPnpmWorkspace) {
      const raw = this.files.read('pnpm-workspace.yaml') ?? '';
      const parsed = parsePnpmWorkspaceYaml(raw);
      if (parsed.catalogDeps.length > 0) this.hasAnyDependencyField = true;
      for (const dep of parsed.catalogDeps) this.declaredExternals.add(dep);
      if (parsed.malformed) {
        this.workspaceConfigError = true;
      } else {
        manifestSources.push({
          name: 'pnpm-workspace.yaml',
          globs: parsed.packages,
          matched: matchWorkspaceDirectories(parsed.packages, candidateDirs),
        });
      }
    }

    // 3. Parse `lerna.json` if present
    if (hasLernaJson) {
      const raw = this.files.read('lerna.json') ?? '';
      try {
        const json = JSON.parse(raw) as Record<string, unknown>;
        if (!json || typeof json !== 'object' || Array.isArray(json)) {
          this.workspaceConfigError = true;
        } else {
          const rawPkgs = json.packages === undefined ? ['packages/*'] : json.packages;
          if (!Array.isArray(rawPkgs) || !rawPkgs.every((p) => typeof p === 'string')) {
            this.workspaceConfigError = true;
          } else {
            const globs = rawPkgs as string[];
            manifestSources.push({
              name: 'lerna.json',
              globs,
              matched: matchWorkspaceDirectories(globs, candidateDirs),
            });
          }
        }
      } catch {
        this.workspaceConfigError = true;
      }
    }

    // 4. Combine workspace globs and detect conflicting workspace manifest declarations
    const allGlobs = manifestSources.flatMap((m) => m.globs);
    const activeWorkspaceDirs = matchWorkspaceDirectories(allGlobs, candidateDirs);
    const conflictingDirs = new Set<string>();

    if (manifestSources.length > 1) {
      const firstSet = manifestSources[0]!.matched;
      for (let i = 1; i < manifestSources.length; i++) {
        const otherSet = manifestSources[i]!.matched;
        for (const d of firstSet) {
          if (!otherSet.has(d)) conflictingDirs.add(d);
        }
        for (const d of otherSet) {
          if (!firstSet.has(d)) conflictingDirs.add(d);
        }
      }
      if (conflictingDirs.size > 0) {
        this.workspaceConfigError = true;
      }
    }

    // 5. Index all `package.json` files; only root and activeWorkspaceDirs are registered as local packages
    for (const file of allPackageJsonFiles) {
      const dir = posix.dirname(file) === '.' ? '' : posix.dirname(file);
      const isRoot = dir === '';
      const isWorkspaceMember = isRoot || activeWorkspaceDirs.has(dir) || conflictingDirs.has(dir);

      let entry = this.packageJsonByDir.get(dir);
      if (!entry) {
        const raw = this.files.read(file);
        try {
          const json = JSON.parse(raw ?? '') as Record<string, unknown>;
          if (!json || typeof json !== 'object' || Array.isArray(json)) {
            entry = { dir, malformed: true };
          } else {
            entry = { dir, json };
            this.collectDeclaredDependencies(json);
          }
        } catch {
          entry = { dir, malformed: true };
          if (isWorkspaceMember) {
            const nameMatch = /["']name["']\s*:\s*["']([^"']+)["']/.exec(raw ?? '');
            if (nameMatch?.[1]) this.unsupportedConfigNames.add(nameMatch[1]);
          }
        }
        this.packageJsonByDir.set(dir, entry);
      }

      if (!isWorkspaceMember) {
        const nonWsName = entry.json && typeof entry.json.name === 'string' ? entry.json.name.trim() : '';
        if (nonWsName) this.nonWorkspaceNames.add(nonWsName);
        continue;
      }

      if (entry.malformed || !entry.json) {
        this.workspaceConfigError = true;
        continue;
      }

      const pkgName = typeof entry.json.name === 'string' ? entry.json.name.trim() : '';
      if (!pkgName) continue;

      if (pkgName.startsWith('@') && pkgName.includes('/')) {
        const scope = pkgName.split('/')[0];
        if (scope) this.workspaceScopes.add(scope);
      }

      if (conflictingDirs.has(dir)) {
        this.unsupportedConfigNames.add(pkgName);
        continue;
      }

      if (this.ambiguousNames.has(pkgName)) {
        continue;
      }

      if (this.packagesByName.has(pkgName)) {
        this.packagesByName.delete(pkgName);
        this.ambiguousNames.add(pkgName);
        continue;
      }

      this.packagesByName.set(pkgName, {
        name: pkgName,
        dir,
        json: entry.json,
      });
    }
  }

  private collectDeclaredDependencies(json: Record<string, unknown>): void {
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = json[field];
      if (deps && typeof deps === 'object' && !Array.isArray(deps)) {
        this.hasAnyDependencyField = true;
        for (const depName of Object.keys(deps as Record<string, unknown>)) {
          this.declaredExternals.add(depName);
          if (depName.startsWith('@types/')) {
            const rawTypeName = depName.slice('@types/'.length);
            const sep = rawTypeName.indexOf('__');
            if (sep !== -1) {
              this.declaredExternals.add(`@${rawTypeName.slice(0, sep)}/${rawTypeName.slice(sep + 2)}`);
            } else {
              this.declaredExternals.add(rawTypeName);
            }
          }
        }
      }
    }
    for (const field of ['bundleDependencies', 'bundledDependencies']) {
      const bundled = json[field];
      if (Array.isArray(bundled)) {
        this.hasAnyDependencyField = true;
        for (const item of bundled) {
          if (typeof item === 'string') this.declaredExternals.add(item);
        }
      }
    }
  }
}

function extractPackageJsonWorkspaces(workspaces: unknown): string[] | undefined {
  if (Array.isArray(workspaces)) {
    if (workspaces.every((item) => typeof item === 'string')) {
      return workspaces as string[];
    }
    return undefined;
  }
  if (workspaces && typeof workspaces === 'object') {
    const pkgs = (workspaces as Record<string, unknown>).packages;
    if (Array.isArray(pkgs) && pkgs.every((item) => typeof item === 'string')) {
      return pkgs as string[];
    }
  }
  return undefined;
}

function stripDeclarationExt(filePath: string): string {
  if (filePath.endsWith('.d.ts')) return `${filePath.slice(0, -5)}.js`;
  if (filePath.endsWith('.d.mts')) return `${filePath.slice(0, -6)}.mjs`;
  if (filePath.endsWith('.d.cts')) return `${filePath.slice(0, -6)}.cjs`;
  return filePath;
}

/** Maps a published path such as `dist/esm/utils.js` back to a likely source file such as `src/utils.ts`. */
function sourceForBuildOutput(target: string, pkgDir: string): string {
  const rel = pkgDir ? target.slice(pkgDir.length + 1) : target;
  const rewritten = stripDeclarationExt(
    rel.replace(/^(?:dist|lib|build|out|esm|cjs)\/(?:(?:esm|cjs|types|es|mjs)\/)?/, 'src/'),
  );
  return pkgDir ? `${pkgDir}/${rewritten}` : rewritten;
}
