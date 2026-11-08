/**
 * Vendored FRAME/12 design tokens for Repo Archaeology's opt-in `--style rich` mode.
 *
 * Canonical source: `@frame12/tokens` (https://github.com/lbrodie11/frame12/tree/main/packages/tokens)
 * Vendored as static constants so `@frame12/tokens` is never a runtime dependency.
 */

import { ConfigError } from '../errors.js';

export const STYLE_MODES = ['classic', 'rich'] as const;
export type StyleMode = (typeof STYLE_MODES)[number];

export function isStyleMode(value: unknown): value is StyleMode {
  return typeof value === 'string' && (STYLE_MODES as readonly string[]).includes(value);
}

export interface ResolveStyleOptions {
  flag?: string | undefined;
  env?: string | undefined;
  config?: StyleMode | string | undefined;
  onWarning?: (message: string) => void;
}

/**
 * Resolve style mode with precedence:
 * `--style` CLI flag > `REPO_ARCHAEOLOGY_STYLE` env var > `.repo-archaeology.json` `"style"` > `'classic'`.
 *
 * Only an explicit invalid `--style` flag throws `ConfigError`. Invalid `REPO_ARCHAEOLOGY_STYLE`
 * or config `"style"` values emit a warning via `onWarning` (when provided) and fall back to `'classic'`.
 */
export function resolveStyleMode(options: ResolveStyleOptions = {}): StyleMode {
  if (options.flag !== undefined && options.flag !== '') {
    const normalized = options.flag.trim().toLowerCase();
    if (isStyleMode(normalized)) {
      return normalized;
    }
    throw new ConfigError(
      `Invalid style mode from --style: "${options.flag}". Expected one of: ${STYLE_MODES.join(', ')}.`,
    );
  }

  if (options.env !== undefined && options.env.trim() !== '') {
    const normalized = options.env.trim().toLowerCase();
    if (isStyleMode(normalized)) {
      return normalized;
    }
    options.onWarning?.(
      `Invalid style mode from REPO_ARCHAEOLOGY_STYLE: "${options.env}". Falling back to "classic" (expected one of: ${STYLE_MODES.join(', ')}).`,
    );
    return 'classic';
  }

  if (options.config !== undefined && options.config !== '') {
    const normalized = String(options.config).trim().toLowerCase();
    if (isStyleMode(normalized)) {
      return normalized;
    }
    options.onWarning?.(
      `Invalid style mode from config "style": "${String(options.config)}". Falling back to "classic" (expected one of: ${STYLE_MODES.join(', ')}).`,
    );
    return 'classic';
  }

  return 'classic';
}

export const FRAME12 = {
  light: {
    desk: '#e2e3e5',
    sheet: '#ffffff',
    panel: '#ffffff',
    ink: '#121212',
    'ink-2': '#4b4b4b',
    rule: '#121212',
    tone: '#121212',
    grid: '#e3e3e3',
    marker: '#ffd60a',
    'marker-ink': '#121212',
    hole: '#e2e3e5',
    backdrop: 'rgba(12, 12, 12, 0.78)',
    diff: '#ffffff',
  },
  dark: {
    desk: '#000000',
    sheet: '#050505',
    panel: '#19191a',
    ink: '#f1f0ea',
    'ink-2': '#b9b8b1',
    rule: '#f1f0ea',
    tone: '#f1f0ea',
    grid: '#2c2c2d',
    marker: '#ffd60a',
    'marker-ink': '#121212',
    hole: '#000000',
    backdrop: 'rgba(12, 12, 12, 0.78)',
    diff: '#ffffff',
  },
  terminal: {
    markerBgRgb: [255, 214, 10] as const,
    markerFgRgb: [18, 18, 18] as const,
    inkRgb: [241, 240, 234] as const,
    ink2Rgb: [185, 184, 177] as const,
    ruleRgb: [185, 184, 177] as const,
    ghostRgb: [216, 112, 255] as const,
    unknownRgb: [255, 200, 56] as const,
    indirectRgb: [86, 212, 221] as const,
    directRgb: [96, 165, 250] as const,
    testRgb: [74, 222, 128] as const,
    ansi256: {
      markerBg: 220,
      markerFg: 16,
      ink: 255,
      ink2: 249,
      rule: 245,
      ghost: 177,
      unknown: 220,
      indirect: 80,
      direct: 75,
      test: 78,
    },
  },
  gutters: {
    pair: '12px',
    scene: '20px',
    change: '32px',
  },
  gutterPx: {
    pair: 12,
    scene: 20,
    change: 32,
  },
  stroke: {
    ink: '2.5px',
    inkPx: 2.5,
  },
  motion: {
    pose: '83.33ms',
    poseMs: 83,
    fps: 12,
  },
  /**
   * Upstream `@frame12/tokens` font stacks (retained for token parity checks).
   * Offline self-contained maps use `FRAME12.offlineFonts` so no web fonts are requested.
   */
  fonts: {
    display: '"Archivo Black", "Arial Black", "Helvetica Neue", sans-serif',
    body: '"Inter", ui-sans-serif, system-ui, -apple-system, sans-serif',
    mono: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
  },
  offlineFonts: {
    display: '"Arial Black", "Helvetica Neue", sans-serif',
    body: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  },
  shadow: {
    sheet: '0 1px 0 rgba(0, 0, 0, 0.05), 0 18px 40px -26px rgba(0, 0, 0, 0.5)',
    peg: 'inset 0 1px 2px rgba(0, 0, 0, 0.25)',
  },
} as const;

