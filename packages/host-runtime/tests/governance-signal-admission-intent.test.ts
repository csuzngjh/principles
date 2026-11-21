/**
 * PRI-1233 / SPEC-PD-INTENT-UNIFICATION-001 §9.2 — governance-admitted pains
 * capture the Stage A intent snapshot through the REAL admission → ensure →
 * L3-consumer execution chain.
 *
 * `ensureGovernanceDiagnosticianTask` creates the task asynchronously, so the
 * place Stage A actually runs for an admitted pain is the L3 consumer
 * (`runPendingDiagnosticianOnce`) or the workspace workers. This test drives
 * the real public boundary: admit a correction signal, ensure the
 * continuation, execute the pending diagnostician, and assert the persisted
 * snapshot. Only the LLM network boundary is scripted (PiAiRuntimeAdapter
 * prototype spy) — admission, marker, task creation, bridge, runner, reader,
 * fs and SQLite are all real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  admitGovernanceSignals,
  buildSharedSeedKeywordStore,
  ensureGovernanceDiagnosticianTask,
  type GovernanceCorrectionCandidate,
} from '../src/governance-signal-admission.js';
import { recordConversationIngestionConsent } from '../src/conversation-ingestion/consent.js';
import { CODEX_INGESTION_DISCLOSURE_VERSION } from '../src/codex-disclosure.js';
import { ingestGovernanceObservations } from '../src/governance-observation-store.js';
import { runPendingDiagnosticianOnce } from '../src/diagnostician-auto-run.js';
import { resetHostIntentDocCacheForTest } from '../src/intent-doc-reader.js';
import {
  PiAiRuntimeAdapter,
  RuntimeStateManager,
  computeIntentContentHash,
  getDefaultPdConfig,
  invalidatePainSignalBridge,
} from '@principles/core/runtime';
import {
  MOCK_ROOT_CAUSE_OUTPUTS,
  MOCK_DISTILLER_OUTPUTS,
  MOCK_ROUTER_OUTPUTS,
} from '../../principles-core/src/runtime/adapter/split-pipeline-fixtures.js';

const BASELINE_DDL = [
  'CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)',
  'CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)',
  'CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL',
];

const AUTHORED_INTENT = [
  '# INTENT.md',
  '',
  '## 1. Why',
  '',
  '治理信号的诊断必须保持证据真实，这是系统的信任根基。',
  '',
  '## 2. Desired Outcome',
  '',
  '被接纳的纠正信号在诊断中引用真实的行为观察。',
  '',
  '## 3. Non-negotiables',
  '',
  '不以伪证据换取诊断完成率。',
  '',
  '## 4. Stop / Escalation',
  '',
  '治理任务失败时保留状态交给 Owner，不自动清理。',
  '',
  '## 5. Current Strategic Focus',
  '',
  '诊断链路的可信度优先于吞吐量。',
  '',
].join('\n');

let workspaceDir: string;

function writeConfig(intentEnabled: boolean): void {
  const config = getDefaultPdConfig() as Record<string, unknown> & {
    features: Record<string, unknown>;
    runtimeProfiles: Record<string, unknown>;
  };
  config.features = {
    ...config.features,
    intent_engineering: { category: 'quiet', enabled: intentEnabled },
    // L3 automatic diagnosis is the execution path under test.
    openclaw_diagnostician_consumer: { category: 'quiet', enabled: true },
    // SPEC §9.6: this suite exercises the authorized B-class path.
    automatic_pain_submission: { category: 'quiet', enabled: true },
  };
  config.runtimeProfiles = {
    ...config.runtimeProfiles,
    'pd.default': {
      type: 'pi-ai', provider: 'gov-prov', model: 'gov-model',
      apiKeyEnv: 'GOV_INTENT_ADMISSION_KEY', baseUrl: 'http://127.0.0.1:8080/v1',
    },
  };
  (config as { internalAgents: { defaultRuntime: string } }).internalAgents.defaultRuntime = 'pd.default';
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
  // PRI-1283 R2: governance continuation requires granted consent-ledger
  // state (see source-revocation-safety.test.ts for the revocation matrix).
  recordConversationIngestionConsent(workspaceDir, 'codex', {
    decision: 'granted',
    decidedVia: 'pd_codex_setup',
    decidedAt: new Date().toISOString(),
    disclosureVersion: CODEX_INGESTION_DISCLOSURE_VERSION,
  });
  process.env.GOV_INTENT_ADMISSION_KEY = 'test-key';
}

function writeIntent(content: string): void {
  fs.mkdirSync(path.join(workspaceDir, '.principles'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.principles', 'INTENT.zh-CN.md'), content, 'utf8');
}

/** Script the LLM boundary (same technique as the pd-cli integration tests). */
function installAdapterSpy(): void {
  const runIdToTaskId = new Map<string, string>();
  let counter = 0;
  let rootCauseTaskId: string | null = null;
  // The governance observation is the one trusted evidence ref.
  const TRUSTED = 'governance_observation:codex|rollout-1|turn-1|user';

  vi.spyOn(PiAiRuntimeAdapter.prototype, 'getCapabilities').mockResolvedValue({
    supportsStructuredJsonOutput: true,
    supportsToolUse: false,
    supportsWorkingDirectory: false,
    supportsModelSelection: false,
    supportsLongRunningSessions: false,
    supportsCancellation: true,
    supportsArtifactWriteBack: false,
    supportsConcurrentRuns: false,
    supportsStreaming: false,
  });
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'healthCheck').mockResolvedValue({
    healthy: true, degraded: false, warnings: [], lastCheckedAt: new Date().toISOString(),
  });
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'startRun').mockImplementation(async (input) => {
    counter += 1;
    const runId = `gov-intent-run-${counter}`;
    const taskId = input.taskRef?.taskId;
    if (typeof taskId === 'string') runIdToTaskId.set(runId, taskId);
    return {
      runId,
      runtimeKind: 'pi-ai',
      startedAt: new Date().toISOString(),
      // Adapter contract: the router receipt binds the prompt digest actually sent.
      systemPromptDigest: createHash('sha256').update(input.systemPrompt ?? '', 'utf8').digest('hex'),
    };
  });
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'pollRun').mockImplementation(async (runId: string) => ({
    runId, status: 'succeeded' as const,
    startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
  }));
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'fetchOutput').mockImplementation(async (runId: string) => {
    const taskId = runIdToTaskId.get(runId);
    if (taskId !== undefined && taskId.includes('diag_distiller')) {
      const sourceRootCauseArtifactId = `pi-art-${rootCauseTaskId ?? ''}-run_${rootCauseTaskId ?? ''}_1`;
      return { runId, payload: { ...MOCK_DISTILLER_OUTPUTS.R6, taskId, sourceRootCauseArtifactId } };
    }
    if (taskId !== undefined && taskId.includes('diag_router')) {
      return {
        runId,
        payload: {
          ...MOCK_ROUTER_OUTPUTS.R6,
          evidence: [{ sourceRef: TRUSTED, note: 'Owner correction observation.' }],
          recommendations: MOCK_ROUTER_OUTPUTS.R6.recommendations.map((rec) =>
            rec.kind === 'rule' && rec.principleAssociation
              ? { ...rec, principleAssociation: { ...rec.principleAssociation, evidenceRefs: [TRUSTED] } }
              : rec,
          ),
        },
      };
    }
    rootCauseTaskId = taskId ?? null;
    const r6 = MOCK_ROOT_CAUSE_OUTPUTS.R6;
    return {
      runId,
      payload: {
        ...r6,
        taskId: taskId ?? 'gov-intent-task',
        evidence: [{ sourceRef: TRUSTED, note: 'Owner correction observation.' }],
        causalChain: r6.causalChain.map((entry) => ({ ...entry, evidenceRefs: [TRUSTED] })),
      },
    };
  });
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'fetchArtifacts').mockResolvedValue([]);
}

