import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { sanitizeGitEnv, validateAgainstSchema, validateSchemaNode } from '../scripts/schema-validator.mjs';
import { openRepository } from '../src/api/index.js';
import { diff } from '../src/commands/diff.js';
import { loadContext, UsageError } from '../src/context.js';
import { RELATIONSHIPS } from '../src/imports/classify.js';
import type { Context } from '../src/context.js';
import type { RawChange, RawCommit } from '../src/git/log.js';
import { CoChangeModel, type Thresholds } from '../src/model/cochange.js';
import { processCommits, type HistoryCommit } from '../src/model/history.js';
import type { CommitOrigin, OriginWeights } from '../src/model/origin.js';
import {
  chronologicalTimeline,
  pairKey,
  planTrackWindow,
  replayPairs,
  replayTimeline,
  toTrackRecord,
  type PairReplay,
  type ReplayPair,
} from '../src/model/track-record.js';
import { formatTrackRecordLine } from '../src/report/views.js';
import { FixtureRepo } from './helpers.js';

const HOUR = 3600;
const T0 = Date.UTC(2025, 0, 1) / 1000;
const DEFAULT_THRESHOLDS: Thresholds = { minShared: 3, minConfidence: 0.4 };

/** Builds a chronological (oldest first) timeline of usable commits. */
class Timeline {
  readonly commits: HistoryCommit[] = [];
  time = T0;

