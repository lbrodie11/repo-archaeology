import type { Context } from '../context.js';
import { MIN_COMMITS_FOR_BACKTEST } from '../commands/backtest.js';
import { DEFAULT_FOLLOW_UP_WINDOW_HOURS } from '../commands/followup-benchmark.js';
import { wilsonInterval } from '../util/stats.js';
import { isoDate } from '../util/term.js';
import {
  combineOriginCounts,
  companionQualifies,
  compareChronological,
  confidenceRatio,
  DecayedSum,
  type Thresholds,
} from './cochange.js';
import type { HistoryCommit } from './history.js';
import { hasNonDefaultOriginWeights, resolveOriginWeights, type OriginCounts, type OriginWeights } from './origin.js';

/**
 * Per-pair track record (RA-06): "when this pair triggered before, did the target change soon after?"
 *
 * Replays the history the `diff` baseline model trains on, oldest first, and for each tracked
 * directional pair `from → to` records every *threshold trigger*: a commit that touches `from`,
 * does not touch `to`, while (using only strictly earlier commits) `to` qualifies as a companion
 * of `from` under the same `minShared` / `minConfidence` thresholds `diff` uses.
 *
 * This is observational evidence about follow-up changes, not about correctness.
 */

/** Default follow-up window (hours), shared with `backtest --follow-ups`. */
export const DEFAULT_TRACK_WINDOW_HOURS = DEFAULT_FOLLOW_UP_WINDOW_HOURS;
export const MIN_TRACK_WINDOW_HOURS = 1;
export const MAX_TRACK_WINDOW_HOURS = 720;
/** Default share of usable commits replayed, as in `backtest --test-fraction`. */
export const DEFAULT_TRACK_TEST_FRACTION = 0.2;
export const TRACK_WINDOW_MIN_COMMITS = 200;
export const TRACK_WINDOW_MAX_COMMITS = 2000;

export type EpisodeExclusion = 'censored' | 'targetDeleted' | 'clockSkew';

export interface TrackWindowPlan {
  /** Usable commits in the replayed history (N). */
  usable: number;
  /** Commits replayed for triggers (W); 0 when limited. */
  window: number;
  /** Commits before the window, used only to build the initial state (N − W). */
  training: number;
  /** Minimum training commits required before the window (T). */
  minTraining: number;
  /** True when W < `MIN_COMMITS_FOR_BACKTEST`. */
  limited: boolean;
}

/**
 * `W = min(2000, max(200, round(testFraction × N)))`, clamped so that at least
 * `T = max(MIN_COMMITS_FOR_BACKTEST, ceil(N / 2))` commits remain before the window.
 * When `W < MIN_COMMITS_FOR_BACKTEST` the history is too thin for a track record.
 */
export function planTrackWindow(usable: number, testFraction = DEFAULT_TRACK_TEST_FRACTION): TrackWindowPlan {
  const n = Math.max(0, Math.floor(usable));
  const minTraining = Math.max(MIN_COMMITS_FOR_BACKTEST, Math.ceil(n / 2));
  let window = Math.min(TRACK_WINDOW_MAX_COMMITS, Math.max(TRACK_WINDOW_MIN_COMMITS, Math.round(testFraction * n)));
  window = Math.min(window, n - minTraining);
  if (window < MIN_COMMITS_FOR_BACKTEST) {
    return { usable: n, window: 0, training: n, minTraining, limited: true };
  }
  return { usable: n, window, training: n - window, minTraining, limited: false };
}

export interface ReplayCommitRef {
  hash: string;
  /** Committer time (unix seconds). */
  commitTime: number;
  /** Position in the chronological replay timeline (0 = oldest usable commit). */
  position: number;
}

export interface ReplayEpisode {
  /** The trigger that opened the episode (`c`). */
  trigger: ReplayCommitRef;
  /** Further triggers for the same pair while the episode was open (counted only in `triggers`). */
  extraTriggers: ReplayCommitRef[];
  /** The first later commit that changed `to` within the window (`c′`), if any. */
  confirmedBy?: ReplayCommitRef;
  /** `(commitTime(c′) − commitTime(c)) / 3600` when confirmed. */
  hoursLater?: number;
  /** Why the episode is left out of `fired`, if it is. */
  excluded?: EpisodeExclusion;
}

export interface ReplayPair {
  /** History identity of the changed file (rename-aware). */
  from: string;
  /** History identity of the suggested file. */
  to: string;
}

export interface TrackRecordEvaluated {
  /** Committer date (YYYY-MM-DD) of the oldest replayed commit. */
  from: string;
  /** Committer date (YYYY-MM-DD) of the newest replayed commit. */
  to: string;
  /** Commits replayed for triggers (W). */
  commits: number;
  /** Commits before the window that built the initial state (N − W). */
  trainingCommits: number;
}

