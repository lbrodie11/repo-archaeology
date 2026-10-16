# Repo Archaeology roadmap

Repo Archaeology v0.1 is implemented and tested. The next job is not to add more features; it is to learn whether the current ones are accurate enough and useful often enough to deserve further investment.

Last updated: October 2026.

## Product principles

- **Local first.** Repository history and source stay on the developer's machine.
- **Evidence before certainty.** Every relationship includes commits; hidden bridges are possible explanations, not diagnoses.
- **Quiet by default.** Historical coupling may warn, but it never blocks work unless a developer explicitly opts into `--exit-code`.
- **Useful before elaborate.** `diff`, `scan`, and `backtest` take priority over integrations and visual spectacle.

## What is built

- NUL-safe Git history parsing with rename and file-lifetime tracking.
- Directional co-change confidence, evidence-aware ranking, sweep filtering, and optional recency weighting.
- A smart default command, plus `scan`, `diff`, `file`, `map`, and `backtest`.
- JavaScript and TypeScript import classification using the TypeScript compiler.
- Conservative hidden-bridge explanations for rare shared environment variables, API routes, and event names.
- A self-contained local HTML map with no external runtime requests.
- Strict source and test typechecking, fixture repositories, regression coverage, package smoke tests, and multi-platform CI.

## Validation gates

Record thresholds before testing. Do not tune on a repository and then count that same repository as validation.

### Gate A: suggestion quality

Run `repo-archaeology backtest` with default settings on three repositories that were not used during development.

Pass when at least two of three repositories meet all of these conditions:

- hit@3 is at least 1.5 times the `popularity, same changes` baseline;
- false alarms are at most 50%;
- the model speaks up on at least 20% of eligible changes.

### Gate B: repeat use

Have five developers try `diff` and `scan` on repositories they know.

Pass when at least two choose to run `diff` again without being prompted. Collect feedback through the GitHub issue template, including whether the suggestion was useful and what was confusing.

### Gate C: personal value

Use `diff` before commits for two weeks.

Pass when it identifies at least one file that would genuinely have been missed and remains useful enough to keep in the workflow.

## Before the npm release

- Confirm the public CI matrix passes on Linux, macOS, and Windows.
- Run Gate A on three untouched repositories and record the results.
- Add one clear map screenshot or short terminal recording from a public repository.
- Verify the package name and install a packed tarball in a clean directory.
- Publish v0.1.0 only after the README commands match the released package.

## Next, if the gates pass

1. Cache parsed history under `.git/repo-archaeology/`, keyed by `HEAD` and analysis settings.
2. Add a non-blocking pull-request integration that updates one comment instead of creating duplicates.
3. Surface `file --json` results in a small editor integration.
4. Add import analysis for another language only when tester demand identifies which one.

## Later

- Replay repository history on the map, with files and ghost wires lighting up as commits pass.
- Explore optional generative audio as a demonstration layer, not as core product functionality.

## Known limitations

- Import checks currently cover JavaScript and TypeScript only.
- Merge commits are skipped; squash-merge and rebase workflows provide cleaner signals.
- Shallow clones expose only part of repository history.
- TypeScript is a sizeable runtime dependency and may affect first-run time through `npx`.
- Very large repositories are bounded during source-reference analysis and do not yet have an incremental history cache.
- A shared reference can suggest why files move together, but it cannot prove causation.

## Stop conditions

If suggestion quality fails Gate A after one disciplined tuning round, revisit the model before adding integrations. If repeat-use or personal-value gates fail twice, keep the project as a useful analysis tool and portfolio piece rather than forcing it into a product.
