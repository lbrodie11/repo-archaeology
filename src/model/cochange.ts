import { wilsonLowerBound } from '../util/stats.js';
import type { HistoryCommit } from './history.js';
import {
  hasNonDefaultOriginWeights,
  resolveOriginWeights,
  type CommitOrigin,
  type OriginCounts,
  type OriginWeights,
} from './origin.js';

/** How many example commits to keep per relationship in standard views and JSON. */
export const EVIDENCE_LIMIT = 3;

/** Maximum shared commits retained in `allEvidence` for `--style rich` / `--full-evidence`. */
export const FULL_EVIDENCE_LIMIT = 50;

export interface PairStat {
  a: number;
  b: number;
  /** Raw number of commits that touched both files. */
  count: number;
  /** Combined recency- and origin-weighted count (equals `count` when unweighted). */
  weight: number;
  /** Origin-weighted count (equals `count` when origin weights are all 1). */
  originWeight: number;
  /** Raw counts of shared commits by origin across all shared commits. */
  originCounts: OriginCounts;
  /** Author time of the most recent shared commit. */
  lastTime: number;
  /** Indices into `model.commits`, newest first (capped at `EVIDENCE_LIMIT = 3`). */
  evidence: number[];
  /** Indices into `model.commits`, newest first (capped at `FULL_EVIDENCE_LIMIT`). */
  allEvidence?: number[];
}

export type WeightingMode = 'none' | 'recency' | 'origin' | 'recency+origin';

export interface Thresholds {
  minShared: number;
  minConfidence: number;
}

/** A file that tends to change when `from` changes. */
export interface Companion {
  from: number;
  to: number;
  stat: PairStat;
  /** P(to changes | from changes), from history. */
  confidence: number;
  /** P(from changes | to changes). */
  reverseConfidence: number;
  /** Confidence adjusted for how much evidence backs it (Wilson lower bound). */
  score: number;
}

export interface ModelOptions {
  halfLifeDays?: number;
  originWeights?: OriginWeights;
}

/*
 * Numerical policy shared by `CoChangeModel` and the RA-06 track-record replay, so that the
 * same commits and options always produce bit-identical weights and threshold decisions,
 * whatever order the commits arrive in:
 *
 * - Origin-only and unweighted: a weight is `Σ count[origin] × weight[origin]` over integer
 *   per-origin counts, in the fixed term order human, agent, bot (`combineOriginCounts`).
 * - Recency (with or without origin weights): a `DecayedSum` fed in one canonical chronological
 *   order (`compareChronological`) and rebased lazily to the newest commit time seen so far.
 * - Thresholds: `companionQualifies` is the single `minShared` / `minConfidence` test.
 */

/** Weighted count from integer per-origin counts, summed in the fixed order human, agent, bot. */
export function combineOriginCounts(counts: OriginCounts, weights: Required<OriginWeights>): number {
  return counts.human * weights.human + counts.agent * weights.agent + counts.bot * weights.bot;
}

/**
 * Canonical chronological order (oldest first): committer time, then git-log order (higher
 * `logOrder` is older), then hash. The same order `backtest --follow-ups` replays.
 */
export function compareChronological(x: HistoryCommit, y: HistoryCommit): number {
  return (
    x.commitTime - y.commitTime ||
    (x.logOrder !== undefined && y.logOrder !== undefined ? y.logOrder - x.logOrder : 0) ||
    (x.hash < y.hash ? 1 : x.hash > y.hash ? -1 : 0)
  );
}

/**
 * A recency-weighted sum `Σ w · 2^(−(R − t) / halfLife)` kept relative to the newest commit time
 * seen when it was last updated and rescaled lazily, so it can be read at any later reference
 * time `R`. Feed it in `compareChronological` order with `reference` = the running newest
 * commit time; the result then does not depend on how the caller is structured.
 */
export class DecayedSum {
  private sum = 0;
  private at = Number.NEGATIVE_INFINITY;

  constructor(private readonly halfLifeSeconds: number) {}

  private scale(delta: number): number {
    return delta <= 0 ? 1 : 0.5 ** (delta / this.halfLifeSeconds);
  }

  add(weight: number, time: number, reference: number): void {
    const base = this.at === Number.NEGATIVE_INFINITY ? 0 : this.sum * this.scale(reference - this.at);
    this.sum = base + weight * this.scale(reference - time);
    this.at = reference;
  }

