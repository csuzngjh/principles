import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = {
  prepare: vi.fn(),
  pragma: vi.fn(),
  close: vi.fn(),
};

vi.mock('better-sqlite3', () => ({
  default: vi.fn(function () { return mockDb; }),
}));

const mockExistsSync = vi.hoisted(() => vi.fn());

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  default: { existsSync: mockExistsSync },
}));

import { SchemaConformanceReadModel } from '../schema-conformance-read-model.js';

const { default: Database } = vi.mocked(await import('better-sqlite3'));

const WS = '/fake/workspace';

function setupFullSchema(tables: Record<string, { columns: { name: string }[]; indexes: { name: string }[] }>) {
  mockDb.prepare.mockImplementation((sql: string) => {
    const match = /^PRAGMA table_info\((\w+)\)$/.exec(sql);
    if (match) {
      const tableName = match[1] as string;
      return { all: vi.fn(() => tables[tableName]?.columns ?? []) };
    }
    return { all: vi.fn(() => []) };
  });

  mockDb.pragma.mockImplementation((sql: string) => {
    const match = /^index_list\((\w+)\)$/.exec(sql);
    if (match) {
      const tableName = match[1] as string;
      return tables[tableName]?.indexes ?? [];
    }
    return [];
  });
}

const FULL_SCHEMA: Record<string, { columns: { name: string }[]; indexes: { name: string }[] }> = {
  tasks: {
    columns: [
      { name: 'task_id' }, { name: 'task_kind' }, { name: 'status' },
      { name: 'created_at' }, { name: 'updated_at' }, { name: 'lease_owner' },
      { name: 'lease_expires_at' }, { name: 'attempt_count' }, { name: 'max_attempts' },
      { name: 'last_error' }, { name: 'input_ref' }, { name: 'result_ref' },
      { name: 'diagnostic_json' },
    ],
    indexes: [
      { name: 'idx_tasks_status' }, { name: 'idx_tasks_created_at' },
      { name: 'idx_tasks_task_kind' }, { name: 'idx_tasks_lease_expires_at' },
      { name: 'idx_tasks_session_id_hint' },
    ],
  },
  runs: {
    columns: [
      { name: 'run_id' }, { name: 'task_id' }, { name: 'runtime_kind' },
      { name: 'execution_status' }, { name: 'started_at' }, { name: 'ended_at' },
      { name: 'reason' }, { name: 'output_ref' }, { name: 'input_payload' },
      { name: 'output_payload' }, { name: 'error_category' }, { name: 'attempt_number' },
      { name: 'created_at' }, { name: 'updated_at' },
    ],
    indexes: [
      { name: 'idx_runs_task_id' }, { name: 'idx_runs_status' }, { name: 'idx_runs_started_at' },
    ],
  },
  artifacts: {
    columns: [
      { name: 'artifact_id' }, { name: 'run_id' }, { name: 'task_id' },
      { name: 'artifact_kind' }, { name: 'content_json' }, { name: 'created_at' },
    ],
    indexes: [
      { name: 'idx_artifacts_task_id' }, { name: 'idx_artifacts_run_id' }, { name: 'idx_artifacts_artifact_kind' },
    ],
  },
  commits: {
    columns: [
      { name: 'commit_id' }, { name: 'task_id' }, { name: 'run_id' },
      { name: 'artifact_id' }, { name: 'idempotency_key' }, { name: 'status' }, { name: 'created_at' },
    ],
    indexes: [
      { name: 'idx_commits_task_id' }, { name: 'idx_commits_artifact_id' },
    ],
  },
  principle_candidates: {
    columns: [
      { name: 'candidate_id' }, { name: 'artifact_id' }, { name: 'task_id' },
      { name: 'source_run_id' }, { name: 'title' }, { name: 'description' },
      { name: 'confidence' }, { name: 'source_recommendation_json' },
      { name: 'idempotency_key' }, { name: 'status' }, { name: 'created_at' },
      { name: 'consumed_at' }, { name: 'recommendation_kind' }, { name: 'trigger_pattern' },
      { name: 'action' }, { name: 'abstracted_principle' },
    ],
    indexes: [
      { name: 'idx_candidates_status' }, { name: 'idx_candidates_source_run_id' },
      { name: 'idx_candidates_task_id' }, { name: 'idx_candidates_recommendation_kind' },
    ],
  },
  pi_artifacts: {
    columns: [
      { name: 'artifact_id' }, { name: 'artifact_kind' }, { name: 'source_task_id' },
      { name: 'source_principle_id' }, { name: 'source_rule_id' },
      { name: 'lineage_artifact_ids' }, { name: 'validation_status' },
      { name: 'content_json' }, { name: 'created_at' }, { name: 'updated_at' },
    ],
    indexes: [
      { name: 'idx_pi_artifacts_source_task_id' }, { name: 'idx_pi_artifacts_artifact_kind' },
      { name: 'idx_pi_artifacts_idempotency' },
    ],
  },
};

