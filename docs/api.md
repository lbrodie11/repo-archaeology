# Library API & Stability Policy (`repo-archaeology`)

`repo-archaeology` ships a typed ESM entry point (`import { openRepository } from 'repo-archaeology'`) so tools like [Gutter](https://github.com/lbrodie11/gutter) can load Git history once per session, run multiple analyses (`diff`, `backtest`, `importGraph`, `scan`, `file`, `explain`), and receive the exact `schemaVersion: 1` objects that the CLI prints with `--json`.

---

## 1. Stability Policy & Semantic Versioning

### Versioning Rules
- **While `>= 1.0.0`:** Any breaking change to exported function signatures, option types, error classes, or returned JSON fields requires a **major version bump** (`2.0.0`, etc.). Minor and patch releases are strictly backward-compatible (only optional options or additive optional output fields).
- **During `0.x` (`0.3.x`, `0.4.x`, etc.):** Any breaking change to the library API requires a **minor version bump** (for example, `0.3.x` → `0.4.0`) and an explicit **`BREAKING`** note in [`CHANGELOG.md`](../CHANGELOG.md). Patch releases (`0.3.0` → `0.3.1`) never introduce breaking changes.
- **Frozen JSON Contract (`schemaVersion: 1`):** Return values conform to the [JSON Output Contract (`v1`)](./json.md) and its Draft 2020-12 JSON Schemas in [`schema/`](../schema). Existing fields are never renamed, removed, or retyped in `schemaVersion: 1`.

### CLI `--json` Parity Guarantee
Every `Repository` method (`diff`, `scan`, `file`, `explain`, `backtest`, `importGraph`) calls the exact same underlying analysis and `withJsonContract` envelope builder as the CLI's `--json` flag. For the same repository state and options, the object returned by a `Repository` method is **byte-for-byte deep-equal** to `JSON.parse` of the corresponding `repo-archaeology <command> --json` output.

### Side-Effect-Free Execution in Library Mode
Library API calls:
- **Never write to `process.stdout` or `process.stderr`** (even when `process.stderr.isTTY` is `true`).
- **Never call `process.exit`** or mutate `process.exitCode`.
- **Never open a browser.**
- **Route progress exclusively through `onProgress`** when provided.
- **Throw typed errors** (`UsageError`, `GitError`, `ConfigError`, or `AbortError` when `signal` is aborted).
- **Local history cache under `.git`:** By default, `openRepository()` reads and updates the incremental commit history cache under `<git-common-dir>/repo-archaeology/cache/` (never touching the working tree or git refs). Pass `settings: { cache: { enabled: false } }` for strictly read-only filesystem execution.

### Supported Node.js Versions & Package Exports
- **Node.js `>= 22`** (matches `"engines": { "node": ">=22" }` in [`package.json`](../package.json)).
- **TypeScript declarations:** Bundled at `dist/api/index.d.ts` via `"exports"` in `package.json`.
- **Exported subpaths:**
  - `.`: Library entry point (`import { openRepository } from 'repo-archaeology'`, and `require('repo-archaeology')` on Node `>= 22.12`).
  - `./schema/*`: Draft 2020-12 JSON Schema files (for example, `import diffSchema from 'repo-archaeology/schema/diff.schema.json' with { type: 'json' }` or `require.resolve('repo-archaeology/schema/diff.schema.json')`).
  - `./package.json`: Package manifest.
  - Deep internal imports such as `repo-archaeology/dist/*` are not exported.

---

## 2. Session API Reference

```ts
import {
  openRepository,
  IMPORT_UNRESOLVED_REASON_CODES,
  type OpenOptions,
  type Repository,
  type DiffJson,
  type ScanJson,
  type FileJson,
  type ExplainJson,
  type BacktestJson,
  type ImportGraphJson,
  type ImportResolutionVia,
  type ImportUnresolvedReasonCode,
  type ImportsCoverageMeta,
  type Relationship,
  type Settings,
  UsageError,
  GitError,
  ConfigError,
} from 'repo-archaeology';
```

### `openRepository(opts: OpenOptions): Promise<Repository>`

Loads Git history and builds the co-change model **once** for the session.

```ts
export interface OpenOptions {
  cwd: string;                  // any path inside the repo
  head?: string;                // RA-02 semantics; default: checked-out HEAD + working tree
  base?: string;                // merge-base isolation, same as --base
  settings?: Partial<Settings>; // same keys as .repo-archaeology.json / CLI flags (maxCommits, maxFiles, minShared, minConfidence, halfLife, skipCommits, ignore, defaultIgnores, cache: { dir?, enabled? })
  useConfigFile?: boolean;      // default true: merge .repo-archaeology.json under explicit settings
  onProgress?: (e: { phase: string; done?: number; total?: number }) => void;
  signal?: AbortSignal;         // cancel long history loads (rejects with AbortError)
}
```

### `Repository`

```ts
export interface Repository {
  readonly root: string;
  readonly headSha: string;
  readonly mergeBaseSha?: string;
  diff(opts?: { limit?: number; kinds?: Relationship[]; base?: string; applyBranchVerdicts?: boolean }): Promise<DiffJson>;
  scan(opts?: { limit?: number; kinds?: Relationship[]; uncheckedCap?: number; showSilenced?: boolean }): Promise<ScanJson>;
  file(path: string, opts?: { limit?: number; showSilenced?: boolean }): Promise<FileJson>;
  explain(a: string, b: string, opts?: { commits?: number; counterexamples?: boolean; context?: number }): Promise<ExplainJson>;
  backtest(opts?: { testFraction?: number; k?: number; before?: string | number; ghosts?: boolean; followUps?: boolean; followUpWindowHours?: number; compareOriginWeights?: string | readonly string[] }): Promise<BacktestJson>;
  importGraph(opts?: { files?: string[] }): Promise<ImportGraphJson>;
  close(): Promise<void>;       // releases git child processes (e.g. RA-02's cat-file)
}
```

- **One history load:** `openRepository` reads `git log` once and builds the `CoChangeModel` in memory. Subsequent calls to `diff`, `scan`, `file`, `explain`, `backtest`, and `importGraph` reuse the loaded session without re-reading `git log`.
- **Sessions are point-in-time snapshots:** Working-tree edits made after `openRepository()` resolves are not seen by an existing session because the tracked/working-tree file set, `RelationshipClassifier` cache, and `importGraph` reverse index are bound to the session. Open a new `openRepository()` session to analyze subsequent working-tree edits.
- **`importGraph({ files })`:** Returns `{ schemaVersion: 1, tool, meta, files, edges, unresolved, languages }` ([`schema/import-graph.schema.json`](../schema/import-graph.schema.json)). `edges` include only internal files present at head (`kind: 'static' | 'dynamic' | 'reexport' | 'require'`, `via?: 'relative' | 'paths' | 'workspace' | 'exports' | 'imports'`, `heuristic?: boolean`). `unresolved` entries preserve `reason: 'unmatched'` and include `reasonCode?: ImportUnresolvedReasonCode` (`'alias-unmatched' | 'unknown-package' | 'target-missing' | 'not-exported' | 'invalid-target' | 'unsupported-config' | 'ambiguous-package'`). `meta.imports` (`ImportsCoverageMeta`) reports coverage (`scope: 'repository'` when unfiltered, or `scope: 'analyzed-files'` when `files` is passed; `scan`, `diff`, `file`, `map`, and `explain` also emit `meta.imports` with `scope: 'analyzed-files'` for the files touched during that operation). Both `importGraph` and `RelationshipClassifier` share the same TypeScript AST dependency extractor (`extractDependencies`, including triple-slash `/// <reference path="..." />` directives emitted as `kind: 'static'` edges, and resolving dynamic `import()` specifiers with the `'import'` export condition even in `.cjs`/`.cts` files). Note that `RelationshipClassifier` additionally follows barrel (`index.*`) re-exports up to depth 3 when classifying pairs as `direct`, whereas `importGraph()` reports the direct hop-by-hop edges (`a -> index.ts` and `index.ts -> b`). When `files` is provided, `from` is restricted to those files **plus** every file in the repository that imports them (reverse edges), using a reverse index built once per session; passing a path outside the repository or a path that does not exist at head throws `UsageError`.
- **Synchronous blob reads in `--head` sessions:** When `opts.head` is set, uncached source-blob reads during import classification and `importGraph()` communicate with the session's `git cat-file --batch` worker synchronously via `Atomics.wait`, which blocks the calling thread's event loop while reading uncached blobs. In long-lived servers or editor extensions, run `--head` sessions in a worker thread or background task if event-loop latency is sensitive.
- **`signal` and `onProgress` scope:** `opts.signal` and `opts.onProgress` apply to the initial `openRepository()` history load and model construction. They do not cover a later `repo.diff({ base })` call that retrains on a different baseline ref.
- **Cross-platform `repo.root`:** `repo.root` (like `meta.root` in all JSON outputs) is canonicalized and uses forward slashes (`/`) on all platforms, including Windows.
- **`close()`:** Always call `await repo.close()` in a `finally` block to release any background `git cat-file --batch` worker spawned when `head` is set. Calling any analysis method (`diff`, `scan`, `file`, `explain`, `backtest`, `importGraph`) after `await repo.close()` rejects with `UsageError` (`"Repository session is closed."`).

---

## 3. Complete Gutter Integration Example

Below is a complete example showing how Gutter opens a single repository session for a pull request, runs `diff`, `backtest`, and `importGraph` (for the PR's changed files and their reverse importers) from that single history load, and cleans up with `close()`:

```ts
import {
  openRepository,
  UsageError,
  GitError,
  ConfigError,
} from 'repo-archaeology';

export async function analyzePullRequest(params: {
  repoPath: string;
  baseRef: string;
  headRef?: string;
  signal?: AbortSignal;
}) {
  const repo = await openRepository({
    cwd: params.repoPath,
    base: params.baseRef,
    head: params.headRef,
    settings: {
      minShared: 3,
      minConfidence: 0.4,
    },
    onProgress(event) {
      // Optional structured progress hook (never writes to stdout/stderr)
      // event: { phase: 'history' | 'model', done?: number, total?: number }
    },
    signal: params.signal,
  });

  try {
    // 1. Check changed files on the branch against the pre-change baseline model
    const diffReport = await repo.diff({ limit: 10 });

    // 2. Evaluate historical holdout precision/hit-rate on the already-loaded history (no second git log)
    const backtestReport = await repo.backtest({
      testFraction: 0.2,
      k: 3,
      followUps: true,
    });

    // 3. Query the import graph for the PR's changed files plus every file that imports them ("What it touches")
    const changedPaths = diffReport.changed
      .filter((file) => !file.deleted)
      .map((file) => file.path);
    const importsReport = await repo.importGraph({
      files: changedPaths,
    });

    return {
      root: repo.root,
      headSha: repo.headSha,
      mergeBaseSha: repo.mergeBaseSha,
      diffReport,
      backtestReport,
      importsReport,
    };
  } finally {
    await repo.close();
  }
}
```
