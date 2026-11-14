/**
 * SIA v1.2 Phase 4 (PRI-1218) — end-to-end chain integration.
 *
 * SPEC-PD-STRATEGIC-INTENT-ANCHORING-001 v1.2 §6 / §7 / §8 / §10
 * TECH-PD-STRATEGIC-INTENT-ANCHORING-001 v1.1 §3 / §5 / §7 / §8
 *
 * EVIDENCE CLASS — read before trusting a green run:
 *   REAL  : SQLite state.db (`RuntimeStateManager`), task CAS, artifact store,
 *           approval queue store, intent decision store, the server-side
 *           strategic-conflict gate, and a REAL `.principles/INTENT.zh-CN.md`
 *           file on disk read through the production `IntentDocReader` port.
 *   FIXTURE: the Stage A model output (`MOCK_ROOT_CAUSE_OUTPUTS.R6` plus
 *           intent-tension overrides) is a runtime double. These tests prove
 *           WIRING + STORAGE + GATE behaviour, NOT model behaviour. Real-model
 *           and real-host acceptance are separate, and are recorded as such in
 *           the phase report (never promoted to PASS from this file).
 *
 * Scenario coverage (PRI-1218's 16 scenarios):
 *   S01 relevant pain · S02 irrelevant pain · S03 intent not configured
 *   S04 not applicable · S05 insufficient evidence · S06 confirmed unresolved
 *   S07 resolved then re-review · S08 intent changed → historical snapshot
 *   S09 digest change invalidates resolution · S10 flag on · S11 flag off
 *   S12 historical V1 · S13 concurrency · S14 failure retry
 *   S15 permission & isolation · S16 server-side bypass attempt
 */
import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { DiagRootCauseRunner } from '../internalization/diag-rootcause-runner.js';
import type { DiagRootCauseRunnerDeps } from '../internalization/diag-rootcause-runner.js';
import { DefaultDiagRootCauseValidator } from '../diagnostician/diag-rootcause-output.js';
import type { DiagRootCauseOutputV1, IntentRelatedField } from '../diagnostician/diag-rootcause-output.js';
import { MOCK_ROOT_CAUSE_OUTPUTS } from '../adapter/split-pipeline-fixtures.js';
import { computeIntentContentHash } from '../intent/intent-hash.js';
import type { IntentDocReader, IntentDocReadResult } from '../intent/intent-doc-reader-port.js';
import { createPITaskDiagnosticJson } from '../internalization/pitask-metadata.js';
import {
  assembleIntentContractV2,
  extractIntentContractV2,
  type IntentContractV1,
  type IntentContractV2,
} from '../internalization/intent-contract.js';
import {
  evaluateStrategicConflictGate,
  describeStrategicConflict,
  STRATEGIC_CONFLICT_UNCONFIRMED,
} from '../intent/strategic-conflict-gate.js';
import { SqliteApprovalQueueStore } from '../activation/sqlite-approval-store.js';
import { SqliteIntentDecisionStore } from '../store/intent/sqlite-intent-decision-store.js';
import { computeArtifactDigest } from '../activation/promotion-evidence-snapshot.js';
import type { EffectivePdConfig } from '../config/pd-config-types.js';
import { getDefaultPdConfig } from '../config/pd-config-defaults.js';
import { resolveProfile } from '../config/pd-profile-constants.js';
import type { RunHandle, RunStatus } from '../runtime-protocol.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TASK_ID = 'diag_rootcause-sia-p4';
const OWNER = 'sia-p4-owner';
const RUNTIME_KIND = 'test-double';

const INTENT_A = `# INTENT.md

## 1. Why
Owner trust is the long-term asset.

## 2. Desired Outcome
Every principle is traceable to its strategic basis.

## 3. Non-negotiables
No unverified claims.

## 4. Stop / Escalation
Stop on unresolved conflict.

## 5. Current Strategic Focus
Close the intent → principle loop.
`;

const INTENT_B = `# INTENT.md

## 1. Why
A different strategy written AFTER the first attempt failed.

## 2. Desired Outcome
Ship faster, skip traceability.

## 3. Non-negotiables
Speed over evidence.

## 4. Stop / Escalation
Never stop.

## 5. Current Strategic Focus
Deprecate the intent loop.
`;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' ? value : null;
}

function makeEffectiveConfig(intentEngineering: boolean): EffectivePdConfig {
  const base = getDefaultPdConfig();
  return {
    config: {
      ...base,
      features: {
        ...base.features,
        intent_engineering: { category: 'quiet', enabled: intentEngineering },
      },
    },
    source: 'user_config',
    warnings: [],
    featuresChangedFromDefault: intentEngineering ? ['intent_engineering'] : [],
    resolvedProfile: resolveProfile({}),
    resolvedContextInjection: { thinkingOs: false, projectFocus: 'off' },
  };
}

function makeRootCauseOutput(overrides: Partial<DiagRootCauseOutputV1> = {}): DiagRootCauseOutputV1 {
  return { ...MOCK_ROOT_CAUSE_OUTPUTS.R6, diagnosisId: 'diag-sia-p4', taskId: TASK_ID, ...overrides };
}

