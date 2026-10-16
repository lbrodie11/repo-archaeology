import { readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { ImportResolver, type RepoFiles } from './resolve.js';
import { extractSpecifiers } from './typescript.js';

/**
 * How two co-changing files are related in the current code:
 * - direct:  one imports the other (directly or through an index/barrel file)
 * - test:    a test file and the code it tests
 * - ghost:   no import link either way, and we could check: a hidden relationship
 * - unknown: we could not check (non-JS/TS files, or unresolvable alias imports)
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
    if (!ia.analyzable && !ib.analyzable) return 'unknown';
    if ((ia.analyzable && ia.unresolved > 0) || (ib.analyzable && ib.unresolved > 0)) return 'unknown';
    return 'ghost';
  }

  /** Why a pair was classified as it was, in plain words (for reports). */
  explain(a: string, b: string, relationship: Relationship): string {
    switch (relationship) {
      case 'test':
        return 'a test and the code it covers';
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
 * A test file and (probably) the code it tests: same name (`foo.ts` / `foo.test.ts`),
 * a more specific name (`command.ts` / `command.help.test.ts`), or the same folder
 * once test folders are stripped (`src/a/x.ts` / `src/a/__tests__/y.test.ts`).
 */
export function isTestPair(a: string, b: string): boolean {
  const aTest = isTestFile(a);
  if (aTest === isTestFile(b)) return false;
  const [test, subject] = aTest ? [a, b] : [b, a];
  if (!SOURCE_CODE.test(subject)) return false; // package.json changing with tests is not "the code under test"
  const testName = testStem(test);
  const subjectName = testStem(subject);
  if (testName === subjectName) return true;
  if (testName.startsWith(subjectName) && /^[.\-_]/.test(testName.slice(subjectName.length))) return true;
  return stripTestDirs(posix.dirname(test)) === posix.dirname(subject);
}

const SOURCE_CODE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|py|rb|go|rs|java|kt|kts|scala|swift|m|mm|c|cc|cpp|h|hpp|cs|fs|php|ex|exs|erl|clj|dart|lua|r|jl|zig|sql)$/i;

function stripTestDirs(dir: string): string {
  const stripped = dir
    .split('/')
    .filter((segment) => !/^(?:__tests__|__test__|tests?|specs?)$/i.test(segment))
    .join('/');
  return stripped === '' ? '.' : stripped;
}
