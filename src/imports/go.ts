import { posix } from 'node:path';
import type { AnalysisSession, AnalysisTarget, ExtractedSpecifier, Extraction, LanguageAnalyzer, SpecifierResolution } from './analysis.js';
import type { RepoFiles } from './tree-files.js';

/**
 * Go import analysis (RA-10). Dependency-free and conservative:
 * - extraction is a bounded lexer over the `package` clause and the `import`
 *   declarations before the first other top-level declaration;
 * - an import resolves to the non-test files of a package directory inside a
 *   module visible to the importing file (its own module, its local `replace`
 *   targets, and `go.work` members); everything else is external;
 * - anything the analyzer cannot be sure of makes the file `incomplete`, which keeps
 *   its pairs `unknown` instead of `ghost`.
 * Nothing is executed: no `go` toolchain, no network.
 */

/** go.mod / go.work larger than this are not parsed (their files are reported incomplete). */
export const MAX_GO_MANIFEST_BYTES = 64 * 1024;
/** At most this many target files per Go import edge (a package's files). */
export const MAX_GO_PACKAGE_FAN_OUT = 200;
const MAX_GO_IMPORTS_PER_FILE = 10_000;

export interface GoModule {
  /** Repo-relative directory of the go.mod (`''` for the root). */
  dir: string;
  /** Declared module path; undefined when the go.mod could not be read or parsed. */
  path?: string;
  /** Why the go.mod is unusable: its files are analyzed as incomplete. */
  broken?: string;
  /** Local `replace` directives: replaced module path → module directory inside the repo. */
  replaces: Map<string, GoModule>;
}

export interface GoIndex {
  files: RepoFiles;
  moduleByDir: Map<string, GoModule>;
  /** Unique module paths → module. Duplicated paths are left out (no local mapping). */
  moduleByPath: Map<string, GoModule>;
  duplicatePaths: Set<string>;
  /** Every module path declared in the repo (duplicates included), longest first. */
  allModulePaths: string[];
  /** Modules listed by the root `go.work` `use` directives. */
  workMembers: Set<GoModule>;
  /** Regular `.go` files by directory, sorted. */
  goFilesByDir: Map<string, string[]>;
  packageNames: Map<string, string | null>;
  visibleCache: Map<GoModule, [string, GoModule][]>;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Lexer

export interface GoImportSpec {
  path: string;
  /** Alias: an identifier, `_` or `.`. */
  name?: string;
}

export interface GoExtraction {
  packageName?: string;
  imports: GoImportSpec[];
  /** Set when the header could not be parsed: the file is incomplete. */
  error?: string;
}

const IDENT = /[\p{L}_][\p{L}\p{N}_]*/uy;
const SIMPLE_ESCAPES: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"' };

class GoLexer {
  pos = 0;
  constructor(private readonly text: string) {}

  get eof(): boolean {
    return this.pos >= this.text.length;
  }

  peek(): string {
    return this.text[this.pos] ?? '';
  }

  /** Skips whitespace, `//` line comments and `/* *\/` block comments. Returns an error for an unterminated block comment. */
  skip(): string | undefined {
    const text = this.text;
    while (this.pos < text.length) {
      const ch = text[this.pos]!;
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '﻿') {
        this.pos++;
      } else if (ch === '/' && text[this.pos + 1] === '/') {
        const end = text.indexOf('\n', this.pos + 2);
        this.pos = end === -1 ? text.length : end + 1;
      } else if (ch === '/' && text[this.pos + 1] === '*') {
        const end = text.indexOf('*/', this.pos + 2);
        if (end === -1) return 'unterminated block comment';
        this.pos = end + 2;
      } else {
        break;
      }
    }
    return undefined;
  }

  ident(): string | undefined {
    IDENT.lastIndex = this.pos;
    const match = IDENT.exec(this.text);
    if (!match) return undefined;
    this.pos += match[0].length;
    return match[0];
  }

  peekIdent(): string | undefined {
    const start = this.pos;
    const word = this.ident();
    this.pos = start;
    return word;
  }

