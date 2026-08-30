/**
 * PRI-357: Golden-path E2E integration test for the diagnostician context pipeline.
 *
 * This test exercises the REAL production path end-to-end:
 *   PainSignalBridge.onPainDetected() → task creation with diagnosticJson
 *   SqliteContextAssembler.assemble() → DiagnosticianContextPayload
 *
 * It uses REAL SQLite databases (state.db via RuntimeStateManager) and a REAL
 * SqliteContextAssembler.* Only the runner/intake/ledger (which are NOT the path
 * under test) are mocked, and the TrajectoryTurnReader is mocked because it
 * represents an external database (TrajectoryDB in the plugin layer).
 *
 * Assertions:
 *   1. workspaceDir !== '<unknown>' && equals the input workspaceDir
 *   2. conversationWindow.length > 0 (populated from trajectory fallback)
 *   3. diagnosisTarget.evidence.length > 0
 *   4. eventSummaries is NOT in the payload schema (PRI-352 removal confirmed)
 *
 * ── Reverse Validation (why this test catches PRI-349/350/352 regressions) ──
 *
 * | Regression                    | Why this test would FAIL on old code               |
 * |-------------------------------|-----------------------------------------------------|
 * | PRI-349: workspaceDir unknown | diagnosticJson lacked workspaceDir → assembler      |
 * |                               | falls back to '<unknown>' → assertion 1 fires       |
 * | PRI-350: conversationWindow   | No TrajectoryTurnReader in assembler →              |
 * | empty after historyQuery empty | conversationWindow = [] → assertion 2 fires         |
 * | PRI-352: eventSummaries       | If eventSummaries reappears in schema, assertion 4  |
 * | dangling field                | catches it immediately                              |
 *
 * ERR entries considered:
 *   - ERR-002 (silent degradation): evidence/workspaceDir/conversationWindow
 *     silently falling back to empty/null/'<unknown>' is silent degradation.
 *     This test makes those failures LOUD (assertions fail).
 *   - ERR-009 (required fields silently skipped): Required payload fields
 *     (workspaceDir, conversationWindow, evidence) must be non-empty when
 *     input data is complete. This test asserts non-emptiness.
 *   - ERR-024/ERR-025 (production path wiring): This test exercises the
 *     REAL SqliteContextAssembler and REAL SqliteConnection, not mocks.
 *   - ERR-048 (write path disconnected from read path): This test runs
 *     onPainDetected (write) → assemble (read) in the same DB, proving
 *     the write path correctly populates data that the read path consumes.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Value } from '@sinclair/typebox/value';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { SqliteHistoryQuery } from '../store/history/sqlite-history-query.js';
import { SqliteContextAssembler } from '../store/context/sqlite-context-assembler.js';
import { PainSignalBridge } from '../pain-signal-bridge.js';
import { DiagnosticianContextPayloadSchema } from '../context-payload.js';
import type { TrajectoryTurnReader, TrajectoryUserTurn, TrajectoryAssistantTurn } from '../store/context/trajectory-turn-reader.js';
import type { DiagnosticianRunnerLike } from '../pain-signal-bridge.js';
import type { CandidateIntakeService } from '../candidate-intake-service.js';
import type { LedgerAdapter } from '../candidate-intake.js';

// ── Constants ────────────────────────────────────────────────────────────

const GOLDEN_WORKSPACE_DIR = '/home/user/projects/my-golden-app';
const GOLDEN_PAIN_ID = 'pain-golden-e2e-001';
const GOLDEN_SESSION_ID = 'sess-golden-e2e';
const GOLDEN_TASK_ID = `diagnosis_${GOLDEN_PAIN_ID}`;

// ── Helpers ──────────────────────────────────────────────────────────────

function notesInclude(notes: string[] | undefined, substring: string): boolean {
  return notes !== undefined && notes.some((n) => n.includes(substring));
}

/** Create a mock TrajectoryTurnReader with pre-seeded turns for a session. */
function createMockTrajectoryTurnReader(
  userTurns: Map<string, TrajectoryUserTurn[]>,
  assistantTurns: Map<string, TrajectoryAssistantTurn[]>,
): TrajectoryTurnReader {
  return {
    listUserTurnsForSession: vi.fn((sessionId: string) => userTurns.get(sessionId) ?? []),
    listAssistantTurns: vi.fn((sessionId: string) => assistantTurns.get(sessionId) ?? []),
  };
}

