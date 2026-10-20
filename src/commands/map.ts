import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import type { Context } from '../context.js';
import { fetchPairCommitPatches, type FilePatchEvidence } from '../git/patch.js';
import { runGit } from '../git/run.js';
import { parallelImplementation, type HiddenBridge, type Relationship } from '../imports/classify.js';
import { renderMapHtml } from '../map/template.js';
import { buildFindingFamilies, type FindingFamilyView } from '../model/families.js';
import { resolveCommitFileChange } from '../model/history.js';
import { buildMeta, toView, type Meta, type RelationshipView } from '../report/views.js';
import { c, isoDate, plural, terminalText } from '../util/term.js';
import { formatExplainCommand, MAX_COUNTEREXAMPLES_PER_SIDE } from './explain.js';
import { classifiedPairs } from './scan.js';

export const MAX_MAP_PATCH_EDGES = 20;
export const MAX_MAP_COMMITS_PER_EDGE = 2;
export const MAX_MAP_PATCH_TIME_MS = 5000;

export interface MapOptions {
  /** Maximum number of relationships drawn. */
  edges: number;
  kinds: Relationship[];
  /** Optional cap for unchecked relationships so they do not consume the map. */
  uncheckedCap?: number;
  /** Opt-in: embed bounded git diff hunks for top relationships into the HTML file. */
  includePatches?: boolean;
  out?: string;
  open: boolean;
}

export interface MapNode {
  path: string;
  dir: string;
  changes: number;
  topAuthor?: string;
  topAuthorShare?: number;
}

export interface MapEdgeEvidence {
  hash: string;
  date: string;
  subject: string;
  sourcePath?: string;
  targetPath?: string;
  sourceStatus?: string;
  targetStatus?: string;
  patches?: {
    source: FilePatchEvidence;
    target: FilePatchEvidence;
  };
}

export interface MapCounterexample {
  hash: string;
  date: string;
  subject: string;
}

export interface MapEdge {
  /** Index into nodes: the file whose changes predict the other (stronger direction). */
  source: number;
  target: number;
  relationship: Relationship;
  why: string;
  hiddenBridge?: HiddenBridge;
  shared: number;
  fromChanges: number;
  toChanges: number;
  confidence: number;
  reverseConfidence: number;
  score: number;
  overviewPriority: number;
  weighted: boolean;
  lastTogether: string;
  crossesDirectories: boolean;
  evidence: MapEdgeEvidence[];
  counterexamples?: {
    fromOnlyTotal?: number;
    toOnlyTotal?: number;
    fromOnly: MapCounterexample[];
    toOnly: MapCounterexample[];
  };
  explainCommand?: string;
}

export interface MapUndrawnPair {
  from: string;
  to: string;
  relationship: Relationship;
  why: string;
  shared: number;
  fromChanges: number;
  toChanges: number;
  confidence: number;
  reverseConfidence: number;
  score: number;
  weighted: boolean;
  lastTogether: string;
  explainCommand: string;
}

export interface MapFamily extends Omit<FindingFamilyView, 'relationships'> {
  /** Indices into `data.nodes` corresponding to `members` (`-1` when a member has no drawn edges). */
  nodeIndices: number[];
  /** Indices into `data.edges` for the qualifying pairwise edges in this family that were drawn. */
  edgeIndices: number[];
  /** Qualifying pairwise relationships in this family that met thresholds but were omitted from `data.edges` by display caps. */
  undrawnPairs?: MapUndrawnPair[];
  /** Sorted member index arrays for every qualifying commit in this family, enabling exact active-member stats when filtered. */
  commitMemberIndices?: number[][];
  /** Highest `overviewPriority` among `edgeIndices`. */
  overviewPriority: number;
}

export interface MapData {
  meta: Meta;
  repoName: string;
  generatedAt: string;
  counts: Record<Relationship, number>;
  classificationTruncated: boolean;
  patchesIncluded?: boolean;
  nodes: MapNode[];
  edges: MapEdge[];
  families?: MapFamily[];
}

