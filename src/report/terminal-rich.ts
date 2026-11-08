import { stderr, stdout } from 'node:process';
import type { DiffFamilyView, DiffResult, Suggestion } from '../commands/diff.js';
import {
  EXPLAIN_DISCLAIMER,
  type CounterexampleCommitEvidence,
  type ExplainResult,
} from '../commands/explain.js';
import type { FileCompanionView, FileResult } from '../commands/file.js';
import type { ScanOptions, ScanResult } from '../commands/scan.js';
import type { FilePatchEvidence } from '../git/patch.js';
import { RELATIONSHIPS, type Relationship } from '../imports/classify.js';
import type { FindingFamilyView } from '../model/families.js';
import type { RelationshipVerdictView } from '../model/verdicts.js';
import { FRAME12 } from '../style/frame12.js';
import { pct, plural, setProgressHandler, shortHash, timeAgo } from '../util/term.js';
import {
  DISCLAIMER,
  formatIntervalCi,
  NAMES,
  weightingLabel,
  type EvidenceView,
  type Meta,
  type RelationshipView,
} from './views.js';

export type ColorLevel = 0 | 1 | 2 | 3;

export interface TerminalCapabilities {
  colorLevel: ColorLevel;
  unicode: boolean;
  links: boolean;
  columns: number;
  isTTY: boolean;
  reducedMotion: boolean;
}

export interface CapabilityOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  columns?: number;
  noColor?: boolean;
  ascii?: boolean;
  noLinks?: boolean;
}

export interface RichRenderOptions extends CapabilityOptions {
  remoteUrl?: string;
  fullEvidence?: boolean;
}

const TRUSTED_GIT_HOSTS = new Map<string, 'commit' | 'commits'>([
  ['github.com', 'commit'],
  ['gitlab.com', 'commit'],
  ['codeberg.org', 'commit'],
  ['bitbucket.org', 'commits'],
]);

const GRAPHEME_SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * Per-render capability detection with explicit precedence:
 * 1. `--no-color` CLI flag -> colorLevel 0
 * 2. Non-empty `NO_COLOR` env var -> colorLevel 0 (https://no-color.org/)
 * 3. `NODE_DISABLE_COLORS` (non-empty and !== '0') -> colorLevel 0
 * 4. `FORCE_COLOR` ('0'/'false' -> 0, '1'/'true' -> 1, '2' -> 2, '3' -> 3), honored even on pipes
 * 5. `TERM=dumb` or `!isTTY` -> colorLevel 0
 * 6. TTY color depth detection (truecolor -> 3, 256color -> 2, default TTY -> 1)
 *
 * `--ascii` and `--no-links` are evaluated independently so toggling one never alters the others.
 */
export function detectTerminalCapabilities(options: CapabilityOptions = {}): TerminalCapabilities {
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  const isTTY = options.isTTY ?? Boolean(stdout.isTTY);

  const resolveColorLevel = (): ColorLevel => {
    if (options.noColor === true || argv.includes('--no-color')) return 0;
    if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 0;
    if (
      env.NODE_DISABLE_COLORS !== undefined &&
      env.NODE_DISABLE_COLORS !== '' &&
      env.NODE_DISABLE_COLORS !== '0'
    ) {
      return 0;
    }
    if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '') {
      const fc = env.FORCE_COLOR.trim().toLowerCase();
      if (fc === '0' || fc === 'false') return 0;
      if (fc === '1' || fc === 'true') return 1;
      if (fc === '2') return 2;
      if (fc === '3') return 3;
      const num = Number(fc);
      if (Number.isInteger(num) && num >= 3) return 3;
      if (Number.isInteger(num) && num > 0) return num as ColorLevel;
    }
    if (env.TERM === 'dumb') return 0;
    if (!isTTY) return 0;

    const colorTerm = (env.COLORTERM ?? '').toLowerCase();
    const termProgram = env.TERM_PROGRAM ?? '';
    if (
      colorTerm === 'truecolor' ||
      colorTerm === '24bit' ||
      Boolean(env.WT_SESSION) ||
      termProgram === 'vscode' ||
      termProgram === 'WezTerm' ||
      termProgram === 'iTerm.app' ||
      termProgram === 'ghostty' ||
      termProgram === 'Alacritty'
    ) {
      return 3;
    }
    if (env.TERM && /256color/i.test(env.TERM)) {
      return 2;
    }
    return 1;
  };

  const unicode =
    options.ascii === true || argv.includes('--ascii') || env.TERM === 'dumb' ? false : true;

  const isCI = env.CI === 'true' || env.CI === '1' || env.GITHUB_ACTIONS === 'true';

  const resolveLinks = (): boolean => {
    if (options.noLinks === true || argv.includes('--no-links')) return false;
    if (env.FORCE_HYPERLINK === '0') return false;
    if (env.TERM === 'dumb') return false;
    if (env.FORCE_HYPERLINK === '1') return true;
    return isTTY && !isCI;
  };

  const envCols = env.COLUMNS !== undefined ? Number(env.COLUMNS) : Number.NaN;
  const rawCols =
    options.columns ??
    (Number.isFinite(envCols) && envCols > 0 ? envCols : undefined) ??
    (isTTY && typeof stdout.columns === 'number' && stdout.columns > 0 ? stdout.columns : 80);
  const columns = Number.isFinite(rawCols) && rawCols > 0 ? Math.max(20, Math.floor(rawCols)) : 80;

  const reducedMotion =
    !isTTY ||
    isCI ||
    env.TERM === 'dumb' ||
    (env.NO_MOTION !== undefined && env.NO_MOTION !== '' && env.NO_MOTION !== '0') ||
    (env.REDUCED_MOTION !== undefined && env.REDUCED_MOTION !== '' && env.REDUCED_MOTION !== '0') ||
    (env.REPO_ARCHAEOLOGY_NO_MOTION !== undefined &&
      env.REPO_ARCHAEOLOGY_NO_MOTION !== '' &&
      env.REPO_ARCHAEOLOGY_NO_MOTION !== '0');

  return {
    colorLevel: resolveColorLevel(),
    unicode,
    links: resolveLinks(),
    columns,
    isTTY,
    reducedMotion,
  };
}

/**
 * Sanitize untrusted repository text (commit subjects, authors, file paths, refs, verdicts, patches)
 * before any trusted ANSI SGR or OSC 8 sequence is applied.
 *
 * Strips complete and incomplete CSI, OSC, DCS, SOS, PM, APC, and ESC sequences, removes bidirectional
 * and standalone zero-width spoofing controls (while preserving ZWJ `\u200d` and VS16 `\ufe0f` inside
 * valid emoji grapheme clusters), and escapes remaining C0/DEL/C1 control characters so no raw `\x1b`
 * or executable terminal control sequence ever survives.
 */
