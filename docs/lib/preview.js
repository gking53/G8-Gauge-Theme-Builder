// preview.js — faithful in-browser cluster + SystemUI mockup.
//
// Renders the REAL assets recolored with the same logic as the build:
//   * gauges      — actual Lottie JSON (lottie-web), recolored via json-recolor.js
//   * gauge icons — thermometer / fuel-pump vectors, color-filtered to primary
//   * gear / logo / nav icons — VectorDrawable pathData as inline SVG
//   * background  — gradient + cluster background image
//   * logo        — cluster_center_logo.png canvas-tinted (silver accents kept)
//   * SystemUI    — bottom nav bar: back · logo · home  |  IQS app icons
//
// Layout positions mirror fragment_cluster.xml constraint guidelines (1280x800).
// Numbers (RPM, temp, fuel, odo, clock) are placeholders — only colors are real.

import lottie from 'lottie-web';
import { recolorJson, hexToRgb } from './json-recolor.js';
import { tintPng, pngToDataUrl } from './png-tint.js';

const eq = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();

export async function initPreview(container, base = '.', baseName = 'yamaha') {
  const data = await fetch(`${base}/preview/${baseName}/preview.json`).then((r) => r.json());
  const baseColors = data.controls_base;

  const gaugeText = await Promise.all(
    data.gauges.map((g) => fetch(`${base}/${g.src}`).then((r) => r.text()))
  );
  const logoBytes = data.images.logo
    ? new Uint8Array(await fetch(`${base}/${data.images.logo}`).then((r) => r.arrayBuffer()))
    : null;
  const bgBytes = data.images.background
    ? new Uint8Array(await fetch(`${base}/${data.images.background}`).then((r) => r.arrayBuffer()))
    : null;

  // ── recolor a VectorDrawable into an <svg> string ──
  function svg(v, colors, klass = '') {
    const paint = (c) => {
      if (!c || c === 'none') return c;
      if (v.filter) return colors[v.control] || c;          // color-filter: recolor all
      return eq(c, baseColors[v.control]) ? (colors[v.control] || c) : c; // value-based
    };
    const paths = v.paths.map((p) => {
      const f = paint(p.fill), s = p.stroke ? paint(p.stroke) : null;
      return `<path d="${p.d}" fill="${f}"` +
        (p.fillOpacity != null ? ` fill-opacity="${p.fillOpacity}"` : '') +
        (s ? ` stroke="${s}"` : '') + (p.strokeWidth ? ` stroke-width="${p.strokeWidth}"` : '') + '/>';
    }).join('');
    return `<svg class="${klass}" viewBox="${v.viewBox}" preserveAspectRatio="xMidYMid meet">${paths}</svg>`;
  }

  // ── DOM scaffold: status bar / cluster fragment / nav bar bands ──
  container.innerHTML = `
    <div class="pv-stage">
      <div class="pv-bg"></div>
      <img class="pv-bgimg" alt="" />
      <div class="pv-statusbar"></div>
      <div class="pv-fragment">
      <div class="pv-gauge pv-center"><div class="pv-lottie"></div>
        <div class="pv-speed"><b>45</b><span>MPH</span></div></div>
      <div class="pv-gauge pv-left"><div class="pv-lottie"></div>
        <div class="pv-gicon"></div>
        <span class="pv-mk pv-mk-top"></span><span class="pv-mk pv-mk-bot"></span></div>
      <div class="pv-gauge pv-right"><div class="pv-lottie"></div>
        <div class="pv-gicon"></div>
        <span class="pv-mk pv-mk-top"></span><span class="pv-mk pv-mk-bot"></span></div>
      <div class="pv-coolant">90&deg;</div>
      <div class="pv-logo"></div>
      <div class="pv-odo"></div>
      <div class="pv-readouts">
        <div class="pv-of"><span class="pv-of-t">ODO</span><span class="pv-of-v">5280.0</span></div>
        <div class="pv-of"></div>
        <div class="pv-of"><span class="pv-of-v">1234.5</span><span class="pv-of-u">hrs</span></div>
      </div>
      <div class="pv-datafields"></div>
      </div>
      <div class="pv-navbar">
        <div class="pv-nav-left">
          <button class="pv-nav-btn pv-nav-back" title="Back">
            <svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" fill="none" stroke="#cfd6e6" stroke-width="2"/></svg></button>
          <button class="pv-nav-btn pv-nav-logo" title="Cluster"></button>
          <button class="pv-nav-btn pv-nav-home" title="Home">
            <svg viewBox="0 0 24 24"><path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z" fill="none" stroke="#cfd6e6" stroke-width="2"/></svg></button>
        </div>
        <div class="pv-nav-right"></div>
      </div>
    </div>`;

  const q = (s) => container.querySelector(s);
  const elBg = q('.pv-bg'), elBgImg = q('.pv-bgimg'), elLogo = q('.pv-logo'), elOdo = q('.pv-odo');

  // Apply geometry ripped from the app's ConstraintLayout (overrides CSS).
  const L = data.layout || {};
  const place = (sel, box) => {
    const el = q(sel); if (!el || !box) return;
    el.style.position = 'absolute'; el.style.transform = 'none';
    el.style.left = el.style.right = el.style.top = el.style.bottom = 'auto';
    for (const k of ['left', 'right', 'top', 'bottom', 'width', 'height']) {
      if (box[k] != null && (k !== 'height' || box[k] >= 1)) el.style[k] = box[k] + '%';
    }
  };
  place('.pv-center', L.center); place('.pv-left', L.left); place('.pv-right', L.right);
  place('.pv-odo', L.divider);
  // odometer row = 3 fields across full width (odometer, DTC, engine hours)
  place('.pv-readouts', L.readouts);
  // logo: vector fills its full box; PNG keeps native aspect (width only)
  if (L.logo) {
    place('.pv-logo', data.center_logo_vector
      ? L.logo : { left: L.logo.left, top: L.logo.top, width: L.logo.width });
  }
  place('.pv-coolant', L.coolant);  // coolant temp number (upper-left of left gauge)
  // nested side-gauge internals (gauge inset, icon, C/H & E/F markers)
  const sides = L.sides || {};
  ['left', 'right'].forEach((role) => {
    const s = sides[role]; if (!s) return;
    place(`.pv-${role} .pv-lottie`, s.gauge);
    place(`.pv-${role} .pv-gicon`, s.icon);
    place(`.pv-${role} .pv-mk-top`, s.mk_top);
    place(`.pv-${role} .pv-mk-bot`, s.mk_bot);
  });
  place('.pv-speed', L.center_speed);  // big speed readout in the center gauge

  // Bands: cluster fragment sits between the status bar and nav bar (like the device).
  const bands = L.bands || { status: 0, nav: 13 };
  q('.pv-statusbar').style.height = bands.status + '%';
  const frag = q('.pv-fragment');
  frag.style.top = bands.status + '%';
  frag.style.bottom = bands.nav + '%';
  q('.pv-navbar').style.height = bands.nav + '%';
  // background image fills the FULL screen on the device: content_main (which holds
  // the tex_bg ImageView) has no fitsSystemWindows, so it spans edge-to-edge behind
  // the translucent system bars. The asset is screen-sized (1280x800 = the 16:10
  // stage), so object-fit:contain fills it exactly with the glow centered; uploaded
  // images get fitCenter (letterboxed), matching the device's default scaleType.
  // width/height MUST be set explicitly — an <img> is a replaced element, so
  // top/bottom/left/right alone won't stretch it (it keeps its intrinsic size).
  elBgImg.style.top = '0'; elBgImg.style.left = '0';
  elBgImg.style.width = '100%'; elBgImg.style.height = '100%';

  // metrics bar (datafields) is NOT modeled — its space is already reserved by the
  // fragment layout; we just leave the region empty.

  // markers (C/H, E/F)
  if (data.markers) {
    q('.pv-left .pv-mk-top').textContent = data.markers.left[1];   // H
    q('.pv-left .pv-mk-bot').textContent = data.markers.left[0];   // C
    q('.pv-right .pv-mk-top').textContent = data.markers.right[1]; // F
    q('.pv-right .pv-mk-bot').textContent = data.markers.right[0]; // E
  }

  // gauge lottie containers, in preview.json order
  const lotEls = data.gauges.map((g) => q(`.pv-${g.pos} .pv-lottie`));
  let anims = [];

  let bgImageUrl = null, timer = null, barSpecs = null, gaugeMode = 'anim', lastColors = null;
  const POS_GROUP = { center: 'center', left: 'coolant', right: 'fuel' };

  // Preview-only gauge bar state (for debugging gradient ranges):
  //   'anim'  -> the white highlight sweeps (real device behavior)
  //   'full'  -> frozen at the last frame (highlight at the tip, bar 100%)
  //   'empty' -> only the static base/track renders, bar fill removed (0%)
  // The colored bar is static-full in the asset, so 'empty' can't be a frame — we
  // strip the gradient fill layers (and their matte layers) at build time, leaving
  // just the solid base layer (the dial/track).
  const layerHasGradient = (layer) => {
    let g = false;
    (function w(o) {
      if (Array.isArray(o)) { o.forEach(w); return; }
      if (o && typeof o === 'object') { if (o.ty === 'gf' || o.ty === 'gs') g = true; for (const k in o) w(o[k]); }
    })(layer.shapes || []);
    return g;
  };
  function emptyBarLayers(json) {
    const L = json.layers || [];
    for (let i = 0; i < L.length; i++) {
      const isMatteFor = i + 1 < L.length && L[i + 1].tt;  // L[i] is the matte of L[i+1]
      if (layerHasGradient(L[i]) || isMatteFor) {
        L[i].hd = true;
        L[i].ks = L[i].ks || {};
        L[i].ks.o = { a: 0, k: 0 };   // opacity 0 — reliable hide across lottie-web versions
      }
    }
  }
  function applyGaugeMode() {
    anims.forEach((a) => {
      if (!a) return;
      if (gaugeMode === 'anim') { a.loop = true; a.play(); }
      else { a.goToAndStop(gaugeMode === 'full' ? Math.max(0, a.totalFrames - 1) : 0, true); }
    });
  }

  function apply(colors) {
    lastColors = colors;   // remembered so a gauge-mode toggle can rebuild
    // background: black, with the colored sphere of tex_bg.png recolored to the
    // background color (or a user-uploaded image). Black stays black.
    elBg.style.background = '#000';
    if (bgImageUrl) {
      elBgImg.src = bgImageUrl; elBgImg.style.display = '';
    } else if (bgBytes) {
      tintPng(bgBytes, colors.background || baseColors.background)
        .then(pngToDataUrl).then((u) => { elBgImg.src = u; elBgImg.style.display = ''; });
    } else {
      elBgImg.style.display = 'none';
    }

    // odometer divider (transparent -> primary -> transparent)
    const prim = colors.primary || baseColors.primary;
    elOdo.style.background = `linear-gradient(90deg, transparent, ${prim} 50%, transparent)`;

    // side gauge icons (native white)
    (data.gauge_icons || []).forEach((v) => {
      const el = q(`.pv-${v.role} .pv-gicon`);
      if (el) el.innerHTML = svg(v, colors);
    });

    // center logo: vector (recolor as SVG) or PNG (silver-preserving canvas tint)
    if (data.center_logo_vector) {
      elLogo.innerHTML = svg(data.center_logo_vector, colors);
    } else if (logoBytes && colors.logo) {
      tintPng(logoBytes, colors.logo).then(pngToDataUrl).then((u) => {
        elLogo.innerHTML = `<img alt="logo" src="${u}" style="width:100%;display:block"/>`;
      });
    }

    // navbar logo + IQS apps
    if (data.navbar?.logo) q('.pv-nav-logo').innerHTML = svg(data.navbar.logo, colors);
    q('.pv-nav-right').innerHTML = (data.navbar?.apps || [])
      .map((v) => `<button class="pv-nav-btn">${svg(v, colors)}</button>`).join('');

    // gauges (recolor + reload Lottie)
    anims.forEach((a) => a.destroy());
    // gauges are the canonical animations -> recolor solid markings FROM the
    // canonical primary; bar gradients are recolored structurally via barSpec.
    const gf = data.gauge_from || { primary: baseColors.primary };
    anims = data.gauges.map((g, i) => {
      const solidRules = [
        { rgb: hexToRgb(gf.primary), to: hexToRgb(colors.primary || baseColors.primary) },
      ];
      if (gf.track) solidRules.push({ rgb: hexToRgb(gf.track), to: hexToRgb(colors.track || baseColors.track || gf.track) });
      const group = POS_GROUP[g.pos] || 'center';
      const spec = (barSpecs && barSpecs[group])
        || { mode: 'single', c1: hexToRgb(baseColors.active_bar || baseColors.primary) };
      const { text } = recolorJson(gaugeText[i], solidRules, spec);
      let json; try { json = JSON.parse(text); } catch { return null; }
      if (gaugeMode === 'empty') emptyBarLayers(json);   // strip fill -> 0% (track only)
      return lottie.loadAnimation({
        container: lotEls[i], renderer: 'svg',
        loop: gaugeMode === 'anim', autoplay: gaugeMode === 'anim', animationData: json,
      });
    }).filter(Boolean);
    applyGaugeMode();   // re-apply the chosen bar mode to the freshly built anims
  }

  return {
    update(colors, bgFile, barSpecsVal) {
      if (bgFile) { if (bgImageUrl) URL.revokeObjectURL(bgImageUrl); bgImageUrl = URL.createObjectURL(bgFile); }
      else if (bgFile === null) { if (bgImageUrl) URL.revokeObjectURL(bgImageUrl); bgImageUrl = null; }
      if (barSpecsVal !== undefined) barSpecs = barSpecsVal;
      clearTimeout(timer);
      timer = setTimeout(() => apply(colors), 120);
    },
    setGaugeMode(mode) {
      const needsRebuild = (mode === 'empty') !== (gaugeMode === 'empty');
      gaugeMode = mode;
      if (needsRebuild && lastColors) apply(lastColors);   // 'empty' strips layers
      else applyGaugeMode();                                // others: just playback
    },
  };
}
