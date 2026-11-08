import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from './errors.js';
import { MAX_ORIGIN_PATTERN_LENGTH, riskySkipPattern, type OriginConfig, type OriginWeights } from './model/origin.js';
import { isStyleMode, type StyleMode } from './style/frame12.js';

export { ConfigError, riskySkipPattern, type StyleMode };

const INVALID_STYLE_SYMBOL = Symbol.for('repo-archaeology.invalidStyle');

export function getInvalidConfigStyle(settings: Partial<Settings> | undefined): string | undefined {
  if (!settings) return undefined;
  return (settings as Record<symbol, string | undefined>)[INVALID_STYLE_SYMBOL];
}

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
  /** Optional commit origin classification overrides and per-origin weights. */
  origin?: OriginConfig;
  /** Optional visual style mode ("classic" or "rich"). */
  style?: StyleMode;
}

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  maxCommits: 5000,
  maxFilesPerCommit: 25,
  minShared: 3,
  minConfidence: 0.4,
  ignore: Object.freeze([]) as unknown as string[],
  useDefaultIgnores: true,
});

/** Files that change "with everything" for mechanical reasons and only add noise. */
export const DEFAULT_IGNORES: readonly string[] = Object.freeze([
  // lockfiles
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock',
  'Cargo.lock', 'go.sum', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Gemfile.lock', 'composer.lock',
  // build output and vendored code
  'dist/', 'build/', 'out/', 'coverage/', 'node_modules/', 'vendor/', '.next/', '.nuxt/', '.svelte-kit/',
  '*.min.js', '*.min.css', '*.map', '*.generated.*', '*.tsbuildinfo',
  // snapshots and release bookkeeping
  '__snapshots__/', '*.snap', 'CHANGELOG*', 'HISTORY.md',
]);

/**
 * The config file comes from the repository, which may not be yours (the README demo
 * runs on fresh clones), so its values are limited: it must not be able to hang the
 * tool or exhaust memory. Command-line flags are typed by the user and stay unrestricted.
 */
export const MAX_CONFIG_BYTES = 64 * 1024;
export const MAX_FILES_PER_COMMIT_FROM_FILE = 1000;

