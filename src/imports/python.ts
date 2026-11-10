import { posix } from 'node:path';
import type { AnalysisSession, AnalysisTarget, ExtractedSpecifier, Extraction, LanguageAnalyzer, SpecifierResolution } from './analysis.js';
import { isTomlTable, parseTomlSubset, TomlSubsetError, tomlGet, type TomlTable, type TomlValue } from './toml.js';
import type { RepoFiles } from './tree-files.js';

/**
 * Python import analysis (RA-10). Dependency-free and conservative:
 * - extraction is a bounded lexer (strings with prefixes and f-string nesting,
 *   comments, continuations, bracket depth, `;`) that reads `import` / `from … import`
 *   at any statement start, plus literal `importlib.import_module("…")` / `__import__("…")`;
 * - absolute imports resolve by elimination against the local namespace of the
 *   known source roots: a top-level name in exactly one root resolves there, in
 *   several roots is `ambiguous-package`, and in none is external;
 * - anything unsure makes the file `incomplete`, which keeps its pairs `unknown`.
 * Nothing is executed (`setup.py` is never run) and nothing is fetched.
 */

export const MAX_PYTHON_MANIFEST_BYTES = 64 * 1024;
const MAX_PYTHON_IMPORTS_PER_FILE = 10_000;
const MAX_PYPROJECTS = 500;

// ---------------------------------------------------------------------------
// Lexer

type TokenType = 'name' | 'string' | 'op' | 'newline' | 'number';

interface Token {
  type: TokenType;
  value: string;
  /** First token of a statement (after a newline, `;` or a top-level `:`). */
  start: boolean;
  /** Strings: an f-string/t-string or bytes literal (never a module name). */
  special?: boolean;
  /** Strings: the literal's text when it has no escapes, else undefined. */
  literal?: string;
}

export interface PythonImport {
  specifier: string;
  kind: 'static' | 'dynamic';
  /** `from <specifier> import <names>`. */
  names?: string[];
}

export interface PythonExtraction {
  imports: PythonImport[];
  dynamicLoads: number;
  error?: string;
}

const STRING_PREFIX = /^(?:[rRuUbBfFtT]|[rR][bBfFtT]|[bBfFtT][rR])$/;
const IDENT_START = /[\p{L}_]/u;
const IDENT_CHAR = /[\p{L}\p{N}_]/u;

class PythonLexError extends Error {}