  add(files: string[], opts: { dt?: number; at?: number; deleted?: string[]; origin?: CommitOrigin } = {}): this {
    this.time = opts.at ?? this.time + (opts.dt ?? 1) * HOUR;
    const n = this.commits.length;
    this.commits.push({
      hash: `c${String(n).padStart(5, '0')}`,
      author: 'Dev',
      time: this.time,
      commitTime: this.time,
      subject: `commit ${n}`,
      files,
      ...(opts.deleted ? { deleted: opts.deleted } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
    });
    return this;
  }

  repeat(count: number, files: string[], dt = 1): this {
    for (let i = 0; i < count; i++) this.add(files, { dt });
    return this;
  }

  /** History as `HistoryBuilder` returns it: newest first, `logOrder` 0 = newest. */
  newestFirst(): HistoryCommit[] {
    const list = [...this.commits].reverse();
    return list.map((c, i) => ({ ...c, logOrder: i }));
  }
}

function fakeCtx(
  commits: HistoryCommit[],
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
  settings: { halfLifeDays?: number; originWeights?: OriginWeights } = {},
): Context {
  return {
    history: { commits, excluded: [], stats: { commitsRead: commits.length } },
    thresholds,
    settings: {
      halfLifeDays: settings.halfLifeDays,
      ...(settings.originWeights ? { origin: { weights: settings.originWeights } } : {}),
    },
  } as unknown as Context;
}

function replayOne(
  timeline: Timeline,
  pair: ReplayPair,
  opts: { thresholds?: Thresholds; windowHours?: number; halfLifeDays?: number; originWeights?: OriginWeights } = {},
): PairReplay {
  const result = replayPairs(
    fakeCtx(timeline.newestFirst(), opts.thresholds ?? DEFAULT_THRESHOLDS, opts),
    [pair],
    { windowHours: opts.windowHours },
  );
  return result.get(pairKey(pair.from, pair.to))!;
}

/**
 * The RA-06 core fixture (N = 100, so T = W = 50): A and B co-change 10 times, then in the
 * window 4 commits change A only, 3 of them followed within 24 h by a B-only commit.
 */
function coreFixture(): Timeline {
  const t = new Timeline();
  t.repeat(10, ['A', 'B']);
  t.repeat(40, ['C']);
  for (let k = 0; k < 4; k++) {
    t.add(['A'], { dt: 100 });
    if (k < 3) t.add(['B'], { dt: 12 + k * 5 });
    t.add(['C'], { dt: 1 });
  }
  t.repeat(39, ['C'], 100);
  assert.equal(t.commits.length, 100);
  return t;
}

const AB: ReplayPair = { from: 'A', to: 'B' };

const firedOf = (tr: ReturnType<typeof toTrackRecord>): number | undefined => ('fired' in tr ? tr.fired : undefined);

describe('RA-06 track record: replay semantics', () => {
  it('core: 4 A-only triggers, 3 followed by B within 24 h → fired 4, confirmed 3', () => {
    const replay = replayOne(coreFixture(), AB);
    const tr = toTrackRecord(replay);
    assert.ok('confirmed' in tr, 'expected: \'confirmed\' in tr');
    assert.equal(tr.fired, 4);
    assert.equal(tr.confirmed, 3);
    assert.equal(tr.triggers, 4);
    assert.equal(tr.coChanged, 0);
    assert.equal(tr.precision, 0.75);
    assert.equal(tr.windowHours, 48);
    assert.deepEqual(tr.excluded, { censored: 0, targetDeleted: 0, clockSkew: 0 });
    assert.equal(tr.evaluated.commits, 50);
    assert.equal(tr.evaluated.trainingCommits, 50);
    assert.ok(tr.interval.low <= tr.precision && tr.precision <= tr.interval.high, 'expected: tr.interval.low <= tr.precision && tr.precision <= tr.interval.high');
    assert.deepEqual(
      replay.episodes.map((e) => e.hoursLater),
      [12, 17, 22, undefined],
    );
    // Each episode records the opening trigger and the confirming commit.
    assert.equal(replay.episodes[0]!.trigger.hash, 'c00050');
    assert.equal(replay.episodes[0]!.confirmedBy?.hash, 'c00051');
  });

  it('episodes: three A-only commits within 2 h then one B commit → fired 1, confirmed 1, triggers 3', () => {
    const t = new Timeline();
    t.repeat(10, ['A', 'B']).repeat(40, ['C']);
    t.add(['A'], { dt: 100 }).add(['A'], { dt: 1 }).add(['A'], { dt: 1 }).add(['B'], { dt: 3 });
    t.repeat(46, ['C'], 100);
    const replay = replayOne(t, AB);
    const tr = toTrackRecord(replay);
    assert.ok('confirmed' in tr, 'expected: \'confirmed\' in tr');
    assert.equal(tr.fired, 1);
    assert.equal(tr.confirmed, 1);
    assert.equal(tr.triggers, 3);
    assert.equal(replay.episodes[0]!.extraTriggers.length, 2);
    assert.equal(replay.episodes[0]!.hoursLater, 5);
  });

  it('episodes: two A-only commits 60 h apart give 2 episodes', () => {
    const t = new Timeline();
    t.repeat(10, ['A', 'B']).repeat(40, ['C']);
    t.add(['A'], { dt: 100 }).add(['A'], { dt: 60 });
    t.repeat(48, ['C'], 100);
    const tr = toTrackRecord(replayOne(t, AB));
    assert.ok('confirmed' in tr, 'expected: \'confirmed\' in tr');
    assert.equal(tr.fired, 2);
    assert.equal(tr.confirmed, 0);
    assert.equal(tr.triggers, 2);
    assert.equal(tr.precision, 0);
    assert.equal(tr.interval.low, 0);
  });

  it('future-data isolation: the commit that makes the pair qualify is not a trigger', () => {
    const t = new Timeline();
    t.repeat(2, ['A', 'B']).repeat(48, ['C']);
    // Window: A-only while only 2 shared (no trigger), the 3rd co-change, then an A-only (trigger).
    t.add(['A'], { dt: 100 });
    t.add(['A', 'B'], { dt: 100 });
    t.add(['A'], { dt: 100 });
    t.repeat(47, ['C'], 100);
    const replay = replayOne(t, AB);
    assert.equal(replay.triggers, 1);
    assert.equal(replay.episodes[0]!.trigger.hash, 'c00052');
    // The qualifying co-change was judged on the state before it (2 shared): not even `coChanged`.
    assert.equal(replay.coChanged, 0);
  });

  it('co-changed counts commits in the window touching both files while the pair qualified', () => {
    const t = new Timeline();
    t.repeat(10, ['A', 'B']).repeat(40, ['C']);
    t.add(['A', 'B'], { dt: 100 }).add(['A', 'B'], { dt: 100 });
    t.repeat(48, ['C'], 100);
    const tr = toTrackRecord(replayOne(t, AB));
    assert.deepEqual(
      { fired: firedOf(tr), reason: 'reason' in tr ? tr.reason : undefined, coChanged: 'coChanged' in tr ? tr.coChanged : -1 },
      { fired: 0, reason: 'never_fired', coChanged: 2 },
    );
  });

  it('direction: A→B and B→A give different records', () => {
    const t = coreFixture();
    const result = replayPairs(fakeCtx(t.newestFirst()), [AB, { from: 'B', to: 'A' }]);
    const ab = toTrackRecord(result.get(pairKey('A', 'B'))!);
    const ba = toTrackRecord(result.get(pairKey('B', 'A'))!);
    assert.ok('confirmed' in ab && 'confirmed' in ba, 'expected: \'confirmed\' in ab && \'confirmed\' in ba');
    assert.deepEqual([ab.fired, ab.confirmed], [4, 3]);
    assert.deepEqual([ba.fired, ba.confirmed], [3, 0]);
  });

  it('stability: repeated replays are identical and state updates are bounded and exact', () => {
    const t = coreFixture();
    const stats = { stateUpdates: 0 };
    const first = replayPairs(fakeCtx(t.newestFirst()), [AB], { stats });
    // Training: 10 × (from + pair) updates; window: 4 A-only from updates. Nothing else.
    assert.equal(stats.stateUpdates, 24);
    const second = replayPairs(fakeCtx(t.newestFirst()), [AB]);
    assert.deepEqual([...first.entries()], [...second.entries()]);
    assert.deepEqual(toTrackRecord(first.get(pairKey('A', 'B'))!), toTrackRecord(second.get(pairKey('A', 'B'))!));
  });
});

describe('RA-06 track record: evaluation window', () => {
  const cases: [number, { window: number; training: number; minTraining: number; limited: boolean }][] = [
    [0, { window: 0, training: 0, minTraining: 30, limited: true }],
    [29, { window: 0, training: 29, minTraining: 30, limited: true }],
    [30, { window: 0, training: 30, minTraining: 30, limited: true }],
    [60, { window: 30, training: 30, minTraining: 30, limited: false }],
    [100, { window: 50, training: 50, minTraining: 50, limited: false }],
    [230, { window: 115, training: 115, minTraining: 115, limited: false }],
    [2000, { window: 400, training: 1600, minTraining: 1000, limited: false }],
    [20000, { window: 2000, training: 18000, minTraining: 10000, limited: false }],
  ];
  for (const [n, expected] of cases) {
    it(`N = ${n} → W = ${expected.window}${expected.limited ? ' (limited_history)' : ''}`, () => {
      assert.deepEqual(planTrackWindow(n), { usable: n, ...expected });
    });
  }

  it('replays the documented window on synthetic histories, including 20,000 commits', () => {
    for (const [n, expected] of cases) {
      const t = new Timeline();
      for (let i = 0; i < n; i++) t.add(i % 7 === 0 ? ['A', 'B'] : i % 3 === 0 ? ['A'] : ['C', `f${i % 50}`]);
      const stats = { stateUpdates: 0 };
      const replay = replayPairs(fakeCtx(t.newestFirst()), [AB], { stats }).get(pairKey('A', 'B'))!;
      const tr = toTrackRecord(replay);
      if (expected.limited) {
        assert.deepEqual(tr, { reason: 'limited_history' });
        continue;
      }
      assert.ok('evaluated' in tr, 'expected: \'evaluated\' in tr');
      assert.equal(tr.evaluated!.commits, expected.window);
      assert.equal(tr.evaluated!.trainingCommits, expected.training);
      // `evaluated` describes the actual replayed window.
      const ordered = chronologicalTimeline(t.newestFirst());
      assert.equal(tr.evaluated!.from, new Date(ordered[expected.training]!.commitTime * 1000).toISOString().slice(0, 10));
      assert.equal(tr.evaluated!.to, new Date(ordered[n - 1]!.commitTime * 1000).toISOString().slice(0, 10));
      // Bounded work: at most (from + pair) updates per commit touching the tracked files.
      assert.ok(stats.stateUpdates <= 2 * n, `${stats.stateUpdates} updates for N = ${n}`);
    }
  });

  it('limitedHistory: true (diff\'s thin/partial-baseline flag) gives limited_history', () => {
    const t = coreFixture();
    const replay = replayPairs(fakeCtx(t.newestFirst()), [AB], { limitedHistory: true }).get(pairKey('A', 'B'))!;
    assert.deepEqual(toTrackRecord(replay), { reason: 'limited_history' });
    assert.equal(formatTrackRecordLine({ to: 'B', trackRecord: toTrackRecord(replay) }), undefined);
  });
});

describe('RA-06 track record: time', () => {
  const withFollowUp = (gapSeconds: number, windowHours = 48): PairReplay => {
    const t = new Timeline();
    t.repeat(10, ['A', 'B']).repeat(40, ['C']);
    t.add(['A'], { dt: 100 });
    t.add(['B'], { at: t.time + gapSeconds });
    t.repeat(48, ['C'], 1000);
    return replayOne(t, AB, { windowHours });
  };

  it('exactly 48 h confirms; 48 h + 1 s does not', () => {
    const exact = toTrackRecord(withFollowUp(48 * HOUR));
    const late = toTrackRecord(withFollowUp(48 * HOUR + 1));
    assert.ok('confirmed' in exact && 'confirmed' in late, 'expected: \'confirmed\' in exact && \'confirmed\' in late');
    assert.deepEqual([exact.fired, exact.confirmed], [1, 1]);
    assert.deepEqual([late.fired, late.confirmed], [1, 0]);
  });

  it('--track-window 1 and 720 bound the window in hours', () => {
    const one = toTrackRecord(withFollowUp(HOUR, 1));
    const oneLate = toTrackRecord(withFollowUp(HOUR + 1, 1));
    const month = toTrackRecord(withFollowUp(720 * HOUR, 720));
    assert.ok('confirmed' in one && 'confirmed' in oneLate && 'confirmed' in month, 'expected: \'confirmed\' in one && \'confirmed\' in oneLate && \'confirmed\' in month');
    assert.equal(one.confirmed, 1);
    assert.equal(oneLate.confirmed, 0);
    assert.equal(month.confirmed, 1);
    assert.equal(month.windowHours, 720);
  });

  it('equal timestamps confirm only when the B commit is later in replay order', () => {
    const later = toTrackRecord(withFollowUp(0));
    assert.ok('confirmed' in later, 'expected: \'confirmed\' in later');
    assert.deepEqual([later.fired, later.confirmed], [1, 1]);

    // Same second, but B is earlier in git-log order (higher logOrder = older): B sorts first.
    const t = new Timeline();
    t.repeat(10, ['A', 'B']).repeat(40, ['C']);
    t.add(['A'], { dt: 100 });
    t.add(['B'], { at: t.time });
    t.repeat(48, ['C'], 1000);
    const history = t.newestFirst();
    const a = history.find((c) => c.hash === 'c00050')!;
    const b = history.find((c) => c.hash === 'c00051')!;
    [a.logOrder, b.logOrder] = [b.logOrder!, a.logOrder!];
    const replay = replayPairs(fakeCtx(history), [AB]).get(pairKey('A', 'B'))!;
    const tr = toTrackRecord(replay);
    assert.ok('confirmed' in tr, 'expected: \'confirmed\' in tr');
    assert.deepEqual([tr.fired, tr.confirmed], [1, 0]);
  });

  it('a negative time delta never confirms and is counted as clockSkew', () => {
    // replayPairs orders by committer time, so a negative delta can only reach the replay from an
    // externally ordered timeline; the guard still holds.
    const t = new Timeline();
    t.repeat(10, ['A', 'B']).repeat(40, ['C']);
    t.add(['A'], { dt: 100 });
    t.add(['B'], { at: t.time - 600 });
    t.repeat(48, ['C'], 1000);
    const replay = replayTimeline(t.commits, [AB], { thresholds: DEFAULT_THRESHOLDS }).get(pairKey('A', 'B'))!;
    const tr = toTrackRecord(replay);
    assert.deepEqual(
      { fired: firedOf(tr), excluded: 'excluded' in tr ? tr.excluded : undefined },
      { fired: 0, excluded: { censored: 0, targetDeleted: 0, clockSkew: 1 } },
    );
  });

  it('censoring: an episode inside the final window is excluded regardless of outcome', () => {
    const t = new Timeline();
    t.repeat(10, ['A', 'B']).repeat(40, ['C']);
    t.repeat(46, ['C'], 100);
    t.add(['A'], { dt: 100 }).add(['A'], { dt: 100 }).add(['B'], { dt: 2 }).add(['C'], { dt: 10 });
    const replay = replayOne(t, AB);
    const tr = toTrackRecord(replay);
    assert.ok('confirmed' in tr, 'expected: \'confirmed\' in tr');
    assert.equal(tr.fired, 1);
    assert.equal(tr.confirmed, 0);
    // The second episode was confirmed after 2 h, but its 48 h window runs past the newest commit.
    assert.equal(tr.excluded.censored, 1);
    assert.equal(replay.episodes[1]!.confirmedBy?.hash, 'c00098');
  });
});

describe('RA-06 track record: weighted equivalence with a fresh CoChangeModel', () => {
  const origins: CommitOrigin[] = ['human', 'agent', 'bot', 'human', 'human', 'agent'];
  const buildTimeline = (): Timeline => {
    const t = new Timeline();
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 90; i++) {
      const r = rand();
      const files = r < 0.3 ? ['A', 'B'] : r < 0.55 ? ['A'] : r < 0.7 ? ['B', 'C'] : r < 0.8 ? ['A', 'C'] : ['C'];
      t.add(files, { dt: 1 + Math.floor(rand() * 200), origin: origins[i % origins.length] });
    }
    return t;
  };
  const modes: [string, { halfLifeDays?: number; originWeights?: OriginWeights }][] = [
    ['unweighted', {}],
    ['halfLifeDays', { halfLifeDays: 3 }],
    ['originWeights', { originWeights: { bot: 0, agent: 0.5 } }],
    ['both', { halfLifeDays: 3, originWeights: { bot: 0, agent: 0.5 } }],
  ];
  const thresholds: Thresholds = { minShared: 3, minConfidence: 0.5 };

  for (const [label, settings] of modes) {
    it(`${label}: qualification at every replay step equals the prefix-built model`, () => {
      const t = buildTimeline();
      const history = t.newestFirst();
      const ordered = chronologicalTimeline(history);
      const pairs: ReplayPair[] = [AB, { from: 'B', to: 'A' }, { from: 'A', to: 'C' }];
      const seen: { position: number; key: string; qualifies: boolean }[] = [];
      replayTimeline(ordered, pairs, {
        thresholds,
        halfLifeDays: settings.halfLifeDays,
        originWeights: settings.originWeights,
        onEvaluate: (event) => seen.push(event),
      });
      const plan = planTrackWindow(ordered.length);
      assert.equal(seen.length, plan.window * pairs.length);
      let flips = 0;
      const last = new Map<string, boolean>();
      for (const event of seen) {
        // Reference: a fresh model over the exact prefix (newest first, as HistoryBuilder returns it).
        const prefix = ordered.slice(0, event.position).reverse();
        const model = new CoChangeModel(prefix, settings);
        const [from, to] = JSON.parse(event.key) as [string, string];
        const fromId = model.id(from);
        const toId = model.id(to);
        const expected =
          fromId !== undefined && toId !== undefined && model.companions(fromId, thresholds).some((c) => c.to === toId);
        assert.equal(event.qualifies, expected, `${label}: ${event.key} at position ${event.position}`);
        if (last.has(event.key) && last.get(event.key) !== expected) flips++;
        last.set(event.key, expected);
      }
      // The fixture must exercise both outcomes, or the comparison proves little.
      assert.ok(seen.some((e) => e.qualifies) && seen.some((e) => !e.qualifies), `${label}: both outcomes occur`);
      assert.ok(flips > 0 || label === 'unweighted', `${label}: qualification changes during the replay`);
    });
  }
});

