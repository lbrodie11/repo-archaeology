import { lstatSync, readFileSync } from 'node:fs';
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
  /** Optional list of plain prefix strings to skip (e.g. ["chore", "style", "docs"]). */
  skipCommitPrefixes?: string[];
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
  '*.min.js', '*.min.css', '*.map', '*.generated.*', '*.tsbuildinfo',
  // snapshots and release bookkeeping
  '__snapshots__/', '*.snap', 'CHANGELOG*', 'HISTORY.md',
];

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * The config file comes from the repository, which may not be yours (the README demo
 * runs on fresh clones), so its values are limited: it must not be able to hang the
 * tool or exhaust memory. Command-line flags are typed by the user and stay unrestricted.
 */
const MAX_CONFIG_BYTES = 64 * 1024;
export const MAX_FILES_PER_COMMIT_FROM_FILE = 1000;
const MAX_SKIP_PATTERN_LENGTH = 200;

/** Reads `.repo-archaeology.json` from the repository root, if present. */
export function loadConfigFile(root: string): Partial<Settings> {
  const file = join(root, CONFIG_FILE);
  // lstat, not existsSync: existsSync follows links and would silently skip a dangling symlink.
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return {};
  if (!stat.isFile()) throw new ConfigError(`${CONFIG_FILE} must be a regular file, not a symlink or device.`);
  if (stat.size > MAX_CONFIG_BYTES) throw new ConfigError(`${CONFIG_FILE} is larger than ${MAX_CONFIG_BYTES / 1024} KB.`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`${CONFIG_FILE} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${CONFIG_FILE} must contain a JSON object.`);
  }
  const settings = validatePartial(raw as Record<string, unknown>, CONFIG_FILE);
  if (settings.maxFilesPerCommit !== undefined && settings.maxFilesPerCommit > MAX_FILES_PER_COMMIT_FROM_FILE) {
    throw new ConfigError(`${CONFIG_FILE}: "maxFilesPerCommit" must be at most ${MAX_FILES_PER_COMMIT_FROM_FILE} (use --max-files for more).`);
  }
  if (settings.skipCommits !== undefined) {
    const problem = riskySkipPattern(settings.skipCommits);
    if (problem) throw new ConfigError(`${CONFIG_FILE}: "skipCommits" ${problem}. Pass it with --skip-commits if you trust it.`);
  }
  return settings;
}

/**
 * Patterns that can backtrack catastrophically: a quantified group that itself contains
 * a quantifier or an alternation, like `(a+)+` or `(a|aa)*`, and backreferences.
 * Deliberately conservative: ordinary subject filters such as `^(chore|style)\b` pass.
 */
export function riskySkipPattern(pattern: string): string | undefined {
  if (pattern.length > MAX_SKIP_PATTERN_LENGTH) return `is longer than ${MAX_SKIP_PATTERN_LENGTH} characters`;
  if (/\\(?:[1-9]|k<)/.test(pattern)) return 'uses a backreference';
  let quantifierCount = 0;
  // Find each group's contents and check whether the group is followed by a quantifier.
  const stack: number[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '[') {
      // Skip character classes, where ( ) + * | { are literal.
      for (i++; i < pattern.length && pattern[i] !== ']'; i++) if (pattern[i] === '\\') i++;
      continue;
    }
    if (ch === '*' || ch === '+' || ch === '{') quantifierCount++;
    if (ch === '(') stack.push(i);
    else if (ch === ')' && stack.length > 0) {
      const start = stack.pop()!;
      const quantified = /^(?:[*+]|\{\d*,?\d*\})/.test(pattern.slice(i + 1));
      if (quantified && /(?:^|[^\\])(?:[*+|]|\{\d*,?\d*\})/.test(pattern.slice(start + 1, i).replace(/\[(?:\\.|[^\]])*\]/g, 'x'))) {
        return 'repeats a group that contains a quantifier or alternation, which can hang on some commit messages';
      }
    }
  }
  if (quantifierCount > 2) {
    return 'has more than 2 repetition quantifiers (*, +, {n,m})';
  }
  return undefined;
}

export function validatePartial(raw: Record<string, unknown>, source: string): Partial<Settings> {
  const out: Partial<Settings> = {};
  const known = new Set(Object.keys(DEFAULT_SETTINGS).concat(['since', 'halfLifeDays', 'skipCommits', 'skipCommitPrefixes']));
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
  if (raw.skipCommitPrefixes !== undefined) {
    if (!Array.isArray(raw.skipCommitPrefixes) || raw.skipCommitPrefixes.some((p) => typeof p !== 'string' || p.trim() === '')) {
      throw new ConfigError(`${source}: "skipCommitPrefixes" must be an array of non-empty strings.`);
    }
    out.skipCommitPrefixes = raw.skipCommitPrefixes as string[];
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

export function compileSkipPattern(pattern: string | undefined, source = '--skip-commits', prefixes?: string[]): RegExp | undefined {
  const parts: string[] = [];
  if (prefixes && prefixes.length > 0) {
    const escaped = prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    parts.push(`^(?:${escaped})(?:\\b|[:\\s_-])`);
  }
  if (pattern !== undefined && pattern !== '') {
    parts.push(`(?:${pattern})`);
  }
  if (parts.length === 0) return undefined;
  try {
    return new RegExp(parts.join('|'), 'i');
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