  /** An interpreted ("…", with escapes) or raw (`…`) string literal. */
  string(): { value?: string; error?: string } {
    const text = this.text;
    const quote = text[this.pos];
    if (quote === '`') {
      const end = text.indexOf('`', this.pos + 1);
      if (end === -1) return { error: 'unterminated raw string' };
      const value = text.slice(this.pos + 1, end).replace(/\r/g, '');
      this.pos = end + 1;
      return { value };
    }
    if (quote !== '"') return { error: 'expected an import path string' };
    let value = '';
    let i = this.pos + 1;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === '"') {
        this.pos = i + 1;
        return { value };
      }
      if (ch === '\n') return { error: 'newline in string' };
      if (ch !== '\\') {
        value += ch;
        i++;
        continue;
      }
      const next = text[i + 1] ?? '';
      if (next in SIMPLE_ESCAPES) {
        value += SIMPLE_ESCAPES[next];
        i += 2;
      } else if (next === 'x' || next === 'u' || next === 'U') {
        const width = next === 'x' ? 2 : next === 'u' ? 4 : 8;
        const hex = text.slice(i + 2, i + 2 + width);
        if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) return { error: 'invalid escape in string' };
        const code = Number.parseInt(hex, 16);
        if (code > 0x10ffff) return { error: 'invalid escape in string' };
        value += String.fromCodePoint(code);
        i += 2 + width;
      } else if (/[0-7]/.test(next)) {
        const oct = text.slice(i + 1, i + 4);
        if (!/^[0-7]{3}$/.test(oct)) return { error: 'invalid escape in string' };
        value += String.fromCharCode(Number.parseInt(oct, 8));
        i += 4;
      } else {
        return { error: 'invalid escape in string' };
      }
    }
    return { error: 'unterminated string' };
  }
}

/**
 * Reads a Go file's `package` clause and its import declarations (single, grouped,
 * aliased with an identifier, `_` or `.`, and several `import` blocks). Stops at the
 * first other top-level declaration, so `import "x"` in later code, comments or raw
 * strings is never read as an import.
 */
export function extractGoImports(text: string): GoExtraction {
  const lexer = new GoLexer(text);
  const imports: GoImportSpec[] = [];
  const fail = (error: string, packageName?: string): GoExtraction => ({ ...(packageName ? { packageName } : {}), imports, error });

  let error = lexer.skip();
  if (error) return fail(error);
  if (lexer.ident() !== 'package') return fail('missing package clause');
  error = lexer.skip();
  if (error) return fail(error);
  const packageName = lexer.ident();
  if (!packageName) return fail('missing package name');

  const spec = (): string | undefined => {
    const skipError = lexer.skip();
    if (skipError) return skipError;
    let name: string | undefined;
    if (lexer.peek() === '.') {
      name = '.';
      lexer.pos++;
    } else {
      name = lexer.ident();
    }
    if (name !== undefined) {
      const afterName = lexer.skip();
      if (afterName) return afterName;
    }
    const literal = lexer.string();
    if (literal.error !== undefined || literal.value === undefined) return `malformed import declaration (${literal.error ?? 'missing path'})`;
    if (imports.length >= MAX_GO_IMPORTS_PER_FILE) return 'too many imports';
    imports.push({ path: literal.value, ...(name !== undefined ? { name } : {}) });
    return undefined;
  };

  for (;;) {
    error = lexer.skip();
    if (error) return fail(error, packageName);
    if (lexer.eof) break;
    if (lexer.peek() === ';') {
      lexer.pos++;
      continue;
    }
    if (lexer.peekIdent() !== 'import') break;
    lexer.ident();
    error = lexer.skip();
    if (error) return fail(error, packageName);
    if (lexer.peek() !== '(') {
      error = spec();
      if (error) return fail(error, packageName);
      continue;
    }
    lexer.pos++;
    for (;;) {
      error = lexer.skip();
      if (error) return fail(error, packageName);
      if (lexer.eof) return fail('unterminated import block', packageName);
      const ch = lexer.peek();
      if (ch === ')') {
        lexer.pos++;
        break;
      }
      if (ch === ';') {
        lexer.pos++;
        continue;
      }
      error = spec();
      if (error) return fail(error, packageName);
    }
  }
  return { packageName, imports };
}

