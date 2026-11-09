import { posix } from 'node:path';
import { formatExplainCommand } from '../commands/explain.js';
import type {
  MapCounterexample,
  MapData,
  MapEdge,
  MapEdgeEvidence,
  MapFamily,
  MapNode,
} from '../commands/map.js';
import type { Relationship } from '../imports/classify.js';
import type { OriginShare } from '../model/origin.js';
import { formatReadingFindingGuide, type ReadingFindingGuide } from '../report/glossary.js';
import type { RelationshipVerdictView } from '../report/views.js';
import { sanitizeHtmlDisplayText } from '../style/frame12.js';
import type { WilsonInterval } from '../util/stats.js';

export const KICKER_MOST_INTERESTING = 'F-01 · MOST INTERESTING FINDING';
export const STATUS_CHIP_EVIDENCE = 'EVIDENCE · NOT PROOF';
export const HOW_TO_READ_SUMMARY = 'How to read this map ▸';
export const HOW_TO_READ_BODY =
  'Files are nodes colored by directory and sized by commit count on a cyanotype survey plate. Pink dashed ghost wires connect files that repeatedly change together in git history with no direct or 2-hop import link detected in current code. Percentage ranges show the two-sided 95% Wilson score confidence interval from raw historical counts; ranking uses the 95% Wilson lower bound with recency and commit-origin weights when configured.';

export interface StrongerDirectionView {
  /** True when `edge.source -> edge.target` is the stronger (or tied) direction; false when reversed. */
  forward: boolean;
  fromNodeIndex: number;
  toNodeIndex: number;
  fromNode: MapNode;
  toNode: MapNode;
  fromPath: string;
  toPath: string;
  shortFrom: string;
  shortTo: string;
  shared: number;
  fromChanges: number;
  toChanges: number;
  confidence: number;
  reverseConfidence: number;
  interval: WilsonInterval;
  reverseInterval: WilsonInterval;
  fromOnlyTotal: number;
  toOnlyTotal: number;
  fromOnly: MapCounterexample[];
  toOnly: MapCounterexample[];
}

export interface DirectionMetricCopy {
  fromLabel: string;
  toLabel: string;
  pctText: string;
  lowerBoundText: string;
  ratioHeadline: string;
  detailText: string;
  pctValue: number;
  rawPctValue: number;
  weighted: boolean;
  shared: number;
  totalChanges: number;
  rangeLowPct: number;
  rangeHighPct: number;
}

export interface PairHeadlineCopy {
  headline: string;
  subhead: string;
  a: string;
  b: string;
  fromPath: string;
  toPath: string;
  shared: number;
  fromChanges: number;
  relationship: Relationship;
  weighted: boolean;
}

export interface FamilyHeadlineCopy {
  headline: string;
  subhead: string;
  memberCount: number;
  dirsPattern: string;
  fileName: string;
  commitsTouchingTwoOrMore: number;
  commitsTouchingAll: number;
  qualifyingPairs: number;
  possiblePairs: number;
}

export interface EmptyStateCopy {
  headline: string;
  subhead: string;
  contextNote: string | null;
  repoName: string;
  commits: number;
  minShared: number;
  minConfidencePct: number;
  looserCommand: string;
}

export interface FamilyPairRowCopy {
  edgeIndex: number;
  fromPath: string;
  toPath: string;
  shortFrom: string;
  shortTo: string;
  shared: number;
  fromChanges: number;
  toChanges: number;
  pctText: string;
  lowerBoundText: string;
  rangeText: string;
  rangeLowPct: number;
  rangeHighPct: number;
  relationship: Relationship;
  isLeadPair: boolean;
}

export interface EvidencePanelCopy {
  kicker: string;
  statusChip: string;
  headline: string;
  subhead: string;
  primaryDirection: DirectionMetricCopy;
  reverseDirection: DirectionMetricCopy;
  asymmetrySummary: string;
  lastTogetherText: string;
  lastTogetherDate: string;
  counterexamplesSummary: string;
  reverseCounterexamplesSummary: string;
  fromOnlyTotal: number;
  toOnlyTotal: number;
  fromOnly: MapCounterexample[];
  toOnly: MapCounterexample[];
  receiptsShown: MapEdgeEvidence[];
  receiptsTotal: number;
  receiptsOverflowCount: number;
  ownerNotes: string[];
  originShareNote: string | null;
  verdictNote: string | null;
  explainCommand: string;
  howToReadSummary: string;
  howToReadBody: string;
  readingGuide?: ReadingFindingGuide;
  familySummary?: {
    label: string;
    members: { path: string; variant: string; changes: number }[];
    commitsTouchingTwoOrMore: number;
    commitsTouchingAll: number;
    qualifyingPairs: number;
    possiblePairs: number;
    pairs: FamilyPairRowCopy[];
  };
}

export type FeaturedFinding =
  | {
      kind: 'family';
      familyIndex: number;
      family: MapFamily;
      leadEdgeIndex: number;
      leadEdge: MapEdge;
    }
  | {
      kind: 'pair';
      edgeIndex: number;
      edge: MapEdge;
    }
  | {
      kind: 'empty';
      contextClusterNodeIndices: number[];
      contextClusterEdgeIndices: number[];
    };

export interface RankedFindingItem {
  id: string;
  findingId: string;
  cutLabel: string;
  kind: 'family' | 'pair';
  relationship: Relationship;
  title: string;
  subtitle: string;
  reverseSummary: string;
  counterexampleLine: string;
  reverseCounterexampleLine: string;
  fromPath: string;
  toPath: string;
  shortFrom: string;
  shortTo: string;
  shared: number;
  totalChanges: number;
  fromOnlyTotal: number;
  toOnlyTotal: number;
  ratioText: string;
  confidence: number;
  weighted: boolean;
  rawPct: number;
  interval: WilsonInterval;
  rangeLowPct: number;
  rangeHighPct: number;
  pointPct: number;
  lastTogether: string;
  overviewPriority: number;
  score: number;
  weak: boolean;
  edgeIndex: number;
  familyIndex?: number;
  relationshipKinds?: Relationship[];
  edgeIndices?: number[];
}

/**
 * Middle-truncates a repository path with `…` so it fits within `maxChars` while
 * preserving the leading directory context and the filename at the end.
 */
export function middleTruncatePath(rawPath: string, maxChars = 32): string {
  const clean = sanitizeHtmlDisplayText(rawPath);
  const limit = Math.max(8, Math.floor(maxChars));
  if (clean.length <= limit) return clean;

  const slashIdx = clean.lastIndexOf('/');
  if (slashIdx <= 0) {
    const headLen = Math.max(3, Math.ceil((limit - 1) * 0.5));
    const tailLen = Math.max(3, limit - 1 - headLen);
    return `${clean.slice(0, headLen)}…${clean.slice(clean.length - tailLen)}`;
  }

  const base = clean.slice(slashIdx + 1);
  const dir = clean.slice(0, slashIdx);

  // If the filename alone is nearly as long as the limit, keep the first folder initial + middle-truncated filename
  if (base.length + 3 >= limit) {
    const headLen = Math.max(3, Math.floor((limit - 1) * 0.45));
    const tailLen = Math.max(3, limit - 1 - headLen);
    return `${clean.slice(0, headLen)}…${clean.slice(clean.length - tailLen)}`;
  }

  const remainingForDir = limit - base.length - 2; // space for "…/"
  if (remainingForDir <= 1) {
    return `…/${base}`;
  }
  return `${dir.slice(0, remainingForDir)}…/${base}`;
}

/**
 * Returns concise, unambiguous display names for a pair of repository paths.
 * When the two files have distinct basenames (`tiny.ts` vs `quick.ts`), returns
 * their basenames. When their basenames collide (`src/adapter/bun/serve-static.ts`
 * vs `src/adapter/deno/serve-static.ts`), includes the contiguous suffix from the
 * differentiating folder segment (`bun/serve-static.ts` vs `deno/serve-static.ts`,
 * or `a/src/index.ts` vs `b/src/index.ts`).
 */
export function disambiguatePairPaths(rawPathA: string, rawPathB: string): [string, string] {
  const pathA = sanitizeHtmlDisplayText(rawPathA);
  const pathB = sanitizeHtmlDisplayText(rawPathB);
  if (pathA === pathB) {
    return [posix.basename(pathA) || pathA, posix.basename(pathB) || pathB];
  }

  const partsA = pathA.split('/').filter(Boolean);
  const partsB = pathB.split('/').filter(Boolean);
  const baseA = partsA[partsA.length - 1] ?? pathA;
  const baseB = partsB[partsB.length - 1] ?? pathB;

  if (baseA !== baseB) {
    return [baseA, baseB];
  }

  // Walk backwards from parent directory until segments differ and keep the contiguous suffix
  let offset = 2;
  const maxDepth = Math.max(partsA.length, partsB.length);
  while (offset <= maxDepth) {
    const segA = partsA[partsA.length - offset];
    const segB = partsB[partsB.length - offset];
    if (segA !== segB) {
      const labelA =
        partsA.length >= offset ? partsA.slice(partsA.length - offset).join('/') : pathA;
      const labelB =
        partsB.length >= offset ? partsB.slice(partsB.length - offset).join('/') : pathB;
      return [labelA, labelB];
    }
    offset++;
  }

  return [pathA, pathB];
}

/**
 * Resolves the stronger directional orientation for a `MapEdge`.
 */
