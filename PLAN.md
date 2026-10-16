# Repo Archaeology: implementation plan

Status as of Friday, October 16, 2026: **v0.1 scaffold is built, tested and working on real repositories, and the six issues from the first external code review are fixed.** This plan covers what is done, how to decide whether to keep going, and what to build next.

## The decision

Build Repo Archaeology as a local-first npm CLI with an interactive map, and treat it as a validated experiment rather than an assumed product.

- **Core:** trustworthy "what usually changes with this?" answers from git history (`diff`, `scan`, `file`).
- **Personality:** ghost wires (co-change with no import link) and a map you want to screenshot (`map`).
- **Honesty:** a built-in backtest that says how often the suggestions would have been right (`backtest`).
- **Not yet:** GitHub Actions, PR bots, 3D cities, accounts, servers.

The space is crowded (Git Truck, git-co-change, gitrisk, Repowise, churnmap). That is fine for a project you build to learn and to use yourself; it is a reason to validate before investing in integrations.

## What v0.1 already does

| Area | Done |
| --- | --- |
| History | NUL-safe streaming `git log` parser; rename following; deleted-then-recreated files get separate lifetimes; merge commits skipped |
| Noise | Default ignores (lockfiles, build output, snapshots, changelogs); sweep cutoff (`--max-files`, default 25); `--skip-commits` regex; single-file commits kept in denominators |
| Statistics | Directional confidence, Wilson lower-bound ranking (effective sample size under a half-life), optional recency half-life, newest-3 evidence commits per pair |
| Imports | TypeScript pre-processor (no regex); relative, `.js`→`.ts`, index files, tsconfig/jsconfig `paths`/`baseUrl` with `extends`, the repo's own packages and workspaces via `exports` maps; barrel files followed 3 levels |
| Classification | ghost wire / import link / test link / unchecked (project config, non-JS, unresolved aliases) |
| Commands | `scan` (default), `diff` (staged, unstaged, untracked, uncommitted renames, `--base`, `--exit-code`), `file`, `backtest` (fixed test set, same-changes baseline, `--before`), `map` (self-contained HTML in `.git/`) |
| Quality | 48 tests including fixture git repos and one regression test per review finding; type-checks under `strict`; runs from a packed tarball; GitHub Actions workflow for Linux, macOS and Windows (not yet run: push the repo to start it) |
| Speed | vite (9,252 commits, full history): 1.8 s. Worst-case synthetic 5,000 × 25-file commits: 1.5 s, ~210 MB |

### First measurements (default settings)

| Repository | Speaks up | Hit@3 when it speaks | Popularity guess, same changes | Lift |
| --- | ---: | ---: | ---: | ---: |
| honojs/hono | 65% | 63% | 12% | 5.3× |
| vitejs/vite | 50% | 75% | 40% | 1.9× |
| tj/commander.js | 47% | 52% | 37% | 1.4× |

Read: on hono, when `diff` flags something, at least one of its top 3 files really changed in the same commit 63% of the time, versus 12% for guessing the busiest files. Commander is small (a handful of files change for everything), so history adds less there. **These three repos were used while building, so they do not count toward the gate below.**

## How to decide whether to continue

Write your answers down before running anything. Do not adjust thresholds after seeing gate results.

**Gate A: suggestion quality.** Pick 3 repositories you did not use while building (ideally ones you work in). Run `npx repo-archaeology backtest` once on each with default settings.

- Pass if, on at least 2 of the 3: hit@3 is at least **1.5×** the "popularity, same changes" row, false alarms are at most **50%**, and it speaks up on at least **20%** of changes.

**Gate B: people.** At least 5 developers run `diff` and `scan` on their own repositories.

- Pass if at least **2** say they would run `diff` again on their own, unprompted.

**Gate C: you.** Use `diff` before your own commits for two weeks.

- Pass if it flagged at least **one** file you would genuinely have missed, and you still want to work on it.

**If A and B pass:** move to Phase 3. **If A fails:** tune with `backtest --before <date>` and re-test on *new* repositories (the failed ones are now training data). **If B or C fails twice:** stop; keep it as a portfolio piece and build what annoyed you most while testing.

## Phases

### Phase 1: make it yours (weekend 1, Oct 17–18, about 8–12 hours)

1. `npm install`, `npm test`, `npm run build`, then `npm link` and run it on two of your own repos. Commit the generated `package-lock.json`.
2. Read the code in this order: `src/git/log.ts` → `src/model/history.ts` → `src/model/cochange.ts` → `src/imports/classify.ts` → `src/commands/diff.ts`. Change anything that surprises you.
3. Check the npm name: `npm view repo-archaeology`. If taken, rename (bin and package name) now.
4. Record a 20-second GIF of `diff` catching a real ghost wire, plus one screenshot of `map`, for the README.
5. Add your name to `LICENSE`, add `repository`/`homepage` fields to `package.json`, push to GitHub, and check that the CI workflow passes on all three operating systems (Windows has never been run).
6. Publish `0.1.0` with `npm publish` (runs typecheck, tests and build first).

**Done when:** `npx repo-archaeology` works on a machine that has never seen the code.

### Phase 2: validate (weekend 2, Oct 24–25, about 10–14 hours)

1. Freeze the gate numbers above in a GitHub issue, then run Gate A.
2. Add a short "try it on your repo" section and a feedback issue template (what it flagged, was it right, would you run it again).
3. Recruit 5 testers: colleagues, a Discord/Slack you are in, one Show HN or Reddit post with the map screenshot.
4. Document a pre-commit recipe: `npx repo-archaeology diff --exit-code` with lefthook or husky (warn only; never block commits by default).
5. Fix the top 3 confusions from tester feedback. Resist new features.

