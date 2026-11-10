import { posix } from 'node:path';
import type { Context } from '../context.js';
import type {
  HiddenBridge,
  ImportResolutionVia,
  ImportsCoverageMeta,
  ImportUnresolvedReasonCode,
  Relationship,
} from '../imports/classify.js';
import type { Companion, WeightingMode } from '../model/cochange.js';
import {
  computeOriginShare,
  type CommitOrigin,
  type OriginConfig,
  type OriginCounts,
  type OriginShare,
} from '../model/origin.js';
import type { OwnersConfig } from '../model/owners.js';
import type { TrackRecord } from '../model/track-record.js';
import {
  VERDICTS_FILE,
  type RelationshipVerdictView,
  type VerdictsMeta,
} from '../model/verdicts.js';
import { roundInterval, wilsonInterval, type WilsonInterval } from '../util/stats.js';
import { c, isoDate, pct, plural, shortHash, terminalText, timeAgo } from '../util/term.js';

export type {
  ImportResolutionVia,
  ImportsCoverageMeta,
  ImportUnresolvedReasonCode,
} from '../imports/classify.js';
export type { RelationshipVerdictView, VerdictsMeta } from '../model/verdicts.js';

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
  /** Repo-committed relationship verdict annotation, when matched by `.repo-archaeology.verdicts.json`. */
  verdict?: RelationshipVerdictView;
  evidence: EvidenceView[];
  /** Non-enumerable full evidence list (up to `FULL_EVIDENCE_LIMIT`) used by `--style rich` / `--full-evidence`. */
  allEvidence?: EvidenceView[];
}

export function attachAllEvidence<T extends RelationshipView>(
  target: T,
  allEvidence?: EvidenceView[],
): T {
  if (allEvidence && allEvidence.length > target.evidence.length) {
    Object.defineProperty(target, 'allEvidence', {
      value: allEvidence,
      enumerable: false,
      configurable: true,
    });
  }
  return target;
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
  revertsSkipped?: number;
  renamesFollowed: number;
  files: number;
  oldestCommit?: string;
  newestCommit?: string;
  /** Counts of analyzed commits by origin. */
  origins?: OriginCounts;
  /** Summary of `.repo-archaeology.verdicts.json` entries. */
  verdicts?: VerdictsMeta;
  /** Scoped import resolution coverage for files inspected during this command. */
  imports?: ImportsCoverageMeta;
  settings: {
    maxCommits: number;
    since?: string;
    maxFilesPerCommit: number;
    minShared: number;
    minConfidence: number;
    halfLifeDays?: number;
    skipCommits?: string;
    skipReverts?: boolean;
    ignore: string[];
    useDefaultIgnores: boolean;
    origin?: OriginConfig;
    owners?: OwnersConfig;
  };
  warnings: string[];
  /** History cache usage for this run (absent only for contexts built without cache configuration). */
  cache?: CacheMeta;
}

export interface CacheMeta {
  enabled: boolean;
  hits: number;
  misses: number;
  /** Repo-relative POSIX path, or `"$REPO_ARCHAEOLOGY_CACHE_DIR"`; never absolute. */
  dir?: string;
}

function mergeWarnings(base: readonly string[], extra: readonly string[]): string[] {
  if (extra.length === 0) return base as string[];
  return [...base, ...extra.filter((warning) => !base.includes(warning))];
}

export function buildMeta(ctx: Context): Meta {
  const { stats } = ctx.history;
  const s = ctx.settings;
  const origins: OriginCounts = { human: 0, agent: 0, bot: 0 };
  for (const commit of ctx.history.commits) {
    const o: CommitOrigin = commit.origin ?? 'human';
    origins[o]++;
  }
  const importsCoverage = ctx.classifier.coverage();
  return {
    tool: 'repo-archaeology',
    root: ctx.root,
    ...(ctx.head !== undefined ? { head: { ref: ctx.head.ref, sha: ctx.head.sha } } : {}),
    commitsRead: stats.commitsRead,
    commitsAnalyzed: ctx.history.commits.length,
    sweepsSkipped: stats.sweepsSkipped,
    subjectSkipped: stats.subjectSkipped,
    revertsSkipped: stats.revertsSkipped,
    renamesFollowed: stats.renamesFollowed,
    files: ctx.model.fileCount,
    oldestCommit: stats.oldestTime ? isoDate(stats.oldestTime) : undefined,
    newestCommit: stats.newestTime ? isoDate(stats.newestTime) : undefined,
    origins,
    verdicts: ctx.verdicts?.meta ?? {
      loaded: 0,
      active: 0,
      expired: 0,
      file: VERDICTS_FILE,
    },
    ...(importsCoverage !== undefined ? { imports: importsCoverage } : {}),
    settings: {
      maxCommits: s.maxCommits,
      since: s.since,
      maxFilesPerCommit: s.maxFilesPerCommit,
      minShared: s.minShared,
      minConfidence: s.minConfidence,
      halfLifeDays: s.halfLifeDays,
      skipCommits: s.skipCommits,
      ...(s.skipReverts !== undefined ? { skipReverts: s.skipReverts } : {}),
      ignore: [...s.ignore],
      useDefaultIgnores: s.useDefaultIgnores,
      ...(s.origin !== undefined ? { origin: s.origin } : {}),
      ...(s.owners !== undefined ? { owners: s.owners } : {}),
    },
    // Import-analysis diagnostics (Go/Python manifests, budgets) for the files analyzed in this operation.
    warnings: mergeWarnings(ctx.warnings, ctx.classifier.analysisWarnings()),
    ...(ctx.history.cache !== undefined
      ? {
          cache: {
            enabled: ctx.history.cache.enabled,
            hits: ctx.history.cache.hits,
            misses: ctx.history.cache.misses,
            ...(ctx.history.cache.dir !== undefined ? { dir: ctx.history.cache.dir } : {}),
          },
        }
      : {}),
  };
}

