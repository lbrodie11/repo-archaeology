/**
 * README.md ships in the npm tarball and is rendered on npmjs.com, which rewrites relative
 * `<img src>` URLs to the GitHub repository but not `<source srcset>` (the dark-mode variant of a
 * `<picture>`). A relative image therefore breaks on npm, in dark mode only. Every image the README
 * shows must use an absolute https URL, and the ones served from this repository must exist.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const RAW_MAIN = 'https://raw.githubusercontent.com/lbrodie11/repo-archaeology/main/';

/** Every image URL in the README: `<img src>`, `<source srcset>` (each candidate) and `![](…)`. */
export function readmeImageUrls(markdown: string): Array<{ line: number; url: string }> {
  const out: Array<{ line: number; url: string }> = [];
  markdown.split('\n').forEach((text, i) => {
    for (const m of text.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)) out.push({ line: i + 1, url: m[1]! });
    for (const m of text.matchAll(/<source\b[^>]*\bsrcset="([^"]+)"/g)) {
      for (const candidate of m[1]!.split(',')) out.push({ line: i + 1, url: candidate.trim().split(/\s+/)[0]! });
    }
    for (const m of text.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)/g)) out.push({ line: i + 1, url: m[1]! });
  });
  return out;
}

describe('README images render on npmjs.com', () => {
  const images = readmeImageUrls(README);

  it('finds the README images, including the dark-mode <source srcset> ones', () => {
    assert.ok(images.length >= 8, `expected the README's images, found ${images.length}`);
    assert.ok(images.some((i) => i.url.endsWith('diff-80-after-dark.png')), 'the dark-mode gallery image');
  });

  it('uses absolute https URLs for every image', () => {
    const relative = images.filter((i) => !i.url.startsWith('https://'));
    assert.deepEqual(relative, [], `relative image URLs break on npmjs.com: ${relative.map((i) => `line ${i.line}: ${i.url}`).join(', ')}`);
  });

  it('points raw.githubusercontent.com/main URLs at files that exist in this repository', () => {
    const missing = images
      .filter((i) => i.url.startsWith(RAW_MAIN))
      .filter((i) => !existsSync(join(ROOT, decodeURIComponent(i.url.slice(RAW_MAIN.length).split(/[?#]/)[0]!))));
    assert.deepEqual(missing, [], `README images missing from the repository: ${missing.map((i) => i.url).join(', ')}`);
  });

  it('catches a relative dark-mode source (the npm bug fixed in 0.13.1)', () => {
    const broken = '<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="docs/x-dark.png">\n  <img src="https://example.com/x.png">\n</picture>';
    assert.deepEqual(
      readmeImageUrls(broken).filter((i) => !i.url.startsWith('https://')),
      [{ line: 2, url: 'docs/x-dark.png' }],
    );
  });
});