/** Create a mock DiagnosticianRunner that returns a basic "succeeded" result. */
function createMockRunner(): DiagnosticianRunnerLike {
  return {
    run: vi.fn().mockResolvedValue({
      status: 'succeeded',
      taskId: GOLDEN_TASK_ID,
      attemptCount: 1,
      output: {
        valid: true,
        diagnosisId: 'diag-golden-e2e',
        summary: 'Golden path test diagnosis',
        rootCause: 'Test root cause',
        violatedPrinciples: [],
        evidence: [{ sourceRef: 'src-golden', note: 'Evidence from golden test' }],
        recommendations: [{ kind: 'principle', description: 'Add defensive check for null context' }],
        confidence: 0.9,
      },
    }),
  };
}

/** Create a mock CandidateIntakeService. */
function createMockIntakeService(): CandidateIntakeService {
  return {
    intake: vi.fn().mockResolvedValue({ id: 'ledger-golden-1' }),
  } as unknown as CandidateIntakeService;
}

/** Create a mock LedgerAdapter. */
function createMockLedgerAdapter(): LedgerAdapter {
  return {
    register: vi.fn(),
    existsForCandidate: vi.fn().mockReturnValue({
      id: 'ledger-golden-1',
      status: 'probation',
      createdAt: new Date().toISOString(),
      text: 'Golden path test principle',
      sourceRef: 'candidate://c-golden-1',
      title: 'Golden Test Principle',
      evaluability: 'weak_heuristic',
    }),
    getEntries: vi.fn(),
  } as unknown as LedgerAdapter;
}

// ── Fixture ──────────────────────────────────────────────────────────────

interface GoldenFixture {
  tmpDir: string;
  stateManager: RuntimeStateManager;
  assembler: SqliteContextAssembler;
  bridge: PainSignalBridge;
  trajectoryTurnReader: TrajectoryTurnReader;
  runner: DiagnosticianRunnerLike;
}

async function createGoldenFixture(
  userTurns: Map<string, TrajectoryUserTurn[]>,
  assistantTurns: Map<string, TrajectoryAssistantTurn[]>,
): Promise<GoldenFixture> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-golden-e2e-'));
  const stateManager = new RuntimeStateManager({ workspaceDir: tmpDir });
  await stateManager.initialize();

  const trajectoryTurnReader = createMockTrajectoryTurnReader(userTurns, assistantTurns);
  const runner = createMockRunner();
  const intakeService = createMockIntakeService();
  const ledgerAdapter = createMockLedgerAdapter();

  // Create SqliteContextAssembler with REAL stores from the same DB
  const assembler = new SqliteContextAssembler(
    stateManager.taskStore,
    new SqliteHistoryQuery(stateManager.connection),
    stateManager.runStore,
    { trajectoryTurnReader },
  );

  // Create PainSignalBridge with real stateManager but mocked runner/intake/ledger
  const bridge = new PainSignalBridge({
    stateManager,
    runner,
    intakeService,
    ledgerAdapter,
    workspaceDir: GOLDEN_WORKSPACE_DIR,
    autoIntakeEnabled: true,
  });

  return { tmpDir, stateManager, assembler, bridge, trajectoryTurnReader, runner };
}

