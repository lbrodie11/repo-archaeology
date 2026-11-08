#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from 'commander';
import { createRepository } from './api/index.js';
import { backtest, printBacktest } from './commands/backtest.js';
import { diff, printDiff } from './commands/diff.js';
import { explain, printExplain } from './commands/explain.js';
import { fileReport, printFile } from './commands/file.js';
import { importGraph, printImports } from './commands/imports.js';
import { openInBrowser, printMap, writeMap } from './commands/map.js';
import { printScan, scan } from './commands/scan.js';
import {
  printVerdictAdd,
  printVerdictList,
  printVerdictPrune,
  verdictAdd,
  verdictList,
  verdictPrune,
} from './commands/verdict.js';
import { ConfigError, type Settings } from './config.js';
import { loadContext, UsageError } from './context.js';
import { workingTreeChanges } from './git/changes.js';
import { GitError } from './git/run.js';
import { RELATIONSHIPS, type Relationship } from './imports/classify.js';
import { parseOriginWeightsSpec, type OriginWeights } from './model/origin.js';
import { formatJsonContract, getToolVersion, validateJsonOutPath, writeJsonContractFile } from './report/contract.js';
import { renderDiffMarkdown } from './report/markdown.js';
import { c, terminalText } from './util/term.js';

const version = getToolVersion();

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('Expected a positive whole number.');
  return n;
}

function nonNegativeInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError('Expected a whole number (0 or greater).');
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

function originWeightsValue(value: string): OriginWeights {
  try {
    return parseOriginWeightsSpec(value, '--origin-weights');
  } catch (err) {
    throw new InvalidArgumentError((err as Error).message);
  }
}

function collectCompareOriginWeights(value: string, previous: string[] = []): string[] {
  try {
    parseOriginWeightsSpec(value, '--compare-origin-weights');
  } catch (err) {
    throw new InvalidArgumentError((err as Error).message);
  }
  return [...previous, value];
}

interface GlobalOptions {
  cwd?: string;
  head?: string;
  maxCommits?: number;
  since?: string;
  maxFiles?: number;
  minShared?: number;
  minConfidence?: number;
  halfLife?: number;
  skipCommits?: string;
  originWeights?: OriginWeights;
  owners?: boolean;
  ignore?: string[];
  defaultIgnores: boolean;
  cache: boolean;
  json?: boolean;
}

function resolveOwnersFlag(cmd?: Command): boolean | undefined {
  if (cmd && cmd.getOptionValueSource('owners') === 'cli') {
    return Boolean(cmd.opts<{ owners?: boolean }>().owners);
  }
  if (program.getOptionValueSource('owners') === 'cli') {
    return Boolean(program.opts<{ owners?: boolean }>().owners);
  }
  return undefined;
}

function settingsFrom(opts: GlobalOptions, cmd?: Command): Partial<Settings> {
  const ownersFlag = resolveOwnersFlag(cmd);
  return {
    maxCommits: opts.maxCommits,
    since: opts.since,
    maxFilesPerCommit: opts.maxFiles,
    minShared: opts.minShared,
    minConfidence: opts.minConfidence,
    halfLifeDays: opts.halfLife,
    skipCommits: opts.skipCommits,
    origin: opts.originWeights !== undefined ? { weights: opts.originWeights } : undefined,
    owners: ownersFlag !== undefined ? { enabled: ownersFlag } : undefined,
    ignore: opts.ignore,
    useDefaultIgnores: opts.defaultIgnores === false ? false : undefined,
    cache: opts.cache === false ? { enabled: false } : undefined,
  };
}

function printJson(value: object): void {
  process.stdout.write(formatJsonContract(value));
}

function printVersionedJson(value: object): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const program = new Command();
program
  .name('repo-archaeology')
  .description('Dig through git history to find files that change together, especially ghost wires: files that keep changing together without importing each other.')
  .version(version)
  .option('-C, --cwd <path>', 'run as if started in <path>')
  .option('--head <ref>', 'analyze repository at <ref> without checking it out')
  .option('--max-commits <n>', 'analyze at most this many recent commits (default 5000)', positiveInt)
  .option('--since <date>', 'only use commits after this date, e.g. "2 years ago" or 2024-01-01')
  .option('--max-files <n>', 'skip commits that touch more files than this, like formatting sweeps (default 25)', positiveInt)
  .option('--min-shared <n>', 'minimum shared commits for a relationship (default 3)', positiveInt)
  .option('--min-confidence <p>', 'minimum confidence, 0-1 or a percentage (default 0.4)', fraction)
  .option('--half-life <days>', 'weight recent commits more: a commit this many days old counts half', positiveNumber)
  .option('--origin-weights <spec>', 'weight commits by origin, e.g. "bot=0,agent=0.5" (values 0..1)', originWeightsValue)
  .option('--owners', 'include recent human contributor context and CODEOWNERS on diff suggestions')
  .option('--no-owners', 'disable contributor context and CODEOWNERS on diff suggestions')
  .option('--skip-commits <regex>', 'leave out commits whose subject matches, e.g. "^(chore|style)\\b"')
  .option('--ignore <glob>', 'ignore matching files (repeatable), e.g. --ignore "docs/**"', collect)
  .option('--no-default-ignores', 'do not ignore lockfiles, build output and snapshots by default')
  .option('--no-cache', 'do not read or write the persistent history cache (.git/repo-archaeology/cache/)')
  .option('--json', 'print machine-readable JSON')
  .addOption(new Option('--no-color', 'disable colors'))
  .allowExcessArguments(true)
  .showHelpAfterError('(run with --help for usage)');

