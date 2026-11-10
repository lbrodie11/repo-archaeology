/**
 * RA-18 surface pilot: export surface, delta, consumers and compiler coverage.
 * Research-only module (`src/surface/`); nothing here is part of the v1 contract.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { analyzeSurfaceChange, analyzeTrees, type TreeChange } from '../src/surface/analyze.js';
import { CompilerCoverageIndex } from '../src/surface/coverage.js';
import { surfaceDelta } from '../src/surface/delta.js';
import { extractBindings, extractSurface } from '../src/surface/extract.js';
import type { SurfaceAnalysis, SurfaceExport } from '../src/surface/types.js';
import { FixtureRepo, memoryFiles } from './helpers.js';

const ROOT = join(import.meta.dirname, '..');

function byName(file: string, text: string): Record<string, SurfaceExport> {
  const surface = extractSurface(file, text);
  assert.equal(surface.status, 'known', surface.reason);
  return Object.fromEntries(surface.exports.map((e) => [e.name, e]));
}

/** Runs the analysis over two in-memory trees; the diff is computed from the maps. */
function analyze(base: Record<string, string>, head: Record<string, string>): SurfaceAnalysis {
  const diff: TreeChange[] = [];
  for (const path of new Set([...Object.keys(base), ...Object.keys(head)])) {
    if (!(path in head)) diff.push({ path, deleted: true });
    else if (!(path in base)) diff.push({ path, deleted: false, added: true });
    else if (base[path] !== head[path]) diff.push({ path, deleted: false });
  }
  return analyzeTrees({ base: 'base', head: 'head', diff, baseFiles: memoryFiles(base), headFiles: memoryFiles(head) });
}

function statuses(result: SurfaceAnalysis): Record<string, string> {
  return Object.fromEntries(result.consumers.map((c) => [c.consumer, c.uses[0]!.reason ? `${c.status}:${c.uses[0]!.reason}` : c.status]));
}

