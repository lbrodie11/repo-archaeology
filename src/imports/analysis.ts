import { posix, win32 } from 'node:path';
import type { ImportResolutionVia, ImportUnresolvedReasonCode } from './package-exports.js';
import { goAnalyzer } from './go.js';
import { pythonAnalyzer } from './python.js';
import { ImportResolver } from './resolve.js';
import type { RepoFiles } from './tree-files.js';
import { extractDetailedDependencies, type ImportEdgeKind } from './typescript.js';

/**
 * The shared per-file import analysis pipeline.
 *
 * `RelationshipClassifier` (relationships in scan/diff/file/explain/map) and
 * `getOrBuildImportGraphIndex` (`imports`) both call `analyzeFile`, so they read
 * the same edges, external count, unresolved specifiers and dynamic loads for a
 * file. Neither calls a language extractor directly. Each keeps its own
 * `AnalysisSession` (and so its own cache scope).
 */

/**
 * What a target is to the import that reaches it (RA-20). `module`: the module the specifier
 * names (Python's leaf module or package `__init__.py`; every file of a Go package). `init`: a
 * Python package `__init__.py` that runs on the way to it (`a/__init__.py` for `import a.b.c`).
 * `name`: a Python submodule taken by name (`from pkg import mod`), with the name in `name`.
 */
export type ImportTargetRole = 'module' | 'init' | 'name';

/** One resolved file an import points at. Go package imports resolve to several. */
export interface AnalysisTarget {
  path: string;
  via: ImportResolutionVia;
  heuristic?: boolean;
  role?: ImportTargetRole;
  /** With `role: 'name'`: the imported name (`mod` in `from pkg import mod`). */
  name?: string;
  /**
   * A probable target the import graph lists (as `heuristic`) but relationships must not claim:
   * the file stays `uncertain` for the importer, so pairs with it are `unknown`, never `direct`.
   */
  graphOnly?: boolean;
}

export interface AnalysisEdge {
  specifier: string;
  kind: ImportEdgeKind;
  /** Sorted and deduplicated; never contains the importing file itself. */
  targets: AnalysisTarget[];
  /** A path reference (TS triple-slash `<reference path>`), not an import statement. */
  reference?: boolean;
}

export interface AnalysisUnresolved {
  specifier: string;
  reasonCode: ImportUnresolvedReasonCode;
}

export interface FileAnalysis {
  /** Language id (`typescript`, `javascript`, …) when an analyzer handles the file. */
  language?: string;
  /** The language analyzer ran to completion on readable source. */
  analyzable: boolean;
  /** The file type is supported but its source could not be read. */
  sourceUnavailable: boolean;
  /**
   * Some import could not be followed (unresolved specifier, non-literal dynamic load,
   * or an `incompleteReason`), so "no import link" cannot be claimed for this file.
   */
  incomplete: boolean;
  incompleteReason?: string;
  edges: AnalysisEdge[];
  external: number;
  unresolved: AnalysisUnresolved[];
  dynamicLoads: number;
  /** Diagnostics raised while resolving this file's imports (surfaced in `meta.warnings`). */
  warnings?: string[];
  /**
   * Files this file may import, but the analyzer cannot tell (a `from pkg import name`
   * that may be an attribute, a Go directory with several package clauses, files past the
   * fan-out cap). Pairs with these files stay `unknown`; the rest of the file is unaffected.
   */
  uncertain?: { path: string; reason: string }[];
}

/** What a language extractor found in one file, before resolution. */
export interface ExtractedSpecifier {
  specifier: string;
  kind: ImportEdgeKind;
  typeOnly?: boolean;
  reference?: boolean;
  /** Python `from <specifier> import <names>`: the imported names (`*` for a star import). */
  names?: string[];
}

export interface Extraction {
  imports: ExtractedSpecifier[];
  dynamicLoads: number;
  /** Set when extraction could not finish (lexer failure, size or work budget): the file is `incomplete`. */
  incompleteReason?: string;
  /** Analyzer-private facts read from the text (Go: the package clause), for `complete`. */
  data?: unknown;
}

/**
 * A file's extraction, or the fact that its source could not be read. An extraction depends on
 * the file's bytes and path only, so it may be reused for the same path with the same blob in
 * another tree (RA-20: `importGraph({ at })`).
 */
export type StoredExtraction = { unavailable: true } | { unavailable?: false; extraction: Extraction };