/** Tokenizes Python source just far enough to find import statements. Throws `PythonLexError`. */
export function tokenizePython(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let depth = 0;
  let start = true;
  const push = (token: Omit<Token, 'start'>) => {
    tokens.push({ ...token, start });
    start = token.type === 'newline' || (token.type === 'op' && (token.value === ';' || (token.value === ':' && depth === 0)));
  };

  /** Scans a string literal starting at the opening quote; returns the index after it. */
  const scanString = (at: number, prefix: string): { end: number; literal?: string } => {
    const quote = text[at]!;
    const triple = text.startsWith(quote.repeat(3), at);
    const formatted = /[fFtT]/.test(prefix);
    let j = at + (triple ? 3 : 1);
    const contentStart = j;
    let escaped = false;
    for (;;) {
      if (j >= text.length) throw new PythonLexError(triple ? 'unterminated triple-quoted string' : 'unterminated string');
      const ch = text[j]!;
      if (triple ? text.startsWith(quote.repeat(3), j) : ch === quote) {
        const end = j + (triple ? 3 : 1);
        return { end, ...(!escaped && !formatted ? { literal: text.slice(contentStart, j) } : {}) };
      }
      if (!triple && ch === '\n') throw new PythonLexError('unterminated string');
      if (ch === '\\') {
        escaped = true;
        j += 2;
        continue;
      }
      if (formatted && ch === '{') {
        if (text[j + 1] === '{') {
          j += 2;
          continue;
        }
        j = scanReplacementField(j + 1, triple);
        continue;
      }
      j++;
    }
  };

  /** Scans an f-string `{…}` expression (nested brackets and strings); returns the index after its `}`. */
  const scanReplacementField = (at: number, multiline: boolean): number => {
    let j = at;
    let nested = 0;
    for (;;) {
      if (j >= text.length) throw new PythonLexError('unterminated f-string expression');
      const ch = text[j]!;
      if (ch === '\n' && !multiline && nested === 0) throw new PythonLexError('unterminated f-string expression');
      if (ch === '"' || ch === "'") {
        j = scanString(j, '').end;
        continue;
      }
      if (IDENT_START.test(ch)) {
        let k = j + 1;
        while (k < text.length && IDENT_CHAR.test(text[k]!)) k++;
        const word = text.slice(j, k);
        if ((text[k] === '"' || text[k] === "'") && STRING_PREFIX.test(word)) {
          j = scanString(k, word).end;
          continue;
        }
        j = k;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') nested++;
      else if (ch === ')' || ch === ']') nested--;
      else if (ch === '}') {
        if (nested === 0) return j + 1;
        nested--;
      }
      j++;
    }
  };

  while (i < text.length) {
    const ch = text[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\f' || ch === '\r' || ch === '﻿') {
      i++;
    } else if (ch === '\n') {
      if (depth === 0) push({ type: 'newline', value: '\n' });
      i++;
    } else if (ch === '#') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
    } else if (ch === '\\') {
      if (text[i + 1] === '\n') i += 2;
      else if (text[i + 1] === '\r' && text[i + 2] === '\n') i += 3;
      else throw new PythonLexError('unexpected backslash');
    } else if (ch === '"' || ch === "'") {
      const { end, literal } = scanString(i, '');
      push({ type: 'string', value: text.slice(i, end), ...(literal !== undefined ? { literal } : {}) });
      i = end;
    } else if (IDENT_START.test(ch)) {
      let k = i + 1;
      while (k < text.length && IDENT_CHAR.test(text[k]!)) k++;
      const word = text.slice(i, k);
      if ((text[k] === '"' || text[k] === "'") && STRING_PREFIX.test(word)) {
        const { end, literal } = scanString(k, word);
        const special = /[fFtTbB]/.test(word);
        push({ type: 'string', value: text.slice(i, end), ...(special ? { special } : {}), ...(literal !== undefined && !special ? { literal } : {}) });
        i = end;
      } else {
        push({ type: 'name', value: word });
        i = k;
      }
    } else if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      let k = i + 1;
      while (k < text.length && /[0-9A-Za-z_.]/.test(text[k]!)) {
        // Exponent signs: 1e-5, 2E+3.
        if (/[eE]/.test(text[k]!) && /[+-]/.test(text[k + 1] ?? '')) k++;
        k++;
      }
      push({ type: 'number', value: text.slice(i, k) });
      i = k;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      push({ type: 'op', value: ch });
      depth++;
      i++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth < 0) throw new PythonLexError(`unbalanced ${JSON.stringify(ch)}`);
      push({ type: 'op', value: ch });
      i++;
    } else if (text.startsWith('...', i)) {
      push({ type: 'op', value: '...' });
      i += 3;
    } else {
      push({ type: 'op', value: ch });
      i++;
    }
  }
  if (depth > 0) throw new PythonLexError('unterminated bracket');
  return tokens;
}

const isEnd = (token: Token | undefined) => token === undefined || token.type === 'newline' || (token.type === 'op' && token.value === ';');

