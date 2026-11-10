import { ImportResolver } from '../imports/resolve.js';
import type { RepoFiles } from '../imports/tree-files.js';
import { typescript } from '../imports/typescript.js';
import { CompilerCoverageIndex } from './coverage.js';
import { bindingsOf, isSurfaceSource, parseSource, surfaceOf, type FileBindings, type ImportBinding } from './extract.js';
import type { Consumer, ConsumerStatus, ConsumerUse, FileDelta, Surface, UncertainReason } from './types.js';

/** Same depth as the classifier's barrel walk (`BARREL_DEPTH` in `src/imports/classify.ts`). */
export const SURFACE_BARREL_DEPTH = 3;

const STATUS_RANK: Record<ConsumerStatus, number> = { 'uses-removed-name': 0, 'uses-changed-export': 1, uncertain: 2 };

export interface ConsumerSearchInput {
  /** Repository at head. */
  files: RepoFiles;
  deltas: readonly FileDelta[];
  /** Head surfaces of the changed files (for CommonJS defaults and opaque checks). */
  headSurfaces: ReadonlyMap<string, Surface>;
  /** Every path added, modified, deleted or renamed in the PR: never reported as consumers. */
  changedPaths: ReadonlySet<string>;
  /** Mode of each path at head (`120000` = symlink), when known. */
  modes?: ReadonlyMap<string, string>;
}

export interface ConsumerSearchResult {
  consumers: Consumer[];
  skippedFiles: { path: string; reason: 'file-too-large' | 'symlink' }[];
  sourceFiles: number;
  parsedImporters: number;
}

interface Origin {
  file: string;
  name: string;
  change: 'removed' | 'changed';
}

interface Item {
  target: string;
  /** The name as exported by `target`. */
  name: string;
  origin: Origin;
  through: string[];
  opaque: boolean;
  depthExceeded: boolean;
}

interface ParsedFile {
  bindings: FileBindings;
  surface: Surface;
}

