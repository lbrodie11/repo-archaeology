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

## Shipped Foundations (`v0.2.x` – `v0.3.0`)

- **Pre-Change Baseline Training (`v0.2.0`):** Isolates co-change training to pre-branch commits (`git merge-base HEAD <ref>`) when checking feature branches (`diff --base`), preventing branch commits from self-reinforcing historical statistics while bridging branch-local renames.
- **"Explain My Silence" Diagnostics (`v0.2.0`):** Transparent CLI and JSON explanations when a change produces zero suggestions (e.g., new files without history, all companions already touched, or closest companions filtered by `--min-shared`, `--min-confidence`, or `--kinds`).
- **Verifiable Change Evidence & Finding Families (`v0.2.0`):** Inspect bounded Git diff hunks and counterexample commits via `explain <fileA> <fileB>` and `map --include-patches`, and group 3+ sibling parallel implementations into unified **Finding families** across `scan`, `diff`, and `map`.
- **Follow-Up Fix Benchmark (`v0.2.0`):** Evaluate multi-commit temporal omissions via `backtest --follow-ups`.
- **Frozen v1 JSON Contract & Schemas (`v0.3.0`):** Versioned `--json` envelope (`schemaVersion: 1`, `tool: { name, version }`), formal Draft 2020-12 JSON Schemas in [`schema/`](schema), and documentation in [`docs/json.md`](docs/json.md).
- **Quiet GitHub Action & Markdown PR Summaries (`v0.3.0`):** Deterministic Markdown rendering (`diff --format markdown --json-out <file>`) and an official composite GitHub Action (`action.yml`) that posts advisory pull request summaries to `$GITHUB_STEP_SUMMARY` with pinned head/base SHA verification.

---

## Upcoming Milestones

### Milestone 1: Coding-Agent Recipes & MCP Server
- **CLI/JSON Agent Hook Recipes:** Documented, zero-dependency integration recipes for Claude Code, Cursor, Windsurf, and GitHub Copilot built on the `schemaVersion: 1` JSON contract.
- **Model Context Protocol Server (`repo-archaeology mcp`):** A read-only MCP server exposing structured co-change and evidence tools (`find_related_files`, `explain_relationship`, `check_changeset`) over `stdio`.

### Milestone 2: Verified Open-Source Gallery & Multi-Repo Benchmark
- **Interactive Showcase Gallery:** Public interactive HTML maps and verified finding walk-throughs for flagship open-source repositories.
- **Held-Out Multi-Repository Benchmark:** Transparent accuracy, coverage, and follow-up evaluation across diverse open-source repositories.

### Milestone 3: Relationship Verdicts, Architecture Evolution & Noise Controls
- **Relationship Verdicts (`.repo-archaeology.verdicts.json`):** Repo-committed configuration for silencing expected mechanical relationships (with optional reasons and expiration dates) and annotating confirmed hidden dependencies for teammates and coding agents.
- **Stateless Architecture Evolution (`evolution --from <ref> --to <ref>`):** Compare co-change models across Git tags or releases (with cross-revision rename lineage mapping) to spot newly emerged or strengthening ghost wires.
- **Formatting-Only Commit Filter:** Optional whitespace-aware filtering (`git diff -w`) so small formatting-only commits do not inflate co-change counts.

### Milestone 4: Contract-Aware Relationships (`--contracts`)
- **Schema & Contract History:** Block-level historical co-change tracking for logical schema units (starting with Prisma `model` and `enum` blocks) so monolithic schema files do not couple unrelated modules.

---

## Contributing & Feedback

Have ideas, questions, or a repository where Repo Archaeology produced surprising findings?
- Open an issue or join discussions on [GitHub Issues](https://github.com/lbrodie11/repo-archaeology/issues).
- Pull requests and feedback on suggestion accuracy are warmly welcomed!
