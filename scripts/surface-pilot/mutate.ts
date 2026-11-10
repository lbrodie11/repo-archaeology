/**
 * RA-18 corpus A: seeded mutations with known answers (docs/research/surface-pilot.md §3).
 *
 * Export sites and edits are found syntactically here; whether an export has consumers or
 * callers comes from the oracle (TypeScript's language service), never from `src/surface/`.
 * `src/surface/` is used only for the preregistered eligibility rule (a `known` surface).
 */
import type * as TS from 'typescript';
import { isTestFile } from '../../src/imports/classify.js';
import type { RepoFiles } from '../../src/imports/tree-files.js';
import { typescript } from '../../src/imports/typescript.js';
import { extractSurface, isSurfaceSource, parseSource } from '../../src/surface/extract.js';
import type { Oracle } from './oracle.js';

export const SEED = 20261110;

export const POSITIVE_KINDS = ['remove-export', 'add-required-param', 'add-required-prop'] as const;
export const NEGATIVE_KINDS = ['edit-body', 'reorder', 'rename-local', 'add-optional-param', 'split-export', 'add-export'] as const;
export type PositiveKind = (typeof POSITIVE_KINDS)[number];
export type NegativeKind = (typeof NEGATIVE_KINDS)[number];
export type MutationKind = PositiveKind | NegativeKind;

export interface Edit {
  start: number;
  end: number;
  text: string;
}

export interface Candidate {
  kind: MutationKind;
  file: string;
  /** The export the mutation is about (positives, and negatives that target one export). */
  name: string;
  edits: Edit[];
  /** Where to ask the oracle for references (positives). */
  position?: number;
}