  value(reference: number): number {
    return this.at === Number.NEGATIVE_INFINITY ? 0 : this.sum * this.scale(reference - this.at);
  }
}

/** `P(to | from)` from weighted counts, capped at 1 (0 when `from` has no weight). */
export function confidenceRatio(pairWeight: number, fromWeight: number): number {
  return fromWeight === 0 ? 0 : Math.min(1, pairWeight / fromWeight);
}

/** The single `minShared` / `minConfidence` test for a directional pair with at least one shared commit. */
export function companionQualifies(effectiveShared: number, confidence: number, thresholds: Thresholds): boolean {
  return effectiveShared + 1e-9 >= thresholds.minShared && confidence >= thresholds.minConfidence;
}

/**
 * Co-change statistics over a set of commits.
 *
 * For files A and B:
 *   changes(A)       commits touching A (single-file commits included, so the
 *                    denominator is honest)
 *   shared(A, B)     commits touching both
 *   confidence(A→B)  shared(A, B) / changes(A)
 *
 * Confidence is directional: if B only ever changes with A, B→A is high even when
 * A changes often on its own.
 */
export class CoChangeModel {
  readonly files: string[] = [];
  readonly changeCount: number[] = [];
  readonly changeWeight: number[] = [];
  /** Integer per-origin change counts per file (the exact basis of `changeWeight` without a half-life). */
  private readonly changeOriginCounts: OriginCounts[] = [];
  /** Sum of squared commit weights, for the effective sample size. */
  private readonly changeWeightSq: number[] = [];
  readonly lastTime: number[] = [];
  readonly authors: Map<string, number>[] = [];
  private readonly ids = new Map<string, number>();
  private readonly adjacency: Map<number, PairStat>[] = [];
  private referenceTime: number;
  private readonly halfLifeSeconds?: number;
  private readonly originWeights: Required<OriginWeights>;
  private readonly hasOriginWeights: boolean;
  private readonly commitList: HistoryCommit[];

  constructor(
    commits: readonly HistoryCommit[],
    options: ModelOptions = {},
  ) {
    this.commitList = [...commits];
    this.referenceTime = commits.reduce((max, c) => Math.max(max, c.commitTime), 0);
    if (options.halfLifeDays && options.halfLifeDays > 0) this.halfLifeSeconds = options.halfLifeDays * 86400;
    this.originWeights = resolveOriginWeights(options.originWeights);
    this.hasOriginWeights = hasNonDefaultOriginWeights(options.originWeights);
    this.commitList.forEach((commit, index) => this.addCommit(commit, index));
    if (this.halfLifeSeconds !== undefined) this.applyRecencyWeights();
  }

