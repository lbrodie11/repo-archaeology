/**
 * What Repo Archaeology's terminal output still needs beyond `@frame12/terminal` (RA-21):
 * the trusted-remote rules for commit links, and the delayed 12 fps progress spinner on stderr.
 * Capabilities, sanitizing, display width and OSC 8 now come from `@frame12/terminal`.
 */
import { stderr } from 'node:process';
import { detectCapabilities, POSE_MS, resolveTerminalMotion, sanitizeText, type Env } from '@frame12/terminal';
import { setProgressHandler } from '../util/term.js';

const TRUSTED_GIT_HOSTS = new Map<string, 'commit' | 'commits'>([
  ['github.com', 'commit'],
  ['gitlab.com', 'commit'],
  ['codeberg.org', 'commit'],
  ['bitbucket.org', 'commits'],
]);

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
 * The web URL of a commit on a trusted host, or `undefined` when the remote or SHA does not pass
 * strict validation. `@frame12/terminal` decides whether to emit it as an OSC 8 link (`https:` only,
 * links enabled) and sanitizes it again.
 */
export function commitUrl(remoteUrl: string | undefined, sha: string): string | undefined {
  if (!isValidCommitSha(sha)) return undefined;
  const repo = parseTrustedRemoteRepoUrl(remoteUrl);
  if (!repo) return undefined;
  return `${repo.baseUrl}/${repo.commitPathSegment}/${sha.toLowerCase()}`;
}

export interface RichSpinnerController {
  update: (message: string) => void;
  stop: () => void;
}

export interface SpinnerOptions {
  /** Capability argv (see `capabilityArgv`): `--ascii`, `--screen-reader`, ... */
  argv?: readonly string[];
  env?: Env;
  /** Defaults to `process.stderr.isTTY`. */
  isTTY?: boolean;
}

const SPINNER_FRAMES_UNICODE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const SPINNER_FRAMES_ASCII = ['-', '\\', '|', '/'] as const;

/** `REPO_ARCHAEOLOGY_NO_MOTION` (non-empty, not `0`) stills the spinner, like `NO_MOTION`. */
function repoArchaeologyNoMotion(env: Env): boolean {
  const v = env.REPO_ARCHAEOLOGY_NO_MOTION;
  return v !== undefined && v.trim() !== '' && v.trim() !== '0';
}

/**
 * Delayed 12 fps (`POSE_MS`, 83.33 ms) progress indicator on stderr for `--style rich`.
 * Motion follows `@frame12/terminal`'s rules (`NO_MOTION`, `REDUCED_MOTION`, `FRAME12_MOTION`, CI,
 * screen readers, `TERM=dumb`, not a TTY all mean still) plus `REPO_ARCHAEOLOGY_NO_MOTION`. When
 * still, progress messages are written as plain append-only lines (only to a TTY). Timers are
 * unref'd so the event loop is never held open, and the line is cleared before stopping.
 */
export function startRichProgressSpinner(options: SpinnerOptions = {}): RichSpinnerController {
  const env = options.env ?? (process.env as Env);
  const argv = options.argv ?? [];
  const isTTY = options.isTTY ?? Boolean(stderr.isTTY);
  // The spinner draws on stderr, so stderr is the stream whose capabilities matter.
  const caps = detectCapabilities(env, { stdin: process.stdin, stdout: { isTTY }, stderr: { isTTY } }, argv);
  const motion = resolveTerminalMotion({ argv, env, caps: { ...caps, interactive: isTTY && !caps.ci && !caps.dumb } });
  const clean = (msg: string) => sanitizeText(msg, { ascii: !caps.unicode });

  if (motion.tempo === 'still' || repoArchaeologyNoMotion(env) || !isTTY) {
    setProgressHandler((msg: string) => {
      if (isTTY) stderr.write(`${clean(msg)}\n`);
    });
    return {
      update: () => {},
      stop: () => {
        setProgressHandler(undefined);
      },
    };
  }

  const frames = caps.unicode ? SPINNER_FRAMES_UNICODE : SPINNER_FRAMES_ASCII;
  let currentMessage = caps.unicode ? 'Reading git history…' : 'Reading git history...';
  let frameIndex = 0;
  let rendered = false;
  let stopped = false;
  let intervalTimer: ReturnType<typeof setInterval> | undefined;

  const renderFrame = () => {
    if (stopped) return;
    const frame = frames[frameIndex % frames.length]!;
    frameIndex++;
    rendered = true;
    try {
      stderr.write(`\r\u001b[K${frame} ${clean(currentMessage)}`);
    } catch {
      // Ignore a broken stderr pipe.
    }
  };

  const delayTimer = setTimeout(() => {
    if (stopped) return;
    renderFrame();
    intervalTimer = setInterval(renderFrame, POSE_MS);
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
    if (rendered) {
      try {
        stderr.write('\r\u001b[K');
      } catch {
        // Ignore a broken stderr pipe.
      }
    }
  };

  return { update, stop };
}
