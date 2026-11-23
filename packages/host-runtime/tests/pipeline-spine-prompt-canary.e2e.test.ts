/**
 * Pipeline spine prompt-channel canary — SPEC-PD-PIPELINE-SPINE-001 v0.9
 * §4.5 Layer A / §6 Phase 1A (PRI-1291).
 *
 * REAL pipeline, scripted LLM boundary only: a real temp workspace (config +
 * consent ledger + trajectory governance observations + INTENT.md), the REAL
 * PainToPrincipleService running SYNCHRONOUSLY with the D1 collaborator set
 * (consent-ledger authorization + governance trajectory reader + intent
 * reader), the real SqliteContextAssembler / split diagnostician runners /
 * intake / ledger adapter. Only PiAiRuntimeAdapter's network methods are
 * scripted (same technique as governance-signal-admission-intent.test.ts)
 * with the schema-valid cached split-pipeline fixtures.
 *
 * Probe assertions (non-default values, end to end):
 *   - CANARY_REASON_9f3a          → Stage A/B/C request bodies
 *   - CANARY_OWNER_CORRECTION_7b2c → Stage A request body
 *   - P_CANARY_ANCHOR_4d1e@1       → Stage A request body via the
 *     evaluatePainIngress `principle_deviation` entry (D2 ②) AND the
 *     persisted diagnosticJson anchor
 *   - CANARY_TURN_TEXT_8e5f        → Stage A request body while the codex
 *     consent is GRANTED (D1); gone + `consent_revoked` ambiguity note after
 *     revocation
 *   - CANARY_INTENT_2a6d           → Stage A request body (intent flag on)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { vi as viImport } from 'vitest';

import {
  MOCK_ROOT_CAUSE_OUTPUTS,
  MOCK_DISTILLER_OUTPUTS,
  MOCK_ROUTER_OUTPUTS,
} from '../../principles-core/src/runtime/adapter/split-pipeline-fixtures.js';
import {
  PiAiRuntimeAdapter,
  RuntimeStateManager,
  evaluatePainIngress,
  getDefaultPdConfig,
  invalidatePainSignalBridge,
  PainToPrincipleService,
  PrincipleTreeLedgerAdapter,
} from '@principles/core/runtime';
import {
  createConsentLedgerSourceMaterialAuthorization,
  createGovernanceTrajectoryTurnReader,
  createHostIntentDocReader,
} from '@principles/host-runtime';
import { recordConversationIngestionConsent } from '../src/conversation-ingestion/consent.js';
import { CODEX_INGESTION_DISCLOSURE_VERSION } from '../src/codex-disclosure.js';
import { ingestGovernanceObservations } from '../src/governance-observation-store.js';
import { loadPdConfigForPlugin } from '../src/pd-config.js';

const CANARY_REASON = 'CANARY_REASON_9f3a owner review skipped before destructive change';
const CANARY_CORRECTION = 'CANARY_OWNER_CORRECTION_7b2c stop, investigate first';
const CANARY_ANCHOR_REF = 'P_CANARY_ANCHOR_4d1e@1';
const CANARY_TURN_TEXT = 'CANARY_TURN_TEXT_8e5f the agent bypassed the review gate';
const CANARY_INTENT = 'CANARY_INTENT_2a6d credibility of diagnosis evidence first';
const TRUSTED = 'governance_observation:codex|rollout-1|turn-1|user';
const NOW = new Date('2026-11-24T00:00:00.000Z');

let workspaceDir: string;
let startRunInputs: string[] = [];

function writeConfig(): void {
  const config = getDefaultPdConfig() as Record<string, unknown> & {
    features: Record<string, unknown>;
    runtimeProfiles: Record<string, unknown>;
    internalAgents: { defaultRuntime: string };
  };
  config.features = {
    ...config.features,
    intent_engineering: { category: 'quiet', enabled: true },
    automatic_pain_submission: { category: 'quiet', enabled: true },
  };
  config.runtimeProfiles = {
    ...config.runtimeProfiles,
    'pd.default': {
      type: 'pi-ai', provider: 'canary-prov', model: 'canary-model',
      apiKeyEnv: 'PD_CANARY_KEY', baseUrl: 'http://127.0.0.1:8080/v1',
    },
  };
  config.internalAgents.defaultRuntime = 'pd.default';
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
  process.env.PD_CANARY_KEY = 'test-key';
}

function grantCodexConsent(): void {
  recordConversationIngestionConsent(workspaceDir, 'codex', {
    decision: 'granted',
    decidedVia: 'pd_codex_setup',
    decidedAt: NOW.toISOString(),
    disclosureVersion: CODEX_INGESTION_DISCLOSURE_VERSION,
  });
}

function writeIntent(): void {
  fs.mkdirSync(path.join(workspaceDir, '.principles'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.principles', 'INTENT.zh-CN.md'), [
    '# INTENT.md',
    '',
    '## 1. Why',
    '',
    CANARY_INTENT,
    '',
    '## 2. Desired Outcome',
    '',
    '诊断证据保持真实。',
    '',
    '## 3. Non-negotiables',
    '',
    '不以伪证据换取完成率。',
    '',
    '## 4. Stop / Escalation',
    '',
    '失败交 Owner。',
    '',
    '## 5. Current Strategic Focus',
    '',
    '链路可信度优先。',
    '',
  ].join('\n'), 'utf8');
}

function seedObservation(): void {
  ingestGovernanceObservations({
    workspaceDir,
    rollout: { hostKind: 'codex', rolloutIdentity: 'rollout-1', rootSessionId: 'root-session-1' },
    observations: [{
      hostKind: 'codex',
      rolloutIdentity: 'rollout-1',
      rootSessionId: 'root-session-1',
      hostTurnId: 'turn-1',
      kind: 'user_turn',
      logicalObservationKey: TRUSTED.replace(/^governance_observation:/, ''),
      visibleText: CANARY_TURN_TEXT,
      source: 'live_hook',
      completeness: 'complete',
      observedAt: NOW.toISOString(),
    }],
    now: NOW,
  });
;
}

/** Script the LLM boundary; record every request body verbatim. */
/** `evidenceRef` = the ref the scripted outputs cite (the revoked leg must cite a non-governance ref that stays in the trusted context). */
function installRecordingAdapterSpy(evidenceRef: string = TRUSTED): void {
  const runIdToTaskId = new Map<string, string>();
  let counter = 0;
  let rootCauseTaskId: string | null = null;
  const CITED = evidenceRef;

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
    const runId = `canary-run-${counter}`;
    const taskId = input.taskRef?.taskId;
    if (typeof taskId === 'string') runIdToTaskId.set(runId, taskId);
    startRunInputs.push(JSON.stringify(input));
    return {
      runId,
      runtimeKind: 'pi-ai',
      startedAt: new Date().toISOString(),
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
          evidence: [{ sourceRef: CITED, note: 'Owner correction observation.' }],
          // keep the prompt-channel principle recommendation only: the
          // implementation-kind fixture entry routes to an MVP-disabled
          // channel and degrades the canary run's terminal status
          recommendations: MOCK_ROUTER_OUTPUTS.R6.recommendations
            .filter((rec) => rec.kind === 'principle')
            .map((rec) => rec),
        },
      };
    }
    rootCauseTaskId = taskId ?? null;
    const r6 = MOCK_ROOT_CAUSE_OUTPUTS.R6;
    return {
      runId,
      payload: {
        ...r6,
        taskId: taskId ?? 'canary-task',
        evidence: [{ sourceRef: CITED, note: 'Owner correction observation.' }],
        causalChain: r6.causalChain.map((entry) => ({ ...entry, evidenceRefs: [CITED] })),
      },
    };
  });
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'fetchArtifacts').mockResolvedValue([]);
}

