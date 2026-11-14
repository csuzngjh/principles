/**
 * SPEC-PD-CONSOLE-READABILITY-002 切片 1 — R1 静态乱码修复（模型层）。
 *
 * TDD：先于实现编写。走真实生产路径 ApprovalsGroupedConsoleModel.getApprovalsGrouped()
 * （真实 SQLite workspace + 真实提取链），不以仅搜索源码替代验证。
 *
 * 证据边界（SPEC E11 / AC-R1）：
 * - scribe（principleDraft.title+statement）是生产可达分支（runtime scribe
 *   写入该形状）——按生产路径验证；
 * - rule（implementationCode 注释提取）未发现生产写入方——此处为提取函数级
 *   验证 + 向后兼容，不冒称当前生产数据路径；
 * - 动态数据疑似损坏原文必须逐字保留：本测试同时锁死「输出不改写真实值」。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PrincipleTreeLedgerAdapter, SqliteConnection } from "@principles/core/runtime";
import { ApprovalsGroupedConsoleModel } from "../../src/server/models/ApprovalsGroupedConsoleModel.js";

const REPLACEMENT_CHAR = "\uFFFD";

let tmpDir: string;
let conn: SqliteConnection;

function seedArtifact(artifactId: string, principleId: string, contentJson: string): void {
  const now = "2026-10-13T08:00:00.000Z";
  conn.getDb().prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, 'principle', ?, ?, NULL, '[]', 'validated', ?, ?, ?)
  `).run(artifactId, `task-${artifactId}`, principleId, contentJson, now, now);
}

function seedApproval(approvalId: string, artifactId: string): void {
  const now = "2026-10-13T08:00:00.000Z";
  conn.getDb().prepare(`
    INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at, summary, trigger_reason)
    VALUES (?, ?, 'prompt', 'low', 'pending', 0.85, ?, ?, 'SPEC-PD-CONSOLE-READABILITY-002 切片1 测试')
  `).run(approvalId, artifactId, now, `${approvalId} summary`);
}

/**
 * Production shape of the reported 2026-09-19 record: the scribe artifact has
 * NO source_principle_id and NO principleId in content. Its identity exists
 * only as candidate lineage (sourceTrace.dreamerArtifactId → dreamer task →
 * candidate id → ledger principle).
 */
