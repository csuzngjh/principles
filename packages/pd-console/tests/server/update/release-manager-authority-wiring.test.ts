/**
 * PRI-672 — ReleaseManager authority wiring through the production update
 * route (ADR-0024 D-1 adoption).
 *
 * Contracts under test:
 * 1. Default install (no config): both release_manager flags default ON
 *    (PRI-698 graduation, Owner decision 2026-09-07) — the authority is
 *    attempted and falls back explicitly per request when not ready
 *    (`release_manager_unavailable:<reasons>`).
 * 2. Explicit flags off: legacy serves every kind with
 *    `release_manager_shadow_disabled` / `release_manager_write_disabled`.
 * 3. Flag on, check ready: ReleaseManager serves the governed check (header)
 *    while the response body stays byte-identical to the legacy contract.
 * 4. Apply-full: served by ReleaseManager when ready; a PRE-transaction
 *    refusal (zero side effects) falls back to the legacy updater with the
 *    reason annotated; a post-transaction failure surfaces as the legacy
 *    failure body — no silent fallback, no partial state.
 * 5. Safety: no third mutation authority ever appears in the registry.
 *
 * The authority module is mocked here (hermetic); the real module surface is
 * type-checked against `create-principles-disciple` dist declarations and its
 * delivery is gated by delivery-surface-parity / release-target-matrix.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Hoisted os mock (same pattern as mutation-controller.test.ts): homedir()
// drives both the installed-layout resolution and the ReleaseManager pdHome —
// without pinning it to the fixture, a real install on the dev machine
// (~/.pd/install.json, ~/.openclaw overlay) could leak into these tests.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const realHomedir = actual.homedir.bind(actual);
  return { ...actual, homedir: vi.fn(() => realHomedir()) };
});

const authorityMock = vi.hoisted(() => ({
  readiness: { ready: false, reasons: ['metadata_source_unconfigured'] as string[] },
  /** PRI-698 Phase 1: structural readiness of the apply-full write path. */
  applyFullReadiness: { ready: false, reasons: ['metadata_source_unconfigured'] as string[] },
  /** Fake ReleaseManager.apply — outcome or thrown error, set per test. */
  applyImpl: null as (() => Promise<unknown>) | null,
  applyCalls: 0,
  /** PRI-729: proves the console never reaches for a rollback it cannot serve. */
  rollbackCalls: 0,
  checkRejection: null as (Error & { reason?: string; nextAction?: string }) | null,
  createThrows: false,
  createCalls: 0,
  /** Readiness reported at DISPATCH time (inside the governed check handler). */
  dispatchReadiness: null as null | { ready: boolean; reasons: string[] },
  dispatchInstallStatus: 'dual-slot' as string | null,
}));

vi.mock('create-principles-disciple/dist/update/release-manager-authority.js', () => {
  type AuthorityKind = 'check' | 'apply' | 'apply-full' | 'rollback';
  return {
    RELEASE_MANAGER_AUTHORITY_KINDS: ['check', 'apply', 'apply-full', 'rollback'],
    createReleaseManagerAuthority: (options: unknown) => {
      authorityMock.createCalls += 1;
      void options;
      if (authorityMock.createThrows) throw new Error('authority construction failed');
      const kinds = () => ({
        check: { ready: authorityMock.readiness.ready, reasons: authorityMock.readiness.reasons },
        apply: { ready: false, reasons: ['plugin_diff_not_supported'] },
        'apply-full': {
          ready: authorityMock.applyFullReadiness.ready,
          reasons: authorityMock.applyFullReadiness.reasons,
        },
        rollback: { ready: false, reasons: ['rollback_not_available'] },
      });
      const initialKinds = kinds();
      return {
        manager: {
          check: async () => {
            if (authorityMock.checkRejection !== null) throw authorityMock.checkRejection;
            return {
              channel: 'stable',
              candidate: null,
              decision: { allowed: false, direction: 'none' },
              trustedTarget: null,
              shadowComparison: { legacy: null, agrees: true, note: null },
            };
          },
          // PRI-698 Phase 1: the write orchestration entry. The mock returns
          // the configured outcome or throws the configured error.
          apply: async (options: unknown) => {
            authorityMock.applyCalls += 1;
            void options;
            if (authorityMock.applyImpl === null) throw new Error('applyImpl not configured');
            return authorityMock.applyImpl();
          },
          rollback: async () => {
            authorityMock.rollbackCalls += 1;
            // rollback() refuses in the real ReleaseManager (ROLLBACK_AVAILABLE
            // = false); if the console ever reaches it, the routing is wrong.
            throw Object.assign(new Error('rollback is not enabled yet'), {
              reason: 'shadow_mode_read_only',
              transactionOpened: false,
            });
          },
        },
        // Registration-time snapshot; a null dispatchInstallStatus simulates
        // the install state corrupting between sync and the next dispatch.
        installStatus: authorityMock.dispatchInstallStatus === null
          ? null
          : {
              layout: 'dual-slot',
              productVersion: '1.222.0',
              releaseId: 'r'.repeat(64),
              generation: 2,
              bootstrapVersion: '1.0.0',
              channel: 'stable',
            },
        kinds: authorityMock.dispatchReadiness === null ? initialKinds : kinds(),
      };
    },
    mapReleaseManagerErrorToFallback: (error: unknown) => {
      const typed = error as { reason?: string; message?: string; nextAction?: string; transactionOpened?: boolean };
      return {
        reason: typed?.reason ?? 'release_manager_check_failed',
        message: typed?.message ?? String(error),
        nextAction: typed?.nextAction ?? null,
        transactionOpened: typed?.transactionOpened === true,
      };
    },
  };
});