export function sanitizeRichText(value: string): string {
  if (!value) return '';
  return (
    value
      // Strip complete or incomplete OSC sequences (ESC ] ... BEL/ST/EOF or C1 0x9d)
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\|$)/g, '')
      .replace(/\u009d[^\u0007\u009c\u001b]*(?:\u0007|\u009c|\u001b\\|$)/g, '')
      // Strip complete or incomplete DCS, SOS, PM, APC sequences (ESC P/X/^/_ ... BEL/ST/EOF or C1)
      .replace(/\u001b[PX^_][^\u0007\u001b]*(?:\u0007|\u001b\\|$)/g, '')
      .replace(/[\u0090\u0098\u009e\u009f][^\u0007\u009c\u001b]*(?:\u0007|\u009c|\u001b\\|$)/g, '')
      // Strip complete or incomplete CSI sequences (ESC [ ... or C1 0x9b)
      .replace(/\u001b\[[0-9:;<=>?]*[ -/]*[@-~]?/g, '')
      .replace(/\u009b[0-9:;<=>?]*[ -/]*[@-~]?/g, '')
      // Strip 2-byte ESC sequences and any bare ESC
      .replace(/\u001b[@-Z\\-_]?/g, '')
      // Strip bidirectional controls and standalone zero-width spoofing marks (keep \u200d ZWJ for emoji)
      .replace(/[\u061c\u200b\u200c\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]|\p{Bidi_Control}/gu, '')
      // Escape remaining C0, DEL, C1, and line/paragraph separators visibly
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (ch) => {
        if (ch === '\n') return '\\n';
        if (ch === '\r') return '\\r';
        if (ch === '\t') return '\\t';
        const code = ch.codePointAt(0)!;
        return code <= 0xff
          ? `\\x${code.toString(16).padStart(2, '0')}`
          : `\\u${code.toString(16).padStart(4, '0')}`;
      })
  );
}

function isZeroWidthCodePoint(cp: number): boolean {
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return true;
  if (cp >= 0x0300 && cp <= 0x036f) return true;
  if (cp >= 0x1ab0 && cp <= 0x1aff) return true;
  if (cp >= 0x1dc0 && cp <= 0x1dff) return true;
  if (cp >= 0x20d0 && cp <= 0x20ff) return true;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true;
  if (cp >= 0xfe20 && cp <= 0xfe2f) return true;
  if (cp >= 0x200b && cp <= 0x200f) return true;
  if (cp === 0xfeff) return true;
  return false;
}

function isDoubleWidthCodePoint(cp: number): boolean {
  return (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f000 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  );
}

export function getGraphemeDisplayWidth(cluster: string): number {
  let maxWidth = 0;
  for (const ch of cluster) {
    const cp = ch.codePointAt(0)!;
    // Regional indicator symbols (flags) and emoji modifiers render as 2 cells
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
      maxWidth = Math.max(maxWidth, 2);
      continue;
    }
    const w = isZeroWidthCodePoint(cp) ? 0 : isDoubleWidthCodePoint(cp) ? 2 : 1;
    if (w > maxWidth) maxWidth = w;
  }
  return maxWidth;
}

/** Strip trusted SGR and OSC 8 sequences to measure visible terminal column width. */
export function stripAnsiAndOsc8(text: string): string {
  return text
    .replace(/\u001b\]8;;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;]*m/g, '');
}

export function getDisplayWidth(text: string): number {
  const plain = stripAnsiAndOsc8(text);
  let width = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(plain)) {
    width += getGraphemeDisplayWidth(segment);
  }
  return width;
}

/**
 * Middle-truncate a sanitized path to fit within `maxCols` display cells without splitting
 * grapheme clusters. Returns `{ display, truncated }`.
 */
export function middleTruncatePath(
  safePath: string,
  maxCols: number,
  unicode = true,
): { display: string; truncated: boolean } {
  const fullWidth = getDisplayWidth(safePath);
  if (fullWidth <= maxCols) {
    return { display: safePath, truncated: false };
  }
  const ellipsis = unicode ? '…' : '...';
  const ellipsisWidth = ellipsis.length;
  const budget = Math.max(4, maxCols - ellipsisWidth);
  const headBudget = Math.ceil(budget / 2);
  const tailBudget = Math.floor(budget / 2);

  const segments = Array.from(GRAPHEME_SEGMENTER.segment(safePath), (s) => s.segment);
  let head = '';
  let headW = 0;
  for (const seg of segments) {
    const w = getGraphemeDisplayWidth(seg);
    if (headW + w > headBudget) break;
    head += seg;
    headW += w;
  }

  let tail = '';
  let tailW = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!;
    const w = getGraphemeDisplayWidth(seg);
    if (tailW + w > tailBudget) break;
    tail = seg + tail;
    tailW += w;
  }

  return { display: `${head}${ellipsis}${tail}`, truncated: true };
}

/**
 * Parse a git remote URL into a canonical, validated `https://<host>/<owner>/<repo>` base URL.
 * Rejects credentials, query strings, fragments, non-HTTPS protocols (except SSH `git@`),
 * unknown hosts, path traversal (`..`, `.`), and control characters.
 */
export function parseTrustedRemoteRepoUrl(remoteUrl: string | undefined): {
  baseUrl: string;
  commitPathSegment: 'commit' | 'commits';
} | undefined {
  if (!remoteUrl || typeof remoteUrl !== 'string') return undefined;
  const trimmed = remoteUrl.trim();
  if (trimmed === '' || trimmed.length > 512) return undefined;
  if (/[\u0000-\u0020\u007f-\u009f\p{Bidi_Control}?#\\]/u.test(trimmed)) return undefined;

  let host: string;
  let rawPath: string;

  if (trimmed.startsWith('https://')) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.port !== '') {
      return undefined;
    }
    if (parsed.search !== '' || parsed.hash !== '') return undefined;
    host = parsed.hostname.toLowerCase();
    rawPath = parsed.pathname;
  } else if (trimmed.startsWith('ssh://')) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (parsed.protocol !== 'ssh:' || parsed.username !== 'git' || parsed.password !== '' || parsed.port !== '') {
      return undefined;
    }
    if (parsed.search !== '' || parsed.hash !== '') return undefined;
    host = parsed.hostname.toLowerCase();
    rawPath = parsed.pathname;
  } else {
    // SCP-like syntax: git@github.com:owner/repo.git
    const scpMatch = /^git@([A-Za-z0-9.-]+):([^\s:]+)$/.exec(trimmed);
    if (!scpMatch) return undefined;
    host = scpMatch[1]!.toLowerCase();
    rawPath = `/${scpMatch[2]!}`;
  }

  const commitPathSegment = TRUSTED_GIT_HOSTS.get(host);
  if (!commitPathSegment) return undefined;

  const cleanPath = rawPath.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  const segments = cleanPath.split('/');
  if (segments.length < 2 || segments.length > 4) return undefined;
  // github.com, codeberg.org, bitbucket.org require exactly owner/repo (2 segments)
  if (host !== 'gitlab.com' && segments.length !== 2) return undefined;

  const validSegment = /^[A-Za-z0-9_.-]+$/;
  for (const seg of segments) {
    if (!validSegment.test(seg) || seg === '.' || seg === '..' || seg.startsWith('.') || seg.endsWith('.')) {
      return undefined;
    }
  }

  return {
    baseUrl: `https://${host}/${segments.join('/')}`,
    commitPathSegment,
  };
}

