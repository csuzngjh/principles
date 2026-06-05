import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SqliteActivationStateStore } from '../sqlite-activation-state-store.js';
import type { SqliteConnection } from '../../store/sqlite-connection.js';
import type { ActivationStatusRecord } from '../activation-types.js';

const mockDb = {
  prepare: vi.fn(),
};

const mockConnection = {
  getDb: vi.fn(() => mockDb),
} as unknown as SqliteConnection;

describe('SqliteActivationStateStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getActivationStatus', () => {
    it('returns null when no activation exists for idempotency key', async () => {
      const mockGet = vi.fn().mockReturnValue(undefined);
      mockDb.prepare.mockReturnValue({ get: mockGet });

      const store = new SqliteActivationStateStore(mockConnection);
      const result = await store.getActivationStatus('art-001::prompt');

      expect(result).toBeNull();
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('SELECT'));
      expect(mockGet).toHaveBeenCalledWith('art-001::prompt');
    });

    it('returns activation record when exists', async () => {
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

      expect(result).toEqual({
        activationId: 'act_001',
        idempotencyKey: 'art-001::prompt',
        artifactId: 'art-001',
        channel: 'prompt',
        action: 'prompt_activate',
        targetRef: 'ledger://P_001',
        activatedAt: '2026-05-17T00:00:00.000Z',
        deactivatedAt: null,
      });
    });

    it('returns activation record for defer_archive channel', async () => {
      const mockGet = vi.fn().mockReturnValue({
        activation_id: 'act_002',
        idempotency_key: 'art-002::defer_archive',
        artifact_id: 'art-002',
        channel: 'defer_archive',
        action: 'defer_archive',
        target_ref: 'ledger://P_002#archived',
        activated_at: '2026-05-17T01:00:00.000Z',
        deactivated_at: null,
      });
      mockDb.prepare.mockReturnValue({ get: mockGet });

      const store = new SqliteActivationStateStore(mockConnection);
      const result = await store.getActivationStatus('art-002::defer_archive');

      expect(result).toEqual({
        activationId: 'act_002',
        idempotencyKey: 'art-002::defer_archive',
        artifactId: 'art-002',
        channel: 'defer_archive',
        action: 'defer_archive',
        targetRef: 'ledger://P_002#archived',
        activatedAt: '2026-05-17T01:00:00.000Z',
        deactivatedAt: null,
      });
    });
  });

  describe('listPromptActivations', () => {
    it('SQL query includes deactivated_at IS NULL filter', async () => {
      const mockAll = vi.fn().mockReturnValue([]);
      mockDb.prepare.mockReturnValue({ all: mockAll });

      const store = new SqliteActivationStateStore(mockConnection);
      await store.listPromptActivations();

      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('deactivated_at IS NULL'),
      );
    });
  });

  describe('recordActivation', () => {
    it('inserts activation record with INSERT OR REPLACE', async () => {
      const mockRun = vi.fn();
      mockDb.prepare.mockReturnValue({ run: mockRun });

      const record: ActivationStatusRecord = {
        activationId: 'act_001',
        idempotencyKey: 'art-001::prompt',
        artifactId: 'art-001',
        channel: 'prompt',
        action: 'prompt_activate',
        targetRef: 'ledger://P_001',
        activatedAt: '2026-05-17T00:00:00.000Z',
        deactivatedAt: null,
      };

      const store = new SqliteActivationStateStore(mockConnection);
      await store.recordActivation(record);

      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT OR REPLACE'));
      expect(mockRun).toHaveBeenCalledWith(
        'act_001',
        'art-001::prompt',
        'art-001',
        'prompt',
        'prompt_activate',
        'ledger://P_001',
        '2026-05-17T00:00:00.000Z',
        null,
      );
    });

    it('handles different channel types correctly', async () => {
      const mockRun = vi.fn();
      mockDb.prepare.mockReturnValue({ run: mockRun });

      const record: ActivationStatusRecord = {
        activationId: 'act_003',
        idempotencyKey: 'art-003::defer_archive',
        artifactId: 'art-003',
        channel: 'defer_archive',
        action: 'defer_archive',
        targetRef: 'ledger://P_003#archived',
        activatedAt: '2026-05-17T02:00:00.000Z',
        deactivatedAt: null,
      };

      const store = new SqliteActivationStateStore(mockConnection);
      await store.recordActivation(record);

      expect(mockRun).toHaveBeenCalledWith(
        'act_003',
        'art-003::defer_archive',
        'art-003',
        'defer_archive',
        'defer_archive',
        'ledger://P_003#archived',
        '2026-05-17T02:00:00.000Z',
        null,
      );
    });
  });
});
