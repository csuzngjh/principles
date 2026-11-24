/**
 * CANARY_TURN_TEXT through the REAL MCP host entry — SPEC-PD-PIPELINE-SPINE-001
 * v0.9 §4.5 Layer A / review round 2 (PRI-1291).
 *
 * Entry under test: the `pd_submit_pain` MCP tool (in-memory MCP client → the
 * real tool handler → the real submit capability → the real SQLite task), and
 * then the PRODUCTION executor the Codex workspace worker uses for the
 * persisted task — `createPainSignalBridge(...).executePendingDiagnosis` —
 * with the collaborators that worker wires (governance trajectory reader,
 * consent-ledger authorization, host intent reader). Only
 * PiAiRuntimeAdapter's network methods are scripted.
 *
 *   positive            — trusted `_meta` + a legitimate `targetTurnId`: the
 *                         EXACT target turn of the authorized governance
 *                         session reaches the Stage A request body; the
 *                         persisted diagnosticJson records the source
 *                         association.
 *   negative            — the Owner revokes the consent; the same diagnosis is
 *                         submitted and executed again: the turn text reaches
 *                         no request body and the refusal is structured.
 *   no verified session — a submission without the trusted `_meta` is the
 *                         legal unbound save (`codex_host_metadata_missing`):
 *                         the reader is never consulted and no turn text can
 *                         reach Stage A.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createHash } from 'node:crypto';
import {
  createPdMcpServer,
  SUBMIT_TOOL_NAME,
  type SubmitRecheckCall,
} from '../server.js';
import { assembleSubmitCapability } from '../submit-assembly.js';
import {
  PiAiRuntimeAdapter,
  PrincipleTreeLedgerAdapter,
  RuntimeStateManager,
  SqliteConnection,
  SqliteContextAssembler,
  SqliteHistoryQuery,
  computeEffectivePdConfig,
  createPainSignalBridge,
  disposePainSignalBridgesForWorkspace,
  getDefaultPdConfig,
} from '@principles/core/runtime';
import {
  createConsentLedgerSourceMaterialAuthorization,
  createGovernanceTrajectoryTurnReader,
  createHostIntentDocReader,
  ingestGovernanceObservations,
  recordConversationIngestionConsent,
} from '@principles/host-runtime';
/**
 * The schema-valid cached split-pipeline fixtures live in core's SOURCE tree
 * (they are not on the barrel). This package's tsconfig type-checks its
 * tests under its own `rootDir`, so a static relative import across the
 * package boundary is a type error here: load the module through vitest's
 * runtime resolver with a computed specifier instead, and pin the shape this
 * canary actually uses.
 */
interface SplitPipelineFixtures {
  MOCK_ROOT_CAUSE_OUTPUTS: { R6: { causalChain: ({ evidenceRefs?: string[] } & Record<string, unknown>)[] } & Record<string, unknown> };
  MOCK_DISTILLER_OUTPUTS: { R6: Record<string, unknown> };
  MOCK_ROUTER_OUTPUTS: { R6: { recommendations: ({ kind: string } & Record<string, unknown>)[] } & Record<string, unknown> };
}
const FIXTURES: SplitPipelineFixtures = await vi.importActual<SplitPipelineFixtures>(
  ['..', '..', '..', 'principles-core', 'src', 'runtime', 'adapter', 'split-pipeline-fixtures.js'].join('/'),
);

const CANARY_TURN_TEXT = 'CANARY_TURN_TEXT_8e5f the agent bypassed the review gate';
const SIBLING_TURN_TEXT = 'CANARY_SIBLING_TURN_TEXT_3c9d an unrelated later turn';
const CANARY_REASON = 'CANARY_REASON_9f3a owner review skipped before destructive change';
const SESSION = 'thread-canary';
const TARGET_TURN = 'turn-target';
const TARGET_REF = `governance_observation:codex|${SESSION}|${TARGET_TURN}|user`;
const ENV_KEY = 'PD_TURN_TEXT_CANARY_KEY';
/** The ref the scripted model outputs cite. The pipeline's validators bind
 * every cited evidence ref to the TRUSTED diagnosis context
 * (`evidence_ref_unbound`): the only ref a faithful model could cite here is
 * the authorized governance observation the MCP entry persisted. */