describe('surface extraction', () => {
  it('reads named, default and aliased exports with their kinds', () => {
    const e = byName('a.ts', `
      export function f(a: string, b?: number) {}
      export class C {}
      export const v = 1, w = 2;
      export let l = 1;
      export interface I { a: string; b?: number; m(): void }
      export type T = { x: string; y?: string };
      export type U = string | number;
      export enum E { A }
      export namespace N { export const z = 1; }
      const local = (x: number, y: number) => x + y;
      function g(this: Window, a: string) {}
      export { local as aliased, g };
      export default function (x: string, ...rest: string[]) {}
    `);
    assert.deepEqual(Object.keys(e).sort(), ['C', 'E', 'I', 'N', 'T', 'U', 'aliased', 'default', 'f', 'g', 'l', 'v', 'w']);
    assert.deepEqual(e.f, { name: 'f', kind: 'function', params: { required: 1, total: 2, rest: false } });
    assert.equal(e.C!.kind, 'class');
    assert.equal(e.v!.kind, 'variable');
    assert.equal(e.l!.kind, 'variable');
    assert.deepEqual(e.I!.requiredProps, ['a', 'm']);
    assert.deepEqual(e.T!.requiredProps, ['x']);
    assert.equal(e.U!.requiredProps, undefined);
    assert.equal(e.E!.kind, 'enum');
    assert.equal(e.N!.kind, 'namespace');
    assert.deepEqual(e.aliased, { name: 'aliased', kind: 'variable', params: { required: 2, total: 2, rest: false } });
    assert.deepEqual(e.g!.params, { required: 1, total: 1, rest: false }, 'a `this` parameter is not counted');
    assert.deepEqual(e.default, { name: 'default', kind: 'function', params: { required: 1, total: 2, rest: true } });
  });

  it('resolves default class, default expression and default identifier', () => {
    assert.equal(byName('a.ts', 'export default class {}').default!.kind, 'class');
    assert.equal(byName('a.ts', 'export default { a: 1 }').default!.kind, 'variable');
    assert.deepEqual(byName('a.ts', 'export default (a: string) => a').default!.params, { required: 1, total: 1, rest: false });
    assert.deepEqual(byName('a.ts', 'function h(a, b) {}\nexport default h;').default, { name: 'default', kind: 'function', params: { required: 2, total: 2, rest: false } });
  });

  it('records export * and export * as ns as opaque', () => {
    const surface = extractSurface('index.ts', `export * from './a';\nexport * as ns from './b';\nexport { x as y } from './c';`);
    assert.equal(surface.status, 'known');
    assert.deepEqual(surface.opaque, [{ specifier: './a' }, { specifier: './b', namespace: 'ns' }]);
    assert.deepEqual(surface.exports, [
      { name: 'ns', kind: 're-export', from: './b', importedName: '*' },
      { name: 'y', kind: 're-export', from: './c', importedName: 'x' },
    ]);
  });

  it('marks type-only exports and counts overloads once with the minimum required parameters', () => {
    const e = byName('a.ts', `
      interface Hidden { a: string }
      export type { Hidden };
      export { type Other } from './o';
      export function over(a: string): void;
      export function over(a: string, b: number): void;
      export function over(a: string, b?: number, c?: boolean) {}
      export const arrow = async (a: string, b = 1) => a;
      export const fn = function (a, b, c) {};
    `);
    assert.equal(e.Hidden!.typeOnly, true);
    assert.equal(e.Hidden!.kind, 'interface');
    assert.equal(e.Other!.typeOnly, true);
    assert.deepEqual(e.over!.params, { required: 1, total: 2, rest: false }, 'the implementation signature is not visible');
    assert.deepEqual(e.arrow!.params, { required: 1, total: 2, rest: false });
    assert.deepEqual(e.fn!.params, { required: 3, total: 3, rest: false });
  });

  it('reads CommonJS objects and property assignments', () => {
    const object = byName('a.js', `
      const { helper } = require('./helper');
      function run(a, b) {}
      class K {}
      module.exports = { run, K, helper, inline(x) {}, value: 1, renamed: run, sub: require('./sub').thing };
    `);
    assert.deepEqual(object.run, { name: 'run', kind: 'function', params: { required: 2, total: 2, rest: false } });
    assert.equal(object.K!.kind, 'class');
    assert.deepEqual(object.helper, { name: 'helper', kind: 're-export', from: './helper', importedName: 'helper' });
    assert.deepEqual(object.inline!.params, { required: 1, total: 1, rest: false });
    assert.equal(object.value!.kind, 'variable');
    assert.equal(object.renamed!.kind, 'function');
    assert.deepEqual(object.sub, { name: 'sub', kind: 're-export', from: './sub', importedName: 'thing' });
    const props = byName('b.js', 'exports.a = function (x) {};\nmodule.exports.b = 2;\nfunction inner() { return exports; }'.replace('\nfunction inner() { return exports; }', ''));
    assert.deepEqual(Object.keys(props), ['a', 'b']);
    assert.equal(extractSurface('c.js', 'module.exports.a = 1;').module, 'cjs');
  });

  it('makes every other CommonJS form unknown', () => {
    for (const text of [
      'module.exports = function () {};',
      'module.exports = require("./x");',
      'module.exports = { ...other };',
      'module.exports = { [key]: 1 };',
      'module.exports = {};\nmodule.exports = {};',
      'if (x) { module.exports.a = 1; }',
      'Object.defineProperty(exports, "a", { value: 1 });',
      'exports = module.exports = {};',
      'export = foo;',
    ]) {
      assert.equal(extractSurface(text.startsWith('export =') ? 'a.ts' : 'a.js', text).status, 'unknown', text);
    }
    assert.equal(extractSurface('a.ts', 'const exports = 1; export const a = exports;').status, 'known', 'a local named exports is not CommonJS');
    assert.equal(extractSurface('a.js', 'const x = pkg.exports;').status, 'known');
  });
});

