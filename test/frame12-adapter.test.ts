/**
 * RA-21 · adapter units: Repo Archaeology result objects → `@frame12/terminal` snapshots.
 * Inputs are the recorded hono fixtures (`test/fixtures/hono/`, 61f7c59) plus small edits.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateSnapshot } from '@frame12/terminal';
import type { DiffResult, Suggestion } from '../src/commands/diff.js';
import {
  diffToRichView,
  explainToRichView,
  fileToRichView,
  pairId,
  relationOf,
  scanToRichView,
  trackRecordSentence,
} from '../src/report/frame12-terminal.js';
import { DISCLAIMER, formatTrackRecordLine } from '../src/report/views.js';
import { COMMANDS, FIXED, HONO_REMOTE, loadHono, SCAN_DEFAULTS, viewFor } from './rich-helpers.js';

const hono = loadHono();

describe('RA-21 · frame12-terminal adapter', () => {
  it('produces contract-valid snapshots for every command', () => {
    for (const command of COMMANDS) {
      const { snapshot } = viewFor(hono, command);
      const result = validateSnapshot(snapshot);
      assert.ok(result.ok, `${command}: ${JSON.stringify(result.ok ? [] : result.issues)}`);
      assert.equal(snapshot.status, 'completed');
      assert.equal(snapshot.runId, `repo-archaeology-${command}`);
      assert.equal(snapshot.startedAt, FIXED.startedAt);
    }
  });

  it('is pure: the same input gives the same snapshot, and the input is not mutated', () => {
    const before = JSON.stringify(hono);
    for (const command of COMMANDS) {
      assert.deepEqual(viewFor(hono, command), viewFor(hono, command));
    }
    assert.equal(JSON.stringify(hono), before);
  });

  describe('diff', () => {
    const { snapshot, nextSteps } = diffToRichView(hono.diff, FIXED);

    it('has one finding per suggestion, in order, with the ids FRAME/12 recorded for this fixture', () => {
      assert.equal(snapshot.findings.length, hono.diff.suggestions.length);
      // `examples/repo-archaeology/fixtures/hono-61f7c59.f12rec` in FRAME/12 (terminal@0.1.0).
      assert.deepEqual(
        snapshot.findings.map((f) => f.id),
        ['pair-e9d61976', 'pair-ee66c335', 'pair-7c78e775'],
      );
      hono.diff.suggestions.forEach((s, i) => {
        const f = snapshot.findings[i]!;
        assert.equal(f.title, `${s.to} usually changes with ${s.from}`);
        assert.deepEqual(f.subject, [
          { kind: 'file', label: s.from },
          { kind: 'file', label: s.to },
        ]);
        assert.equal(f.status, 'review');
      });
      assert.deepEqual(
        snapshot.findings.map((f) => f.prominence),
        ['hero', 'primary', 'primary'],
      );
    });

    it('uses the confidence and its Wilson interval as strength', () => {
      hono.diff.suggestions.forEach((s, i) => {
        assert.deepEqual(snapshot.findings[i]!.strength, {
          value: s.confidence,
          low: s.interval.low,
          high: s.interval.high,
          label: 'co-change confidence (95% interval)',
        });
      });
    });

    it('maps relationships to relations (ghost, direct, indirect) and gives the others no connector', () => {
      assert.equal(relationOf('ghost'), 'history-only');
      assert.equal(relationOf('direct'), 'direct');
      assert.equal(relationOf('indirect'), 'indirect');
      assert.equal(relationOf('unknown'), undefined);
      assert.equal(relationOf('test'), undefined);
      hono.diff.suggestions.forEach((s, i) => {
        assert.equal(snapshot.findings[i]!.relation, relationOf(s.relationship));
      });
      // The relationship kind is still stated in words.
      assert.match(snapshot.findings[0]!.summary!, /^Test link: a test and the code it covers\./);
      assert.match(snapshot.findings[2]!.summary!, /^Import link: /);
    });

    it('turns evidence commits into receipts (dates as midnight UTC, subjects as notes)', () => {
      hono.diff.suggestions.forEach((s, i) => {
        assert.deepEqual(
          snapshot.findings[i]!.receipts,
          s.evidence.map((e) => ({ kind: 'commit', value: e.hash, at: `${e.date}T00:00:00.000Z`, note: e.subject })),
        );
      });
    });

    it('links receipts only for a trusted remote', () => {
      const linked = diffToRichView(hono.diff, { ...FIXED, remoteUrl: HONO_REMOTE }).snapshot;
      const r = linked.findings[0]!.receipts![0]!;
      assert.equal(r.href, `https://github.com/honojs/hono/commit/${r.value}`);
      for (const remote of ['https://evil.example.com/a/b.git', 'http://github.com/honojs/hono.git', 'https://user:pw@github.com/a/b.git']) {
        const untrusted = diffToRichView(hono.diff, { ...FIXED, remoteUrl: remote }).snapshot;
        assert.equal(untrusted.findings[0]!.receipts![0]!.href, undefined, remote);
      }
    });

    it('reports the counts the classic output shows as metrics', () => {
      const m = Object.fromEntries(snapshot.metrics.map((x) => [x.name, x.value]));
      assert.equal(m['commits-analyzed'], hono.diff.meta.commitsAnalyzed);
      assert.equal(m['changed-files'], hono.diff.changed.length);
      assert.equal(m['changed-without-history'], hono.diff.changed.filter((c) => !c.hasHistory).length);
      assert.equal(m.suggestions, hono.diff.suggestions.length);
      assert.equal(m['sweeps-skipped'], hono.diff.meta.sweepsSkipped);
      assert.equal(m['reverts-skipped'], hono.diff.meta.revertsSkipped);
    });

    it('offers explain commands for the top findings and keeps the disclaimer', () => {
      assert.equal(nextSteps.length, 3);
      assert.match(nextSteps[0]!.command, /^npx repo-archaeology explain --head 61f7c59e50244ab4d2dd83c151928cf7ea448510 --base bcfd02bb50fb015587aac7fe1745b5b2b61361ec src\/helper\/ssg\/ssg\.test\.tsx src\/helper\/ssg\/index\.ts$/);
      assert.equal(nextSteps[0]!.description, 'Show the shared commits behind F-01.');
      assert.ok(snapshot.warnings.includes(DISCLAIMER));
    });

    it('says why there is nothing to show, without inventing findings', () => {
      const silent: DiffResult = {
        ...hono.diff,
        suggestions: [],
        silence: {
          primaryReason: 'filtered_by_thresholds',
          reasons: ['filtered_by_thresholds'],
          changedFiles: 16,
          changedWithHistory: 14,
          changedInsufficientHistory: 0,
          rawCompanions: 40,
          qualifyingCompanions: 0,
          touchedCompanions: 3,
          filteredByThreshold: 37,
          filteredByKind: 0,
          deletedCompanions: 0,
          shallowHistory: false,
          limitedHistory: false,
          commitsAnalyzed: 2774,
          details: ['37 companions were below the thresholds (requires ≥3 shared and ≥40% confidence).'],
        },
      };
      const v = diffToRichView(silent, FIXED).snapshot;
      assert.equal(v.findings.length, 0);
      assert.ok(v.warnings.some((w) => w.startsWith('No suggestions after evaluating 14 files')));
      assert.ok(v.warnings.some((w) => w.startsWith('Silence means no untouched file met')));
      assert.ok(!v.warnings.includes(DISCLAIMER));
      const empty = diffToRichView({ ...hono.diff, base: undefined, changed: [], suggestions: [] }, FIXED);
      assert.deepEqual(empty.snapshot.findings, []);
      assert.ok(empty.snapshot.warnings.includes('No uncommitted changes.'));
      assert.equal(empty.nextSteps[0]!.command, 'npx repo-archaeology diff --base main');
    });
  });

  // Repo Archaeology's shared sentence (RA-06), the same words classic and Markdown print.
  describe('track record (activity, never accuracy)', () => {
    const base = hono.diff.suggestions[0]!;
    const sentence = (trackRecord: Suggestion['trackRecord']) => trackRecordSentence({ ...base, trackRecord });

    it('words a fired record as counts, in the same words as classic and Markdown', () => {
      assert.equal(trackRecordSentence(base), 'Before: 5 times this changed without index.ts; it changed within 48 h after 0 (not proof those were fixes).');
      assert.equal(trackRecordSentence(base), formatTrackRecordLine(base)!.text);
      assert.equal(
        sentence({ ...(base.trackRecord as Extract<Suggestion['trackRecord'], { confirmed: number }>), fired: 4, confirmed: 3 }),
        'Before: 4 times this changed without index.ts; it changed within 48 h after 3 (small sample; not proof those were fixes).',
      );
    });

    it('handles fired = 0 (never fired)', () => {
      assert.equal(
        sentence({ fired: 0, reason: 'never_fired', windowHours: 48, evaluated: { from: '2025-07-29', to: '2026-11-04', commits: 555, trainingCommits: 2219 } }),
        'No completed earlier triggers in the last 555 commits.',
      );
      assert.equal(
        sentence({ fired: 0, reason: 'never_fired', triggers: 0, windowHours: 48, evaluated: { from: '2025-07-29', to: '2026-11-04', commits: 555, trainingCommits: 2219 } }),
        'No earlier triggers in the last 555 commits.',
      );
      // The wire contract allows `never_fired` with nothing but `fired` and `reason`: no window to report.
      assert.equal(sentence({ fired: 0, reason: 'never_fired' }), undefined);
    });

    it('prints nothing for limited_history or an absent record, as classic does', () => {
      assert.equal(sentence({ reason: 'limited_history' }), undefined);
      assert.equal(sentence(undefined), undefined);
      const limited = diffToRichView({ ...hono.diff, suggestions: [{ ...base, trackRecord: { reason: 'limited_history' } }] }, FIXED);
      assert.doesNotMatch(limited.snapshot.findings[0]!.summary!, /Before:|triggers/);
    });

    it('never uses accuracy-type wording (RA-06)', () => {
      for (const s of hono.diff.suggestions) {
        const text = trackRecordSentence(s) ?? '';
        assert.doesNotMatch(text, /accura|correct|chance|precision/i, text);
      }
      for (const command of COMMANDS) {
        for (const f of viewFor(hono, command).snapshot.findings) assert.doesNotMatch(f.summary ?? '', /accura|correct|chance/i);
      }
    });

    it('is part of the finding summary', () => {
      const f = diffToRichView(hono.diff, FIXED).snapshot.findings;
      assert.ok(f[0]!.summary!.endsWith(trackRecordSentence(hono.diff.suggestions[0]!)!));
    });
  });

  describe('scan', () => {
    const { snapshot, nextSteps } = scanToRichView(hono.scan, SCAN_DEFAULTS, FIXED);

    it('keeps the order and counts of the previous rich output: families, then relationships', () => {
      const families = hono.scan.families;
      assert.ok(families.length > 0, 'the hono fixture has finding families');
      assert.equal(snapshot.findings.length, families.length + hono.scan.relationships.length);
      families.forEach((fam, i) => {
        const f = snapshot.findings[i]!;
        assert.match(f.id, /^family-[0-9a-f]{8}$/);
        assert.equal(f.title, `${fam.label}: ${fam.members.length} related implementations`);
        assert.deepEqual(f.subject.map((s) => s.label), fam.members.map((m) => m.path));
        assert.equal(f.relation, undefined, 'a family has no pairwise connector');
        assert.deepEqual(f.receipts!.map((r) => r.value), fam.evidence.map((e) => e.hash));
      });
      hono.scan.relationships.forEach((r, i) => {
        const f = snapshot.findings[families.length + i]!;
        assert.equal(f.id, pairId(r.from, r.to));
        assert.equal(f.relation, relationOf(r.relationship));
      });
      // Prominence is monotonic in that order, so the package's reading order keeps it.
      const rank = { hero: 0, primary: 1, secondary: 2 };
      const ranks = snapshot.findings.map((f) => rank[f.prominence]);
      assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
      assert.equal(snapshot.findings[0]!.prominence, 'hero');
    });

    it('reports per-kind counts and points the explain commands at relationship frames', () => {
      const m = Object.fromEntries(snapshot.metrics.map((x) => [x.name, x.value]));
      for (const k of ['ghost', 'unknown', 'indirect', 'direct', 'test'] as const) assert.equal(m[`kind-${k}`], hono.scan.counts[k]);
      assert.equal(m.families, hono.scan.families.length);
      assert.equal(m['relationships-shown'], hono.scan.relationships.length);
      const firstRelFrame = hono.scan.families.length + 1;
      assert.ok(nextSteps.every((s) => s.command.startsWith('npx repo-archaeology explain ')));
      assert.equal(nextSteps.length, Math.max(0, 3 - hono.scan.families.length));
      if (nextSteps[0]) assert.equal(nextSteps[0].description, `Show the shared commits behind F-${String(firstRelFrame).padStart(2, '0')}.`);
    });

    it('the bare command adds the no-history note and the map as a next step', () => {
      const bare = scanToRichView(hono.scan, SCAN_DEFAULTS, FIXED, { changedWithoutHistory: 2, bare: true });
      assert.ok(bare.snapshot.warnings.includes('2 changed files had no usable history; showing repository-wide relationships instead.'));
      assert.deepEqual(bare.nextSteps.at(-1), { command: 'npx repo-archaeology map', description: 'Explore the interactive view.' });
    });

    it('an empty scan has no findings and says how to widen it', () => {
      const empty = scanToRichView(
        { ...hono.scan, counts: { ghost: 0, unknown: 0, indirect: 0, direct: 0, test: 0 }, relationships: [], families: [] },
        SCAN_DEFAULTS,
        FIXED,
      );
      assert.equal(empty.snapshot.findings.length, 0);
      assert.ok(empty.snapshot.warnings.includes('Try lowering --min-shared (now 3) or --min-confidence (now 40%).'));
    });
  });

  describe('file', () => {
    const { snapshot } = fileToRichView(hono.file, FIXED);

    it('has one finding per partner, with the file as subject 1', () => {
      assert.equal(snapshot.findings.length, hono.file.companions.length);
      hono.file.companions.forEach((c, i) => {
        const f = snapshot.findings[i]!;
        assert.equal(f.id, pairId(hono.file.path, c.to));
        assert.equal(f.subject[0]!.label, hono.file.path);
        assert.equal(f.subject[1]!.label, c.to);
        assert.equal(f.strength!.value, c.confidence);
        assert.equal(f.status, c.wouldAlert ? 'review' : 'info');
        assert.match(f.summary!, c.wouldAlert ? /Strong enough for diff to flag it/ : /Below diff's alert threshold/);
      });
    });

    it('reports churn, owners and partner counts as metrics', () => {
      const m = Object.fromEntries(snapshot.metrics.map((x) => [x.name, x.value]));
      assert.equal(m.changes, `${hono.file.changes} commits`);
      assert.equal(m.companions, hono.file.companions.length);
      assert.equal(m['last-changed'], hono.file.lastChanged);
    });
  });

  describe('explain', () => {
    const { snapshot } = explainToRichView(hono.explain, FIXED);
    const ce = hono.explain.counterexamples;

    it('has one finding for the pair with shared commits, then counterexamples, as receipts', () => {
      assert.equal(snapshot.findings.length, 1);
      const f = snapshot.findings[0]!;
      assert.equal(f.id, pairId(hono.explain.from, hono.explain.to));
      assert.equal(f.prominence, 'hero');
      assert.deepEqual(f.strength, {
        value: hono.explain.confidence,
        low: hono.explain.interval.low,
        high: hono.explain.interval.high,
        label: 'co-change confidence (95% interval)',
      });
      assert.deepEqual(
        f.receipts!.map((r) => r.value),
        [...hono.explain.sharedCommits, ...ce.fromWithoutTo, ...ce.toWithoutFrom].map((c) => c.hash),
      );
      assert.match(f.receipts![0]!.note!, new RegExp(`\\(${hono.explain.sharedCommits[0]!.author}\\)$`));
      assert.match(f.receipts![hono.explain.sharedCommits.length]!.note!, /^counterexample, /);
    });

    it('reports counterexample counts as metrics', () => {
      const m = Object.fromEntries(snapshot.metrics.map((x) => [x.name, x.value]));
      assert.equal(m['from-without-to'], ce.fromWithoutToTotal);
      assert.equal(m['to-without-from'], ce.toWithoutFromTotal);
      assert.equal(m.shared, hono.explain.shared);
      assert.equal(m['from-changes'], hono.explain.fromChanges);
      assert.equal(m['to-changes'], hono.explain.toChanges);
    });

    it('states bounds and the explain disclaimer as warnings', () => {
      const bounded = explainToRichView(
        {
          ...hono.explain,
          sharedCommits: [],
          bounds: { ...hono.explain.bounds, commitsTruncated: true, contextClamped: true, outputTruncated: true, timedOut: true },
        },
        FIXED,
      ).snapshot;
      assert.ok(bounded.warnings.includes('No shared commits shown (patch retrieval reached time budget).'));
      assert.ok(
        bounded.warnings.includes(
          `Bounds applied: showing up to ${hono.explain.bounds.maxCommits} shared commits; context lines clamped to ${hono.explain.bounds.contextLines}; patch output capped at ${hono.explain.bounds.maxTotalPatchLines} lines; patch retrieval reached time budget.`,
        ),
      );
      assert.equal(bounded.warnings.at(-1), hono.explain.disclaimer);
    });
  });

  it('labels weighted confidence and keeps the raw interval', () => {
    const s = { ...hono.diff.suggestions[0]!, weighted: true, weighting: 'recency' as const, confidence: 0.7 };
    const f = diffToRichView({ ...hono.diff, suggestions: [s] }, FIXED).snapshot.findings[0]!;
    assert.equal(f.strength!.label, 'recency-weighted co-change confidence (raw 95% interval)');
    assert.match(f.summary!, /\(70% recency-weighted, raw 95% interval 36-66%\)/);
  });

  it('states verdicts and silences expected ones', () => {
    const s = { ...hono.diff.suggestions[0]!, verdict: { kind: 'expected' as const, reason: 'generated together', by: 'platform-team' } };
    const f = diffToRichView({ ...hono.diff, suggestions: [s] }, FIXED).snapshot.findings[0]!;
    assert.equal(f.status, 'info');
    assert.match(f.summary!, /Verdict: expected \(silenced\) \(by platform-team\): generated together\./);
  });
});
