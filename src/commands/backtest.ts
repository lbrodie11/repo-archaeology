import type { Context } from '../context.js';
import { UsageError } from '../context.js';
import { CoChangeModel, type Thresholds } from '../model/cochange.js';
import type { HistoryCommit } from '../model/history.js';
import { buildMeta, printHeader, type Meta } from '../report/views.js';
import { ratio } from '../util/stats.js';
import { c, isoDate, pct, plural } from '../util/term.js';
import {
  followUpBenchmarkCommits,
  printFollowUpBenchmarkSection,
  type FollowUpBenchmarkResult,
} from './followup-benchmark.js';

export interface BacktestOptions {
  /** Share of the newest commits held out for testing (0..1). */
  testFraction: number;
  /** Number of suggestions considered per query. */
  k: number;
  /**
   * Ignore commits after this time (unix seconds). Lets you tune settings on an
   * older window and keep the newest commits untouched for the final score.
   */
  before?: number;
  ghosts?: boolean;
  /** Also evaluate candidate temporal follow-up commits in the held-out window. */
  followUps?: boolean;
  /** Maximum hours between an initial commit and a candidate follow-up commit (default 48). */
  followUpWindowHours?: number;
}

export interface GhostDiagnostics {
  classification: 'current-code';
  queries: number;
  fired: number;
  suggestions: number;
  correct: number;
  coverage: number;
  hitRate: number;
  precision: number;
  falseAlarmRate: number;
  caveat: string;
}

export interface StrategyScore {
  name: string;
  description: string;
  /** Queries where the strategy suggested at least one file. */
  fired: number;
  /** fired / queries. */
  coverage: number;
  /** Of all suggestions made, the share that really changed in the same commit. */
  precision: number;
  /** Of fired queries, the share with at least one correct suggestion (hit@k). */
  hitRate: number;
  /** Of fired queries, the share where every suggestion was wrong. */
  falseAlarmRate: number;
  /** Of all files that really changed alongside, the share that was suggested. */
  recall: number;
}

export interface BacktestResult {
  meta: Meta;
  k: number;
  train: { commits: number; from?: string; to?: string };
  test: { commits: number; from?: string; to?: string };
  /** One query per (held-out commit, changed file with training history). */
  queries: number;
  /** Set when --before cut off the newest commits. */
  before?: string;
  /** Queries whose commit changed no other file: any suggestion there is a false alarm. */
  soloQueries: number;
  strategies: StrategyScore[];
  notes: string[];
  ghostDiagnostics?: GhostDiagnostics;
  followUpBenchmark?: Omit<FollowUpBenchmarkResult, 'meta'>;
}

type Recommender = (fileId: number) => number[];

export const MIN_COMMITS_FOR_BACKTEST = 30;

/**
 * Held-out commits touching more files than this are not replayed. Fixed on purpose:
 * if it followed --max-files, tightening the filter would also quietly drop the
 * hardest test cases and make the score look better than it is.
 */
export const EVALUATION_MAX_FILES = 25;

/**
 * Chronological backtest: learn from older commits only, then replay each newer
 * commit one file at a time and check whether the suggestions for that file were
 * among the files that really changed with it, using a frozen training model.
 */
export function backtest(ctx: Context, options: BacktestOptions): BacktestResult {
  const isGhost = options.ghosts ? (from: string, to: string) => ctx.currentFiles.has(from)
    && ctx.currentFiles.has(to) && ctx.classifier.classify(from, to) === 'ghost' : undefined;
  const result = backtestCommits(ctx.history.commits, ctx.thresholds, options, ctx.settings.halfLifeDays, ctx.history.excluded, isGhost);
  return { ...result, meta: buildMeta(ctx) };
}

/**
 * @param commits  commits the model may learn from
 * @param excluded commits the settings leave out of learning (sweeps, skipped subjects);
 *                 they still take part in the chronological split and are replayed
 *                 when small enough, so every setting is scored on the same test cases
 */
