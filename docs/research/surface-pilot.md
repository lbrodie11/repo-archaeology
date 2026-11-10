# RA-18 · Surface pilot (preregistration)

**Question:** what did this PR change about what a file exports, and which untouched files still use the old version?
**Status:** PREREGISTERED on 2026-11-10. Sections 1–6 were committed before any analysis code ran on real data. They must not be edited afterwards; any change goes under a dated `## Errata` entry at the end of this file. Results are appended under `## Results` by `scripts/surface-pilot/report.ts`, from the committed data in [`data/surface-pilot/`](data/surface-pilot/).
**Scope:** research only. No CLI command, JSON field, schema, library export or v1 output changes. A product prompt is written only if the verdict in section 6 allows it.

## Why

Gutter's predictive "did you forget this file?" questions failed their benchmark (Gutter `docs/benchmark/STAGE0.md`), and Gutter is moving to facts (GU-29). Gutter's `wide-surface` item asks "Is its public shape unchanged?"; a passing pilot would answer that with a fact. Three risks are measured here:

1. **Duplication.** In a type-checked TypeScript project, a removed export that is still imported already fails `tsc`. The fact is only new where the compiler does not look (plain JavaScript, files outside every `tsconfig`, packages not checked together). Every consumer therefore carries a compiler-coverage label, and "beyond-compiler" findings are counted separately.
2. **A biased test.** Merged PRs have already passed CI, so real breakages are rare in them. Correctness is measured on seeded mutations with known answers plus contract-preserving negative controls (corpus A); real PRs (corpus B) measure only relevance.
3. **Forking the path.** The pass rule (section 6) is fixed here, in its own commit, before any run.

## 1. Export surface (per file, syntactic)

Source files: `.ts .tsx .mts .cts .js .jsx .mjs .cjs` (including `.d.ts`). Parsing uses TypeScript's `createSourceFile` only: no `Program`, no type checker, no execution of repository code.

Each export is recorded with:

