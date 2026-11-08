import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRegularTreeMode, parseLsTree, type TreeFileSet } from '../git/repo.js';
import { runGit } from '../git/run.js';
import { isoDate } from '../util/term.js';
import type { History, HistoryCommit } from './history.js';
import { isHumanAuthorIdentity, type OriginConfig } from './origin.js';

export const MAILMAP_FILE = '.mailmap';
export const MAX_MAILMAP_BYTES = 256 * 1024;

export const CODEOWNERS_CANDIDATE_PATHS = [
  '.github/CODEOWNERS',
  'CODEOWNERS',
  'docs/CODEOWNERS',
] as const;

/** GitHub does not load CODEOWNERS files of 3 MB or more. */
export const MAX_CODEOWNERS_BYTES = 3 * 1024 * 1024;
export const MAX_CODEOWNERS_RULES = 5000;
export const MAX_CODEOWNERS_WARNINGS = 5;

export const MAX_OWNERS_PER_SUGGESTION = 5;
export const MAX_OWNERS_LOOKBACK_DAYS = 3650;
export const MAX_OWNERS_COMMITS = 1000;

export interface OwnersConfig {
  /** Whether contributor context and CODEOWNERS enrichment is enabled on `diff` suggestions (default: false). */
  enabled?: boolean;
  /** Maximum number of recent contributors to return per suggestion (1..5, default: 3). */
  max?: number;
  /** Lookback window in days relative to the analyzed reference commit (1..3650, default: 365). */
  lookbackDays?: number;
  /** Maximum qualifying recent commits touching a file to inspect (1..1000, default: 100). */
  maxCommits?: number;
}

export const DEFAULT_OWNERS_CONFIG: Readonly<Required<OwnersConfig>> = Object.freeze({
  enabled: false,
  max: 3,
  lookbackDays: 365,
  maxCommits: 100,
});

export function resolveOwnersConfig(config?: OwnersConfig): Required<OwnersConfig> {
  return {
    enabled: config?.enabled ?? DEFAULT_OWNERS_CONFIG.enabled,
    max: config?.max ?? DEFAULT_OWNERS_CONFIG.max,
    lookbackDays: config?.lookbackDays ?? DEFAULT_OWNERS_CONFIG.lookbackDays,
    maxCommits: config?.maxCommits ?? DEFAULT_OWNERS_CONFIG.maxCommits,
  };
}

export interface SuggestionOwner {
  /** Display name of a historically active contributor (never an email address). */
  name: string;
  /** Historically inferred GitHub username from a `users.noreply.github.com` address, when unambiguous. */
  login?: string;
  /** Number of qualifying recent human-authored commits touching `to` within the analyzed window. */
  commits: number;
  /** UTC date (`YYYY-MM-DD`) of the contributor's most recent qualifying commit touching `to`. */
  lastDate: string;
}

export type CodeownersProvenance = 'base' | 'head' | 'worktree';

export interface SuggestionOwnersSample {
  /** Total qualifying recent human-authored commits touching `to` in the analyzed window (denominator of `owners[].commits`). */
  qualifyingCommits: number;
  /** Configured lookback window in days relative to the analyzed reference commit. */
  lookbackDays: number;
  /** Maximum qualifying recent commits inspected per file (`owners.maxCommits`). */
  maxCommits: number;
  /** Start of the analyzed lookback window (`YYYY-MM-DD`, UTC). */
  fromDate: string;
  /** End of the analyzed lookback window (`YYYY-MM-DD`, UTC, from the reference commit's committer timestamp). */
  toDate: string;
  /** Number of qualifying commits that carried coding-agent assistance trailers (`origin === "agent"` with a human author). */
  agentAssistedCommits: number;
  /** Number of recent commits touching `to` within the window that were excluded as bot- or non-human agent-authored. */
  excludedNonHumanCommits: number;
  /** True when repository history is incomplete (shallow clone, truncated by `--max-commits` or `--since`, or file sample capped at `owners.maxCommits`). */
  incompleteCoverage: boolean;
  /** Provenance of `codeowners` when CODEOWNERS was evaluated (`"base"`, `"head"`, or `"worktree"`). */
  codeownersSource?: CodeownersProvenance;
  /** Relative path of the CODEOWNERS file that was used, when present. */
  codeownersFile?: string;
}

