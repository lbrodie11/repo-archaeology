import { stderr, stdout } from 'node:process';
import { FRAME12 } from '../style/frame12.js';
import { setProgressHandler } from '../util/term.js';

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

/** Expand literal tabs into spaces for clean diff hunk rendering in rich mode. */
export function expandRichTabs(value: string, tabSize = 4): string {
  if (!value || !value.includes('\t')) return value;
  return value.replace(/\t/g, ' '.repeat(tabSize));
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
        stderr.write(`${sanitizeRichText(msg)}\n`);
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
