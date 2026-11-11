#!/usr/bin/env node
/**
 * Install-size delta between two versions of repo-archaeology (RA-21: the cost of adding
 * `@frame12/terminal` as a runtime dependency).
 *
 *   node scripts/install-size.mjs --base <checkout of the old version> [--head <checkout>] [--json]
 *
 * For each checkout: `npm pack` (which builds it), then `npm install <tarball> --omit=dev` into an
 * empty temporary prefix, and measure the packed tarball, the installed `node_modules` (bytes on
 * disk, apparent size and file count) and the dependency list. `--head` defaults to this checkout.
 * Needs the npm registry for the dependencies.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeGitEnv } from './schema-validator.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function npm(args, cwd) {
  return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd,
    encoding: 'utf8',
    env: sanitizeGitEnv(process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Apparent bytes and file count of a directory tree (symlinks not followed). */
export function measureTree(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else {
        bytes += lstatSync(p).size;
        files += 1;
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

/** `name@version` of every package under a `node_modules` (including nested and scoped ones). */
export function installedPackages(nm) {
  const out = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      if (e.name.startsWith('@')) {
        visit(join(dir, e.name));
        continue;
      }
      const pkgDir = join(dir, e.name);
      try {
        const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
        out.push(`${pkg.name}@${pkg.version}`);
      } catch {
        // not a package
      }
      visit(join(pkgDir, 'node_modules'));
    }
  };
  visit(nm);
  return [...new Set(out)].sort();
}

function diskKb(dir) {
  // `du -sk` is what "size on disk" means to most readers (block-rounded); not on Windows.
  if (process.platform === 'win32') return undefined;
  return Number(execFileSync('du', ['-sk', dir], { encoding: 'utf8' }).split(/\s+/)[0]);
}

function measure(checkout, work) {
  const packDir = join(work, 'pack');
  const prefix = join(work, 'install');
  mkdirSync(packDir, { recursive: true });
  mkdirSync(prefix, { recursive: true });
  const [meta] = JSON.parse(npm(['pack', '--json', '--pack-destination', packDir], checkout));
  const tarball = join(packDir, meta.filename);
  writeFileSync(join(prefix, 'package.json'), '{"private":true}\n');
  npm(['install', '--prefix', prefix, tarball, '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], prefix);
  const nm = join(prefix, 'node_modules');
  const tree = measureTree(nm);
  const deps = installedPackages(nm).filter((d) => !d.startsWith('repo-archaeology@'));
  return {
    version: meta.version,
    tarballBytes: statSync(tarball).size,
    unpackedBytes: meta.unpackedSize,
    installBytes: tree.bytes,
    installFiles: tree.files,
    installDiskKb: diskKb(nm),
    dependencies: [...new Set(deps)].sort(),
  };
}

const kb = (n) => (n === undefined ? 'n/a' : `${(n / 1024).toFixed(1)} KB`);
const signed = (n, f) => (n === undefined ? 'n/a' : `${n >= 0 ? '+' : '-'}${f(Math.abs(n))}`);

function main() {
  const base = arg('--base');
  if (!base) {
    console.error('usage: node scripts/install-size.mjs --base <old checkout> [--head <checkout>] [--json]');
    process.exit(2);
  }
  const head = arg('--head') ?? ROOT;
  const work = mkdtempSync(join(tmpdir(), 'ra-install-size-'));
  try {
    const before = measure(resolve(base), join(work, 'base'));
    const after = measure(resolve(head), join(work, 'head'));
    const delta = {
      tarballBytes: after.tarballBytes - before.tarballBytes,
      installBytes: after.installBytes - before.installBytes,
      installFiles: after.installFiles - before.installFiles,
      installDiskKb: before.installDiskKb === undefined ? undefined : after.installDiskKb - before.installDiskKb,
      addedDependencies: after.dependencies.filter((d) => !before.dependencies.includes(d)),
      removedDependencies: before.dependencies.filter((d) => !after.dependencies.includes(d)),
    };
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ before, after, delta }, null, 2));
      return;
    }
    console.log('| | before | after | delta |');
    console.log('| --- | --- | --- | --- |');
    console.log(`| version | ${before.version} | ${after.version} | |`);
    console.log(`| packed tarball | ${kb(before.tarballBytes)} | ${kb(after.tarballBytes)} | ${signed(delta.tarballBytes, kb)} |`);
    console.log(`| installed node_modules (apparent) | ${kb(before.installBytes)} | ${kb(after.installBytes)} | ${signed(delta.installBytes, kb)} |`);
    console.log(`| installed node_modules (on disk) | ${before.installDiskKb ?? 'n/a'} KB | ${after.installDiskKb ?? 'n/a'} KB | ${signed(delta.installDiskKb, (n) => `${n} KB`)} |`);
    console.log(`| installed files | ${before.installFiles} | ${after.installFiles} | ${signed(delta.installFiles, String)} |`);
    console.log(`| added packages | | | ${delta.addedDependencies.join(', ') || 'none'} |`);
    console.log(`| removed packages | | | ${delta.removedDependencies.join(', ') || 'none'} |`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
