/**
 * Per-Workspace §8.4 atomic handover / rollback orchestration
 * (SPEC-PD-SERVICE-HOST-001 §8.4, TD §9; PRI-1282 Phase 4).
 *
 * The state machine itself lives in `@principles/install-layout`
 * (`transitionWorkspaceBackgroundExecution` — cross-process lock,
 * generation fencing, operationId idempotency). This module is the SEQUENCE
 * orchestrator the Operator drives:
 *
 *   HANDOVER (irreversible-order steps, none may be skipped):
 *   1. verify ownership readability + openclaw host binding (claims);
 *   2. begin_handover (registers the workspace in the manifest in the SAME
 *      atomic write; effectiveOwner stays legacy — PREPARING grants no
 *      rights);
 *   3. no-consume readiness via the ACTIVE-RELEASE worker
 *      (`openclaw worker --readiness`) — proves install wiring, declaration,
 *      evidence port and credentials WITHOUT consuming;
 *   4. wait for the Gateway's persisted quiesce acknowledgment
 *      (`pd.gateway-quiesce.v1`, bound to this operationId + generation) —
 *      clearTimeout / PID absence / process exit are never substitutes;
 *   5. ONE CAS transition to service_host_owned;
 *   6. drive one real worker cycle through the same managed adapter the
 *      scheduler uses;
 *   7. persist the completion evidence under <pdHome>/service/handover/.
 *
 *   ROLLBACK mirrors it: stop new cycles (run-lock busy check) →
 *   begin_rollback → complete_rollback (CAS back to legacy) → observe the
 *   Gateway's resumption evidence (or record NOT_VERIFIED when the Gateway
 *   is not running) → evidence.
 *
 * Crash recovery is deterministic: every step re-derives from the persisted
 * `state + operationId + generation` (design §7.3). Process liveness is
 * never consulted.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  readWorkspaceBackgroundOwnership,
  transitionWorkspaceBackgroundExecution,
  type BackgroundExecutionRecord,
  type WorkspaceBackgroundOwnership,
} from '@principles/install-layout';
import { resolveCoordinatorInstallIdentity } from './install-identity.js';
import { collectHostWorkspaceClaimsFor } from './handover-claims.js';
import { acquireServiceRunLock } from './locking/service-run-lock.js';
import { buildWorkerEnvironment } from './worker-env.js';
import { resolveActiveReleaseCliEntry } from './worker-adapter.js';
import { runWorkerProcess } from './worker-process.js';
import type { WorkerProcessResult } from './worker-process.js';

export const DEFAULT_HANDOVER_ACK_WAIT_MS = 15 * 60_000;
export const DEFAULT_HANDOVER_STEP_TIMEOUT_MS = 2 * 60_000;
export const DEFAULT_ROLLBACK_RESUME_WAIT_MS = 90_000;
const HANDOVER_EVIDENCE_SCHEMA = 'pd.service-handover-evidence.v1';

// ─── Shared plumbing ────────────────────────────────────────────────────────

export interface HandoverContextInput {
  readonly pdHomeOverride?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly ackWaitMs?: number;
  readonly stepTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type HandoverContext =
  | { ok: true; pdHome: string; homeDir: string; manifestPath: string; workspaceDir: string }
  | { ok: false; reason: string; nextAction: string };

export function establishHandoverContext(workspaceDir: string, input: HandoverContextInput): HandoverContext {
  const identity = resolveCoordinatorInstallIdentity(input.env ?? process.env, input.pdHomeOverride !== undefined ? { trustedHomeDir: input.pdHomeOverride } : {});
  if (!identity.ok) {
    return { ok: false, reason: `install_identity_unresolved:${identity.reason}`, nextAction: identity.nextAction };
  }
  const manifestPath = path.join(identity.identity.pdHome, 'install.json');
  let workspace: string;
  try {
    workspace = path.resolve(workspaceDir);
  } catch {
    return { ok: false, reason: 'workspace_path_invalid', nextAction: 'Pass an absolute canonical workspace directory.' };
  }
  return { ok: true, pdHome: identity.identity.pdHome, homeDir: identity.identity.homeDir, manifestPath, workspaceDir: workspace };
}

function wait(ms: number): Promise<void> {
  // REF'd on purpose: these are operator-command orchestration waits (ack
  // polling, resumption observation) with hard deadlines. An unref'd timer
  // here let Node exit mid-await with a pending promise — transitions
  // applied, stdout empty, exit 0 (found in Stage 9 acceptance).
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Sanitized single-line key for the evidence directory (no path separators). */
function workspaceEvidenceKey(canonicalDir: string): string {
  return canonicalDir.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-120);
}