/** Raw commits fed newest first, as git log returns them. */
class RawLog {
  private readonly oldestFirst: RawCommit[] = [];
  private time = T0;

  add(changes: (string | RawChange)[], opts: { dt?: number; subject?: string } = {}): this {
    this.time += (opts.dt ?? 1) * HOUR;
    const n = this.oldestFirst.length;
    this.oldestFirst.push({
      hash: `r${String(n).padStart(5, '0')}`,
      authorName: 'Dev',
      authorEmail: 'dev@example.com',
      authorTime: this.time,
      commitTime: this.time,
      subject: opts.subject ?? `commit ${n}`,
      trailers: [],
      changes: changes.map((c) => (typeof c === 'string' ? { status: 'M', path: c } : c)),
    });
    return this;
  }

  repeat(count: number, changes: string[], dt = 1): this {
    for (let i = 0; i < count; i++) this.add(changes, { dt });
    return this;
  }

  get length(): number {
    return this.oldestFirst.length;
  }

  ctx(options: { maxFilesPerCommit?: number; skipReverts?: boolean; thresholds?: Thresholds } = {}): Context {
    const history = processCommits([...this.oldestFirst].reverse(), {
      maxFilesPerCommit: options.maxFilesPerCommit ?? 25,
      ignore: [],
      skipReverts: options.skipReverts,
    });
    return {
      history,
      thresholds: options.thresholds ?? DEFAULT_THRESHOLDS,
      settings: {},
    } as unknown as Context;
  }
}

function record(ctx: Context, from: string, to: string) {
  return toTrackRecord(replayPairs(ctx, [{ from, to }]).get(pairKey(from, to))!);
}

/** 10 A+B co-changes, then fillers up to 50 training commits; returns the log for window commits. */
function rawBase(): RawLog {
  const log = new RawLog();
  log.add([{ status: 'A', path: 'A' }, { status: 'A', path: 'B' }, { status: 'A', path: 'C' }]);
  log.repeat(9, ['A', 'B']).repeat(40, ['C']);
  return log;
}

function padTo(log: RawLog, n: number): RawLog {
  while (log.length < n) log.add(['C'], { dt: 100 });
  return log;
}

