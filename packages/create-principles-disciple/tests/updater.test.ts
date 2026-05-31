import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkForUpdates, fetchChangelog } from '../src/updater.js';

describe('checkForUpdates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('should return hasUpdate false when current version is latest', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: '1.73.0' }),
    }));

    const result = await checkForUpdates('1.73.0');
    expect(result.hasUpdate).toBe(false);
    expect(result.currentVersion).toBe('1.73.0');
    expect(result.error).toBeUndefined();
  });

  it('should return hasUpdate true when newer version exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: '1.74.0' }),
    }));

    const result = await checkForUpdates('1.73.0');
    expect(result.hasUpdate).toBe(true);
    expect(result.latestVersion).toBe('1.74.0');
  });

  it('should handle network errors gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const result = await checkForUpdates('1.73.0');
    expect(result.hasUpdate).toBe(false);
    expect(result.error).toBe('Network error');
  });

  it('should handle HTTP errors gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
    }));
    const result = await checkForUpdates('1.73.0');
    expect(result.hasUpdate).toBe(false);
    expect(result.error).toContain('HTTP 429');
  });

  it('should handle invalid registry response gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ name: 'foo' }),
    }));
    const result = await checkForUpdates('1.73.0');
    expect(result.hasUpdate).toBe(false);
    expect(result.error).toContain('missing version');
  });
});

describe('fetchChangelog', () => {
  it('should fetch changelog for a specific version', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        versions: {
          '1.74.0': {
            version: '1.74.0',
            description: 'Bug fixes and improvements',
          },
        },
      }),
    }));

    const result = await fetchChangelog('1.74.0');
    expect(result).toBe('Bug fixes and improvements');
  });

  it('should handle missing changelog gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        versions: {
          '1.74.0': {
            version: '1.74.0',
          },
        },
      }),
    }));

    const result = await fetchChangelog('1.74.0');
    expect(result).toBeUndefined();
  });
});
