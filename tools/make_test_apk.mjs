// make_test_apk.mjs — STEP 0 validation harness.
//
// Goal: prove a v1-only-signed overlay APK is accepted by the target device
// BEFORE building the rest of the web tool on that assumption.
//
// It zips an already-compiled build/apk/ directory (apktool 'b' has already run,
// so no Java is required here), signs it with the pure-JS v1 signer, and writes
// a ready-to-install APK plus the exact adb commands to deploy + verify it.
//
//   npm run gen-key        # once, to create the signing key
//   npm run make-test-apk  # produces dist-test/<name>.apk
//
// Then push it to the device, reboot, and confirm the overlay loads and recolors.
// If it does, v1 signing is validated and the rest of the pipeline is safe to build.

import JSZip from 'jszip';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { signApkV1 } from '../docs/lib/resign.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Which overlay to use for the smoke test. AccentColor is the simplest (just
// colors.xml -> resources.arsc), so it's the cleanest first proof.
const OVERLAY = process.argv[2] || 'AccentColorYamahaBlueOverlay';
const apkDir = join(root, OVERLAY, 'build', 'apk');
const deviceDir = process.argv[3] || 'AccentColorArcticCatGreen'; // /product/overlay subdir
const outName = `${OVERLAY}.test.apk`;

function walk(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, acc);
    else acc.push(full);
  }
  return acc;
}

const keyPem = readFileSync(join(root, 'docs', 'signing', 'key.pem'), 'utf8');
const certPem = readFileSync(join(root, 'docs', 'signing', 'cert.pem'), 'utf8');

// Build the unsigned zip from the compiled apk dir.
const zip = new JSZip();
const files = walk(apkDir);
for (const f of files) {
  const rel = relative(apkDir, f).split(sep).join('/');
  // resources.arsc and PNGs are stored uncompressed in real APKs (doNotCompress);
  // JSZip decompresses on read regardless, but we mirror it for correctness.
  const store = rel === 'resources.arsc' || rel.toLowerCase().endsWith('.png');
  zip.file(rel, readFileSync(f), store ? { compression: 'STORE' } : undefined);
}
const unsigned = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });

console.log(`Signing ${OVERLAY} (${files.length} entries, ${unsigned.length} bytes unsigned)...`);
const signed = await signApkV1(unsigned, { keyPem, certPem });

const outDir = join(root, 'dist-test');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, outName);
writeFileSync(outPath, signed);

console.log(`\nWrote ${relative(root, outPath)} (${signed.length} bytes)\n`);
console.log('--- Verify the signature (optional, needs Java) ---');
console.log(`  java -jar "<SDK>/build-tools/36.0.0/lib/apksigner.jar" verify --print-certs --v1-signing-enabled true "${outPath}"`);
console.log('\n--- Deploy to device (Step 0 acceptance test) ---');
console.log(`  adb push "${outPath}" /data/local/tmp/${outName}`);
console.log(`  adb shell su -c 'blockdev --setrw /dev/block/dm-2; mount -o remount,rw /; \\`);
console.log(`    cp /data/local/tmp/${outName} /product/overlay/${deviceDir}/${outName.replace('.test', '')}; \\`);
console.log(`    chmod 644 /product/overlay/${deviceDir}/*.apk; mount -o remount,ro /; blockdev --setro /dev/block/dm-2'`);
console.log(`  adb reboot`);
console.log('\nAfter reboot: confirm the overlay still loads (colors unchanged is fine —');
console.log('this only proves the JS v1 signature is ACCEPTED). If it loads, Step 0 passes.');
