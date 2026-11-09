import { DEFAULT_SETTINGS } from '../config.js';
import type { MapData } from '../commands/map.js';
import { RELATIONSHIPS, type Relationship } from '../imports/classify.js';
import type { WeightingMode } from '../model/cochange.js';
import { VERDICTS_FILE, type RelationshipVerdictView } from '../model/verdicts.js';
import { sanitizeHtmlDisplayText } from '../style/frame12.js';
import { wilsonInterval, type WilsonInterval } from '../util/stats.js';
import { getToolVersion } from './contract.js';
import { formatIntervalCi, roundInterval } from './views.js';

const WILSON_EXAMPLE_2_OF_2 = roundInterval(wilsonInterval(2, 2));
const WILSON_EXAMPLE_2_OF_2_CI = formatIntervalCi(WILSON_EXAMPLE_2_OF_2);
const WILSON_EXAMPLE_2_OF_2_LOW = Math.floor(WILSON_EXAMPLE_2_OF_2.low * 100 + 1e-9);

const WILSON_EXAMPLE_9_OF_10 = roundInterval(wilsonInterval(9, 10));
const WILSON_EXAMPLE_9_OF_10_CI = formatIntervalCi(WILSON_EXAMPLE_9_OF_10);
const WILSON_EXAMPLE_9_OF_10_LOW = Math.floor(WILSON_EXAMPLE_9_OF_10.low * 100 + 1e-9);

export type GlossaryTermId =
  | 'ghost-wire'
  | 'directional-cochange'
  | 'wilson-interval'
  | 'weighted-confidence'
  | 'file-family'
  | 'unchecked-link'
  | 'heuristic-import'
  | 'indirect-import'
  | 'direct-test-links'
  | 'counterexamples'
  | 'commit-origin'
  | 'verdicts';

export interface GlossaryEntry {
  id: GlossaryTermId;
  term: string;
  shortTitle: string;
  summary: string;
  detail: string;
  relatedRelationship?: Relationship;
}

