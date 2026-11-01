import { formatExplainCommand } from '../commands/explain.js';
import type { DiffFamilyView, DiffResult, SilenceDiagnostics, Suggestion } from '../commands/diff.js';
import { NAMES } from './views.js';
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
}

const CONTROL_AND_BIDI_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Bidi_Control}/gu;

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
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/~/g, '\\~')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\|/g, '\\|')
    .replace(/[@#]/g, (ch) => (ch === '@' ? '&#64;' : '&#35;'))
    .replace(/\b(GH)-(\d+)\b/gi, '$1&#45;$2')
    .replace(/\b(https?):\/\//gi, '$1&#58;//');
}

/**
 * Formats an untrusted repository path or identifier as a safe GFM inline code span.
 * Backticks inside the string are replaced and HTML/table chars are kept inert so
 * the code span can never be broken out of.
 */
export function formatMarkdownCode(value: string, maxChars = 240): string {
  const sanitized = sanitizeMarkdownControlChars(value, maxChars)
    .replace(/`/g, "'")
    .replace(/\|/g, '\u2223')
    .replace(/</g, '\uFF1C')
    .replace(/>/g, '\uFF1E');
  return `\`${sanitized || ' '}\``;
}

function formatCommitEvidenceLine(ev: { hash: string; date: string; subject: string }): string {
  const sha = formatMarkdownCode(shortHash(ev.hash), 16);
  const date = escapeMarkdownInline(ev.date, 16);
  const subject = escapeMarkdownInline(ev.subject, 160);
  return `  - ${sha} (${date}) — ${subject}`;
}

function formatDirectionalEvidence(s: Suggestion): string {
  const fromCode = formatMarkdownCode(s.from);
  const conf = pct(s.confidence);
  const revConf = pct(s.reverseConfidence);
  const lastTogether = s.lastTogether ? ` · last together ${escapeMarkdownInline(s.lastTogether, 20)}` : '';
  if (s.weighted) {
    return (
      `Changed with ${fromCode} in **${s.shared} of ${s.fromChanges} commits** ` +
      `(**${conf}** recency-weighted · reverse **${revConf}** recency-weighted across ${s.shared}/${s.toChanges} raw commits)` +
      lastTogether
    );
  }
  return (
    `Changed with ${fromCode} in **${s.shared} of ${s.fromChanges} commits (${conf})** ` +
    `· reverse **${revConf}** (${s.shared}/${s.toChanges})` +
    lastTogether
  );
}

function renderSuggestionBlock(s: Suggestion, index: number): string {
  const lines: string[] = [];
  const kindLabel = NAMES[s.relationship];
  const alsoNote =
    s.alsoLinkedFrom.length > 0
      ? ` (also linked to ${s.alsoLinkedFrom.map((p) => formatMarkdownCode(p)).join(', ')})`
      : '';

  lines.push(`${index + 1}. **${formatMarkdownCode(s.to)}** — \`${kindLabel}\``);
  lines.push(`   - ${formatDirectionalEvidence(s)}${alsoNote}`);
  lines.push(`   - ${escapeMarkdownInline(s.why, 240)}`);

  const topCommits = s.evidence.slice(0, 3);
  for (const ev of topCommits) {
    lines.push(` ${formatCommitEvidenceLine(ev)}`);
  }

  const explainCmd = formatExplainCommand(s.from, s.to);
  lines.push(`   - Verify: ${formatMarkdownCode(explainCmd, 300)}`);
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
    const mergeShort = evaluation?.mergeBaseSha
      ? shortHash(evaluation.mergeBaseSha)
      : evaluation?.baselineSha
        ? shortHash(evaluation.baselineSha)
        : result.base;
    const headShort = evaluation?.headSha ? shortHash(evaluation.headSha) : 'HEAD';
    scopeParts.push(
      `against base ${formatMarkdownCode(result.base, 80)} (merge-base ${formatMarkdownCode(mergeShort, 16)} → ${formatMarkdownCode(headShort, 16)})`,
    );
  }
  const range =
    meta.oldestCommit && meta.newestCommit ? ` (${meta.oldestCommit} to ${meta.newestCommit})` : '';
  const skippedParts: string[] = [];
  if (meta.sweepsSkipped > 0) {
    skippedParts.push(`${plural(meta.sweepsSkipped, 'sweeping commit')} skipped`);
  }
  if (meta.subjectSkipped > 0) {
    skippedParts.push(`${plural(meta.subjectSkipped, 'filtered commit')} skipped`);
  }
  const skippedNote = skippedParts.length > 0 ? ` · ${skippedParts.join(', ')}` : '';
  const weightNote =
    meta.settings.halfLifeDays !== undefined
      ? ` · recency half-life ${meta.settings.halfLifeDays}d`
      : '';
  headerLines.push(
    `${scopeParts.join(' ')} · **${plural(meta.commitsAnalyzed, 'commit')} analyzed**${range}` +
      ` (thresholds: ≥${meta.settings.minShared} shared, ≥${pct(meta.settings.minConfidence)} confidence${weightNote})${skippedNote}.`,
  );

  if (meta.warnings.length > 0) {
    headerLines.push('');
    for (const warning of meta.warnings) {
      headerLines.push(`> **Warning:** ${escapeMarkdownInline(warning, 260)}`);
    }
  }

  const footerLines: string[] = [
    '',
    '---',
    `Was a suggestion useful or noisy? [Share feedback](${FEEDBACK_ISSUE_URL}) _(please avoid posting private paths or source code)_.`,
  ];

  // Empty / silence state
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
    return clampMarkdownToByteBudget(headerLines, bodyLines, footerLines, maxBytes);
  }

  // Non-empty suggestions state: enforce byte budget by progressively fitting families and suggestions.
  const families = result.families ?? [];
  const suggestionBlocks = result.suggestions.map((s, idx) => renderSuggestionBlock(s, idx));

  const buildDocument = (includedFamilies: number, includedSuggestions: number): string => {
    const mid: string[] = [];
    const shownSuggested = new Set(result.suggestions.slice(0, includedSuggestions).map((s) => s.to));
    if (includedFamilies > 0) {
      mid.push('');
      const famHeading =
        includedFamilies < families.length
          ? `### Finding families (showing ${includedFamilies} of ${families.length})`
          : `### Finding families (${families.length})`;
      mid.push(famHeading);
      mid.push('');
      for (let i = 0; i < includedFamilies; i++) {
        mid.push(renderFamilyBlock(families[i]!, shownSuggested));
      }
    }

    mid.push('');
    const sugHeading =
      includedSuggestions < suggestionBlocks.length
        ? `### Possibly missed (showing ${includedSuggestions} of ${suggestionBlocks.length})`
        : `### Possibly missed (${suggestionBlocks.length})`;
    mid.push(sugHeading);
    mid.push('');
    for (let i = 0; i < includedSuggestions; i++) {
      if (i > 0) mid.push('');
      mid.push(suggestionBlocks[i]!);
    }

    const omittedSuggestions = suggestionBlocks.length - includedSuggestions;
    const omittedFamilies = families.length - includedFamilies;
    if (omittedSuggestions > 0 || omittedFamilies > 0) {
      const parts: string[] = [];
      if (omittedSuggestions > 0) parts.push(plural(omittedSuggestions, 'suggestion'));
      if (omittedFamilies > 0) parts.push(plural(omittedFamilies, 'finding family', 'finding families'));
      mid.push('');
      mid.push(
        `> _Output truncated to stay within the summary size limit (omitted ${parts.join(' and ')}). Run \`npx repo-archaeology diff\` locally or inspect \`--json-out\` for the full results._`,
      );
    }

    return [...headerLines, ...mid, ...footerLines].join('\n') + '\n';
  };

  const fullDoc = buildDocument(families.length, suggestionBlocks.length);
  if (Buffer.byteLength(fullDoc, 'utf8') <= maxBytes) {
    return fullDoc;
  }

  // Fit as many suggestions and families as possible under maxBytes.
  let bestFamilies = families.length;
  let bestSuggestions = suggestionBlocks.length;
  while (bestSuggestions > 0 || bestFamilies > 0) {
    if (bestSuggestions > 1) {
      bestSuggestions--;
    } else if (bestFamilies > 0) {
      bestFamilies--;
    } else {
      bestSuggestions = 0;
    }
    const candidate = buildDocument(bestFamilies, bestSuggestions);
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) {
      return candidate;
    }
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
