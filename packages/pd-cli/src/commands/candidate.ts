/**
 * pd candidate commands — Principle candidate inspection, intake, audit, repair.
 *
 * Usage:
 *   pd candidate list --task-id <taskId> --workspace <path> [--json]
 *   pd candidate show <candidateId> --workspace <path> [--json]
 *   pd candidate intake --candidate-id <id> [--workspace <path>] [--json] [--dry-run]
 *   pd candidate audit --workspace <path> [--json]
 *   pd candidate repair --candidate-id <id> --workspace <path> [--json]
 *   pd candidate route --candidate-id <id> --workspace <path> [--json]
 */
import { randomUUID } from 'crypto';
import * as path from 'path';
import {
  RuntimeStateManager,
  SqliteConnection,
  candidateList,
  candidateShow,
  CandidateIntakeService,
  CandidateIntakeError,
  loadLedger,
  getLedgerFilePathPublic,
  decideInternalizationRoute,
  createPITaskDiagnosticJson,
  type LedgerPrincipleEntry,
} from '@principles/core/runtime-v2';
import { PrincipleTreeLedgerAdapter } from '../principle-tree-ledger-adapter.js';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { createRemediationResult, remediationAction } from './remediation-output.js';
import type { RemediationResult } from './remediation-output.js';

// ── Interfaces ────────────────────────────────────────────────────────────────

interface CandidateListOptions {
  taskId: string;
  workspace?: string;
  json?: boolean;
}

interface CandidateShowOptions {
  candidateId: string;
  workspace?: string;
  json?: boolean;
}

interface CandidateIntakeOptions {
  candidateId: string;
  workspace?: string;
  json?: boolean;
  dryRun?: boolean;
}

interface CandidateAuditOptions {
  workspace?: string;
  json?: boolean;
}

interface CandidateRepairOptions {
  candidateId: string;
  workspace?: string;
  json?: boolean;
}

