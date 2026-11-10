import type * as TS from 'typescript';
import { typescript } from '../imports/typescript.js';
import { KIND_PRIORITY, type ExportKind, type OpaqueReexport, type Signature, type Surface, type SurfaceExport } from './types.js';

/**
 * Syntactic export surface and import bindings for one JS/TS file (RA-18 pilot).
 * Uses `createSourceFile` only: no Program, no type checker, nothing executed.
 */

export const SURFACE_SOURCE = /\.(?:[cm]?[jt]sx?)$/i;

export function isSurfaceSource(path: string): boolean {
  return SURFACE_SOURCE.test(path) && !/(?:^|\/)node_modules\//.test(path);
}

export function scriptKindFor(fileName: string): TS.ScriptKind {
  const ts = typescript();
  if (/\.tsx$/i.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.(?:jsx|js|mjs|cjs)$/i.test(fileName)) return /\.jsx$/i.test(fileName) ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function parseSource(fileName: string, text: string): TS.SourceFile {
  const ts = typescript();
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
}

/** Parse diagnostics are internal to TypeScript's `SourceFile`; read them defensively. */
export function hasParseErrors(source: TS.SourceFile): boolean {
  const diagnostics = (source as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics;
  return Array.isArray(diagnostics) && diagnostics.length > 0;
}

interface LocalDecl {
  kinds: Set<ExportKind>;
  params?: Signature;
  requiredProps?: Set<string>;
  from?: string;
  importedName?: string;
  typeOnly?: boolean;
}

export function extractSurface(fileName: string, sourceText: string): Surface {
  return surfaceOf(parseSource(fileName, sourceText));
}

export function surfaceOf(source: TS.SourceFile): Surface {
  const ts = typescript();
  const locals = collectLocals(ts, source);
  const exports = new Map<string, SurfaceExport>();
  const opaque: OpaqueReexport[] = [];
  let esm = false;
  let unknownReason: string | undefined;

  const add = (entry: SurfaceExport) => {
    const existing = exports.get(entry.name);
    exports.set(entry.name, existing ? mergeExport(existing, entry) : entry);
  };

  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      esm = true;
      const specifier = statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
      const clause = statement.exportClause;
      if (!clause) {
        if (specifier !== undefined) opaque.push({ specifier });
        continue;
      }
      if (ts.isNamespaceExport(clause)) {
        if (specifier !== undefined) {
          opaque.push({ specifier, namespace: clause.name.text });
          add(withTypeOnly({ name: clause.name.text, kind: 're-export', from: specifier, importedName: '*' }, statement.isTypeOnly));
        }
        continue;
      }
      for (const element of clause.elements) {
        const name = element.name.text;
        const local = (element.propertyName ?? element.name).text;
        const typeOnly = statement.isTypeOnly || element.isTypeOnly;
        if (specifier !== undefined) {
          add(withTypeOnly({ name, kind: 're-export', from: specifier, importedName: local }, typeOnly));
        } else {
          add(withTypeOnly(fromLocal(name, locals.get(local)), typeOnly));
        }
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      esm = true;
      if (statement.isExportEquals) {
        unknownReason ??= 'export-equals';
        continue;
      }
      add(fromExpression(ts, 'default', statement.expression, locals));
      continue;
    }
    if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) {
      if (ts.isImportDeclaration(statement)) esm = true;
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    esm = true;
    const isDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(ts, declaration.name)) add(fromLocal(name, locals.get(name)));
      }
    } else if (ts.isFunctionDeclaration(statement)) {
      const local = statement.name ? locals.get(statement.name.text) : undefined;
      const name = isDefault ? 'default' : statement.name?.text;
      if (name) add(local ? fromLocal(name, local) : { name, kind: 'function', params: signatureOf(ts, [statement]) });
    } else if (ts.isClassDeclaration(statement)) {
      const name = isDefault ? 'default' : statement.name?.text;
      if (name) add({ name, kind: 'class' });
    } else if (
      ts.isInterfaceDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement)
      || ts.isEnumDeclaration(statement)
    ) {
      const local = locals.get(statement.name.text);
      add(fromLocal(isDefault ? 'default' : statement.name.text, local));
    } else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
      add(fromLocal(statement.name.text, locals.get(statement.name.text)));
    } else if (ts.isImportEqualsDeclaration(statement)) {
      add({ name: statement.name.text, kind: 're-export' });
    }
  }

  const cjs = commonJsExports(ts, source, locals);
  if (cjs.used) {
    if (esm && cjs.entries.length > 0) unknownReason ??= 'mixed-esm-and-commonjs';
    if (cjs.unknownReason) unknownReason ??= cjs.unknownReason;
    for (const entry of cjs.entries) add(entry);
  }

  const module = cjs.used ? 'cjs' : esm ? 'esm' : 'none';
  if (unknownReason) return { status: 'unknown', reason: unknownReason, module, exports: [], opaque: [] };
  return {
    status: 'known',
    module,
    exports: [...exports.values()].sort((a, b) => compare(a.name, b.name)),
    opaque: opaque.sort((a, b) => compare(`${a.specifier}\0${a.namespace ?? ''}`, `${b.specifier}\0${b.namespace ?? ''}`)),
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function withTypeOnly(entry: SurfaceExport, typeOnly: boolean): SurfaceExport {
  return typeOnly ? { ...entry, typeOnly: true } : entry;
}

function pickKind(kinds: Iterable<ExportKind>): ExportKind {
  const set = new Set(kinds);
  return KIND_PRIORITY.find((kind) => set.has(kind)) ?? 'variable';
}

function fromLocal(name: string, local: LocalDecl | undefined): SurfaceExport {
  if (!local) return { name, kind: 'variable' };
  const kind = pickKind(local.kinds);
  const entry: SurfaceExport = { name, kind };
  if (local.params && (kind === 'function' || kind === 'variable')) entry.params = { ...local.params };
  if (local.requiredProps && (kind === 'interface' || kind === 'type')) entry.requiredProps = [...local.requiredProps].sort(compare);
  if (kind === 're-export') {
    if (local.from !== undefined) entry.from = local.from;
    if (local.importedName !== undefined) entry.importedName = local.importedName;
  }
  if (local.typeOnly) entry.typeOnly = true;
  return entry;
}

function mergeExport(a: SurfaceExport, b: SurfaceExport): SurfaceExport {
  const kind = pickKind([a.kind, b.kind]);
  const primary = a.kind === kind ? a : b;
  const merged: SurfaceExport = { ...primary, kind };
  const props = new Set([...(a.requiredProps ?? []), ...(b.requiredProps ?? [])]);
  if ((a.requiredProps || b.requiredProps) && (kind === 'interface' || kind === 'type')) merged.requiredProps = [...props].sort(compare);
  if (!(a.typeOnly && b.typeOnly)) delete merged.typeOnly;
  return merged;
}

function unwrap(ts: typeof TS, expression: TS.Expression): TS.Expression {
  let current = expression;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)
      || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

function fromExpression(ts: typeof TS, name: string, raw: TS.Expression, locals: Map<string, LocalDecl>): SurfaceExport {
  const expression = unwrap(ts, raw);
  if (ts.isIdentifier(expression)) return fromLocal(name, locals.get(expression.text));
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    return { name, kind: 'function', params: signatureOf(ts, [expression]) };
  }
  if (ts.isClassExpression(expression)) return { name, kind: 'class' };
  const required = requireCall(ts, expression);
  if (required !== undefined) return { name, kind: 're-export', from: required, importedName: '*' };
  if (ts.isPropertyAccessExpression(expression)) {
    const inner = requireCall(ts, unwrap(ts, expression.expression));
    if (inner !== undefined) return { name, kind: 're-export', from: inner, importedName: expression.name.text };
  }
  return { name, kind: 'variable' };
}

