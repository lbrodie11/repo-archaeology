import { spawnSync } from 'node:child_process';
import { posix } from 'node:path';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import { isRegularTreeMode, parseLsTree, type TreeFileSet } from '../git/repo.js';
import { CONFIG_OVERRIDES, GitError } from '../git/run.js';

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

/** The directory of a repo-relative POSIX path, `''` for the repository root. */
export function repoDirname(path: string): string {
  const dir = posix.dirname(path);
  return dir === '.' ? '' : dir;
}

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
