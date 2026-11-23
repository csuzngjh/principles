/**
 * PRI-1274 (B1 / P1-3) — targetTurnId participates in diagnosis admission.
 *
 * Real-SQLite proof of the review round's core scenario: a submission made
 * at turn 12 that NAMES turn 10 as its target must be diagnosed on turn 10's
 * text and NOTHING else — never turn 11 or turn 12, never "the latest turn".
 *
 *  1. `pd_submit_pain` with a verified session + named target turn whose
 *     text is not yet collectable creates the task WAITING
 *     (`recovery.state = waiting_for_target_evidence`) — unless the
 *     submission carries an explicit Owner statement (existing admission
 *     policy continues, no unnecessary wait).
 *  2. The candidate picker excludes inadmissible tasks INSIDE the store query —
 *     before ORDER BY/LIMIT — so inadmissible work never displaces an
 *     admissible task from the bounded window.
 *  3. The worker reconcile is the only exit: once the exact target turn's
 *     text exists, the disposition flips to `ready_for_diagnosis`.
 *  4. The context assembler, given a target turn, reads EXACTLY that turn —
 *     the session's other turns never substitute it (T6).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { pickDiagnosticianCandidate } from '../diagnostician-candidate.js';
import { reconcileWaitingTargetEvidenceTasks, type TargetTurnEvidenceRead } from '../pain-target-evidence-reconcile.js';
import { submitPainCapability } from '../pain-submit-capability.js';
import { createDiagnosticianTaskId } from '../pain-signal-bridge.js';
import { PainSignalBridge } from '../pain-signal-bridge.js';
import type { DiagnosticianRunnerLike } from '../pain-signal-bridge.js';
import { SqliteConnection } from '../store/sqlite-connection.js';
import { SqliteTaskStore } from '../store/task/sqlite-task-store.js';
import { SqliteRunStore } from '../store/run/sqlite-run-store.js';
import { SqliteHistoryQuery } from '../store/history/sqlite-history-query.js';
import { SqliteContextAssembler } from '../store/context/sqlite-context-assembler.js';
import type { TrajectoryTurnReader, TrajectoryUserTurn } from '../store/context/trajectory-turn-reader.js';
import { validatePainSubmitReceipt, recoverTaskIdentityFromReceipt } from '../pain-receipt-recovery.js';
import { parsePainIngressV1Payload, checkIngressTopLevelConsistency } from '../pain-ingress-payload.js';

let tmpDir: string;
let stateManager: RuntimeStateManager;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-target-evidence-'));
  stateManager = new RuntimeStateManager({ workspaceDir: tmpDir });
  await stateManager.initialize();
});

afterEach(async () => {
  await stateManager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A session-bound submission that NAMES turn 10 while living at turn 12 —
 * through the REAL capability (the exact production write path). */
async function submitTargetingTurn10(painId: string, anchorType: 'agent_instruction' | 'owner_expectation' = 'agent_instruction') {
  const receipt = await submitPainCapability(
    {
      workspaceDir: tmpDir,
      stateDir: path.join(tmpDir, '.state'),
      painId,
      taskId: createDiagnosticianTaskId(painId),
      hostKind: 'codex',
      verifyHostSession: () => ({
        status: 'verified',
        sessionId: 'rollout-target',
        // submissionTurnId intentionally absent — only the explicit target
        // matters here; the tool call itself lived at turn 12.
        targetTurnId: 'turn-10',
      }),
    },
    {
      reason: 'Anchor: agent instruction. Observed: behavior. Deviation: mismatch.',
      anchorType,
      anchorRef: anchorType === 'agent_instruction' ? 'AGENTS.md#safety' : 'Owner statement in this conversation',
      painType: 'user_frustration',
    },
  );
  return receipt;
}

async function readDiagnostic(taskId: string): Promise<Record<string, unknown>> {
  const task = await stateManager.getTask(taskId);
  if (task === null) throw new Error(`task ${taskId} missing`);
  return JSON.parse(task.diagnosticJson as string) as Record<string, unknown>;
}

describe('P1-3.3 — submit-time waiting disposition', () => {
  it('a named target turn without text creates the task waiting_for_target_evidence', async () => {
    const painId = 'mcp_1700000000041_1a000041';
    const receipt = await submitTargetingTurn10(painId);
    expect(receipt.status).toBe('submitted');
    if (receipt.status !== 'submitted') return;
    expect(receipt.warnings.some((warning) => warning.startsWith('target_evidence_pending'))).toBe(true);

    const diagnostic = await readDiagnostic(createDiagnosticianTaskId(painId));
    const verified = (diagnostic.painIngress as Record<string, unknown>).verifiedHostSession as Record<string, unknown>;
    expect(verified.targetTurnId).toBe('turn-10');
    const recovery = diagnostic.recovery as Record<string, unknown>;
    expect(recovery.state).toBe('waiting_for_target_evidence');
    expect(recovery.reasonCode).toBe('target_turn_text_pending');
    // The waiting task is still an ordinary pending row (no new TaskStatus).
    const task = await stateManager.getTask(createDiagnosticianTaskId(painId));
    expect(task?.status).toBe('pending');
  });

  it('an explicit Owner statement does NOT wait (existing admission policy continues)', async () => {
    const painId = 'mcp_1700000000042_2b000042';
    const receipt = await submitTargetingTurn10(painId, 'owner_expectation');
    expect(receipt.status).toBe('submitted');
    if (receipt.status !== 'submitted') return;
    expect(receipt.warnings.some((warning) => warning.startsWith('target_evidence_pending'))).toBe(false);
    const diagnostic = await readDiagnostic(createDiagnosticianTaskId(painId));
    expect(Object.hasOwn(diagnostic, 'recovery')).toBe(false);
  });
});

