/**
 * RA-18 surface pilot: internal research types. Nothing here is part of the v1
 * JSON contract, the CLI or the library API.
 */

export type ExportKind = 'function' | 'class' | 'variable' | 'type' | 'interface' | 'enum' | 'namespace' | 're-export';

/** Merged declarations take the first kind in this order. */
export const KIND_PRIORITY: readonly ExportKind[] = ['class', 'function', 'enum', 'variable', 'interface', 'type', 'namespace', 're-export'];

export interface Signature {
  /** TypeScript's minimum argument count (last parameter without `?`, initializer or `...`, plus one). */
  required: number;
  /** Every parameter, rest included (`this` excluded). */
  total: number;
  rest: boolean;
}

export interface SurfaceExport {
  /** Exported name; `default` for default exports. */
  name: string;
  kind: ExportKind;
  typeOnly?: boolean;
  params?: Signature;
  /** Interfaces and object-literal type aliases: required top-level property names, sorted. */
  requiredProps?: string[];
  /** Re-exports: the module specifier and the name in that module. */
  from?: string;
  importedName?: string;
}

export interface OpaqueReexport {
  specifier: string;
  /** `export * as ns from …` */
  namespace?: string;
}

export type SurfaceStatus = 'known' | 'unknown' | 'unavailable';

export interface Surface {
  status: SurfaceStatus;
  /** Why the surface is `unknown` or `unavailable`. */
  reason?: string;
  module: 'esm' | 'cjs' | 'none';
  /** Sorted by name, one entry per name. */
  exports: SurfaceExport[];
  opaque: OpaqueReexport[];
}

export type ChangeReason = 'kind-changed' | 'required-params-increased' | 'required-props-added' | 'required-props-removed';

export interface DeltaEntry {
  name: string;
  change: 'removed' | 'added' | 'changed';
  reasons?: ChangeReason[];
  propsAdded?: string[];
  propsRemoved?: string[];
  base?: SurfaceExport;
  head?: SurfaceExport;
}

export interface FileDelta {
  file: string;
  /** `unknown` when either side's surface is `unknown` or `unavailable`. */
  status: 'known' | 'unknown';
  reason?: string;
  fileStatus: 'added' | 'modified' | 'deleted';
  entries: DeltaEntry[];
  opaqueAdded: string[];
  opaqueRemoved: string[];
}

export type ConsumerStatus = 'uses-removed-name' | 'uses-changed-export' | 'uncertain';

export type UncertainReason =
  | 'namespace-import'
  | 'dynamic-import'
  | 'opaque-re-export'
  | 'unresolved-specifier'
  | 'parse-failure'
  | 'file-too-large'
  | 'symlink'
  | 'barrel-depth';

export type CompilerCoverage = 'typechecked' | 'not-typechecked' | 'unknown';

export interface ConsumerUse {
  /** The changed file and the affected name in it. */
  file: string;
  name: string;
  status: ConsumerStatus;
  reason?: UncertainReason;
  /** How the consumer names it: `named`, `default`, `require-destructure`, `re-export`, … */
  via: string;
  /** Files between the consumer and the changed file (explicit re-export barrels), nearest first. */
  through: string[];
  /** The specifier the consumer wrote. */
  specifier?: string;
}

export interface Consumer {
  consumer: string;
  /** Strongest status over `uses`. */
  status: ConsumerStatus;
  coverage: CompilerCoverage;
  coverageReason?: string;
  uses: ConsumerUse[];
}

export interface SurfaceAnalysis {
  base: string;
  head: string;
  changedSourceFiles: string[];
  deltas: FileDelta[];
  consumers: Consumer[];
  /** Source files at head that could not be read (too large or symlinks). */
  skippedFiles: { path: string; reason: 'file-too-large' | 'symlink' }[];
  stats: { sourceFiles: number; parsedImporters: number; ms: number };
}