export function isValidCommitSha(sha: string | undefined): boolean {
  return typeof sha === 'string' && /^[0-9a-f]{7,64}$/i.test(sha);
}

/**
 * Construct a trusted OSC 8 hyperlink for a commit SHA when `links` are enabled and both the
 * repository remote and commit SHA pass strict validation. Falls back to plain `displaySha`.
 */
export function formatOsc8CommitLink(
  fullSha: string,
  displaySha: string,
  remoteUrl: string | undefined,
  linksEnabled: boolean,
): string {
  const safeDisplay = sanitizeRichText(displaySha);
  if (!linksEnabled || !isValidCommitSha(fullSha)) return safeDisplay;
  const repo = parseTrustedRemoteRepoUrl(remoteUrl);
  if (!repo) return safeDisplay;
  const commitUrl = `${repo.baseUrl}/${repo.commitPathSegment}/${fullSha.toLowerCase()}`;
  return `\u001b]8;;${commitUrl}\u001b\\${safeDisplay}\u001b]8;;\u001b\\`;
}

interface RichStyler {
  bold: (s: string) => string;
  dim: (s: string) => string;
  rule: (s: string) => string;
  markerBadge: (s: string) => string;
  cutBadge: (s: string) => string;
  relationshipBadge: (r: Relationship) => string;
  yellow: (s: string) => string;
  green: (s: string) => string;
  red: (s: string) => string;
  cyan: (s: string) => string;
  magenta: (s: string) => string;
  sha: (fullSha: string, shortSha: string) => string;
}

function createRichStyler(caps: TerminalCapabilities, remoteUrl?: string): RichStyler {
  const { colorLevel, links } = caps;
  const sgr = (open: string, close: string) => (s: string) =>
    colorLevel > 0 ? `\u001b[${open}m${s}\u001b[${close}m` : s;

  const bold = sgr('1', '22');
  const dim = sgr('2', '22');
  const yellow = sgr('33', '39');
  const green = sgr('32', '39');
  const red = sgr('31', '39');
  const cyan = sgr('36', '39');
  const magenta = sgr('35', '39');

  const rule = (s: string): string => {
    if (colorLevel === 0) return s;
    if (colorLevel === 3) {
      const [r, g, b] = FRAME12.terminal.ruleRgb;
      return `\u001b[38;2;${r};${g};${b}m${s}\u001b[39m`;
    }
    if (colorLevel === 2) {
      return `\u001b[38;5;${FRAME12.terminal.ansi256.rule}m${s}\u001b[39m`;
    }
    return dim(s);
  };

  // FRAME/12 marker-yellow (#ffd60a) background with India-ink (#121212) foreground.
  // Used at most ONCE per render on F-01 to denote rank #1 in the current ordering.
  const markerBadge = (s: string): string => {
    const label = ` ${s} `;
    if (colorLevel === 3) {
      const [br, bg, bb] = FRAME12.terminal.markerBgRgb;
      const [fr, fg, fb] = FRAME12.terminal.markerFgRgb;
      return `\u001b[1;48;2;${br};${bg};${bb};38;2;${fr};${fg};${fb}m${label}\u001b[0m`;
    }
    if (colorLevel === 2) {
      return `\u001b[1;48;5;${FRAME12.terminal.ansi256.markerBg};38;5;${FRAME12.terminal.ansi256.markerFg}m${label}\u001b[0m`;
    }
    if (colorLevel === 1) {
      return `\u001b[1;43;30m${label}\u001b[0m`;
    }
    return `[${s}]`;
  };

  const cutBadge = (s: string): string => {
    if (colorLevel === 0) return `[${s}]`;
    return bold(`[${s}]`);
  };

  const relationshipBadge = (r: Relationship): string => {
    const tag = NAMES[r].toUpperCase();
    const text = `[${tag}] (${NAMES[r]})`;
    if (colorLevel === 0) return text;
    if (colorLevel === 3) {
      const rgbMap: Record<Relationship, readonly [number, number, number]> = {
        ghost: FRAME12.terminal.ghostRgb,
        unknown: FRAME12.terminal.unknownRgb,
        indirect: FRAME12.terminal.indirectRgb,
        direct: FRAME12.terminal.directRgb,
        test: FRAME12.terminal.testRgb,
      };
      const [redC, greenC, blueC] = rgbMap[r];
      return `\u001b[1;38;2;${redC};${greenC};${blueC}m[${tag}]\u001b[22;39m ${dim(`(${NAMES[r]})`)}`;
    }
    const ansi16Map: Record<Relationship, (v: string) => string> = {
      ghost: magenta,
      unknown: yellow,
      indirect: cyan,
      direct: sgr('34', '39'),
      test: green,
    };
    return `${bold(ansi16Map[r](`[${tag}]`))} ${dim(`(${NAMES[r]})`)}`;
  };

  const sha = (fullSha: string, shortSha: string): string => {
    const linked = formatOsc8CommitLink(fullSha, shortSha, remoteUrl, links);
    return colorLevel > 0 ? `\u001b[90m${linked}\u001b[39m` : linked;
  };

  return {
    bold,
    dim,
    rule,
    markerBadge,
    cutBadge,
    relationshipBadge,
    yellow,
    green,
    red,
    cyan,
    magenta,
    sha,
  };
}

function formatCutId(index0Based: number): string {
  return `F-${String(index0Based + 1).padStart(2, '0')}`;
}