describe('P1-3.4 — candidate picker excludes inadmissible tasks before ORDER BY/LIMIT', () => {
  it('waiting and consent-blocked tasks do not consume the bounded window — the admissible task is picked', async () => {
    // Waiting task created FIRST (oldest under updated_at_asc).
    await submitTargetingTurn10('mcp_1700000000043_3c000043');
    await stateManager.createTask({
      taskId: 'diagnosis_blocked_by_consent_1',
      taskKind: 'diagnostician',
      inputRef: 'pain_blocked_by_consent_1',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        sourcePainId: 'pain_blocked_by_consent_1',
        reasonSummary: 'target evidence was revoked',
        provenance: 'owner_reported_no_host_trace',
        evidence: [],
        recovery: {
          schemaVersion: 1,
          state: 'blocked_by_source_material_consent',
          reasonCode: 'target_turn_source_material_consent_revoked',
          attemptCount: 1,
          lastCheckedAt: new Date().toISOString(),
        },
      }),
    });

    // A plain admissible diagnostician task is created after both blocked rows.
    await stateManager.createTask({
      taskId: 'diagnosis_admissible_1',
      taskKind: 'diagnostician',
      inputRef: 'pain_admissible_1',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: JSON.stringify({ sourcePainId: 'pain_admissible_1', reasonSummary: 'plain', provenance: 'automatic_hook' }),
    });

    // limit 1: without the WHERE-clause exclusion the waiting task would
    // occupy the window and the admissible task would starve behind it.
    const picked = await pickDiagnosticianCandidate(stateManager, 1, new Date().toISOString());
    expect(picked?.taskId).toBe('diagnosis_admissible_1');

    // The positive filter finds the waiting task for the reconcile.
    const waiting = await stateManager.listTasks({ taskKind: 'diagnostician', status: 'pending', recoveryState: 'waiting_for_target_evidence', limit: 5 });
    expect(waiting.map((task) => task.taskId)).toEqual([createDiagnosticianTaskId('mcp_1700000000043_3c000043')]);
    const blocked = await stateManager.listTasks({ taskKind: 'diagnostician', status: 'pending', recoveryState: 'blocked_by_source_material_consent', limit: 5 });
    expect(blocked.map((task) => task.taskId)).toEqual(['diagnosis_blocked_by_consent_1']);
  });

  it('the candidate picker preserves legacy minimal-identity blocked_by_consent tasks', async () => {
    await stateManager.createTask({
      taskId: 'diagnosis_identity_metadata_blocked_1',
      taskKind: 'diagnostician',
      inputRef: 'pain_identity_metadata_blocked_1',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        sourcePainId: 'pain_identity_metadata_blocked_1',
        reasonSummary: 'minimal identity metadata was not authorized',
        provenance: 'owner_reported_no_host_trace',
        evidence: [],
        recovery: {
          schemaVersion: 1,
          state: 'blocked_by_consent',
          reasonCode: 'minimal_identity_metadata_not_granted',
          attemptCount: 1,
          lastCheckedAt: new Date().toISOString(),
        },
      }),
    });
    const picked = await pickDiagnosticianCandidate(stateManager, 1, new Date().toISOString());
    expect(picked?.taskId).toBe('diagnosis_identity_metadata_blocked_1');
  });

  it('executePendingDiagnosis refuses a waiting task even when invoked directly (manual runs too)', async () => {
    const painId = 'mcp_1700000000044_4d000044';
    await submitTargetingTurn10(painId);
    const bridge = new PainSignalBridge({
      stateManager,
      runner: { run: async () => { throw new Error('must not run'); } } satisfies DiagnosticianRunnerLike,
      workspaceDir: tmpDir,
      intakeService: {} as never,
      ledgerAdapter: { register: () => undefined, existsForCandidate: () => undefined, getEntries: () => [] } as never,
    });
    const result = await bridge.executePendingDiagnosis({ taskId: createDiagnosticianTaskId(painId) });
    expect(result.status).toBe('skipped');
    expect(result.message).toBe('target_evidence_pending');
  });

  it('executePendingDiagnosis refuses a consent-blocked task even when invoked directly', async () => {
    const painId = 'mcp_1700000000046_6f000046';
    const taskId = createDiagnosticianTaskId(painId);
    await stateManager.createTask({
      taskId,
      taskKind: 'diagnostician',
      inputRef: painId,
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        sourcePainId: painId,
        reasonSummary: 'target evidence was revoked',
        provenance: 'host_context_bound',
        evidence: [],
        recovery: {
          schemaVersion: 1,
          state: 'blocked_by_source_material_consent',
          reasonCode: 'target_turn_source_material_consent_revoked',
          attemptCount: 1,
          lastCheckedAt: new Date().toISOString(),
        },
      }),
    });
    const bridge = new PainSignalBridge({
      stateManager,
      runner: { run: async () => { throw new Error('must not run'); } } satisfies DiagnosticianRunnerLike,
      workspaceDir: tmpDir,
      intakeService: {} as never,
      ledgerAdapter: { register: () => undefined, existsForCandidate: () => undefined, getEntries: () => [] } as never,
    });
    const result = await bridge.executePendingDiagnosis({ taskId });
    expect(result.status).toBe('skipped');
    expect(result.message).toBe('target_evidence_blocked_by_consent');
  });

  it('the direct bridge does not confuse minimal-identity blocked_by_consent with source-material denial', async () => {
    const painId = 'mcp_1700000000047_7a000047';
    const taskId = createDiagnosticianTaskId(painId);
    await stateManager.createTask({
      taskId,
      taskKind: 'diagnostician',
      inputRef: painId,
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        sourcePainId: painId,
        reasonSummary: 'Owner-provided pain without host identity metadata',
        provenance: 'owner_reported_no_host_trace',
        evidence: [],
        recovery: {
          schemaVersion: 1,
          state: 'blocked_by_consent',
          reasonCode: 'minimal_identity_metadata_not_granted',
          attemptCount: 1,
          lastCheckedAt: new Date().toISOString(),
        },
      }),
    });
    const bridge = new PainSignalBridge({
      stateManager,
      runner: { run: async () => { throw new Error('legacy blocked_by_consent is still diagnosable'); } } satisfies DiagnosticianRunnerLike,
      workspaceDir: tmpDir,
      intakeService: {} as never,
      ledgerAdapter: { register: () => undefined, existsForCandidate: () => undefined, getEntries: () => [] } as never,
    });
    await expect(bridge.executePendingDiagnosis({ taskId })).rejects.toThrow('legacy blocked_by_consent is still diagnosable');
  });
});

