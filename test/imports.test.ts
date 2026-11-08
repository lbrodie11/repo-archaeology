import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { isTestFile, isTestPair, RelationshipClassifier, testCovers, workingTreeFiles } from '../src/imports/classify.js';
import { ImportResolver, resolveFile, type RepoFiles } from '../src/imports/resolve.js';
import { extractSourceReferences } from '../src/imports/references.js';
import { extractDependencies, extractSpecifiers } from '../src/imports/typescript.js';

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
    'package.json': '{ "name": "my-lib", "workspaces": ["packages/*"], "exports": { ".": "./dist/index.js", "./util": { "import": "./dist/util/index.js" } } }',
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
  it('keeps module specifiers separate from TypeScript file, types and lib directives', () => {
    const text = `
      /// <reference path="types/ambient.d.ts" />
      /// <reference types="node" />
      /// <reference lib="es2022" />
      import './module';
      export * from './exports';
      const fake = '/// <reference path="fake.d.ts" />';
      /* /// <reference path="comment.d.ts" /> */
    `;
    assert.deepEqual(extractDependencies(text), {
      specifiers: ['./module', './exports'], referencePaths: ['types/ambient.d.ts'], nonLiteralLoads: 0,
    });
    assert.deepEqual(extractSpecifiers(text), ['./module', './exports']);
    const external = new RelationshipClassifier(memoryRepo({
      'src/a.ts': '/// <reference types="node" />\n/// <reference lib="es2022" />',
      'src/b.ts': 'export {};',
    }));
    assert.equal(external.classify('src/a.ts', 'src/b.ts'), 'ghost');
  });

  it('resolves exact path references relative to the declaring file without module extension swaps', () => {
    const referenced = new RelationshipClassifier(memoryRepo({
      'src/nested/widget.js': '/// <reference path="../types/widget.d.ts" />',
      'src/types/widget.d.ts': 'interface Widget {}',
      'src/backslash.js': String.raw`/// <reference path="types\widget.d.ts" />`,
      'src/exact.js': '/// <reference path="./only.js" />',
      'src/only.ts': 'export {};',
      'src/hash.js': '/// <reference path="./types/with#hash.d.ts" />',
      'src/types/with#hash.d.ts': 'interface Hash {}',
    }));
    assert.equal(referenced.classify('src/nested/widget.js', 'src/types/widget.d.ts'), 'direct');
    assert.equal(referenced.classify('src/backslash.js', 'src/types/widget.d.ts'), 'direct');
    assert.equal(referenced.classify('src/hash.js', 'src/types/with#hash.d.ts'), 'direct');
    assert.equal(referenced.classify('src/exact.js', 'src/only.ts'), 'unknown');
  });

  it('does not follow path references outside the repository or at absolute locations', () => {
    for (const path of ['../../outside.d.ts', '/tmp/outside.d.ts', 'C:/outside.d.ts', 'C:outside.d.ts', '//server/share/outside.d.ts']) {
      const referenced = new RelationshipClassifier(memoryRepo({
        'src/widget.js': `/// <reference path="${path}" />`,
        'src/other.ts': 'export {};',
      }));
      assert.equal(referenced.classify('src/widget.js', 'src/other.ts'), 'unknown', path);
      assert.equal(referenced.analyze('src/widget.js').references.size, 0, path);
    }
  });

  it('propagates unresolved path references through followed barrel files', () => {
    const referenced = new RelationshipClassifier(memoryRepo({
      'src/widget.js': "import './lib';",
      'src/lib/index.ts': '/// <reference path="missing.d.ts" />',
      'src/other.ts': 'export {};',
    }));
    assert.equal(referenced.classify('src/widget.js', 'src/other.ts'), 'unknown');
  });

  it('recognizes triple-slash path references as explicit current-code dependencies', () => {
    const referenced = new RelationshipClassifier(memoryRepo({
      'src/widget.js': '// @ts-check\n/// <reference path="widget.types.d.ts" />\nexport {};',
      'src/widget.types.d.ts': 'interface WidgetConfig { enabled: boolean }',
    }));
    assert.equal(referenced.classify('src/widget.js', 'src/widget.types.d.ts'), 'direct');
    assert.equal(referenced.classify('src/widget.types.d.ts', 'src/widget.js'), 'direct');
    assert.match(referenced.explain('src/widget.js', 'src/widget.types.d.ts', 'direct'), /references.*widget\.types\.d\.ts.*current code/);
    assert.match(referenced.explain('src/widget.types.d.ts', 'src/widget.js', 'direct'), /widget\.js.*references/);
  });

  it('marks unresolved relative reference paths as uncertain instead of ghost wires', () => {
    const referenced = new RelationshipClassifier(memoryRepo({
      'src/widget.js': '/// <reference path="missing.d.ts" />\nexport {};',
      'src/other.ts': 'export {};',
    }));
    assert.equal(referenced.classify('src/widget.js', 'src/other.ts'), 'unknown');
    assert.match(referenced.explain('src/widget.js', 'src/other.ts', 'unknown'), /references/);
  });

  it('finds explicit public export names without mistaking private or nested names for exports', () => {
    const source = `
      // export class Fake {}
      const quoted = 'export class AlsoFake {}';
      class Private {}
      export class Hono {}
      export function createClient() {}
      export interface Options {}
      export type Result = string;
      export enum Mode { Read }
      export const route = '/', port = 8080;
      export { Private as Public, Private as default };
      export type { Request as PublicRequest } from './types';
      export * from './other';
      export default class DefaultName {}
      namespace Internal { export class Nested {} }
    `;
    assert.deepEqual(extractSourceReferences('src/a.ts', source).filter((reference) => reference.kind === 'export').map((reference) => reference.value),
      ['Hono', 'createClient', 'Options', 'Result', 'Mode', 'route', 'port', 'Public', 'PublicRequest']);
  });

  it('explains rare shared export names without asserting equivalent implementations', () => {
    const files = { 'src/preset/tiny.ts': 'export class Hono {}', 'src/hono.ts': 'export class Hono {}' };
    const exports = new RelationshipClassifier(memoryRepo(files));
    assert.deepEqual(exports.hiddenBridge('src/preset/tiny.ts', 'src/hono.ts'), {
      signal: 'shared-export', value: 'Hono', filesUsing: 2,
    });
    assert.match(exports.explain('src/preset/tiny.ts', 'src/hono.ts', 'ghost'), /possible shared public contract.*Hono.*current code/);
    const common = new RelationshipClassifier(memoryRepo({
      ...files,
      'src/third.ts': 'export class Hono {}', 'src/fourth.ts': 'export class Hono {}',
    }));
    assert.equal(common.hiddenBridge('src/preset/tiny.ts', 'src/hono.ts'), undefined);
  });

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

