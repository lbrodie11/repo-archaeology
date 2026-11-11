import { ignorePatterns, type Settings } from '../config.js';
import { toRepoPath, UsageError, type Context } from '../context.js';
import { listTreeFiles, resolveCommit } from '../git/repo.js';
import { runGit } from '../git/run.js';
import {
  AnalysisSession,
  analysisWarnings,
  analyzeFile,
  createExtractionStore,
  type ExtractionStore,
  type FileAnalysis,
  type ImportTargetRole,
} from '../imports/analysis.js';
import { gitTreeFiles, workingTreeFiles } from '../imports/classify.js';
import {
  IMPORT_UNRESOLVED_REASON_CODES,
  type ImportResolutionVia,
  type ImportsCoverageMeta,
  type ImportUnresolvedReasonCode,
  type RepoFiles,
} from '../imports/resolve.js';
import type { ImportEdgeKind } from '../imports/typescript.js';
import { buildMeta, printHeader, type Meta } from '../report/views.js';
import { PathMatcher } from '../util/glob.js';
import { c, plural, terminalText } from '../util/term.js';

export type {
  ImportEdgeKind,
  ImportResolutionVia,
  ImportsCoverageMeta,
  ImportTargetRole,
  ImportUnresolvedReasonCode,
};

export interface ImportGraphEdge {
  from: string;
  to: string;
  specifier: string;
  kind: ImportEdgeKind;
  via?: ImportResolutionVia;
  heuristic?: boolean;
  /** What `to` is to the import (Python and Go edges, RA-20). */
  role?: ImportTargetRole;
  /** With `role: 'name'`: the imported name (`mod` in `from pkg import mod`). */
  name?: string;
}

export interface ImportGraphUnresolved {
  from: string;
  specifier: string;
  reason: string;
  reasonCode?: ImportUnresolvedReasonCode;
}

export interface ImportGraphOptions {
  /** Restrict `from` to these files plus every file in the repository that imports them. */
  files?: string[];
}

export interface ImportGraphResult {
  meta: Meta;
  /** Set when the graph is of another commit's tree than the session's (`importGraph({ at })`, RA-20). */
  at?: { ref: string; sha: string };
  files: string[];
  edges: ImportGraphEdge[];
  unresolved: ImportGraphUnresolved[];
  languages: string[];
}

interface IndexedFileStats {
  analyzable: boolean;
  sourceUnavailable: boolean;
  external: number;
  dynamicLoads: number;
}

export interface ImportGraphIndex {
  readonly allFiles: string[];
  readonly edgesByFrom: Map<string, ImportGraphEdge[]>;
  readonly unresolvedByFrom: Map<string, ImportGraphUnresolved[]>;
  readonly statsByFrom: Map<string, IndexedFileStats>;
  readonly importersByTarget: Map<string, Set<string>>;
  readonly languages: string[];
  readonly repoUnsupportedFiles: number;
  /** Import-analysis diagnostics for these files (`meta.warnings`). */
  warningsFor(files: readonly string[]): string[];
  /** The shared pipeline's result for an indexed, analyzable file. */
  analysisOf(path: string): FileAnalysis | undefined;
  /** Language id of a path, when a language analyzer handles it. */
  languageOf(path: string): string | undefined;
  indexFile(from: string): void;
}

const sessionIndexCache = new WeakMap<Context, ImportGraphIndex>();
/** The extractions a session's import graph computed, reusable for unchanged blobs in another tree (RA-20). */
const sessionExtractionStores = new WeakMap<Context, ExtractionStore>();

interface IndexSource {
  /** Reader for the analyzed tree. */
  files: RepoFiles;
  /** Every file of the analyzed tree. */
  currentFiles: ReadonlySet<string>;
  settings: Settings;
  extractions?: ExtractionStore;
}

