import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { resolveSettings, validatePartial, ConfigError, compileSkipPattern, riskySkipPattern } from '../src/config.js';
import { mergeChanges, parseNameStatus, parsePorcelainStatus, reconcileBranchLineage } from '../src/git/changes.js';
import { LogParser, MAX_TRAILERS_PER_COMMIT, readLog, type RawCommit } from '../src/git/log.js';
import { embedJson, renderMapHtml } from '../src/map/template.js';
import { CoChangeModel } from '../src/model/cochange.js';
import { processCommits, type HistoryCommit } from '../src/model/history.js';
import {
  classifyCommitOrigin,
  computeOriginShare,
  createOriginClassifier,
  DEFAULT_AGENT_AUTHOR_PATTERNS,
  DEFAULT_AGENT_TRAILER_PATTERNS,
  DEFAULT_BOT_PATTERNS,
  parseOriginWeightsSpec,
  riskyOriginPattern,
} from '../src/model/origin.js';
import { renderDiffMarkdown } from '../src/report/markdown.js';
import { describeStrength, formatIntervalCi, roundInterval, weightingLabel, type RelationshipView } from '../src/report/views.js';
import { globToRegExp, PathMatcher } from '../src/util/glob.js';
import { wilsonInterval, wilsonLowerBound, Z_95 } from '../src/util/stats.js';
import { pct, terminalText } from '../src/util/term.js';
import { backtestCommits } from '../src/commands/backtest.js';
import { FixtureRepo } from './helpers.js';

describe('terminal output', () => {
  it('escapes control and bidirectional characters without changing ordinary unicode', () => {
    assert.equal(
      terminalText('ok\n\u001b[31m café\u061c\u200f\u2028\u202e'),
      'ok\\n\\x1b[31m café\\u061c\\u200f\\u2028\\u202e',
    );
  });
});

describe('glob', () => {
  const m = (pattern: string, path: string) => globToRegExp(pattern).test(path);
  it('matches bare names at any depth, like .gitignore', () => {
    assert.ok(m('yarn.lock', 'yarn.lock'));
    assert.ok(m('yarn.lock', 'packages/a/yarn.lock'));
    assert.ok(!m('yarn.lock', 'yarn.lock.bak'));
    assert.ok(m('*.snap', 'src/__snapshots__/a.test.ts.snap'));
  });
  it('handles directories, ** and alternation', () => {
    assert.ok(m('dist/', 'dist/index.js'));
    assert.ok(m('dist/', 'packages/x/dist/a/b.js'));
    assert.ok(!m('dist/', 'src/distance.ts'));
    assert.ok(m('docs/**', 'docs/a/b.md'));
    assert.ok(!m('docs/**', 'src/docs.ts'));
    assert.ok(m('src/**/*.{js,ts}', 'src/a.ts'));
    assert.ok(m('src/**/*.{js,ts}', 'src/a/b/c.js'));
    assert.ok(!m('src/**/*.{js,ts}', 'src/a.tsx'));
    assert.ok(m('CHANGELOG*', 'CHANGELOG.md'));
  });
  it('escapes regex characters', () => {
    assert.ok(m('a+b.(x).js', 'a+b.(x).js'));
    assert.ok(!m('a+b.(x).js', 'aab.(x).js'));
    assert.ok(new PathMatcher(['', '  ']).matches('x') === false);
  });
});

describe('wilson lower bound', () => {
  it('ranks more evidence above the same rate with less evidence', () => {
    assert.ok(wilsonLowerBound(0.8, 50) > wilsonLowerBound(0.8, 5));
    assert.ok(wilsonLowerBound(1, 3) < wilsonLowerBound(0.8, 50));
    assert.equal(wilsonLowerBound(0.5, 0), 0);
  });

  it('computes two-sided wilsonInterval for known values and edge cases', () => {
    const ci14of19 = wilsonInterval(14, 19);
    assert.ok(Math.abs(ci14of19.low - 0.51208) <= 1e-4, `expected low ≈ 0.51208, got ${ci14of19.low}`);
    assert.ok(Math.abs(ci14of19.high - 0.88194) <= 1e-4, `expected high ≈ 0.88194, got ${ci14of19.high}`);

    assert.deepEqual(wilsonInterval(0, 0), { low: 0, high: 1 });
    assert.deepEqual(wilsonInterval(3, -5), { low: 0, high: 1 });

    const ci5of5 = wilsonInterval(5, 5);
    assert.equal(ci5of5.high, 1);
    assert.ok(ci5of5.low > 0.5 && ci5of5.low < 1);

    const ci0of10 = wilsonInterval(0, 10);
    assert.equal(ci0of10.low, 0);
    assert.ok(ci0of10.high > 0 && ci0of10.high < 0.5);
  });

  it('keeps wilsonInterval(k, n).low consistent with wilsonLowerBound(k/n, n) over 200 random (k, n) pairs', () => {
    let seed = 0x12345678;
    const nextRand = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };

    for (let i = 0; i < 200; i++) {
      const n = 1 + Math.floor(nextRand() * 500);
      const k = Math.floor(nextRand() * (n + 1));
      const ivDefault = wilsonInterval(k, n);
      const lbDefault = wilsonLowerBound(k / n, n);
      assert.ok(
        Math.abs(ivDefault.low - lbDefault) < 1e-12,
        `mismatch for (${k}, ${n}) at default Z_95=${Z_95}: interval.low=${ivDefault.low} vs lowerBound=${lbDefault}`,
      );
      assert.ok(ivDefault.low >= 0 && ivDefault.low <= k / n + 1e-12);
      assert.ok(ivDefault.high >= k / n - 1e-12 && ivDefault.high <= 1);
    }
  });

  it('rounds intervals outward and matches exact whole-percent bounds without double-rounding for all 0 <= k <= n <= 300', () => {
    assert.equal(formatIntervalCi(roundInterval(wilsonInterval(11, 29))), '(95% CI 22–56%)');
    for (let n = 0; n <= 300; n++) {
      for (let k = 0; k <= n; k++) {
        const raw = wilsonInterval(k, n);
        const rounded = roundInterval(raw);
        assert.ok(
          rounded.low <= raw.low && rounded.high >= raw.high,
          `rounded [${rounded.low}, ${rounded.high}] failed to contain unrounded [${raw.low}, ${raw.high}] for (${k}, ${n})`,
        );
        const ciStr = formatIntervalCi(rounded);
        const match = /^\(95% CI (\d+)–(\d+)%\)$/.exec(ciStr);
        assert.ok(match, `unexpected CI format: ${ciStr}`);
        const lowPct = Number(match[1]);
        const highPct = Number(match[2]);
        assert.equal(
          lowPct,
          Math.floor(raw.low * 100),
          `lowPct ${lowPct} != floor(raw.low * 100) for (${k}, ${n})`,
        );
        assert.equal(
          highPct,
          Math.ceil(raw.high * 100),
          `highPct ${highPct} != ceil(raw.high * 100) for (${k}, ${n})`,
        );
        assert.ok(lowPct / 100 <= raw.low && highPct / 100 >= raw.high);
        if (n > 0) {
          const displayedPct = Number(pct(k / n).slice(0, -1));
          assert.ok(
            lowPct <= displayedPct && displayedPct <= highPct,
            `displayed ${displayedPct}% fell outside [${lowPct}%, ${highPct}%] for (${k}, ${n})`,
          );
        }
      }
    }
  });

  it('places (raw 95% CI …) next to raw counts when weighted=true in describeStrength', () => {
    const baseView = {
      from: 'src/a.ts',
      to: 'src/b.ts',
      relationship: 'ghost' as const,
      why: 'no import link',
      shared: 11,
      fromChanges: 21,
      toChanges: 15,
      confidence: 1,
      reverseConfidence: 0.733,
      interval: roundInterval(wilsonInterval(11, 21)),
      reverseInterval: roundInterval(wilsonInterval(11, 15)),
      score: 0.5,
      weighted: true,
      lastTogether: '2026-05-16',
      crossesDirectories: false,
      evidence: [],
    };
    const weightedLine = describeStrength(baseView);
    assert.match(weightedLine, /^11 of 21 commits \(raw 95% CI 32–72%\) \(100% recency-weighted\) · last together /);
    assert.doesNotMatch(weightedLine, /recency-weighted\)\s*\((?:raw )?95% CI/);

    const unweightedLine = describeStrength({ ...baseView, confidence: 11 / 21, weighted: false });
    assert.match(unweightedLine, /^11 of 21 commits \(52%\) \(95% CI 32–72%\) · last together /);
  });
});