/** Where a session keeps the extractions it computed, and finds ones it may reuse. */
export interface ExtractionStore {
  get(analyzer: string, path: string): StoredExtraction | undefined;
  /** `text` is the source the extraction was read from (absent when it was unavailable). */
  set(analyzer: string, path: string, entry: StoredExtraction, text?: string): void;
}

/** A plain per-session extraction store. */
export function createExtractionStore(): ExtractionStore & { readonly size: number } {
  const entries = new Map<string, StoredExtraction>();
  return {
    get: (analyzer, path) => entries.get(`${analyzer}\0${path}`),
    set: (analyzer, path, entry) => {
      entries.set(`${analyzer}\0${path}`, entry);
    },
    get size() {
      return entries.size;
    },
  };
}

export type SpecifierResolution =
  | {
      kind: 'files';
      /** May be empty: the import names no file (a Python namespace package). */
      targets: AnalysisTarget[];
      /** Something the import may load could not be pinned down to files: the importing file becomes `incomplete`. */
      incompleteReason?: string;
      /** Files the import may load (not edges): pairs with them stay `unknown`. */
      uncertain?: { path: string; reason: string }[];
      warning?: string;
    }
  | { kind: 'external'; warning?: string }
  | { kind: 'unresolved'; reasonCode: ImportUnresolvedReasonCode; warning?: string };

/** At most this many internal edge targets per session for budgeted (fan-out) analyzers. */
export const MAX_SESSION_INTERNAL_EDGES = 200_000;

let defaultEdgeBudget = MAX_SESSION_INTERNAL_EDGES;

/**
 * Test hook: the edge budget new sessions start with (`undefined` restores the default).
 * The budget is spent in analysis order, so two sessions agree on truncation only when
 * they analyze files in the same order (the import graph uses sorted path order).
 */
export function setDefaultEdgeBudgetForTesting(budget: number | undefined): void {
  defaultEdgeBudget = budget ?? MAX_SESSION_INTERNAL_EDGES;
}

/**
 * Consumer policy. The classifier and the import graph historically differ in two
 * edge cases (kept as-is so TS/JS output stays byte-identical):
 * - `includeTarget`: the graph only emits edges to files in the analyzed tree;
 * - `checkInvalidReferenceTargets`: the graph reports path references to symlinked
 *   or escaping targets as `invalid-target`.
 */
export interface AnalysisPolicy {
  /** Import targets outside this set are dropped; a path reference to one is `target-missing`. */
  includeTarget?: (path: string) => boolean;
  checkInvalidReferenceTargets?: boolean;
}

export interface LanguageAnalyzer<Index = unknown> {
  /** Registry key (also the cache key for this analyzer's session index). */
  readonly id: string;
  matches(path: string): boolean;
  language(path: string): string;
  /** Repository-wide index (module maps, source roots, resolvers), built once per session. */
  index(files: RepoFiles): Index;
  /**
   * Reads a file's imports. Must depend on `text` and `path` only (never on the index or other
   * files): sessions reuse extractions across trees for unchanged blobs. Anything that needs the
   * index belongs in `complete`.
   */
  extract(text: string, path: string): Extraction;
  /** The index-dependent rest of an extraction (Go: the enclosing module), run on every analysis. */
  complete?(path: string, extraction: Extraction, index: Index): Extraction;
  resolve(from: string, item: ExtractedSpecifier, index: Index, session: AnalysisSession): SpecifierResolution;
  /** Diagnostics found while building the index (duplicate modules, unsupported config). */
  indexWarnings?(index: Index): readonly string[];
  /** Count this analyzer's edges against `MAX_SESSION_INTERNAL_EDGES` (package fan-out languages). */
  readonly budgeted?: boolean;
}

/** Per-consumer analysis state: the reader, the policy and each analyzer's lazily built index. */
export class AnalysisSession {
  private readonly indexes = new Map<string, unknown>();
  /** Internal edges emitted so far by budgeted analyzers. */
  budgetedEdges = 0;
  edgeBudget = defaultEdgeBudget;

  constructor(
    readonly files: RepoFiles,
    readonly policy: AnalysisPolicy = {},
    readonly analyzers: readonly LanguageAnalyzer[] = LANGUAGE_ANALYZERS,
    /** Where extractions are kept (and, for a derived tree, reused from); none by default. */
    readonly extractions?: ExtractionStore,
  ) {}

