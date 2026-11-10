import { posix, win32 } from 'node:path';
import type { ImportResolutionVia, ImportUnresolvedReasonCode } from './package-exports.js';
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

/** One resolved file an import points at. Go package imports resolve to several. */
export interface AnalysisTarget {
  path: string;
  via: ImportResolutionVia;
  heuristic?: boolean;
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
}

/** What a language extractor found in one file, before resolution. */
export interface ExtractedSpecifier {
  specifier: string;
  kind: ImportEdgeKind;
  typeOnly?: boolean;
  reference?: boolean;
}

export interface Extraction {
  imports: ExtractedSpecifier[];
  dynamicLoads: number;
  /** Set when extraction could not finish (lexer failure, size or work budget): the file is `incomplete`. */
  incompleteReason?: string;
}

export type SpecifierResolution =
  | { kind: 'files'; targets: AnalysisTarget[] }
  | { kind: 'external' }
  | { kind: 'unresolved'; reasonCode: ImportUnresolvedReasonCode };

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
  extract(text: string, path: string, index: Index): Extraction;
  resolve(from: string, item: ExtractedSpecifier, index: Index, session: AnalysisSession): SpecifierResolution;
}

/** Per-consumer analysis state: the reader, the policy and each analyzer's lazily built index. */
export class AnalysisSession {
  private readonly indexes = new Map<string, unknown>();

  constructor(
    readonly files: RepoFiles,
    readonly policy: AnalysisPolicy = {},
    readonly analyzers: readonly LanguageAnalyzer[] = LANGUAGE_ANALYZERS,
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
}

/** Analyzes one file: extract its imports, resolve each, and summarize the result. */
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
  const text = reader.read(path);
  if (text === undefined) {
    result.sourceUnavailable = true;
    return result;
  }
  result.analyzable = true;
  const index = session.indexFor(analyzer);
  const extraction = analyzer.extract(text, path, index);
  result.dynamicLoads = extraction.dynamicLoads;
  if (extraction.incompleteReason) result.incompleteReason = extraction.incompleteReason;

  const seenEdges = new Set<string>();
  const seenUnresolved = new Set<string>();
  for (const item of extraction.imports) {
    const resolved = analyzer.resolve(path, item, index, session);
    if (resolved.kind === 'files') {
      const targets: AnalysisTarget[] = [];
      for (const target of resolved.targets) {
        if (target.path === path || !session.includes(target.path)) continue;
        const edgeKey = `${target.path}\0${item.specifier}\0${item.kind}`;
        if (seenEdges.has(edgeKey)) continue;
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
export const LANGUAGE_ANALYZERS: readonly LanguageAnalyzer[] = [typescriptAnalyzer as LanguageAnalyzer];

/** Whether any language analyzer handles this path (by extension). */
export function isAnalyzablePath(path: string): boolean {
  return LANGUAGE_ANALYZERS.some((analyzer) => analyzer.matches(path));
}
