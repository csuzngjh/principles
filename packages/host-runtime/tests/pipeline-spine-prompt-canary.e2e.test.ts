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
 *     consent is GRANTED (D1). After the Owner revokes the consent the SAME
 *     CACHED bridge refuses immediately: no unauthorized read, NO model
 *     call, `source_authorization_revoked` / `consent_revoked`; the context
 *     Stage A would assemble carries the `consent_revoked` ambiguity note
 *     and withholds the turn text.
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
  SqliteConnection,
  SqliteContextAssembler,
  SqliteHistoryQuery,
  evaluatePainIngress,
  getDefaultPdConfig,
  disposePainSignalBridgesForWorkspace,
  PainToPrincipleService,
  PrincipleTreeLedgerAdapter,
  type TrajectoryTurnReader,
  type SourceMaterialAuthorizationPort,
} from '@principles/core/runtime';
// the PRI-1283 R2 boundary itself (not on the barrel): the canary asserts the
// same function that blocked the model input in the revoked run
import { assertPayloadSourceAuthorization } from '../../principles-core/src/runtime/internalization/source-authorization-boundary.js';
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
const ROOT_SESSION_ID = 'root-session-1';
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

/** The ② entry: a principle_deviation report through the shared evaluator.
 * `painId` distinguishes submissions of the SAME diagnosis (same bound root
 * session, same target turn) — a succeeded task is idempotently skipped, so
 * "re-run the same diagnosis" is a second submission of identical material. */
