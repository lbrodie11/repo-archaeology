#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from 'commander';
import { createRequire } from 'node:module';
import { backtest, printBacktest } from './commands/backtest.js';
import { diff, printDiff } from './commands/diff.js';
import { fileReport, printFile } from './commands/file.js';
import { openInBrowser, printMap, writeMap } from './commands/map.js';
import { printScan, scan } from './commands/scan.js';
import { ConfigError, type Settings } from './config.js';
import { loadContext, UsageError } from './context.js';
import { GitError } from './git/run.js';
import { RELATIONSHIPS, type Relationship } from './imports/classify.js';
import { c } from './util/term.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('Expected a positive whole number.');
  return n;
}

function fraction(value: string): number {
  const n = Number(value.endsWith('%') ? Number(value.slice(0, -1)) / 100 : value);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new InvalidArgumentError('Expected a number between 0 and 1 (or a percentage like 40%).');
  return n;
}

function positiveNumber(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('Expected a positive number.');
  return n;
}

function kindList(value: string): Relationship[] {
  const kinds = value.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (kinds.includes('all')) return [...RELATIONSHIPS];
  const invalid = kinds.filter((k) => !RELATIONSHIPS.includes(k as Relationship));
  if (invalid.length > 0 || kinds.length === 0) {
    throw new InvalidArgumentError(`Use a comma-separated list of: ${RELATIONSHIPS.join(', ')}, or all.`);
  }
  return kinds as Relationship[];
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

interface GlobalOptions {
  cwd?: string;
  maxCommits?: number;
  since?: string;
  maxFiles?: number;
  minShared?: number;
  minConfidence?: number;
  halfLife?: number;
  skipCommits?: string;
  ignore?: string[];
  defaultIgnores: boolean;
  json?: boolean;
}

function settingsFrom(opts: GlobalOptions): Partial<Settings> {
  return {
    maxCommits: opts.maxCommits,
    since: opts.since,
    maxFilesPerCommit: opts.maxFiles,
    minShared: opts.minShared,
    minConfidence: opts.minConfidence,
    halfLifeDays: opts.halfLife,
    skipCommits: opts.skipCommits,
    ignore: opts.ignore,
    useDefaultIgnores: opts.defaultIgnores === false ? false : undefined,
  };
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const program = new Command();
program
  .name('repo-archaeology')
  .description('Dig through git history to find files that change together, especially ghost wires:\nfiles that keep changing together without importing each other.')
  .version(version)
  .option('-C, --cwd <path>', 'run as if started in <path>')
  .option('--max-commits <n>', 'analyze at most this many recent commits (default 5000)', positiveInt)
  .option('--since <date>', 'only use commits after this date, e.g. "2 years ago" or 2024-01-01')
  .option('--max-files <n>', 'skip commits that touch more files than this, like formatting sweeps (default 25)', positiveInt)
  .option('--min-shared <n>', 'minimum shared commits for a relationship (default 3)', positiveInt)
  .option('--min-confidence <p>', 'minimum confidence, 0-1 or a percentage (default 0.4)', fraction)
  .option('--half-life <days>', 'weight recent commits more: a commit this many days old counts half', positiveNumber)
  .option('--skip-commits <regex>', 'leave out commits whose subject matches, e.g. "^(chore|style)\\b"')
  .option('--ignore <glob>', 'ignore matching files (repeatable), e.g. --ignore "docs/**"', collect)
  .option('--no-default-ignores', 'do not ignore lockfiles, build output and snapshots by default')
  .option('--json', 'print machine-readable JSON')
  .addOption(new Option('--no-color', 'disable colors'))
  .showHelpAfterError('(run with --help for usage)');

program
  .command('scan', { isDefault: true })
  .description('list the strongest ghost wires across the repository (default command)')
  .option('-n, --limit <n>', 'how many to show', positiveInt, 15)
  .option('--kinds <list>', `relationship kinds to show: ${RELATIONSHIPS.join(', ')}, or all`, kindList, ['ghost', 'unknown'] as Relationship[])
  .action(async (opts: { limit: number; kinds: Relationship[] }, cmd: Command) => {
    const global = cmd.optsWithGlobals<GlobalOptions>();
    const ctx = await loadContext(global.cwd, settingsFrom(global));
    const result = scan(ctx, opts);
    if (global.json) printJson(result);
    else printScan(result, opts);
  });

program
  .command('diff')
  .description('check your changes: which files usually change with them but were left untouched?')
  .option('-b, --base <ref>', 'also include commits on this branch since it forked from <ref> (e.g. main)')
  .option('-n, --limit <n>', 'how many suggestions to show', positiveInt, 10)
  .option('--kinds <list>', `relationship kinds to report: ${RELATIONSHIPS.join(', ')}, or all`, kindList, [...RELATIONSHIPS])
  .option('--exit-code', 'exit with status 1 when there are suggestions (for hooks and CI)')
  .action(async (opts: { base?: string; limit: number; kinds: Relationship[]; exitCode?: boolean }, cmd: Command) => {
    const global = cmd.optsWithGlobals<GlobalOptions>();
    const ctx = await loadContext(global.cwd, settingsFrom(global));
    const result = await diff(ctx, opts);
    if (global.json) printJson(result);
    else printDiff(result);
    if (opts.exitCode && result.suggestions.length > 0) process.exitCode = 1;
  });

program
  .command('file')
  .description('everything history knows about one file: churn, owners and the files that move with it')
  .argument('<path>', 'file to inspect')
  .option('-n, --limit <n>', 'how many related files to show', positiveInt, 10)
  .action(async (path: string, opts: { limit: number }, cmd: Command) => {
    const global = cmd.optsWithGlobals<GlobalOptions>();
    const ctx = await loadContext(global.cwd, settingsFrom(global));
    const result = fileReport(ctx, path, opts);
    if (global.json) printJson(result);
    else printFile(result);
  });

program
  .command('backtest')
  .description('measure how often suggestions would have been right on recent history')
  .option('--test-fraction <p>', 'share of the newest commits to replay (default 0.2)', fraction, 0.2)
  .option('-k, --k <n>', 'suggestions considered per changed file (default 3)', positiveInt, 3)
  .action(async (opts: { testFraction: number; k: number }, cmd: Command) => {
    const global = cmd.optsWithGlobals<GlobalOptions>();
    const ctx = await loadContext(global.cwd, settingsFrom(global));
    const result = backtest(ctx, opts);
    if (global.json) printJson(result);
    else printBacktest(result);
  });

program
  .command('map')
  .description('write an interactive map of what changes together and open it in your browser')
  .option('-o, --out <file>', 'where to write the HTML (default: a temporary folder)')
  .option('--edges <n>', 'maximum relationships to draw', positiveInt, 150)
  .option('--kinds <list>', `relationship kinds to include: ${RELATIONSHIPS.join(', ')}, or all`, kindList, [...RELATIONSHIPS])
  .option('--no-open', 'write the file without opening a browser')
  .action(async (opts: { out?: string; edges: number; kinds: Relationship[]; open: boolean }, cmd: Command) => {
    const global = cmd.optsWithGlobals<GlobalOptions>();
    const ctx = await loadContext(global.cwd, settingsFrom(global));
    const { file, data } = writeMap(ctx, opts);
    const shouldOpen = opts.open && !global.json && process.stdout.isTTY === true;
    if (shouldOpen) openInBrowser(file);
    if (global.json) printJson({ file, nodes: data.nodes.length, edges: data.edges.length, counts: data.counts });
    else printMap(file, data, shouldOpen);
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof GitError || err instanceof UsageError || err instanceof ConfigError) {
      console.error(c.red(`error: ${err.message}`));
      process.exitCode = 2;
      return;
    }
    throw err;
  }
}

void main();
