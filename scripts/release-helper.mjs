#!/usr/bin/env node
/**
 * Release helper (`scripts/release-helper.mjs`).
 *
 * Provides tested, deterministic release preparation and idempotent npm publication:
 * - Validates `v*.*.*` release tags (including prereleases such as `v0.4.0-rc.1`).
 * - Verifies `package.json` version matches the git tag.
 * - Extracts the matching `CHANGELOG.md` section, enforcing a real `YYYY-MM-DD` date
 *   (rejecting missing dates, `YYYY-MM-DD` placeholders, and empty sections).
 * - Computes local `.tgz` `sha512` integrity and `sha1` shasum digests and compares them
 *   against npm registry metadata before publishing so partial releases can be safely retried.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG_RE = /^v(\d+\.\d+\.\d+(?:-([0-9A-Za-z.-]+))?)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseReleaseTag(rawTag) {
  const trimmed = String(rawTag ?? '').trim();
  const match = TAG_RE.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid release tag "${trimmed}": expected semver tag matching "vX.Y.Z" or "vX.Y.Z-prerelease".`,
    );
  }
  const version = match[1];
  const prereleaseId = match[2] ?? null;
  const isPrerelease = prereleaseId !== null;
  return {
    tag: trimmed,
    version,
    prereleaseId,
    isPrerelease,
    npmDistTag: isPrerelease ? 'next' : 'latest',
  };
}

export function extractChangelogSection(changelogText, version) {
  const escapedVersion = String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingRe = new RegExp(`^## \\[${escapedVersion}\\](?:\\s+-\\s+(\\S+.*))?\\s*$`, 'm');
  const match = headingRe.exec(changelogText);
  if (!match) {
    throw new Error(`Could not find "## [${version}]" section in CHANGELOG.md.`);
  }
  const datePart = match[1] ? match[1].trim() : '';
  if (!datePart) {
    throw new Error(
      `CHANGELOG.md section for ${version} is missing a release date (expected "## [${version}] - YYYY-MM-DD").`,
    );
  }
  if (datePart === 'YYYY-MM-DD') {
    throw new Error(`CHANGELOG.md section for ${version} still has placeholder date YYYY-MM-DD.`);
  }
  if (!DATE_RE.test(datePart)) {
    throw new Error(
      `CHANGELOG.md section for ${version} has invalid release date "${datePart}" (expected YYYY-MM-DD).`,
    );
  }

  const afterHeading = changelogText.slice(match.index + match[0].length);
  const nextHeading = /^## \[/m.exec(afterHeading);
  const body = (nextHeading ? afterHeading.slice(0, nextHeading.index) : afterHeading).trim();
  if (!body) {
    throw new Error(`CHANGELOG.md section for ${version} is empty.`);
  }

  return {
    version,
    date: datePart,
    body,
  };
}

function appendGitHubOutputs(outputFile, entries) {
  if (!outputFile || outputFile.trim() === '') return;
  const lines = [];
  for (const [key, rawValue] of Object.entries(entries)) {
    const value = String(rawValue ?? '').replace(/[\r\n]+/g, ' ');
    const delim = `ghadelim_${randomBytes(12).toString('hex')}`;
    lines.push(`${key}<<${delim}`);
    lines.push(value);
    lines.push(delim);
  }
  appendFileSync(outputFile, `${lines.join('\n')}\n`, 'utf8');
}

export function prepareRelease({
  tag,
  pkgJsonPath = 'package.json',
  changelogPath = 'CHANGELOG.md',
  notesOutPath,
  githubOutputPath,
}) {
  const parsedTag = parseReleaseTag(tag);
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  const expectedTag = `v${pkg.version}`;
  if (parsedTag.tag !== expectedTag) {
    throw new Error(`Git tag "${parsedTag.tag}" does not match package.json version "${expectedTag}".`);
  }

  const changelogText = readFileSync(changelogPath, 'utf8');
  const section = extractChangelogSection(changelogText, pkg.version);

  if (notesOutPath) {
    mkdirSync(dirname(resolve(notesOutPath)), { recursive: true });
    writeFileSync(resolve(notesOutPath), `${section.body}\n`, 'utf8');
  }

  if (githubOutputPath) {
    appendGitHubOutputs(githubOutputPath, {
      tag: parsedTag.tag,
      version: parsedTag.version,
      is_prerelease: String(parsedTag.isPrerelease),
      npm_dist_tag: parsedTag.npmDistTag,
      release_date: section.date,
    });
  }

  return {
    ...parsedTag,
    packageName: pkg.name,
    date: section.date,
    body: section.body,
  };
}

export function computeTarballDigests(tarballPath) {
  const bytes = readFileSync(tarballPath);
  const shasum = createHash('sha1').update(bytes).digest('hex');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  return { shasum, integrity };
}

/**
 * Evaluates whether `packageName@version` is already published on npm and, if so,
 * verifies that the published registry tarball's `dist.integrity` and `dist.shasum`
 * match the local artifact digests before allowing publication to be skipped.
 */
