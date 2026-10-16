import { posix } from 'node:path';
import type { Context } from '../context.js';
import type { Relationship } from '../imports/classify.js';
import type { Companion } from '../model/cochange.js';
import { c, isoDate, pct, plural, shortHash, timeAgo } from '../util/term.js';

export interface EvidenceView {
  hash: string;
  date: string;
  author: string;
  subject: string;
}

/** One historical relationship, ready to print or serialize. */
export interface RelationshipView {
  from: string;
  to: string;
  relationship: Relationship;
  why: string;
  /** Commits that touched both files. */
  shared: number;
  /** Commits that touched `from` (the denominator of `confidence`). */
  fromChanges: number;
  toChanges: number;
  /** P(to changes | from changes). */
  confidence: number;
  /** P(from changes | to changes). */
  reverseConfidence: number;
  /** Evidence-adjusted ranking score (Wilson lower bound of confidence). */
  score: number;
  /** True when confidence is recency-weighted (--half-life), so it is not simply shared / fromChanges. */
  weighted: boolean;
  lastTogether: string;
  crossesDirectories: boolean;
  evidence: EvidenceView[];
}

export interface Meta {
  tool: 'repo-archaeology';
  root: string;
  commitsRead: number;
  commitsAnalyzed: number;
  sweepsSkipped: number;
  subjectSkipped: number;
  renamesFollowed: number;
  files: number;
  oldestCommit?: string;
  newestCommit?: string;
  settings: {
    maxCommits: number;
    since?: string;
    maxFilesPerCommit: number;
    minShared: number;
    minConfidence: number;
    halfLifeDays?: number;
    skipCommits?: string;
  };
  warnings: string[];
}

export function buildMeta(ctx: Context): Meta {
  const { stats } = ctx.history;
  const s = ctx.settings;
  return {
    tool: 'repo-archaeology',
    root: ctx.root,
    commitsRead: stats.commitsRead,
    commitsAnalyzed: ctx.history.commits.length,
    sweepsSkipped: stats.sweepsSkipped,
    subjectSkipped: stats.subjectSkipped,
    renamesFollowed: stats.renamesFollowed,
    files: ctx.model.fileCount,
    oldestCommit: stats.oldestTime ? isoDate(stats.oldestTime) : undefined,
    newestCommit: stats.newestTime ? isoDate(stats.newestTime) : undefined,
    settings: {
      maxCommits: s.maxCommits,
      since: s.since,
      maxFilesPerCommit: s.maxFilesPerCommit,
      minShared: s.minShared,
      minConfidence: s.minConfidence,
      halfLifeDays: s.halfLifeDays,
      skipCommits: s.skipCommits,
    },
    warnings: ctx.warnings,
  };
}

export function toView(ctx: Context, companion: Companion, relationship: Relationship, fromPath?: string): RelationshipView {
  const { model } = ctx;
  const from = fromPath ?? model.path(companion.from);
  const to = model.path(companion.to);
  return {
    from,
    to,
    relationship,
    why: ctx.classifier.explain(from, to, relationship),
    shared: companion.stat.count,
    fromChanges: model.changeCount[companion.from] ?? 0,
    toChanges: model.changeCount[companion.to] ?? 0,
    confidence: round(companion.confidence),
    reverseConfidence: round(companion.reverseConfidence),
    score: round(companion.score),
    weighted: model.weighted,
    lastTogether: isoDate(companion.stat.lastTime),
    crossesDirectories: posix.dirname(from) !== posix.dirname(to),
    evidence: companion.stat.evidence.map((i) => {
      const commit = model.commits[i]!;
      return { hash: commit.hash, date: isoDate(commit.time), author: commit.author, subject: commit.subject };
    }),
  };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

const LABELS: Record<Relationship, (s: string) => string> = {
  ghost: (s) => c.magenta(s),
  unknown: (s) => c.yellow(s),
  direct: (s) => c.blue(s),
  test: (s) => c.green(s),
};

const NAMES: Record<Relationship, string> = {
  ghost: 'ghost wire',
  unknown: 'unchecked',
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
  for (const warning of meta.warnings) console.log(c.yellow(`! ${warning}`));
  console.log();
}

export function printEvidence(view: RelationshipView, indent = '    '): void {
  for (const e of view.evidence) {
    console.log(`${indent}${c.gray(shortHash(e.hash))} ${c.dim(e.date)}  ${e.subject}`);
  }
}

export function describeStrength(view: RelationshipView): string {
  // With a half-life the percentage is weighted, so it is not shared/total: say so.
  const rate = view.weighted ? `${pct(view.confidence)} recency-weighted` : pct(view.confidence);
  return `${view.shared} of ${view.fromChanges} commits (${rate}) · last together ${timeAgo(Date.parse(view.lastTogether) / 1000)}`;
}

export const DISCLAIMER = 'Historical signal, not proof: check whether the change really needs these files.';
