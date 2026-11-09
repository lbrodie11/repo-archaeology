import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ConfigError } from '../config.js';
import type { ChangedFile } from '../git/changes.js';
import type { History } from './history.js';
import { pathOf } from './history.js';
import { globToRegExp } from '../util/glob.js';

export const VERDICTS_FILE = '.repo-archaeology.verdicts.json';
export const VERDICTS_SCHEMA_URL =
  'https://raw.githubusercontent.com/lbrodie11/repo-archaeology/v0.6.0/schema/verdicts.schema.json';
export const MAX_VERDICTS_BYTES = 256 * 1024;
export const MAX_VERDICT_REASON_LENGTH = 300;

export type VerdictKind = 'expected' | 'confirmed';

export interface VerdictEntry {
  pair: [string, string];
  verdict: VerdictKind;
  reason: string;
  until?: string;
  by?: string;
  directed?: boolean;
}

export interface VerdictsFile {
  $schema?: string;
  version: 1;
  verdicts: VerdictEntry[];
}

export interface RelationshipVerdictView {
  kind: VerdictKind;
  reason: string;
  by?: string;
  until?: string;
}

export interface VerdictsMeta {
  loaded: number;
  active: number;
  expired: number;
  file: typeof VERDICTS_FILE;
}

export interface LoadedVerdicts {
  exists: boolean;
  schema?: string;
  entries: VerdictEntry[];
  activeEntries: VerdictEntry[];
  expiredEntries: VerdictEntry[];
  meta: VerdictsMeta;
  warnings: string[];
}

const KNOWN_TOP_LEVEL_KEYS = new Set(['version', 'verdicts', '$schema']);
const KNOWN_ENTRY_KEYS = new Set(['pair', 'verdict', 'reason', 'until', 'by', 'directed']);
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Returns today's UTC date formatted as `YYYY-MM-DD`. */
export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Returns true if `pattern` uses glob syntax (`*`, `**`, `?`, `{a,b}` alternation, or trailing `/`).
 * Literal `{` without a comma-separated alternation (e.g. `routes/{id}.ts`) and `[` (e.g. `app/[id]/page.tsx`)
 * are treated as exact file path characters rather than globs.
 */
export function isGlobPattern(pattern: string): boolean {
  return /[*?]|\/$|\{[^}]*,[^}]*\}/.test(pattern);
}

/**
 * Returns true when a verdict endpoint is either an exact file path or a glob anchored by
 * at least one fixed directory segment or a non-wildcard filename/extension literal.
 * Rejects pure catch-all globs such as `*`, `**`, `**\/*`, `*.*`, or `**\/*.*`.
 */
export function isAnchoredVerdictEndpoint(pattern: string): boolean {
  if (!isGlobPattern(pattern)) return true;
  const isDirPattern = pattern.endsWith('/');
  const trimmed = pattern.replace(/\/+$/, '');
  const segments = trimmed.split('/').filter(Boolean);
  if (segments.length === 0) return false;
  const dirSegments = isDirPattern ? segments : segments.slice(0, -1);
  if (dirSegments.some((seg) => !/[*?]|(\{[^}]*,[^}]*\})/.test(seg) && seg.length > 0)) {
    return true;
  }
  if (isDirPattern) return false;
  const last = segments[segments.length - 1] ?? '';
  // Replace `{a,b}` alternations with a literal token only if every branch has a literal char.
  const expanded = last.replace(/\{([^}]*,[^}]*)\}/g, (_, body: string) => {
    const branches = body.split(',');
    return branches.every((b) => b.replace(/[*?.]/g, '').length > 0) ? 'a' : '';
  });
  const literalChars = expanded.replace(/[*?.]/g, '');
  return literalChars.length > 0;
}

/** Ensures at least one endpoint of a verdict pair is an exact path or anchored glob. */
export function validateVerdictPairSpecificity(first: string, second: string, label: string): void {
  if (!isAnchoredVerdictEndpoint(first) && !isAnchoredVerdictEndpoint(second)) {
    throw new ConfigError(
      `${label} is too broad ("${first}", "${second}"): at least one endpoint must be an exact path or a glob with a fixed directory or extension.`,
    );
  }
}

