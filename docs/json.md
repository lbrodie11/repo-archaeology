# Repo Archaeology JSON Output Contract (`schemaVersion: 1`)

Every Repo Archaeology command supports machine-readable JSON output via `--json` (and `diff` additionally supports writing JSON to a file alongside terminal or Markdown output via `--json-out <file>`).

This document defines the **v1 JSON contract**, schema locations, field stability guarantees, and versioning policy for CI pipelines, pre-commit hooks, and autonomous coding agents.

---

## 1. Contract Envelope & Guarantees

Every JSON payload emitted by Repo Archaeology includes a top-level contract envelope alongside the command's result fields:

```json
{
  "schemaVersion": 1,
  "tool": {
    "name": "repo-archaeology",
    "version": "0.11.0"
  }
}
```

### Core Guarantees
- **Clean `stdout`:** When `--json` is passed, `stdout` contains strictly a single UTF-8 JSON document terminated by `\n`. Progress indicators and error messages are written exclusively to `stderr`.
- **Single-Pass Dual Output on `diff`:** `repo-archaeology diff --format markdown --json-out <file>` runs Git history analysis once, writes the rendered Markdown summary to `stdout`, and atomically writes the full `schemaVersion: 1` JSON payload to `<file>` (`<file>` resolves relative to the invoking shell's working directory).
- **Backward Compatibility with `v0.2.x`:** All existing fields (including `meta.tool`) are preserved unchanged. `schemaVersion` and top-level `tool` are strictly additive.

---

## 2. Versioning Policy

Repo Archaeology follows a strict schema versioning policy for `--json` and `--json-out` payloads:

1. **Additive Changes Keep `schemaVersion: 1`:**
   - Adding new optional properties, adding new top-level summary fields, or adding new diagnostic metadata does **not** increment `schemaVersion`.
   - Consumers should ignore unrecognized object properties when parsing in code. All published `v1` JSON Schemas in `schema/` permit additional properties so additive `0.3.x` fields remain valid against the `v1` schemas.
2. **Breaking Changes Increment `schemaVersion`:**
   - Removing a documented property, renaming a property, changing a property's data type, or altering the meaning of an existing discriminator requires incrementing `schemaVersion` (e.g. to `2`).
3. **Downstream Consumer Guards & Enum Stability:**
   - [`test/json-contract.test.ts`](../test/json-contract.test.ts) and [`scripts/smoke-pack.mjs`](../scripts/smoke-pack.mjs) validate CLI and packed tarball outputs against the Draft 2020-12 schemas in [`schema/`](../schema) via the shared validator in [`scripts/schema-validator.mjs`](../scripts/schema-validator.mjs).
   - [`test/consumer-gutter.test.ts`](../test/consumer-gutter.test.ts) freezes the exact `diff --json` and `backtest --json` field paths, types, relationship kinds (`ghost`, `unknown`, `indirect`, `direct`, `test`), `silence.primaryReason` codes (`no_changed_files`, `limited_repo_history`, `no_history_for_changed_files`, `no_cochange_partners`, `all_companions_touched`, `silenced_by_verdicts`, `filtered_by_thresholds`, `filtered_by_kinds`), and strategy names (`co-change`, `popularity, same changes`) consumed by Gutter (`lbrodie11/gutter`). Removing, renaming, or retyping any of these frozen values requires a coordinated Gutter release.

4. **Growing Value Sets:**
   - The value sets of `via` (`ImportResolutionVia`), `reasonCode` (`ImportUnresolvedReasonCode`) and the top-level `languages` array of `imports --json` may grow within `schemaVersion: 1` when new resolution strategies or languages are added (RA-10 added `via` values `"go-package"` and `"python-module"` and the languages `"go"` and `"python"`). Each release's schemas list that release's values. Consumers must tolerate unknown values (treat an unknown `via` as "resolved somehow" and an unknown `reasonCode` as "unresolved"), as Gutter's contract already does for checklist kinds.

---

## 3. JSON Schema Files (`schema/`)

Machine-readable JSON Schema definitions (Draft 2020-12, `https://json-schema.org/draft/2020-12/schema`) are shipped in the `schema/` directory of the repository and npm package:

| Command | CLI Invocation | JSON Schema File | Discriminator / Notes |
| --- | --- | --- | --- |
| Shared types | — | [`schema/common.schema.json`](../schema/common.schema.json) | Defines `Meta`, `RelationshipView`, `FindingFamilyView`, `DiffSuggestion`, `SilenceDiagnostics`, etc. |
| `scan` | `repo-archaeology scan --json` | [`schema/scan.schema.json`](../schema/scan.schema.json) | Repository-wide relationships and finding families. |
| `diff` | `repo-archaeology diff --json`<br>`repo-archaeology diff --json-out <file>` | [`schema/diff.schema.json`](../schema/diff.schema.json) | Pre-PR / working-tree companion suggestions, `evaluation` baseline metadata, `families`, and optional `silence` diagnostics. |
| `file` | `repo-archaeology file <path> --json` | [`schema/file.schema.json`](../schema/file.schema.json) | Single-file churn, top authors, and companions (`wouldAlert` boolean). |
| `explain` | `repo-archaeology explain <a> <b> --json` | [`schema/explain.schema.json`](../schema/explain.schema.json) | Bounded Git diff hunks across shared commits and counterexample commits. |
| `map` | `repo-archaeology map --json` | [`schema/map.schema.json`](../schema/map.schema.json) | Generated HTML file path, drawn node/edge counts, kind breakdown, and `patchesIncluded`. |
| `backtest` | `repo-archaeology backtest --json` | [`schema/backtest.schema.json`](../schema/backtest.schema.json) | Chronological holdout replay scores, optional `ghostDiagnostics` (`--ghosts`), and optional `followUpBenchmark` (`--follow-ups`). |
| `imports` / `importGraph` | `repo-archaeology imports --json`<br>`repo.importGraph()` | [`schema/import-graph.schema.json`](../schema/import-graph.schema.json) | Internal import graph (`files`, `edges`, `unresolved`, `languages`) and reverse-importer lookups. |
| Default (bare) | `repo-archaeology --json` | [`schema/default.schema.json`](../schema/default.schema.json) | Discriminated union (`oneOf`) keyed by `mode`: `"diff"` when working tree has changes with history, otherwise `"scan"` (with `changedWithoutHistory`). |
| Relationship verdicts file | `<repoRoot>/.repo-archaeology.verdicts.json` | [`schema/verdicts.schema.json`](../schema/verdicts.schema.json) | Repo-committed file (`version: 1`, `verdicts: VerdictEntry[]`) for silencing `expected` pairs or annotating `confirmed` hidden dependencies. |

---

## 4. Environment-Dependent vs. Portable Fields

Most path fields in Repo Archaeology JSON outputs are **normalized POSIX repository-relative paths** (for example, `src/adapter/bun/serve-static.ts`), even when executed on Windows.

Only two fields contain host-specific absolute filesystem paths:

| Field | Where it appears | Description |
| --- | --- | --- |
| `meta.root` | `scan`, `diff`, `file`, `explain`, `backtest`, and default command | Absolute path to the analyzed Git repository worktree on the local machine. |
| `file` | `map --json` | Absolute path to the generated interactive HTML map file on the local machine. |

---

## 5. Command Output Shapes

### 5.1 Common `meta` Object (`common.schema.json#/$defs/Meta`)

Present on `scan`, `diff`, `file`, `explain`, `backtest`, and bare `repo-archaeology`:

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `tool` | `"repo-archaeology"` | Yes | Legacy tool identifier retained for compatibility. |
| `root` | `string` | Yes | Absolute path to the Git repository root. |
| `head` | `{ ref: string, sha: string }` | Optional | Present when `--head <ref>` was passed; records the raw ref string and resolved 40–64 hex commit SHA. |
| `commitsRead` | `integer` | Yes | Total non-merge commits read from `git log`. |
| `commitsAnalyzed` | `integer` | Yes | Usable commits retained after sweep and subject filters. |
| `sweepsSkipped` | `integer` | Yes | Commits skipped because they touched more than `maxFilesPerCommit` files. |
| `subjectSkipped` | `integer` | Yes | Commits skipped via `--skip-commits` or `skipCommitPrefixes`. |
| `revertsSkipped` | `integer` | Optional (always emitted since v0.6.0) | Mechanical `git revert` / `Reapply` commits skipped (`Revert "…"` and `Reapply "…"`; `0` when `--include-reverts` or `"skipReverts": false` is set). |
| `renamesFollowed` | `integer` | Yes | File rename transitions bridged across history. |
| `files` | `integer` | Yes | Distinct tracked file identities in the co-change model. |
| `oldestCommit` | `string` (`YYYY-MM-DD`) | Optional | Date of the oldest analyzed commit (omitted when `commitsAnalyzed === 0`). |
| `newestCommit` | `string` (`YYYY-MM-DD`) | Optional | Date of the newest analyzed commit (omitted when `commitsAnalyzed === 0`). |
| `origins` | `{ human, agent, bot }` | Optional (always emitted since RA-08) | Counts of analyzed commits classified as `human`, `agent`, or `bot` (optional in `schemaVersion: 1` for backward compatibility with older v1 payloads). |
| `verdicts` | `{ loaded, active, expired, file }` | Optional (always emitted since RA-11) | Summary of `.repo-archaeology.verdicts.json`: total `loaded` entries, `active` entries, `expired` (`until < today`) entries, and `file: ".repo-archaeology.verdicts.json"`. |
| `imports` | `ImportsCoverageMeta` | Optional | Import resolution coverage and unresolved diagnostics for commands that perform import classification (`scan`, `diff`, `file`, `map`, `explain`, `imports`, and bare `repo-archaeology`). Omitted on `backtest`. |
| `config` | `{ source: "working-tree" \| "ref" \| "none", ref?: string, sha?: string }` | Optional (always emitted by the CLI and library since RA-19) | Which `.repo-archaeology.json` applied (`common.schema.json#/$defs/ConfigMeta`), so a caller can verify that the code under review did not choose its own settings. `"working-tree"`: the file at the checked-out repository root. `"ref"`: the file in a commit's tree, with `ref` as given and `sha` the resolved 40–64 hex commit; set by `--config-from <ref>` / `configRef`, and by `--head <ref>` alone (which reads `<ref>`'s own tree; when that file is invalid the run falls back to the working tree, reports `"working-tree"` and adds a warning). `"none"`: config reading was disabled (`--no-config` / `useConfigFile: false`). `source` names where the file was looked for, not whether one existed: a missing file at that source means no config. |
| `settings` | `Settings` | Yes | Active analysis settings (`maxCommits`, `maxFilesPerCommit`, `minShared`, `minConfidence`, `ignore`, `useDefaultIgnores`, and optional `since`, `halfLifeDays`, `skipCommits`, `skipReverts`, `origin`, `owners`). |
| `warnings` | `string[]` | Yes | History warnings (e.g., shallow clone warning or merge fallback warning). |
| `cache` | `{ enabled: boolean, hits: integer, misses: integer, dir?: string }` | Optional (always emitted by the CLI since RA-04) | History cache usage for this run (`common.schema.json#/$defs/CacheMeta`). `hits` counts needed commits served from the persistent raw-commit cache; `misses` counts commits parsed from `git log` in this run (all of them when `enabled: false`, i.e. `--no-cache`). `dir` is relative to the repository root with POSIX separators, or the literal `"$REPO_ARCHAEOLOGY_CACHE_DIR"` when that environment variable chose the directory; it is never an absolute path and is omitted when no relative path exists (e.g. another drive on Windows). Cached and `--no-cache` runs are otherwise identical, so consumers comparing outputs should exclude `meta.cache`. Cache rebuilds (corruption, checksum mismatch, version change) and read-only shallow clones add a message to `warnings`. |

