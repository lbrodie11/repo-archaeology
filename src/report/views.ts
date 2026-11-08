import { posix } from 'node:path';
import type { Context } from '../context.js';
import type { HiddenBridge, Relationship } from '../imports/classify.js';
import type { Companion, WeightingMode } from '../model/cochange.js';
import {
  computeOriginShare,
  type CommitOrigin,
  type OriginConfig,
  type OriginCounts,
  type OriginShare,
} from '../model/origin.js';
import { wilsonInterval, type WilsonInterval } from '../util/stats.js';
import { c, isoDate, pct, plural, shortHash, terminalText, timeAgo } from '../util/term.js';

export function weightingLabel(item: { weighted?: boolean; weighting?: WeightingMode }): string | undefined {
  if (!item.weighted && (!item.weighting || item.weighting === 'none')) return undefined;
  if (item.weighting === 'origin') return 'origin-weighted';
  if (item.weighting === 'recency+origin') return 'recency+origin-weighted';
  return 'recency-weighted';
}

export interface EvidenceView {
  hash: string;
  date: string;
  author: string;
  subject: string;
  origin?: CommitOrigin;
}

/** One historical relationship, ready to print or serialize. */
export interface RelationshipView {
  from: string;
  to: string;
  relationship: Relationship;
  why: string;
  hiddenBridge?: HiddenBridge;
  /** Commits that touched both files. */
  shared: number;
  /** Commits that touched `from` (the denominator of `confidence`). */
  fromChanges: number;
  toChanges: number;
  /** P(to changes | from changes). */
  confidence: number;
  /** P(from changes | to changes). */
  reverseConfidence: number;
  /** 95% Wilson score interval for directional confidence (`shared / fromChanges`), always unweighted. */
  interval: WilsonInterval;
  /** 95% Wilson score interval for reverse directional confidence (`shared / toChanges`), always unweighted. */
  reverseInterval: WilsonInterval;
  /** Evidence-adjusted ranking score (Wilson lower bound of confidence). */
  score: number;
  /** True when confidence is recency-weighted (--half-life) or origin-weighted (--origin-weights), so it is not simply shared / fromChanges. */
  weighted: boolean;
  /** Which weighting mode is active when `weighted` is true (`recency`, `origin`, or `recency+origin`). */
  weighting?: WeightingMode;
  lastTogether: string;
  crossesDirectories: boolean;
  /** Share of all shared commits by commit origin (human, agent, bot), summing to 1. */
  originShare?: OriginShare;
  evidence: EvidenceView[];
}

export interface HeadInfo {
  ref: string;
  sha: string;
}

export interface Meta {
  tool: 'repo-archaeology';
  root: string;
  head?: HeadInfo;
  commitsRead: number;
  commitsAnalyzed: number;
  sweepsSkipped: number;
  subjectSkipped: number;
  renamesFollowed: number;
  files: number;
  oldestCommit?: string;
  newestCommit?: string;
  /** Counts of analyzed commits by origin. */
  origins?: OriginCounts;
  settings: {
    maxCommits: number;
    since?: string;
    maxFilesPerCommit: number;
    minShared: number;
    minConfidence: number;
    halfLifeDays?: number;
    skipCommits?: string;
    ignore: string[];
    useDefaultIgnores: boolean;
    origin?: OriginConfig;
  };
  warnings: string[];
}

export function buildMeta(ctx: Context): Meta {
  const { stats } = ctx.history;
  const s = ctx.settings;
  const origins: OriginCounts = { human: 0, agent: 0, bot: 0 };
  for (const commit of ctx.history.commits) {
    const o: CommitOrigin = commit.origin ?? 'human';
    origins[o]++;
  }
  return {
    tool: 'repo-archaeology',
    root: ctx.root,
    ...(ctx.head !== undefined ? { head: { ref: ctx.head.ref, sha: ctx.head.sha } } : {}),
    commitsRead: stats.commitsRead,
    commitsAnalyzed: ctx.history.commits.length,
    sweepsSkipped: stats.sweepsSkipped,
    subjectSkipped: stats.subjectSkipped,
    renamesFollowed: stats.renamesFollowed,
    files: ctx.model.fileCount,
    oldestCommit: stats.oldestTime ? isoDate(stats.oldestTime) : undefined,
    newestCommit: stats.newestTime ? isoDate(stats.newestTime) : undefined,
    origins,
    settings: {
      maxCommits: s.maxCommits,
      since: s.since,
      maxFilesPerCommit: s.maxFilesPerCommit,
      minShared: s.minShared,
      minConfidence: s.minConfidence,
      halfLifeDays: s.halfLifeDays,
      skipCommits: s.skipCommits,
      ignore: [...s.ignore],
      useDefaultIgnores: s.useDefaultIgnores,
      ...(s.origin !== undefined ? { origin: s.origin } : {}),
    },
    warnings: ctx.warnings,
  };
}

