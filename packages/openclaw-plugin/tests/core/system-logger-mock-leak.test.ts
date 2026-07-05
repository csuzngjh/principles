/**
 * PRI-504 regression tests: SystemLogger must use guardWorkspaceLeak
 * to prevent mock-leak workspace paths from polluting filesystem root.
 *
 * Before the fix, mock paths like '/fake/workspace' would be resolved against
 * the current drive letter on Windows, creating real files in the filesystem root.
 * After the fix, such paths are redirected to os.tmpdir()/.pd-test-quarantine/.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SystemLogger, disposeAllSystemLoggers } from '../../src/core/system-logger.js';

describe('SystemLogger mock-leak guard (PRI-504)', () => {
  afterEach(() => {
    disposeAllSystemLoggers();
  });

  function flushAsyncWrites(ms = 50): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(() => resolve(), ms));
  }

  function readTodayLog(workspaceDir: string): string {
    const today = new Date().toISOString().slice(0, 10);
    const logPath = path.join(workspaceDir, 'memory', 'logs', `SYSTEM_${today}.log`);
    if (!fs.existsSync(logPath)) return '';
    return fs.readFileSync(logPath, 'utf-8');
  }

  it('SL-ML-01: mock-leak path /fake/workspace does not pollute filesystem root', async () => {
    const mockPath = '/fake/workspace';

    SystemLogger.log(mockPath, 'TEST_EVENT', 'mock-leak-test-message');

    await flushAsyncWrites();

    const rootFakeDir = '/fake';
    expect(fs.existsSync(rootFakeDir)).toBe(false);

    const windowsFakeDir = 'D:\\fake';
    expect(fs.existsSync(windowsFakeDir)).toBe(false);
  });

  it('SL-ML-02: mock-leak path writes to quarantine directory under tmpdir', async () => {
    const mockPath = '/fake/workspace';

    SystemLogger.log(mockPath, 'TEST_EVENT', 'quarantine-test-message');

    await flushAsyncWrites();

    const quarantineRoot = path.join(os.tmpdir(), '.pd-test-quarantine');
    expect(fs.existsSync(quarantineRoot)).toBe(true);

    const today = new Date().toISOString().slice(0, 10);
    const expectedLogPath = path.join(quarantineRoot, 'fake_workspace', 'memory', 'logs', `SYSTEM_${today}.log`);
    expect(fs.existsSync(expectedLogPath)).toBe(true);

    const content = fs.readFileSync(expectedLogPath, 'utf-8');
    expect(content).toContain('quarantine-test-message');
  });

  it('SL-ML-03: multiple mock-leak paths get separate quarantine directories', async () => {
    const mockPathA = '/fake/workspace-a';
    const mockPathB = '/mock/state-b';

    SystemLogger.log(mockPathA, 'TEST_EVENT', 'message-from-fake-a');
    SystemLogger.log(mockPathB, 'TEST_EVENT', 'message-from-mock-b');

    await flushAsyncWrites();

    const quarantineRoot = path.join(os.tmpdir(), '.pd-test-quarantine');

    const today = new Date().toISOString().slice(0, 10);
    const logPathA = path.join(quarantineRoot, 'fake_workspace-a', 'memory', 'logs', `SYSTEM_${today}.log`);
    const logPathB = path.join(quarantineRoot, 'mock_state-b', 'memory', 'logs', `SYSTEM_${today}.log`);

    expect(fs.existsSync(logPathA)).toBe(true);
    expect(fs.existsSync(logPathB)).toBe(true);

    const contentA = fs.readFileSync(logPathA, 'utf-8');
    const contentB = fs.readFileSync(logPathB, 'utf-8');

    expect(contentA).toContain('message-from-fake-a');
    expect(contentA).not.toContain('message-from-mock-b');
    expect(contentB).toContain('message-from-mock-b');
    expect(contentB).not.toContain('message-from-fake-a');
  });

  it('SL-ML-04: real workspace path still writes to correct location', async () => {
    const realWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-real-workspace-'));

    SystemLogger.log(realWorkspace, 'TEST_EVENT', 'real-workspace-message');

    await flushAsyncWrites();

    const content = readTodayLog(realWorkspace);
    expect(content).toContain('real-workspace-message');

    fs.rmSync(realWorkspace, { recursive: true, force: true });
  });
});