export interface ResolvedIdentity {
  name: string;
  email: string;
}

interface MailmapTarget {
  properName?: string;
  properEmail?: string;
}

/**
 * Deterministic `gitmailmap(5)` resolver for a specific repository state.
 *
 * Supports all four standard `.mailmap` forms:
 * 1. `Proper Name <commit@email.xx>`
 * 2. `<proper@email.xx> <commit@email.xx>`
 * 3. `Proper Name <proper@email.xx> <commit@email.xx>`
 * 4. `Proper Name <proper@email.xx> Commit Name <commit@email.xx>`
 */
export class Mailmap {
  private readonly byEmail = new Map<string, MailmapTarget>();
  private readonly byNameAndEmail = new Map<string, MailmapTarget>();

  constructor(
    byEmail?: ReadonlyMap<string, MailmapTarget>,
    byNameAndEmail?: ReadonlyMap<string, MailmapTarget>,
  ) {
    if (byEmail) {
      for (const [k, v] of byEmail) this.byEmail.set(k, v);
    }
    if (byNameAndEmail) {
      for (const [k, v] of byNameAndEmail) this.byNameAndEmail.set(k, v);
    }
  }

  get isEmpty(): boolean {
    return this.byEmail.size === 0 && this.byNameAndEmail.size === 0;
  }

  resolve(name: string, email: string): ResolvedIdentity {
    const rawName = name.trim();
    const rawEmail = email.trim();
    const emailKey = rawEmail.toLowerCase();
    const nameKey = rawName.toLowerCase();
    if (emailKey !== '') {
      const specific = this.byNameAndEmail.get(`${emailKey}\u0000${nameKey}`);
      if (specific) {
        return {
          name: specific.properName ?? rawName,
          email: (specific.properEmail ?? rawEmail).toLowerCase(),
        };
      }
      const byEmailOnly = this.byEmail.get(emailKey);
      if (byEmailOnly) {
        return {
          name: byEmailOnly.properName ?? rawName,
          email: (byEmailOnly.properEmail ?? rawEmail).toLowerCase(),
        };
      }
    }
    return {
      name: rawName,
      email: emailKey,
    };
  }
}

export const EMPTY_MAILMAP = new Mailmap();

/** Parses `.mailmap` text according to `gitmailmap(5)`. */
export function parseMailmap(content: string): Mailmap {
  const byEmail = new Map<string, MailmapTarget>();
  const byNameAndEmail = new Map<string, MailmapTarget>();

  for (const rawLine of content.split(/\r?\n/)) {
    const hashIdx = rawLine.indexOf('#');
    const line = (hashIdx >= 0 ? rawLine.slice(0, hashIdx) : rawLine).trim();
    if (line === '') continue;

    // Extract angle-bracketed emails in order: `prefix1 <email1> prefix2 <email2>`
    const anglePattern = /([^<>]*?)<([^<>]+)>/g;
    const parts: { textBefore: string; email: string }[] = [];
    let match: RegExpExecArray | null;
    while ((match = anglePattern.exec(line)) !== null) {
      parts.push({
        textBefore: (match[1] ?? '').trim(),
        email: (match[2] ?? '').trim().toLowerCase(),
      });
      if (parts.length >= 2) break;
    }

    if (parts.length === 1) {
      // Form 1: `Proper Name <commit@email.xx>`
      const first = parts[0]!;
      if (first.email !== '' && first.textBefore !== '') {
        const prev = byEmail.get(first.email);
        byEmail.set(first.email, {
          properName: first.textBefore,
          properEmail: prev?.properEmail,
        });
      }
    } else if (parts.length === 2) {
      const first = parts[0]!;
      const second = parts[1]!;
      if (first.email === '' || second.email === '') continue;
      const target: MailmapTarget = {
        ...(first.textBefore !== '' ? { properName: first.textBefore } : {}),
        properEmail: first.email,
      };
      if (second.textBefore !== '') {
        // Form 4: `Proper Name <proper@email.xx> Commit Name <commit@email.xx>`
        byNameAndEmail.set(`${second.email}\u0000${second.textBefore.toLowerCase()}`, target);
      } else {
        // Form 2 (`<proper@email.xx> <commit@email.xx>`) or Form 3 (`Proper Name <proper@email.xx> <commit@email.xx>`)
        const prev = byEmail.get(second.email);
        byEmail.set(second.email, {
          properName: target.properName ?? prev?.properName,
          properEmail: target.properEmail,
        });
      }
    }
  }

  return new Mailmap(byEmail, byNameAndEmail);
}

