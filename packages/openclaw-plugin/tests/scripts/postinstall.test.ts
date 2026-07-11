import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: vi.fn(),
  };
});

import * as os from 'os';

/**
 * Build a standalone runner script that loads postinstall.cjs with a mocked `os`
 * module, avoiding the need to inline JS source via `node -e "..."` (which
 * triggered CodeQL backslash-escape alerts on Windows paths).
 *
 * The runner is written to a temp file and executed via `node <file>`, so all
 * paths are passed as process arguments / env vars — never string-interpolated
 * into JS source.
 */
function buildRunnerScript(opts: { mockOsPath: string; scriptPath: string; testHome: string }): string {
  return [
    "const Module = require('module');",
    "const origResolve = Module._resolveFilename;",
    `Module._resolveFilename = function(request, parent, isMain, options) {`,
    `  if (request === 'os' && parent && parent.filename && parent.filename.includes('postinstall.cjs')) {`,
    `    return require.resolve(${JSON.stringify(opts.mockOsPath)});`,
    `  }`,
    `  return origResolve.call(this, request, parent, isMain, options);`,
    `};`,
    `process.env.PD_TEST_HOMEDIR = ${JSON.stringify(opts.testHome)};`,
    `require(${JSON.stringify(opts.scriptPath)});`,
  ].join('\n');
}

describe('postinstall.cjs lock correctness (static analysis + runtime verification)', () => {
  const testHome = join('/tmp', 'pd-test-postinstall-' + Date.now());
  const configDir = join(testHome, '.openclaw');
  const configPath = join(configDir, 'openclaw.json');
  const lockPath = configPath + '.lock';
  const scriptPath = join(__dirname, '..', '..', 'scripts', 'postinstall.cjs');
  const mockOsPath = join(__dirname, 'mock-os.cjs');
  const runnerPath = join(__dirname, '.postinstall-runner.tmp.cjs');

  beforeEach(() => {
    vi.mocked(os.homedir).mockReturnValue(testHome);
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
    rmSync(runnerPath, { force: true });
    vi.clearAllMocks();
  });

  /** Run postinstall.cjs in a child node process; swallow the expected non-zero exit. */
  function runPostinstall(): void {
    const { execSync } = require('child_process');
    writeFileSync(runnerPath, buildRunnerScript({ mockOsPath, scriptPath, testHome }), 'utf8');
    try {
      execSync(`node "${runnerPath}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (_e) {
      // postinstall calls process.exit(0) which execSync treats as success;
      // non-zero exits are expected for some test cases — caller checks fs state.
    }
  }

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

      runPostinstall();

      const updated = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(updated.plugins.entries['principles-disciple'].hooks.allowConversationAccess).toBe(true);
    });

    it('lock file is cleaned up after successful run', () => {
      writeFileSync(configPath, '{}', 'utf8');

      runPostinstall();

      expect(existsSync(lockPath)).toBe(false);
    });

    it('dead process lock gets cleaned up and script proceeds', () => {
      const cfg = { plugins: { entries: { 'principles-disciple': { enabled: true } } } };
      writeFileSync(configPath, JSON.stringify(cfg), 'utf8');
      writeFileSync(lockPath, '99999999', 'utf8');

      runPostinstall();

      const updated = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(updated.plugins.entries['principles-disciple'].hooks.allowConversationAccess).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    });

    it('lock is released even when config update throws', () => {
      writeFileSync(configPath, 'invalid json {{{', 'utf8');

      runPostinstall();

      expect(existsSync(lockPath)).toBe(false);
    });
  });
});
