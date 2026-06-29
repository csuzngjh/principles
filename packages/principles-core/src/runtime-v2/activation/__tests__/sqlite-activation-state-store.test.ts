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
        promotedAt: null,
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
        promotedAt: null,
        deactivatedAt: null,
      });
    });
  });

  describe('listPromptActivations', () => {
    it('SQL query includes deactivated_at IS NULL filter by default', async () => {
      const mockAll = vi.fn().mockReturnValue([]);
      mockDb.prepare.mockReturnValue({ all: mockAll });

      const store = new SqliteActivationStateStore(mockConnection);
      await store.listPromptActivations();

      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('deactivated_at IS NULL'),
      );
    });

    it('includeDeactivated=true omits the deactivated_at IS NULL filter (P2 #5 fix)', async () => {
      const mockAll = vi.fn().mockReturnValue([]);
      mockDb.prepare.mockReturnValue({ all: mockAll });

      const store = new SqliteActivationStateStore(mockConnection);
      await store.listPromptActivations(true);

      const [sqlCall] = mockDb.prepare.mock.calls;
      const sql = sqlCall ? String(sqlCall) : '';
      expect(sql).toContain("channel = 'prompt'");
      expect(sql).not.toContain('deactivated_at IS NULL');
    });
  });

  describe('listCodeToolHookActivations', () => {
    it('SQL query filters by code_tool_hook channel and deactivated_at IS NULL by default', async () => {
      const mockAll = vi.fn().mockReturnValue([]);
      mockDb.prepare.mockReturnValue({ all: mockAll });

      const store = new SqliteActivationStateStore(mockConnection);
      await store.listCodeToolHookActivations();

      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("channel = 'code_tool_hook'"),
      );
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('deactivated_at IS NULL'),
      );
    });

    it('includeDeactivated=true omits the deactivated_at IS NULL filter (P2 #5 fix)', async () => {
      const mockAll = vi.fn().mockReturnValue([]);
      mockDb.prepare.mockReturnValue({ all: mockAll });

      const store = new SqliteActivationStateStore(mockConnection);
      await store.listCodeToolHookActivations(true);

      const [sqlCall] = mockDb.prepare.mock.calls;
      const sql = sqlCall ? String(sqlCall) : '';
      expect(sql).toContain("channel = 'code_tool_hook'");
      expect(sql).not.toContain('deactivated_at IS NULL');
    });

    it('returns mapped ActivationStatusRecord for code_tool_hook rows', async () => {
      const mockAll = vi.fn().mockReturnValue([{
        activation_id: 'act_code_001',
        idempotency_key: 'art-rule-001::code_tool_hook',
        artifact_id: 'art-rule-001',
        channel: 'code_tool_hook',
        action: 'code_tool_hook_shadow_activate',
        target_ref: 'impl://rule-001',
        activated_at: '2026-06-17T00:00:00.000Z',
        deactivated_at: null,
      }]);
      mockDb.prepare.mockReturnValue({ all: mockAll });

      const store = new SqliteActivationStateStore(mockConnection);
      const result = await store.listCodeToolHookActivations();

      expect(result).toHaveLength(1);
      const [first] = result;
      if (!first) {
        throw new Error('Expected one code_tool_hook activation record');
      }
      expect(first.channel).toBe('code_tool_hook');
      expect(first.activationId).toBe('act_code_001');
      expect(first.artifactId).toBe('art-rule-001');
    });
  });

  describe('recordActivation', () => {
    it('inserts activation record with INSERT OR REPLACE', async () => {
      const mockRun = vi.fn();
      const mockGet = vi.fn().mockReturnValue({ exists: 1 });
      mockDb.prepare.mockImplementation((sql: string) => {
        if (sql.includes('SELECT 1 FROM pi_artifacts')) return { get: mockGet };
        return { run: mockRun };
      });

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
        null,
      );
    });

    it('handles different channel types correctly', async () => {
      const mockRun = vi.fn();
      const mockGet = vi.fn().mockReturnValue({ exists: 1 });
      mockDb.prepare.mockImplementation((sql: string) => {
        if (sql.includes('SELECT 1 FROM pi_artifacts')) return { get: mockGet };
        return { run: mockRun };
      });

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
        null,
      );
    });
  });

  describe('promoteActivation', () => {
    it('atomically promotes only an active code_tool_hook shadow activation', async () => {
      const mockRun = vi.fn().mockReturnValue({ changes: 1 });
      mockDb.prepare.mockReturnValue({ run: mockRun });
      const store = new SqliteActivationStateStore(mockConnection);

      const promoted = await store.promoteActivation('act_code_001', '2026-06-29T00:00:00.000Z');

      expect(promoted).toBe(true);
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining("action = 'code_tool_hook_shadow_activate'"));
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining("SET action = 'code_tool_hook_live_activate'"));
      expect(mockRun).toHaveBeenCalledWith('2026-06-29T00:00:00.000Z', 'act_code_001');
    });

    it('returns false when the activation is not an active shadow activation', async () => {
      mockDb.prepare.mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }) });
      const store = new SqliteActivationStateStore(mockConnection);

      await expect(store.promoteActivation('act_code_001', '2026-06-29T00:00:00.000Z')).resolves.toBe(false);
    });
  });
});
