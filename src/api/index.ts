import { backtest, type BacktestResult } from '../commands/backtest.js';
import { diff, type DiffResult, type SuggestionOwner, type SuggestionOwnersSample } from '../commands/diff.js';
import { explain, type ExplainResult } from '../commands/explain.js';
import { fileReport, type FileResult } from '../commands/file.js';
import {
  importGraph,
  type ImportEdgeKind,
  type ImportGraphEdge,
  type ImportGraphResult,
  type ImportGraphUnresolved,
  type ImportResolutionVia,
  type ImportsCoverageMeta,
  type ImportUnresolvedReasonCode,
} from '../commands/imports.js';
import { scan, type ScanResult } from '../commands/scan.js';
import {
  ConfigError,
  DEFAULT_IGNORES,
  DEFAULT_SETTINGS,
  validatePartial,
  type Settings,
} from '../config.js';
import { loadContext, UsageError, type Context, type ProgressEvent } from '../context.js';
import { GitError } from '../git/run.js';
import { IMPORT_UNRESOLVED_REASON_CODES, RELATIONSHIPS, type Relationship } from '../imports/classify.js';
import { parseOriginWeightsSpec, type CommitOrigin, type OriginConfig, type OriginWeights } from '../model/origin.js';
import { DEFAULT_OWNERS_CONFIG, type CodeownersProvenance, type OwnersConfig } from '../model/owners.js';
import {
  VERDICTS_FILE,
  VERDICTS_SCHEMA_URL,
  type RelationshipVerdictView,
  type VerdictEntry,
  type VerdictKind,
  type VerdictsFile,
  type VerdictsMeta,
} from '../model/verdicts.js';
import {
  JSON_SCHEMA_VERSION,
  withJsonContract,
  type ToolInfo,
  type VersionedJson,
} from '../report/contract.js';
import type { Meta } from '../report/views.js';

export {
  ConfigError,
  DEFAULT_IGNORES,
  DEFAULT_OWNERS_CONFIG,
  DEFAULT_SETTINGS,
  GitError,
  IMPORT_UNRESOLVED_REASON_CODES,
  JSON_SCHEMA_VERSION,
  RELATIONSHIPS,
  UsageError,
  VERDICTS_FILE,
  VERDICTS_SCHEMA_URL,
  type CodeownersProvenance,
  type CommitOrigin,
  type ImportEdgeKind,
  type ImportGraphEdge,
  type ImportGraphUnresolved,
  type ImportResolutionVia,
  type ImportsCoverageMeta,
  type ImportUnresolvedReasonCode,
  type OriginConfig,
  type OriginWeights,
  type OwnersConfig,
  type ProgressEvent,
  type Relationship,
  type RelationshipVerdictView,
  type Settings,
  type SuggestionOwner,
  type SuggestionOwnersSample,
  type ToolInfo,
  type VerdictEntry,
  type VerdictKind,
  type VerdictsFile,
  type VerdictsMeta,
  type VersionedJson,
};

export type DiffJson = VersionedJson<DiffResult>;
export type ScanJson = VersionedJson<ScanResult>;
export type FileJson = VersionedJson<FileResult>;
export type ExplainJson = VersionedJson<ExplainResult>;
export type BacktestJson = VersionedJson<BacktestResult>;
export type ImportGraphJson = VersionedJson<ImportGraphResult>;

export interface MapSummaryResult {
  meta: Meta;
  file: string;
  nodes: number;
  edges: number;
  counts: Record<Relationship, number>;
  patchesIncluded: boolean;
  verdicts?: {
    silenced: number;
  };
}

export type MapJson = VersionedJson<MapSummaryResult>;
export type DefaultJson = VersionedJson<
  ({ mode: 'diff' } & DiffResult) | ({ mode: 'scan'; changedWithoutHistory: number } & ScanResult)
>;

/**
 * Settings accepted by `openRepository({ settings })`.
 * Supports both `.repo-archaeology.json` property names (`maxFilesPerCommit`, `halfLifeDays`,
 * `useDefaultIgnores`, `origin`) and CLI flag aliases (`maxFiles`, `halfLife`, `defaultIgnores`, `originWeights`).
 */
