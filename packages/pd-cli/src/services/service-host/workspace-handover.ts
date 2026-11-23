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
import { acquireServiceRunLock, probeServiceRunLockState, releaseServiceRunLock, workspaceServiceRunLockPath } from './locking/service-run-lock.js';
import { runSchedulerLifecycle } from './scheduler/index.js';
import { readActiveReleaseFacts } from './status/service-run-status.js';
import { buildWorkerEnvironment } from './worker-env.js';
import { readConfigCredentialEnvNames, resolveActiveReleaseCliEntry, type AdapterCycleResult } from './worker-adapter.js';
import { createOpenClawWorkerAdapter } from './worker-adapter-openclaw.js';
import { runWorkerProcess } from './worker-process.js';
import type { WorkerProcessResult } from './worker-process.js';

/* eslint-disable @typescript-eslint/no-use-before-define -- helpers declared after main, matching codebase convention */

export const DEFAULT_HANDOVER_ACK_WAIT_MS = 15 * 60_000;
export const DEFAULT_HANDOVER_STEP_TIMEOUT_MS = 2 * 60_000;
export const DEFAULT_ROLLBACK_RESUME_WAIT_MS = 90_000;
/**
 * Bounded wait for the last in-flight worker cycle to release the workspace
 * run mutex during rollback (PRI-1282 P1-1). Matches the consumer cycle's
 * own bound; on expiry the workspace stays rollback_pending and resumable.
 */
export const DEFAULT_ROLLBACK_DRAIN_WAIT_MS = 10 * 60_000;
const HANDOVER_EVIDENCE_SCHEMA = 'pd.service-handover-evidence.v1';
const HANDOVER_INTENT_SCHEMA = 'pd.service-handover-intent.v1';

// ─── Shared plumbing ────────────────────────────────────────────────────────

export interface HandoverContextInput {
  readonly pdHomeOverride?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly ackWaitMs?: number;
  readonly stepTimeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Test seam: the scheduler-enabled probe the handover runs before the CAS
   * flip (default: real `runSchedulerLifecycle('status', …)`).
   */
  readonly probes?: {
    readonly schedulerStatus?: () => Promise<
      | { ok: true; registered: boolean | null; enabled: boolean | null }
      | { ok: false; reason: string }
    >;
    /**
     * Test seam: mints the operationId for a FRESH operation (never used
     * when a marker or --resume names one — explicit resume only continues
     * a real in-flight operation, per PRI-1282 r4 §5).
     */
    readonly mintOperationId?: (kind: 'handover' | 'rollback') => string;
  };
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
  // Pin the workspace to its REAL directory: intent files, evidence files,
  // the worker launch and the workspace run mutex are all keyed off this
  // spelling, so a symlinked and a real-path invocation meet the SAME
  // operation and either spelling resumes it (PRI-1282 review).
  try {
    workspace = fs.realpathSync.native(workspace);
  } catch {
    // Unresolvable target: keep the lexical spelling — the readiness probe
    // reports the missing directory as the honest failure.
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

/**
 * Sanitized single-line key for the evidence directory (no path
 * separators). A readable stem ALONE is a real collision surface
 * (`/tmp/a b` vs `/tmp/a_b` → same key → cross-workspace evidence mixing,
 * PRI-1282 review P1-6), so the full path's SHA-256 suffix is the actual
 * identity; the stem only keeps the directory browsable.
 */
function workspaceEvidenceKey(canonicalDir: string): string {
  const stem = canonicalDir.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-48);
  const digest = crypto.createHash('sha256').update(canonicalDir, 'utf8').digest('hex').slice(0, 16);
  return `${stem}-${digest}`;
}

/**
 * operationId is the operation's idempotency key AND a filename component
 * under <pdHome>/service/handover/ — an operator-supplied value that
 * reached the filesystem unchecked allowed path traversal (PRI-1282 review
 * P1-6). Whitelisted to characters that are safe on every filesystem.
 */
const SAFE_OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function isSafeOperationId(operationId: string): boolean {
  return SAFE_OPERATION_ID.test(operationId);
}

/**
 * Canonical-directory equality for the persisted quiesce ack (PRI-1282 r4
 * §11): writer, reader and this context all key off REAL directory
 * identity — an ack recorded under a symlinked alias spelling of the same
 * directory binds it; a spelling that resolves elsewhere does not. An
 * unresolvable spelling fails closed (no match).
 */
function ackWorkspaceMatches(recorded: string, canonicalDir: string): boolean {
  let realRecorded: string;
  try {
    realRecorded = fs.realpathSync.native(recorded);
  } catch {
    realRecorded = path.resolve(recorded);
  }
  let realCanonical: string;
  try {
    realCanonical = fs.realpathSync.native(canonicalDir);
  } catch {
    realCanonical = path.resolve(canonicalDir);
  }
  return realRecorded === realCanonical;
}

function errnoOf(error: unknown): string {
  return typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
    ? String(Reflect.get(error, 'code'))
    : '';
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
  if (!isSafeOperationId(evidence.operationId)) {
    return { ok: false, path: handoverEvidencePath(pdHome, evidence.workspaceDir, 'invalid'), reason: 'operation_id_invalid' };
  }
  const target = handoverEvidencePath(pdHome, evidence.workspaceDir, evidence.operationId);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(evidence, null, 2) + '\n');
    } finally {
      fs.closeSync(fd);
    }
    try {
      // Write-once, ATOMICALLY: link() fails with EEXIST instead of
      // replacing — rename() would silently overwrite a concurrently
      // published document (PRI-1282 review P1-6).
      fs.linkSync(tmp, target);
    } catch (linkError) {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      if (errnoOf(linkError) === 'EEXIST') {
        // An existing document is accepted ONLY when its FULL immutable
        // identity is this operation's: schemaVersion + kind + operationId
        // + workspaceDir are already proven by readHandoverEvidence's field
        // check; outcome and the final ownership identity (status +
        // generation) must also match — a same-named different-identity
        // document is a conflict, never a no-op (PRI-1282 review r4 §6.1).
        // startedAt/completedAt/steps are NOT part of the identity: a
        // legitimate crash-retry of the SAME operation records its own
        // timestamps.
        const existing = readHandoverEvidence(pdHome, evidence.workspaceDir, evidence.operationId);
        const generationOf = (doc: HandoverEvidence): number =>
          doc.finalOwnership.status === 'manifest_unreadable' ? -1 : doc.finalOwnership.generation;
        if (existing !== null
          && existing.kind === evidence.kind
          && existing.outcome === evidence.outcome
          && existing.finalOwnership.status === evidence.finalOwnership.status
          && generationOf(existing) === generationOf(evidence)) {
          return { ok: true, path: target, reason: 'already_exists' };
        }
        return { ok: false, path: target, reason: 'evidence_identity_conflict' };
      }
      throw linkError;
    }
    fs.unlinkSync(tmp);
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
    // PRI-1282 review P1-6: the document must BE this operation's evidence
    // for THIS workspace — a field check, not just path keying (path keying
    // alone let a colliding wskey satisfy a foreign workspace's resume).
    if (parsed.operationId !== operationId || parsed.workspaceDir !== canonicalDir) return null;
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