const NOW = new Date('2026-11-16T12:00:00.000Z');

function correction(): GovernanceCorrectionCandidate {
  return {
    kind: 'user_correction',
    hostKind: 'codex',
    logicalObservationKey: 'codex|rollout-1|turn-1|user',
    rolloutIdentity: 'rollout-1',
    rootSessionId: 'root-session-1',
    hostTurnId: 'turn-1',
    text: '不要自作主张,这是错的,我说过先调查已有实现',
    observedAt: NOW.toISOString(),
  };
}

function seedObservation(): void {
  const candidate = correction();
  ingestGovernanceObservations({
    workspaceDir,
    rollout: { hostKind: 'codex', rolloutIdentity: candidate.rolloutIdentity, rootSessionId: candidate.rootSessionId },
    observations: [{
      hostKind: 'codex',
      rolloutIdentity: candidate.rolloutIdentity,
      rootSessionId: candidate.rootSessionId,
      hostTurnId: candidate.hostTurnId,
      kind: 'user_turn',
      logicalObservationKey: candidate.logicalObservationKey,
      visibleText: candidate.text,
      source: 'live_hook',
      completeness: 'complete',
      observedAt: NOW.toISOString(),
    }],
    now: NOW,
  });
}

async function readStageSnapshot(taskId: string): Promise<{ contentHash?: string } | undefined> {
  const stateManager = new RuntimeStateManager({ workspaceDir });
  try {
    await stateManager.initialize();
    for (const candidateId of [taskId, `diag_rootcause-${taskId}`]) {
      const task = await stateManager.getTask(candidateId);
      if (task?.diagnosticJson === undefined || task.diagnosticJson === null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(task.diagnosticJson);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== 'object' || !Object.hasOwn(parsed, 'pi_metadata')) continue;
      const metadata = (parsed as Record<string, unknown>).pi_metadata;
      if (metadata !== null && typeof metadata === 'object' && Object.hasOwn(metadata as object, 'intentSnapshot')) {
        return (metadata as Record<string, unknown>).intentSnapshot as { contentHash?: string };
      }
    }
    return undefined;
  } finally {
    await stateManager.close().catch(() => undefined);
  }
}

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gov-intent-'));
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  const sqlite = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
  for (const statement of BASELINE_DDL) sqlite.prepare(statement).run();
  sqlite.close();
  resetHostIntentDocCacheForTest();
});

