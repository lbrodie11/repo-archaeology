/**
 * Regression tests for the second external code review (two reviewers, October 2026).
 * Each test reproduces the reported failure.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { suggestMissing } from '../src/commands/diff.js';
import { buildMapData } from '../src/commands/map.js';
import { ConfigError, DEFAULT_IGNORES, loadConfigFile, riskySkipPattern } from '../src/config.js';
import { loadContext } from '../src/context.js';
import { workingTreeChanges } from '../src/git/changes.js';
import { RelationshipClassifier, workingTreeFiles } from '../src/imports/classify.js';
import { ImportResolver, type RepoFiles } from '../src/imports/resolve.js';
import { countNonLiteralLoads } from '../src/imports/typescript.js';
import { renderMapHtml } from '../src/map/template.js';
import { CoChangeModel } from '../src/model/cochange.js';
import { loadHistory, type HistoryCommit } from '../src/model/history.js';
import { timeAgo } from '../src/util/term.js';
import { FixtureRepo } from './helpers.js';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((fn) => fn()));

function fixture(): FixtureRepo {
  const r = new FixtureRepo();
  cleanups.push(() => r.cleanup());
  return r;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repo-archaeology-review2-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function memoryRepo(files: Record<string, string | undefined>): RepoFiles {
  return { exists: (p) => p in files, read: (p) => files[p], list: () => Object.keys(files) };
}

/** Symlinks need extra privileges on Windows; skip rather than fail there. */
function trySymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path);
    return true;
  } catch {
    return false;
  }
}

describe('review 2, must fix: hangs', () => {
  it('does not read a symlinked source file (e.g. to /dev/zero) or a file outside the repository', (t) => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, 'secret.ts'), 'export const SECRET_TOKEN = 1;');
    writeFileSync(join(root, 'ok.ts'), 'export {};');
    const linked = process.platform !== 'win32' && trySymlink('/dev/zero', join(root, 'evil.ts'));
    const escaped = trySymlink(join(outside, 'secret.ts'), join(root, 'leak.ts'));
    if (!linked && !escaped) return t.skip('symlinks unavailable');
    const files = workingTreeFiles(root, new Set(['ok.ts', 'evil.ts', 'leak.ts']));
    const started = Date.now();
    if (linked) assert.equal(files.read('evil.ts'), undefined);
    if (escaped) assert.equal(files.read('leak.ts'), undefined);
    assert.equal(files.read('ok.ts'), 'export {};');
    assert.ok(Date.now() - started < 2000);
  });

  it('refuses risky settings from the repository config file but accepts ordinary ones', () => {
    const root = tempDir();
    const write = (config: unknown) => writeFileSync(join(root, '.repo-archaeology.json'), JSON.stringify(config));
    write({ skipCommits: '^(a+)+$' });
    assert.throws(() => loadConfigFile(root), ConfigError);
    write({ skipCommits: '(a|aa)*b' });
    assert.throws(() => loadConfigFile(root), ConfigError);
    write({ skipCommits: '(x)\\1' });
    assert.throws(() => loadConfigFile(root), ConfigError);
    write({ maxFilesPerCommit: 1_000_000 });
    assert.throws(() => loadConfigFile(root), /at most 1000/);
    write({ skipCommits: '^(chore|style)\\b', maxFilesPerCommit: 50 });
    assert.deepEqual(loadConfigFile(root), { skipCommits: '^(chore|style)\\b', maxFilesPerCommit: 50 });
    assert.equal(riskySkipPattern('^chore\\(deps\\)'), undefined);
    assert.equal(riskySkipPattern('^[(+)]+$'), undefined, 'characters inside a class are literal');
  });

  it('refuses a config file that is a symlink', (t) => {
    const root = tempDir();
    if (!trySymlink(process.platform === 'win32' ? 'NUL' : '/dev/zero', join(root, '.repo-archaeology.json'))) return t.skip('symlinks unavailable');
    assert.throws(() => loadConfigFile(root), /regular file/);
  });
});

