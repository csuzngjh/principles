/**
 * PRI-566: Governance actions audit log unit tests.
 *
 * Mirrors recovery-actions-log coverage: append/list round-trip, validation
 * guards, corrupt-line tolerance, bounded reason, and the rc-5 prototype-
 * pollution negative control.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { appendGovernanceAction, listGovernanceActions } from '../governance-actions-log.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-audit-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function logPath(): string {
  return path.join(tmpDir, '.state', 'governance_actions.jsonl');
}

describe('appendGovernanceAction', () => {
  it('writes one JSON line under .state/governance_actions.jsonl', () => {
    const rec = appendGovernanceAction(tmpDir, {
      action: 'deactivate',
      activationId: 'act_test_1',
      operator: 'cli',
      reason: 'owner requested rollback',
    });

    expect(rec.actionId).toBeTruthy();
    expect(rec.action).toBe('deactivate');
    expect(rec.activationId).toBe('act_test_1');
    expect(rec.operator).toBe('cli');
    expect(rec.reason).toBe('owner requested rollback');
    expect(rec.createdAt).toBeTruthy();

    const raw = fs.readFileSync(logPath(), 'utf-8').trim().split('\n');
    expect(raw).toHaveLength(1);
    const parsed: unknown = JSON.parse(raw[0] ?? '{}');
    expect(typeof parsed === 'object' && parsed !== null && Object.hasOwn(parsed, 'actionId')).toBe(true);
  });

  it('creates the .state directory when missing', () => {
    expect(fs.existsSync(path.join(tmpDir, '.state'))).toBe(false);
    appendGovernanceAction(tmpDir, { action: 'promote', activationId: 'act_x', operator: 'console' });
    expect(fs.existsSync(logPath())).toBe(true);
  });

  it('normalizes missing reason to null and keeps channel when provided', () => {
    const rec = appendGovernanceAction(tmpDir, {
      action: 'promote',
      activationId: 'act_y',
      operator: 'cli',
      channel: 'code_tool_hook',
    });
    expect(rec.reason).toBeNull();
    expect(rec.channel).toBe('code_tool_hook');
  });

  it('bounds reason text to 2000 chars (rc-8)', () => {
    const rec = appendGovernanceAction(tmpDir, {
      action: 'deactivate',
      activationId: 'act_z',
      operator: 'cli',
      reason: 'x'.repeat(3000),
    });
    expect((rec.reason ?? '').length).toBe(2000);
  });

  it('rejects unknown action kinds (fail loud, rc-3)', () => {
    expect(() =>
      appendGovernanceAction(tmpDir, {
        action: 'pause' as never,
        activationId: 'act_a',
        operator: 'cli',
      }),
    ).toThrow(/Invalid governance action/);
  });

  it('rejects unknown operators (fail loud, rc-3)', () => {
    expect(() =>
      appendGovernanceAction(tmpDir, {
        action: 'promote',
        activationId: 'act_b',
        operator: 'agent' as never,
      }),
    ).toThrow(/Invalid governance operator/);
  });

  it('rejects empty activationId (rc-3)', () => {
    expect(() =>
      appendGovernanceAction(tmpDir, {
        action: 'deactivate',
        activationId: '',
        operator: 'cli',
      }),
    ).toThrow(/non-empty activationId/);
  });
});

describe('listGovernanceActions', () => {
  it('returns [] when the log file does not exist (no crash)', () => {
    expect(listGovernanceActions(tmpDir)).toEqual([]);
  });

  it('round-trips appended records oldest-first', () => {
    appendGovernanceAction(tmpDir, { action: 'promote', activationId: 'act_1', operator: 'cli' });
    appendGovernanceAction(tmpDir, { action: 'deactivate', activationId: 'act_2', operator: 'console' });

    const all = listGovernanceActions(tmpDir);
    expect(all).toHaveLength(2);
    expect(all[0]?.action).toBe('promote');
    expect(all[1]?.action).toBe('deactivate');
  });

  it('filters by activationId and by action', () => {
    appendGovernanceAction(tmpDir, { action: 'promote', activationId: 'act_1', operator: 'cli' });
    appendGovernanceAction(tmpDir, { action: 'deactivate', activationId: 'act_2', operator: 'console' });
    appendGovernanceAction(tmpDir, { action: 'deactivate', activationId: 'act_1', operator: 'cli' });

    const byAct = listGovernanceActions(tmpDir, { activationId: 'act_1' });
    expect(byAct).toHaveLength(2);
    expect(byAct.every(r => r.activationId === 'act_1')).toBe(true);

    const byAction = listGovernanceActions(tmpDir, { action: 'deactivate' });
    expect(byAction).toHaveLength(2);
    expect(byAction.every(r => r.action === 'deactivate')).toBe(true);
  });

  it('skips corrupt lines without failing the read (tolerant reader)', () => {
    fs.mkdirSync(path.join(tmpDir, '.state'), { recursive: true });
    const good = JSON.stringify({
      actionId: 'id-1', action: 'promote', activationId: 'act_1',
      operator: 'cli', channel: null, reason: null, createdAt: '2026-08-24T00:00:00.000Z',
    });
    fs.writeFileSync(logPath(), '{corrupt line\n\n' + good + '\n', 'utf-8');

    const records = listGovernanceActions(tmpDir);
    expect(records).toHaveLength(1);
    expect(records[0]?.activationId).toBe('act_1');
  });

  it('negative control (rc-5): a line whose action fails the VALID_ACTIONS check via prototype-polluted keys is rejected by the type guard', () => {
    fs.mkdirSync(path.join(tmpDir, '.state'), { recursive: true });
    // Simulate tampered/polluted record: `in`-based checks would accept
    // inherited properties; our Object.hasOwn guard must reject this shape.
    const polluted = JSON.stringify({
      actionId: 'id-bad',
      action: 'constructor',
      activationId: 'act_bad',
      operator: 'cli',
      channel: null,
      reason: null,
      createdAt: '2026-08-24T00:00:00.000Z',
    });
    const good = JSON.stringify({
      actionId: 'id-good', action: 'deactivate', activationId: 'act_ok',
      operator: 'console', channel: null, reason: null, createdAt: '2026-08-24T00:00:01.000Z',
    });
    fs.writeFileSync(logPath(), polluted + '\n' + good + '\n', 'utf-8');

    const records = listGovernanceActions(tmpDir);
    expect(records).toHaveLength(1);
    expect(records[0]?.activationId).toBe('act_ok');
  });
});