/** Reads `.mailmap` from the working tree root if it is a regular file within size bounds. */
export function loadWorkingTreeMailmap(root: string): Mailmap {
  const file = join(root, MAILMAP_FILE);
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.size > MAX_MAILMAP_BYTES) {
    return EMPTY_MAILMAP;
  }
  try {
    return parseMailmap(readFileSync(file, 'utf8'));
  } catch {
    return EMPTY_MAILMAP;
  }
}

/** Reads `.mailmap` from a specific Git commit tree (`<commitSha>:.mailmap`) without touching the working tree. */
export async function loadCommitTreeMailmap(
  root: string,
  commitSha: string,
  treeFiles?: TreeFileSet,
  signal?: AbortSignal,
): Promise<Mailmap> {
  try {
    const files =
      treeFiles ??
      parseLsTree(
        await runGit(root, ['ls-tree', '-z', '--end-of-options', commitSha, '--', MAILMAP_FILE], { signal }),
      );
    const mode = files.modes.get(MAILMAP_FILE);
    if (mode === undefined || !isRegularTreeMode(mode)) {
      return EMPTY_MAILMAP;
    }
    const spec = `${commitSha}:${MAILMAP_FILE}`;
    const sizeOut = (await runGit(root, ['cat-file', '-s', '--end-of-options', spec], { signal })).trim();
    if (Number(sizeOut) > MAX_MAILMAP_BYTES) {
      return EMPTY_MAILMAP;
    }
    const content = await runGit(root, ['cat-file', 'blob', '--end-of-options', spec], { signal });
    return parseMailmap(content);
  } catch {
    return EMPTY_MAILMAP;
  }
}

