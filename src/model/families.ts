import { posix } from 'node:path';
import type { Context } from '../context.js';
import { isProjectConfig, isTestFile, parallelImplementation, RELATIONSHIPS, type Relationship } from '../imports/classify.js';
import { EVIDENCE_LIMIT, type Companion } from './cochange.js';
import { toView, type EvidenceView, type RelationshipView } from '../report/views.js';
import { wilsonLowerBound } from '../util/stats.js';
import { isoDate, plural } from '../util/term.js';

export interface FamilyEvidenceView extends EvidenceView {
  /** Number of family member files modified in this commit (at least 2). */
  membersTouched: number;
  /** Total number of member files in the family. */
  totalMembers: number;
  /** True when every member of the family was modified in this commit. */
  touchesAllMembers: boolean;
  /** Member file paths (in canonical family member order) modified in this commit. */
  memberPaths: string[];
}

export interface FindingFamilyMember {
  /** Canonical repository-relative path of the member file. */
  path: string;
  /** Directory of the member file (`posix.dirname(path)`). */
  dir: string;
  /** Sibling directory name distinguishing this implementation under `parentDir` (e.g. `bun`, `deno`). */
  variant: string;
  /** Total commits touching this file in the analyzed history. */
  changes: number;
  /** Number of qualifying pairwise relationships in this family that involve this member. */
  connections: number;
}

export interface FindingFamilyView {
  /** Deterministic identifier (e.g. `src/adapter/{*}/serve-static`). */
  id: string;
  /** Concise descriptive label (e.g. `serve-static.ts across src/adapter/{*}`). */
  label: string;
  /** Shared implementation stem without extension (e.g. `serve-static`). */
  stem: string;
  /** Display filename(s) (e.g. `serve-static.ts`, or `App.tsx / App.jsx` when extensions differ). */
  fileName: string;
  /** Shared parent directory containing the sibling implementation folders (`.` when at repo top-level folders). */
  parentDir: string;
  /** Human-readable explanation of why these files were grouped into a family. */
  why: string;
  /** Member files (always >= 3), deterministically ordered by `path`. */
  members: FindingFamilyMember[];
  /**
   * Unique historical commits in the analyzed model supporting the family
   * (touching at least 2 member files that form a qualifying pair).
   */
  commitsTouchingTwoOrMore: number;
  /** Unique historical commits in the analyzed model touching all member files. */
  commitsTouchingAll: number;
  /** ISO date (`YYYY-MM-DD`) of the most recent qualifying shared commit in the family. */
  lastTogether: string;
  /** Number of qualifying pairwise relationships present in `relationships`. */
  qualifyingPairs: number;
  /** Total possible pairwise combinations among `members` (`n * (n - 1) / 2`). */
  possiblePairs: number;
  /** True when all `possiblePairs` met thresholds (`qualifyingPairs === possiblePairs`). */
  complete: boolean;
  /** Distinct relationship kinds present among the qualifying pairwise relationships. */
  relationshipKinds: Relationship[];
  /** Highest pairwise ranking score (`score`) among `relationships`, used for deterministic ordering. */
  peakScore: number;
  /** Highest pairwise `shared` commit count among `relationships`. */
  maxPairShared: number;
  /** Most recent commits touching 2 or more family members (annotated with `touchesAllMembers` and `memberPaths`). */
  evidence: FamilyEvidenceView[];
  /** Most recent commits that touched every member of the family. */
  allMemberEvidence: FamilyEvidenceView[];
  /** Complete set of qualifying pairwise relationships in this family (never fabricates missing pairs). */
  relationships: RelationshipView[];
}

export interface BuildFindingFamiliesOptions {
  /**
   * Optional mapping from a member's current path to its identity in `ctx.model`
   * (used by `diff` when a file was renamed on a branch or in the working tree).
   */
  historyPathByMember?: ReadonlyMap<string, string>;
  /**
   * Optional allowed relationship kinds when completing missing member pairs against `ctx.model`.
   */
  allowedKinds?: readonly Relationship[];
  /**
   * Optional map populated with the sorted member index arrays for every qualifying commit per family ID.
   */
  commitMemberIndicesByFamily?: Map<string, number[][]>;
  /**
   * When true, include relationships silenced by `"expected"` verdicts when forming and completing families.
   */
  showSilenced?: boolean;
}

