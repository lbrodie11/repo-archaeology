/**
 * RA-21 · `--style rich` runs without React or Ink.
 *
 * `@frame12/terminal` lists `ink` and `react` as optional peers for its live view (`./ink`).
 * Repo Archaeology imports only the core and `./render` entries, so neither is installed here and
 * the CLI's module graph for all four rich commands must never resolve them. (The packed-tarball
 * install without them is exercised by `scripts/smoke-pack.mjs`.)
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { sanitizeGitEnv } from '../scripts/schema-validator.mjs';
import { buildAppFixture } from './fixtures/import-fixtures.js';
import type { FixtureRepo } from './helpers.js';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');
// `--import` takes a URL: a bare absolute path is not one on Windows (`D:\...`).
const TRACE = pathToFileURL(join(import.meta.dirname, 'fixtures', 'trace-modules.mjs')).href;

describe('RA-21 · --style rich never loads ink or react', () => {
  let repo: FixtureRepo;
  let traceDir: string;
  before(() => {
    repo = buildAppFixture();
    traceDir = mkdtempSync(join(tmpdir(), 'ra21-trace-'));
  });
  after(() => {
    repo.cleanup();
    rmSync(traceDir, { recursive: true, force: true });
  });

  it('ink and react are not installed (they are optional peers of @frame12/terminal)', () => {
    const require = createRequire(join(ROOT, 'package.json'));
    for (const name of ['ink', 'react']) {
      assert.throws(() => require.resolve(name), /Cannot find module/, `${name} should not be installed`);
    }
  });

  for (const [name, args] of [
    ['scan', ['scan']],
    ['diff', ['diff', '--base', 'HEAD~4']],
    ['file', ['file', 'src/db.ts']],
    ['explain', ['explain', 'src/billing.ts', 'templates/invoice.ts']],
  ] as const) {
    it(`${name}: the module graph includes @frame12/terminal core and render, and never ink or react`, () => {
      const traceFile = join(traceDir, `${name}.txt`);
      const res = spawnSync(
        process.execPath,
        ['--import', TRACE, '--import', TSX, CLI, '--min-shared', '2', '--min-confidence', '0.3', '--no-cache', '--style', 'rich', ...args],
        { cwd: repo.dir, encoding: 'utf8', env: sanitizeGitEnv(process.env, { RA_TRACE_FILE: traceFile, NO_COLOR: '1' }), timeout: 60_000 },
      );
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /^Repo Archaeology · /);
      const urls = readFileSync(traceFile, 'utf8').split('\n').filter(Boolean);
      const frame12 = urls.filter((u) => u.includes('/@frame12/terminal/'));
      assert.ok(frame12.some((u) => u.endsWith('/@frame12/terminal/dist/render/index.js')), 'render entry loaded');
      assert.ok(frame12.some((u) => u.endsWith('/@frame12/terminal/dist/index.js')), 'core entry loaded');
      for (const u of frame12) {
        assert.doesNotMatch(u, /\/dist\/(ink|process|cli|node|testing)\//, `unexpected @frame12/terminal module ${u}`);
      }
      for (const u of urls) {
        assert.doesNotMatch(u, /\/node_modules\/(ink|react|react-dom|react-reconciler)\//, `loaded ${u}`);
        assert.notEqual(u, 'ink');
        assert.notEqual(u, 'react');
      }
    });
  }
});
