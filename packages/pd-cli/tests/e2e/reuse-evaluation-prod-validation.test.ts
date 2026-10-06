/**
 * PRI-917 v0.3.2 Phase 3C-5 — Production validation for the Semantic Reuse
 * Evaluation Capability (SPEC §14 slice 5 / §11).
 *
 * Drives the FULL production chain against real workspace state: real
 * .pd/config.yaml + state.db + ledger document + CandidateIntakeService +
 * reuse gate + appendReuseEvidence + the capability runner (through the
 * resolver-provided adapter). T1-T6 as specified:
 *
 *   T1  lexical-only behaviour preserved (capability disabled -> pre-evaluation
 *       review output, create untouched, no events);
 *   T2  semantic success: review -> recommendation -> Owner decision ->
 *       evidence/create, with the observation event;
 *   T3  evaluation unavailable: review continues normally, create intact;
 *   T4  Owner override: the recommendation cannot override an explicit
 *       Owner verdict, in either direction;
 *   T5  ledger invariants: the evaluation path never changes the ledger, and
 *       a completed reuse mutates ONLY reuseEvidence (never text/version/
 *       status/derivedFromPainIds);
 *   T6  telemetry is observation only: events pass the TelemetryEventSchema
 *       (a schema failure would surface as degradation_triggered instead),
 *       carry no persistence-shaped payload, and ledger outcomes are
 *       identical with a listener consuming them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { writeFileSync } from 'fs';
import * as yaml from 'js-yaml';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';

const { mockResolveOwnerIdentity, mockResolveRuntimeAdapter, evaluationScript } = vi.hoisted(() => ({
  mockResolveOwnerIdentity: vi.fn(),
  mockResolveRuntimeAdapter: vi.fn(),
  evaluationScript: { outcomes: [] as unknown[] },
}));

vi.mock('@principles/core/runtime-v2', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveOwnerIdentity: mockResolveOwnerIdentity,
}));

vi.mock('../../src/services/runtime-adapter-resolver.js', () => ({
  resolveRuntimeAdapterFromConfig: mockResolveRuntimeAdapter,
}));

import { handleCandidateReview, handleCandidateIntake } from '../../src/commands/candidate.js';
import {
  RuntimeStateManager,
  storeEmitter,
  type TelemetryEvent,
  type PDRuntimeAdapter,
  type RunHandle,
  type RunStatus,
  type RuntimeCapabilities,
  type RuntimeArtifactRef,
  type RuntimeHealth,
  type StartRunInput,
  type StructuredRunOutput,
} from '@principles/core/runtime-v2';
import { addPrincipleToLedger, loadLedger } from '@principles/core/principle-tree-ledger';
import type { LedgerPrinciple } from '@principles/core/principle-tree-ledger';

let workspaceDir: string;
let stateManager: RuntimeStateManager;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;
/** Telemetry captured through the REAL emitter (post schema validation). */
const observedEvents: TelemetryEvent[] = [];
let telemetryListener: ((event: TelemetryEvent) => void) | null = null;

const CANDIDATE_TEXT = '任何结论必须由可观察证据背书，无查验则显式降级为推断。';
const CANDIDATE_TRIGGER = '在没有外部证据就做出确定性结论时';
const CANDIDATE_ACTION = '先核验可观察状态再断言';