- **name**, `default` included. A name appears once per file; merged declarations (overloads, `interface` merging, `function` + `namespace`) form one entry.
- **kind**: `function`, `class`, `variable` (`const`/`let`/`var`), `type`, `interface`, `enum`, `namespace`, or `re-export` (a name exported from another module: `export { a } from './x'`, or an imported binding exported again). `namespace` is an adaptation: the prompt's list has no kind for `export namespace N {}`. When merged declarations disagree, the kind is the first of `class`, `function`, `enum`, `variable`, `interface`, `type`, `namespace`, `re-export`.
- **local exports are resolved to their declaration**: `export { f }`, `export { f as g }` and `export default f` take the kind (and parameters or properties) of the local declaration of `f`. `export default <expression>` is a `function` for function and arrow expressions, a `class` for class expressions, otherwise a `variable`.
- **parameters**, for functions and for variables initialised with an arrow or function expression (parentheses, `as`, `satisfies` and type assertions unwrapped): `required` = the position of the last parameter that has no `?`, no initializer and no `...`, plus one (TypeScript's minimum-argument rule; a `this` parameter is not counted); `total` = all parameters, including a rest parameter; `rest` = whether one exists. Overloads are counted once: when a function has bodiless overload signatures, `required` is their minimum, `total` their maximum and `rest` true if any has one (the implementation signature is not visible to callers); otherwise the single declaration is used.
- **required properties**, for interfaces and for type aliases whose type is an object literal: the names of top-level property and method signatures without `?` (identifier, string or numeric names; computed names and index signatures are ignored; `extends` is not expanded). Merged interfaces take the union.
- **opaque re-exports**: `export * from 'x'` and `export * as ns from 'x'` are recorded as opaque; the surface behind them is not expanded. `export * as ns` also records the name `ns` as a `re-export`.
- **CommonJS**, when statically visible: `module.exports = { … }` (shorthand, `key: value` and method properties; values resolved like local exports), `module.exports.x = …` and `exports.x = …` as top-level statements. Any other use of `module.exports` or `exports` (reassignment to a non-object, a second `module.exports =`, spread or computed keys, `Object.defineProperty`, nested assignments), and `export =`, make the surface `unknown`.

A file with neither ESM nor CommonJS exports has a known, empty surface. A file that cannot be read (larger than `MAX_SOURCE_BYTES`, a symlink, not a regular blob) has an `unavailable` surface.

## 2. Delta and consumers

**Delta**, per changed source file, comparing the surface at the PR's base with the surface at its merge commit:

- `removed`: the name exists at base and not at head;
- `added`: the name exists at head and not at base;
- `changed`: the name exists at both and (a) the kind changed, (b) `required` parameters increased, or (c) required properties were added or removed. Reasons are recorded (`kind-changed`, `required-params-increased`, `required-props-added`, `required-props-removed`). An optional parameter added, a rest parameter added, or `total` changing alone is not a change.
- A removal plus an addition is never called a rename.
- Opaque re-exports added or removed are listed with the delta.
- A file added in the PR has an empty base surface; a deleted file has an empty head surface. Renamed files are a deletion plus an addition.
- If either side is `unknown` or `unavailable`, the delta is `unknown` and no consumers are searched for that file.

**Affected names** are the `removed` and `changed` names. `added` names have no consumers.

**Consumers** are source files at head that are **unchanged in the PR** (not added, modified, deleted or renamed in base..merge) and import an affected name. Bindings are read from each importing file's syntax:

- named imports (`import { n }`, `import { n as m }`, type-only included), default imports (`import d from` → `default`), `import { default as d }`;
- `require` destructuring (`const { n } = require('x')`, `const { n: m } = require('x')`) and `require('x').n`;
- re-exports: `export { n } from 'x'`, `export { n as m } from 'x'`, and an imported binding exported again (`import { n } from 'x'; export { n }`). A re-exporting file is itself a consumer (it names `n`), and the name it exports is followed to its own importers through barrels, up to the classifier's barrel depth (`3`). Explicit re-exports are followed in any file, not only `index.*` files, because a name-level re-export is explicit in the syntax (adaptation: the classifier's file-level `reachable()` follows `index.*` files only).

Module specifiers are resolved with the existing resolver (`ImportResolver`, RA-09: relative paths, `tsconfig` paths, workspaces, `package.json` `exports`/`imports`), at head.

**Consumer status**, per consumer file and affected name; a file's overall status is its strongest (`uses-removed-name` > `uses-changed-export` > `uncertain`):

- `uses-removed-name`: it imports a name that was removed (directly or through explicit re-exports). Verifiable from the source text. Not claimed to be broken at runtime.
- `uses-changed-export`: it imports an export whose delta is `changed`. Not claimed to be broken.
- `uncertain`, with a reason:
  - `namespace-import`: `import * as ns`, `const x = require('x')` (whole module), `import x from` a CommonJS module, or `export * as ns` reaching the changed file;
  - `dynamic-import`: `import('x')` of the changed file or of a barrel leading to it;
  - `opaque-re-export`: the name is imported from a file that reaches the changed file only through `export *`, or the changed file added or removed an `export *` and the name is not an explicit export of the changed file at head;
  - `unresolved-specifier`: the file imports an affected name, by name, from a specifier the resolver cannot resolve;
  - `parse-failure`: the importing file has parse diagnostics;
  - `file-too-large` / `symlink`: the file could not be read; these are listed as `uncertain` consumers of every affected name in a PR that has at least one affected name;
  - `barrel-depth`: an explicit re-export chain deeper than 3.

**Compiler coverage**, per consumer, by syntactic reading of every `tsconfig*.json` and `jsconfig.json` at head (`include`, `exclude`, `files`, `references`, relative `extends`, `allowJs`, `checkJs`, and a `// @ts-check` comment in a JavaScript file):