#### 5.1.1 Directional Confidence, Wilson Intervals (`interval`, `reverseInterval`), and `score`

Every relationship object in `diff` (`suggestions[]`, `families[].relationships[]`), `scan` (`relationships[]`, `families[].relationships[]`), `file` (`companions[]`), and `explain` exposes directional co-change statistics along with two-sided 95% Wilson score confidence intervals (`common.schema.json#/$defs/WilsonInterval`). Both `interval` and `reverseInterval` are marked optional in the `v1` JSON Schema (to preserve backward compatibility with `v0.3.0` payloads), but are **always emitted** from this release onward:

- **`interval`: `{ "low": number, "high": number }`** — Two-sided 95% Wilson score interval ($z = 1.959963984540054$) for the forward directional confidence $P(\text{to changes} \mid \text{from changes})$, computed from **unweighted raw commit counts** (`shared` successes out of `fromChanges` trials) and rounded outward to 4 decimal places (`floor` for `low`, `ceil` for `high`).
- **`reverseInterval`: `{ "low": number, "high": number }`** — Two-sided 95% Wilson score interval for the reverse directional confidence $P(\text{from changes} \mid \text{to changes})$, computed from **unweighted raw commit counts** (`shared` successes out of `toChanges` trials) and rounded outward to 4 decimal places (`floor` for `low`, `ceil` for `high`).
- **Unweighted `interval` vs. Weighted `score`:** `interval` and `reverseInterval` are **always unweighted** so they match the raw `shared`, `fromChanges`, and `toChanges` commit counts printed alongside them. When `--half-life <days>` or `--origin-weights <spec>` is set (`weighted: true`, `weighting: "recency" | "origin" | "recency+origin"`), `confidence`, `reverseConfidence`, and the ranking `score` (the Wilson lower bound) use weighted counts and may differ from `interval.low`; in Markdown, terminal, and map output, the interval is placed next to the raw commit count and labeled `(raw 95% CI …)`.
- **Worked Example (`14` of `19` commits):** Suppose `from` changed in `fromChanges = 19` commits and `to` changed alongside it in `shared = 14` of those commits (with no `--half-life` weighting):
  - Raw directional rate: $\hat{p} = 14 / 19 \approx 0.7368$ (`confidence: 0.737`).
  - Two-sided 95% Wilson score interval (`wilsonInterval(14, 19)` $\approx \{ \text{low}: 0.51208, \text{high}: 0.88194 \}$): outward-rounded to `interval: { "low": 0.512, "high": 0.882 }`, rendered in Markdown and terminal output as `(95% CI 51–89%)`.
  - Ranking score: `score: 0.512` (the Wilson lower bound rounded to 3 decimal places).

