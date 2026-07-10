import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, openSync, closeSync } from 'fs';
import { join } from 'path';

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: vi.fn(),
  };
});

import * as os from 'os';

describe('postinstall.cjs lock correctness (static analysis + runtime verification)', () => {
  const testHome = join('/tmp', 'pd-test-postinstall-' + Date.now());
  const configDir = join(testHome, '.openclaw');
  const configPath = join(configDir, 'openclaw.json');
  const lockPath = configPath + '.lock';
  const scriptPath = join(__dirname, '..', '..', 'scripts', 'postinstall.cjs');

  beforeEach(() => {
    vi.mocked(os.homedir).mockReturnValue(testHome);
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('static code verification — TOCTOU fix', () => {
    it('uses writeSync via fd instead of writeFileSync with w flag (prevents TOCTOU race)', () => {
      const scriptContent = readFileSync(scriptPath, 'utf8');
      
      const tryAcquireMatch = scriptContent.match(/function tryAcquireLock\(\) \{[\s\S]*?^\}/m);
      expect(tryAcquireMatch).not.toBeNull();
      
      const tryAcquireBody = tryAcquireMatch![0];
      
      expect(tryAcquireBody).toContain('writeSync(fd,');
      expect(tryAcquireBody).toContain('fsyncSync(fd)');
      expect(tryAcquireBody).not.toMatch(/writeFileSync\(LOCK_PATH/);
    });

    it('acquires lock atomically using O_EXCL flag', () => {
      const scriptContent = readFileSync(scriptPath, 'utf8');
      
      expect(scriptContent).toContain('O_CREAT');
      expect(scriptContent).toContain('O_EXCL');
      expect(scriptContent).toContain('openSync(LOCK_PATH');
    });

    it('imports writeSync and fsyncSync from fs', () => {
      const scriptContent = readFileSync(scriptPath, 'utf8');
      
      const importMatch = scriptContent.match(/require\('fs'\)/);
      expect(importMatch).not.toBeNull();
      
      expect(scriptContent).toContain('writeSync');
      expect(scriptContent).toContain('fsyncSync');
    });

    it('properly closes fd in finally block after writeSync', () => {
      const scriptContent = readFileSync(scriptPath, 'utf8');
      
      const tryAcquireMatch = scriptContent.match(/function tryAcquireLock\(\) \{[\s\S]*?^\}/m);
      expect(tryAcquireMatch).not.toBeNull();
      
      const tryAcquireBody = tryAcquireMatch![0];
      
      expect(tryAcquireBody).toContain('try {');
      expect(tryAcquireBody).toContain('} finally {');
      expect(tryAcquireBody).toContain('closeSync(fd)');
    });
  });

  describe('runtime verification', () => {
    it('script runs without errors when config exists and needs update', () => {
      const cfg = {
        plugins: {
          entries: {
            'principles-disciple': { enabled: true },
          },
        },
      };
      writeFileSync(configPath, JSON.stringify(cfg), 'utf8');

      const { execSync } = require('child_process');
      let exitCode = 0;
      let stderr = '';
      try {
        execSync(`node -e "
          const Module = require('module');
          const origResolve = Module._resolveFilename;
          Module._resolveFilename = function(request, parent, isMain, options) {
            if (request === 'os' && parent && parent.filename && parent.filename.includes('postinstall.cjs')) {
              return require.resolve('${join(__dirname, 'mock-os.cjs').replace(/'/g, "\\'")}');
            }
            return origResolve.call(this, request, parent, isMain, options);
          };
          process.env.PD_TEST_HOMEDIR = '${testHome.replace(/'/g, "\\'")}';
          require('${scriptPath.replace(/'/g, "\\'")}');
        "`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e: any) {
        exitCode = e.status;
        stderr = e.stderr || '';
      }

      const updated = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(updated.plugins.entries['principles-disciple'].hooks.allowConversationAccess).toBe(true);
    });

    it('lock file is cleaned up after successful run', () => {
      writeFileSync(configPath, '{}', 'utf8');

      const { execSync } = require('child_process');
      try {
        execSync(`node -e "
          const Module = require('module');
          const origResolve = Module._resolveFilename;
          Module._resolveFilename = function(request, parent, isMain, options) {
            if (request === 'os' && parent && parent.filename && parent.filename.includes('postinstall.cjs')) {
              return require.resolve('${join(__dirname, 'mock-os.cjs').replace(/'/g, "\\'")}');
            }
            return origResolve.call(this, request, parent, isMain, options);
          };
          process.env.PD_TEST_HOMEDIR = '${testHome.replace(/'/g, "\\'")}';
          require('${scriptPath.replace(/'/g, "\\'")}');
        "`, { encoding: 'utf8' });
      } catch (e) {
        // expected — process.exit
      }

      expect(existsSync(lockPath)).toBe(false);
    });

    it('dead process lock gets cleaned up and script proceeds', () => {
      const cfg = { plugins: { entries: { 'principles-disciple': { enabled: true } } } };
      writeFileSync(configPath, JSON.stringify(cfg), 'utf8');
      writeFileSync(lockPath, '99999999', 'utf8');

      const { execSync } = require('child_process');
      try {
        execSync(`node -e "
          const Module = require('module');
          const origResolve = Module._resolveFilename;
          Module._resolveFilename = function(request, parent, isMain, options) {
            if (request === 'os' && parent && parent.filename && parent.filename.includes('postinstall.cjs')) {
              return require.resolve('${join(__dirname, 'mock-os.cjs').replace(/'/g, "\\'")}');
            }
            return origResolve.call(this, request, parent, isMain, options);
          };
          process.env.PD_TEST_HOMEDIR = '${testHome.replace(/'/g, "\\'")}';
          require('${scriptPath.replace(/'/g, "\\'")}');
        "`, { encoding: 'utf8' });
      } catch (e) {
        // expected
      }

      const updated = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(updated.plugins.entries['principles-disciple'].hooks.allowConversationAccess).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    });

    it('lock is released even when config update throws', () => {
      writeFileSync(configPath, 'invalid json {{{', 'utf8');

      const { execSync } = require('child_process');
      try {
        execSync(`node -e "
          const Module = require('module');
          const origResolve = Module._resolveFilename;
          Module._resolveFilename = function(request, parent, isMain, options) {
            if (request === 'os' && parent && parent.filename && parent.filename.includes('postinstall.cjs')) {
              return require.resolve('${join(__dirname, 'mock-os.cjs').replace(/'/g, "\\'")}');
            }
            return origResolve.call(this, request, parent, isMain, options);
          };
          process.env.PD_TEST_HOMEDIR = '${testHome.replace(/'/g, "\\'")}';
          require('${scriptPath.replace(/'/g, "\\'")}');
        "`, { encoding: 'utf8' });
      } catch (e) {
        // expected
      }

      expect(existsSync(lockPath)).toBe(false);
    });
  });
});
