/**
 * Anonymous Product Telemetry v1 — service orchestration tests
 * (PRI-597/598/599 acceptance: gates matrix, daily frequency bound,
 * same-day dedup, cross-day identity rotation, preview exactness,
 * non-interference on failure).
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
import { readProductTelemetryControlState } from '../src/product-telemetry/consent-store.js';
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

function seedWorkspaceDatabases(): void {
  const stateDb = new Database(path.join(workspaceDir, '.pd', 'state.db'));
  stateDb.exec('CREATE TABLE schema_version (version TEXT PRIMARY KEY)');
  stateDb.exec('CREATE TABLE activations (activation_id TEXT, activated_at TEXT NOT NULL)');
  stateDb.exec('CREATE TABLE principle_candidates (id TEXT, status TEXT NOT NULL DEFAULT \'pending\')');
  stateDb.exec('CREATE TABLE principle_applications (principle_id TEXT, session_id TEXT, level TEXT NOT NULL CHECK (level IN (\'effect\',\'presence\')), kind TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const insertVersion = stateDb.prepare('INSERT INTO schema_version (version) VALUES (?)');
  insertVersion.run('002');
  const insertApplication = stateDb.prepare('INSERT INTO principle_applications (principle_id, session_id, level, kind, applied_at) VALUES (?, ?, ?, ?, ?)');
  insertApplication.run('p1', 's1', 'effect', 'rule_blocked', '2026-08-20T00:00:00.000Z');
  stateDb.close();
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  const trajectoryDb = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
  trajectoryDb.exec('CREATE TABLE pain_events (id TEXT, canonical_pain_id TEXT, created_at TEXT)');
  trajectoryDb.close();
}

function seedWorkspaceConfig(configYaml: string): void {
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), configYaml);
}

function freshWorkspace(configYaml: string): string {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-tel-svc-ws-'));
  seedWorkspaceConfig(configYaml);
  seedWorkspaceDatabases();
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
      if (!missingOutcome.attempted) expect(missingOutcome.skipReason).toContain('install_layout_missing');
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

    const state = readProductTelemetryControlState(homeDir);
    expect(state.ok && state.state.lastFailureCode).toBe('http_5xx');
    expect(state.ok && Date.parse(state.state.nextRetryAt as string)).toBe(T0 + 60 * 60 * 1000);

    now = T0 + 30 * 60 * 1000;
    const backed = await service.maybeExportDaily(workspaceDir);
    expect(backed).toEqual({ attempted: false, skipReason: 'retry_backoff' });
    expect(requests).toHaveLength(1);

    now = T0 + 2 * 60 * 60 * 1000;
    await service.maybeExportDaily(workspaceDir);
    expect(requests).toHaveLength(2);
    const afterSecond = readProductTelemetryControlState(homeDir);
    expect(afterSecond.ok && Date.parse(afterSecond.state.nextRetryAt as string)).toBe(now + 6 * 60 * 60 * 1000);
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
    const state = readProductTelemetryControlState(homeDir);
    expect(state.ok && state.state.lastFailureCode).toBeUndefined();
    expect(state.ok && state.state.nextRetryAt).toBeUndefined();
    expect(state.ok && bucketDateFromTime(Date.parse(state.state.lastSucceededAt as string))).toBe(bucketDateFromTime(now));
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
    expect(preview.notes.join()).toContain('ephemeral');
    expect(requests).toHaveLength(0);
  });
});
