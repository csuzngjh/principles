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
describe('P0 WorkBuddy live keyword Pain (P1 review round 3: no fabricated evidence)', () => {
  it('has no persisted behavior evidence → observation_only (no Pain, no task, no quota)', () => {
    const ws = setup();
    const r = invoke(ws, { transcript_path: path.join(ws.home, 'must-not-open.jsonl') });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(rows(ws.workspace, 'SELECT canonical_pain_id FROM pain_events')).toHaveLength(0);
    const markers = rows(ws.workspace, 'SELECT decision, reason, task_payload_json, diagnostician_task_id FROM governance_signal_admissions');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ decision: 'abandoned' });
    expect(String(markers[0]!.reason).length).toBeGreaterThan(0);
    expect(markers[0]!.diagnostician_task_id).toBeNull();
    // No `pain_event:` pseudo-trace may be persisted anywhere.
    expect(String(markers[0]!.task_payload_json ?? '')).not.toContain('pain_event:');
    expect(fs.existsSync(path.join(ws.home, 'must-not-open.jsonl'))).toBe(false);
    // No Diagnostician task store was even created: the abandoned marker never
    // reached ensureGovernanceDiagnosticianTask.
    const statePath = path.join(ws.workspace, '.pd', 'state.db');
    if (fs.existsSync(statePath)) {
      const state = new Database(statePath, { readonly: true });
      try {
        expect(state.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind='diagnostician'").get()).toEqual({ n: 0 });
      } finally { state.close(); }
    } else {
      expect(fs.existsSync(statePath)).toBe(false);
    }
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
  it('deduplicates replay, but keeps independent native turns as separate observations', () => {
    const ws = setup();
    expect(invoke(ws).status).toBe(0);
    expect(invoke(ws).status).toBe(0);
    expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(0);
    expect(rows(ws.workspace, 'SELECT * FROM governance_signal_admissions')).toHaveLength(1);
    expect(invoke(ws, { generation_id: 'native-p0-turn-2' }).status).toBe(0);
    expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(0);
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
  it('never consumes the shared five-per-hour quota without real evidence', () => {
    const ws = setup();
    for (let i = 0; i < 6; i += 1) expect(invoke(ws, { generation_id: 'quota-' + i }).status).toBe(0);
    expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(0);
    expect(rows(ws.workspace, 'SELECT * FROM governance_signal_admissions')).toHaveLength(6);
  });

  // SPEC v0.3 §3.2.3 (D5 reverse): learned keywords are Stage-2 candidates only.
  // Without persisted trust evidence they now settle as observation_only.
  it('learned terms never trigger live Pain; P0 seed terms also need real evidence', () => {
    const ws = setup();
    fs.writeFileSync(path.join(ws.workspace, '.state', 'correction_keywords.json'), JSON.stringify({
      keywords: [
        { term: '方向完全反了', weight: 0.9, source: 'llm', truePositiveCount: 3, falsePositiveCount: 0 },
        { term: '可能不太对', weight: 0.9, source: 'llm', truePositiveCount: 1, falsePositiveCount: 0 },
      ],
    }));
    // 历史 TP≥3 的学习词也不再获得 STRONG 直通。
    expect(invoke(ws, { prompt: '方向完全反了，停下', generation_id: 'native-learned-1' }).status).toBe(0);
    expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(0);
    expect(invoke(ws, { prompt: '可能不太对', generation_id: 'native-learned-2' }).status).toBe(0);
    expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(0);
    // 转述（词不在句首）→ 仍为零。
    expect(invoke(ws, { prompt: '他说方向完全反了', generation_id: 'native-learned-3' }).status).toBe(0);
    expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(0);
    // P0 seed 四词仍被识别，但同样没有持久化证据 → observation_only。
    expect(invoke(ws, { generation_id: 'native-learned-4' }).status).toBe(0);
    expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(0);
    expect(rows(ws.workspace, "SELECT decision FROM governance_signal_admissions WHERE decision='abandoned'")).toHaveLength(3);
  });
});
