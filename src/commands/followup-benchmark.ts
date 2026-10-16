import { UsageError, type Context } from '../context.js';
import { CoChangeModel, compareCompanions, type Companion, type Thresholds } from '../model/cochange.js';
import { pathOf, type HistoryCommit } from '../model/history.js';
import { buildMeta, printHeader, type Meta } from '../report/views.js';
import { ratio } from '../util/stats.js';
import { c, isoDate, pct, plural, terminalText } from '../util/term.js';
import { EVALUATION_MAX_FILES } from './backtest.js';

export const DEFAULT_FOLLOW_UP_WINDOW_HOURS = 48;
export const MAX_FOLLOW_UP_CASES = 50;

/**
 * Commit-subject cues that suggest a commit is following up on recent work.
 * Attached as a descriptive signal label on same-author candidate pairs; never
 * used as a standalone qualifier or treated as proof of a defect.
 */
export const FOLLOW_UP_SUBJECT_RE =
  /\b(fix(?:es|ed|up)?|forgot(?:ten)?|miss(?:ed|ing)?|follow[- ]?up|oops|amend|repair|patch|sync|companion)\b/i;

export type FollowUpSignal = 'subject-cue' | 'shared-file' | 'immediate-same-author';

export const FOLLOW_UP_SIGNALS: readonly FollowUpSignal[] = [
  'subject-cue',
  'shared-file',
  'immediate-same-author',
];

export interface FollowUpBenchmarkOptions {
  /** Share of the newest commits held out for candidate detection (0..1). */
  testFraction: number;
  /** Maximum recommendations considered per candidate changeset. */
  k: number;
  /** Maximum hours between an initial commit and a candidate follow-up commit (default 48). */
  windowHours?: number;
  /** Ignore commits after this time (unix seconds). */
  before?: number;
  /** Maximum candidate cases retained in `cases` (default `MAX_FOLLOW_UP_CASES`). */
  maxCases?: number;
}

export interface FollowUpCandidateCase {
  initialCommit: {
    hash: string;
    date: string;
    author: string;
    subject: string;
    files: string[];
  };
  followUpCommit: {
    hash: string;
    date: string;
    author: string;
    subject: string;
    /** Pre-existing files modified in `followUpCommit` that were not touched in `initialCommit`. */
    laterFiles: string[];
  };
  deltaMinutes: number;
  signals: FollowUpSignal[];
  trainingCommitsBefore: number;
  /** Recommendations from the primary `co-change` strategy trained strictly before `initialCommit`. */
  recommended: string[];
  /** Recommended files that matched `laterFiles`. */
  matched: string[];
  /** Recommended files that were not in `laterFiles`. */
  falsePositives: string[];
}

export interface FollowUpStrategyScore {
  name: string;
  description: string;
  /** Total candidate follow-up pairs evaluated. */
  candidates: number;
  /** Candidates where the strategy triggered at least one recommendation. */
  triggered: number;
  /** triggered / candidates, or null when candidates === 0. */
  coverage: number | null;
  /** Total recommendations made across all triggered candidates. */
  recommendations: number;
  /** Recommendations that matched a file modified in the candidate follow-up commit. */
  correctMatches: number;
  /** Recommendations that did not match the candidate follow-up commit. */
  falsePositives: number;
  /** Triggered candidates with at least one correct match (hit@k). */
  hitCandidates: number;
  /** Triggered candidates where all recommendations were false positives. */
  falseAlarmCandidates: number;
  /** hitCandidates / triggered, or null when triggered === 0. */
  hitRate: number | null;
  /** correctMatches / recommendations, or null when recommendations === 0. */
  precision: number | null;
  /** falsePositives / recommendations, or null when recommendations === 0. */
  falsePositiveRate: number | null;
  /** falseAlarmCandidates / triggered, or null when triggered === 0. */
  falseAlarmRate: number | null;
  /** correctMatches / totalLaterFiles across all evaluated candidates, or null when totalLaterFiles === 0. */
  recall: number | null;
}

export interface FollowUpSignalSummary {
  signal: FollowUpSignal;
  candidates: number;
  totalLaterFiles: number;
  strategies: FollowUpStrategyScore[];
}

