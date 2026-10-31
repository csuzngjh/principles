/**
 * SPEC-PD-CONSOLE-READABILITY-002 切片 1 — 安全阅读修复（源契约 + i18n）。
 *
 * TDD：先于实现编写。覆盖：
 * - R4/R5：审批数量标签不得称为行为证据（evidenceSummary → 审批记录口径）；
 * - R6：旧「编辑」称谓改为「替换待审版本」（focus + principle detail 双侧）；
 * - R2/R3：Focus 卡与原则详情页标题/正文分层（splitReadingTitleBody），
 *   正文容器 whitespace-pre-wrap；
 * - R7：Principles 列表「形成依据」不再粘贴候选描述冒充独立证据；
 * - R4：OwnerDecisionCard 原始检查码渐进披露（details 折叠）；
 * - R1：模型源码字符串字面量不再含 U+FFFD（含 note 字符串；模型行为另由
 *   tests/models/approvals-grouped-console-model.test.ts 以生产路径验证）。
 *
 * 本文件沿用本仓 tests/ui 的源码契约风格（readFileSync + 断言），不引入 DOM 渲染。
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as nodePath from "node:path";

function readSource(relative: string): string {
  return fs.readFileSync(nodePath.join(__dirname, relative), "utf-8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getOwnRecord(obj: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  return Object.hasOwn(obj, key) && isRecord(obj[key]) ? obj[key] : undefined;
}

function getOwnString(obj: Record<string, unknown>, key: string): string | undefined {
  return Object.hasOwn(obj, key) && typeof obj[key] === "string" ? (obj[key] as string) : undefined;
}

function loadLocale(file: string): {
  focus: Record<string, unknown>;
  ownerDecision: Record<string, unknown>;
  principlesDetail: Record<string, unknown>;
} {
  const root: unknown = JSON.parse(fs.readFileSync(nodePath.join(__dirname, "../../src/ui/i18n", file), "utf-8"));
  if (!isRecord(root)) throw new Error(`Expected JSON object: ${file}`);
  const pages = getOwnRecord(root, "pages");
  const focus = pages ? getOwnRecord(pages, "focus") ?? {} : {};
  const ownerDecision = getOwnRecord(focus, "ownerDecision") ?? {};
  const principles = pages ? getOwnRecord(pages, "principles") ?? {} : {};
  const principlesDetail = getOwnRecord(principles, "detail") ?? {};
  return { focus, ownerDecision, principlesDetail };
}

const en = loadLocale("en.json");
const zh = loadLocale("zh-CN.json");

// ── R5：审批数量标签口径 ────────────────────────────────────────────────────

describe("切片1 R5 — 审批记录数不得称为行为证据", () => {
  it("zh evidenceSummary 称「审批记录」且不称「证据」", () => {
    const value = getOwnString(zh.focus, "evidenceSummary");
    expect(value).toBeDefined();
    expect(value).toContain("审批记录");
    expect(value).not.toContain("证据");
    expect((value ?? "").match(/\{\{count\}\}/g)).toHaveLength(1);
  });

  it("en evidenceSummary 称「Approval records」且不称「Evidence」", () => {
    const value = getOwnString(en.focus, "evidenceSummary");
    expect(value).toBeDefined();
    expect(value).toContain("Approval records");
    expect(value).not.toContain("Evidence");
    expect((value ?? "").match(/\{\{count\}\}/g)).toHaveLength(1);
  });

  it("单对象工作台按事项计数，不把审批数量冒充行为证据", () => {
    const src = readSource("../../src/ui/pages/focus/FocusPage.tsx");
    const workbench = readSource("../../src/ui/pages/focus/OwnerWorkbench.tsx");
    expect(src).toContain("pendingGroups.flatMap");
    expect(src).toContain("group.records.filter(record => record.status === 'pending')");
    expect(src).toContain("count: workItems.length");
    expect(workbench).toContain("count: items.length");
    for (const locale of [en, zh]) {
      const workbenchCopy = getOwnRecord(locale.focus, "workbench");
      const count = workbenchCopy && getOwnString(workbenchCopy, "count");
      expect(count).toContain("{{count}}");
      expect(count).not.toMatch(/evidence|证据/i);
    }
  });
});

// ── R6：操作名称（旧「编辑」→「替换待审版本」） ─────────────────────────────

describe("切片1 R6 — 「编辑」称谓改为「替换待审版本」", () => {
  const editKeys = ["editAction", "confirmEdit", "editReasonLabel", "editSucceeded", "editFailed"] as const;

  it("zh focus 编辑族 key 不再出现「编辑」称谓且动作名为「替换待审版本」", () => {
    expect(getOwnString(zh.focus, "editAction")).toBe("替换待审版本");
    expect(getOwnString(zh.focus, "confirmEdit")).toBe("确认替换");
    for (const key of editKeys) {
      const value = getOwnString(zh.focus, key);
      expect(value, `zh.pages.focus.${key}`).toBeDefined();
      expect(value, `zh.pages.focus.${key} 不得再称「编辑」`).not.toContain("编辑");
    }
  });

  it("en focus 编辑族 key 改为 replacement 语义", () => {
    expect(getOwnString(en.focus, "editAction")).toBe("Replace pending version");
    expect(getOwnString(en.focus, "confirmEdit")).toBe("Confirm replacement");
    for (const key of editKeys) {
      const value = getOwnString(en.focus, key);
      expect(value, `en.pages.focus.${key}`).toBeDefined();
      expect(value, `en.pages.focus.${key} 不得再称 Edit`).not.toMatch(/\bEdit\b/);
    }
  });

  it("zh/en principle detail 编辑族 key 同步替换语义", () => {
    expect(getOwnString(zh.principlesDetail, "editAction")).toBe("替换待审版本");
    expect(getOwnString(en.principlesDetail, "editAction")).toBe("Replace pending version");
    for (const key of ["confirmEdit", "editReasonLabel", "editSucceeded", "editFailed"] as const) {
      expect(getOwnString(zh.principlesDetail, key), `zh.detail.${key}`).not.toContain("编辑");
      expect(getOwnString(en.principlesDetail, key), `en.detail.${key}`).not.toMatch(/\bEdit\b/);
    }
  });

  it("FocusPage 源码 defaultValue 不再内嵌「编辑」措辞", () => {
    const src = readSource("../../src/ui/pages/focus/FocusPage.tsx");
    expect(src).not.toContain('defaultValue: "编辑"');
    expect(src).not.toContain("编辑完成");
    expect(src).not.toContain("已保存修订");
    // defaultValue 回退文案与 i18n 主文案保持同语义（fallback 不得复活旧称谓）
    const editFallbacks = src.match(/defaultValue: "[^"]*编辑[^"]*"/g) ?? [];
    expect(editFallbacks, `fallback 不得再含「编辑」：${editFallbacks.join(", ")}`).toHaveLength(0);
  });

  it("artifactUnavailableNote 指引用「替换待审版本」入口", () => {
    const zhValue = getOwnString(zh.focus, "artifactUnavailableNote");
    expect(zhValue).toContain("替换待审版本");
    expect(zhValue).not.toContain("「编辑」");
    const enValue = getOwnString(en.focus, "artifactUnavailableNote");
    expect(enValue).not.toMatch(/\bedit section\b/i);
  });

  it("unlinkedCandidateNote 引导按「审批记录」判断（与重命名后的标签一致）", () => {
    const zhValue = getOwnString(zh.focus, "unlinkedCandidateNote");
    expect(zhValue).toContain("审批记录");
    expect(zhValue).not.toContain("证据摘要");
    const enValue = getOwnString(en.focus, "unlinkedCandidateNote");
    expect(enValue).not.toMatch(/evidence summary/i);
  });
});

// ── R2/R3：标题/正文分层与换行保留 ─────────────────────────────────────────

describe("切片1 R2/R3 — 标题/正文分层与换行保留", () => {
  it("FocusPage 使用 splitReadingTitleBody 分层", () => {
    const src = readSource("../../src/ui/pages/focus/FocusPage.tsx");
    expect(src).toContain("splitReadingTitleBody");
  });

  it("Focus 接入的准确全文容器保留换行与长词换行，并区分预览和全文", () => {
    expect(readSource("../../src/ui/pages/focus/FocusPage.tsx")).toContain("<ApprovalSubjectReading");
    const src = readSource("../../src/ui/pages/focus/ApprovalSubjectReading.tsx");
    const fullBody = src.match(/<div className="[^"]*">\{bodyText\}<\/div>/);
    expect(fullBody).toBeTruthy();
    expect(fullBody?.[0]).toContain("whitespace-pre-wrap");
    expect(fullBody?.[0]).toMatch(/break-words|overflow-wrap/);
    expect(src).toContain("pages.focus.workbench.fullText");
    expect(src).toContain("pages.focus.workbench.textPreview");
  });

  it("PrincipleDetailPage h1 不再直接承载整段规则正文（经分层取短标题）", () => {
    const src = readSource("../../src/ui/pages/principles/PrincipleDetailPage.tsx");
    expect(src).toContain("splitReadingTitleBody");
    const h1Match = src.match(/<h1[^>]*>\s*\{[^}]*\}\s*<\/h1>/);
    expect(h1Match).toBeDefined();
    expect(h1Match?.[0]).not.toContain("learnedPrinciple.value.text");
    expect(h1Match?.[0]).not.toContain("principle.text");
  });

  it("PrincipleDetailPage 学到的行为准则正文块保留换行（whitespace-pre-wrap）", () => {
    const src = readSource("../../src/ui/pages/principles/PrincipleDetailPage.tsx");
    const idx = src.indexOf("owner-decision-learned");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 900);
    expect(block).toContain("{learnedText}");
    expect(block).toContain("whitespace-pre-wrap");
  });

  it("正文/标题预览按码点截断，不使用 UTF-16 slice（避免孤立代理项显示为替换字符）", () => {
    const detail = readSource("../../src/ui/pages/principles/PrincipleDetailPage.tsx");
    expect(detail).toContain("truncateByCodePoints(learnedText, 240)");
    expect(detail).not.toContain("learnedText.slice(0, 240)");

    const reading = readSource("../../src/ui/pages/focus/ApprovalSubjectReading.tsx");
    expect(reading).toContain("truncateByCodePoints(bodyText, 240)");
    expect(reading).not.toContain("bodyText.slice(0, 240)");

    const list = readSource("../../src/ui/pages/principles/PrinciplesPage.tsx");
    expect(list).toContain("truncateByCodePoints(p.text, 80)");
    expect(list).not.toContain("p.text.slice(0, 80)");
  });
});

// ── R7：去重 ────────────────────────────────────────────────────────────────

describe("切片1 R7 — 去除重复展示", () => {
  it("Principles 列表「形成依据」不再粘贴候选描述（ag?.candidateDescription）", () => {
    const src = readSource("../../src/ui/pages/principles/PrinciplesPage.tsx");
    expect(src).not.toContain("ag?.candidateDescription");
    expect(src).toContain('t("principles.blockBasisFallback")');
  });

  it("PrincipleDetailPage 规则全文在页面内只渲染一次（known 路径正文只出现在 learned 块）", () => {
    const src = readSource("../../src/ui/pages/principles/PrincipleDetailPage.tsx");
    const occurrences = src.match(/ownerDecision\.learnedPrinciple\.value\.text/g) ?? [];
    // 分层后 h1 走 title，正文只在 learned 块出现一次
    expect(occurrences.length).toBe(1);
  });
});

// ── R4：检查码渐进披露 ──────────────────────────────────────────────────────

describe("切片1 R4 — OwnerDecisionCard 检查码渐进披露", () => {
  it("deterministicChecks 裸 chip 进入折叠 details，标签走 i18n（双语）", () => {
    const src = readSource("../../src/ui/pages/focus/OwnerDecisionCard.tsx");
    expect(src).toMatch(/<details[^>]*>/);
    const around = src.slice(src.indexOf("deterministicChecks") - 600, src.indexOf("deterministicChecks") + 600);
    expect(around).toContain("<details");
    expect(around).toContain("checksDisclosure");

    const zhLabel = getOwnString(zh.ownerDecision, "checksDisclosure");
    const enLabel = getOwnString(en.ownerDecision, "checksDisclosure");
    expect(typeof zhLabel).toBe("string");
    expect((zhLabel ?? "").length).toBeGreaterThan(2);
    expect(typeof enLabel).toBe("string");
    expect((enLabel ?? "").length).toBeGreaterThan(2);
  });
});

// ── R1：模型源码字符串字面量无 U+FFFD ─────────────────────────────────────

describe("切片1 R1 — 模型源码字符串字面量不再注入替换字符", () => {
  it("ApprovalsGroupedConsoleModel.ts 的字符串字面量（含 note）不含 U+FFFD", () => {
    const src = readSource("../../src/server/models/ApprovalsGroupedConsoleModel.ts");
    // 只检查代码字面量：注释不进 UI（历史注释乱码按 P3 不在本轮清理范围）。
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const templateLiterals = codeOnly.match(/`[^`]*`/g) ?? [];
    const quoted = codeOnly.match(/'[^']*'/g) ?? [];
    const doubleQuoted = codeOnly.match(/"[^"\n]*"/g) ?? [];
    expect(templateLiterals.length + quoted.length + doubleQuoted.length).toBeGreaterThan(5);
    for (const literal of [...templateLiterals, ...quoted, ...doubleQuoted]) {
      expect(literal.includes("\uFFFD"), `literal must not inject U+FFFD: ${literal.slice(0, 60)}`).toBe(false);
    }
  });
});