describe('RA-06 track record: filters and file lifetimes', () => {
  it('a sweep commit touching B neither triggers nor confirms', () => {
    const log = rawBase();
    const sweep = Array.from({ length: 30 }, (_, i) => `s${i}`);
    log.add(['A'], { dt: 100 });
    log.add(['B', ...sweep], { dt: 2 });
    log.add(['A', ...sweep], { dt: 100 });
    // Sweeps are not usable commits, so pad by usable ones.
    while (log.ctx().history.commits.length < 100) log.add(['C'], { dt: 100 });
    const tr = record(log.ctx(), 'A', 'B');
    assert.ok('confirmed' in tr, 'expected: \'confirmed\' in tr');
    assert.deepEqual([tr.fired, tr.confirmed, tr.triggers], [1, 0, 1]);
  });

  it('minShared / minConfidence changes alter fired predictably', () => {
    const log = rawBase();
    for (let k = 0; k < 4; k++) log.add(['A'], { dt: 100 });
    padTo(log, 100);
    const base = record(log.ctx(), 'A', 'B');
    assert.equal(firedOf(base), 4);
    // 10 shared commits never reach minShared 11.
    const strictShared = record(log.ctx({ thresholds: { minShared: 11, minConfidence: 0.4 } }), 'A', 'B');
    assert.deepEqual([firedOf(strictShared), 'reason' in strictShared && strictShared.reason], [0, 'never_fired']);
    // Before the k-th A-only commit (k = 0..3) confidence is 10 / (10 + k): 1, 0.909, 0.833, 0.769.
    const strictConfidence = record(log.ctx({ thresholds: { minShared: 3, minConfidence: 0.9 } }), 'A', 'B');
    assert.equal(firedOf(strictConfidence), 2);
    const looser = record(log.ctx({ thresholds: { minShared: 3, minConfidence: 0.75 } }), 'A', 'B');
    assert.equal(firedOf(looser), 4); // 10/13 = 0.769 ≥ 0.75 for the 4th trigger
  });

  it('a revert commit counts only when the revert policy keeps it', () => {
    const log = rawBase();
    log.add(['A'], { dt: 100 });
    log.add(['B'], { dt: 3, subject: 'Revert "tweak B"' });
    padTo(log, 100);
    const skipped = record(log.ctx(), 'A', 'B');
    const kept = record(log.ctx({ skipReverts: false }), 'A', 'B');
    assert.ok('confirmed' in skipped && 'confirmed' in kept, 'expected: \'confirmed\' in skipped && \'confirmed\' in kept');
    assert.equal(skipped.confirmed, 0);
    assert.equal(kept.confirmed, 1);
  });

  it('from renamed mid-window keeps its identity (triggers before and after the rename count)', () => {
    const log = rawBase();
    log.add(['A'], { dt: 100 });
    log.add(['B'], { dt: 5 });
    log.add([{ status: 'R', oldPath: 'A', path: 'A2' }], { dt: 100 });
    log.add(['A2'], { dt: 100 });
    log.add(['B'], { dt: 5 });
    padTo(log, 100);
    const ctx = log.ctx();
    assert.equal(ctx.history.commits.some((c) => c.files.includes('A')), false, 'A history is under A2');
    const tr = record(ctx, 'A2', 'B');
    assert.ok('confirmed' in tr, 'expected: \'confirmed\' in tr');
    // The rename commit itself is an A2-only change while the pair qualifies: a trigger, unconfirmed.
    assert.deepEqual([tr.fired, tr.confirmed], [3, 2]);
  });

  it('to renamed within the window: the rename is a change to the same file', () => {
    const log = rawBase();
    log.add(['A'], { dt: 100 });
    log.add([{ status: 'R', oldPath: 'B', path: 'B2' }], { dt: 4 });
    padTo(log, 100);
    const tr = record(log.ctx(), 'A', 'B2');
    assert.ok('confirmed' in tr, 'expected: \'confirmed\' in tr');
    assert.deepEqual([tr.fired, tr.confirmed], [1, 1]);
  });

  it('to deleted within the window is targetDeleted, not a confirmation; no triggers after', () => {
    const log = rawBase();
    log.add(['A'], { dt: 100 });
    log.add([{ status: 'D', path: 'B' }], { dt: 4 });
    log.add(['A'], { dt: 100 });
    padTo(log, 100);
    const ctx = log.ctx();
    // Deleted and never re-created, so the identity keeps its plain path.
    const tr = record(ctx, 'A', 'B');
    assert.deepEqual(
      { fired: firedOf(tr), excluded: 'excluded' in tr ? tr.excluded : undefined, triggers: 'triggers' in tr ? tr.triggers : -1 },
      { fired: 0, excluded: { censored: 0, targetDeleted: 1, clockSkew: 0 }, triggers: 1 },
    );
  });

  it('to replaced at the old path: the earlier lifetime\'s history does not count for the new file', () => {
    const log = rawBase();
    log.add([{ status: 'D', path: 'B' }], { dt: 100 });
    log.add([{ status: 'A', path: 'B' }], { dt: 100 });
    for (let k = 0; k < 3; k++) log.add(['A'], { dt: 100 });
    padTo(log, 100);
    const ctx = log.ctx();
    const live = record(ctx, 'A', 'B');
    assert.deepEqual([firedOf(live), 'triggers' in live ? live.triggers : -1], [0, 0]);
    // The earlier lifetime is a separate identity; its episodes stop when it was deleted.
    const oldIdentity = ctx.history.commits.find((c) => c.files.some((f) => f.startsWith('B\u0000')))!.files.find((f) => f.startsWith('B\u0000'))!;
    const old = record(ctx, 'A', oldIdentity);
    assert.deepEqual([firedOf(old), 'triggers' in old ? old.triggers : -1], [0, 0]);
  });
});

/** The adjacent float64 above (`dir = 1`) or below (`dir = -1`) a positive finite `x`. */
function nextFloat(x: number, dir: 1 | -1): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  view.setBigUint64(0, view.getBigUint64(0) + BigInt(dir));
  return view.getFloat64(0);
}

/**
 * Reference replay: qualification from a CoChangeModel freshly built on each exact prefix, and
 * the documented episode rules written out plainly (no shared state with the implementation).
 */
function referenceCounts(
  ordered: readonly HistoryCommit[],
  pair: ReplayPair,
  thresholds: Thresholds,
  settings: { halfLifeDays?: number; originWeights?: OriginWeights },
  windowHours = 48,
): { fired: number; confirmed: number; triggers: number; qualifies: boolean[] } {
  const plan = planTrackWindow(ordered.length);
  const windowSeconds = windowHours * HOUR;
  const newest = ordered[ordered.length - 1]!.commitTime;
  const qualifies: boolean[] = [];
  const episodes: { start: number; confirmed: boolean; censored: boolean }[] = [];
  let open: { start: number; confirmed: boolean; censored: boolean } | undefined;
  let triggers = 0;
  for (let i = plan.training; i < ordered.length; i++) {
    const c = ordered[i]!;
    const model = new CoChangeModel(ordered.slice(0, i).reverse(), settings);
    const fromId = model.id(pair.from);
    const toId = model.id(pair.to);
    const q = fromId !== undefined && toId !== undefined && model.companions(fromId, thresholds).some((x) => x.to === toId);
    qualifies.push(q);
    const touchesFrom = c.files.includes(pair.from);
    const touchesTo = c.files.includes(pair.to);
    if (open && (touchesFrom || touchesTo)) {
      if (c.commitTime - open.start > windowSeconds) {
        episodes.push(open);
        open = undefined;
      } else if (touchesTo) {
        open.confirmed = true;
        episodes.push(open);
        open = undefined;
      }
    }
    if (touchesFrom && !touchesTo && q) {
      triggers++;
      if (!open) open = { start: c.commitTime, confirmed: false, censored: false };
    }
  }
  if (open) episodes.push(open);
  const counted = episodes.filter((e) => e.start + windowSeconds <= newest);
  return { fired: counted.length, confirmed: counted.filter((e) => e.confirmed).length, triggers, qualifies };
}