- `typechecked`: some config includes the consumer (a TypeScript file, or a JavaScript file with `allowJs` and `checkJs` or `// @ts-check`) and also includes the changed file, directly or through a config it references (transitively);
- `not-typechecked`: a JavaScript file without `checkJs` (or `// @ts-check`), a file outside every config, or a file whose configs neither include the changed file nor reference one that does;
- `unknown`: a config that may include the file cannot be parsed, or a needed option comes from a non-relative `extends` that cannot be read, and no config makes it `typechecked`.

Include/exclude follow TypeScript's rules: `include` defaults to `**/*` when neither `files` nor `include` is set; a pattern whose last segment has no `.` or `*` is a directory; `exclude` defaults to `node_modules`, `bower_components`, `jspm_packages` and `outDir`.

## 3. Corpora

All clones are bare (no checkout); nothing from them is installed, built or run.

| Corpus | Repo | Pinned SHA | Why |
|---|---|---|---|
| A, B | `honojs/hono` | `eb754bd5ef22c63f1634a4c374a86be086f85710` | TypeScript, the same pin and PRs as Gutter's Stage 0. Type-checked as one project (`tsconfig.build.json`, `tsconfig.spec.json`), so it tests the duplication risk directly. |
| A, B | `eslint/eslint` | `11c66ba08381cb7cff7679d662c9f6654b6fe712` | Plain-JavaScript CommonJS (`"type": "commonjs"`), 389 files in `lib/`, 846 non-fixture JS files. Its tsconfigs check only `lib/types` and type tests, so `lib/` is where the compiler does not look. Exercises the CommonJS surface. Pinned at the newest first-parent commit at least 7 days before the fetched `main` (`0146008d6e99aa31dc62153c200e714f5afdcd0e`, 2026-11-09), so every corpus-B PR has a complete 7-day follow-up window. |
| A | `vuejs/core` | `8b479a89445868d474f17e2d837765e7c9ece5e4` (v3.5.45) | pnpm TypeScript workspace monorepo (`packages/*`, `packages-private/*`) with cross-package `@vue/*` imports through `tsconfig` paths and workspace packages: exercises RA-09 resolution and `export *` barrels. |

### A · Seeded mutations (correctness)

- **Generator:** `scripts/surface-pilot/mutate.ts`, seed `20261110`, PRNG mulberry32. Deterministic for a fixed seed and pin.
- **Eligible files:** source files (section 1 extensions) that are not tests (`isTestFile`), not `.d.ts`, not under `node_modules/` or any `fixtures/` directory, readable, with a `known` surface. Candidates are shuffled with the seed and taken in order.
- **Ground truth** is independent of the analysis under test: TypeScript's language service (`findReferences`, `findRenameLocations`), used **only** by the research generator, over the pinned tree read from git (no node_modules, no network, nothing executed). Compiler options: the repository's root `tsconfig.json` options when they can be read, plus `allowJs: true`, `checkJs: false`, `noEmit: true`, `skipLibCheck: true`, `types: []`; root files are every eligible-extension file except under `node_modules/` and `fixtures/`. A file `G` **consumes** export `E` of file `F` when `G ≠ F` and `findReferences` on `E`'s declaration returns a reference in `G` that is not inside an export specifier or export declaration (pure pass-through re-exports do not count). A **caller** is such a reference that is the callee of a call or `new` expression.
- **Each mutation** edits one file at the pin and is written as a single commit (parent = pin) on a scratch ref in the scratch clone, using git plumbing (temporary index, `commit-tree`). This is equivalent to a scratch worktree commit, without a checkout (adaptation).
- **Positives**, ≥ 100 per repo (target 120), spread evenly by round robin over the kinds that apply:
  - `remove-export` (an export with ≥ 1 ground-truth consumer): drop the `export` modifier, or the specifier from an `export { … }` list (the whole statement if it was the only one); CommonJS: delete the property from `module.exports = { … }`, or turn `exports.x = …` / `module.exports.x = …` into `const __seededRemoved_x = …`. Variable statements with several declarators are not candidates.
  - `add-required-param` (an exported function, or arrow/function-expression variable, with ≥ 1 ground-truth caller; no overloads; arrow functions must have parenthesised parameters): insert a first parameter `__seeded` (`__seeded: unknown` in TypeScript), after a `this` parameter if there is one.
  - `add-required-prop` (an exported interface or object-literal type alias with ≥ 1 ground-truth consumer): insert `__seeded: unknown;` as the first member. Not applicable to eslint (no TypeScript sources), so eslint's positives are split between the first two kinds.
