/**
 * SqliteIntentDecisionStore tests (PRI-470).
 *
 * Verifies idempotency, snapshot storage, evidence truncation, ordering, and
 * summary aggregation against a real SQLite database.
 *
 * ERR checklist:
 * - EP-01 / ERR-001, ERR-005: store treats DB rows as unknown and validates via guards
 * - EP-03 / ERR-002: write failures throw (fail loud), never silent
 * - EP-07 / ERR-015, ERR-018: idempotency distinguishes current vs recorded state
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { SqliteConnection } from '../../sqlite-connection.js';
import { SqliteIntentDecisionStore } from '../sqlite-intent-decision-store.js';
import type { IntentDecisionInput } from '../../../intent/intent-decision-record.js';

function createTestConnection(): SqliteConnection {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-test-intent-decision-'));
  return new SqliteConnection(tmpDir);
}

function makeInput(overrides: Partial<IntentDecisionInput> = {}): IntentDecisionInput {
  return {
    id: 'rec-' + Math.random().toString(36).slice(2, 8),
    painId: 'pain-1',
    taskId: 'task-1',
    runId: 'run-1',
    intentDocHash: 'sha256:abc',
    source: 'action_drift',
    evidenceStrength: 'moderate',
    relatedIntentFields: ['why'],
    ownerAction: 'confirm_drift',
    evidenceRefs: ['ref-1', 'ref-2'],
    ...overrides,
  };
}

describe('SqliteIntentDecisionStore', () => {
  let connection = null as unknown as SqliteConnection;
  let store = null as unknown as SqliteIntentDecisionStore;

  beforeEach(() => {
    connection = createTestConnection();
    // Touch getDb() so the schema (including intent_decisions) is initialized.
    connection.getDb();
    store = new SqliteIntentDecisionStore(connection);
  });

  afterEach(() => {
    connection?.close();
  });

  describe('record()', () => {
    it('creates a new record with correct fields', async () => {
      const input = makeInput({ id: 'rec-new' });
      const result = await store.record(input);
      expect(result.created).toBe(true);
      expect(result.record.id).toBe('rec-new');
      expect(result.record.painId).toBe('pain-1');
      expect(result.record.taskId).toBe('task-1');
      expect(result.record.source).toBe('action_drift');
      expect(result.record.evidenceStrength).toBe('moderate');
      expect(result.record.relatedIntentFields).toEqual(['why']);
      expect(result.record.ownerAction).toBe('confirm_drift');
      expect(result.record.evidenceRefs).toEqual(['ref-1', 'ref-2']);
      expect(result.record.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('is idempotent when same painId + intentDocHash + ownerAction is resubmitted', async () => {
      const input = makeInput({ id: 'rec-first', painId: 'pain-1', intentDocHash: 'sha256:abc', ownerAction: 'confirm_drift' });
      const first = await store.record(input);
      expect(first.created).toBe(true);

      // Same idempotency key, different id — must return the existing record.
      const replay = await store.record(makeInput({ id: 'rec-second', painId: 'pain-1', intentDocHash: 'sha256:abc', ownerAction: 'confirm_drift' }));
      expect(replay.created).toBe(false);
      expect(replay.record.id).toBe('rec-first');
    });

    it('does NOT treat different ownerAction as idempotent', async () => {
      await store.record(makeInput({ id: 'rec-a', painId: 'pain-1', intentDocHash: 'sha256:abc', ownerAction: 'confirm_drift' }));
      const second = await store.record(makeInput({ id: 'rec-b', painId: 'pain-1', intentDocHash: 'sha256:abc', ownerAction: 'observe' }));
      expect(second.created).toBe(true);
      expect(second.record.id).toBe('rec-b');
    });

    it('with null painId uses taskId-based idempotency', async () => {
      const input = makeInput({
        id: 'rec-task-1',
        painId: undefined,
        taskId: 'task-X',
        intentDocHash: 'sha256:xyz',
        ownerAction: 'dismiss',
      });
      const first = await store.record(input);
      expect(first.created).toBe(true);

      const replay = await store.record(makeInput({
        id: 'rec-task-2',
        painId: undefined,
        taskId: 'task-X',
        intentDocHash: 'sha256:xyz',
        ownerAction: 'dismiss',
      }));
      expect(replay.created).toBe(false);
      expect(replay.record.id).toBe('rec-task-1');
    });

    it('with null painId and null intentDocHash still idempotency-checks via IS operator', async () => {
      await store.record(makeInput({
        id: 'rec-null-1', painId: undefined, taskId: 'task-Y', intentDocHash: undefined, ownerAction: 'observe',
      }));
      const replay = await store.record(makeInput({
        id: 'rec-null-2', painId: undefined, taskId: 'task-Y', intentDocHash: undefined, ownerAction: 'observe',
      }));
      expect(replay.created).toBe(false);
      expect(replay.record.id).toBe('rec-null-1');
    });

    it('truncates evidence to max 3 items', async () => {
      const input = makeInput({ id: 'rec-trunc', evidenceRefs: ['r1', 'r2', 'r3', 'r4', 'r5'] });
      const result = await store.record(input);
      expect(result.record.evidenceRefs).toEqual(['r1', 'r2', 'r3']);
    });

    it('stores immutable snapshots matching the decision-time values', async () => {
      const input = makeInput({
        id: 'rec-snap',
        source: 'intent_suspect',
        evidenceStrength: 'strong',
        relatedIntentFields: ['why', 'desired_outcome'],
        evidenceRefs: ['e1', 'e2'],
      });
      const result = await store.record(input);
      // Read the raw row to verify snapshot columns exist and match.
      const row = connection.getDb().prepare('SELECT source_snapshot, evidence_strength_snapshot, related_intent_fields_snapshot, evidence_refs_snapshot FROM intent_decisions WHERE id = ?').get(result.record.id) as {
        source_snapshot: string;
        evidence_strength_snapshot: string;
        related_intent_fields_snapshot: string;
        evidence_refs_snapshot: string;
      };
      expect(row.source_snapshot).toBe('intent_suspect');
      expect(row.evidence_strength_snapshot).toBe('strong');
      expect(JSON.parse(row.related_intent_fields_snapshot)).toEqual(['why', 'desired_outcome']);
      expect(JSON.parse(row.evidence_refs_snapshot)).toEqual(['e1', 'e2']);
    });

    it('persists the optional note when provided', async () => {
      const result = await store.record(makeInput({ id: 'rec-note', note: 'owner note text' }));
      const row = connection.getDb().prepare('SELECT note FROM intent_decisions WHERE id = ?').get(result.record.id) as { note: string | null };
      expect(row.note).toBe('owner note text');
    });
  });

  describe('getById()', () => {
    it('returns the record when found', async () => {
      const created = await store.record(makeInput({ id: 'rec-get' }));
      const found = await store.getById('rec-get');
      expect(found).not.toBeNull();
      expect(found?.id).toBe('rec-get');
      expect(found?.source).toBe(created.record.source);
    });

    it('returns null when not found', async () => {
      const found = await store.getById('does-not-exist');
      expect(found).toBeNull();
    });
  });

  describe('listByPainId()', () => {
    it('returns records ordered by createdAt DESC', async () => {
      await store.record(makeInput({ id: 'r1', painId: 'pain-list', ownerAction: 'confirm_drift' }));
      await new Promise((r) => setTimeout(r, 10));
      await store.record(makeInput({ id: 'r2', painId: 'pain-list', ownerAction: 'observe', intentDocHash: 'sha256:other' }));
      const list = await store.listByPainId('pain-list');
      expect(list).toHaveLength(2);
      expect(list[0]?.id).toBe('r2');
      expect(list[1]?.id).toBe('r1');
    });

    it('returns empty array for unknown painId', async () => {
      const list = await store.listByPainId('unknown');
      expect(list).toEqual([]);
    });
  });

  describe('listByTaskId()', () => {
    it('returns records ordered by createdAt DESC', async () => {
      await store.record(makeInput({ id: 't1', taskId: 'task-list', painId: 'p1', intentDocHash: 'h1', ownerAction: 'confirm_drift' }));
      await new Promise((r) => setTimeout(r, 10));
      await store.record(makeInput({ id: 't2', taskId: 'task-list', painId: 'p2', intentDocHash: 'h2', ownerAction: 'observe' }));
      const list = await store.listByTaskId('task-list');
      expect(list).toHaveLength(2);
      expect(list[0]?.id).toBe('t2');
      expect(list[1]?.id).toBe('t1');
    });

    it('returns empty array for unknown taskId', async () => {
      const list = await store.listByTaskId('unknown');
      expect(list).toEqual([]);
    });
  });

  describe('getSummary()', () => {
    it('returns all-zero counts and null lastDecisionAt when no records exist', async () => {
      const summary = await store.getSummary();
      expect(summary.lastDecisionAt).toBeNull();
      expect(summary.counts).toEqual({
        confirm_drift: 0,
        revise_intent: 0,
        observe: 0,
        dismiss: 0,
        promote_to_principle: 0,
        promote_to_rulehost: 0,
      });
    });

    it('returns counts per ownerAction and the most recent lastDecisionAt', async () => {
      await store.record(makeInput({ id: 's1', painId: 'p1', intentDocHash: 'h1', ownerAction: 'confirm_drift' }));
      await store.record(makeInput({ id: 's2', painId: 'p2', intentDocHash: 'h2', ownerAction: 'confirm_drift' }));
      await store.record(makeInput({ id: 's3', painId: 'p3', intentDocHash: 'h3', ownerAction: 'observe' }));
      const summary = await store.getSummary();
      expect(summary.counts.confirm_drift).toBe(2);
      expect(summary.counts.observe).toBe(1);
      expect(summary.counts.dismiss).toBe(0);
      expect(summary.counts.revise_intent).toBe(0);
      expect(summary.counts.promote_to_principle).toBe(0);
      expect(summary.counts.promote_to_rulehost).toBe(0);
      expect(summary.lastDecisionAt).not.toBeNull();
    });
  });
});
