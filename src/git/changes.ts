import { readLog, type RawCommit } from './log.js';
import { hasMergesInRange, listTreeFiles } from './repo.js';
import { runGit, splitNul } from './run.js';

export type ChangeSource = 'branch' | 'staged' | 'unstaged' | 'untracked';

export interface ChangedFile {
  /** Current path in the working tree. */
  path: string;
  /** Previous path when the file was renamed (history may still know it by this name). */
  oldPath?: string;
  deleted: boolean;
  /** The path was created by this change (added, untracked, or the target of a rename or copy). */
  added?: boolean;
  sources: ChangeSource[];
}

type BranchOrigin =
  | { kind: 'baseline'; basePath: string }
  | { kind: 'born_on_branch' }
  | { kind: 'deleted' };

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
    files.push({ path, oldPath, deleted: x === 'D' || y === 'D', added: x === '?' || x === 'A' || x === 'R' || x === 'C' || y === 'A' || y === 'R' || y === 'C', sources });
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
      files.push({ path, oldPath: letter === 'R' ? oldPath : undefined, deleted: false, added: true, sources: ['branch'] });
    } else {
      const path = tokens[++i];
      if (path === undefined) break;
      files.push({ path, deleted: letter === 'D', added: letter === 'A', sources: ['branch'] });
    }
  }
  return files;
}

/**
 * Reconciles the net endpoint diff (`mergeBase...HEAD`) with the linear topological sequence
 * of commits on the branch (`mergeBase..HEAD`, oldest first) so chained renames, files
 * deleted and recreated at the same path, and files created at a renamed file's old path
 * keep their true baseline identity (or lack of one).
 */
export function reconcileBranchLineage(
  netFiles: ChangedFile[],
  branchCommits: Iterable<RawCommit>,
  headFiles?: ReadonlySet<string>,
): ChangedFile[] {
  const state = new Map<string, BranchOrigin>();
  const originBefore = (path: string): BranchOrigin => state.get(path) ?? { kind: 'baseline', basePath: path };

  for (const commit of branchCommits) {
    const renameOrigins = commit.changes.map((ch) =>
      ch.status === 'R' && ch.oldPath !== undefined ? originBefore(ch.oldPath) : undefined,
    );
    const writtenPaths = new Set(commit.changes.filter((ch) => ch.status !== 'D').map((ch) => ch.path));
    for (const ch of commit.changes) {
      if (ch.status === 'D') {
        state.set(ch.path, { kind: 'deleted' });
      } else if (ch.status === 'R' && ch.oldPath !== undefined && !writtenPaths.has(ch.oldPath)) {
        state.set(ch.oldPath, { kind: 'deleted' });
      }
    }
    commit.changes.forEach((ch, i) => {
      if (ch.status === 'D') return;
      if (ch.status === 'A' || ch.status === 'C') {
        state.set(ch.path, { kind: 'born_on_branch' });
      } else if (ch.status === 'R') {
        const origin = renameOrigins[i]!;
        state.set(ch.path, origin.kind === 'deleted' ? { kind: 'born_on_branch' } : origin);
      } else {
        const current = originBefore(ch.path);
        if (current.kind !== 'deleted') state.set(ch.path, current);
      }
    });
  }

  if (state.size === 0) return netFiles;

  const movedBaselinePaths = new Set<string>();
  for (const [currentPath, origin] of state) {
    if (origin.kind === 'baseline' && origin.basePath !== currentPath && (!headFiles || headFiles.has(currentPath))) {
      movedBaselinePaths.add(origin.basePath);
    }
  }

  const result: ChangedFile[] = [];
  const seenPaths = new Set<string>();
  for (const file of netFiles) {
    if (file.deleted) {
      // If a baseline file was renamed across multiple commits and heavily edited, endpoint
      // diffing can emit D <old> + A <new>; drop D <old> when <old> survived at <new>.
      if (movedBaselinePaths.has(file.path)) continue;
      result.push({ ...file, sources: [...file.sources] });
      seenPaths.add(file.path);
      continue;
    }
    if (headFiles && !headFiles.has(file.path)) continue;
    seenPaths.add(file.path);
    const origin = state.get(file.path);
    if (origin?.kind === 'born_on_branch') {
      const entry: ChangedFile = { path: file.path, deleted: false, added: true, sources: [...file.sources] };
      result.push(entry);
    } else if (origin?.kind === 'baseline') {
      if (origin.basePath !== file.path) {
        result.push({ path: file.path, oldPath: origin.basePath, deleted: false, added: true, sources: [...file.sources] });
      } else {
        result.push({ path: file.path, deleted: false, added: false, sources: [...file.sources] });
      }
    } else {
      result.push({ ...file, sources: [...file.sources] });
    }
  }

  // If a file was deleted and recreated on the branch with identical bytes to the baseline,
  // endpoint diffing omits it, but its baseline lineage was severed. Only emit when verified in HEAD.
  if (headFiles) {
    for (const [currentPath, origin] of state) {
      if (seenPaths.has(currentPath) || !headFiles.has(currentPath)) continue;
      if (origin.kind === 'born_on_branch') {
        result.push({ path: currentPath, deleted: false, added: true, sources: ['branch'] });
      } else if (origin.kind === 'baseline' && origin.basePath !== currentPath) {
        result.push({ path: currentPath, oldPath: origin.basePath, deleted: false, added: true, sources: ['branch'] });
      }
    }
  }

  return result;
}

