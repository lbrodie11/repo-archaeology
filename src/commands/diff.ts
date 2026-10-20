import { isolateBaselineContext, MIN_FULL_HISTORY_COMMITS, resolveBaseline, SHALLOW_WARNING, type Context } from '../context.js';
import { branchChanges, mergeChanges, workingTreeChanges, type ChangedFile } from '../git/changes.js';
import { type Relationship } from '../imports/classify.js';
import { compareCompanions, type Companion } from '../model/cochange.js';
import { buildFindingFamilies, evaluateParallelPair, type FindingFamilyView } from '../model/families.js';
import { buildMeta, describeStrength, DISCLAIMER, printEvidence, printHeader, relationshipLabel, toView, type Meta, type RelationshipView } from '../report/views.js';
import { c, pct, plural, terminalText } from '../util/term.js';

export interface DiffOptions {
  /** Compare the branch against this ref (merge-base) in addition to uncommitted changes. */
  base?: string;
  limit: number;
  kinds: Relationship[];
}

export interface ChangedFileView extends ChangedFile {
  /**
   * Name the file has in the pre-change baseline model (`merge-base` when `--base` is set,
   * or `HEAD` for working-tree-only checks). For files renamed on a branch under `--base`,
   * this holds the pre-branch baseline path rather than the post-rename `HEAD` path.
   */
  historyPath?: string;
  hasHistory: boolean;
}

export interface Suggestion extends RelationshipView {
  /** Other changed files that also point at this suggestion. */
  alsoLinkedFrom: string[];
}

export interface DiffFamilyView extends FindingFamilyView {
  /** Family member paths that were modified in the current changeset. */
  changedMembers: string[];
  /** Untouched family member paths recommended by `diff`. */
  suggestedMembers: string[];
}

export type SilenceReason =
  | 'no_changed_files'
  | 'no_history_for_changed_files'
  | 'no_cochange_partners'
  | 'all_companions_touched'
  | 'filtered_by_kinds'
  | 'filtered_by_thresholds'
  | 'limited_repo_history';

export interface SilenceDiagnostics {
  /** Primary reason why `diff` produced 0 suggestions. */
  primaryReason: SilenceReason;
  /** All reasons supported by the analysis in priority order. */
  reasons: SilenceReason[];
  /** Number of changed files evaluated. */
  changedFiles: number;
  /** Changed files that appear in the pre-change baseline model. */
  changedWithHistory: number;
  /** Changed files in the baseline model with fewer than `minShared` total commits. */
  changedInsufficientHistory: number;
  /** Distinct live files that ever co-changed (`shared >= 1`) with the changed files. */
  rawCompanions: number;
  /** Distinct live files that met `minShared` and `minConfidence` with at least one changed file. */
  qualifyingCompanions: number;
  /** Distinct co-changed companions already included in the changeset. */
  touchedCompanions: number;
  /** Distinct untouched live companions excluded by `minShared` or `minConfidence`. */
  filteredByThreshold: number;
  /** Distinct untouched live companions that met thresholds but were excluded by `--kinds`. */
  filteredByKind: number;
  /** Distinct historical companions that no longer exist in `currentFiles`. */
  deletedCompanions: number;
  /** True when the repository is a shallow clone. */
  shallowHistory: boolean;
  /** True when baseline history is partial or thin (shallow clone, truncated by --max-commits/--since, or <50 usable commits). */
  limitedHistory: boolean;
  /** Usable baseline commits available to the model. */
  commitsAnalyzed: number;
  /** Human-readable explanations supported by the actual analysis. */
  details: string[];
}

