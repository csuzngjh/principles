import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { runEntry } from './helpers/hook-runner.js';
import { cleanupTempDirs, fixturePayload, makeGovernance, makeHome, makeProjectDir, makeTrajectory } from './helpers/workbench.js';

afterAll(cleanupTempDirs);

function setup(auto = true, host = true) {
  const home = makeHome();
  const workspace = makeGovernance(home, { workbuddyFlag: host, readyRuntime: true });
  const configPath = path.join(workspace, '.pd', 'config.yaml');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    features: Record<string, { enabled: boolean; category: string }>;
  };
  config.features.workbuddy_live_keyword_pain = { enabled: auto, category: 'quiet' };
  fs.writeFileSync(configPath, JSON.stringify(config));
  makeTrajectory(workspace);
  const payload = fixturePayload('user-prompt-submit.json', {
    cwd: makeProjectDir(home, 'keyword'),
    prompt: '这是错的，应该先确认用户要求',
    is_internal_continuation: false,
    generation_id: 'native-p0-turn-1',
  });
  return { home, workspace, payload };
}
function rows(workspace: string, sql: string) {
  const db = new Database(path.join(workspace, '.state', 'trajectory.db'), { readonly: true });
  try { return db.prepare(sql).all() as Record<string, unknown>[]; } finally { db.close(); }
}
function invoke(ws: ReturnType<typeof setup>, overrides: Record<string, unknown> = {}) {
  return runEntry(ws.home, JSON.stringify({ ...ws.payload, ...overrides }), 'UserPromptSubmit');
}
describe('P0 WorkBuddy live keyword Pain', () => {
  it('writes one canonical Pain and one task with a real Pain sourceRef (no transcript)', () => {
    const ws = setup();
    const r = invoke(ws, { transcript_path: path.join(ws.home, 'must-not-open.jsonl') });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    const pains = rows(ws.workspace, 'SELECT canonical_pain_id, host_kind, source FROM pain_events');
    expect(pains).toHaveLength(1);
    expect(pains[0]).toMatchObject({ canonical_pain_id: expect.any(String), host_kind: 'workbuddy', source: 'user_correction' });
    const markers = rows(ws.workspace, 'SELECT task_payload_json, diagnostician_task_id FROM governance_signal_admissions');
    expect(markers).toHaveLength(1);
    const marker = markers[0]!;
    expect(marker.diagnostician_task_id).toEqual(expect.any(String));
    const payload = JSON.parse(String(marker.task_payload_json)) as { evidence: { sourceRef: string }[]; hostKind: string };
    expect(payload.hostKind).toBe('workbuddy');
    expect(payload.evidence).toHaveLength(1);
    expect(payload.evidence[0]!.sourceRef).toBe('pain_event:' + pains[0]!.canonical_pain_id);
    expect(fs.existsSync(path.join(ws.home, 'must-not-open.jsonl'))).toBe(false);
    const state = new Database(path.join(ws.workspace, '.pd', 'state.db'), { readonly: true });
    try {
      expect(state.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind='diagnostician'").get()).toEqual({ n: 1 });
    } finally { state.close(); }
  });
  it('is off by default or if host is off and preserves existing explicit paths', () => {
    for (const ws of [setup(false), setup(true, false)]) {
      expect(invoke(ws).status).toBe(0);
      expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(0);
    }
    const ws = setup(true);
    const explicit = invoke(ws, { prompt: 'PD记录痛苦：这是错的' });
    expect(explicit.status).toBe(0);
    expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(1);
    expect(rows(ws.workspace, 'SELECT * FROM governance_signal_admissions')).toHaveLength(1);
  });
  it('deduplicates replay, but preserves independent native turns', () => {
    const ws = setup();
    expect(invoke(ws).status).toBe(0);
    expect(invoke(ws).status).toBe(0);
    expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(1);
    expect(invoke(ws, { generation_id: 'native-p0-turn-2' }).status).toBe(0);
    expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(2);
    expect(rows(ws.workspace, 'SELECT * FROM governance_signal_admissions')).toHaveLength(2);
  });
  it('ignores internal continuations, missing native ids, quotes, empathy, weak and oversized prompts', () => {
    const ws = setup();
    for (const overrides of [
      { is_internal_continuation: true },
      { is_internal_continuation: undefined },
      { generation_id: undefined },
      { prompt: '他说这是错的，其实是在引用第三方' },
      { prompt: '> 这是错的' },
      { prompt: '搞什么呀' },
      { prompt: '不对，再想想' },
      { prompt: '这是错的' + 'a'.repeat(18_000) },
    ]) {
      const result = invoke(ws, overrides);
      expect(result.status).toBe(0);
    }
    expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(0);
  });
  it('respects shared five-per-hour limit', () => {
    const ws = setup();
    for (let i = 0; i < 6; i += 1) expect(invoke(ws, { generation_id: 'quota-' + i }).status).toBe(0);
    expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(5);
  });

  // AUDIT-P3-01 (2026-10-21): 共享学习词库接入——其他宿主积累的 earned-high
  // 学习词在 WorkBuddy 真实 hook 链路生效；未达门槛的学习词与转述不触发。
  it('learned earned-high term from the shared store triggers one Pain through the real hook', () => {
    const ws = setup();
    fs.writeFileSync(path.join(ws.workspace, '.state', 'correction_keywords.json'), JSON.stringify({
      keywords: [
        { term: '方向完全反了', weight: 0.9, source: 'llm', truePositiveCount: 3, falsePositiveCount: 0 },
        { term: '可能不太对', weight: 0.9, source: 'llm', truePositiveCount: 1, falsePositiveCount: 0 },
      ],
    }));
    // earned-high 学习词开局 → 恰一条 Pain。
    expect(invoke(ws, { prompt: '方向完全反了，停下', generation_id: 'native-learned-1' }).status).toBe(0);
    expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(1);
    expect(rows(ws.workspace, 'SELECT host_kind FROM pain_events')[0]).toMatchObject({ host_kind: 'workbuddy' });
    // 未达 high 门槛的学习词（TP=1）→ 零新增。
    expect(invoke(ws, { prompt: '可能不太对', generation_id: 'native-learned-2' }).status).toBe(0);
    expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(1);
    // 转述（词不在句首）→ 零新增（startsWith 预过滤不因学习词放宽）。
    expect(invoke(ws, { prompt: '他说方向完全反了', generation_id: 'native-learned-3' }).status).toBe(0);
    expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(1);
    // P0 四词行为不回归。
    expect(invoke(ws, { generation_id: 'native-learned-4' }).status).toBe(0);
    expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(2);
  });
});
