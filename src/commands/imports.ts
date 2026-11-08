import { posix, win32 } from 'node:path';
import { ignorePatterns } from '../config.js';
import { toRepoPath, type Context } from '../context.js';
import { workingTreeFiles } from '../imports/classify.js';
import { ImportResolver, type RepoFiles } from '../imports/resolve.js';
import { extractDetailedDependencies, type ImportEdgeKind } from '../imports/typescript.js';
import { buildMeta, printHeader, type Meta } from '../report/views.js';
import { PathMatcher } from '../util/glob.js';
import { c, plural, terminalText } from '../util/term.js';

export type { ImportEdgeKind };

export interface ImportGraphEdge {
  from: string;
  to: string;
  specifier: string;
  kind: ImportEdgeKind;
}

export interface ImportGraphUnresolved {
  from: string;
  specifier: string;
  reason: string;
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

const ANALYZABLE = /\.(?:[cm]?[jt]sx?)$/i;
const TYPESCRIPT_EXT = /\.(?:[cm]?tsx?)$/i;

function detectLanguage(path: string): 'typescript' | 'javascript' | undefined {
  if (!ANALYZABLE.test(path)) return undefined;
  return TYPESCRIPT_EXT.test(path) ? 'typescript' : 'javascript';
}

export interface ImportGraphIndex {
  readonly allFiles: string[];
  readonly edgesByFrom: Map<string, ImportGraphEdge[]>;
  readonly unresolvedByFrom: Map<string, ImportGraphUnresolved[]>;
  readonly importersByTarget: Map<string, Set<string>>;
  readonly languages: string[];
  indexFile(from: string): void;
}

const sessionIndexCache = new WeakMap<Context, ImportGraphIndex>();

export function getOrBuildImportGraphIndex(ctx: Context): ImportGraphIndex {
  const existing = sessionIndexCache.get(ctx);
  if (existing) return existing;

  const repoFiles: RepoFiles = ctx.files ?? workingTreeFiles(ctx.root, ctx.currentFiles);
  const resolver = new ImportResolver(repoFiles);
  const ignoreMatcher = new PathMatcher(ignorePatterns(ctx.settings));

  const allFiles: string[] = [];
  const edgesByFrom = new Map<string, ImportGraphEdge[]>();
  const unresolvedByFrom = new Map<string, ImportGraphUnresolved[]>();
  const importersByTarget = new Map<string, Set<string>>();
  const languageSet = new Set<string>();

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
    if (!ANALYZABLE.test(from) || !ctx.currentFiles.has(from)) {
      edgesByFrom.set(from, []);
      unresolvedByFrom.set(from, []);
      return;
    }
    const text = repoFiles.read(from);
    if (text === undefined) {
      edgesByFrom.set(from, []);
      unresolvedByFrom.set(from, []);
      return;
    }
    const lang = detectLanguage(from);
    if (lang) languageSet.add(lang);

    const { imports, referencePaths } = extractDetailedDependencies(text, from);
    const fileEdges: ImportGraphEdge[] = [];
    const fileUnresolved: ImportGraphUnresolved[] = [];
    const seenEdges = new Set<string>();
    const seenUnresolved = new Set<string>();

    for (const { specifier, kind } of imports) {
      const resolved = resolver.resolve(from, specifier, kind === 'require' ? 'require' : undefined);
      if (resolved.kind === 'file') {
        if (resolved.path !== from && ctx.currentFiles.has(resolved.path)) {
          const edgeKey = `${resolved.path}\0${specifier}\0${kind}`;
          if (!seenEdges.has(edgeKey)) {
            seenEdges.add(edgeKey);
            fileEdges.push({ from, to: resolved.path, specifier, kind });
            addImporter(resolved.path, from);
          }
        }
      } else if (resolved.kind === 'unresolved') {
        if (!seenUnresolved.has(specifier)) {
          seenUnresolved.add(specifier);
          fileUnresolved.push({ from, specifier, reason: 'unmatched' });
        }
      }
    }

    for (const referencePath of referencePaths) {
      const normRef = referencePath.replace(/\\/g, '/');
      const target = posix.normalize(posix.join(posix.dirname(from), normRef));
      const invalid =
        normRef === '' ||
        posix.isAbsolute(normRef) ||
        win32.parse(normRef).root !== '' ||
        target === '..' ||
        target.startsWith('../') ||
        !repoFiles.exists(target) ||
        !ctx.currentFiles.has(target);
      if (invalid) {
        if (!seenUnresolved.has(referencePath)) {
          seenUnresolved.add(referencePath);
          fileUnresolved.push({ from, specifier: referencePath, reason: 'unmatched' });
        }
      } else if (target !== from) {
        const edgeKey = `${target}\0${referencePath}\0static`;
        if (!seenEdges.has(edgeKey)) {
          seenEdges.add(edgeKey);
          fileEdges.push({ from, to: target, specifier: referencePath, kind: 'static' });
          addImporter(target, from);
        }
      }
    }

    fileEdges.sort(
      (a, b) =>
        a.to.localeCompare(b.to) ||
        a.specifier.localeCompare(b.specifier) ||
        a.kind.localeCompare(b.kind),
    );
    fileUnresolved.sort((a, b) => a.specifier.localeCompare(b.specifier));

    edgesByFrom.set(from, fileEdges);
    unresolvedByFrom.set(from, fileUnresolved);
  };

