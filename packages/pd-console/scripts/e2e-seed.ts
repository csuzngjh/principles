/**
 * E2E 测试数据 seed 脚本：在临时 workspace 中初始化完整 schema + 插入测试数据。
 *
 * 被 scripts/e2e-start.mjs 调用（通过 `npx tsx scripts/e2e-seed.ts <workspaceDir>`）。
 * 完成后 pd-console server 用 readonly 模式打开，读取这些预置数据。
 *
 * Seed 内容覆盖 3 个 flow test 的需求：
 * - focus-approve-flow + BDD: isolated prompt approvals for each mutable flow
 * - principle-detail-flow: principles ledger JSON + approvals + pi_artifacts
 * - pain-intent-flow: trajectory.db pain_events + state.db tasks + candidates
 */
import { SqliteConnection } from '@principles/core/runtime-v2';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const workspaceDir = process.argv[2];
const ownerAuthEnabled = process.env.PD_CONSOLE_E2E_OWNER_AUTH === '1';
if (!workspaceDir || !fs.existsSync(workspaceDir)) {
  console.error('[e2e-seed] usage: tsx e2e-seed.ts <workspaceDir>');
  process.exit(1);
}

const now = new Date().toISOString();
const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

// ── 1. 初始化 state.db 完整 schema（writable 模式自动建表）──────────────────
const stateDir = path.join(workspaceDir, '.pd');
fs.mkdirSync(stateDir, { recursive: true });

const stateConn = new SqliteConnection({ workspaceDir, readonly: false });

// PRI-634-F R3: e2e workspaces must carry a persisted host declaration —
// the activation paths (CLI and Console alike) refuse code_tool_hook
// approvals when workspace host provenance is unresolvable. The seed acts
// as the 'host' here, declaring the gate-reachable OpenClaw surface so
// artifact-level contracts (e.g. PR #1079 goldenTrace schema validation)
// are exercised instead of being masked by a provenance refusal.
const hostSemanticsDir = path.join(workspaceDir, '.pd', 'host-tool-semantics');
fs.mkdirSync(hostSemanticsDir, { recursive: true });
fs.writeFileSync(
  path.join(hostSemanticsDir, 'openclaw.json'),
  JSON.stringify({
    version: 1,
    hostKind: 'openclaw',
    mappings: [
      { rawToolName: 'bash', canonicalKind: 'execute' },
      { rawToolName: 'run_shell_command', canonicalKind: 'execute' },
      { rawToolName: 'write', canonicalKind: 'write' },
      { rawToolName: 'write_file', canonicalKind: 'write' },
      { rawToolName: 'edit', canonicalKind: 'write' },
      { rawToolName: 'edit_file', canonicalKind: 'write' },
    ],
    declaredAt: new Date().toISOString(),
  }),
  'utf8',
);
const stateDb = stateConn.getDb();
stateDb.pragma('foreign_keys = OFF');

console.log('[e2e-seed] state.db schema initialized');