export interface FollowUpBenchmarkResult {
  meta?: Meta;
  k: number;
  windowHours: number;
  initialTrainCommits: number;
  heldOutCommits: number;
  before?: string;
  /** Number of CoChangeModel instances constructed during the benchmark run. */
  modelsBuilt: number;
  /** Candidate follow-up pairs where at least one initial file had pre-change history. */
  candidatesEvaluated: number;
  /** Candidate follow-up pairs skipped because no initial file existed in pre-change history. */
  candidatesWithoutHistory: number;
  /** Total later-modified files across all evaluated candidates. */
  totalLaterFiles: number;
  strategies: FollowUpStrategyScore[];
  /** Breakdown of candidate counts and strategy scores by candidate signal. */
  bySignal: Record<FollowUpSignal, FollowUpSignalSummary>;
  /** Sample of evaluated candidate cases (capped to `maxCases`, paths normalized via `pathOf`). */
  cases: FollowUpCandidateCase[];
  /** Number of evaluated candidate cases omitted from `cases` due to `maxCases`. */
  casesTruncated: number;
  methodology: string;
  limitations: string[];
}

export const FOLLOW_UP_METHODOLOGY =
  'Orders commits chronologically by committer timestamp (commitTime, breaking ties by git-log order) and identifies candidate temporal follow-up pairs in the held-out window by the same author (matched by normalized author email, falling back to author name) within the configured time window that share a modified file or occur immediately consecutively, attaching subject-cue labels when the follow-up subject matches fix/follow-up terms. Each follow-up commit is paired with at most one (the nearest qualifying) initial commit. For each candidate pair, the CoChangeModel is trained strictly on commits preceding the initial commit and evaluated on whether its top-k untouched recommendations match the pre-existing files modified in the follow-up commit.';

export const FOLLOW_UP_LIMITATIONS: string[] = [
  'Candidate follow-up commits are not confirmed bug fixes or omissions: developers frequently split work across stacked commits, sequential refactoring steps, or separate tasks intentionally.',
  'Commits are ordered by committer timestamp (commitTime): rebased commit stacks may be compressed into a single timestamp burst, and clock skew across machines can reorder commits relative to author time.',
  'The unconditioned rows ("co-change, no thresholds" and "popularity baseline") are evaluated across all candidates with up to k recommendations per candidate, whereas "popularity, same changes" is restricted to candidates where "co-change" triggered and capped to the exact number of recommendations "co-change" emitted on each candidate.',
  'Omissions caught before committing or squashed during interactive rebase leave no separate follow-up commit in Git history and cannot be observed by this benchmark.',
  'Because candidate selection pairs sequential same-author commits within a time window, unrelated consecutive commits count as false positives when the model recommends a historical companion that was not part of the next commit; consult `bySignal["subject-cue"]` to inspect the subset with explicit fix/follow-up subject cues.',
];

interface StrategyTally {
  triggered: number;
  recommendations: number;
  correctMatches: number;
  falsePositives: number;
  hitCandidates: number;
}

function createTallies(count: number): StrategyTally[] {
  return Array.from({ length: count }, () => ({
    triggered: 0,
    recommendations: 0,
    correctMatches: 0,
    falsePositives: 0,
    hitCandidates: 0,
  }));
}

function nullableRatio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : ratio(numerator, denominator);
}

function cleanPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((p) => pathOf(p)))];
}

export function sameAuthor(a: HistoryCommit, b: HistoryCommit): boolean {
  const emailA = a.authorEmail?.trim().toLowerCase();
  const emailB = b.authorEmail?.trim().toLowerCase();
  if (emailA && emailB) return emailA === emailB;
  return a.author !== '' && a.author === b.author;
}

export function followUpBenchmark(ctx: Context, options: FollowUpBenchmarkOptions): FollowUpBenchmarkResult {
  const result = followUpBenchmarkCommits(
    ctx.history.commits,
    ctx.thresholds,
    options,
    ctx.settings.halfLifeDays,
    ctx.history.excluded,
  );
  return { ...result, meta: buildMeta(ctx) };
}