interface AuditResult {
  status: 'ok' | 'degraded';
  consumedCount: number;
  missingLedgerEntryIds: string[];
  checkedLedgerPath: string;
  checkedDbPath: string;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/** Update candidate status. Sets consumed_at when status='consumed'. */
async function updateCandidateStatus(stateManager: RuntimeStateManager, candidateId: string, status: string): Promise<void> {
  const db = stateManager.connection;
  const now = new Date().toISOString();
  if (status === 'consumed') {
    db.getDb().prepare(
      'UPDATE principle_candidates SET status = ?, consumed_at = ? WHERE candidate_id = ?'
    ).run(status, now, candidateId);
  } else {
    db.getDb().prepare(
      'UPDATE principle_candidates SET status = ? WHERE candidate_id = ?'
    ).run(status, candidateId);
  }
}

/**
 * Ensure consumed_at is set for a consumed candidate.
 * Returns the consumed_at value (existing or newly written), or null if candidate not found.
 */
async function ensureConsumedAt(stateManager: RuntimeStateManager, candidateId: string): Promise<string | null> {
  const db = stateManager.connection;
  const row = db.getDb().prepare('SELECT consumed_at FROM principle_candidates WHERE candidate_id = ?').get(candidateId) as { consumed_at: string | null } | undefined;
  if (!row) return null;
  if (row.consumed_at) return row.consumed_at;
  const now = new Date().toISOString();
  db.getDb().prepare('UPDATE principle_candidates SET consumed_at = ? WHERE candidate_id = ?').run(now, candidateId);
  return now;
}

interface ResolvedRecommendation {
  kind: string;
  description: string;
  triggerPattern?: string;
  action?: string;
  abstractedPrinciple?: string;
  usedFallback: boolean;
}

function resolveCandidateRecommendation(
  candidate: { sourceRecommendationJson?: string; description?: string },
  stateManager: RuntimeStateManager,
  candidateId: string,
): ResolvedRecommendation {
  if (candidate.sourceRecommendationJson) {
    try {
      const parsed = JSON.parse(candidate.sourceRecommendationJson);
      if (parsed?.kind) {
        return {
          kind: parsed.kind,
          description: parsed.description ?? candidate.description ?? '',
          triggerPattern: parsed.triggerPattern,
          action: parsed.action,
          abstractedPrinciple: parsed.abstractedPrinciple,
          usedFallback: false,
        };
      }
    } catch { /* fall through to column fallback */ }
  }

  const row = stateManager.connection.getDb().prepare(
    'SELECT recommendation_kind, trigger_pattern, action, abstracted_principle FROM principle_candidates WHERE candidate_id = ?',
  ).get(candidateId) as
    { recommendation_kind: string; trigger_pattern: string | null; action: string | null; abstracted_principle: string | null } | undefined;

  if (row) {
    return {
      kind: row.recommendation_kind,
      description: candidate.description || '',
      triggerPattern: row.trigger_pattern ?? undefined,
      action: row.action ?? undefined,
      abstractedPrinciple: row.abstracted_principle ?? undefined,
      usedFallback: true,
    };
  }

  return {
    kind: 'defer',
    description: candidate.description || 'No recommendation data available',
    usedFallback: false,
  };
}

// ── List ───────────────────────────────────────────────────────────────────────

export async function handleCandidateList(opts: CandidateListOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();

    const result = await candidateList({
      taskId: opts.taskId,
      stateManager,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.candidates.length === 0) {
      console.log(`No candidates found for task: ${opts.taskId}`);
      return;
    }

    console.log(`\nPrinciple Candidates for Task: ${opts.taskId}\n`);
    console.log(`  Total: ${result.candidates.length}\n`);

    for (const candidate of result.candidates) {
      console.log(`  Candidate: ${candidate.candidateId}`);
      console.log(`    Title:       ${candidate.title}`);
      console.log(`    Artifact:    ${candidate.artifactId}`);
      console.log(`    Source Run:  ${candidate.sourceRunId}`);
      console.log(`    Confidence:  ${candidate.confidence ?? 'N/A'}`);
      console.log(`    Status:      ${candidate.status}`);
      console.log(`    Description: ${candidate.description.substring(0, 100)}${candidate.description.length > 100 ? '...' : ''}`);
      console.log('');
    }
  } finally {
    await stateManager.close();
  }
}

// ── Internalize (PRI-89) ──────────────────────────────────────────────────────

interface CandidateInternalizeOptions {
  candidateId: string;
  workspace?: string;
  json?: boolean;
  dryRun?: boolean;
}

interface CandidateInternalizeResult {
  candidateId: string;
  route: string;
  taskId?: string;
  channel?: string;
  status: 'created' | 'existing' | 'dry_run' | 'no_task_created';
  reason?: string;
}

const ROUTE_CHANNEL_MAP: Record<string, string> = {
  'principle-ledger': 'prompt',
  'rule-candidate': 'code_tool_hook',
  'implementation-candidate': 'skill',
  'prompt-injection-candidate': 'prompt',
};

export async function handleCandidateInternalize(opts: CandidateInternalizeOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();

    const candidate = await stateManager.getCandidate(opts.candidateId);
    if (!candidate) {
      const result: CandidateInternalizeResult = {
        candidateId: opts.candidateId,
        route: 'unknown',
        status: 'no_task_created',
        reason: `Candidate not found: ${opts.candidateId}`,
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`Candidate not found: ${opts.candidateId}`);
      }
      process.exit(1);
      return;
    }

    const recommendation = resolveCandidateRecommendation(candidate, stateManager, opts.candidateId);

    const decision = decideInternalizationRoute(recommendation as Parameters<typeof decideInternalizationRoute>[0]);