#### 5.1.2 Relationship Verdicts (`.repo-archaeology.verdicts.json`, `common.schema.json#/$defs/RelationshipVerdict`)

Teams can commit `<repoRoot>/.repo-archaeology.verdicts.json` (validated against [`schema/verdicts.schema.json`](../schema/verdicts.schema.json)) to silence known mechanical relationships (`"verdict": "expected"`) or annotate real hidden dependencies (`"verdict": "confirmed"`):

- **Scores never change:** Verdicts never alter `shared`, `fromChanges`, `toChanges`, `confidence`, `reverseConfidence`, `interval`, `reverseInterval`, `score`, or `backtest` replay results.
- **Annotation shape (`verdict`):** When a relationship matches an active verdict, `RelationshipView` (and `explain --json`) includes `verdict: { kind: "expected" | "confirmed", reason: string, by?: string, until?: string }`.
- **`diff` filtering, `--base` merge-base isolation & silence diagnostics:**
  - `expected` pairs are excluded from `suggestions[]` and `families[]` (including triangle/family completion).
  - When `diff` runs with `--base <ref>`, active verdicts are loaded from the `<merge-base>` commit tree by default so a pull request cannot silence warnings about itself before merging. Verdict entries added or modified on the branch are counted in `verdicts.addedInBranch` (and `silence.verdicts.addedInBranch`) and noted in terminal/Markdown output (`"This PR adds N expected verdict(s) (not applied until merged)"`). Pass `--apply-branch-verdicts` to preview branch-added verdicts locally before merging.
  - When at least one qualifying candidate is silenced by an `expected` verdict (or `addedInBranch > 0`), `diff` emits top-level `verdicts: { silenced: number, addedInBranch?: number }` (and `silence.verdicts: { silenced: number, addedInBranch?: number }` when `suggestions.length === 0`).
  - When every qualifying candidate was silenced by `expected` verdicts, `silence.primaryReason` is `"silenced_by_verdicts"` (and `"silenced_by_verdicts"` is included in `silence.reasons`).
  - `confirmed` pairs remain in `suggestions[]` with their `verdict` object attached.
- **`scan`, `file`, `map`, and `explain`:**
  - `scan`, `file`, and `map` hide `expected` pairs by default (including during Finding Family completion) unless `--show-silenced` is passed, emit `verdicts: { silenced: number }` in JSON when `silenced > 0` (plus a dim `(N silenced by verdicts; use --show-silenced)` line in terminal output), and attach `verdict` to `confirmed` pairs (and `expected` pairs when `--show-silenced` is set).
  - `explain <a> <b>` always explains the requested pair and includes `verdict` when one matches.
- **Specificity guard, precedence & expiration:**
  - At least one endpoint of `pair` must be an exact path or an anchored glob with a fixed directory prefix or file extension; catch-all pairs where both endpoints match every file (such as `["**", "**"]` or `["*", "**"]`) are rejected.
  - When multiple active verdicts match a pair, precedence is deterministic and independent of file order: more exact endpoints win over globs, narrower globs (more literal segments, then more literal characters) win over broader globs, `directed: true` wins over undirected at equal path specificity, and `"confirmed"` wins over `"expected"` at equal specificity.
  - `until` (`YYYY-MM-DD`) is an inclusive UTC date (`until >= today` in UTC is active; `until < today` is expired and emits a warning in `meta.warnings`).
  - In `--head` or `--base` mode, if `.repo-archaeology.verdicts.json` in a historical commit tree is invalid, analysis falls back to no verdicts and records a warning in `meta.warnings`.
- **Renames vs. globs:** Exact (non-glob) verdict paths are resolved through `RenameTracker` / `History` identities and active branch/working-tree renames (including multi-hop intermediate branch renames and preserving separate file identities when a rename reuses a vacated path), so a verdict on `a.ts` continues to match after `git mv a.ts b.ts`. Glob syntax is recognized when an endpoint contains `*`, `?`, trailing `/`, or comma-separated brace alternation `{a,b}` (literal `[id]` or `{id}` path segments are treated as exact paths), and glob verdicts match current paths only.

#### 5.1.3 Import Resolution Coverage (`meta.imports`, `common.schema.json#/$defs/ImportsCoverageMeta`)

Commands that inspect JS/TS imports (`scan`, `diff`, `file`, `map`, `explain`, `imports`, and the bare default command) include `meta.imports` to report honest import resolution coverage for the exact scope analyzed by that command:

- **`scope`: `"repository" | "analyzed-files"`**
  - `"repository"` on a full `repo-archaeology imports` / `repo.importGraph()` call (with no `files` filter).
  - `"analyzed-files"` on `repo.importGraph({ files })` and on `scan`, `diff`, `file`, `map`, and `explain`, where only the files touched by relationship classification during that operation are counted (without parsing unrelated files across the repository).
