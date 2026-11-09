import { stdout } from 'node:process';
import type { DiffFamilyView, DiffResult, Suggestion } from '../commands/diff.js';
import {
  EXPLAIN_DISCLAIMER,
  formatExplainCommand,
  type CounterexampleCommitEvidence,
  type ExplainResult,
} from '../commands/explain.js';
import type { FileCompanionView, FileResult } from '../commands/file.js';
import type { ScanOptions, ScanResult } from '../commands/scan.js';
import type { Settings } from '../config.js';
import type { FilePatchEvidence } from '../git/patch.js';
import { RELATIONSHIPS, type Relationship } from '../imports/classify.js';
import type { FindingFamilyView } from '../model/families.js';
import type { RelationshipVerdictView } from '../model/verdicts.js';
import { FRAME12 } from '../style/frame12.js';
import type { WilsonInterval } from '../util/stats.js';
import { pct, plural, shortHash, timeAgo } from '../util/term.js';
import {
  detectTerminalCapabilities,
  expandRichTabs,
  formatOsc8CommitLink,
  getDisplayWidth,
  getGraphemeDisplayWidth,
  isValidCommitSha,
  middleTruncatePath,
  parseTrustedRemoteRepoUrl,
  sanitizeRichText,
  startRichProgressSpinner,
  stripAnsiAndOsc8,
  type CapabilityOptions,
  type ColorLevel,
  type RichSpinnerController,
  type TerminalCapabilities,
} from './terminal-safety.js';
import {
  DISCLAIMER,
  NAMES,
  weightingLabel,
  type EvidenceView,
  type Meta,
  type RelationshipView,
} from './views.js';

export {
  detectTerminalCapabilities,
  expandRichTabs,
  formatOsc8CommitLink,
  getDisplayWidth,
  getGraphemeDisplayWidth,
  isValidCommitSha,
  middleTruncatePath,
  parseTrustedRemoteRepoUrl,
  sanitizeRichText,
  startRichProgressSpinner,
  stripAnsiAndOsc8,
  type CapabilityOptions,
  type ColorLevel,
  type RichSpinnerController,
  type TerminalCapabilities,
};

