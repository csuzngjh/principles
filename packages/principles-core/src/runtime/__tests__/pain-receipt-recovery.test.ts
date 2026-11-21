/**
 * PRI-1274 (B1) — structured-receipt fallback recovery against the REAL
 * SQLite task store (SPEC-PD-FEEDBACK-RESILIENCE-001 TD §1.3 兜底路径, T2/T3/T4).
 *
 * Every scenario starts from a REAL persisted original task (unbound MCP
 * ingress shape produced by PainSignalBridge), then drives
 * `recoverTaskIdentityFromReceipt` and asserts the SAME task row — identity
 * restored via CAS, idempotent replays folded, every protected state
 * (terminal / leased / foreign / conflicting identity) untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PainSignalBridge } from '../pain-signal-bridge.js';
import type { DiagnosticianRunnerLike } from '../pain-signal-bridge.js';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { createDiagnosticianTaskId } from '../pain-signal-bridge.js';
import { checkIngressTopLevelConsistency, parsePainIngressV1Payload } from '../pain-ingress-payload.js';
import {
  validatePainSubmitReceipt,
  recoverTaskIdentityFromReceipt,
} from '../pain-receipt-recovery.js';

let tmpDir: string;
let stateManager: RuntimeStateManager;

function makeBridge(): PainSignalBridge {
  const runner: DiagnosticianRunnerLike = { run: async () => ({ status: 'succeeded', taskId: 't', attemptCount: 1 }) };
  return new PainSignalBridge({
    stateManager,
    runner,
    intakeService: {} as never,
    ledgerAdapter: { register: () => undefined, existsForCandidate: () => undefined, getEntries: () => [] } as never,
  });
}

/** The exact unbound MCP ingress shape `pd_submit_pain` persists when the
 * request carried no trusted `_meta` (see submitPainCapability). */
function unboundMcpIngress() {
  return {
    version: 'v1',
    origin: { kind: 'owner_manual', channel: 'mcp_agent_assisted' },
    correlation: { status: 'unbound', reason: 'missing_host_session' },
    evidenceClass: { status: 'unavailable', reason: 'not_applicable_unbound' },
  } as const;
}

async function persistUnboundPain(painId: string, evidence: { sourceRef: string; note: string }[] = []): Promise<string> {
  const bridge = makeBridge();
  const { taskId } = await bridge.submitPainSignal({
    painId,
    painType: 'principle_deviation',
    source: 'mcp_agent_assisted',
    reason: 'receipt fallback fixture',
    provenance: 'agent_reported_owner_approved',
    hostKind: 'codex',
    evidence,
    painIngress: unboundMcpIngress(),
  });
  return taskId;
}

function receiptJson(painId: string, workspaceDir: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'pd.pain-submit-receipt.v1',
    capability: 'pd_submit_pain',
    status: 'submitted',
    painId,
    taskId: createDiagnosticianTaskId(painId),
    workspaceDir,
    diagnosis: { status: 'pending' },
    anchor: { type: 'owner_expectation', ref: 'conversation' },
    provenance: 'agent_reported_owner_approved',
    warnings: [],
    error: null,
    nextAction: null,
    ...overrides,
  };
}

function identity(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'codex-rollout-r1',
    submissionTurnId: 'turn-42',
    toolCallId: 'toolu_call_1',
    ...overrides,
  };
}

function authorize(granted: boolean): { minimalMetadataGranted: boolean } {
  return { minimalMetadataGranted: granted };
}

async function readDiagnostic(taskId: string): Promise<Record<string, unknown>> {
  const task = await stateManager.getTask(taskId);
  if (task === null) throw new Error(`task ${taskId} missing`);
  return JSON.parse(task.diagnosticJson as string) as Record<string, unknown>;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-receipt-rec-'));
  stateManager = new RuntimeStateManager({ workspaceDir: tmpDir });
  await stateManager.initialize();
});