export function resolveStrongerDirection(data: MapData, edge: MapEdge): StrongerDirectionView {
  const sourceNode: MapNode = data.nodes[edge.source] ?? {
    path: `file-${edge.source}`,
    dir: '.',
    changes: edge.fromChanges,
  };
  const targetNode: MapNode = data.nodes[edge.target] ?? {
    path: `file-${edge.target}`,
    dir: '.',
    changes: edge.toChanges,
  };

  const forward =
    edge.confidence > edge.reverseConfidence ||
    (edge.confidence === edge.reverseConfidence &&
      edge.interval.low >= edge.reverseInterval.low);

  const fromNodeIndex = forward ? edge.source : edge.target;
  const toNodeIndex = forward ? edge.target : edge.source;
  const fromNode = forward ? sourceNode : targetNode;
  const toNode = forward ? targetNode : sourceNode;
  const fromPath = sanitizeHtmlDisplayText(fromNode.path);
  const toPath = sanitizeHtmlDisplayText(toNode.path);
  const [shortFrom, shortTo] = disambiguatePairPaths(fromNode.path, toNode.path);

  const fromChanges = forward ? edge.fromChanges : edge.toChanges;
  const toChanges = forward ? edge.toChanges : edge.fromChanges;
  const confidence = forward ? edge.confidence : edge.reverseConfidence;
  const reverseConfidence = forward ? edge.reverseConfidence : edge.confidence;
  const interval = forward ? edge.interval : edge.reverseInterval;
  const reverseInterval = forward ? edge.reverseInterval : edge.interval;

  const rawFromOnly = edge.counterexamples?.fromOnly ?? [];
  const rawToOnly = edge.counterexamples?.toOnly ?? [];
  const rawFromTotal = edge.counterexamples?.fromOnlyTotal ?? Math.max(0, edge.fromChanges - edge.shared);
  const rawToTotal = edge.counterexamples?.toOnlyTotal ?? Math.max(0, edge.toChanges - edge.shared);

  return {
    forward,
    fromNodeIndex,
    toNodeIndex,
    fromNode,
    toNode,
    fromPath,
    toPath,
    shortFrom,
    shortTo,
    shared: edge.shared,
    fromChanges,
    toChanges,
    confidence,
    reverseConfidence,
    interval,
    reverseInterval,
    fromOnlyTotal: forward ? rawFromTotal : rawToTotal,
    toOnlyTotal: forward ? rawToTotal : rawFromTotal,
    fromOnly: forward ? rawFromOnly : rawToOnly,
    toOnly: forward ? rawToOnly : rawFromOnly,
  };
}

function relationshipLeadSentence(relationship: Relationship): string {
  switch (relationship) {
    case 'ghost':
      return 'No direct or 2-hop import link was detected.';
    case 'unknown':
      return "We couldn't check imports for these files.";
    case 'indirect':
      return 'Only an indirect import chain connects them.';
    case 'direct':
      return 'A direct import connects them in current code.';
    case 'test':
      return 'One file tests the other.';
  }
}

/**
 * Formats the deterministic headline and subhead for a two-file relationship.
 *
 * - Headline: `{a} and {b} keep changing together`
 * - Subhead (ghost): `No direct or 2-hop import link was detected. {shared} of {fromChanges} commits that changed {a} also changed {b}.`
 * - Subhead (unknown): `We couldn't check imports for these files. {shared} of {fromChanges} commits that changed {a} also changed {b}.`
 */
export function formatPairHeadline(data: MapData, edge: MapEdge): PairHeadlineCopy {
  const dir = resolveStrongerDirection(data, edge);
  const a = dir.shortFrom;
  const b = dir.shortTo;
  const headline = `${a} and ${b} keep changing together`;
  const firstSentence = relationshipLeadSentence(edge.relationship);
  const commitNoun = dir.fromChanges === 1 ? 'commit' : 'commits';
  const weighted = Boolean(edge.weighted);
  const rawPct = dir.fromChanges > 0 ? Math.round((dir.shared / dir.fromChanges) * 100) : 0;
  const weightedPct = Math.round(dir.confidence * 100);
  const secondSentence = weighted
    ? `${dir.shared} of ${dir.fromChanges} ${commitNoun} that changed ${a} also changed ${b} (${weightedPct}% weighted; ${rawPct}% raw).`
    : `${dir.shared} of ${dir.fromChanges} ${commitNoun} that changed ${a} also changed ${b}.`;
  return {
    headline,
    subhead: `${firstSentence} ${secondSentence}`,
    a,
    b,
    fromPath: dir.fromPath,
    toPath: dir.toPath,
    shared: dir.shared,
    fromChanges: dir.fromChanges,
    relationship: edge.relationship,
    weighted,
  };
}

/**
 * Formats the deterministic headline and subhead for a Finding Family (`MapFamily`).
 *
 * - Headline: `{n} files across {dirs} keep changing together`
 * - Subhead: derived strictly from `MapFamily` counts.
 */
export function formatFamilyHeadline(family: MapFamily): FamilyHeadlineCopy {
  const memberCount = family.members.length;
  const fileNoun = memberCount === 1 ? 'file' : 'files';
  const cleanParent = sanitizeHtmlDisplayText(family.parentDir || '.');
  const dirsPattern = cleanParent === '.' || cleanParent === '' ? '*' : `${cleanParent}/*`;
  const rawFileName =
    family.fileName ||
    (family as { stem?: string }).stem ||
    posix.basename(family.members[0]?.path ?? family.label ?? 'file');
  const cleanFileName = sanitizeHtmlDisplayText(rawFileName);
  const isSameDirSuffix = cleanFileName.startsWith('*-');
  const suffixLabel = isSameDirSuffix
    ? cleanFileName.slice(1).replace(/\.[^.]+$/, '')
    : cleanFileName;
  const parentLabel = cleanParent === '.' || cleanParent === '' ? 'root' : cleanParent;

  const headline = isSameDirSuffix
    ? `${memberCount} ${fileNoun} sharing the ${suffixLabel} suffix in ${parentLabel} keep changing together`
    : `${memberCount} ${fileNoun} across ${dirsPattern} keep changing together`;

  const relKinds = Array.isArray(family.relationshipKinds) ? family.relationshipKinds : [];
  const hasGhost = relKinds.includes('ghost');
  const hasUnknownOnly =
    !hasGhost && relKinds.length > 0 && relKinds.every((k) => k === 'unknown');

  const groupPhrase = isSameDirSuffix
    ? `${memberCount} ${fileNoun} sharing the ${suffixLabel} suffix (${cleanFileName})`
    : `${memberCount} parallel implementations of ${cleanFileName}`;

  const firstSentence = hasGhost
    ? `No direct or 2-hop import link was detected between these ${groupPhrase}.`
    : hasUnknownOnly
      ? `We couldn't check imports for these ${groupPhrase}.`
      : isSameDirSuffix
        ? `These ${groupPhrase} move together in ${parentLabel}.`
        : `These ${groupPhrase} move together across sibling folders.`;

  const commitNoun = family.commitsTouchingTwoOrMore === 1 ? 'commit' : 'commits';
  const pairClause =
    family.complete || family.qualifyingPairs === family.possiblePairs
      ? `All ${family.possiblePairs} pairwise links passed thresholds across ${family.commitsTouchingTwoOrMore} supporting ${commitNoun} (${family.commitsTouchingAll} touched all ${memberCount}).`
      : `${family.qualifyingPairs} of ${family.possiblePairs} pairwise links passed thresholds across ${family.commitsTouchingTwoOrMore} supporting ${commitNoun} (${family.commitsTouchingAll} touched all ${memberCount}).`;

  return {
    headline,
    subhead: `${firstSentence} ${pairClause}`,
    memberCount,
    dirsPattern,
    fileName: cleanFileName,
    commitsTouchingTwoOrMore: family.commitsTouchingTwoOrMore,
    commitsTouchingAll: family.commitsTouchingAll,
    qualifyingPairs: family.qualifyingPairs,
    possiblePairs: family.possiblePairs,
  };
}

/**
 * Formats a single directional co-change metric:
 * `{pct}%` + `{shared} of {n} commits · ≥{lo}% CI (95% range {lo}–{hi}%)`.
 */
export function formatDirectionMetric(
  fromLabel: string,
  toLabel: string,
  shared: number,
  totalChanges: number,
  confidence: number,
  interval: WilsonInterval,
  weighted = false,
): DirectionMetricCopy {
  const pctValue = Math.round(confidence * 100);
  const rawPctValue = totalChanges > 0 ? Math.round((shared / totalChanges) * 100) : 0;
  const rangeLowPct = Math.round(interval.low * 100);
  const rangeHighPct = Math.round(interval.high * 100);
  const commitNoun = totalChanges === 1 ? 'commit' : 'commits';
  const pctText = weighted ? `${pctValue}% weighted` : `${pctValue}%`;
  const detailText = weighted
    ? `Raw ${shared} of ${totalChanges} ${commitNoun} (${rawPctValue}%) · raw 95% range ${rangeLowPct}–${rangeHighPct}%`
    : `${shared} of ${totalChanges} ${commitNoun} · 95% range ${rangeLowPct}–${rangeHighPct}%`;
  return {
    fromLabel,
    toLabel,
    pctText,
    lowerBoundText: `≥${rangeLowPct}% CI`,
    ratioHeadline: `${shared}/${totalChanges} ${commitNoun}`,
    detailText,
    pctValue,
    rawPctValue,
    weighted,
    shared,
    totalChanges,
    rangeLowPct,
    rangeHighPct,
  };
}

/**
 * Formats a plain-English 1-sentence comparison of the two directional co-change counts
 * so first-time readers do not misread a small-sample `100%` rate as symmetrical proof.
 */
export function formatAsymmetrySummary(
  fromLabel: string,
  toLabel: string,
  shared: number,
  fromChanges: number,
  toChanges: number,
): string {
  const safeFrom = sanitizeHtmlDisplayText(fromLabel);
  const safeTo = sanitizeHtmlDisplayText(toLabel);
  if (shared === fromChanges && shared < toChanges) {
    return `Every observed change to ${safeFrom} (${shared} of ${fromChanges}) also changed ${safeTo}, whereas only ${shared} of ${toChanges} changes to ${safeTo} involved ${safeFrom}.`;
  }
  if (shared === fromChanges && shared === toChanges) {
    return `Every observed change to ${safeFrom} (${shared} of ${fromChanges}) and ${safeTo} (${shared} of ${toChanges}) happened together in the analyzed window.`;
  }
  return `${shared} of ${fromChanges} changes to ${safeFrom} also changed ${safeTo}, compared with ${shared} of ${toChanges} changes to ${safeTo} that involved ${safeFrom}.`;
}

/**
 * Formats the speech-balloon callout pointing at the featured relationship's midpoint on the plate:
 * e.g. `12 of 20 commits together · no import detected`.
 */
export function formatBalloonCallout(data: MapData, edge: MapEdge): string {
  const dir = resolveStrongerDirection(data, edge);
  const commitNoun = dir.fromChanges === 1 ? 'commit' : 'commits';
  const kindPhrase =
    edge.relationship === 'ghost'
      ? 'no import detected'
      : edge.relationship === 'unknown'
        ? 'imports unchecked'
        : edge.relationship === 'indirect'
          ? 'indirect import'
          : edge.relationship === 'direct'
            ? 'direct import'
            : 'test link';
  return `${dir.shared} of ${dir.fromChanges} ${commitNoun} together · ${kindPhrase}`;
}

/**
 * Formats counterexample summary text: `Changed alone: {n} time(s)`.
 */
export function formatCounterexamplesLine(aloneCount: number): string {
  const noun = aloneCount === 1 ? 'time' : 'times';
  return `Changed alone: ${aloneCount} ${noun}`;
}

