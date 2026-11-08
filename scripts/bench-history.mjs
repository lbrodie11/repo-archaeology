#!/usr/bin/env node
/**
 * History cache benchmark (`npm run bench:history`).
 *
 * Generates a deterministic synthetic repository with `git fast-import` (default: 20,000
 * commits over 3,000 files, co-change clusters, 5% sweeping commits, occasional renames),
 * then times `diff` and `backtest` with the built CLI (`dist/cli.js`):
 *   - no-cache: `--no-cache` (reference: the pre-RA-04 code path)
 *   - cold:     empty cache (parse everything + write the cache)
 *   - warm:     no new commits (everything served from the cache)
 *   - warm+100: 100 new commits appended since the warm run (parse only those)
 *
 * Options: --commits <n> --files <n> --sweep <fraction> --repeats <n> --max-commits <n> --keep
 * The analysis uses `--max-commits` = all commits by default, so the full history is read.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { sanitizeGitEnv } from './schema-validator.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = join(ROOT, 'dist', 'cli.js');

const { values: args } = parseArgs({
  options: {
    commits: { type: 'string', default: '20000' },
    files: { type: 'string', default: '3000' },
    sweep: { type: 'string', default: '0.05' },
    repeats: { type: 'string', default: '3' },
    'max-commits': { type: 'string' },
    keep: { type: 'boolean', default: false },
  },
});
const COMMITS = Number(args.commits);
const FILES = Number(args.files);
const SWEEP = Number(args.sweep);
const REPEATS = Math.max(1, Number(args.repeats));
const MAX_COMMITS = Number(args['max-commits'] ?? COMMITS + 1000);

if (!existsSync(CLI)) {
  console.error('dist/cli.js not found: run `npm run build` first (npm run bench:history does this).');
  process.exit(1);
}

/** Deterministic PRNG (mulberry32) so every run benchmarks the same repository. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gitEnv = sanitizeGitEnv(process.env, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
});

function git(cwd, ...gitArgs) {
  const r = spawnSync('git', gitArgs, { cwd, encoding: 'utf8', env: gitEnv, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${gitArgs.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/** Streams a fast-import script that appends `count` commits on top of `state`. */
