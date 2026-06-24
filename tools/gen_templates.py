#!/usr/bin/env python3
"""
gen_templates.py  —  Build the in-browser tool's templates + color offset manifest.

The web tool never recompiles resources. Instead this script (run on a dev machine,
when the BASE theme changes) produces, for each overlay:

  * docs/templates/<overlay>.apk   — an UNSIGNED APK at BASE colors. The browser
                                     patches color bytes in-place, then v1-signs it.
  * docs/offsets.json              — exactly where each logical color lives, so the
                                     browser writes 4 bytes at known offsets with no
                                     parsing and no collision risk.

Source of the compiled bytes: each overlay's existing build/apk/ directory, which
already holds apktool's output (resources.arsc + compiled binary XML). So by default
NO Java/apktool is needed here. Pass --rebuild to re-run apktool from source first
(requires the Android Studio JBR; auto-detected).

Usage:
    python tools/gen_templates.py            # zip build/apk dirs + extract offsets
    python tools/gen_templates.py --rebuild  # apktool b from source first
    python tools/gen_templates.py --report   # print findings, write nothing
"""

import argparse
import json
import re
import struct
import zipfile
import subprocess
from fnmatch import fnmatch
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
APKTOOL = ROOT / "apktool_3.0.1.jar"
JAVA = Path(r"C:/Program Files/Android/Android Studio/jbr/bin/java.exe")

# ── Logical controls (labels shown in the UI) ────────────────────────────────
CONTROL_LABELS = {
    "primary": "Main color",
    "active_bar": "Active bar",
    "track": "Gauge line outline",
    "background": "Background color",
    "logo": "Logo color",
    "susp": "System bar icons (gear, suspension)",
    "bg_image": "Background image",
}

# Canonical gauge animations (Arctic Cat's — they have the leading-edge gradient
# active bar). BOTH bases embed these; the offset manifest stores their colors as
# the per-entry "from" values, so the browser recolors green->whatever per base.
CANONICAL_GAUGE_DIR = "arcticCatGreen/VehicleClusterArcticCatSnow"
GAUGE_PRIMARY = "#66bc29"   # solid bar/markings color in the canonical gauges
GAUGE_ACTIVE = "#c8f6ac"    # gradient "active bar" leading-edge color

# ── Theme bases ──────────────────────────────────────────────────────────────
# Each base is a complete theme variant. The recolor structure is shared (same
# underlying app); a base varies only by source location, base colors, and a few
# structural flags. Add a new variant by adding an entry here.
#   colors      : the BASE ("from") color of each control the base supports. Omit
#                 a control (e.g. active_bar) if the base has no clean target.
#   logo_kind   : "png"    -> cluster_center_logo.png recolored by canvas tint
#                 "vector" -> cluster_center_logo.xml recolored by int-patch
#   rebuild     : run apktool b (source dir has no build/apk yet)
#   inject_susp : copy the base app's suspension icons into the GarminCar overlay
#                 (they live in the base app, not the overlay) so they're editable
BASES = {
    "yamaha": {
        "label": "Yamaha",
        "colors": {"primary": "#0066cc", "active_bar": "#0066cc", "track": "#999999",
                   "background": "#0a1633", "logo": "#0066cc", "susp": "#0066cc"},
        "logo_kind": "png",
        "rebuild": True,          # gauges are swapped in -> must recompile
        "inject_susp": False,
        "inject_gauges": True,    # adopt the canonical gradient gauges
        "dirs": {
            "SystemUI": "AndroidSystemUiYamahaBlueOverlay",
            "GarminCar": "GarminCarYamahaBlueSnowOverlay",
            "VehicleCluster": "VehicleClusterYamahaBlueSnowOverlay",
        },
    },
    "arcticcat": {
        "label": "Arctic Cat",
        "colors": {"primary": "#66bc29", "active_bar": "#66bc29", "track": "#999999",
                   "background": "#132308", "logo": "#66bc29", "susp": "#66bc29"},
        "logo_kind": "vector",
        "rebuild": True,
        "inject_susp": True,
        "inject_gauges": False,   # already the canonical gauges
        "dirs": {
            "SystemUI": "arcticCatGreen/AndroidSystemUiArcticCat",
            "GarminCar": "arcticCatGreen/GarminCarArcticCatSnow",
            "VehicleCluster": "arcticCatGreen/VehicleClusterArcticCatSnow",
        },
    },
}

