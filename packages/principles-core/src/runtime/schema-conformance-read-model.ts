import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

export interface SchemaConformanceTableResult {
  exists: boolean;
  missingColumns: string[];
  extraInfo?: string;
}

export interface SchemaConformanceResult {
  overallStatus: 'ok' | 'degraded' | 'error';
  checkedDatabasePath: string;
  tables: Record<string, SchemaConformanceTableResult>;
  indexes: {
    missingIndexes: string[];
  };
  migrationsNeeded: string[];
  generatedAt: string;
}

export interface SchemaConformanceReadModelOptions {
  workspaceDir: string;
}

interface ExpectedTable {
  columns: string[];
  indexes: string[];
}

const EXPECTED_SCHEMA: Record<string, ExpectedTable> = {
  tasks: {
    columns: [
      'task_id', 'task_kind', 'status', 'created_at', 'updated_at',
      'lease_owner', 'lease_expires_at', 'attempt_count', 'max_attempts',
      'last_error', 'input_ref', 'result_ref', 'diagnostic_json',
    ],
    indexes: [
      'idx_tasks_status', 'idx_tasks_created_at', 'idx_tasks_task_kind',
      'idx_tasks_lease_expires_at', 'idx_tasks_session_id_hint',
    ],
  },
  runs: {
    columns: [
      'run_id', 'task_id', 'runtime_kind', 'execution_status', 'started_at',
      'ended_at', 'reason', 'output_ref', 'input_payload', 'output_payload',
      'error_category', 'attempt_number', 'created_at', 'updated_at',
    ],
    indexes: [
      'idx_runs_task_id', 'idx_runs_status', 'idx_runs_started_at',
    ],
  },
  artifacts: {
    columns: [
      'artifact_id', 'run_id', 'task_id', 'artifact_kind', 'content_json', 'created_at',
    ],
    indexes: [
      'idx_artifacts_task_id', 'idx_artifacts_run_id', 'idx_artifacts_artifact_kind',
    ],
  },
  commits: {
    columns: [
      'commit_id', 'task_id', 'run_id', 'artifact_id', 'idempotency_key', 'status', 'created_at',
    ],
    indexes: [
      'idx_commits_task_id', 'idx_commits_artifact_id',
    ],
  },
  principle_candidates: {
    columns: [
      'candidate_id', 'artifact_id', 'task_id', 'source_run_id', 'title', 'description',
      'confidence', 'source_recommendation_json', 'idempotency_key', 'status', 'created_at',
      'consumed_at', 'recommendation_kind', 'trigger_pattern', 'action', 'abstracted_principle',
    ],
    indexes: [
      'idx_candidates_status', 'idx_candidates_source_run_id',
      'idx_candidates_task_id', 'idx_candidates_recommendation_kind',
    ],
  },
  pi_artifacts: {
    columns: [
      'artifact_id', 'artifact_kind', 'source_task_id', 'source_principle_id',
      'source_rule_id', 'lineage_artifact_ids', 'validation_status', 'content_json',
      'created_at', 'updated_at',
    ],
    indexes: [
      'idx_pi_artifacts_source_task_id', 'idx_pi_artifacts_artifact_kind',
      'idx_pi_artifacts_idempotency',
    ],
  },
};

const COLUMN_MIGRATION_MAP: Record<string, string> = {
  recommendation_kind: 'add_recommendation_kind',
  trigger_pattern: 'add_trigger_pattern',
  action: 'add_action',
  abstracted_principle: 'add_abstracted_principle',
};

export class SchemaConformanceReadModel {
  private readonly dbPath: string;

  constructor(opts: SchemaConformanceReadModelOptions) {
    this.dbPath = path.join(opts.workspaceDir, '.pd', 'state.db');
  }

  check(): SchemaConformanceResult {
    const generatedAt = new Date().toISOString();
    const tables: Record<string, SchemaConformanceTableResult> = {};
    const missingIndexes: string[] = [];
    const migrationsNeeded: string[] = [];

    if (!fs.existsSync(this.dbPath)) {
      for (const tableName of Object.keys(EXPECTED_SCHEMA)) {
        const expected = EXPECTED_SCHEMA[tableName];
        tables[tableName] = { exists: false, missingColumns: (expected ?? { columns: [] }).columns.slice() };
      }
      return {
        overallStatus: 'error',
        checkedDatabasePath: this.dbPath,
        tables,
        indexes: { missingIndexes: Object.values(EXPECTED_SCHEMA).flatMap(t => t.indexes) },
        migrationsNeeded: ['initialize_database'],
        generatedAt,
      };
    }

    let db: Database.Database | null = null;
    try {
      db = new Database(this.dbPath, { readonly: true });

      for (const [tableName, expected] of Object.entries(EXPECTED_SCHEMA)) {
        const tableInfo = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
        const existingColumns = new Set(tableInfo.map(c => c.name));

        if (tableInfo.length === 0) {
          tables[tableName] = {
            exists: false,
            missingColumns: expected.columns,
            extraInfo: 'Table does not exist',
          };
          missingIndexes.push(...expected.indexes);
          migrationsNeeded.push(`create_table_${tableName}`);
          continue;
        }

        const missingCols = expected.columns.filter(c => !existingColumns.has(c));
        tables[tableName] = {
          exists: true,
          missingColumns: missingCols,
        };

        for (const col of missingCols) {
          const migrationKey = COLUMN_MIGRATION_MAP[col];
          if (migrationKey) migrationsNeeded.push(migrationKey);
        }

        const indexList = db.pragma(`index_list(${tableName})`) as { name: string }[];
        const existingIndexNames = new Set(indexList.map(i => i.name));
        for (const idx of expected.indexes) {
          if (!existingIndexNames.has(idx)) {
            missingIndexes.push(idx);
          }
        }
      }
    } catch {
      for (const tableName of Object.keys(EXPECTED_SCHEMA)) {
        if (!tables[tableName]) {
          const expected = EXPECTED_SCHEMA[tableName];
          tables[tableName] = {
            exists: false,
            missingColumns: (expected ?? { columns: [] }).columns,
            extraInfo: 'Database read error',
          };
        }
      }
      return {
        overallStatus: 'error',
        checkedDatabasePath: this.dbPath,
        tables,
        indexes: { missingIndexes: Object.values(EXPECTED_SCHEMA).flatMap(t => t.indexes) },
        migrationsNeeded: ['initialize_database'],
        generatedAt,
      };
    } finally {
      if (db) {
        try { db.close(); } catch { /* ignore */ }
      }
    }

    const hasMissingTables = Object.values(tables).some(t => !t.exists);
    const hasMissingColumns = Object.values(tables).some(t => t.missingColumns.length > 0);
    const hasMissingIndexes = missingIndexes.length > 0;

    let overallStatus: 'ok' | 'degraded' | 'error' = 'ok';
    if (hasMissingTables) {
      overallStatus = 'error';
    } else if (hasMissingColumns || hasMissingIndexes) {
      overallStatus = 'degraded';
    }

    return {
      overallStatus,
      checkedDatabasePath: this.dbPath,
      tables,
      indexes: { missingIndexes },
      migrationsNeeded,
      generatedAt,
    };
  }
}