// ---------------------------------------------------------------------------
// go.mod / go.work

export interface GoModFile {
  module?: string;
  replaces: { from: string; to: string }[];
  uses: string[];
  error?: string;
}

function unquote(token: string): string | undefined {
  if (token.startsWith('"')) {
    try {
      const value: unknown = JSON.parse(token);
      return typeof value === 'string' ? value : undefined;
    } catch {
      return undefined;
    }
  }
  if (token.startsWith('`')) return token.endsWith('`') && token.length >= 2 ? token.slice(1, -1) : undefined;
  return token;
}

function tokenizeModLine(line: string): string[] | undefined {
  const tokens: string[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
    } else if (ch === '/' && line[i + 1] === '/') {
      break;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') j += line[j] === '\\' ? 2 : 1;
      if (j >= line.length) return undefined;
      tokens.push(line.slice(i, j + 1));
      i = j + 1;
    } else if (ch === '`') {
      const j = line.indexOf('`', i + 1);
      if (j === -1) return undefined;
      tokens.push(line.slice(i, j + 1));
      i = j + 1;
    } else if (ch === '(' || ch === ')') {
      tokens.push(ch);
      i++;
    } else if (ch === '=' && line[i + 1] === '>') {
      tokens.push('=>');
      i += 2;
    } else {
      let j = i;
      while (j < line.length && !/[\s()"`]/.test(line[j]!) && !(line[j] === '=' && line[j + 1] === '>') && !(line[j] === '/' && line[j + 1] === '/')) j++;
      tokens.push(line.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

/** Parses the `module`, `replace` and `use` directives of a go.mod or go.work (line-oriented, `//` comments, blocks). */
export function parseGoModFile(text: string): GoModFile {
  const result: GoModFile = { replaces: [], uses: [] };
  let block: string | undefined;
  const lines = text.split('\n');
  for (let n = 0; n < lines.length; n++) {
    const tokens = tokenizeModLine(lines[n]!);
    if (!tokens) return { ...result, error: `unterminated string on line ${n + 1}` };
    if (tokens.length === 0) continue;
    let directive: string;
    let args: string[];
    if (block !== undefined) {
      if (tokens[0] === ')') {
        block = undefined;
        continue;
      }
      directive = block;
      args = tokens;
    } else {
      directive = tokens[0]!;
      args = tokens.slice(1);
      if (args[0] === '(') {
        if (args.length > 1) return { ...result, error: `unexpected tokens after "(" on line ${n + 1}` };
        block = directive;
        continue;
      }
    }
    if (directive === 'module') {
      const value = args[0] !== undefined ? unquote(args[0]) : undefined;
      if (!value || args.length !== 1) return { ...result, error: `malformed module directive on line ${n + 1}` };
      if (result.module !== undefined) return { ...result, error: 'repeated module directive' };
      result.module = value;
    } else if (directive === 'replace') {
      const arrow = args.indexOf('=>');
      if (arrow < 1 || arrow > 2 || args.length - arrow - 1 < 1 || args.length - arrow - 1 > 2) {
        return { ...result, error: `malformed replace directive on line ${n + 1}` };
      }
      const from = unquote(args[0]!);
      const to = unquote(args[arrow + 1]!);
      if (!from || !to) return { ...result, error: `malformed replace directive on line ${n + 1}` };
      result.replaces.push({ from, to });
    } else if (directive === 'use') {
      const value = args[0] !== undefined ? unquote(args[0]) : undefined;
      if (!value || args.length !== 1) return { ...result, error: `malformed use directive on line ${n + 1}` };
      result.uses.push(value);
    }
  }
  if (block !== undefined) return { ...result, error: `unterminated ${block} block` };
  return result;
}

/** A replace/use target relative to `baseDir`, or undefined when it leaves the repository or is not a local path. */
function localDir(baseDir: string, target: string): string | undefined {
  const t = target.replace(/\\/g, '/');
  if (!(t === '.' || t === '..' || t.startsWith('./') || t.startsWith('../'))) return undefined;
  const joined = posix.normalize(baseDir ? posix.join(baseDir, t) : t).replace(/\/$/, '');
  if (joined === '..' || joined.startsWith('../') || posix.isAbsolute(joined)) return undefined;
  return joined === '.' ? '' : joined;
}

function isLocalPathTarget(target: string): boolean {
  return /^(?:\.{1,2}(?:[\\/]|$)|[\\/]|[A-Za-z]:[\\/])/.test(target);
}

function readManifest(files: RepoFiles, path: string): { text?: string; error?: string } {
  const text = files.read(path);
  if (text === undefined) return { error: 'unreadable' };
  if (Buffer.byteLength(text) > MAX_GO_MANIFEST_BYTES) return { error: `larger than ${MAX_GO_MANIFEST_BYTES / 1024} KiB` };
  return { text };
}

const dirOf = (path: string): string => {
  const dir = posix.dirname(path);
  return dir === '.' ? '' : dir;
};

export function buildGoIndex(files: RepoFiles): GoIndex {
  const index: GoIndex = {
    files,
    moduleByDir: new Map(),
    moduleByPath: new Map(),
    duplicatePaths: new Set(),
    allModulePaths: [],
    workMembers: new Set(),
    goFilesByDir: new Map(),
    packageNames: new Map(),
    visibleCache: new Map(),
    warnings: [],
  };
  const all = [...files.list()].sort();
  const modFiles: string[] = [];
  for (const path of all) {
    const base = posix.basename(path);
    if (base === 'go.mod') modFiles.push(path);
    else if (path.endsWith('.go')) {
      const dir = dirOf(path);
      let list = index.goFilesByDir.get(dir);
      if (!list) index.goFilesByDir.set(dir, (list = []));
      list.push(path);
    }
  }

  const parsed = new Map<GoModule, GoModFile>();
  const pathOwners = new Map<string, GoModule[]>();
  for (const modFile of modFiles) {
    const module: GoModule = { dir: dirOf(modFile), replaces: new Map() };
    index.moduleByDir.set(module.dir, module);
    // Symlinked or escaping manifests are not trusted.
    if (!files.exists(modFile)) {
      module.broken = `${modFile} is not a regular file in the repository`;
      index.warnings.push(`Go: ${modFile} is not a regular file in the repository; its packages are reported as incomplete.`);
      continue;
    }
    const manifest = readManifest(files, modFile);
    if (manifest.text === undefined) {
      module.broken = `${modFile} is ${manifest.error}`;
      index.warnings.push(`Go: ${modFile} is ${manifest.error}, so it was not read; its packages are reported as incomplete.`);
      continue;
    }
    const mod = parseGoModFile(manifest.text);
    if (mod.error !== undefined || mod.module === undefined) {
      module.broken = `${modFile} could not be parsed`;
      index.warnings.push(`Go: ${modFile} could not be parsed (${mod.error ?? 'no module directive'}); its packages are reported as incomplete.`);
      continue;
    }
    module.path = mod.module;
    parsed.set(module, mod);
    const owners = pathOwners.get(mod.module) ?? [];
    owners.push(module);
    pathOwners.set(mod.module, owners);
  }
  for (const [path, owners] of [...pathOwners].sort(([a], [b]) => a.localeCompare(b))) {
    index.allModulePaths.push(path);
    if (owners.length === 1) {
      index.moduleByPath.set(path, owners[0]!);
    } else {
      index.duplicatePaths.add(path);
      const dirs = owners.map((owner) => (owner.dir === '' ? '.' : owner.dir)).join(', ');
      index.warnings.push(`Go: module path ${path} is declared by more than one go.mod (${dirs}); imports of it are not mapped to local files.`);
    }
  }
  index.allModulePaths.sort((a, b) => b.length - a.length || a.localeCompare(b));

  for (const [module, mod] of parsed) {
    const modFile = module.dir ? `${module.dir}/go.mod` : 'go.mod';
    for (const { from, to } of mod.replaces) {
      if (!isLocalPathTarget(to)) continue; // a versioned replacement: still a dependency
      const dir = localDir(module.dir, to);
      const target = dir !== undefined ? index.moduleByDir.get(dir) : undefined;
      if (dir === undefined) {
        index.warnings.push(`Go: ${modFile} replaces ${from} with ${to}, which is outside the repository; it gets no local mapping.`);
      } else if (!target || target.broken) {
        index.warnings.push(`Go: ${modFile} replaces ${from} with ${to}, which has no usable go.mod in the repository; it gets no local mapping.`);
      } else {
        module.replaces.set(from, target);
      }
    }
  }

  if (all.includes('go.work')) {
    const manifest = files.exists('go.work') ? readManifest(files, 'go.work') : { error: 'not a regular file in the repository' };
    if (manifest.text === undefined) {
      index.warnings.push(`Go: go.work is ${manifest.error}, so it was not read.`);
    } else {
      const work = parseGoModFile(manifest.text);
      if (work.error !== undefined) {
        index.warnings.push(`Go: go.work could not be parsed (${work.error}); its use directives were ignored.`);
      } else {
        for (const use of work.uses) {
          const dir = localDir('', use.startsWith('.') ? use : `./${use}`);
          const member = dir !== undefined ? index.moduleByDir.get(dir) : undefined;
          if (!member || member.broken) {
            index.warnings.push(`Go: go.work uses ${use}, which has no usable go.mod in the repository.`);
          } else {
            index.workMembers.add(member);
          }
        }
      }
    }
  }
  return index;
}

/** The go.mod that owns a directory: the nearest one at or above it. */
export function nearestGoModule(index: GoIndex, dir: string): GoModule | undefined {
  let current = dir;
  for (;;) {
    const module = index.moduleByDir.get(current);
    if (module) return module;
    if (current === '') return undefined;
    current = dirOf(current);
  }
}

/** Module paths an importing module can resolve locally, longest first. */
function visibleModules(index: GoIndex, module: GoModule): [string, GoModule][] {
  const cached = index.visibleCache.get(module);
  if (cached) return cached;
  const map = new Map<string, GoModule>();
  if (index.workMembers.has(module)) {
    for (const member of [...index.workMembers]) {
      if (member.path && !index.duplicatePaths.has(member.path)) map.set(member.path, member);
    }
  }
  if (module.path && !index.duplicatePaths.has(module.path)) map.set(module.path, module);
  // A module's own replace directives win over go.work for the paths they name.
  for (const [from, target] of module.replaces) map.set(from, target);
  const visible = [...map].sort(([a], [b]) => b.length - a.length || a.localeCompare(b));
  index.visibleCache.set(module, visible);
  return visible;
}

/** Complete-segment prefix match: `example.com/app` matches `example.com/app/x`, never `example.com/application`. */
export function goPathWithin(importPath: string, modulePath: string): boolean {
  return importPath === modulePath || importPath.startsWith(`${modulePath}/`);
}

function packageNameOf(index: GoIndex, path: string): string | null {
  const cached = index.packageNames.get(path);
  if (cached !== undefined) return cached;
  const text = index.files.read(path);
  const name = text === undefined ? null : (extractGoImports(text).packageName ?? null);
  index.packageNames.set(path, name);
  return name;
}

/**
 * The files of the package in `dir`: regular, non-test `.go` files directly in it.
 * Files with a minority `package` clause (a `//go:build ignore` generator in
 * `package main`, say) are excluded. Build constraints are not evaluated: every
 * file is included (a conservative union).
 */
export function goPackageFiles(index: GoIndex, dir: string): string[] {
  const candidates = (index.goFilesByDir.get(dir) ?? []).filter((path) => !path.endsWith('_test.go') && index.files.exists(path));
  if (candidates.length <= 1) return candidates;
  const counts = new Map<string, number>();
  for (const path of candidates) {
    const name = packageNameOf(index, path);
    if (name !== null) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (counts.size <= 1) return candidates;
  const dirName = posix.basename(dir);
  const [main] = [...counts].sort(
    ([a, x], [b, y]) => y - x || Number(b === dirName) - Number(a === dirName) || a.localeCompare(b),
  )[0]!;
  // Unreadable files stay in: dropping a real package file could turn its pair into a false ghost.
  return candidates.filter((path) => {
    const name = packageNameOf(index, path);
    return name === null || name === main;
  });
}

function resolveGoImport(from: string, importPath: string, index: GoIndex): SpecifierResolution {
  if (importPath === 'C') return { kind: 'external' }; // cgo
  const fromModule = nearestGoModule(index, dirOf(from));
  if (importPath === '' || /(?:^|\/)\.{1,2}(?:\/|$)|\\|^\/|\/\/|\/$/.test(importPath)) {
    return { kind: 'unresolved', reasonCode: 'invalid-target' };
  }
  if (!fromModule) return { kind: 'unresolved', reasonCode: 'unsupported-config' };
  if (fromModule.broken) return { kind: 'unresolved', reasonCode: 'unsupported-config' };

  for (const [modulePath, module] of visibleModules(index, fromModule)) {
    if (!goPathWithin(importPath, modulePath)) continue;
    const remainder = importPath.slice(modulePath.length).replace(/^\//, '');
    const dir = remainder ? (module.dir ? `${module.dir}/${remainder}` : remainder) : module.dir;
    const owner = nearestGoModule(index, dir);
    if (owner !== module) {
      // The directory belongs to a nested module: a versioned dependency, unless that module is visible too.
      return {
        kind: 'external',
        warning: `Go: imports in-repo module ${owner?.path ?? dir} without a local replace/go.work (resolved as an external dependency).`,
      };
    }
    const packageFiles = goPackageFiles(index, dir);
    if (packageFiles.length === 0) return { kind: 'unresolved', reasonCode: 'target-missing' };
    const targets: AnalysisTarget[] = packageFiles.slice(0, MAX_GO_PACKAGE_FAN_OUT).map((path) => ({ path, via: 'go-package' }));
    if (packageFiles.length > MAX_GO_PACKAGE_FAN_OUT) {
      return {
        kind: 'files',
        targets,
        incompleteReason: `Go package ${importPath} has more than ${MAX_GO_PACKAGE_FAN_OUT} files`,
        warning: `Go: package ${importPath} has ${packageFiles.length} files; import edges list the first ${MAX_GO_PACKAGE_FAN_OUT} and importers are reported as incomplete.`,
      };
    }
    return { kind: 'files', targets };
  }

  for (const duplicate of index.duplicatePaths) {
    if (goPathWithin(importPath, duplicate)) return { kind: 'unresolved', reasonCode: 'ambiguous-package' };
  }
  for (const modulePath of index.allModulePaths) {
    if (goPathWithin(importPath, modulePath)) {
      return {
        kind: 'external',
        warning: `Go: imports in-repo module ${modulePath} without a local replace/go.work (resolved as an external dependency).`,
      };
    }
  }
  return { kind: 'external' };
}

export const goAnalyzer: LanguageAnalyzer<GoIndex> = {
  id: 'go',
  matches: (path) => path.endsWith('.go'),
  language: () => 'go',
  budgeted: true,
  index: buildGoIndex,
  indexWarnings: (index) => index.warnings,
  extract(text, path, index): Extraction {
    const parsed = extractGoImports(text);
    if (parsed.packageName !== undefined) index.packageNames.set(path, parsed.packageName);
    const imports: ExtractedSpecifier[] = parsed.imports.map(({ path: specifier }) => ({ specifier, kind: 'static' }));
    const module = nearestGoModule(index, dirOf(path));
    const incompleteReason =
      parsed.error !== undefined
        ? `Go import declarations could not be parsed: ${parsed.error}`
        : !module
          ? 'Go file outside any go.mod module'
          : module.broken
            ? `Go module manifest unusable: ${module.broken}`
            : undefined;
    return { imports, dynamicLoads: 0, ...(incompleteReason ? { incompleteReason } : {}) };
  },
  resolve(from, item, index, _session: AnalysisSession) {
    return resolveGoImport(from, item.specifier, index);
  },
};

/** Two non-test Go files in one directory are one package: they share scope without importing each other. */
export function isSameGoPackage(a: string, b: string): boolean {
  return a.endsWith('.go') && b.endsWith('.go') && !a.endsWith('_test.go') && !b.endsWith('_test.go') && dirOf(a) === dirOf(b);
}
