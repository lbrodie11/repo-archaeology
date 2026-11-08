import { spawnSync } from 'node:child_process';
import { posix } from 'node:path';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import { isRegularTreeMode, parseLsTree, type TreeFileSet } from '../git/repo.js';
import { CONFIG_OVERRIDES, GitError } from '../git/run.js';
import { typescript } from './typescript.js';

export const MAX_SOURCE_BYTES = 1_000_000;
const DEFAULT_CAT_FILE_TIMEOUT_MS = 10_000;

/** Read access to the repository, using repo-relative POSIX paths. */
export interface RepoFiles {
  exists(path: string): boolean;
  read(path: string): string | undefined;
  /** Every file that exists (used to discover the repo's own packages). */
  list(): Iterable<string>;
  /** Starts any underlying background process (e.g. `git cat-file --batch`) if not already open. */
  open?(): void;
  /** Closes any underlying background process (e.g. `git cat-file --batch`). */
  close?(): void;
}

export interface GitTreeFiles extends RepoFiles {
  open(): void;
  close(): void;
  readonly pid: number | undefined;
  [Symbol.dispose](): void;
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
    const mode = modes.get(path);
    if (mode !== undefined && !isRegularTreeMode(mode)) {
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
    exists: (path) => existing.has(path),
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
    [Symbol.dispose]() {
      explicitlyClosed = true;
      closeInternal();
    },
  };
}

export type Resolution =
  | { kind: 'file'; path: string }
  /** A package from node_modules: not part of this repository. */
  | { kind: 'external' }
  /** Looks local (relative, alias, subpath import) but could not be resolved. */
  | { kind: 'unresolved' };

// Implementation files before declaration files: `./foo` with foo.js and foo.d.ts is foo.js.
const APPEND_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts', '.json'];
const INDEX_FILES = APPEND_EXTENSIONS.filter((e) => e !== '.d.ts' && e !== '.json').map((e) => `index${e}`);
// TypeScript lets `./foo.js` refer to `./foo.ts` in ESM projects.
const EXTENSION_SWAPS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx', '.d.ts'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/** Resolves `base` (a repo-relative path without query/hash) to an existing file. */
export function resolveFile(base: string, files: RepoFiles): string | undefined {
  const normalized = posix.normalize(base);
  if (normalized.startsWith('../') || normalized === '..' || posix.isAbsolute(normalized)) return undefined;
  const p = normalized === '.' ? '' : normalized.replace(/\/$/, '');
  if (p && files.exists(p)) return p;
  const ext = posix.extname(p);
  for (const swap of EXTENSION_SWAPS[ext] ?? []) {
    const candidate = p.slice(0, -ext.length) + swap;
    if (files.exists(candidate)) return candidate;
  }
  for (const e of APPEND_EXTENSIONS) {
    if (p && files.exists(p + e)) return p + e;
  }
  for (const index of INDEX_FILES) {
    const candidate = p ? `${p}/${index}` : index;
    if (files.exists(candidate)) return candidate;
  }
  return undefined;
}

export interface PathEntry {
  pattern: string;
  targets: string[];
  base: string;
}

interface PathsConfig {
  baseUrl?: string;
  paths?: PathEntry[];
  /** Directory of the config that declared `paths`. */
  pathsDir?: string;
  /** Where `paths` targets resolve from: the effective baseUrl, else `pathsDir`. */
  pathsBase?: string;
}

const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json', 'tsconfig.app.json'];

/**
 * Reads `baseUrl` and `paths` from the nearest tsconfig/jsconfig, following
 * relative `extends`. Results are cached per directory.
 */
export class TsConfigPaths {
  private readonly byDir = new Map<string, PathsConfig | null>();
  private readonly byFile = new Map<string, PathsConfig | null>();

  constructor(private readonly files: RepoFiles) { }

