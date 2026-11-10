/**
 * PRI-1044 step 3-1: silent `no_rules_armed` when an activation's artifact row
 * is gone.
 *
 * The candidate query INNER JOINs `pi_artifacts`, so an ACTIVE code_tool_hook
 * activation whose artifact row no longer exists simply vanishes from the
 * result set. The gate then reports `evaluatedLiveRules=0` / `no_rules_armed`
 * with NO warning at all — the Owner-visible symptom observed in PRI-1044,
 * where a shadow activation kept pointing at a deleted `pi_artifacts` row and
 * rule enforcement quietly stopped for 8+ hours.
 *
 * These tests pin the observability contract: the missing reference must emit
 * a structured warning naming the activation, and must leave the durable
 * out-of-workspace degraded-enforcement marker (the same mechanism the gate
 * already uses for a missing/corrupt state.db).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: vi.fn() };
});

import { SqliteConnection, SqliteActivationStateStore } from '@principles/core/runtime';
import type { HostEvent } from '@principles/core/host';
import { createProductionRuleHostGate } from '../src/production-rulehost-gate.js';
import { markerPathFor } from '../src/degraded-enforcement-marker.js';
import type { RuleImplementationRuntime, RuleBatchEvaluation } from '../src/rule-implementation-runtime.js';

const ORPHAN_ARTIFACT_ID = 'art-orphan-001';
const ORPHAN_ACTIVATION_ID = 'act_code_orphan-001';
const HEALTHY_ARTIFACT_ID = 'art-healthy-001';
const HEALTHY_ACTIVATION_ID = 'act_code_healthy-001';

const ALLOWING_CODE = `
function evaluate(input, helpers) {
  return { decision: 'allow', matched: false, reason: 'no match' };
}
var meta = { name: 'orphan-probe', version: '1', ruleId: 'R_ORPHAN_PROBE', coversCondition: 'all' };
`;

let tempWorkspaceDir: string;
let testHome: string;
let sqliteConn: SqliteConnection;

function contentJson(ruleId: string): string {
  return JSON.stringify({
    principleId: `P_${ruleId}`,
    ruleId,
    implementationCode: ALLOWING_CODE,
    ruleHostGateDecision: 'accepted_shadow',
    affectedTools: ['write_file'],
  });
}

function insertArtifact(artifactId: string, ruleId: string): void {
  sqliteConn.getDb().prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, 'rule', ?, ?, ?, '[]', 'validated', ?, '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z')
  `).run(artifactId, `task-${artifactId}`, `P_${ruleId}`, ruleId, contentJson(ruleId));
}

async function insertShadowActivation(activationId: string, artifactId: string, ruleId: string): Promise<void> {
  const store = new SqliteActivationStateStore(sqliteConn);
  await store.recordActivation({
    activationId,
    idempotencyKey: `${artifactId}::code_tool_hook`,
    artifactId,
    channel: 'code_tool_hook',
    action: 'code_tool_hook_shadow_activate',
    targetRef: `impl://${ruleId}`,
    activatedAt: new Date().toISOString(),
    deactivatedAt: null,
  });
}

/** Simulate the PRI-1044 state: the artifact row is gone, the activation stays ACTIVE. */
function deleteArtifactRow(artifactId: string): void {
  sqliteConn.getDb().prepare('DELETE FROM pi_artifacts WHERE artifact_id = ?').run(artifactId);
}

function makeStubRuntime(calls: { rules: unknown }[]): RuleImplementationRuntime {
  return {
    evaluateBatch(rules: readonly unknown[]): RuleBatchEvaluation {
      calls.push({ rules });
      return {
        ok: true,
        results: (rules as readonly unknown[]).map(() => ({
          ok: true,
          result: { decision: 'block', matched: true, reason: 'HEALTHY_SIBLING_BLOCK' },
        })),
      };
    },
  };
}

function makeEvent(): HostEvent {
  return {
    kind: 'before_tool_call',
    context: {
      workspaceDir: tempWorkspaceDir,
      sessionId: 'missing-artifact-test',
      toolName: 'write_file',
    },
    rawPayload: { toolInput: { toolName: 'write_file', params: { path: '/etc/passwd' } } },
    source: 'test',
  } as unknown as HostEvent;
}

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-orphan-home-'));
  vi.mocked(os.homedir).mockReturnValue(testHome);
  tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-orphan-'));
  sqliteConn = new SqliteConnection(tempWorkspaceDir);
  sqliteConn.getDb();
});

afterEach(() => {
  vi.clearAllMocks();
  try { sqliteConn?.close(); } catch { /* best-effort */ }
  try { fs.rmSync(tempWorkspaceDir, { recursive: true, force: true }); } catch { /* Windows */ }
  try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* Windows */ }
});

describe('production gate: active activation whose artifact row is missing', () => {
  it('surfaces a structured warning and a durable marker instead of a silent no_rules_armed', async () => {
    insertArtifact(ORPHAN_ARTIFACT_ID, 'R_ORPHAN_PROBE');
    await insertShadowActivation(ORPHAN_ACTIVATION_ID, ORPHAN_ARTIFACT_ID, 'R_ORPHAN_PROBE');
    deleteArtifactRow(ORPHAN_ARTIFACT_ID);

    const calls: { rules: unknown }[] = [];
    const gate = createProductionRuleHostGate({ implementationRuntime: makeStubRuntime(calls) });
    const result = await gate(makeEvent());

    // Availability posture is unchanged: fail open, nothing evaluated.
    expect(result.decision).toBe('allow');
    expect(calls).toHaveLength(0);
    const evaluations = (result.metadata as { evaluations?: { decision?: string }[] } | undefined)?.evaluations;
    expect(evaluations?.[0]?.decision).toBe('no_rules_armed');

    // ...but it is no longer SILENT.
    const warnings = (result.warnings ?? []).join('\n');
    expect(warnings).toContain('activation_artifact_missing');
    expect(warnings).toContain(ORPHAN_ACTIVATION_ID);
    expect(warnings).toContain(ORPHAN_ARTIFACT_ID);

    const markerPath = markerPathFor(tempWorkspaceDir);
    expect(fs.existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { reason?: string };
    expect(marker.reason).toContain('activation_artifact_missing');
    expect(marker.reason).toContain(ORPHAN_ACTIVATION_ID);
  });

  it('keeps a healthy sibling rule enforcing while reporting the orphaned activation', async () => {
    insertArtifact(HEALTHY_ARTIFACT_ID, 'R_HEALTHY_001');
    await insertShadowActivation(HEALTHY_ACTIVATION_ID, HEALTHY_ARTIFACT_ID, 'R_HEALTHY_001');
    insertArtifact(ORPHAN_ARTIFACT_ID, 'R_ORPHAN_PROBE');
    await insertShadowActivation(ORPHAN_ACTIVATION_ID, ORPHAN_ARTIFACT_ID, 'R_ORPHAN_PROBE');
    deleteArtifactRow(ORPHAN_ARTIFACT_ID);

    const calls: { rules: unknown }[] = [];
    const gate = createProductionRuleHostGate({ implementationRuntime: makeStubRuntime(calls) });
    const result = await gate(makeEvent());

    // The healthy shadow activation still reaches the runtime.
    expect(calls).toHaveLength(1);
    expect(result.decision).toBe('allow');
    const warnings = (result.warnings ?? []).join('\n');
    expect(warnings).toContain('activation_artifact_missing');
    expect(warnings).toContain(ORPHAN_ACTIVATION_ID);
  });
});