    if (!decision.ready || decision.route === 'deferred') {
      const result: CandidateInternalizeResult = {
        candidateId: opts.candidateId,
        route: decision.route,
        status: 'no_task_created',
        reason: decision.reason,
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\nCandidate Internalize: ${opts.candidateId}\n`);
        console.log(`  Route:   ${decision.route}`);
        console.log(`  Ready:   ${decision.ready}`);
        console.log(`  Reason:  ${decision.reason}`);
        console.log('');
      }
      return;
    }

    const channel = ROUTE_CHANNEL_MAP[decision.route] ?? 'prompt';

    if (opts.dryRun) {
      const result: CandidateInternalizeResult = {
        candidateId: opts.candidateId,
        route: decision.route,
        channel,
        status: 'dry_run',
        reason: 'Dry-run mode — no task created',
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\nCandidate Internalize (dry-run): ${opts.candidateId}\n`);
        console.log(`  Route:    ${decision.route}`);
        console.log(`  Channel:  ${channel}`);
        console.log(`  Would create: dreamer PI task`);
        console.log('');
      }
      return;
    }

    const taskId = `dreamer-${opts.candidateId}-${channel}`;

    const existingTask = await stateManager.getTask(taskId);
    if (existingTask) {
      const result: CandidateInternalizeResult = {
        candidateId: opts.candidateId,
        route: decision.route,
        taskId: existingTask.taskId,
        channel,
        status: 'existing',
        reason: 'Task already exists for this candidate+channel combination',
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\nCandidate Internalize: ${opts.candidateId}\n`);
        console.log(`  Route:    ${decision.route}`);
        console.log(`  Channel:  ${channel}`);
        console.log(`  Task:     ${existingTask.taskId} (existing)`);
        console.log('');
      }
      return;
    }

    const diagnosticJson = createPITaskDiagnosticJson({
      dependencyTaskIds: [],
      channel: channel as 'prompt' | 'skill' | 'code_tool_hook' | 'model_training',
      timeoutMs: 300_000,
      inputArtifactRefs: [{ artifactType: 'candidate', ref: `candidate://${opts.candidateId}` }],
      outputArtifactRefs: [],
      parentTaskId: undefined,
      correlationId: opts.candidateId,
    });

    let finalDiagnosticJson = diagnosticJson;
    try {
      const diagObj = JSON.parse(diagnosticJson);
      diagObj.candidateId = opts.candidateId;
      finalDiagnosticJson = JSON.stringify(diagObj);
    } catch {
      finalDiagnosticJson = diagnosticJson;
    }

    const task = await stateManager.createTask({
      taskId,
      taskKind: 'dreamer',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: finalDiagnosticJson,
    });

    const result: CandidateInternalizeResult = {
      candidateId: opts.candidateId,
      route: decision.route,
      taskId: task.taskId,
      channel,
      status: 'created',
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\nCandidate Internalize: ${opts.candidateId}\n`);
      console.log(`  Route:    ${decision.route}`);
      console.log(`  Channel:  ${channel}`);
      console.log(`  Task:     ${task.taskId} (created)`);
      console.log('');
    }
  } finally {
    await stateManager.close();
  }
}

// ── Show ───────────────────────────────────────────────────────────────────────

export async function handleCandidateShow(opts: CandidateShowOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();

    const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir: path.join(workspaceDir, '.state') });

    const result = await candidateShow({
      candidateId: opts.candidateId,
      stateManager,
      ledgerAdapter,
    });

    if (!result) {
      console.error(`Candidate not found: ${opts.candidateId}`);
      process.exit(1);
    }

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`\nPrinciple Candidate: ${result.candidateId}\n`);
    console.log(`  Title:       ${result.title}`);
    console.log(`  Description: ${result.description}`);
    console.log(`  Artifact:    ${result.artifactId}`);
    console.log(`  Task:        ${result.taskId}`);
    console.log(`  Source Run:  ${result.sourceRunId}`);
    console.log(`  Confidence:  ${result.confidence ?? 'N/A'}`);
    console.log(`  Status:      ${result.status}`);
    console.log(`  Created:     ${result.createdAt}`);
    if (result.ledgerEntryId) {
      console.log(`  Ledger Entry: ${result.ledgerEntryId}`);
    }
    console.log('');
  } finally {
    await stateManager.close();
  }
}

// ── Intake ───────────────────────────────────────────────────────────────────

/**
 * pd candidate intake --candidate-id <id> [--workspace <path>] [--json] [--dry-run]
 *
 * Intakes a principle candidate into the ledger.
 * Wires together CandidateIntakeService + PrincipleTreeLedgerAdapter.
 * Updates candidate status to 'consumed' (with consumed_at) after successful ledger write.
 * If ledger write succeeds but DB update fails, exits non-zero with clear error.
 */
export async function handleCandidateIntake(opts: CandidateIntakeOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();

    const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir: path.join(workspaceDir, '.state') });
    const service = new CandidateIntakeService({ stateManager, ledgerAdapter });

    if (opts.dryRun) {
      const candidate = await stateManager.getCandidate(opts.candidateId);
      if (!candidate) {
        console.error(`Candidate not found: ${opts.candidateId}`);
        process.exit(1);
      }
      const artifact = await stateManager.getArtifact(candidate.artifactId);
      if (!artifact) {
        console.error(`Artifact not found for candidate: ${opts.candidateId}`);
        process.exit(1);
      }
      let recommendation: { title?: string; text?: string; triggerPattern?: string; action?: string } = {};
      try {
        const parsed = JSON.parse(artifact.contentJson || '{}');
        recommendation = parsed.recommendation || parsed;
      } catch (err) {
        console.warn(`Warning: could not parse artifact content as JSON — using defaults. ${err instanceof Error ? err.message : String(err)}`);
      }
      const entry: LedgerPrincipleEntry = {
        id: randomUUID(),
        title: recommendation.title || candidate.title,
        text: recommendation.text || candidate.description || '',
        triggerPattern: recommendation.triggerPattern || '',
        action: recommendation.action || '',
        status: 'probation',
        evaluability: 'weak_heuristic',
        sourceRef: `candidate://${opts.candidateId}`,
        artifactRef: `artifact://${candidate.artifactId}`,
        taskRef: candidate.taskId ? `task://${candidate.taskId}` : undefined,
        createdAt: new Date().toISOString(),
      };
      if (opts.json) {
        console.log(JSON.stringify(entry, null, 2));
      } else {
        console.log(`Dry-run: would write entry for candidate ${opts.candidateId}`);
        console.log(JSON.stringify(entry, null, 2));
      }
      return;
    }

    // Normal intake: ledger write first
    const entry = await service.intake(opts.candidateId);

    // Check if already consumed before this call
    const candidate = await stateManager.getCandidate(opts.candidateId);
    if (candidate?.status === 'consumed') {
      const infoMessage = `Candidate ${opts.candidateId} was already consumed. Ledger entry: ${entry.id}`;
      if (opts.json) {
        console.log(JSON.stringify({
          candidateId: opts.candidateId,
          ledgerEntryId: entry.id,
          status: 'already_consumed',
          message: infoMessage,
        }, null, 2));
      } else {
        console.log(infoMessage);
      }
      return;
    }

    // Update DB status — this must succeed; if it fails, exit non-zero
    try {
      await updateCandidateStatus(stateManager, opts.candidateId, 'consumed');
    } catch (err) {
      const msg = `Ledger write succeeded (entry ${entry.id}) but DB status update failed: ${err instanceof Error ? err.message : String(err)}. ` +
        `Candidate ${opts.candidateId} may be in inconsistent state.`;
      console.error(`ERROR: ${msg}`);
      process.exit(1);
    }

    const result = {
      candidateId: opts.candidateId,
      ledgerEntryId: entry.id,
      status: 'consumed',
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\nPrinciple Candidate Intake: ${opts.candidateId}\n`);
      console.log(`  Candidate:    ${opts.candidateId}`);
      console.log(`  Title:        ${entry.title}`);
      console.log(`  Ledger Entry: ${entry.id}`);
      console.log(`  Status:       consumed\n`);
      console.log('Intake complete.\n');
    }
  } catch (err) {
    if (err instanceof CandidateIntakeError || (err as { name?: string }).name === 'CandidateIntakeError') {
      const e = err as { code?: string; message: string };
      console.error(`Intake failed [${e.code ?? 'unknown'}]: ${e.message}`);
    } else {
      console.error(`Intake failed: ${String(err)}`);
    }
    process.exit(1);
  } finally {
    await stateManager.close();
  }
}

// ── Audit ─────────────────────────────────────────────────────────────────────

/**
 * pd candidate audit --workspace <path> [--json]
 *
 * Reads workspace/.pd/state.db principle_candidates and
 * the workspace ledger (same file used by OpenClaw plugin).
 * Checks each consumed candidate has a ledger entry.
 * Exits non-zero if any consumed candidate is missing from ledger.
 */
export async function handleCandidateAudit(opts: CandidateAuditOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let conn: SqliteConnection | undefined;

  try {
    const dbPath = path.join(workspaceDir, '.pd', 'state.db');
    const ledgerStateDir = path.join(workspaceDir, '.state');
    const ledgerPath = getLedgerFilePathPublic(ledgerStateDir);

    conn = new SqliteConnection({ workspaceDir, readonly: true });
    const db = conn.getDb();

    const consumedRows = db.prepare(
      "SELECT candidate_id FROM principle_candidates WHERE status = 'consumed'"
    ).all() as { candidate_id: string }[];

    const consumedIds = consumedRows.map(r => r.candidate_id);

    const ledger = loadLedger(ledgerStateDir);
    const ledgerPrinciples = ledger.tree.principles;

    const missingLedgerEntryIds: string[] = [];
    for (const candidateId of consumedIds) {
      const found = Object.values(ledgerPrinciples).some((p) =>
        p.derivedFromPainIds.includes(candidateId),
      );
      if (!found) {
        missingLedgerEntryIds.push(candidateId);
      }
    }

    const result: AuditResult = {
      status: missingLedgerEntryIds.length === 0 ? 'ok' : 'degraded',
      consumedCount: consumedIds.length,
      missingLedgerEntryIds,
      checkedLedgerPath: ledgerPath,
      checkedDbPath: dbPath,
    };

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\nCandidate Audit Results\n`);
      console.log(`  consumedCount: ${result.consumedCount}`);
      console.log(`  checkedLedgerPath: ${result.checkedLedgerPath}`);
      console.log(`  checkedDbPath: ${result.checkedDbPath}`);
      console.log(`  status: ${result.status}`);
      if (result.missingLedgerEntryIds.length > 0) {
        console.log(`\n  MISSING LEDGER ENTRIES (${result.missingLedgerEntryIds.length}):`);
        result.missingLedgerEntryIds.forEach(id => console.log(`    - ${id}`));
      } else {
        console.log(`\n  All consumed candidates have ledger entries.`);
      }
      console.log('');
    }

    if (result.status === 'degraded') {
      process.exit(1);
    }
  } catch (err) {
    console.error(`Audit failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    try { conn?.close(); } catch { /* best-effort close */ }
  }
}

// ── Repair ─────────────────────────────────────────────────────────────────────

/**
 * pd candidate repair --candidate-id <id> --workspace <path> [--json]
 *
 * Handles consumed but missing ledger entries.
 * Re-calls CandidateIntakeService.intake() to write ledger entry.
 * Does not regenerate candidate; does not update status (already consumed).
 * Fills consumed_at if empty.
 */
export async function handleCandidateRepair(opts: CandidateRepairOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();

    // Verify candidate exists and is consumed
    const candidate = await stateManager.getCandidate(opts.candidateId);
    if (!candidate) {
      console.error(`Candidate not found: ${opts.candidateId}`);
      process.exit(1);
    }
    if (candidate.status !== 'consumed') {
      console.error(`Candidate ${opts.candidateId} is not consumed (status=${candidate.status}). Repair only handles consumed candidates.`);
      process.exit(1);
    }

    const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir: path.join(workspaceDir, '.state') });
    const service = new CandidateIntakeService({ stateManager, ledgerAdapter });

    // Check if already in ledger
    const existing = ledgerAdapter.existsForCandidate(opts.candidateId);
    if (existing) {
      const consumedAt = await ensureConsumedAt(stateManager, opts.candidateId);
      const result = {
        candidateId: opts.candidateId,
        status: 'already_consistent',
        message: `Candidate ${opts.candidateId} already has ledger entry.`,
        ledgerEntryId: existing.id,
        consumedAt,
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\nCandidate ${opts.candidateId} already has ledger entry: ${existing.id}\n`);
        console.log('No repair needed.\n');
      }
      return;
    }

    // Re-intake to restore ledger entry
    const entry = await service.intake(opts.candidateId);
    const consumedAt = await ensureConsumedAt(stateManager, opts.candidateId);

    const result = {
      candidateId: opts.candidateId,
      status: 'repaired',
      ledgerEntryId: entry.id,
      consumedAt,
      message: `Ledger entry restored for consumed candidate ${opts.candidateId}.`,
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\nCandidate Repair: ${opts.candidateId}\n`);
      console.log(`  Status:        repaired`);
      console.log(`  Ledger Entry:   ${entry.id}\n`);
      console.log('Repair complete.\n');
    }
  } catch (err) {
    if (err instanceof CandidateIntakeError || (err as { name?: string }).name === 'CandidateIntakeError') {
      const e = err as { code?: string; message: string };
      console.error(`Repair failed [${e.code ?? 'unknown'}]: ${e.message}`);
    } else {
      console.error(`Repair failed: ${String(err)}`);
    }
    process.exit(1);
  } finally {
    await stateManager.close();
  }
}

// ── Internalization Backfill (consumed candidates missing dreamer tasks) ──────

interface CandidateBackfillOptions {
  workspace?: string;
  json?: boolean;
  dryRun?: boolean;
  confirm?: boolean;
}

interface BackfillCandidateResult {
  candidateId: string;
  route: string;
  status: 'would_create' | 'created' | 'existing' | 'deferred' | 'error';
  taskId?: string;
  channel?: string;
  reason?: string;
}

interface BackfillOutput {
  mode: 'dry-run' | 'confirm';
  totalConsumed: number;
  missingDreamerTask: number;
  alreadyHaveTask: number;
  deferred: number;
  created: number;
  errors: number;
  results: BackfillCandidateResult[];
}

function createBackfillRemediationResult(output: BackfillOutput): RemediationResult {
  const actions = output.results
    .filter((result) => result.status === 'would_create' || result.status === 'created')
    .map((result) => remediationAction({
      action: result.status === 'created' ? 'create_dreamer_task' : 'would_create_dreamer_task',
      targetId: result.candidateId,
      previousState: 'consumed_candidate_without_dreamer',
      nextState: result.status === 'created' ? 'dreamer_task_created' : 'dreamer_task_would_be_created',
      reason: result.reason ?? `Backfill ${result.status === 'created' ? 'created' : 'would create'} dreamer task${result.taskId ? ` ${result.taskId}` : ''}`,
    }));

  return createRemediationResult({
    mode: output.mode === 'confirm' ? 'confirm' : 'dry_run',
    repairedCount: output.created,
    skippedCount: output.alreadyHaveTask + output.deferred + output.errors,
    actions,
    warnings: output.errors > 0 ? [`${output.errors} candidate(s) could not be backfilled.`] : [],
    status: output.errors > 0 && output.created === 0 ? 'error' : undefined,
    safeToConfirm: output.mode === 'dry-run' && output.missingDreamerTask > 0 && output.errors === 0,
  });
}

export async function handleCandidateInternalizationBackfill(opts: CandidateBackfillOptions): Promise<void> {
  if (opts.dryRun && opts.confirm) {
    console.error('Error: --dry-run and --confirm are mutually exclusive');
    process.exit(1);
  }

  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateManager = new RuntimeStateManager({ workspaceDir });
  const isConfirm = opts.confirm ?? false;

  try {
    await stateManager.initialize();

    const db = stateManager.connection.getDb();

    const consumedRows = db.prepare(
      "SELECT candidate_id FROM principle_candidates WHERE status = 'consumed'"
    ).all() as { candidate_id: string }[];

    const output: BackfillOutput = {
      mode: isConfirm ? 'confirm' : 'dry-run',
      totalConsumed: consumedRows.length,
      missingDreamerTask: 0,
      alreadyHaveTask: 0,
      deferred: 0,
      created: 0,
      errors: 0,
      results: [],
    };

    for (const row of consumedRows) {
      const candidateId = row.candidate_id;

      const candidate = await stateManager.getCandidate(candidateId);
      if (!candidate) {
        output.errors++;
        output.results.push({ candidateId, route: 'unknown', status: 'error', reason: 'Candidate not found in DB' });
        continue;
      }

      const recommendation = resolveCandidateRecommendation(candidate, stateManager, candidateId);
      const decision = decideInternalizationRoute(recommendation as Parameters<typeof decideInternalizationRoute>[0]);

      if (!decision.ready || decision.route === 'deferred') {
        output.deferred++;
        output.results.push({ candidateId, route: decision.route, status: 'deferred', reason: decision.reason });
        continue;
      }

      const channel = ROUTE_CHANNEL_MAP[decision.route] ?? 'prompt';
      const taskId = `dreamer-${candidateId}-${channel}`;

      const existingTask = await stateManager.getTask(taskId);
      if (existingTask) {
        if (isConfirm && existingTask.diagnosticJson) {
          try {
            const diagObj = JSON.parse(existingTask.diagnosticJson);
            if (!diagObj.candidateId) {
              diagObj.candidateId = candidateId;
              await stateManager.updateTaskDiagnosticJson(taskId, JSON.stringify(diagObj));
            }
          } catch { /* best-effort */ }
        }
        output.alreadyHaveTask++;
        output.results.push({ candidateId, route: decision.route, status: 'existing', taskId: existingTask.taskId, channel });
        continue;
      }

      output.missingDreamerTask++;

      if (!isConfirm) {
        output.results.push({ candidateId, route: decision.route, status: 'would_create', taskId, channel });
        continue;
      }

      try {
        const diagnosticJson = createPITaskDiagnosticJson({
          dependencyTaskIds: [],
          channel: channel as 'prompt' | 'skill' | 'code_tool_hook' | 'model_training',
          timeoutMs: 300_000,
          inputArtifactRefs: [{ artifactType: 'candidate', ref: `candidate://${candidateId}` }],
          outputArtifactRefs: [],
          parentTaskId: undefined,
          correlationId: candidateId,
        });

        const diagObj = JSON.parse(diagnosticJson);
        diagObj.candidateId = candidateId;
        const finalDiagnosticJson = JSON.stringify(diagObj);

        const task = await stateManager.createTask({
          taskId,
          taskKind: 'dreamer',
          status: 'pending',
          attemptCount: 0,
          maxAttempts: 3,
          diagnosticJson: finalDiagnosticJson,
        });

        output.created++;
        output.results.push({ candidateId, route: decision.route, status: 'created', taskId: task.taskId, channel });
      } catch (err) {
        output.errors++;
        output.results.push({ candidateId, route: decision.route, status: 'error', reason: err instanceof Error ? err.message : String(err) });
      }
    }

    if (opts.json) {
      console.log(JSON.stringify({ ...createBackfillRemediationResult(output), details: output }, null, 2));
    } else {
      const remediation = createBackfillRemediationResult(output);
      console.log(`\nCandidate Internalization Backfill (${output.mode})\n`);
      console.log(`  status:              ${remediation.status}`);
      console.log(`  safe_to_confirm:     ${remediation.safeToConfirm}`);
      console.log(`  total_consumed:      ${output.totalConsumed}`);
      console.log(`  missing_dreamer:     ${output.missingDreamerTask}`);
      console.log(`  already_have_task:   ${output.alreadyHaveTask}`);
      console.log(`  deferred:            ${output.deferred}`);
      if (isConfirm) {
        console.log(`  created:             ${output.created}`);
        console.log(`  errors:              ${output.errors}`);
      }
      for (const r of output.results) {
        console.log(`  ${r.candidateId}: ${r.status} (${r.route})${r.taskId ? ` → ${r.taskId}` : ''}${r.reason ? ` — ${r.reason}` : ''}`);
      }
      if (!isConfirm && output.missingDreamerTask > 0) {
        console.log(`\n  (use --confirm to create missing dreamer tasks)`);
      }
      console.log('');
    }

    if (output.missingDreamerTask > 0 && !isConfirm) {
      process.exitCode = 1;
    }
  } finally {
    await stateManager.close();
  }
}