describe('P1-3 — the worker reconcile is the only exit from waiting', () => {
  it('still waiting while the target text is absent; flipped once it exists; flip is CAS-protected', async () => {
    const painId = 'mcp_1700000000045_5e000045';
    const taskId = createDiagnosticianTaskId(painId);
    await submitTargetingTurn10(painId);

    // Text not yet collected: the reconcile reports still-waiting, no write.
    const before = await reconcileWaitingTargetEvidenceTasks({
      stateManager,
      readTargetTurnEvidence: () => ({ status: 'not_found' }),
      nowIso: new Date().toISOString(),
    });
    expect(before.checked).toBe(1);
    expect(before.flipped).toBe(0);
    expect(before.stillWaiting).toBe(1);
    expect((await readDiagnostic(taskId)).sessionIdHint === undefined).toBe(false);

    // Text arrived (e.g. catch-up ingested the turn): the disposition flips
    // on the SAME task via CAS — and PRI-1273 backfills the evidence +
    // evidenceClass in the SAME write.
    const after = await reconcileWaitingTargetEvidenceTasks({
      stateManager,
      readTargetTurnEvidence: () => ({
        status: 'available',
        entries: [{ sourceRef: 'governance_observation:codex|rollout-target|turn-10|user_turn', note: 'turn ten body' }],
      }),
      nowIso: new Date().toISOString(),
    });
    expect(after.flipped).toBe(1);
    expect(after.backfilled).toBe(1);
    const diagnostic = await readDiagnostic(taskId);
    const recovery = diagnostic.recovery as Record<string, unknown>;
    expect(recovery.state).toBe('ready_for_diagnosis');
    expect(recovery.reasonCode).toBe('target_evidence_arrived');
    expect(recovery.attemptCount).toBe(2);
    expect(recovery.resolvedAt).toBeDefined();
    // PRI-1273 (A2): the real evidence array and its evidenceClass land on
    // the SAME original task, consistent for the read-back validator.
    expect(diagnostic.evidence).toEqual([
      { sourceRef: 'governance_observation:codex|rollout-target|turn-10|user_turn', note: 'turn ten body' },
    ]);
    const painIngress = diagnostic.painIngress as Record<string, unknown>;
    expect(painIngress.evidenceClass).toEqual({ status: 'available', entryCount: 1 });
    const reparsed = parsePainIngressV1Payload(painIngress);
    expect(reparsed.ok).toBe(true);

    // Now the picker serves it.
    const picked = await pickDiagnosticianCandidate(stateManager, 1, new Date().toISOString());
    expect(picked?.taskId).toBe(taskId);

    // A malformed waiting payload is reported, never silently dropped.
    await stateManager.createTask({
      taskId: 'diagnosis_malformed_waiting',
      taskKind: 'diagnostician',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: JSON.stringify({ recovery: { state: 'waiting_for_target_evidence', attemptCount: 1 } }),
    });
    const malformed = await reconcileWaitingTargetEvidenceTasks({
      stateManager,
      readTargetTurnEvidence: () => ({ status: 'available', entries: [{ sourceRef: 'x', note: 'y' }] }),
      nowIso: new Date().toISOString(),
    });
    expect(malformed.errors.some((line) => line.includes('diagnosis_malformed_waiting'))).toBe(true);
  });
});

