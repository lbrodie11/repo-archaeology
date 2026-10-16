import type * as TS from 'typescript';
import { typescript } from './typescript.js';

export type SourceReferenceKind = 'environment' | 'api-route' | 'event';

export interface SourceReference {
  kind: SourceReferenceKind;
  value: string;
}

const EVENT_METHODS = new Set(['addListener', 'emit', 'off', 'on', 'once', 'publish', 'removeListener', 'subscribe', 'trigger']);
const API_ROUTE = /^\/api(?:\/|$)\S*$/;
const EVENT_NAME = /^[a-z][a-z0-9_-]*(?:[.:][a-z][a-z0-9_-]*)+$/;

/** Finds high-confidence shared references in actual JS/TS syntax nodes. */
export function extractSourceReferences(fileName: string, sourceText: string): SourceReference[] {
  const ts = typescript();
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false, scriptKind(ts, fileName));
  const found = new Map<string, SourceReference>();
  const add = (kind: SourceReferenceKind, value: string) => found.set(keyOf(kind, value), { kind, value });

  const visit = (node: TS.Node, parent?: TS.Node): void => {
    const environment = environmentName(ts, node);
    if (environment) add('environment', environment);

    if (ts.isStringLiteralLike(node) && !isModuleSpecifier(ts, node, parent)) {
      if (API_ROUTE.test(node.text)) add('api-route', node.text);
      if (EVENT_NAME.test(node.text) && isEventArgument(ts, node, parent)) add('event', node.text);
    }
    ts.forEachChild(node, (child) => visit(child, node));
  };

  visit(source);
  return [...found.values()];
}

export function sourceReferenceKey(reference: SourceReference): string {
  return keyOf(reference.kind, reference.value);
}

function keyOf(kind: SourceReferenceKind, value: string): string {
  return `${kind}\0${value}`;
}

function environmentName(ts: typeof TS, node: TS.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node) && isEnvironmentObject(ts, node.expression)) return node.name.text;
  if (ts.isElementAccessExpression(node) && isEnvironmentObject(ts, node.expression)) {
    const argument = node.argumentExpression;
    if (argument && ts.isStringLiteralLike(argument)) return argument.text;
  }
  return undefined;
}

function isEnvironmentObject(ts: typeof TS, node: TS.Expression): boolean {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'env') return false;
  if (ts.isIdentifier(node.expression)) return node.expression.text === 'process';
  return ts.isMetaProperty(node.expression)
    && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    && node.expression.name.text === 'meta';
}

function isModuleSpecifier(ts: typeof TS, node: TS.StringLiteralLike, parent?: TS.Node): boolean {
  if (!parent) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return parent.moduleSpecifier === node;
  if (ts.isExternalModuleReference(parent)) return parent.expression === node;
  if (!ts.isCallExpression(parent) || parent.arguments[0] !== node) return false;
  return parent.expression.kind === ts.SyntaxKind.ImportKeyword
    || (ts.isIdentifier(parent.expression) && parent.expression.text === 'require');
}

function isEventArgument(ts: typeof TS, node: TS.StringLiteralLike, parent?: TS.Node): boolean {
  if (!parent || !ts.isCallExpression(parent) || parent.arguments[0] !== node) return false;
  const callee = parent.expression;
  const name = ts.isPropertyAccessExpression(callee)
    ? callee.name.text
    : ts.isElementAccessExpression(callee) && callee.argumentExpression && ts.isStringLiteralLike(callee.argumentExpression)
      ? callee.argumentExpression.text
      : undefined;
  return name !== undefined && EVENT_METHODS.has(name);
}

function scriptKind(ts: typeof TS, fileName: string): TS.ScriptKind {
  if (/\.tsx$/i.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(fileName)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}