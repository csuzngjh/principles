/**
 * PRI-788 G4 — signal-health.json 健康产物模块测试。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readSignalHealth, updateSignalHealth } from '../../src/core/signal-health.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeStateDir(): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-signal-health-'));
  const stateDir = path.join(workspace, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  tempDirs.push(workspace);
  return stateDir;
}

describe('signal-health (PRI-788 G4)', () => {
  it('updateSignalHealth creates defaults and persists mutations atomically', () => {
    const stateDir = makeStateDir();
    expect(readSignalHealth(stateDir)).toBeNull();

    updateSignalHealth(stateDir, (s) => {
      s.stage1Strong += 1;
      s.observerConsecutiveFailures = 3;
    });

    const state = readSignalHealth(stateDir);
    expect(state).not.toBeNull();
    expect(state?.stage1Strong).toBe(1);
    expect(state?.observerConsecutiveFailures).toBe(3);
    expect(state?.day).toBe(new Date().toISOString().slice(0, 10));
  });

  it('mutations accumulate across writes; timestamps are absolute', () => {
    const stateDir = makeStateDir();
    updateSignalHealth(stateDir, (s) => { s.stage2Queued += 2; });
    updateSignalHealth(stateDir, (s) => { s.stage2Queued += 1; s.lastStage2SuccessAt = '2026-09-14T00:00:00Z'; });

    const state = readSignalHealth(stateDir);
    expect(state?.stage2Queued).toBe(3);
    expect(state?.lastStage2SuccessAt).toBe('2026-09-14T00:00:00Z');
    expect(state?.updatedAt).toBeTruthy();
  });

  it('corrupt file is rebuilt from defaults on next write (rc-1)', () => {
    const stateDir = makeStateDir();
    fs.writeFileSync(path.join(stateDir, 'signal-health.json'), '{not-json');
    expect(readSignalHealth(stateDir)).toBeNull();

    updateSignalHealth(stateDir, (s) => { s.stage2Confirmed = 7; });
    expect(readSignalHealth(stateDir)?.stage2Confirmed).toBe(7);
  });

  it('write failures never throw (旁路观测不阻塞检测管线)', async () => {
    const io = await import('../../src/utils/io.js');
    const spy = vi.spyOn(io, 'atomicWriteFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });
    const stateDir = path.join(makeStateDir(), 'not-a-dir', 'deeper');
    expect(() => updateSignalHealth(stateDir, (s) => { s.stage1Strong += 1; })).not.toThrow();
    spy.mockRestore();
  });
});
