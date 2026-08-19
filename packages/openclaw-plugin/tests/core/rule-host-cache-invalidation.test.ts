/**
 * PRI-494 — RuleHost cache invalidation matrix + logger/handle freshness
 *
 * PURPOSE: Verify that the RuleHost fingerprint-based cache invalidates
 * correctly when the underlying SQLite activations or artifact content
 * change. Prevents ERR-024 (cache bypasses enforcement) and ERR-079-style
 * stale-state races where a deactivated rule continues to block.
 *
 * Test strategy: Exercise `RuleHost.evaluateDetailed()` directly (not
 * through gate.ts) for precise control over the cache lifecycle. Use real
 * SQLite + real `SqliteActivationStateStore` for activation mutations
 * (recordActivation / deactivateActivation / promoteActivation) and real
 * `pi_artifacts` UPDATEs for content changes.
 *
 * Cache invalidation contract (rule-host.ts:314-322):
 *   fingerprint = supportsContextV2 + per-activation(
 *     activation_id, artifact_id, target_ref, action,
 *     content_json, source_rule_id, source_principle_id
 *   )
 *   Any field change → fingerprint change → cache miss → reload from SQLite.
 *
 * ERR checklist:
 *   - ERR-024: cache must NOT bypass enforcement (deactivated rule must not block)
 *   - ERR-079: stale cache must not re-open races (deactivate/promote must be visible immediately)
 *   - ERR-088: tests assert rule actually executed (unique block markers), not just timing
 *
 * NOTE on ERR-002 (rc-9 no silent fallback): skippedActivations reason/nextAction
 * is NOT asserted in this file — that contract is verified in PRI-491 tests
 * (governance-approve-activation, activation-page). This file focuses on the
 * cache invalidation matrix and logger/handle freshness only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteConnection, SqliteActivationStateStore } from '@principles/core/runtime-v2';
import { RuleHost } from '../../src/core/rule-host.js';
import type { RuleHostInput, RuleHostLogger } from '@principles/core/runtime-v2';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

// ── Constants ──────────────────────────────────────────────────────────────

const RULE_ID = 'R_CACHE_INVALIDATION';
const ARTIFACT_ID = 'art-cache-invalid';
const ACTIVATION_ID = `act_code_${RULE_ID}`;
const PRINCIPLE_ID = 'P_CACHE_INVALIDATION';

// Unique block markers — each rule version returns a distinct reason string
// so tests can prove WHICH version of the rule actually executed (ERR-088).
const LIVE_BLOCK_REASON = 'CACHE_LIVE_BLOCK_MARKER';
const LIVE_BLOCK_REASON_V2 = 'CACHE_LIVE_BLOCK_MARKER_V2';

// ── Test state ─────────────────────────────────────────────────────────────

let tempWorkspaceDir: string;
let tempStateDir: string;
let sqliteConn: SqliteConnection;

// ── Helpers ────────────────────────────────────────────────────────────────

function setupTempDirs(): void {
  tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cache-inval-'));
  tempStateDir = path.join(tempWorkspaceDir, '.principles');
  fs.mkdirSync(tempStateDir, { recursive: true });
}

function teardownTempDirs(): void {
  try { sqliteConn?.close(); } catch { /* best-effort */ }
  try { fs.rmSync(tempWorkspaceDir, { recursive: true, force: true }); } catch { /* Windows */ }
}

/**
 * Generate RuleCode that blocks /etc/passwd with a unique reason marker.
 * The marker lets tests assert WHICH version of the rule executed.
 */
function makeBlockCode(reason: string, ruleId: string = RULE_ID): string {
  return `
function evaluate(input, helpers) {
  var p = input.action.normalizedPath || '';
  if (p === '/etc/passwd') {
    return { decision: 'block', matched: true, reason: '${reason}' };
  }
  return { decision: 'allow', matched: false, reason: 'not matched' };
}
var meta = { name: 'cache-inval-test', version: '1', ruleId: '${ruleId}', coversCondition: 'all' };
`;
}

