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
  clearGatewayConsumerLease,
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

// ─── PRI-1282 review round 5 F1/F7: per-workspace identity + multi-writer lease ──
describe('dual-workspace isolation (PRI-1282 r5 F1)', () => {
  let workspaceDirB: string;

  beforeEach(() => {
    workspaceDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ownership-gate-b-'));
    fs.mkdirSync(path.join(workspaceDirB, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDirB, '.pd', 'config.yaml'), [
      'version: 1',
      'features:',
      '  internalization_auto_consumer:',
      '    category: quiet',
      '    enabled: true',
      '',
    ].join('\n'));
  });

  afterEach(() => {
    fs.rmSync(workspaceDirB, { recursive: true, force: true });
  });

  const ctxFor = (dir: string): never => ({
    config: undefined,
    workspaceDir: dir,
    stateDir: path.join(dir, '.state'),
    logger,
  } as never);

  it('starting workspace B does not clobber workspace A: both keep cycling and release their leases independently', async () => {
    InternalizationAutoConsumerService.start(ctxFor(workspaceDir));
    InternalizationAutoConsumerService.start(ctxFor(workspaceDirB));

    const idA = __autoConsumerTestSeams.identity(workspaceDir);
    const idB = __autoConsumerTestSeams.identity(workspaceDirB);
    expect(idA.instanceId).not.toBe(idB.instanceId);

    // Both run their cycle and renew their OWN lease.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.mocked(runInternalizationConsumerCycle)).toHaveBeenCalled();
    expect(readGatewayConsumerLease(workspaceDir)).toMatchObject({
      token: idA.token, instanceId: idA.instanceId, state: 'consuming',
    });
    expect(readGatewayConsumerLease(workspaceDirB)).toMatchObject({
      token: idB.token, instanceId: idB.instanceId, state: 'consuming',
    });
    // A's lease is NOT foreign to A: A keeps cycling after B started.
    expect(foreignConsumerLeaseStatus(workspaceDir, {
      selfToken: idA.token, selfInstanceId: idA.instanceId,
    })).toBe('none');

    // Independent release: stopping A clears ONLY A's lease.
    InternalizationAutoConsumerService.stop(ctxFor(workspaceDir));
    expect(readGatewayConsumerLease(workspaceDir)).toBeNull();
    expect(readGatewayConsumerLease(workspaceDirB)).toMatchObject({ instanceId: idB.instanceId });

    // B still cycles; its writer entry is untouched.
    vi.mocked(runInternalizationConsumerCycle).mockClear();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(vi.mocked(runInternalizationConsumerCycle)).toHaveBeenCalled();
  });
});

describe('multi-writer consumer lease (PRI-1282 r5 F7)', () => {
  const LEASE_FILE = () => path.join(workspaceDir, '.pd', 'gateway-consumer-lease.json');

  it('every writer is recorded: a quiesced writer + a still-consuming writer reports alive', () => {
    const base = {
      workspaceDir,
      pid: process.pid,
      host: os.hostname(),
      startedAt: '2026-11-23T00:00:00.000Z',
      updatedAt: '2026-11-23T00:00:00.000Z',
    };
    // Gateway A writes quiesced, then Gateway B writes consuming — BOTH
    // writer entries must be retained; the old single-record shape dropped A.
    writeGatewayConsumerLease({ ...base, token: 'tok-a', instanceId: 'gw-a', state: 'quiesced' });
    writeGatewayConsumerLease({ ...base, token: 'tok-b', instanceId: 'gw-b', state: 'consuming' });

    const lease = readGatewayConsumerLease(workspaceDir);
    expect(lease?.writers).toHaveLength(2);
    expect(foreignConsumerLeaseStatus(workspaceDir)).toBe('alive');
  });

  it('clearing removes only the matching writer; the lease survives while another writer is live', () => {
    const base = {
      workspaceDir,
      pid: process.pid,
      host: os.hostname(),
      startedAt: '2026-11-23T00:00:00.000Z',
      updatedAt: '2026-11-23T00:00:00.000Z',
    };
    writeGatewayConsumerLease({ ...base, token: 'tok-a', instanceId: 'gw-a', state: 'consuming' });
    writeGatewayConsumerLease({ ...base, token: 'tok-b', instanceId: 'gw-b', state: 'consuming' });

    clearGatewayConsumerLease(workspaceDir, 'tok-a', 'gw-a');
    const lease = readGatewayConsumerLease(workspaceDir);
    expect(lease?.writers).toHaveLength(1);
    expect(lease?.writers?.[0]).toMatchObject({ instanceId: 'gw-b' });
    expect(lease?.instanceId).toBe('gw-b');
    expect(fs.existsSync(LEASE_FILE())).toBe(true);

    // Clearing the last writer unlinks the record entirely.
    clearGatewayConsumerLease(workspaceDir, 'tok-b', 'gw-b');
    expect(fs.existsSync(LEASE_FILE())).toBe(false);
  });
});

