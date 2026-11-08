/**
 * Commit origin classification (`human`, `agent`, `bot`), pattern configuration,
 * origin share calculation, and opt-in weighting helpers.
 *
 * The default pattern lists below are heuristics based on common agent and bot
 * identities and commit trailers. Users can extend or replace them via
 * `.repo-archaeology.json` (`origin`).
 */

export type CommitOrigin = 'human' | 'agent' | 'bot';

export const COMMIT_ORIGINS: readonly CommitOrigin[] = ['human', 'agent', 'bot'] as const;

export const MAX_ORIGIN_PATTERN_LENGTH = 200;

export interface CommitTrailer {
  key: string;
  value: string;
}

export interface OriginWeights {
  human?: number;
  agent?: number;
  bot?: number;
}

export interface OriginConfig {
  agentAuthorPatterns?: string[];
  botPatterns?: string[];
  agentTrailerPatterns?: string[];
  replaceDefaults?: boolean;
  weights?: OriginWeights;
}

export interface OriginCounts {
  human: number;
  agent: number;
  bot: number;
}

export interface OriginShare {
  human: number;
  agent: number;
  bot: number;
}

/**
 * Heuristic default patterns matched (case-insensitively) against author name
 * and email to identify coding-agent commits. Checked before bot patterns
 * because agent accounts frequently end in `[bot]`.
 *
 * Patterns are anchored to exact agent handles, `[bot]` accounts, or agent
 * noreply addresses so human names like "Claude Monet", "Jules Verne",
 * "Gemini Patel", "Codex Team", or "Argonaut" stay `human`.
 */
export const DEFAULT_AGENT_AUTHOR_PATTERNS: readonly string[] = [
  '^copilot-swe-agent(?:\\[bot\\])?$',
  '^devin-ai-integration(?:\\[bot\\])?$',
  '^cursor-agent(?:\\[bot\\])?$',
  '^(?:openai-)?codex(?:-agent)?\\[bot\\]$',
  '^(?:google-labs-)?jules\\[bot\\]$',
  '^claude(?:-code)?\\[bot\\]$',
  '^gemini(?:-code-assist)?\\[bot\\]$',
  '^argon(?:-agent)?\\[bot\\]$',
  '^(?:\\d+\\+)?(?:copilot-swe-agent|devin-ai-integration|cursor-agent|codex|openai-codex)\\[bot\\]@users\\.noreply\\.github\\.com$',
  '^(?:\\d+\\+)?(?:jules|google-labs-jules|claude|gemini|gemini-code-assist|argon)\\[bot\\]@users\\.noreply\\.github\\.com$',
  '^noreply@anthropic\\.com$',
  '^(?:amp|noreply)@ampcode\\.com$',
];

/**
 * Heuristic default patterns matched (case-insensitively) against author name
 * and email to identify automated bot commits (dependency updaters, release bots, CI).
 */
export const DEFAULT_BOT_PATTERNS: readonly string[] = [
  '\\[bot\\]$',
  '\\[bot\\]@users\\.noreply\\.github\\.com$',
  '^dependabot(?:\\[bot\\])?$',
  '^(?:renovate(?:\\[bot\\]| bot)?|bot@renovateapp\\.com)$',
  '^github-actions(?:\\[bot\\])?$',
  '^snyk-bot(?:\\[bot\\])?$',
  '^greenkeeper(?:\\[bot\\])?$',
  '^semantic-release-bot(?:\\[bot\\])?$',
  '^allcontributors(?:\\[bot\\])?$',
  '^pre-commit-ci(?:\\[bot\\])?$',
  '^mergify(?:\\[bot\\])?$',
  '^imgbot(?:\\[bot\\])?$',
];

/**
 * Lower-cased trailer keys inspected for coding-agent attribution in step 3.
 */
export const AGENT_TRAILER_KEYS: readonly string[] = [
  'co-authored-by',
  'assisted-by',
  'generated-by',
  'ai-assisted',
];

const AGENT_TRAILER_KEY_SET = new Set<string>(AGENT_TRAILER_KEYS);

