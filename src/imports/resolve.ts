import { builtinModules } from 'node:module';
import { posix } from 'node:path';
import {
  extractBarePackageName,
  IMPORT_UNRESOLVED_REASON_CODES,
  LocalPackages,
  matchPattern,
  patternKeyCompare,
  type DetailedResolution,
  type ImportResolutionVia,
  type ImportsCoverageMeta,
  type ImportUnresolvedReasonCode,
  type PackageTsConfigLookup,
  type Resolution,
  type SourceDirMapping,
} from './package-exports.js';
import {
  candidateFilePaths,
  gitTreeFiles,
  MAX_SOURCE_BYTES,
  resolveFile,
  type GitTreeFiles,
  type GitTreeFilesOptions,
  type RepoFiles,
} from './tree-files.js';
import { typescript } from './typescript.js';
import {
  discoverWorkspaces,
  extractPackageJsonWorkspaces,
  matchWorkspaceDirectories,
  parsePnpmWorkspaceYaml,
  type DiscoveredWorkspaces,
} from './workspaces.js';

export {
  candidateFilePaths,
  discoverWorkspaces,
  extractBarePackageName,
  extractPackageJsonWorkspaces,
  gitTreeFiles,
  IMPORT_UNRESOLVED_REASON_CODES,
  LocalPackages,
  matchPattern,
  matchWorkspaceDirectories,
  MAX_SOURCE_BYTES,
  parsePnpmWorkspaceYaml,
  patternKeyCompare,
  resolveFile,
  type DetailedResolution,
  type DiscoveredWorkspaces,
  type GitTreeFiles,
  type GitTreeFilesOptions,
  type ImportResolutionVia,
  type ImportsCoverageMeta,
  type ImportUnresolvedReasonCode,
  type PackageTsConfigLookup,
  type RepoFiles,
  type Resolution,
  type SourceDirMapping,
};

export interface ResolveOptions {
  typeOnlyImport?: boolean;
}

export interface PathEntry {
  pattern: string;
  targets: string[];
  base: string;
}

export interface PathsConfig {
  baseUrl?: string;
  paths?: PathEntry[];
  /** Directory of the config that declared `paths`. */
  pathsDir?: string;
  /** Where `paths` targets resolve from: the effective baseUrl, else `pathsDir`. */
  pathsBase?: string;
  /** Custom export/import conditions from `compilerOptions.customConditions`. */
  customConditions?: string[];
  /** Source-to-output directory mapping from `compilerOptions`. */
  sourceMapping?: SourceDirMapping;
  /** True when the tsconfig file could not be parsed as valid JSONC. */
  malformed?: boolean;
}

const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json', 'tsconfig.app.json'];
const PKG_CONFIG_NAMES = ['tsconfig.build.json', 'tsconfig.json', 'tsconfig.app.json', 'jsconfig.json'];

/**
 * Reads `baseUrl`, `paths`, `customConditions`, and `outDir`/`declarationDir`/`rootDir`
 * from the nearest tsconfig/jsconfig, following relative `extends` and `references`.
 */
export class TsConfigPaths implements PackageTsConfigLookup {
  private readonly byDir = new Map<string, PathsConfig | null>();
  private readonly byPkgDir = new Map<string, PathsConfig | null>();
  private readonly byFile = new Map<string, PathsConfig | null>();

  constructor(private readonly files: RepoFiles) {}

  forFile(filePath: string): PathsConfig | null {
    return this.forDir(posix.dirname(filePath));
  }

  forPackageDir(pkgDir: string): PathsConfig | null {
    const key = pkgDir === '.' ? '' : pkgDir;
    const cached = this.byPkgDir.get(key);
    if (cached !== undefined) return cached;
    let result: PathsConfig | null = null;
    for (const name of PKG_CONFIG_NAMES) {
      const candidate = key ? `${key}/${name}` : name;
      if (this.files.exists(candidate)) {
        result = this.load(candidate, 0);
        if (result?.sourceMapping?.outDir || result?.sourceMapping?.declarationDir) {
          break;
        }
      }
    }
    this.byPkgDir.set(key, result);
    return result;
  }

  private forDir(dir: string): PathsConfig | null {
    const key = dir === '.' ? '' : dir;
    const cached = this.byDir.get(key);
    if (cached !== undefined) return cached;
    let result: PathsConfig | null = null;
    for (const name of CONFIG_NAMES) {
      const candidate = key ? `${key}/${name}` : name;
      if (this.files.exists(candidate)) {
        result = this.load(candidate, 0);
        break;
      }
    }
    if (result === null && key !== '') result = this.forDir(posix.dirname(key));
    this.byDir.set(key, result);
    return result;
  }