  analyzerFor(path: string): LanguageAnalyzer | undefined {
    return this.analyzers.find((analyzer) => analyzer.matches(path));
  }

  indexFor<Index>(analyzer: LanguageAnalyzer<Index>): Index {
    if (this.indexes.has(analyzer.id)) return this.indexes.get(analyzer.id) as Index;
    const built = analyzer.index(this.files);
    this.indexes.set(analyzer.id, built);
    return built;
  }

  includes(path: string): boolean {
    return this.policy.includeTarget ? this.policy.includeTarget(path) : true;
  }

  /** Index warnings of every analyzer whose index was built in this session, in registry order. */
  indexWarnings(): string[] {
    const out: string[] = [];
    for (const analyzer of this.analyzers) {
      if (!this.indexes.has(analyzer.id) || !analyzer.indexWarnings) continue;
      out.push(...analyzer.indexWarnings(this.indexes.get(analyzer.id)));
    }
    return out;
  }
}

/**
 * `meta.warnings` entries for a set of analyzed files: index warnings first, then each
 * file's resolution warnings, deduplicated and sorted so output is deterministic.
 */
export function analysisWarnings(session: AnalysisSession, analyses: Iterable<FileAnalysis | undefined>): string[] {
  const fileWarnings = new Set<string>();
  for (const analysis of analyses) for (const warning of analysis?.warnings ?? []) fileWarnings.add(warning);
  const index = [...new Set(session.indexWarnings())].sort();
  return [...index, ...[...fileWarnings].filter((warning) => !index.includes(warning)).sort()];
}

function readAndExtract(path: string, reader: RepoFiles, analyzer: LanguageAnalyzer, store: ExtractionStore | undefined): StoredExtraction {
  const text = reader.read(path);
  const entry: StoredExtraction = text === undefined ? { unavailable: true } : { extraction: analyzer.extract(text, path) };
  store?.set(analyzer.id, path, entry, text);
  return entry;
}

/** Analyzes one file: extract its imports (or reuse a stored extraction), resolve each, and summarize the result. */
export function analyzeFile(path: string, reader: RepoFiles, session: AnalysisSession): FileAnalysis {
  const result: FileAnalysis = {
    analyzable: false,
    sourceUnavailable: false,
    incomplete: false,
    edges: [],
    external: 0,
    unresolved: [],
    dynamicLoads: 0,
  };
  const analyzer = session.analyzerFor(path);
  if (!analyzer) return result;
  result.language = analyzer.language(path);
  const stored = session.extractions?.get(analyzer.id, path) ?? readAndExtract(path, reader, analyzer, session.extractions);
  if (stored.unavailable) {
    result.sourceUnavailable = true;
    return result;
  }
  result.analyzable = true;
  const index = session.indexFor(analyzer);
  const extraction = analyzer.complete ? analyzer.complete(path, stored.extraction, index) : stored.extraction;
  result.dynamicLoads = extraction.dynamicLoads;
  if (extraction.incompleteReason) result.incompleteReason = extraction.incompleteReason;

  const seenEdges = new Set<string>();
  const seenUnresolved = new Set<string>();
  const warnings = new Set<string>();
  const uncertain = new Map<string, string>();
  const markIncomplete = (reason: string) => {
    result.incompleteReason ??= reason;
  };
  for (const item of extraction.imports) {
    const resolved = analyzer.resolve(path, item, index, session);
    if (resolved.warning) warnings.add(resolved.warning);
    if (resolved.kind === 'files') {
      if (resolved.incompleteReason) markIncomplete(resolved.incompleteReason);
      for (const item of resolved.uncertain ?? []) if (item.path !== path && !uncertain.has(item.path)) uncertain.set(item.path, item.reason);
      for (const target of resolved.targets) {
        if (target.graphOnly && target.path !== path && !uncertain.has(target.path)) uncertain.set(target.path, 'a probable import the analyzer cannot confirm');
      }
      const targets: AnalysisTarget[] = [];
      for (const target of resolved.targets) {
        if (target.path === path || !session.includes(target.path)) continue;
        const edgeKey = `${target.path}\0${item.specifier}\0${item.kind}`;
        if (seenEdges.has(edgeKey)) continue;
        if (analyzer.budgeted) {
          if (session.budgetedEdges >= session.edgeBudget) {
            markIncomplete('session internal-edge budget reached');
            warnings.add(`Import analysis stopped adding edges after ${session.edgeBudget} internal edges; files past the budget are reported as incomplete.`);
            break;
          }
          session.budgetedEdges++;
        }
        seenEdges.add(edgeKey);
        targets.push(target);
      }
      if (targets.length > 0) {
        result.edges.push({
          specifier: item.specifier,
          kind: item.kind,
          targets,
          ...(item.reference ? { reference: true } : {}),
        });
      }
    } else if (resolved.kind === 'external') {
      result.external++;
    } else if (!seenUnresolved.has(item.specifier)) {
      seenUnresolved.add(item.specifier);
      result.unresolved.push({ specifier: item.specifier, reasonCode: resolved.reasonCode });
    }
  }
  if (warnings.size > 0) result.warnings = [...warnings].sort();
  // A file that is also a certain target is not uncertain; a graph-only target stays uncertain.
  for (const edge of result.edges) for (const target of edge.targets) if (!target.graphOnly) uncertain.delete(target.path);
  if (uncertain.size > 0) result.uncertain = [...uncertain].sort(([a], [b]) => a.localeCompare(b)).map(([path, reason]) => ({ path, reason }));
  result.incomplete = result.unresolved.length > 0 || result.dynamicLoads > 0 || result.incompleteReason !== undefined;
  return result;
}

