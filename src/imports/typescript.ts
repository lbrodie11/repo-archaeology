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

export function extractDependencies(sourceText: string): { specifiers: string[]; referencePaths: string[] } {
  const ts = typescript();
  const info = ts.preProcessFile(sourceText, true, true);
  return {
    specifiers: info.importedFiles.map((file) => file.fileName),
    referencePaths: info.referencedFiles.map((file) => file.fileName),
  };
}
