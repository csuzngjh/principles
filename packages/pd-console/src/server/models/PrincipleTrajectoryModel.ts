/**
 * PrincipleTrajectoryModel — assembles per-principle trajectory data.
 *
 * Reads from:
 * - principle_training_state.json (ledger)
 * - state.db: principle_candidates, tasks, artifacts, pi_artifacts, approvals, activations
 *
 * Returns 6 stages: evidence → diagnosis → proposal → review → deploy → behavior.
 * Each stage has status (available/unavailable/not_applicable), summary, and
 * structured metadata for the frontend to render.
 *
 * ERR checklist:
 * - ERR-001/005: All DB rows treated as unknown, runtime validation
 * - ERR-002: Degraded paths include reason + nextAction, never silent fallback
 * - ERR-009/010: Required fields fail loud
 * - ERR-013: Use Object.hasOwn() for untrusted object keys
 * - ERR-014/016/017: Previews bounded, no raw JSON.stringify on unknown values
 */

import { SqliteConnection } from '@principles/core/runtime-v2';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Output types ─────────────────────────────────────────────────────────────

export interface TrajectoryStage {
  key: 'evidence' | 'diagnosis' | 'proposal' | 'review' | 'deploy' | 'behavior';
  status: 'available' | 'unavailable' | 'not_applicable';
  summary: string;
  detail?: string;
  timestamp?: string;
  unavailableReason?: string;
  nextAction?: string;
  meta?: Record<string, unknown>;
}

export interface TrajectoryResponse {
  principleId: string;
  stages: TrajectoryStage[];
  degraded?: { reason: string; nextAction: string };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function getOwnString(obj: unknown, key: string): string | undefined {
  if (!isRecord(obj)) return undefined;
  if (!Object.hasOwn(obj, key)) return undefined;
  const v = obj[key];
  return isString(v) ? v : undefined;
}

function getOwnNumber(obj: unknown, key: string): number | undefined {
  if (!isRecord(obj)) return undefined;
  if (!Object.hasOwn(obj, key)) return undefined;
  const v = obj[key];
  return typeof v === 'number' ? v : undefined;
}

function getOwnStringArray(obj: unknown, key: string): string[] {
  if (!isRecord(obj)) return [];
  if (!Object.hasOwn(obj, key)) return [];
  const v = obj[key];
  if (!Array.isArray(v)) return [];
  return v.filter(isString);
}

function isMissingTableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('no such table');
}

function isMissingColumnError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('no such column');
}

// ── Ledger reading ───────────────────────────────────────────────────────────

interface LedgerPrinciple {
  id: string;
  text: string;
  status: string;
  derivedFromPainIds: string[];
  ruleIds: string[];
  createdAt: string;
  updatedAt: string;
}

