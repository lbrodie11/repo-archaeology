import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveSettings, validatePartial, ConfigError, compileSkipPattern } from '../src/config.js';
import { mergeChanges, parseNameStatus, parsePorcelainStatus } from '../src/git/changes.js';
import { LogParser, type RawCommit } from '../src/git/log.js';
import { embedJson, renderMapHtml } from '../src/map/template.js';
import { CoChangeModel } from '../src/model/cochange.js';
import type { HistoryCommit } from '../src/model/history.js';
import { globToRegExp, PathMatcher } from '../src/util/glob.js';
import { wilsonLowerBound } from '../src/util/stats.js';
import { terminalText } from '../src/util/term.js';

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
      counts: { ghost: 0, unknown: 0, direct: 0, test: 0 },
      classificationTruncated: false,
      nodes: [],
      edges: [],
    });
    assert.ok(!html.includes('<img'));
    assert.equal(html.match(/<\/script>/g)?.length, 2);
  });
});
