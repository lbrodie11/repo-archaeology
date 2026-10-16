# Repo Archaeology

Dig through your git history to find **ghost wires**: files that keep changing together even though neither one imports the other.

The source tree tells you what imports what. History tells you what actually moves together. When those disagree, there is usually something worth knowing: two adapters that must be kept in sync, a type file and the docs page that describes it, a config that mirrors a schema. Repo Archaeology finds those links, shows you the commits that prove them, and warns you when you change one side and forget the other.

It runs locally against `.git`. No account, no upload, no server.

```text
$ npx repo-archaeology diff

You changed 1 file.

Possibly missed (2)

  src/adapter/deno/serve-static.ts  ghost wire
    changed with src/adapter/bun/serve-static.ts in 12 of 19 commits (63%) · last together 5 months ago
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
| `repo-archaeology` or `scan` | Which files in this repo are secretly coupled? |
| `diff [--base main]` | I changed these files. What usually changes with them that I haven't touched? |
| `file <path>` | What does history know about this file: churn, owners, companions? |
| `map` | Show me the whole picture as an interactive map in the browser. |
| `backtest` | How often would these suggestions have been right on recent history? |

Every command accepts `--json`.

### `diff`

Looks at staged, unstaged and untracked changes (renames included). With `--base main`, it also includes the commits on your branch since it forked from `main`, so it works as a pre-PR check.

```bash
npx repo-archaeology diff --base main
npx repo-archaeology diff --exit-code   # exit 1 when something looks missed (for hooks/CI)
```

### `map`

Writes a single self-contained HTML file (no network requests, works offline) and opens it. Files are dots sized by churn and coloured by folder; ghost wires are pink dashed lines. Click a file to see what moves with it and the commits behind each link. By default the map is written to `.git/repo-archaeology/map.html`, which is never committed. Use `--out` to put it elsewhere. The map includes file paths, author names and commit subjects, so treat it like the repository itself when sharing.

### `backtest`

Learns from older commits only, then replays newer ones one changed file at a time and checks whether the suggestions were among the files that really changed. It compares against a "guess the most popular files" baseline scored on the same changes.

```text
strategy                   speaks up   hit@3   precision   false alarms   recall
co-change                        65%     64%         37%            36%      13%
popularity, same changes         65%     13%          5%            87%       3%
```

Use it to choose thresholds for your repo. To avoid fooling yourself, tune with `--before <date>` (an older window) and look at the final score once without it.

## How to read the results

Every relationship has a kind:

| Kind | Meaning |
| --- | --- |
| **ghost wire** | Neither file imports the other (checked), yet they change together. The interesting one. |
| **import link** | One imports the other, directly or through an index/barrel file. Expected. |
| **test link** | A test changing with code, or tests changing together. Expected. |
| **unchecked** | We could not check imports: non-JS/TS files, project config such as `package.json`, or unresolvable aliases. |

**Confidence is directional.** "When `a.ts` changed, `b.ts` changed too in 9 of 12 commits (75%)" says nothing about how often `a.ts` changes when `b.ts` does; that number is shown as *reverse*.

**Results are ranked by evidence**, not just by percentage: 3 out of 3 ranks below 40 out of 50 (Wilson score lower bound).

**It is a historical signal, not proof.** Two files changing together in the past does not mean your change needs both.

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
  "skipCommits": "^chore\\(deps\\)"
}
```

## How it works

1. **History.** Streams `git log --no-merges -M --name-status -z` (NUL-delimited, so any file name is safe). Renames are followed, so a file keeps its history when it moves. A path later reused for a different file is not confused with the original.
2. **Noise.** Lockfiles, build output, snapshots and changelogs are ignored. Commits touching more than 25 files are treated as sweeps and skipped. Single-file commits are kept, because leaving them out would inflate every confidence number.
3. **Statistics.** For files A and B: `confidence(A→B) = shared(A, B) / changes(A)`, ranked by the Wilson lower bound.
4. **Imports.** JS/TS files are parsed with TypeScript's pre-processor (comments and strings are handled correctly), and imports are resolved like TypeScript does: relative paths, `.js`→`.ts`, index files, `tsconfig`/`jsconfig` `paths` and `baseUrl` (with `extends`), and imports of the repository's own packages, including monorepo workspaces and `exports` maps. Only the current code is analyzed.

Known limits: import checks cover JS/TS only. Merge commits are skipped, so squash-merge and rebase workflows give the cleanest signal. Shallow clones only see part of the history; the tool warns about this.

## Development

```bash
npm install
npm test            # node:test, with fixture git repositories
npm run dev -- scan -C ../some-repo
npm run build && node dist/cli.js --help
```

Requires Node 20+ and git 2.24+.

## License

MIT
