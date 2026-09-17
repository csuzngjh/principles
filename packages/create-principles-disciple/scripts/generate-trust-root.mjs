#!/usr/bin/env node

/**
 * Trust root key ceremony (PRI-732).
 *
 * Generates the ed25519 release signing key pair and writes:
 *   1. the PUBLIC pinned trust root  -> packages/create-principles-disciple/trust/root.json
 *      (committed to the repository; shipped in the npm package and the
 *      self-contained release asset; provisioned by the installer into the
 *      installation's trust/root.json);
 *   2. the PRIVATE signing key        -> --private-key-output <path>
 *      (NEVER inside the repository or the package; belongs only in the
 *      PD_RELEASE_SIGNING_KEY GitHub secret once configured).
 *
 * The root matches the publisher's trust shape exactly (one ed25519 key
 * signs root/timestamp/snapshot/targets, version 1, spec 1.0.31 — see
 * src/update/release-metadata-publisher.ts). Deterministic: the same private
 * key and expiry always re-emit identical root.json bytes.
 *
 * Usage:
 *   node scripts/generate-trust-root.mjs --private-key-output <absolute-path-outside-repo> [--expires <RFC3339-UTC>]
 */

import { createHash, createPublicKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Key, Metadata, Root, Signature } from '@tufjs/models';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');
const TRUST_ROOT_PATH = resolve(PACKAGE_ROOT, 'trust', 'root.json');

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new Error(`Option ${name} requires a value`);
  }
  return value;
}

const RFC3339_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const expires = readOption('--expires') ?? '2036-09-15T00:00:00Z';
if (!RFC3339_UTC_PATTERN.test(expires) || Number.isNaN(Date.parse(expires)) || Date.parse(expires) <= Date.now()) {
  throw new Error(`--expires must be a future RFC3339 UTC timestamp (e.g. 2036-09-15T00:00:00Z), got: ${JSON.stringify(expires)}`);
}

const privateKeyOutput = readOption('--private-key-output');
if (privateKeyOutput === undefined) {
  throw new Error('Usage: generate-trust-root.mjs --private-key-output <absolute-path-outside-repository> [--expires <RFC3339-UTC>]');
}
const privateKeyOutputPath = resolve(privateKeyOutput);
if (!isAbsolute(privateKeyOutput)) {
  throw new Error(`--private-key-output must be an absolute path, got: ${JSON.stringify(privateKeyOutput)}`);
}
// The private key must never live inside the repository or the package.
if (privateKeyOutputPath === REPO_ROOT || privateKeyOutputPath.startsWith(REPO_ROOT + sep)) {
  throw new Error(`Refusing to write the private signing key inside the repository (${privateKeyOutputPath}). Point --private-key-output at a location outside ${REPO_ROOT}.`);
}
// Atomic ceremony creation: the non-force write uses the exclusive-create
// flag (`wx`) so neither the trust root nor the private key can EVER be
// silently overwritten by a race between an existence check and the write
// (the old check-then-write TOCTOU). `wx` raises EEXIST, mapped back to the
// governance errors below. `--force` keeps the explicit, conscious rotation
// semantics with plain `w`.
const forceRotation = process.argv.includes('--force');
// Pre-flight refusal BEFORE any write (zero side effects on the common
// re-run path — including not leaving stray private key material). The `wx`
// flags below remain as the race backstops.
if (!forceRotation && existsSync(TRUST_ROOT_PATH)) {
  throw new Error(`A pinned trust root already exists (${TRUST_ROOT_PATH}). Re-running the ceremony REPLACES the trust anchor every install already pinned — rotation requires an explicit governance decision. Pass --force only for that decision.`);
}
if (!forceRotation && existsSync(privateKeyOutputPath)) {
  throw new Error(`A private signing key already exists at ${privateKeyOutputPath}. Overwriting it can destroy the key behind the currently pinned trust root. Move it aside (or store it in the PD_RELEASE_SIGNING_KEY secret and delete it) and re-run, or pass --force only as an explicit governance decision.`);
}
function writePinnedRoot(bytes) {
  try {
    writeFileSync(TRUST_ROOT_PATH, bytes, { encoding: 'utf8', flag: forceRotation ? 'w' : 'wx' });
  } catch (error) {
    if (!forceRotation && error?.code === 'EEXIST') {
      throw new Error(`A pinned trust root already exists (${TRUST_ROOT_PATH}). Re-running the ceremony REPLACES the trust anchor every install already pinned — rotation requires an explicit governance decision. Pass --force only for that decision.`);
    }
    throw error;
  }
}
// Same exclusive-create discipline for the private key (review 2026-09-17):
// silently overwriting it could destroy the key behind the CURRENTLY pinned
// trust root.
function writePrivateKey(pem) {
  try {
    writeFileSync(privateKeyOutputPath, pem, { encoding: 'utf8', flag: forceRotation ? 'w' : 'wx' });
  } catch (error) {
    if (!forceRotation && error?.code === 'EEXIST') {
      throw new Error(`A private signing key already exists at ${privateKeyOutputPath}. Overwriting it can destroy the key behind the currently pinned trust root. Move it aside (or store it in the PD_RELEASE_SIGNING_KEY secret and delete it) and re-run, or pass --force only as an explicit governance decision.`);
    }
    throw error;
  }
}

const { privateKey } = generateKeyPairSync('ed25519');
const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
const keyId = createHash('sha256').update(publicPem).digest('hex');

const key = new Key({ keyID: keyId, keyType: 'ed25519', scheme: 'ed25519', keyVal: { public: publicPem } });
const root = new Root({ version: 1, specVersion: '1.0.31', expires, consistentSnapshot: false });
for (const role of ['root', 'timestamp', 'snapshot', 'targets']) root.addKey(key, role);

const metadata = new Metadata(root);
metadata.sign(
  (data) => new Signature({ keyID: keyId, sig: cryptoSign(null, data, privateKey).toString('hex') }),
  false,
);
const rootBytes = `${JSON.stringify(metadata.toJSON(), null, 2)}\n`;

// Private key FIRST, then the root: with the pre-flight above the common
// refusal path already returned, so these writes only fail on a race — and
// in that race the committed trust anchor (what installs consume) is only
// ever touched when the key write has succeeded.
mkdirSync(dirname(privateKeyOutputPath), { recursive: true });
writePrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' }));

mkdirSync(dirname(TRUST_ROOT_PATH), { recursive: true });
writePinnedRoot(rootBytes);

console.log(`Pinned trust root written: ${TRUST_ROOT_PATH}`);
console.log(`  keyId:  ${keyId}`);
console.log(`  expires: ${expires}`);
console.log(`Private signing key written: ${privateKeyOutputPath}`);
console.log('NEXT STEPS (Owner):');
console.log('  1. Store the private key as the GitHub secret PD_RELEASE_SIGNING_KEY');
console.log('     (Repository Settings → Secrets and variables → Actions).');
console.log('  2. Delete the local private key file after storing the secret.');
console.log('  3. Release metadata publish mode now verifies against this pinned root.');
console.log('The private key must NEVER be committed, shipped, or logged.');