function canaryRecordPainInput(painId: string): Parameters<PainToPrincipleService['recordPain']>[0] {
  const decision = evaluatePainIngress({
    identity: { kind: 'manual_pain_id', painId },
    painType: 'principle_deviation',
    source: 'manual',
    reason: CANARY_REASON,
    score: 90,
    origin: { kind: 'owner_manual', channel: 'cli_explicit_session' },
    // `rootSessionId` is the bound root session: it becomes the persisted
    // `sessionIdHint`, which is what lets the context assembler read this
    // session's authorized turns (without it no turn text can reach Stage A).
    correlation: { status: 'bound', hostKind: 'codex', rootSessionId: ROOT_SESSION_ID, rolloutIdentity: 'rollout-1', logicalObservationKey: 'codex|rollout-1|turn-1|user' },
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

/** A turn reader that forwards to the REAL governance reader and records how
 * much turn text it handed out — the canary's probe for "no unauthorized
 * read": after a revocation it must deliver nothing. */
interface CountingReader {
  reader: TrajectoryTurnReader;
  /** number of session reads that returned at least one turn */
  readsWithText: () => number;
}

function makeCountingReader(sourceMaterialAuthorization: SourceMaterialAuthorizationPort): CountingReader {
  const real = createGovernanceTrajectoryTurnReader({ workspaceDir, sourceMaterialAuthorization });
  let withText = 0;
  const count = (result: readonly unknown[]): readonly unknown[] => {
    if (result.length > 0) withText += 1;
    return result;
  };
  return {
    reader: {
      listUserTurnsForSession: (sessionId: string) => count(real.listUserTurnsForSession(sessionId)),
      listAssistantTurns: (sessionId: string) => count(real.listAssistantTurns(sessionId)),
      ...(real.listTurnTextsForHostTurnId !== undefined
        ? {
            listTurnTextsForHostTurnId: (
              sessionId: string,
              hostTurnId: string,
              hostKind?: 'openclaw' | 'codex' | 'workbuddy',
            ) => {
              const result = real.listTurnTextsForHostTurnId(sessionId, hostTurnId, hostKind);
              if (result.userTurns.length + result.assistantTurns.length > 0) withText += 1;
              return result;
            },
          }
        : {}),
    },
    readsWithText: () => withText,
  };
}

interface ServiceHarness {
  service: PainToPrincipleService;
  turnReader: CountingReader;
}

function makeService(): ServiceHarness {
  const sourceMaterialAuthorization = createConsentLedgerSourceMaterialAuthorization(workspaceDir);
  const turnReader = makeCountingReader(sourceMaterialAuthorization);
  const configResult = loadPdConfigForPlugin(workspaceDir);
  // `PluginConfigLoadResult` carries `effective` on every path (a failed load
  // yields the default config there) — there is no `defaults` member.
  const effectiveConfig = configResult.effective;
  const service = new PainToPrincipleService({
    workspaceDir,
    stateDir: path.join(workspaceDir, '.state'),
    ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir: path.join(workspaceDir, '.state') }),
    owner: 'canary-e2e',
    autoIntakeEnabled: true,
    asyncMode: false,
    effectiveConfig,
    intentDocReader: createHostIntentDocReader({ workspaceDir, effectiveConfig }),
    trajectoryTurnReader: turnReader.reader,
    sourceMaterialAuthorization,
  });
  return { service, turnReader };
}

async function readDiagnosticianTask(painId: string): Promise<{ diagnosticJson: string | null; taskId: string }> {
  const sm = new RuntimeStateManager({ workspaceDir });
  try {
    await sm.initialize();
    const tasks = await sm.listTasks();
    const parent = tasks.find((t) => t.taskKind === 'diagnostician' && t.inputRef === painId)
      ?? tasks.find((t) => t.taskKind === 'diagnostician' && t.taskId.includes(painId));
    return { diagnosticJson: parent?.diagnosticJson ?? null, taskId: parent?.taskId ?? '' };
  } finally {
    await sm.close().catch(() => undefined);
  }
}

interface RecordedStageA {
  /** the raw request body sent to the model (the user message content) */
  body: string;
  /** the parsed prompt input (RootCausePromptBuilder output) */
  prompt: Record<string, unknown>;
}

/** Every Stage A (root-cause) model request of the run, in order. */
function stageARequests(): RecordedStageA[] {
  return startRunInputs
    .map((recorded) => JSON.parse(recorded) as { outputSchemaRef?: string; inputPayload?: string })
    .filter((input) => input.outputSchemaRef === 'diag-rootcause-output')
    .map((input) => ({ body: String(input.inputPayload ?? ''), prompt: JSON.parse(String(input.inputPayload)) as Record<string, unknown> }));
}

/** All text the conversation window of one Stage A request carries. */
function conversationTexts(prompt: Record<string, unknown>): string[] {
  const collect = (window: unknown): string[] => (Array.isArray(window) ? window : [])
    .map((entry) => (entry as { text?: unknown } | null)?.text)
    .filter((text): text is string => typeof text === 'string');
  return [...collect(prompt.conversationWindow), ...collect((prompt.context as { conversationWindow?: unknown } | undefined)?.conversationWindow)];
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

afterEach(async () => {
  vi.restoreAllMocks();
  // recordPain caches a bridge with live SQLite handles. Dispose it before
  // removing the workspace so Windows never has to delete an open database.
  await disposePainSignalBridgesForWorkspace(workspaceDir);
  try {
    fs.rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // Windows handle latency; the vitest temp keeper sweeps leftovers.
  }
});

describe('pipeline spine prompt canary (Layer A)', () => {
  it('carries every probe — including the AUTHORIZED session turn text — through the REAL sync pipeline into the Stage A request body', async () => {
    const { service, turnReader } = makeService();
    const result = await service.recordPain(canaryRecordPainInput('canary_pain_001'));

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
    // CANARY_TURN_TEXT: the authorized codex governance turn of the bound
    // root session is READ through the sync entry's trajectory reader and
    // arrives verbatim in the Stage A request body's conversation window
    // (pre-D1 the sync entry wired no reader at all)
    const stageA = stageARequests();
    expect(stageA.length).toBeGreaterThan(0);
    expect(stageA.flatMap((request) => conversationTexts(request.prompt))).toContain(CANARY_TURN_TEXT);
    expect(turnReader.readsWithText()).toBeGreaterThan(0);

    // the persisted diagnosticJson carries the canonical anchor (single track)
    // and the source association of the turn that was read
    const parent = await readDiagnosticianTask('canary_pain_001');
    expect(parent.diagnosticJson).toBeTruthy();
    const parsed = JSON.parse(parent.diagnosticJson as string) as Record<string, unknown>;
    const anchor = parsed.anchor as { type?: string; ref?: string } | undefined;
    expect(anchor?.ref).toBe(CANARY_ANCHOR_REF);
    expect(anchor?.type).toBe('established_principle');
    expect(parsed.sessionIdHint).toBe(ROOT_SESSION_ID);
    expect(parsed.hostKind).toBe('codex');
    expect((parsed.evidence as Array<{ sourceRef?: string }> | undefined)?.[0]?.sourceRef).toBe(TRUSTED);

    // the chain produced candidates from the scripted (schema-valid) output
    expect((result.candidateIds ?? []).length).toBeGreaterThanOrEqual(1);
  }, 180_000);

  it('CANARY_TURN_TEXT revocation: on the SAME (cached) bridge the revocation is immediate — the turn text reaches no request body and the reason is structured', async () => {
    const { service, turnReader } = makeService();
    // GRANTED: the turn text reaches Stage A and the bridge is cached with
    // exactly this service's collaborator objects
    const granted = await service.recordPain(canaryRecordPainInput('canary_pain_001'));
    expect(granted.status).toBe('succeeded');
    expect(stageARequests().flatMap((request) => conversationTexts(request.prompt))).toContain(CANARY_TURN_TEXT);
    const readsWhileGranted = turnReader.readsWithText();
    expect(readsWhileGranted).toBeGreaterThan(0);
    const initializeSpy = vi.spyOn(RuntimeStateManager.prototype, 'initialize');

    // the Owner revokes the codex consent
    recordConversationIngestionConsent(workspaceDir, 'codex', {
      decision: 'revoked',
      decidedVia: 'pd_codex_setup',
      decidedAt: new Date().toISOString(),
      disclosureVersion: CODEX_INGESTION_DISCLOSURE_VERSION,
    });
    startRunInputs = [];

    // the same diagnosis re-executes through the same service instance →
    // the same collaborator objects → the CACHED bridge
    const revoked = await service.recordPain(canaryRecordPainInput('canary_pain_002'));

    // scenario B (P1-1): the cached bridge was reused — no new construction
    expect(initializeSpy).not.toHaveBeenCalled();
    // no unauthorized read: the reader delivered no turn text after the revocation
    expect(turnReader.readsWithText()).toBe(readsWhileGranted);
    // NO model call at all: the PRI-1283 R2 boundary blocks the model input
    // of the governed host before the request exists
    expect(startRunInputs).toHaveLength(0);
    expect(revoked.status).toBe('failed');
    const message = String((revoked as { message?: string }).message ?? '');
    expect(message).toContain('source_authorization_revoked');
    expect(message).toContain('consent_revoked');

    // What Stage A would have assembled for the re-executed diagnosis — the
    // production context assembler over the persisted task, with the
    // revoked authorization: the `consent_revoked` note is in
    // ambiguityNotes, the turn text is withheld, and the boundary refuses
    // the payload. (No request body exists to carry the note: the run was
    // blocked before any model call.)
    const connection = new SqliteConnection(workspaceDir);
    const sm = new RuntimeStateManager({ workspaceDir });
    await sm.initialize();
    try {
      const authorization = createConsentLedgerSourceMaterialAuthorization(workspaceDir);
      const reader = createGovernanceTrajectoryTurnReader({ workspaceDir, sourceMaterialAuthorization: authorization });
      const assembler = new SqliteContextAssembler(
        sm.taskStore,
        new SqliteHistoryQuery(connection),
        sm.runStore,
        { trajectoryTurnReader: reader, sourceMaterialAuthorization: authorization },
      );
      const context = await assembler.assemble('diagnosis_canary_pain_002');
      expect(JSON.stringify(context)).not.toContain(CANARY_TURN_TEXT);
      expect((context.ambiguityNotes ?? []).join('\n')).toContain('consent_revoked');
      expect(() => assertPayloadSourceAuthorization(context, authorization, 'diag_rootcause-diagnosis_canary_pain_002'))
        .toThrow(/source_authorization_revoked[\s\S]*consent_revoked/);
    } finally {
      await sm.close().catch(() => undefined);
      connection.close();
    }
  }, 180_000);
});