export interface PairReplay extends ReplayPair {
  plan: TrackWindowPlan;
  /** Absent when the replay was limited. */
  evaluated?: TrackRecordEvaluated;
  windowHours: number;
  episodes: ReplayEpisode[];
  /** Every threshold trigger in the window, including ones inside an open episode. */
  triggers: number;
  /** Commits in the window touching both files while `to` qualified. */
  coChanged: number;
}

export interface ReplayOptions {
  thresholds: Thresholds;
  windowHours?: number;
  testFraction?: number;
  halfLifeDays?: number;
  originWeights?: OriginWeights;
  /** `diff`'s thin/partial-baseline flag: when true every pair is `limited_history`. */
  limitedHistory?: boolean;
  /** Optional instrumentation: incremented once per counter update (tests assert it stays bounded). */
  stats?: { stateUpdates: number };
  /**
   * @internal Test hook: called for every tracked pair before each window commit is added, with
   * whether `to` qualifies as a companion of `from` on the state built from strictly earlier commits.
   */
  onEvaluate?: (event: { position: number; key: string; qualifies: boolean }) => void;
}

export function pairKey(from: string, to: string): string {
  return JSON.stringify([from, to]);
}

/**
 * Orders commits chronologically by committer time, breaking ties by git-log order then hash:
 * the order `followup-benchmark` replays and `CoChangeModel` accumulates recency weights in.
 */
export function chronologicalTimeline(commits: readonly HistoryCommit[]): HistoryCommit[] {
  return [...commits].sort(compareChronological);
}

/**
 * Weighted counter that follows `CoChangeModel`'s numerical policy: integer per-origin counts
 * (exact, order-independent) plus, with a half-life, a `DecayedSum` fed in replay order.
 */
class WeightCounter {
  readonly counts: OriginCounts = { human: 0, agent: 0, bot: 0 };
  count = 0;
  private readonly decayed?: DecayedSum;

  constructor(
    halfLifeSeconds: number | undefined,
    private readonly weights: Required<OriginWeights>,
  ) {
    if (halfLifeSeconds !== undefined) this.decayed = new DecayedSum(halfLifeSeconds);
  }

  add(commit: HistoryCommit, reference: number): void {
    const origin = commit.origin ?? 'human';
    this.count++;
    this.counts[origin]++;
    this.decayed?.add(this.weights[origin], commit.commitTime, reference);
  }

  /** `PairStat.originWeight`: the origin-weighted count. */
  originWeight(): number {
    return combineOriginCounts(this.counts, this.weights);
  }

  /** `PairStat.weight` / `changeWeight` as a model built from the same prefix holds it. */
  weight(reference: number): number {
    return this.decayed ? this.decayed.value(reference) : this.originWeight();
  }
}

interface PairState {
  pair: ReplayPair;
  key: string;
  shared: WeightCounter;
  toDeleted: boolean;
  open?: ReplayEpisode;
  result: PairReplay;
}

/**
 * Replays an already ordered (oldest first) timeline. `replayPairs` sorts the context's history
 * and calls this; tests call it directly to exercise defensive paths such as clock skew.
 */
