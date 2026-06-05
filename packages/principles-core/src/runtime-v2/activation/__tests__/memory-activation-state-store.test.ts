import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryActivationStateStore, MemoryArtifactReadModel } from '../index.js';
import type { ActivationStatusRecord } from '../index.js';

function makeActivationRecord(overrides: Partial<ActivationStatusRecord> = {}): ActivationStatusRecord {
  return {
    activationId: 'act-001',
    idempotencyKey: 'art-001::prompt',
    artifactId: 'art-001',
    channel: 'prompt',
    action: 'prompt_activate',
    targetRef: 'ledger://P_001',
    activatedAt: '2026-05-17T00:00:00.000Z',
    deactivatedAt: null,
    ...overrides,
  };
}

describe('MemoryActivationStateStore', () => {
   
  let store: MemoryActivationStateStore;

  beforeEach(() => {
    store = new MemoryActivationStateStore();
  });

  describe('getActivationStatus', () => {
    it('returns null for non-existent idempotency key', async () => {
      const result = await store.getActivationStatus('non-existent-key');
      expect(result).toBeNull();
    });

    it('returns null for empty string idempotency key', async () => {
      const result = await store.getActivationStatus('');
      expect(result).toBeNull();
    });

    it('returns null after construction (empty store)', async () => {
      const result = await store.getActivationStatus('any-key');
      expect(result).toBeNull();
    });
  });

  describe('recordActivation', () => {
    it('records activation and retrieves it by idempotency key', async () => {
      const record = makeActivationRecord();
      await store.recordActivation(record);

      const result = await store.getActivationStatus(record.idempotencyKey);
      expect(result).not.toBeNull();
      expect(result?.activationId).toBe(record.activationId);
      expect(result?.artifactId).toBe(record.artifactId);
      expect(result?.channel).toBe(record.channel);
      expect(result?.action).toBe(record.action);
      expect(result?.targetRef).toBe(record.targetRef);
      expect(result?.activatedAt).toBe(record.activatedAt);
    });

    it('overwrites existing record for same idempotency key', async () => {
      const record1 = makeActivationRecord({ activationId: 'act-001' });
      const record2 = makeActivationRecord({ activationId: 'act-002' });

      await store.recordActivation(record1);
      await store.recordActivation(record2);

      const result = await store.getActivationStatus(record1.idempotencyKey);
      expect(result?.activationId).toBe('act-002');
    });
  });

  describe('idempotency semantics', () => {
    it('multiple records with different channels are independent', async () => {
      const record1 = makeActivationRecord({ idempotencyKey: 'art-001::prompt', channel: 'prompt' });
      const record2 = makeActivationRecord({ idempotencyKey: 'art-001::defer_archive', channel: 'defer_archive' });

      await store.recordActivation(record1);
      await store.recordActivation(record2);

      const result1 = await store.getActivationStatus('art-001::prompt');
      const result2 = await store.getActivationStatus('art-001::defer_archive');

      expect(result1?.channel).toBe('prompt');
      expect(result2?.channel).toBe('defer_archive');
    });

    it('multiple records with same idempotency key: last write wins', async () => {
      const records = Array.from({ length: 5 }, (_, i) =>
        makeActivationRecord({
          idempotencyKey: 'art-001::prompt',
          activationId: `act-${String(i).padStart(3, '0')}`,
        }),
      );

      for (const record of records) {
        await store.recordActivation(record);
      }

      const result = await store.getActivationStatus('art-001::prompt');
      expect(result?.activationId).toBe('act-004');
    });
  });

  describe('edge cases', () => {
    it('handles activation with minimal required fields', async () => {
      const minimalRecord: ActivationStatusRecord = {
        activationId: 'act-min',
        idempotencyKey: 'art-min::prompt',
        artifactId: 'art-min',
        channel: 'prompt',
        action: 'test',
        targetRef: 'ledger://MIN',
        activatedAt: '2026-05-17T00:00:00.000Z',
        deactivatedAt: null,
      };

      await store.recordActivation(minimalRecord);
      const result = await store.getActivationStatus(minimalRecord.idempotencyKey);

      expect(result?.activationId).toBe('act-min');
    });

    it('handles defer_archive channel', async () => {
      const record = makeActivationRecord({
        channel: 'defer_archive',
        action: 'defer_archive',
        targetRef: 'ledger://P_001#archived',
      });

      await store.recordActivation(record);
      const result = await store.getActivationStatus(record.idempotencyKey);

      expect(result?.channel).toBe('defer_archive');
      expect(result?.action).toBe('defer_archive');
    });
  });
});

