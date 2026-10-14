---
name: pd-record-pain
description: Record an explicit Owner pain statement from the current Codex session — the user's own words, verbatim, as the input basis for a PD behavior diagnosis. Use when the Owner wants to report that something the agent did was wrong, painful, or should be remembered and changed, even when no tool failed.
---

# PD 记录痛苦（Owner 明确反馈入口）

把 Owner 在**当前消息**里明确提交的行为反馈原样交给 Principles Disciple：一条痛苦信号会被持久登记，后台自动诊断，产出可在 Owner 审阅入口查看的候选原则。不需要打开终端，不需要手抄会话 ID。

## Owner 怎么用（唯一入口）

在 Codex 对话框直接发送一条以固定前缀开头的消息：

```
PD记录痛苦：<反馈原文>
```

例如：

```
PD记录痛苦：改公共接口之前必须先核对所有调用方，这次直接改导致下游崩了
```

规则：

- 前缀必须是消息开头、精确的 `PD记录痛苦：`（全角冒号）；冒号后是要记录的原文。
- 反馈原文非空且不超过 500 字；超长会被拒绝（不会被截断），请精简后重发。
- 只记录冒号后这一段文本——引用、工具输出、模型转述都不会触发，也不会被采集。
- 同一条消息重复提交（或 Hook 重放）只产生同一条信号，不会重复。
- 提交后会收到含 `painId` 与 `taskId` 的回执；后台诊断由 PD 工作进程自动继续，之后可在 Owner 审阅入口（`$pd-review`）查看结果或补证/拒绝。

## 语义边界（代理须知）

- 该文本作为 **Owner 陈述**（`owner_statement`）进入诊断材料：未经独立验证、原样保存、来源标注为"Codex 显式前缀提交"。它满足"输入依据存在"这一准入条件，但不降低置信度、复用、类型与 Owner 审批等其他门禁。
- AI 不得代替 Owner 编造或改写陈述；只有 Owner 明确授权转交原文时才可使用。
- 回执只代表"已登记 + 已入队"：请如实转述回执内容，不要声称诊断已完成，也不要虚构结论。
- 若回执标注"会话证据提升暂不可用"（例如会话摄取未开启），诊断仍会基于该陈述进行，无需重新提交。

## 备用入口（终端，用于恢复/补交）

```
pd pain record --reason <摘要> [--owner-statement <Owner 原话>] --host codex --session <rootSessionId> --rollout-id <rolloutId> --host-turn-id <turnId> -w <workspace>
```

`--owner-statement` 与上面的前缀语义相同（500 字上限、拒绝而非截断）；Codex lineage 三元组保持强制，不会为补证据而放宽。
