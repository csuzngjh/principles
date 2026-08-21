/**
 * Legacy RuleHost contract backstop (P1-3, 2026-08-19; P0-1 2026-08-20).
 *
 * Persisted-workspace regression fixture: a workspace upgraded from an older
 * PD may hold an ACTIVE owner-approved rule whose RuleCode reads
 * `input.session.recentThinking` — a contract symbol the current runtime
 * removed. Executing it would silently change semantics (undefined reads);
 * the RuleHost load path must instead:
 *   - NEVER execute the rule (no live/shadow decision from it),
 *   - surface a skippedActivations entry with reason
 *     `legacy_rule_contract_dependency` + a migration nextAction (rc-9),
 *   - leave the workspace DB untouched (no deletion, no deactivation),
 *   - keep loading clean current-contract rules alongside it.
 *
 * P0-1 fail-closed invariant (2026-08-20): an owner-approved LIVE rule that
 * cannot run safely is NOT treated as non-existent. The merged live decision
 * becomes `block` (governance fails closed) so the caller never falls back to
 * 'allow' — see RuleHost.evaluateDetailed. A SHADOW rule remains
 * diagnostic-only and does not force a block.
 *
 * ERR refs: ERR-024/ERR-025 (real SQLite activation → artifact join → load
 * chain, not mocked helpers), ERR-088 (assert the unique skipped structure,
 * not merely the absence of blocking), ERR-002 (reason + nextAction).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteConnection, SqliteActivationStateStore, SqliteActivationSafetyStore } from '@principles/core/runtime-v2';
import type { RuleHostInput } from '@principles/core/runtime-v2';
import { RuleHost } from '../../src/core/rule-host.js';

const LEGACY_RULE_ID = 'rule-real-diagnosis-first-490a7eb9';
const LEGACY_ARTIFACT_ID = 'pi-art-rule-rule-real-diagnosis-first';
const LEGACY_ACTIVATION_ID = 'act_code_rule-real-diagnosis-first-490a7eb9';

// Verbatim pattern from the live workspace rule that read the retired
// contract (see PD_LEGACY_RESIDUE_AUDIT §6.3).
const LEGACY_RECENT_THINKING_CODE = `
function evaluate(input, helpers) {
  var hasRecentDiagnosis = false;
  if (input.session && input.session.recentThinking === true) { hasRecentDiagnosis = true; }
  if (!hasRecentDiagnosis) {
    return { decision: 'requireApproval', matched: true, reason: 'no recent diagnosis evidence' };
  }
  return { decision: 'allow', matched: false };
}
var meta = { name: 'real-diagnosis-first', version: '1', ruleId: '${LEGACY_RULE_ID}', coversCondition: 'all' };
`;

const CLEAN_RULE_ID = 'rule-clean-current-contract';
const CLEAN_ARTIFACT_ID = 'art-clean-current-contract';
const CLEAN_ACTIVATION_ID = 'act_code_rule-clean-current-contract';

const CLEAN_CODE = `
function evaluate(input, helpers) {
  var p = input.action.normalizedPath || '';
  if (p.startsWith('/etc')) {
    return { decision: 'block', matched: true, reason: 'CLEAN_BLOCK' };
  }
  return { decision: 'allow', matched: false, reason: 'Not matched' };
}
var meta = { name: 'clean-rule', version: '1', ruleId: '${CLEAN_RULE_ID}', coversCondition: 'all' };
`;

let tempWorkspaceDir: string;
let tempStateDir: string;
let sqliteConn: SqliteConnection;
let createdRuleHosts: RuleHost[] = [];

function makeRuleHost(): RuleHost {
  const host = new RuleHost(tempStateDir, { warn: () => undefined }, { workspaceDir: tempWorkspaceDir });
  createdRuleHosts.push(host);
  return host;
}

function insertRuleArtifact(artifactId: string, ruleId: string, implementationCode: string): void {
  const now = new Date().toISOString();
  sqliteConn.getDb().prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, 'rule', ?, ?, ?, '[]', 'validated', ?, ?, ?)
  `).run(
    artifactId,
    `task-${artifactId}`,
    `principle-${ruleId}`,
    ruleId,
    JSON.stringify({ ruleId, implementationCode, ruleHostGateDecision: 'accepted_shadow' }),
    now,
    now,
  );
}

async function insertLiveActivation(activationId: string, artifactId: string, ruleId: string): Promise<void> {
  await new SqliteActivationStateStore(sqliteConn).recordActivation({
    activationId,
    idempotencyKey: `${artifactId}::code_tool_hook`,
    artifactId,
    channel: 'code_tool_hook',
    action: 'code_tool_hook_live_activate',
    targetRef: `impl://${ruleId}`,
    activatedAt: new Date().toISOString(),
    deactivatedAt: null,
  });
}

function makeInput(normalizedPath: string): RuleHostInput {
  return {
    action: {
      toolName: 'write_file',
      normalizedPath,
      paramsSummary: { path: normalizedPath },
    },
    workspace: { isRiskPath: false },
    session: { sessionId: 'test-session', currentGfi: 0 },
    evolution: { epTier: 1 },
    derived: { estimatedLineChanges: 1, bashRisk: 'safe' as const },
  };
}

beforeEach(() => {
  tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rulehost-legacy-'));
  tempStateDir = path.join(tempWorkspaceDir, '.principles');
  fs.mkdirSync(tempStateDir, { recursive: true });
  sqliteConn = new SqliteConnection(tempWorkspaceDir);
  sqliteConn.getDb();
  createdRuleHosts = [];
});

afterEach(() => {
  for (const host of createdRuleHosts) {
    try { host.dispose(); } catch { /* best-effort */ }
  }
  createdRuleHosts = [];
  try { sqliteConn?.close(); } catch { /* Windows */ }
  try { fs.rmSync(tempWorkspaceDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

describe('RuleHost retired-contract backstop (persisted workspace)', () => {
  it('global pause suppresses live enforcement without changing per-rule eligibility, and release resumes eligible rules', async () => {
    insertRuleArtifact(CLEAN_ARTIFACT_ID, CLEAN_RULE_ID, CLEAN_CODE);
    await insertLiveActivation(CLEAN_ACTIVATION_ID, CLEAN_ARTIFACT_ID, CLEAN_RULE_ID);
    const safetyStore = new SqliteActivationSafetyStore(sqliteConn);
    await safetyStore.pauseAllLive({
      decisionId: 'pause-decision', subject: { kind: 'all_live_rulecode' }, decision: 'global_emergency_pause',
      principal: { kind: 'break_glass', reason: 'local_no_auth_emergency' }, authentication: { method: 'local_break_glass' },
      reasonCode: 'e2e_emergency', note: null, evidenceSnapshotId: null, decidedAt: '2026-08-21T00:00:00.000Z',
    }, 'pause-1', 'pause-idempotency');
    const ruleHost = makeRuleHost();

    const paused = ruleHost.evaluateDetailed(makeInput('/etc/passwd'));
    expect(paused.liveDecision).toBeUndefined();
    expect(paused.skippedActivations).toEqual([expect.objectContaining({
      activationId: CLEAN_ACTIVATION_ID,
      reason: 'global_rulecode_pause_active',
    })]);
    await expect(safetyStore.getControlState(CLEAN_ACTIVATION_ID)).resolves.toMatchObject({ enforcement: 'eligible' });

    await safetyStore.releaseGlobalPause({
      decisionId: 'release-decision', subject: { kind: 'all_live_rulecode' }, decision: 'global_emergency_pause_release',
      principal: { kind: 'configured_owner', ownerId: 'owner-1' }, authentication: { method: 'console_token', credentialId: 'console-1' },
      reasonCode: 'incident_reviewed', note: 'Resume only eligible rules.', evidenceSnapshotId: null, decidedAt: '2026-08-21T00:01:00.000Z',
    }, { pauseId: 'pause-1', expectedVersion: 1, idempotencyKey: 'release-idempotency' });

    expect(ruleHost.evaluateDetailed(makeInput('/etc/passwd')).liveDecision).toMatchObject({ decision: 'block' });
  });

  it('skips a safety-isolated live rule with an observable recovery action', async () => {
    insertRuleArtifact(CLEAN_ARTIFACT_ID, CLEAN_RULE_ID, CLEAN_CODE);
    await insertLiveActivation(CLEAN_ACTIVATION_ID, CLEAN_ARTIFACT_ID, CLEAN_RULE_ID);
    sqliteConn.getDb().prepare(`
      UPDATE activation_control_states
      SET enforcement = 'safety_isolated', isolation_decision_id = 'decision-isolate', version = 2, updated_at = ?
      WHERE activation_id = ?
    `).run(new Date().toISOString(), CLEAN_ACTIVATION_ID);

    const report = makeRuleHost().evaluateDetailed(makeInput('/etc/passwd'));

    expect(report.liveDecision).toBeUndefined();
    expect(report.liveDecisionActivationId).toBeUndefined();
    expect(report.skippedActivations).toEqual([
      expect.objectContaining({
        activationId: CLEAN_ACTIVATION_ID,
        ruleId: CLEAN_RULE_ID,
        mode: 'live',
        reason: expect.stringContaining('activation_safety_isolated'),
        nextAction: expect.stringMatching(/recover.*shadow/i),
      }),
    ]);
  });

  it('does not infer eligibility when the control authority row is missing', async () => {
    insertRuleArtifact(CLEAN_ARTIFACT_ID, CLEAN_RULE_ID, CLEAN_CODE);
    await insertLiveActivation(CLEAN_ACTIVATION_ID, CLEAN_ARTIFACT_ID, CLEAN_RULE_ID);
    sqliteConn.getDb().prepare('DELETE FROM activation_control_states WHERE activation_id = ?').run(CLEAN_ACTIVATION_ID);

    const report = makeRuleHost().evaluateDetailed(makeInput('/etc/passwd'));

    expect(report.liveDecision).toBeUndefined();
    expect(report.skippedActivations).toEqual([
      expect.objectContaining({
        activationId: CLEAN_ACTIVATION_ID,
        reason: 'activation_control_state_invalid',
        nextAction: expect.stringContaining('Repair'),
      }),
    ]);
  });

  it('Case A: a single incompatible LIVE rule is skipped and fails open', async () => {
    insertRuleArtifact(LEGACY_ARTIFACT_ID, LEGACY_RULE_ID, LEGACY_RECENT_THINKING_CODE);
    await insertLiveActivation(LEGACY_ACTIVATION_ID, LEGACY_ARTIFACT_ID, LEGACY_RULE_ID);

    const ruleHost = makeRuleHost();
    const report = ruleHost.evaluateDetailed(makeInput('/etc/passwd'));

    expect(report.liveDecision).toBeUndefined();
    expect(report.liveDecisionActivationId).toBeUndefined();
    expect(report.shadowDecisions).toHaveLength(0);

    // ERR-088: assert the unique skipped structure, not just absence.
    expect(report.skippedActivations).toHaveLength(1);
    const skip = report.skippedActivations[0]!;
    expect(skip.activationId).toBe(LEGACY_ACTIVATION_ID);
    expect(skip.ruleId).toBe(LEGACY_RULE_ID);
    expect(skip.mode).toBe('live');
    expect(skip.reason).toContain('legacy_rule_contract_dependency');
    expect(skip.reason).toContain('recentThinking');
    expect(skip.nextAction).toContain('Migrate the RuleCode');
    expect(skip.nextAction).toContain('deactivate');
  });

  it('the workspace DB is not mutated: activation row and artifact survive intact', async () => {
    insertRuleArtifact(LEGACY_ARTIFACT_ID, LEGACY_RULE_ID, LEGACY_RECENT_THINKING_CODE);
    await insertLiveActivation(LEGACY_ACTIVATION_ID, LEGACY_ARTIFACT_ID, LEGACY_RULE_ID);

    const ruleHost = makeRuleHost();
    ruleHost.evaluate(makeInput('/etc/passwd'));

    const db = sqliteConn.getDb();
    const activation = db.prepare(
      'SELECT deactivated_at FROM activations WHERE activation_id = ?',
    ).get(LEGACY_ACTIVATION_ID) as { deactivated_at: string | null } | undefined;
    expect(activation).toBeDefined();
    expect(activation!.deactivated_at).toBeNull();
    const artifact = db.prepare(
      'SELECT content_json FROM pi_artifacts WHERE artifact_id = ?',
    ).get(LEGACY_ARTIFACT_ID) as { content_json: string } | undefined;
    expect(artifact).toBeDefined();
    expect(artifact!.content_json).toContain('recentThinking');
  });

  it('Case C/D: incompatible LIVE is skipped while a healthy LIVE block remains authoritative', async () => {
    insertRuleArtifact(LEGACY_ARTIFACT_ID, LEGACY_RULE_ID, LEGACY_RECENT_THINKING_CODE);
    await insertLiveActivation(LEGACY_ACTIVATION_ID, LEGACY_ARTIFACT_ID, LEGACY_RULE_ID);
    insertRuleArtifact(CLEAN_ARTIFACT_ID, CLEAN_RULE_ID, CLEAN_CODE);
    await insertLiveActivation(CLEAN_ACTIVATION_ID, CLEAN_ARTIFACT_ID, CLEAN_RULE_ID);

    const ruleHost = makeRuleHost();
    const report = ruleHost.evaluateDetailed(makeInput('/etc/passwd'));

    expect(report.liveDecision?.decision).toBe('block');
    expect(report.liveDecision?.reason).toBe('CLEAN_BLOCK');
    expect(report.liveDecision?.ruleId).toBe(CLEAN_RULE_ID);
    expect(report.liveDecisionActivationId).toBe(CLEAN_ACTIVATION_ID);
    const skippedIds = report.skippedActivations.map(s => s.activationId);
    expect(skippedIds).toContain(LEGACY_ACTIVATION_ID);
    expect(skippedIds).not.toContain(CLEAN_ACTIVATION_ID);
  });

  it('Case C: incompatible LIVE plus healthy allow remains fail open', async () => {
    const allowCode = `
function evaluate(input, helpers) {
  return { decision: 'allow', matched: false, reason: 'Not matched' };
}
var meta = { name: 'allow-rule', version: '1', ruleId: 'rule-clean-allow', coversCondition: 'all' };
`;
    insertRuleArtifact(LEGACY_ARTIFACT_ID, LEGACY_RULE_ID, LEGACY_RECENT_THINKING_CODE);
    await insertLiveActivation(LEGACY_ACTIVATION_ID, LEGACY_ARTIFACT_ID, LEGACY_RULE_ID);
    insertRuleArtifact('art-clean-allow', 'rule-clean-allow', allowCode);
    await insertLiveActivation('act-clean-allow', 'art-clean-allow', 'rule-clean-allow');

    const ruleHost = makeRuleHost();
    const report = ruleHost.evaluateDetailed(makeInput('/etc/passwd'));

    expect(report.liveDecision).toBeUndefined();
    expect(report.liveDecisionActivationId).toBeUndefined();
  });

  it('Case B: a legacy SHADOW rule is diagnostic-only and does NOT force a live block', async () => {
    const shadowArtifactId = 'art-shadow-legacy';
    const shadowActivationId = 'act-shadow-legacy';
    insertRuleArtifact(shadowArtifactId, 'rule-shadow-legacy', LEGACY_RECENT_THINKING_CODE);
    await new SqliteActivationStateStore(sqliteConn).recordActivation({
      activationId: shadowActivationId,
      idempotencyKey: `${shadowArtifactId}::code_tool_hook`,
      artifactId: shadowArtifactId,
      channel: 'code_tool_hook',
      action: 'code_tool_hook_shadow_activate',
      targetRef: 'impl://rule-shadow-legacy',
      activatedAt: new Date().toISOString(),
      deactivatedAt: null,
    });

    const ruleHost = makeRuleHost();
    const report = ruleHost.evaluateDetailed(makeInput('/etc/passwd'));

    // Shadow is observation-only: no live enforcement, but a structured
    // skipped diagnostic naming the blocking symbol (rc-9).
    expect(report.liveDecision).toBeUndefined();
    expect(report.skippedActivations).toHaveLength(1);
    const skip = report.skippedActivations[0]!;
    expect(skip.mode).toBe('shadow');
    expect(skip.reason).toContain('legacy_rule_contract_dependency');
    expect(skip.reason).toContain('recentThinking');
    expect(skip.nextAction).toContain('Migrate the RuleCode');
  });

  it('Case E: a deactivated legacy rule is not reported (only active rules block)', async () => {
    insertRuleArtifact(LEGACY_ARTIFACT_ID, LEGACY_RULE_ID, LEGACY_RECENT_THINKING_CODE);
    await insertLiveActivation(LEGACY_ACTIVATION_ID, LEGACY_ARTIFACT_ID, LEGACY_RULE_ID);
    await new SqliteActivationStateStore(sqliteConn).deactivateActivation(
      LEGACY_ACTIVATION_ID,
      new Date().toISOString(),
    );

    const ruleHost = makeRuleHost();
    const report = ruleHost.evaluateDetailed(makeInput('/etc/passwd'));
    expect(report.liveDecision).toBeUndefined();
    expect(report.skippedActivations.filter(s => s.reason.includes('legacy_rule_contract_dependency'))).toHaveLength(0);
  });

  it('helper-form usage is skipped and fails open', async () => {
    const helperCode = `
function evaluate(input, helpers) {
  if (helpers.getPlanStatus() !== 'READY' || helpers.hasPlanFile()) {
    return { decision: 'block', matched: true, reason: 'plan not ready' };
  }
  return { decision: 'allow', matched: false };
}
`;
    insertRuleArtifact('art-helper-legacy', 'rule-plan-gate-old', helperCode);
    await insertLiveActivation('act-helper-legacy', 'art-helper-legacy', 'rule-plan-gate-old');

    const ruleHost = makeRuleHost();
    const report = ruleHost.evaluateDetailed(makeInput('/etc/passwd'));

    expect(report.liveDecision).toBeUndefined();
    expect(report.skippedActivations).toHaveLength(1);
    const reason = report.skippedActivations[0]!.reason;
    expect(reason).toContain('getPlanStatus');
    expect(reason).toContain('hasPlanFileHelper');
  });
});
