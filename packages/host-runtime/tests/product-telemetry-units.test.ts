/**
 * Anonymous Product Telemetry v1 — store / eligibility / readers / exporter
 * unit tests (PRI-597/598/599).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  deniedControlState,
  defaultProductTelemetryControlState,
  getProductTelemetryStatePath,
  grantedControlState,
  readProductTelemetryControlState,
  resetControlState,
  writeProductTelemetryControlState,
} from '../src/product-telemetry/consent-store.js';
import {
  computeTelemetryEnvironment,
  isEnvFlagActive,
  isRepoCheckoutModuleDir,
  type TelemetryEnvironmentInput,
} from '../src/product-telemetry/eligibility.js';
import { readMilestoneFacts } from '../src/product-telemetry/milestone-readers.js';
import {
  exportSnapshot,
  nextRetryDelayMs,
  PRODUCT_TELEMETRY_MAX_BODY_BYTES,
  type TelemetryFetchFn,
} from '../src/product-telemetry/exporter.js';
import { bucketDateFromTime, deriveDailyTelemetryId, generateTelemetrySecretHex, buildProductTelemetrySnapshot } from '@principles/core/runtime-v2';

let homeDir: string;
let workspaceDir: string;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-telemetry-home-'));
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-telemetry-ws-'));
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

describe('control-state store', () => {
  it('reads a missing file as the never-configured default (consent unset)', () => {
    const read = readProductTelemetryControlState(homeDir);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.existed).toBe(false);
      expect(read.state.consent).toBe('unset');
      expect(read.state.telemetrySecret).toBeUndefined();
    }
  });

  it('round-trips grant / deny / reset transitions', () => {
    expect(writeProductTelemetryControlState(homeDir, grantedControlState(defaultProductTelemetryControlState())).ok).toBe(true);
    const granted = readProductTelemetryControlState(homeDir);
    expect(granted.ok && granted.state.consent).toBe('granted');
    expect(granted.ok && granted.state.telemetrySecret).toMatch(/^[0-9a-f]{64}$/);

    expect(writeProductTelemetryControlState(homeDir, deniedControlState()).ok).toBe(true);
    const denied = readProductTelemetryControlState(homeDir);
    // disable deletes identity but preserves the explicit denied choice
    expect(denied.ok && denied.state.consent).toBe('denied');
    expect(denied.ok && denied.state.telemetrySecret).toBeUndefined();

    const reGranted = grantedControlState(denied.ok ? denied.state : defaultProductTelemetryControlState());
    expect(writeProductTelemetryControlState(homeDir, reGranted).ok).toBe(true);
    const reset = resetControlState(readProductTelemetryControlState(homeDir).ok ? (readProductTelemetryControlState(homeDir) as { ok: true; state: ReturnType<typeof grantedControlState> }).state : defaultProductTelemetryControlState());
    expect(writeProductTelemetryControlState(homeDir, reset).ok).toBe(true);
    const after = readProductTelemetryControlState(homeDir);
    // reset keeps consent granted and immediately holds a FRESH secret
    expect(after.ok && after.state.consent).toBe('granted');
    expect(after.ok && after.state.telemetrySecret).not.toBe(reGranted.telemetrySecret);
  });

  it('fails loud on malformed or unknown-field state (rc-3/rc-9)', async () => {
    const statePath = getProductTelemetryStatePath(homeDir);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, '{not json');
    expect(readProductTelemetryControlState(homeDir).ok).toBe(false);
    fs.writeFileSync(statePath, JSON.stringify({ consent: 'granted', schemaVersion: '1', consentVersion: '1', extra: 'x' }));
    const read = readProductTelemetryControlState(homeDir);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain("unknown field 'extra'");
    fs.writeFileSync(statePath, JSON.stringify({ consent: 'maybe', schemaVersion: '1', consentVersion: '1' }));
    expect(readProductTelemetryControlState(homeDir).ok).toBe(false);
  });

  it('fails loud on unparseable timestamps and bad attempt-counter fields (review round 2)', () => {
    const statePath = getProductTelemetryStatePath(homeDir);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    // Each well-shaped-but-garbage timestamp must be rejected — a NaN
    // Date.parse would silently skip same-day dedup / retry backoff.
    for (const field of ['lastAttemptedAt', 'lastSucceededAt', 'nextRetryAt']) {
      fs.writeFileSync(
        statePath,
        JSON.stringify({ consent: 'granted', consentVersion: '1', schemaVersion: '1', [field]: 'not-a-date' }),
      );
      const read = readProductTelemetryControlState(homeDir);
      expect(read.ok, field).toBe(false);
      if (!read.ok) expect(read.reason).toContain('parseable ISO-8601');
    }
    // Bad counter fields are rejected too.
    fs.writeFileSync(
      statePath,
      JSON.stringify({ consent: 'granted', consentVersion: '1', schemaVersion: '1', dailyAttemptCount: 3.5 }),
    );
    expect(readProductTelemetryControlState(homeDir).ok).toBe(false);
    fs.writeFileSync(
      statePath,
      JSON.stringify({ consent: 'granted', consentVersion: '1', schemaVersion: '1', attemptBucketDate: '2026/08/26' }),
    );
    expect(readProductTelemetryControlState(homeDir).ok).toBe(false);
    // Valid ISO timestamps and a same-day counter round-trip cleanly.
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        consent: 'granted',
        consentVersion: '1',
        schemaVersion: '1',
        lastAttemptedAt: '2026-08-26T10:00:00.000Z',
        nextRetryAt: '2026-08-26T11:00:00.000Z',
        dailyAttemptCount: 4,
        attemptBucketDate: '2026-08-26',
      }),
    );
    const ok = readProductTelemetryControlState(homeDir);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.state.dailyAttemptCount).toBe(4);
      expect(ok.state.attemptBucketDate).toBe('2026-08-26');
    }
  });

  it('never writes the secret world-readable (0600 where the platform supports it)', () => {
    writeProductTelemetryControlState(homeDir, grantedControlState(defaultProductTelemetryControlState()));
    const statePath = getProductTelemetryStatePath(homeDir);
    expect(fs.existsSync(statePath)).toBe(true);
    if (process.platform !== 'win32') {
      const mode = fs.statSync(statePath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});

describe('environment eligibility', () => {
  const base = (): TelemetryEnvironmentInput => ({
    env: {},
    workspaceEnvironment: 'production',
    installMode: 'canonical',
    moduleDir: homeDir,
  });

  it('is eligible in a clean production-like environment', () => {
    const result = computeTelemetryEnvironment(base());
    expect(result.suppressed).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it('suppresses for the kill switch with priority over everything', () => {
    const result = computeTelemetryEnvironment({ ...base(), env: { killSwitch: '1', ci: 'true' } });
    expect(result.suppressed).toBe(true);
    expect(result.reasons).toContain('env_kill_switch');
    expect(result.reasons).toContain('ci_environment');
    // 'true' also counts (PD_SKIP_* convention)
    expect(isEnvFlagActive('true')).toBe(true);
    expect(isEnvFlagActive('0')).toBe(false);
    expect(isEnvFlagActive(undefined)).toBe(false);
  });

  it('suppresses CI, vitest, and e2e harness environments', () => {
    expect(computeTelemetryEnvironment({ ...base(), env: { ci: 'true' } }).reasons).toContain('ci_environment');
    expect(computeTelemetryEnvironment({ ...base(), env: { vitest: 'true' } }).reasons).toContain('vitest_environment');
    expect(computeTelemetryEnvironment({ ...base(), env: { e2eMode: '1' } }).reasons).toContain('e2e_mode');
    expect(computeTelemetryEnvironment({ ...base(), env: { e2eMode: '0' } }).reasons).toEqual([]);
  });

  it('suppresses test/demo/development workspaces but not unknown/production', () => {
    for (const environment of ['test', 'demo', 'development'] as const) {
      expect(computeTelemetryEnvironment({ ...base(), workspaceEnvironment: environment }).reasons).toContain('workspace_environment');
    }
    expect(computeTelemetryEnvironment({ ...base(), workspaceEnvironment: 'unknown' }).suppressed).toBe(false);
    expect(computeTelemetryEnvironment({ ...base(), workspaceEnvironment: 'production' }).suppressed).toBe(false);
  });

  it('accepts legacy installs but suppresses when nothing is installed', () => {
    expect(computeTelemetryEnvironment({ ...base(), installMode: 'legacy' }).suppressed).toBe(false);
    expect(computeTelemetryEnvironment({ ...base(), installMode: 'missing' }).reasons).toContain('install_layout_missing');
  });

  it('detects a PD monorepo checkout from the module location (build-layout fact)', () => {
    // Build a fake monorepo layout around the module dir.
    const repoRoot = path.join(homeDir, 'fake-repo');
    fs.mkdirSync(path.join(repoRoot, 'packages', 'principles-core'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'packages', 'host-runtime'), { recursive: true });
    const moduleDir = path.join(repoRoot, 'packages', 'host-runtime', 'dist');
    fs.mkdirSync(moduleDir, { recursive: true });
    expect(isRepoCheckoutModuleDir(moduleDir)).toBe(true);
    expect(computeTelemetryEnvironment({ ...base(), moduleDir }).reasons).toContain('repo_checkout');
    // Installed layouts never have the sibling packages tree.
    expect(isRepoCheckoutModuleDir(path.join(homeDir, '.pd', 'runtime', 'host-runtime', 'dist'))).toBe(false);
  });
});

describe('milestone readers', () => {
  function seedWorkspace(): void {
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
    const stateDb = new Database(path.join(workspaceDir, '.pd', 'state.db'));
    stateDb.exec(`
      CREATE TABLE schema_version (version TEXT PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES ('002');
      CREATE TABLE activations (activation_id TEXT, activated_at TEXT NOT NULL);
      INSERT INTO activations VALUES ('a1', '2026-08-01T00:00:00.000Z');
      CREATE TABLE principle_candidates (id TEXT, status TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE principle_applications (
        principle_id TEXT, session_id TEXT, level TEXT NOT NULL CHECK (level IN ('effect','presence')),
        kind TEXT NOT NULL, applied_at TEXT NOT NULL
      );
      INSERT INTO principle_applications VALUES ('p1', 's1', 'presence', 'prompt_injected', '2026-08-20T00:00:00.000Z');
    `);
    const insertCandidate = stateDb.prepare('INSERT INTO principle_candidates (id, status) VALUES (?, ?)');
    insertCandidate.run('c1', 'pending');
    stateDb.close();
    const trajectoryDb = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    trajectoryDb.exec(`
      CREATE TABLE pain_events (id TEXT, canonical_pain_id TEXT, created_at TEXT);
      INSERT INTO pain_events VALUES ('e1', 'cp1', '2026-08-21T00:00:00.000Z');
    `);
    trajectoryDb.close();
  }

  it('derives all six milestones from seeded durable facts', () => {
    seedWorkspace();
    const { facts, notes } = readMilestoneFacts(workspaceDir);
    expect(notes).toEqual([]);
    expect(facts).toEqual({
      initialized: true,
      painObserved: true,
      principleObserved: true,
      activationObserved: true,
      presenceReceiptObserved: true,
      effectReceiptObserved: false,
      initializationFailed: false,
    });
  });

  it('reports principleObserved from the ledger when no candidates exist', () => {
    fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, '.state', 'principle_training_state.json'),
      JSON.stringify({ version: 1, tree: { principles: { p1: { id: 'p1' } } } }),
    );
    const { facts } = readMilestoneFacts(workspaceDir);
    expect(facts.principleObserved).toBe(true);
    expect(facts.initialized).toBe(false);
  });

  it('renders an empty workspace conservatively (all false, notes recorded, never throws)', () => {
    const { facts, notes } = readMilestoneFacts(workspaceDir);
    expect(facts.initialized).toBe(false);
    expect(facts.painObserved).toBe(false);
    expect(facts.effectReceiptObserved).toBe(false);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes).toContain('state_db_missing_or_unreadable');
  });

  it('marks initializationFailed when state.db exists without an initialized schema', () => {
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    const db = new Database(path.join(workspaceDir, '.pd', 'state.db'));
    db.exec('CREATE TABLE unrelated (x TEXT)');
    db.close();
    const { facts } = readMilestoneFacts(workspaceDir);
    expect(facts.initialized).toBe(false);
    expect(facts.initializationFailed).toBe(true);
  });
});

describe('export client', () => {
  const snapshot = buildProductTelemetrySnapshot({
    dailyTelemetryId: deriveDailyTelemetryId(generateTelemetrySecretHex(), '2026-08-26'),
    bucketDate: '2026-08-26',
    pdVersion: '1.218.0',
    hostKind: 'openclaw',
    milestones: {
      initialized: true,
      painObserved: false,
      principleObserved: false,
      activationObserved: false,
      presenceReceiptObserved: false,
      effectReceiptObserved: false,
    },
    reliability: { initializationFailed: false },
  });

  it('exports successfully and reports the HTTP status', async () => {
    const fetchFn: TelemetryFetchFn = async () => ({ status: 204 });
    const result = await exportSnapshot({ snapshot, fetchFn });
    expect(result).toEqual({ ok: true, status: 204 });
  });

  it('maps timeout / network / HTTP failures to coarse retryable codes', async () => {
    const aborting: TelemetryFetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => {
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      });
    expect(await exportSnapshot({ snapshot, fetchFn: aborting, timeoutMs: 20 })).toEqual({ ok: false, code: 'timeout', retryable: true });

    const refusing: TelemetryFetchFn = async () => {
      throw new TypeError('fetch failed (DNS / connection refused)');
    };
    expect(await exportSnapshot({ snapshot, fetchFn: refusing })).toEqual({ ok: false, code: 'network_error', retryable: true });

    const badRequest: TelemetryFetchFn = async () => ({ status: 400 });
    expect(await exportSnapshot({ snapshot, fetchFn: badRequest })).toEqual({ ok: false, code: 'http_400', retryable: false });

    const throttled: TelemetryFetchFn = async () => ({ status: 429 });
    expect(await exportSnapshot({ snapshot, fetchFn: throttled })).toEqual({ ok: false, code: 'http_429', retryable: true });

    const broken: TelemetryFetchFn = async () => ({ status: 503 });
    expect(await exportSnapshot({ snapshot, fetchFn: broken })).toEqual({ ok: false, code: 'http_5xx', retryable: true });

    const weird: TelemetryFetchFn = async () => ({ status: 302 });
    expect(await exportSnapshot({ snapshot, fetchFn: weird })).toEqual({ ok: false, code: 'http_unexpected_status', retryable: false });
  });

  it('refuses to send oversized bodies without a network round trip', async () => {
    const huge = { ...snapshot, pdVersion: 'x'.repeat(PRODUCT_TELEMETRY_MAX_BODY_BYTES) } as unknown as Parameters<typeof exportSnapshot>[0]['snapshot'];
    let called = false;
    const fetchFn: TelemetryFetchFn = async () => {
      called = true;
      return { status: 204 };
    };
    const result = await exportSnapshot({ snapshot: huge, fetchFn });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('uses bounded backoff steps', () => {
    expect(nextRetryDelayMs(false)).toBe(60 * 60 * 1000);
    expect(nextRetryDelayMs(true)).toBe(6 * 60 * 60 * 1000);
  });

  it('sends to the configured endpoint with a JSON POST (exact wire shape)', async () => {
    const seen: Array<{ url: string; init: unknown }> = [];
    const fetchFn: TelemetryFetchFn = async (url, init) => {
      seen.push({ url, init });
      return { status: 200 };
    };
    await exportSnapshot({ snapshot, fetchFn, endpoint: 'https://collector.example/api/product-telemetry/snapshot' });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://collector.example/api/product-telemetry/snapshot');
    const init = seen[0].init as { method: string; headers: Record<string, string>; body: string };
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual(snapshot);
  });
});