function assertMatchesReference(
  t: Timeline,
  pair: ReplayPair,
  thresholds: Thresholds,
  settings: { halfLifeDays?: number; originWeights?: OriginWeights },
  label: string,
): void {
  const ordered = chronologicalTimeline(t.newestFirst());
  const seen: boolean[] = [];
  const key = pairKey(pair.from, pair.to);
  const replay = replayTimeline(ordered, [pair], {
    thresholds,
    ...settings,
    onEvaluate: (e) => {
      if (e.key === key) seen.push(e.qualifies);
    },
  }).get(key)!;
  const expected = referenceCounts(ordered, pair, thresholds, settings);
  assert.deepEqual(seen, expected.qualifies, `${label}: qualification at every step`);
  const tr = toTrackRecord(replay);
  assert.deepEqual(
    { fired: firedOf(tr), confirmed: 'confirmed' in tr ? tr.confirmed : 0, triggers: 'triggers' in tr ? tr.triggers : -1 },
    { fired: expected.fired, confirmed: expected.confirmed, triggers: expected.triggers },
    `${label}: fired/confirmed/triggers`,
  );
}

describe('RA-06 track record: numerical boundaries (shared weight policy with CoChangeModel)', () => {
  it('review fixture: 1.2 / 1.5 at minConfidence 0.8 with origin weights 1/0.1/0.3 agrees with the model', () => {
    const t = new Timeline();
    t.add(['A', 'B'], { origin: 'human' }).add(['A', 'B'], { origin: 'agent' }).add(['A', 'B'], { origin: 'agent' });
    t.add(['A'], { origin: 'bot' });
    while (t.commits.length < 50) t.add(['C']);
    t.add(['A']).add(['B']);
    for (let i = 0; i < 10; i++) t.add(['A', 'B']);
    while (t.commits.length < 100) t.add(['C']);
    const thresholds = { minShared: 1, minConfidence: 0.8 };
    const settings = { originWeights: { human: 1, agent: 0.1, bot: 0.3 } };
    const prefix = new CoChangeModel(chronologicalTimeline(t.newestFirst()).slice(0, 50).reverse(), settings);
    const a = prefix.id('A')!;
    const b = prefix.id('B')!;
    const reference = prefix.companions(a, thresholds).some((c) => c.to === b);
    const replay = replayOne(t, AB, { thresholds, ...settings });
    assert.equal(replay.triggers > 0, reference, 'the replay triggers exactly when the prefix model qualifies');
    assertMatchesReference(t, AB, thresholds, settings, 'review fixture');
    // Fed in any order, the model holds the same weights (no order-dependent accumulation).
    const shuffled = new CoChangeModel(chronologicalTimeline(t.newestFirst()).slice(0, 50), settings);
    assert.equal(shuffled.confidence(shuffled.pair(shuffled.id('A')!, shuffled.id('B')!)!, shuffled.id('A')!), prefix.confidence(prefix.pair(a, b)!, a));
  });

  it('recency: the epoch clock rescales without changing decisions, matches the closed form, and ignores input order', () => {
    // Half-life of 0.002 days (~173 s) over hourly commits: the epoch moves every ~24 hours.
    const halfLifeDays = 0.002;
    const settings = { halfLifeDays, originWeights: { human: 1, agent: 0.1, bot: 0.3 } };
    const t = new Timeline();
    let state = 5;
    const rand = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
    const origins: CommitOrigin[] = ['human', 'agent', 'bot'];
    for (let i = 0; i < 90; i++) {
      const r = rand();
      t.add(r < 0.4 ? ['A', 'B'] : r < 0.7 ? ['A'] : ['B'], { dt: 1 + Math.floor(rand() * 30), origin: origins[i % 3] });
    }
    const ordered = chronologicalTimeline(t.newestFirst());
    assert.ok(
      (ordered[ordered.length - 1]!.commitTime - ordered[0]!.commitTime) / (halfLifeDays * 86400) > 512 * 3,
      'the fixture spans several epoch moves',
    );
    for (const minConfidence of [0.3, 0.5, 0.7]) {
      assertMatchesReference(t, AB, { minShared: 1, minConfidence }, settings, `tiny half-life ${minConfidence}`);
      assertMatchesReference(t, { from: 'B', to: 'A' }, { minShared: 1, minConfidence }, settings, `tiny half-life B→A ${minConfidence}`);
    }

    // Closed form with a moderate half-life: Σ w · 2^(−(R − t) / h), within float tolerance.
    const moderate = { halfLifeDays: 3, originWeights: { human: 1, agent: 0.1, bot: 0.3 } };
    const model = new CoChangeModel(t.newestFirst(), moderate);
    const R = ordered[ordered.length - 1]!.commitTime;
    const weightOf = (c: HistoryCommit) => moderate.originWeights[c.origin ?? 'human'] * 0.5 ** ((R - c.commitTime) / (3 * 86400));
    const expectA = ordered.filter((c) => c.files.includes('A')).reduce((sum, c) => sum + weightOf(c), 0);
    const expectAB = ordered.filter((c) => c.files.includes('A') && c.files.includes('B')).reduce((sum, c) => sum + weightOf(c), 0);
    const a = model.id('A')!;
    const b = model.id('B')!;
    assert.ok(Math.abs(model.changeWeight[a]! - expectA) <= 1e-12 * expectA, `changeWeight ${model.changeWeight[a]} vs ${expectA}`);
    assert.ok(Math.abs(model.pair(a, b)!.weight - expectAB) <= 1e-12 * expectAB, `pair weight ${model.pair(a, b)!.weight} vs ${expectAB}`);

    // Bit-identical weights whatever order the commits are handed to the model in.
    const reversed = new CoChangeModel([...t.newestFirst()].reverse(), moderate);
    const a2 = reversed.id('A')!;
    assert.equal(reversed.changeWeight[a2], model.changeWeight[a]);
    assert.equal(reversed.pair(a2, reversed.id('B')!)!.weight, model.pair(a, b)!.weight);
  });

  const weightSets: [string, OriginWeights][] = [
    ['1/0.1/0.3', { human: 1, agent: 0.1, bot: 0.3 }],
    ['0.7/0.3/0.1', { human: 0.7, agent: 0.3, bot: 0.1 }],
  ];
  const modes: [string, (w: OriginWeights) => { halfLifeDays?: number; originWeights?: OriginWeights }][] = [
    ['origin-only', (w) => ({ originWeights: w })],
    ['recency+origin', (w) => ({ halfLifeDays: 2.5, originWeights: w })],
    ['recency-only', () => ({ halfLifeDays: 1.7 })],
  ];
  const origins: CommitOrigin[] = ['human', 'agent', 'bot', 'agent', 'human', 'bot', 'agent'];
  const randomTimeline = (seed: number): Timeline => {
    let state = seed;
    const rand = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
    const t = new Timeline();
    for (let i = 0; i < 80; i++) {
      const r = rand();
      const files = r < 0.35 ? ['A', 'B'] : r < 0.6 ? ['A'] : r < 0.75 ? ['B'] : ['C'];
      t.add(files, { dt: 1 + Math.floor(rand() * 40), origin: origins[Math.floor(rand() * origins.length)] });
    }
    return t;
  };

  for (const [weightLabel, weights] of weightSets) {
    for (const [modeLabel, settingsFor] of modes) {
      it(`${modeLabel} ${weightLabel}: exact, just-below and just-above thresholds match a fresh prefix model`, () => {
        const settings = settingsFor(weights);
        for (const seed of [3, 11, 29]) {
          const t = randomTimeline(seed);
          const ordered = chronologicalTimeline(t.newestFirst());
          const plan = planTrackWindow(ordered.length);
          // Thresholds at confidences the prefix model actually produces during the window.
          const observed = new Set<number>();
          for (let i = plan.training; i < ordered.length; i += 7) {
            const model = new CoChangeModel(ordered.slice(0, i).reverse(), settings);
            const a = model.id('A');
            const b = model.id('B');
            const stat = a !== undefined && b !== undefined ? model.pair(a, b) : undefined;
            if (stat && a !== undefined) observed.add(model.confidence(stat, a));
          }
          const values = [...observed].filter((v) => v > 0 && v < 1).slice(0, 3);
          assert.ok(values.length > 0, `${modeLabel} seed ${seed}: the fixture produces fractional confidences`);
          for (const v of values) {
            for (const minConfidence of [v, nextFloat(v, -1), nextFloat(v, 1)]) {
              for (const minShared of [1, 2.2]) {
                assertMatchesReference(t, AB, { minShared, minConfidence }, settings, `${modeLabel} ${weightLabel} seed ${seed} minShared ${minShared} minConfidence ${minConfidence}`);
                assertMatchesReference(t, { from: 'B', to: 'A' }, { minShared, minConfidence }, settings, `${modeLabel} ${weightLabel} B→A seed ${seed}`);
              }
            }
          }
        }
      });
    }
  }
});

