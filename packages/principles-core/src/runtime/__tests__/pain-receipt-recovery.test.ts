/**
 * PRI-1274 (B1) — structured-receipt fallback recovery against the REAL
 * SQLite task store (SPEC-PD-FEEDBACK-RESILIENCE-001 TD §1.3 兜底路径, T2/T3/T4).
 *
 * Every scenario starts from a REAL persisted original task (unbound MCP
 * ingress shape produced by PainSignalBridge), then drives
 * `recoverTaskIdentityFromReceipt` and asserts the SAME task row — identity
 * restored via CAS, idempotent replays folded, every protected state
 * (terminal / leased / foreign / conflicting identity) untouched.
 *
 * Review round 2: the receipt's `sessionAssociation` is the P1-2 security
 * boundary — only `codex_host_metadata_missing` is recoverable; a
 * host_context_conflict / blocked_by_consent / host_context_invalid /
 * codex_target_turn_invalid receipt must NEVER bind through PostToolUse.
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
import type { PainIngressV1Payload } from '../pain-ingress-payload.js';
import {
  validatePainSubmitReceipt,
  recoverTaskIdentityFromReceipt,
} from '../pain-receipt-recovery.js';
import { pickDiagnosticianCandidate } from '../diagnostician-candidate.js';

let tmpDir: string;
let stateManager: RuntimeStateManager;

function makeBridge(): PainSignalBridge {
  const runner: DiagnosticianRunnerLike = { run: async () => ({ status: 'succeeded', taskId: 't', attemptCount: 1 }) };
  return new PainSignalBridge({
    stateManager,
    runner,
    workspaceDir: tmpDir,
    intakeService: {} as never,
    ledgerAdapter: { register: () => undefined, existsForCandidate: () => undefined, getEntries: () => [] } as never,
  });
}

/** The exact unbound MCP ingress shape `pd_submit_pain` persists when the
 * request carried no trusted `_meta` (see submitPainCapability). */
