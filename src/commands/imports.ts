import { ignorePatterns } from '../config.js';
import { toRepoPath, UsageError, type Context } from '../context.js';
import { AnalysisSession, analysisWarnings, analyzeFile, type FileAnalysis } from '../imports/analysis.js';
import { workingTreeFiles } from '../imports/classify.js';
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
  ImportUnresolvedReasonCode,
};

export interface ImportGraphEdge {
  from: string;
  to: string;
  specifier: string;
  kind: ImportEdgeKind;
  via?: ImportResolutionVia;
  heuristic?: boolean;
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

export function getOrBuildImportGraphIndex(ctx: Context): ImportGraphIndex {
  const existing = sessionIndexCache.get(ctx);
  if (existing) return existing;

  const repoFiles: RepoFiles = ctx.files ?? workingTreeFiles(ctx.root, ctx.currentFiles);
  // The graph only links files in the analyzed tree, and flags path references to symlinked targets.
  const session = new AnalysisSession(repoFiles, {
    includeTarget: (path) => ctx.currentFiles.has(path),
    checkInvalidReferenceTargets: true,
  });
  const ignoreMatcher = new PathMatcher(ignorePatterns(ctx.settings));

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
      session.analyzerFor(from) !== undefined && ctx.currentFiles.has(from) ? analyzeFile(from, repoFiles, session) : undefined;
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
  for (const file of ctx.currentFiles) {
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

  const index: ImportGraphIndex = {
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
  sessionIndexCache.set(ctx, index);
  return index;
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
      const path = ctx.currentFiles.has(rawInput) ? rawInput : toRepoPath(ctx, rawInput);
      if (!ctx.currentFiles.has(path)) {
        throw new UsageError(`No such file in ${ctx.head?.ref ?? 'the working tree'}: ${path}`);
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
  } finally {
    ctx.close?.();
  }
}

export function printImports(result: ImportGraphResult): void {
  printHeader('imports', result.meta);
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
    const tag = edge.heuristic ? `${edge.kind}, heuristic` : edge.kind;
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
