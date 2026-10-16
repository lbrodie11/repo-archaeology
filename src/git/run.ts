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