describe('git log parser', () => {
  const RS = '\u001e';
  const US = '\u001f';
  const header = (hash: string, subject: string) => `${RS}${hash}${US}Ann${US}ann@x${US}100${US}200${US}${subject}`;

  it('parses statuses, renames, odd file names and empty commits', () => {
    const commits: RawCommit[] = [];
    const parser = new LogParser((c) => commits.push(c));
    const tokens = [
      header('c3', 'sub\u001fwith separator'), '\nM', 'a b.ts', 'R087', 'old/x.ts', 'new/x.ts', 'D', 'line\nbreak.ts',
      header('c2', 'empty commit'),
      `\n${header('c1', 'first')}`, '\nA', 'ünïcödé.ts', 'C100', 'src.ts', 'copy.ts',
    ];
    for (const t of tokens) parser.push(t);
    parser.end();
    assert.equal(commits.length, 3);
    assert.equal(commits[0]!.subject, 'sub\u001fwith separator');
    assert.deepEqual(commits[0]!.changes, [
      { status: 'M', path: 'a b.ts' },
      { status: 'R', oldPath: 'old/x.ts', path: 'new/x.ts' },
      { status: 'D', path: 'line\nbreak.ts' },
    ]);
    assert.equal(commits[0]!.authorTime, 100);
    assert.equal(commits[0]!.commitTime, 200);
    assert.deepEqual(commits[1]!.changes, []);
    assert.deepEqual(commits[2]!.changes, [
      { status: 'A', path: 'ünïcödé.ts' },
      { status: 'C', oldPath: 'src.ts', path: 'copy.ts' },
    ]);
  });
});

describe('working tree parsing', () => {
  it('parses porcelain v1 -z, including renames (new path first)', () => {
    const out = ' M a.ts\0M  b.ts\0R  new name.ts\0old name.ts\0?? fresh.ts\0D  gone.ts\0';
    const files = parsePorcelainStatus(out);
    assert.deepEqual(files.map((f) => [f.path, f.oldPath, f.deleted, f.sources.join('+')]), [
      ['a.ts', undefined, false, 'unstaged'],
      ['b.ts', undefined, false, 'staged'],
      ['new name.ts', 'old name.ts', false, 'staged'],
      ['fresh.ts', undefined, false, 'untracked'],
      ['gone.ts', undefined, true, 'staged'],
    ]);
  });
  it('parses diff --name-status -z and merges lists, latest state winning', () => {
    const branch = parseNameStatus('M\0a.ts\0R100\0x.ts\0y.ts\0D\0z.ts\0');
    assert.deepEqual(branch.map((f) => [f.path, f.oldPath, f.deleted]), [
      ['a.ts', undefined, false],
      ['y.ts', 'x.ts', false],
      ['z.ts', undefined, true],
    ]);
    const merged = mergeChanges(branch, parsePorcelainStatus(' M y.ts\0?? z.ts\0'));
    const y = merged.find((f) => f.path === 'y.ts')!;
    assert.equal(y.oldPath, 'x.ts');
    assert.deepEqual(y.sources, ['branch', 'unstaged']);
    assert.equal(merged.find((f) => f.path === 'z.ts')!.deleted, false);
  });
  it('reconciles multi-step branch lineage and chains working-tree renames', () => {
    const rawCommit = (hash: string, changes: RawCommit['changes']): RawCommit => ({
      hash, authorName: 'a', authorEmail: 'a@b', authorTime: 1, commitTime: 1, subject: hash, trailers: [], changes,
    });
    // Endpoint diff saw D a.ts + A c.ts + M recreated.ts, while commit log had a->b->c and D+A on recreated.ts
    const net = parseNameStatus('D\0a.ts\0A\0c.ts\0M\0recreated.ts\0');
    const reconciled = reconcileBranchLineage(net, [
      rawCommit('c1', [{ status: 'R', oldPath: 'a.ts', path: 'b.ts' }, { status: 'D', path: 'recreated.ts' }]),
      rawCommit('c2', [{ status: 'R', oldPath: 'b.ts', path: 'c.ts' }, { status: 'A', path: 'recreated.ts' }]),
    ]);
    assert.deepEqual(reconciled, [
      { path: 'c.ts', oldPath: 'a.ts', deleted: false, added: true, sources: ['branch'] },
      { path: 'recreated.ts', deleted: false, added: true, sources: ['branch'] },
    ]);
    // Chaining a working-tree rename c.ts -> d.ts preserves oldPath='a.ts' and drops intermediate c.ts
    const chained = mergeChanges(reconciled, parsePorcelainStatus('R  d.ts\0c.ts\0'));
    assert.deepEqual(chained, [
      { path: 'recreated.ts', deleted: false, added: true, sources: ['branch'] },
      { path: 'd.ts', oldPath: 'a.ts', deleted: false, added: true, sources: ['branch', 'staged'] },
    ]);
    // Phantom paths not in HEAD (e.g. side-branch M after rename) are never emitted
    const withSideEdit = reconcileBranchLineage(
      parseNameStatus('R100\0a.ts\0r.ts\0'),
      [
        rawCommit('c1', [{ status: 'R', oldPath: 'a.ts', path: 'r.ts' }]),
        rawCommit('c2', [{ status: 'M', path: 'a.ts' }]),
      ],
      new Set(['r.ts']),
    );
    assert.deepEqual(withSideEdit, [
      { path: 'r.ts', oldPath: 'a.ts', deleted: false, added: true, sources: ['branch'] },
    ]);
  });
});

