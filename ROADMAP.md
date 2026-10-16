# Repo Archaeology Roadmap

Repo Archaeology is a local-first developer tool that mines your Git history to find files that repeatedly change together—even when no import connects them—and shows you the commits behind them.

This roadmap outlines high-level product directions and upcoming milestones for the open-source community.

Last updated: October 2026

---

## Guiding Principles

1. **Local-First & Private:** Analysis runs 100% locally against `.git`. No accounts, no code uploads, and no external telemetry.
2. **Evidence Before Certainty:** Recommendations provide verifiable commit evidence and cautious explanations, not unprovable bug predictions.
3. **Quiet by Default:** Historical signals inform review; they never block developers or cause alert fatigue unless explicitly requested (`--exit-code`).
4. **Action Over Spectacle:** Practical diff-checking (`diff`), hidden dependency auditing (`scan`), and accuracy testing (`backtest`) take precedence over decorative visuals.

---

## Upcoming Milestones

### Milestone 1: Review Engine Accuracy & Baselines
- **Pre-Change Baseline Training:** Isolate co-change training to pre-branch commits when checking feature branches (`--base`), ensuring branch edits cannot self-influence historical confidence.
- **"Explain My Silence" Feedback:** Transparent CLI explanations when a change produces zero suggestions (e.g. insufficient commit history, all companions already staged, or confidence below threshold).
- **Expanded Verification:** Automated suggestion quality benchmarks across diverse open-source repositories.

### Milestone 2: Evidence Explorer & Clarity
- **Diff-Level Evidence:** Inspect exact code diff hunks across co-changing commits directly from the CLI and interactive map to understand *why* files co-evolved.
- **Finding Families:** Group N-way parallel implementations (such as runtime adapters across sibling folders) into single, unified finding cards to reduce repetitive noise.
- **Granular Relationship Suppression:** Support project-level `.repo-archaeology.ignore.json` for silencing specific expected relationships with optional reasons and expiration dates.

### Milestone 3: Workflow & Agent Integrations
- **Official GitHub Action:** Advisory pull request job summaries (`$GITHUB_STEP_SUMMARY`) and single-comment persistent updates without PR comment spam.
- **Coding-Agent Integration (MCP):** A read-only Model Context Protocol server exposing tools (`find_related_files`, `explain_relationship`, `check_changeset`) for Cursor, Claude Code, Windsurf, and Copilot.
- **Structured JSON Stability:** Documented, frozen JSON output schemas for seamless pre-commit hooks and custom CI tooling.

### Milestone 4: Multi-Layer Contracts & Ecosystems
- **Contract-Aware Relationships:** Detect non-imported dependencies across Prisma schemas, GraphQL operations, and SQL migration tables.
- **Architecture Evolution:** Compare co-change graphs across major releases to observe how refactoring impacts module coupling over time.

---

## Contributing & Feedback

Have ideas, questions, or a repository where Repo Archaeology produced surprising findings?
- Open an issue or join discussions on [GitHub Issues](https://github.com/lbrodie11/repo-archaeology/issues).
- Pull requests and feedback on suggestion accuracy are warmly welcomed!
