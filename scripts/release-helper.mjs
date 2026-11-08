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
const SEMVER_CORE_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Compares two X.Y.Z(-prerelease) version strings according to SemVer precedence.
 * Returns -1 if a < b, 0 if a === b, and 1 if a > b.
 */
export function compareSemver(a, b) {
  const ma = SEMVER_CORE_RE.exec(String(a ?? '').trim());
  const mb = SEMVER_CORE_RE.exec(String(b ?? '').trim());
  if (!ma || !mb) {
    throw new Error(`Invalid semver comparison inputs: "${a}" vs "${b}"`);
  }
  for (let i = 1; i <= 3; i++) {
    const na = Number(ma[i]);
    const nb = Number(mb[i]);
    if (na !== nb) return na < nb ? -1 : 1;
  }
  const preA = ma[4];
  const preB = mb[4];
  if (!preA && !preB) return 0;
  // A normal version has higher precedence than a pre-release version (1.0.0 > 1.0.0-alpha)
  if (!preA && preB) return 1;
  if (preA && !preB) return -1;
  const partsA = preA.split('.');
  const partsB = preB.split('.');
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const idA = partsA[i];
    const idB = partsB[i];
    if (idA === undefined) return -1;
    if (idB === undefined) return 1;
    if (idA === idB) continue;
    const isNumA = /^\d+$/.test(idA);
    const isNumB = /^\d+$/.test(idB);
    if (isNumA && isNumB) {
      return Number(idA) < Number(idB) ? -1 : 1;
    }
    if (isNumA !== isNumB) {
      return isNumA ? -1 : 1;
    }
    return idA < idB ? -1 : 1;
  }
  return 0;
}

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

export function queryRegistryLatestVersion(packageName) {
  const res = runNpmRaw(['view', packageName, 'dist-tags.latest', '--json']);
  if (res.status !== 0) {
    const combined = `${res.stderr ?? ''}\n${res.stdout ?? ''}`;
    if (/E404|404 Not Found|is not in this registry/i.test(combined)) {
      return null;
    }
    throw new Error(`npm view ${packageName} dist-tags.latest --json failed (exit ${res.status}):\n${combined.trim()}`);
  }
  const trimmed = (res.stdout ?? '').trim();
  if (!trimmed) return null;
  const parsed = JSON.parse(trimmed);
  return typeof parsed === 'string' && parsed.trim() !== '' ? parsed.trim() : null;
}

export function publishOrSkip({
  tarballPath,
  packageName,
  version,
  distTag,
  provenance = true,
  dryRun = false,
  queryDistFn = queryRegistryDist,
  queryLatestFn = queryRegistryLatestVersion,
  runPublishFn = runNpmRaw,
}) {
  const resolvedTarball = resolve(tarballPath);
  if (!existsSync(resolvedTarball)) {
    throw new Error(`Release tarball not found at ${resolvedTarball}`);
  }
  const parsedTag = parseReleaseTag(version.startsWith('v') ? version : `v${version}`);
  const effectiveDistTag = distTag ?? parsedTag.npmDistTag;
  if ( parsedTag.isPrerelease && (!effectiveDistTag || effectiveDistTag === 'latest')) {
    throw new Error(
      `Prerelease version ${packageName}@${parsedTag.version} must use a non-latest dist-tag (such as 'next').`,
    );
  }

  const localDigests = computeTarballDigests(resolvedTarball);
  const registryDist = queryDistFn(packageName, parsedTag.version);
  const check = evaluatePublishedArtifact({
    packageName,
    version: parsedTag.version,
    localDigests,
    registryDist,
  });

  if (check.status === 'already-published-matching') {
    console.log(
      `Skipping npm publish: ${packageName}@${parsedTag.version} is already published on npm with matching integrity (${check.integrity}).`,
    );
    return check;
  }

  // Guard against downgrading `latest` when publishing an older stable maintenance version:
  // 1. Check registry `dist-tags.latest` explicitly so we fail early with a clear message.
  // 2. Omit `--tag latest` from `npm publish` arguments so npm 11's built-in downgrade protection remains active.
  if (!parsedTag.isPrerelease && (!effectiveDistTag || effectiveDistTag === 'latest')) {
    const currentLatest = queryLatestFn(packageName);
    if (currentLatest && compareSemver(parsedTag.version, currentLatest) < 0) {
      throw new Error(
        `Refusing to publish stable version ${packageName}@${parsedTag.version} as 'latest' because a newer version (${currentLatest}) is already tagged 'latest' on npm.`,
      );
    }
  }

  const publishArgs = ['publish', resolvedTarball, '--access', 'public'];
  if (effectiveDistTag && effectiveDistTag !== 'latest') {
    publishArgs.push('--tag', effectiveDistTag);
  }
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
