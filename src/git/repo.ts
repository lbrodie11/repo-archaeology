import { GitError, gitSucceeds, runGit, splitNul } from './run.js';

/** Returns the absolute path of the repository root containing `cwd`. */
export async function findRepoRoot(cwd: string): Promise<string> {
  try {
    return (await runGit(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch (err) {
    if (err instanceof GitError && /not a git repository/i.test(err.stderr)) {
      throw new GitError(`${cwd} is not inside a git repository. Run this from a git checkout or pass --cwd <path>.`);
    }
    if (err instanceof GitError && /dubious ownership/i.test(err.stderr)) {
      throw new GitError(`git refused to read ${cwd} because of "dubious ownership". See: git config --global --add safe.directory <path>`);
    }
    throw err;
  }
}

export async function hasCommits(root: string): Promise<boolean> {
  return gitSucceeds(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
}

export async function isShallow(root: string): Promise<boolean> {
  try {
    return (await runGit(root, ['rev-parse', '--is-shallow-repository'])).trim() === 'true';
  } catch {
    return false;
  }
}

export async function remoteOriginUrl(root: string): Promise<string | undefined> {
  try {
    const out = (await runGit(root, ['config', '--get', 'remote.origin.url'])).trim();
    return out !== '' ? out : undefined;
  } catch {
    return undefined;
  }
}

export async function refExists(root: string, ref: string): Promise<boolean> {
  if (ref.startsWith('-')) return false;
  return gitSucceeds(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
}

export async function resolveCommit(root: string, ref: string): Promise<string> {
  if (ref.startsWith('-')) throw new GitError(`Invalid revision: ${ref}`);
  return (await runGit(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])).trim();
}

/**
 * All optimal common ancestors between `a` and `b` (`git merge-base --all`).
 * Returns `[]` when the revisions share no common history (e.g. orphan branch or shallow cutoff).
 */
export async function mergeBases(root: string, a: string, b = 'HEAD'): Promise<string[]> {
  if (a.startsWith('-') || b.startsWith('-')) return [];
  try {
    const out = await runGit(root, ['merge-base', '--all', '--end-of-options', a, b]);
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch (err) {
    if (err instanceof GitError && err.exitCode === 1) return [];
    throw err;
  }
}

/**
 * Files that exist right now: tracked files plus untracked, non-ignored files.
 * Used to avoid suggesting deleted files and to resolve imports without touching disk.
 */
export async function listCurrentFiles(root: string): Promise<Set<string>> {
  const [present, deleted] = await Promise.all([
    runGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
    // Deleted from disk but not yet staged: still in the index, but gone.
    runGit(root, ['ls-files', '-z', '--deleted']),
  ]);
  const files = new Set(splitNul(present));
  for (const path of splitNul(deleted)) files.delete(path);
  return files;
}

export interface TreeFileSet extends Set<string> {
  /** Git tree entry mode (`100644`, `100755`, `120000`, etc.) for each path. */
  readonly modes: ReadonlyMap<string, string>;
  /** Git object id of each path's blob. */
  readonly oids: ReadonlyMap<string, string>;
}

export function isRegularTreeMode(mode: string | undefined): boolean {
  return mode === '100644' || mode === '100755';
}

export function parseLsTree(out: string): TreeFileSet {
  const modes = new Map<string, string>();
  const oids = new Map<string, string>();
  const files = new Set<string>();
  for (const entry of splitNul(out)) {
    const tab = entry.indexOf('\t');
    if (tab === -1) continue;
    const meta = entry.slice(0, tab);
    const path = entry.slice(tab + 1);
    const [mode = '', , oid = ''] = meta.split(' ');
    // Skip submodule gitlinks (160000); keep regular files (100644/100755) and symlinks (120000)
    // in the path set to match `git ls-files`, while recording modes so non-regular entries are not read as source.
    if (mode === '160000' || path === '') continue;
    files.add(path);
    modes.set(path, mode);
    oids.set(path, oid);
  }
  Object.defineProperty(files, 'oids', { value: oids, enumerable: false, writable: false });
  return Object.defineProperty(files, 'modes', {
    value: modes,
    enumerable: false,
    writable: false,
  }) as TreeFileSet;
}

/** Files present in a commit tree (`git ls-tree -r -z`), with entry modes attached. */
export async function listTreeFiles(root: string, rev = 'HEAD'): Promise<TreeFileSet> {
  if (rev.startsWith('-')) throw new GitError(`Invalid revision: ${rev}`);
  const out = await runGit(root, ['ls-tree', '-r', '-z', '--end-of-options', rev]);
  return parseLsTree(out);
}

/** True when `base..head` contains at least one merge commit. */
export async function hasMergesInRange(root: string, base: string, head = 'HEAD'): Promise<boolean> {
  if (base.startsWith('-') || head.startsWith('-')) return false;
  const out = await runGit(root, ['rev-list', '--merges', '--count', '--end-of-options', `${base}..${head}`]);
  return Number(out.trim()) > 0;
}

/** True when `sha` has at least one parent commit (i.e. is not a root commit). */
export async function hasParentCommit(root: string, sha: string): Promise<boolean> {
  if (sha.startsWith('-')) return false;
  return gitSucceeds(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${sha}^^{commit}`]);
}