OVERLAY_KEYS = ["SystemUI", "GarminCar", "VehicleCluster"]

# Base app providing suspension icons an overlay must override (for inject_susp).
SUSP_BASE_DIR = "garminCarBase/GarminCarService"
SUSP_NAMES = [
    "ic_susp_driver1_disabled", "ic_susp_driver1_enabled",
    "ic_susp_driver2_disabled", "ic_susp_driver2_enabled",
    "ic_susp_firm_disabled", "ic_susp_firm_enabled", "ic_susp_lock",
    "ic_susp_medium_disabled", "ic_susp_medium_enabled",
    "ic_susp_soft_disabled", "ic_susp_soft_enabled", "ic_susp_unlock",
]

# Entries stored uncompressed in real APKs (apktool doNotCompress).
STORED_SUFFIXES = (".png",)
STORED_NAMES = ("resources.arsc",)


def hex_argb(h):
    """'#rrggbb' -> 0xffRRGGBB (opaque), as stored compiled in arsc/AXML."""
    return 0xFF000000 | int(h.lstrip("#"), 16)


def hex_rgb(h):
    h = h.lstrip("#")
    return [int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)]


def build_scopes(base, key):
    """Derive one overlay's recolor scopes from the base's colors + flags."""
    c = base["colors"]
    s = {"int_scopes": [], "json_scopes": [], "png_tint": [], "png_replace": []}
    if key == "SystemUI":
        s["int_scopes"].append({"control": "logo",
            "glob": "res/drawable/ic_sysbar_cluster.xml", "argb": hex_argb(c["logo"])})
    elif key == "GarminCar":
        # gears + suspension are both nav-bar (system bar) icons -> one control
        if "susp" in c:
            s["int_scopes"].append({"control": "susp",
                "glob": "res/drawable/ic_gear_*.xml", "argb": hex_argb(c["susp"])})
            s["int_scopes"].append({"control": "susp",
                "glob": "res/drawable/ic_susp_*.xml", "argb": hex_argb(c["susp"])})
    elif key == "VehicleCluster":
        s["int_scopes"] += [
            {"control": "primary", "glob": "resources.arsc", "argb": hex_argb(c["primary"])},
            {"control": "background", "glob": "resources.arsc", "argb": hex_argb(c["background"])},
            # gauge graphics (textron_*, tex_gauge_*) — the 'tex' prefix excludes
            # the vector logo (cluster_center_logo.xml), recolored separately below
            {"control": "primary", "glob": "res/drawable/tex*.xml", "argb": hex_argb(c["primary"])},
            # static track / inactive bar (gray #999) in those same drawables
            {"control": "track", "glob": "res/drawable/tex*.xml", "argb": 0xFF999999},
        ]
        # gauges are the CANONICAL animations in every base, so their JSON colors
        # are always the canonical green/gradient (not the base's int colors).
        s["json_scopes"].append({"control": "primary",
            "glob": "res/raw/*.json", "rgb": hex_rgb(GAUGE_PRIMARY)})
        s["json_scopes"].append({"control": "active_bar",   # gradient marker (barSpec)
            "glob": "res/raw/*.json", "rgb": hex_rgb(GAUGE_ACTIVE)})
        s["json_scopes"].append({"control": "track",        # static track (gray)
            "glob": "res/raw/*.json", "rgb": [153, 153, 153]})
        s["png_tint"].append({"control": "background", "glob": "res/drawable-nodpi/tex_bg.png"})
        s["png_replace"].append({"control": "bg_image",
            "glob": "res/drawable-nodpi/tex_bg.png", "w": SCREEN_W, "h": SCREEN_H})
        if base["logo_kind"] == "vector":
            s["int_scopes"].append({"control": "logo",
                "glob": "res/drawable/cluster_center_logo.xml", "argb": hex_argb(c["logo"])})
        else:  # png — canvas tint
            s["png_tint"].insert(0, {"control": "logo",
                "glob": "res/drawable/cluster_center_logo.png"})
    return s