function unboundMcpIngress(evidenceCount = 0): PainIngressV1Payload {
  return {
    version: 'v1',
    origin: { kind: 'owner_manual', channel: 'mcp_agent_assisted' },
    correlation: { status: 'unbound', reason: 'missing_host_session' },
    evidenceClass: evidenceCount > 0
      ? { status: 'available', entryCount: evidenceCount }
      : { status: 'unavailable', reason: 'not_applicable_unbound' },
  };
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
    painIngress: unboundMcpIngress(evidence.length),
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
    // The realistic unbound cause for the Codex fallback territory — the
    // receipt the MCP server actually returns when the request carried no
    // trusted `_meta` (P1-2 gate input).
    sessionAssociation: { status: 'unverified', detail: 'codex_host_metadata_missing' },
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

const TARGET_ENTRIES = [
  { sourceRef: 'governance_observation:codex|codex-rollout-r1|turn-42|user_turn', note: 'owner correction in target turn' },
  { sourceRef: 'governance_observation:codex|codex-rollout-r1|turn-42|assistant_turn', note: 'assistant reply in target turn' },
];

const AUTHORIZED_SOURCE_MATERIAL = {
  isHostSourceMaterialAuthorized: () => ({ authorized: true }) as const,
};

function availableTargetEntries(entries: unknown[] = TARGET_ENTRIES) {
  return () => ({ status: 'available' as const, entries: entries as never });
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

  it('rejects a non-string / object status without throwing (fixed code, no raw text)', () => {
    // A JSON object with a throwing toString must not escape the validator,
    // and the raw value must not be stringified into the reason code.
    const hostile = receiptJson('mcp_1_a', tmpDir);
    hostile.status = { toString(): string { throw new Error('boom'); } };
    const result = validatePainSubmitReceipt(hostile, { workspaceDir: tmpDir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe('receipt_status_not_recoverable');
  });

  it('rejects a malformed sessionAssociation (P1-2 boundary is validated, not dropped)', () => {
    const result = validatePainSubmitReceipt(receiptJson('mcp_1_a', tmpDir, { sessionAssociation: { status: 'weird' } }), { workspaceDir: tmpDir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe('receipt_session_association_invalid');
    const extra = validatePainSubmitReceipt(receiptJson('mcp_1_a', tmpDir, { sessionAssociation: { status: 'unverified', detail: 'x', extra: 1 } }), { workspaceDir: tmpDir });
    expect(extra.ok).toBe(false);
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

describe('recoverTaskIdentityFromReceipt — P1-2 sessionAssociation security gate (T3)', () => {
  const NOT_RECOVERABLE = [
    'host_context_conflict',
    'host_context_invalid:host_context_v1_invalid_shape',
    'blocked_by_consent',
    'codex_target_turn_invalid',
  ] as const;

  for (const detail of NOT_RECOVERABLE) {
    it(`a receipt whose main path refused for ${detail} is never bound by the fallback`, async () => {
      const painId = 'mcp_1700000000020_1f000020';
      const taskId = await persistUnboundPain(painId);
      const validated = validatePainSubmitReceipt(
        receiptJson(painId, tmpDir, { sessionAssociation: { status: 'unverified', detail } }),
        { workspaceDir: tmpDir },
      );
      if (!validated.ok) throw new Error('fixture receipt invalid');

      const outcome = await recoverTaskIdentityFromReceipt({
        workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
        identity: identity(), authorization: authorize(true),
      });
      expect(outcome.status).toBe('rejected');
      if (outcome.status !== 'rejected') return;
      expect(outcome.reasonCode).toBe('session_association_not_recoverable');
      expect(outcome.detail).toBe(detail);
      // No store write happened at all: the task keeps its unbound shape.
      const diagnostic = await readDiagnostic(taskId);
      expect(diagnostic.sessionIdHint).toBeNull();
      expect(Object.hasOwn(diagnostic, 'recovery')).toBe(false);
    });
  }

  it('a receipt with NO sessionAssociation record fails closed (absent is not a designated cause)', async () => {
    const painId = 'mcp_1700000000021_2e000021';
    await persistUnboundPain(painId);
    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir, { sessionAssociation: undefined }), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: identity(), authorization: authorize(true),
    });
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reasonCode).toBe('session_association_not_recoverable');
  });
});

describe('recoverTaskIdentityFromReceipt — WorkBuddy fallback territory (PRI-1275)', () => {
  /** A real persisted ORIGINAL task with the WorkBuddy unbound MCP ingress
   * shape (`host_session_claim_empty` arises ONLY when the caller supplied NO
   * claim at all on a non-Codex host — a claim that was supplied and rejected
   * gets its own refused cause, see the `host_session_claim_unusable` case). */
  async function persistWorkbuddyUnboundPain(painId: string): Promise<string> {
    const bridge = makeBridge();
    const { taskId } = await bridge.submitPainSignal({
      painId,
      painType: 'principle_deviation',
      source: 'mcp_agent_assisted',
      reason: 'receipt fallback fixture (workbuddy)',
      provenance: 'agent_reported_owner_approved',
      hostKind: 'workbuddy',
      evidence: [],
      painIngress: unboundMcpIngress(0),
    });
    return taskId;
  }

  it('host_session_claim_empty (the missing-metadata cause) IS repairable by the WorkBuddy fallback', async () => {
    const painId = 'mcp_1700000000022_3a000022';
    const taskId = await persistWorkbuddyUnboundPain(painId);
    const validated = validatePainSubmitReceipt(
      receiptJson(painId, tmpDir, { sessionAssociation: { status: 'unverified', detail: 'host_session_claim_empty' } }),
      { workspaceDir: tmpDir },
    );
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'workbuddy', receipt: validated.receipt,
      identity: { sessionId: 'wb-session-1', toolCallId: '01a20d41-fdfd-758f-ab69-4df2fe1fe263' },
      authorization: authorize(true),
    });
    expect(outcome.status).toBe('recovered');
    if (outcome.status !== 'recovered') return;
    const diagnostic = await readDiagnostic(taskId);
    expect(diagnostic.sessionIdHint).toBe('wb-session-1');
  });

  it('a FAILED model claim (host_session_not_in_workspace_trajectory) stays refused', async () => {
    const painId = 'mcp_1700000000023_4b000023';
    await persistWorkbuddyUnboundPain(painId);
    const validated = validatePainSubmitReceipt(
      receiptJson(painId, tmpDir, { sessionAssociation: { status: 'unverified', detail: 'host_session_not_in_workspace_trajectory' } }),
      { workspaceDir: tmpDir },
    );
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'workbuddy', receipt: validated.receipt,
      identity: { sessionId: 'wb-session-1', toolCallId: 'wb-call-1' },
      authorization: authorize(true),
    });
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reasonCode).toBe('session_association_not_recoverable');
    expect(outcome.detail).toBe('host_session_not_in_workspace_trajectory');
  });

  it('an UNUSABLE model claim (host_session_claim_unusable: empty/sentinel spellings) stays refused', async () => {
    // Review round: `host_session_claim_empty` used to cover BOTH "no claim
    // supplied" and "a claim supplied but only sentinel/blank". Only the
    // former is the missing-metadata territory; the latter recorded a
    // REFUSAL of something the caller supplied and must not become
    // recoverable (P1-2). The cause was split, and this is its negative
    // control: a task persisted with the sentinel-claim cause is never
    // repaired by the PostToolUse event.
    const painId = 'mcp_1700000000024_5c000024';
    await persistWorkbuddyUnboundPain(painId);
    const validated = validatePainSubmitReceipt(
      receiptJson(painId, tmpDir, { sessionAssociation: { status: 'unverified', detail: 'host_session_claim_unusable' } }),
      { workspaceDir: tmpDir },
    );
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'workbuddy', receipt: validated.receipt,
      identity: { sessionId: 'wb-session-1', toolCallId: 'wb-call-unusable' },
      authorization: authorize(true),
    });
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reasonCode).toBe('session_association_not_recoverable');
    expect(outcome.detail).toBe('host_session_claim_unusable');
  });
});

