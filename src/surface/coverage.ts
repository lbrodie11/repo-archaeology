import { posix } from 'node:path';
import type { RepoFiles } from '../imports/tree-files.js';
import { typescript } from '../imports/typescript.js';
import type { CompilerCoverage } from './types.js';

/**
 * Compiler coverage by syntactic reading of every `tsconfig*.json` / `jsconfig.json`:
 * `include`, `exclude`, `files`, `references`, relative `extends`, `allowJs`, `checkJs`.
 * Nothing is compiled; TypeScript is used only to read JSONC.
 */

const CONFIG_FILE = /(?:^|\/)(?:tsconfig[^/]*\.json|jsconfig\.json)$/i;
const TS_EXTENSIONS = /\.(?:d\.[cm]?ts|[cm]?tsx?)$/i;
const JS_EXTENSIONS = /\.(?:[cm]?jsx?)$/i;
const MAX_EXTENDS_DEPTH = 5;

interface RawConfig {
  extends?: unknown;
  files?: unknown;
  include?: unknown;
  exclude?: unknown;
  references?: unknown;
  compilerOptions?: { allowJs?: unknown; checkJs?: unknown; outDir?: unknown };
}

/** A pattern list together with the directory it is relative to (TypeScript resolves inherited lists from the base config). */
interface PatternList {
  dir: string;
  patterns: string[];
}

interface ResolvedConfig {
  path: string;
  dir: string;
  malformed: boolean;
  /** A non-relative or unreadable `extends`: inherited values are unknown. */
  partial: boolean;
  files?: PatternList;
  include?: PatternList;
  exclude?: PatternList;
  allowJs?: boolean;
  checkJs?: boolean;
  outDir?: string;
  references: string[];
}

export interface CoverageResult {
  coverage: CompilerCoverage;
  reason: string;
}

export class CompilerCoverageIndex {
  private readonly configs: ResolvedConfig[];
  private readonly byPath = new Map<string, ResolvedConfig>();
  private readonly includeCache = new Map<string, 'yes' | 'no' | 'unknown'>();

