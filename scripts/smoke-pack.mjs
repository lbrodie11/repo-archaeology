#!/usr/bin/env node
/**
 * Release tarball smoke test (`scripts/smoke-pack.mjs`).
 *
 * 1. Runs `npm pack` into a temporary directory.
 * 2. Creates a throwaway Git repository with ~40 synthetic commits including a known co-change pair.
 * 3. Installs the packed tarball into a separate temporary prefix.
 * 4. Runs `repo-archaeology diff --base <first-branch-point> --json` and `repo-archaeology backtest --json`.
 * 5. Validates both outputs against `schema/diff.schema.json` and `schema/backtest.schema.json`
 *    using a dependency-free recursive JSON Schema validator (supporting `$ref`, `required`, types, enums, and bounds).
 * 6. Exits non-zero on any failure.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, '..');
const SCHEMA_DIR = join(ROOT_DIR, 'schema');

function resolveNpmCliJs(env = process.env) {
  if (env.npm_execpath && existsSync(env.npm_execpath)) {
    return resolve(env.npm_execpath);
  }
  const execDir = dirname(process.execPath);
  const candidates = [
    join(execDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(execDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const pathVar = env.PATH ?? env.Path ?? '';
  for (const dir of pathVar.split(delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    candidates.push(join(trimmed, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    candidates.push(join(trimmed, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && lstatSync(candidate).isFile()) {
        return realpathSync.native(candidate);
      }
    } catch {
      // continue searching
    }
  }
  return undefined;
}

function runNpm(args, cwd) {
  const npmCliJs = resolveNpmCliJs();
  const res = npmCliJs
    ? spawnSync(process.execPath, [npmCliJs, ...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });
  if (res.status !== 0) {
    throw new Error(
      `npm ${args.join(' ')} failed (exit ${res.status}):\n${res.stderr || res.stdout || ''}`.trim(),
    );
  }
  return (res.stdout ?? '').trim();
}

function runGit(cwd, args, extraEnv = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...extraEnv },
  }).trim();
}

const schemaCache = new Map();

function loadSchema(schemaDir, fileName) {
  const key = `${schemaDir}:${fileName}`;
  if (schemaCache.has(key)) return schemaCache.get(key);
  const fullPath = join(schemaDir, fileName);
  const parsed = JSON.parse(readFileSync(fullPath, 'utf8'));
  schemaCache.set(key, parsed);
  return parsed;
}

function resolveSchemaRef(schemaDir, ref, currentSchemaFile) {
  const [filePart, pointerPart] = ref.split('#');
  const targetFile = filePart && filePart.length > 0 ? filePart : currentSchemaFile;
  const rootSchema = loadSchema(schemaDir, targetFile);
  if (!pointerPart || pointerPart === '' || pointerPart === '/') {
    return { node: rootSchema, file: targetFile };
  }
  const segments = pointerPart.replace(/^\//, '').split('/');
  let cursor = rootSchema;
  for (const seg of segments) {
    if (cursor && typeof cursor === 'object' && seg in cursor) {
      cursor = cursor[seg];
    } else {
      throw new Error(`Unresolved JSON Schema $ref '${ref}' in ${currentSchemaFile}`);
    }
  }
  return { node: cursor, file: targetFile };
}

function validateSchemaNode(schemaDir, value, schema, schemaFile, path, errors) {
  if (schema.$ref) {
    const resolved = resolveSchemaRef(schemaDir, schema.$ref, schemaFile);
    validateSchemaNode(schemaDir, value, resolved.node, resolved.file, path, errors);
    return;
  }

  if (schema.oneOf) {
    const branchErrors = [];
    let matchedCount = 0;
    for (const branch of schema.oneOf) {
      const localErrs = [];
      validateSchemaNode(schemaDir, value, branch, schemaFile, path, localErrs);
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
      errors.push(
        `${path}: expected type ${JSON.stringify(schema.type)}, got ${value === null ? 'null' : typeof value}`,
      );
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
        validateSchemaNode(schemaDir, item, schema.items, schemaFile, `${path}[${idx}]`, errors);
      });
    }
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    if (schema.required) {
      for (const reqKey of schema.required) {
        if (!(reqKey in value) || value[reqKey] === undefined) {
          errors.push(`${path}: missing required property '${reqKey}'`);
        }
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) {
          errors.push(`${path}: unexpected additional property '${key}'`);
        }
      }
    }
    if (schema.properties) {
      for (const [propKey, propSchema] of Object.entries(schema.properties)) {
        if (propKey in value && value[propKey] !== undefined) {
          validateSchemaNode(schemaDir, value[propKey], propSchema, schemaFile, `${path}.${propKey}`, errors);
        }
      }
    }
  }
}

function validateAgainstSchema(schemaDir, payload, schemaFile) {
  const schema = loadSchema(schemaDir, schemaFile);
  const errors = [];
  validateSchemaNode(schemaDir, payload, schema, schemaFile, '$', errors);
  if (errors.length > 0) {
    throw new Error(`Schema validation failed against ${schemaFile}:\n  - ${errors.join('\n  - ')}`);
  }
}

function writeRepoFile(repoDir, relPath, content) {
  const fullPath = join(repoDir, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
}

function commitFiles(repoDir, dayOffset, message, files, author = 'Alice') {
  for (const [relPath, content] of Object.entries(files)) {
    writeRepoFile(repoDir, relPath, content);
    runGit(repoDir, ['add', '--', relPath]);
  }
  const baseSeconds = Math.floor(Date.UTC(2025, 0, 1) / 1000);
  const dateStr = `${baseSeconds + dayOffset * 86400} +0000`;
  runGit(
    repoDir,
    ['commit', '-q', '-m', message, `--author=${author} <${author.toLowerCase()}@example.com>`],
    {
      GIT_AUTHOR_DATE: dateStr,
      GIT_COMMITTER_DATE: dateStr,
    },
  );
}

function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'repo-archaeology-smoke-pack-'));
  const packDir = join(tempRoot, 'pack');
  const installDir = join(tempRoot, 'install');
  const repoDir = join(tempRoot, 'repo');

  try {
    mkdirSync(packDir, { recursive: true });
    mkdirSync(installDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });

    const pkg = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8'));

    // 1. Run `npm pack` into packDir.
    console.log('1. Packing tarball with `npm pack`...');
    runNpm(['pack', '--pack-destination', packDir], ROOT_DIR);
    const tarballPath = join(packDir, `${pkg.name}-${pkg.version}.tgz`);
    if (!existsSync(tarballPath)) {
      throw new Error(`Expected tarball at ${tarballPath}, but it was not created.`);
    }

    // 2. Create a throwaway git repo with ~40 synthetic commits including a known co-change pair.
    console.log('2. Creating synthetic Git repository (~40 commits)...');
    runGit(repoDir, ['init', '-q', '-b', 'main']);
    runGit(repoDir, ['config', 'user.name', 'Smoke Tester']);
    runGit(repoDir, ['config', 'user.email', 'smoke@example.com']);
    runGit(repoDir, ['config', 'commit.gpgsign', 'false']);

    let day = 0;
    commitFiles(repoDir, day++, 'chore: initial setup', {
      'src/payments/charge.ts': 'export const chargeVersion = 0;\n',
      'src/payments/ledger.ts': 'export const ledgerVersion = 0;\n',
      'src/auth/session.ts': 'export const sessionVersion = 0;\n',
      'src/auth/token.ts': 'export const tokenVersion = 0;\n',
    });

    // 39 commits on main -> 40 total baseline commits before branching
    for (let i = 1; i <= 39; i++) {
      if (i % 5 === 0) {
        commitFiles(
          repoDir,
          day++,
          `feat(auth): rotate session and token (${i})`,
          {
            'src/auth/session.ts': `export const sessionVersion = ${i};\n`,
            'src/auth/token.ts': `export const tokenVersion = ${i};\n`,
          },
          'Bob',
        );
      } else {
        commitFiles(
          repoDir,
          day++,
          `feat(payments): sync charge and ledger (${i})`,
          {
            'src/payments/charge.ts': `export const chargeVersion = ${i};\n`,
            'src/payments/ledger.ts': `export const ledgerVersion = ${i};\n`,
          },
          'Alice',
        );
      }
    }

    const firstBranchPoint = runGit(repoDir, ['rev-parse', 'HEAD']);
    runGit(repoDir, ['checkout', '-q', '-b', 'feat/charge-only']);
    commitFiles(repoDir, day++, 'feat(payments): update charge without ledger', {
      'src/payments/charge.ts': 'export const chargeVersion = 999;\n',
    });

    // 3. Install the tarball into a separate temp prefix.
    console.log('3. Installing tarball into isolated temp prefix...');
    writeFileSync(join(installDir, 'package.json'), '{"private":true}\n', 'utf8');
    runNpm(['install', '--prefix', installDir, tarballPath, '--no-audit', '--no-fund'], installDir);

    const installedPkgRoot = join(installDir, 'node_modules', 'repo-archaeology');
    const installedCli = join(installedPkgRoot, 'dist', 'cli.js');
    const installedSchemaDir = join(installedPkgRoot, 'schema');
    if (!existsSync(installedCli)) {
      throw new Error(`Installed CLI entry point missing at ${installedCli}`);
    }
    if (!existsSync(join(installedSchemaDir, 'diff.schema.json'))) {
      throw new Error(`Installed schema directory missing diff.schema.json at ${installedSchemaDir}`);
    }

    const runInstalledCli = (args) => {
      const res = spawnSync(process.execPath, [installedCli, ...args], {
        cwd: repoDir,
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
      });
      if (res.status !== 0) {
        throw new Error(
          `repo-archaeology ${args.join(' ')} exited with status ${res.status}:\n${res.stderr || res.stdout}`,
        );
      }
      return JSON.parse(res.stdout);
    };

    // 4. Run `repo-archaeology diff --base <first-branch-point> --json` and `repo-archaeology backtest --json`.
    console.log('4. Running installed `repo-archaeology diff` and `repo-archaeology backtest`...');
    const diffJson = runInstalledCli(['diff', '--base', firstBranchPoint, '--json']);
    const backtestJson = runInstalledCli(['backtest', '--json']);

    // 5. Validate both outputs against schema/diff.schema.json and schema/backtest.schema.json.
    console.log('5. Validating JSON outputs against v1 schemas...');
    validateAgainstSchema(SCHEMA_DIR, diffJson, 'diff.schema.json');
    validateAgainstSchema(SCHEMA_DIR, backtestJson, 'backtest.schema.json');
    // Also verify the schemas shipped inside the tarball itself validate identically.
    validateAgainstSchema(installedSchemaDir, diffJson, 'diff.schema.json');
    validateAgainstSchema(installedSchemaDir, backtestJson, 'backtest.schema.json');

    const hasKnownPair =
      Array.isArray(diffJson.suggestions) &&
      diffJson.suggestions.some(
        (s) =>
          s.from === 'src/payments/charge.ts' &&
          s.to === 'src/payments/ledger.ts' &&
          s.relationship === 'ghost',
      );
    if (!hasKnownPair) {
      throw new Error(
        `Expected diff --json to suggest 'src/payments/ledger.ts' for 'src/payments/charge.ts', got: ${JSON.stringify(
          diffJson.suggestions,
        )}`,
      );
    }

    const hasBacktestStrategies =
      Array.isArray(backtestJson.strategies) &&
      backtestJson.strategies.some((s) => s.name === 'co-change' && s.fired > 0) &&
      backtestJson.strategies.some((s) => s.name === 'popularity, same changes');
    if (!hasBacktestStrategies) {
      throw new Error(
        `Expected backtest --json to include active 'co-change' and 'popularity, same changes' strategies, got: ${JSON.stringify(
          backtestJson.strategies,
        )}`,
      );
    }

    console.log('Smoke test passed: tarball packed, installed, executed, and validated against schemas.');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  console.error(`error: smoke-pack failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
