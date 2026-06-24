// build.js — orchestrate building all overlay APKs from the user's choices.
//
// Loads the manifest + templates + signing key (all static assets under docs/),
// computes PNG overrides for raster controls, patches+signs each APK, and returns
// { name, deviceDir, outName, bytes } for the installer.

import { buildApk } from './patch.js';
import { tintPng, fitImageToPng } from './png-tint.js';

let _cache;
async function loadAssets(base = '.') {
  if (_cache) return _cache;
  const [manifest, keyPem, certPem] = await Promise.all([
    fetch(`${base}/offsets.json`).then((r) => r.json()),
    fetch(`${base}/signing/key.pem`).then((r) => r.text()),
    fetch(`${base}/signing/cert.pem`).then((r) => r.text()),
  ]);
  _cache = { manifest, signing: { keyPem, certPem }, base };
  return _cache;
}

/**
 * @param {string} baseName                 theme base id (e.g. "yamaha")
 * @param {Object<string,string>} colors  control -> "#rrggbb"
 * @param {File|null} bgImageFile          optional uploaded background image
 * @param {(msg:string)=>void} onProgress
 * @returns {Promise<Array<{name,package,bytes}>>}
 */
export async function buildAll(baseName, colors, bgImageFile, barSpec, onProgress = () => {}) {
  const { manifest, signing, base } = await loadAssets();
  const baseDef = manifest.bases[baseName];
  if (!baseDef) throw new Error(`Unknown base "${baseName}"`);
  const results = [];

  for (const [name, apk] of Object.entries(baseDef.apks)) {
    onProgress(`Building ${name}…`);
    const template = new Uint8Array(
      await fetch(`${base}/${apk.file}`).then((r) => r.arrayBuffer())
    );

    // Prepare raster overrides for this APK.
    const pngOverrides = {};
    for (const t of apk.png_tint || []) {
      if (!colors[t.control]) continue;
      const orig = await getEntryBytes(template, t.entry);
      pngOverrides[t.entry] = await tintPng(orig, colors[t.control]);
    }
    for (const p of apk.png_replace || []) {
      if (p.control === 'bg_image' && bgImageFile) {
        pngOverrides[p.entry] = await fitImageToPng(bgImageFile, p.w, p.h);
      }
    }

    const bytes = await buildApk(template, apk, colors, pngOverrides, signing, barSpec);
    results.push({ name, package: apk.package, bytes });
  }
  onProgress('All overlays built.');
  return results;
}

// Pull one entry's bytes out of a template (for tinting the existing logo).
import JSZip from 'jszip';
async function getEntryBytes(zipBytes, entry) {
  const zip = await JSZip.loadAsync(zipBytes);
  return zip.file(entry).async('uint8array');
}

export { loadAssets };
