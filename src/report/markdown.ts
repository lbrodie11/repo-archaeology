import { formatExplainCommand } from '../commands/explain.js';
import type { DiffFamilyView, DiffResult, SilenceDiagnostics, Suggestion } from '../commands/diff.js';
import type { Settings } from '../config.js';
import { formatOriginWeightsSpec, hasNonDefaultOriginWeights } from '../model/origin.js';
import { formatIntervalCi, formatTrackRecordLine, NAMES, weightingLabel } from './views.js';
import { pct, plural, shortHash } from '../util/term.js';

/**
 * Default UTF-8 byte ceiling for rendered Markdown summaries (512 KiB),
 * keeping output well below GitHub Actions' 1 MiB `$GITHUB_STEP_SUMMARY` limit.
 */
export const DEFAULT_MARKDOWN_MAX_BYTES = 512 * 1024;

export const FEEDBACK_ISSUE_URL =
  'https://github.com/lbrodie11/repo-archaeology/issues/new?template=suggestion-feedback.yml';

export interface RenderDiffMarkdownOptions {
  /** Maximum UTF-8 byte length of the returned Markdown document (default 512 KiB). */
  maxBytes?: number;
  /** Optional analysis settings overrides to preserve in rendered `explain` commands. */
  settings?: Partial<Settings>;
  /** Optional CLI flag-only settings (e.g. explicit `--ignore` patterns) for `explain` commands. */
  flagSettings?: Partial<Settings>;
  /** Optional HTTPS repository URL (e.g. `https://github.com/owner/repo`) to link evidence commit SHAs. */
  repoUrl?: string;
}

const CONTROL_AND_BIDI_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Bidi_Control}/gu;
const SAFE_REPO_URL_RE = /^https?:\/\/[a-zA-Z0-9.-]+(?::\d+)?\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
const HEX_SHA_RE = /^[0-9a-f]{7,64}$/i;
const FULL_HEX_SHA_RE = /^[0-9a-f]{40,64}$/i;

function normalizeRepoUrl(repoUrl?: string): string | undefined {
  if (!repoUrl) return undefined;
  const trimmed = repoUrl.trim().replace(/\/+$/, '');
  return SAFE_REPO_URL_RE.test(trimmed) ? trimmed : undefined;
}

/**
 * Neutralizes C0/C1 control characters, newlines, and Unicode bidi overrides
 * from repository-controlled strings, then clamps to `maxChars`.
 */
export function sanitizeMarkdownControlChars(value: string, maxChars = 240): string {
  const cleaned = value.replace(CONTROL_AND_BIDI_RE, (ch) => {
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    if (ch === '\t') return '\\t';
    const code = ch.codePointAt(0)!;
    return code <= 0xff
      ? `\\x${code.toString(16).padStart(2, '0')}`
      : `\\u${code.toString(16).padStart(4, '0')}`;
  });
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * Escapes untrusted repository text (commit subjects, author names, warning details)
 * for safe inline inclusion in GitHub-Flavored Markdown prose:
 * - neutralizes control/bidi chars and newlines,
 * - escapes HTML (`&`, `<`, `>`),
 * - escapes Markdown emphasis/link/table/code characters,
 * - neutralizes GitHub `@mentions`, `#123` / `GH-123` issue autolinks, and raw URLs.
 */
export function escapeMarkdownInline(value: string, maxChars = 200): string {
  const sanitized = sanitizeMarkdownControlChars(value, maxChars);
  return sanitized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@([a-zA-Z0-9_-]+)/g, '@\u200B$1')
    .replace(/#(\d+)/g, '#\u200B$1')
    .replace(/\b(GH)-(\d+)\b/gi, '$1-\u200B$2')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/~/g, '\\~')
    .replace(/!/g, '\\!')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\|/g, '\\|')
    .replace(/\b(https?):\/\//gi, '$1&#58;//');
}

/**
 * Formats an untrusted repository path, identifier, or shell command as a safe
 * CommonMark/GFM inline code span without altering printable characters (`\``, `|`, `<`, `>`).
 * Uses a backtick fence longer than any embedded backtick run so the code span
 * can never be broken out of and shell quoting is preserved verbatim.
 */