function seedLegacyLineage(scribeArtifactId: string, candidateId: string, principleId: string): void {
  const now = "2026-10-13T08:00:00.000Z";
  const dreamerTaskId = `dreamer-${candidateId}-prompt`;
  const dreamerArtifactId = `pi-art-dreamer-${candidateId}-prompt`;
  const runId = crypto.randomUUID();
  const db = conn.getDb();

  db.prepare(
    "INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts) VALUES (?, ?, ?, ?, ?, 0, 3)",
  ).run(dreamerTaskId, "dreamer", "succeeded", now, now);
  db.prepare(
    "INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, created_at, updated_at, attempt_number) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
  ).run(runId, dreamerTaskId, "openclaw", "succeeded", now, now, now);
  db.prepare(
    "INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(dreamerArtifactId, runId, dreamerTaskId, "dreamer", "{}", now);
  db.prepare(`
    INSERT INTO principle_candidates
      (candidate_id, artifact_id, task_id, source_run_id, title, description, confidence,
       source_recommendation_json, idempotency_key, status, consumed_at, created_at, recommendation_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'consumed', ?, ?, 'principle')
  `).run(candidateId, dreamerArtifactId, dreamerTaskId, runId, "legacy", "legacy", 0.9, "{}", `idem-${candidateId}`, now, now);

  new PrincipleTreeLedgerAdapter({ stateDir: path.join(tmpDir, ".state") }).writeProbationEntry({
    id: principleId,
    title: "Legacy scribe principle",
    text: "A committed statement with a real consequence.",
    triggerPattern: "before_tool_call",
    action: "inject review note",
    status: "probation",
    evaluability: "weak_heuristic",
    sourceRef: `candidate://${candidateId}`,
    createdAt: now,
  });

  // The two pi_artifacts rows the identity resolver walks.
  const insertArtifact = db.prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, NULL, NULL, ?, 'validated', ?, ?, ?)
  `);
  insertArtifact.run(dreamerArtifactId, "dreamer", dreamerTaskId, "[]", "{}", now, now);
  insertArtifact.run(scribeArtifactId, "principle", `scribe-${candidateId}-prompt`, JSON.stringify([dreamerArtifactId]), JSON.stringify({
    principleDraft: { title: "Legacy scribe principle", statement: "A committed statement with a real consequence.", rationale: "legacy" },
    sourceTrace: { dreamerArtifactId },
  }), now, now);
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-readability-s1-"));
  conn = new SqliteConnection({ workspaceDir: tmpDir });
});

afterAll(() => {
  try { conn.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("R1 — extractCandidateDescription 静态乱码（生产路径 getApprovalsGrouped）", () => {
  it("scribe 分支（生产可达）：title+statement 连接不再由源码注入替换字符，且两段原文逐字保留", async () => {
    const principleId = "11111111-1111-4111-8111-111111111111";
    const title = "“共享状态”写入需说明后果 😀";
    const statement = "高代价的共享状态写入必须先给出可读的后果说明，\n再由 Owner 决定。\n\n含空行与引号 “quote”。";
    seedArtifact("art-r1-scribe", principleId, JSON.stringify({
      principleId,
      principleDraft: { title, statement, rationale: "r" },
    }));
    seedApproval("apr-r1-scribe", "art-r1-scribe");

    const model = new ApprovalsGroupedConsoleModel(tmpDir);
    const result = await model.getApprovalsGrouped("openclaw");
    const group = result.groups.find((g) => g.records.some((r) => r.artifactId === "art-r1-scribe"));
    expect(group).toBeDefined();
    expect(group?.candidateDescription).toBeDefined();
    const description = group?.candidateDescription as string;
    // 核心断言：源码不再注入 U+FFFD
    expect(description.includes(REPLACEMENT_CHAR)).toBe(false);
    // 原文逐字保留（R1：不因修复乱码而改写真实值）
    expect(description.includes(title)).toBe(true);
    expect(description.includes(statement)).toBe(true);
  });

  it("rule 分支（提取函数级验证，无生产写入方）：principle+rule 注释提取不再注入替换字符", async () => {
    const principleId = "22222222-2222-4222-8222-222222222222";
    const principleText = "先确认范围，再修改现有内容";
    const ruleText = "删除或整体重写前必须说明影响";
    const implementationCode = [
      "// Principle: " + principleText,
      "// Rule: " + ruleText,
      "if (changingSharedState) requireConfirmation();",
    ].join("\n");
    seedArtifact("art-r1-rule", principleId, JSON.stringify({ principleId, implementationCode }));
    seedApproval("apr-r1-rule", "art-r1-rule");

    const model = new ApprovalsGroupedConsoleModel(tmpDir);
    const result = await model.getApprovalsGrouped("openclaw");
    const group = result.groups.find((g) => g.records.some((r) => r.artifactId === "art-r1-rule"));
    expect(group).toBeDefined();
    const description = group?.candidateDescription as string;
    expect(description.includes(REPLACEMENT_CHAR)).toBe(false);
    expect(description.includes(principleText)).toBe(true);
    expect(description.includes(ruleText)).toBe(true);
  });

  it("text 分支（提取函数级验证）：纯 text 工件逐字返回", async () => {
    const principleId = "33333333-3333-4333-8333-333333333333";
    const text = "配置变更需确认：先给出后果说明，再由 Owner 决定。";
    seedArtifact("art-r1-text", principleId, JSON.stringify({ principleId, title: "t", text }));
    seedApproval("apr-r1-text", "art-r1-text");

    const model = new ApprovalsGroupedConsoleModel(tmpDir);
    const result = await model.getApprovalsGrouped("openclaw");
    const group = result.groups.find((g) => g.records.some((r) => r.artifactId === "art-r1-text"));
    expect(group?.candidateDescription).toBe(text);
  });

  it("损坏的 contentJson 不被静默改写：JSON 解析失败时描述缺失（null 路径），不注入任何字符", async () => {
    const principleId = "44444444-4444-4444-8444-444444444444";
    seedArtifact("art-r1-broken", principleId, "{ not valid json ");
    seedApproval("apr-r1-broken", "art-r1-broken");

    const model = new ApprovalsGroupedConsoleModel(tmpDir);
    const result = await model.getApprovalsGrouped("openclaw");
    const group = result.groups.find((g) => g.records.some((r) => r.artifactId === "art-r1-broken"));
    expect(group).toBeDefined();
    expect(group?.candidateDescription).toBeUndefined();
  });

  it("动态原文中的真实 U+FFFD（数据自带，非源码注入）必须逐字保留，不得“修复”", async () => {
    const principleId = "55555555-5555-4555-8555-555555555555";
    // 模拟存量数据本身损坏（SPEC R1：原文逐字保留，只提示，不修数据）
    const damagedStatement = "损坏数据 \uFFFD 原样保留";
    seedArtifact("art-r1-damaged-data", principleId, JSON.stringify({
      principleId,
      principleDraft: { title: "t", statement: damagedStatement, rationale: "r" },
    }));
    seedApproval("apr-r1-damaged-data", "art-r1-damaged-data");

    const model = new ApprovalsGroupedConsoleModel(tmpDir);
    const result = await model.getApprovalsGrouped("openclaw");
    const group = result.groups.find((g) => g.records.some((r) => r.artifactId === "art-r1-damaged-data"));
    expect(group?.candidateDescription).toContain(damagedStatement);
  });
});

describe("审查卡可批准性 — 存量身份与结构化阻断", () => {
  it("历史 scribe 工件没有 identity 列，但候选血缘能解析到账本原则：不得标为不可批准", async () => {
    const candidateId = crypto.randomUUID();
    const principleId = crypto.randomUUID();
    const artifactId = `pi-art-scribe-${candidateId}-prompt-run_scribe-${candidateId}-prompt_1`;
    seedLegacyLineage(artifactId, candidateId, principleId);
    seedApproval(`apr_prompt_${artifactId}`, artifactId);

    const model = new ApprovalsGroupedConsoleModel(tmpDir);
    const result = await model.getApprovalsGrouped("openclaw");
    const group = result.groups.find((g) => g.principleId === principleId);
    expect(group).toBeDefined();
    expect(group?.approveBlock).toBeUndefined();
  });

  it("identity 列指向账本外的旧 id：呈现为 identity_unresolved，而不是让 Owner 点一个必然失败的批准", async () => {
    const staleId = crypto.randomUUID();
    seedArtifact("art-stale-identity", staleId, JSON.stringify({
      principleDraft: { title: "stale", statement: "A statement whose ledger entry is gone.", rationale: "r" },
    }));
    seedApproval("apr-stale-identity", "art-stale-identity");

    const model = new ApprovalsGroupedConsoleModel(tmpDir);
    const result = await model.getApprovalsGrouped("openclaw");
    const group = result.groups.find((g) => g.records.some((r) => r.artifactId === "art-stale-identity"));
    expect(group).toBeDefined();
    expect(group?.approveBlock?.code).toBe("identity_unresolved");
    expect(group?.approveBlock?.nextAction).toContain("identity");
  });
});
