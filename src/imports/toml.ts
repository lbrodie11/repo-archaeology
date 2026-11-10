/**
 * A minimal, dependency-free TOML subset reader for `pyproject.toml` (RA-10).
 *
 * Accepted subset:
 * - `# comments`, blank lines;
 * - table headers `[a.b]` and array-of-tables headers `[[a.b]]`, with bare or quoted keys;
 * - `key = value` with bare, quoted or dotted keys;
 * - values: basic strings `"…"` (with escapes), literal strings `'…'`, multi-line
 *   basic `"""…"""` and literal `'''…'''` strings, inline arrays (which may span lines,
 *   with trailing commas and comments), inline tables `{ k = v, … }`, and bare scalars
 *   (integers, floats, booleans, dates), which are kept as raw text.
 * Anything else throws `TomlSubsetError`; callers report `unsupported-config` and carry on.
 * Duplicate keys are not diagnosed (the last value wins).
 */

/** A bare scalar (integer, float, boolean, date) kept as its source text. */
export class TomlScalar {
  constructor(readonly raw: string) {}
}

export type TomlValue = string | TomlValue[] | TomlTable | TomlScalar;
export interface TomlTable {
  [key: string]: TomlValue;
}

export class TomlSubsetError extends Error {}

const MAX_DEPTH = 32;

