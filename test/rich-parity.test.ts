/**
 * RA-21 · number parity: every number `--style rich` shows equals a `--json` value.
 *
 * For each command, the rich output (and the screen-reader output) is reduced to the numbers it
 * prints, after removing what is not a measurement: presentation labels (`F-01`, `E-01`), ids,
 * dates, SHAs, and repository text that `--json` carries verbatim (paths, subjects, refs). Each
 * remaining number must be a `--json` number, a `--json` fraction as the package rounds it
 * (`Math.round(x * 100)`), or the length of a `--json` array. The few presentation counts the
 * package adds (findings by prominence, warnings, cuts, receipts beyond the three a card lists)
 * are computed from the snapshot and listed explicitly below.
 *
 * Hono (61f7c59) runs from the recorded `--json` (offline). The app and workspace fixtures run the
 * real CLI twice, `--json` and `--style rich`, and also check the CLI's rich output is exactly the
 * adapter's rendering of that `--json`.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import type { Env, Snapshot } from '@frame12/terminal';
import { sanitizeGitEnv } from '../scripts/schema-validator.mjs';
import { renderRichView, type RichView } from '../src/report/frame12-terminal.js';
import { buildAppFixture, buildWorkspaceFixture } from './fixtures/import-fixtures.js';
import type { FixtureRepo } from './helpers.js';
import { capsFor, COMMANDS, HONO_REMOTE, FIXED, loadHono, viewFor, visible, type Command, type HonoFixtures } from './rich-helpers.js';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');

/** Every number, fraction-as-percent and array length in a `--json` document. */
function allowedFromJson(json: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'number' && Number.isFinite(v)) {
      out.add(String(v));
      if (Number.isInteger(v)) out.add(String(v));
      if (v >= 0 && v <= 1) out.add(String(Math.round(v * 100)));
    } else if (Array.isArray(v)) {
      out.add(String(v.length));
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(walk);
    }
  };
  walk(json);
  return out;
}

/** Counts the package's grammar prints about the snapshot itself. */
function presentationCounts(snapshot: Snapshot): Set<string> {
  const by = { hero: 0, primary: 0, secondary: 0 };
  for (const f of snapshot.findings) by[f.prominence]++;
  const counts = [snapshot.findings.length, snapshot.warnings.length, snapshot.cuts.length, by.hero, by.primary, by.secondary];
  for (const f of snapshot.findings) {
    const n = f.receipts?.length ?? 0;
    counts.push(n, Math.max(0, n - 3));
  }
  return new Set(counts.map(String));
}

