import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import { validateWorkspacePath, verifyNativeModules, rebuildNativeModules, checkBuiltPlugin, ensureConversationAccess, install } from '../src/installer.js';
import { checkOpenClawGateway, stopOpenClawGateway, restartOpenClawGateway } from '../src/utils/env.js';
import { setLanguage } from '../src/i18n.js';
import type { InstallOptions } from '../src/prompts.js';

vi.mock('fs');
vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => Buffer.from('')),
  execSync: vi.fn(() => Buffer.from('')),
}));
// Control the gateway detection + service-control helpers without spawning real
// processes. Spread importOriginal so other env exports (detectWorkspace, etc.)
// used elsewhere stay intact.
vi.mock('../src/utils/env.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    checkOpenClawGateway: vi.fn(),
    stopOpenClawGateway: vi.fn(),
    restartOpenClawGateway: vi.fn(),
  };
});

describe('validateWorkspacePath security guard', () => {
  it('accepts path within workspace', () => {
    const workspace = '/home/user/workspace';
    const target = '/home/user/workspace/file.md';
    expect(() => validateWorkspacePath(target, workspace)).not.toThrow();
  });

  it('accepts workspace root itself', () => {
    const workspace = '/home/user/workspace';
    expect(() => validateWorkspacePath(workspace, workspace)).not.toThrow();
  });

  it('rejects path traversal with ..', () => {
    const workspace = '/home/user/workspace';
    const maliciousPath = '/home/user/workspace/../etc/passwd';
    expect(() => validateWorkspacePath(maliciousPath, workspace)).toThrow(/Security error/);
  });

  it('rejects path outside workspace', () => {
    const workspace = '/home/user/workspace';
    const outsidePath = '/home/otheruser/file';
    expect(() => validateWorkspacePath(outsidePath, workspace)).toThrow(/Security error/);
  });

  it('rejects absolute path traversal', () => {
    const workspace = '/home/user/workspace';
    const maliciousPath = '/etc/passwd';
    expect(() => validateWorkspacePath(maliciousPath, workspace)).toThrow(/Security error/);
  });

  it('handles trailing separators correctly', () => {
    const workspace = '/home/user/workspace/';
    const target = '/home/user/workspace/file.md';
    expect(() => validateWorkspacePath(target, workspace)).not.toThrow();
  });
});

describe('Native module verification', () => {
  const mockExecFileSync = vi.mocked(childProcess.execFileSync);

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockImplementation(() => Buffer.from(''));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('verifyNativeModules succeeds when modules are loadable', () => {
    const cwd = '/test/path';
    const mockExistsSync = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      return p.toString().includes('better-sqlite3');
    });

    expect(() => verifyNativeModules(cwd, 'Test')).not.toThrow();

    expect(mockExistsSync).toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalled();
  });

  it('verifyNativeModules skips missing modules', () => {
    const cwd = '/test/path';
    const mockExistsSync = vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    expect(() => verifyNativeModules(cwd, 'Test')).not.toThrow();

    expect(mockExistsSync).toHaveBeenCalled();
  });

  it('verifyNativeModules throws when module fails to load', () => {
    const cwd = '/test/path';
    const mockExistsSync = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      return p.toString().includes('better-sqlite3');
    });
    mockExecFileSync.mockImplementation(() => {
      throw new Error('Cannot load native module');
    });

    expect(() => verifyNativeModules(cwd, 'Test')).toThrow(/verification failed/);
  });
});