- **`filesScanned` (`integer`):** Supported JS/TS files whose imports were parsed within `scope`.
- **`internalEdges` (`integer`):** Total resolved internal edges originating from `filesScanned`.
- **`external` (`integer`):** Specifiers classified as external packages (`node:` built-ins, declared `dependencies` / `devDependencies` / `peerDependencies` / `optionalDependencies`, `package.json#imports` mapped to external packages, or `tsconfig.paths` mapped into `node_modules`).
- **`unresolved` (`integer`):** Specifiers that could not be resolved to an internal file or declared external dependency (always equal to the sum of values in `unresolvedByReason`).
- **`dynamicLoads` (`integer`):** Files in `scope` containing non-literal dynamic `import(expr)` or `require(expr)` calls.
- **`unsupportedFiles` (`integer`):** Files without an import analyzer (anything but JS/TS, Go and Python) encountered in `scope`.
- **`sourceUnavailable` (`integer`):** Supported JS/TS files in `scope` whose source contents could not be read (e.g., missing blob or exceeding `MAX_SOURCE_BYTES`).
- **`heuristicEdges` (`integer`):** Internal edges in `scope` resolved via a heuristic fallback (such as an unconfigured `"source"` export condition, `dist/` → `src/` build-output remapping without a matching `tsconfig` `outDir`/`rootDir`, or a nested `package.json` in a repository with no explicit workspace manifest). For example, on `shadcn-ui`, all `441` workspace `exports` edges resolve via `dist/` → `src/` fallback and are counted in `heuristicEdges: 441` (and surfaced as `(441 heuristic)` in the human `repo-archaeology imports` terminal summary).
- **`unresolvedByReason` (`Partial<Record<ImportUnresolvedReasonCode, integer>>`, optional):** Non-zero counts of unresolved specifiers grouped by `reasonCode` (`"alias-unmatched"`, `"unknown-package"`, `"target-missing"`, `"not-exported"`, `"invalid-target"`, `"unsupported-config"`, `"ambiguous-package"`). When a bare specifier matches an in-repo `package.json` `name` that is not in an active workspace, it is never silently treated as `"external"` even if listed in `dependencies`: unparseable/conflicting workspace manifests report `"unsupported-config"`, and packages excluded from a valid workspace manifest report `"unknown-package"`.

#### 5.1.4 Historical Contributor Context and `CODEOWNERS` (`--owners`, `common.schema.json#/$defs/SuggestionOwner`)

When `--owners` (or `.repo-archaeology.json` `"owners": { "enabled": true }`) is enabled on `diff` (or bare `repo-archaeology` in `diff` mode), each `DiffSuggestion` in `suggestions[]` is enriched with optional contributor and `CODEOWNERS` context for the suggested companion file (`to`):

- **`owners`: `SuggestionOwner[]`** (`{ name: string, login?: string, commits: integer, lastDate: string }`):
  - Aggregates up to `owners.max` (default `3`, `1..5`) human contributors across up to `owners.maxCommits` (default `100`, `1..1000`) recent commits touching the canonical `to` file identity (following renames) within `owners.lookbackDays` (default `365`, `1..3650`) relative to the analyzed snapshot's reference committer timestamp.
  - Canonicalizes contributor identities via `.mailmap` (`gitmailmap(5)` forms 1–4) loaded from the analyzed revision (so a newer working-tree `.mailmap` never rewrites `--head` or `--base` historical attribution) while keeping raw `evidence[].author`, `file` `authors`, and `origin` unchanged.
  - Excludes bot-authored and non-human coding-agent commits while including human-authored, agent-assisted commits.
  - Infers optional `login` strictly from GitHub noreply email formats (`ID+USERNAME@users.noreply.github.com` and `USERNAME@users.noreply.github.com`, falling back to raw commit emails when `.mailmap` maps to a corporate address) and omits conflicting or ambiguous logins.
  - Never emits raw or canonical email addresses in any field.
- **`ownersSample`: `SuggestionOwnersSample`**:
  - Auditable sample summary: `{ qualifyingCommits, lookbackDays, maxCommits, fromDate, toDate, agentAssistedCommits, excludedNonHumanCommits, incompleteCoverage, codeownersSource?, codeownersFile? }`.
- **`codeowners`: `string[]`** (optional):
  - Matching `@user` and `@org/team` handles from `.github/CODEOWNERS`, `CODEOWNERS`, or `docs/CODEOWNERS` (read from `merge-base` when `--base` is passed, `<head>` when `--head` is passed without `--base`, and the working tree otherwise), using case-sensitive last-valid-match precedence. Email-based `CODEOWNERS` entries are skipped without exposing their email.
  - Rendered Markdown and terminal output insert a zero-width space (`\u200B`) after `@` in handles so copying output into a pull-request comment never triggers accidental GitHub notifications.

---

