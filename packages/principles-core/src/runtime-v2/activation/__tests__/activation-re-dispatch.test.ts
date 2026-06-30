/**
 * Bug-Q fix: verify that a deactivated activation can be re-dispatched.
 *
 * Root cause: getActivationStatus (both SQLite and Memory stores) did not filter
 * out deactivated records. So checkIdempotency returned `already_activated` even
 * for deactivated artifacts, blocking legitimate re-activation.
 *
 * Fix: getActivationStatus now filters `deactivated_at IS NULL` (SQLite) /
 * `record.deactivatedAt === null` (Memory). The dispatcher's checkIdempotency
 * logic is unchanged — it relies on the store layer's filtering.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ActivationDispatcher,
  PromptWriter,
  DeferArchiveWriter,
  MemoryActivationStateStore,
  MemoryArtifactReadModel,
} from '../index.js';
import type { PIArtifactSnapshot, DispatchInput, ActivationStatusRecord } from '../index.js';
import { SqliteActivationStateStore } from '../sqlite-activation-state-store.js';
import type { SqliteConnection } from '../../store/sqlite-connection.js';

function makePrincipleArtifact(overrides: Partial<PIArtifactSnapshot> = {}): PIArtifactSnapshot {
  return {
    artifactId: 'art-001',
    artifactKind: 'principle',
    sourceTaskId: 'task-001',
    sourcePrincipleId: 'P_001',
    lineageArtifactIds: [],
    validationStatus: 'validated',
    contentJson: JSON.stringify({ principleId: 'P_001', text: 'Test principle' }),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeDispatchInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    artifactId: 'art-001',
    channel: 'prompt',
    rolloutDecision: 'auto_activate',
    actor: { kind: 'system', source: 'rollout_reviewer' },
    now: '2026-05-17T00:00:00.000Z',
    confirm: false,
    ...overrides,
  };
}

describe('Bug-Q: re-dispatch after deactivation', () => {
  describe('RD-01: SqliteActivationStateStore.getActivationStatus filters deactivated_at', () => {
    const mockDb = { prepare: vi.fn() };
    const mockConnection = { getDb: vi.fn(() => mockDb) } as unknown as SqliteConnection;

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('SQL filter excludes deactivated records (Bug-Q fix)', async () => {
      // Mock returns undefined to simulate the SQL filter removing deactivated rows.
      // We verify the SQL itself contains the new `deactivated_at IS NULL` clause,
      // which is the actual Bug-Q fix. (Mock cannot execute SQL filtering for real.)
      const mockGet = vi.fn().mockReturnValue(undefined);
      mockDb.prepare.mockReturnValue({ get: mockGet });

      const store = new SqliteActivationStateStore(mockConnection);
      const result = await store.getActivationStatus('art-001::prompt');

      expect(result).toBeNull();

      // Bug-Q fix: verify the SQL contains the new filter clause.
      const sqlCall = mockDb.prepare.mock.calls[0]?.[0] as string;
      expect(sqlCall).toContain('deactivated_at IS NULL');
    });

    it('returns record when deactivated_at is null (currently active)', async () => {
      const mockGet = vi.fn().mockReturnValue({
        activation_id: 'act_001',
        idempotency_key: 'art-001::prompt',
        artifact_id: 'art-001',
        channel: 'prompt',
        action: 'prompt_activate',
        target_ref: 'ledger://P_001',
        activated_at: '2026-05-17T00:00:00.000Z',
        deactivated_at: null,
      });
      mockDb.prepare.mockReturnValue({ get: mockGet });

      const store = new SqliteActivationStateStore(mockConnection);
      const result = await store.getActivationStatus('art-001::prompt');

      expect(result).not.toBeNull();
      expect(result?.activationId).toBe('act_001');
    });
  });

  describe('RD-02: MemoryActivationStateStore.getActivationStatus filters deactivatedAt', () => {
    it('returns null when record is deactivated', async () => {
      const store = new MemoryActivationStateStore();
      const record: ActivationStatusRecord = {
        activationId: 'act-001',
        idempotencyKey: 'art-001::prompt',
        artifactId: 'art-001',
        channel: 'prompt',
        action: 'prompt_activate',
        targetRef: 'ledger://P_001',
        activatedAt: '2026-05-17T00:00:00.000Z',
        deactivatedAt: '2026-06-01T00:00:00.000Z',
      };
      await store.recordActivation(record);

      const result = await store.getActivationStatus('art-001::prompt');

      // Bug-Q fix: deactivated record must be filtered out.
      expect(result).toBeNull();
    });

    it('returns record when not deactivated', async () => {
      const store = new MemoryActivationStateStore();
      const record: ActivationStatusRecord = {
        activationId: 'act-001',
        idempotencyKey: 'art-001::prompt',
        artifactId: 'art-001',
        channel: 'prompt',
        action: 'prompt_activate',
        targetRef: 'ledger://P_001',
        activatedAt: '2026-05-17T00:00:00.000Z',
        deactivatedAt: null,
      };
      await store.recordActivation(record);

      const result = await store.getActivationStatus('art-001::prompt');
      expect(result).not.toBeNull();
      expect(result?.activationId).toBe('act-001');
    });
  });

  describe('RD-03: dispatcher allows re-dispatch after deactivate', () => {
    function makeDispatcher() {
      const stateStore = new MemoryActivationStateStore();
      const artifactStore = new MemoryArtifactReadModel();
      const promptWriter = new PromptWriter();
      const archiveWriter = new DeferArchiveWriter();
      const dispatcher = new ActivationDispatcher(
        artifactStore,
        stateStore,
        { writers: [promptWriter, archiveWriter] },
      );
      return { stateStore, artifactStore, dispatcher };
    }

    it('re-dispatch after deactivate returns "activated" (not "already_activated")', async () => {
      const { stateStore, artifactStore, dispatcher } = makeDispatcher();
      artifactStore.addArtifact(makePrincipleArtifact());

      // First dispatch: confirm → activated
      const first = await dispatcher.dispatch(makeDispatchInput({ confirm: true }));
      expect(first.decision).toBe('activated');

      // Second dispatch without deactivating: should be already_activated (idempotent)
      const second = await dispatcher.dispatch(makeDispatchInput({ confirm: true }));
      expect(second.decision).toBe('already_activated');

      // Now deactivate the activation
      const deactivated = await stateStore.deactivateActivation('act_prompt_P_001', '2026-06-01T00:00:00.000Z');
      expect(deactivated).toBe(true);

      // Bug-Q fix: third dispatch should succeed (not already_activated)
      const third = await dispatcher.dispatch(makeDispatchInput({ confirm: true }));
      expect(third.decision).toBe('activated');
      if (third.decision === 'activated') {
        // New activation record has a new activatedAt (re-activation timestamp).
        expect(third.activationId).toBe('act_prompt_P_001');
      }

      // Verify that getActivationStatus now returns the new active record (not null).
      const status = await stateStore.getActivationStatus('art-001::prompt');
      expect(status).not.toBeNull();
      expect(status?.deactivatedAt).toBeNull();
    });
  });
});