afterEach(async () => {
  delete process.env.GOV_INTENT_ADMISSION_KEY;
  vi.restoreAllMocks();
  resetHostIntentDocCacheForTest();
  invalidatePainSignalBridge(workspaceDir);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
});

describe('PRI-1233: governance admission → L3 execution captures the intent snapshot', () => {
  it('admitted pain (flag ON, authored INTENT) captures the snapshot through the real admission chain', async () => {
    writeConfig(true);
    writeIntent(AUTHORED_INTENT);
    seedObservation();
    installAdapterSpy();

    const admitted = admitGovernanceSignals({
      workspaceDir,
      candidates: [correction()],
      now: NOW,
      keywordStore: buildSharedSeedKeywordStore(),
    });
    expect(admitted.outcomes?.[0]).toMatchObject({ disposition: 'admitted' });
    const painId = (admitted.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId ?? '';

    const ensured = await ensureGovernanceDiagnosticianTask({
      workspaceDir,
      logicalObservationKey: 'codex|rollout-1|turn-1|user',
      canonicalPainId: painId,
    });
    expect(ensured).toMatchObject({ ok: true, created: true });
    const taskId = ensured.ok ? ensured.taskId : '';

    // Idempotent: replay does not create a second task.
    const replay = await ensureGovernanceDiagnosticianTask({
      workspaceDir,
      logicalObservationKey: 'codex|rollout-1|turn-1|user',
      canonicalPainId: painId,
    });
    expect(replay).toMatchObject({ ok: true, created: false, duplicate: true });

    // Task creation alone runs nothing — no snapshot yet.
    expect(await readStageSnapshot(taskId)).toBeUndefined();

    const run = await runPendingDiagnosticianOnce({ workspaceDir, serviceStarted: true, now: NOW.toISOString() });
    expect(run, `runPendingDiagnosticianOnce result: ${JSON.stringify(run)}`).toMatchObject({ served: true });

    const snapshot = await readStageSnapshot(taskId);
    expect(snapshot).toMatchObject({ contentHash: computeIntentContentHash(AUTHORED_INTENT), lang: 'zh-CN' });
  }, 180_000);

  it('flag OFF: the admitted pain diagnoses normally with NO snapshot and zero intent capture', async () => {
    writeConfig(false);
    writeIntent(AUTHORED_INTENT);
    seedObservation();
    installAdapterSpy();

    const admitted = admitGovernanceSignals({
      workspaceDir,
      candidates: [correction()],
      now: NOW,
      keywordStore: buildSharedSeedKeywordStore(),
    });
    expect(admitted.outcomes?.[0]).toMatchObject({ disposition: 'admitted' });
    const painId = (admitted.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId ?? '';

    const ensured = await ensureGovernanceDiagnosticianTask({
      workspaceDir,
      logicalObservationKey: 'codex|rollout-1|turn-1|user',
      canonicalPainId: painId,
    });
    expect(ensured).toMatchObject({ ok: true, created: true });

    const run = await runPendingDiagnosticianOnce({ workspaceDir, serviceStarted: true, now: NOW.toISOString() });
    expect(run.served).toBe(true);

    expect(await readStageSnapshot(ensured.ok ? ensured.taskId : '')).toBeUndefined();
  }, 180_000);

  it('a reader failure (oversized INTENT) degrades without breaking the admitted pain diagnosis', async () => {
    writeConfig(true);
    writeIntent(`${AUTHORED_INTENT}\n${'y'.repeat(33 * 1024)}\n`);
    seedObservation();
    installAdapterSpy();

    const admitted = admitGovernanceSignals({
      workspaceDir,
      candidates: [correction()],
      now: NOW,
      keywordStore: buildSharedSeedKeywordStore(),
    });
    expect(admitted.outcomes?.[0]).toMatchObject({ disposition: 'admitted' });
    const painId = (admitted.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId ?? '';

    const ensured = await ensureGovernanceDiagnosticianTask({
      workspaceDir,
      logicalObservationKey: 'codex|rollout-1|turn-1|user',
      canonicalPainId: painId,
    });
    expect(ensured).toMatchObject({ ok: true, created: true });

    const run = await runPendingDiagnosticianOnce({ workspaceDir, serviceStarted: true, now: NOW.toISOString() });
    // The diagnosis itself still ran; only the intent anchoring degraded.
    expect(run.served).toBe(true);
    expect(await readStageSnapshot(ensured.ok ? ensured.taskId : '')).toBeUndefined();
  }, 180_000);
});
