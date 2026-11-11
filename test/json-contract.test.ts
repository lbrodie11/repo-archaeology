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
      'import-graph.schema.json',
      'verdicts.schema.json',
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
    assert.equal(pkg.version, '0.13.0');
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

    // 5b. imports --json
    const importsRes = runCli(['imports', '--json'], repo.dir);
    assert.equal(importsRes.code, 0, importsRes.stderr);
    const importsJson = JSON.parse(importsRes.stdout);
    assert.equal(importsJson.schemaVersion, 1);
    assert.deepEqual(importsJson.tool, { name: 'repo-archaeology', version: pkgVersion });
    assert.ok(Array.isArray(importsJson.files));
    assert.ok(Array.isArray(importsJson.edges));
    assert.ok(Array.isArray(importsJson.unresolved));
    assert.ok(Array.isArray(importsJson.languages));
    assertMatchesSchema(importsJson, 'import-graph.schema.json');

    // 6. --head <ref> includes meta.head: { ref, sha } and validates against all schemas
    const headSha = repo.git('rev-parse', 'HEAD~1').trim();
    const headScanRes = runCli(['--head', 'HEAD~1', 'scan', '--json'], repo.dir);
    assert.equal(headScanRes.code, 0, headScanRes.stderr);
    const headScanJson = JSON.parse(headScanRes.stdout);
    assert.deepEqual(headScanJson.meta.head, { ref: 'HEAD~1', sha: headSha });
    assertMatchesSchema(headScanJson, 'scan.schema.json');

    const headDiffRes = runCli(['--head', 'HEAD~1', 'diff', '--base', 'HEAD~2', '--json'], repo.dir);
    assert.equal(headDiffRes.code, 0, headDiffRes.stderr);
    const headDiffJson = JSON.parse(headDiffRes.stdout);
    assert.deepEqual(headDiffJson.meta.head, { ref: 'HEAD~1', sha: headSha });
    assertMatchesSchema(headDiffJson, 'diff.schema.json');
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
      assert.equal(activeDiffJson.suggestions[0].owners, undefined);
      assert.equal(activeDiffJson.suggestions[0].ownersSample, undefined);
      assertMatchesSchema(activeDiffJson, 'diff.schema.json');

      const ownersDiffRes = runCli(['diff', '--owners', '--limit', '1', '--json'], repo.dir);
      assert.equal(ownersDiffRes.code, 0, ownersDiffRes.stderr);
      const ownersDiffJson = JSON.parse(ownersDiffRes.stdout);
      assert.equal(ownersDiffJson.suggestions.length, 1);
      assert.ok(Array.isArray(ownersDiffJson.suggestions[0].owners));
      assert.ok(ownersDiffJson.suggestions[0].owners.length >= 1);
      assert.ok(ownersDiffJson.suggestions[0].ownersSample);
      assertMatchesSchema(ownersDiffJson, 'diff.schema.json');

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
        assert.equal(Math.floor(s.interval.low * 10000) / 10000, s.interval.low);
        assert.equal(Math.ceil(s.interval.high * 10000) / 10000, s.interval.high);
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
        const weightedExplainRes = runCli(['explain', 'src/api.ts', 'src/db.ts', '--half-life', '1'], repo.dir);
        return {
          flat: JSON.parse(flatRes.stdout),
          weighted: JSON.parse(weightedRes.stdout),
          weightedExplainStdout: weightedExplainRes.stdout,
        };
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
      assert.match(
        editApiRes.weightedExplainStdout,
        /\d+ of \d+ commits \(raw 95% CI \d+[–-]\d+%\) \(\d+% recency-weighted\)/,
      );
      assert.doesNotMatch(editApiRes.weightedExplainStdout, /recency-weighted\)\s*\((?:raw )?95% CI/);
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

  it('validates RA-08 origin, originShare, meta.origins, --origin-weights, --compare-origin-weights, v1 schema backward compatibility, and proves rankings, scores, and existing fields are unchanged with a fixture snapshot', () => {
    const r = new FixtureRepo();
    try {
      // 3 human commits touching src/api.ts and src/schema.ts (days 0..2: 2024-01-01..2024-01-03)
      for (let i = 1; i <= 3; i++) {
        r.commit({
          author: 'Alice Human',
          message: `feat: update api and schema ${i}`,
          write: {
            'src/api.ts': `export const v = ${i};\n`,
            'src/schema.ts': `export const s = ${i};\n`,
          },
        });
      }
      // 1 agent commit (via Co-authored-by trailer) touching src/api.ts and src/schema.ts (day 3: 2024-01-04)
      r.commit({
        author: 'Alice Human',
        message: 'feat: agent-assisted update\n\nCo-authored-by: Claude <noreply@anthropic.com>',
        write: {
          'src/api.ts': 'export const v = 4;\n',
          'src/schema.ts': 'export const s = 4;\n',
        },
      });
      // 3 bot commits touching src/api.ts and src/bot-partner.ts (days 4..6: 2024-01-05..2024-01-07)
      for (let i = 1; i <= 3; i++) {
        r.commit({
          author: 'dependabot[bot]',
          message: `chore(deps): bump dep ${i}`,
          write: {
            'src/api.ts': `export const v = ${10 + i};\n`,
            'src/bot-partner.ts': `export const b = ${i};\n`,
          },
        });
      }
      // 25 more commits touching src/otherA.ts and src/otherB.ts so backtest has >= 30 commits
      for (let i = 1; i <= 25; i++) {
        r.commit({
          author: i % 5 === 0 ? 'copilot-swe-agent[bot]' : 'Alice Human',
          message: `feat: module update ${i}`,
          write: {
            'src/otherA.ts': `export const oa = ${i};\n`,
            'src/otherB.ts': `export const ob = ${i};\n`,
          },
        });
      }

      // Modify src/api.ts in the working tree for `diff`
      writeFileSync(join(r.dir, 'src/api.ts'), 'export const v = 999;\n', 'utf8');

      // 1. Producer always emits `meta.origins`, `originShare`, and `evidence[].origin`
      const diffDefaultRes = runCli(['diff', '--json'], r.dir);
      assert.equal(diffDefaultRes.code, 0, diffDefaultRes.stderr);
      const diffDefaultJson = JSON.parse(diffDefaultRes.stdout);
      assertMatchesSchema(diffDefaultJson, 'diff.schema.json');

      const scanDefaultRes = runCli(['scan', '--json'], r.dir);
      assert.equal(scanDefaultRes.code, 0, scanDefaultRes.stderr);
      const scanDefaultJson = JSON.parse(scanDefaultRes.stdout);
      assertMatchesSchema(scanDefaultJson, 'scan.schema.json');

      assert.deepEqual(diffDefaultJson.meta.origins, { human: 23, agent: 6, bot: 3 });
      assert.ok(Array.isArray(diffDefaultJson.suggestions) && diffDefaultJson.suggestions.length === 2);
      for (const s of diffDefaultJson.suggestions) {
        assert.ok(s.originShare && typeof s.originShare === 'object');
        assert.equal(
          Math.round((s.originShare.human + s.originShare.agent + s.originShare.bot) * 1000),
          1000,
        );
        for (const ev of s.evidence) {
          assert.ok(['human', 'agent', 'bot'].includes(ev.origin));
        }
      }

      const apiSchemaSugg = diffDefaultJson.suggestions.find((s: { to: string }) => s.to === 'src/schema.ts');
      const apiBotSugg = diffDefaultJson.suggestions.find((s: { to: string }) => s.to === 'src/bot-partner.ts');
      assert.deepEqual(apiSchemaSugg.originShare, { human: 0.75, agent: 0.25, bot: 0 });
      assert.deepEqual(apiBotSugg.originShare, { human: 0, agent: 0, bot: 1 });

      // 2. v1 Schema backward-compatibility: pre-RA-08 / pre-RA-04 v1 payloads (without origins, originShare, origin, or cache) remain valid
      assert.deepEqual(diffDefaultJson.meta.cache, {
        enabled: true,
        hits: 0,
        misses: 32,
        dir: '.git/repo-archaeology/cache',
      });
      assert.deepEqual(scanDefaultJson.meta.cache, {
        enabled: true,
        hits: 32,
        misses: 0,
        dir: '.git/repo-archaeology/cache',
      });
      const legacyScan = structuredClone(scanDefaultJson);
      delete legacyScan.meta.origins;
      delete legacyScan.meta.cache;
      for (const rel of legacyScan.relationships) {
        delete rel.originShare;
        for (const ev of rel.evidence) delete ev.origin;
      }
      assertMatchesSchema(legacyScan, 'scan.schema.json');

      const legacyDiff = structuredClone(diffDefaultJson);
      delete legacyDiff.meta.origins;
      delete legacyDiff.meta.cache;
      for (const s of legacyDiff.suggestions) {
        delete s.originShare;
        for (const ev of s.evidence) delete ev.origin;
      }
      assertMatchesSchema(legacyDiff, 'diff.schema.json');

      // Invalid values for `meta.cache` are rejected by the schema
      const badCache = structuredClone(diffDefaultJson);
      badCache.meta.cache = { enabled: true, hits: -1, misses: 0 };
      const badCacheErrs: string[] = [];
      validateSchemaNode(SCHEMA_DIR, badCache, loadSchema('diff.schema.json'), 'diff.schema.json', '$', badCacheErrs);
      assert.ok(badCacheErrs.some((e) => e.includes('hits')), `expected schema error for invalid meta.cache.hits, got: ${badCacheErrs.join('; ')}`);

      // Invalid values for `origin` or `originShare` are rejected by the schema
      const badOrigin = structuredClone(diffDefaultJson);
      badOrigin.suggestions[0].evidence[0].origin = 'alien';
      const badOriginErrs: string[] = [];
      validateSchemaNode(SCHEMA_DIR, badOrigin, loadSchema('diff.schema.json'), 'diff.schema.json', '$', badOriginErrs);
      assert.ok(badOriginErrs.some((e) => e.includes('origin')), `expected schema error for invalid origin, got: ${badOriginErrs.join('; ')}`);

      const badOriginShare = structuredClone(diffDefaultJson);
      badOriginShare.suggestions[0].originShare = { human: 2, agent: 0, bot: 0 };
      const badShareErrs: string[] = [];
      validateSchemaNode(SCHEMA_DIR, badOriginShare, loadSchema('diff.schema.json'), 'diff.schema.json', '$', badShareErrs);
      assert.ok(badShareErrs.some((e) => e.includes('originShare')), `expected schema error for invalid originShare, got: ${badShareErrs.join('; ')}`);

      // 3. Fixture snapshot: prove rankings, scores, and existing fields are unchanged when no weights are set
      const normalizeExistingFieldsSnapshot = (payload: Record<string, unknown>) => {
        const clone = structuredClone(payload) as {
          meta: {
            root: string;
            settings: Record<string, unknown>;
          };
          evaluation?: { headSha?: string; baselineSha?: string; effectiveOptions: Record<string, unknown> };
          suggestions: Array<{
            from: string;
            to: string;
            relationship: string;
            shared: number;
            fromChanges: number;
            toChanges: number;
            confidence: number;
            reverseConfidence: number;
            score: number;
            weighted: boolean;
            lastTogether: string;
            crossesDirectories: boolean;
            evidence: Array<{ date: string; author: string; subject: string }>;
          }>;
        };
        return {
          settings: clone.meta.settings,
          effectiveOptions: clone.evaluation?.effectiveOptions,
          suggestions: clone.suggestions.map((s) => ({
            from: s.from,
            to: s.to,
            relationship: s.relationship,
            shared: s.shared,
            fromChanges: s.fromChanges,
            toChanges: s.toChanges,
            confidence: s.confidence,
            reverseConfidence: s.reverseConfidence,
            score: s.score,
            weighted: s.weighted,
            lastTogether: s.lastTogether,
            crossesDirectories: s.crossesDirectories,
            evidence: s.evidence.map((e) => ({
              date: e.date,
              author: e.author,
              subject: e.subject,
            })),
          })),
        };
      };

      const expectedSnapshot = JSON.stringify(
        {
          settings: {
            maxCommits: 5000,
            maxFilesPerCommit: 25,
            minShared: 3,
            minConfidence: 0.4,
            ignore: [],
            useDefaultIgnores: true,
          },
          effectiveOptions: {
            minShared: 3,
            minConfidence: 0.4,
            maxCommits: 5000,
            maxFilesPerCommit: 25,
          },
          suggestions: [
            {
              from: 'src/api.ts',
              to: 'src/schema.ts',
              relationship: 'ghost',
              shared: 4,
              fromChanges: 7,
              toChanges: 4,
              confidence: 0.571,
              reverseConfidence: 1,
              score: 0.25,
              weighted: false,
              lastTogether: '2024-01-04',
              crossesDirectories: false,
              evidence: [
                { date: '2024-01-04', author: 'Alice Human', subject: 'feat: agent-assisted update' },
                { date: '2024-01-03', author: 'Alice Human', subject: 'feat: update api and schema 3' },
                { date: '2024-01-02', author: 'Alice Human', subject: 'feat: update api and schema 2' },
              ],
            },
            {
              from: 'src/api.ts',
              to: 'src/bot-partner.ts',
              relationship: 'ghost',
              shared: 3,
              fromChanges: 7,
              toChanges: 3,
              confidence: 0.429,
              reverseConfidence: 1,
              score: 0.158,
              weighted: false,
              lastTogether: '2024-01-07',
              crossesDirectories: false,
              evidence: [
                { date: '2024-01-07', author: 'dependabot[bot]', subject: 'chore(deps): bump dep 3' },
                { date: '2024-01-06', author: 'dependabot[bot]', subject: 'chore(deps): bump dep 2' },
                { date: '2024-01-05', author: 'dependabot[bot]', subject: 'chore(deps): bump dep 1' },
              ],
            },
          ],
        },
        null,
        2,
      );
      assert.equal(JSON.stringify(normalizeExistingFieldsSnapshot(diffDefaultJson), null, 2), expectedSnapshot);

      // Terminal output with no weights vs explicit human=1,agent=1,bot=1 is identical
      const diffTextDefault = runCli(['diff'], r.dir);
      const diffTextExplicitOne = runCli(['diff', '--origin-weights', 'human=1,agent=1,bot=1'], r.dir);
      assert.equal(diffTextDefault.code, 0);
      assert.equal(diffTextDefault.stdout, diffTextExplicitOne.stdout);

      // 4. Opt-in weighting via CLI `--origin-weights bot=0,agent=0.5` drops bot-only companion, sets weighting="origin", adjusts confidence, and keeps interval/reverseInterval raw
      const diffWeightedRes = runCli(['diff', '--origin-weights', 'bot=0,agent=0.5', '--json'], r.dir);
      assert.equal(diffWeightedRes.code, 0, diffWeightedRes.stderr);
      const diffWeightedJson = JSON.parse(diffWeightedRes.stdout);
      assertMatchesSchema(diffWeightedJson, 'diff.schema.json');
      assert.deepEqual(
        diffWeightedJson.suggestions.map((s: { to: string }) => s.to),
        ['src/schema.ts'],
      );
      // Raw shared (4), raw fromChanges (7), and raw Wilson intervals stay identical to the unweighted run
      assert.equal(diffWeightedJson.suggestions[0].shared, 4);
      assert.equal(diffWeightedJson.suggestions[0].fromChanges, 7);
      assert.equal(diffWeightedJson.suggestions[0].weighted, true);
      assert.equal(diffWeightedJson.suggestions[0].weighting, 'origin');
      assert.deepEqual(diffWeightedJson.suggestions[0].interval, apiSchemaSugg.interval);
      assert.deepEqual(diffWeightedJson.suggestions[0].reverseInterval, apiSchemaSugg.reverseInterval);
      // Weighted confidence: (3*1 + 1*0.5) / (3*1 + 1*0.5 + 3*0) = 3.5 / 3.5 = 1
      assert.equal(diffWeightedJson.suggestions[0].confidence, 1);

      // Also verify --origin-weights bot=0 alone keeps interval and reverseInterval identical to unweighted run
      const diffBotZeroRes = runCli(['diff', '--origin-weights', 'bot=0', '--json'], r.dir);
      assert.equal(diffBotZeroRes.code, 0, diffBotZeroRes.stderr);
      const diffBotZeroJson = JSON.parse(diffBotZeroRes.stdout);
      assert.deepEqual(diffBotZeroJson.suggestions[0].interval, apiSchemaSugg.interval);
      assert.deepEqual(diffBotZeroJson.suggestions[0].reverseInterval, apiSchemaSugg.reverseInterval);

      // 5. `backtest --compare-origin-weights bot=0,agent=0.5 --json` validates against schema
      const btCompareRes = runCli(['backtest', '--compare-origin-weights', 'bot=0,agent=0.5', '--json'], r.dir);
      assert.equal(btCompareRes.code, 0, btCompareRes.stderr);
      const btCompareJson = JSON.parse(btCompareRes.stdout);
      assertMatchesSchema(btCompareJson, 'backtest.schema.json');
      assert.ok(Array.isArray(btCompareJson.comparisons) && btCompareJson.comparisons.length === 1);
      assert.equal(btCompareJson.comparisons[0].spec, 'bot=0,agent=0.5');
      assert.deepEqual(btCompareJson.comparisons[0].weights, { human: 1, agent: 0.5, bot: 0 });
      assert.equal('delta' in btCompareJson.comparisons[0], false);
    } finally {
      r.cleanup();
    }
  });

  it('validates RA-09B import-graph edge via/heuristic, unresolved reasonCode, and scoped meta.imports coverage', () => {
    const r = new FixtureRepo();
    try {
      r.write(
        'package.json',
        JSON.stringify(
          {
            name: 'monorepo-root',
            private: true,
            workspaces: ['packages/*'],
            dependencies: { react: '^18.0.0' },
          },
          null,
          2,
        ),
      );
      r.write(
        'packages/ui/package.json',
        JSON.stringify(
          {
            name: '@acme/ui',
            exports: {
              '.': './dist/index.js',
              './internal': null,
            },
          },
          null,
          2,
        ),
      );
      r.write('packages/ui/src/index.ts', 'export const Button = () => "button";\n');
      r.write(
        'packages/app/package.json',
        JSON.stringify(
          {
            name: '@acme/app',
            imports: {
              '#config': './src/config.ts',
            },
          },
          null,
          2,
        ),
      );
      r.write('packages/app/src/config.ts', 'export const cfg = { port: 3000 };\n');
      r.write(
        'packages/app/src/main.ts',
        [
          'import { Button } from "@acme/ui";',
          'import { cfg } from "#config";',
          'import React from "react";',
          'import { secret } from "@acme/ui/internal";',
          'import { ghost } from "undeclared-pkg";',
          'import { alias } from "~/unmapped";',
          'import { missing } from "./missing.js";',
          'export const run = (name: string) => import(name);',
          'export { Button, cfg, React, secret, ghost, alias, missing };',
          '',
        ].join('\n'),
      );
      r.write('README.md', '# Monorepo\n');
      r.git('add', '.');
      r.commit({ message: 'init monorepo', author: 'Alice' });
      for (let i = 1; i <= 3; i++) {
        r.commit({
          message: `feat: update app and ui ${i}`,
          author: 'Alice',
          write: {
            'packages/ui/src/index.ts': `export const Button = () => "button-${i}";\n`,
            'packages/app/src/main.ts': [
              'import { Button } from "@acme/ui";',
              'import { cfg } from "#config";',
              'import React from "react";',
              'import { secret } from "@acme/ui/internal";',
              'import { ghost } from "undeclared-pkg";',
              'import { alias } from "~/unmapped";',
              'import { missing } from "./missing.js";',
              'export const run = (name: string) => import(name);',
              `export const v = ${i};`,
              'export { Button, cfg, React, secret, ghost, alias, missing };',
              '',
            ].join('\n'),
          },
        });
      }

      // 1. Full repository `imports --json` has `meta.imports.scope === 'repository'`
      const importsRes = runCli(['imports', '--json'], r.dir);
      assert.equal(importsRes.code, 0, importsRes.stderr);
      const importsJson = JSON.parse(importsRes.stdout);
      assertMatchesSchema(importsJson, 'import-graph.schema.json');

      assert.equal(importsJson.meta.imports.scope, 'repository');
      assert.equal(importsJson.meta.imports.filesScanned, 3);
      assert.equal(importsJson.meta.imports.internalEdges, 2);
      assert.equal(importsJson.meta.imports.heuristicEdges, 1);
      assert.equal(importsJson.meta.imports.external, 1);
      assert.equal(importsJson.meta.imports.unresolved, 4);
      assert.equal(importsJson.meta.imports.dynamicLoads, 1);
      assert.ok(importsJson.meta.imports.unsupportedFiles >= 1); // README.md / package.json
      assert.deepEqual(importsJson.meta.imports.unresolvedByReason, {
        'alias-unmatched': 1,
        'unknown-package': 1,
        'target-missing': 1,
        'not-exported': 1,
      });

      // Verify additive `via` and `heuristic` on edges
      assert.deepEqual(importsJson.edges, [
        {
          from: 'packages/app/src/main.ts',
          to: 'packages/app/src/config.ts',
          specifier: '#config',
          kind: 'static',
          via: 'imports',
        },
        {
          from: 'packages/app/src/main.ts',
          to: 'packages/ui/src/index.ts',
          specifier: '@acme/ui',
          kind: 'static',
          via: 'exports',
          heuristic: true,
        },
      ]);

      // Verify backwards-compatible `reason: "unmatched"` + additive `reasonCode` on unresolved
      assert.deepEqual(importsJson.unresolved, [
        {
          from: 'packages/app/src/main.ts',
          specifier: './missing.js',
          reason: 'unmatched',
          reasonCode: 'target-missing',
        },
        {
          from: 'packages/app/src/main.ts',
          specifier: '@acme/ui/internal',
          reason: 'unmatched',
          reasonCode: 'not-exported',
        },
        {
          from: 'packages/app/src/main.ts',
          specifier: '~/unmapped',
          reason: 'unmatched',
          reasonCode: 'alias-unmatched',
        },
        {
          from: 'packages/app/src/main.ts',
          specifier: 'undeclared-pkg',
          reason: 'unmatched',
          reasonCode: 'unknown-package',
        },
      ]);

      // 2. Scoped `imports --files <file> --json` has `meta.imports.scope === 'analyzed-files'`
      const scopedImportsRes = runCli(
        ['imports', '--files', 'packages/app/src/config.ts', '--json'],
        r.dir,
      );
      assert.equal(scopedImportsRes.code, 0, scopedImportsRes.stderr);
      const scopedImportsJson = JSON.parse(scopedImportsRes.stdout);
      assertMatchesSchema(scopedImportsJson, 'import-graph.schema.json');
      assert.equal(scopedImportsJson.meta.imports.scope, 'analyzed-files');
      assert.equal(scopedImportsJson.meta.imports.filesScanned, 2); // config.ts + importer main.ts

      // 3. `scan --kinds ... --json` reports `meta.imports.scope === 'analyzed-files'` and classifies @acme/ui <- @acme/app as direct
      const scanRes = runCli(['scan', '--kinds', 'ghost,unknown,indirect,direct,test', '--json'], r.dir);
      assert.equal(scanRes.code, 0, scanRes.stderr);
      const scanJson = JSON.parse(scanRes.stdout);
      assertMatchesSchema(scanJson, 'scan.schema.json');
      assert.equal(scanJson.meta.imports.scope, 'analyzed-files');
      assert.equal(scanJson.meta.imports.filesScanned, 2);
      const uiPair = scanJson.relationships.find(
        (rel: { from: string; to: string }) =>
          (rel.from === 'packages/app/src/main.ts' && rel.to === 'packages/ui/src/index.ts') ||
          (rel.from === 'packages/ui/src/index.ts' && rel.to === 'packages/app/src/main.ts'),
      );
      assert.ok(uiPair, 'expected co-changing pair between main.ts and packages/ui/src/index.ts');
      assert.equal(uiPair.relationship, 'direct');
      assert.match(uiPair.why, /via heuristic source remap/);
    } finally {
      r.cleanup();
    }
  });

  it('validates RA-10 Go and Python output: via "go-package"/"python-module", languages go/python, meta.warnings', () => {
    // A hand-built object carrying the new values validates against the updated schema.
    const edgeSchema = resolveSchemaNodeForTest('import-graph.schema.json#/$defs/ImportGraphEdge');
    for (const via of ['go-package', 'python-module']) {
      const errors: string[] = [];
      validateSchemaNode(SCHEMA_DIR, { from: 'a.go', to: 'b/b.go', specifier: 'example.com/app/b', kind: 'static', via }, edgeSchema, 'import-graph.schema.json', '$', errors);
      assert.deepEqual(errors, [], via);
    }
    const unknownVia: string[] = [];
    validateSchemaNode(SCHEMA_DIR, { from: 'a', to: 'b', specifier: 'b', kind: 'static', via: 'not-a-via' }, edgeSchema, 'import-graph.schema.json', '$', unknownVia);
    assert.ok(unknownVia.length > 0, 'the enum is still closed within one schema release');

    const r = new FixtureRepo();
    try {
      r.commit({
        message: 'initial',
        write: {
          'go.mod': 'module example.com/app\nreplace example.com/gone => ../outside\n',
          'store/store.go': 'package store\nimport "example.com/app/model"\n',
          'store/cache.go': 'package store\n',
          'model/model.go': 'package model\n',
          'src/shop/__init__.py': '',
          'src/shop/cart.py': 'from shop import pricing\nimport requests\n',
          'src/shop/pricing.py': 'RATE = 1\n',
          'web/app.ts': 'export const x = 1;\n',
        },
      });
      for (let i = 0; i < 4; i++) {
        r.commit({
          message: `change ${i}`,
          write: {
            'store/store.go': `package store\nimport "example.com/app/model"\n// ${i}\n`,
            'store/cache.go': `package store\n// ${i}\n`,
            'src/shop/cart.py': `from shop import pricing\nimport requests\n# ${i}\n`,
            'src/shop/pricing.py': `RATE = ${i}\n`,
          },
        });
      }
      const imports = runCli(['imports', '--json'], r.dir);
      assert.equal(imports.code, 0, imports.stderr);
      const graph = JSON.parse(imports.stdout);
      assertMatchesSchema(graph, 'import-graph.schema.json');
      assert.deepEqual(graph.languages, ['go', 'python', 'typescript']);
      assert.deepEqual(
        graph.edges.map((edge: { from: string; to: string; via: string }) => `${edge.from}>${edge.to}:${edge.via}`),
        ['src/shop/cart.py>src/shop/pricing.py:python-module', 'store/store.go>model/model.go:go-package'],
      );
      assert.ok(graph.meta.warnings.some((warning: string) => warning.includes('replaces example.com/gone with ../outside')));
      assert.equal(graph.meta.imports.filesScanned, 7);

      const flags = ['--min-shared', '2', '--min-confidence', '0.3'];
      const scan = runCli(['scan', '--json', ...flags], r.dir);
      assert.equal(scan.code, 0, scan.stderr);
      assertMatchesSchema(JSON.parse(scan.stdout), 'scan.schema.json');
      const explain = runCli(['explain', 'store/store.go', 'store/cache.go', '--json', ...flags], r.dir);
      assert.equal(explain.code, 0, explain.stderr);
      const explainJson = JSON.parse(explain.stdout);
      assertMatchesSchema(explainJson, 'explain.schema.json');
      assert.match(JSON.stringify(explainJson), /same Go package: files share scope without imports/);
      const direct = runCli(['explain', 'src/shop/cart.py', 'src/shop/pricing.py', '--json', ...flags], r.dir);
      assert.equal(direct.code, 0, direct.stderr);
      assertMatchesSchema(JSON.parse(direct.stdout), 'explain.schema.json');
      assert.match(direct.stdout, /cart\.py imports pricing\.py/);
    } finally {
      r.cleanup();
    }
  });
});