export function followUpBenchmarkCommits(
  commits: readonly HistoryCommit[],
  thresholds: Thresholds,
  options: FollowUpBenchmarkOptions,
  halfLifeDays?: number,
  excluded: readonly HistoryCommit[] = [],
): Omit<FollowUpBenchmarkResult, 'meta'> {
  if (!(options.testFraction > 0 && options.testFraction < 1)) {
    throw new UsageError('--test-fraction must be between 0 and 1.');
  }
  if (!(Number.isInteger(options.k) && options.k >= 1)) {
    throw new UsageError('--k must be a positive integer.');
  }
  const windowHours = options.windowHours ?? DEFAULT_FOLLOW_UP_WINDOW_HOURS;
  if (!(Number.isFinite(windowHours) && windowHours > 0)) {
    throw new UsageError('--follow-up-window must be a positive number of hours.');
  }
  const windowSeconds = windowHours * 3600;
  const maxCases = options.maxCases ?? MAX_FOLLOW_UP_CASES;

  if (options.before !== undefined) {
    const cutoff = options.before;
    commits = commits.filter((c) => c.commitTime < cutoff);
    excluded = excluded.filter((c) => c.commitTime < cutoff);
  }

  const left = new Set(excluded);
  const ordered = [...commits, ...excluded].sort((x, y) =>
    y.commitTime - x.commitTime
    || compareLogOrder(x, y)
    || (x.hash < y.hash ? -1 : x.hash > y.hash ? 1 : 0),
  );
  const chronological = [...ordered].reverse();
  const heldOutCount = chronological.length > 0 ? Math.max(1, Math.round(chronological.length * options.testFraction)) : 0;
  const splitIndex = Math.max(0, chronological.length - heldOutCount);

  const available = new Set<string>();
  const seenInTraining = new Set<string>();
  const priorTrainCommits: HistoryCommit[] = [];
  for (let i = 0; i < splitIndex; i++) {
    const commit = chronological[i]!;
    updateAvailability(available, commit);
    if (!left.has(commit)) {
      priorTrainCommits.push(commit);
      for (const f of commit.files) seenInTraining.add(f);
    }
  }
  const initialTrainCommits = priorTrainCommits.length;

  const useIncrementalModel = !(halfLifeDays && halfLifeDays > 0);
  const incrementalModel = useIncrementalModel ? new CoChangeModel(priorTrainCommits) : undefined;
  let modelsBuilt = incrementalModel ? 1 : 0;

  const strategyMeta: { name: string; description: string }[] = [
    {
      name: 'co-change',
      description: `configured thresholds (≥${thresholds.minShared} shared, ≥${pct(thresholds.minConfidence)} confidence)`,
    },
    {
      name: 'co-change, no thresholds',
      description: 'unconditioned Wilson ranking with minShared=1, minConfidence=0 (up to k guesses on all candidates)',
    },
    {
      name: 'popularity baseline',
      description: `unconditioned top-${options.k} most frequently changed untouched files before the initial commit`,
    },
    {
      name: 'popularity, same changes',
      description: 'popularity baseline on the same triggered candidates, capped to co-change’s recommendation count per candidate',
    },
  ];

  const tallies = createTallies(strategyMeta.length);
  const signalState: Record<
    FollowUpSignal,
    { candidates: number; totalLaterFiles: number; tallies: StrategyTally[] }
  > = {
    'subject-cue': { candidates: 0, totalLaterFiles: 0, tallies: createTallies(strategyMeta.length) },
    'shared-file': { candidates: 0, totalLaterFiles: 0, tallies: createTallies(strategyMeta.length) },
    'immediate-same-author': { candidates: 0, totalLaterFiles: 0, tallies: createTallies(strategyMeta.length) },
  };

  let candidatesEvaluated = 0;
  let candidatesWithoutHistory = 0;
  let totalLaterFiles = 0;
  let casesTruncated = 0;
  const cases: FollowUpCandidateCase[] = [];
  const claimedFollowUps = new Set<string>();

  for (let i = splitIndex; i < chronological.length; i++) {
    const initial = chronological[i]!;
    const initialDeleted = new Set(initial.deleted ?? []);
    const initialLiveFiles = initial.files.filter((f) => !initialDeleted.has(f));

    if (initial.files.length >= 1 && initial.files.length <= EVALUATION_MAX_FILES && initialLiveFiles.length > 0) {
      for (let j = i + 1; j < chronological.length; j++) {
        const followUp = chronological[j]!;
        const deltaSeconds = followUp.commitTime - initial.commitTime;
        if (deltaSeconds > windowSeconds) break;
        if (claimedFollowUps.has(followUp.hash)) continue;
        if (followUp.files.length === 0 || followUp.files.length > EVALUATION_MAX_FILES) continue;
        if (!sameAuthor(initial, followUp)) continue;

        const followUpDeleted = new Set(followUp.deleted ?? []);
        const initialSet = new Set(initial.files);
        const laterFiles = followUp.files.filter(
          (f) => !initialSet.has(f) && !followUpDeleted.has(f) && available.has(f),
        );
        if (laterFiles.length === 0) continue;

        const signals: FollowUpSignal[] = [];
        if (followUp.files.some((f) => initialSet.has(f))) {
          signals.push('shared-file');
        }
        if (j === i + 1) {
          signals.push('immediate-same-author');
        }
        if (signals.length === 0) continue;

        // If a nearer initial commit k (i < k < j) by the same author also qualifies with
        // this followUp and has not itself already been claimed as a follow-up, let the
        // nearest earlier initial commit k claim `followUp`.
        if (j > i + 1 && hasNearerQualifyingInitial(chronological, i, j, followUp, followUpDeleted, available, claimedFollowUps)) {
          continue;
        }

        if (FOLLOW_UP_SUBJECT_RE.test(followUp.subject)) {
          signals.unshift('subject-cue');
        }

        claimedFollowUps.add(followUp.hash);

        // Check cheap training-file set before building or querying any model.
        const hasInitialHistory = initialLiveFiles.some((f) => seenInTraining.has(f));
        if (!hasInitialHistory) {
          candidatesWithoutHistory++;
          break;
        }

        const model =
          incrementalModel ??
          (() => {
            modelsBuilt++;
            return new CoChangeModel(priorTrainCommits, { halfLifeDays });
          })();

        candidatesEvaluated++;
        totalLaterFiles += laterFiles.length;
        const laterSet = new Set(laterFiles);
        const touched = new Set(initial.files);

        const cochangeRecs = recommendFromModel(model, initialLiveFiles, touched, available, thresholds, options.k);
        const unthresholdedRecs = recommendFromModel(
          model,
          initialLiveFiles,
          touched,
          available,
          { minShared: 1, minConfidence: 0 },
          options.k,
        );
        const popularRecs = recommendPopular(model, touched, available, options.k);
        // Fair matched baseline: same triggered candidates AND same recommendation budget as `co-change`.
        const popularSameRecs = cochangeRecs.length > 0 ? popularRecs.slice(0, cochangeRecs.length) : [];

        const allStrategyRecs = [cochangeRecs, unthresholdedRecs, popularRecs, popularSameRecs];
        recordTallies(tallies, allStrategyRecs, laterSet);
        for (const sig of signals) {
          const entry = signalState[sig];
          entry.candidates++;
          entry.totalLaterFiles += laterFiles.length;
          recordTallies(entry.tallies, allStrategyRecs, laterSet);
        }

        if (cases.length < maxCases) {
          const matched = cochangeRecs.filter((r) => laterSet.has(r));
          const falsePos = cochangeRecs.filter((r) => !laterSet.has(r));
          cases.push({
            initialCommit: {
              hash: initial.hash,
              date: isoDate(initial.commitTime),
              author: initial.author,
              subject: initial.subject,
              files: cleanPaths(initialLiveFiles),
            },
            followUpCommit: {
              hash: followUp.hash,
              date: isoDate(followUp.commitTime),
              author: followUp.author,
              subject: followUp.subject,
              laterFiles: cleanPaths(laterFiles),
            },
            deltaMinutes: Math.max(0, Math.round(deltaSeconds / 60)),
            signals,
            trainingCommitsBefore: priorTrainCommits.length,
            recommended: cleanPaths(cochangeRecs),
            matched: cleanPaths(matched),
            falsePositives: cleanPaths(falsePos),
          });
        } else {
          casesTruncated++;
        }
        break;
      }
    }

    updateAvailability(available, initial);
    if (!left.has(initial)) {
      priorTrainCommits.push(initial);
      for (const f of initial.files) seenInTraining.add(f);
      incrementalModel?.appendCommit(initial);
    }
  }

  const strategies = finalizeStrategies(strategyMeta, tallies, candidatesEvaluated, totalLaterFiles);
  const bySignal = Object.fromEntries(
    FOLLOW_UP_SIGNALS.map((sig) => [
      sig,
      {
        signal: sig,
        candidates: signalState[sig].candidates,
        totalLaterFiles: signalState[sig].totalLaterFiles,
        strategies: finalizeStrategies(
          strategyMeta,
          signalState[sig].tallies,
          signalState[sig].candidates,
          signalState[sig].totalLaterFiles,
        ),
      } satisfies FollowUpSignalSummary,
    ]),
  ) as Record<FollowUpSignal, FollowUpSignalSummary>;

  return {
    k: options.k,
    windowHours,
    initialTrainCommits,
    heldOutCommits: chronological.length - splitIndex,
    ...(options.before !== undefined ? { before: isoDate(options.before) } : {}),
    modelsBuilt,
    candidatesEvaluated,
    candidatesWithoutHistory,
    totalLaterFiles,
    strategies,
    bySignal,
    cases,
    casesTruncated,
    methodology: FOLLOW_UP_METHODOLOGY,
    limitations: [...FOLLOW_UP_LIMITATIONS],
  };
}