export function buildMapData(ctx: Context, options: Pick<MapOptions, 'edges' | 'kinds' | 'uncheckedCap'>): MapData {
  const generatedAt = new Date().toISOString();
  // "Past year" is measured back from the newest analyzed commit, not from today: an inactive
  // repository, or a run with --before, would otherwise have nothing that counts as recent.
  const newest = ctx.history.stats.newestTime;
  const recencyReference = newest !== undefined ? newest * 1000 : Date.parse(generatedAt);
  const nodes: MapNode[] = [];
  const nodeIndex = new Map<string, number>();
  const nodeFor = (path: string): number => {
    let index = nodeIndex.get(path);
    if (index === undefined) {
      const id = ctx.model.id(path)!;
      const [top] = ctx.model.topAuthors(id, 1);
      index = nodes.length;
      nodeIndex.set(path, index);
      nodes.push({
        path,
        dir: posix.dirname(path) === '.' ? '(root)' : posix.dirname(path),
        changes: ctx.model.changeCount[id] ?? 0,
        topAuthor: top?.author,
        topAuthorShare: top ? Math.round(top.share * 100) / 100 : undefined,
      });
    }
    return index;
  };

  // Index commit indices by file ID (sorted newest first by author time) for fast counterexample lookup.
  const commitsByFile: number[][] = Array.from({ length: ctx.model.fileCount }, () => []);
  const commitFileSets: Set<number>[] = [];
  const sortedCommitIndices = ctx.model.commits
    .map((_, idx) => idx)
    .sort((x, y) => {
      const cx = ctx.model.commits[x]!;
      const cy = ctx.model.commits[y]!;
      return cy.time - cx.time || cy.commitTime - cx.commitTime || x - y;
    });
  for (let i = 0; i < ctx.model.commits.length; i++) {
    const cIds = new Set<number>();
    for (const f of ctx.model.commits[i]!.files) {
      const fid = ctx.model.id(f);
      if (fid !== undefined) cIds.add(fid);
    }
    commitFileSets.push(cIds);
  }
  for (const idx of sortedCommitIndices) {
    for (const fid of commitFileSets[idx]!) {
      commitsByFile[fid]!.push(idx);
    }
  }

  const findCounterexamples = (fileId: number, otherId: number): { total: number; items: MapCounterexample[] } => {
    const items: MapCounterexample[] = [];
    let total = 0;
    for (const idx of commitsByFile[fileId] ?? []) {
      if (commitFileSets[idx]!.has(otherId)) continue;
      total++;
      if (items.length < MAX_COUNTEREXAMPLES_PER_SIDE) {
        const commit = ctx.model.commits[idx]!;
        items.push({ hash: commit.hash, date: isoDate(commit.time), subject: commit.subject });
      }
    }
    return { total, items };
  };

  const counts: Record<Relationship, number> = { ghost: 0, unknown: 0, indirect: 0, direct: 0, test: 0 };
  const edges: MapEdge[] = [];
  const familyCandidates: RelationshipView[] = [];
  const edgeIndexByPairKey = new Map<string, number>();
  let unchecked = 0;
  const classified = classifiedPairs(ctx);
  const hasPrimary = classified.entries.some(({ relationship }) => relationship !== 'unknown' && options.kinds.includes(relationship));
  const uncheckedCap = hasPrimary ? options.uncheckedCap : undefined;
  for (const { companion, relationship } of classified.entries) {
    counts[relationship]++;
    if (!options.kinds.includes(relationship)) continue;
    const fromPath = ctx.model.path(companion.from);
    const toPath = ctx.model.path(companion.to);
    let cachedView: RelationshipView | undefined;
    if (parallelImplementation(fromPath, toPath) !== undefined) {
      cachedView = toView(ctx, companion, relationship, fromPath, toPath);
      familyCandidates.push(cachedView);
    }
    if (relationship === 'unknown' && uncheckedCap !== undefined && unchecked >= uncheckedCap) continue;
    if (edges.length >= options.edges) continue;
    const view = cachedView ?? toView(ctx, companion, relationship, fromPath, toPath);
    if (relationship === 'unknown') unchecked++;

    const evidence: MapEdgeEvidence[] = companion.stat.evidence.map((commitIdx) => {
      const commit = ctx.model.commits[commitIdx]!;
      const srcChange = resolveCommitFileChange(commit, view.from);
      const tgtChange = resolveCommitFileChange(commit, view.to);
      return {
        hash: commit.hash,
        date: isoDate(commit.time),
        subject: commit.subject,
        ...(srcChange.path !== view.from ? { sourcePath: srcChange.path } : {}),
        ...(tgtChange.path !== view.to ? { targetPath: tgtChange.path } : {}),
        ...(srcChange.status !== 'M' ? { sourceStatus: srcChange.status } : {}),
        ...(tgtChange.status !== 'M' ? { targetStatus: tgtChange.status } : {}),
      };
    });

    const cxFrom = findCounterexamples(companion.from, companion.to);
    const cxTo = findCounterexamples(companion.to, companion.from);

    const edgeIndex = edges.length;
    const [u, v] = view.from < view.to ? [view.from, view.to] : [view.to, view.from];
    edgeIndexByPairKey.set(`${u}\u0000${v}`, edgeIndex);

    edges.push({
      source: nodeFor(view.from),
      target: nodeFor(view.to),
      relationship,
      why: view.why,
      hiddenBridge: view.hiddenBridge,
      shared: view.shared,
      fromChanges: view.fromChanges,
      toChanges: view.toChanges,
      confidence: view.confidence,
      reverseConfidence: view.reverseConfidence,
      score: companion.score,
      overviewPriority: mapOverviewPriority({ ...view, confidence: companion.confidence, reverseConfidence: companion.reverseConfidence }, ctx.thresholds.minConfidence, recencyReference),
      weighted: view.weighted,
      lastTogether: view.lastTogether,
      crossesDirectories: view.crossesDirectories,
      evidence,
      counterexamples: {
        fromOnlyTotal: cxFrom.total,
        toOnlyTotal: cxTo.total,
        fromOnly: cxFrom.items,
        toOnly: cxTo.items,
      },
      explainCommand: formatExplainCommand(view.from, view.to, ctx.settings, ctx.flagSettings),
    });
  }

  const commitMemberIndicesByFamily = new Map<string, number[][]>();
  const rawFamilies = buildFindingFamilies(ctx, familyCandidates, {
    allowedKinds: options.kinds,
    commitMemberIndicesByFamily,
  });
  const families: MapFamily[] = rawFamilies.map((fam) => {
    const nodeIndices = fam.members.map((m) => nodeIndex.get(m.path) ?? -1);
    const edgeIndices: number[] = [];
    const undrawnPairs: MapUndrawnPair[] = [];
    for (const rel of fam.relationships) {
      const [u, v] = rel.from < rel.to ? [rel.from, rel.to] : [rel.to, rel.from];
      const eIdx = edgeIndexByPairKey.get(`${u}\u0000${v}`);
      if (eIdx !== undefined) {
        edgeIndices.push(eIdx);
      } else {
        undrawnPairs.push({
          from: rel.from,
          to: rel.to,
          relationship: rel.relationship,
          why: rel.why,
          shared: rel.shared,
          fromChanges: rel.fromChanges,
          toChanges: rel.toChanges,
          confidence: rel.confidence,
          reverseConfidence: rel.reverseConfidence,
          score: rel.score,
          weighted: rel.weighted,
          lastTogether: rel.lastTogether,
          explainCommand: formatExplainCommand(rel.from, rel.to, ctx.settings, ctx.flagSettings),
        });
      }
    }
    const overviewPriority = Math.max(0, ...edgeIndices.map((idx) => edges[idx]?.overviewPriority ?? 0));
    const commitMemberIndices = commitMemberIndicesByFamily.get(fam.id);
    const { relationships: _relationships, ...famBase } = fam;
    return {
      ...famBase,
      nodeIndices,
      edgeIndices,
      ...(undrawnPairs.length > 0 ? { undrawnPairs } : {}),
      ...(commitMemberIndices ? { commitMemberIndices } : {}),
      overviewPriority,
    };
  });

  const repoName = basename(ctx.root);
  // The map is meant to be shared, so it must not reveal where the repo lives on this machine.
  const meta = { ...buildMeta(ctx), root: repoName, warnings: [...ctx.warnings] };
  return { meta, repoName, generatedAt, counts, classificationTruncated: classified.truncated, patchesIncluded: false, nodes, edges, families };
}

