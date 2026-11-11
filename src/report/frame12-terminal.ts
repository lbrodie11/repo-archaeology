/**
 * Repo Archaeology results → a `@frame12/terminal` snapshot, for `--style rich`.
 *
 * Pure and typed: no I/O, no clock, no environment. Everything it shows comes from the result
 * objects `scan`, `diff`, `file` and `explain` return (the same objects `--json` serializes), so
 * every number in the rich output is a number from `--json`. Percentages use the package's own
 * rounding (`Math.round(x * 100)`) everywhere, so a sentence and the tone bar never disagree.
 *
 * Ported from FRAME/12's reference adapter (`packages/terminal/examples/repo-archaeology/
 * adapter.mjs`, terminal@0.1.0): `pairId`, `trackRecordSentence`, the relationship → `relation`
 * map, the "<to> usually changes with <from>" title and the "activity, not correctness" wording.
 * That example should later import this module (or match it); see the RA-21 follow-ups.
 *
 * The terminal glue (capability detection and the choice between `renderRich` and `renderPlain`)
 * is at the bottom; it is pure too: the environment, streams and flags are passed in.
 */
import {
  detectCapabilities,
  type Capabilities,
  type CutSummary,
  type Env,
  type Finding,
  type FindingStatus,
  type Metric,
  type Prominence,
  type ReceiptRef,
  type Relation,
  type Snapshot,
  type Strength,
  type Streams,
} from '@frame12/terminal';
import { renderCapsFor, renderPlain, renderRich, type NextStep } from '@frame12/terminal/render';
import type { DiffFamilyView, DiffResult, Suggestion } from '../commands/diff.js';
import { EXPLAIN_DISCLAIMER, formatExplainCommand, type ExplainResult } from '../commands/explain.js';
import type { FileCompanionView, FileResult } from '../commands/file.js';
import type { ScanOptions, ScanResult } from '../commands/scan.js';
import type { Settings } from '../config.js';
import { RELATIONSHIPS, type Relationship } from '../imports/classify.js';
import type { FindingFamilyView } from '../model/families.js';
import type { RelationshipVerdictView } from '../model/verdicts.js';
import { commitUrl } from './terminal-safety.js';
import { DISCLAIMER, NAMES, weightingLabel, type EvidenceView, type Meta, type RelationshipView } from './views.js';

/** Product name in the masthead. */
export const PRODUCT = 'Repo Archaeology';

/** The silence caveat `diff` prints when nothing met the criteria (same words as classic). */
export const SILENCE_CAVEAT =
  'Silence means no untouched file met the active historical criteria; it does not guarantee the change is complete.';

/** What a rich render needs: the snapshot and the commands printed once as "Next steps". */
export interface RichView {
  snapshot: Snapshot;
  nextSteps: NextStep[];
}

export interface AdapterOptions {
  /** ISO 8601 timestamps of the run (the CLI passes its own clock; tests pass fixed ones). */
  startedAt: string;
  finishedAt: string;
  /** The `origin` remote, used only to link commit receipts when it is a trusted host. */
  remoteUrl?: string;
  /** Flags the user passed, so suggested `explain` commands reproduce the same analysis. */
  flagSettings?: Partial<Settings>;
  /**
   * `--full-evidence`: every stored supporting commit becomes a receipt, not only the ones
   * `--json` lists in `evidence` (so receipt counts are `--json` numbers unless this is set).
   */
  fullEvidence?: boolean;
}

// ------------------------------------------------------------------------------ shared pieces

/** Repo Archaeology relationship → contract relation (only the ones the contract has words for). */
const RELATIONS: Partial<Record<Relationship, Relation>> = {
  ghost: 'history-only',
  direct: 'direct',
  indirect: 'indirect',
};

