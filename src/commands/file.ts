import type { Context } from '../context.js';
import { toRepoPath, UsageError } from '../context.js';
import { buildMeta, describeStrength, printEvidence, printHeader, relationshipLabel, toView, type Meta, type RelationshipView } from '../report/views.js';
import { median } from '../util/stats.js';
import { c, isoDate, pct, plural, timeAgo } from '../util/term.js';

export interface FileOptions {
  limit: number;
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
}

export function fileReport(ctx: Context, input: string, options: FileOptions): FileResult {
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
  // Show weaker links too (min confidence 0), flagging the ones `diff` would raise.
  const companions = model
    .companions(id, { minShared: ctx.thresholds.minShared, minConfidence: 0 })
    .filter((comp) => ctx.currentFiles.has(model.path(comp.to)))
    .slice(0, options.limit)
    .map((comp) => {
      const relationship = ctx.classifier.classify(path, model.path(comp.to));
      return { ...toView(ctx, comp, relationship), wouldAlert: comp.confidence >= ctx.thresholds.minConfidence };
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
  };
}

export function printFile(result: FileResult): void {
  printHeader(`file ${c.bold(result.path)}`, result.meta);
  const times = result.medianChanges > 0 ? ` (${(result.changes / result.medianChanges).toFixed(1)}× the median file)` : '';
  const label = (s: string) => c.bold(s.padEnd(14));
  console.log(`${label('Changed in')}${plural(result.changes, 'commit')}${times}, busier than ${pct(result.churnPercentile)} of files`);
  console.log(`${label('Last changed')}${timeAgo(Date.parse(result.lastChanged) / 1000)} ${c.dim(`(${result.lastChanged})`)}`);
  const who = result.authors.map((a) => `${a.author} ${c.dim(pct(a.share))}`).join(', ');
  console.log(`${label('Who knows it')}${who}`);
  console.log();
  if (result.companions.length === 0) {
    console.log(`No file changed with it at least ${result.meta.settings.minShared} times.`);
    return;
  }
  console.log(c.bold('Files that move with it'));
  console.log(c.dim(`● = strong enough for \`diff\` to flag it (≥ ${pct(result.meta.settings.minConfidence)} confidence)`));
  console.log();
  for (const comp of result.companions) {
    const dot = comp.wouldAlert ? c.magenta('●') : c.dim('○');
    console.log(`  ${dot} ${c.bold(comp.to)}  ${relationshipLabel(comp.relationship)}`);
    console.log(`    ${describeStrength(comp)} · reverse ${pct(comp.reverseConfidence)}`);
    printEvidence(comp);
    console.log();
  }
}
