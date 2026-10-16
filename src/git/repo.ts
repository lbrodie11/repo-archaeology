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
  return gitSucceeds(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
}

/**
 * Files that exist right now: tracked files plus untracked, non-ignored files.
 * Used to avoid suggesting deleted files and to resolve imports without touching disk.
 */
export async function listCurrentFiles(root: string): Promise<Set<string>> {
  const out = await runGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  return new Set(splitNul(out));
}
