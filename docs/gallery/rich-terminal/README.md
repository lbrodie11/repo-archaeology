# `--style rich` before and after (RA-21)

honojs/hono at `61f7c59` (`--head 61f7c59e50244ab4d2dd83c151928cf7ea448510`), `scan` and `diff --base 61f7c59~6`, rendered with
truecolor forced (`FORCE_COLOR=3`) at 40, 80 and 120 columns, parsed by `@xterm/headless` and shown in a
light and a dark terminal theme. "Before" is the RA-13 renderer on `main`; "after" is `@frame12/terminal`.
Regenerate with `node scripts/rich-gallery.mjs --hono <clone> --before <main checkout>/dist/cli.js`.
The raw ANSI is in [`ansi/`](ansi/).

## `scan`

### 40 columns

| Before (RA-13 renderer) | After (`@frame12/terminal`) |
| --- | --- |
| ![before, light](png/scan-40-before-light.png) | ![after, light](png/scan-40-after-light.png) |
| ![before, dark](png/scan-40-before-dark.png) | ![after, dark](png/scan-40-after-dark.png) |

### 80 columns

| Before (RA-13 renderer) | After (`@frame12/terminal`) |
| --- | --- |
| ![before, light](png/scan-80-before-light.png) | ![after, light](png/scan-80-after-light.png) |
| ![before, dark](png/scan-80-before-dark.png) | ![after, dark](png/scan-80-after-dark.png) |

### 120 columns

| Before (RA-13 renderer) | After (`@frame12/terminal`) |
| --- | --- |
| ![before, light](png/scan-120-before-light.png) | ![after, light](png/scan-120-after-light.png) |
| ![before, dark](png/scan-120-before-dark.png) | ![after, dark](png/scan-120-after-dark.png) |

## `diff`

### 40 columns

| Before (RA-13 renderer) | After (`@frame12/terminal`) |
| --- | --- |
| ![before, light](png/diff-40-before-light.png) | ![after, light](png/diff-40-after-light.png) |
| ![before, dark](png/diff-40-before-dark.png) | ![after, dark](png/diff-40-after-dark.png) |

### 80 columns

| Before (RA-13 renderer) | After (`@frame12/terminal`) |
| --- | --- |
| ![before, light](png/diff-80-before-light.png) | ![after, light](png/diff-80-after-light.png) |
| ![before, dark](png/diff-80-before-dark.png) | ![after, dark](png/diff-80-after-dark.png) |

### 120 columns

| Before (RA-13 renderer) | After (`@frame12/terminal`) |
| --- | --- |
| ![before, light](png/diff-120-before-light.png) | ![after, light](png/diff-120-after-light.png) |
| ![before, dark](png/diff-120-before-dark.png) | ![after, dark](png/diff-120-after-dark.png) |
