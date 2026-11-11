/**
 * RA-21 · `--style rich` goldens and the grammar's invariants, for all four commands on the
 * recorded hono fixtures (61f7c59).
 *
 * Variants: rich at 40, 80 and 120 columns (truecolor TTY), `NO_COLOR` on a TTY, `FORCE_COLOR=3`
 * on a pipe, `--ascii`, screen-reader mode, ambiguous-wide (CJK) and a plain non-TTY pipe.
 * Capabilities come from `@frame12/terminal`'s own detection over an injected environment.
 *
 * Re-record only for a reviewed rendering change (for example a new `@frame12/terminal`):
 *   UPDATE_GOLDEN=1 node --import tsx --test test/rich-goldens.test.ts
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { stringWidth, type Capabilities } from '@frame12/terminal';
import { renderRichView } from '../src/report/frame12-terminal.js';
import { capsFor, COMMANDS, FIXED, HONO_REMOTE, loadHono, viewFor, visible, type CapsInput } from './rich-helpers.js';

const GOLDEN_DIR = join(import.meta.dirname, 'fixtures', 'golden-rich');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

export const VARIANTS: Record<string, CapsInput> = {
  'rich-40': { columns: 40, env: { COLORTERM: 'truecolor' } },
  'rich-80': { columns: 80, env: { COLORTERM: 'truecolor' } },
  'rich-120': { columns: 120, env: { COLORTERM: 'truecolor' } },
  'rich-80-links': { columns: 80, env: { COLORTERM: 'truecolor', TERM_PROGRAM: 'iTerm.app' } },
  'no-color': { columns: 80, env: { NO_COLOR: '1', COLORTERM: 'truecolor' } },
  'force-color-3-pipe': { columns: 80, tty: false, env: { FORCE_COLOR: '3' } },
  ascii: { columns: 80, env: { COLORTERM: 'truecolor' }, flags: { ascii: true } },
  'screen-reader': { columns: 80, env: { COLORTERM: 'truecolor' }, flags: { screenReader: true } },
  'ambiguous-wide': { columns: 80, env: { COLORTERM: 'truecolor', LANG: 'ja_JP.UTF-8' } },
  pipe: { columns: 80, tty: false },
};

function check(name: string, actual: string): void {
  const path = join(GOLDEN_DIR, `${name}.ansi`);
  if (UPDATE) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  assert.ok(existsSync(path), `missing golden ${path}; record it with UPDATE_GOLDEN=1`);
  assert.equal(actual, readFileSync(path, 'utf8'), `${name}.ansi changed`);
}

const MARKER_TRUECOLOR = /\u001b\[[0-9;]*48;2;255;214;10/g;

function assertInvariants(label: string, out: string, caps: Capabilities): void {
  const lines = out.split('\n');
  if (!caps.screenReader) {
    for (const line of lines) {
      const width = stringWidth(line, { ambiguousWide: caps.ambiguousWide });
      assert.ok(width <= caps.columns, `${label}: a line is ${width} cells wide (> ${caps.columns}): ${JSON.stringify(visible(line))}`);
    }
  }
  if (caps.colorLevel === 0 && !caps.attributes) {
    assert.ok(!out.includes('\u001b'), `${label}: escape sequences on a stream without styling`);
  }
  if (caps.colorLevel === 3 && !caps.screenReader) {
    assert.equal((out.match(MARKER_TRUECOLOR) ?? []).length, 1, `${label}: exactly one marker chip`);
  }
  if (!caps.links) assert.ok(!out.includes('\u001b]8;'), `${label}: links without link support`);
  if (caps.screenReader) {
    assert.ok(!out.includes('\u001b'), `${label}: screen-reader output is plain`);
    assert.match(out, /^Repo Archaeology run "/);
  }
}

describe('RA-21 · --style rich goldens (hono 61f7c59)', () => {
  const hono = loadHono();
  for (const command of COMMANDS) {
    it(`${command}: every variant matches its golden and keeps the grammar's rules`, () => {
      const view = viewFor(hono, command, { ...FIXED, remoteUrl: HONO_REMOTE });
      for (const [variant, input] of Object.entries(VARIANTS)) {
        const caps = capsFor(input);
        const out = renderRichView(view, caps);
        assertInvariants(`${command}/${variant}`, out, caps);
        check(`${command}/${variant}`, out);
      }
    });
  }

  it('detects each variant the way the package documents', () => {
    assert.equal(capsFor(VARIANTS['rich-80']!).colorLevel, 3);
    assert.equal(capsFor(VARIANTS['no-color']!).colorLevel, 0);
    assert.equal(capsFor(VARIANTS['no-color']!).attributes, true, 'NO_COLOR keeps bold and dim on a TTY');
    assert.equal(capsFor(VARIANTS['force-color-3-pipe']!).colorLevel, 3);
    assert.equal(capsFor(VARIANTS.ascii!).unicode, false);
    assert.equal(capsFor(VARIANTS['screen-reader']!).screenReader, true);
    assert.equal(capsFor(VARIANTS['ambiguous-wide']!).ambiguousWide, true);
    assert.equal(capsFor(VARIANTS.pipe!).colorLevel, 0);
    assert.equal(capsFor(VARIANTS.pipe!).attributes, false);
    assert.equal(capsFor(VARIANTS['rich-80-links']!).links, true);
  });

  it('ASCII mode prints only ASCII for every command (hono text is ASCII)', () => {
    for (const command of COMMANDS) {
      const out = visible(renderRichView(viewFor(hono, command), capsFor(VARIANTS.ascii!)));
      assert.match(out, /^[\x00-\x7f]*$/, command);
    }
  });

  it('ambiguous-wide swaps ambiguous glyphs for their ASCII twins', () => {
    const out = visible(renderRichView(viewFor(hono, 'diff'), capsFor(VARIANTS['ambiguous-wide']!)));
    for (const ch of ['┃', '·', '…', '–', '→']) assert.ok(!out.includes(ch), `ambiguous glyph ${ch} in CJK output`);
  });
});
