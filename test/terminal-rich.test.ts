/**
 * `--style rich` terminal output (RA-13, rendered by `@frame12/terminal` since RA-21).
 *
 * RA-21 deleted Repo Archaeology's own rich renderer and capability code. Tests that exercised
 * those functions directly now check the same behavior through what replaced them: capability
 * precedence through `@frame12/terminal`'s detection with Repo Archaeology's flags mapped onto it,
 * sanitizing and width through the package's renderers, and commit links through the trusted-remote
 * rules Repo Archaeology keeps. The CLI integration, classic regression guard and style-mode tests
 * are unchanged in intent; their expectations follow the FRAME/12 grammar.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { after, before, describe, it } from 'node:test';
import { stringWidth, type Env } from '@frame12/terminal';
import { sanitizeGitEnv } from '../scripts/schema-validator.mjs';
import type { DiffResult } from '../src/commands/diff.js';
import type { ExplainResult } from '../src/commands/explain.js';
import type { FileResult } from '../src/commands/file.js';
import type { ScanOptions, ScanResult } from '../src/commands/scan.js';
import { ConfigError } from '../src/errors.js';
import {
  capabilityArgv,
  diffToRichView,
  explainToRichView,
  fileToRichView,
  renderRichView,
  scanToRichView,
  terminalCapabilities,
  type TerminalFlags,
} from '../src/report/frame12-terminal.js';
import { commitUrl, parseTrustedRemoteRepoUrl, startRichProgressSpinner } from '../src/report/terminal-safety.js';
import { resolveStyleMode } from '../src/style/frame12.js';
import { terminalText } from '../src/util/term.js';
import { FixtureRepo } from './helpers.js';
import { capsFor, FIXED, visible } from './rich-helpers.js';

const ROOT_DIR = join(import.meta.dirname, '..');
const CLI = join(ROOT_DIR, 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');

function runCli(args: string[], cwd: string, extraEnv: Record<string, string | undefined> = {}) {
  const env: NodeJS.ProcessEnv = sanitizeGitEnv(process.env, {
    NO_COLOR: '1',
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
  });
  for (const k of ['FORCE_COLOR', 'FRAME12_SCREEN_READER', 'FRAME12_ASCII', 'TERM_PROGRAM', 'LC_ALL', 'LC_CTYPE']) delete env[k];
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

/** Rendered prose with card gutters removed and wrapped lines joined, for sentence assertions. */
function flat(text: string): string {
  return visible(text)
    .split('\n')
    .map((l) => l.replace(/^[┃|]? +/, '').trim())
    .join(' ');
}

/** `@frame12/terminal`'s detection with Repo Archaeology's flags, for a fake stdout. */
function caps(flags: TerminalFlags, env: Env, isTTY: boolean) {
  return terminalCapabilities(flags, env, { stdout: { isTTY, columns: 80 }, stderr: { isTTY, columns: 80 } }, 'linux');
}

