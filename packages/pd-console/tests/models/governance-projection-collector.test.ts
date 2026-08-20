import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createPITaskDiagnosticJson,
  SqliteConnection,
} from '@principles/core/runtime-v2';
import { GovernanceProjectionCollector } from '../../src/server/models/GovernanceProjectionCollector.js';

const AS_OF = '2026-08-20T10:00:00.000Z';
let tempDir: string;
let workspaceDir: string;

function writeLedger(state: 'candidate' | 'active' = 'candidate'): void {
  const stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'principle_training_state.json'), JSON.stringify({
    _tree: {
      principles: {
        'principle-1': {
          id: 'principle-1',
          status: state,
          createdAt: '2026-08-20T08:00:00.000Z',
          updatedAt: '2026-08-20T09:00:00.000Z',
        },
      },
      rules: {}, implementations: {}, metrics: {}, lastUpdated: AS_OF,
    },
  }));
}

function createStateDb(): SqliteConnection {
  const connection = new SqliteConnection({ workspaceDir, readonly: false });
  connection.getDb();
  return connection;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-governance-projection-'));
  workspaceDir = path.join(tempDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  writeLedger();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('PRI-550 GovernanceProjectionCollector production boundary', () => {
  it('is available from the Console server model layer', async () => {
    await expect(
      import('../../src/server/models/GovernanceProjectionCollector.js'),
    ).resolves.toHaveProperty('GovernanceProjectionCollector');
  });

  it('returns ledger-only facts with explicit unknown lineage when no artifact root exists', async () => {
    const connection = createStateDb();
    connection.close();

    const facts = await new GovernanceProjectionCollector(workspaceDir).collect('principle-1', AS_OF);

    expect(facts.principle.state).toBe('candidate');
    expect(facts.lineage).toMatchObject({
      confidence: 'unknown',
      artifactIds: [],
      taskIds: [],
    });
    expect(facts.collectionIssues).toContainEqual(expect.objectContaining({
      source: 'lineage',
      reasonCode: 'lineage_not_available',
      nextActionCode: 'wait_for_durable_lineage',
    }));
  });

  it('collects the root task only through a validated source-principle artifact', async () => {
    const connection = createStateDb();
    const db = connection.getDb();
    const diagnosticJson = createPITaskDiagnosticJson({
      dependencyTaskIds: [], channel: 'prompt', timeoutMs: 30_000,
      inputArtifactRefs: [], outputArtifactRefs: [],
    });
    db.prepare(`INSERT INTO tasks
      (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts, diagnostic_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('task-1', 'artificer', 'succeeded', '2026-08-20T08:30:00.000Z', '2026-08-20T08:45:00.000Z', 1, 3, diagnosticJson);
    db.prepare(`INSERT INTO pi_artifacts
      (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('artifact-1', 'principle', 'task-1', 'principle-1', '[]', 'validated', '{}', '2026-08-20T08:40:00.000Z', '2026-08-20T08:45:00.000Z');
    connection.close();
    const dbPath = path.join(workspaceDir, '.pd', 'state.db');
    const before = fs.statSync(dbPath);

    const facts = await new GovernanceProjectionCollector(workspaceDir).collect('principle-1', AS_OF);

    expect(facts.lineage).toMatchObject({
      confidence: 'strong',
      artifactIds: ['artifact-1'],
      taskIds: ['task-1'],
    });
    expect(facts.tasks).toContainEqual(expect.objectContaining({
      family: 'task', taskId: 'task-1', taskKind: 'artificer', channel: 'prompt', status: 'succeeded',
    }));
    expect(fs.statSync(dbPath)).toMatchObject({ size: before.size, mtimeMs: before.mtimeMs });
  });

  it('rejects malformed PI metadata and reports the omission instead of guessing a channel', async () => {
    const connection = createStateDb();
    const db = connection.getDb();
    db.prepare(`INSERT INTO tasks
      (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts, diagnostic_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        'task-bad', 'artificer', 'succeeded',
        '2026-08-20T08:30:00.000Z', '2026-08-20T08:45:00.000Z', 1, 3,
        JSON.stringify({ pi_metadata: { dependencyTaskIds: [42], channel: 'prompt' } }),
      );
    db.prepare(`INSERT INTO pi_artifacts
      (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('artifact-bad', 'principle', 'task-bad', 'principle-1', '[]', 'validated', '{}', '2026-08-20T08:40:00.000Z', '2026-08-20T08:45:00.000Z');
    connection.close();

    const facts = await new GovernanceProjectionCollector(workspaceDir).collect('principle-1', AS_OF);

    expect(facts.tasks).toEqual([]);
    expect(facts.collectionIssues).toContainEqual(expect.objectContaining({
      source: 'task', reasonCode: 'metadata_malformed', nextActionCode: 'repair_task_metadata',
      sourceRef: { type: 'task', id: 'task-bad' },
    }));
  });

  it('traverses validated dependencies but ignores malformed tasks outside the rooted component', async () => {
    const connection = createStateDb();
    const db = connection.getDb();
    const rootMetadata = createPITaskDiagnosticJson({
      dependencyTaskIds: [], channel: 'prompt', timeoutMs: 30_000,
      inputArtifactRefs: [], outputArtifactRefs: [],
    });
    const childMetadata = createPITaskDiagnosticJson({
      dependencyTaskIds: ['task-root'], channel: 'prompt', timeoutMs: 30_000,
      inputArtifactRefs: [], outputArtifactRefs: [],
    });
    const insertTask = db.prepare(`INSERT INTO tasks
      (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts, diagnostic_json)
      VALUES (?, ?, 'succeeded', ?, ?, 1, 3, ?)`);
    insertTask.run('task-root', 'artificer', '2026-08-20T08:00:00.000Z', '2026-08-20T08:10:00.000Z', rootMetadata);
    insertTask.run('task-child', 'evaluator', '2026-08-20T08:11:00.000Z', '2026-08-20T08:20:00.000Z', childMetadata);
    insertTask.run('task-unrelated-bad', 'artificer', '2026-08-20T08:00:00.000Z', '2026-08-20T08:10:00.000Z', JSON.stringify({ pi_metadata: { dependencyTaskIds: [42] } }));
    db.prepare(`INSERT INTO pi_artifacts
      (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES ('artifact-root', 'principle', 'task-root', 'principle-1', '[]', 'validated', '{}', ?, ?)`)
      .run('2026-08-20T08:05:00.000Z', '2026-08-20T08:10:00.000Z');
    connection.close();

    const facts = await new GovernanceProjectionCollector(workspaceDir).collect('principle-1', AS_OF);

    expect(facts.lineage.taskIds).toEqual(['task-child', 'task-root']);
    expect(facts.tasks.map(task => task.taskId)).toEqual(['task-child', 'task-root']);
    expect(facts.collectionIssues).not.toContainEqual(expect.objectContaining({
      sourceRef: { type: 'task', id: 'task-unrelated-bad' },
    }));
  });

  it('reports a directed lineage cycle and downgrades aggregate confidence', async () => {
    const connection = createStateDb();
    const db = connection.getDb();
    const metadataA = createPITaskDiagnosticJson({ dependencyTaskIds: ['task-b'], channel: 'prompt', timeoutMs: 30_000, inputArtifactRefs: [], outputArtifactRefs: [] });
    const metadataB = createPITaskDiagnosticJson({ dependencyTaskIds: ['task-a'], channel: 'prompt', timeoutMs: 30_000, inputArtifactRefs: [], outputArtifactRefs: [] });
    const insertTask = db.prepare(`INSERT INTO tasks
      (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts, diagnostic_json)
      VALUES (?, 'artificer', 'succeeded', ?, ?, 1, 3, ?)`);
    insertTask.run('task-a', '2026-08-20T08:00:00.000Z', '2026-08-20T08:10:00.000Z', metadataA);
    insertTask.run('task-b', '2026-08-20T08:11:00.000Z', '2026-08-20T08:20:00.000Z', metadataB);
    db.prepare(`INSERT INTO pi_artifacts
      (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES ('artifact-cycle', 'principle', 'task-a', 'principle-1', '[]', 'validated', '{}', ?, ?)`)
      .run('2026-08-20T08:05:00.000Z', '2026-08-20T08:10:00.000Z');
    connection.close();

    const facts = await new GovernanceProjectionCollector(workspaceDir).collect('principle-1', AS_OF);

    expect(facts.lineage.confidence).toBe('weak');
    expect(facts.collectionIssues).toContainEqual(expect.objectContaining({
      source: 'lineage', reasonCode: 'lineage_cycle', nextActionCode: 'repair_task_dependencies',
    }));
  });
});