function intentTension(overrides: { relatedIntentFields?: IntentRelatedField[]; explanation?: string; intentDocHash?: string } = {}) {
  return {
    source: 'action_drift' as const,
    evidenceStrength: 'strong' as const,
    relatedIntentFields: overrides.relatedIntentFields ?? (['non_negotiables'] as IntentRelatedField[]),
    evidence: ['owner_reported:cli'],
    explanation: overrides.explanation ?? 'The action drifted from a stated non-negotiable.',
    suggestedOwnerAction: 'confirm_drift' as const,
    ...(overrides.intentDocHash === undefined ? {} : { intentDocHash: overrides.intentDocHash }),
  };
}

// ── Workspace harness (REAL SQLite + REAL files) ─────────────────────────────

interface Workspace {
  readonly dir: string;
  readonly stateManager: RuntimeStateManager;
  readonly reads: { count: number };
}

async function createWorkspace(
  label: string,
  options: { intent?: string | null } = {},
): Promise<Workspace> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pd-sia-p4-${label}-`));
  const intentPath = path.join(dir, '.principles', 'INTENT.zh-CN.md');
  if (options.intent !== null) {
    fs.mkdirSync(path.dirname(intentPath), { recursive: true });
    fs.writeFileSync(intentPath, options.intent ?? INTENT_A, 'utf8');
  }
  const stateManager = new RuntimeStateManager({ workspaceDir: dir });
  await stateManager.initialize();
  return { dir, stateManager, reads: { count: 0 } };
}

async function disposeWorkspace(ws: Workspace): Promise<void> {
  await ws.stateManager.close();
  fs.rmSync(ws.dir, { recursive: true, force: true });
}

function writeIntent(ws: Workspace, raw: string): void {
  const intentPath = path.join(ws.dir, '.principles', 'INTENT.zh-CN.md');
  fs.mkdirSync(path.dirname(intentPath), { recursive: true });
  fs.writeFileSync(intentPath, raw, 'utf8');
}

function deleteIntent(ws: Workspace): void {
  fs.rmSync(path.join(ws.dir, '.principles', 'INTENT.zh-CN.md'), { force: true });
}

/**
 * Concrete `IntentDocReader` over the REAL workspace file.
 *
 * Production implements this port in the plugin layer on top of
 * `safeReadIntentDoc()` (which additionally applies the flag check and a TTL
 * cache). This harness reuses the SAME server-side hash primitive
 * (`computeIntentContentHash`) so the hash under test is the production hash,
 * and therefore a retry that re-reads cannot pass unnoticed.
 */
function createFileReader(ws: Workspace): IntentDocReader {
  return {
    readIntentDoc(): IntentDocReadResult {
      ws.reads.count += 1;
      const file = path.join(ws.dir, '.principles', 'INTENT.zh-CN.md');
      if (!fs.existsSync(file)) {
        return {
          ok: false,
          found: false,
          flagEnabled: true,
          reason: 'not_found',
          nextAction: 'Create .principles/INTENT.zh-CN.md',
        };
      }
      const raw = fs.readFileSync(file, 'utf8');
      return {
        ok: true,
        found: true,
        flagEnabled: true,
        doc: { raw, contentHash: computeIntentContentHash(raw), path: file },
      };
    },
  };
}

async function seedStageATask(ws: Workspace, taskId = TASK_ID): Promise<void> {
  await ws.stateManager.createTask({
    taskId,
    taskKind: 'diag_rootcause',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
    }),
  });
}

interface StageAPlan {
  readonly outputs: readonly DiagRootCauseOutputV1[];
  /** 1-based attempt indexes whose run must report `failed`. */
  readonly failAttempts?: readonly number[];
}

interface StageA {
  readonly runner: DiagRootCauseRunner;
  readonly startRun: Mock;
  readonly pollRun: Mock;
  readonly fetchOutput: Mock;
}

function createStageA(ws: Workspace, plan: StageAPlan, intentEngineering = true): StageA {
  let attempt = 0;
  const startRun = vi.fn(async (): Promise<RunHandle> => {
    attempt += 1;
    return { runId: `run-sia-${attempt}`, runtimeKind: RUNTIME_KIND, startedAt: new Date().toISOString() };
  });
  const pollRun = vi.fn(async (handle: RunHandle): Promise<RunStatus> => {
    const fails = plan.failAttempts?.includes(attempt) ?? false;
    return fails
      ? { status: 'failed', runId: handle.runId, reason: 'model_or_runtime_error' }
      : { status: 'succeeded', runId: handle.runId };
  });
  const fetchOutput = vi.fn(async () => ({
    payload: plan.outputs[Math.min(attempt - 1, plan.outputs.length - 1)],
  }));

  const runtimeAdapter = {
    kind: () => RUNTIME_KIND,
    getCapabilities: vi.fn(),
    healthCheck: vi.fn(),
    startRun,
    pollRun,
    fetchOutput,
    cancelRun: vi.fn(async () => undefined),
    fetchArtifacts: vi.fn(),
  };

  const deps: DiagRootCauseRunnerDeps = {
    stateManager: ws.stateManager,
    runtimeAdapter: runtimeAdapter as unknown as DiagRootCauseRunnerDeps['runtimeAdapter'],
    eventEmitter: { emitTelemetry: vi.fn() },
    artifactStore: ws.stateManager.piArtifactStore,
    validator: new DefaultDiagRootCauseValidator(),
    contextAssembler: {
      assemble: async () => ({
        sourceRefs: ['owner_reported:cli'],
        conversationWindow: [],
        trajectorySummary: '',
        painSignal: { painId: 'pain-sia-p4', painType: 'tool_failure', source: 'e2e', reason: 'fixture', score: 70 },
      }),
    } as unknown as DiagRootCauseRunnerDeps['contextAssembler'],
    intentDocReader: createFileReader(ws),
  };

  const runner = new DiagRootCauseRunner(deps, {
    owner: OWNER,
    runtimeKind: RUNTIME_KIND,
    pollIntervalMs: 1,
    timeoutMs: 1000,
    effectiveConfig: makeEffectiveConfig(intentEngineering),
  });

  return { runner, startRun, pollRun, fetchOutput };
}

async function readArtifactContent(ws: Workspace, taskId = TASK_ID): Promise<Record<string, unknown> | null> {
  const artifacts = await ws.stateManager.piArtifactStore.listBySourceTaskId(taskId);
  const [first] = artifacts;
  if (!first) return null;
  return asRecord(JSON.parse(first.contentJson));
}

async function readPersistedSnapshot(ws: Workspace, taskId = TASK_ID): Promise<Record<string, unknown> | null> {
  const task = await ws.stateManager.getTask(taskId);
  if (!task?.diagnosticJson) return null;
  const parsed = asRecord(JSON.parse(task.diagnosticJson));
  return asRecord(asRecord(parsed?.pi_metadata)?.intentSnapshot);
}

function tensionFromArtifact(content: Record<string, unknown> | null): {
  relatedIntentFields: readonly string[];
  explanation: string | null;
} | undefined {
  const tension = asRecord(content?.intentTension);
  if (tension === null) return undefined;
  const fields = Array.isArray(tension.relatedIntentFields)
    ? tension.relatedIntentFields.filter((field): field is string => typeof field === 'string')
    : [];
  const explanation = stringField(tension, 'explanation');
  return { relatedIntentFields: fields, explanation };
}

function strategicIntentRefFrom(content: Record<string, unknown> | null): {
  contentHash: string;
  capturedAt: string;
} | undefined {
  const snapshot = asRecord(content?.intentSnapshot);
  const contentHash = stringField(snapshot, 'contentHash');
  const capturedAt = stringField(snapshot, 'capturedAt');
  if (contentHash === null || capturedAt === null) return undefined;
  return { contentHash, capturedAt };
}

// ── Contract + approval fixtures ─────────────────────────────────────────────

function v1Contract(): IntentContractV1 {
  return {
    ownerIntent: 'Owner intent text',
    targetBehavior: 'Agent checks the anchor before acting',
    forbiddenBehavior: 'Agent acts without checking the anchor',
    evidenceSource: 'pain-sia-p4',
    validationExpectation: 'An evaluator observes the anchor check',
  };
}

function v2Artifact(options: {
  conflictStatus?: 'none' | 'potential' | 'confirmed';
  relevance?: 'relevant' | 'not_applicable' | 'insufficient_evidence' | 'not_configured';
  intentHash?: string | null;
} = {}): Record<string, unknown> {
  const contentHash = options.intentHash ?? null;
  return {
    ...v1Contract(),
    schemaVersion: 2,
    ...(contentHash === null
      ? {}
      : { strategicIntent: { contentHash, capturedAt: '2026-11-14T00:00:00.000Z' } }),
    strategicAssessment: {
      relevance: options.relevance ?? 'relevant',
      rationale: 'Stage A grounded this formation in INTENT.md',
      conflictStatus: options.conflictStatus ?? 'none',
      ...(options.conflictStatus === 'confirmed'
        ? { conflicts: [{ against: 'core_principle', ref: 'CP-002', status: 'confirmed', evidenceRefs: ['evidence-1'] }] }
        : {}),
    },
  };
}

function seedApprovalRows(
  ws: Workspace,
  args: { suffix: string; content: Record<string, unknown>; candidateIds: readonly string[] },
): { artifactId: string; artifactDigest: string } {
  const db = ws.stateManager.connection.getDb();
  const taskId = `task-${args.suffix}`;
  const runId = `run-${args.suffix}`;
  const artifactId = `art-${args.suffix}`;
  db.prepare(
    "INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, 'scribe', 'succeeded', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
  ).run(taskId);
  db.prepare(
    "INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, created_at, updated_at) VALUES (?, ?, 'internal', 'succeeded', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
  ).run(runId, taskId);
  db.prepare(
    "INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?, ?, ?, 'principle', '{}', '2026-01-01T00:00:00Z')",
  ).run(artifactId, runId, taskId);
  const contentJson = JSON.stringify(args.content);
  db.prepare(
    "INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at) VALUES (?, 'principle', ?, '[]', 'pending', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
  ).run(artifactId, taskId, contentJson);
  for (const [index, candidateId] of args.candidateIds.entries()) {
    db.prepare(
      "INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00Z')",
    ).run(candidateId, artifactId, taskId, runId, `candidate ${index + 1}`, 'desc', `idem-${candidateId}`);
  }
  return {
    artifactId,
    artifactDigest: computeArtifactDigest({
      artifactId,
      artifactKind: 'principle',
      sourceTaskId: taskId,
      lineageArtifactIds: [],
      validationStatus: 'pending',
      contentJson,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }),
  };
}

async function enqueueApproval(ws: Workspace, artifactId: string): Promise<string> {
  const store = new SqliteApprovalQueueStore(ws.stateManager.connection);
  const record = await store.enqueue(
    { artifactId, channel: 'prompt', riskLevel: 'high' },
    '2026-11-14T00:00:00Z',
  );
  return record.approvalId;
}

function approvalStatus(ws: Workspace, approvalId: string): string {
  const row: unknown = ws.stateManager.connection.getDb()
    .prepare('SELECT status FROM approvals WHERE approval_id = ?')
    .get(approvalId);
  return stringField(asRecord(row), 'status') ?? '';
}

async function recordResolution(
  ws: Workspace,
  input: { id: string; artifactId: string; candidateId: string; intentHash: string; ownerAction?: 'confirm_drift' | 'observe' },
): Promise<void> {
  const store = new SqliteIntentDecisionStore(ws.stateManager.connection);
  await store.record({
    id: input.id,
    taskId: `task-${input.id}`,
    intentDocHash: input.intentHash,
    source: 'action_drift',
    evidenceStrength: 'strong',
    relatedIntentFields: ['non_negotiables'],
    ownerAction: input.ownerAction ?? 'confirm_drift',
    evidenceRefs: ['evidence-1'],
    artifactId: input.artifactId,
  });
  await store.updateFollowUp(input.id, { resultingCandidateId: input.candidateId });
}

// ── S01–S05: relevance derivation and the "no confirmed conflict" path ───────

describe('SIA v1.2 Phase 4 — strategic relevance through the real chain', () => {
  it('S01 relevant pain: real INTENT.md → snapshot → server-derived V2 relevance → approval allowed', async () => {
    const ws = await createWorkspace('s01');
    try {
      await seedStageATask(ws);
      const stageA = createStageA(ws, {
        outputs: [makeRootCauseOutput({ intentTension: intentTension() })],
      });

      const result = await stageA.runner.run(TASK_ID);
      expect(result.status).toBe('succeeded');

      const expectedHash = computeIntentContentHash(INTENT_A);
      const persisted = await readPersistedSnapshot(ws);
      expect(stringField(persisted, 'contentHash')).toBe(expectedHash);

      const content = await readArtifactContent(ws);
      expect(stringField(asRecord(content?.intentSnapshot), 'contentHash')).toBe(expectedHash);
      // The model never authors the hash: the runner replaces it with the server value.
      expect(stringField(asRecord(content?.intentTension), 'intentDocHash')).toBe(expectedHash);

      const assembly = assembleIntentContractV2({
        base: v1Contract(),
        diagnosisAvailable: true,
        strategicIntentRef: strategicIntentRefFrom(content),
        intentTension: tensionFromArtifact(content),
      });
      expect(assembly.ok).toBe(true);
      if (!assembly.ok) return;
      expect(assembly.contract.strategicAssessment.relevance).toBe('relevant');
      expect(assembly.contract.strategicAssessment.conflictStatus).toBe('none');
      expect(assembly.contract.strategicIntent?.contentHash).toBe(expectedHash);
      expect(assembly.contract.strategicIntent?.relevantSections).toEqual(['non_negotiables']);

      const seeded = seedApprovalRows(ws, {
        suffix: 's01',
        content: { intentContract: assembly.contract },
        candidateIds: ['cand-s01'],
      });
      const approvalId = await enqueueApproval(ws, seeded.artifactId);
      const store = new SqliteApprovalQueueStore(ws.stateManager.connection);
      const approved = await store.approve(approvalId, 'owner', 'LGTM');
      expect(approved.ok).toBe(true);
      expect(approvalStatus(ws, approvalId)).toBe('approved');
    } finally {
      await disposeWorkspace(ws);
    }
  });

  it('S02 irrelevant pain: Stage A reports no related INTENT section → not_applicable', async () => {
    const ws = await createWorkspace('s02');
    try {
      await seedStageATask(ws);
      const stageA = createStageA(ws, {
        outputs: [makeRootCauseOutput({ intentTension: intentTension({ relatedIntentFields: [], explanation: 'Unrelated to the Owner intent.' }) })],
      });
      const result = await stageA.runner.run(TASK_ID);
      expect(result.status).toBe('succeeded');

      const content = await readArtifactContent(ws);
      const assembly = assembleIntentContractV2({
        base: v1Contract(),
        diagnosisAvailable: true,
        strategicIntentRef: strategicIntentRefFrom(content),
        intentTension: tensionFromArtifact(content),
      });
      expect(assembly.ok).toBe(true);
      if (!assembly.ok) return;
      expect(assembly.contract.strategicAssessment.relevance).toBe('not_applicable');
      // relevance is derived from Stage A, never from intentTension.source
      expect(tensionFromArtifact(content)?.relatedIntentFields).toEqual([]);
    } finally {
      await disposeWorkspace(ws);
    }
  });

  it('S03 intent not configured: no INTENT.md → no snapshot, relevance not_configured', async () => {
    const ws = await createWorkspace('s03', { intent: null });
    try {
      await seedStageATask(ws);
      const stageA = createStageA(ws, { outputs: [makeRootCauseOutput()] });
      const result = await stageA.runner.run(TASK_ID);
      expect(result.status).toBe('succeeded');
      expect(ws.reads.count).toBe(1);

      const content = await readArtifactContent(ws);
      expect(content).not.toBeNull();
      expect(content).not.toHaveProperty('intentSnapshot');

      const assembly = assembleIntentContractV2({
        base: v1Contract(),
        diagnosisAvailable: true,
        strategicIntentRef: strategicIntentRefFrom(content),
        intentTension: tensionFromArtifact(content),
      });
      expect(assembly.ok).toBe(true);
      if (!assembly.ok) return;
      expect(assembly.contract.strategicAssessment.relevance).toBe('not_configured');
      expect(assembly.contract.strategicIntent).toBeUndefined();
    } finally {
      await disposeWorkspace(ws);
    }
  });

  it('S04 not applicable: a V2 with not_applicable is approvable (no confirmed conflict)', async () => {
    const ws = await createWorkspace('s04', { intent: null });
    try {
      const contract: IntentContractV2 = {
        ...v1Contract(),
        schemaVersion: 2,
        strategicAssessment: {
          relevance: 'not_applicable',
          rationale: 'Stage A judged the pain unrelated to the Owner intent',
          conflictStatus: 'none',
        },
        corePrincipleRefs: [],
      };
      const seeded = seedApprovalRows(ws, {
        suffix: 's04',
        content: { intentContract: contract },
        candidateIds: ['cand-s04'],
      });
      const approvalId = await enqueueApproval(ws, seeded.artifactId);
      const store = new SqliteApprovalQueueStore(ws.stateManager.connection);
      const result = await store.approve(approvalId, 'owner', 'LGTM');
      expect(result.ok).toBe(true);
    } finally {
      await disposeWorkspace(ws);
    }
  });

  it('S05 insufficient evidence: no diagnosis artifact → insufficient_evidence, still not a conflict block', async () => {
    const ws = await createWorkspace('s05', { intent: null });
    try {
      const assembly = assembleIntentContractV2({ base: v1Contract(), diagnosisAvailable: false });
      expect(assembly.ok).toBe(true);
      if (!assembly.ok) return;
      expect(assembly.contract.strategicAssessment.relevance).toBe('insufficient_evidence');
      expect(assembly.contract.strategicAssessment.conflictStatus).toBe('none');

      const seeded = seedApprovalRows(ws, {
        suffix: 's05',
        content: { intentContract: assembly.contract },
        candidateIds: ['cand-s05'],
      });
      const approvalId = await enqueueApproval(ws, seeded.artifactId);
      const gate = evaluateStrategicConflictGate({
        artifactContent: { intentContract: assembly.contract },
        artifactDigest: seeded.artifactDigest,
        candidateIds: ['cand-s05'],
        resolutions: [],
      });
      expect(gate.ok).toBe(true);

      const store = new SqliteApprovalQueueStore(ws.stateManager.connection);
      expect((await store.approve(approvalId, 'owner', 'LGTM')).ok).toBe(true);
    } finally {
      await disposeWorkspace(ws);
    }
  });
});

// ── S06–S09, S16: the confirmed-conflict gate over the real approval store ───

describe('SIA v1.2 Phase 4 — confirmed conflict governance', () => {
  it('S06 confirmed unresolved: server refuses, approval stays pending, UI view mirrors the refusal', async () => {
    const ws = await createWorkspace('s06', { intent: null });
    try {
      const seeded = seedApprovalRows(ws, {
        suffix: 's06',
        content: { intentContract: v2Artifact({ conflictStatus: 'confirmed', intentHash: 'sha256:intent-a' }) },
        candidateIds: ['cand-s06'],
      });
      const approvalId = await enqueueApproval(ws, seeded.artifactId);
      const store = new SqliteApprovalQueueStore(ws.stateManager.connection);

      const result = await store.approve(approvalId, 'owner', 'LGTM');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe(STRATEGIC_CONFLICT_UNCONFIRMED);
      if (result.error !== STRATEGIC_CONFLICT_UNCONFIRMED) return;
      expect(result.reason).toContain('no_effective_resolution');
      expect(result.reason).toContain('core_principle:CP-002');
      expect(approvalStatus(ws, approvalId)).toBe('pending');

      const view = describeStrategicConflict({
        artifactContent: { intentContract: v2Artifact({ conflictStatus: 'confirmed', intentHash: 'sha256:intent-a' }) },
        artifactDigest: seeded.artifactDigest,
        candidateIds: ['cand-s06'],
        resolutions: [],
      });
      expect(view.isV2).toBe(true);
      expect(view.conflictStatus).toBe('confirmed');
      expect(view.blockCode).toBe(STRATEGIC_CONFLICT_UNCONFIRMED);
      expect(view.conflicts.map((conflict) => `${conflict.against}:${conflict.ref}`)).toEqual(['core_principle:CP-002']);
    } finally {
      await disposeWorkspace(ws);
    }
  });

  it('S07 resolved then re-review: a bound resolution lets the approval through', async () => {
    const ws = await createWorkspace('s07', { intent: null });
    try {
      const seeded = seedApprovalRows(ws, {
        suffix: 's07',
        content: { intentContract: v2Artifact({ conflictStatus: 'confirmed', intentHash: 'sha256:intent-a' }) },
        candidateIds: ['cand-s07'],
      });
      const approvalId = await enqueueApproval(ws, seeded.artifactId);
      await recordResolution(ws, {
        id: 'decision-s07',
        artifactId: seeded.artifactId,
        candidateId: 'cand-s07',
        intentHash: 'sha256:intent-a',
      });
      const store = new SqliteApprovalQueueStore(ws.stateManager.connection);
      const result = await store.approve(approvalId, 'owner', 'Owner confirmed the drift');
      expect(result.ok).toBe(true);
      expect(approvalStatus(ws, approvalId)).toBe('approved');
    } finally {
      await disposeWorkspace(ws);
    }
  });

  it('S08 intent changed after capture: the retry keeps the FIRST snapshot (history wins)', async () => {
    const ws = await createWorkspace('s08');
    try {
      await seedStageATask(ws);
      const stageA = createStageA(ws, {
        outputs: [makeRootCauseOutput({ intentTension: intentTension({ relatedIntentFields: ['why'] }) })],
        failAttempts: [1],
      });

      const first = await stageA.runner.run(TASK_ID);
      expect(first.status).not.toBe('succeeded');
      const hashA = computeIntentContentHash(INTENT_A);
      expect(stringField(await readPersistedSnapshot(ws), 'contentHash')).toBe(hashA);

      // The Owner rewrites INTENT.md between attempts.
      writeIntent(ws, INTENT_B);
      const second = await stageA.runner.run(TASK_ID);
      expect(second.status).toBe('succeeded');
      // Exactly one read: the retry never re-read the file.
      expect(ws.reads.count).toBe(1);

      const content = await readArtifactContent(ws);
      expect(stringField(asRecord(content?.intentSnapshot), 'contentHash')).toBe(hashA);
      const prompt = asRecord(stageA.startRun.mock.calls[1]?.[0])?.inputPayload;
      expect(typeof prompt).toBe('string');
      expect(prompt).toContain(hashA);
      expect(prompt).not.toContain('different strategy');
    } finally {
      await disposeWorkspace(ws);
    }
  });

  it('S08b the intent FILE can disappear after capture without affecting history', async () => {
    const ws = await createWorkspace('s08b');
    try {
      await seedStageATask(ws);
      const stageA = createStageA(ws, {
        outputs: [makeRootCauseOutput({ intentTension: intentTension() })],
        failAttempts: [1],
      });
      await stageA.runner.run(TASK_ID);
      deleteIntent(ws);

      const second = await stageA.runner.run(TASK_ID);
      expect(second.status).toBe('succeeded');
      expect(ws.reads.count).toBe(1);
      expect(stringField(await readPersistedSnapshot(ws), 'contentHash')).toBe(computeIntentContentHash(INTENT_A));
    } finally {
      await disposeWorkspace(ws);
    }
  });

  it('S09 digest change: rewriting the artifact invalidates the old resolution', async () => {
    const ws = await createWorkspace('s09', { intent: null });
    try {
      const seeded = seedApprovalRows(ws, {
        suffix: 's09',
        content: { intentContract: v2Artifact({ conflictStatus: 'confirmed', intentHash: 'sha256:intent-a' }) },
        candidateIds: ['cand-s09'],
      });
      const approvalId = await enqueueApproval(ws, seeded.artifactId);
      await recordResolution(ws, {
        id: 'decision-s09',
        artifactId: seeded.artifactId,
        candidateId: 'cand-s09',
        intentHash: 'sha256:intent-a',
      });

      // A re-scribe rewrites the artifact content: the approval is now bound to
      // a different digest, so the recorded resolution must stop applying.
      ws.stateManager.connection.getDb().prepare(
        'UPDATE pi_artifacts SET content_json = ?, updated_at = ? WHERE artifact_id = ?',
      ).run(
        JSON.stringify({ intentContract: v2Artifact({ conflictStatus: 'confirmed', intentHash: 'sha256:intent-a' }), reScribed: true }),
        '2026-11-14T00:00:01Z',
        seeded.artifactId,
      );

      const store = new SqliteApprovalQueueStore(ws.stateManager.connection);
      const result = await store.approve(approvalId, 'owner', 'LGTM');
      expect(result.ok).toBe(false);
      expect(approvalStatus(ws, approvalId)).toBe('pending');
    } finally {
      await disposeWorkspace(ws);
    }
  });

  it('S16 bypass attempt: a resolution without a server-bound digest does not open the gate', async () => {
    const ws = await createWorkspace('s16', { intent: null });
    try {
      const seeded = seedApprovalRows(ws, {
        suffix: 's16',
        content: { intentContract: v2Artifact({ conflictStatus: 'confirmed', intentHash: 'sha256:intent-a' }) },
        candidateIds: ['cand-s16'],
      });
      const approvalId = await enqueueApproval(ws, seeded.artifactId);

      // Data-layer forgery: correct candidate + correct intent hash, but no
      // digest binding (the column the server computes and owns).
      const db = ws.stateManager.connection.getDb();
      db.prepare(
        "INSERT INTO intent_decisions (id, task_id, intent_doc_hash, source, evidence_strength, related_intent_fields, owner_action, evidence_refs, source_snapshot, evidence_strength_snapshot, related_intent_fields_snapshot, evidence_refs_snapshot, resulting_candidate_id, contract_digest, created_at) VALUES ('forged', 'task-s16', 'sha256:intent-a', 'action_drift', 'strong', '[\"non_negotiables\"]', 'confirm_drift', '[\"evidence-1\"]', '{}', 'strong', '[]', '[]', 'cand-s16', NULL, '2026-11-14T00:00:00Z')",
      ).run();

      const store = new SqliteApprovalQueueStore(ws.stateManager.connection);
      expect((await store.approve(approvalId, 'owner', 'LGTM')).ok).toBe(false);
      expect(approvalStatus(ws, approvalId)).toBe('pending');

      // The store exposes exactly ONE approval-decision entry point: a second,
      // ungated writer would be a silent bypass.
      const decisionMethods = Object.getOwnPropertyNames(SqliteApprovalQueueStore.prototype)
        .filter((name) => /approv/i.test(name));
      expect(decisionMethods).toEqual(['approve']);
    } finally {
      await disposeWorkspace(ws);
    }
  });
});

// ── S10–S14: flags, historical compatibility, concurrency, retry ─────────────

describe('SIA v1.2 Phase 4 — flags, compatibility, concurrency, retry', () => {
  it('S10 flag on: the snapshot is persisted before the model call with the server hash', async () => {
    const ws = await createWorkspace('s10');
    try {
      await seedStageATask(ws);
      const stageA = createStageA(ws, { outputs: [makeRootCauseOutput()] }, true);
      await stageA.runner.run(TASK_ID);

      expect(stageA.startRun).toHaveBeenCalledTimes(1);
      const persisted = await readPersistedSnapshot(ws);
      expect(stringField(persisted, 'contentHash')).toBe(computeIntentContentHash(INTENT_A));
      expect(stringField(persisted, 'capturedAt')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // The prompt was rebuilt from the snapshot, so it carries the basis.
      const prompt = asRecord(stageA.startRun.mock.calls[0]?.[0])?.inputPayload;
      expect(prompt).toContain('Owner trust is the long-term asset.');
    } finally {
      await disposeWorkspace(ws);
    }
  });

  it('S11 flag off: INTENT.md is neither read nor injected, and no snapshot is written', async () => {
    const ws = await createWorkspace('s11');
    try {
      await seedStageATask(ws);
      const stageA = createStageA(ws, { outputs: [makeRootCauseOutput()] }, false);
      const result = await stageA.runner.run(TASK_ID);

      expect(result.status).toBe('succeeded');
      expect(ws.reads.count).toBe(0);
      expect(await readPersistedSnapshot(ws)).toBeNull();

      const content = await readArtifactContent(ws);
      expect(content).not.toBeNull();
      expect(content).not.toHaveProperty('intentSnapshot');
      const call = asRecord(stageA.startRun.mock.calls[0]?.[0]);
      expect(String(call?.inputPayload)).not.toContain(computeIntentContentHash(INTENT_A));
      expect(String(call?.systemPrompt)).not.toContain('PHASE 3.6');
    } finally {
      await disposeWorkspace(ws);
    }
  });

  it('S12 historical V1: an artifact without schemaVersion 2 is never gated', async () => {
    const ws = await createWorkspace('s12', { intent: null });
    try {
      const seeded = seedApprovalRows(ws, {
        suffix: 's12',
        content: { intentContract: v1Contract() },
        candidateIds: ['cand-s12'],
      });
      const approvalId = await enqueueApproval(ws, seeded.artifactId);

      expect(extractIntentContractV2({ intentContract: v1Contract() })).toBeNull();
      const view = describeStrategicConflict({
        artifactContent: { intentContract: v1Contract() },
        artifactDigest: seeded.artifactDigest,
        candidateIds: ['cand-s12'],
        resolutions: [],
      });
      expect(view.isV2).toBe(false);
      expect(view.blockCode).toBeNull();

      const store = new SqliteApprovalQueueStore(ws.stateManager.connection);
      expect((await store.approve(approvalId, 'owner', 'LGTM')).ok).toBe(true);
    } finally {
      await disposeWorkspace(ws);
    }
  });

  it('S13 concurrency: one snapshot CAS winner and one approval winner', async () => {
    const ws = await createWorkspace('s13', { intent: null });
    try {
      await seedStageATask(ws);
      const task = await ws.stateManager.getTask(TASK_ID);
      const expected = task?.diagnosticJson ?? null;
      expect(expected).not.toBeNull();

      const [first, second] = await Promise.all([
        ws.stateManager.updateTaskIfDiagnosticJsonUnchanged(TASK_ID, expected, { diagnosticJson: '{"pi_metadata":{"winner":1}}' }),
        ws.stateManager.updateTaskIfDiagnosticJsonUnchanged(TASK_ID, expected, { diagnosticJson: '{"pi_metadata":{"winner":2}}' }),
      ]);
      expect([first, second].filter((updated) => updated !== null)).toHaveLength(1);

      const seeded = seedApprovalRows(ws, {
        suffix: 's13',
        content: { intentContract: v2Artifact({ conflictStatus: 'confirmed', intentHash: 'sha256:intent-a' }) },
        candidateIds: ['cand-s13'],
      });
      const approvalId = await enqueueApproval(ws, seeded.artifactId);
      await recordResolution(ws, {
        id: 'decision-s13',
        artifactId: seeded.artifactId,
        candidateId: 'cand-s13',
        intentHash: 'sha256:intent-a',
      });
      const store = new SqliteApprovalQueueStore(ws.stateManager.connection);
      const results = await Promise.all([
        store.approve(approvalId, 'owner', 'first'),
        store.approve(approvalId, 'owner', 'second'),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(approvalStatus(ws, approvalId)).toBe('approved');
    } finally {
      await disposeWorkspace(ws);
    }
  });

  it('S14 failure retry: the second attempt succeeds on the snapshot captured by the first', async () => {
    const ws = await createWorkspace('s14');
    try {
      await seedStageATask(ws);
      const stageA = createStageA(ws, {
        outputs: [makeRootCauseOutput({ intentTension: intentTension() })],
        failAttempts: [1],
      });
      expect((await stageA.runner.run(TASK_ID)).status).not.toBe('succeeded');
      const hashA = computeIntentContentHash(INTENT_A);
      expect(stringField(await readPersistedSnapshot(ws), 'contentHash')).toBe(hashA);

      const retry = await stageA.runner.run(TASK_ID);
      expect(retry.status).toBe('succeeded');
      expect(ws.reads.count).toBe(1);
      const content = await readArtifactContent(ws);
      expect(stringField(asRecord(content?.intentSnapshot), 'contentHash')).toBe(hashA);
      expect(stringField(asRecord(content?.intentTension), 'intentDocHash')).toBe(hashA);
    } finally {
      await disposeWorkspace(ws);
    }
  });
});

// ── S15: permission & isolation ──────────────────────────────────────────────

describe('SIA v1.2 Phase 4 — permission & workspace isolation', () => {
  it('S15 one workspace cannot see another workspace snapshot, artifact or approval', async () => {
    const a = await createWorkspace('s15a');
    const b = await createWorkspace('s15b', { intent: null });
    try {
      await seedStageATask(a);
      const stageA = createStageA(a, { outputs: [makeRootCauseOutput({ intentTension: intentTension() })] });
      expect((await stageA.runner.run(TASK_ID)).status).toBe('succeeded');
      expect(stringField(await readPersistedSnapshot(a), 'contentHash')).toBe(computeIntentContentHash(INTENT_A));

      // B has its own database: nothing from A is readable, including the task.
      expect(await b.stateManager.getTask(TASK_ID)).toBeNull();
      expect(await b.stateManager.piArtifactStore.listBySourceTaskId(TASK_ID)).toHaveLength(0);

      const seeded = seedApprovalRows(a, {
        suffix: 's15',
        content: { intentContract: v2Artifact({ conflictStatus: 'confirmed', intentHash: 'sha256:intent-a' }) },
        candidateIds: ['cand-s15'],
      });
      await enqueueApproval(a, seeded.artifactId);

      const countB: unknown = b.stateManager.connection.getDb()
        .prepare('SELECT COUNT(*) AS count FROM approvals')
        .get();
      expect(asRecord(countB)?.count).toBe(0);

      // The refusal in A is authoritative for A only; B never gained a row.
      const countA: unknown = a.stateManager.connection.getDb()
        .prepare('SELECT COUNT(*) AS count FROM approvals')
        .get();
      expect(asRecord(countA)?.count).toBe(1);
    } finally {
      await disposeWorkspace(a);
      await disposeWorkspace(b);
    }
  });
});