function insertRuleArtifact(
  artifactId: string,
  ruleId: string,
  code: string,
  overrides: Partial<{ contentJson: Record<string, unknown>; taskId: string }> = {},
): void {
  const db = sqliteConn.getDb();
  const now = new Date().toISOString();
  // (source_task_id, artifact_kind) is UNIQUE — derive a per-artifact task ID
  // to allow multiple artifacts in the same test (ERR-024 dispose test inserts two).
  const taskId = overrides.taskId ?? `task-${artifactId}`;
  const contentJson = overrides.contentJson ?? {
    principleId: PRINCIPLE_ID,
    ruleId,
    implementationCode: code,
    goldenTrace: { traceId: 'trace-cache', cases: [], createdAt: now, version: 1 },
    ruleHostGateDecision: 'accepted_shadow',
    affectedTools: ['write_file'],
    painReasonSummary: 'cache invalidation test',
  };
  db.prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifactId,
    'rule',
    taskId,
    PRINCIPLE_ID,
    ruleId,
    '[]',
    'validated',
    JSON.stringify(contentJson),
    now,
    now,
  );
}

async function insertActivation(
  activationId: string,
  artifactId: string,
  ruleId: string,
  action: 'code_tool_hook_shadow_activate' | 'code_tool_hook_live_activate',
): Promise<void> {
  const store = new SqliteActivationStateStore(sqliteConn);
  const now = new Date().toISOString();
  await store.recordActivation({
    activationId,
    idempotencyKey: `${artifactId}::code_tool_hook`,
    artifactId,
    channel: 'code_tool_hook',
    action,
    targetRef: `impl://${ruleId}`,
    activatedAt: now,
    deactivatedAt: null,
  });
}

async function deactivateActivation(activationId: string): Promise<void> {
  const store = new SqliteActivationStateStore(sqliteConn);
  const now = new Date().toISOString();
  const ok = await store.deactivateActivation(activationId, now);
  if (!ok) throw new Error(`deactivateActivation failed for ${activationId}`);
}

async function promoteActivation(activationId: string): Promise<void> {
  const store = new SqliteActivationStateStore(sqliteConn);
  const now = new Date().toISOString();
  const ok = await store.promoteActivation(activationId, now);
  if (!ok) throw new Error(`promoteActivation failed for ${activationId}`);
}

function updateArtifactContent(artifactId: string, newCode: string, ruleId: string = RULE_ID): void {
  const db = sqliteConn.getDb();
  const now = new Date().toISOString();
  const contentJson = {
    principleId: PRINCIPLE_ID,
    ruleId,
    implementationCode: newCode,
    goldenTrace: { traceId: 'trace-cache-v2', cases: [], createdAt: now, version: 1 },
    ruleHostGateDecision: 'accepted_shadow',
    affectedTools: ['write_file'],
    painReasonSummary: 'cache invalidation test v2',
  };
  db.prepare(`
    UPDATE pi_artifacts SET content_json = ?, updated_at = ? WHERE artifact_id = ?
  `).run(JSON.stringify(contentJson), now, artifactId);
}

/**
 * Build a RuleHostInput fixture matching the real RuleHostInput contract
 * (rule-host-contracts.ts). No `as` bypass — every field matches the
 * declared type so a future contract change surfaces as a compile error
 * here instead of being silently masked.
 *
 * rc-2-no-as-bypass: test fixtures must also respect the contract shape;
 * `as unknown as` would hide field renames (e.g., rawParams → paramsSummary)
 * and enum drift (e.g., bashRisk 'low' → 'safe'|'normal'|'dangerous'|'unknown').
 */
function makeHostInput(): RuleHostInput {
  return {
    action: {
      toolName: 'write_file',
      normalizedPath: '/etc/passwd',
      paramsSummary: { file_path: '/etc/passwd', content: 'x' },
    },
    workspace: { isRiskPath: false },
    session: { sessionId: 'cache-inval-session', currentGfi: 0 },
    evolution: { epTier: 3 },
    derived: { estimatedLineChanges: 1, bashRisk: 'unknown' },
    context: undefined,
  };
}

function makeLogger(warnSink: (msg: string) => void = () => {}): RuleHostLogger & { warns: string[] } {
  const warns: string[] = [];
  return {
    warn: (msg?: unknown) => {
      const s = typeof msg === 'string' ? msg : String(msg ?? '');
      warns.push(s);
      warnSink(s);
    },
    info: () => {},
    error: () => {},
    debug: () => {},
    warns,
  } as unknown as RuleHostLogger & { warns: string[] };
}

/**
 * Shared setup helper: insert a rule artifact + activation and construct a
 * RuleHost with a spy logger. Reduces boilerplate across the 8 test cases
 * that all start with the same 3-line setup (insert → activate → new RuleHost).
 *
 * Returns { host, input, logger } so each test can destructure exactly what
 * it needs. Tests with extra setup (e.g., dispose tests inserting a second
 * rule) call this for the initial state, then do their own additional setup.
 */
