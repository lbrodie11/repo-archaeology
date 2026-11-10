# Map Hallway Test Protocol (`--style classic` vs `--style rich`)

This protocol evaluates whether the opt-in FRAME/12 Investigation Board + Contact-Sheet Atlas (`repo-archaeology map --style rich`, featuring the default **Briefing** Investigation Board and the **Atlas** Contact Sheet toggle) improves comprehension, speed, and calibration of historical uncertainty compared with the default global force-directed graph (`repo-archaeology map --style classic`) before considering changing the default style.

## Participants & Setup

- **Participants:** 3–5 software engineers unfamiliar with the target repository's co-change history.
- **Design:** Within-subject counterbalanced comparison (half start with `classic`, half start with `rich` on two comparable repositories such as `honojs/hono` and `colinhacks/zod`) or between-subject comparison on `honojs/hono`.
- **Preparation:**
  ```bash
  repo-archaeology map --style classic --no-open --out map-classic.html
  repo-archaeology map --style rich --no-open --out map-rich.html
  ```
- **Environment:** Offline browser window at `1440×900` (desktop) and `360×640` (mobile viewport check). No coaching on what "ghost wire", "cut frame", or "95% CI" mean prior to the tasks.

---

## 5-Task Protocol

### Task 1 · Priority & First Investigation Target
- **Neutral prompt (comprehension & decision quality):**
  > *"Which historically related file pair would you investigate first, and what evidence supports that choice?"*
- **Direct lookup prompt (visual scanning speed):**
  > *"Find the highest-priority ghost wire and name both files."*
- **Target observation:** Does the participant identify the top-ranked cross-folder ghost wire (in `C-01` under `--style rich`) and cite its directional co-change counts rather than treating the visual link as a guaranteed compile-time dependency?

### Task 2 · Directional Counts & Confidence Interval
- **Prompt:**
  > *"Report the shared commit count, directional denominator (which file's total commits form the denominator), and 95% confidence interval for that relationship."*
- **Target observation:** Can the participant state both directions (e.g. `A → B` vs `B → A`) and read the raw two-sided 95% Wilson confidence interval?

### Task 3 · Calibrating Weak Historical Evidence
- **Prompt:**
  > *"Say whether any ghost wire on the map represents weak evidence (`< 30%` 95% CI lower bound), and explain how you can tell."*
- **Target observation:** Does the participant notice thinner line width (scaled by `interval.low`) and the explicit `weak` badge/caption marker on low-lower-bound relationships, and do they recognize that `2 of 2 commits (100%)` is weaker evidence than `9 of 10 commits (90%)`?

### Task 4 · Actionable Local Verification (`explain`)
- **Prompt:**
  > *"Copy the CLI `explain` command for that pair so you could inspect the bounded commit diffs locally."*
- **Target observation:** Time and clicks required to locate and copy `npx repo-archaeology explain <fileA> <fileB>`.

### Task 5 · Theme Switching & Focus Clarity
- **Prompt:**
  > *"Switch the map to dark mode (and light mode) and confirm whether the active finding and its relationship kind remain clear."*
- **Target observation:** Can the participant toggle `Theme: System / Light / Dark`, identify the single gold marker chip (`--f-marker` background with `--f-marker-ink` text), and distinguish relationship kinds by line pattern without relying on color alone?

---

## Evaluation Metrics & Acceptance Criteria

Record the following for each participant and task:

| Metric | Target for promoting `--style rich` |
| :--- | :--- |
| **Median task time (Tasks 1–5)** | Equal to or faster than `--style classic`, with Task 1 & Task 3 at least 25% faster. |
| **Error rate** | `0` misidentifications of the denominator file or relationship type (`ghost` vs `direct` / `indirect` / `test`). |
| **Evidence comprehension** | Participant correctly explains that `X of Y commits (in fileA)` means `X` shared changes out of `Y` total analyzed changes to `fileA`. |
| **Uncertainty identification** | Participant correctly identifies `weak` findings (`interval.low < 0.30`) and treats ghost wires as historical evidence to investigate rather than proof of a bug. |
| **Marker grammar & accessibility** | Participant confirms the single active finding is unambiguous in both light and dark themes and at `360×640` mobile viewport width. |