describe('rebuildNativeModules', () => {
  // PRI-569: rebuild now runs via array-form execFileSync (execNpm).
  const mockExecFileSync = vi.mocked(childProcess.execFileSync);

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockImplementation(() => Buffer.from(''));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips modules that do not exist', async () => {
    const mockExistsSync = vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    await expect(rebuildNativeModules('/test/path', 'Test')).resolves.not.toThrow();

    expect(mockExistsSync).toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('rebuilds existing native modules', async () => {
    const mockExistsSync = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      return p.toString().includes('better-sqlite3');
    });
    mockExecFileSync.mockImplementation(() => Buffer.from(''));

    await expect(rebuildNativeModules('/test/path', 'Test')).resolves.not.toThrow();

    expect(mockExecFileSync).toHaveBeenCalled();
  });

  it('throws when rebuild fails', async () => {
    const mockExistsSync = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      return p.toString().includes('better-sqlite3');
    });
    mockExecFileSync.mockImplementation(() => {
      throw new Error('rebuild failed');
    });

    await expect(rebuildNativeModules('/test/path', 'Test')).rejects.toThrow(/rebuild failed/);
  });
});

describe('checkBuiltPlugin validation', () => {
  const mockReadFileSync = vi.spyOn(fs, 'readFileSync');
  const mockExistsSync = vi.spyOn(fs, 'existsSync');

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      activation: { onCapabilities: ['hook'] },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts valid plugin manifest', async () => {
    const pluginDir = '/test/plugin';
    
    await expect(checkBuiltPlugin(pluginDir)).resolves.not.toThrow();
  });

  it('rejects missing dist directory', async () => {
    mockExistsSync.mockImplementation((p) => {
      return !p.toString().includes('dist');
    });

    await expect(checkBuiltPlugin('/test/plugin')).rejects.toThrow(/Built plugin files missing/);
  });

  it('rejects missing activation object', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({}));

    await expect(checkBuiltPlugin('/test/plugin')).rejects.toThrow(/openclaw.plugin.json is missing activation object/);
  });

  it('rejects missing hook capability', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      activation: { onCapabilities: ['other'] },
    }));

    await expect(checkBuiltPlugin('/test/plugin')).rejects.toThrow(/does not include "hook"/);
  });
});

describe('ensureConversationAccess — PRI-343', () => {
  it('sets hooks.allowConversationAccess to true when missing', () => {
    const config = {
      plugins: {
        allow: ['principles-disciple'],
        entries: {
          'principles-disciple': {
            enabled: true,
            model: 'gpt-4',
            provider: 'openai',
            hooks: {},
          },
        },
      },
    };

    const result = ensureConversationAccess(config);
    const pdEntry = (result.plugins as Record<string, unknown>).entries as Record<string, unknown>;
    const entry = pdEntry['principles-disciple'] as Record<string, unknown>;
    const hooks = entry.hooks as Record<string, unknown>;

    expect(hooks.allowConversationAccess).toBe(true);
    // Other fields preserved
    expect(entry.enabled).toBe(true);
    expect(entry.model).toBe('gpt-4');
    expect(entry.provider).toBe('openai');
  });

  it('is idempotent when allowConversationAccess is already true', () => {
    const config = {
      plugins: {
        allow: ['principles-disciple'],
        entries: {
          'principles-disciple': {
            enabled: true,
            hooks: { allowConversationAccess: true },
          },
        },
      },
    };

    const result = ensureConversationAccess(config);
    const pdEntry = (result.plugins as Record<string, unknown>).entries as Record<string, unknown>;
    const entry = pdEntry['principles-disciple'] as Record<string, unknown>;
    const hooks = entry.hooks as Record<string, unknown>;

    expect(hooks.allowConversationAccess).toBe(true);
    expect(entry.enabled).toBe(true);
  });

  it('creates hooks object when hooks field is completely absent', () => {
    const config = {
      plugins: {
        allow: ['principles-disciple'],
        entries: {
          'principles-disciple': {
            enabled: true,
            model: 'gpt-4',
            // hooks field does not exist at all
          },
        },
      },
    };

    const result = ensureConversationAccess(config);
    const pdEntry = (result.plugins as Record<string, unknown>).entries as Record<string, unknown>;
    const entry = pdEntry['principles-disciple'] as Record<string, unknown>;
    const hooks = entry.hooks as Record<string, unknown>;

    expect(hooks.allowConversationAccess).toBe(true);
    // Other fields preserved
    expect(entry.enabled).toBe(true);
    expect(entry.model).toBe('gpt-4');
  });
});