program
  .command('scan')
  .description('list the strongest ghost wires across the repository')
  .option('-n, --limit <n>', 'how many to show', positiveInt, 15)
  .addOption(kindsOption('relationship kinds to show', ['ghost', 'unknown']))
  .option('--show-silenced', 'also show relationships silenced by expected verdicts')
  .action(async (opts: { limit: number; kinds: Relationship[]; showSilenced?: boolean }, cmd: Command) => {
    const global = cmd.optsWithGlobals<GlobalOptions>();
    const ctx = await loadContext(global.cwd, settingsFrom(global), { head: global.head });
    // Unless --kinds was chosen explicitly, keep config-file noise from crowding out ghost wires.
    const options = { ...opts, uncheckedCap: cmd.getOptionValueSource('kinds') === 'default' ? 5 : undefined };
    if (global.json) {
      printVersionedJson(await createRepository(ctx).scan(options));
    } else {
      const result = scan(ctx, options);
      printScan(result, options);
    }
  });

program
  .command('diff')
  .description('check your changes: which files usually change with them but were left untouched?')
  .option('-b, --base <ref>', 'also include commits on this branch since it forked from <ref> (e.g. main)')
  .option('-n, --limit <n>', 'how many suggestions to show', positiveInt, 10)
  .addOption(kindsOption('relationship kinds to report', [...RELATIONSHIPS]))
  .addOption(new Option('--format <format>', 'output format for stdout').choices(['text', 'markdown']).default('text'))
  .option('--json-out <file>', 'also write the versioned JSON result to <file> in the same run')
  .option('--apply-branch-verdicts', 'apply verdicts added or changed on this branch before merging (when using --base)')
  .option('--owners', 'include recent human contributor context and CODEOWNERS on diff suggestions')
  .option('--no-owners', 'disable contributor context and CODEOWNERS on diff suggestions')
  .option('--exit-code', 'exit with status 1 when there are suggestions (for hooks and CI)')
  .action(
    async (
      opts: {
        base?: string;
        limit: number;
        kinds: Relationship[];
        format: 'text' | 'markdown';
        jsonOut?: string;
        applyBranchVerdicts?: boolean;
        owners?: boolean;
        exitCode?: boolean;
      },
      cmd: Command,
    ) => {
      const global = cmd.optsWithGlobals<GlobalOptions>();
      if (global.json && opts.format === 'markdown') {
        throw new UsageError(
          '--json and --format markdown cannot be used together on stdout; use --format markdown --json-out <file> instead.',
        );
      }
      if (opts.jsonOut !== undefined) {
        validateJsonOutPath(opts.jsonOut);
      }
      const ownersFlag = resolveOwnersFlag(cmd);
      const ctx = await loadContext(global.cwd, settingsFrom(global, cmd), { base: opts.base, head: global.head });
      const result = await createRepository(ctx).diff({ ...opts, owners: ownersFlag });
      if (opts.jsonOut !== undefined) {
        writeJsonContractFile(opts.jsonOut, result);
      }
      if (global.json) printVersionedJson(result);
      else if (opts.format === 'markdown') {
        const repoUrl =
          process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
            ? `${process.env.GITHUB_SERVER_URL.replace(/\/+$/, '')}/${process.env.GITHUB_REPOSITORY}`
            : undefined;
        process.stdout.write(
          renderDiffMarkdown(result, {
            settings: ctx.settings,
            flagSettings: ctx.flagSettings,
            repoUrl,
          }),
        );
      } else printDiff(result);
      if (opts.exitCode && result.suggestions.length > 0) process.exitCode = 1;
    },
  );

