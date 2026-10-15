/**
 * SPEC-PD-CONSOLE-READABILITY-002 切片 1 — R1 静态乱码修复（模型层）。
 *
 * TDD：先于实现编写。走真实生产路径 ApprovalsGroupedConsoleModel.getApprovalsGrouped()
 * （真实 SQLite workspace + 真实提取链），不以仅搜索源码替代验证。
 *
 * 证据边界（SPEC E11 / AC-R1）：
 * - scribe（principleDraft.title+statement）是生产可达分支（runtime-v2 scribe
 *   写入该形状）——按生产路径验证；
 * - rule（implementationCode 注释提取）未发现生产写入方——此处为提取函数级
 *   验证 + 向后兼容，不冒称当前生产数据路径；
 * - 动态数据疑似损坏原文必须逐字保留：本测试同时锁死「输出不改写真实值」。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteConnection } from "@principles/core/runtime-v2";
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
