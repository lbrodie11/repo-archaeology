import { posix } from 'node:path';
import type { AnalysisSession, AnalysisTarget, ExtractedSpecifier, Extraction, LanguageAnalyzer, SpecifierResolution } from './analysis.js';
import { PYTHON_STDLIB_MODULES } from './python-stdlib.js';
import { isTomlTable, parseTomlSubset, TomlSubsetError, tomlGet, type TomlTable, type TomlValue } from './toml.js';
import type { RepoFiles } from './tree-files.js';

/**
 * Python import analysis (RA-10). Dependency-free and conservative:
 * - extraction is a bounded lexer (strings with prefixes, f-string replacement
 *   fields, comments, continuations, bracket depth, `;`) that reads `import` /
 *   `from … import` at any statement start, plus calls to `importlib.import_module`
 *   and `__import__` (including aliases of either);
 * - absolute imports resolve by elimination against the local namespace of the
 *   known source roots (a top-level name in exactly one root resolves there, in
 *   several roots is `ambiguous-package`, in none is external), with the import
 *   system's precedence (regular package, then module, then namespace portion) and
 *   every regular-package `__init__.py` along the path, since importing `a.b.c`
 *   runs `a/__init__.py` and `a/b/__init__.py` first;
 * - anything unsure makes the file `incomplete`, which keeps its pairs `unknown`.
 * Nothing is executed (`setup.py` is never run) and nothing is fetched.
 */

export const MAX_PYTHON_MANIFEST_BYTES = 64 * 1024;
const MAX_PYTHON_IMPORTS_PER_FILE = 10_000;
const MAX_PYPROJECTS = 500;
const MAX_FSTRING_DEPTH = 8;

// ---------------------------------------------------------------------------
// Lexer

type TokenType = 'name' | 'string' | 'op' | 'newline' | 'number';

