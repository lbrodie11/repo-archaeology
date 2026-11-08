import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  ConfigError,
  DEFAULT_IGNORES,
  DEFAULT_SETTINGS,
  GitError,
  openRepository,
  RELATIONSHIPS,
  UsageError,
  type BacktestJson,
  type DiffJson,
  type ExplainJson,
  type FileJson,
  type ImportGraphJson,
  type OpenOptions,
  type Repository,
  type ScanJson,
} from '../src/api/index.js';
import {
  loadSchema as loadSchemaFromDir,
  sanitizeGitEnv,
  validateSchemaNode,
} from '../scripts/schema-validator.mjs';
import { FixtureRepo } from './helpers.js';

const ROOT_DIR = join(import.meta.dirname, '..');
const SCHEMA_DIR = join(ROOT_DIR, 'schema');
const CLI = join(ROOT_DIR, 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');

function runCli(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, ['--import', TSX, CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: sanitizeGitEnv(process.env, { NO_COLOR: '1', ...extraEnv }),
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function assertMatchesSchema(value: unknown, schemaFile: string): void {
  const schema = loadSchemaFromDir(SCHEMA_DIR, schemaFile);
  const errors: string[] = [];
  validateSchemaNode(SCHEMA_DIR, value, schema, schemaFile, '$', errors);
  assert.deepEqual(errors, [], `Schema validation failed for ${schemaFile}:\n${errors.join('\n')}`);
}

function canonicalPosixPath(p: string): string {
  return realpathSync.native(p).replace(/\\/g, '/');
}

describe('RA-03 Library API: openRepository() sessions', () => {
  let repo: FixtureRepo;
  let baseRefSha: string;
  let headRefSha: string;

  before(() => {
    repo = new FixtureRepo();
    repo.write(
      'tsconfig.json',
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            baseUrl: '.',
            paths: {
              '@/*': ['src/*'],
            },
          },
        },
        null,
        2,
      ),
    );
    repo.write('src/adapter/bun/serve-static.ts', 'export const bunServe = 1;\n');
    repo.write('src/adapter/deno/serve-static.ts', 'export const denoServe = 1;\n');
    repo.write('src/adapter/cloudflare/serve-static.ts', 'export const cfServe = 1;\n');
    repo.write('src/db.ts', 'export const db = 1;\n');
    repo.write('src/util.ts', 'export function format(x: number) { return String(x); }\n');
    repo.write(
      'src/api.ts',
      [
        '/// <reference path="./types.d.ts" />',
        "import { db } from './db.js';",
        "import { format } from '@/util';",
        "import fs from 'node:fs';",
        "export { db as reexportedDb } from './db.js';",
        "const lazy = () => import('./adapter/bun/serve-static.js');",
        "const legacy = require('./util');",
        "import { missing } from './does-not-exist.js';",
        'export const api = () => format(db) + typeof fs + typeof lazy + typeof legacy + typeof missing;',
        '',
      ].join('\n'),
    );
    repo.write('src/types.d.ts', 'export interface ApiTypes { ok: boolean; }\n');
    repo.git('add', '.');
    repo.commit({ message: 'initial setup', author: 'Alice' });

    for (let i = 1; i <= 30; i++) {
      repo.commit({
        message: `feat(serve-static): sync adapter behavior ${i}`,
        author: 'Alice',
        write: {
          'src/adapter/bun/serve-static.ts': `export const bunServe = ${i};\n`,
          'src/adapter/deno/serve-static.ts': `export const denoServe = ${i};\n`,
          'src/adapter/cloudflare/serve-static.ts': `export const cfServe = ${i};\n`,
        },
      });
      if (i % 4 === 0) {
        repo.commit({
          message: `fix(api): update query ${i}`,
          author: 'Bob',
          write: {
            'src/api.ts': [
              '/// <reference path="./types.d.ts" />',
              "import { db } from './db.js';",
              "import { format } from '@/util';",
              "import fs from 'node:fs';",
              "export { db as reexportedDb } from './db.js';",
              "const lazy = () => import('./adapter/bun/serve-static.js');",
              "const legacy = require('./util');",
              "import { missing } from './does-not-exist.js';",
              `export const api = () => format(db + ${i}) + typeof fs + typeof lazy + typeof legacy + typeof missing;`,
              '',
            ].join('\n'),
          },
        });
        repo.commit({
          message: `fix(api): follow up db schema ${i}`,
          author: 'Bob',
          write: {
            'src/api.ts': [
              '/// <reference path="./types.d.ts" />',
              "import { db } from './db.js';",
              "import { format } from '@/util';",
              "import fs from 'node:fs';",
              "export { db as reexportedDb } from './db.js';",
              "const lazy = () => import('./adapter/bun/serve-static.js');",
              "const legacy = require('./util');",
              "import { missing } from './does-not-exist.js';",
              `export const api = () => format(db + ${i} + 1) + typeof fs + typeof lazy + typeof legacy + typeof missing;`,
              '',
            ].join('\n'),
            'src/db.ts': `export const db = ${i};\n`,
          },
        });
      }
      if (i === 30) {
        baseRefSha = repo.git('rev-parse', 'HEAD').trim();
      }
    }

    // Create a branch-like commit modifying one member of the 3-way family so diff --base has suggestions
    repo.commit({
      message: 'feat(bun): update bun serve-static only',
      author: 'Alice',
      write: {
        'src/adapter/bun/serve-static.ts': 'export const bunServe = 999;\n',
      },
    });
    headRefSha = repo.git('rev-parse', 'HEAD').trim();
  });

  after(() => {
    repo.cleanup();
  });

  it('guarantees byte-for-byte JSON parity between openRepository() methods and CLI --json', async () => {
    const expectedRoot = canonicalPosixPath(repo.dir);

    // 1. Default session (no base) for scan, file, explain, backtest, importGraph, and working-tree diff
    const defaultSession = await openRepository({
      cwd: join(repo.dir, 'src'),
    });
    try {
      assert.equal(defaultSession.root.replace(/\\/g, '/'), expectedRoot);
      assert.equal(defaultSession.headSha, headRefSha);
      assert.equal(defaultSession.mergeBaseSha, undefined);

      // scan
      const apiScan: ScanJson = await defaultSession.scan({ limit: 5, kinds: ['ghost', 'direct'] });
      const cliScan = JSON.parse(
        runCli(['scan', '--limit', '5', '--kinds', 'ghost,direct', '--json'], repo.dir).stdout,
      );
      assert.deepEqual(apiScan, cliScan);
      assertMatchesSchema(apiScan, 'scan.schema.json');

      // diff (working-tree clean -> silence)
      const apiCleanDiff: DiffJson = await defaultSession.diff({ limit: 5 });
      const cliCleanDiff = JSON.parse(
        runCli(['diff', '--limit', '5', '--json'], repo.dir).stdout,
      );
      assert.deepEqual(apiCleanDiff, cliCleanDiff);
      assertMatchesSchema(apiCleanDiff, 'diff.schema.json');

      // file (session opened in join(repo.dir, 'src') resolves paths relative to cwd or repo root)
      const apiFile: FileJson = await defaultSession.file('adapter/bun/serve-static.ts', { limit: 5 });
      const cliFile = JSON.parse(
        runCli(['file', 'src/adapter/bun/serve-static.ts', '--limit', '5', '--json'], repo.dir).stdout,
      );
      assert.deepEqual(apiFile, cliFile);
      assertMatchesSchema(apiFile, 'file.schema.json');

      // explain
      const apiExplain: ExplainJson = await defaultSession.explain(
        'adapter/bun/serve-static.ts',
        'adapter/deno/serve-static.ts',
        { commits: 3, counterexamples: true, context: 2 },
      );
      const cliExplain = JSON.parse(
        runCli(
          [
            'explain',
            'src/adapter/bun/serve-static.ts',
            'src/adapter/deno/serve-static.ts',
            '--commits',
            '3',
            '--counterexamples',
            '-U',
            '2',
            '--json',
          ],
          repo.dir,
        ).stdout,
      );
      assert.deepEqual(apiExplain, cliExplain);
      assertMatchesSchema(apiExplain, 'explain.schema.json');

      // backtest
      const apiBacktest: BacktestJson = await defaultSession.backtest({
        testFraction: 0.25,
        k: 3,
        ghosts: true,
        followUps: true,
        followUpWindowHours: 48,
        compareOriginWeights: 'bot=0,agent=0.5',
      });
      const cliBacktest = JSON.parse(
        runCli(
          [
            'backtest',
            '--test-fraction',
            '0.25',
            '-k',
            '3',
            '--ghosts',
            '--follow-ups',
            '--follow-up-window',
            '48',
            '--compare-origin-weights',
            'bot=0,agent=0.5',
            '--json',
          ],
          repo.dir,
        ).stdout,
      );
      assert.deepEqual(apiBacktest, cliBacktest);
      assertMatchesSchema(apiBacktest, 'backtest.schema.json');

      // importGraph
      const apiImports: ImportGraphJson = await defaultSession.importGraph();
      const cliImports = JSON.parse(runCli(['imports', '--json'], repo.dir).stdout);
      assert.deepEqual(apiImports, cliImports);
      assertMatchesSchema(apiImports, 'import-graph.schema.json');

      const apiFilteredImports: ImportGraphJson = await defaultSession.importGraph({ files: ['db.ts'] });
      const cliFilteredImports = JSON.parse(
        runCli(['imports', '--files', 'src/db.ts', '--json'], repo.dir).stdout,
      );
      assert.deepEqual(apiFilteredImports, cliFilteredImports);
      assertMatchesSchema(apiFilteredImports, 'import-graph.schema.json');
    } finally {
      await defaultSession.close();
    }

    // 2. Session with base set (diff --base and explain --base)
    const baseSession = await openRepository({
      cwd: repo.dir,
      base: baseRefSha,
    });
    try {
      assert.equal(baseSession.root.replace(/\\/g, '/'), expectedRoot);
      assert.equal(baseSession.headSha, headRefSha);
      assert.equal(baseSession.mergeBaseSha, baseRefSha);

      const apiDiff: DiffJson = await baseSession.diff({ limit: 5 });
      const cliDiff = JSON.parse(
        runCli(['diff', '--base', baseRefSha, '--limit', '5', '--json'], repo.dir).stdout,
      );
      assert.deepEqual(apiDiff, cliDiff);
      assert.ok(apiDiff.suggestions.length >= 1, 'expected suggestions for bun serve-static change');
      assertMatchesSchema(apiDiff, 'diff.schema.json');

      const apiBaseExplain: ExplainJson = await baseSession.explain(
        'src/adapter/bun/serve-static.ts',
        'src/adapter/deno/serve-static.ts',
        { commits: 3, counterexamples: true, context: 2 },
      );
      const cliBaseExplain = JSON.parse(
        runCli(
          [
            'explain',
            'src/adapter/bun/serve-static.ts',
            'src/adapter/deno/serve-static.ts',
            '--base',
            baseRefSha,
            '--commits',
            '3',
            '--counterexamples',
            '-U',
            '2',
            '--json',
          ],
          repo.dir,
        ).stdout,
      );
      assert.deepEqual(apiBaseExplain, cliBaseExplain);
      assertMatchesSchema(apiBaseExplain, 'explain.schema.json');
    } finally {
      await baseSession.close();
    }

    // 3. Session with head + base set (RA-02 mode)
    const headBaseSession = await openRepository({
      cwd: repo.dir,
      head: 'HEAD~1',
      base: 'HEAD~3',
    });
    try {
      const apiHeadDiff = await headBaseSession.diff();
      const cliHeadDiff = JSON.parse(
        runCli(['--head', 'HEAD~1', 'diff', '--base', 'HEAD~3', '--json'], repo.dir).stdout,
      );
      assert.deepEqual(apiHeadDiff, cliHeadDiff);
    } finally {
      await headBaseSession.close();
    }

    const headOnlySession = await openRepository({
      cwd: repo.dir,
      head: 'HEAD~1',
    });
    try {
      const apiHeadImports = await headOnlySession.importGraph();
      const cliHeadImports = JSON.parse(
        runCli(['--head', 'HEAD~1', 'imports', '--json'], repo.dir).stdout,
      );
      assert.deepEqual(apiHeadImports, cliHeadImports);
    } finally {
      await headOnlySession.close();
    }
  });

  it('spawns git log for history loading exactly once across openRepository() and multiple method calls', async () => {
    const spawnedGitArgs: string[][] = [];
    const session = await openRepository({
      cwd: repo.dir,
      head: headRefSha,
      onSpawn: (args: readonly string[]) => {
        spawnedGitArgs.push([...args]);
      },
    } as OpenOptions);
    try {
      await session.scan({ limit: 5 });
      await session.backtest({ testFraction: 0.2, k: 3 });
      await session.file('src/adapter/bun/serve-static.ts');
      await session.importGraph();
      await session.importGraph({ files: ['src/db.ts'] });
    } finally {
      await session.close();
    }

    const gitLogCalls = spawnedGitArgs.filter((args) => args[0] === 'log');
    assert.equal(
      gitLogCalls.length,
      1,
      `Expected git log to be called exactly once per session, got ${gitLogCalls.length}:\n${spawnedGitArgs.map((a) => a.join(' ')).join('\n')}`,
    );
  });

  it('never writes to stdout or stderr in library mode and reports progress via onProgress', () => {
    const apiEntryUrl = pathToFileURL(join(ROOT_DIR, 'src', 'api', 'index.ts')).href;
    const script = [
      `import assert from 'node:assert/strict';`,
      `import { openRepository } from ${JSON.stringify(apiEntryUrl)};`,
      `const stdoutWrites = [];`,
      `const stderrWrites = [];`,
      `const progressEvents = [];`,
      `process.stdout.write = (chunk) => { stdoutWrites.push(String(chunk)); return true; };`,
      `process.stderr.write = (chunk) => { stderrWrites.push(String(chunk)); return true; };`,
      `Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });`,
      `const session = await openRepository({`,
      `  cwd: ${JSON.stringify(repo.dir)},`,
      `  base: ${JSON.stringify(baseRefSha)},`,
      `  onProgress: (e) => progressEvents.push(e),`,
      `});`,
      `try {`,
      `  await session.scan();`,
      `  await session.diff();`,
      `  await session.file('src/adapter/bun/serve-static.ts');`,
      `  await session.explain('src/adapter/bun/serve-static.ts', 'src/adapter/deno/serve-static.ts');`,
      `  await session.backtest();`,
      `  await session.importGraph();`,
      `} finally {`,
      `  await session.close();`,
      `}`,
      `assert.deepEqual(stdoutWrites, [], 'Library API must never write to process.stdout');`,
      `assert.deepEqual(stderrWrites, [], 'Library API must never write to process.stderr');`,
      `assert.ok(progressEvents.some((e) => e.phase === 'history' && typeof e.done === 'number'));`,
      `assert.ok(progressEvents.some((e) => e.phase === 'model' && e.done === 1 && e.total === 1));`,
    ].join('\n');

    const res = spawnSync(process.execPath, ['--import', TSX, '--input-type=module', '-e', script], {
      cwd: repo.dir,
      encoding: 'utf8',
      env: sanitizeGitEnv(process.env, { NO_COLOR: '1' }),
    });
    assert.equal(res.status, 0, `Silence check subprocess failed:\n${res.stdout}\n${res.stderr}`);
    assert.equal(res.stdout, '');
    assert.equal(res.stderr, '');
  });

  it('builds importGraph with static, dynamic, reexport, require, unresolved edges, CJS dynamic import() condition, and cached reverse-importer lookup', async () => {
    const session = await openRepository({ cwd: repo.dir });
    try {
      const fullGraph = await session.importGraph();
      assert.equal(fullGraph.schemaVersion, 1);
      assert.deepEqual(fullGraph.languages, ['typescript']);
      assert.ok(fullGraph.files.includes('src/api.ts'));
      assert.ok(fullGraph.files.includes('src/db.ts'));
      assert.ok(fullGraph.files.includes('src/util.ts'));
      assert.ok(fullGraph.files.includes('src/types.d.ts'));

      const apiEdges = fullGraph.edges.filter((e) => e.from === 'src/api.ts');
      assert.deepEqual(
        apiEdges,
        [
          {
            from: 'src/api.ts',
            to: 'src/adapter/bun/serve-static.ts',
            specifier: './adapter/bun/serve-static.js',
            kind: 'dynamic',
          },
          {
            from: 'src/api.ts',
            to: 'src/db.ts',
            specifier: './db.js',
            kind: 'reexport',
          },
          {
            from: 'src/api.ts',
            to: 'src/db.ts',
            specifier: './db.js',
            kind: 'static',
          },
          {
            from: 'src/api.ts',
            to: 'src/types.d.ts',
            specifier: './types.d.ts',
            kind: 'static',
          },
          {
            from: 'src/api.ts',
            to: 'src/util.ts',
            specifier: './util',
            kind: 'require',
          },
          {
            from: 'src/api.ts',
            to: 'src/util.ts',
            specifier: '@/util',
            kind: 'static',
          },
        ],
      );

      // External 'node:fs' is ignored (not internal and not unresolved), while './does-not-exist.js' is reported in unresolved
      assert.deepEqual(fullGraph.unresolved, [
        {
          from: 'src/api.ts',
          specifier: './does-not-exist.js',
          reason: 'unmatched',
        },
      ]);

      // Reverse lookup: asking for files: ['src/db.ts'] restricts `from` to 'src/db.ts' plus 'src/api.ts' (which imports it)
      const dbGraph = await session.importGraph({ files: ['src/db.ts'] });
      assert.deepEqual(dbGraph.files, ['src/api.ts', 'src/db.ts']);
      assert.ok(dbGraph.edges.every((e) => e.from === 'src/api.ts' || e.from === 'src/db.ts'));
      assert.ok(dbGraph.edges.some((e) => e.from === 'src/api.ts' && e.to === 'src/db.ts'));
      assert.deepEqual(dbGraph.unresolved, [
        {
          from: 'src/api.ts',
          specifier: './does-not-exist.js',
          reason: 'unmatched',
        },
      ]);

      // Asking for a leaf file that nobody imports only includes that file
      const denoGraph = await session.importGraph({ files: ['src/adapter/deno/serve-static.ts'] });
      assert.deepEqual(denoGraph.files, ['src/adapter/deno/serve-static.ts']);
      assert.deepEqual(denoGraph.edges, []);
      assert.deepEqual(denoGraph.unresolved, []);

      // Both missing internal paths and outside-repository paths reject consistently with UsageError
      await assert.rejects(
        () => session.importGraph({ files: ['src/does-not-exist.ts'] }),
        (err: unknown) => err instanceof UsageError && /No such file/.test(err.message),
      );
      await assert.rejects(
        () => session.importGraph({ files: ['../outside.ts'] }),
        (err: unknown) => err instanceof UsageError && /outside the repository/.test(err.message),
      );
    } finally {
      await session.close();
    }

    // [P2] Regression test: dynamic import() in .cjs and .cts files selects the "import" condition,
    // while require() selects the "require" condition in package.json exports.
    const cjsEsmRepo = new FixtureRepo();
    try {
      cjsEsmRepo.write('package.json', JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }, null, 2));
      cjsEsmRepo.write(
        'packages/dual/package.json',
        JSON.stringify(
          {
            name: 'dual-pkg',
            version: '1.0.0',
            exports: {
              '.': {
                import: './esm.mjs',
                require: './cjs.cjs',
              },
            },
          },
          null,
          2,
        ),
      );
      cjsEsmRepo.write('packages/dual/esm.mjs', 'export const mode = "esm";\n');
      cjsEsmRepo.write('packages/dual/cjs.cjs', 'module.exports = { mode: "cjs" };\n');
      cjsEsmRepo.write(
        'src/entry.cjs',
        [
          'const syncMod = require("dual-pkg");',
          'const asyncMod = () => import("dual-pkg");',
          'module.exports = { syncMod, asyncMod };',
          '',
        ].join('\n'),
      );
      cjsEsmRepo.write(
        'src/entry.cts',
        [
          'const syncMod = require("dual-pkg");',
          'const asyncMod = () => import("dual-pkg");',
          'export = { syncMod, asyncMod };',
          '',
        ].join('\n'),
      );
      cjsEsmRepo.git('add', '.');
      cjsEsmRepo.commit({ message: 'init dual package', author: 'Alice' });
      cjsEsmRepo.commit({
        message: 'touch files',
        author: 'Alice',
        write: {
          'packages/dual/esm.mjs': 'export const mode = "esm-v2";\n',
          'src/entry.cjs': 'const syncMod = require("dual-pkg");\nconst asyncMod = () => import("dual-pkg");\nmodule.exports = { syncMod, asyncMod, v: 2 };\n',
        },
      });

      const dualSession = await openRepository({ cwd: cjsEsmRepo.dir });
      try {
        const graph = await dualSession.importGraph();
        const cjsEdges = graph.edges.filter((e) => e.from === 'src/entry.cjs');
        const ctsEdges = graph.edges.filter((e) => e.from === 'src/entry.cts');
        assert.deepEqual(cjsEdges, [
          {
            from: 'src/entry.cjs',
            to: 'packages/dual/cjs.cjs',
            specifier: 'dual-pkg',
            kind: 'require',
          },
          {
            from: 'src/entry.cjs',
            to: 'packages/dual/esm.mjs',
            specifier: 'dual-pkg',
            kind: 'dynamic',
          },
        ]);
        assert.deepEqual(ctsEdges, [
          {
            from: 'src/entry.cts',
            to: 'packages/dual/cjs.cjs',
            specifier: 'dual-pkg',
            kind: 'require',
          },
          {
            from: 'src/entry.cts',
            to: 'packages/dual/esm.mjs',
            specifier: 'dual-pkg',
            kind: 'dynamic',
          },
        ]);

        // Reverse importer lookup on the ESM target finds both .cjs and .cts dynamic importers
        const reverseEsm = await dualSession.importGraph({ files: ['packages/dual/esm.mjs'] });
        assert.deepEqual(reverseEsm.files, [
          'packages/dual/esm.mjs',
          'src/entry.cjs',
          'src/entry.cts',
        ]);
      } finally {
        await dualSession.close();
      }
    } finally {
      cjsEsmRepo.cleanup();
    }
  });

  it('rejects any method called after repo.close() without spawning a new git cat-file process', async () => {
    const headSession = await openRepository({
      cwd: repo.dir,
      head: 'HEAD~1',
      base: 'HEAD~3',
    });
    // Exercise the session before closing
    await headSession.importGraph();
    await headSession.close();
    // Closing again is idempotent
    await headSession.close();

    for (const call of [
      () => headSession.diff(),
      () => headSession.scan(),
      () => headSession.file('src/api.ts'),
      () => headSession.explain('src/api.ts', 'src/db.ts'),
      () => headSession.backtest(),
      () => headSession.importGraph(),
    ]) {
      await assert.rejects(
        call,
        (err: unknown) => err instanceof UsageError && /Repository session is closed/.test(err.message),
      );
    }
  });

  it('honors useConfigFile, settings overrides, frozen defaults, and throws typed errors in library mode', async () => {
    assert.ok(Object.isFrozen(DEFAULT_SETTINGS), 'DEFAULT_SETTINGS must be frozen');
    assert.ok(Object.isFrozen(DEFAULT_SETTINGS.ignore), 'DEFAULT_SETTINGS.ignore must be frozen');
    assert.ok(Object.isFrozen(DEFAULT_IGNORES), 'DEFAULT_IGNORES must be frozen');

    const configRepo = new FixtureRepo();
    try {
      configRepo.write('a.ts', 'export const a = 1;\n');
      configRepo.write('b.ts', 'export const b = 1;\n');
      configRepo.write('.repo-archaeology.json', JSON.stringify({ minShared: 10 }));
      configRepo.git('add', '.');
      configRepo.commit({ message: 'init', author: 'Alice' });
      for (let i = 0; i < 4; i++) {
        configRepo.commit({
          message: `change ${i}`,
          author: 'Alice',
          write: {
            'a.ts': `export const a = ${i + 2};\n`,
            'b.ts': `export const b = ${i + 2};\n`,
          },
        });
      }

      // With useConfigFile: true (default), minShared is 10 from .repo-archaeology.json -> 0 relationships
      const withConfig = await openRepository({ cwd: configRepo.dir });
      try {
        const scan1 = await withConfig.scan();
        assert.equal(scan1.meta.settings.minShared, 10);
        assert.equal(scan1.relationships.length, 0);
      } finally {
        await withConfig.close();
      }

      // With useConfigFile: false, default minShared is 3 -> 1 relationship
      const withoutConfig = await openRepository({ cwd: configRepo.dir, useConfigFile: false });
      try {
        const scan2 = await withoutConfig.scan();
        assert.equal(scan2.meta.settings.minShared, 3);
        assert.equal(scan2.relationships.length, 1);
      } finally {
        await withoutConfig.close();
      }

      // Explicit settings override .repo-archaeology.json even when useConfigFile: true
      const withOverride = await openRepository({
        cwd: configRepo.dir,
        settings: { minShared: 2, minConfidence: 0.5 },
      });
      try {
        const scan3 = await withOverride.scan();
        assert.equal(scan3.meta.settings.minShared, 2);
        assert.equal(scan3.meta.settings.minConfidence, 0.5);
        assert.equal(scan3.relationships.length, 1);
      } finally {
        await withOverride.close();
      }

      // Invalid .repo-archaeology.json throws ConfigError when useConfigFile is true, but succeeds when useConfigFile is false
      configRepo.write('.repo-archaeology.json', '{ "unknownKey": 123 }');
      await assert.rejects(
        () => openRepository({ cwd: configRepo.dir }),
        (err: unknown) => err instanceof ConfigError,
      );
      const ignoredBadConfig = await openRepository({ cwd: configRepo.dir, useConfigFile: false });
      await ignoredBadConfig.close();

      // Calling diff() in head mode without base throws UsageError
      const headOnly = await openRepository({ cwd: configRepo.dir, head: 'HEAD', useConfigFile: false });
      try {
        await assert.rejects(
          () => headOnly.diff(),
          (err: unknown) => err instanceof UsageError && /requires --base/.test(err.message),
        );
      } finally {
        await headOnly.close();
      }

      // Bad head ref throws UsageError; non-git directory throws GitError
      await assert.rejects(
        () => openRepository({ cwd: configRepo.dir, head: 'refs/heads/does-not-exist', useConfigFile: false }),
        (err: unknown) => err instanceof UsageError,
      );
      const nonGitDir = mkdtempSync(join(tmpdir(), 'repo-arch-nongit-'));
      try {
        await assert.rejects(
          () => openRepository({ cwd: nonGitDir }),
          (err: unknown) => err instanceof GitError,
        );
      } finally {
        rmSync(nonGitDir, { recursive: true, force: true });
      }

      assert.ok(Array.isArray(RELATIONSHIPS) && RELATIONSHIPS.includes('ghost'));
    } finally {
      configRepo.cleanup();
    }
  });

  it('rejects openRepository() with an AbortError when signal is pre-aborted or aborted mid-load', async () => {
    // 1. Pre-aborted signal
    const preAborted = AbortSignal.abort();
    await assert.rejects(
      () => openRepository({ cwd: repo.dir, signal: preAborted }),
      (err: unknown) => err instanceof Error && err.name === 'AbortError',
    );

    // 2. Mid-load abort during history streaming
    const ac = new AbortController();
    await assert.rejects(
      () =>
        openRepository({
          cwd: repo.dir,
          signal: ac.signal,
          onProgress: (e) => {
            if (e.phase === 'history') {
              ac.abort();
            }
          },
        }),
      (err: unknown) => err instanceof Error && err.name === 'AbortError',
    );
  });

  it('packs and resolves repo-archaeology ESM/CJS exports, schema subpaths, and TypeScript declarations from a tarball without network access', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'repo-arch-api-pack-'));
    try {
      // Build dist/ first
      const buildRes = spawnSync(
        process.execPath,
        [join(ROOT_DIR, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(ROOT_DIR, 'tsconfig.json')],
        {
          cwd: ROOT_DIR,
          encoding: 'utf8',
        },
      );
      assert.equal(buildRes.status, 0, buildRes.stderr);

      const packDir = join(tmp, 'pack');
      const consumerDir = join(tmp, 'consumer');
      const installedPkgDir = join(consumerDir, 'node_modules', 'repo-archaeology');
      mkdirSync(packDir, { recursive: true });
      mkdirSync(installedPkgDir, { recursive: true });

      const packRes = spawnSync('npm', ['pack', '--json', '--pack-destination', packDir], {
        cwd: ROOT_DIR,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      });
      assert.equal(packRes.status, 0, packRes.stderr);
      const packInfo = JSON.parse(packRes.stdout) as { filename: string }[];
      const tarballName = packInfo[0]!.filename;
      const tarballPath = join(packDir, tarballName);
      assert.ok(existsSync(tarballPath));

      // Unpack the tarball directly into consumer/node_modules/repo-archaeology and link runtime deps
      // so the test never accesses the network.
      const tarRes = spawnSync('tar', ['-xzf', `../../../pack/${tarballName}`, '--strip-components=1'], {
        cwd: installedPkgDir,
        encoding: 'utf8',
      });
      assert.equal(tarRes.status, 0, tarRes.stderr);
      const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
      for (const dep of ['commander', 'typescript', '@types']) {
        const srcDep = join(ROOT_DIR, 'node_modules', dep);
        if (existsSync(srcDep)) {
          symlinkSync(srcDep, join(consumerDir, 'node_modules', dep), symlinkType);
        }
      }

      writeFileSync(
        join(consumerDir, 'package.json'),
        JSON.stringify({ name: 'test-consumer', private: true, type: 'module' }, null, 2),
      );

      // Verify runtime ESM import, schema subpath imports, and CJS require() of 'repo-archaeology'
      const mjsFile = join(consumerDir, 'verify.mjs');
      writeFileSync(
        mjsFile,
        [
          "import assert from 'node:assert/strict';",
          "import { createRequire } from 'node:module';",
          "import { openRepository, UsageError, GitError, ConfigError, RELATIONSHIPS } from 'repo-archaeology';",
          "import diffSchema from 'repo-archaeology/schema/diff.schema.json' with { type: 'json' };",
          "import importGraphSchema from 'repo-archaeology/schema/import-graph.schema.json' with { type: 'json' };",
          "const require = createRequire(import.meta.url);",
          "assert.equal(diffSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');",
          "assert.equal(importGraphSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');",
          "assert.ok(require.resolve('repo-archaeology/schema/diff.schema.json').endsWith('diff.schema.json'));",
          "assert.ok(require.resolve('repo-archaeology').endsWith('index.js'));",
          "const [maj, min] = process.versions.node.split('.').map(Number);",
          "if (maj > 22 || (maj === 22 && min >= 12)) {",
          "  const cjs = require('repo-archaeology');",
          "  assert.equal(typeof cjs.openRepository, 'function');",
          "}",
          `const repo = await openRepository({ cwd: ${JSON.stringify(repo.dir)}, base: ${JSON.stringify(baseRefSha)} });`,
          'try {',
          '  const diff = await repo.diff({ limit: 3 });',
          '  const graph = await repo.importGraph({ files: ["src/db.ts"] });',
          '  assert.equal(diff.schemaVersion, 1);',
          '  assert.equal(graph.schemaVersion, 1);',
          '  assert.ok(RELATIONSHIPS.includes("ghost"));',
          '  assert.equal(typeof UsageError, "function");',
          '  assert.equal(typeof GitError, "function");',
          '  assert.equal(typeof ConfigError, "function");',
          '} finally {',
          '  await repo.close();',
          '}',
        ].join('\n'),
      );
      const runMjs = spawnSync(process.execPath, [mjsFile], {
        cwd: consumerDir,
        encoding: 'utf8',
        env: sanitizeGitEnv(process.env, { NO_COLOR: '1' }),
      });
      assert.equal(runMjs.status, 0, runMjs.stderr);

      // Verify TypeScript declaration resolution via tsc --noEmit (with skipLibCheck: false)
      const tsFile = join(consumerDir, 'verify.ts');
      writeFileSync(
        tsFile,
        [
          "import { openRepository, type OpenOptions, type Repository, type DiffJson, type ImportGraphJson } from 'repo-archaeology';",
          'export async function check(opts: OpenOptions): Promise<{ diff: DiffJson; imports: ImportGraphJson }> {',
          '  const repo: Repository = await openRepository(opts);',
          '  try {',
          '    const diff: DiffJson = await repo.diff({ limit: 5, kinds: ["ghost"] });',
          '    const imports: ImportGraphJson = await repo.importGraph({ files: ["src/api.ts"] });',
          '    return { diff, imports };',
          '  } finally {',
          '    await repo.close();',
          '  }',
          '}',
          '',
        ].join('\n'),
      );
      writeFileSync(
        join(consumerDir, 'tsconfig.json'),
        JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              strict: true,
              noEmit: true,
              skipLibCheck: false,
            },
            include: ['verify.ts'],
          },
          null,
          2,
        ),
      );
      const tscBin = join(ROOT_DIR, 'node_modules', 'typescript', 'bin', 'tsc');
      const tscRes = spawnSync(process.execPath, [tscBin, '-p', consumerDir], {
        cwd: consumerDir,
        encoding: 'utf8',
      });
      assert.equal(tscRes.status, 0, `tsc failed on consumer verify.ts:\n${tscRes.stdout}\n${tscRes.stderr}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