/** RA-06 cross-field invariants the per-field schema cannot express. */
function assertTrackRecordInvariants(tr: Record<string, any>, path: string): void {
  if (!('fired' in tr) || tr.reason !== undefined) return;
  assert.ok(0 <= tr.confirmed && tr.confirmed <= tr.fired && tr.fired <= tr.triggers, `${path}: 0 <= confirmed <= fired <= triggers`);
  assert.ok(
    0 <= tr.interval.low && tr.interval.low <= tr.precision && tr.precision <= tr.interval.high && tr.interval.high <= 1,
    `${path}: 0 <= low <= precision <= high <= 1`,
  );
  assert.ok(Math.abs(tr.precision - tr.confirmed / tr.fired) < 1e-4, `${path}: precision = confirmed / fired`);
}

describe('RA-06 trackRecord JSON contract', () => {
  it('diff --json emits schema-valid trackRecord shapes with the documented invariants', () => {
    const r = new FixtureRepo();
    try {
      r.write('src/a.ts', 'a\n');
      r.write('src/b.ts', 'b\n');
      r.write('src/c.ts', 'c\n');
      r.git('add', '.');
      r.commit({ message: 'init' });
      for (let i = 0; i < 9; i++) r.touch(['src/a.ts', 'src/b.ts']);
      for (let i = 0; i < 40; i++) r.touch(['src/c.ts']);
      for (let k = 0; k < 6; k++) {
        r.touch(['src/a.ts']);
        if (k % 2 === 0) r.touch(['src/b.ts']);
      }
      for (let i = 0; i < 41; i++) r.touch(['src/c.ts']);
      r.write('src/a.ts', 'edited\n');
      const res = runCli(['diff', '--json'], r.dir);
      assert.equal(res.code, 0, res.stderr);
      const payload = JSON.parse(res.stdout);
      assertMatchesSchema(payload, 'diff.schema.json');
      const tr = payload.suggestions.find((s: { to: string }) => s.to === 'src/b.ts').trackRecord;
      // Daily commits: the a-only commits at k = 2 and k = 4 fall inside an open 48 h episode, so they
      // are extra triggers, not new episodes.
      assert.deepEqual([tr.fired, tr.confirmed, tr.triggers], [4, 3, 6]);
      assertTrackRecordInvariants(tr, 'suggestions[b].trackRecord');

      const off = JSON.parse(runCli(['diff', '--json', '--no-track-record'], r.dir).stdout);
      assertMatchesSchema(off, 'diff.schema.json');
      assert.equal(off.suggestions.some((s: object) => 'trackRecord' in s), false);
    } finally {
      r.cleanup();
    }
  });

  it('the TrackRecord schema accepts exactly the three documented shapes', () => {
    const schemaRef = { $ref: 'common.schema.json#/$defs/TrackRecord' };
    const errorsFor = (value: unknown): string[] => {
      const errors: string[] = [];
      validateSchemaNode(SCHEMA_DIR, value, schemaRef, 'common.schema.json', '$', errors);
      return errors;
    };
    const evaluated = { from: '2026-03-01', to: '2026-11-01', commits: 500, trainingCommits: 1500 };
    const excluded = { censored: 1, targetDeleted: 0, clockSkew: 0 };
    const full = {
      fired: 5, confirmed: 4, triggers: 7, coChanged: 7, precision: 0.8,
      interval: { low: 0.376, high: 0.964 }, windowHours: 48, evaluated, excluded,
    };
    assertTrackRecordInvariants(full, 'example');
    assert.deepEqual(errorsFor(full), []);
    assert.deepEqual(errorsFor({ fired: 0, reason: 'never_fired' }), []);
    assert.deepEqual(
      errorsFor({ fired: 0, reason: 'never_fired', triggers: 0, coChanged: 0, windowHours: 48, evaluated, excluded }),
      [],
    );
    assert.deepEqual(errorsFor({ reason: 'limited_history' }), []);

    const invalid: [string, unknown][] = [
      ['precision > 1', { ...full, precision: 1.2 }],
      ['interval.low < 0', { ...full, interval: { low: -0.1, high: 0.9 } }],
      ['windowHours 0', { ...full, windowHours: 0 }],
      ['windowHours 721', { ...full, windowHours: 721 }],
      ['fired 0 without reason', { ...full, fired: 0 }],
      ['missing interval', { ...full, interval: undefined }],
      ['unknown reason', { reason: 'not_enough' }],
      ['limited_history with counts', { reason: 'limited_history', fired: 0 }],
      ['never_fired with fired 2', { fired: 2, reason: 'never_fired' }],
      ['never_fired with precision', { fired: 0, reason: 'never_fired', precision: 0 }],
      ['accuracy field', { ...full, accuracy: 0.8 }],
      ['excluded missing clockSkew', { ...full, excluded: { censored: 0, targetDeleted: 0 } }],
      ['evaluated with a timestamp', { ...full, evaluated: { ...evaluated, from: '2026-03-01T00:00:00Z' } }],
    ];
    for (const [label, value] of invalid) {
      const clean = JSON.parse(JSON.stringify(value));
      assert.notDeepEqual(errorsFor(clean), [], `schema should reject ${label}`);
    }
  });
});