function hasNearerQualifyingInitial(
  chronological: readonly HistoryCommit[],
  i: number,
  j: number,
  followUp: HistoryCommit,
  followUpDeleted: ReadonlySet<string>,
  availableAtI: ReadonlySet<string>,
  claimedFollowUps: ReadonlySet<string>,
): boolean {
  const available = new Set(availableAtI);
  for (let k = i; k < j; k++) {
    const commit = chronological[k]!;
    if (k > i) {
      const kDeleted = new Set(commit.deleted ?? []);
      const kLive = commit.files.filter((f) => !kDeleted.has(f));
      if (
        !claimedFollowUps.has(commit.hash) &&
        commit.files.length >= 1 &&
        commit.files.length <= EVALUATION_MAX_FILES &&
        kLive.length > 0 &&
        sameAuthor(commit, followUp)
      ) {
        const kSet = new Set(commit.files);
        const kLater = followUp.files.filter((f) => !kSet.has(f) && !followUpDeleted.has(f) && available.has(f));
        const qualifies = k + 1 === j || followUp.files.some((f) => kSet.has(f));
        if (kLater.length > 0 && qualifies) {
          return true;
        }
      }
    }
    updateAvailability(available, commit);
  }
  return false;
}

function recordTallies(
  tallies: StrategyTally[],
  allStrategyRecs: readonly (readonly string[])[],
  laterSet: ReadonlySet<string>,
): void {
  allStrategyRecs.forEach((recs, idx) => {
    if (recs.length === 0) return;
    const t = tallies[idx]!;
    t.triggered++;
    t.recommendations += recs.length;
    const hits = recs.filter((r) => laterSet.has(r)).length;
    t.correctMatches += hits;
    t.falsePositives += recs.length - hits;
    if (hits > 0) t.hitCandidates++;
  });
}

