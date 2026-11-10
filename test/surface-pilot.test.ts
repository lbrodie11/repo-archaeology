/**
 * RA-18 research harness: the mutation generator, the oracle, the preregistration order
 * and the report generator (docs/research/surface-pilot.md).
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { surfaceDelta } from '../src/surface/delta.js';
import { extractSurface } from '../src/surface/extract.js';
import { applyEdits, generateMutations, NEGATIVE_KINDS, POSITIVE_KINDS } from '../scripts/surface-pilot/mutate.js';
import { Oracle } from '../scripts/surface-pilot/oracle.js';
import { computeResults, DATA_DIR, DOC, judge, loadData, renderMarkdown, replaceSection, resultsJson, verdictOf } from '../scripts/surface-pilot/report.js';
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

const shallow = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: ROOT, encoding: 'utf8' }).trim() === 'true';
  } catch {
    return true;
  }
})();

/** Oldest commit matching `git log` arguments. */
function firstCommit(args: string[]): string | undefined {
  const out = execFileSync('git', ['log', '--reverse', '--format=%H', ...args], { cwd: ROOT, encoding: 'utf8' }).trim();
  return out.split('\n')[0] || undefined;
}

describe('preregistration', () => {
  const DOC_PATH = 'docs/research/surface-pilot.md';
  const HEADING = '# RA-18 · Surface pilot (preregistration)';

  it(
    'the preregistration commit is a strict ancestor of the first commit with results, and sections 1–6 are unchanged since',
    { skip: shallow && process.env.CI !== 'true' ? 'shallow clone: no history to check' : false },
    () => {
      assert.equal(shallow, false, 'CI must check out full history (fetch-depth: 0) for this test');
      const prereg = firstCommit(['-S', HEADING, '--', DOC_PATH]);
      const data = firstCommit(['--', 'docs/research/data/surface-pilot']);
      assert.ok(prereg, 'preregistration commit found');
      assert.ok(data, 'first data commit found');
      assert.notEqual(prereg, data, 'preregistration and data must be separate commits');
      assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', prereg!, data!], { cwd: ROOT }).status, 0, `${prereg!.slice(0, 7)} must precede ${data!.slice(0, 7)}`);
      const touched = execFileSync('git', ['show', '--name-only', '--format=', prereg!], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
      assert.deepEqual(touched, [DOC_PATH], 'the preregistration commit contains only the preregistration');
      const original = execFileSync('git', ['show', `${prereg}:${DOC_PATH}`], { cwd: ROOT, encoding: 'utf8' });
      const current = execFileSync('git', ['show', `HEAD:${DOC_PATH}`], { cwd: ROOT, encoding: 'utf8' });
      const rules = (text: string) => text.slice(0, text.indexOf('\n## Results'));
      assert.equal(rules(current), rules(original), 'sections 1–6 must not change after preregistration (use Errata)');
    },
  );

  it('the verdict rule is copied verbatim from the prompt', () => {
    const doc = readFileSync(join(ROOT, DOC_PATH), 'utf8');
    for (const line of [
      '> * CORRECT if all three hold on corpus A, pooled and in each repo:',
      '>    * removal recall ≥ 0.95;',
      '>    * signature/property recall ≥ 0.90;',
      '>    * false-positive rate ≤ 0.02.',
      '> Otherwise NOT CORRECT: stop and report the failure classes.',
      '> * PASS-DESCRIBE if CORRECT, and corpus B shows a delta with ≥ 1 untouched consumer on ≥ 10% of PRs in at least one repo.',
      '> * PASS-WITNESS if PASS-DESCRIBE, and corpus B has ≥ 5 beyond-compiler `uses-removed-name` findings, of which ≥ 80% were followed by a change to that consumer within 7 days.',
      '> * INSUFFICIENT if CORRECT, but fewer than 50 PRs could be analyzed in either repo of corpus B.',
      '> * Otherwise STOP: the analysis is correct but too rarely relevant to be worth a panel.',
      "> Post-hoc interpretation goes in a separate, labeled paragraph and can't change the verdict.",
    ]) {
      assert.ok(doc.includes(line), line);
    }
  });
});

describe('report generator', () => {
  it('every number in the results section and results.json matches the committed raw records', () => {
    assert.ok(existsSync(join(DATA_DIR, 'corpus-a')) && existsSync(join(DATA_DIR, 'corpus-b')), 'raw records are committed');
    const results = computeResults(loadData());
    const doc = readFileSync(DOC, 'utf8');
    assert.equal(doc, replaceSection(doc, renderMarkdown(results)), 'run: node --import tsx scripts/surface-pilot/report.ts --write');
    assert.equal(readFileSync(join(DATA_DIR, 'results.json'), 'utf8'), resultsJson(results));
  });

  it('judges positives and negative controls exactly as preregistered', () => {
    const analysis = (deltas: unknown[], consumers: unknown[]) => ({ changedSourceFiles: ['a.ts'], deltas, consumers, skippedFiles: 0, sourceFiles: 2, parsedImporters: 1 });
    const base = { id: 'x', repo: 'r', file: 'a.ts', name: 'f', sha: '0', oracleConsumers: ['b.ts'], ms: 1 };
    const removed = { file: 'a.ts', status: 'known', fileStatus: 'modified', entries: [{ name: 'f', change: 'removed' }] };
    const use = (status: string, reason?: string) => ({ consumer: 'b.ts', status, coverage: 'typechecked', uses: [{ file: 'a.ts', name: 'f', status, via: 'named', ...(reason ? { reason } : {}) }] });
    assert.equal(judge({ ...base, class: 'positive', kind: 'remove-export', analysis: analysis([removed], [use('uses-removed-name')]) } as never).ok, true);
    assert.equal(judge({ ...base, class: 'positive', kind: 'remove-export', analysis: analysis([removed], [use('uncertain', 'namespace-import')]) } as never).failure, 'only-uncertain: namespace-import');
    const changed = { ...removed, entries: [{ name: 'f', change: 'changed', reasons: ['required-params-increased'] }] };
    assert.equal(judge({ ...base, class: 'positive', kind: 'add-required-param', analysis: analysis([changed], [use('uses-changed-export')]) } as never).ok, true);
    assert.equal(judge({ ...base, class: 'positive', kind: 'add-required-prop', analysis: analysis([changed], [use('uses-changed-export')]) } as never).ok, false, 'wrong reason');
    assert.equal(judge({ ...base, class: 'negative', kind: 'edit-body', analysis: analysis([{ ...removed, entries: [] }], [use('uncertain', 'namespace-import')]) } as never).ok, true, 'uncertain consumers are not false positives');
    assert.equal(judge({ ...base, class: 'negative', kind: 'edit-body', analysis: analysis([changed], []) } as never).ok, false);
    const added = { ...removed, entries: [{ name: '__seededExport', change: 'added' }] };
    assert.equal(judge({ ...base, name: '__seededExport', class: 'negative', kind: 'add-export', analysis: analysis([added], []) } as never).ok, true);
    assert.equal(judge({ ...base, name: '__seededExport', class: 'negative', kind: 'add-export', analysis: analysis([{ ...removed, entries: [] }], []) } as never).ok, false, 'add-export must show as added');
  });

  it('applies the verdict rule in the preregistered order', () => {
    const rate = (k: number, n: number) => ({ k, n, rate: k / n });
    const a = (removal: number, signature: number, fp: number) => ({ repo: 'r', removal: rate(removal, 100), signature: rate(signature, 100), falsePositive: rate(fp, 100) }) as never;
    const b = (analyzed: number, relevant: number, beyond: { followUp: { status: string } }[] = []) => ({ repo: 'b', analyzed, relevant: rate(relevant, analyzed), beyondCompiler: beyond }) as never;
    assert.equal(verdictOf([a(94, 95, 0)], a(94, 95, 0), [b(200, 30), b(200, 30)]).verdict, 'NOT CORRECT');
    assert.equal(verdictOf([a(95, 90, 3)], a(95, 90, 2), [b(200, 30), b(200, 30)]).verdict, 'NOT CORRECT', 'each repo, not only pooled');
    assert.equal(verdictOf([a(95, 90, 2)], a(95, 90, 2), [b(49, 30), b(200, 30)]).verdict, 'INSUFFICIENT');
    assert.equal(verdictOf([a(95, 90, 2)], a(95, 90, 2), [b(200, 19), b(200, 10)]).verdict, 'STOP');
    assert.equal(verdictOf([a(95, 90, 2)], a(95, 90, 2), [b(200, 20), b(200, 10)]).verdict, 'PASS-DESCRIBE');
    const followed = Array.from({ length: 5 }, (_, i) => ({ followUp: { status: i < 4 ? 'followed' : 'censored' } }));
    assert.equal(verdictOf([a(95, 90, 2)], a(95, 90, 2), [b(200, 20, followed), b(200, 10)]).verdict, 'PASS-WITNESS');
    followed[3]!.followUp.status = 'not-followed';
    assert.equal(verdictOf([a(95, 90, 2)], a(95, 90, 2), [b(200, 20, followed), b(200, 10)]).verdict, 'PASS-DESCRIBE');
  });
});