/**
 * Opt-in enrichment (`--include-patches`): embeds bounded git diff hunks for the highest-priority
 * map relationships while enforcing strict commit, hunk, line, and wall-clock limits.
 */
export async function attachMapPatches(ctx: Context, data: MapData): Promise<void> {
  const commitByHash = new Map(ctx.model.commits.map((c) => [c.hash, c]));
  const prioritized = [...data.edges].sort((a, b) => {
    const aGhost = a.relationship === 'ghost' ? 1 : 0;
    const bGhost = b.relationship === 'ghost' ? 1 : 0;
    return bGhost - aGhost || b.overviewPriority - a.overviewPriority || b.score - a.score || b.shared - a.shared;
  });

  const startMs = Date.now();
  const deadlineMs = startMs + MAX_MAP_PATCH_TIME_MS;
  for (const edge of prioritized.slice(0, MAX_MAP_PATCH_EDGES)) {
    const fromPath = data.nodes[edge.source]?.path;
    const toPath = data.nodes[edge.target]?.path;
    if (!fromPath || !toPath) continue;
    for (const ev of edge.evidence.slice(0, MAX_MAP_COMMITS_PER_EDGE)) {
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) break;
      const commit = commitByHash.get(ev.hash);
      if (!commit) continue;
      const changeA = resolveCommitFileChange(commit, fromPath);
      const changeB = resolveCommitFileChange(commit, toPath);
      const { patchA, patchB } = await fetchPairCommitPatches(ctx.root, ev.hash, fromPath, changeA, toPath, changeB, {
        contextLines: 1,
        maxPatchBytes: 32 * 1024,
        maxHunksPerFile: 2,
        maxLinesPerHunk: 12,
        timeoutMs: Math.min(2000, remainingMs),
        deadlineMs,
      });
      ev.patches = { source: patchA, target: patchB };
    }
  }

  data.patchesIncluded = true;
  const privacyWarning =
    'Bounded source-code patches are embedded in this report (--include-patches). Review before sharing externally.';
  if (!data.meta.warnings.includes(privacyWarning)) {
    data.meta.warnings.push(privacyWarning);
  }
}