function finalizeStrategies(
  strategyMeta: readonly { name: string; description: string }[],
  tallies: readonly StrategyTally[],
  candidates: number,
  totalLaterFiles: number,
): FollowUpStrategyScore[] {
  return strategyMeta.map((meta, idx) => {
    const t = tallies[idx]!;
    const falseAlarmCandidates = t.triggered - t.hitCandidates;
    return {
      ...meta,
      candidates,
      triggered: t.triggered,
      coverage: nullableRatio(t.triggered, candidates),
      recommendations: t.recommendations,
      correctMatches: t.correctMatches,
      falsePositives: t.falsePositives,
      hitCandidates: t.hitCandidates,
      falseAlarmCandidates,
      hitRate: nullableRatio(t.hitCandidates, t.triggered),
      precision: nullableRatio(t.correctMatches, t.recommendations),
      falsePositiveRate: nullableRatio(t.falsePositives, t.recommendations),
      falseAlarmRate: nullableRatio(falseAlarmCandidates, t.triggered),
      recall: nullableRatio(t.correctMatches, totalLaterFiles),
    };
  });
}

function recommendFromModel(
  model: CoChangeModel,
  changedFiles: readonly string[],
  touched: ReadonlySet<string>,
  available: ReadonlySet<string>,
  thresholds: Thresholds,
  k: number,
): string[] {
  const best = new Map<number, Companion>();
  for (const file of changedFiles) {
    const id = model.id(file);
    if (id === undefined) continue;
    for (const companion of model.companions(id, thresholds)) {
      const target = model.path(companion.to);
      if (touched.has(target) || !available.has(target)) continue;
      const existing = best.get(companion.to);
      if (!existing || compareCompanions(companion, existing) < 0) {
        best.set(companion.to, companion);
      }
    }
  }
  return [...best.values()]
    .sort(compareCompanions)
    .slice(0, k)
    .map((c) => model.path(c.to));
}

