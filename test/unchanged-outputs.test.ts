/**
 * RA-21 · outputs that `--style rich` must never touch.
 *
 * The goldens under `test/fixtures/golden-unchanged/` were recorded from `main` (6c8083d) before
 * `--style rich` moved to `@frame12/terminal`. They pin the classic terminal output, `--json`
 * (classic and rich), `diff --format markdown` (classic and rich), the HTML map in both styles,
 * and exit codes for the four rich commands and the bare CLI. Only run-specific values are
 * normalized: the fixture's temporary path, the tool version, relative times ("3 months ago",
 * which move with the clock) and the map's `generatedAt`.
 *
 * Re-record only for an intentional, reviewed change to one of these outputs:
 *   UPDATE_GOLDEN=1 node --import tsx --test test/unchanged-outputs.test.ts
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { sanitizeGitEnv } from '../scripts/schema-validator.mjs';
import { buildAppFixture, buildWorkspaceFixture } from './fixtures/import-fixtures.js';
import type { FixtureRepo } from './helpers.js';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');
const GOLDEN_DIR = join(import.meta.dirname, 'fixtures', 'golden-unchanged');
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;

const FLAGS = ['--min-shared', '2', '--min-confidence', '0.3', '--no-cache'];

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, env: Record<string, string> = {}): Promise<Run> {
  const childEnv: NodeJS.ProcessEnv = sanitizeGitEnv(process.env, { NO_COLOR: '1', TERM: 'xterm-256color', ...env });
  // GitHub Actions sets GITHUB_SERVER_URL/GITHUB_REPOSITORY, which make Markdown link commits:
  // the goldens describe output outside Actions.
  for (const k of Object.keys(childEnv)) if (k.startsWith('GITHUB_')) delete childEnv[k];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', TSX, CLI, ...args], { cwd, env: childEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const RELATIVE_TIME = /\b(?:today|yesterday|\d+ days ago|\d+ months? ago|[\d.]+ years ago)\b/g;

/** Every spelling of a directory the CLI may print: real path, forward slashes (Windows), JSON-escaped. */
function pathSpellings(dir: string): string[] {
  const forms = new Set<string>();
  for (const p of [dir, realpathSync(dir), realpathSync.native(dir)]) {
    for (const q of [p, p.replace(/\\/g, '/')]) {
      forms.add(q);
      forms.add(JSON.stringify(q).slice(1, -1));
    }
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

export function normalizeText(text: string, dir: string): string {
  let out = text;
  for (const p of pathSpellings(dir)) out = out.split(p).join('<repo>');
  // The rest of a path under the fixture uses `/` on every platform (Windows prints `\`, or `\\`
  // inside JSON strings). On POSIX this changes nothing.
  out = out.replace(/<repo>(?:\\\\|\\)[^\s'"`)]*/g, (m) => m.replace(/\\\\|\\/g, '/'));
  return out
    .split(basename(dir))
    .join('<repo-name>')
    .split(VERSION)
    .join('<version>')
    .replace(RELATIVE_TIME, '<ago>')
    .replace(/"generatedAt":\s*"[^"]*"/g, '"generatedAt":"<generatedAt>"')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<timestamp>');
}

function serializeRun(run: Run, dir: string, extra = ''): string {
  return `exit: ${run.code}\n--- stdout\n${normalizeText(run.stdout, dir)}--- stderr\n${normalizeText(run.stderr, dir)}${extra}`;
}

function checkGolden(group: string, name: string, actual: string): void {
  const path = join(GOLDEN_DIR, group, `${name}.txt`);
  if (UPDATE) {
    mkdirSync(join(GOLDEN_DIR, group), { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  assert.ok(existsSync(path), `missing golden ${path}; record it with UPDATE_GOLDEN=1`);
  assert.equal(actual, readFileSync(path, 'utf8'), `${group}/${name}.txt changed`);
}

interface Case {
  name: string;
  args: string[];
}

function casesFor(diffBase: string, file: string, pair: [string, string]): Case[] {
  return [
    { name: 'bare', args: [] },
    { name: 'scan', args: ['scan', '--limit', '50'] },
    { name: 'scan-all-kinds', args: ['scan', '--kinds', 'ghost,unknown,indirect,direct,test'] },
    { name: 'diff', args: ['diff', '--base', diffBase] },
    { name: 'diff-clean', args: ['diff'] },
    { name: 'file', args: ['file', file] },
    { name: 'explain', args: ['explain', ...pair] },
    { name: 'explain-counterexamples', args: ['explain', ...pair, '--counterexamples'] },
    { name: 'error-missing-file', args: ['file', 'no/such/file.ts'] },
    { name: 'error-bad-style', args: ['scan', '--style', 'neon'] },
  ];
}

async function checkGroup(group: string, dir: string, diffBase: string, file: string, pair: [string, string]): Promise<void> {
  const cases = casesFor(diffBase, file, pair);

  // Classic terminal output (and exit codes), with --style classic and the default.
  for (const item of cases) {
    const [classic, explicit] = await Promise.all([
      runCli([...FLAGS, ...item.args], dir),
      runCli([...FLAGS, '--style', 'classic', ...item.args], dir),
    ]);
    if (item.name !== 'error-bad-style') {
      assert.equal(explicit.stdout, classic.stdout, `${group}/${item.name}: --style classic differs from the default`);
    }
    checkGolden(group, `classic-${item.name}`, serializeRun(classic, dir));
  }

  // --json: classic and rich are byte-identical to each other and to the golden.
  for (const item of cases.filter((c) => !c.name.startsWith('error-'))) {
    const [classic, rich] = await Promise.all([
      runCli([...FLAGS, '--json', ...item.args], dir),
      runCli([...FLAGS, '--style', 'rich', '--json', ...item.args], dir),
    ]);
    assert.equal(rich.stdout, classic.stdout, `${group}/${item.name}: --json differs under --style rich`);
    assert.equal(rich.code, classic.code);
    checkGolden(group, `json-${item.name}`, serializeRun(classic, dir));
  }

  // Exit codes for the error cases under --style rich equal classic's.
  for (const item of cases.filter((c) => c.name === 'error-missing-file')) {
    const rich = await runCli([...FLAGS, '--style', 'rich', ...item.args], dir);
    checkGolden(group, `rich-exit-${item.name}`, `exit: ${rich.code}\n--- stderr\n${normalizeText(rich.stderr, dir)}`);
  }

  // diff --format markdown: classic and rich are byte-identical.
  const mdArgs = ['diff', '--base', diffBase, '--format', 'markdown'];
  const [mdClassic, mdRich] = await Promise.all([
    runCli([...FLAGS, ...mdArgs], dir),
    runCli([...FLAGS, '--style', 'rich', ...mdArgs], dir),
  ]);
  assert.equal(mdRich.stdout, mdClassic.stdout);
  checkGolden(group, 'markdown-diff', serializeRun(mdClassic, dir));

  // The HTML map in both styles.
  for (const style of ['classic', 'rich']) {
    const out = join(dir, '.git', `map-${style}.html`);
    const run = await runCli([...FLAGS, 'map', '--no-open', '--style', style, '-o', out], dir);
    checkGolden(group, `map-${style}`, serializeRun(run, dir, `--- html\n${normalizeText(readFileSync(out, 'utf8'), dir)}`));
  }
}

describe('RA-21 · classic, JSON, Markdown, the map and exit codes are byte-identical to main', { concurrency: true }, () => {
  // The classic map seeds its layout from the repository directory name, so each fixture is
  // cloned into a directory with a fixed name (the temporary parent is normalized away). A local
  // clone keeps every commit and SHA; `fs.cpSync` of a `.git` directory fails on macOS runners.
  let parent: string;
  let app: string;
  let mono: string;
  before(() => {
    parent = mkdtempSync(join(tmpdir(), 'ra21-unchanged-'));
    const copy = (repo: FixtureRepo, name: string): string => {
      const target = join(parent, name);
      const git = (args: string[], cwd?: string) =>
        execFileSync('git', args, { cwd, stdio: 'ignore', env: sanitizeGitEnv(process.env) });
      git(['clone', '--quiet', '--no-local', repo.dir, target]);
      git(['remote', 'remove', 'origin'], target);
      repo.cleanup();
      return target;
    };
    app = copy(buildAppFixture(), 'fixture-app');
    mono = copy(buildWorkspaceFixture(), 'fixture-workspace');
  });
  after(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it('app fixture', async () => {
    await checkGroup('app', app, 'HEAD~4', 'src/db.ts', ['src/billing.ts', 'templates/invoice.ts']);
  });

  it('workspace fixture', async () => {
    await checkGroup('workspace', mono, 'HEAD~3', 'packages/core/src/model.ts', ['packages/core/src/model.ts', 'packages/web/src/listener.js']);
  });
});
