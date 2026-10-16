import { wilsonLowerBound } from '../util/stats.js';
import type { HistoryCommit } from './history.js';

/** How many example commits to keep per relationship. */
export const EVIDENCE_LIMIT = 3;

export interface PairStat {
  a: number;
  b: number;
  /** Raw number of commits that touched both files. */
  count: number;
  /** Recency-weighted count (equals `count` when no half-life is set). */
  weight: number;
  /** Author time of the most recent shared commit. */
  lastTime: number;
  /** Indices into `model.commits`, newest first. */
  evidence: number[];
}

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
  /** Sum of squared commit weights, for the effective sample size. */
  private readonly changeWeightSq: number[] = [];
  readonly lastTime: number[] = [];
  readonly authors: Map<string, number>[] = [];
  private readonly ids = new Map<string, number>();
  private readonly adjacency: Map<number, PairStat>[] = [];
  private readonly referenceTime: number;
  private readonly halfLifeSeconds?: number;

  constructor(
    readonly commits: readonly HistoryCommit[],
    options: ModelOptions = {},
  ) {
    this.referenceTime = commits.reduce((max, c) => Math.max(max, c.commitTime), 0);
    if (options.halfLifeDays && options.halfLifeDays > 0) this.halfLifeSeconds = options.halfLifeDays * 86400;
    commits.forEach((commit, index) => this.addCommit(commit, index));
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

  /** Whether confidence is recency-weighted (a half-life is set). */
  get weighted(): boolean {
    return this.halfLifeSeconds !== undefined;
  }

  /** Confidence that `to` changes, given that `from` changed. */
  confidence(stat: PairStat, from: number): number {
    const denominator = this.changeWeight[from] ?? 0;
    return denominator === 0 ? 0 : Math.min(1, stat.weight / denominator);
  }

  /** Files that historically change with `from`, best first. */
  companions(from: number, thresholds: Thresholds): Companion[] {
    const result: Companion[] = [];
    const neighbours = this.adjacency[from];
    if (!neighbours) return result;
    for (const [to, stat] of neighbours) {
      if (stat.count < thresholds.minShared) continue;
      const confidence = this.confidence(stat, from);
      if (confidence < thresholds.minConfidence) continue;
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
        if (b <= a || stat.count < thresholds.minShared) continue;
        const ab = this.confidence(stat, a);
        const ba = this.confidence(stat, b);
        const passAB = ab >= thresholds.minConfidence;
        const passBA = ba >= thresholds.minConfidence;
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

  private weightOf(commit: HistoryCommit): number {
    if (!this.halfLifeSeconds) return 1;
    const age = Math.max(0, this.referenceTime - commit.commitTime);
    return 0.5 ** (age / this.halfLifeSeconds);
  }

  private intern(path: string): number {
    let id = this.ids.get(path);
    if (id === undefined) {
      id = this.files.length;
      this.ids.set(path, id);
      this.files.push(path);
      this.changeCount.push(0);
      this.changeWeight.push(0);
      this.changeWeightSq.push(0);
      this.lastTime.push(0);
      this.authors.push(new Map());
      this.adjacency.push(new Map());
    }
    return id;
  }

  private addCommit(commit: HistoryCommit, index: number): void {
    const weight = this.weightOf(commit);
    const ids = [...new Set(commit.files.map((f) => this.intern(f)))];
    for (const id of ids) {
      this.changeCount[id]!++;
      this.changeWeight[id]! += weight;
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
          stat = { a, b, count: 0, weight: 0, lastTime: 0, evidence: [] };
          this.adjacency[a]!.set(b, stat);
          this.adjacency[b]!.set(a, stat);
        }
        stat.count++;
        stat.weight += weight;
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
    if (ev.length >= EVIDENCE_LIMIT && last !== undefined && (time(index) < time(last) || (time(index) === time(last) && tie(index) <= tie(last)))) return;
    ev.push(index);
    ev.sort((x, y) => time(y) - time(x) || tie(y) - tie(x) || x - y);
    if (ev.length > EVIDENCE_LIMIT) ev.length = EVIDENCE_LIMIT;
  }
}

export function compareCompanions(x: Companion, y: Companion): number {
  return y.score - x.score || y.stat.count - x.stat.count || y.stat.lastTime - x.stat.lastTime || x.to - y.to;
}
