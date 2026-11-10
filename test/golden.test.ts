/**
 * Golden JSON snapshots for the import-analysis pipeline (RA-10).
 *
 * The snapshots under `test/fixtures/golden/` were recorded before the shared
 * `src/imports/analysis.ts` pipeline existed. Every refactor of import analysis must
 * keep them byte-identical: they are the regression baseline for TS/JS behavior.
 *
 * Re-record only for an intentional, reviewed behavior change:
 *   UPDATE_GOLDEN=1 node --import tsx --test test/golden.test.ts
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildMapData } from '../src/commands/map.js';
import { loadContext } from '../src/context.js';
import { sanitizeGitEnv } from '../scripts/schema-validator.mjs';
import { FixtureRepo } from './helpers.js';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');
const GOLDEN_DIR = join(import.meta.dirname, 'fixtures', 'golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/** This repository's own history, pinned so the snapshot never moves with new commits. */
export const SELF_SHA = '21d4d843331328076b45dc17c24f262e14bfe59a';

interface GoldenCase {
  name: string;
  args: string[];
}

function runCli(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', TSX, CLI, ...args], {
      cwd,
      env: { ...sanitizeGitEnv(process.env), NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Removes machine- and run-specific values: absolute paths, tool version, cache counters, timestamps. */
export function normalizeGolden(value: unknown, dir: string): unknown {
  const replacePaths = (text: string): string => text.split(dir).join('<repo>');
  const walk = (node: unknown, key?: string): unknown => {
    if (typeof node === 'string') {
      if (key === 'generatedAt') return '<generatedAt>';
      return replacePaths(node);
    }
    if (Array.isArray(node)) {
      // Whether the checkout running the test is dirty is not part of the analysis.
      const items = key === 'warnings' ? node.filter((item) => typeof item !== 'string' || !item.startsWith('Working tree has uncommitted changes')) : node;
      return items.map((item) => walk(item));
    }
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === 'cache' && v && typeof v === 'object' && 'enabled' in (v as object)) continue;
        if ((k === 'root' || k === 'repoName') && typeof v === 'string') {
          out[k] = '<root>';
          continue;
        }
        if (k === 'file' && typeof v === 'string' && v.endsWith('.html')) {
          out[k] = '<map.html>';
          continue;
        }
        out[k] = walk(v, k);
      }
      if (key === 'tool' && typeof out.version === 'string') out.version = '<version>';
      return out;
    }
    return node;
  };
  return walk(value);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function checkGolden(group: string, name: string, actual: string): void {
  const path = join(GOLDEN_DIR, group, `${name}.json`);
  if (UPDATE) {
    mkdirSync(join(GOLDEN_DIR, group), { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  assert.ok(existsSync(path), `missing golden snapshot ${path}; record it with UPDATE_GOLDEN=1`);
  const expected = readFileSync(path, 'utf8');
  // Byte-identical: compare the raw text, not parsed objects.
  assert.equal(actual, expected, `${group}/${name}.json changed`);
}

async function runCases(group: string, dir: string, prefix: string[], cases: GoldenCase[]): Promise<void> {
  const results = await Promise.all(cases.map((item) => runCli([...prefix, '--json', ...item.args], dir)));
  cases.forEach((item, index) => {
    const result = results[index]!;
    assert.equal(result.code, 0, `${group}/${item.name} exited ${result.code}: ${result.stderr}`);
    checkGolden(group, item.name, serialize(normalizeGolden(JSON.parse(result.stdout), dir)));
  });
}

async function mapDataGolden(group: string, dir: string, flags: Record<string, number>, head?: string): Promise<void> {
  const ctx = await loadContext(dir, { ...flags, cache: false } as never, { silent: true, ...(head ? { head } : {}) });
  try {
    const data = buildMapData(ctx, { edges: 150, kinds: ['ghost', 'unknown', 'indirect', 'direct'] });
    checkGolden(group, 'map-data', serialize(normalizeGolden(data, dir)));
  } finally {
    ctx.close?.();
  }
}

let counter = 0;
/** A new revision of a file that keeps it valid (JSON manifests must stay parseable). */
function revise(path: string, content: string): string {
  counter++;
  if (path.endsWith('.json')) return `${JSON.stringify({ ...JSON.parse(content), revision: counter }, null, 2)}\n`;
  if (path.endsWith('.md')) return `${content}\nRevision ${counter}.\n`;
  if (path.endsWith('.css')) return `${content}/* revision ${counter} */\n`;
  return `${content}// ${path} revision ${counter}\n`;
}

/** A single TS/JS app: relative, `paths`, `#imports`, barrels, triple-slash, require, dynamic and missing imports. */
function buildAppFixture(): FixtureRepo {
  counter = 0;
  const repo = new FixtureRepo();
  const base: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'app', type: 'module', imports: { '#lib/*': './src/lib/*.ts' }, dependencies: { react: '18' } }, null, 2),
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }, null, 2),
    'src/index.ts': "export * from './api';\nexport * from './lib/util';\n",
    'src/api.ts': "import { db } from './db';\nimport { util } from '@/lib/util';\nimport React from 'react';\nimport fs from 'node:fs';\nexport const api = [db, util, React, fs];\n",
    'src/db.ts': 'export const db = 1;\n',
    'src/lib/util.ts': "import config from '#lib/config';\nexport const util = config;\n",
    'src/lib/config.ts': 'export default { retries: 3 };\n',
    'src/billing.ts': "export const PLAN = process.env.BILLING_PLAN;\n",
    'templates/invoice.ts': "export const template = process.env.BILLING_PLAN;\n",
    'src/loader.ts': 'export async function load(name: string) {\n  return import(name);\n}\n',
    'src/types.ts': '/// <reference path="./globals.d.ts" />\nexport type Id = string;\n',
    'src/globals.d.ts': 'declare const VERSION: string;\n',
    'src/missing.ts': "import './nope';\nimport '@/nothing';\nimport '#unknown';\n",
    'src/legacy.cjs': "const helper = require('./legacy-helper.cjs');\nmodule.exports = helper;\n",
    'src/legacy-helper.cjs': 'module.exports = 1;\n',
    'src/ui/button.tsx': "import { api } from '../index';\nexport const Button = () => api;\n",
    'src/ui/panel.tsx': "import { Button } from './button';\nexport const Panel = Button;\n",
    'src/api.test.ts': "import { api } from './api';\nconsole.log(api);\n",
    'README.md': '# app\n',
    'styles/main.css': 'body { margin: 0; }\n',
  };
  repo.commit({ message: 'initial', write: base });
  const groups: string[][] = [
    ['src/billing.ts', 'templates/invoice.ts'],
    ['src/api.ts', 'src/db.ts', 'src/api.test.ts'],
    ['src/ui/panel.tsx', 'src/db.ts'],
    ['src/loader.ts', 'src/lib/config.ts'],
    ['src/types.ts', 'src/globals.d.ts', 'styles/main.css'],
    ['src/legacy.cjs', 'src/missing.ts'],
    ['src/ui/button.tsx', 'src/lib/util.ts', 'README.md'],
  ];
  for (let round = 0; round < 5; round++) {
    for (const group of groups) {
      const write: Record<string, string> = {};
      for (const path of group) write[path] = revise(path, base[path]!);
      repo.commit({ message: `update ${group.join(' + ')} (${round})`, write });
    }
  }
  return repo;
}