- **Negative controls**, ≥ 100 per repo (target 120, 20 per kind), all contract-preserving:
  - `edit-body`: insert `void 0;` as the first statement of an exported function's block body;
  - `reorder`: swap two adjacent top-level function, interface or type-alias declarations;
  - `rename-local`: rename a top-level non-exported function or variable that no export statement names, at every `findRenameLocations` location in the file (only locations in that file), to `<name>__seeded`;
  - `add-optional-param`: append `__seeded?: unknown` (TypeScript) or `__seeded = undefined` (JavaScript) to an exported non-overloaded function's parameters, before a rest parameter if there is one;
  - `split-export`: turn `export function f` into `function f` plus `export { f };` at the end of the file; CommonJS analogue: turn a shorthand `module.exports = { f }` property into `f: f`;
  - `add-export`: append `export const __seededExport = 1;` (ESM) or `module.exports.__seededExport = 1;` (CommonJS). This must show as exactly one `added` entry.
- If a kind has fewer eligible candidates than its quota, the shortfall is filled from the other kinds of the same class in round-robin order, and reported.

### B · Real PRs (relevance)

- **hono:** the same 200 PRs as Gutter's Stage 0 (`docs/benchmark/data/honojs__hono/stage0/default/bench.json` in `lbrodie11/gutter`, field `prs`: `base`, `mergeCommitSha`, `mergedAt`).
- **eslint:** the last 200 first-parent commits at or before the pin whose subject ends in `(#<number>)` (eslint squash-merges PRs); `base` = first parent, merge = the commit.
- Each PR is analyzed as base → merge commit. "Changed in the PR" = `git diff --name-status -M base merge`.
- **Follow-up horizon** (for the 7-day oracle): hono `61f7c59e50244ab4d2dd83c151928cf7ea448510` (fetched `main`, 2026-11-07), eslint `0146008d6e99aa31dc62153c200e714f5afdcd0e`.

## 4. Metrics

Computed by `scripts/surface-pilot/` and committed with every raw per-item record under [`data/surface-pilot/`](data/surface-pilot/).

**Corpus A** (pooled and per repo):

- **Removal recall** = detected `remove-export` positives / all `remove-export` positives. Detected: the delta has `removed` for that name **and** at least one consumer has status `uses-removed-name` for it.
- **Signature/property recall** = detected (`add-required-param` + `add-required-prop`) / all of them. Detected: the delta has `changed` for that name with reason `required-params-increased` (or `required-props-added`) **and** at least one consumer has status `uses-changed-export` for it.
- **False-positive rate** = negative controls with a false positive / all negative controls. A false positive is any `removed` or `changed` delta entry, any consumer whose status is not `uncertain`, or, for `add-export`, a delta that is not exactly one `added` entry for the new name.
- **Uncertain share** = `uncertain` consumer records / all consumer records, over positives.
- Reported, not decisive: oracle-consumer recall (ground-truth consumers reported with a non-`uncertain` status / all ground-truth consumers), failure classes of every missed positive and every false positive.

**Corpus B** (per repo):

