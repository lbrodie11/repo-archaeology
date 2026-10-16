import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { posix } from 'node:path';
import type { Context } from '../context.js';
import type { Relationship } from '../imports/classify.js';
import { renderMapHtml } from '../map/template.js';
import { buildMeta, toView, type Meta } from '../report/views.js';
import { c } from '../util/term.js';
import { classifiedPairs } from './scan.js';

export interface MapOptions {
  /** Maximum number of relationships drawn. */
  edges: number;
  kinds: Relationship[];
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
  shared: number;
  confidence: number;
  reverseConfidence: number;
  lastTogether: string;
  evidence: { hash: string; date: string; subject: string }[];
}

export interface MapData {
  meta: Meta;
  repoName: string;
  generatedAt: string;
  counts: Record<Relationship, number>;
  nodes: MapNode[];
  edges: MapEdge[];
}

export function buildMapData(ctx: Context, options: Pick<MapOptions, 'edges' | 'kinds'>): MapData {
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
  for (const { companion, relationship } of classifiedPairs(ctx)) {
    counts[relationship]++;
    if (edges.length >= options.edges || !options.kinds.includes(relationship)) continue;
    const view = toView(ctx, companion, relationship);
    edges.push({
      source: nodeFor(view.from),
      target: nodeFor(view.to),
      relationship,
      why: view.why,
      shared: view.shared,
      confidence: view.confidence,
      reverseConfidence: view.reverseConfidence,
      lastTogether: view.lastTogether,
      evidence: view.evidence.map((e) => ({ hash: e.hash, date: e.date, subject: e.subject })),
    });
  }
  return { meta: buildMeta(ctx), repoName: basename(ctx.root), generatedAt: new Date().toISOString(), counts, nodes, edges };
}

export function defaultMapPath(root: string): string {
  const safe = basename(root).replace(/[^\w.-]+/g, '_') || 'repo';
  return join(tmpdir(), 'repo-archaeology', `${safe}-map.html`);
}

export function writeMap(ctx: Context, options: MapOptions): { file: string; data: MapData } {
  const data = buildMapData(ctx, options);
  const file = options.out ? resolve(ctx.cwd, options.out) : defaultMapPath(ctx.root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderMapHtml(data), 'utf8');
  return { file, data };
}

/** Opens a file in the default browser; failures are silent because the path is printed anyway. */
export function openInBrowser(file: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [file]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', `"${file}"`]]
        : ['xdg-open', [file]];
  try {
    const child = spawn(command as string, args as string[], { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // ignore: the path is printed for the user to open
  }
}

export function printMap(file: string, data: MapData, opened: boolean): void {
  const ghosts = data.edges.filter((e) => e.relationship === 'ghost').length;
  console.log(`${c.bold('Repo Archaeology')} ${c.dim('·')} map`);
  for (const warning of data.meta.warnings) console.log(c.yellow(`! ${warning}`));
  if (data.edges.length === 0) {
    console.log('No relationships passed the thresholds, so the map is empty. Try --min-shared 2 or --min-confidence 0.3.');
  } else {
    console.log(`Drew ${data.edges.length} relationships between ${data.nodes.length} files (${ghosts} ghost wires).`);
  }
  console.log(`${opened ? 'Opened' : 'Wrote'} ${c.bold(file)}`);
}
