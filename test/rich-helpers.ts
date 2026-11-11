/**
 * Shared helpers for the RA-21 `--style rich` tests: the recorded hono fixtures, a fixed clock,
 * and capabilities detected by `@frame12/terminal` from an injected environment and streams.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Capabilities, Env } from '@frame12/terminal';
import { stripAnsi } from '@frame12/terminal';
import type { DiffResult } from '../src/commands/diff.js';
import type { ExplainResult } from '../src/commands/explain.js';
import type { FileResult } from '../src/commands/file.js';
import type { ScanOptions, ScanResult } from '../src/commands/scan.js';
import {
  diffToRichView,
  explainToRichView,
  fileToRichView,
  scanToRichView,
  terminalCapabilities,
  type AdapterOptions,
  type RichView,
  type TerminalFlags,
} from '../src/report/frame12-terminal.js';

export const HONO_DIR = join(import.meta.dirname, 'fixtures', 'hono');

export interface HonoFixtures {
  scan: ScanResult;
  diff: DiffResult;
  file: FileResult;
  explain: ExplainResult;
}

export function loadHono(): HonoFixtures {
  const read = <T>(name: string): T => JSON.parse(readFileSync(join(HONO_DIR, `${name}.json`), 'utf8')) as T;
  return { scan: read('scan'), diff: read('diff'), file: read('file'), explain: read('explain') };
}

/** `scan`'s default options (what the CLI passes without flags). */
export const SCAN_DEFAULTS: ScanOptions = { limit: 15, kinds: ['ghost', 'unknown'], uncheckedCap: 5 };

export const FIXED: AdapterOptions = {
  startedAt: '2026-11-11T09:00:00.000Z',
  finishedAt: '2026-11-11T09:00:02.000Z',
};

export const HONO_REMOTE = 'https://github.com/honojs/hono.git';

export type Command = 'scan' | 'diff' | 'file' | 'explain';
export const COMMANDS: Command[] = ['scan', 'diff', 'file', 'explain'];

/** The adapter for one command of a fixture set. */
export function viewFor(fixtures: HonoFixtures, command: Command, options: AdapterOptions = FIXED, scanOptions: ScanOptions = SCAN_DEFAULTS): RichView {
  switch (command) {
    case 'scan':
      return scanToRichView(fixtures.scan, scanOptions, options);
    case 'diff':
      return diffToRichView(fixtures.diff, options);
    case 'file':
      return fileToRichView(fixtures.file, options);
    case 'explain':
      return explainToRichView(fixtures.explain, options);
  }
}

export interface CapsInput {
  columns?: number;
  tty?: boolean;
  env?: Env;
  flags?: TerminalFlags;
}

/** Capabilities from `@frame12/terminal`'s own detection, for a fake terminal. */
export function capsFor(input: CapsInput = {}): Capabilities {
  const tty = input.tty ?? true;
  const env: Env = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', ...input.env };
  return terminalCapabilities(
    input.flags ?? {},
    env,
    {
      stdin: { isTTY: false },
      stdout: { isTTY: tty, columns: input.columns ?? 80, rows: 40 },
      stderr: { isTTY: tty, columns: input.columns ?? 80, rows: 40 },
    },
    'linux',
  );
}

/** Text as the reader sees it: no SGR styling, no OSC 8 link wrappers. */
export function visible(text: string): string {
  return stripAnsi(text);
}