export function toView(ctx: Context, companion: Companion, relationship: Relationship, fromPath?: string, toPath?: string): RelationshipView {
  const { model } = ctx;
  const from = fromPath ?? model.path(companion.from);
  const to = toPath ?? model.path(companion.to);
  const hiddenBridge = relationship === 'ghost' ? ctx.classifier.hiddenBridge(from, to) : undefined;
  const verdict = ctx.verdicts?.match(from, to);
  const shared = companion.stat.count;
  const fromChanges = model.changeCount[companion.from] ?? 0;
  const toChanges = model.changeCount[companion.to] ?? 0;
  const mapCommitIndex = (i: number): EvidenceView => {
    const commit = model.commits[i]!;
    return {
      hash: commit.hash,
      date: isoDate(commit.time),
      author: commit.author,
      subject: commit.subject,
      origin: commit.origin ?? 'human',
    };
  };
  const view: RelationshipView = {
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
    ...(verdict !== undefined ? { verdict } : {}),
    evidence: companion.stat.evidence.map(mapCommitIndex),
  };
  const allIndices = companion.stat.allEvidence;
  return attachAllEvidence(
    view,
    allIndices && allIndices.length > companion.stat.evidence.length
      ? allIndices.map(mapCommitIndex)
      : undefined,
  );
}

export function formatVerdictAnnotation(verdict: RelationshipVerdictView): string {
  const badge = verdict.kind === 'confirmed' ? c.green('confirmed') : c.yellow('expected (silenced)');
  const metaParts: string[] = [];
  if (verdict.by) metaParts.push(`by ${terminalText(verdict.by)}`);
  if (verdict.until) metaParts.push(`until ${terminalText(verdict.until)}`);
  const metaStr = metaParts.length > 0 ? c.dim(` (${metaParts.join(', ')})`) : '';
  return `${badge}${metaStr}: ${terminalText(verdict.reason)}`;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export { roundInterval } from '../util/stats.js';

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
  const revertsSkipped = meta.revertsSkipped ?? 0;
  const skippedParts = [
    meta.sweepsSkipped > 0 ? plural(meta.sweepsSkipped, 'sweeping commit') : '',
    revertsSkipped > 0 ? plural(revertsSkipped, 'revert commit') : '',
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

/** `trackRecord.fired` below this is labelled "small sample" in every renderer. */
export const TRACK_RECORD_SMALL_SAMPLE = 5;

/**
 * The one-line track-record summary shared by the classic, rich and Markdown renderers, so the
 * wording cannot drift: counts first, never framed as accuracy. `name` formats the target's
 * file name for the output medium (terminal sanitizing or Markdown code). Accepts every shape
 * `common.schema.json#/$defs/TrackRecord` allows. Returns `undefined` when nothing should be
 * printed: no track record, `limited_history`, or a `never_fired` record without
 * `evaluated.commits` (no window size to report).
 */
export function formatTrackRecordLine(
  s: { to: string; trackRecord?: TrackRecord },
  name: (fileName: string) => string = (x) => x,
): { text: string; dim: boolean } | undefined {
  const tr = s.trackRecord;
  if (!tr || !('fired' in tr)) return undefined;
  if ('reason' in tr) {
    // Every field but `fired` and `reason` is optional on the wire: say only what is present.
    const commits = tr.evaluated?.commits;
    if (typeof commits !== 'number') return undefined;
    const excluded = tr.excluded;
    const unresolved = excluded ? excluded.censored + excluded.targetDeleted + excluded.clockSkew : undefined;
    if (tr.triggers === 0) {
      return { text: `No earlier triggers in the last ${commits} commits.`, dim: true };
    }
    if (typeof tr.triggers === 'number' && typeof unresolved === 'number' && unresolved > 0) {
      return {
        text: `No completed earlier triggers in the last ${commits} commits (${unresolved} too recent or left out).`,
        dim: true,
      };
    }
    // Trigger counts unknown: `fired: 0` still means no completed episode in the window.
    return { text: `No completed earlier triggers in the last ${commits} commits.`, dim: true };
  }
  const target = name(posix.basename(s.to));
  const times = tr.fired === 1 ? '1 time' : `${tr.fired} times`;
  const caveat = tr.fired < TRACK_RECORD_SMALL_SAMPLE ? 'small sample; not proof those were fixes' : 'not proof those were fixes';
  return {
    text: `Before: ${times} this changed without ${target}; it changed within ${tr.windowHours} h after ${tr.confirmed} (${caveat}).`,
    dim: false,
  };
}

export const DISCLAIMER = 'Historical signal, not proof: check whether the change really needs these files.';