  const candidates = [...ctx.currentFiles]
    .filter((file) => ANALYZABLE.test(file) && !ignoreMatcher.matches(file))
    .sort();

  for (const file of candidates) {
    indexFile(file);
    allFiles.push(file);
  }

  const index: ImportGraphIndex = {
    allFiles,
    edgesByFrom,
    unresolvedByFrom,
    importersByTarget,
    languages: [...languageSet].sort(),
    indexFile,
  };
  sessionIndexCache.set(ctx, index);
  return index;
}

export function importGraph(ctx: Context, options: ImportGraphOptions = {}): ImportGraphResult {
  ctx.open?.();
  try {
    const index = getOrBuildImportGraphIndex(ctx);

    if (options.files === undefined) {
      const files = [...index.allFiles];
      const edges = files.flatMap((from) => index.edgesByFrom.get(from) ?? []);
      const unresolved = files.flatMap((from) => index.unresolvedByFrom.get(from) ?? []);
      return {
        meta: buildMeta(ctx),
        files,
        edges,
        unresolved,
        languages: [...index.languages],
      };
    }

    const allowedFrom = new Set<string>();
    for (const rawInput of options.files) {
      const path = ctx.currentFiles.has(rawInput) ? rawInput : toRepoPath(ctx, rawInput);
      if (ctx.currentFiles.has(path)) {
        index.indexFile(path);
        allowedFrom.add(path);
      }
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
      const lang = detectLanguage(f);
      if (lang) langSet.add(lang);
    }
    const languages = langSet.size > 0 ? [...langSet].sort() : [...index.languages];

    return {
      meta: buildMeta(ctx),
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
  console.log(
    `${plural(result.files.length, 'file')} · ${plural(result.edges.length, 'internal import edge')} · ${plural(result.unresolved.length, 'unresolved specifier')}`,
  );
  if (result.edges.length === 0 && result.unresolved.length === 0) {
    return;
  }
  console.log();
  for (const edge of result.edges) {
    console.log(
      `  ${c.bold(terminalText(edge.from))} ${c.dim('→')} ${c.bold(terminalText(edge.to))}  ${c.dim(`(${edge.kind}: ${terminalText(edge.specifier)})`)}`,
    );
  }
  if (result.unresolved.length > 0) {
    console.log();
    console.log(c.bold(`Unresolved (${result.unresolved.length})`));
    for (const item of result.unresolved) {
      console.log(
        `  ${c.bold(terminalText(item.from))}  ${terminalText(item.specifier)} ${c.dim(`[${terminalText(item.reason)}]`)}`,
      );
    }
  }
}