export function mapOverviewPriority(
  view: Pick<RelationshipView, 'from' | 'to' | 'confidence' | 'reverseConfidence' | 'lastTogether' | 'hiddenBridge'>,
  minConfidence: number,
  referenceTime: number,
): number {
  const age = referenceTime - Date.parse(view.lastTogether);
  if (!Number.isFinite(age) || age < 0 || age > 365 * 86400000
    || Math.min(view.confidence, view.reverseConfidence) < minConfidence) return 0;
  const fromDir = posix.dirname(view.from);
  const toDir = posix.dirname(view.to);
  const independent = fromDir !== toDir && fromDir !== '.' && toDir !== '.'
    && !fromDir.startsWith(`${toDir}/`) && !toDir.startsWith(`${fromDir}/`);
  return independent && view.hiddenBridge?.signal !== 'parallel-implementation' ? 2 : 1;
}

/**
 * Default location: inside the repository's .git folder. It is never committed,
 * stays the same between runs, and (unlike a shared temp folder) cannot be
 * pre-created by another user of the machine.
 */
export async function defaultMapPath(root: string): Promise<string> {
  const gitDir = (await runGit(root, ['rev-parse', '--absolute-git-dir'])).trim();
  return join(gitDir, 'repo-archaeology', 'map.html');
}

export async function writeMap(ctx: Context, options: MapOptions): Promise<{ file: string; data: MapData }> {
  const data = buildMapData(ctx, options);
  if (options.includePatches) {
    await attachMapPatches(ctx, data);
  }
  // --out is relative to where the command was run, even with --cwd.
  const file = options.out ? resolve(process.cwd(), options.out) : await defaultMapPath(ctx.root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderMapHtml(data), 'utf8');
  return { file, data };
}

/**
 * Opens a file in the default browser; failures are silent because the path is printed anyway.
 * No shell is involved on any platform, so unusual file names cannot run commands.
 */
export function openInBrowser(file: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  try {
    const child = spawn(command, [file], { stdio: 'ignore', detached: true });
    child.on('error', () => { });
    child.unref();
  } catch {
    // ignore: the path is printed for the user to open
  }
}

export function printMap(file: string, data: MapData, opened: boolean): void {
  const ghosts = data.edges.filter((e) => e.relationship === 'ghost').length;
  const familyCount = data.families?.length ?? 0;
  const familyNote = familyCount > 0 ? `, ${plural(familyCount, 'finding family', 'finding families')}` : '';
  console.log(`${c.bold('Repo Archaeology')} ${c.dim('·')} map`);
  for (const warning of data.meta.warnings) console.log(c.yellow(`! ${terminalText(warning)}`));
  if (data.edges.length === 0) {
    console.log('No relationships passed the thresholds, so the map is empty. Try --min-shared 2 or --min-confidence 0.3.');
  } else {
    console.log(`Drew ${data.edges.length} relationships between ${data.nodes.length} files (${ghosts} ghost wires${familyNote}).`);
  }
  if (data.classificationTruncated) console.log(c.yellow('Only the strongest relationships were classified; additional relationship kinds may exist.'));
  console.log(`${opened ? 'Opened' : 'Wrote'} ${c.bold(terminalText(file))}`);
}