describe('recoverTaskIdentityFromReceipt — OpenClaw fallback territory (PRI-1276)', () => {
  /** The OpenClaw unbound MCP ingress shape: on the installed OpenClaw
   * 2026.11.5 runtime the materialized `tools/call` carries NO `_meta`
   * producer (materializer calls `callTool(server, tool, args)` — audit
   * PRI1276_OPENCLAW_HOST_IDENTITY_AUDIT_20261125 §2.2), so every normal-entry
   * submission without a model claim persists exactly this shape and the
   * `after_tool_call` receipt is the designated repair source. */
  async function persistOpenclawUnboundPain(painId: string): Promise<string> {
    const bridge = makeBridge();
    const { taskId } = await bridge.submitPainSignal({
      painId,
      painType: 'principle_deviation',
      source: 'mcp_agent_assisted',
      reason: 'receipt fallback fixture (openclaw)',
      provenance: 'agent_reported_owner_approved',
      hostKind: 'openclaw',
      evidence: [],
      painIngress: unboundMcpIngress(0),
    });
    return taskId;
  }

  it('host_session_claim_empty IS repairable through the SAME CAS recovery (no turn id — OpenClaw exposes no proven submission turn)', async () => {
    const painId = 'mcp_1700000000025_6d000025';
    const taskId = await persistOpenclawUnboundPain(painId);
    const validated = validatePainSubmitReceipt(
      receiptJson(painId, tmpDir, { sessionAssociation: { status: 'unverified', detail: 'host_session_claim_empty' } }),
      { workspaceDir: tmpDir },
    );
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'openclaw', receipt: validated.receipt,
      identity: { sessionId: 'oc-session-1', toolCallId: 'oc-call-1' },
      authorization: authorize(true),
    });
    expect(outcome.status).toBe('recovered');
    if (outcome.status !== 'recovered') return;
    const diagnostic = await readDiagnostic(taskId);
    expect(diagnostic.sessionIdHint).toBe('oc-session-1');
    const painIngress = diagnostic.painIngress as Record<string, unknown>;
    expect(painIngress.verifiedHostSession).toEqual({ status: 'verified', sessionId: 'oc-session-1' });
    // Idempotent replay of the SAME physical call folds.
    const replay = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'openclaw', receipt: validated.receipt,
      identity: { sessionId: 'oc-session-1', toolCallId: 'oc-call-1' },
      authorization: authorize(true),
    });
    expect(replay.status).toBe('already_bound');
  });

  it('a DIFFERENT toolCallId against an already-bound task is ambiguous (never a second identity write)', async () => {
    const painId = 'mcp_1700000000026_7e000026';
    await persistOpenclawUnboundPain(painId);
    const validated = validatePainSubmitReceipt(
      receiptJson(painId, tmpDir, { sessionAssociation: { status: 'unverified', detail: 'host_session_claim_empty' } }),
      { workspaceDir: tmpDir },
    );
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const first = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'openclaw', receipt: validated.receipt,
      identity: { sessionId: 'oc-session-2', toolCallId: 'oc-call-2a' },
      authorization: authorize(true),
    });
    expect(first.status).toBe('recovered');
    const second = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'openclaw', receipt: validated.receipt,
      identity: { sessionId: 'oc-session-2', toolCallId: 'oc-call-2b' },
      authorization: authorize(true),
    });
    expect(second.status).toBe('rejected');
    if (second.status !== 'rejected') return;
    expect(second.reasonCode).toBe('ambiguous_receipt');
  });

  it('an OpenClaw event NEVER repairs another host\u2019s original task (hostKind owner check)', async () => {
    const painId = 'mcp_1700000000027_8f000027';
    // The original task belongs to codex; an OpenClaw completion event claims it.
    await persistUnboundPain(painId);
    const validated = validatePainSubmitReceipt(
      receiptJson(painId, tmpDir, { sessionAssociation: { status: 'unverified', detail: 'host_session_claim_empty' } }),
      { workspaceDir: tmpDir },
    );
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'openclaw', receipt: validated.receipt,
      identity: { sessionId: 'oc-session-3', toolCallId: 'oc-call-3' },
      authorization: authorize(true),
    });
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reasonCode).toBe('task_host_kind_mismatch');
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
      readTargetTurnEvidence: () => ({ status: 'not_found' }),
      sourceMaterialAuthorization: AUTHORIZED_SOURCE_MATERIAL,
    });
    expect(outcome.status).toBe('recovered');
    if (outcome.status !== 'recovered') return;
    // 原 painId/taskId 不变（唯一业务锚点）。
    expect(outcome.painId).toBe(painId);
    expect(outcome.taskId).toBe(taskId);
    // The event turn is the submission turn AND the target turn; with no
    // target text available yet (P1-3), the disposition waits.
    expect(outcome.disposition.state).toBe('waiting_for_target_evidence');
    expect(outcome.disposition.reasonCode).toBe('target_turn_text_pending');
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
      targetTurnId: 'turn-42',
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

  it('C01: valid target-turn entries persist atomically with identity, evidenceClass and ready_for_diagnosis', async () => {
    const painId = 'mcp_1700000000016_0a000016';
    const taskId = await persistUnboundPain(painId);
    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: identity(), authorization: authorize(true),
      readTargetTurnEvidence: availableTargetEntries(),
      sourceMaterialAuthorization: AUTHORIZED_SOURCE_MATERIAL,
    });
    expect(outcome.status).toBe('recovered');
    if (outcome.status !== 'recovered') return;
    expect(outcome.disposition.state).toBe('ready_for_diagnosis');
    expect(outcome.disposition.reasonCode).toBe('receipt_recovered');
    expect(outcome.disposition.resolvedAt).toBeDefined();

    // Read the SAME raw SQLite task back: identity, real evidence, count class
    // and disposition are all present from the one CAS result.
    const task = await stateManager.getTask(taskId);
    expect(task?.taskId).toBe(taskId);
    expect(task?.inputRef).toBe(painId);
    const diagnostic = await readDiagnostic(taskId);
    expect(diagnostic.sessionIdHint).toBe('codex-rollout-r1');
    const ingress = diagnostic.painIngress as Record<string, unknown>;
    expect(ingress.verifiedHostSession).toEqual({
      status: 'verified', sessionId: 'codex-rollout-r1', submissionTurnId: 'turn-42', targetTurnId: 'turn-42',
    });
    expect(diagnostic.evidence).toEqual(TARGET_ENTRIES);
    expect(ingress.evidenceClass).toEqual({ status: 'available', entryCount: TARGET_ENTRIES.length });
    const recovery = diagnostic.recovery as Record<string, unknown>;
    expect(recovery.state).toBe('ready_for_diagnosis');
    expect((recovery.receiptRef as Record<string, unknown>).toolCallId).toBe('toolu_call_1');
  });

  it('PRI-1296: a legacy boolean true is never sufficient evidence for ready', async () => {
    const painId = 'mcp_1700000000018_0a000018';
    const taskId = await persistUnboundPain(painId);
    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: identity(), authorization: authorize(true),
      targetTurnTextAvailable: () => true,
    });
    expect(outcome.status).toBe('recovered');
    if (outcome.status !== 'recovered') return;
    expect(outcome.disposition.state).toBe('waiting_for_target_evidence');
    expect(outcome.disposition.reasonCode).toBe('target_turn_evidence_reader_unavailable');
    const diagnostic = await readDiagnostic(taskId);
    expect(diagnostic.evidence).toEqual([]);
    expect((diagnostic.recovery as Record<string, unknown>).state).toBe('waiting_for_target_evidence');
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

    // Evidence untouched (identity recovery never fabricates evidence), and
    // the fixture stays readable by the diagnosis re-entry gate.
    const diagnostic = await readDiagnostic(taskId);
    expect(Array.isArray(diagnostic.evidence)).toBe(true);
    expect((diagnostic.evidence as unknown[]).length).toBe(1);
    const ingress = parsePainIngressV1Payload(diagnostic.painIngress);
    expect(ingress.ok).toBe(true);
  });

  it('submission turn absent from the event still recovers the session (no target pinned)', async () => {
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
    const recovery = diagnostic.recovery as Record<string, unknown>;
    // No target turn named ⇒ session-level policy, no artificial wait.
    expect(recovery.state).toBe('ready_for_diagnosis');
  });
});

