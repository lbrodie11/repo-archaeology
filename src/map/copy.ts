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
import {
  computePlateLayout,
  MAX_EGO_NODES,
  PLATE_WIDTH,
  type FeaturedPlateLayout,
  type PlateFocus,
} from './plate-layout.js';

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
 * Formats the contributor concentration note when `topAuthorShare >= 0.4`. The note never names the
 * contributor: map reports are meant to be shared, and the share alone is the useful signal.
 */
export function formatOwnerNote(
  node: Pick<MapNode, 'path' | 'topAuthor' | 'topAuthorShare'>,
  shortLabel?: string,
): string | null {
  if (!node.topAuthor || typeof node.topAuthorShare !== 'number' || node.topAuthorShare < 0.4) {
    return null;
  }
  const pct = Math.round(node.topAuthorShare * 100);
  const label = shortLabel ?? (posix.basename(sanitizeHtmlDisplayText(node.path)) || sanitizeHtmlDisplayText(node.path));
  return `One contributor made ${pct}% of ${label} commits`;
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

export type {
  FeaturedPlateLayout,
  LabelCandidatePosition,
  PlateEdgeLayout,
  PlateGroup,
  PlateLabelBox,
  PlateMetrics,
  PlateMode,
  PlateNodeLayout,
  PlateOverflowItem,
} from './plate-layout.js';
export { COMPACT_CONTEXT_NODES, MAX_EGO_NODES, PLATE_WIDTH } from './plate-layout.js';

/**
 * Lays out the featured finding's blueprint plate with the shared pair-centered engine
 * (`src/map/plate-layout.ts`), the same code the rich map runs in the browser after a click.
 * Widths below the desktop minimum (560) use the compact (phone) composition.
 */
export function computeFeaturedPlateLayout(
  data: MapData,
  featured: FeaturedFinding,
  options?: {
    width?: number;
    visible?: Partial<Record<Relationship, boolean>>;
    previous?: readonly { nodeIndex: number; x: number }[];
  },
): FeaturedPlateLayout {
  const visible: Partial<Record<Relationship, boolean>> = options?.visible ?? {
    ghost: eDefaultVisible(data, 'ghost'),
    unknown: eDefaultVisible(data, 'unknown'),
    indirect: eDefaultVisible(data, 'indirect'),
    direct: eDefaultVisible(data, 'direct'),
    test: eDefaultVisible(data, 'test'),
  };
  const focus: PlateFocus =
    featured.kind === 'family'
      ? {
          seeds: featured.family.nodeIndices,
          leadEdge: featured.leadEdgeIndex,
          featuredEdges: featured.family.edgeIndices,
        }
      : featured.kind === 'pair'
        ? {
            seeds: [featured.edge.source, featured.edge.target],
            leadEdge: featured.edgeIndex,
            featuredEdges: [featured.edgeIndex],
          }
        : { seeds: featured.contextClusterNodeIndices.slice(0, MAX_EGO_NODES), leadEdge: null, featuredEdges: [] };
  const width = options?.width ?? PLATE_WIDTH.desktop.max;
  return computePlateLayout(data, focus, {
    mode: width < PLATE_WIDTH.desktop.min ? 'compact' : 'desktop',
    width,
    visible,
    previous: options?.previous,
  });
}

