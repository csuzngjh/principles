import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Force the Windows hardening path to fail: chmod still succeeds there, which
// is exactly the trap this test protects against.
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => {
    throw new Error('icacls failed');
  }),
}));

import { saveProviderApiKey } from '../pd-credentials.js';

const originalPlatform = process.platform;

describe('pd-credentials Windows permission honesty', () => {
  beforeAll(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('reports best_effort when icacls fails even though chmod succeeded', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cred-win-'));
    try {
      const result = saveProviderApiKey('WIN_FAIL_API_KEY', 'sk-win-fallback-9876', { homeDir });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.permissions).toBe('best_effort');

      const doc = fs.readFileSync(path.join(homeDir, '.pd', 'credentials.yaml'), 'utf8');
      expect(doc).toContain('filePermissions: best_effort');
      // No plaintext temp file is left behind next to the credentials file.
      const leftovers = fs
        .readdirSync(path.join(homeDir, '.pd'))
        .filter((name) => name.includes('.tmp-'));
      expect(leftovers).toEqual([]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
