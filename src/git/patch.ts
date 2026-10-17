import type { CommitFileChange } from '../model/history.js';
import { runGitBounded } from './run.js';

export const DEFAULT_CONTEXT_LINES = 2;
export const MAX_CONTEXT_LINES = 10;
export const DEFAULT_MAX_PATCH_BYTES = 64 * 1024;
export const DEFAULT_MAX_HUNKS_PER_FILE = 4;
export const DEFAULT_MAX_LINES_PER_HUNK = 24;
export const DEFAULT_MAX_LINE_LENGTH = 240;
export const DEFAULT_PATCH_TIMEOUT_MS = 3000;

export interface PatchBoundsOptions {
  contextLines?: number;
  maxPatchBytes?: number;
  maxHunksPerFile?: number;
  maxLinesPerHunk?: number;
  maxLineLength?: number;
  timeoutMs?: number;
  /** Optional wall-clock deadline (epoch ms) shared across fallback subprocess calls. */
  deadlineMs?: number;
}

export interface PatchHunk {
  header: string;
  lines: string[];
  truncated: boolean;
  omittedLines: number;
  lineClipped?: boolean;
}

export interface FilePatchEvidence {
  /** Current canonical repository path for this file. */
  canonicalPath: string;
  /** Historical path at the inspected commit. */
  path: string;
  /** Previous path when the file was renamed or copied in this commit. */
  oldPath?: string;
  /** Git change status in this commit (A, M, D, R, C, T, etc.). */
  status: string;
  binary: boolean;
  emptyDiff: boolean;
  unsupportedPath: boolean;
  truncated: boolean;
  timedOut: boolean;
  omittedHunks: number;
  omittedLines: number;
  statusNote?: string;
  hunks: PatchHunk[];
}

