#!/usr/bin/env node
/**
 * The `--style rich` before/after gallery for RA-21 (`docs/gallery/rich-terminal/`).
 *
 *   npm run build                                   # this branch ("after")
 *   node scripts/rich-gallery.mjs --hono <clone> --before <main checkout>/dist/cli.js
 *
 * Runs `scan -n 4` and `diff --base 61f7c59~6` on honojs/hono at 61f7c59 (read with `--head`, no
 * checkout; nothing from the clone runs) with the previous renderer (`--before`, a build of `main`)
 * and with this branch, at 40, 80 and 120 columns with truecolor forced, as a terminal would get it.
 * The ANSI goes through @xterm/headless (a real terminal parser, as in FRAME/12's own gallery) and
 * is screenshotted in light and dark themes with Playwright.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeGitEnv } from './schema-validator.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'gallery', 'rich-terminal');
const HONO_SHA = '61f7c59e50244ab4d2dd83c151928cf7ea448510';
const WIDTHS = [40, 80, 120];
const COMMANDS = { scan: ['scan', '-n', '4'], diff: ['diff', '--base', '61f7c59~6'] };

const THEMES = {
  light: { fg: '#1d1d1f', bg: '#ffffff', palette: ['#000000', '#c91b00', '#00a600', '#c7c400', '#0225c7', '#ca30c7', '#00c5c7', '#c7c7c7', '#686868', '#ff6e67', '#5ffa68', '#fffc67', '#6871ff', '#ff77ff', '#60fdff', '#ffffff'] },
  dark: { fg: '#e6e6e6', bg: '#16161a', palette: ['#000000', '#ff5555', '#50fa7b', '#f1fa8c', '#6272a4', '#ff79c6', '#8be9fd', '#bbbbbb', '#555555', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff'] },
};

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function render(cli, hono, args, columns) {
  const env = sanitizeGitEnv(process.env, { FORCE_COLOR: '3', COLUMNS: String(columns), LANG: 'en_US.UTF-8', TERM: 'xterm-256color' });
  for (const k of ['NO_COLOR', 'TERM_PROGRAM', 'COLORTERM', 'LC_ALL', 'LC_CTYPE', 'FRAME12_ASCII', 'FRAME12_SCREEN_READER', 'CI']) delete env[k];
  return execFileSync(process.execPath, [cli, '-C', hono, '--head', HONO_SHA, '--no-cache', '--no-config', '--style', 'rich', ...args], {
    encoding: 'utf8',
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function xterm256(n) {
  if (n < 16) return null;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return [v, v, v];
  }
  const i = n - 16;
  const step = (x) => (x === 0 ? 0 : 55 + x * 40);
  return [step(Math.floor(i / 36)), step(Math.floor(i / 6) % 6), step(i % 6)];
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function color(cell, plane) {
  const rgb = plane === 'fg' ? cell.isFgRGB() : cell.isBgRGB();
  const pal = plane === 'fg' ? cell.isFgPalette() : cell.isBgPalette();
  const v = plane === 'fg' ? cell.getFgColor() : cell.getBgColor();
  if (rgb) return `#${v.toString(16).padStart(6, '0')}`;
  if (pal) return v < 16 ? `var(--c${v})` : `rgb(${xterm256(v).join(',')})`;
  return null;
}

/** ANSI → HTML through @xterm/headless (cells, widths, SGR exactly as a terminal parses them). */
async function ansiToHtml(ansi, columns) {
  const { Terminal } = (await import('@xterm/headless')).default;
  const lines = ansi.split('\n');
  const term = new Terminal({ cols: columns, rows: Math.max(2, lines.length + 1), allowProposedApi: true, convertEol: true, scrollback: 0 });
  await new Promise((done) => term.write(ansi, done));
  const buf = term.buffer.active;
  const rows = [];
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    let html = '';
    let run = '';
    let style = '';
    const flush = () => {
      if (run) html += style ? `<span style="${style}">${esc(run)}</span>` : esc(run);
      run = '';
    };
    for (let x = 0; x < columns; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      let fg = color(cell, 'fg');
      let bg = color(cell, 'bg');
      if (cell.isInverse()) [fg, bg] = [bg ?? 'var(--bg)', fg ?? 'var(--fg)'];
      const st = [fg ? `color:${fg}` : '', bg ? `background:${bg}` : '', cell.isBold() ? 'font-weight:700' : '', cell.isDim() ? 'opacity:.6' : '', cell.isUnderline() ? 'text-decoration:underline' : '']
        .filter(Boolean)
        .join(';');
      if (st !== style) {
        flush();
        style = st;
      }
      run += cell.getChars() || ' ';
    }
    flush();
    rows.push(html.replace(/\s+$/, ''));
  }
  while (rows.length && rows[rows.length - 1] === '') rows.pop();
  term.dispose();
  return rows.join('\n');
}