/** Import statements and dynamic loads of one Python file. */
export function extractPythonImports(text: string): PythonExtraction {
  let tokens: Token[];
  try {
    tokens = tokenizePython(text);
  } catch (error) {
    if (error instanceof PythonLexError) return { imports: [], dynamicLoads: 0, error: error.message };
    throw error;
  }
  const imports: PythonImport[] = [];
  let dynamicLoads = 0;
  let error: string | undefined;
  const add = (item: PythonImport) => {
    if (imports.length >= MAX_PYTHON_IMPORTS_PER_FILE) {
      error ??= 'too many imports';
      return;
    }
    imports.push(item);
  };

  let i = 0;
  const name = (): string | undefined => (tokens[i]?.type === 'name' ? tokens[i++]!.value : undefined);
  const op = (value: string): boolean => {
    if (tokens[i]?.type === 'op' && tokens[i]!.value === value) {
      i++;
      return true;
    }
    return false;
  };
  const dotted = (): string | undefined => {
    const first = name();
    if (first === undefined) return undefined;
    const parts = [first];
    while (op('.')) {
      const next = name();
      if (next === undefined) return undefined;
      parts.push(next);
    }
    return parts.join('.');
  };
  const alias = (): boolean => {
    if (tokens[i]?.type === 'name' && tokens[i]!.value === 'as') {
      i++;
      return name() !== undefined;
    }
    return true;
  };

  const importStatement = (): boolean => {
    // import a.b as c, d
    for (;;) {
      const module = dotted();
      if (module === undefined || !alias()) return false;
      add({ specifier: module, kind: 'static' });
      if (!op(',')) break;
    }
    return isEnd(tokens[i]);
  };

  const fromStatement = (): boolean => {
    // from ..a.b import (x as y, z) | *
    let dots = '';
    for (;;) {
      if (op('.')) dots += '.';
      else if (op('...')) dots += '...';
      else break;
    }
    let module = '';
    if (!(tokens[i]?.type === 'name' && tokens[i]!.value === 'import')) {
      const parsed = dotted();
      if (parsed === undefined) return false;
      module = parsed;
    }
    if (dots === '' && module === '') return false;
    if (name() !== 'import') return false;
    const names: string[] = [];
    if (op('*')) {
      names.push('*');
    } else {
      const parenthesized = op('(');
      for (;;) {
        const imported = name();
        if (imported === undefined || !alias()) return false;
        names.push(imported);
        if (!op(',')) break;
        if (parenthesized && tokens[i]?.type === 'op' && tokens[i]!.value === ')') break;
      }
      if (parenthesized && !op(')')) return false;
    }
    add({ specifier: dots + module, kind: 'static', names });
    return isEnd(tokens[i]);
  };

  for (i = 0; i < tokens.length; ) {
    const token = tokens[i]!;
    if (token.start && token.type === 'name' && (token.value === 'import' || token.value === 'from')) {
      // `from` at a statement start is always an import (`yield from`/`raise … from` never start one).
      i++;
      const ok = token.value === 'import' ? importStatement() : fromStatement();
      if (!ok) {
        error ??= `unparsed ${token.value} statement`;
        while (i < tokens.length && !isEnd(tokens[i])) i++;
      }
      continue;
    }
    if (token.type === 'name' && (token.value === 'import_module' || token.value === '__import__')) {
      const previous = tokens[i - 1];
      const isDefinition = previous?.type === 'name' && previous.value === 'def';
      const viaAttribute = previous?.type === 'op' && previous.value === '.';
      const ownerOk = !viaAttribute || (tokens[i - 2]?.type === 'name' && tokens[i - 2]!.value === 'importlib');
      if (!isDefinition && ownerOk && tokens[i + 1]?.type === 'op' && tokens[i + 1]!.value === '(') {
        const argument = tokens[i + 2];
        const after = tokens[i + 3];
        const literal = argument?.type === 'string' && !argument.special ? argument.literal : undefined;
        const closes = after?.type === 'op' && (after.value === ')' || after.value === ',');
        if (literal !== undefined && closes && /^[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*$/u.test(literal)) {
          add({ specifier: literal, kind: 'dynamic' });
        } else {
          // A computed (or package-relative) module name could be anything, including the partner file.
          dynamicLoads++;
        }
        i += 2;
        continue;
      }
    }
    i++;
  }
  return { imports, dynamicLoads, ...(error ? { error } : {}) };
}

// ---------------------------------------------------------------------------
// Source roots and the local namespace

export interface PythonIndex {
  files: RepoFiles;
  /** Regular `.py` files. */
  pyFiles: Set<string>;
  /** Every directory that contains a `.py` file at any depth (`''` excluded). */
  pyDirs: Set<string>;
  /** Source roots, longest first (`''` is the repository root). */
  roots: string[];
  /** Top-level module/package name → roots that define it. */
  nameRoots: Map<string, string[]>;
  /** Names of top-level packages that live outside every source root (unknown layouts). */
  strayPackages: Set<string>;
  warnings: string[];
}

const dirOf = (path: string): string => {
  const dir = posix.dirname(path);
  return dir === '.' ? '' : dir;
};
const join = (dir: string, rest: string): string => (dir ? (rest ? `${dir}/${rest}` : dir) : rest);

/** `base` + a relative path from a manifest, or undefined when it leaves the repository. */
function within(base: string, relative: string): string | undefined {
  const joined = posix.normalize(join(base, relative.replace(/\\/g, '/'))).replace(/\/$/, '');
  if (joined === '..' || joined.startsWith('../') || posix.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) return undefined;
  return joined === '.' ? '' : joined;
}

const strings = (value: TomlValue | undefined): string[] | undefined => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value as string[];
  return undefined;
};