  private load(configPath: string, depth: number): PathsConfig | null {
    const cached = this.byFile.get(configPath);
    if (cached !== undefined) return cached;
    this.byFile.set(configPath, null); // guards against `extends` cycles
    const text = this.files.read(configPath);
    if (text === undefined) return null;
    const parsed = typescript().parseConfigFileTextToJson(configPath, text);
    const json = parsed.config as
      | {
          extends?: string | string[];
          references?: { path?: string }[];
          compilerOptions?: {
            baseUrl?: string;
            paths?: Record<string, string[]>;
            customConditions?: unknown[];
            rootDir?: string;
            outDir?: string;
            declarationDir?: string;
          };
        }
      | undefined;
    if (parsed.error && (!json || Object.keys(json).length === 0)) {
      const malformed: PathsConfig = { malformed: true };
      this.byFile.set(configPath, malformed);
      return malformed;
    }
    if (!json || typeof json !== 'object') return null;

    const dir = posix.dirname(configPath) === '.' ? '' : posix.dirname(configPath);
    let result: PathsConfig = {};
    const parents =
      typeof json.extends === 'string' ? [json.extends] : Array.isArray(json.extends) ? json.extends : [];
    for (const parent of parents) {
      if (depth >= 5 || typeof parent !== 'string' || !(parent.startsWith('./') || parent.startsWith('../'))) continue;
      let parentPath = posix.normalize(dir ? posix.join(dir, parent) : parent);
      if (!this.files.exists(parentPath) && !parentPath.endsWith('.json')) {
        if (this.files.exists(`${parentPath}/tsconfig.json`)) {
          parentPath = `${parentPath}/tsconfig.json`;
        } else {
          parentPath += '.json';
        }
      }
      const inherited = this.load(parentPath, depth + 1);
      if (inherited) {
        result = {
          ...result,
          ...inherited,
          sourceMapping: inherited.sourceMapping ? { ...inherited.sourceMapping } : result.sourceMapping,
        };
      }
    }

    const references = Array.isArray(json.references) ? json.references : [];
    for (const ref of references) {
      if (depth >= 5 || typeof ref?.path !== 'string') continue;
      let refPath = posix.normalize(dir ? posix.join(dir, ref.path) : ref.path);
      if (this.files.exists(posix.join(refPath, 'tsconfig.json'))) refPath = posix.join(refPath, 'tsconfig.json');
      else if (!refPath.endsWith('.json')) refPath += '.json';
      const referenced = this.load(refPath, depth + 1);
      if (referenced) {
        result = {
          ...result,
          ...referenced,
          paths: [
            ...(referenced.paths ?? []),
            ...(result.paths ?? []).filter((ip) => !(referenced.paths ?? []).some((rp) => rp.pattern === ip.pattern)),
          ],
        };
      }
    }

    const options = json.compilerOptions ?? {};
    if (typeof options.baseUrl === 'string') {
      const resolvedBase = posix.normalize(dir ? posix.join(dir, options.baseUrl) : options.baseUrl);
      result.baseUrl = resolvedBase === '.' ? '' : resolvedBase;
    }
    if (Array.isArray(options.customConditions)) {
      result.customConditions = options.customConditions.filter((c): c is string => typeof c === 'string');
    }
    if (
      typeof options.rootDir === 'string' ||
      typeof options.outDir === 'string' ||
      typeof options.declarationDir === 'string'
    ) {
      const resolveRel = (val: string | undefined): string | undefined => {
        if (typeof val !== 'string') return undefined;
        const norm = posix.normalize(dir ? posix.join(dir, val) : val);
        return norm === '.' ? '' : norm.replace(/\/$/, '');
      };
      result.sourceMapping = {
        configDir: dir,
        rootDir: resolveRel(options.rootDir) ?? result.sourceMapping?.rootDir,
        outDir: resolveRel(options.outDir) ?? result.sourceMapping?.outDir,
        declarationDir: resolveRel(options.declarationDir) ?? result.sourceMapping?.declarationDir,
      };
    }
    if (options.paths !== undefined) {
      if (options.paths && typeof options.paths === 'object' && !Array.isArray(options.paths)) {
        const currentBase = result.baseUrl ?? dir;
        const declaredPaths: PathEntry[] = Object.entries(options.paths)
          .filter(([, targets]) => Array.isArray(targets))
          .map(([pattern, targets]) => ({
            pattern,
            targets: targets.filter((t): t is string => typeof t === 'string'),
            base: currentBase,
          }));
        // Child mappings override parent mappings for the same pattern, and come first.
        const inherited = (result.paths ?? []).filter((ip) => !declaredPaths.some((dp) => dp.pattern === ip.pattern));
        result.paths = [...declaredPaths, ...inherited];
        result.pathsDir = dir;
      } else {
        result.malformed = true;
      }
    }
    // Same rule as TypeScript: paths resolve against the effective baseUrl when there is one.
    result.pathsBase = result.baseUrl ?? result.pathsDir;
    this.byFile.set(configPath, result);
    return result;
  }
}

