import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diff, type DiffResult } from '../src/commands/diff.js';
import { explain } from '../src/commands/explain.js';
import { loadContext } from '../src/context.js';
import {
  escapeMarkdownInline,
  FEEDBACK_ISSUE_URL,
  formatMarkdownCode,
  renderDiffMarkdown,
} from '../src/report/markdown.js';
import { FixtureRepo } from './helpers.js';

function createBaseDiffResult(overrides: Partial<DiffResult> = {}): DiffResult {
  return {
    meta: {
      tool: 'repo-archaeology',
      root: '/workspace/repo',
      commitsRead: 120,
      commitsAnalyzed: 115,
      sweepsSkipped: 4,
      subjectSkipped: 1,
      renamesFollowed: 2,
      files: 40,
      oldestCommit: '2025-01-01',
      newestCommit: '2026-10-15',
      settings: {
        maxCommits: 5000,
        maxFilesPerCommit: 25,
        minShared: 3,
        minConfidence: 0.4,
        ignore: [],
        useDefaultIgnores: true,
      },
      warnings: [],
    },
    base: 'main',
    evaluation: {
      targetBranchRef: 'main',
      headSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      mergeBaseSha: '00112233445566778899aabbccddeeff00112233',
      baselineSha: '00112233445566778899aabbccddeeff00112233',
      commitsAnalyzed: 115,
      effectiveOptions: {
        minShared: 3,
        minConfidence: 0.4,
        maxCommits: 5000,
        maxFilesPerCommit: 25,
      },
    },
    changed: [
      {
        path: 'src/adapter/bun/serve-static.ts',
        deleted: false,
        added: false,
        sources: ['branch'],
        historyPath: 'src/adapter/bun/serve-static.ts',
        hasHistory: true,
      },
    ],
    suggestions: [
      {
        from: 'src/adapter/bun/serve-static.ts',
        to: 'src/adapter/deno/serve-static.ts',
        relationship: 'ghost',
        why: 'possible parallel implementations: serve-static.ts appears in sibling folders',
        hiddenBridge: {
          signal: 'parallel-implementation',
          value: 'serve-static.ts',
          filesUsing: 3,
        },
        shared: 12,
        fromChanges: 20,
        toChanges: 18,
        confidence: 0.6,
        reverseConfidence: 0.667,
        interval: { low: 0.3865, high: 0.7812 },
        reverseInterval: { low: 0.4374, high: 0.8373 },
        score: 0.387,
        weighted: false,
        lastTogether: '2026-05-16',
        crossesDirectories: true,
        evidence: [
          {
            hash: '26f8c33000000000000000000000000000000000',
            date: '2026-05-16',
            author: 'Alice',
            subject: 'fix(serveStatic): make options parameter optional in all adapters',
          },
          {
            hash: '1196f14000000000000000000000000000000000',
            date: '2025-08-07',
            author: 'Bob',
            subject: 'feat(serve-static): use join to correct path resolution',
          },
          {
            hash: '246a06a000000000000000000000000000000000',
            date: '2024-09-24',
            author: 'Carol',
            subject: 'feat(serve-static): support absolute root',
          },
          {
            hash: '9999999000000000000000000000000000000000',
            date: '2024-01-10',
            author: 'Dan',
            subject: 'fourth commit that should be capped at 3 in summary',
          },
        ],
        alsoLinkedFrom: ['src/adapter/cloudflare/serve-static.ts'],
      },
    ],
    families: [
      {
        id: 'src/adapter/*/serve-static',
        label: 'serve-static.ts across src/adapter/*',
        stem: 'serve-static',
        fileName: 'serve-static.ts',
        parentDir: 'src/adapter',
        why: '3 parallel implementations of serve-static.ts in sibling folders',
        members: [
          { path: 'src/adapter/bun/serve-static.ts', dir: 'src/adapter/bun', variant: 'bun', changes: 20, connections: 2 },
          { path: 'src/adapter/cloudflare/serve-static.ts', dir: 'src/adapter/cloudflare', variant: 'cloudflare', changes: 19, connections: 2 },
          { path: 'src/adapter/deno/serve-static.ts', dir: 'src/adapter/deno', variant: 'deno', changes: 18, connections: 2 },
        ],
        commitsTouchingTwoOrMore: 16,
        commitsTouchingAll: 9,
        lastTogether: '2026-05-16',
        qualifyingPairs: 3,
        possiblePairs: 3,
        complete: true,
        relationshipKinds: ['ghost'],
        peakScore: 0.387,
        maxPairShared: 12,
        evidence: [],
        allMemberEvidence: [],
        relationships: [],
        changedMembers: ['src/adapter/bun/serve-static.ts'],
        suggestedMembers: ['src/adapter/deno/serve-static.ts', 'src/adapter/cloudflare/serve-static.ts'],
      },
    ],
    ...overrides,
  };
}