describe('RA-13 · FRAME/12 rich terminal output', () => {
  describe('capability detection & precedence contract (via @frame12/terminal)', () => {
    it('maps Repo Archaeology flags onto the package argv contract', () => {
      assert.deepEqual(capabilityArgv({}), []);
      assert.deepEqual(capabilityArgv({ color: true, links: true, ascii: false }), []);
      assert.deepEqual(capabilityArgv({ color: false, ascii: true, links: false, screenReader: true, columns: 120 }), [
        '--no-color',
        '--ascii',
        '--no-links',
        '--screen-reader',
        '--columns',
        '120',
      ]);
    });

    it('enforces explicit color precedence (--no-color > nonempty NO_COLOR > NODE_DISABLE_COLORS > FORCE_COLOR > TERM=dumb > TTY)', () => {
      // 1. --no-color wins over FORCE_COLOR=3 and TTY
      assert.equal(caps({ color: false }, { FORCE_COLOR: '3', COLORTERM: 'truecolor' }, true).colorLevel, 0);
      // 2. Non-empty NO_COLOR disables color, even with FORCE_COLOR=3
      assert.equal(caps({}, { NO_COLOR: '1', FORCE_COLOR: '3', COLORTERM: 'truecolor' }, true).colorLevel, 0);
      // 3. Empty NO_COLOR="" does NOT disable color on a truecolor TTY (https://no-color.org/)
      assert.equal(caps({}, { NO_COLOR: '', COLORTERM: 'truecolor' }, true).colorLevel, 3);
      // 4. NODE_DISABLE_COLORS=1 disables color
      assert.equal(caps({}, { NODE_DISABLE_COLORS: '1', FORCE_COLOR: '3' }, true).colorLevel, 0);
      // 5. Explicit FORCE_COLOR=1/2/3 enables color even when piped
      assert.equal(caps({}, { FORCE_COLOR: '1' }, false).colorLevel, 1);
      assert.equal(caps({}, { FORCE_COLOR: '2' }, false).colorLevel, 2);
      assert.equal(caps({}, { FORCE_COLOR: '3' }, false).colorLevel, 3);
      assert.equal(caps({}, { FORCE_COLOR: '0', COLORTERM: 'truecolor' }, true).colorLevel, 0);
      // 6. TERM=dumb and non-TTY without FORCE_COLOR resolve to colorLevel 0
      assert.equal(caps({}, { TERM: 'dumb', COLORTERM: 'truecolor' }, true).colorLevel, 0);
      assert.equal(caps({}, { COLORTERM: 'truecolor' }, false).colorLevel, 0);
      // 7. Windows Terminal (WT_SESSION), VS Code, 256color, and basic TTY detection
      assert.equal(caps({}, { WT_SESSION: 'guid-1234' }, true).colorLevel, 3);
      assert.equal(caps({}, { TERM_PROGRAM: 'vscode' }, true).colorLevel, 3);
      assert.equal(caps({}, { TERM: 'xterm-256color' }, true).colorLevel, 2);
      assert.equal(caps({}, { TERM: 'xterm' }, true).colorLevel, 1);
      // NO_COLOR asks for no color, not for no emphasis: bold and dim stay on a TTY, never on a pipe.
      assert.equal(caps({}, { NO_COLOR: '1' }, true).attributes, true);
      assert.equal(caps({}, { NO_COLOR: '1' }, false).attributes, false);
    });

    it('keeps --ascii, --no-color, and --no-links independent', () => {
      const env = { COLORTERM: 'truecolor', TERM_PROGRAM: 'iTerm.app', LANG: 'en_US.UTF-8' };
      const asciiOnly = caps({ ascii: true }, env, true);
      assert.equal(asciiOnly.unicode, false);
      assert.equal(asciiOnly.colorLevel, 3);
      assert.equal(asciiOnly.links, true);

      const noLinksOnly = caps({ links: false }, env, true);
      assert.equal(noLinksOnly.links, false);
      assert.equal(noLinksOnly.unicode, true);
      assert.equal(noLinksOnly.colorLevel, 3);

      const noColorOnly = caps({ color: false }, env, true);
      assert.equal(noColorOnly.colorLevel, 0);
      assert.equal(noColorOnly.unicode, true);
      assert.equal(noColorOnly.links, true);
    });

    it('takes --columns and --screen-reader from Repo Archaeology flags, and FRAME12_SCREEN_READER from the environment', () => {
      assert.equal(caps({ columns: 120 }, {}, true).columns, 120);
      assert.equal(caps({ columns: 5 }, {}, true).columns, 20, 'clamped to the package minimum');
      assert.equal(caps({}, { COLUMNS: '100' }, false).columns, 100);
      assert.equal(caps({ screenReader: true }, {}, true).screenReader, true);
      assert.equal(caps({}, { FRAME12_SCREEN_READER: '1' }, true).screenReader, true);
      assert.equal(caps({}, {}, true).screenReader, false);
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
    it('keeps classic terminalText() escaping, and preserves combining marks, emoji and CJK in rich output', () => {
      // Classic terminalText() still escapes control chars visibly
      assert.equal(terminalText('line1\nline2\u001b[31m'), 'line1\\nline2\\x1b[31m');

      const scan = sampleScan(1);
      const unicodePath = 'src/café é 👍🏽 🇺🇸 👩‍💻 日本語.ts';
      const rel = { ...scan.relationships[0]!, from: unicodePath };
      const out = renderRichView(scanToRichView({ ...scan, relationships: [rel] }, SCAN_OPTS, FIXED), capsFor({ columns: 120 }));
      assert.ok(visible(out).includes(unicodePath));
      // Middle-truncation keeps every line within the width without splitting graphemes.
      const narrow = renderRichView(scanToRichView({ ...scan, relationships: [{ ...rel, from: `src/👩‍💻/👍🏽/🇺🇸/${'deep/'.repeat(20)}café.ts` }] }, SCAN_OPTS, FIXED), capsFor({ columns: 40 }));
      for (const line of narrow.split('\n')) assert.ok(stringWidth(line) <= 40, JSON.stringify(visible(line)));
      assert.ok(visible(narrow).includes('café.ts'), 'middle truncation keeps the file name');
    });

    it('constructs commit links only from strictly validated remotes and commit SHAs', () => {
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

      // Valid SHA + valid remote gives the commit URL; anything else gives none
      const sha = 'abcdef1234567890abcdef1234567890abcdef12';
      assert.equal(commitUrl('git@github.com:lbrodie11/repo-archaeology.git', sha), `https://github.com/lbrodie11/repo-archaeology/commit/${sha}`);
      assert.equal(commitUrl('https://github.com/lbrodie11/repo-archaeology', 'not-a-sha!'), undefined);
      assert.equal(commitUrl('https://user:pass@github.com/lbrodie11/repo-archaeology', sha), undefined);

      // The package emits the OSC 8 link only when links are on
      const scan = sampleScan(1);
      const view = scanToRichView(scan, SCAN_OPTS, { ...FIXED, remoteUrl: 'git@github.com:lbrodie11/repo-archaeology.git' });
      const linked = renderRichView(view, capsFor({ env: { TERM_PROGRAM: 'iTerm.app' } }));
      assert.ok(linked.includes(`\u001b]8;;https://github.com/lbrodie11/repo-archaeology/commit/${'1'.repeat(40)}\u001b\\`));
      const unlinked = renderRichView(view, capsFor({ env: { TERM_PROGRAM: 'iTerm.app' }, flags: { links: false } }));
      assert.ok(!unlinked.includes('\u001b]8;'));
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

    it('renders rich output for scan, diff, file, explain, and bare CLI while preserving evidence, families, verdicts, and statistical meaning', () => {
      repo.write('src/adapter/bun/serve-static.ts', 'export const bunServe = 500;\n');
      try {
        const classicDiff = runCli(['diff'], repo.dir).stdout;
        const richDiff = runCli(['diff', '--style', 'rich', '--columns', '100'], repo.dir);
        assert.equal(richDiff.code, 0, richDiff.stderr);
        const richDiffPlain = visible(richDiff.stdout);

        assert.match(richDiffPlain, /^Repo Archaeology · diff \(uncommitted changes\)/);
        assert.match(richDiffPlain, /FINDINGS {2}2 \(1 top, 1 primary\)/);
        assert.match(richDiffPlain, /^F-01 {2}src\/adapter\/cloudflare\/serve-static\.ts usually changes with src\/adapter\/bun\/serve-static\.ts/m);
        assert.match(richDiffPlain, /^F-02 {2}src\/adapter\/deno\/serve-static\.ts usually changes with src\/adapter\/bun\/serve-static\.ts/m);
        // Families are named on the suggestions they cover
        assert.match(flat(richDiffPlain), /Part of the .* family: changed src\/adapter\/bun\/serve-static\.ts; check/);
        // Preserves the verdict annotation
        assert.match(flat(richDiffPlain), /Verdict: confirmed \(by platform-team\): Adapters must stay in lockstep/);

        // Receipts are --json's evidence (the 3 most recent of 7 shared commits), all listed on the card
        for (let i = 4; i <= 6; i++) {
          assert.match(classicDiff, new RegExp(`sync adapter behavior ${i}`), `expected receipt ${i} in classic diff`);
          assert.match(richDiffPlain, new RegExp(`sync adapter behavior ${i}`), `expected receipt ${i} preserved in rich diff`);
        }
        assert.doesNotMatch(richDiffPlain, /more receipts?/);

        // Screen-reader output lists every receipt; --full-evidence adds the stored ones beyond --json's evidence
        const srDiff = runCli(['diff', '--style', 'rich', '--screen-reader'], repo.dir).stdout;
        for (let i = 4; i <= 6; i++) assert.match(srDiff, new RegExp(`Receipt E-\\d+ for F-01 \\(commit\\): [0-9a-f]{40} [0-9-]+: feat\\(serve-static\\): sync adapter behavior ${i}`));
        assert.doesNotMatch(srDiff, /for F-01 \(commit\): .*sync adapter behavior 3/);
        assert.doesNotMatch(srDiff, /initial setup/);
        const srFull = runCli(['diff', '--style', 'rich', '--screen-reader', '--full-evidence'], repo.dir).stdout;
        for (let i = 1; i <= 6; i++) assert.match(srFull, new RegExp(`for F-01 \\(commit\\): .*sync adapter behavior ${i}`));
        assert.match(srFull, /for F-01 \(commit\): .*initial setup/);
        const richScanFull = visible(runCli(['scan', '--style', 'rich', '--full-evidence'], repo.dir).stdout);
        assert.match(richScanFull, /\+4 more receipts/);

        // Weighted confidence (--half-life) keeps the raw interval next to the raw counts and labels the weighting
        const weightedRichDiff = visible(runCli(['diff', '--style', 'rich', '--half-life', '7', '--columns', '200'], repo.dir).stdout);
        assert.match(flat(weightedRichDiff), /7 of 8 commits that changed src\/adapter\/bun\/serve-static\.ts also changed .* \(\d+% recency-weighted, raw 95% interval 53-98%\)/);
        assert.match(weightedRichDiff, /recency-weighted co-change confidence \(raw 95% interval\)/);

        // Rich file command
        const richFilePlain = visible(runCli(['file', 'src/adapter/bun/serve-static.ts', '--style', 'rich', '--columns', '100'], repo.dir).stdout);
        assert.match(richFilePlain, /^Repo Archaeology · file src\/adapter\/bun\/serve-static\.ts/);
        assert.match(richFilePlain, /Who knows it +Alice \d+%, Bob \d+%/);
        assert.match(richFilePlain, /Files that move with it +2/);
        assert.match(flat(richFilePlain), /Strong enough for diff to flag it \(at least 40% confidence\)\./);

        // Rich explain command: the pair, counterexample counts and receipts
        const richExplain = runCli(
          ['explain', 'src/adapter/bun/serve-static.ts', 'src/adapter/deno/serve-static.ts', '--counterexamples', '--style', 'rich', '--columns', '120'],
          repo.dir,
        );
        assert.equal(richExplain.code, 0, richExplain.stderr);
        const richExplainPlain = visible(richExplain.stdout);
        assert.match(richExplainPlain, /^Repo Archaeology · explain src\/adapter\/bun\/serve-static\.ts and src\/adapter\/deno\/serve-static\.ts/);
        assert.match(richExplainPlain, /^F-01 {2}src\/adapter\/deno\/serve-static\.ts usually changes with src\/adapter\/bun\/serve-static\.ts/m);
        assert.match(richExplainPlain, /Subject 1 without subject 2 +1/);
        assert.match(richExplainPlain, /Subject 2 without subject 1 +0/);
        assert.match(richExplainPlain, /sync adapter behavior 6 \(Alice\)/);
        assert.match(visible(runCli(['explain', 'src/adapter/bun/serve-static.ts', 'src/adapter/deno/serve-static.ts', '--style', 'rich', '--screen-reader'], repo.dir).stdout), /counterexample, src\/adapter\/bun\/serve-static\.ts without src\/adapter\/deno\/serve-static\.ts: fix\(bun\): bun-only tweak/);
        // Patch hunks stay in classic; rich points there
        assert.match(richExplainPlain, /explain .* --style classic/);

        // Bare CLI with --style rich runs diff when dirty
        const bareRichDirty = visible(runCli(['--style', 'rich'], repo.dir).stdout);
        assert.match(bareRichDirty, /^Repo Archaeology · diff/);
      } finally {
        repo.git('checkout', '-q', '--', 'src/adapter/bun/serve-static.ts');
      }

      // Bare CLI with --style rich runs scan when clean, and points at the map
      const bareRichClean = visible(runCli(['--style', 'rich'], repo.dir).stdout);
      assert.match(bareRichClean, /^Repo Archaeology · scan/);
      assert.match(bareRichClean, /npx repo-archaeology map\n {4}Explore the interactive view\./);

      // Silence diagnostics preserved in rich diff when working tree is clean
      const silentRichDiff = visible(runCli(['diff', '--style', 'rich'], repo.dir).stdout);
      assert.match(silentRichDiff, /warning: No uncommitted changes\./);
      assert.match(silentRichDiff, /npx repo-archaeology diff --base main\n {4}Check a whole branch\./);

      // Commands outside the rich renderer (backtest, imports, verdict) do not fail when --style rich is passed
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
      assert.ok(!badEnvTermRes.stdout.includes('FINDINGS'));

      // Invalid .repo-archaeology.json "style" is ignored in --json and warns + falls back in terminal mode
      repo.write('.repo-archaeology.json', JSON.stringify({ style: 'invalid-style' }));
      try {
        const badConfigJsonRes = runCli(['scan', '--json'], repo.dir);
        assert.equal(badConfigJsonRes.code, 0);
        assert.equal(badConfigJsonRes.stderr, '');

        const badConfigTermRes = runCli(['scan'], repo.dir);
        assert.equal(badConfigTermRes.code, 0);
        assert.match(badConfigTermRes.stderr, /Invalid style mode from config "style"/);
        assert.ok(!badConfigTermRes.stdout.includes('FINDINGS'));
      } finally {
        repo.git('clean', '-fdq', '--', '.repo-archaeology.json');
      }

      // Explicit invalid --style flag fails with exit code 2
      const badFlagRes = runCli(['scan', '--style', 'invalid-style'], repo.dir);
      assert.equal(badFlagRes.code, 2);
      assert.match(badFlagRes.stderr, /Invalid style mode from --style/);
    });

    it('follows the package linear rules on a pipe: no escapes, results on stdout only', () => {
      for (const env of [{}, { NO_COLOR: undefined, TERM_PROGRAM: 'iTerm.app', COLORTERM: 'truecolor' }]) {
        const res = runCli(['scan', '--style', 'rich'], repo.dir, env);
        assert.equal(res.code, 0, res.stderr);
        assert.ok(!res.stdout.includes('\u001b'), 'a pipe gets no escape sequences');
        assert.equal(res.stderr, '', 'nothing narrated to a non-TTY stderr');
      }
      // FORCE_COLOR=3 is honored on a pipe, as the package documents
      const forced = runCli(['scan', '--style', 'rich'], repo.dir, { NO_COLOR: undefined, FORCE_COLOR: '3' });
      assert.match(forced.stdout, /\u001b\[[0-9;]*48;2;255;214;10/);
    });

    it('shell-quotes suggested explain commands and preserves --head, --base, and analysis options', () => {
      const scanJson = JSON.parse(runCli(['scan', '--json'], repo.dir).stdout) as ScanResult;
      const baseRel = scanJson.relationships[0]!;
      const dangerousPaths = [
        '$(printf INJECTED).ts',
        'src/a"b\'c.ts',
        'src/a\u001b[31m‮b.ts',
        '-leading-dash.ts',
      ];
      const commands = (text: string) =>
        visible(text)
          .replace(/ \\\n\s*/g, ' ')
          .replace(/\\\n\s*/g, '')
          .split('\n')
          .filter((line) => line.includes('repo-archaeology explain'))
          .map((line) => line.trim());

      for (const dangerousFrom of dangerousPaths) {
        const craftedScan: ScanResult = { ...scanJson, families: [], relationships: [{ ...baseRel, from: dangerousFrom, to: 'src/safe.ts' }] };
        const craftedDiff: DiffResult = {
          meta: scanJson.meta,
          changed: [{ path: dangerousFrom, sources: ['unstaged'], deleted: false, hasHistory: true }],
          suggestions: [{ ...baseRel, from: dangerousFrom, to: 'src/safe.ts', alsoLinkedFrom: [] }],
          families: [],
        };
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
        for (const out of [
          renderRichView(scanToRichView(craftedScan, SCAN_OPTS, FIXED), capsFor()),
          renderRichView(diffToRichView(craftedDiff, FIXED), capsFor()),
          renderRichView(fileToRichView(craftedFile, FIXED), capsFor()),
        ]) {
          const [cmd] = commands(out);
          assert.ok(cmd, 'a suggested explain command');
          assert.ok(!cmd.includes('"$(printf INJECTED).ts"'), `unquoted substitution in ${cmd}`);
          if (dangerousFrom.startsWith('$(')) assert.match(cmd, /'\$\(printf INJECTED\)\.ts'/);
          if (dangerousFrom.startsWith('-')) assert.match(cmd, /explain -- '-leading-dash\.ts' src\/safe\.ts/);
          if (dangerousFrom.includes('\u001b')) assert.match(cmd, /\$'src\/a\\x1b\[31m\\u202eb\.ts'/);
        }
      }

      // Preserve --head and active history/weighting options in suggested commands so inspecting
      // a finding at an earlier ref reproduces its reported shared commit count.
      repo.git('tag', 'baseline', 'HEAD~4');
      try {
        const baselineScanPlain = visible(
          runCli(['scan', '--head', 'baseline', '--half-life', '30', '--max-commits', '100', '--style', 'rich', '--columns', '200'], repo.dir).stdout,
        );
        assert.match(baselineScanPlain, /4 of 4 commits/);
        assert.match(
          baselineScanPlain,
          /npx repo-archaeology explain --head baseline --max-commits 100 --half-life 30 src\/adapter\/bun\/serve-static\.ts src\/adapter\/cloudflare\/serve-static\.ts/,
        );

        const baselineExplainJson = JSON.parse(
          runCli(
            ['explain', '--head', 'baseline', '--max-commits', '100', '--half-life', '30', 'src/adapter/bun/serve-static.ts', 'src/adapter/cloudflare/serve-static.ts', '--json'],
            repo.dir,
          ).stdout,
        ) as ExplainResult;
        assert.equal(baselineExplainJson.shared, 4);

        const headExplainJson = JSON.parse(
          runCli(['explain', 'src/adapter/bun/serve-static.ts', 'src/adapter/cloudflare/serve-static.ts', '--json'], repo.dir).stdout,
        ) as ExplainResult;
        assert.equal(headExplainJson.shared, 7);

        // diff --base HEAD~1 --head HEAD preserves both --base and --head
        const branchDiffPlain = visible(runCli(['diff', '--base', 'HEAD~1', '--head', 'HEAD', '--style', 'rich', '--columns', '200'], repo.dir).stdout);
        assert.match(branchDiffPlain, /npx repo-archaeology explain --head HEAD --base [0-9a-f]{40} src\/adapter\/bun\/serve-static\.ts/);
      } finally {
        repo.git('tag', '-d', 'baseline');
      }
    });

    it('states explain bounds and timeout notices', () => {
      const baseExplain = JSON.parse(
        runCli(['explain', 'src/adapter/bun/serve-static.ts', 'src/adapter/deno/serve-static.ts', '--json'], repo.dir).stdout,
      ) as ExplainResult;

      // Exhausted patch-retrieval budget with 0 collected sharedCommits discloses timeout
      const timedOutEmptyExplain: ExplainResult = {
        ...baseExplain,
        shared: 3,
        sharedCommits: [],
        bounds: { ...baseExplain.bounds, commitsTruncated: true, contextClamped: true, outputTruncated: true, timedOut: true },
      };
      const timedOut = visible(renderRichView(explainToRichView(timedOutEmptyExplain, FIXED), capsFor({ columns: 200 })));
      assert.match(timedOut, /No shared commits shown \(patch retrieval reached time budget\)\./);
      assert.match(
        timedOut,
        /Bounds applied: showing up to 3 shared commits; context lines clamped to 2; patch output capped at 200 lines; patch retrieval reached time budget\./,
      );

      // Live CLI explain --context 99 --style rich surfaces contextClamped bound
      const clampedCli = visible(
        runCli(['explain', 'src/adapter/bun/serve-static.ts', 'src/adapter/deno/serve-static.ts', '--context', '99', '--style', 'rich', '--columns', '200'], repo.dir).stdout,
      );
      assert.match(clampedCli, /Bounds applied: showing up to 3 shared commits; context lines clamped to 10\./);
    });

    it('fits 20, 40, 80, and 120 columns, keeps one marker chip, and offers a complete ASCII mode across all 4 commands', () => {
      const scanJson = JSON.parse(runCli(['scan', '--json'], repo.dir).stdout) as ScanResult;
      const remote = { ...FIXED, remoteUrl: 'https://github.com/lbrodie11/repo-archaeology.git' };
      const scanView = scanToRichView(scanJson, SCAN_OPTS, remote);

      for (const columns of [20, 40, 80, 120]) {
        const out = renderRichView(scanView, capsFor({ columns, env: { COLORTERM: 'truecolor', TERM_PROGRAM: 'iTerm.app' } }));
        for (const line of out.split('\n')) assert.ok(stringWidth(line) <= columns, `${columns} cols: ${JSON.stringify(visible(line))}`);
        // Full paths are recoverable at every width in screen-reader output
        const sr = renderRichView(scanView, capsFor({ columns, flags: { screenReader: true } }));
        assert.ok(sr.includes('src/adapter/bun/serve-static.ts') && sr.includes('src/adapter/deno/serve-static.ts'));
        // Exactly one marker-yellow chip per render
        assert.equal((out.match(/\u001b\[[0-9;]*48;2;255;214;10/g) ?? []).length, 1, `expected 1 marker at ${columns} cols`);
        // Valid remote + a terminal with link support emits OSC 8 commit links
        assert.match(out, /\u001b\]8;;https:\/\/github\.com\/lbrodie11\/repo-archaeology\/commit\/[0-9a-f]{40}\u001b\\/);
      }

      // ASCII mode replaces all generated non-ASCII glyphs without disabling color or links,
      // while preserving Unicode in repository-supplied text.
      const asciiCaps = capsFor({ columns: 80, env: { COLORTERM: 'truecolor', TERM_PROGRAM: 'iTerm.app' }, flags: { ascii: true } });
      const asciiScanOut = renderRichView(scanView, asciiCaps);
      assert.match(visible(asciiScanOut), /^[\x00-\x7f]*$/);
      assert.match(asciiScanOut, /\u001b\[[0-9;]*48;2;255;214;10/);
      assert.match(asciiScanOut, /\u001b\]8;;https:/);

      repo.write('src/adapter/bun/serve-static.ts', 'export const bunServe = 500;\n');
      try {
        const diffJson = JSON.parse(runCli(['diff', '--half-life', '7', '--json'], repo.dir).stdout) as DiffResult;
        assert.match(visible(renderRichView(diffToRichView(diffJson, FIXED), asciiCaps)), /^[\x00-\x7f]*$/);
      } finally {
        repo.git('checkout', '-q', '--', 'src/adapter/bun/serve-static.ts');
      }
      const fileJson = JSON.parse(runCli(['file', 'src/adapter/bun/serve-static.ts', '--json'], repo.dir).stdout) as FileResult;
      assert.match(visible(renderRichView(fileToRichView(fileJson, FIXED), asciiCaps)), /^[\x00-\x7f]*$/);
      const explainJson = JSON.parse(
        runCli(['explain', 'src/adapter/bun/serve-static.ts', 'src/adapter/deno/serve-static.ts', '--counterexamples', '--json'], repo.dir).stdout,
      ) as ExplainResult;
      assert.match(visible(renderRichView(explainToRichView(explainJson, FIXED), asciiCaps)), /^[\x00-\x7f]*$/);

      // Repository-supplied Unicode in filenames is preserved even in ASCII mode
      const unicodeScan: ScanResult = { ...scanJson, families: [], relationships: [{ ...scanJson.relationships[0]!, from: 'src/café.ts' }] };
      assert.match(visible(renderRichView(scanToRichView(unicodeScan, SCAN_OPTS, FIXED), asciiCaps)), /src\/café\.ts/);
    });

    it('benchmarks rich formatting of 500 findings independently from CLI startup', () => {
      const scan = sampleScan(500);
      const caps = capsFor({ columns: 120, env: { COLORTERM: 'truecolor', TERM_PROGRAM: 'iTerm.app' } });
      const options = { ...FIXED, remoteUrl: 'https://github.com/lbrodie11/repo-archaeology.git' };
      const scanOptions: ScanOptions = { limit: 500, kinds: ['ghost', 'unknown'] };
      const median = (fn: () => void) => {
        fn(); // warmup
        const samples: number[] = [];
        for (let i = 0; i < 15; i++) {
          const t0 = performance.now();
          fn();
          samples.push(performance.now() - t0);
        }
        samples.sort((a, b) => a - b);
        return { median: samples[7]!, p95: samples[14]! };
      };

      // What Repo Archaeology owns: building the snapshot. RA-21 keeps a tighter budget here than
      // the old 150 ms for the whole render.
      const adapter = median(() => scanToRichView(scan, scanOptions, options));
      assert.ok(adapter.median < 15, `expected 500-finding adapter median < 15ms, got ${adapter.median.toFixed(2)}ms`);

      // The full render is @frame12/terminal's renderRich (0.1.0: about 180-240 ms for 500 findings
      // on an M-series laptop, ~90 ms of it sanitizing). The RA-13 budget of 150 ms measured Repo
      // Archaeology's own renderer, which RA-21 deleted; this end-to-end budget guards against a
      // regression in the integration, and the package's render time is an RA-21 follow-up for FRAME/12.
      let lastOutput = '';
      const full = median(() => {
        lastOutput = renderRichView(scanToRichView(scan, scanOptions, options), caps);
      });
      assert.ok(lastOutput.length > 100_000);
      assert.ok(full.median < 500, `expected 500-finding rich render median < 500ms, got ${full.median.toFixed(2)}ms (p95 ${full.p95.toFixed(2)}ms)`);

      // The default scan (15 findings) renders well under a frame budget.
      const small = sampleScan(15);
      const typical = median(() => renderRichView(scanToRichView(small, SCAN_OPTS, options), caps));
      assert.ok(typical.median < 50, `expected 15-finding rich render median < 50ms, got ${typical.median.toFixed(2)}ms`);

      // Verify the spinner controller lifecycle cleans up without leaking timers
      const spinner = startRichProgressSpinner({ isTTY: false, env: { CI: 'true' } });
      spinner.update('Analyzing…');
      spinner.stop();
    });
  });

  describe('one source of terminal colors, and no React', () => {
    const srcFiles = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? srcFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));

    it('nothing in src/ references FRAME12.terminal or the deleted rich renderer', () => {
      for (const file of srcFiles(join(ROOT_DIR, 'src'))) {
        const text = readFileSync(file, 'utf8');
        const rel = relative(ROOT_DIR, file);
        assert.doesNotMatch(text, /FRAME12\s*\.\s*terminal|FRAME12\[['"]terminal['"]\]/, `${rel} references FRAME12.terminal`);
        assert.doesNotMatch(text, /terminal-rich(\.js)?['"]/, `${rel} imports the deleted terminal-rich module`);
        assert.doesNotMatch(text, /\b(formatRich|printRich)\w*/, `${rel} references a deleted formatRich*/printRich* function`);
      }
    });

    it('imports @frame12/terminal only from its core and render entries, never ink or react', () => {
      for (const file of srcFiles(join(ROOT_DIR, 'src'))) {
        const text = readFileSync(file, 'utf8');
        const rel = relative(ROOT_DIR, file);
        for (const m of text.matchAll(/from\s+['"](@frame12\/[^'"]+)['"]/g)) {
          assert.ok(['@frame12/terminal', '@frame12/terminal/render'].includes(m[1]!), `${rel} imports ${m[1]}`);
        }
        assert.doesNotMatch(text, /from\s+['"](ink|react)(\/[^'"]*)?['"]|import\(\s*['"](ink|react)['"]/, `${rel} imports ink or react`);
      }
    });

    it('declares the dependency exactly pinned, with ink and react absent', () => {
      const pkg = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
      assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@frame12/terminal', 'commander', 'typescript']);
      assert.match(pkg.dependencies['@frame12/terminal']!, /^\d+\.\d+\.\d+$/, 'exact version');
      for (const deps of [pkg.dependencies, pkg.devDependencies]) {
        assert.equal(deps.ink, undefined);
        assert.equal(deps.react, undefined);
      }
    });
  });
});

const SCAN_OPTS: ScanOptions = { limit: 15, kinds: ['ghost', 'unknown'] };

/** A synthetic scan result with `n` ghost wires. */
function sampleScan(n: number): ScanResult {
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
  return {
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
      settings: { maxCommits: 5000, maxFilesPerCommit: 25, minShared: 3, minConfidence: 0.4, ignore: [], useDefaultIgnores: true },
      warnings: [],
    },
    counts: { ghost: n, unknown: 0, indirect: 0, direct: 0, test: 0 },
    qualifying: n,
    classified: n,
    truncated: false,
    relationships: Array.from({ length: n }, (_, i) => ({
      ...baseRel,
      from: n === 1 ? baseRel.from : `packages/mod-${i}/src/service-${i}.ts`,
      to: n === 1 ? baseRel.to : `packages/mod-${i}/src/handler-${i}.ts`,
    })),
    families: [],
  };
}