const baseInstallOptions: InstallOptions = {
  language: 'en',
  mode: 'smart',
  workspaceDir: '/tmp/pd-test-ws',
  channels: [],
  overwriteConfig: false,
  host: 'openclaw',
  stopGateway: false,
};

describe('install() gateway lock pre-flight', () => {
  // Pin English so string assertions on operator-visible failure text are
  // deterministic (the catch block now routes through t()).
  let savedLang: 'zh' | 'en';

  beforeEach(() => {
    vi.clearAllMocks();
    savedLang = 'zh';
    setLanguage('en');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setLanguage(savedLang);
  });

  // cli-5: the abort path must NOT mutate — gateway is never stopped and no
  // install step runs. This is the core fix: the old code warned + proceeded
  // into a known-likely EPERM; now non-interactive mode refuses cleanly.
  it('aborts cleanly (no mutation) when gateway is running in non-interactive mode without --stop-gateway', async () => {
    vi.mocked(checkOpenClawGateway).mockResolvedValue({ isRunning: true, port: 18789, pid: 33584 });
    vi.mocked(stopOpenClawGateway).mockResolvedValue({ ok: true });

    const result = await install({ ...baseInstallOptions, stopGateway: false }, '/nonexistent/plugin', { quiet: true });

    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/^gateway_running_aborted:/);
    // No mutation: gateway never stopped, restart never invoked.
    expect(stopOpenClawGateway).not.toHaveBeenCalled();
    expect(restartOpenClawGateway).not.toHaveBeenCalled();
  });

  // Regression: `--yes` is non-interactive but NOT json (quiet=false, human
  // output on). interactive must follow nonInteractive, NOT quiet — otherwise
  // a `--yes` run with the gateway up would hang on an interactive prompt.
  it('--yes mode (quiet=false, nonInteractive=true) aborts without prompting when the gateway is running', async () => {
    vi.mocked(checkOpenClawGateway).mockResolvedValue({ isRunning: true, port: 18789 });
    vi.mocked(stopOpenClawGateway).mockResolvedValue({ ok: true });

    // quiet=false (not --json), nonInteractive=true (--yes): must NOT prompt.
    const result = await install({ ...baseInstallOptions, stopGateway: false }, '/nonexistent/plugin', { quiet: false, nonInteractive: true });

    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/^gateway_running_aborted:/);
    expect(stopOpenClawGateway).not.toHaveBeenCalled();
  });

  it('--stop-gateway stops the gateway and restarts it even when a later step fails (finally)', async () => {
    vi.mocked(checkOpenClawGateway).mockResolvedValue({ isRunning: true, port: 18789 });
    vi.mocked(stopOpenClawGateway).mockResolvedValue({ ok: true });
    vi.mocked(restartOpenClawGateway).mockResolvedValue({ ok: true });

    // fs is auto-mocked -> checkBuiltPlugin throws ("Built plugin files missing")
    // -> catch -> finally(restart). Verifies restart runs on failure too.
    const result = await install({ ...baseInstallOptions, stopGateway: true }, '/nonexistent/plugin', { quiet: true });

    expect(stopOpenClawGateway).toHaveBeenCalledTimes(1);
    expect(restartOpenClawGateway).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
  });

  // ERR-046 / rc-9: when install fails before a backup is created, the result
  // must NOT claim "Previous install has been restored" (the old misleading
  // success-shaped message). backupDir stays null -> "not modified" branch.
  it('reports "not modified" (never "restored") when install fails before a backup is created', async () => {
    vi.mocked(checkOpenClawGateway).mockResolvedValue({ isRunning: false });

    const result = await install({ ...baseInstallOptions }, '/nonexistent/plugin', { quiet: true });

    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/^install_failed_before_mutation:/);
    expect(result.error).toMatch(/not modified/);
    expect(result.error).not.toMatch(/has been restored/);
  });
});