const CONTROL_AND_BIDI_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200B-\u200F\uFEFF]|\p{Bidi_Control}/gu;
const TRAILING_ANGLE_EMAIL_RE = /^([^<>]+?)\s*<[^<>@\s]+@[^<>@\s]+>\s*$/;
const EMAIL_LIKE_RE = /[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+|^[^\s<>@]+@[^\s<>@]+$/;
const SCRIPT_BLOCK_RE = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const HTML_TAG_RE = /<[^>]*>/g;

/**
 * Validates and sanitizes an untrusted Git author name for ownership output:
 * - Rejects names that are or contain an email address (`undefined`)
 * - Strips HTML tags, angle brackets, control/bidi chars, and `@` mention prefixes
 * - Clamps to 120 characters
 */
export function sanitizeContributorName(rawName: string | undefined): string | undefined {
  if (!rawName) return undefined;
  let cleaned = rawName.replace(CONTROL_AND_BIDI_RE, ' ').trim();
  if (cleaned === '') return undefined;

  const angleMatch = TRAILING_ANGLE_EMAIL_RE.exec(cleaned);
  if (angleMatch) {
    cleaned = angleMatch[1]!.trim();
  }

  // Reject any author name that is or contains an email address.
  if (EMAIL_LIKE_RE.test(cleaned)) {
    return undefined;
  }

  // Remove script blocks, HTML tags, stray angle brackets, and `@` characters (preventing @mentions and emails).
  cleaned = cleaned
    .replace(SCRIPT_BLOCK_RE, ' ')
    .replace(HTML_TAG_RE, ' ')
    .replace(/[<>@]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned === '' || EMAIL_LIKE_RE.test(cleaned)) {
    return undefined;
  }

  if (cleaned.length > 120) {
    cleaned = `${cleaned.slice(0, 119).trimEnd()}…`;
  }
  return cleaned;
}

const NOREPLY_EMAIL_RE =
  /^(?:(\d+)\+)?([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})@users\.noreply\.github\.com$/i;

const RESERVED_OR_BOT_LOGINS = new Set([
  'noreply',
  'ghost',
  'web-flow',
  'github-actions',
  'dependabot',
  'renovate',
  'copilot',
  'copilot-swe-agent',
  'devin-ai-integration',
  'cursor-agent',
  'claude',
  'claude-code',
  'gemini',
  'gemini-code-assist',
  'jules',
  'google-labs-jules',
  'codex',
  'openai-codex',
  'snyk-bot',
  'greenkeeper',
  'semantic-release-bot',
  'allcontributors',
  'pre-commit-ci',
  'mergify',
  'imgbot',
  'argon',
  'argon-agent',
]);

/**
 * Infers a historical GitHub username strictly from GitHub's documented noreply formats:
 * - `ID+USERNAME@users.noreply.github.com`
 * - `USERNAME@users.noreply.github.com`
 *
 * Rejects malformed, bot-like, reserved, or non-human usernames.
 */
export function inferGitHubLoginFromEmail(
  email: string | undefined,
  originConfig?: OriginConfig,
): string | undefined {
  if (!email) return undefined;
  const trimmed = email.trim();
  const match = NOREPLY_EMAIL_RE.exec(trimmed);
  if (!match) return undefined;
  const login = match[2]!;
  const lower = login.toLowerCase();
  if (RESERVED_OR_BOT_LOGINS.has(lower) || lower.endsWith('-bot')) {
    return undefined;
  }
  if (!isHumanAuthorIdentity({ authorName: login, authorEmail: trimmed.toLowerCase() }, originConfig)) {
    return undefined;
  }
  return login;
}

const GITHUB_USER_HANDLE_RE = /^@[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const GITHUB_TEAM_HANDLE_RE =
  /^@[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;

export function isValidCodeownerHandle(token: string): boolean {
  if (token.length > 140) return false;
  return GITHUB_USER_HANDLE_RE.test(token) || GITHUB_TEAM_HANDLE_RE.test(token);
}

/**
 * Formats a `@user` or `@org/team` handle with a zero-width space after `@` so rendered
 * Markdown or terminal text copied into a pull-request comment never triggers GitHub notifications.
 */
export function renderNonMentioningHandle(handle: string): string {
  const clean = handle.startsWith('@') ? handle.slice(1) : handle;
  return `@\u200B${clean}`;
}

interface CodeownersRule {
  pattern: string;
  regex: RegExp;
  owners: string[];
  /** True when the rule explicitly had 0 owner tokens on the line (clearing prior rules). */
  unownedRule: boolean;
  /** True when the rule had only email owners that were skipped for privacy. */
  emailOnlyRule: boolean;
}

export interface LoadedCodeowners {
  file?: string;
  source: CodeownersProvenance;
  rules: CodeownersRule[];
  warnings: string[];
}

/**
 * Compiles a supported GitHub CODEOWNERS pattern into a case-sensitive `RegExp`.
 * Returns `{ error }` when the pattern uses unsupported syntax (`!`, `[...]`, `{...}`).
 */
export function compileCodeownersPattern(pattern: string): { regex?: RegExp; error?: string } {
  if (pattern === '' || pattern.length > 500 || CONTROL_AND_BIDI_RE.test(pattern)) {
    return { error: 'malformed pattern' };
  }
  if (pattern.startsWith('!')) {
    return { error: 'negation patterns starting with "!" are not supported in CODEOWNERS' };
  }
  // Check for unescaped `[` or `]` or `{` or `}`
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '[' || ch === ']') {
      return { error: 'character ranges "[...]" are not supported in CODEOWNERS' };
    }
    if (ch === '{' || ch === '}') {
      return { error: 'brace expansion "{...}" is not supported in CODEOWNERS' };
    }
  }

  if (pattern === '*') {
    return { regex: /^.+$/ };
  }

  let p = pattern;
  const leadingSlash = p.startsWith('/');
  if (leadingSlash) p = p.slice(1);
  const trailingSlash = p.endsWith('/') && !p.endsWith('\\/');
  if (trailingSlash) p = p.replace(/\/+$/, '');
  if (p === '') {
    return { regex: /^.+$/ };
  }

  const hasInternalSlash = p.includes('/');
  const anchoredToRoot = leadingSlash || hasInternalSlash;

  let hasWildcard = false;
  let body = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === '\\' && i + 1 < p.length) {
      const next = p[++i]!;
      body += next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      continue;
    }
    if (ch === '*') {
      hasWildcard = true;
      if (p[i + 1] === '*') {
        while (p[i + 1] === '*') i++;
        if (p[i + 1] === '/') {
          i++;
          body += '(?:.+/)?';
        } else {
          body += '.*';
        }
      } else {
        body += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      hasWildcard = true;
      body += '[^/]';
      continue;
    }
    body += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  const prefix = anchoredToRoot ? '^' : '^(?:.+/)?';
  let suffix: string;
  if (trailingSlash) {
    suffix = '/.+$';
  } else if (!hasWildcard) {
    // In GitHub CODEOWNERS, a literal path without wildcards or trailing slash matches
    // either the exact file or any file inside a directory of that name.
    suffix = '(?:/.+)?$';
  } else {
    suffix = '$';
  }

  try {
    return { regex: new RegExp(`${prefix}${body}${suffix}`) };
  } catch {
    return { error: 'invalid pattern syntax' };
  }
}

/** Splits a CODEOWNERS line (after comment stripping) into tokens while respecting `\ ` escaped spaces. */
function tokenizeCodeownersLine(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '#') {
      // Unescaped `#` starts an inline comment when at start of token
      if (current === '') break;
    }
    if (ch === '\\' && i + 1 < line.length && line[i + 1] === ' ') {
      current += '\\ ';
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current !== '') tokens.push(current);
  return tokens;
}