export interface DiffEvaluation {
  /** Target branch/ref passed via `--base`, when comparing a branch. */
  targetBranchRef?: string;
  /** Resolved commit SHA of `HEAD`. */
  headSha?: string;
  /** Resolved commit SHA of the unique merge-base (only present when `--base` is set). */
  mergeBaseSha?: string;
  /** Resolved commit SHA used to train the pre-change historical model (`mergeBaseSha` with `--base`, otherwise `headSha`). */
  baselineSha?: string;
  /** Number of usable pre-change commits in the training model. */
  commitsAnalyzed: number;
  effectiveOptions: {
    minShared: number;
    minConfidence: number;
    maxCommits: number;
    maxFilesPerCommit: number;
    halfLifeDays?: number;
    since?: string;
    skipCommits?: string;
  };
}

export interface DiffResult {
  meta: Meta;
  base?: string;
  evaluation?: DiffEvaluation;
  changed: ChangedFileView[];
  suggestions: Suggestion[];
  /** Parallel-implementation finding families formed by the current changeset and qualifying suggestions. */
  families?: DiffFamilyView[];
  /** Present when `suggestions.length === 0`, explaining why no recommendations were emitted. */
  silence?: SilenceDiagnostics;
}

const MERGE_FALLBACK_WARNING =
  'Branch history contains merge commits; using net branch diff without per-commit lineage replay.';

export async function collectChanges(ctx: Context, base?: string, warnings?: string[]): Promise<ChangedFile[]> {
  const lists: ChangedFile[][] = [];
  if (base) {
    const mergeBaseSha = ctx.base === base && ctx.mergeBaseSha !== undefined
      ? ctx.mergeBaseSha
      : await resolveBaseline(ctx.root, base);
    lists.push(
      await branchChanges(ctx.root, mergeBaseSha, {
        onMergeFallback: () => {
          if (warnings && !warnings.includes(MERGE_FALLBACK_WARNING)) {
            warnings.push(MERGE_FALLBACK_WARNING);
          }
        },
      }),
    );
  }
  lists.push(await workingTreeChanges(ctx.root));
  return mergeChanges(...lists);
}

function formatPathSample(paths: Iterable<string>, max = 3): string {
  const list = [...paths];
  if (list.length <= max) return list.join(', ');
  return `${list.slice(0, max).join(', ')}, +${list.length - max} more`;
}

