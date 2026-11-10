import { posix } from 'node:path';
import { resolveFile, type RepoFiles } from './tree-files.js';
import { discoverWorkspaces } from './workspaces.js';

export type ImportResolutionVia = 'relative' | 'paths' | 'workspace' | 'exports' | 'imports' | 'go-package' | 'python-module';

export type ImportUnresolvedReasonCode =
  | 'alias-unmatched'
  | 'unknown-package'
  | 'target-missing'
  | 'not-exported'
  | 'invalid-target'
  | 'unsupported-config'
  | 'ambiguous-package';

export const IMPORT_UNRESOLVED_REASON_CODES: readonly ImportUnresolvedReasonCode[] = [
  'alias-unmatched',
  'unknown-package',
  'target-missing',
  'not-exported',
  'invalid-target',
  'unsupported-config',
  'ambiguous-package',
];

export interface ImportsCoverageMeta {
  scope: 'repository' | 'analyzed-files';
  filesScanned: number;
  internalEdges: number;
  external: number;
  unresolved: number;
  dynamicLoads: number;
  unsupportedFiles: number;
  sourceUnavailable: number;
  heuristicEdges: number;
  unresolvedByReason: Partial<Record<ImportUnresolvedReasonCode, number>>;
}

export type Resolution =
  | { kind: 'file'; path: string }
  /** A package from node_modules: not part of this repository. */
  | { kind: 'external' }
  /** Looks local (relative, alias, subpath import) but could not be resolved. */
  | { kind: 'unresolved' };

export type DetailedResolution =
  | {
      kind: 'file';
      path: string;
      via: ImportResolutionVia;
      heuristic?: boolean;
      typeOnlyTarget?: boolean;
    }
  | {
      kind: 'external';
      via?: ImportResolutionVia;
    }
  | {
      kind: 'unresolved';
      reason: 'unmatched';
      reasonCode: ImportUnresolvedReasonCode;
    };

export interface SourceDirMapping {
  configDir: string;
  rootDir?: string;
  outDir?: string;
  declarationDir?: string;
}

export interface PackageTsConfigLookup {
  forPackageDir(pkgDir: string): { sourceMapping?: SourceDirMapping } | null;
}

interface LocalPackage {
  name: string;
  dir: string;
  json: Record<string, unknown>;
  /** True when discovered without an explicit workspace manifest (e.g. Rush/Nx or nested package fallback). */
  heuristicWorkspace?: boolean;
}

interface EnclosingPackageJson {
  dir: string;
  json?: Record<string, unknown>;
  malformed?: boolean;
}

type TargetEvalResult =
  | { status: 'resolved'; path: string; heuristic?: boolean; typeOnlyTarget?: boolean }
  | { status: 'external' }
  | { status: 'blocked' }
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'unsupported' }
  | { status: 'unknown-package' }
  | { status: 'ambiguous-package' }
  | { status: 'unmatched-condition' };

/**
 * Matches a pattern containing at most one `*` against `specifier`.
 * Per Node.js `PACKAGE_IMPORTS_EXPORTS_RESOLVE`, when `pattern` contains `*`,
 * `specifier.length` must be `>= pattern.length` (the `*` substitution must be non-empty).
 * Returns the captured substring for `*`, `""` for exact match, or `undefined`.
 */
export function matchPattern(pattern: string, specifier: string): string | undefined {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === specifier ? '' : undefined;
  // Multiple `*` wildcards in a single exports/imports pattern key are not supported by Node's PATTERN_KEY_COMPARE.
  if (pattern.indexOf('*', star + 1) !== -1) return undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  // Node requires matchKey.length >= expansionKey.length (where expansionKey includes '*'), so '*' matches >= 1 char.
  if (specifier.length < pattern.length) return undefined;
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

/**
 * Node.js `PATTERN_KEY_COMPARE(keyA, keyB)`:
 * 1. Let `baseLengthA` be `keyA.indexOf('*') + 1` if `keyA` contains `'*'`, else `keyA.length`.
 * 2. Let `baseLengthB` be `keyB.indexOf('*') + 1` if `keyB` contains `'*'`, else `keyB.length`.
 * 3. Longer `baseLength` sorts first (`baseLenB - baseLenA`).
 * 4. If `keyA` does not contain `'*'`, return `1` (steps 6–7 of Node's spec).
 * 5. If `keyB` does not contain `'*'`, return `-1`.
 * 6. Longer total key length (longer trailer after `'*'`) sorts first (`keyB.length - keyA.length`).
 */
export function patternKeyCompare(keyA: string, keyB: string): number {
  const starA = keyA.indexOf('*');
  const starB = keyB.indexOf('*');
  const baseLenA = starA === -1 ? keyA.length : starA + 1;
  const baseLenB = starB === -1 ? keyB.length : starB + 1;
  if (baseLenA !== baseLenB) return baseLenB - baseLenA;
  if (starA === -1 && starB === -1) return 0;
  if (starA === -1) return 1;
  if (starB === -1) return -1;
  if (keyA.length !== keyB.length) return keyB.length - keyA.length;
  return 0;
}

export function extractBarePackageName(specifier: string): string | undefined {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) {
    return undefined;
  }
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    const scope = parts[0];
    const name = parts[1];
    if (!scope || scope.length <= 1 || !name) return undefined;
    return `${scope}/${name}`;
  }
  const parts = specifier.split('/');
  return parts[0] || undefined;
}

