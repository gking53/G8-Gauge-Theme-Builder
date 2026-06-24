// gen_key.mjs — generate the public signing key used by the in-browser signer.
//
// This key is intentionally PUBLIC and committed to the repo. On a rooted device
// the overlay signature does not need to match any platform key; it only needs to
// be a valid signature. Anyone building a theme uses this same key. Run once:
//
//   npm run gen-key
//
// Writes docs/signing/key.pem (PKCS#8 private) and docs/signing/cert.pem (X.509).

import forge from 'node-forge';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'docs', 'signing');
mkdirSync(outDir, { recursive: true });

console.log('Generating RSA-2048 keypair (this is a few seconds)...');
const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });

const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = '01';
// Validity must be far in the future; jarsigner-style certs use 25-30y.
// We avoid Date.now() determinism concerns by fixing explicit dates.
cert.validity.notBefore = new Date('2020-01-01T00:00:00Z');
cert.validity.notAfter = new Date('2070-01-01T00:00:00Z');
const attrs = [
  { name: 'commonName', value: 'Custom Theme Community Key' },
  { name: 'organizationName', value: 'Custom Theme Web' },
];
cert.setSubject(attrs);
cert.setIssuer(attrs); // self-signed
cert.sign(keys.privateKey, forge.md.sha256.create());

const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
const certPem = forge.pki.certificateToPem(cert);

writeFileSync(join(outDir, 'key.pem'), keyPem);
writeFileSync(join(outDir, 'cert.pem'), certPem);

console.log('Wrote:');
console.log('  docs/signing/key.pem');
console.log('  docs/signing/cert.pem');
console.log('\nThis key is public by design — see header comment.');
