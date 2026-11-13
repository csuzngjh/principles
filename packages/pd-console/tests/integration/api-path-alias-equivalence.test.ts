import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { handleRequest, initServices, closeServices } from '../../src/server/index.js';

/**
 * PRI-1139 Group E equivalence contract.
 *
 * The console dispatch strips the deprecated `/api/v1/` prefix once and then
 * routes on the canonical `/api/...` form, so both spellings must reach the
 * SAME handler branch. This test drives the REAL request listener (the exact
 * function `main()` hands to http.createServer) over real HTTP sockets and
 * asserts, per route family, that the legacy and canonical spellings return
 * the same status and the same body.
 *
 * Probes are chosen to be side-effect free on an empty workspace (GETs, or a
 * POST whose body fails validation identically on both paths). The assertion
 * is EQUIVALENCE, not a specific payload: whatever the handler answers, it
 * must answer it for both spellings.
 */

const probes: readonly { method: string; path: string; body?: string }[] = [
  { method: 'GET', path: '/failed-tasks' },
  { method: 'GET', path: '/failed-tasks/no-such-id' },
  { method: 'GET', path: '/receipts' },
  { method: 'GET', path: '/receipts/counts' },
  { method: 'GET', path: '/receipts/principles/no-such-id' },
  { method: 'GET', path: '/approvals' },
  { method: 'GET', path: '/approvals/grouped' },
  { method: 'GET', path: '/approvals/no-such-id' },
  { method: 'GET', path: '/principles' },
  { method: 'GET', path: '/principles/core' },
  { method: 'GET', path: '/principles/no-such-id' },
  { method: 'GET', path: '/principles/no-such-id/governance' },
  { method: 'GET', path: '/principles/owner-decision-inbox' },
  { method: 'GET', path: '/principles/owner-decision-library' },
  { method: 'GET', path: '/config' },
  { method: 'GET', path: '/config/summary' },
  { method: 'GET', path: '/config/catalog' },
  { method: 'GET', path: '/config/readiness/no-such-name' },
  { method: 'GET', path: '/lifecycle/principles/no-such-id' },
  { method: 'GET', path: '/examiner' },
  { method: 'GET', path: '/examiner/suites' },
  { method: 'GET', path: '/activations' },
  { method: 'GET', path: '/activations/no-such-id' },
  { method: 'GET', path: '/activations/no-such-id/owner-review' },
  { method: 'GET', path: '/owner-identity' },
  { method: 'GET', path: '/governance/experience' },
  { method: 'GET', path: '/governance/queue' },
  { method: 'GET', path: '/governance/rule-candidate-bindings' },
  { method: 'GET', path: '/governance/owner-decisions' },
  { method: 'GET', path: '/governance/design-gate' },
  { method: 'GET', path: '/intent/content' },
  { method: 'GET', path: '/intent-decisions/summary' },
  { method: 'GET', path: '/onboarding' },
  { method: 'GET', path: '/evidence-chain' },
  { method: 'POST', path: '/evidence/outcomes', body: JSON.stringify({}) },
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/workspaces' },
  { method: 'GET', path: '/update/history' },
  { method: 'GET', path: '/feedback/reports' },
  // SPEC v0.8 §9.2/§9.4: both console diagnostician routes must be dispatched
  // by the real listener, not only by their own unit tests (L2 + L2b).
  { method: 'GET', path: '/diagnostician/backlog' },
  { method: 'POST', path: '/diagnostician/no-such-task/run', body: JSON.stringify({}) },
  // The alias must not invent routes: an unknown resource 404s identically.
  { method: 'GET', path: '/no-such-route' },
];

describe('PRI-1139 /api dual-path equivalence (canonical /api + deprecated /api/v1 alias)', () => {
  let server: http.Server;
  let baseUrl: string;
  let workspaceDir: string;

  beforeAll(async () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-api-alias-equiv-'));
    const services = await initServices(workspaceDir);
    server = http.createServer(handleRequest(services));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(() => resolve()));
    await closeServices();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  async function call(url: string, method: string, body?: string): Promise<{ status: number; text: string }> {
    const response = await fetch(url, {
      method,
      ...(body === undefined ? {} : { body, headers: { 'Content-Type': 'application/json' } }),
    });
    return { status: response.status, text: await response.text() };
  }

  /**
   * Some handlers stamp per-request wall-clock values (`asOf`, `generatedAt`,
   * uptime…). Equivalence is about WHICH handler answered and with what
   * payload SHAPE, so those volatile tokens are normalized before the
   * byte-level comparison — everything else must match exactly.
   */
  function normalizeVolatile(text: string): string {
    return text
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<ISO_TS>')
      .replace(/"(?:asOf|generatedAt|checkedAt|now|timestamp)"\s*:\s*"[^"]*"/g, '"$1":"<TS>"')
      .replace(/"(?:uptimeMs|durationMs|elapsedMs)"\s*:\s*\d+/g, '"$1":<MS>');
  }

  for (const probe of probes) {
    it(`${probe.method} ${probe.path}: /api/v1 alias and canonical /api answer identically`, { timeout: 30_000 }, async () => {
      const legacy = await call(`${baseUrl}/api/v1${probe.path}`, probe.method, probe.body);
      const canonical = await call(`${baseUrl}/api${probe.path}`, probe.method, probe.body);
      expect(canonical.status, `status mismatch for ${probe.method} ${probe.path}`).toBe(legacy.status);
      expect(normalizeVolatile(canonical.text), `body mismatch for ${probe.method} ${probe.path}`).toBe(normalizeVolatile(legacy.text));
    });
  }

  it('non-API paths are untouched by the alias (still 404, not reinterpreted)', { timeout: 30_000 }, async () => {
    const response = await call(`${baseUrl}/some/static/path`, 'GET');
    expect(response.status).toBe(404);
  });

  it('query strings never participate in the alias strip', { timeout: 30_000 }, async () => {
    const legacy = await call(`${baseUrl}/api/v1/failed-tasks?limit=1`, 'GET');
    const canonical = await call(`${baseUrl}/api/failed-tasks?limit=1`, 'GET');
    expect(canonical.status).toBe(legacy.status);
    expect(normalizeVolatile(canonical.text)).toBe(normalizeVolatile(legacy.text));
  });
});