**Done when:** all three gates have a recorded pass or fail.

### Phase 3: only if the gates pass (2–4 weekends)

Ordered by expected value:

1. **Speed for big repos.** Cache the parsed history in `.git/repo-archaeology/cache.json`, keyed by HEAD and settings, and update incrementally from the last cached commit.
2. **PR integration.** A GitHub Action that runs `diff --base origin/<base> --json` and posts one comment, updated in place, never duplicated. Only ghost wires and import links above the thresholds; "historical signal" wording; no failing checks by default.
3. **`file` in the editor.** A small VS Code extension that shows "usually changes with…" for the open file, using `file --json`.
4. **More languages.** Python and Go import extraction (both are line-based enough for a careful parser), so ghost wires work beyond JS/TS.

### Phase 4: the delight layer (any time after Phase 2)

**Replay mode.** `map --replay`: animate the repository's history on the map; files light up as they change, ghost wires pulse when both ends move in the same commit, and optionally drive generative audio from the same events. This is where Commit Symphony lives: a demo and marketing feature, not the core.

## Known limitations and backlog

| Item | Why it matters | Idea |
| --- | --- | --- |
| `typescript` is a runtime dependency (~20 MB) | Slower first `npx` run | Swap to `es-module-lexer` + `cjs-module-lexer` or a native parser; keep TypeScript only for tsconfig parsing |
| TypeScript 7 (native) may change the JS API | Breaks import extraction | Dependency is pinned to `^5.4 \|\| ^6`; add a test against each major |
| Import checks are JS/TS only | Other repos see mostly "unchecked" | Phase 3, item 4 |
| Merge commits are skipped | Merge-heavy workflows lose some signal | Optional `--first-parent` mode that diffs each merge against its first parent |
| Hub files (e.g. a central `types.ts`) | Appear in many suggestions | Penalize by base rate (lift) if backtests show it helps |
| One unresolved alias makes a file "unchecked" | Fewer ghost wires in alias-heavy code | Read Vite/webpack alias config |
| Windows not tested | Paths, `explorer.exe` opening | Add a Windows CI job |
| Very large monorepos (100k+ commits) | Memory for pair maps | Typed-array adjacency, `--since` default for huge repos |

## Review log (5 passes on the scaffold)

1. **Git parsing on real repositories** (hono, commander.js, vite). Cross-checked commit counts against `git rev-list` and per-file counts against `git log`. Found: imports of a repo's own package (`hono/utils`) were treated as external, creating false ghost wires → resolve local packages through `exports` maps and `dist`→`src`. Exact tsconfig `paths` patterns were sorted after wildcards → fixed.
2. **Statistics.** Found: the backtest's test set changed when `--max-files` changed, so filters could game the score → fixed test set (held-out commits ≤ 25 files, regardless of settings). Comparing hit rates against a baseline that always speaks up was unfair → added "popularity, same changes". `scan` could report a direction below the threshold → only passing directions are reported. Tuned on 3 repos: half-life and `--skip-commits` gave no consistent gain, so both stay opt-in.
3. **Output and UX.** Found: tests and `package.json` dominated ghost wires → tests are "test links", project config is "unchecked", and unchecked results only fill in around ghost wires in `scan`. Map: isolated dots, invisible labels, lines bloating on zoom → only active files drawn, selection zooms to the neighbourhood, constant-width lines, ghost-wire pairs listed with both files. Help text tidied.
4. **Security and robustness.** Found: map written to a predictable shared temp path → now `.git/repo-archaeology/map.html`. Shared maps contained the absolute local path → stripped. Windows browser opening went through `cmd` → now no shell anywhere. HTML embedding escaped against `</script>` in commit subjects (tested). `| head` crashed with EPIPE → handled. Refs starting with `-` rejected before reaching git.
5. **Packaging and fresh-eyes read.** Packed the tarball, installed it into an empty folder, ran the bin. Found: stale files could ship from `dist/` → build cleans first. 39.5% printed as "40%" next to a 40% threshold → percentages round down. `./foo` resolved to `foo.d.ts` before `foo.js` → implementation files first. Paths named `..something` were treated as outside the repo → fixed.

### External review (after the five passes)

An independent review rated v0.1 7/10 and found six medium-priority correctness issues. All six were confirmed, fixed, and covered by regression tests that fail on the old code and pass on the new:

1. **A deleted file's history leaked into a new, unrelated file at the same path.** Files now have lifetimes: a file created at a path starts fresh, and the old one keeps its own (hidden) identity. A related bug surfaced while testing: renaming `old.ts` and adding a new `old.ts` in the same commit merged the two.
2. **`--half-life` overstated evidence.** Ranking now uses the effective sample size (Kish), so 3 recent commits plus 1,000 nearly weightless old ones count as about 3. Weighted percentages are labelled "recency-weighted".
3. **Barrel files with unresolved imports produced false ghost wires.** Any unresolved import along the followed path now makes the pair "unchecked". On vite this moved ghost wires from 107 to 50: fewer, more trustworthy.
4. **`diff --kinds ghost` could drop a valid ghost wire** when a stronger import link pointed at the same file. Relationships are now filtered by kind before the strongest is chosen.
5. **`#` subpath aliases were stripped as URL fragments** and never resolved.
6. **Files deleted from disk but not staged still counted as existing.**

Also added: a GitHub Actions workflow (Linux and macOS on Node 20/22/24, Windows on Node 22/24).