/**
 * Formats the contributor ownership note when `topAuthorShare >= 0.4`.
 */
export function formatOwnerNote(
  node: Pick<MapNode, 'path' | 'topAuthor' | 'topAuthorShare'>,
  shortLabel?: string,
): string | null {
  if (!node.topAuthor || typeof node.topAuthorShare !== 'number' || node.topAuthorShare < 0.4) {
    return null;
  }
  const author = sanitizeHtmlDisplayText(node.topAuthor);
  const pct = Math.round(node.topAuthorShare * 100);
  const label = shortLabel ?? (posix.basename(sanitizeHtmlDisplayText(node.path)) || sanitizeHtmlDisplayText(node.path));
  return `Top historical contributor: ${author} (${pct}% of ${label} commits)`;
}

/**
 * Formats the commit origin share note when `originShare` is present.
 */
export function formatOriginShareNote(originShare?: OriginShare): string | null {
  if (!originShare) return null;
  const humanPct = Math.round(originShare.human * 100);
  const agentPct = Math.round(originShare.agent * 100);
  const botPct = Math.round(originShare.bot * 100);
  if (agentPct === 0 && botPct === 0) {
    return `Commit origin: ${humanPct}% human (0% agent or bot)`;
  }
  const parts: string[] = [];
  if (agentPct > 0) parts.push(`${agentPct}% agent`);
  if (botPct > 0) parts.push(`${botPct}% bot`);
  if (humanPct > 0) parts.push(`${humanPct}% human`);
  return `Commit origin: ${parts.join(', ')}`;
}

/**
 * Formats the verdict annotation when `verdict` is present on an edge.
 */
export function formatVerdictNote(verdict?: RelationshipVerdictView): string | null {
  if (!verdict) return null;
  const prefix = verdict.kind === 'confirmed' ? 'Confirmed dependency' : 'Expected relationship';
  return `${prefix}: ${sanitizeHtmlDisplayText(verdict.reason)}`;
}

/**
 * Builds a dynamic empty-state CLI command that lowers `minShared` and/or `minConfidence`
 * relative to the current run settings, omitting any threshold already at its floor.
 */
export function formatLooserThresholdCommand(
  settings?: { minShared?: number; minConfidence?: number },
  style: 'classic' | 'rich' = 'rich',
): string {
  const curShared = typeof settings?.minShared === 'number' ? settings.minShared : 3;
  const curConf = typeof settings?.minConfidence === 'number' ? settings.minConfidence : 0.4;
  const args: string[] = ['npx repo-archaeology map'];
  if (style === 'rich') args.push('--style rich');
  if (curShared > 1) {
    args.push(`--min-shared ${Math.max(1, curShared - 1)}`);
  }
  if (curConf > 0.05) {
    const nextConf = Math.max(0.05, Math.round(curConf * 50) / 100);
    args.push(`--min-confidence ${nextConf}`);
  }
  return args.join(' ');
}

/**
 * Formats the first-class empty state copy when a repository has no ghost wires (and no surprising links).
 */
export function formatEmptyStateCopy(
  data: MapData,
  contextCluster?: { nodeCount: number; edgeCount: number },
): EmptyStateCopy {
  const repoName = sanitizeHtmlDisplayText(data.repoName);
  const commits = data.meta.commitsAnalyzed;
  const minShared = data.meta.settings.minShared;
  const minConfidencePct = Math.round(data.meta.settings.minConfidence * 100);
  const commitNoun = commits === 1 ? 'commit' : 'commits';
  const sharedNoun = minShared === 1 ? 'commit' : 'commits';
  const looserCommand = formatLooserThresholdCommand(data.meta.settings, 'rich');

  const headline = `No ghost wires in ${repoName}`;
  const subhead = `Checked ${commits.toLocaleString('en-US')} ${commitNoun} at ≥${minShared} shared ${sharedNoun} and ≥${minConfidencePct}% confidence.`;

  let contextNote: string | null;
  if (contextCluster && contextCluster.edgeCount > 0) {
    const fileNoun = contextCluster.nodeCount === 1 ? 'file' : 'files';
    const linkNoun = contextCluster.edgeCount === 1 ? 'import link' : 'import links';
    contextNote = `Showing the strongest import cluster (${contextCluster.nodeCount} ${fileNoun}, ${contextCluster.edgeCount} ${linkNoun}) on the plate for repository context.`;
  } else {
    contextNote = null;
  }

  return {
    headline,
    subhead,
    contextNote,
    repoName,
    commits,
    minShared,
    minConfidencePct,
    looserCommand,
  };
}

/**
 * Assembles the complete Evidence Panel copy for a featured finding (family or pair).
 */
export function formatEvidencePanelCopy(
  data: MapData,
  featured: Exclude<FeaturedFinding, { kind: 'empty' }>,
  findingId = 'F-01',
): EvidencePanelCopy {
  const edge = featured.kind === 'family' ? featured.leadEdge : featured.edge;
  const dir = resolveStrongerDirection(data, edge);
  const isWeighted = Boolean(edge.weighted);

  const headlineInfo =
    featured.kind === 'family'
      ? formatFamilyHeadline(featured.family)
      : formatPairHeadline(data, edge);

  const primaryDirection = formatDirectionMetric(
    dir.shortFrom,
    dir.shortTo,
    dir.shared,
    dir.fromChanges,
    dir.confidence,
    dir.interval,
    isWeighted,
  );
  const reverseDirection = formatDirectionMetric(
    dir.shortTo,
    dir.shortFrom,
    dir.shared,
    dir.toChanges,
    dir.reverseConfidence,
    dir.reverseInterval,
    isWeighted,
  );

  const lastTogetherDate = sanitizeHtmlDisplayText(
    featured.kind === 'family' ? featured.family.lastTogether : edge.lastTogether,
  );
  const lastTogetherText = `Last together ${lastTogetherDate}`;

  const counterexamplesSummary = formatCounterexamplesLine(dir.fromOnlyTotal);
  const reverseCounterexamplesSummary = formatCounterexamplesLine(dir.toOnlyTotal);

  const allReceipts: MapEdgeEvidence[] =
    featured.kind === 'family' && featured.family.evidence.length > 0
      ? featured.family.evidence.map((ev) => ({
          hash: ev.hash,
          date: ev.date,
          subject: ev.subject,
          origin: ev.origin,
        }))
      : edge.evidence;

  const receiptsShown = allReceipts.slice(0, 3);
  const receiptsTotal =
    featured.kind === 'family'
      ? Math.max(allReceipts.length, featured.family.commitsTouchingTwoOrMore)
      : Math.max(allReceipts.length, dir.shared);
  const receiptsOverflowCount = Math.max(0, receiptsTotal - receiptsShown.length);

  const ownerNotes: string[] = [];
  if (featured.kind === 'family') {
    for (const ni of featured.family.nodeIndices) {
      const node = data.nodes[ni];
      if (!node) continue;
      const member = featured.family.members.find((m) => m.path === node.path);
      const shortLabel = member
        ? featured.family.stem.startsWith('*-')
          ? member.path.slice(member.path.lastIndexOf('/') + 1)
          : `${member.variant}/${featured.family.fileName}`
        : undefined;
      const note = formatOwnerNote(node, shortLabel);
      if (note && !ownerNotes.includes(note)) ownerNotes.push(note);
    }
  } else {
    const noteA = formatOwnerNote(dir.fromNode, dir.shortFrom);
    const noteB = formatOwnerNote(dir.toNode, dir.shortTo);
    if (noteA) ownerNotes.push(noteA);
    if (noteB && noteB !== noteA) ownerNotes.push(noteB);
  }

  const originShareNote = formatOriginShareNote(edge.originShare);
  const verdictNote = formatVerdictNote(edge.verdict);
  const explainCommand =
    edge.explainCommand ?? formatExplainCommand(dir.fromNode.path, dir.toNode.path);

  const familyPairs: FamilyPairRowCopy[] =
    featured.kind === 'family'
      ? featured.family.edgeIndices
          .map((ei) => {
            const pe = data.edges[ei];
            if (!pe) return null;
            const pDir = resolveStrongerDirection(data, pe);
            const lo = Math.round(pDir.interval.low * 100);
            const hi = Math.round(pDir.interval.high * 100);
            const pPct = Math.round(pDir.confidence * 100);
            const pRawPct = pDir.fromChanges > 0 ? Math.round((pDir.shared / pDir.fromChanges) * 100) : 0;
            const pPctText = pe.weighted ? `${pPct}% weighted (${pRawPct}% raw)` : `${pPct}%`;
            return {
              edgeIndex: ei,
              fromPath: pDir.fromPath,
              toPath: pDir.toPath,
              shortFrom: pDir.shortFrom,
              shortTo: pDir.shortTo,
              shared: pDir.shared,
              fromChanges: pDir.fromChanges,
              toChanges: pDir.toChanges,
              pctText: pPctText,
              lowerBoundText: `≥${lo}% CI`,
              rangeText: `${lo}–${hi}%`,
              rangeLowPct: lo,
              rangeHighPct: hi,
              relationship: pe.relationship,
              isLeadPair: ei === featured.leadEdgeIndex,
            };
          })
          .filter((p): p is FamilyPairRowCopy => p !== null)
      : [];

  return {
    kicker: `${findingId} · MOST INTERESTING FINDING`,
    statusChip: STATUS_CHIP_EVIDENCE,
    headline: headlineInfo.headline,
    subhead: headlineInfo.subhead,
    primaryDirection,
    reverseDirection,
    asymmetrySummary: formatAsymmetrySummary(
      dir.shortFrom,
      dir.shortTo,
      dir.shared,
      dir.fromChanges,
      dir.toChanges,
    ),
    lastTogetherText,
    lastTogetherDate,
    counterexamplesSummary,
    reverseCounterexamplesSummary,
    fromOnlyTotal: dir.fromOnlyTotal,
    toOnlyTotal: dir.toOnlyTotal,
    fromOnly: dir.fromOnly.slice(0, 3),
    toOnly: dir.toOnly.slice(0, 3),
    receiptsShown,
    receiptsTotal,
    receiptsOverflowCount,
    ownerNotes,
    originShareNote,
    verdictNote,
    explainCommand,
    howToReadSummary: HOW_TO_READ_SUMMARY,
    howToReadBody: HOW_TO_READ_BODY,
    readingGuide: formatReadingFindingGuide({
      fromLabel: dir.shortFrom,
      toLabel: dir.shortTo,
      shared: dir.shared,
      fromChanges: dir.fromChanges,
      toChanges: dir.toChanges,
      confidence: dir.confidence,
      reverseConfidence: dir.reverseConfidence,
      interval: dir.interval,
      reverseInterval: dir.reverseInterval,
      relationship: edge.relationship,
      why: edge.why,
      weighted: edge.weighted,
      weighting: edge.weighting,
      verdict: edge.verdict,
      isFamily: featured.kind === 'family',
      familyMemberCount: featured.kind === 'family' ? featured.family.members.length : undefined,
      familyQualifyingPairs:
        featured.kind === 'family' ? featured.family.qualifyingPairs : undefined,
      familyPossiblePairs:
        featured.kind === 'family' ? featured.family.possiblePairs : undefined,
      topAuthor: dir.fromNode.topAuthor,
      topAuthorShare: dir.fromNode.topAuthorShare,
    }),
    ...(featured.kind === 'family'
      ? {
          familySummary: {
            label: sanitizeHtmlDisplayText(featured.family.label),
            members: featured.family.members.map((m) => ({
              path: sanitizeHtmlDisplayText(m.path),
              variant: sanitizeHtmlDisplayText(m.variant),
              changes: m.changes,
            })),
            commitsTouchingTwoOrMore: featured.family.commitsTouchingTwoOrMore,
            commitsTouchingAll: featured.family.commitsTouchingAll,
            qualifyingPairs: featured.family.qualifyingPairs,
            possiblePairs: featured.family.possiblePairs,
            pairs: familyPairs,
          },
        }
      : {}),
  };
}