/** Specifiers that look like local aliases even when no config explains them. */
const ALIAS_LIKE = /^(?:[@~#$]\/|~(?:\/|$)|#|\$(?:lib|app)?(?:\/|$))/;

const BUILTIN_MODULES = new Set<string>([
  ...builtinModules,
  ...builtinModules.map((m) => (m.startsWith('node:') ? m.slice(5) : `node:${m}`)),
]);

function isBuiltinModule(specifier: string): boolean {
  if (BUILTIN_MODULES.has(specifier)) return true;
  const slash = specifier.indexOf('/');
  if (slash !== -1 && BUILTIN_MODULES.has(specifier.slice(0, slash))) return true;
  return false;
}

export class ImportResolver {
  private readonly tsconfig: TsConfigPaths;
  private readonly packages: LocalPackages;

  constructor(private readonly files: RepoFiles) {
    this.tsconfig = new TsConfigPaths(files);
    this.packages = new LocalPackages(files, this.tsconfig);
  }

  resolve(fromFile: string, rawSpecifier: string, explicitMode?: 'import' | 'require'): Resolution {
    const detailed = this.resolveDetailed(fromFile, rawSpecifier, explicitMode);
    if (detailed.kind === 'file') return { kind: 'file', path: detailed.path };
    if (detailed.kind === 'external') return { kind: 'external' };
    return { kind: 'unresolved' };
  }

  resolveDetailed(
    fromFile: string,
    rawSpecifier: string,
    explicitMode?: 'import' | 'require',
    options?: ResolveOptions,
  ): DetailedResolution {
    // Drop query/hash suffixes (`./x.svg?raw`), but a leading `#` is a subpath alias (`#utils` or `#/utils`).
    const specifier = rawSpecifier.startsWith('#')
      ? rawSpecifier.replace(/\?.*$/, '')
      : rawSpecifier.replace(/[?#].*$/, '');
    if (specifier === '') {
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'invalid-target' };
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
      return { kind: 'external' }; // node:fs, https://, data:
    }

    const fromDir = posix.dirname(fromFile) === '.' ? '' : posix.dirname(fromFile);

    // 1. Relative specifiers (`./...`, `../...`, `.`, `..`)
    if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') {
      const joined = posix.normalize(fromDir ? posix.join(fromDir, specifier) : specifier);
      if (joined === '..' || joined.startsWith('../') || posix.isAbsolute(joined)) {
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'invalid-target' };
      }
      const found = resolveFile(joined, this.files);
      if (found) {
        if (this.files.isWithinDir && !this.files.isWithinDir(found, '')) {
          return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'invalid-target' };
        }
        return { kind: 'file', path: found, via: 'relative' };
      }
      if (this.files.isInvalidTarget?.(joined, '')) {
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'invalid-target' };
      }
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'target-missing' };
    }

    // 2. Absolute paths (`/foo/bar`) are invalid module specifiers in repo context
    if (specifier.startsWith('/')) {
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'invalid-target' };
    }

    const mode = explicitMode ?? (fromFile.endsWith('.cjs') || fromFile.endsWith('.cts') ? 'require' : 'import');
    const config = this.tsconfig.forFile(fromFile);
    const customConditions = config?.customConditions ?? [];
    const typeOnlyImport = options?.typeOnlyImport ?? false;

    // 3. Node.js subpath imports (`#...`) via nearest enclosing `package.json#imports`
    if (specifier.startsWith('#')) {
      const importsResult = this.packages.resolveSubpathImport(
        fromFile,
        specifier,
        mode,
        customConditions,
        typeOnlyImport,
      );
      if (importsResult !== undefined) {
        // If `#/foo` was not matched by `package.json#imports`, allow `tsconfig.paths` (e.g. `#/*`) to try before failing.
        if (importsResult.kind !== 'unresolved') {
          return importsResult;
        }
        const viaPaths = this.tryResolvePaths(config, specifier);
        if (viaPaths?.kind === 'file') return viaPaths;
        return importsResult;
      }
      const viaPaths = this.tryResolvePaths(config, specifier);
      if (viaPaths) {
        if (viaPaths.kind === 'file') return viaPaths;
        return {
          kind: 'unresolved',
          reason: 'unmatched',
          reasonCode: viaPaths.sawInvalidTarget ? 'invalid-target' : 'target-missing',
        };
      }
      if (config?.malformed) {
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'unsupported-config' };
      }
      if (specifier === '#') {
        return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'invalid-target' };
      }
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'alias-unmatched' };
    }

    // 4. TypeScript `paths` and `baseUrl`
    const pathsAttempt = this.tryResolvePaths(config, specifier);
    if (pathsAttempt?.kind === 'file') {
      return pathsAttempt;
    }

    if (config?.baseUrl !== undefined) {
      const baseCandidate = posix.normalize(config.baseUrl ? posix.join(config.baseUrl, specifier) : specifier);
      if (baseCandidate !== '..' && !baseCandidate.startsWith('../') && !posix.isAbsolute(baseCandidate)) {
        const found = resolveFile(baseCandidate, this.files);
        if (found) {
          if (this.files.isWithinDir && !this.files.isWithinDir(found, '')) {
            return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'invalid-target' };
          }
          return { kind: 'file', path: found, via: 'paths' };
        }
      }
    }

    // 5. Workspace / local packages (`package.json#exports` or workspace fallbacks)
    const local = this.packages.resolveDetailed(specifier, mode, customConditions, typeOnlyImport);
    if (local) return local;

    // 6. Built-in modules (e.g. `fs`, `path/posix`)
    if (isBuiltinModule(specifier)) {
      return { kind: 'external' };
    }

    // 7. If `tsconfig.paths` matched the specifier and pointed into `node_modules/` or an external package, check external
    if (this.packages.isDeclaredExternal(specifier, fromFile)) {
      return { kind: 'external' };
    }
    if (pathsAttempt?.sawNodeModulesTarget && extractBarePackageName(specifier) !== undefined) {
      return { kind: 'external' };
    }

    // 8. If `tsconfig.paths` matched the specifier but its target file was missing or invalid, report that
    if (pathsAttempt) {
      return {
        kind: 'unresolved',
        reason: 'unmatched',
        reasonCode: pathsAttempt.sawInvalidTarget ? 'invalid-target' : 'target-missing',
      };
    }

    if (config?.malformed) {
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'unsupported-config' };
    }

    // 9. Unmatched alias-like specifier (`@/foo`, `~/bar`, `$lib/baz`)
    if (ALIAS_LIKE.test(specifier)) {
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'alias-unmatched' };
    }

    // 10. Bare specifier that is neither a workspace package nor a declared external dependency
    const bareName = extractBarePackageName(specifier);
    if (!bareName) {
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'invalid-target' };
    }
    if (this.packages.hasWorkspaceConfigError()) {
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'unsupported-config' };
    }
    if (this.packages.isUnknownBarePackage(bareName)) {
      return { kind: 'unresolved', reason: 'unmatched', reasonCode: 'unknown-package' };
    }
    return { kind: 'external' };
  }

  private tryResolvePaths(
    config: PathsConfig | null,
    specifier: string,
  ):
    | { kind: 'file'; path: string; via: 'paths' }
    | { kind: 'unmatched-paths'; sawInvalidTarget: boolean; sawNodeModulesTarget: boolean }
    | undefined {
    if (!config?.paths) return undefined;
    const matches = config.paths
      .map((entry) => ({ entry, capture: matchPattern(entry.pattern, specifier) }))
      .filter((m): m is { entry: PathEntry; capture: string } => m.capture !== undefined)
      .sort((x, y) => patternKeyCompare(x.entry.pattern, y.entry.pattern));

    if (matches.length === 0) return undefined;

    let sawInvalidTarget = false;
    let sawNodeModulesTarget = false;

    for (const { entry, capture } of matches) {
      for (const target of entry.targets) {
        const substituted = target.replace('*', capture);
        const joined = posix.normalize(entry.base ? posix.join(entry.base, substituted) : substituted);
        if (joined === '..' || joined.startsWith('../') || posix.isAbsolute(joined)) {
          sawInvalidTarget = true;
          continue;
        }
        if (joined.startsWith('node_modules/') || joined.includes('/node_modules/')) {
          sawNodeModulesTarget = true;
        }
        const found = resolveFile(joined, this.files);
        if (found) {
          if (this.files.isWithinDir && !this.files.isWithinDir(found, '')) {
            sawInvalidTarget = true;
            continue;
          }
          return { kind: 'file', path: found, via: 'paths' };
        }
        if (this.files.isInvalidTarget?.(joined, '')) {
          sawInvalidTarget = true;
        }
      }
    }
    return { kind: 'unmatched-paths', sawInvalidTarget, sawNodeModulesTarget };
  }
}
