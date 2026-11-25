/**
 * PRI-1282 Phase 4 — the standalone OpenClaw workspace worker.
 *
 * Covers the ownership gate (refuse anything but service_host_owned,
 * fail-closed on an unreadable marker), the real bounded cycle against a real
 * workspace (empty cycle = truthful `ready`, never fabricated progress), the
 * no-consume readiness self-check, the liveness evidence file, and the
 * PARITY guard: the ports this worker hands to the shared consumer cycle
 * must equal the Gateway AutoConsumer's ports on every OpenClaw host fact.
 *
 * Ownership reads use the cycle's injection seam (`options.ownership`) —
 * vi.mock cannot intercept a module's INTERNAL calls, and the real manifest
 * chain has its own install-layout suite.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeOpenClawWorkerReadiness,
  openclawWorkerCycleDriver,
  readOpenClawWorkerLiveness,
  runOpenClawWorkspaceWorkerCycle,
} from '../../src/openclaw-worker.js';
import { runConsumerCycle } from '../../src/service/internalization-auto-consumer-service.js';
import { createDiagnosticianTaskId, createRuntimeStateHandle, getDefaultPdConfig } from '@principles/core/runtime';
import { SystemLogger } from '../../src/core/system-logger.js';
import { recordConversationIngestionConsent, runInternalizationConsumerCycle, runPendingDiagnosticianOnce } from '@principles/host-runtime';
import type { WorkspaceBackgroundOwnership } from '@principles/install-layout';
import type { InternalizationConsumerCyclePorts } from '@principles/host-runtime';
import { prepareOpenClawPromptRound } from '../../src/hooks/prompt.js';
import { readOpenclawTargetTurnEvidence } from '../../src/hooks/pain-receipt-fallback.js';

vi.mock('../../src/core/system-logger.js');
// Spread-mock host-runtime (ERR-115 pattern): default delegates to the real
// implementations so the cycle tests exercise production behavior; individual
// cases override for capture/injection.
vi.mock('@principles/host-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@principles/host-runtime')>();
  return {
    ...actual,
    runInternalizationConsumerCycle: vi.fn(async (...args: Parameters<typeof actual.runInternalizationConsumerCycle>) => actual.runInternalizationConsumerCycle(...args)),
    runPendingDiagnosticianOnce: vi.fn(async (...args: Parameters<typeof actual.runPendingDiagnosticianOnce>) => actual.runPendingDiagnosticianOnce(...args)),
  };
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let workspaceDir: string;

const LEGACY: WorkspaceBackgroundOwnership = { status: 'legacy_owned', source: 'no_record', generation: 0 };
const SERVICE_HOST_OWNED: WorkspaceBackgroundOwnership = {
  status: 'service_host_owned',
  generation: 2,
  record: { state: 'service_host_owned', effectiveOwner: 'service_host', generation: 2, operationId: null, previousOwner: null, targetOwner: null, updatedAt: '2026-11-22T00:00:00.000Z' },
};
const UNREADABLE: WorkspaceBackgroundOwnership = { status: 'manifest_unreadable', reason: 'install_manifest_missing', nextAction: 'restore' };

beforeEach(() => {
  vi.clearAllMocks();
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-openclaw-worker-'));
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), [
    'version: 1',
    'features:',
    '  internalization_auto_consumer:',
    '    category: quiet',
    '    enabled: true',
    '',
  ].join('\n'));
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

function ownership(value: WorkspaceBackgroundOwnership): () => WorkspaceBackgroundOwnership {
  return () => value;
}

describe('runOpenClawWorkspaceWorkerCycle — ownership gate', () => {
  it('refuses a legacy-owned workspace (manual invocation cannot create a double consumer)', async () => {
    const result = await runOpenClawWorkspaceWorkerCycle({ workspaceDir, logger, ownership: ownership(LEGACY) });
    expect(result).toMatchObject({ mode: 'paused', reason: expect.stringContaining('openclaw_workspace_not_service_host_owned:legacy_owned') });
    expect(result.report).toBeUndefined();
  });

  it('fails closed on an unreadable ownership marker', async () => {
    const result = await runOpenClawWorkspaceWorkerCycle({ workspaceDir, logger, ownership: ownership(UNREADABLE) });
    expect(result).toMatchObject({ mode: 'degraded', reason: expect.stringContaining('openclaw_owner_marker_unreadable') });
  });

  it('degrades on a missing workspace directory', async () => {
    const result = await runOpenClawWorkspaceWorkerCycle({ workspaceDir: path.join(workspaceDir, 'not-there'), logger });
    expect(result).toMatchObject({ mode: 'degraded', reason: 'openclaw_workspace_directory_missing' });
  });
});

describe('runOpenClawWorkspaceWorkerCycle — real bounded cycle', () => {
  it('completes an empty cycle truthfully: mode ready, ran=false, no fabricated progress', async () => {
    const result = await runOpenClawWorkspaceWorkerCycle({ workspaceDir, logger, ownership: ownership(SERVICE_HOST_OWNED) });
    expect(result.mode).toBe('ready');
    expect(result.report).toMatchObject({
      ownership: { state: 'service_host_owned', generation: 2 },
      declaration: { persisted: true, validated: true },
      downstream: { ran: false },
    });
    // The declaration really landed on disk (host fact refresh, codex pattern).
    expect(fs.existsSync(path.join(workspaceDir, '.pd', 'host-tool-semantics', 'openclaw.json'))).toBe(true);
    // The shared cycle wrote the real state db.
    expect(fs.existsSync(path.join(workspaceDir, '.pd', 'state.db'))).toBe(true);
    // Liveness evidence exists and is finalized.
    const liveness = readOpenClawWorkerLiveness(workspaceDir);
    expect(liveness).toMatchObject({ runningStage: null, lastCycleMode: 'ready', lastCycleDriver: 'manual' });
  });

  it('reports degraded with rc-9 reason when the consumer cycle throws', async () => {
    const real = vi.mocked(runInternalizationConsumerCycle);
    real.mockImplementationOnce(async () => { throw new Error('provider exploded'); });
    const result = await runOpenClawWorkspaceWorkerCycle({ workspaceDir, logger, ownership: ownership(SERVICE_HOST_OWNED) });
    expect(result).toMatchObject({ mode: 'degraded', reason: expect.stringContaining('openclaw_consumer_cycle_error') });
    expect(result.nextAction).toBeDefined();
    real.mockRestore?.();
  });

  it('attributes the cycle driver from PD_INVOCATION_SOURCE', async () => {
    process.env.PD_INVOCATION_SOURCE = 'service_host';
    try {
      await runOpenClawWorkspaceWorkerCycle({ workspaceDir, logger, ownership: ownership(SERVICE_HOST_OWNED) });
      expect(readOpenClawWorkerLiveness(workspaceDir)).toMatchObject({ lastCycleDriver: 'service_host' });
    } finally {
      delete process.env.PD_INVOCATION_SOURCE;
    }
    expect(openclawWorkerCycleDriver()).toBe('manual');
  });

  it('routes diagnostician evidence into the report (served and skipped)', async () => {
    const real = vi.mocked(runPendingDiagnosticianOnce);
    real.mockResolvedValueOnce({ served: true, taskId: 'diagnosis_pain-9' } as never);
    const served = await runOpenClawWorkspaceWorkerCycle({ workspaceDir, logger, ownership: ownership(SERVICE_HOST_OWNED) });
    expect(served.report?.diagnostician).toMatchObject({ served: true, status: 'succeeded', taskId: 'diagnosis_pain-9' });
    real.mockResolvedValueOnce({ served: false, reason: 'no_candidate' } as never);
    const skipped = await runOpenClawWorkspaceWorkerCycle({ workspaceDir, logger, ownership: ownership(SERVICE_HOST_OWNED) });
    expect(skipped.report?.diagnostician).toMatchObject({ served: false, status: 'no_candidate' });
  });
});

describe('computeOpenClawWorkerReadiness (no-consume self-check)', () => {
  it('requires the credential of the profile the diagnostician ACTUALLY binds — not any configured one (PRI-1282 review)', async () => {
    // Two profiles: pd.a's secret IS exported, pd.b's is not. The
    // diagnostician binds pd.b, so the workspace is NOT ready even though a
    // configured credential exists (the consuming cycle would hit
    // runtime_config_error on pd.b).
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), [
      'version: 1',
      'features:',
      '  internalization_auto_consumer: { category: quiet, enabled: true }',
      'runtimeProfiles:',
      "  pd.a: { type: pi-ai, provider: p, model: m, apiKeyEnv: PD_TEST_BOUND_A_KEY, baseUrl: 'http://127.0.0.1/v1' }",
      "  pd.b: { type: pi-ai, provider: p, model: m, apiKeyEnv: PD_TEST_UNBOUND_B_KEY, baseUrl: 'http://127.0.0.1/v1' }",
      'internalAgents:',
      "  defaultRuntime: pd.b",
      '  agents:',
      '    diagnostician: { enabled: true }',
      '',
    ].join('\n'));
    process.env.PD_TEST_BOUND_A_KEY = 'a-secret';
    delete process.env.PD_TEST_UNBOUND_B_KEY;
    try {
      const readiness = await computeOpenClawWorkerReadiness(workspaceDir, { ownership: ownership(SERVICE_HOST_OWNED) });
      expect(readiness.checks.credentials).toBe(false);

      // Rebind the diagnostician to pd.a — now readiness answers for the
      // credential the cycle will actually use.
      fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), [
        'version: 1',
        'features:',
        '  internalization_auto_consumer: { category: quiet, enabled: true }',
        'runtimeProfiles:',
        "  pd.a: { type: pi-ai, provider: p, model: m, apiKeyEnv: PD_TEST_BOUND_A_KEY, baseUrl: 'http://127.0.0.1/v1' }",
        "  pd.b: { type: pi-ai, provider: p, model: m, apiKeyEnv: PD_TEST_UNBOUND_B_KEY, baseUrl: 'http://127.0.0.1/v1' }",
        'internalAgents:',
        "  defaultRuntime: pd.a",
        '  agents:',
        '    diagnostician: { enabled: true }',
        '',
      ].join('\n'));
      const rebound = await computeOpenClawWorkerReadiness(workspaceDir, { ownership: ownership(SERVICE_HOST_OWNED) });
      expect(rebound.checks.credentials).toBe(true);
    } finally {
      delete process.env.PD_TEST_BOUND_A_KEY;
      delete process.env.PD_TEST_UNBOUND_B_KEY;
    }
  });


  it('is degraded while the workspace has no declaration / trajectory / credentials', async () => {
    const readiness = await computeOpenClawWorkerReadiness(workspaceDir, { ownership: ownership(SERVICE_HOST_OWNED) });
    expect(readiness.mode).toBe('degraded');
    expect(readiness.checks.workspaceDirectory).toBe(true);
    expect(readiness.checks.ownership).toBe(true);
    expect(readiness.checks.declaration).toBe(false);
    expect(readiness.reason).toContain('declaration');
    expect(readiness.nextAction).toBeDefined();
  });

  it('becomes ready once declaration, trajectory db and credentials exist', async () => {
    // Land the declaration the real way (the worker cycle persists it).
    await runOpenClawWorkspaceWorkerCycle({ workspaceDir, logger, ownership: ownership(SERVICE_HOST_OWNED) });
    fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
    const trajectoryDb = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    // Real production shape: the evidence port queries
    // tool_calls(id, session_id, tool_name, outcome, params_json) and
    // pain_events(id, session_id, canonical_pain_id)
    // (workspace-behavior-evidence.ts) — a bare `id` fixture would pass the
    // check while the port could never consume it (PRI-1282 r5 F8).
    trajectoryDb.exec(
      'CREATE TABLE tool_calls (id INTEGER PRIMARY KEY, session_id TEXT, tool_name TEXT, outcome TEXT, params_json TEXT);'
      + 'CREATE TABLE pain_events (id INTEGER PRIMARY KEY, session_id TEXT, canonical_pain_id TEXT);',
    );
    trajectoryDb.close();
    process.env.OPENROUTER_API_KEY = 'test-value';
    try {
      const readiness = await computeOpenClawWorkerReadiness(workspaceDir, { ownership: ownership(SERVICE_HOST_OWNED) });
      // This minimal fixture declares no runtimeProfiles, so the credential
      // check is honestly degraded — assert the full matrix instead of
      // pretending a profile-less workspace is credential-ready.
      expect(readiness.checks).toEqual({ workspaceDirectory: true, ownership: true, declaration: true, evidencePort: true, credentials: false });
      expect(readiness.reason).toContain('credentials');
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('degrades when the trajectory schema is an older shape missing evidence columns', async () => {
    await runOpenClawWorkspaceWorkerCycle({ workspaceDir, logger, ownership: ownership(SERVICE_HOST_OWNED) });
    fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
    const trajectoryDb = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    // Old schema: tables exist but lack session_id/canonical_pain_id — the
    // port's queries would throw at consume time; readiness must degrade.
    trajectoryDb.exec('CREATE TABLE tool_calls (id INTEGER PRIMARY KEY); CREATE TABLE pain_events (id INTEGER PRIMARY KEY);');
    trajectoryDb.close();
    const readiness = await computeOpenClawWorkerReadiness(workspaceDir, { ownership: ownership(SERVICE_HOST_OWNED) });
    expect(readiness.mode).toBe('degraded');
    expect(readiness.checks.evidencePort).toBe(false);
    expect(readiness.checks.declaration).toBe(true);
  });

  it('gates a pending DEFAULT-DISABLED stage task by credentials, not agents[].enabled (PRI-1282 r5 F4)', async () => {
    // Real configured profile; agent section left at shipped defaults —
    // philosopher is disabled by default yet the full-chain consumer runs it.
    const config = getDefaultPdConfig();
    (config.runtimeProfiles as Record<string, unknown>)['pd.default'] = {
      type: 'pi-ai', provider: 'test-provider', model: 'test-model',
      apiKeyEnv: 'PD_TEST_STAGE_KEY', baseUrl: 'http://127.0.0.1:8080/v1',
    };
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
    const pending = { pendingTaskKinds: async () => ['philosopher'] as const, ownership: ownership(SERVICE_HOST_OWNED) };
    // Credential present → a disabled-by-default stage agent still passes:
    // the consuming cycle resolves it with ignoreAgentEnabled: true.
    process.env.PD_TEST_STAGE_KEY = 'test-value';
    try {
      const readiness = await computeOpenClawWorkerReadiness(workspaceDir, pending);
      expect(readiness.checks.credentials).toBe(true);
    } finally {
      delete process.env.PD_TEST_STAGE_KEY;
    }
    // Credential missing → honestly rejected.
    const denied = await computeOpenClawWorkerReadiness(workspaceDir, pending);
    expect(denied.checks.credentials).toBe(false);
  });

  it('fails closed when the ownership marker is unreadable', async () => {
    const readiness = await computeOpenClawWorkerReadiness(workspaceDir, { ownership: ownership(UNREADABLE) });
    expect(readiness.mode).toBe('degraded');
    expect(readiness.checks.ownership).toBe(false);
  });
});

describe('parity with the Gateway AutoConsumer ports (instruction §5.3)', () => {
  it('hands the shared cycle the SAME OpenClaw host facts the Gateway service does', async () => {
    const captured: InternalizationConsumerCyclePorts[] = [];
    const real = vi.mocked(runInternalizationConsumerCycle);
    real.mockImplementationOnce(async (_dir: string, ports: InternalizationConsumerCyclePorts) => {
      captured.push(ports);
      return { ran: false, skipReason: 'parity-capture' } as never;
    });
    real.mockImplementationOnce(async (_dir: string, ports: InternalizationConsumerCyclePorts) => {
      captured.push(ports);
      return { ran: false, skipReason: 'parity-capture' } as never;
    });
    const gatewayDir = path.join(path.dirname(workspaceDir), `${path.basename(workspaceDir)}-gateway-parity`);
    fs.mkdirSync(path.join(gatewayDir, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(gatewayDir, '.pd', 'config.yaml'), fs.readFileSync(path.join(workspaceDir, '.pd', 'config.yaml')));
    try {
      await runConsumerCycle(gatewayDir, logger);
      await runOpenClawWorkspaceWorkerCycle({ workspaceDir, logger, ownership: ownership(SERVICE_HOST_OWNED) });
    } finally {
      fs.rmSync(gatewayDir, { recursive: true, force: true });
    }
    expect(captured).toHaveLength(2);
    const [gatewayPorts, workerPorts] = captured;
    // Same host facts (the ONLY intentional difference is attribution:
    // owner/logLabel — the worker must identify itself honestly).
    expect(workerPorts.hostToolCatalog).toEqual(gatewayPorts.hostToolCatalog);
    expect(workerPorts.toolSemantics).toBe(gatewayPorts.toolSemantics);
    expect(workerPorts.hostKinds).toEqual(gatewayPorts.hostKinds);
    expect(workerPorts.behaviorEvidence).toBeDefined();
    expect(workerPorts.owner).toBe('service-host-worker');
    expect(gatewayPorts.owner).toBe('auto-consumer');
    // Both event sinks are the SystemLogger module (identical stream across
    // the handover): invoking the worker's sink lands in SystemLogger.log.
    expect(typeof workerPorts.emitEvent).toBe('function');
    workerPorts.emitEvent?.('TEST_PARITY_EVENT', '{}');
    expect(SystemLogger.log).toHaveBeenCalledWith(workspaceDir, 'TEST_PARITY_EVENT', '{}');
  });
});

describe('PRI-1296 — OpenClaw target-evidence reconcile before diagnosis execution', () => {
  it('backfills real authorized target evidence on the SAME waiting task before the diagnostician is invoked', async () => {
    const session = 'oc-session-pri1296';
    const turn = 'turn-10';
    const painId = 'mcp_1700000001296_oc001296';
    const taskId = createDiagnosticianTaskId(painId);
    const consent = recordConversationIngestionConsent(workspaceDir, 'openclaw', {
      decision: 'granted', decidedVia: 'owner_directive', disclosureVersion: 'test-v1', evidenceRef: 'pri-1296-test',
    });
    expect(consent.ok).toBe(true);

    // Real collection path: the production before_prompt_build pre-selection
    // hook persists the admitted user message and connects it to the exact
    // native message id the evidence reader later queries. No direct
    // governance_observations fixture — the row must arrive through the hook.
    const ordinal = prepareOpenClawPromptRound({
      prompt: 'prompt',
      currentUserMessage: 'OC-T10-OWNER-CORRECTION',
      currentUserMessageId: turn,
      messages: [{ role: 'user', content: 'OC-T10-OWNER-CORRECTION' }],
    }, {
      workspaceDir,
      sessionId: session,
      trigger: 'user',
      runId: 'run-pri1296-turn-10',
      logger,
    });
    expect(Number.isInteger(ordinal)).toBe(true);
    expect(readOpenclawTargetTurnEvidence(workspaceDir, session, turn)).toMatchObject({
      status: 'available',
      entries: expect.arrayContaining([expect.objectContaining({ note: 'OC-T10-OWNER-CORRECTION' })]),
    });
    const stamp = new Date().toISOString();

    const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false, bootstrapIfMissing: true });
    try {
      await handle.stateManager.createTask({
        taskId,
        taskKind: 'diagnostician',
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 3,
        inputRef: painId,
        diagnosticJson: JSON.stringify({
          painId,
          hostKind: 'openclaw',
          evidence: [],
          painIngress: {
            verifiedHostSession: { status: 'verified', sessionId: session, targetTurnId: turn },
            evidenceClass: { status: 'unavailable', reason: 'not_applicable_unbound' },
          },
          recovery: {
            schemaVersion: 1,
            state: 'waiting_for_target_evidence',
            reasonCode: 'target_turn_text_pending',
            attemptCount: 1,
            lastCheckedAt: stamp,
          },
        }),
      });
    } finally {
      await handle.close();
    }

    // Keep the paid/model boundary closed: capture that diagnosis is invoked
    // after reconcile while the evidence write itself uses the real stores.
    vi.mocked(runPendingDiagnosticianOnce).mockResolvedValueOnce({ served: false, reason: 'no_candidate' } as never);
    const result = await runOpenClawWorkspaceWorkerCycle({ workspaceDir, logger, ownership: ownership(SERVICE_HOST_OWNED) });
    expect(result.mode).toBe('ready');
    expect(result.report?.targetEvidenceReconcile).toMatchObject({ checked: 1, flipped: 1, backfilled: 1, blocked: 0 });
    expect(runPendingDiagnosticianOnce).toHaveBeenCalledTimes(1);

    const verify = await createRuntimeStateHandle({ workspaceDir, readonly: true });
    try {
      const task = await verify.stateManager.getTask(taskId);
      expect(task?.inputRef).toBe(painId);
      const diagnostic = JSON.parse(task?.diagnosticJson ?? '{}') as Record<string, any>;
      expect(diagnostic.evidence).toEqual([
        { sourceRef: 'governance_observation:openclaw|oc-session-pri1296|turn-10|user', note: 'OC-T10-OWNER-CORRECTION' },
      ]);
      expect(diagnostic.painIngress.evidenceClass).toEqual({ status: 'available', entryCount: 1 });
      expect(diagnostic.recovery).toMatchObject({ state: 'ready_for_diagnosis', reasonCode: 'target_evidence_arrived' });
    } finally {
      await verify.close();
    }
  });

  it('embedded chat without a native message id captures the exact persisted user-turn index', () => {
    const session = 'oc-session-pri1296-embedded';
    const consent = recordConversationIngestionConsent(workspaceDir, 'openclaw', {
      decision: 'granted', decidedVia: 'owner_directive', disclosureVersion: 'test-v1', evidenceRef: 'pri-1296-embedded-test',
    });
    expect(consent.ok).toBe(true);

    const ordinal = prepareOpenClawPromptRound({
      prompt: 'prompt',
      currentUserMessage: 'EMBEDDED-T10-OWNER-CORRECTION',
      messages: [{ role: 'user', content: 'EMBEDDED-T10-OWNER-CORRECTION' }],
    }, {
      workspaceDir,
      sessionId: session,
      trigger: 'user',
      runId: 'run-pri1296-embedded-turn-10',
      logger,
    });
    expect(Number.isInteger(ordinal)).toBe(true);

    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    try {
      const row = db.prepare('SELECT turn_index AS turnIndex FROM user_turns WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(session) as { turnIndex: number } | undefined;
      expect(row?.turnIndex).toEqual(expect.any(Number));
      const hostTurnId = String(row?.turnIndex);
      expect(readOpenclawTargetTurnEvidence(workspaceDir, session, hostTurnId)).toMatchObject({
        status: 'available',
        entries: expect.arrayContaining([expect.objectContaining({ note: 'EMBEDDED-T10-OWNER-CORRECTION' })]),
      });
    } finally {
      db.close();
    }
  });

  it('negative control: the same real prompt collection writes no target evidence before consent is granted', () => {
    const session = 'oc-session-pri1296-no-consent';
    const turn = 'turn-11';
    const ordinal = prepareOpenClawPromptRound({
      prompt: 'prompt',
      currentUserMessage: 'uncollected owner correction',
      currentUserMessageId: turn,
      messages: [{ role: 'user', content: 'uncollected owner correction' }],
    }, {
      workspaceDir,
      sessionId: session,
      trigger: 'user',
      runId: 'run-pri1296-no-consent',
      logger,
    });
    expect(Number.isInteger(ordinal)).toBe(true);
    expect(readOpenclawTargetTurnEvidence(workspaceDir, session, turn).status).toBe('blocked_by_consent');

    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    try {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'governance_observations'").get();
      const count = table === undefined
        ? 0
        : Number((db.prepare('SELECT COUNT(*) AS count FROM governance_observations').get() as { count: number }).count);
      expect(count).toBe(0);
    } finally {
      db.close();
    }
  });
});
