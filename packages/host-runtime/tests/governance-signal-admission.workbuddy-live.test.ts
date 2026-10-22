/**
 * AUDIT-P3-01 / AUDIT-P3-04 (2026-10-21) — WorkBuddy live-keyword 检测的直接
 * host-runtime 单测 + 共享学习词库接入契约。
 *
 * 之前这两个函数（assessWorkbuddyLiveKeyword / admitTrustedWorkbuddyLiveCorrection）
 * 只有 workbuddy-adapter 的间接（真实 hook 进程）覆盖，本文件补齐包内直接边界：
 *  - 词表契约：只有「共享 live 词库中满足 high 门槛的 correction 词」可触发
 *    自动 Pain（seed ≥0.7 / owner_promoted ≥0.7 / earned-high TP≥3 且零 FP）；
 *  - 安全边界：startsWith 预过滤、原生事件门、显式前缀保留、双 flag、幂等；
 *  - 降级：词库文件损坏 → seed-only（P0 四词仍在）。
 *
 * SPEC：docs/specs/SPEC-PD-CROSS-HOST-KEYWORD-PAIN-001-v0.2.md §4
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDefaultPdConfig } from '@principles/core/runtime-v2';
import {
  admitTrustedWorkbuddyLiveCorrection,
  assessWorkbuddyLiveKeyword,
  resolveSharedCorrectionKeywordStoreForDetection,
} from '../src/governance-signal-admission.js';

const BASELINE_DDL = [
  'CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)',
  'CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)',
  'CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL',
];

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-wb-live-kw-'));
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  const sqlite = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
  for (const statement of BASELINE_DDL) sqlite.prepare(statement).run();
  sqlite.close();
  // 双 flag 开启（quiet、生产默认 OFF——测试显式打开）。
  const config = getDefaultPdConfig();
  if (config.features['host.workbuddy']) config.features['host.workbuddy'].enabled = true;
  config.features['workbuddy_live_keyword_pain'] = { enabled: true, category: 'quiet' };
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
});

afterEach(() => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      return;
    } catch {
      // Windows 句柄延迟释放，短暂重试。
    }
  }
});

/** 写共享学习词库文件（correction-cue-learner 投影形状）。 */
function writeLearnedStore(keywords: Array<Record<string, unknown>>): void {
  fs.writeFileSync(
    path.join(workspaceDir, '.state', 'correction_keywords.json'),
    JSON.stringify({ keywords }),
  );
}

function nativeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: 'UserPromptSubmit',
    is_internal_continuation: false,
    session_id: 'wb-live-session',
    generation_id: 'wb-live-gen-1',
    prompt: '这是错的，重做',
    ...overrides,
  };
}