export interface SettingsInput extends Partial<Settings> {
  /** Alias for `maxFilesPerCommit` (matches `--max-files`). */
  maxFiles?: number;
  /** Alias for `halfLifeDays` (matches `--half-life`). */
  halfLife?: number;
  /** Alias for `useDefaultIgnores` (matches `--no-default-ignores`). */
  defaultIgnores?: boolean;
  /** Alias for `origin.weights` (matches `--origin-weights`). */
  originWeights?: OriginWeights | string;
}

export interface OpenOptions {
  /** Any path inside the repository. */
  cwd: string;
  /** Analyze the repository as of `<head>` without checking it out; default: checked-out `HEAD` + working tree. */
  head?: string;
  /** Merge-base isolation, same as `--base`. */
  base?: string;
  /** Same keys as `.repo-archaeology.json` or CLI flags (`maxCommits`, `maxFiles`, `minShared`, `minConfidence`, `halfLife`, `skipCommits`, `ignore`, `defaultIgnores`). */
  settings?: SettingsInput;
  /** Default `true`: merge `.repo-archaeology.json` under explicit `settings`. */
  useConfigFile?: boolean;
  /** Progress callback invoked during history loading and model construction. */
  onProgress?: (e: { phase: string; done?: number; total?: number }) => void;
  /** Cancel long history loads. */
  signal?: AbortSignal;
}

export interface Repository {
  readonly root: string;
  readonly headSha: string;
  readonly mergeBaseSha?: string;
  diff(opts?: {
    limit?: number;
    kinds?: Relationship[];
    base?: string;
    applyBranchVerdicts?: boolean;
    owners?: boolean;
  }): Promise<DiffJson>;
  scan(opts?: {
    limit?: number;
    kinds?: Relationship[];
    uncheckedCap?: number;
    showSilenced?: boolean;
  }): Promise<ScanJson>;
  file(path: string, opts?: { limit?: number; showSilenced?: boolean }): Promise<FileJson>;
  explain(a: string, b: string, opts?: { commits?: number; counterexamples?: boolean; context?: number }): Promise<ExplainJson>;
  backtest(opts?: {
    testFraction?: number;
    k?: number;
    before?: string | number;
    ghosts?: boolean;
    followUps?: boolean;
    followUpWindowHours?: number;
    compareOriginWeights?: string | readonly string[];
  }): Promise<BacktestJson>;
  importGraph(opts?: { files?: string[] }): Promise<ImportGraphJson>;
  close(): Promise<void>;
}

function normalizeSettingsInput(input?: SettingsInput): Partial<Settings> {
  if (!input) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigError('settings must be a JSON object.');
  }
  const copy: Record<string, unknown> = { ...input };
  if ('maxFiles' in copy) {
    if (copy.maxFiles !== undefined && copy.maxFilesPerCommit === undefined) {
      copy.maxFilesPerCommit = copy.maxFiles;
    }
    delete copy.maxFiles;
  }
  if ('halfLife' in copy) {
    if (copy.halfLife !== undefined && copy.halfLifeDays === undefined) {
      copy.halfLifeDays = copy.halfLife;
    }
    delete copy.halfLife;
  }
  if ('defaultIgnores' in copy) {
    if (copy.defaultIgnores !== undefined && copy.useDefaultIgnores === undefined) {
      copy.useDefaultIgnores = copy.defaultIgnores;
    }
    delete copy.defaultIgnores;
  }
  if ('originWeights' in copy) {
    const rawWeights = copy.originWeights;
    delete copy.originWeights;
    if (rawWeights !== undefined) {
      const weights =
        typeof rawWeights === 'string'
          ? parseOriginWeightsSpec(rawWeights, 'settings.originWeights')
          : rawWeights;
      const existingOrigin =
        copy.origin && typeof copy.origin === 'object' && !Array.isArray(copy.origin)
          ? (copy.origin as Record<string, unknown>)
          : {};
      copy.origin = { ...existingOrigin, weights };
    }
  }
  return validatePartial(copy, 'settings');
}

