/**
 * Journey 10 — Rule Governance 三态 E2E (shadow → live → deactivated)。
 *
 * 此前 PARTIAL 原因: 只补了 live 事件溯源,未跑真实拦截三态。本测试用
 * 真实 SQLite store + 真实 RuleHost 运行时(与生产同构的加载/编译/评估
 * 路径,规则代码是安全的合成 benign 规则——拦截 /etc 系统目录写入):
 *
 *   SHADOW   → evaluateDetailed: liveDecision 为 undefined(真实调用不 block),
 *              shadowDecisions 记录 would_block + activationId 可审计
 *   PROMOTE  → SqliteActivationStateStore.promoteActivation(生产 promote 路径)
 *              → live evaluate 对 /etc 路径真实 block,live 事件带 activationId
 *   DEACTIVATE → 同一调用不再 block
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SqliteConnection } from '@principles/core/runtime-v2';
import { SqliteActivationStateStore } from '@principles/core/runtime-v2';
import { RuleHost } from '../../src/core/rule-host.js';

const ARTIFACT_ID = 'pi-art-j10-rule';
const RULE_ID = 'rule-j10';
const ACTIVATION_ID = 'act_code_rule-j10';
const NOW = new Date().toISOString();

/** benign 合成规则: 拦截向 /etc 系统目录的写入(安全、确定性、无副作用) */
const RULE_CODE = `
var meta = { name: 'j10-guard', version: '1', ruleId: '${RULE_ID}', coversCondition: 'all' };
function evaluate(input) {
  var p = (input.action && input.action.normalizedPath) || '';
  if (p.startsWith('/etc')) {
    return { decision: 'block', matched: true, reason: 'J10: system directory write' };
  }
  return { decision: 'allow', matched: false, reason: 'J10: not matched' };
}
`;

let tempWorkspaceDir: string;
let tempStateDir: string;
let sqliteConn: SqliteConnection;
let createdHosts: RuleHost[] = [];

function makeRuleHost(): RuleHost {
  const host = new RuleHost(tempStateDir, { warn: () => {}, info: () => {}, error: () => {} }, { workspaceDir: tempWorkspaceDir });
  createdHosts.push(host);
  return host;
}

function makeInput(targetPath: string) {
  return {
    toolName: 'write_file',
    action: { normalizedPath: targetPath, rawParams: { path: targetPath }, command: 'write' },
    context: {},
  };
}

async function insertRuleArtifact(): Promise<void> {
  const db = sqliteConn.getDb();
  db.prepare(`
    INSERT OR REPLACE INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids,
      validation_status, content_json, created_at, updated_at, source_rule_id)
    VALUES (?, 'rule', 'task-j10', '[]', 'validated', ?, ?, ?, ?)
  `).run(ARTIFACT_ID, JSON.stringify({
    principleId: 'P_J10',
    ruleId: RULE_ID,
    implementationCode: RULE_CODE,
    goldenTrace: {
      traceId: 'trace-j10', createdAt: NOW, version: 1,
      cases: [
        { caseId: 'neg-1', kind: 'negative', toolName: 'write_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
        { caseId: 'pos-1', kind: 'positive', toolName: 'write_file', params: { path: '/safe/a.txt' }, expectedDecision: 'allow' },
      ],
    },
    ruleHostGateDecision: 'accepted_shadow',
    affectedTools: ['write_file'],
  }), NOW, NOW, RULE_ID);
}

async function insertActivation(action: 'code_tool_hook_shadow_activate' | 'code_tool_hook_live_activate'): Promise<void> {
  const store = new SqliteActivationStateStore(sqliteConn);
  await store.recordActivation({
    activationId: ACTIVATION_ID,
    idempotencyKey: `${ARTIFACT_ID}::code_tool_hook`,
    artifactId: ARTIFACT_ID,
    channel: 'code_tool_hook',
    action,
    targetRef: `impl://${RULE_ID}`,
    activatedAt: NOW,
  });
}

beforeEach(async () => {
  tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-j10-'));
  tempStateDir = path.join(tempWorkspaceDir, '.principles');
  fs.mkdirSync(tempStateDir, { recursive: true });
  sqliteConn = new SqliteConnection(tempWorkspaceDir);
  await insertRuleArtifact();
});

afterEach(async () => {
  for (const h of createdHosts) { try { h.dispose(); } catch { /* best-effort */ } }
  createdHosts = [];
  try { sqliteConn.close(); } catch { /* best-effort */ }
  try { fs.rmSync(tempWorkspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
});

describe('Journey 10 — validated rule → approval → SHADOW → promote → LIVE → deactivate', () => {
  it('SHADOW: observation-only — 真实调用不 block,shadow 决策带 activationId', async () => {
    await insertActivation('code_tool_hook_shadow_activate');
    const ruleHost = makeRuleHost();

    const report = ruleHost.evaluateDetailed(makeInput('/etc/passwd') as never);

    // 关键断言 (INV-06): shadow 永不 block 真实调用
    expect(report.liveDecision).toBeUndefined();
    // 观测被记录且可审计 (activationId 贯通)
    expect(report.shadowDecisions.length).toBe(1);
    expect(report.shadowDecisions[0]?.decision).toBe('block'); // would_block
    expect(report.shadowDecisions[0]?.activationId).toBe(ACTIVATION_ID);
    // live 聚合无 activationId (shadow 期无 live)
    expect(report.liveDecisionActivationId).toBeUndefined();
  });

  it('PROMOTE → LIVE: 同一调用真实 block,live 溯源带 activationId', async () => {
    await insertActivation('code_tool_hook_shadow_activate');
    // 生产 promote 路径 (BEGIN IMMEDIATE 原子改写)
    const store = new SqliteActivationStateStore(sqliteConn);
    await store.promoteActivation(ACTIVATION_ID, new Date().toISOString());

    const ruleHost = makeRuleHost();
    const blocked = ruleHost.evaluate(makeInput('/etc/passwd') as never);
    const allowed = ruleHost.evaluate(makeInput('/safe/file.txt') as never);

    expect(blocked?.decision).toBe('block');
    expect(blocked?.ruleId).toBe(RULE_ID);
    // allow 是隐式默认 (mergeDecisions 只返回有意义决策): 安全路径不产生
    // block 决策即放行 — undefined 或 {decision:'allow'} 均为"未被拦截"
    expect(allowed?.decision ?? 'allow').toBe('allow');

    // live 事件溯源 (P1/ISSUE-023): 聚合报告携带 activationId
    const report = ruleHost.evaluateDetailed(makeInput('/etc/passwd') as never);
    expect(report.liveDecision?.decision).toBe('block');
    expect(report.liveDecisionActivationId).toBe(ACTIVATION_ID);
  });

  it('DEACTIVATE: 同一调用不再 block,shadow 观测同步消失', async () => {
    await insertActivation('code_tool_hook_live_activate');
    const store = new SqliteActivationStateStore(sqliteConn);
    await store.deactivateActivation(ACTIVATION_ID, new Date().toISOString());

    const ruleHost = makeRuleHost();
    const result = ruleHost.evaluate(makeInput('/etc/passwd') as never);
    expect(result).toBeUndefined(); // 无 active activation → 无决策(放行)

    const report = ruleHost.evaluateDetailed(makeInput('/etc/passwd') as never);
    expect(report.liveDecision).toBeUndefined();
    expect(report.shadowDecisions.length).toBe(0);
  });
});