function painCount(): number {
  const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

describe('assessWorkbuddyLiveKeyword — 共享词库参数（AUDIT-P3-01）', () => {
  it('缺省 store 保持 P0 四词行为（向后兼容）', () => {
    // P0 词命中。
    expect(assessWorkbuddyLiveKeyword('这是错的，重来', 's').matched).toBe(true);
    expect(assessWorkbuddyLiveKeyword('不要自作主张', 's').matched).toBe(true);
    // seed overlay 的其他 high 词不在 P0 四词内 → 缺省不触发。
    expect(assessWorkbuddyLiveKeyword('我说的是另一个文件', 's').matched).toBe(false);
    // 引用/转述：词不在句首 → 不触发。
    expect(assessWorkbuddyLiveKeyword('你刚才说"这是错的"？其实不是', 's').matched).toBe(false);
    // 超长：prompt_too_large。
    expect(assessWorkbuddyLiveKeyword('这是错的' + 'x'.repeat(17 * 1024), 's')).toMatchObject({
      matched: false,
      reason: 'prompt_too_large',
    });
  });

  it('传入共享 store：earned-high 学习词与 seed high 词均可触发；未达门槛的学习词不可', () => {
    writeLearnedStore([
      { term: '方向完全反了', weight: 0.9, source: 'llm', truePositiveCount: 3, falsePositiveCount: 0 }, // earned-high
      { term: '可能不太对', weight: 0.9, source: 'llm', truePositiveCount: 1, falsePositiveCount: 0 }, // 未达 TP 门槛 → ambiguous
      { term: '我说的是', weight: 0.75, source: 'user', truePositiveCount: 0, falsePositiveCount: 0 }, // owner_promoted ≥0.7
    ]);
    // store 解析走生产路径（含 mtime 缓存与降级），与 pd-hook 使用同一入口。
    const store = resolveSharedCorrectionKeywordStoreForDetection(workspaceDir);

    expect(assessWorkbuddyLiveKeyword('方向完全反了，停下', 's', store).matched).toBe(true);
    expect(assessWorkbuddyLiveKeyword('可能不太对', 's', store).matched).toBe(false);
    expect(assessWorkbuddyLiveKeyword('我说的是另一个文件', 's', store).matched).toBe(true);
    // 学习词同样受 startsWith 预过滤约束（转述不触发）。
    expect(assessWorkbuddyLiveKeyword('他说方向完全反了', 's', store).matched).toBe(false);
  });
});

describe('admitTrustedWorkbuddyLiveCorrection — 共享词库准入契约（AUDIT-P3-01/P3-04）', () => {
  it('earned-high 学习词经完整准入产生一条 canonical Pain，且重复投递幂等', () => {
    writeLearnedStore([
      { term: '方向完全反了', weight: 0.9, source: 'llm', truePositiveCount: 3, falsePositiveCount: 0 },
    ]);
    const event = nativeEvent({ prompt: '方向完全反了，停下' });

    const first = admitTrustedWorkbuddyLiveCorrection({ workspaceDir, rawEvent: event });
    if (!first.ok) throw new Error(`admission degraded: ${first.reason} / ${first.nextAction}`);
    expect(first.ok).toBe(true);
    expect(first.outcomes?.[0]).toMatchObject({ disposition: 'admitted', duplicate: false });
    expect(painCount()).toBe(1);

    const replay = admitTrustedWorkbuddyLiveCorrection({ workspaceDir, rawEvent: event });
    expect(replay.ok).toBe(true);
    expect(replay.outcomes?.[0]).toMatchObject({ disposition: 'already_admitted' });
    expect(painCount()).toBe(1);
  });

  it('未达 high 门槛的学习词不产生 Pain、不写 marker', () => {
    writeLearnedStore([
      { term: '可能不太对', weight: 0.9, source: 'llm', truePositiveCount: 1, falsePositiveCount: 0 },
    ]);
    const result = admitTrustedWorkbuddyLiveCorrection({
      workspaceDir,
      rawEvent: nativeEvent({ prompt: '可能不太对' , generation_id: 'wb-live-gen-2' }),
    });
    expect(result.ok).toBe(true);
    expect(result.outcomes).toEqual([]);
    expect(painCount()).toBe(0);
  });

  it('词库文件损坏 → 降级 seed-only：P0 四词仍可触发（降级不静默致死）', () => {
    fs.writeFileSync(path.join(workspaceDir, '.state', 'correction_keywords.json'), '{ malformed');
    const result = admitTrustedWorkbuddyLiveCorrection({
      workspaceDir,
      rawEvent: nativeEvent({ prompt: '不要自作主张' , generation_id: 'wb-live-gen-3' }),
    });
    expect(result.ok).toBe(true);
    expect(result.outcomes?.[0]).toMatchObject({ disposition: 'admitted' });
    expect(painCount()).toBe(1);
  });

  it('安全边界：内部续接、无效原生事件、显式前缀、flag 关闭各自拒绝', async () => {
    writeLearnedStore([
      { term: '方向完全反了', weight: 0.9, source: 'llm', truePositiveCount: 3, falsePositiveCount: 0 },
    ]);
    // 内部续接 → 原生门拒绝。
    const cont = admitTrustedWorkbuddyLiveCorrection({
      workspaceDir,
      rawEvent: nativeEvent({ is_internal_continuation: true, prompt: '方向完全反了' }),
    });
    expect(cont).toMatchObject({ ok: false, reason: 'native_current_user_unverified' });
    // 无效原生事件（缺 generation_id）。
    const badId = admitTrustedWorkbuddyLiveCorrection({
      workspaceDir,
      rawEvent: nativeEvent({ generation_id: '' }),
    });
    expect(badId).toMatchObject({ ok: false, reason: 'native_identity_invalid' });
    // 显式 Owner Statement 前缀保留（关键词路径必须跳过）。
    const explicit = admitTrustedWorkbuddyLiveCorrection({
      workspaceDir,
      rawEvent: nativeEvent({ prompt: 'PD记录痛苦：方向完全反了' }),
    });
    expect(explicit).toMatchObject({ ok: false, reason: 'explicit_owner_statement_reserved' });
    // 双 flag 关闭 → 拒绝。
    const config = getDefaultPdConfig();
    if (config.features['host.workbuddy']) config.features['host.workbuddy'].enabled = false;
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
    const { invalidatePainSignalBridge } = await import('@principles/core/runtime-v2');
    invalidatePainSignalBridge(workspaceDir);
    const disabled = admitTrustedWorkbuddyLiveCorrection({
      workspaceDir,
      rawEvent: nativeEvent({ prompt: '方向完全反了', generation_id: 'wb-live-gen-4' }),
    });
    expect(disabled).toMatchObject({ ok: false, reason: 'workbuddy_auto_disabled' });
    expect(painCount()).toBe(0);
  });

  it('转述（学习词不在句首）经完整准入不产生 Pain', () => {
    writeLearnedStore([
      { term: '方向完全反了', weight: 0.9, source: 'llm', truePositiveCount: 3, falsePositiveCount: 0 },
    ]);
    const result = admitTrustedWorkbuddyLiveCorrection({
      workspaceDir,
      rawEvent: nativeEvent({ prompt: '他说方向完全反了，你觉得呢', generation_id: 'wb-live-gen-5' }),
    });
    expect(result.ok).toBe(true);
    expect(result.outcomes).toEqual([]);
    expect(painCount()).toBe(0);
  });
});
