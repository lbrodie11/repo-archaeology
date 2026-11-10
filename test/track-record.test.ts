import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
      { fired: tr.fired, reason: 'reason' in tr ? tr.reason : undefined, coChanged: 'coChanged' in tr ? tr.coChanged : -1 },
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
      assert.equal(tr.evaluated.commits, expected.window);
      assert.equal(tr.evaluated.trainingCommits, expected.training);
      // `evaluated` describes the actual replayed window.
      const ordered = chronologicalTimeline(t.newestFirst());
      assert.equal(tr.evaluated.from, new Date(ordered[expected.training]!.commitTime * 1000).toISOString().slice(0, 10));
      assert.equal(tr.evaluated.to, new Date(ordered[n - 1]!.commitTime * 1000).toISOString().slice(0, 10));
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
      { fired: tr.fired, excluded: 'excluded' in tr ? tr.excluded : undefined },
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
    assert.equal(base.fired, 4);
    // 10 shared commits never reach minShared 11.
    const strictShared = record(log.ctx({ thresholds: { minShared: 11, minConfidence: 0.4 } }), 'A', 'B');
    assert.deepEqual([strictShared.fired, 'reason' in strictShared && strictShared.reason], [0, 'never_fired']);
    // Before the k-th A-only commit (k = 0..3) confidence is 10 / (10 + k): 1, 0.909, 0.833, 0.769.
    const strictConfidence = record(log.ctx({ thresholds: { minShared: 3, minConfidence: 0.9 } }), 'A', 'B');
    assert.equal(strictConfidence.fired, 2);
    const looser = record(log.ctx({ thresholds: { minShared: 3, minConfidence: 0.75 } }), 'A', 'B');
    assert.equal(looser.fired, 4); // 10/13 = 0.769 ≥ 0.75 for the 4th trigger
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
      { fired: tr.fired, excluded: 'excluded' in tr ? tr.excluded : undefined, triggers: 'triggers' in tr ? tr.triggers : -1 },
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
    assert.deepEqual([live.fired, 'triggers' in live ? live.triggers : -1], [0, 0]);
    // The earlier lifetime is a separate identity; its episodes stop when it was deleted.
    const oldIdentity = ctx.history.commits.find((c) => c.files.some((f) => f.startsWith('B\u0000')))!.files.find((f) => f.startsWith('B\u0000'))!;
    const old = record(ctx, 'A', oldIdentity);
    assert.deepEqual([old.fired, 'triggers' in old ? old.triggers : -1], [0, 0]);
  });
});

describe('RA-06 track record: wording', () => {
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