export function getOrBuildImportGraphIndex(ctx: Context): ImportGraphIndex {
  const existing = sessionIndexCache.get(ctx);
  if (existing) return existing;
  const extractions = createExtractionStore();
  const index = buildImportGraphIndex({
    files: ctx.files ?? workingTreeFiles(ctx.root, ctx.currentFiles),
    currentFiles: ctx.currentFiles,
    settings: ctx.settings,
    extractions,
  });
  sessionIndexCache.set(ctx, index);
  sessionExtractionStores.set(ctx, extractions);
  return index;
}

function buildImportGraphIndex(source: IndexSource): ImportGraphIndex {
  const repoFiles = source.files;
  const currentFiles = source.currentFiles;
  // The graph only links files in the analyzed tree, and flags path references to symlinked targets.
  const session = new AnalysisSession(
    repoFiles,
    {
      includeTarget: (path) => currentFiles.has(path),
      checkInvalidReferenceTargets: true,
    },
    undefined,
    source.extractions,
  );
  const ignoreMatcher = new PathMatcher(ignorePatterns(source.settings));

  const allFiles: string[] = [];
  const edgesByFrom = new Map<string, ImportGraphEdge[]>();
  const unresolvedByFrom = new Map<string, ImportGraphUnresolved[]>();
  const statsByFrom = new Map<string, IndexedFileStats>();
  const importersByTarget = new Map<string, Set<string>>();
  const languageSet = new Set<string>();
  const analyses = new Map<string, FileAnalysis>();
  let repoUnsupportedFiles = 0;

  const addImporter = (target: string, importer: string): void => {
    let set = importersByTarget.get(target);
    if (!set) {
      set = new Set();
      importersByTarget.set(target, set);
    }
    set.add(importer);
  };

  const indexFile = (from: string): void => {
    if (edgesByFrom.has(from)) return;
    const analysis =
      session.analyzerFor(from) !== undefined && currentFiles.has(from) ? analyzeFile(from, repoFiles, session) : undefined;
    if (!analysis?.analyzable) {
      edgesByFrom.set(from, []);
      unresolvedByFrom.set(from, []);
      statsByFrom.set(from, {
        analyzable: false,
        sourceUnavailable: analysis?.sourceUnavailable ?? false,
        external: 0,
        dynamicLoads: 0,
      });
      return;
    }
    if (analysis.language) languageSet.add(analysis.language);
    analyses.set(from, analysis);

    const fileEdges: ImportGraphEdge[] = [];
    for (const edge of analysis.edges) {
      for (const target of edge.targets) {
        fileEdges.push({
          from,
          to: target.path,
          specifier: edge.specifier,
          kind: edge.kind,
          via: target.via,
          ...(target.heuristic ? { heuristic: true } : {}),
          ...(target.role !== undefined ? { role: target.role } : {}),
          ...(target.name !== undefined ? { name: target.name } : {}),
        });
        addImporter(target.path, from);
      }
    }
    const fileUnresolved: ImportGraphUnresolved[] = analysis.unresolved.map(({ specifier, reasonCode }) => ({
      from,
      specifier,
      reason: 'unmatched',
      reasonCode,
    }));

    fileEdges.sort(
      (a, b) =>
        a.to.localeCompare(b.to) ||
        a.specifier.localeCompare(b.specifier) ||
        a.kind.localeCompare(b.kind),
    );
    fileUnresolved.sort((a, b) => a.specifier.localeCompare(b.specifier));

    edgesByFrom.set(from, fileEdges);
    unresolvedByFrom.set(from, fileUnresolved);
    statsByFrom.set(from, {
      analyzable: true,
      sourceUnavailable: false,
      external: analysis.external,
      dynamicLoads: analysis.dynamicLoads,
    });
  };

  const candidates: string[] = [];
  for (const file of currentFiles) {
    if (ignoreMatcher.matches(file)) continue;
    if (session.analyzerFor(file) !== undefined) {
      candidates.push(file);
    } else {
      repoUnsupportedFiles++;
    }
  }
  candidates.sort();

  for (const file of candidates) {
    indexFile(file);
    allFiles.push(file);
  }

  return {
    allFiles,
    edgesByFrom,
    unresolvedByFrom,
    statsByFrom,
    importersByTarget,
    languages: [...languageSet].sort(),
    repoUnsupportedFiles,
    languageOf: (path) => session.analyzerFor(path)?.language(path),
    warningsFor: (files) => analysisWarnings(session, files.map((file) => analyses.get(file))),
    analysisOf: (path) => analyses.get(path),
    indexFile,
  };
}

