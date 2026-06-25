// patch.js — apply a user's color choices to one template APK, then v1-sign it.
//
// Three kinds of edits, all driven by docs/offsets.json:
//   * int_patches  — overwrite 4-byte ARGB values at known offsets in
//                    resources.arsc / compiled AXML (alpha byte preserved).
//   * json_replace — value-based recolor of Lottie arrays in res/raw/*.json.
//   * png overrides — caller supplies replacement bytes for an entry (logo tint
//                     or background-image upload), produced by png-tint.js in the
//                     browser. patch.js itself stays canvas-free and portable.
//
// Portable across Node and browser (JSZip + resign.js).

import JSZip from 'jszip';
import { signApkV1 } from './resign.js';
import { recolorJson, hexToRgb } from './json-recolor.js';

function writeArgbLE(bytes, offset, hex) {
  const [r, g, b] = hexToRgb(hex);
  bytes[offset] = b;       // little-endian AARRGGBB -> [BB,GG,RR,AA]
  bytes[offset + 1] = g;
  bytes[offset + 2] = r;
  // bytes[offset + 3] (alpha) left untouched
}

/**
 * @param {Uint8Array} templateBytes  unsigned template APK
 * @param {object} apkManifest        offsets.json entry for this APK
 * @param {Object<string,string>} colors   control -> "#rrggbb"
 * @param {Object<string,Uint8Array>} pngOverrides  entry path -> replacement bytes
 * @param {{keyPem:string, certPem:string}} signing
 * @returns {Promise<Uint8Array>} signed APK
 */
export async function buildApk(templateBytes, apkManifest, colors, pngOverrides, signing, barSpecs = null) {
  const zip = await JSZip.loadAsync(templateBytes);

  // 1) int patches, grouped by entry so each entry is read/written once.
  const byEntry = new Map();
  for (const p of apkManifest.int_patches || []) {
    if (!colors[p.control]) continue;
    if (!byEntry.has(p.entry)) byEntry.set(p.entry, []);
    byEntry.get(p.entry).push(p);
  }
  for (const [entry, patches] of byEntry) {
    const bytes = await zip.file(entry).async('uint8array');
    for (const p of patches) {
      for (const off of p.offsets) writeArgbLE(bytes, off, colors[p.control]);
    }
    const store = entry === 'resources.arsc' || entry.toLowerCase().endsWith('.png');
    zip.file(entry, bytes, store ? { compression: 'STORE' } : undefined);
  }

  // 2) json recolor: solid markings by value (primary/track); each gauge's bar
  //    gradient uses its group's barSpec (center / coolant / fuel).
  const gaugeEntries = new Set();
  const solidByEntry = new Map();
  const groupByEntry = new Map();
  for (const j of apkManifest.json_replace || []) {
    gaugeEntries.add(j.entry);
    if (j.control === 'active_bar') {
      groupByEntry.set(j.entry, j.group || 'center');
    } else if (colors[j.control]) {  // solid fills (markings, track)
      if (!solidByEntry.has(j.entry)) solidByEntry.set(j.entry, []);
      solidByEntry.get(j.entry).push({ rgb: j.rgb, to: hexToRgb(colors[j.control]) });
    }
  }
  for (const entry of gaugeEntries) {
    const text = await zip.file(entry).async('string');
    const spec = barSpecs && (barSpecs[groupByEntry.get(entry)] || barSpecs.center);
    const { text: out } = recolorJson(text, solidByEntry.get(entry) || [], spec || null);
    zip.file(entry, out);
  }

  // 3) png overrides (tint / upload) — bytes prepared by caller.
  for (const [entry, bytes] of Object.entries(pngOverrides || {})) {
    zip.file(entry, bytes, { compression: 'STORE' });
  }

  const unsigned = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return signApkV1(unsigned, signing);
}
