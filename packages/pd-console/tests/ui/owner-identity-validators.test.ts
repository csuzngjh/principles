/**
 * ADR-0022 (PRI-578 PR-3-A review): owner identity API view validators.
 *
 * Behavioral tests over the production validators — the API view must carry
 * BOTH the resolved registration source AND the canonical governance
 * readiness snapshot. A payload without the governance snapshot (the old
 * shape that made Settings conflate "registered" with "governance ready")
 * must be REJECTED.
 */

import { describe, it, expect } from 'vitest';
import {
  validateOwnerIdentityView,
  validateOwnerIdentityRegister,
  validateOwnerIdentityUnregister,
} from '../../src/ui/utils/validators.js';

const governanceReady = { authenticationMode: 'authenticated', ownerIdentityConfiguration: 'configured' };
const governanceBlockedNoAuth = { authenticationMode: 'no_auth', ownerIdentityConfiguration: 'missing' };
const governanceBlockedIdentity = { authenticationMode: 'authenticated', ownerIdentityConfiguration: 'missing' };

function fileRecord() {
  return { schemaVersion: 1, ownerId: 'alice', credentialId: 'cred-1', registeredAt: '2026-08-29T00:00:00.000Z' };
}

describe('validateOwnerIdentityView — registration vs governance readiness states', () => {
  it('state 1: source=file + token auth enabled → validates as governance ready', () => {
    const out = validateOwnerIdentityView({ resolved: { ownerId: 'alice', credentialId: 'cred-1', source: 'file' }, fileRecord: fileRecord(), governance: governanceReady });
    expect(out).not.toBeNull();
    expect(out?.resolved.source).toBe('file');
    expect(out?.governance.ownerIdentityConfiguration).toBe('configured');
  });

  it('state 2: source=file + token auth disabled → registration exists but governance NOT configured', () => {
    const out = validateOwnerIdentityView({ resolved: { ownerId: 'alice', credentialId: 'cred-1', source: 'file' }, fileRecord: fileRecord(), governance: governanceBlockedNoAuth });
    expect(out).not.toBeNull();
    expect(out?.resolved.source).toBe('file');
    expect(out?.governance).toEqual(governanceBlockedNoAuth);
  });

  it('state 3: source=env + ready → validates', () => {
    const out = validateOwnerIdentityView({ resolved: { ownerId: 'env-owner', credentialId: 'env-cred', source: 'env' }, fileRecord: null, governance: governanceReady });
    expect(out).not.toBeNull();
    expect(out?.governance.ownerIdentityConfiguration).toBe('configured');
  });

  it('state 4: partial env → source invalid_env with diagnosable error, governance missing', () => {
    const out = validateOwnerIdentityView({
      resolved: { ownerId: null, credentialId: null, source: 'invalid_env', error: 'owner_identity_invalid_env: PD_OWNER_ID and PD_OWNER_CREDENTIAL_ID must be set together' },
      fileRecord: fileRecord(),
      governance: governanceBlockedIdentity,
    });
    expect(out).not.toBeNull();
    expect(out?.resolved.source).toBe('invalid_env');
    expect(out?.resolved.ownerId).toBeNull();
    expect(out?.resolved.error).toContain('owner_identity_invalid_env');
    expect(out?.governance.ownerIdentityConfiguration).toBe('missing');
  });

  it('state 5: none → not registered, governance missing', () => {
    const out = validateOwnerIdentityView({ resolved: { ownerId: null, credentialId: null, source: 'none' }, fileRecord: null, governance: governanceBlockedNoAuth });
    expect(out).not.toBeNull();
    expect(out?.resolved.source).toBe('none');
    expect(out?.governance.ownerIdentityConfiguration).toBe('missing');
  });

  it('state 6: file read failure → error surfaces (never a silent not-registered)', () => {
    const out = validateOwnerIdentityView({
      resolved: { ownerId: null, credentialId: null, source: 'none', error: 'owner_identity_read_failed: EACCES' },
      fileRecord: null,
      fileError: 'owner_identity_read_failed: EACCES',
      governance: governanceBlockedIdentity,
    });
    expect(out).not.toBeNull();
    expect(out?.resolved.error).toBe('owner_identity_read_failed: EACCES');
    expect(out?.fileError).toBe('owner_identity_read_failed: EACCES');
  });

  it('rejects the old shape without the governance snapshot (second-truth-source regression guard)', () => {
    expect(validateOwnerIdentityView({ resolved: { ownerId: 'a', credentialId: 'c', source: 'file' }, fileRecord: null })).toBeNull();
    expect(validateOwnerIdentityView({ resolved: { ownerId: null, credentialId: null, source: 'file' }, governance: { authenticationMode: 'authenticated', ownerIdentityConfiguration: 'bogus' } })).toBeNull();
  });

  it('rejects unknown sources and non-string identity fields', () => {
    expect(validateOwnerIdentityView({ resolved: { ownerId: null, credentialId: null, source: 'server' }, fileRecord: null, governance: governanceReady })).toBeNull();
    expect(validateOwnerIdentityView({ resolved: { ownerId: 5, credentialId: null, source: 'file' }, fileRecord: null, governance: governanceReady })).toBeNull();
  });
});

describe('validateOwnerIdentityRegister / validateOwnerIdentityUnregister — carry governance readiness', () => {
  it('register payload requires the governance snapshot', () => {
    expect(validateOwnerIdentityRegister({ source: 'file', record: fileRecord(), governance: governanceBlockedNoAuth })).not.toBeNull();
    expect(validateOwnerIdentityRegister({ source: 'file', record: fileRecord() })).toBeNull();
  });

  it('register payload can express "registered but governance not ready"', () => {
    const out = validateOwnerIdentityRegister({ source: 'file', record: fileRecord(), governance: governanceBlockedNoAuth });
    expect(out?.governance.ownerIdentityConfiguration).toBe('missing');
    expect(out?.governance.authenticationMode).toBe('no_auth');
  });

  it('unregister payload requires the governance snapshot', () => {
    expect(validateOwnerIdentityUnregister({ ok: true, source: 'none', governance: governanceBlockedNoAuth })).not.toBeNull();
    expect(validateOwnerIdentityUnregister({ ok: true, source: 'none' })).toBeNull();
  });
});