const VALID_COMMIT_HASH = /^[0-9a-f]{7,64}$/i;
const QUOTED_OR_CONTROL_PATH_CHAR = /[\u0000-\u001f\u007f-\u009f"\\]/;

/**
 * Checks whether a historical path can be safely queried and represented in
 * line-oriented unified diff headers. Paths with embedded NUL, CR, or LF characters
 * cannot appear in single-line diff headers without ambiguity and are handled
 * gracefully without invoking line-based patch parsing.
 */
export function isSupportedHistoricalPath(path: string): boolean {
  if (!path || path.length > 4096) return false;
  if (path.includes('\0') || path.includes('\n') || path.includes('\r')) return false;
  return true;
}

function canCombineInSingleShow(change: CommitFileChange): boolean {
  const check = (p: string) => !QUOTED_OR_CONTROL_PATH_CHAR.test(p) && !p.includes(' b/');
  return check(change.path) && (change.oldPath === undefined || check(change.oldPath));
}

function pathArgsForChange(change: CommitFileChange): string[] {
  if (change.oldPath !== undefined && change.oldPath !== change.path) {
    return [change.oldPath, change.path];
  }
  return [change.path];
}

function unsupportedPatchResult(canonicalPath: string, change: CommitFileChange, reason: string): FilePatchEvidence {
  return {
    canonicalPath,
    path: change.path,
    ...(change.oldPath !== undefined ? { oldPath: change.oldPath } : {}),
    status: change.status,
    binary: false,
    emptyDiff: false,
    unsupportedPath: true,
    truncated: false,
    timedOut: false,
    omittedHunks: 0,
    omittedLines: 0,
    statusNote: reason,
    hunks: [],
  };
}

/**
 * Parses a unified diff section for a single file into bounded hunks.
 */
export function parseSingleFileDiff(
  rawDiff: string,
  canonicalPath: string,
  change: CommitFileChange,
  options: PatchBoundsOptions = {},
  rawTruncated = false,
  timedOut = false,
): FilePatchEvidence {
  const maxHunks = options.maxHunksPerFile ?? DEFAULT_MAX_HUNKS_PER_FILE;
  const maxLinesPerHunk = options.maxLinesPerHunk ?? DEFAULT_MAX_LINES_PER_HUNK;
  const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;

  const lines = rawDiff.split(/\r?\n/);
  let binary = false;
  let hasModeChange = false;
  const rawHunks: { header: string; lines: string[] }[] = [];
  let currentHunk: { header: string; lines: string[] } | null = null;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      continue;
    }
    if (!currentHunk) {
      if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
        binary = true;
        continue;
      }
      if (line.startsWith('old mode ') || line.startsWith('new mode ')) {
        hasModeChange = true;
        continue;
      }
    }
    if (line.startsWith('@@ ')) {
      currentHunk = { header: line, lines: [] };
      rawHunks.push(currentHunk);
      continue;
    }
    if (currentHunk) {
      if (
        line.startsWith('+') ||
        line.startsWith('-') ||
        line.startsWith(' ') ||
        line.startsWith('\\ No newline at end of file')
      ) {
        currentHunk.lines.push(line);
      }
    }
  }

  const keptRawHunks = rawHunks.slice(0, maxHunks);
  const omittedHunks = Math.max(0, rawHunks.length - keptRawHunks.length);
  let totalOmittedLines = 0;
  for (let i = maxHunks; i < rawHunks.length; i++) {
    totalOmittedLines += rawHunks[i]!.lines.length;
  }

  const hunks: PatchHunk[] = keptRawHunks.map((h, idx) => {
    const keptLines = h.lines.slice(0, maxLinesPerHunk);
    const omittedInHunk = Math.max(0, h.lines.length - keptLines.length);
    totalOmittedLines += omittedInHunk;
    let lineClipped = false;
    const clippedLines = keptLines.map((l) => {
      if (l.length > maxLineLength) {
        lineClipped = true;
        return `${l.slice(0, Math.max(0, maxLineLength - 1))}…`;
      }
      return l;
    });
    const header = h.header.length > maxLineLength ? `${h.header.slice(0, Math.max(0, maxLineLength - 1))}…` : h.header;
    const isLastRawHunk = idx === rawHunks.length - 1;
    return {
      header,
      lines: clippedLines,
      truncated: omittedInHunk > 0 || (rawTruncated && isLastRawHunk),
      omittedLines: omittedInHunk,
      ...(lineClipped ? { lineClipped: true } : {}),
    };
  });

  const truncated = rawTruncated || timedOut || omittedHunks > 0 || totalOmittedLines > 0;
  let emptyDiff = false;
  let statusNote: string | undefined;

  if (timedOut && hunks.length === 0) {
    statusNote = 'Diff retrieval timed out';
  } else if (binary) {
    statusNote = 'Binary file changed';
  } else if (rawTruncated && hunks.length === 0) {
    statusNote = 'Patch truncated due to byte limit';
  } else if (hunks.length === 0) {
    if (change.status === 'R' && change.oldPath) {
      statusNote = `Renamed from ${change.oldPath} to ${change.path} without content changes`;
    } else if (change.status === 'C' && change.oldPath) {
      statusNote = `Copied from ${change.oldPath} to ${change.path} without content changes`;
    } else if (hasModeChange) {
      emptyDiff = true;
      statusNote = 'File mode changed without content modifications';
    } else if (change.status === 'A') {
      emptyDiff = true;
      statusNote = 'Empty file added';
    } else if (change.status === 'D') {
      emptyDiff = true;
      statusNote = 'Empty file deleted';
    } else {
      emptyDiff = true;
      statusNote = 'No textual diff hunks';
    }
  } else if (change.status === 'R' && change.oldPath) {
    statusNote = `Renamed from ${change.oldPath} to ${change.path}`;
  } else if (change.status === 'A') {
    statusNote = 'File added';
  } else if (change.status === 'D') {
    statusNote = 'File deleted';
  }

  return {
    canonicalPath,
    path: change.path,
    ...(change.oldPath !== undefined ? { oldPath: change.oldPath } : {}),
    status: change.status,
    binary,
    emptyDiff,
    unsupportedPath: false,
    truncated,
    timedOut,
    omittedHunks,
    omittedLines: totalOmittedLines,
    ...(statusNote ? { statusNote } : {}),
    hunks,
  };
}

