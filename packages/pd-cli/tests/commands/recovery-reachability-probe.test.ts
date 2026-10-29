/**
 * SPEC-RULECODE-HOST-PROMOTION-001 review round 3 (P1): the CLI-channel
 * reachability probe executes the REAL built `pd activation list --json`
 * subprocess against the TARGET workspace. These tests run the real probe
 * (built dist required) and pin its evidence semantics:
 *  - a governed workspace listing the expected activation → ok + matched;
 *  - an expected activation the listing does NOT carry → workspaceMatched
 *    false (a probe of the wrong workspace can never certify this one).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteConnection } from '@principles/core/runtime-v2';
import { probeCliRecoveryReachability } from '../../src/commands/recovery-reachability-probe.js';

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

describe('probeCliRecoveryReachability — real subprocess evidence (SPEC R3/P1)', () => {
  beforeAll(() => {
    // The probe spawns the BUILT entry; fail loud here if the build is absent
    // so the suite never silently degrades into "unreachable" assertions.
    expect(fs.existsSync(path.resolve(process.cwd(), 'dist', 'index.js'))).toBe(true);
  });

  it('a governed workspace whose listing carries the expected activation → ok + workspaceMatched', async () => {
    seedActivation('act-probe-target');
    const evidence = await probeCliRecoveryReachability(tempDir, 'act-probe-target');
    expect(evidence).toEqual({ source: 'cli-status-probe', ok: true, workspaceMatched: true });
  });

  it('an expected activation ABSENT from the listing (wrong workspace / stale probe) → failure with precise detail', async () => {
    seedActivation('act-probe-other');
    const evidence = await probeCliRecoveryReachability(tempDir, 'act-probe-target');
    expect(evidence.ok).toBe(false);
    expect(evidence.workspaceMatched).toBe(false);
    expect(evidence.detail).toContain('act-probe-target');
  });
});