function isIndependentCrossDir(data: MapData, edge: MapEdge): boolean {
  if (edge.hiddenBridge?.signal === 'parallel-implementation') return false;
  const fromDir = data.nodes[edge.source]?.dir ?? '.';
  const toDir = data.nodes[edge.target]?.dir ?? '.';
  return (
    fromDir !== toDir &&
    fromDir !== '.' &&
    toDir !== '.' &&
    fromDir !== '(root)' &&
    toDir !== '(root)' &&
    !fromDir.startsWith(`${toDir}/`) &&
    !toDir.startsWith(`${fromDir}/`)
  );
}

function findStrongestImportCluster(data: MapData): {
  nodeIndices: number[];
  edgeIndices: number[];
} {
  const importEdgeIndices = data.edges
    .map((e, idx) => ({ e, idx }))
    .filter(({ e }) => e.relationship === 'direct' || e.relationship === 'indirect' || e.relationship === 'test')
    .map(({ idx }) => idx);

  if (importEdgeIndices.length === 0) {
    return { nodeIndices: [], edgeIndices: [] };
  }

  const adjNodes = new Map<number, number[]>();
  const adjEdges = new Map<number, number[]>();
  for (const ei of importEdgeIndices) {
    const e = data.edges[ei]!;
    if (!adjNodes.has(e.source)) adjNodes.set(e.source, []);
    if (!adjNodes.has(e.target)) adjNodes.set(e.target, []);
    if (!adjEdges.has(e.source)) adjEdges.set(e.source, []);
    if (!adjEdges.has(e.target)) adjEdges.set(e.target, []);
    adjNodes.get(e.source)!.push(e.target);
    adjNodes.get(e.target)!.push(e.source);
    adjEdges.get(e.source)!.push(ei);
    adjEdges.get(e.target)!.push(ei);
  }

  const visited = new Set<number>();
  let bestNodes: number[] = [];
  let bestEdges: number[] = [];
  let bestScore = -1;
  let bestShared = -1;

  for (const startNode of adjNodes.keys()) {
    if (visited.has(startNode)) continue;
    visited.add(startNode);
    const queue = [startNode];
    const edgeSet = new Set<number>();
    for (let q = 0; q < queue.length; q++) {
      const u = queue[q]!;
      for (const ei of adjEdges.get(u) ?? []) edgeSet.add(ei);
      for (const v of adjNodes.get(u) ?? []) {
        if (!visited.has(v)) {
          visited.add(v);
          queue.push(v);
        }
      }
    }
    const compEdges = Array.from(edgeSet).sort((a, b) => a - b);
    const compScore = compEdges.reduce((m, ei) => Math.max(m, data.edges[ei]?.score ?? 0), 0);
    const compShared = compEdges.reduce((s, ei) => s + (data.edges[ei]?.shared ?? 0), 0);
    if (
      compEdges.length > bestEdges.length ||
      (compEdges.length === bestEdges.length &&
        (compScore > bestScore || (compScore === bestScore && compShared > bestShared)))
    ) {
      bestNodes = queue.sort((a, b) => a - b);
      bestEdges = compEdges;
      bestScore = compScore;
      bestShared = compShared;
    }
  }

  return { nodeIndices: bestNodes, edgeIndices: bestEdges };
}

/**
 * Deterministically selects the featured finding for the Investigation Board (`C-01`):
 * 1. Top item of the existing overview priority among ghost wires, choosing a family over
 *    a pair when the family's `overviewPriority` is highest.
 * 2. If there are no ghost wires, the top "surprising" link.
 * 3. If there's nothing at all, a first-class empty state with the strongest import cluster as context.
 */