export function backtestCommits(
  commits: readonly HistoryCommit[],
  thresholds: Thresholds,
  options: BacktestOptions,
  halfLifeDays?: number,
  excluded: readonly HistoryCommit[] = [],
  isGhost?: (from: string, to: string) => boolean,
): Omit<BacktestResult, 'meta'> {
  if (!(options.testFraction > 0 && options.testFraction < 1)) throw new UsageError('--test-fraction must be between 0 and 1.');
  if (!(Number.isInteger(options.k) && options.k >= 1)) throw new UsageError('--k must be a positive integer.');
  if (options.ghosts && !isGhost) throw new UsageError('Ghost diagnostics require a current-code classifier.');
  if (options.followUpWindowHours !== undefined && !options.followUps) {
    throw new UsageError('--follow-up-window requires --follow-ups.');
  }
  if (options.before !== undefined) {
    const cutoff = options.before;
    commits = commits.filter((commit) => commit.commitTime < cutoff);
    excluded = excluded.filter((commit) => commit.commitTime < cutoff);
  }
  if (commits.length < MIN_COMMITS_FOR_BACKTEST) {
    throw new UsageError(`A backtest needs at least ${MIN_COMMITS_FOR_BACKTEST} usable commits; this history has ${commits.length}.`);
  }

  const left = new Set(excluded);
  // Git timestamps have one-second precision. Preserve git-log order for ties so
  // file availability is replayed in the same order as the original history.
  const ordered = [...commits, ...excluded].sort((x, y) =>
    y.commitTime - x.commitTime
    || compareLogOrder(x, y)
    || (x.hash < y.hash ? -1 : x.hash > y.hash ? 1 : 0),
  );
  const testCount = Math.max(1, Math.round(ordered.length * options.testFraction));
  const testTimeline = ordered.slice(0, testCount);
  const testCommits = testTimeline.filter((commit) => commit.files.length <= EVALUATION_MAX_FILES);
  const trainingTimeline = ordered.slice(testCount);
  const trainCommits = trainingTimeline.filter((commit) => !left.has(commit));
  const model = new CoChangeModel(trainCommits, { halfLifeDays });
  const available = new Set<string>();
  for (const commit of [...trainingTimeline].reverse()) updateAvailability(available, commit);

  const popular = model.files.map((_, id) => id).sort((x, y) => (model.changeCount[y] ?? 0) - (model.changeCount[x] ?? 0) || x - y);
  const existing = (ids: number[]) => ids.filter((id) => available.has(model.path(id)));
  // Set per query: whether the main strategy suggested anything (used by the fair baseline).
  let modelSpoke = false;
  const strategies: [Omit<StrategyScore, 'fired' | 'coverage' | 'precision' | 'hitRate' | 'falseAlarmRate' | 'recall'>, Recommender][] = [
    [
      { name: 'co-change', description: `your thresholds (≥${thresholds.minShared} shared, ≥${pct(thresholds.minConfidence)} confidence): what \`diff\` reports` },
      (id) => existing(model.companions(id, thresholds).map((x) => x.to)).slice(0, options.k),
    ],
    [
      { name: 'co-change, no thresholds', description: 'same ranking, always suggests something it has seen' },
      (id) => existing(model.companions(id, { minShared: 1, minConfidence: 0 }).map((x) => x.to)).slice(0, options.k),
    ],
    [
      { name: 'popularity baseline', description: `always suggests the ${options.k} most frequently changed files` },
      (id) => existing(popular.filter((p) => p !== id)).slice(0, options.k),
    ],
    [
      // The fair comparison: co-change only speaks up on some changes, which may be easier ones.
      { name: 'popularity, same changes', description: 'the popularity guess, scored only where co-change spoke up' },
      (id) => (modelSpoke ? existing(popular.filter((p) => p !== id)).slice(0, options.k) : []),
    ],
  ];

  const tallies = strategies.map(() => ({ fired: 0, suggestions: 0, correct: 0, hitQueries: 0 }));
  const ghostTally = { fired: 0, suggestions: 0, correct: 0, hitQueries: 0 };
  let queries = 0;
  let soloQueries = 0;
  let expectedTotal = 0;

  for (const commit of [...testTimeline].reverse()) {
    if (commit.files.length <= EVALUATION_MAX_FILES) {
      for (const file of commit.files) {
        const id = model.id(file);
        if (id === undefined) continue; // a file born after the split: nothing to learn from
        const expected = new Set(commit.files.filter((f) => f !== file).map((f) => model.id(f)).filter((x): x is number => x !== undefined));
        const unseen = commit.files.length - 1 - expected.size; // companions that did not exist in training: impossible to predict, still count against recall
        queries++;
        if (commit.files.length === 1) soloQueries++;
        expectedTotal += expected.size + unseen;
        strategies.forEach(([, recommend], i) => {
          const suggested = recommend(id);
          if (i === 0) modelSpoke = suggested.length > 0;
          if (i === 0 && options.ghosts && isGhost) {
            const ghosts = suggested.filter((target) => isGhost(model.path(id), model.path(target)));
            const correct = ghosts.filter((target) => expected.has(target)).length;
            ghostTally.suggestions += ghosts.length;
            ghostTally.correct += correct;
            if (ghosts.length > 0) ghostTally.fired++;
            if (correct > 0) ghostTally.hitQueries++;
          }
          const t = tallies[i]!;
          if (suggested.length === 0) return;
          t.fired++;
          t.suggestions += suggested.length;
          const hits = suggested.filter((s) => expected.has(s)).length;
          t.correct += hits;
          if (hits > 0) t.hitQueries++;
        });
      }
    }
    updateAvailability(available, commit);
  }

  const scores: StrategyScore[] = strategies.map(([info], i) => {
    const t = tallies[i]!;
    return {
      ...info,
      fired: t.fired,
      coverage: ratio(t.fired, queries),
      precision: ratio(t.correct, t.suggestions),
      hitRate: ratio(t.hitQueries, t.fired),
      falseAlarmRate: ratio(t.fired - t.hitQueries, t.fired),
      recall: ratio(t.correct, expectedTotal),
    };
  });

  return {
    k: options.k,
    train: span(trainCommits),
    test: span(testCommits),
    queries,
    before: options.before !== undefined ? isoDate(options.before) : undefined,
    soloQueries,
    strategies: scores,
    notes: interpret(scores, queries),
    ...(options.ghosts ? {
      ghostDiagnostics: {
        classification: 'current-code' as const,
        queries,
        fired: ghostTally.fired,
        suggestions: ghostTally.suggestions,
        correct: ghostTally.correct,
        coverage: ratio(ghostTally.fired, queries),
        hitRate: ratio(ghostTally.hitQueries, ghostTally.fired),
        precision: ratio(ghostTally.correct, ghostTally.suggestions),
        falseAlarmRate: ratio(ghostTally.fired - ghostTally.hitQueries, ghostTally.fired),
        caveat: 'Diagnostic subset of the original top-k suggestions, classified using current working-tree imports. This leaks future information (also with --before); missing files are excluded. Not an unbiased historical accuracy estimate or a ghost-only recommender.',
      }
    } : {}),
    ...(options.followUps ? {
      followUpBenchmark: followUpBenchmarkCommits(
        commits,
        thresholds,
        {
          testFraction: options.testFraction,
          k: options.k,
          windowHours: options.followUpWindowHours,
          before: options.before,
        },
        halfLifeDays,
        excluded,
      ),
    } : {}),
  };
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

function span(commits: readonly HistoryCommit[]): { commits: number; from?: string; to?: string } {
  if (commits.length === 0) return { commits: 0 };
  const times = commits.map((x) => x.commitTime);
  return { commits: commits.length, from: isoDate(Math.min(...times)), to: isoDate(Math.max(...times)) };
}

function interpret(scores: StrategyScore[], queries: number): string[] {
  const [model, , , baseline] = scores;
  if (!model || !baseline || queries === 0) return ['No held-out commit touched a file with training history, so there is nothing to score.'];
  const notes: string[] = [];
  if (model.fired === 0) {
    notes.push('With these thresholds it never spoke up. Try --min-confidence 0.3 or --min-shared 2.');
    return notes;
  }
  const lift = baseline.hitRate > 0 ? model.hitRate / baseline.hitRate : Infinity;
  if (lift >= 2) notes.push(`When it speaks up it is ${Number.isFinite(lift) ? `${lift.toFixed(1)}×` : 'far'} more often right than guessing popular files on the same changes.`);
  else if (lift >= 1.25) notes.push(`Right ${lift.toFixed(1)}× as often as guessing popular files on the same changes: useful, but expect noise. A higher --min-confidence may help.`);
  else notes.push('Barely better than guessing popular files on this repository: treat its suggestions with caution.');
  if (model.coverage < 0.05) notes.push('It rarely speaks up (under 5% of changes). That is fine for a quiet reviewer; lower --min-confidence for more suggestions.');
  if (model.falseAlarmRate > 0.6) notes.push('Most alerts were wrong: raise --min-confidence to make it quieter but more reliable.');
  notes.push('To tune settings without overfitting, experiment with --before <date> (an older window), then report one final run without it.');
  return notes;
}

export function printBacktest(result: BacktestResult): void {
  printHeader('backtest', result.meta);
  console.log(`Learned from ${plural(result.train.commits, 'older commit')} ${c.dim(`(${result.train.from} → ${result.train.to})`)}`);
  console.log(`Replayed ${plural(result.test.commits, 'newer commit')} ${c.dim(`(${result.test.from} → ${result.test.to})`)}, one changed file at a time: ${plural(result.queries, 'query', 'queries')}`);
  console.log(c.dim(`${result.soloQueries} of those queries came from single-file commits, where any suggestion counts as a false alarm.`));
  if (result.before) console.log(c.dim(`Commits from ${result.before} on were left out (--before).`));
  console.log();

  const header = ['strategy', 'speaks up', `hit@${result.k}`, 'precision', 'false alarms', 'recall'];
  const rows = result.strategies.map((s) => [s.name, pct(s.coverage), pct(s.hitRate), pct(s.precision), pct(s.falseAlarmRate), pct(s.recall)]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!))).join('   ');
  console.log(c.bold(line(header)));
  for (const row of rows) console.log(line(row));
  console.log();
  for (const s of result.strategies) console.log(c.dim(`${s.name}: ${s.description}`));
  console.log(c.dim(`speaks up = share of queries with any suggestion · hit@${result.k} = of those, share with ≥1 correct · precision = correct / all suggestions · recall = share of real companions suggested`));
  console.log();
  for (const note of result.notes) console.log(`• ${note}`);
  if (result.ghostDiagnostics) {
    const ghosts = result.ghostDiagnostics;
    console.log();
    console.log(c.bold('Ghost subset (current-code diagnostic)'));
    console.log(`${ghosts.fired} of ${ghosts.queries} queries raised ghost suggestions; ${ghosts.correct} of ${ghosts.suggestions} suggestions matched the held-out commit.`);
    if (ghosts.fired > 0) console.log(`Hit rate ${pct(ghosts.hitRate)} · precision ${pct(ghosts.precision)} · false alarms ${pct(ghosts.falseAlarmRate)}`);
    else console.log('No ghost suggestions to score.');
    console.log(c.dim(ghosts.caveat));
  }
  if (result.followUpBenchmark) {
    console.log();
    printFollowUpBenchmarkSection(result.followUpBenchmark);
  }
}