export function evaluatePublishedArtifact({
  packageName,
  version,
  localDigests,
  registryDist,
}) {
  if (!registryDist || typeof registryDist !== 'object') {
    return { status: 'not-published' };
  }

  const remoteIntegrity =
    typeof registryDist.integrity === 'string' && registryDist.integrity.trim() !== ''
      ? registryDist.integrity.trim()
      : undefined;
  const remoteShasum =
    typeof registryDist.shasum === 'string' && registryDist.shasum.trim() !== ''
      ? registryDist.shasum.trim()
      : undefined;

  if (!remoteIntegrity && !remoteShasum) {
    throw new Error(
      `Package ${packageName}@${version} appears on npm without dist.integrity or dist.shasum metadata; refusing to skip publish blindly.`,
    );
  }

  const integrityMatches = !remoteIntegrity || remoteIntegrity === localDigests.integrity;
  const shasumMatches = !remoteShasum || remoteShasum === localDigests.shasum;

  if (!integrityMatches || !shasumMatches) {
    throw new Error(
      `Package ${packageName}@${version} is already published on npm with different artifact digests ` +
        `(local integrity=${localDigests.integrity}, shasum=${localDigests.shasum}; ` +
        `registry integrity=${remoteIntegrity ?? 'none'}, shasum=${remoteShasum ?? 'none'}).`,
    );
  }

  return {
    status: 'already-published-matching',
    integrity: localDigests.integrity,
    shasum: localDigests.shasum,
  };
}

