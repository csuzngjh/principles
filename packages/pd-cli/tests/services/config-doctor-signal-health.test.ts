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

  it('恰好超过 24h（24.5h）即 degraded — 常量必须与「>24h」契约一致', () => {
    const stateDir = makeStateDir();
    const stale = new Date(Date.now() - 24.5 * 60 * 60 * 1000).toISOString();
    writeHealth(stateDir, { updatedAt: stale });
    expect(buildSignalHealthEntry(stateDir).status).toBe('degraded');
  });

  it('23h 未更新仍是 ok（不误报 degraded）', () => {
    const stateDir = makeStateDir();
    const fresh = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
    writeHealth(stateDir, { updatedAt: fresh });
    expect(buildSignalHealthEntry(stateDir).status).toBe('ok');
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

describe('buildSignalHealthEntry (AUDIT-P2-02 新增指标)', () => {
  it('新字段存在 → counts 如实呈现 stage2Invocations/stage2BatchSkipped', () => {
    const stateDir = makeStateDir();
    // pending=0：纯计数展示。pending>0 && batchSkipped>0 的 degraded 组合
    // 由 AUDIT-P2-04 describe 单独覆盖。
    writeHealth(stateDir, { stage2Invocations: 12, stage2BatchSkipped: 3, pendingCount: 0 });
    const entry = buildSignalHealthEntry(stateDir);
    expect(entry.status).toBe('ok');
    expect(entry.counts).toMatchObject({ stage2Invocations: 12, stage2BatchSkipped: 3, pendingCount: 0 });
  });

  it('旧格式文件（无新字段）→ counts 读作 0，不退化为 unknown（向后兼容）', () => {
    const stateDir = makeStateDir();
    writeHealth(stateDir, { stage2Queued: 7 }); // writeHealth 基线本身就不带新字段
    const entry = buildSignalHealthEntry(stateDir);
    expect(entry.status).toBe('ok');
    expect(entry.counts).not.toBeNull();
    expect(entry.counts?.stage2Invocations).toBe(0);
    expect(entry.counts?.stage2BatchSkipped).toBe(0);
    expect(entry.counts?.stage2Queued).toBe(7);
  });
});

describe('buildSignalHealthEntry (AUDIT-P2-04 队列积压分级)', () => {
  it('pending>0 且 batchSkipped>0 → degraded：积压 + 分类器不可用对 Owner 可见', () => {
    const stateDir = makeStateDir();
    writeHealth(stateDir, { pendingCount: 7, stage2BatchSkipped: 4 });
    const entry = buildSignalHealthEntry(stateDir);
    expect(entry.status).toBe('degraded');
    expect(entry.reason).toContain('backlog stands at 7');
    expect(entry.reason).toContain('skipped 4');
    expect(entry.nextAction).toContain('signal_collector');
  });

  it('pending>0 但 batchSkipped=0 → 维持 ok（积压等待下一周期消费，不是站桩）', () => {
    const stateDir = makeStateDir();
    writeHealth(stateDir, { pendingCount: 3, stage2BatchSkipped: 0 });
    const entry = buildSignalHealthEntry(stateDir);
    expect(entry.status).toBe('ok');
  });
});