export interface Mutation extends Candidate {
  id: string;
  class: 'positive' | 'negative';
  /** Ground truth (positives): files that consume (or, for parameters, call) the export. */
  oracleConsumers: string[];
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function applyEdits(text: string, edits: readonly Edit[]): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

/** Files mutations may edit (section 3 of the preregistration). */
export function eligibleFiles(files: RepoFiles): string[] {
  const out: string[] = [];
  for (const path of [...files.list()].sort()) {
    if (!isSurfaceSource(path) || isTestFile(path) || /\.d\.[cm]?ts$/i.test(path) || /(?:^|\/)fixtures\//.test(path)) continue;
    const text = files.read(path);
    if (text === undefined) continue;
    if (extractSurface(path, text).status !== 'known') continue;
    out.push(path);
  }
  return out;
}

const isTsFile = (path: string) => /\.[cm]?tsx?$/i.test(path);

function exportModifier(ts: typeof TS, node: TS.Node): { exportKw: TS.Node; defaultKw?: TS.Node } | undefined {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  const exportKw = modifiers?.find((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  if (!exportKw) return undefined;
  return { exportKw, defaultKw: modifiers?.find((m) => m.kind === ts.SyntaxKind.DefaultKeyword) };
}

/** Removes `export` (and `default`) plus the whitespace after them. */
function dropExportKeyword(text: string, source: TS.SourceFile, mod: { exportKw: TS.Node; defaultKw?: TS.Node }): Edit {
  const start = mod.exportKw.getStart(source);
  let end = (mod.defaultKw ?? mod.exportKw).getEnd();
  while (end < text.length && /[ \t]/.test(text[end]!)) end++;
  return { start, end, text: '' };
}

/** Removes one element of a comma-separated list (export specifiers, object properties). */
function removeListElement(text: string, source: TS.SourceFile, elements: TS.NodeArray<TS.Node>, index: number): Edit {
  const element = elements[index]!;
  if (index < elements.length - 1) return { start: element.getStart(source), end: elements[index + 1]!.getStart(source), text: '' };
  if (index > 0) return { start: elements[index - 1]!.getEnd(), end: element.getEnd(), text: '' };
  // The only element: keep the braces, drop the element and a trailing comma.
  const after = /^\s*,/.exec(text.slice(element.getEnd()));
  return { start: element.getStart(source), end: element.getEnd() + (after ? after[0].length : 0), text: '' };
}

function openParenEnd(ts: typeof TS, source: TS.SourceFile, node: TS.SignatureDeclaration): number | undefined {
  const paren = node.getChildren(source).find((c) => c.kind === ts.SyntaxKind.OpenParenToken);
  return paren?.getEnd();
}

interface FunctionSite {
  name: string;
  /** Where references are asked for. */
  position: number;
  fn: TS.SignatureDeclaration & { body?: TS.Node };
  esmDeclaration?: TS.FunctionDeclaration;
  shorthand?: TS.ShorthandPropertyAssignment;
}

interface Sites {
  removals: Candidate[];
  functions: FunctionSite[];
  types: { name: string; position: number; insertAt: number }[];
  localNames: { name: string; position: number }[];
  reorders: Candidate[];
  module: 'esm' | 'cjs';
}

/** Every syntactic export site of one file that the generator knows how to edit. */
export function findSites(path: string, text: string): Sites {
  const ts = typescript();
  const source = parseSource(path, text);
  const sites: Sites = { removals: [], functions: [], types: [], localNames: [], reorders: [], module: 'esm' };
  const functionDecls = new Map<string, TS.FunctionDeclaration[]>();
  const exportedLocals = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      functionDecls.set(statement.name.text, [...(functionDecls.get(statement.name.text) ?? []), statement]);
    }
  }
  const singleFunction = (name: string): TS.FunctionDeclaration | undefined => {
    const group = functionDecls.get(name) ?? [];
    return group.length === 1 && group[0]!.body ? group[0] : undefined;
  };
  const isCjs = /\bmodule\.exports\b|\bexports\.[\w$]+\s*=/.test(text);
  if (isCjs) sites.module = 'cjs';

  const addFunction = (name: string, position: number, fn: TS.Node | undefined, extra: Partial<FunctionSite> = {}) => {
    if (!fn) return;
    if (ts.isArrowFunction(fn) && openParenEnd(ts, source, fn) === undefined) return;
    if (ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn) || ts.isArrowFunction(fn) || ts.isMethodDeclaration(fn)) {
      sites.functions.push({ name, position, fn, ...extra });
    }
  };
  const localFunctionLike = (name: string): TS.Node | undefined => {
    const decl = singleFunction(name);
    if (decl) return decl;
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) continue;
      const declaration = statement.declarationList.declarations[0]!;
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer
        && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) return declaration.initializer;
    }
    return undefined;
  };

  const seenGroups = new Set<string>();
  for (const statement of source.statements) {
    const mod = exportModifier(ts, statement);
    if (mod) {
      const isDefault = Boolean(mod.defaultKw);
      if (ts.isVariableStatement(statement)) {
        const declarations = statement.declarationList.declarations;
        if (declarations.length === 1 && ts.isIdentifier(declarations[0]!.name)) {
          const declaration = declarations[0]!;
          const name = (declaration.name as TS.Identifier).text;
          const position = declaration.name.getStart(source);
          sites.removals.push({ kind: 'remove-export', file: path, name, position, edits: [dropExportKeyword(text, source, mod)] });
          const init = declaration.initializer;
          if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) addFunction(name, position, init);
        }
      } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)
        || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)
        || (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name))) && statement.name) {
        const local = statement.name.text;
        const name = isDefault ? 'default' : local;
        const group = `${statement.kind}:${local}`;
        if (!seenGroups.has(group)) {
          seenGroups.add(group);
          // Every declaration of a merged group (overloads, merged interfaces) loses `export`.
          const members = source.statements.filter((s) => s.kind === statement.kind && (s as TS.DeclarationStatement).name?.getText(source) === local && exportModifier(ts, s));
          sites.removals.push({
            kind: 'remove-export',
            file: path,
            name,
            position: statement.name.getStart(source),
            edits: members.map((s) => dropExportKeyword(text, source, exportModifier(ts, s)!)),
          });
        }
        if (ts.isFunctionDeclaration(statement) && singleFunction(local) === statement) {
          addFunction(name, statement.name.getStart(source), statement, isDefault ? {} : { esmDeclaration: statement });
        }
        if (isTsFile(path) && !isDefault) {
          if (ts.isInterfaceDeclaration(statement) && !sites.types.some((t) => t.name === name)) {
            const brace = statement.getChildren(source).find((c) => c.kind === ts.SyntaxKind.OpenBraceToken);
            if (brace) sites.types.push({ name, position: statement.name.getStart(source), insertAt: brace.getEnd() });
          } else if (ts.isTypeAliasDeclaration(statement) && ts.isTypeLiteralNode(statement.type)) {
            sites.types.push({ name, position: statement.name.getStart(source), insertAt: statement.type.getStart(source) + 1 });
          }
        }
      }
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause) && !statement.isTypeOnly) {
      const elements = statement.exportClause.elements;
      elements.forEach((element, index) => {
        if (element.isTypeOnly) return;
        const name = element.name.text;
        const local = (element.propertyName ?? element.name).text;
        if (!statement.moduleSpecifier) exportedLocals.add(local);
        const edits = elements.length === 1
          ? [{ start: statement.getStart(source), end: statement.getEnd(), text: '' }]
          : [removeListElement(text, source, elements, index)];
        sites.removals.push({ kind: 'remove-export', file: path, name, position: element.name.getStart(source), edits });
        if (!statement.moduleSpecifier) addFunction(name, element.name.getStart(source), localFunctionLike(local));
      });
      continue;
    }
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) exportedLocals.add(statement.expression.text);
    if (isCjs && ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
      && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const { left, right } = statement.expression;
      const isModuleExports = (n: TS.Node) => ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'module' && n.name.text === 'exports';
      if (isModuleExports(left) && ts.isObjectLiteralExpression(right)) {
        right.properties.forEach((property, index) => {
          const nameNode = property.name;
          if (!nameNode || !(ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode))) return;
          const name = nameNode.text;
          const position = nameNode.getStart(source);
          sites.removals.push({ kind: 'remove-export', file: path, name, position, edits: [removeListElement(text, source, right.properties, index)] });
          if (ts.isShorthandPropertyAssignment(property)) {
            exportedLocals.add(name);
            addFunction(name, position, localFunctionLike(name), { shorthand: property });
          } else if (ts.isPropertyAssignment(property)) {
            if (ts.isIdentifier(property.initializer)) {
              exportedLocals.add(property.initializer.text);
              addFunction(name, position, localFunctionLike(property.initializer.text));
            } else addFunction(name, position, property.initializer);
          } else if (ts.isMethodDeclaration(property)) {
            addFunction(name, position, property);
          }
        });
      } else if (ts.isPropertyAccessExpression(left) && (isModuleExports(left.expression) || (ts.isIdentifier(left.expression) && left.expression.text === 'exports'))) {
        const name = left.name.text;
        const position = left.name.getStart(source);
        sites.removals.push({ kind: 'remove-export', file: path, name, position, edits: [{ start: left.getStart(source), end: left.getEnd(), text: `const __seededRemoved_${name}` }] });
        if (ts.isIdentifier(right)) {
          exportedLocals.add(right.text);
          addFunction(name, position, localFunctionLike(right.text));
        } else addFunction(name, position, right);
      }
    }
  }

  // Top-level non-exported locals that no export statement names.
  for (const statement of source.statements) {
    if (exportModifier(ts, statement)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name && singleFunction(statement.name.text) === statement && !exportedLocals.has(statement.name.text)) {
      sites.localNames.push({ name: statement.name.text, position: statement.name.getStart(source) });
    } else if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
      const declaration = statement.declarationList.declarations[0]!;
      if (ts.isIdentifier(declaration.name) && !exportedLocals.has(declaration.name.text)
        && !(declaration.initializer && /\brequire\s*\(/.test(declaration.initializer.getText(source)))) {
        sites.localNames.push({ name: declaration.name.text, position: declaration.name.getStart(source) });
      }
    }
  }

  // Adjacent top-level function, interface or type-alias declarations (hoisting-safe to swap).
  const swappable = (s: TS.Statement | undefined): s is TS.Statement =>
    s !== undefined && ((ts.isFunctionDeclaration(s) && s.name !== undefined && singleFunction(s.name.text) === s)
      || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s));
  for (let i = 0; i + 1 < source.statements.length; i++) {
    const a = source.statements[i];
    const b = source.statements[i + 1];
    if (!swappable(a) || !swappable(b)) continue;
    const aStart = a.getStart(source, true);
    const bStart = b.getStart(source, true);
    const aText = text.slice(aStart, a.getEnd());
    const bText = text.slice(bStart, b.getEnd());
    sites.reorders.push({
      kind: 'reorder',
      file: path,
      name: `${(a as TS.DeclarationStatement).name?.getText(source)}<>${(b as TS.DeclarationStatement).name?.getText(source)}`,
      edits: [{ start: aStart, end: a.getEnd(), text: bText }, { start: bStart, end: b.getEnd(), text: aText }],
    });
  }
  return sites;
}