describe('RA-06 track record: wording', () => {
  it('renders every schema-valid never_fired shape without throwing, inventing counts, or printing "undefined"', () => {
    const evaluated = { from: '2026-01-01', to: '2026-02-01', commits: 400, trainingCommits: 1600 };
    const excludedNone = { censored: 0, targetDeleted: 0, clockSkew: 0 };
    const cases: [string, Record<string, unknown>, string | undefined][] = [
      ['minimal { fired: 0, reason }', {}, undefined],
      ['evaluated only', { evaluated }, 'No completed earlier triggers in the last 400 commits.'],
      ['excluded only', { excluded: { ...excludedNone, censored: 2 } }, undefined],
      ['triggers only', { triggers: 0 }, undefined],
      ['evaluated + triggers 0', { evaluated, triggers: 0 }, 'No earlier triggers in the last 400 commits.'],
      ['evaluated + triggers > 0, no excluded', { evaluated, triggers: 3 }, 'No completed earlier triggers in the last 400 commits.'],
      ['evaluated + excluded, no triggers', { evaluated, excluded: { ...excludedNone, censored: 2 } }, 'No completed earlier triggers in the last 400 commits.'],
      ['windowHours + coChanged only', { windowHours: 48, coChanged: 3 }, undefined],
    ];
    for (const [label, extra, expected] of cases) {
      const trackRecord = { fired: 0, reason: 'never_fired', ...extra } as ReturnType<typeof toTrackRecord>;
      const errors: string[] = [];
      validateSchemaNode(SCHEMA_DIR, trackRecord, { $ref: 'common.schema.json#/$defs/TrackRecord' }, 'common.schema.json', '$', errors);
      assert.deepEqual(errors, [], `${label} is a valid wire shape`);
      let line: ReturnType<typeof formatTrackRecordLine>;
      assert.doesNotThrow(() => (line = formatTrackRecordLine({ to: 'src/x.ts', trackRecord })), label);
      assert.equal(line?.text, expected, label);
      if (line) assert.doesNotMatch(line.text, /undefined|NaN/, label);
    }
  });

  it('zero triggers and positive triggers with every episode excluded are worded differently', () => {
    const base = { fired: 0 as const, reason: 'never_fired' as const, coChanged: 0, windowHours: 48, evaluated: { from: '2026-01-01', to: '2026-02-01', commits: 400, trainingCommits: 1600 } };
    const none = formatTrackRecordLine({ to: 'x.ts', trackRecord: { ...base, triggers: 0, excluded: { censored: 0, targetDeleted: 0, clockSkew: 0 } } });
    const allExcluded = formatTrackRecordLine({ to: 'x.ts', trackRecord: { ...base, triggers: 2, excluded: { censored: 1, targetDeleted: 1, clockSkew: 0 } } });
    assert.equal(none?.text, 'No earlier triggers in the last 400 commits.');
    assert.equal(allExcluded?.text, 'No completed earlier triggers in the last 400 commits (2 too recent or left out).');
    // And from a real replay: an episode inside the final window is censored.
    const t = new Timeline();
    t.repeat(10, ['A', 'B']).repeat(40, ['C']).repeat(49, ['C'], 100);
    t.add(['A'], { dt: 100 });
    const tr = toTrackRecord(replayOne(t, AB));
    assert.equal(formatTrackRecordLine({ to: 'B', trackRecord: tr })?.text, 'No completed earlier triggers in the last 50 commits (1 too recent or left out).');
  });

  it('counts first, small-sample caveat, never-fired line, no accuracy framing', () => {
    const tr = toTrackRecord(replayOne(coreFixture(), AB));
    const line = formatTrackRecordLine({ to: 'src/auth/permissions.ts', trackRecord: tr })!;
    assert.equal(
      line.text,
      'Before: 4 times this changed without permissions.ts; it changed within 48 h after 3 (small sample; not proof those were fixes).',
    );
    assert.equal(line.dim, false);
    const five = formatTrackRecordLine({
      to: 'permissions.ts',
      trackRecord: { ...(tr as Extract<typeof tr, { confirmed: number }>), fired: 5, confirmed: 4 },
    })!;
    assert.equal(
      five.text,
      'Before: 5 times this changed without permissions.ts; it changed within 48 h after 4 (not proof those were fixes).',
    );
    const never = formatTrackRecordLine({
      to: 'x.ts',
      trackRecord: {
        fired: 0,
        reason: 'never_fired',
        triggers: 0,
        coChanged: 0,
        windowHours: 48,
        evaluated: { from: '2026-01-01', to: '2026-02-01', commits: 500, trainingCommits: 1500 },
        excluded: { censored: 0, targetDeleted: 0, clockSkew: 0 },
      },
    })!;
    assert.deepEqual(never, { text: 'No earlier triggers in the last 500 commits.', dim: true });
    for (const text of [line.text, five.text, never.text]) assert.doesNotMatch(text, /accura|correct|chance|%/i);
  });
});

// ---------------------------------------------------------------------------------------------
// End-to-end: CLI renderers, JSON, API, bare command, flags, isolation.
// ---------------------------------------------------------------------------------------------

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');
const SCHEMA_DIR = join(import.meta.dirname, '..', 'schema');
const HANDLER = 'src/handler.ts';
const PERMISSIONS = 'src/permissions.ts';
const OTHER = 'src/other.ts';
const LINKED = 'src/linked.ts';