export function toView(ctx: Context, companion: Companion, relationship: Relationship, fromPath?: string, toPath?: string): RelationshipView {
  const { model } = ctx;
  const from = fromPath ?? model.path(companion.from);
  const to = toPath ?? model.path(companion.to);
  const hiddenBridge = relationship === 'ghost' ? ctx.classifier.hiddenBridge(from, to) : undefined;
  const shared = companion.stat.count;
  const fromChanges = model.changeCount[companion.from] ?? 0;
  const toChanges = model.changeCount[companion.to] ?? 0;
  return {
    from,
    to,
    relationship,
    why: ctx.classifier.explain(from, to, relationship, hiddenBridge),
    hiddenBridge,
    shared,
    fromChanges,
    toChanges,
    confidence: round(companion.confidence),
    reverseConfidence: round(companion.reverseConfidence),
    interval: roundInterval(wilsonInterval(shared, fromChanges)),
    reverseInterval: roundInterval(wilsonInterval(shared, toChanges)),
    score: round(companion.score),
    weighted: model.weighted,
    ...(model.weighted ? { weighting: model.weighting } : {}),
    lastTogether: isoDate(companion.stat.lastTime),
    crossesDirectories: posix.dirname(from) !== posix.dirname(to),
    originShare: computeOriginShare(companion.stat.originCounts),
    evidence: companion.stat.evidence.map((i) => {
      const commit = model.commits[i]!;
      return {
        hash: commit.hash,
        date: isoDate(commit.time),
        author: commit.author,
        subject: commit.subject,
        origin: commit.origin ?? 'human',
      };
    }),
  };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export function roundInterval(interval: WilsonInterval): WilsonInterval {
  return {
    low: Math.floor(interval.low * 10000) / 10000,
    high: Math.ceil(interval.high * 10000) / 10000,
  };
}

export function formatIntervalCi(interval: WilsonInterval, raw = false): string {
  return `(${raw ? 'raw ' : ''}95% CI ${Math.floor(interval.low * 100 + 1e-9)}–${Math.ceil(interval.high * 100 - 1e-9)}%)`;
}

const LABELS: Record<Relationship, (s: string) => string> = {
  ghost: (s) => c.magenta(s),
  unknown: (s) => c.yellow(s),
  indirect: (s) => c.cyan(s),
  direct: (s) => c.blue(s),
  test: (s) => c.green(s),
};

export const NAMES: Record<Relationship, string> = {
  ghost: 'ghost wire',
  unknown: 'unchecked',
  indirect: 'indirect import',
  direct: 'import link',
  test: 'test link',
};

export function relationshipLabel(r: Relationship): string {
  return LABELS[r](NAMES[r]);
}

export function printHeader(title: string, meta: Meta): void {
  console.log(`${c.bold('Repo Archaeology')} ${c.dim('·')} ${title}`);
  const span = meta.oldestCommit && meta.newestCommit ? ` from ${meta.oldestCommit} to ${meta.newestCommit}` : '';
  const skippedParts = [
    meta.sweepsSkipped > 0 ? plural(meta.sweepsSkipped, 'sweeping commit') : '',
    meta.subjectSkipped > 0 ? `${meta.subjectSkipped} matching --skip-commits` : '',
  ].filter(Boolean);
  const skipped = skippedParts.length > 0 ? `, ${skippedParts.join(' and ')} skipped` : '';
  console.log(c.dim(`${plural(meta.commitsAnalyzed, 'commit')} analyzed${span}${skipped}`));
  for (const warning of meta.warnings) console.log(c.yellow(`! ${terminalText(warning)}`));
  console.log();
}

export function printEvidence(view: RelationshipView, indent = '    '): void {
  for (const e of view.evidence) {
    console.log(`${indent}${c.gray(shortHash(e.hash))} ${c.dim(e.date)}  ${terminalText(e.subject)}`);
  }
}

export function describeStrength(view: RelationshipView): string {
  // With a half-life or origin weights the percentage is weighted, so it is not shared/total: say so, and keep the raw CI next to the raw count.
  const wLabel = weightingLabel(view);
  const countsAndRate = view.weighted
    ? `${view.shared} of ${view.fromChanges} commits ${formatIntervalCi(view.interval, true)} (${pct(view.confidence)} ${wLabel})`
    : `${view.shared} of ${view.fromChanges} commits (${pct(view.confidence)}) ${formatIntervalCi(view.interval)}`;
  return `${countsAndRate} · last together ${timeAgo(Date.parse(view.lastTogether) / 1000)}`;
}

export const DISCLAIMER = 'Historical signal, not proof: check whether the change really needs these files.';
