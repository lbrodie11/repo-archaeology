import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openRepository, ConfigError, type OpenOptions, type Repository } from '../src/api/index.js';
import { renderDiffMarkdown } from '../src/report/markdown.js';
import {
  CodeownersMatcher,
  inferGitHubLoginFromEmail,
  parseCodeownersText,
  sanitizeContributorName,
  renderNonMentioningHandle,
} from '../src/model/owners.js';
import { sanitizeGitEnv } from '../scripts/schema-validator.mjs';
import { FixtureRepo } from './helpers.js';

const ROOT_DIR = join(import.meta.dirname, '..');
const CLI = join(ROOT_DIR, 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');

function runCli(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, ['--import', TSX, CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: sanitizeGitEnv(process.env, { NO_COLOR: '1', ...extraEnv }),
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function runDiff(cwd: string, options: Omit<OpenOptions, 'cwd'> & NonNullable<Parameters<Repository['diff']>[0]> = {}) {
  const repo = await openRepository({ cwd, ...options });
  try {
    return await repo.diff(options);
  } finally {
    await repo.close();
  }
}

async function runFile(cwd: string, path: string, options: Omit<OpenOptions, 'cwd'> = {}) {
  const repo = await openRepository({ cwd, ...options });
  try {
    return await repo.file(path);
  } finally {
    await repo.close();
  }
}

describe('RA-12: Historical contributor context (.mailmap, owners, ownersSample) and CODEOWNERS', () => {
  it('1 & 2. merges identities across gitmailmap(5) forms 1-4 for owners while preserving raw commit.author and origin', async () => {
    const repo = new FixtureRepo();
    try {
      // Form 1: Proper Name <commit@email.xx>
      // Form 2: <proper@email.xx> <commit@email.xx>
      // Form 3: Proper Name <proper@email.xx> <commit@email.xx>
      // Form 4: Proper Name <proper@email.xx> Commit Name <commit@email.xx>
      repo.write(
        '.mailmap',
        [
          '# Mailmap forms 1-4',
          'Alice Canonical <alice.form1@corp.example.com>',
          '<alice@canonical.example.com> <alice.form1@corp.example.com>',
          'Alice Canonical <alice@canonical.example.com> <alice.old@legacy.example.com>',
          'Alice Canonical <alice@canonical.example.com> A. Legacy <shared-team@legacy.example.com>',
          'Bob Canonical <bob@canonical.example.com> Bob Other <shared-team@legacy.example.com>',
        ].join('\n') + '\n',
      );
      repo.git('add', '.mailmap');
      repo.commit({ message: 'chore: add mailmap', author: 'Setup', email: 'setup@example.com', day: 1 });

      // 4 commits by Alice under 3 different raw identities (forms 1+2, form 3, form 4)
      repo.commit({
        message: 'feat: sync a and b (form 1+2)',
        author: 'alice-raw-1',
        email: 'alice.form1@corp.example.com',
        day: 2,
        write: { 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n' },
      });
      repo.commit({
        message: 'feat: sync a and b (form 3)',
        author: 'alice-raw-2',
        email: 'alice.old@legacy.example.com',
        day: 3,
        write: { 'src/a.ts': 'export const a = 2;\n', 'src/b.ts': 'export const b = 2;\n' },
      });
      repo.commit({
        message: 'feat: sync a and b (form 4 alice)',
        author: 'A. Legacy',
        email: 'shared-team@legacy.example.com',
        day: 4,
        write: { 'src/a.ts': 'export const a = 3;\n', 'src/b.ts': 'export const b = 3;\n' },
      });
      // Form 4 with same commit email (shared-team@legacy.example.com) but different commit name (Bob Other)
      repo.commit({
        message: 'feat: sync a and b (form 4 bob)',
        author: 'Bob Other',
        email: 'shared-team@legacy.example.com',
        day: 5,
        write: { 'src/a.ts': 'export const a = 4;\n', 'src/b.ts': 'export const b = 4;\n' },
      });

      // Modify src/a.ts in working tree
      repo.write('src/a.ts', 'export const a = 999;\n');

      const report = await runDiff(repo.dir, { owners: true });
      assert.equal(report.suggestions.length, 1);
      const sugg = report.suggestions[0]!;
      assert.equal(sugg.to, 'src/b.ts');

      // Owners aggregates Alice's 3 commits into one canonical entry, and Bob's 1 commit separately
      assert.deepEqual(sugg.owners, [
        { name: 'Alice Canonical', commits: 3, lastDate: '2024-01-05' },
        { name: 'Bob Canonical', commits: 1, lastDate: '2024-01-06' },
      ]);
      assert.equal(sugg.ownersSample?.qualifyingCommits, 4);

      // Existing raw evidence[].author and file command authors remain raw (unchanged by .mailmap)
      const evidenceAuthors = sugg.evidence.map((e) => e.author);
      assert.ok(
        evidenceAuthors.includes('Bob Other') && evidenceAuthors.includes('A. Legacy'),
        `expected raw author names in evidence, got: ${JSON.stringify(evidenceAuthors)}`,
      );

      const fReport = await runFile(repo.dir, 'src/b.ts');
      const fileAuthorNames = fReport.authors.map((a) => a.author);
      assert.ok(fileAuthorNames.includes('alice-raw-1'));
      assert.ok(fileAuthorNames.includes('alice-raw-2'));
      assert.ok(!fileAuthorNames.includes('Alice Canonical'));

      // Warm RA-04 history cache + working-tree .mailmap update reflects new canonical identity without cache misses
      repo.write(
        '.mailmap',
        [
          'Alice Warm Cache <alice@canonical.example.com> <alice.form1@corp.example.com>',
          'Alice Warm Cache <alice@canonical.example.com> <alice.old@legacy.example.com>',
          'Alice Warm Cache <alice@canonical.example.com> A. Legacy <shared-team@legacy.example.com>',
          'Bob Canonical <bob@canonical.example.com> Bob Other <shared-team@legacy.example.com>',
        ].join('\n') + '\n',
      );
      const warmReport = await runDiff(repo.dir, { owners: true });
      assert.equal(warmReport.meta.cache?.enabled, true);
      assert.ok((warmReport.meta.cache?.hits ?? 0) > 0);
      assert.equal(warmReport.meta.cache?.misses, 0);
      assert.deepEqual(warmReport.suggestions[0]!.owners, [
        { name: 'Alice Warm Cache', commits: 3, lastDate: '2024-01-05' },
        { name: 'Bob Canonical', commits: 1, lastDate: '2024-01-06' },
      ]);
    } finally {
      repo.cleanup();
    }
  });

  it('3. uses revision-isolated .mailmap for --head and --base without leaking a newer working-tree .mailmap', async () => {
    const repo = new FixtureRepo();
    try {
      for (let i = 1; i <= 3; i++) {
        repo.commit({
          message: `feat: pair change ${i}`,
          author: 'Original Name',
          email: 'dev@example.com',
          day: i,
          write: {
            'src/a.ts': `export const a = ${i};\n`,
            'src/b.ts': `export const b = ${i};\n`,
          },
        });
      }
      repo.git('branch', 'base-branch');
      repo.commit({
        message: 'feat: modify a on feature commit',
        author: 'Original Name',
        email: 'dev@example.com',
        day: 4,
        write: { 'src/a.ts': 'export const a = 100;\n' },
      });
      const featureSha = repo.git('rev-parse', 'HEAD').trim();

      // Now add a .mailmap ONLY in a newer commit + working tree that renames Original Name -> Future Alias
      repo.commit({
        message: 'chore: add future mailmap',
        author: 'Admin',
        email: 'admin@example.com',
        day: 5,
        write: {
          '.mailmap': 'Future Alias <future@example.com> <dev@example.com>\n',
        },
      });
      repo.write('.mailmap', 'Worktree Uncommitted Alias <wt@example.com> <dev@example.com>\n');

      // Analyzing --head <featureSha> --base base-branch must NOT see Future Alias or Worktree Uncommitted Alias
      const historicalReport = await runDiff(repo.dir, {
        head: featureSha,
        base: 'base-branch',
        owners: true,
      });
      assert.equal(historicalReport.suggestions.length, 1);
      assert.deepEqual(historicalReport.suggestions[0]!.owners, [
        { name: 'Original Name', commits: 3, lastDate: '2024-01-04' },
      ]);
    } finally {
      repo.cleanup();
    }
  });

  it('4 & 5. excludes bots and non-human coding agents from owners while including human-authored agent-assisted commits', async () => {
    const repo = new FixtureRepo();
    try {
      // 2 pure human commits by Alice
      for (let i = 1; i <= 2; i++) {
        repo.commit({
          message: `feat: human change ${i}`,
          author: 'Alice Dev',
          email: 'alice@example.com',
          day: i,
          write: { 'src/a.ts': `export const a = ${i};\n`, 'src/b.ts': `export const b = ${i};\n` },
        });
      }
      // 1 human-authored, agent-assisted commit by Alice (via Co-authored-by trailer)
      repo.commit({
        message: 'feat: agent-assisted change\n\nCo-authored-by: Claude <noreply@anthropic.com>',
        author: 'Alice Dev',
        email: 'alice@example.com',
        day: 3,
        write: { 'src/a.ts': 'export const a = 3;\n', 'src/b.ts': 'export const b = 3;\n' },
      });
      // 2 bot commits
      repo.commit({
        message: 'chore(deps): dependabot update',
        author: 'dependabot[bot]',
        email: '49699333+dependabot[bot]@users.noreply.github.com',
        day: 4,
        write: { 'src/a.ts': 'export const a = 4;\n', 'src/b.ts': 'export const b = 4;\n' },
      });
      // 1 non-human coding agent commit (authored directly by Devin AI)
      repo.commit({
        message: 'feat: autonomous agent commit',
        author: 'Devin AI',
        email: 'devin-ai-integration[bot]@users.noreply.github.com',
        day: 5,
        write: { 'src/a.ts': 'export const a = 5;\n', 'src/b.ts': 'export const b = 5;\n' },
      });
      // 1 commit where .mailmap attempts to map a bot email to a human-looking name (must still be excluded because raw author is non-human)
      repo.write('.mailmap', 'Mapped Bot <mapped@example.com> <renovate[bot]@users.noreply.github.com>\n');
      repo.git('add', '.mailmap');
      repo.commit({
        message: 'chore: renovate bump',
        author: 'renovate[bot]',
        email: 'renovate[bot]@users.noreply.github.com',
        day: 6,
        write: { 'src/a.ts': 'export const a = 6;\n', 'src/b.ts': 'export const b = 6;\n' },
      });

      repo.write('src/a.ts', 'export const a = 999;\n');

      const report = await runDiff(repo.dir, { owners: true });
      const sugg = report.suggestions.find((s) => s.to === 'src/b.ts');
      assert.ok(sugg);
      assert.deepEqual(sugg.owners, [
        { name: 'Alice Dev', commits: 3, lastDate: '2024-01-04' },
      ]);
      assert.equal(sugg.ownersSample?.qualifyingCommits, 3);
      assert.equal(sugg.ownersSample?.agentAssistedCommits, 1);
      assert.equal(sugg.ownersSample?.excludedNonHumanCommits, 3);
    } finally {
      repo.cleanup();
    }
  });

  it('6. never merges distinct contributors who share the same display name but have different emails', async () => {
    const repo = new FixtureRepo();
    try {
      for (let i = 1; i <= 2; i++) {
        repo.commit({
          message: `feat: alex 1 commit ${i}`,
          author: 'Alex Kim',
          email: 'alex.one@team-a.example.com',
          day: i,
          write: { 'src/a.ts': `export const a = ${i};\n`, 'src/b.ts': `export const b = ${i};\n` },
        });
      }
      for (let i = 1; i <= 2; i++) {
        repo.commit({
          message: `feat: alex 2 commit ${i}`,
          author: 'Alex Kim',
          email: 'alex.two@team-b.example.com',
          day: 2 + i,
          write: { 'src/a.ts': `export const a = ${10 + i};\n`, 'src/b.ts': `export const b = ${10 + i};\n` },
        });
      }

      repo.write('src/a.ts', 'export const a = 999;\n');
      const report = await runDiff(repo.dir, { owners: true });
      const sugg = report.suggestions[0]!;
      assert.equal(sugg.owners?.length, 2, 'two distinct emails with the same display name must stay separate');
      assert.equal(sugg.owners?.[0]?.name, 'Alex Kim');
      assert.equal(sugg.owners?.[0]?.commits, 2);
      assert.equal(sugg.owners?.[1]?.name, 'Alex Kim');
      assert.equal(sugg.owners?.[1]?.commits, 2);
    } finally {
      repo.cleanup();
    }
  });

  it('7. strictly infers GitHub login from noreply emails, falls back to raw noreply when mailmapped, and drops conflicting or ambiguous logins', async () => {
    // Unit checks on inferGitHubLoginFromEmail
    assert.equal(inferGitHubLoginFromEmail('123456+octocat@users.noreply.github.com'), 'octocat');
    assert.equal(inferGitHubLoginFromEmail('Octo-Cat@users.noreply.github.com'), 'Octo-Cat');
    assert.equal(inferGitHubLoginFromEmail('octocat@github.com'), undefined);
    assert.equal(inferGitHubLoginFromEmail('octocat@company.com'), undefined);
    assert.equal(inferGitHubLoginFromEmail('-bad@users.noreply.github.com'), undefined);
    assert.equal(inferGitHubLoginFromEmail('bad--name@users.noreply.github.com'), undefined);
    assert.equal(inferGitHubLoginFromEmail('dependabot[bot]@users.noreply.github.com'), undefined);
    assert.equal(inferGitHubLoginFromEmail('ghost@users.noreply.github.com'), undefined);

    const repo = new FixtureRepo();
    try {
      // Contributor 1: mailmapped to corporate email, raw commit has 12345+alice-gh@users.noreply.github.com -> login: 'alice-gh'
      // Contributor 2: has two DIFFERENT noreply logins mapped to same canonical email -> ambiguous, login omitted
      repo.write(
        '.mailmap',
        [
          'Alice Smith <alice@corp.example.com> <12345+alice-gh@users.noreply.github.com>',
          'Bob Ambiguous <bob@corp.example.com> <111+bob-one@users.noreply.github.com>',
          'Bob Ambiguous <bob@corp.example.com> <222+bob-two@users.noreply.github.com>',
        ].join('\n') + '\n',
      );
      repo.git('add', '.mailmap');
      repo.commit({ message: 'chore: mailmap', author: 'Setup', email: 'setup@example.com', day: 1 });

      for (let i = 1; i <= 2; i++) {
        repo.commit({
          message: `feat: alice ${i}`,
          author: 'Alice Smith',
          email: '12345+alice-gh@users.noreply.github.com',
          day: 1 + i,
          write: { 'src/a.ts': `export const a = ${i};\n`, 'src/b.ts': `export const b = ${i};\n` },
        });
      }
      repo.commit({
        message: 'feat: bob login 1',
        author: 'Bob Ambiguous',
        email: '111+bob-one@users.noreply.github.com',
        day: 4,
        write: { 'src/a.ts': 'export const a = 4;\n', 'src/b.ts': 'export const b = 4;\n' },
      });
      repo.commit({
        message: 'feat: bob login 2',
        author: 'Bob Ambiguous',
        email: '222+bob-two@users.noreply.github.com',
        day: 5,
        write: { 'src/a.ts': 'export const a = 5;\n', 'src/b.ts': 'export const b = 5;\n' },
      });

      repo.write('src/a.ts', 'export const a = 999;\n');
      const report = await runDiff(repo.dir, { owners: true });
      const sugg = report.suggestions[0]!;
      const alice = sugg.owners?.find((o) => o.name === 'Alice Smith');
      const bob = sugg.owners?.find((o) => o.name === 'Bob Ambiguous');
      assert.equal(alice?.login, 'alice-gh');
      assert.equal(bob?.login, undefined, 'conflicting noreply logins for the same contributor must omit login');
    } finally {
      repo.cleanup();
    }
  });

  it('8 & 9. never leaks email addresses and sanitizes author names and CODEOWNERS handles against @mention / HTML / bidi injection', async () => {
    assert.equal(sanitizeContributorName('alice@secret-domain.example.com'), undefined);
    assert.equal(sanitizeContributorName('Alice <alice@secret-domain.example.com>'), 'Alice');
    assert.equal(sanitizeContributorName('@octocat <script>alert(1)</script>\u202E'), 'octocat');
    assert.equal(renderNonMentioningHandle('@org/team-a'), '@\u200Borg/team-a');

    const repo = new FixtureRepo();
    try {
      repo.write('.github/CODEOWNERS', 'src/* @org/core-team @octocat dev-notify@secret-corp.example.com\n');
      repo.git('add', '.github/CODEOWNERS');
      repo.commit({ message: 'chore: add codeowners', author: 'Setup', email: 'setup@example.com', day: 1 });

      // Commit with an email-only author name and non-noreply email -> omitted rather than leaking an email
      repo.commit({
        message: 'feat: email-as-name commit',
        author: 'only-email@private-domain.example.com',
        email: 'only-email@private-domain.example.com',
        day: 2,
        write: { 'src/a.ts': 'export const a = 0;\n', 'src/b.ts': 'export const b = 0;\n' },
      });

      for (let i = 1; i <= 3; i++) {
        repo.commit({
          message: `feat: pair update ${i}`,
          // Author name intentionally contains an email address, @mention, and bidi control char
          author: 'leak@private-email.example.com @octo \u202E',
          email: `999+octo@users.noreply.github.com`,
          day: 2 + i,
          write: { 'src/a.ts': `export const a = ${i};\n`, 'src/b.ts': `export const b = ${i};\n` },
        });
      }

      repo.write('src/a.ts', 'export const a = 999;\n');
      const report = await runDiff(repo.dir, { owners: true });
      const sugg = report.suggestions[0]!;

      // 1. JSON contract check: no email addresses anywhere in owners, ownersSample, or codeowners
      const serializedOwnership = JSON.stringify({
        owners: sugg.owners,
        ownersSample: sugg.ownersSample,
        codeowners: sugg.codeowners,
      });
      assert.doesNotMatch(serializedOwnership, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      assert.deepEqual(sugg.codeowners, ['@org/core-team', '@octocat']);

      // 2. Markdown rendering check: no active @mentions (/@[A-Za-z0-9]/) and no raw HTML tags
      const md = renderDiffMarkdown(report);
      assert.doesNotMatch(md, /@[A-Za-z0-9]/, 'Markdown output must never contain an active @mention without zero-width break');
      assert.doesNotMatch(md, /<img|<script/i);
      assert.match(md, /Designated code owners.*@\u200Borg\/core-team/);
      assert.match(md, /People who may have context/);
      assert.match(md, /Historical activity suggests familiarity, not current ownership or availability\./);

      // 3. Terminal output check: no active @mentions and no forbidden phrasing
      const cliRes = runCli(['diff', '--owners'], repo.dir);
      assert.equal(cliRes.code, 0, cliRes.stderr);
      assert.doesNotMatch(cliRes.stdout, /@[A-Za-z0-9]/);
      for (const forbidden of ['responsible for', 'assigned owner', 'forgotten by', 'best reviewer']) {
        assert.equal(cliRes.stdout.toLowerCase().includes(forbidden), false);
        assert.equal(md.toLowerCase().includes(forbidden), false);
      }
    } finally {
      repo.cleanup();
    }
  });

  it('10, 11 & 12. enforces CODEOWNERS precedence, last-valid-match semantics, case-sensitivity, email skipping, and unsupported pattern warnings', async () => {
    // Unit test for pattern compilation, last-match wins, email-only rule, and unsupported pattern warnings
    const parsed = parseCodeownersText(
      [
        '# Global fallback',
        '* @global-owner',
        '/src/ @src-dir-owner',
        '/src/**/*.ts @ts-owner @org/ts-team',
        'docs/*.md docs-team@example.com',
        'docs/mixed.md @docs-handle docs-team@example.com',
        '!src/negated.ts @never',
        'src/[a-z].ts @bracket',
        'src/{a,b}.ts @brace',
        'src/valid-plus+name.ts @plus-owner',
        'src/CaseFile.ts @case-upper',
      ].join('\n'),
      '.github/CODEOWNERS',
      'worktree',
    );
    const matcher = new CodeownersMatcher(parsed);
    assert.deepEqual(matcher.match('README.md'), ['@global-owner']);
    assert.deepEqual(matcher.match('src/sub/file.ts'), ['@ts-owner', '@org/ts-team']);
    assert.deepEqual(matcher.match('src/sub/file.js'), ['@src-dir-owner']);
    // docs/*.md only had an email owner, which overrides * @global-owner and is skipped for privacy
    assert.deepEqual(matcher.match('docs/guide.md'), []);
    assert.deepEqual(matcher.match('docs/mixed.md'), ['@docs-handle']);
    // Escaped metacharacter `+` in path works cleanly
    assert.deepEqual(matcher.match('src/valid-plus+name.ts'), ['@plus-owner']);
    // Case-sensitive matching
    assert.deepEqual(matcher.match('src/CaseFile.ts'), ['@case-upper']);
    assert.deepEqual(matcher.match('src/casefile.ts'), ['@ts-owner', '@org/ts-team']);
    // Warnings emitted for `!`, `[...]`, `{...}`
    assert.equal(parsed.warnings.length, 3);
    assert.ok(parsed.warnings.some((w) => w.includes('negation')));
    assert.ok(parsed.warnings.some((w) => w.includes('character range')));
    assert.ok(parsed.warnings.some((w) => w.includes('brace expansion')));

    // Precedence test: .github/CODEOWNERS > CODEOWNERS > docs/CODEOWNERS
    const repo = new FixtureRepo();
    try {
      repo.write('.github/CODEOWNERS', '* @from-dot-github\n!unsupported @ignored\n');
      repo.write('CODEOWNERS', '* @from-root\n');
      repo.write('docs/CODEOWNERS', '* @from-docs\n');
      repo.git('add', '.');
      for (let i = 1; i <= 3; i++) {
        repo.commit({
          message: `feat: pair ${i}`,
          author: 'Alice',
          day: i,
          write: { 'src/a.ts': `export const a = ${i};\n`, 'src/b.ts': `export const b = ${i};\n` },
        });
      }
      repo.write('src/a.ts', 'export const a = 999;\n');

      const report = await runDiff(repo.dir, { owners: true });
      assert.deepEqual(report.suggestions[0]!.codeowners, ['@from-dot-github']);
      assert.equal(report.suggestions[0]!.ownersSample?.codeownersFile, '.github/CODEOWNERS');
      assert.equal(report.suggestions[0]!.ownersSample?.codeownersSource, 'worktree');
      assert.ok(report.meta.warnings?.some((w) => w.includes('.github/CODEOWNERS line 2')));

      // Oversized >= 3 MiB CODEOWNERS file is skipped with a warning in meta.warnings without crashing
      repo.write('.github/CODEOWNERS', `* @from-dot-github\n#${'x'.repeat(3 * 1024 * 1024)}\n`);
      const hugeReport = await runDiff(repo.dir, { owners: true });
      assert.equal(hugeReport.suggestions[0]!.codeowners, undefined);
      assert.ok(hugeReport.meta.warnings?.some((w) => w.includes('file is 3 MB or larger')));
    } finally {
      repo.cleanup();
    }
  });

  it('13. enforces lookbackDays relative to reference commitTime, deterministic ordering, single-commit wording, and OwnersConfig validation', async () => {
    const repo = new FixtureRepo();
    try {
      // Old contributor (400 days before tip) -> outside default 365-day lookback
      for (let i = 1; i <= 3; i++) {
        repo.commit({
          message: `feat: ancient commit ${i}`,
          author: 'Ancient Contributor',
          email: 'ancient@example.com',
          day: i,
          write: { 'src/a.ts': `export const a = ${i};\n`, 'src/b.ts': `export const b = ${i};\n` },
        });
      }
      // Recent commit at day 500 (so day 1..3 are ~497 days earlier > 365 lookbackDays)
      repo.commit({
        message: 'feat: recent single commit',
        author: 'Recent Contributor',
        email: 'recent@example.com',
        day: 500,
        write: { 'src/a.ts': 'export const a = 500;\n', 'src/b.ts': 'export const b = 500;\n' },
      });

      repo.write('src/a.ts', 'export const a = 999;\n');

      const report = await runDiff(repo.dir, { owners: true });
      const sugg = report.suggestions[0]!;
      assert.deepEqual(sugg.owners, [
        { name: 'Recent Contributor', commits: 1, lastDate: '2025-05-15' },
      ]);
      assert.equal(sugg.ownersSample?.qualifyingCommits, 1);

      // Single-commit limited-sample wording in Markdown and CLI
      const md = renderDiffMarkdown(report);
      assert.match(md, /limited sample: 1 qualifying recent change/);
      const cliRes = runCli(['diff', '--owners'], repo.dir);
      assert.match(cliRes.stdout, /limited sample: 1 qualifying recent change/);

      // Config validation rejects owners.max > 5 or lookbackDays > 3650
      await assert.rejects(
        () => openRepository({ cwd: repo.dir, settings: { owners: { max: 10 } } }),
        (err: unknown) =>
          err instanceof ConfigError && /"owners\.max" must be an integer between 1 and 5/.test(err.message),
      );
      await assert.rejects(
        () => openRepository({ cwd: repo.dir, settings: { owners: { lookbackDays: 0 } } }),
        (err: unknown) =>
          err instanceof ConfigError && /"owners\.lookbackDays" must be an integer between 1 and 3650/.test(err.message),
      );
    } finally {
      repo.cleanup();
    }
  });

  it('14 & 15. follows file renames for contributor attribution and sets incompleteCoverage on truncated history', async () => {
    const repo = new FixtureRepo();
    try {
      const baseLines = 'export const header1 = 1;\nexport const header2 = 2;\nexport const header3 = 3;\n';
      // 1 earliest commit so maxCommits: 4 truncates history
      repo.commit({
        message: 'chore: initial seed',
        author: 'Seed Author',
        email: 'seed@example.com',
        day: 1,
        write: { 'README.md': '# Repo\n' },
      });
      // 3 commits touching src/a.ts and src/old-name.ts by Rename Expert
      for (let i = 1; i <= 3; i++) {
        repo.commit({
          message: `feat: pre-rename ${i}`,
          author: 'Rename Expert',
          email: 'expert@example.com',
          day: 1 + i,
          write: {
            'src/a.ts': `${baseLines}export const a = ${i};\n`,
            'src/old-name.ts': `${baseLines}export const b = ${i};\n`,
          },
        });
      }
      // Rename src/old-name.ts -> src/new-name.ts (preserving similarity for git -M) and touch src/a.ts
      repo.commit({
        message: 'refactor: rename old-name to new-name',
        author: 'Rename Expert',
        email: 'expert@example.com',
        day: 5,
        move: [['src/old-name.ts', 'src/new-name.ts']],
        write: {
          'src/a.ts': `${baseLines}export const a = 4;\n`,
        },
      });

      repo.write('src/a.ts', `${baseLines}export const a = 999;\n`);

      // Run with maxCommits: 4 so history is truncated (repo has 5 commits -> incompleteCoverage: true)
      const report = await runDiff(repo.dir, { settings: { maxCommits: 4 }, owners: true });
      const sugg = report.suggestions.find((s) => s.to === 'src/new-name.ts');
      assert.ok(sugg, 'expected suggestion for renamed file src/new-name.ts');
      assert.deepEqual(sugg.owners, [
        { name: 'Rename Expert', commits: 4, lastDate: '2024-01-06' },
      ]);
      assert.equal(sugg.ownersSample?.incompleteCoverage, true);

      const md = renderDiffMarkdown(report);
      assert.match(md, /incomplete history coverage/);
    } finally {
      repo.cleanup();
    }
  });

  it('16 & 17. supports --owners / --no-owners, reads CODEOWNERS from base on diff --base, and leaves disabled mode unchanged', async () => {
    const repo = new FixtureRepo();
    try {
      repo.write('.github/CODEOWNERS', '* @base-owner\n');
      repo.git('add', '.github/CODEOWNERS');
      for (let i = 1; i <= 3; i++) {
        repo.commit({
          message: `feat: sync a and b ${i}`,
          author: 'Base Dev',
          email: 'basedev@example.com',
          day: i,
          write: { 'src/a.ts': `export const a = ${i};\n`, 'src/b.ts': `export const b = ${i};\n` },
        });
      }
      repo.git('branch', 'base-ref');

      // On feature branch, change .github/CODEOWNERS to @feature-owner and touch src/a.ts
      repo.commit({
        message: 'feat: update codeowners and a.ts on feature branch',
        author: 'Feature Dev',
        email: 'featdev@example.com',
        day: 4,
        write: {
          '.github/CODEOWNERS': '* @feature-owner\n',
          'src/a.ts': 'export const a = 100;\n',
        },
      });

      // 1. Default (disabled) mode: no owners, ownersSample, or codeowners fields
      const disabledReport = await runDiff(repo.dir, { base: 'base-ref' });
      assert.equal(disabledReport.suggestions.length, 1);
      assert.equal(disabledReport.suggestions[0]!.owners, undefined);
      assert.equal(disabledReport.suggestions[0]!.ownersSample, undefined);
      assert.equal(disabledReport.suggestions[0]!.codeowners, undefined);

      // 2. diff --base with owners: true reads CODEOWNERS from merge-base (@base-owner, source: 'base')
      const baseReport = await runDiff(repo.dir, { base: 'base-ref', owners: true });
      assert.equal(baseReport.suggestions.length, 1);
      assert.deepEqual(baseReport.suggestions[0]!.codeowners, ['@base-owner']);
      assert.equal(baseReport.suggestions[0]!.ownersSample?.codeownersSource, 'base');
      assert.equal(baseReport.suggestions[0]!.ownersSample?.codeownersFile, '.github/CODEOWNERS');

      // 3. When .repo-archaeology.json enables owners by default, --no-owners and repo.diff({ owners: false }) disable it
      repo.write('.repo-archaeology.json', JSON.stringify({ owners: { enabled: true, max: 2 } }));
      const configEnabledRes = runCli(['diff', '--base', 'base-ref', '--json'], repo.dir);
      assert.equal(configEnabledRes.code, 0, configEnabledRes.stderr);
      const configEnabledJson = JSON.parse(configEnabledRes.stdout);
      assert.ok(Array.isArray(configEnabledJson.suggestions[0].owners));

      const cliNoOwnersRes = runCli(['diff', '--base', 'base-ref', '--no-owners', '--json'], repo.dir);
      assert.equal(cliNoOwnersRes.code, 0, cliNoOwnersRes.stderr);
      const cliNoOwnersJson = JSON.parse(cliNoOwnersRes.stdout);
      assert.equal(cliNoOwnersJson.suggestions[0].owners, undefined);
      assert.equal(cliNoOwnersJson.suggestions[0].ownersSample, undefined);
      assert.equal(cliNoOwnersJson.suggestions[0].codeowners, undefined);

      // Library API repo.diff({ owners: true / false })
      const session = await openRepository({ cwd: repo.dir, base: 'base-ref' });
      try {
        const apiEnabled = await session.diff({ owners: true });
        assert.ok(Array.isArray(apiEnabled.suggestions[0]?.owners));
        const apiDisabled = await session.diff({ owners: false });
        assert.equal(apiDisabled.suggestions[0]?.owners, undefined);
      } finally {
        await session.close();
      }
    } finally {
      repo.cleanup();
    }
  });
});
