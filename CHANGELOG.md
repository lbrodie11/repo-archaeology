# Changelog

All notable changes to **Repo Archaeology** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Two-Sided 95% Wilson Confidence Intervals (`interval`, `reverseInterval`):** Added `wilsonInterval(successes, trials, z)` in [`src/util/stats.ts`](src/util/stats.ts) and exposed `interval: { low, high }` and `reverseInterval: { low, high }` (computed from unweighted raw commit counts and rounded to 4 decimals) on every relationship view, suggestion, family member pair, file companion, and `explain` result across JSON (`diff`, `scan`, `file`, `explain`), Markdown (`diff --format markdown`), terminal output, and interactive map tooltips/panels (`schema/common.schema.json`, `schema/file.schema.json`, `schema/explain.schema.json`, `docs/json.md`).
- **Gutter Consumer Contract Guard ([`test/consumer-gutter.test.ts`](test/consumer-gutter.test.ts)):** Freezes the exact `schemaVersion: 1` `diff --json` and `backtest --json` field paths, types, relationship kinds, `silence.primaryReason` codes, and strategy names consumed by Gutter (`lbrodie11/gutter`), with individual negative mutation tests that fail naming Gutter when any frozen field is removed or retyped.
- **Release Tarball & Schema Smoke Test ([`scripts/smoke-pack.mjs`](scripts/smoke-pack.mjs), [`scripts/schema-validator.mjs`](scripts/schema-validator.mjs)):** Packs the release tarball into a temporary directory, verifies the packed file allowlist, installs into an isolated prefix, runs the installed `repo-archaeology` binary (`diff --base <first-branch-point> --json` and `backtest --json`) against a 40-commit synthetic Git repository with sanitized `GIT_*` environment variables, and validates both outputs against `schema/diff.schema.json` and `schema/backtest.schema.json` in CI (`.github/workflows/ci.yml`).
- **Automated Tag-Driven Release Pipeline ([`.github/workflows/release.yml`](.github/workflows/release.yml), [`scripts/release-helper.mjs`](scripts/release-helper.mjs)):** Consolidates release publishing into a single `v*.*.*` tag workflow split into least-privilege `verify`, `publish` (`id-token: write`), and `github-release` (`contents: write`) jobs, with SHA-pinned GitHub Actions, prerelease `--tag next` / `--prerelease` support, digest-verified retry recovery, and automatic triggering of `.github/workflows/action-smoke.yml`.

## [0.3.0] - 2026-11-01

### Added
- **Versioned v1 JSON Output Contract (`schemaVersion: 1`):**
  - Added top-level `schemaVersion: 1` and `tool: { name: "repo-archaeology", version: "<semver>" }` to every `--json` output across `scan`, `diff`, `file`, `explain`, `map`, `backtest`, and the bare default command (`mode: "diff" | "scan"`), preserving all existing `v0.2.x` fields without breaking changes.
  - Added formal JSON Schema (Draft 2020-12) definitions under [`schema/`](schema) (`common`, `scan`, `diff`, `file`, `explain`, `map`, `backtest`, and `default`) and included `schema/` in the published npm package.
  - Added [`docs/json.md`](docs/json.md) documenting all v1 JSON output shapes, required vs. optional properties, portable vs. host-specific path fields, and the schema versioning policy.
- **Deterministic Markdown PR Renderer & Single-Pass JSON Output (`diff`):**
  - Added `repo-archaeology diff --format <text|markdown>` (`src/report/markdown.ts`) to render deterministic GitHub-Flavored Markdown summaries with Finding Families, directional co-change evidence (including explicit recency-weighted labels when `--half-life` is active), up to 3 supporting commits per suggestion, baseline-aware copyable `explain --base <fullSha>` commands, honest silence diagnostics, untrusted input escaping (`@\u200Bmentions`, `#\u200B123` / `GH-\u200B123` autolinks, HTML/Markdown/bidi controls), and an exact 512 KiB UTF-8 byte budget ceiling.
  - Added `--base <ref>` to `repo-archaeology explain` so reviewers can inspect pre-change baseline history directly (resolving branch/working-tree rename lineage before matching baseline filenames while preserving current filenames for working-tree import classification).
  - Added `repo-archaeology diff --json-out <file>` (`src/report/contract.ts`) to atomically write the versioned `schemaVersion: 1` JSON payload in the same single Git history run as `--format markdown` or terminal text output, with path validation against symlink, non-regular device/FIFO/socket, and `.git` internal directory writes.
- **Official Composite GitHub Action (`action.yml`):**
  - Added root-level composite `action.yml` and runner (`src/action/runner.ts`) for non-blocking pull request summaries written to `$GITHUB_STEP_SUMMARY`.
  - Verifies checked-out `HEAD` matches the expected PR `head` commit SHA (detecting GitHub Actions' default synthetic `refs/pull/:id/merge` commit with actionable guidance), detects shallow clones (`git rev-parse --is-shallow-repository`) and `< 2`-commit repositories and degrades gracefully with `analysis-status: insufficient-history` and exit code `0`, warns when uncommitted working-tree changes are included in the analysis (`uncommitted-files-count` output and `::warning::` annotation), isolates external `npx` execution outside `$GITHUB_WORKSPACE` while preserving external `NPM_CONFIG_USERCONFIG` / `NPM_CONFIG_GLOBALCONFIG` settings (such as `actions/setup-node` `registry-url`), validates `working-directory` containment within `$GITHUB_WORKSPACE`, and exposes `suggestion-count`, `uncommitted-files-count`, `json-path`, and `analysis-status` outputs.
  - Added dogfooding pull request workflow (`.github/workflows/repo-archaeology.yml`) and post-release consumer smoke workflow (`.github/workflows/action-smoke.yml`).

## [0.2.1] - 2026-11-01

### Changed
- Expanded `README.md` with clear explanations of directional co-change denominators, noise/sweep filtering safeguards, real-world `map`/`diff`/`scan` workflows, and honest limitations.

## [0.2.0] - 2026-10-31

### Added
- **Pre-Change Baseline Isolation (`diff --base <ref>`):** Trains the co-change model strictly at `git merge-base HEAD <ref>` while bridging branch-local file renames (`reconcileBranchLineage`).
- **"Explain My Silence" Diagnostics:** Structured `silence` diagnostics in `diff` explaining why zero suggestions were returned (`no_changed_files`, `limited_repo_history`, `no_history_for_changed_files`, `all_companions_touched`, `no_cochange_partners`, `filtered_by_thresholds`, `filtered_by_kinds`).
- **Follow-Up Fix Benchmark (`backtest --follow-ups`):** Evaluates multi-commit omissions across same-author temporal follow-up commits (`--follow-up-window <hours>`, default `48h`).
- **Evidence Explorer (`explain` & `map --include-patches`):** Bounded Git diff hunk inspection across recent shared commits and counterexample commits, plus opt-in patch previews in the interactive HTML map.
- **Finding Families:** Groups 3+ sibling parallel implementations into unified finding families across `scan`, `diff`, and `map`.

## [0.1.0] - 2026-10-18

### Added
- Initial release of `repo-archaeology` with `scan`, `diff`, `file`, `map`, and `backtest` commands, Wilson lower-bound co-change ranking, TypeScript AST import and reference classification, and hidden bridge signal detection.