describe('SchemaConformanceReadModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    Database.mockImplementation(function () { return mockDb; });
  });

  it('returns error when DB does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    const model = new SchemaConformanceReadModel({ workspaceDir: WS });
    const result = model.check();

    expect(result.overallStatus).toBe('error');
    expect(result.checkedDatabasePath).toContain('state.db');
    expect(result.migrationsNeeded).toContain('initialize_database');
    expect(Object.values(result.tables).every(t => t.exists === false)).toBe(true);
  });

  it('returns error when DB throws on open', () => {
    Database.mockImplementation(function () {
      throw new Error('Cannot open database');
    });

    const model = new SchemaConformanceReadModel({ workspaceDir: WS });
    const result = model.check();

    expect(result.overallStatus).toBe('error');
    expect(result.migrationsNeeded).toContain('initialize_database');
  });

  it('reports missing tables on empty DB', () => {
    setupFullSchema({});

    const model = new SchemaConformanceReadModel({ workspaceDir: WS });
    const result = model.check();

    expect(result.overallStatus).toBe('error');
    expect(result.tables.tasks?.exists).toBe(false);
    expect(result.tables.runs?.exists).toBe(false);
    expect(result.tables.artifacts?.exists).toBe(false);
    expect(result.tables.commits?.exists).toBe(false);
    expect(result.tables.principle_candidates?.exists).toBe(false);
    expect(result.tables.pi_artifacts?.exists).toBe(false);
    expect(result.migrationsNeeded).toContain('create_table_tasks');
    expect(result.migrationsNeeded).toContain('create_table_principle_candidates');
    expect(result.migrationsNeeded).not.toContain('add_recommendation_kind');
  });

  it('reports missing columns for old schema', () => {
    const oldSchema = JSON.parse(JSON.stringify(FULL_SCHEMA)) as typeof FULL_SCHEMA;
    const oldPc = oldSchema.principle_candidates;
    if (oldPc) {
      oldPc.columns = oldPc.columns.filter(
        c => !['recommendation_kind', 'trigger_pattern', 'action', 'abstracted_principle'].includes(c.name),
      );
      oldPc.indexes = oldPc.indexes.filter(
        i => i.name !== 'idx_candidates_recommendation_kind',
      );
    }
    setupFullSchema(oldSchema);

    const model = new SchemaConformanceReadModel({ workspaceDir: WS });
    const result = model.check();

    expect(result.overallStatus).toBe('degraded');
    expect(result.tables.principle_candidates?.missingColumns).toContain('recommendation_kind');
    expect(result.tables.principle_candidates?.missingColumns).toContain('trigger_pattern');
    expect(result.tables.principle_candidates?.missingColumns).toContain('action');
    expect(result.tables.principle_candidates?.missingColumns).toContain('abstracted_principle');
    expect(result.indexes.missingIndexes).toContain('idx_candidates_recommendation_kind');
    expect(result.migrationsNeeded).toContain('add_recommendation_kind');
    expect(result.migrationsNeeded).toContain('add_trigger_pattern');
    expect(result.migrationsNeeded).toContain('add_action');
    expect(result.migrationsNeeded).toContain('add_abstracted_principle');
  });

  it('returns ok for fully migrated schema', () => {
    setupFullSchema(FULL_SCHEMA);

    const model = new SchemaConformanceReadModel({ workspaceDir: WS });
    const result = model.check();

    expect(result.overallStatus).toBe('ok');
    expect(result.migrationsNeeded).toEqual([]);
    expect(result.indexes.missingIndexes).toEqual([]);
    for (const table of Object.values(result.tables)) {
      expect(table.exists).toBe(true);
      expect(table.missingColumns).toEqual([]);
    }
  });

  it('does not trigger migration on readonly query', () => {
    setupFullSchema(FULL_SCHEMA);

    const model = new SchemaConformanceReadModel({ workspaceDir: WS });
    model.check();

    expect(Database).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ readonly: true }),
    );
  });

  it('includes generatedAt in output', () => {
    mockExistsSync.mockReturnValue(false);
    const model = new SchemaConformanceReadModel({ workspaceDir: WS });
    const result = model.check();

    expect(result.generatedAt).toBeTruthy();
    expect(new Date(result.generatedAt).getTime()).not.toBeNaN();
  });

  it('includes migrationsNeeded for partial missing columns', () => {
    const partialSchema = JSON.parse(JSON.stringify(FULL_SCHEMA)) as typeof FULL_SCHEMA;
    const partialPc = partialSchema.principle_candidates;
    if (partialPc) {
      partialPc.columns = partialPc.columns.filter(
        c => !['trigger_pattern', 'action', 'abstracted_principle'].includes(c.name),
      );
    }
    setupFullSchema(partialSchema);

    const model = new SchemaConformanceReadModel({ workspaceDir: WS });
    const result = model.check();

    expect(result.overallStatus).toBe('degraded');
    expect(result.migrationsNeeded).toContain('add_trigger_pattern');
    expect(result.migrationsNeeded).toContain('add_action');
    expect(result.migrationsNeeded).toContain('add_abstracted_principle');
  });
});