export function formatMarkdownCode(value: string, maxChars = 240): string {
  const sanitized = sanitizeMarkdownControlChars(value, maxChars);
  if (sanitized.length === 0) {
    return '` `';
  }
  let fence = '`';
  while (sanitized.includes(fence)) {
    fence += '`';
  }
  const needsSpacePadding =
    sanitized.startsWith('`') ||
    sanitized.endsWith('`') ||
    sanitized.startsWith(' ') ||
    sanitized.endsWith(' ');
  const pad = needsSpacePadding ? ' ' : '';
  return `${fence}${pad}${sanitized}${pad}${fence}`;
}

function formatCommitEvidenceLine(
  ev: { hash: string; date: string; subject: string },
  repoUrl?: string,
): string {
  const shaCode = formatMarkdownCode(shortHash(ev.hash), 16);
  const sha =
    repoUrl && HEX_SHA_RE.test(ev.hash) ? `[${shaCode}](${repoUrl}/commit/${ev.hash})` : shaCode;
  const date = escapeMarkdownInline(ev.date, 16);
  const subject = escapeMarkdownInline(ev.subject, 160);
  return `  - ${sha} (${date}) — ${subject}`;
}

function formatDirectionalEvidence(s: Suggestion, settings?: Partial<Settings>): string {
  const fromCode = formatMarkdownCode(s.from);
  const conf = pct(s.confidence);
  const revConf = pct(s.reverseConfidence);
  const ci = formatIntervalCi(s.interval, s.weighted);
  const lastTogether = s.lastTogether ? ` · last together ${escapeMarkdownInline(s.lastTogether, 20)}` : '';
  if (s.weighted) {
    let wLabel = weightingLabel(s);
    if (!s.weighting && settings) {
      const recency = settings.halfLifeDays !== undefined;
      const origin = hasNonDefaultOriginWeights(settings.origin?.weights);
      if (recency && origin) wLabel = 'recency+origin-weighted';
      else if (origin) wLabel = 'origin-weighted';
    }
    return (
      `Changed with ${fromCode} in **${s.shared} of ${s.fromChanges} commits** ${ci} ` +
      `(**${conf}** ${wLabel} · reverse **${revConf}** ${wLabel} across ${s.shared}/${s.toChanges} raw commits)` +
      lastTogether
    );
  }
  return (
    `Changed with ${fromCode} in **${s.shared} of ${s.fromChanges} commits (${conf})** ${ci} ` +
    `· reverse **${revConf}** (${s.shared}/${s.toChanges})` +
    lastTogether
  );
}

