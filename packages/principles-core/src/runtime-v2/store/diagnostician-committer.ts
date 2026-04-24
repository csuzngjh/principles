/**
 * DiagnosticianCommitter — atomic commit interface for DiagnosticianOutputV1.
 *
 * Persists a DiagnosticianOutputV1 to the artifact registry (artifacts +
 * commits + principle_candidates) inside a single SQLite transaction, with
 * idempotent re-commit support via UNIQUE constraints on run_id and
 * idempotency_key.
 *
 * COMT-01 through COMT-06
 */
import { Value } from '@sinclair/typebox/value';
import { randomUUID } from 'crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { SqliteConnection } from './sqlite-connection.js';
import { PDRuntimeError } from '../error-categories.js';
import { DiagnosticianOutputV1Schema, type DiagnosticianOutputV1 } from '../diagnostician-output.js';

// ── Public Types ─────────────────────────────────────────────────────────────

export interface DiagnosticianCommitter {
  /**
   * Atomically commit a DiagnosticianOutputV1 to the artifact registry.
   *
   * @param input.runId - the run producing this output
   * @param input.taskId - the task being diagnosed
   * @param input.output - the DiagnosticianOutputV1 to persist
   * @param input.idempotencyKey - client-supplied key for deduplication
   *
   * @returns CommitResult with commitId, artifactId, candidateCount
   *
   * @throws PDRuntimeError{input_invalid} if output fails schema validation
   * @throws PDRuntimeError{artifact_commit_failed} on non-idempotency SQL errors
   *
   * Idempotency: re-commits with the same runId or idempotencyKey return the
   * existing commit result without error.
   */
  commit(input: CommitInput): Promise<CommitResult>;
}

export interface CommitInput {
  runId: string;
  taskId: string;
  output: DiagnosticianOutputV1;
  idempotencyKey: string;
}

export interface CommitResult {
  commitId: string;
  artifactId: string;
  candidateCount: number;
}

// ── Implementation ────────────────────────────────────────────────────────────

export class SqliteDiagnosticianCommitter implements DiagnosticianCommitter {
  constructor(private readonly connection: SqliteConnection) {}

  async commit(input: CommitInput): Promise<CommitResult> {
    const db = this.connection.getDb();

    // 1. Validate input.output conforms to DiagnosticianOutputV1
    if (!Value.Check(DiagnosticianOutputV1Schema, input.output)) {
      throw new PDRuntimeError(
        'input_invalid',
        'DiagnosticianOutputV1 validation failed',
        { errors: [...Value.Errors(DiagnosticianOutputV1Schema, input.output)].map((e) => e.message) },
      );
    }

    const commitId = randomUUID();
    const artifactId = randomUUID();
    const now = new Date().toISOString();

    // 2. Wrap everything in a transaction
    const transaction = db.transaction(() => {
      // 2a. Insert artifact
      db.prepare(`
        INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        artifactId,
        input.runId,
        input.taskId,
        'diagnostician_output',
        JSON.stringify(input.output),
        now,
      );

      // 2b. Insert commit record
      db.prepare(`
        INSERT INTO commits (commit_id, task_id, run_id, artifact_id, idempotency_key, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        commitId,
        input.taskId,
        input.runId,
        artifactId,
        input.idempotencyKey,
        'committed',
        now,
      );

      // 2c. Extract and insert principle candidates
      let candidateCount = 0;
      const principleRecommendations = input.output.recommendations.filter(
        (r) => r.kind === 'principle',
      );

      for (let i = 0; i < principleRecommendations.length; i++) {
        const rec = principleRecommendations[i];
        if (!rec) continue;

        // Application-layer guard against pathological inputs
        if (rec.description.length > 10_000) {
          throw new PDRuntimeError(
            'input_invalid',
            `Recommendation description exceeds 10,000 character limit (${rec.description.length})`,
          );
        }

        const candidateId = randomUUID();
        const candidateIdemKey = `${commitId}:${i}`;

        // Title defaults to description (DiagnosticianRecommendation has no title field)
        const title = rec.description;

        db.prepare(`
          INSERT INTO principle_candidates
            (candidate_id, artifact_id, task_id, source_run_id, title, description,
             confidence, source_recommendation_json, idempotency_key, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          candidateId,
          artifactId,
          input.taskId,
          input.runId,
          title,
          rec.description,
          input.output.confidence ?? null,
          JSON.stringify(rec),
          candidateIdemKey,
          'pending',
          now,
        );
        candidateCount++;
      }

      return candidateCount;
    });

    try {
      const candidateCount = transaction();
      return { commitId, artifactId, candidateCount };
    } catch (err: unknown) {
      // 3. Handle idempotency: re-commit returns existing result
      const existingResult = SqliteDiagnosticianCommitter.tryGetExistingCommit(db, input.runId, input.idempotencyKey);
      if (existingResult) {
        return existingResult;
      }

      // 4. Preserve already-typed PDRuntimeErrors (e.g., input_invalid from guard)
      if (err instanceof PDRuntimeError) {
        throw err;
      }

      // 5. Wrap unknown SQL errors as PDRuntimeError
      const constraint = SqliteDiagnosticianCommitter.extractConstraint(err);
      throw new PDRuntimeError(
        'artifact_commit_failed',
        'Failed to commit diagnostician output',
        { originalError: String(err), constraint },
      );
    }
  }

  /**
   * Attempt to return an existing CommitResult when UNIQUE constraint is violated.
   * Returns null if no existing commit found (re-throw original error).
   */
  private static tryGetExistingCommit(
    db: BetterSqlite3.Database,
    runId: string,
    idempotencyKey: string,
  ): CommitResult | null {
    // Try finding by idempotency_key first (most specific), then by run_id
    const byIdemKey = db
      .prepare(`
        SELECT c.commit_id, c.artifact_id,
               (SELECT COUNT(*) FROM principle_candidates pc WHERE pc.artifact_id = c.artifact_id) AS candidate_count
        FROM commits c
        WHERE c.idempotency_key = ?
      `)
      .get(idempotencyKey) as { commit_id: string; artifact_id: string; candidate_count: number } | undefined;

    if (byIdemKey) {
      return {
        commitId: byIdemKey.commit_id,
        artifactId: byIdemKey.artifact_id,
        candidateCount: byIdemKey.candidate_count,
      };
    }

    const byRunId = db
      .prepare(`
        SELECT c.commit_id, c.artifact_id,
               (SELECT COUNT(*) FROM principle_candidates pc WHERE pc.artifact_id = c.artifact_id) AS candidate_count
        FROM commits c
        WHERE c.run_id = ?
      `)
      .get(runId) as { commit_id: string; artifact_id: string; candidate_count: number } | undefined;

    if (byRunId) {
      return {
        commitId: byRunId.commit_id,
        artifactId: byRunId.artifact_id,
        candidateCount: byRunId.candidate_count,
      };
    }

    return null;
  }

  /**
   * Extract SQLite constraint name from an error object.
   */
  private static extractConstraint(err: unknown): string | undefined {
    if (err instanceof Error && 'code' in err) {
      const sqliteErr = err as { code: string };
      const msg = err.message;
      const match = /UNIQUE constraint failed[;:]\s*(.+)/i.exec(msg);
      return match ? match[1] : sqliteErr.code;
    }
    return undefined;
  }
}
