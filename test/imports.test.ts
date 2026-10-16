import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isTestFile, isTestPair, RelationshipClassifier, testCovers } from '../src/imports/classify.js';
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
    'dist/index.js': 'export const built = true',
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
    'src/env-a.ts': 'export const key = process.env.PAYMENTS_KEY',
    'src/env-b.ts': "export const key = import.meta.env['PAYMENTS_KEY']",
    'src/route-a.ts': "fetch('/api/orders')",
    'src/route-b.ts': "app.get('/api/orders', handler)",
    'src/event-a.ts': "bus.emit('order.created')",
    'src/event-b.ts': "bus.on('order.created', handler)",
    'src/adapter/bun/serve.ts': 'export const runtime = "bun"',
    'src/adapter/deno/serve.ts': 'export const runtime = "deno"',
    'src/other/serve.ts': 'export const unrelated = true',
    'src/common-a.ts': 'process.env.NODE_ENV',
    'src/common-b.ts': 'process.env.NODE_ENV',
    'src/common-c.ts': 'process.env.NODE_ENV',
    'src/common-d.ts': 'process.env.NODE_ENV',
    'src/reference-noise.ts': `
      // process.env.PAYMENTS_KEY; bus.on('order.created')
      const code = "process.env.PAYMENTS_KEY";
      const eventName = 'order.created';
      on('order.created');
      import('/api/orders');
    `,
    'src/aliased.ts': "import x from '~/somewhere'",
    'src/api.test.ts': "import { x } from './api'",
    'schema.sql': 'create table t();',
    'package.json': '{}',
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
    assert.match(classifier.explain('src/db.ts', 'src/billing.ts', 'ghost'), /current code/);
  });

  it('recognizes possible parallel implementations only in sibling folders', () => {
    assert.deepEqual(classifier.hiddenBridge('src/adapter/bun/serve.ts', 'src/adapter/deno/serve.ts'), {
      signal: 'parallel-implementation', value: 'serve.ts', filesUsing: 2,
    });
    assert.match(classifier.explain('src/adapter/bun/serve.ts', 'src/adapter/deno/serve.ts', 'ghost'), /possible parallel implementations/);
    assert.equal(classifier.hiddenBridge('src/adapter/bun/serve.ts', 'src/other/serve.ts'), undefined);
    assert.equal(classifier.hiddenBridge('serve.ts', 'adapter/serve.ts'), undefined);
    assert.equal(classifier.hiddenBridge('src/a/index.d.ts', 'src/b/index.d.ts'), undefined);
  });

  it('explains rare shared environment, route and event references', () => {
    assert.deepEqual(classifier.hiddenBridge('src/env-a.ts', 'src/env-b.ts'), {
      signal: 'shared-environment', value: 'PAYMENTS_KEY', filesUsing: 2,
    });
    assert.match(classifier.explain('src/env-a.ts', 'src/env-b.ts', 'ghost'), /shared configuration/);
    assert.deepEqual(classifier.hiddenBridge('src/route-a.ts', 'src/route-b.ts'), {
      signal: 'shared-api-route', value: '/api/orders', filesUsing: 2,
    });
    assert.deepEqual(classifier.hiddenBridge('src/event-a.ts', 'src/event-b.ts'), {
      signal: 'shared-event', value: 'order.created', filesUsing: 2,
    });
  });

  it('suppresses common references and ignores comments, code-like strings and module specifiers', () => {
    assert.equal(classifier.hiddenBridge('src/common-a.ts', 'src/common-b.ts'), undefined);
    assert.equal(classifier.hiddenBridge('src/env-a.ts', 'src/reference-noise.ts'), undefined);
    assert.equal(classifier.hiddenBridge('src/route-a.ts', 'src/reference-noise.ts'), undefined);
    assert.equal(classifier.hiddenBridge('src/event-a.ts', 'src/reference-noise.ts'), undefined);
  });

  it('says unknown when it cannot check', () => {
    assert.equal(classifier.classify('src/billing.ts', 'package.json'), 'unknown');
    assert.equal(classifier.classify('docs/a.md', 'docs/b.md'), 'unknown');
    assert.equal(classifier.classify('src/aliased.ts', 'src/billing.ts'), 'unknown');
    assert.equal(classifier.classify('src/deleted.ts', 'src/billing.ts'), 'unknown');
    assert.equal(classifier.classify('schema.sql', 'src/billing.ts'), 'unknown');
    assert.match(classifier.explain('src/deleted.ts', 'src/billing.ts', 'unknown'), /source is unavailable/);
    assert.match(classifier.explain('schema.sql', 'src/billing.ts', 'unknown'), /file types are not supported/);
  });

  it('recognizes tests and the code they cover', () => {
    assert.equal(classifier.classify('src/api.ts', 'src/api.test.ts'), 'test');
    assert.ok(isTestFile('src/__tests__/x.ts'));
    assert.ok(isTestFile('pkg/foo_test.go'));
    assert.ok(!isTestFile('src/contest.ts'));
    assert.ok(isTestPair('lib/command.js', 'tests/command.help.test.js'));
    assert.ok(isTestPair('src/a.test.ts', 'src/b.test.ts')); // tests moving together
    assert.ok(isTestPair('docs/guide.md', 'test/deep/x.test.ts'));
    assert.ok(!isTestPair('package.json', 'tests/command.test.js'));
    assert.ok(!isTestPair('tsconfig.json', 'src/a.test.ts'));
    assert.ok(testCovers('tests/command.help.test.js', 'lib/command.js'));
    assert.ok(testCovers('src/a/__tests__/y.test.ts', 'src/a/x.ts'));
    assert.ok(testCovers('playground/worker/__tests__/es/worker-es.spec.ts', 'playground/worker/index.html'));
    assert.ok(testCovers('playground/glob/__tests__/g.spec.ts', 'playground/glob/root/index.html'));
    assert.ok(!testCovers('src/__tests__/x.test.ts', 'src/deep/a.ts'));
    assert.ok(!testCovers('test/x.test.ts', 'README.md'));
    assert.ok(!isTestPair('src/a.ts', 'src/b.ts'));
  });
});
