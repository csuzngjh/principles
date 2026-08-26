/**
 * Anonymous Product Telemetry v1 — service orchestration tests
 * (PRI-597/598/599 acceptance: gates matrix, daily frequency bound,
 * same-day dedup, cross-day identity rotation, preview exactness,
 * non-interference on failure; review remediation: workspace measurement
 * unit — Case A–F multi-workspace independence).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  createProductTelemetryService,
  PREVIEW_BANNER,
  type ProductTelemetryServiceDeps,
} from '../src/product-telemetry/service.js';
import { getProductTelemetryStatePath, readProductTelemetryControlState, writeProductTelemetryControlState, type ProductTelemetryControlState } from '../src/product-telemetry/consent-store.js';
import { workspaceExportLockPath, workspaceScopeIdFor } from '../src/product-telemetry/workspace-scope.js';
import type { TelemetryFetchFn } from '../src/product-telemetry/exporter.js';
import { loadPdConfigForPlugin } from '../src/pd-config.js';
import { validateProductTelemetrySnapshot, bucketDateFromTime } from '@principles/core/runtime-v2';

let homeDir: string;
let workspaceDir: string;
let requests: Array<{ url: string; body: string }>;
let fetchStatus: () => Promise<number>;
const recordingFetch: TelemetryFetchFn = async (url, init) => {
  const status = await fetchStatus();
  requests.push({ url, body: init.body });
  return { status };
};

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-08-26T10:00:00.000Z');

function seedCanonicalInstall(): void {
  fs.mkdirSync(path.join(homeDir, '.pd', 'runtime', 'host-runtime'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.pd', 'install.json'), JSON.stringify({ layoutVersion: 1, mode: 'canonical', hosts: ['openclaw'] }));
  fs.mkdirSync(path.join(homeDir, '.pd', 'runtime', 'plugin'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.pd', 'runtime', 'plugin', 'package.json'), JSON.stringify({ name: 'principles-disciple', version: '1.218.0' }));
}

function seedWorkspaceDatabases(dir: string): void {
  const stateDb = new Database(path.join(dir, '.pd', 'state.db'));
  stateDb.exec('CREATE TABLE schema_version (version TEXT PRIMARY KEY)');
  stateDb.exec('CREATE TABLE activations (activation_id TEXT, activated_at TEXT NOT NULL)');
  stateDb.exec('CREATE TABLE principle_candidates (id TEXT, status TEXT NOT NULL DEFAULT \'pending\')');
  stateDb.exec('CREATE TABLE principle_applications (principle_id TEXT, session_id TEXT, level TEXT NOT NULL CHECK (level IN (\'effect\',\'presence\')), kind TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const insertVersion = stateDb.prepare('INSERT INTO schema_version (version) VALUES (?)');
  insertVersion.run('002');
  const insertApplication = stateDb.prepare('INSERT INTO principle_applications (principle_id, session_id, level, kind, applied_at) VALUES (?, ?, ?, ?, ?)');
  insertApplication.run('p1', 's1', 'effect', 'rule_blocked', '2026-08-20T00:00:00.000Z');
  stateDb.close();
  fs.mkdirSync(path.join(dir, '.state'), { recursive: true });
  const trajectoryDb = new Database(path.join(dir, '.state', 'trajectory.db'));
  trajectoryDb.exec('CREATE TABLE pain_events (id TEXT, canonical_pain_id TEXT, created_at TEXT)');
  trajectoryDb.close();
}

function seedWorkspaceConfig(dir: string, configYaml: string): void {
  fs.mkdirSync(path.join(dir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pd', 'config.yaml'), configYaml);
}

function freshWorkspace(configYaml: string): string {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-tel-svc-ws-'));
  seedWorkspaceConfig(workspaceDir, configYaml);
  seedWorkspaceDatabases(workspaceDir);
  return workspaceDir;
}

const VALID_CONFIG_BASE = [
  'version: 1',
  'runtimeProfiles:',
  '  openclaw.default:',
  '    type: openclaw',
  '    source: default',
  'internalAgents:',
  '  defaultRuntime: openclaw.default',
  '  agents:',
  '    diagnostician:',
  '      enabled: true',
  '    dreamer:',
  '      enabled: true',
  '    scribe:',
  '      enabled: true',
  '    artificer:',
  '      enabled: true',
  '    philosopher:',
  '      enabled: false',
  '    evaluator:',
  '      enabled: false',
  '    rolloutReviewer:',
  '      enabled: false',
  '    correctionObserver:',
  '      enabled: false',
  '    empathyObserver:',
  '      enabled: false',
  '    signalCollector:',
  '      enabled: false',
].join('\n');

function configWithFeaturesLine(featuresLine: string): string {
  return `${VALID_CONFIG_BASE}\nfeatures:\n  anonymous_product_telemetry:\n${featuresLine}\n`;
}

const FLAG_ON_CONFIG = configWithFeaturesLine('    category: quiet\n    enabled: true');
const FLAG_OFF_CONFIG = configWithFeaturesLine('    category: quiet\n    enabled: false');
function makeService(overrides: Partial<ProductTelemetryServiceDeps> = {}) {
  return createProductTelemetryService({
    homeDir,
    env: {},
    moduleDir: homeDir, // outside any monorepo checkout
    fetchFn: recordingFetch,
    now: () => T0,
    ...overrides,
  });
}

/** Derive the scope key for a workspace under the CURRENT stored secret. */
function scopeKeyFor(workspace: string): string {
  const read = readProductTelemetryControlState(homeDir);
  if (!read.ok || read.state.telemetrySecret === undefined) throw new Error('no secret for scope derivation');
  return workspaceScopeIdFor(read.state.telemetrySecret, workspace);
}