function renderSuggestionBlock(
  s: Suggestion,
  index: number,
  settings?: Partial<Settings>,
  flagSettings?: Partial<Settings>,
  repoUrl?: string,
  baselineRef?: string,
): string {
  const lines: string[] = [];
  const kindLabel = NAMES[s.relationship];
  const alsoNote =
    s.alsoLinkedFrom.length > 0
      ? ` (also linked to ${s.alsoLinkedFrom.map((p) => formatMarkdownCode(p)).join(', ')})`
      : '';

  lines.push(`${index + 1}. **${formatMarkdownCode(s.to)}** — \`${kindLabel}\``);
  lines.push(`   - ${formatDirectionalEvidence(s, settings)}${alsoNote}`);
  lines.push(`   - ${escapeMarkdownInline(s.why, 240)}`);
  if (s.verdict) {
    const label = s.verdict.kind === 'confirmed' ? 'Confirmed dependency' : 'Expected relationship';
    const metaParts: string[] = [];
    if (s.verdict.by) metaParts.push(`by ${escapeMarkdownInline(s.verdict.by, 80)}`);
    if (s.verdict.until) metaParts.push(`until ${escapeMarkdownInline(s.verdict.until, 20)}`);
    const attr = metaParts.length > 0 ? ` (${metaParts.join(', ')})` : '';
    lines.push(`   - **${label}**${attr}: ${escapeMarkdownInline(s.verdict.reason, 300)}`);
  }
  if (s.codeowners && s.codeowners.length > 0) {
    const provLabel =
      s.ownersSample?.codeownersSource === 'base'
        ? 'base CODEOWNERS'
        : s.ownersSample?.codeownersSource === 'head'
          ? 'head CODEOWNERS'
          : 'CODEOWNERS';
    const handles = s.codeowners.map((h) => escapeMarkdownInline(h, 140)).join(', ');
    lines.push(`   - **Designated code owners** (${provLabel}): ${handles}`);
  }
  if (s.owners !== undefined) {
    const sample = s.ownersSample;
    const lookbackDays = sample?.lookbackDays ?? 365;
    const qualifying = sample?.qualifyingCommits ?? s.owners.reduce((sum, o) => sum + o.commits, 0);
    const metaNotes: string[] = [];
    if (sample && sample.agentAssistedCommits > 0) {
      metaNotes.push(`${plural(sample.agentAssistedCommits, 'AI-assisted commit')} included`);
    }
    if (sample?.incompleteCoverage) {
      metaNotes.push('incomplete history coverage');
    }
    const notesSuffix = metaNotes.length > 0 ? `, ${metaNotes.join(', ')}` : '';
    if (s.owners.length === 0) {
      lines.push(
        `   - **People who may have context:** no qualifying recent human changes in the last ${lookbackDays}d${notesSuffix}.`,
      );
    } else if (qualifying <= 1) {
      const o = s.owners[0]!;
      const loginPart = o.login ? ` (${escapeMarkdownInline(o.login, 40)})` : '';
      lines.push(
        `   - **People who may have context** _(limited sample: 1 qualifying recent change in ${lookbackDays}d${notesSuffix})_: ` +
          `${escapeMarkdownInline(o.name, 120)}${loginPart} (1 of 1 change, last ${escapeMarkdownInline(o.lastDate, 16)}) — ` +
          `_Historical activity suggests familiarity, not current ownership or availability._`,
      );
    } else {
      const people = s.owners
        .map((o) => {
          const loginPart = o.login ? ` (${escapeMarkdownInline(o.login, 40)})` : '';
          return (
            `${escapeMarkdownInline(o.name, 120)}${loginPart} ` +
            `(contributed to ${o.commits} of ${qualifying} qualifying recent changes, last ${escapeMarkdownInline(o.lastDate, 16)})`
          );
        })
        .join('; ');
      lines.push(
        `   - **People who may have context** (${lookbackDays}d window${notesSuffix}): ${people} — ` +
          `_Historical activity suggests familiarity, not current ownership or availability._`,
      );
    }
  }

  const trackLine = formatTrackRecordLine(s, (name) => formatMarkdownCode(name));
  if (trackLine) lines.push(trackLine.dim ? `   - _${trackLine.text}_` : `   - ${trackLine.text}`);

  const topCommits = s.evidence.slice(0, 3);
  for (const ev of topCommits) {
    lines.push(` ${formatCommitEvidenceLine(ev, repoUrl)}`);
  }

  const explainCmd = formatExplainCommand(
    s.from,
    s.to,
    settings,
    flagSettings,
    baselineRef ? { base: baselineRef } : undefined,
  );
  lines.push(`   - Verify: ${formatMarkdownCode(explainCmd, Number.POSITIVE_INFINITY)}`);
  return lines.join('\n');
}

function renderFamilyBlock(f: DiffFamilyView, shownSuggested: ReadonlySet<string>): string {
  const touched = f.changedMembers.map((p) => formatMarkdownCode(p)).join(', ');
  const suggested = f.suggestedMembers
    .map((p) => (shownSuggested.has(p) ? formatMarkdownCode(p) : `${formatMarkdownCode(p)} _(beyond --limit)_`))
    .join(', ');
  const coverage = f.complete
    ? `all ${f.possiblePairs} pairwise links met thresholds`
    : `${f.qualifyingPairs} of ${f.possiblePairs} pairwise links met thresholds`;
  const commitsText =
    `${plural(f.commitsTouchingTwoOrMore, 'supporting commit')} (2+ members via a qualifying pair)` +
    (f.commitsTouchingAll > 0 ? `, ${f.commitsTouchingAll} touched all ${f.members.length}` : '');
  return (
    `- **${escapeMarkdownInline(f.label, 160)}** — changed ${touched}; check ${suggested} ` +
    `(${coverage} · ${commitsText})`
  );
}

