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
import { workingTreeChanges } from './git/changes.js';
import { GitError } from './git/run.js';
import { RELATIONSHIPS, type Relationship } from './imports/classify.js';
import { c, terminalText } from './util/term.js';

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

function dateValue(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new InvalidArgumentError('Expected a date such as 2026-01-01.');
  return Math.floor(ms / 1000);
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

function kindsOption(description: string, defaults: Relationship[]): Option {
  return new Option('--kinds <list>', `${description}: comma-separated ${RELATIONSHIPS.join(', ')}, or all`)
    .argParser(kindList)
    .default(defaults, defaults.length === RELATIONSHIPS.length ? 'all' : defaults.join(','));
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
  .description('Dig through git history to find files that change together, especially ghost wires: files that keep changing together without importing each other.')
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
  .allowExcessArguments(true)
  .showHelpAfterError('(run with --help for usage)');

program
  .command('scan')
  .description('list the strongest ghost wires across the repository')
  .option('-n, --limit <n>', 'how many to show', positiveInt, 15)
  .addOption(kindsOption('relationship kinds to show', ['ghost', 'unknown']))
  .action(async (opts: { limit: number; kinds: Relationship[] }, cmd: Command) => {
    const global = cmd.optsWithGlobals<GlobalOptions>();
    const ctx = await loadContext(global.cwd, settingsFrom(global));
    // Unless --kinds was chosen explicitly, keep config-file noise from crowding out ghost wires.
    const options = { ...opts, uncheckedCap: cmd.getOptionValueSource('kinds') === 'default' ? 5 : undefined };
    const result = scan(ctx, options);
    if (global.json) printJson(result);
    else printScan(result, options);
  });

program
  .command('diff')
  .description('check your changes: which files usually change with them but were left untouched?')
  .option('-b, --base <ref>', 'also include commits on this branch since it forked from <ref> (e.g. main)')
  .option('-n, --limit <n>', 'how many suggestions to show', positiveInt, 10)
  .addOption(kindsOption('relationship kinds to report', [...RELATIONSHIPS]))
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
  .option('--before <date>', 'leave out commits from this date on (tune on an older window)', dateValue)
  .option('--ghosts', 'diagnose the ghost subset using current imports (contains future information)')
  .action(async (opts: { testFraction: number; k: number; before?: number; ghosts?: boolean }, cmd: Command) => {
    const global = cmd.optsWithGlobals<GlobalOptions>();
    const ctx = await loadContext(global.cwd, settingsFrom(global));
    const result = backtest(ctx, opts);
    if (global.json) printJson(result);
    else printBacktest(result);
  });

program
  .command('map')
  .description('write an interactive map of what changes together and open it in your browser')
  .option('-o, --out <file>', 'where to write the HTML (default: .git/repo-archaeology/map.html)')
  .option('--edges <n>', 'maximum relationships to draw', positiveInt, 150)
  .addOption(kindsOption('relationship kinds to include', ['ghost', 'unknown', 'indirect', 'direct']))
  .option('--no-open', 'write the file without opening a browser')
  .action(async (opts: { out?: string; edges: number; kinds: Relationship[]; open: boolean }, cmd: Command) => {
    const global = cmd.optsWithGlobals<GlobalOptions>();
    const ctx = await loadContext(global.cwd, settingsFrom(global));
    const options = {
      ...opts,
      uncheckedCap: cmd.getOptionValueSource('kinds') === 'default' ? Math.max(1, Math.floor(opts.edges * 0.1)) : undefined,
    };
    const { file, data } = await writeMap(ctx, options);
    const shouldOpen = opts.open && !global.json && process.stdout.isTTY === true;
    if (shouldOpen) openInBrowser(file);
    if (global.json) printJson({ file, nodes: data.nodes.length, edges: data.edges.length, counts: data.counts });
    else printMap(file, data, shouldOpen);
  });

for (const cmd of program.commands) {
  cmd.allowExcessArguments(false);
}

program.action(async () => {
  // The bare command has a default action, so a mistyped command arrives as an extra argument.
  const [unexpected] = program.args;
  if (unexpected !== undefined) {
    const suggestion = closestCommand(unexpected, program.commands.map((cmd) => cmd.name()));
    program.error(`error: unknown command '${terminalText(unexpected)}'${suggestion ? `\n(Did you mean ${suggestion}?)` : ''}`, { exitCode: 2, code: 'commander.unknownCommand' });
  }
  const global = program.opts<GlobalOptions>();
  const ctx = await loadContext(global.cwd, settingsFrom(global));
  const changes = await workingTreeChanges(ctx.root);
  let changedWithoutHistory = 0;
  if (changes.length > 0) {
    const result = await diff(ctx, { limit: 10, kinds: [...RELATIONSHIPS] }, changes);
    if (result.changed.some((file) => file.hasHistory)) {
      if (global.json) printJson({ mode: 'diff', ...result });
      else printDiff(result);
      return;
    }
    changedWithoutHistory = result.changed.length;
  }

  const options = { limit: 15, kinds: ['ghost', 'unknown'] as Relationship[], uncheckedCap: 5 };
  const result = scan(ctx, options);
  if (global.json) printJson({ mode: 'scan', changedWithoutHistory, ...result });
  else {
    if (changedWithoutHistory > 0) console.log(c.dim(`${changedWithoutHistory} changed file${changedWithoutHistory === 1 ? '' : 's'} had no usable history; showing repository-wide relationships instead.\n`));
    printScan(result, options);
    console.log();
    console.log(c.dim('Explore the interactive view with `repo-archaeology map`.'));
  }
});

/** The command name within two edits of `input`, if any (for "Did you mean …?"). */
function closestCommand(input: string, names: string[]): string | undefined {
  const distance = (a: string, b: string): number => {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let diagonal = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const above = row[j]!;
        row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
        diagonal = above;
      }
    }
    return row[b.length]!;
  };
  const ranked = names.map((name) => ({ name, d: distance(input.toLowerCase(), name) })).sort((x, y) => x.d - y.d);
  return ranked[0] && ranked[0].d <= 2 ? ranked[0].name : undefined;
}

async function main(): Promise<void> {
  // `repo-archaeology scan | head` closes the pipe early: that is not an error.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(process.exitCode ?? 0);
    throw err;
  });
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof GitError || err instanceof UsageError || err instanceof ConfigError) {
      console.error(c.red(`error: ${terminalText(err.message)}`));
      process.exitCode = 2;
      return;
    }
    throw err;
  }
}

void main();
