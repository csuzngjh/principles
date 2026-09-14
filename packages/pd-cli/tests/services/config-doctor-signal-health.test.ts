/**
 * PRI-788 G4 — pd config doctor 的 signalHealth 分级测试。
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildSignalHealthEntry } from '../../src/services/config-doctor.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeStateDir(): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-doctor-signal-'));
  const stateDir = path.join(workspace, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  tempDirs.push(workspace);
  return stateDir;
}

function writeHealth(stateDir: string, state: Record<string, unknown>): void {
  fs.writeFileSync(path.join(stateDir, 'signal-health.json'), JSON.stringify({
    stage1Strong: 0,
    stage2Confirmed: 0,
    stage2Queued: 0,
    stage2Dropped: 0,
    pendingCount: 0,
    lastStage2SuccessAt: null,
    observerLastSuccessAt: null,
    observerConsecutiveFailures: 0,
    day: new Date().toISOString().slice(0, 10),
    updatedAt: new Date().toISOString(),
    ...state,
  }));
}

describe('buildSignalHealthEntry (PRI-788 G4)', () => {
  it('missing file → unknown with nextAction, never throws (rc-1)', () => {
    const entry = buildSignalHealthEntry(makeStateDir());
    expect(entry.status).toBe('unknown');
    expect(entry.counts).toBeNull();
    expect(entry.nextAction).toMatch(/signal_collector/);
  });

  it('corrupt file → unknown', () => {
    const stateDir = makeStateDir();
    fs.writeFileSync(path.join(stateDir, 'signal-health.json'), '{not-json');
    expect(buildSignalHealthEntry(stateDir).status).toBe('unknown');
  });

  it('fresh healthy file → ok with counts', () => {
    const stateDir = makeStateDir();
    writeHealth(stateDir, { stage1Strong: 3, pendingCount: 2 });
    const entry = buildSignalHealthEntry(stateDir);
    expect(entry.status).toBe('ok');
    expect(entry.counts).toMatchObject({ stage1Strong: 3, pendingCount: 2 });
    expect(entry.observerConsecutiveFailures).toBe(0);
  });

  it('observerConsecutiveFailures > 4 → degraded with probe nextAction', () => {
    const stateDir = makeStateDir();
    writeHealth(stateDir, { observerConsecutiveFailures: 40 });
    const entry = buildSignalHealthEntry(stateDir);
    expect(entry.status).toBe('degraded');
    expect(entry.reason).toContain('40 cycles');
    expect(entry.nextAction).toContain('pd runtime probe');
  });

  it('stale updatedAt (>24h) → degraded', () => {
    const stateDir = makeStateDir();
    const stale = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    writeHealth(stateDir, { updatedAt: stale });
    const entry = buildSignalHealthEntry(stateDir);
    expect(entry.status).toBe('degraded');
    expect(entry.reason).toContain('>24h');
  });

  it('non-finite garbage fields degrade gracefully without throwing (rc-2)', () => {
    const stateDir = makeStateDir();
    writeHealth(stateDir, {
      stage1Strong: 'lots',
      observerConsecutiveFailures: 'many',
      updatedAt: 12345,
    });
    const entry = buildSignalHealthEntry(stateDir);
    expect(entry.status).toBe('degraded'); // updatedAt 非法 → stale 分支
    expect(entry.counts?.stage1Strong).toBe(0);
  });
});