- PRs analyzed (analysis finished without error) and PRs skipped, with reasons.
- Share of analyzed PRs with any surface delta (`added`, `removed` or `changed`).
- Share of analyzed PRs with a delta and ≥ 1 untouched consumer whose status is `uses-removed-name` or `uses-changed-export` (the decisive relevance number). The share counting `uncertain` consumers too is reported, not decisive.
- Every `uses-removed-name` finding, listed individually, with its compiler coverage and three oracles:
  - still present at the merge commit (by construction, yes; checked anyway);
  - consumer changed within 7 days after merge: a first-parent commit of the horizon with committer time in (`mergedAt`, `mergedAt` + 7 days] that touches the consumer path; `censored` when the horizon ends before the window does (counted as not followed);
  - for `typechecked` consumers: the TypeScript compiler bundled with this repository (not the analyzed repository's own toolchain, which would need `npm install`: network access and install scripts) checks the consumer file with the program described by the config that includes it, read from the merge commit's tree, with no node_modules. The oracle is `error` when a diagnostic in that file (codes 2305, 2307, 2339, 2459, 2460, 2614, 2724) names the removed export, `no-error` otherwise, and `unavailable` (with a reason) when the config cannot be loaded (for example a non-relative `extends`).
- **Beyond-compiler findings**: `uses-removed-name` findings whose consumer is `not-typechecked`.
- Analysis time per PR (wall clock of the full analysis, fresh resolver and caches per PR, TypeScript already loaded): median and p95.

## 5. Budgets and safety

- Time on hono: median ≤ 2 s and p95 ≤ 10 s per PR. Measured on the machine that runs the script (documented with the results; this pilot does not run in CI).
- Files over `MAX_SOURCE_BYTES` and symlinks are skipped and counted as `uncertain`.
- Nothing from the analyzed repositories runs. The only compiler invocations are TypeScript's own APIs (this repository's dependency) reading blobs from git, in the research scripts only.
- Runtime dependencies stay `commander` and `typescript`.

## 6. Verdict rule (preregistered; applied mechanically)

Copied verbatim from the RA-18 prompt:

> * CORRECT if all three hold on corpus A, pooled and in each repo:
>    * removal recall ≥ 0.95;
>    * signature/property recall ≥ 0.90;
>    * false-positive rate ≤ 0.02.
> Otherwise NOT CORRECT: stop and report the failure classes.
> * PASS-DESCRIBE if CORRECT, and corpus B shows a delta with ≥ 1 untouched consumer on ≥ 10% of PRs in at least one repo.
>    * What it allows: a Gutter prompt that shows "Surface changes" as context facts ("this PR removed `x` from `a.ts`; 3 untouched files import it"), with no claim of breakage.
> * PASS-WITNESS if PASS-DESCRIBE, and corpus B has ≥ 5 beyond-compiler `uses-removed-name` findings, of which ≥ 80% were followed by a change to that consumer within 7 days.
>    * What it allows: the stronger wording "still imports a name this PR removed".
> * INSUFFICIENT if CORRECT, but fewer than 50 PRs could be analyzed in either repo of corpus B.
> * Otherwise STOP: the analysis is correct but too rarely relevant to be worth a panel.
> Post-hoc interpretation goes in a separate, labeled paragraph and can't change the verdict.

**Application order** (fixed now, so the order cannot be chosen after the fact): NOT CORRECT → INSUFFICIENT → PASS-WITNESS → PASS-DESCRIBE → STOP; the first that holds is the verdict. "A delta with ≥ 1 untouched consumer" is the decisive corpus-B share in section 4 (non-`uncertain` consumers). Censored follow-ups count as not followed. Thresholds compare point estimates.

## Results

