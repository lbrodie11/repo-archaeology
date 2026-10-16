import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONFIG_FILE = '.repo-archaeology.json';

export interface Settings {
  /** Analyze at most this many (non-merge) commits, newest first. */
  maxCommits: number;
  /** Optional git --since value, e.g. "2 years ago" or "2024-01-01". */
  since?: string;
  /** Commits touching more files than this (after ignores) are treated as sweeps and skipped. */
  maxFilesPerCommit: number;
  /** Minimum number of shared commits before a relationship is reported. */
  minShared: number;
  /** Minimum directional confidence (0..1) before a relationship is reported. */
  minConfidence: number;
  /** Optional recency half-life in days. Older commits count less when set. */
  halfLifeDays?: number;
  /** Optional regular expression (case-insensitive): commits whose subject matches are left out. */
  skipCommits?: string;
  /** Extra glob patterns to ignore, added to the defaults. */
  ignore: string[];
  /** Set to false to drop the built-in ignore list. */
  useDefaultIgnores: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  maxCommits: 5000,
  maxFilesPerCommit: 25,
  minShared: 3,
  minConfidence: 0.4,
  ignore: [],
  useDefaultIgnores: true,
};

/** Files that change "with everything" for mechanical reasons and only add noise. */
export const DEFAULT_IGNORES = [
  // lockfiles
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock',
  'Cargo.lock', 'go.sum', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Gemfile.lock', 'composer.lock',
  // build output and vendored code
  'dist/', 'build/', 'out/', 'coverage/', 'node_modules/', 'vendor/', '.next/', '.nuxt/', '.svelte-kit/',
  '*.min.js', '*.min.css', '*.map', '*.generated.*',
  // snapshots and release bookkeeping
  '__snapshots__/', '*.snap', 'CHANGELOG*', 'HISTORY.md',
];

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Reads `.repo-archaeology.json` from the repository root, if present. */
export function loadConfigFile(root: string): Partial<Settings> {
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`${CONFIG_FILE} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${CONFIG_FILE} must contain a JSON object.`);
  }
  return validatePartial(raw as Record<string, unknown>, CONFIG_FILE);
}

export function validatePartial(raw: Record<string, unknown>, source: string): Partial<Settings> {
  const out: Partial<Settings> = {};
  const known = new Set(Object.keys(DEFAULT_SETTINGS).concat(['since', 'halfLifeDays', 'skipCommits']));
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new ConfigError(`${source}: unknown setting "${key}".`);
  }
  const int = (key: keyof Settings, min: number) => {
    const v = raw[key];
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
      throw new ConfigError(`${source}: "${key}" must be an integer >= ${min}.`);
    }
    (out as Record<string, unknown>)[key] = v;
  };
  int('maxCommits', 1);
  int('maxFilesPerCommit', 2);
  int('minShared', 1);
  if (raw.minConfidence !== undefined) {
    const v = raw.minConfidence;
    if (typeof v !== 'number' || v < 0 || v > 1) throw new ConfigError(`${source}: "minConfidence" must be between 0 and 1.`);
    out.minConfidence = v;
  }
  if (raw.halfLifeDays !== undefined) {
    const v = raw.halfLifeDays;
    if (typeof v !== 'number' || !(v > 0)) throw new ConfigError(`${source}: "halfLifeDays" must be a positive number.`);
    out.halfLifeDays = v;
  }
  if (raw.since !== undefined) {
    if (typeof raw.since !== 'string' || raw.since.trim() === '') throw new ConfigError(`${source}: "since" must be a non-empty string.`);
    out.since = raw.since;
  }
  if (raw.skipCommits !== undefined) {
    if (typeof raw.skipCommits !== 'string') throw new ConfigError(`${source}: "skipCommits" must be a regular expression string.`);
    compileSkipPattern(raw.skipCommits, source);
    out.skipCommits = raw.skipCommits;
  }
  if (raw.ignore !== undefined) {
    if (!Array.isArray(raw.ignore) || raw.ignore.some((p) => typeof p !== 'string')) {
      throw new ConfigError(`${source}: "ignore" must be an array of glob strings.`);
    }
    out.ignore = raw.ignore as string[];
  }
  if (raw.useDefaultIgnores !== undefined) {
    if (typeof raw.useDefaultIgnores !== 'boolean') throw new ConfigError(`${source}: "useDefaultIgnores" must be true or false.`);
    out.useDefaultIgnores = raw.useDefaultIgnores;
  }
  return out;
}

/** Defaults, then the config file, then command-line flags. Ignore lists are concatenated. */
export function resolveSettings(fromFile: Partial<Settings>, fromFlags: Partial<Settings>): Settings {
  const merged: Settings = { ...DEFAULT_SETTINGS, ...stripUndefined(fromFile), ...stripUndefined(fromFlags) };
  merged.ignore = [...(fromFile.ignore ?? []), ...(fromFlags.ignore ?? [])];
  return merged;
}

export function compileSkipPattern(pattern: string | undefined, source = '--skip-commits'): RegExp | undefined {
  if (pattern === undefined || pattern === '') return undefined;
  try {
    return new RegExp(pattern, 'i');
  } catch (err) {
    throw new ConfigError(`${source}: invalid regular expression: ${(err as Error).message}`);
  }
}

export function ignorePatterns(settings: Settings): string[] {
  return [...(settings.useDefaultIgnores ? DEFAULT_IGNORES : []), ...settings.ignore];
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
