import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { DEFAULT_IGNORES } from '../src/config.js';
import { loadHistory } from '../src/model/history.js';
import { CoChangeModel } from '../src/model/cochange.js';
import { FixtureRepo } from './helpers.js';

const repos: FixtureRepo[] = [];
after(() => repos.forEach((r) => r.cleanup()));
function repo(): FixtureRepo {
  const r = new FixtureRepo();
  repos.push(r);
  return r;
}

const options = { maxFilesPerCommit: 5, ignore: DEFAULT_IGNORES };

describe('history from real git repositories', () => {
  it('follows renames so pre-rename history counts for the current name', async () => {
    const r = repo();
    r.touch(['src/old.ts', 'src/partner.ts']);
    r.touch(['src/old.ts', 'src/partner.ts']);
    r.commit({ message: 'move', move: [['src/old.ts', 'lib/new.ts']] });
    r.touch(['lib/new.ts', 'src/partner.ts']);
    const history = await loadHistory(r.dir, options);
    const model = new CoChangeModel(history.commits);
    assert.equal(model.id('src/old.ts'), undefined);
    assert.equal(model.changeCount[model.id('lib/new.ts')!], 4);
    assert.equal(model.pair(model.id('lib/new.ts')!, model.id('src/partner.ts')!)!.count, 3);
    assert.equal(history.stats.renamesFollowed, 1);
  });

  it('does not merge a reused path into the file that moved away', async () => {
    const r = repo();
    r.touch(['a.ts', 'b.ts']);
    r.commit({ message: 'rename a to c', move: [['a.ts', 'c.ts']] });
    r.touch(['a.ts', 'z.ts'], 'brand new a.ts');
    const history = await loadHistory(r.dir, options);
    const model = new CoChangeModel(history.commits);
    assert.equal(model.changeCount[model.id('c.ts')!], 2); // original a.ts history + rename
    assert.equal(model.changeCount[model.id('a.ts')!], 1); // only the new file
    assert.equal(model.pair(model.id('a.ts')!, model.id('b.ts')!), undefined);
  });

  it('skips sweeps and ignored files, keeping sweeps aside for backtests', async () => {
    const r = repo();
    r.touch(['a.ts', 'b.ts', 'package-lock.json', 'dist/out.js']);
    r.touch(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'], 'format everything');
    r.touch(['yarn.lock'], 'only a lockfile');
    const history = await loadHistory(r.dir, options);
    assert.equal(history.commits.length, 1);
    assert.deepEqual([...history.commits[0]!.files].sort(), ['a.ts', 'b.ts']);
    assert.equal(history.stats.sweepsSkipped, 1);
    assert.equal(history.stats.emptyAfterIgnores, 1);
    assert.equal(history.excluded.length, 1);
    assert.equal(history.excluded[0]!.subject, 'format everything');
  });

  it('skips commits by subject when asked', async () => {
    const r = repo();
    r.touch(['a.ts', 'b.ts'], 'chore: bump');
    r.touch(['a.ts', 'b.ts'], 'feat: real work');
    const history = await loadHistory(r.dir, { ...options, skipCommits: /^chore\b/i });
    assert.deepEqual(history.commits.map((c) => c.subject), ['feat: real work']);
    assert.equal(history.stats.subjectSkipped, 1);
  });

  it('handles spaces, unicode and newlines in file names', async () => {
    const r = repo();
    r.touch(['docs/read me.md', 'src/ünï.ts', 'weird\nname.ts']);
    r.touch(['docs/read me.md', 'src/ünï.ts', 'weird\nname.ts']);
    const history = await loadHistory(r.dir, options);
    const model = new CoChangeModel(history.commits);
    for (const f of ['docs/read me.md', 'src/ünï.ts', 'weird\nname.ts']) assert.equal(model.changeCount[model.id(f)!], 2, f);
  });

  it('respects maxCommits and records authors and times', async () => {
    const r = repo();
    r.touch(['a.ts'], 'one', { author: 'Ada' });
    r.touch(['a.ts'], 'two', { author: 'Grace' });
    r.touch(['a.ts'], 'three', { author: 'Grace' });
    const history = await loadHistory(r.dir, { ...options, maxCommits: 2 });
    assert.deepEqual(history.commits.map((c) => c.subject), ['three', 'two']);
    const model = new CoChangeModel(history.commits);
    assert.deepEqual(model.topAuthors(model.id('a.ts')!), [{ author: 'Grace', commits: 2, share: 1 }]);
  });
});