/** `require('x')` with a literal argument: the specifier. */
export function requireCall(ts: typeof TS, node: TS.Node): string | undefined {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'require') return undefined;
  const argument = node.arguments[0];
  return node.arguments.length === 1 && argument && ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

type FunctionLike = TS.SignatureDeclarationBase & { body?: TS.Node };

export function signatureOf(ts: typeof TS, declarations: readonly FunctionLike[]): Signature {
  const overloads = declarations.filter((d) => d.body === undefined);
  const visible = overloads.length > 0 && overloads.length < declarations.length ? overloads : declarations;
  let required = Number.POSITIVE_INFINITY;
  let total = 0;
  let rest = false;
  for (const declaration of visible) {
    const params = declaration.parameters.filter((p) => !(ts.isIdentifier(p.name) && p.name.text === 'this'));
    let lastRequired = -1;
    params.forEach((p, i) => {
      if (!p.questionToken && !p.initializer && !p.dotDotDotToken) lastRequired = i;
      if (p.dotDotDotToken) rest = true;
    });
    required = Math.min(required, lastRequired + 1);
    total = Math.max(total, params.length);
  }
  return { required: Number.isFinite(required) ? required : 0, total, rest };
}

function requiredPropsOf(ts: typeof TS, members: readonly TS.TypeElement[]): Set<string> {
  const props = new Set<string>();
  for (const member of members) {
    if (!(ts.isPropertySignature(member) || ts.isMethodSignature(member)) || member.questionToken) continue;
    const name = member.name;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) props.add(name.text);
  }
  return props;
}

