/**
 * PRI-531 BDD: principle application ledger writes at the real call sites.
 * Drives handleBeforeToolCall (real gate, mocked RuleHost evaluation) against
 * a real temp workspace with a real .pd/config.yaml flag; asserts rows via a
 * readonly SqliteConnection. Presence dedup exercises the hook-side helper
 * (recordInjectionPresence) including a simulated restart.
 */
import { beforeEach, afterEach, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import {
  SqliteConnection,
  getDefaultPdConfig,
} from '@principles/core/runtime-v2';
import { handleBeforeToolCall } from '../../src/hooks/gate.js';
import {
  recordInjectionPresence,
  clearPrincipleApplicationLedgerCache,
} from '../../src/core/principle-application-ledger.js';
import { createStepRegistry, defineFeature } from '../../../principles-core/tests/bdd/support/vitest-bdd.js';
import { resolveFeaturePath } from '../../../principles-core/tests/bdd/support/repo-root.js';

const registry = createStepRegistry();
vi.mock('../../src/core/session-tracker.js', () => ({
  getSession: vi.fn(() => ({ currentGfi: 0 })),
  trackBlock: vi.fn(),
  trackReceiptAutoCorrect: vi.fn(),
  setInjectedPrincipleIds: vi.fn(),
}));
vi.mock('../../src/core/evolution-engine.js', () => ({
  getEvolutionEngine: vi.fn(() => ({ getTier: vi.fn().mockReturnValue(3), getPoints: vi.fn().mockReturnValue(200) })),
}));
const mockEventLogInstance = {
  recordRuleHostEvaluated: vi.fn(),
  recordRuleEnforced: vi.fn(),
  recordRuleHostBlocked: vi.fn(),
  recordRuleHostRequireApproval: vi.fn(),
  recordRuleHostAutoCorrectProposed: vi.fn(),
  recordRuleHostAutoCorrectApplied: vi.fn(),
  recordGateBlock: vi.fn(),
};
vi.mock('../../src/core/event-log.js', () => ({
  EventLogService: { get: vi.fn(() => mockEventLogInstance) },
}));
let _mockEvaluate = vi.fn().mockReturnValue(undefined);
vi.mock('../../src/core/rule-host.js', () => ({
  RuleHost: vi.fn(function(this: unknown, _stateDir: string, _logger: unknown) {
    this.evaluate = _mockEvaluate;
  }),
  // P1 (2026-08-20): gate.ts routes compatibility-guard blocks through this type
  // guard; the mocked rule-host must export it so mocked evaluate() results are
  // not misrouted.
  isCompatibilityGuardBlock: vi.fn(() => false),
}));
vi.mock('../../src/core/workspace-context.js', () => ({
  WorkspaceContext: {
    fromHookContext: vi.fn((ctx: { workspaceDir?: string }) => ({
      workspaceDir: ctx.workspaceDir,
      stateDir: (ctx.workspaceDir ?? '') + '/.state',
      getRuleHost: () => ({ evaluate: _mockEvaluate, dispose: vi.fn() }),
      eventLog: mockEventLogInstance,
      trajectory: { recordGateBlock: vi.fn(), getRuleHostContextRows: vi.fn(() => ({ rows: [], truncated: false })) },
      config: { get: vi.fn().mockReturnValue(undefined) },
      resolve: vi.fn(() => '/mock/PROFILE.json'),
    })),
  },
}));

let workspaceDir = '';
let readerConn: SqliteConnection | undefined;

function countRows(where: string): number {
  const row = readerConn!.getDb()
    .prepare(`SELECT COUNT(*) AS n FROM principle_applications ${where}`)
    .get() as { n: number };
  return row.n;
}

function writeConfig(enabled: boolean): void {
  const cfg = getDefaultPdConfig() as unknown as {
    features: Record<string, { category?: string; enabled: boolean }>;
  };
  cfg.features.principle_receipt_ledger = { category: 'quiet', enabled };
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(cfg));
}

registry.given(/一个已安装 PD 的工作区，且 \.pd\/config\.yaml (启用|未启用) principle_receipt_ledger/, (_m: string, state: string) => {
  writeConfig(state === '启用');
});

registry.when(/RuleHost 拦截一次工具调用（规则 R-531，会话 sess-531）/, () => {
  _mockEvaluate = vi.fn().mockReturnValue({
    decision: 'block',
    matched: true,
    reason: '删除类操作必须先确认目标',
    ruleId: 'R-531',
    principleId: 'princ-531',
  });
  handleBeforeToolCall(
    { toolName: 'bash', params: { command: 'rm -rf build/' } },
    { workspaceDir, sessionId: 'sess-531', logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } },
  );
});