/** Candidates of every kind for one file (positives still need the oracle check). */
export function candidatesFor(path: string, text: string): Map<MutationKind, Candidate[]> {
  const ts = typescript();
  const sites = findSites(path, text);
  const out = new Map<MutationKind, Candidate[]>();
  const push = (candidate: Candidate) => out.set(candidate.kind, [...(out.get(candidate.kind) ?? []), candidate]);
  const tsFile = isTsFile(path);
  for (const removal of sites.removals) push(removal);
  for (const site of sites.functions) {
    // Re-find the node in this parse by position (sites were found on an identical parse).
    const fn = site.fn;
    const paren = openParenEnd(ts, fn.getSourceFile(), fn);
    if (paren === undefined) continue;
    const params = fn.parameters;
    const thisParam = params[0] && ts.isIdentifier(params[0].name) && params[0].name.text === 'this' ? params[0] : undefined;
    const required = tsFile ? '__seeded: unknown' : '__seeded';
    const others = params.filter((p) => p !== thisParam);
    const requiredEdit: Edit = thisParam
      ? { start: thisParam.getEnd(), end: thisParam.getEnd(), text: `, ${required}` }
      : { start: paren, end: paren, text: others.length > 0 ? `${required}, ` : required };
    push({ kind: 'add-required-param', file: path, name: site.name, position: site.position, edits: [requiredEdit] });
    const optional = tsFile ? '__seeded?: unknown' : '__seeded = undefined';
    const last = params[params.length - 1];
    const optionalEdit: Edit = !last
      ? { start: paren, end: paren, text: optional }
      : last.dotDotDotToken
        ? { start: last.getStart(fn.getSourceFile()), end: last.getStart(fn.getSourceFile()), text: `${optional}, ` }
        : { start: last.getEnd(), end: last.getEnd(), text: `, ${optional}` };
    push({ kind: 'add-optional-param', file: path, name: site.name, edits: [optionalEdit] });
    const body = fn.body;
    if (body && ts.isBlock(body)) push({ kind: 'edit-body', file: path, name: site.name, edits: [{ start: body.getStart(fn.getSourceFile()) + 1, end: body.getStart(fn.getSourceFile()) + 1, text: ' void 0;' }] });
    if (site.esmDeclaration) {
      const mod = exportModifier(ts, site.esmDeclaration)!;
      push({
        kind: 'split-export',
        file: path,
        name: site.name,
        edits: [dropExportKeyword(text, fn.getSourceFile(), mod), { start: text.length, end: text.length, text: `${text.endsWith('\n') ? '' : '\n'}export { ${site.name} };\n` }],
      });
    }
    if (site.shorthand) {
      push({ kind: 'split-export', file: path, name: site.name, edits: [{ start: site.shorthand.getEnd(), end: site.shorthand.getEnd(), text: `: ${site.name}` }] });
    }
  }
  for (const type of sites.types) {
    push({ kind: 'add-required-prop', file: path, name: type.name, position: type.position, edits: [{ start: type.insertAt, end: type.insertAt, text: ' __seeded: unknown;' }] });
  }
  for (const local of sites.localNames) push({ kind: 'rename-local', file: path, name: local.name, position: local.position, edits: [] });
  for (const reorder of sites.reorders) push(reorder);
  const exportLine = sites.module === 'cjs' ? 'module.exports.__seededExport = 1;' : 'export const __seededExport = 1;';
  push({ kind: 'add-export', file: path, name: '__seededExport', edits: [{ start: text.length, end: text.length, text: `${text.endsWith('\n') ? '' : '\n'}${exportLine}\n` }] });
  return out;
}