afterEach(async () => {
  await stateManager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('validatePainSubmitReceipt — strict surface (T3 negatives)', () => {
  it('accepts a full submitted receipt', () => {
    const result = validatePainSubmitReceipt(receiptJson('mcp_1_a', tmpDir), { workspaceDir: tmpDir });
    expect(result.ok).toBe(true);
  });

  it('rejects wrong schemaVersion / capability / status', () => {
    expect(validatePainSubmitReceipt(receiptJson('mcp_1_a', tmpDir, { schemaVersion: 'other.v1' }), { workspaceDir: tmpDir }).ok).toBe(false);
    expect(validatePainSubmitReceipt(receiptJson('mcp_1_a', tmpDir, { capability: 'pd_recall_principle_pains' }), { workspaceDir: tmpDir }).ok).toBe(false);
    expect(validatePainSubmitReceipt(receiptJson('mcp_1_a', tmpDir, { status: 'refused' }), { workspaceDir: tmpDir }).ok).toBe(false);
    expect(validatePainSubmitReceipt(receiptJson('mcp_1_a', tmpDir, { status: 'failed' }), { workspaceDir: tmpDir }).ok).toBe(false);
  });

  it('rejects a broken deterministic taskId↔painId mapping', () => {
    const result = validatePainSubmitReceipt(receiptJson('mcp_1_a', tmpDir, { taskId: 'diagnosis_something_else' }), { workspaceDir: tmpDir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe('receipt_task_id_mapping_mismatch');
  });

  it('rejects a foreign workspace receipt', () => {
    const other = path.join(path.dirname(tmpDir), 'other-workspace');
    const result = validatePainSubmitReceipt(receiptJson('mcp_1_a', other), { workspaceDir: tmpDir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe('receipt_workspace_mismatch');
  });

  it('rejects the degraded minimal transport form (no schemaVersion/capability)', () => {
    const minimal = { status: 'submitted', painId: 'mcp_1_a', taskId: createDiagnosticianTaskId('mcp_1_a'), workspaceDir: tmpDir, diagnosis: { status: 'pending' } };
    expect(validatePainSubmitReceipt(minimal, { workspaceDir: tmpDir }).ok).toBe(false);
  });

  it('rejects unknown fields and non-object payloads', () => {
    expect(validatePainSubmitReceipt(receiptJson('mcp_1_a', tmpDir, { extra: 1 }), { workspaceDir: tmpDir }).ok).toBe(false);
    expect(validatePainSubmitReceipt('submitted', { workspaceDir: tmpDir }).ok).toBe(false);
    expect(validatePainSubmitReceipt(null, { workspaceDir: tmpDir }).ok).toBe(false);
  });
});

describe('recoverTaskIdentityFromReceipt — T2 happy path (real SQLite)', () => {
  it('recovers the SAME original task and keeps re-entry consistency', async () => {
    const painId = 'mcp_1700000000001_aa000001';
    const taskId = await persistUnboundPain(painId);
    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error(`fixture receipt invalid: ${validated.reasonCode}`);

    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir,
      hostKind: 'codex',
      receipt: validated.receipt,
      identity: identity(),
      authorization: authorize(true),
    });
    expect(outcome.status).toBe('recovered');
    if (outcome.status !== 'recovered') return;
    // 原 painId/taskId 不变（唯一业务锚点）。
    expect(outcome.painId).toBe(painId);
    expect(outcome.taskId).toBe(taskId);
    expect(outcome.disposition.state).toBe('waiting_for_target_evidence');
    expect(outcome.disposition.reasonCode).toBe('receipt_recovered');
    expect(outcome.disposition.receiptRef?.toolCallId).toBe('toolu_call_1');

    const task = await stateManager.getTask(taskId);
    if (task === null) throw new Error('task missing');
    expect(task.inputRef).toBe(painId);
    expect(task.taskId).toBe(createDiagnosticianTaskId(painId));

    const diagnostic = await readDiagnostic(taskId);
    expect(diagnostic.sessionIdHint).toBe('codex-rollout-r1');
    const verified = diagnostic.painIngress as Record<string, unknown>;
    expect(verified.verifiedHostSession).toEqual({
      status: 'verified',
      sessionId: 'codex-rollout-r1',
      submissionTurnId: 'turn-42',
    });

    // CRITICAL: the recovered payload must still pass the reader-side
    // consistency gate (the diagnosis pipeline's re-entry validation).
    const ingress = parsePainIngressV1Payload(diagnostic.painIngress);
    expect(ingress.ok).toBe(true);
    if (!ingress.ok) return;
    const mismatch = checkIngressTopLevelConsistency({
      payload: ingress.payload,
      topLevelProvenance: diagnostic.provenance,
      topLevelSessionIdHint: diagnostic.sessionIdHint,
      topLevelEvidenceCount: Array.isArray(diagnostic.evidence) ? diagnostic.evidence.length : 0,
    });
    expect(mismatch).toBeNull();

    const recovery = diagnostic.recovery as Record<string, unknown>;
    expect(recovery.state).toBe('waiting_for_target_evidence');
    expect(recovery.schemaVersion).toBe(1);
  });

  it('a task that already carries evidence resolves to ready_for_diagnosis', async () => {
    const painId = 'mcp_1700000000002_bb000002';
    const taskId = await persistUnboundPain(painId, [{ sourceRef: 'governance_observation:k1', note: 'turn text' }]);
    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');

    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: identity({ toolCallId: 'call_2' }), authorization: authorize(true),
    });
    expect(outcome.status).toBe('recovered');
    if (outcome.status !== 'recovered') return;
    expect(outcome.disposition.state).toBe('ready_for_diagnosis');
    expect(outcome.disposition.resolvedAt).toBeDefined();

    // Evidence untouched (identity recovery never fabricates evidence).
    const diagnostic = await readDiagnostic(taskId);
    expect(Array.isArray(diagnostic.evidence)).toBe(true);
    expect((diagnostic.evidence as unknown[]).length).toBe(1);
  });

  it('submission turn absent from the event still recovers the session', async () => {
    const painId = 'mcp_1700000000003_cc000003';
    await persistUnboundPain(painId);
    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');

    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: { sessionId: 'codex-rollout-r1', toolCallId: 'call_3' }, authorization: authorize(true),
    });
    expect(outcome.status).toBe('recovered');
    const diagnostic = await readDiagnostic(createDiagnosticianTaskId(painId));
    const verified = diagnostic.painIngress as Record<string, unknown>;
    expect(verified.verifiedHostSession).toEqual({ status: 'verified', sessionId: 'codex-rollout-r1' });
  });
});