import {
  updateMutationController,
  LEGACY_MUTATION_AUTHORITY,
  RELEASE_MANAGER_AUTHORITY,
  MUTATION_KINDS,
  COMPAT_FALLBACK_REASON_LITERALS,
  COMPAT_FALLBACK_REASON_PREFIXES,
  isDeclaredCompatFallbackReason,
} from '../../../src/server/update/mutation-controller.js';

function createMockRequest(method: string): IncomingMessage {
  return {
    method,
    url: '/api/update/test',
    // POST handlers read the body via req.on('data'/'end'); deliver an empty
    // body immediately (the refusal paths under test only need the headers,
    // which the controller sets before the handler runs).
    on: vi.fn(function (this: unknown, event: string, callback: () => void) {
      if (event === 'end') setImmediate(callback);
    }),
    headers: {},
  } as unknown as IncomingMessage;
}

function createMockResponse(): ServerResponse & { _headers: Record<string, string>; _body: string } {
  const res = {
    headersSent: false,
    statusCode: 200,
    _headers: {} as Record<string, string>,
    _body: '',
    setHeader: vi.fn(function (this: unknown, name: string, value: string) {
      res._headers[name.toLowerCase()] = value;
      return res;
    }),
    writeHead: vi.fn(function (this: unknown, statusCode: number) {
      res.statusCode = statusCode;
      return res;
    }),
    end: vi.fn(function (this: unknown, data?: string) {
      if (data !== undefined) res._body = data;
      return res;
    }),
  } as unknown as ServerResponse & { _headers: Record<string, string>; _body: string };
  return res;
}

/**
 * PRI-702: the Owner-facing history stream of a workspace, read raw so the
 * persisted schema (not a helper's view of it) is what the assertions see.
 */
function readHistory(workspaceDir: string): Record<string, unknown>[] {
  const historyPath = path.join(workspaceDir, '.pd', 'update-history.json');
  if (!fs.existsSync(historyPath)) return [];
  return JSON.parse(fs.readFileSync(historyPath, 'utf8')) as Record<string, unknown>[];
}

const DEGRADED_LEGACY_BODY = {
  hasUpdate: false,
  currentVersion: 'unknown',
  latestVersion: '',
  codexInstalled: false,
  error: 'Could not determine current version (plugin not installed)',
};

