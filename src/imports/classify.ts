import { readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { extractSourceReferences, sourceReferenceKey, type SourceReference, type SourceReferenceKind } from './references.js';
import { ImportResolver, type RepoFiles } from './resolve.js';
import { extractSpecifiers } from './typescript.js';

/**
 * How two co-changing files are related in the current code:
 * - direct:  one imports the other (directly or through an index/barrel file)
 * - test:    a test changing with code (or with another test): expected
 * - ghost:   no import link either way, and we could check: a hidden relationship
 * - unknown: we could not check (non-JS/TS files, project config, or unresolvable alias imports)
 */
export type Relationship = 'direct' | 'test' | 'ghost' | 'unknown';

export const RELATIONSHIPS: readonly Relationship[] = ['ghost', 'unknown', 'direct', 'test'];

export const MAX_BRIDGE_FILES = 3;
export const MAX_BRIDGE_SOURCE_FILES = 10_000;
export const MAX_BRIDGE_SOURCE_BYTES = 50_000_000;

export interface HiddenBridge {
  signal: 'parallel-implementation' | 'shared-environment' | 'shared-api-route' | 'shared-event';
  value: string;
  filesUsing: number;
}

const ANALYZABLE = /\.(?:[cm]?[jt]sx?)$/i;
const MAX_SOURCE_BYTES = 1_000_000;
const BARREL_DEPTH = 3;

interface FileImports {
  analyzable: boolean;
  sourceUnavailable: boolean;
  imports: Set<string>;
  unresolved: number;
}

/** Repository access backed by the working tree and a set of known files. */
export function workingTreeFiles(root: string, existing: ReadonlySet<string>): RepoFiles {
  return {
    exists: (path) => existing.has(path),
    list: () => existing,
    read: (path) => {
      try {
        const full = join(root, path);
        if (statSync(full).size > MAX_SOURCE_BYTES) return undefined;
        return readFileSync(full, 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

export class RelationshipClassifier {
  private readonly resolver: ImportResolver;
  private readonly cache = new Map<string, FileImports>();
  private readonly reachCache = new Map<string, Reach>();
  private bridgeReferences?: Map<string, Set<string>>;
  private bridgeUses?: Map<string, SourceReference & { filesUsing: number }>;

  constructor(
    private readonly files: RepoFiles,
    private readonly includeBridgeFile: (path: string) => boolean = () => true,
  ) {
    this.resolver = new ImportResolver(files);
  }

  classify(a: string, b: string): Relationship {
    if (isTestPair(a, b)) return 'test';
    const ia = this.analyze(a);
    const ib = this.analyze(b);
    const ra = this.reachable(a);
    const rb = this.reachable(b);
    if (ra.files.has(b) || rb.files.has(a)) return 'direct';
    // Manifests and tool config are "used" without imports (dependencies, build settings).
    if (isProjectConfig(a) || isProjectConfig(b)) return 'unknown';
    if (ia.sourceUnavailable || ib.sourceUnavailable) return 'unknown';
    if (!ia.analyzable || !ib.analyzable) return 'unknown';
    // "No import link" is only a claim we can make if every path we followed was resolved.
    if ((ia.analyzable && ra.incomplete) || (ib.analyzable && rb.incomplete)) return 'unknown';
    return 'ghost';
  }

  /** Why a pair was classified as it was, in plain words (for reports). */
  explain(a: string, b: string, relationship: Relationship, bridge?: HiddenBridge): string {
    switch (relationship) {
      case 'test':
        if (isTestFile(a) && isTestFile(b)) return 'two tests that change together';
        return (isTestFile(a) ? testCovers(a, b) : testCovers(b, a)) ? 'a test and the code it covers' : 'a test that changes with this code';
      case 'direct': {
        if (this.analyze(a).imports.has(b)) return `${posix.basename(a)} imports ${posix.basename(b)}`;
        if (this.analyze(b).imports.has(a)) return `${posix.basename(b)} imports ${posix.basename(a)}`;
        return 'linked through an index/barrel file';
      }
      case 'ghost': {
        const signal = bridge ?? this.hiddenBridge(a, b);
        if (!signal) return 'no import link detected in the current code';
        if (signal.signal === 'parallel-implementation') return `possible parallel implementations: ${signal.value} appears in sibling folders`;
        const rarity = `used in ${signal.filesUsing} files`;
        if (signal.signal === 'shared-environment') return `shared configuration: both reference environment variable ${signal.value} (${rarity})`;
        const kind = signal.signal === 'shared-api-route' ? 'API route' : 'event';
        return `possible shared contract: both reference ${kind} ${JSON.stringify(signal.value)} (${rarity})`;
      }
      case 'unknown': {
        const ia = this.analyze(a);
        const ib = this.analyze(b);
        if (isProjectConfig(a) || isProjectConfig(b)) return 'involves project configuration, which code uses without importing';
        if (ia.sourceUnavailable || ib.sourceUnavailable) return 'source is unavailable, so an import link cannot be ruled out';
        if (!ia.analyzable || !ib.analyzable) return 'import status unknown because one or both file types are not supported';
        return 'some imports could not be resolved (aliases or barrel files), so an import link cannot be ruled out';
      }
    }
  }

  hiddenBridge(a: string, b: string): HiddenBridge | undefined {
    const parallel = parallelImplementation(a, b);
    if (parallel) return parallel;
    this.indexBridgeReferences();
    const aReferences = this.bridgeReferences!.get(a);
    const bReferences = this.bridgeReferences!.get(b);
    if (!aReferences || !bReferences) return undefined;

    const candidates = [...aReferences]
      .filter((key) => bReferences.has(key))
      .map((key) => this.bridgeUses!.get(key)!)
      .filter((reference) => reference.filesUsing <= MAX_BRIDGE_FILES)
      .sort((x, y) => x.filesUsing - y.filesUsing || referencePriority(x.kind) - referencePriority(y.kind) || x.value.localeCompare(y.value));
    const best = candidates[0];
    if (!best) return undefined;
    const signal = best.kind === 'environment' ? 'shared-environment' : best.kind === 'api-route' ? 'shared-api-route' : 'shared-event';
    return { signal, value: best.value, filesUsing: best.filesUsing };
  }

  analyze(file: string): FileImports {
    const cached = this.cache.get(file);
    if (cached) return cached;
    const result: FileImports = { analyzable: false, sourceUnavailable: false, imports: new Set(), unresolved: 0 };
    this.cache.set(file, result);
    if (!ANALYZABLE.test(file)) return result;
    const text = this.files.read(file);
    if (text === undefined) {
      result.sourceUnavailable = true;
      return result;
    }
    result.analyzable = true;
    for (const specifier of extractSpecifiers(text)) {
      const resolved = this.resolver.resolve(file, specifier);
      if (resolved.kind === 'file') {
        if (resolved.path !== file) result.imports.add(resolved.path);
      } else if (resolved.kind === 'unresolved') {
        result.unresolved++;
      }
    }
    return result;
  }

  private indexBridgeReferences(): void {
    if (this.bridgeReferences && this.bridgeUses) return;
    const files: string[] = [];
    for (const file of this.files.list()) {
      if (!ANALYZABLE.test(file) || !this.includeBridgeFile(file)) continue;
      files.push(file);
      if (files.length > MAX_BRIDGE_SOURCE_FILES) {
        this.bridgeReferences = new Map();
        this.bridgeUses = new Map();
        return;
      }
    }

    const byFile = new Map<string, Set<string>>();
    const uses = new Map<string, SourceReference & { filesUsing: number }>();
    let sourceBytes = 0;
    for (const file of files) {
      const text = this.files.read(file);
      if (text === undefined) continue;
      sourceBytes += Buffer.byteLength(text);
      if (sourceBytes > MAX_BRIDGE_SOURCE_BYTES) {
        this.bridgeReferences = new Map();
        this.bridgeUses = new Map();
        return;
      }
      const keys = new Set<string>();
      for (const reference of extractSourceReferences(file, text)) {
        const key = sourceReferenceKey(reference);
        keys.add(key);
        const existing = uses.get(key);
        if (existing) existing.filesUsing++;
        else uses.set(key, { ...reference, filesUsing: 1 });
      }
      byFile.set(file, keys);
    }
    this.bridgeReferences = byFile;
    this.bridgeUses = uses;
  }

  /**
   * Direct imports plus whatever is re-exported through index (barrel) files.
   * `incomplete` is set when the file itself or any barrel followed had an import
   * we could not resolve, or barrels nested deeper than we follow.
   */
  private reachable(file: string): Reach {
    const cached = this.reachCache.get(file);
    if (cached) return cached;
    const reach: Reach = { files: new Set(), incomplete: false };
    const visit = (current: string, depth: number) => {
      const info = this.analyze(current);
      if (info.unresolved > 0) reach.incomplete = true;
      for (const target of info.imports) {
        if (reach.files.has(target)) continue;
        reach.files.add(target);
        if (!isIndexFile(target)) continue;
        if (depth < BARREL_DEPTH) visit(target, depth + 1);
        else reach.incomplete = true;
      }
    };
    visit(file, 0);
    this.reachCache.set(file, reach);
    return reach;
  }
}

function parallelImplementation(a: string, b: string): HiddenBridge | undefined {
  const name = posix.basename(a);
  if (name !== posix.basename(b) || /^index(?:\.[^.]+)+$/i.test(name)) return undefined;
  const aDir = posix.dirname(a);
  const bDir = posix.dirname(b);
  if (aDir === '.' || bDir === '.' || aDir === bDir || posix.dirname(aDir) !== posix.dirname(bDir)) return undefined;
  return { signal: 'parallel-implementation', value: name, filesUsing: 2 };
}

function referencePriority(kind: SourceReferenceKind): number {
  return kind === 'environment' ? 0 : kind === 'api-route' ? 1 : 2;
}

interface Reach {
  files: Set<string>;
  incomplete: boolean;
}

function isIndexFile(path: string): boolean {
  return /^index\.[cm]?[jt]sx?$/i.test(posix.basename(path));
}

const TEST_DIR = /(?:^|\/)(?:__tests__|__test__|tests?|specs?)\//i;
const TEST_NAME = /(?:[.-](?:test|spec|e2e)\.[^./]+$|_test\.[^./]+$|^test_)/i;

export function isTestFile(path: string): boolean {
  return TEST_NAME.test(posix.basename(path)) || TEST_DIR.test(path);
}

/** The name a test file and its subject share: `src/foo.ts` and `test/foo.test.ts` -> `foo`. */
export function testStem(path: string): string {
  let base = posix.basename(path).toLowerCase();
  base = base.replace(/[.-](?:test|spec|e2e)(?=\.[^.]+$)/, '').replace(/_test(?=\.[^.]+$)/, '').replace(/^test_/, '');
  base = base.replace(/\.d(?=\.ts$)/, '').replace(/\.[^.]+$/, '');
  if (base === 'index') base = `${posix.basename(posix.dirname(path)).toLowerCase()}/index`;
  return base;
}

/**
 * Pairs that involve tests. A test changing alongside code is expected (tests
 * cover code, often indirectly), so it is never reported as a ghost wire.
 * Project configuration is the exception: package.json moving with a test is
 * mechanical, not "the code under test".
 */
export function isTestPair(a: string, b: string): boolean {
  const aTest = isTestFile(a);
  const bTest = isTestFile(b);
  if (aTest && bTest) return true;
  if (!aTest && !bTest) return false;
  return !isProjectConfig(aTest ? b : a);
}

/**
 * Whether `test` looks like it covers `subject` specifically: same name
 * (`foo.ts` / `foo.test.ts`), a more specific name (`command.ts` /
 * `command.help.test.ts`), or the same feature folder once test folders are
 * stripped (`src/a/x.ts` / `src/a/__tests__/y.test.ts`). Used for wording.
 */
export function testCovers(test: string, subject: string): boolean {
  const testName = testStem(test);
  const subjectName = testStem(subject);
  if (testName === subjectName) return true;
  if (testName.startsWith(subjectName) && /^[.\-_]/.test(testName.slice(subjectName.length))) return true;
  const testArea = stripTestDirs(posix.dirname(test));
  const subjectArea = posix.dirname(subject);
  if (testArea === subjectArea) return testArea !== '.';
  // Shallow folders like `src` are too broad to say a test covers everything below them.
  const [outer, inner] = testArea.length < subjectArea.length ? [testArea, subjectArea] : [subjectArea, testArea];
  return outer.split('/').length >= 2 && inner.startsWith(`${outer}/`);
}

const PROJECT_CONFIG = /^(?:package\.json|tsconfig[\w.-]*\.json|jsconfig\.json|[\w.-]+\.config\.[cm]?[jt]s|\.[\w.-]*rc(?:\.[\w]+)?|dockerfile|makefile|[\w.-]+\.ya?ml|[\w.-]+\.lock)$/i;

/** Manifests and tooling configuration: they change with everything for mechanical reasons. */
export function isProjectConfig(path: string): boolean {
  return path.startsWith('.github/') || PROJECT_CONFIG.test(posix.basename(path));
}

function stripTestDirs(dir: string): string {
  const stripped = dir
    .split('/')
    .filter((segment) => !/^(?:__tests__|__test__|tests?|specs?)$/i.test(segment))
    .join('/');
  return stripped === '' ? '.' : stripped;
}
