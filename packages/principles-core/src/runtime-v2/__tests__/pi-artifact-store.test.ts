import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  MemoryPIArtifactStore,
} from '../internalization/pi-artifact-store.js';
import {
  SqlitePIArtifactStore,
} from '../store/artifact/sqlite-pi-artifact-store.js';
import { SqliteConnection } from '../store/sqlite-connection.js';
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

function createStoreContractTests(
  name: string,
  createStore: () => PIArtifactStore,
  cleanup?: () => void,
) {
  describe(`${name} PIArtifactStore contract (PRI-84)`, () => {
    let store: PIArtifactStore = createStore();

    beforeEach(() => {
      store = createStore();
    });

    afterEach(() => {
      if (cleanup) cleanup();
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
}

createStoreContractTests('MemoryPIArtifactStore', () => new MemoryPIArtifactStore());

describe('MemoryPIArtifactStore index consistency (PRI-84)', () => {
  let store: MemoryPIArtifactStore = new MemoryPIArtifactStore();

  beforeEach(() => {
    store = new MemoryPIArtifactStore();
  });

  it('upsertArtifact with different artifactId cleans up old idempotency entries', async () => {
    const r1 = makeRecord({ artifactId: 'art-old', sourceTaskId: 'task-1', artifactKind: 'principle' });
    await store.createArtifact(r1);

    const r2 = makeRecord({ artifactId: 'art-new', sourceTaskId: 'task-1', artifactKind: 'principle' });
    await store.upsertArtifact(r2);

    const byId = await store.getArtifactById('art-old');
    expect(byId).toBeNull();

    const byIdNew = await store.getArtifactById('art-new');
    expect(byIdNew).not.toBeNull();
    expect(byIdNew?.artifactId).toBe('art-new');
  });

  it('upsertArtifact does not leave dangling entries in artifacts map', async () => {
    const r1 = makeRecord({ artifactId: 'art-v1', sourceTaskId: 'task-X', artifactKind: 'principle' });
    await store.createArtifact(r1);

    const r2 = makeRecord({ artifactId: 'art-v2', sourceTaskId: 'task-X', artifactKind: 'principle' });
    await store.upsertArtifact(r2);

    const results = await store.listBySourceTaskId('task-X');
    expect(results).toHaveLength(1);
    const [first] = results;
    expect(first).toBeDefined();
    expect(first?.artifactId).toBe('art-v2');
  });
});

describe('SqlitePIArtifactStore contract (PRI-84)', () => {
  let tmpDir = '';
  let connection: SqliteConnection = new SqliteConnection(os.tmpdir());
  let store: SqlitePIArtifactStore = new SqlitePIArtifactStore(connection);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pi-art-sqlite-'));
    connection = new SqliteConnection(tmpDir);
    store = new SqlitePIArtifactStore(connection);
    // P1-3: Seed parent task records for FK validation.
    // Each test's sourceTaskId must exist in tasks table before createArtifact.
    const db = connection.getDb();
    const taskIds = [
      'task-001', 'task-upsert', 'task-s', 'task-other',
      'task-p', 'task-c', 'task-dup', 'task-persist',
    ];
    const insertTask = db.prepare(
      "INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, 'diagnosis', 'pending', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    );
    for (const taskId of taskIds) {
      insertTask.run(taskId);
    }
  });

  afterEach(() => {
    connection.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('createArtifact persists to SQLite and returns record', async () => {
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

  it('upsertArtifact with ON CONFLICT replaces existing record', async () => {
    const original = makeRecord({
      artifactId: 'art-v1',
      sourceTaskId: 'task-upsert',
      artifactKind: 'principle',
      contentJson: '{"v": 1}',
    });
    await store.createArtifact(original);

    const updated = makeRecord({
      artifactId: 'art-v2',
      sourceTaskId: 'task-upsert',
      artifactKind: 'principle',
      contentJson: '{"v": 2}',
      validationStatus: 'validated',
    });

    await store.upsertArtifact(updated);

    const oldFetched = await store.getArtifactById('art-v1');
    expect(oldFetched).toBeNull();

    const newFetched = await store.getArtifactById('art-v2');
    expect(newFetched).toBeDefined();
    if (newFetched) {
      expect(newFetched.contentJson).toBe('{"v": 2}');
      expect(newFetched.validationStatus).toBe('validated');
    }
  });

  it('listBySourceTaskId returns matching artifacts from SQLite', async () => {
    const r1 = makeRecord({ artifactId: 'art-a', sourceTaskId: 'task-s', artifactKind: 'principle' });
    const r2 = makeRecord({ artifactId: 'art-b', sourceTaskId: 'task-s', artifactKind: 'rule' });
    const r3 = makeRecord({ artifactId: 'art-c', sourceTaskId: 'task-other', artifactKind: 'principle' });

    await store.createArtifact(r1);
    await store.createArtifact(r2);
    await store.createArtifact(r3);

    const results = await store.listBySourceTaskId('task-s');
    expect(results).toHaveLength(2);
    expect(results.map(r => r.artifactId)).toEqual(expect.arrayContaining(['art-a', 'art-b']));
  });

  it('listLineage resolves lineage from SQLite', async () => {
    const parent = makeRecord({ artifactId: 'p-art', sourceTaskId: 'task-p', artifactKind: 'principle' });
    const child = makeRecord({
      artifactId: 'c-art',
      sourceTaskId: 'task-c',
      artifactKind: 'rule',
      lineageArtifactIds: ['p-art'],
    });

    await store.createArtifact(parent);
    await store.createArtifact(child);

    const lineage = await store.listLineage('c-art');
    expect(lineage).toHaveLength(1);
    expect(lineage[0]?.artifactId).toBe('p-art');
  });

  it('idempotency: duplicate sourceTaskId+kind throws in SQLite', async () => {
    const r1 = makeRecord({ sourceTaskId: 'task-dup', artifactKind: 'principle' });
    await store.createArtifact(r1);

    const r2 = makeRecord({ artifactId: 'art-dup2', sourceTaskId: 'task-dup', artifactKind: 'principle' });
    await expect(store.createArtifact(r2)).rejects.toThrow();
  });

  it('survives process restart (data persists across connections)', async () => {
    const record = makeRecord({ artifactId: 'persist-art', sourceTaskId: 'task-persist' });
    await store.createArtifact(record);

    connection.close();
    connection = new SqliteConnection(tmpDir);
    store = new SqlitePIArtifactStore(connection);

    const fetched = await store.getArtifactById('persist-art');
    expect(fetched).toBeDefined();
    expect(fetched?.artifactId).toBe('persist-art');
  });
});