export function bindingNames(ts: typeof TS, name: TS.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const out: string[] = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    out.push(...bindingNames(ts, element.name));
  }
  return out;
}

function collectLocals(ts: typeof TS, source: TS.SourceFile): Map<string, LocalDecl> {
  const locals = new Map<string, LocalDecl>();
  const functions = new Map<string, TS.FunctionDeclaration[]>();
  const get = (name: string): LocalDecl => {
    let local = locals.get(name);
    if (!local) {
      local = { kinds: new Set() };
      locals.set(name, local);
    }
    return local;
  };
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      get(statement.name.text).kinds.add('function');
      const group = functions.get(statement.name.text) ?? [];
      group.push(statement);
      functions.set(statement.name.text, group);
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      get(statement.name.text).kinds.add('class');
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          const local = get(declaration.name.text);
          const init = declaration.initializer ? unwrap(ts, declaration.initializer) : undefined;
          const required = init ? requireCall(ts, init) : undefined;
          if (required !== undefined) {
            local.kinds.add('re-export');
            local.from = required;
            local.importedName = '*';
          } else if (init && ts.isPropertyAccessExpression(init) && requireCall(ts, unwrap(ts, init.expression)) !== undefined) {
            local.kinds.add('re-export');
            local.from = requireCall(ts, unwrap(ts, init.expression));
            local.importedName = init.name.text;
          } else {
            local.kinds.add('variable');
            if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) local.params = signatureOf(ts, [init]);
          }
        } else {
          const init = declaration.initializer ? unwrap(ts, declaration.initializer) : undefined;
          const required = init ? requireCall(ts, init) : undefined;
          if (required !== undefined && ts.isObjectBindingPattern(declaration.name)) {
            for (const element of declaration.name.elements) {
              if (!ts.isIdentifier(element.name)) continue;
              const local = get(element.name.text);
              local.kinds.add('re-export');
              local.from = required;
              const property = element.propertyName;
              local.importedName = element.dotDotDotToken ? '*' : property && (ts.isIdentifier(property) || ts.isStringLiteral(property)) ? property.text : element.name.text;
            }
          } else {
            for (const name of bindingNames(ts, declaration.name)) get(name).kinds.add('variable');
          }
        }
      }
    } else if (ts.isInterfaceDeclaration(statement)) {
      const local = get(statement.name.text);
      local.kinds.add('interface');
      local.requiredProps = new Set([...(local.requiredProps ?? []), ...requiredPropsOf(ts, statement.members)]);
    } else if (ts.isTypeAliasDeclaration(statement)) {
      const local = get(statement.name.text);
      local.kinds.add('type');
      if (ts.isTypeLiteralNode(statement.type)) {
        local.requiredProps = new Set([...(local.requiredProps ?? []), ...requiredPropsOf(ts, statement.type.members)]);
      }
    } else if (ts.isEnumDeclaration(statement)) {
      get(statement.name.text).kinds.add('enum');
    } else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
      get(statement.name.text).kinds.add('namespace');
    } else if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const from = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (!clause) continue;
      const typeOnly = clause.isTypeOnly;
      if (clause.name) Object.assign(get(clause.name.text), { from, importedName: 'default', typeOnly }).kinds.add('re-export');
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        Object.assign(get(bindings.name.text), { from, importedName: '*', typeOnly }).kinds.add('re-export');
      } else if (bindings) {
        for (const element of bindings.elements) {
          Object.assign(get(element.name.text), {
            from,
            importedName: (element.propertyName ?? element.name).text,
            typeOnly: typeOnly || element.isTypeOnly,
          }).kinds.add('re-export');
        }
      }
    } else if (ts.isImportEqualsDeclaration(statement)) {
      const local = get(statement.name.text);
      local.kinds.add('re-export');
      if (ts.isExternalModuleReference(statement.moduleReference) && ts.isStringLiteralLike(statement.moduleReference.expression)) {
        local.from = statement.moduleReference.expression.text;
        local.importedName = '*';
      }
    }
  }
  for (const [name, group] of functions) get(name).params = signatureOf(ts, group);
  for (const local of locals.values()) if (!local.typeOnly) delete local.typeOnly;
  return locals;
}