describe('T6 — the assembler reads EXACTLY the named target turn (never 11/12)', () => {
  /** A reader over a store that holds turns 10, 11 and 12 of the session. */
  function makeReader(withById: boolean): TrajectoryTurnReader {
    const turn = (id: number, text: string): TrajectoryUserTurn => ({
      id, turnIndex: id, rawExcerpt: text, correctionDetected: false, correctionCue: null, createdAt: `2026-11-22T00:00:${id}s`.replace(`${id}s`, `${String(id).padStart(2, '0')}Z`),
    });
    const byId = new Map<string, TrajectoryUserTurn>([
      ['turn-10', turn(10, 'OWNER: please follow the review checklist before merging.')],
      ['turn-11', turn(11, 'assistant filler between the turns')],
      ['turn-12', turn(12, 'the submission turn (must never substitute the target)')],
    ]);
    const reader: TrajectoryTurnReader = {
      listUserTurnsForSession: (sessionId) => (sessionId === 'rollout-target' ? [...byId.values()] : []),
      listAssistantTurns: () => [],
      ...(withById
        ? {
          listTurnTextsForHostTurnId: (sessionId: string, hostTurnId: string, hostKind?: string) => ({
            // EXACT (host, session, turn) semantics: only the named turn,
            // and only for the owning host kind.
            userTurns: hostKind === 'codex' && sessionId === 'rollout-target' && byId.has(hostTurnId)
              ? [byId.get(hostTurnId) as TrajectoryUserTurn]
              : [],
            assistantTurns: [],
          }),
        }
        : {}),
    };
    return reader;
  }

  async function assembleWith(reader: TrajectoryTurnReader, targetTurnId?: string) {
    // Seed a diagnostician task whose diagnostic_json mirrors the recovered
    // shape (bound session + named target).
    const taskId = `diagnosis_asm_${Math.random().toString(36).slice(2, 8)}`;
    await stateManager.createTask({
      taskId,
      taskKind: 'diagnostician',
      inputRef: 'pain_asm',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        sourcePainId: 'pain_asm',
        reasonSummary: 'assembler fixture',
        source: 'mcp_agent_assisted',
        provenance: 'host_context_bound',
        sessionIdHint: 'rollout-target',
        hostKind: 'codex',
        workspaceDir: tmpDir,
        evidence: [],
        ...(targetTurnId === undefined ? {} : { painIngress: { version: 'v1', origin: { kind: 'owner_manual', channel: 'mcp_agent_assisted' }, correlation: { status: 'bound', sessionId: 'rollout-target' }, evidenceClass: { status: 'unavailable', reason: 'not_applicable_unbound' }, verifiedHostSession: { status: 'verified', sessionId: 'rollout-target', submissionTurnId: 'turn-12', targetTurnId } } }),
      }),
    });
    const connection = new SqliteConnection(tmpDir);
    try {
      const assembler = new SqliteContextAssembler(
        new SqliteTaskStore(connection),
        new SqliteHistoryQuery(connection),
        new SqliteRunStore(connection),
        { trajectoryTurnReader: reader },
      );
      return await assembler.assemble(taskId);
    } finally {
      connection.close();
    }
  }

  it('a task naming turn 10 gets ONLY turn 10 — turns 11 and 12 never substitute', async () => {
    const payload = await assembleWith(makeReader(true), 'turn-10');
    const texts = payload.conversationWindow.map((entry) => entry.text).join('\n');
    expect(texts).toContain('review checklist');
    expect(texts).not.toContain('filler between the turns');
    expect(texts).not.toContain('must never substitute the target');
  });

  it('without a named target the session-level policy is unchanged (all turns visible)', async () => {
    const payload = await assembleWith(makeReader(true), undefined);
    const texts = payload.conversationWindow.map((entry) => entry.text).join('\n');
    expect(texts).toContain('review checklist');
    expect(texts).toContain('filler between the turns');
  });

  it('a reader without by-turn-id support yields NO substitution — observable note, empty window', async () => {
    const payload = await assembleWith(makeReader(false), 'turn-10');
    expect(payload.conversationWindow.length).toBe(0);
    expect((payload.ambiguityNotes ?? []).some((note) => note.includes('session-wide substitution skipped'))).toBe(true);
  });

  it('a named target whose text is missing yields no substitution either (waiting is the honest state)', async () => {
    const payload = await assembleWith(makeReader(true), 'turn-99');
    expect(payload.conversationWindow.length).toBe(0);
    expect((payload.ambiguityNotes ?? []).some((note) => note.includes('turn-99') && note.includes('no readable text'))).toBe(true);
  });
});

// ── r2b (devin review round): explicit-target hint, waiting fairness, manual-run guard ──

