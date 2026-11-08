import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  computeTarballDigests,
  evaluatePublishedArtifact,
  extractChangelogSection,
  parseReleaseTag,
  prepareRelease,
  publishOrSkip,
} from '../scripts/release-helper.mjs';
import { sanitizeGitEnv } from '../scripts/schema-validator.mjs';
import { assertPackedFileList } from '../scripts/smoke-pack.mjs';
import { FixtureRepo } from './helpers.js';

const ROOT_DIR = join(import.meta.dirname, '..');

describe('Release preparation, prerelease tags, partial-release recovery, and git hook isolation', () => {
  it('parses stable and prerelease tags and selects the matching npm dist-tag', () => {
    const stable = parseReleaseTag('v0.3.0');
    assert.deepEqual(stable, {
      tag: 'v0.3.0',
      version: '0.3.0',
      prereleaseId: null,
      isPrerelease: false,
      npmDistTag: 'latest',
    });

    const prerelease = parseReleaseTag('v0.4.0-rc.1');
    assert.deepEqual(prerelease, {
      tag: 'v0.4.0-rc.1',
      version: '0.4.0-rc.1',
      prereleaseId: 'rc.1',
      isPrerelease: true,
      npmDistTag: 'next',
    });

    assert.throws(() => parseReleaseTag('0.3.0'), /Invalid release tag/);
    assert.throws(() => parseReleaseTag('v0.3'), /Invalid release tag/);
  });

  it('validates CHANGELOG.md sections: missing section, missing date, YYYY-MM-DD placeholder, empty body, and valid release notes', () => {
    const sampleChangelog = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '### Added',
      '- Work in progress.',
      '',
      '## [0.4.0-rc.1] - 2026-11-15',
      '',
      '### Added',
      '- Release candidate feature.',
      '',
      '## [0.3.1] - YYYY-MM-DD',
      '',
      '### Fixed',
      '- Pending date.',
      '',
      '## [0.3.0]',
      '',
      '### Added',
      '- Missing date suffix.',
      '',
      '## [0.2.9] - 2026-10-01',
      '',
      '## [0.2.8] - 2026-09-20',
      '',
      '### Added',
      '- Valid section.',
    ].join('\n');

    // 1. Valid prerelease section
    const rcSection = extractChangelogSection(sampleChangelog, '0.4.0-rc.1');
    assert.equal(rcSection.date, '2026-11-15');
    assert.match(rcSection.body, /Release candidate feature/);

    // 2. Missing section
    assert.throws(
      () => extractChangelogSection(sampleChangelog, '9.9.9'),
      /Could not find "## \[9\.9\.9\]" section in CHANGELOG\.md/,
    );

    // 3. Placeholder date YYYY-MM-DD
    assert.throws(
      () => extractChangelogSection(sampleChangelog, '0.3.1'),
      /still has placeholder date YYYY-MM-DD/,
    );

    // 4. Missing `- YYYY-MM-DD` date suffix
    assert.throws(
      () => extractChangelogSection(sampleChangelog, '0.3.0'),
      /is missing a release date \(expected "## \[0\.3\.0\] - YYYY-MM-DD"\)/,
    );

    // 5. Empty section body
    assert.throws(
      () => extractChangelogSection(sampleChangelog, '0.2.9'),
      /CHANGELOG\.md section for 0\.2\.9 is empty/,
    );
  });

  it('prepareRelease enforces tag/package.json parity and writes release notes + GITHUB_OUTPUT metadata', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'repo-arch-release-test-'));
    try {
      const pkgPath = join(tmpDir, 'package.json');
      const changelogPath = join(tmpDir, 'CHANGELOG.md');
      const notesPath = join(tmpDir, 'notes.md');
      const outputPath = join(tmpDir, 'github_output.txt');

      writeFileSync(pkgPath, JSON.stringify({ name: 'repo-archaeology', version: '0.4.0-beta.2' }), 'utf8');
      writeFileSync(
        changelogPath,
        '# Changelog\n\n## [0.4.0-beta.2] - 2026-11-20\n\n### Added\n- Beta release notes.\n',
        'utf8',
      );
      writeFileSync(outputPath, '', 'utf8');

      // Version mismatch between tag and package.json
      assert.throws(
        () =>
          prepareRelease({
            tag: 'v0.4.0-beta.1',
            pkgJsonPath: pkgPath,
            changelogPath,
          }),
        /Git tag "v0\.4\.0-beta\.1" does not match package\.json version "v0\.4\.0-beta\.2"/,
      );

      // Matching prerelease tag
      const prepared = prepareRelease({
        tag: 'v0.4.0-beta.2',
        pkgJsonPath: pkgPath,
        changelogPath,
        notesOutPath: notesPath,
        githubOutputPath: outputPath,
      });
      assert.equal(prepared.isPrerelease, true);
      assert.equal(prepared.npmDistTag, 'next');
      assert.equal(readFileSync(notesPath, 'utf8'), '### Added\n- Beta release notes.\n');
      const ghOutput = readFileSync(outputPath, 'utf8');
      assert.match(ghOutput, /is_prerelease<<ghadelim_[0-9a-f]+\ntrue\n/);
      assert.match(ghOutput, /npm_dist_tag<<ghadelim_[0-9a-f]+\nnext\n/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('recovers safely from partial releases by verifying tarball integrity & shasum before skipping npm publish', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'repo-arch-digest-test-'));
    try {
      const tarballPath = join(tmpDir, 'repo-archaeology-0.3.0.tgz');
      writeFileSync(tarballPath, 'synthetic-tarball-bytes-for-digest-test', 'utf8');
      const localDigests = computeTarballDigests(tarballPath);

      // Case 1: Not yet published on npm -> proceed with publish
      const unpublished = evaluatePublishedArtifact({
        packageName: 'repo-archaeology',
        version: '0.3.0',
        localDigests,
        registryDist: null,
      });
      assert.deepEqual(unpublished, { status: 'not-published' });

      // Case 2: Already published on npm with identical sha512 integrity and sha1 shasum -> skip publish on retry
      const matching = evaluatePublishedArtifact({
        packageName: 'repo-archaeology',
        version: '0.3.0',
        localDigests,
        registryDist: {
          integrity: localDigests.integrity,
          shasum: localDigests.shasum,
        },
      });
      assert.deepEqual(matching, {
        status: 'already-published-matching',
        integrity: localDigests.integrity,
        shasum: localDigests.shasum,
      });

      // Case 3: Already published on npm with DIFFERENT artifact integrity -> fail loudly
      assert.throws(
        () =>
          evaluatePublishedArtifact({
            packageName: 'repo-archaeology',
            version: '0.3.0',
            localDigests,
            registryDist: {
              integrity: 'sha512-differentArtifactDigest==',
              shasum: localDigests.shasum,
            },
          }),
        /already published on npm with different artifact digests/,
      );

      // Case 4: Registry returned dist object with no digests -> refuse to blindly skip
      assert.throws(
        () =>
          evaluatePublishedArtifact({
            packageName: 'repo-archaeology',
            version: '0.3.0',
            localDigests,
            registryDist: {},
          }),
        /without dist\.integrity or dist\.shasum metadata/,
      );

      // Case 5: Full publishOrSkip two-attempt retry simulation (attempt 1 publishes; attempt 2 skips npm publish)
      let registryState: { integrity: string; shasum: string } | null = null;
      const publishCalls: string[][] = [];

      const firstAttempt = publishOrSkip({
        tarballPath,
        packageName: 'repo-archaeology',
        version: '0.4.0-rc.1',
        distTag: 'next',
        queryDistFn: () => registryState,
        runPublishFn: (args) => {
          publishCalls.push(args);
          registryState = { ...localDigests };
          return { status: 0, stdout: '+ repo-archaeology@0.4.0-rc.1', stderr: '' };
        },
      });
      assert.equal(firstAttempt.status, 'published');
      assert.equal(publishCalls.length, 1);
      assert.deepEqual(publishCalls[0], [
        'publish',
        tarballPath,
        '--access',
        'public',
        '--tag',
        'next',
        '--provenance',
      ]);

      // Attempt 2 (retry after downstream GitHub Release failure): skips npm publish because digests match
      const retryAttempt = publishOrSkip({
        tarballPath,
        packageName: 'repo-archaeology',
        version: '0.4.0-rc.1',
        distTag: 'next',
        queryDistFn: () => registryState,
        runPublishFn: (args) => {
          publishCalls.push(args);
          return { status: 1, stderr: 'E403 cannot publish over existing version' };
        },
      });
      assert.equal(retryAttempt.status, 'already-published-matching');
      assert.equal(publishCalls.length, 1, 'retry must not invoke npm publish a second time when digests match');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('validates packed tarball file allowlist and rejects unexpected src/ or test/ files', () => {
    assertPackedFileList([
      { path: 'package.json' },
      { path: 'README.md' },
      { path: 'LICENSE' },
      { path: 'dist/cli.js' },
      { path: 'schema/diff.schema.json' },
      { path: 'schema/backtest.schema.json' },
    ]);

    assert.throws(
      () =>
        assertPackedFileList([
          { path: 'package.json' },
          { path: 'README.md' },
          { path: 'LICENSE' },
          { path: 'dist/cli.js' },
          { path: 'schema/diff.schema.json' },
          { path: 'schema/backtest.schema.json' },
          { path: 'src/cli.ts' },
        ]),
      /Tarball contains unexpected files.*src\/cli\.ts/,
    );
  });

  it('strips GIT_DIR, GIT_WORK_TREE, and GIT_INDEX_FILE so git hooks cannot write into an outer repository', () => {
    const outerRepo = new FixtureRepo();
    try {
      outerRepo.write('outer.txt', 'untouched\n');
      outerRepo.git('add', 'outer.txt');
      outerRepo.commit({ message: 'outer initial', author: 'OuterAuthor' });
      const outerHeadBefore = outerRepo.git('rev-parse', 'HEAD').trim();
      const outerBranchBefore = outerRepo.git('rev-parse', '--abbrev-ref', 'HEAD').trim();
      const outerUserBefore = outerRepo.git('config', 'user.name').trim();

      const origGitDir = process.env.GIT_DIR;
      const origWorkTree = process.env.GIT_WORK_TREE;
      const origIndexFile = process.env.GIT_INDEX_FILE;
      process.env.GIT_DIR = join(outerRepo.dir, '.git');
      process.env.GIT_WORK_TREE = outerRepo.dir;
      process.env.GIT_INDEX_FILE = join(outerRepo.dir, '.git', 'index');

      let innerRepo: FixtureRepo | undefined;
      try {
        const cleaned = sanitizeGitEnv(process.env);
        assert.equal(cleaned.GIT_DIR, undefined);
        assert.equal(cleaned.GIT_WORK_TREE, undefined);
        assert.equal(cleaned.GIT_INDEX_FILE, undefined);

        innerRepo = new FixtureRepo();
        innerRepo.git('config', 'user.name', 'InnerHookTester');
        innerRepo.git('checkout', '-q', '-b', 'feat/inner-branch');
        innerRepo.write('inner.ts', 'export const inner = 1;\n');
        innerRepo.git('add', 'inner.ts');
        innerRepo.commit({ message: 'inner commit', author: 'InnerHookTester' });
      } finally {
        if (origGitDir === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = origGitDir;
        if (origWorkTree === undefined) delete process.env.GIT_WORK_TREE;
        else process.env.GIT_WORK_TREE = origWorkTree;
        if (origIndexFile === undefined) delete process.env.GIT_INDEX_FILE;
        else process.env.GIT_INDEX_FILE = origIndexFile;
        innerRepo?.cleanup();
      }

      const outerHeadAfter = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: outerRepo.dir,
        encoding: 'utf8',
        env: sanitizeGitEnv(process.env),
      }).trim();
      const outerBranchAfter = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: outerRepo.dir,
        encoding: 'utf8',
        env: sanitizeGitEnv(process.env),
      }).trim();
      const outerUserAfter = execFileSync('git', ['config', 'user.name'], {
        cwd: outerRepo.dir,
        encoding: 'utf8',
        env: sanitizeGitEnv(process.env),
      }).trim();

      assert.equal(outerHeadAfter, outerHeadBefore, 'outer repository HEAD must not be modified when GIT_DIR is set');
      assert.equal(outerBranchAfter, outerBranchBefore, 'outer repository branch must not be modified when GIT_DIR is set');
      assert.equal(outerUserAfter, outerUserBefore, 'outer repository user.name must not be modified when GIT_DIR is set');
    } finally {
      outerRepo.cleanup();
    }
  });

  it('keeps release.yml, action-smoke.yml, and ci.yml aligned with single-entry-point SHA-pinned jobs', () => {
    assert.equal(
      existsSync(join(ROOT_DIR, '.github', 'workflows', 'publish.yml')),
      false,
      'legacy publish.yml must be removed so release.yml is the single publishing entry point',
    );
    const releaseYml = readFileSync(join(ROOT_DIR, '.github', 'workflows', 'release.yml'), 'utf8');
    const smokeYml = readFileSync(join(ROOT_DIR, '.github', 'workflows', 'action-smoke.yml'), 'utf8');

    assert.match(releaseYml, /^name:\s*Release\s*$/m);
    assert.match(smokeYml, /workflows:\s*\['Release'\]/);

    const usesLines = releaseYml
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('uses:') || l.startsWith('- uses:'));
    assert.ok(usesLines.length >= 4, 'expected SHA-pinned uses: lines in release.yml');
    for (const line of usesLines) {
      assert.match(
        line,
        /@[0-9a-f]{40}\s+#\s*v\d+/,
        `Every third-party action in release.yml must be pinned to a 40-char commit SHA with a version comment: ${line}`,
      );
    }
  });
});
