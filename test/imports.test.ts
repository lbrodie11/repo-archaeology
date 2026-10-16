import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isTestFile, isTestPair, RelationshipClassifier } from '../src/imports/classify.js';
import { ImportResolver, resolveFile, type RepoFiles } from '../src/imports/resolve.js';

function memoryRepo(files: Record<string, string>): RepoFiles {
  return {
    exists: (p) => p in files,
    read: (p) => files[p],
    list: () => Object.keys(files),
  };
}

describe('import resolution', () => {
  const repo = memoryRepo({
    'src/a.ts': '',
    'src/index.ts': '',
    'src/b.tsx': '',
    'src/util/index.ts': '',
    'src/data.json': '',
    'src/esm.ts': '',
    'lib/legacy.js': '',
    'tsconfig.base.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], "@exact": ["src/a.ts"] } } }',
    'tsconfig.json': '{ // comments are allowed\n "extends": "./tsconfig.base", "compilerOptions": { "strict": true, } }',
    'package.json': '{ "name": "my-lib", "exports": { ".": "./dist/index.js", "./util": { "import": "./dist/util/index.js" } } }',
    'packages/ui/package.json': '{ "name": "@acme/ui", "main": "dist/index.js" }',
    'packages/ui/src/index.ts': '',
    'packages/ui/src/button.tsx': '',
  });
  const resolver = new ImportResolver(repo);
  const r = (from: string, spec: string) => resolver.resolve(from, spec);

  it('resolves relative imports with extensions, swaps and index files', () => {
    assert.deepEqual(r('src/a.ts', './b'), { kind: 'file', path: 'src/b.tsx' });
    assert.deepEqual(r('src/a.ts', './esm.js'), { kind: 'file', path: 'src/esm.ts' });
    assert.deepEqual(r('src/a.ts', './util'), { kind: 'file', path: 'src/util/index.ts' });
    assert.deepEqual(r('src/a.ts', './data.json'), { kind: 'file', path: 'src/data.json' });
    assert.deepEqual(r('src/a.ts', '../lib/legacy'), { kind: 'file', path: 'lib/legacy.js' });
    assert.deepEqual(r('src/a.ts', './missing'), { kind: 'unresolved' });
    assert.equal(resolveFile('../outside', repo), undefined);
  });

  it('follows tsconfig paths through extends', () => {
    assert.deepEqual(r('src/b.tsx', '@/util'), { kind: 'file', path: 'src/util/index.ts' });
    assert.deepEqual(r('src/b.tsx', '@exact'), { kind: 'file', path: 'src/a.ts' });
    assert.deepEqual(r('src/b.tsx', '@/nope'), { kind: 'unresolved' });
    assert.deepEqual(r('src/b.tsx', 'src/a'), { kind: 'file', path: 'src/a.ts' }); // baseUrl
  });

  it('maps imports of the repo’s own packages back to source files', () => {
    assert.deepEqual(r('test/x.ts', 'my-lib'), { kind: 'file', path: 'src/index.ts' });
    assert.deepEqual(r('test/x.ts', 'my-lib/util'), { kind: 'file', path: 'src/util/index.ts' });
    assert.deepEqual(r('apps/web/page.tsx', '@acme/ui'), { kind: 'file', path: 'packages/ui/src/index.ts' });
    assert.deepEqual(r('apps/web/page.tsx', '@acme/ui/button'), { kind: 'file', path: 'packages/ui/src/button.tsx' });
    assert.deepEqual(r('apps/web/page.tsx', '@acme/ui/missing'), { kind: 'unresolved' });
  });

  it('treats packages and URLs as external and unknown aliases as unresolved', () => {
    assert.deepEqual(r('src/a.ts', 'react'), { kind: 'external' });
    assert.deepEqual(r('src/a.ts', 'node:fs'), { kind: 'external' });
    assert.deepEqual(r('src/a.ts', '~/thing'), { kind: 'unresolved' });
    assert.deepEqual(r('src/a.ts', '#internal'), { kind: 'unresolved' });
  });
});

describe('relationship classification', () => {
  const repo = memoryRepo({
    'src/api.ts': "import { db } from './db'\nexport const x = 1",
    'src/db.ts': "// import './api' in a comment does not count\nexport const db = 1; const s = \"require('./api')\"",
    'src/cron.js': "const lib = require('./lib')",
    'src/lib/index.ts': "export * from './payments'",
    'src/lib/payments.ts': 'export const pay = 1',
    'src/billing.ts': 'export {}',
    'src/aliased.ts': "import x from '~/somewhere'",
    'src/api.test.ts': "import { x } from './api'",
    'schema.sql': 'create table t();',
    'docs/a.md': '',
    'docs/b.md': '',
  });
  const classifier = new RelationshipClassifier(repo);

  it('finds direct imports, including through barrel files and require()', () => {
    assert.equal(classifier.classify('src/api.ts', 'src/db.ts'), 'direct');
    assert.equal(classifier.classify('src/db.ts', 'src/api.ts'), 'direct');
    assert.equal(classifier.classify('src/cron.js', 'src/lib/payments.ts'), 'direct');
  });

  it('calls a checked pair with no import link a ghost wire', () => {
    assert.equal(classifier.classify('src/db.ts', 'src/billing.ts'), 'ghost');
    assert.equal(classifier.classify('schema.sql', 'src/billing.ts'), 'ghost');
  });

  it('says unknown when it cannot check', () => {
    assert.equal(classifier.classify('docs/a.md', 'docs/b.md'), 'unknown');
    assert.equal(classifier.classify('src/aliased.ts', 'src/billing.ts'), 'unknown');
  });

  it('recognizes tests and the code they cover', () => {
    assert.equal(classifier.classify('src/api.ts', 'src/api.test.ts'), 'test');
    assert.ok(isTestFile('src/__tests__/x.ts'));
    assert.ok(isTestFile('pkg/foo_test.go'));
    assert.ok(!isTestFile('src/contest.ts'));
    assert.ok(isTestPair('lib/command.js', 'tests/command.help.test.js'));
    assert.ok(isTestPair('src/a/x.ts', 'src/a/__tests__/y.test.ts'));
    assert.ok(!isTestPair('package.json', 'tests/command.test.js'));
    assert.ok(!isTestPair('src/a.test.ts', 'src/b.test.ts'));
  });
});