// ── 2. 插入 tasks（diagnostician 诊断任务，evidence-chain 用）────────────────
stateDb.prepare(`
  INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, last_error, attempt_count, diagnostic_json, input_ref)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  'task-diag-1', 'diagnostician', 'succeeded', eightDaysAgo, eightDaysAgo, null,
  1, JSON.stringify({ painId: 'pain-1', rootCause: 'Agent 未确认就修改配置' }), '1',
);

// ── 3. 插入 runs（artifacts 和 principle_candidates 的父表）──────────────────
stateDb.prepare(`
  INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, ended_at, attempt_number, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run('run-1', 'task-diag-1', 'diagnostician', 'succeeded', eightDaysAgo, eightDaysAgo, 1, eightDaysAgo, eightDaysAgo);

// ── 4. 插入 artifacts（diagnostician_output，evidence-chain PRI-469 用）──────
stateDb.prepare(`
  INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(
  'artifact-diag-output-1', 'run-1', 'task-diag-1', 'diagnostician_output',
  JSON.stringify({ rootCause: 'Agent 未确认就修改配置', evidence: ['pain-1'] }), eightDaysAgo,
);

// ── 5. 插入 pi_artifacts（approvals 的父表，principle internalization）──────
const insertPiArtifact = stateDb.prepare(`
  INSERT INTO pi_artifacts (
    artifact_id, artifact_kind, source_task_id, source_principle_id,
    lineage_artifact_ids, validation_status, content_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
insertPiArtifact.run(
  'artifact-prompt-1', 'principle', 'task-diag-1', 'p-001',
  '[]', 'validated', JSON.stringify({ principleId: 'p-001', title: '配置变更需确认' }), now, now,
);
insertPiArtifact.run(
  'artifact-prompt-bdd', 'principle', 'task-diag-bdd', 'p-002',
  '[]', 'validated', JSON.stringify({ principleId: 'p-002', title: 'BDD 审批隔离原则' }), now, now,
);
// PRI-586: isolated artifact+approval pair for governance-experience.spec.ts
// (nothing else consumes it, so the spec is deterministic in a full serial run).
// pi_artifacts has UNIQUE(source_task_id, artifact_kind), so it needs its own
// source task id.
insertPiArtifact.run(
  'artifact-experience-1', 'principle', 'task-diag-exp', 'p-002',
  '[]', 'validated', JSON.stringify({ principleId: 'p-002', title: '治理体验快照验证原则' }), now, now,
);
insertPiArtifact.run(
  'artifact-hook-1', 'principle', 'task-diag-2', 'p-001',
  '[]', 'validated', JSON.stringify({ principleId: 'p-001', title: '错误后必须分析根因' }), now, now,
);

// Regression fixture for PR #1079: a rule artifact with an illegal
// `expectedDecision: 'requireApproval'` in its goldenTrace. This value
// is a RuleHostDecision runtime enum, NOT a GoldenTraceDecision test
// expectation (legal: allow | block | propose_correction). Before
// PR #1079, extractGoldenTrace() used `as unknown as GoldenTrace` to
// bypass schema validation, so this artifact would slip through and
// fail later inside the sandbox with an opaque
// `gate_decision_not_accepted_shadow:rejected_validation_failed` error.
// After PR #1079, the canonical validateGoldenTrace() rejects it at
// the schema layer with `golden_trace_schema_invalid: <detail>`.
insertPiArtifact.run(
  'artifact-rule-bad-trace', 'rule', 'task-diag-1', 'p-001',
  '[]', 'validated',
  JSON.stringify({
    implementationCode: 'function evaluate(input, helpers) { return { decision: "requireApproval", matched: true, reason: "test" }; }',
    goldenTrace: {
      traceId: 'gt-bad-trace-1',
      sourcePainId: 'pain-e2e-1',
      cases: [
        {
          caseId: 'case-bad-negative',
          kind: 'negative',
          toolName: 'write_file',
          params: { path: '/etc/passwd' },
          // ILLEGAL: requireApproval is a RuleHostDecision, not a
          // GoldenTraceDecision. Legal values: allow | block | propose_correction.
          expectedDecision: 'requireApproval',
        },
        {
          caseId: 'case-valid-positive',
          kind: 'positive',
          toolName: 'write_file',
          params: { path: '/project/src/safe.ts' },
          expectedDecision: 'allow',
        },
      ],
      createdAt: now,
      version: 1,
    },
    ruleHostGateDecision: 'accepted_shadow',
    affectedTools: ['write_file'],
  }),
  now, now,
);

const safeRuleCode = 'function evaluate(input) { const risky = input.action.toolName === "edit_file" && input.action.paramsSummary.path === "/etc/passwd"; return { decision: risky ? "block" : "allow", matched: risky, reason: risky ? "risk path" : "neutral" }; }';
function ownerReviewRuleContent(ruleId: string, principleId = 'p-rulecode-owner') {
  return JSON.stringify({
    principleId,
    ruleId,
    implementationCode: safeRuleCode,
    goldenTrace: {
      traceId: `trace-${ruleId}`,
      sourcePainId: 'pain-e2e-1',
      cases: [
        { caseId: 'negative', kind: 'negative', toolName: 'edit_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
        { caseId: 'positive', kind: 'positive', toolName: 'edit_file', params: { path: '/workspace/safe.ts' }, expectedDecision: 'allow' },
      ],
      createdAt: eightDaysAgo,
      version: 1,
    },
    ruleHostGateDecision: 'accepted_shadow',
    affectedTools: ['edit_file'],
  });
}

insertPiArtifact.run(
  'artifact-rule-owner-shadow', 'rule', 'task-rule-owner-shadow', 'p-rulecode-owner',
  '["artifact-diag-output-1"]', 'validated', ownerReviewRuleContent('rule-owner-shadow'), now, now,
);
insertPiArtifact.run(
  'artifact-rule-owner-live', 'rule', 'task-rule-owner-live', 'p-rulecode-owner',
  '["artifact-diag-output-1"]', 'validated', ownerReviewRuleContent('rule-owner-live'), now, now,
);

const insertRuleActivation = stateDb.prepare(`
  INSERT INTO activations (
    activation_id, idempotency_key, artifact_id, channel, action, target_ref,
    activated_at, promoted_at, deactivated_at
  ) VALUES (?, ?, ?, 'code_tool_hook', ?, ?, ?, ?, NULL)
`);
insertRuleActivation.run(
  'act-rule-shadow-e2e', 'idem-rule-shadow-e2e', 'artifact-rule-owner-shadow',
  'code_tool_hook_shadow_activate', 'impl://rule-owner-shadow', eightDaysAgo, null,
);
insertRuleActivation.run(
  'act-rule-live-e2e', 'idem-rule-live-e2e', 'artifact-rule-owner-live',
  'code_tool_hook_live_activate', 'impl://rule-owner-live', eightDaysAgo, eightDaysAgo,
);
stateDb.prepare(`
  INSERT INTO activation_control_states (activation_id, enforcement, isolation_decision_id, version, updated_at)
  VALUES (?, 'eligible', NULL, 1, ?)
`).run('act-rule-shadow-e2e', now);
stateDb.prepare(`
  INSERT INTO activation_control_states (activation_id, enforcement, isolation_decision_id, version, updated_at)
  VALUES (?, 'eligible', NULL, 1, ?)
`).run('act-rule-live-e2e', now);
if (ownerAuthEnabled) {
  insertPiArtifact.run(
    'artifact-rule-owner-reject', 'rule', 'task-rule-owner-reject', 'p-rulecode-reject',
    '["artifact-diag-output-1"]', 'validated', ownerReviewRuleContent('rule-owner-reject', 'p-rulecode-reject'), now, now,
  );
  insertRuleActivation.run(
    'act-rule-reject-e2e', 'idem-rule-reject-e2e', 'artifact-rule-owner-reject',
    'code_tool_hook_shadow_activate', 'impl://rule-owner-reject', eightDaysAgo, null,
  );
  stateDb.prepare(`
    INSERT INTO activation_control_states (activation_id, enforcement, isolation_decision_id, version, updated_at)
    VALUES (?, 'eligible', NULL, 1, ?)
  `).run('act-rule-reject-e2e', now);
}

// ── 6. 插入 principle_candidates（evidence-chain 候选，需 artifact_id + run_id）
// F13 (PRI-442): schema 现在强制 CHECK (status != 'consumed' OR consumed_at IS NOT NULL)
// — consumed 状态的候选必须提供 consumed_at。这里用 created_at 同时间戳。
stateDb.prepare(`
  INSERT INTO principle_candidates (
    candidate_id, artifact_id, task_id, source_run_id, title, description,
    confidence, source_recommendation_json, idempotency_key, status, created_at, consumed_at,
    recommendation_kind, abstracted_principle
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  'cand-1', 'artifact-diag-output-1', 'task-diag-1', 'run-1',
  '配置变更需确认', 'Agent 修改配置前应先获得 Owner 确认',
  0.85, '', 'idem-cand-1', 'consumed', eightDaysAgo, eightDaysAgo,
  'apply', '修改任何配置文件前，必须先向 Owner 确认',
);

// ── 7. 插入 approvals（E2E 与 BDD 使用独立的可变记录）──────────────────────
stateDb.prepare(`
  INSERT INTO approvals (
    approval_id, artifact_id, channel, risk_level, status, confidence,
    requested_at, summary, trigger_reason
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  'apr-prompt-bdd', 'artifact-prompt-bdd', 'prompt', 'low', 'pending', 0.85,
  eightDaysAgo, 'BDD 场景专用 prompt 原则', 'Owner 审批：BDD 隔离记录',
);
stateDb.prepare(`
  INSERT INTO approvals (
    approval_id, artifact_id, channel, risk_level, status, confidence,
    requested_at, summary, trigger_reason
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  'apr-prompt-1', 'artifact-prompt-1', 'prompt', 'low', 'pending', 0.85,
  eightDaysAgo, '将"配置变更需确认"原则注入 prompt', 'Owner 审批：新增 prompt 指令',
);
// PRI-586: isolated approval for governance-experience.spec.ts (prompt channel,
// valid artifact — approving it activates cleanly like apr-prompt-1).
stateDb.prepare(`
  INSERT INTO approvals (
    approval_id, artifact_id, channel, risk_level, status, confidence,
    requested_at, summary, trigger_reason
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  'apr-experience-1', 'artifact-experience-1', 'prompt', 'low', 'pending', 0.85,
  eightDaysAgo, '治理体验快照用户流程验证', 'Owner 审批：治理体验专用记录',
);
stateDb.prepare(`
  INSERT INTO approvals (
    approval_id, artifact_id, channel, risk_level, status, confidence,
    requested_at, summary, trigger_reason
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  'apr-hook-1', 'artifact-hook-1', 'code_tool_hook', 'medium', 'pending', 0.78,
  now, '将"错误后必须分析根因"挂载到 code_tool_hook', 'Owner 审批：新增工具调用钩子',
);

// Regression approval for PR #1079: points at the bad-trace rule artifact.
// Approving this MUST return 500 activation_failed with reason containing
// 'golden_trace_schema_invalid' (post-fix), NOT 'gate_decision_not_accepted_shadow'
// (pre-fix opaque error). The approval is rolled back to pending so the
// owner can retry after fixing the artifact.
stateDb.prepare(`
  INSERT INTO approvals (
    approval_id, artifact_id, channel, risk_level, status, confidence,
    requested_at, summary, trigger_reason
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  'apr-hook-bad-trace', 'artifact-rule-bad-trace', 'code_tool_hook', 'high', 'pending', 0.72,
  now, '回归测试：rule artifact 含非法 expectedDecision=requireApproval', 'Owner 审批：触发 golden_trace_schema_invalid 验证',
);

// ── PRI-517: dedicated isolated records for real-UI-click e2e ───────────────
// Each click action gets its own approval + artifact + principle so the
// focus-governance-clicks.spec.ts tests never mutate records owned by other
// specs (focus-approve-flow / BDD). All are prompt channel (MVP-reversible)
// so approve produces a real activation and deactivate is available.
insertPiArtifact.run(
  'artifact-click-approve', 'principle', 'task-click-approve', 'p-click-approve',
  '[]', 'validated', JSON.stringify({ principleId: 'p-click-approve', title: '点击批准测试原则' }), now, now,
);
insertPiArtifact.run(
  'artifact-click-reject', 'principle', 'task-click-reject', 'p-click-reject',
  '[]', 'validated', JSON.stringify({ principleId: 'p-click-reject', title: '点击拒绝测试原则' }), now, now,
);
insertPiArtifact.run(
  'artifact-click-edit', 'principle', 'task-click-edit', 'p-click-edit',
  '[]', 'validated', JSON.stringify({ principleId: 'p-click-edit', title: '点击编辑测试原则' }), now, now,
);
// Edit replacement artifact (pre-validated, so editApproval can point at it).
// NOTE: pi_artifacts has a UNIQUE(source_task_id, artifact_kind) constraint, so
// this artifact needs its own source_task_id distinct from artifact-click-edit.
insertPiArtifact.run(
  'artifact-click-edit-new', 'principle', 'task-click-edit-new', 'p-click-edit',
  '[]', 'validated', JSON.stringify({ principleId: 'p-click-edit', title: '编辑后新原则' }), now, now,
);
const insertClickApproval = stateDb.prepare(`
  INSERT INTO approvals (
    approval_id, artifact_id, channel, risk_level, status, confidence,
    requested_at, summary, trigger_reason
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
insertClickApproval.run(
  'apr-click-approve', 'artifact-click-approve', 'prompt', 'low', 'pending', 0.85,
  eightDaysAgo, '点击测试：批准', 'Owner 审批：UI 点击批准',
);
insertClickApproval.run(
  'apr-click-reject', 'artifact-click-reject', 'prompt', 'low', 'pending', 0.85,
  eightDaysAgo, '点击测试：拒绝', 'Owner 审批：UI 点击拒绝',
);
insertClickApproval.run(
  'apr-click-edit', 'artifact-click-edit', 'prompt', 'low', 'pending', 0.85,
  eightDaysAgo, '点击测试：编辑', 'Owner 审批：UI 点击编辑',
);

stateConn.close();
console.log('[e2e-seed] state.db seeded with approvals plus shadow/live RuleCode Owner review fixtures');

const logsDir = path.join(stateDir, 'logs');
fs.mkdirSync(logsDir, { recursive: true });
const shadowEvents = Array.from({ length: 20 }, (_, index) => ({
  ts: new Date(Date.now() - (25 * 60 - index * 70) * 60 * 1000).toISOString(),
  type: 'rulehost_evaluated',
  category: 'observation',
  data: {
    activationId: 'act-rule-shadow-e2e',
    activationMode: 'shadow',
    matched: index < 4,
    decision: index < 2 ? 'block' : 'allow',
    toolName: 'edit_file',
    filePath: index < 4 ? '/workspace/config.ts' : '/workspace/readme.md',
  },
}));
const liveEvents = Array.from({ length: 4 }, (_, index) => ({
  ts: new Date(Date.now() - index * 60 * 60 * 1000).toISOString(),
  type: 'rulehost_evaluated',
  category: 'observation',
  data: {
    activationId: 'act-rule-live-e2e',
    activationMode: 'live',
    matched: index === 0,
    decision: index === 0 ? 'block' : 'allow',
    toolName: 'edit_file',
    filePath: '/workspace/config.ts',
  },
}));
fs.writeFileSync(
  path.join(logsDir, `events_${now.slice(0, 10)}.jsonl`),
  [...shadowEvents, ...liveEvents].map(event => JSON.stringify(event)).join('\n'),
  'utf8',
);

// ── 8. 初始化 trajectory.db + pain_events ───────────────────────────────────
const trajectoryDir = path.join(workspaceDir, '.state');
fs.mkdirSync(trajectoryDir, { recursive: true });
const trajectoryDbPath = path.join(trajectoryDir, 'trajectory.db');

const trajDb = new Database(trajectoryDbPath);
trajDb.exec(`
  CREATE TABLE IF NOT EXISTS pain_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    source TEXT NOT NULL,
    score REAL NOT NULL DEFAULT 0,
    reason TEXT,
    severity TEXT,
    origin TEXT,
    confidence REAL,
    text TEXT,
    created_at TEXT NOT NULL,
    canonical_pain_id TEXT,
    runtime_task_id TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pain_events_canonical_pain_id
    ON pain_events(canonical_pain_id)
    WHERE canonical_pain_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS gate_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    session_id TEXT,
    reason TEXT
  );
`);

trajDb.prepare(`
  INSERT INTO pain_events (
    session_id, source, score, reason, severity, origin, confidence,
    text, created_at, canonical_pain_id, runtime_task_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  'session-e2e-1', 'manual', 0.8, 'Agent 修改配置未确认', 'medium', 'gate',
  0.85, 'Agent 在未经 Owner 确认的情况下修改了数据库配置', eightDaysAgo,
  'pain-e2e-1', 'task-diag-1',
);

trajDb.close();
console.log('[e2e-seed] trajectory.db seeded: 1 pain_event');

// ── 9. 写入 principle_training_state.json ───────────────────────────────────
const ledgerPath = path.join(trajectoryDir, 'principle_training_state.json');
const ledger = {
  _tree: {
    principles: {
      'p-001': {
        id: 'p-001',
        status: 'active',
        text: '配置变更需确认',
        triggerPattern: 'on-config-change',
        action: '修改任何配置文件前，必须先向 Owner 确认',
        evaluability: 'deterministic',
        priority: 'P1',
        scope: 'general',
        domain: '',
        valueScore: 0,
        adherenceRate: 0,
        painPreventedCount: 0,
        ruleIds: [],
        conflictsWithPrincipleIds: [],
        derivedFromPainIds: ['pain-e2e-1'],
        createdAt: eightDaysAgo,
        updatedAt: now,
      },
    },
    rules: {},
  },
  'p-001': {
    principleId: 'p-001',
    evaluability: 'deterministic',
    applicableOpportunityCount: 0,
    observedViolationCount: 0,
    complianceRate: 0,
    violationTrend: 0,
    generatedSampleCount: 0,
    approvedSampleCount: 0,
    includedTrainRunIds: [],
    deployedCheckpointIds: [],
    internalizationStatus: 'needs_training',
  },
};
fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), 'utf8');
console.log('[e2e-seed] principle_training_state.json written: 1 principle (p-001)');

// ── 10. 写入最小有效 .pd/config.yaml ─────────────────────────────────────────
// 必须包含 validatePdConfig 要求的所有 required sections（version/runtimeProfiles/
// internalAgents/ui），features section 包含 intent_engineering=false（默认 off）。
// 这样 intent-onboarding-flow.spec.ts 的 PATCH /config/features/intent_engineering
// 只需 toggle 已存在的 flag，不会触发 auto-create-features 路径（该路径生成的不完整
// config 会 fail validatePdConfig → 409 conflict）。
const configPath = path.join(stateDir, 'config.yaml');
const minimalConfig = {
  version: 1,
  workspace: {
    // PRI-587: environment classification exercised by governance-experience.spec.ts
    default: workspaceDir,
    environment: 'test',
  },
  features: {
    intent_engineering: { category: 'quiet', enabled: false },
    rulecode_owner_live_decision: { category: 'core', enabled: ownerAuthEnabled },
    rulecode_safety_controls: { category: 'core', enabled: true },
    // PRI-584~587: governance experience snapshot ON for e2e — existing specs
    // assert API contracts and approve buttons (both preserved in experience
    // mode), so the whole suite now also covers the new Focus path.
    governance_experience_v1: { category: 'quiet', enabled: true },
  },
  runtimeProfiles: {
    'openclaw.default': { type: 'openclaw', source: 'default' },
  },
  internalAgents: {
    defaultRuntime: 'openclaw.default',
    agents: {
      diagnostician: { enabled: true, runtimeProfile: 'openclaw.default' },
      dreamer: { enabled: true },
      scribe: { enabled: true },
    },
  },
  ui: { diagnostics: { mode: 'simple' } },
};
fs.writeFileSync(configPath, yaml.dump(minimalConfig), 'utf8');
console.log('[e2e-seed] .pd/config.yaml written: intent_engineering=false (flag-off default)');

console.log('[e2e-seed] done — workspace ready for E2E tests');