async function setupHostWithActivation(
  action: 'code_tool_hook_shadow_activate' | 'code_tool_hook_live_activate',
  reason: string = LIVE_BLOCK_REASON,
): Promise<{ host: RuleHost; input: RuleHostInput; logger: RuleHostLogger & { warns: string[] } }> {
  insertRuleArtifact(ARTIFACT_ID, RULE_ID, makeBlockCode(reason));
  await insertActivation(ACTIVATION_ID, ARTIFACT_ID, RULE_ID, action);
  const logger = makeLogger();
  const host = new RuleHost(tempStateDir, logger, { workspaceDir: tempWorkspaceDir });
  return { host, input: makeHostInput(), logger };
}

// ── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  setupTempDirs();
  WorkspaceContext.clearCache();
  sqliteConn = new SqliteConnection(tempWorkspaceDir);
  sqliteConn.getDb();
});

afterEach(() => {
  WorkspaceContext.clearCache();
  teardownTempDirs();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PRI-494 — RuleHost cache invalidation matrix', () => {
  it('cache hit: repeated evaluate with no mutation returns same behavior (baseline)', async () => {
    const { host, input } = await setupHostWithActivation('code_tool_hook_live_activate');

    // First call: cold load (cache miss)
    const r1 = host.evaluateDetailed(input);
    expect(r1.liveDecision?.decision).toBe('block');
    expect(r1.liveDecision?.reason).toBe(LIVE_BLOCK_REASON);

    // Second call: cache hit — same behavior, no DB reload
    const r2 = host.evaluateDetailed(input);
    expect(r2.liveDecision?.decision).toBe('block');
    expect(r2.liveDecision?.reason).toBe(LIVE_BLOCK_REASON);

    host.dispose();
  });

  it('promote (shadow → live) invalidates cache: shadow no-block → live blocks', async () => {
    const { host, input } = await setupHostWithActivation('code_tool_hook_shadow_activate');

    // Shadow: no live block
    const r1 = host.evaluateDetailed(input);
    expect(r1.liveDecision).toBeUndefined();
    expect(r1.shadowDecisions).toHaveLength(1);
    expect(r1.shadowDecisions[0]?.decision).toBe('block');
    expect(r1.shadowDecisions[0]?.reason).toBe(LIVE_BLOCK_REASON);

    // Promote: action changes shadow → live, fingerprint changes, cache invalidates
    await promoteActivation(ACTIVATION_ID);

    const r2 = host.evaluateDetailed(input);
    expect(r2.liveDecision?.decision).toBe('block');
    expect(r2.liveDecision?.reason).toBe(LIVE_BLOCK_REASON);
    expect(r2.shadowDecisions).toHaveLength(0);

    host.dispose();
  });

  it('deactivate invalidates cache: live block → no block (ERR-079 stale cache regression)', async () => {
    const { host, input } = await setupHostWithActivation('code_tool_hook_live_activate');

    // Live block
    const r1 = host.evaluateDetailed(input);
    expect(r1.liveDecision?.decision).toBe('block');

    // Deactivate: row removed from active set, fingerprint changes, cache invalidates
    await deactivateActivation(ACTIVATION_ID);

    const r2 = host.evaluateDetailed(input);
    expect(r2.liveDecision).toBeUndefined();
    expect(r2.shadowDecisions).toHaveLength(0);

    host.dispose();
  });

  it('artifact content change invalidates cache: old reason → new reason', async () => {
    const { host, input } = await setupHostWithActivation('code_tool_hook_live_activate');

    // Original content
    const r1 = host.evaluateDetailed(input);
    expect(r1.liveDecision?.reason).toBe(LIVE_BLOCK_REASON);

    // Update artifact content_json: new code with different reason marker
    updateArtifactContent(ARTIFACT_ID, makeBlockCode(LIVE_BLOCK_REASON_V2));

    const r2 = host.evaluateDetailed(input);
    expect(r2.liveDecision?.decision).toBe('block');
    expect(r2.liveDecision?.reason).toBe(LIVE_BLOCK_REASON_V2);

    host.dispose();
  });

  it('action change (live → shadow) invalidates cache: live block → shadow no-block', async () => {
    const { host, input } = await setupHostWithActivation('code_tool_hook_live_activate');

    // Live block
    const r1 = host.evaluateDetailed(input);
    expect(r1.liveDecision?.decision).toBe('block');

    // Manually flip action live → shadow (reverse of promote; simulates
    // a manual DB edit or future demote operation). Fingerprint changes
    // because action is part of the fingerprint.
    const db = sqliteConn.getDb();
    db.prepare(`
      UPDATE activations SET action = ? WHERE activation_id = ? AND deactivated_at IS NULL
    `).run('code_tool_hook_shadow_activate', ACTIVATION_ID);

    const r2 = host.evaluateDetailed(input);
    expect(r2.liveDecision).toBeUndefined();
    expect(r2.shadowDecisions).toHaveLength(1);
    expect(r2.shadowDecisions[0]?.decision).toBe('block');

    host.dispose();
  });
});

