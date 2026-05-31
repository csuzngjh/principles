import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkForUpdates, fetchChangelog, applyUpdate, computeDiff } from '../src/updater.js';

// Module-level mocks (hoisted to top by vitest)
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue(JSON.stringify({ version: '1.0.0' })),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

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

describe('applyUpdate', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();

    // Reconfigure fs mocks to defaults after clearAllMocks
    const fs = await import('fs');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ version: '1.0.0' }));
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);

    // Mock fetch for network calls (fetchLatestPackageInfo + downloadPackage)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        version: '1.74.0',
        dist: { tarball: 'https://registry.npmjs.org/create-principles-disciple/-/create-principles-disciple-1.74.0.tgz' },
      }),
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
  });

  it('should apply update with smart merge strategy', async () => {
    const result = await applyUpdate({
      targetDir: '/tmp/target',
      backupDir: '/tmp/backup',
      mergeStrategy: 'smart',
    });

    expect(result.success).toBe(true);
  });

  it('should apply update with overwrite strategy', async () => {
    const result = await applyUpdate({
      targetDir: '/tmp/target',
      backupDir: '/tmp/backup',
      mergeStrategy: 'overwrite',
    });

    expect(result.success).toBe(true);
  });

  it('should apply update with keep strategy', async () => {
    const result = await applyUpdate({
      targetDir: '/tmp/target',
      backupDir: '/tmp/backup',
      mergeStrategy: 'keep',
    });

    expect(result.success).toBe(true);
  });

  it('should include updated files in result on success', async () => {
    const result = await applyUpdate({
      targetDir: '/tmp/target',
      backupDir: '/tmp/backup',
      mergeStrategy: 'overwrite',
    });

    expect(result.success).toBe(true);
    expect(result.updatedFiles).toBeDefined();
    expect(Array.isArray(result.updatedFiles)).toBe(true);
  });

  it('should return error when fetch fails', async () => {
    // Override fetch mock for this test
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }));

    const result = await applyUpdate({
      targetDir: '/tmp/target',
      backupDir: '/tmp/backup',
      mergeStrategy: 'smart',
    });

    expect(result.success).toBe(false);
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

describe('computeDiff', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const fs = await import('fs');
    vi.mocked(fs.readFileSync).mockReturnValue('');
    vi.mocked(fs.existsSync).mockReturnValue(true);
  });

  it('should detect modified files', async () => {
    const fs = await import('fs');
    vi.mocked(fs.readdirSync).mockImplementation(((dir: unknown) => {
      const dirStr = String(dir);
      if (dirStr.includes('current')) {
        return [{ name: 'file1.txt', isDirectory: () => false }] as any;
      }
      if (dirStr.includes('new')) {
        return [{ name: 'file1.txt', isDirectory: () => false }] as any;
      }
      return [] as any;
    }) as any);

    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce('old content')
      .mockReturnValueOnce('new content');

    const result = await computeDiff('/tmp/current', '/tmp/new');
    expect(result.modified).toEqual(['file1.txt']);
    expect(result.added).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  it('should detect added files', async () => {
    const fs = await import('fs');
    vi.mocked(fs.readdirSync).mockImplementation(((dir: unknown) => {
      const dirStr = String(dir);
      if (dirStr.includes('current')) {
        return [] as any;
      }
      if (dirStr.includes('new')) {
        return [{ name: 'file2.txt', isDirectory: () => false }] as any;
      }
      return [] as any;
    }) as any);

    const result = await computeDiff('/tmp/current', '/tmp/new');
    expect(result.modified).toEqual([]);
    expect(result.added).toEqual(['file2.txt']);
    expect(result.deleted).toEqual([]);
  });

  it('should detect deleted files', async () => {
    const fs = await import('fs');
    vi.mocked(fs.readdirSync).mockImplementation(((dir: unknown) => {
      const dirStr = String(dir);
      if (dirStr.includes('current')) {
        return [{ name: 'old.txt', isDirectory: () => false }] as any;
      }
      if (dirStr.includes('new')) {
        return [] as any;
      }
      return [] as any;
    }) as any);

    const result = await computeDiff('/tmp/current', '/tmp/new');
    expect(result.modified).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.deleted).toEqual(['old.txt']);
  });

  it('should detect no changes when files are identical', async () => {
    const fs = await import('fs');
    vi.mocked(fs.readdirSync).mockImplementation(((dir: unknown) => {
      const dirStr = String(dir);
      if (dirStr.includes('current')) {
        return [{ name: 'same.txt', isDirectory: () => false }] as any;
      }
      if (dirStr.includes('new')) {
        return [{ name: 'same.txt', isDirectory: () => false }] as any;
      }
      return [] as any;
    }) as any);

    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce('identical content')
      .mockReturnValueOnce('identical content');

    const result = await computeDiff('/tmp/current', '/tmp/new');
    expect(result.modified).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  it('should handle mixed changes', async () => {
    const fs = await import('fs');
    vi.mocked(fs.readdirSync).mockImplementation(((dir: unknown) => {
      const dirStr = String(dir);
      if (dirStr.includes('current')) {
        return [
          { name: 'same.txt', isDirectory: () => false },
          { name: 'modified.txt', isDirectory: () => false },
          { name: 'deleted.txt', isDirectory: () => false },
        ] as any;
      }
      if (dirStr.includes('new')) {
        return [
          { name: 'same.txt', isDirectory: () => false },
          { name: 'modified.txt', isDirectory: () => false },
          { name: 'added.txt', isDirectory: () => false },
        ] as any;
      }
      return [] as any;
    }) as any);

    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce('same content')   // current/same.txt
      .mockReturnValueOnce('same content')   // new/same.txt
      .mockReturnValueOnce('old version')    // current/modified.txt
      .mockReturnValueOnce('new version');   // new/modified.txt

    const result = await computeDiff('/tmp/current', '/tmp/new');
    expect(result.modified).toEqual(['modified.txt']);
    expect(result.added).toEqual(['added.txt']);
    expect(result.deleted).toEqual(['deleted.txt']);
  });

  it('should handle empty directories', async () => {
    const fs = await import('fs');
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    const result = await computeDiff('/tmp/current', '/tmp/new');
    expect(result.modified).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.deleted).toEqual([]);
  });
});