def argb_le(value: int) -> bytes:
    """ARGB int -> 4 little-endian bytes as stored in compiled resources."""
    return struct.pack("<I", value & 0xFFFFFFFF)


def find_int_offsets(data: bytes, argb: int) -> list[int]:
    """All byte offsets where the 4-byte LE ARGB pattern occurs in `data`."""
    needle = argb_le(argb)
    offsets, start = [], 0
    while (i := data.find(needle, start)) != -1:
        offsets.append(i)
        start = i + 1
    return offsets


def count_json_triples(text: str, rgb: list[int]) -> int:
    """Count Lottie colors (solid fills/strokes AND gradient stops) matching rgb."""
    try:
        doc = json.loads(text)
    except Exception:
        return 0
    n = 0
    hit = lambda r, g, b: (round(r * 255), round(g * 255), round(b * 255)) == tuple(rgb)

    def walk(o):
        nonlocal n
        if isinstance(o, dict):
            c = o.get("c")
            if isinstance(c, dict) and isinstance(c.get("k"), list) and c["k"]:
                k = c["k"]
                if isinstance(k[0], (int, float)) and len(k) >= 3:
                    if hit(k[0], k[1], k[2]):
                        n += 1
                else:
                    for kf in k:
                        s = kf.get("s") if isinstance(kf, dict) else None
                        if isinstance(s, list) and len(s) >= 3 and all(isinstance(x, (int, float)) for x in s[:3]) and hit(*s[:3]):
                            n += 1
            if o.get("ty") in ("gf", "gs"):
                g = o.get("g", {})
                p, arr = g.get("p"), (g.get("k") or {}).get("k")
                if p and isinstance(arr, list) and arr and isinstance(arr[0], (int, float)):
                    for i in range(p):
                        off = i * 4
                        if off + 3 < len(arr) and hit(arr[off + 1], arr[off + 2], arr[off + 3]):
                            n += 1
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(doc)
    return n