export function replayTimeline(
  timeline: readonly HistoryCommit[],
  pairs: readonly ReplayPair[],
  options: ReplayOptions,
): Map<string, PairReplay> {
  const windowHours = options.windowHours ?? DEFAULT_TRACK_WINDOW_HOURS;
  const windowSeconds = windowHours * 3600;
  const plan = planTrackWindow(timeline.length, options.testFraction);
  const limited = plan.limited || options.limitedHistory === true;
  const out = new Map<string, PairReplay>();
  const stats = options.stats;

  const halfLifeSeconds =
    options.halfLifeDays !== undefined && options.halfLifeDays > 0 ? options.halfLifeDays * 86400 : undefined;
  const useOriginWeights = hasNonDefaultOriginWeights(options.originWeights);
  // Default weights resolve to all 1s, so the unweighted case is the same integer arithmetic.
  const originWeights = useOriginWeights ? resolveOriginWeights(options.originWeights) : resolveOriginWeights();
  const counter = () => new WeightCounter(halfLifeSeconds, originWeights);

  const windowStart = timeline[plan.training];
  const windowEnd = timeline[timeline.length - 1];
  const evaluated: TrackRecordEvaluated | undefined =
    !limited && windowStart && windowEnd
      ? {
          from: isoDate(windowStart.commitTime),
          to: isoDate(windowEnd.commitTime),
          commits: plan.window,
          trainingCommits: plan.training,
        }
      : undefined;

  const states: PairState[] = [];
  for (const pair of pairs) {
    const key = pairKey(pair.from, pair.to);
    if (out.has(key)) continue;
    const result: PairReplay = {
      from: pair.from,
      to: pair.to,
      plan: limited && !plan.limited ? { ...plan, window: 0, training: plan.usable, limited: true } : plan,
      ...(evaluated ? { evaluated } : {}),
      windowHours,
      episodes: [],
      triggers: 0,
      coChanged: 0,
    };
    out.set(key, result);
    if (pair.from === pair.to) continue;
    states.push({ pair, key, shared: counter(), toDeleted: false, result });
  }
  if (limited || states.length === 0) return out;

  // State only for tracked `from` files and their tracked partners.
  const fromWeight = new Map<string, WeightCounter>();
  const byFile = new Map<string, PairState[]>();
  for (const state of states) {
    if (!fromWeight.has(state.pair.from)) fromWeight.set(state.pair.from, counter());
    for (const file of [state.pair.from, state.pair.to]) {
      const list = byFile.get(file);
      if (list) {
        if (!list.includes(state)) list.push(state);
      } else byFile.set(file, [state]);
    }
  }

  let reference = Number.NEGATIVE_INFINITY;
  /**
   * Same test, on the same numbers, as `CoChangeModel.companions(from, thresholds)` for the single
   * partner `to` (a pair exists only once it has a shared commit).
   */
  const qualifies = (state: PairState): boolean => {
    const shared = state.shared;
    if (shared.count === 0) return false;
    const effectiveShared = useOriginWeights ? shared.originWeight() : shared.count;
    const confidence = confidenceRatio(shared.weight(reference), fromWeight.get(state.pair.from)!.weight(reference));
    return companionQualifies(effectiveShared, confidence, options.thresholds);
  };

  /** Adds `commit` to the per-pair state (mirrors `CoChangeModel.addCommit` for the tracked counters). */
  const addCommit = (commit: HistoryCommit, files: ReadonlySet<string>): void => {
    if (commit.commitTime > reference) reference = commit.commitTime;
    for (const [from, weight] of fromWeight) {
      if (!files.has(from)) continue;
      weight.add(commit, reference);
      if (stats) stats.stateUpdates++;
    }
    for (const file of files) {
      const touched = byFile.get(file);
      if (!touched) continue;
      for (const state of touched) {
        if (file !== state.pair.from || !files.has(state.pair.to)) continue;
        state.shared.add(commit, reference);
        if (stats) stats.stateUpdates++;
      }
    }
  };

  const touchedFiles = (commit: HistoryCommit): Set<string> | undefined => {
    let relevant = false;
    for (const file of commit.files) {
      if (byFile.has(file)) {
        relevant = true;
        break;
      }
    }
    return relevant ? new Set(commit.files) : undefined;
  };

  const updateDeletion = (commit: HistoryCommit, files: ReadonlySet<string>): void => {
    if (!commit.deleted || commit.deleted.length === 0) return;
    for (const state of states) {
      if (files.has(state.pair.to) && commit.deleted.includes(state.pair.to)) state.toDeleted = true;
    }
  };

  // Training prefix: state only.
  for (let i = 0; i < plan.training; i++) {
    const commit = timeline[i]!;
    const files = touchedFiles(commit);
    if (!files) {
      if (commit.commitTime > reference) reference = commit.commitTime;
      continue;
    }
    addCommit(commit, files);
    updateDeletion(commit, files);
  }

  const ref = (commit: HistoryCommit, position: number): ReplayCommitRef => ({
    hash: commit.hash,
    commitTime: commit.commitTime,
    position,
  });

  const close = (state: PairState): void => {
    state.result.episodes.push(state.open!);
    state.open = undefined;
  };

  // Evaluation window: evaluate with the state strictly before `c`, then add `c`.
  for (let i = plan.training; i < timeline.length; i++) {
    const commit = timeline[i]!;
    if (options.onEvaluate) {
      for (const state of states) options.onEvaluate({ position: i, key: state.key, qualifies: qualifies(state) });
    }
    const files = touchedFiles(commit);
    if (!files) {
      if (commit.commitTime > reference) reference = commit.commitTime;
      continue;
    }
    for (const state of byFileStates(files, byFile)) {
      const touchesFrom = files.has(state.pair.from);
      const touchesTo = files.has(state.pair.to);
      // 1. Resolve the open episode against this commit.
      if (state.open) {
        const delta = commit.commitTime - state.open.trigger.commitTime;
        if (delta > windowSeconds) {
          close(state);
        } else if (touchesTo) {
          if (delta < 0) {
            state.open.excluded = 'clockSkew';
          } else if (commit.deleted?.includes(state.pair.to)) {
            state.open.excluded = 'targetDeleted';
          } else {
            state.open.confirmedBy = ref(commit, i);
            state.open.hoursLater = delta / 3600;
          }
          close(state);
        }
      }
      // 2. Triggers and co-changes, judged on the state before this commit.
      if (!touchesFrom || state.toDeleted) continue;
      if (!qualifies(state)) continue;
      if (touchesTo) {
        state.result.coChanged++;
        continue;
      }
      state.result.triggers++;
      if (state.open) state.open.extraTriggers.push(ref(commit, i));
      else state.open = { trigger: ref(commit, i), extraTriggers: [] };
    }
    addCommit(commit, files);
    updateDeletion(commit, files);
  }

  // Episodes whose window is not fully observed are censored regardless of outcome, so late
  // confirmations cannot inflate the rate.
  const newest = windowEnd?.commitTime ?? Number.NEGATIVE_INFINITY;
  for (const state of states) {
    if (state.open) close(state);
    for (const episode of state.result.episodes) {
      if (episode.excluded === undefined && episode.trigger.commitTime + windowSeconds > newest) {
        episode.excluded = 'censored';
      }
    }
  }
  return out;
}