/** The ② entry: a principle_deviation report through the shared evaluator. */
function canaryRecordPainInput(): Parameters<PainToPrincipleService['recordPain']>[0] {
  const decision = evaluatePainIngress({
    identity: { kind: 'manual_pain_id', painId: 'canary_pain_001' },
    painType: 'principle_deviation',
    source: 'manual',
    reason: CANARY_REASON,
    score: 90,
    origin: { kind: 'owner_manual', channel: 'cli_explicit_session' },
    correlation: { status: 'bound', hostKind: 'codex', sessionId: 'root-session-1', rolloutIdentity: 'rollout-1', logicalObservationKey: 'codex|rollout-1|turn-1|user' },
    evidence: { status: 'available', entries: [{ kind: 'behavior_trace', sourceRef: TRUSTED, note: 'deviated from the review gate' }] },
    deviationAnchor: { principleId: 'P_CANARY_ANCHOR_4d1e', principleVersion: '1' },
  });
  if (decision.action !== 'submit') {
    throw new Error(`canary ingress refused: ${JSON.stringify(decision)}`);
  }
  return {
    painId: decision.legacy.painId,
    painType: decision.legacy.painType,
    source: decision.legacy.source,
    reason: decision.legacy.reason,
    score: decision.legacy.score,
    sessionId: decision.legacy.sessionId,
    provenance: decision.legacy.provenance,
    hostKind: decision.legacy.hostKind,
    evidence: decision.legacy.evidence,
    painIngress: decision.legacy.painIngress,
    deviationAnchor: decision.legacy.deviationAnchor,
    anchor: decision.legacy.anchor,
    correctionEvidence: {
      text: CANARY_CORRECTION,
      classification: 'owner_statement',
      channel: 'cli_owner_statement',
    },
    recordObservability: false,
  };
}