describe('surface delta', () => {
  const delta = (before: string, after: string) => surfaceDelta('a.ts', extractSurface('a.ts', before), extractSurface('a.ts', after));

  it('reports removal and addition, never a rename', () => {
    const d = delta('export function a() {}', 'export function b() {}');
    assert.deepEqual(d.entries.map((e) => [e.name, e.change]), [['a', 'removed'], ['b', 'added']]);
  });

  it('reports kind changes and required-parameter increases, not optional parameters', () => {
    assert.deepEqual(delta('export function f() {}', 'export const f = 1;').entries.map((e) => e.reasons), [['kind-changed']]);
    assert.deepEqual(delta('export function f(a) {}', 'export function f(a, b) {}').entries.map((e) => e.reasons), [['required-params-increased']]);
    assert.deepEqual(delta('export function f(a) {}', 'export function f(a, b?: string) {}').entries, []);
    assert.deepEqual(delta('export function f(a) {}', 'export function f(a, ...b: string[]) {}').entries, []);
    assert.deepEqual(delta('export function f(a, b) {}', 'export function f(a) {}').entries, [], 'fewer required parameters is not a change');
  });

  it('reports required properties added and removed on interfaces', () => {
    const added = delta('export interface I { a: string }', 'export interface I { a: string; b: number; c?: number }').entries[0]!;
    assert.deepEqual([added.reasons, added.propsAdded], [['required-props-added'], ['b']]);
    const removed = delta('export interface I { a: string; b: number }', 'export interface I { a: string }').entries[0]!;
    assert.deepEqual([removed.reasons, removed.propsRemoved], [['required-props-removed'], ['b']]);
  });

  it('is unknown when either side is unknown, and lists opaque changes', () => {
    const d = surfaceDelta('a.js', extractSurface('a.js', 'module.exports = { a };'), extractSurface('a.js', 'module.exports = function () {};'));
    assert.equal(d.status, 'unknown');
    const opaque = delta(`export * from './x';`, `export * from './y';`);
    assert.deepEqual([opaque.opaqueAdded, opaque.opaqueRemoved], [['./y'], ['./x']]);
  });
});

