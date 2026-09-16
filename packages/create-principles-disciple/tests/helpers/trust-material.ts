/**
 * Shared test trust material (PRI-732 / PRI-671): generates an ed25519
 * signing identity and builds self-signed TUF Roots in the exact shape the
 * release trust pipeline emits (one key signs root/timestamp/snapshot/targets,
 * version 1, spec 1.0.31 — same construction as
 * scripts/generate-trust-root.mjs and release-metadata-publisher.ts).
 */
import { createHash, createPublicKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { Key, Metadata, Root, Signature } from '@tufjs/models';

export const FAR_EXPIRY = '2036-01-01T00:00:00Z';

export interface TestTrustMaterial {
  readonly keyId: string;
  readonly privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  readonly privateKeyPem: string;
  readonly key: Key;
}

export function makeTrustMaterial(): TestTrustMaterial {
  const { privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  const keyId = createHash('sha256').update(publicKeyPem).digest('hex');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return {
    keyId,
    privateKey,
    privateKeyPem,
    key: new Key({ keyID: keyId, keyType: 'ed25519', scheme: 'ed25519', keyVal: { public: publicKeyPem } }),
  };
}

/** Build a self-signed TUF Root with the same shape the publisher/keygen emit. */
export function buildSignedRoot(material: TestTrustMaterial, expires: string): Buffer {
  const root = new Root({ version: 1, specVersion: '1.0.31', expires, consistentSnapshot: false });
  for (const role of ['root', 'timestamp', 'snapshot', 'targets']) root.addKey(material.key, role);
  const metadata = new Metadata(root);
  metadata.sign(
    (data) => new Signature({ keyID: material.keyId, sig: cryptoSign(null, data, material.privateKey).toString('hex') }),
    false,
  );
  return Buffer.from(JSON.stringify(metadata.toJSON()), 'utf8');
}
