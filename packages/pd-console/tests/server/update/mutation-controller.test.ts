/**
 * PRI-659 — Mutation Controller migration tests + route characterization.
 *
 * Migration guarantees under test (ADR-0023 / ADR-0024 D-1):
 * 1. The controller routes, but never mutates — it cannot become a third
 *    updater or a new mutation authority.
 * 2. Exactly ONE authority (`legacy-console-updater`) is registered per
 *    mutation kind in the production singleton — no implementation was
 *    duplicated, and ReleaseManager is not yet active (fallback mode).
 * 3. Replaceability: registering `release-manager` for a kind flips routing
 *    to it with zero route-layer change (tested on a fresh controller).
 * 4. Characterization: the HTTP behavior through the controller matches the
 *    pre-refactor contract (404 unknown subPath, 405 method mismatch,
 *    degraded check response shape).
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Hoisted os mock (same pattern as update.test.ts): homedir() drives canonical
// layout resolution — without pinning it to the fixture, a real install on the
// dev machine (~/.pd/install.json) could leak into these tests.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const realHomedir = actual.homedir.bind(actual);
  return { ...actual, homedir: vi.fn(() => realHomedir()) };
});

import {
  MutationController,
  updateMutationController,
  LEGACY_MUTATION_AUTHORITY,
  RELEASE_MANAGER_AUTHORITY,
  PREFERRED_MUTATION_AUTHORITY,
  MUTATION_KINDS,
  type MutationContext,
} from '../../../src/server/update/mutation-controller.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRequest(method: string): IncomingMessage {
  return {
    method,
    url: '/api/update/test',
    on: vi.fn(),
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

function okHandler(marker: string) {
  return async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, marker }));
  };
}

const ctx: MutationContext = { workspaceDir: '/tmp/whatever' };

// ---------------------------------------------------------------------------
// Migration tests — controller semantics on fresh instances
// ---------------------------------------------------------------------------

describe('MutationController (migration semantics)', () => {
  it('fails loud when no authority is registered for a kind — no silent mutation path', async () => {
    const controller = new MutationController();
    expect(() => controller.resolveAuthority('check')).toThrow(/No mutation authority registered/);
    const req = createMockRequest('GET');
    const res = createMockResponse();
    await expect(controller.dispatch(req, res, ctx, 'check')).rejects.toThrow(/No mutation authority registered/);
  });

  it('resolves the legacy authority with fallback=true when only legacy is registered', () => {
    const controller = new MutationController();
    controller.register('check', { name: LEGACY_MUTATION_AUTHORITY, handler: okHandler('legacy') });
    const resolved = controller.resolveAuthority('check');
    expect(resolved.authority.name).toBe(LEGACY_MUTATION_AUTHORITY);
    expect(resolved.fallback).toBe(true);
  });

  it('prefers release-manager once registered — console can switch authority without route-layer change', async () => {
    const controller = new MutationController();
    const legacyCalls: string[] = [];
    const rmCalls: string[] = [];
    controller.register('apply', {
      name: LEGACY_MUTATION_AUTHORITY,
      handler: async (_req, res) => { legacyCalls.push('apply'); res.writeHead(200); res.end('{}'); },
    });
    controller.register('apply', {
      name: RELEASE_MANAGER_AUTHORITY,
      handler: async (_req, res) => { rmCalls.push('apply'); res.writeHead(200); res.end('{}'); },
    });

    const resolved = controller.resolveAuthority('apply');
    expect(resolved.authority.name).toBe(RELEASE_MANAGER_AUTHORITY);
    expect(resolved.fallback).toBe(false);

    const req = createMockRequest('POST');
    const res = createMockResponse();
    await controller.dispatch(req, res, ctx, 'apply');
    expect(rmCalls).toEqual(['apply']);
    expect(legacyCalls).toEqual([]);
  });

  it('annotates every dispatched response with X-PD-Mutation-Authority (fallback and direct variants)', async () => {
    const controller = new MutationController();
    controller.register('rollback', { name: LEGACY_MUTATION_AUTHORITY, handler: okHandler('legacy') });

    const resFallback = createMockResponse();
    await controller.dispatch(createMockRequest('POST'), resFallback, ctx, 'rollback');
    expect(resFallback._headers['x-pd-mutation-authority']).toBe(
      `${LEGACY_MUTATION_AUTHORITY} (preferred: ${RELEASE_MANAGER_AUTHORITY} not yet available)`,
    );

    controller.register('rollback', { name: RELEASE_MANAGER_AUTHORITY, handler: okHandler('rm') });
    const resDirect = createMockResponse();
    await controller.dispatch(createMockRequest('POST'), resDirect, ctx, 'rollback');
    expect(resDirect._headers['x-pd-mutation-authority']).toBe(RELEASE_MANAGER_AUTHORITY);
  });

  it('describeGovernance reports active/preferred/fallback/available per kind', () => {
    const controller = new MutationController();
    for (const kind of MUTATION_KINDS) {
      controller.register(kind, { name: LEGACY_MUTATION_AUTHORITY, handler: okHandler(kind) });
    }
    const snapshot = controller.describeGovernance();
    for (const kind of MUTATION_KINDS) {
      expect(snapshot[kind]).toEqual({
        active: LEGACY_MUTATION_AUTHORITY,
        preferred: PREFERRED_MUTATION_AUTHORITY,
        fallback: true,
        available: [LEGACY_MUTATION_AUTHORITY],
      });
    }
  });

  it('refuses to guess between multiple non-preferred, non-legacy authorities', () => {
    const controller = new MutationController();
    controller.register('apply', { name: 'something-else', handler: okHandler('x') });
    expect(() => controller.resolveAuthority('apply')).toThrow(/No preferred .* or legacy .* authority/);
  });
});

// ---------------------------------------------------------------------------
// PRI-672 — explicit fallback reasons (rc-9: degradation must be observable)
// ---------------------------------------------------------------------------

describe('MutationController fallback reasons (PRI-672)', () => {
  it('emits X-PD-Mutation-Fallback-Reason only when the fallback serves and a reason is known', async () => {
    const controller = new MutationController();
    controller.register('check', { name: LEGACY_MUTATION_AUTHORITY, handler: okHandler('legacy') });
    controller.setFallbackReason('check', 'release_manager_shadow_disabled');

    const resFallback = createMockResponse();
    await controller.dispatch(createMockRequest('GET'), resFallback, ctx, 'check');
    expect(resFallback._headers['x-pd-mutation-authority']).toContain(LEGACY_MUTATION_AUTHORITY);
    expect(resFallback._headers['x-pd-mutation-fallback-reason']).toBe('release_manager_shadow_disabled');

    // Direct preferred dispatch: no fallback, no reason header.
    controller.register('check', { name: RELEASE_MANAGER_AUTHORITY, handler: okHandler('rm') });
    const resDirect = createMockResponse();
    await controller.dispatch(createMockRequest('GET'), resDirect, ctx, 'check');
    expect(resDirect._headers['x-pd-mutation-authority']).toBe(RELEASE_MANAGER_AUTHORITY);
    expect(resDirect._headers['x-pd-mutation-fallback-reason']).toBeUndefined();

    // Clearing the reason removes the header.
    controller.setFallbackReason('check', null);
    const resCleared = createMockResponse();
    controller.register('check', { name: LEGACY_MUTATION_AUTHORITY, handler: okHandler('legacy') });
    controller.unregister('check', RELEASE_MANAGER_AUTHORITY);
    await controller.dispatch(createMockRequest('GET'), resCleared, ctx, 'check');
    expect(resCleared._headers['x-pd-mutation-fallback-reason']).toBeUndefined();
  });

  it('describeGovernance carries the fallbackReason only while a fallback with a reason serves', () => {
    const controller = new MutationController();
    controller.register('apply', { name: LEGACY_MUTATION_AUTHORITY, handler: okHandler('legacy') });
    controller.setFallbackReason('apply', 'release_manager_unavailable:rollback_not_available');
    expect(controller.describeGovernance().apply).toMatchObject({
      active: LEGACY_MUTATION_AUTHORITY,
      fallback: true,
      fallbackReason: 'release_manager_unavailable:rollback_not_available',
    });

    controller.setFallbackReason('apply', null);
    expect(controller.describeGovernance().apply.fallbackReason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Production wiring tests — the real singleton after routes/update.js loads
// ---------------------------------------------------------------------------

describe('updateMutationController (production wiring via routes/update.js)', () => {
  let tmpDir: string;
  let savedOpenclawHome: string | undefined;
  let routes: typeof import('../../../src/server/routes/update.js');

  // Import once outside the per-test timeout: the first load of the
  // routes/update.js module graph (@principles/core runtime-v2, semver, …)
  // takes well over the default 5s test timeout on a cold transform cache.
  beforeAll(async () => {
    routes = await import('../../../src/server/routes/update.js');
  }, 60_000);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-mutation-ctrl-test-'));
    // Fixture with NO plugin package.json → /check takes the degraded path,
    // which never reaches fetch (keeps this test file free of network mocks).
    fs.mkdirSync(path.join(tmpDir, 'extensions', 'principles-disciple'), { recursive: true });
    savedOpenclawHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = tmpDir;
    vi.mocked(os.homedir).mockImplementation(() => tmpDir);
  });

  afterEach(() => {
    if (savedOpenclawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = savedOpenclawHome;
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('registers exactly one authority — legacy-console-updater — for every kind (no third updater)', async () => {
    const snapshot = updateMutationController.describeGovernance();
    for (const kind of MUTATION_KINDS) {
      expect(snapshot[kind].available).toEqual([LEGACY_MUTATION_AUTHORITY]);
      expect(snapshot[kind].active).toBe(LEGACY_MUTATION_AUTHORITY);
      expect(snapshot[kind].fallback).toBe(true);
    }
  });

  it('characterization: unknown subPath still returns 404 with the same message', async () => {
    const { handleUpdateRoute } = routes;
    const req = createMockRequest('GET');
    const res = createMockResponse();
    await handleUpdateRoute(req, res, tmpDir, '/no-such-mutation');
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res._body)).toMatchObject({
      success: false,
      error: 'not_found',
      message: 'Update route not found: /no-such-mutation',
    });
  });

  it('characterization: method mismatch still returns 405 through the controller (POST /check)', async () => {
    const { handleUpdateRoute } = routes;
    const req = createMockRequest('POST');
    const res = createMockResponse();
    await handleUpdateRoute(req, res, tmpDir, '/check');
    expect(res.statusCode).toBe(405);
  });

  it('characterization: GET /apply-full returns 405 through the controller', async () => {
    const { handleUpdateRoute } = routes;
    const req = createMockRequest('GET');
    const res = createMockResponse();
    await handleUpdateRoute(req, res, tmpDir, '/apply-full');
    expect(res.statusCode).toBe(405);
  });

  it('characterization: degraded check response shape is unchanged and carries the authority header', async () => {
    const { handleUpdateRoute } = routes;
    const req = createMockRequest('GET');
    const res = createMockResponse();
    await handleUpdateRoute(req, res, tmpDir, '/check');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res._body) as Record<string, unknown>;
    // ERR-002 degraded contract (exact pre-refactor shape)
    expect(body).toEqual({
      success: true,
      data: {
        hasUpdate: false,
        currentVersion: 'unknown',
        latestVersion: '',
        codexInstalled: false,
        error: 'Could not determine current version (plugin not installed)',
      },
    });
    expect(res._headers['x-pd-mutation-authority']).toContain(LEGACY_MUTATION_AUTHORITY);
  });
});
