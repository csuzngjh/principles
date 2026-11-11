/**
 * PRI-494 — Full-hook performance budget with ERR-088 execution proof
 *
 * PURPOSE: Verify that the complete PRODUCTION before_tool_call path
 * (real SQLite activation read → RuleContext v2 assembly → VM evaluate →
 * shared gate decision → shared-result handler) meets the perf budget:
 *   - p95 < 500ms
 *   - p99 < 1000ms
 *
 * PR-1 (RuleHost retirement): the entry point was `handleBeforeToolCall`, which
 * has no production wiring. The measurement now drives the SAME runtime object
 * src/index.ts assembles (`createOpenClawHostRuntime` → `dispatchBeforeToolCall`
 * → `createProductionRuleHostGate` + `handleSharedRuleHostResult`), so the
 * numbers reflect what the host actually pays.
 *
 * ERR-088 fix: Unlike a timing-only assertion, this test proves the rule
 * actually executed by asserting a UNIQUE block marker (`PERF_BUDGET_BLOCK`)
 * appears in the block reason. A test that only checked timing could pass
 * even if the rule was silently skipped (cache stale, flag off, action
 * mismatch). The unique marker guarantees the rule loaded + compiled +
 * evaluated + returned a block decision.
 *
 * Test path (matches production wiring):
 *   createOpenClawHostRuntime().dispatchBeforeToolCall
 *     → createProductionRuleHostGate
 *       → buildRuleContextIfEnabled (production v2 provider)
 *       → pi_artifacts + activation LEFT JOIN (real SQLite read)
 *       → evaluateBatch (real node:vm child process compile + evaluate)
 *     → handleSharedRuleHostResult
 *
 * Spec: PRI-494 acceptance criteria
 *   - "perf test must prove rules actually executed, not just timing"
 *   - "p95 < 500ms, p99 < 1000ms" (enforced contract threshold, PRI-496)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { SqliteActivationStateStore, SqliteConnection } from '@principles/core/runtime';
import { buildRuleContextIfEnabled, handleSharedRuleHostResult } from '../../src/hooks/gate.js';
import { createOpenClawHostRuntime } from '../../src/host-runtime/openclaw-host-runtime.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

// ── Mocks (non-DB services only, matching rule-context-v2.perf.test.ts) ────

vi.mock('../../src/core/session-tracker.js', () => ({
  getSession: vi.fn(() => ({ currentGfi: 0 })),
  trackBlock: vi.fn(),
  trackReceiptAutoCorrect: vi.fn(),
  setInjectedPrincipleIds: vi.fn(),
}));

const mockEventLogInstance = {
  recordRuleHostEvaluated: vi.fn(),
  recordRuleEnforced: vi.fn(),
  recordRuleHostBlocked: vi.fn(),
  recordRuleHostRequireApproval: vi.fn(),
  recordRuleHostAutoCorrectProposed: vi.fn(),
  recordRuleHostAutoCorrectApplied: vi.fn(),
  recordRuleHostSkipped: vi.fn(),
};
vi.mock('../../src/core/event-log.js', () => ({
  EventLogService: { get: vi.fn(() => mockEventLogInstance) },
}));

vi.mock('../../src/core/principle-tree-ledger.js', () => ({
  loadLedger: vi.fn(),
}));

// ── Constants ──────────────────────────────────────────────────────────────

const RULE_ID = 'R_PERF_BUDGET';
const ARTIFACT_ID = 'art-perf-budget';
const ACTIVATION_ID = `act_code_${RULE_ID}`;
// Unique block marker — proves the rule actually executed (ERR-088).
// If this marker is missing from the block reason, the rule was silently
// skipped (cache stale, flag off, action mismatch, etc.).
const BLOCK_MARKER = 'PERF_BUDGET_BLOCK_MARKER';

// ── Test state ─────────────────────────────────────────────────────────────

let tempWorkspaceDir: string;

// ── Helpers ────────────────────────────────────────────────────────────────

function setupTempWorkspace(): void {
  tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-perf-budget-'));
  const configDir = path.join(tempWorkspaceDir, '.pd');
  fs.mkdirSync(configDir, { recursive: true });

  // Enable rulecode_context_v2 (quiet flag, explicitly on for this workspace)
  const config = {
    version: 1,
    features: {
      prompt: { category: 'core', enabled: true },
      code_tool_hook: { category: 'core', enabled: true },
      defer_archive: { category: 'core', enabled: true },
      rulecode_context_v2: { category: 'quiet', enabled: true },
    },
    runtimeProfiles: { 'openclaw.default': { type: 'openclaw', source: 'default' } },
    internalAgents: { defaultRuntime: 'openclaw.default', agents: { diagnostician: { enabled: true } } },
    ui: { diagnostics: { mode: 'simple' } },
  };
  fs.writeFileSync(path.join(configDir, 'config.yaml'), yaml.dump(config), 'utf8');
}

function teardownTempWorkspace(): void {
  WorkspaceContext.clearCache();
  try { fs.rmSync(tempWorkspaceDir, { recursive: true, force: true }); } catch { /* Windows */ }
}

