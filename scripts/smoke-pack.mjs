#!/usr/bin/env node
/**
 * Release tarball smoke test (`scripts/smoke-pack.mjs`).
 *
 * 1. Runs `npm pack --json` into a temporary directory (or `--pack-out <dir>`),
 *    reading the tarball filename and verifying that only `dist/`, `schema/`,
 *    `README.md`, `LICENSE`, and `package.json` are included.
 * 2. Creates a throwaway Git repository with ~40 synthetic commits including a known co-change pair,
 *    stripping all ambient `GIT_*` environment variables so git hooks cannot leak into the outer repo.
 * 3. Installs the packed tarball into a separate temporary prefix.
 * 4. Runs the installed `repo-archaeology` binary (`node_modules/.bin/repo-archaeology` / `npm exec`)
 *    for `diff --base <first-branch-point> --json` and `backtest --json`.
 * 5. Validates both outputs against `schema/diff.schema.json` and `schema/backtest.schema.json`
 *    using the shared recursive JSON Schema validator (`scripts/schema-validator.mjs`).
 * 6. Runs `--style rich` for `scan`, `diff`, `file` and `explain` from the installed tarball, which
 *    has `@frame12/terminal` but neither of its optional peers (`ink`, `react`) (RA-21).
 * 7. Exits non-zero on any failure.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNpmCliJs } from './release-helper.mjs';
import { sanitizeGitEnv, validateAgainstSchema } from './schema-validator.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, '..');
const SCHEMA_DIR = join(ROOT_DIR, 'schema');

const ALLOWED_PACKED_FILE_RE = /^(?:package\.json|README\.md|LICENSE|dist\/.+\.(?:js|d\.ts)|assets\/fonts\/.+\.(?:woff2|txt)|schema\/.+\.schema\.json)$/;

export function assertPackedFileList(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('npm pack --json returned an empty file list.');
  }
  const paths = files.map((entry) => (typeof entry === 'string' ? entry : entry?.path)).filter(Boolean);
  const unexpected = paths.filter((p) => !ALLOWED_PACKED_FILE_RE.test(p));
  if (unexpected.length > 0) {
    throw new Error(
      `Tarball contains unexpected files outside dist/, assets/fonts/, schema/, README.md, LICENSE, package.json: ${unexpected.join(', ')}`,
    );
  }
  for (const requiredFile of ['package.json', 'README.md', 'LICENSE', 'dist/cli.js', 'schema/diff.schema.json', 'schema/backtest.schema.json']) {
    if (!paths.includes(requiredFile)) {
      throw new Error(`Tarball is missing required file '${requiredFile}'.`);
    }
  }
}

function runNpm(args, cwd) {
  const cleanEnv = sanitizeGitEnv(process.env);
  const npmCliJs = resolveNpmCliJs(cleanEnv);
  const res = npmCliJs
    ? spawnSync(process.execPath, [npmCliJs, ...args], {
        cwd,
        env: cleanEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
        cwd,
        env: cleanEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        timeout: 120_000,
      });
  if (res.error) {
    throw new Error(`npm ${args.join(' ')} failed to spawn: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(
      `npm ${args.join(' ')} failed (exit ${res.status}):\n${(res.stderr || res.stdout || '').trim()}`,
    );
  }
  return (res.stdout ?? '').trim();
}

function runGit(cwd, args, extraEnv = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    env: sanitizeGitEnv(process.env, extraEnv),
  }).trim();
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

export function runSmokePack(options = {}) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'repo-archaeology-smoke-pack-'));
  const packDir = join(tempRoot, 'pack');
  const installDir = join(tempRoot, 'install');
  const repoDir = options.repoDir ? resolve(options.repoDir) : join(tempRoot, 'repo');

  try {
    mkdirSync(packDir, { recursive: true });
    mkdirSync(installDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });

    const pkg = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8'));

    // 1. Run `npm pack --json` into packDir and verify packed file list.
    console.log('1. Packing tarball with `npm pack --json`...');
    const packStdout = runNpm(['pack', '--json', '--pack-destination', packDir], ROOT_DIR);
    let packMeta;
    try {
      const parsed = JSON.parse(packStdout);
      packMeta = Array.isArray(parsed) ? parsed[0] : parsed;
    } catch (err) {
      throw new Error(
        `Failed to parse npm pack --json output (${err instanceof Error ? err.message : String(err)}):\n${packStdout}`,
      );
    }
    if (!packMeta || typeof packMeta.filename !== 'string' || !packMeta.filename) {
      throw new Error(`npm pack --json did not return a valid filename: ${packStdout}`);
    }
    assertPackedFileList(packMeta.files);
    const packedPaths = packMeta.files.map((entry) => (typeof entry === 'string' ? entry : entry?.path)).filter(Boolean);
    for (const apiFile of ['dist/api/index.js', 'dist/api/index.d.ts', 'schema/import-graph.schema.json']) {
      if (!packedPaths.includes(apiFile)) {
        throw new Error(`Tarball is missing required library API file '${apiFile}'.`);
      }
    }

    const tarballPath = join(packDir, packMeta.filename);
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
    const installedSchemaDir = join(installedPkgRoot, 'schema');
    const binPathPosix = join(installDir, 'node_modules', '.bin', 'repo-archaeology');
    const binPathWin = join(installDir, 'node_modules', '.bin', 'repo-archaeology.cmd');
    const expectedBin = process.platform === 'win32' ? binPathWin : binPathPosix;
    if (!existsSync(expectedBin)) {
      throw new Error(`Installed CLI bin wrapper missing at ${expectedBin}`);
    }
    if (!existsSync(join(installedSchemaDir, 'diff.schema.json'))) {
      throw new Error(`Installed schema directory missing diff.schema.json at ${installedSchemaDir}`);
    }

    const runInstalledRaw = (args) => {
      const cliEnv = sanitizeGitEnv(process.env, { NO_COLOR: '1' });
      const npmCliJs = resolveNpmCliJs(cliEnv);
      // On POSIX, execute `node_modules/.bin/repo-archaeology` directly to verify both the bin symlink
      // and the `#!/usr/bin/env node` shebang. On Windows, invoke via `npm exec --prefix <installDir>`
      // with `-C <repoDir>` to exercise the installed bin entry without cmd.exe quoting hazards.
      const res =
        process.platform !== 'win32'
          ? spawnSync(binPathPosix, args, {
              cwd: repoDir,
              encoding: 'utf8',
              env: cliEnv,
              stdio: ['ignore', 'pipe', 'pipe'],
              timeout: 120_000,
            })
          : npmCliJs
            ? spawnSync(
                process.execPath,
                [npmCliJs, 'exec', '--prefix', installDir, '--', 'repo-archaeology', '-C', repoDir, ...args],
                {
                  cwd: installDir,
                  encoding: 'utf8',
                  env: cliEnv,
                  stdio: ['ignore', 'pipe', 'pipe'],
                  timeout: 120_000,
                },
              )
            : spawnSync(
                'npm.cmd',
                ['exec', '--prefix', installDir, '--', 'repo-archaeology', '-C', repoDir, ...args],
                {
                  cwd: installDir,
                  encoding: 'utf8',
                  env: cliEnv,
                  stdio: ['ignore', 'pipe', 'pipe'],
                  shell: true,
                  timeout: 120_000,
                },
              );
      if (res.error) {
        throw new Error(`repo-archaeology ${args.join(' ')} failed to spawn: ${res.error.message}`);
      }
      if (res.status !== 0) {
        throw new Error(
          `repo-archaeology ${args.join(' ')} exited with status ${res.status}:\n${res.stderr || res.stdout}`,
        );
      }
      return res;
    };

    const runInstalledCli = (args) => {
      const res = runInstalledRaw(args);
      try {
        return JSON.parse(res.stdout);
      } catch (err) {
        throw new Error(
          `Failed to parse JSON output from 'repo-archaeology ${args.join(' ')}' (${
            err instanceof Error ? err.message : String(err)
          }):\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
        );
      }
    };

    // 4. Run `repo-archaeology diff --base <first-branch-point> --json` and `repo-archaeology backtest --json`.
    console.log('4. Running installed `repo-archaeology diff` and `repo-archaeology backtest`...');
    const diffJson = runInstalledCli(['diff', '--base', firstBranchPoint, '--json']);
    const backtestJson = runInstalledCli(['backtest', '--json']);

    // 5. Validate both outputs against schema/diff.schema.json and schema/backtest.schema.json.
    console.log('5. Validating JSON outputs against v1 schemas...');
    validateAgainstSchema(SCHEMA_DIR, diffJson, 'diff.schema.json');
    validateAgainstSchema(SCHEMA_DIR, backtestJson, 'backtest.schema.json');
    validateAgainstSchema(installedSchemaDir, diffJson, 'diff.schema.json');
    validateAgainstSchema(installedSchemaDir, backtestJson, 'backtest.schema.json');

    // 5b. `--style rich` from the tarball install, without ink or react (RA-21).
    console.log('5b. Running installed `--style rich` for scan, diff, file and explain (no ink, no react)...');
    for (const peer of ['ink', 'react']) {
      if (existsSync(join(installDir, 'node_modules', peer))) {
        throw new Error(`Expected the install to have no '${peer}' (an optional peer of @frame12/terminal), but it is present.`);
      }
    }
    if (!existsSync(join(installDir, 'node_modules', '@frame12', 'terminal', 'package.json'))) {
      throw new Error('Expected @frame12/terminal to be installed as a dependency of repo-archaeology.');
    }
    for (const args of [
      ['scan'],
      ['diff', '--base', firstBranchPoint],
      ['file', 'src/payments/charge.ts'],
      ['explain', 'src/payments/charge.ts', 'src/payments/ledger.ts'],
    ]) {
      const res = runInstalledRaw(['--style', 'rich', ...args]);
      // `·`, or its ASCII twin `-` where @frame12/terminal detects no Unicode (Windows without TERM).
      if (!/^Repo Archaeology [·-] /.test(res.stdout)) {
        throw new Error(`repo-archaeology --style rich ${args.join(' ')} did not print the FRAME/12 masthead:\n${res.stdout}`);
      }
      if (res.stdout.includes('\u001b')) {
        throw new Error(`repo-archaeology --style rich ${args.join(' ')} wrote escape sequences to a pipe.`);
      }
    }

    if (diffJson.tool?.version !== pkg.version) {
      throw new Error(`Expected diff --json tool.version '${pkg.version}', got '${diffJson.tool?.version}'`);
    }

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

    // 6. Verify ESM library API entry point (`import('repo-archaeology')`) and declarations from installed tarball.
    if (!existsSync(join(installedPkgRoot, 'dist', 'api', 'index.d.ts'))) {
      throw new Error(`Installed package missing dist/api/index.d.ts at ${installedPkgRoot}`);
    }
    const apiScript = [
      "import assert from 'node:assert/strict';",
      "import { createRequire } from 'node:module';",
      "import { pathToFileURL } from 'node:url';",
      "import { openRepository } from 'repo-archaeology';",
      "import diffSchema from 'repo-archaeology/schema/diff.schema.json' with { type: 'json' };",
      "import importGraphSchema from 'repo-archaeology/schema/import-graph.schema.json' with { type: 'json' };",
      "import verdictsSchema from 'repo-archaeology/schema/verdicts.schema.json' with { type: 'json' };",
      `const require = createRequire(pathToFileURL(${JSON.stringify(join(installDir, 'package.json'))}).href);`,
      "assert.equal(diffSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');",
      "assert.equal(importGraphSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');",
      "assert.equal(verdictsSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');",
      "assert.ok(require.resolve('repo-archaeology/schema/diff.schema.json').endsWith('diff.schema.json'));",
      "assert.ok(require.resolve('repo-archaeology').endsWith('index.js'));",
      "const [nodeMaj, nodeMin] = process.versions.node.split('.').map(Number);",
      "if (nodeMaj > 22 || (nodeMaj === 22 && nodeMin >= 12)) {",
      "  const cjsMod = require('repo-archaeology');",
      "  assert.equal(typeof cjsMod.openRepository, 'function');",
      "}",
      `const repo = await openRepository({ cwd: ${JSON.stringify(repoDir)}, base: ${JSON.stringify(firstBranchPoint)} });`,
      'try {',
      '  const [d, bt, ig] = await Promise.all([repo.diff(), repo.backtest(), repo.importGraph()]);',
      '  process.stdout.write(JSON.stringify({ d, bt, ig }));',
      '} finally {',
      '  await repo.close();',
      '}',
    ].join('\n');
    const apiRes = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', '--input-type=module', '-e', apiScript], {
      cwd: installDir,
      encoding: 'utf8',
      env: sanitizeGitEnv(process.env, { NO_COLOR: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    if (apiRes.status !== 0) {
      throw new Error(`Library API import('repo-archaeology') failed:\n${apiRes.stderr || apiRes.stdout}`);
    }
    if (apiRes.stderr !== '') {
      throw new Error(`Library API wrote unexpected output to stderr:\n${apiRes.stderr}`);
    }
    const apiParsed = JSON.parse(apiRes.stdout);
    validateAgainstSchema(SCHEMA_DIR, apiParsed.d, 'diff.schema.json');
    validateAgainstSchema(SCHEMA_DIR, apiParsed.bt, 'backtest.schema.json');
    validateAgainstSchema(SCHEMA_DIR, apiParsed.ig, 'import-graph.schema.json');

    let exportedTarballPath;
    if (options.packOutDir) {
      const destDir = resolve(options.packOutDir);
      mkdirSync(destDir, { recursive: true });
      exportedTarballPath = join(destDir, packMeta.filename);
      copyFileSync(tarballPath, exportedTarballPath);
      writeFileSync(join(destDir, 'tarball-filename.txt'), `${packMeta.filename}\n`, 'utf8');
    }

    console.log('Smoke test passed: tarball packed, installed, executed, and validated against schemas.');
    return {
      filename: packMeta.filename,
      tarballPath: exportedTarballPath,
      filesCount: packMeta.files.length,
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function parseSmokeArgs(argv) {
  let packOutDir;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pack-out') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('Missing directory path after --pack-out');
      }
      packOutDir = next;
      i++;
    }
  }
  return { packOutDir };
}

const isMain =
  process.argv[1] !== undefined &&
  (() => {
    try {
      return realpathSync.native(resolve(process.argv[1])) === realpathSync.native(fileURLToPath(import.meta.url));
    } catch {
      return false;
    }
  })();

if (isMain) {
  try {
    const opts = parseSmokeArgs(process.argv.slice(2));
    runSmokePack(opts);
  } catch (err) {
    console.error(`error: smoke-pack failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