function buildGraphCoverage(
  index: ImportGraphIndex,
  files: readonly string[],
  edges: readonly ImportGraphEdge[],
  unresolved: readonly ImportGraphUnresolved[],
  scope: 'repository' | 'analyzed-files',
): ImportsCoverageMeta {
  let filesScanned = 0;
  let external = 0;
  let dynamicLoads = 0;
  let unsupportedFiles = scope === 'repository' ? index.repoUnsupportedFiles : 0;
  let sourceUnavailable = 0;

  for (const file of files) {
    const st = index.statsByFrom.get(file);
    if (!st) continue;
    if (st.sourceUnavailable) {
      sourceUnavailable++;
    } else if (!st.analyzable) {
      if (scope === 'analyzed-files') unsupportedFiles++;
    } else {
      filesScanned++;
      external += st.external;
      dynamicLoads += st.dynamicLoads;
    }
  }

  let heuristicEdges = 0;
  for (const edge of edges) {
    if (edge.heuristic) heuristicEdges++;
  }

  const rawReasons: Partial<Record<ImportUnresolvedReasonCode, number>> = {};
  for (const item of unresolved) {
    const code = item.reasonCode;
    if (code) {
      rawReasons[code] = (rawReasons[code] ?? 0) + 1;
    }
  }
  const unresolvedByReason: Partial<Record<ImportUnresolvedReasonCode, number>> = {};
  for (const code of IMPORT_UNRESOLVED_REASON_CODES) {
    const count = rawReasons[code];
    if (count) {
      unresolvedByReason[code] = count;
    }
  }

  return {
    scope,
    filesScanned,
    internalEdges: edges.length,
    external,
    unresolved: unresolved.length,
    dynamicLoads,
    unsupportedFiles,
    sourceUnavailable,
    heuristicEdges,
    unresolvedByReason,
  };
}

function graphMeta(ctx: Context, index: ImportGraphIndex, files: readonly string[], coverage: ImportsCoverageMeta): Meta {
  const meta = buildMeta(ctx);
  const extra = index.warningsFor(files).filter((warning) => !meta.warnings.includes(warning));
  return { ...meta, imports: coverage, ...(extra.length > 0 ? { warnings: [...meta.warnings, ...extra] } : {}) };
}

export function importGraph(ctx: Context, options: ImportGraphOptions = {}): ImportGraphResult {
  ctx.open?.();
  try {
    const index = getOrBuildImportGraphIndex(ctx);
    return selectGraph(ctx, index, ctx.currentFiles, ctx.head?.ref ?? 'the working tree', options);
  } finally {
    ctx.close?.();
  }
}

