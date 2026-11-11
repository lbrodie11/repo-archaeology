#!/usr/bin/env node
/**
 * Records `test/fixtures/hono/*.json`: this repository's `--json` output for `scan`, `diff`,
 * `file` and `explain` on honojs/hono at a pinned commit (61f7c59, the commit FRAME/12's
 * reference adapter fixture uses). The RA-21 rich-terminal tests read these offline.
 *
 *   git clone --no-checkout https://github.com/honojs/hono.git /tmp/hono
 *   node scripts/record-hono-fixtures.mjs /tmp/hono
 *
 * Only reads the clone's history through this repository's own CLI (`--head`, no checkout):
 * nothing from the clone is installed, built or executed.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeGitEnv } from './schema-validator.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test', 'fixtures', 'hono');
export const HONO_SHA = '61f7c59e50244ab4d2dd83c151928cf7ea448510';

export const HONO_COMMANDS = {
  scan: ['scan'],
  diff: ['diff', '--base', '61f7c59~6'],
  file: ['file', 'src/hono-base.ts'],
  explain: ['explain', 'src/helper/ssg/ssg.test.tsx', 'src/helper/ssg/index.ts'],
};

function normalize(json) {
  json.tool.version = '<version>';
  json.meta.root = 'hono';
  delete json.meta.cache;
  return json;
}

function main() {
  const clone = process.argv[2];
  if (!clone) {
    console.error('usage: node scripts/record-hono-fixtures.mjs <hono clone>');
    process.exit(2);
  }
  const tsx = import.meta.resolve('tsx');
  mkdirSync(OUT, { recursive: true });
  for (const [name, args] of Object.entries(HONO_COMMANDS)) {
    const stdout = execFileSync(
      process.execPath,
      ['--import', tsx, join(ROOT, 'src', 'cli.ts'), '-C', resolve(clone), '--head', HONO_SHA, '--no-cache', '--no-config', ...args, '--json'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: sanitizeGitEnv(process.env, { NO_COLOR: '1' }) },
    );
    const file = join(OUT, `${name}.json`);
    writeFileSync(file, `${JSON.stringify(normalize(JSON.parse(stdout)), null, 2)}\n`);
    console.log(`${name}: ${readFileSync(file).length} bytes`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
