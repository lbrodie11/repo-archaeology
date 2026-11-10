/**
 * RA-18 research oracle: TypeScript's language service over a git tree (no checkout, no
 * node_modules, no network, nothing from the repository executed). Used only by the
 * research scripts, as ground truth independent of `src/surface/` (which never builds a
 * Program). See docs/research/surface-pilot.md, section 3.
 */
import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import type * as TS from 'typescript';
import { typescript } from '../../src/imports/typescript.js';
import type { RepoFiles } from '../../src/imports/tree-files.js';

export const VIRTUAL_ROOT = '/repo';
const TS_OR_JS = /\.(?:[cm]?[jt]sx?)$/i;

export const toVirtual = (path: string): string => `${VIRTUAL_ROOT}/${path}`;
export const fromVirtual = (path: string): string | undefined =>
  path.startsWith(`${VIRTUAL_ROOT}/`) ? path.slice(VIRTUAL_ROOT.length + 1) : undefined;

/** Files the oracle program includes: every JS/TS file outside `node_modules/` and `fixtures/`. */
export function oracleRootFiles(paths: Iterable<string>): string[] {
  return [...paths].filter((p) => TS_OR_JS.test(p) && !/(?:^|\/)(?:node_modules|fixtures)\//.test(p)).sort();
}

class TreeHost {
  readonly dirs = new Set<string>();
  readonly overrides = new Map<string, string>();
  constructor(readonly files: RepoFiles) {
    for (const path of files.list()) {
      let dir = posix.dirname(path);
      while (dir !== '.' && !this.dirs.has(dir)) {
        this.dirs.add(dir);
        dir = posix.dirname(dir);
      }
    }
  }
  readFile(path: string): string | undefined {
    const repoPath = fromVirtual(path);
    if (repoPath === undefined) return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    return this.overrides.get(repoPath) ?? this.files.read(repoPath);
  }
  fileExists(path: string): boolean {
    const repoPath = fromVirtual(path);
    if (repoPath === undefined) return existsSync(path);
    return this.overrides.has(repoPath) || this.files.exists(repoPath);
  }
  directoryExists(path: string): boolean {
    if (path === VIRTUAL_ROOT) return true;
    const repoPath = fromVirtual(path);
    if (repoPath === undefined) return existsSync(path);
    return this.dirs.has(repoPath.replace(/\/$/, ''));
  }
}

/** The repository's `tsconfig.json` compiler options (relative `extends` followed), or `{}`. */
export function readRootOptions(files: RepoFiles, configPath = 'tsconfig.json'): { options: TS.CompilerOptions; error?: string } {
  const ts = typescript();
  const host = new TreeHost(files);
  const text = host.readFile(toVirtual(configPath));
  if (text === undefined) return { options: {}, error: `${configPath} not found` };
  const json = ts.parseConfigFileTextToJson(toVirtual(configPath), text);
  if (json.error) return { options: {}, error: `${configPath} is not valid JSON` };
  const parsed = ts.parseJsonConfigFileContent(
    json.config,
    {
      useCaseSensitiveFileNames: true,
      readDirectory: () => [],
      fileExists: (p) => host.fileExists(p),
      readFile: (p) => host.readFile(p),
    },
    posix.dirname(toVirtual(configPath)),
    undefined,
    toVirtual(configPath),
  );
  // 6053 "File not found" / 5083 "Cannot read file": an `extends` (often a package) that is not in the tree.
  const unreadableExtends = parsed.errors.find((d) => d.code === 6053 || d.code === 5083);
  if (unreadableExtends) return { options: parsed.options, error: ts.flattenDiagnosticMessageText(unreadableExtends.messageText, '\n') };
  return { options: parsed.options };
}

export interface OracleOptions {
  /** Read compiler options from this config (default `tsconfig.json`), when it exists. */
  configPath?: string;
  /** CommonJS defaults when the repository has no root tsconfig. */
  commonJs?: boolean;
}

export class Oracle {
  readonly ts: typeof TS = typescript();
  readonly service: TS.LanguageService;
  readonly rootFiles: string[];
  private readonly host: TreeHost;
  private versions = new Map<string, number>();

  constructor(files: RepoFiles, options: OracleOptions = {}) {
    const ts = this.ts;
    this.host = new TreeHost(files);
    this.rootFiles = oracleRootFiles(files.list());
    const root = readRootOptions(files, options.configPath ?? 'tsconfig.json');
    const compilerOptions: TS.CompilerOptions = {
      ...root.options,
      allowJs: true,
      checkJs: false,
      noEmit: true,
      skipLibCheck: true,
      types: [],
      composite: false,
      incremental: false,
      declaration: false,
      isolatedDeclarations: false,
      jsx: root.options.jsx ?? ts.JsxEmit.Preserve,
      target: root.options.target ?? ts.ScriptTarget.ESNext,
    };
    if (root.error && options.commonJs) {
      compilerOptions.module = ts.ModuleKind.CommonJS;
      compilerOptions.moduleResolution = ts.ModuleResolutionKind.Node10;
    }
    delete compilerOptions.tsBuildInfoFile;
    delete compilerOptions.outDir;
    delete compilerOptions.rootDir;
    const host = this.host;
    const serviceHost: TS.LanguageServiceHost = {
      getCompilationSettings: () => compilerOptions,
      getScriptFileNames: () => this.rootFiles.map(toVirtual),
      getScriptVersion: (fileName) => String(this.versions.get(fileName) ?? 0),
      getScriptSnapshot: (fileName) => {
        const text = host.readFile(fileName);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => VIRTUAL_ROOT,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: (p) => host.fileExists(p),
      readFile: (p) => host.readFile(p),
      directoryExists: (p) => host.directoryExists(p),
      getDirectories: () => [],
      useCaseSensitiveFileNames: () => true,
    };
    this.service = ts.createLanguageService(serviceHost, ts.createDocumentRegistry());
  }

  program(): TS.Program {
    return this.service.getProgram()!;
  }

  sourceFile(path: string): TS.SourceFile | undefined {
    return this.program().getSourceFile(toVirtual(path));
  }

  /** Exported symbols of a module, as the checker sees them (CommonJS included). */
  exportsOf(path: string): TS.Symbol[] {
    const source = this.sourceFile(path);
    if (!source) return [];
    const checker = this.program().getTypeChecker();
    const moduleSymbol = checker.getSymbolAtLocation(source) ?? (source as unknown as { symbol?: TS.Symbol }).symbol;
    if (!moduleSymbol) return [];
    return checker.getExportsOfModule(moduleSymbol);
  }

  /** References to the symbol declared at `node`, outside its own file and outside export specifiers. */
  externalReferences(path: string, position: number): { file: string; position: number; call: boolean }[] {
    const referenced = this.service.findReferences(toVirtual(path), position) ?? [];
    const out: { file: string; position: number; call: boolean }[] = [];
    const seen = new Set<string>();
    for (const group of referenced) {
      for (const ref of group.references) {
        const file = fromVirtual(ref.fileName);
        if (file === undefined || file === path) continue;
        const key = `${file}:${ref.textSpan.start}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const source = this.sourceFile(file);
        if (!source) continue;
        const node = findNode(this.ts, source, ref.textSpan.start, ref.textSpan.length);
        if (!node || isInsideExport(this.ts, node)) continue;
        out.push({ file, position: ref.textSpan.start, call: isCallee(this.ts, node) });
      }
    }
    return out;
  }

  renameLocations(path: string, position: number): readonly TS.RenameLocation[] | undefined {
    return this.service.findRenameLocations(toVirtual(path), position, false, false, { providePrefixAndSuffixTextForRename: true });
  }
}

export function findNode(ts: typeof TS, source: TS.SourceFile, start: number, length: number): TS.Node | undefined {
  let found: TS.Node | undefined;
  const visit = (node: TS.Node) => {
    if (node.getStart(source) <= start && node.getEnd() >= start + length) {
      if (node.getStart(source) === start && node.getEnd() === start + length) found = node;
      ts.forEachChild(node, visit);
    }
  };
  visit(source);
  return found;
}

function isInsideExport(ts: typeof TS, node: TS.Node): boolean {
  for (let current: TS.Node | undefined = node; current; current = current.parent) {
    if (ts.isExportSpecifier(current) || ts.isExportDeclaration(current) || ts.isExportAssignment(current)) return true;
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

function isCallee(ts: typeof TS, node: TS.Node): boolean {
  let target: TS.Node = node;
  const parent = node.parent;
  if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) target = parent;
  const call = target.parent;
  return Boolean(call && (ts.isCallExpression(call) || ts.isNewExpression(call)) && call.expression === target);
}

export interface TypecheckOracleResult {
  oracle: 'error' | 'no-error' | 'unavailable';
  reason?: string;
  codes?: number[];
}

const NAME_CODES = new Set([2305, 2307, 2339, 2459, 2460, 2614, 2724]);

/**
 * Type-checks one consumer file with the program its config describes (read from the tree,
 * no node_modules), and reports whether a diagnostic in that file names `removedName`.
 */
export function typecheckConsumer(files: RepoFiles, configPath: string, consumer: string, removedName: string): TypecheckOracleResult {
  const ts = typescript();
  const root = readRootOptions(files, configPath);
  if (root.error) return { oracle: 'unavailable', reason: root.error };
  const host = new TreeHost(files);
  const options: TS.CompilerOptions = { ...root.options, noEmit: true, skipLibCheck: true, types: [], composite: false, incremental: false };
  delete options.tsBuildInfoFile;
  const compilerHost = ts.createCompilerHost(options, true);
  compilerHost.getCurrentDirectory = () => VIRTUAL_ROOT;
  compilerHost.fileExists = (p) => host.fileExists(p);
  compilerHost.readFile = (p) => host.readFile(p);
  compilerHost.directoryExists = (p) => host.directoryExists(p);
  compilerHost.getDirectories = () => [];
  compilerHost.realpath = (p) => p;
  const originalGetSourceFile = compilerHost.getSourceFile.bind(compilerHost);
  compilerHost.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = host.readFile(fileName);
    if (text === undefined) return fromVirtual(fileName) === undefined ? originalGetSourceFile(fileName, languageVersion, onError, shouldCreate) : undefined;
    return ts.createSourceFile(fileName, text, languageVersion, true);
  };
  const program = ts.createProgram({ rootNames: [toVirtual(consumer)], options, host: compilerHost });
  const source = program.getSourceFile(toVirtual(consumer));
  if (!source) return { oracle: 'unavailable', reason: 'consumer not in program' };
  const diagnostics = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
  const quoted = [`'${removedName}'`, `"${removedName}"`];
  const hits = diagnostics.filter((d) => NAME_CODES.has(d.code) && quoted.some((q) => ts.flattenDiagnosticMessageText(d.messageText, '\n').includes(q)));
  return hits.length > 0 ? { oracle: 'error', codes: [...new Set(hits.map((d) => d.code))].sort() } : { oracle: 'no-error' };
}