interface CommonJsResult {
  used: boolean;
  entries: SurfaceExport[];
  unknownReason?: string;
}

function isModuleExports(ts: typeof TS, node: TS.Node): node is TS.PropertyAccessExpression {
  return ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'module' && node.name.text === 'exports';
}

/** Is `node` an identifier in a non-reference position (a property name or a declaration name)? */
function isNameOnly(ts: typeof TS, node: TS.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)
    || ts.isPropertySignature(parent) || ts.isMethodSignature(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent)
    || ts.isEnumMember(parent) || ts.isQualifiedName(parent) || ts.isLabeledStatement(parent)
    || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isPropertyAssignment(parent)) && (parent as { name?: TS.Node }).name === node) return true;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  return false;
}

function isDeclarationName(ts: typeof TS, node: TS.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  return (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)
    || ts.isBindingElement(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) && (parent as { name?: TS.Node }).name === node;
}

function isTopLevelAssignment(ts: typeof TS, target: TS.Expression, source: TS.SourceFile): TS.Expression | undefined {
  const binary = target.parent;
  if (!binary || !ts.isBinaryExpression(binary) || binary.left !== target || binary.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined;
  const statement = binary.parent;
  if (!statement || !ts.isExpressionStatement(statement) || statement.parent !== source) return undefined;
  return binary.right;
}

function commonJsExports(ts: typeof TS, source: TS.SourceFile, locals: Map<string, LocalDecl>): CommonJsResult {
  const text = source.text;
  if (!/\bexports\b/.test(text)) return { used: false, entries: [] };
  const result: CommonJsResult = { used: false, entries: [] };
  const fail = (reason: string) => {
    result.used = true;
    result.unknownReason ??= reason;
  };
  let objectAssignments = 0;
  let exportsShadowed = false;
  const bareExports: TS.Identifier[] = [];

  const visit = (node: TS.Node): void => {
    if (isModuleExports(ts, node)) {
      result.used = true;
      const parent = node.parent;
      const value = isTopLevelAssignment(ts, node, source);
      if (value !== undefined) {
        objectAssignments++;
        const object = unwrap(ts, value);
        if (objectAssignments > 1) fail('module.exports-reassigned');
        else if (!ts.isObjectLiteralExpression(object)) fail('module.exports-not-object');
        else readObject(object);
      } else if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        const propertyValue = isTopLevelAssignment(ts, parent, source);
        if (propertyValue !== undefined) result.entries.push(fromExpression(ts, parent.name.text, propertyValue, locals));
        else fail('module.exports-dynamic-use');
      } else {
        fail('module.exports-dynamic-use');
      }
      return; // do not visit the `module` / `exports` identifiers inside
    }
    if (ts.isIdentifier(node) && node.text === 'exports') {
      if (isDeclarationName(ts, node)) exportsShadowed = true;
      else if (!isNameOnly(ts, node)) bareExports.push(node);
    }
    ts.forEachChild(node, visit);
  };

  const readObject = (object: TS.ObjectLiteralExpression) => {
    for (const property of object.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        result.entries.push(fromLocal(property.name.text, locals.get(property.name.text)));
      } else if (ts.isPropertyAssignment(property) && propertyNameText(ts, property.name) !== undefined) {
        result.entries.push(fromExpression(ts, propertyNameText(ts, property.name)!, property.initializer, locals));
      } else if (ts.isMethodDeclaration(property) && propertyNameText(ts, property.name) !== undefined) {
        result.entries.push({ name: propertyNameText(ts, property.name)!, kind: 'function', params: signatureOf(ts, [property]) });
      } else if ((ts.isGetAccessor(property) || ts.isSetAccessor(property)) && propertyNameText(ts, property.name) !== undefined) {
        result.entries.push({ name: propertyNameText(ts, property.name)!, kind: 'variable' });
      } else {
        fail('module.exports-computed-or-spread');
      }
    }
  };

  visit(source);
  if (!exportsShadowed) {
    for (const identifier of bareExports) {
      result.used = true;
      const parent = identifier.parent;
      if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === identifier) {
        const value = isTopLevelAssignment(ts, parent, source);
        if (value !== undefined) result.entries.push(fromExpression(ts, parent.name.text, value, locals));
        else fail('exports-dynamic-use');
      } else {
        fail('exports-dynamic-use');
      }
    }
  }
  return result;
}

