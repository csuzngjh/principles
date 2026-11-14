/**
 * DiagnosticianCommitter — atomic commit interface for DiagnosticianOutputV2.
 *
 * Persists a DiagnosticianOutputV2 to the artifact registry (artifacts +
 * commits + principle_candidates) inside a single SQLite transaction, with
 * idempotent re-commit support via UNIQUE constraints on run_id and
 * idempotency_key.
 *
 * PRI-1146 (V2 Only): only V2 output is accepted. Each candidate row keeps the
 * original structured recommendation in `source_recommendation_json` —
 * including `recommendationRef` and, for rules, `principleAssociation` — so
 * the recommendationRef → candidateId mapping is deterministically
 * reconstructible per artifact (same artifact_id + unique ref).
 *
 * COMT-01 through COMT-06
 */
import { Value } from '@sinclair/typebox/value';
import { randomUUID } from 'crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { SqliteConnection } from '../sqlite-connection.js';
import { PDRuntimeError } from '../../error-categories.js';
import { DiagnosticianOutputV2Schema, type DiagnosticianOutputV2 } from '../../diagnostician-output.js';

// ── Public Types ─────────────────────────────────────────────────────────────

export interface DiagnosticianCommitter {
  /**
   * Atomically commit a DiagnosticianOutputV2 to the artifact registry.
   *
   * @param input.runId - the run producing this output
   * @param input.taskId - the task being diagnosed
   * @param input.output - the DiagnosticianOutputV2 to persist
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
  output: DiagnosticianOutputV2;
  idempotencyKey: string;
  /**
   * Optional pre-built `contentJson` for the committed artifact. When omitted,
   * the committer serializes `output` itself (current behavior, shared with
   * the legacy monolithic diagnostician).
   *
   * Used by Layer 0 of the internalization progressive disclosure (design
   * §6.1, PR 1 task 3.11): the split diag-router runner builds an
   * ArtifactSummary envelope and passes the resulting JSON string here so the
   * committed principle artifact carries the same `summary` /
   * `predecessorSummary` fields every other SummaryRunnerKind writer attaches.
   * rc-9: when the runner's envelope build degrades it simply omits this
   * field and the committer falls back to `JSON.stringify(output)` — never
   * silent.
   */
  readonly contentJson?: string;
}

export interface CommitResult {
  commitId: string;
  artifactId: string;
  candidateCount: number;
}

/** A PI-artifact row written in the SAME transaction as the commit. */
export interface CommitPIArtifactInput {
  artifactId: string;
  artifactKind: string;
  lineageArtifactIds: string[];
  validationStatus: string;
  contentJson: string;
  createdAt: string;
  updatedAt: string;
}

// ── Implementation ────────────────────────────────────────────────────────────

export class SqliteDiagnosticianCommitter implements DiagnosticianCommitter {
  constructor(private readonly connection: SqliteConnection) {}

  async commit(input: CommitInput): Promise<CommitResult> {
    return this.commitSync(input);
  }