const CITED = TARGET_REF;

const workspaces: string[] = [];
let startRunInputs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env[ENV_KEY];
  for (const workspaceDir of workspaces.splice(0)) {
    await disposePainSignalBridgesForWorkspace(workspaceDir).catch(() => undefined);
    await rm(workspaceDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined);
  }
});

async function makeWorkspace(): Promise<string> {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'pd-turn-text-canary-'));
  workspaces.push(workspaceDir);
  const config = getDefaultPdConfig() as ReturnType<typeof getDefaultPdConfig> & {
    runtimeProfiles: Record<string, unknown>;
    internalAgents: { defaultRuntime: string };
  };
  // the Workspace-level authorization for the trusted identity-metadata path
  const minimalMetadata = config.features.host_identity_minimal_metadata;
  if (minimalMetadata === undefined) throw new Error('host_identity_minimal_metadata flag missing from the default config');
  minimalMetadata.enabled = true;
  config.runtimeProfiles = {
    ...config.runtimeProfiles,
    'pd.default': { type: 'pi-ai', provider: 'canary-prov', model: 'canary-model', apiKeyEnv: ENV_KEY, baseUrl: 'http://127.0.0.1:8080/v1' },
  };
  config.internalAgents.defaultRuntime = 'pd.default';
  await mkdir(join(workspaceDir, '.pd'), { recursive: true });
  await mkdir(join(workspaceDir, '.state'), { recursive: true });
  await writeFile(join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
  // the governance store requires the trajectory database to exist
  await writeFile(join(workspaceDir, '.state', 'trajectory.db'), '');
  process.env[ENV_KEY] = 'test-key';
  return workspaceDir;
}

function recordConsent(workspaceDir: string, decision: 'granted' | 'revoked'): void {
  const recorded = recordConversationIngestionConsent(workspaceDir, 'codex', {
    decision,
    decidedVia: 'pd_codex_setup',
    decidedAt: new Date().toISOString(),
    disclosureVersion: 'g2b-2026-11-12',
  });
  if (!recorded.ok) throw new Error(recorded.reason);
}

function seedGovernanceTurns(workspaceDir: string): void {
  const ingested = ingestGovernanceObservations({
    workspaceDir,
    rollout: { hostKind: 'codex', rolloutIdentity: SESSION, rootSessionId: SESSION },
    observations: [
      { hostTurnId: TARGET_TURN, visibleText: CANARY_TURN_TEXT },
      { hostTurnId: 'turn-sibling', visibleText: SIBLING_TURN_TEXT },
    ].map((turn) => ({
      hostKind: 'codex' as const,
      rolloutIdentity: SESSION,
      rootSessionId: SESSION,
      hostTurnId: turn.hostTurnId,
      kind: 'user_turn' as const,
      logicalObservationKey: `codex|${SESSION}|${turn.hostTurnId}|user`,
      visibleText: turn.visibleText,
      source: 'live_hook' as const,
      completeness: 'complete' as const,
      observedAt: new Date().toISOString(),
    })),
  });
  if (!ingested.ok) throw new Error(ingested.reason);
}