def rebuild_from_source(src: Path) -> None:
    """Optional: re-run apktool b so build/apk reflects current source edits."""
    build = src / "build"
    if build.exists():
        import shutil
        shutil.rmtree(build)
    print(f"  apktool b {src.name} ...")
    r = subprocess.run([str(JAVA), "-jar", str(APKTOOL), "b", str(src)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"apktool failed for {src.name}:\n{r.stderr[:800]}")


def inject_susp(garmincar_src: Path):
    """Copy the base app's suspension icons into a GarminCar overlay + register
    them in public.xml so the overlay overrides the base. Idempotent."""
    import shutil
    base = ROOT / SUSP_BASE_DIR / "res" / "drawable"
    dst = garmincar_src / "res" / "drawable"
    pub = garmincar_src / "res" / "values" / "public.xml"
    if not base.exists() or not pub.exists():
        print(f"  [susp] base or public.xml missing — skip")
        return
    for n in SUSP_NAMES:
        src = base / f"{n}.xml"
        if src.exists():
            shutil.copyfile(src, dst / f"{n}.xml")
    text = pub.read_text(encoding="utf-8")
    if "ic_susp_" not in text:
        # assign IDs right after the existing drawable block
        existing = re.findall(r'type="drawable"[^>]*id="0x7f02([0-9a-fA-F]{4})"', text)
        start = max((int(x, 16) for x in existing), default=-1) + 1
        lines = "".join(
            f'    <public type="drawable" name="{n}" id="0x7f02{start + i:04x}" />\n'
            for i, n in enumerate(SUSP_NAMES))
        text = text.replace("</resources>", lines + "</resources>")
        pub.write_text(text, encoding="utf-8")
        print(f"  [susp] injected {len(SUSP_NAMES)} icons into {garmincar_src.name}")
    else:
        print(f"  [susp] already present in {garmincar_src.name}")


def inject_gauges(vehiclecluster_src: Path):
    """Copy the canonical gradient gauges into a VehicleCluster overlay's res/raw
    so this base adopts the leading-edge active-bar effect. Idempotent."""
    import shutil
    canon = ROOT / CANONICAL_GAUGE_DIR / "res" / "raw"
    dst = vehiclecluster_src / "res" / "raw"
    if not canon.exists():
        print("  [gauges] canonical gauge dir missing — skip")
        return
    n = 0
    for f in canon.glob("tex_*.json"):
        shutil.copyfile(f, dst / f.name)
        n += 1
    print(f"  [gauges] injected {n} canonical gauges into {vehiclecluster_src.name}")


def extract_overlay(apk_dir: Path, scopes: dict, apk_entry: dict) -> int:
    """Fill apk_entry's patch lists from scopes; return count of real issues."""
    issues = 0
    for scope in scopes["int_scopes"]:
        matched = entries_matching(apk_dir, scope["glob"])
        scope_total = 0
        for rel in matched:
            offs = find_int_offsets((apk_dir / rel).read_bytes(), scope["argb"])
            if offs:
                scope_total += len(offs)
                apk_entry["int_patches"].append({"control": scope["control"], "entry": rel,
                    "argb": f"{scope['argb']:08x}", "offsets": offs})
                print(f"  [int]  {scope['control']:10s} {rel:40s} #{scope['argb']:08x} x{len(offs)}")
        if matched and scope_total == 0:
            print(f"  [WARN] {scope['control']:10s} {scope['glob']}: #{scope['argb']:08x} not found")
            issues += 1
        elif not matched:
            print(f"  [WARN] {scope['control']:10s} {scope['glob']}: no entries matched")
            issues += 1
    for scope in scopes["json_scopes"]:
        for rel in entries_matching(apk_dir, scope["glob"]):
            text = (apk_dir / rel).read_text(encoding="utf-8", errors="ignore")
            if count_json_triples(text, scope["rgb"]):
                apk_entry["json_replace"].append({"control": scope["control"], "entry": rel, "rgb": scope["rgb"]})
                print(f"  [json] {scope['control']:10s} {rel}")
    for scope in scopes["png_tint"]:
        for rel in entries_matching(apk_dir, scope["glob"]):
            apk_entry["png_tint"].append({"control": scope["control"], "entry": rel})
            print(f"  [png-tint] {scope['control']:10s} {rel}")
    for scope in scopes["png_replace"]:
        for rel in entries_matching(apk_dir, scope["glob"]):
            apk_entry["png_replace"].append({"control": scope["control"], "entry": rel,
                "w": scope["w"], "h": scope["h"]})
            print(f"  [png-replace] {scope['control']:10s} {rel}")
    return issues


def zip_apk_dir(apk_dir: Path) -> bytes:
    """Zip a build/apk/ directory into an unsigned APK (bytes), mirroring storage."""
    import io
    buf = io.BytesIO()
    files = sorted(p for p in apk_dir.rglob("*") if p.is_file())
    with zipfile.ZipFile(buf, "w") as z:
        for p in files:
            rel = p.relative_to(apk_dir).as_posix()
            store = rel in STORED_NAMES or rel.lower().endswith(STORED_SUFFIXES)
            z.writestr(rel, p.read_bytes(),
                       zipfile.ZIP_STORED if store else zipfile.ZIP_DEFLATED)
    return buf.getvalue()


def entries_matching(apk_dir: Path, glob: str) -> list[str]:
    out = []
    for p in apk_dir.rglob("*"):
        if p.is_file():
            rel = p.relative_to(apk_dir).as_posix()
            if fnmatch(rel, glob):
                out.append(rel)
    return out


_VECTOR_TAG = re.compile(r"<vector\b[^>]*>", re.S)
_PATH_TAG = re.compile(r"<path\b[^>]*/?>", re.S)


def _attr(tag, name):
    m = re.search(rf'{name}="([^"]*)"', tag)
    return m.group(1) if m else None


def _norm_color(c):
    """Android color -> (svg_fill, opacity). Handles #rgb, #rrggbb, #aarrggbb."""
    if not c:
        return None, None
    h = c.lstrip("#")
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    if len(h) == 8:  # AARRGGBB
        a = int(h[0:2], 16) / 255
        return "#" + h[2:], round(a, 3)
    return "#" + h, None


def parse_vector(xml_text):
    """Parse an Android VectorDrawable into {viewBox, paths:[{d,fill,stroke,...}]}."""
    vtag = _VECTOR_TAG.search(xml_text).group(0)
    vw = _attr(vtag, "android:viewportWidth") or "24"
    vh = _attr(vtag, "android:viewportHeight") or "24"
    paths = []
    for ptag in _PATH_TAG.findall(xml_text):
        d = _attr(ptag, "android:pathData")
        if not d:
            continue
        fill, fop = _norm_color(_attr(ptag, "android:fillColor"))
        stroke, sop = _norm_color(_attr(ptag, "android:strokeColor"))
        p = {"d": d}
        p["fill"] = fill if fill else "none"
        if fop is not None:
            p["fillOpacity"] = fop
        if stroke:
            p["stroke"] = stroke
            sw = _attr(ptag, "android:strokeWidth")
            if sw:
                p["strokeWidth"] = sw
        paths.append(p)
    return {"viewBox": f"0 0 {vw} {vh}", "paths": paths}


# Physical cluster screen + density, from `adb shell dumpsys window displays`:
#   real 1280x800, density 240dpi, mStable=[0,36][1280,720]
SCREEN_W, SCREEN_H = 1280, 800
SCREEN_DENSITY = 240
DP = SCREEN_DENSITY / 160.0  # dp -> px scale factor (1.5 at 240dpi)
# Cluster fragment is inset by the system bars (fitsSystemWindows=true):
#   status bar 36px (top), nav bar 80px (bottom) -> fragment is the 684px between.
STATUS_BAR_PCT = 36 / SCREEN_H * 100   # 4.5
NAV_BAR_PCT = 80 / SCREEN_H * 100      # 10.0

_GUIDE_RE = re.compile(r"<androidx\.constraintlayout\.widget\.Guideline\b[^>]*>", re.S)
_ELEM_RE = re.compile(r"<([\w.]+)\b([^>]*?)/?>", re.S)
_DIM_RE = re.compile(r'<dimen name="([^"]+)">([0-9.]+)(px|dp)?</dimen>')


def _dimens(base_app):
    out = {}
    f = ROOT / base_app / "res" / "values" / "dimens.xml"
    if f.exists():
        text = f.read_text(encoding="utf-8")
        for name, val, unit in _DIM_RE.findall(text):
            out[name] = float(val) * (DP if unit == "dp" else 1.0)  # normalize to px
        # resolve @dimen aliases (e.g. gauge_icon_height -> @dimen/gauge_icon_width)
        for name, tgt in re.findall(r'<dimen name="([^"]+)">@dimen/([^<]+)</dimen>', text):
            if tgt in out:
                out[name] = out[tgt]
    return out


def parse_constraint_layout(xml, dims, ref_w=None, ref_h=None):
    """Resolve a ConstraintLayout's guideline/parent-anchored views to % boxes.

    Returns {id: {left,top,width,height} in % of screen}. Handles the cases used
    by fragment_cluster.xml: anchors to parent or percentage Guidelines, sizes of
    0dp (stretch between anchors), fixed @dimen (px), or wrap_content (point).

    ref_w/ref_h are the container's px size, used to convert fixed px sizes to %.
    For nested sub-layouts pass the parent gauge's px box so sizes scale to it.
    """
    rw = ref_w if ref_w is not None else SCREEN_W
    rh = ref_h if ref_h is not None else SCREEN_H
    guides = {}  # id -> ("h"|"v", percent 0..100)
    for tag in _GUIDE_RE.findall(xml):
        gid = _attr(tag, "android:id")
        if not gid:
            continue
        gid = gid.split("/")[-1]
        orient = "h" if _attr(tag, "android:orientation") == "horizontal" else "v"
        pct = _attr(tag, "app:layout_constraintGuide_percent")
        if pct is not None:
            guides[gid] = (orient, float(pct) * 100)

    def ref_x(ref):  # vertical guideline / parent -> x%
        if not ref or ref == "parent":
            return None
        r = ref.split("/")[-1]
        return guides[r][1] if r in guides else None

    def ref_y(ref):  # horizontal guideline / parent -> y%
        if not ref or ref == "parent":
            return None
        r = ref.split("/")[-1]
        return guides[r][1] if r in guides else None

    def size_pct(val, axis):
        if val is None:
            return None
        if val in ("0.0dp", "0dp"):
            return None  # stretch
        if val.startswith("@dimen/"):
            px = dims.get(val.split("/")[-1])
            if px is None:
                return None
            return px / (rw if axis == "w" else rh) * 100
        m = re.match(r"^([0-9.]+)(dp|px)$", val)  # literal e.g. "3.0dp"
        if m:
            px = float(m.group(1)) * (DP if m.group(2) == "dp" else 1.0)
            return px / (rw if axis == "w" else rh) * 100
        return None  # wrap_content / other

    out = {}
    for m in _ELEM_RE.finditer(xml):
        tag = m.group(0)
        eid = _attr(tag, "android:id")
        if not eid:
            continue
        eid = eid.split("/")[-1]

        a = lambda n: _attr(tag, n)
        ls = ref_x(a("app:layout_constraintStart_toStartOf"))
        if ls is None:
            ls = ref_x(a("app:layout_constraintStart_toEndOf"))
        le = ref_x(a("app:layout_constraintEnd_toEndOf"))
        if le is None:
            le = ref_x(a("app:layout_constraintEnd_toStartOf"))
        ts = ref_y(a("app:layout_constraintTop_toTopOf"))
        if ts is None:
            ts = ref_y(a("app:layout_constraintTop_toBottomOf"))
        be = ref_y(a("app:layout_constraintBottom_toBottomOf"))
        if be is None:
            be = ref_y(a("app:layout_constraintBottom_toTopOf"))

        start_parent = "parent" in (a("app:layout_constraintStart_toStartOf") or "")
        end_parent = "parent" in (a("app:layout_constraintEnd_toEndOf") or "")
        top_parent = "parent" in (a("app:layout_constraintTop_toTopOf") or "")
        bot_parent = "parent" in (a("app:layout_constraintBottom_toBottomOf") or "")

        w = size_pct(a("android:layout_width"), "w")
        h = size_pct(a("android:layout_height"), "h")

        x0 = 0 if start_parent else ls
        x1 = 100 if end_parent else le
        y0 = 0 if top_parent else ts
        y1 = 100 if bot_parent else be

        box = {}
        # horizontal
        if w is not None and (x0 is not None or x1 is not None):
            if x0 is not None and x1 is not None:  # fixed size, centered between anchors
                box["left"] = round((x0 + x1) / 2 - w / 2, 2)
            elif x0 is not None:
                box["left"] = round(x0, 2)
            else:
                box["left"] = round(x1 - w, 2)
            box["width"] = round(w, 2)
        elif x0 is not None and x1 is not None:
            box["left"] = round(x0, 2)
            box["width"] = round(x1 - x0, 2)
        elif x0 is not None:                       # point, left-anchored
            box["left"] = round(x0, 2)
        elif x1 is not None:                       # point, right-anchored
            box["right"] = round(100 - x1, 2)
        # vertical
        if h is not None and (y0 is not None or y1 is not None):
            if y0 is not None:
                box["top"] = round(y0, 2)
            else:
                box["top"] = round(y1 - h, 2)
            box["height"] = round(h, 2)
        elif y0 is not None and y1 is not None:
            box["top"] = round(y0, 2)
            box["height"] = round(y1 - y0, 2)
        elif y0 is not None:                        # point, top-anchored
            box["top"] = round(y0, 2)
        elif y1 is not None:                        # point, bottom-anchored
            box["bottom"] = round(100 - y1, 2)

        if box:
            out[eid] = box
    return out


def _extract_layout():
    """Cluster geometry from the base app's ConstraintLayouts (theme-independent)."""
    dims = _dimens("vehiclecluster")
    frag_h_px = SCREEN_H * (100 - STATUS_BAR_PCT - NAV_BAR_PCT) / 100
    frag = ROOT / "vehiclecluster" / "res" / "layout" / "fragment_cluster.xml"
    if not frag.exists():
        return None
    boxes = parse_constraint_layout(frag.read_text(encoding="utf-8"), dims,
                                    ref_w=SCREEN_W, ref_h=frag_h_px)
    idmap = {
        "center_gauge": "center", "left_gauge": "left", "right_gauge": "right",
        "vendorLogo": "logo", "odometer_divider": "divider", "odometer_fields": "readouts",
        "datafields": "datafields", "coolant_temperature": "coolant",
    }
    layout = {dst: boxes[src] for src, dst in idmap.items() if src in boxes}
    layout["bands"] = {"status": STATUS_BAR_PCT, "nav": NAV_BAR_PCT}

    sides = {}
    for role, fname in {"left": "cluster_temperature_gauge.xml",
                        "right": "cluster_fuel_gauge.xml"}.items():
        gbox = layout.get(role)
        sf = ROOT / "vehiclecluster" / "res" / "layout" / fname
        if gbox and sf.exists():
            sub = parse_constraint_layout(sf.read_text(encoding="utf-8"), dims,
                ref_w=gbox["width"] / 100 * SCREEN_W, ref_h=gbox["height"] / 100 * frag_h_px)
            sides[role] = {"gauge": sub.get("gauge"), "icon": sub.get("gauge_icon"),
                           "mk_top": sub.get("gauge_text_full"), "mk_bot": sub.get("gauge_text_empty")}
    if sides:
        layout["sides"] = sides

    cf = ROOT / "vehiclecluster" / "res" / "layout" / "cluster_center_gauge.xml"
    cbox = layout.get("center")
    if cf.exists() and cbox:
        csub = parse_constraint_layout(cf.read_text(encoding="utf-8"), dims,
            ref_w=cbox["width"] / 100 * SCREEN_W, ref_h=cbox["height"] / 100 * frag_h_px)
        if csub.get("center_data_field"):
            layout["center_speed"] = csub["center_data_field"]
    return layout


def export_preview(base_name, base):
    """Write docs/preview/<base>/{preview.json, gauges/*, img/*} for the mockup."""
    import shutil
    pdir = DOCS / "preview" / base_name
    (pdir / "gauges").mkdir(parents=True, exist_ok=True)
    (pdir / "img").mkdir(parents=True, exist_ok=True)
    vc = ROOT / base["dirs"]["VehicleCluster"]
    sysui = ROOT / base["dirs"]["SystemUI"]
    gc = ROOT / base["dirs"]["GarminCar"]

    preview = {
        "controls_base": dict(base["colors"]),
        # gauges are the canonical animations in every base — recolor FROM these
        "gauge_from": {"primary": GAUGE_PRIMARY, "active_bar": GAUGE_ACTIVE, "track": "#999999"},
        "gauges": [], "images": {}, "gauge_icons": [],
        "navbar": {"logo": None, "apps": []},
        "markers": {"left": ["C", "H"], "right": ["E", "F"]},  # temp C/H, fuel E/F
    }
    layout = _extract_layout()
    if layout:
        preview["layout"] = layout

    def load_vec(path, **extra):
        if not path.exists():
            print(f"  [preview] MISSING {path.relative_to(ROOT)}")
            return None
        v = parse_vector(path.read_text(encoding="utf-8"))
        v.update(extra)
        return v

    # gauges (theme overlay's Lottie)
    for entry, label, pos in [("tex_tach.json", "Tach", "center"),
                              ("tex_temp_gauge.json", "Temp", "left"),
                              ("tex_fuel_gauge.json", "Fuel", "right")]:
        src = vc / "res" / "raw" / entry
        if src.exists():
            shutil.copyfile(src, pdir / "gauges" / entry)
            preview["gauges"].append({"label": label, "pos": pos,
                                      "src": f"preview/{base_name}/gauges/{entry}"})
            print(f"  [preview] gauge {label:6s} ({pos})")

    # side-gauge icons (white, from the base app — shared)
    for entry, role in [("ic_ice_temp_icon.xml", "left"), ("ic_ice_fuel_icon.xml", "right")]:
        v = load_vec(ROOT / "vehiclecluster" / "res" / "drawable" / entry, role=role)
        if v:
            preview["gauge_icons"].append(v)

    # navbar: SystemUI logo + a suspension (IQS) indicator
    v = load_vec(sysui / "res" / "drawable" / "ic_sysbar_cluster.xml", control="logo")
    if v:
        preview["navbar"]["logo"] = v
    # right-side icons: neutral gear, then the suspension-mode indicator
    gear = load_vec(gc / "res" / "drawable" / "ic_gear_n.xml", control="susp", label="N")
    if gear:
        preview["navbar"]["apps"].append(gear)
    v = load_vec(gc / "res" / "drawable" / "ic_susp_firm_enabled.xml", control="susp", label="Susp")
    if v:
        preview["navbar"]["apps"].append(v)

    # center logo: vector (recolor as SVG) or PNG (canvas tint)
    if base["logo_kind"] == "vector":
        v = load_vec(vc / "res" / "drawable" / "cluster_center_logo.xml", control="logo")
        if v:
            preview["center_logo_vector"] = v
            print(f"  [preview] center logo: vector ({len(v['paths'])} paths)")
    else:
        src = vc / "res" / "drawable" / "cluster_center_logo.png"
        if src.exists():
            shutil.copyfile(src, pdir / "img" / "cluster_center_logo.png")
            preview["images"]["logo"] = f"preview/{base_name}/img/cluster_center_logo.png"
            print(f"  [preview] center logo: png")

    # background sphere image
    src = vc / "res" / "drawable-nodpi" / "tex_bg.png"
    if src.exists():
        shutil.copyfile(src, pdir / "img" / "tex_bg.png")
        preview["images"]["background"] = f"preview/{base_name}/img/tex_bg.png"

    (pdir / "preview.json").write_text(json.dumps(preview, indent=2))
    print(f"  -> wrote {(pdir / 'preview.json').relative_to(ROOT)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", action="store_true", help="print findings, write nothing")
    ap.add_argument("--no-preview", action="store_true", help="skip docs/preview export")
    ap.add_argument("--base", help="only generate this base (default: all)")
    args = ap.parse_args()

    manifest = {"control_labels": CONTROL_LABELS, "bases": {}}
    total_issues = 0
    bases = {args.base: BASES[args.base]} if args.base else BASES

    for base_name, base in bases.items():
        print(f"\n############  BASE: {base_name}  ({base['label']})  ############")
        base_entry = {
            "label": base["label"],
            "controls": {**base["colors"], "bg_image": None},  # supported controls + base color
            "apks": {},
        }
        for key in OVERLAY_KEYS:
            src = ROOT / base["dirs"][key]
            if base.get("inject_susp") and key == "GarminCar":
                inject_susp(src)
            if base.get("inject_gauges") and key == "VehicleCluster":
                inject_gauges(src)
            if base.get("rebuild") or not (src / "build" / "apk").exists():
                rebuild_from_source(src)
            apk_dir = src / "build" / "apk"
            if not apk_dir.exists():
                print(f"[SKIP] {base_name}/{key}: no build/apk")
                continue

            print(f"\n=== {base_name}/{key} ({src.name}) ===")
            mani = (src / "AndroidManifest.xml").read_text(encoding="utf-8")
            pkg_m = re.search(r'package="([^"]+)"', mani)
            apk_entry = {
                "file": f"templates/{base_name}/{key}.apk",
                "package": pkg_m.group(1) if pkg_m else None,
                "int_patches": [], "json_replace": [], "png_tint": [], "png_replace": [],
            }
            total_issues += extract_overlay(apk_dir, build_scopes(base, key), apk_entry)
            base_entry["apks"][key] = apk_entry

            if not args.report:
                out = DOCS / "templates" / base_name / f"{key}.apk"
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(zip_apk_dir(apk_dir))
                print(f"  -> wrote {out.relative_to(ROOT)} ({out.stat().st_size:,} bytes)")

        manifest["bases"][base_name] = base_entry

        if not args.report and not args.no_preview:
            print(f"\n--- Preview assets ({base_name}) ---")
            export_preview(base_name, base)

    if not args.report:
        # merge into existing offsets.json when generating a single base
        out = DOCS / "offsets.json"
        if args.base and out.exists():
            existing = json.loads(out.read_text())
            existing.setdefault("bases", {}).update(manifest["bases"])
            existing["control_labels"] = CONTROL_LABELS
            manifest = existing
        out.write_text(json.dumps(manifest, indent=2))
        print(f"\nWrote {out.relative_to(ROOT)}")

    print(f"\nDone. {total_issues} issue(s).")
    if total_issues:
        print("Investigate WARN lines above before trusting the manifest.")


if __name__ == "__main__":
    main()