export function findConsumers(input: ConsumerSearchInput): ConsumerSearchResult {
  const ts = typescript();
  const { files, deltas, changedPaths } = input;
  const resolver = new ImportResolver(files);
  const sources = [...files.list()].filter(isSurfaceSource).sort();
  const result: ConsumerSearchResult = { consumers: [], skippedFiles: [], sourceFiles: sources.length, parsedImporters: 0 };

  const origins: Origin[] = [];
  for (const delta of deltas) {
    if (delta.status !== 'known') continue;
    for (const entry of delta.entries) {
      if (entry.change !== 'added') origins.push({ file: delta.file, name: entry.name, change: entry.change });
    }
  }
  const opaqueChanged = deltas.filter((d) => d.status === 'known' && (d.opaqueAdded.length > 0 || d.opaqueRemoved.length > 0)).map((d) => d.file);
  if (origins.length === 0 && opaqueChanged.length === 0) return result;

  // Pass 1: every source file's specifiers (TypeScript's pre-processor, no AST), resolved at head.
  const importersOf = new Map<string, Set<string>>();
  const unresolvedIn = new Set<string>();
  const texts = new Map<string, string>();
  const resolveCache = new Map<string, string | undefined | null>();
  /** Resolved target file, `undefined` for external, `null` for unresolved. */
  const resolve = (from: string, specifier: string, mode?: 'import' | 'require', typeOnly = false): string | undefined | null => {
    const key = `${from}\0${specifier}\0${mode ?? ''}\0${typeOnly ? 1 : 0}`;
    if (resolveCache.has(key)) return resolveCache.get(key);
    const resolved = resolver.resolveDetailed(from, specifier, mode, { typeOnlyImport: typeOnly });
    const value = resolved.kind === 'file' ? resolved.path : resolved.kind === 'external' ? undefined : null;
    resolveCache.set(key, value);
    return value;
  };
  for (const path of sources) {
    const text = files.read(path);
    if (text === undefined) {
      const mode = input.modes?.get(path);
      if (!changedPaths.has(path)) result.skippedFiles.push({ path, reason: mode === '120000' ? 'symlink' : 'file-too-large' });
      continue;
    }
    texts.set(path, text);
    const info = ts.preProcessFile(text, true, true);
    for (const reference of info.importedFiles) {
      const specifier = reference.fileName;
      const relative = specifier.startsWith('.');
      const targets = new Set<string>();
      let unresolved = false;
      // Bare specifiers can resolve differently by condition (`import`/`require`/`types`): index every target.
      const attempts: [('import' | 'require')?, boolean?][] = relative
        ? [[undefined]]
        : [[undefined], ['require'], ['import'], ['import', true], ['require', true]];
      for (const [mode, typeOnly] of attempts) {
        const target = resolve(path, specifier, mode, typeOnly);
        if (typeof target === 'string') targets.add(target);
        else if (target === null) unresolved = true;
      }
      if (targets.size === 0 && unresolved) unresolvedIn.add(path);
      for (const target of targets) {
        if (target === path) continue;
        let set = importersOf.get(target);
        if (!set) importersOf.set(target, (set = new Set()));
        set.add(path);
      }
    }
  }

  const parsed = new Map<string, ParsedFile | undefined>();
  const parse = (path: string): ParsedFile | undefined => {
    if (parsed.has(path)) return parsed.get(path);
    const text = texts.get(path);
    let value: ParsedFile | undefined;
    if (text !== undefined) {
      const source = parseSource(path, text);
      value = { bindings: bindingsOf(source), surface: surfaceOf(source) };
      result.parsedImporters++;
    }
    parsed.set(path, value);
    return value;
  };

  const uses = new Map<string, ConsumerUse[]>();
  const seenUse = new Set<string>();
  const record = (consumer: string, use: ConsumerUse) => {
    if (changedPaths.has(consumer)) return;
    const key = `${consumer}\0${use.file}\0${use.name}\0${use.status}\0${use.reason ?? ''}\0${use.via}\0${use.through.join('>')}`;
    if (seenUse.has(key)) return;
    seenUse.add(key);
    const list = uses.get(consumer) ?? [];
    list.push(use);
    uses.set(consumer, list);
  };
  const statusOf = (item: Item): { status: ConsumerStatus; reason?: UncertainReason } => {
    if (item.depthExceeded) return { status: 'uncertain', reason: 'barrel-depth' };
    if (item.opaque) return { status: 'uncertain', reason: 'opaque-re-export' };
    return { status: item.origin.change === 'removed' ? 'uses-removed-name' : 'uses-changed-export' };
  };

  const queue: Item[] = origins.map((origin) => ({ target: origin.file, name: origin.name, origin, through: [], opaque: false, depthExceeded: false }));
  const visited = new Set<string>();
  while (queue.length > 0) {
    const item = queue.shift()!;
    const key = `${item.target}\0${item.name}\0${item.origin.file}\0${item.origin.name}\0${item.opaque}`;
    if (visited.has(key)) continue;
    visited.add(key);
    for (const importer of [...(importersOf.get(item.target) ?? [])].sort()) {
      if (importer === item.origin.file) continue;
      const file = parse(importer);
      if (!file) continue;
      const base = { file: item.origin.file, name: item.origin.name, through: item.through };
      if (file.bindings.parseFailed) {
        record(importer, { ...base, status: 'uncertain', reason: 'parse-failure', via: 'parse-failure' });
        continue;
      }
      for (const binding of file.bindings.bindings) {
        if (resolveBinding(resolve, importer, binding) !== item.target) continue;
        const spec = { specifier: binding.specifier };
        switch (binding.kind) {
          case 'named':
          case 'default':
          case 'require-destructure':
          case 'require-property': {
            if (binding.kind === 'default' && item.target === item.origin.file && input.headSurfaces.get(item.target)?.module === 'cjs') {
              record(importer, { ...base, ...spec, status: 'uncertain', reason: 'namespace-import', via: 'default-of-commonjs' });
              break;
            }
            if (binding.imported !== item.name) break;
            record(importer, { ...base, ...spec, ...statusOf(item), via: binding.kind });
            break;
          }
          case 'namespace':
          case 'require-whole':
            record(importer, { ...base, ...spec, status: 'uncertain', reason: 'namespace-import', via: binding.kind });
            break;
          case 'dynamic':
            record(importer, { ...base, ...spec, status: 'uncertain', reason: 'dynamic-import', via: 'dynamic' });
            break;
          case 're-export': {
            if (binding.imported !== item.name || binding.exportedAs === undefined) break;
            record(importer, { ...base, ...spec, ...statusOf(item), via: 're-export' });
            enqueue(item, importer, binding.exportedAs, item.opaque);
            break;
          }
          case 're-export-star': {
            if (item.name === 'default') break;
            // An explicit export of the same name in the barrel shadows the star.
            if (file.surface.status === 'known' && file.surface.exports.some((e) => e.name === item.name)) break;
            enqueue(item, importer, item.name, true);
            break;
          }
          case 're-export-namespace':
            if (binding.exportedAs !== undefined) enqueue(item, importer, binding.exportedAs, true);
            break;
          case 'side-effect':
            break;
        }
      }
    }
  }

  function enqueue(item: Item, barrel: string, name: string, opaque: boolean): void {
    if (item.depthExceeded) return;
    const through = [barrel, ...item.through];
    queue.push({
      target: barrel,
      name,
      origin: item.origin,
      through,
      opaque,
      depthExceeded: through.length > SURFACE_BARREL_DEPTH,
    });
  }

  // A changed file gained or lost an `export *`: names it does not export explicitly may come and go.
  for (const changed of opaqueChanged) {
    const surface = input.headSurfaces.get(changed);
    const explicit = new Set(surface?.exports.map((e) => e.name) ?? []);
    for (const importer of [...(importersOf.get(changed) ?? [])].sort()) {
      const file = parse(importer);
      if (!file || file.bindings.parseFailed) continue;
      for (const binding of file.bindings.bindings) {
        if (binding.imported === undefined || binding.imported === 'default' || explicit.has(binding.imported)) continue;
        if (!['named', 'require-destructure', 'require-property', 're-export'].includes(binding.kind)) continue;
        if (resolveBinding(resolve, importer, binding) !== changed) continue;
        record(importer, { file: changed, name: binding.imported, status: 'uncertain', reason: 'opaque-re-export', via: binding.kind, through: [], specifier: binding.specifier });
      }
    }
  }

  // An affected name imported, by name, from a specifier that does not resolve.
  const byName = new Map<string, Origin[]>();
  for (const origin of origins) byName.set(origin.name, [...(byName.get(origin.name) ?? []), origin]);
  for (const path of [...unresolvedIn].sort()) {
    if (changedPaths.has(path)) continue;
    const file = parse(path);
    if (!file) continue;
    for (const binding of file.bindings.bindings) {
      if (binding.imported === undefined || !byName.has(binding.imported)) continue;
      if (resolveBinding(resolve, path, binding) !== null) continue;
      for (const origin of byName.get(binding.imported)!) {
        record(path, { file: origin.file, name: origin.name, status: 'uncertain', reason: 'unresolved-specifier', via: binding.kind, through: [], specifier: binding.specifier });
      }
    }
  }

  // Files that could not be read might import anything.
  for (const skipped of result.skippedFiles) {
    for (const origin of origins) {
      record(skipped.path, { file: origin.file, name: origin.name, status: 'uncertain', reason: skipped.reason, via: 'unreadable', through: [] });
    }
  }

  const coverage = new CompilerCoverageIndex(files);
  for (const [consumer, list] of [...uses].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    list.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || cmp(a.file, b.file) || cmp(a.name, b.name) || cmp(a.via, b.via));
    const strongest = list[0]!;
    const covered = coverage.coverage(consumer, strongest.file);
    result.consumers.push({ consumer, status: strongest.status, coverage: covered.coverage, coverageReason: covered.reason, uses: list });
  }
  return result;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function resolveBinding(
  resolve: (from: string, specifier: string, mode?: 'import' | 'require', typeOnly?: boolean) => string | undefined | null,
  from: string,
  binding: ImportBinding,
): string | undefined | null {
  return resolve(from, binding.specifier, binding.mode, Boolean(binding.typeOnly));
}
