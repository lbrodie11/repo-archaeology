import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { getToolVersion, JSON_SCHEMA_VERSION, validateJsonOutPath, writeJsonContractFile } from '../src/report/contract.js';
import { FixtureRepo } from './helpers.js';

const ROOT_DIR = join(import.meta.dirname, '..');
const SCHEMA_DIR = join(ROOT_DIR, 'schema');
const CLI = join(ROOT_DIR, 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');

function runCli(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, ['--import', TSX, CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...extraEnv },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

interface JsonSchemaNode {
  $schema?: string;
  $id?: string;
  $ref?: string;
  title?: string;
  description?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  oneOf?: JsonSchemaNode[];
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  minItems?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  minLength?: number;
  pattern?: string;
  $defs?: Record<string, JsonSchemaNode>;
}

const schemaCache = new Map<string, JsonSchemaNode>();

function loadSchema(fileName: string): JsonSchemaNode {
  const cached = schemaCache.get(fileName);
  if (cached) return cached;
  const fullPath = join(SCHEMA_DIR, fileName);
  const parsed = JSON.parse(readFileSync(fullPath, 'utf8')) as JsonSchemaNode;
  schemaCache.set(fileName, parsed);
  return parsed;
}

function resolveSchemaRef(ref: string, currentSchemaFile: string): { node: JsonSchemaNode; file: string } {
  const [filePart, pointerPart] = ref.split('#');
  const targetFile = filePart && filePart.length > 0 ? filePart : currentSchemaFile;
  const rootSchema = loadSchema(targetFile);
  if (!pointerPart || pointerPart === '' || pointerPart === '/') {
    return { node: rootSchema, file: targetFile };
  }
  const segments = pointerPart.replace(/^\//, '').split('/');
  let cursor: unknown = rootSchema;
  for (const seg of segments) {
    if (cursor && typeof cursor === 'object' && seg in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[seg];
    } else {
      throw new Error(`Unresolved JSON Schema $ref '${ref}' in ${currentSchemaFile}`);
    }
  }
  return { node: cursor as JsonSchemaNode, file: targetFile };
}

function validateSchemaNode(
  value: unknown,
  schema: JsonSchemaNode,
  schemaFile: string,
  path: string,
  errors: string[],
): void {
  if (schema.$ref) {
    const resolved = resolveSchemaRef(schema.$ref, schemaFile);
    validateSchemaNode(value, resolved.node, resolved.file, path, errors);
    return;
  }

  if (schema.oneOf) {
    const branchErrors: string[][] = [];
    let matchedCount = 0;
    for (const branch of schema.oneOf) {
      const localErrs: string[] = [];
      validateSchemaNode(value, branch, schemaFile, path, localErrs);
      if (localErrs.length === 0) {
        matchedCount++;
      } else {
        branchErrors.push(localErrs);
      }
    }
    if (matchedCount !== 1) {
      errors.push(
        `${path}: expected value to match exactly 1 oneOf branch (matched ${matchedCount}): ${branchErrors
          .map((b) => b.join('; '))
          .join(' | ')}`,
      );
    }
    return;
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    return;
  }

  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${path}: expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
    return;
  }

  if (schema.type !== undefined) {
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matchesType = allowedTypes.some((t) => {
      if (t === 'null') return value === null;
      if (t === 'array') return Array.isArray(value);
      if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
      if (t === 'number') return typeof value === 'number' && Number.isFinite(value);
      if (t === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
      return typeof value === t;
    });
    if (!matchesType) {
      errors.push(`${path}: expected type ${JSON.stringify(schema.type)}, got ${value === null ? 'null' : typeof value}`);
      return;
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: string length ${value.length} < minLength ${schema.minLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: string ${JSON.stringify(value)} does not match pattern ${schema.pattern}`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: number ${value} < minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: number ${value} > maximum ${schema.maximum}`);
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      errors.push(`${path}: number ${value} <= exclusiveMinimum ${schema.exclusiveMinimum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: array length ${value.length} < minItems ${schema.minItems}`);
    }
    if (schema.items) {
      value.forEach((item, idx) => {
        validateSchemaNode(item, schema.items!, schemaFile, `${path}[${idx}]`, errors);
      });
    }
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (schema.required) {
      for (const reqKey of schema.required) {
        if (!(reqKey in record) || record[reqKey] === undefined) {
          errors.push(`${path}: missing required property '${reqKey}'`);
        }
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(record)) {
        if (!(key in schema.properties)) {
          errors.push(`${path}: unexpected additional property '${key}'`);
        }
      }
    }
    if (schema.properties) {
      for (const [propKey, propSchema] of Object.entries(schema.properties)) {
        if (propKey in record && record[propKey] !== undefined) {
          validateSchemaNode(record[propKey], propSchema, schemaFile, `${path}.${propKey}`, errors);
        }
      }
    }
  }
}

function assertMatchesSchema(value: unknown, schemaFile: string): void {
  const schema = loadSchema(schemaFile);
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  const errors: string[] = [];
  validateSchemaNode(value, schema, schemaFile, '$', errors);
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
    assertMatchesSchema(scanJson, 'scan.schema.json');

    // 2. file --json
    const fileRes = runCli(['file', 'src/adapter/bun/serve-static.ts', '--json'], repo.dir);
    assert.equal(fileRes.code, 0, fileRes.stderr);
    const fileJson = JSON.parse(fileRes.stdout);
    assert.equal(fileJson.schemaVersion, 1);
    assert.deepEqual(fileJson.tool, { name: 'repo-archaeology', version: pkgVersion });
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

      const activeDiffRes = runCli(['diff', '--json'], repo.dir);
      assert.equal(activeDiffRes.code, 0, activeDiffRes.stderr);
      const activeDiffJson = JSON.parse(activeDiffRes.stdout);
      assert.ok(activeDiffJson.suggestions.length >= 2);
      assert.ok(activeDiffJson.families.length >= 1);
      assert.equal(activeDiffJson.silence, undefined);
      assertMatchesSchema(activeDiffJson, 'diff.schema.json');

      const defaultDiffRes = runCli(['--json'], repo.dir);
      assert.equal(defaultDiffRes.code, 0, defaultDiffRes.stderr);
      const defaultDiffJson = JSON.parse(defaultDiffRes.stdout);
      assert.equal(defaultDiffJson.mode, 'diff');
      assert.ok(defaultDiffJson.suggestions.length >= 2);
      assertMatchesSchema(defaultDiffJson, 'default.schema.json');
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
});
