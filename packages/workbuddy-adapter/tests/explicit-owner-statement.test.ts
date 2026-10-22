import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { runEntry } from './helpers/hook-runner.js';
import { cleanupTempDirs, fixturePayload, makeGovernance, makeHome, makeProjectDir, makeTrajectory } from './helpers/workbench.js';
afterAll(cleanupTempDirs);
function setup(enabled = true) {
  const home = makeHome(); const workspace = makeGovernance(home, { workbuddyFlag: enabled }); makeTrajectory(workspace);
  return { home, workspace, payload: fixturePayload('user-prompt-submit.json', { cwd: makeProjectDir(home, 'owner'), prompt: 'PD记录痛苦：未核对调用方就修改了公共接口' }) };
}
function rows(workspace: string, sql: string) {
  const db = new Database(path.join(workspace, '.state', 'trajectory.db'), { readonly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}
function invoke(ws: ReturnType<typeof setup>, overrides: Record<string, unknown> = {}) {
  return runEntry(ws.home, JSON.stringify({ ...ws.payload, ...overrides }), 'UserPromptSubmit');
}
describe('current Owner WorkBuddy statement through real production hook', () => {
  it('persists WorkBuddy pain + queued task with unverified Owner words and reports real IDs without reading a transcript', () => {
    const ws = setup(); const text = '反馈'.repeat(250);
    const result = invoke(ws, { prompt: `PD记录痛苦：${text}`, transcript_path: path.join(ws.home, 'must-not-read.jsonl') });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain('host=workbuddy status=received');
    expect(result.stdout).toContain('unverified owner_statement');
    expect(rows(ws.workspace, 'SELECT canonical_pain_id, host_kind, source FROM pain_events')).toEqual([{ canonical_pain_id: expect.any(String), host_kind: 'workbuddy', source: 'user_correction' }]);
    const markers = rows(ws.workspace, 'SELECT task_payload_json, diagnostician_task_id, host_kind FROM governance_signal_admissions') as { task_payload_json: string; diagnostician_task_id: string; host_kind: string }[];
    expect(markers).toHaveLength(1); const marker = markers[0]; expect(marker.host_kind).toBe('workbuddy');
    expect(JSON.parse(marker.task_payload_json)).toMatchObject({ hostKind: 'workbuddy', evidence: [], correctionEvidence: { text, classification: 'owner_statement', channel: 'workbuddy_explicit_prefix' } });
    const db = new Database(path.join(ws.workspace, '.pd', 'state.db'), { readonly: true });
    try {
      const tasks = db.prepare("SELECT task_id, diagnostic_json FROM tasks WHERE task_kind='diagnostician'").all() as { task_id: string; diagnostic_json: string }[];
      expect(db.prepare('SELECT COUNT(*) AS n FROM approvals').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM pi_artifacts').get()).toEqual({ n: 0 });
      expect(tasks).toHaveLength(1); expect(tasks[0].task_id).toBe(marker.diagnostician_task_id);
      expect(tasks[0].diagnostic_json).toContain(text); expect(result.stdout).toContain(marker.diagnostician_task_id);
      expect(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE task_kind != ?').get('diagnostician')).toEqual({ n: 0 });
    } finally { db.close(); }
  });
  it('deduplicates exact resends while independent native turns remain distinct', () => {
    const ws = setup(); expect(invoke(ws).stdout).toContain('status=received');
    expect(invoke(ws).stdout).toContain('disposition=already_admitted');
    expect(rows(ws.workspace, 'SELECT canonical_pain_id FROM pain_events')).toHaveLength(1);
    expect(invoke(ws, { generation_id: 'other-native-turn' }).stdout).toContain('status=received');
    expect(rows(ws.workspace, 'SELECT canonical_pain_id FROM pain_events')).toHaveLength(2);
  });
  for (const [name, override, reason] of [
    ['empty', { prompt: 'PD记录痛苦：  ' }, 'statement_empty'],
    ['too long', { prompt: `PD记录痛苦：${'长'.repeat(501)}` }, 'statement_too_long'],
    ['missing turn', { generation_id: undefined }, 'lineage_invalid'],
    ['internal', { is_internal_continuation: true }, 'owner_source_unverified'],
    ['unverified user origin', { is_internal_continuation: undefined }, 'owner_source_unverified'],
    ['malformed user origin', { is_internal_continuation: 'false' }, 'owner_source_unverified'],
  ] as const) it(`rejects ${name} without pain or task`, () => {
    const ws = setup(); const result = invoke(ws, override); expect(result.status).toBe(0);
    expect(result.stdout).toContain(`status=rejected reason=owner_statement_${reason}`);
    expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(0);
    expect(fs.existsSync(path.join(ws.workspace, '.pd', 'state.db'))).toBe(false);
  });
  it('disabled host creates no statement receipt or pain', () => {
    const ws = setup(false); const result = invoke(ws); expect(result.stdout).toBe(''); expect(result.stderr).toContain('host.workbuddy_disabled');
    expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(0);
  });
  for (const prompt of ['普通纠正反馈', '> PD记录痛苦：引用', '他说 PD记录痛苦：引用']) it(`does not infer explicit submission: ${prompt}`, () => {
    const ws = setup(); expect(invoke(ws, { prompt }).stdout).not.toContain('owner_statement'); expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(0);
  });
  for (const prompt of [' PD记录痛苦：非前缀', 'PD记录痛苦:半角', 'PD记录痛苦']) it(`recovers a near-miss prefix with an actionable format notice: ${prompt}`, () => {
    const ws = setup(); const result = invoke(ws, { prompt }); expect(result.status).toBe(0);
    expect(result.stdout).toContain('status=rejected reason=owner_statement_prefix_format');
    expect(result.stdout).toContain('full-width colon');
    expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(0);
    expect(fs.existsSync(path.join(ws.workspace, '.pd', 'state.db'))).toBe(false);
  });
  it('retains the existing session quota rather than granting explicit intake unlimited admission', () => {
    const ws = setup();
    for (let turn = 0; turn < 5; turn++) expect(invoke(ws, { generation_id: `quota-${turn}` }).stdout).toContain('status=received');
    expect(invoke(ws, { generation_id: 'quota-overflow' }).stdout).toContain('owner_statement_rate_limited');
    expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(5);
  });
  it('does not accept a prompt-shaped payload from a tool registration channel', () => {
    const ws = setup(); const result = runEntry(ws.home, JSON.stringify(ws.payload), 'PostToolUse');
    expect(result.stdout).not.toContain('status=received');
    expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(0);
  });
  it('keeps an admitted pain recoverable when task storage fails, then repairs exactly that task on resend', () => {
    const ws = setup();
    const statePath = path.join(ws.workspace, '.pd', 'state.db');
    fs.mkdirSync(statePath);
    const failed = invoke(ws);
    expect(failed.status).toBe(0);
    expect(failed.stdout).toContain('owner_statement_continuation_failed');
    expect(failed.stdout).toContain('painId=');
    expect(failed.stdout).not.toContain('status=received');
    expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(1);
    fs.rmdirSync(statePath);
    const repaired = invoke(ws);
    expect(repaired.stdout).toContain('status=received');
    expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(1);
    expect(rows(ws.workspace, 'SELECT diagnostician_task_id FROM governance_signal_admissions')).toEqual([{ diagnostician_task_id: expect.any(String) }]);
  });
  it.each([{ session_id: undefined }, { generation_id: '' }, { generation_id: 42 }, { transcript_path: [] }])('invalid native input is a model-visible rejection without invented identity: %j', (invalid) => {
    const ws = setup(); const result = invoke(ws, invalid);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain('status=rejected reason=owner_statement_decode_invalid');
    expect(result.stdout).not.toContain('status=received');
    expect(rows(ws.workspace, 'SELECT * FROM pain_events')).toHaveLength(0);
    expect(fs.existsSync(path.join(ws.workspace, '.pd/state.db'))).toBe(false);
  });
  it('does not add malformed-input context when the host is disabled or the input is not an explicit submission', () => {
    const disabled = setup(false); expect(invoke(disabled, { session_id: undefined }).stdout).toBe('');
    const ordinary = setup(); expect(invoke(ordinary, { session_id: undefined, prompt: 'ordinary message' }).stdout).toBe('');
    expect(invoke(ordinary, { session_id: undefined, hook_event_name: 'PreToolUse' }).stdout).toBe('');
    expect(rows(ordinary.workspace, 'SELECT * FROM pain_events')).toHaveLength(0);
  });
  it('exposes unavailable storage to the model without clearing the user prompt', () => {
    const ws = setup(); fs.rmSync(path.join(ws.workspace, '.state', 'trajectory.db')); const result = invoke(ws);
    expect(result.status).toBe(0); expect(result.stdout).toContain('status=rejected reason=owner_statement_continuation_failed'); expect(result.stdout).not.toContain('status=received');
  });
});