Everything between the markers below is generated by [`scripts/surface-pilot/report.ts`](../../scripts/surface-pilot/report.ts) from the raw records in [`data/surface-pilot/`](data/surface-pilot/) (`corpus-a/<repo>.jsonl`: one line per mutation; `corpus-b/<repo>.jsonl`: one line per PR; `results.json`: every computed number). `test/surface-pilot.test.ts` regenerates it and fails if a number differs. To reproduce, see [Reproducing](#reproducing).

<!-- surface-pilot:results:start (generated by scripts/surface-pilot/report.ts; do not edit) -->

**Verdict (mechanical, §6): NOT CORRECT.**

- CORRECT does not hold (removal recall < 0.95 in pooled, eslint, hono, vue-core; signature/property recall < 0.90 in eslint): NOT CORRECT. The rule stops here; corpus B and timing below are reported, not decisive.

### R1 · Corpus A: seeded mutations

| Scope | Removal recall (≥ 0.95) | Signature/property recall (≥ 0.90) | False-positive rate (≤ 0.02) | Uncertain share | Oracle-consumer recall (not decisive) |
|---|---|---|---|---|---|
| pooled | 0.351 (68/194) **no** | 0.916 (152/166) yes | 0.000 (0/360) yes | 0.525 (802/1529) | 0.019 (587/31695) |
| eslint | 0.035 (4/114) **no** | 0.167 (1/6) **no** | 0.000 (0/120) yes | 0.931 (242/260) | 0.000 (5/30972) |
| hono | 0.800 (32/40) **no** | 0.988 (79/80) yes | 0.000 (0/120) yes | 0.036 (12/330) | 0.895 (255/285) |
| vue-core | 0.800 (32/40) **no** | 0.900 (72/80) yes | 0.000 (0/120) yes | 0.584 (548/939) | 0.747 (327/438) |

By kind (positives: detected; negative controls: false positives):

| Kind | pooled | eslint | hono | vue-core |
|---|---|---|---|---|
| add-export | 0.000 (0/60) | 0.000 (0/20) | 0.000 (0/20) | 0.000 (0/20) |
| add-optional-param | 0.000 (0/61) | 0.000 (0/20) | 0.000 (0/21) | 0.000 (0/20) |
| add-required-param | 0.860 (74/86) | 0.167 (1/6) | 1.000 (40/40) | 0.825 (33/40) |
| add-required-prop | 0.975 (78/80) | – | 0.975 (39/40) | 0.975 (39/40) |
| edit-body | 0.000 (0/61) | 0.000 (0/20) | 0.000 (0/21) | 0.000 (0/20) |
| remove-export | 0.351 (68/194) | 0.035 (4/114) | 0.800 (32/40) | 0.800 (32/40) |
| rename-local | 0.000 (0/61) | 0.000 (0/20) | 0.000 (0/21) | 0.000 (0/20) |
| reorder | 0.000 (0/61) | 0.000 (0/20) | 0.000 (0/21) | 0.000 (0/20) |
| split-export | 0.000 (0/56) | 0.000 (0/20) | 0.000 (0/16) | 0.000 (0/20) |

Generation (from `corpus-a/<repo>.meta.json`):

- eslint @ `11c66ba`: 389 eligible files; quota shortfalls add-required-param −54.
- hono @ `eb754bd`: 291 eligible files; quota shortfalls split-export −4.
- vue-core @ `8b479a8`: 296 eligible files; quota shortfalls none.

**Failure classes** (every missed positive and every false positive):

| Class | Count |
|---|---|
| add-required-param: only-uncertain: dynamic-import+namespace-import+opaque-re-export | 2 |
| add-required-param: only-uncertain: namespace-import | 5 |
| add-required-param: only-uncertain: namespace-import+opaque-re-export | 2 |
| add-required-param: only-uncertain: opaque-re-export | 3 |
| add-required-prop: only-uncertain: namespace-import | 1 |
| add-required-prop: only-uncertain: namespace-import+opaque-re-export | 1 |
| remove-export: no-consumer-found | 7 |
| remove-export: only-uncertain: dynamic-import+namespace-import+opaque-re-export | 1 |
| remove-export: only-uncertain: namespace-import | 112 |
| remove-export: only-uncertain: namespace-import+opaque-re-export | 2 |
| remove-export: only-uncertain: opaque-re-export | 4 |

### R2 · Corpus B: real PRs

| Repo | PRs | Analyzed | Any surface delta | A `removed` or `changed` entry | Delta + ≥ 1 untouched consumer (decisive, ≥ 10%) | … counting `uncertain` consumers too | A changed file with an `unknown` surface | `uses-removed-name` findings | Beyond-compiler | Followed within 7 days |
|---|---|---|---|---|---|---|---|---|---|---|
| eslint | 200 | 200 | 0.025 (5/200) | 0.000 (0/200) | 0.000 (0/200) | 0.000 (0/200) | 0.085 (17/200) | 0 | 0 | n/a (0/0) |
| hono | 200 | 200 | 0.075 (15/200) | 0.025 (5/200) | 0.005 (1/200) | 0.005 (1/200) | 0.000 (0/200) | 0 | 0 | n/a (0/0) |

**Every `uses-removed-name` finding** (oracles: still present at merge; consumer changed within 7 days; type-check of `typechecked` consumers):

None.

### R3 · Time per PR

| Repo | Median (hono budget ≤ 2 s) | p95 (hono budget ≤ 10 s) | Max | Slowest PRs (ms, source files, importers parsed) |
|---|---|---|---|---|
| eslint | 62 ms | 101 ms | 266 ms | #21101 266 ms, 1487, 0; #21054 239 ms, 1487, 0; #21210 153 ms, 1493, 0; #21313 150 ms, 1491, 0; #21261 133 ms, 1489, 0 |
| hono | 64 ms (within budget) | 92 ms | 313 ms | #5512 313 ms, 459, 5; #5154 306 ms, 388, 40; #5463 192 ms, 448, 6; #5442 191 ms, 392, 0; #5466 188 ms, 451, 4 |

Measured on Apple M2 (8 cores, 8 GB), darwin-arm64, Node v20.19.0, wall clock per PR with fresh resolver and caches, TypeScript already loaded. Not a CI runner.

### R4 · Post-hoc: how the oracle's consumers really reach each positive (NOT part of the rule; cannot change the verdict)

Written after the R1 results by `scripts/surface-pilot/posthoc.ts` (`posthoc.json`). For every positive, the oracle's ground-truth consumers are re-read with TypeScript's own module resolution (not `src/surface/`) and the positive gets the strongest way any of them reaches the mutated export. Cells: detected / positives.

| How a verified consumer reaches the export | pooled | eslint | hono | vue-core |
|---|---|---|---|---|
| named | 1.000 (194/194) | 1.000 (3/3) | 1.000 (96/96) | 1.000 (95/95) |
| named-via-barrel | 1.000 (18/18) | – | 1.000 (11/11) | 1.000 (7/7) |
| only-via-export-star | 0.000 (0/13) | – | – | 0.000 (0/13) |
| only-namespace | 0.091 (1/11) | 0.000 (0/8) | 0.333 (1/3) | – |
| no-import-found | 0.056 (7/124) | 0.018 (2/109) | 0.300 (3/10) | 0.400 (2/5) |

Detection where a verified consumer names the export directly or through explicit re-exports (`named` + `named-via-barrel`): 1.000 (212/212).

<!-- surface-pilot:results:end -->

### Reading of the evidence (post-hoc interpretation, 2026-11-10; not part of the rule)

Written after the runs. It explains the verdict; it does not change it.

1. **The verdict is NOT CORRECT.** Removal recall misses 0.95 in every repo, and eslint also misses the signature/property recall threshold. There were no false positives: 0 of 360 negative controls.
2. **Where syntax can see the consumer, the analysis found it.** R4 re-reads every positive's ground-truth consumers with TypeScript's own resolver. When a consumer names the export directly, or through explicit re-exports, the analysis reported it in 212 of 212 positives. Every miss falls into one of three classes:
   - **Ground-truth artefacts (124 positives, 117 missed).** The preregistered oracle counts a file as a consumer when `findReferences` returns a reference in it. Two TypeScript behaviours make that wrong here:
     - On a re-export specifier, `findReferences` follows the alias to the original declaration. Files that import the original module directly were counted as consumers of the barrel's export. Example: hono's `src/adapter/*/index.ts` barrels, where nothing in the repository imports those names from the barrel; the only `from 'hono/aws-lambda'` text is in JSDoc examples.
     - eslint types every rule's `module.exports = { meta, create }` with one JSDoc interface, so each rule's `create` is linked to every other rule's. That produced 30,972 "consumers". The real importer, `lib/rules/index.js`, loads whole modules.
     
     This flaw is in the preregistered instrument, not in the analysis. It is reported, not corrected, because changing the ground truth after seeing the results is exactly what preregistration exists to prevent.
   - **Namespace and whole-module imports (11 positives, 10 missed).** Examples: `import * as JWT from './jwt'`, and eslint's `const astUtils = require('./utils/ast-utils')`. These are `uncertain` by design.
   - **`export *` barrels (13 positives, all missed).** vue's packages read `@vue/shared` through `export * from './general'`, which is opaque by design.
3. **Real PRs rarely produce the fact at all.** In hono, 1 of 200 PRs had an untouched consumer of a removed or changed export: #5154, a `kind-changed` on `useRef` (function to const), which is not a breakage. In eslint, 0 of 200 did. Neither repository produced a `uses-removed-name` finding, so nothing could be witnessed beyond the compiler. In eslint, the preregistered CommonJS rule also makes central modules `unknown` (`module.exports = SourceCode`, `ast-utils.js`) in 17 of 200 PRs. Had CORRECT held, corpus B would have given STOP (0.5% and 0% against the 10% bar).
4. **Speed is not the problem:** hono's median was 64 ms per PR and its p95 92 ms, against budgets of 2 s and 10 s.
5. **Recommendation:** per the prompt, nothing else needs to happen. A rerun with a corrected oracle (resolving imports by module rather than by symbol references) and with `export *` expanded would probably clear the correctness bar. Corpus B suggests it would then stop on relevance. Any rerun needs a fresh preregistration and a new seed.

### Run notes

- **Harness only; no definition, rule or analysis code changed.** Mutation commits are written with git plumbing. Piping the mutated text into `git hash-object -w --stdin` through `execFileSync` hung twice: in the first hono attempt and the first vue-core attempt, with `git` blocked reading stdin. Both runs were killed and restarted from scratch. The runner now writes the blob from a temporary file (`git hash-object -w --no-filters <file>`), which gives the same blob ids, so mutation commits are unchanged. The decisive hono and eslint corpus-A runs used the intermediate fix (stdin as an explicit pipe, plus a timeout); vue-core used the temporary-file version.
- **Node version:** the runs and timings used Node v20.19.0, which is below the package's `engines` (≥ 22). The test suite passes on it.
- **R4 and `posthoc.ts` were written after seeing R1** and are labeled post-hoc wherever they appear.

### Reproducing

Nothing below installs, builds or runs code from the analyzed repositories.

```bash
git clone --bare https://github.com/honojs/hono.git /tmp/ra18/hono.git
git clone --bare https://github.com/eslint/eslint.git /tmp/ra18/eslint.git
git clone --bare https://github.com/vuejs/core.git /tmp/ra18/vue-core.git
node --import tsx scripts/surface-pilot/run.ts corpus-a --repo hono --git /tmp/ra18/hono.git
node --import tsx scripts/surface-pilot/run.ts corpus-a --repo eslint --git /tmp/ra18/eslint.git
node --import tsx scripts/surface-pilot/run.ts corpus-a --repo vue-core --git /tmp/ra18/vue-core.git
node --import tsx scripts/surface-pilot/run.ts corpus-b --repo hono --git /tmp/ra18/hono.git --gutter-bench <gutter>/docs/benchmark/data/honojs__hono/stage0/default/bench.json
node --import tsx scripts/surface-pilot/run.ts corpus-b --repo eslint --git /tmp/ra18/eslint.git
node --import tsx scripts/surface-pilot/posthoc.ts --corpora /tmp/ra18   # post-hoc only (R4)
node --import tsx scripts/surface-pilot/report.ts --write
```

Mutations are deterministic (seed `20261110`), and so are their commit ids (fixed author, committer and date). Times differ by machine.