function resolveRemainingTimeoutMs(options: PatchBoundsOptions): number | null {
  const baseTimeout = options.timeoutMs ?? DEFAULT_PATCH_TIMEOUT_MS;
  if (options.deadlineMs === undefined) return baseTimeout;
  const remaining = options.deadlineMs - Date.now();
  if (remaining <= 0) return null;
  return Math.min(baseTimeout, remaining);
}

/**
 * Fetches bounded patch evidence for a single file in a specific commit.
 */
export async function fetchSingleFilePatch(
  root: string,
  hash: string,
  canonicalPath: string,
  change: CommitFileChange,
  options: PatchBoundsOptions = {},
): Promise<FilePatchEvidence> {
  if (!VALID_COMMIT_HASH.test(hash)) {
    return unsupportedPatchResult(canonicalPath, change, 'Invalid commit hash');
  }
  if (!isSupportedHistoricalPath(change.path) || (change.oldPath !== undefined && !isSupportedHistoricalPath(change.oldPath))) {
    return unsupportedPatchResult(
      canonicalPath,
      change,
      'Diff preview unavailable for path containing control characters',
    );
  }

  const timeoutMs = resolveRemainingTimeoutMs(options);
  if (timeoutMs === null) {
    return parseSingleFileDiff('', canonicalPath, change, options, false, true);
  }

  const contextLines = Math.min(MAX_CONTEXT_LINES, Math.max(0, Math.floor(options.contextLines ?? DEFAULT_CONTEXT_LINES)));
  const maxBytes = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
  const args = [
    'show',
    '--root',
    '--format=',
    '--patch',
    '--no-ext-diff',
    '--no-textconv',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '-M',
    `--unified=${contextLines}`,
    '--end-of-options',
    hash,
    '--',
    ...pathArgsForChange(change),
  ];

  try {
    const res = await runGitBounded(root, args, {
      maxBytes,
      timeoutMs,
      literalPathspecs: true,
    });
    return parseSingleFileDiff(res.stdout, canonicalPath, change, options, res.truncated, res.timedOut);
  } catch {
    return unsupportedPatchResult(canonicalPath, change, 'Diff preview unavailable for this commit path');
  }
}

function splitDiffSections(raw: string): string[] {
  const sections: string[] = [];
  const lines = raw.split(/\r?\n/);
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current) sections.push(current.join('\n'));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) sections.push(current.join('\n'));
  return sections;
}

function sectionMatchesChange(section: string, change: CommitFileChange): boolean {
  const firstNl = section.indexOf('\n');
  const header = firstNl === -1 ? section : section.slice(0, firstNl);
  const oldP = change.oldPath ?? change.path;
  const newP = change.path;
  if (header === `diff --git a/${oldP} b/${newP}`) return true;
  if (header === `diff --git a/${newP} b/${newP}`) return true;
  if (header === `diff --git a/${oldP} b/${oldP}`) return true;
  return false;
}

/**
 * Fetches bounded patch evidence for two files that changed together in `hash`.
 * Uses a single `git show` subprocess call in the common case, falling back to
 * isolated per-file queries when paths contain quoting/control characters or when
 * either file section is missing from the combined output.
 */
