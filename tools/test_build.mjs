// test_build.mjs — end-to-end pipeline proof for a chosen base/overlay (no browser).
//   node tools/test_build.mjs [base] [overlayKey]
// Default: arcticcat VehicleCluster (richest: arsc + AXML + vector logo + JSON).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildApk } from '../docs/lib/patch.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] || 'arcticcat';
const key = process.argv[3] || 'VehicleCluster';

const manifest = JSON.parse(readFileSync(join(root, 'docs', 'offsets.json'), 'utf8'));
const apk = manifest.bases[base].apks[key];
const signing = {
  keyPem: readFileSync(join(root, 'docs', 'signing', 'key.pem'), 'utf8'),
  certPem: readFileSync(join(root, 'docs', 'signing', 'cert.pem'), 'utf8'),
};
const template = readFileSync(join(root, 'docs', apk.file));

// Distinct test colors, easy to spot when decompiled.
const colors = { primary: '#ff8800', background: '#220033', logo: '#ff00ff', susp: '#00ffff' };
const barSpec = { mode: 'single', c1: [255, 136, 0] };  // bar = shades of orange

const signed = await buildApk(template, apk, colors, {}, signing, barSpec);
mkdirSync(join(root, 'dist-test'), { recursive: true });
const out = join(root, 'dist-test', `${base}-${key}.built.apk`);
writeFileSync(out, signed);
console.log(`Wrote ${out} (${signed.length} bytes)`);
console.log(`base=${base} key=${key} package=${apk.package}`);
console.log(`int_patches=${apk.int_patches.length} json_replace=${apk.json_replace.length}`);
