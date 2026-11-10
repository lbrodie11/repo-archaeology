#!/usr/bin/env node
/**
 * RA-18 surface pilot runner (research only; see docs/research/surface-pilot.md).
 *
 *   node --import tsx scripts/surface-pilot/run.ts corpus-a --repo hono --git <bare clone>
 *   node --import tsx scripts/surface-pilot/run.ts corpus-b --repo hono --git <bare clone> [--gutter-bench <bench.json>]
 *
 * Clones are bare (`git clone --bare <url>`); nothing is checked out, installed, built or
 * run from them. Mutations are written as single commits on `refs/surface-pilot/*` with git
 * plumbing (a temporary index), so the clone's own refs are untouched.
 * Raw records go to docs/research/data/surface-pilot/.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { listTreeFiles } from '../../src/git/repo.js';
import { gitTreeFiles } from '../../src/imports/tree-files.js';
import { analyzeSurfaceChange } from '../../src/surface/analyze.js';
import type { SurfaceAnalysis } from '../../src/surface/types.js';
import { sanitizeGitEnv } from '../schema-validator.mjs';
import { CORPORA, FOLLOW_UP_DAYS, PRS_PER_REPO, type CorpusRepo } from './corpora.js';
import { applyEdits, generateMutations, SEED, type Mutation } from './mutate.js';
import { Oracle, typecheckConsumer } from './oracle.js';

export const DATA_DIR = resolve(import.meta.dirname, '..', '..', 'docs', 'research', 'data', 'surface-pilot');

const FIXED_DATE = '1793232000 +0000'; // 2026-10-30, so mutation commit ids are reproducible

function git(gitDir: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: gitDir,
    // No stdin at all: piping `input` to `hash-object --stdin` hung intermittently (Node 20, worker threads alive).
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: sanitizeGitEnv(process.env, { GIT_OPTIONAL_LOCKS: '0', ...env }),
  });
}

/** Writes `path` = `text` on top of `pin` as one commit on `refs/surface-pilot/<id>`. */
export function commitMutation(gitDir: string, pin: string, path: string, text: string, id: string): string {
  const scratch = mkdtempSync(join(tmpdir(), 'ra18-index-'));
  try {
    const env = {
      GIT_INDEX_FILE: join(scratch, 'index'),
      GIT_AUTHOR_NAME: 'RA-18 pilot',
      GIT_AUTHOR_EMAIL: 'pilot@invalid',
      GIT_COMMITTER_NAME: 'RA-18 pilot',
      GIT_COMMITTER_EMAIL: 'pilot@invalid',
      GIT_AUTHOR_DATE: FIXED_DATE,
      GIT_COMMITTER_DATE: FIXED_DATE,
    };
    git(gitDir, ['read-tree', pin], env);
    const mode = git(gitDir, ['ls-tree', pin, '--', path]).split(' ')[0] || '100644';
    const blobFile = join(scratch, 'blob');
    writeFileSync(blobFile, text);
    const blob = git(gitDir, ['hash-object', '-w', '--no-filters', '--', blobFile]).trim();
    git(gitDir, ['update-index', '--cacheinfo', `${mode},${blob},${path}`], env);
    const tree = git(gitDir, ['write-tree'], env).trim();
    const sha = git(gitDir, ['commit-tree', tree, '-p', pin, '-m', `RA-18 mutation ${id}`], env).trim();
    git(gitDir, ['update-ref', `refs/surface-pilot/${id}`, sha]);
    return sha;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The analysis, trimmed to what the report needs (paths, names, statuses). */
export function summarize(analysis: SurfaceAnalysis) {
  return {
    changedSourceFiles: analysis.changedSourceFiles,
    deltas: analysis.deltas.map((d) => ({
      file: d.file,
      status: d.status,
      ...(d.reason ? { reason: d.reason } : {}),
      fileStatus: d.fileStatus,
      entries: d.entries.map((e) => ({ name: e.name, change: e.change, ...(e.reasons ? { reasons: e.reasons } : {}) })),
      ...(d.opaqueAdded.length ? { opaqueAdded: d.opaqueAdded } : {}),
      ...(d.opaqueRemoved.length ? { opaqueRemoved: d.opaqueRemoved } : {}),
    })),
    consumers: analysis.consumers.map((c) => ({
      consumer: c.consumer,
      status: c.status,
      coverage: c.coverage,
      ...(c.coverageReason ? { coverageReason: c.coverageReason } : {}),
      uses: c.uses.map((u) => ({
        file: u.file,
        name: u.name,
        status: u.status,
        ...(u.reason ? { reason: u.reason } : {}),
        via: u.via,
        ...(u.through.length ? { through: u.through } : {}),
      })),
    })),
    skippedFiles: analysis.skippedFiles.length,
    sourceFiles: analysis.stats.sourceFiles,
    parsedImporters: analysis.stats.parsedImporters,
  };
}

function writeJsonl(path: string, records: unknown[]): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function machine() {
  return { node: process.version, platform: `${process.platform}-${process.arch}`, cpu: cpus()[0]?.model ?? 'unknown', cpus: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30) };
}

async function corpusA(repo: CorpusRepo, gitDir: string): Promise<void> {
  const set = await listTreeFiles(gitDir, repo.pin);
  const files = gitTreeFiles(gitDir, repo.pin, set);
  let generated;
  try {
    const started = performance.now();
    const oracle = new Oracle(files, { commonJs: repo.commonJs });
    process.stderr.write(`[${repo.id}] oracle program: ${oracle.rootFiles.length} root files\n`);
    let last = 0;
    generated = generateMutations(files, oracle, {
      prefix: repo.id,
      seed: SEED,
      positiveKinds: repo.positiveKinds,
      onProgress: (message) => {
        if (performance.now() - last > 5000) {
          last = performance.now();
          process.stderr.write(`[${repo.id}] ${message}\n`);
        }
      },
    });
    process.stderr.write(`[${repo.id}] generated ${generated.mutations.length} mutations in ${Math.round((performance.now() - started) / 1000)} s\n`);
  } finally {
    files.close();
  }
  const records = [];
  const reader = gitTreeFiles(gitDir, repo.pin, set);
  try {
    for (const mutation of generated.mutations) {
      const text = reader.read(mutation.file)!;
      const sha = commitMutation(gitDir, repo.pin, mutation.file, applyEdits(text, mutation.edits), mutation.id);
      const started = performance.now();
      const analysis = await analyzeSurfaceChange(gitDir, repo.pin, sha);
      const ms = Math.round(performance.now() - started);
      records.push(mutationRecord(repo, mutation, sha, analysis, ms));
      if (records.length % 20 === 0) process.stderr.write(`[${repo.id}] analyzed ${records.length}/${generated.mutations.length}\n`);
    }
  } finally {
    reader.close();
  }
  writeJsonl(join(DATA_DIR, 'corpus-a', `${repo.id}.jsonl`), records);
  writeFileSync(
    join(DATA_DIR, 'corpus-a', `${repo.id}.meta.json`),
    `${JSON.stringify({ repo: repo.id, url: repo.url, pin: repo.pin, seed: SEED, eligibleFiles: generated.eligibleFiles, candidatesSeen: generated.candidatesSeen, shortfalls: generated.shortfalls, machine: machine() }, null, 2)}\n`,
  );
}

function mutationRecord(repo: CorpusRepo, mutation: Mutation, sha: string, analysis: SurfaceAnalysis, ms: number) {
  return {
    id: mutation.id,
    repo: repo.id,
    class: mutation.class,
    kind: mutation.kind,
    file: mutation.file,
    name: mutation.name,
    sha,
    edits: mutation.edits,
    oracleConsumers: mutation.oracleConsumers,
    ms,
    analysis: summarize(analysis),
  };
}

interface PullRequest {
  id: string;
  base: string;
  merge: string;
  mergedAt: number;
  subject?: string;
}

function gutterStage0Prs(benchPath: string, gitDir: string): PullRequest[] {
  const bench = JSON.parse(readFileSync(benchPath, 'utf8')) as { prs: { id: string; base: string; mergeCommitSha: string }[] };
  return bench.prs.map((pr) => ({ id: pr.id, base: pr.base, merge: pr.mergeCommitSha, mergedAt: Number(git(gitDir, ['show', '-s', '--format=%ct', pr.mergeCommitSha]).trim()) }));
}

function squashSubjectPrs(gitDir: string, pin: string): PullRequest[] {
  const out = git(gitDir, ['log', '--first-parent', '--format=%H%x1f%P%x1f%ct%x1f%s', pin]);
  const prs: PullRequest[] = [];
  for (const line of out.split('\n')) {
    const [sha, parents, ct, subject] = line.split('\x1f');
    if (!sha || !subject) continue;
    const number = /\(#(\d+)\)$/.exec(subject)?.[1];
    if (!number) continue;
    prs.push({ id: `#${number}`, base: parents!.split(' ')[0]!, merge: sha, mergedAt: Number(ct), subject });
    if (prs.length === PRS_PER_REPO) break;
  }
  return prs;
}

async function corpusB(repo: CorpusRepo, gitDir: string, benchPath?: string): Promise<void> {
  if (!repo.corpusB) throw new Error(`${repo.id} is not in corpus B`);
  const prs = repo.corpusB.prs === 'gutter-stage0' ? gutterStage0Prs(benchPath ?? '', gitDir) : squashSubjectPrs(gitDir, repo.pin);
  const horizon = repo.corpusB.horizon;
  const horizonTime = Number(git(gitDir, ['show', '-s', '--format=%ct', horizon]).trim());
  const records = [];
  // Warm up TypeScript's module load once, so the first PR's time measures the analysis.
  await analyzeSurfaceChange(gitDir, prs[0]!.base, prs[0]!.base).catch(() => undefined);
  for (const pr of prs) {
    const record: Record<string, unknown> = { id: pr.id, repo: repo.id, base: pr.base, merge: pr.merge, mergedAt: pr.mergedAt };
    try {
      const started = performance.now();
      const analysis = await analyzeSurfaceChange(gitDir, pr.base, pr.merge);
      record.ms = Math.round(performance.now() - started);
      record.analysis = summarize(analysis);
      record.findings = await removedNameFindings(gitDir, pr, analysis, horizon, horizonTime);
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
    }
    records.push(record);
    if (records.length % 20 === 0) process.stderr.write(`[${repo.id}] analyzed ${records.length}/${prs.length} PRs\n`);
  }
  writeJsonl(join(DATA_DIR, 'corpus-b', `${repo.id}.jsonl`), records);
  writeFileSync(
    join(DATA_DIR, 'corpus-b', `${repo.id}.meta.json`),
    `${JSON.stringify({ repo: repo.id, url: repo.url, pin: repo.pin, horizon, prSource: repo.corpusB.prs, prs: prs.length, machine: machine() }, null, 2)}\n`,
  );
}

/** Every `uses-removed-name` use, with its three oracles (§4). */
async function removedNameFindings(gitDir: string, pr: PullRequest, analysis: SurfaceAnalysis, horizon: string, horizonTime: number) {
  const findings = [];
  const windowEnd = pr.mergedAt + FOLLOW_UP_DAYS * 86400;
  let mergeFiles: ReturnType<typeof gitTreeFiles> | undefined;
  try {
    for (const consumer of analysis.consumers) {
      for (const use of consumer.uses) {
        if (use.status !== 'uses-removed-name') continue;
        mergeFiles ??= gitTreeFiles(gitDir, pr.merge, await listTreeFiles(gitDir, pr.merge));
        const text = mergeFiles.read(consumer.consumer);
        const presentAtMerge = text !== undefined && new RegExp(`\\b${use.name === 'default' ? '' : use.name.replace(/[$]/g, '\\$')}`).test(text);
        const log = git(gitDir, ['log', '--first-parent', '--format=%H %ct', `${pr.merge}..${horizon}`, '--', consumer.consumer]).trim();
        const changes = log ? log.split('\n').map((l) => l.split(' ')).map(([sha, ct]) => ({ sha: sha!, ct: Number(ct) })) : [];
        const inWindow = changes.filter((c) => c.ct > pr.mergedAt && c.ct <= windowEnd).sort((a, b) => a.ct - b.ct);
        const followUp = inWindow.length > 0
          ? { status: 'followed', commit: inWindow[0]!.sha, hours: Math.round(((inWindow[0]!.ct - pr.mergedAt) / 3600) * 10) / 10 }
          : horizonTime < windowEnd ? { status: 'censored' } : { status: 'not-followed' };
        const typecheck = consumer.coverage === 'typechecked' && consumer.coverageReason
          ? typecheckConsumer(mergeFiles, consumer.coverageReason, consumer.consumer, use.name)
          : undefined;
        findings.push({
          consumer: consumer.consumer,
          file: use.file,
          name: use.name,
          via: use.via,
          through: use.through,
          coverage: consumer.coverage,
          coverageReason: consumer.coverageReason,
          presentAtMerge,
          followUp,
          ...(typecheck ? { typecheck } : {}),
        });
      }
    }
  } finally {
    mergeFiles?.close();
  }
  return findings;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { repo: { type: 'string' }, git: { type: 'string' }, 'gutter-bench': { type: 'string' } },
  });
  const [command] = positionals;
  const repo = CORPORA.find((r) => r.id === values.repo);
  if (!repo || !values.git || (command !== 'corpus-a' && command !== 'corpus-b')) {
    process.stderr.write('usage: run.ts corpus-a|corpus-b --repo <hono|eslint|vue-core> --git <bare clone> [--gutter-bench <bench.json>]\n');
    process.exit(2);
  }
  const gitDir = resolve(values.git);
  git(gitDir, ['cat-file', '-e', `${repo.pin}^{commit}`]);
  if (command === 'corpus-a') await corpusA(repo, gitDir);
  else await corpusB(repo, gitDir, values['gutter-bench']);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
