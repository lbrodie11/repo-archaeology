/**
 * Consumer contract guard for Gutter (`lbrodie11/gutter`).
 *
 * Gutter's GitHub Action and co-change review panel consume the `schemaVersion: 1`
 * JSON output emitted by `repo-archaeology diff --json` (and `--json-out`) and
 * `repo-archaeology backtest --json`.
 *
 * DO NOT rename, remove, or retype any field, enum value, or strategy name
 * asserted in this file without:
 *   1. Coordinating a matching consumer release in `lbrodie11/gutter`, and
 *   2. Following the breaking-change versioning policy in `docs/json.md`.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { FixtureRepo } from './helpers.js';

const ROOT_DIR = join(import.meta.dirname, '..');
const CLI = join(ROOT_DIR, 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');

export const GUTTER_RELATIONSHIP_KINDS = [
  'ghost',
  'unknown',
  'indirect',
  'direct',
  'test',
] as const;

export const GUTTER_SILENCE_REASONS = [
  'no_changed_files',
  'limited_repo_history',
  'no_history_for_changed_files',
  'no_cochange_partners',
  'all_companions_touched',
  'filtered_by_thresholds',
  'filtered_by_kinds',
] as const;

export const GUTTER_BACKTEST_STRATEGIES = [
  'co-change',
  'popularity, same changes',
] as const;

function runCli(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, ['--import', TSX, CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
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

export function validateGutterDiffContract(payload: unknown): string[] {
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

      if ('lastTogether' in item && item.lastTogether !== undefined && typeof item.lastTogether !== 'string') {
        errors.push(
          `Gutter contract error at '${prefix}.lastTogether': expected optional string, got ${JSON.stringify(item.lastTogether)}`,
        );
      }

      if (!Array.isArray(item.evidence)) {
        errors.push(
          `Gutter contract error at '${prefix}.evidence': expected array, got ${JSON.stringify(item.evidence)}`,
        );
      } else {
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

      if (!Array.isArray(fam.members)) {
        errors.push(
          `Gutter contract error at '${prefix}.members': expected array, got ${JSON.stringify(fam.members)}`,
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

export function validateGutterBacktestContract(payload: unknown): string[] {
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

    // Silent diff --json contract and reason code alignment with schema/common.schema.json
    assertGutterDiffContract(silentDiffJson);
    assert.equal(
      (silentDiffJson.silence as Record<string, unknown>)?.primaryReason,
      'no_changed_files',
    );

    const commonSchema = JSON.parse(
      readFileSync(join(ROOT_DIR, 'schema', 'common.schema.json'), 'utf8'),
    ) as {
      $defs?: {
        Relationship?: { enum?: string[] };
        SilenceReason?: { enum?: string[] };
      };
    };
    assert.deepEqual(
      commonSchema.$defs?.Relationship?.enum,
      [...GUTTER_RELATIONSHIP_KINDS],
      'Gutter relationship kinds must stay in sync with schema/common.schema.json#/$defs/Relationship',
    );
    assert.deepEqual(
      commonSchema.$defs?.SilenceReason?.enum,
      [...GUTTER_SILENCE_REASONS],
      'Gutter silence.primaryReason enum must stay in sync with schema/common.schema.json#/$defs/SilenceReason',
    );

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

  it('fails with a message naming Gutter when any frozen field is removed or retyped in-memory', () => {
    const diffMutations: Array<{ label: string; expectedPath: string; mutate: (doc: any) => void }> = [
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
        label: 'retyped suggestions[0].lastTogether',
        expectedPath: 'suggestions[0].lastTogether',
        mutate: (doc) => {
          doc.suggestions[0].lastTogether = 12345;
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
      const mutated = structuredClone(activeDiffJson);
      testCase.mutate(mutated);
      const errors = validateGutterDiffContract(mutated);
      assert.ok(
        errors.length > 0,
        `expected validator to reject ${testCase.label}, but it passed`,
      );
      assert.ok(
        errors.some((e) => e.includes('Gutter') && e.includes(testCase.expectedPath)),
        `expected error for ${testCase.label} to mention 'Gutter' and '${testCase.expectedPath}', got: ${errors.join('; ')}`,
      );
      assert.throws(
        () => assertGutterDiffContract(mutated),
        (err: unknown) =>
          err instanceof Error &&
          err.message.includes('Gutter') &&
          err.message.includes(testCase.expectedPath),
      );
    }

    const backtestMutations: Array<{ label: string; expectedPath: string; mutate: (doc: any) => void }> = [
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
        label: 'renamed co-change strategy',
        expectedPath: "missing required strategy 'co-change'",
        mutate: (doc) => {
          doc.strategies = doc.strategies.filter((s: { name: string }) => s.name !== 'co-change');
        },
      },
      {
        label: 'renamed popularity strategy',
        expectedPath: "missing required strategy 'popularity, same changes'",
        mutate: (doc) => {
          doc.strategies = doc.strategies.filter(
            (s: { name: string }) => s.name !== 'popularity, same changes',
          );
        },
      },
    ];

    for (const testCase of backtestMutations) {
      const mutated = structuredClone(backtestJson);
      testCase.mutate(mutated);
      const errors = validateGutterBacktestContract(mutated);
      assert.ok(
        errors.length > 0,
        `expected backtest validator to reject ${testCase.label}, but it passed`,
      );
      assert.ok(
        errors.some((e) => e.includes('Gutter') && e.includes(testCase.expectedPath)),
        `expected error for ${testCase.label} to mention 'Gutter' and '${testCase.expectedPath}', got: ${errors.join('; ')}`,
      );
      assert.throws(
        () => assertGutterBacktestContract(mutated),
        (err: unknown) =>
          err instanceof Error &&
          err.message.includes('Gutter') &&
          err.message.includes(testCase.expectedPath),
      );
    }
  });

  it('verifies release.yml SHA pinning, OIDC permissions, smoke-pack step, and CHANGELOG.md Consumers section', () => {
    const releaseYml = readFileSync(join(ROOT_DIR, '.github', 'workflows', 'release.yml'), 'utf8');
    assert.match(releaseYml, /tags:\s*\n\s*-\s*'v\*\.\*\.\*'/);
    assert.match(releaseYml, /id-token:\s*write/);
    assert.match(releaseYml, /contents:\s*write/);
    assert.match(releaseYml, /node scripts\/smoke-pack\.mjs/);
    assert.match(releaseYml, /npm publish --provenance --access public/);

    const usesLines = releaseYml
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('uses:') || l.startsWith('- uses:'));
    assert.ok(usesLines.length >= 2, 'expected at least 2 uses: lines in release.yml');
    for (const line of usesLines) {
      assert.match(
        line,
        /@[0-9a-f]{40}\s+#\s*v\d+/,
        `Every third-party action in release.yml must be pinned to a 40-char commit SHA with a version comment: ${line}`,
      );
    }

    const changelog = readFileSync(join(ROOT_DIR, 'CHANGELOG.md'), 'utf8');
    assert.match(changelog, /## \[0\.3\.0\]/);
    assert.match(changelog, /### Consumers/);
    assert.match(changelog, /test\/consumer-gutter\.test\.ts/);
  });
});