/** Parses and validates raw JSON text from `.repo-archaeology.json`. */
export function parseConfigText(content: string, source = CONFIG_FILE): Partial<Settings> {
  if (Buffer.byteLength(content, 'utf8') > MAX_CONFIG_BYTES) {
    throw new ConfigError(`${source} is larger than ${MAX_CONFIG_BYTES / 1024} KB.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new ConfigError(`${source} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${source} must contain a JSON object.`);
  }
  const settings = validatePartial(raw as Record<string, unknown>, source);
  if (settings.maxFilesPerCommit !== undefined && settings.maxFilesPerCommit > MAX_FILES_PER_COMMIT_FROM_FILE) {
    throw new ConfigError(`${source}: "maxFilesPerCommit" must be at most ${MAX_FILES_PER_COMMIT_FROM_FILE} (use --max-files for more).`);
  }
  if (settings.skipCommits !== undefined) {
    const problem = riskySkipPattern(settings.skipCommits);
    if (problem) throw new ConfigError(`${source}: "skipCommits" ${problem}. Pass it with --skip-commits if you trust it.`);
  }
  return settings;
}

/** Reads `.repo-archaeology.json` from the repository root, if present. */
export function loadConfigFile(root: string): Partial<Settings> {
  const file = join(root, CONFIG_FILE);
  // lstat, not existsSync: existsSync follows links and would silently skip a dangling symlink.
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return {};
  if (!stat.isFile()) throw new ConfigError(`${CONFIG_FILE} must be a regular file, not a symlink or device.`);
  if (stat.size > MAX_CONFIG_BYTES) throw new ConfigError(`${CONFIG_FILE} is larger than ${MAX_CONFIG_BYTES / 1024} KB.`);
  return parseConfigText(readFileSync(file, 'utf8'), CONFIG_FILE);
}

export function validatePartial(raw: Record<string, unknown>, source: string): Partial<Settings> {
  const out: Partial<Settings> = {};
  const known = new Set(Object.keys(DEFAULT_SETTINGS).concat(['since', 'halfLifeDays', 'skipCommits', 'skipCommitPrefixes', 'origin', 'style']));
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
  if (raw.origin !== undefined) {
    out.origin = validateOriginConfig(raw.origin, source);
  }
  if (raw.style !== undefined) {
    if (isStyleMode(raw.style)) {
      out.style = raw.style;
    } else {
      Object.defineProperty(out, INVALID_STYLE_SYMBOL, {
        value: typeof raw.style === 'string' ? raw.style : JSON.stringify(raw.style),
        enumerable: false,
        configurable: true,
      });
    }
  }
  return out;
}

function validateOriginConfig(raw: unknown, source: string): OriginConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${source}: "origin" must be a JSON object.`);
  }
  const obj = raw as Record<string, unknown>;
  const knownKeys = new Set(['agentAuthorPatterns', 'botPatterns', 'agentTrailerPatterns', 'replaceDefaults', 'weights']);
  for (const key of Object.keys(obj)) {
    if (!knownKeys.has(key)) {
      throw new ConfigError(`${source}: unknown setting "origin.${key}".`);
    }
  }
  const out: OriginConfig = {};
  const validatePatternList = (field: 'agentAuthorPatterns' | 'botPatterns' | 'agentTrailerPatterns') => {
    const val = obj[field];
    if (val === undefined) return;
    if (!Array.isArray(val)) {
      throw new ConfigError(`${source}: "origin.${field}" must be an array of regular expression strings.`);
    }
    const list: string[] = [];
    for (const item of val) {
      if (typeof item !== 'string' || item.length === 0) {
        throw new ConfigError(`${source}: "origin.${field}" entries must be non-empty regular expression strings.`);
      }
      if (item.length > MAX_ORIGIN_PATTERN_LENGTH) {
        throw new ConfigError(`${source}: "origin.${field}" pattern is longer than ${MAX_ORIGIN_PATTERN_LENGTH} characters.`);
      }
      try {
        new RegExp(item, 'i');
      } catch (err) {
        throw new ConfigError(`${source}: "origin.${field}" has invalid regular expression "${item}": ${(err as Error).message}`);
      }
      const problem = riskySkipPattern(item);
      if (problem) {
        throw new ConfigError(`${source}: "origin.${field}" pattern "${item}" ${problem}.`);
      }
      list.push(item);
    }
    out[field] = list;
  };
  validatePatternList('agentAuthorPatterns');
  validatePatternList('botPatterns');
  validatePatternList('agentTrailerPatterns');

  if (obj.replaceDefaults !== undefined) {
    if (typeof obj.replaceDefaults !== 'boolean') {
      throw new ConfigError(`${source}: "origin.replaceDefaults" must be true or false.`);
    }
    out.replaceDefaults = obj.replaceDefaults;
  }
  if (obj.weights !== undefined) {
    if (typeof obj.weights !== 'object' || obj.weights === null || Array.isArray(obj.weights)) {
      throw new ConfigError(`${source}: "origin.weights" must be a JSON object.`);
    }
    const wObj = obj.weights as Record<string, unknown>;
    const knownWeightKeys = new Set(['human', 'agent', 'bot']);
    for (const key of Object.keys(wObj)) {
      if (!knownWeightKeys.has(key)) {
        throw new ConfigError(`${source}: unknown setting "origin.weights.${key}".`);
      }
    }
    const weights: OriginWeights = {};
    for (const key of ['human', 'agent', 'bot'] as const) {
      const v = wObj[key];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
        throw new ConfigError(`${source}: "origin.weights.${key}" must be a number between 0 and 1.`);
      }
      weights[key] = v;
    }
    out.weights = weights;
  }
  return out;
}

/** Defaults, then the config file, then command-line flags. Ignore lists are concatenated. */
export function resolveSettings(fromFile: Partial<Settings>, fromFlags: Partial<Settings>): Settings {
  const merged: Settings = { ...DEFAULT_SETTINGS, ...stripUndefined(fromFile), ...stripUndefined(fromFlags) };
  const invalidFileStyle = getInvalidConfigStyle(fromFile);
  if (invalidFileStyle !== undefined && merged.style === undefined) {
    Object.defineProperty(merged, INVALID_STYLE_SYMBOL, {
      value: invalidFileStyle,
      enumerable: false,
      configurable: true,
    });
  }
  merged.ignore = [...(fromFile.ignore ?? []), ...(fromFlags.ignore ?? [])];
  if (fromFile.origin !== undefined || fromFlags.origin !== undefined) {
    const fileOrigin = fromFile.origin ?? {};
    const flagOrigin = fromFlags.origin ?? {};
    const mergedWeights =
      fileOrigin.weights !== undefined || flagOrigin.weights !== undefined
        ? { ...stripUndefined(fileOrigin.weights ?? {}), ...stripUndefined(flagOrigin.weights ?? {}) }
        : undefined;
    merged.origin = {
      ...stripUndefined(fileOrigin),
      ...stripUndefined(flagOrigin),
      ...(mergedWeights !== undefined ? { weights: mergedWeights } : {}),
    };
  }
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
