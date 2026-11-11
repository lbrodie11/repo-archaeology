# RA-20 · Base-tree import graphs and Python target roles

Gutter's `broken-import` (GU-31) compares the import graph at a pull request's base with the graph at its head. A base edge `{ from, to, specifier }` into a removed `to` is broken when `from` is untouched and `specifier` no longer resolves at head. Before RA-20 the base graph needed a second `openRepository({ head: <base> })`, which re-read and re-parsed every file of the base tree, although almost all of them are byte-identical to the head tree the head session had just analyzed. Python consumers also had to guess, from specifier strings and path suffixes, whether a base target was the imported module, an `__init__.py` on the way, or a submodule taken by name.

This records the decisions behind `importGraph({ at })` / `imports --at <ref>` and the `role` edge field. The contract is in [`docs/api.md`](../../api.md) and [`docs/json.md` §5.9.1](../../json.md#591-target-roles-and-base-tree-graphs-ra-20).

## D1 · Design (a): `importGraph({ files, at })` on the existing session

Two designs were on the table: (a) a method on the head session that analyzes another tree, or (b) an `openRepository` option that builds a session's index from another open session.

**Chosen: (a), as an option of the existing `importGraph` rather than a new `importersAt`.**

- The result is the same `ImportGraphJson` a fresh session at `at` returns, so "identical output to a fresh session" is a plain deep-equal (that is how the parity tests are written), and consumers reuse their existing parsing. The one addition is a top-level `at: { ref, sha }`.
- (b) would still open a session: it resolves settings and config, loads history (or needs a new "no history" mode), and opens a second `cat-file` worker the caller must close. Gutter only wants the graph. (a) loads no history (tested with a spy on `loadHistory`) and closes its base reader after each call.
- The CLI gets `--at <ref>` on `imports`, with `--json` parity.

## D2 · What is reused: extractions, never resolutions

The tempting design was "reuse the head analysis of every file whose blob is unchanged". **That is wrong for exactly the case RA-20 exists for.** An unchanged `a.ts` with `import './old'` resolves to `old.ts` at base and to nothing at head, because the file set differs. The same holds for a `tsconfig.json` `paths` change, a `go.mod` module path or a `package-dir` mapping: an unchanged file's edges depend on other files.

So the pipeline is split in two (`src/imports/analysis.ts`):

1. **Extraction:** reading a file's import statements (the TypeScript parser, the Go and Python lexers). It is a function of the file's bytes and path only, and it is the expensive part. `LanguageAnalyzer.extract(text, path)` no longer receives the index. Go's index-dependent part (the enclosing module and the package-header cache) moved to a new `complete(path, extraction, index)` hook.
2. **Resolution:** turning specifiers into files against a tree's file list and configuration. This is cheap map work.

`importGraph({ at })` builds an ordinary index for `at`'s tree (its file list from `git ls-tree`, its own `ImportResolver`, Go and Python indexes, all configuration read from `at`), and resolves every analyzable file. Extractions come from an `ExtractionStore`: for a path whose blob is the same in both trees, the head session's extraction is reused; every other file is read from `at` and extracted. Equal blob means equal bytes, and therefore an equal extraction.

**Invalidation.** The requirement allowed invalidating the reuse "for the files they govern, or for everything". Neither is needed. No resolution result is reused, so any resolution-affecting file that differs (`tsconfig*.json`, `jsconfig.json`, `package.json`, workspace manifests, `go.mod`, `go.work`, `pyproject.toml`, `setup.cfg`, `setup.py`) is simply read from `at` like everything else. The invalidation tests change each of `tsconfig.json` `paths`, a `go.mod` module path and a `pyproject.toml` `package-dir` between base and head, with every source file unchanged. They show that the base result follows the base configuration while reusing all extractions (`extracted: 0`).

**Unchanged** means the same git blob: the extraction store records, for every extraction, the blob id of the text it was read from. In a `--head` session that is the tree entry's id. In a working-tree session it is computed from the bytes read (`git hash-object`, SHA-1 or SHA-256 like the repository). A path is reused at `at` only when its regular-file blob id there is the same. An earlier draft trusted `git diff <at>` for working trees. Review found that wrong when a file is edited or reverted after the session's graph was built, for `assume-unchanged`/`skip-worktree` entries, and for checkout filters (LFS, `core.autocrlf`): in each case git calls the path clean while the stored extraction came from other bytes. Comparing ids needs no `git diff` at all. The cost is hashing the text a working-tree session reads (about 30 ms per 20 MB of source in 2,500 files, measured). In a `--head` session, unchanged blobs (same id and mode) are also read through the session's own cached `cat-file` reader, for the configuration and `__init__.py` files resolution reads.

**Edge budget.** The derived index analyzes every analyzable file of `at` in sorted path order, so the per-session edge budget (`MAX_SESSION_INTERNAL_EDGES`) is spent exactly as in a fresh session.

**Cold sessions.** Reuse comes only from what the session already analyzed. Without a prior `importGraph()` the call costs about as much as a fresh session minus history. Gutter always builds the head graph first.

## D3 · Settings

The `at` side uses the session's effective settings (the ignore patterns are the only ones the import graph reads). It never reads `at`'s `.repo-archaeology.json`. A caller who wants the base branch's config opens the session with `configRef: <base>` (RA-19), and that applies to both sides. RA-19's `useConfigFile`/`configRef` semantics are unchanged.

## D4 · `role` on Python and Go edges

`role` is optional and additive (`schemaVersion: 1`):

- `"module"`: the module the specifier names. That is the leaf of `import a.b.c`, the package `__init__.py` of `import a.b` and of `from a.b import x`, and every file of a Go package.
- `"init"`: a regular-package `__init__.py` that runs on the way.
- `"name"`: a submodule taken by `from pkg import name`, with `name`.

`resolveModule` (`src/imports/python.ts`) assigns roles where the walk already knows them, so source roots, relative imports and `package-dir` mappings are handled exactly. A consumer no longer re-derives them, which replaces Gutter's `isAncestorInit`. Within one specifier, a path's role is determined by its position relative to the named module, so deduplication by `(to, specifier, kind)` cannot merge two roles.

Go edges get `"module"` too, because it costs nothing and lets a consumer read `role` uniformly for package languages. **TS/JS edges get no role.** Their `to` is always the module the specifier names, and leaving it out keeps TS/JS output byte-identical (the golden snapshots are unchanged).

## D5 · `from . import x` behind a PEP 562 `__getattr__` (requirement 3)

`github/spec-kit`'s `src/specify_cli/workflows/overlay/__init__.py` defines a module-level `__getattr__` and runs `from . import x`. RA-10 treated any `__getattr__` as "the package may bind any name", made the submodule `uncertain`, and emitted no edge. That was right for relationships, but it made the import invisible to the graph.

**Decision: emit it as a heuristic, graph-only edge.** The edge is emitted when all of the following hold:

- the named submodule exists on disk;
- `__init__.py` binds no attribute of that name;
- `__init__.py`'s only dynamic trait is a single module-level `def __getattr__`.

The edge is `{ heuristic: true, role: "name", name }`. Python consults `__getattr__` only for names the module does not bind, and conventional `__getattr__` functions (lazy imports, deprecation shims) raise `AttributeError` for unknown names. So the submodule is the probable target, but not a certain one. RA-10's own test case (`def __getattr__(name): return 1`) shows that `__getattr__` can shadow the submodule.

To keep RA-10's guarantee that relationships never claim a possible import as `direct`, the target is marked `graphOnly` (internal, not in JSON) and stays in `uncertain`. The classifier skips `graphOnly` targets, so `scan`, `diff`, `file`, `explain` and `map` still report the pair as `unknown`, and their `meta.imports` counters are unchanged. A star import, `globals()`, `setattr`, `vars`, `__dict__`, `exec`, `eval`, `locals`, `sys.modules`, or any second use of the name `__getattr__` keeps the old behaviour (uncertain, no edge).

## D6 · Measurements

`scripts/bench-base-graph.mjs` (Apple M-series laptop, Node 22, local blobless clones from Gutter's benchmark corpus, blobs pre-fetched by a warm-up run). For each repository, the 20 most recent first-parent commits that name a PR (`(#N)` or `Merge pull request`) and remove at least one TS/JS, Go or Python file (deleted, or renamed away under `--no-renames`). Base is the first parent; `files` are all removed paths. Three interleaved repeats per PR, median per PR, then p50/p95 over PRs.

- **Second session** (today, Gutter GU-31): `openRepository({ head: base, settings: { maxCommits: 1, cache: { enabled: false } }, useConfigFile: false })` + `importGraph({ files })` + `close()`.
- **Derived** (RA-20): `importGraph({ files, at: base })` on a head session that already built its graph (untimed, as in Gutter).

| Repository (pin) | PRs | Second session p50 / p95 | Derived p50 / p95 | p95 ratio | Parity |
| --- | --- | --- | --- | --- | --- |
| `honojs/hono` (`eb754bd`) | 20 | 459 / 673 ms | 91 / 208 ms | 31% | 20/20 identical |
| `allianz/ng-aquila` (`5b23a36`) | 20 | 1236 / 1780 ms | 200 / 335 ms | **19%** (target ≤ 25%) | 20/20 identical |

Measured on the final code (blob-id reuse, after three review passes). An earlier run on the first draft gave hono 545/1009 vs 88/272 ms (27%) and ng-aquila 1239/1669 vs 198/369 ms (22%); the second-session baseline varies more from run to run than the derived path. Parity means identical `files`, `edges`, `unresolved`, `languages` and `meta.imports` between the two results for every PR.

Per PR, the derived path re-parsed only what differs. On ng-aquila that is 3 to 44 files out of about 1,800 analyzable ones, except one PR at 196. On hono it is 0 to 55 files out of about 380, except one PR that rewrote 125 files (283 re-parsed). What remains is the base side's `ls-tree`, building its resolvers, and resolving every file of the base tree.

**Memory** (`node --expose-gc`, heap retained after GC):

| | hono p50 | ng-aquila p50 |
| --- | --- | --- |
| Head session's graph, before RA-20 (main) | 4.0 MB | 12.2 MB |
| Head session's graph, with the extraction store | 4.1 MB | 13.2 MB |
| Derived `at` index, kept while the session is open (last `at` only) | 0.1 MB | 4.0 MB |

The second session's own graph (about as large as the head graph) and its history are gone. The derived index stays cached for repeated calls with the same `at` until the session is closed or another `at` is asked for.

Reproduce:

```bash
npm run build
node --expose-gc scripts/bench-base-graph.mjs --repo ~/.cache/gutter-bench/honojs__hono --rev eb754bd
node --expose-gc scripts/bench-base-graph.mjs --repo ~/.cache/gutter-bench/allianz__ng-aquila --rev 5b23a36
# head-graph memory of another build (e.g. main's): add --memory-only --lib <dir>/dist/api/index.js
```

Correctness on real repositories is also tested in CI: `test/import-graph-at.test.ts` compares the derived and fresh graphs of this repository at v0.10.0 from a v0.11.0 session, whole and scoped.

**Accepted cost.** Every session that builds an import graph keeps its extractions, even if it never calls `importGraph({ at })`: about +1 MB on ng-aquila (+9% of the graph's retained heap) and +0.1 MB on hono. Making it opt-in would mean a session option, while Gutter, the only consumer of `at`, always wants it.
