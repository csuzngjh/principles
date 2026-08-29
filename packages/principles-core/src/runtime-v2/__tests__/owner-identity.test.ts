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

  it('CASE C: only PD_OWNER_ID set + valid file → NOT the file owner (fail-closed invalid_env)', () => {
    const home = tempHome();
    seedOwnerFile(home, JSON.stringify({ schemaVersion: 1, ownerId: 'file-owner', credentialId: 'file-cred', registeredAt: 'x' }));
    const resolved = resolveOwnerIdentity({ PD_OWNER_ID: 'only-id' }, home);
    expect(resolved.source).toBe('invalid_env');
    expect(resolved.ownerId).toBeNull();
    expect(resolved.credentialId).toBeNull();
    expect(resolved.error).toContain('owner_identity_invalid_env');
  });

  it('CASE D: only PD_OWNER_CREDENTIAL_ID set + valid file → NOT the file owner (fail-closed invalid_env)', () => {
    const home = tempHome();
    seedOwnerFile(home, JSON.stringify({ schemaVersion: 1, ownerId: 'file-owner', credentialId: 'file-cred', registeredAt: 'x' }));
    const resolved = resolveOwnerIdentity({ PD_OWNER_CREDENTIAL_ID: 'only-cred' }, home);
    expect(resolved.source).toBe('invalid_env');
    expect(resolved.ownerId).toBeNull();
    expect(resolved.credentialId).toBeNull();
  });

  it('CASE E: an env key set but empty/whitespace is an invalid override attempt (no file fallback)', () => {
    const home = tempHome();
    seedOwnerFile(home, JSON.stringify({ schemaVersion: 1, ownerId: 'file-owner', credentialId: 'file-cred', registeredAt: 'x' }));
    for (const env of [
      { PD_OWNER_ID: '' },
      { PD_OWNER_ID: '   ' },
      { PD_OWNER_ID: '', PD_OWNER_CREDENTIAL_ID: '' },
      { PD_OWNER_ID: 'o', PD_OWNER_CREDENTIAL_ID: ' ' },
      { PD_OWNER_ID: 'o', PD_OWNER_CREDENTIAL_ID: undefined },
    ]) {
      const resolved = resolveOwnerIdentity(env, home);
      expect(resolved.source, JSON.stringify(env)).toBe('invalid_env');
      expect(resolved.ownerId, JSON.stringify(env)).toBeNull();
      expect(resolved.credentialId, JSON.stringify(env)).toBeNull();
    }
  });

  it('CASE C/D: partial env without any file → invalid/missing, not none-silent', () => {
    const home = tempHome();
    const resolved = resolveOwnerIdentity({ PD_OWNER_ID: 'only-id' }, home);
    expect(resolved.source).toBe('invalid_env');
    expect(resolved.error).toContain('owner_identity_invalid_env');
  });

  it('returns none when neither env nor file provides a complete identity', () => {
    const home = tempHome();
    expect(resolveOwnerIdentity({}, home)).toEqual({ ownerId: null, credentialId: null, source: 'none' });
  });

  it('a file read failure surfaces a diagnosable error instead of a clean none', () => {
    const home = tempHome();
    // Non-ENOENT failure, simulated portably via a directory at the file path
    // (reading a directory fails with EISDIR on POSIX; on Windows the fs read
    // path rejects directories as well). No chmod-dependence.
    mkdirSync(join(home, '.pd', 'owner.json'), { recursive: true });
    const resolved = resolveOwnerIdentity({}, home);
    expect(resolved.source).toBe('none');
    expect(resolved.ownerId).toBeNull();
    expect(resolved.credentialId).toBeNull();
    expect(resolved.error).toContain('owner_identity_read_failed');
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

  it('a non-ENOENT read failure is an error, never a silent not-registered', () => {
    const home = tempHome();
    // Directory at the file path → EISDIR on both POSIX and Windows
    // (chmod-based EACCES simulation is not cross-platform stable).
    mkdirSync(join(home, '.pd', 'owner.json'), { recursive: true });
    const result = readOwnerIdentityFile(home);
    expect(result.record).toBeNull();
    expect(result.error).toContain('owner_identity_read_failed');
    expect(result.error).not.toContain('file-owner');
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
