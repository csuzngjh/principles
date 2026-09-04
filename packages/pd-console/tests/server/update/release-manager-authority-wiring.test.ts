/**
 * PRI-672 — ReleaseManager authority wiring through the production update
 * route (ADR-0024 D-1 adoption).
 *
 * Contracts under test:
 * 1. Flag off (default): legacy serves every kind, with the machine-readable
 *    `release_manager_shadow_disabled` fallback reason — zero behavior change.
 * 2. Flag on, authority not ready: explicit fallback with structured
 *    `release_manager_unavailable:<reasons>` per kind.
 * 3. Flag on, check ready: ReleaseManager serves the governed check (header)
 *    while the response body stays byte-identical to the legacy contract.
 * 4. Failure: a ReleaseManager refusal re-annotates the explicit fallback and
 *    still serves the legacy body — no silent fallback, no partial state.
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
  checkRejection: null as (Error & { reason?: string; nextAction?: string }) | null,
  createCalls: 0,
}));

vi.mock('create-principles-disciple/dist/update/release-manager-authority.js', () => {
  type AuthorityKind = 'check' | 'apply' | 'apply-full' | 'rollback';
  return {
    RELEASE_MANAGER_AUTHORITY_KINDS: ['check', 'apply', 'apply-full', 'rollback'],
    createReleaseManagerAuthority: (options: unknown) => {
      authorityMock.createCalls += 1;
      void options;
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
        },
        installStatus: {
          layout: 'dual-slot',
          productVersion: '1.222.0',
          releaseId: 'r'.repeat(64),
          generation: 2,
          bootstrapVersion: '1.0.0',
          channel: 'stable',
        },
        kinds: {
          check: { ready: authorityMock.readiness.ready, reasons: authorityMock.readiness.reasons },
          apply: { ready: false, reasons: ['rollback_not_available'] },
          'apply-full': { ready: false, reasons: ['rollback_not_available'] },
          rollback: { ready: false, reasons: ['rollback_not_available'] },
        } satisfies Record<AuthorityKind, { ready: boolean; reasons: string[] }>,
      };
    },
    mapReleaseManagerErrorToFallback: (error: unknown) => {
      const typed = error as { reason?: string; message?: string; nextAction?: string };
      return {
        reason: typed?.reason ?? 'release_manager_check_failed',
        message: typed?.message ?? String(error),
        nextAction: typed?.nextAction ?? null,
      };
    },
  };
});

import {
  updateMutationController,
  LEGACY_MUTATION_AUTHORITY,
  MUTATION_KINDS,
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
    authorityMock.checkRejection = null;
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

  it('flag off (default): legacy serves check with the shadow-disabled fallback reason and unchanged body', async () => {
    const req = createMockRequest('GET');
    const res = createMockResponse();
    await routes.handleUpdateRoute(req, res, tmpDir, '/check');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ success: true, data: DEGRADED_LEGACY_BODY });
    expect(res._headers['x-pd-mutation-authority']).toContain(LEGACY_MUTATION_AUTHORITY);
    expect(res._headers['x-pd-mutation-fallback-reason']).toBe('release_manager_shadow_disabled');
    // Authority never even attempted while the flag is off.
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
      'release_manager_unavailable:rollback_not_available',
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
      'release_manager_unavailable:rollback_not_available',
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

    // Rollback path: flipping the flag off deregisters the preferred authority.
    fs.rmSync(path.join(tmpDir, '.pd', 'config.yaml'));
    await routes.handleUpdateRoute(createMockRequest('GET'), createMockResponse(), tmpDir, '/check');
    snapshot = updateMutationController.describeGovernance();
    for (const kind of MUTATION_KINDS) {
      expect(snapshot[kind].available).toEqual([LEGACY_MUTATION_AUTHORITY]);
      expect(snapshot[kind].fallbackReason).toBe('release_manager_shadow_disabled');
    }
  });
});