/** Read the workspace-scoped export entry for a workspace. */
function workspaceEntryOf(workspace: string): ProductTelemetryControlState['workspaceExports'][string] | undefined {
  const read = readProductTelemetryControlState(homeDir);
  if (!read.ok) return undefined;
  return read.state.workspaceExports?.[scopeKeyFor(workspace)];
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-tel-svc-home-'));
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-tel-svc-ws-'));
  requests = [];
  fetchStatus = async () => 204;
  seedCanonicalInstall();
  freshWorkspace(FLAG_ON_CONFIG);
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

function setWorkspaceEnvironment(environment: 'test' | 'demo' | 'development' | 'production'): void {
  const workspacePath = workspaceDir.split(path.sep).join('/');
  fs.writeFileSync(
    path.join(workspaceDir, '.pd', 'config.yaml'),
    `${FLAG_ON_CONFIG}workspace:\n  default: ${workspacePath}\n  environment: ${environment}\n`,
  );
}

describe('gate matrix — zero network requests unless every gate is open', () => {
  it('makes zero requests while consent is unset (default OFF)', async () => {
    const service = makeService();
    const outcome = await service.maybeExportDaily(workspaceDir);
    expect(outcome).toEqual({ attempted: false, skipReason: 'consent_unset' });
    expect(requests).toHaveLength(0);
  });

  it('makes zero requests when consent is denied', async () => {
    const service = makeService();
    service.disable();
    const outcome = await service.maybeExportDaily(workspaceDir);
    expect(outcome).toEqual({ attempted: false, skipReason: 'consent_denied' });
    expect(requests).toHaveLength(0);
  });

  it('makes zero requests when the feature flag is off', async () => {
    freshWorkspace(FLAG_OFF_CONFIG);
    const service = makeService();
    service.enable();
    const outcome = await service.maybeExportDaily(workspaceDir);
    expect(outcome).toEqual({ attempted: false, skipReason: 'feature_flag_disabled' });
    expect(requests).toHaveLength(0);
  });

  it('makes zero requests under the environment kill switch (overrides local enable)', async () => {
    const service = makeService({ env: { PD_TELEMETRY_DISABLED: '1' } });
    service.enable();
    const outcome = await service.maybeExportDaily(workspaceDir);
    expect(outcome.attempted).toBe(false);
    if (!outcome.attempted) {
      expect(outcome.skipReason).toContain('environment_suppressed');
      expect(outcome.skipReason).toContain('env_kill_switch');
    }
    expect(requests).toHaveLength(0);
  });

  it('makes zero requests in CI / vitest / e2e environments even when opted in', async () => {
    for (const env of [{ CI: 'true' }, { VITEST: 'true' }, { PD_E2E_MODE: '1' }]) {
      requests = [];
      const service = makeService({ env });
      service.enable();
      const outcome = await service.maybeExportDaily(workspaceDir);
      expect(outcome.attempted).toBe(false);
      if (!outcome.attempted) expect(outcome.skipReason.startsWith('environment_suppressed')).toBe(true);
      expect(requests).toHaveLength(0);
    }
  });

  it('makes zero requests for test/demo/development workspaces', async () => {
    for (const environment of ['test', 'demo', 'development'] as const) {
      requests = [];
      freshWorkspace(FLAG_ON_CONFIG);
      setWorkspaceEnvironment(environment);
      // The fixture must parse (otherwise flag_disabled masks the suppression under test).
      const loaded = loadPdConfigForPlugin(workspaceDir);
      expect(loaded.ok).toBe(true);
      const service = makeService();
      service.enable();
      const outcome = await service.maybeExportDaily(workspaceDir);
      expect(outcome.attempted).toBe(false);
      if (!outcome.attempted) expect(outcome.skipReason).toContain('workspace_environment');
      expect(requests).toHaveLength(0);
    }
  });

  it('makes zero requests when running from a repo checkout or with nothing installed', async () => {
    const repoRoot = path.join(homeDir, 'repo');
    fs.mkdirSync(path.join(repoRoot, 'packages', 'principles-core'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'packages', 'host-runtime'), { recursive: true });
    const service = makeService({ moduleDir: path.join(repoRoot, 'packages', 'host-runtime', 'dist') });
    service.enable();
    const outcome = await service.maybeExportDaily(workspaceDir);
    expect(outcome.attempted).toBe(false);
    if (!outcome.attempted) expect(outcome.skipReason).toContain('repo_checkout');
    expect(requests).toHaveLength(0);

    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-tel-empty-'));
    try {
      const missing = makeService({ homeDir: emptyHome, moduleDir: emptyHome });
      missing.enable();
      const missingOutcome = await missing.maybeExportDaily(workspaceDir);
      expect(missingOutcome.attempted).toBe(false);
      if (!missingOutcome) expect(missingOutcome.skipReason).toContain('install_layout_missing');
      expect(requests).toHaveLength(0);
    } finally {
      fs.rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});

describe('daily export flow — bounded frequency, identity rotation, resilience', () => {
  it('exports once per day: second same-day trigger is skipped (client-side bound)', async () => {
    const service = makeService();
    service.enable();
    const first = await service.maybeExportDaily(workspaceDir);
    expect(first).toMatchObject({ attempted: true, ok: true, httpStatus: 204 });
    expect(requests).toHaveLength(1);
    const second = await service.maybeExportDaily(workspaceDir);
    expect(second).toEqual({ attempted: false, skipReason: 'already_succeeded_today' });
    expect(requests).toHaveLength(1);
  });

  it('hard-caps failed attempts at 5/day per workspace via dailyAttemptCount (review round 2)', async () => {
    fetchStatus = async () => 500;
    const service = makeService();
    service.enable();
    // Simulate 5 prior same-day failures recorded in THIS workspace's entry.
    const stateRead = readProductTelemetryControlState(homeDir);
    expect(stateRead.ok).toBe(true);
    if (!stateRead.ok) return;
    const capState: ProductTelemetryControlState = {
      ...stateRead.state,
      workspaceExports: { [scopeKeyFor(workspaceDir)]: { dailyAttemptCount: 5, attemptBucketDate: '2026-08-26' } },
    };
    expect(writeProductTelemetryControlState(homeDir, capState).ok).toBe(true);

    const capped = await service.maybeExportDaily(workspaceDir);
    expect(capped).toEqual({ attempted: false, skipReason: 'daily_attempt_cap' });
    expect(requests).toHaveLength(0);

    // A stale counter from a previous day resets (new bucket date).
    const staleState: ProductTelemetryControlState = {
      ...capState,
      workspaceExports: { [scopeKeyFor(workspaceDir)]: { dailyAttemptCount: 5, attemptBucketDate: '2026-08-25' } },
    };
    expect(writeProductTelemetryControlState(homeDir, staleState).ok).toBe(true);
    const afterReset = await service.maybeExportDaily(workspaceDir);
    expect(afterReset.attempted).toBe(true);
    expect(requests).toHaveLength(1);
    // The 6th failure re-records the counter against TODAY's bucket.
    const recorded = workspaceEntryOf(workspaceDir);
    expect(recorded?.dailyAttemptCount).toBe(1);
    expect(recorded?.attemptBucketDate).toBe('2026-08-26');
  });

  it('one network request when two processes export the same workspace concurrently (export lock, review round 2)', async () => {
    // The lock is acquired synchronously before the fetch await, so the second
    // caller sees it busy and skips without a network call.
    const slowFetch: TelemetryFetchFn = async (url, init) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      requests.push({ url, body: init.body });
      return { status: 204 };
    };
    const serviceA = makeService({ fetchFn: slowFetch });
    const serviceB = makeService({ fetchFn: slowFetch });
    serviceA.enable();

    const [outcomeA, outcomeB] = await Promise.all([
      serviceA.maybeExportDaily(workspaceDir),
      serviceB.maybeExportDaily(workspaceDir),
    ]);

    const outcomes = [outcomeA, outcomeB].sort((a, b) => (a.attempted === b.attempted ? 0 : a.attempted ? -1 : 1));
    expect(outcomes[0], JSON.stringify([outcomeA, outcomeB])).toMatchObject({ attempted: true, ok: true });
    expect(outcomes[1], JSON.stringify([outcomeA, outcomeB])).toEqual({ attempted: false, skipReason: 'export_lock_busy' });
    expect(requests).toHaveLength(1);
    // The lock is released afterwards, so a later sequential trigger works.
    const later = await serviceA.maybeExportDaily(workspaceDir);
    expect(later).toEqual({ attempted: false, skipReason: 'already_succeeded_today' });
  });

  it('derives a different (unlinkable) daily ID on the next day', async () => {
    let now = T0;
    const service = makeService({ now: () => now });
    service.enable();
    await service.maybeExportDaily(workspaceDir);
    const day1Id = JSON.parse(requests[0].body).dailyTelemetryId;
    expect(JSON.parse(requests[0].body).bucketDate).toBe('2026-08-26');

    now = T0 + DAY_MS;
    await service.maybeExportDaily(workspaceDir);
    expect(requests).toHaveLength(2);
    const day2 = JSON.parse(requests[1].body);
    expect(day2.bucketDate).toBe('2026-08-27');
    expect(day2.dailyTelemetryId).not.toBe(day1Id);
    expect(validateProductTelemetrySnapshot(day2).ok).toBe(true);
  });

  it('records bounded failure state and honors retry backoff without throwing', async () => {
    fetchStatus = async () => 500;
    let now = T0;
    const service = makeService({ now: () => now });
    service.enable();
    const failed = await service.maybeExportDaily(workspaceDir);
    expect(failed).toEqual({ attempted: true, ok: false, failureCode: 'http_5xx' });

    const entry = workspaceEntryOf(workspaceDir);
    expect(entry?.lastFailureCode).toBe('http_5xx');
    expect(Date.parse(entry?.nextRetryAt as string)).toBe(T0 + 60 * 60 * 1000);

    now = T0 + 30 * 60 * 1000;
    const backed = await service.maybeExportDaily(workspaceDir);
    expect(backed).toEqual({ attempted: false, skipReason: 'retry_backoff' });
    expect(requests).toHaveLength(1);

    now = T0 + 2 * 60 * 60 * 1000;
    await service.maybeExportDaily(workspaceDir);
    expect(requests).toHaveLength(2);
    const afterSecond = workspaceEntryOf(workspaceDir);
    expect(Date.parse(afterSecond?.nextRetryAt as string)).toBe(now + 6 * 60 * 60 * 1000);
  });

  it('recovers after a success following failures (failure state cleared)', async () => {
    fetchStatus = async () => 429;
    const service = makeService();
    service.enable();
    await service.maybeExportDaily(workspaceDir);

    fetchStatus = async () => 204;
    const now = T0 + 2 * 60 * 60 * 1000;
    const recovered = makeService({ now: () => now });
    const outcome = await recovered.maybeExportDaily(workspaceDir);
    expect(outcome).toMatchObject({ attempted: true, ok: true });
    const entry = workspaceEntryOf(workspaceDir);
    expect(entry?.lastFailureCode).toBeUndefined();
    expect(entry?.nextRetryAt).toBeUndefined();
    // Success also clears the daily attempt counter (fresh budget tomorrow).
    expect(entry?.dailyAttemptCount).toBeUndefined();
    expect(entry?.attemptBucketDate).toBeUndefined();
    expect(bucketDateFromTime(Date.parse(entry?.lastSucceededAt as string))).toBe(bucketDateFromTime(now));
  });

  it('survives collector unreachability (DNS-shaped failure) and never throws', async () => {
    const refusing: TelemetryFetchFn = async () => {
      throw new TypeError('getaddrinfo ENOTFOUND collector');
    };
    const service = makeService({ fetchFn: refusing });
    service.enable();
    const outcome = await service.maybeExportDaily(workspaceDir);
    expect(outcome).toEqual({ attempted: true, ok: false, failureCode: 'network_error' });
    const status = service.getStatus(workspaceDir);
    expect(status.ok).toBe(true);
  });
});

describe('workspace-scoped measurement — Case A–F (review remediation P1-1)', () => {
  function secondWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-tel-svc-ws2-'));
    seedWorkspaceConfig(dir, FLAG_ON_CONFIG);
    seedWorkspaceDatabases(dir);
    return dir;
  }

  it('Case A: workspace B still exports the same day after workspace A succeeded', async () => {
    const wsB = secondWorkspace();
    try {
      const service = makeService();
      service.enable();
      const first = await service.maybeExportDaily(workspaceDir);
      expect(first).toMatchObject({ attempted: true, ok: true });
      expect(requests).toHaveLength(1);
      const second = await service.maybeExportDaily(wsB);
      expect(second).toMatchObject({ attempted: true, ok: true });
      expect(requests).toHaveLength(2);
      // Both workspaces recorded independent same-day success entries.
      const entryA = workspaceEntryOf(workspaceDir);
      const entryB = workspaceEntryOf(wsB);
      expect(entryA?.lastSucceededAt).toBeDefined();
      expect(entryB?.lastSucceededAt).toBeDefined();
    } finally {
      fs.rmSync(wsB, { recursive: true, force: true });
    }
  });

  it('Case B: workspace A failure/backoff does not block workspace B', async () => {
    fetchStatus = async () => 500;
    const wsB = secondWorkspace();
    try {
      const service = makeService();
      service.enable();
      const failed = await service.maybeExportDaily(workspaceDir);
      expect(failed).toMatchObject({ attempted: true, ok: false, failureCode: 'http_5xx' });
      // B is NOT in A's retry backoff.
      const outcomeB = await service.maybeExportDaily(wsB);
      expect(outcomeB).toMatchObject({ attempted: true, ok: false, failureCode: 'http_5xx' });
      expect(requests).toHaveLength(2);
      // A is in backoff; B's state is separate.
      const backed = await service.maybeExportDaily(workspaceDir);
      expect(backed).toEqual({ attempted: false, skipReason: 'retry_backoff' });
      expect(requests).toHaveLength(2);
    } finally {
      fs.rmSync(wsB, { recursive: true, force: true });
    }
  });

  it('Case C: workspace A holding its export lock does not block workspace B', async () => {
    const wsB = secondWorkspace();
    try {
      const service = makeService();
      service.enable();
      const scopeA = scopeKeyFor(workspaceDir);
      const lockPathA = workspaceExportLockPath(getProductTelemetryStatePath(homeDir), scopeA);
      fs.mkdirSync(path.dirname(lockPathA), { recursive: true });
      fs.writeFileSync(lockPathA, 'held');
      try {
        // A skips on its own busy lock...
        const outcomeA = await service.maybeExportDaily(workspaceDir);
        expect(outcomeA).toEqual({ attempted: false, skipReason: 'export_lock_busy' });
        // ...while B exports freely.
        const outcomeB = await service.maybeExportDaily(wsB);
        expect(outcomeB).toMatchObject({ attempted: true, ok: true });
        expect(requests).toHaveLength(1);
      } finally {
        fs.rmSync(lockPathA, { force: true });
      }
    } finally {
      fs.rmSync(wsB, { recursive: true, force: true });
    }
  });

  it('Case D: same workspace + same day dedupes to one request', async () => {
    const service = makeService();
    service.enable();
    await service.maybeExportDaily(workspaceDir);
    const again = await service.maybeExportDaily(workspaceDir);
    expect(again).toEqual({ attempted: false, skipReason: 'already_succeeded_today' });
    expect(requests).toHaveLength(1);
  });

  it('Case E: same workspace on the next day derives a new unlinkable ID', async () => {
    let now = T0;
    const service = makeService({ now: () => now });
    service.enable();
    await service.maybeExportDaily(workspaceDir);
    const day1Id = JSON.parse(requests[0].body).dailyTelemetryId;
    now = T0 + DAY_MS;
    const outcome = await service.maybeExportDaily(workspaceDir);
    expect(outcome).toMatchObject({ attempted: true, ok: true });
    const day2Id = JSON.parse(requests[1].body).dailyTelemetryId;
    expect(day2Id).not.toBe(day1Id);
  });

  it('Case F: different workspaces on the same day derive different IDs', async () => {
    const wsB = secondWorkspace();
    try {
      const service = makeService();
      service.enable();
      await service.maybeExportDaily(workspaceDir);
      await service.maybeExportDaily(wsB);
      expect(requests).toHaveLength(2);
      const idA = JSON.parse(requests[0].body).dailyTelemetryId;
      const idB = JSON.parse(requests[1].body).dailyTelemetryId;
      expect(idA).not.toBe(idB);
      // Both snapshots remain wire-valid.
      expect(validateProductTelemetrySnapshot(JSON.parse(requests[0].body)).ok).toBe(true);
      expect(validateProductTelemetrySnapshot(JSON.parse(requests[1].body)).ok).toBe(true);
    } finally {
      fs.rmSync(wsB, { recursive: true, force: true });
    }
  });
});

describe('control plane — enable / disable / reset / status / preview', () => {
  it('status shows gates and bounded export status without ever exposing the secret', async () => {
    const service = makeService();
    service.enable();
    await service.maybeExportDaily(workspaceDir);
    const status = service.getStatus(workspaceDir);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    const stateRead = readProductTelemetryControlState(homeDir);
    const secretValue = stateRead.ok ? stateRead.state.telemetrySecret : undefined;
    const serialized = JSON.stringify(status.view);
    expect(secretValue).toMatch(/^[0-9a-f]{64}$/);
    expect(serialized).not.toContain(secretValue as string);
    expect(status.view.consent).toBe('granted');
    expect(status.view.flagEnabled).toBe(true);
    expect(status.view.hasSecret).toBe(true);
    expect(status.view.lastSucceededAt).toBeDefined();
    expect(status.view.lastFailureCode).toBeUndefined();
    expect(status.view.canExport).toBe(true);
  });

  it('names an unresolved flag distinctly from a disabled flag (review round 2)', () => {
    const service = makeService();
    service.enable();
    // No workspace → the workspace-scope flag cannot be resolved at all.
    const status = service.getStatus(undefined);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.view.flagEnabled).toBeNull();
    expect(status.view.blockers).toContain('feature_flag_unresolved');
    expect(status.view.blockers).not.toContain('feature_flag_disabled');
    // A workspace with the flag explicitly OFF reports 'disabled'; ON reports neither.
    const flagOnWorkspace = workspaceDir;
    const flagOffWorkspace = freshWorkspace(FLAG_OFF_CONFIG);
    const withOff = service.getStatus(flagOffWorkspace);
    expect(withOff.ok && withOff.view.blockers).toContain('feature_flag_disabled');
    expect(withOff.ok && withOff.view.blockers).not.toContain('feature_flag_unresolved');
    const withOn = service.getStatus(flagOnWorkspace);
    expect(withOn.ok && withOn.view.blockers).not.toContain('feature_flag_unresolved');
    expect(withOn.ok && withOn.view.blockers).not.toContain('feature_flag_disabled');
  });

  it('disable immediately stops future exports and deletes identity (SPEC §19)', async () => {
    const service = makeService();
    service.enable();
    service.disable();
    const outcome = await service.maybeExportDaily(workspaceDir);
    expect(outcome).toEqual({ attempted: false, skipReason: 'consent_denied' });
    expect(requests).toHaveLength(0);
    const state = readProductTelemetryControlState(homeDir);
    expect(state.ok && state.state.telemetrySecret).toBeUndefined();
  });

  it('reset rotates the secret so future daily IDs are unrelated to previous ones', async () => {
    const service = makeService();
    service.enable();
    const before = readProductTelemetryControlState(homeDir);
    const secretBefore = before.ok ? before.state.telemetrySecret : undefined;
    service.reset();
    const after = readProductTelemetryControlState(homeDir);
    const secretAfter = after.ok ? after.state.telemetrySecret : undefined;
    expect(secretAfter).toBeDefined();
    expect(secretAfter).not.toBe(secretBefore);
    expect(after.ok && after.state.consent).toBe('granted');
    const outcome = await service.maybeExportDaily(workspaceDir);
    expect(outcome).toMatchObject({ attempted: true, ok: true });
    const sentSecretIndependent = JSON.parse(requests[0].body).dailyTelemetryId;
    expect(sentSecretIndependent).toMatch(/^[0-9a-f]{32}$/);
  });

  it('preview shows the exact outbound payload (valid schema) and never sends', async () => {
    const service = makeService();
    service.enable();
    const preview = service.preview(workspaceDir);
    expect(preview.banner).toBe(PREVIEW_BANNER);
    expect(validateProductTelemetrySnapshot(preview.snapshot).ok).toBe(true);
    expect(preview.snapshot.pdVersion).toBe('1.218.0');
    expect(preview.snapshot.hostKind).toBe('openclaw');
    expect(preview.gates.canExport).toBe(true);
    expect(requests).toHaveLength(0);

    // The previewed payload equals what an export actually sends.
    await service.maybeExportDaily(workspaceDir);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0].body)).toEqual(preview.snapshot);
  });

  it('preview works before consent (ephemeral secret, honest note)', () => {
    const service = makeService();
    const preview = service.preview(workspaceDir);
    expect(preview.secretEphemeral).toBe(true);
    expect(preview.gates.canExport).toBe(false);
    expect(preview.gates.consent).toBe('unset');
    expect(preview.notes.join()).toContain('provisional');
    expect(requests).toHaveLength(0);
  });
});