export interface GenerateOptions {
  seed?: number;
  positives?: number;
  negatives?: number;
  /** Positive kinds that apply to this repository (eslint: no `add-required-prop`). */
  positiveKinds?: readonly PositiveKind[];
  prefix: string;
  /** Called while scanning, for progress output. */
  onProgress?: (message: string) => void;
}

export interface GenerateResult {
  mutations: Mutation[];
  /** Kinds that could not fill their quota, and how many came from other kinds instead. */
  shortfalls: Record<string, number>;
  eligibleFiles: number;
  candidatesSeen: Record<string, number>;
}

/** Deterministic for a fixed seed, tree and oracle. */
export function generateMutations(files: RepoFiles, oracle: Oracle, options: GenerateOptions): GenerateResult {
  const random = mulberry32(options.seed ?? SEED);
  const eligible = eligibleFiles(files);
  const byKind = new Map<MutationKind, Candidate[]>();
  for (const path of eligible) {
    const text = files.read(path)!;
    for (const [kind, list] of candidatesFor(path, text)) byKind.set(kind, [...(byKind.get(kind) ?? []), ...list]);
  }
  const positiveKinds = options.positiveKinds ?? POSITIVE_KINDS;
  const streams = new Map<MutationKind, Candidate[]>();
  for (const kind of [...POSITIVE_KINDS, ...NEGATIVE_KINDS]) streams.set(kind, shuffle(byKind.get(kind) ?? [], random));
  const candidatesSeen: Record<string, number> = {};
  for (const [kind, list] of streams) candidatesSeen[kind] = list.length;

  const textOf = (path: string) => files.read(path)!;
  const accept = (candidate: Candidate, cls: 'positive' | 'negative'): Omit<Mutation, 'id'> | undefined => {
    if (cls === 'positive') {
      const refs = oracle.externalReferences(candidate.file, candidate.position!);
      const relevant = candidate.kind === 'add-required-param' ? refs.filter((r) => r.call) : refs;
      const consumers = [...new Set(relevant.map((r) => r.file))].sort();
      if (consumers.length === 0) return undefined;
      return { ...candidate, class: cls, oracleConsumers: consumers };
    }
    if (candidate.kind === 'rename-local') {
      const locations = oracle.renameLocations(candidate.file, candidate.position!);
      if (!locations || locations.length === 0) return undefined;
      const newName = `${candidate.name}__seeded`;
      if (textOf(candidate.file).includes(newName)) return undefined;
      const edits: Edit[] = [];
      for (const location of locations) {
        if (location.fileName !== `/repo/${candidate.file}`) return undefined; // used outside the file: not a local
        edits.push({ start: location.textSpan.start, end: location.textSpan.start + location.textSpan.length, text: `${location.prefixText ?? ''}${newName}${location.suffixText ?? ''}` });
      }
      return { ...candidate, edits, class: cls, oracleConsumers: [] };
    }
    return { ...candidate, class: cls, oracleConsumers: [] };
  };

  const select = (kinds: readonly MutationKind[], total: number, cls: 'positive' | 'negative'): { picked: Omit<Mutation, 'id'>[]; shortfalls: Record<string, number> } => {
    const quota = Math.floor(total / kinds.length);
    const picked: Omit<Mutation, 'id'>[] = [];
    const cursor = new Map<MutationKind, number>(kinds.map((k) => [k, 0]));
    const used = new Set<string>();
    const next = (kind: MutationKind): Omit<Mutation, 'id'> | undefined => {
      const list = streams.get(kind) ?? [];
      for (let i = cursor.get(kind)!; i < list.length; i++) {
        cursor.set(kind, i + 1);
        const candidate = list[i]!;
        const key = `${candidate.kind}\0${candidate.file}\0${candidate.name}`;
        if (used.has(key)) continue;
        const accepted = accept(candidate, cls);
        if (accepted) {
          used.add(key);
          options.onProgress?.(`${cls} ${kind} ${picked.length + 1}/${total}: ${candidate.file} ${candidate.name}`);
          return accepted;
        }
      }
      return undefined;
    };
    const counts = new Map<MutationKind, number>();
    for (const kind of kinds) {
      for (let n = 0; n < quota; n++) {
        const m = next(kind);
        if (!m) break;
        picked.push(m);
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
      }
    }
    const shortfalls: Record<string, number> = {};
    for (const kind of kinds) if ((counts.get(kind) ?? 0) < quota) shortfalls[kind] = quota - (counts.get(kind) ?? 0);
    // Fill any shortfall round robin from the other kinds of the same class.
    let progress = true;
    while (picked.length < total && progress) {
      progress = false;
      for (const kind of kinds) {
        if (picked.length >= total) break;
        const m = next(kind);
        if (m) {
          picked.push(m);
          progress = true;
        }
      }
    }
    return { picked, shortfalls };
  };

  const positives = select(positiveKinds, options.positives ?? 120, 'positive');
  const negatives = select(NEGATIVE_KINDS, options.negatives ?? 120, 'negative');
  const mutations: Mutation[] = [
    ...positives.picked.map((m, i) => ({ id: `${options.prefix}-p${String(i + 1).padStart(3, '0')}`, ...m })),
    ...negatives.picked.map((m, i) => ({ id: `${options.prefix}-n${String(i + 1).padStart(3, '0')}`, ...m })),
  ];
  return { mutations, shortfalls: { ...positives.shortfalls, ...negatives.shortfalls }, eligibleFiles: eligible.length, candidatesSeen };
}
