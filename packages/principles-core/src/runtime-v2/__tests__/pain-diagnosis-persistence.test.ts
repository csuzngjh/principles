/**
 * Pain Diagnosis Persistence regression tests (Pain Diagnosis Persistence
 * SPEC v1.1 §12).
 *
 * Coverage required by the SPEC:
 *   1. Agent behavior failure → persisted diagnosis category People.
 *   2. Environment failure → persisted diagnosis category Tooling.
 *   3. Mixed failure → multiple diagnosis rows sharing one pain_id (no Mixed enum).
 *   4. Principle pollution → a software-bug (Design/Tooling) diagnosis keeps its
 *      true category and cannot masquerade as an agent-behavior (People) narrative;
 *      the Stage A prompt only allows People with agent-behavior evidence.
 *
 * Plus flag-contract behavior: default off writes nothing; replay is idempotent;
 * unparseable rootCause prefixes and store failures degrade observably (rc-9).
 *
 * Persistence goes through a REAL RuntimeStateManager on a temp workspace, so
 * the schema migration (pain_diagnoses) and the sqlite round-trip are exercised.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PainSignalBridge } from '../pain-signal-bridge.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { RuntimeStateManager as RuntimeStateManagerClass } from '../store/runtime-state-manager.js';
import { SqliteConnection } from '../store/sqlite-connection.js';
import type { DiagnosticianOutputV1 } from '../diagnostician-output.js';
import type { LedgerAdapter } from '../candidate-intake.js';
import { buildRootCauseProtocolInstruction } from '../diagnostician/rootcause-prompt-builder.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const workspaces: string[] = [];
const managers: RuntimeStateManagerClass[] = [];

async function makeStateManager(): Promise<RuntimeStateManager> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-diag-'));
  workspaces.push(dir);
  const mgr = new RuntimeStateManagerClass({ workspaceDir: dir });
  await mgr.initialize();
  managers.push(mgr);
  return mgr;
}

afterAll(async () => {
  for (const mgr of managers.splice(0)) {
    try { await mgr.close(); } catch { /* best-effort cleanup */ }
  }
  for (const dir of workspaces.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

function makeOutput(rootCause: string, over: Partial<DiagnosticianOutputV1> = {}): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: 'diag-001',
    summary: 'test diagnosis summary',
    rootCause,
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'tool_calls:1', note: 'agent action evidence' }],
    recommendations: [{ kind: 'defer', description: 'no actionable principle' }],
    confidence: 0.7,
    ...over,
  };
}

interface CapturedEvent {
  eventType: string;
  payload: Record<string, unknown>;
}

function makeBridge(stateManager: RuntimeStateManager, opts: { persistenceEnabled: boolean; events: CapturedEvent[] }): PainSignalBridge {
  const ledgerAdapter: LedgerAdapter = {
    existsForCandidate: () => null,
    writeProbationEntry: undefined as never,
  };
  return new PainSignalBridge({
    stateManager,
    runner: {
      run: async (taskId) => ({ status: 'succeeded', taskId, attemptCount: 1 }),
    },
    intakeService: undefined as never,
    ledgerAdapter,
    autoIntakeEnabled: false,
    diagnosisPersistenceEnabled: opts.persistenceEnabled,
    eventEmitter: {
      emitTelemetry: (event) => { opts.events.push({ eventType: event.eventType, payload: event.payload }); },
    },
  });
}

async function completeDiagnosis(
  bridge: PainSignalBridge,
  opts: { painId: string; taskId: string; output: DiagnosticianOutputV1 },
): Promise<ReturnType<PainSignalBridge['onDiagnosisComplete']>> {
  return bridge.onDiagnosisComplete({
    taskId: opts.taskId,
    diagnosticianOutput: opts.output,
    painId: opts.painId,
    provenance: 'automatic_hook',
    inputEvidenceCount: 1,
  });
}

// ── SPEC §12: Agent Failure → People ────────────────────────────────────────