export async function workingTreeChanges(root: string): Promise<ChangedFile[]> {
  const out = await runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--find-renames']);
  return mergeChanges(parsePorcelainStatus(out));
}

/** Files changed on this branch since it forked from `base` (merge-base semantics). */
export async function branchChanges(
  root: string,
  base: string,
  options?: { onMergeFallback?: () => void },
): Promise<ChangedFile[]> {
  const [out, hasMerges] = await Promise.all([
    runGit(root, ['diff', '--name-status', '-z', '-M', '--no-ext-diff', '--end-of-options', `${base}...HEAD`, '--']),
    hasMergesInRange(root, base, 'HEAD'),
  ]);
  const netFiles = parseNameStatus(out);
  if (hasMerges) {
    options?.onMergeFallback?.();
    return netFiles;
  }
  const commits: RawCommit[] = [];
  const [, headFiles] = await Promise.all([
    readLog(root, { rev: `${base}..HEAD`, topoOrder: true, reverse: true }, (c) => commits.push(c)),
    listTreeFiles(root, 'HEAD'),
  ]);
  return reconcileBranchLineage(netFiles, commits, headFiles);
}

/** Merges change lists, keeping one entry per current path and chaining renames across lists. */
export function mergeChanges(...lists: ChangedFile[][]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const list of lists) {
    const priorByPath = new Map<string, ChangedFile>();
    for (const [k, v] of byPath) priorByPath.set(k, { ...v, sources: [...v.sources] });
    const writtenInList = new Set(list.filter((f) => !f.deleted).map((f) => f.path));
    for (const file of list) {
      const movedFrom = file.oldPath !== undefined && file.oldPath !== file.path ? priorByPath.get(file.oldPath) : undefined;
      let effectiveOldPath = file.oldPath;
      let effectiveAdded = file.added;
      const mergedSources = [...file.sources];

      if (movedFrom && !movedFrom.deleted) {
        if (movedFrom.added && movedFrom.oldPath === undefined) {
          effectiveOldPath = undefined;
          effectiveAdded = true;
        } else {
          effectiveOldPath = movedFrom.oldPath ?? movedFrom.path;
          effectiveAdded = true;
        }
        for (const s of movedFrom.sources) {
          if (!mergedSources.includes(s)) mergedSources.unshift(s);
        }
        if (!writtenInList.has(file.oldPath!)) {
          byPath.delete(file.oldPath!);
        }
      }

      const existing = byPath.get(file.path);
      if (!existing) {
        const entry: ChangedFile = {
          ...file,
          deleted: file.deleted,
          added: effectiveAdded,
          sources: mergedSources,
        };
        if (effectiveOldPath !== undefined) entry.oldPath = effectiveOldPath;
        else delete entry.oldPath;
        byPath.set(file.path, entry);
        continue;
      }

      if (existing.deleted && effectiveAdded && effectiveOldPath === undefined) {
        delete existing.oldPath;
        existing.added = true;
      } else if (effectiveOldPath !== undefined) {
        existing.oldPath = effectiveOldPath;
      }
      // The latest state wins: a file deleted on the branch but restored in the working tree exists.
      existing.deleted = file.deleted;
      if (effectiveAdded) existing.added = true;
      for (const s of mergedSources) if (!existing.sources.includes(s)) existing.sources.push(s);
    }
  }
  return [...byPath.values()];
}