/**
 * Packages that live in this repository (the root package and monorepo workspaces declared
 * in `package.json#workspaces`, `pnpm-workspace.yaml`, or `lerna.json`, with heuristic fallback
 * for nested `package.json` files when no explicit workspace manifest is present).
 */
export class LocalPackages {
  private initialized = false;
  private readonly packagesByName = new Map<string, LocalPackage>();
  private readonly ambiguousNames = new Set<string>();
  private readonly unsupportedConfigNames = new Set<string>();
  private readonly nonWorkspaceNames = new Set<string>();
  private readonly workspaceScopes = new Set<string>();
  private readonly packageJsonByDir = new Map<string, EnclosingPackageJson>();
  private readonly declaredExternals = new Set<string>();
  private workspaceConfigError = false;
  private anyManifest = false;
  private hasAnyDependencyField = false;

  constructor(
    private readonly files: RepoFiles & { list(): Iterable<string> },
    private readonly tsconfig?: PackageTsConfigLookup,
  ) {}

  hasWorkspaceConfigError(): boolean {
    this.ensureInitialized();
    return this.workspaceConfigError;
  }

  hasAnyManifest(): boolean {
    this.ensureInitialized();
    return this.anyManifest;
  }

  isDeclaredExternal(specifier: string, _fromFile?: string): boolean {
    this.ensureInitialized();
    const pkgName = extractBarePackageName(specifier);
    if (!pkgName) return false;
    // Never classify an in-repo package name as an external dependency
    if (
      this.packagesByName.has(pkgName) ||
      this.ambiguousNames.has(pkgName) ||
      this.unsupportedConfigNames.has(pkgName) ||
      this.nonWorkspaceNames.has(pkgName)
    ) {
      return false;
    }
    return this.declaredExternals.has(pkgName);
  }

  isUnknownBarePackage(bareName: string): boolean {
    this.ensureInitialized();
    if (this.nonWorkspaceNames.has(bareName)) return true;
    if (this.declaredExternals.has(bareName)) return false;
    if (bareName.startsWith('@')) {
      const scope = bareName.split('/')[0];
      if (scope && this.workspaceScopes.has(scope)) return true;
    }
    return this.hasAnyDependencyField;
  }

  resolve(specifier: string, mode: 'import' | 'require' = 'import'): Resolution | undefined {
    const detailed = this.resolveDetailed(specifier, mode, [], false);
    if (!detailed) return undefined;
    if (detailed.kind === 'file') return { kind: 'file', path: detailed.path };
    if (detailed.kind === 'external') return { kind: 'external' };
    return { kind: 'unresolved' };
  }