/** The graph (or the `files`-scoped part of it) from a built index. */
function selectGraph(
  ctx: Context,
  index: ImportGraphIndex,
  treeFiles: ReadonlySet<string>,
  treeLabel: string,
  options: ImportGraphOptions,
): ImportGraphResult {
  if (options.files === undefined) {
    const files = [...index.allFiles];
    const edges = files.flatMap((from) => index.edgesByFrom.get(from) ?? []);
    const unresolved = files.flatMap((from) => index.unresolvedByFrom.get(from) ?? []);
    const coverage = buildGraphCoverage(index, files, edges, unresolved, 'repository');
    return {
      meta: graphMeta(ctx, index, files, coverage),
      files,
      edges,
      unresolved,
      languages: [...index.languages],
    };
  }

  const allowedFrom = new Set<string>();
  for (const rawInput of options.files) {
    const path = treeFiles.has(rawInput) ? rawInput : toRepoPath(ctx, rawInput);
    if (!treeFiles.has(path)) {
      throw new UsageError(`No such file in ${treeLabel}: ${path}`);
    }
    index.indexFile(path);
    allowedFrom.add(path);
    const importers = index.importersByTarget.get(path);
    if (importers) {
      for (const importer of importers) {
        allowedFrom.add(importer);
      }
    }
  }

  const files = [...allowedFrom].sort();
  const edges = files.flatMap((from) => index.edgesByFrom.get(from) ?? []);
  const unresolved = files.flatMap((from) => index.unresolvedByFrom.get(from) ?? []);
  const langSet = new Set<string>();
  for (const f of files) {
    const lang = index.languageOf(f);
    if (lang) langSet.add(lang);
  }
  const languages = langSet.size > 0 ? [...langSet].sort() : [...index.languages];
  const coverage = buildGraphCoverage(index, files, edges, unresolved, 'analyzed-files');

  return {
    meta: graphMeta(ctx, index, files, coverage),
    files,
    edges,
    unresolved,
    languages,
  };
}

export interface ImportGraphAtOptions extends ImportGraphOptions {
  /** Test hook: called with the paths whose extraction was reused from the session's own graph. */
  onReuse?: (stats: { reused: number; extracted: number }) => void;
}

interface DerivedIndex {
  sha: string;
  index: ImportGraphIndex;
  treeFiles: ReadonlySet<string>;
  reader: { open(): void; close(): void };
}

/** The last tree a session's `importGraph({ at })` analyzed: Gutter asks for one base per PR. */
const derivedIndexCache = new WeakMap<Context, DerivedIndex>();

/** Resolves `importGraph({ at })` / `imports --at <ref>` to a commit SHA. */
export async function resolveAtRef(root: string, at: string): Promise<string> {
  const trimmed = typeof at === 'string' ? at.trim() : '';
  if (trimmed === '' || trimmed.startsWith('-')) {
    throw new UsageError(`Invalid --at revision "${String(at)}": revision cannot be empty or start with "-".`);
  }
  try {
    return await resolveCommit(root, trimmed);
  } catch {
    throw new UsageError(`--at: "${at}" is not a branch, tag or commit in this repository.`);
  }
}

const splitNul = (out: string): string[] => out.split('\0').filter((path) => path !== '');

/**
 * Paths whose content may differ between `atSha`'s tree and the tree the session analyzed:
 * `git diff-tree` for a `head` session; `git diff` against the working tree plus untracked files
 * otherwise. Every other path present in both has the same blob (or the same cleaned content).
 */
