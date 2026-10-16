import { isolateBaselineContext, resolveBaseline, type Context } from '../context.js';
import { branchChanges, mergeChanges, workingTreeChanges, type ChangedFile } from '../git/changes.js';
import type { Relationship } from '../imports/classify.js';
import { compareCompanions, type Companion } from '../model/cochange.js';
import { buildMeta, describeStrength, DISCLAIMER, printEvidence, printHeader, relationshipLabel, toView, type Meta, type RelationshipView } from '../report/views.js';
import { c, plural, terminalText } from '../util/term.js';

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
}

const MERGE_FALLBACK_WARNING =
  'Branch history contains merge commits; using net branch diff without per-commit lineage replay.';

export async function collectChanges(ctx: Context, base?: string): Promise<ChangedFile[]> {
  const lists: ChangedFile[][] = [];
  if (base) {
    const mergeBaseSha = ctx.base === base && ctx.mergeBaseSha !== undefined
      ? ctx.mergeBaseSha
      : await resolveBaseline(ctx.root, base);
    lists.push(
      await branchChanges(ctx.root, mergeBaseSha, {
        onMergeFallback: () => {
          if (!ctx.warnings.includes(MERGE_FALLBACK_WARNING)) {
            ctx.warnings.push(MERGE_FALLBACK_WARNING);
          }
        },
      }),
    );
  }
  lists.push(await workingTreeChanges(ctx.root));
  return mergeChanges(...lists);
}

/** Pure part of `diff`: given the changed files, find historically related files left untouched. */
export function suggestMissing(ctx: Context, changes: ChangedFile[], options: Pick<DiffOptions, 'limit' | 'kinds'>): { changed: ChangedFileView[]; suggestions: Suggestion[] } {
  const { model } = ctx;
  const touched = new Set<string>();
  for (const f of changes) {
    touched.add(f.path);
    if (f.oldPath) touched.add(f.oldPath);
  }

  const changed: ChangedFileView[] = [];
  // Classify and filter every (changed file, partner) link *before* picking the strongest
  // per partner: otherwise a strong import link could hide a weaker but qualifying ghost wire.
  const best = new Map<number, { companion: Companion; fromPath: string; relationship: Relationship; linkedFrom: Set<string> }>();
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
        best.set(companion.to, { companion, fromPath: file.path, relationship, linkedFrom: new Set([file.path]) });
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

  const suggestions: Suggestion[] = [...best.values()]
    .sort((x, y) => compareCompanions(x.companion, y.companion))
    .slice(0, options.limit)
    .map((entry) => ({
      ...toView(ctx, entry.companion, entry.relationship, entry.fromPath),
      alsoLinkedFrom: [...entry.linkedFrom].filter((p) => p !== entry.fromPath),
    }));
  return { changed, suggestions };
}

export async function diff(ctx: Context, options: DiffOptions, changes?: ChangedFile[]): Promise<DiffResult> {
  const effectiveCtx = await isolateBaselineContext(ctx, options.base);
  changes ??= await collectChanges(effectiveCtx, options.base);
  const { changed, suggestions } = suggestMissing(effectiveCtx, changes, options);
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
  return { meta, base: options.base, evaluation, changed, suggestions };
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
    } else {
      console.log(c.green(`✓ Nothing obviously missing: evaluated ${plural(withHistory, 'file')}; no untouched file usually changes alongside ${withHistory === 1 ? 'it' : 'them'}.`));
    }
    return;
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