function propertyNameText(ts: typeof TS, name: TS.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
  return undefined;
}

// ---------------------------------------------------------------------------
// Import bindings (consumer side)
// ---------------------------------------------------------------------------

export type BindingKind =
  | 'named'
  | 'default'
  | 'namespace'
  | 'dynamic'
  | 'require-destructure'
  | 'require-property'
  | 'require-whole'
  | 're-export'
  | 're-export-star'
  | 're-export-namespace'
  | 'side-effect';

export interface ImportBinding {
  specifier: string;
  kind: BindingKind;
  /** The name in the target module (`default` for default imports). */
  imported?: string;
  /** For re-exports: the name this file exports it as. */
  exportedAs?: string;
  typeOnly?: boolean;
  mode: 'import' | 'require';
}

export interface FileBindings {
  bindings: ImportBinding[];
  parseFailed: boolean;
}

export function extractBindings(fileName: string, sourceText: string): FileBindings {
  return bindingsOf(parseSource(fileName, sourceText));
}

export function bindingsOf(source: TS.SourceFile): FileBindings {
  const ts = typescript();
  const bindings: ImportBinding[] = [];
  /** Local name → the import that created it (for import-then-export). */
  const importedLocals = new Map<string, { specifier: string; imported: string; mode: 'import' | 'require'; typeOnly?: boolean }>();
  const push = (binding: ImportBinding) => {
    if (!binding.typeOnly) delete binding.typeOnly;
    bindings.push(binding);
  };

  const visit = (node: TS.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (!clause) {
        push({ specifier, kind: 'side-effect', mode: 'import' });
        return;
      }
      if (clause.name) {
        push({ specifier, kind: 'default', imported: 'default', typeOnly: clause.isTypeOnly, mode: 'import' });
        importedLocals.set(clause.name.text, { specifier, imported: 'default', mode: 'import', typeOnly: clause.isTypeOnly });
      }
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        push({ specifier, kind: 'namespace', typeOnly: clause.isTypeOnly, mode: 'import' });
      } else if (named) {
        for (const element of named.elements) {
          const imported = (element.propertyName ?? element.name).text;
          const typeOnly = clause.isTypeOnly || element.isTypeOnly;
          push({ specifier, kind: imported === 'default' ? 'default' : 'named', imported, typeOnly, mode: 'import' });
          importedLocals.set(element.name.text, { specifier, imported, mode: 'import', typeOnly });
        }
      }
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const clause = node.exportClause;
      if (!clause) push({ specifier, kind: 're-export-star', typeOnly: node.isTypeOnly, mode: 'import' });
      else if (ts.isNamespaceExport(clause)) push({ specifier, kind: 're-export-namespace', exportedAs: clause.name.text, typeOnly: node.isTypeOnly, mode: 'import' });
      else {
        for (const element of clause.elements) {
          push({
            specifier,
            kind: 're-export',
            imported: (element.propertyName ?? element.name).text,
            exportedAs: element.name.text,
            typeOnly: node.isTypeOnly || element.isTypeOnly,
            mode: 'import',
          });
        }
      }
      return;
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
      push({ specifier: node.moduleReference.expression.text, kind: 'require-whole', typeOnly: node.isTypeOnly, mode: 'require' });
      return;
    }
    if (ts.isCallExpression(node)) {
      const specifier = requireCall(ts, node);
      if (specifier !== undefined) {
        readRequire(node, specifier);
      } else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument)) push({ specifier: argument.text, kind: 'dynamic', mode: 'import' });
      }
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      const specifier = node.argument.literal.text;
      if (node.qualifier) {
        let first: TS.EntityName = node.qualifier;
        while (ts.isQualifiedName(first)) first = first.left;
        push({ specifier, kind: 'named', imported: first.text, typeOnly: true, mode: 'import' });
      } else {
        push({ specifier, kind: 'namespace', typeOnly: true, mode: 'import' });
      }
    }
    ts.forEachChild(node, visit);
  };

  const readRequire = (call: TS.CallExpression, specifier: string) => {
    let outer: TS.Node = call;
    while (outer.parent && (ts.isParenthesizedExpression(outer.parent) || ts.isAsExpression(outer.parent) || ts.isNonNullExpression(outer.parent))) outer = outer.parent;
    const parent = outer.parent;
    if (parent && ts.isVariableDeclaration(parent) && parent.initializer === outer && ts.isObjectBindingPattern(parent.name)) {
      for (const element of parent.name.elements) {
        const property = element.propertyName;
        if (element.dotDotDotToken || (property && !(ts.isIdentifier(property) || ts.isStringLiteral(property)))) {
          push({ specifier, kind: 'require-whole', mode: 'require' });
          continue;
        }
        const imported = property ? (property as TS.Identifier | TS.StringLiteral).text : ts.isIdentifier(element.name) ? element.name.text : undefined;
        if (imported === undefined) {
          push({ specifier, kind: 'require-whole', mode: 'require' });
          continue;
        }
        push({ specifier, kind: 'require-destructure', imported, mode: 'require' });
        if (ts.isIdentifier(element.name)) importedLocals.set(element.name.text, { specifier, imported, mode: 'require' });
      }
      return;
    }
    if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === outer) {
      push({ specifier, kind: 'require-property', imported: parent.name.text, mode: 'require' });
      const declaration = parent.parent;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer === parent && ts.isIdentifier(declaration.name)) {
        importedLocals.set(declaration.name.text, { specifier, imported: parent.name.text, mode: 'require' });
      }
      return;
    }
    if (parent && ts.isExpressionStatement(parent)) {
      push({ specifier, kind: 'side-effect', mode: 'require' });
      return;
    }
    push({ specifier, kind: 'require-whole', mode: 'require' });
  };

  visit(source);

  // Import-then-export: `import { a } from './x'; export { a as b }` re-exports `a` as `b`.
  const reexportLocal = (local: string, exportedAs: string, typeOnly: boolean) => {
    const origin = importedLocals.get(local);
    if (!origin) return;
    push({ specifier: origin.specifier, kind: 're-export', imported: origin.imported, exportedAs, typeOnly: typeOnly || origin.typeOnly, mode: origin.mode });
  };
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        reexportLocal((element.propertyName ?? element.name).text, element.name.text, statement.isTypeOnly || element.isTypeOnly);
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression)) {
      reexportLocal(statement.expression.text, 'default', false);
    } else if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
      && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const { left, right } = statement.expression;
      if (isModuleExports(ts, left) && ts.isObjectLiteralExpression(right)) {
        for (const property of right.properties) {
          if (ts.isShorthandPropertyAssignment(property)) reexportLocal(property.name.text, property.name.text, false);
          else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer) && propertyNameText(ts, property.name) !== undefined) {
            reexportLocal(property.initializer.text, propertyNameText(ts, property.name)!, false);
          }
        }
      } else if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(right)
        && (isModuleExports(ts, left.expression) || (ts.isIdentifier(left.expression) && left.expression.text === 'exports'))) {
        reexportLocal(right.text, left.name.text, false);
      }
    }
  }

  return { bindings, parseFailed: hasParseErrors(source) };
}