/** Script the LLM boundary; record every request body verbatim. */
function installRecordingAdapterSpy(): void {
  const runIdToTaskId = new Map<string, string>();
  let counter = 0;
  let rootCauseTaskId: string | null = null;
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'getCapabilities').mockResolvedValue({
    supportsStructuredJsonOutput: true, supportsToolUse: false, supportsWorkingDirectory: false,
    supportsModelSelection: false, supportsLongRunningSessions: false, supportsCancellation: true,
    supportsArtifactWriteBack: false, supportsConcurrentRuns: false, supportsStreaming: false,
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
      runId, runtimeKind: 'pi-ai', startedAt: new Date().toISOString(),
      systemPromptDigest: createHash('sha256').update(input.systemPrompt ?? '', 'utf8').digest('hex'),
    };
  });
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'pollRun').mockImplementation(async (runId: string) => ({
    runId, status: 'succeeded' as const, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
  }));
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'fetchOutput').mockImplementation(async (runId: string) => {
    const taskId = runIdToTaskId.get(runId);
    if (taskId !== undefined && taskId.includes('diag_distiller')) {
      const sourceRootCauseArtifactId = `pi-art-${rootCauseTaskId ?? ''}-run_${rootCauseTaskId ?? ''}_1`;
      return { runId, payload: { ...FIXTURES.MOCK_DISTILLER_OUTPUTS.R6, taskId, sourceRootCauseArtifactId } };
    }
    if (taskId !== undefined && taskId.includes('diag_router')) {
      return {
        runId,
        payload: {
          ...FIXTURES.MOCK_ROUTER_OUTPUTS.R6,
          evidence: [{ sourceRef: CITED, note: 'Canary observation.' }],
          recommendations: FIXTURES.MOCK_ROUTER_OUTPUTS.R6.recommendations.filter((rec) => rec.kind === 'principle'),
        },
      };
    }
    rootCauseTaskId = taskId ?? null;
    const r6 = FIXTURES.MOCK_ROOT_CAUSE_OUTPUTS.R6;
    return {
      runId,
      payload: {
        ...r6,
        taskId: taskId ?? 'canary-task',
        evidence: [{ sourceRef: CITED, note: 'Canary observation.' }],
        causalChain: r6.causalChain.map((entry) => ({ ...entry, evidenceRefs: [CITED] })),
      },
    };
  });
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'fetchArtifacts').mockResolvedValue([]);
}

/** The REAL MCP entry: in-memory client → `pd_submit_pain` → real capability. */
async function submitThroughMcp(workspaceDir: string, options: { trustedMeta: boolean }): Promise<{
  taskId: string;
  sessionAssociation: unknown;
  warnings: unknown;
}> {
  const assembly = assembleSubmitCapability(workspaceDir, 'codex', {});
  if (!assembly.ok || assembly.call === undefined) throw new Error('submit capability unavailable');
  const recheck: SubmitRecheckCall = async () => 'not_found';
  const handle = createPdMcpServer({
    workspaceDir,
    enableSubmitTool: true,
    deadlineMs: 10_000,
    callSubmitCapability: assembly.call,
    recheckSubmitTask: recheck,
    logSink: () => undefined,
  });
  const client = new Client({ name: 'turn-text-canary-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), handle.mcpServer.connect(serverTransport)]);
  try {
    const result = await client.callTool({
      name: SUBMIT_TOOL_NAME,
      arguments: {
        reason: CANARY_REASON,
        anchorType: 'owner_expectation',
        anchorRef: 'Owner request in the preceding turn',
        painType: 'user_frustration',
        targetTurnId: TARGET_TURN,
      },
      ...(options.trustedMeta ? { _meta: { threadId: SESSION, 'x-codex-turn-metadata': { turn_id: 'turn-submit' } } } : {}),
    });
    const [block] = result.content;
    if (block === undefined || block.type !== 'text') throw new Error('expected a single text content block');
    const receipt = JSON.parse(block.text) as { status: string; taskId: string | null; sessionAssociation: unknown; warnings: unknown; error: unknown };
    if (receipt.status !== 'submitted' || receipt.taskId === null) {
      throw new Error(`submission not accepted: ${JSON.stringify(receipt.error)}`);
    }
    return { taskId: receipt.taskId, sessionAssociation: receipt.sessionAssociation, warnings: receipt.warnings };
  } finally {
    await client.close();
    await handle.mcpServer.close();
  }
}

interface StageAResult { body: string; prompt: Record<string, unknown> }

function stageARequests(): StageAResult[] {
  return startRunInputs
    .map((recorded) => JSON.parse(recorded) as { outputSchemaRef?: string; inputPayload?: string })
    .filter((input) => input.outputSchemaRef === 'diag-rootcause-output')
    .map((input) => {
      const body = String(input.inputPayload ?? '');
      return { body, prompt: JSON.parse(body) as Record<string, unknown> };
    });
}

function conversationTexts(prompt: Record<string, unknown>): string[] {
  const window: unknown = prompt.conversationWindow;
  if (!Array.isArray(window)) return [];
  return window.map((entry) => (entry as { text?: unknown } | null)?.text).filter((text): text is string => typeof text === 'string');
}

/** The production executor the Codex workspace worker uses for a persisted task. */
async function executeLikeCodexWorker(workspaceDir: string, taskId: string): Promise<{ status: string; detail: string }> {
  const stateDir = join(workspaceDir, '.state');
  const effectiveConfig = computeEffectivePdConfig(JSON.parse(await readFile(join(workspaceDir, '.pd', 'config.yaml'), 'utf8')));
  const sourceMaterialAuthorization = createConsentLedgerSourceMaterialAuthorization(workspaceDir);
  const bridge = await createPainSignalBridge({
    workspaceDir,
    stateDir,
    ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir }),
    effectiveConfig,
    getEnvVar: (name: string) => process.env[name],
    intentDocReader: createHostIntentDocReader({ workspaceDir, effectiveConfig }),
    trajectoryTurnReader: createGovernanceTrajectoryTurnReader({ workspaceDir, sourceMaterialAuthorization }),
    sourceMaterialAuthorization,
    isAutoPainSubmissionAuthorized: () => true,
  });
  const executed = await bridge.executePendingDiagnosis({ taskId });
  const record = executed as { status: string; message?: string; failureReason?: string; errorCategory?: string };
  return { status: record.status, detail: `${record.errorCategory ?? ''} ${record.message ?? record.failureReason ?? ''}` };
}

