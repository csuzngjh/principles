import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OWNER_IDENTITY_SCHEMA_VERSION,
  resolveOwnerIdentity,
  readOwnerIdentityFile,
  writeOwnerIdentityFile,
  deleteOwnerIdentityFile,
  ownerIdentityFilePath,
} from '../owner-identity.js';

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'pd-owner-id-'));
}

function seedOwnerFile(homeDir: string, content: string): void {
  mkdirSync(join(homeDir, '.pd'), { recursive: true });
  writeFileSync(join(homeDir, '.pd', 'owner.json'), content, 'utf8');
}

describe('resolveOwnerIdentity — env > file > none (ADR-0022)', () => {
  it('env wins when both PD_OWNER_ID and PD_OWNER_CREDENTIAL_ID are set', () => {
    const home = tempHome();
    seedOwnerFile(home, JSON.stringify({ schemaVersion: 1, ownerId: 'file-owner', credentialId: 'file-cred', registeredAt: 'x' }));
    const resolved = resolveOwnerIdentity(
      { PD_OWNER_ID: '  env-owner ', PD_OWNER_CREDENTIAL_ID: 'env-cred' },
      home,
    );
    expect(resolved).toEqual({ ownerId: 'env-owner', credentialId: 'env-cred', source: 'env' });
  });

  it('falls back to ~/.pd/owner.json when env is absent', () => {
    const home = tempHome();
    seedOwnerFile(home, JSON.stringify({ schemaVersion: 1, ownerId: 'file-owner', credentialId: 'file-cred', registeredAt: '2026-08-29T00:00:00.000Z' }));
    const resolved = resolveOwnerIdentity({}, home);
    expect(resolved).toEqual({ ownerId: 'file-owner', credentialId: 'file-cred', source: 'file' });
  });

  it('partial env (one var only) falls through to the file', () => {
    const home = tempHome();
    seedOwnerFile(home, JSON.stringify({ schemaVersion: 1, ownerId: 'file-owner', credentialId: 'file-cred', registeredAt: 'x' }));
    const resolved = resolveOwnerIdentity({ PD_OWNER_ID: 'only-id' }, home);
    expect(resolved.source).toBe('file');
  });

  it('returns none when neither env nor file provides a complete identity', () => {
    const home = tempHome();
    expect(resolveOwnerIdentity({}, home)).toEqual({ ownerId: null, credentialId: null, source: 'none' });
    expect(resolveOwnerIdentity({ PD_OWNER_ID: 'only-id' }, home).source).toBe('none');
  });

  it('a malformed owner.json does not poison resolution — falls through to none', () => {
    const home = tempHome();
    seedOwnerFile(home, 'not json');
    const resolved = resolveOwnerIdentity({}, home);
    expect(resolved.source).toBe('none');
    expect(readOwnerIdentityFile(home).error).toBeDefined();
  });
});

describe('readOwnerIdentityFile', () => {
  it('absent file is a valid not-registered state (no error)', () => {
    const home = tempHome();
    expect(readOwnerIdentityFile(home)).toEqual({ record: null });
  });

  it('rejects unsupported schemaVersion', () => {
    const home = tempHome();
    seedOwnerFile(home, JSON.stringify({ schemaVersion: 99, ownerId: 'o', credentialId: 'c' }));
    const result = readOwnerIdentityFile(home);
    expect(result.record).toBeNull();
    expect(result.error).toContain('owner_identity_unsupported_version');
  });

  it('rejects missing/empty fields', () => {
    const home = tempHome();
    seedOwnerFile(home, JSON.stringify({ schemaVersion: 1, ownerId: '', credentialId: 'c' }));
    expect(readOwnerIdentityFile(home).error).toContain('owner_identity_malformed');
  });
});

describe('writeOwnerIdentityFile / deleteOwnerIdentityFile — round trip', () => {
  it('writes, re-reads and deletes cleanly', () => {
    const home = tempHome();
    const write = writeOwnerIdentityFile(home, { ownerId: '  alice ', credentialId: 'cred-1' });
    expect(write.ok).toBe(true);
    if (!write.ok) return;
    expect(write.record.schemaVersion).toBe(OWNER_IDENTITY_SCHEMA_VERSION);
    expect(write.record.ownerId).toBe('alice');
    expect(write.record.credentialId).toBe('cred-1');
    expect(write.record.registeredAt).not.toBe('');

    const read = readOwnerIdentityFile(home);
    expect(read.record?.ownerId).toBe('alice');
    expect(existsSync(ownerIdentityFilePath(home))).toBe(true);

    expect(deleteOwnerIdentityFile(home).ok).toBe(true);
    expect(readOwnerIdentityFile(home).record).toBeNull();
    // idempotent delete (absent file) is a no-op success
    expect(deleteOwnerIdentityFile(home).ok).toBe(true);
  });

  it('rejects empty input', () => {
    const home = tempHome();
    expect(writeOwnerIdentityFile(home, { ownerId: ' ', credentialId: 'cred' }).ok).toBe(false);
    expect(writeOwnerIdentityFile(home, { ownerId: 'o', credentialId: '' }).ok).toBe(false);
  });

  it('does not create the file when input is invalid', () => {
    const home = tempHome();
    writeOwnerIdentityFile(home, { ownerId: '', credentialId: '' });
    expect(existsSync(ownerIdentityFilePath(home))).toBe(false);
  });
});