function formatRichVerdict(verdict: RelationshipVerdictView, styler: RichStyler): string {
  const badge =
    verdict.kind === 'confirmed'
      ? styler.green('confirmed')
      : styler.yellow('expected (silenced)');
  const metaParts: string[] = [];
  if (verdict.by) metaParts.push(`by ${sanitizeRichText(verdict.by)}`);
  if (verdict.until) metaParts.push(`until ${sanitizeRichText(verdict.until)}`);
  const metaStr = metaParts.length > 0 ? styler.dim(` (${metaParts.join(', ')})`) : '';
  return `${badge}${metaStr}: ${sanitizeRichText(verdict.reason)}`;
}

function formatRichStrength(view: RelationshipView): string {
  const wLabel = weightingLabel(view);
  const countsAndRate = view.weighted
    ? `${view.shared} of ${view.fromChanges} commits ${formatIntervalCi(view.interval, true)} (${pct(view.confidence)} ${wLabel})`
    : `${view.shared} of ${view.fromChanges} commits (${pct(view.confidence)}) ${formatIntervalCi(view.interval)}`;
  return `${countsAndRate} · last together ${timeAgo(Date.parse(view.lastTogether) / 1000)}`;
}

function renderRichHeader(
  commandTitle: string,
  meta: Meta,
  caps: TerminalCapabilities,
  styler: RichStyler,
): string[] {
  const lines: string[] = [];
  const ruleChar = caps.unicode ? '━' : '=';
  const dot = caps.unicode ? '·' : '|';
  const ruleWidth = Math.min(caps.columns, 76);
  lines.push(styler.rule(ruleChar.repeat(ruleWidth)));
  lines.push(
    `${styler.bold('FRAME/12')} ${styler.dim(dot)} ${styler.bold('Repo Archaeology')} ${styler.dim(dot)} ${commandTitle}`,
  );
  const span =
    meta.oldestCommit && meta.newestCommit
      ? ` from ${ sanitizeRichText(meta.oldestCommit)} to ${sanitizeRichText(meta.newestCommit)}`
      : '';
  const skippedParts = [
    meta.sweepsSkipped > 0 ? plural(meta.sweepsSkipped, 'sweeping commit') : '',
    meta.subjectSkipped > 0 ? `${meta.subjectSkipped} matching --skip-commits` : '',
  ].filter(Boolean);
  const skipped = skippedParts.length > 0 ? `, ${skippedParts.join(' and ')} skipped` : '';
  lines.push(styler.dim(`${plural(meta.commitsAnalyzed, 'commit')} analyzed${span}${skipped}`));
  lines.push(styler.rule(ruleChar.repeat(ruleWidth)));
  for (const warning of meta.warnings) {
    lines.push(styler.yellow(`! ${sanitizeRichText(warning)}`));
  }
  lines.push('');
  return lines;
}

function renderRichEvidence(
  evidence: EvidenceView[],
  caps: TerminalCapabilities,
  styler: RichStyler,
  options: { indent?: string; fullEvidence?: boolean; explainHint?: string } = {},
): string[] {
  const indent = options.indent ?? '    ';
  const lines: string[] = [];
  if (evidence.length === 0) return lines;

  const primaryLimit = options.fullEvidence ? evidence.length : Math.min(3, evidence.length);
  const primary = evidence.slice(0, primaryLimit);
  const overflow = options.fullEvidence ? [] : evidence.slice(primaryLimit);

  const formatEntry = (e: EvidenceView): string => {
    const hashStr = styler.sha(e.hash, shortHash(e.hash));
    const dateStr = styler.dim(sanitizeRichText(e.date));
    const subjectStr = sanitizeRichText(e.subject);
    return `${indent}${hashStr} ${dateStr}  ${subjectStr}`;
  };

  for (const e of primary) {
    lines.push(formatEntry(e));
  }
  if (overflow.length > 0) {
    lines.push(
      styler.dim(
        `${indent}Additional receipts (+${overflow.length} more; pass --full-evidence to inline):`,
      ),
    );
    for (const e of overflow) {
      lines.push(formatEntry(e));
    }
  }
  if (options.explainHint) {
    lines.push(styler.dim(`${indent}Inspect: ${options.explainHint}`));
  }
  return lines;
}

function formatHeadlinePair(
  leftPath: string,
  rightPath: string,
  arrow: string,
  caps: TerminalCapabilities,
  styler: RichStyler,
): { headline: string; fullPathsLine?: string } {
  const safeLeft = sanitizeRichText(leftPath);
  const safeRight = sanitizeRichText(rightPath);
  const pairBudget = Math.max(12, caps.columns - 24);
  const combinedWidth = getDisplayWidth(safeLeft) + getDisplayWidth(safeRight) + 3;

  if (combinedWidth <= pairBudget) {
    return {
      headline: `${styler.bold(safeLeft)} ${styler.dim(arrow)} ${styler.bold(safeRight)}`,
    };
  }

  const eachBudget = Math.max(6, Math.floor((pairBudget - 3) / 2));
  const leftTrunc = middleTruncatePath(safeLeft, eachBudget, caps.unicode);
  const rightTrunc = middleTruncatePath(safeRight, eachBudget, caps.unicode);
  return {
    headline: `${styler.bold(leftTrunc.display)} ${styler.dim(arrow)} ${styler.bold(rightTrunc.display)}`,
    fullPathsLine: `    paths: ${safeLeft} ${arrow} ${safeRight}`,
  };
}

function renderScanFamilies(
  families: FindingFamilyView[],
  caps: TerminalCapabilities,
  styler: RichStyler,
): string[] {
  const lines: string[] = [];
  if (!families || families.length === 0) return lines;
  const dot = caps.unicode ? '·' : '|';
  lines.push(styler.bold(`Finding families (${families.length})`));
  lines.push('');
  families.forEach((fam, idx) => {
    const n = styler.dim(`${String(idx + 1).padStart(2)}.`);
    const variants = fam.members.map((m) => sanitizeRichText(m.variant)).join(` ${dot} `);
    const kinds = fam.relationshipKinds.map((k) => styler.relationshipBadge(k)).join(styler.dim(', '));
    lines.push(
      `${n} ${styler.bold(sanitizeRichText(fam.label))}  ${styler.cyan(`${fam.members.length} related implementations`)} ${styler.dim(dot)} ${kinds}`,
    );
    lines.push(`    members: ${variants}`);
    const pairNote = fam.complete
      ? `all ${fam.possiblePairs} pairwise links met thresholds`
      : `${fam.qualifyingPairs} of ${fam.possiblePairs} pairwise links met thresholds`;
    lines.push(
      `    ${plural(fam.commitsTouchingTwoOrMore, 'supporting commit')} (2+ members via a qualifying pair) ${dot} ${plural(fam.commitsTouchingAll, 'commit')} touched all ${fam.members.length} ${dot} ${pairNote} ${dot} last together ${timeAgo(Date.parse(fam.lastTogether) / 1000)}`,
    );
    for (const ev of fam.evidence) {
      const scope = ev.touchesAllMembers
        ? `all ${ev.totalMembers} members`
        : `${ev.membersTouched} of ${ev.totalMembers} members`;
      lines.push(
        `    ${styler.sha(ev.hash, shortHash(ev.hash))} ${styler.dim(sanitizeRichText(ev.date))}  ${sanitizeRichText(ev.subject)} ${styler.dim(`[${scope}]`)}`,
      );
    }
    lines.push('');
  });
  return lines;
}