program
  .command('file')
  .description('everything history knows about one file: churn, owners and the files that move with it')
  .argument('<path>', 'file to inspect')
  .option('-n, --limit <n>', 'how many related files to show', positiveInt, 10)
  .option('--show-silenced', 'also show companions silenced by expected verdicts')
  .action(async (path: string, opts: { limit: number; showSilenced?: boolean }, cmd: Command) => {
    const global = cmd.optsWithGlobals<GlobalOptions>();
    const ctx = await loadContext(global.cwd, settingsFrom(global), { head: global.head });
    if (global.json) {
      printVersionedJson(await createRepository(ctx).file(path, opts));
    } else {
      const result = fileReport(ctx, path, opts);
      printFile(result);
    }
  });

program
  .command('explain')
  .description('inspect paired git diff hunks and counterexample commits for two files')
  .argument('<fileA>', 'first file to inspect')
  .argument('<fileB>', 'second file to inspect')
  .option('-b, --base <ref>', 'inspect pre-change baseline history up to the merge-base with <ref>')
  .option('-n, --commits <n>', 'how many recent shared commits to inspect (default 3, max 10)', positiveInt, 3)
  .option('--counterexamples', 'also show patch hunks for commits where one file changed without the other')
  .option('-U, --context <lines>', 'lines of unified diff context around each hunk (default 2, max 10)', nonNegativeInt, 2)
  .action(async (fileA: string, fileB: string, opts: { base?: string; commits: number; counterexamples?: boolean; context: number }, cmd: Command) => {
    const global = cmd.optsWithGlobals<GlobalOptions>();
    const ctx = await loadContext(global.cwd, settingsFrom(global), { base: opts.base, head: global.head });
    if (global.json) {
      printVersionedJson(
        await createRepository(ctx).explain(fileA, fileB, {
          commits: opts.commits,
          counterexamples: opts.counterexamples,
          context: opts.context,
        }),
      );
    } else {
      const result = await explain(ctx, fileA, fileB, {
        commits: opts.commits,
        counterexamples: opts.counterexamples,
        contextLines: opts.context,
      });
      printExplain(result);
    }
  });

program
  .command('backtest')
  .description('measure how often suggestions would have been right on recent history')
  .option('--test-fraction <p>', 'share of the newest commits to replay (default 0.2)', fraction, 0.2)
  .option('-k, --k <n>', 'suggestions considered per changed file (default 3)', positiveInt, 3)
  .option('--before <date>', 'leave out commits from this date on (tune on an older window)', dateValue)
  .option('--ghosts', 'diagnose the ghost subset using current imports (contains future information)')
  .option('--follow-ups', 'also evaluate candidate temporal follow-up commits in the held-out window')
  .option('--follow-up-window <hours>', 'maximum hours between an initial commit and a candidate follow-up (default 48)', positiveNumber)
  .option('--compare-origin-weights <spec>', 'compare unweighted default (all=1) against <spec> (e.g. "bot=0,agent=0.5"; omitted keys inherit config origin.weights)', collectCompareOriginWeights)
  .action(async (opts: { testFraction: number; k: number; before?: number; ghosts?: boolean; followUps?: boolean; followUpWindow?: number; compareOriginWeights?: string[] }, cmd: Command) => {
    if (opts.followUpWindow !== undefined && !opts.followUps) {
      throw new UsageError('--follow-up-window requires --follow-ups.');
    }
    const global = cmd.optsWithGlobals<GlobalOptions>();
    const ctx = await loadContext(global.cwd, settingsFrom(global), { head: global.head });
    if (global.json) {
      printVersionedJson(
        await createRepository(ctx).backtest({
          testFraction: opts.testFraction,
          k: opts.k,
          before: opts.before,
          ghosts: opts.ghosts,
          followUps: opts.followUps,
          followUpWindowHours: opts.followUpWindow,
          compareOriginWeights: opts.compareOriginWeights,
        }),
      );
    } else {
      const result = backtest(ctx, { ...opts, followUpWindowHours: opts.followUpWindow, compareOriginWeights: opts.compareOriginWeights });
      printBacktest(result);
    }
  });

program
  .command('imports')
  .description('inspect internal module imports and reverse importers across the repository')
  .option('-f, --files <path...>', 'restrict from to these files plus every file that imports them')
  .action(async (opts: { files?: string[] }, cmd: Command) => {
    const global = cmd.optsWithGlobals<GlobalOptions>();
    const ctx = await loadContext(global.cwd, settingsFrom(global), { head: global.head });
    if (global.json) {
      printVersionedJson(await createRepository(ctx).importGraph({ files: opts.files }));
    } else {
      const result = importGraph(ctx, { files: opts.files });
      printImports(result);
    }
  });

