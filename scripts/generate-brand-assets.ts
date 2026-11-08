/**
 * Generator for `docs/brand/*` assets.
 *
 * Usage:
 *   node --experimental-strip-types scripts/generate-brand-assets.ts
 *
 * Requires Playwright (`npm i -D playwright` or `NODE_PATH` pointing to an installed `playwright` package).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRAND_DIR = join(ROOT_DIR, 'docs', 'brand');

interface PlaywrightPage {
  setContent(html: string, opts?: { waitUntil?: string }): Promise<void>;
  evaluate<R>(fn: () => R): Promise<R>;
  screenshot(opts: { path: string; omitBackground?: boolean }): Promise<Buffer>;
  close(): Promise<void>;
}

interface PlaywrightBrowser {
  newPage(opts: { viewport: { width: number; height: number }; deviceScaleFactor: number }): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightModule {
  chromium: { launch(opts?: { channel?: string }): Promise<PlaywrightBrowser> };
}

function loadPlaywright(): PlaywrightModule {
  const nodePathEntries = process.env.NODE_PATH ? process.env.NODE_PATH.split(delimiter).filter(Boolean) : [];
  const anchors = [
    join(ROOT_DIR, 'package.json'),
    ...nodePathEntries.flatMap((p) => [join(p, 'playwright', 'package.json'), join(p, '..', 'package.json')]),
  ];
  for (const anchor of anchors) {
    if (!existsSync(anchor)) continue;
    try {
      const req = createRequire(anchor);
      return req('playwright') as PlaywrightModule;
    } catch {
      // try next anchor
    }
  }
  throw new Error('Playwright not found. Install with `npm i -D playwright` or set NODE_PATH.');
}

async function launchBrowser(chromium: PlaywrightModule['chromium']): Promise<PlaywrightBrowser> {
  try {
    return await chromium.launch();
  } catch {
    return await chromium.launch({ channel: 'chrome' });
  }
}

/**
 * Canonical 32x32 SVG mark ("The Stratigraphic Cut & Ghost Wire").
 * - Outer 2-unit #121212 frame centered at x=1,y=1..31,31 so all 2 units sit inside viewBox 0..32.
 * - Three slanted #ffffff sedimentary strata separated by wide 3.75-unit #121212 channels.
 * - Vertical #ffd60a ghost-wire core sample (x=19..23.5) piercing the two dark channels between
 *   Top <-> Bottom while passing behind the untouched Middle stratum.
 */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect x="1" y="1" width="30" height="30" fill="#121212" stroke="#121212" stroke-width="2"/>
  <polygon points="4,4 28,4 28,8.5 4,11.5" fill="#ffffff"/>
  <polygon points="4,24 28,21 28,28 4,28" fill="#ffffff"/>
  <rect x="19" y="6" width="4.5" height="20" fill="#ffd60a"/>
  <polygon points="4,15.25 28,12.25 28,17.25 4,20.25" fill="#ffffff"/>
</svg>
`;

/**
 * Dark-mode 32x32 SVG mark with a 2-unit #f1f0ea outer frame for contrast on dark surfaces (#0d1117).
 */
export const ICON_DARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect x="1" y="1" width="30" height="30" fill="#121212" stroke="#f1f0ea" stroke-width="2"/>
  <polygon points="4,4 28,4 28,8.5 4,11.5" fill="#ffffff"/>
  <polygon points="4,24 28,21 28,28 4,28" fill="#ffffff"/>
  <rect x="19" y="6" width="4.5" height="20" fill="#ffd60a"/>
  <polygon points="4,15.25 28,12.25 28,17.25 4,20.25" fill="#ffffff"/>
</svg>
`;

/**
 * Hand-tuned 16x16 pixel-grid favicon variant.
 * Uses whole-pixel horizontal strata (y=2..5, y=7..9, y=11..14 across x=2..14) and a whole-pixel
 * #ffd60a vertical ghost wire at x=10..12 across y=3..7 and y=9..13 (occluded by y=7..9).
 */
export const ICON_16_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">
  <rect width="16" height="16" fill="#121212"/>
  <rect x="2" y="2" width="12" height="3" fill="#ffffff"/>
  <rect x="2" y="11" width="12" height="3" fill="#ffffff"/>
  <rect x="10" y="3" width="2" height="4" fill="#ffd60a"/>
  <rect x="10" y="9" width="2" height="4" fill="#ffd60a"/>
  <rect x="2" y="7" width="12" height="2" fill="#ffffff"/>