describe('RA-09A: monorepo workspace discovery, exports, #imports, and source remapping', () => {
  it('discovers workspaces from package.json#workspaces (array & object), pnpm-workspace.yaml, and lerna.json with !negation', () => {
    // 1. package.json#workspaces.packages object form + negation
    const objWorkspaces = new ImportResolver(
      memoryRepo({
        'package.json': JSON.stringify({
          workspaces: { packages: ['packages/*', '!packages/legacy'] },
          dependencies: { react: '^18.0.0' },
        }),
        'packages/active/package.json': JSON.stringify({ name: '@acme/active', main: './src/index.ts' }),
        'packages/active/src/index.ts': 'export const ok = true;',
        'packages/legacy/package.json': JSON.stringify({ name: '@acme/legacy', main: './src/index.ts' }),
        'packages/legacy/src/index.ts': 'export const old = true;',
        'examples/demo/package.json': JSON.stringify({ name: '@acme/demo', main: './src/index.ts' }),
        'examples/demo/src/index.ts': 'export const demo = true;',
      }),
    );

    assert.deepEqual(objWorkspaces.resolveDetailed('apps/web/index.ts', '@acme/active'), {
      kind: 'file',
      path: 'packages/active/src/index.ts',
      via: 'workspace',
    });
    // Negated workspace package and undeclared nested package.json are not workspace packages
    assert.deepEqual(objWorkspaces.resolveDetailed('apps/web/index.ts', '@acme/legacy'), {
      kind: 'unresolved',
      reason: 'unmatched',
      reasonCode: 'unknown-package',
    });
    assert.deepEqual(objWorkspaces.resolveDetailed('apps/web/index.ts', '@acme/demo'), {
      kind: 'unresolved',
      reason: 'unmatched',
      reasonCode: 'unknown-package',
    });
    // Declared external vs undeclared external
    assert.deepEqual(objWorkspaces.resolveDetailed('apps/web/index.ts', 'react'), {
      kind: 'external',
    });
    assert.deepEqual(objWorkspaces.resolveDetailed('apps/web/index.ts', 'undeclared-npm-pkg'), {
      kind: 'unresolved',
      reason: 'unmatched',
      reasonCode: 'unknown-package',
    });

    // 2. pnpm-workspace.yaml with comments, negation, and catalog dependencies
    const pnpmWorkspaces = new ImportResolver(
      memoryRepo({
        'pnpm-workspace.yaml': [
          '# pnpm workspace config',
          'packages:',
          '  - "packages/*"',
          "  - 'apps/*'",
          '  - "!packages/ignored"',
          'catalog:',
          '  zod: ^3.23.0',
        ].join('\n'),
        'packages/core/package.json': JSON.stringify({
          name: '@pnpm-monorepo/core',
          exports: './src/index.ts',
        }),
        'packages/core/src/index.ts': 'export const core = 1;',
        'packages/ignored/package.json': JSON.stringify({
          name: '@pnpm-monorepo/ignored',
          exports: './src/index.ts',
        }),
        'packages/ignored/src/index.ts': 'export const ignored = 1;',
      }),
    );

    assert.deepEqual(pnpmWorkspaces.resolveDetailed('apps/web/app.ts', '@pnpm-monorepo/core'), {
      kind: 'file',
      path: 'packages/core/src/index.ts',
      via: 'exports',
    });
    assert.deepEqual(pnpmWorkspaces.resolveDetailed('apps/web/app.ts', '@pnpm-monorepo/ignored'), {
      kind: 'unresolved',
      reason: 'unmatched',
      reasonCode: 'unknown-package',
    });
    assert.deepEqual(pnpmWorkspaces.resolveDetailed('apps/web/app.ts', 'zod'), {
      kind: 'external',
    });

    // 3. lerna.json workspace discovery
    const lernaWorkspaces = new ImportResolver(
      memoryRepo({
        'lerna.json': JSON.stringify({ packages: ['modules/*'] }),
        'modules/auth/package.json': JSON.stringify({ name: '@lerna-repo/auth', module: 'src/index.ts' }),
        'modules/auth/src/index.ts': 'export const auth = true;',
      }),
    );
    assert.deepEqual(lernaWorkspaces.resolveDetailed('src/main.ts', '@lerna-repo/auth'), {
      kind: 'file',
      path: 'modules/auth/src/index.ts',
      via: 'workspace',
    });
  });

  it('reports ambiguous-package on duplicate workspace package names and unsupported-config on conflicting/malformed manifests', () => {
    const duplicateResolver = new ImportResolver(
      memoryRepo({
        'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
        'packages/a/package.json': JSON.stringify({ name: '@acme/dup', exports: './src/index.ts' }),
        'packages/a/src/index.ts': 'export const a = 1;',
        'packages/b/package.json': JSON.stringify({ name: '@acme/dup', exports: './src/index.ts' }),
        'packages/b/src/index.ts': 'export const b = 2;',
      }),
    );

    assert.deepEqual(duplicateResolver.resolveDetailed('src/app.ts', '@acme/dup'), {
      kind: 'unresolved',
      reason: 'unmatched',
      reasonCode: 'ambiguous-package',
    });

    // Conflicting workspace manifests (package.json vs pnpm-workspace.yaml disagreeing on packages/only-pnpm)
    const conflictingResolver = new ImportResolver(
      memoryRepo({
        'package.json': JSON.stringify({ workspaces: ['packages/shared'] }),
        'pnpm-workspace.yaml': 'packages:\n  - packages/shared\n  - packages/only-pnpm\n',
        'packages/shared/package.json': JSON.stringify({ name: '@acme/shared', exports: './src/index.ts' }),
        'packages/shared/src/index.ts': 'export const shared = 1;',
        'packages/only-pnpm/package.json': JSON.stringify({ name: '@acme/only-pnpm', exports: './src/index.ts' }),
        'packages/only-pnpm/src/index.ts': 'export const onlyPnpm = 1;',
      }),
    );

    assert.deepEqual(conflictingResolver.resolveDetailed('src/app.ts', '@acme/only-pnpm'), {
      kind: 'unresolved',
      reason: 'unmatched',
      reasonCode: 'unsupported-config',
    });

    // Malformed exports mixing '.' subpath keys and condition keys at top level
    const invalidExportsResolver = new ImportResolver(
      memoryRepo({
        'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
        'packages/bad/package.json': JSON.stringify({
          name: '@acme/bad',
          exports: { '.': './src/index.ts', import: './src/esm.ts' },
        }),
        'packages/bad/src/index.ts': '',
      }),
    );
    assert.deepEqual(invalidExportsResolver.resolveDetailed('src/app.ts', '@acme/bad'), {
      kind: 'unresolved',
      reason: 'unmatched',
      reasonCode: 'unsupported-config',
    });
  });

  it('enforces exports encapsulation, PATTERN_KEY_COMPARE specificity, and null target blocking', () => {
    const resolver = new ImportResolver(
      memoryRepo({
        'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
        'packages/pkg/package.json': JSON.stringify({
          name: '@acme/pkg',
          main: './src/index.ts',
          exports: {
            '.': './src/index.ts',
            './features/*': './src/features/*.ts',
            './features/internal/*': null,
            './*.js': './src/js/*.ts',
            './*': './src/wild/*.ts',
            './cjs-blocked': {
              require: null,
              default: './src/cjs-blocked.ts',
            },
          },
        }),
        'packages/pkg/src/index.ts': 'export const root = 1;',
        'packages/pkg/src/secret.ts': 'export const secret = 1;',
        'packages/pkg/src/features/login.ts': 'export const login = 1;',
        'packages/pkg/src/features/internal/token.ts': 'export const token = 1;',
        'packages/pkg/src/wild/features/internal/token.ts': 'export const fallbackToken = 1;',
        'packages/pkg/src/js/item.ts': 'export const jsItem = 1;',
        'packages/pkg/src/wild/item.js.ts': 'export const wildItem = 1;',
        'packages/pkg/src/wild/plain.ts': 'export const plain = 1;',
        'packages/pkg/src/cjs-blocked.ts': 'export const blocked = 1;',
      }),
    );

    // Longer prefix before '*' wins: './features/*' beats './*'
    assert.deepEqual(resolver.resolveDetailed('src/a.ts', '@acme/pkg/features/login'), {
      kind: 'file',
      path: 'packages/pkg/src/features/login.ts',
      via: 'exports',
    });

    // Tied prefix before '*': longer suffix after '*' wins ('./*.js' beats './*')
    assert.deepEqual(resolver.resolveDetailed('src/a.ts', '@acme/pkg/item.js'), {
      kind: 'file',
      path: 'packages/pkg/src/js/item.ts',
      via: 'exports',
    });
    assert.deepEqual(resolver.resolveDetailed('src/a.ts', '@acme/pkg/plain'), {
      kind: 'file',
      path: 'packages/pkg/src/wild/plain.ts',
      via: 'exports',
    });

    // More specific pattern './features/internal/*' mapping to `null` blocks less-specific './*'
    assert.deepEqual(resolver.resolveDetailed('src/a.ts', '@acme/pkg/features/internal/token'), {
      kind: 'unresolved',
      reason: 'unmatched',
      reasonCode: 'not-exported',
    });

    // Condition mapping to `null` blocks `default` fallback
    assert.deepEqual(resolver.resolveDetailed('src/a.ts', '@acme/pkg/cjs-blocked', 'require'), {
      kind: 'unresolved',
      reason: 'unmatched',
      reasonCode: 'not-exported',
    });
    assert.deepEqual(resolver.resolveDetailed('src/a.ts', '@acme/pkg/cjs-blocked', 'import'), {
      kind: 'file',
      path: 'packages/pkg/src/cjs-blocked.ts',
      via: 'exports',
    });

    // Encapsulation: when `exports` has only '.', deep subpath './secret' is not-exported even if src/secret.ts exists
    const encapsulated = new ImportResolver(
      memoryRepo({
        'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
        'packages/strict/package.json': JSON.stringify({
          name: '@acme/strict',
          main: './src/index.ts',
          exports: { '.': './src/index.ts' },
        }),
        'packages/strict/src/index.ts': '',
        'packages/strict/src/secret.ts': '',
      }),
    );
    assert.deepEqual(encapsulated.resolveDetailed('src/a.ts', '@acme/strict/secret'), {
      kind: 'unresolved',
      reason: 'unmatched',
      reasonCode: 'not-exported',
    });
  });

  it('orders conditions correctly: default last, configured vs heuristic source, and type-only exports', () => {
    // 1. `default` never overrides a more specific matching condition even if listed first;
    //    `source` is heuristic fallback when not in tsconfig customConditions
    const baseFiles: Record<string, string> = {
      'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
      'packages/cond/package.json': JSON.stringify({
        name: '@acme/cond',
        exports: {
          '.': {
            default: './src/default.ts',
            import: './src/import.ts',
            require: './src/require.ts',
          },
          './source-only': {
            source: './src/from-source.ts',
            import: './dist/missing-built.js',
          },
          './types-only': {
            types: './src/types-only.d.ts',
          },
        },
      }),
      'packages/cond/src/default.ts': '',
      'packages/cond/src/import.ts': '',
      'packages/cond/src/require.ts': '',
      'packages/cond/src/from-source.ts': '',
      'packages/cond/src/types-only.d.ts': 'export interface T {}',
      'src/app.ts': 'import type { T } from "@acme/cond/types-only";\nexport {};\n',
      'src/runtime.ts': 'import { T } from "@acme/cond/types-only";\nexport { T };\n',
    };

    const unconfiguredResolver = new ImportResolver(memoryRepo(baseFiles));
    assert.deepEqual(unconfiguredResolver.resolveDetailed('src/app.ts', '@acme/cond', 'import'), {
      kind: 'file',
      path: 'packages/cond/src/import.ts',
      via: 'exports',
    });
    assert.deepEqual(unconfiguredResolver.resolveDetailed('src/app.ts', '@acme/cond', 'require'), {
      kind: 'file',
      path: 'packages/cond/src/require.ts',
      via: 'exports',
    });
    // `source` used as heuristic fallback when `import` target is missing and `source` is not in customConditions
    assert.deepEqual(unconfiguredResolver.resolveDetailed('src/app.ts', '@acme/cond/source-only', 'import'), {
      kind: 'file',
      path: 'packages/cond/src/from-source.ts',
      via: 'exports',
      heuristic: true,
    });
    // `types`-only export does NOT resolve for runtime import, but DOES resolve for type-only import
    assert.deepEqual(
      unconfiguredResolver.resolveDetailed('src/runtime.ts', '@acme/cond/types-only', 'import', {
        typeOnlyImport: false,
      }),
      {
        kind: 'unresolved',
        reason: 'unmatched',
        reasonCode: 'not-exported',
      },
    );
    assert.deepEqual(
      unconfiguredResolver.resolveDetailed('src/app.ts', '@acme/cond/types-only', 'import', {
        typeOnlyImport: true,
      }),
      {
        kind: 'file',
        path: 'packages/cond/src/types-only.d.ts',
        via: 'exports',
      },
    );

    // 2. When tsconfig declares `customConditions: ["source"]`, `source` is non-heuristic!
    const configuredResolver = new ImportResolver(
      memoryRepo({
        ...baseFiles,
        'tsconfig.json': JSON.stringify({
          compilerOptions: { customConditions: ['source'] },
        }),
      }),
    );
    assert.deepEqual(configuredResolver.resolveDetailed('src/app.ts', '@acme/cond/source-only', 'import'), {
      kind: 'file',
      path: 'packages/cond/src/from-source.ts',
      via: 'exports',
    });
  });

  it('prioritizes existing built targets, then tsconfig outDir/declarationDir -> rootDir, then heuristic dist -> src', () => {
    const repo = memoryRepo({
      'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
      // Package 1: built dist file actually exists in repo -> must respect dist/index.js without heuristic rewrite
      'packages/built/package.json': JSON.stringify({
        name: '@acme/built',
        exports: { '.': './dist/index.js' },
      }),
      'packages/built/dist/index.js': 'export const built = true;',
      'packages/built/src/index.ts': 'export const built = true;',

      // Package 2: tsconfig outDir & declarationDir -> rootDir mapping (non-heuristic!)
      'packages/tsconfig-mapped/package.json': JSON.stringify({
        name: '@acme/tsconfig-mapped',
        exports: {
          '.': './compiled/index.js',
          './button': './dts-out/components/button.d.ts',
        },
      }),
      'packages/tsconfig-mapped/tsconfig.json': JSON.stringify({
        compilerOptions: {
          rootDir: './source',
          outDir: './compiled',
          declarationDir: './dts-out',
        },
      }),
      'packages/tsconfig-mapped/source/index.ts': 'export const mapped = true;',
      'packages/tsconfig-mapped/source/components/button.tsx': 'export const Button = () => null;',

      // Package 3: no tsconfig outDir, dist/ is gitignored -> bounded dist/ -> src/ heuristic (heuristic: true)
      'packages/heuristic/package.json': JSON.stringify({
        name: '@acme/heuristic',
        exports: { '.': './dist/esm/index.js' },
      }),
      'packages/heuristic/src/index.ts': 'export const h = true;',
      'apps/web/main.ts': 'import { h } from "@acme/heuristic";\nexport { h };\n',
    });

    const resolver = new ImportResolver(repo);

    // 1. Existing dist/ file wins directly without heuristic flag
    assert.deepEqual(resolver.resolveDetailed('apps/web/main.ts', '@acme/built'), {
      kind: 'file',
      path: 'packages/built/dist/index.js',
      via: 'exports',
    });

    // 2. Tsconfig outDir/declarationDir -> rootDir resolves with heuristic: false
    assert.deepEqual(resolver.resolveDetailed('apps/web/main.ts', '@acme/tsconfig-mapped'), {
      kind: 'file',
      path: 'packages/tsconfig-mapped/source/index.ts',
      via: 'exports',
    });
    assert.deepEqual(resolver.resolveDetailed('apps/web/main.ts', '@acme/tsconfig-mapped/button'), {
      kind: 'file',
      path: 'packages/tsconfig-mapped/source/components/button.tsx',
      via: 'exports',
    });

    // 3. Heuristic dist/esm/ -> src/ sets heuristic: true and explain() notes it
    assert.deepEqual(resolver.resolveDetailed('apps/web/main.ts', '@acme/heuristic'), {
      kind: 'file',
      path: 'packages/heuristic/src/index.ts',
      via: 'exports',
      heuristic: true,
    });
    const classifier = new RelationshipClassifier(repo);
    assert.equal(classifier.classify('apps/web/main.ts', 'packages/heuristic/src/index.ts'), 'direct');
    assert.match(
      classifier.explain('apps/web/main.ts', 'packages/heuristic/src/index.ts', 'direct'),
      /via heuristic source remap/,
    );
  });

  it('resolves package.json#imports (#...) including wildcards, conditions, null blocking, workspace/external targets, recursion, and cycles', () => {
    const resolver = new ImportResolver(
      memoryRepo({
        'package.json': JSON.stringify({
          workspaces: ['packages/*'],
          dependencies: { lodash: '^4.17.21' },
        }),
        'packages/ui/package.json': JSON.stringify({
          name: '@acme/ui',
          exports: { './*': './src/*.tsx' },
        }),
        'packages/ui/src/button.tsx': 'export const Button = 1;',
        'packages/app/package.json': JSON.stringify({
          name: '@acme/app',
          imports: {
            '#db': './src/db/client.ts',
            '#env': {
              import: './src/env.esm.ts',
              require: './src/env.cjs.ts',
            },
            '#internal/*': './src/internal/*.ts',
            '#internal/secret/*': null,
            '#ui/*': '@acme/ui/*',
            '#lodash': 'lodash',
            '#undeclared': 'not-installed-pkg',
            '#alias-to-db': '#db',
            '#cycle-a': '#cycle-b',
            '#cycle-b': '#cycle-a',
            '#escape': '../ui/src/button.tsx',
          },
        }),
        'packages/app/src/index.ts': '',
        'packages/app/src/db/client.ts': 'export const db = {};',
        'packages/app/src/env.esm.ts': 'export const env = "esm";',
        'packages/app/src/env.cjs.ts': 'export const env = "cjs";',
        'packages/app/src/internal/auth.ts': 'export const auth = true;',
        'packages/app/src/internal/secret/key.ts': 'export const key = "secret";',
      }),
    );

    const from = 'packages/app/src/index.ts';

    // Exact #imports
    assert.deepEqual(resolver.resolveDetailed(from, '#db'), {
      kind: 'file',
      path: 'packages/app/src/db/client.ts',
      via: 'imports',
    });

    // Conditional #imports
    assert.deepEqual(resolver.resolveDetailed(from, '#env', 'import'), {
      kind: 'file',
      path: 'packages/app/src/env.esm.ts',
      via: 'imports',
    });
    assert.deepEqual(resolver.resolveDetailed(from, '#env', 'require'), {
      kind: 'file',
      path: 'packages/app/src/env.cjs.ts',
      via: 'imports',
    });

    // Wildcard #imports and null blocking
    assert.deepEqual(resolver.resolveDetailed(from, '#internal/auth'), {
      kind: 'file',
      path: 'packages/app/src/internal/auth.ts',
      via: 'imports',
    });
    assert.deepEqual(resolver.resolveDetailed(from, '#internal/secret/key'), {
      kind: 'unresolved',
      reason: 'unmatched',
      reasonCode: 'not-exported',
    });
    assert.deepEqual(resolver.resolveDetailed(from, '#unmapped'), {
      kind: 'unresolved',
      reason: 'unmatched',
      reasonCode: 'not-exported',
    });

    // Target pointing to workspace package
    assert.deepEqual(resolver.resolveDetailed(from, '#ui/button'), {
      kind: 'file',
      path: 'packages/ui/src/button.tsx',
      via: 'imports',
    });

    // Target pointing to declared external package vs unknown package
    assert.deepEqual(resolver.resolveDetailed(from, '#lodash'), {
      kind: 'external',
      via: 'imports',
    });
    assert.deepEqual(resolver.resolveDetailed(from, '#undeclared'), {
      kind: 'unresolved',
      reason: 'unmatched',
      reasonCode: 'unknown-package',
    });

    // Recursive #imports (#alias-to-db -> #db)
    assert.deepEqual(resolver.resolveDetailed(from, '#alias-to-db'), {
      kind: 'file',
      path: 'packages/app/src/db/client.ts',
      via: 'imports',
    });

    // Cycle detection (#cycle-a -> #cycle-b -> #cycle-a)
    assert.deepEqual(resolver.resolveDetailed(from, '#cycle-a'), {
      kind: 'unresolved',
      reason: 'unmatched',
      reasonCode: 'invalid-target',
    });

    // Escaping package directory via ../ in #imports
    assert.deepEqual(resolver.resolveDetailed(from, '#escape'), {
      kind: 'unresolved',
      reason: 'unmatched',
      reasonCode: 'invalid-target',
    });
  });

  it('rejects path traversal and symlink targets escaping package or repository boundaries as invalid-target', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ra09-symlink-'));
    try {
      mkdirSync(join(tmp, 'packages/pkg-a/src'), { recursive: true });
      mkdirSync(join(tmp, 'packages/pkg-b/src'), { recursive: true });

      writeFileSync(
        join(tmp, 'package.json'),
        JSON.stringify({ workspaces: ['packages/*'] }),
      );
      writeFileSync(
        join(tmp, 'packages/pkg-a/package.json'),
        JSON.stringify({
          name: '@acme/pkg-a',
          exports: {
            './escape-dots': '../pkg-b/src/secret.ts',
            './symlink-file': './src/link-to-b.ts',
            './symlink-dir/*': './src/linked-dir/*.ts',
          },
        }),
      );
      writeFileSync(join(tmp, 'packages/pkg-a/src/index.ts'), 'export const a = 1;\n');
      writeFileSync(join(tmp, 'packages/pkg-b/src/secret.ts'), 'export const secret = 2;\n');

      // Symlink file and symlink directory pointing out of pkg-a into pkg-b
      symlinkSync(join(tmp, 'packages/pkg-b/src/secret.ts'), join(tmp, 'packages/pkg-a/src/link-to-b.ts'));
      symlinkSync(join(tmp, 'packages/pkg-b/src'), join(tmp, 'packages/pkg-a/src/linked-dir'));

      const tracked = new Set([
        'package.json',
        'packages/pkg-a/package.json',
        'packages/pkg-a/src/index.ts',
        'packages/pkg-a/src/link-to-b.ts',
        'packages/pkg-a/src/linked-dir/secret.ts',
        'packages/pkg-b/src/secret.ts',
      ]);
      const files = workingTreeFiles(tmp, tracked);
      const resolver = new ImportResolver(files);

      // 1. '../' traversal out of package root
      assert.deepEqual(resolver.resolveDetailed('packages/pkg-a/src/index.ts', '@acme/pkg-a/escape-dots'), {
        kind: 'unresolved',
        reason: 'unmatched',
        reasonCode: 'invalid-target',
      });

      // 2. Symlinked file inside package
      assert.deepEqual(resolver.resolveDetailed('packages/pkg-a/src/index.ts', '@acme/pkg-a/symlink-file'), {
        kind: 'unresolved',
        reason: 'unmatched',
        reasonCode: 'invalid-target',
      });

      // 3. Regular file reached through a symlinked directory that escapes pkg-a into pkg-b
      assert.deepEqual(resolver.resolveDetailed('packages/pkg-a/src/index.ts', '@acme/pkg-a/symlink-dir/secret'), {
        kind: 'unresolved',
        reason: 'unmatched',
        reasonCode: 'invalid-target',
      });

      // 4. Relative import escaping repository root
      assert.deepEqual(resolver.resolveDetailed('packages/pkg-a/src/index.ts', '../../../../outside'), {
        kind: 'unresolved',
        reason: 'unmatched',
        reasonCode: 'invalid-target',
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('resolves historical --head monorepo workspaces and exports from the commit tree rather than the dirty working tree', async () => {
    const { FixtureRepo } = await import('./helpers.js');
    const { openRepository } = await import('../src/api/index.js');
    const fixture = new FixtureRepo();
    try {
      fixture.write(
        'pnpm-workspace.yaml',
        'packages:\n  - "packages/*"\n',
      );
      fixture.write(
        'packages/shared/package.json',
        JSON.stringify({
          name: '@hist/shared',
          exports: { '.': './src/v1.ts' },
        }),
      );
      fixture.write('packages/shared/src/v1.ts', 'export const v = 1;\n');
      fixture.write('packages/shared/src/v2.ts', 'export const v = 2;\n');
      fixture.write(
        'packages/app/package.json',
        JSON.stringify({
          name: '@hist/app',
          imports: { '#helper': './src/helper-v1.ts' },
        }),
      );
      fixture.write('packages/app/src/helper-v1.ts', 'export const h = 1;\n');
      fixture.write('packages/app/src/helper-v2.ts', 'export const h = 2;\n');
      fixture.write(
        'packages/app/src/main.ts',
        'import { v } from "@hist/shared";\nimport { h } from "#helper";\nexport { v, h };\n',
      );
      fixture.git('add', '.');
      fixture.commit({ message: 'v1 monorepo layout', author: 'Alice' });
      fixture.git('tag', 'v1');

      // Mutate working tree and commit v2 where exports and #imports point to v2 files and workspaces exclude shared
      fixture.write(
        'pnpm-workspace.yaml',
        'packages:\n  - "packages/*"\n  - "!packages/shared"\n',
      );
      fixture.write(
        'packages/shared/package.json',
        JSON.stringify({
          name: '@hist/shared',
          exports: { '.': './src/v2.ts' },
        }),
      );
      fixture.write(
        'packages/app/package.json',
        JSON.stringify({
          name: '@hist/app',
          imports: { '#helper': './src/helper-v2.ts' },
        }),
      );
      fixture.git('add', '.');
      fixture.commit({ message: 'v2 monorepo layout', author: 'Alice' });

      const histSession = await openRepository({ cwd: fixture.dir, head: 'v1' });
      try {
        const graph = await histSession.importGraph();
        assert.deepEqual(graph.edges, [
          {
            from: 'packages/app/src/main.ts',
            to: 'packages/app/src/helper-v1.ts',
            specifier: '#helper',
            kind: 'static',
            via: 'imports',
          },
          {
            from: 'packages/app/src/main.ts',
            to: 'packages/shared/src/v1.ts',
            specifier: '@hist/shared',
            kind: 'static',
            via: 'exports',
          },
        ]);
        assert.equal(graph.meta.imports?.scope, 'repository');
        assert.equal(graph.meta.imports?.unresolved, 0);
      } finally {
        await histSession.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('caches workspace manifests and tsconfig across large monorepos (50 workspace packages, 1,000 imports)', () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({
        name: 'large-monorepo',
        private: true,
        workspaces: ['packages/*'],
        dependencies: { react: '^18.0.0' },
      }),
      'tsconfig.base.json': JSON.stringify({
        compilerOptions: {
          customConditions: ['source'],
        },
      }),
      'tsconfig.json': JSON.stringify({
        extends: './tsconfig.base.json',
      }),
    };

    const readCounts = new Map<string, number>();
    for (let i = 0; i < 50; i++) {
      const pkgDir = `packages/pkg-${i}`;
      files[`${pkgDir}/package.json`] = JSON.stringify({
        name: `@large/pkg-${i}`,
        exports: {
          '.': {
            source: './src/index.ts',
            import: './dist/index.js',
          },
          './utils/*': './src/utils/*.ts',
        },
      });
      files[`${pkgDir}/src/index.ts`] = `export const id = ${i};\n`;
      files[`${pkgDir}/src/utils/math.ts`] = `export const add = (a: number, b: number) => a + b + ${i};\n`;
    }

    const trackedRepo: RepoFiles = {
      exists: (p) => p in files,
      read: (p) => {
        readCounts.set(p, (readCounts.get(p) ?? 0) + 1);
        return files[p];
      },
      list: () => Object.keys(files),
    };

    const resolver = new ImportResolver(trackedRepo);
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      const targetPkg = i % 50;
      const fromPkg = (i + 1) % 50;
      const fromFile = `packages/pkg-${fromPkg}/src/index.ts`;
      const spec = i % 2 === 0 ? `@large/pkg-${targetPkg}` : `@large/pkg-${targetPkg}/utils/math`;
      const res = resolver.resolveDetailed(fromFile, spec);
      assert.equal(res.kind, 'file');
    }
    const elapsedMs = performance.now() - start;

    // Each package.json and tsconfig.json must be read at most once despite 1,000 resolutions
    assert.equal(readCounts.get('package.json'), 1);
    assert.equal(readCounts.get('tsconfig.json'), 1);
    assert.equal(readCounts.get('tsconfig.base.json'), 1);
    for (let i = 0; i < 50; i++) {
      assert.equal(readCounts.get(`packages/pkg-${i}/package.json`), 1);
    }
    assert.ok(elapsedMs < 1000, `Expected 1,000 monorepo resolutions in <1000ms, took ${elapsedMs.toFixed(1)}ms`);
  });
});

