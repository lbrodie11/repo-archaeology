/**
 * Regression tests for the six issues found in the first external code review.
 * Each test reproduces the original failure.
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { suggestMissing } from '../src/commands/diff.js';
import { scan } from '../src/commands/scan.js';
import { DEFAULT_IGNORES } from '../src/config.js';
import { loadContext, type Context } from '../src/context.js';
import type { RawCommit } from '../src/git/log.js';
import { RelationshipClassifier } from '../src/imports/classify.js';
import { ImportResolver, type RepoFiles } from '../src/imports/resolve.js';
import { CoChangeModel } from '../src/model/cochange.js';
import { loadHistory, pathOf, RenameTracker, type HistoryCommit } from '../src/model/history.js';
import { FixtureRepo } from './helpers.js';

const repos: FixtureRepo[] = [];
after(() => repos.forEach((r) => r.cleanup()));

function memoryRepo(files: Record<string, string>): RepoFiles {
  return { exists: (p) => p in files, read: (p) => files[p], list: () => Object.keys(files) };
}

describe('1. deleted and recreated files', () => {
  it('do not inherit the old file’s history', async () => {
    const r = new FixtureRepo();
    repos.push(r);
    for (let i = 0; i < 5; i++) r.touch(['a.ts', 'b.ts']);
    r.commit({ message: 'delete a', write: { 'a.ts': null } });
    r.touch(['a.ts', 'c.ts'], 'unrelated new a.ts');
    const history = await loadHistory(r.dir, { maxFilesPerCommit: 25, ignore: DEFAULT_IGNORES });
    const model = new CoChangeModel(history.commits);
    const a = model.id('a.ts')!;
    assert.equal(model.changeCount[a], 1);
    assert.equal(model.pair(a, model.id('b.ts')!), undefined);
    // The old file still exists in the model under its own identity, invisible in results.
    const old = model.files.find((f) => f !== 'a.ts' && pathOf(f) === 'a.ts')!;
    assert.equal(model.changeCount[model.id(old)!], 6);
  });

  it('keeps a renamed file’s history when a new file takes its old name in the same commit', () => {
    const tracker = new RenameTracker();
    const commit = (changes: RawCommit['changes']): RawCommit => ({ hash: 'h', authorName: 'a', authorEmail: '', authorTime: 0, commitTime: 0, subject: '', changes });
    assert.deepEqual(tracker.apply(commit([{ status: 'R', oldPath: 'old.ts', path: 'new.ts' }, { status: 'A', path: 'old.ts' }])), ['new.ts', 'old.ts']);
    assert.deepEqual(tracker.apply(commit([{ status: 'M', path: 'old.ts' }])), ['new.ts']);
  });
});

describe('2. recency weighting', () => {
  it('does not count weightless old commits as evidence', () => {
    const commits: HistoryCommit[] = [];
    const day = 86400;
    for (let i = 0; i < 3; i++) commits.push({ hash: `r${i}`, author: 'x', time: (3000 + i) * day, commitTime: (3000 + i) * day, subject: '', files: ['a.ts', 'b.ts'] });
    for (let i = 0; i < 1000; i++) commits.push({ hash: `o${i}`, author: 'x', time: i * day, commitTime: i * day, subject: '', files: ['a.ts'] });
    const model = new CoChangeModel(commits, { halfLifeDays: 30 });
    const a = model.id('a.ts')!;
    assert.ok(Math.abs(model.effectiveChanges(a) - 3) < 0.1, String(model.effectiveChanges(a)));
    const [companion] = model.companions(a, { minShared: 1, minConfidence: 0 });
    assert.ok(companion!.confidence > 0.99);
    assert.ok(companion!.score < 0.6, `score ${companion!.score} should reflect ~3 commits of evidence`);
    const flat = new CoChangeModel(commits);
    assert.equal(flat.effectiveChanges(a), 1003);
  });
});

describe('3. barrel files with unresolved imports', () => {
  it('make "no import link" uncertain instead of a ghost wire', () => {
    const files = {
      'src/a.ts': "import { x } from './lib'",
      'src/lib/index.ts': "export * from '~/somewhere'\nexport * from './x'",
      'src/lib/x.ts': '',
      'src/b.ts': '',
    };
    assert.equal(new RelationshipClassifier(memoryRepo(files)).classify('src/a.ts', 'src/b.ts'), 'unknown');
    const resolved = { ...files, 'src/lib/index.ts': "export * from './x'" };
    assert.equal(new RelationshipClassifier(memoryRepo(resolved)).classify('src/a.ts', 'src/b.ts'), 'ghost');
  });
});

describe('4. diff --kinds', () => {
  it('keeps a qualifying ghost wire when a stronger import link to the same file is filtered out', () => {
    const commits: HistoryCommit[] = [];
    let t = 0;
    const add = (files: string[]) => commits.push({ hash: `h${t}`, author: 'x', time: t, commitTime: t++, subject: `c${t}`, files });
    for (let i = 0; i < 10; i++) add(['src/x.ts', 'src/t.ts']); // x imports t: strong import link
    for (let i = 0; i < 3; i++) add(['src/y.ts', 'src/t.ts']); // y has no import: ghost wire
    for (let i = 0; i < 2; i++) add(['src/y.ts']);
    const files = { 'src/x.ts': "import './t'", 'src/y.ts': '', 'src/t.ts': '' };
    const model = new CoChangeModel(commits);
    const ctx = {
      model,
      currentFiles: new Set(Object.keys(files)),
      classifier: new RelationshipClassifier(memoryRepo(files)),
      thresholds: { minShared: 3, minConfidence: 0.4 },
    } as unknown as Context;
    const changes = [
      { path: 'src/x.ts', deleted: false, sources: ['unstaged' as const] },
      { path: 'src/y.ts', deleted: false, sources: ['unstaged' as const] },
    ];
    const ghostsOnly = suggestMissing(ctx, changes, { limit: 10, kinds: ['ghost'] });
    assert.deepEqual(ghostsOnly.suggestions.map((s) => [s.from, s.to, s.relationship]), [['src/y.ts', 'src/t.ts', 'ghost']]);
    const all = suggestMissing(ctx, changes, { limit: 10, kinds: ['ghost', 'direct'] });
    assert.deepEqual(all.suggestions.map((s) => [s.from, s.relationship]), [['src/x.ts', 'direct']]);
  });
});

describe('5. "#" aliases', () => {
  it('reach tsconfig paths instead of being stripped as a hash suffix', () => {
    const resolver = new ImportResolver(memoryRepo({
      'tsconfig.json': '{ "compilerOptions": { "paths": { "#/*": ["./src/*"] } } }',
      'src/a.ts': '',
      'src/b.ts': '',
      'src/icon.svg': '',
    }));
    assert.deepEqual(resolver.resolve('src/a.ts', '#/b'), { kind: 'file', path: 'src/b.ts' });
    assert.deepEqual(resolver.resolve('src/a.ts', '#/b?raw'), { kind: 'file', path: 'src/b.ts' });
    assert.deepEqual(resolver.resolve('src/a.ts', './icon.svg#symbol'), { kind: 'file', path: 'src/icon.svg' });
    assert.deepEqual(resolver.resolve('src/a.ts', '#nothing'), { kind: 'unresolved' });
  });
});

describe('6. unstaged deletions', () => {
  it('are not treated as existing files', async () => {
    const r = new FixtureRepo();
    repos.push(r);
    for (let i = 0; i < 4; i++) r.touch(['src/a.ts', 'docs/b.md']);
    rmSync(join(r.dir, 'docs/b.md'));
    const ctx = await loadContext(r.dir, { minShared: 3, minConfidence: 0.4 });
    assert.equal(ctx.currentFiles.has('docs/b.md'), false);
    const result = scan(ctx, { limit: 10, kinds: ['ghost', 'unknown', 'direct', 'test'] });
    assert.deepEqual(result.relationships, []);
  });
});