/** Source roots a pyproject.toml declares (setuptools, poetry, hatch), relative to its directory. */
export function pyprojectRoots(toml: TomlTable): { roots: string[]; unsupported: string[] } {
  const roots: string[] = [];
  const unsupported: string[] = [];
  const where = tomlGet(toml, ['tool', 'setuptools', 'packages', 'find', 'where']);
  if (where !== undefined) {
    const list = strings(where);
    if (list) roots.push(...list);
    else unsupported.push('tool.setuptools.packages.find.where');
  }
  const packageDir = tomlGet(toml, ['tool', 'setuptools', 'package-dir']);
  if (packageDir !== undefined) {
    if (!isTomlTable(packageDir)) unsupported.push('tool.setuptools.package-dir');
    else {
      for (const key of Object.keys(packageDir).sort()) {
        const dir = packageDir[key];
        if (typeof dir !== 'string') unsupported.push(`tool.setuptools.package-dir.${key}`);
        else if (key === '') roots.push(dir);
        else if (!key.includes('.') && posix.basename(posix.normalize(dir.replace(/\\/g, '/')).replace(/\/$/, '')) === key) roots.push(posix.dirname(dir) || '.');
        else unsupported.push(`tool.setuptools.package-dir.${key}`);
      }
    }
  }
  const poetry = tomlGet(toml, ['tool', 'poetry', 'packages']);
  if (poetry !== undefined) {
    if (!Array.isArray(poetry)) unsupported.push('tool.poetry.packages');
    else {
      for (const entry of poetry) {
        if (!isTomlTable(entry) || typeof entry.include !== 'string') {
          unsupported.push('tool.poetry.packages');
          continue;
        }
        const from = entry.from;
        if (from !== undefined && typeof from !== 'string') unsupported.push('tool.poetry.packages.from');
        else roots.push(from ?? '.');
      }
    }
  }
  const hatch = tomlGet(toml, ['tool', 'hatch', 'build', 'targets', 'wheel', 'packages']);
  if (hatch !== undefined) {
    const list = strings(hatch);
    if (!list) unsupported.push('tool.hatch.build.targets.wheel.packages');
    // Hatch lists package paths (`src/foo`): the root is their parent directory.
    else for (const item of list) roots.push(posix.dirname(posix.normalize(item.replace(/\\/g, '/')).replace(/\/$/, '')) || '.');
  }
  return { roots, unsupported };
}