describe('recoverTaskIdentityFromReceipt — PRI-1296 structured evidence admission matrix (real SQLite)', () => {
  async function recoverWithEvidenceRead(painId: string, options: {
    readonly read?: (sessionId: string, turnId: string) => unknown;
    readonly authorization?: unknown;
  }): Promise<{ outcome: Awaited<ReturnType<typeof recoverTaskIdentityFromReceipt>>; diagnostic: Record<string, unknown> }> {
    const taskId = await persistUnboundPain(painId);
    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: identity(), authorization: authorize(true),
      ...(options.read !== undefined ? { readTargetTurnEvidence: options.read as never } : {}),
      ...(options.authorization !== undefined ? { sourceMaterialAuthorization: options.authorization as never } : {}),
    });
    return { outcome, diagnostic: await readDiagnostic(taskId) };
  }

  it('C03-C06: every source-material consent denial becomes blocked without persisting evidence', async () => {
    const reasons = ['consent_missing', 'consent_revoked', 'consent_not_granted', 'consent_unreadable'] as const;
    for (const [index, reason] of reasons.entries()) {
      const painId = `mcp_17000000002${index}_c30000${index}`;
      const { outcome, diagnostic } = await recoverWithEvidenceRead(painId, {
        read: () => ({ status: 'blocked_by_consent', reason }),
        authorization: AUTHORIZED_SOURCE_MATERIAL,
      });
      expect(outcome.status).toBe('recovered');
      if (outcome.status !== 'recovered') return;
      expect(outcome.disposition.state).toBe('blocked_by_source_material_consent');
      expect(outcome.disposition.reasonCode).toBe(`target_turn_source_material_${reason}`);
      expect(diagnostic.sessionIdHint).toBe('codex-rollout-r1');
      expect(diagnostic.evidence).toEqual([]);
    }
  });

  it('C07-C11: read failure, empty/malformed entries, missing reader and missing pre-write authorization never become ready', async () => {
    const cases = [
      { suffix: '01', read: () => ({ status: 'read_failed', reason: 'sqlite_locked' }), authorization: AUTHORIZED_SOURCE_MATERIAL, reasonCode: 'target_turn_read_failed' },
      { suffix: '02', read: availableTargetEntries([]), authorization: AUTHORIZED_SOURCE_MATERIAL, reasonCode: 'target_turn_evidence_invalid' },
      { suffix: '03', read: availableTargetEntries([{ sourceRef: 'x', note: 'ok', extra: true }]), authorization: AUTHORIZED_SOURCE_MATERIAL, reasonCode: 'target_turn_evidence_invalid' },
      { suffix: '04', read: undefined, authorization: AUTHORIZED_SOURCE_MATERIAL, reasonCode: 'target_turn_evidence_reader_unavailable' },
      { suffix: '05', read: availableTargetEntries(), authorization: undefined, reasonCode: 'target_turn_source_material_authorization_unavailable' },
    ] as const;
    for (const testCase of cases) {
      const { outcome, diagnostic } = await recoverWithEvidenceRead(`mcp_17000000003${testCase.suffix}_c70000${testCase.suffix}`, {
        ...(testCase.read !== undefined ? { read: testCase.read } : {}),
        ...(testCase.authorization !== undefined ? { authorization: testCase.authorization } : {}),
      });
      expect(outcome.status).toBe('recovered');
      if (outcome.status !== 'recovered') return;
      expect(outcome.disposition.state).toBe('waiting_for_target_evidence');
      expect(outcome.disposition.reasonCode).toBe(testCase.reasonCode);
      expect(diagnostic.sessionIdHint).toBe('codex-rollout-r1');
      expect(diagnostic.evidence).toEqual([]);
      expect((diagnostic.recovery as Record<string, unknown>).state).toBe('waiting_for_target_evidence');
    }
  });

  it('C12: consent revoked after a valid read but before the CAS gate blocks the evidence write', async () => {
    const revokedPort = {
      isHostSourceMaterialAuthorized: () => ({ authorized: false as const, reason: 'consent_revoked' as const }),
    };
    const { outcome, diagnostic } = await recoverWithEvidenceRead('mcp_1700000000306_c1200006', {
      read: availableTargetEntries(),
      authorization: revokedPort,
    });
    expect(outcome.status).toBe('recovered');
    if (outcome.status !== 'recovered') return;
    expect(outcome.disposition.state).toBe('blocked_by_source_material_consent');
    expect(outcome.disposition.reasonCode).toBe('target_turn_source_material_consent_revoked');
    expect(diagnostic.evidence).toEqual([]);
  });

  it('C18: an owner_expectation anchor stays independently admissible without reading target evidence', async () => {
    const painId = 'mcp_1700000000307_c1800007';
    const bridge = makeBridge();
    await bridge.submitPainSignal({
      painId,
      painType: 'principle_deviation',
      source: 'mcp_agent_assisted',
      reason: 'owner statement fixture',
      provenance: 'agent_reported_owner_approved',
      hostKind: 'codex',
      evidence: [],
      anchor: { type: 'owner_expectation', ref: 'owner statement' },
      painIngress: unboundMcpIngress(0),
    });
    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');
    let readCalled = false;
    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: identity(), authorization: authorize(true),
      readTargetTurnEvidence: () => { readCalled = true; return { status: 'not_found' as const }; },
      sourceMaterialAuthorization: AUTHORIZED_SOURCE_MATERIAL,
    });
    expect(outcome.status).toBe('recovered');
    if (outcome.status !== 'recovered') return;
    expect(outcome.disposition.state).toBe('ready_for_diagnosis');
    expect(readCalled).toBe(false);
  });
});