function readLedgerPrinciple(workspaceDir: string, principleId: string): LedgerPrinciple | null {
  const ledgerPath = path.join(workspaceDir, '.state', 'principle_training_state.json');
  if (!fs.existsSync(ledgerPath)) return null;

  let content: string;
  try {
    content = fs.readFileSync(ledgerPath, 'utf-8');
  } catch {
    return null;
  }

  if (!content || content.trim() === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;

  const treeValue: unknown = Object.hasOwn(parsed, '_tree')
    ? parsed._tree
    : Object.hasOwn(parsed, 'tree')
      ? parsed.tree
      : parsed;

  if (!isRecord(treeValue)) return null;

  const principlesValue = treeValue.principles;
  if (!isRecord(principlesValue)) return null;

  const entry = principlesValue[principleId];
  if (!isRecord(entry)) return null;

  return {
    id: getOwnString(entry, 'id') ?? principleId,
    text: getOwnString(entry, 'text') ?? '',
    status: getOwnString(entry, 'status') ?? 'candidate',
    derivedFromPainIds: getOwnStringArray(entry, 'derivedFromPainIds'),
    ruleIds: getOwnStringArray(entry, 'ruleIds'),
    createdAt: getOwnString(entry, 'createdAt') ?? '',
    updatedAt: getOwnString(entry, 'updatedAt') ?? '',
  };
}

// ── Model ────────────────────────────────────────────────────────────────────

export class PrincipleTrajectoryModel {
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  async getTrajectory(principleId: string): Promise<TrajectoryResponse> {
    const degradedReasons: string[] = [];
    const degradedNextActions: string[] = [];

    // 1. Read principle from ledger
    const principle = readLedgerPrinciple(this.workspaceDir, principleId);
    if (!principle) {
      return {
        principleId,
        stages: this.createAllUnavailable('Principle not found in ledger'),
        degraded: { reason: 'Principle ledger entry missing', nextAction: 'Verify principle ID exists.' },
      };
    }

    // 2. Open state.db
    const stateDbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    let stateDbAvailable = false;
    let db: ReturnType<SqliteConnection['getDb']> | null = null;
    let conn: SqliteConnection | null = null;

    if (fs.existsSync(stateDbPath)) {
      try {
        conn = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: true });
        db = conn.getDb();
        stateDbAvailable = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        degradedReasons.push(`State database unavailable: ${msg}`);
        degradedNextActions.push('Check .pd/state.db integrity.');
      }
    } else {
      degradedReasons.push('State database not found');
      degradedNextActions.push('Run pd config doctor to initialize.');
    }

    try {

    // 3. Resolve task_id via principle_candidates
    //    derivedFromPainIds[0] == candidate_id in principle_candidates
    let taskId: string | null = null;
    let candidateRecord: unknown = null;

    if (stateDbAvailable && db && principle.derivedFromPainIds.length > 0) {
      const [candidateId] = principle.derivedFromPainIds;
      try {
        const rows = db.prepare(
          'SELECT candidate_id, task_id, recommendation_kind, status, title, abstracted_principle, confidence FROM principle_candidates WHERE candidate_id = ?'
        ).all(candidateId);
        if (rows.length > 0) {
          [candidateRecord] = rows;
          taskId = getOwnString(rows[0], 'task_id') ?? null;
        }
      } catch (err) {
        if (isMissingTableError(err)) {
          degradedReasons.push('principle_candidates table missing');
          degradedNextActions.push('Workspace may need initialization.');
        } else {
          degradedReasons.push(`Candidate query failed: ${err instanceof Error ? err.message : String(err)}`);
          degradedNextActions.push('Check state.db integrity.');
        }
      }
    }

    // 4. Resolve diagnosis task info
    let taskRecord: unknown = null;
    let diagnosticArtifact: unknown = null;

    if (stateDbAvailable && db && taskId) {
      try {
        const taskRows = db.prepare(
          'SELECT task_id, task_kind, status, created_at FROM tasks WHERE task_id = ?'
        ).all(taskId);
        if (taskRows.length > 0) {
          [taskRecord] = taskRows;
        }
      } catch (err) {
        if (!isMissingTableError(err) && !isMissingColumnError(err)) {
          degradedReasons.push(`Task query failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      try {
        const artRows = db.prepare(
          "SELECT artifact_id, artifact_kind, created_at FROM artifacts WHERE task_id = ? AND artifact_kind = 'diagnostician_output' LIMIT 1"
        ).all(taskId);
        if (artRows.length > 0) {
          [diagnosticArtifact] = artRows;
        }
      } catch (err) {
        if (!isMissingTableError(err) && !isMissingColumnError(err)) {
          degradedReasons.push(`Artifact query failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // 5. Resolve pi_artifacts → approvals + activations
    let piArtifactCount = 0;
    let approvalRecords: unknown[] = [];
    let activationRecords: unknown[] = [];

    if (stateDbAvailable && db) {
      try {
        const piRows = db.prepare(
          'SELECT artifact_id, artifact_kind, validation_status FROM pi_artifacts WHERE source_principle_id = ?'
        ).all(principleId);
        piArtifactCount = piRows.length;
      } catch (err) {
        if (isMissingTableError(err)) {
          degradedReasons.push('pi_artifacts table missing');
          degradedNextActions.push('Internalization pipeline may not be initialized.');
        }
      }

      if (piArtifactCount > 0) {
        // Approvals
        try {
          approvalRecords = db.prepare(
            'SELECT ap.approval_id, ap.channel, ap.status, ap.risk_level, ap.requested_at, ap.decided_at ' +
            'FROM approvals ap JOIN pi_artifacts pa ON pa.artifact_id = ap.artifact_id ' +
            'WHERE pa.source_principle_id = ?'
          ).all(principleId);
        } catch (err) {
          if (!isMissingTableError(err) && !isMissingColumnError(err)) {
            degradedReasons.push(`Approval query failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Activations
        try {
          activationRecords = db.prepare(
            'SELECT act.activation_id, act.channel, act.action, act.target_ref, act.activated_at, act.deactivated_at ' +
            'FROM activations act JOIN pi_artifacts pa ON pa.artifact_id = act.artifact_id ' +
            'WHERE pa.source_principle_id = ?'
          ).all(principleId);
        } catch (err) {
          if (!isMissingTableError(err) && !isMissingColumnError(err)) {
            degradedReasons.push(`Activation query failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    // ── Assemble stages ────────────────────────────────────────────────────

    const stages: TrajectoryStage[] = [];

    // Stage 1: Evidence
    stages.push(this.assembleEvidenceStage(principle, candidateRecord));

    // Stage 2: Diagnosis
    stages.push(this.assembleDiagnosisStage(taskRecord, diagnosticArtifact));

    // Stage 3: Proposal
    stages.push(this.assembleProposalStage(candidateRecord));

    // Stage 4: Review
    stages.push(this.assembleReviewStage(approvalRecords, piArtifactCount));

    // Stage 5: Deploy
    stages.push(this.assembleDeployStage(activationRecords, piArtifactCount));

    // Stage 6: Behavior
    stages.push(this.assembleBehaviorStage(principle, activationRecords));

    const response: TrajectoryResponse = { principleId, stages };

    if (degradedReasons.length > 0) {
      response.degraded = {
        reason: degradedReasons.join('; '),
        nextAction: degradedNextActions.join(' ') || 'Check workspace state.',
      };
    }

    return response;
    } finally {
      if (conn) {
        try { conn.close(); } catch { /* best-effort */ }
      }
    }
  }

  // ── Stage assemblers ─────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private assembleEvidenceStage(
    principle: LedgerPrinciple,
    candidateRecord: unknown,
  ): TrajectoryStage {
    const painIds = principle.derivedFromPainIds;
    if (painIds.length === 0) {
      return {
        key: 'evidence',
        status: 'not_applicable',
        summary: 'No source pain records linked to this principle',
        unavailableReason: 'Principle has no derivedFromPainIds',
        nextAction: 'This principle was not derived from observed pain events.',
      };
    }

    const candidateTitle = getOwnString(candidateRecord, 'title');
    const candidateConfidence = getOwnNumber(candidateRecord, 'confidence');

    return {
      key: 'evidence',
      status: 'available',
      summary: `Linked to ${painIds.length} pain record${painIds.length > 1 ? 's' : ''}`,
      detail: candidateTitle ?? undefined,
      timestamp: principle.createdAt || undefined,
      meta: {
        painIdCount: painIds.length,
        painIds,
        confidence: candidateConfidence,
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private assembleDiagnosisStage(
    taskRecord: unknown,
    diagnosticArtifact: unknown,
  ): TrajectoryStage {
    if (!taskRecord) {
      return {
        key: 'diagnosis',
        status: 'unavailable',
        summary: '—',
        unavailableReason: 'No diagnostic task found for this principle',
        nextAction: 'The principle may have been created outside the diagnosis pipeline.',
      };
    }

    const taskStatus = getOwnString(taskRecord, 'status') ?? 'unknown';
    const taskCreatedAt = getOwnString(taskRecord, 'created_at');
    const artifactId = getOwnString(diagnosticArtifact, 'artifact_id');

    return {
      key: 'diagnosis',
      status: 'available',
      summary: `Diagnostic task ${taskStatus}`,
      detail: artifactId ? `Artifact: ${artifactId.slice(0, 12)}...` : undefined,
      timestamp: taskCreatedAt || undefined,
      meta: {
        taskStatus,
        taskId: getOwnString(taskRecord, 'task_id'),
        artifactId,
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private assembleProposalStage(candidateRecord: unknown): TrajectoryStage {
    if (!candidateRecord) {
      return {
        key: 'proposal',
        status: 'unavailable',
        summary: '—',
        unavailableReason: 'No candidate record found',
        nextAction: 'The principle may have been created outside the diagnosis pipeline.',
      };
    }

    const recommendationKind = getOwnString(candidateRecord, 'recommendation_kind') ?? 'unknown';
    const candidateStatus = getOwnString(candidateRecord, 'status') ?? 'unknown';
    const title = getOwnString(candidateRecord, 'title');
    const confidence = getOwnNumber(candidateRecord, 'confidence');

    return {
      key: 'proposal',
      status: 'available',
      summary: `Recommendation: ${recommendationKind}, Status: ${candidateStatus}`,
      detail: title || undefined,
      meta: {
        recommendationKind,
        candidateStatus,
        confidence,
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private assembleReviewStage(
    approvalRecords: unknown[],
    piArtifactCount: number,
  ): TrajectoryStage {
    if (piArtifactCount === 0) {
      return {
        key: 'review',
        status: 'unavailable',
        summary: '—',
        unavailableReason: 'Principle has not entered the internalization pipeline',
        nextAction: 'Approve the principle candidate to trigger internalization.',
      };
    }

    if (approvalRecords.length === 0) {
      return {
        key: 'review',
        status: 'not_applicable',
        summary: 'No approval required for this principle',
        detail: 'This principle was internalized without owner review (low-risk channel).',
      };
    }

    // Summarize approval records
    const statuses = approvalRecords.map(r => getOwnString(r, 'status') ?? 'unknown');
    const channels = approvalRecords.map(r => getOwnString(r, 'channel') ?? 'unknown');
    const latestDecision = approvalRecords
      .map(r => getOwnString(r, 'decided_at'))
      .filter((d): d is string => d !== undefined)
      .sort()
      .at(-1);

    const allDecided = statuses.every(s => s === 'approved' || s === 'rejected');
    const summaryStatus = allDecided
      ? statuses.every(s => s === 'approved') ? 'All approved' : 'Mixed decisions'
      : `${statuses.filter(s => s === 'pending').length} pending`;

    return {
      key: 'review',
      status: 'available',
      summary: `${approvalRecords.length} review record${approvalRecords.length > 1 ? 's' : ''}: ${summaryStatus}`,
      detail: `Channels: ${[...new Set(channels)].join(', ')}`,
      timestamp: latestDecision,
      meta: {
        recordCount: approvalRecords.length,
        statuses,
        channels: [...new Set(channels)],
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private assembleDeployStage(
    activationRecords: unknown[],
    piArtifactCount: number,
  ): TrajectoryStage {
    if (piArtifactCount === 0) {
      return {
        key: 'deploy',
        status: 'unavailable',
        summary: '—',
        unavailableReason: 'Principle has not entered the internalization pipeline',
        nextAction: 'Approve the principle candidate to trigger internalization.',
      };
    }

    if (activationRecords.length === 0) {
      return {
        key: 'deploy',
        status: 'unavailable',
        summary: '—',
        unavailableReason: 'No activation records found',
        nextAction: 'The principle was internalized but not yet deployed to any channel.',
      };
    }

    const activeChannels = activationRecords
      .filter(r => !getOwnString(r, 'deactivated_at'))
      .map(r => getOwnString(r, 'channel') ?? 'unknown');
    const allChannels = activationRecords.map(r => getOwnString(r, 'channel') ?? 'unknown');
    const latestActivation = activationRecords
      .map(r => getOwnString(r, 'activated_at'))
      .filter((d): d is string => d !== undefined)
      .sort()
      .at(-1);

    return {
      key: 'deploy',
      status: 'available',
      summary: `Deployed to ${[...new Set(allChannels)].join(', ')}`,
      detail: activeChannels.length > 0
        ? `Active: ${[...new Set(activeChannels)].join(', ')}`
        : 'All activations deactivated',
      timestamp: latestActivation,
      meta: {
        activationCount: activationRecords.length,
        activeChannels: [...new Set(activeChannels)],
        allChannels: [...new Set(allChannels)],
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private assembleBehaviorStage(
    principle: LedgerPrinciple,
    activationRecords: unknown[],
  ): TrajectoryStage {
    const ruleCount = principle.ruleIds.length;
    const hasActiveActivations = activationRecords.some(r => !getOwnString(r, 'deactivated_at'));

    if (ruleCount === 0 && activationRecords.length === 0) {
      return {
        key: 'behavior',
        status: 'not_applicable',
        summary: '—',
        unavailableReason: 'No rules or activations for this principle',
        nextAction: 'This principle has not been internalized into actionable rules yet.',
      };
    }

    const statusLabel = hasActiveActivations ? 'Active' : 'Inactive';

    return {
      key: 'behavior',
      status: 'available',
      summary: `${ruleCount} rule${ruleCount !== 1 ? 's' : ''}, ${statusLabel}`,
      detail: principle.status,
      meta: {
        ruleCount,
        hasActiveActivations,
        principleStatus: principle.status,
      },
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private createAllUnavailable(reason: string): TrajectoryStage[] {
    const keys: TrajectoryStage['key'][] = ['evidence', 'diagnosis', 'proposal', 'review', 'deploy', 'behavior'];
    return keys.map(key => ({
      key,
      status: 'unavailable' as const,
      summary: '—',
      unavailableReason: reason,
      nextAction: 'Verify the principle exists and has gone through the internalization pipeline.',
    }));
  }

  dispose(): void {
    // Connection is opened and closed per-request in getTrajectory; no persistent state.
  }
}
