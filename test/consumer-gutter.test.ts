/**
 * Consumer contract guard for Gutter (`lbrodie11/gutter`).
 *
 * Gutter's GitHub Action and co-change review panel (prompts `GU-01`, `GU-05`, and
 * downstream Gutter workflows that invoke `npx repo-archaeology@^0.3.0`) parse the
 * `schemaVersion: 1` JSON payloads from `repo-archaeology diff --json` (and `--json-out`)
 * and `repo-archaeology backtest --json`.
 *
 * DO NOT rename, remove, or retype any field, relationship kind, silence reason code,
 * or backtest strategy name asserted in this file without:
 *   1. Coordinating a matching consumer release in `lbrodie11/gutter`, and
 *   2. Following the breaking-change versioning policy in `docs/json.md`.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { sanitizeGitEnv } from '../scripts/schema-validator.mjs';
import { FixtureRepo } from './helpers.js';

const ROOT_DIR = join(import.meta.dirname, '..');
const CLI = join(ROOT_DIR, 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');

const GUTTER_RELATIONSHIP_KINDS = [
  'ghost',
  'unknown',
  'indirect',
  'direct',
  'test',
] as const;

const GUTTER_SILENCE_REASONS = [
  'no_changed_files',
  'limited_repo_history',
  'no_history_for_changed_files',
  'no_cochange_partners',
  'all_companions_touched',
  'silenced_by_verdicts',
  'filtered_by_thresholds',
  'filtered_by_kinds',
] as const;

const GUTTER_BACKTEST_STRATEGIES = [
  'co-change',
  'popularity, same changes',
] as const;

function runCli(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, ['--import', TSX, CLI, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    env: sanitizeGitEnv(process.env, { NO_COLOR: '1' }),
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function checkWilsonInterval(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(
      `Gutter contract error at '${path}': expected object, got ${JSON.stringify(value)}`,
    );
    return;
  }
  if (!isFiniteNumber(value.low) || value.low < 0 || value.low > 1) {
    errors.push(
      `Gutter contract error at '${path}.low': expected number in [0, 1], got ${JSON.stringify(value.low)}`,
    );
  }
  if (!isFiniteNumber(value.high) || value.high < 0 || value.high > 1) {
    errors.push(
      `Gutter contract error at '${path}.high': expected number in [0, 1], got ${JSON.stringify(value.high)}`,
    );
  }
  if (isFiniteNumber(value.low) && isFiniteNumber(value.high) && value.low > value.high) {
    errors.push(
      `Gutter contract error at '${path}': expected low <= high, got ${value.low} > ${value.high}`,
    );
  }
}

function checkCommonEnvelopeAndMeta(payload: Record<string, unknown>, errors: string[]): void {
  if (payload.schemaVersion !== 1) {
    errors.push(
      `Gutter contract error at 'schemaVersion': expected 1, got ${JSON.stringify(payload.schemaVersion)}`,
    );
  }

  if (!isRecord(payload.tool)) {
    errors.push(`Gutter contract error at 'tool': expected object, got ${typeof payload.tool}`);
  } else {
    if (typeof payload.tool.name !== 'string' || payload.tool.name.length === 0) {
      errors.push(
        `Gutter contract error at 'tool.name': expected non-empty string, got ${JSON.stringify(payload.tool.name)}`,
      );
    }
    if (typeof payload.tool.version !== 'string' || payload.tool.version.length === 0) {
      errors.push(
        `Gutter contract error at 'tool.version': expected non-empty string, got ${JSON.stringify(payload.tool.version)}`,
      );
    }
  }

  if (!isRecord(payload.meta)) {
    errors.push(`Gutter contract error at 'meta': expected object, got ${typeof payload.meta}`);
  } else {
    if (!isFiniteNumber(payload.meta.commitsAnalyzed)) {
      errors.push(
        `Gutter contract error at 'meta.commitsAnalyzed': expected number, got ${JSON.stringify(payload.meta.commitsAnalyzed)}`,
      );
    }
    if (!isStringArray(payload.meta.warnings)) {
      errors.push(
        `Gutter contract error at 'meta.warnings': expected string[], got ${JSON.stringify(payload.meta.warnings)}`,
      );
    }
  }
}

function validateGutterDiffContract(payload: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(payload)) {
    return [`Gutter contract error at '$': expected object, got ${typeof payload}`];
  }

  checkCommonEnvelopeAndMeta(payload, errors);

  if (!isFiniteNumber(payload.totalSuggestions)) {
    errors.push(
      `Gutter contract error at 'totalSuggestions': expected number, got ${JSON.stringify(payload.totalSuggestions)}`,
    );
  }

  if (!Array.isArray(payload.suggestions)) {
    errors.push(
      `Gutter contract error at 'suggestions': expected array, got ${JSON.stringify(payload.suggestions)}`,
    );
  } else {
    payload.suggestions.forEach((item, idx) => {
      const prefix = `suggestions[${idx}]`;
      if (!isRecord(item)) {
        errors.push(`Gutter contract error at '${prefix}': expected object`);
        return;
      }

      const stringFields = ['from', 'to', 'why'] as const;
      for (const field of stringFields) {
        if (typeof item[field] !== 'string') {
          errors.push(
            `Gutter contract error at '${prefix}.${field}': expected string, got ${JSON.stringify(item[field])}`,
          );
        }
      }

      if (
        typeof item.relationship !== 'string' ||
        !(GUTTER_RELATIONSHIP_KINDS as readonly string[]).includes(item.relationship)
      ) {
        errors.push(
          `Gutter contract error at '${prefix}.relationship': expected one of ${GUTTER_RELATIONSHIP_KINDS.join('|')}, got ${JSON.stringify(item.relationship)}`,
        );
      }

      const numberFields = ['shared', 'fromChanges', 'toChanges', 'confidence', 'score'] as const;
      for (const field of numberFields) {
        if (!isFiniteNumber(item[field])) {
          errors.push(
            `Gutter contract error at '${prefix}.${field}': expected number, got ${JSON.stringify(item[field])}`,
          );
        }
      }

      checkWilsonInterval(item.interval, `${prefix}.interval`, errors);
      checkWilsonInterval(item.reverseInterval, `${prefix}.reverseInterval`, errors);

      if ('lastTogether' in item && item.lastTogether !== undefined) {
        if (typeof item.lastTogether !== 'string' || item.lastTogether.length === 0) {
          errors.push(
            `Gutter contract error at '${prefix}.lastTogether': expected optional non-empty string, got ${JSON.stringify(item.lastTogether)}`,
          );
        }
      }

      if (!Array.isArray(item.evidence)) {
        errors.push(
          `Gutter contract error at '${prefix}.evidence': expected array, got ${JSON.stringify(item.evidence)}`,
        );
      } else {
        if (isFiniteNumber(item.shared) && item.shared > 0 && item.evidence.length === 0) {
          errors.push(
            `Gutter contract error at '${prefix}.evidence': expected at least 1 evidence commit when shared > 0, got []`,
          );
        }
        item.evidence.forEach((ev, evIdx) => {
          const evPrefix = `${prefix}.evidence[${evIdx}]`;
          if (!isRecord(ev)) {
            errors.push(`Gutter contract error at '${evPrefix}': expected object`);
            return;
          }
          for (const evField of ['hash', 'date', 'author', 'subject'] as const) {
            if (typeof ev[evField] !== 'string') {
              errors.push(
                `Gutter contract error at '${evPrefix}.${evField}': expected string, got ${JSON.stringify(ev[evField])}`,
              );
            }
          }
        });
      }

      if (
        'alsoLinkedFrom' in item &&
        item.alsoLinkedFrom !== undefined &&
        !isStringArray(item.alsoLinkedFrom)
      ) {
        errors.push(
          `Gutter contract error at '${prefix}.alsoLinkedFrom': expected optional string[], got ${JSON.stringify(item.alsoLinkedFrom)}`,
        );
      }
    });
  }

  if (!Array.isArray(payload.families)) {
    errors.push(
      `Gutter contract error at 'families': expected array, got ${JSON.stringify(payload.families)}`,
    );
  } else {
    payload.families.forEach((fam, idx) => {
      const prefix = `families[${idx}]`;
      if (!isRecord(fam)) {
        errors.push(`Gutter contract error at '${prefix}': expected object`);
        return;
      }

      for (const field of ['id', 'label', 'why'] as const) {
        if (typeof fam[field] !== 'string') {
          errors.push(
            `Gutter contract error at '${prefix}.${field}': expected string, got ${JSON.stringify(fam[field])}`,
          );
        }
      }

      if (!Array.isArray(fam.members) || fam.members.length === 0) {
        errors.push(
          `Gutter contract error at '${prefix}.members': expected non-empty array, got ${JSON.stringify(fam.members)}`,
        );
      } else {
        fam.members.forEach((member, mIdx) => {
          const mPrefix = `${prefix}.members[${mIdx}]`;
          if (!isRecord(member) || typeof member.path !== 'string') {
            errors.push(
              `Gutter contract error at '${mPrefix}.path': expected string, got ${JSON.stringify(isRecord(member) ? member.path : member)}`,
            );
          }
        });
      }

      if (
        'changedMembers' in fam &&
        fam.changedMembers !== undefined &&
        !isStringArray(fam.changedMembers)
      ) {
        errors.push(
          `Gutter contract error at '${prefix}.changedMembers': expected optional string[], got ${JSON.stringify(fam.changedMembers)}`,
        );
      }
    });
  }

  if ('silence' in payload && payload.silence !== undefined) {
    if (!isRecord(payload.silence)) {
      errors.push(
        `Gutter contract error at 'silence': expected optional object, got ${JSON.stringify(payload.silence)}`,
      );
    } else if (
      typeof payload.silence.primaryReason !== 'string' ||
      !(GUTTER_SILENCE_REASONS as readonly string[]).includes(payload.silence.primaryReason)
    ) {
      errors.push(
        `Gutter contract error at 'silence.primaryReason': expected one of ${GUTTER_SILENCE_REASONS.join('|')}, got ${JSON.stringify(payload.silence.primaryReason)}`,
      );
    }
  }

  return errors;
}

function validateGutterBacktestContract(payload: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(payload)) {
    return [`Gutter contract error at '$': expected object, got ${typeof payload}`];
  }

  checkCommonEnvelopeAndMeta(payload, errors);

  if (!isRecord(payload.test)) {
    errors.push(`Gutter contract error at 'test': expected object, got ${JSON.stringify(payload.test)}`);
  } else {
    if (!isFiniteNumber(payload.test.commits)) {
      errors.push(
        `Gutter contract error at 'test.commits': expected number, got ${JSON.stringify(payload.test.commits)}`,
      );
    }
    if (typeof payload.test.from !== 'string') {
      errors.push(
        `Gutter contract error at 'test.from': expected string, got ${JSON.stringify(payload.test.from)}`,
      );
    }
    if (typeof payload.test.to !== 'string') {
      errors.push(
        `Gutter contract error at 'test.to': expected string, got ${JSON.stringify(payload.test.to)}`,
      );
    }
  }

  if (!Array.isArray(payload.strategies)) {
    errors.push(
      `Gutter contract error at 'strategies': expected array, got ${JSON.stringify(payload.strategies)}`,
    );
  } else {
    const seenNames = new Set<string>();
    payload.strategies.forEach((strat, idx) => {
      const prefix = `strategies[${idx}]`;
      if (!isRecord(strat)) {
        errors.push(`Gutter contract error at '${prefix}': expected object`);
        return;
      }
      if (typeof strat.name !== 'string') {
        errors.push(
          `Gutter contract error at '${prefix}.name': expected string, got ${JSON.stringify(strat.name)}`,
        );
      } else {
        seenNames.add(strat.name);
      }
      for (const numField of ['fired', 'precision', 'hitRate'] as const) {
        if (!isFiniteNumber(strat[numField])) {
          errors.push(
            `Gutter contract error at '${prefix}.${numField}': expected number, got ${JSON.stringify(strat[numField])}`,
          );
        }
      }
    });

    for (const requiredStrategy of GUTTER_BACKTEST_STRATEGIES) {
      if (!seenNames.has(requiredStrategy)) {
        errors.push(
          `Gutter contract error at 'strategies': missing required strategy '${requiredStrategy}' (found: ${[...seenNames].join(', ')})`,
        );
      }
    }
  }

  return errors;
}

function assertGutterDiffContract(payload: unknown): void {
  const errors = validateGutterDiffContract(payload);
  assert.deepEqual(
    errors,
    [],
    `Breaking change for consumer Gutter (lbrodie11/gutter) in diff --json contract:\n${errors.join('\n')}`,
  );
}

function assertGutterBacktestContract(payload: unknown): void {
  const errors = validateGutterBacktestContract(payload);
  assert.deepEqual(
    errors,
    [],
    `Breaking change for consumer Gutter (lbrodie11/gutter) in backtest --json contract:\n${errors.join('\n')}`,
  );
}

describe('Gutter consumer contract guard (diff --json & backtest --json)', () => {
  let repo: FixtureRepo;
  let activeDiffJson: Record<string, unknown>;
  let silentDiffJson: Record<string, unknown>;
  let backtestJson: Record<string, unknown>;

  before(() => {
    repo = new FixtureRepo();
    repo.write('src/adapter/bun/serve-static.ts', 'export const bunServe = 0;\n');
    repo.write('src/adapter/deno/serve-static.ts', 'export const denoServe = 0;\n');
    repo.write('src/adapter/cloudflare/serve-static.ts', 'export const cfServe = 0;\n');
    repo.write('src/api.ts', "import { db } from './db';\nexport const api = db;\n");
    repo.write('src/db.ts', 'export const db = 0;\n');
    repo.git('add', '.');
    repo.commit({ message: 'initial setup', author: 'Alice' });

    for (let i = 1; i <= 25; i++) {
      repo.commit({
        message: `feat(serve-static): sync adapter behavior ${i}`,
        author: 'Alice',
        write: {
          'src/adapter/bun/serve-static.ts': `export const bunServe = ${i};\n`,
          'src/adapter/deno/serve-static.ts': `export const denoServe = ${i};\n`,
          'src/adapter/cloudflare/serve-static.ts': `export const cfServe = ${i};\n`,
        },
      });
      if (i % 5 === 0) {
        repo.commit({
          message: `fix(api): update query and db ${i}`,
          author: 'Bob',
          write: {
            'src/api.ts': `import { db } from './db';\nexport const api = db + ${i};\n`,
            'src/db.ts': `export const db = ${i};\n`,
          },
        });
      }
    }

    // 1. Capture silent diff --json (clean working tree -> silence.primaryReason === 'no_changed_files')
    const silentRes = runCli(['diff', '--json'], repo.dir);
    assert.equal(silentRes.code, 0, silentRes.stderr);
    silentDiffJson = JSON.parse(silentRes.stdout) as Record<string, unknown>;

    // 2. Capture active diff --json (modify 1 file of the 3-member family -> suggestions + families)
    repo.write('src/adapter/bun/serve-static.ts', 'export const bunServe = 999;\n');
    const activeRes = runCli(['diff', '--json'], repo.dir);
    assert.equal(activeRes.code, 0, activeRes.stderr);
    activeDiffJson = JSON.parse(activeRes.stdout) as Record<string, unknown>;
    repo.git('checkout', '-q', '--', '.');

    // 3. Capture backtest --json
    const backtestRes = runCli(['backtest', '--json'], repo.dir);
    assert.equal(backtestRes.code, 0, backtestRes.stderr);
    backtestJson = JSON.parse(backtestRes.stdout) as Record<string, unknown>;
  });

  after(() => {
    repo.cleanup();
  });

  it('freezes all diff --json fields, nested suggestion/family shapes, and silence reason codes consumed by Gutter', () => {
    assertGutterDiffContract(activeDiffJson);
    assert.ok(
      Array.isArray(activeDiffJson.suggestions) && activeDiffJson.suggestions.length >= 2,
      'expected fixture diff --json to contain at least 2 suggestions for Gutter validation',
    );
    assert.ok(
      Array.isArray(activeDiffJson.families) && activeDiffJson.families.length >= 1,
      'expected fixture diff --json to contain at least 1 finding family for Gutter validation',
    );

    const firstSuggestion = (activeDiffJson.suggestions as Record<string, unknown>[])[0]!;
    assert.equal(typeof firstSuggestion.lastTogether, 'string');
    assert.ok(Array.isArray(firstSuggestion.evidence) && firstSuggestion.evidence.length >= 1);
    assert.ok(Array.isArray(firstSuggestion.alsoLinkedFrom));

    const firstFamily = (activeDiffJson.families as Record<string, unknown>[])[0]!;
    assert.ok(Array.isArray(firstFamily.members) && firstFamily.members.length >= 3);
    assert.ok(Array.isArray(firstFamily.changedMembers) && firstFamily.changedMembers.length >= 1);

    assertGutterDiffContract(silentDiffJson);
    assert.equal(
      (silentDiffJson.silence as Record<string, unknown>)?.primaryReason,
      'no_changed_files',
    );

    // Order-independent check that schema/common.schema.json preserves every Gutter-expected enum value
    const commonSchema = JSON.parse(
      readFileSync(join(ROOT_DIR, 'schema', 'common.schema.json'), 'utf8'),
    ) as {
      $defs?: {
        Relationship?: { enum?: string[] };
        SilenceReason?: { enum?: string[] };
      };
    };
    const schemaRelationships = new Set(commonSchema.$defs?.Relationship?.enum ?? []);
    for (const kind of GUTTER_RELATIONSHIP_KINDS) {
      assert.ok(
        schemaRelationships.has(kind),
        `Gutter requires Relationship kind '${kind}' to remain in schema/common.schema.json#/$defs/Relationship`,
      );
    }
    const schemaSilenceReasons = new Set(commonSchema.$defs?.SilenceReason?.enum ?? []);
    for (const reason of GUTTER_SILENCE_REASONS) {
      assert.ok(
        schemaSilenceReasons.has(reason),
        `Gutter requires SilenceReason '${reason}' to remain in schema/common.schema.json#/$defs/SilenceReason`,
      );
    }

    for (const reason of GUTTER_SILENCE_REASONS) {
      const clone = structuredClone(silentDiffJson);
      (clone.silence as Record<string, unknown>).primaryReason = reason;
      assertGutterDiffContract(clone);
    }
  });

  it('freezes all backtest --json fields and strategy names consumed by Gutter', () => {
    assertGutterBacktestContract(backtestJson);
    const strategies = backtestJson.strategies as Array<Record<string, unknown>>;
    const names = strategies.map((s) => s.name);
    assert.ok(names.includes('co-change'));
    assert.ok(names.includes('popularity, same changes'));
  });

  describe('negative mutations (fails naming Gutter when any frozen field is removed or retyped)', () => {
    const diffMutations: Array<{
      label: string;
      expectedPath: string;
      expectedDetail?: string;
      mutate: (doc: any) => void;
    }> = [
      {
        label: 'removed schemaVersion',
        expectedPath: 'schemaVersion',
        mutate: (doc) => {
          delete doc.schemaVersion;
        },
      },
      {
        label: 'removed tool.name',
        expectedPath: 'tool.name',
        mutate: (doc) => {
          delete doc.tool.name;
        },
      },
      {
        label: 'removed tool.version',
        expectedPath: 'tool.version',
        mutate: (doc) => {
          delete doc.tool.version;
        },
      },
      {
        label: 'removed meta.commitsAnalyzed',
        expectedPath: 'meta.commitsAnalyzed',
        mutate: (doc) => {
          delete doc.meta.commitsAnalyzed;
        },
      },
      {
        label: 'retyped meta.warnings',
        expectedPath: 'meta.warnings',
        mutate: (doc) => {
          doc.meta.warnings = 'not-an-array';
        },
      },
      {
        label: 'removed totalSuggestions',
        expectedPath: 'totalSuggestions',
        mutate: (doc) => {
          delete doc.totalSuggestions;
        },
      },
      {
        label: 'removed suggestions[0].from',
        expectedPath: 'suggestions[0].from',
        mutate: (doc) => {
          delete doc.suggestions[0].from;
        },
      },
      {
        label: 'removed suggestions[0].to',
        expectedPath: 'suggestions[0].to',
        mutate: (doc) => {
          delete doc.suggestions[0].to;
        },
      },
      {
        label: 'invalid suggestions[0].relationship',
        expectedPath: 'suggestions[0].relationship',
        mutate: (doc) => {
          doc.suggestions[0].relationship = 'renamed_kind';
        },
      },
      {
        label: 'removed suggestions[0].why',
        expectedPath: 'suggestions[0].why',
        mutate: (doc) => {
          delete doc.suggestions[0].why;
        },
      },
      {
        label: 'removed suggestions[0].shared',
        expectedPath: 'suggestions[0].shared',
        mutate: (doc) => {
          delete doc.suggestions[0].shared;
        },
      },
      {
        label: 'removed suggestions[0].fromChanges',
        expectedPath: 'suggestions[0].fromChanges',
        mutate: (doc) => {
          delete doc.suggestions[0].fromChanges;
        },
      },
      {
        label: 'removed suggestions[0].toChanges',
        expectedPath: 'suggestions[0].toChanges',
        mutate: (doc) => {
          delete doc.suggestions[0].toChanges;
        },
      },
      {
        label: 'removed suggestions[0].confidence',
        expectedPath: 'suggestions[0].confidence',
        mutate: (doc) => {
          delete doc.suggestions[0].confidence;
        },
      },
      {
        label: 'removed suggestions[0].score',
        expectedPath: 'suggestions[0].score',
        mutate: (doc) => {
          delete doc.suggestions[0].score;
        },
      },
      {
        label: 'invalid suggestions[0].interval (low > high)',
        expectedPath: 'suggestions[0].interval',
        mutate: (doc) => {
          doc.suggestions[0].interval = { low: 0.9, high: 0.1 };
        },
      },
      {
        label: 'removed suggestions[0].reverseInterval',
        expectedPath: 'suggestions[0].reverseInterval',
        mutate: (doc) => {
          delete doc.suggestions[0].reverseInterval;
        },
      },
      {
        label: 'retyped suggestions[0].lastTogether to number',
        expectedPath: 'suggestions[0].lastTogether',
        mutate: (doc) => {
          doc.suggestions[0].lastTogether = 12345;
        },
      },
      {
        label: 'set suggestions[0].lastTogether to null',
        expectedPath: 'suggestions[0].lastTogether',
        mutate: (doc) => {
          doc.suggestions[0].lastTogether = null;
        },
      },
      {
        label: 'emptied suggestions[0].evidence when shared > 0',
        expectedPath: 'suggestions[0].evidence',
        mutate: (doc) => {
          doc.suggestions[0].evidence = [];
        },
      },
      {
        label: 'removed suggestions[0].evidence[0].hash',
        expectedPath: 'suggestions[0].evidence[0].hash',
        mutate: (doc) => {
          delete doc.suggestions[0].evidence[0].hash;
        },
      },
      {
        label: 'removed suggestions[0].evidence[0].date',
        expectedPath: 'suggestions[0].evidence[0].date',
        mutate: (doc) => {
          delete doc.suggestions[0].evidence[0].date;
        },
      },
      {
        label: 'removed suggestions[0].evidence[0].author',
        expectedPath: 'suggestions[0].evidence[0].author',
        mutate: (doc) => {
          delete doc.suggestions[0].evidence[0].author;
        },
      },
      {
        label: 'removed suggestions[0].evidence[0].subject',
        expectedPath: 'suggestions[0].evidence[0].subject',
        mutate: (doc) => {
          delete doc.suggestions[0].evidence[0].subject;
        },
      },
      {
        label: 'retyped suggestions[0].alsoLinkedFrom',
        expectedPath: 'suggestions[0].alsoLinkedFrom',
        mutate: (doc) => {
          doc.suggestions[0].alsoLinkedFrom = [42];
        },
      },
      {
        label: 'removed families[0].id',
        expectedPath: 'families[0].id',
        mutate: (doc) => {
          delete doc.families[0].id;
        },
      },
      {
        label: 'removed families[0].label',
        expectedPath: 'families[0].label',
        mutate: (doc) => {
          delete doc.families[0].label;
        },
      },
      {
        label: 'removed families[0].why',
        expectedPath: 'families[0].why',
        mutate: (doc) => {
          delete doc.families[0].why;
        },
      },
      {
        label: 'removed families[0].members[0].path',
        expectedPath: 'families[0].members[0].path',
        mutate: (doc) => {
          delete doc.families[0].members[0].path;
        },
      },
      {
        label: 'retyped families[0].changedMembers',
        expectedPath: 'families[0].changedMembers',
        mutate: (doc) => {
          doc.families[0].changedMembers = 'not-an-array';
        },
      },
      {
        label: 'unknown silence.primaryReason',
        expectedPath: 'silence.primaryReason',
        mutate: (doc) => {
          doc.silence = { primaryReason: 'unknown_future_reason' };
        },
      },
    ];

    for (const testCase of diffMutations) {
      it(`diff --json rejects ${testCase.label}`, () => {
        const mutated = structuredClone(activeDiffJson);
        testCase.mutate(mutated);
        const errors = validateGutterDiffContract(mutated);
        assert.ok(errors.length > 0, `expected validator to reject ${testCase.label}`);
        assert.ok(
          errors.some(
            (e) =>
              e.includes('Gutter') &&
              e.includes(`'${testCase.expectedPath}'`) &&
              (!testCase.expectedDetail || e.includes(testCase.expectedDetail)),
          ),
          `expected error for ${testCase.label} to mention 'Gutter' and '${testCase.expectedPath}', got: ${errors.join('; ')}`,
        );
        assert.throws(
          () => assertGutterDiffContract(mutated),
          (err: unknown) =>
            err instanceof Error &&
            err.message.includes('Gutter') &&
            err.message.includes(`'${testCase.expectedPath}'`),
        );
      });
    }

    const backtestMutations: Array<{
      label: string;
      expectedPath: string;
      expectedDetail?: string;
      mutate: (doc: any) => void;
    }> = [
      {
        label: 'removed test.commits',
        expectedPath: 'test.commits',
        mutate: (doc) => {
          delete doc.test.commits;
        },
      },
      {
        label: 'removed test.from',
        expectedPath: 'test.from',
        mutate: (doc) => {
          delete doc.test.from;
        },
      },
      {
        label: 'removed test.to',
        expectedPath: 'test.to',
        mutate: (doc) => {
          delete doc.test.to;
        },
      },
      {
        label: 'removed strategies[0].name',
        expectedPath: 'strategies[0].name',
        mutate: (doc) => {
          delete doc.strategies[0].name;
        },
      },
      {
        label: 'removed strategies[0].fired',
        expectedPath: 'strategies[0].fired',
        mutate: (doc) => {
          delete doc.strategies[0].fired;
        },
      },
      {
        label: 'removed strategies[0].precision',
        expectedPath: 'strategies[0].precision',
        mutate: (doc) => {
          delete doc.strategies[0].precision;
        },
      },
      {
        label: 'removed strategies[0].hitRate',
        expectedPath: 'strategies[0].hitRate',
        mutate: (doc) => {
          delete doc.strategies[0].hitRate;
        },
      },
      {
        label: 'removed co-change strategy',
        expectedPath: 'strategies',
        expectedDetail: "missing required strategy 'co-change'",
        mutate: (doc) => {
          doc.strategies = doc.strategies.filter((s: { name: string }) => s.name !== 'co-change');
        },
      },
      {
        label: 'removed popularity strategy',
        expectedPath: 'strategies',
        expectedDetail: "missing required strategy 'popularity, same changes'",
        mutate: (doc) => {
          doc.strategies = doc.strategies.filter(
            (s: { name: string }) => s.name !== 'popularity, same changes',
          );
        },
      },
    ];

    for (const testCase of backtestMutations) {
      it(`backtest --json rejects ${testCase.label}`, () => {
        const mutated = structuredClone(backtestJson);
        testCase.mutate(mutated);
        const errors = validateGutterBacktestContract(mutated);
        assert.ok(errors.length > 0, `expected backtest validator to reject ${testCase.label}`);
        assert.ok(
          errors.some(
            (e) =>
              e.includes('Gutter') &&
              e.includes(`'${testCase.expectedPath}'`) &&
              (!testCase.expectedDetail || e.includes(testCase.expectedDetail)),
          ),
          `expected error for ${testCase.label} to mention 'Gutter' and '${testCase.expectedPath}', got: ${errors.join('; ')}`,
        );
        assert.throws(
          () => assertGutterBacktestContract(mutated),
          (err: unknown) =>
            err instanceof Error &&
            err.message.includes('Gutter') &&
            err.message.includes(`'${testCase.expectedPath}'`),
        );
      });
    }
  });
});