describe('recoverTaskIdentityFromReceipt — idempotence and ambiguity (T4)', () => {
  it('same physical call replayed folds into already_bound with no second write', async () => {
    const painId = 'mcp_1700000000004_dd000004';
    await persistUnboundPain(painId);
    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const base = {
      workspaceDir: tmpDir, hostKind: 'codex' as const, receipt: validated.receipt,
      identity: identity(), authorization: authorize(true),
    };
    const first = await recoverTaskIdentityFromReceipt(base);
    expect(first.status).toBe('recovered');
    const second = await recoverTaskIdentityFromReceipt(base);
    expect(second.status).toBe('already_bound');
    // Exactly one recovery write happened: attemptCount stayed at 1.
    const diagnostic = await readDiagnostic(createDiagnosticianTaskId(painId));
    const recovery = diagnostic.recovery as Record<string, unknown>;
    expect(recovery.attemptCount).toBe(1);
  });

  it('a DIFFERENT toolCallId matching the same task is ambiguous — identity untouched', async () => {
    const painId = 'mcp_1700000000005_ee000005';
    await persistUnboundPain(painId);
    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const first = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: identity(), authorization: authorize(true),
    });
    expect(first.status).toBe('recovered');

    const second = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: identity({ toolCallId: 'call_other' }), authorization: authorize(true),
    });
    expect(second.status).toBe('rejected');
    if (second.status !== 'rejected') return;
    expect(second.reasonCode).toBe('ambiguous_receipt');
  });

  it('a receipt whose session conflicts with the bound identity is rejected', async () => {
    const painId = 'mcp_1700000000006_ff000006';
    await persistUnboundPain(painId);
    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');
    await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: identity(), authorization: authorize(true),
    });
    const conflicting = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: identity({ sessionId: 'codex-rollout-OTHER', toolCallId: 'call_x' }), authorization: authorize(true),
    });
    expect(conflicting.status).toBe('rejected');
    if (conflicting.status !== 'rejected') return;
    expect(conflicting.reasonCode).toBe('identity_conflict');
    const diagnostic = await readDiagnostic(createDiagnosticianTaskId(painId));
    expect(diagnostic.sessionIdHint).toBe('codex-rollout-r1');
  });

  it('two concurrent recoveries racing on the same task produce one write and one cas_conflict-free outcome', async () => {
    const painId = 'mcp_1700000000007_99000007';
    await persistUnboundPain(painId);
    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const base = {
      workspaceDir: tmpDir, hostKind: 'codex' as const, receipt: validated.receipt,
      identity: identity(), authorization: authorize(true),
    };
    const [a, b] = await Promise.all([
      recoverTaskIdentityFromReceipt(base),
      recoverTaskIdentityFromReceipt(base),
    ]);
    const statuses = [a.status, b.status].sort();
    // The SQLite store serializes the two CAS attempts; the loser re-reads
    // and folds into already_bound. No double-write, no failure.
    expect(statuses).toEqual(['already_bound', 'recovered']);
    const diagnostic = await readDiagnostic(createDiagnosticianTaskId(painId));
    const recovery = diagnostic.recovery as Record<string, unknown>;
    expect(recovery.attemptCount).toBe(1);
  });
});