const TS_JS = /\.(?:[cm]?[jt]sx?)$/i;
const TYPESCRIPT_EXT = /\.(?:[cm]?tsx?)$/i;

/** TS/JS: the TypeScript parser for extraction, `ImportResolver` (tsconfig, package.json, workspaces) for resolution. */
export const typescriptAnalyzer: LanguageAnalyzer<ImportResolver> = {
  id: 'typescript',
  matches: (path) => TS_JS.test(path),
  language: (path) => (TYPESCRIPT_EXT.test(path) ? 'typescript' : 'javascript'),
  index: (files) => new ImportResolver(files),
  extract(text, path) {
    const { imports, referencePaths, nonLiteralLoads } = extractDetailedDependencies(text, path);
    return {
      // Imports first, then path references: the classifier's reach walk depends on this order.
      imports: [
        ...imports,
        ...referencePaths.map((specifier): ExtractedSpecifier => ({ specifier, kind: 'static', reference: true })),
      ],
      dynamicLoads: nonLiteralLoads,
    };
  },
  resolve(from, item, resolver, session) {
    if (item.reference) return resolveReferencePath(from, item.specifier, session);
    const resolved = resolver.resolveDetailed(from, item.specifier, item.kind === 'require' ? 'require' : 'import', {
      typeOnlyImport: Boolean(item.typeOnly),
    });
    if (resolved.kind === 'file') {
      return {
        kind: 'files',
        targets: [{ path: resolved.path, via: resolved.via, ...(resolved.heuristic ? { heuristic: true } : {}) }],
      };
    }
    if (resolved.kind === 'external') return { kind: 'external' };
    return { kind: 'unresolved', reasonCode: resolved.reasonCode };
  },
};

/** `/// <reference path="…" />`: a path relative to the referencing file. */
function resolveReferencePath(from: string, referencePath: string, session: AnalysisSession): SpecifierResolution {
  const path = referencePath.replace(/\\/g, '/');
  const target = posix.normalize(posix.join(posix.dirname(from), path));
  const invalid =
    path === '' ||
    posix.isAbsolute(path) ||
    win32.parse(path).root !== '' ||
    target === '..' ||
    target.startsWith('../') ||
    (session.policy.checkInvalidReferenceTargets === true && Boolean(session.files.isInvalidTarget?.(target, '')));
  if (invalid) return { kind: 'unresolved', reasonCode: 'invalid-target' };
  if (!session.files.exists(target) || !session.includes(target)) return { kind: 'unresolved', reasonCode: 'target-missing' };
  return { kind: 'files', targets: [{ path: target, via: 'relative' }] };
}

/** Every registered language analyzer, in match order. */
export const LANGUAGE_ANALYZERS: readonly LanguageAnalyzer[] = [
  typescriptAnalyzer as LanguageAnalyzer,
  goAnalyzer as LanguageAnalyzer,
  pythonAnalyzer as LanguageAnalyzer,
];

/** Whether any language analyzer handles this path (by extension). */
export function isAnalyzablePath(path: string): boolean {
  return LANGUAGE_ANALYZERS.some((analyzer) => analyzer.matches(path));
}