describe('Markdown PR summary renderer (src/report/markdown.ts)', () => {
  it('renders suggestions, finding families, 3-commit evidence cap, explain command, and feedback link', () => {
    const md = renderDiffMarkdown(createBaseDiffResult());

    assert.match(md, /^## Repo Archaeology/m);
    assert.match(md, /prompts for review, not proof of a bug/);
    assert.match(md, /Evaluated \*\*1 changed file\*\* against base `main` \(merge-base `0011223` → `a1b2c3d`\)/);
    assert.match(md, /### Finding families \(1\)/);
    assert.match(md, /`src\/adapter\/cloudflare\/serve-static\.ts` _\(beyond --limit\)_/);
    assert.match(md, /### Possibly missed \(1\)/);
    assert.match(md, /1\. \*\*`src\/adapter\/deno\/serve-static\.ts`\*\* — `ghost wire`/);
    assert.match(
      md,
      /Changed with `src\/adapter\/bun\/serve-static\.ts` in \*\*12 of 20 commits \(60%\)\*\* \(95% CI 38–79%\) · reverse \*\*66%\*\* \(12\/18\) · last together 2026-05-16 \(also linked to `src\/adapter\/cloudflare\/serve-static\.ts`\)/,
    );
    assert.match(md, /`26f8c33` \(2026-05-16\)/);
    assert.match(md, /`1196f14` \(2025-08-07\)/);
    assert.match(md, /`246a06a` \(2024-09-24\)/);
    assert.doesNotMatch(md, /9999999/, 'must cap supporting commit evidence at 3 commits per suggestion');
    assert.match(
      md,
      /Verify: `npx repo-archaeology explain --base 00112233445566778899aabbccddeeff00112233 src\/adapter\/bun\/serve-static\.ts src\/adapter\/deno\/serve-static\.ts`/,
    );
    assert.ok(md.includes(FEEDBACK_ISSUE_URL));

    // When a changed file was renamed on the branch, Verify uses the current filename and full baseline SHA
    const renamedMd = renderDiffMarkdown(
      createBaseDiffResult({
        changed: [
          {
            path: 'src/adapter/bun/static-handler.ts',
            oldPath: 'src/adapter/bun/serve-static.ts',
            deleted: false,
            added: false,
            sources: ['branch'],
            historyPath: 'src/adapter/bun/serve-static.ts',
            hasHistory: true,
          },
        ],
        suggestions: [
          {
            ...createBaseDiffResult().suggestions[0]!,
            from: 'src/adapter/bun/static-handler.ts',
          },
        ],
      }),
    );
    assert.match(
      renamedMd,
      /Verify: `npx repo-archaeology explain --base 00112233445566778899aabbccddeeff00112233 src\/adapter\/bun\/static-handler\.ts src\/adapter\/deno\/serve-static\.ts`/,
    );
  });

  it('explicitly labels recency-weighted percentages while keeping raw commit counts when weighted=true', () => {
    const base = createBaseDiffResult();
    base.meta.settings.halfLifeDays = 90;
    base.suggestions[0]!.weighted = true;
    base.suggestions[0]!.confidence = 0.72;
    base.suggestions[0]!.reverseConfidence = 0.55;

    const md = renderDiffMarkdown(base);
    assert.match(md, /recency half-life 90d/);
    assert.match(
      md,
      /Changed with `src\/adapter\/bun\/serve-static\.ts` in \*\*12 of 20 commits\*\* \(raw 95% CI 38–79%\) \(\*\*72%\*\* recency-weighted · reverse \*\*55%\*\* recency-weighted across 12\/18 raw commits\)/,
    );
  });

  it('renders honest empty/silence states for every primaryReason without claiming the change is safe', () => {
    const reasons = [
      'no_changed_files',
      'limited_repo_history',
      'no_history_for_changed_files',
      'all_companions_touched',
      'no_cochange_partners',
      'filtered_by_thresholds',
      'filtered_by_kinds',
    ] as const;

    for (const reason of reasons) {
      const md = renderDiffMarkdown(
        createBaseDiffResult({
          suggestions: [],
          families: [],
          silence: {
            primaryReason: reason,
            reasons: [reason],
            changedFiles: reason === 'no_changed_files' ? 0 : 1,
            changedWithHistory: reason === 'no_history_for_changed_files' ? 0 : 1,
            changedInsufficientHistory: 0,
            rawCompanions: 2,
            qualifyingCompanions: 0,
            touchedCompanions: 1,
            filteredByThreshold: 1,
            filteredByKind: 0,
            deletedCompanions: 0,
            shallowHistory: reason === 'limited_repo_history',
            limitedHistory: reason === 'limited_repo_history',
            commitsAnalyzed: 115,
            details: [`Detail for ${reason}`],
          },
        }),
      );
      assert.match(md, /### No companion suggestions/);
      assert.ok(md.includes(escapeMarkdownInline(`Detail for ${reason}`)));
      assert.match(md, /not that this change is guaranteed free of omissions/);
      assert.doesNotMatch(md, /\bsafe to merge\b|\bno bugs\b/i);
      assert.ok(!md.includes(FEEDBACK_ISSUE_URL), 'feedback footer should be omitted when there are 0 suggestions');
    }
  });

  it('escapes hostile commit subjects, paths, HTML tags, @mentions, #123 autolinks, and bidi controls', () => {
    const hostileSubject =
      '<script>alert(1)</script> <!-- comment --> [click](https://evil.example) @octocat @org/team #123 GH-456 | `code` \n\r\u202e';
    const escaped = escapeMarkdownInline(hostileSubject, 300);

    assert.doesNotMatch(escaped, /<script>|<!--/);
    assert.match(escaped, /&lt;script&gt;alert\\\(1\\\)&lt;\/script&gt;/);
    assert.doesNotMatch(escaped, /@octocat|@org\/team/);
    assert.ok(escaped.includes('@\u200Boctocat'));
    assert.ok(escaped.includes('@\u200Borg/team'));
    assert.doesNotMatch(escaped, /#123/);
    assert.ok(escaped.includes('#\u200B123'));
    assert.doesNotMatch(escaped, /GH-456/);
    assert.ok(escaped.includes('GH-\u200B456'));
    assert.match(escaped, /https&#58;\/\/evil\.example/);
    assert.doesNotMatch(escaped, /[\n\r\u202e]/);
    assert.match(escaped, /\\\\n\\\\r\\\\u202e/);

    const codeSpan = formatMarkdownCode('src/weird`file|name<test>\n.ts');
    assert.equal(codeSpan, '``src/weird`file|name<test>\\n.ts``');
    assert.equal(formatMarkdownCode('`leading-and-trailing`'), '`` `leading-and-trailing` ``');
    assert.ok(!codeSpan.includes('\u200B'), 'code spans must never contain zero-width spaces');
  });

  it('preserves exact shell quoting in Verify commands without executing filename-controlled syntax or truncating long paths', () => {
    const probePath = 'src/a`$(printf INJECTED)`b|c<d>/one.ts';
    const longPartner = `packages/${'deeply-nested-monorepo-module/'.repeat(12)}partner.ts`;
    const base = createBaseDiffResult();
    base.meta.settings.halfLifeDays = 90;
    base.meta.settings.since = '2025-01-01';
    base.meta.settings.maxCommits = 250;
    base.suggestions[0]!.from = probePath;
    base.suggestions[0]!.to = longPartner;

    const md = renderDiffMarkdown(base, {
      repoUrl: 'https://github.com/lbrodie11/repo-archaeology',
    });

    // Path characters (` | < >) must be preserved literally inside multi-backtick code span
    assert.ok(md.includes('``src/a`$(printf INJECTED)`b|c<d>/one.ts``'));

    // Extract the Verify command from its multi-backtick code span
    const verifyMatch = /Verify: (`+)\s*(npx repo-archaeology explain [^\n]+?)\s*\1/.exec(md);
    assert.ok(verifyMatch, `expected Verify code span in:\n${md}`);
    const verifyCmd = verifyMatch[2]!;

    // Must preserve the single-quoted literal backtick and never replace it with an apostrophe
    assert.ok(
      verifyCmd.includes(`'${probePath}'`),
      `Verify command must preserve literal single-quoted path, got: ${verifyCmd}`,
    );
    assert.ok(verifyCmd.includes(longPartner), 'Verify command must not truncate paths > 300 characters');

    // Must preserve effective analysis settings (--since, --max-commits, --half-life) and contain zero U+200B
    assert.match(verifyCmd, /--base 00112233445566778899aabbccddeeff00112233/);
    assert.match(verifyCmd, /--since 2025-01-01/);
    assert.match(verifyCmd, /--max-commits 250/);
    assert.match(verifyCmd, /--half-life 90/);
    assert.ok(!verifyCmd.includes('\u200B'), 'Verify command must never contain U+200B zero-width spaces');

    // Commit SHAs must link when repoUrl is provided
    assert.match(
      md,
      /\[`26f8c33`\]\(https:\/\/github\.com\/lbrodie11\/repo-archaeology\/commit\/26f8c33000000000000000000000000000000000\)/,
    );
  });

  it('reproduces diff --base statistics via Verify command, resolves reused renamed paths, and preserves import classification', async () => {
    const repo = new FixtureRepo();
    try {
      // 1. Create and delete `src/reused.ts` and `src/fresh-reused.ts` in early history (unrelated to `src/partner.ts`)
      repo.write('src/reused.ts', 'export const oldReused = 1;\n');
      repo.write('src/fresh-reused.ts', 'export const oldFresh = 1;\n');
      repo.write('src/other.ts', 'export const other = 1;\n');
      repo.git('add', '.');
      repo.commit({ message: 'early unrelated files' });
      repo.commit({
        message: 'remove old reused files',
        write: {
          'src/reused.ts': null,
          'src/fresh-reused.ts': null,
          'src/other.ts': 'export const other = 2;\n',
        },
      });

      // 2. Co-change `src/original.ts` (which directly imports `src/partner.ts`) and `src/partner.ts` 4 times on main
      for (let i = 1; i <= 4; i++) {
        repo.commit({
          message: `sync original and partner (${i})`,
          write: {
            'src/original.ts': `import { partner } from './partner';\nexport const orig = partner + ${i};\n`,
            'src/partner.ts': `export const partner = ${i};\n`,
          },
        });
      }
      const baseSha = repo.git('rev-parse', 'HEAD').trim();

      // 3. On a feature branch, rename `src/original.ts` -> `src/reused.ts` (touching only `reused.ts`, so HEAD has 4/5 while baseline has 4/4)
      //    and add a brand-new `src/fresh-reused.ts`
      repo.git('checkout', '-q', '-b', 'feature-reused-rename');
      repo.commit({
        message: 'refactor: rename original.ts to reused.ts and add fresh-reused.ts',
        move: [['src/original.ts', 'src/reused.ts']],
        write: {
          'src/reused.ts': "import { partner } from './partner';\nexport const orig = partner + 99;\n",
          'src/fresh-reused.ts': 'export const brandNew = true;\n',
        },
      });

      const ctx = await loadContext(repo.dir, {}, { base: 'main' });
      const diffRes = await diff(ctx, {
        base: 'main',
        limit: 10,
        kinds: ['ghost', 'unknown', 'indirect', 'direct', 'test'],
      });

      assert.equal(diffRes.suggestions.length, 1);
      const sug = diffRes.suggestions[0]!;
      assert.equal(sug.from, 'src/reused.ts');
      assert.equal(sug.to, 'src/partner.ts');
      assert.equal(sug.shared, 4);
      assert.equal(sug.fromChanges, 4);
      assert.equal(sug.relationship, 'direct');

      // Render Markdown and verify the generated Verify command uses full 40-char SHA and current filename
      const md = renderDiffMarkdown(diffRes);
      assert.match(
        md,
        new RegExp(`Verify: \`npx repo-archaeology explain --base ${baseSha} src/reused\\.ts src/partner\\.ts\``),
      );

      // Run explain --base <baseSha> with the current path `src/reused.ts` (as in the Verify command):
      // Must resolve rename lineage BEFORE matching the deleted `src/reused.ts` in the baseline model,
      // and must classify imports using the current working-tree path (`direct`, not `unknown`)!
      const explainCurrent = await explain(ctx, 'src/reused.ts', 'src/partner.ts');
      assert.equal(explainCurrent.from, 'src/reused.ts');
      assert.equal(explainCurrent.to, 'src/partner.ts');
      assert.equal(explainCurrent.shared, 4);
      assert.equal(explainCurrent.fromChanges, 4);
      assert.equal(explainCurrent.confidence, 1);
      assert.equal(explainCurrent.relationship, 'direct');

      // Running explain --base with the old baseline path `src/original.ts` also maps to current `src/reused.ts` for classification
      const explainOldName = await explain(ctx, 'src/original.ts', 'src/partner.ts');
      assert.equal(explainOldName.shared, 4);
      assert.equal(explainOldName.fromChanges, 4);
      assert.equal(explainOldName.relationship, 'direct');

      // Brand-new file added over a previously deleted path (`src/fresh-reused.ts`) must NOT inherit deleted history
      await assert.rejects(
        () => explain(ctx, 'src/fresh-reused.ts', 'src/partner.ts'),
        /Nothing to show for src\/fresh-reused\.ts: it has no usable history yet/,
      );

      // Uncommitted working-tree rename WITHOUT --base (`git mv src/reused.ts src/wt-renamed.ts`):
      // diff (without --base) produces a suggestion with Verify command omitting --base,
      // and running explain without --base resolves the working-tree rename and classifies current imports.
      repo.git('mv', 'src/reused.ts', 'src/wt-renamed.ts');
      const ctxNoBase = await loadContext(repo.dir, {});
      const diffNoBase = await diff(ctxNoBase, {
        limit: 10,
        kinds: ['ghost', 'unknown', 'indirect', 'direct', 'test'],
      });
      assert.equal(diffNoBase.suggestions.length, 1);
      assert.equal(diffNoBase.suggestions[0]!.from, 'src/wt-renamed.ts');
      assert.equal(diffNoBase.suggestions[0]!.to, 'src/partner.ts');
      const mdNoBase = renderDiffMarkdown(diffNoBase);
      assert.match(
        mdNoBase,
        /Verify: `npx repo-archaeology explain src\/wt-renamed\.ts src\/partner\.ts`/,
      );
      const explainWtRename = await explain(ctxNoBase, 'src/wt-renamed.ts', 'src/partner.ts');
      assert.equal(explainWtRename.from, 'src/wt-renamed.ts');
      assert.equal(explainWtRename.to, 'src/partner.ts');
      assert.equal(explainWtRename.shared, 4);
      assert.equal(explainWtRename.fromChanges, 5);
      assert.equal(explainWtRename.relationship, 'direct');
    } finally {
      repo.cleanup();
    }
  });

  it('enforces UTF-8 maxBytes ceiling in sub-linear time and shows totalSuggestions when capped by --limit', () => {
    const manySuggestions = Array.from({ length: 12 }, (_, idx) => ({
      ...createBaseDiffResult().suggestions[0]!,
      to: `src/adapter/platform-${idx}/serve-static.ts`,
      alsoLinkedFrom: [],
    }));
    const result = createBaseDiffResult({
      base: '00112233445566778899aabbccddeeff00112233',
      totalSuggestions: 25,
      suggestions: manySuggestions,
    });
    const fullMd = renderDiffMarkdown(result);
    assert.match(fullMd, /against base `0011223`/);
    assert.match(fullMd, /### Possibly missed \(showing 12 of 25\)/);

    const fullBytes = Buffer.byteLength(fullMd, 'utf8');

    // Exact byte-budget boundary assertions: fullBytes + 1, fullBytes, and fullBytes - 1
    const aboveExact = renderDiffMarkdown(result, { maxBytes: fullBytes + 1 });
    assert.equal(Buffer.byteLength(aboveExact, 'utf8'), fullBytes);
    assert.doesNotMatch(aboveExact, /Output truncated/);

    const atExact = renderDiffMarkdown(result, { maxBytes: fullBytes });
    assert.equal(Buffer.byteLength(atExact, 'utf8'), fullBytes);
    assert.doesNotMatch(atExact, /Output truncated/);

    const belowExact = renderDiffMarkdown(result, { maxBytes: fullBytes - 1 });
    const belowExactBytes = Buffer.byteLength(belowExact, 'utf8');
    assert.ok(
      belowExactBytes <= fullBytes - 1,
      `expected budget fullBytes - 1 (${fullBytes - 1} B) to truncate, got ${belowExactBytes} B`,
    );
    assert.match(belowExact, /Output truncated to stay within the summary size limit/);

    const tightBudget = Math.floor(fullBytes * 0.45);
    const truncatedMd = renderDiffMarkdown(result, { maxBytes: tightBudget });
    const truncatedBytes = Buffer.byteLength(truncatedMd, 'utf8');

    assert.ok(
      truncatedBytes <= tightBudget,
      `expected truncated markdown (${truncatedBytes} B) <= maxBytes (${tightBudget} B)`,
    );
    assert.match(truncatedMd, /### Possibly missed \(showing \d+ of 25\)/);
    assert.match(truncatedMd, /Output truncated to stay within the summary size limit \(omitted \d+ suggestions?\)/);

    // Performance regression check: 2,000 suggestions truncated to 16 KiB must finish quickly (< 500ms)
    const hugeSuggestions = Array.from({ length: 2000 }, (_, idx) => ({
      ...createBaseDiffResult().suggestions[0]!,
      to: `src/adapter/platform-${idx}/serve-static.ts`,
      alsoLinkedFrom: [],
    }));
    const startMs = performance.now();
    const hugeTruncated = renderDiffMarkdown(
      createBaseDiffResult({ totalSuggestions: 2000, suggestions: hugeSuggestions }),
      { maxBytes: 16 * 1024 },
    );
    const elapsedMs = performance.now() - startMs;
    assert.ok(Buffer.byteLength(hugeTruncated, 'utf8') <= 16 * 1024);
    assert.ok(elapsedMs < 500, `expected 2,000-suggestion truncation in < 500ms, took ${elapsedMs.toFixed(1)}ms`);
  });
});