/** An npm-workspaces monorepo: `exports`, subpaths, not-exported and unknown packages. */
function buildWorkspaceFixture(): FixtureRepo {
  counter = 0;
  const repo = new FixtureRepo();
  const base: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }, null, 2),
    'packages/core/package.json': JSON.stringify({ name: '@acme/core', exports: { '.': './src/index.ts', './util': './src/util.ts' } }, null, 2),
    'packages/core/src/index.ts': "export * from './model';\n",
    'packages/core/src/model.ts': 'export interface Model { id: string }\nexport const MODEL_EVENT = "model:saved";\n',
    'packages/core/src/util.ts': 'export const slug = (s: string) => s.toLowerCase();\n',
    'packages/core/src/internal.ts': 'export const secret = 1;\n',
    'packages/web/package.json': JSON.stringify({ name: '@acme/web', dependencies: { '@acme/core': '*', lodash: '4' } }, null, 2),
    'packages/web/src/app.tsx': "import { MODEL_EVENT } from '@acme/core';\nimport { slug } from '@acme/core/util';\nimport { secret } from '@acme/core/internal';\nimport _ from 'lodash';\nexport const app = [MODEL_EVENT, slug, secret, _];\n",
    'packages/web/src/page.jsx': "import { app } from './app';\nexport default function Page() { return app; }\n",
    'packages/web/src/listener.js': "export const on = 'model:saved';\n",
    'packages/cli/package.json': JSON.stringify({ name: '@acme/cli', type: 'module' }, null, 2),
    'packages/cli/src/main.mjs': "import '@acme/missing';\nimport { slug } from '@acme/core/util';\nexport default slug;\n",
    'docs/guide.md': '# guide\n',
  };
  repo.commit({ message: 'initial', write: base });
  const groups: string[][] = [
    ['packages/core/src/model.ts', 'packages/web/src/listener.js'],
    ['packages/web/src/app.tsx', 'packages/core/src/util.ts'],
    ['packages/web/src/page.jsx', 'packages/core/src/model.ts', 'docs/guide.md'],
    ['packages/cli/src/main.mjs', 'packages/core/src/internal.ts'],
    ['packages/core/package.json', 'packages/core/src/index.ts'],
  ];
  for (let round = 0; round < 5; round++) {
    for (const group of groups) {
      const write: Record<string, string> = {};
      for (const path of group) write[path] = revise(path, base[path]!);
      repo.commit({ message: `update ${group.join(' + ')} (${round})`, write });
    }
  }
  return repo;
}

