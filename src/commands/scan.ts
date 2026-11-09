import type { Context } from '../context.js';
import { RELATIONSHIPS, type Relationship } from '../imports/classify.js';
import { compareCompanions, type Companion } from '../model/cochange.js';
import { buildFindingFamilies, isEligibleFamilyPair, type FindingFamilyView } from '../model/families.js';
import {
  buildMeta,
  describeStrength,
  DISCLAIMER,
  formatVerdictAnnotation,
  printEvidence,
  printHeader,
  relationshipLabel,
  toView,
  type Meta,
  type RelationshipView,
} from '../report/views.js';
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
  /** Include relationships silenced by `"expected"` verdicts. */
  showSilenced?: boolean;
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
  /** Count of qualifying relationships silenced by `"expected"` verdicts. */
  verdicts?: {
    silenced: number;
  };
}

export interface ClassifiedCompanion {
  companion: Companion;
  relationship: Relationship;
}

export interface ClassifiedPairs {
  entries: ClassifiedCompanion[];
  qualifying: number;
  truncated: boolean;
  silenced: number;
}

/** Relationships above the thresholds between files that still exist, best first, classified. */
export function classifiedPairs(ctx: Context, max = MAX_CLASSIFIED, options?: { showSilenced?: boolean }): ClassifiedPairs {
  const { model, currentFiles } = ctx;
  const candidates: Companion[] = [];
  let silenced = 0;
  for (const pair of model.strongestPairs(ctx.thresholds)) {
    const fromPath = model.path(pair.from);
    const toPath = model.path(pair.to);
    if (!currentFiles.has(fromPath) || !currentFiles.has(toPath)) continue;
    if (!options?.showSilenced && ctx.verdicts?.match(fromPath, toPath)?.kind === 'expected') {
      silenced++;
      continue;
    }
    candidates.push(pair);
  }
  candidates.sort(compareCompanions);
  const entries = candidates.slice(0, max).map((companion) => ({
    companion,
    relationship: ctx.classifier.classify(model.path(companion.from), model.path(companion.to)),
  }));
  return { entries, qualifying: candidates.length, truncated: candidates.length > entries.length, silenced };
}

export function scan(ctx: Context, options: ScanOptions): ScanResult {
  ctx.open?.();
  try {
    const counts: Record<Relationship, number> = { ghost: 0, unknown: 0, indirect: 0, direct: 0, test: 0 };
    const selected: RelationshipView[] = [];
    const pending: ClassifiedCompanion[] = [];
    const classified = classifiedPairs(ctx, MAX_CLASSIFIED, { showSilenced: options.showSilenced });
    for (const entry of classified.entries) {
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
    const familyCandidates: RelationshipView[] = [];
    for (const entry of pending) {
      const fromPath = ctx.model.path(entry.companion.from);
      const toPath = ctx.model.path(entry.companion.to);
      if (isEligibleFamilyPair(fromPath, toPath)) {
        familyCandidates.push(toView(ctx, entry.companion, entry.relationship, fromPath, toPath));
      }
    }
    const families = buildFindingFamilies(ctx, familyCandidates, {
      allowedKinds: options.kinds,
      showSilenced: options.showSilenced,
    }).slice(0, options.limit);
    return {
      meta: buildMeta(ctx),
      counts,
      qualifying: classified.qualifying,
      classified: classified.entries.length,
      truncated: classified.truncated,
      relationships: selected,
      families,
      ...(classified.silenced > 0 ? { verdicts: { silenced: classified.silenced } } : {}),
    };
  } finally {
    ctx.close?.();
  }
}

export function printScan(result: ScanResult, options: ScanOptions): void {
  printHeader('scan', result.meta);
  const { counts } = result;
  const total = RELATIONSHIPS.reduce((sum, r) => sum + counts[r], 0);
  if (total === 0) {
    console.log('No files changed together often enough to report.');
    if (result.verdicts?.silenced) {
      console.log(c.dim(`(${result.verdicts.silenced} silenced by verdicts; use --show-silenced)`));
    } else {
      console.log(c.dim(`Try lowering --min-shared (now ${result.meta.settings.minShared}) or --min-confidence (now ${pct(result.meta.settings.minConfidence)}).`));
    }
    return;
  }
  const counted = RELATIONSHIPS.map((r) => `${counts[r]} ${relationshipLabel(r)}`).join(c.dim(' · '));
  console.log(result.truncated
    ? `${result.qualifying} relationships above the thresholds; strongest ${result.classified} classified: ${counted}`
    : `${total} relationships above the thresholds: ${counted}`);
  console.log(c.dim(`Showing ${options.kinds.map((k) => relationshipLabel(k)).join(', ')}. Change with --kinds ghost,unknown,indirect,direct,test.`));
  if (result.verdicts?.silenced) {
    console.log(c.dim(`(${result.verdicts.silenced} silenced by verdicts; use --show-silenced)`));
  }
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
        `    ${plural(fam.commitsTouchingTwoOrMore, 'supporting commit')} (2+ members via a qualifying pair) · ${plural(fam.commitsTouchingAll, 'commit')} touched all ${fam.members.length} · ${pairNote} · last together ${timeAgo(Date.parse(fam.lastTogether) / 1000)}`,
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
    if (view.verdict) console.log(`    ${formatVerdictAnnotation(view.verdict)}`);
    printEvidence(view);
    console.log();
  });
  console.log(c.dim(DISCLAIMER));
}
