/**
 * SPEC-RULECODE-HOST-PROMOTION-001 review round 3 (P1): isolated-environment
 * proof that the OFFICIAL out-of-band recovery path works against a BAD live
 * rule and that the shared production gate actually READS the pause the
 * official route wrote (real recovery EFFECT, not an HTTP-200 or a replay):
 *
 *   bad live rule denies writes → real emergency-pause route (break-glass)
 *   → the SAME gate now allows with the pause warning
 *   → official release (Owner decision route, expectedVersion)
 *   → enforcement resumes (deny again; no auto-revive of anything).
 *
 * The test seeds governance rows directly (fixture evidence) but performs
 * every CONTROL through the real route handler and every enforcement check
 * through the real production gate — never by mutating control state by hand.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleActivationsRoute, disposeActivationsModels } from '../../../src/server/routes/activations.js';
import { createProductionRuleHostGate } from '@principles/host-runtime';
import { SqliteConnection } from '@principles/core/runtime-v2';

function createMockRequest(method: string, options?: { body?: unknown; subPath?: string }): IncomingMessage {
  const bodyStr = options?.body !== undefined ? JSON.stringify(options.body) : '';
  return {
    method,
    url: `/api/v1/activations${options?.subPath ?? ''}`,
    [Symbol.asyncIterator]() {
      const chunks = options?.body !== undefined ? [Buffer.from(bodyStr)] : [];
      let i = 0;
      return {
        next: () =>
          i < chunks.length
            ? Promise.resolve({ value: chunks[i++], done: false })
            : Promise.resolve({ value: undefined, done: true }),
      };
    },
  } as unknown as IncomingMessage;
}

function createMockResponse(): ServerResponse & { statusCode: number; body: string } {
  const res = {
    statusCode: 0,
    body: '',
    setHeader: () => undefined,
    end(payload?: string) { this.body = payload ?? ''; },
    writeHead(code: number) { this.statusCode = code; },
  };
  return res as unknown as ServerResponse & { statusCode: number; body: string };
}

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-recovery-effect-'));
});

afterEach(() => {
  disposeActivationsModels();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** A deliberately BAD live rule: it blocks EVERY write tool call. */
const BAD_RULE_CODE = 'function evaluate(input) { const w = input.action.toolName === \'write_file\'; return { decision: w ? \'block\' : \'allow\', matched: w, reason: w ? \'bad rule blocks all writes\' : \'neutral\' }; } var meta={name:\'bad\',version:\'1\',ruleId:\'R_BAD_LIVE\',coversCondition:\'all\'};';

function seedBadLiveRule(): void {
  const conn = new SqliteConnection({ workspaceDir: tempDir, readonly: false });
  const now = '2026-10-29T00:00:00.000Z';
  const db = conn.getDb();
  db.prepare("INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES ('task-bad-live', 'diagnosis', 'pending', ?, ?)").run(now, now);
  db.prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES ('artifact-bad-live', 'rule', 'task-bad-live', 'R_BAD_LIVE', '["parent-1"]', 'validated', ?, ?, ?)`).run(JSON.stringify({ implementationCode: BAD_RULE_CODE, affectedTools: ['write_file'] }), now, now);
  db.prepare(`INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, deactivated_at)
    VALUES ('act-bad-live', 'idem-bad-live', 'artifact-bad-live', 'code_tool_hook', 'code_tool_hook_live_activate', 'impl://R_BAD_LIVE', ?, NULL)`).run(now);
  db.prepare(`INSERT INTO activation_control_states (activation_id, enforcement, version, updated_at) VALUES ('act-bad-live', 'eligible', 1, ?)`).run(now);
  conn.close();
}

interface GateOutcome { decision: 'allow' | 'deny'; warnings: string }

async function runGateOnWrite(): Promise<GateOutcome> {
  const gate = createProductionRuleHostGate({ hostKind: 'openclaw', projectDir: tempDir });
  const result = await gate({
    kind: 'before_tool_call',
    context: { workspaceDir: tempDir, sessionId: 'recovery-effect-session', toolName: 'write_file' },
    rawPayload: { toolInput: { toolName: 'write_file', params: { file_path: path.join(tempDir, 'target.txt'), content: 'x' } } },
    source: 'test:recovery-effect',
  } as never);
  return { decision: result.decision === 'deny' ? 'deny' : 'allow', warnings: (result.warnings ?? []).join('\n') };
}

describe('isolated environment — official recovery path vs a bad live rule (SPEC R3/P1)', () => {
  it('the bad rule denies writes before any recovery (the hazard is real)', async () => {
    seedBadLiveRule();
    const outcome = await runGateOnWrite();
    expect(outcome.decision).toBe('deny');
  });

  it('the REAL emergency-pause route recovers: the gate reads the official pause row and allows with the pause warning', async () => {
    seedBadLiveRule();
    const before = await runGateOnWrite();
    expect(before.decision).toBe('deny');

    const req = createMockRequest('POST', { subPath: '/emergency-pause', body: { idempotencyKey: 'recovery-effect-1', reasonCode: 'host_unusable' } });
    const res = createMockResponse();
    await handleActivationsRoute(req, res, tempDir, '/emergency-pause', {
      ownerActor: null,
      breakGlassActor: { principal: { kind: 'break_glass', reason: 'local_no_auth_emergency' }, authentication: { method: 'local_break_glass' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('paused');

    const after = await runGateOnWrite();
    expect(after.decision).toBe('allow');
    expect(after.warnings).toContain('global_rulecode_pause_active');
  });

  it('release follows the Owner decision route (expectedVersion) and enforcement resumes — nothing is auto-revived', async () => {
    seedBadLiveRule();
    const pauseReq = createMockRequest('POST', { subPath: '/emergency-pause', body: { idempotencyKey: 'recovery-effect-2', reasonCode: 'host_unusable' } });
    const pauseRes = createMockResponse();
    await handleActivationsRoute(pauseReq, pauseRes, tempDir, '/emergency-pause', {
      ownerActor: null,
      breakGlassActor: { principal: { kind: 'break_glass', reason: 'local_no_auth_emergency' }, authentication: { method: 'local_break_glass' } },
    });
    expect(pauseRes.statusCode).toBe(200);
    const pause = JSON.parse(pauseRes.body).data as { pauseId: string; version: number };

    // Official release only (no direct control-state writes in this test).
    // Release is a governance decision: break-glass may STOP enforcement but
    // never release it — the route must see the configured Owner identity.
    const releaseReq = createMockRequest('POST', { subPath: `/emergency-pause/${encodeURIComponent(pause.pauseId)}/release`, body: { idempotencyKey: 'recovery-effect-2-release', reasonCode: 'incident_resolved', expectedVersion: pause.version } });
    const releaseRes = createMockResponse();
    await handleActivationsRoute(releaseReq, releaseRes, tempDir, `/emergency-pause/${encodeURIComponent(pause.pauseId)}/release`, {
      ownerActor: { principal: { kind: 'configured_owner', ownerId: 'owner-recovery-test' }, authentication: { method: 'console_token', credentialId: 'credential-recovery-test' } },
    });
    expect(releaseRes.statusCode).toBe(200);

    const resumed = await runGateOnWrite();
    // The rule was never deactivated or auto-revived — it is still live, so
    // enforcement resumes exactly where it was.
    expect(resumed.decision).toBe('deny');
  });
});