/**
 * Heuristic default patterns matched (case-insensitively) against values of
 * `Co-authored-by`, `Assisted-by`, `Generated-by`, and `AI-Assisted` trailers.
 *
 * Uses bounded agent noreply emails and exact agent identities rather than
 * unanchored substrings so ordinary humans ("Bob <bob@example.com>",
 * "Pam Campbell", "Sam Ampofo", "Jean-Claude Van", "Devin Smith", or human
 * `@openai.com` addresses) are never misclassified as agents.
 */
export const DEFAULT_AGENT_TRAILER_PATTERNS: readonly string[] = [
  '(?:^|<)noreply@anthropic\\.com(?:>|$)',
  '(?:^|<)(?:amp|noreply)@ampcode\\.com(?:>|$)',
  '(?:^|<)(?:cursoragent|noreply)@cursor\\.com(?:>|$)',
  '(?:^|<)(?:devin|noreply)@cognition\\.ai(?:>|$)',
  '(?:^|<)(?:aider|noreply)@aider\\.chat(?:>|$)',
  '(?:^|<)(?:codex|noreply)@openai\\.com(?:>|$)',
  '(?:^|<)copilot@github\\.com(?:>|$)',
  '(?:^|<)(?:\\d+\\+)?(?:copilot|copilot-swe-agent|devin-ai-integration|cursor-agent|codex|openai-codex)(?:\\[bot\\])?@users\\.noreply\\.github\\.com(?:>|$)',
  '(?:^|<)(?:\\d+\\+)?(?:jules|google-labs-jules|claude|gemini|gemini-code-assist|argon)(?:\\[bot\\])?@users\\.noreply\\.github\\.com(?:>|$)',
  '^(?:github )?copilot(?:\\[bot\\])?(?: <[^<>]+>)?$',
  '^(?:copilot-swe-agent|devin-ai-integration|cursor-agent)(?:\\[bot\\])?(?: <[^<>]+>)?$',
  '^(?:claude code|openai codex|cursor agent|gemini code assist)(?: <[^<>]+>)?$',
  '^(?:amp|aider|windsurf|cline|argon)(?:\\[bot\\])?$',
];

export interface CommitIdentityInput {
  authorName?: string;
  authorEmail?: string;
  trailers?: readonly CommitTrailer[];
}

export type OriginClassifier = (commit: CommitIdentityInput) => CommitOrigin;

/**
 * Rejects regular expressions that could backtrack catastrophically or exceed length bounds:
 * - longer than `MAX_ORIGIN_PATTERN_LENGTH` (200 chars)
 * - backreferences (`\1`..`\9`, `\k<...>`)
 * - a quantified group containing a quantifier (`*`, `+`, `?`, `{n,m}`) or alternation (`|`),
 *   such as `(a+)+`, `(a?a?)+`, `((?:a)?)+`, or `(a|aa)*`
 * - more than 6 repetition quantifiers (`*`, `+`, `?`, `{n,m}`)
 */
export function riskySkipPattern(pattern: string): string | undefined {
  if (pattern.length > MAX_ORIGIN_PATTERN_LENGTH) return `is longer than ${MAX_ORIGIN_PATTERN_LENGTH} characters`;
  if (/\\(?:[1-9]|k<)/.test(pattern)) return 'uses a backreference';
  // Mask escaped character pairs (`\.`), character classes (`[...]`), and non-capturing / named
  // group headers (`(?:`, `(?i:`, `(?<name>`) to equal-length placeholders so every remaining
  // `(`, `)`, `*`, `+`, `?`, `|`, `{` is an unescaped syntax token outside character classes.
  const clean = pattern.replace(/\\./g, 'xx');
  const masked = clean.replace(/\[[^\]]*\]/g, (m) => 'x'.repeat(m.length));
  const normalized = masked.replace(
    /\(\?(?:<[^>()!]+>|[a-zA-Z-]*:)/g,
    (m) => '(' + 'x'.repeat(m.length - 1),
  );
  let quantifierCount = 0;
  const stack: number[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '*' || ch === '+' || ch === '{') {
      quantifierCount++;
    } else if (
      ch === '?' &&
      normalized[i - 1] !== '(' &&
      normalized[i - 1] !== '*' &&
      normalized[i - 1] !== '+' &&
      normalized[i - 1] !== '?' &&
      normalized[i - 1] !== '}'
    ) {
      quantifierCount++;
    }
    if (ch === '(') {
      stack.push(i);
    } else if (ch === ')' && stack.length > 0) {
      const start = stack.pop()!;
      const quantified = /^(?:[*+]|\{\d*,?\d*\})/.test(normalized.slice(i + 1));
      if (quantified && /(?:[*+?|]|\{\d*,?\d*\})/.test(normalized.slice(start + 1, i))) {
        return 'repeats a group that contains a quantifier or alternation, which can hang on some commit messages';
      }
    }
  }
  if (quantifierCount > 6) {
    return 'has too many repetition quantifiers (*, +, ?, {n,m})';
  }
  return undefined;
}