export function parseCodeownersText(
  content: string,
  filePath: string,
  source: CodeownersProvenance,
): LoadedCodeowners {
  const rules: CodeownersRule[] = [];
  const warnings: string[] = [];
  const addWarning = (msg: string) => {
    if (warnings.length < MAX_CODEOWNERS_WARNINGS && !warnings.includes(msg)) {
      warnings.push(msg);
    }
  };

  const lines = content.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx]!.trim();
    if (rawLine === '' || rawLine.startsWith('#')) continue;

    const tokens = tokenizeCodeownersLine(rawLine);
    if (tokens.length === 0) continue;

    const [patternToken, ...ownerTokens] = tokens;
    const compiled = compileCodeownersPattern(patternToken!);
    if (!compiled.regex) {
      addWarning(
        `${filePath} line ${idx + 1}: unsupported pattern "${ sanitizeContributorName(patternToken) ?? 'pattern' }" ignored (${compiled.error ?? 'unsupported syntax'}).`,
      );
      continue;
    }

    if (rules.length >= MAX_CODEOWNERS_RULES) {
      addWarning(`${filePath}: truncated after ${MAX_CODEOWNERS_RULES} rules.`);
      break;
    }

    if (ownerTokens.length === 0) {
      rules.push({
        pattern: patternToken!,
        regex: compiled.regex,
        owners: [],
        unownedRule: true,
        emailOnlyRule: false,
      });
      continue;
    }

    const validHandles: string[] = [];
    let skippedEmailCount = 0;
    for (const token of ownerTokens) {
      if (isValidCodeownerHandle(token)) {
        if (!validHandles.includes(token)) {
          validHandles.push(token);
        }
      } else if (EMAIL_LIKE_RE.test(token)) {
        // Skip email-based CODEOWNERS entries without exposing their address.
        skippedEmailCount++;
      } else {
        addWarning(`${filePath} line ${idx + 1}: ignored malformed owner entry (expected @user or @org/team).`);
      }
    }

    if (validHandles.length > 0 || skippedEmailCount > 0) {
      rules.push({
        pattern: patternToken!,
        regex: compiled.regex,
        owners: validHandles,
        unownedRule: false,
        emailOnlyRule: validHandles.length === 0 && skippedEmailCount > 0,
      });
    }
  }

  return { file: filePath, source, rules, warnings };
}