// ─── Commit intent (crash recovery, PRI-1282 review) ────────────────────────

/**
 * The persisted commit INTENT written BEFORE the CAS flip: the steady-state
 * `service_host_owned` marker deliberately clears `operationId`, so a run
 * killed between the flip and the evidence write would otherwise be
 * unattributable and unresumable. The intent is the auditable "this
 * operation committed generation N" fact the resume path verifies against
 * workspace + operationId + committed generation.
 *
 * Lifecycle / versioning policy (PRI-1282 review — the intent file IS
 * persisted state and must be declared): one `<opId>.intent.json` per
 * operation lives next to that operation's evidence document under
 * `<pdHome>/service/handover/<wskey>/`; it is retained with the evidence
 * directory for audit, and `schemaVersion` (`pd.service-handover-intent.v1`)
 * is the compatibility contract — a reader ignores files whose
 * schemaVersion it does not know, and a format change bumps the suffix
 * rather than mutating in place. The intent is process EVIDENCE, never an
 * ownership authority: deleting it only loses resumability attribution,
 * never ownership (the install manifest stays the single source).
 */
export interface HandoverCommitIntent {
  schemaVersion: typeof HANDOVER_INTENT_SCHEMA;
  kind: 'handover';
  operationId: string;
  workspaceDir: string;
  preparingGeneration: number;
  committedGeneration: number;
  writtenAt: string;
}

export function handoverIntentPath(pdHome: string, canonicalDir: string, operationId: string): string {
  return path.join(pdHome, 'service', 'handover', workspaceEvidenceKey(canonicalDir), `${operationId}.intent.json`);
}

export function writeHandoverIntent(intent: HandoverCommitIntent, pdHome: string): { ok: boolean; path: string; reason?: string } {
  if (!isSafeOperationId(intent.operationId)) {
    return { ok: false, path: handoverIntentPath(pdHome, intent.workspaceDir, 'invalid'), reason: 'operation_id_invalid' };
  }
  const target = handoverIntentPath(pdHome, intent.workspaceDir, intent.operationId);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(intent, null, 2) + '\n');
    } finally {
      fs.closeSync(fd);
    }
    try {
      // Atomic no-replace publish, same posture as the evidence document.
      fs.linkSync(tmp, target);
    } catch (linkError) {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      if (errnoOf(linkError) === 'EEXIST') {
        // Full-identity compare (PRI-1282 r4 §6.2): kind/schemaVersion are
        // proven by the reader's field check, but the operation AND the
        // generation pair must also match — an operationId reused across
        // generations is a conflict, never an idempotent replay.
        const existing = readHandoverIntent(pdHome, intent.workspaceDir, intent.operationId);
        if (existing !== null
          && existing.workspaceDir === intent.workspaceDir
          && existing.preparingGeneration === intent.preparingGeneration
          && existing.committedGeneration === intent.committedGeneration) {
          return { ok: true, path: target, reason: 'already_exists' };
        }
        return { ok: false, path: target, reason: 'intent_identity_conflict' };
      }
      throw linkError;
    }
    fs.unlinkSync(tmp);
    return { ok: true, path: target };
  } catch (error) {
    return { ok: false, path: target, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Read + field-validate a persisted commit intent (null = absent/untrusted). */
export function readHandoverIntent(pdHome: string, canonicalDir: string, operationId: string): HandoverCommitIntent | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(handoverIntentPath(pdHome, canonicalDir, operationId), 'utf8'));
    if (!isJsonObject(parsed)) return null;
    if (parsed.schemaVersion !== HANDOVER_INTENT_SCHEMA || parsed.kind !== 'handover') return null;
    if (!isNonEmptyString(parsed.operationId) || parsed.operationId !== operationId) return null;
    if (!isNonEmptyString(parsed.workspaceDir) || !isNonEmptyString(parsed.writtenAt)) return null;
    if (typeof parsed.preparingGeneration !== 'number' || !Number.isInteger(parsed.preparingGeneration) || parsed.preparingGeneration < 0) return null;
    if (typeof parsed.committedGeneration !== 'number' || !Number.isInteger(parsed.committedGeneration) || parsed.committedGeneration < 1) return null;
    return {
      schemaVersion: HANDOVER_INTENT_SCHEMA,
      kind: 'handover',
      operationId: parsed.operationId,
      workspaceDir: parsed.workspaceDir,
      preparingGeneration: parsed.preparingGeneration,
      committedGeneration: parsed.committedGeneration,
      writtenAt: parsed.writtenAt,
    };
  } catch {
    return null;
  }
}

// ─── Rollback intent (crash recovery, PRI-1282 review r4 §8) ────────────────
//
// The rollback mirror of the handover commit intent: persisted AFTER
// begin_rollback and BEFORE the complete_rollback CAS, it binds
// operationId + workspace + pending/committed generations so a run killed
// between the CAS and the evidence write is resumable — `--resume` then
// only rewrites the missing evidence, never re-flips ownership.

const ROLLBACK_INTENT_SCHEMA = 'pd.service-rollback-intent.v1';

export interface RollbackCommitIntent {
  schemaVersion: typeof ROLLBACK_INTENT_SCHEMA;
  kind: 'rollback';
  operationId: string;
  workspaceDir: string;
  /** Generation of the rollback_pending marker this intent belongs to. */
  pendingGeneration: number;
  /** Generation complete_rollback commits (pendingGeneration + 1). */
  committedGeneration: number;
  writtenAt: string;
}

export function rollbackIntentPath(pdHome: string, canonicalDir: string, operationId: string): string {
  return path.join(pdHome, 'service', 'handover', workspaceEvidenceKey(canonicalDir), `${operationId}.rollback-intent.json`);
}