describe('co-change model', () => {
  const commit = (files: string[], day: number): HistoryCommit => ({
    hash: `h${day}`, author: 'a', time: day * 86400, commitTime: day * 86400, subject: `c${day}`, files,
  });

  it('counts single-file commits in the denominator (no inflated confidence)', () => {
    const commits: HistoryCommit[] = [];
    let day = 0;
    for (let i = 0; i < 20; i++) commits.push(commit(['session.ts'], day++));
    for (let i = 0; i < 4; i++) commits.push(commit(['session.ts', 'security.ts'], day++));
    const model = new CoChangeModel(commits);
    const session = model.id('session.ts')!;
    const [companion] = model.companions(session, { minShared: 1, minConfidence: 0 });
    assert.equal(companion!.stat.count, 4);
    assert.equal(Math.round(companion!.confidence * 1000) / 1000, Math.round((4 / 24) * 1000) / 1000);
    assert.equal(companion!.reverseConfidence, 1);
  });

  it('is directional and keeps the newest evidence', () => {
    const commits = [
      commit(['a', 'b'], 1), commit(['a', 'b'], 5), commit(['a', 'b'], 3), commit(['a', 'b'], 9),
      commit(['a'], 2), commit(['a'], 4), commit(['a'], 6), commit(['a'], 7),
    ];
    const model = new CoChangeModel(commits);
    const stat = model.pair(model.id('a')!, model.id('b')!)!;
    assert.equal(model.confidence(stat, model.id('a')!), 0.5);
    assert.equal(model.confidence(stat, model.id('b')!), 1);
    assert.deepEqual(stat.evidence.map((i) => commits[i]!.hash), ['h9', 'h5', 'h3']);
    const [strongest] = [...model.strongestPairs({ minShared: 1, minConfidence: 0 })];
    assert.equal(model.path(strongest!.from), 'b');
  });

  it('weights recent commits more with a half-life', () => {
    const commits = [commit(['a', 'b'], 0), commit(['a'], 365), commit(['a'], 365)];
    const flat = new CoChangeModel(commits);
    const decayed = new CoChangeModel(commits, { halfLifeDays: 365 });
    const conf = (m: CoChangeModel) => m.confidence(m.pair(m.id('a')!, m.id('b')!)!, m.id('a')!);
    assert.ok(Math.abs(conf(flat) - 1 / 3) < 1e-9);
    assert.ok(Math.abs(conf(decayed) - 0.5 / 2.5) < 1e-9);
  });

  it('applies thresholds', () => {
    const commits = [commit(['a', 'b'], 1), commit(['a', 'b'], 2), commit(['a', 'c'], 3)];
    const model = new CoChangeModel(commits);
    const names = (t: { minShared: number; minConfidence: number }) => model.companions(model.id('a')!, t).map((c) => model.path(c.to));
    assert.deepEqual(names({ minShared: 2, minConfidence: 0 }), ['b']);
    assert.deepEqual(names({ minShared: 1, minConfidence: 0.5 }), ['b']);
    assert.deepEqual(names({ minShared: 1, minConfidence: 0 }), ['b', 'c']);
  });

  it('produces identical companion stats when built incrementally via appendCommit and guards against half-life', () => {
    const commits = [
      commit(['a', 'b', 'c'], 1),
      commit(['a', 'b'], 2),
      commit(['b', 'c'], 3),
      commit(['a', 'd'], 4),
      commit(['a', 'b', 'd'], 5),
      commit(['b', 'c', 'd'], 6),
      commit(['a', 'c'], 7),
    ];
    const split = 3;
    const incremental = new CoChangeModel(commits.slice(0, split));
    for (const c of commits.slice(split)) {
      incremental.appendCommit(c);
    }
    const batch = new CoChangeModel(commits);
    assert.equal(incremental.fileCount, batch.fileCount);
    assert.equal(incremental.commits.length, batch.commits.length);
    for (const file of ['a', 'b', 'c', 'd']) {
      const incId = incremental.id(file)!;
      const batchId = batch.id(file)!;
      assert.equal(incremental.changeCount[incId], batch.changeCount[batchId]);
      assert.equal(incremental.changeWeight[incId], batch.changeWeight[batchId]);
      const incCompanions = incremental
        .companions(incId, { minShared: 1, minConfidence: 0 })
        .map((c) => ({
          to: incremental.path(c.to),
          count: c.stat.count,
          weight: c.stat.weight,
          lastTime: c.stat.lastTime,
          confidence: c.confidence,
          reverseConfidence: c.reverseConfidence,
          evidence: c.stat.evidence.map((idx) => incremental.commits[idx]!.hash),
        }));
      const batchCompanions = batch
        .companions(batchId, { minShared: 1, minConfidence: 0 })
        .map((c) => ({
          to: batch.path(c.to),
          count: c.stat.count,
          weight: c.stat.weight,
          lastTime: c.stat.lastTime,
          confidence: c.confidence,
          reverseConfidence: c.reverseConfidence,
          evidence: c.stat.evidence.map((idx) => batch.commits[idx]!.hash),
        }));
      assert.deepEqual(incCompanions, batchCompanions);
    }

    const weighted = new CoChangeModel(commits.slice(0, 2), { halfLifeDays: 90 });
    assert.throws(() => weighted.appendCommit(commits[2]!), /only supported for unweighted models/i);
  });
});

