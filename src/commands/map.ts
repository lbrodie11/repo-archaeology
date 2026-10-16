import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import type { Context } from '../context.js';
import { runGit } from '../git/run.js';
import type { HiddenBridge, Relationship } from '../imports/classify.js';
import { renderMapHtml } from '../map/template.js';
import { buildMeta, toView, type Meta, type RelationshipView } from '../report/views.js';
import { c, terminalText } from '../util/term.js';
import { classifiedPairs } from './scan.js';

export interface MapOptions {
  /** Maximum number of relationships drawn. */
  edges: number;
  kinds: Relationship[];
  /** Optional cap for unchecked relationships so they do not consume the map. */
  uncheckedCap?: number;
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
  evidence: { hash: string; date: string; subject: string }[];
}

export interface MapData {
  meta: Meta;
  repoName: string;
  generatedAt: string;
  counts: Record<Relationship, number>;
  classificationTruncated: boolean;
  nodes: MapNode[];
  edges: MapEdge[];
}

export function buildMapData(ctx: Context, options: Pick<MapOptions, 'edges' | 'kinds' | 'uncheckedCap'>): MapData {
  const generatedAt = new Date().toISOString();
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

  const counts: Record<Relationship, number> = { ghost: 0, unknown: 0, direct: 0, test: 0 };
  const edges: MapEdge[] = [];
  let unchecked = 0;
  const classified = classifiedPairs(ctx);
  const hasPrimary = classified.entries.some(({ relationship }) => relationship !== 'unknown' && options.kinds.includes(relationship));
  const uncheckedCap = hasPrimary ? options.uncheckedCap : undefined;
  for (const { companion, relationship } of classified.entries) {
    counts[relationship]++;
    if (!options.kinds.includes(relationship)) continue;
    if (relationship === 'unknown' && uncheckedCap !== undefined && unchecked >= uncheckedCap) continue;
    if (edges.length >= options.edges) continue;
    const view = toView(ctx, companion, relationship);
    if (relationship === 'unknown') unchecked++;
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
      overviewPriority: mapOverviewPriority({ ...view, confidence: companion.confidence, reverseConfidence: companion.reverseConfidence }, ctx.thresholds.minConfidence, Date.parse(generatedAt)),
      weighted: view.weighted,
      lastTogether: view.lastTogether,
      crossesDirectories: view.crossesDirectories,
      evidence: view.evidence.map((e) => ({ hash: e.hash, date: e.date, subject: e.subject })),
    });
  }
  const repoName = basename(ctx.root);
  // The map is meant to be shared, so it must not reveal where the repo lives on this machine.
  const meta = { ...buildMeta(ctx), root: repoName };
  return { meta, repoName, generatedAt, counts, classificationTruncated: classified.truncated, nodes, edges };
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
  console.log(`${c.bold('Repo Archaeology')} ${c.dim('·')} map`);
  for (const warning of data.meta.warnings) console.log(c.yellow(`! ${terminalText(warning)}`));
  if (data.edges.length === 0) {
    console.log('No relationships passed the thresholds, so the map is empty. Try --min-shared 2 or --min-confidence 0.3.');
  } else {
    console.log(`Drew ${data.edges.length} relationships between ${data.nodes.length} files (${ghosts} ghost wires).`);
  }
  if (data.classificationTruncated) console.log(c.yellow('Only the strongest relationships were classified; additional relationship kinds may exist.'));
  console.log(`${opened ? 'Opened' : 'Wrote'} ${c.bold(terminalText(file))}`);
}
