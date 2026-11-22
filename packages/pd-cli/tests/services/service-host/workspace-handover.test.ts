/**
 * PRI-1282 Phase 4 — per-Workspace §8.4 handover / rollback integration.
 *
 * Real objects throughout: the install manifest, the CAS transition
 * primitive, the active-release entry resolution (a stub installed pd-cli
 * that answers `openclaw worker --readiness|--once`), the plugin's real
 * gateway-quiesce-ack writer, and the evidence store. Only the Gateway
 * process is simulated — by writing the SAME ack file its gate writes.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// These tests spawn REAL worker subprocesses through the stub active-release
// entry (Windows process spawn is slow); the suite default of 5s is too tight.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
import { runWorkspaceHandover, runWorkspaceRollback, readHandoverEvidence } from '../../../src/services/service-host/workspace-handover.js';
import { MANAGED_WORKER_HOST_KINDS, WORKER_HOST_KINDS } from '../../../src/services/service-host/worker-adapter.js';
import { readWorkspaceBackgroundOwnership } from '@principles/install-layout';
import { writeGatewayQuiesceAck } from '../../../../openclaw-plugin/src/service/gateway-quiesce-ack.js';

let home: string;
let workspace: string;
let manifestPath: string;
let stubModeFile: string;

const STUB_CLI = [
  '// Stub installed pd-cli entry (test fixture): answers the two openclaw',
  '// worker probe forms. Behavior is steered by a mode FILE next to this',
  '// stub (the coordinator allowlist env would strip env vars).',
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'const args = process.argv.slice(2);',
  'const mode = (() => { try { return fs.readFileSync(path.join(__dirname, "stub-mode.txt"), "utf8").trim(); } catch { return ""; } })();',
  'const readiness = args.includes("--readiness");',
  'const ws = args[args.indexOf("--workspace") + 1];',
  'if (readiness) {',
  '  if (mode === "readiness-degraded") { console.log(JSON.stringify({ mode: "degraded", workspaceDir: ws, checks: {}, reason: "openclaw_worker_readiness_failed:declaration", nextAction: "fix" })); process.exit(1); }',
  '  console.log(JSON.stringify({ mode: "ready", workspaceDir: ws, checks: { workspaceDirectory: true, ownership: true, declaration: true, evidencePort: true, credentials: true } }));',
  '  process.exit(0);',
  '}',
  'console.log(JSON.stringify({ workspaceDir: ws, mode: "ready", report: { ownership: { state: "service_host_owned", generation: 2, source: "record" }, declaration: { persisted: true, validated: true }, downstream: { ran: false, skipReason: "test_empty" }, diagnostician: { served: false, status: "no_candidate" } } }));',
  'process.exit(0);',
].join('\n');

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-handover-'));
  fs.mkdirSync(path.join(home, '.pd', 'runtime', 'pd-cli', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(home, '.pd', 'install.json'), JSON.stringify({
    layoutVersion: 1,
    mode: 'canonical',
    hosts: ['openclaw'],
    workspaces: [],
  }, null, 2) + '\n', 'utf8');
  // Legal-minimal active release record (the install-layout fixture shape)
  // so the managed coordinator's release validation passes.
  fs.writeFileSync(path.join(home, '.pd', 'active.json'), JSON.stringify({
    schemaVersion: 1,
    generation: 3,
    releaseId: 'rel-2026-11-22-abc',
    releaseMetadataDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    previousReleaseId: null,
    transactionId: 'tx-0001',
    productVersion: '0.9.0',
  }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(home, '.pd', 'runtime', 'pd-cli', 'dist', 'index.js'), STUB_CLI, 'utf8');
  stubModeFile = path.join(home, '.pd', 'runtime', 'pd-cli', 'dist', 'stub-mode.txt');
  // The openclaw DEFAULT workspace dir under this trusted home carries the
  // default host claim — the authorized discovery source for the binding check.
  workspace = path.join(home, '.openclaw', 'workspace');
  fs.mkdirSync(path.join(workspace, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.pd', 'config.yaml'), 'version: 1\n', 'utf8');
  manifestPath = path.join(home, '.pd', 'install.json');
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function env(): Record<string, string | undefined> {
  return { ...process.env, PD_TEST_STUB_MODE_FILE: stubModeFile };
}

function ownership(): ReturnType<typeof readWorkspaceBackgroundOwnership> {
  return readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir: workspace });
}

describe('runWorkspaceHandover — full §8.4 sequence', () => {
  it('completes: preparing → readiness → quiesce ack → CAS → worker cycle → evidence', async () => {
    // The "Gateway" acknowledges for this operation (its start/tick gate
    // writer, same file + binding semantics).
    const beginRecord = { state: 'handover_preparing' as const, generation: 1 };
    expect(writeGatewayQuiesceAck({
      workspaceDir: workspace,
      state: beginRecord.state,
      operationId: 'op-integration-1',
      generation: beginRecord.generation,
      inFlightCycles: 0,
      outcome: 'quiesced',
      startedVia: 'service_start',
    }).ok).toBe(true);

    const result = await runWorkspaceHandover(workspace, {
      pdHomeOverride: home,
      env: env(),
      resumeOperationId: 'op-integration-1',
      ackWaitMs: 5_000,
      stepTimeoutMs: 30_000,
    });
    expect(result).toMatchObject({ ok: true, outcome: 'completed', operationId: 'op-integration-1' });
    if (!result.ok) return;
    // The marker flipped exactly once: gen 0(no record) → preparing(1) → owned(2).
    expect(ownership()).toMatchObject({ status: 'service_host_owned', generation: 2 });
    // The workspace was registered into the manifest in the same atomic write.
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { workspaces: string[] };
    expect(raw.workspaces).toContain(workspace);
    // Evidence is write-once, operationId keyed, and re-readable.
    const evidence = readHandoverEvidence(path.join(home, '.pd'), workspace, 'op-integration-1');
    expect(evidence).toMatchObject({ kind: 'handover', outcome: 'completed' });
    expect(evidence?.steps.map((step) => step.step)).toEqual(
      expect.arrayContaining(['binding_verified', 'begin_handover', 'readiness', 'quiesce_ack', 'cas_flip', 'worker_cycle']),
    );
    expect(result.workerCycle.mode).toBe('ready');
  });

  it('is idempotent per operationId: replaying the same operation converges', async () => {
    writeGatewayQuiesceAck({
      workspaceDir: workspace, state: 'handover_preparing', operationId: 'op-replay-1', generation: 1,
      inFlightCycles: 0, outcome: 'quiesced', startedVia: 'service_start',
    });
    const first = await runWorkspaceHandover(workspace, { pdHomeOverride: home, env: env(), resumeOperationId: 'op-replay-1', ackWaitMs: 5_000, stepTimeoutMs: 30_000 });
    expect(first.ok).toBe(true);
    // Re-run with the SAME operation id: the marker is already the terminal
    // state; the command records it and completes verification-only.
    const second = await runWorkspaceHandover(workspace, { pdHomeOverride: home, env: env(), resumeOperationId: 'op-replay-1', ackWaitMs: 5_000, stepTimeoutMs: 30_000 });
    expect(second.ok).toBe(true);
    expect(ownership()).toMatchObject({ status: 'service_host_owned', generation: 2 });
  });

  it('blocks and restores legacy when the Gateway never acknowledges', async () => {
    const result = await runWorkspaceHandover(workspace, {
      pdHomeOverride: home, env: env(), resumeOperationId: 'op-no-ack-1', ackWaitMs: 150, stepTimeoutMs: 30_000,
    });
    expect(result).toMatchObject({ ok: false, outcome: 'blocked', reason: 'gateway_quiesce_ack_absent' });
    // Fail-closed rollback of the preparing state: the Gateway stays the sole owner.
    expect(ownership()).toMatchObject({ status: 'legacy_owned' });
  });

  it('blocks when the ack exists but is bound to ANOTHER operation', async () => {
    writeGatewayQuiesceAck({
      workspaceDir: workspace, state: 'handover_preparing', operationId: 'op-OTHER', generation: 1,
      inFlightCycles: 0, outcome: 'quiesced', startedVia: 'service_start',
    });
    const result = await runWorkspaceHandover(workspace, {
      pdHomeOverride: home, env: env(), resumeOperationId: 'op-mine-1', ackWaitMs: 150, stepTimeoutMs: 30_000,
    });
    expect(result).toMatchObject({ ok: false, outcome: 'blocked', reason: 'gateway_quiesce_ack_operation_mismatch' });
    expect(ownership()).toMatchObject({ status: 'legacy_owned' });
  }, 30_000);

  it('blocks and restores legacy when readiness fails', async () => {
    fs.writeFileSync(stubModeFile, 'readiness-degraded', 'utf8');
    const result = await runWorkspaceHandover(workspace, {
      pdHomeOverride: home, env: env(), resumeOperationId: 'op-degraded-1', ackWaitMs: 5_000, stepTimeoutMs: 30_000,
    });
    expect(result).toMatchObject({ ok: false, outcome: 'blocked', reason: expect.stringContaining('openclaw_worker_readiness:degraded') });
    expect(ownership()).toMatchObject({ status: 'legacy_owned' });
  });

  it('blocks a workspace without an OpenClaw host claim', async () => {
    const orphan = path.join(home, 'nowhere-near-a-claim');
    fs.mkdirSync(orphan, { recursive: true });
    const result = await runWorkspaceHandover(orphan, { pdHomeOverride: home, env: env(), ackWaitMs: 150 });
    expect(result).toMatchObject({ ok: false, outcome: 'blocked', reason: 'no_openclaw_host_binding' });
  });

  it('abort restores legacy from a stuck preparing state', async () => {
    await runWorkspaceHandover(workspace, { pdHomeOverride: home, env: env(), resumeOperationId: 'op-stuck-1', ackWaitMs: 1 });
    // (blocked, but the preparing record may exist if begin landed before the
    // ack wait — force the stuck state deterministically:)
    const fromTransition = await import('@principles/install-layout');
    fromTransition.transitionWorkspaceBackgroundExecution({
      manifestPath, workspaceDir: workspace, kind: 'begin_handover', operationId: 'op-stuck-2', registerWorkspace: true,
    });
    expect(ownership()).toMatchObject({ status: 'handover_preparing' });
    const aborted = await runWorkspaceHandover(workspace, { pdHomeOverride: home, env: env(), abort: true, resumeOperationId: 'op-stuck-2' });
    expect(aborted).toMatchObject({ ok: false, outcome: 'aborted' });
    expect(ownership()).toMatchObject({ status: 'legacy_owned' });
  });
});

describe('runWorkspaceRollback', () => {
  async function completeHandoverFirst(operationId: string): Promise<void> {
    writeGatewayQuiesceAck({
      workspaceDir: workspace, state: 'handover_preparing', operationId, generation: 1,
      inFlightCycles: 0, outcome: 'quiesced', startedVia: 'service_start',
    });
    await runWorkspaceHandover(workspace, { pdHomeOverride: home, env: env(), resumeOperationId: operationId, ackWaitMs: 5_000, stepTimeoutMs: 30_000 });
    expect(ownership()).toMatchObject({ status: 'service_host_owned' });
  }

  it('rolls back to legacy with monotonic generation and evidence', async () => {
    await completeHandoverFirst('op-before-rollback-1');
    const result = await runWorkspaceRollback(workspace, { pdHomeOverride: home, env: env(), ackWaitMs: 150 });
    expect(result).toMatchObject({ ok: true, outcome: 'completed' });
    if (!result.ok) return;
    expect(result.gatewayResumption).toBe('not_verified_gateway_not_running');
    // handover(1,2) then rollback(3,4): strictly monotonic.
    expect(ownership()).toMatchObject({ status: 'legacy_owned', source: 'record', generation: 4 });
    const evidence = readHandoverEvidence(path.join(home, '.pd'), workspace, result.operationId);
    expect(evidence).toMatchObject({ kind: 'rollback', outcome: 'completed' });
  });

  it('observes the Gateway resumption event when the stream shows it', async () => {
    await completeHandoverFirst('op-resume-obs-1');
    // Simulate the Gateway's ownership-watch resumption log.
    const logsDir = path.join(workspace, 'memory', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, 'SYSTEM_2026-11-22.log'), '[2026-11-22T00:00:00Z] [INTERNALIZATION_CONSUMER_RESUMED] test\n', 'utf8');
    const result = await runWorkspaceRollback(workspace, { pdHomeOverride: home, env: env(), ackWaitMs: 5_000 });
    expect(result).toMatchObject({ ok: true, gatewayResumption: 'observed' });
  });

  it('refuses while a service run-once holds the install lock', async () => {
    await completeHandoverFirst('op-lock-1');
    const { acquireServiceRunLock, releaseServiceRunLock } = await import('../../../src/services/service-host/locking/service-run-lock.js');
    const lock = acquireServiceRunLock(path.join(home, '.pd'));
    expect(lock.ok).toBe(true);
    if (!lock.ok) return;
    try {
      const result = await runWorkspaceRollback(workspace, { pdHomeOverride: home, env: env() });
      expect(result).toMatchObject({ ok: false, outcome: 'blocked', reason: expect.stringContaining('service_run_in_progress') });
      expect(ownership()).toMatchObject({ status: 'service_host_owned' });
    } finally {
      releaseServiceRunLock(lock.handle);
    }
  });

  it('refuses a legacy-owned workspace (nothing to roll back)', async () => {
    const result = await runWorkspaceRollback(workspace, { pdHomeOverride: home, env: env() });
    // Structured refusal either way: an unregistered legacy workspace cannot
    // hold an ownership record (workspace_not_registered); a registered one
    // is simply not service_host_owned (unexpected_state).
    expect(result).toMatchObject({ ok: false, outcome: 'blocked', reason: expect.stringContaining('begin_rollback_failed') });
  });
});

describe('managed dispatch after handover (§8.5 regression)', () => {
  it('a service_host_owned openclaw workspace is EXECUTED by the managed run-once', async () => {
    writeGatewayQuiesceAck({
      workspaceDir: workspace, state: 'handover_preparing', operationId: 'op-managed-1', generation: 1,
      inFlightCycles: 0, outcome: 'quiesced', startedVia: 'service_start',
    });
    await runWorkspaceHandover(workspace, { pdHomeOverride: home, env: env(), resumeOperationId: 'op-managed-1', ackWaitMs: 5_000, stepTimeoutMs: 30_000 });
    expect(ownership()).toMatchObject({ status: 'service_host_owned' });

    const { runServiceManagedOnce } = await import('../../../src/services/service-host/managed-run.js');
    let executed = 0;
    const result = await runServiceManagedOnce({
      env: env(),
      trustedHomeDir: home,
      probes: {
        adapters: {
          openclaw: {
            hostKind: 'openclaw',
            adapterVersion: 'pd.worker-adapter.v1',
            supports: () => ({ supported: true }),
            executeOnce: async () => {
              executed += 1;
              return {
                hostKind: 'openclaw',
                adapterVersion: 'pd.worker-adapter.v1',
                workspaceDir: workspace,
                invocationId: 'test-invocation',
                cycleOutcome: 'cycle_completed_without_business_progress',
                lastProgressAt: null,
                businessProgress: {
                  taskStateChanged: false, changedTaskCount: 0, diagnosticianSucceeded: false,
                  downstreamRan: false, postProcessingResumed: 0, catchUpProcessed: 0,
                  evidenceReadable: false, evidenceReason: 'not_attempted',
                },
                health: {
                  livenessFile: path.join(workspace, '.state', 'openclaw-worker-liveness.json'),
                  livenessRecorded: false, lastCycleDriver: null, lastCycleCompletedAt: null,
                  lastCycleMode: null, runningStage: null, lastInvocationId: null,
                },
                startedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                durationMs: 1,
                worker: {
                  cliEntry: '/stub', cliEntrySource: 'canonical', exitCode: 0, termSignal: null,
                  timedOut: false, cancelled: false, stdoutTruncated: false,
                  environmentReport: { stripped: [], pinnedFromTrustedIdentity: [], passedThrough: [], invocationSource: 'service_host' },
                },
              };
            },
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(executed).toBe(1);
    const record = result.ok ? result.executions.find((entry) => entry.canonicalDir === workspace) : undefined;
    expect(record).toMatchObject({ hostKind: 'openclaw', admission: 'executed' });
  }, 60_000);

  it('SHADOW cannot select openclaw — the compile-time boundary plus the command-level invalid-host gate (Phase 2; runtime refusal covered by the existing service-command suite)', () => {
    // The shadow surfaces type as ShadowHostKind ('codex' | 'workbuddy') —
    // openclaw is structurally absent from every shadow entry point, and the
    // existing service-command tests already pin the `--shadow --host
    // openclaw` CLI refusal. This regression guard pins the CONSTANT the
    // boundary is enforced with.
    expect(WORKER_HOST_KINDS).toEqual(['codex', 'workbuddy']);
    expect(MANAGED_WORKER_HOST_KINDS).toEqual(['codex', 'workbuddy', 'openclaw']);
  });
});
