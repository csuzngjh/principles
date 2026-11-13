/**
 * PRI-531 BDD: principle application ledger writes at the real call sites.
 * PR-1 (legacy RuleHost retirement): the tool-call steps drive the shared
 * production seam — a `HostEventResult` (exactly what the shared gate emits for
 * the same decision) handed to `handleSharedRuleHostResult` — against a real
 * temp workspace with a real .pd/config.yaml flag; rows are asserted via a
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
} from '@principles/core/runtime';
import type { HostEventResult } from '@principles/core/host';
import { handleSharedRuleHostResult } from '../../src/hooks/gate.js';
import {
  recordInjectionPresence,
  clearPrincipleApplicationLedgerCache,
} from '../../src/core/principle-application-ledger.js';
import { clearPrincipleReceiptMetadataCache } from '../../src/core/principle-receipt-metadata.js';
import { createStepRegistry, defineFeature } from '../../../principles-core/tests/bdd/support/vitest-bdd.js';
import { resolveFeaturePath } from '../../../principles-core/tests/bdd/support/repo-root.js';

const registry = createStepRegistry();
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
  recordGateBlock: vi.fn(),
};
vi.mock('../../src/core/event-log.js', () => ({
  EventLogService: { get: vi.fn(() => mockEventLogInstance) },
}));
vi.mock('../../src/core/workspace-context.js', () => ({
  WorkspaceContext: {
    fromHookContext: vi.fn((ctx: { workspaceDir?: string }) => ({
      workspaceDir: ctx.workspaceDir,
      stateDir: (ctx.workspaceDir ?? '') + '/.state',
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

/**
 * PR-1 (legacy RuleHost retirement): the steps used to drive
 * `handleBeforeToolCall`, which has no production wiring. Each step now builds
 * the `HostEventResult` the shared production gate emits for the same decision
 * and hands it to the adapter that records it.
 */
function runSharedGate(params: Record<string, unknown>, result: HostEventResult): void {
  handleSharedRuleHostResult(
    { toolName: 'exec', params },
    { workspaceDir, sessionId: 'sess-531', logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } },
    result,
  );
}

registry.given(/一个已安装 PD 的工作区，且 \.pd\/config\.yaml (启用|未启用) principle_receipt_ledger/, (_m: string, state: string) => {
  writeConfig(state === '启用');
});

registry.when(/RuleHost 拦截一次工具调用（规则 R-531，会话 sess-531）/, () => {
  runSharedGate({ command: 'rm -rf build/' }, {
    decision: 'deny',
    source: 'openclaw:before_tool_call',
    reason: '删除类操作必须先确认目标',
    metadata: {
      evaluatedLiveRules: 1,
      ruleId: 'R-531',
      principleId: 'princ-531',
      evaluations: [
        { toolName: 'exec', filePath: 'rm -rf build/', matched: true, decision: 'block', ruleId: 'R-531', activationMode: 'live' },
      ],
    },
  });
});

registry.when(/RuleHost 对一次工具调用应用 live 自动纠正（dry_run false→true）/, () => {
  runSharedGate({ command: 'rm -rf build/', dry_run: false }, {
    decision: 'allow',
    source: 'openclaw:before_tool_call',
    metadata: {
      evaluatedLiveRules: 1,
      ruleDecision: 'auto_correct',
      matched: true,
      ruleId: 'R-531',
      principleId: 'princ-531',
      ruleReason: 'enforce dry run',
      correctionProposal: {
        proposedParams: { dry_run: true },
        correctedFields: [{ field: 'dry_run', original: false, proposed: true, reason: 'enforce dry run' }],
        applicationMode: 'live',
        confidence: 0.9,
        ruleId: 'R-531',
        principleId: 'princ-531',
        notifyAgent: false,
      },
      evaluations: [
        { toolName: 'exec', filePath: 'rm -rf build/', matched: true, decision: 'auto_correct', ruleId: 'R-531', activationMode: 'live' },
      ],
    },
  });
});

registry.when(/RuleHost 对一次工具调用返回 requireApproval/, () => {
  runSharedGate({ command: 'x' }, {
    decision: 'allow',
    source: 'openclaw:before_tool_call',
    metadata: {
      evaluatedLiveRules: 1,
      ruleDecision: 'requireApproval',
      matched: true,
      ruleId: 'R-531',
      ruleReason: 'sensitive write',
      evaluations: [
        { toolName: 'exec', filePath: 'x', matched: true, decision: 'requireApproval', ruleId: 'R-531', activationMode: 'live' },
      ],
    },
  });
});

const PRINC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRINC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

registry.when(/同一会话注入原则 princ-A 与 princ-B 两次/, () => {
  recordInjectionPresence(workspaceDir, [PRINC_A, PRINC_B], 'sess-inject');
  recordInjectionPresence(workspaceDir, [PRINC_A, PRINC_B], 'sess-inject');
});

registry.when(/进程重启（连接缓存清空）后再次注入相同原则/, () => {
  clearPrincipleApplicationLedgerCache();
  recordInjectionPresence(workspaceDir, [PRINC_A, PRINC_B], 'sess-inject');
});

registry.when(/RuleHost 拦截一次工具调用/, () => {
  runSharedGate({ command: 'rm -rf build/' }, {
    decision: 'deny',
    source: 'openclaw:before_tool_call',
    reason: '删除类操作必须先确认目标',
    metadata: {
      evaluatedLiveRules: 1,
      ruleId: 'R-531',
      principleId: 'princ-531',
      evaluations: [
        { toolName: 'exec', filePath: 'rm -rf build/', matched: true, decision: 'block', ruleId: 'R-531', activationMode: 'live' },
      ],
    },
  });
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
});

afterEach(() => {
  readerConn?.close();
  readerConn = undefined;
  clearPrincipleApplicationLedgerCache();
  // The shared deny path now builds the owner-facing block copy, which opens a
  // cached readonly metadata connection to this workspace (PRI-1184 / F4).
  clearPrincipleReceiptMetadataCache();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

defineFeature(
  fs.readFileSync(resolveFeaturePath('docs/specs/features/receipt/principle-application-ledger.feature'), 'utf8'),
  registry,
);
