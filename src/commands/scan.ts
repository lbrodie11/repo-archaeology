import type { Context } from '../context.js';
import { RELATIONSHIPS, type Relationship } from '../imports/classify.js';
import { compareCompanions, type Companion } from '../model/cochange.js';
import { buildMeta, describeStrength, DISCLAIMER, printEvidence, printHeader, relationshipLabel, toView, type Meta, type RelationshipView } from '../report/views.js';
import { c, pct } from '../util/term.js';

/** Upper bound on relationships classified (each needs the files' imports parsed). */
export const MAX_CLASSIFIED = 5000;

export interface ScanOptions {
  limit: number;
  kinds: Relationship[];
  /**
   * At most this many "unchecked" results (pairs we could not check for imports,
   * e.g. config files). They are often mechanical, so by default they only fill
   * in around the ghost wires instead of crowding them out.
   */
  uncheckedCap?: number;
}

export interface ScanResult {
  meta: Meta;
  /** Relationships above the thresholds, by kind (capped at MAX_CLASSIFIED in total). */
  counts: Record<Relationship, number>;
  relationships: RelationshipView[];
}

export interface ClassifiedCompanion {
  companion: Companion;
  relationship: Relationship;
}

/** Relationships above the thresholds between files that still exist, best first, classified. */
export function classifiedPairs(ctx: Context, max = MAX_CLASSIFIED): ClassifiedCompanion[] {
  const { model, currentFiles } = ctx;
  const candidates: Companion[] = [];
  for (const pair of model.strongestPairs(ctx.thresholds)) {
    if (currentFiles.has(model.path(pair.from)) && currentFiles.has(model.path(pair.to))) candidates.push(pair);
  }
  candidates.sort(compareCompanions);
  return candidates.slice(0, max).map((companion) => ({
    companion,
    relationship: ctx.classifier.classify(model.path(companion.from), model.path(companion.to)),
  }));
}

export function scan(ctx: Context, options: ScanOptions): ScanResult {
  const counts: Record<Relationship, number> = { ghost: 0, unknown: 0, direct: 0, test: 0 };
  const selected: RelationshipView[] = [];
  const pending: ClassifiedCompanion[] = [];
  for (const entry of classifiedPairs(ctx)) {
    counts[entry.relationship]++;
    if (options.kinds.includes(entry.relationship)) pending.push(entry);
  }
  if (options.uncheckedCap === undefined) {
    for (const entry of pending.slice(0, options.limit)) selected.push(toView(ctx, entry.companion, entry.relationship));
  } else {
    // Checked results first; unchecked ones only fill the remaining space, up to the cap.
    const checked = pending.filter((e) => e.relationship !== 'unknown').slice(0, options.limit);
    const room = Math.min(options.uncheckedCap, options.limit - checked.length);
    const filler = room > 0 ? pending.filter((e) => e.relationship === 'unknown').slice(0, room) : [];
    for (const entry of [...checked, ...filler]) selected.push(toView(ctx, entry.companion, entry.relationship));
  }
  return { meta: buildMeta(ctx), counts, relationships: selected };
}

export function printScan(result: ScanResult, options: ScanOptions): void {
  printHeader('scan', result.meta);
  const { counts } = result;
  const total = RELATIONSHIPS.reduce((sum, r) => sum + counts[r], 0);
  if (total === 0) {
    console.log('No files changed together often enough to report.');
    console.log(c.dim(`Try lowering --min-shared (now ${result.meta.settings.minShared}) or --min-confidence (now ${pct(result.meta.settings.minConfidence)}).`));
    return;
  }
  console.log(
    `${total} relationships above the thresholds: ` +
      RELATIONSHIPS.map((r) => `${counts[r]} ${relationshipLabel(r)}`).join(c.dim(' · ')),
  );
  console.log(c.dim(`Showing ${options.kinds.map((k) => relationshipLabel(k)).join(', ')}. Change with --kinds ghost,unknown,direct,test.`));
  console.log();
  if (result.relationships.length === 0) {
    console.log('Nothing of the selected kinds. Everything that changes together is explained by imports or tests.');
    return;
  }
  result.relationships.forEach((view, i) => {
    const n = c.dim(`${String(i + 1).padStart(2)}.`);
    console.log(`${n} ${c.bold(view.from)} ${c.dim('→')} ${c.bold(view.to)}  ${relationshipLabel(view.relationship)}`);
    console.log(`    when ${view.from.split('/').pop()} changed, ${view.to.split('/').pop()} changed too in ${describeStrength(view)}`);
    console.log(c.dim(`    reverse: ${pct(view.reverseConfidence)} · ${view.why}`));
    printEvidence(view);
    console.log();
  });
  console.log(c.dim(DISCLAIMER));
}