describe('recoverTaskIdentityFromReceipt — idempotence and ambiguity (T4/T7)', () => {
  it('same physical call replayed folds into already_bound with no second write (T7)', async () => {
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

  it('PRI-1296 review: an already-bound replay backfills target evidence onto a legacy boolean-flipped empty task', async () => {
    const painId = 'mcp_1700000001296_rb000296';
    const taskId = await persistUnboundPain(painId);
    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const base = {
      workspaceDir: tmpDir, hostKind: 'codex' as const, receipt: validated.receipt,
      identity: identity(), authorization: authorize(true),
    };
    const first = await recoverTaskIdentityFromReceipt(base);
    expect(first.status).toBe('recovered');

    const waiting = await readDiagnostic(taskId);
    const legacyReady = {
      ...waiting,
      recovery: {
        ...(waiting.recovery as Record<string, unknown>),
        state: 'ready_for_diagnosis',
        reasonCode: 'target_evidence_arrived',
        resolvedAt: new Date().toISOString(),
      },
    };
    await stateManager.updateTaskIfDiagnosticJsonUnchanged(taskId, JSON.stringify(waiting), { diagnosticJson: JSON.stringify(legacyReady) });

    const replay = await recoverTaskIdentityFromReceipt({
      ...base,
      readTargetTurnEvidence: availableTargetEntries(),
      sourceMaterialAuthorization: AUTHORIZED_SOURCE_MATERIAL,
    });
    expect(replay.status).toBe('already_bound');
    const diagnostic = await readDiagnostic(taskId);
    expect(diagnostic.evidence).toEqual(TARGET_ENTRIES);
    expect((diagnostic.painIngress as Record<string, unknown>).evidenceClass).toEqual({ status: 'available', entryCount: TARGET_ENTRIES.length });
    expect(diagnostic.recovery).toMatchObject({ state: 'ready_for_diagnosis', reasonCode: 'target_evidence_arrived' });
  });

  it('PRI-1296 review: an already-bound replay returns a legacy invalid READY task to waiting when evidence is absent', async () => {
    const painId = 'mcp_1700000001296_rb000297';
    const taskId = await persistUnboundPain(painId);
    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const base = {
      workspaceDir: tmpDir, hostKind: 'codex' as const, receipt: validated.receipt,
      identity: identity(), authorization: authorize(true),
    };
    expect((await recoverTaskIdentityFromReceipt(base)).status).toBe('recovered');

    const waiting = await readDiagnostic(taskId);
    const legacyReady = {
      ...waiting,
      recovery: {
        ...(waiting.recovery as Record<string, unknown>),
        state: 'ready_for_diagnosis',
        reasonCode: 'target_evidence_arrived',
        resolvedAt: new Date().toISOString(),
      },
    };
    await stateManager.updateTaskIfDiagnosticJsonUnchanged(taskId, JSON.stringify(waiting), { diagnosticJson: JSON.stringify(legacyReady) });

    const replay = await recoverTaskIdentityFromReceipt({
      ...base,
      readTargetTurnEvidence: () => ({ status: 'not_found' as const }),
      sourceMaterialAuthorization: AUTHORIZED_SOURCE_MATERIAL,
    });
    expect(replay.status).toBe('already_bound');
    const diagnostic = await readDiagnostic(taskId);
    expect(diagnostic.evidence).toEqual([]);
    expect(diagnostic.recovery).toMatchObject({ state: 'waiting_for_target_evidence', reasonCode: 'target_turn_text_pending' });
    expect((diagnostic.recovery as Record<string, unknown>).resolvedAt).toBeUndefined();
  });

  it('PRI-1296 review: malformed persisted evidence is not admissible and is replaced only by validated target entries', async () => {
    const painId = 'mcp_1700000001296_ev000301';
    const taskId = await persistUnboundPain(painId);
    const before = await readDiagnostic(taskId);
    const malformed = { ...before, evidence: [{ sourceRef: '', note: 'malformed legacy evidence' }] };
    const seeded = await stateManager.updateTaskIfDiagnosticJsonUnchanged(
      taskId,
      JSON.stringify(before),
      { diagnosticJson: JSON.stringify(malformed) },
    );
    expect(seeded).not.toBeNull();

    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const base = {
      workspaceDir: tmpDir,
      hostKind: 'codex' as const,
      receipt: validated.receipt,
      identity: identity(),
      authorization: authorize(true),
      sourceMaterialAuthorization: AUTHORIZED_SOURCE_MATERIAL,
    };
    const waiting = await recoverTaskIdentityFromReceipt({
      ...base,
      readTargetTurnEvidence: () => ({ status: 'not_found' as const }),
    });
    expect(waiting.status).toBe('recovered');
    if (waiting.status !== 'recovered') return;
    expect(waiting.disposition.state).toBe('waiting_for_target_evidence');

    const replay = await recoverTaskIdentityFromReceipt({
      ...base,
      readTargetTurnEvidence: () => ({ status: 'available' as const, entries: TARGET_ENTRIES }),
    });
    expect(replay.status).toBe('already_bound');
    const diagnostic = await readDiagnostic(taskId);
    expect(diagnostic.evidence).toEqual(TARGET_ENTRIES);
    expect((diagnostic.painIngress as Record<string, unknown>).evidenceClass)
      .toEqual({ status: 'available', entryCount: TARGET_ENTRIES.length });
    expect(diagnostic.recovery).toMatchObject({ state: 'ready_for_diagnosis', reasonCode: 'target_evidence_arrived' });
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

describe('recoverTaskIdentityFromReceipt — P1-4 read→write race (T5, real SQLite)', () => {
  it('a lease acquired between read and write is defeated by the CAS preconditions', async () => {
    const painId = 'mcp_1700000000017_3b000017';
    const taskId = await persistUnboundPain(painId);
    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');

    // Wrap the manager: the FIRST getTask lets a "worker" acquire the lease
    // after the recovery has read the row but before its CAS — exactly the
    // P1-4 window. The preconditioned UPDATE must lose, re-read, and then
    // honor the now-active lease instead of writing identity under it.
    let intercepted = false;
    const racingManager = Object.create(stateManager) as RuntimeStateManager;
    racingManager.getTask = async (id: string) => {
      const task = await stateManager.getTask(id);
      if (!intercepted && task !== null && id === taskId) {
        intercepted = true;
        await stateManager.acquireLease({ taskId, owner: 'racing-worker', runtimeKind: 'test-double', durationMs: 60_000 });
      }
      return task;
    };

    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: identity(), authorization: authorize(true),
      managerFactory: async () => racingManager,
    });
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reasonCode).toBe('task_leased');
    const diagnostic = await readDiagnostic(taskId);
    expect(diagnostic.sessionIdHint).toBeNull();
  });

  it('a terminal transition between read and write is defeated the same way', async () => {
    const painId = 'mcp_1700000000018_4c000018';
    const taskId = await persistUnboundPain(painId);
    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');

    let intercepted = false;
    const racingManager = Object.create(stateManager) as RuntimeStateManager;
    racingManager.getTask = async (id: string) => {
      const task = await stateManager.getTask(id);
      if (!intercepted && task !== null && id === taskId) {
        intercepted = true;
        await stateManager.updateTask(taskId, { status: 'succeeded' });
      }
      return task;
    };

    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: identity(), authorization: authorize(true),
      managerFactory: async () => racingManager,
    });
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reasonCode).toBe('task_terminal');
    const diagnostic = await readDiagnostic(taskId);
    expect(diagnostic.sessionIdHint).toBeNull();
  });
});

