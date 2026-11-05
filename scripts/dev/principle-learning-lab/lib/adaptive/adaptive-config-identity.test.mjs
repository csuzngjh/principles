import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptiveConfigIdentity } from './adaptive-config-identity.mjs';

const config = () => ({
  host: 'openclaw', hostVersion: '2026.10.10', runtimeMode: 'embedded',
  pluginVersion: '0.1', effectiveHookSetFingerprint: 'known-source-digest',
  evidenceCoverage: 'partial',
});

test('reordering fields preserves identity while every observed field change invalidates it', () => {
  const source = config();
  const original = structuredClone(source);
  const identity = adaptiveConfigIdentity(source);
  assert.equal(identity.digest, adaptiveConfigIdentity(Object.fromEntries(Object.entries(source).reverse())).digest);
  for (const key of ['hostVersion', 'runtimeMode', 'pluginVersion', 'effectiveHookSetFingerprint']) {
    assert.notEqual(identity.digest, adaptiveConfigIdentity({ ...source, [key]: source[key] + '-changed' }).digest);
  }
  assert.notEqual(identity.digest, adaptiveConfigIdentity({ ...source, host: 'codex' }).digest);
  assert.notEqual(identity.digest, adaptiveConfigIdentity({ ...source, evidenceCoverage: 'complete' }).digest);
  assert.deepEqual(source, original);
});

test('unknown and partial facts remain unknown and partial instead of becoming verified', () => {
  assert.equal(adaptiveConfigIdentity(config()).coverage, 'partial');
  assert.equal(adaptiveConfigIdentity({ ...config(), pluginVersion: 'unknown', evidenceCoverage: 'complete' }).coverage, 'unknown');
  assert.equal(adaptiveConfigIdentity({ ...config(), evidenceCoverage: 'unknown' }).coverage, 'unknown');
});

test('missing, inherited, accessor and extra fields cannot silently enter a snapshot', () => {
  assert.equal(adaptiveConfigIdentity(null), null);
  assert.equal(adaptiveConfigIdentity([]), null);
  assert.equal(adaptiveConfigIdentity({ ...config(), host: 'other' }), null);
  assert.equal(adaptiveConfigIdentity({ ...config(), evidenceCoverage: 'verified' }), null);
  assert.equal(adaptiveConfigIdentity({ ...config(), extraSource: 'not-accounted-for' }), null);
  assert.equal(adaptiveConfigIdentity(Object.create(config())), null);
  const source = config();
  delete source.hostVersion;
  assert.equal(adaptiveConfigIdentity(source), null);
  Object.defineProperty(source, 'hostVersion', { get() { throw new Error('must not invoke'); } });
  assert.equal(adaptiveConfigIdentity(source), null);
});