export const GLOSSARY_TERMS: readonly GlossaryEntry[] = Object.freeze([
  {
    id: 'ghost-wire',
    term: 'Ghost wire (ghost)',
    shortTitle: 'GHOST WIRE · DEFINITION',
    summary:
      'A pair of files that repeatedly change in the same Git commits, where no direct or one-step-removed import link was detected in current code and the files could be checked.',
    detail: `Requires at least ${DEFAULT_SETTINGS.minShared} shared commits and ${Math.round(DEFAULT_SETTINGS.minConfidence * 100)}% directional co-change by default. A ghost wire is historical evidence to investigate, not automatic proof of a bug or runtime dependency. When both files in a ghost wire share a parallel sibling filename or reference the same rare environment variable, /api/... route, event name, or named export (used by at most 3 files), Repo Archaeology attaches a hiddenBridge clue to suggest why they might move together.`,
    relatedRelationship: 'ghost',
  },
  {
    id: 'directional-cochange',
    term: 'Directional co-change (A → B vs. B → A)',
    shortTitle: 'DIRECTIONAL CO-CHANGE % · ASYMMETRY',
    summary:
      'Co-change is asymmetric: A → B measures how often commits touching A also touched B (shared / changes(A)), while B → A divides by changes(B).',
    detail:
      'If a small adapter file changed 10 times and 8 of those commits also updated a core router that changed 200 times, Adapter → Router is 80% (8 of 10), whereas Router → Adapter is 4% (8 of 200). Always check which file is the denominator.',
  },
  {
    id: 'wilson-interval',
    term: '95% Wilson confidence range (raw 95% CI)',
    shortTitle: '95% WILSON CONFIDENCE RANGE',
    summary:
      'A sample-size-aware statistical interval computed from raw commit counts so small samples do not outrank well-supported findings.',
    detail: `A raw ratio of 2 of 2 (100%) has a wide interval ${WILSON_EXAMPLE_2_OF_2_CI} (lower bound ${WILSON_EXAMPLE_2_OF_2_LOW}%), whereas 9 of 10 (90%) has a tighter interval ${WILSON_EXAMPLE_9_OF_10_CI} (lower bound ${WILSON_EXAMPLE_9_OF_10_LOW}%). Repo Archaeology ranks findings and scales line widths by the conservative 95% Wilson lower bound (rounded outward so bounds never overstate certainty). Even when recency or origin weighting is enabled, the Wilson interval is always computed from unweighted raw commit counts.`,
  },
  {
    id: 'weighted-confidence',
    term: 'Weighted percentage (recency / origin weighting)',
    shortTitle: 'WEIGHTED VS. RAW CO-CHANGE %',
    summary:
      'When --half-life or --origin-weights is enabled, the headline percentage weights recent or human/agent commits more heavily than older or bot commits.',
    detail:
      'Because weighted percentages are no longer equal to the simple ratio shared / fromChanges, the report labels them explicitly (for example, "68% weighted (60% raw)") and keeps the unweighted raw commit counts and raw 95% Wilson interval visible alongside.',
  },
  {
    id: 'file-family',
    term: 'Finding family (3+ parallel files)',
    shortTitle: 'FINDING FAMILY · DEFINITION',
    summary:
      'A group of 3 or more sibling files sharing a filename stem across parallel directories (for example, src/adapter/*/serve-static.ts) with multiple qualifying pairwise links.',
    detail:
      'Instead of scattering N×(N−1)/2 separate cards across the report, Repo Archaeology groups parallel implementations into one family card showing how many commits touched 2+ members vs. all members together.',
  },
  {
    id: 'unchecked-link',
    term: 'Unchecked / unknown relationship (unknown)',
    shortTitle: 'UNCHECKED LINKS · DISPLAYED VS. TOTAL',
    summary:
      'Co-changing file pairs whose static import relationship could not be verified (non-JS/TS files, dynamic specifiers, or pairs beyond the classification cap).',
    detail:
      '"Unchecked" means static import status is unknown—not that an import link is absent. When top-link display caps omit lower-ranked unchecked pairs from the diagram, the report shows both the displayed count and the full repository total (for example, "15 SHOWN OF 56").',
    relatedRelationship: 'unknown',
  },
  {
    id: 'heuristic-import',
    term: 'Heuristic import link (heuristic: true)',
    shortTitle: 'HEURISTIC IMPORT RESOLUTION',
    summary:
      'An internal import edge marked with heuristic: true (while via stays relative, paths, workspace, exports, or imports) when the resolver maps build output directories (dist/, lib/, build/, out/) back to source files, or falls back to an in-repo package not declared in a workspace manifest.',
    detail:
      'Heuristic resolution prevents false-positive ghost wires in monorepos and unbuilt package layouts. The total count of heuristic edges is reported in meta.imports.heuristicEdges inside About this analysis.',
  },
  {
    id: 'indirect-import',
    term: 'Indirect import (one step removed)',
    shortTitle: 'INDIRECT IMPORTS · ONE STEP REMOVED',
    summary:
      'No direct import link connects the two files, but one file imports a file that imports the other (one step removed).',
    detail:
      'Indirect imports explain why two files move together through an intermediate module (for example, a.ts → helper.ts → b.ts). Because the dependency path is visible in current code one step removed, indirect imports are separated from ghost wires.',
    relatedRelationship: 'indirect',
  },
  {
    id: 'direct-test-links',
    term: 'Direct import (direct) & Test link (test)',
    shortTitle: 'DIRECT IMPORTS & TEST LINKS',
    summary:
      'Expected couplings where one file directly imports the other (or through a barrel file), or where a test file changes alongside the implementation it covers.',
    detail:
      'Direct and test relationships confirm that Git history aligns with static code structure. They provide structural context around ghost wires in the ego network and Atlas.',
    relatedRelationship: 'direct',
  },
  {
    id: 'counterexamples',
    term: 'Counterexample commits (Changed alone)',
    shortTitle: 'COUNTEREXAMPLE COMMITS',
    summary:
      'Analyzed commits where one file in a pair changed without the other (fromChanges − shared, or toChanges − shared).',
    detail:
      'Inspecting counterexamples helps prevent confirmation bias: if file A changed alone 8 times for local formatting or unrelated helpers, and changed with file B 12 times when updating public options, you can tell which kind of edit you are making now.',
  },
  {
    id: 'commit-origin',
    term: 'Commit origin shares (human, agent, bot)',
    shortTitle: 'COMMIT ORIGIN CLASSIFICATION',
    summary:
      'Breakdown of shared commits by author/trailer heuristics into human developers, AI coding agents, and automated bots (such as dependency updaters).',
    detail:
      'If a file pair only changes together in automated bot sweeps, it may be less actionable during manual code review than a pair repeatedly updated together by human engineers.',
  },
  {
    id: 'verdicts',
    term: 'Relationship verdicts (confirmed vs. expected / silenced)',
    shortTitle: 'RELATIONSHIP VERDICTS',
    summary: `Team annotations stored in ${VERDICTS_FILE} that mark a known coupling as "confirmed" (highlight in reviews) or "expected" (silenced by default unless --show-silenced is passed).`,
    detail:
      'Verdicts let teams record institutional knowledge directly in the repository so reviewed couplings are either surfaced with their documented reason or muted from default noise.',
  },
]);