describe('recoverTaskIdentityFromReceipt — protected states (T3/T4/T8/T9 negatives)', () => {
  it('authorization revoked → blocked_by_consent disposition, identity untouched', async () => {
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
    expect(outcome.taskUnbound).toBe(true);
    const diagnostic = await readDiagnostic(taskId);
    expect(diagnostic.sessionIdHint).toBeNull();
    const recovery = diagnostic.recovery as Record<string, unknown>;
    expect(recovery.state).toBe('blocked_by_consent');
    expect(recovery.reasonCode).toBe('minimal_identity_metadata_not_granted');

    // This is the real PostToolUse receipt-recovery path, not a synthetic row:
    // identity binding is blocked, but the owner-manual report remains eligible.
    const candidate = await pickDiagnosticianCandidate(stateManager, 1, new Date().toISOString());
    expect(candidate?.taskId).toBe(taskId);
  });

  it('T9: with the authorization OFF, ZERO identity metadata is persisted — no receiptRef, no toolCallId anywhere', async () => {
    const painId = 'mcp_1700000000019_5d000019';
    const taskId = await persistUnboundPain(painId);
    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');
    await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: identity(), authorization: authorize(false),
    });
    const raw = (await stateManager.getTask(taskId))?.diagnosticJson ?? '';
    const diagnostic = JSON.parse(raw) as Record<string, unknown>;
    const recovery = diagnostic.recovery as Record<string, unknown> | undefined;
    expect(recovery).toBeDefined();
    expect(Object.hasOwn(recovery as object, 'receiptRef')).toBe(false);
    expect(raw).not.toContain('toolu_call_1');
    expect(raw).not.toContain('codex-rollout-r1');
    expect(raw).not.toContain('turn-42');
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

  it('submit_unconfirmed requires the exact-ID read-back before recovering (T8)', async () => {
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

  it('a non-Codex task (hostKind mismatch) is never bound by a Codex PostToolUse event (P1-2.6)', async () => {
    const painId = 'mcp_1700000000024_6f000024';
    const bridge = makeBridge();
    const { taskId } = await bridge.submitPainSignal({
      painId,
      painType: 'principle_deviation',
      source: 'mcp_agent_assisted',
      reason: 'openclaw submission',
      provenance: 'agent_reported_owner_approved',
      hostKind: 'openclaw',
      evidence: [],
      painIngress: unboundMcpIngress(),
    });
    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: identity(), authorization: authorize(true),
    });
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reasonCode).toBe('task_host_kind_mismatch');
    const diagnostic = await readDiagnostic(taskId);
    expect(diagnostic.sessionIdHint).toBeNull();
  });

  it('a task persisted for a DIFFERENT workspace is never bound (P1-2.6)', async () => {
    const painId = 'mcp_1700000000025_7a000025';
    // Same store, but the persisted diagnostic workspace names another dir.
    const bridge = new PainSignalBridge({
      stateManager,
      runner: { run: async () => ({ status: 'succeeded', taskId: 't', attemptCount: 1 }) },
      workspaceDir: path.join(path.dirname(tmpDir), 'another-workspace'),
      intakeService: {} as never,
      ledgerAdapter: { register: () => undefined, existsForCandidate: () => undefined, getEntries: () => [] } as never,
    });
    const { taskId } = await bridge.submitPainSignal({
      painId,
      painType: 'principle_deviation',
      source: 'mcp_agent_assisted',
      reason: 'foreign workspace fixture',
      provenance: 'agent_reported_owner_approved',
      hostKind: 'codex',
      evidence: [],
      painIngress: unboundMcpIngress(),
    });
    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: identity(), authorization: authorize(true),
    });
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reasonCode).toBe('task_workspace_mismatch');
    const diagnostic = await readDiagnostic(taskId);
    expect(diagnostic.sessionIdHint).toBeNull();
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
      hostKind: 'codex',
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
    expect(outcome.taskUnbound).toBe(true);
    const diagnostic = await readDiagnostic(taskId);
    expect(Object.hasOwn(diagnostic, 'recovery')).toBe(false);
  });
});

