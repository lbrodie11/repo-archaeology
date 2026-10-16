/**
 * Minimal glob matcher for repo-relative POSIX paths (no dependency needed).
 *
 * Supported: `*` (within one path segment), `?`, `**` (any number of segments),
 * and `{a,b}` alternation of literal strings.
 * A pattern without a `/` matches the file name at any depth, like .gitignore
 * (so `*.snap` is treated as `**\/*.snap`). A trailing `/` matches a whole directory.
 */
export function globToRegExp(pattern: string): RegExp {
  let g = pattern.trim().replace(/\\/g, '/');
  if (g.startsWith('./')) g = g.slice(2);
  if (g.startsWith('/')) g = g.slice(1);
  else if (!g.slice(0, -1).includes('/')) g = `**/${g}`;
  if (g.endsWith('/')) g += '**';

  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        const atSegmentStart = i === 0 || g[i - 1] === '/';
        const followedBySlash = g[i + 2] === '/';
        if (atSegmentStart && followedBySlash) {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end > i) {
        re += `(?:${g.slice(i + 1, end).split(',').map(escapeRegExp).join('|')})`;
        i = end;
      } else {
        re += '\\{';
      }
    } else {
      re += escapeRegExp(c);
    }
  }
  return new RegExp(`^${re}$`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class PathMatcher {
  private readonly regexps: RegExp[];
  constructor(patterns: readonly string[]) {
    this.regexps = patterns.filter((p) => p.trim() !== '').map(globToRegExp);
  }
  matches(path: string): boolean {
    return this.regexps.some((r) => r.test(path));
  }
}