describe('r2b (0001) — the receipt recovery honors the EXPLICIT target the unbound submission named', () => {
  it('an unbound submission naming turn 10 recovers with turn 10 as target — never the submission turn 12', async () => {
    const painId = 'mcp_1700000000061_9f000061';
    const receipt = await submitPainCapability(
      {
        workspaceDir: tmpDir,
        stateDir: path.join(tmpDir, '.state'),
        painId,
        taskId: createDiagnosticianTaskId(painId),
        hostKind: 'codex',
        verifyHostSession: () => ({ status: 'unverified', detail: 'codex_host_metadata_missing' }),
      },
      {
        reason: 'Anchor: agent instruction. Observed: behavior. Deviation: mismatch.',
        anchorType: 'agent_instruction',
        anchorRef: 'AGENTS.md#safety',
        painType: 'user_frustration',
        targetTurnId: 'turn-10',
      },
    );
    expect(receipt.status).toBe('submitted');

    // The unbound task keeps the shape-validated (NOT host-verified) hint.
    const taskId = createDiagnosticianTaskId(painId);
    const persisted = await readDiagnostic(taskId);
    const ingress = parsePainIngressV1Payload(persisted.painIngress);
    expect(ingress.ok).toBe(true);
    if (!ingress.ok) return;
    expect(ingress.payload.requestedTargetTurnId).toBe('turn-10');

    // The PostToolUse event carries the submission turn (12); recovery must
    // bind the session AND restore the EXPLICIT target (10).
    const validated = validatePainSubmitReceipt({
      schemaVersion: 'pd.pain-submit-receipt.v1',
      capability: 'pd_submit_pain',
      status: 'submitted',
      painId,
      taskId,
      workspaceDir: tmpDir,
      sessionAssociation: { status: 'unverified', detail: 'codex_host_metadata_missing' },
    }, { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: { sessionId: 'rollout-hint', submissionTurnId: 'turn-12', toolCallId: 'call-hint-1' },
      authorization: { minimalMetadataGranted: true },
    });
    expect(outcome.status).toBe('recovered');
    const diagnostic = await readDiagnostic(taskId);
    const verified = parsePainIngressV1Payload(diagnostic.painIngress);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.payload.verifiedHostSession).toEqual({
      status: 'verified', sessionId: 'rollout-hint', submissionTurnId: 'turn-12', targetTurnId: 'turn-10',
    });
    // Turn 10's text is absent → the SAME explicit turn is what it waits for.
    const recovery = diagnostic.recovery as Record<string, unknown>;
    expect(recovery.state).toBe('waiting_for_target_evidence');
  });

  it('r2b (0004): an owner_expectation submission recovers straight to ready_for_diagnosis (one shared waiting rule)', async () => {
    const painId = 'mcp_1700000000062_8e000062';
    const receipt = await submitPainCapability(
      {
        workspaceDir: tmpDir,
        stateDir: path.join(tmpDir, '.state'),
        painId,
        taskId: createDiagnosticianTaskId(painId),
        hostKind: 'codex',
        verifyHostSession: () => ({ status: 'unverified', detail: 'codex_host_metadata_missing' }),
      },
      {
        reason: 'Anchor: owner expectation. Observed: behavior. Deviation: mismatch.',
        anchorType: 'owner_expectation',
        anchorRef: 'Owner statement in this conversation',
        painType: 'user_frustration',
        targetTurnId: 'turn-10',
      },
    );
    expect(receipt.status).toBe('submitted');
    const taskId = createDiagnosticianTaskId(painId);
    const validated = validatePainSubmitReceipt({
      schemaVersion: 'pd.pain-submit-receipt.v1',
      capability: 'pd_submit_pain',
      status: 'submitted',
      painId,
      taskId,
      workspaceDir: tmpDir,
      sessionAssociation: { status: 'unverified', detail: 'codex_host_metadata_missing' },
    }, { workspaceDir: tmpDir });
    if (!validated.ok) throw new Error('fixture receipt invalid');
    const outcome = await recoverTaskIdentityFromReceipt({
      workspaceDir: tmpDir, hostKind: 'codex', receipt: validated.receipt,
      identity: { sessionId: 'rollout-owner', submissionTurnId: 'turn-12', toolCallId: 'call-owner-1' },
      authorization: { minimalMetadataGranted: true },
    });
    expect(outcome.status).toBe('recovered');
    if (outcome.status !== 'recovered') return;
    // Explicit Owner statement = independently admissible: the submit path
    // and the recovery share ONE rule (targetEvidenceWaitRequired), so the
    // recovered task never waits for text that will not come.
    expect(outcome.disposition.state).toBe('ready_for_diagnosis');
  });
});

describe('r2b (0002) — the waiting reconcile rotates; the oldest five cannot starve the sixth', () => {
  it('a full page advances the cursor, the next pass reaches the sixth task and flips it', async () => {
    // Six waiting tasks, each naming its own target turn; only turn-06 has text.
    for (let index = 1; index <= 6; index += 1) {
      const painId = `mcp_170000000007${index}_a000006${index}`;
      const receipt = await submitPainCapability(
        {
          workspaceDir: tmpDir,
          stateDir: path.join(tmpDir, '.state'),
          painId,
          taskId: createDiagnosticianTaskId(painId),
          hostKind: 'codex',
          verifyHostSession: () => ({ status: 'verified', sessionId: `rollout-fair-${index}`, targetTurnId: `turn-0${index}` }),
        },
        {
          reason: 'Anchor: agent instruction. Observed: behavior. Deviation: mismatch.',
          anchorType: 'agent_instruction',
          anchorRef: 'AGENTS.md#safety',
          painType: 'user_frustration',
        },
      );
      expect(receipt.status).toBe('submitted');
    }
    const probe = (_sessionId: string, turnId: string): TargetTurnEvidenceRead =>
      turnId === 'turn-06'
        ? { status: 'available', entries: [{ sourceRef: 'governance_observation:codex|x|turn-06|user_turn', note: 'turn six body' }] }
        : { status: 'not_found' };

    // Default limit 5: the first pass sees the five OLDEST (no text).
    const first = await reconcileWaitingTargetEvidenceTasks({ stateManager, readTargetTurnEvidence: probe, nowIso: new Date().toISOString() });
    expect(first.checked).toBe(5);
    expect(first.flipped).toBe(0);
    expect(first.stillWaiting).toBe(5);

    // Second pass rotates past them and reaches the sixth — which flips.
    const second = await reconcileWaitingTargetEvidenceTasks({ stateManager, readTargetTurnEvidence: probe, nowIso: new Date().toISOString() });
    expect(second.checked).toBe(1);
    expect(second.flipped).toBe(1);
  });
});

