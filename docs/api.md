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

### Supported Node.js Versions
- **Node.js `>= 22`** (ESM-only; matches `"engines": { "node": ">=22" }` in [`package.json`](../package.json)).
- **TypeScript declarations:** Bundled at `dist/api/index.d.ts` (with declaration maps at `dist/api/index.d.ts.map`) via `"exports"` in `package.json`.

---

## 2. Session API Reference

```ts
import {
  openRepository,
  type OpenOptions,
  type Repository,
  type DiffJson,
  type ScanJson,
  type FileJson,
  type ExplainJson,
  type BacktestJson,
  type ImportGraphJson,
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
  settings?: Partial<Settings>; // same keys as .repo-archaeology.json / CLI flags (maxCommits, maxFiles, minShared, minConfidence, halfLife, skipCommits, ignore, defaultIgnores)
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
  diff(opts?: { limit?: number; kinds?: Relationship[] }): Promise<DiffJson>;
  scan(opts?: { limit?: number; kinds?: Relationship[] }): Promise<ScanJson>;
  file(path: string, opts?: { limit?: number }): Promise<FileJson>;
  explain(a: string, b: string, opts?: { commits?: number; counterexamples?: boolean; context?: number }): Promise<ExplainJson>;
  backtest(opts?: { testFraction?: number; k?: number; before?: string | number; ghosts?: boolean; followUps?: boolean; followUpWindowHours?: number; compareOriginWeights?: string | readonly string[] }): Promise<BacktestJson>;
  importGraph(opts?: { files?: string[] }): Promise<ImportGraphJson>;
  close(): Promise<void>;       // releases git child processes (e.g. RA-02's cat-file)
}
```

- **One history load:** `openRepository` reads `git log` once and builds the `CoChangeModel` in memory. Subsequent calls to `diff`, `scan`, `file`, `explain`, `backtest`, and `importGraph` reuse the loaded session without re-reading `git log`.
- **`importGraph({ files })`:** Returns `{ schemaVersion: 1, tool, meta, files, edges, unresolved, languages }` ([`schema/import-graph.schema.json`](../schema/import-graph.schema.json)). `edges` include only internal files present at head (`kind: 'static' | 'dynamic' | 'reexport' | 'require'`). When `files` is provided, `from` is restricted to those files **plus** every file in the repository that imports them (reverse edges), using a reverse index built once per session.
- **`close()`:** Always call `await repo.close()` in a `finally` block to release any background `git cat-file --batch` worker spawned when `head` is set.

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