export async function fetchPairCommitPatches(
  root: string,
  hash: string,
  canonicalPathA: string,
  changeA: CommitFileChange,
  canonicalPathB: string,
  changeB: CommitFileChange,
  options: PatchBoundsOptions = {},
): Promise<{ patchA: FilePatchEvidence; patchB: FilePatchEvidence; timedOut: boolean }> {
  if (!VALID_COMMIT_HASH.test(hash)) {
    return {
      patchA: unsupportedPatchResult(canonicalPathA, changeA, 'Invalid commit hash'),
      patchB: unsupportedPatchResult(canonicalPathB, changeB, 'Invalid commit hash'),
      timedOut: false,
    };
  }

  const baseTimeout = options.timeoutMs ?? DEFAULT_PATCH_TIMEOUT_MS;
  const deadlineMs = options.deadlineMs ?? Date.now() + baseTimeout;
  const scopedOptions: PatchBoundsOptions = { ...options, deadlineMs };

  const okA = isSupportedHistoricalPath(changeA.path) && (changeA.oldPath === undefined || isSupportedHistoricalPath(changeA.oldPath));
  const okB = isSupportedHistoricalPath(changeB.path) && (changeB.oldPath === undefined || isSupportedHistoricalPath(changeB.oldPath));

  if (!okA || !okB || !canCombineInSingleShow(changeA) || !canCombineInSingleShow(changeB)) {
    const patchA = okA
      ? await fetchSingleFilePatch(root, hash, canonicalPathA, changeA, scopedOptions)
      : unsupportedPatchResult(canonicalPathA, changeA, 'Diff preview unavailable for path containing control characters');
    const patchB = okB
      ? await fetchSingleFilePatch(root, hash, canonicalPathB, changeB, scopedOptions)
      : unsupportedPatchResult(canonicalPathB, changeB, 'Diff preview unavailable for path containing control characters');
    return { patchA, patchB, timedOut: patchA.timedOut || patchB.timedOut };
  }

  const timeoutMs = resolveRemainingTimeoutMs(scopedOptions);
  if (timeoutMs === null) {
    return {
      patchA: parseSingleFileDiff('', canonicalPathA, changeA, scopedOptions, false, true),
      patchB: parseSingleFileDiff('', canonicalPathB, changeB, scopedOptions, false, true),
      timedOut: true,
    };
  }

  const contextLines = Math.min(MAX_CONTEXT_LINES, Math.max(0, Math.floor(scopedOptions.contextLines ?? DEFAULT_CONTEXT_LINES)));
  const maxBytes = scopedOptions.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
  const pathList = [...new Set([...pathArgsForChange(changeA), ...pathArgsForChange(changeB)])];
  const args = [
    'show',
    '--root',
    '--format=',
    '--patch',
    '--no-ext-diff',
    '--no-textconv',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '-M',
    `--unified=${contextLines}`,
    '--end-of-options',
    hash,
    '--',
    ...pathList,
  ];

  try {
    const res = await runGitBounded(root, args, {
      maxBytes,
      timeoutMs,
      literalPathspecs: true,
    });
    if (res.timedOut) {
      return {
        patchA: parseSingleFileDiff('', canonicalPathA, changeA, scopedOptions, res.truncated, true),
        patchB: parseSingleFileDiff('', canonicalPathB, changeB, scopedOptions, res.truncated, true),
        timedOut: true,
      };
    }
    const sections = splitDiffSections(res.stdout);
    const lastSection = sections.at(-1);
    const secA = sections.find((s) => sectionMatchesChange(s, changeA));
    const secB = sections.find((s) => sectionMatchesChange(s, changeB));

    // Git outputs files in sorted path order, not request order. Only the final section
    // in `sections` was cut mid-stream when `res.truncated` is true; any missing section
    // is fetched individually using the remaining deadline budget.
    const patchA =
      secA !== undefined
        ? parseSingleFileDiff(secA, canonicalPathA, changeA, scopedOptions, res.truncated && secA === lastSection, false)
        : await fetchSingleFilePatch(root, hash, canonicalPathA, changeA, scopedOptions);
    const patchB =
      secB !== undefined
        ? parseSingleFileDiff(secB, canonicalPathB, changeB, scopedOptions, res.truncated && secB === lastSection, false)
        : await fetchSingleFilePatch(root, hash, canonicalPathB, changeB, scopedOptions);

    return { patchA, patchB, timedOut: patchA.timedOut || patchB.timedOut };
  } catch {
    const patchA = await fetchSingleFilePatch(root, hash, canonicalPathA, changeA, scopedOptions);
    const patchB = await fetchSingleFilePatch(root, hash, canonicalPathB, changeB, scopedOptions);
    return { patchA, patchB, timedOut: patchA.timedOut || patchB.timedOut };
  }
}
