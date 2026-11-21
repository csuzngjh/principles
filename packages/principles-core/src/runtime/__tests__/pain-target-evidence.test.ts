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
 *  2. The candidate picker excludes waiting tasks INSIDE the store query —
 *     before ORDER BY/LIMIT — so a waiting task never displaces an
 *     admissible one from the bounded window.
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
import { reconcileWaitingTargetEvidenceTasks } from '../pain-target-evidence-reconcile.js';
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

describe('P1-3.4 — candidate picker excludes waiting tasks before ORDER BY/LIMIT', () => {
  it('the OLDEST task being waiting does not consume the bounded window — the admissible task is picked', async () => {
    // Waiting task created FIRST (oldest under updated_at_asc).
    await submitTargetingTurn10('mcp_1700000000043_3c000043');
    // A plain admissible diagnostician task created SECOND.
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
});

describe('P1-3 — the worker reconcile is the only exit from waiting', () => {
  it('still waiting while the target text is absent; flipped once it exists; flip is CAS-protected', async () => {
    const painId = 'mcp_1700000000045_5e000045';
    const taskId = createDiagnosticianTaskId(painId);
    await submitTargetingTurn10(painId);

    // Text not yet collected: the reconcile reports still-waiting, no write.
    const before = await reconcileWaitingTargetEvidenceTasks({
      stateManager,
      targetTurnTextAvailable: () => false,
      nowIso: new Date().toISOString(),
    });
    expect(before.checked).toBe(1);
    expect(before.flipped).toBe(0);
    expect(before.stillWaiting).toBe(1);
    expect((await readDiagnostic(taskId)).sessionIdHint === undefined).toBe(false);

    // Text arrived (e.g. catch-up ingested the turn): the disposition flips
    // on the SAME task via CAS.
    const after = await reconcileWaitingTargetEvidenceTasks({
      stateManager,
      targetTurnTextAvailable: () => true,
      nowIso: new Date().toISOString(),
    });
    expect(after.flipped).toBe(1);
    const diagnostic = await readDiagnostic(taskId);
    const recovery = diagnostic.recovery as Record<string, unknown>;
    expect(recovery.state).toBe('ready_for_diagnosis');
    expect(recovery.reasonCode).toBe('target_evidence_arrived');
    expect(recovery.attemptCount).toBe(2);
    expect(recovery.resolvedAt).toBeDefined();

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
      targetTurnTextAvailable: () => true,
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
    expect(payload.ambiguityNotes.some((note) => note.includes('session-wide substitution skipped'))).toBe(true);
  });

  it('a named target whose text is missing yields no substitution either (waiting is the honest state)', async () => {
    const payload = await assembleWith(makeReader(true), 'turn-99');
    expect(payload.conversationWindow.length).toBe(0);
    expect(payload.ambiguityNotes.some((note) => note.includes('turn-99') && note.includes('no readable text'))).toBe(true);
  });
});
