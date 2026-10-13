/**
 * PRI-956 (F15, R1 merge-readiness D1/D2/D3/D5): REAL-DB route tests for the
 * runtime-revocation disclosure on GET /api/v1/principles.
 *
 * Unlike the model-level tests (which only pin annotation given an ID set),
 * these drive `handlePrinciplesRoute` against a REAL workspace: a real
 * principle_training_state.json ledger plus a real state.db seeded with
 * activations rows in every lifecycle shape the review called out:
 * - deactivated old activation + active newer activation (re-activation /
 *   supersede) → NOT revoked;
 * - all activations deactivated → revoked;
 * - activations on different channels with one still active → NOT revoked
 *   (no global claim while any channel authority survives);
 * - unreadable activations table → revocationCheckUnavailable propagated,
 *   and the UI must express that runtime status cannot be confirmed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteConnection } from '@principles/core/runtime-v2';
import { handlePrinciplesRoute, disposePrinciplesModels } from '../../../src/server/routes/principles.js';

let workspaceDir: string;

function request(): IncomingMessage {
  return { method: 'GET', url: '/api/v1/principles?filter=all' } as IncomingMessage;
}

function response(): ServerResponse & { body: string; statusCode: number } {
  return {
    body: '', statusCode: 200, headersSent: false,
    writeHead: vi.fn(function (this: { statusCode: number }, code: number) { this.statusCode = code; return this; }),
    end: vi.fn(function (this: { body: string }, body?: string) { this.body = body ?? ''; return this; }),
  } as unknown as ServerResponse & { body: string; statusCode: number };
}

function seedLedger(): void {
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.state', 'principle_training_state.json'), JSON.stringify({ _tree: { principles: {
    'principle-revoked': { id: 'principle-revoked', status: 'active', text: 'All activations deactivated', triggerPattern: '', action: '', createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z' },
    'principle-reactivated': { id: 'principle-reactivated', status: 'active', text: 'Deactivated then re-activated', triggerPattern: '', action: '', createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z' },
    'principle-superseded': { id: 'principle-superseded', status: 'active', text: 'Old deactivated, newer active exists', triggerPattern: '', action: '', createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z' },
    'principle-mixed-channel': { id: 'principle-mixed-channel', status: 'active', text: 'Prompt deactivated but hook active', triggerPattern: '', action: '', createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z' },
    'principle-never-activated': { id: 'principle-never-activated', status: 'active', text: 'No activation history at all', triggerPattern: '', action: '', createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z' },
  }, rules: {}, implementations: {}, metrics: {}, lastUpdated: '2026-10-13T00:00:00.000Z' } }));
}

function seedActivations(): void {
  const connection = new SqliteConnection({ workspaceDir, readonly: false });
  const db = connection.getDb();
  const ins = db.prepare(
    'INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, promoted_at, deactivated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)'
  );
  // principle-revoked: single deactivated prompt activation
  ins.run('act-r1-prompt-deactivated', 'idem-r1', 'artifact-r1', 'prompt', 'prompt_activate', 'ledger://principle-revoked', '2026-10-13T00:00:01.000Z', '2026-10-13T00:00:02.000Z');
  // principle-reactivated: old deactivated + NEW active (re-activation)
  ins.run('act-r2-old-deactivated', 'idem-r2a', 'artifact-r2', 'prompt', 'prompt_activate', 'ledger://principle-reactivated', '2026-10-13T00:00:01.000Z', '2026-10-13T00:00:02.000Z');
  ins.run('act-r2-new-active', 'idem-r2b', 'artifact-r2', 'prompt', 'prompt_activate', 'ledger://principle-reactivated', '2026-10-13T00:00:03.000Z', null);
  // principle-superseded: old deactivated, newer active (supersede)
  ins.run('act-r3-old-deactivated', 'idem-r3a', 'artifact-r3', 'prompt', 'prompt_activate', 'ledger://principle-superseded', '2026-10-13T00:00:01.000Z', '2026-10-13T00:00:02.000Z');
  ins.run('act-r3-new-active', 'idem-r3b', 'artifact-r3', 'prompt', 'prompt_activate', 'ledger://principle-superseded', '2026-10-13T00:00:03.000Z', null);
  // principle-mixed-channel: prompt deactivated, hook still active (D2: no global claim)
  ins.run('act-r4-prompt-deactivated', 'idem-r4a', 'artifact-r4', 'prompt', 'prompt_activate', 'ledger://principle-mixed-channel', '2026-10-13T00:00:01.000Z', '2026-10-13T00:00:02.000Z');
  ins.run('act-r4-hook-active', 'idem-r4b', 'artifact-r4', 'code_tool_hook', 'code_tool_hook_shadow_activate', 'ledger://principle-mixed-channel', '2026-10-13T00:00:01.000Z', null);
  connection.close();
}

beforeEach(() => { workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-principles-revoke-')); });
afterEach(() => { disposePrinciplesModels(); fs.rmSync(workspaceDir, { recursive: true, force: true }); });

describe('PRI-956 runtime-revocation disclosure (real activations table, D1/D2/D5)', () => {
  it('revoked only when NO active activation remains; re-activation / supersede / mixed-channel stay NOT revoked', async () => {
    seedLedger();
    seedActivations();
    const res = response();
    await handlePrinciplesRoute({ req: request(), res, workspaceDir, subPath: '', featureFlags: {} });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body).data;
    const byId = new Map(data.principles.map((p: { id: string; runtimeDeactivated?: boolean }) => [p.id, p.runtimeDeactivated === true]));
    // D1: all activations deactivated → CURRENTLY revoked
    expect(byId.get('principle-revoked')).toBe(true);
    // D1: deactivate + re-activate (new active row) → NOT revoked
    expect(byId.get('principle-reactivated')).toBe(false);
    // D1: supersede (old deactivated, newer active) → NOT revoked
    expect(byId.get('principle-superseded')).toBe(false);
    // D2: one channel deactivated while another stays active → no global revocation claim
    expect(byId.get('principle-mixed-channel')).toBe(false);
    // No activation history at all → never revoked
    expect(byId.get('principle-never-activated')).toBe(false);
  });

  it('D3: an unreadable activations table propagates revocationCheckUnavailable (status cannot be confirmed)', async () => {
    seedLedger();
    // Real state.db whose activations table is BROKEN: the column the query
    // needs does not exist, so the read fails loudly at the SQL layer.
    const connection = new SqliteConnection({ workspaceDir, readonly: false });
    const db = connection.getDb();
    db.prepare('DROP TABLE activations').run();
    db.prepare('CREATE TABLE activations (unrelated_column TEXT)').run();
    connection.close();
    const res = response();
    await handlePrinciplesRoute({ req: request(), res, workspaceDir, subPath: '', featureFlags: {} });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(typeof data.revocationCheckUnavailable).toBe('string');
    expect(data.revocationCheckUnavailable).toContain('activation_query_failed');
    // D3: must not default — no principle may be flagged revoked on a failed read
    for (const p of data.principles) {
      expect(p.runtimeDeactivated ?? false).toBe(false);
    }
  });
});
