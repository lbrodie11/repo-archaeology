import { readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
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

const ANALYZABLE = /\.(?:[cm]?[jt]sx?)$/i;
const MAX_SOURCE_BYTES = 1_000_000;
const BARREL_DEPTH = 3;

interface FileImports {
  analyzable: boolean;
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
  private readonly reachCache = new Map<string, Set<string>>();

  constructor(private readonly files: RepoFiles) {
    this.resolver = new ImportResolver(files);
  }

  classify(a: string, b: string): Relationship {
    if (isTestPair(a, b)) return 'test';
    const ia = this.analyze(a);
    const ib = this.analyze(b);
    if (this.reachable(a).has(b) || this.reachable(b).has(a)) return 'direct';
    // Manifests and tool config are "used" without imports (dependencies, build settings).
    if (isProjectConfig(a) || isProjectConfig(b)) return 'unknown';
    if (!ia.analyzable && !ib.analyzable) return 'unknown';
    if ((ia.analyzable && ia.unresolved > 0) || (ib.analyzable && ib.unresolved > 0)) return 'unknown';
    return 'ghost';
  }

  /** Why a pair was classified as it was, in plain words (for reports). */
  explain(a: string, b: string, relationship: Relationship): string {
    switch (relationship) {
      case 'test':
        if (isTestFile(a) && isTestFile(b)) return 'two tests that change together';
        return (isTestFile(a) ? testCovers(a, b) : testCovers(b, a)) ? 'a test and the code it covers' : 'a test that changes with this code';
      case 'direct': {
        if (this.analyze(a).imports.has(b)) return `${posix.basename(a)} imports ${posix.basename(b)}`;
        if (this.analyze(b).imports.has(a)) return `${posix.basename(b)} imports ${posix.basename(a)}`;
        return 'linked through an index/barrel file';
      }
      case 'ghost':
        return 'no import link in either direction';
      case 'unknown': {
        const ia = this.analyze(a);
        const ib = this.analyze(b);
        if (isProjectConfig(a) || isProjectConfig(b)) return 'involves project configuration, which code uses without importing';
        if (!ia.analyzable && !ib.analyzable) return 'import check not possible for these file types';
        return 'some imports could not be resolved (aliases?)';
      }
    }
  }

  analyze(file: string): FileImports {
    const cached = this.cache.get(file);
    if (cached) return cached;
    const result: FileImports = { analyzable: false, imports: new Set(), unresolved: 0 };
    this.cache.set(file, result);
    if (!ANALYZABLE.test(file)) return result;
    const text = this.files.read(file);
    if (text === undefined) return result;
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

  /** Direct imports plus whatever is re-exported through index (barrel) files. */
  private reachable(file: string): Set<string> {
    const cached = this.reachCache.get(file);
    if (cached) return cached;
    const reach = new Set<string>();
    const visit = (current: string, depth: number) => {
      for (const target of this.analyze(current).imports) {
        if (reach.has(target)) continue;
        reach.add(target);
        if (depth < BARREL_DEPTH && isIndexFile(target)) visit(target, depth + 1);
      }
    };
    visit(file, 0);
    this.reachCache.set(file, reach);
    return reach;
  }
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