  /**
   * Synchronous commit body.
   *
   * Exists so a caller can compose the commit with OTHER writes in a single
   * SQLite transaction (SPEC §5.3: artifact + candidate + pi_artifact + task
   * success must not be four independent check-then-write steps). better-sqlite3
   * transactions require a synchronous callback, hence the sync variant.
   */
  commitSync(input: CommitInput): CommitResult {
    const db = this.connection.getDb();

    // 1. Validate input.output conforms to DiagnosticianOutputV2
    // rc-1-treat-as-unknown / rc-3-fail-loud-missing: input.output is untrusted
    // runtime data. Validate it is a non-null object BEFORE dereferencing
    // .recommendations, so a null/undefined/malformed output yields a categorized
    // PDRuntimeError('input_invalid') instead of a native TypeError.
    if (typeof input.output !== 'object' || input.output === null) {
      throw new PDRuntimeError(
        'input_invalid',
        'DiagnosticianOutputV2 output must be a non-null object',
        { taskId: input.taskId, runId: input.runId },
      );
    }
    // PRI-518 / rc-9-no-silent-fallback: reject empty recommendations explicitly
    // before the generic schema error, with a message that names the silent
    // zero-candidate failure mode. (Schema minItems is the backstop.)
    if (!Array.isArray(input.output.recommendations) || input.output.recommendations.length === 0) {
      throw new PDRuntimeError(
        'input_invalid',
        'DiagnosticianOutputV2.recommendations must be non-empty; an empty array would commit zero owner-reviewable candidates. Emit a { kind: "defer", ... } recommendation when no action is warranted.',
        { taskId: input.taskId, runId: input.runId },
      );
    }
    if (!Value.Check(DiagnosticianOutputV2Schema, input.output)) {
      throw new PDRuntimeError(
        'input_invalid',
        'DiagnosticianOutputV2 validation failed (V1 output is not accepted — the schemaVersion literal "diagnostician-output-v2" and per-recommendation recommendationRef are required)',
        { errors: [...Value.Errors(DiagnosticianOutputV2Schema, input.output)].map((e) => e.message) },
      );
    }
    // PRI-1146 / SPEC v0.6 §4: recommendationRef must be unique within the
    // artifact — the ref→candidate mapping is only deterministic when refs do
    // not collide. The validator checks this too; the committer is the write
    // boundary and re-asserts it (fail-loud, never "keep the first").
    {
      const seen = new Set<string>();
      for (const rec of input.output.recommendations) {
        if (seen.has(rec.recommendationRef)) {
          throw new PDRuntimeError(
            'input_invalid',
            `DiagnosticianOutputV2.recommendations contains duplicate recommendationRef "${rec.recommendationRef}"; refs must be unique within the artifact`,
            { taskId: input.taskId, runId: input.runId },
          );
        }
        seen.add(rec.recommendationRef);
      }
    }

    // CodeRabbit PR #1273 #14 / rc-9: when a caller supplies a pre-built
    // contentJson (Layer 0 envelope), validate it is parseable JSON
    // serializing a non-null object — otherwise the artifact row would
    // diverge from the principle_candidates rows (derived from input.output)
    // in the same transaction, and readers would fail to parse it. Fail loud
    // rather than persisting an inconsistent artifact.
    if (input.contentJson !== undefined) {
      let parsedContentJson: unknown;
      try {
        parsedContentJson = JSON.parse(input.contentJson);
      } catch {
        throw new PDRuntimeError(
          'input_invalid',
          'CommitInput.contentJson must be a valid JSON string',
          { taskId: input.taskId, runId: input.runId },
        );
      }
      if (parsedContentJson === null || typeof parsedContentJson !== 'object' || Array.isArray(parsedContentJson)) {
        throw new PDRuntimeError(
          'input_invalid',
          'CommitInput.contentJson must serialize a non-null object',
          { taskId: input.taskId, runId: input.runId },
        );
      }
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
        input.contentJson ?? JSON.stringify(input.output),
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

      // 2c. Extract and insert all recommendations (principle + rule + implementation + prompt + defer)
      let candidateCount = 0;
      for (let i = 0; i < input.output.recommendations.length; i++) {
        const rec = input.output.recommendations[i];
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

        // Title defaults to first 200 chars of description (DiagnosticianRecommendation has no title field)
        const MAX_TITLE_LENGTH = 200;
        const title = rec.description.slice(0, MAX_TITLE_LENGTH);

        db.prepare(`
          INSERT INTO principle_candidates
            (candidate_id, artifact_id, task_id, source_run_id, title, description,
             confidence, source_recommendation_json, idempotency_key, status, created_at,
             recommendation_kind, trigger_pattern, action, abstracted_principle)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          rec.kind,
          rec.triggerPattern ?? null,
          rec.action ?? null,
          rec.abstractedPrinciple ?? null,
        );
        candidateCount++;
      }

      return candidateCount;
    });

    try {
      const candidateCount = transaction();
      return { commitId, artifactId, candidateCount };
    } catch (err: unknown) {
      // 3. Preserve already-typed PDRuntimeErrors (e.g., input_invalid from guard)
      // Do this FIRST before checking existing commits — guard errors should not
      // trigger idempotency lookup (which could return unrelated existing commits).
      if (err instanceof PDRuntimeError) {
        throw err;
      }

      // 4. Handle idempotency: re-commit returns existing result
      const existingResult = SqliteDiagnosticianCommitter.tryGetExistingCommit(db, input.runId, input.idempotencyKey);
      if (existingResult) {
        return existingResult;
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
    // eslint-disable-next-line no-restricted-syntax -- 'in' required for Error subtype narrowing (err.code access)
    if (err instanceof Error && 'code' in err) {
      const sqliteErr = err as { code: string };
      const msg = err.message;
      const match = /UNIQUE constraint failed[;:]\s*(.+)/i.exec(msg);
      return match ? match[1] : sqliteErr.code;
    }
    return undefined;
  }
}