function explainSilence(
  ctx: Context,
  changed: ChangedFileView[],
  touched: ReadonlySet<string>,
  options: Pick<DiffOptions, 'base' | 'kinds'>,
): SilenceDiagnostics {
  const { model, thresholds } = ctx;
  const hasHistoryCount = ctx.history !== undefined;
  const commitsAnalyzed = ctx.history?.commits.length ?? 0;
  const shallowHistory = ctx.shallow ?? (ctx.warnings ?? []).includes(SHALLOW_WARNING);
  const truncatedByMaxCommits = ctx.history?.stats?.truncated === true;
  const limitedBySince = ctx.history?.stats?.truncatedBySince !== undefined
    ? ctx.history.stats.truncatedBySince
    : false;
  const insufficientRepoHistory = hasHistoryCount && commitsAnalyzed < thresholds.minShared;
  const thinRepoHistory =
    hasHistoryCount && commitsAnalyzed >= thresholds.minShared && commitsAnalyzed < MIN_FULL_HISTORY_COMMITS;
  const limitedHistory =
    shallowHistory || truncatedByMaxCommits || limitedBySince || insufficientRepoHistory || thinRepoHistory;
  const withHistory = changed.filter((f) => f.hasHistory && f.historyPath !== undefined);

  const appendLimitedHistoryDetails = (target: string[]) => {
    if (shallowHistory) {
      target.push('Analysis is limited by shallow Git history; run `git fetch --unshallow` for complete baseline history.');
    }
    if (truncatedByMaxCommits) {
      target.push(
        `Analysis is limited by --max-commits (${ctx.settings?.maxCommits ?? commitsAnalyzed}); older repository history was truncated.`,
      );
    }
    if (limitedBySince) {
      target.push(`Analysis is limited by --since (${ctx.settings!.since}); older repository history was excluded.`);
    }
    if (insufficientRepoHistory) {
      target.push(
        `Analysis is limited by insufficient repository history: only ${plural(commitsAnalyzed, 'usable baseline commit')} available (requires --min-shared ${thresholds.minShared}).`,
      );
    } else if (thinRepoHistory) {
      target.push(
        `Analysis is based on a thin baseline history (${plural(commitsAnalyzed, 'usable baseline commit')}, fewer than ${MIN_FULL_HISTORY_COMMITS}).`,
      );
    }
  };

  if (changed.length === 0) {
    const reasons: SilenceReason[] = ['no_changed_files'];
    const details: string[] = [
      options.base
        ? 'No files changed between the baseline and HEAD or in the working tree.'
        : 'No uncommitted changes in the working tree. Use --base <ref> to compare a branch.',
    ];
    if (limitedHistory) {
      reasons.push('limited_repo_history');
      appendLimitedHistoryDetails(details);
    }
    return {
      primaryReason: 'no_changed_files',
      reasons,
      changedFiles: 0,
      changedWithHistory: 0,
      changedInsufficientHistory: 0,
      rawCompanions: 0,
      qualifyingCompanions: 0,
      touchedCompanions: 0,
      filteredByThreshold: 0,
      filteredByKind: 0,
      deletedCompanions: 0,
      shallowHistory,
      limitedHistory,
      commitsAnalyzed,
      details,
    };
  }

  if (withHistory.length === 0) {
    const reasons: SilenceReason[] = [];
    const details: string[] = [
      'None of the changed files appear in the pre-change baseline history (newly added, ignored, or only touched in skipped commits).',
    ];
    const limitedPrimary = shallowHistory || (insufficientRepoHistory && commitsAnalyzed === 0);
    if (limitedPrimary) {
      reasons.push('limited_repo_history', 'no_history_for_changed_files');
    } else {
      reasons.push('no_history_for_changed_files');
      if (limitedHistory) reasons.push('limited_repo_history');
    }
    if (limitedHistory) appendLimitedHistoryDetails(details);
    return {
      primaryReason: reasons[0]!,
      reasons,
      changedFiles: changed.length,
      changedWithHistory: 0,
      changedInsufficientHistory: 0,
      rawCompanions: 0,
      qualifyingCompanions: 0,
      touchedCompanions: 0,
      filteredByThreshold: 0,
      filteredByKind: 0,
      deletedCompanions: 0,
      shallowHistory,
      limitedHistory,
      commitsAnalyzed,
      details,
    };
  }

  let changedInsufficientHistory = 0;
  const rawCompanionSet = new Set<string>();
  const qualifyingCompanionSet = new Set<string>();
  const touchedQualifyingSet = new Set<string>();
  const touchedRawSet = new Set<string>();
  const filteredByKindSet = new Set<string>();
  const filteredByThresholdSet = new Set<string>();
  const deletedSet = new Set<string>();
  const excludedKinds = new Set<Relationship>();
  let maxRejectedShared = 0;
  let maxRejectedConfidence = 0;

  for (const file of withHistory) {
    const id = model.id(file.historyPath!)!;
    const fileCommits = model.changeCount[id] ?? 0;
    if (fileCommits < thresholds.minShared) changedInsufficientHistory++;

    const qualifyingIds = new Set(model.companions(id, thresholds).map((c) => c.to));
    const allCompanions = model.companions(id, { minShared: 1, minConfidence: 0 });
    for (const comp of allCompanions) {
      const target = model.path(comp.to);
      // Check `touched` before `currentFiles` so a companion renamed in this changeset
      // (whose old baseline path is in `touched` via `oldPath`) is recognized as touched, not deleted.
      const isTouched = touched.has(target);
      if (!isTouched && !ctx.currentFiles.has(target)) {
        deletedSet.add(target);
        continue;
      }
      rawCompanionSet.add(target);
      const meetsThresholds = qualifyingIds.has(comp.to);
      if (meetsThresholds) {
        qualifyingCompanionSet.add(target);
        if (isTouched) {
          touchedQualifyingSet.add(target);
          touchedRawSet.add(target);
        } else {
          const rel = ctx.classifier.classify(file.path, target);
          if (!options.kinds.includes(rel)) {
            filteredByKindSet.add(target);
            excludedKinds.add(rel);
          }
        }
      } else if (isTouched) {
        touchedRawSet.add(target);
      } else {
        filteredByThresholdSet.add(target);
        if (comp.stat.count > maxRejectedShared || (comp.stat.count === maxRejectedShared && comp.confidence > maxRejectedConfidence)) {
          maxRejectedShared = comp.stat.count;
          maxRejectedConfidence = comp.confidence;
        }
      }
    }
  }

  for (const target of touchedRawSet) {
    filteredByThresholdSet.delete(target);
    filteredByKindSet.delete(target);
  }
  for (const target of filteredByKindSet) {
    filteredByThresholdSet.delete(target);
  }

  const reasons: SilenceReason[] = [];
  const details: string[] = [];

  if (rawCompanionSet.size === 0) {
    reasons.push('no_cochange_partners');
    if (deletedSet.size > 0) {
      details.push(
        `Evaluated ${plural(withHistory.length, 'changed file')} with history; ${plural(deletedSet.size, 'former co-changed partner')} no longer ${deletedSet.size === 1 ? 'exists' : 'exist'} in the working tree.`,
      );
    } else {
      details.push(
        `Evaluated ${plural(withHistory.length, 'changed file')} with history; no other live file in the baseline model ever co-changed with ${withHistory.length === 1 ? 'it' : 'them'}.`,
      );
    }
  }

  if (filteredByKindSet.size > 0) {
    reasons.push('filtered_by_kinds');
    details.push(
      `${plural(filteredByKindSet.size, 'untouched companion')} (${formatPathSample(filteredByKindSet)}) met co-change thresholds (≥${thresholds.minShared} shared, ≥${pct(thresholds.minConfidence)} confidence) but ${filteredByKindSet.size === 1 ? 'was' : 'were'} excluded by --kinds (${[...excludedKinds].join(', ')}).`,
    );
  }

  if (filteredByThresholdSet.size > 0) {
    reasons.push('filtered_by_thresholds');
    details.push(
      `${plural(filteredByThresholdSet.size, 'untouched co-change partner')} (${formatPathSample(filteredByThresholdSet)}) fell below thresholds (requires ≥${thresholds.minShared} shared and ≥${pct(thresholds.minConfidence)} confidence; strongest was ${maxRejectedShared} shared at ${pct(maxRejectedConfidence)} confidence).`,
    );
    if (changedInsufficientHistory > 0) {
      details.push(
        `${plural(changedInsufficientHistory, 'changed file')} had fewer than ${thresholds.minShared} baseline commits (--min-shared ${thresholds.minShared}), so its companions could not meet the minimum shared-commit threshold.`,
      );
    }
  }

  const nothingFiltered = filteredByKindSet.size === 0 && filteredByThresholdSet.size === 0;
  if (touchedQualifyingSet.size > 0) {
    reasons.push('all_companions_touched');
    const prefix = nothingFiltered ? 'All ' : '';
    details.push(
      `${prefix}${plural(touchedQualifyingSet.size, 'qualifying historical companion')} (${formatPathSample(touchedQualifyingSet)}) ${touchedQualifyingSet.size === 1 ? 'is' : 'are'} already included in this changeset.`,
    );
  } else if (touchedRawSet.size > 0 && nothingFiltered) {
    reasons.push('all_companions_touched');
    details.push(
      `All ${plural(touchedRawSet.size, 'co-changed partner')} (${formatPathSample(touchedRawSet)}) ${touchedRawSet.size === 1 ? 'is' : 'are'} already included in this changeset.`,
    );
  }

  if (limitedHistory) {
    const noSpecificFilterOrTouched =
      nothingFiltered && touchedRawSet.size === 0;
    if ((shallowHistory && !reasons.includes('all_companions_touched')) || (insufficientRepoHistory && noSpecificFilterOrTouched)) {
      reasons.unshift('limited_repo_history');
    } else {
      reasons.push('limited_repo_history');
    }
    appendLimitedHistoryDetails(details);
  }

  const primaryReason: SilenceReason = reasons[0] ?? 'no_cochange_partners';
  return {
    primaryReason,
    reasons,
    changedFiles: changed.length,
    changedWithHistory: withHistory.length,
    changedInsufficientHistory,
    rawCompanions: rawCompanionSet.size,
    qualifyingCompanions: qualifyingCompanionSet.size,
    touchedCompanions: touchedRawSet.size,
    filteredByThreshold: filteredByThresholdSet.size,
    filteredByKind: filteredByKindSet.size,
    deletedCompanions: deletedSet.size,
    shallowHistory,
    limitedHistory,
    commitsAnalyzed,
    details,
  };
}

