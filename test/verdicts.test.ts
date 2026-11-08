import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openRepository } from '../src/api/index.js';
import { diff } from '../src/commands/diff.js';
import { explain } from '../src/commands/explain.js';
import { fileReport } from '../src/commands/file.js';
import { buildMapData } from '../src/commands/map.js';
import { scan } from '../src/commands/scan.js';
import { verdictAdd, verdictList, verdictPrune } from '../src/commands/verdict.js';
import { ConfigError } from '../src/config.js';
import { loadContext } from '../src/context.js';
import { RELATIONSHIPS } from '../src/imports/classify.js';
import {
  isGlobPattern,
  loadVerdictsFile,
  MAX_VERDICTS_BYTES,
  parseVerdictsText,
  VERDICTS_FILE,
  VERDICTS_SCHEMA_URL,
} from '../src/model/verdicts.js';
import { UsageError } from '../src/context.js';
import { renderDiffMarkdown } from '../src/report/markdown.js';
import { loadSchema, sanitizeGitEnv, validateSchemaNode } from '../scripts/schema-validator.mjs';
import { FixtureRepo } from './helpers.js';

const ROOT_DIR = join(import.meta.dirname, '..');
const SCHEMA_DIR = join(ROOT_DIR, 'schema');
const CLI = join(ROOT_DIR, 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');

function runCli(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, ['--import', TSX, CLI, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    env: sanitizeGitEnv(process.env, { NO_COLOR: '1' }),
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function assertValidSchema(value: unknown, schemaFile: string): void {
  const schema = loadSchema(SCHEMA_DIR, schemaFile);
  const errors: string[] = [];
  validateSchemaNode(SCHEMA_DIR, value, schema, schemaFile, '$', errors);
  assert.deepEqual(errors, [], `Schema validation failed for ${schemaFile}:\n${errors.join('\n')}`);
}

describe('RA-11 relationship verdicts (.repo-archaeology.verdicts.json)', () => {
  it('silences expected pairs in diff (updating silence.verdicts and silenced_by_verdicts), hides them in scan/file/map unless --show-silenced, and keeps confirmed pairs annotated without changing historical scores', async () => {
    const repo = new FixtureRepo();
    try {
      for (let i = 0; i < 4; i++) {
        repo.commit({
          message: `sync manifest and lock ${i}`,
          write: {
            'src/manifest.json': `{"v":${i}}\n`,
            'src/manifest.lock.json': `{"lock":${i}}\n`,
          },
        });
        repo.commit({
          message: `sync charge and schema ${i}`,
          write: {
            'src/billing/charge.ts': `export const charge = ${i};\n`,
            'db/schema.sql': `-- schema ${i}\n`,
          },
        });
      }

      // Baseline scan and explain scores BEFORE any verdicts exist
      const ctxBefore = await loadContext(repo.dir, {});
      const scanBefore = scan(ctxBefore, { limit: 20, kinds: [...RELATIONSHIPS] });
      const chargeSchemaBefore = scanBefore.relationships.find(
        (r) =>
          (r.from === 'src/billing/charge.ts' && r.to === 'db/schema.sql') ||
          (r.from === 'db/schema.sql' && r.to === 'src/billing/charge.ts'),
      );
      assert.ok(chargeSchemaBefore, 'expected charge.ts <-> schema.sql relationship before verdicts');
      assert.equal(chargeSchemaBefore.verdict, undefined);

      const explainBefore = await explain(ctxBefore, 'src/manifest.json', 'src/manifest.lock.json', {});
      assert.equal(explainBefore.verdict, undefined);

      // Write verdicts: expected for manifest <-> manifest.lock, confirmed for charge.ts <-> schema.sql
      const verdictsDoc = {
        version: 1,
        verdicts: [
          {
            pair: ['src/manifest.json', 'src/manifest.lock.json'],
            verdict: 'expected',
            reason: 'Lockfile always moves with manifest',
            until: '2099-12-31',
            by: 'lbrodie11',
            directed: false,
          },
          {
            pair: ['src/billing/charge.ts', 'db/schema.sql'],
            verdict: 'confirmed',
            reason: 'Charge writes the orders table; keep in sync',
            by: 'lbrodie11',
          },
        ],
      };
      assertValidSchema(verdictsDoc, 'verdicts.schema.json');
      repo.write(VERDICTS_FILE, `${JSON.stringify(verdictsDoc, null, 2)}\n`);

      const ctxAfter = await loadContext(repo.dir, {});
      // 1. scan hides expected by default, reports verdicts.silenced, keeps confirmed with verdict annotation, and never alters scores
      const scanDefault = scan(ctxAfter, { limit: 20, kinds: [...RELATIONSHIPS] });
      assertValidSchema(
        { schemaVersion: 1, tool: { name: 'repo-archaeology', version: '0.3.0' }, ...scanDefault },
        'scan.schema.json',
      );
      assert.deepEqual(scanDefault.meta.verdicts, {
        loaded: 2,
        active: 2,
        expired: 0,
        file: VERDICTS_FILE,
      });
      assert.deepEqual(scanDefault.verdicts, { silenced: 1 });
      assert.equal(
        scanDefault.relationships.some(
          (r) =>
            (r.from === 'src/manifest.json' && r.to === 'src/manifest.lock.json') ||
            (r.from === 'src/manifest.lock.json' && r.to === 'src/manifest.json'),
        ),
        false,
        'expected pair must be hidden from scan by default',
      );
      const chargeSchemaAfter = scanDefault.relationships.find(
        (r) =>
          (r.from === 'src/billing/charge.ts' && r.to === 'db/schema.sql') ||
          (r.from === 'db/schema.sql' && r.to === 'src/billing/charge.ts'),
      );
      assert.ok(chargeSchemaAfter, 'confirmed pair must remain in scan');
      assert.deepEqual(chargeSchemaAfter.verdict, {
        kind: 'confirmed',
        reason: 'Charge writes the orders table; keep in sync',
        by: 'lbrodie11',
      });
      // Scores and intervals never change
      assert.equal(chargeSchemaAfter.shared, chargeSchemaBefore.shared);
      assert.equal(chargeSchemaAfter.fromChanges, chargeSchemaBefore.fromChanges);
      assert.equal(chargeSchemaAfter.toChanges, chargeSchemaBefore.toChanges);
      assert.equal(chargeSchemaAfter.confidence, chargeSchemaBefore.confidence);
      assert.equal(chargeSchemaAfter.reverseConfidence, chargeSchemaBefore.reverseConfidence);
      assert.equal(chargeSchemaAfter.score, chargeSchemaBefore.score);
      assert.deepEqual(chargeSchemaAfter.interval, chargeSchemaBefore.interval);
      assert.deepEqual(chargeSchemaAfter.reverseInterval, chargeSchemaBefore.reverseInterval);

      // 2. scan --show-silenced includes expected pair with verdict annotation
      const scanSilenced = scan(ctxAfter, { limit: 20, kinds: [...RELATIONSHIPS], showSilenced: true });
      const manifestRel = scanSilenced.relationships.find(
        (r) =>
          (r.from === 'src/manifest.json' && r.to === 'src/manifest.lock.json') ||
          (r.from === 'src/manifest.lock.json' && r.to === 'src/manifest.json'),
      );
      assert.ok(manifestRel, 'expected pair must appear when showSilenced is true');
      assert.deepEqual(manifestRel.verdict, {
        kind: 'expected',
        reason: 'Lockfile always moves with manifest',
        until: '2099-12-31',
        by: 'lbrodie11',
      });

      // 3. file command hides expected unless showSilenced, reports verdicts.silenced, and marks wouldAlert = false on expected
      const fileDefault = fileReport(ctxAfter, 'src/manifest.json', { limit: 10 });
      assertValidSchema(
        { schemaVersion: 1, tool: { name: 'repo-archaeology', version: '0.3.0' }, ...fileDefault },
        'file.schema.json',
      );
      assert.deepEqual(fileDefault.verdicts, { silenced: 1 });
      assert.equal(
        fileDefault.companions.some((c) => c.to === 'src/manifest.lock.json'),
        false,
      );
      const fileSilenced = fileReport(ctxAfter, 'src/manifest.json', { limit: 10, showSilenced: true });
      assert.equal(fileSilenced.verdicts, undefined);
      const lockComp = fileSilenced.companions.find((c) => c.to === 'src/manifest.lock.json');
      assert.ok(lockComp);
      assert.equal(lockComp.wouldAlert, false);
      assert.equal(lockComp.verdict?.kind, 'expected');

      // 4. map command hides expected unless showSilenced and reports verdicts.silenced
      const mapDefault = buildMapData(ctxAfter, { edges: 50, kinds: [...RELATIONSHIPS] });
      assert.deepEqual(mapDefault.verdicts, { silenced: 1 });
      const mapHasManifestDefault = mapDefault.edges.some((e) => {
        const s = mapDefault.nodes[e.source]!.path;
        const t = mapDefault.nodes[e.target]!.path;
        return (
          (s === 'src/manifest.json' && t === 'src/manifest.lock.json') ||
          (s === 'src/manifest.lock.json' && t === 'src/manifest.json')
        );
      });
      assert.equal(mapHasManifestDefault, false);

      const mapSilenced = buildMapData(ctxAfter, { edges: 50, kinds: [...RELATIONSHIPS], showSilenced: true });
      const manifestEdge = mapSilenced.edges.find((e) => {
        const s = mapSilenced.nodes[e.source]!.path;
        const t = mapSilenced.nodes[e.target]!.path;
        return (
          (s === 'src/manifest.json' && t === 'src/manifest.lock.json') ||
          (s === 'src/manifest.lock.json' && t === 'src/manifest.json')
        );
      });
      assert.ok(manifestEdge);
      assert.equal(manifestEdge.verdict?.kind, 'expected');

      // 5. explain always explains and includes verdict without changing scores
      const explainAfter = await explain(ctxAfter, 'src/manifest.json', 'src/manifest.lock.json', {});
      assert.equal(explainAfter.verdict?.kind, 'expected');
      assert.equal(explainAfter.shared, explainBefore.shared);
      assert.equal(explainAfter.confidence, explainBefore.confidence);
      assert.equal(explainAfter.score, explainBefore.score);
      assert.deepEqual(explainAfter.interval, explainBefore.interval);

      // 6. diff when only manifest.json is changed: its only companion (manifest.lock.json) is expected (silenced)
      repo.write('src/manifest.json', '{"v":99}\n');

      const diffAllSilenced = await diff(ctxAfter, { limit: 10, kinds: [...RELATIONSHIPS] });
      assert.equal(diffAllSilenced.suggestions.length, 0);
      assert.ok(diffAllSilenced.silence);
      assert.equal(diffAllSilenced.silence.primaryReason, 'silenced_by_verdicts');
      assert.ok(diffAllSilenced.silence.reasons.includes('silenced_by_verdicts'));
      assert.deepEqual(diffAllSilenced.silence.verdicts, { silenced: 1 });
      const mdSilenced = renderDiffMarkdown(diffAllSilenced);
      assert.match(mdSilenced, /1 expected relationship silenced by verdicts/);

      // 7. diff when both manifest.json and charge.ts are changed: manifest.lock.json is silenced and db/schema.sql remains as confirmed
      repo.write('src/billing/charge.ts', 'export const charge = 99;\n');
      const diffConfirmedRemains = await diff(ctxAfter, { limit: 10, kinds: [...RELATIONSHIPS] });
      assert.equal(diffConfirmedRemains.suggestions.length, 1);
      assert.equal(diffConfirmedRemains.suggestions[0]!.to, 'db/schema.sql');
      assert.deepEqual(diffConfirmedRemains.suggestions[0]!.verdict, {
        kind: 'confirmed',
        reason: 'Charge writes the orders table; keep in sync',
        by: 'lbrodie11',
      });
      assert.deepEqual(diffConfirmedRemains.verdicts, { silenced: 1 });
      const mdConfirmed = renderDiffMarkdown(diffConfirmedRemains);
      assert.match(mdConfirmed, /Confirmed dependency/);
      assert.match(mdConfirmed, /Charge writes the orders table; keep in sync/);
      assert.match(mdConfirmed, /1 expected relationship silenced by verdicts/);
    } finally {
      repo.cleanup();
    }
  });

  it('supports directed verdicts, glob pairs (matching current paths only), and expired until warnings + verdict prune', async () => {
    const repo = new FixtureRepo();
    try {
      for (let i = 0; i < 5; i++) {
        repo.commit({
          message: `sync a, b, and locales ${i}`,
          write: {
            'src/a.ts': `export const a = ${i};\n`,
            'src/b.ts': `export const b = ${i};\n`,
            'locales/en.json': `{"hi":"${i}"}\n`,
            'locales/fr.json': `{"hi":"${i}"}\n`,
          },
        });
      }

      repo.write(
        VERDICTS_FILE,
        JSON.stringify(
          {
            version: 1,
            verdicts: [
              {
                pair: ['src/a.ts', 'src/b.ts'],
                verdict: 'expected',
                reason: 'Changing a.ts does not require b.ts, but changing b.ts requires a.ts',
                directed: true,
              },
              {
                pair: ['locales/*.json', 'locales/*.json'],
                verdict: 'expected',
                reason: 'Locale bundles are synced by translation pipeline',
              },
              {
                pair: ['src/b.ts', 'src/a.ts'],
                verdict: 'expected',
                reason: 'Temporary freeze that already expired',
                until: '2020-01-01',
              },
            ],
          },
          null,
          2,
        ) + '\n',
      );

      const ctx = await loadContext(repo.dir, {});
      assert.deepEqual(ctx.verdicts?.meta, {
        loaded: 3,
        active: 2,
        expired: 1,
        file: VERDICTS_FILE,
      });
      assert.ok(
        ctx.warnings.some((w) => w.includes('expired on 2020-01-01')),
        'expired verdict must emit a warning in meta.warnings',
      );

      // Directed check: src/a.ts -> src/b.ts is silenced, but src/b.ts -> src/a.ts is NOT (since the reverse entry expired!)
      assert.equal(ctx.verdicts?.match('src/a.ts', 'src/b.ts')?.kind, 'expected');
      assert.equal(ctx.verdicts?.match('src/b.ts', 'src/a.ts'), undefined);

      // Glob check: locales/en.json <-> locales/fr.json is silenced
      assert.equal(ctx.verdicts?.match('locales/en.json', 'locales/fr.json')?.kind, 'expected');

      // Prune removes the expired entry and keeps the 2 active entries
      const pruneRes = await verdictPrune({ cwd: repo.dir });
      assert.equal(pruneRes.pruned, 1);
      assert.equal(pruneRes.remaining, 2);

      const afterPrune = loadVerdictsFile(repo.dir);
      assert.equal(afterPrune.meta.loaded, 2);
      assert.equal(afterPrune.meta.active, 2);
      assert.equal(afterPrune.meta.expired, 0);
    } finally {
      repo.cleanup();
    }
  });

  it('matches exact (non-glob) verdict paths across git renames while keeping glob verdicts on current paths only', async () => {
    const repo = new FixtureRepo();
    try {
      for (let i = 0; i < 5; i++) {
        repo.commit({
          message: `co-change old-name and partner ${i}`,
          write: {
            'src/old-name.ts': `export const v = ${i};\n`,
            'src/partner.ts': `export const p = ${i};\n`,
          },
        });
      }

      // Verdict recorded under the pre-rename path `src/old-name.ts`
      repo.write(
        VERDICTS_FILE,
        JSON.stringify(
          {
            version: 1,
            verdicts: [
              {
                pair: ['src/old-name.ts', 'src/partner.ts'],
                verdict: 'confirmed',
                reason: 'Keep partner synced even after rename',
              },
              {
                pair: ['src/old-*.ts', 'src/partner.ts'],
                verdict: 'expected',
                reason: 'Glob only matches current paths',
              },
            ],
          },
          null,
          2,
        ) + '\n',
      );

      // Commit a rename src/old-name.ts -> src/new-name.ts
      repo.git('mv', 'src/old-name.ts', 'src/new-name.ts');
      repo.commit({ message: 'rename old-name to new-name' });

      const ctx = await loadContext(repo.dir, {});
      // Exact path verdict on `src/old-name.ts` follows rename to `src/new-name.ts`,
      // while glob `src/old-*.ts` does NOT match `src/new-name.ts`!
      const matched = ctx.verdicts?.match('src/new-name.ts', 'src/partner.ts');
      assert.ok(matched, 'exact path verdict must survive rename');
      assert.equal(matched.kind, 'confirmed');
      assert.equal(matched.reason, 'Keep partner synced even after rename');

      // Also verify uncommitted working-tree rename in diff
      repo.git('mv', 'src/new-name.ts', 'src/final-name.ts');
      repo.write('src/final-name.ts', 'export const v = 999;\n');
      const diffRes = await diff(ctx, { limit: 10, kinds: [...RELATIONSHIPS] });
      const partnerSug = diffRes.suggestions.find((s) => s.to === 'src/partner.ts');
      assert.ok(partnerSug, 'expected partner.ts suggestion after working-tree rename');
      assert.equal(partnerSug.verdict?.kind, 'confirmed');
    } finally {
      repo.cleanup();
    }
  });

  it('verdict add creates, sorts, deduplicates with a notice, validates inputs, and verdict list [--json] reports entries', async () => {
    const repo = new FixtureRepo();
    try {
      repo.commit({
        message: 'init',
        write: { 'a.ts': '1\n', 'b.ts': '1\n', 'c.ts': '1\n' },
      });

      // 1. Add expected verdict via CLI
      const add1 = runCli(
        ['verdict', 'add', 'z.ts', 'a.ts', '--expected', '--reason', 'Mechanical sync', '--by', 'alice'],
        repo.dir,
      );
      assert.equal(add1.code, 0, add1.stderr);
      assert.ok(existsSync(join(repo.dir, VERDICTS_FILE)));

      // 2. Add confirmed verdict (should sort before expected because "confirmed" < "expected")
      const add2 = runCli(
        ['verdict', 'add', 'b.ts', 'c.ts', '--confirmed', '--reason', 'Confirmed coupling', '--until', '2099-01-01'],
        repo.dir,
      );
      assert.equal(add2.code, 0, add2.stderr);

      const rawAfter2 = readFileSync(join(repo.dir, VERDICTS_FILE), 'utf8');
      assert.ok(rawAfter2.endsWith('\n'), 'verdicts file must end with a trailing newline');
      const parsed2 = JSON.parse(rawAfter2);
      assert.equal(parsed2.verdicts.length, 2);
      assert.equal(parsed2.verdicts[0].verdict, 'confirmed');
      assert.deepEqual(parsed2.verdicts[0].pair, ['b.ts', 'c.ts']);
      assert.equal(parsed2.verdicts[1].verdict, 'expected');
      assert.deepEqual(parsed2.verdicts[1].pair, ['z.ts', 'a.ts']);

      // 3. Deduplicate undirected paireven when reversed (`a.ts`, `z.ts`) and emit notice
      const addDup = await verdictAdd('a.ts', 'z.ts', {
        confirmed: true,
        reason: 'Upgraded to confirmed',
        cwd: repo.dir,
      });
      assert.equal(addDup.replaced, true);
      assert.equal(addDup.total, 2);

      // 4. verdict list --json
      const listRes = runCli(['verdict', 'list', '--json'], repo.dir);
      assert.equal(listRes.code, 0, listRes.stderr);
      const listJson = JSON.parse(listRes.stdout);
      assert.equal(listJson.meta.loaded, 2);
      assert.equal(listJson.verdicts.length, 2);

      const listObj = await verdictList({ cwd: repo.dir });
      assert.equal(listObj.verdicts.length, 2);
    } finally {
      repo.cleanup();
    }
  });

  it('rejects symlinks, oversized files, and invalid entries (naming the entry index), warns on unknown keys, and reads from <head> tree in --head mode', async () => {
    const repo = new FixtureRepo();
    try {
      repo.commit({
        message: 'init',
        write: {
          'a.ts': 'export const a = 1;\n',
          'b.ts': 'export const b = 1;\n',
        },
      });

      // Unknown keys produce a warning without throwing
      const withUnknown = parseVerdictsText(
        JSON.stringify({
          version: 1,
          extraTop: true,
          verdicts: [
            {
              pair: ['a.ts', 'b.ts'],
              verdict: 'expected',
              reason: 'valid reason',
              extraField: 123,
            },
          ],
        }),
        VERDICTS_FILE,
      );
      assert.equal(withUnknown.warnings.length, 2);
      assert.ok(withUnknown.warnings.some((w) => w.includes('extraTop')));
      assert.ok(withUnknown.warnings.some((w) => w.includes('extraField')));

      // Invalid entry raises ConfigError naming verdicts[0]
      assert.throws(
        () =>
          parseVerdictsText(
            JSON.stringify({
              version: 1,
              verdicts: [{ pair: ['a.ts', 'b.ts'], verdict: 'expected', reason: '' }],
            }),
            VERDICTS_FILE,
          ),
        (err: unknown) => err instanceof ConfigError && /verdicts\[0\]\.reason/.test(err.message),
      );

      assert.throws(
        () =>
          parseVerdictsText(
            JSON.stringify({
              version: 1,
              verdicts: [
                { pair: ['a.ts', 'b.ts'], verdict: 'expected', reason: 'ok' },
                { pair: ['../outside.ts', 'b.ts'], verdict: 'expected', reason: 'bad path' },
              ],
            }),
            VERDICTS_FILE,
          ),
        (err: unknown) => err instanceof ConfigError && /verdicts\[1\]\.pair\[0\]/.test(err.message),
      );

      // Oversized text rejected
      const huge = 'x'.repeat(MAX_VERDICTS_BYTES + 100);
      assert.throws(
        () => parseVerdictsText(huge, VERDICTS_FILE),
        (err: unknown) => err instanceof ConfigError && /256 KB/.test(err.message),
      );

      // Symlink rejected
      writeFileSync(join(repo.dir, 'other.json'), '{"version":1,"verdicts":[]}\n');
      symlinkSync(join(repo.dir, 'other.json'), join(repo.dir, VERDICTS_FILE));
      assert.throws(
        () => loadVerdictsFile(repo.dir),
        (err: unknown) => err instanceof ConfigError && /not a regular file/.test(err.message),
      );
      unlinkSync(join(repo.dir, VERDICTS_FILE));

      // --head mode reads .repo-archaeology.verdicts.json from <head> tree, not working tree
      repo.write(
        VERDICTS_FILE,
        JSON.stringify({
          version: 1,
          verdicts: [{ pair: ['a.ts', 'b.ts'], verdict: 'confirmed', reason: 'from committed head' }],
        }) + '\n',
      );
      repo.git('add', VERDICTS_FILE);
      repo.commit({ message: 'commit verdicts' });
      const committedSha = repo.git('rev-parse', 'HEAD');

      // Overwrite working tree verdicts with empty list
      repo.write(VERDICTS_FILE, JSON.stringify({ version: 1, verdicts: [] }) + '\n');

      const headCtx = await loadContext(repo.dir, {}, { head: committedSha });
      assert.equal(headCtx.verdicts?.meta.loaded, 1);
      assert.equal(headCtx.verdicts?.match('a.ts', 'b.ts')?.reason, 'from committed head');

      // Invalid verdicts file at <head> falls back to empty verdicts with a warning in meta.warnings (Reviewer 1 #7)
      repo.write(VERDICTS_FILE, '{not valid json\n');
      repo.git('add', VERDICTS_FILE);
      repo.commit({ message: 'corrupt verdicts on branch' });
      const badSha = repo.git('rev-parse', 'HEAD');
      repo.write(VERDICTS_FILE, JSON.stringify({ version: 1, verdicts: [] }) + '\n');

      const badHeadCtx = await loadContext(repo.dir, {}, { head: badSha });
      assert.equal(badHeadCtx.verdicts?.meta.loaded, 0);
      assert.ok(
        badHeadCtx.warnings.some((w) =>
          w.includes(`Ignoring invalid ${VERDICTS_FILE} at ${badSha}`) && w.includes('proceeding with no verdicts'),
        ),
      );
    } finally {
      repo.cleanup();
    }
  });

  it('prevents a PR from silencing warnings about itself in diff --base unless --apply-branch-verdicts is passed, and rejects catch-all globs', async () => {
    const repo = new FixtureRepo();
    try {
      for (let i = 0; i < 4; i++) {
        repo.commit({
          message: `co-change a and b ${i}`,
          write: {
            'src/a.ts': `export const a = ${i};\n`,
            'src/b.ts': `export const b = ${i};\n`,
          },
        });
      }

      // Catch-all globs where neither endpoint is anchored are rejected
      for (const badPair of [
        ['**', '**'],
        ['*', '**'],
        ['**/*', '**/*'],
        ['*.*', '*.*'],
      ] as [string, string][]) {
        assert.throws(
          () =>
            parseVerdictsText(
              JSON.stringify({
                version: 1,
                verdicts: [{ pair: badPair, verdict: 'expected', reason: 'catch-all noise' }],
              }),
              VERDICTS_FILE,
            ),
          (err: unknown) => err instanceof ConfigError && /too broad/.test(err.message),
        );
      }
      await assert.rejects(
        () => verdictAdd('**', '**', { expected: true, reason: 'catch-all noise', cwd: repo.dir }),
        (err: unknown) => err instanceof UsageError && /too broad/.test(err.message),
      );

      // Create feature branch that modifies src/a.ts AND adds an expected verdict for [src/a.ts, src/b.ts]
      repo.git('checkout', '-b', 'feature/self-silence');
      repo.write('src/a.ts', 'export const a = 999;\n');
      await verdictAdd('src/a.ts', 'src/b.ts', {
        expected: true,
        reason: 'Attempt to silence warning in the same PR',
        cwd: repo.dir,
      });
      repo.git('add', 'src/a.ts', VERDICTS_FILE);
      repo.commit({ message: 'change a.ts and silence b.ts in same PR' });

      // Default `diff --base main` loads verdicts from merge-base (main), so src/b.ts is STILL suggested!
      const ctx = await loadContext(repo.dir, {}, { base: 'main' });
      const diffDefault = await diff(ctx, { base: 'main', limit: 10, kinds: [...RELATIONSHIPS] });
      assertValidSchema(
        { schemaVersion: 1, tool: { name: 'repo-archaeology', version: '0.3.0' }, ...diffDefault },
        'diff.schema.json',
      );
      assert.equal(diffDefault.suggestions.length, 1, 'PR must not silence warnings about itself before merge');
      assert.equal(diffDefault.suggestions[0]!.to, 'src/b.ts');
      assert.deepEqual(diffDefault.verdicts, { silenced: 0, addedInBranch: 1 });

      const md = renderDiffMarkdown(diffDefault);
      assert.match(md, /This PR adds 1 expected verdict \(not applied until merged\)/);

      // With applyBranchVerdicts: true (--apply-branch-verdicts), the branch verdict is previewed locally
      const diffPreview = await diff(ctx, {
        base: 'main',
        limit: 10,
        kinds: [...RELATIONSHIPS],
        applyBranchVerdicts: true,
      });
      assert.equal(diffPreview.suggestions.length, 0);
      assert.deepEqual(diffPreview.verdicts, { silenced: 1, addedInBranch: 1 });
      assert.equal(diffPreview.silence?.primaryReason, 'silenced_by_verdicts');
      assert.deepEqual(diffPreview.silence?.verdicts, { silenced: 1, addedInBranch: 1 });

      // Also verify openRepository() session API forwards applyBranchVerdicts and showSilenced
      const session = await openRepository({ cwd: repo.dir, base: 'main' });
      try {
        const apiDiffDefault = await session.diff({ limit: 10 });
        assert.equal(apiDiffDefault.suggestions.length, 1);
        assert.deepEqual(apiDiffDefault.verdicts, { silenced: 0, addedInBranch: 1 });

        const apiDiffPreview = await session.diff({ limit: 10, applyBranchVerdicts: true });
        assert.equal(apiDiffPreview.suggestions.length, 0);
        assert.deepEqual(apiDiffPreview.verdicts, { silenced: 1, addedInBranch: 1 });
      } finally {
        await session.close();
      }
      const headSession = await openRepository({ cwd: repo.dir });
      try {
        const apiScanHidden = await headSession.scan({ kinds: [...RELATIONSHIPS] });
        assert.equal(apiScanHidden.relationships.length, 0);
        assert.deepEqual(apiScanHidden.verdicts, { silenced: 1 });

        const apiScanShown = await headSession.scan({ kinds: [...RELATIONSHIPS], showSilenced: true });
        assert.equal(apiScanShown.relationships.length, 1);
        assert.equal(apiScanShown.relationships[0]!.verdict?.kind, 'expected');

        const apiFileHidden = await headSession.file('src/a.ts');
        assert.equal(apiFileHidden.companions.length, 0);
        assert.deepEqual(apiFileHidden.verdicts, { silenced: 1 });

        const apiFileShown = await headSession.file('src/a.ts', { showSilenced: true });
        assert.equal(apiFileShown.companions.length, 1);
        assert.equal(apiFileShown.companions[0]!.verdict?.kind, 'expected');
      } finally {
        await headSession.close();
      }
    } finally {
      repo.cleanup();
    }
  });

  it('preserves $schema in verdict add/prune, preserves in-repo symlink paths, rejects explain --show-silenced, and treats until as inclusive UTC', async () => {
    const repo = new FixtureRepo();
    try {
      repo.commit({
        message: 'init with symlink',
        write: {
          'src/real.ts': 'export const r = 1;\n',
          'src/partner.ts': 'export const p = 1;\n',
        },
      });
      symlinkSync('real.ts', join(repo.dir, 'src/link.ts'));
      repo.git('add', 'src/link.ts');
      repo.commit({ message: 'add symlink' });

      // 1. verdict add writes default $schema on new file and records symlink's own tracked path (not target)
      await verdictAdd('src/link.ts', 'src/partner.ts', {
        expected: true,
        reason: 'Symlink path preserved lexically',
        cwd: repo.dir,
      });
      const createdJson = JSON.parse(readFileSync(join(repo.dir, VERDICTS_FILE), 'utf8'));
      assert.equal(createdJson.$schema, VERDICTS_SCHEMA_URL);
      assert.deepEqual(createdJson.verdicts[0].pair, ['src/link.ts', 'src/partner.ts']);

      // 2. Custom $schema is preserved across verdict add and verdict prune
      const customSchema = 'https://example.com/custom-verdicts.schema.json';
      createdJson.$schema = customSchema;
      createdJson.verdicts.push({
        pair: ['src/real.ts', 'src/partner.ts'],
        verdict: 'expected',
        reason: 'Already expired',
        until: '2020-01-01',
      });
      writeFileSync(join(repo.dir, VERDICTS_FILE), `${JSON.stringify(createdJson, null, 2)}\n`);

      await verdictAdd('src/real.ts', 'src/link.ts', {
        confirmed: true,
        reason: 'Confirmed link',
        cwd: repo.dir,
      });
      const afterAddJson = JSON.parse(readFileSync(join(repo.dir, VERDICTS_FILE), 'utf8'));
      assert.equal(afterAddJson.$schema, customSchema);

      await verdictPrune({ cwd: repo.dir });
      const afterPruneJson = JSON.parse(readFileSync(join(repo.dir, VERDICTS_FILE), 'utf8'));
      assert.equal(afterPruneJson.$schema, customSchema);

      // 3. explain --show-silenced is removed and rejected by CLI
      const badExplain = runCli(['explain', 'src/real.ts', 'src/partner.ts', '--show-silenced'], repo.dir);
      assert.notEqual(badExplain.code, 0);
      assert.match(badExplain.stderr, /unknown option '--show-silenced'/);

      // 4. until is an inclusive UTC date (until === nowDate is active; until < nowDate is expired)
      const inclusiveCheck = parseVerdictsText(
        JSON.stringify({
          version: 1,
          verdicts: [
            { pair: ['a.ts', 'b.ts'], verdict: 'expected', reason: 'active today', until: '2026-06-15' },
            { pair: ['c.ts', 'd.ts'], verdict: 'expected', reason: 'expired yesterday', until: '2026-06-14' },
          ],
        }),
        VERDICTS_FILE,
        { nowDate: '2026-06-15' },
      );
      assert.equal(inclusiveCheck.meta.active, 1);
      assert.equal(inclusiveCheck.meta.expired, 1);
      assert.equal(inclusiveCheck.activeEntries[0]!.pair[0], 'a.ts');

      // 5. isGlobPattern only treats {a,b} with a comma as brace alternation; literal {id} and [id] are exact paths
      assert.equal(isGlobPattern('src/routes/{id}.ts'), false);
      assert.equal(isGlobPattern('app/[id]/page.tsx'), false);
      assert.equal(isGlobPattern('src/{a,b}.ts'), true);
      assert.equal(isGlobPattern('src/*.ts'), true);
    } finally {
      repo.cleanup();
    }
  });

  it('enforces deterministic specificity and confirmed-over-expected precedence independent of file order or verdict add/prune', async () => {
    const repo = new FixtureRepo();
    try {
      repo.commit({
        message: 'init',
        write: {
          'src/a.ts': 'export const a = 1;\n',
          'src/b.ts': 'export const b = 1;\n',
          'other/x.ts': 'export const x = 1;\n',
          'other/y.ts': 'export const y = 1;\n',
        },
      });

      // 1. Equal specificity: confirmed beats expected regardless of order in file
      for (const entries of [
        [
          { pair: ['src/a.ts', 'src/b.ts'], verdict: 'expected', reason: 'expected first' },
          { pair: ['src/a.ts', 'src/b.ts'], verdict: 'confirmed', reason: 'confirmed second' },
        ],
        [
          { pair: ['src/a.ts', 'src/b.ts'], verdict: 'confirmed', reason: 'confirmed first' },
          { pair: ['src/a.ts', 'src/b.ts'], verdict: 'expected', reason: 'expected second' },
        ],
      ]) {
        repo.write(VERDICTS_FILE, JSON.stringify({ version: 1, verdicts: entries }) + '\n');
        const ctx = await loadContext(repo.dir, {});
        assert.equal(ctx.verdicts?.match('src/a.ts', 'src/b.ts')?.kind, 'confirmed');
      }

      // 2. Overlapping globs: narrower glob ["src/*.ts", "src/*.ts"] (expected) beats broader ["**/*.ts", "**/*.ts"] (confirmed)
      // even after verdict add sorts confirmed before expected in .repo-archaeology.verdicts.json (Reviewer 2 P2 #4)
      repo.write(
        VERDICTS_FILE,
        JSON.stringify({
          version: 1,
          verdicts: [
            { pair: ['src/*.ts', 'src/*.ts'], verdict: 'expected', reason: 'narrower src glob' },
            { pair: ['**/*.ts', '**/*.ts'], verdict: 'confirmed', reason: 'broader repo glob' },
          ],
        }) + '\n',
      );
      const ctxBeforeAdd = await loadContext(repo.dir, {});
      assert.equal(ctxBeforeAdd.verdicts?.match('src/a.ts', 'src/b.ts')?.kind, 'expected');
      assert.equal(ctxBeforeAdd.verdicts?.match('other/x.ts', 'other/y.ts')?.kind, 'confirmed');

      // Run verdict add for an unrelated rule, which re-serializes the file with confirmed entries first
      await verdictAdd('README.md', 'CHANGELOG.md', {
        expected: true,
        reason: 'unrelated rule',
        cwd: repo.dir,
      });
      const ctxAfterAdd = await loadContext(repo.dir, {});
      assert.equal(
        ctxAfterAdd.verdicts?.match('src/a.ts', 'src/b.ts')?.kind,
        'expected',
        'narrower glob must still win after verdict add re-orders the file',
      );
    } finally {
      repo.cleanup();
    }
  });

  it('excludes silenced pairs from Finding Family completion across scan, diff, and map unless --show-silenced is set (P2 #1)', async () => {
    const repo = new FixtureRepo();
    try {
      for (let i = 0; i < 4; i++) {
        repo.commit({
          message: `sync parallel widgets ${i}`,
          write: {
            'pkg/alpha/widget.ts': `export const alpha = ${i};\n`,
            'pkg/beta/widget.ts': `export const beta = ${i};\n`,
            'pkg/gamma/widget.ts': `export const gamma = ${i};\n`,
          },
        });
      }

      // Silence beta <-> gamma while leaving alpha <-> beta and alpha <-> gamma active
      await verdictAdd('pkg/beta/widget.ts', 'pkg/gamma/widget.ts', {
        expected: true,
        reason: 'beta and gamma are synced mechanically',
        cwd: repo.dir,
      });
      repo.git('add', VERDICTS_FILE);
      repo.commit({ message: 'commit expected verdict on beta <-> gamma' });

      const ctx = await loadContext(repo.dir, {});

      // scan: family has 3 members (connected via alpha-beta and alpha-gamma), but only 2 of 3 qualifyingPairs (complete: false)
      const scanDefault = scan(ctx, { limit: 20, kinds: [...RELATIONSHIPS] });
      assert.equal(scanDefault.families.length, 1);
      assert.equal(scanDefault.families[0]!.qualifyingPairs, 2);
      assert.equal(scanDefault.families[0]!.possiblePairs, 3);
      assert.equal(scanDefault.families[0]!.complete, false);
      assert.equal(
        scanDefault.families[0]!.relationships.some(
          (r) =>
            (r.from === 'pkg/beta/widget.ts' && r.to === 'pkg/gamma/widget.ts') ||
            (r.from === 'pkg/gamma/widget.ts' && r.to === 'pkg/beta/widget.ts'),
        ),
        false,
        'silenced pair must not be reintroduced by family triangle completion',
      );

      // scan --show-silenced: all 3 pairs included (complete: true)
      const scanAll = scan(ctx, { limit: 20, kinds: [...RELATIONSHIPS], showSilenced: true });
      assert.equal(scanAll.families.length, 1);
      assert.equal(scanAll.families[0]!.qualifyingPairs, 3);
      assert.equal(scanAll.families[0]!.complete, true);

      // map with edges: 2 so any 3rd family pair would fall into undrawnPairs if not filtered
      const mapDefault = buildMapData(ctx, { edges: 2, kinds: [...RELATIONSHIPS] });
      assert.equal(mapDefault.families?.length, 1);
      assert.equal(mapDefault.families![0]!.complete, false);
      assert.equal(mapDefault.families![0]!.undrawnPairs, undefined);

      // diff when alpha is modified: beta and gamma are suggested, and the diff family has qualifyingPairs: 2 (complete: false)
      repo.write('pkg/alpha/widget.ts', 'export const alpha = 99;\n');
      const diffRes = await diff(ctx, { limit: 10, kinds: [...RELATIONSHIPS] });
      assert.equal(diffRes.families?.length, 1);
      assert.equal(diffRes.families![0]!.qualifyingPairs, 2);
      assert.equal(diffRes.families![0]!.complete, false);
    } finally {
      repo.cleanup();
    }
  });

  it('preserves separate file identities when rename destinations reuse vacated paths (P2 #2) and follows intermediate branch renames (P2 #3)', async () => {
    const repo = new FixtureRepo();
    try {
      for (let i = 0; i < 4; i++) {
        repo.commit({
          message: `co-change a, b, and partner ${i}`,
          write: {
            'a.ts': `export const a = ${i};\n`,
            'b.ts': `export const b = ${i};\n`,
            'partner.ts': `export const p = ${i};\n`,
          },
        });
      }
      // Silence only [a.ts, partner.ts]; [b.ts, partner.ts] is NOT silenced
      await verdictAdd('a.ts', 'partner.ts', {
        expected: true,
        reason: 'Only a.ts <-> partner.ts is silenced',
        cwd: repo.dir,
      });
      repo.git('add', VERDICTS_FILE);
      repo.commit({ message: 'commit verdict on a.ts <-> partner.ts' });

      // P2 #2: On a branch, rename b.ts -> c.ts and then a.ts -> b.ts
      repo.git('checkout', '-b', 'feature/reuse-path');
      repo.git('mv', 'b.ts', 'c.ts');
      repo.commit({ message: 'rename b.ts to c.ts' });
      repo.git('mv', 'a.ts', 'b.ts');
      repo.commit({ message: 'rename a.ts to b.ts' });

      const ctxReuse = await loadContext(repo.dir, {}, { base: 'main' });
      const diffReuse = await diff(ctxReuse, { base: 'main', limit: 10, kinds: [...RELATIONSHIPS] });
      const partnerFromC = diffReuse.suggestions.find((s) => s.to === 'partner.ts');
      assert.ok(partnerFromC, 'partner.ts must still be suggested from c.ts (original b.ts)');
      assert.equal(partnerFromC.from, 'c.ts');

      // P2 #3: Multi-hop rename on a branch (x.ts -> y.ts in commit 1, verdict on y.ts, y.ts -> z.ts in commit 2)
      repo.git('checkout', 'main');
      for (let i = 0; i < 4; i++) {
        repo.commit({
          message: `co-change x and companion ${i}`,
          write: {
            'x.ts': `export const x = ${i};\n`,
            'companion.ts': `export const c = ${i};\n`,
          },
        });
      }
      repo.git('checkout', '-b', 'feature/multi-hop');
      repo.git('mv', 'x.ts', 'y.ts');
      repo.commit({ message: 'rename x.ts to y.ts' });
      await verdictAdd('y.ts', 'companion.ts', {
        expected: true,
        reason: 'Verdict recorded under intermediate branch name y.ts',
        cwd: repo.dir,
      });
      repo.git('add', VERDICTS_FILE);
      repo.commit({ message: 'record verdict on y.ts' });
      repo.git('mv', 'y.ts', 'z.ts');
      repo.commit({ message: 'rename y.ts to z.ts' });

      const headSha = repo.git('rev-parse', 'HEAD');
      const ctxMultiHop = await loadContext(repo.dir, {}, { base: 'main', head: headSha });
      const diffMultiHop = await diff(ctxMultiHop, {
        base: 'main',
        limit: 10,
        kinds: [...RELATIONSHIPS],
        applyBranchVerdicts: true,
      });
      assert.equal(
        diffMultiHop.suggestions.some((s) => s.to === 'companion.ts'),
        false,
        'verdict on intermediate branch path y.ts must silence companion.ts after y.ts -> z.ts',
      );
      assert.equal(diffMultiHop.verdicts?.silenced, 1);
    } finally {
      repo.cleanup();
    }
  });
});
