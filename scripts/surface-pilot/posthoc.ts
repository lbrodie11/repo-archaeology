#!/usr/bin/env node
/**
 * RA-18 POST-HOC check (written after the corpus-A results; NOT part of the preregistered
 * rule and cannot change the verdict). For every corpus-A positive, re-verifies the oracle's
 * ground-truth consumers with TypeScript's own module resolution (the oracle program's
 * `getResolvedModule`, not `src/surface/`): does the consumer actually import the mutated
 * file, and how?
 *
 *   node --import tsx scripts/surface-pilot/posthoc.ts --corpora <dir with hono.git, eslint.git, vue-core.git>
 *
 * Writes docs/research/data/surface-pilot/posthoc.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type * as TS from 'typescript';
import { listTreeFiles } from '../../src/git/repo.js';
import { gitTreeFiles } from '../../src/imports/tree-files.js';
import { CORPORA } from './corpora.js';
import { fromVirtual, Oracle } from './oracle.js';
import { DATA_DIR, judge } from './report.js';

/** How a verified consumer reaches the mutated export (strongest first). */
export const CATEGORIES = ['named', 'named-via-barrel', 'only-via-export-star', 'only-namespace', 'no-import-found'] as const;
export type Category = (typeof CATEGORIES)[number];

interface Reach {
  target: string;
  names: Set<string>;
  namespace: boolean;
}

/** Every module a file loads, resolved by TypeScript, with the names it binds. */
/** `Program.getResolvedModule` exists at runtime in TypeScript ≥ 5.3 but is not in every version's public typings. */
type ResolvingProgram = TS.Program & {
  getResolvedModule(file: TS.SourceFile, name: string, mode: TS.ResolutionMode): { resolvedModule?: { resolvedFileName: string } } | undefined;
};

function importsOf(oracle: Oracle, path: string): Reach[] {
  const ts = oracle.ts;
  const program = oracle.program() as ResolvingProgram;
  const source = oracle.sourceFile(path);
  if (!source) return [];
  const out: Reach[] = [];
  const resolveSpecifier = (literal: TS.StringLiteralLike): string | undefined => {
    const mode = program.getModeForUsageLocation(source, literal);
    const resolved = program.getResolvedModule(source, literal.text, mode)?.resolvedModule?.resolvedFileName;
    return resolved ? fromVirtual(resolved) : undefined;
  };
  const add = (literal: TS.StringLiteralLike, names: string[], namespace: boolean) => {
    const target = resolveSpecifier(literal);
    if (target) out.push({ target, names: new Set(names), namespace });
  };
  const visit = (node: TS.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause;
      const names: string[] = [];
      let namespace = false;
      if (clause?.name) names.push('default');
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespace = true;
      else if (bindings) for (const e of bindings.elements) names.push((e.propertyName ?? e.name).text);
      add(node.moduleSpecifier, names, namespace);
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.exportClause;
      if (clause && ts.isNamedExports(clause)) add(node.moduleSpecifier, clause.elements.map((e) => (e.propertyName ?? e.name).text), false);
      else add(node.moduleSpecifier, [], true);
      return;
    }
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]!)) {
      const literal = node.arguments[0] as TS.StringLiteralLike;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamic) {
        const parent = node.parent;
        if (isRequire && parent && ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
          add(literal, parent.name.elements.map((e) => (e.propertyName && ts.isIdentifier(e.propertyName) ? e.propertyName.text : ts.isIdentifier(e.name) ? e.name.text : '')), false);
        } else if (isRequire && parent && ts.isPropertyAccessExpression(parent) && parent.expression === node) {
          add(literal, [parent.name.text], false);
        } else {
          add(literal, [], true);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** Barrel files that re-export from `file`: `{ path, names re-exported (explicitly), star }`. */
function barrelsOf(oracle: Oracle, file: string, candidates: Iterable<string>): Map<string, { names: Map<string, string>; star: boolean }> {
  const out = new Map<string, { names: Map<string, string>; star: boolean }>();
  const ts = oracle.ts;
  for (const path of candidates) {
    const source = oracle.sourceFile(path);
    if (!source) continue;
    for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
      const program = oracle.program() as ResolvingProgram;
      const mode = program.getModeForUsageLocation(source, statement.moduleSpecifier);
      const resolved = program.getResolvedModule(source, statement.moduleSpecifier.text, mode)?.resolvedModule?.resolvedFileName;
      if (!resolved || fromVirtual(resolved) !== file) continue;
      const entry = out.get(path) ?? { names: new Map<string, string>(), star: false };
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) for (const e of clause.elements) entry.names.set((e.propertyName ?? e.name).text, e.name.text);
      else entry.star = true;
      out.set(path, entry);
    }
  }
  return out;
}

export function categorize(oracle: Oracle, file: string, name: string, consumers: readonly string[]): Category {
  const imports = new Map(consumers.map((c) => [c, importsOf(oracle, c)]));
  const targets = new Set([...imports.values()].flatMap((list) => list.map((r) => r.target)));
  const barrels = barrelsOf(oracle, file, targets);
  let best = CATEGORIES.length - 1;
  const consider = (category: Category) => (best = Math.min(best, CATEGORIES.indexOf(category)));
  for (const list of imports.values()) {
    for (const reach of list) {
      if (reach.target === file) {
        if (reach.names.has(name)) consider('named');
        else if (reach.namespace) consider('only-namespace');
        continue;
      }
      const barrel = barrels.get(reach.target);
      if (!barrel) continue;
      const exportedAs = barrel.names.get(name);
      if (exportedAs !== undefined && reach.names.has(exportedAs)) consider('named-via-barrel');
      else if (barrel.star && reach.names.has(name)) consider('only-via-export-star');
      else if (reach.namespace) consider('only-namespace');
    }
  }
  return CATEGORIES[best]!;
}

interface Record_ { id: string; class: string; kind: string; file: string; name: string; oracleConsumers: string[]; analysis: unknown }

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { corpora: { type: 'string' } } });
  if (!values.corpora) throw new Error('--corpora <dir> is required');
  const items: { id: string; repo: string; kind: string; detected: boolean; category: Category }[] = [];
  for (const repo of CORPORA.filter((r) => r.corpusA)) {
    const gitDir = join(resolve(values.corpora), `${repo.id}.git`);
    const records = readFileSync(join(DATA_DIR, 'corpus-a', `${repo.id}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record_);
    const files = gitTreeFiles(gitDir, repo.pin, await listTreeFiles(gitDir, repo.pin));
    try {
      const oracle = new Oracle(files, { commonJs: repo.commonJs });
      for (const record of records.filter((r) => r.class === 'positive')) {
        items.push({
          id: record.id,
          repo: repo.id,
          kind: record.kind,
          detected: judge(record as never).ok,
          category: categorize(oracle, record.file, record.name, record.oracleConsumers),
        });
      }
    } finally {
      files.close();
    }
    process.stderr.write(`[${repo.id}] categorized\n`);
  }
  writeFileSync(join(DATA_DIR, 'posthoc.json'), `${JSON.stringify({ note: 'POST-HOC, written after the corpus-A results; not part of the preregistered rule.', items }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
