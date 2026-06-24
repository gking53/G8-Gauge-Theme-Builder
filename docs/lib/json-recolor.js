// json-recolor.js — recolor Lottie gauges: solid fills/strokes by value, and the
// bar GRADIENTS structurally. Runs in Node and the browser.
//
//   recolorJson(text, solidRules, barSpec)
//     solidRules : [{ rgb:[r,g,b] 0-255, to:[r,g,b] }]  — exact-value solid recolor
//     barSpec    : how to recolor the gauge bar gradients:
//        { mode:'single', c1:[r,g,b] }                 hue-shift shade gradient to c1
//        { mode:'two', c1:[r,g,b], c2:[r,g,b], fade }  start->end gradient, fade=curve
//
// Gradient heuristic: stops that VARY = the main bar (a dark->light shade ramp);
// stops that are IDENTICAL = the bright leading-edge highlight (kept with its
// original alpha fade, recolored to a light tint of the bar color).

const to255 = (r, g, b) => [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];

function rgb2hsv(r, g, b) {            // 0-255 -> [h 0-360, s 0-1, v 0-1]
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return [h, mx ? d / mx : 0, mx];
}
function hsv2rgb(h, s, v) {             // -> [r,g,b] 0-255
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
const lerp3 = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));

export function recolorJson(text, solidRules = [], barSpec = null) {
  let doc;
  try { doc = JSON.parse(text); } catch { return { text, replaced: 0 }; }
  let replaced = 0;

  const setStop = (arr, i, c) => { arr[i * 4 + 1] = c[0] / 255; arr[i * 4 + 2] = c[1] / 255; arr[i * 4 + 3] = c[2] / 255; replaced++; };

  const recolorSolid = (k) => {
    if (!Array.isArray(k) || k.length < 3 || typeof k[0] !== 'number') return;
    const c = to255(k[0], k[1], k[2]);
    const r = solidRules.find((x) => x.rgb[0] === c[0] && x.rgb[1] === c[1] && x.rgb[2] === c[2]);
    if (r) { k[0] = r.to[0] / 255; k[1] = r.to[1] / 255; k[2] = r.to[2] / 255; replaced++; }
  };

  const recolorGradient = (g) => {
    if (!barSpec) return;
    const p = g.p, arr = g.k && g.k.k;
    if (!p || !Array.isArray(arr) || typeof arr[0] !== 'number') return;
    const pos = [], cols = [];
    for (let i = 0; i < p; i++) { pos.push(arr[i * 4]); cols.push([arr[i * 4 + 1], arr[i * 4 + 2], arr[i * 4 + 3]]); }
    const same = cols.every((c) => c[0] === cols[0][0] && c[1] === cols[0][1] && c[2] === cols[0][2]);
    const lo = Math.min(...pos), span = (Math.max(...pos) - lo) || 1;

    if (same) {
      // leading-edge highlight -> a light tint of the bar color (keep alpha ramp)
      const base = barSpec.mode === 'two' ? barSpec.c2 : barSpec.c1;
      const [h, s] = rgb2hsv(base[0], base[1], base[2]);
      const light = hsv2rgb(h, s * 0.45, 1);
      for (let i = 0; i < p; i++) setStop(arr, i, light);
      return;
    }
    // main bar shade gradient
    if (barSpec.mode === 'two') {
      const fade = barSpec.fade == null ? 0.5 : barSpec.fade;
      const expo = Math.pow(4, (fade - 0.5) * 2);  // 0.5 -> linear; lower -> sharper
      for (let i = 0; i < p; i++) {
        const t = Math.pow((pos[i] - lo) / span, expo);
        setStop(arr, i, lerp3(barSpec.c1, barSpec.c2, t));
      }
    } else {
      const [h1, s1] = rgb2hsv(barSpec.c1[0], barSpec.c1[1], barSpec.c1[2]);
      for (let i = 0; i < p; i++) {
        const v = rgb2hsv(cols[i][0] * 255, cols[i][1] * 255, cols[i][2] * 255)[2];
        setStop(arr, i, hsv2rgb(h1, s1, v));  // target hue/sat, keep each shade's lightness
      }
    }
  };

  (function walk(o) {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o && typeof o === 'object') {
      if (o.c && o.c.k != null) {
        if (typeof o.c.k[0] === 'number') recolorSolid(o.c.k);
        else if (Array.isArray(o.c.k)) o.c.k.forEach((kf) => kf && recolorSolid(kf.s));
      }
      if ((o.ty === 'gf' || o.ty === 'gs') && o.g) recolorGradient(o.g);
      for (const key in o) if (key !== 'c' && key !== 'g') walk(o[key]);
    }
  })(doc);

  return { text: JSON.stringify(doc), replaced };
}

/** "#rrggbb" -> [r,g,b] */
export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
