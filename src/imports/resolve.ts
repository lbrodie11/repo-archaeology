import { posix } from 'node:path';
import { typescript } from './typescript.js';

/** Read access to the repository, using repo-relative POSIX paths. */
export interface RepoFiles {
  exists(path: string): boolean;
  read(path: string): string | undefined;
  /** Every file that exists (used to discover the repo's own packages). */
  list(): Iterable<string>;
}

export type Resolution =
  | { kind: 'file'; path: string }
  /** A package from node_modules: not part of this repository. */
  | { kind: 'external' }
  /** Looks local (relative, alias, subpath import) but could not be resolved. */
  | { kind: 'unresolved' };

// Implementation files before declaration files: `./foo` with foo.js and foo.d.ts is foo.js.
const APPEND_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts', '.json'];
const INDEX_FILES = APPEND_EXTENSIONS.filter((e) => e !== '.d.ts' && e !== '.json').map((e) => `index${e}`);
// TypeScript lets `./foo.js` refer to `./foo.ts` in ESM projects.
const EXTENSION_SWAPS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx', '.d.ts'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/** Resolves `base` (a repo-relative path without query/hash) to an existing file. */
export function resolveFile(base: string, files: RepoFiles): string | undefined {
  const normalized = posix.normalize(base);
  if (normalized.startsWith('../') || normalized === '..' || posix.isAbsolute(normalized)) return undefined;
  const p = normalized === '.' ? '' : normalized.replace(/\/$/, '');
  if (p && files.exists(p)) return p;
  const ext = posix.extname(p);
  for (const swap of EXTENSION_SWAPS[ext] ?? []) {
    const candidate = p.slice(0, -ext.length) + swap;
    if (files.exists(candidate)) return candidate;
  }
  for (const e of APPEND_EXTENSIONS) {
    if (p && files.exists(p + e)) return p + e;
  }
  for (const index of INDEX_FILES) {
    const candidate = p ? `${p}/${index}` : index;
    if (files.exists(candidate)) return candidate;
  }
  return undefined;
}

interface PathsConfig {
  baseUrl?: string;
  paths?: { pattern: string; targets: string[] }[];
  /** Directory of the config that declared `paths`. */
  pathsDir?: string;
  /** Where `paths` targets resolve from: the effective baseUrl, else `pathsDir`. */
  pathsBase?: string;
}

const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json', 'tsconfig.app.json'];

/**
 * Reads `baseUrl` and `paths` from the nearest tsconfig/jsconfig, following
 * relative `extends`. Results are cached per directory.
 */
export class TsConfigPaths {
  private readonly byDir = new Map<string, PathsConfig | null>();
  private readonly byFile = new Map<string, PathsConfig | null>();

  constructor(private readonly files: RepoFiles) { }

  forFile(filePath: string): PathsConfig | null {
    return this.forDir(posix.dirname(filePath));
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
    const json = parsed.config as {
      extends?: string | string[];
      references?: { path?: string }[];
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    } | undefined;
    if (!json) return null;

    const dir = posix.dirname(configPath);
    let result: PathsConfig = {};
    const parents = typeof json.extends === 'string' ? [json.extends] : Array.isArray(json.extends) ? json.extends : [];
    for (const parent of parents) {
      if (depth >= 5 || typeof parent !== 'string' || !(parent.startsWith('./') || parent.startsWith('../'))) continue;
      let parentPath = posix.normalize(posix.join(dir, parent));
      if (!parentPath.endsWith('.json')) parentPath += '.json';
      const inherited = this.load(parentPath, depth + 1);
      if (inherited) result = { ...result, ...inherited };
    }

    const references = Array.isArray(json.references) ? json.references : [];
    for (const ref of references) {
      if (depth >= 5 || typeof ref?.path !== 'string') continue;
      let refPath = posix.normalize(posix.join(dir, ref.path));
      if (this.files.exists(posix.join(refPath, 'tsconfig.json'))) refPath = posix.join(refPath, 'tsconfig.json');
      else if (!refPath.endsWith('.json')) refPath += '.json';
      const referenced = this.load(refPath, depth + 1);
      if (referenced) {
        result = {
          ...result,
          ...referenced,
          paths: [...(result.paths ?? []), ...(referenced.paths ?? [])],
        };
      }
    }

    const options = json.compilerOptions ?? {};
    if (typeof options.baseUrl === 'string') {
      result.baseUrl = posix.normalize(posix.join(dir, options.baseUrl));
    }
    if (options.paths && typeof options.paths === 'object' && !Array.isArray(options.paths)) {
      const declaredPaths = Object.entries(options.paths)
        .filter(([, targets]) => Array.isArray(targets))
        .map(([pattern, targets]) => ({ pattern, targets: targets.filter((t) => typeof t === 'string') }));
      result.paths = [...(result.paths ?? []), ...declaredPaths];
      result.pathsDir = dir;
    }
    // Same rule as TypeScript: paths resolve against the effective baseUrl when there is one.
    result.pathsBase = result.baseUrl ?? result.pathsDir;
    this.byFile.set(configPath, result);
    return result;
  }
}

