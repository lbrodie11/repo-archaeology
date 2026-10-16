# Repo Archaeology

[![CI](https://github.com/lbrodie11/repo-archaeology/actions/workflows/ci.yml/badge.svg)](https://github.com/lbrodie11/repo-archaeology/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/repo-archaeology.svg)](https://www.npmjs.com/package/repo-archaeology)
[![License: MIT](https://img.shields.io/badge/license-MIT-2f6f5e.svg)](https://github.com/lbrodie11/repo-archaeology/blob/main/LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-%3E%3D22-3c873a.svg)](https://github.com/lbrodie11/repo-archaeology/blob/main/package.json)

**Discover files you might have forgotten to update.** Explore hidden relationships in your codebase using Git history. See which files frequently change together, investigate why, and check your pending changes for possible omissions.

A repository tells two stories. The source tree says what depends on what. Git history records what people have learned to change together.

Repo Archaeology compares those stories. It finds **ghost wires**: files that repeatedly change together even though neither imports the other. It shows the commits behind each relationship, suggests files a change may have overlooked, and offers cautious explanations when both files reference the same rare environment variable, API route, or event name.

Everything runs locally against `.git`. There is no account, upload, or server, and warnings never block a commit unless you explicitly request an exit code.

![Repo Archaeology map showing ghost wires in the Hono repository](https://raw.githubusercontent.com/lbrodie11/repo-archaeology/main/docs/repo-archaeology-map.png)

*The interactive map on [honojs/hono](https://github.com/honojs/hono), generated locally with the default thresholds.*

## The two core experiences

* **Check your changes**: Find related files that historically changed alongside the files you are editing:
  ```bash
  npx repo-archaeology diff
  # Or check an entire feature branch against main:
  npx repo-archaeology diff --base main
  ```
* **Explore your codebase**: Open an interactive visual graph showing hidden coupling across your project:
  ```bash
  npx repo-archaeology map
  ```

## When to use Repo Archaeology

| Situation | What Repo Archaeology does | Recommended command |
| --- | --- | --- |
| **Editing code** | Check if files that usually change alongside your edits were missed | `npx repo-archaeology diff` |
| **Reviewing a PR** | Check all commits on a branch before merging | `npx repo-archaeology diff --base main` |
| **Joining a new project** | Surface surprising dependencies between modules | `npx repo-archaeology` |
| **Architecture audits** | Visualize historical coupling across folders | `npx repo-archaeology map` |

## Quick start

Requires Node.js 22+ and Git 2.24+. Run it inside any Git repository:

```bash
# Explore your current Git repository
npx repo-archaeology

# Open the interactive map
npx repo-archaeology map

# Check potentially overlooked files
npx repo-archaeology diff

# Show all options
npx repo-archaeology --help
```

Or install it globally:

```bash
npm install -g repo-archaeology
```

With no subcommand, Repo Archaeology checks changed files when they have usable history. On a clean tree, it shows the strongest hidden relationships and points you to the map.

## Example

```text
$ repo-archaeology diff

You changed 1 file.

Possibly missed (2)

  src/adapter/deno/serve-static.ts  ghost wire
    changed with src/adapter/bun/serve-static.ts in 12 of 19 commits (63%) · last together 5 months ago
    possible parallel implementations: serve-static.ts appears in sibling folders
    26f8c33 2026-05-16  fix(serveStatic): make options parameter optional in all adapters (#4934)
    1196f14 2025-08-07  feat(serve-static): use `join` to correct path resolution (#4291)
    246a06a 2024-09-24  feat(serve-static): support absolute root (#3420)

  src/adapter/cloudflare-workers/serve-static.ts  ghost wire
    changed with src/adapter/bun/serve-static.ts in 10 of 19 commits (53%) · last together 5 months ago
    ...
```

*(Real output from the [hono](https://github.com/honojs/hono) repository after editing the Bun adapter.)*

## Commands

| Command | What it answers |
| --- | --- |
| `repo-archaeology` | If files changed, what might be missing? If clean, what are the strongest hidden relationships? |
| `scan` | Which files in this repo are secretly coupled? |
| `diff [--base main]` | I changed these files. What usually changes with them that I haven't touched? |
| `file <path>` | What does history know about this file: churn, owners, companions? |
| `map` | Show me the whole picture as an interactive map in the browser. |
| `backtest` | How often would these suggestions have been right on recent history? |

Every command accepts `--json`. Run `repo-archaeology --help` for all options.

### `diff`

Looks at staged, unstaged and untracked changes (renames included). With `--base main`, it also includes the commits on your branch since it forked from `main`, so it works as a pre-PR check.

```bash
repo-archaeology diff --base main
repo-archaeology diff --exit-code   # exit 1 when something looks missed (for hooks/CI)
```

### `map`

Writes a single self-contained HTML file (no network requests, works offline) and opens it. Files are dots sized by churn and coloured by folder; ghost wires are pink dashed lines. Click a file to see what moves with it and the commits behind each link. By default the map is written to `.git/repo-archaeology/map.html`, which is never committed. Use `--out` to put it elsewhere. The map includes file paths, author names and commit subjects, so treat it like the repository itself when sharing.

The overview prioritizes pairs that changed together within the past year and meet `--min-confidence` in both directions. Independent folders receive priority over parent/child folders and possible parallel implementations. Wilson score orders findings within each group. This is a discovery heuristic, not a risk score; older and one-way links remain available, and `diff` ranking is unchanged.

Unsupported code/schema pairs remain **unchecked**, not proven ghost wires. `diff` includes these by default. Use `map --kinds unknown` or `scan --kinds unknown` to inspect them without the default unchecked cap.

### `backtest`

Learns from older commits only, then replays newer ones one changed file at a time and checks whether the suggestions were among the files that really changed. It compares against a "guess the most popular files" baseline scored on the same changes.

```text
strategy                   speaks up   hit@3   precision   false alarms   recall
co-change                        65%     64%         37%            36%      13%
popularity, same changes         65%     13%          5%            87%       3%
```

Use it to choose thresholds for your repo. To avoid fooling yourself, tune with `--before <date>` (an older window) and look at the final score once without it.

`repo-archaeology backtest --ghosts` adds a diagnostic breakdown of the original top-k suggestions that are ghost wires in today's working tree. It reports raw query/suggestion counts, hit rate and precision without altering the main scores. **Current imports leak future information**, including with `--before`; missing current files are excluded. This is neither an unbiased historical ghost-accuracy estimate nor a simulation of filtering to ghosts before ranking.

## How to read the results

Every relationship has a kind:

| Kind | Meaning |
| --- | --- |
| **ghost wire** | No import link was detected between the files in the current code, not even one step removed, yet they change together. The interesting one. |
| **indirect import** | No direct import, but one file imports a file that imports the other (for example `hono.ts → hono-base.ts → compose.ts`). The coupling is visible in the code, one step removed. |
| **import link** | One imports or explicitly path-references the other, directly or through an index/barrel file. A type reference is not a runtime import. |
| **test link** | A test changing with code, or tests changing together. Expected. |
| **unchecked** | We could not check dependencies fully: non-JS/TS files, project config such as `package.json`, unresolved imports or path references, or dynamic loads whose target is computed at runtime (`import(name)`, `require(name)`, `import.meta.glob`). |

**Confidence is directional.** "When `a.ts` changed, `b.ts` changed too in 9 of 12 commits (75%)" says nothing about how often `a.ts` changes when `b.ts` does; that number is shown as *reverse*.

**Results are ranked by evidence**, not just by percentage: 3 out of 3 ranks below 40 out of 50 (Wilson score lower bound).

**It is a historical signal, not proof.** Two files changing together in the past does not mean your change needs both.

**Hidden bridges are possible explanations, not diagnoses.** For JS/TS files, Repo Archaeology recognizes possible parallel implementations in sibling folders and walks the TypeScript syntax tree for shared environment variables, `/api/...` route strings, event names used in event-method calls, and explicit named exports. Reference signals are shown only when at most three current, non-ignored source files use them. A shared export name suggests a possible public contract, not identical behavior; private, default, wildcard and nested namespace exports are not inferred. Without a recognized signal, the tool says only that no import link was detected in the current code.

## Options

Global options work with every command:

| Option | Default | Meaning |
| --- | --- | --- |
| `--min-shared <n>` | 3 | Minimum commits two files must share |
| `--min-confidence <p>` | 0.4 | Minimum directional confidence (`0.4` or `40%`) |
| `--max-commits <n>` | 5000 | Most recent non-merge commits to read |
| `--since <date>` | | Only commits after this date (`"2 years ago"`, `2024-01-01`) |
| `--max-files <n>` | 25 | Commits touching more files are treated as sweeps (formatting, mass renames) and skipped |
| `--ignore <glob>` | | Ignore matching files (repeatable) |
| `--no-default-ignores` | | Keep lockfiles, build output, snapshots and changelogs |
| `--skip-commits <regex>` | | Skip commits whose subject matches, e.g. `"^(chore\|style)\b"` |
| `--half-life <days>` | | Weight recent commits more |
| `-C, --cwd <path>` | | Run as if started in `<path>` |

Settings can also live in `.repo-archaeology.json` at the repository root (flags win):

```json
{
  "minShared": 3,
  "minConfidence": 0.4,
  "maxFilesPerCommit": 25,
  "ignore": ["docs/generated/", "*.pb.go"],
  "skipCommitPrefixes": ["chore", "deps"],
  "skipCommits": "^chore\\(deps\\)"
}
```

The config file is part of the repository, so it is treated as untrusted input: it must be a small regular file, `maxFilesPerCommit` is capped at 1000, and `skipCommits` patterns that can backtrack catastrophically (quantifiers vulnerable to polynomial/exponential ReDoS, repeated groups with alternation, or backreferences) are refused. For safe prefix-based skipping without regexes, use `skipCommitPrefixes`. Command-line flags are not restricted.

## How it works

1. **History.** Streams `git log --no-merges -M --name-status -z` (NUL-delimited, so any file name is safe). Renames are followed, so a file keeps its history when it moves. A path later reused for a different file is not confused with the original.
2. **Noise.** Lockfiles, build output, snapshots and changelogs are ignored. Commits touching more than 25 files are treated as sweeps and skipped. Single-file commits are kept, because leaving them out would inflate every confidence number.
3. **Statistics.** For files A and B: `confidence(A→B) = shared(A, B) / changes(A)`, ranked by the Wilson lower bound.
4. **Imports.** JS/TS files are parsed with TypeScript's pre-processor (comments and strings are handled correctly), and imports are resolved across relative paths, `.js`→`.ts` swaps, index files, `tsconfig`/`jsconfig` `paths` and `baseUrl` (including relative `extends` files and project `references` such as `tsconfig.app.json`), and the repository's own packages, including monorepo workspaces and `exports` maps (conditions are matched in the map's own order, as Node does). Only the current code is analyzed. Only regular files inside the repository are read; symlinks are skipped.
  TypeScript `/// <reference path="..." />` directives count as explicit dependencies too. Paths are resolved exactly, relative to the declaring file and within the repository; missing or outside-repository targets make the import check uncertain. `types` and `lib` directives are not treated as local file paths. JSON keeps the existing `direct` relationship kind, with reference-specific explanation text.
5. **Possible explanations.** The TypeScript syntax tree is checked for rare shared environment variables, API routes, and event names. This is evidence for a possible bridge, never proof of causation.

Known limits:

- Import checks cover JS/TS only.
- Unmatched scoped aliases or dynamic runtime imports whose targets are computed dynamically leave affected pairs reported as **unchecked**, never as ghost wires.
- In config-heavy monorepos (many example apps with their own `package.json`), most relationships can end up unchecked. `scan` caps how many it shows.
- Merge commits are skipped. Edits made on a branch to a file that was renamed on the main line are folded into the renamed file, but squash-merge and rebase workflows still give the cleanest signal.
- Shallow clones only see part of the history; the tool warns about this.
- In `map`, "recent" means within a year of the newest analyzed commit, not of today.

## Project status

The v0.1 implementation is complete and tested, but the product hypothesis is not yet validated. The built-in `backtest` measures suggestion quality; the remaining question is whether developers choose to run `diff` again after trying it. See [PLAN.md](https://github.com/lbrodie11/repo-archaeology/blob/main/PLAN.md) for the validation gates and roadmap.

Repo Archaeology currently understands JavaScript and TypeScript imports. Other file types still participate in history analysis, but their import relationships may be marked **unchecked**.

## Contributing

Bug reports and real-world suggestion feedback are welcome in [GitHub Issues](https://github.com/lbrodie11/repo-archaeology/issues). Please avoid posting proprietary file names, commit subjects, or source code from private repositories.

To work on the project:

```bash
npm install
npm test
npm run typecheck
npm run build
npm run dev -- scan -C ../some-repo
```

## License

MIT