describe('PRI-494 — RuleHost logger sink + SQLite handle freshness', () => {
  it('updateLogger on cached RuleHost routes new warn to new logger (not old sink)', async () => {
    const { host, input, logger: logger1 } = await setupHostWithActivation('code_tool_hook_live_activate');
    const logger2 = makeLogger();

    // Trigger an evaluation to cache the RuleHost instance + populate fingerprint
    const r1 = host.evaluateDetailed(input);
    expect(r1.liveDecision?.decision).toBe('block');

    // Switch logger sink on the cached instance
    host.updateLogger(logger2);

    // Deactivate to trigger the "armed but empty" warn on next evaluate.
    // This warn must route to logger2, not logger1.
    await deactivateActivation(ACTIVATION_ID);

    const r2 = host.evaluateDetailed(input);
    expect(r2.liveDecision).toBeUndefined();

    // logger1 should have no warns from the post-updateLogger evaluation
    // (it may have warns from the first evaluation, but not the empty-load warn).
    // logger2 should have the "armed but empty" warn.
    const logger2Warns = logger2.warns.filter((w) => w.includes('armed but empty'));
    expect(logger2Warns.length).toBeGreaterThan(0);

    // The same warn should NOT appear in logger1 (it was the old sink).
    // logger1 may have other warns (e.g., from the first cold load), but
    // the "armed but empty" message must only be in logger2 because
    // updateLogger was called between evaluations.
    const logger1ArmedWarns = logger1.warns.filter((w) => w.includes('armed but empty'));
    expect(logger1ArmedWarns).toHaveLength(0);

    host.dispose();
  });

  it('dispose() closes SQLite handle and next load opens fresh (ERR-024)', async () => {
    const { host, input } = await setupHostWithActivation('code_tool_hook_live_activate');

    // First load: caches the rule
    const r1 = host.evaluateDetailed(input);
    expect(r1.liveDecision?.decision).toBe('block');

    // Dispose: closes SQLite connection, clears cachedImplementations + fingerprint
    host.dispose();

    // Mutate DB AFTER dispose (new rule with different reason)
    const NEW_RULE_ID = 'R_CACHE_INVALIDATION_NEW';
    const NEW_ARTIFACT_ID = 'art-cache-invalid-new';
    const NEW_ACTIVATION_ID = `act_code_${NEW_RULE_ID}`;
    // Deactivate the old activation so only the new rule is active
    await deactivateActivation(ACTIVATION_ID);
    insertRuleArtifact(NEW_ARTIFACT_ID, NEW_RULE_ID, makeBlockCode(LIVE_BLOCK_REASON_V2, NEW_RULE_ID));
    await insertActivation(NEW_ACTIVATION_ID, NEW_ARTIFACT_ID, NEW_RULE_ID, 'code_tool_hook_live_activate');

    // Re-evaluate: must open a fresh SQLite connection and load the NEW rule
    const r2 = host.evaluateDetailed(input);
    expect(r2.liveDecision?.decision).toBe('block');
    expect(r2.liveDecision?.reason).toBe(LIVE_BLOCK_REASON_V2);
    expect(r2.liveDecision?.ruleId).toBe(NEW_RULE_ID);

    host.dispose();
  });

  it('dispose() clears cached implementations (no stale enforcement after dispose + reactivate)', async () => {
    const { host, input } = await setupHostWithActivation('code_tool_hook_live_activate');

    // Live block
    const r1 = host.evaluateDetailed(input);
    expect(r1.liveDecision?.decision).toBe('block');
    expect(r1.liveDecision?.reason).toBe(LIVE_BLOCK_REASON);

    // Dispose + deactivate the rule
    host.dispose();
    await deactivateActivation(ACTIVATION_ID);

    // Re-evaluate: no active rules, no stale block from disposed cache
    const r2 = host.evaluateDetailed(input);
    expect(r2.liveDecision).toBeUndefined();
    expect(r2.shadowDecisions).toHaveLength(0);

    host.dispose();
  });
});