describe('pain diagnosis persistence (SPEC v1.1 §12 regression)', () => {
  it('agent behavior failure (changed code without testing) persists category People', async () => {
    const mgr = await makeStateManager();
    const events: CapturedEvent[] = [];
    const bridge = makeBridge(mgr, { persistenceEnabled: true, events });

    await completeDiagnosis(bridge, {
      painId: 'pain-agent-001',
      taskId: 'diagnosis_pain-agent-001',
      output: makeOutput('People: Agent modified code without running the tests first'),
    });

    const rows = await mgr.getDiagnosesByPainId('pain-agent-001');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBe('People');
    expect(rows[0]?.rootCause).toBe('People: Agent modified code without running the tests first');
    expect(rows[0]?.diagnosisId).toBe('diag-001');
    expect(rows[0]?.evidence).toEqual([{ sourceRef: 'tool_calls:1', note: 'agent action evidence' }]);
    expect(rows[0]?.confidence).toBe(0.7);
    expect(rows[0]?.artifactId).toBeNull();
    expect(typeof rows[0]?.createdAt).toBe('string');
  });

  // ── SPEC §12: Environment Failure → Tooling ──────────────────────────────

  it('environment failure (third-party API outage) persists category Tooling', async () => {
    const mgr = await makeStateManager();
    const bridge = makeBridge(mgr, { persistenceEnabled: true, events: [] });

    await completeDiagnosis(bridge, {
      painId: 'pain-env-001',
      taskId: 'diagnosis_pain-env-001',
      output: makeOutput('Tooling: third-party API returned 503 for every retry'),
    });

    const rows = await mgr.getDiagnosesByPainId('pain-env-001');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBe('Tooling');
  });

  // ── SPEC §12: Mixed Failure → multiple rows per pain_id ──────────────────

  it('mixed failure persists multiple diagnosis rows under one pain_id (no Mixed enum)', async () => {
    const mgr = await makeStateManager();
    const bridge = makeBridge(mgr, { persistenceEnabled: true, events: [] });
    const painId = 'pain-mixed-001';

    await completeDiagnosis(bridge, {
      painId,
      taskId: 'diagnosis_pain-mixed-001',
      output: makeOutput('Tooling: unstable third-party API', { diagnosisId: 'diag-tooling' }),
    });
    await completeDiagnosis(bridge, {
      painId,
      taskId: 'diagnosis_pain-mixed-001-r2',
      output: makeOutput('People: Agent added no fallback despite prior API instability', { diagnosisId: 'diag-people' }),
    });

    const rows = await mgr.getDiagnosesByPainId(painId);
    expect(rows).toHaveLength(2);
    // Same-millisecond writes make created_at tie-break on id — assert the
    // category SET, order is not part of the contract.
    expect([...rows.map((r) => r.category)].sort()).toEqual(['People', 'Tooling']);
    expect(new Set(rows.map((r) => r.painId))).toEqual(new Set([painId]));
  });

  it('replaying the same diagnosis completion is idempotent', async () => {
    const mgr = await makeStateManager();
    const bridge = makeBridge(mgr, { persistenceEnabled: true, events: [] });
    const call = {
      painId: 'pain-replay-001',
      taskId: 'diagnosis_pain-replay-001',
      output: makeOutput('Design: missing validation gate'),
    };
    await completeDiagnosis(bridge, call);
    await completeDiagnosis(bridge, call);
    const rows = await mgr.getDiagnosesByPainId('pain-replay-001');
    expect(rows).toHaveLength(1);
  });

  // ── SPEC §12: Principle Pollution ────────────────────────────────────────

  it('software-bug diagnosis keeps its Design category — attribution cannot drift to People', async () => {
    const mgr = await makeStateManager();
    const bridge = makeBridge(mgr, { persistenceEnabled: true, events: [] });

    // A bug in PD itself, which the agent legitimately worked around: the
    // persisted attribution must remain Design so a future agent Principle
    // cannot be justified by re-reading this pain's history as "agent error".
    await completeDiagnosis(bridge, {
      painId: 'pain-pollution-001',
      taskId: 'diagnosis_pain-pollution-001',
      output: makeOutput('Design: PD failed to close the DB handle before renaming the workspace', { confidence: 0.9 }),
    });

    const rows = await mgr.getDiagnosesByPainId('pain-pollution-001');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBe('Design');
    expect(rows[0]?.rootCause).not.toMatch(/^People:/);
  });

  it('prompt requires agent-behavior evidence for People — failure is not automatically an agent error', () => {
    const prompt = buildRootCauseProtocolInstruction({ evidenceFirstAttribution: true });
    expect(prompt).toContain('Evidence First Attribution');
    expect(prompt).toContain('A failure event is NOT automatically an agent error');
    expect(prompt).toContain('Never classify as People without evidence of an avoidable agent action');
    // SPEC §6: the five People-leaning behaviors are stated explicitly.
    expect(prompt).toContain('without investigating');
    expect(prompt).toContain('skipped verification or testing');
    expect(prompt).toContain('ignored an already-active principle');
    expect(prompt).toContain('high-risk action without checking');
    expect(prompt).toContain('repeated the same class of error');
  });

  it('prompt is byte-identical when the flag is off (default) — no attribution semantics ship by default', () => {
    const off = buildRootCauseProtocolInstruction();
    expect(off).toBe(buildRootCauseProtocolInstruction({ evidenceFirstAttribution: false }));
    expect(off).not.toContain('Evidence First Attribution');
    expect(off).not.toContain('automatically an agent error');
  });

  // ── Flag default / degradation contract ───────────────────────────────────

  it('flag off (default) writes no diagnosis rows', async () => {
    const mgr = await makeStateManager();
    const bridge = makeBridge(mgr, { persistenceEnabled: false, events: [] });

    await completeDiagnosis(bridge, {
      painId: 'pain-off-001',
      taskId: 'diagnosis_pain-off-001',
      output: makeOutput('People: Agent modified code without running the tests first'),
    });

    expect(await mgr.getDiagnosesByPainId('pain-off-001')).toHaveLength(0);
  });

  it('unparseable rootCause prefix skips the write observably (rc-9)', async () => {
    const mgr = await makeStateManager();
    const events: CapturedEvent[] = [];
    const bridge = makeBridge(mgr, { persistenceEnabled: true, events });

    await completeDiagnosis(bridge, {
      painId: 'pain-noprefix-001',
      taskId: 'diagnosis_pain-noprefix-001',
      output: makeOutput('Something went wrong with no category prefix'),
    });

    expect(await mgr.getDiagnosesByPainId('pain-noprefix-001')).toHaveLength(0);
    const skipped = events.filter((e) => e.eventType === 'pain_diagnosis_persist_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.payload.reason).toBe('unparseable_root_cause_prefix');
    expect(typeof skipped[0]?.payload.nextAction).toBe('string');
  });

  it('store failure degrades observably and does not break the admission flow', async () => {
    const mgr = await makeStateManager();
    const events: CapturedEvent[] = [];
    const failing = Object.assign(Object.create(Object.getPrototypeOf(mgr)), mgr, {
      recordPainDiagnosis: async () => { throw new Error('injected store failure'); },
    }) as RuntimeStateManager;
    const bridge = makeBridge(failing, { persistenceEnabled: true, events });

    await expect(completeDiagnosis(bridge, {
      painId: 'pain-storefail-001',
      taskId: 'diagnosis_pain-storefail-001',
      output: makeOutput('Tooling: store unavailable'),
    })).resolves.toBeDefined();

    const failed = events.filter((e) => e.eventType === 'pain_diagnosis_persist_failed');
    expect(failed).toHaveLength(1);
    expect(String(failed[0]?.payload.reason)).toContain('injected store failure');
    expect(typeof failed[0]?.payload.nextAction).toBe('string');
  });

  // ── Schema migration ──────────────────────────────────────────────────────

  it('existing state.db gains the pain_diagnoses table on next open', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-diag-mig-'));
    workspaces.push(dir);

    const first = new SqliteConnection(dir);
    const db = first.getDb();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pain_diagnoses'").get()).toBeDefined();
    // Simulate a pre-feature database by dropping the table, then reopen.
    db.prepare('DROP TABLE pain_diagnoses').run();
    first.close();

    const second = new SqliteConnection(dir);
    const db2 = second.getDb();
    expect(db2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pain_diagnoses'").get()).toBeDefined();
    second.close();
  });
});