export function formatRichScan(
  result: ScanResult,
  options: ScanOptions,
  renderOpts: RichRenderOptions = {},
): string {
  const caps = detectTerminalCapabilities(renderOpts);
  const styler = createRichStyler(caps, renderOpts.remoteUrl);
  const dot = caps.unicode ? '·' : '|';
  const arrow = caps.unicode ? '→' : '->';
  const subRule = styler.rule((caps.unicode ? '─' : '-').repeat(Math.min(caps.columns, 64)));
  const lines = renderRichHeader('scan', result.meta, caps, styler);

  const { counts } = result;
  const total = RELATIONSHIPS.reduce((sum, r) => sum + counts[r], 0);
  if (total === 0) {
    lines.push('No files changed together often enough to report.');
    if (result.verdicts?.silenced) {
      lines.push(styler.dim(`(${result.verdicts.silenced} silenced by verdicts; use --show-silenced)`));
    } else {
      lines.push(
        styler.dim(
          `Try lowering --min-shared (now ${result.meta.settings.minShared}) or --min-confidence (now ${pct(result.meta.settings.minConfidence)}).`,
        ),
      );
    }
    return `${lines.join('\n')}\n`;
  }

  const counted = RELATIONSHIPS.map((r) => `${counts[r]} ${NAMES[r]}`).join(` ${dot} `);
  lines.push(
    result.truncated
      ? `${result.qualifying} relationships above the thresholds; strongest ${result.classified} classified: ${counted}`
      : `${total} relationships above the thresholds: ${counted}`,
  );
  lines.push(
    styler.dim(
      `Showing ${options.kinds.map((k) => NAMES[k]).join(', ')}. Change with --kinds ghost,unknown,indirect,direct,test.`,
    ),
  );
  if (result.verdicts?.silenced) {
    lines.push(styler.dim(`(${result.verdicts.silenced} silenced by verdicts; use --show-silenced)`));
  }
  lines.push('');

  if (result.relationships.length === 0) {
    lines.push(
      result.truncated
        ? 'Nothing of the selected kinds was found within the classification limit.'
        : 'Nothing of the selected kinds. Everything that changes together is explained by imports (direct or one step removed) or tests.',
    );
    return `${lines.join('\n')}\n`;
  }

  if (result.families && result.families.length > 0) {
    lines.push(...renderScanFamilies(result.families, caps, styler));
    lines.push(styler.bold(`Individual relationships (${result.relationships.length})`));
    lines.push('');
  }

  result.relationships.forEach((view, i) => {
    const cutId = formatCutId(i);
    // Exactly one marker-yellow badge per render on F-01 (rank #1 in current ordering)
    const badge = i === 0 ? styler.markerBadge(`${cutId} · #1 IN RANKING`) : styler.cutBadge(cutId);
    const { headline, fullPathsLine } = formatHeadlinePair(view.from, view.to, arrow, caps, styler);
    const safeFrom = sanitizeRichText(view.from);
    const safeTo = sanitizeRichText(view.to);

    lines.push(`${badge} ${headline}  ${styler.relationshipBadge(view.relationship)}`);
    if (fullPathsLine) lines.push(styler.dim(fullPathsLine));
    lines.push(`    when ${safeFrom} changed, ${safeTo} changed too in ${formatRichStrength(view)}`);
    lines.push(styler.dim(`    reverse: ${pct(view.reverseConfidence)} ${dot} ${sanitizeRichText(view.why)}`));
    if (view.verdict) {
      lines.push(`    ${formatRichVerdict(view.verdict, styler)}`);
    }
    lines.push(
      ...renderRichEvidence(view.evidence, caps, styler, {
        fullEvidence: renderOpts.fullEvidence,
        explainHint: `repo-archaeology explain "${safeFrom}" "${safeTo}"`,
      }),
    );
    if (i < result.relationships.length - 1) {
      lines.push(`    ${subRule}`);
    }
    lines.push('');
  });

  lines.push(styler.dim(DISCLAIMER));
  return `${lines.join('\n')}\n`;
}

export function printRichScan(
  result: ScanResult,
  options: ScanOptions,
  renderOpts: RichRenderOptions = {},
): void {
  stdout.write(formatRichScan(result, options, renderOpts));
}

