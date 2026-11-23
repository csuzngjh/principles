/**
 * PRI-1282 Phase 4 — §8.4 ownership gate + quiesce protocol for the
 * InternalizationAutoConsumerService.
 *
 * These tests pin the SAFETY invariants of the Gateway-side migration:
 *  - the marker is read before the service arms a chain and before EVERY
 *    tick; non-legacy_owned states (and an UNREADABLE manifest) fail closed;
 *  - a blocking observation parks the ONE timer slot, awaits the in-flight
    * cycle (bounded) and persists the pd.gateway-quiesce.v1 acknowledgment
 *    bound to the marker's operationId + generation;
 *  - the parked slot watches slowly and RE-ARMS normal consumption when the
 *    marker returns to legacy_owned (rollback without a Gateway restart);
 *  - no new consumption cycle ever starts while blocked.
 *
 * The ownership projection is mocked at its seam (`readOpenClawWorkspaceOwnership`)
 * because its real chain (manifest parse → canonicalization) has its own
 * install-layout suite; the ack WRITER runs against real files.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InternalizationAutoConsumerService } from '../../src/service/internalization-auto-consumer-service.js';
import { readGatewayQuiesceAck } from '../../src/service/gateway-quiesce-ack.js';
import { SystemLogger } from '../../src/core/system-logger.js';
import { loadFeatureFlagFromConfig } from '../../src/core/pd-config-loader.js';
import { runInternalizationConsumerCycle, runPendingDiagnosticianOnce, saveHostToolDeclaration } from '@principles/host-runtime';
import { readOpenClawWorkspaceOwnership } from '../../src/openclaw-worker.js';
import type { WorkspaceBackgroundOwnership } from '@principles/install-layout';

vi.mock('../../src/core/pd-config-loader.js');
vi.mock('../../src/core/system-logger.js');
vi.mock('../../src/openclaw-worker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/openclaw-worker.js')>();
  return {
    ...actual,
    readOpenClawWorkspaceOwnership: vi.fn(),
  };
});
vi.mock('@principles/host-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@principles/host-runtime')>();
  return {
    ...actual,
    runInternalizationConsumerCycle: vi.fn(async () => ({ ran: false, skipReason: 'test-empty' })),
    runPendingDiagnosticianOnce: vi.fn(async () => ({ served: false, reason: 'no_candidate' as const })),
    saveHostToolDeclaration: vi.fn(() => ({ ok: true })),
  };
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let workspaceDir: string;

function ownership(value: WorkspaceBackgroundOwnership): void {
  vi.mocked(readOpenClawWorkspaceOwnership).mockReturnValue(value);
}

function preparingRecord(operationId: string, generation: number): WorkspaceBackgroundOwnership {
  return {
    status: 'handover_preparing',
    generation,
    record: {
      state: 'handover_preparing',
      effectiveOwner: 'legacy',
      generation,
      operationId,
      previousOwner: 'legacy',
      targetOwner: 'service_host',
      updatedAt: '2026-11-22T00:00:00.000Z',
    },
  };
}

const LEGACY: WorkspaceBackgroundOwnership = { status: 'legacy_owned', source: 'no_record', generation: 0 };
const SERVICE_HOST_OWNED: WorkspaceBackgroundOwnership = {
  status: 'service_host_owned',
  generation: 2,
  record: {
    state: 'service_host_owned',
    effectiveOwner: 'service_host',
    generation: 2,
    operationId: null,
    previousOwner: null,
    targetOwner: null,
    updatedAt: '2026-11-22T00:00:00.000Z',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ownership-gate-'));
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), [
    'version: 1',
    'features:',
    '  internalization_auto_consumer:',
    '    category: quiet',
    '    enabled: true',
    '',
  ].join('\n'));
  vi.mocked(loadFeatureFlagFromConfig).mockReturnValue({ enabled: true, source: 'test' } as never);
  ownership(LEGACY);
});

afterEach(() => {
  InternalizationAutoConsumerService.stop({});
  vi.useRealTimers();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

function systemLogEvents(): string[] {
  return vi.mocked(SystemLogger.log).mock.calls.map((call) => call[1]);
}

function startService(): void {
  InternalizationAutoConsumerService.start({
    config: undefined,
    workspaceDir,
    stateDir: path.join(workspaceDir, '.state'),
    logger,
  } as never);
}

describe('service-start ownership gate', () => {
  it('arms the normal adaptive chain when the marker is legacy', () => {
    startService();
    expect(systemLogEvents()).toContain('INTERNALIZATION_CONSUMER_STARTED');
    expect(systemLogEvents()).not.toContain('INTERNALIZATION_CONSUMER_OWNERSHIP_BLOCKED');
  });

  it('refuses to arm and writes a quiesce ack when the marker is handover_preparing', async () => {
    ownership(preparingRecord('op-gate-1', 3));
    startService();
    expect(systemLogEvents()).not.toContain('INTERNALIZATION_CONSUMER_STARTED');
    expect(systemLogEvents()).toContain('INTERNALIZATION_CONSUMER_OWNERSHIP_BLOCKED');
    await vi.advanceTimersByTimeAsync(0);
    const ack = readGatewayQuiesceAck(workspaceDir);
    expect(ack).toMatchObject({
      state: 'handover_preparing',
      operationId: 'op-gate-1',
      generation: 3,
      inFlightCycles: 0,
      outcome: 'quiesced',
      writer: { startedVia: 'service_start' },
    });
    // No consumption cycle may run for this workspace.
    expect(runInternalizationConsumerCycle).not.toHaveBeenCalled();
  });

  it('refuses to arm on service_host_owned (handover already completed) with an ack', async () => {
    ownership(SERVICE_HOST_OWNED);
    startService();
    await vi.advanceTimersByTimeAsync(0);
    expect(systemLogEvents()).toContain('INTERNALIZATION_CONSUMER_OWNERSHIP_BLOCKED');
    expect(readGatewayQuiesceAck(workspaceDir)).toMatchObject({ state: 'service_host_owned', generation: 2 });
    expect(runInternalizationConsumerCycle).not.toHaveBeenCalled();
  });

  it('fails closed on an unreadable manifest and writes NO ack (nothing to bind)', async () => {
    ownership({ status: 'manifest_unreadable', reason: 'install_manifest_missing', nextAction: 'restore' });
    startService();
    await vi.advanceTimersByTimeAsync(0);
    expect(systemLogEvents()).toContain('INTERNALIZATION_CONSUMER_OWNERSHIP_BLOCKED');
    expect(readGatewayQuiesceAck(workspaceDir)).toBeNull();
    expect(runInternalizationConsumerCycle).not.toHaveBeenCalled();
  });
});

describe('per-tick ownership gate + quiesce', () => {
  it('runs a cycle on the first tick when legacy, then quiesces when the marker flips to handover_preparing', async () => {
    startService();
    await vi.advanceTimersByTimeAsync(30_000); // INITIAL_DELAY fires runCycle #1
    expect(runInternalizationConsumerCycle).toHaveBeenCalledTimes(1);
    // The marker flips between ticks (a handover command ran).
    ownership(preparingRecord('op-tick-1', 1));
    await vi.advanceTimersByTimeAsync(600_000); // next adaptive tick (idle 120s max)
    // The blocked tick started NO new cycle and quiesced with an ack.
    expect(runInternalizationConsumerCycle).toHaveBeenCalledTimes(1);
    const ack = readGatewayQuiesceAck(workspaceDir);
    expect(ack).toMatchObject({ state: 'handover_preparing', operationId: 'op-tick-1', generation: 1, outcome: 'quiesced' });
  });

  it('parks and acks IMMEDIATELY at cycle end when the marker flipped DURING the cycle', async () => {
    // The handover opens while cycle #1 is running; the post-cycle gate (not
    // a future tick) must observe it, park the chain and write the ack with
    // in-flight = 0 — the cycle has legitimately finished.
    vi.mocked(runInternalizationConsumerCycle).mockImplementationOnce(async () => {
      ownership(preparingRecord('op-during-1', 2));
      return { ran: false, skipReason: 'empty' };
    });
    startService();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runInternalizationConsumerCycle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    const ack = readGatewayQuiesceAck(workspaceDir);
    expect(ack).toMatchObject({ state: 'handover_preparing', operationId: 'op-during-1', generation: 2, inFlightCycles: 0, outcome: 'quiesced' });
    // No further cycles: the chain is parked, not rescheduled.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(runInternalizationConsumerCycle).toHaveBeenCalledTimes(1);
  });

  it('a HUNG cycle cannot ack — the handover fails closed on ack absence (honest contract)', async () => {
    vi.mocked(runInternalizationConsumerCycle).mockImplementationOnce(async () => {
      await new Promise<void>(() => undefined); // never settles
      return { ran: false, skipReason: 'stuck' };
    });
    startService();
    await vi.advanceTimersByTimeAsync(30_000);
    ownership(preparingRecord('op-hung-1', 4));
    // The chain is wedged inside the hung await: no post-cycle gate, no tick,
    // no ack. The Gateway cannot prove it stopped — so it does NOT claim to.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(readGatewayQuiesceAck(workspaceDir)).toBeNull();
    expect(runInternalizationConsumerCycle).toHaveBeenCalledTimes(1);
  });
});

describe('ownership watch (rollback resume + fresh operation ack)', () => {
  it('re-arms normal consumption when the marker returns to legacy_owned', async () => {
    ownership(preparingRecord('op-resume-1', 1));
    startService();
    await vi.advanceTimersByTimeAsync(0);
    expect(systemLogEvents()).toContain('INTERNALIZATION_CONSUMER_OWNERSHIP_BLOCKED');
    // Rollback completes: the watch's next slow tick sees legacy again.
    ownership(LEGACY);
    await vi.advanceTimersByTimeAsync(30_000); // OWNERSHIP_WATCH_INTERVAL
    expect(systemLogEvents()).toContain('INTERNALIZATION_CONSUMER_RESUMED');
    expect(systemLogEvents()).toContain('INTERNALIZATION_CONSUMER_STARTED');
    // The resumed chain actually consumes again after its initial delay.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runInternalizationConsumerCycle).toHaveBeenCalled();
  });

  it('acks a NEW operation identity while watching, without consuming', async () => {
    ownership(preparingRecord('op-watch-1', 5));
    startService();
    await vi.advanceTimersByTimeAsync(0);
    // The first handover aborted and a second one started (same state, new op/gen).
    ownership(preparingRecord('op-watch-2', 7));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(readGatewayQuiesceAck(workspaceDir)).toMatchObject({ operationId: 'op-watch-2', generation: 7 });
    expect(runInternalizationConsumerCycle).not.toHaveBeenCalled();
  });
});

describe('stop semantics are unchanged for other workspaces', () => {
  it('stopping one workspace leaves another workspace chain armed', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ownership-gate-b-'));
    try {
      fs.mkdirSync(path.join(other, '.pd'), { recursive: true });
      fs.writeFileSync(path.join(other, '.pd', 'config.yaml'), fs.readFileSync(path.join(workspaceDir, '.pd', 'config.yaml')));
      InternalizationAutoConsumerService.start({ config: undefined, workspaceDir: other, stateDir: path.join(other, '.state'), logger } as never);
      startService();
      InternalizationAutoConsumerService.stop({ workspaceDir: other } as never);
      // The remaining workspace still ticks.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(runInternalizationConsumerCycle).toHaveBeenCalledTimes(1);
      expect(systemLogEvents()).toContain('INTERNALIZATION_CONSUMER_STARTED');
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('consumer lease arbitration (PRI-1282 P1-3)', () => {
  // A lease written by ANOTHER (live) pid — simulated with the test runner's
  // parent process so PID liveness stays real (no probe mocks).
  function foreignLeaseFile(): void {
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'gateway-consumer-lease.json'), JSON.stringify({
      schemaVersion: 'pd.gateway-consumer-lease.v1',
      token: 'foreign-token', pid: process.ppid ?? 1, host: os.hostname(),
      workspaceDir, state: 'consuming',
      startedAt: '2026-11-23T00:00:00.000Z', updatedAt: '2026-11-23T00:00:00.000Z',
    }), 'utf8');
  }

  it('a live FOREIGN consumer lease suppresses the quiesced ack — this process stopping proves nothing about the OTHER consumer', async () => {
    ownership(preparingRecord('op-foreign-1', 3));
    foreignLeaseFile();
    startService();
    await vi.advanceTimersByTimeAsync(0);
    expect(systemLogEvents()).toContain('INTERNALIZATION_CONSUMER_OWNERSHIP_BLOCKED');
    expect(readGatewayQuiesceAck(workspaceDir)).toBeNull();
    expect(runInternalizationConsumerCycle).not.toHaveBeenCalled();
  });

  it('a live FOREIGN consumer lease keeps the parked consumer parked when ownership returns to legacy_owned', async () => {
    ownership(preparingRecord('op-foreign-2', 3));
    startService();
    await vi.advanceTimersByTimeAsync(0);
    expect(readGatewayQuiesceAck(workspaceDir)).not.toBeNull();
    // A sibling Gateway now holds the workspace; rollback completed meanwhile.
    foreignLeaseFile();
    ownership(LEGACY);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(systemLogEvents()).not.toContain('INTERNALIZATION_CONSUMER_RESUMED');
    expect(runInternalizationConsumerCycle).not.toHaveBeenCalled();
  });
});

// ─── PRI-1282 review round 4 §3: consumer INSTANCE lifecycle ────────────────
import {
  __autoConsumerTestSeams,
} from '../../src/service/internalization-auto-consumer-service.js';
import {
  foreignConsumerLeaseStatus,
  readGatewayConsumerLease,
  writeGatewayConsumerLease,
} from '../../src/service/gateway-consumer-lease.js';

describe('consumer instance lifecycle (PRI-1282 r4 §3)', () => {
  const LEASE_FILE = () => path.join(workspaceDir, '.pd', 'gateway-consumer-lease.json');

  /** A lease owned by a DIFFERENT instance — optionally same pid. */
  function foreignInstanceLease(pid: number, instanceId = 'other-instance'): void {
    fs.writeFileSync(LEASE_FILE(), JSON.stringify({
      schemaVersion: 'pd.gateway-consumer-lease.v1',
      token: 'foreign-token',
      instanceId,
      pid,
      host: os.hostname(),
      workspaceDir,
      state: 'consuming',
      startedAt: '2026-11-23T00:00:00.000Z',
      updatedAt: '2026-11-23T00:00:00.000Z',
    }), 'utf8');
  }

  it('same PID but a different instanceId is a DIFFERENT consumer (alive); our own identity is not foreign', () => {
    foreignInstanceLease(process.pid, 'old-instance');
    expect(foreignConsumerLeaseStatus(workspaceDir)).toBe('alive');
    expect(
      foreignConsumerLeaseStatus(workspaceDir, { selfInstanceId: 'old-instance' }),
    ).toBe('none');
    expect(
      foreignConsumerLeaseStatus(workspaceDir, { selfToken: 'foreign-token' }),
    ).toBe('none');
    // A different instance of this process is still foreign to us.
    expect(
      foreignConsumerLeaseStatus(workspaceDir, { selfInstanceId: 'brand-new' }),
    ).toBe('alive');
  });

  it('start() refuses to consume while a live foreign INSTANCE holds the lease — same PID, different instance', () => {
    foreignInstanceLease(process.pid, 'older-instance');
    startService();
    expect(systemLogEvents()).toContain('INTERNALIZATION_CONSUMER_START_REFUSED');
    expect(systemLogEvents()).not.toContain('INTERNALIZATION_CONSUMER_STARTED');
    expect(runInternalizationConsumerCycle).not.toHaveBeenCalled();
    // The foreign lease was NOT overwritten or removed.
    expect(readGatewayConsumerLease(workspaceDir)).toMatchObject({
      token: 'foreign-token',
      instanceId: 'older-instance',
    });
  });

  it('start() refuses to consume while a foreign-PID live lease exists (Gateway restart while old consumer alive)', () => {
    foreignInstanceLease(process.ppid ?? 1, 'sibling-gateway');
    startService();
    expect(systemLogEvents()).toContain('INTERNALIZATION_CONSUMER_START_REFUSED');
    expect(systemLogEvents()).not.toContain('INTERNALIZATION_CONSUMER_STARTED');
    expect(runInternalizationConsumerCycle).not.toHaveBeenCalled();
  });

  it('start() refuses when the lease cannot be published (no unprotected consumption)', () => {
    fs.rmSync(path.join(workspaceDir, '.pd'), { recursive: true, force: true });
    fs.writeFileSync(path.join(workspaceDir, '.pd'), 'not a directory', 'utf8');
    startService();
    expect(systemLogEvents()).toContain('INTERNALIZATION_CONSUMER_START_REFUSED');
    expect(systemLogEvents()).not.toContain('INTERNALIZATION_CONSUMER_STARTED');
    expect(runInternalizationConsumerCycle).not.toHaveBeenCalled();
  });

  it('stop() holds the lease while a cycle is in-flight and releases it only after the cycle settles', async () => {
    startService();
    let settle!: () => void;
    const inFlight = new Promise<void>((resolve) => { settle = resolve; });
    __autoConsumerTestSeams.injectInFlight(workspaceDir, inFlight);
    __autoConsumerTestSeams.setStopDrainWaitMs(5_000);
    InternalizationAutoConsumerService.stop({ workspaceDir } as never);
    await vi.advanceTimersByTimeAsync(0);
    // Lease retained while the in-flight cycle may still be running.
    expect(fs.existsSync(LEASE_FILE())).toBe(true);
    settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(fs.existsSync(LEASE_FILE())).toBe(false);
  });

  it('stop() drain timeout keeps the protective lease and records an observable timeout — no silent exit', async () => {
    startService();
    __autoConsumerTestSeams.injectInFlight(workspaceDir, new Promise<void>(() => { /* never */ }));
    __autoConsumerTestSeams.setStopDrainWaitMs(50);
    InternalizationAutoConsumerService.stop({ workspaceDir } as never);
    await vi.advanceTimersByTimeAsync(60);
    expect(systemLogEvents()).toContain('INTERNALIZATION_CONSUMER_STOP_DRAIN_TIMEOUT');
    expect(fs.existsSync(LEASE_FILE())).toBe(true); // protective lease retained
    __autoConsumerTestSeams.setStopDrainWaitMs(30_000);
  });

  it('stop() does not delete a successor instance\'s lease (token + instanceId gated)', async () => {
    startService();
    __autoConsumerTestSeams.setStopDrainWaitMs(5_000);
    // A successor instance claimed the lease before our stop ran.
    const successor = writeGatewayConsumerLease({
      workspaceDir,
      token: 'successor-token',
      instanceId: 'successor-instance',
      state: 'consuming',
    });
    expect(successor.ok).toBe(true);
    InternalizationAutoConsumerService.stop({ workspaceDir } as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(readGatewayConsumerLease(workspaceDir)).toMatchObject({
      token: 'successor-token',
      instanceId: 'successor-instance',
    });
  });

  it('the quiesced ack requires the lease lifecycle to end first — an unwritable lease means NO ack', async () => {
    ownership(preparingRecord('op-leasefail', 3));
    // Start, then break .pd writability so the lease 'quiesced' transition fails.
    fs.rmSync(path.join(workspaceDir, '.pd', 'gateway-quiesce-ack.json'), { force: true });
    startService();
    fs.rmSync(path.join(workspaceDir, '.pd'), { recursive: true, force: true });
    fs.writeFileSync(path.join(workspaceDir, '.pd'), 'not a directory', 'utf8');
    await vi.advanceTimersByTimeAsync(0);
    expect(readGatewayQuiesceAck(workspaceDir)).toBeNull();
  });
});
