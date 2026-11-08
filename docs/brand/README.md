# Repo Archaeology Brand Assets

Canonical brand marks and social preview cards for **Repo Archaeology** (`lbrodie11/repo-archaeology` / `repo-archaeology`).

## Mark Concept — *The Stratigraphic Cut & Ghost Wire*

The Repo Archaeology mark is built on a `32×32` grid with a `2`-unit `#121212` outer frame (`<rect x="1" y="1" width="30" height="30" fill="#121212" stroke="#121212" stroke-width="2"/>`, sitting completely inside the `0..32` viewBox), three slanted `#ffffff` sedimentary strata separated by wide `3.75`-unit `#121212` channels, and a vertical `#ffd60a` ghost-wire core sample:

- **Top stratum (`#ffffff`):** `4,4 → 28,4 → 28,8.5 → 4,11.5`.
- **Middle stratum (`#ffffff`):** `4,15.25 → 28,12.25 → 28,17.25 → 4,20.25`.
- **Bottom stratum (`#ffffff`):** `4,24 → 28,21 → 28,28 → 4,28`.
- **Ghost-wire core sample (`#ffd60a`):** Vertical `4.5`-unit shaft (`x=19..23.5, y=6..26`) piercing the two dark channels between the top and bottom strata while passing *behind* the untouched middle stratum (rendered before the middle stratum polygon so the middle `#ffffff` stratum occludes it).

## Palette Tokens

| Token | Light Hex | Dark Hex | Role |
|---|---|---|---|
| Ink / Ground | `#121212` | `#121212` | Outer frame fill, stratigraphic channels, primary typography |
| Paper Strata | `#ffffff` | `#ffffff` | Sedimentary commit strata and card sheet surface |
| Dark-Mode Frame Border | `#121212` | `#f1f0ea` | Outer `2`-unit border stroke for visibility on dark surfaces (`#0d1117`) |
| Ghost-Wire Gold | `#ffd60a` | `#ffd60a` | Primary accent and vertical ghost-wire core sample |

## Asset Inventory

| File | Dimensions | Variant & Usage |
|---|---|---|
| [`icon.svg`](icon.svg) | Vector (`32×32` viewBox) | Light-mode header mark (`README.md`) & SVG favicon (`<link rel="icon" type="image/svg+xml">`) |
| [`icon-dark.svg`](icon-dark.svg) | Vector (`32×32` viewBox) | Dark-mode header mark (`README.md` `<picture>` `prefers-color-scheme: dark`) |
| [`icon-16.png`](icon-16.png) | `16×16` PNG | Hand-tuned pixel-grid favicon (`shape-rendering="crispEdges"`, whole-pixel horizontal strata without subpixel blur) |
| [`icon-32.png`](icon-32.png) | `32×32` PNG | Hand-tuned `32×32` pixel-grid retina favicon (`shape-rendering="crispEdges"`, whole-pixel horizontal strata without staircase blur) |
| [`icon-128.png`](icon-128.png) | `128×128` PNG | Framed VS Code Marketplace extension icon |
| [`icon-180.png`](icon-180.png) | `180×180` PNG | Padded, frameless safe-zone variant for iOS / macOS `apple-touch-icon.png` (resists rounded-corner clipping) |
| [`icon-512.png`](icon-512.png) | `512×512` PNG | Padded, frameless safe-zone variant for GitHub App / OAuth / organization avatars (fits inside a circular mask) |
| [`social-preview.png`](social-preview.png) | `1280×640` PNG | GitHub repository social preview (`Settings → General → Social preview`) & OpenGraph card |

## Regenerating Assets

All vector marks, raster exports, and the `1280×640` social card are generated from [`scripts/generate-brand-assets.ts`](../../scripts/generate-brand-assets.ts):

```bash
node --experimental-strip-types scripts/generate-brand-assets.ts
```

## GitHub Actions Marketplace Branding

GitHub Actions Marketplace restricts `action.yml` `branding.icon` to a fixed allowlist of Feather v4.28.0 icons (custom SVGs are not supported). [`action.yml`](../../action.yml) uses:

```yaml
branding:
  icon: 'layers'
  color: 'purple'
```
