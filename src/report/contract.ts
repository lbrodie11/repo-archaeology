import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { UsageError } from '../context.js';

export const JSON_SCHEMA_VERSION = 1 as const;

export interface ToolInfo {
  name: 'repo-archaeology';
  version: string;
}

export type VersionedJson<T extends object> = {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  tool: ToolInfo;
} & T;

let cachedVersion: string | undefined;

export function getToolVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  const pkgPath = new URL('../../package.json', import.meta.url);
  const raw = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
  if (typeof raw.version !== 'string' || raw.version.trim() === '') {
    throw new Error('Unable to read version from package.json');
  }
  cachedVersion = raw.version.trim();
  return cachedVersion;
}

export function getToolInfo(): ToolInfo {
  return {
    name: 'repo-archaeology',
    version: getToolVersion(),
  };
}

export function withJsonContract<T extends object>(payload: T): VersionedJson<T> {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    tool: getToolInfo(),
    ...payload,
  };
}

export function formatJsonContract<T extends object>(payload: T): string {
  return `${JSON.stringify(withJsonContract(payload), null, 2)}\n`;
}

function nearestExistingAncestor(targetPath: string): string {
  let current = targetPath;
  while (true) {
    const st = lstatSync(current, { throwIfNoEntry: false });
    if (st) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function isInsideDir(childPath: string, parentDir: string): boolean {
  const rel = relative(parentDir, childPath);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertNotProtectedGitPath(targetPath: string): void {
  const parts = targetPath.split(/[\\/]+/);
  let gitIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]?.toLowerCase() === '.git') {
      gitIdx = i;
      break;
    }
  }
  if (gitIdx === -1) return;
  const afterGit = parts.slice(gitIdx + 1);
  // Allow writing inside .git/repo-archaeology/... (e.g. local scratch artifacts),
  // but never allow overwriting .git/config, .git/HEAD, .git/hooks/*, etc.
  if (afterGit.length < 2 || afterGit[0]?.toLowerCase() !== 'repo-archaeology') {
    throw new UsageError('--json-out cannot write directly into .git internal directories.');
  }
}

export interface WriteJsonOutOptions {
  cwd?: string;
  allowedRoot?: string;
}

/**
 * Validates `rawPath` for `--json-out` and returns the resolved target file path.
 */
export function validateJsonOutPath(rawPath: string, options: WriteJsonOutOptions = {}): string {
  if (typeof rawPath !== 'string' || rawPath.trim() === '' || /[\u0000-\u001f\u007f]/.test(rawPath)) {
    throw new UsageError('--json-out requires a valid file path.');
  }
  const baseDir = options.cwd ?? process.cwd();
  const targetPath = resolve(baseDir, rawPath);
  assertNotProtectedGitPath(targetPath);

  const existingStat = lstatSync(targetPath, { throwIfNoEntry: false });
  if (existingStat?.isSymbolicLink()) {
    throw new UsageError('--json-out refuses to write through a symbolic link.');
  }
  if (existingStat?.isDirectory()) {
    throw new UsageError('--json-out path points to a directory, not a file.');
  }
  if (existingStat && !existingStat.isFile()) {
    throw new UsageError('--json-out target must be a regular file.');
  }

  const ancestor = nearestExistingAncestor(dirname(targetPath));
  const resolvedAncestor = realpathSync.native(ancestor);
  const relativeRemainder = relative(ancestor, targetPath);
  const canonicalTarget = resolve(resolvedAncestor, relativeRemainder);
  assertNotProtectedGitPath(canonicalTarget);

  const allowedRoot = options.allowedRoot ?? process.env.REPO_ARCHAEOLOGY_JSON_OUT_ROOT;
  if (allowedRoot && allowedRoot.trim() !== '') {
    const resolvedAllowedRoot = realpathSync.native(resolve(baseDir, allowedRoot));
    if (!isInsideDir(canonicalTarget, resolvedAllowedRoot)) {
      throw new UsageError(`--json-out path must stay within ${resolvedAllowedRoot}.`);
    }
  }
  return targetPath;
}

/**
 * Validates `rawPath` and atomically writes the versioned JSON payload to disk.
 * Returns the resolved output file path.
 */
export function writeJsonContractFile<T extends object>(
  rawPath: string,
  payload: T,
  options: WriteJsonOutOptions = {},
): string {
  const targetPath = validateJsonOutPath(rawPath, options);
  const parentDir = dirname(targetPath);
  mkdirSync(parentDir, { recursive: true });
  const parentReal = realpathSync.native(parentDir);
  assertNotProtectedGitPath(join(parentReal, 'out.json'));

  const tmpPath = join(
    parentDir,
    `.repo-archaeology-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  const serialized = formatJsonContract(payload);
  try {
    writeFileSync(tmpPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
  return targetPath;
}
