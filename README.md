# G8 Gauge Theme Builder (in-browser)

Let people pick their own colors for the Garmin G8 / Android cluster theme, build the
signed RRO overlay APKs **entirely in the browser**, and install them to a rooted
Android 10 device over **WebUSB** — no server, no app to install, no apktool / Java /
Python at runtime. It's a static site (hostable on GitHub Pages).

Supports multiple **theme bases** (Yamaha, Arctic Cat); each is a complete overlay set
the user recolors. Switching base is a full swap (all overlays).

## How it works (runtime — browser only)

The build **never recompiles resources** — that's what would need apktool/Java. Instead
it byte-patches prebuilt templates:

1. Loads a prebuilt template APK (`docs/templates/<base>/<overlay>.apk`).
2. Recolors it using `docs/offsets.json`:
   - **`patch.js`** — overwrite 4-byte ARGB ints at known offsets in `resources.arsc` /
     compiled `*.xml` (alpha preserved).
   - **`json-recolor.js`** — recolor the Lottie gauges: solid fills by value, and the
     **bar gradients structurally** (single = hue-shift the shade gradient to one color;
     custom = a 2-color start→end gradient with a fade/transition slider).
   - **`png-tint.js`** — canvas recolor of the cluster logo (PNG bases) and the
     background sphere (black stays black), and fit an uploaded background image.
   - **`resign.js`** — re-sign with a **v1 (JAR) signature** in pure JS.
3. **`adb.js`** — install over WebUSB, fully autodetected: `pm path <package>` finds each
   overlay's exact on-device APK, `/proc/mounts` finds the block device; then remount `/`
   rw → `cp` into `/product/overlay/…` → chmod → remount ro → reboot.

All dependencies are **vendored** in `docs/vendor/` (jszip, node-forge, lottie-web, the
ya-webadb bundle, the Russo One font), so the site makes no external requests. The USB
**install needs desktop Chrome/Edge** (WebUSB); other browsers can still build + download
the APKs.

A **live preview** (`preview.js`) renders the real assets recolored by the same passes as
the build, laid out from the cluster's actual ConstraintLayouts (geometry extracted from
the base app; screen 1280×800 @240dpi, with the status/nav bar insets). Numbers
(RPM/temp/fuel/odo) are placeholders; layout approximates the device.

The signing key (`docs/signing/`) is **public by design**: the device is rooted, so the
signature only needs to be a *valid* v1 signature, not match a platform key.

## Theme bases

Declared in `BASES` at the top of `tools/gen_templates.py`. A base = source overlay dirs,
base colors, and a few structural flags (`logo_kind` png/vector, `rebuild`, `inject_susp`,
`inject_gauges`). Current bases:

- **Yamaha** — blue; cluster logo is a PNG (canvas tint).
- **Arctic Cat** — green; cluster logo is a vector (int-patch); suspension icons are
  injected from the base GarminCar app (they live in the base, not the overlay).

Both target the **same overlay packages** (so the deploy slots are identical), and both
embed the **same canonical gradient gauge animations** (recolored per base at runtime).

## Controls (per base)

| Control | What it recolors |
|---|---|
| **Main color** | gauge markings + odometer accent |
| **Active bar** | the moving gauge bar — *single* (shades of one color) or *custom 2-color* gradient + fade |
| **Gauge line outline** | the static track line of the gauge (`#999`, JSON + drawables) |
| **System bar icons (gear, suspension)** | nav-bar vehicle-slot icons (`ic_gear_*`, `ic_susp_*`) |
| **Background color** | the cluster background sphere (black stays black) |
| **Logo color** | SystemUI nav logo + cluster logo |
| **Background image** (upload) | replaces the cluster background |

Warning colors (coolant hot/cold, low fuel) live in the **base app**, not the overlays, so
they stay blue/amber/red regardless of the chosen theme.

## Dev setup

```bash
npm install
npm run gen-key          # once: create the public signing key in docs/signing/
npm run gen-templates    # build BOTH bases -> docs/templates/<base>/, offsets.json, preview/
npm run serve            # http://localhost:8080  (no-cache dev server)
```

`gen-templates` runs **apktool** (needs the Android Studio JBR — path at the top of
`tools/gen_templates.py`): it injects the suspension icons + canonical gauges and
recompiles each base. Useful flags:

```bash
npm run gen-templates -- --base arcticcat   # one base only
npm run gen-templates -- --report           # print findings, write nothing
```

Vendored browser deps (rebuild after upgrading versions):

```bash
npm run bundle-adb   # ya-webadb stack -> docs/vendor/yawebadb.js (one shared stream-extra)
# jszip / node-forge / lottie-web: esbuild the tools/vendor-*.mjs entries
```

## Adding or changing a base

Add an entry to `BASES` (`label`, `colors`, `logo_kind`, `rebuild`, `inject_susp`,
`inject_gauges`, `dirs`). `build_scopes()` derives the recolor scopes from the colors +
flags — the recolor *structure* is shared, only the source/colors differ. Re-run
`gen-templates`. (Canonical gauges come from `CANONICAL_GAUGE_DIR`; device geometry/density
constants are `SCREEN_*`, `STATUS_BAR_PCT`, `NAV_BAR_PCT`.)

## Validation (no browser)

```bash
node tools/test_build.mjs [base] [overlay]   # full patch+recolor+sign of one overlay
node tools/make_test_apk.mjs                 # sign one overlay; prints adb deploy commands
```

Verify the output with the Android SDK:

```bash
java -jar <SDK>/build-tools/<ver>/lib/apksigner.jar verify --verbose dist-test/*.apk
java -jar apktool_3.0.1.jar d dist-test/<file>.apk -o dist-test/decomp -f
```

## Deploy to GitHub Pages

Commit everything under `docs/` (incl. `templates/`, `offsets.json`, `preview/`,
`vendor/`, `signing/`, `.nojekyll`) and set **Settings → Pages → Source: `main` / `/docs`**.
WebUSB needs HTTPS, which `github.io` provides. Only `docs/` is served — the rest of the
repo is dev tooling. `node_modules/`, `dist-test/`, and `*/build/` are gitignored.

**`docs/` is fully self-contained**: a browser fetching that folder does the entire
recolor → sign → install flow. You only need the dev toolchain (apktool/Java/`tools/`) to
*regenerate or extend* the base templates, not for per-user theming.
