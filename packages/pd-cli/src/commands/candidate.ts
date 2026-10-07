/**
 * pd candidate commands — Principle candidate inspection, intake, audit, repair, reuse review.
 *
 * Usage:
 *   pd candidate list --task-id <taskId> --workspace <path> [--json]
 *   pd candidate show <candidateId> --workspace <path> [--json]
 *   pd candidate intake --candidate-id <id> [--workspace <path>] [--json] [--dry-run]
 *   pd candidate review --candidate-id <id> [--workspace <path>] [--json]
 *   pd candidate review --candidate-id <id> --decide reuse --principle-id <id> --reason "..." [--json]
 *   pd candidate review --candidate-id <id> --decide create --reason "..." [--json]
 *   pd candidate audit --workspace <path> [--json]
 *   pd candidate repair --candidate-id <id> --workspace <path> [--json]
 *   pd candidate route --candidate-id <id> --workspace <path> [--json]
 */
import { randomUUID } from 'crypto';
import * as path from 'path';
import {
  RuntimeStateManager,
  candidateList,
  candidateShow,
  CandidateIntakeService,
  CandidateIntakeError,
  INTAKE_ERROR_CODES,
  decideInternalizationRoute,
  buildDreamerSeedFromCandidate,
  findExistingDreamerTask,
  parseSeedSourcePainId,
  PrincipleTreeLedgerAdapter,
  // PRI-917 PR3A: the review surface consumes the SAME proposal/semantics
  // machinery as the intake gate (audit C4 — one implementation, no drift).
  buildReuseProposal,
  buildReuseShortlist,
  extractIntakeRecommendation,
  isPrincipleLedgerEligibleKind,
  resolveOwnerIdentity,
  defaultOwnerIdentityHomeDir,
  ReuseEvaluationRunner,
  ReuseEvaluationError,
  createBridgeTelemetryEventEmitter,
  auditCandidateLedgerConsistency,
  type LedgerPrincipleEntry,
  type ReuseDecision,
  type CandidateIntakeResult,
} from '@principles/core/runtime-v2';
import { loadLedger, getLedgerFilePathPublic } from '@principles/core/principle-tree-ledger';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { createWorkspaceTelemetryEmitter } from '../services/workspace-telemetry.js';
import { loadPdConfig } from '../services/pd-config-loader.js';
import { createReuseGatedIntakeService } from '../services/reuse-gated-intake.js';
import { resolveRuntimeAdapterFromConfig } from '../services/runtime-adapter-resolver.js';
import { resolvePromptFullPipelineSeedMode } from '../services/pd-config-loader.js';
import { createRemediationResult, remediationAction } from './remediation-output.js';
import type { RemediationResult } from './remediation-output.js';
import { checkAdmissionGate } from './admission-gate.js';

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
  /** PRI-917 / R7: consumed candidates resolved into an existing principle via reuseEvidence. */
  reusedResolvedCount: number;
  /** Consumed candidates whose recommendation_kind never targets the Principle Ledger. */
  nonLedgerKindCount: number;
  checkedLedgerPath: string;
  checkedDbPath: string;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/** Update candidate status. Sets consumed_at when status='consumed'. */
interface UpdateCandidateStatusOptions {
  stateManager: RuntimeStateManager;
  candidateId: string;
  targetStatus: string;
  expectedCurrentStatus?: string;
}