export const riskyOriginPattern = riskySkipPattern;

function compilePatternList(patterns: readonly string[]): RegExp[] {
  return patterns.map((p) => {
    const problem = riskyOriginPattern(p);
    if (problem) {
      throw new Error(`Unsafe origin pattern "${p}": ${problem}.`);
    }
    return new RegExp(p, 'i');
  });
}

function resolvePatternStrings(
  defaults: readonly string[],
  custom: readonly string[] | undefined,
  replaceDefaults?: boolean,
): readonly string[] {
  if (replaceDefaults) {
    return custom ?? [];
  }
  if (!custom || custom.length === 0) {
    return defaults;
  }
  return [...defaults, ...custom];
}

/**
 * Compiles an `OriginClassifier` for a repository configuration.
 *
 * Classification order (first match wins):
 * 1. `agent` if author name or email matches an agent-author pattern.
 * 2. `bot` if author name or email matches a bot pattern.
 * 3. `agent` if any `Co-authored-by` / `Assisted-by` / `Generated-by` / `AI-Assisted`
 *    trailer value matches an agent-trailer pattern.
 * 4. `human` otherwise.
 */
export function createOriginClassifier(config?: OriginConfig): OriginClassifier {
  const replace = config?.replaceDefaults === true;
  const agentAuthorRegexes = compilePatternList(
    resolvePatternStrings(DEFAULT_AGENT_AUTHOR_PATTERNS, config?.agentAuthorPatterns, replace),
  );
  const botRegexes = compilePatternList(
    resolvePatternStrings(DEFAULT_BOT_PATTERNS, config?.botPatterns, replace),
  );
  const agentTrailerRegexes = compilePatternList(
    resolvePatternStrings(DEFAULT_AGENT_TRAILER_PATTERNS, config?.agentTrailerPatterns, replace),
  );

  return (commit: CommitIdentityInput): CommitOrigin => {
    const name = (commit.authorName ?? '').trim();
    const email = (commit.authorEmail ?? '').trim();
    const strippedEmail = email.replace(/^\d+\+/, '');
    const authorCandidates = [name, email, ...(strippedEmail !== email ? [strippedEmail] : [])].filter(
      (s) => s.length > 0,
    );

    for (const re of agentAuthorRegexes) {
      if (authorCandidates.some((candidate) => re.test(candidate))) {
        return 'agent';
      }
    }

    for (const re of botRegexes) {
      if (authorCandidates.some((candidate) => re.test(candidate))) {
        return 'bot';
      }
    }

    const trailers = commit.trailers;
    if (trailers && trailers.length > 0 && agentTrailerRegexes.length > 0) {
      for (const trailer of trailers) {
        const key = trailer.key.trim().toLowerCase();
        if (!AGENT_TRAILER_KEY_SET.has(key)) continue;
        const value = trailer.value;
        for (const re of agentTrailerRegexes) {
          if (re.test(value)) {
            return 'agent';
          }
        }
      }
    }

    return 'human';
  };
}

const defaultClassifier = createOriginClassifier();
const classifierCache = new WeakMap<OriginConfig, OriginClassifier>();