describe('RA-19 meta.config JSON contract', () => {
  it('every command reports a schema-valid meta.config for the working tree, --no-config and --config-from', () => {
    const r = new FixtureRepo();
    try {
      r.write('src/a.ts', 'export const a = 0;\n');
      r.write('src/b.ts', 'export const b = 0;\n');
      r.write('.repo-archaeology.json', JSON.stringify({ minShared: 2 }));
      r.git('add', '.');
      r.commit({ message: 'root' });
      for (let i = 1; i <= 34; i++) r.touch(i % 2 === 0 ? ['src/a.ts', 'src/b.ts'] : ['src/a.ts']);
      r.write('src/a.ts', 'export const a = 99;\n');
      const sha = r.git('rev-parse', 'HEAD').trim();
      const commands: [string[], string][] = [
        [['scan'], 'scan.schema.json'],
        [['diff'], 'diff.schema.json'],
        [['file', 'src/a.ts'], 'file.schema.json'],
        [['explain', 'src/a.ts', 'src/b.ts'], 'explain.schema.json'],
        [['backtest'], 'backtest.schema.json'],
        [['imports'], 'import-graph.schema.json'],
        [['map', '--no-open', '-o', join(r.dir, '.git', 'map.html')], 'map.schema.json'],
        [[], 'default.schema.json'],
      ];
      const sources: [string[], unknown][] = [
        [[], { source: 'working-tree' }],
        [['--no-config'], { source: 'none' }],
        [['--config-from', 'HEAD'], { source: 'ref', ref: 'HEAD', sha }],
      ];
      for (const [flags, expected] of sources) {
        for (const [args, schemaFile] of commands) {
          const res = runCli([...args, '--json', '--no-cache', ...flags], r.dir);
          assert.equal(res.code, 0, `${args.join(' ')} ${flags.join(' ')}: ${res.stderr}`);
          const out = JSON.parse(res.stdout);
          assert.equal(out.schemaVersion, JSON_SCHEMA_VERSION);
          assert.deepEqual(out.meta.config, expected, `${args.join(' ') || '(default)'} ${flags.join(' ')}`);
          assertMatchesSchema(out, schemaFile);
          // Payloads from producers that predate RA-19 (no meta.config) stay valid.
          const legacy = structuredClone(out);
          delete legacy.meta.config;
          assertMatchesSchema(legacy, schemaFile);
        }
      }
    } finally {
      r.cleanup();
    }
  });

  it('the ConfigMeta schema accepts exactly the three documented shapes', () => {
    const schemaRef = { $ref: 'common.schema.json#/$defs/ConfigMeta' };
    const errorsFor = (value: unknown): string[] => {
      const errors: string[] = [];
      validateSchemaNode(SCHEMA_DIR, value, schemaRef, 'common.schema.json', '$', errors);
      return errors;
    };
    const sha = 'a'.repeat(40);
    assert.deepEqual(errorsFor({ source: 'working-tree' }), []);
    assert.deepEqual(errorsFor({ source: 'none' }), []);
    assert.deepEqual(errorsFor({ source: 'ref', ref: 'origin/main', sha }), []);
    assert.deepEqual(errorsFor({ source: 'ref', ref: 'v1', sha: 'b'.repeat(64) }), []);
    const invalid: [string, unknown][] = [
      ['unknown source', { source: 'file' }],
      ['missing source', { ref: 'main', sha }],
      ['ref without sha', { source: 'ref', ref: 'main' }],
      ['ref without ref', { source: 'ref', sha }],
      ['empty ref', { source: 'ref', ref: '', sha }],
      ['short sha', { source: 'ref', ref: 'main', sha: 'abc1234' }],
      ['uppercase sha', { source: 'ref', ref: 'main', sha: 'A'.repeat(40) }],
      ['not an object', 'working-tree'],
    ];
    for (const [label, value] of invalid) {
      assert.notDeepEqual(errorsFor(value), [], `schema should reject ${label}`);
    }
  });
});

function resolveSchemaNodeForTest(ref: string): JsonSchemaNode {
  const [file, pointer] = ref.split('#/$defs/');
  const root = loadSchema(file!);
  return root.$defs![pointer!]!;
}
