/**
 * PRI-1146 P2-01 — full receipt re-verification after a process restart.
 *
 * The previous restart test only proved that `readRouterContextReceipt()` can
 * READ the envelope back. That is a structural check, not evidence: it does not
 * re-derive the message, the effective system prompt, the predecessor digests,
 * or the exposed set. This suite closes that gap with the production chain:
 *
 *   real SQLite state manager → real split runners → real PiAiRuntimeAdapter
 *   (provider call mocked) → receipt + `runs.input_payload` + predecessor
 *   artifacts persisted → runtime closed → NEW runtime opens the same
 *   workspace → evidence rebuilt from persisted data ONLY →
 *   `verifyRouterContextReceipt()`.
 *
 * Every negative case tampers ONE persisted input and must be rejected. A
 * structural read of the same tampered envelope still succeeds, which is
 * exactly why `readRouterContextReceipt()` alone is never "verified".
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('@earendil-works/pi-ai/compat', () => ({
  getModel: vi.fn(),
  getProviders: vi.fn(() => ['openrouter', 'anthropic', 'openai', 'google']),
  completeSimple: vi.fn(),
}));

import { getModel, completeSimple } from '@earendil-works/pi-ai/compat';
import { PiAiRuntimeAdapter } from '../../adapter/pi-ai-runtime-adapter.js';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { SqliteDiagnosticianCommitter } from '../../store/commit/diagnostician-committer.js';
import { SqliteContextAssembler } from '../../store/context/sqlite-context-assembler.js';
import { SqliteHistoryQuery } from '../../store/history/sqlite-history-query.js';
import { PainSignalBridge } from '../../pain-signal-bridge.js';
import { CandidateIntakeService } from '../../candidate-intake-service.js';
import { PrincipleTreeLedgerAdapter } from '../../adapter/principle-tree-ledger-adapter.js';
import { addPrincipleToLedger } from '../../../principle-tree-ledger.js';
import type { LedgerPrinciple } from '../../types/ledger-store.js';
import { DiagRootCauseRunner } from '../diag-rootcause-runner.js';
import { DiagDistillerRunner } from '../diag-distiller-runner.js';
import { DiagRouterRunner } from '../diag-router-runner.js';
import { SplitDiagnosticianRunner } from '../split-diagnostician-runner.js';
import { DefaultDiagRootCauseValidator } from '../../diagnostician/diag-rootcause-output.js';
import { DefaultDiagDistillerValidator } from '../../diagnostician/diag-distiller-output.js';
import {
  readRouterContextReceipt,
  verifyRouterContextReceipt,
  type RouterContextReceipt,
} from '../router-context-evidence.js';
import { reconstructRouterContextEvidence } from '../router-context-reconstruction.js';
import { MOCK_ROOT_CAUSE_OUTPUTS, MOCK_DISTILLER_OUTPUTS, MOCK_ROUTER_OUTPUTS } from '../../adapter/split-pipeline-fixtures.js';
import type { StoreEventEmitter } from '../../store/event-emitter.js';

const OWNER = 'test-receipt-restart-owner';
const RUNTIME_KIND = 'pi-ai';
const PAIN_ID = 'pain-receipt-restart';
const PARENT_TASK_ID = `diagnosis_${PAIN_ID}`;
const ROUTER_TASK_ID = `diag_router-${PARENT_TASK_ID}`;
const ROOTCAUSE_TASK_ID = `diag_rootcause-${PARENT_TASK_ID}`;
const DISTILLER_TASK_ID = `diag_distiller-${PARENT_TASK_ID}`;
const SEEDED_PRINCIPLE_ID = '22222222-2222-4222-8222-222222222222';
const PROFILE_LAYER = 'PROFILE-LAYER: always answer with terse JSON.';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const mockGetModel = getModel as ReturnType<typeof vi.fn>;
const mockComplete = completeSimple as ReturnType<typeof vi.fn>;

function makeAssistantMessage(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    role: 'assistant' as const,
    stopReason: 'stop' as const,
    api: 'openai-completions',
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
  };
}

function makePrinciple(id: string): LedgerPrinciple {
  return {
    id, version: 1, text: 'Limit blast radius', triggerPattern: '', action: '',
    status: 'active', priority: 'P2', scope: 'general', evaluability: 'weak_heuristic',
    valueScore: 0, adherenceRate: 0, painPreventedCount: 0, derivedFromPainIds: [],
    ruleIds: [], conflictsWithPrincipleIds: [],
    createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z',
  };
}

/** Plain, JSON-safe evidence loaded from disk by a NEW runtime instance. */
interface ReloadedEvidence {
  envelope: Record<string, unknown>;
  run: { runId: string; taskId: string; inputPayload?: string };
  predecessorArtifacts: { artifactId: string; contentJson: string }[];
}