async function updateCandidateStatus(opts: UpdateCandidateStatusOptions): Promise<void> {
  const { stateManager, candidateId, targetStatus, expectedCurrentStatus } = opts;
  const db = stateManager.connection;
  const now = new Date().toISOString();
  if (targetStatus === 'consumed') {
    const result = db.getDb().prepare(
      'UPDATE principle_candidates SET status = ?, consumed_at = ? WHERE candidate_id = ? AND status = ?'
    ).run(targetStatus, now, candidateId, expectedCurrentStatus ?? targetStatus);
    if (result.changes === 0) {
      throw new Error(`Guarded transition failed: candidate ${candidateId} is not in expected status '${expectedCurrentStatus ?? targetStatus}'`);
    }
  } else {
    const result = db.getDb().prepare(
      'UPDATE principle_candidates SET status = ? WHERE candidate_id = ? AND status = ?'
    ).run(targetStatus, candidateId, expectedCurrentStatus ?? targetStatus);
    if (result.changes === 0) {
      throw new Error(`Guarded transition failed: candidate ${candidateId} is not in expected status '${expectedCurrentStatus ?? targetStatus}'`);
    }
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

/**
 * Resolve `sourcePainId` from the canonical diagnostician task chain.
 *
 * The `CandidateRecord` does not carry `sourcePainId` — it must be resolved by
 * looking up the diagnostician task (`candidate.taskId`) and parsing its
 * `diagnosticJson`, which contains `sourcePainId` as a top-level key (set by
 * `PainSignalBridge.buildDiagnosticJson`).
 *
 * Runtime Contract:
 *   - Rules 1/2/5 (unknown JSON, no `as` bypass, `Object.hasOwn` key checks)
 *     are enforced inside the canonical reader (`parseSeedSourcePainId`)
 *     that this function delegates to since PRI-866
 *
 * ERR-004: `sourcePainId` resolved from canonical chain, never invented.
 *
 * @returns The validated `sourcePainId`, or `null` when it cannot be resolved
 *          (task missing, JSON malformed, field absent, wrong type, or blank).
 *          Callers at the production boundary must fail loud on `null`.
 */
export async function resolveSourcePainIdFromDiagnostician(
  stateManager: RuntimeStateManager,
  candidate: { taskId?: string; sourceRunId?: string },
): Promise<string | null> {
  const candidateTaskId = candidate.taskId?.trim();
  if (!candidateTaskId) return null;

  let diagTask = await stateManager.getTask(candidateTaskId);
  if (!diagTask) return null;

  // Production candidates are emitted by diag_router. Resolve its validated
  // diagnosisId from the exact source run, then verify the referenced task is
  // a diagnostician task before trusting its lineage.
  if (diagTask.taskKind === 'diag_router') {
    const sourceRunId = candidate.sourceRunId?.trim();
    if (!sourceRunId) return null;
    const sourceRun = await stateManager.getRun(sourceRunId);
    if (!sourceRun || sourceRun.taskId !== candidateTaskId || typeof sourceRun.outputPayload !== 'string') return null;
    let routerOutput: unknown;
    try {
      routerOutput = JSON.parse(sourceRun.outputPayload);
    } catch {
      return null;
    }
    if (routerOutput === null || typeof routerOutput !== 'object' || Array.isArray(routerOutput) ||
        !Object.hasOwn(routerOutput, 'diagnosisId')) return null;
    const diagnosisId = Reflect.get(routerOutput, 'diagnosisId');
    if (typeof diagnosisId !== 'string' || diagnosisId.trim() === '') return null;
    diagTask = await stateManager.getTask(diagnosisId.trim());
  }

  // Reject every non-canonical task kind to prevent cross-chain lineage
  // contamination from arbitrary candidate.taskId values.
  if (!diagTask || diagTask.taskKind !== 'diagnostician') return null;

  // PRI-866: field parse delegates to the core canonical reader
  // (parseSeedSourcePainId) — same value semantics as the previous inline
  // parse (trim, blank→null, malformed→null), one source of truth for
  // how sourcePainId is read from diagnosticJson.
  return parseSeedSourcePainId(diagTask.diagnosticJson);
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
  /** Required for degraded/refused/failed statuses — tells the operator what to do next. */
  nextAction?: string;
}

export async function handleCandidateInternalize(opts: CandidateInternalizeOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateManager = new RuntimeStateManager({ workspaceDir });
  // PRI-720: resolve the full-chain override once per invocation (seed-time
  // application; affects only chains this command seeds).
  const seedPipelineMode = resolvePromptFullPipelineSeedMode(workspaceDir);

  try {
    await stateManager.initialize();

    const candidate = await stateManager.getCandidate(opts.candidateId);
    if (!candidate) {
      const result: CandidateInternalizeResult = {
        candidateId: opts.candidateId,
        route: 'unknown',
        status: 'no_task_created',
        reason: `Candidate not found: ${opts.candidateId}`,
        nextAction: 'Verify candidate ID and run pd candidate show <id> to check existence',
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

    // PRI-435: Resolve sourcePainId from the canonical diagnostician task chain.
    // The CandidateRecord does not carry sourcePainId — it must be looked up
    // from the diagnostician task's diagnosticJson via candidate.taskId.
    // Missing/malformed sourcePainId must fail loud with no side effects.
    const sourcePainId = await resolveSourcePainIdFromDiagnostician(stateManager, candidate);
    if (sourcePainId === null) {
      const result: CandidateInternalizeResult = {
        candidateId: opts.candidateId,
        route: decision.route,
        status: 'no_task_created',
        reason: `Cannot resolve sourcePainId from diagnostician task chain for candidate ${opts.candidateId}`,
        nextAction: 'Verify the diagnostician task diagnosticJson contains a valid top-level sourcePainId; re-run diagnosis if the pain signal is missing',
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`Cannot resolve sourcePainId for candidate ${opts.candidateId}`);
        console.error(`Next: ${result.nextAction}`);
      }
      process.exit(1);
      return;
    }

    const seed = buildDreamerSeedFromCandidate(candidate, { route: decision.route, ready: decision.ready, sourcePainId, pipelineMode: seedPipelineMode });
    // eslint-disable-next-line no-restricted-syntax -- 'in' required for discriminated union narrowing (BridgeTaskSeed | BridgeDecision)
    if ('decision' in seed) {
      const decisionResult = seed as { decision: string; reason?: string; taskId?: string };
      const reason = decisionResult.decision === 'already_exists'
        ? `Task ${decisionResult.taskId} already exists`
        : decisionResult.reason ?? 'Seed not created';
      const result: CandidateInternalizeResult = {
        candidateId: opts.candidateId,
        route: decision.route,
        status: 'no_task_created',
        reason,
        nextAction: reason.startsWith('Candidate ')
          ? 'Check candidate lineage fields (taskId, artifactId, sourceRunId)'
          : 'Verify internalization route configuration and candidate readiness',
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\nCandidate Internalize: ${opts.candidateId}\n`);
        console.log(`  Route:   ${decision.route}`);
        console.log(`  Ready:   ${decision.ready}`);
        console.log(`  Reason:  ${reason}`);
        console.log(`  Next:    ${result.nextAction}`);
        console.log('');
      }
      return;
    }

    const { channel } = seed;

    if (opts.dryRun) {
      const result: CandidateInternalizeResult = {
        candidateId: opts.candidateId,
        route: decision.route,
        channel: seed.channel,
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

    // PRI-720 C6: candidate-level dedup (demotion may change the derived
    // channel suffix vs a pre-existing chain).
    const existingTask = await findExistingDreamerTask((id) => stateManager.getTask(id), opts.candidateId);
    if (existingTask) {
      const result: CandidateInternalizeResult = {
        candidateId: opts.candidateId,
        route: decision.route,
        taskId: existingTask.taskId,
        channel: seed.channel,
        status: 'existing',
        reason: 'Task already exists for this candidate (any channel variant)',
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

    const task = await stateManager.createTask({
      taskId: seed.taskId,
      taskKind: seed.taskKind,
      status: seed.status,
      attemptCount: seed.attemptCount,
      maxAttempts: seed.maxAttempts,
      diagnosticJson: seed.diagnosticJson,
    });

    const result: CandidateInternalizeResult = {
      candidateId: opts.candidateId,
      route: decision.route,
      taskId: task.taskId,
      channel: seed.channel,
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
    // F10-1: surface dangling sourceRunId warning in text mode (rc-9).
    if (result.warning) {
      console.log(`  ⚠ WARNING:   ${result.warning}`);
    }
    if (result.nextAction) {
      console.log(`  Next Action: ${result.nextAction}`);
    }
    console.log('');
  } finally {
    await stateManager.close();
  }
}

// ── Intake ───────────────────────────────────────────────────────────────────

// ── Shared intake/decision finalizers (PRI-917 PR3A) ─────────────────────────

/**
 * PRI-917 PR3A (surface audit C2): unify the candidate terminal state after a
 * successful ledger write OR a recorded reuse resolution — always through the
 * guarded {@link updateCandidateStatus} (optimistic pending→consumed +
 * consumed_at), never bypassing the existing mechanism (SPEC §13: the
 * candidate still reaches `consumed`).
 *
 * Returns 'already_consumed' when the candidate was consumed before this call
 * (e.g. an INV-R07 replay). Exits non-zero on a guarded-transition failure —
 * the ledger/LEDGER fact is already durable, so the inconsistency must be
 * loud (same posture as the pre-PR3A intake path).
 */
async function markCandidateConsumed(
  stateManager: RuntimeStateManager,
  candidateId: string,
  ledgerFact: string,
): Promise<'consumed' | 'already_consumed'> {
  const candidate = await stateManager.getCandidate(candidateId);
  if (candidate?.status === 'consumed') {
    return 'already_consumed';
  }
  try {
    await updateCandidateStatus({ stateManager, candidateId, targetStatus: 'consumed', expectedCurrentStatus: 'pending' });
  } catch (err) {
    const msg = `The ledger fact is durable (${ledgerFact}) but the candidate status update failed: ${err instanceof Error ? err.message : String(err)}. ` +
      `Candidate ${candidateId} may be in inconsistent state.`;
    console.error(`ERROR: ${msg}`);
    process.exit(1);
  }
  return 'consumed';
}

/**
 * PRI-917 PR3A (surface audit C1/C2): report a `reuse_selected` intake result
 * as the SUCCESS it is — resolution + selected Principle + evidence, exit 0 —
 * and unify the candidate terminal state (C2). Used by BOTH `pd candidate
 * intake` (replay path) and `pd candidate review --decide reuse` (fresh
 * decision). The CLI prints the durable fact; it does not create one.
 */
async function reportReuseResolution(opts: {
  stateManager: RuntimeStateManager;
  candidateId: string;
  result: Extract<CandidateIntakeResult, { outcome: 'refused' }>;
  json: boolean;
}): Promise<void> {
  const { stateManager, candidateId, result, json } = opts;
  if (!result.selectedPrincipleId || !result.reuseEvidence) {
    // Adapter/service contract violation — never print a hollow resolution.
    throw new CandidateIntakeError(
      INTAKE_ERROR_CODES.INPUT_INVALID,
      `reuse_selected result for candidate ${candidateId} is missing selectedPrincipleId/reuseEvidence (contract violation)`,
      { candidateId, reason: 'reuse_resolution_contract_violation' },
    );
  }
  const consumedState = await markCandidateConsumed(stateManager, candidateId, `reuse evidence on ${result.selectedPrincipleId}`);
  const replayed = result.reuseProposal === undefined;
  const resolution = {
    candidateId,
    status: 'reused',
    selectedPrincipleId: result.selectedPrincipleId,
    reuseEvidence: result.reuseEvidence,
    replayed,
    candidateStatus: consumedState,
    message: result.message,
  };
  if (json) {
    console.log(JSON.stringify(resolution, null, 2));
    return;
  }
  console.log(`\nPrinciple Candidate Reuse: ${candidateId}\n`);
  console.log(`  Candidate:         ${candidateId}`);
  console.log(`  Reused Principle:  ${result.selectedPrincipleId}`);
  console.log(`  Pain:              ${result.reuseEvidence.painId}`);
  console.log(`  Decided By:        ${result.reuseEvidence.actor.kind} ${result.reuseEvidence.actor.id}`);
  console.log(`  Decided At:        ${result.reuseEvidence.decidedAt}`);
  console.log(`  Reason:            ${result.reuseEvidence.reason}`);
  console.log(`  Candidate Status:  ${consumedState === 'already_consumed' ? 'already consumed (INV-R07 replay)' : 'consumed'}`);
  console.log('  Evidence:          recorded on the Principle\'s reuseEvidence (append-only)\n');
}

// ── Shared park reporting (R7 gate-bypass fix, adhoc-20261007) ────────────────

/**
 * Emit the park observation (`reuse_gate_triggered`) on the durable
 * workspace telemetry sink, mirroring the bridge / diagnose / pain-retry
 * paths (PRI-939 Option A). A manual-command park must be observable in the
 * same place the automatic ones are — telemetry is how parked candidates are
 * audited (R7 Wave-2 gate audit).
 */
function emitReuseGateParkedTelemetry(
  workspaceDir: string,
  candidateId: string,
  recommended: { selectedPrincipleId?: string; confidence: number; recommendation: string } | undefined,
): void {
  createBridgeTelemetryEventEmitter(createWorkspaceTelemetryEmitter(workspaceDir)).emitTelemetry({
    eventType: 'reuse_gate_triggered',
    traceId: candidateId,
    timestamp: new Date().toISOString(),
    payload: {
      candidateId,
      ...(recommended?.selectedPrincipleId !== undefined ? { selectedPrincipleId: recommended.selectedPrincipleId } : {}),
      ...(recommended ? { confidence: recommended.confidence, recommendation: recommended.recommendation } : {}),
    },
  });
}

/**
 * Report a `reuse_pending_owner` intake result from the MANUAL paths
 * (`pd candidate intake` / `pd candidate repair`): the gate suspects a
 * semantic duplicate, so nothing was written and the candidate awaits the
 * Owner. Exit code stays 0 — a park is the gate working, not a command
 * failure (same posture as diagnose / pain-retry / the bridge: park is not
 * counted as intake failure). cli-6: the result carries a structured reason
 * and the executable next action (`pd candidate review --decide`).
 */
function reportReusePark(opts: {
  workspaceDir: string;
  candidateId: string;
  result: Extract<CandidateIntakeResult, { outcome: 'refused' }>;
  json: boolean;
  commandLabel: string;
}): void {
  const recommended =
    opts.result.reuseRecommendation?.status === 'recommended' ? opts.result.reuseRecommendation : undefined;
  emitReuseGateParkedTelemetry(opts.workspaceDir, opts.candidateId, recommended);
  const review = {
    candidateId: opts.candidateId,
    status: 'review_required',
    reason: 'reuse_review_required',
    reusedPrincipleId: recommended?.selectedPrincipleId,
    ...(recommended ? { confidence: recommended.confidence } : {}),
    message: opts.result.message,
    nextAction: `pd candidate review --candidate-id ${opts.candidateId} --decide reuse|create --reason "..."`,
  };
  if (opts.json) {
    console.log(JSON.stringify(review, null, 2));
    return;
  }
  console.log(`\nPrinciple Candidate ${opts.commandLabel}: ${opts.candidateId} — reuse review required\n`);
  console.log(`  Candidate:         ${opts.candidateId}`);
  if (recommended?.selectedPrincipleId !== undefined) {
    console.log(`  Suspected Duplicate Of: ${recommended.selectedPrincipleId} (confidence ${recommended.confidence})`);
  }
  console.log(`  Status:            review_required (no Principle was created)`);
  console.log(`  Message:           ${review.message}`);
  console.log(`  Next Action:       ${review.nextAction}\n`);
}

/**
 * PRI-917 v0.3.2 (Phase 3C-4): run the Semantic Reuse Evaluation Capability
 * against the lexical proposal and return a DISPLAY object.
 *
 * Display-only by construction:
 *   - the result is rendered for the Owner; nothing here persists, and the
 *     runner itself has no ledger path (Phase 3C-3);
 *   - the recommendation NEVER flows into an automatic decision — the Owner's
 *     `--decide` verdict is the only thing that reaches intake (T4);
 *   - any failure (capability disabled, profile unconfigured, LLM timeout,
 *     contract violation) degrades OBSERVABLY to `status: 'unavailable'`
 *     with the reason (SPEC §9) — the lexical proposal still shows, and the
 *     Owner can still decide (T5).
 *
 * Returns null when the capability is disabled in config (silent by design —
 * `pd config doctor` is the place that advertises the capability; a disabled
 * advisory stage should not add review noise).
 */
type ReuseEvaluationDisplay =
  | { status: 'recommended'; recommendation: 'reuse' | 'create' | 'uncertain'; selectedPrincipleId?: string; rationale: string; confidence: number }
  | { status: 'unavailable'; reason: string };

async function evaluateReuseProposal(
  workspaceDir: string,
  claim: { text: string; triggerPattern: string; action: string },
  entries: readonly {
    principleId: string;
    existingPrinciple: { text: string; triggerPattern: string; action: string; status: string };
  }[],
): Promise<ReuseEvaluationDisplay | null> {
  const configLoad = loadPdConfig(workspaceDir);
  const effective = configLoad.ok ? configLoad.effective : configLoad.defaults;
  const capability = effective.config.reuseEvaluation;
  if (!capability?.enabled) {
    return null;
  }
  if (entries.length === 0) {
    // Case A (SPEC §6): nothing credible was found — there is nothing to
    // evaluate, and intake proceeds to create without an Owner decision.
    return null;
  }

  // PRI-917 review (P2): timeout precedence — capability.timeoutMs wins,
  // otherwise the resolved PROFILE's own timeout (its documented default),
  // otherwise the runner's built-in default.
    const capabilityProfile = effective.config.runtimeProfiles[capability.runtimeProfile ?? ''];
  const profileTimeoutMs = capabilityProfile?.type === 'pi-ai' ? capabilityProfile.timeoutMs : undefined;
  try {
    const adapter = resolveRuntimeAdapterFromConfig({
      runtimeKind: 'config',
      workspaceDir,
      runtimeProfileId: capability.runtimeProfile,
    });
    const runner = new ReuseEvaluationRunner(
      { runtimeAdapter: adapter },
      { ...(capability.timeoutMs !== undefined ? { timeoutMs: capability.timeoutMs } : { ...(profileTimeoutMs !== undefined ? { timeoutMs: profileTimeoutMs } : {}) }) },
    );
    const output = await runner.recommend({
      candidate: claim,
      candidates: entries.map((entry) => ({
        principleId: entry.principleId,
        text: entry.existingPrinciple.text,
        triggerPattern: entry.existingPrinciple.triggerPattern,
        action: entry.existingPrinciple.action,
      })),
    });
    // PRI-917 review (P2): the validator deliberately does NOT check id
    // existence (INV-R08 lives one layer up, against the REAL shortlist).
    // This is that layer: a hallucinated/foreign id must not reach the Owner
    // as an executable-looking recommendation.
    if (output.recommendation === 'reuse') {
      const inShortlist = entries.some((entry) => entry.principleId === output.selectedPrincipleId);
      if (!inShortlist) {
        return {
          status: 'unavailable',
          reason: `selected_principle_not_in_shortlist:${output.selectedPrincipleId ?? '(absent)'}`,
        };
      }
    }
    return {
      status: 'recommended',
      recommendation: output.recommendation,
      ...(output.selectedPrincipleId !== undefined ? { selectedPrincipleId: output.selectedPrincipleId } : {}),
      rationale: output.rationale,
      confidence: output.confidence,
    };
  } catch (err: unknown) {
    const reason = err instanceof ReuseEvaluationError
      ? `${err.reason}: ${err.detail ?? err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
    return { status: 'unavailable', reason };
  }
}

/**
 * Decision mode of {@link handleCandidateReview}: validate the CLI contract
 * (rc-3), resolve the Owner identity (fail-closed), then run the EXISTING
 * intake chain with the §11 verdict injected. No CLI-side persistence.
 */
async function executeOwnerDecision(deps: {
  opts: CandidateReviewOptions & { decide: 'reuse' | 'create' };
  stateManager: RuntimeStateManager;
  ledgerAdapter: PrincipleTreeLedgerAdapter;
  stateDir: string;
}): Promise<void> {
  const { opts, stateManager, ledgerAdapter, stateDir } = deps;
  const failCli = (message: string, nextAction: string): never => {
    if (opts.json) {
      console.log(JSON.stringify({ candidateId: opts.candidateId, status: 'refused', decision: opts.decide, error: message, nextAction }, null, 2));
    } else {
      console.error(`ERROR: ${message}`);
      console.error(`  Next Action: ${nextAction}`);
    }
    process.exit(1);
  };

  if (typeof opts.reason !== 'string' || opts.reason.trim() === '') {
    failCli('--reason is required with --decide (the evidence entry must record why the Owner resolved this candidate)', 'Re-run with --reason "..." (non-empty).');
  }
  if (opts.decide === 'reuse' && (typeof opts.principleId !== 'string' || opts.principleId.trim() === '')) {
    failCli('--principle-id is required with --decide reuse', 'Re-run with --principle-id <id from the review proposal>.');
  }

  // Owner identity: env > ~/.pd/owner.json > none (ADR-0022 resolver).
  const identity = resolveOwnerIdentity(process.env, defaultOwnerIdentityHomeDir());
  if ((identity.source !== 'env' && identity.source !== 'file') || !identity.ownerId) {
    failCli(
      `Owner identity is required to record a ${opts.decide} decision (identity source: ${identity.source})${identity.error ? `: ${identity.error}` : ''}`,
      'Register the Owner identity file (~/.pd/owner.json) or set PD_OWNER_ID and PD_OWNER_CREDENTIAL_ID together, then retry.',
    );
  }

  const decision: ReuseDecision = opts.decide === 'reuse'
    ? {
        decision: 'reuse',
        selectedPrincipleId: opts.principleId as string,
        actor: { kind: 'owner', id: identity.ownerId as string },
        reason: opts.reason as string,
        decidedAt: new Date().toISOString(),
      }
    : { decision: 'create' };

  // INV-R08: verify the selected principle is in the current proposal.
  // This prevents a stale or empty proposal from silently degrading reuse
  // into create.
  if (opts.decide === 'reuse') {
    const candidate = await stateManager.getCandidate(opts.candidateId);
    const artifact = candidate ? await stateManager.getArtifact(candidate.artifactId) : null;
    const extracted = candidate ? extractIntakeRecommendation(candidate, artifact) : null;
    if (!candidate || !extracted || !extracted.ok) {
      failCli('Cannot build the reuse proposal for this candidate', 'Run `pd candidate review --candidate-id <id>` first.');
      return;
    }
    const proposal = buildReuseProposal(opts.candidateId, buildReuseShortlist({
      text: extracted.recommendation.text || candidate.description || '',
      triggerPattern: extracted.recommendation.triggerPattern ?? '',
      action: extracted.recommendation.action ?? '',
    }, stateDir, { recommendationKind: candidate.rawRecommendationKind }));
    if (!proposal.candidates.some((c) => c.principleId === opts.principleId)) {
      failCli(`Principle ${opts.principleId} is not in the current reuse proposal`, 'Re-run `pd candidate review` to see the current proposal.');
    }
  }

  const service = new CandidateIntakeService({
    stateManager,
    ledgerAdapter,
    // The verdict is fixed by the CLI invocation; the intake gate still
    // validates it (rc-1/rc-2/rc-3) and checks the selection against the
    // proposal (INV-R08) — the CLI cannot smuggle a decision past the gate.
    reuseDecision: () => decision,
    reuseStateDir: stateDir,
  });

  const intakeResult = await service.intake(opts.candidateId);

  if (intakeResult.outcome === 'refused' && intakeResult.reason === 'reuse_selected') {
    await reportReuseResolution({ stateManager, candidateId: opts.candidateId, result: intakeResult, json: opts.json === true });
    return;
  }
  if (intakeResult.outcome === 'refused') {
    // A non-principle kind or unknown kind cannot carry a reuse decision.
    throw new CandidateIntakeError(
      INTAKE_ERROR_CODES.INPUT_INVALID,
      `Principle Ledger write refused: ${intakeResult.message}`,
      { candidateId: opts.candidateId, reason: intakeResult.reason },
    );
  }

  // create verdict (or gate absent shapes) — same durable outcome as intake.
  const { entry } = intakeResult;
  const consumedState = await markCandidateConsumed(stateManager, opts.candidateId, entry.id);
  if (consumedState === 'already_consumed') {
    // Consumed before this call — the ledger entry is identical by intake
    // idempotency; report it like `pd candidate intake` does.
    const infoMessage = `Candidate ${opts.candidateId} was already consumed. Ledger entry: ${entry.id}`;
    if (opts.json) {
      console.log(JSON.stringify({ candidateId: opts.candidateId, ledgerEntryId: entry.id, status: 'already_consumed', message: infoMessage }, null, 2));
    } else {
      console.log(infoMessage);
    }
    return;
  }
  const result = {
    candidateId: opts.candidateId,
    decision: opts.decide,
    ledgerEntryId: entry.id,
    status: 'consumed' as const,
  };
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`\nPrinciple Candidate Decision: ${opts.candidateId}\n`);
  console.log(`  Decision:     ${opts.decide}`);
  console.log(`  Candidate:    ${opts.candidateId}`);
  console.log(`  Ledger Entry: ${entry.id}`);
  console.log(`  Status:       consumed\n`);
  console.log('Decision complete.\n');
}

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
    // R7 gate-bypass fix (adhoc-20261007): construct through the shared gated
    // assembly so the manual intake path runs the Reuse Review Gate exactly
    // like diagnose / pain-retry / the bridge. A bare construction left
    // reuseCheck='not_configured' and let semantic duplicates go straight to
    // CREATE (R7 Wave-2 audit D-1, P0).
    const service = createReuseGatedIntakeService({ stateManager, ledgerAdapter, workspaceDir });

    // Fetch candidate once for admission gate check and downstream paths.
    const candidate = await stateManager.getCandidate(opts.candidateId);
    if (!candidate) {
      console.error(`Candidate not found: ${opts.candidateId}`);
      process.exit(1);
      return;
    }

    // PRI-442 Stage 4: admission gate check — refuse non-admitted candidates
    // to prevent CLI from bypassing the production admission gate.
    const admissionBlock = checkAdmissionGate(candidate);
    if (admissionBlock) {
      const result = {
        candidateId: opts.candidateId,
        status: 'refused',
        admissionDecision: admissionBlock.decision,
        reason: admissionBlock.reason,
        nextAction: admissionBlock.nextAction,
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`Admission gate refused candidate ${opts.candidateId}: ${admissionBlock.decision}`);
        console.error(`  Reason:      ${admissionBlock.reason}`);
        console.error(`  Next Action: ${admissionBlock.nextAction}`);
      }
      process.exit(1);
      return;
    }

    if (opts.dryRun) {
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

    // Normal intake: ledger write first.
    // Phase 1 / PR1: the manual intake command operates on an EXPLICIT
    // candidate id, so a Principle Ledger write boundary refusal is surfaced
    // loudly (never silently swallowed) instead of being treated as success.
    const intakeResult = await service.intake(opts.candidateId);
    if (intakeResult.outcome === 'refused' && intakeResult.reason === 'reuse_selected') {
      // PRI-917 PR3A (surface audit C1/C2): a recorded reuse resolution is a
      // SUCCESS, not a failure — the evidence is already durable on the
      // selected Principle (fresh decision) or was recorded earlier (INV-R07
      // replay via intake step 2b, which is how this branch is reachable from
      // the gate-less intake command). Report the resolution, unify the
      // candidate terminal state with the automatic paths (SPEC §13), exit 0.
      await reportReuseResolution({ stateManager, candidateId: opts.candidateId, result: intakeResult, json: opts.json === true });
      return;
    }
    if (intakeResult.outcome === 'refused' && intakeResult.reason === 'reuse_pending_owner') {
      // R7 gate-bypass fix: the Reuse Review Gate parked this candidate as a
      // suspected duplicate. No ledger entry was written and the candidate
      // stays pending for the Owner — do NOT mark it consumed. cli-5: this
      // path performs no state mutation at all.
      reportReusePark({
        workspaceDir,
        candidateId: opts.candidateId,
        result: intakeResult,
        json: opts.json === true,
        commandLabel: 'Intake',
      });
      return;
    }
    if (intakeResult.outcome === 'refused') {
      throw new CandidateIntakeError(
        INTAKE_ERROR_CODES.INPUT_INVALID,
        `Principle Ledger write refused: ${intakeResult.message}`,
        { candidateId: opts.candidateId, reason: intakeResult.reason },
      );
    }
    const { entry } = intakeResult;
    const consumedState = await markCandidateConsumed(stateManager, opts.candidateId, entry.id);

    if (consumedState === 'already_consumed') {
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

// ── Review (PRI-917 PR3A — the Owner reuse decision surface) ──────────────────

interface CandidateReviewOptions {
  candidateId: string;
  workspace?: string;
  json?: boolean;
  /** Omit for the read-only proposal view; `reuse`/`create` enter decision mode. */
  decide?: 'reuse' | 'create';
  /** Required with `--decide reuse`. */
  principleId?: string;
  /** Required with `--decide` (rc-3): why the Owner resolved this candidate. */
  reason?: string;
}

/**
 * pd candidate review — PRI-917 PR3A Owner decision surface (SPEC §18).
 *
 * Phase 1 (read-only): shows the candidate and the deterministic Top-K reuse
 * proposal (score, reasons/shared terms, and the existing Principle's text /
 * triggerPattern / action / status) so the Owner can decide with the same
 * information the gate will consume.
 *
 * Phase 2 (`--decide`): constructs the SPEC §11 verdict (actor from
 * resolveOwnerIdentity — fail-closed when unresolvable) and injects it into
 * CandidateIntakeService, which runs the EXISTING gate → appendReuseEvidence
 * chain. The CLI is an interaction layer only: it never writes reuseEvidence,
 * decision files, or any other state (SPEC §18 — the only durable authority
 * is `Principle.reuseEvidence[]`).
 */
export async function handleCandidateReview(opts: CandidateReviewOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();

    const stateDir = path.join(workspaceDir, '.state');
    const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir });
    const candidate = await stateManager.getCandidate(opts.candidateId);
    if (!candidate) {
      console.error(`Candidate not found: ${opts.candidateId}`);
      process.exit(1);
      return;
    }

    if (opts.decide === 'reuse' || opts.decide === 'create') {
      // PRI-442 Stage 4: admission gate check — same as handleCandidateIntake.
      // Prevents CLI from bypassing the production admission gate.
      //
      // PRI-917 v0.3.3 (R5 F4 two-heads-block fix): the pre-check does NOT
      // apply to a `reuse` verdict. Admission confidence protects the LEDGER
      // from low-quality NEW principles; a reuse decision creates nothing — it
      // appends one auditable evidence entry to an EXISTING principle whose
      // recurrence is itself the proof of value. Blocking it here left every
      // low-confidence historical candidate permanently undecidable while the
      // auto path consumed high-confidence ones before any Owner could ask.
      // `create` keeps the pre-check: a low-confidence candidate still cannot
      // become a new Principle via the CLI.
      if (opts.decide === 'create') {
        const admissionBlock = checkAdmissionGate(candidate);
        if (admissionBlock) {
          const payload = {
            candidateId: opts.candidateId,
            status: 'refused',
            admissionDecision: admissionBlock.decision,
            reason: admissionBlock.reason,
            nextAction: admissionBlock.nextAction,
          };
          if (opts.json) {
            console.log(JSON.stringify(payload, null, 2));
          } else {
            console.error(`Admission gate refused candidate ${opts.candidateId}: ${admissionBlock.decision}`);
            console.error(`  Reason:      ${admissionBlock.reason}`);
            console.error(`  Next Action: ${admissionBlock.nextAction}`);
          }
          process.exit(1);
          return;
        }
      }
      // opts.decide is narrowed here — no cast needed to build the decision-mode shape.
      await executeOwnerDecision({ opts: { ...opts, decide: opts.decide }, stateManager, ledgerAdapter, stateDir });
      return;
    }

    // ── Read-only proposal view ──
    const rawKindEligible = isPrincipleLedgerEligibleKind(candidate.rawRecommendationKind);
    if (!rawKindEligible) {
      // Fail closed like the intake boundary: a non-principle candidate never
      // reaches the reuse gate, so reviewing a proposal for it would lie.
      const rawKind = typeof candidate.rawRecommendationKind === 'string' ? candidate.rawRecommendationKind : null;
      const payload = {
        candidateId: opts.candidateId,
        recommendationKindEligible: false,
        rawRecommendationKind: rawKind,
        message: `Candidate ${opts.candidateId} has recommendation_kind '${rawKind ?? 'absent'}' which does not target the Principle Ledger; there is no reuse proposal to review.`,
        nextAction: 'Run `pd candidate route --candidate-id <id>` for this candidate\'s internalization route instead.',
      };
      if (opts.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(`\nPrinciple Candidate Review: ${opts.candidateId}\n`);
      console.log(`  Kind:         ${rawKind ?? 'absent'} (not Principle-Ledger eligible)`);
      console.log(`  ${payload.message}`);
      console.log(`  Next Action:  ${payload.nextAction}\n`);
      return;
    }

    const artifact = await stateManager.getArtifact(candidate.artifactId);
    if (!artifact) {
      console.error(`Artifact not found for candidate: ${opts.candidateId} (artifact ${candidate.artifactId})`);
      process.exit(1);
      return;
    }
    // C4: the SAME extraction intake uses (4b/4c) — never a second parser.
    const extracted = extractIntakeRecommendation(candidate, artifact);
    if (!extracted.ok) {
      throw extracted.error;
    }
    const { recommendation } = extracted;

    const shortlist = buildReuseShortlist(
      {
        text: recommendation.text || candidate.description || '',
        triggerPattern: recommendation.triggerPattern ?? '',
        action: recommendation.action ?? '',
      },
      stateDir,
      { recommendationKind: candidate.rawRecommendationKind },
    );
    const proposal = buildReuseProposal(opts.candidateId, shortlist);

    // Enrich each entry with the existing Principle's durable content.
    const ledger = loadLedger(stateDir);
    const entries = proposal.candidates.map((entry) => {
      const principle = ledger.tree.principles[entry.principleId];
      return {
        principleId: entry.principleId,
        score: entry.score,
        reasons: entry.reasons,
        existingPrinciple: principle
          ? { text: principle.text, triggerPattern: principle.triggerPattern, action: principle.action, status: principle.status }
          : { text: '', triggerPattern: '', action: '', status: 'missing' },
      };
    });

    // PRI-917 v0.3.2 (Phase 3C-4): run the Semantic Reuse Evaluation
    // Capability as a DISPLAY enhancement on the read-only review path. Its
    // output is a RECOMMENDATION for the Owner — it never decides, never
    // writes, and its failure degrades observably to lexical-only (SPEC §9).
    const evaluation = await evaluateReuseProposal(workspaceDir, {
      text: recommendation.text || candidate.description || '',
      triggerPattern: recommendation.triggerPattern ?? '',
      action: recommendation.action ?? '',
    }, entries);

    // PRI-917 v0.3.2 §11: the events are OBSERVATION ONLY. They record what
    // the capability recommended; they are never decision storage (the
    // Owner's verdict lives exclusively in Principle.reuseEvidence[]) and
    // no intake outcome reads them. Emitted only when the capability
    // actually ran (disabled or nothing-to-evaluate emits nothing).
    // PRI-939 Option A: persist allowlisted events (reuse_evaluation_unavailable)
    // to the workspace sink instead of the unsubscribed singleton.
    const workspaceTelemetry = createWorkspaceTelemetryEmitter(workspaceDir);
    if (evaluation !== null) {
      const timestamp = new Date().toISOString();
      if (evaluation.status === 'recommended') {
        workspaceTelemetry.emitTelemetry({
          eventType: 'reuse_evaluation_recommended',
          traceId: opts.candidateId,
          timestamp,
          sessionId: 'pd-cli-review',
          agentId: 'reuse-evaluation',
          payload: {
            candidateId: opts.candidateId,
            recommendation: evaluation.recommendation,
            ...(evaluation.selectedPrincipleId !== undefined ? { selectedPrincipleId: evaluation.selectedPrincipleId } : {}),
            confidence: evaluation.confidence,
          },
        });
      } else {
        workspaceTelemetry.emitTelemetry({
          eventType: 'reuse_evaluation_unavailable',
          traceId: opts.candidateId,
          timestamp,
          sessionId: 'pd-cli-review',
          agentId: 'reuse-evaluation',
          payload: {
            candidateId: opts.candidateId,
            reason: evaluation.reason.slice(0, 200),
          },
        });
      }
    }

    const nextAction = entries.length > 0
      ? `pd candidate review --candidate-id ${opts.candidateId} --decide reuse --principle-id <id> --reason "..." (or --decide create --reason "...")`
      : `No credible reuse proposal — intake will create a new Principle: pd candidate intake --candidate-id ${opts.candidateId} --workspace "${workspaceDir}"`;

    if (opts.json) {
      console.log(JSON.stringify({
        candidateId: opts.candidateId,
        title: candidate.title,
        description: candidate.description,
        status: candidate.status,
        taskId: candidate.taskId,
        recommendationKindEligible: true,
        claim: { text: recommendation.text || candidate.description || '', triggerPattern: recommendation.triggerPattern ?? '', action: recommendation.action ?? '' },
        proposal: {
          status: proposal.status,
          eligibleCount: proposal.eligibleCount,
          candidates: entries.map((entry) => ({
            ...entry,
            semanticMatch: evaluation?.status === 'recommended'
              && evaluation.recommendation === 'reuse'
              && evaluation.selectedPrincipleId === entry.principleId,
          })),
        },
        ...(evaluation ? { evaluation } : {}),
        nextAction,
      }, null, 2));
      return;
    }

    console.log(`\nPrinciple Candidate Review: ${opts.candidateId}\n`);
    console.log(`  Title:        ${candidate.title}`);
    console.log(`  Description:  ${candidate.description}`);
    console.log(`  Status:       ${candidate.status}`);
    console.log(`  Task:         ${candidate.taskId}`);
    console.log(`  Claim:        ${recommendation.text || candidate.description || ''}`);
    console.log(`  Trigger:      ${recommendation.triggerPattern ?? ''}`);
    console.log(`  Action:       ${recommendation.action ?? ''}`);
    console.log(`\n  Reuse Proposal (${entries.length} of ${proposal.eligibleCount} eligible, Top-3):\n`);
    if (entries.length === 0) {
      console.log('    No credible existing Principle found — the intake gate will create a new one.\n');
    }
    entries.forEach((entry, index) => {
      console.log(`    ${index + 1}. ${entry.principleId}  (score ${entry.score.toFixed(3)})`);
      for (const reason of entry.reasons) {
        console.log(`       reason: ${reason}`);
      }
      console.log(`       text:    ${entry.existingPrinciple.text}`);
      console.log(`       trigger: ${entry.existingPrinciple.triggerPattern}`);
      console.log(`       action:  ${entry.existingPrinciple.action}`);
      console.log(`       status:  ${entry.existingPrinciple.status}`);
    });
    console.log('');
    if (evaluation === null) {
      // Capability disabled (or nothing to evaluate): lexical-only review,
      // exactly the pre-3C-4 output.
    } else if (evaluation.status === 'recommended') {
      console.log('  Semantic evaluation (advisory — the Owner decides):');
      console.log(`    recommendation: ${evaluation.recommendation}`);
      if (evaluation.selectedPrincipleId) {
        console.log(`    principle:      ${evaluation.selectedPrincipleId}`);
      }
      console.log(`    rationale:      ${evaluation.rationale}`);
      console.log(`    confidence:     ${evaluation.confidence}`);
    } else {
      console.log('  Semantic evaluation: UNAVAILABLE (lexical proposal only — not semantically judged)');
      console.log(`    reason: ${evaluation.reason}`);
    }
    console.log(`\n  Next Action:  ${nextAction}\n`);
  } catch (err) {
    if (err instanceof CandidateIntakeError || (err as { name?: string }).name === 'CandidateIntakeError') {
      const e = err as { code?: string; message: string };
      console.error(`Review failed [${e.code ?? 'unknown'}]: ${e.message}`);
    } else {
      console.error(`Review failed: ${String(err)}`);
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
 * Delegates the judgment to the core auditCandidateLedgerConsistency so every
 * surface (pd candidate audit, pd health, operator health) applies the SAME
 * reuse-aware rules (PRI-917 / R7): reuse resolutions and non-Principle-Ledger
 * kinds are not "missing"; only a consumed principle-kind candidate with no
 * resolution anywhere is true drift.
 * Exits non-zero if any consumed candidate is truly missing from the ledger.
 */
export async function handleCandidateAudit(opts: CandidateAuditOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);

  try {
    const dbPath = path.join(workspaceDir, '.pd', 'state.db');
    const ledgerStateDir = path.join(workspaceDir, '.state');
    const ledgerPath = getLedgerFilePathPublic(ledgerStateDir);

    const audit = await auditCandidateLedgerConsistency(workspaceDir);

    if (audit.status === 'error') {
      console.error(`Audit failed: ${audit.reason ?? 'could not read candidate/ledger state'}`);
      console.error('Next action: open this workspace once with the PD runtime to create/migrate state.db, then retry the audit.');
      process.exit(1);
      return;
    }

    const result: AuditResult = {
      status: audit.status,
      consumedCount: audit.consumedCount,
      missingLedgerEntryIds: audit.missingLedgerEntryIds ?? [],
      reusedResolvedCount: audit.reusedResolvedCount ?? 0,
      nonLedgerKindCount: audit.nonLedgerKindCount ?? 0,
      checkedLedgerPath: ledgerPath,
      checkedDbPath: dbPath,
    };

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\nCandidate Audit Results\n`);
      console.log(`  consumedCount: ${result.consumedCount}`);
      console.log(`  reusedResolvedCount: ${result.reusedResolvedCount}`);
      console.log(`  nonLedgerKindCount: ${result.nonLedgerKindCount}`);
      console.log(`  checkedLedgerPath: ${result.checkedLedgerPath}`);
      console.log(`  checkedDbPath: ${result.checkedDbPath}`);
      console.log(`  status: ${result.status}`);
      if (result.missingLedgerEntryIds.length > 0) {
        console.log(`\n  MISSING LEDGER ENTRIES (${result.missingLedgerEntryIds.length}):`);
        result.missingLedgerEntryIds.forEach(id => console.log(`    - ${id}`));
      } else {
        console.log(`\n  All consumed candidates have ledger resolutions.`);
      }
      console.log('');
    }

    if (result.status === 'degraded') {
      process.exit(1);
    }
  } catch (err) {
    console.error(`Audit failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
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

    // PRI-442 Stage 4: admission gate check — even for consumed candidates,
    // re-verify admission before re-intaking to prevent bypassing the gate.
    // A consumed candidate that would fail the gate indicates data corruption
    // or a prior bypass; refuse and surface the reason.
    const admissionBlock = checkAdmissionGate(candidate);
    if (admissionBlock) {
      const result = {
        candidateId: opts.candidateId,
        status: 'refused',
        admissionDecision: admissionBlock.decision,
        reason: admissionBlock.reason,
        nextAction: admissionBlock.nextAction,
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`Admission gate refused candidate ${opts.candidateId}: ${admissionBlock.decision}`);
        console.error(`  Reason:      ${admissionBlock.reason}`);
        console.error(`  Next Action: ${admissionBlock.nextAction}`);
      }
      process.exit(1);
      return;
    }

    const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir: path.join(workspaceDir, '.state') });
    // R7 gate-bypass fix (adhoc-20261007): repair re-intakes through the same
    // gated assembly — otherwise "restore the missing ledger entry" became an
    // unconditional duplicate-CREATE for orphaned cleanup candidates (R7
    // Wave-2 audit D-1 §3.3).
    const service = createReuseGatedIntakeService({ stateManager, ledgerAdapter, workspaceDir });

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

    // Re-intake to restore ledger entry.
    // Phase 1 / PR1: repair exists solely to restore a missing ledger entry, so
    // a write-boundary refusal means the candidate is not principle-eligible —
    // fail loud rather than reporting a "repaired" entry that does not exist.
    const intakeResult = await service.intake(opts.candidateId);
    if (intakeResult.outcome === 'refused' && intakeResult.reason === 'reuse_pending_owner') {
      // R7 gate-bypass fix: the gate suspects a semantic duplicate — restoring
      // the entry would recreate a near-duplicate Principle. No write happened;
      // the Owner resolves it via the review channel. cli-5: no mutation on
      // this path (candidate stays consumed, ledger untouched).
      reportReusePark({
        workspaceDir,
        candidateId: opts.candidateId,
        result: intakeResult,
        json: opts.json === true,
        commandLabel: 'Repair',
      });
      return;
    }
    if (intakeResult.outcome === 'refused') {
      throw new CandidateIntakeError(
        INTAKE_ERROR_CODES.INPUT_INVALID,
        `Ledger repair refused: ${intakeResult.message}`,
        { candidateId: opts.candidateId, reason: intakeResult.reason },
      );
    }
    const { entry } = intakeResult;
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
  includePending?: boolean;
}

interface BackfillCandidateResult {
  candidateId: string;
  route: string;
  status: 'would_create' | 'created' | 'existing' | 'deferred' | 'error' | 'would_intake_and_create' | 'intake_failed' | 'intake_succeeded_existing_task';
  taskId?: string;
  channel?: string;
  reason?: string;
  statusBefore?: string;
  statusAfter?: string;
  intakeDecision?: 'would_intake' | 'intake_succeeded' | 'intake_failed' | 'skipped' | 'not_needed';
  seedDecision?: 'would_seed' | 'seeded' | 'existing' | 'skipped' | 'not_needed';
  nextAction?: string;
}

interface BackfillOutput {
  mode: 'dry-run' | 'confirm';
  totalConsumed: number;
  totalPending: number;
  missingDreamerTask: number;
  alreadyHaveTask: number;
  deferred: number;
  created: number;
  intakeSucceeded: number;
  intakeFailed: number;
  errors: number;
  results: BackfillCandidateResult[];
}

function createBackfillRemediationResult(output: BackfillOutput): RemediationResult {
  const actions = output.results
    .filter((result) => result.status === 'would_create' || result.status === 'created' || result.status === 'would_intake_and_create' || result.status === 'intake_failed' || result.status === 'intake_succeeded_existing_task')
    .map((result) => {
      if (result.status === 'would_intake_and_create') {
        return remediationAction({
          action: 'would_intake_and_create_dreamer_task',
          targetId: result.candidateId,
          previousState: 'pending_candidate_without_dreamer',
          nextState: 'dreamer_task_would_be_created',
          reason: result.reason ?? `Backfill would intake pending candidate and create dreamer task${result.taskId ? ` ${result.taskId}` : ''}`,
        });
      }
      if (result.status === 'intake_failed') {
        return remediationAction({
          action: 'intake_failed',
          targetId: result.candidateId,
          previousState: 'pending_candidate',
          nextState: 'pending_candidate_intake_failed',
          reason: result.reason ?? `Backfill intake failed for pending candidate`,
        });
      }
      if (result.status === 'intake_succeeded_existing_task') {
        return remediationAction({
          action: 'intake_succeeded_existing_task',
          targetId: result.candidateId,
          previousState: 'pending_candidate',
          nextState: 'consumed_candidate_with_existing_dreamer',
          reason: result.reason ?? `Backfill intake succeeded but dreamer task already exists`,
        });
      }
      return remediationAction({
        action: result.status === 'created' ? 'create_dreamer_task' : 'would_create_dreamer_task',
        targetId: result.candidateId,
        previousState: 'consumed_candidate_without_dreamer',
        nextState: result.status === 'created' ? 'dreamer_task_created' : 'dreamer_task_would_be_created',
        reason: result.reason ?? `Backfill ${result.status === 'created' ? 'created' : 'would create'} dreamer task${result.taskId ? ` ${result.taskId}` : ''}`,
      });
    });

  return createRemediationResult({
    mode: output.mode === 'confirm' ? 'confirm' : 'dry_run',
    repairedCount: output.created,
    skippedCount: output.alreadyHaveTask + output.deferred + output.errors + output.intakeFailed,
    actions,
    warnings: output.errors > 0 ? [`${output.errors} candidate(s) could not be backfilled.`] : (output.intakeFailed > 0 ? [`${output.intakeFailed} pending candidate(s) intake failed.`] : []),
    status: (output.errors > 0 || output.intakeFailed > 0) && output.created === 0 ? 'error' : undefined,
    safeToConfirm: output.mode === 'dry-run' && (output.missingDreamerTask > 0 || output.totalPending > 0) && output.errors === 0,
  });
}

export async function handleCandidateInternalizationBackfill(opts: CandidateBackfillOptions): Promise<void> {
  if (opts.dryRun && opts.confirm) {
    console.error('Error: --dry-run and --confirm are mutually exclusive');
    process.exit(1);
    return;
  }

  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const isConfirm = opts.confirm ?? false;
  const stateManager = new RuntimeStateManager({ workspaceDir, readonly: !isConfirm });
  // PRI-720: resolve the full-chain override once per invocation.
  const seedPipelineMode = resolvePromptFullPipelineSeedMode(workspaceDir);

  try {
    await stateManager.initialize();

    const db = stateManager.connection.getDb();

    const consumedRows = db.prepare(
      "SELECT candidate_id FROM principle_candidates WHERE status = 'consumed'"
    ).all() as { candidate_id: string }[];

    let pendingRows: { candidate_id: string }[] = [];
    if (opts.includePending) {
      pendingRows = db.prepare(
        "SELECT candidate_id FROM principle_candidates WHERE status = 'pending'"
      ).all() as { candidate_id: string }[];
    }

    const output: BackfillOutput = {
      mode: isConfirm ? 'confirm' : 'dry-run',
      totalConsumed: consumedRows.length,
      totalPending: pendingRows.length,
      missingDreamerTask: 0,
      alreadyHaveTask: 0,
      deferred: 0,
      created: 0,
      intakeSucceeded: 0,
      intakeFailed: 0,
      errors: 0,
      results: [],
    };

    for (const row of consumedRows) {
      const candidateId = row.candidate_id;

      const candidate = await stateManager.getCandidate(candidateId);
      if (!candidate) {
        output.errors++;
        output.results.push({ candidateId, route: 'unknown', status: 'error', reason: 'Candidate not found in DB', statusBefore: 'consumed', statusAfter: 'consumed', intakeDecision: 'not_needed', seedDecision: 'skipped', nextAction: 'Investigate why consumed candidate is missing from DB' });
        continue;
      }

      const recommendation = resolveCandidateRecommendation(candidate, stateManager, candidateId);
      const decision = decideInternalizationRoute(recommendation as Parameters<typeof decideInternalizationRoute>[0]);

      // PRI-435: Resolve sourcePainId from the canonical diagnostician task chain.
      // Missing/malformed sourcePainId must fail loud per-candidate with no side effects.
      const sourcePainId = await resolveSourcePainIdFromDiagnostician(stateManager, candidate);
      if (sourcePainId === null) {
        output.errors++;
        output.results.push({ candidateId, route: decision.route, status: 'error', reason: `Cannot resolve sourcePainId from diagnostician task chain for candidate ${candidateId}`, statusBefore: 'consumed', statusAfter: 'consumed', intakeDecision: 'not_needed', seedDecision: 'skipped', nextAction: 'Verify the diagnostician task diagnosticJson contains a valid top-level sourcePainId; re-run diagnosis if the pain signal is missing' });
        continue;
      }
      const seed = buildDreamerSeedFromCandidate(candidate, { route: decision.route, ready: decision.ready, sourcePainId, pipelineMode: seedPipelineMode });
      // eslint-disable-next-line no-restricted-syntax -- 'in' required for discriminated union narrowing (BridgeTaskSeed | BridgeDecision)
      if ('decision' in seed) {
        output.deferred++;
        const decisionResult = seed as { decision: string; reason?: string; taskId?: string };
        const reason = decisionResult.decision === 'already_exists'
          ? `Task ${decisionResult.taskId} already exists`
          : decisionResult.reason ?? 'Seed not created';
        output.results.push({ candidateId, route: decision.route, status: 'deferred', reason, statusBefore: 'consumed', statusAfter: 'consumed', intakeDecision: 'not_needed', seedDecision: 'skipped', nextAction: reason.startsWith('Candidate ') ? 'Check candidate lineage fields (taskId, artifactId, sourceRunId)' : 'Verify internalization route configuration' });
        continue;
      }

      const { channel } = seed;
      const { taskId } = seed;

      // PRI-720 C6: candidate-level dedup (demotion may change the derived
      // channel suffix vs a pre-existing chain).
      const existingTask = await findExistingDreamerTask((id) => stateManager.getTask(id), candidateId);
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
        output.results.push({ candidateId, route: decision.route, status: 'existing', taskId: existingTask.taskId, channel, statusBefore: 'consumed', statusAfter: 'consumed', intakeDecision: 'not_needed', seedDecision: 'existing' });
        continue;
      }

      output.missingDreamerTask++;

      if (!isConfirm) {
        output.results.push({ candidateId, route: decision.route, status: 'would_create', taskId, channel, statusBefore: 'consumed', statusAfter: 'consumed', intakeDecision: 'not_needed', seedDecision: 'would_seed' });
        continue;
      }

      try {
        const task = await stateManager.createTask({
          taskId: seed.taskId,
          taskKind: seed.taskKind,
          status: seed.status,
          attemptCount: seed.attemptCount,
          maxAttempts: seed.maxAttempts,
          diagnosticJson: seed.diagnosticJson,
        });

        output.created++;
        output.results.push({ candidateId, route: decision.route, status: 'created', taskId: task.taskId, channel, statusBefore: 'consumed', statusAfter: 'consumed', intakeDecision: 'not_needed', seedDecision: 'seeded' });
      } catch (err) {
        output.errors++;
        output.results.push({ candidateId, route: decision.route, status: 'error', reason: err instanceof Error ? err.message : String(err), statusBefore: 'consumed', statusAfter: 'consumed', intakeDecision: 'not_needed', seedDecision: 'skipped', nextAction: 'Investigate dreamer task creation failure' });
      }
    }

    const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir: path.join(workspaceDir, '.state') });
    // R7 gate-bypass fix (adhoc-20261007): --include-pending intakes parked
    // (reuse_review_required) candidates too — the worst bypass, because it
    // consumed the very state the gate created to await the Owner (R7 Wave-2
    // audit D-1 §3.4). Same gated assembly as every other intake path.
    const intakeService = createReuseGatedIntakeService({ stateManager, ledgerAdapter, workspaceDir });

    for (const row of pendingRows) {
      const candidateId = row.candidate_id;

      const candidate = await stateManager.getCandidate(candidateId);
      if (!candidate) {
        output.errors++;
        output.results.push({ candidateId, route: 'unknown', status: 'error', reason: 'Pending candidate not found in DB', statusBefore: 'pending', statusAfter: 'pending', intakeDecision: 'skipped', seedDecision: 'skipped', nextAction: 'Investigate why pending candidate is missing from DB' });
        continue;
      }

      // PRI-442 Stage 4: admission gate check — refuse non-admitted pending
      // candidates to prevent backfill from bypassing the admission gate.
      const admissionBlock = checkAdmissionGate(candidate);
      if (admissionBlock) {
        output.intakeFailed++;
        output.results.push({ candidateId, route: 'unknown', status: 'intake_failed', reason: `Admission gate refused: ${admissionBlock.reason}`, statusBefore: 'pending', statusAfter: 'pending', intakeDecision: 'skipped', seedDecision: 'skipped', nextAction: admissionBlock.nextAction });
        continue;
      }

      const recommendation = resolveCandidateRecommendation(candidate, stateManager, candidateId);
      const decision = decideInternalizationRoute(recommendation as Parameters<typeof decideInternalizationRoute>[0]);

      // PRI-435: Resolve sourcePainId from the canonical diagnostician task chain.
      // Missing/malformed sourcePainId must fail loud per-candidate with no side effects.
      const sourcePainId = await resolveSourcePainIdFromDiagnostician(stateManager, candidate);
      if (sourcePainId === null) {
        output.errors++;
        output.results.push({ candidateId, route: decision.route, status: 'error', reason: `Cannot resolve sourcePainId from diagnostician task chain for candidate ${candidateId}`, statusBefore: 'pending', statusAfter: 'pending', intakeDecision: 'skipped', seedDecision: 'skipped', nextAction: 'Verify the diagnostician task diagnosticJson contains a valid top-level sourcePainId; re-run diagnosis if the pain signal is missing' });
        continue;
      }
      const seed = buildDreamerSeedFromCandidate(candidate, { route: decision.route, ready: decision.ready, sourcePainId, pipelineMode: seedPipelineMode });
      // eslint-disable-next-line no-restricted-syntax -- 'in' required for discriminated union narrowing (BridgeTaskSeed | BridgeDecision)
      if ('decision' in seed) {
        output.deferred++;
        const decisionResult = seed as { decision: string; reason?: string; taskId?: string };
        const reason = decisionResult.decision === 'already_exists'
          ? `Task ${decisionResult.taskId} already exists`
          : decisionResult.reason ?? 'Seed not created';
        output.results.push({ candidateId, route: decision.route, status: 'deferred', reason, statusBefore: 'pending', statusAfter: 'pending', intakeDecision: 'skipped', seedDecision: 'skipped', nextAction: 'Investigate why bridge decision is not seeded' });
        continue;
      }

      const { channel } = seed;
      const { taskId } = seed;

      if (!isConfirm) {
        output.missingDreamerTask++;
        output.results.push({ candidateId, route: decision.route, status: 'would_intake_and_create', taskId, channel, statusBefore: 'pending', statusAfter: 'pending', intakeDecision: 'would_intake', seedDecision: 'would_seed', nextAction: 'Run with --confirm to intake and seed' });
        continue;
      }

      const intakeResult = await intakeService.intake(candidateId).catch((intakeErr: unknown) => {
        output.intakeFailed++;
        const intakeReason = intakeErr instanceof CandidateIntakeError
          ? `Intake failed [${(intakeErr as { code?: string }).code ?? 'unknown'}]: ${intakeErr.message}`
          : `Intake failed: ${intakeErr instanceof Error ? intakeErr.message : String(intakeErr)}`;
        output.results.push({ candidateId, route: decision.route, status: 'intake_failed', reason: intakeReason, statusBefore: 'pending', statusAfter: 'pending', intakeDecision: 'intake_failed', seedDecision: 'skipped', nextAction: 'Fix intake issue and re-run backfill' });
        return null;
      });

      if (!intakeResult) {
        continue;
      }

      // Phase 1 / PR1: a Principle Ledger write boundary refusal is NOT a
      // failure — the candidate's kind simply does not target the ledger, so
      // having no ledger entry is the expected state. Report it and continue
      // without mutating candidate status or creating a dreamer task.
      //
      // Statuses are deliberately reused from the existing model (SPEC v2.1 §7
      // "禁止执行者自行创造新状态"): 'deferred' + 'skipped' rather than a new
      // status value.
      //
      // R7 gate-bypass fix: a park (reuse_pending_owner) is a DIFFERENT
      // refusal — the candidate is a suspected duplicate awaiting the Owner.
      // It must NOT be reported as "no action required" and must NOT be
      // counted as an intake failure: the gate worked. The candidate stays
      // pending; only `pd candidate review --decide` resolves it (cli-6).
      if (intakeResult.outcome === 'refused' && intakeResult.reason === 'reuse_pending_owner') {
        const recommended =
          intakeResult.reuseRecommendation?.status === 'recommended' ? intakeResult.reuseRecommendation : undefined;
        emitReuseGateParkedTelemetry(workspaceDir, candidateId, recommended);
        output.deferred++;
        output.results.push({
          candidateId,
          route: decision.route,
          status: 'deferred',
          reason: `reuse_review_required: candidate is a suspected duplicate${recommended?.selectedPrincipleId !== undefined ? ` of Principle ${recommended.selectedPrincipleId}` : ''} — parked for Owner review`,
          statusBefore: 'pending',
          statusAfter: 'pending',
          intakeDecision: 'skipped',
          seedDecision: 'skipped',
          nextAction: `pd candidate review --candidate-id ${candidateId} --decide reuse|create --reason "..."`,
        });
        continue;
      }
      if (intakeResult.outcome === 'refused') {
        output.results.push({ candidateId, route: decision.route, status: 'deferred', reason: intakeResult.message, statusBefore: 'pending', statusAfter: 'pending', intakeDecision: 'skipped', seedDecision: 'skipped', nextAction: 'No action required: this candidate kind does not target the Principle Ledger.' });
        continue;
      }

      const intakeEntry = intakeResult.entry;

      try {
        await updateCandidateStatus({ stateManager, candidateId, targetStatus: 'consumed', expectedCurrentStatus: 'pending' });
      } catch (statusErr) {
        const statusMsg = `Ledger write succeeded (entry ${intakeEntry.id}) but DB status update failed: ${statusErr instanceof Error ? statusErr.message : String(statusErr)}`;
        output.intakeFailed++;
        output.results.push({ candidateId, route: decision.route, status: 'intake_failed', reason: statusMsg, statusBefore: 'pending', statusAfter: 'pending', intakeDecision: 'intake_failed', seedDecision: 'skipped', nextAction: 'Candidate may be in inconsistent state — check ledger and DB manually' });
        continue;
      }

      output.intakeSucceeded++;

      const existingTask = await stateManager.getTask(taskId);
      if (existingTask) {
        output.alreadyHaveTask++;
        output.results.push({ candidateId, route: decision.route, status: 'intake_succeeded_existing_task', taskId: existingTask.taskId, channel, statusBefore: 'pending', statusAfter: 'consumed', intakeDecision: 'intake_succeeded', seedDecision: 'existing', reason: `Intake succeeded but dreamer task ${existingTask.taskId} already exists` });
        continue;
      }

      try {
        const task = await stateManager.createTask({
          taskId: seed.taskId,
          taskKind: seed.taskKind,
          status: seed.status,
          attemptCount: seed.attemptCount,
          maxAttempts: seed.maxAttempts,
          diagnosticJson: seed.diagnosticJson,
        });

        output.created++;
        output.results.push({ candidateId, route: decision.route, status: 'created', taskId: task.taskId, channel, statusBefore: 'pending', statusAfter: 'consumed', intakeDecision: 'intake_succeeded', seedDecision: 'seeded' });
      } catch (err) {
        output.errors++;
        output.results.push({ candidateId, route: decision.route, status: 'error', reason: err instanceof Error ? err.message : String(err), statusBefore: 'pending', statusAfter: 'consumed', intakeDecision: 'intake_succeeded', seedDecision: 'skipped', nextAction: 'Intake succeeded but dreamer task creation failed — candidate is consumed, re-run backfill for consumed candidates' });
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
      if (opts.includePending) {
        console.log(`  total_pending:       ${output.totalPending}`);
      }
      console.log(`  missing_dreamer:     ${output.missingDreamerTask}`);
      console.log(`  already_have_task:   ${output.alreadyHaveTask}`);
      console.log(`  deferred:            ${output.deferred}`);
      if (isConfirm) {
        console.log(`  created:             ${output.created}`);
        console.log(`  errors:              ${output.errors}`);
        if (opts.includePending) {
          console.log(`  intake_succeeded:    ${output.intakeSucceeded}`);
          console.log(`  intake_failed:       ${output.intakeFailed}`);
        }
      }
      for (const r of output.results) {
        const prefix = r.statusBefore === 'pending' ? '[pending]' : '[consumed]';
        console.log(`  ${prefix} ${r.candidateId}: ${r.status} (${r.route})${r.taskId ? ` → ${r.taskId}` : ''}${r.reason ? ` — ${r.reason}` : ''}`);
      }
      if (!isConfirm && (output.missingDreamerTask > 0 || output.totalPending > 0)) {
        console.log(`\n  (use --confirm to create missing dreamer tasks${opts.includePending ? ' and intake pending candidates' : ''})`);
      }
      console.log('');
    }

    if ((output.missingDreamerTask > 0 || output.totalPending > 0) && !isConfirm) {
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
