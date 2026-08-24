/**
 * RecoveryActionsLog unit tests — Governance Recovery Actions v1 (SPEC §10).
 *
 * Tests the append-only JSONL audit log for owner-triggered recovery actions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { appendRecoveryAction, listRecoveryActions } from '../recovery-actions-log.js';

describe('RecoveryActionsLog', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-actions-log-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('append creates .state/recovery_actions.jsonl', () => {
    appendRecoveryAction(tmpDir, {
      taskId: 'dreamer-chain-1',
      previousStatus: 'failed',
      result: 'recovered',
      operator: 'console',
      reason: 'Owner approved retry after reviewing failure',
    });
    const logPath = path.join(tmpDir, '.state', 'recovery_actions.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);
  });

  it('append returns record with SPEC §10 minimal fields', () => {
    const record = appendRecoveryAction(tmpDir, {
      taskId: 'dreamer-chain-2',
      previousStatus: 'needs_human_review',
      result: 'requeued',
      operator: 'console',
      reason: null,
    });
    expect(typeof record.actionId).toBe('string');
    expect(record.actionId.length).toBeGreaterThan(0);
    expect(record.taskId).toBe('dreamer-chain-2');
    expect(record.action).toBe('recover');
    expect(record.previousStatus).toBe('needs_human_review');
    expect(record.operator).toBe('console');
    expect(record.reason).toBeNull();
    expect(record.createdAt).toBeTruthy();
    expect(record.result).toBe('requeued');
  });

  it('defaults operator to null when omitted', () => {
    const record = appendRecoveryAction(tmpDir, {
      taskId: 't-1',
      previousStatus: 'failed',
      result: 'recovered',
    });
    expect(record.operator).toBeNull();
  });

  it('bounds reason to 2000 characters (rc-8 bounded serialization)', () => {
    const longReason = 'x'.repeat(3000);
    const record = appendRecoveryAction(tmpDir, {
      taskId: 't-2',
      previousStatus: 'failed',
      result: 'recovered',
      reason: longReason,
    });
    expect(record.reason).not.toBeNull();
    expect((record.reason as string).length).toBe(2000);
  });

  it('rejects invalid result values (fail loud, rc-3)', () => {
    expect(() =>
      appendRecoveryAction(tmpDir, {
        taskId: 't-3',
        previousStatus: 'failed',
        // @ts-expect-error — deliberately invalid union member
        result: 'exploded',
      }),
    ).toThrow(/Invalid recovery result/);
  });

  it('list returns records oldest-first and round-trips fields', () => {
    appendRecoveryAction(tmpDir, { taskId: 't-a', previousStatus: 'failed', result: 'recovered', operator: 'console', reason: 'first' });
    appendRecoveryAction(tmpDir, { taskId: 't-b', previousStatus: 'needs_human_review', result: 'requeued' });
    const records = listRecoveryActions(tmpDir);
    expect(records.length).toBe(2);
    expect(records[0]?.taskId).toBe('t-a');
    expect(records[0]?.result).toBe('recovered');
    expect(records[0]?.reason).toBe('first');
    expect(records[1]?.taskId).toBe('t-b');
    expect(records[1]?.operator).toBeNull();
  });

  it('list filters by taskId', () => {
    appendRecoveryAction(tmpDir, { taskId: 't-a', previousStatus: 'failed', result: 'recovered' });
    appendRecoveryAction(tmpDir, { taskId: 't-b', previousStatus: 'failed', result: 'recovered' });
    const records = listRecoveryActions(tmpDir, { taskId: 't-b' });
    expect(records.length).toBe(1);
    expect(records[0]?.taskId).toBe('t-b');
  });

  it('list returns [] when log file does not exist', () => {
    expect(listRecoveryActions(tmpDir)).toEqual([]);
  });

  it('list skips corrupt and shape-invalid lines (rc-1/rc-2)', () => {
    const stateDir = path.join(tmpDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    const logPath = path.join(stateDir, 'recovery_actions.jsonl');
    const good = appendRecoveryAction(tmpDir, { taskId: 't-good', previousStatus: 'failed', result: 'recovered' });
    fs.appendFileSync(
      logPath,
      [
        'not json at all\n',
        JSON.stringify({ taskId: 'missing every other field' }) + '\n',
        JSON.stringify({ actionId: 'x', taskId: 't-wrong-result', action: 'recover', previousStatus: 'failed', operator: null, reason: null, createdAt: 'now', result: 'not-a-real-result' }) + '\n',
      ].join(''),
      'utf-8',
    );
    const records = listRecoveryActions(tmpDir);
    expect(records.length).toBe(1);
    expect(records[0]?.taskId).toBe('t-good');
    expect(records[0]?.actionId).toBe(good.actionId);
  });
});