  forFile(filePath: string): PathsConfig | null {
    return this.forDir(posix.dirname(filePath));
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
    const json = parsed.config as {
      extends?: string | string[];
      references?: { path?: string }[];
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    } | undefined;
    if (!json) return null;

    const dir = posix.dirname(configPath);
    let result: PathsConfig = {};
    const parents = typeof json.extends === 'string' ? [json.extends] : Array.isArray(json.extends) ? json.extends : [];
    for (const parent of parents) {
      if (depth >= 5 || typeof parent !== 'string' || !(parent.startsWith('./') || parent.startsWith('../'))) continue;
      let parentPath = posix.normalize(posix.join(dir, parent));
      if (!parentPath.endsWith('.json')) parentPath += '.json';
      const inherited = this.load(parentPath, depth + 1);
      if (inherited) result = { ...result, ...inherited };
    }

    const references = Array.isArray(json.references) ? json.references : [];
    for (const ref of references) {
      if (depth >= 5 || typeof ref?.path !== 'string') continue;
      let refPath = posix.normalize(posix.join(dir, ref.path));
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
      result.baseUrl = posix.normalize(posix.join(dir, options.baseUrl));
    }
    if (options.paths && typeof options.paths === 'object' && !Array.isArray(options.paths)) {
      const currentBase = result.baseUrl ?? dir;
      const declaredPaths: PathEntry[] = Object.entries(options.paths)
        .filter(([, targets]) => Array.isArray(targets))
        .map(([pattern, targets]) => ({
          pattern,
          targets: targets.filter((t) => typeof t === 'string'),
          base: currentBase,
        }));
      // Child mappings override parent mappings for the same pattern, and come first.
      const inherited = (result.paths ?? []).filter((ip) => !declaredPaths.some((dp) => dp.pattern === ip.pattern));
      result.paths = [...declaredPaths, ...inherited];
      result.pathsDir = dir;
    }
    // Same rule as TypeScript: paths resolve against the effective baseUrl when there is one.
    result.pathsBase = result.baseUrl ?? result.pathsDir;
    this.byFile.set(configPath, result);
    return result;
  }
}