async function persistedDiagnosticJson(workspaceDir: string, taskId: string): Promise<Record<string, unknown>> {
  const state = new RuntimeStateManager({ workspaceDir });
  await state.initialize();
  try {
    const task = await state.getTask(taskId);
    return JSON.parse(task?.diagnosticJson ?? '{}') as Record<string, unknown>;
  } finally {
    await state.close();
  }
}

/** What the Stage A runner would assemble for a persisted task: the
 * PRODUCTION context assembler with the executor's collaborators. */
async function assembleLikeStageA(workspaceDir: string, taskId: string): Promise<string> {
  const connection = new SqliteConnection(workspaceDir);
  const state = new RuntimeStateManager({ workspaceDir });
  await state.initialize();
  try {
    const sourceMaterialAuthorization = createConsentLedgerSourceMaterialAuthorization(workspaceDir);
    const assembler = new SqliteContextAssembler(
      state.taskStore,
      new SqliteHistoryQuery(connection),
      state.runStore,
      {
        trajectoryTurnReader: createGovernanceTrajectoryTurnReader({ workspaceDir, sourceMaterialAuthorization }),
        sourceMaterialAuthorization,
      },
    );
    return JSON.stringify(await assembler.assemble(taskId));
  } finally {
    await state.close().catch(() => undefined);
    connection.close();
  }
}

