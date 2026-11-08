import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { getToolVersion, JSON_SCHEMA_VERSION, validateJsonOutPath, writeJsonContractFile } from '../src/report/contract.js';
import {
  loadSchema as loadSchemaFromDir,
  sanitizeGitEnv,
  validateSchemaNode,
  type JsonSchemaNode,
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

function loadSchema(fileName: string): JsonSchemaNode {
  return loadSchemaFromDir(SCHEMA_DIR, fileName);
}

function assertMatchesSchema(value: unknown, schemaFile: string): void {
  const schema = loadSchema(schemaFile);
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  const errors: string[] = [];
  validateSchemaNode(SCHEMA_DIR, value, schema, schemaFile, '$', errors);
  assert.deepEqual(errors, [], `Schema validation failed for ${schemaFile}:\n${errors.join('\n')}`);
}

describe('JSON output contract (v1) and JSON Schemas', () => {
  let repo: FixtureRepo;
  const pkgVersion = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')).version as string;

  before(() => {
    repo = new FixtureRepo();
    repo.write('src/adapter/bun/serve-static.ts', 'export const bunServe = 1;\n');
    repo.write('src/adapter/deno/serve-static.ts', 'export const denoServe = 1;\n');
    repo.write('src/adapter/cloudflare/serve-static.ts', 'export const cfServe = 1;\n');
    repo.write('src/api.ts', "import { db } from './db';\nexport const api = db;\n");
    repo.write('src/db.ts', 'export const db = 1;\n');
    repo.git('add', '.');
    repo.commit({ message: 'initial setup', author: 'Alice' });

    for (let i = 0; i < 35; i++) {
      repo.commit({
        message: `feat(serve-static): sync adapter behavior ${i}`,
        author: 'Alice',
        write: {
          'src/adapter/bun/serve-static.ts': `export const bunServe = ${i};\n`,
          'src/adapter/deno/serve-static.ts': `export const denoServe = ${i};\n`,
          'src/adapter/cloudflare/serve-static.ts': `export const cfServe = ${i};\n`,
        },
      });
      if (i % 5 === 0) {
        repo.commit({
          message: `fix(api): update query ${i}`,
          author: 'Bob',
          write: {
            'src/api.ts': `import { db } from './db';\nexport const api = db + ${i};\n`,
          },
        });
        repo.commit({
          message: `fix(api): follow up db schema ${i}`,
          author: 'Bob',
          write: {
            'src/api.ts': `import { db } from './db';\nexport const api = db + ${i} + 1;\n`,
            'src/db.ts': `export const db = ${i};\n`,
          },
        });
      }
    }
  });

  after(() => {
    repo.cleanup();
  });

  it('ships valid Draft 2020-12 JSON Schema files in schema/ and includes schema in package.json files', () => {
    const schemaFiles = [
      'common.schema.json',
      'scan.schema.json',
      'diff.schema.json',
      'file.schema.json',
      'explain.schema.json',
      'map.schema.json',
      'backtest.schema.json',
      'default.schema.json',
    ];
    for (const file of schemaFiles) {
      const schema = loadSchema(file);
      assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', `${file} must declare Draft 2020-12`);
      assert.equal(
        schema.$id,
        `https://raw.githubusercontent.com/lbrodie11/repo-archaeology/v${pkgVersion}/schema/${file}`,
        `${file} must use a stable versioned raw $id URI`,
      );
      assert.ok(schema.title, `${file} must have a title`);
    }
    const pkg = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')) as {
      version: string;
      files: string[];
    };
    assert.equal(pkg.version, '0.3.0');
    assert.equal(getToolVersion(), pkgVersion);
    assert.ok(pkg.files.includes('schema'), 'package.json files array must include "schema"');
  });

  it('validates scan --json, file --json, explain --json, map --json, and backtest --json against their schemas', () => {
    // 1. scan --json
    const scanRes = runCli(['scan', '--json'], repo.dir);
    assert.equal(scanRes.code, 0, scanRes.stderr);
    const scanJson = JSON.parse(scanRes.stdout);
    assert.equal(scanJson.schemaVersion, JSON_SCHEMA_VERSION);
    assert.deepEqual(scanJson.tool, { name: 'repo-archaeology', version: pkgVersion });
    assert.equal(scanJson.meta.tool, 'repo-archaeology');
    assert.ok(scanJson.families.length >= 1, 'expected 3-way serve-static family in scan --json');
    for (const rel of scanJson.relationships) {
      assert.ok(rel.interval, 'scan relationship must expose interval');
      assert.ok(rel.reverseInterval, 'scan relationship must expose reverseInterval');
      assert.ok(rel.interval.low <= rel.confidence && rel.confidence <= rel.interval.high);
      assert.ok(rel.reverseInterval.low <= rel.reverseConfidence && rel.reverseConfidence <= rel.reverseInterval.high);
    }
    for (const fam of scanJson.families) {
      for (const rel of fam.relationships) {
        assert.ok(rel.interval, 'scan family relationship must expose interval');
        assert.ok(rel.reverseInterval, 'scan family relationship must expose reverseInterval');
      }
    }
    assertMatchesSchema(scanJson, 'scan.schema.json');

    // 2. file --json
    const fileRes = runCli(['file', 'src/adapter/bun/serve-static.ts', '--json'], repo.dir);
    assert.equal(fileRes.code, 0, fileRes.stderr);
    const fileJson = JSON.parse(fileRes.stdout);
    assert.equal(fileJson.schemaVersion, 1);
    assert.deepEqual(fileJson.tool, { name: 'repo-archaeology', version: pkgVersion });
    assert.ok(fileJson.companions.length >= 1);
    for (const comp of fileJson.companions) {
      assert.ok(comp.interval, 'file companion must expose interval');
      assert.ok(comp.reverseInterval, 'file companion must expose reverseInterval');
      assert.ok(comp.interval.low <= comp.confidence && comp.confidence <= comp.interval.high);
      assert.ok(comp.reverseInterval.low <= comp.reverseConfidence && comp.reverseConfidence <= comp.reverseInterval.high);
    }
    assertMatchesSchema(fileJson, 'file.schema.json');

    // 3. explain --json (with --counterexamples)
    const explainRes = runCli(
      [
        'explain',
        'src/adapter/bun/serve-static.ts',
        'src/adapter/deno/serve-static.ts',
        '--counterexamples',
        '--json',
      ],
      repo.dir,
    );
    assert.equal(explainRes.code, 0, explainRes.stderr);
    const explainJson = JSON.parse(explainRes.stdout);
    assert.equal(explainJson.schemaVersion, 1);
    assert.deepEqual(explainJson.tool, { name: 'repo-archaeology', version: pkgVersion });
    assert.ok(explainJson.interval, 'explain --json must expose interval');
    assert.ok(explainJson.reverseInterval, 'explain --json must expose reverseInterval');
    assert.ok(explainJson.interval.low <= explainJson.confidence && explainJson.confidence <= explainJson.interval.high);
    assert.ok(
      explainJson.reverseInterval.low <= explainJson.reverseConfidence &&
        explainJson.reverseConfidence <= explainJson.reverseInterval.high,
    );
    assertMatchesSchema(explainJson, 'explain.schema.json');

    // 4. map --json
    const mapRes = runCli(['map', '--no-open', '--include-patches', '--json'], repo.dir);
    assert.equal(mapRes.code, 0, mapRes.stderr);
    const mapJson = JSON.parse(mapRes.stdout);
    assert.equal(mapJson.schemaVersion, 1);
    assert.deepEqual(mapJson.tool, { name: 'repo-archaeology', version: pkgVersion });
    assert.equal(mapJson.patchesIncluded, true);
    assertMatchesSchema(mapJson, 'map.schema.json');

    // 5. backtest --json (with --ghosts and --follow-ups)
    const backtestRes = runCli(['backtest', '--ghosts', '--follow-ups', '--json'], repo.dir);
    assert.equal(backtestRes.code, 0, backtestRes.stderr);
    const backtestJson = JSON.parse(backtestRes.stdout);
    assert.equal(backtestJson.schemaVersion, 1);
    assert.deepEqual(backtestJson.tool, { name: 'repo-archaeology', version: pkgVersion });
    assert.ok(backtestJson.ghostDiagnostics);
    assert.ok(backtestJson.followUpBenchmark);
    assertMatchesSchema(backtestJson, 'backtest.schema.json');
  });

  it('validates diff --json (suggestions and silence) and bare default command in both scan and diff modes', () => {
    try {
      // Clean working tree -> bare default command runs in 'scan' mode
      const defaultScanRes = runCli(['--json'], repo.dir);
      assert.equal(defaultScanRes.code, 0, defaultScanRes.stderr);
      const defaultScanJson = JSON.parse(defaultScanRes.stdout);
      assert.equal(defaultScanJson.mode, 'scan');
      assert.equal(defaultScanJson.changedWithoutHistory, 0);
      assertMatchesSchema(defaultScanJson, 'default.schema.json');

      // Clean working tree -> diff --json emits silence (no_changed_files)
      const silentDiffRes = runCli(['diff', '--json'], repo.dir);
      assert.equal(silentDiffRes.code, 0, silentDiffRes.stderr);
      const silentDiffJson = JSON.parse(silentDiffRes.stdout);
      assert.equal(silentDiffJson.suggestions.length, 0);
      assert.equal(silentDiffJson.silence?.primaryReason, 'no_changed_files');
      assertMatchesSchema(silentDiffJson, 'diff.schema.json');

      // Edit one member of the 3-way family -> diff --json and bare default command ('diff' mode)
      repo.write('src/adapter/bun/serve-static.ts', 'export const bunServe = 999;\n');

      const activeDiffRes = runCli(['diff', '--limit', '1', '--json'], repo.dir);
      assert.equal(activeDiffRes.code, 0, activeDiffRes.stderr);
      const activeDiffJson = JSON.parse(activeDiffRes.stdout);
      assert.equal(activeDiffJson.suggestions.length, 1);
      assert.equal(activeDiffJson.totalSuggestions, 2);
      assert.ok(activeDiffJson.families.length >= 1);
      assert.equal(activeDiffJson.silence, undefined);
      assertMatchesSchema(activeDiffJson, 'diff.schema.json');

      // Forward-compatibility: additive fields keep schemaVersion: 1 valid
      assertMatchesSchema(
        { ...activeDiffJson, futureAdditiveField: 'allowed-in-v1' },
        'diff.schema.json',
      );

      const defaultDiffRes = runCli(['--json'], repo.dir);
      assert.equal(defaultDiffRes.code, 0, defaultDiffRes.stderr);
      const defaultDiffJson = JSON.parse(defaultDiffRes.stdout);
      assert.equal(defaultDiffJson.mode, 'diff');
      assert.ok(defaultDiffJson.suggestions.length >= 2);
      for (const s of defaultDiffJson.suggestions) {
        assert.ok(s.interval, 'diff suggestion must expose interval');
        assert.ok(s.reverseInterval, 'diff suggestion must expose reverseInterval');
        assert.ok(
          s.interval.low <= s.confidence && s.confidence <= s.interval.high,
          `expected ${s.interval.low} <= ${s.confidence} <= ${s.interval.high}`,
        );
        assert.ok(
          s.reverseInterval.low <= s.reverseConfidence && s.reverseConfidence <= s.reverseInterval.high,
          `expected ${s.reverseInterval.low} <= ${s.reverseConfidence} <= ${s.reverseInterval.high}`,
        );
        assert.equal(Math.round(s.interval.low * 10000) / 10000, s.interval.low);
        assert.equal(Math.round(s.interval.high * 10000) / 10000, s.interval.high);
      }
      for (const fam of defaultDiffJson.families) {
        for (const rel of fam.relationships) {
          assert.ok(rel.interval, 'diff family relationship must expose interval');
          assert.ok(rel.reverseInterval, 'diff family relationship must expose reverseInterval');
          assert.ok(rel.interval.low <= rel.confidence && rel.confidence <= rel.interval.high);
        }
      }
      assertMatchesSchema(defaultDiffJson, 'default.schema.json');

      // With --half-life set, interval and reverseInterval are unchanged (unweighted) while score may differ
      const editApiRes = (() => {
        repo.write('src/api.ts', "import { db } from './db';\nexport const api = db + 999;\n");
        const flatRes = runCli(['diff', '--json'], repo.dir);
        const weightedRes = runCli(['diff', '--half-life', '1', '--json'], repo.dir);
        return { flat: JSON.parse(flatRes.stdout), weighted: JSON.parse(weightedRes.stdout) };
      })();
      assertMatchesSchema(editApiRes.weighted, 'diff.schema.json');
      const flatDb = editApiRes.flat.suggestions.find((s: { to: string }) => s.to === 'src/db.ts');
      const weightedDb = editApiRes.weighted.suggestions.find((s: { to: string }) => s.to === 'src/db.ts');
      assert.ok(flatDb && weightedDb, 'expected src/db.ts suggestion in both flat and weighted diff runs');
      assert.deepEqual(weightedDb.interval, flatDb.interval, 'interval must remain unweighted when --half-life is set');
      assert.deepEqual(
        weightedDb.reverseInterval,
        flatDb.reverseInterval,
        'reverseInterval must remain unweighted when --half-life is set',
      );
      assert.equal(weightedDb.weighted, true);
      assert.notEqual(weightedDb.score, flatDb.score, 'score should reflect recency weighting when --half-life is set');
    } finally {
      repo.git('checkout', '-q', '--', '.');
    }
  });

  it('supports single-pass diff --format markdown --json-out <file> and enforces flag/path guards', () => {
    const tmpOutDir = mkdtempSync(join(tmpdir(), 'repo-arch-json-out-'));
    try {
      repo.write('src/adapter/bun/serve-static.ts', 'export const bunServe = 777;\n');
      const jsonOutPath = join(tmpOutDir, 'nested', 'diff-report.json');

      const res = runCli(['diff', '--format', 'markdown', '--json-out', jsonOutPath], repo.dir);
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stdout, /^## Repo Archaeology/m);
      assert.match(res.stdout, /### Finding families \(1\)/);
      assert.match(res.stdout, /### Possibly missed \(2\)/);
      assert.ok(existsSync(jsonOutPath), 'expected --json-out file to be written');

      const writtenJson = JSON.parse(readFileSync(jsonOutPath, 'utf8'));
      assert.equal(writtenJson.schemaVersion, 1);
      assert.equal(writtenJson.suggestions.length, 2);
      assertMatchesSchema(writtenJson, 'diff.schema.json');

      // Mutual exclusion: --json and --format markdown on stdout
      const conflictRes = runCli(['diff', '--json', '--format', 'markdown'], repo.dir);
      assert.equal(conflictRes.code, 2);
      assert.match(conflictRes.stderr, /--json and --format markdown cannot be used together/);

      // Security guards on --json-out
      assert.throws(() => validateJsonOutPath('   '), /--json-out requires a valid file path/);
      assert.throws(() => validateJsonOutPath('bad\u0000path.json'), /--json-out requires a valid file path/);
      assert.throws(
        () => validateJsonOutPath(tmpOutDir),
        /--json-out path points to a directory/,
      );
      assert.throws(
        () => validateJsonOutPath(join(repo.dir, '.git', 'config')),
        /--json-out cannot write directly into \.git internal directories/,
      );
      assert.throws(
        () => validateJsonOutPath(join(repo.dir, '.git', 'hooks', 'pre-commit')),
        /--json-out cannot write directly into \.git internal directories/,
      );
      assert.throws(
        () => validateJsonOutPath(join(repo.dir, '.GIT', 'config')),
        /--json-out cannot write directly into \.git internal directories/,
      );

      // Allowed inside .git/repo-archaeology/
      const allowedGitScratch = validateJsonOutPath(join(repo.dir, '.git', 'repo-archaeology', 'diff.json'));
      assert.ok(allowedGitScratch.endsWith(join('.git', 'repo-archaeology', 'diff.json')));

      // Rejects writing through a symbolic link
      const targetFile = join(tmpOutDir, 'real.json');
      writeFileSync(targetFile, '{}');
      const symlinkFile = join(tmpOutDir, 'link.json');
      symlinkSync(targetFile, symlinkFile);
      assert.throws(
        () => writeJsonContractFile(symlinkFile, { hello: 'world' }),
        /--json-out refuses to write through a symbolic link/,
      );

      // Rejects existing non-regular files (e.g. character devices like /dev/null on POSIX)
      if (process.platform !== 'win32' && existsSync('/dev/null')) {
        assert.throws(
          () => validateJsonOutPath('/dev/null'),
          /--json-out target must be a regular file/,
        );
      }

      // Enforces REPO_ARCHAEOLOGY_JSON_OUT_ROOT / allowedRoot containment
      const subAllowed = join(tmpOutDir, 'allowed');
      mkdirSync(subAllowed, { recursive: true });
      assert.throws(
        () => validateJsonOutPath(join(tmpOutDir, 'outside.json'), { allowedRoot: subAllowed }),
        /--json-out path must stay within/,
      );
    } finally {
      repo.git('checkout', '-q', '--', '.');
      rmSync(tmpOutDir, { recursive: true, force: true });
    }
  });

  it('shared schema validator rejects invalid payloads, unknown schema keywords, and enforces sibling keywords beside $ref', () => {
    const validTool = { name: 'repo-archaeology', version: '0.3.0' };
    const toolSchema = resolveSchemaNodeForTest('common.schema.json#/$defs/ToolInfo');

    const badErrors: string[] = [];
    validateSchemaNode(SCHEMA_DIR, { name: 'wrong', version: '' }, toolSchema, 'common.schema.json', '$', badErrors);
    assert.ok(badErrors.length >= 2, `expected errors for invalid ToolInfo, got: ${badErrors.join('; ')}`);

    // Rejects unsupported JSON Schema keywords instead of silently skipping them
    assert.throws(
      () => {
        const errs: string[] = [];
        validateSchemaNode(
          SCHEMA_DIR,
          validTool,
          { type: 'object', anyOf: [{ required: ['name'] }] },
          'common.schema.json',
          '$',
          errs,
        );
      },
      /Unsupported JSON Schema keyword 'anyOf'/,
    );

    // Enforces sibling keywords alongside $ref
    const siblingErrs: string[] = [];
    validateSchemaNode(
      SCHEMA_DIR,
      validTool,
      {
        $ref: 'common.schema.json#/$defs/ToolInfo',
        properties: {
          version: { type: 'string', pattern: '^99\\.' },
        },
      },
      'common.schema.json',
      '$',
      siblingErrs,
    );
    assert.equal(siblingErrs.length, 1);
    assert.match(siblingErrs[0]!, /does not match pattern \^99\\\./);
  });
});

function resolveSchemaNodeForTest(ref: string): JsonSchemaNode {
  const [file, pointer] = ref.split('#/$defs/');
  const root = loadSchema(file!);
  return root.$defs![pointer!]!;
}