export function relationOf(relationship: Relationship): Relation | undefined {
  return RELATIONS[relationship];
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** A stable domain id for a pair (FNV-1a of both paths): never a presentation label. */
export function pairId(from: string, to: string): string {
  return `pair-${fnv1a(`${from}\u0000${to}`)}`;
}

/** A stable domain id for a finding family (FNV-1a of its members, in order). */
export function familyId(members: readonly string[]): string {
  return `family-${fnv1a(members.join('\u0000'))}`;
}

/** The package's rounding: `0.615` → `62%`. */
export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** Repo Archaeology dates are days; the contract wants timestamps (midnight UTC). */
function day(date: string | undefined): string | undefined {
  return date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00.000Z` : undefined;
}

/** `0–100` range text used in sentences: the same numbers the tone bar prints. */
function range(interval: { low: number; high: number }): string {
  return `${Math.round(interval.low * 100)}-${Math.round(interval.high * 100)}%`;
}

function prominenceAt(index: number): Prominence {
  return index === 0 ? 'hero' : index < 3 ? 'primary' : 'secondary';
}

function commitReceipt(e: Pick<EvidenceView, 'hash' | 'date' | 'subject'>, remoteUrl: string | undefined, note = e.subject): ReceiptRef {
  const at = day(e.date);
  const href = commitUrl(remoteUrl, e.hash);
  return { kind: 'commit', value: e.hash, ...(at ? { at } : {}), note, ...(href ? { href } : {}) };
}

/** `evidence` (as in `--json`), or every stored supporting commit under `--full-evidence`. */
function viewReceipts(view: RelationshipView, full: boolean | undefined): EvidenceView[] {
  return full && view.allEvidence && view.allEvidence.length > view.evidence.length ? view.allEvidence : view.evidence;
}

export function strengthOf(view: Pick<RelationshipView, 'confidence' | 'interval' | 'weighted' | 'weighting'>): Strength {
  const weighting = weightingLabel(view);
  return {
    value: view.confidence,
    low: view.interval.low,
    high: view.interval.high,
    label: weighting ? `${weighting} co-change confidence (raw 95% interval)` : 'co-change confidence (95% interval)',
  };
}

function rateText(confidence: number, interval: { low: number; high: number }, weighting: string | undefined): string {
  return weighting ? `${pct(confidence)} ${weighting}, raw 95% interval ${range(interval)}` : `${pct(confidence)}, 95% interval ${range(interval)}`;
}

/** "6 of 8 commits that changed A also changed B (75%, 95% interval 41-93%)." */
function forwardSentence(view: RelationshipView, from = view.from, to = view.to): string {
  return `${view.shared} of ${view.fromChanges} commits that changed ${from} also changed ${to} (${rateText(view.confidence, view.interval, weightingLabel(view))}).`;
}

/** The forward sentence plus "the other way 6 of 6 (100%)". */
function directionSentence(view: RelationshipView): string {
  return `${forwardSentence(view).slice(0, -1)}; the other way ${view.shared} of ${view.toChanges} (${pct(view.reverseConfidence)}).`;
}

function relationshipSentence(relationship: Relationship, why: string): string {
  return `${capitalize(NAMES[relationship])}: ${why}.`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function verdictSentence(verdict: RelationshipVerdictView): string {
  const kind = verdict.kind === 'confirmed' ? 'confirmed' : 'expected (silenced)';
  const meta = [verdict.by ? `by ${verdict.by}` : '', verdict.until ? `until ${verdict.until}` : ''].filter(Boolean).join(', ');
  return `Verdict: ${kind}${meta ? ` (${meta})` : ''}: ${verdict.reason}.`;
}

function findingStatus(view: { verdict?: RelationshipVerdictView }): FindingStatus {
  return view.verdict?.kind === 'expected' ? 'info' : 'review';
}

type TrackRecordInput = Pick<Suggestion, 'from' | 'to' | 'trackRecord'>;

/**
 * The track record, in words that never claim correctness, and scoped to the window Repo
 * Archaeology evaluated: it counts whether <to> changed soon after a change to <from> that left it
 * out, which is activity, not proof of a fix. (Ported from FRAME/12's reference adapter.)
 */
export function trackRecordSentence(s: TrackRecordInput): string | undefined {
  const tr = s.trackRecord;
  if (!tr) return undefined;
  if (!('fired' in tr)) return 'Track record: not enough history to replay (no claim either way).';
  const when = tr.evaluated?.from && tr.evaluated?.to ? ` between ${tr.evaluated.from} and ${tr.evaluated.to}` : '';
  if (tr.fired === 0) return `Track record: no change to ${s.from}${when} left ${s.to} out, so there is nothing to replay (historical activity, not correctness).`;
  if (!('confirmed' in tr)) return `Track record: ${plural(tr.fired, 'change')} to ${s.from}${when} left ${s.to} out (historical activity, not correctness).`;
  return `Track record: ${plural(tr.fired, 'change')} to ${s.from}${when} left ${s.to} out; it changed within ${tr.windowHours} h after ${tr.confirmed} of them (historical activity, not correctness).`;
}

/** Contributor and CODEOWNERS context for a diff suggestion (`--owners`), in classic's words. */
export function ownershipSentences(s: Suggestion): string[] {
  if (s.owners === undefined && s.codeowners === undefined) return [];
  const out: string[] = [];
  const sample = s.ownersSample;
  if (s.codeowners && s.codeowners.length > 0) {
    const source = sample?.codeownersSource === 'base' ? 'base CODEOWNERS' : sample?.codeownersSource === 'head' ? 'head CODEOWNERS' : 'CODEOWNERS';
    // Handles are printed without their `@`, so text copied into a PR comment never pings anyone.
    // (Classic inserts a zero-width break after `@`; @frame12/terminal strips zero-width characters.)
    const handles = s.codeowners.map((h) => h.replace(/@(?=[A-Za-z0-9_-])/g, '')).join(', ');
    out.push(`Designated code owners (${source}, handles without @): ${handles}.`);
  }
  if (s.owners !== undefined) {
    const lookbackDays = sample?.lookbackDays ?? 365;
    const qualifying = sample?.qualifyingCommits ?? s.owners.reduce((sum, o) => sum + o.commits, 0);
    const notes: string[] = [];
    if (sample && sample.agentAssistedCommits > 0) notes.push(`${plural(sample.agentAssistedCommits, 'AI-assisted commit')} included`);
    if (sample?.incompleteCoverage) notes.push('incomplete history coverage');
    const suffix = notes.length > 0 ? `, ${notes.join(', ')}` : '';
    if (s.owners.length === 0) {
      out.push(`People who may have context: no qualifying recent human changes in the last ${lookbackDays} days${suffix}.`);
      return out;
    }
    const people = s.owners
      .map((o) => `${o.name}${o.login ? ` (${o.login})` : ''}, ${o.commits} of ${qualifying} qualifying recent changes, last ${o.lastDate}`)
      .join('; ');
    out.push(`People who may have context (${lookbackDays}-day window${suffix}): ${people}.`);
    out.push('Historical activity suggests familiarity, not current ownership or availability.');
  }
  return out;
}

function historyMetrics(meta: Meta): Metric[] {
  const metrics: Metric[] = [{ name: 'commits-analyzed', label: 'Commits analyzed', value: meta.commitsAnalyzed }];
  if (meta.oldestCommit && meta.newestCommit) {
    metrics.push({ name: 'history', label: 'History', value: `${meta.oldestCommit} to ${meta.newestCommit}` });
  }
  if (meta.sweepsSkipped > 0) metrics.push({ name: 'sweeps-skipped', label: 'Sweeping commits skipped', value: meta.sweepsSkipped });
  if ((meta.revertsSkipped ?? 0) > 0) metrics.push({ name: 'reverts-skipped', label: 'Revert commits skipped', value: meta.revertsSkipped! });
  if (meta.subjectSkipped > 0) metrics.push({ name: 'subject-skipped', label: 'Matching --skip-commits', value: meta.subjectSkipped });
  return metrics;
}

function snapshot(
  command: string,
  title: string,
  meta: Meta,
  findings: Finding[],
  metrics: Metric[],
  warnings: string[],
  options: AdapterOptions,
): Snapshot {
  const cuts: CutSummary[] = [{ cut: 'read-history', title: 'Read git history', status: 'ok' }];
  return {
    schemaVersion: 1,
    runId: `repo-archaeology-${command}`,
    title,
    status: 'completed',
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    cuts,
    metrics,
    findings,
    // The contract requires non-empty warnings; repository text may still be blank.
    warnings: [...meta.warnings, ...warnings].filter((w) => w.trim() !== ''),
  };
}

function pairFinding(
  view: RelationshipView,
  index: number,
  summary: string[],
  options: AdapterOptions,
  extra: { status?: FindingStatus; prominence?: Prominence } = {},
): Finding {
  const relation = relationOf(view.relationship);
  return {
    id: pairId(view.from, view.to),
    title: `${view.to} usually changes with ${view.from}`,
    summary: summary.filter(Boolean).join(' '),
    subject: [
      { kind: 'file', label: view.from },
      { kind: 'file', label: view.to },
    ],
    strength: strengthOf(view),
    prominence: extra.prominence ?? prominenceAt(index),
    status: extra.status ?? findingStatus(view),
    ...(relation ? { relation } : {}),
    receipts: viewReceipts(view, options.fullEvidence).map((e) => commitReceipt(e, options.remoteUrl)),
  };
}

function frameLabel(index: number): string {
  return `F-${String(index + 1).padStart(2, '0')}`;
}

/** `explain` commands for the first three pair findings (`offset` = findings before them). */
function explainSteps(
  pairs: Array<{ from: string; to: string }>,
  offset: number,
  settings: Meta['settings'],
  options: AdapterOptions,
  refs: { head?: string; base?: string },
): NextStep[] {
  return pairs.slice(0, Math.max(0, 3 - offset)).map((p, i) => ({
    command: formatExplainCommand(p.from, p.to, settings, options.flagSettings, refs),
    description: `Show the shared commits behind ${frameLabel(offset + i)}.`,
  }));
}

function headRef(meta: Meta): { head?: string } {
  return meta.head ? { head: meta.head.ref } : {};
}

// ---------------------------------------------------------------------------------------- scan

function familyFinding(fam: FindingFamilyView, index: number, options: AdapterOptions): Finding {
  const n = fam.members.length;
  const pairNote = fam.complete
    ? `all ${fam.possiblePairs} pairwise links met thresholds`
    : `${fam.qualifyingPairs} of ${fam.possiblePairs} pairwise links met thresholds`;
  const summary = [
    `${n} related implementations (${fam.members.map((m) => m.variant).join(', ')}): ${fam.why}.`,
    `Relationships: ${fam.relationshipKinds.map((k) => NAMES[k]).join(', ')}.`,
    `${plural(fam.commitsTouchingTwoOrMore, 'supporting commit')} touched two or more members via a qualifying pair; ${plural(fam.commitsTouchingAll, 'commit')} touched all ${n}; ${pairNote}; last together ${fam.lastTogether}.`,
  ];
  return {
    id: familyId(fam.members.map((m) => m.path)),
    title: `${fam.label}: ${n} related implementations`,
    summary: summary.join(' '),
    subject: fam.members.map((m) => ({ kind: 'file', label: m.path })),
    prominence: prominenceAt(index),
    status: 'review',
    receipts: fam.evidence.map((ev) =>
      commitReceipt(ev, options.remoteUrl, `${ev.subject} [${ev.touchesAllMembers ? `all ${ev.totalMembers} members` : `${ev.membersTouched} of ${ev.totalMembers} members`}]`),
    ),
  };
}

export interface ScanExtras {
  /** The bare command: changed files without usable history, so it fell back to `scan`. */
  changedWithoutHistory?: number;
  /** The bare command adds "explore the interactive view" as a next step. */
  bare?: boolean;
}

export function scanToRichView(result: ScanResult, scanOptions: ScanOptions, options: AdapterOptions, extras: ScanExtras = {}): RichView {
  const { meta, counts } = result;
  const total = RELATIONSHIPS.reduce((sum, r) => sum + counts[r], 0);
  const families = result.families ?? [];
  const warnings: string[] = [];
  const nextSteps: NextStep[] = [];
  const metrics = historyMetrics(meta);
  const silenced = result.verdicts?.silenced ?? 0;

  if ((extras.changedWithoutHistory ?? 0) > 0) {
    const n = extras.changedWithoutHistory!;
    warnings.push(`${plural(n, 'changed file')} had no usable history; showing repository-wide relationships instead.`);
    metrics.push({ name: 'changed-without-history', label: 'Changed files without history', value: n });
  }

  let findings: Finding[] = [];
  if (total === 0) {
    warnings.push('No files changed together often enough to report.');
    if (silenced === 0) {
      warnings.push(`Try lowering --min-shared (now ${meta.settings.minShared}) or --min-confidence (now ${pct(meta.settings.minConfidence)}).`);
    }
  } else {
    metrics.push(
      result.truncated
        ? { name: 'relationships-qualifying', label: 'Above the thresholds', value: result.qualifying }
        : { name: 'relationships', label: 'Above the thresholds', value: total },
    );
    if (result.truncated) metrics.push({ name: 'relationships-classified', label: 'Strongest classified', value: result.classified });
    for (const r of RELATIONSHIPS) metrics.push({ name: `kind-${r}`, label: capitalize(NAMES[r]), value: counts[r] });
    metrics.push({ name: 'kinds-shown', label: 'Showing', value: scanOptions.kinds.map((k) => NAMES[k]).join(', ') });
    if (families.length > 0) metrics.push({ name: 'families', label: 'Finding families', value: families.length });
    metrics.push({ name: 'relationships-shown', label: 'Relationships shown', value: result.relationships.length });

    if (result.relationships.length === 0) {
      warnings.push(
        result.truncated
          ? 'Nothing of the selected kinds was found within the classification limit.'
          : 'Nothing of the selected kinds. Everything that changes together is explained by imports (direct or one step removed) or tests.',
      );
      nextSteps.push({ command: 'npx repo-archaeology scan --kinds ghost,unknown,indirect,direct,test', description: 'Show every relationship kind.' });
    } else {
      // Today's order: families first, then individual relationships (ranked by score).
      findings = [
        ...families.map((fam, i) => familyFinding(fam, i, options)),
        ...result.relationships.map((view, i) =>
          pairFinding(
            view,
            families.length + i,
            [
              relationshipSentence(view.relationship, view.why),
              directionSentence(view),
              `Last together ${view.lastTogether}.`,
              view.verdict ? verdictSentence(view.verdict) : '',
            ],
            options,
          ),
        ),
      ];
      nextSteps.push(...explainSteps(result.relationships, families.length, meta.settings, options, headRef(meta)));
      warnings.push(DISCLAIMER);
    }
  }
  if (silenced > 0) {
    metrics.push({ name: 'silenced', label: 'Silenced by verdicts', value: silenced });
    nextSteps.push({ command: 'npx repo-archaeology scan --show-silenced', description: 'Also show relationships silenced by verdicts.' });
  }
  if (extras.bare) nextSteps.push({ command: 'npx repo-archaeology map', description: 'Explore the interactive view.' });

  return { snapshot: snapshot('scan', 'scan', meta, findings, metrics, warnings, options), nextSteps };
}

// ---------------------------------------------------------------------------------------- diff

function familySentence(s: Suggestion, families: DiffFamilyView[]): string {
  const fam = families.find((f) => f.suggestedMembers.includes(s.to));
  if (!fam) return '';
  return `Part of the ${fam.label} family: changed ${fam.changedMembers.join(', ')}; check ${fam.suggestedMembers.join(', ')} (${fam.commitsTouchingTwoOrMore} supporting commits).`;
}

export function diffToRichView(result: DiffResult, options: AdapterOptions): RichView {
  const { meta } = result;
  const title = result.base ? `diff (${result.base}...HEAD + uncommitted changes)` : 'diff (uncommitted changes)';
  const metrics = historyMetrics(meta);
  const warnings: string[] = [];
  const nextSteps: NextStep[] = [];
  let findings: Finding[] = [];

  const withoutHistory = result.changed.filter((f) => !f.hasHistory).length;
  const withHistory = result.changed.length - withoutHistory;
  const silenced = result.verdicts?.silenced ?? result.silence?.verdicts?.silenced ?? 0;
  const addedInBranch = result.verdicts?.addedInBranch ?? result.silence?.verdicts?.addedInBranch ?? 0;
  metrics.push({ name: 'changed-files', label: 'Changed files', value: result.changed.length });
  if (withoutHistory > 0) metrics.push({ name: 'changed-without-history', label: 'New or without usable history', value: withoutHistory });
  if (silenced > 0) metrics.push({ name: 'silenced', label: 'Silenced by verdicts', value: silenced });
  if (addedInBranch > 0) {
    metrics.push({ name: 'verdicts-added', label: 'Verdicts added (not applied until merged)', value: addedInBranch });
  }

  if (result.changed.length === 0) {
    warnings.push(result.base ? 'No changes on this branch or in the working tree.' : 'No uncommitted changes.');
    if (!result.base) nextSteps.push({ command: 'npx repo-archaeology diff --base main', description: 'Check a whole branch.' });
  } else if (result.suggestions.length === 0) {
    const silence = result.silence;
    if (silence) {
      metrics.push(
        { name: 'qualifying-companions', label: 'Qualifying companions', value: silence.qualifyingCompanions },
        { name: 'touched-companions', label: 'Already in this change', value: silence.touchedCompanions },
        { name: 'filtered-by-threshold', label: 'Below the thresholds', value: silence.filteredByThreshold },
        { name: 'filtered-by-kind', label: 'Excluded by --kinds', value: silence.filteredByKind },
      );
    }
    if (withHistory === 0) {
      warnings.push('No suggestions: none of the changed files have usable history to evaluate.', ...(silence?.details.slice(1) ?? []));
    } else if (!silence) {
      // Classic prints this as a success line; with no findings the package says the run found nothing.
      warnings.push(`Nothing obviously missing: evaluated ${plural(withHistory, 'file')}; no untouched file usually changes alongside ${withHistory === 1 ? 'it' : 'them'}.`);
    } else {
      warnings.push(`No suggestions after evaluating ${plural(withHistory, 'file')}.`, ...silence.details, SILENCE_CAVEAT);
    }
  } else {
    const families = result.families ?? [];
    metrics.push({ name: 'suggestions', label: 'Possibly missed', value: result.suggestions.length });
    if (result.totalSuggestions !== undefined && result.totalSuggestions !== result.suggestions.length) {
      metrics.push({ name: 'total-suggestions', label: 'Suggestions before --limit', value: result.totalSuggestions });
    }
    if (families.length > 0) metrics.push({ name: 'families', label: 'Finding families', value: families.length });
    findings = result.suggestions.map((s, i) =>
      pairFinding(
        s,
        i,
        [
          relationshipSentence(s.relationship, s.why),
          directionSentence(s),
          `Last together ${s.lastTogether}.`,
          s.alsoLinkedFrom.length > 0 ? `Also linked to: ${s.alsoLinkedFrom.join(', ')}.` : '',
          familySentence(s, families),
          s.verdict ? verdictSentence(s.verdict) : '',
          ...ownershipSentences(s),
          trackRecordSentence(s) ?? '',
        ],
        options,
      ),
    );
    const baselineRef = result.base !== undefined ? (result.evaluation?.baselineSha ?? result.evaluation?.mergeBaseSha ?? result.base) : undefined;
    nextSteps.push(...explainSteps(result.suggestions, 0, meta.settings, options, { ...headRef(meta), ...(baselineRef ? { base: baselineRef } : {}) }));
    warnings.push(DISCLAIMER);
  }
  return { snapshot: snapshot('diff', title, meta, findings, metrics, warnings, options), nextSteps };
}

// ---------------------------------------------------------------------------------------- file

export function fileToRichView(result: FileResult, options: AdapterOptions): RichView {
  const { meta } = result;
  const metrics = historyMetrics(meta);
  const warnings: string[] = [];
  const nextSteps: NextStep[] = [];
  const silenced = result.verdicts?.silenced ?? 0;
  metrics.push(
    { name: 'changes', label: 'Changed in', value: plural(result.changes, 'commit') },
    { name: 'churn-percentile', label: 'Busier than', value: `${pct(result.churnPercentile)} of files` },
    { name: 'median-changes', label: 'Median file', value: plural(result.medianChanges, 'commit') },
    { name: 'last-changed', label: 'Last changed', value: result.lastChanged },
    { name: 'authors', label: 'Who knows it', value: result.authors.map((a) => `${a.author} ${pct(a.share)}`).join(', ') },
    { name: 'companions', label: 'Files that move with it', value: result.companions.length },
  );
  if (silenced > 0) metrics.push({ name: 'silenced', label: 'Silenced by verdicts', value: silenced });

  const threshold = pct(meta.settings.minConfidence);
  const findings = result.companions.map((comp: FileCompanionView, i) =>
    pairFinding(
      { ...comp, from: result.path },
      i,
      [
        relationshipSentence(comp.relationship, comp.why),
        directionSentence({ ...comp, from: result.path }),
        `Last together ${comp.lastTogether}.`,
        comp.wouldAlert
          ? `Strong enough for diff to flag it (at least ${threshold} confidence).`
          : `Below diff's alert threshold (${threshold} confidence).`,
        comp.verdict ? verdictSentence(comp.verdict) : '',
      ],
      options,
      { status: comp.verdict?.kind === 'expected' || !comp.wouldAlert ? 'info' : 'review' },
    ),
  );
  if (findings.length === 0) {
    warnings.push(`No file changed with it at least ${meta.settings.minShared} times.`);
  } else {
    nextSteps.push(...explainSteps(result.companions.map((c) => ({ from: result.path, to: c.to })), 0, meta.settings, options, headRef(meta)));
    warnings.push(DISCLAIMER);
  }
  return { snapshot: snapshot('file', `file ${result.path}`, meta, findings, metrics, warnings, options), nextSteps };
}