export function buildPythonIndex(files: RepoFiles): PythonIndex {
  const index: PythonIndex = {
    files,
    pyFiles: new Set(),
    pyDirs: new Set(),
    roots: [],
    nameRoots: new Map(),
    strayPackages: new Set(),
    warnings: [],
  };
  const all = [...files.list()].sort();
  const projectDirs: { dir: string; manifest?: string }[] = [];
  for (const path of all) {
    const base = posix.basename(path);
    if (base === 'setup.py' || base === 'setup.cfg') {
      // Never executed or parsed: the directory is only treated as a project root.
      projectDirs.push({ dir: dirOf(path) });
    }
    if (path.endsWith('.py')) {
      // No symlinks: a linked file or directory never counts as part of a package.
      if (!files.exists(path)) continue;
      index.pyFiles.add(path);
      for (let dir = dirOf(path); dir !== ''; dir = dirOf(dir)) {
        if (index.pyDirs.has(dir)) break;
        index.pyDirs.add(dir);
      }
    } else if (base === 'pyproject.toml') {
      projectDirs.push({ dir: dirOf(path), manifest: path });
    }
  }

  const roots = new Set<string>(['']);
  const addRoot = (dir: string | undefined, origin: string) => {
    if (dir === undefined) {
      index.warnings.push(`Python: ${origin} points outside the repository; ignored.`);
      return;
    }
    if (dir === '' || index.pyDirs.has(dir)) roots.add(dir);
  };
  addRoot('src', 'src/');
  const fallback = (dir: string) => {
    addRoot(dir, dir);
    addRoot(join(dir, 'src'), join(dir, 'src'));
  };
  let manifests = 0;
  const seenProjectDirs = new Set<string>();
  for (const { dir, manifest } of projectDirs) {
    if (!manifest) {
      if (!seenProjectDirs.has(dir)) fallback(dir);
      continue;
    }
    seenProjectDirs.add(dir);
    if (++manifests > MAX_PYPROJECTS) {
      index.warnings.push(`Python: more than ${MAX_PYPROJECTS} pyproject.toml files; the rest were not read (their directories are used as source roots).`);
      fallback(dir);
      continue;
    }
    const text = files.exists(manifest) ? files.read(manifest) : undefined;
    if (text === undefined || Buffer.byteLength(text) > MAX_PYTHON_MANIFEST_BYTES) {
      const why = text === undefined ? 'not a readable regular file' : `larger than ${MAX_PYTHON_MANIFEST_BYTES / 1024} KiB`;
      index.warnings.push(`Python: ${manifest} is ${why}, so it was not read (unsupported-config); its directory is used as a source root.`);
      fallback(dir);
      continue;
    }
    let toml: TomlTable;
    try {
      toml = parseTomlSubset(text);
    } catch (error) {
      if (!(error instanceof TomlSubsetError)) throw error;
      index.warnings.push(`Python: ${manifest} uses TOML outside the supported subset (unsupported-config: ${error.message}); its directory is used as a source root.`);
      fallback(dir);
      continue;
    }
    const declared = pyprojectRoots(toml);
    for (const key of declared.unsupported) index.warnings.push(`Python: ${manifest} ${key} has an unsupported form (unsupported-config); ignored.`);
    if (declared.roots.length === 0) fallback(dir);
    for (const root of declared.roots) addRoot(within(dir, root), `${manifest} source root ${JSON.stringify(root)}`);
  }
  index.roots = [...roots].sort((a, b) => b.length - a.length || a.localeCompare(b));

  const rootSet = new Set(index.roots);
  const names = new Map<string, Set<string>>();
  const addName = (name: string, root: string) => {
    let set = names.get(name);
    if (!set) names.set(name, (set = new Set()));
    set.add(root);
  };
  for (const file of index.pyFiles) {
    // Every root above this file sees it under the first path segment below the root.
    let child = file;
    for (let dir = dirOf(file); ; dir = dirOf(dir)) {
      if (rootSet.has(dir)) {
        const top = dir === '' ? child : child.slice(dir.length + 1);
        addName(top === posix.basename(file) ? top.replace(/\.py$/, '') : top, dir);
      }
      if (dir === '') break;
      child = dir;
    }
    if (posix.basename(file) === '__init__.py') {
      const pkg = dirOf(file);
      const parent = dirOf(pkg);
      if (pkg !== '' && !rootSet.has(parent) && !index.pyFiles.has(join(parent, '__init__.py'))) index.strayPackages.add(posix.basename(pkg));
    }
  }
  for (const [name, set] of names) index.nameRoots.set(name, [...set].sort());
  return index;
}

type ModuleLookup = { kind: 'file'; path: string } | { kind: 'namespace' } | { kind: 'missing' };

function lookupModule(index: PythonIndex, base: string): ModuleLookup {
  if (index.pyFiles.has(`${base}.py`)) return { kind: 'file', path: `${base}.py` };
  const init = join(base, '__init__.py');
  if (index.pyFiles.has(init)) return { kind: 'file', path: init };
  if (base === '' || index.pyDirs.has(base)) return { kind: 'namespace' };
  return { kind: 'missing' };
}