program
  .command('map')
  .description('write an interactive map of what changes together and open it in your browser')
  .option('-o, --out <file>', 'where to write the HTML (default: .git/repo-archaeology/map.html)')
  .option('--edges <n>', 'maximum relationships to draw', positiveInt, 150)
  .addOption(kindsOption('relationship kinds to include', ['ghost', 'unknown', 'indirect', 'direct']))
  .option('--include-patches', 'embed bounded git diff hunks for top relationships (opt-in; review before sharing externally)')
  .option('--show-silenced', 'also include relationships silenced by expected verdicts')
  .option('--no-open', 'write the file without opening a browser')
  .action(async (opts: { out?: string; edges: number; kinds: Relationship[]; includePatches?: boolean; showSilenced?: boolean; open: boolean }, cmd: Command) => {
    const global = cmd.optsWithGlobals<GlobalOptions>();
    const ctx = await loadContext(global.cwd, settingsFrom(global), { head: global.head });
    const options = {
      ...opts,
      uncheckedCap: cmd.getOptionValueSource('kinds') === 'default' ? Math.max(1, Math.floor(opts.edges * 0.1)) : undefined,
    };
    const { file, data } = await writeMap(ctx, options);
    const shouldOpen = opts.open && !global.json && process.stdout.isTTY === true;
    if (shouldOpen) openInBrowser(file);
    if (global.json) {
      printJson({
        meta: data.meta,
        file,
        nodes: data.nodes.length,
        edges: data.edges.length,
        counts: data.counts,
        patchesIncluded: Boolean(data.patchesIncluded),
        ...(data.verdicts ? { verdicts: data.verdicts } : {}),
      });
    } else printMap(file, data, shouldOpen);
  });

const verdictCmd = program
  .command('verdict')
  .description('manage repo-committed relationship verdicts (.repo-archaeology.verdicts.json)');

verdictCmd
  .command('add')
  .description('record an expected (silenced) or confirmed relationship verdict')
  .argument('<a>', 'first file path or glob')
  .argument('<b>', 'second file path or glob')
  .option('--expected', 'mark the relationship as expected mechanical coupling (silenced in diff/scan/file/map)')
  .option('--confirmed', 'mark the relationship as a confirmed hidden dependency')
  .option('--reason <text>', 'explanation for this verdict (1–300 characters)')
  .option('--until <date>', 'optional expiration date in YYYY-MM-DD format')
  .option('--by <name>', 'optional author or team handle')
  .option('--directed', 'apply only in direction <a> → <b> (default is undirected)')
  .action(
    async (
      a: string,
      b: string,
      opts: {
        expected?: boolean;
        confirmed?: boolean;
        reason?: string;
        until?: string;
        by?: string;
        directed?: boolean;
      },
      cmd: Command,
    ) => {
      const global = cmd.optsWithGlobals<GlobalOptions>();
      const result = await verdictAdd(a, b, { ...opts, cwd: global.cwd });
      if (global.json) printJson(result);
      else printVerdictAdd(result);
    },
  );

verdictCmd
  .command('list')
  .description('list configured relationship verdicts in .repo-archaeology.verdicts.json')
  .action(async (_opts: unknown, cmd: Command) => {
    const global = cmd.optsWithGlobals<GlobalOptions>();
    const result = await verdictList({ cwd: global.cwd });
    if (global.json) printJson(result);
    else printVerdictList(result);
  });

verdictCmd
  .command('prune')
  .description('remove expired verdicts from .repo-archaeology.verdicts.json')
  .action(async (_opts: unknown, cmd: Command) => {
    const global = cmd.optsWithGlobals<GlobalOptions>();
    const result = await verdictPrune({ cwd: global.cwd });
    if (global.json) printJson(result);
    else printVerdictPrune(result);
  });

for (const cmd of program.commands) {
  cmd.allowExcessArguments(false);
  for (const sub of cmd.commands) {
    sub.allowExcessArguments(false);
  }
}

program.action(async () => {
  // The bare command has a default action, so a mistyped command arrives as an extra argument.
  const [unexpected] = program.args;
  if (unexpected !== undefined) {
    const suggestion = closestCommand(unexpected, program.commands.map((cmd) => cmd.name()));
    program.error(`error: unknown command '${terminalText(unexpected)}'${suggestion ? `\n(Did you mean ${suggestion}?)` : ''}`, { exitCode: 2, code: 'commander.unknownCommand' });
  }
  const global = program.opts<GlobalOptions>();
  const ownersFlag = resolveOwnersFlag();
  const ctx = await loadContext(global.cwd, settingsFrom(global), { head: global.head });
  let changedWithoutHistory = 0;
  if (!ctx.head) {
    const changes = await workingTreeChanges(ctx.root);
    if (changes.length > 0) {
      const result = await diff(ctx, { limit: 10, kinds: [...RELATIONSHIPS], owners: ownersFlag }, changes);
      if (result.changed.some((file) => file.hasHistory)) {
        if (global.json) printJson({ mode: 'diff', ...result });
        else printDiff(result);
        return;
      }
      changedWithoutHistory = result.changed.length;
    }
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