/** Validates that `value` is a real calendar date in `YYYY-MM-DD` format. */
export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const [yStr, mStr, dStr] = value.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

/**
 * Validates and normalizes a verdict endpoint (either a repo-relative POSIX path or a glob).
 */
export function normalizeVerdictEndpoint(raw: unknown, label: string): string {
  if (typeof raw !== 'string') {
    throw new ConfigError(`${label} must be a non-empty string.`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ConfigError(`${label} must be a non-empty string.`);
  }
  if (CONTROL_CHAR_RE.test(trimmed)) {
    throw new ConfigError(`${label} must not contain control characters.`);
  }
  const posixPath = trimmed.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  if (posixPath.length === 0 || posixPath.startsWith('/') || /^[A-Za-z]:/.test(posixPath)) {
    throw new ConfigError(`${label} must be a repository-relative path or glob (got "${raw}").`);
  }
  const segments = posixPath.split('/');
  if (segments.some((seg) => seg === '..' || seg === '.')) {
    throw new ConfigError(`${label} must not contain "." or ".." path segments (got "${raw}").`);
  }
  if (!isGlobPattern(posixPath) && segments.some((seg) => seg.length === 0)) {
    throw new ConfigError(`${label} must not contain empty path segments (got "${raw}").`);
  }
  return posixPath;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function realpathLenient(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realpathLenient(parent), basename(path));
  }
}

/**
 * Resolves symlink or 8.3 aliases at or above `realRoot` (such as `/var` -> `/private/var` on macOS
 * or `RUNNER~1` -> `runneradmin` on Windows) while preserving the lexical path beneath `realRoot`
 * so tracked symlinks inside the repository are recorded under their symlink path.
 */
function normalizeAtRepoRoot(path: string, realRoot: string): string {
  const resolved = resolve(path);
  if (isWithinRoot(realRoot, resolved)) return resolved;

  const chain: { dir: string; suffix: string[] }[] = [];
  let cursor = resolved;
  const parts: string[] = [];
  while (true) {
    chain.push({ dir: cursor, suffix: [...parts] });
    const parent = dirname(cursor);
    if (parent === cursor) break;
    parts.unshift(basename(cursor));
    cursor = parent;
  }
  chain.reverse();

  for (const { dir, suffix } of chain) {
    try {
      if (realpathSync.native(dir) === realRoot) {
        return suffix.length > 0 ? resolve(realRoot, ...suffix) : realRoot;
      }
    } catch {
      break;
    }
  }
  return resolved;
}

/**
 * Normalizes a CLI user argument for `verdict add <a> <b>`:
 * - Globs are normalized directly as repo-relative patterns.
 * - Exact file paths are resolved lexically relative to `cwd` against `root` so running from a
 *   subdirectory works cleanly without dereferencing symlinks inside the repository.
 */
export function resolveCliVerdictEndpoint(root: string, input: string, label: string, cwd = process.cwd()): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new ConfigError(`${label} must be a non-empty path or glob.`);
  }
  const normalizedInput = input.trim().replace(/\\/g, '/');
  if (isGlobPattern(normalizedInput)) {
    return normalizeVerdictEndpoint(normalizedInput, label);
  }
  if (normalizedInput.startsWith('/') || /^[A-Za-z]:/.test(normalizedInput)) {
    throw new ConfigError(`${label} must be inside the repository (${input}).`);
  }
  const realRoot = realpathLenient(resolve(root));
  const normalizedCwd = normalizeAtRepoRoot(cwd, realRoot);
  const baseCwd = isWithinRoot(realRoot, normalizedCwd) ? normalizedCwd : realpathLenient(resolve(cwd));
  const rawTarget = resolve(baseCwd, input);
  const target = normalizeAtRepoRoot(rawTarget, realRoot);
  const rel = relative(realRoot, target);
  if (rel === '' || rel === '.' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ConfigError(`${label} must be inside the repository (${input}).`);
  }
  return normalizeVerdictEndpoint(rel.split(sep).join('/'), label);
}

