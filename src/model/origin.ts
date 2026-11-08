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
 */
export const DEFAULT_AGENT_AUTHOR_PATTERNS: readonly string[] = [
  '^copilot-swe-agent',
  '^devin-ai-integration',
  '^cursor-agent',
  '^codex',
  '^jules',
  '^claude',
  '^gemini',
  '^argon',
];

/**
 * Heuristic default patterns matched (case-insensitively) against author name
 * and email to identify automated bot commits (dependency updaters, release bots, CI).
 */
export const DEFAULT_BOT_PATTERNS: readonly string[] = [
  '\\[bot\\]$',
  '\\[bot\\]@users\\.noreply\\.github\\.com$',
  '^dependabot',
  '^renovate',
  '^github-actions',
  '^snyk-bot',
  '^greenkeeper',
  '^semantic-release-bot',
  '^allcontributors',
  '^pre-commit-ci',
  '^mergify',
  '^imgbot',
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
 */
export const DEFAULT_AGENT_TRAILER_PATTERNS: readonly string[] = [
  'Claude',
  'noreply@anthropic.com',
  'Copilot',
  'Codex',
  'openai',
  'Cursor',
  'Devin',
  'Gemini',
  'Jules',
  'Argon',
  'Aider',
  'Windsurf',
  'Cline',
  'Amp',
];

export interface CommitIdentityInput {
  authorName?: string;
  authorEmail?: string;
  trailers?: readonly CommitTrailer[];
}

export type OriginClassifier = (commit: CommitIdentityInput) => CommitOrigin;

function compilePatternList(patterns: readonly string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p, 'i'));
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

/** Classifies a commit's origin using default or custom `OriginConfig` patterns. */
export function classifyCommitOrigin(commit: CommitIdentityInput, config?: OriginConfig): CommitOrigin {
  if (!config) return defaultClassifier(commit);
  return createOriginClassifier(config)(commit);
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
