/**
 * Anonymous Product Telemetry v1 — store / eligibility / readers / exporter
 * / workspace-scope unit tests (PRI-597/598/599; review remediation:
 * workspace measurement unit, tri-state facts).
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
  pruneWorkspaceExports,
  readProductTelemetryControlState,
  resetControlState,
  writeProductTelemetryControlState,
  MAX_WORKSPACE_EXPORT_ENTRIES,
  WORKSPACE_EXPORT_STATE_MAX_AGE_DAYS,
  type ProductTelemetryControlState,
} from '../src/product-telemetry/consent-store.js';
import {
  computeTelemetryEnvironment,
  isEnvFlagActive,
  isRepoCheckoutModuleDir,
  type TelemetryEnvironmentInput,
} from '../src/product-telemetry/eligibility.js';
import { readMilestoneFacts } from '../src/product-telemetry/milestone-readers.js';
import {
  canonicalizeWorkspacePath,
  workspaceExportLockPath,
  workspaceScopeIdFor,
} from '../src/product-telemetry/workspace-scope.js';
import {
  exportSnapshot,
  nextRetryDelayMs,
  PRODUCT_TELEMETRY_MAX_BODY_BYTES,
  type TelemetryFetchFn,
} from '../src/product-telemetry/exporter.js';
import { deriveDailyTelemetryId, deriveWorkspaceScopeId, generateTelemetrySecretHex, buildProductTelemetrySnapshot } from '@principles/core/runtime-v2';

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
    const reset = resetControlState(readProductTelemetryControlState(homeDir).ok ? (readProductTelemetryControlState(homeDir) as { ok: true; state: ProductTelemetryControlState }).state : defaultProductTelemetryControlState());
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
    fs.writeFileSync(statePath, JSON.stringify({ consent: 'granted', schemaVersion: '2', consentVersion: '1', extra: 'x' }));
    const read = readProductTelemetryControlState(homeDir);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain("unknown field 'extra'");
    fs.writeFileSync(statePath, JSON.stringify({ consent: 'maybe', schemaVersion: '2', consentVersion: '1' }));
    expect(readProductTelemetryControlState(homeDir).ok).toBe(false);
  });

  it('fails loud on unparseable timestamps and bad attempt-counter fields (review round 2)', () => {
    const statePath = getProductTelemetryStatePath(homeDir);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    // Each well-shaped-but-garbage timestamp must be rejected — a NaN
    // Date.parse would silently skip same-day dedup / retry backoff. The
    // fields live inside a workspaceExports entry under schema v2.
    for (const field of ['lastAttemptedAt', 'lastSucceededAt', 'nextRetryAt']) {
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          consent: 'granted',
          consentVersion: '1',
          schemaVersion: '2',
          workspaceExports: { aaaa0000aaaa0000: { [field]: 'not-a-date' } },
        }),
      );
      const read = readProductTelemetryControlState(homeDir);
      expect(read.ok, field).toBe(false);
      if (!read.ok) expect(read.reason).toContain('parseable ISO-8601');
    }
    // Bad counter fields are rejected too.
    fs.writeFileSync(
      statePath,
      JSON.stringify({ consent: 'granted', consentVersion: '1', schemaVersion: '2', workspaceExports: { aaaa0000aaaa0000: { dailyAttemptCount: 3.5 } } }),
    );
    expect(readProductTelemetryControlState(homeDir).ok).toBe(false);
    fs.writeFileSync(
      statePath,
      JSON.stringify({ consent: 'granted', consentVersion: '1', schemaVersion: '2', workspaceExports: { aaaa0000aaaa0000: { attemptBucketDate: '2026/08/26' } } }),
    );
    expect(readProductTelemetryControlState(homeDir).ok).toBe(false);
    // Valid workspace entries round-trip cleanly.
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        consent: 'granted',
        consentVersion: '1',
        schemaVersion: '2',
        workspaceExports: {
          aaaa0000aaaa0000: {
            lastAttemptedAt: '2026-08-26T10:00:00.000Z',
            nextRetryAt: '2026-08-26T11:00:00.000Z',
            dailyAttemptCount: 4,
            attemptBucketDate: '2026-08-26',
          },
        },
      }),
    );
    const ok = readProductTelemetryControlState(homeDir);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.state.workspaceExports?.aaaa0000aaaa0000?.dailyAttemptCount).toBe(4);
      expect(ok.state.workspaceExports?.aaaa0000aaaa0000?.attemptBucketDate).toBe('2026-08-26');
    }
  });

  it('rejects non-hex or oversized workspaceExports maps', () => {
    const statePath = getProductTelemetryStatePath(homeDir);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({ consent: 'granted', consentVersion: '1', schemaVersion: '2', workspaceExports: { 'not-hex!': {} } }),
    );
    expect(readProductTelemetryControlState(homeDir).ok).toBe(false);
    const tooMany: Record<string, unknown> = {};
    for (let i = 0; i < MAX_WORKSPACE_EXPORT_ENTRIES + 1; i += 1) tooMany[i.toString(16).padStart(16, '0')] = {};
    fs.writeFileSync(statePath, JSON.stringify({ consent: 'granted', consentVersion: '1', schemaVersion: '2', workspaceExports: tooMany }));
    const read = readProductTelemetryControlState(homeDir);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain('at most');
  });

  it('migrates a v1 machine-global state to v2: consent+secret kept, export bookkeeping dropped', () => {
    const statePath = getProductTelemetryStatePath(homeDir);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const secret = generateTelemetrySecretHex();
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        consent: 'granted',
        consentVersion: '1',
        telemetrySecret: secret,
        lastAttemptedAt: '2026-08-25T10:00:00.000Z',
        lastSucceededAt: '2026-08-25T10:00:00.000Z',
        lastFailureCode: 'http_5xx',
        nextRetryAt: '2026-08-25T16:00:00.000Z',
        dailyAttemptCount: 3,
        attemptBucketDate: '2026-08-25',
        schemaVersion: '1',
      }),
    );
    const read = readProductTelemetryControlState(homeDir);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // Identity preserved...
    expect(read.state.consent).toBe('granted');
    expect(read.state.consentVersion).toBe('1');
    expect(read.state.telemetrySecret).toBe(secret);
    // ...machine-global export bookkeeping deliberately discarded (cannot be
    // attributed to a workspace; operational state, not a governance fact).
    expect(read.state.workspaceExports).toBeUndefined();
    expect(read.state.schemaVersion).toBe('2');
    // Persisted as v2 on the next write.
    expect(writeProductTelemetryControlState(homeDir, read.state).ok).toBe(true);
    expect(fs.readFileSync(statePath, 'utf8')).toContain('"schemaVersion": "2"');
    // A v1 file with garbage export fields is still migrated (those fields
    // are dropped, not validated): the identity fields carry the decision.
    fs.writeFileSync(
      statePath,
      JSON.stringify({ consent: 'denied', consentVersion: '1', schemaVersion: '1', lastSucceededAt: 'garbage-but-dropped' }),
    );
    const migrated = readProductTelemetryControlState(homeDir);
    expect(migrated.ok).toBe(true);
    if (migrated.ok) expect(migrated.state.consent).toBe('denied');
  });

  it('prunes workspace export entries untouched beyond the max age', () => {
    const now = Date.parse('2026-08-26T10:00:00.000Z');
    const fresh = { lastAttemptedAt: '2026-08-26T09:00:00.000Z' };
    const stale = { lastAttemptedAt: '2026-01-01T00:00:00.000Z' };
    const succeededLongAgo = { lastSucceededAt: '2026-01-01T00:00:00.000Z' };
    const pruned = pruneWorkspaceExports(
      {
        consent: 'granted',
        consentVersion: '1',
        schemaVersion: '2',
        workspaceExports: { aaaa: fresh, bbbb: stale, cccc: succeededLongAgo },
      },
      now,
    );
    expect(Object.keys(pruned.workspaceExports ?? {})).toEqual(['aaaa']);
    // Boundary: exactly at the max age is kept; one day older is dropped.
    const edge = new Date(now - WORKSPACE_EXPORT_STATE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const prunedEdge = pruneWorkspaceExports(
      { consent: 'granted', consentVersion: '1', schemaVersion: '2', workspaceExports: { aaaa: { lastAttemptedAt: edge } } },
      now,
    );
    expect(Object.keys(prunedEdge.workspaceExports ?? {})).toEqual(['aaaa']);
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

describe('workspace scope', () => {
  it('canonicalizes equivalent Windows path spellings to one scope', () => {
    const secret = generateTelemetrySecretHex();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-tel-scope-'));
    try {
      const base = dir.split(path.sep).join('/');
      const variants =
        process.platform === 'win32'
          ? [dir, base, `${base}/`, dir.toUpperCase(), base.toLowerCase(), path.join(dir, '.', 'sub', '..')]
          : [dir, base, `${base}/`];
      const scopes = new Set(variants.map((variant) => workspaceScopeIdFor(secret, variant)));
      expect(scopes.size).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('separates different workspaces and derives unlinkable daily IDs', () => {
    const secret = generateTelemetrySecretHex();
    const scopeA = workspaceScopeIdFor(secret, workspaceDir);
    const scopeB = workspaceScopeIdFor(secret, homeDir);
    expect(scopeA).not.toBe(scopeB);
    expect(scopeA).toMatch(/^[0-9a-f]{16}$/);
    // Case E (same workspace, next day) and Case F (different workspaces,
    // same day) at the derivation level.
    expect(deriveDailyTelemetryId(secret, scopeA, '2026-08-26')).not.toBe(deriveDailyTelemetryId(secret, scopeA, '2026-08-27'));
    expect(deriveDailyTelemetryId(secret, scopeA, '2026-08-26')).not.toBe(deriveDailyTelemetryId(secret, scopeB, '2026-08-26'));
  });

  it('lock filenames embed only the opaque scope key, never the workspace path', () => {
    const lockPath = workspaceExportLockPath(getProductTelemetryStatePath(homeDir), 'abcd1234abcd1234');
    expect(path.basename(lockPath)).toBe('product-telemetry.json.export-lock.abcd1234abcd1234');
    const canonical = canonicalizeWorkspacePath(workspaceDir);
    expect(lockPath).not.toContain(canonical);
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
  // A config that parses cleanly (mirrors the service-test fixture shape);
  // feature overrides are appended per test.
  const VALID_CONFIG_HEAD = [
    'version: 1',
    'runtimeProfiles:',
    '  openclaw.default:',
    '    type: openclaw',
    '    source: default',
    'internalAgents:',
    '  defaultRuntime: openclaw.default',
    '  agents:',
    '    diagnostician:',
    '      enabled: false',
    '    dreamer:',
    '      enabled: false',
    '    scribe:',
    '      enabled: false',
    '    artificer:',
    '      enabled: false',
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

  function writeWorkspaceFlagConfig(flagId: string, enabled: boolean): void {
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, '.pd', 'config.yaml'),
      `${VALID_CONFIG_HEAD}\nfeatures:\n  ${flagId}:\n    category: quiet\n    enabled: ${enabled}\n`,
    );
  }

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

  it('renders an empty workspace conservatively (evaluable false, notes recorded, never throws)', () => {
    // No DBs at all: absence of any record is a DEFINITE negative — false,
    // not unknown (review remediation P1-2).
    const { facts, notes } = readMilestoneFacts(workspaceDir);
    expect(facts.initialized).toBe(false);
    expect(facts.painObserved).toBe(false);
    expect(facts.effectReceiptObserved).toBe(false);
    expect(facts.initializationFailed).toBe(false);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes).toContain('state_db_missing');
  });

  it('marks initializationFailed only from a readable DB whose schema is definitively absent', () => {
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    const db = new Database(path.join(workspaceDir, '.pd', 'state.db'));
    db.exec('CREATE TABLE unrelated (x TEXT)');
    db.close();
    const { facts } = readMilestoneFacts(workspaceDir);
    expect(facts.initialized).toBe(false);
    expect(facts.initializationFailed).toBe(true);
  });

  it('treats an unreadable state.db as UNKNOWN, never as initializationFailed=true (review remediation)', () => {
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    const dbPath = path.join(workspaceDir, '.pd', 'state.db');
    fs.writeFileSync(dbPath, 'this is not a sqlite database at all');
    const { facts, notes } = readMilestoneFacts(workspaceDir);
    // Read failure must not fabricate an initialization failure.
    expect(facts.initializationFailed).toBeNull();
    expect(facts.initialized).toBeNull();
    expect(facts.activationObserved).toBeNull();
    expect(notes.join()).toContain('state_db_unreadable');
  });

  it('missing receipt tables in an initialized DB render receipts unknown (old-schema ambiguity)', () => {
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    const db = new Database(path.join(workspaceDir, '.pd', 'state.db'));
    db.exec('CREATE TABLE schema_version (version TEXT PRIMARY KEY); INSERT INTO schema_version VALUES (\'002\');');
    db.close();
    const { facts, notes } = readMilestoneFacts(workspaceDir);
    // The DB is readable but the receipt table does not exist (old schema):
    // absence of the table is not evidence of absence of receipts.
    expect(facts.initialized).toBe(true);
    expect(facts.presenceReceiptObserved).toBeNull();
    expect(facts.effectReceiptObserved).toBeNull();
    expect(notes.join()).toContain('state_db_unreadable');
  });

  it('renders receipt milestones unknown when receipt collection is disabled (flag off ≠ no receipts)', () => {
    seedWorkspace();
    writeWorkspaceFlagConfig('principle_receipt_ledger', false);
    const { facts, notes } = readMilestoneFacts(workspaceDir);
    // The seeded presence receipt exists, but collection being disabled means
    // absence is unprovable — unknown, never false.
    expect(facts.presenceReceiptObserved).toBeNull();
    expect(facts.effectReceiptObserved).toBeNull();
    expect(notes).toContain('receipt_collection_disabled');
  });

  it('keeps receipt milestones evaluable when only the self-report sub-flag is disabled', () => {
    seedWorkspace();
    writeWorkspaceFlagConfig('principle_receipt_self_report', false);
    const { facts, notes } = readMilestoneFacts(workspaceDir);
    // The ledger flag stays at its default (on) — milestones remain evaluable.
    expect(facts.presenceReceiptObserved).toBe(true);
    expect(facts.effectReceiptObserved).toBe(false);
    expect(notes).not.toContain('receipt_collection_disabled');
  });

  it('a malformed ledger does not poison a readable principle_candidates source (authority-first)', () => {
    seedWorkspace();
    // Corrupt the ledger AFTER seeding so candidates remain readable.
    fs.writeFileSync(path.join(workspaceDir, '.state', 'principle_training_state.json'), '{not json');
    const { facts, notes } = readMilestoneFacts(workspaceDir);
    expect(facts.principleObserved).toBe(true); // candidates row exists
    expect(notes).toContain('principle_ledger_malformed');
  });

  it('principleObserved is unknown only when BOTH sources are undeterminable', () => {
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
    // Unreadable state.db (candidates unknown) + malformed ledger → unknown.
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'state.db'), 'not a sqlite db');
    fs.writeFileSync(path.join(workspaceDir, '.state', 'principle_training_state.json'), '{not json');
    const { facts } = readMilestoneFacts(workspaceDir);
    expect(facts.principleObserved).toBeNull();
  });

  it('trajectory.db unreadable renders painObserved unknown (not false)', () => {
    fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.state', 'trajectory.db'), 'garbage');
    const { facts, notes } = readMilestoneFacts(workspaceDir);
    expect(facts.painObserved).toBeNull();
    expect(notes.join()).toContain('trajectory_db_unreadable');
  });
});

describe('export client', () => {
  const snapshot = buildProductTelemetrySnapshot({
    dailyTelemetryId: deriveDailyTelemetryId(generateTelemetrySecretHex(), deriveWorkspaceScopeId(generateTelemetrySecretHex(), '/ws'), '2026-08-26'),
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