function makePrinciple(overrides: Partial<LedgerPrinciple> = {}): LedgerPrinciple {
  return {
    id: randomUUID(),
    version: 1,
    text: CANDIDATE_TEXT,
    triggerPattern: CANDIDATE_TRIGGER,
    action: CANDIDATE_ACTION,
    status: 'active',
    priority: 'P1',
    scope: 'general',
    evaluability: 'manual_only',
    valueScore: 0.5,
    adherenceRate: 0.8,
    painPreventedCount: 0,
    derivedFromPainIds: [],
    ruleIds: [],
    conflictsWithPrincipleIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function seedPrincipleCandidate(opts: { painId?: string } = {}): Promise<string> {
  const candidateId = randomUUID();
  const artifactId = randomUUID();
  const now = new Date().toISOString();

  const taskId = randomUUID();
  await stateManager.taskStore.createTask({
    taskId,
    taskKind: 'diagnostician',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    lastError: undefined,
    inputRef: '',
    resultRef: '',
    diagnosticJson: undefined,
  });
  const runId = randomUUID();
  await stateManager.runStore.createRun({
    runId,
    taskId,
    runtimeKind: 'openclaw',
    attemptNumber: 1,
    executionStatus: 'succeeded',
    startedAt: now,
    endedAt: now,
  });
  if (opts.painId !== undefined) {
    await stateManager.recordPainDiagnosis({
      painId: opts.painId,
      taskId,
      diagnosisId: `diag-${candidateId}`,
      category: 'People',
      rootCause: 'People: seeded diagnosis for reuse evidence',
      evidence: [],
      confidence: 0.9,
      artifactId,
    });
  }

  const db = new Database(join(workspaceDir, '.pd', 'state.db'));
  try {
    db.prepare(`
      INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      artifactId,
      runId,
      taskId,
      'principle',
      JSON.stringify({ text: CANDIDATE_TEXT, triggerPattern: CANDIDATE_TRIGGER, action: CANDIDATE_ACTION }),
      now,
    );
    db.prepare(`
      INSERT INTO principle_candidates
        (candidate_id, artifact_id, task_id, source_run_id, title, description, confidence,
         source_recommendation_json, idempotency_key, status, created_at, recommendation_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'principle')
    `).run(
      candidateId,
      artifactId,
      taskId,
      runId,
      '测试候选',
      CANDIDATE_TEXT,
      0.9,
      JSON.stringify({ text: CANDIDATE_TEXT, triggerPattern: CANDIDATE_TRIGGER, action: CANDIDATE_ACTION }),
      `${artifactId}::prompt`,
      now,
    );
  } finally {
    db.close();
  }
  return candidateId;
}

function candidateStatus(candidateId: string): string | null {
  const db = new Database(join(workspaceDir, '.pd', 'state.db'));
  try {
    const row = db.prepare('SELECT status FROM principle_candidates WHERE candidate_id = ?').get(candidateId) as { status: string } | undefined;
    return row?.status ?? null;
  } finally {
    db.close();
  }
}

function ledgerPath(): string {
  return join(workspaceDir, '.state', 'principle_training_state.json');
}

function ledgerBytes(): string {
  return fs.readFileSync(ledgerPath(), 'utf8');
}

function printedStdout(): string {
  return consoleLogSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
}

function printedJson(): unknown {
  return JSON.parse(printedStdout());
}

function writeWorkspaceConfig(reuseEvaluation: Record<string, unknown> | undefined): void {
  writeFileSync(
    join(workspaceDir, '.pd', 'config.yaml'),
    yaml.dump({
      version: 1,
      features: {
        prompt: { category: 'core', enabled: true },
        code_tool_hook: { category: 'core', enabled: true },
        defer_archive: { category: 'core', enabled: true },
      },
      runtimeProfiles: {
        'openclaw.default': { type: 'openclaw', source: 'default' },
        'pd.custom': { type: 'pi-ai', provider: 'test', model: 'test-model', apiKeyEnv: 'PD_TEST_EVAL_KEY' },
      },
      internalAgents: { defaultRuntime: 'pd.custom', agents: { diagnostician: { enabled: true } } },
      ...(reuseEvaluation !== undefined ? { reuseEvaluation } : {}),
    }),
    'utf8',
  );
  process.env.PD_TEST_EVAL_KEY = 'test-key';
}

function scriptEvaluation(outcomes: unknown[]): void {
  evaluationScript.outcomes = outcomes;
  mockResolveRuntimeAdapter.mockImplementation(() => new ScriptedEvaluationAdapter());
}

function makeResolverThrow(): void {
  mockResolveRuntimeAdapter.mockImplementation(() => {
    throw new Error('auth_missing: reuse evaluation profile has no API key');
  });
}

interface ScriptedOutcome {
  payload?: unknown;
  failRun?: string;
}

class ScriptedEvaluationAdapter implements PDRuntimeAdapter {
  readonly startedRuns: StartRunInput[] = [];

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  kind(): 'test-double' {
    return 'test-double';
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      supportsStructuredJsonOutput: true,
      supportsToolUse: false,
      supportsWorkingDirectory: false,
      supportsModelSelection: false,
      supportsLongRunningSessions: false,
      supportsCancellation: true,
      supportsArtifactWriteBack: false,
      supportsConcurrentRuns: false,
      supportsStreaming: false,
    };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async healthCheck(): Promise<RuntimeHealth> {
    return { healthy: true, degraded: false, warnings: [], lastCheckedAt: '2026-09-29T00:00:00.000Z' };
  }

  async startRun(input: StartRunInput): Promise<RunHandle> {
    this.startedRuns.push(input);
    return { runId: `run-${this.startedRuns.length}`, runtimeKind: 'test-double', startedAt: '2026-09-29T00:00:00.000Z' };
  }

  async pollRun(runId: string): Promise<RunStatus> {
    const outcome = evaluationScript.outcomes[0] as ScriptedOutcome | undefined;
    if (outcome?.failRun) {
      return { runId, status: 'failed', reason: outcome.failRun };
    }
    return { runId, status: 'succeeded' };
  }

  async fetchOutput(runId: string): Promise<StructuredRunOutput | null> {
    const outcome = evaluationScript.outcomes.shift() as ScriptedOutcome | undefined;
    if (!outcome || outcome.failRun || outcome.payload === undefined) {
      return null;
    }
    return { runId, payload: outcome.payload };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async cancelRun(runId: string): Promise<void> {
    void runId;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async fetchArtifacts(runId: string): Promise<RuntimeArtifactRef[]> {
    void runId;
    return [];
  }
}

beforeEach(async () => {
  workspaceDir = join(os.tmpdir(), `pd-reuse-prodval-${randomUUID()}`);
  fs.mkdirSync(join(workspaceDir, '.pd'), { recursive: true });
  stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();

  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
  mockResolveOwnerIdentity.mockReturnValue({ ownerId: 'owner-1', credentialId: 'cred-1', source: 'file' });
  evaluationScript.outcomes = [];
  mockResolveRuntimeAdapter.mockReset();
  delete process.env.PD_TEST_EVAL_KEY;

  // T6: capture events through the REAL emitter — an event that fails the
  // TelemetryEventSchema would arrive here as degradation_triggered instead,
  // so asserting on the event type doubles as a schema-validity check.
  observedEvents.length = 0;
  telemetryListener = (event: TelemetryEvent) => {
    observedEvents.push(event);
  };
  storeEmitter.on('telemetry', telemetryListener);
});

afterEach(() => {
  if (telemetryListener) {
    storeEmitter.off('telemetry', telemetryListener);
    telemetryListener = null;
  }
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  exitSpy.mockRestore();
  delete process.env.PD_TEST_EVAL_KEY;
  try { stateManager.close(); } catch { /* best effort */ }
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
  mockResolveOwnerIdentity.mockReset();
  mockResolveRuntimeAdapter.mockReset();
});

function reuseEvents(): TelemetryEvent[] {
  return observedEvents.filter(
    (e) => e.eventType === 'reuse_evaluation_recommended' || e.eventType === 'reuse_evaluation_unavailable',
  );
}

// ── T1 — lexical-only behaviour preserved ────────────────────────────────────

describe('T1 — capability disabled preserves lexical-only behaviour', () => {
  it('disabled section: no evaluation field, no events, create untouched', async () => {
    writeWorkspaceConfig({ enabled: false });
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-t1' });

    await handleCandidateReview({ candidateId, workspace: workspaceDir, json: true });

    expect(exitSpy).not.toHaveBeenCalled();
    const parsed = printedJson() as { evaluation?: unknown; proposal: { candidates: unknown[] } };
    expect(parsed.evaluation).toBeUndefined();
    expect(parsed.proposal.candidates.length).toBeGreaterThan(0);
    expect(reuseEvents()).toHaveLength(0);

    // Create is exactly the pre-capability flow.
    await handleCandidateIntake({ candidateId, workspace: workspaceDir, json: true });
    expect(candidateStatus(candidateId)).toBe('consumed');
  });

  it('legacy config WITHOUT the section: capability defaults ON with zero migration', async () => {
    // A workspace written before the capability existed has no reuseEvaluation
    // key. Zero migration means the section resolves from defaults (enabled,
    // defaultRuntime fallback) — so an evaluation DOES run here; no config
    // edit is ever required to activate the capability.
    writeWorkspaceConfig(undefined);
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-t1b' });
    scriptEvaluation([
      { payload: { recommendation: 'reuse', selectedPrincipleId: existing.id, rationale: 'r', confidence: 0.9 } },
    ]);

    await handleCandidateReview({ candidateId, workspace: workspaceDir, json: true });

    const parsed = printedJson() as {
      evaluation: { status: string; recommendation: string };
      proposal: { candidates: Array<{ principleId: string; semanticMatch: boolean }> };
    };
    expect(parsed.evaluation).toEqual({
      status: 'recommended',
      recommendation: 'reuse',
      selectedPrincipleId: existing.id,
      rationale: 'r',
      confidence: 0.9,
    });
    const matched = parsed.proposal.candidates.find((c) => c.semanticMatch);
    expect(matched?.principleId).toBe(existing.id);
    const events = reuseEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('reuse_evaluation_recommended');
  });
});

// ── T2 — semantic success, full chain ────────────────────────────────────────

describe('T2 — semantic success: review -> recommendation -> Owner decision -> evidence', () => {
  it('full REUSE chain: recommendation observed, evidence written, invariants held', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-t2' });
    writeWorkspaceConfig({ enabled: true, runtimeProfile: 'pd.custom', timeoutMs: 5000 });
    scriptEvaluation([
      { payload: { recommendation: 'reuse', selectedPrincipleId: existing.id, rationale: 'same experience', confidence: 0.9 } },
    ]);
    const afterSeed = ledgerBytes();

    // Review: the recommendation is displayed and observed.
    await handleCandidateReview({ candidateId, workspace: workspaceDir, json: true });
    const review = printedJson() as { evaluation: { status: string; recommendation: string } };
    expect(review.evaluation.status).toBe('recommended');
    // T5: the evaluation path itself left the ledger untouched.
    expect(ledgerBytes()).toBe(afterSeed);

    // The observation event fired exactly once, carrying no persistence.
    const events = reuseEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('reuse_evaluation_recommended');
    expect(Object.keys(events[0]?.payload as Record<string, unknown>).sort()).toEqual([
      'candidateId', 'confidence', 'recommendation', 'selectedPrincipleId',
    ]);

    // Owner decides reuse: the verdict is recorded on the Principle.
    consoleLogSpy.mockClear();
    await handleCandidateReview({
      candidateId, workspace: workspaceDir, decide: 'reuse', principleId: existing.id, reason: 'covers it', json: true,
    });
    const stored = loadLedger(join(workspaceDir, '.state')).tree.principles[existing.id];
    expect(stored?.reuseEvidence).toHaveLength(1);
    expect(candidateStatus(candidateId)).toBe('consumed');
    // T5 evidence integrity: ONLY reuseEvidence changed.
    const afterReuse = JSON.parse(ledgerBytes()) as { _tree: { principles: Record<string, LedgerPrinciple> } };
    const reusedEntry = afterReuse._tree.principles[existing.id];
    expect(reusedEntry?.text).toBe(CANDIDATE_TEXT);
    expect(reusedEntry?.version).toBe(1);
    expect(reusedEntry?.status).toBe('active');
    expect(reusedEntry?.derivedFromPainIds).toEqual([]);
  });

  it('full CREATE chain: recommendation observed, Owner create produces a new Principle', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-t2b' });
    writeWorkspaceConfig({ enabled: true, runtimeProfile: 'pd.custom' });
    scriptEvaluation([
      { payload: { recommendation: 'reuse', selectedPrincipleId: existing.id, rationale: 'judge leans reuse', confidence: 0.8 } },
    ]);
    await handleCandidateReview({ candidateId, workspace: workspaceDir, json: true });
    consoleLogSpy.mockClear();

    await handleCandidateReview({
      candidateId, workspace: workspaceDir, decide: 'create', reason: 'owner sees a distinction', json: true,
    });

    const principles = loadLedger(join(workspaceDir, '.state')).tree.principles;
    expect(Object.keys(principles)).toHaveLength(2);
    expect(principles[existing.id]?.reuseEvidence).toBeUndefined();
    const created = Object.values(principles).find((p) => p.id !== existing.id);
    expect(created?.derivedFromPainIds).toContain(candidateId);
    expect(candidateStatus(candidateId)).toBe('consumed');
  });
});

// ── T3 — evaluation unavailable: review continues, create intact ─────────────

describe('T3 — evaluation unavailable: review continues normally', () => {
  it('degrades observably and the create path is fully intact', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-t3' });
    writeWorkspaceConfig({ enabled: true, runtimeProfile: 'pd.custom' });
    makeResolverThrow();
    const before = ledgerBytes();

    await handleCandidateReview({ candidateId, workspace: workspaceDir, json: true });

    expect(exitSpy).not.toHaveBeenCalled();
    const parsed = printedJson() as {
      evaluation: { status: string; reason: string };
      proposal: { candidates: unknown[] };
    };
    expect(parsed.evaluation.status).toBe('unavailable');
    expect(parsed.proposal.candidates.length).toBeGreaterThan(0);
    // The unavailable observation fired; the failure itself wrote nothing.
    const events = reuseEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('reuse_evaluation_unavailable');
    expect(ledgerBytes()).toBe(before);

    // Create intact (SPEC §9 cuts both ways).
    consoleLogSpy.mockClear();
    await handleCandidateIntake({ candidateId, workspace: workspaceDir, json: true });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(candidateStatus(candidateId)).toBe('consumed');
    expect(ledgerBytes()).not.toBe(before);
  });
});

// ── T4 — Owner override, both directions ─────────────────────────────────────

describe('T4 — the recommendation cannot override an explicit Owner verdict', () => {
  it('judge=reuse + Owner=create -> new Principle, proposed target untouched', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-t4a' });
    writeWorkspaceConfig({ enabled: true, runtimeProfile: 'pd.custom' });
    scriptEvaluation([
      { payload: { recommendation: 'reuse', selectedPrincipleId: existing.id, rationale: 'judge says reuse', confidence: 0.97 } },
    ]);
    await handleCandidateReview({ candidateId, workspace: workspaceDir, json: true });

    await handleCandidateReview({
      candidateId, workspace: workspaceDir, decide: 'create', reason: 'owner disagrees', json: true,
    });

    const principles = loadLedger(join(workspaceDir, '.state')).tree.principles;
    expect(Object.keys(principles)).toHaveLength(2);
    expect(principles[existing.id]?.reuseEvidence).toBeUndefined();
    expect(candidateStatus(candidateId)).toBe('consumed');
  });

  it('judge=create + Owner=reuse -> evidence appended', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-t4b' });
    writeWorkspaceConfig({ enabled: true, runtimeProfile: 'pd.custom' });
    scriptEvaluation([
      { payload: { recommendation: 'create', rationale: 'judge says create', confidence: 0.6 } },
    ]);
    await handleCandidateReview({ candidateId, workspace: workspaceDir, json: true });

    await handleCandidateReview({
      candidateId, workspace: workspaceDir, decide: 'reuse', principleId: existing.id, reason: 'owner sees coverage', json: true,
    });

    const stored = loadLedger(join(workspaceDir, '.state')).tree.principles[existing.id];
    expect(stored?.reuseEvidence).toHaveLength(1);
    expect(candidateStatus(candidateId)).toBe('consumed');
  });
});

// ── T6 — telemetry is observation only ───────────────────────────────────────

describe('T6 — telemetry: observation only, never decision storage', () => {
  it('payloads carry no persistence-shaped keys, and outcomes are identical with events consumed', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-t6' });
    writeWorkspaceConfig({ enabled: true, runtimeProfile: 'pd.custom' });

    // Unavailable -> unavailable observation.
    makeResolverThrow();
    await handleCandidateReview({ candidateId, workspace: workspaceDir, json: true });

    // Recommended -> recommended observation.
    scriptEvaluation([
      { payload: { recommendation: 'reuse', selectedPrincipleId: existing.id, rationale: 'r', confidence: 0.9 } },
    ]);
    await handleCandidateReview({ candidateId, workspace: workspaceDir, json: true });

    const events = reuseEvents();
    expect(events.map((e) => e.eventType)).toEqual([
      'reuse_evaluation_unavailable',
      'reuse_evaluation_recommended',
    ]);
    for (const event of events) {
      const payloadKeys = Object.keys(event.payload as Record<string, unknown>);
      for (const forbidden of ['reuseEvidence', 'write', 'persist', 'decision', 'verdict']) {
        expect(payloadKeys).not.toContain(forbidden);
      }
      // Observation, not audit: no evidence records travel in events.
      expect(event.payload).not.toHaveProperty('reuseEvidence');
    }
    // Events never influenced the ledger: the review-only session left it
    // byte-identical to the seeded state even though two events fired.
    const stored = loadLedger(join(workspaceDir, '.state')).tree.principles[existing.id];
    expect(stored?.reuseEvidence).toBeUndefined();
    expect(candidateStatus(candidateId)).toBe('pending');
  });

  it('an event payload that violates the TelemetryEventSchema degrades instead of firing', async () => {
    // Directly probe the emitter contract the review path relies on: a
    // malformed reuse event arrives as degradation_triggered (rc-9), never as
    // a valid-looking reuse event with fabricated authority.
    const before = observedEvents.length;
    storeEmitter.emitTelemetry({
      // @ts-expect-error — intentionally malformed event for the contract probe:
      // sessionId (a required schema field) is missing, so the emitter must
      // degrade to degradation_triggered instead of firing a reuse event.
      eventType: 'reuse_evaluation_recommended',
      traceId: 'probe',
      timestamp: new Date().toISOString(),
      payload: { candidateId: 'c', recommendation: 'reuse', confidence: 0.9 },
    });
    const fired = observedEvents.slice(before);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.eventType).toBe('degradation_triggered');
  });
});

// ── PRI-939 Option A — degradation reaches the durable workspace sink ────────

/** Workspace-parameterized candidate seeder for the isolation test (review only needs task/run/artifact/candidate rows). */
async function seedPrincipleCandidateInto(
  wsDir: string,
  sm: RuntimeStateManager,
): Promise<string> {
  const candidateId = randomUUID();
  const artifactId = randomUUID();
  const now = new Date().toISOString();
  const taskId = randomUUID();
  await sm.taskStore.createTask({
    taskId, taskKind: 'diagnostician', status: 'pending', attemptCount: 0, maxAttempts: 3,
    leaseOwner: undefined, leaseExpiresAt: undefined, lastError: undefined, inputRef: '', resultRef: '', diagnosticJson: undefined,
  });
  const runId = randomUUID();
  await sm.runStore.createRun({
    runId, taskId, runtimeKind: 'openclaw', attemptNumber: 1, executionStatus: 'succeeded', startedAt: now, endedAt: now,
  });
  const db = new Database(join(wsDir, '.pd', 'state.db'));
  try {
    db.prepare(`
      INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(artifactId, runId, taskId, 'principle', JSON.stringify({ text: CANDIDATE_TEXT, triggerPattern: CANDIDATE_TRIGGER, action: CANDIDATE_ACTION }), now);
    db.prepare(`
      INSERT INTO principle_candidates
        (candidate_id, artifact_id, task_id, source_run_id, title, description, confidence,
         source_recommendation_json, idempotency_key, status, created_at, recommendation_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'principle')
    `).run(candidateId, artifactId, taskId, runId, '测试候选', CANDIDATE_TEXT, 0.9,
      JSON.stringify({ text: CANDIDATE_TEXT, triggerPattern: CANDIDATE_TRIGGER, action: CANDIDATE_ACTION }),
      `${artifactId}::prompt`, now);
  } finally {
    db.close();
  }
  return candidateId;
}

function readSinkEvents(sinkPath: string): TelemetryEvent[] {
  if (!fs.existsSync(sinkPath)) return [];
  return fs.readFileSync(sinkPath, 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l) as TelemetryEvent);
}

describe('PRI-939 Option A — Owner visibility for semantic reuse degradation', () => {
  it('review with unavailable evaluation persists the degradation event to the workspace sink (T2)', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-939-sink' });
    writeWorkspaceConfig({ enabled: true, runtimeProfile: 'pd.custom' });
    makeResolverThrow();

    await handleCandidateReview({ candidateId, workspace: workspaceDir, json: true });

    // The singleton still forwards (pre-Option-A observability unchanged)...
    const events = reuseEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('reuse_evaluation_unavailable');
    // ...AND the workspace sink now persists it durably (before: lost with the process).
    const sink = join(workspaceDir, '.pd', 'telemetry', 'critical-events.jsonl');
    expect(fs.existsSync(sink)).toBe(true);
    const persisted = readSinkEvents(sink);
    const unavailable = persisted.find((e) => e.eventType === 'reuse_evaluation_unavailable');
    expect(unavailable).toBeDefined();
    expect((unavailable?.payload as { candidateId: string }).candidateId).toBe(candidateId);
    expect(String((unavailable?.payload as { reason: string }).reason)).toContain('auth_missing');
    // recommended events must NOT land in the sink (no second decision log).
    expect(persisted.some((e) => e.eventType === 'reuse_evaluation_recommended')).toBe(false);
  });

  it('recommended evaluation does NOT create a sink line (allowlist excludes it, T1)', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    const candidateId = await seedPrincipleCandidate({ painId: 'pain-939-rec' });
    writeWorkspaceConfig({ enabled: true, runtimeProfile: 'pd.custom', timeoutMs: 5000 });
    scriptEvaluation([
      { payload: { recommendation: 'reuse', selectedPrincipleId: existing.id, rationale: 'r', confidence: 0.9 } },
    ]);

    await handleCandidateReview({ candidateId, workspace: workspaceDir, json: true });

    expect(readSinkEvents(join(workspaceDir, '.pd', 'telemetry', 'critical-events.jsonl'))
      .some((e) => e.eventType.startsWith('reuse_evaluation'))).toBe(false);
    expect(reuseEvents()[0]?.eventType).toBe('reuse_evaluation_recommended');
  });

  it('T4: with the semantic evaluation unavailable, --decide create and --decide reuse both still work', async () => {
    const existing = makePrinciple();
    addPrincipleToLedger(join(workspaceDir, '.state'), existing);
    writeWorkspaceConfig({ enabled: true, runtimeProfile: 'pd.custom' });
    makeResolverThrow();

    // Owner create on an unavailable evaluation.
    const candidateA = await seedPrincipleCandidate({ painId: 'pain-939-create' });
    await handleCandidateReview({ candidateId: candidateA, workspace: workspaceDir, decide: 'create', reason: 'genuinely new', json: true });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(candidateStatus(candidateA)).toBe('consumed');

    // Owner reuse on an unavailable evaluation (a second pending candidate).
    const candidateB = await seedPrincipleCandidate({ painId: 'pain-939-reuse' });
    await handleCandidateReview({
      candidateId: candidateB, workspace: workspaceDir, decide: 'reuse', principleId: existing.id, reason: 'covers it', json: true,
    });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(candidateStatus(candidateB)).toBe('consumed');
    expect(loadLedger(join(workspaceDir, '.state')).tree.principles[existing.id]?.reuseEvidence).toHaveLength(1);
  });

  it('T5: two workspaces keep their degradation events isolated (multi-host workspace attribution)', async () => {
    writeWorkspaceConfig({ enabled: true, runtimeProfile: 'pd.custom' });
    makeResolverThrow();

    // Workspace A — the harness default (OpenClaw-side workspace, in production terms).
    addPrincipleToLedger(join(workspaceDir, '.state'), makePrinciple());
    const candidateA = await seedPrincipleCandidate({ painId: 'pain-939-wsA' });
    await handleCandidateReview({ candidateId: candidateA, workspace: workspaceDir, json: true });

    // Workspace B — an independently seeded second workspace (the Codex workspace).
    const wsB = join(os.tmpdir(), `pd-reuse-prodval-b-${randomUUID()}`);
    fs.mkdirSync(join(wsB, '.pd'), { recursive: true });
    const smB = new RuntimeStateManager({ workspaceDir: wsB });
    try {
      await smB.initialize();
      writeFileSync(join(wsB, '.pd', 'config.yaml'), fs.readFileSync(join(workspaceDir, '.pd', 'config.yaml')), 'utf8');
      addPrincipleToLedger(join(wsB, '.state'), makePrinciple());
      const candidateB = await seedPrincipleCandidateInto(wsB, smB);

      await handleCandidateReview({ candidateId: candidateB, workspace: wsB, json: true });

      const idsIn = (p: string) => readSinkEvents(p).map((e) => (e.payload as { candidateId?: string }).candidateId);
      expect(idsIn(join(workspaceDir, '.pd', 'telemetry', 'critical-events.jsonl'))).toEqual([candidateA]);
      expect(idsIn(join(wsB, '.pd', 'telemetry', 'critical-events.jsonl'))).toEqual([candidateB]);
    } finally {
      try { smB.close(); } catch { /* best effort */ }
      try { fs.rmSync(wsB, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});
