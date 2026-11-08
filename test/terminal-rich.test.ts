import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { sanitizeGitEnv } from '../scripts/schema-validator.mjs';
import type { DiffResult } from '../src/commands/diff.js';
import type { ExplainResult } from '../src/commands/explain.js';
import type { FileResult } from '../src/commands/file.js';
import type { ScanOptions, ScanResult } from '../src/commands/scan.js';
import {
  detectTerminalCapabilities,
  formatOsc8CommitLink,
  formatRichDiff,
  formatRichExplain,
  formatRichFile,
  formatRichScan,
  getDisplayWidth,
  middleTruncatePath,
  parseTrustedRemoteRepoUrl,
  sanitizeRichText,
  startRichProgressSpinner,
  stripAnsiAndOsc8,
} from '../src/report/terminal-rich.js';
import { ConfigError } from '../src/errors.js';
import { resolveStyleMode } from '../src/style/frame12.js';
import { terminalText } from '../src/util/term.js';
import { FixtureRepo } from './helpers.js';

const ROOT_DIR = join(import.meta.dirname, '..');
const CLI = join(ROOT_DIR, 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');

function runCli(args: string[], cwd: string, extraEnv: Record<string, string | undefined> = {}) {
  const env: NodeJS.ProcessEnv = sanitizeGitEnv(process.env, {
    NO_COLOR: '1',
    TERM: 'xterm-256color',
  });
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const result = spawnSync(process.execPath, ['--import', TSX, CLI, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    env,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('RA-13 · FRAME/12 rich terminal output', () => {
  describe('capability detection & precedence contract', () => {
    it('enforces explicit color precedence (--no-color > nonempty NO_COLOR > NODE_DISABLE_COLORS > FORCE_COLOR > TERM=dumb > TTY)', () => {
      // 1. --no-color wins over FORCE_COLOR=3 and TTY
      assert.equal(
        detectTerminalCapabilities({
          argv: ['node', 'cli.ts', '--no-color'],
          env: { FORCE_COLOR: '3', COLORTERM: 'truecolor' },
          isTTY: true,
        }).colorLevel,
        0,
      );

      // 2. Non-empty NO_COLOR disables color, even with FORCE_COLOR=3
      assert.equal(
        detectTerminalCapabilities({
          argv: [],
          env: { NO_COLOR: '1', FORCE_COLOR: '3', COLORTERM: 'truecolor' },
          isTTY: true,
        }).colorLevel,
        0,
      );

      // 3. Empty NO_COLOR="" does NOT disable color on a truecolor TTY (https://no-color.org/)
      assert.equal(
        detectTerminalCapabilities({
          argv: [],
          env: { NO_COLOR: '', COLORTERM: 'truecolor' },
          isTTY: true,
        }).colorLevel,
        3,
      );

      // 4. NODE_DISABLE_COLORS=1 disables color
      assert.equal(
        detectTerminalCapabilities({
          argv: [],
          env: { NODE_DISABLE_COLORS: '1', FORCE_COLOR: '3' },
          isTTY: true,
        }).colorLevel,
        0,
      );

      // 5. Explicit FORCE_COLOR=1/2/3 enables color even when piped (isTTY: false)
      assert.equal(
        detectTerminalCapabilities({
          argv: [],
          env: { FORCE_COLOR: '1' },
          isTTY: false,
        }).colorLevel,
        1,
      );
      assert.equal(
        detectTerminalCapabilities({
          argv: [],
          env: { FORCE_COLOR: '2' },
          isTTY: false,
        }).colorLevel,
        2,
      );
      assert.equal(
        detectTerminalCapabilities({
          argv: [],
          env: { FORCE_COLOR: '3' },
          isTTY: false,
        }).colorLevel,
        3,
      );
      assert.equal(
        detectTerminalCapabilities({
          argv: [],
          env: { FORCE_COLOR: '0', COLORTERM: 'truecolor' },
          isTTY: true,
        }).colorLevel,
        0,
      );

      // 6. TERM=dumb and non-TTY without FORCE_COLOR resolve to colorLevel 0
      assert.equal(
        detectTerminalCapabilities({
          argv: [],
          env: { TERM: 'dumb', COLORTERM: 'truecolor' },
          isTTY: true,
        }).colorLevel,
        0,
      );
      assert.equal(
        detectTerminalCapabilities({
          argv: [],
          env: { COLORTERM: 'truecolor' },
          isTTY: false,
        }).colorLevel,
        0,
      );

      // 7. Windows Terminal (WT_SESSION), VS Code, 256color, and basic TTY detection
      assert.equal(
        detectTerminalCapabilities({
          argv: [],
          env: { WT_SESSION: 'guid-1234' },
          isTTY: true,
        }).colorLevel,
        3,
      );
      assert.equal(
        detectTerminalCapabilities({
          argv: [],
          env: { TERM_PROGRAM: 'vscode' },
          isTTY: true,
        }).colorLevel,
        3,
      );
      assert.equal(
        detectTerminalCapabilities({
          argv: [],
          env: { TERM: 'xterm-256color' },
          isTTY: true,
        }).colorLevel,
        2,
      );
      assert.equal(
        detectTerminalCapabilities({
          argv: [],
          env: { TERM: 'xterm' },
          isTTY: true,
        }).colorLevel,
        1,
      );
    });

    it('keeps --ascii, --no-color, and --no-links independent', () => {
      const asciiOnly = detectTerminalCapabilities({
        ascii: true,
        env: { COLORTERM: 'truecolor' },
        isTTY: true,
      });
      assert.equal(asciiOnly.unicode, false);
      assert.equal(asciiOnly.colorLevel, 3);
      assert.equal(asciiOnly.links, true);

      const noLinksOnly = detectTerminalCapabilities({
        noLinks: true,
        env: { COLORTERM: 'truecolor' },
        isTTY: true,
      });
      assert.equal(noLinksOnly.links, false);
      assert.equal(noLinksOnly.unicode, true);
      assert.equal(noLinksOnly.colorLevel, 3);

      const noColorOnly = detectTerminalCapabilities({
        noColor: true,
        env: { COLORTERM: 'truecolor' },
        isTTY: true,
      });
      assert.equal(noColorOnly.colorLevel, 0);
      assert.equal(noColorOnly.unicode, true);
      assert.equal(noColorOnly.links, true);
    });

    it('resolves style mode with precedence: --style > REPO_ARCHAEOLOGY_STYLE > config > classic', () => {
      assert.equal(resolveStyleMode({}), 'classic');
      assert.equal(resolveStyleMode({ config: 'rich' }), 'rich');
      assert.equal(resolveStyleMode({ env: 'classic', config: 'rich' }), 'classic');
      assert.equal(resolveStyleMode({ flag: 'rich', env: 'classic', config: 'classic' }), 'rich');
      assert.throws(
        () => resolveStyleMode({ flag: 'neon' }),
        (err: unknown) => err instanceof ConfigError && /Invalid style mode from --style/.test(err.message),
      );

      // Invalid env or config warns and falls back to 'classic' instead of throwing
      const warnings: string[] = [];
      assert.equal(
        resolveStyleMode({ env: 'neon', onWarning: (msg) => warnings.push(msg) }),
        'classic',
      );
      assert.equal(
        resolveStyleMode({ config: 'neon', onWarning: (msg) => warnings.push(msg) }),
        'classic',
      );
      assert.equal(warnings.length, 2);
      assert.match(warnings[0]!, /Invalid style mode from REPO_ARCHAEOLOGY_STYLE/);
      assert.match(warnings[1]!, /Invalid style mode from config "style"/);
    });
  });

  describe('terminal safety, Unicode width, and OSC 8 hyperlink hardening', () => {
    it('strips CSI, OSC, DCS, APC, bare ESC, and bidi controls while preserving classic terminalText() and ZWJ/emoji graphemes', () => {
      // Classic terminalText() still escapes control chars visibly
      assert.equal(terminalText('line1\nline2\u001b[31m'), 'line1\\nline2\\x1b[31m');

      // Rich sanitizer strips executable/incomplete terminal sequences completely
      const malicious =
        'fix: \u001b]8;;https://evil.example/phish\u0007click-here\u001b]8;;\u0007 ' +
        '\u001b[2J\u001b[H\u009b31m\u001bP1$r\u001b\\\u001b_malicious-apc\u0007' +
        'bidi-\u202eevil\u202c-zwsp\u200b-incomplete\u001b[99';
      const cleaned = sanitizeRichText(malicious);
      assert.ok(!cleaned.includes('\u001b'), 'no raw ESC may survive sanitizeRichText');
      assert.ok(!cleaned.includes('\u0007'), 'no raw BEL may survive sanitizeRichText');
      assert.ok(!cleaned.includes('\u009b'), 'no C1 CSI may survive sanitizeRichText');
      assert.ok(!cleaned.includes('\u202e'), 'no bidi override may survive sanitizeRichText');
      assert.ok(!cleaned.includes('\u200b'), 'no zero-width space may survive sanitizeRichText');
      assert.ok(!cleaned.includes('evil.example'), 'malicious OSC 8 URL must be stripped');
      assert.match(cleaned, /click-here/);

      // Preserves combining marks, emoji skin tones, flags, and ZWJ sequences
      const unicodeText = 'café e\u0301 👍🏽 🇺🇸 👩‍💻 日本語';
      const sanitizedUnicode = sanitizeRichText(unicodeText);
      assert.equal(sanitizedUnicode, unicodeText);
      assert.ok(getDisplayWidth(sanitizedUnicode) >= 16);

      // Middle-truncation never splits a multi-codepoint grapheme cluster
      const emojiPath = 'src/👩‍💻/👍🏽/🇺🇸/café.ts';
      const truncated = middleTruncatePath(emojiPath, 12, true);
      assert.equal(truncated.truncated, true);
      assert.ok(getDisplayWidth(truncated.display) <= 12);
    });

    it('constructs OSC 8 links only from strictly validated remotes and commit SHAs', () => {
      // Valid HTTPS, SSH, and SCP remotes
      assert.deepEqual(parseTrustedRemoteRepoUrl('https://github.com/lbrodie11/repo-archaeology.git'), {
        baseUrl: 'https://github.com/lbrodie11/repo-archaeology',
        commitPathSegment: 'commit',
      });
      assert.deepEqual(parseTrustedRemoteRepoUrl('git@github.com:lbrodie11/repo-archaeology.git'), {
        baseUrl: 'https://github.com/lbrodie11/repo-archaeology',
        commitPathSegment: 'commit',
      });
      assert.deepEqual(parseTrustedRemoteRepoUrl('ssh://git@gitlab.com/group/sub/project.git'), {
        baseUrl: 'https://gitlab.com/group/sub/project',
        commitPathSegment: 'commit',
      });
      assert.deepEqual(parseTrustedRemoteRepoUrl('https://bitbucket.org/workspace/repo'), {
        baseUrl: 'https://bitbucket.org/workspace/repo',
        commitPathSegment: 'commits',
      });

      // Rejects credentials, http://, file://, query/hash, traversal, unknown hosts, control chars
      assert.equal(parseTrustedRemoteRepoUrl('https://user:secret@github.com/a/b.git'), undefined);
      assert.equal(parseTrustedRemoteRepoUrl('ssh://admin@github.com/a/b.git'), undefined);
      assert.equal(parseTrustedRemoteRepoUrl('http://github.com/a/b.git'), undefined);
      assert.equal(parseTrustedRemoteRepoUrl('file:///tmp/repo'), undefined);
      assert.equal(parseTrustedRemoteRepoUrl('https://github.com/a/b?foo=1'), undefined);
      assert.equal(parseTrustedRemoteRepoUrl('https://github.com/a/b#frag'), undefined);
      assert.equal(parseTrustedRemoteRepoUrl('https://github.com/a/../b'), undefined);
      assert.equal(parseTrustedRemoteRepoUrl('https://evil.example.com/a/b.git'), undefined);
      assert.equal(parseTrustedRemoteRepoUrl('https://github.com/a/b\u001b]8;;evil'), undefined);

      // Valid SHA + valid remote + links=true emits OSC 8
      const sha = 'abcdef1234567890abcdef1234567890abcdef12';
      const linked = formatOsc8CommitLink(
        sha,
        'abcdef1',
        'git@github.com:lbrodie11/repo-archaeology.git',
        true,
      );
      assert.equal(
        linked,
        `\u001b]8;;https://github.com/lbrodie11/repo-archaeology/commit/${sha}\u001b\\abcdef1\u001b]8;;\u001b\\`,
      );

      // Invalid SHA or untrusted remote falls back to plain SHA
      assert.equal(
        formatOsc8CommitLink('not-a-sha!', 'not-a-s', 'https://github.com/lbrodie11/repo-archaeology', true),
        'not-a-s',
      );
      assert.equal(
        formatOsc8CommitLink(sha, 'abcdef1', 'https://user:pass@github.com/lbrodie11/repo-archaeology', true),
        'abcdef1',
      );
    });
  });

  describe('classic regression guard, evidence preservation, and CLI integration', () => {
    let repo: FixtureRepo;

    before(() => {
      repo = new FixtureRepo();
      repo.git('remote', 'add', 'origin', 'https://github.com/lbrodie11/repo-archaeology.git');
      repo.write('src/adapter/bun/serve-static.ts', 'export const bunServe = 0;\n');
      repo.write('src/adapter/deno/serve-static.ts', 'export const denoServe = 0;\n');
      repo.write('src/adapter/cloudflare/serve-static.ts', 'export const cfServe = 0;\n');
      repo.write(
        '.repo-archaeology.verdicts.json',
        JSON.stringify(
          {
            version: 1,
            verdicts: [
              {
                pair: ['src/adapter/bun/serve-static.ts', 'src/adapter/deno/serve-static.ts'],
                verdict: 'confirmed',
                reason: 'Adapters must stay in lockstep on response headers',
                by: 'platform-team',
              },
            ],
          },
          null,
          2,
        ),
      );
      repo.git('add', '.');
      repo.commit({ message: 'initial setup', author: 'Alice' });

      // 6 shared commits so evidence has > 3 receipts (5 stored in model.evidence)
      for (let i = 1; i <= 6; i++) {
        repo.commit({
          message: `feat(serve-static): sync adapter behavior ${i}`,
          author: 'Alice',
          write: {
            'src/adapter/bun/serve-static.ts': `export const bunServe = ${i};\n`,
            'src/adapter/deno/serve-static.ts': `export const denoServe = ${i};\n`,
            'src/adapter/cloudflare/serve-static.ts': `export const cfServe = ${i};\n`,
          },
        });
      }
      // 1 solo commit for counterexample coverage in explain
      repo.commit({
        message: 'fix(bun): bun-only tweak',
        author: 'Bob',
        write: {
          'src/adapter/bun/serve-static.ts': 'export const bunServe = 99;\n',
        },
      });
    });

    after(() => {
      repo.cleanup();
    });

    it('preserves byte-identical classic output, JSON output, and Markdown output across commands', () => {
      // Dirty working tree for diff
      repo.write('src/adapter/bun/serve-static.ts', 'export const bunServe = 500;\n');
      try {
        for (const cmdArgs of [
          ['scan'],
          ['diff'],
          ['file', 'src/adapter/bun/serve-static.ts'],
          ['explain', 'src/adapter/bun/serve-static.ts', 'src/adapter/deno/serve-static.ts', '--counterexamples'],
        ]) {
          const defaultOut = runCli(cmdArgs, repo.dir);
          const explicitClassicOut = runCli([...cmdArgs, '--style', 'classic'], repo.dir);
          const envClassicOut = runCli(cmdArgs, repo.dir, { REPO_ARCHAEOLOGY_STYLE: 'classic' });
          assert.equal(defaultOut.code, 0, defaultOut.stderr);
          assert.equal(explicitClassicOut.stdout, defaultOut.stdout, `classic mismatch for ${cmdArgs.join(' ')}`);
          assert.equal(envClassicOut.stdout, defaultOut.stdout, `env classic mismatch for ${cmdArgs.join(' ')}`);
          // Classic output must not contain FRAME/12 banner
          assert.ok(!defaultOut.stdout.includes('FRAME/12'));

          // JSON output is byte-identical between classic and rich
          const jsonClassic = runCli([...cmdArgs, '--json'], repo.dir);
          const jsonRich = runCli([...cmdArgs, '--style', 'rich', '--json'], repo.dir);
          assert.equal(jsonClassic.code, 0, jsonClassic.stderr);
          assert.equal(jsonRich.stdout, jsonClassic.stdout, `JSON mismatch for ${cmdArgs.join(' ')}`);
        }

        // Markdown output (diff --format markdown) is byte-identical between classic and rich
        const mdClassic = runCli(['diff', '--format', 'markdown'], repo.dir);
        const mdRich = runCli(['diff', '--style', 'rich', '--format', 'markdown'], repo.dir);
        assert.equal(mdClassic.code, 0, mdClassic.stderr);
        assert.equal(mdRich.stdout, mdClassic.stdout);
      } finally {
        repo.git('checkout', '-q', '--', 'src/adapter/bun/serve-static.ts');
      }
    });

    it('renders rich output for scan, diff, file, explain, and bare CLI while preserving all evidence, families, verdicts, and statistical meaning', () => {
      repo.write('src/adapter/bun/serve-static.ts', 'export const bunServe = 500;\n');
      try {
        const classicDiff = runCli(['diff'], repo.dir).stdout;
        const richDiff = runCli(['diff', '--style', 'rich'], repo.dir).stdout;
        const richDiffPlain = stripAnsiAndOsc8(richDiff);

        assert.match(richDiffPlain, /FRAME\/12 · Repo Archaeology · diff/);
        assert.match(richDiffPlain, /Finding families \(1\)/);
        assert.match(richDiffPlain, /Possibly missed \(2\)/);
        assert.match(richDiffPlain, /\[F-01 · #1 IN RANKING\]/);
        assert.match(richDiffPlain, /\[F-02\]/);
        // At most one marker ranking badge per render
        assert.equal((richDiffPlain.match(/#1 IN RANKING/g) ?? []).length, 1);

        // Preserves verdict annotation
        assert.match(richDiffPlain, /confirmed \(by platform-team\): Adapters must stay in lockstep/);

        // Preserves all 3 mined supporting commit receipts in CLI diff
        for (let i = 4; i <= 6; i++) {
          assert.match(
            classicDiff,
            new RegExp(`sync adapter behavior ${i}`),
            `expected receipt ${i} in classic diff`,
          );
          assert.match(
            richDiffPlain,
            new RegExp(`sync adapter behavior ${i}`),
            `expected receipt ${i} preserved in rich diff`,
          );
        }

        // Live CLI diff --style rich preserves all 7 shared commits via "Additional receipts (+4 more…)"
        // and inlines all 7 when --full-evidence is passed.
        assert.match(
          richDiffPlain,
          /Additional receipts \(\+4 more; pass --full-evidence to inline\):/,
        );
        for (let i = 1; i <= 6; i++) {
          assert.match(richDiffPlain, new RegExp(`sync adapter behavior ${i}`));
        }
        assert.match(richDiffPlain, /initial setup/);

        const richDiffFullPlain = stripAnsiAndOsc8(
          runCli(['diff', '--style', 'rich', '--full-evidence'], repo.dir).stdout,
        );
        assert.doesNotMatch(richDiffFullPlain, /Additional receipts/);
        for (let i = 1; i <= 6; i++) {
          assert.match(richDiffFullPlain, new RegExp(`sync adapter behavior ${i}`));
        }
        assert.match(richDiffFullPlain, /initial setup/);

        // Live CLI scan --style rich and scan --style rich --full-evidence also preserve all 7 receipts
        const richScanPlain = stripAnsiAndOsc8(runCli(['scan', '--style', 'rich'], repo.dir).stdout);
        assert.match(
          richScanPlain,
          /Additional receipts \(\+4 more; pass --full-evidence to inline\):/,
        );
        const richScanFullPlain = stripAnsiAndOsc8(
          runCli(['scan', '--style', 'rich', '--full-evidence'], repo.dir).stdout,
        );
        assert.doesNotMatch(richScanFullPlain, /Additional receipts/);
        for (let i = 1; i <= 6; i++) {
          assert.match(richScanFullPlain, new RegExp(`sync adapter behavior ${i}`));
        }

        // Weighted confidence (--half-life) keeps (raw 95% CI ...) next to raw count and labels recency-weighted
        const weightedRichDiff = stripAnsiAndOsc8(
          runCli(['diff', '--style', 'rich', '--half-life', '7'], repo.dir).stdout,
        );
        assert.match(
          weightedRichDiff,
          /7 of 8 commits \(raw 95% CI 52–98%\) \(\d+% recency-weighted\)/,
        );
        assert.doesNotMatch(weightedRichDiff, /recency-weighted\)\s*\((?:raw )?95% CI/);

        // Rich file command (default + --full-evidence)
        const richFilePlain = stripAnsiAndOsc8(
          runCli(['file', 'src/adapter/bun/serve-static.ts', '--style', 'rich'], repo.dir).stdout,
        );
        assert.match(richFilePlain, /FRAME\/12 · Repo Archaeology · file src\/adapter\/bun\/serve-static\.ts/);
        assert.match(richFilePlain, /Who knows it/);
        assert.match(richFilePlain, /Files that move with it/);
        assert.match(
          richFilePlain,
          /Additional receipts \(\+4 more; pass --full-evidence to inline\):/,
        );
        assert.equal((richFilePlain.match(/#1 IN RANKING/g) ?? []).length, 1);

        const richFileFullPlain = stripAnsiAndOsc8(
          runCli(
            ['file', 'src/adapter/bun/serve-static.ts', '--style', 'rich', '--full-evidence'],
            repo.dir,
          ).stdout,
        );
        assert.doesNotMatch(richFileFullPlain, /Additional receipts/);

        // Rich explain command (with patch hunks and counterexamples)
        const richExplainPlain = stripAnsiAndOsc8(
          runCli(
            [
              'explain',
              'src/adapter/bun/serve-static.ts',
              'src/adapter/deno/serve-static.ts',
              '--counterexamples',
              '--style',
              'rich',
            ],
            repo.dir,
          ).stdout,
        );
        assert.match(richExplainPlain, /FRAME\/12 · Repo Archaeology · explain/);
        assert.match(richExplainPlain, /\[F-01 · PAIR EVIDENCE\]/);
        assert.match(richExplainPlain, /Shared commits/);
        assert.match(richExplainPlain, /\+export const bunServe = 6;/);
        assert.match(richExplainPlain, /When one file changed without the other/);
        assert.match(richExplainPlain, /bun-only tweak/);

        // Bare CLI with --style rich runs diff when dirty
        const bareRichDirty = stripAnsiAndOsc8(runCli(['--style', 'rich'], repo.dir).stdout);
        assert.match(bareRichDirty, /FRAME\/12 · Repo Archaeology · diff/);
      } finally {
        repo.git('checkout', '-q', '--', 'src/adapter/bun/serve-static.ts');
      }

      // Bare CLI with --style rich runs scan when clean
      const bareRichClean = stripAnsiAndOsc8(runCli(['--style', 'rich'], repo.dir).stdout);
      assert.match(bareRichClean, /FRAME\/12 · Repo Archaeology · scan/);

      // Silence diagnostics preserved in rich diff when working tree is clean
      const silentRichDiff = stripAnsiAndOsc8(runCli(['diff', '--style', 'rich'], repo.dir).stdout);
      assert.match(silentRichDiff, /No uncommitted changes\. Use --base main to check a whole branch\./);

      // Commands outside RA-13 scope (backtest, imports, verdict) do not fail when --style rich is passed
      assert.equal(runCli(['imports', '--style', 'rich'], repo.dir).code, 0);
      assert.equal(runCli(['verdict', 'list', '--style', 'rich'], repo.dir).code, 0);

      // Invalid REPO_ARCHAEOLOGY_STYLE is ignored in --json and --format markdown modes,
      // and warns + falls back to classic in terminal mode.
      const badEnvJsonRes = runCli(['scan', '--json'], repo.dir, {
        REPO_ARCHAEOLOGY_STYLE: 'invalid-style',
      });
      assert.equal(badEnvJsonRes.code, 0);
      assert.equal(badEnvJsonRes.stderr, '');
      assert.doesNotThrow(() => JSON.parse(badEnvJsonRes.stdout));

      const badEnvMdRes = runCli(['diff', '--format', 'markdown'], repo.dir, {
        REPO_ARCHAEOLOGY_STYLE: 'invalid-style',
      });
      assert.equal(badEnvMdRes.code, 0);
      assert.equal(badEnvMdRes.stderr, '');

      const badEnvTermRes = runCli(['scan'], repo.dir, {
        REPO_ARCHAEOLOGY_STYLE: 'invalid-style',
      });
      assert.equal(badEnvTermRes.code, 0);
      assert.match(badEnvTermRes.stderr, /Invalid style mode from REPO_ARCHAEOLOGY_STYLE/);
      assert.ok(!badEnvTermRes.stdout.includes('FRAME/12'));

      // Invalid .repo-archaeology.json "style" is ignored in --json and warns + falls back in terminal mode
      repo.write('.repo-archaeology.json', JSON.stringify({ style: 'invalid-style' }));
      try {
        const badConfigJsonRes = runCli(['scan', '--json'], repo.dir);
        assert.equal(badConfigJsonRes.code, 0);
        assert.equal(badConfigJsonRes.stderr, '');

        const badConfigTermRes = runCli(['scan'], repo.dir);
        assert.equal(badConfigTermRes.code, 0);
        assert.match(badConfigTermRes.stderr, /Invalid style mode from config "style"/);
        assert.ok(!badConfigTermRes.stdout.includes('FRAME/12'));
      } finally {
        repo.git('clean', '-fdq', '--', '.repo-archaeology.json');
      }

      // Explicit invalid --style flag fails with exit code 2
      const badFlagRes = runCli(['scan', '--style', 'invalid-style'], repo.dir);
      assert.equal(badFlagRes.code, 2);
      assert.match(badFlagRes.stderr, /Invalid style mode from --style/);
    });

    it('shell-quotes Inspect command arguments and preserves --head, --base, and analysis options', () => {
      const scanJson = JSON.parse(runCli(['scan', '--json'], repo.dir).stdout) as ScanResult;
      const baseRel = scanJson.relationships[0]!;
      const dangerousPaths = [
        '$(printf INJECTED).ts',
        'src/a"b\'c.ts',
        'src/a\u001b[31m\u202eb.ts',
        '-leading-dash.ts',
      ];

      for (const dangerousFrom of dangerousPaths) {
        const craftedScan: ScanResult = {
          ...scanJson,
          relationships: [{ ...baseRel, from: dangerousFrom, to: 'src/safe.ts' }],
        };
        const outScan = stripAnsiAndOsc8(formatRichScan(craftedScan, { limit: 15, kinds: ['ghost'] }));
        const inspectScan = outScan.split('\n').find((line) => line.includes('Inspect:')) ?? '';
        assert.ok(!inspectScan.includes('"$(printf INJECTED).ts"'), `unquoted substitution in ${inspectScan}`);
        if (dangerousFrom.startsWith('-')) {
          assert.match(inspectScan, /explain -- '-leading-dash\.ts' src\/safe\.ts/);
        }

        const craftedDiff: DiffResult = {
          meta: scanJson.meta,
          changed: [{ path: dangerousFrom, sources: ['unstaged'], deleted: false, hasHistory: true }],
          suggestions: [
            {
              ...baseRel,
              from: dangerousFrom,
              to: 'src/safe.ts',
              alsoLinkedFrom: [],
            },
          ],
          families: [],
        };
        const outDiff = stripAnsiAndOsc8(formatRichDiff(craftedDiff));
        const inspectDiff = outDiff.split('\n').find((line) => line.includes('Inspect:')) ?? '';
        assert.ok(!inspectDiff.includes('"$(printf INJECTED).ts"'));
        if (dangerousFrom.startsWith('-')) {
          assert.match(inspectDiff, /explain -- '-leading-dash\.ts' src\/safe\.ts/);
        }

        const craftedFile: FileResult = {
          meta: scanJson.meta,
          path: dangerousFrom,
          changes: 8,
          churnPercentile: 0.9,
          medianChanges: 4,
          lastChanged: '2026-03-01',
          authors: [{ author: 'Alice', commits: 8, share: 1 }],
          companions: [{ ...baseRel, from: dangerousFrom, to: 'src/safe.ts', wouldAlert: true }],
        };
        const outFile = stripAnsiAndOsc8(formatRichFile(craftedFile));
        const inspectFile = outFile.split('\n').find((line) => line.includes('Inspect:')) ?? '';
        assert.ok(!inspectFile.includes('"$(printf INJECTED).ts"'));
        if (dangerousFrom.startsWith('-')) {
          assert.match(inspectFile, /explain -- '-leading-dash\.ts' src\/safe\.ts/);
        }
      }

      // Preserve --head and active history/weighting options in Inspect commands so inspecting
      // a finding at an earlier ref reproduces its reported shared commit count.
      repo.git('tag', 'baseline', 'HEAD~4');
      try {
        const baselineScanPlain = stripAnsiAndOsc8(
          runCli(
            ['scan', '--head', 'baseline', '--half-life', '30', '--max-commits', '100', '--style', 'rich'],
            repo.dir,
          ).stdout,
        );
        assert.match(baselineScanPlain, /4 of 4 commits/);
        assert.match(
          baselineScanPlain,
          /Inspect: npx repo-archaeology explain --head baseline --max-commits 100 --half-life 30 src\/adapter\/bun\/serve-static\.ts src\/adapter\/cloudflare\/serve-static\.ts/,
        );

        const baselineExplainJson = JSON.parse(
          runCli(
            [
              'explain',
              '--head',
              'baseline',
              '--max-commits',
              '100',
              '--half-life',
              '30',
              'src/adapter/bun/serve-static.ts',
              'src/adapter/cloudflare/serve-static.ts',
              '--json',
            ],
            repo.dir,
          ).stdout,
        ) as ExplainResult;
        assert.equal(baselineExplainJson.shared, 4);

        const headExplainJson = JSON.parse(
          runCli(
            [
              'explain',
              'src/adapter/bun/serve-static.ts',
              'src/adapter/cloudflare/serve-static.ts',
              '--json',
            ],
            repo.dir,
          ).stdout,
        ) as ExplainResult;
        assert.equal(headExplainJson.shared, 7);

        // diff --base HEAD~1 --head HEAD preserves both --base and --head in Inspect:
        const branchDiffPlain = stripAnsiAndOsc8(
          runCli(['diff', '--base', 'HEAD~1', '--head', 'HEAD', '--style', 'rich'], repo.dir).stdout,
        );
        assert.match(
          branchDiffPlain,
          /Inspect: npx repo-archaeology explain --head HEAD --base [0-9a-f]{40} src\/adapter\/bun\/serve-static\.ts/,
        );
      } finally {
        repo.git('tag', '-d', 'baseline');
      }
    });

    it('restores explain bounds and timeout notices and expands tabs in diff hunks', () => {
      const baseExplain = JSON.parse(
        runCli(
          ['explain', 'src/adapter/bun/serve-static.ts', 'src/adapter/deno/serve-static.ts', '--json'],
          repo.dir,
        ).stdout,
      ) as ExplainResult;

      // Exhausted patch-retrieval budget with 0 collected sharedCommits discloses timeout
      const timedOutEmptyExplain: ExplainResult = {
        ...baseExplain,
        shared: 3,
        sharedCommits: [],
        bounds: {
          ...baseExplain.bounds,
          commitsTruncated: true,
          contextClamped: true,
          outputTruncated: true,
          timedOut: true,
        },
      };
      const timedOutPlain = stripAnsiAndOsc8(formatRichExplain(timedOutEmptyExplain));
      assert.match(
        timedOutPlain,
        /No shared commit patches rendered \(patch retrieval reached time budget\)\./,
      );
      assert.match(
        timedOutPlain,
        /Bounds applied: showing up to 3 shared commits; context lines clamped to 2; patch output capped at 200 lines; patch retrieval reached time budget\./,
      );

      // Live CLI explain --context 99 --style rich surfaces contextClamped bound
      const clampedCliPlain = stripAnsiAndOsc8(
        runCli(
          [
            'explain',
            'src/adapter/bun/serve-static.ts',
            'src/adapter/deno/serve-static.ts',
            '--context',
            '99',
            '--style',
            'rich',
          ],
          repo.dir,
        ).stdout,
      );
      assert.match(
        clampedCliPlain,
        /Bounds applied: showing up to 3 shared commits; context lines clamped to 10\./,
      );

      // Tab-indented diff hunk lines expand tabs so '+'/'-' prefixes align with 4-space code
      const firstSharedCommit = baseExplain.sharedCommits[0]!;
      const tabbedExplain: ExplainResult = {
        ...baseExplain,
        sharedCommits: [
          {
            ...firstSharedCommit,
            fileA: {
              ...firstSharedCommit.fileA,
              hunks: [
                {
                  ...firstSharedCommit.fileA.hunks[0]!,
                  lines: ['-\treturn 7;', '+\treturn 8;'],
                },
              ],
            },
          },
        ],
      };
      const tabbedPlain = stripAnsiAndOsc8(formatRichExplain(tabbedExplain));
      assert.ok(!tabbedPlain.includes('\t'), 'expected tabs expanded in rich explain hunks');
      assert.match(tabbedPlain, /- {4}return 7;/);
      assert.match(tabbedPlain, /\+ {4}return 8;/);
    });

    it('adapts to 20, 40, 80, and 120 column widths while preserving full untruncated paths and complete ASCII mode across all 4 formatters', () => {
      const scanJson = JSON.parse(runCli(['scan', '--json'], repo.dir).stdout) as ScanResult;
      const scanOpts: ScanOptions = { limit: 15, kinds: ['ghost', 'unknown'] };

      for (const columns of [20, 40, 80, 120]) {
        const out = formatRichScan(scanJson, scanOpts, {
          columns,
          isTTY: true,
          env: { COLORTERM: 'truecolor' },
          remoteUrl: 'https://github.com/lbrodie11/repo-archaeology.git',
        });
        const plain = stripAnsiAndOsc8(out);
        // Full paths are always recoverable in the output at every width
        assert.ok(
          plain.includes('src/adapter/bun/serve-static.ts'),
          `expected full path in ${columns}-col output`,
        );
        assert.ok(
          plain.includes('src/adapter/deno/serve-static.ts'),
          `expected full companion path in ${columns}-col output`,
        );
        // Exactly one marker-yellow SGR sequence (48;2;255;214;10) per render
        const markerMatches = out.match(/\u001b\[1;48;2;255;214;10;38;2;18;18;18m/g) ?? [];
        assert.equal(markerMatches.length, 1, `expected 1 marker highlight at ${columns} cols`);
        // Valid remote + TTY emits OSC 8 commit links
        assert.match(out, /\u001b\]8;;https:\/\/github\.com\/lbrodie11\/repo-archaeology\/commit\/[0-9a-f]{40}\u001b\\/);
      }

      // ASCII mode replaces ALL generated non-ASCII punctuation across scan, diff, file, and explain
      // without disabling color or links, while preserving Unicode in repository-supplied text.
      const asciiScanOut = formatRichScan(scanJson, scanOpts, {
        columns: 80,
        ascii: true,
        isTTY: true,
        env: { COLORTERM: 'truecolor' },
        remoteUrl: 'https://github.com/lbrodie11/repo-archaeology.git',
      });
      const asciiScanPlain = stripAnsiAndOsc8(asciiScanOut);
      assert.match(asciiScanPlain, /^[\x00-\x7f]*$/);
      assert.match(asciiScanPlain, /F-01 \| #1 IN RANKING/);
      assert.match(asciiScanPlain, /95% CI 64-100%/);
      assert.match(asciiScanOut, /\u001b\[1;48;2;255;214;10/);

      repo.write('src/adapter/bun/serve-static.ts', 'export const bunServe = 500;\n');
      try {
        const diffJson = JSON.parse(
          runCli(['diff', '--half-life', '7', '--json'], repo.dir).stdout,
        ) as DiffResult;
        const asciiDiffPlain = stripAnsiAndOsc8(formatRichDiff(diffJson, { ascii: true, columns: 80 }));
        assert.match(asciiDiffPlain, /^[\x00-\x7f]*$/);
        assert.match(asciiDiffPlain, /raw 95% CI 52-98%/);
        assert.match(asciiDiffPlain, /-- changed src\/adapter\/bun\/serve-static\.ts; check /);

        // Silence detail with filtered_by_thresholds uses >= in --ascii mode
        const silentThresholdJson = JSON.parse(
          runCli(['diff', '--min-shared', '99', '--json'], repo.dir).stdout,
        ) as DiffResult;
        const asciiSilentPlain = stripAnsiAndOsc8(formatRichDiff(silentThresholdJson, { ascii: true }));
        assert.match(asciiSilentPlain, /^[\x00-\x7f]*$/);
        assert.match(asciiSilentPlain, /requires >=99 shared and >=40% confidence/);
      } finally {
        repo.git('checkout', '-q', '--', 'src/adapter/bun/serve-static.ts');
      }

      const fileJson = JSON.parse(
        runCli(['file', 'src/adapter/bun/serve-static.ts', '--json'], repo.dir).stdout,
      ) as FileResult;
      const asciiFilePlain = stripAnsiAndOsc8(formatRichFile(fileJson, { ascii: true, columns: 80 }));
      assert.match(asciiFilePlain, /^[\x00-\x7f]*$/);

      const explainJson = JSON.parse(
        runCli(
          [
            'explain',
            'src/adapter/bun/serve-static.ts',
            'src/adapter/deno/serve-static.ts',
            '--counterexamples',
            '--json',
          ],
          repo.dir,
        ).stdout,
      ) as ExplainResult;
      const asciiExplainPlain = stripAnsiAndOsc8(
        formatRichExplain(explainJson, { ascii: true, columns: 80 }),
      );
      assert.match(asciiExplainPlain, /^[\x00-\x7f]*$/);
      assert.match(asciiExplainPlain, /\[F-01 \| PAIR EVIDENCE\]/);

      // Repository-supplied Unicode in filenames/subjects is preserved even when ascii: true
      const unicodeScan: ScanResult = {
        ...scanJson,
        relationships: [
          {
            ...scanJson.relationships[0]!,
            from: 'src/café.ts',
          },
        ],
      };
      const unicodeAsciiPlain = stripAnsiAndOsc8(
        formatRichScan(unicodeScan, scanOpts, { ascii: true, columns: 80 }),
      );
      assert.match(unicodeAsciiPlain, /src\/café\.ts/);
    });

    it('benchmarks rich formatting of 500 findings independently from CLI startup', () => {
      const baseRel: ScanResult['relationships'][number] = {
        from: 'packages/payments/src/checkout/session-controller.ts',
        to: 'packages/payments/src/webhooks/stripe-handler.ts',
        relationship: 'ghost',
        why: 'no import link detected in the current code',
        shared: 14,
        fromChanges: 19,
        toChanges: 22,
        confidence: 0.737,
        reverseConfidence: 0.636,
        interval: { low: 0.512, high: 0.882 },
        reverseInterval: { low: 0.4295, high: 0.8027 },
        score: 0.512,
        weighted: false,
        lastTogether: '2026-10-15',
        crossesDirectories: true,
        evidence: [
          { hash: '1111111111111111111111111111111111111111', date: '2026-10-15', author: 'Alice', subject: 'feat: update checkout session' },
          { hash: '2222222222222222222222222222222222222222', date: '2026-10-10', author: 'Bob', subject: 'fix: handle webhook retry' },
          { hash: '3333333333333333333333333333333333333333', date: '2026-10-01', author: 'Alice', subject: 'refactor: sync payment metadata' },
        ],
      };

      const relationships = Array.from({ length: 500 }, (_, i) => ({
        ...baseRel,
        from: `packages/mod-${i}/src/service-${i}.ts`,
        to: `packages/mod-${i}/src/handler-${i}.ts`,
      }));

      const fixture500: ScanResult = {
        meta: {
          tool: 'repo-archaeology',
          root: '/tmp/bench',
          commitsRead: 2000,
          commitsAnalyzed: 1850,
          sweepsSkipped: 10,
          subjectSkipped: 0,
          renamesFollowed: 12,
          files: 1200,
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
        counts: { ghost: 500, unknown: 0, indirect: 0, direct: 0, test: 0 },
        qualifying: 500,
        classified: 500,
        truncated: false,
        relationships,
        families: [],
      };

      const scanOpts: ScanOptions = { limit: 500, kinds: ['ghost', 'unknown'] };
      // Warmup
      formatRichScan(fixture500, scanOpts, { isTTY: true, env: { COLORTERM: 'truecolor' } });

      const samples: number[] = [];
      let lastOutput = '';
      for (let i = 0; i < 15; i++) {
        const t0 = performance.now();
        lastOutput = formatRichScan(fixture500, scanOpts, {
          isTTY: true,
          env: { COLORTERM: 'truecolor' },
          remoteUrl: 'https://github.com/lbrodie11/repo-archaeology.git',
        });
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);
      const medianMs = samples[Math.floor(samples.length / 2)]!;
      const p95Ms = samples[Math.floor(samples.length * 0.95)]!;
      assert.ok(lastOutput.length > 100_000);
      assert.ok(
        medianMs < 150,
        `expected 500-finding rich format median < 150ms, got ${medianMs.toFixed(2)}ms (p95 ${p95Ms.toFixed(2)}ms)`,
      );

      // Verify spinner controller lifecycle cleans up without leaking timers
      const spinner = startRichProgressSpinner({ isTTY: false, env: { CI: 'true' } });
      spinner.update('Analyzing…');
      spinner.stop();
    });
  });
});