function themeCss() {
  const vars = (t) => [`--fg:${t.fg}`, `--bg:${t.bg}`, ...t.palette.map((c, i) => `--c${i}:${c}`)].join(';');
  return `.t-light{${vars(THEMES.light)}}.t-dark{${vars(THEMES.dark)}}
.term{background:var(--bg);color:var(--fg);font:13px/1.35 ui-monospace,"JetBrains Mono","DejaVu Sans Mono",Menlo,monospace;padding:14px 16px;margin:0;white-space:pre;display:inline-block;border-radius:6px}`;
}

async function main() {
  const hono = arg('--hono');
  const before = arg('--before');
  if (!hono || !before) {
    console.error('usage: node scripts/rich-gallery.mjs --hono <clone> --before <main>/dist/cli.js');
    process.exit(2);
  }
  const after = join(ROOT, 'dist', 'cli.js');
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'ansi'), { recursive: true });
  mkdirSync(join(OUT, 'png'), { recursive: true });

  const shots = [];
  for (const [name, args] of Object.entries(COMMANDS)) {
    for (const columns of WIDTHS) {
      for (const [side, cli] of [['before', resolve(before)], ['after', after]]) {
        const ansi = render(cli, resolve(hono), args, columns);
        const key = `${name}-${columns}-${side}`;
        writeFileSync(join(OUT, 'ansi', `${key}.ansi`), ansi);
        shots.push({ key, html: await ansiToHtml(ansi, columns) });
      }
    }
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const { key, html } of shots) {
      for (const theme of ['light', 'dark']) {
        await page.setContent(`<!doctype html><meta charset="utf-8"><style>${themeCss()} body{margin:0;background:#888}</style><pre class="term t-${theme}">${html}</pre>`);
        await page.locator('pre').screenshot({ path: join(OUT, 'png', `${key}-${theme}.png`) });
      }
    }
  } finally {
    await browser.close();
  }

  const rows = [];
  for (const name of Object.keys(COMMANDS)) {
    rows.push(`## \`${name}\``, '');
    for (const columns of WIDTHS) {
      rows.push(`### ${columns} columns`, '', '| Before (RA-13 renderer) | After (`@frame12/terminal`) |', '| --- | --- |');
      for (const theme of ['light', 'dark']) {
        rows.push(`| ![before, ${theme}](png/${name}-${columns}-before-${theme}.png) | ![after, ${theme}](png/${name}-${columns}-after-${theme}.png) |`);
      }
      rows.push('');
    }
  }
  writeFileSync(
    join(OUT, 'README.md'),
    [
      '# `--style rich` before and after (RA-21)',
      '',
      `honojs/hono at \`61f7c59\` (\`--head ${HONO_SHA}\`), \`scan\` and \`diff --base 61f7c59~6\`, rendered with`,
      'truecolor forced (`FORCE_COLOR=3`) at 40, 80 and 120 columns, parsed by `@xterm/headless` and shown in a',
      'light and a dark terminal theme. "Before" is the RA-13 renderer on `main`; "after" is `@frame12/terminal`.',
      'Regenerate with `node scripts/rich-gallery.mjs --hono <clone> --before <main checkout>/dist/cli.js`.',
      'The raw ANSI is in [`ansi/`](ansi/).',
      '',
      ...rows,
    ].join('\n'),
  );
  console.log(`Wrote ${shots.length * 2} PNGs and ${shots.length} ANSI files to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