// ── Route (Internalization Inspection) ──────────────────────────────────────

interface CandidateRouteOptions {
  candidateId: string;
  workspace?: string;
  json?: boolean;
}

/**
 * pd candidate route --candidate-id <id> --workspace <path> [--json]
 *
 * Read-only: shows which internalization pipeline route a candidate will enter,
 * whether it's ready, and what fields are missing.
 */
export async function handleCandidateRoute(opts: CandidateRouteOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();

    const candidate = await stateManager.getCandidate(opts.candidateId);
    if (!candidate) {
      console.error(`Candidate not found: ${opts.candidateId}`);
      process.exit(1);
      return; // unreachable in production, needed for test mocks
    }

    const recommendation = resolveCandidateRecommendation(candidate, stateManager, opts.candidateId);

    const decision = decideInternalizationRoute(recommendation as Parameters<typeof decideInternalizationRoute>[0]);

    const result = {
      candidateId: opts.candidateId,
      recommendationKind: recommendation.kind,
      route: decision.route,
      ready: decision.ready,
      missingFields: decision.missingFields,
      reason: decision.reason,
      nextAction: decision.nextAction,
      ...(recommendation.usedFallback && { _meta: { source: 'column_fallback' } }),
    };

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\nCandidate Route: ${result.candidateId}\n`);
      console.log(`  Kind:           ${result.recommendationKind}`);
      console.log(`  Route:          ${result.route}`);
      console.log(`  Ready:          ${result.ready}`);
      console.log(`  Missing Fields: ${result.missingFields.length > 0 ? result.missingFields.join(', ') : '(none)'}`);
      console.log(`  Reason:         ${result.reason}`);
      console.log(`  Next Action:    ${result.nextAction}`);
      if (recommendation.usedFallback) {
        console.log(`  Source:         column_fallback (source_recommendation_json unavailable)`);
      }
      console.log('');
    }
  } finally {
    await stateManager.close();
  }
}