describe('review 2, accuracy', () => {
  it('classifies one-step import chains as indirect, naming the file in between', () => {
    const files = {
      'src/jwt/types.ts': "import { sign } from './jws'",
      'src/jwt/jws.ts': "import { alg } from './jwa'",
      'src/jwt/jwa.ts': 'export const alg = 1',
      'src/other.ts': '',
    };
    const classifier = new RelationshipClassifier(memoryRepo(files));
    assert.equal(classifier.classify('src/jwt/types.ts', 'src/jwt/jwa.ts'), 'indirect');
    assert.equal(classifier.classify('src/jwt/jwa.ts', 'src/jwt/types.ts'), 'indirect');
    assert.match(classifier.explain('src/jwt/types.ts', 'src/jwt/jwa.ts', 'indirect'), /connected through src\/jwt\/jws\.ts/);
    assert.equal(classifier.classify('src/jwt/types.ts', 'src/other.ts'), 'ghost');
  });

  it('recognizes parallel implementations whose names differ only by extension', () => {
    const classifier = new RelationshipClassifier(memoryRepo({ 'templates/react-ts/App.tsx': '', 'templates/react/App.jsx': '' }));
    assert.deepEqual(classifier.hiddenBridge('templates/react-ts/App.tsx', 'templates/react/App.jsx'), {
      signal: 'parallel-implementation', value: 'App.tsx / App.jsx', filesUsing: 2,
    });
  });

  it('follows conditional exports in the order the package lists them, ignoring types', () => {
    const resolver = new ImportResolver(memoryRepo({
      'packages/lib/package.json': JSON.stringify({ name: 'lib', exports: { '.': { types: './src/types.d.ts', node: './src/node.ts', default: './src/browser.ts' } } }),
      'packages/lib/src/node.ts': '',
      'packages/lib/src/browser.ts': '',
      'packages/lib/src/types.d.ts': '',
      'app/a.ts': '',
    }));
    assert.deepEqual(resolver.resolve('app/a.ts', 'lib'), { kind: 'file', path: 'packages/lib/src/node.ts' });
  });

  it('treats imports whose target is computed at runtime as uncertain, not as no link', () => {
    assert.equal(countNonLiteralLoads("const m = await import('./literal');"), 0);
    assert.equal(countNonLiteralLoads('const m = await import(name);'), 1);
    assert.equal(countNonLiteralLoads('const m = require(`./${name}`);'), 1);
    assert.equal(countNonLiteralLoads("const pages = import.meta.glob('./pages/*.ts');"), 1);
    assert.equal(countNonLiteralLoads("// import(name) in a comment\nconst s = 'require(x)';"), 0);
    const dynamic = new RelationshipClassifier(memoryRepo({ 'src/a.ts': 'export const load = (n: string) => import(n);', 'src/b.ts': '' }));
    assert.equal(dynamic.classify('src/a.ts', 'src/b.ts'), 'unknown');
  });

  it('treats an unreadable barrel as uncertain', () => {
    const files = { 'src/a.ts': "import { x } from './lib'", 'src/lib/index.ts': undefined, 'src/b.ts': '' };
    assert.equal(new RelationshipClassifier(memoryRepo(files)).classify('src/a.ts', 'src/b.ts'), 'unknown');
  });

  it('does not give a new uncommitted file the history of a deleted file at the same path', async () => {
    const r = fixture();
    for (let i = 0; i < 5; i++) r.touch(['src/a.ts', 'src/b.ts']);
    r.commit({ message: 'delete a', write: { 'src/a.ts': null } });
    r.write('src/a.ts', 'export const unrelated = 1;\n');
    const ctx = await loadContext(r.dir, { minShared: 3, minConfidence: 0.4 });
    const changes = await workingTreeChanges(r.dir);
    const result = suggestMissing(ctx, changes, { limit: 10, kinds: ['ghost', 'unknown', 'indirect', 'direct', 'test'] });
    assert.equal(result.changed.find((f) => f.path === 'src/a.ts')?.hasHistory, false);
    assert.deepEqual(result.suggestions, []);
  });

  it('keeps branch edits to a file that was renamed on the main line before the merge', async () => {
    const r = fixture();
    r.commit({ message: 'create', write: { 'old.ts': 'a\nb\nc\nd\n', 'other.ts': '1\n' }, day: 0 });
    r.git('checkout', '-q', '-b', 'feature');
    r.git('checkout', '-q', 'main');
    r.commit({ message: 'rename', move: [['old.ts', 'new.ts']], day: 1 });
    r.git('checkout', '-q', 'feature');
    for (let day = 2; day <= 4; day++) r.commit({ message: `edit ${day}`, write: { 'old.ts': `a\nb\nc\nd\n${day}\n`, 'other.ts': `${day}\n` }, day });
    r.git('checkout', '-q', 'main');
    spawnSync('git', ['merge', '-q', '--no-edit', 'feature'], { cwd: r.dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
    const history = await loadHistory(r.dir, { maxFilesPerCommit: 25, ignore: DEFAULT_IGNORES });
    const model = new CoChangeModel(history.commits);
    assert.equal(model.id('old.ts'), undefined, 'branch edits must not be stranded under the old name');
    assert.equal(model.changeCount[model.id('new.ts')!], 5);
    assert.equal(model.pair(model.id('new.ts')!, model.id('other.ts')!)?.count, 4);
  });

  it('ignores git settings that would hide the root commit or rename detection', async () => {
    const r = fixture();
    r.touch(['a.ts', 'b.ts'], 'root');
    r.touch(['a.ts', 'b.ts']);
    r.git('config', 'log.showRoot', 'false');
    r.git('config', 'diff.renameLimit', '1');
    const history = await loadHistory(r.dir, { maxFilesPerCommit: 25, ignore: DEFAULT_IGNORES });
    assert.equal(history.commits.length, 2);
    assert.deepEqual(history.commits.at(-1)?.files.sort(), ['a.ts', 'b.ts']);
  });

  it('orders evidence by the date it displays', () => {
    const commits: HistoryCommit[] = [
      // Rebased: authored first, committed last.
      { hash: 'early-author', author: 'x', time: 100, commitTime: 900, subject: '', files: ['a.ts', 'b.ts'] },
      { hash: 'late-author', author: 'x', time: 500, commitTime: 600, subject: '', files: ['a.ts', 'b.ts'] },
      { hash: 'middle', author: 'x', time: 300, commitTime: 700, subject: '', files: ['a.ts', 'b.ts'] },
    ];
    const model = new CoChangeModel(commits);
    const stat = model.pair(model.id('a.ts')!, model.id('b.ts')!)!;
    assert.deepEqual(stat.evidence.map((i) => commits[i]!.hash), ['late-author', 'middle', 'early-author']);
  });
});

describe('review 2, map and wording', () => {
  it('measures "past year" from the newest analyzed commit, not from today', async () => {
    const r = fixture();
    // Fixture dates are in 2024, well over a year before today.
    for (let i = 0; i < 4; i++) r.touch(['src/billing/a.ts', 'src/email/b.ts']);
    const ctx = await loadContext(r.dir, { minShared: 3, minConfidence: 0.4 });
    const data = buildMapData(ctx, { edges: 50, kinds: ['ghost', 'unknown', 'indirect', 'direct'], uncheckedCap: 5 });
    assert.ok(data.edges.some((e) => e.overviewPriority > 0), JSON.stringify(data.edges.map((e) => e.overviewPriority)));
  });

  it('lays out folders whose names collide with Object.prototype members', () => {
    const html = renderMapHtml({
      meta: {} as never, repoName: 'r', generatedAt: '2024-01-01T00:00:00Z', counts: { ghost: 0, unknown: 0, indirect: 0, direct: 0, test: 0 },
      classificationTruncated: false, nodes: [], edges: [],
    });
    assert.match(html, /var dirs = Object\.create\(null\)/);
  });

  it('says "1 month ago", not "1 months ago"', () => {
    const now = 1_000_000_000;
    assert.equal(timeAgo(now - 45 * 86400, now), '1 month ago');
    assert.equal(timeAgo(now - 70 * 86400, now), '2 months ago');
  });

  it('reports a mistyped command as unknown and suggests the right one', () => {
    const r = fixture();
    r.touch(['a.ts']);
    const result = spawnSync(process.execPath, ['--import', TSX, CLI, 'scna'], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown command 'scna'/);
    assert.match(result.stderr, /Did you mean scan\?/);
    assert.doesNotMatch(result.stderr, /too many arguments/);
  });
});