export const FRAME12_ALLOWED_HEX = new Set<string>(
  [
    ...Object.values(FRAME12.light),
    ...Object.values(FRAME12.dark),
  ]
    .filter((v) => v.startsWith('#'))
    .map((v) => v.toLowerCase()),
);

/**
 * Deterministic directory hue hash (`0..359`), matching the classic map's `hashHue`.
 */
export function hashHue(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 360;
}

/**
 * Directory fill color in `hsl(...)` with theme-appropriate lightness so every hue (0..359)
 * maintains >= 3:1 WCAG contrast against the frame background (`--f-panel` and `--f-sheet`).
 */
export function directoryFillHsl(hue: number, theme: 'light' | 'dark'): string {
  const normalizedHue = ((Math.round(hue) % 360) + 360) % 360;
  const lightness = theme === 'dark' ? 68 : 32;
  return `hsl(${normalizedHue}, 52%, ${lightness}%)`;
}

export function directoryFillColor(dir: string, theme: 'light' | 'dark'): string {
  return directoryFillHsl(hashHue(dir || '.'), theme);
}

/**
 * Convert an sRGB channel (0..255) to linear luminance component.
 */
function srgbChannelToLinear(channel255: number): number {
  const c = channel255 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminanceRgb(r: number, g: number, b: number): number {
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

export function hslToRgb(h: number, sPct: number, lPct: number): [number, number, number] {
  const hNorm = (((h % 360) + 360) % 360) / 360;
  const s = Math.max(0, Math.min(1, sPct / 100));
  const l = Math.max(0, Math.min(1, lPct / 100));

  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }

  const hue2rgb = (p: number, q: number, t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, hNorm + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, hNorm) * 255),
    Math.round(hue2rgb(p, q, hNorm - 1 / 3) * 255),
  ];
}

export function parseColorToRgb(color: string): [number, number, number] {
  const trimmed = color.trim().toLowerCase();
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    if (hex.length === 3) {
      return [
        parseInt(hex[0]! + hex[0]!, 16),
        parseInt(hex[1]! + hex[1]!, 16),
        parseInt(hex[2]! + hex[2]!, 16),
      ];
    }
    if (hex.length === 6) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ];
    }
  }
  const hslMatch = /^hsl\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)%\s*\)$/.exec(trimmed);
  if (hslMatch) {
    return hslToRgb(Number(hslMatch[1]), Number(hslMatch[2]), Number(hslMatch[3]));
  }
  const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(trimmed);
  if (rgbMatch) {
    return [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])];
  }
  throw new Error(`Unsupported color format for contrast calculation: "${color}"`);
}

/**
 * WCAG 2.1 contrast ratio between two `#rrggbb`, `rgb(...)`, or `hsl(...)` colors.
 */
export function wcagContrastRatio(fg: string, bg: string): number {
  const [r1, g1, b1] = parseColorToRgb(fg);
  const [r2, g2, b2] = parseColorToRgb(bg);
  const l1 = relativeLuminanceRgb(r1, g1, b1);
  const l2 = relativeLuminanceRgb(r2, g2, b2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Normalizes untrusted repository text (file paths, commit subjects, author names)
 * for HTML and Canvas display by neutralizing C0/C1 control characters, Unicode
 * bidirectional overrides (`\p{Bidi_Control}`), and zero-width characters into
 * visible escape sequences (`\x..` / `\u....`).
 * Kept separate from `src/util/term.ts` (`sanitizeDisplayText`) so browser display
 * normalization and terminal ANSI/OSC escaping remain independent.
 */
export function sanitizeHtmlDisplayText(value: string): string {
  return value.replace(
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200d\u2028\u2029\u2060\ufeff]|\p{Bidi_Control}/gu,
    (character) => {
      if (character === '\n') return '\\n';
      if (character === '\r') return '\\r';
      if (character === '\t') return '\\t';
      const code = character.codePointAt(0)!;
      return code <= 0xff
        ? `\\x${code.toString(16).padStart(2, '0')}`
        : `\\u${code.toString(16).padStart(4, '0')}`;
    },
  );
}