function insertPerfRuleArtifact(connection: SqliteConnection): void {
  const db = connection.getDb();
  const now = new Date().toISOString();
  // RuleCode blocks writes to /etc/passwd with a UNIQUE marker.
  // The marker is the ERR-088 execution proof: if the rule executes,
  // blockReason contains BLOCK_MARKER; if it doesn't, blockReason is
  // missing or contains a different string.
  const implCode = `
function evaluate(input, helpers) {
  var p = input.action.normalizedPath || '';
  if (p === '/etc/passwd') {
    return { decision: 'block', matched: true, reason: '${BLOCK_MARKER}' };
  }
  return { decision: 'allow', matched: false, reason: 'not matched' };
}
var meta = { name: 'perf-budget', version: '1', ruleId: '${RULE_ID}', coversCondition: 'all' };
`;
  const contentJson = {
    principleId: 'P_PERF_BUDGET',
    ruleId: RULE_ID,
    requiresContextVersion: 2,
    implementationCode: implCode,
    goldenTrace: { traceId: 'trace-perf', cases: [], createdAt: now, version: 1 },
    ruleHostGateDecision: 'accepted_shadow',
    affectedTools: ['write'],
    painReasonSummary: 'perf budget test',
  };
  db.prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ARTIFACT_ID, 'rule', `task-${ARTIFACT_ID}`, 'P_PERF_BUDGET', RULE_ID,
    '[]', 'validated', JSON.stringify(contentJson), now, now,
  );
}