function validateVerdictEntry(
  raw: unknown,
  index: number,
  source: string,
  warnings: string[],
): VerdictEntry {
  const entryLabel = `${source}: verdicts[${index}]`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${entryLabel} must be an object.`);
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KNOWN_ENTRY_KEYS.has(key)) {
      warnings.push(`Unknown key "${key}" in ${source} verdicts[${index}] was ignored.`);
    }
  }

  if (!Array.isArray(obj.pair) || obj.pair.length !== 2) {
    throw new ConfigError(`${entryLabel}.pair must be an array of two path or glob strings.`);
  }
  const first = normalizeVerdictEndpoint(obj.pair[0], `${entryLabel}.pair[0]`);
  const second = normalizeVerdictEndpoint(obj.pair[1], `${entryLabel}.pair[1]`);
  validateVerdictPairSpecificity(first, second, `${entryLabel}.pair`);

  if (obj.verdict !== 'expected' && obj.verdict !== 'confirmed') {
    throw new ConfigError(`${entryLabel}.verdict must be "expected" or "confirmed".`);
  }

  if (typeof obj.reason !== 'string') {
    throw new ConfigError(`${entryLabel}.reason must be a string of 1–${MAX_VERDICT_REASON_LENGTH} characters.`);
  }
  if (obj.reason.trim().length < 1 || obj.reason.length > MAX_VERDICT_REASON_LENGTH) {
    throw new ConfigError(`${entryLabel}.reason must be 1–${MAX_VERDICT_REASON_LENGTH} characters (non-whitespace).`);
  }

  let until: string | undefined;
  if (obj.until !== undefined) {
    if (typeof obj.until !== 'string' || !isValidIsoDate(obj.until)) {
      throw new ConfigError(`${entryLabel}.until must be a valid ISO date in YYYY-MM-DD format.`);
    }
    until = obj.until;
  }

  let by: string | undefined;
  if (obj.by !== undefined) {
    if (typeof obj.by !== 'string' || obj.by.trim().length === 0 || CONTROL_CHAR_RE.test(obj.by)) {
      throw new ConfigError(`${entryLabel}.by must be a non-empty string.`);
    }
    by = obj.by.trim();
  }

  let directed: boolean | undefined;
  if (obj.directed !== undefined) {
    if (typeof obj.directed !== 'boolean') {
      throw new ConfigError(`${entryLabel}.directed must be a boolean.`);
    }
    directed = obj.directed;
  }

  return {
    pair: [first, second],
    verdict: obj.verdict,
    reason: obj.reason,
    ...(until !== undefined ? { until } : {}),
    ...(by !== undefined ? { by } : {}),
    ...(directed !== undefined ? { directed } : {}),
  };
}

export function emptyLoadedVerdicts(): LoadedVerdicts {
  return {
    exists: false,
    entries: [],
    activeEntries: [],
    expiredEntries: [],
    meta: {
      loaded: 0,
      active: 0,
      expired: 0,
      file: VERDICTS_FILE,
    },
    warnings: [],
  };
}

export function parseVerdictsText(
  content: string,
  source: string,
  options?: { nowDate?: string },
): LoadedVerdicts {
  if (Buffer.byteLength(content, 'utf8') > MAX_VERDICTS_BYTES) {
    throw new ConfigError(`${source} exceeds the 256 KB size limit.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new ConfigError(`Could not parse ${source}: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`${source} must contain a JSON object.`);
  }
  const root = parsed as Record<string, unknown>;
  const warnings: string[] = [];
  for (const key of Object.keys(root)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      warnings.push(`Unknown key "${key}" in ${source} was ignored.`);
    }
  }
  let schema: string | undefined;
  if (root.$schema !== undefined) {
    if (typeof root.$schema !== 'string' || root.$schema.trim().length === 0 || CONTROL_CHAR_RE.test(root.$schema)) {
      throw new ConfigError(`${source}: "$schema" must be a non-empty string.`);
    }
    schema = root.$schema.trim();
  }
  if (root.version !== 1) {
    throw new ConfigError(`${source}: "version" must be 1.`);
  }
  if (!Array.isArray(root.verdicts)) {
    throw new ConfigError(`${source}: "verdicts" must be an array.`);
  }

  const today = options?.nowDate ?? todayIsoDate();
  const entries: VerdictEntry[] = [];
  const activeEntries: VerdictEntry[] = [];
  const expiredEntries: VerdictEntry[] = [];

  for (let i = 0; i < root.verdicts.length; i++) {
    const entry = validateVerdictEntry(root.verdicts[i], i, source, warnings);
    entries.push(entry);
    if (entry.until !== undefined && entry.until < today) {
      expiredEntries.push(entry);
      const arrow = entry.directed ? '→' : '↔';
      warnings.push(
        `Verdict verdicts[${i}] (${entry.pair[0]} ${arrow} ${entry.pair[1]}) expired on ${entry.until} and was ignored.`,
      );
    } else {
      activeEntries.push(entry);
    }
  }

  return {
    exists: true,
    ...(schema !== undefined ? { schema } : {}),
    entries,
    activeEntries,
    expiredEntries,
    meta: {
      loaded: entries.length,
      active: activeEntries.length,
      expired: expiredEntries.length,
      file: VERDICTS_FILE,
    },
    warnings,
  };
}

/**
 * Loads `.repo-archaeology.verdicts.json` from the repository root if it exists.
 * Rejects symlinks, non-regular files, and files larger than 256 KB.
 */
export function loadVerdictsFile(root: string, options?: { nowDate?: string }): LoadedVerdicts {
  const file = join(root, VERDICTS_FILE);
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) {
    return emptyLoadedVerdicts();
  }
  if (!stat.isFile()) {
    throw new ConfigError(`Refusing to read ${VERDICTS_FILE}: not a regular file.`);
  }
  if (stat.size > MAX_VERDICTS_BYTES) {
    throw new ConfigError(`${VERDICTS_FILE} exceeds the 256 KB size limit.`);
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new ConfigError(`Could not read ${VERDICTS_FILE}: ${(err as Error).message}`);
  }
  return parseVerdictsText(text, VERDICTS_FILE, options);
}

/**
 * Extracts a map of historical path -> latest live canonical path from `History`.
 * When `a.ts` was renamed to `b.ts` (and optionally `b.ts` to `c.ts`), maps `a.ts -> c.ts` and `b.ts -> c.ts`.
 * If a new file was later created at `a.ts`, `a.ts` is not redirected to `b.ts`.
 */
type RenameChangeInput = Pick<ChangedFile, 'path' | 'oldPath'> &
  Partial<Pick<ChangedFile, 'priorPaths' | 'deleted'>>;

/**
 * Extracts a map of historical/baseline/intermediate path -> current live canonical path.
 * - Pre-baseline renames in `history` map to their baseline canonical path.
 * - Active changes (`activeChanges`) map baseline `oldPath` (and any intermediate branch/working-tree
 *   `priorPaths`) directly to `change.path` WITHOUT transitively merging `baseline -> current`
 *   mappings across distinct files when a rename destination reuses another file's old path.
 */
export function buildRenameAliasMap(
  history?: History,
  activeChanges?: readonly RenameChangeInput[],
): Map<string, string> {
  const historyToBaseline = new Map<string, string>();
  const claimedAtBaseline = new Set<string>();

  if (history) {
    const allCommits = [...history.commits, ...history.excluded].sort(
      (a, b) => b.commitTime - a.commitTime || b.time - a.time || (a.logOrder ?? 0) - (b.logOrder ?? 0),
    );
    for (const commit of allCommits) {
      const map = commit.changesByIdentity;
      if (!map) continue;
      for (const [identity, change] of Object.entries(map)) {
        // Ignore earlier deleted lifetimes (`path\u0000n`).
        if (identity.includes('\u0000')) continue;
        const baselineCanonical = pathOf(identity);
        claimedAtBaseline.add(baselineCanonical);
        if (
          change.path !== baselineCanonical &&
          !claimedAtBaseline.has(change.path) &&
          !historyToBaseline.has(change.path)
        ) {
          historyToBaseline.set(change.path, baselineCanonical);
        }
        if (
          change.oldPath !== undefined &&
          change.oldPath !== baselineCanonical &&
          !claimedAtBaseline.has(change.oldPath) &&
          !historyToBaseline.has(change.oldPath)
        ) {
          historyToBaseline.set(change.oldPath, baselineCanonical);
        }
      }
    }
    if (history.renames) {
      for (const [oldPath, newPath] of Object.entries(history.renames)) {
        if (oldPath !== newPath && !claimedAtBaseline.has(oldPath) && !historyToBaseline.has(oldPath)) {
          historyToBaseline.set(oldPath, newPath);
        }
      }
    }
  }

  // Flatten any multi-hop chains purely within committed baseline `history`.
  for (const [oldPath, target] of historyToBaseline.entries()) {
    const resolved = followAliasChain(target, historyToBaseline);
    if (resolved !== oldPath) {
      historyToBaseline.set(oldPath, resolved);
    } else {
      historyToBaseline.delete(oldPath);
    }
  }

  if (!activeChanges || activeChanges.length === 0) {
    return historyToBaseline;
  }

  // `activeChanges` already represents net baseline-to-current mappings (`oldPath` is baseline,
  // `path` is current) plus any intermediate branch/worktree rename steps in `priorPaths`.
  // Never chain `baselineToCurrent` with itself so `b -> c` + `a -> b` stay separate identities.
  const baselineToCurrent = new Map<string, string>();
  const intermediateToCurrent = new Map<string, string>();
  const currentClaimed = new Set<string>();

  for (const change of activeChanges) {
    if (change.deleted) continue;
    currentClaimed.add(change.path);
    if (change.oldPath && change.oldPath !== change.path) {
      baselineToCurrent.set(change.oldPath, change.path);
    }
  }

  for (const change of activeChanges) {
    if (change.deleted || !change.priorPaths) continue;
    for (const prior of change.priorPaths) {
      if (
        prior !== change.path &&
        prior !== change.oldPath &&
        !currentClaimed.has(prior) &&
        !baselineToCurrent.has(prior) &&
        !intermediateToCurrent.has(prior)
      ) {
        intermediateToCurrent.set(prior, change.path);
      }
    }
  }

  const combined = new Map<string, string>();
  for (const [oldPath, baselineTarget] of historyToBaseline.entries()) {
    const finalTarget = baselineToCurrent.get(baselineTarget) ?? baselineTarget;
    if (finalTarget !== oldPath) {
      combined.set(oldPath, finalTarget);
    }
  }
  for (const [baseOld, currentPath] of baselineToCurrent.entries()) {
    if (baseOld !== currentPath) {
      combined.set(baseOld, currentPath);
    }
  }
  for (const [midPath, currentPath] of intermediateToCurrent.entries()) {
    if (midPath !== currentPath && !combined.has(midPath)) {
      combined.set(midPath, currentPath);
    }
  }

  return combined;
}

function followAliasChain(start: string, map: ReadonlyMap<string, string>): string {
  let cur = start;
  for (let hops = 0; hops < 100; hops++) {
    const next = map.get(cur);
    if (next === undefined || next === cur) return cur;
    cur = next;
  }
  return cur;
}

interface CompiledEndpoint {
  raw: string;
  isGlob: boolean;
  regex?: RegExp;
  literalSegments: number;
  literalChars: number;
}

interface CompiledVerdict {
  entry: VerdictEntry;
  view: RelationshipVerdictView;
  first: CompiledEndpoint;
  second: CompiledEndpoint;
  directed: boolean;
  exactCount: number;
  literalSegments: number;
  literalChars: number;
}

function compileEndpoint(raw: string): CompiledEndpoint {
  const segments = raw.replace(/\/+$/, '').split('/').filter(Boolean);
  const literalSegments = segments.filter((seg) => !/[*?]|(\{[^}]*,[^}]*\})/.test(seg)).length;
  const literalChars = raw.replace(/[*?{},/]/g, '').length;
  if (isGlobPattern(raw)) {
    return { raw, isGlob: true, regex: globToRegExp(raw), literalSegments, literalChars };
  }
  return { raw, isGlob: false, literalSegments, literalChars };
}

/**
 * Deterministic, serialization-independent precedence comparator for matching verdicts:
 * 1. More exact (non-glob) endpoints win (`2 > 1 > 0`).
 * 2. More literal non-wildcard path segments win (`["src/*.ts", "src/*.ts"]` beats `["**\/*.ts", "**\/*.ts"]`).
 * 3. More literal non-wildcard characters win.
 * 4. Directed rules (`directed: true`) beat undirected rules (`directed: false`).
 * 5. `"confirmed"` beats `"expected"` when specificity is equal.
 * 6. Canonical lexical tie-breaker (`pair[0]`, `pair[1]`, `reason`).
 */
function compareCompiledVerdictPrecedence(a: CompiledVerdict, b: CompiledVerdict): number {
  if (a.exactCount !== b.exactCount) return b.exactCount - a.exactCount;
  if (a.literalSegments !== b.literalSegments) return b.literalSegments - a.literalSegments;
  if (a.literalChars !== b.literalChars) return b.literalChars - a.literalChars;
  if (a.directed !== b.directed) return a.directed ? -1 : 1;
  if (a.entry.verdict !== b.entry.verdict) {
    return a.entry.verdict === 'confirmed' ? -1 : 1;
  }
  const canonicalPair = (v: CompiledVerdict): [string, string] =>
    v.directed || v.entry.pair[0] <= v.entry.pair[1]
      ? v.entry.pair
      : [v.entry.pair[1], v.entry.pair[0]];
  const [a0, a1] = canonicalPair(a);
  const [b0, b1] = canonicalPair(b);
  return compareStrings(a0, b0) || compareStrings(a1, b1) || compareStrings(a.entry.reason, b.entry.reason);
}

/**
 * Matches directional or undirected candidate relationships `(from, to)` against active verdicts.
 * - Exact (non-glob) verdict paths are matched through rename identities so a verdict on `a.ts`
 *   continues to match after `a.ts -> b.ts`.
 * - Glob verdicts match current paths only.
 */
export class VerdictMatcher {
  readonly meta: VerdictsMeta;
  readonly loaded: LoadedVerdicts;
  private readonly history?: History;
  private readonly compiled: CompiledVerdict[];
  private readonly baseAliases: Map<string, string>;

  constructor(
    loaded: LoadedVerdicts,
    history?: History,
    activeChanges?: readonly RenameChangeInput[],
  ) {
    this.loaded = loaded;
    this.meta = loaded.meta;
    this.history = history;
    this.baseAliases = buildRenameAliasMap(history, activeChanges);
    this.compiled = loaded.activeEntries.map((entry) => {
      const first = compileEndpoint(entry.pair[0]);
      const second = compileEndpoint(entry.pair[1]);
      return {
        entry,
        view: {
          kind: entry.verdict,
          reason: entry.reason,
          ...(entry.by !== undefined ? { by: entry.by } : {}),
          ...(entry.until !== undefined ? { until: entry.until } : {}),
        },
        first,
        second,
        directed: entry.directed === true,
        exactCount: (!first.isGlob ? 1 : 0) + (!second.isGlob ? 1 : 0),
        literalSegments: first.literalSegments + second.literalSegments,
        literalChars: first.literalChars + second.literalChars,
      };
    });
  }

  /** Returns a clone with branch/working-tree rename mappings (including intermediate branch renames) applied. */
  withChanges(changes: readonly RenameChangeInput[]): VerdictMatcher {
    if (
      changes.length === 0 ||
      !changes.some(
        (c) =>
          (c.oldPath && c.oldPath !== c.path) ||
          (c.priorPaths && c.priorPaths.some((p) => p !== c.path)),
      )
    ) {
      return this;
    }
    return new VerdictMatcher(this.loaded, this.history, changes);
  }

  /** Resolves a verdict endpoint path to its current canonical path. */
  resolveCanonicalPath(path: string): string {
    return this.baseAliases.get(path) ?? path;
  }

  private matchesEndpoint(endpoint: CompiledEndpoint, candidatePath: string): boolean {
    if (endpoint.isGlob) {
      return endpoint.regex!.test(candidatePath);
    }
    return this.resolveCanonicalPath(endpoint.raw) === candidatePath;
  }

  /**
   * Finds the highest-precedence matching verdict for the directional pair `from -> to`, if any.
   */
  match(from: string, to: string): RelationshipVerdictView | undefined {
    if (this.compiled.length === 0) return undefined;
    let best: CompiledVerdict | undefined;
    for (const item of this.compiled) {
      const forward =
        this.matchesEndpoint(item.first, from) && this.matchesEndpoint(item.second, to);
      const reverse =
        !item.directed &&
        this.matchesEndpoint(item.first, to) &&
        this.matchesEndpoint(item.second, from);
      if (forward || reverse) {
        if (!best || compareCompiledVerdictPrecedence(item, best) < 0) {
          best = item;
        }
      }
    }
    return best?.view;
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorts verdict entries deterministically by `verdict`, then `pair[0]`, then `pair[1]`. */
export function sortVerdictEntries(entries: readonly VerdictEntry[]): VerdictEntry[] {
  return [...entries].sort(
    (a, b) =>
      compareStrings(a.verdict, b.verdict) ||
      compareStrings(a.pair[0], b.pair[0]) ||
      compareStrings(a.pair[1], b.pair[1]),
  );
}

/** Formats a `.repo-archaeology.verdicts.json` document with 2-space indent, `$schema`, sorted entries, and trailing newline. */
export function formatVerdictsJson(
  entries: readonly VerdictEntry[],
  schema: string | undefined = VERDICTS_SCHEMA_URL,
): string {
  const sorted = sortVerdictEntries(entries).map((entry) => ({
    pair: [entry.pair[0], entry.pair[1]] as [string, string],
    verdict: entry.verdict,
    reason: entry.reason,
    ...(entry.until !== undefined ? { until: entry.until } : {}),
    ...(entry.by !== undefined ? { by: entry.by } : {}),
    ...(entry.directed !== undefined ? { directed: entry.directed } : {}),
  }));
  const doc: VerdictsFile = {
    ...(schema !== undefined ? { $schema: schema } : {}),
    version: 1,
    verdicts: sorted,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Checks whether two verdict entries refer to the same relationship pair for deduplication. */
export function isSameVerdictPair(existing: VerdictEntry, incoming: VerdictEntry): boolean {
  const existingDirected = existing.directed === true;
  const incomingDirected = incoming.directed === true;
  if (existing.pair[0] === incoming.pair[0] && existing.pair[1] === incoming.pair[1]) {
    return existingDirected === incomingDirected;
  }
  if (!existingDirected && !incomingDirected) {
    return existing.pair[0] === incoming.pair[1] && existing.pair[1] === incoming.pair[0];
  }
  return false;
}

/** Checks whether two verdict entries have the same pair and identical metadata. */
export function isSameVerdictEntry(a: VerdictEntry, b: VerdictEntry): boolean {
  return (
    isSameVerdictPair(a, b) &&
    a.verdict === b.verdict &&
    a.reason === b.reason &&
    a.until === b.until &&
    a.by === b.by
  );
}

/** Safely writes `<root>/.repo-archaeology.verdicts.json`, refusing symlinks or oversized payloads. */
export function writeVerdictsFile(
  root: string,
  entries: readonly VerdictEntry[],
  schema: string | undefined = VERDICTS_SCHEMA_URL,
): string {
  const target = join(root, VERDICTS_FILE);
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) {
    throw new ConfigError(`Refusing to write ${VERDICTS_FILE}: existing path is not a regular file.`);
  }
  const formatted = formatVerdictsJson(entries, schema);
  if (Buffer.byteLength(formatted, 'utf8') > MAX_VERDICTS_BYTES) {
    throw new ConfigError(`Refusing to write ${VERDICTS_FILE}: resulting file exceeds the 256 KB size limit.`);
  }
  writeFileSync(target, formatted, 'utf8');
  return target;
}