function renderSilenceSection(result: DiffResult, silence: SilenceDiagnostics): string[] {
  const lines: string[] = [];
  lines.push('### No companion suggestions');
  lines.push('');

  const withHistory = result.changed.filter((f) => f.hasHistory).length;
  switch (silence.primaryReason) {
    case 'no_changed_files':
      lines.push('No changed files were detected in the evaluated range.');
      break;
    case 'limited_repo_history':
      lines.push(
        `No suggestions after evaluating ${plural(result.changed.length, 'changed file')} ` +
          `(${plural(result.meta.commitsAnalyzed, 'commit')} in baseline history):`,
      );
      break;
    case 'no_history_for_changed_files':
      lines.push('No suggestions: none of the changed files appear in the pre-change baseline history.');
      break;
    case 'all_companions_touched':
    case 'silenced_by_verdicts':
    case 'no_cochange_partners':
    case 'filtered_by_thresholds':
    case 'filtered_by_kinds':
    default:
      lines.push(
        `No suggestions after evaluating ${plural(withHistory || result.changed.length, 'file')}:`,
      );
      break;
  }

  if (silence.details.length > 0) {
    lines.push('');
    for (const detail of silence.details) {
      lines.push(`- ${escapeMarkdownInline(detail, 260)}`);
    }
  }

  lines.push('');
  lines.push(
    '_Zero suggestions means no untouched file met the configured historical co-change thresholds—not that this change is guaranteed free of omissions._',
  );
  return lines;
}

/**
 * Pure, deterministic GitHub-Flavored Markdown renderer for `DiffResult`.
 * Contains no GitHub environment variable lookups or network calls.
 */