async function changedSince(ctx: Context, atSha: string): Promise<Set<string>> {
  if (ctx.head !== undefined) {
    const out = await runGit(ctx.root, ['diff-tree', '-r', '-z', '--no-renames', '--name-only', '--end-of-options', atSha, ctx.head.sha]);
    return new Set(splitNul(out));
  }
  const [diffOut, untracked] = await Promise.all([
    runGit(ctx.root, ['diff', '-z', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', '--end-of-options', atSha, '--']),
    runGit(ctx.root, ['ls-files', '-z', '--others', '--exclude-standard']),
  ]);
  return new Set([...splitNul(diffOut), ...splitNul(untracked)]);
}

/**
 * RA-20: the import graph of another commit's tree (`at`), from this session, without a second
 * session or any history. The tree's file list, configuration (tsconfig, package.json, go.mod,
 * pyproject, …) and resolution are its own; only per-file extractions (the parse of a file's
 * import statements, a function of its bytes and path) are reused from this session's graph for
 * files whose blob is the same in both trees. Settings are the session's (never `at`'s
 * `.repo-archaeology.json`). The result equals a fresh session at `at` with the same settings.
 */
export async function importGraphAt(ctx: Context, at: string, options: ImportGraphAtOptions = {}): Promise<ImportGraphResult> {
  const sha = await resolveAtRef(ctx.root, at);
  let derived = derivedIndexCache.get(ctx);
  let build: (() => void) | undefined;
  if (derived?.sha !== sha) {
    const [treeFiles, changed] = await Promise.all([listTreeFiles(ctx.root, sha), changedSince(ctx, sha)]);
    const base = gitTreeFiles(ctx.root, sha, treeFiles);
    const unchanged = (path: string): boolean => !changed.has(path) && ctx.currentFiles.has(path) && treeFiles.has(path);
    // A `head` session reads the same blobs from its own (cached) reader; a working tree may differ in
    // line endings after git's filters, so its tree is always read from `at`.
    const headFiles = ctx.head !== undefined ? ctx.files : undefined;
    const reader: RepoFiles = {
      ...base,
      read: (path) => (headFiles !== undefined && unchanged(path) ? headFiles.read(path) : base.read(path)),
    };
    const own = createExtractionStore();
    let reused = 0;
    let extracted = 0;
    const extractions: ExtractionStore = {
      get: (analyzer, path) => {
        const local = own.get(analyzer, path);
        if (local) return local;
        const shared = unchanged(path) ? sessionExtractionStores.get(ctx)?.get(analyzer, path) : undefined;
        if (shared) reused++;
        return shared;
      },
      set: (analyzer, path, entry) => {
        extracted++;
        own.set(analyzer, path, entry);
      },
    };
    const pending: DerivedIndex = { sha, index: undefined as unknown as ImportGraphIndex, treeFiles, reader: base };
    build = () => {
      pending.index = buildImportGraphIndex({ files: reader, currentFiles: treeFiles, settings: ctx.settings, extractions });
      options.onReuse?.({ reused, extracted });
    };
    derived = pending;
  }
  ctx.open?.();
  derived.reader.open();
  try {
    if (build) {
      build();
      derivedIndexCache.set(ctx, derived);
    }
    const result = selectGraph(ctx, derived.index, derived.treeFiles, at, options);
    return { meta: result.meta, at: { ref: at, sha }, files: result.files, edges: result.edges, unresolved: result.unresolved, languages: result.languages };
  } finally {
    derived.reader.close();
    ctx.close?.();
  }
}

export function printImports(result: ImportGraphResult): void {
  printHeader('imports', result.meta);
  if (result.at) console.log(c.dim(`graph at ${terminalText(result.at.ref)} (${result.at.sha.slice(0, 12)})`));
  const heuristicCount = result.meta.imports?.heuristicEdges ?? 0;
  const heuristicNote = heuristicCount > 0 ? ` (${heuristicCount} heuristic)` : '';
  console.log(
    `${plural(result.files.length, 'file')} · ${plural(result.edges.length, 'internal import edge')}${heuristicNote} · ${plural(result.unresolved.length, 'unresolved specifier')}`,
  );
  if (result.edges.length === 0 && result.unresolved.length === 0) {
    return;
  }
  console.log();
  for (const edge of result.edges) {
    const role = edge.role === 'name' && edge.name !== undefined ? `name ${edge.name}` : edge.role;
    const tag = [edge.kind, ...(edge.role !== undefined && edge.role !== 'module' ? [role] : []), ...(edge.heuristic ? ['heuristic'] : [])].join(', ');
    console.log(
      `  ${c.bold(terminalText(edge.from))} ${c.dim('→')} ${c.bold(terminalText(edge.to))}  ${c.dim(`(${tag}: ${terminalText(edge.specifier)})`)}`,
    );
  }
  if (result.unresolved.length > 0) {
    console.log();
    console.log(c.bold(`Unresolved (${result.unresolved.length})`));
    for (const item of result.unresolved) {
      const detail = item.reasonCode ? `${item.reason}: ${item.reasonCode}` : item.reason;
      console.log(
        `  ${c.bold(terminalText(item.from))}  ${terminalText(item.specifier)} ${c.dim(`[${terminalText(detail)}]`)}`,
      );
    }
  }
}
