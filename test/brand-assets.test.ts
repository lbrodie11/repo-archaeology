import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ICON_16_SVG,
  ICON_32_SVG,
  ICON_DARK_SVG,
  ICON_PADDED_SVG,
  ICON_SVG,
  buildSocialCardHtml,
} from '../scripts/generate-brand-assets.js';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRAND_DIR = join(ROOT_DIR, 'docs', 'brand');

describe('brand assets', () => {
  it('keeps committed docs/brand/icon.svg and icon-dark.svg byte-identical to generator constants', () => {
    const iconSvgOnDisk = readFileSync(join(BRAND_DIR, 'icon.svg'), 'utf8').replace(/\r\n/g, '\n');
    const iconDarkSvgOnDisk = readFileSync(join(BRAND_DIR, 'icon-dark.svg'), 'utf8').replace(/\r\n/g, '\n');

    assert.equal(iconSvgOnDisk, ICON_SVG);
    assert.equal(iconDarkSvgOnDisk, ICON_DARK_SVG);
  });

  it('uses crispEdges whole-pixel geometry for 16x16 and 32x32 favicons and safe-zone bounds for padded icons', () => {
    assert.match(ICON_16_SVG, /shape-rendering="crispEdges"/);
    assert.match(ICON_32_SVG, /shape-rendering="crispEdges"/);
    assert.match(ICON_PADDED_SVG, /viewBox="0 0 32 32"/);
  });

  it('renders accurate Wilson lower-bound + 95% CI copy and backtest baseline labels in social card HTML', () => {
    const html = buildSocialCardHtml();
    assert.ok(html.includes(ICON_SVG.trim()));
    assert.ok(html.includes('ranked by Wilson lower bound with 95% CIs and commit receipts'));
    assert.ok(html.includes('64% hit@3 (37% precision) vs 13% popularity (same changes)'));
  });
});