export function renderDiffMarkdown(result: DiffResult, options: RenderDiffMarkdownOptions = {}): string {
  const maxBytes = options.maxBytes ?? DEFAULT_MARKDOWN_MAX_BYTES;
  const repoUrl = normalizeRepoUrl(options.repoUrl);
  const effectiveSettings: Partial<Settings> = {
    ...result.meta.settings,
    ...options.settings,
  };
  const headerLines: string[] = [];

  headerLines.push('## Repo Archaeology');
  headerLines.push('');
  headerLines.push(
    '_Historical co-change clues from Git history. Suggestions highlight untouched files that repeatedly changed alongside your modified files in past commits—they are prompts for review, not proof of a bug._',
  );
  headerLines.push('');

  const { meta, evaluation } = result;
  const withoutHistory = result.changed.filter((f) => !f.hasHistory).length;
  const historyNote =
    withoutHistory > 0 ? ` (${withoutHistory} new or without prior baseline history)` : '';
  const scopeParts: string[] = [];
  scopeParts.push(`Evaluated **${plural(result.changed.length, 'changed file')}**${historyNote}`);
  if (result.base) {
    const baseDisplay = FULL_HEX_SHA_RE.test(result.base) ? shortHash(result.base) : result.base;
    const mergeShort = evaluation?.mergeBaseSha
      ? shortHash(evaluation.mergeBaseSha)
      : evaluation?.baselineSha
        ? shortHash(evaluation.baselineSha)
        : baseDisplay;
    const headShort = evaluation?.headSha ? shortHash(evaluation.headSha) : 'HEAD';
    scopeParts.push(
      `against base ${formatMarkdownCode(baseDisplay, 80)} (merge-base ${formatMarkdownCode(mergeShort, 16)} → ${formatMarkdownCode(headShort, 16)})`,
    );
  }
  const range =
    meta.oldestCommit && meta.newestCommit ? ` (${meta.oldestCommit} to ${meta.newestCommit})` : '';
  const skippedParts: string[] = [];
  if (meta.sweepsSkipped > 0) {
    skippedParts.push(`${plural(meta.sweepsSkipped, 'sweeping commit')} skipped`);
  }
  if ((meta.revertsSkipped ?? 0) > 0) {
    skippedParts.push(`${plural(meta.revertsSkipped!, 'revert commit')} skipped`);
  }
  if (meta.subjectSkipped > 0) {
    skippedParts.push(`${plural(meta.subjectSkipped, 'filtered commit')} skipped`);
  }
  const skippedNote = skippedParts.length > 0 ? ` · ${skippedParts.join(', ')}` : '';
  const silencedCount = result.verdicts?.silenced ?? result.silence?.verdicts?.silenced ?? 0;
  const silencedNote =
    silencedCount > 0 ? ` · ${plural(silencedCount, 'expected relationship')} silenced by verdicts` : '';
  const halfLifeNote =
    meta.settings.halfLifeDays !== undefined
      ? ` · recency half-life ${meta.settings.halfLifeDays}d`
      : '';
  const originWeightsNote = hasNonDefaultOriginWeights(meta.settings.origin?.weights)
    ? ` · origin weights ${formatOriginWeightsSpec(meta.settings.origin!.weights!)}`
    : '';
  const weightNote = `${halfLifeNote}${originWeightsNote}`;
  headerLines.push(
    `${scopeParts.join(' ')} · **${plural(meta.commitsAnalyzed, 'commit')} analyzed**${range}` +
      ` (thresholds: ≥${meta.settings.minShared} shared, ≥${pct(meta.settings.minConfidence)} confidence${weightNote})${skippedNote}${silencedNote}.`,
  );

  const addedInBranch = result.verdicts?.addedInBranch ?? result.silence?.verdicts?.addedInBranch ?? 0;
  if (addedInBranch > 0) {
    headerLines.push('');
    headerLines.push(
      `> **Note:** This PR adds ${plural(addedInBranch, 'expected verdict')} (not applied until merged).`,
    );
  }

  if (meta.warnings.length > 0) {
    headerLines.push('');
    for (const warning of meta.warnings) {
      headerLines.push(`> **Warning:** ${escapeMarkdownInline(warning, 260)}`);
    }
  }

  // Empty / silence state (omit feedback footer when there are no suggestions)
  if (result.suggestions.length === 0) {
    const silence: SilenceDiagnostics = result.silence ?? {
      primaryReason: result.changed.length === 0 ? 'no_changed_files' : 'no_cochange_partners',
      reasons: [result.changed.length === 0 ? 'no_changed_files' : 'no_cochange_partners'],
      changedFiles: result.changed.length,
      changedWithHistory: result.changed.filter((f) => f.hasHistory).length,
      changedInsufficientHistory: 0,
      rawCompanions: 0,
      qualifyingCompanions: 0,
      touchedCompanions: 0,
      filteredByThreshold: 0,
      filteredByKind: 0,
      deletedCompanions: 0,
      shallowHistory: false,
      limitedHistory: false,
      commitsAnalyzed: meta.commitsAnalyzed,
      details: [],
    };
    const bodyLines = ['', ...renderSilenceSection(result, silence)];
    return clampMarkdownToByteBudget(headerLines, bodyLines, [], maxBytes);
  }

  const footerLines: string[] = [
    '',
    '---',
    `Was a suggestion useful or noisy? [Share feedback](${FEEDBACK_ISSUE_URL}) _(please avoid posting private paths or source code)_.`,
  ];

  // Non-empty suggestions state: precompute blocks and prefix byte sums so truncation runs in O(N + log N) time.
  const families = result.families ?? [];
  const baselineRef =
    result.base !== undefined
      ? (evaluation?.baselineSha ?? evaluation?.mergeBaseSha ?? result.base)
      : undefined;
  const suggestionBlocks = result.suggestions.map((s, idx) =>
    renderSuggestionBlock(
      s,
      idx,
      effectiveSettings,
      options.flagSettings,
      repoUrl,
      baselineRef,
    ),
  );
  const totalSuggestions = Math.max(result.totalSuggestions ?? suggestionBlocks.length, suggestionBlocks.length);

  // sugPrefixBytes[k] = UTF-8 bytes of suggestionBlocks[0..k-1] joined by '\n\n'
  const sugPrefixBytes = new Float64Array(suggestionBlocks.length + 1);
  for (let i = 0; i < suggestionBlocks.length; i++) {
    const blockBytes = Buffer.byteLength(suggestionBlocks[i]!, 'utf8');
    sugPrefixBytes[i + 1] = sugPrefixBytes[i]! + (i > 0 ? 2 : 0) + blockBytes;
  }

  const headerText = headerLines.join('\n');
  const footerText = footerLines.join('\n');
  const baseWrapperBytes = Buffer.byteLength(`${headerText}\n${footerText}\n`, 'utf8');

  const formatMiddlePrefixAndSuffix = (
    includedFamilies: number,
    includedSuggestions: number,
  ): { prefixLines: string[]; suffixLines: string[] } => {
    const prefixLines: string[] = [];
    const shownSuggested = new Set(result.suggestions.slice(0, includedSuggestions).map((s) => s.to));
    if (includedFamilies > 0) {
      prefixLines.push('');
      const famHeading =
        includedFamilies < families.length
          ? `### Finding families (showing ${includedFamilies} of ${families.length})`
          : `### Finding families (${families.length})`;
      prefixLines.push(famHeading);
      prefixLines.push('');
      for (let i = 0; i < includedFamilies; i++) {
        prefixLines.push(renderFamilyBlock(families[i]!, shownSuggested));
      }
    }

    prefixLines.push('');
    const sugHeading =
      includedSuggestions < totalSuggestions
        ? `### Possibly missed (showing ${includedSuggestions} of ${totalSuggestions})`
        : `### Possibly missed (${totalSuggestions})`;
    prefixLines.push(sugHeading);
    prefixLines.push('');

    const suffixLines: string[] = [];
    const omittedSuggestions = suggestionBlocks.length - includedSuggestions;
    const omittedFamilies = families.length - includedFamilies;
    if (omittedSuggestions > 0 || omittedFamilies > 0) {
      const parts: string[] = [];
      if (omittedSuggestions > 0) parts.push(plural(omittedSuggestions, 'suggestion'));
      if (omittedFamilies > 0) parts.push(plural(omittedFamilies, 'finding family', 'finding families'));
      suffixLines.push('');
      suffixLines.push(
        `> _Output truncated to stay within the summary size limit (omitted ${parts.join(' and ')}). Run \`npx repo-archaeology diff\` locally or inspect \`--json-out\` for the full results._`,
      );
    }
    return { prefixLines, suffixLines };
  };

  // Compute exact UTF-8 byte length without joining suggestionBlocks.
  const measureCandidateBytes = (includedFamilies: number, includedSuggestions: number): number => {
    const { prefixLines, suffixLines } = formatMiddlePrefixAndSuffix(
      includedFamilies,
      includedSuggestions,
    );
    const prefixBytes = Buffer.byteLength(`\n${prefixLines.join('\n')}`, 'utf8');
    const sugSectionBytes =
      includedSuggestions > 0 ? 1 + sugPrefixBytes[includedSuggestions]! : 0;
    const suffixBytes =
      suffixLines.length > 0 ? Buffer.byteLength(`\n${suffixLines.join('\n')}`, 'utf8') : 0;
    return baseWrapperBytes + prefixBytes + sugSectionBytes + suffixBytes;
  };

  const buildDocument = (includedFamilies: number, includedSuggestions: number): string => {
    const { prefixLines, suffixLines } = formatMiddlePrefixAndSuffix(
      includedFamilies,
      includedSuggestions,
    );
    const mid: string[] = [...prefixLines];
    for (let i = 0; i < includedSuggestions; i++) {
      if (i > 0) mid.push('');
      mid.push(suggestionBlocks[i]!);
    }
    mid.push(...suffixLines);
    return [...headerLines, ...mid, ...footerLines].join('\n') + '\n';
  };

  if (measureCandidateBytes(families.length, suggestionBlocks.length) <= maxBytes) {
    return buildDocument(families.length, suggestionBlocks.length);
  }

  // Map monotonic step index in [0, families.length + suggestionBlocks.length] to (includedFamilies, includedSuggestions):
  // - Drop suggestions down to 1 first while keeping all families,
  // - Then drop families down to 0 while keeping 1 suggestion,
  // - Finally drop the last suggestion to 0.
  const totalSteps = families.length + suggestionBlocks.length;
  const stepToCounts = (step: number): [number, number] => {
    if (step <= 0) return [0, 0];
    if (step <= families.length) return [step - 1, 1];
    return [families.length, step - families.length];
  };

  let lo = 0;
  let hi = totalSteps - 1;
  let bestStep = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const [famCount, sugCount] = stepToCounts(mid);
    if (measureCandidateBytes(famCount, sugCount) <= maxBytes) {
      bestStep = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (bestStep >= 0) {
    const [bestFamilies, bestSuggestions] = stepToCounts(bestStep);
    return buildDocument(bestFamilies, bestSuggestions);
  }

  return clampMarkdownToByteBudget(headerLines, [], footerLines, maxBytes);
}

function clampMarkdownToByteBudget(
  headerLines: string[],
  bodyLines: string[],
  footerLines: string[],
  maxBytes: number,
): string {
  const full = [...headerLines, ...bodyLines, ...footerLines].join('\n') + '\n';
  if (Buffer.byteLength(full, 'utf8') <= maxBytes) return full;

  const minimal =
    [
      '## Repo Archaeology',
      '',
      '_Output truncated to fit the summary byte budget. Run `npx repo-archaeology diff` or inspect `--json-out` for details._',
      ...footerLines,
    ].join('\n') + '\n';
  if (Buffer.byteLength(minimal, 'utf8') <= maxBytes) return minimal;
  return Buffer.from(minimal, 'utf8').subarray(0, Math.max(0, maxBytes - 1)).toString('utf8') + '\n';
}
