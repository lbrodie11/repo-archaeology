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

/** Files present in a commit tree (`git ls-tree -r --name-only -z`). */
export async function listTreeFiles(root: string, rev = 'HEAD'): Promise<Set<string>> {
  if (rev.startsWith('-')) throw new GitError(`Invalid revision: ${rev}`);
  const out = await runGit(root, ['ls-tree', '-r', '--name-only', '-z', rev]);
  return new Set(splitNul(out));
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
