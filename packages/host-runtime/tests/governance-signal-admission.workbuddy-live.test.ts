/**
 * AUDIT-P3-01 / AUDIT-P3-04（2026-10-21），P1 评审整改（round 3）后更新。
 *
 * WorkBuddy 没有任何持久化的 governance_observations 存储，因此“自动关键词
 * 纠正”无法提供真实、可验证、已持久化的行为证据。共享 ingress 会将其判为
 * `observation_only`：不产生 Pain、不建 Task、不消耗额度，也不再用
 * `pain_event:<canonicalPainId>` 伪造 behavior_trace。
 *
 * 本文件仍覆盖词表契约（D5 学习词不直通、共享位置守卫（引号 / 第三人称 /
 * 否定 / 条件语境）、原生事件门、双 flag、幂等）——只是准入结果从
 * admitted/pending 变为 abandoned。
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDefaultPdConfig } from '@principles/core/runtime-v2';
import {
  admitTrustedWorkbuddyLiveCorrection,
  assessWorkbuddyCorrectionCandidate,
  assessWorkbuddyLiveKeyword,
  resolveSharedCorrectionKeywordStoreForDetection,
} from '../src/governance-signal-admission.js';

const BASELINE_DDL = [
  'CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)',
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

function markerRows(): Array<{ decision: string; reason: string | null }> {
  const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
  try {
    return db.prepare('SELECT decision, reason FROM governance_signal_admissions ORDER BY logical_observation_key').all() as Array<{ decision: string; reason: string | null }>;
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

  it('传入共享 store：学习词永不直通；降级词即使 owner_promoted 也只作候选', () => {
    writeLearnedStore([
      { term: '方向完全反了', weight: 0.9, source: 'llm', truePositiveCount: 3, falsePositiveCount: 0 },
      { term: '可能不太对', weight: 0.9, source: 'llm', truePositiveCount: 1, falsePositiveCount: 0 },
      { term: '我说的是', weight: 0.75, source: 'user', truePositiveCount: 0, falsePositiveCount: 0 },
    ]);
    // store 解析走生产路径（含 mtime 缓存与降级），与 pd-hook 使用同一入口。
    const store = resolveSharedCorrectionKeywordStoreForDetection(workspaceDir);

    // SPEC v0.3 §3.2.3：历史 TP≥3 的学习词不再获得 STRONG 直通。
    expect(assessWorkbuddyLiveKeyword('方向完全反了，停下', 's', store).matched).toBe(false);
    expect(store.terms['方向完全反了']?.precision).toBe('ambiguous');
    expect(assessWorkbuddyLiveKeyword('可能不太对', 's', store).matched).toBe(false);
    // 降级词无论来源都只能作候选（§3.2.1）。
    expect(assessWorkbuddyLiveKeyword('我说的是另一个文件', 's', store).matched).toBe(false);
    expect(store.terms['我说的是']?.precision).toBe('ambiguous');
    // 学习词同样受共享第三人称守卫约束：转述句降级 ambiguous，不直通。
    expect(assessWorkbuddyLiveKeyword('他说方向完全反了', 's', store).matched).toBe(false);
    // 真实 seed high 词仍走确定性路径（现有能力不回退）。
    expect(assessWorkbuddyLiveKeyword('这是错的', 's', store).matched).toBe(true);
  });
});

describe('admitTrustedWorkbuddyLiveCorrection — 共享词库准入契约（AUDIT-P3-01/P3-04）', () => {
  it('P-5 退役后的正向控制：句中的 high 精度纠正词仍是 strong 候选', () => {
    // 句首预过滤退役前，该句被 startsWith 静默丢弃。
    expect(assessWorkbuddyCorrectionCandidate('我早说了，这是错的', 's')).toMatchObject({
      kind: 'strong',
      reason: 'matched',
    });
    expect(assessWorkbuddyLiveKeyword('我早说了，这是错的', 's').matched).toBe(true);
  });

  it('学习词与 seed high 词都不再产生 Pain：无持久化行为证据 → observation_only', () => {
    writeLearnedStore([
      { term: '方向完全反了', weight: 0.9, source: 'llm', truePositiveCount: 3, falsePositiveCount: 0 },
    ]);
    // SPEC v0.3 §3.2.3：历史高精度学习词不能直接产生 Pain。
    const learned = admitTrustedWorkbuddyLiveCorrection({
      workspaceDir,
      rawEvent: nativeEvent({ prompt: '方向完全反了，停下', generation_id: 'wb-live-gen-1a' }),
    });
    expect(learned.ok).toBe(true);
    expect(learned.outcomes?.[0]).toMatchObject({ disposition: 'abandoned' });
    expect(painCount()).toBe(0);

    // 自动纠正没有真实持久化证据 → 判 observation_only，不再伪造 pain_event。
    const event = nativeEvent({ prompt: '这是错的，停下', generation_id: 'wb-live-gen-1b' });
    const first = admitTrustedWorkbuddyLiveCorrection({ workspaceDir, rawEvent: event });
    if (!first.ok) throw new Error(`admission degraded: ${first.reason} / ${first.nextAction}`);
    expect(first.outcomes?.[0]).toMatchObject({ disposition: 'abandoned' });
    expect(painCount()).toBe(0);

    const replay = admitTrustedWorkbuddyLiveCorrection({ workspaceDir, rawEvent: event });
    expect(replay.ok).toBe(true);
    expect(replay.outcomes?.[0]).toMatchObject({ disposition: 'abandoned' });
    expect(painCount()).toBe(0);
    // Two deliveries of the same generation reuse ONE terminal marker.
    const markers = markerRows();
    expect(markers).toHaveLength(2);
    expect(markers.every((marker) => marker.decision === 'abandoned')).toBe(true);
    // No fabricated `pain_event:` trace survives in any persisted payload.
    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    try {
      const payloads = db.prepare('SELECT task_payload_json FROM governance_signal_admissions').all() as Array<{ task_payload_json: string | null }>;
      expect(payloads.some((row) => (row.task_payload_json ?? '').includes('pain_event:'))).toBe(false);
    } finally {
      db.close();
    }
  });

  it('未达 high 门槛的学习词同样 observation_only，不落 pending', () => {
    writeLearnedStore([
      { term: '可能不太对', weight: 0.9, source: 'llm', truePositiveCount: 1, falsePositiveCount: 0 },
    ]);
    const result = admitTrustedWorkbuddyLiveCorrection({
      workspaceDir,
      rawEvent: nativeEvent({ prompt: '可能不太对' , generation_id: 'wb-live-gen-2' }),
    });
    expect(result.ok).toBe(true);
    expect(result.outcomes?.[0]).toMatchObject({ disposition: 'abandoned' });
    expect(painCount()).toBe(0);
  });

  it('词库文件损坏 → 降级 seed-only：P0 四词仍被识别，但没有证据仍 observation_only', () => {
    fs.writeFileSync(path.join(workspaceDir, '.state', 'correction_keywords.json'), '{ malformed');
    const result = admitTrustedWorkbuddyLiveCorrection({
      workspaceDir,
      rawEvent: nativeEvent({ prompt: '不要自作主张' , generation_id: 'wb-live-gen-3' }),
    });
    expect(result.ok).toBe(true);
    expect(result.outcomes?.[0]).toMatchObject({ disposition: 'abandoned' });
    expect(painCount()).toBe(0);
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
    // P-5 retired: the reported-speech phrase now reaches the shared guards,
    // downgrades to ambiguous, and is abandoned at the evidence gate.
    expect(result.outcomes).toMatchObject([
      { disposition: 'abandoned', kind: 'user_correction', reason: 'evidence_invalid' },
    ]);
    expect(painCount()).toBe(0);
  });
});