describe('surface consumers', () => {
  const lib = {
    'src/lib.ts': 'export function keep() {}\nexport function gone() {}\nexport function grow(a: string) {}\nexport default function main() {}',
  };
  const libHead = 'export function keep() {}\nexport function grow(a: string, b: string) {}\nexport default function main(a: string) {}';

  it('finds named, default and require-destructuring consumers', () => {
    const base = {
      ...lib,
      'src/named.ts': `import { gone, keep } from './lib';`,
      'src/default.ts': `import main from './lib';`,
      'src/req.js': `const { grow } = require('./lib');`,
      'src/prop.js': `const g = require('./lib').gone;`,
      'src/unrelated.ts': `import { keep } from './lib';`,
    };
    const result = analyze(base, { ...base, 'src/lib.ts': libHead });
    assert.deepEqual(result.deltas[0]!.entries.map((e) => [e.name, e.change]), [['default', 'changed'], ['gone', 'removed'], ['grow', 'changed']]);
    assert.deepEqual(statuses(result), {
      'src/default.ts': 'uses-changed-export',
      'src/named.ts': 'uses-removed-name',
      'src/prop.js': 'uses-removed-name',
      'src/req.js': 'uses-changed-export',
    });
    assert.deepEqual(result.consumers.find((c) => c.consumer === 'src/req.js')!.uses[0]!.via, 'require-destructure');
  });

  it('follows one and two barrels, and the barrels are consumers too', () => {
    const base = {
      ...lib,
      'src/index.ts': `export { gone } from './lib';`,
      'src/outer/index.ts': `export { gone as renamed } from '../index';`,
      'src/a.ts': `import { gone } from './index';`,
      'src/b.ts': `import { renamed } from './outer';`,
      'src/c.ts': `import { gone } from './lib';\nexport { gone as again };`,
      'src/d.ts': `import { again } from './c';`,
    };
    const result = analyze(base, { ...base, 'src/lib.ts': libHead });
    assert.deepEqual(statuses(result), {
      'src/a.ts': 'uses-removed-name',
      'src/b.ts': 'uses-removed-name',
      'src/c.ts': 'uses-removed-name',
      'src/d.ts': 'uses-removed-name',
      'src/index.ts': 'uses-removed-name',
      'src/outer/index.ts': 'uses-removed-name',
    });
    assert.deepEqual(result.consumers.find((c) => c.consumer === 'src/b.ts')!.uses[0]!.through, ['src/outer/index.ts', 'src/index.ts']);
  });

  it('marks namespace, dynamic, star and unresolved imports uncertain', () => {
    const base = {
      ...lib,
      'src/ns.ts': `import * as lib from './lib';`,
      'src/dyn.ts': `const lib = await import('./lib');`,
      'src/whole.js': `const lib = require('./lib');`,
      'src/star.ts': `export * from './lib';`,
      'src/via-star.ts': `import { gone } from './star';`,
      'src/missing.ts': `import { gone } from './nowhere';`,
    };
    const result = analyze(base, { ...base, 'src/lib.ts': libHead });
    assert.deepEqual(statuses(result), {
      'src/dyn.ts': 'uncertain:dynamic-import',
      'src/missing.ts': 'uncertain:unresolved-specifier',
      'src/ns.ts': 'uncertain:namespace-import',
      'src/via-star.ts': 'uncertain:opaque-re-export',
      'src/whole.js': 'uncertain:namespace-import',
    });
  });

  it('handles a changed file that imports itself in a cycle, and excludes changed consumers', () => {
    const base = {
      'src/a.ts': `import { b } from './b';\nexport function a() {}\nexport { a as self } from './a';`,
      'src/b.ts': `import { a } from './a';\nexport const b = 1;`,
      'src/c.ts': `import { a } from './a';`,
    };
    const result = analyze(base, {
      'src/a.ts': `import { b } from './b';\nexport { a as self } from './a';`,
      'src/b.ts': base['src/b.ts'],
      'src/c.ts': `import { a } from './a';\n// touched`,
    });
    assert.deepEqual(statuses(result), { 'src/b.ts': 'uses-removed-name' }, 'c.ts changed in the PR, a.ts is the changed file');
  });

  it('labels compiler coverage per consumer', () => {
    const base = {
      ...lib,
      'tsconfig.json': JSON.stringify({ include: ['src'], compilerOptions: { allowJs: true } }),
      'src/named.ts': `import { gone } from './lib';`,
      'src/req.js': `const { gone } = require('./lib');`,
      'scripts/tool.ts': `import { gone } from '../src/lib';`,
    };
    const result = analyze(base, { ...base, 'src/lib.ts': libHead });
    assert.deepEqual(Object.fromEntries(result.consumers.map((c) => [c.consumer, c.coverage])), {
      'scripts/tool.ts': 'not-typechecked',
      'src/named.ts': 'typechecked',
      'src/req.js': 'not-typechecked',
    });
  });

  it('runs end to end on a git repository at two commits', async () => {
    const repo = new FixtureRepo();
    try {
      repo.commit({ message: 'base', write: { ...lib, 'src/use.ts': `import { gone } from './lib';` } });
      const base = repo.git('rev-parse', 'HEAD').trim();
      repo.commit({ message: 'head', write: { 'src/lib.ts': libHead } });
      const result = await analyzeSurfaceChange(repo.dir, base, 'HEAD');
      assert.deepEqual(statuses(result), { 'src/use.ts': 'uses-removed-name' });
      assert.deepEqual(result.changedSourceFiles, ['src/lib.ts']);
    } finally {
      repo.cleanup();
    }
  });
});

describe('import bindings', () => {
  it('reads every binding form', () => {
    const { bindings } = extractBindings('a.ts', `
      import d, { a as b, type T } from './x';
      import * as ns from './y';
      import './side';
      export { c } from './z';
      export * from './w';
      export * as q from './v';
      const { r, s: t } = require('./r');
      const u = require('./u');
      const p = require('./p').prop;
      void import('./dyn');
      export { b as bee };
    `);
    const summary = bindings.map((b) => `${b.kind}:${b.specifier}:${b.imported ?? ''}:${b.exportedAs ?? ''}${b.typeOnly ? ':type' : ''}`);
    assert.deepEqual(summary, [
      'default:./x:default:',
      'named:./x:a:',
      'named:./x:T::type',
      'namespace:./y::',
      'side-effect:./side::',
      're-export:./z:c:c',
      're-export-star:./w::',
      're-export-namespace:./v::q',
      'require-destructure:./r:r:',
      'require-destructure:./r:s:',
      'require-whole:./u::',
      'require-property:./p:prop:',
      'dynamic:./dyn::',
      're-export:./x:a:bee',
    ]);
  });
});