  resolveDetailed(
    specifier: string,
    mode: 'import' | 'require' = 'import',
    customConditions: readonly string[] = [],
    typeOnlyImport = false,
  ): DetailedResolution | undefined {
    this.ensureInitialized();
    const matchedName = this.findMatchingPackageName(specifier);
    if (!matchedName) return undefined;

    if (this.unsupportedConfigNames.has(matchedName)) {
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'unsupported-config' };
    }
    if (this.ambiguousNames.has(matchedName)) {
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'ambiguous-package' };
    }

    const pkg = this.packagesByName.get(matchedName);
    if (!pkg) {
      if (this.nonWorkspaceNames.has(matchedName)) {
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'unknown-package' };
      }
      return undefined;
    }

    const rest = specifier.slice(pkg.name.length);
    const subpath = rest === '' ? '.' : `.${rest}`;
    const resolved = this.resolvePackageSubpath(pkg, subpath, mode, customConditions, typeOnlyImport);
    if (resolved.kind === 'file' && pkg.heuristicWorkspace && !resolved.heuristic) {
      return { ...resolved, heuristic: true };
    }
    return resolved;
  }

  resolveSubpathImport(
    fromFile: string,
    specifier: string,
    mode: 'import' | 'require',
    customConditions: readonly string[],
    typeOnlyImport: boolean,
  ): DetailedResolution | undefined {
    this.ensureInitialized();
    if (!specifier.startsWith('#') || specifier === '#' || specifier.startsWith('#/')) {
      return undefined;
    }

    const enclosing = this.findNearestPackageJson(fromFile);
    if (!enclosing) return undefined;
    if (enclosing.malformed || !enclosing.json) {
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'unsupported-config' };
    }

    const importsField = enclosing.json.imports;
    if (importsField === undefined) {
      return undefined;
    }
    if (importsField === null || typeof importsField !== 'object' || Array.isArray(importsField)) {
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'unsupported-config' };
    }

    const importsMap = importsField as Record<string, unknown>;
    for (const key of Object.keys(importsMap)) {
      if (!key.startsWith('#') || key === '#' || key.startsWith('#/')) {
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'unsupported-config' };
      }
    }

    const pkg: LocalPackage = {
      name: typeof enclosing.json.name === 'string' ? enclosing.json.name : '',
      dir: enclosing.dir,
      json: enclosing.json,
    };

    const visited = new Set<string>();
    const evalRes = this.resolveImportsEntry(
      pkg,
      importsMap,
      specifier,
      mode,
      customConditions,
      typeOnlyImport,
      visited,
    );
    return this.targetEvalToResolution(evalRes, 'imports');
  }

  private findNearestPackageJson(fromFile: string): EnclosingPackageJson | undefined {
    let dir = posix.dirname(fromFile);
    while (true) {
      const key = dir === '.' ? '' : dir;
      const cached = this.packageJsonByDir.get(key);
      if (cached !== undefined) return cached;
      const pkgPath = key ? `${key}/package.json` : 'package.json';
      if (this.files.exists(pkgPath)) {
        const raw = this.files.read(pkgPath);
        try {
          const json = JSON.parse(raw ?? '') as Record<string, unknown>;
          if (!json || typeof json !== 'object' || Array.isArray(json)) {
            const malformed: EnclosingPackageJson = { dir: key, malformed: true };
            this.packageJsonByDir.set(key, malformed);
            return malformed;
          }
          const entry: EnclosingPackageJson = { dir: key, json };
          this.packageJsonByDir.set(key, entry);
          return entry;
        } catch {
          const malformed: EnclosingPackageJson = { dir: key, malformed: true };
          this.packageJsonByDir.set(key, malformed);
          return malformed;
        }
      }
      if (key === '') break;
      const parent = posix.dirname(key);
      dir = parent === key ? '' : parent;
    }
    return undefined;
  }

  private findMatchingPackageName(specifier: string): string | undefined {
    const primaryCandidates = new Set<string>([
      ...this.packagesByName.keys(),
      ...this.ambiguousNames,
      ...this.unsupportedConfigNames,
    ]);
    let best: string | undefined;
    for (const name of primaryCandidates) {
      if (specifier === name || specifier.startsWith(`${name}/`)) {
        if (!best || name.length > best.length) {
          best = name;
        }
      }
    }
    if (best !== undefined) return best;

    for (const name of this.nonWorkspaceNames) {
      if (specifier === name || specifier.startsWith(`${name}/`)) {
        if (!best || name.length > best.length) {
          best = name;
        }
      }
    }
    return best;
  }

  private resolveImportsEntry(
    pkg: LocalPackage,
    importsMap: Record<string, unknown>,
    specifier: string,
    mode: 'import' | 'require',
    customConditions: readonly string[],
    typeOnlyImport: boolean,
    visited: Set<string>,
  ): TargetEvalResult {
    if (visited.has(specifier) || visited.size > 10) {
      return { status: 'invalid' };
    }
    visited.add(specifier);

    // 1. Exact key match (no `*` in key)
    if (Object.prototype.hasOwnProperty.call(importsMap, specifier) && !specifier.includes('*')) {
      const target = importsMap[specifier];
      return this.evaluateImportTarget(
        pkg,
        importsMap,
        target,
        undefined,
        mode,
        customConditions,
        typeOnlyImport,
        visited,
        false,
      );
    }

    // 2. Pattern keys with a single `*`, sorted by Node's `PATTERN_KEY_COMPARE`
    const patternMatches = Object.keys(importsMap)
      .filter((k) => k.includes('*'))
      .map((k) => ({ key: k, capture: matchPattern(k, specifier) }))
      .filter((m): m is { key: string; capture: string } => m.capture !== undefined)
      .sort((a, b) => patternKeyCompare(a.key, b.key));

    if (patternMatches.length > 0) {
      const best = patternMatches[0]!;
      const target = importsMap[best.key];
      return this.evaluateImportTarget(
        pkg,
        importsMap,
        target,
        best.capture,
        mode,
        customConditions,
        typeOnlyImport,
        visited,
        false,
      );
    }

    return { status: 'blocked' };
  }

  private evaluateImportTarget(
    pkg: LocalPackage,
    importsMap: Record<string, unknown>,
    target: unknown,
    capture: string | undefined,
    mode: 'import' | 'require',
    customConditions: readonly string[],
    typeOnlyImport: boolean,
    visited: Set<string>,
    inheritedHeuristic: boolean,
  ): TargetEvalResult {
    if (target === null) {
      return { status: 'blocked' };
    }

    if (typeof target === 'string') {
      if (capture !== undefined && target.indexOf('*') !== target.lastIndexOf('*')) {
        return { status: 'invalid' };
      }
      const substituted = capture !== undefined ? target.replace('*', capture) : target;
      if (substituted.startsWith('#')) {
        if (substituted === '#' || substituted.startsWith('#/')) {
          return { status: 'invalid' };
        }
        return this.resolveImportsEntry(
          pkg,
          importsMap,
          substituted,
          mode,
          customConditions,
          typeOnlyImport,
          new Set(visited),
        );
      }
      if (substituted.startsWith('./')) {
        return this.evaluateSingleFileTarget(pkg, substituted, inheritedHeuristic);
      }
      if (substituted.startsWith('../') || substituted.startsWith('/')) {
        return { status: 'invalid' };
      }
      // Bare package target in `#imports` (e.g. `"@acme/ui/button"` or `"lodash"`)
      const wsResolved = this.resolveDetailed(substituted, mode, customConditions, typeOnlyImport);
      if (wsResolved) {
        if (wsResolved.kind === 'file') {
          return {
            status: 'resolved',
            path: wsResolved.path,
            heuristic: inheritedHeuristic || wsResolved.heuristic,
            typeOnlyTarget: wsResolved.typeOnlyTarget,
          };
        }
        if (wsResolved.kind === 'external') {
          return { status: 'external' };
        }
        return this.reasonCodeToTargetEval(wsResolved.reasonCode);
      }
      if (this.isDeclaredExternal(substituted)) {
        return { status: 'external' };
      }
      const bare = extractBarePackageName(substituted);
      if (!bare) return { status: 'invalid' };
      return { status: 'unknown-package' };
    }

    if (Array.isArray(target)) {
      if (target.length === 0) return { status: 'blocked' };
      let lastFailure: TargetEvalResult = { status: 'missing' };
      for (const item of target) {
        const res = this.evaluateImportTarget(
          pkg,
          importsMap,
          item,
          capture,
          mode,
          customConditions,
          typeOnlyImport,
          visited,
          inheritedHeuristic,
        );
        if (res.status === 'resolved' || res.status === 'external' || res.status === 'blocked') {
          return res;
        }
        lastFailure = res;
      }
      return lastFailure;
    }

    if (typeof target === 'object') {
      const obj = target as Record<string, unknown>;
      const keys = Object.keys(obj);
      if (keys.some((k) => k.startsWith('.'))) {
        return { status: 'unsupported' };
      }
      return this.evaluateConditionObject(
        obj,
        mode,
        customConditions,
        typeOnlyImport,
        inheritedHeuristic,
        (childTarget, childHeuristic, isTypesCond) => {
          const res = this.evaluateImportTarget(
            pkg,
            importsMap,
            childTarget,
            capture,
            mode,
            customConditions,
            typeOnlyImport,
            visited,
            childHeuristic,
          );
          if (res.status === 'resolved' && isTypesCond) {
            return { ...res, typeOnlyTarget: true };
          }
          return res;
        },
      );
    }

    return { status: 'unsupported' };
  }

  private resolvePackageSubpath(
    pkg: LocalPackage,
    subpath: string,
    mode: 'import' | 'require',
    customConditions: readonly string[],
    typeOnlyImport: boolean,
  ): DetailedResolution {
    const hasExportsField = Object.prototype.hasOwnProperty.call(pkg.json, 'exports');

    if (hasExportsField) {
      const exportsVal = pkg.json.exports;
      if (exportsVal === null) {
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'not-exported' };
      }
      const evalRes = this.evaluateTopLevelExports(pkg, exportsVal, subpath, mode, customConditions, typeOnlyImport);
      return this.targetEvalToResolution(evalRes, 'exports');
    }

    // No `exports` field: fall back to `module` / `source` / `main` / `types` (for '.') or package-root subpath
    if (subpath === '.') {
      const entryFields = typeOnlyImport
        ? ['module', 'source', 'main', 'types', 'typings', ' jsnext:main']
        : ['module', 'source', 'main'];
      for (const field of entryFields) {
        const entry = pkg.json[field.trim()];
        if (typeof entry === 'string' && entry.trim() !== '') {
          const normEntry = entry.startsWith('./') || entry.startsWith('../') ? entry : `./${entry}`;
          const evalRes = this.evaluateSingleFileTarget(pkg, normEntry, false);
          if (evalRes.status === 'resolved') {
            return {
              kind: 'file',
              path: evalRes.path,
              via: 'workspace',
              ...(evalRes.heuristic ? { heuristic: true } : {}),
            };
          }
          if (evalRes.status === 'invalid') {
            return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'invalid-target' };
          }
        }
      }
      // Fallback to `./src/index` or `./index`
      for (const fallback of ['./src/index', './index']) {
        const evalRes = this.evaluateSingleFileTarget(pkg, fallback, false);
        if (evalRes.status === 'resolved') {
          return {
            kind: 'file',
            path: evalRes.path,
            via: 'workspace',
            ...(evalRes.heuristic ? { heuristic: true } : {}),
          };
        }
        if (evalRes.status === 'invalid') {
          return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'invalid-target' };
        }
      }
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'target-missing' };
    }

    // Deep subpath when `exports` is absent (e.g. `@acme/ui/button`)
    const relSubpath = subpath.slice(2); // strip leading `./`
    for (const candidateRel of [`./${relSubpath}`, `./src/${relSubpath}`]) {
      const evalRes = this.evaluateSingleFileTarget(pkg, candidateRel, false);
      if (evalRes.status === 'resolved') {
        return {
          kind: 'file',
          path: evalRes.path,
          via: 'workspace',
          ...(evalRes.heuristic ? { heuristic: true } : {}),
        };
      }
      if (evalRes.status === 'invalid') {
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'invalid-target' };
      }
    }
    return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'target-missing' };
  }

  private evaluateTopLevelExports(
    pkg: LocalPackage,
    exportsVal: unknown,
    subpath: string,
    mode: 'import' | 'require',
    customConditions: readonly string[],
    typeOnlyImport: boolean,
  ): TargetEvalResult {
    if (typeof exportsVal === 'string' || Array.isArray(exportsVal)) {
      if (subpath !== '.') return { status: 'blocked' };
      return this.evaluateExportTarget(pkg, exportsVal, undefined, mode, customConditions, typeOnlyImport, false);
    }

    if (exportsVal && typeof exportsVal === 'object') {
      const obj = exportsVal as Record<string, unknown>;
      const keys = Object.keys(obj);
      if (keys.length === 0) return { status: 'blocked' };

      const hasSubpathKeys = keys.some((k) => k.startsWith('.'));
      const hasConditionKeys = keys.some((k) => !k.startsWith('.'));
      // Node.js forbids mixing subpath keys (starting with '.') and condition keys in the same exports object.
      if (hasSubpathKeys && hasConditionKeys) {
        return { status: 'unsupported' };
      }

      if (hasSubpathKeys) {
        for (const k of keys) {
          if (k !== '.' && !k.startsWith('./')) {
            return { status: 'unsupported' };
          }
        }
        // 1. Exact key match (without `*`)
        if (Object.prototype.hasOwnProperty.call(obj, subpath) && !subpath.includes('*')) {
          return this.evaluateExportTarget(
            pkg,
            obj[subpath],
            undefined,
            mode,
            customConditions,
            typeOnlyImport,
            false,
          );
        }

        // 2. Wildcard pattern match ordered by `PATTERN_KEY_COMPARE`
        const patternMatches = keys
          .filter((k) => k.includes('*'))
          .map((k) => ({ key: k, capture: matchPattern(k, subpath) }))
          .filter((m): m is { key: string; capture: string } => m.capture !== undefined)
          .sort((a, b) => patternKeyCompare(a.key, b.key));

        if (patternMatches.length > 0) {
          const best = patternMatches[0]!;
          return this.evaluateExportTarget(
            pkg,
            obj[best.key],
            best.capture,
            mode,
            customConditions,
            typeOnlyImport,
            false,
          );
        }

        return { status: 'blocked' };
      }

      // Shorthand conditional root object (applies only to `.`)
      if (subpath !== '.') {
        return { status: 'blocked' };
      }
      return this.evaluateExportTarget(pkg, obj, undefined, mode, customConditions, typeOnlyImport, false);
    }

    return { status: 'unsupported' };
  }

  private evaluateExportTarget(
    pkg: LocalPackage,
    target: unknown,
    capture: string | undefined,
    mode: 'import' | 'require',
    customConditions: readonly string[],
    typeOnlyImport: boolean,
    inheritedHeuristic: boolean,
  ): TargetEvalResult {
    if (target === null) {
      return { status: 'blocked' };
    }

    if (typeof target === 'string') {
      if (!target.startsWith('./')) {
        return { status: 'invalid' };
      }
      if (capture !== undefined && target.indexOf('*') !== target.lastIndexOf('*')) {
        return { status: 'invalid' };
      }
      const substituted = capture !== undefined ? target.replace('*', capture) : target;
      return this.evaluateSingleFileTarget(pkg, substituted, inheritedHeuristic);
    }

    if (Array.isArray(target)) {
      if (target.length === 0) return { status: 'blocked' };
      let lastFailure: TargetEvalResult = { status: 'missing' };
      for (const item of target) {
        const res = this.evaluateExportTarget(
          pkg,
          item,
          capture,
          mode,
          customConditions,
          typeOnlyImport,
          inheritedHeuristic,
        );
        if (res.status === 'resolved' || res.status === 'blocked') {
          return res;
        }
        lastFailure = res;
      }
      return lastFailure;
    }

    if (typeof target === 'object') {
      const obj = target as Record<string, unknown>;
      const keys = Object.keys(obj);
      if (keys.some((k) => k.startsWith('.'))) {
        return { status: 'unsupported' };
      }
      return this.evaluateConditionObject(
        obj,
        mode,
        customConditions,
        typeOnlyImport,
        inheritedHeuristic,
        (childTarget, childHeuristic, isTypesCond) => {
          const res = this.evaluateExportTarget(
            pkg,
            childTarget,
            capture,
            mode,
            customConditions,
            typeOnlyImport,
            childHeuristic,
          );
          if (res.status === 'resolved' && isTypesCond) {
            return { ...res, typeOnlyTarget: true };
          }
          return res;
        },
      );
    }

    return { status: 'unsupported' };
  }

  /**
   * Evaluates a conditional `exports` or `imports` object according to Node.js + TypeScript rules:
   * - Active conditions: `customConditions`, `'node'`, `mode` (`'import'` OR `'require'`, mutually exclusive),
   *   and `'types'` (when `typeOnlyImport` is true).
   * - Object keys are walked in declaration order, EXCEPT `'default'` is only evaluated after
   *   non-`'default'` active conditions if none matched earlier (so `{ default: ..., import: ... }`
   *   still prefers `'import'` over `'default'`, while `{ import: ..., default: ... }` checks `'import'` first).
   * - If no active runtime condition matched and `'source'` is present (even when not in `customConditions`),
   *   `'source'` is tried as a `heuristic: true` fallback before failing.
   * - If `'types'` is the only matching condition for a value import, we do NOT resolve a `.d.ts` file as
   *   a runtime target unless `typeOnlyImport` is true or the target is an implementation `.ts`/`.tsx` file.
   */
  private evaluateConditionObject(
    obj: Record<string, unknown>,
    mode: 'import' | 'require',
    customConditions: readonly string[],
    typeOnlyImport: boolean,
    inheritedHeuristic: boolean,
    evalChild: (childTarget: unknown, heuristic: boolean, isTypesCond: boolean) => TargetEvalResult,
  ): TargetEvalResult {
    const customSet = new Set(customConditions);
    const activeConditions = new Set<string>(['node', mode, ...customConditions]);
    if (typeOnlyImport) {
      activeConditions.add('types');
    }

    const keys = Object.keys(obj);
    const nonDefaultKeys = keys.filter((k) => k !== 'default');
    const orderedKeys = keys.includes('default') ? [...nonDefaultKeys, 'default'] : nonDefaultKeys;

    let lastFailure: TargetEvalResult | undefined;

    for (const key of orderedKeys) {
      if (!activeConditions.has(key) && key !== 'default') continue;
      const val = obj[key];
      if (val === null) {
        return { status: 'blocked' };
      }
      const res = evalChild(val, inheritedHeuristic, key === 'types');
      if (res.status === 'resolved' || res.status === 'external' || res.status === 'blocked') {
        return res;
      }
      if (res.status !== 'unmatched-condition') {
        lastFailure = res;
      }
    }

    // Heuristic `source` condition fallback when `source` was not explicitly configured in `customConditions`
    if (!customSet.has('source') && Object.prototype.hasOwnProperty.call(obj, 'source')) {
      const sourceVal = obj.source;
      if (sourceVal === null) return { status: 'blocked' };
      const res = evalChild(sourceVal, true, false);
      if (res.status === 'resolved' || res.status === 'external' || res.status === 'blocked') {
        return res;
      }
      if (res.status !== 'unmatched-condition') {
        lastFailure = res;
      }
    }

    return lastFailure ?? { status: 'unmatched-condition' };
  }

  /**
   * Resolves a package-relative target path (e.g. `./dist/index.js` or `./src/index.ts`):
   * 1. Enforces package boundary (`..` segments escaping `pkg.dir`, absolute paths, or `node_modules` segments -> `invalid`).
   * 2. If the exact/extension-swapped target file exists in the repo, returns it directly (`heuristic: false`).
   * 3. Otherwise, checks package `tsconfig.json` `outDir`/`declarationDir` -> `rootDir` mapping (`heuristic: false`).
   * 4. Otherwise, applies bounded `dist/`/`lib/`/`build/`/`out/` -> `src/` heuristic (`heuristic: true`).
   */
  private evaluateSingleFileTarget(
    pkg: LocalPackage,
    rawRelativeTarget: string,
    inheritedHeuristic: boolean,
  ): TargetEvalResult {
    if (!rawRelativeTarget.startsWith('./')) {
      return { status: 'invalid' };
    }
    const cleanRel = rawRelativeTarget.replace(/[?#].*$/, '');
    const normRel = posix.normalize(cleanRel);
    if (
      normRel === '..' ||
      normRel.startsWith('../') ||
      posix.isAbsolute(normRel) ||
      normRel.split('/').includes('node_modules')
    ) {
      return { status: 'invalid' };
    }

    const targetInRepo = pkg.dir ? posix.join(pkg.dir, normRel) : normRel;
    if (pkg.dir && targetInRepo !== pkg.dir && !targetInRepo.startsWith(`${pkg.dir}/`)) {
      return { status: 'invalid' };
    }

    const checkResolved = (found: string, heuristic: boolean): TargetEvalResult => {
      if (pkg.dir && found !== pkg.dir && !found.startsWith(`${pkg.dir}/`)) {
        return { status: 'invalid' };
      }
      if (this.files.isWithinDir && !this.files.isWithinDir(found, pkg.dir)) {
        return { status: 'invalid' };
      }
      return { status: 'resolved', path: found, heuristic: inheritedHeuristic || heuristic };
    };

    // 1. Direct target resolution (existing built/source file wins without rewriting)
    const direct = resolveFile(targetInRepo, this.files);
    if (direct !== undefined) {
      return checkResolved(direct, false);
    }
    if (this.files.isInvalidTarget?.(targetInRepo, pkg.dir)) {
      return { status: 'invalid' };
    }

    // 2. Tsconfig-backed `outDir` / `declarationDir` -> `rootDir` remapping (`heuristic: false`)
    const pkgConfig = this.tsconfig?.forPackageDir(pkg.dir);
    const mapping = pkgConfig?.sourceMapping;
    if (mapping && mapping.rootDir !== undefined) {
      for (const buildDir of [mapping.outDir, mapping.declarationDir]) {
        if (buildDir !== undefined && (targetInRepo === buildDir || targetInRepo.startsWith(`${buildDir}/`))) {
          const suffix = targetInRepo.slice(buildDir.length).replace(/^\//, '');
          const swappedSuffix = stripDeclarationExt(suffix);
          const remapped = mapping.rootDir ? posix.join(mapping.rootDir, swappedSuffix) : swappedSuffix;
          const found = resolveFile(remapped, this.files);
          if (found !== undefined) {
            return checkResolved(found, false);
          }
          if (this.files.isInvalidTarget?.(remapped, pkg.dir)) {
            return { status: 'invalid' };
          }
        }
      }
    }

    // 3. Bounded `dist/` / `lib/` / `build/` / `out/` -> `src/` heuristic (`heuristic: true`)
    const heuristicTarget = sourceForBuildOutput(targetInRepo, pkg.dir);
    if (heuristicTarget !== targetInRepo) {
      const found = resolveFile(heuristicTarget, this.files);
      if (found !== undefined) {
        return checkResolved(found, true);
      }
      if (this.files.isInvalidTarget?.(heuristicTarget, pkg.dir)) {
        return { status: 'invalid' };
      }
    }

    return { status: 'missing' };
  }

  private targetEvalToResolution(evalRes: TargetEvalResult, via: 'exports' | 'imports'): DetailedResolution {
    switch (evalRes.status) {
      case 'resolved':
        return {
          kind: 'file',
          path: evalRes.path,
          via,
          ...(evalRes.heuristic ? { heuristic: true } : {}),
        };
      case 'external':
        return { kind: 'external', via };
      case 'blocked':
      case 'unmatched-condition':
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'not-exported' };
      case 'missing':
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'target-missing' };
      case 'invalid':
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'invalid-target' };
      case 'unsupported':
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'unsupported-config' };
      case 'unknown-package':
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'unknown-package' };
      case 'ambiguous-package':
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'ambiguous-package' };
    }
  }

  private reasonCodeToTargetEval(reasonCode: ImportUnresolvedReasonCode): TargetEvalResult {
    switch (reasonCode) {
      case 'not-exported':
        return { status: 'blocked' };
      case 'target-missing':
        return { status: 'missing' };
      case 'invalid-target':
      case 'alias-unmatched':
        return { status: 'invalid' };
      case 'unsupported-config':
        return { status: 'unsupported' };
      case 'unknown-package':
        return { status: 'unknown-package' };
      case 'ambiguous-package':
        return { status: 'ambiguous-package' };
    }
  }

  private ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;

    const discovered = discoverWorkspaces(this.files);
    this.anyManifest = discovered.anyManifest;
    this.workspaceConfigError = discovered.workspaceConfigError;

    for (const dep of discovered.catalogDeps) {
      this.declaredExternals.add(dep);
    }

    if (discovered.rootPackageEntry) {
      this.packageJsonByDir.set('', discovered.rootPackageEntry);
      if (discovered.rootPackageEntry.json) {
        this.collectDeclaredDependencies(discovered.rootPackageEntry.json);
      }
    }

    // When no explicit workspace manifest (`package.json#workspaces`, `pnpm-workspace.yaml`, `lerna.json`)
    // exists and no workspace config error occurred (e.g. Rush/Nx or nested package repo), allow nested
    // `package.json` files as heuristic local packages so real internal edges are never silently dropped.
    const allowHeuristicNestedPackages =
      !discovered.hasExplicitWorkspaceManifest && !discovered.workspaceConfigError;

    for (const file of discovered.allPackageJsonFiles) {
      const dir = posix.dirname(file) === '.' ? '' : posix.dirname(file);
      const isRoot = dir === '';
      const isDeclaredWorkspaceMember =
        isRoot || discovered.activeWorkspaceDirs.has(dir) || discovered.conflictingDirs.has(dir);
      const isHeuristicMember = !isDeclaredWorkspaceMember && allowHeuristicNestedPackages;
      const isWorkspaceMember = isDeclaredWorkspaceMember || isHeuristicMember;

      let entry = this.packageJsonByDir.get(dir);
      if (!entry) {
        const raw = this.files.read(file);
        try {
          const json = JSON.parse(raw ?? '') as Record<string, unknown>;
          if (!json || typeof json !== 'object' || Array.isArray(json)) {
            entry = { dir, malformed: true };
          } else {
            entry = { dir, json };
            this.collectDeclaredDependencies(json);
          }
        } catch {
          entry = { dir, malformed: true };
          if (isWorkspaceMember || discovered.workspaceConfigError) {
            const nameMatch = /["']name["']\s*:\s*["']([^"']+)["']/.exec(raw ?? '');
            if (nameMatch?.[1]) this.unsupportedConfigNames.add(nameMatch[1]);
          }
        }
        this.packageJsonByDir.set(dir, entry);
      }

      if (!isWorkspaceMember) {
        const nonWsName = entry.json && typeof entry.json.name === 'string' ? entry.json.name.trim() : '';
        if (nonWsName) {
          if (discovered.workspaceConfigError) {
            // If workspace manifest(s) failed to parse or conflicted, mark in-repo packages as unsupported-config
            this.unsupportedConfigNames.add(nonWsName);
          } else {
            this.nonWorkspaceNames.add(nonWsName);
          }
        }
        continue;
      }

      if (entry.malformed || !entry.json) {
        this.workspaceConfigError = true;
        continue;
      }

      const pkgName = typeof entry.json.name === 'string' ? entry.json.name.trim() : '';
      if (!pkgName) continue;

      if (pkgName.startsWith('@') && pkgName.includes('/')) {
        const scope = pkgName.split('/')[0];
        if (scope) this.workspaceScopes.add(scope);
      }

      if (discovered.conflictingDirs.has(dir) || discovered.workspaceConfigError) {
        this.unsupportedConfigNames.add(pkgName);
        continue;
      }

      if (this.ambiguousNames.has(pkgName)) {
        continue;
      }

      if (this.packagesByName.has(pkgName)) {
        this.packagesByName.delete(pkgName);
        this.ambiguousNames.add(pkgName);
        continue;
      }

      this.packagesByName.set(pkgName, {
        name: pkgName,
        dir,
        json: entry.json,
        ...(isHeuristicMember ? { heuristicWorkspace: true } : {}),
      });
    }
  }

  private collectDeclaredDependencies(json: Record<string, unknown>): void {
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = json[field];
      if (deps && typeof deps === 'object' && !Array.isArray(deps)) {
        this.hasAnyDependencyField = true;
        for (const depName of Object.keys(deps as Record<string, unknown>)) {
          this.declaredExternals.add(depName);
          if (depName.startsWith('@types/')) {
            const rawTypeName = depName.slice('@types/'.length);
            const sep = rawTypeName.indexOf('__');
            if (sep !== -1) {
              this.declaredExternals.add(`@${rawTypeName.slice(0, sep)}/${rawTypeName.slice(sep + 2)}`);
            } else {
              this.declaredExternals.add(rawTypeName);
            }
          }
        }
      }
    }
    for (const field of ['bundleDependencies', 'bundledDependencies']) {
      const bundled = json[field];
      if (Array.isArray(bundled)) {
        this.hasAnyDependencyField = true;
        for (const item of bundled) {
          if (typeof item === 'string') this.declaredExternals.add(item);
        }
      }
    }
  }
}

function stripDeclarationExt(filePath: string): string {
  if (filePath.endsWith('.d.ts')) return `${filePath.slice(0, -5)}.js`;
  if (filePath.endsWith('.d.mts')) return `${filePath.slice(0, -6)}.mjs`;
  if (filePath.endsWith('.d.cts')) return `${filePath.slice(0, -6)}.cjs`;
  return filePath;
}

/** Maps a published path such as `dist/esm/utils.js` back to a likely source file such as `src/utils.ts`. */
function sourceForBuildOutput(target: string, pkgDir: string): string {
  const rel = pkgDir ? target.slice(pkgDir.length + 1) : target;
  const rewritten = stripDeclarationExt(
    rel.replace(/^(?:dist|lib|build|out|esm|cjs)\/(?:(?:esm|cjs|types|es|mjs)\/)?/, 'src/'),
  );
  return pkgDir ? `${pkgDir}/${rewritten}` : rewritten;
}