export interface RichRenderOptions extends CapabilityOptions {
  remoteUrl?: string;
  fullEvidence?: boolean;
  flagSettings?: Partial<Settings>;
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

export function formatRichDimLine(text: string, renderOpts: RichRenderOptions = {}): string {
  const caps = detectTerminalCapabilities(renderOpts);
  const styler = createRichStyler(caps, renderOpts.remoteUrl);
  return styler.dim(sanitizeRichText(text));
}

export function printRichDimLine(text: string, renderOpts: RichRenderOptions = {}): void {
  stdout.write(`${formatRichDimLine(text, renderOpts)}\n`);
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

function renderRichSuggestionOwnership(s: Suggestion, styler: RichStyler, unicode: boolean): string[] {
  if (s.owners === undefined && s.codeowners === undefined) return [];
  const out: string[] = [];
  const sample = s.ownersSample;
  if (s.codeowners && s.codeowners.length > 0) {
    const provLabel =
      sample?.codeownersSource === 'base'
        ? 'base CODEOWNERS'
        : sample?.codeownersSource === 'head'
          ? 'head CODEOWNERS'
          : 'CODEOWNERS';
    const handles = s.codeowners
      .map((h) => {
        const safe = sanitizeRichText(h);
        return unicode ? safe.replace(/@([A-Za-z0-9_-]+)/g, '@\u200B$1') : safe;
      })
      .join(', ');
    out.push(`    ${styler.bold('Designated code owners')} ${styler.dim(`(${provLabel})`)}: ${handles}`);
  }
  if (s.owners !== undefined) {
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
      out.push(
        `    ${styler.bold('People who may have context')}: ${styler.dim(`no qualifying recent human changes in the last ${lookbackDays}d${notesSuffix}`)}`,
      );
      return out;
    }
    if (qualifying <= 1) {
      const o = s.owners[0]!;
      const loginPart = o.login ? ` (${sanitizeRichText(o.login)})` : '';
      out.push(
        `    ${styler.bold('People who may have context')} ${styler.dim(`(limited sample: 1 qualifying recent change in ${lookbackDays}d${notesSuffix})`)}: ${sanitizeRichText(o.name)}${loginPart} ${styler.dim(`(1 of 1 change, last ${sanitizeRichText(o.lastDate)})`)}`,
      );
      out.push(styler.dim('    Historical activity suggests familiarity, not current ownership or availability.'));
      return out;
    }
    const people = s.owners
      .map((o) => {
        const loginPart = o.login ? ` (${sanitizeRichText(o.login)})` : '';
        return `${sanitizeRichText(o.name)}${loginPart} ${styler.dim(`(contributed to ${o.commits} of ${qualifying} qualifying recent changes, last ${sanitizeRichText(o.lastDate)})`)}`;
      })
      .join('; ');
    out.push(
      `    ${styler.bold('People who may have context')} ${styler.dim(`(${lookbackDays}d window${notesSuffix})`)}: ${people}`,
    );
    out.push(styler.dim('    Historical activity suggests familiarity, not current ownership or availability.'));
  }
  return out;
}

function formatRichIntervalCi(interval: WilsonInterval, raw = false, unicode = true): string {
  const dash = unicode ? '–' : '-';
  return `(${raw ? 'raw ' : ''}95% CI ${Math.floor(interval.low * 100 + 1e-9)}${dash}${Math.ceil(interval.high * 100 - 1e-9)}%)`;
}

function formatRichStrength(view: RelationshipView, caps: TerminalCapabilities): string {
  const dot = caps.unicode ? '·' : '|';
  const wLabel = weightingLabel(view);
  const countsAndRate = view.weighted
    ? `${view.shared} of ${view.fromChanges} commits ${formatRichIntervalCi(view.interval, true, caps.unicode)} (${pct(view.confidence)} ${wLabel})`
    : `${view.shared} of ${view.fromChanges} commits (${pct(view.confidence)}) ${formatRichIntervalCi(view.interval, false, caps.unicode)}`;
  return `${countsAndRate} ${dot} last together ${timeAgo(Date.parse(view.lastTogether) / 1000)}`;
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
      ? ` from ${sanitizeRichText(meta.oldestCommit)} to ${sanitizeRichText(meta.newestCommit)}`
      : '';
  const revertsSkipped = meta.revertsSkipped ?? 0;
  const skippedParts = [
    meta.sweepsSkipped > 0 ? plural(meta.sweepsSkipped, 'sweeping commit') : '',
    revertsSkipped > 0 ? plural(revertsSkipped, 'revert commit') : '',
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

function resolveViewReceipts(view: RelationshipView): EvidenceView[] {
  return view.allEvidence && view.allEvidence.length > view.evidence.length
    ? view.allEvidence
    : view.evidence;
}

function renderRichEvidence(
  view: RelationshipView,
  styler: RichStyler,
  options: { indent?: string; fullEvidence?: boolean; explainHint?: string } = {},
): string[] {
  const indent = options.indent ?? '    ';
  const lines: string[] = [];
  const evidence = resolveViewReceipts(view);

  if (evidence.length > 0) {
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
    const badge = i === 0 ? styler.markerBadge(`${cutId} ${dot} #1 IN RANKING`) : styler.cutBadge(cutId);
    const { headline, fullPathsLine } = formatHeadlinePair(view.from, view.to, arrow, caps, styler);
    const safeFrom = sanitizeRichText(view.from);
    const safeTo = sanitizeRichText(view.to);

    lines.push(`${badge} ${headline}  ${styler.relationshipBadge(view.relationship)}`);
    if (fullPathsLine) lines.push(styler.dim(fullPathsLine));
    lines.push(`    when ${safeFrom} changed, ${safeTo} changed too in ${formatRichStrength(view, caps)}`);
    lines.push(styler.dim(`    reverse: ${pct(view.reverseConfidence)} ${dot} ${sanitizeRichText(view.why)}`));
    if (view.verdict) {
      lines.push(`    ${formatRichVerdict(view.verdict, styler)}`);
    }
    const explainCmd = formatExplainCommand(
      view.from,
      view.to,
      result.meta.settings,
      renderOpts.flagSettings,
      result.meta.head ? { head: result.meta.head.ref } : undefined,
    );
    lines.push(
      ...renderRichEvidence(view, styler, {
        fullEvidence: renderOpts.fullEvidence,
        explainHint: explainCmd,
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
  const emDash = caps.unicode ? '—' : '--';
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

  const formatSilenceDetail = (detail: string): string => {
    const safe = sanitizeRichText(detail);
    return caps.unicode ? safe : safe.replace(/≥(?=\d)/g, '>=');
  };

  if (result.suggestions.length === 0) {
    if (withHistory === 0) {
      lines.push(styler.dim('No suggestions: none of the changed files have usable history to evaluate.'));
      if (result.silence) {
        for (const detail of result.silence.details.slice(1)) {
          lines.push(styler.dim(`  ${bullet} ${formatSilenceDetail(detail)}`));
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
        lines.push(`  ${bullet} ${formatSilenceDetail(detail)}`);
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
        `  ${styler.bold(sanitizeRichText(fam.label))} ${emDash} changed ${fam.changedMembers.map(sanitizeRichText).join(', ')}; check ${suggestedLabels.join(', ')} ${styler.dim(`(${pairNote} ${dot} ${plural(fam.commitsTouchingTwoOrMore, 'supporting commit')} (2+ members via a qualifying pair))`)}`,
      );
    }
    lines.push('');
  }

  lines.push(styler.bold(`Possibly missed (${result.suggestions.length})`));
  lines.push('');

  const baselineRef =
    result.base !== undefined
      ? (result.evaluation?.baselineSha ?? result.evaluation?.mergeBaseSha ?? result.base)
      : undefined;

  result.suggestions.forEach((s: Suggestion, i: number) => {
    const cutId = formatCutId(i);
    // Exactly one marker-yellow badge per render on F-01 (rank #1 in current ordering)
    const badge = i === 0 ? styler.markerBadge(`${cutId} ${dot} #1 IN RANKING`) : styler.cutBadge(cutId);
    const { headline, fullPathsLine } = formatHeadlinePair(s.to, s.from, arrow, caps, styler);
    const safeFrom = sanitizeRichText(s.from);

    lines.push(`  ${badge} ${headline}  ${styler.relationshipBadge(s.relationship)}`);
    if (fullPathsLine) lines.push(styler.dim(fullPathsLine));
    lines.push(`    changed with ${safeFrom} in ${formatRichStrength(s, caps)}`);
    if (s.alsoLinkedFrom.length > 0) {
      lines.push(styler.dim(`    also linked to: ${s.alsoLinkedFrom.map(sanitizeRichText).join(', ')}`));
    }
    lines.push(styler.dim(`    ${sanitizeRichText(s.why)}`));
    if (s.verdict) {
      lines.push(`    ${formatRichVerdict(s.verdict, styler)}`);
    }
    lines.push(...renderRichSuggestionOwnership(s, styler, caps.unicode));
    const explainCmd = formatExplainCommand(
      s.from,
      s.to,
      result.meta.settings,
      renderOpts.flagSettings,
      {
        ...(result.meta.head ? { head: result.meta.head.ref } : {}),
        ...(baselineRef ? { base: baselineRef } : {}),
      },
    );
    lines.push(
      ...renderRichEvidence(s, styler, {
        fullEvidence: renderOpts.fullEvidence,
        explainHint: explainCmd,
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
    const badge = i === 0 ? styler.markerBadge(`${cutId} ${dot} #1 IN RANKING`) : styler.cutBadge(cutId);
    const statusDot = comp.wouldAlert ? styler.magenta(alertDot) : styler.dim(quietDot);
    const safeTo = sanitizeRichText(comp.to);
    const truncTo = middleTruncatePath(safeTo, Math.max(12, caps.columns - 24), caps.unicode);

    lines.push(`  ${statusDot} ${badge} ${styler.bold(truncTo.display)}  ${styler.relationshipBadge(comp.relationship)}`);
    if (truncTo.truncated) {
      lines.push(styler.dim(`    path: ${safeTo}`));
    }
    lines.push(`    ${formatRichStrength(comp, caps)} ${dot} reverse ${pct(comp.reverseConfidence)}`);
    lines.push(styler.dim(`    ${sanitizeRichText(comp.why)}`));
    if (comp.verdict) {
      lines.push(`    ${formatRichVerdict(comp.verdict, styler)}`);
    }
    const explainCmd = formatExplainCommand(
      result.path,
      comp.to,
      result.meta.settings,
      renderOpts.flagSettings,
      result.meta.head ? { head: result.meta.head.ref } : undefined,
    );
    lines.push(
      ...renderRichEvidence(comp, styler, {
        fullEvidence: renderOpts.fullEvidence,
        explainHint: explainCmd,
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
      const safeLine = sanitizeRichText(expandRichTabs(rawLine));
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
    ? `${result.shared} of ${result.fromChanges} commits ${formatRichIntervalCi(result.interval, true, caps.unicode)} (${pct(result.confidence)} ${wLabel})`
    : `${result.shared} of ${result.fromChanges} commits (${pct(result.confidence)}) ${formatRichIntervalCi(result.interval, false, caps.unicode)}`;
  const dirB = result.weighted
    ? `${result.shared} of ${result.toChanges} commits ${formatRichIntervalCi(result.reverseInterval, true, caps.unicode)} (${pct(result.reverseConfidence)} ${wLabel})`
    : `${result.shared} of ${result.toChanges} commits (${pct(result.reverseConfidence)}) ${formatRichIntervalCi(result.reverseInterval, false, caps.unicode)}`;
  const lastStr = result.lastTogether
    ? ` ${dot} last together ${timeAgo(Date.parse(result.lastTogether) / 1000)} (${sanitizeRichText(result.lastTogether)})`
    : '';

  const { headline, fullPathsLine } = formatHeadlinePair(result.from, result.to, biArrow, caps, styler);
  lines.push(`${styler.markerBadge(`F-01 ${dot} PAIR EVIDENCE`)} ${headline}`);
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
    if (result.shared > 0 && result.bounds.timedOut) {
      lines.push('No shared commit patches rendered (patch retrieval reached time budget).');
    } else {
      lines.push('No shared commits found between these two files in the analyzed history.');
    }
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

  if (
    result.bounds.commitsTruncated ||
    result.bounds.outputTruncated ||
    result.bounds.timedOut ||
    result.bounds.contextClamped
  ) {
    const notices: string[] = [];
    if (result.bounds.commitsTruncated) {
      notices.push(`showing up to ${result.bounds.maxCommits} shared commits`);
    }
    if (result.bounds.contextClamped) {
      notices.push(`context lines clamped to ${result.bounds.contextLines}`);
    }
    if (result.bounds.outputTruncated) {
      notices.push(`patch output capped at ${result.bounds.maxTotalPatchLines} lines`);
    }
    if (result.bounds.timedOut) {
      notices.push('patch retrieval reached time budget');
    }
    lines.push(styler.dim(`Bounds applied: ${notices.join('; ')}.`));
  }

  lines.push(styler.dim(result.disclaimer ?? EXPLAIN_DISCLAIMER));
  return `${lines.join('\n')}\n`;
}

export function printRichExplain(result: ExplainResult, renderOpts: RichRenderOptions = {}): void {
  stdout.write(formatRichExplain(result, renderOpts));
}