export function resolveNpmCliJs(env = process.env) {
  if (env.npm_execpath && existsSync(env.npm_execpath)) {
    return resolve(env.npm_execpath);
  }
  const execDir = dirname(process.execPath);
  const candidates = [
    join(execDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(execDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const pathVar = env.PATH ?? env.Path ?? '';
  for (const dir of pathVar.split(delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    candidates.push(join(trimmed, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    candidates.push(join(trimmed, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && lstatSync(candidate).isFile()) {
        return realpathSync.native(candidate);
      }
    } catch {
      // continue searching
    }
  }
  return undefined;
}

function runNpmRaw(args, cwd = process.cwd()) {
  const npmCliJs = resolveNpmCliJs();
  return npmCliJs
    ? spawnSync(process.execPath, [npmCliJs, ...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        timeout: 120_000,
      });
}

export function queryRegistryDist(packageName, version) {
  const spec = `${packageName}@${version}`;
  const res = runNpmRaw(['view', spec, 'dist', '--json']);
  if (res.status !== 0) {
    const combined = `${res.stderr ?? ''}\n${res.stdout ?? ''}`;
    if (/E404|404 Not Found|is not in this registry|No match found for version/i.test(combined)) {
      return null;
    }
    throw new Error(`npm view ${spec} dist --json failed (exit ${res.status}):\n${combined.trim()}`);
  }
  const trimmed = (res.stdout ?? '').trim();
  if (!trimmed) {
    return null;
  }
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed;
}

export function publishOrSkip({
  tarballPath,
  packageName,
  version,
  distTag,
  provenance = true,
  dryRun = false,
  queryDistFn = queryRegistryDist,
  runPublishFn = runNpmRaw,
}) {
  const resolvedTarball = resolve(tarballPath);
  if (!existsSync(resolvedTarball)) {
    throw new Error(`Release tarball not found at ${resolvedTarball}`);
  }
  const localDigests = computeTarballDigests(resolvedTarball);
  const registryDist = queryDistFn(packageName, version);
  const check = evaluatePublishedArtifact({
    packageName,
    version,
    localDigests,
    registryDist,
  });

  if (check.status === 'already-published-matching') {
    console.log(
      `Skipping npm publish: ${packageName}@${version} is already published on npm with matching integrity (${check.integrity}).`,
    );
    return check;
  }

  const publishArgs = ['publish', resolvedTarball, '--access', 'public', '--tag', distTag];
  if (provenance) {
    publishArgs.push('--provenance');
  }
  if (dryRun) {
    publishArgs.push('--dry-run');
  }

  console.log(`Running npm ${publishArgs.join(' ')}...`);
  const res = runPublishFn(publishArgs);
  if (res.status !== 0) {
    throw new Error(
      `npm ${publishArgs.join(' ')} failed (exit ${res.status}):\n${(res.stderr || res.stdout || '').trim()}`,
    );
  }
  return {
    status: 'published',
    integrity: localDigests.integrity,
    shasum: localDigests.shasum,
  };
}

function parseCliArgs(argv) {
  const [subcommand, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--dry-run') {
      flags.dryRun = true;
    } else if (token === '--no-provenance') {
      flags.provenance = false;
    } else if (token.startsWith('--')) {
      const key = token.slice(2);
      const val = rest[i + 1];
      if (val === undefined || val.startsWith('--')) {
        throw new Error(`Missing value for flag ${token}`);
      }
      flags[key] = val;
      i++;
    }
  }
  return { subcommand, flags };
}

const isMain =
  process.argv[1] !== undefined &&
  (() => {
    try {
      return realpathSync.native(resolve(process.argv[1])) === realpathSync.native(fileURLToPath(import.meta.url));
    } catch {
      return false;
    }
  })();

if (isMain) {
  try {
    const { subcommand, flags } = parseCliArgs(process.argv.slice(2));
    if (subcommand === 'prepare') {
      if (!flags.tag) {
        throw new Error('Usage: release-helper.mjs prepare --tag <vX.Y.Z> [--notes-out <file>] [--github-output <file>]');
      }
      const result = prepareRelease({
        tag: flags.tag,
        pkgJsonPath: flags.pkg ?? 'package.json',
        changelogPath: flags.changelog ?? 'CHANGELOG.md',
        notesOutPath: flags['notes-out'],
        githubOutputPath: flags['github-output'],
      });
      console.log(
        `Prepared release ${result.tag} (npm dist-tag: ${result.npmDistTag}, prerelease: ${result.isPrerelease}, date: ${result.date}).`,
      );
    } else if (subcommand === 'publish-or-skip') {
      if (!flags.tarball || !flags.name || !flags.version || !flags['dist-tag']) {
        throw new Error(
          'Usage: release-helper.mjs publish-or-skip --tarball <path> --name <pkg> --version <ver> --dist-tag <tag>',
        );
      }
      publishOrSkip({
        tarballPath: flags.tarball,
        packageName: flags.name,
        version: flags.version,
        distTag: flags['dist-tag'],
        provenance: flags.provenance !== false,
        dryRun: Boolean(flags.dryRun),
      });
    } else {
      throw new Error(`Unknown subcommand "${subcommand ?? ''}". Expected "prepare" or "publish-or-skip".`);
    }
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
