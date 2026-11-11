import { posix } from 'node:path';
import type { AnalysisSession, AnalysisTarget, ExtractedSpecifier, Extraction, ImportTargetRole, LanguageAnalyzer, SpecifierResolution } from './analysis.js';
import { PYTHON_STDLIB_MODULES } from './python-stdlib.js';
import { isTomlTable, parseTomlSubset, TomlSubsetError, tomlGet, type TomlTable, type TomlValue } from './toml.js';
import { repoDirname as dirOf, type RepoFiles } from './tree-files.js';

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
  /** Inside a `def` or `class` body (not module scope). */
  scoped?: boolean;
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
 * Tokenizes Python source just far enough to find imports.
 * - The expressions inside f-string replacement fields are tokenized too (they run code,
 *   so they can load modules); their tokens follow the string token and never start a
 *   statement. A field's format spec is literal text, except for its own nested fields.
 * - Each token records whether it sits inside a `def` or `class` body (`scoped`), from
 *   the indentation of logical lines, so module-level bindings can be told apart.
 * Throws `PythonLexError`.
 */
export function tokenizePython(text: string, depth = 0): Token[] {
  if (depth > MAX_FSTRING_DEPTH) throw new PythonLexError('f-strings nested too deeply');
  const tokens: Token[] = [];
  let i = 0;
  let brackets = 0;
  let start = true;
  // Indentation-based scope tracking.
  const blocks: { indent: number; scoped: boolean }[] = [];
  let lineIndent = 0;
  let lineStart = 0;
  let atLineStart = true;
  let statementIndent = 0;
  let statementScoped = false;
  let statementHead: string | undefined;
  let previousSeparator: 'newline' | ';' | ':' = 'newline';

  const beginStatement = (head: string) => {
    const indent =
      previousSeparator === 'newline' ? lineIndent : previousSeparator === ';' ? statementIndent : statementIndent + 0.5;
    while (blocks.length > 0 && blocks[blocks.length - 1]!.indent >= indent) blocks.pop();
    statementIndent = indent;
    statementScoped = blocks.some((block) => block.scoped);
    statementHead = head;
  };

  const push = (token: Omit<Token, 'start'>) => {
    if (start && token.type !== 'newline') beginStatement(token.type === 'name' ? token.value : '');
    tokens.push({ ...token, start, ...(statementScoped ? { scoped: true } : {}) });
    if (token.type === 'op' && token.value === ':' && brackets === 0 && statementHead !== undefined && COMPOUND_HEADS.has(statementHead)) {
      blocks.push({ indent: statementIndent, scoped: statementHead === 'def' || statementHead === 'class' || statementHead === 'async' });
      statementHead = undefined;
    }
    start = token.type === 'newline' || (token.type === 'op' && (token.value === ';' || (token.value === ':' && brackets === 0)));
    if (start) previousSeparator = token.type === 'newline' ? 'newline' : (token.value as ';' | ':');
  };

  /**
   * Scans an f-string `{…}` field starting after its `{`. Returns the index after its `}`
   * and the ranges of code inside it: the expression, and the expressions of fields nested
   * in its format spec. The spec itself (after a top-level `:` or `!`) is literal text.
   */
  const scanField = (at: number, multiline: boolean): { end: number; code: [number, number][] } => {
    let j = at;
    let nested = 0;
    let spec = false;
    const code: [number, number][] = [];
    let exprEnd = -1;
    for (;;) {
      if (j >= text.length) throw new PythonLexError('unterminated f-string expression');
      const ch = text[j]!;
      if (ch === '\n' && !multiline && (spec || nested === 0)) throw new PythonLexError('unterminated f-string expression');
      if (spec) {
        if (ch === '{') {
          const inner = scanField(j + 1, multiline);
          code.push(...inner.code);
          j = inner.end;
          continue;
        }
        if (ch === '}') {
          code.unshift([at, exprEnd]);
          return { end: j + 1, code };
        }
        j++;
        continue;
      }
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
      else if (nested === 0 && (ch === ':' || (ch === '!' && text[j + 1] !== '='))) {
        // Start of the conversion (`!r`) or format spec: no longer code.
        exprEnd = j;
        spec = true;
      } else if (ch === '}') {
        if (nested === 0) {
          code.unshift([at, j]);
          return { end: j + 1, code };
        }
        nested--;
      }
      j++;
    }
  };

  /** Scans a string literal starting at its opening quote. */
  const scanString = (at: number, prefix: string): { end: number; literal?: string; code: [number, number][] } => {
    const quote = text[at]!;
    const triple = text.startsWith(quote.repeat(3), at);
    const formatted = /[fFtT]/.test(prefix);
    let j = at + (triple ? 3 : 1);
    const contentStart = j;
    let escaped = false;
    const code: [number, number][] = [];
    for (;;) {
      if (j >= text.length) throw new PythonLexError(triple ? 'unterminated triple-quoted string' : 'unterminated string');
      const ch = text[j]!;
      if (triple ? text.startsWith(quote.repeat(3), j) : ch === quote) {
        const end = j + (triple ? 3 : 1);
        return { end, ...(!escaped && !formatted ? { literal: text.slice(contentStart, j) } : {}), code };
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
        const field = scanField(j + 1, triple);
        code.push(...field.code);
        j = field.end;
        continue;
      }
      j++;
    }
  };

  /** Finds the end of a string inside a replacement field (its own fields are tokenized with the expression). */
  const skipString = (at: number, prefix: string): number => scanString(at, prefix).end;

  const pushString = (from: number, prefix: string, quoteAt: number) => {
    const { end, literal, code } = scanString(quoteAt, prefix);
    const special = /[fFtTbB]/.test(prefix);
    push({ type: 'string', value: text.slice(from, end), ...(special ? { special } : {}), ...(literal !== undefined && !special ? { literal } : {}) });
    for (const [codeStart, codeEnd] of code) {
      for (const token of tokenizePython(text.slice(codeStart, codeEnd), depth + 1)) {
        if (token.type !== 'newline') tokens.push({ ...token, start: false, ...(statementScoped ? { scoped: true } : {}) });
      }
    }
    i = end;
  };

  while (i < text.length) {
    const ch = text[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\f' || ch === '\r' || ch === '﻿') {
      i++;
      continue;
    }
    if (ch === '\n') {
      if (brackets === 0) {
        push({ type: 'newline', value: '\n' });
        atLineStart = true;
      }
      i++;
      lineStart = i;
      continue;
    }
    if (ch === '#') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (atLineStart && brackets === 0) {
      // Indentation of this logical line (tabs to the next multiple of 8, as Python does).
      let column = 0;
      for (let k = lineStart; k < i; k++) column = text[k] === '\t' ? (Math.floor(column / 8) + 1) * 8 : column + 1;
      lineIndent = column;
      atLineStart = false;
    }
    if (ch === '\\') {
      if (text[i + 1] === '\n') i += 2;
      else if (text[i + 1] === '\r' && text[i + 2] === '\n') i += 3;
      else throw new PythonLexError('unexpected backslash');
      lineStart = i;
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

/** Statements that open an indented block; `def`, `class` and `async` (def) bodies are not module scope. */
const COMPOUND_HEADS = new Set(['def', 'class', 'async', 'if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with', 'match', 'case']);

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
 * (with/except), `global` and walrus targets. With `moduleOnly`, bindings inside
 * `def`/`class` bodies and parameters are skipped: they are not module attributes
 * (a `global` declaration still is).
 */
function nonImportBindings(tokens: Token[], inImport: (index: number) => boolean, moduleOnly = false): Set<string> {
  const bound = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.type !== 'name' || inImport(i)) continue;
    const next = tokens[i + 1];
    if (token.value === 'global' && isName(next)) {
      for (let j = i + 1; j < tokens.length && (tokens[j]!.type === 'name' || isOp(tokens[j], ',')); j++) {
        if (tokens[j]!.type === 'name') bound.add(tokens[j]!.value);
      }
      continue;
    }
    if (moduleOnly && token.scoped) continue;
    if ((token.value === 'def' || token.value === 'class') && isName(next)) {
      bound.add(next!.value);
      if (!moduleOnly && token.value === 'def' && isOp(tokens[i + 2], '(')) {
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
      if (!moduleOnly) for (let j = i + 1; j < tokens.length && !isOp(tokens[j], ':'); j++) if (tokens[j]!.type === 'name') bound.add(tokens[j]!.value);
    } else if ((token.value === 'for' || token.value === 'as' || token.value === 'del' || token.value === 'nonlocal') && isName(next)) {
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

/** What a call to a loader does with its arguments. */
type LoaderKind =
  /** `importlib.import_module(name)`, `runpy.run_module(name)`: loads (and runs) the named module. */
  | 'module'
  /** `__import__(name, globals, locals, fromlist, level)`. */
  | 'dunder-import'
  /** `exec(code)` / `eval(code)`: runs source text, which may import. */
  | 'exec'
  /** `runpy.run_path`, `importlib.util.spec_from_file_location`, `SourceFileLoader`, `imp.load_source`: loads a file by path. */
  | 'path';

/** Attribute calls that load code by file path, whatever the owner is called. */
const PATH_LOADER_ATTRIBUTES = new Set(['spec_from_file_location', 'spec_from_loader', 'SourceFileLoader', 'SourcelessFileLoader', 'ExtensionFileLoader', 'load_source', 'load_compiled', 'load_dynamic', 'load_package', 'run_path']);
/** Loader functions reachable as attributes of these modules (or their aliases). */
const LOADER_MODULES: Record<string, Record<string, LoaderKind>> = {
  importlib: { import_module: 'module', __import__: 'dunder-import' },
  builtins: { __import__: 'dunder-import', exec: 'exec', eval: 'exec' },
  runpy: { run_module: 'module', run_path: 'path' },
  'importlib.util': { spec_from_file_location: 'path', spec_from_loader: 'path' },
  'importlib.machinery': { SourceFileLoader: 'path', SourcelessFileLoader: 'path', ExtensionFileLoader: 'path' },
  imp: { load_source: 'path', load_compiled: 'path', load_dynamic: 'path', load_package: 'path', load_module: 'path' },
};
const MAX_EXEC_DEPTH = 2;

interface CallArgument {
  keyword?: string;
  tokens: Token[];
}

/** The arguments of the call whose `(` is at `open`, split on top-level commas. */
function callArguments(tokens: Token[], open: number): CallArgument[] {
  const args: CallArgument[] = [];
  let current: Token[] = [];
  let depth = 0;
  for (let j = open; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (isOp(t, '(') || isOp(t, '[') || isOp(t, '{')) {
      depth++;
      if (depth === 1) continue;
    } else if (isOp(t, ')') || isOp(t, ']') || isOp(t, '}')) {
      depth--;
      if (depth === 0) break;
    } else if (depth === 1 && isOp(t, ',')) {
      args.push(splitKeyword(current));
      current = [];
      continue;
    }
    current.push(t);
  }
  if (current.length > 0) args.push(splitKeyword(current));
  return args;
}

function splitKeyword(tokens: Token[]): CallArgument {
  if (tokens.length >= 2 && tokens[0]!.type === 'name' && isOp(tokens[1], '=') && !isOp(tokens[2], '=')) return { keyword: tokens[0]!.value, tokens: tokens.slice(2) };
  return { tokens };
}

/** A plain (non-f, non-bytes, escape-free) string literal argument. */
function literalArgument(arg: CallArgument | undefined): string | undefined {
  if (!arg || arg.tokens.length !== 1) return undefined;
  const t = arg.tokens[0]!;
  return t.type === 'string' && !t.special ? t.literal : undefined;
}

/** `__import__`'s `fromlist`: none, a literal list/tuple of names, or something computed. */
function fromlistArgument(arg: CallArgument | undefined): string[] | 'none' | 'computed' {
  if (!arg) return 'none';
  const t = arg.tokens;
  if (t.length === 1 && isName(t[0], 'None')) return 'none';
  const open = t[0];
  const close = t[t.length - 1];
  if (!((isOp(open, '[') && isOp(close, ']')) || (isOp(open, '(') && isOp(close, ')')))) return 'computed';
  const names: string[] = [];
  for (let k = 1; k < t.length - 1; k++) {
    const item = t[k]!;
    if (k % 2 === 1) {
      const literal = item.type === 'string' && !item.special ? item.literal : undefined;
      if (literal === undefined || !/^(?:\*|[\p{L}_][\p{L}\p{N}_]*)$/u.test(literal)) return 'computed';
      names.push(literal);
    } else if (!isOp(item, ',')) return 'computed';
  }
  return names;
}

/** Import statements and dynamic loads of one Python file. */
export function extractPythonImports(text: string, execDepth = 0): PythonExtraction {
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

  // Loader bindings: module aliases (`import importlib as il`, `import runpy`) and function
  // aliases (`from importlib import import_module as load`, `from runpy import run_path`).
  const loaderModules = new Map<string, string>(Object.keys(LOADER_MODULES).filter((m) => !m.includes('.')).map((m) => [m, m]));
  const loaderFunctions = new Map<string, LoaderKind>([
    ['__import__', 'dunder-import'],
    ['import_module', 'module'],
    ['exec', 'exec'],
    ['eval', 'exec'],
  ]);
  const importBound = new Set<string>();
  for (const statement of statements) {
    for (const binding of statement.bindings) {
      if (binding.name === undefined) {
        // `import importlib.util` binds `importlib`; `import importlib.util as u` binds u to importlib.util.
        const target = binding.bound === binding.module.split('.')[0] ? binding.module.split('.')[0]! : binding.module;
        if (LOADER_MODULES[target]) loaderModules.set(binding.bound, target);
        else importBound.add(binding.bound);
      } else if (binding.name === '*') {
        for (const [name, kind] of Object.entries(LOADER_MODULES[binding.module] ?? {})) loaderFunctions.set(name, kind);
      } else {
        const kind = LOADER_MODULES[binding.module]?.[binding.name];
        if (kind) loaderFunctions.set(binding.bound, kind);
        else if (LOADER_MODULES[`${binding.module}.${binding.name}`]) loaderModules.set(binding.bound, `${binding.module}.${binding.name}`);
        else importBound.add(binding.bound);
      }
    }
  }
  const rebound = nonImportBindings(tokens, inImport);
  for (const name of importBound) rebound.add(name);

  let dynamicLoads = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (inImport(i)) continue;
    const token = tokens[i]!;
    if (token.type !== 'name') continue;
    const previous = tokens[i - 1];
    if (isName(previous, 'def') || isName(previous, 'class')) continue;
    const viaAttribute = isOp(previous, '.');
    let kind: LoaderKind | undefined;
    let shadowed = false;
    if (viaAttribute) {
      const owner = tokens[i - 2];
      const ownerModule = owner?.type === 'name' && !isOp(tokens[i - 3], '.') ? loaderModules.get(owner.value) : undefined;
      kind = ownerModule ? LOADER_MODULES[ownerModule]?.[token.value] : undefined;
      // `importlib.util.spec_from_file_location(…)` and similar path loaders, whatever the owner chain.
      if (!kind && PATH_LOADER_ATTRIBUTES.has(token.value)) kind = 'path';
      shadowed = ownerModule !== undefined && owner !== undefined && rebound.has(owner.value);
    } else {
      kind = loaderFunctions.get(token.value);
      shadowed = rebound.has(token.value);
    }
    if (!kind) continue;
    const next = tokens[i + 1];
    if (!isOp(next, '(')) {
      // `f(import_module=True)`, `def f(import_module: …)`: a keyword, not the loader.
      if ((isOp(next, '=') && !isOp(tokens[i + 2], '=')) || (isOp(next, ':') && (isOp(previous, '(') || isOp(previous, ',')))) continue;
      // A rebound name, or `exec`/`eval` mentioned without a call, loads nothing here.
      if ((shadowed && !viaAttribute) || kind === 'exec') continue;
      // The loader escapes (`f = importlib.import_module`): later calls cannot be followed.
      dynamicLoads++;
      continue;
    }
    if (shadowed) {
      // A rebound name could be any function; its call is an uncertain load, never an edge.
      dynamicLoads++;
      continue;
    }
    const args = callArguments(tokens, i + 1);
    const positional = args.filter((arg) => arg.keyword === undefined);
    const named = (keyword: string, position: number) => args.find((arg) => arg.keyword === keyword) ?? (positional.length > position ? positional[position] : undefined);
    if (kind === 'path') {
      dynamicLoads++;
    } else if (kind === 'module') {
      const literal = literalArgument(named('name', 0) ?? named('mod_name', 0));
      if (literal !== undefined && MODULE_NAME.test(literal)) add({ specifier: literal, kind: 'dynamic' });
      else dynamicLoads++;
    } else if (kind === 'dunder-import') {
      const literal = literalArgument(named('name', 0));
      const level = named('level', 4);
      const relative = level !== undefined && !(level.tokens.length === 1 && level.tokens[0]!.value === '0');
      if (literal === undefined || relative || !MODULE_NAME.test(literal)) {
        dynamicLoads++;
      } else {
        // `__import__('pkg', fromlist=['child'])` also imports pkg.child, like `from pkg import child`.
        const fromlist = fromlistArgument(named('fromlist', 3));
        if (fromlist === 'computed') {
          add({ specifier: literal, kind: 'dynamic' });
          dynamicLoads++;
        } else if (fromlist === 'none' || fromlist.length === 0) {
          add({ specifier: literal, kind: 'dynamic' });
        } else {
          add({ specifier: literal, kind: 'dynamic', names: fromlist });
        }
      }
    } else {
      // exec/eval: literal source is read for imports; anything computed could import anything.
      const literal = literalArgument(named('source', 0) ?? named('expression', 0));
      if (literal === undefined || execDepth >= MAX_EXEC_DEPTH) {
        dynamicLoads++;
      } else {
        const inner = extractPythonImports(literal, execDepth + 1);
        for (const item of inner.imports) add({ ...item, kind: 'dynamic' });
        dynamicLoads += inner.dynamicLoads + (inner.error !== undefined ? 1 : 0);
      }
    }
  }
  return { imports, dynamicLoads, ...(error ? { error } : {}) };
}

/** What a package `__init__.py` binds, for telling `from pkg import name` attributes from submodules. */
export interface InitializerBindings {
  /** The initializer could not be read or binds names dynamically (`__getattr__`, star imports, `globals()`, …). */
  dynamic: boolean;
  /**
   * The only dynamic trait is a module-level `def __getattr__` (PEP 562). It is consulted only for
   * names the module does not bind, so a submodule on disk that no other binding names is the
   * probable target of `from pkg import name` (a heuristic edge, RA-20).
   */
  lazyGetattrOnly?: boolean;
  /** `from . import a [as b]` at module level: b → a. */
  submodules: Map<string, string>;
  /** Module-level names bound any other way (assignment, def, class, other imports, …). */
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
    // An import inside a function body binds a local name (any submodule it loads is the same submodule).
    if (parsed.tokens[statement.from]?.scoped) continue;
    for (const binding of statement.bindings) {
      if (binding.bound === '*') result.dynamic = true;
      else if (binding.module === '.' && binding.name !== undefined) result.submodules.set(binding.bound, binding.name);
      else result.other.add(binding.bound);
    }
  }
  // These can bind module attributes from anywhere, including function bodies that run later.
  const starOrDynamicImport = result.dynamic;
  let otherDynamic = false;
  let getattrToken = false;
  for (const token of parsed.tokens) {
    if (token.type !== 'name' || !DYNAMIC_NAMESPACE.has(token.value)) continue;
    if (token.value === '__getattr__') getattrToken = true;
    else otherDynamic = true;
  }
  for (let i = 0; i < parsed.tokens.length; i++) {
    if (isName(parsed.tokens[i], 'modules') && isOp(parsed.tokens[i - 1], '.') && isName(parsed.tokens[i - 2], 'sys')) otherDynamic = true;
  }
  result.dynamic = starOrDynamicImport || otherDynamic || getattrToken;
  for (const name of nonImportBindings(parsed.tokens, (index) => importTokens.has(index), true)) result.other.add(name);
  // `__getattr__` is named once by its own `def` and nowhere else (no `getattr(mod, '__getattr__')` games).
  const getattrUses = parsed.tokens.filter((token) => token.type === 'name' && token.value === '__getattr__').length;
  if (getattrToken && !starOrDynamicImport && !otherDynamic && getattrUses === 1 && result.other.has('__getattr__')) result.lazyGetattrOnly = true;
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
   * Why a manifest could declare any package name (unreadable, oversized, TOML outside the
   * subset, a computed `package_dir`). When set, a top-level name that is neither local nor
   * standard library is unresolved (`unsupported-config`) instead of external.
   */
  layoutUncertain: string[];
  /** Top-level names a manifest declares in a form we do not model: unresolved (`unsupported-config`). */
  uncertainNames: Set<string>;
  initializers: Map<string, InitializerBindings>;
  warnings: string[];
}

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

/**
 * Where a project's packages live, as one manifest declares it (paths relative to the
 * manifest's directory). `uncertainNames` are top-level names declared in a form we do
 * not model (e.g. a dotted `package-dir` key); `uncertainAll` means the manifest could
 * declare any name (we could not read the relevant part at all).
 */
export interface PythonLayout {
  roots: string[];
  packages: [string, string][];
  uncertainNames: string[];
  uncertainAll: boolean;
  unsupported: string[];
}

const emptyLayout = (): PythonLayout => ({ roots: [], packages: [], uncertainNames: [], uncertainAll: false, unsupported: [] });
const PACKAGE_NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/** A setuptools `package_dir` entry: `""` is a root, a plain name is a package remap, a dotted name is not modeled. */
function packageDirEntry(layout: PythonLayout, key: string, dir: string, origin: string): void {
  if (key === '') layout.roots.push(dir);
  // `{public = "impl"}`: the top-level package `public` lives in `impl/`.
  else if (PACKAGE_NAME.test(key)) layout.packages.push([key, dir]);
  else {
    // A dotted key remaps a subpackage of its top-level package.
    layout.unsupported.push(`${origin}.${key}`);
    layout.uncertainNames.push(key.split('.')[0]!);
  }
}

/** Source roots and package mappings a pyproject.toml declares (setuptools, poetry, hatch). */
export function pyprojectRoots(toml: TomlTable): PythonLayout {
  const layout = emptyLayout();
  const unknown = (key: string) => {
    layout.unsupported.push(key);
    layout.uncertainAll = true;
  };
  const where = tomlGet(toml, ['tool', 'setuptools', 'packages', 'find', 'where']);
  if (where !== undefined) {
    const list = strings(where);
    if (list) layout.roots.push(...list);
    else unknown('tool.setuptools.packages.find.where');
  }
  const packageDir = tomlGet(toml, ['tool', 'setuptools', 'package-dir']);
  if (packageDir !== undefined) {
    if (!isTomlTable(packageDir)) unknown('tool.setuptools.package-dir');
    else {
      for (const key of Object.keys(packageDir).sort()) {
        const dir = packageDir[key];
        if (typeof dir !== 'string') unknown(`tool.setuptools.package-dir.${key}`);
        else packageDirEntry(layout, key, dir, 'tool.setuptools.package-dir');
      }
    }
  }
  const poetry = tomlGet(toml, ['tool', 'poetry', 'packages']);
  if (poetry !== undefined) {
    if (!Array.isArray(poetry)) unknown('tool.poetry.packages');
    else {
      for (const entry of poetry) {
        if (!isTomlTable(entry) || typeof entry.include !== 'string') {
          unknown('tool.poetry.packages');
          continue;
        }
        const from = entry.from;
        if (from !== undefined && typeof from !== 'string') unknown('tool.poetry.packages.from');
        else layout.roots.push(from ?? '.');
      }
    }
  }
  const hatch = tomlGet(toml, ['tool', 'hatch', 'build', 'targets', 'wheel', 'packages']);
  if (hatch !== undefined) {
    const list = strings(hatch);
    if (!list) unknown('tool.hatch.build.targets.wheel.packages');
    // Hatch lists package paths (`src/foo`): the root is their parent directory.
    else for (const item of list) layout.roots.push(posix.dirname(posix.normalize(item.replace(/\\/g, '/')).replace(/\/$/, '')) || '.');
  }
  const sources = tomlGet(toml, ['tool', 'hatch', 'build', 'targets', 'wheel', 'sources']);
  if (sources !== undefined) {
    // `sources = {"src" = ""}` makes src a root; `{"lib/impl" = "public"}` installs lib/impl as `public`.
    if (Array.isArray(sources) && sources.every((item) => typeof item === 'string')) {
      for (const item of sources as string[]) layout.roots.push(item);
    } else if (!isTomlTable(sources)) {
      unknown('tool.hatch.build.targets.wheel.sources');
    } else {
      for (const key of Object.keys(sources).sort()) {
        const target = sources[key];
        if (typeof target !== 'string') unknown(`tool.hatch.build.targets.wheel.sources.${key}`);
        else if (target === '' || target === '.') layout.roots.push(key);
        else if (PACKAGE_NAME.test(target)) layout.packages.push([target, key]);
        else {
          layout.unsupported.push(`tool.hatch.build.targets.wheel.sources.${key}`);
          layout.uncertainNames.push(target.split('/')[0]!);
        }
      }
    }
  }
  return layout;
}

/** `setup.cfg` `[options] package_dir` and `[options.packages.find] where` (INI, never executed). */
export function setupCfgLayout(text: string): PythonLayout {
  const layout = emptyLayout();
  let section = '';
  let key: string | undefined;
  const values = new Map<string, string[]>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^\s*[#;]/.test(line) || line.trim() === '') continue;
    const header = /^\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      section = header[1]!.trim();
      key = undefined;
      continue;
    }
    if (/^\s/.test(line) && key !== undefined) {
      values.get(key)!.push(line.trim());
      continue;
    }
    const entry = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(line);
    if (!entry) continue;
    key = `${section}.${entry[1]!.trim()}`;
    values.set(key, entry[2]!.trim() === '' ? [] : [entry[2]!.trim()]);
  }
  for (const line of values.get('options.package_dir') ?? []) {
    const pair = /^([^=]*?)\s*=\s*(\S+)$/.exec(line);
    if (!pair) {
      layout.unsupported.push('options.package_dir');
      layout.uncertainAll = true;
      continue;
    }
    packageDirEntry(layout, pair[1]!.trim(), pair[2]!, 'options.package_dir');
  }
  for (const line of values.get('options.packages.find.where') ?? []) layout.roots.push(...line.split(/[\s,]+/).filter(Boolean));
  return layout;
}

/**
 * `setup.py` read as text, never executed: a literal `package_dir={...}` dict and
 * `find_packages(where='…')`. Any other `package_dir` (a variable, a computed dict) could
 * remap any name.
 */
export function setupPyLayout(text: string): PythonLayout {
  const layout = emptyLayout();
  const mentions = text.match(/\bpackage_dir\b/g)?.length ?? 0;
  let literals = 0;
  for (const match of text.matchAll(/\bpackage_dir\s*=\s*\{([^{}]*)\}/g)) {
    literals++;
    let rest = match[1]!;
    for (const pair of match[1]!.matchAll(/(['"])(.*?)\1\s*:\s*(['"])(.*?)\3/g)) {
      packageDirEntry(layout, pair[2]!, pair[4]!, 'setup.py package_dir');
      rest = rest.replace(pair[0], '');
    }
    if (rest.replace(/[\s,]/g, '') !== '') {
      layout.unsupported.push('setup.py package_dir');
      layout.uncertainAll = true;
    }
  }
  if (mentions > literals) {
    layout.unsupported.push('setup.py package_dir');
    layout.uncertainAll = true;
  }
  for (const match of text.matchAll(/\bfind(?:_namespace)?_packages\s*\(\s*(?:where\s*=\s*)?(['"])(.*?)\1/g)) layout.roots.push(match[2]!);
  return layout;
}

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
    uncertainNames: new Set(),
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
    // Code outside the repository cannot be a partner file: imports of it stay external.
    if (dir === undefined) index.warnings.push(`Python: ${origin} points outside the repository; ignored.`);
    else if (dir === '' || index.pyDirs.has(dir)) roots.add(dir);
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
  const apply = (manifest: string, dir: string, layout: PythonLayout) => {
    for (const key of layout.unsupported) {
      const warning = `Python: ${manifest} ${key} has an unsupported form (unsupported-config).`;
      if (layout.uncertainAll) uncertain(warning);
      else index.warnings.push(warning);
    }
    for (const name of layout.uncertainNames) index.uncertainNames.add(name);
    // A project with no declared layout is flat or src/-based; one manifest per directory is enough for that.
    if (layout.roots.length === 0 && layout.packages.length === 0) {
      if (!fallbackDirs.has(dir)) fallback(dir);
    }
    fallbackDirs.add(dir);
    for (const root of layout.roots) addRoot(within(dir, root), `${manifest} source root ${JSON.stringify(root)}`);
    for (const [name, target] of layout.packages) {
      const mapped = within(dir, target);
      if (mapped === undefined || mapped === '') {
        index.warnings.push(`Python: ${manifest} maps package ${name} to ${JSON.stringify(target)}, outside the repository; ignored.`);
        continue;
      }
      const list = index.mappedPackages.get(name) ?? [];
      list.push(mapped);
      index.mappedPackages.set(name, list);
    }
  };
  const fallbackDirs = new Set<string>();
  let manifests = 0;
  for (const { dir, manifest, setup } of projectDirs) {
    const path = (manifest ?? setup)!;
    if (++manifests > MAX_PYPROJECTS) {
      uncertain(`Python: more than ${MAX_PYPROJECTS} project manifests; the rest were not read (unsupported-config).`);
      fallback(dir);
      continue;
    }
    const { text, why } = readManifest(path);
    if (text === undefined) {
      uncertain(`Python: ${path} is ${why}, so it was not read (unsupported-config).`);
      fallback(dir);
      continue;
    }
    if (setup) {
      // Read as text only; setup.py is never executed.
      apply(path, dir, path.endsWith('.cfg') ? setupCfgLayout(text) : setupPyLayout(text));
      continue;
    }
    let toml: TomlTable;
    try {
      toml = parseTomlSubset(text);
    } catch (error) {
      if (!(error instanceof TomlSubsetError)) throw error;
      uncertain(`Python: ${path} uses TOML outside the supported subset (unsupported-config: ${error.message}).`);
      fallback(dir);
      continue;
    }
    apply(path, dir, pyprojectRoots(toml));
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

/** The direct submodules of a package directory: its modules and its subpackages' initializers. */
function submoduleFiles(index: PythonIndex, base: string): string[] {
  const out: string[] = [];
  for (const file of index.pyFiles) {
    if (dirOf(file) === base && posix.basename(file) !== '__init__.py') out.push(file);
    else if (posix.basename(file) === '__init__.py' && dirOf(dirOf(file)) === base && dirOf(file) !== base) out.push(file);
  }
  return out.sort();
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
  // What each target is to the import (RA-20): set once per path, a certain target wins over a heuristic one.
  const targets = new Map<string, AnalysisTarget>();
  const add = (path: string, role: ImportTargetRole, extra: { name?: string; probable?: boolean } = {}) => {
    const existing = targets.get(path);
    if (existing && !(existing.graphOnly && !extra.probable)) return;
    targets.set(path, {
      path,
      via: 'python-module',
      ...(extra.probable ? { heuristic: true, graphOnly: true } : {}),
      role,
      ...(extra.name !== undefined ? { name: extra.name } : {}),
    });
  };
  // Initializers on the way run before the module (`import a.b.c` runs a/ and a/b/__init__.py).
  for (const init of walked.inits) if (!containsImporter(init, from)) add(init, 'init');
  const leaf = leafFile(walked.leaf);
  // The leaf itself: always for `import x` and plain modules; for a package's from-import only
  // when a name comes out of its __init__.py (an attribute, a star import or an ambiguous name).
  let readsLeaf = names === undefined || walked.leaf.kind === 'module';
  const uncertain: { path: string; reason: string }[] = [];
  for (const name of names ?? []) {
    if (name === '*') {
      readsLeaf = true;
      // `from pkg import *` also imports the submodules a package lists in `__all__`.
      if (walked.leaf.kind === 'package' && bindingsOf(index, walked.leaf.init).other.has('__all__')) {
        for (const child of submoduleFiles(index, walked.base)) {
          uncertain.push({ path: child, reason: `from ${posix.basename(walked.base)} import *: __all__ may name this submodule` });
        }
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
    const subFile = leafFile(sub);
    if (walked.leaf.kind === 'package') {
      // `from pkg import name` takes pkg's attribute if `__init__.py` binds one; only then does it skip the submodule.
      const bindings = bindingsOf(index, walked.leaf.init);
      const viaSubmodule = bindings.submodules.get(name);
      const bound = bindings.other.has(name) || (viaSubmodule !== undefined && viaSubmodule !== name);
      if (bindings.dynamic && !bound && bindings.lazyGetattrOnly && subFile !== undefined) {
        // RA-20: a PEP 562 `__getattr__` only answers names the package does not bind, so the submodule
        // on disk is the probable target; but `__getattr__` could still return something else. The
        // graph lists it as a heuristic edge; it stays uncertain, so relationships never claim it.
        readsLeaf = true;
        add(subFile, 'name', { name, probable: true });
        uncertain.push({ path: subFile, reason: `from ${posix.basename(walked.base)} import ${name}: ${name} may be an attribute of ${walked.leaf.init} or the submodule` });
        continue;
      }
      if (bindings.dynamic || bound) {
        const reason = `from ${posix.basename(walked.base)} import ${name}: ${name} may be an attribute of ${walked.leaf.init} or the submodule`;
        if (subFile !== undefined) uncertain.push({ path: subFile, reason });
        readsLeaf = true;
        continue;
      }
    }
    if (subFile !== undefined) add(subFile, 'name', { name });
  }
  // A package whose submodules are imported still runs its __init__.py first, unless it contains the importer.
  if (leaf !== undefined && (readsLeaf || (walked.leaf.kind === 'package' && !containsImporter(leaf, from)))) add(leaf, 'module');
  const sorted = [...targets.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { kind: 'files', targets: sorted, ...(uncertain.length > 0 ? { uncertain } : {}) };
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
  // Declared in a form we do not model (a dotted package-dir key, a nested hatch source).
  if (index.uncertainNames.has(top)) return { kind: 'unresolved', reasonCode: 'unsupported-config' };
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