async function insertPerfActivation(connection: SqliteConnection): Promise<void> {
  const store = new SqliteActivationStateStore(connection);
  const now = new Date().toISOString();
  await store.recordActivation({
    activationId: ACTIVATION_ID,
    idempotencyKey: `${ARTIFACT_ID}::code_tool_hook`,
    artifactId: ARTIFACT_ID,
    channel: 'code_tool_hook',
    action: 'code_tool_hook_live_activate',
    targetRef: `impl://${RULE_ID}`,
    activatedAt: now,
    deactivatedAt: null,
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function formatMs(ms: number): string {
  return ms.toFixed(2) + 'ms';
}

// ── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  setupTempWorkspace();
});

afterEach(() => {
  teardownTempWorkspace();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PRI-494 — Full-hook perf budget with ERR-088 execution proof', () => {
  it('production before_tool_call steady-state meets p95<500ms p99<1000ms AND rule actually blocks (ERR-088)', async () => {
    const connection = new SqliteConnection(tempWorkspaceDir);
    insertPerfRuleArtifact(connection);
    await insertPerfActivation(connection);
    connection.close();

    const event = {
      toolName: 'write',
      params: { file_path: '/etc/passwd', content: 'x' },
    };
    const hookContext = {
      workspaceDir: tempWorkspaceDir,
      sessionId: 'perf-budget-session',
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    };

    // Same runtime object src/index.ts assembles: production v2 provider +
    // shared-result handler + shared gate + real VM evaluator.
    const runtime = createOpenClawHostRuntime({
      ruleContextProvider: (_event, context, request) => buildRuleContextIfEnabled(
        WorkspaceContext.fromHookContext({ ...context, workspaceDir: context.workspaceDir }),
        request.targetPath,
        context.sessionId,
        context.logger,
      ),
      onBeforeToolResult: (eventArg, context, result) => handleSharedRuleHostResult(
        eventArg,
        { ...context, workspaceDir: context.workspaceDir, logger: context.logger },
        result,
      ),
    });

    // ERR-088 execution proof — assert the rule ACTUALLY blocked with the
    // unique marker BEFORE measuring timing. This is the regression guard:
    // if a future change silently skips the rule (stale cache, flag off,
    // action mismatch), this assertion fails even if timing is fast.
    const proofResult = await runtime.dispatchBeforeToolCall(event, hookContext);
    expect(proofResult).toBeDefined();
    expect(proofResult?.block).toBe(true);
    expect(proofResult?.blockReason).toContain(BLOCK_MARKER);

    // Warm up: the first call also pays lazy workspace/service initialisation
    // (config load, trajectory schema, VM subprocess start). Steady-state
    // measurements below exclude that one-time cost.
    await runtime.dispatchBeforeToolCall(event, hookContext);

    // Measure 100 steady-state iterations
    const timings: number[] = [];
    const ITERATIONS = 100;
    for (let i = 0; i < ITERATIONS; i++) {
      const start = performance.now();
      const result = await runtime.dispatchBeforeToolCall(event, hookContext);
      const end = performance.now();
      timings.push(end - start);

      // ERR-088: every iteration must prove the rule executed. A timing-only
      // test would skip this and could pass with a no-op rule.
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain(BLOCK_MARKER);
    }

    timings.sort((a, b) => a - b);
    const p50 = percentile(timings, 50);
    const p95 = percentile(timings, 95);
    const p99 = percentile(timings, 99);
    const mean = timings.reduce((s, t) => s + t, 0) / timings.length;
    const min = timings[0];
    const max = timings[timings.length - 1];

    console.log(`[PRI-494 perf] full-hook steady-state (${ITERATIONS} iterations, shared gate + handler, v2 flag on):
  min=${formatMs(min)} p50=${formatMs(p50)} p95=${formatMs(p95)} p99=${formatMs(p99)} mean=${formatMs(mean)} max=${formatMs(max)}
  spec budget: p95<500ms p99<1000ms (CI contract threshold)
  Windows note: SQLite FS overhead + RuleContext v2 trajectory query per call
    can push p95 past 50ms on Windows dev machines; the 500ms/1000ms bounds
    below prevent flaky failures while still catching regressions. Actual
    numbers above are the authoritative baseline — include in PR body.`);

    // Spec budgets (PRI-494 acceptance criteria):
    //   p95 < 50ms, p99 < 200ms (aspirational target, NOT enforced in CI)
    //
    // Contract threshold (PRI-496, enforced in CI):
    //   p95 < 500ms, p99 < 1000ms
    // Rationale: the authoritative baseline (perf-baselines/2026-07-02) is
    // p95~53ms / p99~61ms on a fast Windows dev box, but GitHub Actions
    // shared runners and slower CI environments legitimately measure
    // steady-state p95 ~230ms (SQLite FS overhead is 3-5x Linux per playbook
    // §10.3, plus full parallel CI load inflates tail latency). The previous
    // 200ms/500ms contract was too close to the real cost on those environments
    // and produced false CI failures (e.g. PRI-518 PR #1260 hit p95=254ms on a
    // loaded runner, ~5x the baseline). 500ms/1000ms still catches any real
    // regression (>2x the worst legitimate environment) while eliminating
    // pure-environment flakes. ERR-088 BLOCK_MARKER above already proves the
    // rule executed — the timing bound is a sanity guard, not the correctness
    // signal. See docs/runbooks/ops/rulehost-seed-mvp-playbook.md §10.3.
    expect(p95).toBeLessThan(500); // 500ms contract threshold (regression guard ~2x worst env)
    expect(p99).toBeLessThan(1000); // 1000ms contract threshold
  }, 30000); // 30s timeout: 100 iterations + setup on Windows can exceed 5s default
});