</svg>
`;

/**
 * Padded, frameless safe-zone variant for surfaces that apply rounded-corner or circular masks
 * (180x180 apple-touch-icon and 512x512 GitHub App / organization avatar).
 * All corners sit within [6..26] (max corner distance 14.14 < 16 inscribed circle radius).
 */
export const ICON_PADDED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" fill="#121212"/>
  <polygon points="6,6 26,6 26,10 6,12.5" fill="#ffffff"/>
  <polygon points="6,23 26,20.5 26,26 6,26" fill="#ffffff"/>
  <rect x="18.5" y="7.75" width="3.75" height="16.5" fill="#ffd60a"/>
  <polygon points="6,15.75 26,13.25 26,17.25 6,19.75" fill="#ffffff"/>
</svg>
`;

export function buildSocialCardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Dela+Gothic+One&family=M+PLUS+1+Code:wght@500;700&family=Zen+Kaku+Gothic+New:wght@500;700;900&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 1280px;
    height: 640px;
    overflow: hidden;
    background: #e2e3e5;
    font-family: "Zen Kaku Gothic New", "Helvetica Neue", Arial, sans-serif;
    color: #121212;
    padding: 36px;
  }
  .sheet {
    width: 100%;
    height: 100%;
    background: #ffffff;
    border: 4px solid #121212;
    box-shadow: 10px 10px 0 #121212;
    display: grid;
    grid-template-columns: 1.08fr 0.92fr;
    position: relative;
    overflow: hidden;
  }
  .left {
    padding: 42px 44px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    border-right: 4px solid #121212;
    z-index: 2;
    background: #ffffff;
  }
  .brand-row {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .brand-row svg {
    width: 54px;
    height: 54px;
    flex-shrink: 0;
  }
  .kicker {
    font-family: "M PLUS 1 Code", monospace;
    font-size: 13.5px;
    font-weight: 700;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    color: #4b4b4b;
    margin-bottom: 3px;
  }
  .wordmark {
    font-family: "Dela Gothic One", "Arial Black", sans-serif;
    font-size: 29px;
    line-height: 1.05;
    letter-spacing: 0.01em;
    color: #121212;
    white-space: nowrap;
  }
  .headline {
    font-size: 40px;
    font-weight: 900;
    line-height: 1.18;
    letter-spacing: -0.02em;
    color: #121212;
  }
  .headline mark {
    display: inline-block;
    background: #ffd60a;
    color: #121212;
    padding: 1px 8px 3px;
    line-height: 1.12;
  }
  .sub {
    font-size: 18.5px;
    font-weight: 500;
    color: #4b4b4b;
    line-height: 1.42;
    margin-top: 14px;
  }
  .pills {
    display: flex;
    gap: 10px;
    flex-wrap: nowrap;
  }
  .pill {
    font-family: "M PLUS 1 Code", monospace;
    font-size: 12.5px;
    font-weight: 700;
    padding: 7px 10px;
    border: 2.5px solid #121212;
    background: #ffffff;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    white-space: nowrap;
  }
  .pill.accent {
    background: #ffd60a;
  }
  .right {
    background: #f4f4f5;
    padding: 26px 28px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 12px;
  }
  .section-bar {
    height: 22px;
    background: #121212;
    color: #ffffff;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 10px;
    font-family: "M PLUS 1 Code", monospace;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .section-bar .tag {
    color: #ffd60a;
  }
  .cut {
    background: #ffffff;
    border: 3px solid #121212;
    padding: 14px 16px;
  }
  .cut.alert {
    box-shadow: inset 8px 0 0 #ffd60a, 6px 6px 0 #121212;
    padding-left: 22px;
  }
  .cut-tag {
    font-family: "M PLUS 1 Code", monospace;
    font-size: 11.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #4b4b4b;
    margin-bottom: 6px;
    display: flex;
    justify-content: space-between;
    white-space: nowrap;
  }
  .cut-code {
    font-family: "M PLUS 1 Code", monospace;
    font-size: 12.5px;
    font-weight: 700;
    color: #121212;
    background: #f4f4f5;
    padding: 7px 10px;
    border: 1.5px solid #121212;
    line-height: 1.45;
    margin-bottom: 7px;
  }
  .cut-code .arrow {
    color: #4b4b4b;
  }
  .cut-meta {
    font-family: "M PLUS 1 Code", monospace;
    font-size: 11.5px;
    font-weight: 500;
    color: #4b4b4b;
    line-height: 1.35;
  }
  .sha {
    text-transform: none;
    font-weight: 700;
    color: #121212;
  }
  .colophon-bar {
    border-top: 2.5px solid #121212;
    padding-top: 10px;
    font-family: "M PLUS 1 Code", monospace;
    font-size: 12px;
    color: #121212;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .colophon-bar .label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #4b4b4b;
  }
  .colophon-bar .metric {
    font-family: "Zen Kaku Gothic New", "Helvetica Neue", Arial, sans-serif;
    font-size: 15.5px;
    font-weight: 900;
    color: #121212;
  }
</style>
</head>
<body>
  <div class="sheet">
    <div class="left">
      <div class="brand-row">
        ${ICON_SVG.trim()}
        <div>
          <div class="kicker">GIT CO-CHANGE &amp; GHOST-WIRE ENGINE</div>
          <div class="wordmark">REPO ARCHAEOLOGY</div>
        </div>
      </div>
      <div>
        <div class="headline">Discover <mark>hidden relationships</mark><br>in your Git history.</div>
        <div class="sub">Finds files that repeatedly change together without importing each other — ranked by Wilson 95% confidence intervals with supporting commit receipts.</div>
      </div>
      <div class="pills">
        <span class="pill accent">LOCAL-FIRST · OFFLINE</span>
        <span class="pill">WILSON 95% CI</span>
        <span class="pill">WALK-FORWARD BACKTEST</span>
      </div>
    </div>
    <div class="right">
      <div class="section-bar">
        <span>VERIFIED HONO CORPUS</span>
        <span class="tag">GHOST WIRES</span>
      </div>
      <div class="cut alert">
        <div class="cut-tag"><span>GHOST WIRE</span><span>60% · 12 OF 20 COMMITS</span></div>
        <div class="cut-code">src/adapter/bun/serve-static.ts<br><span class="arrow">→</span> src/adapter/deno/serve-static.ts</div>
        <div class="cut-meta">possible parallel implementations · receipts: <span class="sha">26f8c33</span> · <span class="sha">1196f14</span> · <span class="sha">246a06a</span></div>
      </div>
      <div class="cut alert">
        <div class="cut-tag"><span>GHOST WIRE</span><span>100% · 9 OF 9 COMMITS</span></div>
        <div class="cut-code">src/preset/tiny.ts <span class="arrow">→</span> src/preset/quick.ts</div>
        <div class="cut-meta">reverse: 90% · no import link detected in the current code</div>
      </div>
      <div class="colophon-bar">
        <span class="label">WALK-FORWARD BACKTEST · 2,757 COMMITS ANALYZED</span>
        <span class="metric">64% hit@3 (37% precision) vs 13% popularity baseline</span>
      </div>
    </div>
  </div>
</body>
</html>`;
}

async function main(): Promise<void> {
  mkdirSync(BRAND_DIR, { recursive: true });
  writeFileSync(join(BRAND_DIR, 'icon.svg'), ICON_SVG);
  writeFileSync(join(BRAND_DIR, 'icon-dark.svg'), ICON_DARK_SVG);

  const { chromium } = loadPlaywright();
  const browser = await launchBrowser(chromium);
  try {
    const iconSpecs: Array<{ file: string; size: number; svg: string }> = [
      { file: 'icon-16.png', size: 16, svg: ICON_16_SVG },
      { file: 'icon-32.png', size: 32, svg: ICON_SVG },
      { file: 'icon-128.png', size: 128, svg: ICON_SVG },
      { file: 'icon-180.png', size: 180, svg: ICON_PADDED_SVG },
      { file: 'icon-512.png', size: 512, svg: ICON_PADDED_SVG },
    ];

    for (const { file, size, svg } of iconSpecs) {
      const page = await browser.newPage({
        viewport: { width: size, height: size },
        deviceScaleFactor: 1,
      });
      await page.setContent(
        `<!doctype html><html><body style="margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent">${svg.replace(
          '<svg ',
          `<svg width="${size}" height="${size}" style="display:block" `,
        )}</body></html>`,
      );
      await page.screenshot({
        path: join(BRAND_DIR, file),
        omitBackground: true,
      });
      await page.close();
    }

    const socialPage = await browser.newPage({
      viewport: { width: 1280, height: 640 },
      deviceScaleFactor: 1,
    });
    await socialPage.setContent(buildSocialCardHtml(), { waitUntil: 'networkidle' });
    await socialPage.evaluate(() => document.fonts.ready);
    await socialPage.screenshot({
      path: join(BRAND_DIR, 'social-preview.png'),
    });
    await socialPage.close();
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
