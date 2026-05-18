/* eslint-disable @typescript-eslint/init-declarations */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryApprovalQueueStore } from '../memory-approval-store.js';
import { SqliteApprovalQueueStore } from '../sqlite-approval-store.js';
import { SqliteConnection } from '../../store/sqlite-connection.js';
import type { ApprovalEnqueueInput } from '../activation-types.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

function makeEnqueueInput(overrides: Partial<ApprovalEnqueueInput> = {}): ApprovalEnqueueInput {
  return {
    artifactId: 'art-1',
    channel: 'code_tool_hook',
    riskLevel: 'high',
    confidence: 0.85,
    summary: 'A new skill will be activated',
    triggerReason: 'Principle recommends this',
    confidenceExplanation: 'Based on 12 validations',
    effectDescription: 'This will monitor tool calls',
    rejectionEffect: 'The principle will have no enforcement',
    ...overrides,
  };
}

 
describe('MemoryApprovalQueueStore extended', () => {
 
let store!: MemoryApprovalQueueStore;  

  beforeEach(() => { store = new MemoryApprovalQueueStore(); });
  describe('listAll', () => {
    it('returns all records regardless of status', async () => {
      await store.enqueue(makeEnqueueInput({ artifactId: 'art-1' }), '2026-01-01T00:00:00Z');
      await store.enqueue(makeEnqueueInput({ artifactId: 'art-2', channel: 'skill' }), '2026-01-01T00:00:00Z');
      const r3 = await store.enqueue(makeEnqueueInput({ artifactId: 'art-3', channel: 'model_training' }), '2026-01-01T00:00:00Z');
      await store.approve(r3.approvalId, 'user-1');
      const all = await store.listAll();
      expect(all).toHaveLength(3);
    });
    it('filters by status', async () => {
      await store.enqueue(makeEnqueueInput({ artifactId: 'art-1' }), '2026-01-01T00:00:00Z');
      const r2 = await store.enqueue(makeEnqueueInput({ artifactId: 'art-2' }), '2026-01-01T00:00:00Z');
      await store.reject(r2.approvalId, 'user-1', 'bad');
      const pending = await store.listAll({ status: 'pending' });
      expect(pending).toHaveLength(1);
      expect(pending[0]?.status).toBe('pending');
    });
    it('filters by channel', async () => {
      await store.enqueue(makeEnqueueInput({ artifactId: 'art-1', channel: 'code_tool_hook' }), '2026-01-01T00:00:00Z');
      await store.enqueue(makeEnqueueInput({ artifactId: 'art-2', channel: 'skill' }), '2026-01-01T00:00:00Z');
      const result = await store.listAll({ channel: 'skill' });
      expect(result).toHaveLength(1);
      expect(result[0]?.channel).toBe('skill');
    });
    it('paginates results', async () => {
      for (let i = 0; i < 7; i++) {
        await store.enqueue(makeEnqueueInput({ artifactId: 'art-' + i }), '2026-01-01T00:00:00Z');
      }
      const page1 = await store.listAll({ page: 1, pageSize: 3 });
      const page2 = await store.listAll({ page: 2, pageSize: 3 });
      const page3 = await store.listAll({ page: 3, pageSize: 3 });
      expect(page1).toHaveLength(3);
      expect(page2).toHaveLength(3);
      expect(page3).toHaveLength(1);
    });
  });
  describe('countByStatus', () => {
    it('returns correct counts grouped by status', async () => {
      await store.enqueue(makeEnqueueInput({ artifactId: 'art-1' }), '2026-01-01T00:00:00Z');
      await store.enqueue(makeEnqueueInput({ artifactId: 'art-2', channel: 'skill' }), '2026-01-01T00:00:00Z');
      const r3 = await store.enqueue(makeEnqueueInput({ artifactId: 'art-3', channel: 'model_training' }), '2026-01-01T00:00:00Z');
      await store.approve(r3.approvalId, 'user-1');
      const stats = await store.countByStatus();
      expect(stats.pending).toBe(2);
      expect(stats.approved).toBe(1);
      expect(stats.rejected).toBe(0);
      expect(stats.cancelled).toBe(0);
    });
  });
  describe('enqueue with context fields', () => {
    it('stores context fields on the record', async () => {
      const record = await store.enqueue(makeEnqueueInput(), '2026-01-01T00:00:00Z');
      expect(record.summary).toBe('A new skill will be activated');
      expect(record.triggerReason).toBe('Principle recommends this');
      expect(record.confidenceExplanation).toBe('Based on 12 validations');
      expect(record.effectDescription).toBe('This will monitor tool calls');
      expect(record.rejectionEffect).toBe('The principle will have no enforcement');
    });
    it('stores context fields even when optional fields are omitted', async () => {
      const record = await store.enqueue({ artifactId: 'art-1', channel: 'code_tool_hook', riskLevel: 'high' }, '2026-01-01T00:00:00Z');
      expect(record.summary).toBeUndefined();
    });
  });
  describe('getById returns context fields', () => {
    it('returns context fields from stored record', async () => {
      const created = await store.enqueue(makeEnqueueInput(), '2026-01-01T00:00:00Z');
      const record = await store.getById(created.approvalId);
      expect(record).not.toBeNull();
      expect(record?.summary).toBe('A new skill will be activated');
      expect(record?.triggerReason).toBe('Principle recommends this');
    });
  });
});

 
describe('SqliteApprovalQueueStore extended', () => {
 
let store!: SqliteApprovalQueueStore;  

   
   
   
  let connection!: SqliteConnection;  

   
   
   
  let tmpDir!: string;  

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-test-')); connection = new SqliteConnection(path.join(tmpDir, 'test.db')); store = new SqliteApprovalQueueStore(connection); });
  afterEach(() => { connection.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });
  describe('listAll', () => {
    it('returns all records regardless of status', async () => {
      await store.enqueue(makeEnqueueInput({ artifactId: 'art-1' }), '2026-01-01T00:00:00Z');
      await store.enqueue(makeEnqueueInput({ artifactId: 'art-2', channel: 'skill' }), '2026-01-01T00:00:00Z');
      const r3 = await store.enqueue(makeEnqueueInput({ artifactId: 'art-3', channel: 'model_training' }), '2026-01-01T00:00:00Z');
      await store.approve(r3.approvalId, 'user-1');
      const all = await store.listAll();
      expect(all).toHaveLength(3);
    });
    it('filters by status', async () => {
      await store.enqueue(makeEnqueueInput({ artifactId: 'art-1' }), '2026-01-01T00:00:00Z');
      const r2 = await store.enqueue(makeEnqueueInput({ artifactId: 'art-2' }), '2026-01-01T00:00:00Z');
      await store.reject(r2.approvalId, 'user-1', 'bad');
      const pending = await store.listAll({ status: 'pending' });
      expect(pending).toHaveLength(1);
      expect(pending[0]?.status).toBe('pending');
    });
    it('filters by channel', async () => {
      await store.enqueue(makeEnqueueInput({ artifactId: 'art-1', channel: 'code_tool_hook' }), '2026-01-01T00:00:00Z');
      await store.enqueue(makeEnqueueInput({ artifactId: 'art-2', channel: 'skill' }), '2026-01-01T00:00:00Z');
      const result = await store.listAll({ channel: 'skill' });
      expect(result).toHaveLength(1);
      expect(result[0]?.channel).toBe('skill');
    });
    it('paginates results', async () => {
      for (let i = 0; i < 7; i++) {
        await store.enqueue(makeEnqueueInput({ artifactId: 'art-' + i }), '2026-01-01T00:00:00Z');
      }
      const page1 = await store.listAll({ page: 1, pageSize: 3 });
      const page2 = await store.listAll({ page: 2, pageSize: 3 });
      const page3 = await store.listAll({ page: 3, pageSize: 3 });
      expect(page1).toHaveLength(3);
      expect(page2).toHaveLength(3);
      expect(page3).toHaveLength(1);
    });
  });
  describe('countByStatus', () => {
    it('returns correct counts grouped by status', async () => {
      await store.enqueue(makeEnqueueInput({ artifactId: 'art-1' }), '2026-01-01T00:00:00Z');
      await store.enqueue(makeEnqueueInput({ artifactId: 'art-2', channel: 'skill' }), '2026-01-01T00:00:00Z');
      const r3 = await store.enqueue(makeEnqueueInput({ artifactId: 'art-3', channel: 'model_training' }), '2026-01-01T00:00:00Z');
      await store.approve(r3.approvalId, 'user-1');
      const stats = await store.countByStatus();
      expect(stats.pending).toBe(2);
      expect(stats.approved).toBe(1);
      expect(stats.rejected).toBe(0);
      expect(stats.cancelled).toBe(0);
    });
  });
  describe('enqueue with context fields', () => {
    it('stores context fields on the record', async () => {
      const record = await store.enqueue(makeEnqueueInput(), '2026-01-01T00:00:00Z');
      expect(record.summary).toBe('A new skill will be activated');
      expect(record.triggerReason).toBe('Principle recommends this');
      expect(record.confidenceExplanation).toBe('Based on 12 validations');
      expect(record.effectDescription).toBe('This will monitor tool calls');
      expect(record.rejectionEffect).toBe('The principle will have no enforcement');
    });
  });
  describe('getById returns context fields', () => {
    it('returns context fields from stored record', async () => {
      const created = await store.enqueue(makeEnqueueInput(), '2026-01-01T00:00:00Z');
      const record = await store.getById(created.approvalId);
      expect(record).not.toBeNull();
      expect(record?.summary).toBe('A new skill will be activated');
      expect(record?.triggerReason).toBe('Principle recommends this');
    });
  });
 
 
});