export function selectFeaturedFinding(
  data: MapData,
  visible?: Partial<Record<Relationship, boolean>>,
): FeaturedFinding {
  const isRelVisible = (rel: Relationship): boolean =>
    visible ? Boolean(visible[rel]) : true;

  // 1. Check ghost wires
  const ghostEdges = data.edges
    .map((edge, edgeIndex) => ({ edge, edgeIndex }))
    .filter(({ edge }) => edge.relationship === 'ghost' && isRelVisible('ghost'))
    .sort(
      (a, b) =>
        b.edge.overviewPriority - a.edge.overviewPriority ||
        b.edge.score - a.edge.score ||
        b.edge.shared - a.edge.shared ||
        a.edgeIndex - b.edgeIndex,
    );

  const ghostFamilies = (data.families ?? [])
    .map((family, familyIndex) => {
      const ghostMemberEdges = family.edgeIndices
        .filter((ei) => {
          const e = data.edges[ei];
          return e !== undefined && e.relationship === 'ghost' && isRelVisible('ghost');
        })
        .sort((eiA, eiB) => {
          const a = data.edges[eiA]!;
          const b = data.edges[eiB]!;
          return (
            b.overviewPriority - a.overviewPriority ||
            b.score - a.score ||
            b.shared - a.shared ||
            eiA - eiB
          );
        });
      if (ghostMemberEdges.length === 0) return null;
      const leadEdgeIndex = ghostMemberEdges[0]!;
      const leadEdge = data.edges[leadEdgeIndex]!;
      const maxGhostPrio = Math.max(
        family.overviewPriority,
        ...ghostMemberEdges.map((ei) => data.edges[ei]!.overviewPriority),
      );
      return {
        family,
        familyIndex,
        leadEdgeIndex,
        leadEdge,
        overviewPriority: maxGhostPrio,
      };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null)
    .sort(
      (a, b) =>
        b.overviewPriority - a.overviewPriority ||
        b.family.peakScore - a.family.peakScore ||
        b.family.commitsTouchingTwoOrMore - a.family.commitsTouchingTwoOrMore ||
        b.family.maxPairShared - a.family.maxPairShared ||
        a.familyIndex - b.familyIndex,
    );

  if (ghostEdges.length > 0 || ghostFamilies.length > 0) {
    const topEdge = ghostEdges[0];
    const topFam = ghostFamilies[0];

    if (topFam && topEdge) {
      // Choose a family over a pair when the family's overviewPriority is highest:
      // - If topFam.overviewPriority > topEdge.edge.overviewPriority -> family wins
      // - If tied at overviewPriority > 0 -> family wins (family's overviewPriority is highest)
      // - If tied at overviewPriority === 0 -> family wins when it contains the top edge or its peakScore >= topEdge.score
      const famWins =
        topFam.overviewPriority > topEdge.edge.overviewPriority ||
        (topFam.overviewPriority === topEdge.edge.overviewPriority &&
          (topFam.overviewPriority > 0 ||
            topFam.family.edgeIndices.includes(topEdge.edgeIndex) ||
            topFam.family.peakScore >= topEdge.edge.score));

      if (famWins) {
        return {
          kind: 'family',
          familyIndex: topFam.familyIndex,
          family: topFam.family,
          leadEdgeIndex: topFam.leadEdgeIndex,
          leadEdge: topFam.leadEdge,
        };
      }
    } else if (topFam) {
      return {
        kind: 'family',
        familyIndex: topFam.familyIndex,
        family: topFam.family,
        leadEdgeIndex: topFam.leadEdgeIndex,
        leadEdge: topFam.leadEdge,
      };
    }

    if (topEdge) {
      return {
        kind: 'pair',
        edgeIndex: topEdge.edgeIndex,
        edge: topEdge.edge,
      };
    }
  }

  // 2. If there are no ghost wires, look for the top "surprising" unchecked link
  const surprisingEdges = data.edges
    .map((edge, edgeIndex) => ({ edge, edgeIndex }))
    .filter(
      ({ edge }) =>
        isRelVisible(edge.relationship) &&
        edge.relationship === 'unknown' &&
        (edge.overviewPriority >= 2 || isIndependentCrossDir(data, edge)),
    )
    .sort(
      (a, b) =>
        b.edge.overviewPriority - a.edge.overviewPriority ||
        b.edge.score - a.edge.score ||
        b.edge.shared - a.edge.shared ||
        a.edgeIndex - b.edgeIndex,
    );

  if (surprisingEdges.length > 0) {
    const topSurprising = surprisingEdges[0]!;
    return {
      kind: 'pair',
      edgeIndex: topSurprising.edgeIndex,
      edge: topSurprising.edge,
    };
  }

  // 3. Otherwise, first-class empty state with the strongest import cluster as context
  const cluster = findStrongestImportCluster(data);
  return {
    kind: 'empty',
    contextClusterNodeIndices: cluster.nodeIndices,
    contextClusterEdgeIndices: cluster.edgeIndices,
  };
}

/**
 * Formats a URL hash fragment (`#f=<sourcePath>..<targetPath>`) for deep-linking a finding.
 * Escapes literal `..` inside either path as `%2E%2E` so `..` only appears as the delimiter.
 */
export function formatFindingHash(sourcePath: string, targetPath: string): string {
  const encodePart = (p: string): string => encodeURIComponent(p).replace(/\.\./g, '%2E%2E');
  return `#f=${encodePart(sourcePath)}..${encodePart(targetPath)}`;
}

/**
 * Resolves a `#f=<sourcePath>..<targetPath>` hash fragment against `data`.
 * Returns `null` if the hash is missing, malformed, tampered with, or does not match any edge in `data`.
 */
export function resolveFindingFromHash(hash: string, data: MapData): FeaturedFinding | null {
  if (!hash || typeof hash !== 'string') return null;
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = trimmed.split('&');
  let rawPair: string | null = null;
  for (const part of params) {
    if (part.startsWith('f=')) {
      rawPair = part.slice(2);
      break;
    }
  }
  if (!rawPair) return null;
  const sepIdx = rawPair.indexOf('..');
  if (sepIdx <= 0 || sepIdx === rawPair.length - 2) return null;

  let pathA: string;
  let pathB: string;
  try {
    pathA = decodeURIComponent(rawPair.slice(0, sepIdx));
    pathB = decodeURIComponent(rawPair.slice(sepIdx + 2));
  } catch {
    return null;
  }
  if (!pathA || !pathB || pathA.length > 1024 || pathB.length > 1024) return null;
  if (/[\u0000-\u001f\u007f]/.test(pathA) || /[\u0000-\u001f\u007f]/.test(pathB)) return null;

  for (let ei = 0; ei < data.edges.length; ei++) {
    const e = data.edges[ei]!;
    const sPath = data.nodes[e.source]?.path;
    const tPath = data.nodes[e.target]?.path;
    if ((sPath === pathA && tPath === pathB) || (sPath === pathB && tPath === pathA)) {
      return {
        kind: 'pair',
        edgeIndex: ei,
        edge: e,
      };
    }
  }
  return null;
}

/**
 * Builds the deterministic ranked list of findings (`RankedFindingItem[]`) from `MapData`.
 */
export function buildRankedFindings(
  data: MapData,
  visible?: Partial<Record<Relationship, boolean>>,
): RankedFindingItem[] {
  const isRelVisible = (rel: Relationship): boolean =>
    visible ? Boolean(visible[rel]) : eDefaultVisible(data, rel);

  const edgeToFamilyIdx = new Map<number, number>();
  (data.families ?? []).forEach((fam, fIdx) => {
    const activeEdges = fam.edgeIndices.filter((ei) => {
      const e = data.edges[ei];
      return e !== undefined && isRelVisible(e.relationship);
    });
    if (activeEdges.length >= 2) {
      for (const ei of activeEdges) {
        if (!edgeToFamilyIdx.has(ei)) edgeToFamilyIdx.set(ei, fIdx);
      }
    }
  });

  const sortedEdgeIndices = data.edges
    .map((_, idx) => idx)
    .filter((ei) => isRelVisible(data.edges[ei]!.relationship))
    .sort((eiA, eiB) => {
      const a = data.edges[eiA]!;
      const b = data.edges[eiB]!;
      const aGhost = a.relationship === 'ghost' ? 1 : 0;
      const bGhost = b.relationship === 'ghost' ? 1 : 0;
      return (
        bGhost - aGhost ||
        b.overviewPriority - a.overviewPriority ||
        b.score - a.score ||
        b.shared - a.shared ||
        eiA - eiB
      );
    });

  const emittedFamilies = new Set<number>();
  const items: RankedFindingItem[] = [];

  for (const ei of sortedEdgeIndices) {
    const famIdx = edgeToFamilyIdx.get(ei);
    if (famIdx !== undefined) {
      if (emittedFamilies.has(famIdx)) continue;
      emittedFamilies.add(famIdx);
      const fam = data.families![famIdx]!;
      const activeEdges = fam.edgeIndices
        .filter((idx) => {
          const e = data.edges[idx];
          return e !== undefined && isRelVisible(e.relationship);
        })
        .sort((aIdx, bIdx) => {
          const a = data.edges[aIdx]!;
          const b = data.edges[bIdx]!;
          return (
            b.overviewPriority - a.overviewPriority ||
            b.score - a.score ||
            b.shared - a.shared ||
            aIdx - bIdx
          );
        });
      const leadEdgeIdx = activeEdges[0] ?? ei;
      const leadEdge = data.edges[leadEdgeIdx]!;
      const dir = resolveStrongerDirection(data, leadEdge);
      const rankNum = items.length + 1;
      const findingId = `F-${String(rankNum).padStart(2, '0')}`;
      const famFileName =
        fam.fileName ||
        (fam as { stem?: string }).stem ||
        posix.basename(fam.members[0]?.path ?? fam.label ?? 'file');
      const famHasGhost =
        Array.isArray(fam.relationshipKinds) && fam.relationshipKinds.includes('ghost');
      const famWeighted = Boolean(leadEdge.weighted);
      const famRawPct = dir.fromChanges > 0 ? Math.round((dir.shared / dir.fromChanges) * 100) : 0;
      const famRevRawPct = dir.toChanges > 0 ? Math.round((dir.shared / dir.toChanges) * 100) : 0;
      const famRevPctText = famWeighted
        ? `${Math.round(dir.reverseConfidence * 100)}% weighted, ${famRevRawPct}% raw`
        : `${Math.round(dir.reverseConfidence * 100)}%`;
      items.push({
        id: `family:${fam.id}`,
        findingId,
        cutLabel: findingId,
        kind: 'family',
        relationship: famHasGhost ? 'ghost' : leadEdge.relationship,
        title: String(famFileName).startsWith('*-')
          ? `${fam.members.length} files sharing the ${sanitizeHtmlDisplayText(String(famFileName).slice(1).replace(/\.[^.]+$/, ''))} suffix in ${sanitizeHtmlDisplayText(fam.parentDir === '.' ? 'root' : fam.parentDir)}`
          : `${sanitizeHtmlDisplayText(famFileName)} across ${sanitizeHtmlDisplayText(fam.parentDir === '.' ? '*' : `${fam.parentDir}/*`)}`,
        subtitle: `${fam.members.length} files (${fam.members.map((m) => sanitizeHtmlDisplayText(m.variant)).join(', ')}) · ${fam.commitsTouchingTwoOrMore} commits (2+ files)`,
        reverseSummary: `Reverse (${dir.shortTo} → ${dir.shortFrom}): ${dir.shared} of ${dir.toChanges} (${famRevPctText})`,
        counterexampleLine: formatCounterexamplesLine(dir.fromOnlyTotal),
        reverseCounterexampleLine: formatCounterexamplesLine(dir.toOnlyTotal),
        fromPath: dir.fromPath,
        toPath: dir.toPath,
        shortFrom: dir.shortFrom,
        shortTo: dir.shortTo,
        shared: dir.shared,
        totalChanges: dir.fromChanges,
        fromOnlyTotal: dir.fromOnlyTotal,
        toOnlyTotal: dir.toOnlyTotal,
        ratioText: `${dir.shared}/${dir.fromChanges}`,
        confidence: dir.confidence,
        weighted: famWeighted,
        rawPct: famRawPct,
        interval: dir.interval,
        rangeLowPct: Math.round(dir.interval.low * 100),
        rangeHighPct: Math.round(dir.interval.high * 100),
        pointPct: Math.round(dir.confidence * 100),
        lastTogether: sanitizeHtmlDisplayText(fam.lastTogether),
        overviewPriority: fam.overviewPriority,
        score: fam.peakScore,
        weak: dir.interval.low < 0.3,
        edgeIndex: leadEdgeIdx,
        familyIndex: famIdx,
        relationshipKinds: Array.isArray(fam.relationshipKinds)
          ? [...fam.relationshipKinds]
          : [leadEdge.relationship],
        edgeIndices: [...fam.edgeIndices],
      });
      continue;
    }

    const edge = data.edges[ei]!;
    const dir = resolveStrongerDirection(data, edge);
    const rankNum = items.length + 1;
    const findingId = `F-${String(rankNum).padStart(2, '0')}`;
    const isWeighted = Boolean(edge.weighted);
    const rawPct = dir.fromChanges > 0 ? Math.round((dir.shared / dir.fromChanges) * 100) : 0;
    const revRawPct = dir.toChanges > 0 ? Math.round((dir.shared / dir.toChanges) * 100) : 0;
    const pctSummary = isWeighted
      ? `${Math.round(dir.confidence * 100)}% weighted, ${rawPct}% raw`
      : `${Math.round(dir.confidence * 100)}%`;
    const revPctSummary = isWeighted
      ? `${Math.round(dir.reverseConfidence * 100)}% weighted, ${revRawPct}% raw`
      : `${Math.round(dir.reverseConfidence * 100)}%`;
    items.push({
      id: `pair:${dir.fromPath}..${dir.toPath}`,
      findingId,
      cutLabel: findingId,
      kind: 'pair',
      relationship: edge.relationship,
      title: `${dir.shortFrom} ⇢ ${dir.shortTo}`,
      subtitle: `${dir.shared} of ${dir.fromChanges} ${dir.fromChanges === 1 ? 'commit' : 'commits'} (${pctSummary}) · 95% range ${Math.round(dir.interval.low * 100)}–${Math.round(dir.interval.high * 100)}%`,
      reverseSummary: `Reverse (${dir.shortTo} → ${dir.shortFrom}): ${dir.shared} of ${dir.toChanges} (${revPctSummary})`,
      counterexampleLine: formatCounterexamplesLine(dir.fromOnlyTotal),
      reverseCounterexampleLine: formatCounterexamplesLine(dir.toOnlyTotal),
      fromPath: dir.fromPath,
      toPath: dir.toPath,
      shortFrom: dir.shortFrom,
      shortTo: dir.shortTo,
      shared: dir.shared,
      totalChanges: dir.fromChanges,
      fromOnlyTotal: dir.fromOnlyTotal,
      toOnlyTotal: dir.toOnlyTotal,
      ratioText: `${dir.shared}/${dir.fromChanges}`,
      confidence: dir.confidence,
      weighted: isWeighted,
      rawPct,
      interval: dir.interval,
      rangeLowPct: Math.round(dir.interval.low * 100),
      rangeHighPct: Math.round(dir.interval.high * 100),
      pointPct: Math.round(dir.confidence * 100),
      lastTogether: sanitizeHtmlDisplayText(edge.lastTogether),
      overviewPriority: edge.overviewPriority,
      score: edge.score,
      weak:
        (edge.relationship === 'ghost' || edge.relationship === 'unknown') &&
        dir.interval.low < 0.3,
      edgeIndex: ei,
    });
  }

  return items;
}

function eDefaultVisible(data: MapData, rel: Relationship): boolean {
  const hasPrimary = data.edges.some((e) => e.relationship !== 'unknown');
  if (rel === 'unknown') return !hasPrimary;
  return true;
}

export type LabelCandidatePosition = 'S' | 'N' | 'E' | 'W' | 'SE' | 'SW' | 'NE' | 'NW';

export interface PlateLabelBox {
  nodeIndex: number;
  text: string;
  fullPath: string;
  position: LabelCandidatePosition;
  x: number;
  y: number;
  w: number;
  h: number;
  anchorX: number;
  anchorY: number;
  textAlign: 'left' | 'center' | 'right';
}

export interface PlateNodeLayout {
  nodeIndex: number;
  path: string;
  shortLabel: string;
  dir: string;
  changes: number;
  x: number;
  y: number;
  r: number;
  isFeaturedEndpoint: boolean;
  label: PlateLabelBox;
}

export interface PlateEdgeLayout {
  edgeIndex: number;
  sourceNodeIndex: number;
  targetNodeIndex: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  relationship: Relationship;
  intervalLow: number;
  strokeWidth: number;
  isFeatured: boolean;
  isLeadEdge: boolean;
}

export interface FeaturedPlateLayout {
  width: number;
  height: number;
  nodes: PlateNodeLayout[];
  edges: PlateEdgeLayout[];
  leadEdge: PlateEdgeLayout | null;
  balloonTarget: { x: number; y: number } | null;
  balloonBox: { x: number; y: number; w: number; h: number } | null;
  fullComponentNodeCount: number;
  truncatedToEgoCap: boolean;
  /** Number of non-featured context-to-context edges omitted from dense (>=5-node) plate diagrams. */
  hiddenContextEdges: number;
}

export const MAX_EGO_NODES = 12;
export const CANDIDATE_POSITIONS: readonly LabelCandidatePosition[] = [
  'S',
  'N',
  'E',
  'W',
  'SE',
  'SW',
  'NE',
  'NW',
] as const;

function disambiguateNodeSetPaths(paths: readonly string[]): string[] {
  const cleanPaths = paths.map((p) => sanitizeHtmlDisplayText(p));
  const splitPaths = cleanPaths.map((p) => p.split('/').filter(Boolean));
  const depth = cleanPaths.map(() => 1);

  for (let pass = 0; pass < 5; pass++) {
    const counts = new Map<string, number>();
    for (let i = 0; i < cleanPaths.length; i++) {
      const parts = splitPaths[i]!;
      const d = Math.min(depth[i]!, parts.length);
      const label = parts.slice(parts.length - d).join('/') || cleanPaths[i]!;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    let anyCollision = false;
    for (let i = 0; i < cleanPaths.length; i++) {
      const parts = splitPaths[i]!;
      const d = Math.min(depth[i]!, parts.length);
      const label = parts.slice(parts.length - d).join('/') || cleanPaths[i]!;
      if ((counts.get(label) ?? 0) > 1 && depth[i]! < parts.length) {
        depth[i]! += 1;
        anyCollision = true;
      }
    }
    if (!anyCollision) break;
  }

  return cleanPaths.map((p, i) => {
    const parts = splitPaths[i]!;
    const d = Math.min(depth[i]!, parts.length);
    const combined = parts.slice(parts.length - d).join('/') || p;
    return middleTruncatePath(combined, 36);
  });
}

function boxesOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  pad = 2,
): boolean {
  return (
    a.x - pad < b.x + b.w &&
    a.x + a.w + pad > b.x &&
    a.y - pad < b.y + b.h &&
    a.y + a.h + pad > b.y
  );
}

function distToSegmentSq(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-6) {
    const ex = px - x1;
    const ey = py - y1;
    return ex * ex + ey * ey;
  }
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  const ex = px - projX;
  const ey = py - projY;
  return ex * ex + ey * ey;
}

function boxIntersectsSegment(
  box: { x: number; y: number; w: number; h: number },
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): boolean {
  // Sample 5 points along the segment and check if any fall inside the padded box
  const pad = 3;
  for (let s = 0; s <= 4; s++) {
    const t = s / 4;
    const sx = x1 + (x2 - x1) * t;
    const sy = y1 + (y2 - y1) * t;
    if (
      sx >= box.x - pad &&
      sx <= box.x + box.w + pad &&
      sy >= box.y - pad &&
      sy <= box.y + box.h + pad
    ) {
      return true;
    }
  }
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return distToSegmentSq(cx, cy, x1, y1, x2, y2) < (box.h / 2 + 4) ** 2;
}

function candidateBoxForPosition(
  nx: number,
  ny: number,
  r: number,
  w: number,
  h: number,
  pos: LabelCandidatePosition,
  extraOffset = 0,
): Omit<PlateLabelBox, 'nodeIndex' | 'text' | 'fullPath'> {
  const gap = 7 + extraOffset;
  const diag = Math.round((r + gap) * 0.75);
  switch (pos) {
    case 'S':
      return {
        position: pos,
        x: Math.round((nx - w / 2) * 10) / 10,
        y: Math.round((ny + r + gap) * 10) / 10,
        w,
        h,
        anchorX: nx,
        anchorY: Math.round((ny + r + gap + h * 0.76) * 10) / 10,
        textAlign: 'center',
      };
    case 'N':
      return {
        position: pos,
        x: Math.round((nx - w / 2) * 10) / 10,
        y: Math.round((ny - r - gap - h) * 10) / 10,
        w,
        h,
        anchorX: nx,
        anchorY: Math.round((ny - r - gap - h * 0.24) * 10) / 10,
        textAlign: 'center',
      };
    case 'E':
      return {
        position: pos,
        x: Math.round((nx + r + gap + 2) * 10) / 10,
        y: Math.round((ny - h / 2) * 10) / 10,
        w,
        h,
        anchorX: Math.round((nx + r + gap + 2) * 10) / 10,
        anchorY: Math.round((ny + h * 0.28) * 10) / 10,
        textAlign: 'left',
      };
    case 'W':
      return {
        position: pos,
        x: Math.round((nx - r - gap - 2 - w) * 10) / 10,
        y: Math.round((ny - h / 2) * 10) / 10,
        w,
        h,
        anchorX: Math.round((nx - r - gap - 2) * 10) / 10,
        anchorY: Math.round((ny + h * 0.28) * 10) / 10,
        textAlign: 'right',
      };
    case 'SE':
      return {
        position: pos,
        x: Math.round((nx + diag) * 10) / 10,
        y: Math.round((ny + diag * 0.75) * 10) / 10,
        w,
        h,
        anchorX: Math.round((nx + diag) * 10) / 10,
        anchorY: Math.round((ny + diag * 0.75 + h * 0.76) * 10) / 10,
        textAlign: 'left',
      };
    case 'SW':
      return {
        position: pos,
        x: Math.round((nx - diag - w) * 10) / 10,
        y: Math.round((ny + diag * 0.75) * 10) / 10,
        w,
        h,
        anchorX: Math.round((nx - diag) * 10) / 10,
        anchorY: Math.round((ny + diag * 0.75 + h * 0.76) * 10) / 10,
        textAlign: 'right',
      };
    case 'NE':
      return {
        position: pos,
        x: Math.round((nx + diag) * 10) / 10,
        y: Math.round((ny - diag * 0.75 - h) * 10) / 10,
        w,
        h,
        anchorX: Math.round((nx + diag) * 10) / 10,
        anchorY: Math.round((ny - diag * 0.75 - h * 0.24) * 10) / 10,
        textAlign: 'left',
      };
    case 'NW':
      return {
        position: pos,
        x: Math.round((nx - diag - w) * 10) / 10,
        y: Math.round((ny - diag * 0.75 - h) * 10) / 10,
        w,
        h,
        anchorX: Math.round((nx - diag) * 10) / 10,
        anchorY: Math.round((ny - diag * 0.75 - h * 0.24) * 10) / 10,
        textAlign: 'right',
      };
  }
}

/**
 * Computes the deterministic ego-network layout (up to 12 nodes) and 8-position
 * collision-free label placement for the featured finding on the cyanotype plate.
 */
export function computeFeaturedPlateLayout(
  data: MapData,
  featured: FeaturedFinding,
  options?: {
    width?: number;
    height?: number;
    visible?: Partial<Record<Relationship, boolean>>;
  },
): FeaturedPlateLayout {
  const width = options?.width ?? 760;
  const height = options?.height ?? 380;
  const isRelVisible = (rel: Relationship): boolean =>
    options?.visible ? Boolean(options.visible[rel]) : eDefaultVisible(data, rel);

  const visibleEdgeIndices = data.edges
    .map((_, idx) => idx)
    .filter((ei) => isRelVisible(data.edges[ei]!.relationship));

  const adjNodes = new Map<number, Set<number>>();
  for (const ei of visibleEdgeIndices) {
    const e = data.edges[ei]!;
    if (!adjNodes.has(e.source)) adjNodes.set(e.source, new Set());
    if (!adjNodes.has(e.target)) adjNodes.set(e.target, new Set());
    adjNodes.get(e.source)!.add(e.target);
    adjNodes.get(e.target)!.add(e.source);
  }

  let seedNodeIndices: number[] = [];
  const featuredEdgeSet = new Set<number>();
  let leadEdgeIndex = -1;

  if (featured.kind === 'family') {
    seedNodeIndices = featured.family.nodeIndices.filter((ni) => ni >= 0 && ni < data.nodes.length);
    for (const ei of featured.family.edgeIndices) {
      if (visibleEdgeIndices.includes(ei)) featuredEdgeSet.add(ei);
    }
    leadEdgeIndex = featured.leadEdgeIndex;
  } else if (featured.kind === 'pair') {
    seedNodeIndices = [featured.edge.source, featured.edge.target].filter(
      (ni) => ni >= 0 && ni < data.nodes.length,
    );
    featuredEdgeSet.add(featured.edgeIndex);
    leadEdgeIndex = featured.edgeIndex;
  } else {
    seedNodeIndices = featured.contextClusterNodeIndices.slice(0, MAX_EGO_NODES);
  }

  if (seedNodeIndices.length === 0) {
    return {
      width,
      height,
      nodes: [],
      edges: [],
      leadEdge: null,
      balloonTarget: null,
      balloonBox: null,
      fullComponentNodeCount: 0,
      truncatedToEgoCap: false,
      hiddenContextEdges: 0,
    };
  }

  // Measure full connected component size from seed nodes
  const compVisited = new Set<number>(seedNodeIndices);
  const compQueue = [...seedNodeIndices];
  for (let q = 0; q < compQueue.length; q++) {
    const u = compQueue[q]!;
    for (const v of adjNodes.get(u) ?? []) {
      if (!compVisited.has(v)) {
        compVisited.add(v);
        compQueue.push(v);
      }
    }
  }
  const fullComponentNodeCount = compVisited.size;

  // Build ego network: seed nodes + direct neighbors ranked by strongest connecting edge, capped at 12
  const egoSet = new Set<number>(seedNodeIndices.slice(0, MAX_EGO_NODES));
  if (egoSet.size < MAX_EGO_NODES) {
    const candidateNeighbors = new Map<
      number,
      { ghost: number; prio: number; score: number; shared: number }
    >();
    for (const ei of visibleEdgeIndices) {
      const e = data.edges[ei]!;
      const sIn = egoSet.has(e.source);
      const tIn = egoSet.has(e.target);
      if (sIn === tIn) continue;
      const nbr = sIn ? e.target : e.source;
      const rank = {
        ghost: e.relationship === 'ghost' ? 1 : 0,
        prio: e.overviewPriority,
        score: e.score,
        shared: e.shared,
      };
      const prev = candidateNeighbors.get(nbr);
      if (
        !prev ||
        rank.ghost > prev.ghost ||
        (rank.ghost === prev.ghost &&
          (rank.prio > prev.prio ||
            (rank.prio === prev.prio &&
              (rank.score > prev.score || (rank.score === prev.score && rank.shared > prev.shared)))))
      ) {
        candidateNeighbors.set(nbr, rank);
      }
    }

    const sortedNeighbors = Array.from(candidateNeighbors.entries())
      .sort(
        (a, b) =>
          b[1].ghost - a[1].ghost ||
          b[1].prio - a[1].prio ||
          b[1].score - a[1].score ||
          b[1].shared - a[1].shared ||
          a[0] - b[0],
      )
      .map(([ni]) => ni);

    for (const nbr of sortedNeighbors) {
      if (egoSet.size >= MAX_EGO_NODES) break;
      egoSet.add(nbr);
    }
  }

  const egoNodeIndices = Array.from(egoSet);
  const seedSet = new Set<number>(seedNodeIndices);
  // Keep seed nodes first (with leadEdge endpoints in slots 0 and 1), then neighbor nodes
  const leadSource = leadEdgeIndex >= 0 ? data.edges[leadEdgeIndex]?.source : undefined;
  const leadTarget = leadEdgeIndex >= 0 ? data.edges[leadEdgeIndex]?.target : undefined;
  egoNodeIndices.sort((a, b) => {
    const aLead = a === leadSource ? 0 : a === leadTarget ? 1 : seedSet.has(a) ? 2 : 3;
    const bLead = b === leadSource ? 0 : b === leadTarget ? 1 : seedSet.has(b) ? 2 : 3;
    return aLead - bLead || a - b;
  });

  const rawEgoEdgeIndices = visibleEdgeIndices.filter((ei) => {
    const e = data.edges[ei]!;
    return egoSet.has(e.source) && egoSet.has(e.target);
  });

  // Avoid O(n^2) crossing-chord hairballs on dense >=5-node cliques by retaining
  // lead-incident edges + ring-perimeter edges so the cluster stays clean and legible.
  const egoPosByNode = new Map<number, number>();
  egoNodeIndices.forEach((ni, idx) => egoPosByNode.set(ni, idx));
  const egoEdgeIndices =
    egoNodeIndices.length >= 5 && rawEgoEdgeIndices.length > egoNodeIndices.length + 3
      ? rawEgoEdgeIndices.filter((ei) => {
          if (ei === leadEdgeIndex) return true;
          const e = data.edges[ei]!;
          if (e.source === leadSource || e.target === leadSource || e.source === leadTarget || e.target === leadTarget) {
            return true;
          }
          const pa = egoPosByNode.get(e.source) ?? -1;
          const pb = egoPosByNode.get(e.target) ?? -1;
          const diff = Math.abs(pa - pb);
          return diff === 1 || diff === egoNodeIndices.length - 1;
        })
      : rawEgoEdgeIndices;

  const nCount = egoNodeIndices.length;
  const cx = width / 2;
  const cy = height / 2 + 16; // shifted down slightly so top-center speech balloon has plenty of room
  const rx = Math.max(90, (width - 220) / 2);
  const ry = Math.max(60, (height - 110) / 2);

  const px = new Float64Array(nCount);
  const py = new Float64Array(nCount);

  if (nCount === 1) {
    px[0] = cx;
    py[0] = cy;
  } else if (nCount === 2) {
    px[0] = cx - Math.min(130, rx * 0.65);
    py[0] = cy;
    px[1] = cx + Math.min(130, rx * 0.65);
    py[1] = cy;
  } else if (nCount === 3) {
    // Triangle with the lead pair across the top-center so the speech balloon sits cleanly above it
    px[0] = cx - Math.min(135, rx * 0.72);
    py[0] = cy - Math.min(44, ry * 0.52);
    px[1] = cx + Math.min(135, rx * 0.72);
    py[1] = cy - Math.min(44, ry * 0.52);
    px[2] = cx;
    py[2] = cy + Math.min(72, ry * 0.78);
  } else {
    const seedsInEgo = egoNodeIndices.filter((ni) => seedSet.has(ni));
    const nbrsInEgo = egoNodeIndices.filter((ni) => !seedSet.has(ni));
    const sCount = seedsInEgo.length;
    const mCount = nbrsInEgo.length;

    const anchorX = new Float64Array(sCount);
    const anchorY = new Float64Array(sCount);

    if (sCount === 2) {
      const spanX = mCount >= 5 ? Math.min(165, rx * 0.64) : Math.min(125, rx * 0.52);
      const seedY = mCount >= 5 ? cy - Math.min(48, ry * 0.38) : cy - 14;
      anchorX[0] = cx - spanX;
      anchorY[0] = seedY;
      anchorX[1] = cx + spanX;
      anchorY[1] = seedY;
    } else if (sCount === 3) {
      const spanX = Math.min(122, rx * 0.5);
      const topY = cy - Math.min(42, ry * 0.52);
      const botY = cy + Math.min(64, ry * 0.76);
      anchorX[0] = cx - spanX;
      anchorY[0] = topY;
      anchorX[1] = cx + spanX;
      anchorY[1] = topY;
      anchorX[2] = cx;
      anchorY[2] = botY;
    } else {
      const innerScaleX = mCount > 0 ? (sCount >= 6 ? 0.78 : sCount >= 4 ? 0.66 : 0.52) : 0.85;
      const innerScaleY = mCount > 0 ? (sCount >= 6 ? 0.78 : sCount >= 4 ? 0.66 : 0.56) : 0.85;
      const innerRx = rx * innerScaleX;
      const innerRy = ry * innerScaleY;
      for (let i = 0; i < sCount; i++) {
        const angle = -Math.PI * 0.78 + (2 * Math.PI * i) / Math.max(1, sCount);
        anchorX[i] = cx + Math.cos(angle) * innerRx;
        anchorY[i] = cy + Math.sin(angle) * innerRy;
      }
    }

    for (let i = 0; i < sCount; i++) {
      px[i] = anchorX[i]!;
      py[i] = anchorY[i]!;
    }

    // Place neighbors along an outer arc from right-flank (-0.12*PI) around the bottom to left-flank (+1.12*PI),
    // ordered by the horizontal position of the seed node(s) each neighbor connects to so edges don't cross.
    const localIdxByGlobal = new Map<number, number>();
    egoNodeIndices.forEach((gi, li) => localIdxByGlobal.set(gi, li));

    const localDeg = new Int32Array(nCount);
    for (const ei of egoEdgeIndices) {
      const e = data.edges[ei]!;
      const li = localIdxByGlobal.get(e.source);
      const lj = localIdxByGlobal.get(e.target);
      if (li !== undefined && lj !== undefined) {
        localDeg[li] = localDeg[li]! + 1;
        localDeg[lj] = localDeg[lj]! + 1;
      }
    }

    const nbrMeta = nbrsInEgo.map((ni, j) => {
      const localIdx = sCount + j;
      let sumX = 0;
      let sumY = 0;
      let count = 0;
      for (const ei of egoEdgeIndices) {
        const e = data.edges[ei]!;
        if (e.source === ni && seedSet.has(e.target)) {
          const si = localIdxByGlobal.get(e.target)!;
          sumX += px[si]!;
          sumY += py[si]!;
          count++;
        } else if (e.target === ni && seedSet.has(e.source)) {
          const si = localIdxByGlobal.get(e.source)!;
          sumX += px[si]!;
          sumY += py[si]!;
          count++;
        }
      }
      const prefX = count > 0 ? sumX / count : cx;
      const prefY = count > 0 ? sumY / count : cy;
      return { localIdx, prefX, prefY, ni };
    });

    // Sort neighbors from right-connected to bottom-connected to left-connected
    nbrMeta.sort((a, b) => b.prefX - a.prefX || a.prefY - b.prefY || a.ni - b.ni);

    const arcAngles =
      mCount === 1
        ? [0.05 * Math.PI]
        : mCount === 2
          ? [-0.05 * Math.PI, 1.05 * Math.PI]
          : mCount === 3
            ? [-0.08 * Math.PI, 0.36 * Math.PI, 0.96 * Math.PI]
            : Array.from(
                { length: mCount },
                (_, k) => -0.14 * Math.PI + (1.28 * Math.PI * k) / Math.max(1, mCount - 1),
              );

    const outerAnchorX = new Float64Array(nCount);
    const outerAnchorY = new Float64Array(nCount);
    for (let k = 0; k < mCount; k++) {
      const { localIdx } = nbrMeta[k]!;
      const angle = arcAngles[k]!;
      const ax = cx + Math.cos(angle) * rx * (mCount >= 6 ? 0.96 : 0.92);
      const ay = cy + Math.sin(angle) * ry * (mCount >= 6 ? 0.92 : 0.86);
      px[localIdx] = ax;
      py[localIdx] = ay;
      outerAnchorX[localIdx] = ax;
      outerAnchorY[localIdx] = ay;
    }

    // Light deterministic relaxation for neighbors while keeping seed nodes anchored in their clear formation
    for (let iter = 0; iter < 50; iter++) {
      const fx = new Float64Array(nCount);
      const fy = new Float64Array(nCount);
      for (let i = 0; i < nCount; i++) {
        for (let j = i + 1; j < nCount; j++) {
          const dx = px[j]! - px[i]!;
          const dy = py[j]! - py[i]!;
          const d2 = Math.max(25, dx * dx + dy * dy);
          const d = Math.sqrt(d2);
          const rep = (nCount >= 8 ? 5800 : 3600) / d2;
          const rxForce = (dx / d) * rep;
          const ryForce = (dy / d) * rep;
          fx[i] = fx[i]! - rxForce;
          fy[i] = fy[i]! - ryForce;
          fx[j] = fx[j]! + rxForce;
          fy[j] = fy[j]! + ryForce;
        }
      }
      for (const ei of egoEdgeIndices) {
        const e = data.edges[ei]!;
        const li = localIdxByGlobal.get(e.source);
        const lj = localIdxByGlobal.get(e.target);
        if (li === undefined || lj === undefined) continue;
        const dx = px[lj]! - px[li]!;
        const dy = py[lj]! - py[li]!;
        const d = Math.max(1, Math.hypot(dx, dy));
        const targetLen = featuredEdgeSet.has(ei) ? 170 : nCount >= 8 ? 190 : 125;
        const degNorm = Math.sqrt(Math.max(1, Math.max(localDeg[li]!, localDeg[lj]!)));
        const kSpring = (featuredEdgeSet.has(ei) ? 0.05 : 0.035) / degNorm;
        const f = (d - targetLen) * kSpring;
        const sx = (dx / d) * f;
        const sy = (dy / d) * f;
        fx[li] = fx[li]! + sx;
        fy[li] = fy[li]! + sy;
        fx[lj] = fx[lj]! - sx;
        fy[lj] = fy[lj]! - sy;
      }

      // Repel neighbor nodes from the speech-balloon zone above the lead pair (slots 0 and 1)
      const bMidX = nCount >= 2 ? (px[0]! + px[1]!) / 2 : cx;
      const bMidY = nCount >= 2 ? (py[0]! + py[1]!) / 2 : cy;
      const zoneLeft = bMidX - 155;
      const zoneRight = bMidX + 155;
      const zoneTop = Math.max(6, bMidY - 82);
      const zoneBottom = bMidY + 8;

      for (let i = 0; i < nCount; i++) {
        if (i < sCount) {
          // Keep seed nodes strongly anchored to their clean geometric formation
          fx[i] = fx[i]! + (anchorX[i]! - px[i]!) * 0.35;
          fy[i] = fy[i]! + (anchorY[i]! - py[i]!) * 0.35;
        } else {
          fx[i] = fx[i]! + (outerAnchorX[i]! - px[i]!) * 0.12;
          fy[i] = fy[i]! + (outerAnchorY[i]! - py[i]!) * 0.12;
          if (px[i]! > zoneLeft && px[i]! < zoneRight && py[i]! > zoneTop && py[i]! < zoneBottom) {
            const pushDirX = px[i]! >= bMidX ? 1 : -1;
            fx[i] = fx[i]! + pushDirX * 28;
            fy[i] = fy[i]! + 24;
          }
        }

        px[i] = Math.max(105, Math.min(width - 105, px[i]! + fx[i]! * 0.2));
        py[i] = Math.max(64, Math.min(height - 42, py[i]! + fy[i]! * 0.2));
      }
    }
  }

  // Node radii and short disambiguated labels
  const shortLabels = disambiguateNodeSetPaths(
    egoNodeIndices.map((ni) => data.nodes[ni]?.path ?? `file-${ni}`),
  );
  const radii = egoNodeIndices.map((ni) => {
    const changes = data.nodes[ni]?.changes ?? 1;
    const baseR = Math.max(5.5, Math.min(11, 4.2 + Math.sqrt(changes) * 0.85));
    return seedSet.has(ni) ? Math.max(7.5, baseR) : baseR;
  });

  // Final hard guard: ensure no non-lead node circle falls inside the speech-balloon box above lead pair
  if (nCount >= 2 && featured.kind !== 'empty') {
    const bMidX = (px[0]! + px[1]!) / 2;
    const bMidY = (py[0]! + py[1]!) / 2;
    const bBoxW = 368;
    const bBoxH = 44;
    const bBoxX = Math.max(12, Math.min(width - bBoxW - 12, bMidX - bBoxW / 2));
    const bBoxY = Math.max(8, bMidY - 58);

    for (let i = 2; i < nCount; i++) {
      const rPad = radii[i]! + 12;
      if (
        px[i]! + rPad > bBoxX &&
        px[i]! - rPad < bBoxX + bBoxW &&
        py[i]! + rPad > bBoxY &&
        py[i]! - rPad < bBoxY + bBoxH
      ) {
        // Push outward to the nearest horizontal side or below the balloon box
        if (px[i]! >= bMidX) {
          px[i] = Math.min(width - 95, bBoxX + bBoxW + rPad + 14);
        } else {
          px[i] = Math.max(95, bBoxX - rPad - 14);
        }
        py[i] = Math.max(py[i]!, bBoxY + bBoxH + rPad + 8);
      }
    }
  }

  const localIdxByGlobal = new Map<number, number>();
  egoNodeIndices.forEach((gi, li) => localIdxByGlobal.set(gi, li));

  const edges: PlateEdgeLayout[] = egoEdgeIndices.map((ei) => {
    const e = data.edges[ei]!;
    const li = localIdxByGlobal.get(e.source)!;
    const lj = localIdxByGlobal.get(e.target)!;
    const strokeWidth = Math.round((1.4 + Math.max(0, Math.min(1, e.interval.low)) * 2.8) * 10) / 10;
    return {
      edgeIndex: ei,
      sourceNodeIndex: e.source,
      targetNodeIndex: e.target,
      x1: Math.round(px[li]! * 10) / 10,
      y1: Math.round(py[li]! * 10) / 10,
      x2: Math.round(px[lj]! * 10) / 10,
      y2: Math.round(py[lj]! * 10) / 10,
      relationship: e.relationship,
      intervalLow: e.interval.low,
      strokeWidth,
      isFeatured: featuredEdgeSet.has(ei),
      isLeadEdge: ei === leadEdgeIndex,
    };
  });

  const leadEdge = edges.find((e) => e.isLeadEdge) ?? edges.find((e) => e.isFeatured) ?? edges[0] ?? null;
  const balloonTarget =
    leadEdge && featured.kind !== 'empty'
      ? {
          x: Math.round(((leadEdge.x1 + leadEdge.x2) / 2) * 10) / 10,
          y: Math.round(((leadEdge.y1 + leadEdge.y2) / 2) * 10) / 10,
        }
      : null;

  // Reserve a bounding box above the balloon target so node labels and nodes don't collide with the balloon
  const balloonBox = balloonTarget
    ? {
        x: Math.round(Math.max(12, Math.min(width - 380, balloonTarget.x - 184)) * 10) / 10,
        y: Math.round(Math.max(8, balloonTarget.y - 54) * 10) / 10,
        w: 368,
        h: 42,
      }
    : null;

  // 8-position label placement around each node
  const placedLabels: PlateLabelBox[] = [];
  const nodes: PlateNodeLayout[] = [];

  for (let i = 0; i < nCount; i++) {
    const gi = egoNodeIndices[i]!;
    const node = data.nodes[gi] ?? { path: `file-${gi}`, dir: '.', changes: 1 };
    const text = shortLabels[i]!;
    const fullPath = sanitizeHtmlDisplayText(node.path);
    const nx = Math.round(px[i]! * 10) / 10;
    const ny = Math.round(py[i]! * 10) / 10;
    const r = Math.round(radii[i]! * 10) / 10;
    const labelW = Math.ceil(text.length * 7.6 + 10);
    const labelH = 18;

    // Order the 8 candidates starting with those pointing away from the graph center
    const dxCenter = nx - cx;
    const dyCenter = ny - cy;
    const orderedCandidates = [...CANDIDATE_POSITIONS].sort((posA, posB) => {
      const scoreDir = (pos: LabelCandidatePosition): number => {
        const vx = pos.includes('E') ? 1 : pos.includes('W') ? -1 : 0;
        const vy = pos.includes('S') ? 1 : pos.includes('N') ? -1 : 0;
        return -(vx * dxCenter + vy * dyCenter);
      };
      return scoreDir(posA) - scoreDir(posB);
    });

    let chosen: PlateLabelBox | null = null;
    let bestFallback: { box: PlateLabelBox; penalty: number } | null = null;

    for (const extraOffset of [0, 16, 32]) {
      for (const pos of orderedCandidates) {
        const cand = candidateBoxForPosition(nx, ny, r, labelW, labelH, pos, extraOffset);
        const fullCand: PlateLabelBox = {
          nodeIndex: gi,
          text,
          fullPath,
          ...cand,
        };

        // Check bounds
        const outOfBounds =
          fullCand.x < 6 ||
          fullCand.y < 6 ||
          fullCand.x + fullCand.w > width - 6 ||
          fullCand.y + fullCand.h > height - 6;

        // Check overlap with already placed labels
        const hitsLabel = placedLabels.some((other) => boxesOverlap(fullCand, other, 3));

        // Check overlap with any node circle
        let hitsNode = false;
        for (let j = 0; j < nCount; j++) {
          const ox = px[j]!;
          const oy = py[j]!;
          const or = radii[j]! + 3;
          const nodeBox = { x: ox - or, y: oy - or, w: or * 2, h: or * 2 };
          if (boxesOverlap(fullCand, nodeBox, 1)) {
            hitsNode = true;
            break;
          }
        }

        // Check overlap with featured edge line
        const hitsFeaturedLine =
          leadEdge !== null &&
          boxIntersectsSegment(fullCand, leadEdge.x1, leadEdge.y1, leadEdge.x2, leadEdge.y2);

        // Check overlap with balloon callout box
        const hitsBalloon = balloonBox !== null && boxesOverlap(fullCand, balloonBox, 4);

        if (!outOfBounds && !hitsLabel && !hitsNode && !hitsFeaturedLine && !hitsBalloon) {
          chosen = fullCand;
          break;
        }

        const penalty =
          (hitsLabel ? 1000 : 0) +
          (hitsNode ? 400 : 0) +
          (hitsBalloon ? 350 : 0) +
          (outOfBounds ? 200 : 0) +
          (hitsFeaturedLine ? 80 : 0) +
          extraOffset;
        if (!bestFallback || penalty < bestFallback.penalty) {
          bestFallback = { box: fullCand, penalty };
        }
      }
      if (chosen) break;
    }

    const finalLabel = chosen ?? bestFallback!.box;
    placedLabels.push(finalLabel);
    nodes.push({
      nodeIndex: gi,
      path: fullPath,
      shortLabel: text,
      dir: sanitizeHtmlDisplayText(node.dir),
      changes: node.changes,
      x: nx,
      y: ny,
      r,
      isFeaturedEndpoint: seedSet.has(gi),
      label: finalLabel,
    });
  }

  return {
    width,
    height,
    nodes,
    edges,
    leadEdge,
    balloonTarget,
    balloonBox,
    fullComponentNodeCount,
    truncatedToEgoCap: fullComponentNodeCount > nCount,
    hiddenContextEdges: Math.max(0, rawEgoEdgeIndices.length - egoEdgeIndices.length),
  };
}

