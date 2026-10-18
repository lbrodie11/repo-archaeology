import { spawn } from 'node:child_process';

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr = '',
    readonly exitCode: number | null = null,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Config overrides applied to every git call so user settings cannot change the
 * output format we parse (quoted paths, colors, relative paths, signatures) or
 * which history is reported (rename detection, the root commit's files, submodule
 * entries, commit message encoding). Replace refs are ignored too: `git replace`
 * can graft a different history onto the repository.
 */
const CONFIG_OVERRIDES = [
  '--no-replace-objects',
  '-c', 'core.quotepath=off',
  '-c', 'color.ui=never',
  '-c', 'log.showSignature=false',
  '-c', 'log.showRoot=true',
  '-c', 'diff.relative=false',
  '-c', 'diff.noprefix=false',
  '-c', 'diff.renames=true',
  '-c', 'diff.renameLimit=1000',
  '-c', 'diff.ignoreSubmodules=none',
  '-c', 'status.renames=true',
  '-c', 'status.renameLimit=1000',
  '-c', 'i18n.logOutputEncoding=UTF-8',
];

const MAX_STDERR = 64 * 1024;

interface SpawnResult {
  code: number | null;
  stderr: string;
}

function spawnGit(cwd: string, args: string[], onData: (chunk: string) => void): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...CONFIG_OVERRIDES, ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        // Read-only commands like `git status` must not take the index lock.
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        GIT_NO_REPLACE_OBJECTS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR) stderr += chunk;
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') reject(new GitError('git was not found on your PATH. Install git and try again.'));
      else reject(new GitError(`Failed to run git: ${err.message}`));
    });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

function failure(args: string[], result: SpawnResult): GitError {
  const detail = result.stderr.trim().split('\n').slice(-3).join('\n');
  return new GitError(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`, result.stderr, result.code);
}

/** Runs git and returns stdout. Rejects with GitError on a non-zero exit code. */
export async function runGit(cwd: string, args: string[]): Promise<string> {
  let out = '';
  const result = await spawnGit(cwd, args, (chunk) => {
    out += chunk;
  });
  if (result.code !== 0) throw failure(args, result);
  return out;
}

/** Runs git and reports whether it exited with code 0 (for --verify style checks). */
export async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  const result = await spawnGit(cwd, args, () => {});
  return result.code === 0;
}

/**
 * Streams git output split on NUL bytes (use with `-z`), so paths containing
 * newlines, spaces or unicode are never mangled and memory stays flat.
 */
export async function streamGitNulTokens(
  cwd: string,
  args: string[],
  onToken: (token: string) => void,
): Promise<void> {
  let remainder = '';
  let callbackError: unknown;
  const result = await spawnGit(cwd, args, (chunk) => {
    if (callbackError) return;
    const parts = (remainder + chunk).split('\0');
    remainder = parts.pop() ?? '';
    try {
      for (const part of parts) onToken(part);
    } catch (err) {
      callbackError = err;
    }
  });
  if (callbackError) throw callbackError;
  if (result.code !== 0) throw failure(args, result);
  if (remainder !== '') onToken(remainder);
}

/** Splits NUL-delimited output that has already been collected. */
export function splitNul(output: string): string[] {
  const parts = output.split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

export interface BoundedGitOptions {
  /** Maximum UTF-8 bytes of stdout to collect before truncating and stopping git. */
  maxBytes: number;
  /** Maximum execution time in milliseconds before stopping git. */
  timeoutMs: number;
  /** Treat all path arguments literally rather than as git pathspec globs/magic. */
  literalPathspecs?: boolean;
}

export interface BoundedGitResult {
  stdout: string;
  truncated: boolean;
  timedOut: boolean;
  exitCode: number | null;
  stderr: string;
}

/**
 * Runs git with strict output-byte and execution-time bounds using argument-array
 * subprocess execution (no shell). If stdout exceeds `maxBytes` or execution exceeds
 * `timeoutMs`, the git process is terminated cleanly and the partial output is returned
 * with `truncated` or `timedOut` set.
 */
export function runGitBounded(cwd: string, args: string[], options: BoundedGitOptions): Promise<BoundedGitResult> {
  return new Promise((resolve, reject) => {
    const isPosix = process.platform !== 'win32';
    const fullArgs = options.literalPathspecs ? ['--literal-pathspecs', ...CONFIG_OVERRIDES, ...args] : [...CONFIG_OVERRIDES, ...args];
    const child = spawn('git', fullArgs, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        GIT_NO_REPLACE_OBJECTS: '1',
        ...(options.literalPathspecs ? { GIT_LITERAL_PATHSPECS: '1' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: isPosix,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let bytesCollected = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (code !== 0 && !truncated && !timedOut) {
        reject(failure(args, { code, stderr }));
        return;
      }
      resolve({ stdout, truncated, timedOut, exitCode: code, stderr });
    };

    const signalChild = (signal: NodeJS.Signals) => {
      if (isPosix && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          // ignore if process group already exited
        }
      }
      try {
        child.kill(signal);
      } catch {
        // ignore if already exited
      }
    };

    const stopChild = () => {
      child.stdout.destroy();
      child.stderr.destroy();
      signalChild('SIGTERM');
      if (!killTimer) {
        killTimer = setTimeout(() => {
          signalChild('SIGKILL');
          settle(null);
        }, 200);
        killTimer.unref?.();
      }
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, Math.max(1, options.timeoutMs));
    timeout.unref?.();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (truncated || timedOut) return;
      const chunkBytes = Buffer.byteLength(chunk, 'utf8');
      if (bytesCollected + chunkBytes <= options.maxBytes) {
        stdout += chunk;
        bytesCollected += chunkBytes;
      } else {
        const remaining = Math.max(0, options.maxBytes - bytesCollected);
        if (remaining > 0) {
          stdout += Buffer.from(chunk, 'utf8').subarray(0, remaining).toString('utf8');
          bytesCollected = options.maxBytes;
        }
        truncated = true;
        stopChild();
      }
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR) stderr += chunk;
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (err.code === 'ENOENT') reject(new GitError('git was not found on your PATH. Install git and try again.'));
      else reject(new GitError(`Failed to run git: ${err.message}`));
    });
    child.on('exit', (code) => {
      if (truncated || timedOut) {
        settle(code);
      }
    });
    child.on('close', (code) => {
      settle(code);
    });
  });
}