describe('PRI-1146 P2-01 — receipt survives restart and fully re-verifies', () => {
  let tmpDir = '';
  let receipt: RouterContextReceipt;
  /** The EXACT system prompt handed to the provider for the router stage. */
  let providerSystemPrompt = '';
  let routerInputPayload = '';

  beforeAll(async () => {
    process.env.TEST_API_KEY = 'test-key-123';
    mockGetModel.mockReturnValue({ id: 'anthropic/claude-sonnet-4' });
    vi.clearAllMocks();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-receipt-restart-int-'));
    const ledgerStateDir = path.join(tmpDir, '.state');
    fs.mkdirSync(ledgerStateDir, { recursive: true });
    addPrincipleToLedger(ledgerStateDir, makePrinciple(SEEDED_PRINCIPLE_ID));

    const stateManager = new RuntimeStateManager({ workspaceDir: tmpDir });
    await stateManager.initialize();
    const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir: ledgerStateDir });
    const committer = new SqliteDiagnosticianCommitter(stateManager.connection);
    const contextAssembler = new SqliteContextAssembler(
      stateManager.taskStore,
      new SqliteHistoryQuery(stateManager.connection),
      stateManager.runStore,
      { trajectoryTurnReader: { listUserTurnsForSession: vi.fn().mockReturnValue([]), listAssistantTurns: vi.fn().mockReturnValue([]) } },
    );

    const runtimeAdapter = new PiAiRuntimeAdapter({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
      apiKeyEnv: 'TEST_API_KEY',
      outputPathStrategy: 'free_form_only',
      systemPrompt: PROFILE_LAYER,
    });

    // Deterministic provider: Stage A → B → C in call order. The distiller's
    // source artifact id is read back from the real store at call time, exactly
    // like production.
    let providerCalls = 0;
    mockComplete.mockImplementation(async () => {
      providerCalls++;
      if (providerCalls === 1) {
        return makeAssistantMessage(JSON.stringify({
          ...MOCK_ROOT_CAUSE_OUTPUTS.R6,
          diagnosisId: 'diag-restart-001',
          taskId: ROOTCAUSE_TASK_ID,
        }));
      }
      if (providerCalls === 2) {
        const stageAArtifacts = await stateManager.piArtifactStore.listBySourceTaskId(ROOTCAUSE_TASK_ID);
        const stageAArtifactId = stageAArtifacts[0]?.artifactId;
        if (!stageAArtifactId) throw new Error('stage A artifact missing before stage B');
        return makeAssistantMessage(JSON.stringify({
          ...MOCK_DISTILLER_OUTPUTS.R6,
          taskId: DISTILLER_TASK_ID,
          sourceRootCauseArtifactId: stageAArtifactId,
        }));
      }
      return makeAssistantMessage(JSON.stringify({
        ...MOCK_ROUTER_OUTPUTS.R6,
        diagnosisId: 'diag-restart-001',
      }));
    });

    const eventEmitter = { emitTelemetry: vi.fn() } as Pick<StoreEventEmitter, 'emitTelemetry'>;
    const options = { owner: OWNER, runtimeKind: RUNTIME_KIND, pollIntervalMs: 10, timeoutMs: 1000 };
    const rootCauseRunner = new DiagRootCauseRunner(
      { stateManager, runtimeAdapter, eventEmitter, artifactStore: stateManager.piArtifactStore, validator: new DefaultDiagRootCauseValidator(), contextAssembler },
      options,
    );
    const distillerRunner = new DiagDistillerRunner(
      { stateManager, runtimeAdapter, eventEmitter, artifactStore: stateManager.piArtifactStore, validator: new DefaultDiagDistillerValidator() },
      options,
    );
    const routerRunner = new DiagRouterRunner(
      { stateManager, runtimeAdapter, eventEmitter, artifactStore: stateManager.piArtifactStore, committer, trustedPrincipleSource: ledgerAdapter },
      options,
    );
    const splitRunner = new SplitDiagnosticianRunner({ rootCauseRunner, distillerRunner, routerRunner, stateManager, committer });
    const intakeService = new CandidateIntakeService({ stateManager, ledgerAdapter });
    const bridge = new PainSignalBridge({ stateManager, runner: splitRunner, intakeService, ledgerAdapter, autoIntakeEnabled: true, workspaceDir: tmpDir });

    await bridge.onPainDetected({
      painId: PAIN_ID,
      painType: 'tool_failure',
      source: 'test-source',
      reason: 'test reason',
      evidence: [{ sourceRef: 'owner_reported:cli', note: 'evidence note' }],
    });

    expect((await stateManager.getTask(ROUTER_TASK_ID))?.status).toBe('succeeded');

    // The router call is the one whose RAW user message carries `trustedContext`
    // (JSON.stringify would escape the quotes and defeat the search).
    const routerCall = mockComplete.mock.calls
      .map((call) => call[1] as { systemPrompt?: unknown; messages?: { content?: unknown }[] })
      .find((context) => typeof context.messages?.[0]?.content === 'string'
        && (context.messages[0].content).includes('"trustedContext"'));
    if (!routerCall || typeof routerCall.systemPrompt !== 'string') throw new Error('router provider call missing');
    providerSystemPrompt = routerCall.systemPrompt;

    const routerArtifacts = await stateManager.piArtifactStore.listBySourceTaskId(ROUTER_TASK_ID);
    const [routerArtifact] = routerArtifacts;
    if (!routerArtifact) throw new Error('missing persisted router artifact');
    const parsedEnvelope: unknown = JSON.parse(routerArtifact.contentJson);
    if (parsedEnvelope === null || typeof parsedEnvelope !== 'object') throw new Error('invalid router envelope');
    const receiptNode = Reflect.get(parsedEnvelope, 'trustedContextReceipt');
    if (typeof receiptNode !== 'object' || receiptNode === null) throw new Error('missing trustedContextReceipt');
    const runIdForRead = Reflect.get(receiptNode, 'runId');
    if (typeof runIdForRead !== 'string') throw new Error('receipt runId missing');
    const read = readRouterContextReceipt(parsedEnvelope, { taskId: ROUTER_TASK_ID, runId: runIdForRead });
    if (read.status !== 'available') throw new Error(`receipt unreadable: ${read.reason}`);
    ({receipt} = read);

    const run = await stateManager.runStore.getRun(receipt.runId);
    if (!run?.inputPayload) throw new Error('router run input payload was not persisted');
    routerInputPayload = run.inputPayload;

    // Simulate the process ending: the original runtime is closed and no
    // in-memory object below is reused by the assertions.
    stateManager.close();
  });

  afterAll(() => {
    delete process.env.TEST_API_KEY;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows may hold the closed SQLite handle briefly */ }
  });

  /** Open a BRAND NEW runtime and load evidence from disk only. */
  async function reloadEvidence(runId: string): Promise<ReloadedEvidence> {
    const stateManager = new RuntimeStateManager({ workspaceDir: tmpDir });
    await stateManager.initialize();
    try {
      const routerArtifacts = await stateManager.piArtifactStore.listBySourceTaskId(ROUTER_TASK_ID);
      const [routerArtifact] = routerArtifacts;
      if (!routerArtifact) throw new Error('missing persisted router artifact after restart');
      const parsedEnvelope: unknown = JSON.parse(routerArtifact.contentJson);
      if (parsedEnvelope === null || typeof parsedEnvelope !== 'object') throw new Error('invalid router envelope after restart');
      const envelope = parsedEnvelope as Record<string, unknown>;

      const run = await stateManager.runStore.getRun(runId);
      if (!run) throw new Error('router run missing after restart');

      const {inputPayload} = run;
      if (!inputPayload) throw new Error('router run input payload missing after restart');
      const parsedPayload: unknown = JSON.parse(inputPayload);
      if (parsedPayload === null || typeof parsedPayload !== 'object') throw new Error('invalid router input payload');
      const { rootCauseArtifactId, distillerArtifactId } = parsedPayload as { rootCauseArtifactId: string; distillerArtifactId: string };

      const artifacts = await Promise.all([
        stateManager.piArtifactStore.getArtifactById(rootCauseArtifactId),
        stateManager.piArtifactStore.getArtifactById(distillerArtifactId),
      ]);
      const predecessorArtifacts = artifacts
        .filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== null)
        .map((artifact) => ({ artifactId: artifact.artifactId, contentJson: artifact.contentJson }));

      return {
        envelope,
        run: { runId: run.runId, taskId: run.taskId, inputPayload },
        predecessorArtifacts,
      };
    } finally {
      stateManager.close();
    }
  }

  function reconstructFrom(evidence: ReloadedEvidence) {
    return reconstructRouterContextEvidence({
      run: evidence.run,
      predecessorArtifacts: evidence.predecessorArtifacts,
      profileSystemPrompt: PROFILE_LAYER,
    });
  }

  it('re-verifies the FULL evidence set from persisted data in a new process', async () => {
    const persisted = await reloadEvidence(receipt.runId);

    // Persistence proof: the exact submitted message survived the restart.
    expect(persisted.run.inputPayload).toBe(routerInputPayload);
    expect(persisted.envelope).toHaveProperty('trustedContextReceipt');

    const reconstructed = reconstructFrom(persisted);
    expect(reconstructed.status).toBe('available');
    if (reconstructed.status !== 'available') return;
    const {evidence} = reconstructed;

    // The evidence was rebuilt from disk, including the profile layer merge.
    expect(evidence.systemPrompt).toContain(PROFILE_LAYER);
    expect(sha256(evidence.systemPrompt)).toBe(receipt.systemPromptDigest);
    // The digest matches the prompt the provider ACTUALLY received pre-restart.
    expect(receipt.systemPromptDigest).toBe(sha256(providerSystemPrompt));
    expect(receipt.messageDigest).toBe(sha256(persisted.run.inputPayload ?? ''));

    const verified = verifyRouterContextReceipt(persisted.envelope, {
      taskId: persisted.run.taskId,
      runId: persisted.run.runId,
      contextHash: evidence.contextHash,
      message: evidence.message,
      systemPrompt: evidence.systemPrompt,
      predecessors: evidence.predecessors,
      exposed: evidence.exposed,
    });
    expect(verified).toEqual({ status: 'available', receipt });
  });

  it('rejects a tampered message even though the structural read still passes', async () => {
    const persisted = await reloadEvidence(receipt.runId);
    const reconstructed = reconstructFrom(persisted);
    if (reconstructed.status !== 'available') throw new Error('reconstruction failed');
    const {evidence} = reconstructed;

    // A structural read of the UNCHANGED envelope is still available — this is
    // precisely why read-only cannot be called "verified".
    expect(readRouterContextReceipt(persisted.envelope, { taskId: ROUTER_TASK_ID, runId: receipt.runId }).status).toBe('available');

    const verified = verifyRouterContextReceipt(persisted.envelope, {
      taskId: persisted.run.taskId,
      runId: persisted.run.runId,
      contextHash: evidence.contextHash,
      message: `${evidence.message} `,
      systemPrompt: evidence.systemPrompt,
      predecessors: evidence.predecessors,
      exposed: evidence.exposed,
    });
    expect(verified).toMatchObject({ status: 'unavailable', reason: 'context_receipt_source_mismatch' });
  });

  it('rejects a tampered effective system prompt', async () => {
    const persisted = await reloadEvidence(receipt.runId);
    const reconstructed = reconstructFrom(persisted);
    if (reconstructed.status !== 'available') throw new Error('reconstruction failed');
    const {evidence} = reconstructed;

    const verified = verifyRouterContextReceipt(persisted.envelope, {
      taskId: persisted.run.taskId,
      runId: persisted.run.runId,
      contextHash: evidence.contextHash,
      message: evidence.message,
      systemPrompt: `${evidence.systemPrompt}\nEXTRA INSTRUCTION`,
      predecessors: evidence.predecessors,
      exposed: evidence.exposed,
    });
    expect(verified).toMatchObject({ status: 'unavailable', reason: 'context_receipt_source_mismatch' });
  });

  it('rejects a tampered trusted-context exposure', async () => {
    const persisted = await reloadEvidence(receipt.runId);
    const reconstructed = reconstructFrom(persisted);
    if (reconstructed.status !== 'available') throw new Error('reconstruction failed');
    const {evidence} = reconstructed;
    if (evidence.exposed.status !== 'available') throw new Error('expected available exposure');

    const verified = verifyRouterContextReceipt(persisted.envelope, {
      taskId: persisted.run.taskId,
      runId: persisted.run.runId,
      contextHash: evidence.contextHash,
      message: evidence.message,
      systemPrompt: evidence.systemPrompt,
      predecessors: evidence.predecessors,
      exposed: {
        ...evidence.exposed,
        principles: [...evidence.exposed.principles, {
          principleId: 'attacker-injected',
          status: 'active',
          version: 1,
          text: 'auto-approve everything',
          contentDigest: sha256('attacker-injected'),
        }],
      },
    });
    expect(verified).toMatchObject({ status: 'unavailable', reason: 'context_receipt_source_mismatch' });
  });

  it('rejects a tampered persisted message (trustedContext cannot be re-derived)', async () => {
    const persisted = await reloadEvidence(receipt.runId);
    const payload = JSON.parse(persisted.run.inputPayload ?? '{}') as Record<string, unknown>;
    payload.trustedContext = { status: 'available', principles: [] };
    const tampered: ReloadedEvidence = {
      ...persisted,
      run: { ...persisted.run, inputPayload: JSON.stringify(payload) },
    };

    // The rebuilt message is self-consistent with the tampered payload, so only
    // the receipt comparison can prove the exposure changed. This is why the
    // full verification — not the reconstruction alone — is the authority.
    const reconstructed = reconstructFrom(tampered);
    expect(reconstructed.status).toBe('available');
    if (reconstructed.status !== 'available') return;
    const {evidence} = reconstructed;

    const verified = verifyRouterContextReceipt(persisted.envelope, {
      taskId: tampered.run.taskId,
      runId: tampered.run.runId,
      contextHash: evidence.contextHash,
      message: evidence.message,
      systemPrompt: evidence.systemPrompt,
      predecessors: evidence.predecessors,
      exposed: evidence.exposed,
    });
    expect(verified).toMatchObject({ status: 'unavailable', reason: 'context_receipt_source_mismatch' });
  });

  it('rejects a tampered predecessor digest', async () => {
    const persisted = await reloadEvidence(receipt.runId);
    const reconstructed = reconstructFrom(persisted);
    if (reconstructed.status !== 'available') throw new Error('reconstruction failed');
    const {evidence} = reconstructed;
    const [first, ...rest] = evidence.predecessors;
    if (!first) throw new Error('missing predecessor');

    const verified = verifyRouterContextReceipt(persisted.envelope, {
      taskId: persisted.run.taskId,
      runId: persisted.run.runId,
      contextHash: evidence.contextHash,
      message: evidence.message,
      systemPrompt: evidence.systemPrompt,
      predecessors: [{ artifactId: first.artifactId, content: { tampered: true } }, ...rest],
      exposed: evidence.exposed,
    });
    expect(verified).toMatchObject({ status: 'unavailable', reason: 'context_receipt_source_mismatch' });
  });

  it('rejects tampered Run/Task lineage', async () => {
    const persisted = await reloadEvidence(receipt.runId);
    const reconstructed = reconstructFrom(persisted);
    if (reconstructed.status !== 'available') throw new Error('reconstruction failed');
    const {evidence} = reconstructed;

    const verified = verifyRouterContextReceipt(persisted.envelope, {
      taskId: `${persisted.run.taskId}-forged`,
      runId: persisted.run.runId,
      contextHash: evidence.contextHash,
      message: evidence.message,
      systemPrompt: evidence.systemPrompt,
      predecessors: evidence.predecessors,
      exposed: evidence.exposed,
    });
    expect(verified).toMatchObject({ status: 'unavailable', reason: 'context_receipt_lineage_mismatch' });
  });

  it('rejects a tampered Artifact lineage (predecessor content no longer matches the message)', async () => {
    const persisted = await reloadEvidence(receipt.runId);
    const [first, ...rest] = persisted.predecessorArtifacts;
    if (!first) throw new Error('missing predecessor artifact');

    const tampered: ReloadedEvidence = {
      ...persisted,
      predecessorArtifacts: [{ ...first, contentJson: JSON.stringify({ tampered: true }) }, ...rest],
    };
    const reconstructed = reconstructFrom(tampered);
    expect(reconstructed).toMatchObject({ status: 'unavailable', reason: 'predecessor_artifact_invalid' });
  });

  it('rejects missing persisted evidence instead of degrading to a read', async () => {
    const persisted = await reloadEvidence(receipt.runId);

    const missingPayload = reconstructFrom({ ...persisted, run: { ...persisted.run, inputPayload: undefined } });
    expect(missingPayload).toMatchObject({ status: 'unavailable', reason: 'run_input_payload_missing' });

    const missingArtifact = reconstructFrom({
      ...persisted,
      predecessorArtifacts: persisted.predecessorArtifacts.slice(0, 1),
    });
    expect(missingArtifact).toMatchObject({ status: 'unavailable', reason: 'predecessor_artifacts_incomplete' });
  });
});