describe('config', () => {
  it('validates values and rejects unknown keys', () => {
    assert.throws(() => validatePartial({ minShared: 0 }, 'x'), ConfigError);
    assert.throws(() => validatePartial({ minConfidence: 2 }, 'x'), ConfigError);
    assert.throws(() => validatePartial({ minSharde: 3 }, 'x'), /unknown setting/);
    assert.throws(() => validatePartial({ skipCommits: '(' }, 'x'), /invalid regular expression/);
    assert.deepEqual(validatePartial({ ignore: ['docs/'], maxCommits: 10 }, 'x'), { ignore: ['docs/'], maxCommits: 10 });
  });
  it('layers defaults, file and flags, concatenating ignores', () => {
    const s = resolveSettings({ minShared: 5, ignore: ['a/'] }, { minShared: undefined, minConfidence: 0.6, ignore: ['b/'] });
    assert.equal(s.minShared, 5);
    assert.equal(s.minConfidence, 0.6);
    assert.deepEqual(s.ignore, ['a/', 'b/']);
    assert.equal(compileSkipPattern('^chore')!.test('Chore: x'), true);
  });
});

describe('map html', () => {
  it('cannot be broken out of by data such as commit subjects', () => {
    const json = embedJson({ s: '</script><script>alert(1)</script>', t: '\u2028<!--' });
    assert.ok(!json.includes('<'));
    assert.deepEqual(JSON.parse(json), { s: '</script><script>alert(1)</script>', t: '\u2028<!--' });
    const html = renderMapHtml({
      meta: {
        tool: 'repo-archaeology', root: '/r', commitsRead: 1, commitsAnalyzed: 1, sweepsSkipped: 0, subjectSkipped: 0, renamesFollowed: 0, files: 1,
        settings: { maxCommits: 1, maxFilesPerCommit: 1, minShared: 1, minConfidence: 0, ignore: [], useDefaultIgnores: true }, warnings: [],
      },
      repoName: '<img src=x onerror=alert(1)>',
      generatedAt: '',
      counts: { ghost: 0, unknown: 0, indirect: 0, direct: 0, test: 0 },
      classificationTruncated: false,
      nodes: [],
      edges: [],
    });
    assert.ok(!html.includes('<img'));
    assert.equal(html.match(/<\/script>/g)?.length, 2);
  });
});