---

## Plate Layout A/B: Pair-Centered Rows vs the v0.6.0 Arc

The Briefing blueprint plate (`C-01`) changed from an arc around the selected pair (v0.6.0) to pair-centered rows with curved wires (`src/map/plate-layout.ts`). Geometry is verified automatically (no overlapping, clipped or misplaced labels; no wire through an unrelated file; identical server and browser layouts), but **whether readers understand the plate faster is a human question**. Run this short A/B before claiming the new layout is better.

- **Participants:** 5 engineers who have not seen either layout. Counterbalance: odd participants start with A, even with B.
- **Builds:** generate both reports from the same repository and commit (for example a local clone of `shadcn-ui/ui`):
  ```bash
  npx repo-archaeology@0.6.0 map --style rich --no-open --out plate-A-arc.html
  npx repo-archaeology map --style rich --no-open --out plate-B-rows.html
  ```
- **Viewports:** 1440×900, then 390×844 for task P5. Do not explain the layout; the plate footer and Field Guide are the only help.

### Tasks (time each, record the answer)
- **P1 · Name the pair:** *"Which two files is this plate about?"* Correct: the lead pair.
- **P2 · Find a both-sided file:** *"Name one file related to both of those files."* Correct: any file with wires to both.
- **P3 · Find a one-sided file:** *"Name a file related to only one of them, and say which."* Correct: file and side both right.
- **P4 · Trace a file:** *"Pick any file and tell me every file it is connected to on the plate."* Allow hover. Correct: complete and with no extras.
- **P5 · Phone:** at 390px, *"Open a related file that is not drawn on the plate."* Correct: uses the list under the plate (B) or finds it another way (A).

### Record and decide

| Metric | Promote B when |
| :--- | :--- |
| Median time, P2–P4 | B at least 20% faster than A |
| Errors, P2–P4 | B has no more errors than A, and no participant reads row position as relationship strength |
| P4 completeness | B ≥ 4/5 participants list every connection with no extras |
| P5 success | B 5/5 |
| Unprompted confusion notes | Fewer for B (for example "why are some wires curved?", "what does this row mean?") |

If B fails P2 or P3, revisit the plate key wording before the geometry. If P4 fails, check whether participants noticed the footer hint ("Point at a file to trace its wires") and the highlight it triggers.

---

## Atlas Overview Check (3–5 people)

The Atlas overview changed from drawing every file of every group to level-of-detail rendering (folder groups for dense frames, explained empty frames, constant-size captions). The browser tests verify that nothing is blank, mislabeled or unreachable; they cannot verify that people find things faster. Run this with 3–5 developers who have not used Repo Archaeology, on a repository with at least one 25+ file group (for example a local clone of `shadcn-ui/ui`), comparing `repo-archaeology@0.7.0` (A) with the current build (B).

### Tasks (time each, record the answer and the number of clicks)
- **A1 · Largest group:** *"Which group of related files is the largest, and roughly what areas of the code does it span?"* Correct: the right frame and at least two of its folders.
- **A2 · Find a file:** *"Find `<a file inside the large group>` and tell me one file it changes with."* Correct: file located (search or zoom) and a real neighbour named.
- **A3 · Inspect a ghost wire:** *"Open a ghost-wire relationship and tell me which frame it belongs to and how often the two files changed together."* Correct: frame id matches the inspector's `Inspecting C-xx` line, counts read correctly.
- **A4 · Explain an empty frame:** *"Why does frame `<an unchecked-only frame>` show no relationships, and how would you see them?"* Correct: names the filter and shows them.
- **A5 · Back to the overview:** *"Get back to seeing every group."* Correct: `Reset view` (or equivalent) without reloading.

### Decide

| Metric | Keep B when |
| :--- | :--- |
| Task success (A1–A5) | B is at least as high as A on every task, and A4 is 100% |
| Median time, A1 and A2 | B is at least 20% faster |
| Interpretation errors | No participant reads a folder group as a single file, or group position as importance |
| Clicks to complete A3 | B needs no more than A |

If people misread folder groups as files, strengthen the double-ring marker or the "Grouped by folder" note before changing the thresholds.