// ─── PRI-1282 r5 F7: two REAL processes — one quiesced, one still consuming ──
describe('cross-process lease visibility (PRI-1282 r5 F7)', () => {
  it('a real foreign process holding a consuming lease is judged alive; after it exits its PID evidence goes dead', async () => {
    vi.useRealTimers(); // real child-process + real time for this one
    const { spawn } = await import('node:child_process');
    const readyFile = path.join(workspaceDir, '.pd', 'child-ready');
    // Child: register as a consuming writer on the REAL lease file, signal
    // readiness, then keep running until the parent kills it.
    const childScript = `
      const fs = require('node:fs');
      const os = require('node:os');
      const lease = ${JSON.stringify(path.join(workspaceDir, '.pd', 'gateway-consumer-lease.json'))};
      const record = {
        schemaVersion: 'pd.gateway-consumer-lease.v1',
        token: 'child-token', instanceId: 'child-instance',
        pid: process.pid, host: os.hostname(),
        workspaceDir: ${JSON.stringify(workspaceDir)},
        state: 'consuming',
        startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        writers: [{
          token: 'child-token', instanceId: 'child-instance',
          pid: process.pid, host: os.hostname(), state: 'consuming',
          startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }],
      };
      fs.writeFileSync(lease, JSON.stringify(record));
      fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['-e', childScript], { stdio: 'ignore' });
    try {
      // Deterministic wait: the child creates readyFile only after the lease lands.
      for (let i = 0; i < 100 && !fs.existsSync(readyFile); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(fs.existsSync(readyFile)).toBe(true);
      expect(foreignConsumerLeaseStatus(workspaceDir)).toBe('alive');
    } finally {
      child.kill('SIGKILL');
    }
    // Deterministic wait for the child's death to be observable.
    for (let i = 0; i < 100; i += 1) {
      try { process.kill(child.pid!, 0); await new Promise((r) => setTimeout(r, 50)); }
      catch { break; }
    }
    expect(foreignConsumerLeaseStatus(workspaceDir)).toBe('none');
    vi.useFakeTimers();
  }, 20_000);
});

// ─── PRI-1282 r6: split drain-mark vs workspace-ack + serialized registration ─
describe('dual-Gateway quiesce progress (PRI-1282 r6)', () => {
  it('a live foreign consumer does not prevent OUR lease record from being marked quiesced (ack still withheld)', async () => {
    ownership(preparingRecord('op-split-drain', 3));
    // A parseable foreign record (r5 schema, different instance) held by
    // THIS test process's PID → 'alive' per pid-liveness.
    writeGatewayConsumerLease({
      workspaceDir, token: 'foreign-tok', instanceId: 'foreign-inst', state: 'consuming',
    });
    startService();
    await vi.advanceTimersByTimeAsync(0);
    // No workspace-level ack while the foreign writer is active...
    expect(readGatewayQuiesceAck(workspaceDir)).toBeNull();
    // ...but OUR writer record was still transitioned to 'quiesced' —
    // the drain mark is decoupled from the global claim so a second
    // Gateway is never blocked waiting on it.
    const lease = readGatewayConsumerLease(workspaceDir);
    const ours = lease?.writers?.find((w) => w.instanceId === __autoConsumerTestSeams.identity(workspaceDir).instanceId);
    expect(ours?.state).toBe('quiesced');
    expect(lease?.writers?.find((w) => w.instanceId === 'foreign-inst')?.state).toBe('consuming');
  });
});

describe('cross-process lease registration (PRI-1282 r6)', () => {
  it('two real processes serialize check+register: the second is refused while the first consumes, and takes over after the first drains', async () => {
    vi.useRealTimers();
    const { spawn, execFileSync } = await import('node:child_process');
    const bundlePath = path.join(process.cwd(), 'tests', '.tmp-lease-bundle-r6.cjs');
    execFileSync('npx', ['esbuild', 'src/service/gateway-consumer-lease.ts',
      '--bundle', '--format=cjs', '--platform=node', '--external:better-sqlite3',
      `--outfile=${bundlePath}`], { stdio: 'pipe' });
    const marker = (name: string) => path.join(workspaceDir, '.pd', `child-${name}`);
    const childScript = `
      const fs = require('node:fs');
      const path = require('node:path');
      const lease = require(${JSON.stringify(bundlePath)});
      const ws = ${JSON.stringify(workspaceDir)};
      const id = process.env.ROLE;
      const reg = lease.registerGatewayConsumerLease({ workspaceDir: ws, token: 'tok-' + id, instanceId: 'inst-' + id });
      fs.writeFileSync(path.join(ws, '.pd', 'child-reg-' + id + '.json'), JSON.stringify(reg));
      // Then idle until the parent signals drain: mark our record 'quiesced'.
      const timer = setInterval(() => {
        if (fs.existsSync(path.join(ws, '.pd', 'drain-' + id))) {
          lease.writeGatewayConsumerLease({ workspaceDir: ws, token: 'tok-' + id, instanceId: 'inst-' + id, state: 'quiesced' });
          fs.writeFileSync(path.join(ws, '.pd', 'child-drained-' + id), 'done');
          clearInterval(timer);
          process.exit(0);
        }
      }, 25);
      timer.unref();
      setInterval(() => {}, 1000); // keep alive for liveness evidence
    `;
    const spawnChild = (role: string) => spawn(process.execPath, ['-e', childScript], {
      stdio: 'ignore', env: { ...process.env, ROLE: role },
    });
    const waitFile = async (p: string, tries = 200): Promise<boolean> => {
      for (let i = 0; i < tries && !fs.existsSync(p); i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      return fs.existsSync(p);
    };
    const a = spawnChild('a');
    try {
      expect(await waitFile(marker('reg-a.json'))).toBe(true);
      const b = spawnChild('b');
      try {
        expect(await waitFile(marker('reg-b.json'))).toBe(true);
        const regA = JSON.parse(fs.readFileSync(marker('reg-a.json'), 'utf8'));
        const regB = JSON.parse(fs.readFileSync(marker('reg-b.json'), 'utf8'));
        // Exactly one may hold the consuming role.
        expect(regA).toMatchObject({ ok: true, status: 'registered' });
        expect(regB).toMatchObject({ ok: true, status: 'refused_foreign_alive' });
        expect(foreignConsumerLeaseStatus(workspaceDir, { selfInstanceId: 'inst-b' })).toBe('alive');

        // A drains: marks its OWN record quiesced, then exits.
        fs.writeFileSync(path.join(workspaceDir, '.pd', 'drain-a'), 'go');
        expect(await waitFile(path.join(workspaceDir, '.pd', 'child-drained-a'))).toBe(true);

        // The lease keeps BOTH records: a quiesced + nothing active.
        const lease = readGatewayConsumerLease(workspaceDir);
        expect(lease?.writers?.find((w) => w.instanceId === 'inst-a')?.state).toBe('quiesced');
        expect(foreignConsumerLeaseStatus(workspaceDir, { selfInstanceId: 'inst-b' })).toBe('none');

        // A third Gateway lifecycle now registers — take-over after A's drain.
        const b2 = spawnChild('b2');
        try {
          expect(await waitFile(marker('reg-b2.json'))).toBe(true);
          const reg = JSON.parse(fs.readFileSync(marker('reg-b2.json'), 'utf8'));
          expect(reg).toMatchObject({ ok: true, status: 'registered' });
        } finally {
          b2.kill('SIGKILL');
        }
      } finally {
        b.kill('SIGKILL');
      }
    } finally {
      a.kill('SIGKILL');
      try { fs.unlinkSync(bundlePath); } catch { /* best effort */ }
    }
    vi.useFakeTimers();
  }, 40_000);
});

describe('gated lease mutations (PRI-1282 r7)', () => {
  it('write and clear serialize on the arbitration gate — a parked transaction refuses them instead of silently overwriting', async () => {
    vi.useRealTimers();
    const { default: Database } = await import('better-sqlite3');
    const gatePath = path.join(workspaceDir, '.pd', 'gateway-consumer-lease.json.gate.db');
    const holder = new Database(gatePath);
    holder.exec('PRAGMA busy_timeout = 250');
    holder.exec('BEGIN IMMEDIATE');
    try {
      const write = writeGatewayConsumerLease({ workspaceDir, token: 'tok', instanceId: 'inst', state: 'consuming' });
      expect(write).toMatchObject({ ok: false });
      if (!write.ok) expect(write.reason).toContain('consumer lease gate');
      // clear is a read→filter→replace of the same file — same gate class.
      expect(() => clearGatewayConsumerLease(workspaceDir, 'tok', 'inst')).not.toThrow();
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    // Gate released → the write goes through.
    expect(writeGatewayConsumerLease({ workspaceDir, token: 'tok', instanceId: 'inst', state: 'consuming' })).toEqual({ ok: true });
    vi.useFakeTimers();
  });
});