function buildDiffFamilies(
  ctx: Context,
  changed: ChangedFileView[],
  allSuggestedPaths: readonly string[],
  kinds: Relationship[],
): DiffFamilyView[] {
  if (allSuggestedPaths.length === 0) return [];

  const historyPathByMember = new Map<string, string>();
  const changedSet = new Set<string>();
  for (const f of changed) {
    if (f.deleted || !f.hasHistory || !f.historyPath) continue;
    changedSet.add(f.path);
    historyPathByMember.set(f.path, f.historyPath);
  }
  const suggestedSet = new Set<string>();
  for (const sPath of allSuggestedPaths) {
    suggestedSet.add(sPath);
    if (!historyPathByMember.has(sPath)) {
      historyPathByMember.set(sPath, sPath);
    }
  }

  const candidateMembers = [...new Set([...changedSet, ...suggestedSet])];
  if (candidateMembers.length < 3) return [];

  // Evaluate all parallel-implementation pairs among changed + suggested members in either direction.
  const candidateViews: RelationshipView[] = [];
  for (let i = 0; i < candidateMembers.length; i++) {
    for (let j = i + 1; j < candidateMembers.length; j++) {
      const pathA = candidateMembers[i]!;
      const pathB = candidateMembers[j]!;
      const view = evaluateParallelPair(ctx, pathA, pathB, kinds, historyPathByMember);
      if (view) candidateViews.push(view);
    }
  }
  if (candidateViews.length < 2) return [];

  const rawFamilies = buildFindingFamilies(ctx, candidateViews, { historyPathByMember, allowedKinds: kinds });
  const diffFamilies: DiffFamilyView[] = [];
  for (const fam of rawFamilies) {
    const changedMembers = fam.members.map((m) => m.path).filter((p) => changedSet.has(p));
    const suggestedMembers = fam.members.map((m) => m.path).filter((p) => suggestedSet.has(p));
    if (changedMembers.length === 0 || suggestedMembers.length === 0) continue;
    diffFamilies.push({
      ...fam,
      changedMembers,
      suggestedMembers,
    });
  }
  return diffFamilies;
}