const FIXTURE_FLAGS = ['--min-shared', '2', '--min-confidence', '0.3', '--no-cache'];

describe('golden JSON snapshots (TS/JS import analysis baseline)', { concurrency: true }, () => {
  let app: FixtureRepo;
  let mono: FixtureRepo;
  before(() => {
    app = buildAppFixture();
    mono = buildWorkspaceFixture();
  });
  after(() => {
    app.cleanup();
    mono.cleanup();
  });

  it('app fixture: scan, diff, file, explain, imports and map', async () => {
    await runCases('app', app.dir, FIXTURE_FLAGS, [
      { name: 'scan', args: ['scan', '--limit', '50'] },
      { name: 'diff', args: ['diff', '--base', 'HEAD~4'] },
      { name: 'file', args: ['file', 'src/db.ts'] },
      { name: 'explain', args: ['explain', 'src/billing.ts', 'templates/invoice.ts'] },
      { name: 'imports', args: ['imports'] },
      { name: 'imports-files', args: ['imports', '--files', 'src/lib/util.ts'] },
      { name: 'map', args: ['map', '--no-open', '-o', join(app.dir, '.git', 'map.html')] },
    ]);
    await mapDataGolden('app', app.dir, { minShared: 2, minConfidence: 0.3 });
  });

  it('workspace fixture: scan, diff, file, explain, imports and map', async () => {
    await runCases('workspace', mono.dir, FIXTURE_FLAGS, [
      { name: 'scan', args: ['scan', '--limit', '50'] },
      { name: 'diff', args: ['diff', '--base', 'HEAD~3'] },
      { name: 'file', args: ['file', 'packages/core/src/model.ts'] },
      { name: 'explain', args: ['explain', 'packages/core/src/model.ts', 'packages/web/src/listener.js'] },
      { name: 'imports', args: ['imports'] },
      { name: 'map', args: ['map', '--no-open', '-o', join(mono.dir, '.git', 'map.html')] },
    ]);
    await mapDataGolden('workspace', mono.dir, { minShared: 2, minConfidence: 0.3 });
  });

  it("this repository's own history at a pinned commit", async (t) => {
    let available = false;
    try {
      execFileSync('git', ['cat-file', '-e', `${SELF_SHA}^{commit}`], { cwd: ROOT, stdio: 'ignore', env: sanitizeGitEnv(process.env) });
      available = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: ROOT, encoding: 'utf8', env: sanitizeGitEnv(process.env) }).trim() === 'false';
    } catch {
      available = false;
    }
    if (!available) {
      t.skip(`needs the full history with ${SELF_SHA.slice(0, 7)} (shallow clone or no .git)`);
      return;
    }
    // `--head` reads the pinned tree and its config, never the working tree.
    await runCases('self', ROOT, ['--head', SELF_SHA, '--no-cache'], [
      { name: 'scan', args: ['scan', '--limit', '50'] },
      { name: 'diff', args: ['diff', '--base', 'fac8ea0'] },
      { name: 'file', args: ['file', 'src/imports/classify.ts'] },
      { name: 'explain', args: ['explain', 'src/imports/classify.ts', 'src/commands/imports.ts'] },
      { name: 'imports', args: ['imports'] },
      { name: 'map', args: ['map', '--no-open', '-o', join(mkdtempSync(join(tmpdir(), 'ra-golden-')), 'map.html')] },
    ]);
    await mapDataGolden('self', ROOT, {}, SELF_SHA);
  });
});
