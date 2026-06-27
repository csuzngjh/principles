/**
 * E2E 测试数据 seed 脚本：在临时 workspace 中初始化完整 schema + 插入测试数据。
 *
 * 被 scripts/e2e-start.mjs 调用（通过 `npx tsx scripts/e2e-seed.ts <workspaceDir>`）。
 * 完成后 pd-console server 用 readonly 模式打开，读取这些预置数据。
 *
 * Seed 内容覆盖 3 个 flow test 的需求：
 * - focus-approve-flow: governance queue (2 pending approvals)
 * - principle-detail-flow: principles ledger JSON + approvals + pi_artifacts
 * - pain-intent-flow: trajectory.db pain_events + state.db tasks + candidates
 */
import { SqliteConnection } from '@principles/core/runtime-v2';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const workspaceDir = process.argv[2];
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
  'artifact-hook-1', 'principle', 'task-diag-2', 'p-001',
  '[]', 'validated', JSON.stringify({ principleId: 'p-001', title: '错误后必须分析根因' }), now, now,
);

// ── 6. 插入 principle_candidates（evidence-chain 候选，需 artifact_id + run_id）
stateDb.prepare(`
  INSERT INTO principle_candidates (
    candidate_id, artifact_id, task_id, source_run_id, title, description,
    confidence, source_recommendation_json, idempotency_key, status, created_at,
    recommendation_kind, abstracted_principle
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  'cand-1', 'artifact-diag-output-1', 'task-diag-1', 'run-1',
  '配置变更需确认', 'Agent 修改配置前应先获得 Owner 确认',
  0.85, '', 'idem-cand-1', 'consumed', eightDaysAgo,
  'apply', '修改任何配置文件前，必须先向 Owner 确认',
);

// ── 7. 插入 approvals（2 行 pending，MVP proven channels）───────────────────
stateDb.prepare(`
  INSERT INTO approvals (
    approval_id, artifact_id, channel, risk_level, status, confidence,
    requested_at, summary, trigger_reason
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  'apr-prompt-1', 'artifact-prompt-1', 'prompt', 'low', 'pending', 0.85,
  eightDaysAgo, '将"配置变更需确认"原则注入 prompt', 'Owner 审批：新增 prompt 指令',
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

stateConn.close();
console.log('[e2e-seed] state.db seeded: 2 approvals, 2 pi_artifacts, 1 task, 1 run, 1 artifact, 1 candidate');

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
  features: {
    intent_engineering: { category: 'quiet', enabled: false },
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