function fastImport(cwd, state, count) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['fast-import', '--quiet', '--done'], { cwd, env: gitEnv, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    child.stdin.on('error', () => {}); // a fast-import failure is reported through its exit code
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolvePromise() : reject(new Error(`fast-import failed: ${stderr}`))));

    const { random, files, clusters } = state;
    // Marks only live for one fast-import process: continue from the branch tip instead.
    if (state.head) state.head = 'refs/heads/main^0';
    const chunks = [];
    let pending = 0;
    const flush = () => {
      child.stdin.write(chunks.join(''));
      chunks.length = 0;
      pending = 0;
    };
    const data = (text) => `data ${Buffer.byteLength(text)}\n${text}\n`;
    const fileBody = (path, version) =>
      `// Module ${path} (rev ${version})\n` +
      Array.from({ length: 24 }, (_, k) => `export const symbol_${k} = ${version + k}; // line ${k} in ${path}`).join('\n') +
      '\n';
    if (!state.head) {
      // Root commit creates every file so later renames and edits always have a source.
      const n = ++state.n;
      const time = 1_577_836_800;
      chunks.push(
        `commit refs/heads/main\nmark :${n}\nauthor Dev 0 <dev0@example.com> ${time} +0000\ncommitter Dev 0 <dev0@example.com> ${time} +0000\n` +
          data('init') +
          files.map((path) => `M 100644 inline ${path}\n${data(fileBody(path, 0))}`).join(''),
      );
      state.head = `:${n}`;
      count--;
    }
    for (let i = 0; i < count; i++) {
      const n = ++state.n;
      const time = 1_577_836_800 + n * 3600;
      const who = `Dev ${n % 17}`;
      const lines = [];
      let subject;
      if (random() < SWEEP) {
        subject = `chore: sweep ${n}`;
        const touched = new Set();
        const size = 40 + Math.floor(random() * 80);
        while (touched.size < size) touched.add(Math.floor(random() * files.length));
        for (const f of touched) lines.push(`M 100644 inline ${files[f]}\n${data(fileBody(files[f], n))}`);
      } else if (random() < 0.04) {
        const f = Math.floor(random() * files.length);
        const oldPath = files[f];
        const renamed = oldPath.replace(/(?:_r\d+)?\.ts$/, `_r${n}.ts`);
        subject = `refactor: rename ${oldPath}`;
        // Realistic rename+edit: delete old path and write slightly modified content at new path so git -M runs inexact rename detection.
        lines.push(`D ${oldPath}\nM 100644 inline ${renamed}\n${data(fileBody(oldPath, n))}`);
        clusters[state.clusterOf[f]] = clusters[state.clusterOf[f]].map((x) => (x === oldPath ? renamed : x));
        files[f] = renamed;
      } else {
        const cluster = clusters[Math.floor(random() * clusters.length)];
        const touched = new Set();
        const size = 2 + Math.floor(random() * 4);
        while (touched.size < Math.min(size, cluster.length)) touched.add(cluster[Math.floor(random() * cluster.length)]);
        if (random() < 0.1) touched.add(files[Math.floor(random() * files.length)]);
        subject = `feat: change ${[...touched][0]} (${n})`;
        for (const path of touched) lines.push(`M 100644 inline ${path}\n${data(fileBody(path, n))}`);
      }
      chunks.push(
        `commit refs/heads/main\nmark :${n}\n` +
          `author ${who} <dev${n % 17}@example.com> ${time} +0000\n` +
          `committer ${who} <dev${n % 17}@example.com> ${time} +0000\n` +
          data(subject) +
          (state.head ? `from ${state.head}\n` : '') +
          lines.join(''),
      );
      state.head = `:${n}`;
      if (++pending >= 500) flush();
    }
    chunks.push('done\n');
    flush();
    child.stdin.end();
  });
}

function newState() {
  const random = rng(20260408);
  const files = [];
  const clusters = [];
  const clusterOf = [];
  for (let f = 0; f < FILES; f++) {
    const c = Math.floor(f / 6);
    files.push(`src/m${Math.floor(c / 10)}/c${c}/f${f}.ts`);
    (clusters[c] ??= []).push(files[f]);
    clusterOf.push(c);
  }
  return { random, files, clusters, clusterOf, n: 0, head: '' };
}

function timeRun(cwd, cmdArgs, cacheDir, maxCommitsOverride = MAX_COMMITS) {
  const start = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [CLI, ...cmdArgs, '--max-commits', String(maxCommitsOverride), '--json'], {
    cwd,
    encoding: 'utf8',
    env: { ...gitEnv, NO_COLOR: '1', REPO_ARCHAEOLOGY_CACHE_DIR: cacheDir },
    maxBuffer: 256 * 1024 * 1024,
  });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  if (r.status !== 0 && !(cmdArgs[0] === 'diff' && r.status === 1)) throw new Error(`${cmdArgs.join(' ')} failed: ${r.stderr}`);
  const meta = JSON.parse(r.stdout).meta;
  return { ms, cache: meta.cache, commitsRead: meta.commitsRead };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const fmt = (ms) => `${(ms / 1000).toFixed(2)} s`;

const LOG = join(ROOT, 'dist', 'git', 'log.js');
const CACHE = join(ROOT, 'dist', 'git', 'cache.js');
const HISTORY = join(ROOT, 'dist', 'model', 'history.js');
/**
 * Measures the raw-history loading stage breakdown (git rev-list, cache scan+parse,
 * and HistoryBuilder) vs uncached `readLog` (`git log --name-status`).
 */