describe('RA-08 commit origin: trailers, classification, originShare, weighting, and compare', () => {
  const RS = '\u001e';
  const US = '\u001f';
  const GS = '\u001d';

  it('parses trailers (including multi-line unfolded values, values with colons, cap at 20, lower-cased keys) and subjects with tabs, |, unicode, RS/US/GS', async () => {
    const out: RawCommit[] = [];
    const p = new LogParser((c) => out.push(c));

    // 25 trailers: should cap at MAX_TRAILERS_PER_COMMIT (20), lower-case keys, and preserve ':' in trailer values
    const trailerBlock = Array.from({ length: 25 }, (_, i) => {
      if (i === 0) return 'Co-Authored-By: Claude\n  <noreply@anthropic.com>';
      if (i === 1) return 'Assisted-By: agent:v2:https://ampcode.com:8080/session:123';
      return `X-Trailer-${i}: val:${i}:extra`;
    }).join(GS);
    const trickySubject = `feat(core):\thandle | pipes | café 🚀 ${RS} ${US} ${GS} end`;
    p.push(`${RS}abc1234${US}Alice${US}alice@example.com${US}100${US}200${GS}${trailerBlock}${US}${trickySubject}`);
    p.push('\nM');
    p.push('src/a.ts');
    p.end();

    assert.equal(out.length, 1);
    assert.equal(out[0]!.subject, trickySubject);
    assert.equal(out[0]!.trailers.length, MAX_TRAILERS_PER_COMMIT);
    assert.deepEqual(out[0]!.trailers[0], {
      key: 'co-authored-by',
      value: 'Claude <noreply@anthropic.com>',
    });
    assert.deepEqual(out[0]!.trailers[1], {
      key: 'assisted-by',
      value: 'agent:v2:https://ampcode.com:8080/session:123',
    });
    assert.deepEqual(out[0]!.trailers[19], {
      key: 'x-trailer-19',
      value: 'val:19:extra',
    });

    // Also verify real `git log` integration with multi-line unfolded trailers and special subject characters
    const repo = new FixtureRepo();
    try {
      repo.commit({
        author: 'Alice',
        message: [
          'feat:\tsubject with | pipe | Snowman ☃ and accents é',
          '',
          'Body paragraph.',
          '',
          'Co-authored-by: Claude',
          '  <noreply@anthropic.com>',
          'AI-Assisted: Cursor Agent',
        ].join('\n'),
        write: { 'src/a.ts': 'export const a = 1;\n' },
      });
      const logged: RawCommit[] = [];
      await readLog(repo.dir, { maxCommits: 5 }, (c) => logged.push(c));
      assert.equal(logged.length, 1);
      assert.equal(logged[0]!.subject, 'feat:\tsubject with | pipe | Snowman ☃ and accents é');
      assert.deepEqual(logged[0]!.trailers, [
        { key: 'co-authored-by', value: 'Claude <noreply@anthropic.com>' },
        { key: 'ai-assisted', value: 'Cursor Agent' },
      ]);
    } finally {
      repo.cleanup();
    }
  });

  it('classifies human, agent, and bot commits in priority order without false positives on human names/emails, and supports custom patterns + replaceDefaults', () => {
    assert.ok(DEFAULT_AGENT_AUTHOR_PATTERNS.length >= 8);
    assert.ok(DEFAULT_BOT_PATTERNS.length >= 12);
    assert.ok(DEFAULT_AGENT_TRAILER_PATTERNS.length >= 10);

    // Every built-in pattern must pass riskyOriginPattern
    for (const p of [
      ...DEFAULT_AGENT_AUTHOR_PATTERNS,
      ...DEFAULT_BOT_PATTERNS,
      ...DEFAULT_AGENT_TRAILER_PATTERNS,
    ]) {
      assert.equal(riskyOriginPattern(p), undefined, `default pattern "${p}" should be safe`);
    }

    // True positives:
    // 1. dependabot[bot] -> bot
    assert.equal(
      classifyCommitOrigin({
        authorName: 'dependabot[bot]',
        authorEmail: '49699333+dependabot[bot]@users.noreply.github.com',
        trailers: [],
      }),
      'bot',
    );
    // 2. renovate[bot] and self-hosted Renovate Bot / bot@renovateapp.com -> bot
    assert.equal(
      classifyCommitOrigin({
        authorName: 'renovate[bot]',
        authorEmail: '29139614+renovate[bot]@users.noreply.github.com',
        trailers: [],
      }),
      'bot',
    );
    assert.equal(
      classifyCommitOrigin({
        authorName: 'Renovate Bot',
        authorEmail: 'renovate@selfhosted.internal',
        trailers: [],
      }),
      'bot',
    );
    assert.equal(
      classifyCommitOrigin({
        authorName: 'Dependency Updater',
        authorEmail: 'bot@renovateapp.com',
        trailers: [],
      }),
      'bot',
    );
    // 2b. github-actions[bot] -> bot
    assert.equal(
      classifyCommitOrigin({
        authorName: 'github-actions[bot]',
        authorEmail: '41898282+github-actions[bot]@users.noreply.github.com',
        trailers: [],
      }),
      'bot',
    );
    // 3. copilot-swe-agent[bot] -> agent (agent-author step runs before bot step)
    assert.equal(
      classifyCommitOrigin({
        authorName: 'copilot-swe-agent[bot]',
        authorEmail: '198982749+copilot-swe-agent[bot]@users.noreply.github.com',
        trailers: [],
      }),
      'agent',
    );
    // Other default agent authors with [bot] suffix also classify as agent
    for (const agentName of ['devin-ai-integration[bot]', 'cursor-agent[bot]', 'codex[bot]', 'jules[bot]', 'claude[bot]', 'gemini[bot]', 'argon[bot]']) {
      assert.equal(
        classifyCommitOrigin({
          authorName: agentName,
          authorEmail: `${agentName}@users.noreply.github.com`,
          trailers: [],
        }),
        'agent',
        `expected ${agentName} to classify as agent before bot`,
      );
    }
    // 4. human with Co-authored-by: Claude <noreply@anthropic.com> trailer -> agent
    assert.equal(
      classifyCommitOrigin({
        authorName: 'Jane Developer',
        authorEmail: 'jane@example.com',
        trailers: [{ key: 'co-authored-by', value: 'Claude <noreply@anthropic.com>' }],
      }),
      'agent',
    );
    // Genuine Amp and other agent trailer attributions -> agent
    assert.equal(
      classifyCommitOrigin({
        authorName: 'Jane Developer',
        authorEmail: 'jane@example.com',
        trailers: [{ key: 'co-authored-by', value: 'Amp <amp@ampcode.com>' }],
      }),
      'agent',
    );
    for (const tool of ['Amp', 'Windsurf', 'Aider', 'Cline', 'Argon']) {
      assert.equal(
        classifyCommitOrigin({
          authorName: 'Jane Developer',
          authorEmail: 'jane@example.com',
          trailers: [{ key: 'assisted-by', value: tool }],
        }),
        'agent',
        `expected Assisted-by: ${tool} to classify as agent`,
      );
    }
    // 5. bot commit carrying an agent trailer -> bot (bot step runs before trailers)
    assert.equal(
      classifyCommitOrigin({
        authorName: 'dependabot[bot]',
        authorEmail: 'dependabot[bot]@users.noreply.github.com',
        trailers: [{ key: 'co-authored-by', value: 'Claude <noreply@anthropic.com>' }],
      }),
      'bot',
    );
    // 6. False-positive regression checks: ordinary humans whose names or emails contain
    // agent substrings ("amp" in example.com / Campbell / Ampofo, "claude" in Jean-Claude / Claude Monet,
    // "devin" in Devin Smith, "@openai.com" human employee, "Jules Verne", "Gemini Patel", "Codex Team", "Argonaut")
    // MUST classify as human!
    const humanTrailerCases = [
      'Bob <bob@example.com>',
      'Pam Campbell <pam@corp.io>',
      'Sam Ampofo <sam@corp.io>',
      'Jean-Claude Van <jc@corp.io>',
      'Devin Smith <devin.smith@corp.io>',
      'Alice <alice@openai.com>',
    ];
    for (const trailerValue of humanTrailerCases) {
      assert.equal(
        classifyCommitOrigin({
          authorName: 'Jane Developer',
          authorEmail: 'jane@example.com',
          trailers: [{ key: 'co-authored-by', value: trailerValue }],
        }),
        'human',
        `expected Co-authored-by "${trailerValue}" to classify as human`,
      );
    }
    const humanAuthorCases: Array<[string, string]> = [
      ['Claude Monet', 'claude.monet@impressionism.fr'],
      ['Jules Verne', 'jules.verne@books.fr'],
      ['Gemini Patel', 'gemini.patel@company.com'],
      ['Codex Team', 'codex-team@company.com'],
      ['Argonaut', 'argonaut@company.com'],
    ];
    for (const [authorName, authorEmail] of humanAuthorCases) {
      assert.equal(
        classifyCommitOrigin({ authorName, authorEmail, trailers: [] }),
        'human',
        `expected author "${authorName} <${authorEmail}>" to classify as human`,
      );
    }

    // 4 human-authored commits with Co-authored-by: Bob <bob@example.com> stay human and are not dropped by agent=0
    const bobRawCommits: RawCommit[] = Array.from({ length: 4 }, (_, i) => ({
      hash: `bob-${i}`,
      authorName: 'Alice',
      authorEmail: 'alice@example.com',
      authorTime: (i + 1) * 10,
      commitTime: (i + 1) * 10,
      subject: `feat: change ${i}`,
      trailers: [{ key: 'co-authored-by', value: 'Bob <bob@example.com>' }],
      changes: [{ status: 'M', path: 'a.ts' }, { status: 'M', path: 'b.ts' }],
    }));
    const bobHistory = processCommits(bobRawCommits, { maxFilesPerCommit: 25, ignore: [] });
    assert.ok(bobHistory.commits.every((c) => c.origin === 'human'));
    const bobModel = new CoChangeModel(bobHistory.commits, { originWeights: { agent: 0 } });
    assert.equal(bobModel.companions(bobModel.id('a.ts')!, { minShared: 3, minConfidence: 0.4 }).length, 1);

    // Custom patterns via config: extending defaults
    const customConfig = {
      agentAuthorPatterns: ['^acme-codegen'],
      botPatterns: ['^internal-sync-bot'],
      agentTrailerPatterns: ['AcmeCopilot'],
    };
    const extended = createOriginClassifier(customConfig);
    assert.equal(extended({ authorName: 'acme-codegen[bot]', authorEmail: '', trailers: [] }), 'agent');
    assert.equal(classifyCommitOrigin({ authorName: 'acme-codegen[bot]', authorEmail: '', trailers: [] }, customConfig), 'agent');
    assert.equal(extended({ authorName: 'internal-sync-bot', authorEmail: '', trailers: [] }), 'bot');
    assert.equal(
      extended({
        authorName: 'Jane',
        authorEmail: 'jane@example.com',
        trailers: [{ key: 'generated-by', value: 'AcmeCopilot v2' }],
      }),
      'agent',
    );
    assert.equal(extended({ authorName: 'dependabot[bot]', authorEmail: '', trailers: [] }), 'bot');

    // Custom patterns with replaceDefaults: true
    const replaced = createOriginClassifier({
      agentAuthorPatterns: ['^only-this-agent'],
      botPatterns: ['^only-this-bot'],
      agentTrailerPatterns: ['OnlyThisTrailerAgent'],
      replaceDefaults: true,
    });
    assert.equal(replaced({ authorName: 'copilot-swe-agent[bot]', authorEmail: '', trailers: [] }), 'human');
    assert.equal(replaced({ authorName: 'dependabot[bot]', authorEmail: '', trailers: [] }), 'human');
    assert.equal(
      replaced({
        authorName: 'Jane',
        authorEmail: 'jane@example.com',
        trailers: [{ key: 'co-authored-by', value: 'Claude <noreply@anthropic.com>' }],
      }),
      'human',
    );
    assert.equal(replaced({ authorName: 'only-this-agent', authorEmail: '', trailers: [] }), 'agent');
    assert.equal(replaced({ authorName: 'only-this-bot', authorEmail: '', trailers: [] }), 'bot');
    assert.equal(
      replaced({
        authorName: 'Jane',
        authorEmail: 'jane@example.com',
        trailers: [{ key: 'ai-assisted', value: 'OnlyThisTrailerAgent' }],
      }),
      'agent',
    );
  });

  it('validates origin config regexes (rejecting invalid, >200 char, and catastrophic-backtracking regexes) and weight specs', () => {
    assert.throws(
      () => validatePartial({ origin: { agentAuthorPatterns: ['(unclosed'] } }, 'cfg'),
      ConfigError,
    );
    assert.throws(
      () => validatePartial({ origin: { botPatterns: ['a'.repeat(201)] } }, 'cfg'),
      /longer than 200 characters/,
    );
    // Rejects catastrophic backtracking / backreference / excessive quantifier patterns across all 3 lists without executing them
    assert.equal(riskyOriginPattern, riskySkipPattern, 'shares a single regex safety helper');
    assert.throws(
      () => validatePartial({ origin: { agentAuthorPatterns: ['^(a+)+$'] } }, 'cfg'),
      /repeats a group that contains a quantifier or alternation/,
    );
    assert.throws(
      () => validatePartial({ origin: { botPatterns: ['(a|aa)*'] } }, 'cfg'),
      /repeats a group that contains a quantifier or alternation/,
    );
    // Rejects repeated groups containing optional `?` quantifiers across all 3 origin pattern lists
    for (const evilOptional of ['^(a?a?)+$', '^(a?)+$', '^((?:a)?)+$']) {
      for (const field of ['agentAuthorPatterns', 'botPatterns', 'agentTrailerPatterns'] as const) {
        assert.throws(
          () => validatePartial({ origin: { [field]: [evilOptional] } }, 'cfg'),
          /repeats a group that contains a quantifier or alternation/,
          `expected ${field} to reject ${evilOptional}`,
        );
        assert.throws(
          () => createOriginClassifier({ [field]: [evilOptional] }),
          /repeats a group that contains a quantifier or alternation/,
          `expected createOriginClassifier(${field}) to reject ${evilOptional}`,
        );
      }
    }
    // Bounded subprocess regression check: rejecting ^(a?a?)+$ completes immediately without hanging on 'a'.repeat(32) + '!'
    const sub = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        '--input-type=module',
        '-e',
        `import { validatePartial } from './src/config.ts';
         import { createOriginClassifier } from './src/model/origin.ts';
         for (const f of ['agentAuthorPatterns', 'botPatterns', 'agentTrailerPatterns']) {
           let threw = false;
           try { validatePartial({ origin: { [f]: ['^(a?a?)+$'] } }, 'cfg'); } catch { threw = true; }
           if (!threw) process.exit(1);
           threw = false;
           try { createOriginClassifier({ [f]: ['^(a?a?)+$'] }); } catch { threw = true; }
           if (!threw) process.exit(2);
         }`,
      ],
      { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 2000 },
    );
    assert.equal(sub.status, 0, sub.stderr);

    assert.throws(
      () => validatePartial({ origin: { agentTrailerPatterns: ['(x)\\1'] } }, 'cfg'),
      /uses a backreference/,
    );
    // Safe multi-quantifier patterns like ^a.*b.*c.*$ pass while excessive quantifier chains are rejected
    assert.equal(riskySkipPattern('^a.*b.*c.*$'), undefined);
    assert.doesNotThrow(() => validatePartial({ origin: { agentAuthorPatterns: ['^a.*b.*c.*$'] } }, 'cfg'));
    assert.throws(
      () => validatePartial({ origin: { agentAuthorPatterns: ['a+b+c+d+e+f+g+'] } }, 'cfg'),
      /too many repetition quantifiers/,
    );
    assert.throws(
      () => createOriginClassifier({ agentAuthorPatterns: ['^(a+)+$'] }),
      /repeats a group/,
    );
    assert.throws(
      () => validatePartial({ origin: { weights: { bot: 1.5 } } }, 'cfg'),
      /between 0 and 1/,
    );
    assert.throws(
      () => validatePartial({ origin: { weights: { bot: -0.1 } } }, 'cfg'),
      /between 0 and 1/,
    );
    const valid = validatePartial(
      {
        origin: {
          agentAuthorPatterns: ['^custom-agent'],
          replaceDefaults: false,
          weights: { human: 1, agent: 0.5, bot: 0 },
        },
      },
      'cfg',
    );
    assert.deepEqual(valid.origin?.weights, { human: 1, agent: 0.5, bot: 0 });
    assert.deepEqual(parseOriginWeightsSpec('bot=0,agent=0.5'), { bot: 0, agent: 0.5 });
    assert.throws(() => parseOriginWeightsSpec('unknown=0.5'), /unknown origin/);
    assert.throws(() => parseOriginWeightsSpec('bot=2'), /between 0 and 1/);
  });

  it('computes originShare over ALL shared commits (not just the 3 evidence commits) and sums to 1 with 3 decimals', () => {
    // 1/3 + 1/3 + 1/3 must sum to 1.000
    const equalThree = computeOriginShare({ human: 1, agent: 1, bot: 1 });
    assert.equal(
      Math.round((equalThree.human + equalThree.agent + equalThree.bot) * 1000),
      1000,
    );

    // Build 7 shared commits between a.ts and b.ts:
    // 3 newest commits are human (so all 3 shown in evidence[] are human),
    // while 2 older commits are agent and 2 older commits are bot.
    const rawCommits: RawCommit[] = [
      { hash: 'h7', authorName: 'Alice', authorEmail: 'a@x', authorTime: 70, commitTime: 70, subject: 'human 3', trailers: [], changes: [{ status: 'M', path: 'a.ts' }, { status: 'M', path: 'b.ts' }] },
      { hash: 'h6', authorName: 'Alice', authorEmail: 'a@x', authorTime: 60, commitTime: 60, subject: 'human 2', trailers: [], changes: [{ status: 'M', path: 'a.ts' }, { status: 'M', path: 'b.ts' }] },
      { hash: 'h5', authorName: 'Alice', authorEmail: 'a@x', authorTime: 50, commitTime: 50, subject: 'human 1', trailers: [], changes: [{ status: 'M', path: 'a.ts' }, { status: 'M', path: 'b.ts' }] },
      { hash: 'h4', authorName: 'copilot-swe-agent[bot]', authorEmail: 'c@x', authorTime: 40, commitTime: 40, subject: 'agent 2', trailers: [], changes: [{ status: 'M', path: 'a.ts' }, { status: 'M', path: 'b.ts' }] },
      { hash: 'h3', authorName: 'Alice', authorEmail: 'a@x', authorTime: 30, commitTime: 30, subject: 'agent 1', trailers: [{ key: 'co-authored-by', value: 'Claude <noreply@anthropic.com>' }], changes: [{ status: 'M', path: 'a.ts' }, { status: 'M', path: 'b.ts' }] },
      { hash: 'h2', authorName: 'dependabot[bot]', authorEmail: 'd@x', authorTime: 20, commitTime: 20, subject: 'bot 2', trailers: [], changes: [{ status: 'M', path: 'a.ts' }, { status: 'M', path: 'b.ts' }] },
      { hash: 'h1', authorName: 'renovate[bot]', authorEmail: 'r@x', authorTime: 10, commitTime: 10, subject: 'bot 1', trailers: [], changes: [{ status: 'M', path: 'a.ts' }, { status: 'M', path: 'b.ts' }] },
    ];
    const history = processCommits(rawCommits, { maxFilesPerCommit: 25, ignore: [] });
    const model = new CoChangeModel(history.commits);
    const stat = model.pair(model.id('a.ts')!, model.id('b.ts')!)!;
    assert.equal(stat.evidence.length, 3, 'evidence is capped at 3 commits');
    assert.deepEqual(
      stat.evidence.map((idx) => model.commits[idx]!.origin),
      ['human', 'human', 'human'],
    );
    assert.deepEqual(stat.originCounts, { human: 3, agent: 2, bot: 2 });
    const share = computeOriginShare(stat.originCounts);
    assert.deepEqual(share, { human: 0.428, agent: 0.286, bot: 0.286 });
    assert.equal(Math.round((share.human + share.agent + share.bot) * 1000), 1000);
  });

  it('weighting bot=0 removes bot-only co-change from confidence and thresholds while keeping raw shared and fromChanges', () => {
    const commits: HistoryCommit[] = [
      // 3 human commits touching a.ts and b.ts
      { hash: 'h1', author: 'Alice', time: 10, commitTime: 10, subject: 'h1', origin: 'human', files: ['a.ts', 'b.ts'] },
      { hash: 'h2', author: 'Alice', time: 20, commitTime: 20, subject: 'h2', origin: 'human', files: ['a.ts', 'b.ts'] },
      { hash: 'h3', author: 'Alice', time: 30, commitTime: 30, subject: 'h3', origin: 'human', files: ['a.ts', 'b.ts'] },
      // 3 human commits touching a.ts only
      { hash: 'h4', author: 'Alice', time: 40, commitTime: 40, subject: 'h4', origin: 'human', files: ['a.ts'] },
      { hash: 'h5', author: 'Alice', time: 50, commitTime: 50, subject: 'h5', origin: 'human', files: ['a.ts'] },
      { hash: 'h6', author: 'Alice', time: 60, commitTime: 60, subject: 'h6', origin: 'human', files: ['a.ts'] },
      // 3 bot commits touching a.ts, b.ts, and botOnly.ts
      { hash: 'b1', author: 'dependabot[bot]', time: 70, commitTime: 70, subject: 'b1', origin: 'bot', files: ['a.ts', 'b.ts', 'botOnly.ts'] },
      { hash: 'b2', author: 'dependabot[bot]', time: 80, commitTime: 80, subject: 'b2', origin: 'bot', files: ['a.ts', 'b.ts', 'botOnly.ts'] },
      { hash: 'b3', author: 'dependabot[bot]', time: 90, commitTime: 90, subject: 'b3', origin: 'bot', files: ['a.ts', 'b.ts', 'botOnly.ts'] },
    ];

    const defaultModel = new CoChangeModel(commits);
    const originOnlyModel = new CoChangeModel(commits, { originWeights: { bot: 0 } });
    const recencyOnlyModel = new CoChangeModel(commits, { halfLifeDays: 90 });
    const bothWeightedModel = new CoChangeModel(commits, { halfLifeDays: 90, originWeights: { bot: 0 } });

    assert.equal(defaultModel.weighted, false);
    assert.equal(defaultModel.weighting, 'none');
    assert.equal(originOnlyModel.weighted, true);
    assert.equal(originOnlyModel.weighting, 'origin');
    assert.equal(recencyOnlyModel.weighted, true);
    assert.equal(recencyOnlyModel.weighting, 'recency');
    assert.equal(bothWeightedModel.weighted, true);
    assert.equal(bothWeightedModel.weighting, 'recency+origin');

    // Verify weighting labels for only --origin-weights, only --half-life, and both
    const sampleView = (weighting?: 'recency' | 'origin' | 'recency+origin'): RelationshipView => ({
      from: 'a.ts',
      to: 'b.ts',
      relationship: 'ghost',
      why: 'changed together',
      shared: 6,
      fromChanges: 9,
      toChanges: 6,
      confidence: 0.5,
      reverseConfidence: 1,
      interval: roundInterval(wilsonInterval(6, 9)),
      reverseInterval: roundInterval(wilsonInterval(6, 6)),
      score: 0.25,
      weighted: Boolean(weighting),
      ...(weighting ? { weighting } : {}),
      lastTogether: '2025-01-01',
      crossesDirectories: false,
      originShare: { human: 0.5, agent: 0, bot: 0.5 },
      evidence: [],
    });
    assert.equal(weightingLabel(sampleView(undefined)), undefined);
    assert.equal(weightingLabel(sampleView('recency')), 'recency-weighted');
    assert.equal(weightingLabel(sampleView('origin')), 'origin-weighted');
    assert.equal(weightingLabel(sampleView('recency+origin')), 'recency+origin-weighted');
    assert.match(describeStrength(sampleView('origin')), /50% origin-weighted/);
    assert.match(describeStrength(sampleView('recency')), /50% recency-weighted/);
    assert.match(describeStrength(sampleView('recency+origin')), /50% recency\+origin-weighted/);

    const mdFor = (weighting: 'recency' | 'origin' | 'recency+origin', halfLifeDays?: number, originWeights?: { bot?: number }) =>
      renderDiffMarkdown({
        meta: {
          tool: 'repo-archaeology',
          root: '/repo',
          commitsRead: 9,
          commitsAnalyzed: 9,
          sweepsSkipped: 0,
          subjectSkipped: 0,
          renamesFollowed: 0,
          files: 2,
          settings: {
            maxCommits: 5000,
            maxFilesPerCommit: 25,
            minShared: 3,
            minConfidence: 0.4,
            ...(halfLifeDays !== undefined ? { halfLifeDays } : {}),
            ignore: [],
            useDefaultIgnores: true,
            ...(originWeights ? { origin: { weights: originWeights } } : {}),
          },
          warnings: [],
        },
        changed: [{ path: 'a.ts', deleted: false, sources: ['unstaged'], hasHistory: true }],
        suggestions: [{ ...sampleView(weighting), alsoLinkedFrom: [] }],
      });
    assert.match(mdFor('origin', undefined, { bot: 0 }), /\*\*50%\*\* origin-weighted · reverse \*\*100%\*\* origin-weighted/);
    assert.match(mdFor('recency', 90, undefined), /\*\*50%\*\* recency-weighted · reverse \*\*100%\*\* recency-weighted/);
    assert.match(mdFor('recency+origin', 90, { bot: 0 }), /\*\*50%\*\* recency\+origin-weighted · reverse \*\*100%\*\* recency\+origin-weighted/);

    const idA = originOnlyModel.id('a.ts')!;
    const idB = originOnlyModel.id('b.ts')!;
    const idBotOnly = originOnlyModel.id('botOnly.ts')!;

    // Raw shared (stat.count) and raw fromChanges (changeCount) stay raw (6 and 9)
    const statAB = originOnlyModel.pair(idA, idB)!;
    assert.equal(statAB.count, 6);
    assert.equal(originOnlyModel.changeCount[idA], 9);

    // Default confidence(a -> b) is 6/9; with bot=0 it is 3/6 = 0.5
    assert.ok(Math.abs(defaultModel.confidence(defaultModel.pair(defaultModel.id('a.ts')!, defaultModel.id('b.ts')!)!, defaultModel.id('a.ts')!) - 6 / 9) < 1e-9);
    assert.ok(Math.abs(originOnlyModel.confidence(statAB, idA) - 3 / 6) < 1e-9);

    // Bot-only pair (a.ts -> botOnly.ts) has raw shared=3, but with bot=0 its confidence is 0 and it is removed from companions
    const statABot = originOnlyModel.pair(idA, idBotOnly)!;
    assert.equal(statABot.count, 3);
    assert.equal(originOnlyModel.confidence(statABot, idA), 0);
    const companions = originOnlyModel.companions(idA, { minShared: 3, minConfidence: 0.4 });
    assert.deepEqual(companions.map((c) => originOnlyModel.path(c.to)), ['b.ts']);
    assert.equal(companions[0]!.stat.count, 6);
  });

  it('backtest --compare-origin-weights runs default and weighted on the exact same split, resolves spec on top of config weights, and reports single deltas + byOrigin', () => {
    const commits: HistoryCommit[] = [];
    let t = 1;
    // Older training history:
    // - Human commits consistently pair a.ts with b.ts (15 times)
    for (let i = 0; i < 15; i++) {
      commits.push({ hash: `train-h-${i}`, author: 'Alice', time: t, commitTime: t++, subject: 'human feature', origin: 'human', files: ['a.ts', 'b.ts'] });
    }
    // - Bot commits noisily pair a.ts with noise1.ts, noise2.ts, noise3.ts (20 times)
    for (let i = 0; i < 20; i++) {
      commits.push({ hash: `train-b-${i}`, author: 'dependabot[bot]', time: t, commitTime: t++, subject: 'bump deps', origin: 'bot', files: ['a.ts', 'noise1.ts', 'noise2.ts', 'noise3.ts'] });
    }
    // Newer held-out test window (10 commits): human changes to a.ts + b.ts
    for (let i = 0; i < 10; i++) {
      commits.push({ hash: `test-h-${i}`, author: 'Alice', time: t, commitTime: t++, subject: 'human change', origin: 'human', files: ['a.ts', 'b.ts'] });
    }
    // Newest-first order as History.commits expects
    commits.reverse();

    // Pass originWeights: { agent: 0.5 } (simulating .repo-archaeology.json origin.weights) and compareOriginWeights: 'bot=0'
    const res = backtestCommits(
      commits,
      { minShared: 3, minConfidence: 0.3 },
      { testFraction: 0.2, k: 1, originWeights: { agent: 0.5 }, compareOriginWeights: 'bot=0' },
    );
    assert.ok(res.comparisons && res.comparisons.length === 1);
    const comp = res.comparisons[0]!;
    assert.equal(comp.spec, 'bot=0');
    // Default run is always unweighted (all=1), while weighted spec inherits agent=0.5 from config and overrides bot=0
    assert.deepEqual(comp.defaultWeights, { human: 1, agent: 1, bot: 1 });
    assert.deepEqual(comp.weights, { human: 1, agent: 0.5, bot: 0 });
    // Single `deltas` field (no duplicate `delta` field)
    assert.equal('delta' in (comp as unknown as Record<string, unknown>), false);
    assert.equal('deltas' in comp, true);
    // Weighted run (bot=0) drops the noisy bot companions so top-1 recommendation on a.ts is b.ts (higher precision & hitRate)
    assert.ok(comp.weighted.precision > comp.default.precision);
    assert.ok(comp.weighted.hitRate > comp.default.hitRate);
    assert.ok(comp.default.byOrigin && comp.weighted.byOrigin);
    assert.ok(comp.weighted.byOrigin.human.hitRate > comp.default.byOrigin.human.hitRate);
    assert.ok(Math.abs(comp.deltas.precision - (comp.weighted.precision - comp.default.precision)) < 1e-9);
    assert.ok(Math.abs(comp.deltas.hitRate - (comp.weighted.hitRate - comp.default.hitRate)) < 1e-9);
    assert.ok(Math.abs(comp.deltas.lift - (comp.weighted.lift - comp.default.lift)) < 1e-9);
  });
});