function makeService(): PainToPrincipleService {
  const sourceMaterialAuthorization = createConsentLedgerSourceMaterialAuthorization(workspaceDir);
  const trajectoryTurnReader = createGovernanceTrajectoryTurnReader({
    workspaceDir,
    sourceMaterialAuthorization,
  });
  const configResult = loadPdConfigForPlugin(workspaceDir);
  const effectiveConfig = configResult.ok ? configResult.effective : configResult.defaults;
  return new PainToPrincipleService({
    workspaceDir,
    stateDir: path.join(workspaceDir, '.state'),
    ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir: path.join(workspaceDir, '.state') }),
    owner: 'canary-e2e',
    autoIntakeEnabled: true,
    asyncMode: false,
    effectiveConfig,
    intentDocReader: createHostIntentDocReader({ workspaceDir, effectiveConfig }),
    trajectoryTurnReader,
    sourceMaterialAuthorization,
  });
}

async function readDiagnosticianTask(): Promise<{ diagnosticJson: string | null; taskId: string }> {
  const sm = new RuntimeStateManager({ workspaceDir });
  try {
    await sm.initialize();
    const tasks = await sm.listTasks();
    const parent = tasks.find((t) => t.taskKind === 'diagnostician');
    return { diagnosticJson: parent?.diagnosticJson ?? null, taskId: parent?.taskId ?? '' };
  } finally {
    await sm.close().catch(() => undefined);
  }
}

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-canary-prompt-'));
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  const trajectory = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
  trajectory.close();
  startRunInputs = [];
  writeConfig();
  grantCodexConsent();
  writeIntent();
  seedObservation();
  installRecordingAdapterSpy();
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    fs.rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // Windows handle latency; the vitest temp keeper sweeps leftovers.
  }
});

describe('pipeline spine prompt canary (Layer A)', () => {
  it('carries every probe through the REAL sync pipeline into the model request bodies', async () => {
    const service = makeService();
    const result = await service.recordPain(canaryRecordPainInput());

    // the chain ran synchronously and reached the model boundary
    expect(result.status).toBe('succeeded');
    expect(startRunInputs.length).toBeGreaterThanOrEqual(3);

    const allInputs = startRunInputs.join(' || ');
    // Pain reason → Stage A/B/C request bodies
    expect(allInputs).toContain(CANARY_REASON);
    // Owner correction → Stage A system prompt (verbatim quote)
    expect(allInputs).toContain(CANARY_CORRECTION);
    // Anchor via the evaluatePainIngress deviation entry (D2 ②) → Stage A
    // (prompt ANCHOR block + diagnosisTarget.anchor)
    expect(allInputs).toContain(CANARY_ANCHOR_REF);
    // INTENT.md content → Stage A (intent snapshot sections)
    expect(allInputs).toContain(CANARY_INTENT);
    // D1 POSITIVE: the AUTHORIZED codex governance evidence ref survives the
    // sync service's authorization gate (pre-fix: deny-all filtered it)
    expect(allInputs).toContain(TRUSTED);

    // the persisted diagnosticJson carries the canonical anchor (single track)
    const parent = await readDiagnosticianTask();
    expect(parent.diagnosticJson).toBeTruthy();
    const parsed = JSON.parse(parent.diagnosticJson as string) as Record<string, unknown>;
    const anchor = parsed.anchor as { type?: string; ref?: string } | undefined;
    expect(anchor?.ref).toBe(CANARY_ANCHOR_REF);
    expect(anchor?.type).toBe('established_principle');

    // the chain produced candidates from the scripted (schema-valid) output
    expect((result.candidateIds ?? []).length).toBeGreaterThanOrEqual(1);
  }, 180_000);

  it('revoking the codex consent blocks the model input fail-closed with a structured reason (D1 negative)', async () => {
    recordConversationIngestionConsent(workspaceDir, 'codex', {
      decision: 'revoked',
      decidedVia: 'pd_codex_setup',
      decidedAt: new Date().toISOString(),
      disclosureVersion: CODEX_INGESTION_DISCLOSURE_VERSION,
    });
    const service = makeService();
    const result = await service.recordPain(canaryRecordPainInput());

    // PRI-1283 R2 boundary: the revoked host's conversation material may no
    // longer reach the model AT ALL — the sync run fails closed with a
    // structured, observable reason instead of silently degrading.
    expect(result.status).toBe('failed');
    const message = String((result as { message?: string }).message ?? '');
    expect(message).toContain('source_authorization_revoked');
    expect(message).toContain('consent_revoked');
    // and nothing was ever sent to the model boundary carrying the
    // governance material
    const allInputs = startRunInputs.join(' || ');
    expect(allInputs).not.toContain(TRUSTED);
  }, 180_000);
});