/** Pure part of `diff`: given the changed files, find historically related files left untouched. */
export function suggestMissing(
  ctx: Context,
  changes: ChangedFile[],
  options: Pick<DiffOptions, 'base' | 'limit' | 'kinds'>,
): { changed: ChangedFileView[]; suggestions: Suggestion[]; families: DiffFamilyView[]; silence?: SilenceDiagnostics } {
  const { model } = ctx;
  const touched = new Set<string>();
  for (const f of changes) {
    touched.add(f.path);
    if (f.oldPath) touched.add(f.oldPath);
  }

  const changed: ChangedFileView[] = [];
  // Classify and filter every (changed file, partner) link *before* picking the strongest
  // per partner: otherwise a strong import link could hide a weaker but qualifying ghost wire.
  const best = new Map<
    number,
    {
      companion: Companion;
      fromPath: string;
      relationship: Relationship;
      linkedFrom: Set<string>;
    }
  >();
  for (const file of changes) {
    // The model represents the pre-change baseline (merge-base for `--base`, or `HEAD` for
    // working-tree checks). Any path with `added: true` was created after the baseline: it
    // only has baseline history if it was renamed from `oldPath` (never from `file.path`,
    // which in the baseline model could only belong to an earlier, deleted file).
    const baselinePath = file.added ? file.oldPath : (file.oldPath ?? file.path);
    const historyPath = baselinePath !== undefined && model.id(baselinePath) !== undefined ? baselinePath : undefined;
    if (historyPath) touched.add(historyPath);
    changed.push({ ...file, historyPath, hasHistory: historyPath !== undefined });
    if (historyPath === undefined) continue;
    for (const companion of model.companions(model.id(historyPath)!, ctx.thresholds)) {
      const target = model.path(companion.to);
      if (touched.has(target) || !ctx.currentFiles.has(target)) continue;
      const relationship = ctx.classifier.classify(file.path, target);
      if (!options.kinds.includes(relationship)) continue;
      const existing = best.get(companion.to);
      if (!existing) {
        best.set(companion.to, {
          companion,
          fromPath: file.path,
          relationship,
          linkedFrom: new Set([file.path]),
        });
      } else {
        existing.linkedFrom.add(file.path);
        if (compareCompanions(companion, existing.companion) < 0) {
          existing.companion = companion;
          existing.fromPath = file.path;
          existing.relationship = relationship;
        }
      }
    }
  }

  const allEntries = [...best.values()].sort((x, y) => compareCompanions(x.companion, y.companion));
  const topEntries = allEntries.slice(0, options.limit);
  const suggestions: Suggestion[] = topEntries.map((entry) => ({
    ...toView(ctx, entry.companion, entry.relationship, entry.fromPath),
    alsoLinkedFrom: [...entry.linkedFrom].filter((p) => p !== entry.fromPath),
  }));
  const allSuggestedPaths = allEntries.map((entry) => model.path(entry.companion.to));
  const families = buildDiffFamilies(ctx, changed, allSuggestedPaths, options.kinds);
  const silence = suggestions.length === 0 ? explainSilence(ctx, changed, touched, options) : undefined;
  return { changed, suggestions, families, ...(silence ? { silence } : {}) };
}