/** Repository strings from `--json` (paths, subjects, refs, ids), longest first. */
function jsonStrings(json: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (/\d/.test(v)) out.add(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(json);
  return [...out].sort((a, b) => b.length - a.length);
}

/** The numbers left in rendered output once labels, ids, dates, SHAs and repository text are removed. */
export function renderedNumbers(output: string, json: unknown): string[] {
  let text = visible(output)
    // Command continuations, then hero/body gutters, so wrapped text is contiguous again.
    .replace(/ \\\n\s*/g, ' ')
    // A word longer than the line is split with a bare `\` (POSIX joins it back).
    .replace(/\\\n\s*/g, '')
    .split('\n')
    .map((l) => l.replace(/^[┃|]? +/, '').trim())
    .join(' ');
  for (const s of jsonStrings(json)) text = text.split(s).join(' ');
  text = text
    .replace(/\b[FEC]-\d+\b/g, ' ')
    .replace(/\b(?:pair|family)-[0-9a-f]{8}\b/g, ' ')
    .replace(/\brepo-archaeology-[a-z]+\b/g, ' ')
    .replace(/\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?/g, ' ')
    .replace(/\b[0-9a-f]{7,40}\b/g, ' ')
    // Truncated repository text (an ellipsis inside or at the end of a word).
    .replace(/\S*(?:…|\.\.\.)\S*/g, ' ')
    // Template words: "95% interval", "subject 1", "Subject 2", "F-01 subject 2 (file)".
    .replace(/\b95%/g, ' ')
    .replace(/\b[Ss]ubjects? \d\b/g, ' ');
  return text.match(/\d+(?:\.\d+)?/g) ?? [];
}

function assertParity(label: string, output: string, json: unknown, view: RichView): void {
  const allowed = new Set([...allowedFromJson(json), ...presentationCounts(view.snapshot)]);
  const numbers = renderedNumbers(output, json);
  assert.ok(numbers.length > 5, `${label}: expected numbers in the output`);
  const unknown = numbers.filter((n) => !allowed.has(n));
  assert.deepEqual(unknown, [], `${label}: numbers not found in --json: ${unknown.join(', ')}`);
}

function checkAll(label: string, fixtures: HonoFixtures, command: Command, json: unknown): void {
  const options = { ...FIXED, remoteUrl: HONO_REMOTE };
  const view = viewFor(fixtures, command, options);
  for (const columns of [40, 80, 120]) {
    assertParity(`${label} ${command} rich ${columns}`, renderRichView(view, capsFor({ columns, env: { FORCE_COLOR: '3' } })), json, view);
  }
  assertParity(`${label} ${command} screen reader`, renderRichView(view, capsFor({ flags: { screenReader: true } })), json, view);
}

describe('RA-21 · every number in --style rich equals a --json value', { concurrency: true }, () => {
  it('hono 61f7c59: scan, diff, file and explain', () => {
    const hono = loadHono();
    for (const command of COMMANDS) checkAll('hono', hono, command, hono[command]);
  });

  it('the parity check catches a number that is not in --json', () => {
    const hono = loadHono();
    const view = viewFor(hono, 'diff');
    const out = renderRichView(view, capsFor()).replace('the other way 20 of 27', 'the other way 987654 of 27');
    assert.throws(() => assertParity('tampered', out, hono.diff, view), /numbers not found in --json: 987654/);
  });

  const runCli = (args: string[], cwd: string, env: Env): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', TSX, CLI, ...args], { cwd, env: env as NodeJS.ProcessEnv });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
      child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}: ${stderr}`))));
    });

  const fixtureCase = (name: string, build: () => FixtureRepo, args: Record<Command, string[]>) =>
    it(`${name} fixture: the CLI's rich output is the adapter's rendering of its --json, and parity holds`, async () => {
      const repo = build();
      try {
        // Same environment for the CLI and the in-test capability detection (a pipe, 80 columns).
        const env = sanitizeGitEnv(process.env, { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' }) as Env;
        for (const key of ['NO_COLOR', 'FORCE_COLOR', 'TERM_PROGRAM', 'COLORTERM', 'WT_SESSION', 'CI', 'GITHUB_ACTIONS', 'FRAME12_SCREEN_READER', 'FRAME12_ASCII', 'LC_ALL', 'LC_CTYPE']) {
          delete (env as Record<string, string | undefined>)[key];
        }
        const flags = ['--min-shared', '2', '--min-confidence', '0.3', '--no-cache'];
        for (const command of COMMANDS) {
          const [jsonText, rich] = await Promise.all([
            runCli([...flags, ...args[command], '--json'], repo.dir, env),
            runCli([...flags, '--columns', '80', '--style', 'rich', ...args[command]], repo.dir, env),
          ]);
          const json = JSON.parse(jsonText) as HonoFixtures[Command];
          const fixtures = { [command]: json } as unknown as HonoFixtures;
          const view = viewFor(fixtures, command, FIXED, { limit: 15, kinds: ['ghost', 'unknown'], uncheckedCap: 5 });
          const caps = capsFor({ tty: false, env, flags: { columns: 80 } });
          assert.equal(rich, renderRichView(view, caps), `${name} ${command}: CLI rich output differs from the adapter over --json`);
          assert.ok(!rich.includes('\u001b'), `${name} ${command}: a pipe gets no escape sequences`);
          assertParity(`${name} ${command} CLI`, rich, json, view);
          checkAll(name, fixtures, command, json);
        }
      } finally {
        repo.cleanup();
      }
    });

  fixtureCase('app', buildAppFixture, {
    scan: ['scan'],
    diff: ['diff', '--base', 'HEAD~4'],
    file: ['file', 'src/db.ts'],
    explain: ['explain', 'src/billing.ts', 'templates/invoice.ts'],
  });
  fixtureCase('workspace', buildWorkspaceFixture, {
    scan: ['scan'],
    diff: ['diff', '--base', 'HEAD~3'],
    file: ['file', 'packages/core/src/model.ts'],
    explain: ['explain', 'packages/core/src/model.ts', 'packages/web/src/listener.js'],
  });
});