export function getGlossaryEntry(id: GlossaryTermId): GlossaryEntry {
  const found = GLOSSARY_TERMS.find((entry) => entry.id === id);
  if (!found) {
    throw new Error(`Unknown glossary term id: ${id}`);
  }
  return found;
}

export interface ReadingFindingInput {
  fromLabel: string;
  toLabel: string;
  shared: number;
  fromChanges: number;
  toChanges: number;
  confidence: number;
  reverseConfidence: number;
  interval: WilsonInterval;
  reverseInterval: WilsonInterval;
  relationship: Relationship;
  why?: string;
  weighted?: boolean;
  weighting?: WeightingMode;
  verdict?: RelationshipVerdictView;
  isFamily?: boolean;
  familyMemberCount?: number;
  familyQualifyingPairs?: number;
  familyPossiblePairs?: number;
  topAuthor?: string;
  topAuthorShare?: number;
}

export interface ReadingFindingGuide {
  heading: string;
  summaryLine: string;
  whatItSaysLabel: string;
  whatItSays: string;
  whatItDoesNotSayLabel: string;
  whatItDoesNotSay: string;
  whatToInspectLabel: string;
  whatToInspect: string;
}

function floorPct(v: number): number {
  return Math.floor(v * 100 + 1e-9);
}

function ceilPct(v: number): number {
  return Math.ceil(v * 100 - 1e-9);
}

function resolveWeightingPhrase(weighted?: boolean, weighting?: WeightingMode): string {
  if (!weighted && (!weighting || weighting === 'none')) return '';
  if (weighting === 'origin') return 'origin-weighted';
  if (weighting === 'recency+origin') return 'recency+origin-weighted';
  return 'recency-weighted';
}