export async function diff(ctx: Context, options: DiffOptions, changes?: ChangedFile[]): Promise<DiffResult> {
  const isolatedCtx = await isolateBaselineContext(ctx, options.base);
  const localWarnings = [...isolatedCtx.warnings];
  const effectiveCtx: Context = { ...isolatedCtx, warnings: localWarnings };
  changes ??= await collectChanges(effectiveCtx, options.base, localWarnings);
  const { changed, suggestions, families, silence } = suggestMissing(effectiveCtx, changes, options);
  const meta = buildMeta(effectiveCtx);
  const baselineSha = effectiveCtx.mergeBaseSha ?? effectiveCtx.headSha;
  const evaluation: DiffEvaluation = {
    ...(options.base !== undefined ? { targetBranchRef: options.base } : {}),
    ...(effectiveCtx.headSha !== undefined ? { headSha: effectiveCtx.headSha } : {}),
    ...(options.base !== undefined && effectiveCtx.mergeBaseSha !== undefined ? { mergeBaseSha: effectiveCtx.mergeBaseSha } : {}),
    ...(baselineSha !== undefined ? { baselineSha } : {}),
    commitsAnalyzed: meta.commitsAnalyzed,
    effectiveOptions: {
      minShared: meta.settings.minShared,
      minConfidence: meta.settings.minConfidence,
      maxCommits: meta.settings.maxCommits,
      maxFilesPerCommit: meta.settings.maxFilesPerCommit,
      ...(meta.settings.halfLifeDays !== undefined ? { halfLifeDays: meta.settings.halfLifeDays } : {}),
      ...(meta.settings.since !== undefined ? { since: meta.settings.since } : {}),
      ...(meta.settings.skipCommits !== undefined ? { skipCommits: meta.settings.skipCommits } : {}),
    },
  };
  return {
    meta,
    base: options.base,
    evaluation,
    changed,
    suggestions,
    families,
    ...(silence ? { silence } : {}),
  };
}

