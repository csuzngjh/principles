/**
 * PRI-1278 Phase 5 — consumer-safety substrate regression tests.
 *
 * Proves the ownership gate + per-cycle run mutex behavior of the Codex and
 * WorkBuddy worker commands across the three drivers (manual / companion /
 * service_host):
 *
 *   - legacy drivers never consume once ownership leaves `legacy_owned`
 *     (handover_preparing / rollback_pending / service_host_owned);
 *   - the Service-Host driver consumes legacy_owned (designed shadow
 *     convergence) and service_host_owned, never a mid-transition state;
 *   - an unreadable owner marker fails closed (degraded) for every driver;
 *   - the per-workspace run mutex blocks overlapping consumers and is held
 *     only for the single cycle;
 *   - the adapter cycle is never invoked on a blocked path (no consumption).
 *
 * Red evidence: against the pre-fix commands (no gate wiring) every
 * blocked-path test fails because the consuming cycle runs unconditionally.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@principles/codex-adapter', async (importOriginal) => {
  const original = await importOriginal<typeof import('@principles/codex-adapter')>();
  return {
    ...original,
    runCodexWorkspaceWorkerCycle: vi.fn(async (args: { workspaceDir: string }) => ({
      workspaceDir: args.workspaceDir,
      mode: 'ready',
    })),
  };
});

vi.mock('@principles/workbuddy-adapter', async (importOriginal) => {
  const original = await importOriginal<typeof import('@principles/workbuddy-adapter')>();
  return {
    ...original,
    runWorkbuddyWorkspaceWorkerCycle: vi.fn(async (args: { workspaceDir: string }) => ({
      workspaceDir: args.workspaceDir,
      mode: 'ready',
    })),
  };
});

import { runCodexWorkspaceWorkerCycle } from '@principles/codex-adapter';
import { runWorkbuddyWorkspaceWorkerCycle } from '@principles/workbuddy-adapter';
import { handleCodexWorker } from '../../src/commands/codex-worker.js';
import { handleWorkbuddyWorker } from '../../src/commands/workbuddy-worker.js';
import { beginWorkerConsumptionCycle, endWorkerConsumptionCycle } from '../../src/services/service-host/worker-consumption-gate.js';

const codexCycle = vi.mocked(runCodexWorkspaceWorkerCycle);
const workbuddyCycle = vi.mocked(runWorkbuddyWorkspaceWorkerCycle);

let tmpRoot: string;
let pdHome: string;
let workspace: string;
let logs: string[];
let errors: string[];
let savedPdHomeEnv: string | undefined;
let savedInvocationSource: string | undefined;

function seedManifest(state?: string): void {
  fs.mkdirSync(pdHome, { recursive: true });
  const payload: Record<string, unknown> = {
    layoutVersion: 1,
    mode: 'canonical',
    hosts: ['codex'],
    workspaces: [workspace],
  };
  if (state !== undefined) {
    // The legal state/effectiveOwner/previousOwner/targetOwner/operationId
    // combinations are part of the ownership contract (SPEC §8.4) — an
    // illegal combination is structural damage and fails closed at parse.
    const record = state === 'handover_preparing'
      ? { state, effectiveOwner: 'legacy', generation: 3, operationId: 'op-test', previousOwner: 'legacy', targetOwner: 'service_host', updatedAt: '2026-11-27T00:00:00.000Z' }
      : state === 'rollback_pending'
        ? { state, effectiveOwner: 'service_host', generation: 3, operationId: 'op-test', previousOwner: 'service_host', targetOwner: 'legacy', updatedAt: '2026-11-27T00:00:00.000Z' }
        : { state, effectiveOwner: 'service_host', generation: 3, operationId: null, previousOwner: null, targetOwner: null, updatedAt: '2026-11-27T00:00:00.000Z' };
    payload.backgroundExecutions = { [workspace]: record };
  }
  fs.writeFileSync(path.join(pdHome, 'install.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function setDriver(driver: 'manual' | 'companion' | 'service_host'): void {
  if (driver === 'manual') {
    delete process.env.PD_INVOCATION_SOURCE;
  } else {
    process.env.PD_INVOCATION_SOURCE = driver;
  }
}

function firstJson(): Record<string, unknown> {
  const line = logs.find((entry) => entry.startsWith('{'));
  expect(line, 'expected exactly one JSON document on stdout').toBeDefined();
  return JSON.parse(line ?? '{}') as Record<string, unknown>;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-p2-gate-'));
  pdHome = path.join(tmpRoot, 'pdhome');
  workspace = path.join(tmpRoot, 'ws-alpha');
  fs.mkdirSync(workspace, { recursive: true });
  logs = [];
  errors = [];
  savedPdHomeEnv = process.env.PD_SERVICE_PD_HOME;
  savedInvocationSource = process.env.PD_INVOCATION_SOURCE;
  process.env.PD_SERVICE_PD_HOME = pdHome;
  delete process.env.PD_INVOCATION_SOURCE;
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  process.exitCode = undefined;
  codexCycle.mockClear();
  workbuddyCycle.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  if (savedPdHomeEnv === undefined) delete process.env.PD_SERVICE_PD_HOME;
  else process.env.PD_SERVICE_PD_HOME = savedPdHomeEnv;
  if (savedInvocationSource === undefined) delete process.env.PD_INVOCATION_SOURCE;
  else process.env.PD_INVOCATION_SOURCE = savedInvocationSource;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ownership gate — driver × state matrix (real manifest reads)', () => {
  it('legacy drivers consume legacy_owned / no-record workspaces', () => {
    seedManifest(); // no backgroundExecutions — the pre-service-host default
    for (const driver of ['manual', 'companion'] as const) {
      setDriver(driver);
      const cycle = beginWorkerConsumptionCycle({ hostKind: 'codex', workspaceDir: workspace, driver });
      expect(cycle.verdict).toEqual({ kind: 'consume' });
      endWorkerConsumptionCycle(cycle);
    }
  });

  it.each(['handover_preparing', 'rollback_pending', 'service_host_owned'] as const)('legacy drivers never consume %s', (state) => {
    seedManifest(state);
    for (const driver of ['manual', 'companion'] as const) {
      const cycle = beginWorkerConsumptionCycle({ hostKind: 'codex', workspaceDir: workspace, driver });
      expect(cycle.verdict.kind).toBe('paused');
      if (cycle.verdict.kind !== 'consume') {
        expect(cycle.verdict.reason).toBe(`legacy_consumption_blocked:${state}`);
        expect(cycle.verdict.nextAction).toContain('handover');
      }
      expect(cycle.lockHandle).toBeNull();
      endWorkerConsumptionCycle(cycle);
    }
  });

  it('service_host driver consumes legacy_owned (shadow convergence) and service_host_owned', () => {
    for (const state of [undefined, 'service_host_owned'] as const) {
      seedManifest(state);
      const cycle = beginWorkerConsumptionCycle({ hostKind: 'workbuddy', workspaceDir: workspace, driver: 'service_host' });
      expect(cycle.verdict).toEqual({ kind: 'consume' });
      endWorkerConsumptionCycle(cycle);
    }
  });

  it.each(['handover_preparing', 'rollback_pending'] as const)('service_host driver never consumes mid-transition %s', (state) => {
    seedManifest(state);
    const cycle = beginWorkerConsumptionCycle({ hostKind: 'workbuddy', workspaceDir: workspace, driver: 'service_host' });
    expect(cycle.verdict.kind).toBe('paused');
    if (cycle.verdict.kind !== 'consume') expect(cycle.verdict.reason).toBe(`service_host_consumption_blocked:${state}`);
    endWorkerConsumptionCycle(cycle);
  });

  it('unreadable owner marker fails closed for every driver', () => {
    fs.mkdirSync(pdHome, { recursive: true });
    fs.writeFileSync(path.join(pdHome, 'install.json'), '{not json', 'utf8');
    for (const driver of ['manual', 'companion', 'service_host'] as const) {
      const cycle = beginWorkerConsumptionCycle({ hostKind: 'codex', workspaceDir: workspace, driver });
      expect(cycle.verdict.kind).toBe('degraded');
      if (cycle.verdict.kind !== 'consume') expect(cycle.verdict.reason).toContain('codex_owner_marker_unreadable:');
      endWorkerConsumptionCycle(cycle);
    }
  });
});

describe('per-workspace run mutex', () => {
  it('blocks a second overlapping consumer and frees after the cycle ends', () => {
    seedManifest();
    const first = beginWorkerConsumptionCycle({ hostKind: 'codex', workspaceDir: workspace, driver: 'manual' });
    expect(first.verdict).toEqual({ kind: 'consume' });
    expect(first.lockHandle).not.toBeNull();

    const second = beginWorkerConsumptionCycle({ hostKind: 'codex', workspaceDir: workspace, driver: 'companion' });
    expect(second.verdict.kind).toBe('paused');
    if (second.verdict.kind !== 'consume') expect(second.verdict.reason).toBe('codex_worker_run_in_progress');
    expect(second.lockHandle).toBeNull();

    endWorkerConsumptionCycle(first);
    const third = beginWorkerConsumptionCycle({ hostKind: 'codex', workspaceDir: workspace, driver: 'companion' });
    expect(third.verdict).toEqual({ kind: 'consume' });
    endWorkerConsumptionCycle(third);
  });
});

describe('pd codex worker --once — wiring', () => {
  it('manual driver + handover_preparing: cycle never runs, paused JSON, no failure exit', async () => {
    seedManifest('handover_preparing');
    setDriver('manual');
    await handleCodexWorker({ workspace, json: true, once: true });
    expect(codexCycle).not.toHaveBeenCalled();
    expect(firstJson()).toMatchObject({ mode: 'paused', reason: 'legacy_consumption_blocked:handover_preparing' });
    expect(logs.filter((line) => line.startsWith('{'))).toHaveLength(1);
    expect(process.exitCode).toBeUndefined();
  });

  it('companion driver + service_host_owned: cycle never runs', async () => {
    seedManifest('service_host_owned');
    setDriver('companion');
    await handleCodexWorker({ workspace, json: true, once: true });
    expect(codexCycle).not.toHaveBeenCalled();
    expect(firstJson()).toMatchObject({ mode: 'paused', reason: 'legacy_consumption_blocked:service_host_owned' });
  });

  it('manual driver + no ownership record: cycle runs (pre-service-host default)', async () => {
    seedManifest();
    setDriver('manual');
    await handleCodexWorker({ workspace, json: true, once: true });
    expect(codexCycle).toHaveBeenCalledTimes(1);
    expect(firstJson()).toMatchObject({ mode: 'ready' });
  });

  it('service_host driver + legacy_owned: cycle runs (shadow convergence preserved)', async () => {
    seedManifest();
    setDriver('service_host');
    await handleCodexWorker({ workspace, json: true, once: true });
    expect(codexCycle).toHaveBeenCalledTimes(1);
  });

  it('service_host driver + handover_preparing: cycle never runs', async () => {
    seedManifest('handover_preparing');
    setDriver('service_host');
    await handleCodexWorker({ workspace, json: true, once: true });
    expect(codexCycle).not.toHaveBeenCalled();
    expect(firstJson()).toMatchObject({ mode: 'paused', reason: 'service_host_consumption_blocked:handover_preparing' });
  });

  it('unreadable owner marker: degraded, exit 1, cycle never runs', async () => {
    fs.mkdirSync(pdHome, { recursive: true });
    fs.writeFileSync(path.join(pdHome, 'install.json'), '{corrupt', 'utf8');
    setDriver('manual');
    await handleCodexWorker({ workspace, json: true, once: true });
    expect(codexCycle).not.toHaveBeenCalled();
    expect(firstJson()).toMatchObject({ mode: 'degraded' });
    expect(String(firstJson().reason)).toContain('codex_owner_marker_unreadable:');
    expect(process.exitCode).toBe(1);
  });
});

describe('pd workbuddy worker --once — wiring', () => {
  it('manual driver + rollback_pending: cycle never runs', async () => {
    seedManifest('rollback_pending');
    setDriver('manual');
    await handleWorkbuddyWorker({ workspace, json: true, once: true });
    expect(workbuddyCycle).not.toHaveBeenCalled();
    expect(firstJson()).toMatchObject({ mode: 'paused', reason: 'legacy_consumption_blocked:rollback_pending' });
    expect(process.exitCode).toBeUndefined();
  });

  it('manual driver + no ownership record: cycle runs', async () => {
    seedManifest();
    setDriver('manual');
    await handleWorkbuddyWorker({ workspace, json: true, once: true });
    expect(workbuddyCycle).toHaveBeenCalledTimes(1);
    expect(firstJson()).toMatchObject({ mode: 'ready' });
  });

  it('companion driver + service_host_owned: cycle never runs', async () => {
    seedManifest('service_host_owned');
    setDriver('companion');
    await handleWorkbuddyWorker({ workspace, json: true, once: true });
    expect(workbuddyCycle).not.toHaveBeenCalled();
    expect(firstJson()).toMatchObject({ mode: 'paused', reason: 'legacy_consumption_blocked:service_host_owned' });
  });

  it('service_host driver + service_host_owned: cycle runs', async () => {
    seedManifest('service_host_owned');
    setDriver('service_host');
    await handleWorkbuddyWorker({ workspace, json: true, once: true });
    expect(workbuddyCycle).toHaveBeenCalledTimes(1);
  });
});
