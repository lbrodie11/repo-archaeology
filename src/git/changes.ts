import { runGit, splitNul } from './run.js';

export type ChangeSource = 'branch' | 'staged' | 'unstaged' | 'untracked';

export interface ChangedFile {
  /** Current path in the working tree. */
  path: string;
  /** Previous path when the file was renamed (history may still know it by this name). */
  oldPath?: string;
  deleted: boolean;
  sources: ChangeSource[];
}

/**
 * Parses `git status --porcelain=v1 -z` output.
 * Entries are `XY PATH NUL`, and renames/copies are `XY NEW NUL OLD NUL`.
 */
export function parsePorcelainStatus(output: string): ChangedFile[] {
  const tokens = splitNul(output);
  const files: ChangedFile[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]!;
    if (entry.length < 4) continue;
    const x = entry[0]!;
    const y = entry[1]!;
    const path = entry.slice(3);
    if (x === '!' && y === '!') continue;
    let oldPath: string | undefined;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      oldPath = tokens[++i];
      if (x === 'C' || y === 'C') oldPath = undefined; // a copy leaves the source untouched
    }
    const sources: ChangeSource[] = [];
    if (x === '?' && y === '?') sources.push('untracked');
    else {
      if (x !== ' ') sources.push('staged');
      if (y !== ' ') sources.push('unstaged');
    }
    files.push({ path, oldPath, deleted: x === 'D' || y === 'D', sources });
  }
  return files;
}

/** Parses `git diff --name-status -z` output (no commit headers). */
export function parseNameStatus(output: string): ChangedFile[] {
  const tokens = splitNul(output);
  const files: ChangedFile[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i]!.trim();
    if (!status) continue;
    const letter = status[0]!;
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[++i];
      const path = tokens[++i];
      if (path === undefined) break;
      files.push({ path, oldPath: letter === 'R' ? oldPath : undefined, deleted: false, sources: ['branch'] });
    } else {
      const path = tokens[++i];
      if (path === undefined) break;
      files.push({ path, deleted: letter === 'D', sources: ['branch'] });
    }
  }
  return files;
}

export async function workingTreeChanges(root: string): Promise<ChangedFile[]> {
  const out = await runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--find-renames']);
  return parsePorcelainStatus(out);
}

/** Files changed on this branch since it forked from `base` (merge-base semantics). */
export async function branchChanges(root: string, base: string): Promise<ChangedFile[]> {
  const out = await runGit(root, ['diff', '--name-status', '-z', '-M', '--no-ext-diff', `${base}...HEAD`, '--']);
  return parseNameStatus(out);
}

/** Merges change lists, keeping one entry per current path. */
export function mergeChanges(...lists: ChangedFile[][]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const list of lists) {
    for (const file of list) {
      const existing = byPath.get(file.path);
      if (!existing) {
        byPath.set(file.path, { ...file, sources: [...file.sources] });
        continue;
      }
      existing.oldPath ??= file.oldPath;
      // The latest state wins: a file deleted on the branch but restored in the working tree exists.
      existing.deleted = file.deleted;
      for (const s of file.sources) if (!existing.sources.includes(s)) existing.sources.push(s);
    }
  }
  return [...byPath.values()];
}
