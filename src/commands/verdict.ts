import { resolve } from 'node:path';
import { ConfigError } from '../config.js';
import { UsageError } from '../context.js';
import { findRepoRoot } from '../git/repo.js';
import {
  isSameVerdictPair,
  isValidIsoDate,
  loadVerdictsFile,
  MAX_VERDICT_REASON_LENGTH,
  resolveCliVerdictEndpoint,
  sortVerdictEntries,
  todayIsoDate,
  validateVerdictPairSpecificity,
  VERDICTS_FILE,
  VERDICTS_SCHEMA_URL,
  writeVerdictsFile,
  type VerdictEntry,
  type VerdictKind,
  type VerdictsMeta,
} from '../model/verdicts.js';
import { c, plural, terminalText } from '../util/term.js';

export interface VerdictAddOptions {
  expected?: boolean;
  confirmed?: boolean;
  reason?: string;
  until?: string;
  by?: string;
  directed?: boolean;
  cwd?: string;
}

export interface VerdictAddResult {
  file: typeof VERDICTS_FILE;
  entry: VerdictEntry;
  replaced: boolean;
  total: number;
  warnings: string[];
}

export interface VerdictListEntryView extends VerdictEntry {
  expired: boolean;
}

export interface VerdictListResult {
  version: 1;
  file: typeof VERDICTS_FILE;
  exists: boolean;
  meta: VerdictsMeta;
  verdicts: VerdictListEntryView[];
  warnings: string[];
}

export interface VerdictPruneResult {
  file: typeof VERDICTS_FILE;
  exists: boolean;
  pruned: number;
  remaining: number;
  removed: VerdictEntry[];
  warnings: string[];
}

export async function verdictAdd(
  firstInput: string,
  secondInput: string,
  options: VerdictAddOptions,
): Promise<VerdictAddResult> {
  if (Boolean(options.expected) === Boolean(options.confirmed)) {
    throw new UsageError('Specify exactly one of --expected or --confirmed.');
  }
  const verdict: VerdictKind = options.expected ? 'expected' : 'confirmed';

  if (typeof options.reason !== 'string' || options.reason.trim().length < 1 || options.reason.length > MAX_VERDICT_REASON_LENGTH) {
    throw new UsageError(`--reason is required and must be 1–${MAX_VERDICT_REASON_LENGTH} characters.`);
  }

  let until: string | undefined;
  if (options.until !== undefined) {
    if (!isValidIsoDate(options.until)) {
      throw new UsageError('--until must be a valid ISO date in YYYY-MM-DD format.');
    }
    until = options.until;
  }

  let by: string | undefined;
  if (options.by !== undefined) {
    if (typeof options.by !== 'string' || options.by.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(options.by)) {
      throw new UsageError('--by must be a non-empty string.');
    }
    by = options.by.trim();
  }

  const cwd = resolve(options.cwd ?? process.cwd());
  const root = await findRepoRoot(cwd);

  let first: string;
  let second: string;
  try {
    first = resolveCliVerdictEndpoint(root, firstInput, 'First path', cwd);
    second = resolveCliVerdictEndpoint(root, secondInput, 'Second path', cwd);
    validateVerdictPairSpecificity(first, second, 'Verdict pair');
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new UsageError(err.message);
    }
    throw err;
  }

  const entry: VerdictEntry = {
    pair: [first, second],
    verdict,
    reason: options.reason,
    ...(until !== undefined ? { until } : {}),
    ...(by !== undefined ? { by } : {}),
    ...(options.directed === true ? { directed: true } : {}),
  };

  const loaded = loadVerdictsFile(root);
  const nextEntries: VerdictEntry[] = [];
  let replaced = false;
  for (const existing of loaded.entries) {
    if (isSameVerdictPair(existing, entry)) {
      if (!replaced) {
        nextEntries.push(entry);
        replaced = true;
      }
    } else {
      nextEntries.push(existing);
    }
  }
  if (!replaced) {
    nextEntries.push(entry);
  }

  const sorted = sortVerdictEntries(nextEntries);
  const schema = loaded.exists ? loaded.schema : VERDICTS_SCHEMA_URL;
  writeVerdictsFile(root, sorted, schema);

  return {
    file: VERDICTS_FILE,
    entry,
    replaced,
    total: sorted.length,
    warnings: loaded.warnings,
  };
}