describe('r2b (0003) — the split pipeline (manual pd diagnose run) refuses waiting tasks before the lease', () => {
  it('returns a structured refusal with zero lease, zero runs and the task still pending', async () => {
    const { SplitDiagnosticianRunner } = await import('../internalization/split-diagnostician-runner.js');
    const { DiagRootCauseRunner } = await import('../internalization/diag-rootcause-runner.js');
    const { DiagDistillerRunner } = await import('../internalization/diag-distiller-runner.js');
    const { DiagRouterRunner } = await import('../internalization/diag-router-runner.js');
    const { PiAiRuntimeAdapter } = await import('../adapter/pi-ai-runtime-adapter.js');
    const { SqliteDiagnosticianCommitter } = await import('../store/commit/diagnostician-committer.js');
    const { DefaultDiagRootCauseValidator } = await import('../diagnostician/diag-rootcause-output.js');
    const { DefaultDiagDistillerValidator } = await import('../diagnostician/diag-distiller-output.js');

    const taskId = 'diagnosis_waiting_manual_1';
    await stateManager.createTask({
      taskId,
      taskKind: 'diagnostician',
      inputRef: 'pain_waiting_manual_1',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        sourcePainId: 'pain_waiting_manual_1',
        reasonSummary: 'waiting fixture',
        provenance: 'host_context_bound',
        hostKind: 'codex',
        workspaceDir: tmpDir,
        evidence: [],
        painIngress: {
          version: 'v1',
          origin: { kind: 'owner_manual', channel: 'mcp_agent_assisted' },
          correlation: { status: 'unbound', reason: 'missing_host_session' },
          evidenceClass: { status: 'unavailable', reason: 'not_applicable_unbound' },
          verifiedHostSession: { status: 'verified', sessionId: 'rollout-manual', targetTurnId: 'turn-manual-1' },
        },
        recovery: { schemaVersion: 1, state: 'waiting_for_target_evidence', reasonCode: 'target_turn_text_pending', attemptCount: 1, lastCheckedAt: new Date().toISOString() },
      }),
    });

    const eventEmitter: { emitTelemetry: () => void } = { emitTelemetry: () => undefined };
    const runtimeAdapter = new PiAiRuntimeAdapter({
      provider: 'openrouter',
      model: 'test-model',
      apiKeyEnv: 'PD_TEST_UNUSED_KEY',
      outputPathStrategy: 'free_form_only',
      systemPrompt: 'test',
    });
    const options = { owner: 'test-owner', runtimeKind: 'openclaw', pollIntervalMs: 10, timeoutMs: 1000 };
    const contextAssembler = new SqliteContextAssembler(
      stateManager.taskStore,
      new SqliteHistoryQuery(stateManager.connection),
      stateManager.runStore,
    );
    const committer = new SqliteDiagnosticianCommitter(stateManager.connection);
    const splitRunner = new SplitDiagnosticianRunner({
      rootCauseRunner: new DiagRootCauseRunner(
        { stateManager, runtimeAdapter, eventEmitter, artifactStore: stateManager.piArtifactStore, validator: new DefaultDiagRootCauseValidator(), contextAssembler },
        options,
      ),
      distillerRunner: new DiagDistillerRunner(
        { stateManager, runtimeAdapter, eventEmitter, artifactStore: stateManager.piArtifactStore, validator: new DefaultDiagDistillerValidator() },
        options,
      ),
      routerRunner: new DiagRouterRunner(
        { stateManager, runtimeAdapter, eventEmitter, artifactStore: stateManager.piArtifactStore, committer, trustedPrincipleSource: { readTrustedPrinciples: () => ({ status: 'ok', principles: [] }) } },
        options,
      ),
      stateManager,
      committer,
    });

    const result = await splitRunner.run(taskId);
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failureReason).toContain('target_evidence_pending');
    expect(result.attemptCount).toBe(0);
    // No lease was taken and no run record exists — the task is untouched.
    const task = await stateManager.getTask(taskId);
    expect(task?.status).toBe('pending');
    expect(task?.leaseOwner ?? null).toBeNull();
    expect(await stateManager.runStore.listRunsByTask(taskId)).toEqual([]);
  });
});

