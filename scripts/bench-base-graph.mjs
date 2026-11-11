#!/usr/bin/env node
/**
 * Base-tree import graph benchmark (RA-20): the cost of the base-tree importers of the paths a
 * merged pull request removes (deleted or renamed away), two ways.
 *
 *   - second session ("today", Gutter GU-31): `openRepository({ head: <base>, settings: { maxCommits: 1,
 *     cache: { enabled: false } }, useConfigFile: false })` + `importGraph({ files: removed })` + `close()`.
 *   - derived (RA-20): on a head session that already built its graph (`importGraph()`, untimed, as
 *     Gutter does), `importGraph({ files: removed, at: <base> })`.
 *
 * Pull requests: the first `--prs` first-parent commits from `--rev` (default HEAD) whose subject names
 * a PR (`(#123)` or `Merge pull request`) and that remove at least one TS/JS, Go or Python file. Base is
 * the first parent. Each PR is measured `--repeats` times, interleaved; the per-PR value is the median.
 * Every derived result is checked against the second session's (files, edges, unresolved, languages,
 * meta.imports): any mismatch is reported and fails the run.
 *
 * Memory (run with `node --expose-gc`): heap retained after GC by the head session's graph, and the
 * extra heap the derived index keeps while the session is open. `--lib <dist/api/index.js>` points at
 * another build (for example main's) to compare the head graph's retained heap.
 *
 *   npm run build && node --expose-gc scripts/bench-base-graph.mjs --repo ~/.cache/gutter-bench/honojs__hono
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '..');
const { values: args } = parseArgs({
  options: {
    repo: { type: 'string' },
    rev: { type: 'string', default: 'HEAD' },
    prs: { type: 'string', default: '20' },
    repeats: { type: 'string', default: '3' },
    lib: { type: 'string', default: join(ROOT, 'dist', 'api', 'index.js') },
    out: { type: 'string' },
    'memory-only': { type: 'boolean', default: false },
  },
});
if (!args.repo) throw new Error('--repo <dir> is required');
const REPO = resolve(args.repo);
const PRS = Number(args.prs);
const REPEATS = Math.max(1, Number(args.repeats));
const lib = await import(pathToFileURL(resolve(args.lib)).href);
const SETTINGS = { maxCommits: 1, cache: { enabled: false } };
const ANALYZABLE = /\.(?:[cm]?[jt]sx?|go|py)$/;

const git = (...a) => {
  const r = spawnSync('git', a, { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

function selectPrs() {
  const out = [];
  for (const line of git('log', '--first-parent', '-n', '5000', '--format=%H %P%x09%s', args.rev).split('\n')) {
    if (out.length >= PRS) break;
    const [ids, subject = ''] = line.split('\t');
    const [sha, parent] = (ids ?? '').split(' ');
    if (!sha || !parent || !/\(#\d+\)|Merge pull request/.test(subject)) continue;
    const removed = git('diff-tree', '-r', '-z', '--no-commit-id', '--no-renames', '--diff-filter=D', '--name-only', parent, sha)
      .split('\0')
      .filter(Boolean);
    if (!removed.some((p) => ANALYZABLE.test(p))) continue;
    out.push({ sha, base: parent, subject: subject.slice(0, 80), removed });
  }
  return out;
}

const gc = () => globalThis.gc?.();
const heap = () => {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
};
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const open = (head) => lib.openRepository({ cwd: REPO, head, settings: SETTINGS, useConfigFile: false });
const part = (g) => JSON.stringify([g.files, g.edges, g.unresolved, g.languages, g.meta.imports]);

async function secondSession(pr) {
  const t0 = performance.now();
  const repo = await open(pr.base);
  try {
    const graph = await repo.importGraph({ files: pr.removed });
    return { ms: performance.now() - t0, graph };
  } finally {
    await repo.close();
  }
}

async function derived(pr) {
  const repo = await open(pr.sha);
  try {
    const h0 = heap();
    await repo.importGraph();
    const h1 = heap();
    let stats;
    const t0 = performance.now();
    const graph = await repo.importGraph({ files: pr.removed, at: pr.base, onReuse: (s) => (stats = s) });
    const ms = performance.now() - t0;
    const h2 = heap();
    return { ms, graph, stats, headGraphHeap: h1 - h0, derivedHeap: h2 - h1 };
  } finally {
    await repo.close();
  }
}

const prs = selectPrs();
console.error(`${REPO}: ${prs.length} PRs`);
const rows = [];
for (const pr of prs) {
  // Warm-up: fetches any missing blobs of a blobless clone, so the timings below are local reads.
  await secondSession(pr);
  const warm = await open(pr.sha);
  try {
    await warm.importGraph();
  } finally {
    await warm.close();
  }
  if (args['memory-only']) {
    const repo = await open(pr.sha);
    const h0 = heap();
    await repo.importGraph();
    rows.push({ pr: pr.sha.slice(0, 7), headGraphHeap: heap() - h0 });
    await repo.close();
    continue;
  }
  const today = [];
  const fresh = [];
  let check;
  for (let i = 0; i < REPEATS; i++) {
    const a = await secondSession(pr);
    const b = await derived(pr);
    today.push(a.ms);
    fresh.push(b);
    check ??= part(a.graph) === part(b.graph);
  }
  const row = {
    pr: pr.sha.slice(0, 7),
    subject: pr.subject,
    removed: pr.removed.length,
    files: fresh[0].graph.files.length,
    todayMs: median(today),
    derivedMs: median(fresh.map((f) => f.ms)),
    reused: fresh[0].stats?.reused,
    extracted: fresh[0].stats?.extracted,
    headGraphHeap: median(fresh.map((f) => f.headGraphHeap)),
    derivedHeap: median(fresh.map((f) => f.derivedHeap)),
    parity: check,
  };
  rows.push(row);
  console.error(JSON.stringify(row));
}

const summary = (key) => ({ p50: median(rows.map((r) => r[key])), p95: pct(rows.map((r) => r[key]), 95) });
const result = args['memory-only']
  ? { repo: REPO, rows, headGraphHeap: summary('headGraphHeap') }
  : {
      repo: REPO,
      rev: git('rev-parse', args.rev).trim(),
      repeats: REPEATS,
      prs: rows.length,
      today: summary('todayMs'),
      derived: summary('derivedMs'),
      ratioP95: pct(rows.map((r) => r.derivedMs), 95) / pct(rows.map((r) => r.todayMs), 95),
      headGraphHeap: summary('headGraphHeap'),
      derivedHeap: summary('derivedHeap'),
      parityFailures: rows.filter((r) => !r.parity).map((r) => r.pr),
      rows,
    };
const text = JSON.stringify(result, null, 2);
if (args.out) writeFileSync(args.out, `${text}\n`);
console.log(text);
if (!args['memory-only'] && result.parityFailures.length > 0) process.exitCode = 1;