export function formatReadingFindingGuide(input: ReadingFindingInput): ReadingFindingGuide {
  const safeFrom = sanitizeHtmlDisplayText(input.fromLabel);
  const safeTo = sanitizeHtmlDisplayText(input.toLabel);
  const pctVal = floorPct(input.confidence);
  const revPctVal = floorPct(input.reverseConfidence);
  const rawPctVal = input.fromChanges > 0 ? floorPct(input.shared / input.fromChanges) : 0;
  const revRawPctVal = input.toChanges > 0 ? floorPct(input.shared / input.toChanges) : 0;
  const lowPct = floorPct(input.interval.low);
  const highPct = ceilPct(input.interval.high);
  const isWeighted = Boolean(input.weighted);
  const wPhrase = resolveWeightingPhrase(input.weighted, input.weighting);

  const familyPrefix =
    input.isFamily && input.familyMemberCount && input.familyMemberCount >= 3
      ? `Across this ${input.familyMemberCount}-file family (${input.familyQualifyingPairs ?? 0} of ${input.familyPossiblePairs ?? 0} pairs qualifying), the lead pair is ${safeFrom} → ${safeTo}. `
      : '';

  const whatItSaysLabel = isWeighted
    ? `What does ${pctVal}% weighted (${rawPctVal}% raw) mean?`
    : `What does ${pctVal}% mean?`;

  const whatItSays = isWeighted
    ? `${familyPrefix}With ${wPhrase} scoring active, ${safeFrom} → ${safeTo} scores ${pctVal}% weighted confidence across ${input.shared} of ${input.fromChanges} raw analyzed commits (${rawPctVal}% raw ratio; unweighted 95% Wilson range ${lowPct}–${highPct}%). In the reverse direction (${safeTo} → ${safeTo === safeFrom ? 'companion' : safeFrom}), the score is ${revPctVal}% weighted (${input.shared} of ${input.toChanges} raw commits, ${revRawPctVal}% raw).`
    : `${familyPrefix}Of the ${input.fromChanges} analyzed commits that changed ${safeFrom}, ${input.shared} also changed ${safeTo} (${pctVal}%, 95% Wilson confidence range ${lowPct}–${highPct}%). In the reverse direction (${safeTo} → ${safeFrom}), ${input.shared} of ${input.toChanges} commits moved together (${revPctVal}%).`;

  const whatItDoesNotSayLabel = `Does that mean ${safeTo} needs changing now?`;
  let relationshipExplanation: string;
  if (input.relationship === 'ghost') {
    relationshipExplanation = `This history does not establish a ${pctVal}% probability of a bug, a missing edit, or a runtime dependency. No direct or one-step-removed import link was detected between ${safeFrom} and ${safeTo} in current code, and the files could be checked—this is a historical signal to investigate, not proof that your current change requires updating ${safeTo}.`;
  } else if (input.relationship === 'unknown') {
    relationshipExplanation = `Static import analysis could not verify whether ${safeFrom} and ${safeTo} import each other (for example, non-JS/TS files, dynamic specifiers, or pairs beyond the import classification cap). "Unchecked" means import status is unknown—not that an import link is absent—and does not prove ${safeTo} needs an update now.`;
  } else if (input.relationship === 'indirect') {
    relationshipExplanation = `One file imports a file that imports the other (one step removed) in current code and they have moved together historically, but that still does not guarantee every edit to ${safeFrom} requires modifying ${safeTo}.`;
  } else if (input.relationship === 'test') {
    const cleanWhy = input.why ? sanitizeHtmlDisplayText(input.why) : '';
    if (cleanWhy === 'both are tests') {
      relationshipExplanation = `Both files are classified as tests (${cleanWhy}) and changed together in ${input.shared} of ${input.fromChanges} commits (${pctVal}%). That historical co-change does not prove every edit to ${safeFrom} requires updating ${safeTo}.`;
    } else {
      const whyNote = cleanWhy ? ` (${cleanWhy})` : '';
      relationshipExplanation = `Classified as a test relationship${whyNote} that changed together in ${input.shared} of ${input.fromChanges} commits (${pctVal}%). Isolated edits or internal refactors to ${safeFrom} do not automatically require updating ${safeTo}.`;
    }
  } else {
    relationshipExplanation = `These files have a direct import link in current code, but historical co-change still does not prove that every isolated edit to ${safeFrom} requires modifying ${safeTo}.`;
  }

  if (input.verdict) {
    const safeReason = sanitizeHtmlDisplayText(input.verdict.reason);
    const verdictTag =
      input.verdict.kind === 'confirmed'
        ? `Recorded verdict (confirmed dependency): "${safeReason}".`
        : `Recorded verdict (expected / silenced relationship): "${safeReason}".`;
    relationshipExplanation = `${relationshipExplanation} ${verdictTag}`;
  }

  if (input.topAuthor && input.topAuthorShare !== undefined && input.topAuthorShare >= 0.6) {
    const safeAuthor = sanitizeHtmlDisplayText(input.topAuthor);
    const authorPct = Math.round(input.topAuthorShare * 100);
    relationshipExplanation = `${relationshipExplanation} Most changes to ${safeFrom} were made by ${safeAuthor} (${authorPct}%), so this pattern may reflect one contributor's workflow habits rather than a strict code dependency.`;
  }

  const fromAlone = Math.max(0, input.fromChanges - input.shared);
  const toAlone = Math.max(0, input.toChanges - input.shared);
  const totalAlone = fromAlone + toAlone;
  const whatToInspectLabel = 'What should I inspect next?';
  const whatToInspect =
    totalAlone > 0
      ? `Review the ${input.shared} shared commit receipts below alongside the ${totalAlone} counterexample commit${totalAlone === 1 ? '' : 's'} where ${safeFrom} (${fromAlone}) or ${safeTo} (${toAlone}) changed alone. Check whether the historical co-changes resemble your current edit.`
      : `Review the ${input.shared} shared commit receipts below (neither file changed alone in the analyzed window) and run the CLI explain command to inspect the paired diff hunks.`;

  const summaryRate = isWeighted
    ? `${pctVal}% weighted (${input.shared}/${input.fromChanges} raw)`
    : `${pctVal}% (${input.shared}/${input.fromChanges} commits)`;

  return {
    heading: 'READING THIS FINDING · EXPLAIN THESE NUMBERS',
    summaryLine: `Reading this finding · ${summaryRate} is historical co-change, not proof — Explain these numbers`,
    whatItSaysLabel,
    whatItSays,
    whatItDoesNotSayLabel,
    whatItDoesNotSay: relationshipExplanation,
    whatToInspectLabel,
    whatToInspect,
  };
}