function parseBeforeOption(before?: string | number): number | undefined {
  if (before === undefined) return undefined;
  if (typeof before === 'number') {
    if (!Number.isFinite(before) || before < 0) {
      throw new UsageError('Expected a valid unix timestamp or date string for `before`.');
    }
    return Math.floor(before);
  }
  const ms = Date.parse(before);
  if (Number.isNaN(ms)) {
    throw new UsageError('Expected a date such as 2026-01-01.');
  }
  return Math.floor(ms / 1000);
}

/**
 * Wraps an already-loaded `Context` into a `Repository` session whose methods return
 * the exact `schemaVersion: 1` JSON envelope shapes.
 */
export function createRepository(ctx: Context): Repository {
  const headSha = ctx.headSha ?? '';
  let closed = false;
  const assertOpen = (): void => {
    if (closed) {
      throw new UsageError('Repository session is closed.');
    }
  };
  return {
    root: ctx.root,
    headSha,
    ...(ctx.mergeBaseSha !== undefined ? { mergeBaseSha: ctx.mergeBaseSha } : {}),

    async diff(opts) {
      assertOpen();
      const result = await diff(ctx, {
        base: opts?.base ?? ctx.base,
        limit: opts?.limit ?? 10,
        kinds: opts?.kinds ?? [...RELATIONSHIPS],
        applyBranchVerdicts: opts?.applyBranchVerdicts,
        owners: opts?.owners,
      });
      return withJsonContract(result);
    },

    async scan(opts) {
      assertOpen();
      const limit = opts?.limit ?? 15;
      const kinds = opts?.kinds ?? ['ghost', 'unknown'];
      const uncheckedCap =
        opts?.uncheckedCap !== undefined ? opts.uncheckedCap : opts?.kinds === undefined ? 5 : undefined;
      const result = scan(ctx, {
        limit,
        kinds,
        uncheckedCap,
        showSilenced: opts?.showSilenced,
      });
      return withJsonContract(result);
    },

    async file(path, opts) {
      assertOpen();
      const result = fileReport(ctx, path, {
        limit: opts?.limit ?? 10,
        showSilenced: opts?.showSilenced,
      });
      return withJsonContract(result);
    },

    async explain(a, b, opts) {
      assertOpen();
      const result = await explain(ctx, a, b, {
        commits: opts?.commits ?? 3,
        counterexamples: opts?.counterexamples,
        contextLines: opts?.context ?? 2,
      });
      return withJsonContract(result);
    },

    async backtest(opts) {
      assertOpen();
      if (opts?.followUpWindowHours !== undefined && !opts?.followUps) {
        throw new UsageError('--follow-up-window requires --follow-ups.');
      }
      const result = backtest(ctx, {
        testFraction: opts?.testFraction ?? 0.2,
        k: opts?.k ?? 3,
        before: parseBeforeOption(opts?.before),
        ghosts: opts?.ghosts,
        followUps: opts?.followUps,
        followUpWindowHours: opts?.followUpWindowHours,
        compareOriginWeights: opts?.compareOriginWeights,
      });
      return withJsonContract(result);
    },

    async importGraph(opts) {
      assertOpen();
      const result = importGraph(ctx, {
        files: opts?.files,
      });
      return withJsonContract(result);
    },

    async close() {
      closed = true;
      ctx.closeSession?.();
      ctx.close?.();
    },
  };
}

/**
 * Opens a repository session that loads git history and builds the co-change model once,
 * exposing analysis methods that return the `schemaVersion: 1` JSON shapes without writing
 * to `stdout` or `stderr`.
 */
export async function openRepository(opts: OpenOptions): Promise<Repository> {
  if (!opts || typeof opts.cwd !== 'string' || opts.cwd.trim() === '') {
    throw new UsageError('openRepository requires a non-empty `cwd` path.');
  }
  const flagSettings = normalizeSettingsInput(opts.settings);
  const internalOpts = opts as OpenOptions & { onSpawn?: (args: readonly string[], cwd: string) => void };
  const ctx = await loadContext(opts.cwd, flagSettings, {
    head: opts.head,
    base: opts.base,
    useConfigFile: opts.useConfigFile ?? true,
    silent: true,
    onProgress: opts.onProgress,
    signal: opts.signal,
    keepOpen: true,
    onSpawn: internalOpts.onSpawn,
  });
  return createRepository(ctx);
}