describe('CANARY_TURN_TEXT through the real MCP entry (targetTurnId) and the production executor', () => {
  it('positive: the exact target turn of the authorized session reaches the Stage A request body', async () => {
    const workspaceDir = await makeWorkspace();
    recordConsent(workspaceDir, 'granted');
    seedGovernanceTurns(workspaceDir);
    installRecordingAdapterSpy();
    startRunInputs = [];

    const submitted = await submitThroughMcp(workspaceDir, { trustedMeta: true });
    // the MCP entry verified the host session and bound the target turn
    expect(submitted.sessionAssociation).toEqual({
      status: 'verified', sessionId: SESSION, submissionTurnId: 'turn-submit', targetTurnId: TARGET_TURN,
    });
    const persisted = await persistedDiagnosticJson(workspaceDir, submitted.taskId);
    // diagnosticJson 保存正确的来源关联
    expect(persisted.sessionIdHint).toBe(SESSION);
    expect(persisted.hostKind).toBe('codex');
    expect((persisted.evidence as { sourceRef?: string; note?: string }[]).map((entry) => entry.sourceRef)).toEqual([TARGET_REF]);

    const executed = await executeLikeCodexWorker(workspaceDir, submitted.taskId);

    expect(executed.status, executed.detail).toBe('succeeded');
    const stageA = stageARequests();
    expect(stageA.length).toBeGreaterThan(0);
    // the turn text is IN the conversation window of the Stage A request body
    expect(stageA.flatMap((request) => conversationTexts(request.prompt))).toContain(CANARY_TURN_TEXT);
    // exact-turn scoping: the sibling turn of the same session is not read
    expect(startRunInputs.join('\n')).not.toContain(SIBLING_TURN_TEXT);
  }, 180_000);

  it('negative: after the Owner revokes the consent the same diagnosis reaches no request body with the turn text', async () => {
    const workspaceDir = await makeWorkspace();
    recordConsent(workspaceDir, 'granted');
    seedGovernanceTurns(workspaceDir);
    installRecordingAdapterSpy();
    startRunInputs = [];
    const granted = await submitThroughMcp(workspaceDir, { trustedMeta: true });
    expect((await executeLikeCodexWorker(workspaceDir, granted.taskId)).status).toBe('succeeded');
    expect(stageARequests().flatMap((request) => conversationTexts(request.prompt))).toContain(CANARY_TURN_TEXT);

    // the Owner revokes the consent
    recordConsent(workspaceDir, 'revoked');
    startRunInputs = [];
    const afterRevoke = await submitThroughMcp(workspaceDir, { trustedMeta: true });
    const executed = await executeLikeCodexWorker(workspaceDir, afterRevoke.taskId);

    // NO model call: the PRI-1283 R2 boundary blocks the model input of the
    // governed host before any request exists — so no request body can carry
    // the turn text or the revoked host's evidence ref
    expect(startRunInputs).toHaveLength(0);
    // the refusal is structured and names both the boundary and the cause
    expect(executed.status).toBe('failed');
    expect(executed.detail).toContain('source_authorization_revoked');
    expect(executed.detail).toContain('consent_revoked');
    expect(executed.detail).toContain('the model input is blocked');
  }, 180_000);

  it('no verified host session: the submission is saved unbound and no turn text can reach Stage A', async () => {
    const workspaceDir = await makeWorkspace();
    recordConsent(workspaceDir, 'granted');
    seedGovernanceTurns(workspaceDir);
    installRecordingAdapterSpy();
    startRunInputs = [];

    const submitted = await submitThroughMcp(workspaceDir, { trustedMeta: false });
    // the correct refusal of an unverified session: an explicit unbound save
    expect(submitted.sessionAssociation).toEqual({ status: 'unverified', detail: 'codex_host_metadata_missing' });
    expect(JSON.stringify(submitted.warnings)).toContain('host_session_unverified:codex_host_metadata_missing');
    const persisted = await persistedDiagnosticJson(workspaceDir, submitted.taskId);
    // no session hint and no evidence → the context assembler never consults
    // a turn reader for this task
    expect(persisted.sessionIdHint).toBeNull();
    expect(persisted.evidence).toEqual([]);

    // the context Stage A would assemble carries no turn text — although the
    // codex consent is GRANTED here: the text is withheld because the session
    // was never verified, not because consent is missing
    const assembled = await assembleLikeStageA(workspaceDir, submitted.taskId);
    expect(assembled).not.toContain(CANARY_TURN_TEXT);
    expect(assembled).not.toContain(SIBLING_TURN_TEXT);
    expect(assembled).not.toContain(TARGET_REF);
  }, 60_000);
});
