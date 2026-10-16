import type { Context } from '../context.js';
import { UsageError } from '../context.js';
import { branchChanges, mergeChanges, workingTreeChanges, type ChangedFile } from '../git/changes.js';
import { refExists } from '../git/repo.js';
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
  /** Name the file has in history (differs from `path` for uncommitted renames). */
  historyPath?: string;
  hasHistory: boolean;
}

export interface Suggestion extends RelationshipView {
  /** Other changed files that also point at this suggestion. */
  alsoLinkedFrom: string[];
}

export interface DiffResult {
  meta: Meta;
  base?: string;
  changed: ChangedFileView[];
  suggestions: Suggestion[];
}

export async function collectChanges(ctx: Context, base?: string): Promise<ChangedFile[]> {
  const lists: ChangedFile[][] = [];
  if (base) {
    if (!(await refExists(ctx.root, base))) throw new UsageError(`"${base}" is not a branch, tag or commit in this repository.`);
    lists.push(await branchChanges(ctx.root, base));
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
    // A path created only in the working tree has no committed history of its own: whatever
    // the log knows under that name belonged to an earlier, deleted file. Paths created or
    // renamed on the branch are in the committed log, where RenameTracker gives them their real identity.
    const bornUncommitted = file.added === true && !file.sources.includes('branch');
    const ownHistory = !bornUncommitted && model.id(file.path) !== undefined;
    const historyPath = ownHistory ? file.path : file.oldPath !== undefined && model.id(file.oldPath) !== undefined ? file.oldPath : undefined;
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
  changes ??= await collectChanges(ctx, options.base);
  const { changed, suggestions } = suggestMissing(ctx, changes, options);
  return { meta: buildMeta(ctx), base: options.base, changed, suggestions };
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
