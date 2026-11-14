import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteProviderApiKey,
  getCredentialStatus,
  isValidCredentialEnvName,
  maskCredentialValue,
  pdProviderCredentials,
  redactSecretsFromText,
  resolveProviderApiKey,
  saveProviderApiKey,
} from '../pd-credentials.js';

describe('pd-credentials (PRI-1213)', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), 'pd-credentials-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('returns env first and never reads the file when env is set', () => {
    saveProviderApiKey('DEEPSEEK_API_KEY', 'from-file-key', { homeDir });
    const resolved = resolveProviderApiKey('DEEPSEEK_API_KEY', {
      homeDir,
      env: { DEEPSEEK_API_KEY: 'from-env-key' },
    });
    expect(resolved).toEqual({ value: 'from-env-key', source: 'env' });
  });

  it('falls back to the local file when env is missing or empty', () => {
    expect(saveProviderApiKey('DEEPSEEK_API_KEY', 'file-key-123456', { homeDir }).ok).toBe(true);
    expect(
      resolveProviderApiKey('DEEPSEEK_API_KEY', { homeDir, env: {} }),
    ).toEqual({ value: 'file-key-123456', source: 'file' });
    expect(
      resolveProviderApiKey('DEEPSEEK_API_KEY', {
        homeDir,
        env: { DEEPSEEK_API_KEY: '   ' },
      }),
    ).toEqual({ value: 'file-key-123456', source: 'file' });
  });

  it('reports status with a server-side last4 mask and never the key', () => {
    saveProviderApiKey('OPENAI_API_KEY', 'sk-abcdefghijklmnop', { homeDir });
    const status = getCredentialStatus('OPENAI_API_KEY', { homeDir, env: {} });
    expect(status).toEqual({ configured: true, source: 'file', last4: 'mnop' });
    expect(JSON.stringify(status)).not.toContain('sk-abcdefghijklmnop');
  });

  it('does not invent a mask for short values', () => {
    expect(maskCredentialValue('short')).toBeUndefined();
    expect(maskCredentialValue('12345678')).toBe('5678');
  });

  it('writes a round-trippable YAML file and restricts POSIX permissions', () => {
    const saved = saveProviderApiKey('MOONSHOT_API_KEY', 'moonshot-key-value', { homeDir });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const raw = readFileSync(saved.filePath, 'utf8');
    expect(raw).toContain('schemaVersion: 1');
    expect(raw).toContain('MOONSHOT_API_KEY');
    if (process.platform !== 'win32') {
      expect(statSync(saved.filePath).mode & 0o777).toBe(0o600);
    }
    expect(['restricted', 'best_effort']).toContain(saved.permissions);
  });

  it('keeps other entries when deleting one key', () => {
    saveProviderApiKey('A_API_KEY', 'aaaaaaaa-key', { homeDir });
    saveProviderApiKey('B_API_KEY', 'bbbbbbbb-key', { homeDir });
    const deleted = deleteProviderApiKey('A_API_KEY', { homeDir });
    expect(deleted).toEqual(expect.objectContaining({ ok: true, removed: true }));
    expect(resolveProviderApiKey('A_API_KEY', { homeDir, env: {} }).value).toBeNull();
    expect(resolveProviderApiKey('B_API_KEY', { homeDir, env: {} }).value).toBe('bbbbbbbb-key');
  });

  it('fails loud on a malformed file and refuses to overwrite it', () => {
    const dir = path.join(homeDir, '.pd');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'credentials.yaml'), 'credentials: [not-a-map]', 'utf8');

    const resolved = resolveProviderApiKey('DEEPSEEK_API_KEY', { homeDir, env: {} });
    expect(resolved.value).toBeNull();
    expect(resolved.error).toContain('credentials_malformed');

    const saved = saveProviderApiKey('DEEPSEEK_API_KEY', 'new-key-value', { homeDir });
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.error).toContain('refusing to overwrite');
  });

  it('rejects invalid env names and control characters without echoing the key', () => {
    expect(isValidCredentialEnvName('BAD-NAME')).toBe(false);
    expect(saveProviderApiKey('BAD-NAME', 'x', { homeDir }).ok).toBe(false);
    const withNewline = saveProviderApiKey('DEEPSEEK_API_KEY', 'abc\ndef', { homeDir });
    expect(withNewline.ok).toBe(false);
    if (!withNewline.ok) expect(withNewline.error).not.toContain('abc');
  });

  it('redacts the key, bearer tokens and sk- shapes from upstream text', () => {
    const redacted = redactSecretsFromText(
      'Incorrect API key provided: super-secret-key. Header: Bearer abcdef1234567890. Also sk-abcdefghijk',
      ['super-secret-key'],
    );
    expect(redacted).not.toContain('super-secret-key');
    expect(redacted).not.toContain('abcdef1234567890');
    expect(redacted).not.toContain('sk-abcdefghijk');
    expect(redacted).toContain('[REDACTED]');
  });

  it('exposes the same behaviour through the public facade', () => {
    saveProviderApiKey('ZAI_API_KEY', 'zai-key-value', { homeDir });
    expect(
      pdProviderCredentials.resolve('ZAI_API_KEY', { homeDir, env: {} }),
    ).toEqual({ value: 'zai-key-value', source: 'file' });
  });
});
