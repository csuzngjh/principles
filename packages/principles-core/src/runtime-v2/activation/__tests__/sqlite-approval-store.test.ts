import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteApprovalQueueStore } from '../sqlite-approval-store.js';
import { SqliteConnection } from '../../store/sqlite-connection.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

function createTestConnection(): SqliteConnection {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-test-approval-'));
  return new SqliteConnection(tmpDir);
}

describe('SqliteApprovalQueueStore', () => {
  let connection = null as unknown as SqliteConnection;
  let store = null as unknown as SqliteApprovalQueueStore;

  beforeEach(() => {
    connection = createTestConnection();
    store = new SqliteApprovalQueueStore(connection);
  });

  afterEach(() => {
    connection?.close();
  });

  it('enqueue creates a pending record', async () => {
    const record = await store.enqueue({
      artifactId: 'art-1',
      channel: 'code_tool_hook',
      riskLevel: 'high',
      confidence: 0.8,
    }, '2026-05-18T00:00:00Z');
    expect(record.approvalId).toBeTruthy();
    expect(record.status).toBe('pending');
    expect(record.artifactId).toBe('art-1');
    expect(record.channel).toBe('code_tool_hook');
    expect(record.riskLevel).toBe('high');
    expect(record.confidence).toBe(0.8);
  });

  it('getById returns the record', async () => {
    const created = await store.enqueue({
      artifactId: 'art-1',
      channel: 'skill',
      riskLevel: 'medium',
    }, '2026-05-18T00:00:00Z');
    const found = await store.getById(created.approvalId);
    expect(found).not.toBeNull();
    const { artifactId } = found as typeof found & {};
    expect(artifactId).toBe('art-1');
  });

  it('getById returns null for missing record', async () => {
    const found = await store.getById('nonexistent');
    expect(found).toBeNull();
  });

  it('listPending returns only pending records', async () => {
    await store.enqueue({ artifactId: 'art-1', channel: 'code_tool_hook', riskLevel: 'high' }, '2026-05-18T00:00:00Z');
    await store.enqueue({ artifactId: 'art-2', channel: 'model_training', riskLevel: 'critical' }, '2026-05-18T00:00:00Z');
    const pending = await store.listPending();
    expect(pending).toHaveLength(2);
  });

  it('listPending filters by channel', async () => {
    await store.enqueue({ artifactId: 'art-1', channel: 'code_tool_hook', riskLevel: 'high' }, '2026-05-18T00:00:00Z');
    await store.enqueue({ artifactId: 'art-2', channel: 'model_training', riskLevel: 'critical' }, '2026-05-18T00:00:00Z');
    const pending = await store.listPending({ channel: 'model_training' });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.channel).toBe('model_training');
  });

  it('approve changes status to approved', async () => {
    const created = await store.enqueue({ artifactId: 'art-1', channel: 'code_tool_hook', riskLevel: 'high' }, '2026-05-18T00:00:00Z');
    const result = await store.approve(created.approvalId, 'user-1', 'LGTM');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.status).toBe('approved');
      expect(result.record.decidedBy).toBe('user-1');
      expect(result.record.decisionNote).toBe('LGTM');
    }
  });

  it('reject changes status to rejected', async () => {
    const created = await store.enqueue({ artifactId: 'art-1', channel: 'code_tool_hook', riskLevel: 'high' }, '2026-05-18T00:00:00Z');
    const result = await store.reject(created.approvalId, 'user-1', 'dangerous');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.status).toBe('rejected');
      expect(result.record.rejectionReason).toBe('dangerous');
    }
  });

  it('approve returns error for already-approved record', async () => {
    const created = await store.enqueue({ artifactId: 'art-1', channel: 'code_tool_hook', riskLevel: 'high' }, '2026-05-18T00:00:00Z');
    await store.approve(created.approvalId, 'user-1');
    const result = await store.approve(created.approvalId, 'user-2');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('already_decided');
    }
  });

  it('approve returns not_found for missing record', async () => {
    const result = await store.approve('nonexistent', 'user-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('not_found');
    }
  });

  it('enqueue is idempotent for same artifact+channel', async () => {
    const r1 = await store.enqueue({ artifactId: 'art-1', channel: 'code_tool_hook', riskLevel: 'high' }, '2026-05-18T00:00:00Z');
    const r2 = await store.enqueue({ artifactId: 'art-1', channel: 'code_tool_hook', riskLevel: 'high' }, '2026-05-19T00:00:00Z');
    expect(r1.approvalId).toBe(r2.approvalId);
    expect(r1.requestedAt).toBe(r2.requestedAt);
    expect(r1.requestedAt).toBe('2026-05-18T00:00:00Z');
    const pending = await store.listPending();
    expect(pending).toHaveLength(1);
  });

  it('listPending filters by riskLevel', async () => {
    await store.enqueue({ artifactId: 'art-1', channel: 'code_tool_hook', riskLevel: 'high' }, '2026-05-18T00:00:00Z');
    await store.enqueue({ artifactId: 'art-2', channel: 'model_training', riskLevel: 'critical' }, '2026-05-18T00:00:00Z');
    const pending = await store.listPending({ riskLevel: 'critical' });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.channel).toBe('model_training');
  });

  it('reject returns error for already-rejected record', async () => {
    const created = await store.enqueue({ artifactId: 'art-1', channel: 'code_tool_hook', riskLevel: 'high' }, '2026-05-18T00:00:00Z');
    await store.reject(created.approvalId, 'user-1', 'dangerous');
    const result = await store.reject(created.approvalId, 'user-2', 'also bad');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('already_decided');
    }
  });
});