export function formatRichDiff(result: DiffResult, renderOpts: RichRenderOptions = {}): string {
  const caps = detectTerminalCapabilities(renderOpts);
  const styler = createRichStyler(caps, renderOpts.remoteUrl);
  const dot = caps.unicode ? '·' : '|';
  const arrow = caps.unicode ? '←' : '<-';
  const bullet = caps.unicode ? '•' : '*';
  const checkMark = caps.unicode ? '✓' : 'OK';
  const subRule = styler.rule((caps.unicode ? '─' : '-').repeat(Math.min(caps.columns, 64)));

  const headerTitle = result.base
    ? `diff ${styler.dim(`(${sanitizeRichText(result.base)}...HEAD + uncommitted changes)`)}`
    : `diff ${styler.dim('(uncommitted changes)')}`;
  const lines = renderRichHeader(headerTitle, result.meta, caps, styler);

  if (result.changed.length === 0) {
    lines.push(
      result.base
        ? 'No changes on this branch or in the working tree.'
        : 'No uncommitted changes. Use --base main to check a whole branch.',
    );
    return `${lines.join('\n')}\n`;
  }

  const withoutHistory = result.changed.filter((f) => !f.hasHistory).length;
  const withHistory = result.changed.length - withoutHistory;
  const note = withoutHistory > 0 ? styler.dim(` (${withoutHistory} new or without usable history)`) : '';
  const silencedCount = result.verdicts?.silenced ?? result.silence?.verdicts?.silenced ?? 0;
  const silencedNote =
    silencedCount > 0
      ? styler.dim(` (${plural(silencedCount, 'expected relationship')} silenced by verdicts)`)
      : '';
  lines.push(`You changed ${plural(result.changed.length, 'file')}${note}${silencedNote}.`);
  const addedInBranch = result.verdicts?.addedInBranch ?? result.silence?.verdicts?.addedInBranch ?? 0;
  if (addedInBranch > 0) {
    lines.push(styler.dim(`This PR adds ${plural(addedInBranch, 'expected verdict')} (not applied until merged).`));
  }
  lines.push('');

  if (result.suggestions.length === 0) {
    if (withHistory === 0) {
      lines.push(styler.dim('No suggestions: none of the changed files have usable history to evaluate.'));
      if (result.silence) {
        for (const detail of result.silence.details.slice(1)) {
          lines.push(styler.dim(`  ${bullet} ${sanitizeRichText(detail)}`));
        }
      }
    } else if (!result.silence) {
      lines.push(
        styler.green(
          `${checkMark} Nothing obviously missing: evaluated ${plural(withHistory, 'file')}; no untouched file usually changes alongside ${withHistory === 1 ? 'it' : 'them'}.`,
        ),
      );
    } else {
      lines.push(`No suggestions after evaluating ${plural(withHistory, 'file')}:`);
      for (const detail of result.silence.details) {
        lines.push(`  ${bullet} ${sanitizeRichText(detail)}`);
      }
      lines.push(
        styler.dim(
          'Silence means no untouched file met the active historical criteria; it does not guarantee the change is complete.',
        ),
      );
    }
    return `${lines.join('\n')}\n`;
  }

  if (result.families && result.families.length > 0) {
    const shownSuggested = new Set(result.suggestions.map((s) => s.to));
    lines.push(styler.bold(`Finding families (${result.families.length})`));
    for (const fam of result.families as DiffFamilyView[]) {
      const pairNote = fam.complete
        ? `all ${fam.possiblePairs} pairwise links met thresholds`
        : `${fam.qualifyingPairs} of ${fam.possiblePairs} pairwise links met thresholds`;
      const suggestedLabels = fam.suggestedMembers.map((p) =>
        shownSuggested.has(p)
          ? styler.bold(sanitizeRichText(p))
          : `${styler.bold(sanitizeRichText(p))} ${styler.dim('(beyond --limit)')}`,
      );
      lines.push(
        `  ${styler.bold(sanitizeRichText(fam.label))} — changed ${fam.changedMembers.map(sanitizeRichText).join(', ')}; check ${suggestedLabels.join(', ')} ${styler.dim(`(${pairNote} ${dot} ${plural(fam.commitsTouchingTwoOrMore, 'supporting commit')} (2+ members via a qualifying pair))`)}`,
      );
    }
    lines.push('');
  }

  lines.push(styler.bold(`Possibly missed (${result.suggestions.length})`));
  lines.push('');

  result.suggestions.forEach((s: Suggestion, i: number) => {
    const cutId = formatCutId(i);
    // Exactly one marker-yellow badge per render on F-01 (rank #1 in current ordering)
    const badge = i === 0 ? styler.markerBadge(`${cutId} · #1 IN RANKING`) : styler.cutBadge(cutId);
    const { headline, fullPathsLine } = formatHeadlinePair(s.to, s.from, arrow, caps, styler);
    const safeFrom = sanitizeRichText(s.from);
    const safeTo = sanitizeRichText(s.to);

    lines.push(`  ${badge} ${headline}  ${styler.relationshipBadge(s.relationship)}`);
    if (fullPathsLine) lines.push(styler.dim(fullPathsLine));
    lines.push(`    changed with ${safeFrom} in ${formatRichStrength(s)}`);
    if (s.alsoLinkedFrom.length > 0) {
      lines.push(styler.dim(`    also linked to: ${s.alsoLinkedFrom.map(sanitizeRichText).join(', ')}`));
    }
    lines.push(styler.dim(`    ${sanitizeRichText(s.why)}`));
    if (s.verdict) {
      lines.push(`    ${formatRichVerdict(s.verdict, styler)}`);
    }
    const baseArg = result.base ? ` --base "${sanitizeRichText(result.base)}"` : '';
    lines.push(
      ...renderRichEvidence(s.evidence, caps, styler, {
        fullEvidence: renderOpts.fullEvidence,
        explainHint: `repo-archaeology explain "${safeFrom}" "${safeTo}"${baseArg}`,
      }),
    );
    if (i < result.suggestions.length - 1) {
      lines.push(`    ${subRule}`);
    }
    lines.push('');
  });

  lines.push(styler.dim(DISCLAIMER));
  return `${lines.join('\n')}\n`;
}

export function printRichDiff(result: DiffResult, renderOpts: RichRenderOptions = {}): void {
  stdout.write(formatRichDiff(result, renderOpts));
}

export function formatRichFile(result: FileResult, renderOpts: RichRenderOptions = {}): string {
  const caps = detectTerminalCapabilities(renderOpts);
  const styler = createRichStyler(caps, renderOpts.remoteUrl);
  const dot = caps.unicode ? '·' : '|';
  const alertDot = caps.unicode ? '●' : '*';
  const quietDot = caps.unicode ? '○' : 'o';
  const gte = caps.unicode ? '≥' : '>=';
  const timesSign = caps.unicode ? '×' : 'x';
  const safePath = sanitizeRichText(result.path);

  const lines = renderRichHeader(`file ${styler.bold(safePath)}`, result.meta, caps, styler);
  const times =
    result.medianChanges > 0
      ? ` (${(result.changes / result.medianChanges).toFixed(1)}${timesSign} the median file)`
      : '';
  const label = (s: string) => styler.bold(s.padEnd(14));
  lines.push(
    `${label('Changed in')}${plural(result.changes, 'commit')}${times}, busier than ${pct(result.churnPercentile)} of files`,
  );
  lines.push(
    `${label('Last changed')}${timeAgo(Date.parse(result.lastChanged) / 1000)} ${styler.dim(`(${sanitizeRichText(result.lastChanged)})`)}`,
  );
  const who = result.authors
    .map((a) => `${sanitizeRichText(a.author)} ${styler.dim(pct(a.share))}`)
    .join(', ');
  lines.push(`${label('Who knows it')}${who}`);
  lines.push('');

  if (result.companions.length === 0) {
    lines.push(`No file changed with it at least ${result.meta.settings.minShared} times.`);
    if (result.verdicts?.silenced) {
      lines.push(styler.dim(`(${result.verdicts.silenced} silenced by verdicts; use --show-silenced)`));
    }
    return `${lines.join('\n')}\n`;
  }

  lines.push(styler.bold('Files that move with it'));
  lines.push(
    styler.dim(
      `${alertDot} = strong enough for \`diff\` to flag it (${gte} ${pct(result.meta.settings.minConfidence)} confidence)`,
    ),
  );
  if (result.verdicts?.silenced) {
    lines.push(styler.dim(`(${result.verdicts.silenced} silenced by verdicts; use --show-silenced)`));
  }
  lines.push('');

  result.companions.forEach((comp: FileCompanionView, i: number) => {
    const cutId = formatCutId(i);
    const badge = i === 0 ? styler.markerBadge(`${cutId} · #1 IN RANKING`) : styler.cutBadge(cutId);
    const statusDot = comp.wouldAlert ? styler.magenta(alertDot) : styler.dim(quietDot);
    const safeTo = sanitizeRichText(comp.to);
    const truncTo = middleTruncatePath(safeTo, Math.max(12, caps.columns - 24), caps.unicode);

    lines.push(`  ${statusDot} ${badge} ${styler.bold(truncTo.display)}  ${styler.relationshipBadge(comp.relationship)}`);
    if (truncTo.truncated) {
      lines.push(styler.dim(`    path: ${safeTo}`));
    }
    lines.push(`    ${formatRichStrength(comp)} ${dot} reverse ${pct(comp.reverseConfidence)}`);
    lines.push(styler.dim(`    ${sanitizeRichText(comp.why)}`));
    if (comp.verdict) {
      lines.push(`    ${formatRichVerdict(comp.verdict, styler)}`);
    }
    lines.push(
      ...renderRichEvidence(comp.evidence, caps, styler, {
        fullEvidence: renderOpts.fullEvidence,
        explainHint: `repo-archaeology explain "${safePath}" "${safeTo}"`,
      }),
    );
    lines.push('');
  });

  return `${lines.join('\n')}\n`;
}

