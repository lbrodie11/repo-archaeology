# Repo Archaeology Roadmap

Repo Archaeology is a local-first developer tool that mines your Git history to find files that repeatedly change together—even when no import connects them—and shows you the commits behind them.

This roadmap outlines shipped capabilities and upcoming milestones for the open-source community.

Last updated: November 2026

---

## Guiding Principles

1. **Local-First & Private:** Analysis runs 100% locally against `.git`. No accounts, no code uploads, and no external telemetry.
2. **Evidence Before Certainty:** Recommendations provide verifiable commit evidence and cautious explanations, not unprovable bug predictions.
3. **Quiet by Default:** Historical signals inform review; they never block developers or cause alert fatigue unless explicitly requested (`--exit-code` or `fail-on-suggestions`).
4. **Action Over Spectacle:** Practical diff-checking (`diff`), hidden dependency auditing (`scan`), and accuracy testing (`backtest`) take precedence over decorative visuals.

---

## Shipped Foundations (`v0.2.x` – `v0.9.0`)

- **Pre-Change Baseline Training (`v0.2.0`):** Isolates co-change training to pre-branch commits (`git merge-base HEAD <ref>`) when checking feature branches (`diff --base`), preventing branch commits from self-reinforcing historical statistics while bridging branch-local renames.
- **"Explain My Silence" Diagnostics (`v0.2.0`):** Transparent CLI and JSON explanations when a change produces zero suggestions (e.g., new files without history, all companions already touched, or closest companions filtered by `--min-shared`, `--min-confidence`, or `--kinds`).
- **Verifiable Change Evidence & Finding Families (`v0.2.0`):** Inspect bounded Git diff hunks and counterexample commits via `explain <fileA> <fileB>` and `map --include-patches`, and group 3+ sibling parallel implementations into unified **Finding families** across `scan`, `diff`, and `map`.
- **Follow-Up Fix Benchmark (`v0.2.0`):** Evaluate multi-commit temporal omissions via `backtest --follow-ups`.
- **Frozen v1 JSON Contract & Schemas (`v0.3.0`):** Versioned `--json` envelope (`schemaVersion: 1`, `tool: { name, version }`), formal Draft 2020-12 JSON Schemas in [`schema/`](schema), and documentation in [`docs/json.md`](docs/json.md).
- **Quiet GitHub Action & Markdown PR Summaries (`v0.3.0`):** Deterministic Markdown rendering (`diff --format markdown --json-out <file>`) and an official composite GitHub Action (`action.yml`) that posts advisory pull request summaries to `$GITHUB_STEP_SUMMARY` with pinned head/base SHA verification.
- **Programmatic Library API & Import Graph (`v0.4.0`):** First-class ESM library (`openRepository()` in [`docs/api.md`](docs/api.md)), `repo-archaeology imports [--files ...]`, and workspace/monorepo/`exports`/`imports`/`tsconfig` import resolution with coverage diagnostics (`meta.imports`).
- **Historical Revision Analysis (`--head <ref>`) & Persistent History Cache (`v0.4.0`):** Analyze any commit or tag without checking it out, backed by an incremental, settings-independent raw-commit cache in `<git-common-dir>/repo-archaeology/cache/`.
- **Statistical & Origin-Aware Evidence (`v0.4.0`):** Two-sided 95% Wilson confidence intervals (`interval` / `reverseInterval`), `human` / `agent` / `bot` commit origin classification and weighting (`--origin-weights`, `backtest --compare-origin-weights`), relationship verdicts (`.repo-archaeology.verdicts.json`), and historical contributor / `CODEOWNERS` context (`--owners`).
- **Precomputed Map Engine & Opt-In FRAME/12 `--style rich` (`v0.4.0`):** Deterministic precomputed layout (`#ra-layout`) with zero-idle-CPU rendering, plus opt-in `--style rich` FRAME/12 editorial terminal output and ranked contact-sheet ("dig sheet") browser maps.
- **FRAME/12 Investigation Board & Built-In Field Guide (`v0.5.1`):** Interactive `Briefing` + `Atlas` views in `map --style rich` with a featured finding ego-network blueprint (`C-01`), directional co-change and Wilson confidence interval evidence cards, ranked findings index (`C-05`), and a built-in 12-term **Repo Archaeology Field Guide** with contextual `?` popovers and worked statistical explanations.
- **Revert Filtering & Honest Suffix Families (`v0.6.0`):** Mechanical `Revert "…"` / `Reapply "…"` commits are skipped by default (`meta.revertsSkipped`, `--include-reverts` to opt out), and same-directory suffix families exclude generic layer suffixes (`-service`, `-controller`, …).
- **Pair-Centered Briefing Plate on One Shared Engine (`v0.7.0`):** The Briefing plate is laid out by a single deterministic engine used by both the report and the browser, in rows by relationship to the selected pair, with curved wires that avoid unrelated files and labels, width-aware compact plates, keyboard access, and trace-on-hover.
- **Readable Atlas Overview (`v0.8.0`):** Dense Atlas frames draw as folder groups until opened or zoomed, frames hidden by filters explain themselves, captions and labels stay readable at any zoom, and `Reset view` reaches every frame; seeded browser stress tests cover the plate and the Atlas.
- **Go and Python Import Analysis (`v0.9.0`):** Go and Python files get the same import checking as JS/TS, through one shared analysis pipeline, with dependency-free lexers that never execute code. Go resolves `go.mod`/`go.work` modules and replacements to package files; Python resolves source roots (`pyproject.toml`, `setup.cfg`, `setup.py` read as text) with the import system's package rules. When the analyzer is unsure, the pair stays unchecked, never a ghost wire.