function byFileStates(files: ReadonlySet<string>, byFile: ReadonlyMap<string, PairState[]>): PairState[] {
  const seen = new Set<PairState>();
  const list: PairState[] = [];
  for (const file of files) {
    for (const state of byFile.get(file) ?? []) {
      if (seen.has(state)) continue;
      seen.add(state);
      list.push(state);
    }
  }
  return list;
}

export type TrackRecordContext = Pick<Context, 'history' | 'thresholds' | 'settings'>;

/**
 * Replays the context's usable history (the commits the `diff` baseline model trains on) for
 * each directional pair. Returns one `PairReplay` per `pairKey(from, to)`.
 */
export function replayPairs(
  ctx: TrackRecordContext,
  pairs: readonly ReplayPair[],
  opts: Omit<ReplayOptions, 'thresholds' | 'halfLifeDays' | 'originWeights'> & Partial<Pick<ReplayOptions, 'thresholds'>> = {},
): Map<string, PairReplay> {
  return replayTimeline(chronologicalTimeline(ctx.history.commits), pairs, {
    ...opts,
    thresholds: opts.thresholds ?? ctx.thresholds,
    halfLifeDays: ctx.settings.halfLifeDays,
    originWeights: ctx.settings.origin?.weights,
  });
}

export interface TrackRecordExcluded {
  censored: number;
  targetDeleted: number;
  clockSkew: number;
}

/** Track record attached to `diff` suggestions (`schemaVersion: 1`, additive). */
export type TrackRecord =
  | {
      fired: number;
      confirmed: number;
      triggers: number;
      coChanged: number;
      /** `confirmed / fired`: an observed follow-up rate (the name is shared with Gutter). */
      precision: number;
      /** 95% Wilson interval for `confirmed / fired` (descriptive: episodes are not independent). */
      interval: { low: number; high: number };
      windowHours: number;
      evaluated: TrackRecordEvaluated;
      excluded: TrackRecordExcluded;
    }
  | {
      fired: 0;
      reason: 'never_fired';
      /** Context fields: optional in the wire contract (Gutter needs only `fired` and `reason`); `toTrackRecord` always sets them. */
      triggers?: number;
      coChanged?: number;
      windowHours?: number;
      evaluated?: TrackRecordEvaluated;
      excluded?: TrackRecordExcluded;
    }
  | { reason: 'limited_history' };

const round4 = (x: number): number => Math.round(x * 10000) / 10000;

export function toTrackRecord(replay: PairReplay): TrackRecord {
  if (replay.plan.limited || !replay.evaluated) return { reason: 'limited_history' };
  const excluded: TrackRecordExcluded = { censored: 0, targetDeleted: 0, clockSkew: 0 };
  let fired = 0;
  let confirmed = 0;
  for (const episode of replay.episodes) {
    if (episode.excluded) {
      excluded[episode.excluded]++;
      continue;
    }
    fired++;
    if (episode.confirmedBy) confirmed++;
  }
  const common = {
    triggers: replay.triggers,
    coChanged: replay.coChanged,
    windowHours: replay.windowHours,
    evaluated: replay.evaluated,
    excluded,
  };
  if (fired === 0) return { fired: 0, reason: 'never_fired', ...common };
  const interval = wilsonInterval(confirmed, fired);
  return {
    fired,
    confirmed,
    triggers: replay.triggers,
    coChanged: replay.coChanged,
    precision: round4(confirmed / fired),
    interval: {
      low: Math.floor(interval.low * 10000) / 10000,
      high: Math.ceil(interval.high * 10000) / 10000,
    },
    windowHours: replay.windowHours,
    evaluated: replay.evaluated,
    excluded,
  };
}

/** Validates `--track-window` / `trackWindowHours`: an integer from 1 to 720. */
export function isValidTrackWindow(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_TRACK_WINDOW_HOURS &&
    value <= MAX_TRACK_WINDOW_HOURS
  );
}