describe('recoverTaskIdentityFromReceipt — protected states (T3/T4 negatives)', () => {
  it('authorization revoked → blocked_by_consent with a persisted disposition, identity untouched', async () => {
    const painId = 'mcp_1700000000008_88000008';
    const taskId = await persistUnboundPain(painId);
    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');

    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: identity(), authorization: authorize(false),
    });
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reasonCode).toBe('blocked_by_consent');
    const diagnostic = await readDiagnostic(taskId);
    expect(diagnostic.sessionIdHint).toBeNull();
    const recovery = diagnostic.recovery as Record<string, unknown>;
    expect(recovery.state).toBe('blocked_by_consent');
    expect(recovery.reasonCode).toBe('minimal_identity_metadata_not_granted');
  });

  it('repeated blocked_by_consent checks increment attemptCount (bounded state, not a reset)', async () => {
    const painId = 'mcp_1700000000009_77000009';
    await persistUnboundPain(painId);
    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const base = {
      workspaceDir: tmpDir, hostKind: 'codex' as const, receipt: validated.receipt,
      identity: identity(), authorization: authorize(false),
    };
    await recoverTaskIdentityFromReceipt(base);
    await recoverTaskIdentityFromReceipt(base);
    const diagnostic = await readDiagnostic(createDiagnosticianTaskId(painId));
    const recovery = diagnostic.recovery as Record<string, unknown>;
    expect(recovery.attemptCount).toBe(2);
  });

  it('submit_unconfirmed requires the exact-ID read-back before recovering', async () => {
    const painId = 'mcp_1700000000010_66000010';
    const missing = validatePainSubmitReceipt(receiptJson(painId, tmpDir, { status: 'submit_unconfirmed' }), { workspaceDir: tmpDir });
    if (!missing.ok) throw new Error('fixture receipt invalid');
    const rejected = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: missing.receipt,
      identity: identity(), authorization: authorize(true),
    });
    expect(rejected.status).toBe('rejected');
    if (rejected.status !== 'rejected') return;
    expect(rejected.reasonCode).toBe('submit_unconfirmed_task_not_found');

    const taskId = await persistUnboundPain(painId);
    const confirmed = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: missing.receipt,
      identity: identity({ toolCallId: 'call_uc' }), authorization: authorize(true),
    });
    expect(confirmed.status).toBe('recovered');
    const diagnostic = await readDiagnostic(taskId);
    expect(diagnostic.sessionIdHint).toBe('codex-rollout-r1');
  });

  it('a receipt naming a non-existent task is rejected without any write', async () => {
    const validated = validatePainSubmitReceipt(receiptJson('mcp_1700000000011_55000011', tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: identity(), authorization: authorize(true),
    });
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reasonCode).toBe('task_not_found');
  });

  it('a task row whose input_ref is a different pain is foreign — never recovered', async () => {
    const painId = 'mcp_1700000000012_44000012';
    const taskId = await persistUnboundPain(painId);
    // Corrupt the original binding: input_ref now names another pain.
    const task = await stateManager.getTask(taskId);
    if (task === null) throw new Error('task missing');
    await stateManager.updateTask(taskId, { inputRef: 'mcp_something_else' });
    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: identity(), authorization: authorize(true),
    });
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reasonCode).toBe('task_input_ref_mismatch');
  });

  it('terminal tasks are never mutated (no reopening of historical state)', async () => {
    const painId = 'mcp_1700000000013_33000013';
    const taskId = await persistUnboundPain(painId);
    await stateManager.updateTask(taskId, { status: 'succeeded' });
    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: identity(), authorization: authorize(true),
    });
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reasonCode).toBe('task_terminal');
    const diagnostic = await readDiagnostic(taskId);
    expect(diagnostic.sessionIdHint).toBeNull();
    expect(Object.hasOwn(diagnostic, 'recovery')).toBe(false);
  });

  it('an active lease protects the task from the fallback writer', async () => {
    const painId = 'mcp_1700000000014_22000014';
    const taskId = await persistUnboundPain(painId);
    await stateManager.acquireLease({ taskId, owner: 'worker-1', runtimeKind: 'test-double', durationMs: 60_000 });
    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: identity(), authorization: authorize(true),
    });
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reasonCode).toBe('task_leased');
    const diagnostic = await readDiagnostic(taskId);
    expect(diagnostic.sessionIdHint).toBeNull();
  });

  it('a task without the painIngress block (not an MCP submission) fails closed', async () => {
    const painId = 'mcp_1700000000015_11000015';
    const bridge = makeBridge();
    const { taskId } = await bridge.submitPainSignal({
      painId,
      painType: 'user_frustration',
      source: 'manual',
      reason: 'legacy shape without ingress',
      provenance: 'owner_reported_no_host_trace',
      evidence: [],
    });
    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: identity(), authorization: authorize(true),
    });
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reasonCode).toBe('diagnostic_payload_invalid:pain_ingress_missing');
    const diagnostic = await readDiagnostic(taskId);
    expect(Object.hasOwn(diagnostic, 'recovery')).toBe(false);
  });
});