export function printRichFile(result: FileResult, renderOpts: RichRenderOptions = {}): void {
  stdout.write(formatRichFile(result, renderOpts));
}

function hasUnexplainedPatchTruncation(patch: FilePatchEvidence): boolean {
  if (!patch.truncated && !patch.timedOut && !patch.rawTruncated) return false;
  if (patch.timedOut || patch.rawTruncated) return true;
  if (patch.omittedHunks === 0 && patch.omittedLines === 0) return true;
  return patch.hunks.some((h) => h.truncated && h.omittedLines === 0);
}

function renderRichFilePatch(
  patch: FilePatchEvidence,
  caps: TerminalCapabilities,
  styler: RichStyler,
  indent = '    ',
): string[] {
  const lines: string[] = [];
  const ellipsis = caps.unicode ? '…' : '...';
  const arrow = caps.unicode ? '→' : '->';
  const current = sanitizeRichText(patch.canonicalPath);
  const historical = sanitizeRichText(patch.path);
  const old = patch.oldPath ? sanitizeRichText(patch.oldPath) : undefined;
  const pathLabel =
    old && old !== patch.path
      ? `${styler.bold(current)} ${styler.dim(`[${patch.status}: ${old} ${arrow} ${historical}]`)}`
      : patch.path !== patch.canonicalPath
        ? `${styler.bold(current)} ${styler.dim(`[${patch.status} at ${historical}]`)}`
        : `${styler.bold(current)} ${styler.dim(`[${patch.status}]`)}`;

  lines.push(`${indent}${pathLabel}`);
  if (patch.hunks.length === 0) {
    lines.push(`${indent}  ${styler.dim(sanitizeRichText(patch.statusNote ?? 'No textual diff hunks'))}`);
    return lines;
  }

  for (const hunk of patch.hunks) {
    lines.push(`${indent}  ${styler.cyan(sanitizeRichText(hunk.header))}`);
    for (const rawLine of hunk.lines) {
      const safeLine = sanitizeRichText(rawLine);
      if (rawLine.startsWith('+')) {
        lines.push(`${indent}    ${styler.green(safeLine)}`);
      } else if (rawLine.startsWith('-')) {
        lines.push(`${indent}    ${styler.red(safeLine)}`);
      } else {
        lines.push(`${indent}    ${styler.dim(safeLine)}`);
      }
    }
    if (hunk.omittedLines > 0) {
      lines.push(`${indent}    ${styler.dim(`${ellipsis} (${plural(hunk.omittedLines, 'line')} omitted in hunk)`)}`);
    }
  }
  if (patch.omittedHunks > 0) {
    const hunkCountStr = patch.rawTruncated
      ? `${patch.omittedHunks.toLocaleString('en-US')}+ ${patch.omittedHunks === 1 ? 'additional hunk' : 'additional hunks'}`
      : plural(patch.omittedHunks, 'additional hunk');
    lines.push(`${indent}  ${styler.dim(`${ellipsis} (${hunkCountStr} omitted for this file)`)}`);
  }
  if (hasUnexplainedPatchTruncation(patch)) {
    const reason = patch.timedOut ? 'time limit' : 'byte/time limit';
    lines.push(`${indent}  ${styler.dim(`${ellipsis} (patch truncated due to ${reason})`)}`);
  }
  return lines;
}