function runCli(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, ['--import', TSX, CLI, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    env: sanitizeGitEnv(process.env, { NO_COLOR: '1', REPO_ARCHAEOLOGY_CACHE_DIR: '' }),
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * 100 daily commits (T = W = 50). Training: handler+permissions co-change 10 times (incl. the
 * initial commit), linked+permissions 5 times. Window: 4 handler-only commits, the first 3
 * followed one day later by a permissions-only commit.
 */
function buildRepo(): FixtureRepo {
  const repo = new FixtureRepo();
  for (const f of [HANDLER, PERMISSIONS, OTHER, LINKED]) repo.write(f, `// ${f}\n`);
  repo.git('add', '.');
  repo.commit({ message: 'initial' });
  for (let i = 0; i < 9; i++) repo.touch([HANDLER, PERMISSIONS]);
  for (let i = 0; i < 5; i++) repo.touch([LINKED, PERMISSIONS]);
  for (let i = 0; i < 35; i++) repo.touch([OTHER]);
  for (let k = 0; k < 4; k++) {
    repo.touch([HANDLER]);
    if (k < 3) repo.touch([PERMISSIONS]);
    repo.touch([OTHER]);
  }
  for (let i = 0; i < 39; i++) repo.touch([OTHER]);
  assert.equal(Number(repo.git('rev-list', '--count', 'HEAD').trim()), 100);
  return repo;
}

type Json = Record<string, any>;

function permissionsSuggestion(payload: Json): Json {
  const s = (payload.suggestions as Json[]).find((x) => x.to === PERMISSIONS);
  assert.ok(s, `expected a ${PERMISSIONS} suggestion`);
  return s;
}

function assertInvariants(tr: Json): void {
  if (!('fired' in tr)) return;
  if (tr.reason === 'never_fired') return;
  assert.ok(0 <= tr.confirmed && tr.confirmed <= tr.fired && tr.fired <= tr.triggers, 'expected 0 <= confirmed <= fired <= triggers');
  assert.ok(
    0 <= tr.interval.low && tr.interval.low <= tr.precision && tr.precision <= tr.interval.high && tr.interval.high <= 1,
    'expected 0 <= low <= precision <= high <= 1',
  );
}

describe('RA-06 track record: end-to-end contract', () => {
  let repo: FixtureRepo;
  let originalPermissions: string;

  before(() => {
    repo = buildRepo();
    originalPermissions = readFileSync(join(repo.dir, PERMISSIONS), 'utf8');
  });
  after(() => repo.cleanup());

  const editHandler = () => writeFileSync(join(repo.dir, HANDLER), 'export const handler = 1; // edited\n');
  const reset = () => {
    repo.git('checkout', '-q', '--', '.');
    repo.git('clean', '-qfd');
  };

  it('classic, rich, Markdown, --json, --json-out, the API and the bare command report identical numbers', async () => {
    editHandler();
    try {
      const json = runCli(['diff', '--json'], repo.dir);
      assert.equal(json.code, 0, json.stderr);
      const payload = JSON.parse(json.stdout) as Json;
      validateAgainstSchema(SCHEMA_DIR, payload, 'diff.schema.json');
      const s = permissionsSuggestion(payload);
      assert.equal(s.from, HANDLER);
      const tr = s.trackRecord as Json;
      assert.deepEqual(
        { fired: tr.fired, confirmed: tr.confirmed, triggers: tr.triggers, coChanged: tr.coChanged, precision: tr.precision, windowHours: tr.windowHours },
        { fired: 4, confirmed: 3, triggers: 4, coChanged: 0, precision: 0.75, windowHours: 48 },
      );
      assert.deepEqual(tr.excluded, { censored: 0, targetDeleted: 0, clockSkew: 0 });
      assert.equal(tr.evaluated.commits, 50);
      assert.equal(tr.evaluated.trainingCommits, 50);
      assertInvariants(tr);
      for (const other of payload.suggestions as Json[]) {
        if (other.trackRecord) assertInvariants(other.trackRecord);
      }

      const outFile = join(repo.dir, '..', `${basename(repo.dir)}-track.json`);
      const classic = runCli(['diff', '--json-out', outFile], repo.dir);
      const rich = runCli(['--style', 'rich', 'diff'], repo.dir);
      const markdown = runCli(['diff', '--format', 'markdown'], repo.dir);
      const bare = runCli(['--json'], repo.dir);
      for (const r of [classic, rich, markdown, bare]) assert.equal(r.code, 0, r.stderr);
      const fromFile = JSON.parse(readFileSync(outFile, 'utf8')) as Json;
      rmSync(outFile, { force: true });
      assert.deepEqual(permissionsSuggestion(fromFile).trackRecord, tr);
      const bareJson = JSON.parse(bare.stdout) as Json;
      assert.equal(bareJson.mode, 'diff');
      validateAgainstSchema(SCHEMA_DIR, bareJson, 'default.schema.json');
      assert.deepEqual(permissionsSuggestion(bareJson).trackRecord, tr);

      const api = await openRepository({ cwd: repo.dir });
      try {
        const viaApi = (await api.diff()) as unknown as Json;
        assert.deepEqual(stripVolatile(viaApi), stripVolatile(payload));
      } finally {
        await api.close();
      }

      const expectedLine =
        'Before: 4 times this changed without permissions.ts; it changed within 48 h after 3 (small sample; not proof those were fixes).';
      assert.ok(classic.stdout.includes(expectedLine), `classic output lacks the track-record line:\n${classic.stdout}`);
      // Rich (@frame12/terminal, RA-21) wraps prose to the terminal width inside the finding's card:
      // join the wrapped lines (dropping the card gutter) before looking for the same sentence.
      const richProse = rich.stdout
        .split('\n')
        .map((line) => line.replace(/^[┃|]? +/, '').trim())
        .join(' ');
      assert.ok(richProse.includes(expectedLine), `rich output lacks the track-record line:\n${rich.stdout}`);
      assert.ok(
        markdown.stdout.includes(
          'Before: 4 times this changed without `permissions.ts`; it changed within 48 h after 3 (small sample; not proof those were fixes).',
        ),
        `Markdown output lacks the track-record line:\n${markdown.stdout}`,
      );
      // Never framed as accuracy, correctness or chance in any renderer.
      for (const [label, text] of [['classic', classic.stdout], ['rich', rich.stdout], ['markdown', markdown.stdout]] as const) {
        assert.doesNotMatch(text, /accura|correct|chance/i, `${label} output uses accuracy-type wording`);
      }
    } finally {
      reset();
    }
  });

  it('--no-track-record omits the field; suggestion order and exit codes are unchanged', () => {
    editHandler();
    try {
      const withRecord = runCli(['diff', '--json', '--exit-code'], repo.dir);
      const without = runCli(['diff', '--json', '--exit-code', '--no-track-record'], repo.dir);
      assert.equal(withRecord.code, 1);
      assert.equal(without.code, 1);
      const a = JSON.parse(withRecord.stdout) as Json;
      const b = JSON.parse(without.stdout) as Json;
      validateAgainstSchema(SCHEMA_DIR, b, 'diff.schema.json');
      for (const s of b.suggestions as Json[]) assert.equal('trackRecord' in s, false);
      const stripped = (a.suggestions as Json[]).map(({ trackRecord: _tr, ...rest }) => rest);
      assert.deepEqual(stripped, b.suggestions);
      const text = runCli(['diff', '--no-track-record'], repo.dir);
      assert.doesNotMatch(text.stdout, /Before: |No earlier triggers/);
    } finally {
      reset();
    }
  });

  it('--track-window accepts whole hours 1..720 and exits 2 otherwise', () => {
    editHandler();
    try {
      for (const ok of ['1', '720']) {
        const r = runCli(['diff', '--json', '--track-window', ok], repo.dir);
        assert.equal(r.code, 0, r.stderr);
        assert.equal(permissionsSuggestion(JSON.parse(r.stdout) as Json).trackRecord.windowHours, Number(ok));
      }
      // Daily commits: nothing follows within 1 h.
      const oneHour = permissionsSuggestion(JSON.parse(runCli(['diff', '--json', '--track-window', '1'], repo.dir).stdout) as Json);
      assert.equal(oneHour.trackRecord.confirmed, 0);
      for (const bad of ['0', '721', 'abc', '1.5', '-3']) {
        const r = runCli(['diff', '--track-window', bad], repo.dir);
        assert.equal(r.code, 2, `--track-window ${bad}: ${r.stderr}`);
        assert.match(r.stderr, /--track-window must be a whole number of hours from 1 to 720/);
      }
    } finally {
      reset();
    }
  });

  it('API: trackRecord: false and trackWindowHours follow the same rules', async () => {
    editHandler();
    const api = await openRepository({ cwd: repo.dir });
    try {
      const off = (await api.diff({ trackRecord: false })) as unknown as Json;
      for (const s of off.suggestions as Json[]) assert.equal('trackRecord' in s, false);
      const week = (await api.diff({ trackWindowHours: 168 })) as unknown as Json;
      assert.equal(permissionsSuggestion(week).trackRecord.windowHours, 168);
      for (const bad of [0, 721, 1.5, Number.NaN]) {
        await assert.rejects(() => api.diff({ trackWindowHours: bad }), UsageError);
      }
    } finally {
      await api.close();
      reset();
    }
  });

  it('never calls replayPairs with trackRecord: false; replays only each suggestion\'s primary pair', async () => {
    writeFileSync(join(repo.dir, HANDLER), 'export const handler = 2;\n');
    writeFileSync(join(repo.dir, LINKED), 'export const linked = 2;\n');
    try {
      const ctx = await loadContext(repo.dir, {}, { silent: true });
      const calls: ReplayPair[][] = [];
      const spy: typeof replayPairs = (c, pairs, opts) => {
        calls.push([...pairs]);
        return replayPairs(c, pairs, opts);
      };
      const off = await diff(ctx, { limit: 10, kinds: [...RELATIONSHIPS], trackRecord: false, replayPairs: spy });
      assert.equal(calls.length, 0);
      assert.ok(off.suggestions.length > 0, 'expected suggestions');
      assert.ok(off.suggestions.every((s) => s.trackRecord === undefined), 'expected no trackRecord');

      const on = await diff(ctx, { limit: 10, kinds: [...RELATIONSHIPS], replayPairs: spy });
      assert.equal(calls.length, 1);
      const s = on.suggestions.find((x) => x.to === PERMISSIONS)!;
      assert.equal(s.alsoLinkedFrom.length, 1, 'both changed files link to permissions.ts');
      assert.deepEqual(
        calls[0],
        on.suggestions.map((x) => ({ from: x.from, to: x.to })),
        'one primary pair per suggestion, alsoLinkedFrom sources not replayed',
      );
      assert.ok(!calls[0]!.some((p) => p.from === s.alsoLinkedFrom[0] && p.to === PERMISSIONS), 'secondary source not replayed');
      assert.deepEqual(
        off.suggestions.map((x) => [x.from, x.to]),
        on.suggestions.map((x) => [x.from, x.to]),
        'order unchanged',
      );
    } finally {
      reset();
    }
  });

  it('a dirty working tree does not affect the record', () => {
    editHandler();
    try {
      const clean = permissionsSuggestion(JSON.parse(runCli(['diff', '--json'], repo.dir).stdout) as Json).trackRecord;
      writeFileSync(join(repo.dir, OTHER), 'export const other = -1;\n');
      writeFileSync(join(repo.dir, 'src/untracked.ts'), 'export const u = 1;\n');
      const dirty = permissionsSuggestion(JSON.parse(runCli(['diff', '--json'], repo.dir).stdout) as Json).trackRecord;
      assert.deepEqual(dirty, clean);
    } finally {
      reset();
    }
  });

  it('with --base main, feature-branch commits (including later permissions changes) never enter the replay', () => {
    editHandler();
    const onMain = permissionsSuggestion(JSON.parse(runCli(['diff', '--json'], repo.dir).stdout) as Json).trackRecord;
    reset();
    repo.git('checkout', '-q', '-b', 'feature');
    try {
      repo.touch([HANDLER], 'feature: handler');
      repo.touch([PERMISSIONS], 'feature: permissions');
      repo.commit({ message: 'feature: restore permissions', write: { [PERMISSIONS]: originalPermissions } });
      const r = runCli(['diff', '--base', 'main', '--json'], repo.dir);
      assert.equal(r.code, 0, r.stderr);
      const payload = JSON.parse(r.stdout) as Json;
      assert.deepEqual(payload.changed.map((c: Json) => c.path), [HANDLER]);
      assert.equal(payload.evaluation.baselineSha, repo.git('rev-parse', 'main').trim());
      // If the branch leaked, its handler commit would add a trigger confirmed a day later.
      assert.deepEqual(permissionsSuggestion(payload).trackRecord, onMain);
    } finally {
      repo.git('checkout', '-q', 'main');
      repo.git('branch', '-q', '-D', 'feature');
    }
  });

  it('with --head <old>, nothing newer than <old> is used', () => {
    repo.git('checkout', '-q', '-b', 'head-test');
    try {
      repo.touch([HANDLER], 'old: handler');
      const old = repo.git('rev-parse', 'HEAD').trim();
      const args = ['diff', '--base', `${old}~1`, '--head', old, '--json'];
      const before = JSON.parse(runCli(args, repo.dir).stdout) as Json;
      const tr = permissionsSuggestion(before).trackRecord;
      assert.equal(tr.fired, 4);
      repo.touch([PERMISSIONS], 'new: permissions');
      repo.touch([HANDLER], 'new: handler');
      repo.touch([PERMISSIONS], 'new: permissions again');
      const later = JSON.parse(runCli(args, repo.dir).stdout) as Json;
      assert.deepEqual(later.suggestions, before.suggestions);
      assert.deepEqual(later.evaluation, before.evaluation);
    } finally {
      repo.git('checkout', '-q', 'main');
      repo.git('branch', '-q', '-D', 'head-test');
    }
  });

  it('thin history (< 50 usable commits) gives limited_history and prints no line', () => {
    const small = new FixtureRepo();
    try {
      small.write(HANDLER, 'a\n');
      small.write(PERMISSIONS, 'b\n');
      small.git('add', '.');
      small.commit({ message: 'init' });
      for (let i = 0; i < 6; i++) small.touch([HANDLER, PERMISSIONS]);
      writeFileSync(join(small.dir, HANDLER), 'edited\n');
      const payload = JSON.parse(runCli(['diff', '--json'], small.dir).stdout) as Json;
      assert.deepEqual(permissionsSuggestion(payload).trackRecord, { reason: 'limited_history' });
      validateAgainstSchema(SCHEMA_DIR, payload, 'diff.schema.json');
      const text = runCli(['diff'], small.dir).stdout;
      assert.doesNotMatch(text, /Before: |No earlier triggers/);
    } finally {
      small.cleanup();
    }
  });
});

function stripVolatile(payload: Json): Json {
  const clone = structuredClone(payload);
  delete clone.meta?.cache;
  return clone;
}
