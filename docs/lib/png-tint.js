// png-tint.js — browser-only canvas helpers for the two raster controls.
//
//   tintPng(bytes, hex)        recolor a single-color logo, preserving alpha edges
//   fitImageToPng(file, w, h)  scale an uploaded image to cover w x h, encode PNG
//
// Uses <canvas>, so this module is browser-only and is called from app.js, never
// from patch.js (which stays portable). Outputs Uint8Array PNG bytes.

function decode(bytesOrBlob) {
  const blob = bytesOrBlob instanceof Blob
    ? bytesOrBlob
    : new Blob([bytesOrBlob], { type: 'image/png' });
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

async function canvasToBytes(canvas) {
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

// saturation of an 8-bit RGB pixel (0..1)
function satOf(r, g, b) {
  const mx = Math.max(r, g, b);
  return mx ? (mx - Math.min(r, g, b)) / mx : 0;
}

const SAT_MIN = 0.18; // below this a pixel is treated as silver/white/black and kept

/**
 * Recolor the brand-colored pixels of an image to `hex`, preserving silver/white
 * accents, black, and anti-aliasing. Each colored pixel is mapped to the TARGET
 * color scaled by its own brightness relative to the brightest colored pixel — so
 * a dark target (e.g. #000000) yields black, not a hue shift. Low-saturation
 * pixels (chrome accents, black background) and transparency are left untouched.
 */
export async function tintPng(bytes, hex) {
  const img = await decode(bytes);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  const d = id.data;
  const tr = parseInt(hex.slice(1, 3), 16);
  const tg = parseInt(hex.slice(3, 5), 16);
  const tb = parseInt(hex.slice(5, 7), 16);

  // pass 1: brightest colored pixel (the solid brand color) -> maps to full target
  let vmax = 1;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    if (satOf(d[i], d[i + 1], d[i + 2]) >= SAT_MIN) {
      const v = Math.max(d[i], d[i + 1], d[i + 2]);
      if (v > vmax) vmax = v;
    }
  }
  // pass 2: recolor colored pixels, keep accents/black/transparency
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    if (satOf(d[i], d[i + 1], d[i + 2]) < SAT_MIN) continue;
    const f = Math.min(1, Math.max(d[i], d[i + 1], d[i + 2]) / vmax);
    d[i] = Math.round(tr * f); d[i + 1] = Math.round(tg * f); d[i + 2] = Math.round(tb * f);
  }
  ctx.putImageData(id, 0, 0);
  return canvasToBytes(c);
}

/** Scale `file` to cover w x h (center-crop), return PNG bytes. */
export async function fitImageToPng(file, w, h) {
  const img = await decode(file);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  return canvasToBytes(c);
}

/** Make a small data-URL preview of tinted logo bytes for the UI. */
export async function pngToDataUrl(bytes) {
  const blob = new Blob([bytes], { type: 'image/png' });
  return new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.readAsDataURL(blob);
  });
}
