import type { Context } from '../context.js';
import { toRepoPath, UsageError } from '../context.js';
import {
  buildMeta,
  describeStrength,
  formatVerdictAnnotation,
  printEvidence,
  printHeader,
  relationshipLabel,
  toView,
  type Meta,
  type RelationshipView,
} from '../report/views.js';
import { median } from '../util/stats.js';
import { c, isoDate, pct, plural, terminalText, timeAgo } from '../util/term.js';

export interface FileOptions {
  limit: number;
  /** Include relationships silenced by `"expected"` verdicts. */
  showSilenced?: boolean;
}

export interface FileCompanionView extends RelationshipView {
  /** Whether `diff` would raise this one (passes --min-confidence as well as --min-shared). */
  wouldAlert: boolean;
}

export interface FileResult {
  meta: Meta;
  path: string;
  changes: number;
  /** Share of files that changed less often than this one. */
  churnPercentile: number;
  medianChanges: number;
  lastChanged: string;
  authors: { author: string; commits: number; share: number }[];
  companions: FileCompanionView[];
  /** Count of qualifying companions silenced by `"expected"` verdicts. */
  verdicts?: {
    silenced: number;
  };
}

export function fileReport(ctx: Context, input: string, options: FileOptions): FileResult {
  ctx.open?.();
  try {
    const path = toRepoPath(ctx, input);
    const { model } = ctx;
    const id = model.id(path);
    if (id === undefined) {
      const reason = ctx.currentFiles.has(path)
        ? 'it has no usable history yet (new, ignored, or only changed in sweeping commits)'
        : 'no such file in the history or the working tree';
      throw new UsageError(`Nothing to show for ${path}: ${reason}.`);
    }
    const counts = model.changeCount;
    const mine = counts[id] ?? 0;
    const below = counts.filter((n) => n < mine).length;
    let silenced = 0;
    // Show weaker links too (min confidence 0), flagging the ones `diff` would raise.
    const companions = model
      .companions(id, { minShared: ctx.thresholds.minShared, minConfidence: 0 })
      .filter((comp) => {
        const target = model.path(comp.to);
        if (!ctx.currentFiles.has(target)) return false;
        if (!options.showSilenced && ctx.verdicts?.match(path, target)?.kind === 'expected') {
          silenced++;
          return false;
        }
        return true;
      })
      .slice(0, options.limit)
      .map((comp) => {
        const target = model.path(comp.to);
        const relationship = ctx.classifier.classify(path, target);
        const view = toView(ctx, comp, relationship);
        return {
          ...view,
          wouldAlert: comp.confidence >= ctx.thresholds.minConfidence && view.verdict?.kind !== 'expected',
        };
      });
    return {
      meta: buildMeta(ctx),
      path,
      changes: mine,
      churnPercentile: counts.length > 0 ? below / counts.length : 0,
      medianChanges: median(counts),
      lastChanged: isoDate(model.lastTime[id] ?? 0),
      authors: model.topAuthors(id, 3),
      companions,
      ...(silenced > 0 ? { verdicts: { silenced } } : {}),
    };
  } finally {
    ctx.close?.();
  }
}

export function printFile(result: FileResult): void {
  printHeader(`file ${c.bold(terminalText(result.path))}`, result.meta);
  const times = result.medianChanges > 0 ? ` (${(result.changes / result.medianChanges).toFixed(1)}× the median file)` : '';
  const label = (s: string) => c.bold(s.padEnd(14));
  console.log(`${label('Changed in')}${plural(result.changes, 'commit')}${times}, busier than ${pct(result.churnPercentile)} of files`);
  console.log(`${label('Last changed')}${timeAgo(Date.parse(result.lastChanged) / 1000)} ${c.dim(`(${result.lastChanged})`)}`);
  const who = result.authors.map((a) => `${terminalText(a.author)} ${c.dim(pct(a.share))}`).join(', ');
  console.log(`${label('Who knows it')}${who}`);
  console.log();
  if (result.companions.length === 0) {
    console.log(`No file changed with it at least ${result.meta.settings.minShared} times.`);
    if (result.verdicts?.silenced) {
      console.log(c.dim(`(${result.verdicts.silenced} silenced by verdicts; use --show-silenced)`));
    }
    return;
  }
  console.log(c.bold('Files that move with it'));
  console.log(c.dim(`● = strong enough for \`diff\` to flag it (≥ ${pct(result.meta.settings.minConfidence)} confidence)`));
  if (result.verdicts?.silenced) {
    console.log(c.dim(`(${result.verdicts.silenced} silenced by verdicts; use --show-silenced)`));
  }
  console.log();
  for (const comp of result.companions) {
    const dot = comp.wouldAlert ? c.magenta('●') : c.dim('○');
    console.log(`  ${dot} ${c.bold(terminalText(comp.to))}  ${relationshipLabel(comp.relationship)}`);
    console.log(`    ${describeStrength(comp)} · reverse ${pct(comp.reverseConfidence)}`);
    console.log(c.dim(`    ${terminalText(comp.why)}`));
    if (comp.verdict) console.log(`    ${formatVerdictAnnotation(comp.verdict)}`);
    printEvidence(comp);
    console.log();
  }
}
