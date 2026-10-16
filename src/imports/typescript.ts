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

/**
 * Module specifiers referenced by a JS/TS source file: static imports, `export … from`,
 * `require()`, dynamic `import()` and side-effect imports. Uses TypeScript's
 * pre-processor, which understands comments and strings, unlike a regex.
 */
export function extractSpecifiers(sourceText: string): string[] {
  return extractDependencies(sourceText).specifiers;
}

export function extractDependencies(sourceText: string, fileName = 'file.tsx'): { specifiers: string[]; referencePaths: string[]; nonLiteralLoads: number } {
  const ts = typescript();
  const info = ts.preProcessFile(sourceText, true, true);
  return {
    specifiers: info.importedFiles.map((file) => file.fileName),
    referencePaths: info.referencedFiles.map((file) => file.fileName),
    nonLiteralLoads: countNonLiteralLoads(sourceText, fileName),
  };
}

/** Cheap pre-check so most files never need a full parse. */
const MAYBE_DYNAMIC = /\brequire\b|\bimport\s*\(|\bimport\.meta\.glob\b/;

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
        const importMetaGlob = name === 'glob' && ts.isMetaProperty(target) && target.keywordToken === ts.SyntaxKind.ImportKeyword;
        const requireContext = name === 'context' && ts.isIdentifier(target) && target.text === 'require';
        if (importMetaGlob || requireContext) count++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

