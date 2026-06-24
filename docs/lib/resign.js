// resign.js — APK v1 (JAR) signing, portable across Node and browser.
//
// Why v1-only: the target is Android 10 system RROs dropped into /product/overlay
// on a rooted device. Signatures don't need to match any platform key (root), they
// only need to be a *valid, parseable* signature so PackageParser/OverlayManager
// will load the APK. v1 (JAR) signing is enough on API 29 and is implementable in
// pure JS; v2 (APK Signing Block) is not needed and is far harder client-side.
//
// IF a future device demands v2, this module is where that assumption breaks —
// see tools/make_test_apk.mjs + the README "Step 0" validation.
//
// Exports: signApkV1(zipBytes, { keyPem, certPem, createdBy }) -> Uint8Array
//
// Dependencies are imported by bare specifier so the same file works in Node
// (resolved from node_modules) and in the browser (resolved via an import map
// pointing at docs/vendor/*). See docs/index.html for the import map.

import JSZip from 'jszip';
import forge from 'node-forge';

const CRLF = '\r\n';
const DEFAULT_CREATED_BY = 'custom-theme-web (v1 jar signer)';

// Signature-related files we strip before re-signing.
const SIG_RE = /^META-INF\/.*\.(SF|RSA|DSA|EC)$/i;
const isManifest = (name) => name.toUpperCase() === 'META-INF/MANIFEST.MF';

// Uint8Array -> binary (latin1) string, in chunks. Doing it in one
// String.fromCharCode.apply(...) overflows the call stack on large entries in
// Chrome (e.g. the recolored tex_bg.png); chunking keeps each apply() small.
function bytesToBinary(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return s;
}

function sha256b64(bytes) {
  const md = forge.md.sha256.create();
  md.update(bytesToBinary(bytes)); // forge digests operate on binary strings
  return forge.util.encode64(md.digest().getBytes());
}

function strToBytes(str) {
  // manifests are ASCII/latin1; encode as raw bytes
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

// JAR manifest spec: lines wrap at 72 bytes including CRLF (= 70 content bytes),
// continuation lines begin with a single leading space. Digests in the .SF file
// are computed over these exact wrapped bytes, so wrapping must be deterministic.
function formatAttr(name, value) {
  let line = `${name}: ${value}`;
  let out = '';
  while (line.length > 70) {
    out += line.slice(0, 70) + CRLF + ' ';
    line = line.slice(70);
  }
  out += line + CRLF;
  return out;
}

function mainSection(versionAttr, createdBy) {
  return formatAttr(versionAttr, '1.0') + formatAttr('Created-By', createdBy) + CRLF;
}

function entrySection(name, digestB64) {
  return formatAttr('Name', name) + formatAttr('SHA-256-Digest', digestB64) + CRLF;
}

/**
 * Sign a zip (APK) with a v1 JAR signature.
 * @param {Uint8Array} zipBytes  raw bytes of the unsigned (or to-be-re-signed) APK
 * @param {{keyPem:string, certPem:string, createdBy?:string}} opts
 * @returns {Promise<Uint8Array>}
 */
export async function signApkV1(zipBytes, { keyPem, certPem, createdBy = DEFAULT_CREATED_BY }) {
  const zip = await JSZip.loadAsync(zipBytes);

  // Collect content entries in stable order, dropping any prior signature files.
  const names = [];
  zip.forEach((relPath, file) => {
    if (file.dir) return;
    if (isManifest(relPath) || SIG_RE.test(relPath)) return;
    names.push(relPath);
  });
  names.sort(); // deterministic output

  // --- MANIFEST.MF ---
  let manifest = mainSection('Manifest-Version', createdBy);
  // Map of entry name -> its manifest section text (needed for CERT.SF digests).
  const manifestSections = new Map();
  for (const name of names) {
    const content = await zip.file(name).async('uint8array');
    const section = entrySection(name, sha256b64(content));
    manifestSections.set(name, section);
    manifest += section;
  }
  const manifestBytes = strToBytes(manifest);

  // --- CERT.SF ---
  let sf = mainSection('Signature-Version', createdBy);
  // digest of the whole manifest file
  sf = sf.replace(
    /\r\n\r\n$/,
    CRLF + formatAttr('SHA-256-Digest-Manifest', sha256b64(manifestBytes)).trimEnd() + CRLF + CRLF
  );
  for (const name of names) {
    // .SF per-entry digest is over the entry's *section bytes* in the manifest
    sf += entrySection(name, sha256b64(strToBytes(manifestSections.get(name))));
  }
  const sfBytes = strToBytes(sf);

  // --- CERT.RSA (detached PKCS#7 over CERT.SF) ---
  const privateKey = forge.pki.privateKeyFromPem(keyPem);
  const certificate = forge.pki.certificateFromPem(certPem);
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(bytesToBinary(sfBytes));
  p7.addCertificate(certificate);
  p7.addSigner({
    key: privateKey,
    certificate,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime },
    ],
  });
  p7.sign({ detached: true });
  const rsaDer = forge.asn1.toDer(p7.toAsn1()).getBytes();
  const rsaBytes = strToBytes(rsaDer);

  // --- assemble signed zip ---
  zip.remove('META-INF/MANIFEST.MF');
  zip.forEach((relPath, file) => { if (SIG_RE.test(relPath) && !file.dir) zip.remove(relPath); });
  zip.file('META-INF/MANIFEST.MF', manifestBytes);
  zip.file('META-INF/CERT.SF', sfBytes);
  zip.file('META-INF/CERT.RSA', rsaBytes);

  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}