registry.when(/RuleHost 对一次工具调用应用 live 自动纠正（dry_run false→true）/, () => {
  _mockEvaluate = vi.fn().mockReturnValue({
    decision: 'auto_correct',
    matched: true,
    reason: 'enforce dry run',
    ruleId: 'R-531',
    correctionProposal: {
      proposedParams: { dry_run: true },
      correctedFields: [{ field: 'dry_run', original: false, proposed: true, reason: 'enforce dry run' }],
      applicationMode: 'live' as const,
      confidence: 0.9,
      ruleId: 'R-531',
      principleId: 'princ-531',
      notifyAgent: false,
    },
  });
  handleBeforeToolCall(
    { toolName: 'bash', params: { command: 'rm -rf build/', dry_run: false } },
    { workspaceDir, sessionId: 'sess-531', logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } },
  );
});

registry.when(/RuleHost 对一次工具调用返回 requireApproval/, () => {
  _mockEvaluate = vi.fn().mockReturnValue({
    decision: 'requireApproval',
    matched: true,
    reason: 'sensitive write',
    ruleId: 'R-531',
  });
  handleBeforeToolCall(
    { toolName: 'bash', params: { command: 'x' } },
    { workspaceDir, sessionId: 'sess-531', logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } },
  );
});

registry.when(/同一会话注入原则 princ-A 与 princ-B 两次/, () => {
  recordInjectionPresence(workspaceDir, ['princ-A', 'princ-B'], 'sess-inject');
  recordInjectionPresence(workspaceDir, ['princ-A', 'princ-B'], 'sess-inject');
});

registry.when(/进程重启（连接缓存清空）后再次注入相同原则/, () => {
  clearPrincipleApplicationLedgerCache();
  recordInjectionPresence(workspaceDir, ['princ-A', 'princ-B'], 'sess-inject');
});

registry.when(/RuleHost 拦截一次工具调用/, () => {
  _mockEvaluate = vi.fn().mockReturnValue({
    decision: 'block',
    matched: true,
    reason: '删除类操作必须先确认目标',
    ruleId: 'R-531',
    principleId: 'princ-531',
  });
  handleBeforeToolCall(
    { toolName: 'bash', params: { command: 'rm -rf build/' } },
    { workspaceDir, sessionId: 'sess-531', logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } },
  );
});

registry.then(/principle_applications 表新增一行 kind=rule_blocked level=effect/, () => {
  expect(countRows("WHERE kind='rule_blocked' AND level='effect'")).toBe(1);
});

registry.then(/该行包含 session_id=sess-531、rule_id=R-531 与拦截原因摘要/, () => {
  const row = readerConn!.getDb()
    .prepare("SELECT * FROM principle_applications WHERE kind='rule_blocked'")
    .get() as { session_id: string; rule_id: string; digest: string; principle_id: string };
  expect(row.session_id).toBe('sess-531');
  expect(row.rule_id).toBe('R-531');
  expect(row.digest).toContain('删除类操作必须先确认目标');
  expect(row.principle_id).toBe('princ-531');
});

registry.then(/principle_applications 表新增一行 kind=auto_correct_applied level=effect/, () => {
  expect(countRows("WHERE kind='auto_correct_applied' AND level='effect'")).toBe(1);
});

registry.then(/该行 digest 记录被纠正的字段与前后值/, () => {
  const row = readerConn!.getDb()
    .prepare("SELECT digest FROM principle_applications WHERE kind='auto_correct_applied'")
    .get() as { digest: string };
  expect(row.digest).toContain('dry_run');
  expect(row.digest).toContain('false');
  expect(row.digest).toContain('true');
});

registry.then(/principle_applications 表只有 2 行 kind=prompt_injected level=presence/, () => {
  expect(countRows("WHERE kind='prompt_injected' AND level='presence'")).toBe(2);
});

registry.then(/仍然只有 2 行 presence（部分唯一索引跨重启去重）/, () => {
  expect(countRows("WHERE kind='prompt_injected' AND level='presence'")).toBe(2);
});

registry.then(/principle_applications 表没有新增任何行/, () => {
  expect(countRows('')).toBe(0);
});

beforeEach(() => {
  clearPrincipleApplicationLedgerCache();
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ledger-bdd-'));
  readerConn = new SqliteConnection({ workspaceDir, readonly: true });
  _mockEvaluate = vi.fn().mockReturnValue(undefined);
});

afterEach(() => {
  readerConn?.close();
  readerConn = undefined;
  clearPrincipleApplicationLedgerCache();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

defineFeature(
  fs.readFileSync(resolveFeaturePath('docs/specs/features/receipt/principle-application-ledger.feature'), 'utf8'),
  registry,
);
