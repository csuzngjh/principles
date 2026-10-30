/**
 * SPEC-RULECODE-HOST-PROMOTION-001 review round 4 (P1): the CLI-channel
 * reachability probe executes the REAL built `pd activation list --json` and
 * the REAL `pd activation deactivate --dry-run` subprocesses against the
 * TARGET workspace, and reports per-capability evidence:
 *  - a governed workspace listing the expected activation → both CLI
 *    capabilities ok + matched (dry-run targets a nonexistent probe id, so
 *    nothing is deactivated and no governance audit record is written);
 *  - an expected activation the listing does NOT carry → pd_status unverified;
 *  - console-channel capabilities are ALWAYS reported not-verified from a CLI
 *    subprocess (fail closed — never fabricated as ok).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import { SqliteConnection } from '@principles/core/runtime-v2';
import { probeCliRecoveryReachability, DEACTIVATE_DRY_RUN_PROBE_ACTIVATION_ID } from '../../src/commands/recovery-reachability-probe.js';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-probe-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedActivation(activationId: string): void {
  const conn = new SqliteConnection({ workspaceDir: tempDir, readonly: false });
  const now = '2026-10-29T00:00:00.000Z';
  const db = conn.getDb();
  db.prepare("INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES ('task-probe', 'diagnosis', 'pending', ?, ?)").run(now, now);
  db.prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES ('artifact-probe', 'rule', 'task-probe', '[]', 'validated', '{}', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, deactivated_at)
    VALUES (?, 'idem-probe', 'artifact-probe', 'code_tool_hook', 'code_tool_hook_shadow_activate', 'impl://rule-probe', ?, NULL)`).run(activationId, now);
  conn.close();
}

function auditLogCount(): number {
  const logDir = path.join(tempDir, '.pd', 'logs');
  if (!fs.existsSync(logDir)) return 0;
  return fs.readdirSync(logDir).filter(name => name.endsWith('.jsonl')).reduce((total, name) => {
    const lines = fs.readFileSync(path.join(logDir, name), 'utf8').split('\n').filter(Boolean);
    return total + lines.length;
  }, 0);
}

describe('probeCliRecoveryReachability — real subprocess, per-capability evidence (SPEC R4/P1)', () => {
  beforeAll(() => {
    // The probes spawn the BUILT entry; fail loud here if the build is absent
    // so the suite never silently degrades into "unreachable" assertions.
    expect(fs.existsSync(path.resolve(process.cwd(), 'dist', 'index.js'))).toBe(true);
  });

  it('a governed workspace listing the expected activation → both CLI capabilities ok + matched; console capabilities explicitly NOT verified', { timeout: 120_000 }, async () => {
    seedActivation('act-probe-target');
    const capabilities = await probeCliRecoveryReachability(tempDir, 'act-probe-target', { timeoutMs: 60_000 });
    const byId = new Map(capabilities.map(capability => [capability.capabilityId, capability]));
    expect(byId.get('pd_status')).toMatchObject({ ok: true, workspaceMatched: true, channel: 'cli' });
    expect(byId.get('rulecode_deactivate')).toMatchObject({ ok: true, workspaceMatched: true, channel: 'cli' });
    expect(byId.get('rulecode_global_pause')).toMatchObject({ ok: false, channel: 'console' });
    expect(byId.get('owner_review_access')).toMatchObject({ ok: false, channel: 'console' });
  });

  it('the deactivate probe runs the REAL dry-run path: no activation is touched and NO governance audit record is written', { timeout: 120_000 }, async () => {
    seedActivation('act-probe-dry');
    const before = auditLogCount();
    await probeCliRecoveryReachability(tempDir, 'act-probe-dry', { timeoutMs: 60_000 });
    const after = auditLogCount();
    expect(after).toBe(before);
    // The probe id activation must not exist and nothing may have created it.
    const db = new Database(path.join(tempDir, '.pd', 'state.db'), { readonly: true });
    try {
      const row = db.prepare('SELECT 1 FROM activations WHERE activation_id = ?').get(DEACTIVATE_DRY_RUN_PROBE_ACTIVATION_ID);
      expect(row).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('an expected activation ABSENT from the listing (wrong workspace / stale probe) → pd_status unverified with precise detail', { timeout: 120_000 }, async () => {
    seedActivation('act-probe-other');
    const capabilities = await probeCliRecoveryReachability(tempDir, 'act-probe-target', { timeoutMs: 60_000 });
    const status = capabilities.find(capability => capability.capabilityId === 'pd_status');
    expect(status?.ok).toBe(false);
    expect(status?.workspaceMatched).toBe(false);
    expect(status?.detail).toContain('act-probe-target');
  });
});
