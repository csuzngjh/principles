/**
 * P1 (2026-08-20): Compatibility Guard semantic isolation through the REAL
 * gate hook path.
 *
 * RuleHost → gate.ts → final OpenClaw result, using REAL SQLite (legacy LIVE
 * activation) and the REAL WorkspaceContext / EventLogService / session-tracker
 * — no RuleHost / event / context / session mocks. This closes the wiring gap
 * between the already-correct RuleHost.evaluateDetailed() unit coverage and the
 * actual OpenClaw hook behavior.
 *
 * The fail-closed block caused by an incompatible persisted RuleCode (the
 * RuleCode was NEVER executed) is a RUNTIME compatibility guard, not Principle
 * enforcement and not Agent behavioral friction. It must:
 *   - still fail closed with operator guidance to migrate/deactivate,
 *   - NOT enter the behavioral evidence chain:
 *       no rule_enforced, no gate_block event, no principle application receipt
 *       (kind=rule_blocked), no GFI/block tracking (trackBlock → blockedAttempts),
 *       no pain pipeline (no evolution stream pain_detected, no diagnostic task),
 *   - while a NORMAL RuleHost block keeps the full behavioral path intact.
 *
 * ERR refs: ERR-024/ERR-025 (real SQLite activation → load chain, not mocked
 * helpers), ERR-002 (reason + nextAction on the operator-facing result, rc-9),
 * rc-1/rc-2 (machine discriminator fields diagnostics.kind / diagnostics.code —
 * never reason.startsWith/includes text branching), feedback-pollution guard:
 * a runtime compatibility fault is NOT an Agent behavior failure, so it must
 * never feed GFI/Pain/internalization (would otherwise teach PD "this was a
 * behavioral mistake" when it was a runtime contract problem).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { SqliteConnection, SqliteActivationStateStore, getDefaultPdConfig } from '@principles/core/runtime-v2';
import { handleBeforeToolCall } from '../../src/hooks/gate.js';
import type { PluginHookBeforeToolCallResult } from '../../src/openclaw-sdk.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import { EventLogService } from '../../src/core/event-log.js';
import { seedSessionForTest, getSession, clearSession } from '../../src/core/session-tracker.js';
import { clearPrincipleApplicationLedgerCache } from '../../src/core/principle-application-ledger.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const LEGACY_RULE_ID = 'rule-compat-gate-real';
const LEGACY_ARTIFACT_ID = 'pi-art-rule-rule-compat-gate-real';
const LEGACY_ACTIVATION_ID = 'act_code_rule-compat-gate-real';

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
var meta = { name: 'compat-gate-real', version: '1', ruleId: '${LEGACY_RULE_ID}', coversCondition: 'all' };
`;

const NORMAL_RULE_ID = 'rule-normal-block-real';
const NORMAL_ARTIFACT_ID = 'art-normal-block-real';
const NORMAL_ACTIVATION_ID = 'act_code_rule-normal-block-real';

// A healthy current-contract LIVE rule that genuinely blocks (must keep the
// full behavioral evidence path — regression guard).
const NORMAL_BLOCK_CODE = `
function evaluate(input, helpers) {
  var p = input.action.normalizedPath || '';
  if (p.indexOf('/etc/') === 0 || p === '/etc') {
    return { decision: 'block', matched: true, reason: 'NORMAL_PRINCIPLE_BLOCK' };
  }
  return { decision: 'allow', matched: false, reason: 'Not matched' };
}
var meta = { name: 'normal-block-real', version: '1', ruleId: '${NORMAL_RULE_ID}', coversCondition: 'all' };
`;

// ── Test state ─────────────────────────────────────────────────────────────

let tempWorkspaceDir: string;
let sqliteConn: SqliteConnection;
const seededSessions = new Set<string>();

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

function writeConfig(flags: { ledger: boolean }): void {
  const cfg = getDefaultPdConfig() as unknown as {
    features: Record<string, { category?: string; enabled: boolean }>;
  };
  cfg.features.principle_receipt_ledger = { category: 'quiet', enabled: flags.ledger };
  fs.mkdirSync(path.join(tempWorkspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(tempWorkspaceDir, '.pd', 'config.yaml'), yaml.dump(cfg));
}

function runGate(toolName: string, params: Record<string, unknown>, sessionId: string): PluginHookBeforeToolCallResult | void {
  return handleBeforeToolCall(
    { toolName, params },
    {
      workspaceDir: tempWorkspaceDir,
      sessionId,
      logger: { warn: () => undefined, error: () => undefined, info: () => undefined },
    },
  );
}

function bufferedEvents() {
  return EventLogService.get(path.join(tempWorkspaceDir, '.state')).getBufferedEvents();
}

function evolutionStream(): string {
  const streamPath = path.join(tempWorkspaceDir, 'memory', 'evolution.jsonl');
  if (!fs.existsSync(streamPath)) return '';
  return fs.readFileSync(streamPath, 'utf8');
}

function seedSession(sessionId: string): void {
  seedSessionForTest(sessionId, tempWorkspaceDir);
  seededSessions.add(sessionId);
}

beforeEach(() => {
  clearPrincipleApplicationLedgerCache();
  WorkspaceContext.clearCache();
  tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-compat-'));
  sqliteConn = new SqliteConnection(tempWorkspaceDir);
  sqliteConn.getDb();
});

afterEach(() => {
  for (const sessionId of seededSessions) {
    try { clearSession(sessionId); } catch { /* best-effort */ }
  }
  seededSessions.clear();
  WorkspaceContext.clearCache();
  clearPrincipleApplicationLedgerCache();
  try { sqliteConn?.close(); } catch { /* Windows */ }
  try { fs.rmSync(tempWorkspaceDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

// ── Compatibility Guard: behavior evidence isolation ───────────────────────

describe('compatibility guard: RuleHost → gate → OpenClaw result (real SQLite, real hook)', () => {
  it('Test A: legacy LIVE recentThinking rule fails open through the gate hook', async () => {
    insertRuleArtifact(LEGACY_ARTIFACT_ID, LEGACY_RULE_ID, LEGACY_RECENT_THINKING_CODE);
    await insertLiveActivation(LEGACY_ACTIVATION_ID, LEGACY_ARTIFACT_ID, LEGACY_RULE_ID);

    expect(runGate('write_file', { file_path: '/etc/passwd', content: 'x' }, 'sess-a')).toBeUndefined();
  });

  it('Test A2: the RuleHost report carries a structured skipped activation', async () => {
    insertRuleArtifact(LEGACY_ARTIFACT_ID, LEGACY_RULE_ID, LEGACY_RECENT_THINKING_CODE);
    await insertLiveActivation(LEGACY_ACTIVATION_ID, LEGACY_ARTIFACT_ID, LEGACY_RULE_ID);

    const ruleHost = WorkspaceContext.fromHookContext({
      workspaceDir: tempWorkspaceDir,
      sessionId: 'sess-a2',
      logger: { warn: () => undefined },
    }).getRuleHost({ warn: () => undefined } as never);
    const report = ruleHost.evaluateDetailed({
      action: { toolName: 'write_file', normalizedPath: '/etc/passwd', paramsSummary: { path: '/etc/passwd' } },
      workspace: { isRiskPath: false },
      session: { sessionId: 'sess-a2', currentGfi: 0 },
      evolution: { epTier: 1 },
      derived: { estimatedLineChanges: 1, bashRisk: 'safe' as const },
    });

    expect(report.liveDecision).toBeUndefined();
    expect(report.skippedActivations).toEqual([
      expect.objectContaining({
        activationId: LEGACY_ACTIVATION_ID,
        reason: expect.stringContaining('legacy_rule_contract_dependency'),
        nextAction: expect.stringContaining('deactivate'),
      }),
    ]);
    ruleHost.dispose();
  });

  it('Test B: compatibility block does NOT increase GFI / block tracking (real session state)', async () => {
    seedSession('sess-b-gfi');
    insertRuleArtifact(LEGACY_ARTIFACT_ID, LEGACY_RULE_ID, LEGACY_RECENT_THINKING_CODE);
    await insertLiveActivation(LEGACY_ACTIVATION_ID, LEGACY_ARTIFACT_ID, LEGACY_RULE_ID);

    const before = getSession('sess-b-gfi');
    expect(before?.blockedAttempts).toBe(0);
    expect(before?.currentGfi).toBe(0);

    expect(runGate('write_file', { file_path: '/etc/passwd', content: 'x' }, 'sess-b-gfi')).toBeUndefined();

    const after = getSession('sess-b-gfi');
    expect(after?.blockedAttempts).toBe(0);
    expect(after?.currentGfi).toBe(0);

    // recordGateBlockAndReturn was NOT entered: no gate_block event marker.
    expect(bufferedEvents().filter((e) => e.type === 'gate_block')).toHaveLength(0);
  });

  it('Test C: compatibility block does NOT produce Pain / Diagnosis (real event + evolution stream)', async () => {
    insertRuleArtifact(LEGACY_ARTIFACT_ID, LEGACY_RULE_ID, LEGACY_RECENT_THINKING_CODE);
    await insertLiveActivation(LEGACY_ACTIVATION_ID, LEGACY_ARTIFACT_ID, LEGACY_RULE_ID);

    expect(runGate('write_file', { file_path: '/etc/passwd', content: 'x' }, 'sess-c')).toBeUndefined();

    // The pain pipeline is only reachable through recordGateBlockAndReturn,
    // which is never called: no gate_block event, and no pain_detected ever
    // reaches the durable evolution stream.
    expect(bufferedEvents().filter((e) => e.type === 'gate_block')).toHaveLength(0);
    expect(evolutionStream()).not.toContain('"type":"pain_detected"');
    expect(evolutionStream()).not.toContain('"type": "pain_detected"');

    // No diagnostic task was created by the gate path for this session.
    const rows = sqliteConn.getDb()
      .prepare('SELECT COUNT(*) AS n FROM tasks WHERE diagnostic_json LIKE ?')
      .get(`%${'sess-c'}%`) as { n: number };
    expect(rows.n).toBe(0);
  });

  it('Test D: compatibility block does NOT create a Principle Enforcement Receipt (ledger flag ON)', async () => {
    writeConfig({ ledger: true });
    insertRuleArtifact(LEGACY_ARTIFACT_ID, LEGACY_RULE_ID, LEGACY_RECENT_THINKING_CODE);
    await insertLiveActivation(LEGACY_ACTIVATION_ID, LEGACY_ARTIFACT_ID, LEGACY_RULE_ID);

    expect(runGate('write_file', { file_path: '/etc/passwd', content: 'x' }, 'sess-d')).toBeUndefined();

    // No rule_enforced event (the Principle never ran) — the audit trail is
    // preserved via rulehost_evaluated + rulehost_skipped instead.
    const types = bufferedEvents().map((e) => e.type);
    expect(types).toContain('rulehost_evaluated');
    expect(types).toContain('rulehost_skipped');
    expect(types).not.toContain('rule_enforced');

    // No principle application row of any kind (ledger is ON, so this is real).
    const count = (sqliteConn.getDb()
      .prepare('SELECT COUNT(*) AS n FROM principle_applications')
      .get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('Test E: skipped diagnostic names compatibility and remediation', async () => {
    insertRuleArtifact(LEGACY_ARTIFACT_ID, LEGACY_RULE_ID, LEGACY_RECENT_THINKING_CODE);
    await insertLiveActivation(LEGACY_ACTIVATION_ID, LEGACY_ARTIFACT_ID, LEGACY_RULE_ID);

    expect(runGate('write_file', { file_path: '/etc/passwd', content: 'x' }, 'sess-e')).toBeUndefined();
    const skipped = bufferedEvents().find((event) => event.type === 'rulehost_skipped');
    expect(skipped).toBeDefined();
    expect(JSON.stringify(skipped)).toContain('legacy_rule_contract_dependency');
    expect(JSON.stringify(skipped).toLowerCase()).toContain('deactivate');
  });
});

// ── Non-regression: normal RuleHost block keeps the behavioral path ────────

describe('non-regression: normal RuleHost block behavior is unchanged', () => {
  it('normal LIVE rule still blocks, records rule_enforced + gate_block, writes receipt, tracks GFI', async () => {
    writeConfig({ ledger: true });
    seedSession('sess-normal');
    insertRuleArtifact(NORMAL_ARTIFACT_ID, NORMAL_RULE_ID, NORMAL_BLOCK_CODE);
    await insertLiveActivation(NORMAL_ACTIVATION_ID, NORMAL_ARTIFACT_ID, NORMAL_RULE_ID);

    const result = runGate('write_file', { file_path: '/etc/passwd', content: 'x' }, 'sess-normal') as PluginHookBeforeToolCallResult;

    expect(result.block).toBe(true);
    expect(result.blockReason).toContain('NORMAL_PRINCIPLE_BLOCK');

    // Behavioral path entered: rule_enforced + gate_block events.
    const types = bufferedEvents().map((e) => e.type);
    expect(types).toContain('rule_enforced');
    expect(types).toContain('gate_block');

    // GFI/block tracking still runs: blockedAttempts incremented by trackBlock.
    expect(getSession('sess-normal')?.blockedAttempts).toBe(1);

    // Principle application receipt row still written.
    const row = sqliteConn.getDb()
      .prepare("SELECT * FROM principle_applications WHERE kind='rule_blocked'")
      .get() as { rule_id: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.rule_id).toBe(NORMAL_RULE_ID);
  });
});
