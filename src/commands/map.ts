import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import type { Context } from '../context.js';
import { runGit } from '../git/run.js';
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
  const repoName = basename(ctx.root);
  // The map is meant to be shared, so it must not reveal where the repo lives on this machine.
  const meta = { ...buildMeta(ctx), root: repoName };
  return { meta, repoName, generatedAt: new Date().toISOString(), counts, nodes, edges };
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