function recommendPopular(
  model: CoChangeModel,
  touched: ReadonlySet<string>,
  available: ReadonlySet<string>,
  k: number,
): string[] {
  return model.files
    .map((path, id) => ({ path, id, count: model.changeCount[id] ?? 0 }))
    .filter((entry) => !touched.has(entry.path) && available.has(entry.path))
    .sort((a, b) => b.count - a.count || a.id - b.id)
    .slice(0, k)
    .map((entry) => entry.path);
}

function updateAvailability(available: Set<string>, commit: HistoryCommit): void {
  const deleted = new Set(commit.deleted ?? []);
  for (const file of commit.files) {
    if (deleted.has(file)) available.delete(file);
    else available.add(file);
  }
}

function compareLogOrder(a: HistoryCommit, b: HistoryCommit): number {
  return a.logOrder !== undefined && b.logOrder !== undefined ? a.logOrder - b.logOrder : 0;
}

function fmtRate(value: number | null): string {
  return value === null ? 'n/a' : pct(value);
}

export function printFollowUpBenchmarkSection(result: Omit<FollowUpBenchmarkResult, 'meta'>): void {
  console.log(c.bold(`Candidate follow-up benchmark (≤${result.windowHours}h window, top-${result.k})`));
  console.log(
    `Evaluated ${plural(result.candidatesEvaluated, 'candidate follow-up pair')} across ${plural(result.heldOutCommits, 'held-out commit')} (${plural(result.totalLaterFiles, 'later-modified file')}).`,
  );
  if (result.candidatesWithoutHistory > 0) {
    console.log(c.dim(`Skipped ${plural(result.candidatesWithoutHistory, 'candidate pair')} whose initial commit touched only new files without prior history.`));
  }
  if (result.candidatesEvaluated === 0) {
    console.log(c.dim('No candidate follow-up pairs with prior history were found in the held-out window.'));
    return;
  }
  console.log();
  const header = ['strategy', 'triggered', 'coverage', 'matches', 'false pos', `hit@${result.k}`, 'precision', 'recall'];
  const rows = result.strategies.map((s) => [
    s.name,
    `${s.triggered}/${s.candidates}`,
    fmtRate(s.coverage),
    String(s.correctMatches),
    String(s.falsePositives),
    fmtRate(s.hitRate),
    fmtRate(s.precision),
    fmtRate(s.recall),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!))).join('   ');
  console.log(c.bold(line(header)));
  for (const row of rows) console.log(line(row));

  const activeSignals = FOLLOW_UP_SIGNALS.map((sig) => result.bySignal[sig]).filter((s) => s.candidates > 0);
  if (activeSignals.length > 0) {
    console.log();
    console.log(c.bold('By candidate signal (co-change strategy):'));
    for (const sigSummary of activeSignals) {
      const primary = sigSummary.strategies[0]!;
      console.log(
        `  ${sigSummary.signal.padEnd(22)} ${plural(sigSummary.candidates, 'pair')}, triggered ${primary.triggered}/${sigSummary.candidates} (${fmtRate(primary.coverage)}), hit@${result.k} ${fmtRate(primary.hitRate)}, precision ${fmtRate(primary.precision)}, recall ${fmtRate(primary.recall)}`,
      );
    }
  }

  console.log();
  console.log(c.dim(`Methodology: ${terminalText(result.methodology)}`));
  for (const limitation of result.limitations) {
    console.log(c.dim(`• Caveat: ${terminalText(limitation)}`));
  }
}

export function printFollowUpBenchmark(result: FollowUpBenchmarkResult): void {
  if (result.meta) printHeader('backtest --follow-ups', result.meta);
  printFollowUpBenchmarkSection(result);
}