  constructor(private readonly files: RepoFiles) {
    const paths = [...files.list()].filter((p) => CONFIG_FILE.test(p) && !/(?:^|\/)node_modules\//.test(p)).sort();
    this.configs = paths.map((p) => this.load(p, 0, new Set()));
    for (const config of this.configs) this.byPath.set(config.path, config);
  }

  coverage(consumer: string, changedFile: string): CoverageResult {
    const consumerIsJs = JS_EXTENSIONS.test(consumer) && !TS_EXTENSIONS.test(consumer);
    let uncertain: string | undefined;
    let includedSomewhere = false;
    let jsUnchecked = false;
    for (const config of this.configs) {
      const includesConsumer = this.includes(config, consumer);
      if (includesConsumer === 'unknown') {
        uncertain ??= `${config.path} could not be read`;
        continue;
      }
      if (includesConsumer === 'no') continue;
      includedSomewhere = true;
      if (consumerIsJs) {
        const checked = config.checkJs ?? (config.partial ? undefined : false);
        if (checked === undefined && !this.hasTsCheck(consumer)) {
          uncertain ??= `checkJs in ${config.path} comes from an unreadable extends`;
          continue;
        }
        if (!checked && !this.hasTsCheck(consumer)) {
          jsUnchecked = true;
          continue;
        }
      }
      const withChanged = this.includesTransitively(config, changedFile, new Set());
      if (withChanged === 'yes') return { coverage: 'typechecked', reason: config.path };
      if (withChanged === 'unknown') uncertain ??= `${config.path} may not include ${changedFile}`;
    }
    if (uncertain) return { coverage: 'unknown', reason: uncertain };
    if (!includedSomewhere) return { coverage: 'not-typechecked', reason: 'outside every tsconfig' };
    if (jsUnchecked) return { coverage: 'not-typechecked', reason: 'JavaScript without checkJs' };
    return { coverage: 'not-typechecked', reason: 'not checked together with the changed file' };
  }

  private tsCheck = new Map<string, boolean>();

  private hasTsCheck(path: string): boolean {
    let cached = this.tsCheck.get(path);
    if (cached === undefined) {
      const text = this.files.read(path) ?? '';
      cached = /^\s*\/\/\s*@ts-check\b/m.test(text.slice(0, 4096)) && !/^\s*\/\/\s*@ts-nocheck\b/m.test(text.slice(0, 4096));
      this.tsCheck.set(path, cached);
    }
    return cached;
  }

  private includesTransitively(config: ResolvedConfig, file: string, seen: Set<string>): 'yes' | 'no' | 'unknown' {
    if (seen.has(config.path)) return 'no';
    seen.add(config.path);
    let result: 'yes' | 'no' | 'unknown' = this.includes(config, file);
    if (result === 'yes') return 'yes';
    for (const reference of config.references) {
      const target = this.byPath.get(reference) ?? (this.files.exists(reference) ? this.load(reference, 0, new Set()) : undefined);
      if (!target) continue;
      const sub = this.includesTransitively(target, file, seen);
      if (sub === 'yes') return 'yes';
      if (sub === 'unknown') result = 'unknown';
    }
    return result;
  }

  /** Whether the program of `config` contains `file` by its own `files`/`include`/`exclude`. */
  includes(config: ResolvedConfig, file: string): 'yes' | 'no' | 'unknown' {
    const key = `${config.path}\0${file}`;
    const cached = this.includeCache.get(key);
    if (cached) return cached;
    const result = this.computeIncludes(config, file);
    this.includeCache.set(key, result);
    return result;
  }

  private computeIncludes(config: ResolvedConfig, file: string): 'yes' | 'no' | 'unknown' {
    const scope = config.dir === '' ? true : file.startsWith(`${config.dir}/`);
    if (config.malformed) return scope ? 'unknown' : 'no';
    const isTs = TS_EXTENSIONS.test(file);
    const isJs = !isTs && JS_EXTENSIONS.test(file);
    if (!isTs && !isJs) return 'no';
    if (config.files?.patterns.some((p) => normalizeRelative(config.files!.dir, p) === file)) {
      return isJs && config.allowJs === undefined && config.partial ? 'unknown' : isJs && !config.allowJs ? 'no' : 'yes';
    }
    let include = config.include;
    if (!include && !config.files) {
      if (config.partial) return scope ? 'unknown' : 'no';
      include = { dir: config.dir, patterns: ['**/*'] };
    }
    if (!include) return 'no';
    if (!include.patterns.some((p) => patternRegExp(include.dir, p, 'include')?.test(file))) return 'no';
    const exclude = config.exclude ?? {
      dir: config.dir,
      patterns: ['node_modules', 'bower_components', 'jspm_packages', ...(config.outDir ? [config.outDir] : [])],
    };
    if (exclude.patterns.some((p) => patternRegExp(exclude.dir, p, 'exclude')?.test(file))) return 'no';
    if (isJs) {
      if (config.allowJs === undefined) return config.partial ? 'unknown' : 'no';
      if (!config.allowJs) return 'no';
    }
    return 'yes';
  }

  private load(path: string, depth: number, seen: Set<string>): ResolvedConfig {
    const dir = repoDir(path);
    const empty: ResolvedConfig = { path, dir, malformed: true, partial: false, references: [] };
    if (seen.has(path)) return { ...empty, malformed: false, partial: true };
    seen.add(path);
    const text = this.files.read(path);
    if (text === undefined) return empty;
    const parsed = typescript().parseConfigFileTextToJson(path, text);
    const raw = parsed.config as RawConfig | undefined;
    if (parsed.error || !raw || typeof raw !== 'object') return empty;

    let result: ResolvedConfig = { path, dir, malformed: false, partial: false, references: [] };
    const parents = typeof raw.extends === 'string' ? [raw.extends] : Array.isArray(raw.extends) ? raw.extends : [];
    for (const parent of parents) {
      if (typeof parent !== 'string') continue;
      if (depth >= MAX_EXTENDS_DEPTH || !(parent.startsWith('./') || parent.startsWith('../'))) {
        result.partial = true;
        continue;
      }
      let parentPath = normalizeRelative(dir, parent);
      if (!this.files.exists(parentPath) && !parentPath.endsWith('.json')) parentPath = `${parentPath}.json`;
      if (!this.files.exists(parentPath)) {
        result.partial = true;
        continue;
      }
      const inherited = this.load(parentPath, depth + 1, seen);
      if (inherited.malformed) {
        result.partial = true;
        continue;
      }
      result = {
        ...result,
        partial: result.partial || inherited.partial,
        files: inherited.files ?? result.files,
        include: inherited.include ?? result.include,
        exclude: inherited.exclude ?? result.exclude,
        allowJs: inherited.allowJs ?? result.allowJs,
        checkJs: inherited.checkJs ?? result.checkJs,
        outDir: inherited.outDir ?? result.outDir,
      };
    }
    const list = (value: unknown): PatternList | undefined =>
      Array.isArray(value) ? { dir, patterns: value.filter((v): v is string => typeof v === 'string') } : undefined;
    result.files = list(raw.files) ?? result.files;
    result.include = list(raw.include) ?? result.include;
    result.exclude = list(raw.exclude) ?? result.exclude;
    const options = raw.compilerOptions ?? {};
    if (typeof options.allowJs === 'boolean') result.allowJs = options.allowJs;
    if (typeof options.checkJs === 'boolean') result.checkJs = options.checkJs;
    if (typeof options.outDir === 'string') result.outDir = posix.relative(dir || '.', normalizeRelative(dir, options.outDir)) || '.';
    // `checkJs` implies `allowJs` (TypeScript 5+).
    if (result.checkJs === true && result.allowJs === undefined) result.allowJs = true;
    result.references = [];
    if (Array.isArray(raw.references)) {
      for (const reference of raw.references as { path?: unknown }[]) {
        if (typeof reference?.path !== 'string') continue;
        const target = normalizeRelative(dir, reference.path);
        result.references.push(target.endsWith('.json') ? target : `${target}/tsconfig.json`);
      }
    }
    return result;
  }
}

function repoDir(path: string): string {
  const dir = posix.dirname(path);
  return dir === '.' ? '' : dir;
}

function normalizeRelative(dir: string, relative: string): string {
  const joined = posix.normalize(dir ? posix.join(dir, relative) : relative);
  return joined === '.' ? '' : joined.replace(/\/$/, '');
}

const regexpCache = new Map<string, RegExp | undefined>();

/** TypeScript's include/exclude wildcard rules, as a regexp over repo-relative paths. */
export function patternRegExp(dir: string, pattern: string, usage: 'include' | 'exclude'): RegExp | undefined {
  const key = `${usage}\0${dir}\0${pattern}`;
  if (regexpCache.has(key)) return regexpCache.get(key);
  let full = normalizeRelative(dir, pattern);
  let result: RegExp | undefined;
  if (full === '..' || full.startsWith('../')) {
    result = undefined;
  } else {
    const last = full.split('/').pop() ?? '';
    const isDirectory = full === '' || !/[.*?]/.test(last);
    if (usage === 'include' && isDirectory) full = full === '' ? '**/*' : `${full}/**/*`;
    let re = '';
    for (let i = 0; i < full.length; i++) {
      const c = full[i]!;
      if (c === '*' && full[i + 1] === '*' && (i === 0 || full[i - 1] === '/') && (full[i + 2] === '/' || i + 2 === full.length)) {
        re += full[i + 2] === '/' ? '(?:[^/]+/)*' : '.*';
        i += full[i + 2] === '/' ? 2 : 1;
      } else if (c === '*') {
        re += '[^/]*';
      } else if (c === '?') {
        re += '[^/]';
      } else {
        re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      }
    }
    // An exclude pattern also excludes everything below a matching directory.
    result = new RegExp(usage === 'exclude' ? `^${re}(?:/.*)?$` : `^${re}$`);
  }
  regexpCache.set(key, result);
  return result;
}
