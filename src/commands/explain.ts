import { posix } from 'node:path';
import { DEFAULT_SETTINGS, type Settings } from '../config.js';
import type { Context } from '../context.js';
import { toRepoPath, UsageError } from '../context.js';
import {
  DEFAULT_CONTEXT_LINES,
  DEFAULT_MAX_HUNKS_PER_FILE,
  DEFAULT_MAX_LINES_PER_HUNK,
  DEFAULT_MAX_PATCH_BYTES,
  DEFAULT_PATCH_TIMEOUT_MS,
  fetchPairCommitPatches,
  fetchSingleFilePatch,
  MAX_CONTEXT_LINES,
  type FilePatchEvidence,
  type PatchBoundsOptions,
  type PatchHunk,
} from '../git/patch.js';
import type { HiddenBridge, Relationship } from '../imports/classify.js';
import { resolveCommitFileChange, type HistoryCommit } from '../model/history.js';
import { buildMeta, printHeader, relationshipLabel, type Meta } from '../report/views.js';
import { wilsonLowerBound } from '../util/stats.js';
import { c, isoDate, pct, plural, shortHash, terminalText, timeAgo } from '../util/term.js';

export const DEFAULT_EXPLAIN_COMMITS = 3;
export const MAX_EXPLAIN_COMMITS = 10;
export const MAX_COUNTEREXAMPLES_PER_SIDE = 3;
export const DEFAULT_MAX_TOTAL_PATCH_LINES = 200;
export const DEFAULT_TOTAL_TIMEOUT_MS = 8000;

export const EXPLAIN_DISCLAIMER =
  'Historical patches show what changed in the same commit, not proof of why the files changed together or that future changes require both files.';

export interface ExplainOptions extends PatchBoundsOptions {
  /** Number of recent shared commits to inspect (default 3, capped at 10). */
  commits?: number;
  /** Alias for `commits`. */
  limit?: number;
  /** Also fetch patch hunks for counterexample commits where one file changed without the other. */
  counterexamples?: boolean;
  /** Maximum total diff lines emitted across all inspected patches (default 200). */
  maxTotalPatchLines?: number;
  /** Maximum wall-clock milliseconds spent retrieving git patches (default 8000). */
  totalTimeoutMs?: number;
}

export interface SharedCommitEvidence {
  hash: string;
  date: string;
  author: string;
  subject: string;
  fileA: FilePatchEvidence;
  fileB: FilePatchEvidence;
}

export interface CounterexampleCommitEvidence {
  hash: string;
  date: string;
  author: string;
  subject: string;
  historicalPath: string;
  oldPath?: string;
  status: string;
  patch?: FilePatchEvidence;
}

export interface ExplainBoundsSummary {
  maxCommits: number;
  contextLines: number;
  contextClamped?: boolean;
  maxPatchBytes: number;
  maxHunksPerFile: number;
  maxLinesPerHunk: number;
  maxTotalPatchLines: number;
  timeoutMs: number;
  commitsTruncated: boolean;
  outputTruncated: boolean;
  timedOut: boolean;
}