  /**
   * Recency weights (see the numerical policy above): one `DecayedSum` per file and per pair,
   * fed in canonical chronological order and read at the model's reference time.
   */
  private applyRecencyWeights(): void {
    const halfLife = this.halfLifeSeconds!;
    const order = this.commitList.map((_, i) => i).sort((x, y) => compareChronological(this.commitList[x]!, this.commitList[y]!) || x - y);
    const fileSums = this.files.map(() => new DecayedSum(halfLife));
    const pairSums = new Map<PairStat, DecayedSum>();
    let reference = Number.NEGATIVE_INFINITY;
    for (const index of order) {
      const commit = this.commitList[index]!;
      if (commit.commitTime > reference) reference = commit.commitTime;
      const weight = this.originWeightOf(commit);
      const ids = [...new Set(commit.files.map((f) => this.ids.get(f)!))];
      for (const id of ids) fileSums[id]!.add(weight, commit.commitTime, reference);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const stat = this.adjacency[Math.min(ids[i]!, ids[j]!)]!.get(Math.max(ids[i]!, ids[j]!))!;
          let sum = pairSums.get(stat);
          if (!sum) pairSums.set(stat, (sum = new DecayedSum(halfLife)));
          sum.add(weight, commit.commitTime, reference);
        }
      }
    }
    fileSums.forEach((sum, id) => (this.changeWeight[id] = sum.value(reference)));
    for (const [stat, sum] of pairSums) stat.weight = sum.value(reference);
  }

  get commits(): readonly HistoryCommit[] {
    return this.commitList;
  }

  /** Incrementally adds a commit to an unweighted model. */
  appendCommit(commit: HistoryCommit): void {
    if (this.halfLifeSeconds !== undefined) {
      throw new Error('appendCommit is only supported for unweighted models');
    }
    const index = this.commitList.length;
    this.commitList.push(commit);
    if (commit.commitTime > this.referenceTime) {
      this.referenceTime = commit.commitTime;
    }
    this.addCommit(commit, index);
  }

  get fileCount(): number {
    return this.files.length;
  }

  id(path: string): number | undefined {
    return this.ids.get(path);
  }

  path(id: number): string {
    return this.files[id]!;
  }

  pair(a: number, b: number): PairStat | undefined {
    return this.adjacency[a]?.get(b);
  }

  /**
   * How many commits' worth of evidence a file's history carries. Equals the raw
   * change count without a half-life; with one, old commits count for less
   * (Kish effective sample size: (Σw)² / Σw²), so 3 recent commits plus 1,000
   * nearly weightless old ones count as about 3, not 1,003.
   */
  effectiveChanges(id: number): number {
    const sumSq = this.changeWeightSq[id] ?? 0;
    const sum = this.changeWeight[id] ?? 0;
    return sumSq === 0 ? 0 : (sum * sum) / sumSq;
  }

  /** Whether confidence is recency- or origin-weighted. */
  get weighted(): boolean {
    return this.halfLifeSeconds !== undefined || this.hasOriginWeights;
  }

  /** Which weighting mode is active (`none`, `recency`, `origin`, or `recency+origin`). */
  get weighting(): WeightingMode {
    const recency = this.halfLifeSeconds !== undefined;
    const origin = this.hasOriginWeights;
    if (recency && origin) return 'recency+origin';
    if (recency) return 'recency';
    if (origin) return 'origin';
    return 'none';
  }

  /** Effective shared count used for `minShared` threshold checks. */
  effectiveShared(stat: PairStat | undefined): number {
    if (!stat) return 0;
    return this.hasOriginWeights ? stat.originWeight : stat.count;
  }

  /** Confidence that `to` changes, given that `from` changed. */
  confidence(stat: PairStat, from: number): number {
    return confidenceRatio(stat.weight, this.changeWeight[from] ?? 0);
  }

  /** Files that historically change with `from`, best first. */
  companions(from: number, thresholds: Thresholds): Companion[] {
    const result: Companion[] = [];
    const neighbours = this.adjacency[from];
    if (!neighbours) return result;
    for (const [to, stat] of neighbours) {
      const confidence = this.confidence(stat, from);
      if (!companionQualifies(this.effectiveShared(stat), confidence, thresholds)) continue;
      result.push({
        from,
        to,
        stat,
        confidence,
        reverseConfidence: this.confidence(stat, to),
        score: wilsonLowerBound(confidence, this.effectiveChanges(from)),
      });
    }
    return result.sort(compareCompanions);
  }

  /** Every relationship once (a < b), with the stronger direction as `from`. */
  *strongestPairs(thresholds: Thresholds): Generator<Companion> {
    for (let a = 0; a < this.adjacency.length; a++) {
      const neighbours = this.adjacency[a];
      if (!neighbours) continue;
      for (const [b, stat] of neighbours) {
        if (b <= a) continue;
        const shared = this.effectiveShared(stat);
        const ab = this.confidence(stat, a);
        const ba = this.confidence(stat, b);
        const passAB = companionQualifies(shared, ab, thresholds);
        const passBA = companionQualifies(shared, ba, thresholds);
        if (!passAB && !passBA) continue;
        const scoreAB = wilsonLowerBound(ab, this.effectiveChanges(a));
        const scoreBA = wilsonLowerBound(ba, this.effectiveChanges(b));
        // Report a direction that passes the thresholds; if both do, the better-evidenced one.
        const forward = passAB && (!passBA || scoreAB > scoreBA || (scoreAB === scoreBA && ab >= ba));
        yield forward
          ? { from: a, to: b, stat, confidence: ab, reverseConfidence: ba, score: scoreAB }
          : { from: b, to: a, stat, confidence: ba, reverseConfidence: ab, score: scoreBA };
      }
    }
  }

  /** Top authors of a file by number of commits. */
  topAuthors(id: number, limit = 3): { author: string; commits: number; share: number }[] {
    const authors = this.authors[id];
    if (!authors) return [];
    const total = this.changeCount[id] ?? 0;
    return [...authors.entries()]
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .slice(0, limit)
      .map(([author, commits]) => ({ author, commits, share: total === 0 ? 0 : commits / total }));
  }

  private originWeightOf(commit: HistoryCommit): number {
    if (!this.hasOriginWeights) return 1;
    const origin: CommitOrigin = commit.origin ?? 'human';
    return this.originWeights[origin];
  }

  private weightOf(commit: HistoryCommit, originWeight: number): number {
    if (!this.halfLifeSeconds) return originWeight;
    const age = Math.max(0, this.referenceTime - commit.commitTime);
    return originWeight * 0.5 ** (age / this.halfLifeSeconds);
  }

  private intern(path: string): number {
    let id = this.ids.get(path);
    if (id === undefined) {
      id = this.files.length;
      this.ids.set(path, id);
      this.files.push(path);
      this.changeCount.push(0);
      this.changeWeight.push(0);
      this.changeOriginCounts.push({ human: 0, agent: 0, bot: 0 });
      this.changeWeightSq.push(0);
      this.lastTime.push(0);
      this.authors.push(new Map());
      this.adjacency.push(new Map());
    }
    return id;
  }

  private addCommit(commit: HistoryCommit, index: number): void {
    const origin: CommitOrigin = commit.origin ?? 'human';
    const originWeight = this.originWeightOf(commit);
    const weight = this.weightOf(commit, originWeight);
    const ids = [...new Set(commit.files.map((f) => this.intern(f)))];
    for (const id of ids) {
      this.changeCount[id]!++;
      const counts = this.changeOriginCounts[id]!;
      counts[origin]++;
      // Recency weights are filled in by `applyRecencyWeights` once every commit is known.
      if (this.halfLifeSeconds === undefined) this.changeWeight[id] = combineOriginCounts(counts, this.originWeights);
      this.changeWeightSq[id]! += weight * weight;
      this.lastTime[id] = Math.max(this.lastTime[id]!, commit.time);
      const authors = this.authors[id]!;
      authors.set(commit.author, (authors.get(commit.author) ?? 0) + 1);
    }
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = Math.min(ids[i]!, ids[j]!);
        const b = Math.max(ids[i]!, ids[j]!);
        let stat = this.adjacency[a]!.get(b);
        if (!stat) {
          stat = {
            a,
            b,
            count: 0,
            weight: 0,
            originWeight: 0,
            originCounts: { human: 0, agent: 0, bot: 0 },
            lastTime: 0,
            evidence: [],
            allEvidence: [],
          };
          this.adjacency[a]!.set(b, stat);
          this.adjacency[b]!.set(a, stat);
        }
        stat.count++;
        stat.originCounts[origin]++;
        stat.originWeight = combineOriginCounts(stat.originCounts, this.originWeights);
        if (this.halfLifeSeconds === undefined) stat.weight = stat.originWeight;
        stat.lastTime = Math.max(stat.lastTime, commit.time);
        this.addEvidence(stat, index);
      }
    }
  }

  private addEvidence(stat: PairStat, index: number): void {
    // Ordered by author time: the date shown next to each commit and used for "last together".
    // Committer time breaks ties, so rebased commits keep their original order.
    const time = (i: number) => this.commits[i]!.time;
    const tie = (i: number) => this.commits[i]!.commitTime;
    const ev = stat.evidence;
    const last = ev[ev.length - 1];
    if (
      ev.length < EVIDENCE_LIMIT ||
      last === undefined ||
      time(index) > time(last) ||
      (time(index) === time(last) && tie(index) > tie(last))
    ) {
      ev.push(index);
      ev.sort((x, y) => time(y) - time(x) || tie(y) - tie(x) || x - y);
      if (ev.length > EVIDENCE_LIMIT) ev.length = EVIDENCE_LIMIT;
    }

    const allEv = (stat.allEvidence ??= []);
    const lastAll = allEv[allEv.length - 1];
    if (
      allEv.length >= FULL_EVIDENCE_LIMIT &&
      lastAll !== undefined &&
      (time(index) < time(lastAll) || (time(index) === time(lastAll) && tie(index) <= tie(lastAll)))
    ) {
      return;
    }
    allEv.push(index);
    allEv.sort((x, y) => time(y) - time(x) || tie(y) - tie(x) || x - y);
    if (allEv.length > FULL_EVIDENCE_LIMIT) allEv.length = FULL_EVIDENCE_LIMIT;
  }
}

export function compareCompanions(x: Companion, y: Companion): number {
  return y.score - x.score || y.stat.count - x.stat.count || y.stat.lastTime - x.stat.lastTime || x.to - y.to;
}