describe('MemoryArtifactReadModel', () => {
   
  let model: MemoryArtifactReadModel;

  beforeEach(() => {
    model = new MemoryArtifactReadModel();
  });

  describe('addArtifact', () => {
    it('adds artifact and retrieves it by id', async () => {
      model.addArtifact({
        artifactId: 'art-001',
        artifactKind: 'principle',
        sourceTaskId: 'task-001',
        lineageArtifactIds: [],
        validationStatus: 'validated',
        contentJson: '{"principleId": "P_001"}',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      const result = await model.getArtifactById('art-001');
      expect(result).not.toBeNull();
      expect(result?.artifactId).toBe('art-001');
    });

    it('overwrites existing artifact with same artifactId', async () => {
      model.addArtifact({
        artifactId: 'art-001',
        artifactKind: 'principle',
        sourceTaskId: 'task-001',
        lineageArtifactIds: [],
        validationStatus: 'validated',
        contentJson: '{"v": 1}',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      model.addArtifact({
        artifactId: 'art-001',
        artifactKind: 'rule',
        sourceTaskId: 'task-002',
        lineageArtifactIds: [],
        validationStatus: 'pending',
        contentJson: '{"v": 2}',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      });

      const result = await model.getArtifactById('art-001');
      expect(result?.artifactKind).toBe('rule');
      expect(result?.sourceTaskId).toBe('task-002');
    });
  });

  describe('getArtifactById', () => {
    it('returns null for non-existent artifact', async () => {
      const result = await model.getArtifactById('non-existent');
      expect(result).toBeNull();
    });

    it('returns null for empty string artifactId', async () => {
      const result = await model.getArtifactById('');
      expect(result).toBeNull();
    });

    it('returns stored artifact by artifactId', async () => {
      const artifact = {
        artifactId: 'art-001',
        artifactKind: 'principle' as const,
        sourceTaskId: 'task-001',
        lineageArtifactIds: [],
        validationStatus: 'validated' as const,
        contentJson: '{"principleId": "P_001"}',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };

      model.addArtifact(artifact);
      const result = await model.getArtifactById('art-001');

      expect(result).not.toBeNull();
      expect(result?.artifactId).toBe('art-001');
      expect(result?.artifactKind).toBe('principle');
      expect(result?.sourceTaskId).toBe('task-001');
      expect(result?.validationStatus).toBe('validated');
    });

    it('returns latest artifact after overwrite', async () => {
      model.addArtifact({
        artifactId: 'art-001',
        artifactKind: 'principle',
        sourceTaskId: 'task-001',
        lineageArtifactIds: [],
        validationStatus: 'validated',
        contentJson: '{"v": 1}',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      model.addArtifact({
        artifactId: 'art-001',
        artifactKind: 'rule',
        sourceTaskId: 'task-002',
        lineageArtifactIds: [],
        validationStatus: 'pending',
        contentJson: '{"v": 2}',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      });

      const result = await model.getArtifactById('art-001');
      expect(result?.artifactKind).toBe('rule');
      expect(result?.sourceTaskId).toBe('task-002');
    });
  });

  describe('multiple artifacts', () => {
    it('handles multiple different artifacts', async () => {
      const artifacts = [
        {
          artifactId: 'art-001',
          artifactKind: 'principle' as const,
          sourceTaskId: 'task-001',
          lineageArtifactIds: [],
          validationStatus: 'validated' as const,
          contentJson: '{"principleId": "P_001"}',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          artifactId: 'art-002',
          artifactKind: 'rule' as const,
          sourceTaskId: 'task-002',
          lineageArtifactIds: [],
          validationStatus: 'pending' as const,
          contentJson: '{"ruleId": "R_001"}',
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ];

      for (const artifact of artifacts) {
        model.addArtifact(artifact);
      }

      const result1 = await model.getArtifactById('art-001');
      const result2 = await model.getArtifactById('art-002');

      expect(result1?.artifactId).toBe('art-001');
      expect(result2?.artifactId).toBe('art-002');
    });
  });
});