export function parseTomlSubset(text: string): TomlTable {
  const root = newTable();
  let current: TomlTable = root;
  let pos = 0;
  let line = 1;

  const fail = (message: string): never => {
    throw new TomlSubsetError(`line ${line}: ${message}`);
  };
  const peek = (offset = 0) => text[pos + offset] ?? '';
  const advance = (count = 1) => {
    for (let i = 0; i < count; i++) {
      if (text[pos] === '\n') line++;
      pos++;
    }
  };
  /** Spaces and tabs only. */
  const skipInline = () => {
    while (peek() === ' ' || peek() === '\t') advance();
  };
  const skipComment = () => {
    if (peek() === '#') while (pos < text.length && peek() !== '\n') advance();
  };
  /** Whitespace, newlines and comments (inside arrays). */
  const skipAll = () => {
    for (;;) {
      const ch = peek();
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') advance();
      else if (ch === '#') skipComment();
      else break;
    }
  };
  const endOfLine = () => {
    skipInline();
    skipComment();
    if (peek() === '\r') advance();
    if (pos < text.length && peek() !== '\n') fail(`unexpected ${JSON.stringify(peek())}`);
    if (peek() === '\n') advance();
  };

  const basicString = (): string => {
    const multi = text.startsWith('"""', pos);
    advance(multi ? 3 : 1);
    if (multi && peek() === '\n') advance();
    else if (multi && peek() === '\r' && peek(1) === '\n') advance(2);
    let out = '';
    for (;;) {
      if (pos >= text.length) fail('unterminated string');
      const ch = peek();
      if (multi && text.startsWith('"""', pos)) {
        // `"""""` closes with the last three quotes; up to two before them are content.
        let quotes = 0;
        while (text[pos + quotes] === '"') quotes++;
        if (quotes > 5) fail('too many quotes');
        out += '"'.repeat(quotes - 3);
        advance(quotes);
        return out;
      }
      if (!multi && ch === '"') {
        advance();
        return out;
      }
      if (!multi && ch === '\n') fail('newline in string');
      if (ch === '\\') {
        const next = peek(1);
        const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\', e: '\x1b' };
        if (next in simple) {
          out += simple[next];
          advance(2);
        } else if (next === 'u' || next === 'U') {
          const width = next === 'u' ? 4 : 8;
          const hex = text.slice(pos + 2, pos + 2 + width);
          if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) fail('invalid unicode escape');
          const code = Number.parseInt(hex, 16);
          if (code > 0x10ffff) fail('invalid unicode escape');
          out += String.fromCodePoint(code);
          advance(2 + width);
        } else if (multi && /[ \t\r\n]/.test(next)) {
          // Line-ending backslash: trim the newline and following whitespace.
          advance();
          while (/[ \t\r\n]/.test(peek()) && pos < text.length) advance();
        } else {
          fail('invalid escape');
        }
        continue;
      }
      out += ch;
      advance();
    }
  };

  const literalString = (): string => {
    const multi = text.startsWith("'''", pos);
    advance(multi ? 3 : 1);
    if (multi && peek() === '\n') advance();
    else if (multi && peek() === '\r' && peek(1) === '\n') advance(2);
    const close = multi ? "'''" : "'";
    const found = text.indexOf(close, pos);
    if (found === -1) fail('unterminated string');
    let end = found;
    // `''''` / `'''''`: up to two quotes before the closing three are content.
    if (multi) while (end - found < 2 && text[end + 3] === "'") end++;
    const value = text.slice(pos, end);
    if (!multi && value.includes('\n')) fail('newline in string');
    advance(end - pos + close.length);
    return value;
  };

  const key = (): string => {
    skipInline();
    const ch = peek();
    if (ch === '"') {
      if (text.startsWith('"""', pos)) fail('multi-line string as key');
      return basicString();
    }
    if (ch === "'") {
      if (text.startsWith("'''", pos)) fail('multi-line string as key');
      return literalString();
    }
    const match = /[A-Za-z0-9_-]+/y;
    match.lastIndex = pos;
    const found = match.exec(text);
    if (!found) return fail(`expected a key, found ${JSON.stringify(ch)}`);
    advance(found[0].length);
    return found[0];
  };

  const dottedKey = (): string[] => {
    const parts = [key()];
    for (;;) {
      skipInline();
      if (peek() !== '.') return parts;
      advance();
      parts.push(key());
    }
  };

  const value = (depth: number): TomlValue => {
    if (depth > MAX_DEPTH) fail('nesting too deep');
    skipInline();
    const ch = peek();
    if (ch === '"') return basicString();
    if (ch === "'") return literalString();
    if (ch === '[') {
      advance();
      const items: TomlValue[] = [];
      for (;;) {
        skipAll();
        if (peek() === ']') {
          advance();
          return items;
        }
        if (pos >= text.length) fail('unterminated array');
        items.push(value(depth + 1));
        skipAll();
        if (peek() === ',') {
          advance();
          continue;
        }
        if (peek() === ']') {
          advance();
          return items;
        }
        fail('expected "," or "]" in array');
      }
    }
    if (ch === '{') {
      advance();
      const table = newTable();
      skipInline();
      if (peek() === '}') {
        advance();
        return table;
      }
      for (;;) {
        const path = dottedKey();
        skipInline();
        if (peek() !== '=') fail('expected "=" in inline table');
        advance();
        assign(table, path, value(depth + 1));
        skipInline();
        if (peek() === ',') {
          advance();
          continue;
        }
        if (peek() === '}') {
          advance();
          return table;
        }
        fail('expected "," or "}" in inline table');
      }
    }
    const scalar = /[A-Za-z0-9_+\-.:]+(?:[ T][0-9:.+\-Z]+)?/y;
    scalar.lastIndex = pos;
    const found = scalar.exec(text);
    if (!found || found[0] === '') return fail(`unsupported value starting with ${JSON.stringify(ch)}`);
    advance(found[0].length);
    return new TomlScalar(found[0]);
  };

  const isTable = (v: TomlValue | undefined): v is TomlTable => isTomlTable(v);

  const descend = (table: TomlTable, part: string): TomlTable => {
    const existing = Object.hasOwn(table, part) ? table[part] : undefined;
    if (existing === undefined) {
      const created = newTable();
      table[part] = created;
      return created;
    }
    if (Array.isArray(existing)) {
      const last = existing[existing.length - 1];
      if (isTable(last)) return last;
      return fail(`key ${part} is not a table`);
    }
    if (isTable(existing)) return existing;
    return fail(`key ${part} is not a table`);
  };

  function assign(table: TomlTable, path: string[], v: TomlValue): void {
    let target = table;
    for (const part of path.slice(0, -1)) target = descend(target, part);
    target[path[path.length - 1]!] = v;
  }

  while (pos < text.length) {
    skipAll();
    if (pos >= text.length) break;
    if (peek() === '[') {
      const arrayOfTables = peek(1) === '[';
      advance(arrayOfTables ? 2 : 1);
      const path = dottedKey();
      skipInline();
      if (arrayOfTables) {
        if (!text.startsWith(']]', pos)) fail('expected "]]"');
        advance(2);
        let parent = root;
        for (const part of path.slice(0, -1)) parent = descend(parent, part);
        const last = path[path.length - 1]!;
        const existing = Object.hasOwn(parent, last) ? parent[last] : undefined;
        const entry = newTable();
        if (existing === undefined) parent[last] = [entry];
        else if (Array.isArray(existing)) existing.push(entry);
        else fail(`key ${last} is not an array of tables`);
        current = entry;
      } else {
        if (peek() !== ']') fail('expected "]"');
        advance();
        let target = root;
        for (const part of path) target = descend(target, part);
        current = target;
      }
      endOfLine();
      continue;
    }
    const path = dottedKey();
    skipInline();
    if (peek() !== '=') fail('expected "="');
    advance();
    assign(current, path, value(0));
    endOfLine();
  }
  return root;
}

/** Follows a key path through tables; undefined when any step is missing or not a table. */
export function tomlGet(table: TomlTable, path: string[]): TomlValue | undefined {
  let current: TomlValue | undefined = table;
  for (const part of path) {
    if (!isTomlTable(current)) return undefined;
    current = Object.hasOwn(current, part) ? current[part] : undefined;
  }
  return current;
}

export function isTomlTable(value: TomlValue | undefined): value is TomlTable {
  return value !== undefined && typeof value === 'object' && !Array.isArray(value) && !(value instanceof TomlScalar);
}

/** Tables have no prototype, so a `__proto__` or `constructor` key in untrusted TOML is just a key. */
function newTable(): TomlTable {
  return Object.create(null) as TomlTable;
}