export class CodeownersMatcher {
  constructor(readonly loaded: LoadedCodeowners) {}

  get hasFile(): boolean {
    return this.loaded.file !== undefined;
  }

  get file(): string | undefined {
    return this.loaded.file;
  }

  get source(): CodeownersProvenance {
    return this.loaded.source;
  }

  /**
   * Returns the designated `@user` / `@org/team` handles for `repoPath` using
   * case-sensitive matching and last-valid-match precedence.
   */
  match(repoPath: string): string[] {
    let matched: string[] = [];
    for (const rule of this.loaded.rules) {
      if (rule.regex.test(repoPath)) {
        if (rule.unownedRule || rule.emailOnlyRule) {
          matched = [];
        } else {
          matched = [...rule.owners];
        }
      }
    }
    return matched;
  }
}

export function loadWorkingTreeCodeowners(root: string): CodeownersMatcher {
  for (const relPath of CODEOWNERS_CANDIDATE_PATHS) {
    const full = join(root, relPath);
    const stat = lstatSync(full, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isFile()) {
      return new CodeownersMatcher({
        source: 'worktree',
        rules: [],
        warnings: [`Skipping ${relPath}: not a regular file.`],
      });
    }
    if (stat.size >= MAX_CODEOWNERS_BYTES) {
      return new CodeownersMatcher({
        source: 'worktree',
        rules: [],
        warnings: [`Skipping ${relPath}: file is 3 MB or larger.`],
      });
    }
    const content = readFileSync(full, 'utf8');
    return new CodeownersMatcher(parseCodeownersText(content, relPath, 'worktree'));
  }
  return new CodeownersMatcher({ source: 'worktree', rules: [], warnings: [] });
}

export async function loadCommitTreeCodeowners(
  root: string,
  commitSha: string,
  source: 'base' | 'head',
  treeFiles?: TreeFileSet,
  signal?: AbortSignal,
): Promise<CodeownersMatcher> {
  const files =
    treeFiles ??
    parseLsTree(
      await runGit(
        root,
        ['ls-tree', '-z', '--end-of-options', commitSha, '--', ...CODEOWNERS_CANDIDATE_PATHS],
        { signal },
      ),
    );

  for (const relPath of CODEOWNERS_CANDIDATE_PATHS) {
    const mode = files.modes.get(relPath);
    if (mode === undefined) continue;
    if (!isRegularTreeMode(mode)) {
      return new CodeownersMatcher({
        source,
        rules: [],
        warnings: [`Skipping ${relPath} at ${source}: not a regular file.`],
      });
    }
    const spec = `${commitSha}:${relPath}`;
    const sizeOut = (await runGit(root, ['cat-file', '-s', '--end-of-options', spec], { signal })).trim();
    if (Number(sizeOut) >= MAX_CODEOWNERS_BYTES) {
      return new CodeownersMatcher({
        source,
        rules: [],
        warnings: [`Skipping ${relPath} at ${source}: file is 3 MB or larger.`],
      });
    }
    const content = await runGit(root, ['cat-file', 'blob', '--end-of-options', spec], { signal });
    return new CodeownersMatcher(parseCodeownersText(content, relPath, source));
  }

  return new CodeownersMatcher({ source, rules: [], warnings: [] });
}

