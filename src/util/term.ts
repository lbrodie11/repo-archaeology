import { stdout } from 'node:process';

function colorEnabled(): boolean {
  if (process.argv.includes('--no-color') || 'NO_COLOR' in process.env) return false;
  if ('FORCE_COLOR' in process.env && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(stdout.isTTY) && process.env.TERM !== 'dumb';
}

const enabled = colorEnabled();
const wrap = (open: number, close: number) => (s: string | number) =>
  enabled ? `\u001b[${open}m${s}\u001b[${close}m` : String(s);

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

/**
 * Percentages are rounded down, so a value just under a threshold never prints
 * as the threshold itself (39.5% shows as 39%, not 40%).
 */
export function pct(value: number): string {
  return `${Math.floor(value * 100 + 1e-9)}%`;
}

export function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

export function isoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function timeAgo(unixSeconds: number, now = Date.now() / 1000): string {
  const days = Math.floor((now - unixSeconds) / 86400);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 45) return `${days} days ago`;
  const months = Math.round(days / 30.44);
  if (months < 18) return `${months} ${months === 1 ? 'month' : 'months'} ago`;
  const years = (days / 365.25).toFixed(1).replace(/\.0$/, '');
  return `${years} years ago`;
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? word : pluralWord}`;
}

/** Makes repository-controlled text inert when printed to a terminal. */
export function terminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Bidi_Control}/gu, (character) => {
    if (character === '\n') return '\\n';
    if (character === '\r') return '\\r';
    if (character === '\t') return '\\t';
    const code = character.codePointAt(0)!;
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

/** Progress messages go to stderr so stdout stays clean for --json and pipes. */
export function progress(message: string): void {
  if (process.stderr.isTTY) process.stderr.write(`${c.dim(message)}\n`);
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}
