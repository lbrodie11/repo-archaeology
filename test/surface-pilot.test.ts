/**
 * RA-18 research harness: the mutation generator, the oracle, the preregistration order
 * and the report generator (docs/research/surface-pilot.md).
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { surfaceDelta } from '../src/surface/delta.js';
import { extractSurface } from '../src/surface/extract.js';
import { applyEdits, generateMutations, NEGATIVE_KINDS, POSITIVE_KINDS } from '../scripts/surface-pilot/mutate.js';
import { Oracle } from '../scripts/surface-pilot/oracle.js';
import { memoryFiles } from './helpers.js';

const ROOT = join(import.meta.dirname, '..');

const FIXTURE: Record<string, string> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
  'src/math.ts': [
    'export function add(a: number, b: number) { return a + b; }',
    'export function sub(a: number, b: number) { return a - b; }',
    'export interface Point { x: number; y?: number }',
    'export type Size = { w: number };',
    'export interface Unused { z: number }',
    'function helper() { return 1; }',
    'function twice(n: number) { return n * 2; }',
    'const local = twice(2);',
    'export const mul = (a: number, b: number) => a * b + local;',
    'export { helper as help };',
    '',
  ].join('\n'),
  'src/geo.ts': [
    "import { add, sub, mul, help, type Point, type Size } from './math';",
    'export function area(s: Size, p: Point) { return mul(s.w, add(p.x, sub(1, help()))); }',
    'export const origin: Point = { x: 0 };',
    '',
  ].join('\n'),
  'src/app.ts': "import { area, origin } from './geo';\nexport function main() { return area({ w: 1 }, origin); }\n",
  'src/legacy.js': 'function run(a) { return a; }\nfunction other() { return 2; }\nconst hidden = 3;\nmodule.exports = { run, other };\n',
  'src/caller.js': "const { run, other } = require('./legacy');\nrun(other());\n",
};

describe('mutation generator', () => {
  const files = memoryFiles(FIXTURE);
  const generate = (seed: number) => generateMutations(files, new Oracle(files), { prefix: 't', seed, positives: 9, negatives: 12 });

  it('is deterministic for a fixed seed', () => {
    const a = generate(7);
    const b = generate(7);
    assert.deepEqual(a, b);
    assert.ok(a.mutations.length > 0);
    assert.notDeepEqual(generate(8).mutations.map((m) => m.id + m.file + m.name), a.mutations.map((m) => m.id + m.file + m.name), 'another seed picks differently');
  });

  it('gives every positive at least one ground-truth consumer before mutation', () => {
    const { mutations } = generate(7);
    const positives = mutations.filter((m) => m.class === 'positive');
    assert.ok(positives.length >= 6, `positives: ${positives.length}`);
    for (const kind of POSITIVE_KINDS) assert.ok(positives.some((m) => m.kind === kind), `has a ${kind}`);
    for (const m of positives) {
      assert.ok(m.oracleConsumers.length >= 1, `${m.id} ${m.kind} ${m.name}`);
      assert.ok(!m.oracleConsumers.includes(m.file));
    }
    assert.ok(!positives.some((m) => m.name === 'Unused'), 'an export without consumers is never a positive');
  });

  it('negative controls preserve the surface (property test over seeds)', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 15; seed++) {
      for (const m of generate(seed).mutations.filter((x) => x.class === 'negative')) {
        seen.add(m.kind);
        const before = extractSurface(m.file, FIXTURE[m.file]!);
        const after = extractSurface(m.file, applyEdits(FIXTURE[m.file]!, m.edits));
        assert.equal(after.status, 'known', `${m.kind} ${m.file}: ${after.reason}`);
        const delta = surfaceDelta(m.file, before, after);
        const expected = m.kind === 'add-export' ? [['__seededExport', 'added']] : [];
        assert.deepEqual(delta.entries.map((e) => [e.name, e.change]), expected, `${m.kind} ${m.file} ${m.name}`);
        if (m.kind !== 'add-export' && m.kind !== 'add-optional-param') {
          assert.deepEqual(after.exports.map((e) => e.name), before.exports.map((e) => e.name), `${m.kind} ${m.file} ${m.name}`);
        }
      }
    }
    assert.deepEqual([...seen].sort(), [...NEGATIVE_KINDS].sort(), 'every negative kind was exercised');
  });

  it('positives change the surface as intended', () => {
    for (const m of generate(3).mutations.filter((x) => x.class === 'positive')) {
      const before = extractSurface(m.file, FIXTURE[m.file]!);
      const after = extractSurface(m.file, applyEdits(FIXTURE[m.file]!, m.edits));
      const b = before.exports.find((e) => e.name === m.name);
      const a = after.exports.find((e) => e.name === m.name);
      assert.ok(b, `${m.id} exported before`);
      if (m.kind === 'remove-export') assert.equal(a, undefined, `${m.id} ${m.name} removed`);
      if (m.kind === 'add-required-param') assert.equal(a!.params!.required, b.params!.required + 1, `${m.id} ${m.name}`);
      if (m.kind === 'add-required-prop') assert.ok(a!.requiredProps!.includes('__seeded'), `${m.id} ${m.name}`);
    }
  });
});
