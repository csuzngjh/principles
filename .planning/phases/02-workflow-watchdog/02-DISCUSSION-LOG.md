# Phase 02: YAML 工作流漏斗框架 - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-19
**Phase:** 02-yaml
**Areas discussed:** WORKFLOW_FUNNELS 数据来源, workflows.yaml 维护方式, 新 Event 类型定义位置

---

## WORKFLOW_FUNNELS 数据来源

| Option | Description | Selected |
|--------|-------------|----------|
| 方案A: workflows.yaml 动态加载 | YAML 是真相来源，启动时解析加载到内存 WORKFLOW_FUNNELS | ✓ |
| 方案B: TypeScript 硬编码 | WORKFLOW_FUNNELS 在代码里硬编码，YAML 仅作参考 | |

**User's choice:** 方案A — YAML 动态加载，YAML 是真相来源
**Notes:** 与 Phase 1 设计意图一致，新增工作流只需改 YAML

---

## workflows.yaml 维护方式

| Option | Description | Selected |
|--------|-------------|----------|
| 方案A: 开发者手动维护 | 新增 event 类型时，开发者直接在 YAML 中注册 stage | ✓ |
| 方案B: 代码自动注册 | 代码有新 event 类型时自动注册到 workflows.yaml | |

**User's choice:** 方案A — 开发者手动维护
**Notes:** 完全控制，可版本化和 review，不会产生未预期的漏斗

---

## 新 Event 类型定义位置

| Option | Description | Selected |
|--------|-------------|----------|
| 方案A: 内联到 event-types.ts | Nocturnal + RuleHost 6 个新 EventData 类型全部内联到 event-types.ts | ✓ |
| 方案B: 拆到独立文件 | 新建 nocturnal-types.ts + rulehost-types.ts | |

**User's choice:** 方案A — 内联到 event-types.ts
**Notes:** 与现有模式一致，保持类型一目了然

---

## Claude's Discretion

无 — 所有决策均由用户明确选择。

## Deferred Ideas

无。

