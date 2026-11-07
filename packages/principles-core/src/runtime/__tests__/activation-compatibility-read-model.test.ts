import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SqliteConnection } from '../store/sqlite-connection.js';
import { ActivationCompatibilityReadModel } from '../activation-compatibility-read-model.js';
import { createRuleArtifact, seedArtifactToDb, type TestWorkspace } from '../activation/__tests__/helpers.js';

/**
 * Persisted-workspace regression fixture (P1-3): a workspace upgraded from an
 * older PD may hold an ACTIVE owner-approved rule whose RuleCode reads
 * `input.session.recentThinking` — a contract symbol the current runtime
 * removed. The compatibility read model must detect it; it must NOT silently
 * report clean (which would let an upgrade change the rule's semantics), and
 * it must never mutate the workspace.
 */

function createBareWorkspace(): TestWorkspace {
  // Local variant of the shared helper (avoids pulling the dispatcher deps
  // we do not need here) — same real-SQLite production stores.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-compat-scan-'));
  fs.mkdirSync(path.join(tmpDir, '.pd'), { recursive: true });
  const connection = new SqliteConnection({ workspaceDir: tmpDir });
  connection.getDb();
  return {
    workspaceDir: tmpDir,
    connection,
    approvalStore: null as never,
    stateStore: null as never,
    artifactStore: null as never,
    cleanup: () => {
      connection.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

const LEGACY_RECENT_THINKING_CODE = `function evaluate(input, helpers) {
  var hasRecentDiagnosis = false;
  if (input.session && input.session.recentThinking === true) { hasRecentDiagnosis = true; }
  if (!hasRecentDiagnosis) {
    return { decision: 'requireApproval', matched: true, reason: 'no recent diagnosis evidence' };
  }
  return { decision: 'allow', matched: false };
}`;

const CLEAN_V2_CODE = `function evaluate(input, helpers) {
  var h = input.context && input.context.history;
  if (h && h.status === 'available' && h.recentCalls.length > 0) {
    return { decision: 'requireApproval', matched: true, reason: 'diagnosis evidence present' };
  }
  return { decision: 'allow', matched: false, reason: 'cannot verify: history unavailable' };
}`;

function seedActiveCodeToolHookRule(
  ws: TestWorkspace,
  spec: { artifactId: string; ruleId: string; implementationCode: string; activationId: string },
): void {
  const { artifactId, ruleId, implementationCode, activationId } = spec;
  const artifact = createRuleArtifact({
    artifactId,
    sourceRuleId: ruleId,
    contentJson: JSON.stringify({
      ruleId,
      implementationCode,
      ruleHostGateDecision: 'accepted_shadow',
      affectedTools: ['write_file'],
    }),
  });
  seedArtifactToDb(ws, artifact);
  const db = ws.connection.getDb();
  db.prepare(`
    INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, promoted_at, deactivated_at)
    VALUES (?, ?, ?, 'code_tool_hook', 'code_tool_hook_shadow_activate', ?, ?, NULL, NULL)
  `).run(activationId, `idem-${activationId}`, artifactId, ruleId, new Date().toISOString());
}

describe('ActivationCompatibilityReadModel', () => {
  it('detects an active rule that reads the retired recentThinking contract', () => {
    const ws = createBareWorkspace();
    try {
      seedActiveCodeToolHookRule(ws, { artifactId: 'art-legacy-1', ruleId: 'rule-real-diagnosis-first', implementationCode: LEGACY_RECENT_THINKING_CODE, activationId: 'act-legacy-1' });
      const result = new ActivationCompatibilityReadModel({ workspaceDir: ws.workspaceDir }).scan();
      expect(result.ok).toBe(false);
      expect(result.status).toBe('legacy_dependency');
      expect(result.scannedActivations).toBe(1);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        symbol: 'recentThinking',
        ruleId: 'rule-real-diagnosis-first',
        activationId: 'act-legacy-1',
        channel: 'code_tool_hook',
      });
      expect(result.reason).toBe('legacy_rule_contract_dependency');
      expect(result.nextAction).toContain('Migrate or deactivate');
    } finally {
      ws.cleanup();
    }
  });

  it('passes a clean RuleContextV2-only active rule', () => {
    const ws = createBareWorkspace();
    try {
      seedActiveCodeToolHookRule(ws, { artifactId: 'art-clean-1', ruleId: 'rule-clean-v2', implementationCode: CLEAN_V2_CODE, activationId: 'act-clean-1' });
      const result = new ActivationCompatibilityReadModel({ workspaceDir: ws.workspaceDir }).scan();
      expect(result.ok).toBe(true);
      expect(result.status).toBe('clean');
      expect(result.findings).toEqual([]);
    } finally {
      ws.cleanup();
    }
  });

  it('ignores deactivated rules (only active activations block upgrades)', () => {
    const ws = createBareWorkspace();
    try {
      seedActiveCodeToolHookRule(ws, { artifactId: 'art-legacy-2', ruleId: 'rule-retired-old', implementationCode: LEGACY_RECENT_THINKING_CODE, activationId: 'act-legacy-2' });
      ws.connection.getDb().prepare(
        'UPDATE activations SET deactivated_at = ? WHERE activation_id = ?',
      ).run(new Date().toISOString(), 'act-legacy-2');
      const result = new ActivationCompatibilityReadModel({ workspaceDir: ws.workspaceDir }).scan();
      expect(result.status).toBe('clean');
      expect(result.scannedActivations).toBe(0);
    } finally {
      ws.cleanup();
    }
  });

  it('treats a workspace without state.db as a clean pass (fresh install)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-compat-empty-'));
    try {
      const result = new ActivationCompatibilityReadModel({ workspaceDir: tmpDir }).scan();
      expect(result.ok).toBe(true);
      expect(result.status).toBe('no_state_db');
      // Side-effect-free: no state.db was created by the scan (EP-02).
      expect(fs.existsSync(path.join(tmpDir, '.pd', 'state.db'))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('never mutates the scanned workspace (activations and artifacts intact)', () => {
    const ws = createBareWorkspace();
    try {
      seedActiveCodeToolHookRule(ws, { artifactId: 'art-legacy-3', ruleId: 'rule-kept-3', implementationCode: LEGACY_RECENT_THINKING_CODE, activationId: 'act-legacy-3' });
      const result = new ActivationCompatibilityReadModel({ workspaceDir: ws.workspaceDir }).scan();
      expect(result.ok).toBe(false);
      const db = ws.connection.getDb();
      const activations = db.prepare('SELECT COUNT(*) AS n FROM activations').get() as { n: number };
      const artifacts = db.prepare('SELECT COUNT(*) AS n FROM pi_artifacts').get() as { n: number };
      expect(activations.n).toBe(1);
      expect(artifacts.n).toBeGreaterThanOrEqual(1);
    } finally {
      ws.cleanup();
    }
  });
});
