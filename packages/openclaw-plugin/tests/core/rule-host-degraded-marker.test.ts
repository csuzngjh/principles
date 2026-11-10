/**
 * PR #1846 review follow-up (CodeRabbit): SqliteConnection's default write
 * mode AUTO-CREATES a missing state.db, so "the governance store was
 * deleted" never reached the catch-based marker — the load succeeded with
 * zero activations. RuleHost must detect the missing file BEFORE connecting
 * and leave the same durable out-of-workspace trace as the host-runtime
 * gate, while keeping the fail-open allow posture.
 *
 * os.homedir is mocked so the marker never lands in the real user home.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: vi.fn() };
});

import { RuleHost } from '../../src/core/rule-host.js';
import { markerPathFor } from '../../src/core/degraded-enforcement-marker.js';
import { SqliteConnection, SqliteActivationStateStore } from '@principles/core/runtime';
import type { RuleHostInput } from '@principles/core/runtime';

let tempWorkspaceDir: string;
let testHome: string;

function makeInput(normalizedPath: string): RuleHostInput {
  return {
    action: {
      toolName: 'write_file',
      normalizedPath,
      paramsSummary: { path: normalizedPath },
    },
    workspace: { isRiskPath: false },
    session: { sessionId: 'marker-test', currentGfi: 0 },
    evolution: { epTier: 1 },
    derived: { estimatedLineChanges: 1, bashRisk: 'safe' as const },
  };
}

describe('RuleHost degraded-enforcement marker on missing state.db (PR #1846 review)', () => {
  beforeEach(() => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rh-marker-home-'));
    vi.mocked(os.homedir).mockReturnValue(testHome);
    tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rh-marker-ws-'));
    // Deliberately NO state.db: this is the deleted-store / never-created
    // workspace case the fix must not auto-bootstrap away.
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(testHome, { recursive: true, force: true });
    fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
  });

  it('records the durable marker, warns with activation_db_not_found, and still fails open', () => {
    const warns: string[] = [];
    const host = new RuleHost(path.join(tempWorkspaceDir, '.principles'), { warn: (m?: string) => { if (m) warns.push(m); } }, { workspaceDir: tempWorkspaceDir });

    const result = host.evaluate(makeInput('/etc/passwd'));

    expect(result).toBeUndefined();
    expect(warns.some((w) => w.includes('activation_db_not_found'))).toBe(true);

    const markerPath = markerPathFor(tempWorkspaceDir);
    expect(fs.existsSync(markerPath)).toBe(true);
    const record = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    expect(record.reason).toBe('activation_db_not_found');
    expect(record.workspaceDir).toBe(path.resolve(tempWorkspaceDir));
    expect(record.occurrences).toBe(1);
    host.dispose();
  });

  it('does NOT auto-create state.db while probing for it', () => {
    const host = new RuleHost(path.join(tempWorkspaceDir, '.principles'), { warn: () => {} }, { workspaceDir: tempWorkspaceDir });
    host.evaluate(makeInput('/etc/passwd'));
    expect(fs.existsSync(path.join(tempWorkspaceDir, '.pd', 'state.db'))).toBe(false);
    host.dispose();
  });

  it('surfaces an ACTIVE activation whose pi_artifacts row is missing (PRI-1044)', async () => {
    const conn = new SqliteConnection(tempWorkspaceDir);
    const db = conn.getDb();
    const artifactId = 'art-orphan-pri1044';
    const activationId = 'act_code_orphan-pri1044';
    db.prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, 'rule', 'task-orphan-pri1044', 'P_ORPHAN', 'R_ORPHAN', '[]', 'validated', ?, '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z')
    `).run(artifactId, JSON.stringify({ ruleId: 'R_ORPHAN', implementationCode: 'module.exports = {};' }));
    await new SqliteActivationStateStore(conn).recordActivation({
      activationId,
      idempotencyKey: `${artifactId}::code_tool_hook`,
      artifactId,
      channel: 'code_tool_hook',
      action: 'code_tool_hook_shadow_activate',
      targetRef: 'impl://R_ORPHAN',
      activatedAt: new Date().toISOString(),
      deactivatedAt: null,
    });
    db.prepare('DELETE FROM pi_artifacts WHERE artifact_id = ?').run(artifactId);
    conn.close();

    const warns: string[] = [];
    const host = new RuleHost(path.join(tempWorkspaceDir, '.principles'), { warn: (m?: string) => { if (m) warns.push(m); } }, { workspaceDir: tempWorkspaceDir });
    try {
      host.evaluate(makeInput('/etc/passwd'));

      expect(warns.some((w) => w.includes('activation_artifact_missing') && w.includes(activationId))).toBe(true);
      const markerPath = markerPathFor(tempWorkspaceDir);
      expect(fs.existsSync(markerPath)).toBe(true);
      const record = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      expect(record.reason).toContain('activation_artifact_missing');
      expect(record.reason).toContain(activationId);
    } finally {
      // Release the SQLite handle before the afterEach cleanup (Windows EPERM).
      host.dispose();
    }
  });
});