/** Classifies a commit's origin using default or custom `OriginConfig` patterns (cached per config object). */
export function classifyCommitOrigin(commit: CommitIdentityInput, config?: OriginConfig): CommitOrigin {
  if (!config) return defaultClassifier(commit);
  let classifier = classifierCache.get(config);
  if (!classifier) {
    classifier = createOriginClassifier(config);
    classifierCache.set(config, classifier);
  }
  return classifier(commit);
}

/**
 * Converts raw `{ human, agent, bot }` commit counts into 3-decimal fractions
 * guaranteed to sum to 1 (when total > 0) using the Largest Remainder Method.
 */
export function computeOriginShare(counts: OriginCounts): OriginShare {
  const total = counts.human + counts.agent + counts.bot;
  if (total <= 0) {
    return { human: 0, agent: 0, bot: 0 };
  }
  const keys: readonly CommitOrigin[] = ['human', 'agent', 'bot'];
  const raw = keys.map((k) => (counts[k] * 1000) / total);
  const floors = raw.map((v) => Math.floor(v));
  let remainderUnits = 1000 - (floors[0]! + floors[1]! + floors[2]!);
  if (remainderUnits > 0) {
    const order = [0, 1, 2].sort((a, b) => {
      const remDiff = (raw[b]! - floors[b]!) - (raw[a]! - floors[a]!);
      if (Math.abs(remDiff) > 1e-12) return remDiff;
      const countDiff = counts[keys[b]!] - counts[keys[a]!];
      if (countDiff !== 0) return countDiff;
      return a - b;
    });
    for (let i = 0; i < remainderUnits && i < order.length; i++) {
      floors[order[i]!]! += 1;
    }
  }
  return {
    human: floors[0]! / 1000,
    agent: floors[1]! / 1000,
    bot: floors[2]! / 1000,
  };
}

/** Resolves optional origin weights to `{ human, agent, bot }`, defaulting each to 1. */
export function resolveOriginWeights(weights?: OriginWeights): Required<OriginWeights> {
  return {
    human: weights?.human ?? 1,
    agent: weights?.agent ?? 1,
    bot: weights?.bot ?? 1,
  };
}

/** True when any origin weight is explicitly set to a value other than 1. */
export function hasNonDefaultOriginWeights(weights?: OriginWeights): boolean {
  if (!weights) return false;
  return (
    (weights.human !== undefined && weights.human !== 1)
    || (weights.agent !== undefined && weights.agent !== 1)
    || (weights.bot !== undefined && weights.bot !== 1)
  );
}

/**
 * Parses a CLI origin-weights specification such as `bot=0,agent=0.5`.
 * Throws an Error with a clear message if invalid.
 */
export function parseOriginWeightsSpec(spec: string, source = '--origin-weights'): OriginWeights {
  const trimmed = spec.trim();
  if (trimmed === '') {
    throw new Error(`${source}: expected key=value pairs such as "bot=0,agent=0.5".`);
  }
  const out: OriginWeights = {};
  const parts = trimmed.split(',');
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (part === '') {
      throw new Error(`${source}: empty entry in "${spec}".`);
    }
    const eq = part.indexOf('=');
    if (eq <= 0 || part.indexOf('=', eq + 1) !== -1) {
      throw new Error(`${source}: invalid entry "${part}" (expected <human|agent|bot>=<0..1>).`);
    }
    const key = part.slice(0, eq).trim().toLowerCase();
    const valStr = part.slice(eq + 1).trim();
    if (key !== 'human' && key !== 'agent' && key !== 'bot') {
      throw new Error(`${source}: unknown origin "${key}" (expected human, agent, or bot).`);
    }
    const value = Number(valStr);
    if (valStr === '' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`${source}: weight for "${key}" must be a number between 0 and 1.`);
    }
    out[key] = value;
  }
  return out;
}

/** Formats an `OriginWeights` object back into a compact spec string (e.g. `bot=0,agent=0.5`). */
export function formatOriginWeightsSpec(weights: OriginWeights): string {
  const parts: string[] = [];
  for (const key of ['human', 'agent', 'bot'] as const) {
    const val = weights[key];
    if (val !== undefined) {
      parts.push(`${key}=${val}`);
    }
  }
  return parts.join(',') || 'human=1,agent=1,bot=1';
}