const EXTENDED_FAMILY_CONFIG = /^[\w.-]+\.config-[\w.-]+\.[cm]?[jt]s$/i;

const GENERIC_SAME_DIR_SUFFIXES = new Set([
  'only',
  'mid',
  'final',
  'old',
  'new',
  'test',
  'tests',
  'spec',
  'specs',
  'e2e',
  'mock',
  'mocks',
  'fixture',
  'fixtures',
  'index',
  'main',
  'app',
  'core',
  'base',
  'common',
  'shared',
  'default',
  'type',
  'types',
  'util',
  'utils',
  'helper',
  'helpers',
  'config',
  'configs',
  'constant',
  'constants',
  'service',
  'services',
  'controller',
  'controllers',
  'handler',
  'handlers',
  'route',
  'routes',
  'router',
  'slice',
  'slices',
  'store',
  'stores',
  'state',
  'model',
  'models',
  'schema',
  'schemas',
  'view',
  'views',
  'page',
  'pages',
  'card',
  'cards',
  'modal',
  'modals',
  'dialog',
  'dialogs',
  'button',
  'buttons',
  'input',
  'inputs',
  'form',
  'forms',
  'table',
  'tables',
  'list',
  'lists',
  'item',
  'items',
  'field',
  'fields',
  'filter',
  'filters',
  'hook',
  'hooks',
  'context',
  'provider',
  'providers',
  'client',
  'clients',
  'server',
  'adapter',
  'adapters',
  'middleware',
  'plugin',
  'plugins',
  'action',
  'actions',
  'reducer',
  'reducers',
  'selector',
  'selectors',
  'query',
  'queries',
  'mutation',
  'mutations',
  'widget',
  'widgets',
  'panel',
  'panels',
  'layout',
  'layouts',
  'section',
  'sections',
]);

function isFamilyConfig(path: string): boolean {
  return isProjectConfig(path) || EXTENDED_FAMILY_CONFIG.test(posix.basename(path));
}

/**
 * Returns the shared `*-<suffix>` pattern (e.g. `*-picker`) when two files in the same
 * directory share a descriptive hyphenated suffix (`>= 3` letters) and extension (such as
 * `accent-picker.tsx`, `menu-picker.tsx`, and `picker.tsx`), or `undefined` otherwise.
 */
export function sameDirectorySuffixFamilyStem(pathA: string, pathB: string): string | undefined {
  if (isFamilyConfig(pathA) || isFamilyConfig(pathB) || isTestFile(pathA) || isTestFile(pathB)) {
    return undefined;
  }
  const dirA = posix.dirname(pathA);
  const dirB = posix.dirname(pathB);
  if (dirA !== dirB) return undefined;
  const extA = posix.extname(pathA);
  const extB = posix.extname(pathB);
  if (!extA || extA.toLowerCase() !== extB.toLowerCase()) return undefined;
  const stemA = fileStem(pathA);
  const stemB = fileStem(pathB);
  if (!stemA || !stemB || stemA === stemB) return undefined;
  const partsA = stemA.split('-').filter(Boolean);
  const partsB = stemB.split('-').filter(Boolean);
  if (partsA.length < 2 && partsB.length < 2) return undefined;
  const lastA = partsA[partsA.length - 1]!.toLowerCase();
  const lastB = partsB[partsB.length - 1]!.toLowerCase();
  if (lastA !== lastB) return undefined;
  if (!/^[a-z]{3,}$/.test(lastA) || GENERIC_SAME_DIR_SUFFIXES.has(lastA)) return undefined;
  return `*-${lastA}`;
}

export function isEligibleFamilyPair(pathA: string, pathB: string): boolean {
  return (
    parallelImplementation(pathA, pathB) !== undefined ||
    sameDirectorySuffixFamilyStem(pathA, pathB) !== undefined
  );
}

/**
 * Evaluates whether two parallel-implementation paths qualify in either direction (`A -> B` or `B -> A`)
 * against `ctx.model` and `ctx.thresholds`, returning the canonical `RelationshipView` when they do.
 */