describe('compiler coverage', () => {
  const index = (files: Record<string, string>) => new CompilerCoverageIndex(memoryFiles(files));

  it('reads include and exclude globs', () => {
    const coverage = index({
      'tsconfig.json': JSON.stringify({ include: ['src/**/*.ts'], exclude: ['src/**/*.test.ts', 'src/gen'] }),
      'src/a.ts': '', 'src/b.ts': '', 'src/a.test.ts': '', 'src/gen/x.ts': '',
    });
    assert.equal(coverage.coverage('src/b.ts', 'src/a.ts').coverage, 'typechecked');
    assert.equal(coverage.coverage('src/a.test.ts', 'src/a.ts').coverage, 'not-typechecked');
    assert.equal(coverage.coverage('src/gen/x.ts', 'src/a.ts').coverage, 'not-typechecked');
  });

  it('reads files and references', () => {
    const coverage = index({
      'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.test.json' }] }),
      'tsconfig.app.json': JSON.stringify({ files: ['src/a.ts', 'src/b.ts'] }),
      'tsconfig.test.json': JSON.stringify({ include: ['test'], references: [{ path: './tsconfig.app.json' }] }),
      'tsconfig.other.json': JSON.stringify({ include: ['other'] }),
      'src/a.ts': '', 'src/b.ts': '', 'test/t.ts': '', 'other/o.ts': '',
    });
    assert.equal(coverage.coverage('src/b.ts', 'src/a.ts').coverage, 'typechecked');
    assert.equal(coverage.coverage('test/t.ts', 'src/a.ts').coverage, 'typechecked', 'through a reference');
    assert.deepEqual(coverage.coverage('other/o.ts', 'src/a.ts'), { coverage: 'not-typechecked', reason: 'not checked together with the changed file' });
  });

  it('treats JavaScript without checkJs as not type-checked, unless // @ts-check', () => {
    const coverage = index({
      'tsconfig.json': JSON.stringify({ compilerOptions: { allowJs: true } }),
      'src/a.ts': '', 'src/b.js': '', 'src/c.js': '// @ts-check\n',
    });
    assert.deepEqual(coverage.coverage('src/b.js', 'src/a.ts'), { coverage: 'not-typechecked', reason: 'JavaScript without checkJs' });
    assert.equal(coverage.coverage('src/c.js', 'src/a.ts').coverage, 'typechecked');
    assert.equal(index({ 'jsconfig.json': JSON.stringify({ compilerOptions: { checkJs: true } }), 'a.js': '', 'b.js': '' }).coverage('a.js', 'b.js').coverage, 'typechecked');
  });

  it('is unknown when a tsconfig cannot be parsed, and outside every tsconfig otherwise', () => {
    assert.equal(index({ 'pkg/tsconfig.json': '{ "include": [', 'pkg/a.ts': '', 'pkg/b.ts': '' }).coverage('pkg/a.ts', 'pkg/b.ts').coverage, 'unknown');
    assert.deepEqual(index({ 'a.ts': '', 'b.ts': '' }).coverage('a.ts', 'b.ts'), { coverage: 'not-typechecked', reason: 'outside every tsconfig' });
    assert.equal(
      index({ 'tsconfig.json': JSON.stringify({ extends: '@tsconfig/node22', include: ['src'] }), 'src/a.js': '', 'src/b.ts': '' }).coverage('src/a.js', 'src/b.ts').coverage,
      'unknown',
      'allowJs may come from a package config that cannot be read',
    );
  });
});

describe('no regressions', () => {
  it('nothing outside src/surface imports it, so classifier and ghost-wire output cannot change', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'surface') walk(path);
        } else if (/\.ts$/.test(entry.name) && /from '\.{1,2}\/(?:\.\.\/)*surface\//.test(readFileSync(path, 'utf8'))) {
          offenders.push(path);
        }
      }
    };
    walk(join(ROOT, 'src'));
    assert.deepEqual(offenders, []);
  });

  it('src/surface is excluded from the published build', () => {
    const config = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8')) as { exclude?: string[] };
    assert.ok(config.exclude?.includes('src/surface/**'));
  });
});
