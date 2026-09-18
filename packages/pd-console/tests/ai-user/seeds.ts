/**
 * Optional workspace seeds for AI User scenarios (Owner Decision Experience v1).
 *
 * The harness's default is a genuinely empty first-run workspace; scenarios
 * that need governance material opt in through this registry by scenario id.
 * Seeds write ONLY into the freshly created temp workspace the bootstrap made
 * (mkdtemp) — never into any installed or production path (§1.1).
 */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { SqliteConnection, createPITaskDiagnosticJson } from '@principles/core/runtime-v2';

const AS_OF = '2026-09-18T10:00:00.000Z';
const HUMAN_TEXT = '主任务未完成前不得推进次要议题：行动焦点必须锚定 Owner 明确表达的当前目标。';
const TECH_TEXT = '读取 source-of-truth.json 的 mtime 与 MD5 值，与 CURRENT_STATE.md 比对后决定是否阻止提交。';

function writeLedger(workspaceDir: string): void {
  fs.mkdirSync(join(workspaceDir, '.state'), { recursive: true });
  fs.writeFileSync(join(workspaceDir, '.state', 'principle_training_state.json'), JSON.stringify({ _tree: { principles: {
    'prin-pending': { id: 'prin-pending', status: 'probation', text: HUMAN_TEXT, evaluability: 'weak_heuristic', derivedFromPainIds: ['cand-pending'], ruleIds: [], createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z' },
    'prin-blocked': { id: 'prin-blocked', status: 'candidate', text: TECH_TEXT, evaluability: 'weak_heuristic', derivedFromPainIds: ['cand-blocked'], ruleIds: [], createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z' },
    'prin-history': { id: 'prin-history', status: 'active', text: HUMAN_TEXT, evaluability: 'weak_heuristic', derivedFromPainIds: ['cand-history'], ruleIds: ['rule-h'], createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-15T23:31:11.835Z' },
  }, rules: {}, implementations: {}, metrics: {}, lastUpdated: AS_OF } }));
}

/**
 * Seeds the three Owner Decision v1 QA shapes:
 *   prin-pending — pending approval with readable scribe material (decision);
 *   prin-blocked — unbound technical candidate (judgment blocked);
 *   prin-history — approved + promoted + deactivated activation with one
 *                  historical deterministic effect (decided/recovery).
 */
export function seedOwnerDecisionV1Workspace(workspaceDir: string): void {
  writeLedger(workspaceDir);
  const conn = new SqliteConnection({ workspaceDir, readonly: false });
  try {
    const db = conn.getDb();
    const diagJson = createPITaskDiagnosticJson({ dependencyTaskIds: [], channel: 'prompt', timeoutMs: 30_000, inputArtifactRefs: [], outputArtifactRefs: [] });
    db.prepare(`INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts, diagnostic_json)
      VALUES ('diag-task', 'dreamer', 'succeeded', '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z', 0, 3, ?)`).run(diagJson);
    db.prepare(`INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, created_at, updated_at)
      VALUES ('run-diag', 'diag-task', 'test', 'succeeded', '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z')`).run();
    const insertArtifact = db.prepare(`INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at)
      VALUES (?, 'run-diag', 'diag-task', 'diagnostician_output', ?, ?)`);
    const diagnosis = (summary: string, rootCause: string): string => JSON.stringify({ summary, rootCause, recommendations: [] });
    insertArtifact.run('art-pending', diagnosis('Agent 在主任务未完成时切换到次要议题。', '缺乏焦点锚定机制。'), '2026-09-17T00:00:00.000Z');
    insertArtifact.run('art-blocked', diagnosis('状态文件与源不一致。', '未核对来源。'), '2026-09-13T00:00:00.000Z');
    insertArtifact.run('art-history', diagnosis('重复覆盖已存在文件。', '缺少覆盖前确认。'), '2026-09-13T00:00:00.000Z');
    const insertCandidate = db.prepare(`INSERT INTO principle_candidates
      (candidate_id, task_id, artifact_id, source_run_id, recommendation_kind, status, title, description, confidence, idempotency_key, created_at, consumed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertCandidate.run('cand-pending', 'diag-task', 'art-pending', 'run-diag', 'principle', 'consumed', 'title p', HUMAN_TEXT, 0.8, 'idem-p', '2026-09-17T00:05:00.000Z', '2026-09-17T00:06:00.000Z');
    insertCandidate.run('cand-blocked', 'diag-task', 'art-blocked', 'run-diag', 'implementation', 'consumed', 'title b', TECH_TEXT, 0.8, 'idem-b', '2026-09-13T00:05:00.000Z', '2026-09-13T00:06:00.000Z');
    insertCandidate.run('cand-history', 'diag-task', 'art-history', 'run-diag', 'principle', 'consumed', 'title h', HUMAN_TEXT, 0.55, 'idem-h', '2026-09-13T00:05:00.000Z', '2026-09-13T00:06:00.000Z');

    // prin-history: scribe + failed evaluator (recovery frontier) + approved +
    // deactivated activation + one historical deterministic effect + presence.
    db.prepare(`INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts, diagnostic_json)
      VALUES ('task-scribe-h', 'scribe', 'succeeded', '2026-09-15T08:00:00.000Z', '2026-09-15T08:10:00.000Z', 0, 3, ?)`).run(diagJson);
    const hookDiag = createPITaskDiagnosticJson({ dependencyTaskIds: ['task-scribe-h'], channel: 'code_tool_hook', timeoutMs: 30_000, inputArtifactRefs: [], outputArtifactRefs: [] });
    db.prepare(`INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts, diagnostic_json)
      VALUES ('task-eval-h', 'evaluator', 'failed', '2026-09-15T08:00:00.000Z', '2026-09-15T16:44:31.802Z', 1, 3, ?)`).run(hookDiag);
    const scribeContent = JSON.stringify({
      principleDraft: { title: '焦点锚定', statement: HUMAN_TEXT, rationale: '主任务焦点被次要议题稀释。', applicability: ['任务执行期间'], antiPatterns: ['无锚定切换话题'], confidence: 0.9 },
      risks: ['基线有缺陷时固守可能阻碍必要改进。'],
      intentContract: { targetBehavior: '切换议题前确认主任务已完成或被 Owner 明确放下。' },
    });
    db.prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES ('pi-art-h', 'principle', 'task-scribe-h', 'prin-history', '[]', 'validated', ?, '2026-09-15T08:10:00.000Z', '2026-09-15T08:10:00.000Z')`).run(scribeContent);
    db.prepare(`INSERT INTO approvals (approval_id, artifact_id, channel, status, risk_level, requested_at, decided_at, decided_by)
      VALUES ('apr-h', 'pi-art-h', 'code_tool_hook', 'approved', 'medium', '2026-09-15T23:00:00.000Z', '2026-09-15T23:31:11.835Z', 'owner')`).run();
    db.prepare(`INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, deactivated_at)
      VALUES ('act-h', 'idem-act-h', 'pi-art-h', 'code_tool_hook', 'code_rule_live_activate', 'rule://h', '2026-09-17T07:45:01.379Z', '2026-09-17T07:54:41.687Z')`).run();
    db.prepare(`INSERT INTO principle_applications (principle_id, activation_id, channel, level, kind, session_id, digest, created_at)
      VALUES ('prin-history', 'act-h', 'code_tool_hook', 'effect', 'rule_blocked', 's1', '一次确定性拦截记录', '2026-09-16T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO principle_applications (principle_id, channel, level, kind, session_id, digest, created_at)
      VALUES ('prin-history', 'prompt', 'presence', 'prompt_injected', 's1', '上下文出现记录', '2026-09-16T00:10:00.000Z')`).run();

    // prin-pending: scribe artifact + pending prompt-channel approval.
    db.prepare(`INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts, diagnostic_json)
      VALUES ('task-scribe-p', 'scribe', 'succeeded', '2026-09-17T08:00:00.000Z', '2026-09-17T08:10:00.000Z', 0, 3, ?)`).run(diagJson);
    db.prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES ('pi-art-p', 'principle', 'task-scribe-p', 'prin-pending', '[]', 'validated', ?, '2026-09-17T08:10:00.000Z', '2026-09-17T08:10:00.000Z')`).run(scribeContent);
    db.prepare(`INSERT INTO approvals (approval_id, artifact_id, channel, status, risk_level, requested_at)
      VALUES ('apr-p', 'pi-art-p', 'prompt', 'pending', 'low', '2026-09-17T09:00:00.000Z')`).run();
  } finally {
    conn.close();
  }
}

/** Scenario-id → optional seed applied to the fresh temp workspace. */
export const AI_USER_SEEDS: Record<string, (workspaceDir: string) => void> = {
  'odv1-novice-pending-decision': seedOwnerDecisionV1Workspace,
  'odv1-blocked-identity': seedOwnerDecisionV1Workspace,
  'odv1-historical-deactivated': seedOwnerDecisionV1Workspace,
};
