/**
 * PRI-530 BDD: Principle Receipt — RuleHost block copy enrichment.
 * Drives the real recordGateBlockAndReturn against a real temp workspace
 * (real .pd/state.db seeds + real .pd/config.yaml flag resolution).
 */
import { beforeEach, afterEach, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteConnection, getDefaultPdConfig } from '@principles/core/runtime-v2';
import * as yaml from 'js-yaml';
import { recordGateBlockAndReturn } from '../../src/hooks/gate-block-helper.js';
import type { WorkspaceContext } from '../../src/core/workspace-context.js';
import { clearPrincipleReceiptMetadataCache } from '../../src/core/principle-receipt-metadata.js';
import { createStepRegistry, defineFeature } from '../../../principles-core/tests/bdd/support/vitest-bdd.js';
import { resolveFeaturePath } from '../../../principles-core/tests/bdd/support/repo-root.js';

const registry = createStepRegistry();

let workspaceDir = '';
let conn: SqliteConnection | undefined;
let blockReason = '';

function makeWctx(): WorkspaceContext {
  return {
    workspaceDir,
    stateDir: path.join(workspaceDir, '.state'),
    eventLog: {
      recordGateBlock: vi.fn(),
    },
    trajectory: { recordGateBlock: vi.fn() },
    config: { get: vi.fn().mockReturnValue(undefined) },
    resolve: (p: string) => path.join(workspaceDir, p),
  } as unknown as WorkspaceContext;
}

function seedFullMetadata(): void {
  const db = conn!.getDb();
  const now = '2026-08-01T00:00:00.000Z';
  db.prepare('INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('task-receipt', 'diagnostician', 'pending', now, now);
  db.prepare('INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('run-receipt', 'task-receipt', 'test-double', 'queued', now, now, now);
  db.prepare('INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('art-receipt', 'run-receipt', 'task-receipt', 'principle', '{}', now);
  db.prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id,
              content_json, created_at, updated_at)
              VALUES ('pi-receipt', 'principle', 'task-receipt', 'princ-530', ?, ?, ?)`)
    .run(JSON.stringify({ text: '删除类操作必须先确认目标', painReasonSummary: 'agent 差点删错目录，owner 纠正' }), now, now);
  db.prepare(`INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id,
              title, description, idempotency_key, created_at)
              VALUES ('cand-receipt', 'art-receipt', 'task-receipt', 'run-receipt', '删除前确认目标', '', 'ikey-receipt', ?)`)
    .run(now);
  db.prepare(`INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status,
              requested_at, decided_at, decided_by)
              VALUES ('appr-receipt', 'pi-receipt', 'code_tool_hook', 'high', 'approved', ?, '2026-07-30T10:00:00.000Z', 'owner')`)
    .run(now);
}

registry.given(/一个已安装 PD 的工作区，且 \.pd\/config\.yaml (启用|未启用) principle_receipt_block_copy/, (_match: string, state: string) => {
  // Build a fully valid config from the canonical defaults, then patch the flag —
  // hand-written minimal configs fail validatePdConfig (version/runtimeProfiles/
  // internalAgents are all required) and silently fall back to defaults.
  const cfg = getDefaultPdConfig() as unknown as {
    features: Record<string, { category?: string; enabled: boolean }>;
  };
  cfg.features.principle_receipt_block_copy = {
    category: 'quiet',
    enabled: state === '启用',
  };
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(cfg));
});

registry.given(/原则元数据完整：标题「删除前确认目标」、批准日期 2026-07-30、来源摘要存在/, () => {
  seedFullMetadata();
});

registry.given(/原则元数据不存在（拦截来自遗留规则 R-legacy-530）/, () => {
  // No seeds — reader joins miss and fall back to the raw rule id.
  legacyMode = true;
});

registry.when(/RuleHost 拦截一次 bash 工具调用/, () => {
  const ruleId = blockReasonCaptureRuleId();
  const result = recordGateBlockAndReturn(makeWctx(), {
    filePath: 'build/',
    reason: '删除类操作必须先确认目标',
    toolName: 'bash',
    sessionId: undefined,
    blockSource: 'rule-host',
    ruleId,
    principleId: ruleId === 'R-legacy-530' ? undefined : 'princ-530',
  }, { warn: vi.fn(), error: vi.fn(), info: vi.fn() });
  expect(result.block).toBe(true);
  blockReason = String(result.blockReason ?? '');
});

registry.then(/blockReason 包含原则标题「删除前确认目标」/, () => {
  expect(blockReason).toContain('「删除前确认目标」');
});

registry.then(/blockReason 包含批准日期 2026-07-30/, () => {
  expect(blockReason).toContain('2026-07-30');
});

registry.then(/blockReason 包含来源摘要「来源：」/, () => {
  expect(blockReason).toContain('来源：');
});

registry.then(/blockReason 指示 agent 向 Owner 解释并请求确认/, () => {
  expect(blockReason).toContain('向 Owner');
  expect(blockReason).toContain('确认');
});

registry.then(/blockReason 包含原始规则 ID R-legacy-530/, () => {
  expect(blockReason).toContain('R-legacy-530');
});

registry.then(/blockReason 不包含「来源：」/, () => {
  expect(blockReason).not.toContain('来源：');
});

registry.then(/blockReason 为既有通用模板（包含 Security Gate Blocked）/, () => {
  expect(blockReason).toContain('Security Gate Blocked');
});

registry.then(/blockReason 不包含原则署名标记「PD 原则」/, () => {
  expect(blockReason).not.toContain('PD 原则');
});

// The legacy scenario uses the rule id as attribution input (no principle id).
let legacyMode = false;
function blockReasonCaptureRuleId(): string {
  return legacyMode ? 'R-legacy-530' : 'R-530';
}

beforeEach(() => {
  clearPrincipleReceiptMetadataCache();
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-receipt-bdd-'));
  conn = new SqliteConnection(workspaceDir);
  legacyMode = false;
  blockReason = '';
});

afterEach(() => {
  conn?.close();
  clearPrincipleReceiptMetadataCache();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

defineFeature(
  fs.readFileSync(resolveFeaturePath('docs/specs/features/receipt/principle-receipt-block-copy.feature'), 'utf8'),
  registry,
);