export function writeRollbackIntent(intent: RollbackCommitIntent, pdHome: string): { ok: boolean; path: string; reason?: string } {
  if (!isSafeOperationId(intent.operationId)) {
    return { ok: false, path: rollbackIntentPath(pdHome, intent.workspaceDir, 'invalid'), reason: 'operation_id_invalid' };
  }
  const target = rollbackIntentPath(pdHome, intent.workspaceDir, intent.operationId);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(intent, null, 2) + '\n');
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(tmp, target); // atomic no-replace publish
    } catch (linkError) {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      if (errnoOf(linkError) === 'EEXIST') {
        const existing = readRollbackIntent(pdHome, intent.workspaceDir, intent.operationId);
        if (existing !== null
          && existing.workspaceDir === intent.workspaceDir
          && existing.pendingGeneration === intent.pendingGeneration
          && existing.committedGeneration === intent.committedGeneration) {
          return { ok: true, path: target, reason: 'already_exists' };
        }
        return { ok: false, path: target, reason: 'intent_identity_conflict' };
      }
      throw linkError;
    }
    fs.unlinkSync(tmp);
    return { ok: true, path: target };
  } catch (error) {
    return { ok: false, path: target, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Read + field-validate a persisted rollback intent (null = absent/untrusted). */
export function readRollbackIntent(pdHome: string, canonicalDir: string, operationId: string): RollbackCommitIntent | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(rollbackIntentPath(pdHome, canonicalDir, operationId), 'utf8'));
    if (!isJsonObject(parsed)) return null;
    if (parsed.schemaVersion !== ROLLBACK_INTENT_SCHEMA || parsed.kind !== 'rollback') return null;
    if (!isNonEmptyString(parsed.operationId) || parsed.operationId !== operationId) return null;
    if (!isNonEmptyString(parsed.workspaceDir) || !isNonEmptyString(parsed.writtenAt)) return null;
    if (typeof parsed.pendingGeneration !== 'number' || !Number.isInteger(parsed.pendingGeneration) || parsed.pendingGeneration < 0) return null;
    if (typeof parsed.committedGeneration !== 'number' || !Number.isInteger(parsed.committedGeneration) || parsed.committedGeneration < 1) return null;
    return {
      schemaVersion: ROLLBACK_INTENT_SCHEMA,
      kind: 'rollback',
      operationId: parsed.operationId,
      workspaceDir: parsed.workspaceDir,
      pendingGeneration: parsed.pendingGeneration,
      committedGeneration: parsed.committedGeneration,
      writtenAt: parsed.writtenAt,
    };
  } catch {
    return null;
  }
}

