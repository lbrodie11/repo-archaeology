import type { Context } from '../context.js';
import { parallelImplementation, RELATIONSHIPS, type Relationship } from '../imports/classify.js';
import { compareCompanions, type Companion } from '../model/cochange.js';
import { buildFindingFamilies, type FindingFamilyView } from '../model/families.js';
import { buildMeta, describeStrength, DISCLAIMER, printEvidence, printHeader, relationshipLabel, toView, type Meta, type RelationshipView } from '../report/views.js';
import { c, pct, plural, shortHash, terminalText, timeAgo } from '../util/term.js';

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
  /** Relationships classified within the analysis cap, by kind. */
  counts: Record<Relationship, number>;
  qualifying: number;
  classified: number;
  truncated: boolean;
  relationships: RelationshipView[];
  /** Parallel-implementation finding families (3+ related files) among the reported relationships. */
  families: FindingFamilyView[];
}

export interface ClassifiedCompanion {
  companion: Companion;
  relationship: Relationship;
}

export interface ClassifiedPairs {
  entries: ClassifiedCompanion[];
  qualifying: number;
  truncated: boolean;
}

/** Relationships above the thresholds between files that still exist, best first, classified. */
export function classifiedPairs(ctx: Context, max = MAX_CLASSIFIED): ClassifiedPairs {
  const { model, currentFiles } = ctx;
  const candidates: Companion[] = [];
  for (const pair of model.strongestPairs(ctx.thresholds)) {
    if (currentFiles.has(model.path(pair.from)) && currentFiles.has(model.path(pair.to))) candidates.push(pair);
  }
  candidates.sort(compareCompanions);
  const entries = candidates.slice(0, max).map((companion) => ({
    companion,
    relationship: ctx.classifier.classify(model.path(companion.from), model.path(companion.to)),
  }));
  return { entries, qualifying: candidates.length, truncated: candidates.length > entries.length };
}

export function scan(ctx: Context, options: ScanOptions): ScanResult {
  const counts: Record<Relationship, number> = { ghost: 0, unknown: 0, indirect: 0, direct: 0, test: 0 };
  const selected: RelationshipView[] = [];
  const pending: ClassifiedCompanion[] = [];
  const classified = classifiedPairs(ctx);
  for (const entry of classified.entries) {
    counts[entry.relationship]++;
    if (options.kinds.includes(entry.relationship)) pending.push(entry);
  }
  let candidateEntries: ClassifiedCompanion[];
  if (options.uncheckedCap === undefined) {
    candidateEntries = pending;
    for (const entry of pending.slice(0, options.limit)) selected.push(toView(ctx, entry.companion, entry.relationship));
  } else {
    // Checked results first; unchecked ones only fill the remaining space, up to the cap.
    const checkedAll = pending.filter((e) => e.relationship !== 'unknown');
    const checked = checkedAll.slice(0, options.limit);
    const room = Math.min(options.uncheckedCap, options.limit - checked.length);
    const filler = room > 0 ? pending.filter((e) => e.relationship === 'unknown').slice(0, room) : [];
    for (const entry of [...checked, ...filler]) selected.push(toView(ctx, entry.companion, entry.relationship));
    candidateEntries = [
      ...checkedAll,
      ...pending.filter((e) => e.relationship === 'unknown').slice(0, options.uncheckedCap),
    ];
  }
  const familyCandidates: RelationshipView[] = [];
  for (const entry of candidateEntries) {
    const fromPath = ctx.model.path(entry.companion.from);
    const toPath = ctx.model.path(entry.companion.to);
    if (parallelImplementation(fromPath, toPath) !== undefined) {
      familyCandidates.push(toView(ctx, entry.companion, entry.relationship, fromPath, toPath));
    }
  }
  const families = buildFindingFamilies(ctx, familyCandidates).slice(0, options.limit);
  return {
    meta: buildMeta(ctx),
    counts,
    qualifying: classified.qualifying,
    classified: classified.entries.length,
    truncated: classified.truncated,
    relationships: selected,
    families,
  };
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
  const counted = RELATIONSHIPS.map((r) => `${counts[r]} ${relationshipLabel(r)}`).join(c.dim(' · '));
  console.log(result.truncated
    ? `${result.qualifying} relationships above the thresholds; strongest ${result.classified} classified: ${counted}`
    : `${total} relationships above the thresholds: ${counted}`);
  console.log(c.dim(`Showing ${options.kinds.map((k) => relationshipLabel(k)).join(', ')}. Change with --kinds ghost,unknown,indirect,direct,test.`));
  console.log();
  if (result.relationships.length === 0) {
    console.log(result.truncated
      ? 'Nothing of the selected kinds was found within the classification limit.'
      : 'Nothing of the selected kinds. Everything that changes together is explained by imports (direct or one step removed) or tests.');
    return;
  }
  if (result.families && result.families.length > 0) {
    console.log(c.bold(`Finding families (${result.families.length})`));
    console.log();
    result.families.forEach((fam, idx) => {
      const n = c.dim(`${String(idx + 1).padStart(2)}.`);
      const variants = fam.members.map((m) => terminalText(m.variant)).join(' · ');
      const kinds = fam.relationshipKinds.map((k) => relationshipLabel(k)).join(c.dim(', '));
      console.log(`${n} ${c.bold(terminalText(fam.label))}  ${c.cyan(`${fam.members.length} related implementations`)} ${c.dim('·')} ${kinds}`);
      console.log(`    members: ${variants}`);
      const pairNote = fam.complete
        ? `all ${fam.possiblePairs} pairwise links met thresholds`
        : `${fam.qualifyingPairs} of ${fam.possiblePairs} pairwise links met thresholds`;
      console.log(
        `    ${plural(fam.commitsTouchingTwoOrMore, 'commit')} touched 2+ members · ${plural(fam.commitsTouchingAll, 'commit')} touched all ${fam.members.length} · ${pairNote} · last together ${timeAgo(Date.parse(fam.lastTogether) / 1000)}`,
      );
      for (const ev of fam.evidence) {
        const scope = ev.touchesAllMembers
          ? `all ${ev.totalMembers} members`
          : `${ev.membersTouched} of ${ev.totalMembers} members`;
        console.log(`    ${c.gray(shortHash(ev.hash))} ${c.dim(ev.date)}  ${terminalText(ev.subject)} ${c.dim(`[${scope}]`)}`);
      }
      console.log();
    });
    console.log(c.bold(`Individual relationships (${result.relationships.length})`));
    console.log();
  }
  result.relationships.forEach((view, i) => {
    const n = c.dim(`${String(i + 1).padStart(2)}.`);
    const from = terminalText(view.from);
    const to = terminalText(view.to);
    console.log(`${n} ${c.bold(from)} ${c.dim('→')} ${c.bold(to)}  ${relationshipLabel(view.relationship)}`);
    console.log(`    when ${from} changed, ${to} changed too in ${describeStrength(view)}`);
    console.log(c.dim(`    reverse: ${pct(view.reverseConfidence)} · ${terminalText(view.why)}`));
    printEvidence(view);
    console.log();
  });
  console.log(c.dim(DISCLAIMER));
}
