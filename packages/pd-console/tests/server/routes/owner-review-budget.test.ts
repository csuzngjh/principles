/**
 * PRI-1202 — normal path still answers 200 with the derived probe budget.
 *
 * The owner-review route awaits the CLI recovery probes inside the shared
 * console request budget. This drives the REAL HTTP listener (the listener
 * `handleRequest` hands to `http.createServer`) against a seeded activation
 * and asserts the route still returns 200 with the review payload, so the
 * budget derivation did not turn the normal path into a timeout/error.
 *
 * The probes are stubbed to resolve immediately: their own budget is proven
 * by `cli-recovery-probe-budget.test.ts` and
 * `request-budget-authority.test.ts`; this test owns the route-level 200.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@principles/host-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@principles/host-runtime')>();
  return {
    ...actual,
    resolveCliRecoveryEntry: () => 'unused-mocked-cli-entry',
    probeCliActivationStatus: async () => ({ capabilityId: 'pd_status', channel: 'cli', ok: true, workspaceMatched: true }),
    probeCliDeactivateDryRun: async () => ({ capabilityId: 'rulecode_deactivate', channel: 'cli', ok: true, workspaceMatched: true }),
  };
});

import { AuthConfig } from '../../../src/server/config/AuthConfig.js';
import { closeServices, handleRequest, initServices } from '../../../src/server/index.js';
import { SqliteConnection } from '@principles/core/runtime';

const ACTIVATION_ID = 'act-budget';

function seedShadowActivation(workspaceDir: string): void {
  const conn = new SqliteConnection({ workspaceDir, readonly: false });
  const db = conn.getDb();
  const now = '2026-11-13T00:00:00.000Z';
  db.prepare("INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES ('task-budget', 'diagnosis', 'pending', ?, ?)").run(now, now);
  db.prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES ('artifact-budget', 'rule', 'task-budget', 'rule-budget', '["parent-1"]', 'validated', ?, ?, ?)`)
    .run(JSON.stringify({ implementationCode: 'function evaluate(input) { return { decision: \'allow\', matched: false, reason: \'neutral\' }; }' }), now, now);
  db.prepare(`INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, deactivated_at)
    VALUES (?, 'idem-budget', 'artifact-budget', 'code_tool_hook', 'code_tool_hook_shadow_activate', 'impl://rule-budget', ?, NULL)`).run(ACTIVATION_ID, now);
  db.prepare("INSERT INTO activation_control_states (activation_id, enforcement, version, updated_at) VALUES (?, 'eligible', 1, ?)").run(ACTIVATION_ID, now);
  conn.close();
}

describe('PRI-1202 owner-review route under the shared request budget', () => {
  let server: http.Server;
  let baseUrl: string;
  let workspaceDir: string;

  beforeAll(async () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-owner-review-budget-'));
    seedShadowActivation(workspaceDir);
    const services = await initServices(workspaceDir, new AuthConfig({ noAuth: true }));
    server = http.createServer(handleRequest(services));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    await closeServices();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('returns 200 with the review payload instead of a 504', { timeout: 30_000 }, async () => {
    const response = await fetch(`${baseUrl}/api/activations/${ACTIVATION_ID}/owner-review`);
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const body: unknown = JSON.parse(text);
    if (typeof body !== 'object' || body === null || !('data' in body)) throw new Error(`unexpected body: ${text}`);
    const data = body.data;
    if (typeof data !== 'object' || data === null || !('activation' in data)) throw new Error(`unexpected data: ${text}`);
    const activation = data.activation;
    if (typeof activation !== 'object' || activation === null || !('activationId' in activation)) throw new Error(`unexpected activation: ${text}`);
    expect(activation.activationId).toBe(ACTIVATION_ID);
  });
});