export async function verdictList(options?: { cwd?: string; nowDate?: string }): Promise<VerdictListResult> {
  const cwd = resolve(options?.cwd ?? process.cwd());
  const root = await findRepoRoot(cwd);
  const loaded = loadVerdictsFile(root, { nowDate: options?.nowDate });
  const today = options?.nowDate ?? todayIsoDate();
  const verdicts: VerdictListEntryView[] = loaded.entries.map((entry) => ({
    ...entry,
    expired: entry.until !== undefined && entry.until < today,
  }));
  return {
    version: 1,
    file: VERDICTS_FILE,
    exists: loaded.exists,
    meta: loaded.meta,
    verdicts,
    warnings: loaded.warnings,
  };
}

export async function verdictPrune(options?: { cwd?: string; nowDate?: string }): Promise<VerdictPruneResult> {
  const cwd = resolve(options?.cwd ?? process.cwd());
  const root = await findRepoRoot(cwd);
  const loaded = loadVerdictsFile(root, { nowDate: options?.nowDate });
  if (!loaded.exists) {
    return {
      file: VERDICTS_FILE,
      exists: false,
      pruned: 0,
      remaining: 0,
      removed: [],
      warnings: [],
    };
  }
  const sortedActive = sortVerdictEntries(loaded.activeEntries);
  if (loaded.expiredEntries.length > 0) {
    writeVerdictsFile(root, sortedActive, loaded.schema);
  }
  return {
    file: VERDICTS_FILE,
    exists: true,
    pruned: loaded.expiredEntries.length,
    remaining: sortedActive.length,
    removed: loaded.expiredEntries,
    warnings: loaded.warnings,
  };
}

export function printVerdictAdd(result: VerdictAddResult): void {
  const arrow = result.entry.directed ? '→' : '↔';
  const pairLabel = `${c.bold(terminalText(result.entry.pair[0]))} ${c.dim(arrow)} ${c.bold(terminalText(result.entry.pair[1]))}`;
  const kindLabel = result.entry.verdict === 'confirmed' ? c.green('confirmed') : c.yellow('expected');
  if (result.replaced) {
    console.log(c.yellow(`Notice: replaced existing verdict for ${pairLabel} in ${result.file}.`));
  }
  console.log(`${c.green('✓')} Saved ${kindLabel} verdict for ${pairLabel} in ${c.bold(result.file)} (${plural(result.total, 'verdict')} total).`);
}

export function printVerdictList(result: VerdictListResult): void {
  console.log(`${c.bold('Repo Archaeology')} ${c.dim('·')} verdicts ${c.dim(`(${result.file})`)}`);
  console.log(
    c.dim(
      `${plural(result.meta.loaded, 'verdict')} loaded (${result.meta.active} active, ${result.meta.expired} expired)`,
    ),
  );
  console.log();
  if (result.verdicts.length === 0) {
    console.log(`No relationship verdicts configured in ${result.file}.`);
    return;
  }
  result.verdicts.forEach((v, i) => {
    const n = c.dim(`${String(i + 1).padStart(2)}.`);
    const arrow = v.directed ? '→' : '↔';
    const kindBadge = v.verdict === 'confirmed' ? c.green('confirmed') : c.yellow('expected');
    const expBadge = v.expired ? ` ${c.red('[expired]')}` : '';
    const metaParts: string[] = [];
    if (v.by) metaParts.push(`by ${terminalText(v.by)}`);
    if (v.until) metaParts.push(`until ${terminalText(v.until)}`);
    const metaStr = metaParts.length > 0 ? c.dim(` (${metaParts.join(', ')})`) : '';
    console.log(
      `${n} ${c.bold(terminalText(v.pair[0]))} ${c.dim(arrow)} ${c.bold(terminalText(v.pair[1]))}  ${kindBadge}${expBadge}${metaStr}`,
    );
    console.log(`    ${terminalText(v.reason)}`);
  });
}

export function printVerdictPrune(result: VerdictPruneResult): void {
  if (!result.exists) {
    console.log(`No ${result.file} file found.`);
    return;
  }
  if (result.pruned === 0) {
    console.log(`${c.green('✓')} No expired verdicts in ${c.bold(result.file)} (${plural(result.remaining, 'active verdict')}).`);
    return;
  }
  console.log(
    `${c.green('✓')} Pruned ${plural(result.pruned, 'expired verdict')} from ${c.bold(result.file)} (${plural(result.remaining, 'active verdict')} remaining).`,
  );
}