// ── Review round 2 (directive G4): lease-generation ABA fencing ─────────────

describe('recoverTaskIdentityFromReceipt — G: lease_generation CAS fencing (real SQLite)', () => {
  it('the store primitive defeats the ABA cycle (acquire→release restores status/owner/expires, NOT generation)', async () => {
    const painId = 'mcp_1700000000031_7a000031';
    const taskId = await persistUnboundPain(painId);
    // Snapshot BEFORE any takeover — the recovery's read-time view.
    const snapshot = await stateManager.getTask(taskId);
    if (snapshot === null) throw new Error('task missing');
    expect(snapshot.status).toBe('pending');

    // Worker B takes the lease over and releases it: status, owner and
    // expiresAt cycle back to the snapshot's values — the classic ABA shape.
    const leased = await stateManager.acquireLease({ taskId, owner: 'worker-b', runtimeKind: 'test-double', durationMs: 60_000 });
    const generationAfterTakeover = leased.leaseGeneration ?? 0;
    expect(generationAfterTakeover).toBeGreaterThan(snapshot.leaseGeneration ?? 0);
    await stateManager.releaseLease({ taskId, owner: 'worker-b', leaseGeneration: generationAfterTakeover });

    // The generation-aware CAS (what the recovery now sends) LOSES — the
    // fencing token moved even though every legacy column matches.
    const fenced = await stateManager.updateTaskIfDiagnosticJsonUnchanged(
      taskId,
      snapshot.diagnosticJson ?? null,
      { diagnosticJson: JSON.stringify({ ...JSON.parse(snapshot.diagnosticJson ?? '{}'), abTest: true }) },
      {
        expectedStatus: snapshot.status,
        expectedLeaseOwner: snapshot.leaseOwner ?? null,
        expectedLeaseExpiresAt: snapshot.leaseExpiresAt ?? null,
        expectedLeaseGeneration: snapshot.leaseGeneration ?? 0,
        expectedAttemptCount: snapshot.attemptCount,
      },
    );
    expect(fenced).toBeNull();

    // Negative control (documents the pre-fix hole): WITHOUT the generation
    // precondition the same stale snapshot WOULD have won — exactly the ABA
    // bug directive G closes.
    const unfenced = await stateManager.updateTaskIfDiagnosticJsonUnchanged(
      taskId,
      snapshot.diagnosticJson ?? null,
      { diagnosticJson: JSON.stringify({ ...JSON.parse(snapshot.diagnosticJson ?? '{}'), abTest: true }) },
      {
        expectedStatus: snapshot.status,
        expectedLeaseOwner: snapshot.leaseOwner ?? null,
        expectedLeaseExpiresAt: snapshot.leaseExpiresAt ?? null,
      },
    );
    expect(unfenced).not.toBeNull();
  });

  it('a stale-worker write with an old generation is rejected after a takeover', async () => {
    const painId = 'mcp_1700000000032_7a000032';
    const taskId = await persistUnboundPain(painId);
    // Worker A acquires (generation 1), then releases; B takes over
    // (generation 2) — the takeover shape A's stale fence must lose to.
    const aLease = await stateManager.acquireLease({ taskId, owner: 'worker-a', runtimeKind: 'test-double', durationMs: 60_000 });
    const aSnapshot = await stateManager.getTask(taskId);
    if (aSnapshot === null) throw new Error('task missing');
    await stateManager.releaseLease({ taskId, owner: 'worker-a', leaseGeneration: aLease.leaseGeneration ?? 0 });
    await stateManager.acquireLease({ taskId, owner: 'worker-b', runtimeKind: 'test-double', durationMs: 60_000 });
    // Worker A submits with its OLD generation — rejected.
    const aWrite = await stateManager.updateTaskIfDiagnosticJsonUnchanged(
      taskId,
      aSnapshot.diagnosticJson ?? null,
      { diagnosticJson: JSON.stringify({ ...JSON.parse(aSnapshot.diagnosticJson ?? '{}'), staleWorker: true }) },
      {
        expectedStatus: aSnapshot.status,
        expectedLeaseOwner: aSnapshot.leaseOwner ?? null,
        expectedLeaseExpiresAt: aSnapshot.leaseExpiresAt ?? null,
        expectedLeaseGeneration: aLease.leaseGeneration ?? 0,
        expectedAttemptCount: aSnapshot.attemptCount,
      },
    );
    expect(aWrite).toBeNull();
  });

  it('recovery after an ABA cycle re-reads the fresh state and decides on CURRENT facts', async () => {
    const painId = 'mcp_1700000000033_7a000033';
    const taskId = await persistUnboundPain(painId);
    // An ABA cycle completes BEFORE the recovery starts: the recovery's own
    // fresh read sees generation 1, asserts it, and its CAS succeeds.
    const leased = await stateManager.acquireLease({ taskId, owner: 'worker-b', runtimeKind: 'test-double', durationMs: 60_000 });
    await stateManager.releaseLease({ taskId, owner: 'worker-b', leaseGeneration: leased.leaseGeneration ?? 0 });

    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: identity(), authorization: authorize(true),
    });
    expect(outcome.status).toBe('recovered');
    const diagnostic = await readDiagnostic(taskId);
    expect(diagnostic.sessionIdHint).toBe('codex-rollout-r1');
  });
});

