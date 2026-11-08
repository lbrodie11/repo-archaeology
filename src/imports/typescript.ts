import { createRequire } from 'node:module';
import type * as TS from 'typescript';

let cached: typeof TS | undefined;

/**
 * Loads the TypeScript compiler lazily: it is large, and commands like
 * `backtest` never need it.
 */
export function typescript(): typeof TS {
  if (!cached) {
    const require = createRequire(import.meta.url);
    cached = require('typescript') as typeof TS;
  }
  return cached;
}

export type ImportEdgeKind = 'static' | 'dynamic' | 'reexport' | 'require';

export interface ExtractedImport {
  specifier: string;
  kind: ImportEdgeKind;
  typeOnly?: boolean;
}

/**
 * Module specifiers referenced by a JS/TS source file: static imports, `export … from`,
 * `require()`, dynamic `import()` and side-effect imports. Uses TypeScript's
 * pre-processor, which understands comments and strings, unlike a regex.
 */
export function extractSpecifiers(sourceText: string): string[] {
  return extractDependencies(sourceText).specifiers;
}

export function extractDependencies(
  sourceText: string,
  fileName = 'file.tsx',
): {
  specifiers: string[];
  referencePaths: string[];
  nonLiteralLoads: number;
} {
  const { imports, referencePaths, nonLiteralLoads } = extractDetailedDependencies(sourceText, fileName);
  return {
    specifiers: imports.map((item) => item.specifier),
    referencePaths,
    nonLiteralLoads,
  };
}

/**
 * Parses a JS/TS source file's AST to extract module specifiers together with their
 * import syntax kind (`'static' | 'dynamic' | 'reexport' | 'require'`), triple-slash
 * `<reference path="..." />` directives, and non-literal dynamic load count.
 */
export function extractDetailedDependencies(
  sourceText: string,
  fileName = 'file.tsx',
): { imports: ExtractedImport[]; referencePaths: string[]; nonLiteralLoads: number } {
  const ts = typescript();
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false);
  const imports: ExtractedImport[] = [];
  const isLiteral = (node: TS.Node | undefined): node is TS.StringLiteralLike =>
    node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));

  const visit = (node: TS.Node): void => {
    if (ts.isImportDeclaration(node) && isLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const allNamedTypeOnly =
        clause !== undefined &&
        clause.name === undefined &&
        clause.namedBindings !== undefined &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((el) => el.isTypeOnly);
      const typeOnly = Boolean(clause?.isTypeOnly || allNamedTypeOnly);
      imports.push({
        specifier: node.moduleSpecifier.text,
        kind: 'static',
        ...(typeOnly ? { typeOnly: true } : {}),
      });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && isLiteral(node.moduleSpecifier)) {
      const allNamedTypeOnly =
        node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.length > 0 &&
        node.exportClause.elements.every((el) => el.isTypeOnly);
      const typeOnly = Boolean(node.isTypeOnly || allNamedTypeOnly);
      imports.push({
        specifier: node.moduleSpecifier.text,
        kind: 'reexport',
        ...(typeOnly ? { typeOnly: true } : {}),
      });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isLiteral(node.moduleReference.expression)
    ) {
      imports.push({
        specifier: node.moduleReference.expression.text,
        kind: 'require',
        ...(node.isTypeOnly ? { typeOnly: true } : {}),
      });
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg = node.arguments[0];
      if (isLiteral(arg)) {
        if (callee.kind === ts.SyntaxKind.ImportKeyword) {
          imports.push({ specifier: arg.text, kind: 'dynamic' });
        } else if (ts.isIdentifier(callee) && callee.text === 'require') {
          imports.push({ specifier: arg.text, kind: 'require' });
        }
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      isLiteral(node.argument.literal)
    ) {
      imports.push({ specifier: node.argument.literal.text, kind: 'static', typeOnly: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return {
    imports,
    referencePaths: source.referencedFiles.map((file) => file.fileName),
    nonLiteralLoads: countNonLiteralLoads(sourceText, fileName),
  };
}

/** Cheap pre-check so most files never need a full parse. */
const MAYBE_DYNAMIC = /\brequire\b|\bimport\s*[(<]|\bimport\s*\/\*|\bimport\s*\.\s*meta\b/;

/**
 * Loads whose target cannot be read from the source: `import(name)`, `require(name)`,
 * template literals with substitutions, `import.meta.glob(...)` and `require.context(...)`.
 * `preProcessFile` silently drops these, so without counting them a file that loads its
 * partner dynamically would look like it has no import link at all.
 */
export function countNonLiteralLoads(sourceText: string, fileName = 'file.tsx'): number {
  if (!MAYBE_DYNAMIC.test(sourceText)) return 0;
  const ts = typescript();
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false);
  let count = 0;
  const isLiteral = (node: TS.Node | undefined) => node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
  const visit = (node: TS.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const loader = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require');
      if (loader && !isLiteral(node.arguments[0])) count++;
      if (ts.isPropertyAccessExpression(callee)) {
        const target = callee.expression;
        const name = callee.name.text;
        const importMetaGlob = (name === 'glob' || name === 'globEager') && ts.isMetaProperty(target) && target.keywordToken === ts.SyntaxKind.ImportKeyword;
        const requireContext = name === 'context' && ts.isIdentifier(target) && target.text === 'require';
        if (importMetaGlob || requireContext) count++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

