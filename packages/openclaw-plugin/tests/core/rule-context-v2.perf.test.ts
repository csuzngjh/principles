/**
 * PRI-486 Phase 7 — RuleContext v2 performance baseline (spec §10.3)
 *
 * PURPOSE: Record context query p50/p95 + first trajectory access cold-start.
 *
 * Spec §10.3 constraint: "性能预算必须先基准再定值。文档不得把未执行的
 * 目标写成'实测结果'"。This test records baseline numbers only — no threshold
 * assertions. Baseline data is emitted via console.log for PR body inclusion.
 *
 * Scenarios:
 *   1. context query p50/p95: 100 history rows → 100 buildProductionRuleContext calls
 *   2. cold-start: empty workspace → first recordToolCall (schema init)
 *
 * Spec: docs/superpowers/specs/2026-06-27-rulecode-context-vision-design.md §10.3
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { buildProductionRuleContext } from '../../src/core/rule-context-assembler.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

// ── Mocks (non-DB services only) ───────────────────────────────────────────

vi.mock('../../src/core/session-tracker.js', () => ({
  getSession: vi.fn(() => ({ currentGfi: 0 })),
  trackBlock: vi.fn(),
  hasRecentThinking: vi.fn(() => false),
}));

vi.mock('../../src/core/evolution-engine.js', () => ({
  getEvolutionEngine: vi.fn(() => ({ getTier: () => 3, getPoints: () => 200 })),
}));

vi.mock('../../src/core/event-log.js', () => ({
  EventLogService: { get: vi.fn(() => ({})) },
}));

vi.mock('../../src/core/principle-tree-ledger.js', () => ({
  loadLedger: vi.fn(),
}));

// ── Test setup ─────────────────────────────────────────────────────────────

let tempWorkspaceDir: string;

function setupTempWorkspace(): void {
  tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-ctx-v2-perf-'));
  const configDir = path.join(tempWorkspaceDir, '.pd');
  fs.mkdirSync(configDir, { recursive: true });

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
  fs.writeFileSync(
    path.join(configDir, 'config.yaml'),
    yaml.dump(config),
    'utf8',
  );
}

function teardownTempWorkspace(): void {
  WorkspaceContext.clearCache();
  try {
    fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
  } catch {
    // Windows: best-effort
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  setupTempWorkspace();
});

afterEach(() => {
  teardownTempWorkspace();
});

// ── Helpers ────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function formatMs(ms: number): string {
  return ms.toFixed(2) + 'ms';
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PRI-486 Phase 7 — RuleContext v2 performance baseline (spec §10.3)', () => {
  it('context query p50/p95 over 100 iterations with 100 history rows', () => {
    const wctx = WorkspaceContext.fromHookContext({
      workspaceDir: tempWorkspaceDir,
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    } as unknown as Parameters<typeof WorkspaceContext.fromHookContext>[0]);

    // Seed 100 tool call history rows (mix of read/write/success/failure)
    for (let i = 0; i < 100; i++) {
      const isRead = i % 2 === 0;
      wctx.trajectory.recordToolCall({
        sessionId: 'perf-session',
        toolName: isRead ? 'read_file' : 'write_file',
        outcome: i % 7 === 0 ? 'failure' : 'success',
        paramsJson: { file_path: `src/file${i}.ts` },
      });
    }

    // Warm up (first call may have query plan cache miss)
    buildProductionRuleContext('perf-session', 'src/target.ts', wctx.trajectory, tempWorkspaceDir);

    // Measure 100 iterations
    const timings: number[] = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      const ctx = buildProductionRuleContext(
        'perf-session',
        `src/target${i}.ts`,
        wctx.trajectory,
        tempWorkspaceDir,
      );
      const end = performance.now();
      timings.push(end - start);
      // Sanity: result must be a valid RuleContextV2
      expect(ctx.version).toBe(2);
      expect(ctx.history.status).toBe('available');
    }

    timings.sort((a, b) => a - b);
    const p50 = percentile(timings, 50);
    const p95 = percentile(timings, 95);
    const p99 = percentile(timings, 99);
    const mean = timings.reduce((s, t) => s + t, 0) / timings.length;
    const min = timings[0];
    const max = timings[timings.length - 1];

     
    console.log(`[PRI-486 perf] context query (100 rows, 100 iterations):
  min=${formatMs(min)} p50=${formatMs(p50)} p95=${formatMs(p95)} p99=${formatMs(p99)} mean=${formatMs(mean)} max=${formatMs(max)}`);

    // No threshold assertion (spec §10.3: baseline first, budget later)
    // Just sanity check: each call should complete in reasonable time
    expect(p95).toBeLessThan(100); // 100ms sanity upper bound
  });

  it('cold-start: first recordToolCall (schema init) cost', () => {
    // Fresh workspace — no DB file exists yet
    const wctx = WorkspaceContext.fromHookContext({
      workspaceDir: tempWorkspaceDir,
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    } as unknown as Parameters<typeof WorkspaceContext.fromHookContext>[0]);

    // Measure first recordToolCall (triggers schema init)
    const start = performance.now();
    wctx.trajectory.recordToolCall({
      sessionId: 'cold-start-session',
      toolName: 'read_file',
      outcome: 'success',
      paramsJson: { file_path: 'src/cold.ts' },
    });
    const end = performance.now();
    const coldStartMs = end - start;

     
    console.log(`[PRI-486 perf] cold-start (first recordToolCall + schema init): ${formatMs(coldStartMs)}`);

    // Sanity: cold-start should complete in reasonable time
    expect(coldStartMs).toBeLessThan(500); // 500ms sanity upper bound

    // Verify the record was actually written
    const ctx = buildProductionRuleContext('cold-start-session', 'src/cold.ts', wctx.trajectory, tempWorkspaceDir);
    expect(ctx.history.status).toBe('available');
    expect(ctx.history.calls).toHaveLength(1);
  });

  it('context query with empty history (baseline overhead)', () => {
    const wctx = WorkspaceContext.fromHookContext({
      workspaceDir: tempWorkspaceDir,
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    } as unknown as Parameters<typeof WorkspaceContext.fromHookContext>[0]);

    // Sanity: verify baseline returns a valid available context (not fail-soft unavailable)
    const sample = buildProductionRuleContext(
      'empty-session',
      'src/target.ts',
      wctx.trajectory,
      tempWorkspaceDir,
    );
    expect(sample.version).toBe(2);
    expect(sample.history.status).toBe('available');

    // No history recorded — measure baseline query cost
    const timings: number[] = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      buildProductionRuleContext('empty-session', 'src/target.ts', wctx.trajectory, tempWorkspaceDir);
      const end = performance.now();
      timings.push(end - start);
    }

    timings.sort((a, b) => a - b);
    const p50 = percentile(timings, 50);
    const p95 = percentile(timings, 95);

     
    console.log(`[PRI-486 perf] empty-history query (100 iterations):
  p50=${formatMs(p50)} p95=${formatMs(p95)}`);

    expect(p95).toBeLessThan(50); // 50ms sanity upper bound
  });
});