function cleanupGoldenFixture(fixture: GoldenFixture): void {
  fixture.stateManager.close();
  fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('PRI-357: Golden-path diagnostician E2E (real SQLite, no mock of assembly path)', () => {

  it('G1: onPainDetected → assemble produces payload with non-empty workspaceDir, conversationWindow, evidence, and no eventSummaries in schema', async () => {
    // ── Seed trajectory turns ──
    const userTurns = new Map<string, TrajectoryUserTurn[]>([
      [GOLDEN_SESSION_ID, [
        { id: 1, turnIndex: 0, rawExcerpt: 'Help me fix the login bug in auth.ts', correctionDetected: false, correctionCue: null, createdAt: '2026-06-10T10:00:00.000Z' },
        { id: 3, turnIndex: 2, rawExcerpt: 'No, the login is still broken after your fix', correctionDetected: true, correctionCue: 'rejected', createdAt: '2026-06-10T10:04:00.000Z' },
      ]],
    ]);
    const assistantTurns = new Map<string, TrajectoryAssistantTurn[]>([
      [GOLDEN_SESSION_ID, [
        { id: 2, sessionId: GOLDEN_SESSION_ID, runId: 'run-golden-1', provider: 'anthropic', model: 'claude-sonnet-4-20250514', sanitizedText: 'I found a null reference in the auth validation. Let me fix it.', createdAt: '2026-06-10T10:02:00.000Z' },
        { id: 4, sessionId: GOLDEN_SESSION_ID, runId: 'run-golden-2', provider: 'anthropic', model: 'claude-sonnet-4-20250514', sanitizedText: 'You are right. The null check was in the wrong place. Moving it to the controller layer.', createdAt: '2026-06-10T10:06:00.000Z' },
      ]],
    ]);

    const f = await createGoldenFixture(userTurns, assistantTurns);
    try {
      // ── Step 1: onPainDetected ──
      const bridgeResult = await f.bridge.onPainDetected({
        painId: GOLDEN_PAIN_ID,
        painType: 'tool_failure',
        source: 'pain',
        reason: 'Login auth.ts bug: null reference in validation layer',
        score: 85,
        sessionId: GOLDEN_SESSION_ID,
        evidence: [
          { sourceRef: 'tool_call:Edit:auth.ts', note: 'User reported null reference in auth validation; assistant fix was misplaced' },
          { sourceRef: 'user_correction:turn_3', note: 'User correction: login still broken after fix attempt' },
        ],
      });

      // Verify bridge produced a result (task was created and runner called)
      expect(bridgeResult.painId).toBe(GOLDEN_PAIN_ID);
      expect(bridgeResult.taskId).toBe(GOLDEN_TASK_ID);

      // Verify the task exists in the real DB
      const taskInDb = await f.stateManager.getTask(GOLDEN_TASK_ID);
      expect(taskInDb).not.toBeNull();
      expect(taskInDb?.taskKind).toBe('diagnostician');
      expect(taskInDb?.diagnosticJson).toBeDefined();

      // ── Step 2: assemble ──
      const payload = await f.assembler.assemble(GOLDEN_TASK_ID);

      // ── Assertion 1: workspaceDir ──
      expect(payload.workspaceDir).not.toBe('<unknown>');
      expect(payload.workspaceDir).toBe(GOLDEN_WORKSPACE_DIR);

      // ── Assertion 2: conversationWindow ──
      expect(payload.conversationWindow.length).toBeGreaterThan(0);
      // Should contain at least the 4 turns (2 user + 2 assistant) from trajectory
      expect(payload.conversationWindow.length).toBeGreaterThanOrEqual(4);
      // Entries must be sorted by timestamp ascending
      expect(payload.conversationWindow[0]?.role).toBe('user');
      expect(payload.conversationWindow[0]?.ts).toBe('2026-06-10T10:00:00.000Z');
      // User turn text from rawExcerpt
      expect(payload.conversationWindow[0]?.text).toContain('login bug');
      // Assistant text is sanitized
      expect(payload.conversationWindow[1]?.role).toBe('assistant');
      expect(payload.conversationWindow[1]?.text).toContain('null reference');

      // ── Assertion 3: evidence ──
      const { evidence } = payload.diagnosisTarget;
      expect(evidence).toBeDefined();
      if (!evidence) throw new Error('evidence must be defined');
      expect(evidence.length).toBeGreaterThan(0);
      // Evidence must contain the entries we seeded
      const evidenceSourceRefs = evidence.map(e => e.sourceRef);
      expect(evidenceSourceRefs).toContain('tool_call:Edit:auth.ts');
      expect(evidenceSourceRefs).toContain('user_correction:turn_3');

      // ── Assertion 4: eventSummaries resolution (PRI-352) ──
      // The DiagnosticianContextPayloadSchema must NOT contain eventSummaries
      const schemaKeys = Object.keys(DiagnosticianContextPayloadSchema.properties);
      expect(schemaKeys).not.toContain('eventSummaries');
      // The assembled payload must not have an eventSummaries property
      expect(Object.prototype.hasOwnProperty.call(payload, 'eventSummaries')).toBe(false);
      // The payload must validate against the schema
      expect(Value.Check(DiagnosticianContextPayloadSchema, payload)).toBe(true);

      // ── Additional quality checks ──
      // diagnosisTarget must have reasonSummary, source, severity
      expect(payload.diagnosisTarget.reasonSummary).toBeTruthy();
      expect(payload.diagnosisTarget.source).toBe('pain');
      expect(payload.diagnosisTarget.severity).toBe('severe');
      // provenance must be set (openclaw_context_bound since we have sessionId)
      expect(payload.diagnosisTarget.provenance).toBe('host_context_bound');
      // sessionIdHint must propagate from diagnosticJson
      expect(payload.diagnosisTarget.sessionIdHint).toBe(GOLDEN_SESSION_ID);
    } finally {
      cleanupGoldenFixture(f);
    }
  });

  it('G2: payload validates against DiagnosticianContextPayloadSchema after full assembly', async () => {
    // G2 ensures the assembled payload passes TypeBox schema validation.
    // This catches future schema changes that break the DiagnosticianContextPayload contract.
    const userTurns = new Map<string, TrajectoryUserTurn[]>([
      [GOLDEN_SESSION_ID, [
        { id: 10, turnIndex: 0, rawExcerpt: 'Simple query', correctionDetected: false, correctionCue: null, createdAt: '2026-06-10T09:00:00.000Z' },
      ]],
    ]);
    const assistantTurns = new Map<string, TrajectoryAssistantTurn[]>([
      [GOLDEN_SESSION_ID, [
        { id: 11, sessionId: GOLDEN_SESSION_ID, runId: 'run-schema', provider: 'openai', model: 'gpt-4', sanitizedText: 'Simple response', createdAt: '2026-06-10T09:01:00.000Z' },
      ]],
    ]);

    const f = await createGoldenFixture(userTurns, assistantTurns);
    try {
      await f.bridge.onPainDetected({
        painId: GOLDEN_PAIN_ID,
        painType: 'user_frustration',
        source: 'write',
        reason: 'Schema validation test pain',
        sessionId: GOLDEN_SESSION_ID,
        evidence: [{ sourceRef: 'schema-test', note: 'Schema validation' }],
      });

      const payload = await f.assembler.assemble(GOLDEN_TASK_ID);

      // Schema already checked inside assemble(), double-check explicitly
      expect(Value.Check(DiagnosticianContextPayloadSchema, payload)).toBe(true);

      // Verify conversationWindow from trajectory fallback works
      expect(payload.conversationWindow.length).toBeGreaterThan(0);
      expect(payload.workspaceDir).not.toBe('<unknown>');
    } finally {
      cleanupGoldenFixture(f);
    }
  });

  it('G3: workspaceDir=<unknown> when bridge has no workspaceDir (degradation is observable)', async () => {
    // G3: When workspaceDir is NOT provided to the bridge, the payload
    // should fall back to '<unknown>' — but this must be OBSERVABLE
    // (ERR-002: no silent degradation). The test verifies the degradation
    // is explicit.
    const userTurns = new Map<string, TrajectoryUserTurn[]>([
      [GOLDEN_SESSION_ID, [
        { id: 20, turnIndex: 0, rawExcerpt: 'Test without workspace', correctionDetected: false, correctionCue: null, createdAt: '2026-06-10T08:00:00.000Z' },
      ]],
    ]);
    const assistantTurns = new Map<string, TrajectoryAssistantTurn[]>([
      [GOLDEN_SESSION_ID, [
        { id: 21, sessionId: GOLDEN_SESSION_ID, runId: 'run-no-ws', provider: 'openai', model: 'gpt-4', sanitizedText: 'Response without workspace', createdAt: '2026-06-10T08:01:00.000Z' },
      ]],
    ]);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-golden-e2e-no-ws-'));
    const stateManager = new RuntimeStateManager({ workspaceDir: tmpDir });
    await stateManager.initialize();

    const trajectoryTurnReader = createMockTrajectoryTurnReader(userTurns, assistantTurns);
    const runner = createMockRunner();
    const intakeService = createMockIntakeService();
    const ledgerAdapter = createMockLedgerAdapter();

    const assembler = new SqliteContextAssembler(
      stateManager.taskStore,
      new SqliteHistoryQuery(stateManager.connection),
      stateManager.runStore,
      { trajectoryTurnReader },
    );

    // Bridge WITHOUT workspaceDir
    const bridge = new PainSignalBridge({
      stateManager,
      runner,
      intakeService,
      ledgerAdapter,
      autoIntakeEnabled: true,
      // workspaceDir intentionally omitted
    });

    try {
      await bridge.onPainDetected({
        painId: 'pain-no-ws-g3',
        painType: 'tool_failure',
        source: 'pain',
        reason: 'No workspaceDir test',
        sessionId: GOLDEN_SESSION_ID,
        evidence: [{ sourceRef: 'g3-test', note: 'G3 evidence' }],
      });

      const payload = await assembler.assemble('diagnosis_pain-no-ws-g3');

      // workspaceDir is '<unknown>' (no workspaceDir in diagnosticJson + no record-level workspaceDir)
      expect(payload.workspaceDir).toBe('<unknown>');

      // conversationWindow should still be empty because trajectory fallback
      // requires workspaceDir !== '<unknown>' (PRI-350 guard)
      // This is EXPECTED degradation: when workspaceDir is unknown, we cannot
      // safely access trajectory DB.
      expect(payload.conversationWindow).toEqual([]);
      expect(notesInclude(payload.ambiguityNotes, 'No conversation history')).toBe(true);

      // evidence IS present (from diagnosticJson)
      const g3Evidence = payload.diagnosisTarget.evidence;
      expect(g3Evidence).toBeDefined();
      if (!g3Evidence) throw new Error('g3 evidence must be defined');
      expect(g3Evidence.length).toBeGreaterThan(0);
    } finally {
      stateManager.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('G4: evidence from diagnosticJson survives the full onPainDetected → assemble round-trip', async () => {
    // G4 specifically validates that evidence written by buildDiagnosticJson
    // is correctly read by SqliteContextAssembler.reconstructDiagnosticianRecord.
    const userTurns = new Map<string, TrajectoryUserTurn[]>([
      [GOLDEN_SESSION_ID, [
        { id: 30, turnIndex: 0, rawExcerpt: 'Evidence round-trip test', correctionDetected: false, correctionCue: null, createdAt: '2026-06-10T07:00:00.000Z' },
      ]],
    ]);
    const assistantTurns = new Map<string, TrajectoryAssistantTurn[]>([
      [GOLDEN_SESSION_ID, [
        { id: 31, sessionId: GOLDEN_SESSION_ID, runId: 'run-evidence', provider: 'openai', model: 'gpt-4', sanitizedText: 'Evidence response', createdAt: '2026-06-10T07:01:00.000Z' },
      ]],
    ]);

    const f = await createGoldenFixture(userTurns, assistantTurns);
    try {
      const customEvidence = [
        { sourceRef: 'trace:file:src/controller.ts:42', note: 'Null check was missing on line 42 — this was the root cause of the login failure' },
        { sourceRef: 'user_message:turn_5', note: 'User said: the fix you applied to auth.ts actually broke the registration flow too' },
        { sourceRef: 'tool_call:Write:controller.ts', note: 'Write tool was used to patch controller.ts with the corrected null check' },
      ];

      await f.bridge.onPainDetected({
        painId: GOLDEN_PAIN_ID,
        painType: 'tool_failure',
        source: 'pain',
        reason: 'Evidence round-trip validation',
        sessionId: GOLDEN_SESSION_ID,
        evidence: customEvidence,
      });

      const payload = await f.assembler.assemble(GOLDEN_TASK_ID);

      // Evidence must be exactly what we put in (round-trip integrity)
      const roundTripEvidence = payload.diagnosisTarget.evidence;
      expect(roundTripEvidence).toBeDefined();
      if (!roundTripEvidence) throw new Error('round-trip evidence must be defined');
      expect(roundTripEvidence.length).toBe(customEvidence.length);

      // Each evidence entry must be preserved
      for (let i = 0; i < customEvidence.length; i++) {
        const expected = customEvidence[i];
        if (!expected) throw new Error('custom evidence entry missing');
        expect(roundTripEvidence[i]?.sourceRef).toBe(expected.sourceRef);
        expect(roundTripEvidence[i]?.note).toBe(expected.note);
      }

      // Other fields still work
      expect(payload.workspaceDir).toBe(GOLDEN_WORKSPACE_DIR);
      expect(payload.conversationWindow.length).toBeGreaterThan(0);
    } finally {
      cleanupGoldenFixture(f);
    }
  });
});