describe('PRI-1273 (A2) — the reconcile backfills the arrived evidence onto the SAME task', () => {
  const TURN10_ENTRIES = [
    { sourceRef: 'governance_observation:codex|rollout-1273|turn-10|user_turn', note: 'turn ten user body' },
    { sourceRef: 'governance_observation:codex|rollout-1273|turn-10|assistant_turn', note: 'turn ten assistant body' },
  ];

  it('the reader receives the EXACT (session, target turn) — turn 12\'s submission reads turn 10 only', async () => {
    const painId = 'mcp_1700000001273_a0000001';
    await submitTargetingTurn10(painId);
    const seen: [string, string][] = [];
    const report = await reconcileWaitingTargetEvidenceTasks({
      stateManager,
      readTargetTurnEvidence: (sessionId, turnId) => {
        seen.push([sessionId, turnId]);
        return { status: 'available', entries: TURN10_ENTRIES };
      },
      nowIso: new Date().toISOString(),
    });
    expect(seen).toEqual([['rollout-target', 'turn-10']]);
    expect(report.backfilled).toBe(1);
    // The backfill carries ONLY the target turn's rows — count and content
    // agree, and the full read-back consistency contract accepts the payload.
    const diagnostic = await readDiagnostic(createDiagnosticianTaskId(painId));
    expect(diagnostic.evidence).toEqual(TURN10_ENTRIES);
    const painIngress = diagnostic.painIngress as Record<string, unknown>;
    expect(painIngress.evidenceClass).toEqual({ status: 'available', entryCount: 2 });
    const parsedIngress = parsePainIngressV1Payload(painIngress);
    expect(parsedIngress.ok).toBe(true);
    if (!parsedIngress.ok) return;
    expect(checkIngressTopLevelConsistency({
      payload: parsedIngress.payload,
      topLevelProvenance: diagnostic.provenance,
      topLevelSessionIdHint: diagnostic.sessionIdHint,
      topLevelEvidenceCount: TURN10_ENTRIES.length,
    })).toBeNull();
  });

  it('a source-material consent denial is NOT a wait — the task is reclassified blocked with the reason', async () => {
    const painId = 'mcp_1700000001273_a0000002';
    const taskId = createDiagnosticianTaskId(painId);
    await submitTargetingTurn10(painId);
    const report = await reconcileWaitingTargetEvidenceTasks({
      stateManager,
      readTargetTurnEvidence: () => ({ status: 'blocked_by_consent', reason: 'consent_revoked' }),
      nowIso: new Date().toISOString(),
    });
    expect(report.blocked).toBe(1);
    expect(report.flipped).toBe(0);
    const diagnostic = await readDiagnostic(taskId);
    const recovery = diagnostic.recovery as Record<string, unknown>;
    expect(recovery.state).toBe('blocked_by_source_material_consent');
    expect(recovery.reasonCode).toBe('target_turn_source_material_consent_revoked');
    // No evidence was persisted from a denied source, and the class never
    // claims availability.
    expect(diagnostic.evidence).toEqual([]);
    const painIngress = diagnostic.painIngress as Record<string, unknown>;
    expect((painIngress.evidenceClass as Record<string, unknown>).status).toBe('unavailable');
    // The blocked task leaves the waiting set: a second reconcile does not
    // touch it again, and the picker excludes it.
    const second = await reconcileWaitingTargetEvidenceTasks({
      stateManager,
      readTargetTurnEvidence: () => ({ status: 'blocked_by_consent', reason: 'consent_revoked' }),
      nowIso: new Date().toISOString(),
    });
    expect(second.checked).toBe(0);
    expect(await pickDiagnosticianCandidate(stateManager, 5, new Date().toISOString())).toBeNull();
  });

  it('consent_missing and consent_not_granted denials carry their own reason codes', async () => {
    for (const [suffix, reason] of [['3', 'consent_missing'], ['4', 'consent_not_granted']] as const) {
      const painId = `mcp_1700000001273_a00000${suffix}`;
      await submitTargetingTurn10(painId);
      const report = await reconcileWaitingTargetEvidenceTasks({
        stateManager,
        readTargetTurnEvidence: () => ({ status: 'blocked_by_consent', reason }),
        nowIso: new Date().toISOString(),
      });
      expect(report.blocked).toBe(1);
      const diagnostic = await readDiagnostic(createDiagnosticianTaskId(painId));
      expect((diagnostic.recovery as Record<string, unknown>).reasonCode).toBe(`target_turn_source_material_${reason}`);
    }
  });

  it('a store read failure is an observable error, never a flip and never a block', async () => {
    const painId = 'mcp_1700000001273_a0000005';
    const taskId = createDiagnosticianTaskId(painId);
    await submitTargetingTurn10(painId);
    const report = await reconcileWaitingTargetEvidenceTasks({
      stateManager,
      readTargetTurnEvidence: () => ({ status: 'read_failed', reason: 'sqlite_locked' }),
      nowIso: new Date().toISOString(),
    });
    expect(report.flipped).toBe(0);
    expect(report.blocked).toBe(0);
    expect(report.errors.some((line) => line.includes('target_evidence_read_failed') && line.includes(taskId))).toBe(true);
    // The task keeps waiting untouched — a transient store failure must not
    // burn the one recovery classification.
    const diagnostic = await readDiagnostic(taskId);
    expect((diagnostic.recovery as Record<string, unknown>).state).toBe('waiting_for_target_evidence');
  });

  it('invalid entries from the reader are rejected element-wise (rc-4), never partially persisted', async () => {
    const painId = 'mcp_1700000001273_a0000006';
    const taskId = createDiagnosticianTaskId(painId);
    await submitTargetingTurn10(painId);
    const badEntriesCases: unknown[][] = [
      [{ sourceRef: 'x', note: 'ok' }, { sourceRef: '', note: 'empty ref' }],
      [{ sourceRef: 'x', note: 'ok' }, { sourceRef: 'y', note: 42 }],
      [{ sourceRef: 'x', note: 'ok' }, 'not-an-object'],
      [{ sourceRef: 'x', note: 'ok', extra: 'field' }],
      [],
    ];
    for (const entries of badEntriesCases) {
      const report = await reconcileWaitingTargetEvidenceTasks({
        stateManager,
        readTargetTurnEvidence: () => ({ status: 'available', entries: entries as never }),
        nowIso: new Date().toISOString(),
      });
      expect(report.flipped).toBe(0);
      expect(report.errors.some((line) => line.includes('target_evidence_read_invalid_entries'))).toBe(true);
    }
    const diagnostic = await readDiagnostic(taskId);
    expect((diagnostic.recovery as Record<string, unknown>).state).toBe('waiting_for_target_evidence');
    expect(diagnostic.evidence).toEqual([]);
  });

  it('idempotent: a repeated catch-up after the flip writes nothing new (the task left the waiting set)', async () => {
    const painId = 'mcp_1700000001273_a0000007';
    const taskId = createDiagnosticianTaskId(painId);
    await submitTargetingTurn10(painId);
    const first = await reconcileWaitingTargetEvidenceTasks({
      stateManager,
      readTargetTurnEvidence: () => ({ status: 'available', entries: TURN10_ENTRIES }),
      nowIso: new Date().toISOString(),
    });
    expect(first.backfilled).toBe(1);
    const second = await reconcileWaitingTargetEvidenceTasks({
      stateManager,
      readTargetTurnEvidence: () => ({ status: 'available', entries: TURN10_ENTRIES }),
      nowIso: new Date().toISOString(),
    });
    expect(second.checked).toBe(0);
    expect(second.flipped).toBe(0);
    expect(second.backfilled).toBe(0);
    const diagnostic = await readDiagnostic(taskId);
    expect((diagnostic.evidence as unknown[]).length).toBe(2);
    expect((diagnostic.recovery as Record<string, unknown>).attemptCount).toBe(2);
  });

  it('an actively leased waiting task is never mutated by the reconcile (P1-4 parity)', async () => {
    const painId = 'mcp_1700000001273_a0000008';
    const taskId = createDiagnosticianTaskId(painId);
    await submitTargetingTurn10(painId);
    const acquisition = await stateManager.acquireLeaseDetailed({
      taskId,
      owner: 'external-worker',
      runtimeKind: 'pi-ai',
      durationMs: 60_000,
    });
    const before = await readDiagnostic(taskId);
    const report = await reconcileWaitingTargetEvidenceTasks({
      stateManager,
      readTargetTurnEvidence: () => ({ status: 'available', entries: TURN10_ENTRIES }),
      nowIso: new Date().toISOString(),
    });
    // The CAS preconditions (expected lease owner/expiry) defeat the write:
    // the task stays byte-identical under the active lease.
    expect(report.flipped + report.blocked).toBe(0);
    const after = await readDiagnostic(taskId);
    expect(after).toEqual(before);
    expect(acquisition.task.leaseOwner).toBe('external-worker');
  });

  it('a terminal waiting-shaped task is never reopened', async () => {
    const painId = 'mcp_1700000001273_a0000009';
    const taskId = createDiagnosticianTaskId(painId);
    await submitTargetingTurn10(painId);
    await stateManager.updateTask(taskId, { status: 'failed' });
    const before = await readDiagnostic(taskId);
    const report = await reconcileWaitingTargetEvidenceTasks({
      stateManager,
      readTargetTurnEvidence: () => ({ status: 'available', entries: TURN10_ENTRIES }),
      nowIso: new Date().toISOString(),
    });
    // The store query filters status=pending, so the failed task is not even
    // examined — no write, no reopen.
    expect(report.checked).toBe(0);
    const task = await stateManager.getTask(taskId);
    expect(task?.status).toBe('failed');
    expect(JSON.parse(task?.diagnosticJson ?? '{}')).toEqual(before);
  });

  it('a waiting task that already carries evidence flips without touching the existing array', async () => {
    const painId = 'mcp_1700000001273_a0000010';
    const taskId = createDiagnosticianTaskId(painId);
    await submitTargetingTurn10(painId);
    // Another path (e.g. PRI-1283's sweep shape) already wrote one entry
    // with a matching evidenceClass.
    const diagnostic = await readDiagnostic(taskId);
    const existing = [{ sourceRef: 'codex:correction', note: 'owner correction' }];
    await stateManager.updateTaskIfDiagnosticJsonUnchanged(
      taskId,
      JSON.stringify(diagnostic),
      { diagnosticJson: JSON.stringify({
        ...diagnostic,
        evidence: existing,
        painIngress: { ...(diagnostic.painIngress as Record<string, unknown>), evidenceClass: { status: 'available', entryCount: 1 } },
      }) },
    );
    const report = await reconcileWaitingTargetEvidenceTasks({
      stateManager,
      readTargetTurnEvidence: () => ({ status: 'available', entries: TURN10_ENTRIES }),
      nowIso: new Date().toISOString(),
    });
    expect(report.flipped).toBe(1);
    expect(report.backfilled).toBe(0);
    const after = await readDiagnostic(taskId);
    expect(after.evidence).toEqual(existing);
    expect(((after.painIngress as Record<string, unknown>).evidenceClass as Record<string, unknown>).entryCount).toBe(1);
  });

  it('devin BUG_0001: the LEGACY boolean probe still works against this Core (old published adapter) — flip-only, no evidence, no consent classification, never a throw', async () => {
    const painId = 'mcp_1700000001273_a0000011';
    const taskId = createDiagnosticianTaskId(painId);
    await submitTargetingTurn10(painId);

    // Legacy probe false: still waiting, no write.
    const before = await reconcileWaitingTargetEvidenceTasks({
      stateManager,
      targetTurnTextAvailable: () => false,
      nowIso: new Date().toISOString(),
    });
    expect(before).toMatchObject({ checked: 1, flipped: 0, stillWaiting: 1 });

    // Legacy probe true: the disposition flips with NO evidence write —
    // exactly the pre-PRI-1273 behavior an old adapter expects.
    const after = await reconcileWaitingTargetEvidenceTasks({
      stateManager,
      targetTurnTextAvailable: () => true,
      nowIso: new Date().toISOString(),
    });
    expect(after).toMatchObject({ checked: 1, flipped: 1, backfilled: 0, blocked: 0 });
    const diagnostic = await readDiagnostic(taskId);
    expect((diagnostic.recovery as Record<string, unknown>).state).toBe('ready_for_diagnosis');
    expect(diagnostic.evidence).toEqual([]);
    // The class keeps its creation-time honest `unavailable` — a legacy
    // flip must never fabricate availability without entries.
    expect((diagnostic.painIngress as Record<string, unknown>).evidenceClass).toEqual({ status: 'unavailable', reason: 'not_applicable_unbound' });
  });

  it('devin BUG_0001: a caller wiring NEITHER probe gets a loud per-task error, never a throw that degrades the whole cycle', async () => {
    const painId = 'mcp_1700000001273_a0000012';
    const taskId = createDiagnosticianTaskId(painId);
    await submitTargetingTurn10(painId);
    const report = await reconcileWaitingTargetEvidenceTasks({
      stateManager,
      nowIso: new Date().toISOString(),
    });
    expect(report.checked).toBe(1);
    expect(report.flipped + report.blocked).toBe(0);
    expect(report.errors.some((line) => line.includes('target_evidence_reconcile_unconfigured') && line.includes(taskId))).toBe(true);
    const task = await stateManager.getTask(taskId);
    expect(task?.status).toBe('pending');
  });
});