// ------------------------------------------------------------------------------------- explain

export function explainToRichView(result: ExplainResult, options: AdapterOptions): RichView {
  const { meta, counterexamples: ce, bounds } = result;
  const warnings: string[] = [];
  const view: RelationshipView = { ...result, lastTogether: result.lastTogether ?? '', evidence: [] };
  const summary = [
    relationshipSentence(result.relationship, result.why),
    forwardSentence(view),
    `The other way, ${result.shared} of ${result.toChanges} commits that changed ${result.to} also changed ${result.from} (${rateText(result.reverseConfidence, result.reverseInterval, weightingLabel(result))}).`,
    result.lastTogether ? `Last together ${result.lastTogether}.` : '',
    result.verdict ? verdictSentence(result.verdict) : '',
    result.meetsThresholds
      ? ''
      : `Below the alert thresholds (needs at least ${meta.settings.minShared} shared commits and ${pct(meta.settings.minConfidence)} confidence).`,
    `Counterexamples: ${result.from} changed without ${result.to} in ${plural(ce.fromWithoutToTotal, 'commit')}, and ${result.to} without ${result.from} in ${plural(ce.toWithoutFromTotal, 'commit')}.`,
  ];
  const receipts: ReceiptRef[] = [
    ...result.sharedCommits.map((c) => commitReceipt(c, options.remoteUrl, `${c.subject} (${c.author})`)),
    ...ce.fromWithoutTo.map((c) => commitReceipt(c, options.remoteUrl, `counterexample, ${result.from} without ${result.to}: ${c.subject}`)),
    ...ce.toWithoutFrom.map((c) => commitReceipt(c, options.remoteUrl, `counterexample, ${result.to} without ${result.from}: ${c.subject}`)),
  ];
  const relation = relationOf(result.relationship);
  const finding: Finding = {
    id: pairId(result.from, result.to),
    title: `${result.to} usually changes with ${result.from}`,
    summary: summary.filter(Boolean).join(' '),
    subject: [
      { kind: 'file', label: result.from },
      { kind: 'file', label: result.to },
    ],
    strength: strengthOf(result),
    prominence: 'hero',
    status: findingStatus(result),
    ...(relation ? { relation } : {}),
    receipts,
  };

  const metrics: Metric[] = [
    ...historyMetrics(meta),
    { name: 'shared', label: 'Shared commits', value: result.shared },
    { name: 'from-changes', label: 'Commits changing subject 1', value: result.fromChanges },
    { name: 'to-changes', label: 'Commits changing subject 2', value: result.toChanges },
    { name: 'from-without-to', label: 'Subject 1 without subject 2', value: ce.fromWithoutToTotal },
    { name: 'to-without-from', label: 'Subject 2 without subject 1', value: ce.toWithoutFromTotal },
    { name: 'shared-commits-shown', label: 'Shared commits shown', value: result.sharedCommits.length },
  ];

  if (result.sharedCommits.length === 0) {
    warnings.push(
      result.shared > 0 && bounds.timedOut
        ? 'No shared commits shown (patch retrieval reached time budget).'
        : 'No shared commits found between these two files in the analyzed history.',
    );
  }
  const notices: string[] = [];
  if (bounds.commitsTruncated) notices.push(`showing up to ${bounds.maxCommits} shared commits`);
  if (bounds.contextClamped) notices.push(`context lines clamped to ${bounds.contextLines}`);
  if (bounds.outputTruncated) notices.push(`patch output capped at ${bounds.maxTotalPatchLines} lines`);
  if (bounds.timedOut) notices.push('patch retrieval reached time budget');
  if (notices.length > 0) warnings.push(`Bounds applied: ${notices.join('; ')}.`);
  warnings.push(result.disclaimer || EXPLAIN_DISCLAIMER);

  return {
    snapshot: snapshot('explain', `explain ${result.from} and ${result.to}`, meta, [finding], metrics, warnings, options),
    // Patch hunks are not part of the snapshot contract: classic shows them.
    nextSteps: [{ command: `${result.cliCommand} --style classic`, description: 'Show the patch hunks for these commits.' }],
  };
}