export interface ComputeFileOwnersOptions {
  history: History;
  ownersConfig: Required<OwnersConfig>;
  originConfig?: OriginConfig;
  shallow?: boolean;
  codeowners?: CodeownersMatcher;
}

export interface FileOwnershipEnrichment {
  owners: SuggestionOwner[];
  ownersSample: SuggestionOwnersSample;
  codeowners?: string[];
}

/**
 * Computes recent human contributor context and optional CODEOWNERS handles for a target file path.
 */
export function computeFileOwnership(
  targetPath: string,
  options: ComputeFileOwnersOptions,
): FileOwnershipEnrichment {
  const { history, ownersConfig, originConfig, shallow, codeowners } = options;
  const referenceTime =
    history.stats.referenceCommitTime ??
    history.commits[0]?.commitTime ??
    history.stats.newestTime ??
    0;
  const lookbackSeconds = ownersConfig.lookbackDays * 86400;
  const cutoffTime = Math.max(0, referenceTime - lookbackSeconds);

  // Collect commits touching targetPath within [cutoffTime, referenceTime], ordered by committer time desc.
  const commitsInWindow: HistoryCommit[] = [];
  for (const commit of history.commits) {
    if (commit.commitTime > referenceTime || commit.commitTime < cutoffTime) continue;
    if (!commit.files.includes(targetPath)) continue;
    commitsInWindow.push(commit);
  }

  commitsInWindow.sort(
    (a, b) =>
      b.commitTime - a.commitTime ||
      (a.logOrder ?? 0) - (b.logOrder ?? 0) ||
      a.hash.localeCompare(b.hash),
  );

  let excludedNonHumanCommits = 0;
  const eligibleHumanCommits: {
    commit: HistoryCommit;
    key: string;
    displayName: string;
    canonicalEmail: string;
    rawEmail?: string;
  }[] = [];

  for (const commit of commitsInWindow) {
    if (commit.origin === 'bot' || commit.humanAuthor === false) {
      excludedNonHumanCommits++;
      continue;
    }
    const rawName = commit.rawAuthorName ?? commit.author;
    const rawEmail = commit.rawAuthorEmail ?? commit.authorEmail;
    const canonicalName = commit.canonicalAuthor ?? rawName;
    const canonicalEmail = (commit.canonicalEmail ?? rawEmail ?? '').trim().toLowerCase();

    // Double-check against origin patterns in case HistoryCommit was constructed directly in a unit test.
    if (
      !isHumanAuthorIdentity({ authorName: rawName, authorEmail: rawEmail }, originConfig) ||
      !isHumanAuthorIdentity({ authorName: canonicalName, authorEmail: canonicalEmail }, originConfig)
    ) {
      excludedNonHumanCommits++;
      continue;
    }

    // Require a non-empty canonical email so two distinct people with the same display name are never merged.
    if (canonicalEmail === '') {
      continue;
    }

    const displayName =
      sanitizeContributorName(canonicalName) ??
      sanitizeContributorName(rawName) ??
      inferGitHubLoginFromEmail(canonicalEmail, originConfig) ??
      inferGitHubLoginFromEmail(rawEmail, originConfig);
    if (!displayName) {
      continue;
    }

    eligibleHumanCommits.push({
      commit,
      key: `email:${canonicalEmail}`,
      displayName,
      canonicalEmail,
      rawEmail,
    });
  }

  const cappedByMaxCommits = eligibleHumanCommits.length > ownersConfig.maxCommits;
  const qualifyingSlice = eligibleHumanCommits.slice(0, ownersConfig.maxCommits);
  const qualifyingCommits = qualifyingSlice.length;

  let agentAssistedCommits = 0;
  const byContributor = new Map<
    string,
    {
      key: string;
      name: string;
      canonicalEmail: string;
      rawEmails: Set<string>;
      commits: number;
      lastCommitTime: number;
    }
  >();

  for (const item of qualifyingSlice) {
    if (item.commit.origin === 'agent') {
      agentAssistedCommits++;
    }
    let agg = byContributor.get(item.key);
    if (!agg) {
      agg = {
        key: item.key,
        name: item.displayName,
        canonicalEmail: item.canonicalEmail,
        rawEmails: new Set<string>(),
        commits: 0,
        lastCommitTime: item.commit.commitTime,
      };
      byContributor.set(item.key, agg);
    }
    agg.commits++;
    if (item.commit.commitTime > agg.lastCommitTime) {
      agg.lastCommitTime = item.commit.commitTime;
      agg.name = item.displayName;
    }
    if (item.rawEmail) {
      agg.rawEmails.add(item.rawEmail);
    }
  }

  // Infer GitHub noreply logins and guard against ambiguity within or across contributors.
  const ranked = [...byContributor.values()].map((agg) => {
    let login = inferGitHubLoginFromEmail(agg.canonicalEmail, originConfig);
    if (!login && agg.rawEmails.size > 0) {
      const candidateLogins = new Map<string, string>();
      for (const rawEmail of agg.rawEmails) {
        const inferred = inferGitHubLoginFromEmail(rawEmail, originConfig);
        if (inferred) {
          candidateLogins.set(inferred.toLowerCase(), inferred);
        }
      }
      if (candidateLogins.size === 1) {
        login = [...candidateLogins.values()][0];
      }
    }
    return {
      ...agg,
      login,
    };
  });

  // If two distinct contributors on this file share the same inferred login, treat it as ambiguous on both.
  const loginCounts = new Map<string, number>();
  for (const r of ranked) {
    if (r.login) {
      const lower = r.login.toLowerCase();
      loginCounts.set(lower, (loginCounts.get(lower) ?? 0) + 1);
    }
  }
  for (const r of ranked) {
    if (r.login && (loginCounts.get(r.login.toLowerCase()) ?? 0) > 1) {
      r.login = undefined;
    }
  }

  ranked.sort(
    (a, b) =>
      b.commits - a.commits ||
      b.lastCommitTime - a.lastCommitTime ||
      a.name.localeCompare(b.name) ||
      (a.login ?? '').localeCompare(b.login ?? '') ||
      a.key.localeCompare(b.key),
  );

  const owners: SuggestionOwner[] = ranked.slice(0, ownersConfig.max).map((r) => ({
    name: r.name,
    ...(r.login !== undefined ? { login: r.login } : {}),
    commits: r.commits,
    lastDate: isoDate(r.lastCommitTime),
  }));

  const incompleteCoverage =
    Boolean(shallow) ||
    history.stats.truncated === true ||
    history.stats.truncatedBySince === true ||
    cappedByMaxCommits;

  const matchedCodeowners = codeowners?.hasFile ? codeowners.match(targetPath) : undefined;

  const ownersSample: SuggestionOwnersSample = {
    qualifyingCommits,
    lookbackDays: ownersConfig.lookbackDays,
    maxCommits: ownersConfig.maxCommits,
    fromDate: isoDate(cutoffTime),
    toDate: isoDate(referenceTime),
    agentAssistedCommits,
    excludedNonHumanCommits,
    incompleteCoverage,
    ...(codeowners?.hasFile
      ? {
          codeownersSource: codeowners.source,
          codeownersFile: codeowners.file,
        }
      : {}),
  };

  return {
    owners,
    ownersSample,
    ...(matchedCodeowners && matchedCodeowners.length > 0 ? { codeowners: matchedCodeowners } : {}),
  };
}