---

## Upcoming Milestones

### Milestone 1: Coding-Agent Recipes, Pre-Change Briefing & MCP Server
- **CLI/JSON Agent Hook Recipes:** Documented, zero-dependency integration recipes for Claude Code, Cursor, Windsurf, and GitHub Copilot built on the `schemaVersion: 1` JSON contract.
- **10-Second Pre-Change Briefing (`file <path>`):** Concise pre-edit file briefing surfacing top historical companions, Finding Family siblings, associated test files, recent commits, and the last shared co-change commit.
- **Model Context Protocol Server (`repo-archaeology mcp`):** A read-only MCP server exposing structured co-change and evidence tools (`find_related_files`, `explain_relationship`, `check_changeset`) over `stdio`.

### Milestone 2: Verified Open-Source Gallery, "Beat the Archaeologist" & Multi-Repo Benchmark
- **Interactive Showcase Gallery & "Beat the Archaeologist" Challenge:** Public interactive HTML maps, verified finding walk-throughs, and a 5-round historical prediction challenge (`backtest --quiz`) built on real held-out commits from flagship open-source repositories.
- **CodeTour Export (`.tours/`):** Export high-confidence ghost wires and Finding Families to VS Code / GitHub Codespaces `.tour` files backed by real commit citations.
- **Held-Out Multi-Repository Benchmark:** Transparent accuracy, coverage, and follow-up evaluation across diverse open-source repositories.

### Milestone 3: PR-Time Coupling Signals, Relationship Verdicts & Architecture Evolution
- **"✓ Already Updated" Companions & New Coupling Signals in `diff`:** Positive confirmation when a PR already updates expected historical companions, plus early surfacing when a branch introduces or strengthens hidden coupling.
- **Relationship Verdicts (`.repo-archaeology.verdicts.json`) *(Shipped)*:** Repo-committed configuration for silencing expected mechanical relationships (with optional reasons and expiration dates) and annotating confirmed hidden dependencies for teammates and coding agents without altering underlying historical scores (`repo-archaeology verdict add|list|prune`, `--show-silenced`, `schema/verdicts.schema.json`).
- **Stateless Architecture Evolution (`evolution --from <ref> --to <ref>`):** Compare co-change models across Git tags or releases (keyed by cross-revision rename lineage over a fixed commit range) to spot newly emerged or strengthening ghost wires.
- **Formatting-Only Commit Filter:** Optional whitespace-aware filtering (`git diff -w`) so small formatting-only commits do not inflate co-change counts.

### Milestone 4: Contract-Aware Relationships (`--contracts`)
- **Schema & Contract History:** Block-level historical co-change tracking for logical schema units (starting with Prisma `model` and `enum` blocks) so monolithic schema files do not couple unrelated modules.

---

## Contributing & Feedback

Have ideas, questions, or a repository where Repo Archaeology produced surprising findings?
- Open an issue or join discussions on [GitHub Issues](https://github.com/lbrodie11/repo-archaeology/issues).
- Pull requests and feedback on suggestion accuracy are warmly welcomed!