export interface ExplainResult {
  meta: Meta;
  from: string;
  to: string;
  relationship: Relationship;
  why: string;
  hiddenBridge?: HiddenBridge;
  meetsThresholds: boolean;
  shared: number;
  fromChanges: number;
  toChanges: number;
  confidence: number;
  reverseConfidence: number;
  score: number;
  weighted: boolean;
  lastTogether?: string;
  crossesDirectories: boolean;
  sharedCommits: SharedCommitEvidence[];
  counterexamples: {
    fromWithoutToTotal: number;
    toWithoutFromTotal: number;
    fromWithoutTo: CounterexampleCommitEvidence[];
    toWithoutFrom: CounterexampleCommitEvidence[];
  };
  bounds: ExplainBoundsSummary;
  cliCommand: string;
  disclaimer: string;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

const UNSAFE_SHELL_CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;

function shellQuoteArg(arg: string): string {
  if (/^[a-zA-Z0-9._/@:-]+$/.test(arg) && !arg.startsWith('-')) {
    return arg;
  }
  if (UNSAFE_SHELL_CONTROL.test(arg)) {
    let escaped = '';
    for (const ch of arg) {
      const code = ch.codePointAt(0)!;
      if (ch === '\\') escaped += '\\\\';
      else if (ch === "'") escaped += "\\'";
      else if (ch === '\n') escaped += '\\n';
      else if (ch === '\r') escaped += '\\r';
      else if (ch === '\t') escaped += '\\t';
      else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
        escaped += `\\x${code.toString(16).padStart(2, '0')}`;
      } else if (
        (code >= 0x200b && code <= 0x200f) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
      ) {
        escaped += `\\u${code.toString(16).padStart(4, '0')}`;
      } else {
        escaped += ch;
      }
    }
    return `$'${escaped}'`;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Formats a safe, copyable CLI command for inspecting two repository-relative paths. */
export function formatExplainCommand(fileA: string, fileB: string, settings?: Partial<Settings>): string {
  const flagParts: string[] = [];
  if (settings) {
    if (settings.since !== undefined) {
      flagParts.push(`--since ${shellQuoteArg(settings.since)}`);
    }
    if (settings.maxCommits !== undefined && settings.maxCommits !== DEFAULT_SETTINGS.maxCommits) {
      flagParts.push(`--max-commits ${settings.maxCommits}`);
    }
    if (settings.maxFilesPerCommit !== undefined && settings.maxFilesPerCommit !== DEFAULT_SETTINGS.maxFilesPerCommit) {
      flagParts.push(`--max-files ${settings.maxFilesPerCommit}`);
    }
    if (settings.halfLifeDays !== undefined) {
      flagParts.push(`--half-life ${settings.halfLifeDays}`);
    }
    if (settings.skipCommits !== undefined) {
      flagParts.push(`--skip-commits ${shellQuoteArg(settings.skipCommits)}`);
    }
  }
  const flagsStr = flagParts.length > 0 ? ` ${flagParts.join(' ')}` : '';
  const needsDoubleDash = fileA.startsWith('-') || fileB.startsWith('-');
  const sep = needsDoubleDash ? ' -- ' : ' ';
  return `npx repo-archaeology explain${flagsStr}${sep}${shellQuoteArg(fileA)} ${shellQuoteArg(fileB)}`;
}

function countPatchLines(patch: FilePatchEvidence): number {
  return patch.hunks.reduce((sum, h) => sum + 1 + h.lines.length, 0);
}

function enforceTotalLineBudget(
  patch: FilePatchEvidence,
  remainingLines: number,
): { patch: FilePatchEvidence; usedLines: number; clippedByTotal: boolean } {
  const currentLines = countPatchLines(patch);
  if (currentLines <= remainingLines) {
    return { patch, usedLines: currentLines, clippedByTotal: false };
  }
  const keptHunks: PatchHunk[] = [];
  let used = 0;
  let extraOmittedHunks = 0;
  let extraOmittedLines = 0;

  for (const hunk of patch.hunks) {
    if (used + 1 >= remainingLines) {
      extraOmittedHunks++;
      extraOmittedLines += hunk.lines.length;
      continue;
    }
    const availForLines = remainingLines - used - 1;
    if (hunk.lines.length <= availForLines) {
      keptHunks.push(hunk);
      used += 1 + hunk.lines.length;
    } else {
      const keptLines = hunk.lines.slice(0, availForLines);
      const dropped = hunk.lines.length - keptLines.length;
      extraOmittedLines += dropped;
      keptHunks.push({
        ...hunk,
        lines: keptLines,
        truncated: true,
        omittedLines: hunk.omittedLines + dropped,
      });
      used += 1 + keptLines.length;
    }
  }

  return {
    patch: {
      ...patch,
      hunks: keptHunks,
      truncated: true,
      omittedHunks: patch.omittedHunks + extraOmittedHunks,
      omittedLines: patch.omittedLines + extraOmittedLines,
      ...(keptHunks.length === 0 && !patch.statusNote
        ? { statusNote: 'Diff omitted due to total output size limit' }
        : {}),
    },
    usedLines: used,
    clippedByTotal: true,
  };
}

function sortCommitsNewestFirst(commits: readonly HistoryCommit[], indices: number[]): number[] {
  return [...indices].sort((x, y) => {
    const cx = commits[x]!;
    const cy = commits[y]!;
    return cy.time - cx.time || cy.commitTime - cx.commitTime || x - y;
  });
}

function ensureFileInHistory(ctx: Context, path: string): number {
  const id = ctx.model.id(path);
  if (id === undefined) {
    const reason = ctx.currentFiles.has(path)
      ? 'it has no usable history yet (new, ignored, or only changed in sweeping commits)'
      : 'no such file in the history or the working tree';
    throw new UsageError(`Nothing to show for ${path}: ${reason}.`);
  }
  return id;
}

export async function explain(
  ctx: Context,
  inputA: string,
  inputB: string,
  options: ExplainOptions = {},
): Promise<ExplainResult> {
  const from = toRepoPath(ctx, inputA);
  const to = toRepoPath(ctx, inputB);
  if (from === to) {
    throw new UsageError('Please provide two different files to explain.');
  }

  const idA = ensureFileInHistory(ctx, from);
  const idB = ensureFileInHistory(ctx, to);

  const requestedCommits = options.commits ?? options.limit ?? DEFAULT_EXPLAIN_COMMITS;
  const maxCommits = Math.min(MAX_EXPLAIN_COMMITS, Math.max(1, Math.floor(requestedCommits)));
  const maxPatchBytes = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
  const maxHunksPerFile = options.maxHunksPerFile ?? DEFAULT_MAX_HUNKS_PER_FILE;
  const maxLinesPerHunk = options.maxLinesPerHunk ?? DEFAULT_MAX_LINES_PER_HUNK;
  const maxTotalPatchLines = options.maxTotalPatchLines ?? DEFAULT_MAX_TOTAL_PATCH_LINES;
  const perCommitTimeoutMs = options.timeoutMs ?? DEFAULT_PATCH_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const requestedContext = options.contextLines ?? DEFAULT_CONTEXT_LINES;
  const contextLines = Math.min(MAX_CONTEXT_LINES, Math.max(0, Math.floor(requestedContext)));
  const contextClamped = requestedContext !== contextLines;

  const { model } = ctx;
  const stat = model.pair(idA, idB);
  const shared = stat?.count ?? 0;
  const fromChanges = model.changeCount[idA] ?? 0;
  const toChanges = model.changeCount[idB] ?? 0;
  const confidence = stat ? model.confidence(stat, idA) : 0;
  const reverseConfidence = stat ? model.confidence(stat, idB) : 0;
  const score = wilsonLowerBound(confidence, model.effectiveChanges(idA));
  const meetsThresholds =
    shared >= ctx.thresholds.minShared &&
    (confidence >= ctx.thresholds.minConfidence || reverseConfidence >= ctx.thresholds.minConfidence);

  const relationship = ctx.classifier.classify(from, to);
  const hiddenBridge = relationship === 'ghost' ? ctx.classifier.hiddenBridge(from, to) : undefined;
  const why = ctx.classifier.explain(from, to, relationship, hiddenBridge);

  const sharedIndices: number[] = [];
  const aOnlyIndices: number[] = [];
  const bOnlyIndices: number[] = [];

  model.commits.forEach((commit, idx) => {
    const hasA = commit.files.includes(from);
    const hasB = commit.files.includes(to);
    if (hasA && hasB) sharedIndices.push(idx);
    else if (hasA) aOnlyIndices.push(idx);
    else if (hasB) bOnlyIndices.push(idx);
  });

  const sortedShared = sortCommitsNewestFirst(model.commits, sharedIndices);
  const sortedAOnly = sortCommitsNewestFirst(model.commits, aOnlyIndices);
  const sortedBOnly = sortCommitsNewestFirst(model.commits, bOnlyIndices);

  const selectedShared = sortedShared.slice(0, maxCommits);
  const commitsTruncated = requestedCommits > MAX_EXPLAIN_COMMITS || sortedShared.length > selectedShared.length;

  let remainingLines = maxTotalPatchLines;
  let outputTruncated = false;
  let timedOut = false;
  const startMs = Date.now();
  const deadlineMs = startMs + totalTimeoutMs;

  const patchBounds: PatchBoundsOptions = {
    contextLines,
    maxPatchBytes,
    maxHunksPerFile,
    maxLinesPerHunk,
    maxLineLength: options.maxLineLength,
    timeoutMs: perCommitTimeoutMs,
    deadlineMs,
  };

  const sharedCommits: SharedCommitEvidence[] = [];
  for (const idx of selectedShared) {
    const commit = model.commits[idx]!;
    const changeA = resolveCommitFileChange(commit, from);
    const changeB = resolveCommitFileChange(commit, to);
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      timedOut = true;
      break;
    }
    const budgetMs = Math.min(perCommitTimeoutMs, remainingMs);
    const { patchA: rawA, patchB: rawB, timedOut: pairTimedOut } = await fetchPairCommitPatches(
      ctx.root,
      commit.hash,
      from,
      changeA,
      to,
      changeB,
      { ...patchBounds, timeoutMs: budgetMs, deadlineMs },
    );
    if (pairTimedOut) timedOut = true;

    // Reserve at least half of remainingLines for fileB when both have hunks so fileA cannot starve fileB.
    const rawBLines = countPatchLines(rawB);
    const reserveForB = rawBLines > 0 ? Math.min(rawBLines, Math.max(2, Math.floor(remainingLines / 2))) : 0;
    const budgetForA = Math.max(0, remainingLines - reserveForB);
    const boundedA = enforceTotalLineBudget(rawA, budgetForA);
    remainingLines = Math.max(0, remainingLines - boundedA.usedLines);
    const boundedB = enforceTotalLineBudget(rawB, remainingLines);
    remainingLines = Math.max(0, remainingLines - boundedB.usedLines);
    if (boundedA.clippedByTotal || boundedB.clippedByTotal) {
      outputTruncated = true;
    }

    sharedCommits.push({
      hash: commit.hash,
      date: isoDate(commit.time),
      author: commit.author,
      subject: commit.subject,
      fileA: boundedA.patch,
      fileB: boundedB.patch,
    });
  }

  const buildCounterexamples = async (
    indices: number[],
    canonicalPath: string,
  ): Promise<CounterexampleCommitEvidence[]> => {
    const result: CounterexampleCommitEvidence[] = [];
    for (const idx of indices.slice(0, MAX_COUNTEREXAMPLES_PER_SIDE)) {
      const commit = model.commits[idx]!;
      const change = resolveCommitFileChange(commit, canonicalPath);
      const entry: CounterexampleCommitEvidence = {
        hash: commit.hash,
        date: isoDate(commit.time),
        author: commit.author,
        subject: commit.subject,
        historicalPath: change.path,
        ...(change.oldPath !== undefined ? { oldPath: change.oldPath } : {}),
        status: change.status,
      };
      if (options.counterexamples) {
        const remainingMs = deadlineMs - Date.now();
        if (remainingMs <= 0) {
          timedOut = true;
        } else {
          const budgetMs = Math.min(perCommitTimeoutMs, remainingMs);
          const rawPatch = await fetchSingleFilePatch(ctx.root, commit.hash, canonicalPath, change, {
            ...patchBounds,
            timeoutMs: budgetMs,
            deadlineMs,
          });
          if (rawPatch.timedOut) timedOut = true;
          const bounded = enforceTotalLineBudget(rawPatch, remainingLines);
          remainingLines = Math.max(0, remainingLines - bounded.usedLines);
          if (bounded.clippedByTotal) outputTruncated = true;
          entry.patch = bounded.patch;
        }
      }
      result.push(entry);
    }
    return result;
  };

  const fromWithoutTo = await buildCounterexamples(sortedAOnly, from);
  const toWithoutFrom = await buildCounterexamples(sortedBOnly, to);

  return {
    meta: buildMeta(ctx),
    from,
    to,
    relationship,
    why,
    ...(hiddenBridge ? { hiddenBridge } : {}),
    meetsThresholds,
    shared,
    fromChanges,
    toChanges,
    confidence: round(confidence),
    reverseConfidence: round(reverseConfidence),
    score: round(score),
    weighted: model.weighted,
    ...(stat && stat.lastTime > 0 ? { lastTogether: isoDate(stat.lastTime) } : {}),
    crossesDirectories: posix.dirname(from) !== posix.dirname(to),
    sharedCommits,
    counterexamples: {
      fromWithoutToTotal: sortedAOnly.length,
      toWithoutFromTotal: sortedBOnly.length,
      fromWithoutTo,
      toWithoutFrom,
    },
    bounds: {
      maxCommits,
      contextLines,
      ...(contextClamped ? { contextClamped: true } : {}),
      maxPatchBytes,
      maxHunksPerFile,
      maxLinesPerHunk,
      maxTotalPatchLines,
      timeoutMs: totalTimeoutMs,
      commitsTruncated,
      outputTruncated,
      timedOut,
    },
    cliCommand: formatExplainCommand(from, to, ctx.settings),
    disclaimer: EXPLAIN_DISCLAIMER,
  };
}

function formatHistoricalPathLabel(patch: FilePatchEvidence): string {
  const current = terminalText(patch.canonicalPath);
  const hist = terminalText(patch.path);
  const old = patch.oldPath ? terminalText(patch.oldPath) : undefined;
  if (old && old !== patch.path) {
    return `${c.bold(current)} ${c.dim(`[${patch.status}: ${old} → ${hist}]`)}`;
  }
  if (patch.path !== patch.canonicalPath) {
    return `${c.bold(current)} ${c.dim(`[${patch.status} at ${hist}]`)}`;
  }
  return `${c.bold(current)} ${c.dim(`[${patch.status}]`)}`;
}

function hasUnexplainedTruncation(patch: FilePatchEvidence): boolean {
  if (!patch.truncated && !patch.timedOut) return false;
  if (patch.timedOut) return true;
  if (patch.omittedHunks === 0 && patch.omittedLines === 0) return true;
  return patch.hunks.some((h) => h.truncated && h.omittedLines === 0);
}

function printFilePatch(patch: FilePatchEvidence, indent = '    '): void {
  console.log(`${indent}${formatHistoricalPathLabel(patch)}`);
  if (patch.hunks.length === 0) {
    console.log(`${indent}  ${c.dim(terminalText(patch.statusNote ?? 'No textual diff hunks'))}`);
    return;
  }
  for (const hunk of patch.hunks) {
    console.log(`${indent}  ${c.cyan(terminalText(hunk.header))}`);
    for (const rawLine of hunk.lines) {
      const safeLine = terminalText(rawLine);
      if (rawLine.startsWith('+')) {
        console.log(`${indent}    ${c.green(safeLine)}`);
      } else if (rawLine.startsWith('-')) {
        console.log(`${indent}    ${c.red(safeLine)}`);
      } else {
        console.log(`${indent}    ${c.dim(safeLine)}`);
      }
    }
    if (hunk.omittedLines > 0) {
      console.log(`${indent}    ${c.dim(`… (${plural(hunk.omittedLines, 'line')} omitted in hunk)`)}`);
    }
  }
  if (patch.omittedHunks > 0) {
    console.log(`${indent}  ${c.dim(`… (${plural(patch.omittedHunks, 'additional hunk')} omitted for this file)`)}`);
  }
  if (hasUnexplainedTruncation(patch)) {
    const reason = patch.timedOut ? 'time limit' : 'byte/time limit';
    console.log(`${indent}  ${c.dim(`… (patch truncated due to ${reason})`)}`);
  }
}

export function printExplain(result: ExplainResult): void {
  printHeader(
    `explain ${c.bold(terminalText(result.from))} ${c.dim('↔')} ${c.bold(terminalText(result.to))}`,
    result.meta,
  );

  const rateA = result.weighted ? `${pct(result.confidence)} recency-weighted` : pct(result.confidence);
  const rateB = result.weighted ? `${pct(result.reverseConfidence)} recency-weighted` : pct(result.reverseConfidence);
  const lastStr = result.lastTogether
    ? ` · last together ${timeAgo(Date.parse(result.lastTogether) / 1000)} (${result.lastTogether})`
    : '';

  console.log(`${c.bold('Relationship')}  ${relationshipLabel(result.relationship)}${lastStr}`);
  console.log(`${c.bold('Why')}           ${terminalText(result.why)}`);
  console.log(
    `${c.bold('Direction')}     ${terminalText(result.from)} → ${terminalText(result.to)}: ${result.shared} of ${result.fromChanges} commits (${rateA})`,
  );
  console.log(
    `              ${terminalText(result.to)} → ${terminalText(result.from)}: ${result.shared} of ${result.toChanges} commits (${rateB})`,
  );
  if (!result.meetsThresholds) {
    console.log(
      c.yellow(
        `Note: This pair is below configured alert thresholds (requires ≥${result.meta.settings.minShared} shared commits and ≥${pct(result.meta.settings.minConfidence)} confidence).`,
      ),
    );
  }
  console.log();

  if (result.sharedCommits.length === 0) {
    console.log('No shared commits found between these two files in the analyzed history.');
  } else {
    const showing =
      result.shared > result.sharedCommits.length
        ? `${result.sharedCommits.length} most recent of ${plural(result.shared, 'shared commit')}`
        : plural(result.sharedCommits.length, 'shared commit');
    console.log(c.bold(`Shared commits (${showing})`));
    console.log();
    for (const commit of result.sharedCommits) {
      console.log(
        `  ${c.bold(shortHash(commit.hash))} ${c.dim(`(${commit.hash})`)} · ${commit.date} · ${terminalText(commit.author)}`,
      );
      console.log(`  ${terminalText(commit.subject)}`);
      printFilePatch(commit.fileA, '    ');
      printFilePatch(commit.fileB, '    ');
      console.log();
    }
  }

  const { fromWithoutTo, toWithoutFrom, fromWithoutToTotal, toWithoutFromTotal } = result.counterexamples;
  if (fromWithoutToTotal > 0 || toWithoutFromTotal > 0) {
    console.log(c.bold('When one file changed without the other'));
    const printSide = (labelFile: string, otherFile: string, total: number, list: CounterexampleCommitEvidence[]) => {
      if (total === 0) {
        console.log(`  ${terminalText(labelFile)} without ${terminalText(otherFile)}: 0 commits`);
        return;
      }
      const suffix = total > list.length ? ` (showing ${list.length} most recent of ${total})` : ` (${plural(total, 'commit')})`;
      console.log(`  ${c.bold(terminalText(labelFile))} without ${terminalText(otherFile)}${c.dim(suffix)}`);
      for (const item of list) {
        const pathNote =
          item.historicalPath !== labelFile ? ` ${c.dim(`[at ${terminalText(item.historicalPath)}]`)}` : '';
        console.log(
          `    ${c.gray(shortHash(item.hash))} ${c.dim(item.date)}  ${terminalText(item.subject)}${pathNote}`,
        );
        if (item.patch) {
          printFilePatch(item.patch, '      ');
        }
      }
    };
    printSide(result.from, result.to, fromWithoutToTotal, fromWithoutTo);
    printSide(result.to, result.from, toWithoutFromTotal, toWithoutFrom);
    console.log();
  }

  if (
    result.bounds.commitsTruncated ||
    result.bounds.outputTruncated ||
    result.bounds.timedOut ||
    result.bounds.contextClamped
  ) {
    const notices: string[] = [];
    if (result.bounds.commitsTruncated) {
      notices.push(`showing up to ${result.bounds.maxCommits} shared commits`);
    }
    if (result.bounds.contextClamped) {
      notices.push(`context lines clamped to ${result.bounds.contextLines}`);
    }
    if (result.bounds.outputTruncated) {
      notices.push(`patch output capped at ${result.bounds.maxTotalPatchLines} lines`);
    }
    if (result.bounds.timedOut) {
      notices.push('patch retrieval reached time budget');
    }
    console.log(c.dim(`Bounds applied: ${notices.join('; ')}.`));
  }
  console.log(c.dim(result.disclaimer));
}