export function evaluateParallelPair(
  ctx: Context,
  pathA: string,
  pathB: string,
  allowedKinds?: readonly Relationship[],
  historyPathByMember?: ReadonlyMap<string, string>,
  excludeSilenced = false,
): RelationshipView | undefined {
  if (isFamilyConfig(pathA) || isFamilyConfig(pathB)) return undefined;
  if (!isEligibleFamilyPair(pathA, pathB)) return undefined;
  const { model, thresholds } = ctx;
  const histA = historyPathByMember?.get(pathA) ?? pathA;
  const histB = historyPathByMember?.get(pathB) ?? pathB;
  const idA = model.id(histA);
  const idB = model.id(histB);
  if (idA === undefined || idB === undefined || idA === idB) return undefined;
  const stat = model.pair(idA, idB);
  if (!stat || model.effectiveShared(stat) + 1e-9 < thresholds.minShared) return undefined;
  const confAB = model.confidence(stat, idA);
  const confBA = model.confidence(stat, idB);
  const passAB = confAB >= thresholds.minConfidence;
  const passBA = confBA >= thresholds.minConfidence;
  const allowAB = passAB && !(excludeSilenced && ctx.verdicts?.match(pathA, pathB)?.kind === 'expected');
  const allowBA = passBA && !(excludeSilenced && ctx.verdicts?.match(pathB, pathA)?.kind === 'expected');
  if (!allowAB && !allowBA) return undefined;
  const rel = ctx.classifier.classify(pathA, pathB);
  if (allowedKinds && !allowedKinds.includes(rel)) return undefined;

  const scoreAB = wilsonLowerBound(confAB, model.effectiveChanges(idA));
  const scoreBA = wilsonLowerBound(confBA, model.effectiveChanges(idB));
  const forward = allowAB && (!allowBA || scoreAB > scoreBA || (scoreAB === scoreBA && confAB >= confBA));
  const companion: Companion = forward
    ? { from: idA, to: idB, stat, confidence: confAB, reverseConfidence: confBA, score: scoreAB }
    : { from: idB, to: idA, stat, confidence: confBA, reverseConfidence: confAB, score: scoreBA };
  const [fromPath, toPath] = forward ? [pathA, pathB] : [pathB, pathA];
  return toView(ctx, companion, rel, fromPath, toPath);
}