export function handoverEvidencePath(pdHome: string, canonicalDir: string, operationId: string): string {
  return path.join(pdHome, 'service', 'handover', workspaceEvidenceKey(canonicalDir), `${operationId}.json`);
}

export interface HandoverEvidence {
  schemaVersion: typeof HANDOVER_EVIDENCE_SCHEMA;
  kind: 'handover' | 'rollback';
  operationId: string;
  workspaceDir: string;
  startedAt: string;
  completedAt: string;
  outcome: 'completed' | 'aborted' | 'failed';
  steps: readonly { step: string; at: string; outcome: string; detail?: string }[];
  finalOwnership: WorkspaceBackgroundOwnership;
}

export function writeHandoverEvidence(evidence: HandoverEvidence, pdHome: string): { ok: boolean; path: string; reason?: string } {
  const target = handoverEvidencePath(pdHome, evidence.workspaceDir, evidence.operationId);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Write-once: an existing evidence document for this operationId is the
    // audit record; a rerun appends nothing and never rewrites history.
    if (fs.existsSync(target)) return { ok: true, path: target, reason: 'already_exists' };
    const tmp = `${target}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(evidence, null, 2) + '\n');
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
    return { ok: true, path: target };
  } catch (error) {
    return { ok: false, path: target, reason: error instanceof Error ? error.message : String(error) };
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Field-level validation of one persisted evidence step (rc-3/rc-4). */
function parseEvidenceStep(value: unknown): { step: string; at: string; outcome: string; detail?: string } | null {
  if (!isJsonObject(value)) return null;
  if (!isNonEmptyString(value.step) || !isNonEmptyString(value.at) || !isNonEmptyString(value.outcome)) return null;
  if (value.detail !== undefined && !isNonEmptyString(value.detail)) return null;
  return { step: value.step, at: value.at, outcome: value.outcome, ...(value.detail !== undefined ? { detail: value.detail } : {}) };
}

/**
 * Field-level validation of one embedded BackgroundExecutionRecord
 * (rc-3: required fields validated explicitly, never cast into shape).
 */
function parseEvidenceRecord(
  value: unknown,
  state: 'legacy_owned' | 'handover_preparing' | 'service_host_owned' | 'rollback_pending',
): BackgroundExecutionRecord | null {
  if (!isJsonObject(value)) return null;
  if (value.state !== state) return null;
  if (value.effectiveOwner !== 'legacy' && value.effectiveOwner !== 'service_host') return null;
  if (typeof value.generation !== 'number' || !Number.isInteger(value.generation) || value.generation < 0) return null;
  if (value.operationId !== null && !isNonEmptyString(value.operationId)) return null;
  if (value.previousOwner !== null && value.previousOwner !== 'legacy' && value.previousOwner !== 'service_host') return null;
  if (value.targetOwner !== null && value.targetOwner !== 'legacy' && value.targetOwner !== 'service_host') return null;
  if (!isNonEmptyString(value.updatedAt)) return null;
  return {
    state,
    effectiveOwner: value.effectiveOwner,
    generation: value.generation,
    operationId: value.operationId ?? null,
    previousOwner: value.previousOwner,
    targetOwner: value.targetOwner,
    updatedAt: value.updatedAt,
  };
}

/**
 * Field-level validation of the persisted ownership projection embedded in
 * an evidence document (rc-2/rc-3: untrusted JSON until proven). Every
 * branch constructs its exact variant from validated fields — no casts.
 */
function parseEvidenceOwnership(value: unknown): WorkspaceBackgroundOwnership | null {
  if (!isJsonObject(value)) return null;
  if (typeof value.generation !== 'number' || !Number.isInteger(value.generation) || value.generation < 0) return null;
  if (value.status === 'legacy_owned') {
    if (value.source !== 'record' && value.source !== 'no_record') return null;
    if (value.record === undefined) {
      return { status: 'legacy_owned', source: value.source, generation: value.generation };
    }
    const record = parseEvidenceRecord(value.record, 'legacy_owned');
    if (record === null) return null;
    return { status: 'legacy_owned', source: value.source, generation: value.generation, record };
  }
  if (value.status === 'manifest_unreadable') {
    if (!isNonEmptyString(value.reason) || !isNonEmptyString(value.nextAction)) return null;
    return { status: 'manifest_unreadable', reason: value.reason, nextAction: value.nextAction };
  }
  if (value.status !== 'handover_preparing' && value.status !== 'service_host_owned' && value.status !== 'rollback_pending') {
    return null;
  }
  const record = parseEvidenceRecord(value.record, value.status);
  if (record === null) return null;
  return {
    status: value.status,
    generation: value.generation,
    record,
  };
}

/**
 * Read + field-validate the write-once evidence document (rc-2/rc-3:
 * untrusted JSON until proven — an unreadable or malformed document is
 * null, i.e. "no evidence", and the caller fails closed).
 */
export function readHandoverEvidence(pdHome: string, canonicalDir: string, operationId: string): HandoverEvidence | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(handoverEvidencePath(pdHome, canonicalDir, operationId), 'utf8'));
    if (!isJsonObject(parsed)) return null;
    if (parsed.schemaVersion !== HANDOVER_EVIDENCE_SCHEMA) return null;
    if (parsed.kind !== 'handover' && parsed.kind !== 'rollback') return null;
    if (!isNonEmptyString(parsed.operationId) || !isNonEmptyString(parsed.workspaceDir)) return null;
    if (!isNonEmptyString(parsed.startedAt) || !isNonEmptyString(parsed.completedAt)) return null;
    if (parsed.outcome !== 'completed' && parsed.outcome !== 'aborted' && parsed.outcome !== 'failed') return null;
    if (!Array.isArray(parsed.steps)) return null;
    const steps: { step: string; at: string; outcome: string; detail?: string }[] = [];
    for (const rawStep of parsed.steps) {
      const step = parseEvidenceStep(rawStep);
      if (step === null) return null;
      steps.push(step);
    }
    const finalOwnership = parseEvidenceOwnership(parsed.finalOwnership);
    if (finalOwnership === null) return null;
    return {
      schemaVersion: HANDOVER_EVIDENCE_SCHEMA,
      kind: parsed.kind,
      operationId: parsed.operationId,
      workspaceDir: parsed.workspaceDir,
      startedAt: parsed.startedAt,
      completedAt: parsed.completedAt,
      outcome: parsed.outcome,
      steps,
      finalOwnership,
    };
  } catch {
    return null;
  }
}

/** Spawn a bounded active-release CLI probe (readiness or one cycle). */
async function runActiveReleaseWorkerProbe(args: {
  homeDir: string;
  workspaceDir: string;
  mode: 'readiness' | 'once';
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ ok: true; result: WorkerProcessResult } | { ok: false; reason: string; nextAction: string }> {
  const identity = resolveCoordinatorInstallIdentity(process.env, { trustedHomeDir: args.homeDir });
  if (!identity.ok) return { ok: false, reason: `install_identity_unresolved:${identity.reason}`, nextAction: identity.nextAction };
  const entry = resolveActiveReleaseCliEntry(identity.identity);
  if (entry.kind === 'missing') {
    return { ok: false, reason: `active_release_missing:${entry.reason}`, nextAction: entry.nextAction };
  }
  const { env } = buildWorkerEnvironment({
    identity: identity.identity,
    hostKind: 'openclaw',
    inheritedEnv: process.env,
    credentialEnvAllowlist: [],
  });
  const result = await runWorkerProcess({
    cliEntry: entry.entry,
    args: ['openclaw', 'worker', args.mode === 'readiness' ? '--readiness' : '--once', '--json', '--workspace', args.workspaceDir],
    env,
    timeoutMs: args.timeoutMs,
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  });
  return { ok: true, result };
}

function parseWorkerJson(stdout: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ─── Handover ────────────────────────────────────────────────────────────────

export interface HandoverRunOptions extends HandoverContextInput {
  readonly resumeOperationId?: string;
  /** Abort an in-flight handover_preparing back to legacy_owned. */
  readonly abort?: boolean;
}

export type HandoverRunResult =
  | {
      ok: true;
      outcome: 'completed';
      operationId: string;
      workspaceDir: string;
      generation: number;
      readiness: 'ready';
      quiesceAck: { operationId: string; generation: number; outcome: string; startedVia: string };
      workerCycle: { mode: string; exitCode: number | null; evidencePath: string };
      evidencePath: string;
    }
  | {
      ok: false;
      outcome: 'aborted' | 'blocked' | 'failed';
      reason: string;
      nextAction: string;
      operationId?: string;
      detail?: unknown;
    };

export async function runWorkspaceHandover(workspaceDir: string, options: HandoverRunOptions): Promise<HandoverRunResult> {
  const context = establishHandoverContext(workspaceDir, options);
  if (!context.ok) return { ok: false, outcome: 'blocked', reason: context.reason, nextAction: context.nextAction };
  const ackWaitMs = options.ackWaitMs ?? DEFAULT_HANDOVER_ACK_WAIT_MS;
  const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_HANDOVER_STEP_TIMEOUT_MS;
  const startedAt = nowIso();
  const steps: { step: string; at: string; outcome: string; detail?: string }[] = [];
  const record = (step: string, outcome: string, detail?: string): void => {
    steps.push({ step, at: nowIso(), outcome, ...(detail !== undefined ? { detail } : {}) });
  };
  const aborted = (): boolean => options.signal?.aborted === true;

  // ── 1. Ownership readability + host binding verification. ──
  const initial = readWorkspaceBackgroundOwnership({ manifestPath: context.manifestPath, workspaceDir: context.workspaceDir });
  if (initial.status === 'manifest_unreadable') {
    return { ok: false, outcome: 'blocked', reason: `ownership_unreadable:${initial.reason}`, nextAction: initial.nextAction };
  }
  // ── Crash-recovery continuation (design §7.3): a prior run already flipped
  // the marker. With the SAME operationId's completed evidence this converges
  // as verify-only (one worker cycle + evidence reconciliation); WITHOUT that
  // proof it refuses — the command never claims an operation it cannot
  // attribute (the marker does not retain operationId in steady states).
  // ──
  if (initial.status === 'service_host_owned') {
    const priorOp = options.resumeOperationId ?? '';
    const priorEvidence = priorOp !== '' ? readHandoverEvidence(context.pdHome, context.workspaceDir, priorOp) : null;
    if (priorOp !== '' && priorEvidence !== null && priorEvidence.outcome === 'completed') {
      record('already_service_host_owned', 'verify_only_continuation');
      const cycleCont = await runActiveReleaseWorkerProbe({ homeDir: context.homeDir, workspaceDir: context.workspaceDir, mode: 'once', timeoutMs: Math.max(stepTimeoutMs, 10 * 60_000), ...(options.signal !== undefined ? { signal: options.signal } : {}) });
      const cycleContJson = cycleCont.ok ? parseWorkerJson(cycleCont.result.stdout) : null;
      record('worker_cycle', cycleCont.ok ? String(cycleContJson?.mode ?? `exit=${cycleCont.result.exitCode}`) : cycleCont.reason);
      const ownershipAfter = readWorkspaceBackgroundOwnership({ manifestPath: context.manifestPath, workspaceDir: context.workspaceDir });
      const evidenceCont: HandoverEvidence = {
        schemaVersion: HANDOVER_EVIDENCE_SCHEMA,
        kind: 'handover',
        operationId: priorOp,
        workspaceDir: context.workspaceDir,
        startedAt,
        completedAt: nowIso(),
        outcome: 'completed',
        steps,
        finalOwnership: ownershipAfter,
      };
      const writtenCont = writeHandoverEvidence(evidenceCont, context.pdHome);
      return {
        ok: true,
        outcome: 'completed',
        operationId: priorOp,
        workspaceDir: context.workspaceDir,
        generation: ownershipAfter.status === 'service_host_owned' ? ownershipAfter.generation : 0,
        readiness: 'ready',
        quiesceAck: { operationId: priorOp, generation: priorEvidence.finalOwnership.status === 'service_host_owned' ? priorEvidence.finalOwnership.generation : 0, outcome: 'verified_by_prior_evidence', startedVia: 'prior_run' },
        workerCycle: { mode: String(cycleContJson?.mode ?? 'unknown'), exitCode: cycleCont.ok ? cycleCont.result.exitCode : null, evidencePath: writtenCont.path },
        evidencePath: writtenCont.path,
      };
    }
    return {
      ok: false,
      outcome: 'blocked',
      reason: 'already_service_host_owned',
      nextAction: 'This workspace already belongs to the Service Host. Pass --resume <operationId> of the completed handover to re-verify, or use pd service rollback to return it to the legacy consumer.',
    };
  }
  const binding = collectHostWorkspaceClaimsFor(context.workspaceDir, context.homeDir, options.env);
  if (!binding.openclawClaimed) {
    return {
      ok: false,
      outcome: 'blocked',
      reason: 'no_openclaw_host_binding',
      nextAction: 'Bind the workspace to OpenClaw first (host declaration or validated mcp-binding claim); the handover never guesses host ownership.',
    };
  }
  if (binding.foreignOwner !== null) {
    return {
      ok: false,
      outcome: 'blocked',
      reason: `foreign_workspace_owner:${binding.foreignOwner}`,
      nextAction: 'Another host claims this workspace; resolve the cross-host ownership conflict before handing over to the Service Host.',
    };
  }
  record('binding_verified', 'openclaw_claim_present');

  // ── 2. begin_handover (idempotent; registers the workspace atomically). ──
  const resumeOp = initial.status === 'handover_preparing' ? initial.record.operationId : undefined;
  if (options.abort === true) {
    const target = resumeOp ?? options.resumeOperationId;
    if (target === undefined || target === null) {
      return { ok: false, outcome: 'blocked', reason: 'abort_requires_operation', nextAction: 'No handover_preparing record exists for this workspace; nothing to abort.' };
    }
    const abortedTransition = transitionWorkspaceBackgroundExecution({
      manifestPath: context.manifestPath, workspaceDir: context.workspaceDir, kind: 'abort_handover', operationId: target,
    });
    if (!abortedTransition.ok) return { ok: false, outcome: 'failed', reason: `abort_failed:${abortedTransition.reason}`, nextAction: abortedTransition.nextAction ?? 'Inspect the manifest ownership record.', detail: abortedTransition.message };
    record('aborted', 'legacy_owned');
    return { ok: false, outcome: 'aborted', reason: 'handover_aborted_by_operator', nextAction: 'The workspace is back to legacy ownership; the Gateway consumer is the sole owner.', operationId: target };
  }
  const operationId = resumeOp ?? options.resumeOperationId ?? `handover-${crypto.randomUUID()}`;
  const begin = transitionWorkspaceBackgroundExecution({
    manifestPath: context.manifestPath, workspaceDir: context.workspaceDir, kind: 'begin_handover', operationId, registerWorkspace: true,
  });
  if (!begin.ok) {
    return { ok: false, outcome: 'blocked', reason: `begin_handover_failed:${begin.reason}`, nextAction: begin.nextAction ?? 'Re-read the ownership record and retry.', operationId, detail: begin.message };
  }
  record('begin_handover', begin.changed ? 'handover_preparing' : 'idempotent_replay', `generation=${begin.record.generation}`);
  const preparingGeneration = begin.record.generation;

  // ── 3. No-consume readiness through the ACTIVE-RELEASE worker. ──
  const readiness = await runActiveReleaseWorkerProbe({ homeDir: context.homeDir, workspaceDir: context.workspaceDir, mode: 'readiness', timeoutMs: stepTimeoutMs, ...(options.signal !== undefined ? { signal: options.signal } : {}) });
  if (!readiness.ok) {
    const rollback = transitionWorkspaceBackgroundExecution({ manifestPath: context.manifestPath, workspaceDir: context.workspaceDir, kind: 'abort_handover', operationId });
    record('readiness', 'unavailable', readiness.reason);
    if (!rollback.ok) {
      return { ok: false, outcome: 'failed', reason: `readiness_failed_and_abort_failed:${readiness.reason}|${rollback.reason}`, nextAction: 'The workspace is STUCK in handover_preparing — resolve manually (pd service handover --abort).', operationId, detail: readiness.nextAction };
    }
    return { ok: false, outcome: 'blocked', reason: `readiness_not_met:${readiness.reason}`, nextAction: `${readiness.nextAction} The workspace was restored to legacy ownership.`, operationId };
  }
  const readinessJson = parseWorkerJson(readiness.result.stdout);
  const readinessMode = typeof readinessJson?.mode === 'string' ? readinessJson.mode : 'unknown';
  if (readinessMode !== 'ready') {
    const rollback = transitionWorkspaceBackgroundExecution({ manifestPath: context.manifestPath, workspaceDir: context.workspaceDir, kind: 'abort_handover', operationId });
    record('readiness', readinessMode, readiness.result.stdout.slice(0, 400));
    if (!rollback.ok) {
      return { ok: false, outcome: 'failed', reason: `readiness_not_ready_and_abort_failed:${readinessMode}|${rollback.reason}`, nextAction: 'The workspace is STUCK in handover_preparing — resolve manually (pd service handover --abort).', operationId };
    }
    return {
      ok: false,
      outcome: 'blocked',
      reason: `openclaw_worker_readiness:${readinessMode}`,
      nextAction: 'Fix the failing readiness checks (declaration / evidence port / credentials) and retry; the workspace was restored to legacy ownership.',
      operationId,
      detail: readinessJson ?? undefined,
    };
  }
  record('readiness', 'ready');

  // ── 4. Wait for the Gateway quiesce ack (persisted, operation-bound). ──
  const ackPlugin = await import('principles-disciple/openclaw-worker');
  const ackDeadline = Date.now() + (options.ackWaitMs ?? ackWaitMs);
  let ack: ReturnType<typeof ackPlugin.readGatewayQuiesceAck> = null;
  while (Date.now() < ackDeadline) {
    if (aborted()) break;
    ack = ackPlugin.readGatewayQuiesceAck(context.workspaceDir);
    if (ack !== null && ack.operationId === operationId && ack.generation === preparingGeneration && ack.outcome === 'quiesced' && ack.inFlightCycles === 0) break;
    await wait(2_000);
  }
  const ackDefect: string | null = ack === null
    ? 'gateway_quiesce_ack_absent'
    : ack.operationId !== operationId
      ? 'gateway_quiesce_ack_operation_mismatch'
      : ack.generation !== preparingGeneration
        ? 'gateway_quiesce_ack_generation_mismatch'
        : ack.outcome !== 'quiesced'
          ? `gateway_quiesce_ack_not_quiesced:${ack.outcome}`
          : null;
  if (ackDefect !== null) {
    const rollback = transitionWorkspaceBackgroundExecution({ manifestPath: context.manifestPath, workspaceDir: context.workspaceDir, kind: 'abort_handover', operationId });
    record('quiesce_ack', 'missing_or_mismatched', ack === null ? 'no_ack_file' : `${ack.state}/${ack.operationId}/${ack.outcome}`);
    if (!rollback.ok) {
      return { ok: false, outcome: 'failed', reason: `quiesce_unproven_and_abort_failed:${ackDefect}|${rollback.reason}`, nextAction: 'The workspace is STUCK in handover_preparing — resolve manually (pd service handover --abort).', operationId };
    }
    return {
      ok: false,
      outcome: 'blocked',
      reason: ackDefect,
      nextAction: ackDefect === 'gateway_quiesce_ack_not_quiesced:in_flight_timeout'
        ? 'The Gateway reported an in-flight cycle it could not bound; retry the handover after the cycle settles.'
        : ackDefect === 'gateway_quiesce_ack_operation_mismatch'
          ? 'The persisted ack belongs to a DIFFERENT handover operation; let this operation reach the Gateway (it may still be mid-tick) and retry, or restart the Gateway so its gates re-acknowledge.'
          : 'Start or restart the OpenClaw Gateway so it can acknowledge the handover (its start gate writes the ack), then retry.',
      operationId,
      detail: ack ?? undefined,
    };
  }
  if (ack === null) {
    // Unreachable (a null ack always yields a defect above) — kept total for
    // the type system; fail loudly rather than trust a silent pass-through.
    return { ok: false, outcome: 'failed', reason: 'internal_ack_unexpected_null', nextAction: 'Retry the handover.', operationId };
  }
  record('quiesce_ack', 'quiesced', `startedVia=${ack.writer.startedVia}`);

  // ── 5. The single CAS flip. ──
  const flip = transitionWorkspaceBackgroundExecution({
    manifestPath: context.manifestPath, workspaceDir: context.workspaceDir, kind: 'complete_handover', operationId, expectedGeneration: preparingGeneration,
  });
  if (!flip.ok) {
    // unexpected_state on service_host_owned can mean a prior crashed run
    // already flipped: distinguish via the marker, never by guessing.
    const after = readWorkspaceBackgroundOwnership({ manifestPath: context.manifestPath, workspaceDir: context.workspaceDir });
    if (after.status === 'service_host_owned') {
      record('cas_flip', 'already_service_host_owned', flip.reason);
    } else {
      return { ok: false, outcome: 'failed', reason: `complete_handover_failed:${flip.reason}`, nextAction: flip.nextAction ?? 'Re-read the ownership record and retry; the workspace is still handover_preparing.', operationId, detail: flip.message };
    }
  } else {
    record('cas_flip', 'service_host_owned', `generation=${flip.record.generation}`);
  }

  // ── 6. One real worker cycle through the active release. ──
  const cycle = await runActiveReleaseWorkerProbe({ homeDir: context.homeDir, workspaceDir: context.workspaceDir, mode: 'once', timeoutMs: Math.max(stepTimeoutMs, 10 * 60_000), ...(options.signal !== undefined ? { signal: options.signal } : {}) });
  const cycleJson = cycle.ok ? parseWorkerJson(cycle.result.stdout) : null;
  record('worker_cycle', cycle.ok ? String(cycleJson?.mode ?? `exit=${cycle.result.exitCode}`) : cycle.reason, cycle.ok ? cycle.result.stdout.slice(0, 400) : cycle.nextAction);

  // ── 7. Completion evidence (write-once, operationId keyed). ──
  const finalOwnership = readWorkspaceBackgroundOwnership({ manifestPath: context.manifestPath, workspaceDir: context.workspaceDir });
  const evidence: HandoverEvidence = {
    schemaVersion: HANDOVER_EVIDENCE_SCHEMA,
    kind: 'handover',
    operationId,
    workspaceDir: context.workspaceDir,
    startedAt,
    completedAt: nowIso(),
    outcome: 'completed',
    steps,
    finalOwnership,
  };
  const written = writeHandoverEvidence(evidence, context.pdHome);
  return {
    ok: true,
    outcome: 'completed',
    operationId,
    workspaceDir: context.workspaceDir,
    generation: finalOwnership.status === 'service_host_owned' ? finalOwnership.generation : (flip.ok ? flip.record.generation : preparingGeneration),
    readiness: 'ready',
    quiesceAck: { operationId: ack.operationId ?? operationId, generation: ack.generation, outcome: ack.outcome, startedVia: ack.writer.startedVia },
    workerCycle: { mode: String(cycleJson?.mode ?? 'unknown'), exitCode: cycle.ok ? cycle.result.exitCode : null, evidencePath: written.path },
    evidencePath: written.path,
  };
}

// ─── Rollback ────────────────────────────────────────────────────────────────

export type RollbackRunResult =
  | {
      ok: true;
      outcome: 'completed';
      operationId: string;
      workspaceDir: string;
      generation: number;
      gatewayResumption: 'observed' | 'not_verified_gateway_not_running';
      evidencePath: string;
    }
  | { ok: false; outcome: 'blocked' | 'failed'; reason: string; nextAction: string; operationId?: string };

export async function runWorkspaceRollback(workspaceDir: string, options: HandoverContextInput): Promise<RollbackRunResult> {
  const context = establishHandoverContext(workspaceDir, options);
  if (!context.ok) return { ok: false, outcome: 'blocked', reason: context.reason, nextAction: context.nextAction };
  const startedAt = nowIso();
  const steps: { step: string; at: string; outcome: string; detail?: string }[] = [];
  const record = (step: string, outcome: string, detail?: string): void => {
    steps.push({ step, at: nowIso(), outcome, ...(detail !== undefined ? { detail } : {}) });
  };

  // ── 1-3. Stop Service Host cycles: a held run-once lock means a managed
  // run is ACTIVE — the rollback refuses rather than race it. ──
  const runLock = acquireServiceRunLock(context.pdHome);
  if (!runLock.ok) {
    return {
      ok: false,
      outcome: 'blocked',
      reason: `service_run_in_progress:${runLock.kind}`,
      nextAction: 'A managed run-once is currently executing; wait for it to finish (workers are bounded) and retry the rollback.',
    };
  }

  try {
    const initial = readWorkspaceBackgroundOwnership({ manifestPath: context.manifestPath, workspaceDir: context.workspaceDir });
    if (initial.status === 'manifest_unreadable') {
      return { ok: false, outcome: 'blocked', reason: `ownership_unreadable:${initial.reason}`, nextAction: initial.nextAction };
    }
    // ── 4-6. begin_rollback → complete_rollback (CAS back to legacy). ──
    const resumeOp = initial.status === 'rollback_pending' ? initial.record.operationId : undefined;
    const operationId = resumeOp ?? `rollback-${crypto.randomUUID()}`;
    const begin = transitionWorkspaceBackgroundExecution({
      manifestPath: context.manifestPath, workspaceDir: context.workspaceDir, kind: 'begin_rollback', operationId,
    });
    if (!begin.ok) {
      return { ok: false, outcome: 'blocked', reason: `begin_rollback_failed:${begin.reason}`, nextAction: begin.nextAction ?? 'Only a service_host_owned workspace can roll back.', operationId };
    }
    record('begin_rollback', begin.changed ? 'rollback_pending' : 'idempotent_replay', `generation=${begin.record.generation}`);
    const finish = transitionWorkspaceBackgroundExecution({
      manifestPath: context.manifestPath, workspaceDir: context.workspaceDir, kind: 'complete_rollback', operationId,
    });
    if (!finish.ok) {
      return { ok: false, outcome: 'failed', reason: `complete_rollback_failed:${finish.reason}`, nextAction: 'The workspace is rollback_pending — rerun the rollback command to complete it (fail-closed, never auto-cleared).', operationId };
    }
    record('complete_rollback', 'legacy_owned', `generation=${finish.record.generation}`);

    // ── 7-9. Observe the Gateway's resumption (bounded; honest NOT_VERIFIED
    // when the Gateway is not running — the start gate guarantees resumption
    // on its next launch, verified separately by the gate tests). ──
    let gatewayResumption: 'observed' | 'not_verified_gateway_not_running' = 'not_verified_gateway_not_running';
    const resumeDeadline = Date.now() + (options.ackWaitMs ?? DEFAULT_ROLLBACK_RESUME_WAIT_MS);
    while (Date.now() < resumeDeadline) {
      if (options.signal?.aborted === true) break;
      const logsDir = path.join(context.workspaceDir, 'memory', 'logs');
      try {
        const logs = fs.readdirSync(logsDir).filter((name) => name.startsWith('SYSTEM_')).sort();
        for (const logName of logs.slice(-3)) {
          const text = fs.readFileSync(path.join(logsDir, logName), 'utf8');
          if (text.includes('INTERNALIZATION_CONSUMER_RESUMED') || text.includes('INTERNALIZATION_CONSUMER_STARTED')) {
            gatewayResumption = 'observed';
            break;
          }
        }
      } catch {
        // No SystemLogger stream at all → Gateway has never run here in this
        // window; stays not_verified.
      }
      if (gatewayResumption === 'observed') break;
      await wait(3_000);
    }
    record('gateway_resumption', gatewayResumption);

    const finalOwnership = readWorkspaceBackgroundOwnership({ manifestPath: context.manifestPath, workspaceDir: context.workspaceDir });
    const evidence: HandoverEvidence = {
      schemaVersion: HANDOVER_EVIDENCE_SCHEMA,
      kind: 'rollback',
      operationId,
      workspaceDir: context.workspaceDir,
      startedAt,
      completedAt: nowIso(),
      outcome: 'completed',
      steps,
      finalOwnership,
    };
    const written = writeHandoverEvidence(evidence, context.pdHome);
    return {
      ok: true,
      outcome: 'completed',
      operationId,
      workspaceDir: context.workspaceDir,
      generation: finish.record.generation,
      gatewayResumption,
      evidencePath: written.path,
    };
  } finally {
    const { releaseServiceRunLock } = await import('./locking/service-run-lock.js');
    releaseServiceRunLock(runLock.handle);
  }
}