const VALID_PART = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/** Resolves a module path (`base` = its file path without extension) and the names imported from it. */
function resolveModule(index: PythonIndex, base: string, names: string[] | undefined): SpecifierResolution {
  const module = lookupModule(index, base);
  if (module.kind === 'missing') return { kind: 'unresolved', reasonCode: 'target-missing' };
  if (names === undefined) {
    return { kind: 'files', targets: module.kind === 'file' ? [{ path: module.path, via: 'python-module' }] : [] };
  }
  const targets: AnalysisTarget[] = [];
  for (const name of names) {
    if (name === '*') {
      if (module.kind === 'file') targets.push({ path: module.path, via: 'python-module' });
      continue;
    }
    const sub = lookupModule(index, join(base, name));
    if (sub.kind === 'file') targets.push({ path: sub.path, via: 'python-module' });
    else if (sub.kind === 'namespace') continue;
    // Not a submodule: `name` is probably an attribute defined in (or re-exported by) the module.
    else if (module.kind === 'file') targets.push({ path: module.path, via: 'python-module', heuristic: true });
    else return { kind: 'unresolved', reasonCode: 'target-missing' };
  }
  const seen = new Set<string>();
  return {
    kind: 'files',
    targets: targets
      .sort((a, b) => a.path.localeCompare(b.path) || Number(Boolean(a.heuristic)) - Number(Boolean(b.heuristic)))
      .filter((target) => (seen.has(target.path) ? false : (seen.add(target.path), true))),
  };
}

/** The innermost source root containing `path`. */
function rootOf(index: PythonIndex, path: string): string {
  for (const root of index.roots) if (root === '' || path.startsWith(`${root}/`)) return root;
  return '';
}

export function resolvePythonImport(from: string, item: ExtractedSpecifier, index: PythonIndex): SpecifierResolution {
  const specifier = item.specifier;
  const level = /^\.*/.exec(specifier)![0].length;
  const rest = specifier.slice(level);
  const parts = rest === '' ? [] : rest.split('.');
  if (parts.some((part) => !VALID_PART.test(part))) return { kind: 'unresolved', reasonCode: 'invalid-target' };

  if (level > 0) {
    const root = rootOf(index, from);
    const relDir = root === '' ? dirOf(from) : dirOf(from).slice(root.length + 1);
    const packageParts = relDir === '' ? [] : relDir.split('/');
    // `from . import x` needs a package; each extra dot climbs one level, never above the root.
    if (level > packageParts.length) return { kind: 'unresolved', reasonCode: 'target-missing' };
    const baseParts = packageParts.slice(0, packageParts.length - (level - 1));
    return resolveModule(index, join(root, [...baseParts, ...parts].join('/')), item.names);
  }

  const top = parts[0];
  if (top === undefined) return { kind: 'unresolved', reasonCode: 'invalid-target' };
  const roots = index.nameRoots.get(top) ?? [];
  if (roots.length > 1) return { kind: 'unresolved', reasonCode: 'ambiguous-package' };
  if (roots.length === 1) return resolveModule(index, join(roots[0]!, parts.join('/')), item.names);
  // Not in any known root. A same-named package elsewhere in the repo, or a sibling of a
  // script (Python puts the script's folder on sys.path), means a layout we do not model.
  const fromDir = dirOf(from);
  const scriptDir = !index.pyFiles.has(join(fromDir, '__init__.py'));
  const sibling = scriptDir ? lookupModule(index, join(fromDir, top)) : { kind: 'missing' as const };
  if (index.strayPackages.has(top) || sibling.kind !== 'missing') return { kind: 'unresolved', reasonCode: 'unknown-package' };
  return { kind: 'external' };
}

export const pythonAnalyzer: LanguageAnalyzer<PythonIndex> = {
  id: 'python',
  matches: (path) => path.endsWith('.py'),
  language: () => 'python',
  budgeted: true,
  index: buildPythonIndex,
  indexWarnings: (index) => index.warnings,
  extract(text): Extraction {
    const parsed = extractPythonImports(text);
    return {
      imports: parsed.imports.map(({ specifier, kind, names }) => ({ specifier, kind, ...(names ? { names } : {}) })),
      dynamicLoads: parsed.dynamicLoads,
      ...(parsed.error !== undefined ? { incompleteReason: `Python source could not be fully read: ${parsed.error}` } : {}),
    };
  },
  resolve(from, item, index, _session: AnalysisSession) {
    return resolvePythonImport(from, item, index);
  },
};
