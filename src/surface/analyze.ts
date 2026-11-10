import { performance } from 'node:perf_hooks';
import { parseNameStatus } from '../git/changes.js';
import { listTreeFiles, type TreeFileSet } from '../git/repo.js';
import { GitError, runGit } from '../git/run.js';
import { gitTreeFiles, type RepoFiles } from '../imports/tree-files.js';
import { findConsumers } from './consumers.js';
import { surfaceDelta } from './delta.js';
import { extractSurface, isSurfaceSource } from './extract.js';
import type { FileDelta, Surface, SurfaceAnalysis } from './types.js';

/**
 * RA-18 pilot entry point: what did `base..head` change about each changed source file's
 * export surface, and which untouched files at `head` still use an affected name?
 * Research only: not wired into any command, JSON output or the library API.
 */
export async function analyzeSurfaceChange(root: string, base: string, head: string): Promise<SurfaceAnalysis> {
  const started = performance.now();
  for (const rev of [base, head]) if (rev.startsWith('-') || /[\s\0]/.test(rev)) throw new GitError(`Invalid revision: ${rev}`);
  const [diff, baseSet, headSet] = await Promise.all([
    runGit(root, ['diff', '--name-status', '-z', '-M', '--no-ext-diff', '--no-textconv', '--end-of-options', base, head]),
    listTreeFiles(root, base),
    listTreeFiles(root, head),
  ]);
  const baseFiles = gitTreeFiles(root, base, baseSet);
  const headFiles = gitTreeFiles(root, head, headSet);
  try {
    return analyzeTrees({ base, head, diff: parseNameStatus(diff), baseFiles, headFiles, headSet, started });
  } finally {
    baseFiles.close();
    headFiles.close();
  }
}

export interface TreeChange {
  path: string;
  oldPath?: string;
  deleted: boolean;
  added?: boolean;
}

export interface AnalyzeTreesInput {
  base: string;
  head: string;
  diff: readonly TreeChange[];
  baseFiles: RepoFiles;
  headFiles: RepoFiles;
  headSet?: TreeFileSet;
  started?: number;
}

export function analyzeTrees(input: AnalyzeTreesInput): SurfaceAnalysis {
  const started = input.started ?? performance.now();
  const changedPaths = new Set<string>();
  const sides = new Map<string, { base?: string; head?: string }>();
  for (const change of input.diff) {
    changedPaths.add(change.path);
    if (change.oldPath) {
      // A rename is a deletion plus an addition.
      changedPaths.add(change.oldPath);
      sides.set(change.oldPath, { base: change.oldPath });
      sides.set(change.path, { head: change.path });
    } else if (change.deleted) {
      sides.set(change.path, { base: change.path });
    } else if (change.added) {
      sides.set(change.path, { head: change.path });
    } else {
      sides.set(change.path, { base: change.path, head: change.path });
    }
  }

  const changedSourceFiles = [...sides.keys()].filter(isSurfaceSource).sort();
  const deltas: FileDelta[] = [];
  const headSurfaces = new Map<string, Surface>();
  for (const file of changedSourceFiles) {
    const side = sides.get(file)!;
    const baseSurface = side.base !== undefined ? readSurface(input.baseFiles, side.base) : undefined;
    const headSurface = side.head !== undefined ? readSurface(input.headFiles, side.head) : undefined;
    if (headSurface) headSurfaces.set(file, headSurface);
    deltas.push(surfaceDelta(file, baseSurface, headSurface));
  }

  const search = findConsumers({ files: input.headFiles, deltas, headSurfaces, changedPaths, modes: input.headSet?.modes });
  return {
    base: input.base,
    head: input.head,
    changedSourceFiles,
    deltas,
    consumers: search.consumers,
    skippedFiles: search.skippedFiles,
    stats: { sourceFiles: search.sourceFiles, parsedImporters: search.parsedImporters, ms: Math.round(performance.now() - started) },
  };
}

function readSurface(files: RepoFiles, path: string): Surface {
  const text = files.read(path);
  if (text === undefined) return { status: 'unavailable', reason: 'unreadable (too large, symlink or not a regular file)', module: 'none', exports: [], opaque: [] };
  return extractSurface(path, text);
}