export function printDiff(result: DiffResult): void {
  printHeader(result.base ? `diff ${c.dim(`(${result.base}...HEAD + uncommitted changes)`)}` : `diff ${c.dim('(uncommitted changes)')}`, result.meta);
  if (result.changed.length === 0) {
    console.log(result.base ? 'No changes on this branch or in the working tree.' : 'No uncommitted changes. Use --base main to check a whole branch.');
    return;
  }
  const withoutHistory = result.changed.filter((f) => !f.hasHistory).length;
  const withHistory = result.changed.length - withoutHistory;
  const note = withoutHistory > 0 ? c.dim(` (${withoutHistory} new or without usable history)`) : '';
  console.log(`You changed ${plural(result.changed.length, 'file')}${note}.`);
  console.log();
  if (result.suggestions.length === 0) {
    if (withHistory === 0) {
      console.log(c.dim('No suggestions: none of the changed files have usable history to evaluate.'));
      if (result.silence) {
        for (const detail of result.silence.details.slice(1)) {
          console.log(c.dim(`  • ${terminalText(detail)}`));
        }
      }
    } else if (!result.silence) {
      console.log(c.green(`✓ Nothing obviously missing: evaluated ${plural(withHistory, 'file')}; no untouched file usually changes alongside ${withHistory === 1 ? 'it' : 'them'}.`));
    } else {
      console.log(`No suggestions after evaluating ${plural(withHistory, 'file')}:`);
      for (const detail of result.silence.details) {
        console.log(`  • ${terminalText(detail)}`);
      }
      console.log(c.dim('Silence means no untouched file met the active historical criteria; it does not guarantee the change is complete.'));
    }
    return;
  }
  if (result.families && result.families.length > 0) {
    const shownSuggested = new Set(result.suggestions.map((s) => s.to));
    console.log(c.bold(`Finding families (${result.families.length})`));
    for (const fam of result.families) {
      const pairNote = fam.complete
        ? `all ${fam.possiblePairs} pairwise links met thresholds`
        : `${fam.qualifyingPairs} of ${fam.possiblePairs} pairwise links met thresholds`;
      const suggestedLabels = fam.suggestedMembers.map((p) =>
        shownSuggested.has(p) ? c.bold(terminalText(p)) : `${c.bold(terminalText(p))} ${c.dim('(beyond --limit)')}`,
      );
      console.log(
        `  ${c.bold(terminalText(fam.label))} — changed ${fam.changedMembers.map(terminalText).join(', ')}; check ${suggestedLabels.join(', ')} ${c.dim(`(${pairNote} · ${plural(fam.commitsTouchingTwoOrMore, 'supporting commit')} (2+ members via a qualifying pair))`)}`,
      );
    }
    console.log();
  }
  console.log(c.bold(`Possibly missed (${result.suggestions.length})`));
  console.log();
  for (const s of result.suggestions) {
    console.log(`  ${c.bold(terminalText(s.to))}  ${relationshipLabel(s.relationship)}`);
    console.log(`    changed with ${terminalText(s.from)} in ${describeStrength(s)}`);
    if (s.alsoLinkedFrom.length > 0) console.log(c.dim(`    also linked to: ${s.alsoLinkedFrom.map(terminalText).join(', ')}`));
    console.log(c.dim(`    ${terminalText(s.why)}`));
    printEvidence(s);
    console.log();
  }
  console.log(c.dim(DISCLAIMER));
}