function matchPattern(pattern: string, specifier: string): string | undefined {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === specifier ? '' : undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (specifier.length < prefix.length + suffix.length) return undefined;
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

/** Specifiers that look like local aliases even when no config explains them. */
const ALIAS_LIKE = /^(?:[@~#$]\/|~(?:\/|$)|#|\$(?:lib|app)?(?:\/|$))/;

export class ImportResolver {
  private readonly tsconfig: TsConfigPaths;
  private readonly packages: LocalPackages;

  constructor(private readonly files: RepoFiles) {
    this.tsconfig = new TsConfigPaths(files);
    this.packages = new LocalPackages(files);
  }

  resolve(fromFile: string, rawSpecifier: string): Resolution {
    // Drop query/hash suffixes (`./x.svg?raw`), but a leading `#` is a subpath alias (`#/utils`).
    const specifier = rawSpecifier.startsWith('#') ? rawSpecifier.replace(/\?.*$/, '') : rawSpecifier.replace(/[?#].*$/, '');
    if (specifier === '') return { kind: 'unresolved' };
    if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return { kind: 'external' }; // node:fs, https://, data:

    if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') {
      const found = resolveFile(posix.join(posix.dirname(fromFile), specifier), this.files);
      return found ? { kind: 'file', path: found } : { kind: 'unresolved' };
    }
    if (specifier.startsWith('/')) return { kind: 'unresolved' };

    const config = this.tsconfig.forFile(fromFile);
    if (config?.paths) {
      const matches = config.paths
        .map((entry) => ({ entry, capture: matchPattern(entry.pattern, specifier) }))
        .filter((m): m is { entry: PathEntry; capture: string } => m.capture !== undefined)
        // TypeScript prefers an exact pattern, then the longest prefix before `*`.
        .sort((x, y) => prefixLength(y.entry.pattern) - prefixLength(x.entry.pattern));
      for (const { entry, capture } of matches) {
        for (const target of entry.targets) {
          const found = resolveFile(posix.join(entry.base, target.replace('*', capture)), this.files);
          if (found) return { kind: 'file', path: found };
        }
      }
      if (matches.length > 0) return { kind: 'unresolved' };
    }
    if (config?.baseUrl !== undefined) {
      const found = resolveFile(posix.join(config.baseUrl, specifier), this.files);
      if (found) return { kind: 'file', path: found };
    }
    const mode = fromFile.endsWith('.cjs') || fromFile.endsWith('.cts') ? 'require' : 'import';
    const local = this.packages.resolve(specifier, mode);
    if (local) return local;
    return ALIAS_LIKE.test(specifier) ? { kind: 'unresolved' } : { kind: 'external' };
  }
}

function prefixLength(pattern: string): number {
  const star = pattern.indexOf('*');
  return star === -1 ? Number.MAX_SAFE_INTEGER : star;
}

interface LocalPackage {
  name: string;
  dir: string;
  json: Record<string, unknown>;
}

/**
 * Packages that live in this repository (the root package and monorepo workspaces).
 * Imports such as `my-lib/utils` or `@acme/ui` point back into the repo, so they
 * must not be treated as external, or files would look unconnected when they are not.
 */
export class LocalPackages {
  private packages?: LocalPackage[];

  constructor(private readonly files: RepoFiles & { list(): Iterable<string> }) { }

  resolve(specifier: string, mode: 'import' | 'require' = 'import'): Resolution | undefined {
    const pkg = this.all()
      .filter((p) => specifier === p.name || specifier.startsWith(`${p.name}/`))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (!pkg) return undefined;
    const subpath = specifier.slice(pkg.name.length + 1);
    for (const candidate of packageCandidates(pkg.json, subpath, mode)) {
      const target = posix.join(pkg.dir, candidate);
      const sourceTarget = sourceForBuildOutput(target, pkg.dir);
      const found = resolveFile(sourceTarget, this.files) ?? resolveFile(target, this.files);
      if (found) return { kind: 'file', path: found };
    }
    return { kind: 'unresolved' };
  }

  private all(): LocalPackage[] {
    if (this.packages) return this.packages;
    this.packages = [];
    for (const file of this.files.list()) {
      if (file !== 'package.json' && !file.endsWith('/package.json')) continue;
      if (file.includes('node_modules/')) continue;
      try {
        const json = JSON.parse(this.files.read(file) ?? '') as Record<string, unknown>;
        if (typeof json.name === 'string' && json.name) this.packages.push({ name: json.name, dir: posix.dirname(file) === '.' ? '' : posix.dirname(file), json });
      } catch {
        // not valid JSON: ignore
      }
    }
    return this.packages;
  }
}

/** Paths (relative to the package) an import of `subpath` may point at, most likely first. */
function packageCandidates(json: Record<string, unknown>, subpath: string, mode: 'import' | 'require' = 'import'): string[] {
  const out: string[] = [];
  const exportKey = subpath ? `./${subpath}` : '.';
  const exportsField = json.exports;
  if (typeof exportsField === 'string' && !subpath) out.push(exportsField);
  else if (exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
    const map = exportsField as Record<string, unknown>;
    const isConditionsOnly = Object.keys(map).every((k) => !k.startsWith('.'));
    if (isConditionsOnly && !subpath) {
      out.push(...collectExportTargets(map, mode));
    } else {
      out.push(...collectExportTargets(map[exportKey], mode));
      for (const [key, value] of Object.entries(map)) {
        const capture = key.includes('*') ? matchPattern(key, exportKey) : undefined;
        if (capture !== undefined) {
          for (const target of collectExportTargets(value, mode)) {
            out.push(target.replace('*', capture));
          }
        }
      }
    }
  }
  if (!subpath) {
    for (const field of ['source', 'browser', 'module', 'main', 'types']) {
      if (typeof json[field] === 'string') out.push(json[field] as string);
    }
    out.push('src/index', 'index');
  } else {
    out.push(`src/${subpath}`, subpath, `lib/${subpath}`);
  }
  return [...new Set(out)];
}

/** Conditions a runtime import can match. `types` is only a fallback: runtime code never loads it. */
const ESM_CONDITIONS = new Set(['browser', 'development', 'import', 'module', 'node', 'default']);
const CJS_CONDITIONS = new Set(['browser', 'development', 'require', 'node', 'default']);
const RUNTIME_CONDITIONS = new Set(['browser', 'development', 'import', 'module', 'node', 'require', 'default']);

function collectExportTargets(value: unknown, mode: 'import' | 'require' = 'import'): string[] {
  const out: string[] = [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    for (const v of value) out.push(...collectExportTargets(v, mode));
    return out;
  }
  if (value && typeof value === 'object') {
    const conditions = value as Record<string, unknown>;
    // `source` is a widespread convention pointing straight at the source file.
    if (typeof conditions.source === 'string') out.push(conditions.source);
    // In Node.js, `import` and `require` are mutually exclusive conditions.
    const active = mode === 'require' ? CJS_CONDITIONS : ESM_CONDITIONS;
    for (const [key, target] of Object.entries(conditions)) {
      if (!active.has(key)) continue;
      out.push(...collectExportTargets(target, mode));
    }
    // Fall back to any runtime condition if mode-specific conditions yielded no targets
    if (out.length === 0) {
      for (const [key, target] of Object.entries(conditions)) {
        if (!RUNTIME_CONDITIONS.has(key)) continue;
        out.push(...collectExportTargets(target, mode));
      }
    }
    if (typeof conditions.types === 'string') out.push(conditions.types);
  }
  return out;
}

/** Maps a published path such as `dist/esm/utils.js` back to a likely source file such as `src/utils.ts`. */
function sourceForBuildOutput(target: string, pkgDir: string): string {
  const rel = pkgDir ? target.slice(pkgDir.length + 1) : target;
  const rewritten = rel.replace(/^(?:dist|lib|build|out|esm|cjs)\/(?:(?:esm|cjs|types|es|mjs)\/)?/, 'src/').replace(/\.d\.ts$/, '.ts');
  return pkgDir ? `${pkgDir}/${rewritten}` : rewritten;
}