export function formatRichExplain(result: ExplainResult, renderOpts: RichRenderOptions = {}): string {
  const caps = detectTerminalCapabilities(renderOpts);
  const styler = createRichStyler(caps, renderOpts.remoteUrl);
  const dot = caps.unicode ? '·' : '|';
  const arrow = caps.unicode ? '→' : '->';
  const biArrow = caps.unicode ? '↔' : '<->';
  const gte = caps.unicode ? '≥' : '>=';
  const safeFrom = sanitizeRichText(result.from);
  const safeTo = sanitizeRichText(result.to);

  const lines = renderRichHeader(
    `explain ${styler.bold(safeFrom)} ${styler.dim(biArrow)} ${styler.bold(safeTo)}`,
    result.meta,
    caps,
    styler,
  );

  const wLabel = weightingLabel(result);
  const dirA = result.weighted
    ? `${result.shared} of ${result.fromChanges} commits ${formatIntervalCi(result.interval, true)} (${pct(result.confidence)} ${wLabel})`
    : `${result.shared} of ${result.fromChanges} commits (${pct(result.confidence)}) ${formatIntervalCi(result.interval)}`;
  const dirB = result.weighted
    ? `${result.shared} of ${result.toChanges} commits ${formatIntervalCi(result.reverseInterval, true)} (${pct(result.reverseConfidence)} ${wLabel})`
    : `${result.shared} of ${result.toChanges} commits (${pct(result.reverseConfidence)}) ${formatIntervalCi(result.reverseInterval)}`;
  const lastStr = result.lastTogether
    ? ` ${dot} last together ${timeAgo(Date.parse(result.lastTogether) / 1000)} (${sanitizeRichText(result.lastTogether)})`
    : '';

  const { headline, fullPathsLine } = formatHeadlinePair(result.from, result.to, biArrow, caps, styler);
  lines.push(`${styler.markerBadge('F-01 · PAIR EVIDENCE')} ${headline}`);
  if (fullPathsLine) lines.push(styler.dim(fullPathsLine));
  lines.push(`${styler.bold('Relationship')}  ${styler.relationshipBadge(result.relationship)}${lastStr}`);
  lines.push(`${styler.bold('Why')}           ${sanitizeRichText(result.why)}`);
  if (result.verdict) {
    lines.push(`${styler.bold('Verdict')}       ${formatRichVerdict(result.verdict, styler)}`);
  }
  lines.push(`${styler.bold('Direction')}     ${safeFrom} ${arrow} ${safeTo}: ${dirA}`);
  lines.push(`              ${safeTo} ${arrow} ${safeFrom}: ${dirB}`);
  if (!result.meetsThresholds) {
    lines.push(
      styler.yellow(
        `Note: This pair is below configured alert thresholds (requires ${gte}${result.meta.settings.minShared} shared commits and ${gte}${pct(result.meta.settings.minConfidence)} confidence).`,
      ),
    );
  }
  lines.push('');

  if (result.sharedCommits.length === 0) {
    lines.push('No shared commits found between these two files in the analyzed history.');
  } else {
    const showing =
      result.shared > result.sharedCommits.length
        ? `${result.sharedCommits.length} most recent of ${plural(result.shared, 'shared commit')}`
        : plural(result.sharedCommits.length, 'shared commit');
    lines.push(styler.bold(`Shared commits (${showing})`));
    lines.push('');
    for (const commit of result.sharedCommits) {
      const linkedShort = styler.sha(commit.hash, shortHash(commit.hash));
      lines.push(
        `  ${styler.bold(linkedShort)} ${styler.dim(`(${sanitizeRichText(commit.hash)})`)} ${dot} ${sanitizeRichText(commit.date)} ${dot} ${sanitizeRichText(commit.author)}`,
      );
      lines.push(`  ${sanitizeRichText(commit.subject)}`);
      lines.push(...renderRichFilePatch(commit.fileA, caps, styler, '    '));
      lines.push(...renderRichFilePatch(commit.fileB, caps, styler, '    '));
      lines.push('');
    }
  }

  const { fromWithoutTo, toWithoutFrom, fromWithoutToTotal, toWithoutFromTotal } = result.counterexamples;
  if (fromWithoutToTotal > 0 || toWithoutFromTotal > 0) {
    lines.push(styler.bold('When one file changed without the other'));
    const appendSide = (
      labelFile: string,
      otherFile: string,
      total: number,
      list: CounterexampleCommitEvidence[],
    ) => {
      const safeLabel = sanitizeRichText(labelFile);
      const safeOther = sanitizeRichText(otherFile);
      if (total === 0) {
        lines.push(`  ${safeLabel} without ${safeOther}: 0 commits`);
        return;
      }
      const suffix =
        total > list.length ? ` (showing ${list.length} most recent of ${total})` : ` (${plural(total, 'commit')})`;
      lines.push(`  ${styler.bold(safeLabel)} without ${safeOther}${styler.dim(suffix)}`);
      for (const item of list) {
        const pathNote =
          item.historicalPath !== labelFile
            ? ` ${styler.dim(`[at ${sanitizeRichText(item.historicalPath)}]`)}`
            : '';
        lines.push(
          `    ${styler.sha(item.hash, shortHash(item.hash))} ${styler.dim(sanitizeRichText(item.date))}  ${sanitizeRichText(item.subject)}${pathNote}`,
        );
        if (item.patch) {
          lines.push(...renderRichFilePatch(item.patch, caps, styler, '      '));
        }
      }
    };
    appendSide(result.from, result.to, fromWithoutToTotal, fromWithoutTo);
    appendSide(result.to, result.from, toWithoutFromTotal, toWithoutFrom);
    lines.push('');
  }

  lines.push(styler.dim(EXPLAIN_DISCLAIMER));
  return `${lines.join('\n')}\n`;
}

export function printRichExplain(result: ExplainResult, renderOpts: RichRenderOptions = {}): void {
  stdout.write(formatRichExplain(result, renderOpts));
}

export interface RichSpinnerController {
  update: (message: string) => void;
  stop: () => void;
}

const SPINNER_FRAMES_UNICODE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const SPINNER_FRAMES_ASCII = ['-', '\\', '|', '/'] as const;

/**
 * Delayed 12fps (`83.33ms` pose duration) progress indicator for `--style rich`.
 * Suppresses animation in non-TTY, CI, `TERM=dumb`, or reduced-motion environments,
 * unrefs timers so the event loop is never held open, and cleans up the stderr line before stopping.
 */
export function startRichProgressSpinner(options: CapabilityOptions = {}): RichSpinnerController {
  const caps = detectTerminalCapabilities({
    ...options,
    isTTY: options.isTTY ?? Boolean(stderr.isTTY),
  });

  if (caps.reducedMotion || !stderr.isTTY) {
    setProgressHandler((msg: string) => {
      if (stderr.isTTY) {
        stderr.write(`${ sanitizeRichText(msg)}\n`);
      }
    });
    return {
      update: () => {},
      stop: () => {
        setProgressHandler(undefined);
      },
    };
  }

  const frames = caps.unicode ? SPINNER_FRAMES_UNICODE : SPINNER_FRAMES_ASCII;
  let currentMessage = 'Reading git history…';
  let frameIndex = 0;
  let rendered = false;
  let stopped = false;
  let intervalTimer: ReturnType<typeof setInterval> | undefined;

  const renderFrame = () => {
    if (stopped || !stderr.isTTY) return;
    const frame = frames[frameIndex % frames.length]!;
    frameIndex++;
    rendered = true;
    try {
      stderr.write(`\r\u001b[K${frame} ${sanitizeRichText(currentMessage)}`);
    } catch {
      // Ignore broken stderr pipe
    }
  };

  const delayTimer = setTimeout(() => {
    if (stopped) return;
    renderFrame();
    intervalTimer = setInterval(renderFrame, FRAME12.motion.poseMs);
    intervalTimer.unref?.();
  }, 150);
  delayTimer.unref?.();

  const update = (message: string) => {
    currentMessage = message;
    if (rendered) renderFrame();
  };

  setProgressHandler(update);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(delayTimer);
    if (intervalTimer !== undefined) clearInterval(intervalTimer);
    setProgressHandler(undefined);
    if (rendered && stderr.isTTY) {
      try {
        stderr.write('\r\u001b[K');
      } catch {
        // Ignore broken stderr pipe
      }
    }
  };

  return { update, stop };
}