/** Default scheduler-enabled fact probe: `pd service status` on this install. */
async function probeSchedulerEnabled(
  context: { homeDir: string },
  env: Readonly<Record<string, string | undefined>> | undefined,
): Promise<{ ok: true; registered: boolean | null; enabled: boolean | null } | { ok: false; reason: string }> {
  const status = await runSchedulerLifecycle('status', { env: env ?? process.env, trustedHomeDir: context.homeDir });
  if (!status.ok) return { ok: false, reason: status.reason };
  return { ok: true, registered: status.facts.registered, enabled: status.facts.enabled };
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
    // Same allowlist the managed adapter uses: the workspace's own
    // `apiKeyEnv` names must reach the probe child or a console-saved /
    // custom-named credential is stripped (PRI-1282 review).
    credentialEnvAllowlist: readConfigCredentialEnvNames(args.workspaceDir),
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

/**
 * One REAL worker cycle through the SAME managed adapter the scheduler's
 * run-once uses (PRI-1282 review): entry resolution, allowlist env build
 * (workspace credential names included), spawn, task-progress diffing,
 * JSON/workspace/mode validation and liveness normalization are all the
 * adapter's verified contract — the handover never trusts raw stdout.
 */
async function runManagedOpenClawCycle(args: {
  homeDir: string;
  workspaceDir: string;
  invocationId: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ ok: true; result: AdapterCycleResult } | { ok: false; reason: string; nextAction: string }> {
  const identity = resolveCoordinatorInstallIdentity(process.env, { trustedHomeDir: args.homeDir });
  if (!identity.ok) return { ok: false, reason: `install_identity_unresolved:${identity.reason}`, nextAction: identity.nextAction };
  const result = await createOpenClawWorkerAdapter().executeOnce({
    workspaceDir: args.workspaceDir,
    activeRelease: readActiveReleaseFacts(identity.identity.activeRecordPath),
    invocationId: args.invocationId,
    timeoutMs: args.timeoutMs,
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
    identity: identity.identity,
    inheritedEnv: process.env,
  });
  return { ok: true, result };
}

/** The cycle outcomes that prove a first managed cycle actually worked. */
function verifiedCycleOutcome(result: AdapterCycleResult): boolean {
  return result.cycleOutcome === 'cycle_completed' || result.cycleOutcome === 'cycle_completed_without_business_progress';
}

/**
 * The consuming Worker child holds the per-workspace run mutex for its
 * whole cycle — the lock survives the coordinator's own death because the
 * CHILD is the recorded holder. Before launching (or rolling back around)
 * a worker we probe that mutex: a live holder means the old cycle is still
 * running and overlapping it would create two consumers on one workspace
 * (PRI-1282 review). Returns the blocked/failed verdict or null to proceed.
 */
function refuseWhileWorkerRunning(
  context: { pdHome: string; workspaceDir: string },
  operationId: string,
): { ok: false; outcome: 'blocked'; reason: string; nextAction: string; operationId: string } | null {
  const probe = probeServiceRunLockState(workspaceServiceRunLockPath(context.pdHome, context.workspaceDir));
  if (probe.state === 'free') return null;
  if (probe.state === 'held') {
    return {
      ok: false,
      outcome: 'blocked',
      reason: 'service_host_worker_still_running',
      nextAction: 'A worker cycle is still consuming this workspace (its process holds the workspace run mutex); wait for it to finish — cycles are bounded — and rerun the operation.',
      operationId,
    };
  }
  return {
    ok: false,
    outcome: 'blocked',
    reason: `service_host_worker_lock_unverifiable:${probe.detail ?? 'unknown'}`,
    nextAction: 'The workspace run mutex could not be verified; refusing to risk overlapping a still-running worker. Repair or remove the stale lock under <pdHome>/service/workspace-runs/ and rerun.',
    operationId,
  };
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
  // operationId enters file paths and CAS records — a filesystem-safe
  // whitelist at the command boundary, before anything keys off it
  // (PRI-1282 review P1-6).
  if (options.resumeOperationId !== undefined && !isSafeOperationId(options.resumeOperationId)) {
    return { ok: false, outcome: 'blocked', reason: 'operation_id_invalid', nextAction: 'operationId may only contain letters, digits, dots, underscores and hyphens (1-128 chars).' };
  }
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
  // the marker. Attribution comes from EITHER the completed evidence OR the
  // commit intent the flip path persists first — a run killed between flip
  // and evidence write is resumable because the intent carries
  // workspace + operationId + committed generation (PRI-1282 review).
  // ──
  if (initial.status === 'service_host_owned') {
    const priorOp = options.resumeOperationId ?? '';
    const priorEvidence = priorOp !== '' ? readHandoverEvidence(context.pdHome, context.workspaceDir, priorOp) : null;
    const priorIntent = priorOp !== '' ? readHandoverIntent(context.pdHome, context.workspaceDir, priorOp) : null;
    // PRI-1282 review P1-6: 'completed' alone is not resumable — the
    // evidence must be THIS workspace's handover whose committed ownership
    // matches the CURRENT marker generation, else a stale/foreign document
    // could impersonate the committed run.
    const evidenceMatches = priorEvidence !== null
      && priorEvidence.kind === 'handover'
      && priorEvidence.outcome === 'completed'
      && priorEvidence.finalOwnership.status === 'service_host_owned'
      && priorEvidence.finalOwnership.generation === initial.generation;
    const intentMatches = priorIntent !== null
      && priorIntent.workspaceDir === context.workspaceDir
      && priorIntent.committedGeneration === initial.generation;
    if (priorOp !== '' && (evidenceMatches || intentMatches)) {
      record('already_service_host_owned', intentMatches && priorEvidence?.outcome !== 'completed' ? 'verify_only_continuation_by_intent' : 'verify_only_continuation');
      // A crashed run may have left its Worker child alive in its own
      // process group — the child still holds the workspace run mutex, so
      // resuming without this probe would overlap two consumers (PRI-1282).
      const stillRunning = refuseWhileWorkerRunning(context, priorOp);
      if (stillRunning !== null) return stillRunning;
      // The re-verification cycle joins the same install-level run mutex as
      // the scheduler and rollback — a concurrent managed run must not
      // overlap this verification (PRI-1282 review).
      const contLock = acquireServiceRunLock(context.pdHome);
      if (!contLock.ok) {
        return { ok: false, outcome: 'blocked', reason: `service_run_in_progress:${contLock.kind}`, nextAction: 'A managed run-once is currently executing; wait for it to finish and rerun `pd service handover --resume` to re-verify.', operationId: priorOp };
      }
      try {
        const cycleCont = await runManagedOpenClawCycle({ homeDir: context.homeDir, workspaceDir: context.workspaceDir, invocationId: priorOp, timeoutMs: Math.max(stepTimeoutMs, 10 * 60_000), ...(options.signal !== undefined ? { signal: options.signal } : {}) });
        record('worker_cycle', cycleCont.ok ? `${cycleCont.result.cycleOutcome}${cycleCont.result.workerMode !== undefined ? `(${cycleCont.result.workerMode})` : ''}` : cycleCont.reason);
        if (!cycleCont.ok || !verifiedCycleOutcome(cycleCont.result)) {
          return {
            ok: false,
            outcome: 'failed',
            reason: `first_cycle_unverified:${cycleCont.ok ? cycleCont.result.cycleOutcome : cycleCont.reason}`,
            nextAction: 'The workspace is service_host_owned but the verification cycle did not complete; rerun `pd service handover --resume` to re-verify, or `pd service rollback` to return it to the Gateway.',
            operationId: priorOp,
            ...(cycleCont.ok && cycleCont.result.reason !== undefined ? { detail: cycleCont.result.reason } : {}),
          };
        }
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
        if (!writtenCont.ok) {
          return { ok: false, outcome: 'failed', reason: `handover_evidence_write_failed:${writtenCont.reason ?? 'io'}`, nextAction: 'The verification cycle passed but the evidence could not be persisted; rerun `pd service handover --resume` after fixing the write failure.', operationId: priorOp };
        }
        return {
          ok: true,
          outcome: 'completed',
          operationId: priorOp,
          workspaceDir: context.workspaceDir,
          generation: ownershipAfter.status === 'service_host_owned' ? ownershipAfter.generation : 0,
          readiness: 'ready',
          quiesceAck: { operationId: priorOp, generation: priorEvidence?.finalOwnership.status === 'service_host_owned' ? priorEvidence.finalOwnership.generation : (priorIntent?.committedGeneration ?? 0), outcome: 'verified_by_prior_evidence', startedVia: 'prior_run' },
          workerCycle: { mode: cycleCont.result.workerMode ?? cycleCont.result.cycleOutcome, exitCode: cycleCont.result.worker.exitCode, evidencePath: writtenCont.path },
          evidencePath: writtenCont.path,
        };
      } finally {
        releaseServiceRunLock(contLock.handle);
      }
    }
    return {
      ok: false,
      outcome: 'blocked',
      reason: 'already_service_host_owned',
      nextAction: 'This workspace already belongs to the Service Host. Pass --resume <operationId> of the committed handover to re-verify, or use pd service rollback to return it to the legacy consumer.',
    };
  }
  // ── Abort handling FIRST (PRI-1282 review P1-5): binding verification
  // cannot gate an operator's abort — a workspace stuck in
  // handover_preparing with a missing/broken OpenClaw binding would
  // otherwise be unrecoverable by --abort. The abort must also name the
  // EXACT in-flight operation: a marker's operationId no longer silently
  // overrides an explicit --resume, and generation fencing keeps a stale
  // caller from aborting a newer generation's work.
  const markerOp = initial.status === 'handover_preparing' ? initial.record.operationId : undefined;
  if (options.resumeOperationId !== undefined && markerOp !== undefined && options.resumeOperationId !== markerOp) {
    return {
      ok: false,
      outcome: 'blocked',
      reason: 'operation_id_mismatch',
      nextAction: `The in-flight handover is ${markerOp}; --resume must name that exact operation (or omit --resume to adopt it).`,
      operationId: markerOp ?? undefined,
    };
  }
  if (options.abort === true) {
    const target = markerOp;
    if (target === undefined || target === null) {
      return { ok: false, outcome: 'blocked', reason: 'abort_requires_operation', nextAction: 'No handover_preparing record exists for this workspace; nothing to abort.' };
    }
    const abortedTransition = transitionWorkspaceBackgroundExecution({
      manifestPath: context.manifestPath, workspaceDir: context.workspaceDir, kind: 'abort_handover', operationId: target, expectedGeneration: initial.generation,
    });
    if (!abortedTransition.ok) return { ok: false, outcome: 'failed', reason: `abort_failed:${abortedTransition.reason}`, nextAction: abortedTransition.nextAction ?? 'Inspect the manifest ownership record.', detail: abortedTransition.message };
    record('aborted', 'legacy_owned');
    return { ok: false, outcome: 'aborted', reason: 'handover_aborted_by_operator', nextAction: 'The workspace is back to legacy ownership; the Gateway consumer is the sole owner.', operationId: target };
  }
  // PRI-1282 review r4 §5: an explicit --resume may ONLY continue a real
  // in-flight operation. With no handover_preparing marker there is nothing
  // to resume — the command must NOT silently mint a new operationId out of
  // the name the operator passed (and a completed operation can never
  // re-enter the execution flow).
  if (options.resumeOperationId !== undefined && markerOp === undefined) {
    return {
      ok: false,
      outcome: 'blocked',
      reason: 'no_resumable_operation',
      nextAction: `No in-flight handover exists for this workspace to resume as '${options.resumeOperationId}'; omit --resume to start a new handover.`,
      operationId: options.resumeOperationId,
    };
  }
  const binding = collectHostWorkspaceClaimsFor(context.workspaceDir, context.homeDir, options.env);
  if (binding.bindingUnverifiable !== null) {
    return {
      ok: false,
      outcome: 'blocked',
      reason: `foreign_owner_unverifiable:${binding.bindingUnverifiable}`,
      nextAction: 'A host binding file could not be read or parsed, so cross-host ownership cannot be verified; repair the binding file(s) and retry (fail-closed per §9.1.8).',
    };
  }
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
  const resumeOp = markerOp;

  // ── 1.5. Scheduler gate (PRI-1282 review): handing ownership to the
  // Service Host while no enabled OS trigger exists would leave the
  // workspace consumed by NOBODY. Verified BEFORE the ownership-changing
  // transition so a refusal keeps the workspace cleanly legacy-owned (and
  // never blocks a recovery --abort); the command never enables the trigger
  // on the operator's behalf. ──
  const schedulerStatus = options.probes?.schedulerStatus !== undefined
    ? await options.probes.schedulerStatus()
    : await probeSchedulerEnabled(context, options.env);
  if (!schedulerStatus.ok) {
    return {
      ok: false,
      outcome: 'blocked',
      reason: `service_host_scheduler_status_unavailable:${schedulerStatus.reason}`,
      nextAction: 'The Service Host scheduler status could not be determined; resolve that first (the workspace stays legacy-owned and untouched).',
    };
  }
  if (schedulerStatus.registered !== true || schedulerStatus.enabled !== true) {
    return {
      ok: false,
      outcome: 'blocked',
      reason: 'service_host_scheduler_not_enabled',
      nextAction: 'Install and enable the Service Host scheduler for this install first (`pd service install`, `pd service enable`); without an enabled trigger a handed-over workspace is consumed by nobody, so the workspace stays legacy-owned.',
    };
  }
  record('scheduler_trigger', 'registered_and_enabled');

  // operationId comes from the in-flight marker alone now — an explicit
  // --resume was already proven equal to it above, and a fresh operation
  // mints a fresh id. A marker name is never silently replaced.
  const operationId = resumeOp ?? options.probes?.mintOperationId?.('handover') ?? `handover-${crypto.randomUUID()}`;
  if (!isSafeOperationId(operationId)) {
    return { ok: false, outcome: 'blocked', reason: 'operation_id_invalid', nextAction: 'operationId may only contain letters, digits, dots, underscores and hyphens (1-128 chars).', operationId };
  }
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
    const rollback = transitionWorkspaceBackgroundExecution({ manifestPath: context.manifestPath, workspaceDir: context.workspaceDir, kind: 'abort_handover', operationId, expectedGeneration: preparingGeneration });
    record('readiness', 'unavailable', readiness.reason);
    if (!rollback.ok) {
      return { ok: false, outcome: 'failed', reason: `readiness_failed_and_abort_failed:${readiness.reason}|${rollback.reason}`, nextAction: 'The workspace is STUCK in handover_preparing — resolve manually (pd service handover --abort).', operationId, detail: readiness.nextAction };
    }
    return { ok: false, outcome: 'blocked', reason: `readiness_not_met:${readiness.reason}`, nextAction: `${readiness.nextAction} The workspace was restored to legacy ownership.`, operationId };
  }
  const readinessJson = parseWorkerJson(readiness.result.stdout);
  const readinessMode = typeof readinessJson?.mode === 'string' ? readinessJson.mode : 'unknown';
  // PRI-1282 review P2-1: 'ready' must be corroborated by a clean process
  // outcome — a timed-out/cancelled/failed child that managed to print
  // mode:'ready' before dying is not evidence of readiness.
  const readinessProcessFailed = readiness.result.exitCode !== 0
    || readiness.result.timedOut === true
    || readiness.result.cancelled === true
    || readiness.result.spawnError !== undefined
    || readiness.result.stdoutTruncated === true
    // close-observed is required: a worker whose stdout was captured but
    // whose process never provably terminated cannot attest readiness
    // (PRI-1282 r4 §10).
    || readiness.result.terminationConfirmed !== true;
  // The readiness document must attest THIS workspace — an out-of-band or
  // stale 'ready' printed for another dir is not this workspace's proof.
  const readinessWorkspaceMismatch = typeof readinessJson?.workspaceDir === 'string'
    && path.resolve(readinessJson.workspaceDir) !== context.workspaceDir;
  if (readinessMode !== 'ready' || readinessProcessFailed || readinessWorkspaceMismatch) {
    const processDetail = readinessProcessFailed
      ? `exitCode=${readiness.result.exitCode} timedOut=${readiness.result.timedOut} cancelled=${readiness.result.cancelled} stdoutTruncated=${readiness.result.stdoutTruncated} terminationConfirmed=${readiness.result.terminationConfirmed ?? false}${readiness.result.spawnError !== undefined ? ` spawnError=${readiness.result.spawnError}` : ''}`
      : '';
    const rollback = transitionWorkspaceBackgroundExecution({ manifestPath: context.manifestPath, workspaceDir: context.workspaceDir, kind: 'abort_handover', operationId, expectedGeneration: preparingGeneration });
    record('readiness', readinessProcessFailed ? `process_failed(${processDetail})` : readinessMode, readiness.result.stdout.slice(0, 400));
    if (!rollback.ok) {
      return { ok: false, outcome: 'failed', reason: `readiness_not_ready_and_abort_failed:${readinessMode}|${rollback.reason}`, nextAction: 'The workspace is STUCK in handover_preparing — resolve manually (pd service handover --abort).', operationId };
    }
    return {
      ok: false,
      outcome: 'blocked',
      reason: readinessWorkspaceMismatch
        ? 'openclaw_worker_readiness_workspace_mismatch'
        : readinessProcessFailed ? `openclaw_worker_readiness_process:${readinessMode}` : `openclaw_worker_readiness:${readinessMode}`,
      nextAction: 'Fix the failing readiness checks (declaration / evidence port / credentials) and retry; the workspace was restored to legacy ownership.',
      operationId,
      detail: readinessJson ?? { exitCode: readiness.result.exitCode, timedOut: readiness.result.timedOut, cancelled: readiness.result.cancelled },
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
    // PRI-1282 review P2-2: the ack must bind THIS operation's state and
    // THIS workspace too — an ack written for handover_preparing of another
    // workspace (or a stale-marker state) is not this operation's evidence.
    if (ack !== null
      && ack.operationId === operationId
      && ack.generation === preparingGeneration
      && ack.state === 'handover_preparing'
      // PRI-1282 r4 §11: compare REAL directory identity, not lexical
      // spelling — an ack persisted under a symlinked alias spelling must
      // still bind this workspace (and a foreign spelling must not).
      && ackWorkspaceMatches(ack.workspaceDir, context.workspaceDir)
      && ack.outcome === 'quiesced'
      && ack.inFlightCycles === 0) break;
    await wait(2_000);
  }
  const ackDefect: string | null = ack === null
    ? 'gateway_quiesce_ack_absent'
    : ack.operationId !== operationId
      ? 'gateway_quiesce_ack_operation_mismatch'
      : ack.generation !== preparingGeneration
        ? 'gateway_quiesce_ack_generation_mismatch'
        : ack.state !== 'handover_preparing'
          ? `gateway_quiesce_ack_state_mismatch:${ack.state}`
          : !ackWorkspaceMatches(ack.workspaceDir, context.workspaceDir)
            ? 'gateway_quiesce_ack_workspace_mismatch'
            : ack.outcome !== 'quiesced'
              ? `gateway_quiesce_ack_not_quiesced:${ack.outcome}`
              : null;
  if (ackDefect !== null) {
    const rollback = transitionWorkspaceBackgroundExecution({ manifestPath: context.manifestPath, workspaceDir: context.workspaceDir, kind: 'abort_handover', operationId, expectedGeneration: preparingGeneration });
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

  // ── 5-7. Commit section — under the SAME install-level run mutex the
  // scheduler and rollback serialize on (PRI-1282 review): holding it from
  // before the flip until the first worker child exits means a rollback can
  // never flip ownership back while this cycle is still consuming, and a
  // managed run-once sees `already_running` instead of overlapping us. A
  // bare `pd openclaw worker --once` stays lock-free BY DESIGN — it is the
  // leaf consumer the orchestrators drive; serializing it too would
  // self-deadlock every launch below. ──
  const runLock = acquireServiceRunLock(context.pdHome);
  if (!runLock.ok) {
    return {
      ok: false,
      outcome: 'blocked',
      reason: `service_run_in_progress:${runLock.kind}`,
      nextAction: 'A managed run-once or rollback is currently executing; wait for it to finish and rerun the handover — the workspace stays handover_preparing and this operationId resumes.',
      operationId,
    };
  }
  try {
    // The workspace mutex still held means a Worker child outlived its
    // coordinator — refuse before flipping rather than overlap it.
    const stillRunning = refuseWhileWorkerRunning(context, operationId);
    if (stillRunning !== null) return stillRunning;
    // Persist the commit intent BEFORE the flip: the steady-state marker
    // clears operationId, so a crash between flip and evidence write would
    // leave the commit unattributable without it (PRI-1282 review).
    const intentWritten = writeHandoverIntent({
      schemaVersion: HANDOVER_INTENT_SCHEMA,
      kind: 'handover',
      operationId,
      workspaceDir: context.workspaceDir,
      preparingGeneration,
      committedGeneration: preparingGeneration + 1,
      writtenAt: nowIso(),
    }, context.pdHome);
    if (!intentWritten.ok) {
      return { ok: false, outcome: 'failed', reason: `handover_intent_write_failed:${intentWritten.reason ?? 'io'}`, nextAction: 'The commit intent could not be persisted; the workspace stays handover_preparing — fix the write failure and rerun (the operation resumes).', operationId };
    }

    // ── 4b. Scheduler re-check (PRI-1282 r4 §9): the §1.5 gate proved the
    // trigger was enabled at command start, but `pd service disable` may
    // have landed between then and now (it serializes on the SAME install
    // lock, so an in-flight handover never overlaps a live disable — a
    // disable that completed before our lock acquisition is what this
    // catches). Re-verify immediately before the irreversible flip.
    const schedulerRecheck = options.probes?.schedulerStatus !== undefined
      ? await options.probes.schedulerStatus()
      : await probeSchedulerEnabled(context, options.env);
    if (!schedulerRecheck.ok || schedulerRecheck.registered !== true || schedulerRecheck.enabled !== true) {
      const reason = !schedulerRecheck.ok
        ? `service_host_scheduler_status_unavailable:${schedulerRecheck.reason}`
        : 'service_host_scheduler_not_enabled';
      const rollback = transitionWorkspaceBackgroundExecution({
        manifestPath: context.manifestPath, workspaceDir: context.workspaceDir, kind: 'abort_handover', operationId, expectedGeneration: preparingGeneration,
      });
      record('cas_flip', 'aborted', `scheduler_recheck:${reason}${rollback.ok ? '' : ` (abort_handover failed: ${rollback.ok === false ? rollback.reason : '?'})`}`);
      return {
        ok: false,
        outcome: 'blocked',
        reason,
        nextAction: 'The Service Host scheduler was disabled or became unreadable during the handover; the preparing state was rolled back — enable it (`pd service enable`) and rerun `pd service handover`.',
        operationId,
      };
    }

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

    // ── 6. One real worker cycle through the SAME managed adapter the
    // scheduler drives — its contract already validates spawn, exit code,
    // workspace match and worker mode, so a failed/garbage first cycle is
    // never recorded as success (PRI-1282 review). ──
    const cycle = await runManagedOpenClawCycle({ homeDir: context.homeDir, workspaceDir: context.workspaceDir, invocationId: operationId, timeoutMs: Math.max(stepTimeoutMs, 10 * 60_000), ...(options.signal !== undefined ? { signal: options.signal } : {}) });
    record('worker_cycle', cycle.ok ? `${cycle.result.cycleOutcome}${cycle.result.workerMode !== undefined ? `(${cycle.result.workerMode})` : ''}` : cycle.reason);
    if (!cycle.ok || !verifiedCycleOutcome(cycle.result)) {
      // Ownership is committed but the FIRST cycle is not verified —
      // reported as a resumable failure, NEVER as a completed handover.
      return {
        ok: false,
        outcome: 'failed',
        reason: `first_cycle_unverified:${cycle.ok ? cycle.result.cycleOutcome : cycle.reason}`,
        nextAction: 'Ownership already flipped to the Service Host but the first managed cycle did not verify; fix the worker problem and rerun `pd service handover --resume <operationId>` to re-verify, or `pd service rollback` to return the workspace to the Gateway.',
        operationId,
        detail: cycle.ok ? (cycle.result.reason ?? cycle.result.worker.stderrTail ?? undefined) : cycle.nextAction,
      };
    }

    // ── 6b. Final ownership re-verification (PRI-1282 r4 §7): the worker
    // cycle verified, but 'completed' ALSO requires the authoritative
    // marker to still prove THIS operation's commit — status
    // service_host_owned at exactly the committed generation, backed by the
    // persisted commit intent bound to this operationId. A flipped-away or
    // re-generated marker means something else owns the workspace now —
    // report a resumable verification failure, never a completed handover.
    const finalOwnership = readWorkspaceBackgroundOwnership({ manifestPath: context.manifestPath, workspaceDir: context.workspaceDir });
    const persistedIntent = readHandoverIntent(context.pdHome, context.workspaceDir, operationId);
    const verificationDefect: string | null =
      finalOwnership.status !== 'service_host_owned'
        ? `final_ownership_status:${finalOwnership.status}`
        : finalOwnership.generation !== preparingGeneration + 1
          ? `final_ownership_generation:${finalOwnership.generation}!=${preparingGeneration + 1}`
          : persistedIntent === null
            ? 'commit_intent_absent'
            : persistedIntent.operationId !== operationId || persistedIntent.committedGeneration !== finalOwnership.generation
              ? 'commit_intent_mismatch'
              : null;
    if (verificationDefect !== null) {
      return {
        ok: false,
        outcome: 'failed',
        reason: `final_ownership_verification_failed:${verificationDefect}`,
        nextAction: 'The first managed cycle verified but the final ownership state cannot be proven to be THIS operation\'s commit; rerun `pd service handover --resume` with this operationId to re-verify, or `pd service rollback` to return the workspace to the Gateway.',
        operationId,
      };
    }
    record('final_ownership_verification', 'verified', `generation=${preparingGeneration + 1}`);

    // ── 7. Completion evidence (write-once, operationId keyed). The
    // handover only reports completion when BOTH the verified cycle and
    // this write landed. ──
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
    if (!written.ok) {
      return { ok: false, outcome: 'failed', reason: `handover_evidence_write_failed:${written.reason ?? 'io'}`, nextAction: 'The first managed cycle verified but the completion evidence could not be persisted; fix the write failure and rerun `pd service handover --resume <operationId>`.', operationId };
    }
    return {
      ok: true,
      outcome: 'completed',
      operationId,
      workspaceDir: context.workspaceDir,
      generation: finalOwnership.status === 'service_host_owned' ? finalOwnership.generation : (flip.ok ? flip.record.generation : preparingGeneration),
      readiness: 'ready',
      quiesceAck: { operationId: ack.operationId ?? operationId, generation: ack.generation, outcome: ack.outcome, startedVia: ack.writer.startedVia },
      workerCycle: { mode: cycle.result.workerMode ?? cycle.result.cycleOutcome, exitCode: cycle.result.worker.exitCode, evidencePath: written.path },
      evidencePath: written.path,
    };
  } finally {
    releaseServiceRunLock(runLock.handle);
  }
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

export interface RollbackRunOptions extends HandoverContextInput {
  /** Continue a named rollback operation (PRI-1282 r4 §8). */
  readonly resumeOperationId?: string;
}

export async function runWorkspaceRollback(workspaceDir: string, options: RollbackRunOptions): Promise<RollbackRunResult> {
  const context = establishHandoverContext(workspaceDir, options);
  if (!context.ok) return { ok: false, outcome: 'blocked', reason: context.reason, nextAction: context.nextAction };
  if (options.resumeOperationId !== undefined && !isSafeOperationId(options.resumeOperationId)) {
    return { ok: false, outcome: 'blocked', reason: 'operation_id_invalid', nextAction: 'operationId may only contain letters, digits, dots, underscores and hyphens (1-128 chars).' };
  }
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
    const resumeOp = initial.status === 'rollback_pending' ? initial.record.operationId : undefined;

    // ── --resume arbitration (PRI-1282 r4 §5/§8): an explicit resume may
    // only continue a REAL in-flight or already-committed operation.
    if (options.resumeOperationId !== undefined && resumeOp !== undefined && options.resumeOperationId !== resumeOp) {
      return {
        ok: false,
        outcome: 'blocked',
        reason: 'operation_id_mismatch',
        nextAction: `The in-flight rollback is ${resumeOp}; --resume must name that exact operation (or omit --resume to adopt it).`,
        operationId: resumeOp ?? undefined,
      };
    }
    if (options.resumeOperationId !== undefined && resumeOp === undefined) {
      const resumeIntent = readRollbackIntent(context.pdHome, context.workspaceDir, options.resumeOperationId);
      const canCompleteEvidence = initial.status === 'legacy_owned'
        && resumeIntent !== null
        && resumeIntent.workspaceDir === context.workspaceDir
        && resumeIntent.committedGeneration === initial.generation;
      if (!canCompleteEvidence) {
        return {
          ok: false,
          outcome: 'blocked',
          reason: 'no_resumable_operation',
          nextAction: `No in-flight or committed-but-unevidenced rollback exists for this workspace to resume as '${options.resumeOperationId}'.`,
          operationId: options.resumeOperationId,
        };
      }
      // PRI-1282 r5 F6 — resume of an ALREADY-EVIDENCED operation returns
      // the ORIGINAL recorded conclusion, never a fabricated re-verification:
      // if the first run persisted evidence (including its real
      // gateway_resumption observation) and then crashed, the stored
      // document is the answer.
      const existingEvidence = readHandoverEvidence(context.pdHome, context.workspaceDir, options.resumeOperationId);
      if (existingEvidence !== null && existingEvidence.kind === 'rollback') {
        if (existingEvidence.outcome !== 'completed') {
          return {
            ok: false,
            outcome: 'failed',
            reason: `prior_operation_outcome:${existingEvidence.outcome}`,
            nextAction: 'The persisted evidence records this operation did not complete; inspect the evidence document, then run a NEW rollback.',
            operationId: options.resumeOperationId,
          };
        }
        const observedStep = existingEvidence.steps.find((entry) => entry.step === 'gateway_resumption');
        return {
          ok: true,
          outcome: 'completed',
          operationId: options.resumeOperationId,
          workspaceDir: context.workspaceDir,
          generation: initial.generation,
          gatewayResumption: observedStep?.outcome === 'observed' ? 'observed' : 'not_verified_gateway_not_running',
          evidencePath: handoverEvidencePath(context.pdHome, context.workspaceDir, options.resumeOperationId),
        };
      }
      // Evidence-only continuation: ownership already returned to the
      // Gateway at exactly the intent's committed generation — rewrite ONLY
      // the missing evidence, never re-run the transition (§8.6).
      record('resume', 'evidence_only_continuation', `generation=${initial.generation}`);
      const evidence: HandoverEvidence = {
        schemaVersion: HANDOVER_EVIDENCE_SCHEMA,
        kind: 'rollback',
        operationId: options.resumeOperationId,
        workspaceDir: context.workspaceDir,
        startedAt,
        completedAt: nowIso(),
        outcome: 'completed',
        steps,
        finalOwnership: initial,
      };
      const written = writeHandoverEvidence(evidence, context.pdHome);
      if (!written.ok) {
        return {
          ok: false,
          outcome: 'failed',
          reason: `rollback_evidence_write_failed:${written.reason ?? 'io'}`,
          nextAction: 'Ownership already returned to the Gateway but the rollback evidence still cannot be persisted; fix the write failure and rerun `pd service rollback --resume` with this operationId.',
          operationId: options.resumeOperationId,
        };
      }
      return {
        ok: true,
        outcome: 'completed',
        operationId: options.resumeOperationId,
        workspaceDir: context.workspaceDir,
        generation: initial.generation,
        gatewayResumption: 'not_verified_gateway_not_running',
        evidencePath: written.path,
      };
    }
    const operationId = resumeOp ?? options.probes?.mintOperationId?.('rollback') ?? `rollback-${crypto.randomUUID()}`;

    // ── 4-6. begin_rollback FIRST, then drain, then complete_rollback
    // (PRI-1282 review P1-1 — ordering, not a new lock): flipping the marker
    // to rollback_pending closes the worker gate (`service_host_owned` is
    // the only consumable state) BEFORE we wait, so a worker that starts
    // after this CAS can never begin consuming. Probing the workspace mutex
    // first left a TOCTOU window: a worker launched between the probe and
    // the CAS passed the gate and kept consuming past complete_rollback →
    // two consumers on one workspace.
    const begin = transitionWorkspaceBackgroundExecution({
      manifestPath: context.manifestPath, workspaceDir: context.workspaceDir, kind: 'begin_rollback', operationId,
    });
    if (!begin.ok) {
      return { ok: false, outcome: 'blocked', reason: `begin_rollback_failed:${begin.reason}`, nextAction: begin.nextAction ?? 'Only a service_host_owned workspace can roll back.', operationId };
    }
    record('begin_rollback', begin.changed ? 'rollback_pending' : 'idempotent_replay', `generation=${begin.record.generation}`);
    const rollbackGeneration = begin.record.generation;

    // Now that new cycles are gated out, wait for the LAST in-flight cycle
    // to finish — the workspace run mutex is held by the worker child for
    // its whole cycle, so 'free' is the honest drain proof (bounded; a
    // timeout keeps the workspace safely rollback_pending and resumable).
    const workspaceRunLockPath = workspaceServiceRunLockPath(context.pdHome, context.workspaceDir);
    const drainDeadline = Date.now() + (options.stepTimeoutMs ?? DEFAULT_ROLLBACK_DRAIN_WAIT_MS);
    for (;;) {
      const probe = probeServiceRunLockState(workspaceRunLockPath);
      if (probe.state === 'free') break;
      if (probe.state !== 'held') {
        return {
          ok: false,
          outcome: 'blocked',
          reason: `service_host_worker_lock_unverifiable:${probe.detail ?? 'unknown'}`,
          nextAction: 'The workspace run mutex could not be verified; the workspace stays rollback_pending (fail-closed) — repair the stale lock under <pdHome>/service/workspace-runs/ and rerun the rollback.',
          operationId,
        };
      }
      if (Date.now() >= drainDeadline || options.signal?.aborted === true) {
        return {
          ok: false,
          outcome: 'blocked',
          reason: 'service_host_worker_drain_timeout',
          nextAction: 'A worker cycle still holds the workspace run mutex past the drain deadline; the workspace stays rollback_pending — wait for the bounded cycle to finish and rerun the rollback.',
          operationId,
        };
      }
      await wait(2_000);
    }
    record('worker_drain', 'workspace_run_mutex_free');

    // Persist the rollback intent BEFORE the CAS (PRI-1282 r4 §8): a run
    // killed between complete_rollback and the evidence write would
    // otherwise leave the flip unattributable — --resume verifies against
    // this intent and only rewrites the missing evidence.
    const intentWritten = writeRollbackIntent({
      schemaVersion: ROLLBACK_INTENT_SCHEMA,
      kind: 'rollback',
      operationId,
      workspaceDir: context.workspaceDir,
      pendingGeneration: rollbackGeneration,
      committedGeneration: rollbackGeneration + 1,
      writtenAt: nowIso(),
    }, context.pdHome);
    if (!intentWritten.ok) {
      return { ok: false, outcome: 'failed', reason: `rollback_intent_write_failed:${intentWritten.reason ?? 'io'}`, nextAction: 'The rollback intent could not be persisted; the workspace stays rollback_pending — fix the write failure and rerun `pd service rollback --resume` with this operationId.', operationId };
    }

    const finish = transitionWorkspaceBackgroundExecution({
      manifestPath: context.manifestPath, workspaceDir: context.workspaceDir, kind: 'complete_rollback', operationId, expectedGeneration: rollbackGeneration,
    });
    if (!finish.ok) {
      return { ok: false, outcome: 'failed', reason: `complete_rollback_failed:${finish.reason}`, nextAction: 'The workspace is rollback_pending — rerun the rollback command to complete it (fail-closed, never auto-cleared).', operationId };
    }
    record('complete_rollback', 'legacy_owned', `generation=${finish.record.generation}`);

    // ── 6b. Final ownership re-verification (PRI-1282 r4 §7): 'completed'
    // requires the authoritative marker to prove THIS rollback's commit —
    // legacy_owned at exactly the intent's committed generation.
    const verifyOwnership = readWorkspaceBackgroundOwnership({ manifestPath: context.manifestPath, workspaceDir: context.workspaceDir });
    const verificationDefect: string | null =
      verifyOwnership.status !== 'legacy_owned'
        ? `final_ownership_status:${verifyOwnership.status}`
        : verifyOwnership.generation !== rollbackGeneration + 1
          ? `final_ownership_generation:${verifyOwnership.generation}!=${rollbackGeneration + 1}`
          : null;
    if (verificationDefect !== null) {
      return {
        ok: false,
        outcome: 'failed',
        reason: `final_ownership_verification_failed:${verificationDefect}`,
        nextAction: 'The rollback CAS committed but the final ownership state cannot be proven to be THIS operation\'s commit; rerun `pd service rollback --resume` with this operationId to re-verify.',
        operationId,
      };
    }
    record('final_ownership_verification', 'verified', `generation=${rollbackGeneration + 1}`);

    // ── 7-9. Observe the Gateway's resumption (bounded; honest NOT_VERIFIED
    // when the Gateway is not running — the start gate guarantees resumption
    // on its next launch, verified separately by the gate tests). ──
    let gatewayResumption: 'observed' | 'not_verified_gateway_not_running' = 'not_verified_gateway_not_running';
    const resumeDeadline = Date.now() + (options.ackWaitMs ?? DEFAULT_ROLLBACK_RESUME_WAIT_MS);
    const startedAtMs = Date.parse(startedAt);
    while (Date.now() < resumeDeadline) {
      if (options.signal?.aborted === true) break;
      const logsDir = path.join(context.workspaceDir, 'memory', 'logs');
      try {
        const logs = fs.readdirSync(logsDir).filter((name) => name.startsWith('SYSTEM_')).sort();
        for (const logName of logs.slice(-3)) {
          const text = fs.readFileSync(path.join(logsDir, logName), 'utf8');
          // PRI-1282 review P2-3: a resumption event only counts when its
          // SystemLogger timestamp is AT/AFTER this rollback started — a
          // substring hit on an older log line fabricated 'observed' from a
          // resumption that predates this rollback.
          for (const line of text.split('\n')) {
            const stamp = /^\[([^\]]+)\]\s*\[([A-Z_]+)\]/.exec(line);
            if (stamp === null || stamp[1] === undefined || stamp[2] === undefined) continue;
            const eventMs = Date.parse(stamp[1]);
            if (!Number.isFinite(eventMs) || eventMs < startedAtMs) continue;
            if (stamp[2] === 'INTERNALIZATION_CONSUMER_RESUMED' || stamp[2] === 'INTERNALIZATION_CONSUMER_STARTED') {
              gatewayResumption = 'observed';
              break;
            }
          }
          if (gatewayResumption === 'observed') break;
        }
      } catch {
        // No SystemLogger stream at all → Gateway has never run here in this
        // window; stays not_verified.
      }
      if (gatewayResumption === 'observed') break;
      await wait(3_000);
    }
    record('gateway_resumption', gatewayResumption);

    const evidence: HandoverEvidence = {
      schemaVersion: HANDOVER_EVIDENCE_SCHEMA,
      kind: 'rollback',
      operationId,
      workspaceDir: context.workspaceDir,
      startedAt,
      completedAt: nowIso(),
      outcome: 'completed',
      steps,
      finalOwnership: verifyOwnership,
    };
    const written = writeHandoverEvidence(evidence, context.pdHome);
    // PRI-1282 review P2-3: the rollback did not complete if its audit
    // record could not be persisted — the ownership flip already happened,
    // so this reports a resumable failure, never silent success.
    if (!written.ok) {
      return {
        ok: false,
        outcome: 'failed',
        reason: `rollback_evidence_write_failed:${written.reason ?? 'io'}`,
        nextAction: 'Ownership already returned to the Gateway but the rollback evidence could not be persisted; fix the write failure and rerun `pd service rollback` to record it (the operation is idempotent).',
        operationId,
      };
    }
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
    releaseServiceRunLock(runLock.handle);
  }
}