function fileStem(path: string): string {
  return posix.basename(path).replace(/\.[^.]+$/, '');
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareRelationshipViews(a: RelationshipView, b: RelationshipView): number {
  return (
    b.score - a.score
    || b.shared - a.shared
    || compareStrings(b.lastTogether, a.lastTogether)
    || compareStrings(a.from, b.from)
    || compareStrings(a.to, b.to)
  );
}

export function compareFindingFamilies(a: FindingFamilyView, b: FindingFamilyView): number {
  return (
    b.peakScore - a.peakScore
    || b.commitsTouchingTwoOrMore - a.commitsTouchingTwoOrMore
    || b.commitsTouchingAll - a.commitsTouchingAll
    || b.members.length - a.members.length
    || compareStrings(b.lastTogether, a.lastTogether)
    || compareStrings(a.id, b.id)
  );
}

interface CandidateFamily {
  id: string;
  stem: string;
  parentDir: string;
  sameDirSuffix?: boolean;
  memberPaths: string[];
  pairs: RelationshipView[];
}

interface RankedCommitEvidence {
  commitIdx: number;
  memberIndices: number[];
}

/**
 * Groups qualifying pairwise relationships into Finding Families.
 *
 * Rules:
 * - Only pairs satisfying `parallelImplementation(from, to)` are eligible.
 * - Pairs are partitioned by `(parentDir, stem)` so files sharing only a basename across
 *   unrelated directory depths or high-churn hubs can never merge into a family.
 * - Within each `(parentDir, stem)` bucket, connected components formed strictly by the
 *   qualifying parallel pairs are extracted; a family requires at least 3 distinct files
 *   across at least 3 distinct sibling directories.
 * - Incomplete triangles (e.g. A–B and B–C without A–C) are preserved with their exact
 *   qualifying pairs (`qualifyingPairs < possiblePairs`) without fabricating missing pairs.
 * - Unique commit counts (`commitsTouchingTwoOrMore`, `commitsTouchingAll`) are computed
 *   in a single pass over `ctx.model.commits` rather than summing pairwise counts.
 */
export function buildFindingFamilies(
  ctx: Pick<Context, 'model'> & Partial<Pick<Context, 'thresholds' | 'classifier' | 'settings' | 'verdicts'>>,
  relationships: readonly RelationshipView[],
  options: BuildFindingFamiliesOptions = {},
): FindingFamilyView[] {
  const { model } = ctx;
  const { historyPathByMember, allowedKinds, commitMemberIndicesByFamily, showSilenced } = options;
  const excludeSilenced = !showSilenced;
  const canEvaluateModelPairs =
    allowedKinds !== undefined
    && ctx.thresholds !== undefined
    && ctx.classifier !== undefined
    && ctx.settings !== undefined;

  // 1. Deduplicate qualifying parallel-implementation and same-directory suffix pairs by unordered file pair.
  const bestPairByKey = new Map<string, RelationshipView>();
  for (const rel of relationships) {
    if (isFamilyConfig(rel.from) || isFamilyConfig(rel.to)) continue;
    if (!isEligibleFamilyPair(rel.from, rel.to)) continue;
    if (allowedKinds && !allowedKinds.includes(rel.relationship)) continue;
    if (
      excludeSilenced
      && (rel.verdict?.kind === 'expected' || ctx.verdicts?.match(rel.from, rel.to)?.kind === 'expected')
    ) {
      continue;
    }
    const [u, v] = rel.from < rel.to ? [rel.from, rel.to] : [rel.to, rel.from];
    const key = `${u}\u0000${v}`;
    const existing = bestPairByKey.get(key);
    if (!existing || compareRelationshipViews(rel, existing) < 0) {
      bestPairByKey.set(key, rel);
    }
  }
  if (bestPairByKey.size < 2) return [];

  // 2. Partition pairs by structural `(parentDir, stem)` key.
  const buckets = new Map<
    string,
    { parentDir: string; stem: string; sameDirSuffix: boolean; pairs: RelationshipView[] }
  >();
  for (const rel of bestPairByKey.values()) {
    const suffixStem = parallelImplementation(rel.from, rel.to)
      ? undefined
      : sameDirectorySuffixFamilyStem(rel.from, rel.to);
    const sameDirSuffix = suffixStem !== undefined;
    const parentDir = sameDirSuffix ? posix.dirname(rel.from) : posix.dirname(posix.dirname(rel.from));
    const stem = suffixStem ?? fileStem(rel.from);
    const bucketKey = `${sameDirSuffix ? '1' : '0'}\u0000${parentDir}\u0000${stem}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = { parentDir, stem, sameDirSuffix, pairs: [] };
      buckets.set(bucketKey, bucket);
    }
    bucket.pairs.push(rel);
  }

  // 3. Extract connected components of size >= 3 within each `(parentDir, stem)` bucket.
  const candidates: CandidateFamily[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.pairs.length < 2) continue;
    const adj = new Map<string, Set<string>>();
    for (const rel of bucket.pairs) {
      let fromSet = adj.get(rel.from);
      if (!fromSet) {
        fromSet = new Set();
        adj.set(rel.from, fromSet);
      }
      fromSet.add(rel.to);

      let toSet = adj.get(rel.to);
      if (!toSet) {
        toSet = new Set();
        adj.set(rel.to, toSet);
      }
      toSet.add(rel.from);
    }

    const allNodes = [...adj.keys()].sort(compareStrings);
    const visited = new Set<string>();
    const bucketComponents: { memberPaths: string[]; pairs: RelationshipView[] }[] = [];

    for (const start of allNodes) {
      if (visited.has(start)) continue;
      const compNodes: string[] = [];
      const queue: string[] = [start];
      visited.add(start);
      while (queue.length > 0) {
        const curr = queue.shift()!;
        compNodes.push(curr);
        const neighbours = [...(adj.get(curr) ?? [])].sort(compareStrings);
        for (const next of neighbours) {
          if (!visited.has(next)) {
            visited.add(next);
            queue.push(next);
          }
        }
      }
      compNodes.sort(compareStrings);
      const distinctDirs = new Set(compNodes.map((p) => posix.dirname(p)));
      if (compNodes.length < 3) continue;
      if (!bucket.sameDirSuffix && distinctDirs.size < 3) continue;

      const nodeSet = new Set(compNodes);
      const compPairs = bucket.pairs.filter((rel) => nodeSet.has(rel.from) && nodeSet.has(rel.to));
      if (canEvaluateModelPairs) {
        const existingPairKeys = new Set(
          compPairs.map((r) => (r.from < r.to ? `${r.from}\u0000${r.to}` : `${r.to}\u0000${r.from}`)),
        );
        for (let i = 0; i < compNodes.length; i++) {
          for (let j = i + 1; j < compNodes.length; j++) {
            const pathA = compNodes[i]!;
            const pathB = compNodes[j]!;
            const key = `${pathA}\u0000${pathB}`;
            if (existingPairKeys.has(key)) continue;
            const extraView = evaluateParallelPair(
              ctx as Context,
              pathA,
              pathB,
              allowedKinds,
              historyPathByMember,
              excludeSilenced,
            );
            if (extraView) {
              compPairs.push(extraView);
              existingPairKeys.add(key);
            }
          }
        }
      }
      compPairs.sort(compareRelationshipViews);
      if (compPairs.length < (bucket.sameDirSuffix ? 3 : 2)) continue;
      bucketComponents.push({ memberPaths: compNodes, pairs: compPairs });
    }

    bucketComponents.sort((a, b) => compareStrings(a.memberPaths[0]!, b.memberPaths[0]!));
    const baseId = bucket.sameDirSuffix
      ? (bucket.parentDir === '.' ? bucket.stem : `${bucket.parentDir}/${bucket.stem}`)
      : (bucket.parentDir === '.' ? `*/${bucket.stem}` : `${bucket.parentDir}/*/${bucket.stem}`);
    bucketComponents.forEach((comp, idx) => {
      const firstVariant = bucket.sameDirSuffix
        ? fileStem(comp.memberPaths[0]!)
        : posix.basename(posix.dirname(comp.memberPaths[0]!));
      const id = bucketComponents.length === 1 ? baseId : `${baseId}#${firstVariant || idx + 1}`;
      candidates.push({
        id,
        stem: bucket.stem,
        parentDir: bucket.parentDir,
        sameDirSuffix: bucket.sameDirSuffix,
        memberPaths: comp.memberPaths,
        pairs: comp.pairs,
      });
    });
  }

  if (candidates.length === 0) return [];

  // 4. Single-pass scan over `model.commits` to compute exact family-wide commit statistics.
  const familiesByFileId = new Map<number, Array<{ familyIdx: number; memberIdx: number }>>();
  const statsByFamily = candidates.map((cand) => {
    const qualifyingMemberPairs = new Set<string>();
    const indexByPath = new Map<string, number>();
    cand.memberPaths.forEach((p, idx) => indexByPath.set(p, idx));
    for (const rel of cand.pairs) {
      const ia = indexByPath.get(rel.from);
      const ib = indexByPath.get(rel.to);
      if (ia !== undefined && ib !== undefined) {
        const lo = Math.min(ia, ib);
        const hi = Math.max(ia, ib);
        qualifyingMemberPairs.add(`${lo}:${hi}`);
      }
    }
    return {
      commitsTouchingTwoOrMore: 0,
      commitsTouchingAll: 0,
      lastQualifyingTime: 0,
      qualifyingMemberPairs,
      commitMemberIndices: [] as number[][],
      topEvidence: [] as RankedCommitEvidence[],
      topAllMemberEvidence: [] as RankedCommitEvidence[],
    };
  });

  candidates.forEach((cand, familyIdx) => {
    cand.memberPaths.forEach((memberPath, memberIdx) => {
      const histPath = historyPathByMember?.get(memberPath) ?? memberPath;
      const fid = model.id(histPath);
      if (fid === undefined) return;
      let list = familiesByFileId.get(fid);
      if (!list) {
        list = [];
        familiesByFileId.set(fid, list);
      }
      list.push({ familyIdx, memberIdx });
    });
  });

  const commits = model.commits;
  const timeOf = (i: number) => commits[i]!.time;
  const tieOf = (i: number) => commits[i]!.commitTime;

  const insertEvidence = (list: RankedCommitEvidence[], entry: RankedCommitEvidence) => {
    const last = list[list.length - 1];
    if (
      list.length >= EVIDENCE_LIMIT
      && last !== undefined
      && (timeOf(entry.commitIdx) < timeOf(last.commitIdx)
        || (timeOf(entry.commitIdx) === timeOf(last.commitIdx) && tieOf(entry.commitIdx) <= tieOf(last.commitIdx)))
    ) {
      return;
    }
    list.push(entry);
    list.sort(
      (x, y) =>
        timeOf(y.commitIdx) - timeOf(x.commitIdx)
        || tieOf(y.commitIdx) - tieOf(x.commitIdx)
        || x.commitIdx - y.commitIdx,
    );
    if (list.length > EVIDENCE_LIMIT) list.length = EVIDENCE_LIMIT;
  };

  if (familiesByFileId.size > 0) {
    const touchedByFamily = new Map<number, number[]>();
    for (let commitIdx = 0; commitIdx < commits.length; commitIdx++) {
      const commit = commits[commitIdx]!;
      touchedByFamily.clear();
      for (const fIdentity of commit.files) {
        const fid = model.id(fIdentity);
        if (fid === undefined) continue;
        const refs = familiesByFileId.get(fid);
        if (!refs) continue;
        for (const ref of refs) {
          let members = touchedByFamily.get(ref.familyIdx);
          if (!members) {
            members = [];
            touchedByFamily.set(ref.familyIdx, members);
          }
          if (!members.includes(ref.memberIdx)) {
            members.push(ref.memberIdx);
          }
        }
      }
      if (touchedByFamily.size === 0) continue;

      for (const [familyIdx, memberIndices] of touchedByFamily) {
        if (memberIndices.length < 2) continue;
        memberIndices.sort((a, b) => a - b);
        const st = statsByFamily[familyIdx]!;
        const cand = candidates[familyIdx]!;

        let touchesQualifyingPair = false;
        for (let i = 0; i < memberIndices.length && !touchesQualifyingPair; i++) {
          for (let j = i + 1; j < memberIndices.length; j++) {
            if (st.qualifyingMemberPairs.has(`${memberIndices[i]!}:${memberIndices[j]!}`)) {
              touchesQualifyingPair = true;
              break;
            }
          }
        }
        if (!touchesQualifyingPair) continue;

        st.commitsTouchingTwoOrMore++;
        st.lastQualifyingTime = Math.max(st.lastQualifyingTime, commit.time);
        st.commitMemberIndices.push(memberIndices);

        const entry: RankedCommitEvidence = { commitIdx, memberIndices };
        insertEvidence(st.topEvidence, entry);
        if (memberIndices.length === cand.memberPaths.length) {
          st.commitsTouchingAll++;
          insertEvidence(st.topAllMemberEvidence, entry);
        }
      }
    }
  }

  // 5. Build deterministic `FindingFamilyView` objects.
  const results: FindingFamilyView[] = candidates.map((cand, familyIdx) => {
    const st = statsByFamily[familyIdx]!;
    commitMemberIndicesByFamily?.set(cand.id, st.commitMemberIndices);
    const totalMembers = cand.memberPaths.length;
    const possiblePairs = (totalMembers * (totalMembers - 1)) / 2;
    const qualifyingPairs = cand.pairs.length;
    const complete = qualifyingPairs === possiblePairs;

    // Count connections per member and disambiguate variants if two files ever share a folder.
    const connectionsByPath = new Map<string, number>();
    for (const p of cand.memberPaths) connectionsByPath.set(p, 0);
    for (const rel of cand.pairs) {
      connectionsByPath.set(rel.from, (connectionsByPath.get(rel.from) ?? 0) + 1);
      connectionsByPath.set(rel.to, (connectionsByPath.get(rel.to) ?? 0) + 1);
    }

    const suffixToken = cand.sameDirSuffix && cand.stem.startsWith('*-') ? cand.stem.slice(1).toLowerCase() : '';
    const rawVariants = cand.memberPaths.map((p) => {
      if (cand.sameDirSuffix && suffixToken) {
        const s = fileStem(p);
        if (s.toLowerCase().endsWith(suffixToken) && s.length > suffixToken.length) {
          return s.slice(0, s.length - suffixToken.length);
        }
        return s;
      }
      return posix.basename(posix.dirname(p));
    });
    const variantCounts = new Map<string, number>();
    for (const v of rawVariants) variantCounts.set(v, (variantCounts.get(v) ?? 0) + 1);

    const members: FindingFamilyMember[] = cand.memberPaths.map((memberPath, idx) => {
      const dir = posix.dirname(memberPath);
      const rawVariant = rawVariants[idx]!;
      const variant = (variantCounts.get(rawVariant) ?? 0) > 1
        ? `${rawVariant} (${posix.basename(memberPath)})`
        : rawVariant;
      const histPath = historyPathByMember?.get(memberPath) ?? memberPath;
      const fid = model.id(histPath);
      const changes = fid !== undefined ? (model.changeCount[fid] ?? 0) : 0;
      return {
        path: memberPath,
        dir,
        variant,
        changes,
        connections: connectionsByPath.get(memberPath) ?? 0,
      };
    });

    const basenames = [...new Set(cand.memberPaths.map((p) => posix.basename(p)))];
    const fileName = cand.sameDirSuffix
      ? `${cand.stem}${posix.extname(cand.memberPaths[0]!) || ''}`
      : basenames.length === 1
        ? basenames[0]!
        : basenames.join(' / ');
    const suffixLabel = cand.sameDirSuffix && cand.stem.startsWith('*-') ? cand.stem.slice(1) : cand.stem;
    const label = cand.sameDirSuffix
      ? (cand.parentDir === '.' ? `${fileName} in root` : `${fileName} in ${cand.parentDir}`)
      : (cand.parentDir === '.' ? `${fileName} across sibling folders` : `${fileName} across ${cand.parentDir}/*`);

    const variantsList = members.map((m) => m.variant).join(', ');
    const pairsPhrase = complete
      ? `all ${possiblePairs} pairwise links meet thresholds`
      : `${qualifyingPairs} of ${possiblePairs} pairwise links meet thresholds`;
    const commitsPhrase = `${plural(st.commitsTouchingTwoOrMore, 'supporting commit')} (2+ members via a qualifying pair), ${st.commitsTouchingAll} touched all ${totalMembers}`;
    const why = cand.sameDirSuffix
      ? `${totalMembers} files sharing the ${suffixLabel} suffix in ${cand.parentDir === '.' ? 'root' : cand.parentDir} (${variantsList}); ${pairsPhrase} (${commitsPhrase})`
      : `${totalMembers} parallel implementations of ${fileName} in sibling folders (${variantsList}); ${pairsPhrase} (${commitsPhrase})`;

    const presentKinds = new Set<Relationship>(cand.pairs.map((p) => p.relationship));
    const relationshipKinds = RELATIONSHIPS.filter((k) => presentKinds.has(k));

    const peakScore = round(Math.max(...cand.pairs.map((p) => p.score), 0));
    const maxPairShared = Math.max(...cand.pairs.map((p) => p.shared), 0);
    const lastTogether = st.lastQualifyingTime > 0
      ? isoDate(st.lastQualifyingTime)
      : (cand.pairs[0]?.lastTogether ?? '');

    const toFamilyEvidence = (entry: RankedCommitEvidence): FamilyEvidenceView => {
      const commit = commits[entry.commitIdx]!;
      const memberPaths = entry.memberIndices.map((mi) => cand.memberPaths[mi]!);
      return {
        hash: commit.hash,
        date: isoDate(commit.time),
        author: commit.author,
        subject: commit.subject,
        origin: commit.origin ?? 'human',
        membersTouched: memberPaths.length,
        totalMembers,
        touchesAllMembers: memberPaths.length === totalMembers,
        memberPaths,
      };
    };

    return {
      id: cand.id,
      label,
      stem: cand.stem,
      fileName,
      parentDir: cand.parentDir,
      why,
      members,
      commitsTouchingTwoOrMore: st.commitsTouchingTwoOrMore,
      commitsTouchingAll: st.commitsTouchingAll,
      lastTogether,
      qualifyingPairs,
      possiblePairs,
      complete,
      relationshipKinds,
      peakScore,
      maxPairShared,
      evidence: st.topEvidence.map(toFamilyEvidence),
      allMemberEvidence: st.topAllMemberEvidence.map(toFamilyEvidence),
      relationships: cand.pairs,
    };
  });

  return results.sort(compareFindingFamilies);
}
