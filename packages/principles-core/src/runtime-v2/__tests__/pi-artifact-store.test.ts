import { describe, it, expect, beforeEach } from 'vitest';
import {
  MemoryPIArtifactStore,
} from '../internalization/pi-artifact-store.js';
import type {
  PIArtifactRecord,
  PIArtifactStore,
} from '../internalization/pi-artifact.js';

function makeRecord(overrides: Partial<PIArtifactRecord> = {}): PIArtifactRecord {
  return {
    artifactId: overrides.artifactId ?? 'art-001',
    artifactKind: overrides.artifactKind ?? 'principle',
    sourceTaskId: overrides.sourceTaskId ?? 'task-001',
    sourcePrincipleId: overrides.sourcePrincipleId,
    sourceRuleId: overrides.sourceRuleId,
    lineageArtifactIds: overrides.lineageArtifactIds ?? [],
    validationStatus: overrides.validationStatus ?? 'pending',
    contentJson: overrides.contentJson ?? '{}',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  };
}

describe('PIArtifactStore contract (PRI-84)', () => {
  let store: PIArtifactStore = new MemoryPIArtifactStore();

  beforeEach(() => {
    store = new MemoryPIArtifactStore();
  });

  it('createArtifact persists a PIArtifact and returns it', async () => {
    const record = makeRecord();

    const result = await store.createArtifact(record);

    expect(result).toEqual(record);

    const fetched = await store.getArtifactById(record.artifactId);
    expect(fetched).toEqual(record);
  });

  it('getArtifactById returns null for unknown artifact', async () => {
    const result = await store.getArtifactById('nonexistent');

    expect(result).toBeNull();
  });

  it('listBySourceTaskId returns all artifacts for a source task', async () => {
    const r1 = makeRecord({ artifactId: 'art-1', sourceTaskId: 'task-A', artifactKind: 'principle' });
    const r2 = makeRecord({ artifactId: 'art-2', sourceTaskId: 'task-A', artifactKind: 'rule' });
    const r3 = makeRecord({ artifactId: 'art-3', sourceTaskId: 'task-B', artifactKind: 'principle' });

    await store.createArtifact(r1);
    await store.createArtifact(r2);
    await store.createArtifact(r3);

    const results = await store.listBySourceTaskId('task-A');

    expect(results).toHaveLength(2);
    expect(results.map(r => r.artifactId)).toEqual(expect.arrayContaining(['art-1', 'art-2']));
  });

  it('listLineage returns artifacts linked via lineageArtifactIds', async () => {
    const parent = makeRecord({ artifactId: 'parent-art', sourceTaskId: 'task-parent', artifactKind: 'principle' });
    const child = makeRecord({
      artifactId: 'child-art',
      sourceTaskId: 'task-child',
      artifactKind: 'rule',
      lineageArtifactIds: ['parent-art'],
    });

    await store.createArtifact(parent);
    await store.createArtifact(child);

    const lineage = await store.listLineage('child-art');

    expect(lineage).toHaveLength(1);
    expect(lineage[0]?.artifactId).toBe('parent-art');
  });

  it('idempotency: same sourceTaskId + artifactKind does not create duplicate', async () => {
    const r1 = makeRecord({ sourceTaskId: 'task-X', artifactKind: 'principle' });
    await store.createArtifact(r1);

    const r2 = makeRecord({
      artifactId: 'art-dup',
      sourceTaskId: 'task-X',
      artifactKind: 'principle',
    });

    await expect(store.createArtifact(r2)).rejects.toThrow();
  });

  it('upsertArtifact creates new when no matching sourceTaskId+kind exists', async () => {
    const record = makeRecord({ sourceTaskId: 'task-Y', artifactKind: 'rule' });

    const result = await store.upsertArtifact(record);

    expect(result.artifactId).toBe(record.artifactId);

    const fetched = await store.getArtifactById(record.artifactId);
    expect(fetched).toEqual(record);
  });

  it('upsertArtifact updates existing when matching sourceTaskId+kind exists', async () => {
    const original = makeRecord({
      artifactId: 'art-original',
      sourceTaskId: 'task-Z',
      artifactKind: 'principle',
      contentJson: '{"old": true}',
    });
    await store.createArtifact(original);

    const updated = makeRecord({
      artifactId: 'art-updated',
      sourceTaskId: 'task-Z',
      artifactKind: 'principle',
      contentJson: '{"new": true}',
      validationStatus: 'validated',
    });

    const result = await store.upsertArtifact(updated);

    expect(result.contentJson).toBe('{"new": true}');
    expect(result.validationStatus).toBe('validated');

    const fetched = await store.getArtifactById('art-original');
    expect(fetched).toBeNull();

    const newFetched = await store.getArtifactById('art-updated');
    expect(newFetched).toBeDefined();
    if (newFetched) {
      expect(newFetched.contentJson).toBe('{"new": true}');
    }
  });

  it('listLineage returns empty array when no lineage refs', async () => {
    const record = makeRecord({ artifactId: 'solo-art', lineageArtifactIds: [] });
    await store.createArtifact(record);

    const lineage = await store.listLineage('solo-art');

    expect(lineage).toEqual([]);
  });

  it('allows different artifactKinds for same sourceTaskId', async () => {
    const r1 = makeRecord({ artifactId: 'art-p', sourceTaskId: 'task-M', artifactKind: 'principle' });
    const r2 = makeRecord({ artifactId: 'art-r', sourceTaskId: 'task-M', artifactKind: 'rule' });

    await store.createArtifact(r1);
    await store.createArtifact(r2);

    const results = await store.listBySourceTaskId('task-M');
    expect(results).toHaveLength(2);
  });
});
