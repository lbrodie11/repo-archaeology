/**
 * RA-21 · hostile repository text renders inert in `--style rich` and screen-reader mode.
 *
 * File paths, commit subjects, author names, verdict reasons, family labels and warnings are
 * untrusted. Fixtures inject ANSI (CSI, SGR, cursor moves, clear screen), OSC 8 links, OSC 52
 * clipboard writes, DCS/APC, C1 controls, bidi overrides and isolates, zero-width characters,
 * 10 KB subjects and 2 KB paths. Output must keep only the escape sequences the package emits
 * (its SGR styling and OSC 8 links to the trusted remote), carry no raw control or bidi
 * character, and keep every rich line within the terminal width.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stringWidth } from '@frame12/terminal';
import type { DiffResult } from '../src/commands/diff.js';
import type { ExplainResult } from '../src/commands/explain.js';
import type { FileResult } from '../src/commands/file.js';
import type { ScanResult } from '../src/commands/scan.js';
import { renderRichView } from '../src/report/frame12-terminal.js';
import { capsFor, COMMANDS, FIXED, HONO_REMOTE, loadHono, viewFor, visible, type HonoFixtures } from './rich-helpers.js';

const ESC = '\u001b';
const ATTACKS = [
  `${ESC}[2J${ESC}[H${ESC}[31mred${ESC}[0m`,
  `${ESC}]8;;https://evil.example/phish${ESC}\\click-here${ESC}]8;;${ESC}\\`,
  `${ESC}]52;c;cm0gLXJmIH4=${ESC}\\`,
  `${ESC}P1$r${ESC}\\${ESC}_apc${ESC}\\`,
  '\u009b31m\u0090dcs\u009c',
  'bidi-‮evil‬-⁦iso⁩',
  'zero​width‌‍⁠﻿',
  'cr\roverwrite\bback\u0007bell',
  `${ESC}[99`,
].join(' ');

const LONG_SUBJECT = `feat: ${'x'.repeat(10 * 1024)} ${ATTACKS}`;
const LONG_PATH = `src/${'deep/'.repeat(400)}${ATTACKS.replace(/ /g, '_')}.ts`;
const HOSTILE_PATH = `src/${ATTACKS}/evil.ts`;
const HOSTILE_AUTHOR = `Mallory ${ATTACKS}`;

function hostileFixtures(): HonoFixtures {
  const hono = loadHono();
  const evidence = <T extends { subject: string; author: string }>(list: T[]): T[] =>
    list.map((e, i) => ({ ...e, subject: i === 0 ? LONG_SUBJECT : `${e.subject} ${ATTACKS}`, author: HOSTILE_AUTHOR }));

  const scan: ScanResult = {
    ...hono.scan,
    meta: { ...hono.scan.meta, warnings: [`warning ${ATTACKS}`] },
    families: hono.scan.families.map((f) => ({
      ...f,
      label: `${f.label} ${ATTACKS}`,
      members: f.members.map((m, i) => ({ ...m, path: i === 0 ? LONG_PATH : m.path, variant: `${m.variant} ${ATTACKS}` })),
      evidence: evidence(f.evidence),
    })),
    relationships: hono.scan.relationships.map((r, i) => ({
      ...r,
      from: i % 2 === 0 ? HOSTILE_PATH : LONG_PATH,
      why: `${r.why} ${ATTACKS}`,
      verdict: { kind: 'confirmed', reason: `reason ${ATTACKS}`, by: HOSTILE_AUTHOR },
      evidence: evidence(r.evidence),
    })),
  };
  const diff: DiffResult = {
    ...hono.diff,
    base: `main${ATTACKS}`,
    suggestions: hono.diff.suggestions.map((s, i) => ({
      ...s,
      from: HOSTILE_PATH,
      to: i === 0 ? LONG_PATH : `${s.to}${ATTACKS}`,
      alsoLinkedFrom: [HOSTILE_PATH],
      codeowners: ['@org/team', `@${ATTACKS}`],
      owners: [{ name: HOSTILE_AUTHOR, login: `login${ATTACKS}`, commits: 2, lastDate: '2026-01-01' }],
      evidence: evidence(s.evidence),
    })),
  };
  const file: FileResult = {
    ...hono.file,
    path: HOSTILE_PATH,
    authors: hono.file.authors.map((a) => ({ ...a, author: HOSTILE_AUTHOR })),
    companions: hono.file.companions.map((c, i) => ({ ...c, to: i === 0 ? LONG_PATH : `${c.to}${ATTACKS}`, evidence: evidence(c.evidence) })),
  };
  const explain: ExplainResult = {
    ...hono.explain,
    from: LONG_PATH,
    to: HOSTILE_PATH,
    why: `why ${ATTACKS}`,
    sharedCommits: hono.explain.sharedCommits.map((c, i) => ({ ...c, subject: i === 0 ? LONG_SUBJECT : `${c.subject} ${ATTACKS}`, author: HOSTILE_AUTHOR })),
    disclaimer: hono.explain.disclaimer,
  };
  return { scan, diff, file, explain };
}

/** Escape sequences the package itself may emit: SGR styling and OSC 8 links to the trusted remote. */
const PACKAGE_SGR = /\u001b\[[0-9;]*m/g;
const PACKAGE_LINK = /\u001b\]8;;(?:https:\/\/github\.com\/honojs\/hono\/commit\/[0-9a-f]{40})?\u001b\\/g;
/**
 * Raw controls, bidi controls and invisible spacing. ZWNJ (U+200C) and ZWJ (U+200D) are not here:
 * `@frame12/terminal` keeps those two joiners in prose because they shape real scripts (Persian,
 * Indic, emoji), and shows them as `\u{200c}` escapes in identifiers such as paths (checked below).
 */
const FORBIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜​‎‏‪-‮⁠⁦-⁩﻿]/u;

function assertInert(label: string, out: string, columns: number | undefined): void {
  const rest = out.replace(PACKAGE_SGR, '').replace(PACKAGE_LINK, '');
  const bad = FORBIDDEN.exec(rest);
  assert.equal(bad, null, `${label}: raw control or bidi character U+${bad?.[0].codePointAt(0)?.toString(16)} survived at ${bad?.index}`);
  // Injected payloads are never live. Their text may appear only inside a copyable `explain`
  // command, where the path is shell-quoted as $'…\x1b]8;;https://evil.example…' (ESC as literal
  // text) so the command still names the real file. Commands wrap with `\` continuations, so they
  // are joined back first.
  const shown = visible(out).replace(/ ?\\\n\s*/g, (m) => (m.startsWith(' ') ? ' ' : ''));
  for (const [needle, escapedPrefix] of [
    ['evil.example', '\\x1b]8;;https://'],
    [']52;', '\\x1b'],
  ] as const) {
    for (let i = shown.indexOf(needle); i !== -1; i = shown.indexOf(needle, i + 1)) {
      assert.ok(shown.slice(0, i).endsWith(escapedPrefix), `${label}: injected ${needle} outside a quoted command`);
    }
  }
  assert.ok(!/(^|[^\w@])@org\b/.test(visible(out)), `${label}: a pingable @handle survived`);
  if (columns !== undefined) {
    for (const line of out.split('\n')) {
      const w = stringWidth(line);
      assert.ok(w <= columns, `${label}: line of ${w} cells exceeds ${columns}: ${JSON.stringify(visible(line).slice(0, 120))}`);
    }
  }
  // 10 KB of repository text is capped, never printed whole.
  assert.ok(!visible(out).includes('x'.repeat(2100)), `${label}: a 10 KB subject was printed whole`);
}

describe('RA-21 · hostile repository text renders inert', () => {
  const fixtures = hostileFixtures();
  for (const command of COMMANDS) {
    it(`${command}: rich at 40, 80 and 120 columns (truecolor, links on) and screen-reader mode`, () => {
      const view = viewFor(fixtures, command, { ...FIXED, remoteUrl: HONO_REMOTE });
      for (const columns of [40, 80, 120]) {
        const caps = capsFor({ columns, env: { COLORTERM: 'truecolor', TERM_PROGRAM: 'iTerm.app' } });
        assert.equal(caps.links, true);
        assertInert(`${command} rich ${columns}`, renderRichView(view, caps), columns);
      }
      for (const ambiguousWide of [false, true]) {
        const caps = capsFor({ columns: 80, env: ambiguousWide ? { LANG: 'ja_JP.UTF-8' } : {} });
        assertInert(`${command} rich ambiguous-wide=${ambiguousWide}`, renderRichView(view, caps), 80);
      }
      const sr = renderRichView(view, capsFor({ flags: { screenReader: true } }));
      assert.ok(!sr.includes(ESC), `${command} screen reader: escape sequences`);
      assertInert(`${command} screen reader`, sr, undefined);
      // In a path (an identifier), every zero-width character is a visible escape.
      const subjectLines = sr.split('\n').filter((l) => / subject \d \(file\): /.test(l) && l.includes('zero'));
      assert.ok(subjectLines.length > 0, `${command}: a hostile path is a subject`);
      for (const l of subjectLines) assert.ok(l.includes('zero\\u{200b}width\\u{200c}\\u{200d}\\u{2060}\\u{feff}'), l.slice(0, 200));
      // Screen-reader output is one fact per line: injected newlines never start a fake line.
      for (const line of sr.split('\n').filter(Boolean)) {
        assert.match(line, /^(Repo Archaeology run|Run started|Cut |Findings|Finding |Receipt |Metric |Warning: |Next step: |End of results)/, `${command}: unexpected line ${JSON.stringify(line.slice(0, 80))}`);
      }
    });
  }

  it('a 2 KB path is middle-truncated in rich output and printed in full for screen readers', () => {
    const view = viewFor(fixtures, 'explain', FIXED);
    const rich = visible(renderRichView(view, capsFor({ columns: 80 })));
    assert.ok(rich.includes('…'), 'path truncated with an ellipsis');
    const sr = renderRichView(view, capsFor({ flags: { screenReader: true } }));
    assert.ok(sr.includes('deep/'.repeat(300)), 'the screen-reader subject line carries the full path');
  });
});