// ------------------------------------------------------------------------------ terminal glue

/** Repo Archaeology's own terminal flags, as commander parsed them. */
export interface TerminalFlags {
  /** `false` for `--no-color`. */
  color?: boolean;
  ascii?: boolean;
  /** `false` for `--no-links`. */
  links?: boolean;
  screenReader?: boolean;
  columns?: number;
}

/**
 * The argv `@frame12/terminal` reads, built from flags commander already parsed (never from raw
 * `process.argv`, where a path argument could look like a flag).
 */
export function capabilityArgv(flags: TerminalFlags): string[] {
  const argv: string[] = [];
  if (flags.color === false) argv.push('--no-color');
  if (flags.ascii === true) argv.push('--ascii');
  if (flags.links === false) argv.push('--no-links');
  if (flags.screenReader === true) argv.push('--screen-reader');
  if (flags.columns !== undefined) argv.push('--columns', String(flags.columns));
  return argv;
}

/** `@frame12/terminal`'s own detection, with Repo Archaeology's flags mapped onto it. */
export function terminalCapabilities(flags: TerminalFlags, env: Env, streams: Streams, platform?: string): Capabilities {
  return detectCapabilities(env, streams, capabilityArgv(flags), platform ? { platform } : {});
}

/**
 * The rich output for a view: `renderPlain` in screen-reader mode (append-only, one fact per line),
 * otherwise `renderRich` at the terminal's own level (no escape sequences on a pipe or file).
 */
export function renderRichView(view: RichView, caps: Capabilities): string {
  const options = { product: PRODUCT, nextSteps: view.nextSteps };
  if (caps.screenReader) return renderPlain(view.snapshot, options);
  return renderRich(view.snapshot, renderCapsFor(caps, 'stdout'), options);
}