function timeRawStages(cwd, cacheDir, maxCommits = MAX_COMMITS) {
  const script = `
    import { statSync } from 'node:fs';
    import { join } from 'node:path';
    import { readLog, listLogHashes } from ${JSON.stringify(pathToFileURL(LOG).href)};
    import { gitVersion, scanCachedCommits, parseCachedRecord } from ${JSON.stringify(pathToFileURL(CACHE).href)};
    import { HistoryBuilder } from ${JSON.stringify(pathToFileURL(HISTORY).href)};

    const root = ${JSON.stringify(cwd)};
    const cacheDir = ${JSON.stringify(cacheDir)};
    const maxCommits = ${maxCommits};

    // 1. Uncached git log --name-status + LogParser
    const t0 = performance.now();
    let count = 0;
    await readLog(root, { maxCommits }, () => { count++; });
    const gitLogMs = performance.now() - t0;

    // 2. Warm cache: git rev-list + scanCachedCommits + parseCachedRecord
    const ver = await gitVersion(root);
    const t1 = performance.now();
    const hashes = await listLogHashes(root, { maxCommits });
    const revListMs = performance.now() - t1;

    const t2 = performance.now();
    const scanned = scanCachedCommits(cacheDir, ver, hashes, new Set());
    const parsed = [];
    for (let i = 0; i < hashes.length; i++) {
      const bufIdx = scanned.segOf[i];
      if (bufIdx >= 0) {
        const line = scanned.buffers[bufIdx].toString('utf8', scanned.startOf[i], scanned.endOf[i]);
        parsed.push(parseCachedRecord(line, hashes[i]));
      }
    }
    const cacheReadParseMs = performance.now() - t2;

    // 3. HistoryBuilder over parsed records
    const t3 = performance.now();
    const builder = new HistoryBuilder({ maxFilesPerCommit: 25, ignore: [] });
    for (const c of parsed) builder.add(c);
    builder.finish();
    const builderMs = performance.now() - t3;

    const bytes = scanned.index.segments.reduce((n, s) => n + (s.bytes ?? statSync(join(cacheDir, s.file)).size), 0);
    const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
    process.stdout.write(JSON.stringify({ count, gitLogMs, revListMs, cacheReadParseMs, warmRawMs: revListMs + cacheReadParseMs, builderMs, bytes, rssMb }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd,
    encoding: 'utf8',
    env: { ...gitEnv, REPO_ARCHAEOLOGY_CACHE_DIR: cacheDir },
  });
  if (r.status !== 0) throw new Error(`raw stage timing failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), 'ra-bench-history-'));
  const repo = join(work, 'repo');
  const cacheDir = join(work, 'cache');
  try {
    git(work, 'init', '-q', '-b', 'main', repo);
    const state = newState();
    let t = Date.now();
    await fastImport(repo, state, COMMITS);
    git(repo, 'checkout', '-q', '-f', 'main');
    console.log(`Generated ${COMMITS} commits over ${FILES} files (${SWEEP * 100}% sweeps) in ${((Date.now() - t) / 1000).toFixed(1)} s`);
    console.log(`git: ${git(repo, '--version').trim()} · node ${process.version} · ${process.platform}/${process.arch} · repeats=${REPEATS} (median) · --max-commits ${MAX_COMMITS}\n`);

    // An uncommitted edit inside a cluster gives `diff` something to analyze.
    const edit = () => writeFileSync(join(repo, state.clusters[3][0]), `export const v = -1; // edited\n`);
    edit();

    const rows = [];
    for (const command of [['diff'], ['backtest']]) {
      const results = { noCache: [], cold: [], warm: [], warm100: [] };
      let last = {};
      for (let rep = 0; rep < REPEATS; rep++) {
        results.noCache.push(timeRun(repo, ['--no-cache', ...command], cacheDir).ms);
        rmSync(cacheDir, { recursive: true, force: true });
        last.cold = timeRun(repo, command, cacheDir);
        results.cold.push(last.cold.ms);
        last.warm = timeRun(repo, command, cacheDir);
        results.warm.push(last.warm.ms);
        await fastImport(repo, state, 100);
        git(repo, 'checkout', '-q', '-f', 'main');
        edit();
        last.warm100 = timeRun(repo, command, cacheDir);
        results.warm100.push(last.warm100.ms);
      }
      rows.push({ command: command[0], results, last });
    }
    // Ensure the warm cache is populated for all current commits in a single compacted segment before measuring stages and bounded --max-commits.
    rmSync(cacheDir, { recursive: true, force: true });
    timeRun(repo, ['diff'], cacheDir);
    const stages = timeRawStages(repo, cacheDir);

    const boundedRows = [];
    for (const maxC of [5000, 500]) {
      for (const cmd of ['diff', 'backtest']) {
        const noCacheTimes = [];
        const warmTimes = [];
        let hits = 0;
        for (let rep = 0; rep < REPEATS; rep++) {
          noCacheTimes.push(timeRun(repo, ['--no-cache', cmd], cacheDir, maxC).ms);
          const w = timeRun(repo, [cmd], cacheDir, maxC);
          warmTimes.push(w.ms);
          hits = w.cache.hits;
        }
        const rawSub = timeRawStages(repo, cacheDir, maxC);
        boundedRows.push({
          maxCommits: maxC,
          command: cmd,
          noCacheMs: median(noCacheTimes),
          warmMs: median(warmTimes),
          hits,
          rawGitLogMs: rawSub.gitLogMs,
          rawWarmMs: rawSub.warmRawMs,
        });
      }
    }

    console.log('| Command (end-to-end CLI) | --no-cache | Cold (empty cache) | Warm (no new commits) | Warm + 100 new commits | Cold ÷ Warm |');
    console.log('| :--- | ---: | ---: | ---: | ---: | ---: |');
    for (const { command, results, last } of rows) {
      const cold = median(results.cold);
      const warm = median(results.warm);
      console.log(
        `| \`${command}\` | ${fmt(median(results.noCache))} | ${fmt(cold)} (${last.cold.cache.misses} misses) | ${fmt(warm)} (${last.warm.cache.hits} hits) | ${fmt(median(results.warm100))} (${last.warm100.cache.misses} misses) | ${(cold / warm).toFixed(1)}× |`,
      );
    }
    console.log('');
    console.log('Bounded `--max-commits` against warm 20k-commit cache (`O(maxCommits)` prefix scan vs `--no-cache`):\n');
    console.log('| Command | `--max-commits` | `--no-cache` (CLI) | Warm 20k cache (CLI) | Raw `git log` | Raw warm scan+parse | Raw speedup |');
    console.log('| :--- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const b of boundedRows) {
      console.log(
        `| \`${b.command}\` | ${b.maxCommits} | ${fmt(b.noCacheMs)} | ${fmt(b.warmMs)} (${b.hits} hits) | ${fmt(b.rawGitLogMs)} | ${fmt(b.rawWarmMs)} | ${(b.rawGitLogMs / b.rawWarmMs).toFixed(1)}× |`,
      );
    }
    console.log('');
    console.log('Raw history loading stage breakdown (isolated from working-tree bridge indexing & model construction):\n');
    console.log('| Stage | Time | Notes |');
    console.log('| :--- | ---: | :--- |');
    console.log(`| Uncached \`git log --name-status\` + \`LogParser\` | ${fmt(stages.gitLogMs)} | ${stages.count} commits parsed from git |`);
    console.log(`| Warm \`git rev-list\` + cache load & parse | ${fmt(stages.warmRawMs)} | \`rev-list\`: ${fmt(stages.revListMs)} · cache read+parse: ${fmt(stages.cacheReadParseMs)} |`);
    console.log(`| **Raw history speedup (Uncached ÷ Warm)** | **${(stages.gitLogMs / stages.warmRawMs).toFixed(1)}×** | Cache disk size: ${(stages.bytes / (1024 * 1024)).toFixed(1)} MB · RSS: ${stages.rssMb} MB |`);
    console.log(`| Downstream \`HistoryBuilder\` (post-cache) | ${fmt(stages.builderMs)} | Rename tracking + ignore/sweep filtering |`);
    console.log('');
  } finally {
    if (args.keep) console.log(`Kept benchmark repository at ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