function matchPattern(pattern: string, specifier: string): string | undefined {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === specifier ? '' : undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (specifier.length < prefix.length + suffix.length) return undefined;
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

/** Specifiers that look like local aliases even when no config explains them. */
const ALIAS_LIKE = /^(?:[@~#$]\/|~|#|\$|@[a-zA-Z0-9_-]+\/)/;

export class ImportResolver {
  private readonly tsconfig: TsConfigPaths;
  private readonly packages: LocalPackages;

  constructor(private readonly files: RepoFiles) {
    this.tsconfig = new TsConfigPaths(files);
    this.packages = new LocalPackages(files);
  }

  resolve(fromFile: string, rawSpecifier: string): Resolution {
    // Drop query/hash suffixes (`./x.svg?raw`), but a leading `#` is a subpath alias (`#/utils`).
    const specifier = rawSpecifier.startsWith('#') ? rawSpecifier.replace(/\?.*$/, '') : rawSpecifier.replace(/[?#].*$/, '');
    if (specifier === '') return { kind: 'unresolved' };
    if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return { kind: 'external' }; // node:fs, https://, data:

    if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') {
      const found = resolveFile(posix.join(posix.dirname(fromFile), specifier), this.files);
      return found ? { kind: 'file', path: found } : { kind: 'unresolved' };
    }
    if (specifier.startsWith('/')) return { kind: 'unresolved' };

    const config = this.tsconfig.forFile(fromFile);
    if (config?.paths) {
      const matches = config.paths
        .map((entry) => ({ entry, capture: matchPattern(entry.pattern, specifier) }))
        .filter((m): m is { entry: (typeof config.paths)[number]; capture: string } => m.capture !== undefined)
        // TypeScript prefers an exact pattern, then the longest prefix before `*`.
        .sort((x, y) => prefixLength(y.entry.pattern) - prefixLength(x.entry.pattern));
      for (const { entry, capture } of matches) {
        for (const target of entry.targets) {
          const found = resolveFile(posix.join(config.pathsBase ?? '', target.replace('*', capture)), this.files);
          if (found) return { kind: 'file', path: found };
        }
      }
      if (matches.length > 0) return { kind: 'unresolved' };
    }
    if (config?.baseUrl !== undefined) {
      const found = resolveFile(posix.join(config.baseUrl, specifier), this.files);
      if (found) return { kind: 'file', path: found };
    }
    const local = this.packages.resolve(specifier);
    if (local) return local;
    return ALIAS_LIKE.test(specifier) ? { kind: 'unresolved' } : { kind: 'external' };
  }
}

function prefixLength(pattern: string): number {
  const star = pattern.indexOf('*');
  return star === -1 ? Number.MAX_SAFE_INTEGER : star;
}

interface LocalPackage {
  name: string;
  dir: string;
  json: Record<string, unknown>;
}

/**
 * Packages that live in this repository (the root package and monorepo workspaces).
 * Imports such as `my-lib/utils` or `@acme/ui` point back into the repo, so they
 * must not be treated as external, or files would look unconnected when they are not.
 */
export class LocalPackages {
  private packages?: LocalPackage[];

  constructor(private readonly files: RepoFiles & { list(): Iterable<string> }) { }

  resolve(specifier: string): Resolution | undefined {
    const pkg = this.all()
      .filter((p) => specifier === p.name || specifier.startsWith(`${p.name}/`))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (!pkg) return undefined;
    const subpath = specifier.slice(pkg.name.length + 1);
    for (const candidate of packageCandidates(pkg.json, subpath)) {
      const target = posix.join(pkg.dir, candidate);
      const sourceTarget = sourceForBuildOutput(target, pkg.dir);
      const found = resolveFile(sourceTarget, this.files) ?? resolveFile(target, this.files);
      if (found) return { kind: 'file', path: found };
    }
    return { kind: 'unresolved' };
  }

  private all(): LocalPackage[] {
    if (this.packages) return this.packages;
    this.packages = [];
    for (const file of this.files.list()) {
      if (file !== 'package.json' && !file.endsWith('/package.json')) continue;
      if (file.includes('node_modules/')) continue;
      try {
        const json = JSON.parse(this.files.read(file) ?? '') as Record<string, unknown>;
        if (typeof json.name === 'string' && json.name) this.packages.push({ name: json.name, dir: posix.dirname(file) === '.' ? '' : posix.dirname(file), json });
      } catch {
        // not valid JSON: ignore
      }
    }
    return this.packages;
  }
}

/** Paths (relative to the package) an import of `subpath` may point at, most likely first. */
function packageCandidates(json: Record<string, unknown>, subpath: string): string[] {
  const out: string[] = [];
  const exportKey = subpath ? `./${subpath}` : '.';
  const exportsField = json.exports;
  if (typeof exportsField === 'string' && !subpath) out.push(exportsField);
  else if (exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
    const map = exportsField as Record<string, unknown>;
    const isConditionsOnly = Object.keys(map).every((k) => !k.startsWith('.'));
    if (isConditionsOnly && !subpath) {
      out.push(...collectExportTargets(map));
    } else {
      out.push(...collectExportTargets(map[exportKey]));
      for (const [key, value] of Object.entries(map)) {
        const capture = key.includes('*') ? matchPattern(key, exportKey) : undefined;
        if (capture !== undefined) {
          for (const target of collectExportTargets(value)) {
            out.push(target.replace('*', capture));
          }
        }
      }
    }
  }
  if (!subpath) {
    for (const field of ['source', 'browser', 'module', 'main', 'types']) {
      if (typeof json[field] === 'string') out.push(json[field] as string);
    }
    out.push('src/index', 'index');
  } else {
    out.push(`src/${subpath}`, subpath, `lib/${subpath}`);
  }
  return [...new Set(out)];
}

/** Conditions a runtime import can match. `types` is only a fallback: runtime code never loads it. */
const RUNTIME_CONDITIONS = new Set(['browser', 'development', 'import', 'module', 'node', 'require', 'default']);

function collectExportTargets(value: unknown): string[] {
  const out: string[] = [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    for (const v of value) out.push(...collectExportTargets(v));
    return out;
  }
  if (value && typeof value === 'object') {
    const conditions = value as Record<string, unknown>;
    // `source` is a widespread convention pointing straight at the source file.
    if (typeof conditions.source === 'string') out.push(conditions.source);
    // Like Node: the first matching condition *in the object's own order* wins.
    // We collect in that order, ignoring `types` until the end.
    for (const [key, target] of Object.entries(conditions)) {
      if (!RUNTIME_CONDITIONS.has(key)) continue;
      out.push(...collectExportTargets(target));
    }
    if (typeof conditions.types === 'string') out.push(conditions.types);
  }
  return out;
}

/** Maps a published path such as `dist/esm/utils.js` back to a likely source file such as `src/utils.ts`. */
function sourceForBuildOutput(target: string, pkgDir: string): string {
  const rel = pkgDir ? target.slice(pkgDir.length + 1) : target;
  const rewritten = rel.replace(/^(?:dist|lib|build|out|esm|cjs)\/(?:(?:esm|cjs|types|es|mjs)\/)?/, 'src/').replace(/\.d\.ts$/, '.ts');
  return pkgDir ? `${pkgDir}/${rewritten}` : rewritten;
}