// ── Review round 2 (directive I3): historical requestedTargetTurnId normalization ──

describe('recoverTaskIdentityFromReceipt — I: the historical target hint passes the shared normalization', () => {
  it('a whitespace-padded historical hint binds the trimmed turn; a malformed hint never guesses', async () => {
    const painId = 'mcp_1700000000034_7a000034';
    // Persist an unbound pain whose historical hint carries outer whitespace.
    const bridge = makeBridge();
    await bridge.submitPainSignal({
      painId,
      painType: 'principle_deviation',
      source: 'mcp_agent_assisted',
      reason: 'hint normalization fixture',
      provenance: 'agent_reported_owner_approved',
      hostKind: 'codex',
      evidence: [],
      painIngress: { ...unboundMcpIngress(0), requestedTargetTurnId: ' turn-42 ' },
    });

    const validated = validatePainSubmitReceipt(receiptJson(painId, tmpDir), { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: identity({ submissionTurnId: 'turn-99' }),
      authorization: authorize(true),
      // Target evidence is only consulted for the RESOLVED target.
      readTargetTurnEvidence: (sessionId, turnId) => {
        expect(sessionId).toBe('codex-rollout-r1');
        // The padded historical hint must resolve to the TRIMMED id.
        expect(turnId).toBe('turn-42');
        return { status: 'available' as const, entries: TARGET_ENTRIES };
      },
      sourceMaterialAuthorization: AUTHORIZED_SOURCE_MATERIAL,
    });
    expect(outcome.status).toBe('recovered');
    if (outcome.status !== 'recovered') return;
    expect(outcome.disposition.state).toBe('ready_for_diagnosis');

    // A malformed historical hint (control characters) is discarded — the
    // documented default (the event's submission turn) applies, never a
    // guess at the corrupt value.
    const painId2 = 'mcp_1700000000035_7a000035';
    await bridge.submitPainSignal({
      painId: painId2,
      painType: 'principle_deviation',
      source: 'mcp_agent_assisted',
      reason: 'hint normalization fixture 2',
      provenance: 'agent_reported_owner_approved',
      hostKind: 'codex',
      evidence: [],
      painIngress: { ...unboundMcpIngress(0), requestedTargetTurnId: 'bad\u0007turn' },
    });
    const validated2 = validatePainSubmitReceipt(receiptJson(painId2, tmpDir), { workspaceDir: tmpDir });
    if (!validated2.ok) throw new Error('fixture receipt 2 invalid');
    let observedTurn: string | null = null;
    const outcome2 = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated2.receipt,
      identity: identity({ submissionTurnId: 'turn-7' }),
      authorization: authorize(true),
      readTargetTurnEvidence: (_sessionId, turnId) => {
        observedTurn = turnId;
        return { status: 'available' as const, entries: TARGET_ENTRIES };
      },
      sourceMaterialAuthorization: AUTHORIZED_SOURCE_MATERIAL,
    });
    expect(outcome2.status).toBe('recovered');
    expect(observedTurn).toBe('turn-7');
  });
});