describe('ReleaseManager authority wiring (production route, flag paths)', () => {
  let tmpDir: string;
  let savedOpenclawHome: string | undefined;
  let savedMetadataUrl: string | undefined;
  let routes: typeof import('../../../src/server/routes/update.js');

  beforeAll(async () => {
    routes = await import('../../../src/server/routes/update.js');
  }, 60_000);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rm-wiring-test-'));
    fs.mkdirSync(path.join(tmpDir, 'extensions', 'principles-disciple'), { recursive: true });
    savedOpenclawHome = process.env.OPENCLAW_HOME;
    savedMetadataUrl = process.env.PD_RELEASE_METADATA_URL;
    delete process.env.PD_RELEASE_METADATA_URL;
    process.env.OPENCLAW_HOME = tmpDir;
    vi.mocked(os.homedir).mockImplementation(() => tmpDir);
    authorityMock.readiness = { ready: false, reasons: ['metadata_source_unconfigured'] };
    authorityMock.applyFullReadiness = { ready: false, reasons: ['metadata_source_unconfigured'] };
    authorityMock.applyImpl = null;
    authorityMock.applyCalls = 0;
    authorityMock.rollbackCalls = 0;
    authorityMock.createCalls = 0;
    authorityMock.checkRejection = null;
    authorityMock.createThrows = false;
    authorityMock.dispatchReadiness = null;
    authorityMock.dispatchInstallStatus = 'dual-slot';
  });

  afterEach(() => {
    if (savedOpenclawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = savedOpenclawHome;
    if (savedMetadataUrl === undefined) delete process.env.PD_RELEASE_METADATA_URL;
    else process.env.PD_RELEASE_METADATA_URL = savedMetadataUrl;
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function enableFlag(): void {
    fs.mkdirSync(path.join(tmpDir, '.pd'), { recursive: true });
    // The pd-config contract requires runtimeProfiles + internalAgents — an
    // incomplete config fails validation wholesale and flags fall back to
    // defaults (flag off), so the fixture must be a fully valid document.
    fs.writeFileSync(
      path.join(tmpDir, '.pd', 'config.yaml'),
      [
        'version: 1',
        `workspace: { default: "${tmpDir.replace(/\\/g, '\\\\')}" }`,
        "runtimeProfiles:",
        "  'openclaw.default': { type: openclaw, source: default }",
        'internalAgents:',
        "  defaultRuntime: 'openclaw.default'",
        '  agents:',
        '    diagnostician: { enabled: true, runtimeProfile: openclaw.default }',
        '    dreamer: { enabled: true }',
        '    scribe: { enabled: true }',
        'features:',
        '  release_manager_shadow: { category: quiet, enabled: true }',
        '',
      ].join('\n'),
    );
  }

  /** PRI-698 Phase 1: shadow + write authority flags both on. */
  function enableWriteFlag(): void {
    enableFlag();
    const configPath = path.join(tmpDir, '.pd', 'config.yaml');
    fs.writeFileSync(
      configPath,
      fs.readFileSync(configPath, 'utf8').replace(
        '  release_manager_shadow: { category: quiet, enabled: true }',
        '  release_manager_shadow: { category: quiet, enabled: true }\n  release_manager_write_authority: { category: quiet, enabled: true }',
      ),
    );
  }

  it('default install (no config): shadow defaults ON, authority not ready without a metadata source → explicit fallback', async () => {
    const req = createMockRequest('GET');
    const res = createMockResponse();
    await routes.handleUpdateRoute(req, res, tmpDir, '/check');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ success: true, data: DEGRADED_LEGACY_BODY });
    expect(res._headers['x-pd-mutation-authority']).toContain(LEGACY_MUTATION_AUTHORITY);
    expect(res._headers['x-pd-mutation-fallback-reason']).toBe(
      'release_manager_unavailable:metadata_source_unconfigured',
    );
    // Default-on means the authority is ATTEMPTED (graduated shadow flag);
    // availability is preserved by the explicit per-request fallback.
    expect(authorityMock.createCalls).toBe(1);
  });

  it('explicit shadow off: legacy serves check with the shadow-disabled fallback reason and unchanged body', async () => {
    fs.mkdirSync(path.join(tmpDir, '.pd'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.pd', 'config.yaml'),
      [
        'version: 1',
        `workspace: { default: "${tmpDir.replace(/\\/g, '\\\\')}" }`,
        "runtimeProfiles:",
        "  'openclaw.default': { type: openclaw, source: default }",
        'internalAgents:',
        "  defaultRuntime: 'openclaw.default'",
        '  agents:',
        '    diagnostician: { enabled: true, runtimeProfile: openclaw.default }',
        '    dreamer: { enabled: true }',
        '    scribe: { enabled: true }',
        'features:',
        '  release_manager_shadow: { category: quiet, enabled: false }',
        '',
      ].join('\n'),
    );
    const req = createMockRequest('GET');
    const res = createMockResponse();
    await routes.handleUpdateRoute(req, res, tmpDir, '/check');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ success: true, data: DEGRADED_LEGACY_BODY });
    expect(res._headers['x-pd-mutation-authority']).toContain(LEGACY_MUTATION_AUTHORITY);
    expect(res._headers['x-pd-mutation-fallback-reason']).toBe('release_manager_shadow_disabled');
    // Authority never even attempted while the flag is explicitly off.
    expect(authorityMock.createCalls).toBe(0);
  });

  it('flag on, authority not ready: explicit fallback carries the structured readiness reasons', async () => {
    enableFlag();
    const checkRes = createMockResponse();
    await routes.handleUpdateRoute(createMockRequest('GET'), checkRes, tmpDir, '/check');
    expect(checkRes._headers['x-pd-mutation-authority']).toContain(LEGACY_MUTATION_AUTHORITY);
    expect(checkRes._headers['x-pd-mutation-fallback-reason']).toBe(
      'release_manager_unavailable:metadata_source_unconfigured',
    );

    const applyRes = createMockResponse();
    await routes.handleUpdateRoute(createMockRequest('POST'), applyRes, tmpDir, '/apply');
    expect(applyRes._headers['x-pd-mutation-fallback-reason']).toBe(
      'release_manager_unavailable:plugin_diff_not_supported',
    );
  });

  it('flag on, check ready: ReleaseManager serves under its own header while the body stays the legacy contract', async () => {
    enableFlag();
    authorityMock.readiness = { ready: true, reasons: [] };
    const req = createMockRequest('GET');
    const res = createMockResponse();
    await routes.handleUpdateRoute(req, res, tmpDir, '/check');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ success: true, data: DEGRADED_LEGACY_BODY });
    expect(res._headers['x-pd-mutation-authority']).toBe('release-manager');
    expect(res._headers['x-pd-mutation-fallback-reason']).toBeUndefined();
    // Mutation kinds stay on the legacy fallback even when check is ready.
    const applyRes = createMockResponse();
    await routes.handleUpdateRoute(createMockRequest('POST'), applyRes, tmpDir, '/apply');
    expect(applyRes._headers['x-pd-mutation-authority']).toContain(LEGACY_MUTATION_AUTHORITY);
    expect(applyRes._headers['x-pd-mutation-fallback-reason']).toBe(
      'release_manager_unavailable:plugin_diff_not_supported',
    );
  });

  it('ReleaseManager refusal: explicit fallback re-annotation, legacy body served, no partial state', async () => {
    enableFlag();
    authorityMock.readiness = { ready: true, reasons: [] };
    authorityMock.checkRejection = Object.assign(new Error('metadata refresh failed'), {
      reason: 'metadata_refresh_failed',
      nextAction: 'retry the update check',
    });
    const req = createMockRequest('GET');
    const res = createMockResponse();
    await routes.handleUpdateRoute(req, res, tmpDir, '/check');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ success: true, data: DEGRADED_LEGACY_BODY });
    expect(res._headers['x-pd-mutation-authority']).toContain(LEGACY_MUTATION_AUTHORITY);
    expect(res._headers['x-pd-mutation-fallback-reason']).toBe(
      'release_manager_unavailable:metadata_refresh_failed',
    );
  });

  it('no third mutation authority ever appears; flag off after flag on fully deregisters release-manager', async () => {
    enableFlag();
    authorityMock.readiness = { ready: true, reasons: [] };
    await routes.handleUpdateRoute(createMockRequest('GET'), createMockResponse(), tmpDir, '/check');
    let snapshot = updateMutationController.describeGovernance();
    expect(snapshot.check.available).toEqual([LEGACY_MUTATION_AUTHORITY, 'release-manager']);
    expect(snapshot.check.active).toBe('release-manager');
    expect(snapshot.check.fallback).toBe(false);

    // Rollback path: explicitly disabling BOTH flags deregisters the
    // preferred authority (the registry defaults are ON, so off requires an
    // explicit config).
    fs.writeFileSync(
      path.join(tmpDir, '.pd', 'config.yaml'),
      [
        'version: 1',
        `workspace: { default: "${tmpDir.replace(/\\/g, '\\\\')}" }`,
        "runtimeProfiles:",
        "  'openclaw.default': { type: openclaw, source: default }",
        'internalAgents:',
        "  defaultRuntime: 'openclaw.default'",
        '  agents:',
        '    diagnostician: { enabled: true, runtimeProfile: openclaw.default }',
        '    dreamer: { enabled: true }',
        '    scribe: { enabled: true }',
        'features:',
        '  release_manager_shadow: { category: quiet, enabled: false }',
        '  release_manager_write_authority: { category: quiet, enabled: false }',
        '',
      ].join('\n'),
    );
    await routes.handleUpdateRoute(createMockRequest('GET'), createMockResponse(), tmpDir, '/check');
    snapshot = updateMutationController.describeGovernance();
    for (const kind of MUTATION_KINDS) {
      expect(snapshot[kind].available).toEqual([LEGACY_MUTATION_AUTHORITY]);
      expect(snapshot[kind].fallbackReason).toBe('release_manager_shadow_disabled');
    }
  });

  it('authority module import failure falls back explicitly with installer_missing (delivery-surface gap)', async () => {
    enableFlag();
    // The wiring's dynamic import runs once per process; make THAT import fail
    // by re-importing the route module under a throwing factory for the
    // authority spec (the production catch records { state: 'missing' }).
    vi.resetModules();
    vi.doMock('create-principles-disciple/dist/update/release-manager-authority.js', () => {
      throw new Error('Cannot find module');
    });
    const freshRoutes = await import('../../../src/server/routes/update.js');
    const req = createMockRequest('GET');
    const res = createMockResponse();
    await freshRoutes.handleUpdateRoute(req, res, tmpDir, '/check');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ success: true, data: DEGRADED_LEGACY_BODY });
    expect(res._headers['x-pd-mutation-authority']).toContain(LEGACY_MUTATION_AUTHORITY);
    expect(res._headers['x-pd-mutation-fallback-reason']).toBe('installer_missing');
    // Restore the normal module registry for subsequent tests.
    vi.resetModules();
    vi.doUnmock('create-principles-disciple/dist/update/release-manager-authority.js');
  });

  it('createReleaseManagerAuthority throwing falls back explicitly with authority_module_unavailable', async () => {
    enableFlag();
    authorityMock.createThrows = true;
    const req = createMockRequest('GET');
    const res = createMockResponse();
    await routes.handleUpdateRoute(req, res, tmpDir, '/check');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ success: true, data: DEGRADED_LEGACY_BODY });
    for (const kind of MUTATION_KINDS) {
      expect(updateMutationController.describeGovernance()[kind].fallbackReason).toBe('authority_module_unavailable');
    }
  });

  it('readiness flipping between registration and dispatch re-falls-back explicitly inside the governed check', async () => {
    enableFlag();
    // Registration sync sees a READY check (authority registered); the next
    // dispatch constructs a fresh authority whose install state now fails.
    authorityMock.readiness = { ready: true, reasons: [] };
    await routes.handleUpdateRoute(createMockRequest('GET'), createMockResponse(), tmpDir, '/check');
    expect(updateMutationController.describeGovernance().check.active).toBe('release-manager');

    authorityMock.dispatchInstallStatus = null; // install state corrupt at dispatch time
    const req = createMockRequest('GET');
    const res = createMockResponse();
    await routes.handleUpdateRoute(req, res, tmpDir, '/check');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ success: true, data: DEGRADED_LEGACY_BODY });
    expect(res._headers['x-pd-mutation-authority']).toContain(LEGACY_MUTATION_AUTHORITY);
    expect(res._headers['x-pd-mutation-fallback-reason']).toBe('release_manager_unavailable:install_state_corrupt');
  });

  // ── PRI-698 Phase 1: the apply-full write path ──────────────────────────────

  it('no config at all: a ready apply-full routes to the ReleaseManager on the registry default (never release_manager_write_disabled)', async () => {
    // `release_manager_write_authority` defaults ON, so an install that never
    // configured it must NOT be pushed onto the legacy updater. The other
    // apply-full suites only cover explicit `enabled: true` / `enabled: false`,
    // which is exactly the gap this closes.
    authorityMock.readiness = { ready: true, reasons: [] };
    authorityMock.applyFullReadiness = { ready: true, reasons: [] };
    authorityMock.applyImpl = async () => ({
      kind: 'applied',
      productVersion: '1.223.0',
      transactionId: 'update-default-abcdef01',
      journalPath: path.join(tmpDir, '.pd', 'transactions', 'update-default-abcdef01.jsonl'),
    });
    const res = createMockResponse();
    await routes.handleUpdateRoute(createMockRequest('POST'), res, tmpDir, '/apply-full');
    expect(res.statusCode).toBe(200);
    expect(authorityMock.applyCalls).toBe(1);
    expect(res._headers['x-pd-mutation-authority']).toBe(RELEASE_MANAGER_AUTHORITY);
    expect(res._headers['x-pd-mutation-fallback-reason']).toBeUndefined();
    expect(updateMutationController.describeGovernance()['apply-full'].fallbackReason).toBeUndefined();
    const history = readHistory(tmpDir);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ kind: 'update', authority: RELEASE_MANAGER_AUTHORITY });
  });

  it('write flag explicitly off: structurally-ready apply-full stays legacy with release_manager_write_disabled', async () => {
    // shadow on (explicit), write authority explicitly disabled — the
    // registry default is ON, so the off case requires an explicit config.
    fs.mkdirSync(path.join(tmpDir, '.pd'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.pd', 'config.yaml'),
      [
        'version: 1',
        `workspace: { default: "${tmpDir.replace(/\\/g, '\\\\')}" }`,
        "runtimeProfiles:",
        "  'openclaw.default': { type: openclaw, source: default }",
        'internalAgents:',
        "  defaultRuntime: 'openclaw.default'",
        '  agents:',
        '    diagnostician: { enabled: true, runtimeProfile: openclaw.default }',
        '    dreamer: { enabled: true }',
        '    scribe: { enabled: true }',
        'features:',
        '  release_manager_shadow: { category: quiet, enabled: true }',
        '  release_manager_write_authority: { category: quiet, enabled: false }',
        '',
      ].join('\n'),
    );
    authorityMock.readiness = { ready: true, reasons: [] };
    authorityMock.applyFullReadiness = { ready: true, reasons: [] };
    // A /check dispatch runs the registration sync; asserting the GOVERNANCE
    // snapshot avoids executing the real legacy apply-full mutation (which
    // would reach for the npm registry) while proving the routing decision.
    await routes.handleUpdateRoute(createMockRequest('GET'), createMockResponse(), tmpDir, '/check');
    const snapshot = updateMutationController.describeGovernance()['apply-full'];
    expect(snapshot.active).toBe(LEGACY_MUTATION_AUTHORITY);
    expect(snapshot.available).toEqual([LEGACY_MUTATION_AUTHORITY]);
    expect(snapshot.fallbackReason).toBe('release_manager_write_disabled');
    // The write path was never attempted — the gate is the flag, not readiness.
    expect(authorityMock.applyCalls).toBe(0);
  });

  it('write flag on: ReleaseManager serves apply-full and the body keeps the legacy response contract', async () => {
    enableWriteFlag();
    authorityMock.readiness = { ready: true, reasons: [] };
    authorityMock.applyFullReadiness = { ready: true, reasons: [] };
    authorityMock.applyImpl = async () => ({
      kind: 'applied',
      productVersion: '1.223.0',
      transactionId: 'update-1-abcdef01',
      journalPath: '/tmp/transactions/update-1-abcdef01.jsonl',
    });
    const req = createMockRequest('POST');
    const res = createMockResponse();
    await routes.handleUpdateRoute(req, res, tmpDir, '/apply-full');
    expect(res.statusCode).toBe(200);
    expect(authorityMock.applyCalls).toBe(1);
    expect(res._headers['x-pd-mutation-authority']).toBe('release-manager');
    expect(res._headers['x-pd-mutation-fallback-reason']).toBeUndefined();
    expect(JSON.parse(res._body)).toEqual({
      success: true,
      data: {
        success: true,
        message: 'Updated to 1.223.0. Transaction update-1-abcdef01 confirmed in the journal.',
        newVersion: '1.223.0',
        requiresRestart: true,
        nextAction: 'Restart PD Console to run the updated build.',
      },
    });
    // PRI-702 (ADR-0024 D-7): the RM-served update lands in the SAME
    // Owner-facing history stream — exactly one event, under the authority
    // that actually served it (not one from the installer plus one from the
    // console, and not zero either).
    const history = readHistory(tmpDir);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      fromVersion: '1.222.0',
      toVersion: '1.223.0',
      success: true,
      kind: 'update',
      authority: 'release-manager',
      transactionId: 'update-1-abcdef01',
    });
  });

  it('an unwritable history file must not misreport a mutation that already happened (PRI-702 rc-9)', async () => {
    enableWriteFlag();
    authorityMock.readiness = { ready: true, reasons: [] };
    authorityMock.applyFullReadiness = { ready: true, reasons: [] };
    authorityMock.applyImpl = async () => ({
      kind: 'applied',
      productVersion: '1.223.0',
      transactionId: 'update-1-abcdef01',
      journalPath: '/tmp/transactions/update-1-abcdef01.jsonl',
    });
    // Make the history append fail: the path exists as a directory.
    fs.mkdirSync(path.join(tmpDir, '.pd', 'update-history.json'), { recursive: true });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = createMockResponse();
      await routes.handleUpdateRoute(createMockRequest('POST'), res, tmpDir, '/apply-full');
      // The update DID happen — the response must still say so.
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res._body) as { data: { success: boolean } };
      expect(body.data.success).toBe(true);
      // ...but the audit gap is never silent.
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('WITHOUT an update-history record'));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('write flag on: a no_update outcome maps to a success body without restart', async () => {
    enableWriteFlag();
    authorityMock.readiness = { ready: true, reasons: [] };
    authorityMock.applyFullReadiness = { ready: true, reasons: [] };
    authorityMock.applyImpl = async () => ({
      kind: 'no_update',
      note: 'already_current: release 1.222.0 is the channel pointer',
    });
    const req = createMockRequest('POST');
    const res = createMockResponse();
    await routes.handleUpdateRoute(req, res, tmpDir, '/apply-full');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res._body)).toEqual({
      success: true,
      data: {
        success: true,
        message: 'No update applied: already_current: release 1.222.0 is the channel pointer',
        requiresRestart: false,
      },
    });
    // PRI-702: legacy parity — the legacy updater records a refusal when the
    // source does not advance the installation, so the RM-served no-update
    // leaves the same trace (still exactly one event, no version movement).
    const history = readHistory(tmpDir);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      fromVersion: '1.222.0',
      toVersion: '1.222.0',
      success: false,
      kind: 'refusal',
      authority: 'release-manager',
      reason: 'already_current: release 1.222.0 is the channel pointer',
    });
  });

  it('write flag on: a ReleaseManager post-transaction failure maps onto the legacy failure body without partial state', async () => {
    enableWriteFlag();
    authorityMock.readiness = { ready: true, reasons: [] };
    authorityMock.applyFullReadiness = { ready: true, reasons: [] };
    authorityMock.applyImpl = async () => {
      // transactionOpened: the refusal happened AFTER the update transaction
      // was opened — runtime-side effects may exist, so the console must
      // surface the failure, never auto-fallback to the legacy updater.
      throw Object.assign(new Error('installer refused the payload'), {
        reason: 'apply_failed',
        nextAction: 'The runtime is unchanged. Resolve the reported cause and retry.',
        transactionOpened: true,
      });
    };
    const req = createMockRequest('POST');
    const res = createMockResponse();
    await routes.handleUpdateRoute(req, res, tmpDir, '/apply-full');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res._body)).toEqual({
      success: true,
      data: {
        success: false,
        message: 'installer refused the payload',
        reason: 'apply_failed',
        nextAction: 'The runtime is unchanged. Resolve the reported cause and retry.',
        requiresRestart: false,
      },
    });
    // PRI-702: a post-transaction failure is a real update attempt that ended
    // terminal — exactly one failure event, never a success, never a second
    // event from a fallback (this path does not fall back).
    const history = readHistory(tmpDir);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      fromVersion: '1.222.0',
      toVersion: 'failed',
      success: false,
      kind: 'failure',
      authority: 'release-manager',
      reason: 'apply_failed',
    });
    // Flipping the write flag off (explicit config) deregisters the preferred
    // authority for apply-full (rollback safety: the legacy path is always one
    // flag away). Governance-snapshot assertion — no real legacy dispatch.
    fs.writeFileSync(
      path.join(tmpDir, '.pd', 'config.yaml'),
      fs.readFileSync(path.join(tmpDir, '.pd', 'config.yaml'), 'utf8').replace(
        '  release_manager_write_authority: { category: quiet, enabled: true }',
        '  release_manager_write_authority: { category: quiet, enabled: false }',
      ),
    );
    await routes.handleUpdateRoute(createMockRequest('GET'), createMockResponse(), tmpDir, '/check');
    const afterSnapshot = updateMutationController.describeGovernance()['apply-full'];
    expect(afterSnapshot.active).toBe(LEGACY_MUTATION_AUTHORITY);
    expect(afterSnapshot.fallbackReason).toBe('release_manager_write_disabled');
  });

  it('write flag on: a PRE-transaction ReleaseManager refusal (zero side effects) falls back to the legacy updater with the reason annotated', async () => {
    enableWriteFlag();
    authorityMock.readiness = { ready: true, reasons: [] };
    authorityMock.applyFullReadiness = { ready: true, reasons: [] };
    authorityMock.applyImpl = async () => {
      // transactionOpened is false: apply() refused before opening the
      // transaction (e.g. the release pipeline has not published the signed
      // artifact targets yet). Zero side effects ⇒ the explicit fallback
      // serves the request, exactly like the governed check's precedent.
      throw Object.assign(new Error('signed artifact target not found'), {
        reason: 'metadata_refresh_failed',
        nextAction: 'Wait for the release pipeline to publish the targets, then retry.',
        transactionOpened: false,
      });
    };
    // The legacy fallback performs its own registry check — stub fetch so it
    // refuses fast (stale installer bundle ⇒ no mutation) without network.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: '1.0.0', pd: { bundledPluginVersion: '0.0.1' } }),
    })));
    try {
      const req = createMockRequest('POST');
      const res = createMockResponse();
      await routes.handleUpdateRoute(req, res, tmpDir, '/apply-full');
      expect(res.statusCode).toBe(200);
      expect(res._headers['x-pd-mutation-authority']).toContain('refused pre-transaction');
      expect(res._headers['x-pd-mutation-fallback-reason']).toBe(
        'release_manager_refused_pre_transaction:metadata_refresh_failed',
      );
      const body = JSON.parse(res._body) as { success: boolean; data: { success: boolean; reason?: string } };
      expect(body.success).toBe(true);
      expect(body.data.success).toBe(false);

      // PRI-702 (Principle 4 — one update, one history event): the RM refusal
      // itself produces NO history record (it is a routing decision, carried
      // by the response headers above). The legacy updater that actually
      // performed the mutation owns the single surviving event, and its
      // authority says so.
      const history = readHistory(tmpDir);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        success: false,
        kind: 'refusal',
        authority: 'legacy-console-updater',
      });
      expect(history[0]?.authority).not.toBe('release-manager');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // ── PRI-729: production lifecycle verification ──────────────────────────────
  //
  // The audit (docs/architecture/PRI-729-release-manager-adoption-audit.md)
  // shows the ReleaseManager cannot yet serve every kind in production. What
  // this section pins is the CONSEQUENCE the task is allowed to rely on: the
  // compatibility fallback is explicit, designed, reason-coded, fail-loud and
  // never a second authority — for all four lifecycle phases.

  /** Journal files the CONSOLE opened (the legacy updater's own transactions). */
  function legacyJournalFiles(): string[] {
    const dir = path.join(tmpDir, '.pd', 'transactions');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((name) => name.startsWith('console-'));
  }

  it('lifecycle/check — the Companion-visible wire contract is byte-identical under RM governance and under the compatibility fallback', async () => {
    // The exact subset the Desktop Companion reads
    // (pd-companion/src/lib/poller.ts → parseUpdateCheckResponse):
    // `{data:{hasUpdate:boolean, latestVersion?:string}}`.
    const companionShape = (body: unknown): { hasUpdate: boolean; latestVersion?: string } => {
      const envelope = body as { data?: unknown };
      const source = (typeof envelope.data === 'object' && envelope.data !== null
        ? envelope.data
        : body) as Record<string, unknown>;
      if (typeof source.hasUpdate !== 'boolean') throw new Error('Companion would reject: hasUpdate is not a boolean');
      if (source.latestVersion !== undefined && typeof source.latestVersion !== 'string') {
        throw new Error('Companion would reject: latestVersion is not a string');
      }
      return {
        hasUpdate: source.hasUpdate,
        ...(typeof source.latestVersion === 'string' ? { latestVersion: source.latestVersion } : {}),
      };
    };

    // (a) compatibility fallback: the authority is attempted, reports not-ready.
    const fallbackRes = createMockResponse();
    await routes.handleUpdateRoute(createMockRequest('GET'), fallbackRes, tmpDir, '/check');
    expect(fallbackRes.statusCode).toBe(200);
    expect(fallbackRes._headers['x-pd-mutation-authority']).toContain(LEGACY_MUTATION_AUTHORITY);
    expect(companionShape(JSON.parse(fallbackRes._body))).toEqual({ hasUpdate: false, latestVersion: '' });

    // (b) RM-served governed check: same bytes on the wire.
    enableFlag();
    authorityMock.readiness = { ready: true, reasons: [] };
    const governedRes = createMockResponse();
    await routes.handleUpdateRoute(createMockRequest('GET'), governedRes, tmpDir, '/check');
    expect(governedRes.statusCode).toBe(200);
    expect(governedRes._headers['x-pd-mutation-authority']).toBe(RELEASE_MANAGER_AUTHORITY);
    expect(governedRes._body).toBe(fallbackRes._body);
    expect(companionShape(JSON.parse(governedRes._body))).toEqual({ hasUpdate: false, latestVersion: '' });
  });

  it('lifecycle/apply-full — ReleaseManager performs the mutation, owns the journal, and the console opens no second transaction', async () => {
    enableWriteFlag();
    authorityMock.readiness = { ready: true, reasons: [] };
    authorityMock.applyFullReadiness = { ready: true, reasons: [] };
    authorityMock.applyImpl = async () => ({
      kind: 'applied',
      productVersion: '1.223.0',
      transactionId: 'update-1-abcdef01',
      journalPath: path.join(tmpDir, '.pd', 'transactions', 'update-1-abcdef01.jsonl'),
    });
    const res = createMockResponse();
    await routes.handleUpdateRoute(createMockRequest('POST'), res, tmpDir, '/apply-full');
    expect(res.statusCode).toBe(200);
    expect(authorityMock.applyCalls).toBe(1);
    expect(res._headers['x-pd-mutation-authority']).toBe(RELEASE_MANAGER_AUTHORITY);
    expect(res._headers['x-pd-mutation-fallback-reason']).toBeUndefined();

    // journal (ADR-0024 D-2): the RM→installer transaction is the ONLY one —
    // the console must not double-journal the same mutation.
    expect(legacyJournalFiles()).toEqual([]);

    // history (ADR-0024 D-7): exactly one Owner-visible event, correlated to
    // that transaction.
    const history = readHistory(tmpDir);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      success: true,
      kind: 'update',
      authority: RELEASE_MANAGER_AUTHORITY,
      transactionId: 'update-1-abcdef01',
    });
  });

  it('lifecycle/failure — a post-transaction failure is traceable, recorded as a failure, and never degrades to a silent legacy fallback', async () => {
    enableWriteFlag();
    authorityMock.readiness = { ready: true, reasons: [] };
    authorityMock.applyFullReadiness = { ready: true, reasons: [] };
    authorityMock.applyImpl = async () => {
      throw Object.assign(new Error('installer refused the payload'), {
        reason: 'apply_failed',
        nextAction: 'The runtime is unchanged. Resolve the reported cause and retry.',
        transactionOpened: true,
      });
    };
    const res = createMockResponse();
    await routes.handleUpdateRoute(createMockRequest('POST'), res, tmpDir, '/apply-full');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res._body) as { data: { success: boolean; reason?: string; nextAction?: string } };
    expect(body.data.success).toBe(false);
    expect(body.data.reason).toBe('apply_failed');
    expect(body.data.nextAction).toBe('The runtime is unchanged. Resolve the reported cause and retry.');

    // Fail-loud: the failure stays on the RM authority — it is NOT converted
    // into a legacy retry (the transaction was opened, so side effects may exist).
    expect(res._headers['x-pd-mutation-authority']).toBe(RELEASE_MANAGER_AUTHORITY);
    expect(res._headers['x-pd-mutation-fallback-reason']).toBeUndefined();
    expect(legacyJournalFiles()).toEqual([]);

    const history = readHistory(tmpDir);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      toVersion: 'failed',
      success: false,
      kind: 'failure',
      authority: RELEASE_MANAGER_AUTHORITY,
      reason: 'apply_failed',
      nextAction: 'The runtime is unchanged. Resolve the reported cause and retry.',
    });
  });

  it('lifecycle/rollback — served by the compatibility fallback with a declared reason, and the ReleaseManager is never asked to roll back', async () => {
    // Both flags ON and both kinds ready: the strongest possible attempt at the
    // preferred authority. rollback still must not reach it.
    enableWriteFlag();
    authorityMock.readiness = { ready: true, reasons: [] };
    authorityMock.applyFullReadiness = { ready: true, reasons: [] };
    const res = createMockResponse();
    await routes.handleUpdateRoute(createMockRequest('POST'), res, tmpDir, '/rollback');

    expect(res._headers['x-pd-mutation-authority']).toContain(LEGACY_MUTATION_AUTHORITY);
    const reason = res._headers['x-pd-mutation-fallback-reason'];
    expect(reason).toBe('release_manager_unavailable:rollback_not_available');
    // The degradation is a member of the DECLARED vocabulary, not a free-form string.
    expect(isDeclaredCompatFallbackReason(reason)).toBe(true);

    // No second authority: legacy is the only thing registered for rollback.
    const governance = updateMutationController.describeGovernance().rollback;
    expect(governance.available).toEqual([LEGACY_MUTATION_AUTHORITY]);
    expect(governance.active).toBe(LEGACY_MUTATION_AUTHORITY);
    expect(governance.fallback).toBe(true);
    // ...and ReleaseManager.rollback() (which refuses) was never invoked.
    expect(authorityMock.rollbackCalls).toBe(0);
  });

  it('every fallback the production route can produce is a declared compatibility fallback (the design is enumerable)', async () => {
    enableWriteFlag();
    authorityMock.readiness = { ready: true, reasons: [] };
    authorityMock.applyFullReadiness = { ready: true, reasons: [] };
    await routes.handleUpdateRoute(createMockRequest('GET'), createMockResponse(), tmpDir, '/check');

    const snapshot = updateMutationController.describeGovernance();
    // check / apply-full are served by the ReleaseManager when ready...
    expect(snapshot.check.fallback).toBe(false);
    expect(snapshot['apply-full'].fallback).toBe(false);

    // ...and the remaining two kinds carry an explicit, declared reason. A
    // fallback without a reason would be a silent degradation.
    const reasons: string[] = [];
    for (const kind of MUTATION_KINDS) {
      if (!snapshot[kind].fallback) continue;
      const reason = snapshot[kind].fallbackReason;
      expect(reason).toBeDefined();
      reasons.push(reason as string);
    }
    expect(reasons.sort()).toEqual([
      'release_manager_unavailable:plugin_diff_not_supported',
      'release_manager_unavailable:rollback_not_available',
    ]);
    for (const reason of reasons) {
      const declared = (COMPAT_FALLBACK_REASON_LITERALS as readonly string[]).includes(reason)
        || COMPAT_FALLBACK_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix) && reason.length > prefix.length);
      expect(declared).toBe(true);
    }
  });

  it('a change in routing is fail-loud: the new authority and reason are logged, and steady state is not re-logged', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      // Baseline (flags ON, both readies ready): check/apply-full on the
      // ReleaseManager, apply/rollback on the designed compatibility fallback.
      enableWriteFlag();
      authorityMock.readiness = { ready: true, reasons: [] };
      authorityMock.applyFullReadiness = { ready: true, reasons: [] };
      await routes.handleUpdateRoute(createMockRequest('GET'), createMockResponse(), tmpDir, '/check');

      // Transition: both flags explicitly off ⇒ every kind steps back to the
      // compatibility fallback. The CHANGE is what must be logged.
      logSpy.mockClear();
      fs.writeFileSync(
        path.join(tmpDir, '.pd', 'config.yaml'),
        [
          'version: 1',
          `workspace: { default: "${tmpDir.replace(/\\/g, '\\\\')}" }`,
          'runtimeProfiles:',
          "  'openclaw.default': { type: openclaw, source: default }",
          'internalAgents:',
          "  defaultRuntime: 'openclaw.default'",
          '  agents:',
          '    diagnostician: { enabled: true, runtimeProfile: openclaw.default }',
          '    dreamer: { enabled: true }',
          '    scribe: { enabled: true }',
          'features:',
          '  release_manager_shadow: { category: quiet, enabled: false }',
          '  release_manager_write_authority: { category: quiet, enabled: false }',
          '',
        ].join('\n'),
      );
      await routes.handleUpdateRoute(createMockRequest('GET'), createMockResponse(), tmpDir, '/check');
      const lines = logSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith('[update] /api/update/'));
      expect(lines).toEqual([
        `[update] /api/update/check → ${LEGACY_MUTATION_AUTHORITY} (compatibility fallback: release_manager_shadow_disabled)`,
        `[update] /api/update/apply → ${LEGACY_MUTATION_AUTHORITY} (compatibility fallback: release_manager_shadow_disabled)`,
        `[update] /api/update/apply-full → ${LEGACY_MUTATION_AUTHORITY} (compatibility fallback: release_manager_shadow_disabled)`,
        `[update] /api/update/rollback → ${LEGACY_MUTATION_AUTHORITY} (compatibility fallback: release_manager_shadow_disabled)`,
      ]);

      // Steady state: an unchanged decision is not re-logged (the Companion
      // polls every 6h; this records transitions, not traffic).
      logSpy.mockClear();
      await routes.handleUpdateRoute(createMockRequest('GET'), createMockResponse(), tmpDir, '/check');
      expect(logSpy.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('[update] /api/update/'))).toEqual([]);
    } finally {
      logSpy.mockRestore();
    }
  });
});