export interface AnalysisProvenanceItem {
  label: string;
  value: string;
}

export interface AnalysisProvenance {
  title: string;
  subtitle: string;
  items: AnalysisProvenanceItem[];
  warnings: string[];
  footerText: string;
  githubUrl: string;
}

/**
 * Strips common local/CI absolute filesystem paths from warning messages so shared HTML
 * reports avoid leaking the machine directory structure where the report was generated.
 */
export function redactFilesystemPaths(text: string): string {
  return sanitizeHtmlDisplayText(text).replace(
    /(?:\/(?:Users|home|var|private|tmp|opt|srv|etc|root|mnt|Volumes|workspaces?|builds|runner)\/|[A-Za-z]:\\)[^\s"'<>)+,;]+/g,
    '<repo-path>',
  );
}

export function buildAnalysisProvenance(data: MapData, toolVersion?: string): AnalysisProvenance {
  const version = toolVersion ?? getToolVersion();
  const m = data.meta;
  const s = m.settings ?? DEFAULT_SETTINGS;
  const commitsAnalyzed = m.commitsAnalyzed ?? 0;
  const commitsRead = m.commitsRead ?? commitsAnalyzed;
  const trackedFiles = m.files ?? data.nodes?.length ?? 0;
  const renamesFollowed = m.renamesFollowed ?? 0;
  const sweepsSkipped = m.sweepsSkipped ?? 0;
  const subjectSkipped = m.subjectSkipped ?? 0;
  const minShared = s.minShared ?? DEFAULT_SETTINGS.minShared;
  const minConfidence = s.minConfidence ?? DEFAULT_SETTINGS.minConfidence;
  const maxFilesPerCommit = s.maxFilesPerCommit ?? DEFAULT_SETTINGS.maxFilesPerCommit;
  const maxCommits = s.maxCommits ?? DEFAULT_SETTINGS.maxCommits;

  const revText = m.head
    ? `${sanitizeHtmlDisplayText(m.head.ref)} @ ${sanitizeHtmlDisplayText(m.head.sha.slice(0, 12))} (static imports checked at analyzed tree snapshot)`
    : 'Git history + current repository tree snapshot';

  const dateWindow =
    m.oldestCommit && m.newestCommit
      ? `${sanitizeHtmlDisplayText(m.oldestCommit)} to ${sanitizeHtmlDisplayText(m.newestCommit)}`
      : commitsAnalyzed > 0
        ? 'Single-date or undated commit window'
        : 'No commits in analyzed range';

  const commitCoverage = `${commitsAnalyzed.toLocaleString('en-US')} analyzed of ${commitsRead.toLocaleString('en-US')} commits read (${dateWindow}) across ${trackedFiles.toLocaleString('en-US')} tracked files (${renamesFollowed.toLocaleString('en-US')} rename${renamesFollowed === 1 ? '' : 's'} followed)`;

  const skippedParts: string[] = [];
  if (sweepsSkipped > 0) {
    skippedParts.push(`${sweepsSkipped.toLocaleString('en-US')} large sweep${sweepsSkipped === 1 ? '' : 's'} > ${maxFilesPerCommit} files skipped`);
  }
  if (subjectSkipped > 0) {
    skippedParts.push(`${subjectSkipped.toLocaleString('en-US')} skipped by commit-subject filter`);
  }
  const skippedSuffix = skippedParts.length > 0 ? ` (${skippedParts.join('; ')})` : '';

  const thresholdsText = `Min shared commits: ${minShared} · Min directional confidence: ${Math.round(minConfidence * 100)}% · Max files per commit: ${maxFilesPerCommit} · Max commits: ${maxCommits.toLocaleString('en-US')}${s.since ? ` · Since: ${sanitizeHtmlDisplayText(s.since)}` : ''}${skippedSuffix}`;

  const hasOriginWeights = Boolean(s.origin?.weights && Object.keys(s.origin.weights).length > 0);
  let weightingText = 'Unweighted raw commit counts (ranked by 95% Wilson score lower bound)';
  if (s.halfLifeDays && hasOriginWeights) {
    weightingText = `Recency half-life (${s.halfLifeDays} days) + commit-origin weights active. Headline percentages are weighted; 95% Wilson intervals remain unweighted raw commit counts.`;
  } else if (s.halfLifeDays) {
    weightingText = `Recency half-life: ${s.halfLifeDays} days. Headline percentages weight recent commits higher; 95% Wilson intervals remain unweighted raw commit counts.`;
  } else if (hasOriginWeights) {
    weightingText = 'Commit-origin weights active. Headline percentages weight origins differently; 95% Wilson intervals remain unweighted raw commit counts.';
  }

  const totalQualifying = RELATIONSHIPS.reduce((acc, rel) => acc + (data.counts?.[rel] ?? 0), 0);
  const drawnCount = data.edges.length;
  const uncheckedDrawn = data.edges.filter((e) => e.relationship === 'unknown').length;
  const uncheckedTotal = Math.max(uncheckedDrawn, data.counts?.unknown ?? uncheckedDrawn);
  const scopeText = `${drawnCount.toLocaleString('en-US')} relationship${drawnCount === 1 ? '' : 's'} drawn in report of ${totalQualifying.toLocaleString('en-US')} qualifying (${uncheckedDrawn} of ${uncheckedTotal} unchecked links shown)${data.classificationTruncated ? ' · Import classification cap reached (excess pairs marked Unchecked)' : ''}`;

  let importsText = 'Static import & reference graph compared against historical co-change pairs';
  if (m.imports) {
    const imp = m.imports;
    importsText = `${imp.filesScanned.toLocaleString('en-US')} source files scanned (${imp.unsupportedFiles} non-JS/TS, ${imp.sourceUnavailable} unavailable) · ${imp.internalEdges.toLocaleString('en-US')} internal edges resolved (${imp.heuristicEdges} heuristic) · ${imp.unresolved.toLocaleString('en-US')} unresolved specifier${imp.unresolved === 1 ? '' : 's'} · ${imp.dynamicLoads.toLocaleString('en-US')} dynamic load${imp.dynamicLoads === 1 ? '' : 's'}`;
  }

  const originParts: string[] = [];
  if (m.origins) {
    const totalO = m.origins.human + m.origins.agent + m.origins.bot;
    if (totalO > 0) {
      originParts.push(
        `Origins: ${m.origins.human.toLocaleString('en-US')} human, ${m.origins.agent.toLocaleString('en-US')} agent, ${m.origins.bot.toLocaleString('en-US')} bot`,
      );
    }
  }
  const silencedCount = data.verdicts?.silenced ?? 0;
  if (m.verdicts && (m.verdicts.loaded > 0 || silencedCount > 0)) {
    originParts.push(
      `Verdicts (${VERDICTS_FILE}): ${m.verdicts.active} active, ${m.verdicts.expired} expired, ${silencedCount} silenced`,
    );
  } else {
    originParts.push(`Verdicts: none configured (${VERDICTS_FILE})`);
  }

  const items: AnalysisProvenanceItem[] = [
    { label: 'Analyzed revision', value: revText },
    { label: 'History coverage', value: commitCoverage },
    { label: 'Thresholds & filters', value: thresholdsText },
    { label: 'Scoring & weighting', value: weightingText },
    { label: 'Report edge budget', value: scopeText },
    { label: 'Import resolution', value: importsText },
    { label: 'Origins & verdicts', value: originParts.join(' · ') },
  ];

  const warnings = (m.warnings ?? []).map((w) => redactFilesystemPaths(w));
  if (m.commitsAnalyzed === 0) {
    warnings.push('No commits matched the analysis window; coverage is incomplete.');
  }

  return {
    title: 'ABOUT THIS ANALYSIS · METHODOLOGY & PROVENANCE',
    subtitle:
      'Recorded settings, history window, and static import coverage for this standalone HTML report (local filesystem paths are omitted for safe sharing).',
    items,
    warnings,
    footerText: `Generated by Repo Archaeology v${version} — An open-source developer tool for investigating hidden relationships in Git history. Historical signal, not proof.`,
    githubUrl: 'https://github.com/lbrodie11/repo-archaeology',
  };
}