### 5.2 `diff --json` & `diff --json-out <file>` ([`schema/diff.schema.json`](../schema/diff.schema.json))

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `schemaVersion` | `1` | Yes | JSON contract major version. |
| `tool` | `{ name, version }` | Yes | Tool name and semver version. |
| `meta` | `Meta` | Yes | Repository and baseline model metadata. |
| `base` | `string` | Optional | Present when `--base <ref>` was passed. |
| `evaluation` | `DiffEvaluation` | Yes | Reproducibility metadata: `commitsAnalyzed`, `effectiveOptions`, and optional `targetBranchRef`, `headSha`, `mergeBaseSha`, `baselineSha`. |
| `changed` | `ChangedFileView[]` | Yes | Evaluated changed files (`path`, `deleted`, `sources`, `hasHistory`, and optional `oldPath`, `added`, `historyPath`). |
| `totalSuggestions` | `integer` | Yes | Total number of qualifying companion suggestions before `--limit` truncation. |
| `suggestions` | `DiffSuggestion[]` | Yes | Ranked untouched companion files (`RelationshipView` plus `alsoLinkedFrom: string[]` and the optional `trackRecord`, see [5.2.1](#521-track-record-suggestionstrackrecord-commonschemajsondefstrackrecord)), capped at `--limit`. |
| `families` | `DiffFamilyView[]` | Yes | Parallel-implementation finding families touched by the change (`FindingFamilyView` plus `changedMembers` and `suggestedMembers`). |
| `verdicts` | `{ silenced: integer, addedInBranch?: integer }` | Optional | Present when at least one qualifying suggestion was silenced by an `expected` verdict (`silenced > 0`) or when `diff --base` detected verdict entries added/changed on the branch (`addedInBranch > 0`). |
| `silence` | `SilenceDiagnostics` | Optional | Present when `suggestions.length === 0`. Explains why no recommendations were emitted (`primaryReason`, `reasons`, `details`, filter counts, and optional `verdicts: { silenced, addedInBranch? }`). |

#### Example `diff --base main --json` Payload

```json
{
  "schemaVersion": 1,
  "tool": {
    "name": "repo-archaeology",
    "version": "0.11.0"
  },
  "meta": {
    "tool": "repo-archaeology",
    "root": "/workspace/repo",
    "commitsRead": 120,
    "commitsAnalyzed": 118,
    "sweepsSkipped": 2,
    "subjectSkipped": 0,
    "revertsSkipped": 0,
    "renamesFollowed": 3,
    "files": 42,
    "oldestCommit": "2025-01-10",
    "newestCommit": "2026-10-15",
    "origins": {
      "human": 110,
      "agent": 5,
      "bot": 3
    },
    "settings": {
      "maxCommits": 5000,
      "maxFilesPerCommit": 25,
      "minShared": 3,
      "minConfidence": 0.4,
      "ignore": [],
      "useDefaultIgnores": true
    },
    "warnings": []
  },
  "base": "main",
  "evaluation": {
    "targetBranchRef": "main",
    "headSha": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    "mergeBaseSha": "00112233445566778899aabbccddeeff00112233",
    "baselineSha": "00112233445566778899aabbccddeeff00112233",
    "commitsAnalyzed": 118,
    "effectiveOptions": {
      "minShared": 3,
      "minConfidence": 0.4,
      "maxCommits": 5000,
      "maxFilesPerCommit": 25
    }
  },
  "changed": [
    {
      "path": "src/adapter/bun/serve-static.ts",
      "deleted": false,
      "added": false,
      "sources": ["branch"],
      "historyPath": "src/adapter/bun/serve-static.ts",
      "hasHistory": true
    }
  ],
  "totalSuggestions": 1,
  "suggestions": [
    {
      "from": "src/adapter/bun/serve-static.ts",
      "to": "src/adapter/deno/serve-static.ts",
      "relationship": "ghost",
      "why": "possible parallel implementations: serve-static.ts appears in sibling folders",
      "hiddenBridge": {
        "signal": "parallel-implementation",
        "value": "serve-static.ts",
        "filesUsing": 2
      },
      "shared": 12,
      "fromChanges": 20,
      "toChanges": 18,
      "confidence": 0.6,
      "reverseConfidence": 0.667,
      "interval": {
        "low": 0.3865,
        "high": 0.7812
      },
      "reverseInterval": {
        "low": 0.4374,
        "high": 0.8373
      },
      "score": 0.387,
      "weighted": false,
      "lastTogether": "2026-05-16",
      "crossesDirectories": true,
      "originShare": {
        "human": 0.917,
        "agent": 0.083,
        "bot": 0
      },
      "evidence": [
        {
          "hash": "26f8c33000000000000000000000000000000000",
          "date": "2026-05-16",
          "author": "Alice",
          "subject": "fix(serveStatic): make options parameter optional in all adapters",
          "origin": "human"
        }
      ],
      "alsoLinkedFrom": [],
      "trackRecord": {
        "fired": 5,
        "confirmed": 4,
        "triggers": 7,
        "coChanged": 7,
        "precision": 0.8,
        "interval": { "low": 0.3755, "high": 0.9638 },
        "windowHours": 48,
        "evaluated": { "from": "2026-03-01", "to": "2026-11-01", "commits": 400, "trainingCommits": 1600 },
        "excluded": { "censored": 1, "targetDeleted": 0, "clockSkew": 0 }
      }
    }
  ],
  "families": []
}
```

#### 5.2.1 Track record (`suggestions[].trackRecord`, `common.schema.json#/$defs/TrackRecord`)

`diff` (and the bare command's auto-diff) attaches an optional `trackRecord` to every suggestion. It answers one question about the suggestion's **primary directional pair** (`from → to`): *when this pair triggered before, did `to` change soon after?* It is **observational evidence, not correctness**: it says "the last 5 times `from` changed without `to` while the model linked them, `to` changed within 48 h on 4 occasions". It does not say those changes were fixes, or that the warning was right 80% of the time. `--no-track-record` (API: `trackRecord: false`) skips the replay entirely and omits the field.

It takes one of three shapes:

| Shape | When |
| --- | --- |
| `{ fired, confirmed, triggers, coChanged, precision, interval, windowHours, evaluated, excluded }` | At least one completed episode (`fired ≥ 1`). |
| `{ fired: 0, reason: "never_fired", triggers?, coChanged?, windowHours?, evaluated?, excluded? }` | The window was evaluable, but no episode completed. Gutter needs only `fired` and `reason`; the optional fields are context (for example `triggers > 0` with every episode censored). |
| `{ reason: "limited_history" }` | Fewer than 30 commits could be replayed, or `diff`'s thin/partial-baseline flag is set (shallow clone, `--max-commits`/`--since` truncation, or fewer than 50 usable baseline commits: the same definition as `silence.limitedHistory`). |

Definitions:

- **History and order.** The replay uses exactly the commits the `diff` baseline model trains on: history up to `evaluation.baselineSha` (the merge-base with `--base`, otherwise `HEAD`; `--head` respected), after the model's own filters (ignores, `--skip-commits`, `--max-files` sweeps, the revert policy, `--since`, `--max-commits`). Commits are ordered by committer time (`commitTime`) with git-log tie-breaks, exactly as `backtest --follow-ups` does, and every duration uses committer time. Feature-branch commits are never replayed, and the working tree plays no part.
- **Evaluation window.** With `N` usable commits, `W = min(2000, max(200, round(0.2 × N)))`, clamped so that at least `T = max(30, ceil(N / 2))` commits stay before the window: `W = min(W, N − T)`. If `W < 30`, the result is `limited_history`. The `N − W` commits before the window only build the initial state (`evaluated.trainingCommits`); `evaluated.commits` is `W`, and `evaluated.from`/`to` are the committer dates of the first and last replayed commit.

  | N | W | Commits before W |
  | ---: | ---: | ---: |
  | 29 | limited | — |
  | 60 | 30 | 30 |
  | 100 | 50 | 50 |
  | 230 | 115 | 115 |
  | 2,000 | 400 | 1,600 |
  | 20,000 | 2,000 | 18,000 |
- **Replay.** For each window commit `c`, triggers are evaluated on state built only from commits strictly before `c`, then `c` is added. That state equals a `CoChangeModel` freshly built from the same prefix with the same options, including `--half-life` and origin weights, bit for bit: both follow one numerical policy (`src/model/cochange.ts`). Without a half-life, a weighted count is `Σ count[origin] × weight[origin]` over integer per-origin counts, in the fixed order human, agent, bot, so it does not depend on the order commits are added in. With a half-life, recency weights are kept relative to an epoch that moves only with the commit-time sequence, and are accumulated in one canonical chronological order (committer time, then git-log order, then hash). Both sides also share one threshold test, so a confidence that lands exactly on `--min-confidence` (for example `1.2 / 1.5` with origin weights `1/0.1/0.3`) is decided the same way by `diff` and by the replay.
- **Pair.** Only the primary `from → to`; `alsoLinkedFrom` sources are not aggregated in. File identities follow renames, so a renamed file keeps its history, and a file deleted and later re-created at the same path is a different file.
- **Trigger.** At commit `c`: `c` touches `from`, does not touch `to`, `to` has not been deleted, and `to` qualifies as a companion of `from` under the same `minShared`/`minConfidence` thresholds `diff` uses. This is a *threshold trigger*: it does not replay `diff`'s other filters as of `c` (historical import classification, verdicts, `--kinds`), so a pair `diff` would have hidden at the time can still trigger.
- **Episodes.** A trigger opens an episode, which closes when `to` changes or when `windowHours` pass. Further triggers while an episode is open count only in `triggers`, so a short branch that touches `from` four times is one warning, not four. `fired` counts episodes; `confirmed` counts episodes in which `to` changed in a commit strictly after the opening trigger in replay order with `0 ≤ commitTime(c′) − commitTime(c) ≤ windowHours` (exactly 48 h confirms; 48 h + 1 s does not; equal timestamps confirm only when the `to` commit comes later in replay order). A rename of `to` counts as a change to it.
- **Exclusions** (`excluded`, not in `fired`): `censored`, the episode's window extends past the newest replayed commit (applied whatever the outcome, so late confirmations cannot inflate the rate); `targetDeleted`, `to` was deleted within the window (a deletion is not a confirmation); `clockSkew`, a negative time delta. Because commits are ordered by committer time, `clockSkew` stays 0 in practice; it guards externally ordered timelines. A commit the model filters out (sweep, skipped subject, revert per policy) neither triggers nor confirms.
- **`coChanged`** (context): window commits touching both files while `to` qualified.
- **Rate.** `precision = confirmed / fired`, rounded to 4 decimals, is an observed follow-up rate; the name is kept for Gutter's contract and does not mean accuracy. `interval` is the 95% Wilson interval for `confirmed / fired` (`low` floored, `high` ceiled to 4 decimals). It is descriptive only: episodes from one repository are not independent samples.
- **Invariants:** `0 ≤ confirmed ≤ fired ≤ triggers`; `0 ≤ interval.low ≤ precision ≤ interval.high ≤ 1`. The schema bounds each field; `test/json-contract.test.ts` checks the cross-field relations.
- **Window size.** `--track-window <hours>` (API: `trackWindowHours`) takes a whole number from 1 to 720 (default 48); anything else is a usage error (exit 2).

Text output (classic, `--style rich` and Markdown, including Action summaries) adds one line per suggestion when `fired > 0`, counts first, for example `Before: 5 times this changed without permissions.ts; it changed within 48 h after 4 (not proof those were fixes).` (with `small sample;` before the caveat when `fired < 5`), and nothing for `limited_history`. For `never_fired` it prints one dim line that states only what the record's optional fields support: `No earlier triggers in the last 400 commits.` when `triggers` is 0; `No completed earlier triggers in the last 400 commits (2 too recent or left out).` when triggers occurred but every episode was excluded; `No completed earlier triggers in the last 400 commits.` when the trigger counts are absent; and no line when `evaluated.commits` is absent. `diff` itself always emits the full context. The rate is never shown as a percentage or described as accuracy, correctness or chance.

---

### 5.3 `scan --json` ([`schema/scan.schema.json`](../schema/scan.schema.json))

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `schemaVersion` | `1` | Yes | JSON contract major version. |
| `tool` | `{ name, version }` | Yes | Tool name and semver version. |
| `meta` | `Meta` | Yes | Repository metadata. |
| `counts` | `Record<Relationship, integer>` | Yes | Classified relationship counts by kind (`ghost`, `unknown`, `indirect`, `direct`, `test`). |
| `qualifying` | `integer` | Yes | Total file pairs meeting `--min-shared` and `--min-confidence`. |
| `classified` | `integer` | Yes | Number of qualifying pairs classified (capped at `MAX_CLASSIFIED = 5000`). |
| `truncated` | `boolean` | Yes | `true` when `qualifying > classified`. |
| `relationships` | `RelationshipView[]` | Yes | Top relationships matching `--kinds` and `--limit`. |
| `families` | `FindingFamilyView[]` | Yes | Parallel-implementation finding families (3+ sibling files). |
| `verdicts` | `{ silenced: integer }` | Optional | Present when at least one qualifying relationship was silenced by an `expected` verdict (`silenced > 0`). |

---

### 5.4 `file <path> --json` ([`schema/file.schema.json`](../schema/file.schema.json))

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `schemaVersion` | `1` | Yes | JSON contract major version. |
| `tool` | `{ name, version }` | Yes | Tool name and semver version. |
| `meta` | `Meta` | Yes | Repository metadata. |
| `path` | `string` | Yes | Normalized repository-relative path of the inspected file. |
| `changes` | `integer` | Yes | Total analyzed commits touching this file. |
| `churnPercentile` | `number` (`0..1`) | Yes | Fraction of tracked files with strictly fewer changes than this file. |
| `medianChanges` | `number` | Yes | Median change count across all tracked files. |
| `lastChanged` | `string` (`YYYY-MM-DD`) | Yes | ISO date of the most recent analyzed commit touching this file. |
| `authors` | `{ author, commits, share }[]` | Yes | Top 3 authors by commit count on this file. |
| `companions` | `FileCompanionView[]` | Yes | Co-changing files meeting `--min-shared` (`RelationshipView` plus `wouldAlert: boolean`). |
| `verdicts` | `{ silenced: integer }` | Optional | Present when at least one companion was silenced by an `expected` verdict (`silenced > 0`). |

---

### 5.5 `explain <fileA> <fileB> --json` ([`schema/explain.schema.json`](../schema/explain.schema.json))

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `schemaVersion` | `1` | Yes | JSON contract major version. |
| `tool` | `{ name, version }` | Yes | Tool name and semver version. |
| `meta` | `Meta` | Yes | Repository metadata. |
| `from`, `to` | `string` | Yes | Normalized repository-relative file paths. |
| `relationship` | `Relationship` | Yes | Dependency classification in current code. |
| `why` | `string` | Yes | Human-readable classification explanation. |
| `hiddenBridge` | `HiddenBridge` | Optional | Shared AST signal when `relationship === "ghost"`. |
| `verdict` | `RelationshipVerdict` | Optional | Active verdict annotation (`{ kind: "expected" \| "confirmed", reason, by?, until? }`) when `.repo-archaeology.verdicts.json` matches this pair. |
| `meetsThresholds` | `boolean` | Yes | Whether the pair meets active `--min-shared` and `--min-confidence` in at least one direction. |
| `shared`, `fromChanges`, `toChanges` | `integer` | Yes | Raw shared and individual commit counts (stay raw even when `--half-life` or `--origin-weights` is set, while `minShared` uses the origin-weighted shared count when origin weights are active; `interval` from RA-05 stays raw as well). |
| `confidence`, `reverseConfidence`, `score` | `number` | Yes | Directional confidences and Wilson score. |
| `interval`, `reverseInterval` | `WilsonInterval` | Optional (always emitted) | Two-sided 95% Wilson score intervals (`{ low, high }`) for unweighted directional and reverse confidence. |
| `weighted` | `boolean` | Yes | `true` when `--half-life` recency weighting or `--origin-weights` origin weighting is active. |
| `weighting` | `"none" \| "recency" \| "origin" \| "recency+origin"` | Optional | Emitted when `weighted === true` to distinguish recency weighting (`"recency"`), origin weighting (`"origin"`), or both (`"recency+origin"`). |
| `lastTogether` | `string` | Optional | ISO date of most recent shared commit (omitted when `shared === 0`). |
| `crossesDirectories` | `boolean` | Yes | `true` when `dirname(from) !== dirname(to)`. |
| `originShare` | `{ human, agent, bot }` | Optional (always emitted since RA-08) | Share of all shared commits by origin (`human`, `agent`, `bot`), rounded to 3 decimals and summing to 1 (or all `0` when `shared === 0`). Optional in `schemaVersion: 1` for backward compatibility with older v1 payloads. |
| `sharedCommits` | `SharedCommitEvidence[]` | Yes | Recent shared commits with `origin` (`"human" \| "agent" \| "bot"`) and bounded diff hunks (`fileA`, `fileB`). |
| `counterexamples` | `object` | Yes | `fromWithoutToTotal`, `toWithoutFromTotal`, `fromWithoutTo`, `toWithoutFrom` (each commit includes `origin`). |
| `bounds` | `ExplainBoundsSummary` | Yes | Active line/hunk/byte/timeout budgets and truncation flags. |
| `cliCommand` | `string` | Yes | Reproducible CLI command string. |
| `disclaimer` | `string` | Yes | Methodological caveat. |

---

### 5.6 `map --json` ([`schema/map.schema.json`](../schema/map.schema.json))

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `schemaVersion` | `1` | Yes | JSON contract major version. |
| `tool` | `{ name, version }` | Yes | Tool name and semver version. |
| `meta` | `Meta` | Yes | Repository metadata (`root` is sanitized to the repository folder name; includes `meta.head` when `--head <ref>` is passed). |
| `file` | `string` | Yes | Absolute path to the written HTML file. |
| `nodes` | `integer` | Yes | Number of file nodes drawn in the map. |
| `edges` | `integer` | Yes | Number of relationship edges drawn in the map. |
| `counts` | `Record<Relationship, integer>` | Yes | Classified relationship counts by kind across the repository. |
| `patchesIncluded` | `boolean` | Yes | `true` when `--include-patches` was enabled. |
| `verdicts` | `{ silenced: integer }` | Optional | Present when at least one qualifying relationship was silenced by an `expected` verdict (`silenced > 0`). |

---

### 5.7 `backtest --json` ([`schema/backtest.schema.json`](../schema/backtest.schema.json))

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `schemaVersion` | `1` | Yes | JSON contract major version. |
| `tool` | `{ name, version }` | Yes | Tool name and semver version. |
| `meta` | `Meta` | Yes | Repository metadata. |
| `k` | `integer` | Yes | Top-`k` suggestions evaluated per query. |
| `train`, `test` | `{ commits, from?, to? }` | Yes | Training and held-out commit window summaries. |
| `queries` | `integer` | Yes | Total held-out `(commit, file)` queries evaluated. |
| `before` | `string` (`YYYY-MM-DD`) | Optional | Cutoff date when `--before` was specified. |
| `soloQueries` | `integer` | Yes | Held-out queries where only 1 file changed in the commit. |
| `strategies` | `StrategyScore[]` | Yes | Precision, hit rate, coverage, false-alarm rate, and recall per strategy. |
| `notes` | `string[]` | Yes | Methodological notes. |
| `ghostDiagnostics` | `GhostDiagnostics` | Optional | Present when `--ghosts` was passed. |
| `followUpBenchmark` | `FollowUpBenchmarkResult` | Optional | Present when `--follow-ups` was passed (each case's `initialCommit` and `followUpCommit` includes `origin`). |
| `comparisons` | `OriginWeightComparison[]` | Optional | Present when `--compare-origin-weights <spec>` was passed; reports `defaultWeights` (`{ human: 1, agent: 1, bot: 1 }`), resolved `weights` (keys omitted in `<spec>` inherit from `origin.weights` in `.repo-archaeology.json`), `default`, `weighted` (each including `byOrigin` slices for `human`, `agent`, and `bot` held-out commits), `deltas` (`precision`, `hitRate`, `lift`, `coverage`, `falseAlarmRate`, `recall`, `fired`), and `caveat` on the same split. |

---

### 5.8 Default Command (`repo-archaeology --json`, [`schema/default.schema.json`](../schema/default.schema.json))

When `repo-archaeology --json` is invoked with no subcommand, it inspects the working tree and emits a discriminated union keyed by `"mode"`:

- **`"mode": "diff"`:** Emitted when uncommitted changes touch at least one file with usable history. Contains all properties of `DiffResult` (`schema/diff.schema.json`) plus `"mode": "diff"`.
- **`"mode": "scan"`:** Emitted when the working tree is clean or changed files have no prior history. Contains all properties of `ScanResult` (`schema/scan.schema.json`) plus `"mode": "scan"` and `"changedWithoutHistory"` (`integer`).

---

### 5.9 `imports --json` / `repo.importGraph()` ([`schema/import-graph.schema.json`](../schema/import-graph.schema.json))

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `schemaVersion` | `1` | Yes | JSON contract major version. |
| `tool` | `{ name, version }` | Yes | Tool name and semver version. |
| `meta` | `Meta` | Yes | Repository metadata (including `meta.imports` with `scope: "repository"` when unfiltered or `scope: "analyzed-files"` when `--files` is passed). |
| `at` | `{ ref, sha }` | No | Present only with `--at <ref>` / `importGraph({ at })` (RA-20): the graph is of that commit's tree, not the session's. `files`, `edges`, `unresolved`, `languages` and `meta.imports` describe `at`'s tree and equal a fresh session at `at` with the same settings; the rest of `meta` (history, `head`, `config`, `settings`) is the session's. See §5.9.1. |
| `files` | `string[]` | Yes | Sorted repository-relative paths included in the graph (`from` candidates). When `files` filter is passed, includes the requested files plus every file that imports them (passing a path outside the repository or a path not present at head throws `UsageError`). |
| `edges` | `ImportGraphEdge[]` | Yes | Internal dependency edges (`{ from, to, specifier, kind, via?, heuristic? }`) where `kind` is `"static" \| "dynamic" \| "reexport" \| "require"`, `via` is `"relative" \| "paths" \| "workspace" \| "exports" \| "imports" \| "go-package" \| "python-module"` (`"go-package"`: a Go import resolved to one of the imported package's non-test files, one edge per file; `"python-module"`: a Python import resolved to a module, and to every regular-package `__init__.py` on its path; the set may grow, see §2), `heuristic` is `boolean` (`true` when resolved via a heuristic `dist/` → `src/` remap or unconfigured `"source"` export condition (TS/JS), or for a Python submodule behind a package's PEP 562 `__getattr__` (see §5.9.1)), `role` and `name` are described in §5.9.1, and `to` is an internal file present at head (at `at` with `--at`). |
| `unresolved` | `ImportGraphUnresolved[]` | Yes | Unresolved module specifiers (`{ from, specifier, reason, reasonCode? }`), preserving `reason: "unmatched"` for `schemaVersion: 1` compatibility and adding `reasonCode`: `"alias-unmatched" \| "unknown-package" \| "target-missing" \| "not-exported" \| "invalid-target" \| "unsupported-config" \| "ambiguous-package"`. |
| `languages` | `string[]` | Yes | Sorted list of detected source languages (`"go"`, `"javascript"`, `"python"`, `"typescript"`; the set may grow, see §2). |

---

Go and Python (RA-10): `meta.imports` counters (`filesScanned`, `internalEdges`, `external`, `unresolved`, `dynamicLoads`, `unsupportedFiles`, `heuristicEdges`, `unresolvedByReason`) include `.go` and `.py` files. Index and resolution diagnostics are appended to `meta.warnings` (for example `Go: module path … is declared by more than one go.mod`, `Go: imports in-repo module … without a local replace/go.work`, `Go: … replaces … which is outside the repository`, `Python: pyproject.toml uses TOML outside the supported subset (unsupported-config: …)`, and fan-out or session edge-budget notices). The same warnings appear in `scan`, `diff`, `file`, `explain` and `map` output for the files those commands analyzed. See the README's *Language support* section for what each language resolves.


#### 5.9.1 Target roles and base-tree graphs (RA-20)

**`role` (`common.schema.json#/$defs/ImportTargetRole`, optional):** what an edge's `to` is to the import. Emitted on every `"python-module"` and `"go-package"` edge since 0.12.0; absent on TS/JS edges (whose `to` is always the module the specifier names) and in older output, so consumers must tolerate its absence. `to`, `specifier` and `kind` are unchanged.

| `role` | Meaning | Python examples (`via: "python-module"`) |
| --- | --- | --- |
| `"module"` | The module the specifier names. Go: every file of the imported package. | `a/b/c.py` for `import a.b.c`; `a/b/__init__.py` for `import a.b` and for `from a.b import x`; `pkg/mod.py` for `from .mod import x` |
| `"init"` | A regular-package `__init__.py` that runs on the way to the module. | `a/__init__.py` and `a/b/__init__.py` for `import a.b.c` |
| `"name"` | A submodule taken by name, with the name in `name`. | `pkg/mod.py` with `name: "mod"` for `from pkg import mod`; `pkg/sub/__init__.py` with `name: "sub"` for `from pkg import sub` |

An `__init__.py` of a package that contains the importing file is never a target (it already ran). `package-dir` mappings and relative imports resolve first, so roles name the mapped paths. A consumer can decide "the specifier still resolves" exactly: for example, `from pkg import mod` whose `"name"` target `pkg/mod.py` was deleted is broken even though the `"module"` target `pkg/__init__.py` still resolves, while the loss of an `"init"` target alone leaves the module importable as a namespace package.

**`__getattr__` submodules (`heuristic: true`, `role: "name"`):** `from pkg import x` (including `from . import x` inside `pkg/__init__.py`) where `x` exists on disk, `pkg/__init__.py` binds no `x`, and its only dynamic trait is one module-level `def __getattr__` (PEP 562) gives a heuristic edge to the submodule. `__getattr__` is consulted only for names the package does not bind, so the submodule is the probable target, but it could return something else. Relationship classification (`scan`, `diff`, `file`, `explain`, `map`) does not count these edges: such pairs stay `unknown`, never `direct`. Any other dynamic namespace (a star import, `globals()`, `setattr`, `sys.modules`, a second use of `__getattr__`) still gives no edge (the submodule is only possible). Before 0.12.0 these imports gave no edge.

**Base-tree graphs (`--at <ref>`, `importGraph({ at })`):** the graph of another commit's tree from the current session, typically a pull request's base: `importGraph({ files: removedPaths, at: mergeBase })` lists the base-tree importers of files a PR deletes or renames away. The result's `files`, `edges`, `unresolved`, `languages` and `meta.imports` equal `openRepository({ head: at, settings, useConfigFile: false }).importGraph({ files })` with the session's settings (tested on fixtures and real repositories). `files` must exist in `at`'s tree (`UsageError` otherwise). `meta.warnings` adds `at`'s import diagnostics to the session's warnings. No history is read for `at`, and `at`'s `.repo-archaeology.json` is never read: the session's settings apply.

## 6. Usage Examples (`jq` & Automation)

```bash
# List suggested companion file paths for your current branch
npx repo-archaeology diff --base main --json | jq -r '.suggestions[].to'

# Check the primary silence reason when zero suggestions are returned
npx repo-archaeology diff --base main --json | jq -r '.silence.primaryReason // "has_suggestions"'

# Write Markdown to stdout for a PR summary while saving the v1 JSON artifact
npx repo-archaeology diff --base main --format markdown --json-out ./archaeology-diff.json
```