export interface Token {
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
const MODULE_NAME = /^[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*$/u;

class PythonLexError extends Error {}

/**
 * Tokenizes Python source just far enough to find imports. The expressions inside
 * f-string replacement fields are tokenized too (they run code, so they can load
 * modules); their tokens follow the string token and never start a statement.
 * Throws `PythonLexError`.
 */
export function tokenizePython(text: string, depth = 0): Token[] {
  if (depth > MAX_FSTRING_DEPTH) throw new PythonLexError('f-strings nested too deeply');
  const tokens: Token[] = [];
  let i = 0;
  let brackets = 0;
  let start = true;
  const push = (token: Omit<Token, 'start'>) => {
    tokens.push({ ...token, start });
    start = token.type === 'newline' || (token.type === 'op' && (token.value === ';' || (token.value === ':' && brackets === 0)));
  };

  /** Scans a string literal starting at the opening quote. */
  const scanString = (at: number, prefix: string): { end: number; literal?: string; fields: Token[] } => {
    const quote = text[at]!;
    const triple = text.startsWith(quote.repeat(3), at);
    const formatted = /[fFtT]/.test(prefix);
    let j = at + (triple ? 3 : 1);
    const contentStart = j;
    let escaped = false;
    const fields: Token[] = [];
    for (;;) {
      if (j >= text.length) throw new PythonLexError(triple ? 'unterminated triple-quoted string' : 'unterminated string');
      const ch = text[j]!;
      if (triple ? text.startsWith(quote.repeat(3), j) : ch === quote) {
        const end = j + (triple ? 3 : 1);
        return { end, ...(!escaped && !formatted ? { literal: text.slice(contentStart, j) } : {}), fields };
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
        const end = scanReplacementField(j + 1, triple);
        // The field's expression (and any nested fields in its format spec) is code.
        for (const token of tokenizePython(text.slice(j + 1, end - 1), depth + 1)) {
          if (token.type !== 'newline') fields.push({ ...token, start: false });
        }
        j = end;
        continue;
      }
      j++;
    }
  };

  /** Finds the end of an f-string `{…}` field (nested brackets and strings); returns the index after its `}`. */
  const scanReplacementField = (at: number, multiline: boolean): number => {
    let j = at;
    let nested = 0;
    for (;;) {
      if (j >= text.length) throw new PythonLexError('unterminated f-string expression');
      const ch = text[j]!;
      if (ch === '\n' && !multiline && nested === 0) throw new PythonLexError('unterminated f-string expression');
      if (ch === '"' || ch === "'") {
        j = skipString(j, '');
        continue;
      }
      if (IDENT_START.test(ch)) {
        let k = j + 1;
        while (k < text.length && IDENT_CHAR.test(text[k]!)) k++;
        const word = text.slice(j, k);
        if ((text[k] === '"' || text[k] === "'") && STRING_PREFIX.test(word)) {
          j = skipString(k, word);
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

  /** Finds the end of a string inside a replacement field (its own fields are tokenized later). */
  const skipString = (at: number, prefix: string): number => {
    const quote = text[at]!;
    const triple = text.startsWith(quote.repeat(3), at);
    const formatted = /[fFtT]/.test(prefix);
    let j = at + (triple ? 3 : 1);
    for (;;) {
      if (j >= text.length) throw new PythonLexError('unterminated string');
      const ch = text[j]!;
      if (triple ? text.startsWith(quote.repeat(3), j) : ch === quote) return j + (triple ? 3 : 1);
      if (!triple && ch === '\n') throw new PythonLexError('unterminated string');
      if (ch === '\\') {
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

  const pushString = (from: number, prefix: string, quoteAt: number) => {
    const { end, literal, fields } = scanString(quoteAt, prefix);
    const special = /[fFtTbB]/.test(prefix);
    push({ type: 'string', value: text.slice(from, end), ...(special ? { special } : {}), ...(literal !== undefined && !special ? { literal } : {}) });
    for (const field of fields) tokens.push(field);
    i = end;
  };

  while (i < text.length) {
    const ch = text[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\f' || ch === '\r' || ch === '﻿') {
      i++;
    } else if (ch === '\n') {
      if (brackets === 0) push({ type: 'newline', value: '\n' });
      i++;
    } else if (ch === '#') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
    } else if (ch === '\\') {
      if (text[i + 1] === '\n') i += 2;
      else if (text[i + 1] === '\r' && text[i + 2] === '\n') i += 3;
      else throw new PythonLexError('unexpected backslash');
    } else if (ch === '"' || ch === "'") {
      pushString(i, '', i);
    } else if (IDENT_START.test(ch)) {
      let k = i + 1;
      while (k < text.length && IDENT_CHAR.test(text[k]!)) k++;
      const word = text.slice(i, k);
      if ((text[k] === '"' || text[k] === "'") && STRING_PREFIX.test(word)) {
        pushString(i, word, k);
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
      brackets++;
      i++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      brackets--;
      if (brackets < 0) throw new PythonLexError(`unbalanced ${JSON.stringify(ch)}`);
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
  if (brackets > 0) throw new PythonLexError('unterminated bracket');
  return tokens;
}

const isEnd = (token: Token | undefined) => token === undefined || token.type === 'newline' || (token.type === 'op' && token.value === ';');
const isOp = (token: Token | undefined, value: string) => token?.type === 'op' && token.value === value;
const isName = (token: Token | undefined, value?: string) => token?.type === 'name' && (value === undefined || token.value === value);

interface ImportStatement {
  /** Token range [from, to) of the statement. */
  from: number;
  to: number;
  /** `import a.b as c` → { module: 'a.b', bound: 'c' }; `from m import n as k` → { module: 'm', name: 'n', bound: 'k' }. */
  bindings: { module: string; name?: string; bound: string }[];
  item?: PythonImport;
  items: PythonImport[];
}

interface ParsedSource {
  tokens: Token[];
  statements: ImportStatement[];
  error?: string;
}

/** Tokenizes and parses the import statements of one file. */
function parseSource(text: string): ParsedSource | { lexError: string } {
  let tokens: Token[];
  try {
    tokens = tokenizePython(text);
  } catch (error) {
    if (error instanceof PythonLexError) return { lexError: error.message };
    throw error;
  }
  const statements: ImportStatement[] = [];
  let error: string | undefined;
  let i = 0;
  const name = (): string | undefined => (tokens[i]?.type === 'name' ? tokens[i++]!.value : undefined);
  const op = (value: string): boolean => {
    if (isOp(tokens[i], value)) {
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
  const alias = (): string | null | undefined => {
    if (isName(tokens[i], 'as')) {
      i++;
      return name() ?? undefined;
    }
    return null;
  };

  const importStatement = (statement: ImportStatement): boolean => {
    // import a.b as c, d
    for (;;) {
      const module = dotted();
      if (module === undefined) return false;
      const bound = alias();
      if (bound === undefined) return false;
      statement.items.push({ specifier: module, kind: 'static' });
      statement.bindings.push({ module, bound: bound ?? module.split('.')[0]! });
      if (!op(',')) break;
    }
    return isEnd(tokens[i]);
  };

  const fromStatement = (statement: ImportStatement): boolean => {
    // from ..a.b import (x as y, z) | *
    let dots = '';
    for (;;) {
      if (op('.')) dots += '.';
      else if (op('...')) dots += '...';
      else break;
    }
    let module = '';
    if (!isName(tokens[i], 'import')) {
      const parsed = dotted();
      if (parsed === undefined) return false;
      module = parsed;
    }
    if (dots === '' && module === '') return false;
    if (name() !== 'import') return false;
    const names: string[] = [];
    const specifier = dots + module;
    if (op('*')) {
      names.push('*');
      statement.bindings.push({ module: specifier, name: '*', bound: '*' });
    } else {
      const parenthesized = op('(');
      for (;;) {
        const imported = name();
        if (imported === undefined) return false;
        const bound = alias();
        if (bound === undefined) return false;
        names.push(imported);
        statement.bindings.push({ module: specifier, name: imported, bound: bound ?? imported });
        if (!op(',')) break;
        if (parenthesized && isOp(tokens[i], ')')) break;
      }
      if (parenthesized && !op(')')) return false;
    }
    statement.items.push({ specifier, kind: 'static', names });
    return isEnd(tokens[i]);
  };

  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token.start && token.type === 'name' && (token.value === 'import' || token.value === 'from')) {
      // `from` at a statement start is always an import (`yield from`/`raise … from` never start one).
      const statement: ImportStatement = { from: i, to: i, bindings: [], items: [] };
      i++;
      const ok = token.value === 'import' ? importStatement(statement) : fromStatement(statement);
      if (!ok) {
        error ??= `unparsed ${token.value} statement`;
        while (i < tokens.length && !isEnd(tokens[i])) i++;
      }
      statement.to = i;
      statements.push(statement);
      continue;
    }
    i++;
  }
  return { tokens, statements, ...(error ? { error } : {}) };
}

/**
 * Names a file binds other than through imports: `def`/`class` names, their
 * parameters, assignment and annotation targets at a statement start, `for`, `as`
 * (with/except) and walrus targets. Used to tell a loader alias from a rebound name.
 */
function nonImportBindings(tokens: Token[], inImport: (index: number) => boolean): Set<string> {
  const bound = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.type !== 'name' || inImport(i)) continue;
    const next = tokens[i + 1];
    if ((token.value === 'def' || token.value === 'class') && isName(next)) {
      bound.add(next!.value);
      if (token.value === 'def' && isOp(tokens[i + 2], '(')) {
        // Parameters (and, conservatively, every other name in the signature).
        let depth = 0;
        for (let j = i + 2; j < tokens.length; j++) {
          const t = tokens[j]!;
          if (isOp(t, '(') || isOp(t, '[') || isOp(t, '{')) depth++;
          else if (isOp(t, ')') || isOp(t, ']') || isOp(t, '}')) {
            depth--;
            if (depth === 0) break;
          } else if (t.type === 'name') bound.add(t.value);
        }
      }
    } else if (token.value === 'lambda') {
      for (let j = i + 1; j < tokens.length && !isOp(tokens[j], ':'); j++) if (tokens[j]!.type === 'name') bound.add(tokens[j]!.value);
    } else if ((token.value === 'for' || token.value === 'as' || token.value === 'del' || token.value === 'global' || token.value === 'nonlocal') && isName(next)) {
      for (let j = i + 1; j < tokens.length && (tokens[j]!.type === 'name' || isOp(tokens[j], ',') || isOp(tokens[j], '(')); j++) {
        if (tokens[j]!.type === 'name' && tokens[j]!.value !== 'in') bound.add(tokens[j]!.value);
        if (isName(tokens[j], 'in')) break;
      }
    } else if (isOp(next, ':') && isOp(tokens[i + 2], '=')) {
      bound.add(token.value); // walrus
    } else if (token.start) {
      // a = …, a: T = …, a += …, a, b = …
      let j = i;
      const names: string[] = [];
      while (tokens[j]?.type === 'name') {
        names.push(tokens[j]!.value);
        if (!isOp(tokens[j + 1], ',')) break;
        j += 2;
      }
      const after = tokens[j + 1];
      const assigns =
        (isOp(after, '=') && !isOp(tokens[j + 2], '=')) ||
        isOp(after, ':') ||
        (after?.type === 'op' && /^[-+*/%@&|^<>]$/.test(after.value) && (isOp(tokens[j + 2], '=') || isOp(tokens[j + 3], '=')));
      if (assigns) for (const n of names) bound.add(n);
    }
  }
  return bound;
}

/** Import statements and dynamic loads of one Python file. */
export function extractPythonImports(text: string): PythonExtraction {
  const parsed = parseSource(text);
  if ('lexError' in parsed) return { imports: [], dynamicLoads: 0, error: parsed.lexError };
  const { tokens, statements } = parsed;
  let error = parsed.error;
  const imports: PythonImport[] = [];
  const add = (item: PythonImport) => {
    if (imports.length >= MAX_PYTHON_IMPORTS_PER_FILE) {
      error ??= 'too many imports';
      return;
    }
    imports.push(item);
  };
  for (const statement of statements) for (const item of statement.items) add(item);

  const importTokens = new Set<number>();
  for (const statement of statements) for (let k = statement.from; k < statement.to; k++) importTokens.add(k);
  const inImport = (index: number) => importTokens.has(index);

  // Loader bindings: `import importlib [as il]`, `from importlib import import_module [as load]`,
  // `from builtins import __import__ [as x]`, `from importlib import *`.
  const loaderModules = new Set(['importlib']);
  const loaderFunctions = new Set(['__import__', 'import_module']);
  const importBound = new Map<string, number>();
  for (const statement of statements) {
    for (const binding of statement.bindings) {
      if (binding.name === undefined && binding.module.split('.')[0] === 'importlib' && (binding.bound === 'importlib' || binding.module === 'importlib')) {
        loaderModules.add(binding.bound);
      } else if (binding.module === 'importlib' && (binding.name === 'import_module' || binding.name === '*')) {
        if (binding.name === 'import_module') loaderFunctions.add(binding.bound);
      } else if (binding.module === 'builtins' && binding.name === '__import__') {
        loaderFunctions.add(binding.bound);
      } else if (binding.bound !== '*') {
        importBound.set(binding.bound, (importBound.get(binding.bound) ?? 0) + 1);
      }
    }
  }
  const rebound = nonImportBindings(tokens, inImport);
  for (const name of importBound.keys()) rebound.add(name);

  let dynamicLoads = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (inImport(i)) continue;
    const token = tokens[i]!;
    if (token.type !== 'name') continue;
    const previous = tokens[i - 1];
    if (isName(previous, 'def') || isName(previous, 'class')) continue;
    const viaAttribute = isOp(previous, '.');
    let loader = false;
    let shadowed = false;
    if (viaAttribute) {
      const owner = tokens[i - 2];
      const ownerIsBare = owner?.type === 'name' && !isOp(tokens[i - 3], '.');
      if (token.value === 'import_module' && ownerIsBare && loaderModules.has(owner!.value)) {
        loader = true;
        shadowed = rebound.has(owner!.value);
      } else if (token.value === '__import__' && ownerIsBare && owner!.value === 'builtins') {
        loader = true;
        shadowed = rebound.has('builtins');
      }
    } else if (loaderFunctions.has(token.value)) {
      loader = true;
      shadowed = rebound.has(token.value);
    }
    if (!loader) continue;
    if (!isOp(tokens[i + 1], '(')) {
      // The loader escapes (`f = importlib.import_module`): later calls cannot be followed.
      if (!rebound.has(token.value) || viaAttribute) dynamicLoads++;
      continue;
    }
    const argument = tokens[i + 2];
    const after = tokens[i + 3];
    const literal = argument?.type === 'string' && !argument.special ? argument.literal : undefined;
    const closes = isOp(after, ')') || isOp(after, ',');
    if (!shadowed && literal !== undefined && closes && MODULE_NAME.test(literal)) {
      add({ specifier: literal, kind: 'dynamic' });
    } else {
      // A computed, package-relative or possibly rebound load could be anything, including the partner file.
      dynamicLoads++;
    }
  }
  return { imports, dynamicLoads, ...(error ? { error } : {}) };
}

/** What a package `__init__.py` binds, for telling `from pkg import name` attributes from submodules. */
export interface InitializerBindings {
  /** The initializer could not be read or binds names dynamically (`__getattr__`, star imports, `globals()`, …). */
  dynamic: boolean;
  /** `from . import a [as b]`: b → a. */
  submodules: Map<string, string>;
  /** Names bound any other way (assignment, def, class, other imports, …). */
  other: Set<string>;
}

const DYNAMIC_NAMESPACE = new Set(['__getattr__', 'globals', 'setattr', 'vars', '__dict__', 'exec', 'eval', 'locals']);

export function initializerBindings(text: string | undefined): InitializerBindings {
  const result: InitializerBindings = { dynamic: false, submodules: new Map(), other: new Set() };
  if (text === undefined) return { ...result, dynamic: true };
  const parsed = parseSource(text);
  if ('lexError' in parsed || parsed.error) return { ...result, dynamic: true };
  const importTokens = new Set<number>();
  for (const statement of parsed.statements) {
    for (let k = statement.from; k < statement.to; k++) importTokens.add(k);
    for (const binding of statement.bindings) {
      if (binding.bound === '*') result.dynamic = true;
      else if (binding.module === '.' && binding.name !== undefined) result.submodules.set(binding.bound, binding.name);
      else result.other.add(binding.bound);
    }
  }
  for (const token of parsed.tokens) if (token.type === 'name' && DYNAMIC_NAMESPACE.has(token.value)) result.dynamic = true;
  for (let i = 0; i < parsed.tokens.length; i++) {
    if (isName(parsed.tokens[i], 'modules') && isOp(parsed.tokens[i - 1], '.') && isName(parsed.tokens[i - 2], 'sys')) result.dynamic = true;
  }
  for (const name of nonImportBindings(parsed.tokens, (index) => importTokens.has(index))) result.other.add(name);
  return result;
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
  /** setuptools `package-dir` mappings: top-level package name → directories. */
  mappedPackages: Map<string, string[]>;
  /** Names of top-level packages that live outside every source root (unknown layouts). */
  strayPackages: Set<string>;
  /**
   * Why the project layout cannot be fully modeled (unreadable, oversized or unsupported
   * manifests). When set, a top-level name that is neither local nor standard library is
   * unresolved (`unsupported-config`) instead of external: it may be a package we missed.
   */
  layoutUncertain: string[];
  initializers: Map<string, InitializerBindings>;
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

/** Source roots and package mappings a pyproject.toml declares (setuptools, poetry, hatch), relative to its directory. */
export function pyprojectRoots(toml: TomlTable): { roots: string[]; packages: [string, string][]; unsupported: string[] } {
  const roots: string[] = [];
  const packages: [string, string][] = [];
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
        // `{public = "impl"}`: the top-level package `public` lives in `impl/`.
        else if (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(key)) packages.push([key, dir]);
        // Dotted keys remap subpackages; not modeled.
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
  const hatchSources = tomlGet(toml, ['tool', 'hatch', 'build', 'targets', 'wheel', 'sources']);
  if (hatchSources !== undefined) unsupported.push('tool.hatch.build.targets.wheel.sources');
  return { roots, packages, unsupported };
}

/** setup.py / setup.cfg keys that remap where packages live (read as text, never executed). */
const SETUP_LAYOUT_KEYS = /\b(?:package_dir|py_modules)\b|find(?:_namespace)?_packages\s*\(\s*(?:where\s*=|['"])|^\s*where\s*=/m;

export function buildPythonIndex(files: RepoFiles): PythonIndex {
  const index: PythonIndex = {
    files,
    pyFiles: new Set(),
    pyDirs: new Set(),
    roots: [],
    nameRoots: new Map(),
    mappedPackages: new Map(),
    strayPackages: new Set(),
    layoutUncertain: [],
    initializers: new Map(),
    warnings: [],
  };
  const all = [...files.list()].sort();
  const projectDirs: { dir: string; manifest?: string; setup?: string }[] = [];
  for (const path of all) {
    const base = posix.basename(path);
    if (base === 'setup.py' || base === 'setup.cfg') projectDirs.push({ dir: dirOf(path), setup: path });
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

  const uncertain = (warning: string) => {
    index.warnings.push(warning);
    index.layoutUncertain.push(warning);
  };
  const roots = new Set<string>(['']);
  const addRoot = (dir: string | undefined, origin: string) => {
    if (dir === undefined) {
      uncertain(`Python: ${origin} points outside the repository; packages declared there are not modeled (unsupported-config).`);
      return;
    }
    if (dir === '' || index.pyDirs.has(dir)) roots.add(dir);
  };
  addRoot('src', 'src/');
  const fallback = (dir: string) => {
    addRoot(dir, dir);
    addRoot(join(dir, 'src'), join(dir, 'src'));
  };
  const readManifest = (path: string): { text?: string; why?: string } => {
    const text = files.exists(path) ? files.read(path) : undefined;
    if (text === undefined) return { why: 'not a readable regular file' };
    if (Buffer.byteLength(text) > MAX_PYTHON_MANIFEST_BYTES) return { why: `larger than ${MAX_PYTHON_MANIFEST_BYTES / 1024} KiB` };
    return { text };
  };
  let manifests = 0;
  const seenProjectDirs = new Set<string>();
  for (const { dir, manifest, setup } of projectDirs) {
    if (setup) {
      // Never executed: read as text only to notice layout remapping we do not model.
      const { text, why } = readManifest(setup);
      if (text === undefined) uncertain(`Python: ${setup} is ${why}, so its package layout is unknown (unsupported-config).`);
      else if (SETUP_LAYOUT_KEYS.test(text)) uncertain(`Python: ${setup} declares its package layout (package_dir, py_modules or find_packages where), which is not read (unsupported-config).`);
      if (!seenProjectDirs.has(dir)) fallback(dir);
      continue;
    }
    seenProjectDirs.add(dir);
    if (++manifests > MAX_PYPROJECTS) {
      uncertain(`Python: more than ${MAX_PYPROJECTS} pyproject.toml files; the rest were not read (unsupported-config).`);
      fallback(dir);
      continue;
    }
    const { text, why } = readManifest(manifest!);
    if (text === undefined) {
      uncertain(`Python: ${manifest} is ${why}, so it was not read (unsupported-config).`);
      fallback(dir);
      continue;
    }
    let toml: TomlTable;
    try {
      toml = parseTomlSubset(text);
    } catch (error) {
      if (!(error instanceof TomlSubsetError)) throw error;
      uncertain(`Python: ${manifest} uses TOML outside the supported subset (unsupported-config: ${error.message}).`);
      fallback(dir);
      continue;
    }
    const declared = pyprojectRoots(toml);
    for (const key of declared.unsupported) uncertain(`Python: ${manifest} ${key} has an unsupported form (unsupported-config).`);
    if (declared.roots.length === 0 && declared.packages.length === 0) fallback(dir);
    for (const root of declared.roots) addRoot(within(dir, root), `${manifest} source root ${JSON.stringify(root)}`);
    for (const [name, target] of declared.packages) {
      const mapped = within(dir, target);
      if (mapped === undefined || mapped === '') {
        uncertain(`Python: ${manifest} maps package ${name} to ${JSON.stringify(target)}, outside the repository (unsupported-config).`);
        continue;
      }
      const list = index.mappedPackages.get(name) ?? [];
      list.push(mapped);
      index.mappedPackages.set(name, list);
    }
  }
  index.roots = [...roots].sort((a, b) => b.length - a.length || a.localeCompare(b));

  const rootSet = new Set(index.roots);
  const mappedDirs = new Set([...index.mappedPackages.values()].flat());
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
        addName(child === file ? top.replace(/\.py$/, '') : top, dir);
      }
      if (dir === '') break;
      child = dir;
    }
    if (posix.basename(file) === '__init__.py') {
      const pkg = dirOf(file);
      const parent = dirOf(pkg);
      if (pkg !== '' && !mappedDirs.has(pkg) && !rootSet.has(parent) && !index.pyFiles.has(join(parent, '__init__.py'))) index.strayPackages.add(posix.basename(pkg));
    }
  }
  for (const [name, set] of names) index.nameRoots.set(name, [...set].sort());
  return index;
}

type ModuleLookup = { kind: 'package'; init: string } | { kind: 'module'; path: string } | { kind: 'namespace' } | { kind: 'missing' };

/**
 * What `base` names, with the path-based finder's precedence: a regular package
 * (`base/__init__.py`) wins over a module (`base.py`), which wins over a namespace
 * portion (a directory holding Python files).
 */
function lookupModule(index: PythonIndex, base: string): ModuleLookup {
  const init = join(base, '__init__.py');
  if (index.pyFiles.has(init)) return { kind: 'package', init };
  if (index.pyFiles.has(`${base}.py`)) return { kind: 'module', path: `${base}.py` };
  if (base === '' || index.pyDirs.has(base)) return { kind: 'namespace' };
  return { kind: 'missing' };
}

const VALID_PART = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/**
 * Walks a module path from its top-level location: every regular package on the way
 * contributes its `__init__.py` (Python runs them before the module), a module file
 * in the middle (`a.py` for `a.b`) is not a package, so the import fails.
 */
function walkModule(index: PythonIndex, topBase: string, rest: string[]): { inits: string[]; base: string; leaf: ModuleLookup } | undefined {
  const inits: string[] = [];
  let base = topBase;
  let lookup = lookupModule(index, base);
  for (const part of rest) {
    if (lookup.kind === 'package') inits.push(lookup.init);
    else if (lookup.kind !== 'namespace') return undefined;
    base = join(base, part);
    lookup = lookupModule(index, base);
  }
  if (lookup.kind === 'missing') return undefined;
  return { inits, base, leaf: lookup };
}

/** The leaf file a walked module path names, if any (a namespace has none). */
const leafFile = (leaf: ModuleLookup): string | undefined => (leaf.kind === 'package' ? leaf.init : leaf.kind === 'module' ? leaf.path : undefined);

/**
 * An initializer of a package that contains the importing file already ran before that
 * file did, whatever it imports: it is not a dependency the import statement adds.
 */
function containsImporter(init: string, from: string): boolean {
  const pkg = dirOf(init);
  const fromDir = dirOf(from);
  return pkg !== '' && (fromDir === pkg || fromDir.startsWith(`${pkg}/`));
}

function bindingsOf(index: PythonIndex, init: string): InitializerBindings {
  let cached = index.initializers.get(init);
  if (!cached) {
    cached = initializerBindings(index.files.read(init));
    index.initializers.set(init, cached);
  }
  return cached;
}

/** Resolves a module path (top-level location + remaining parts) and the names imported from it. */
function resolveModule(index: PythonIndex, from: string, topBase: string, rest: string[], names: string[] | undefined): SpecifierResolution {
  const walked = walkModule(index, topBase, rest);
  if (!walked) return { kind: 'unresolved', reasonCode: 'target-missing' };
  // Initializers on the way run before the module (`import a.b.c` runs a/ and a/b/__init__.py).
  const paths = new Set(walked.inits.filter((init) => !containsImporter(init, from)));
  const leaf = leafFile(walked.leaf);
  // The leaf itself: always for `import x` and plain modules; for a package's from-import only
  // when a name comes out of its __init__.py (an attribute, a star import or an ambiguous name).
  let readsLeaf = names === undefined || walked.leaf.kind === 'module';
  let incompleteReason: string | undefined;
  for (const name of names ?? []) {
    if (name === '*') {
      readsLeaf = true;
      // `from pkg import *` also imports the submodules a package lists in `__all__`.
      if (walked.leaf.kind === 'package' && bindingsOf(index, walked.leaf.init).other.has('__all__')) {
        incompleteReason ??= `from ${posix.basename(walked.base)} import *: __all__ may name submodules`;
      }
      continue;
    }
    if (walked.leaf.kind === 'module') continue; // an attribute of a plain module
    const sub = lookupModule(index, join(walked.base, name));
    if (sub.kind === 'missing') {
      // Not a submodule: an attribute of the package (or an ImportError). A namespace has no attributes.
      if (walked.leaf.kind === 'namespace') return { kind: 'unresolved', reasonCode: 'target-missing' };
      readsLeaf = true;
      continue;
    }
    if (walked.leaf.kind === 'package') {
      // `from pkg import name` takes pkg's attribute if `__init__.py` binds one; only then does it skip the submodule.
      const bindings = bindingsOf(index, walked.leaf.init);
      const viaSubmodule = bindings.submodules.get(name);
      const attribute = bindings.dynamic || bindings.other.has(name) || (viaSubmodule !== undefined && viaSubmodule !== name);
      if (attribute) {
        incompleteReason ??= `from ${posix.basename(walked.base)} import ${name}: ${name} may be an attribute of ${walked.leaf.init} or the submodule`;
        readsLeaf = true;
        continue;
      }
    }
    const subFile = leafFile(sub);
    if (subFile !== undefined) paths.add(subFile);
  }
  // A package whose submodules are imported still runs its __init__.py first, unless it contains the importer.
  if (leaf !== undefined && (readsLeaf || (walked.leaf.kind === 'package' && !containsImporter(leaf, from)))) paths.add(leaf);
  const targets: AnalysisTarget[] = [...paths].sort().map((path) => ({ path, via: 'python-module' }));
  return { kind: 'files', targets, ...(incompleteReason ? { incompleteReason } : {}) };
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
    const mapped = [...index.mappedPackages.values()].flat().find((dir) => from.startsWith(`${dir}/`));
    const root = mapped !== undefined ? dirOf(mapped) : rootOf(index, from);
    // Inside a remapped package (`package-dir`), the package directory sits directly under its parent.
    const relDir = root === '' ? dirOf(from) : dirOf(from).slice(root.length + 1);
    const packageParts = relDir === '' ? [] : relDir.split('/');
    // `from . import x` needs a package; each extra dot climbs one level, never above the root.
    if (level > packageParts.length) return { kind: 'unresolved', reasonCode: 'target-missing' };
    const all = [...packageParts.slice(0, packageParts.length - (level - 1)), ...parts];
    return resolveModule(index, from, join(root, all[0]!), all.slice(1), item.names);
  }

  const top = parts[0];
  if (top === undefined) return { kind: 'unresolved', reasonCode: 'invalid-target' };
  const roots = index.nameRoots.get(top) ?? [];
  const mapped = index.mappedPackages.get(top) ?? [];
  if (roots.length + mapped.length > 1) return { kind: 'unresolved', reasonCode: 'ambiguous-package' };
  if (mapped.length === 1) return resolveModule(index, from, mapped[0]!, parts.slice(1), item.names);
  if (roots.length === 1) return resolveModule(index, from, join(roots[0]!, top), parts.slice(1), item.names);
  // Not in any known root. A same-named package elsewhere in the repo, or a sibling of a
  // script (Python puts the script's folder on sys.path), means a layout we do not model.
  const fromDir = dirOf(from);
  const scriptDir = !index.pyFiles.has(join(fromDir, '__init__.py'));
  const sibling = scriptDir ? lookupModule(index, join(fromDir, top)) : { kind: 'missing' as const };
  if (index.strayPackages.has(top) || sibling.kind !== 'missing') return { kind: 'unresolved', reasonCode: 'unknown-package' };
  if (index.layoutUncertain.length > 0 && !PYTHON_STDLIB_MODULES.has(top)) return { kind: 'unresolved', reasonCode: 'unsupported-config' };
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
