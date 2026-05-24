# 指令一：Linear 工单与路线图完全对齐任务

> **任务类型**：Linear 工单管理（不涉及代码修改）
> **执行者**：有 Linear MCP 工具访问权限的 AI 助手
> **预计时间**：60-90 分钟
> **目标**：让 Linear 里的所有 Backlog 工单与 `docs/plans/2026-05-roadmap/` 路线图完全对齐

> **2026-05-23 已取代**：此原始同步指令仍包含 `IdleTrigger` 建设方向，在 ADR-0012 之后不再有效。当前 Linear 同步以 [`03-linear-sync-plan.md`](./03-linear-sync-plan.md) 的 Runtime V2-only retirement 顺序为准。

---

## 你需要读的文档（按顺序）

在开始任何 Linear 操作前，先完整读取以下文件：

```
1. docs/plans/2026-05-roadmap/README.md              ← 总览，理解全局
2. docs/plans/2026-05-roadmap/01-current-state.md    ← 了解哪些已完成、哪些待做
3. docs/plans/2026-05-roadmap/02-roadmap.md          ← 阶段划分和依赖关系
4. docs/plans/2026-05-roadmap/03-linear-sync-plan.md ← 操作清单（主要参考）
5. docs/plans/2026-05-roadmap/issues/README.md       ← 工单描述文件索引
```

读完后，你应该能回答：
- 哪 1 个工单需要取消？
- 哪些工单需要更新描述？
- 哪些工单已经通过 MCP 更新过（需要验证）？
- 哪些新工单需要创建（分批次）？

---

## 操作清单

### 批次 A：立即执行（必须完成）

#### A-1：取消 PRI-170

**操作**：将 PRI-170 状态改为 `Canceled`，并在 comment 中写明原因。

**Comment 内容**：
```
Superseded by PRI-113 (shipped).

Audit on 2026-05-18 confirmed that `golden-trace.ts` already exports
GoldenTraceCaseSchema, GoldenTraceSchema, validateGoldenTraceCase,
validateGoldenTrace, createSyntheticRuleHostInput, createGoldenTraceFixture,
and all related types. Tests exist at `runtime-v2/__tests__/golden-trace.test.ts`.

The `contracts/` directory described in this issue does not exist and does not
match the codebase convention. Closing as no-op. See PRI-113.
```

---

#### A-2：更新 PRI-171 描述

**操作**：用 `docs/plans/2026-05-roadmap/issues/PRI-171-full-trace-context.md` 的内容**替换**整个描述。

从文件中 `## Goal` 开始到文件末尾，全部复制为新描述。

同时确认：
- Priority 保持 Urgent
- 设置 Project 为 `Project P: PD Product & Runtime`（当前未设）

---

#### A-3：更新 PRI-172 描述 + 标题

**操作**：
1. 将标题改为：`[Core] Refiner-aware Sandbox Wrapper for PrincipleCompiler`
2. 用 `docs/plans/2026-05-roadmap/issues/PRI-172-sandbox-evaluator.md` 的内容**替换**整个描述

从文件中 `## ⚠️ Required RFC Decision` 开始到文件末尾，全部复制为新描述。

同时确认：
- Priority 保持 Urgent
- 设置 Project 为 `Project P: PD Product & Runtime`（当前未设）

---

#### A-4：更新 PRI-173 描述

**操作**：用 `docs/plans/2026-05-roadmap/issues/PRI-173-compiler-refiner-loop.md` 的内容**替换**整个描述。

从文件中 `## Goal` 开始到文件末尾，全部复制为新描述。

同时确认：
- Priority 保持 High
- 设置 Project 为 `Project P: PD Product & Runtime`（当前未设）

---

#### A-5：更新 PRI-147 描述

**操作**：在现有描述**末尾追加**（不要删除原有的中文设计决策块）。

追加内容来自 `docs/plans/2026-05-roadmap/issues/PRI-147-approvals-ui.md`，从 `## Pre-Implementation Check` 开始到文件末尾。

---

#### A-6：验证已更新工单（PRI-146 / PRI-148 / PRI-174）

查询这 3 个工单的当前描述，确认是否包含以下段落：
- `## Pre-Implementation Check`
- `## Architecture Guardrails`
- `## Allowed Files`
- `## Forbidden`
- `## Verification`

**如果 PRI-146 缺少上述段落**：用以下内容替换描述（从 `## Goal` 开始）：

```markdown
## Goal

Implement `RuleHostWriter` — the activation channel writer for `code_tool_hook`. Activation must be gated by **Offline Replay testing** against historical trajectory logs (Shadow Mode). Code never goes live without proving it would not have caused false positives on past runs.

## Context

This is the highest-risk activation channel. The "Shadow Mode" concept was redefined in `INTERNALIZATION_PIPELINE.md` §9.2 to mean **Offline Replay testing**, not bypass-execution.

## Pre-Implementation Check

Before writing code, confirm what already exists:

* `packages/principles-core/src/runtime-v2/golden-trace.ts` — GoldenTrace types + validators (PRI-113, shipped)
* `packages/principles-core/src/runtime-v2/golden-trace-replay-validator.ts` — `replayGoldenTrace()` (PRI-115, shipped)
* `packages/principles-core/src/runtime-v2/golden-trace-replay-adapter.ts` — sandbox loader (keeps node:vm out of core)
* `packages/principles-core/src/runtime-v2/activation/activation-dispatcher.ts` — dispatcher (PRI-144, shipped)
* `packages/principles-core/src/runtime-v2/activation/sqlite-activation-state-store.ts` — state persistence (PRI-145, shipped)

**This issue does NOT need to re-create any of the above. It composes them.**

## Must Read First

* `docs/architecture/ACTIVATION_CHANNELS.md` §3.4
* `docs/architecture/INTERNALIZATION_PIPELINE.md` §9.2 (Shadow Mode = Offline Replay, NOT bypass)
* `docs/adr/0004-l2-auto-correction-and-replay.md`
* `docs/adr/0006-hybrid-activation-mechanism.md` §3.4

## Architecture Guardrails

* `RuleHostWriter` lives in `@principles/core/runtime-v2/activation/writers/`
* Must NOT import `node:vm` directly — use the adapter pattern from PRI-115
* `mode = require_approval` is hardcoded. Config cannot downgrade this channel to `auto`
* Shadow Mode is NOT bypass-execution. The rule never runs against live tool calls during shadow period
* Forbidden patterns check must run before any sandbox load

## Allowed Files

New:
* `packages/principles-core/src/runtime-v2/activation/writers/rule-host-writer.ts`
* `packages/principles-core/src/runtime-v2/activation/writers/shadow-mode-evaluator.ts`
* `packages/principles-core/src/runtime-v2/activation/writers/__tests__/rule-host-writer.test.ts`
* `packages/principles-core/src/runtime-v2/activation/writers/__tests__/shadow-mode-evaluator.test.ts`
* `packages/principles-core/src/runtime-v2/activation/writers/index.ts`

Modify:
* `packages/principles-core/src/runtime-v2/activation/activation-dispatcher.ts`
* `packages/principles-core/src/runtime-v2/activation/index.ts`
* `packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts`

## Forbidden

* Do NOT implement bypass mode ("log only" shadow)
* Do NOT register rules with host's `before_tool_call` hook (that's PRI-174)
* Do NOT bypass `forbiddenPatternCheck`
* Do NOT skip `canActivate` step
* Do NOT use `setInterval` inside core

## Scope

1. `canActivate(artifact)`: forbidden patterns check + GoldenTrace replay
2. `activate(artifact, context)`: atomic write to `.principles/implementations/code/{implId}/` + Ledger update + telemetry
3. `ShadowModeEvaluator.evaluateShadowDay(implId)`: pure function, called externally
4. `deactivate(activationId)`: rollback
5. Tests: at least 8 cases

## Verification

* `pnpm test packages/principles-core` passes
* `pnpm run typecheck` passes
* `architecture-regression.test.ts` passes with new assertion: `rule-host-writer.ts` does not contain `node:vm`
* E2E: dispatch artifact with `channel=code_tool_hook` → goes to ApprovalQueue (NOT direct activation)

## Out of Scope

* Host-side `before_tool_call` hook (PRI-174)
* Compiler refiner loop (PRI-173)
* Full trace context assembly (PRI-171)

## Related

* PRI-113, PRI-115, PRI-144, PRI-145, PRI-114 (all shipped, dependencies)
* PRI-172 (Sandbox Wrapper, sibling)
* PRI-173 (Compiler Refiner Loop, sibling)
* PRI-174 (Host applies propose_correction, sibling)
```

**如果 PRI-148 缺少上述段落**：参考 `docs/plans/2026-05-roadmap/issues/` 目录（PRI-148 的完整描述已在之前 MCP 调用中更新，如果 Linear 上已有完整内容则跳过）。

**如果 PRI-174 缺少上述段落**：同上（已在之前 MCP 调用中更新）。

---

#### A-7：验证已建工单（PRI-182 / PRI-183 / PRI-184）

查询这 3 个工单是否存在：

| 工单 | 标题 | 如果不存在 |
|------|------|-----------|
| PRI-182 | [Docs] Architecture document-vs-code drift audit + IdleTrigger location resolution | 用 `issues/` 目录中对应文件创建 |
| PRI-183 | [Docs] PRUNING_PIPELINE.md — formalize the pruning design referenced by overview | 同上 |
| PRI-184 | [Tests] Architecture regression — add invariant-numbered guards for AC-* / BALM-* / GAP-* / SCHED-* | 同上 |

如需创建：Project = `Project P: PD Product & Runtime`，Team = `Principles_disciple`。

---

### 批次 B：优先级和项目归属修正

以下工单需要确认/修正 Priority 和 Project 归属，不需要改描述：

| 工单 | 当前 Priority | 应该是 | 当前 Project | 应该是 |
|------|-------------|--------|------------|--------|
| PRI-171 | Urgent | Urgent（保持）| 未设 | Project P |
| PRI-172 | Urgent | Urgent（保持）| 未设 | Project P |
| PRI-173 | High | High（保持）| 未设 | Project P |
| PRI-174 | Urgent | Urgent（保持）| 未设（已设）| Project P |
| PRI-155 | High | High（保持）| Project P（已设）| 保持 |
| PRI-154 | High | High（保持）| Project P（已设）| 保持 |
| PRI-162 | High | High（保持）| Project P（已设）| 保持 |

---

### 批次 C：确认 Phase 1B 工单状态

以下工单应该在 Backlog 且描述准确，逐一查询确认状态：

| 工单 | 预期状态 | 如果不在 Backlog |
|------|---------|----------------|
| PRI-118 | Backlog | 报告异常 |
| PRI-119 | Backlog | 报告异常 |
| PRI-120 | Backlog | 报告异常 |
| PRI-121 | Backlog | 报告异常 |
| PRI-131 | Backlog | 报告异常 |
| PRI-149 | Backlog | 报告异常 |
| PRI-150 | Backlog | 报告异常 |

---

### 批次 D：不需要操作的工单（确认即可）

以下工单**不需要任何修改**，只需确认它们存在且状态正常：

- PRI-32, 33, 34, 35, 36（模板工单，保持 Backlog）
- PRI-158, 159, 160, 161, 165（Project S，不动）
- PRI-175, 176, 177, 178, 179, 180, 181（Host 改造类，保持 Backlog）

---

### 批次 E：Phase 2 / Phase 3 工单（暂不创建）

以下工单**现在不创建**，等 Phase 1A 完成后再建：

- BALM 5 个工单（`issues/NEW-balm-*.md`）
- LRAS 3 个工单（`issues/NEW-lras-*.md`）
- GAP + Scheduler 5 个工单（`issues/NEW-gap-*.md`, `issues/NEW-sched-*.md`）
- Phase 3 4 个工单（`issues/NEW-phase3-*.md`）

---

## 完成后输出报告

完成所有操作后，输出以下格式的报告：

```
## Linear 对齐报告 — {{日期}}

### 批次 A：立即执行

| 操作 | 工单 | 结果 | 备注 |
|------|------|------|------|
| Cancel | PRI-170 | ✅/❌ | |
| Update 描述 | PRI-171 | ✅/❌ | |
| Update 描述+标题 | PRI-172 | ✅/❌ | |
| Update 描述 | PRI-173 | ✅/❌ | |
| Append 描述 | PRI-147 | ✅/❌ | |
| Verify 描述完整 | PRI-146 | ✅/❌ | 缺少段落：X |
| Verify 描述完整 | PRI-148 | ✅/❌ | |
| Verify 描述完整 | PRI-174 | ✅/❌ | |
| Verify 存在 | PRI-182 | ✅/❌ | 已存在/已创建 |
| Verify 存在 | PRI-183 | ✅/❌ | |
| Verify 存在 | PRI-184 | ✅/❌ | |

### 批次 B：优先级/项目归属

| 工单 | 操作 | 结果 |
|------|------|------|
| PRI-171 | 设置 Project P | ✅/❌ |
| PRI-172 | 设置 Project P | ✅/❌ |
| PRI-173 | 设置 Project P | ✅/❌ |

### 批次 C：Phase 1B 工单状态

| 工单 | 状态 | 正常/异常 |
|------|------|---------|
| PRI-118 | Backlog | ✅ |
| ... | | |

### 失败项（如有）

| 工单 | 操作 | 失败原因 | 建议处理 |
|------|------|---------|---------|

### 总结

- 成功操作：X 项
- 失败操作：X 项
- 需要人工处理：X 项
```

---

## 注意事项

1. **每次 MCP 调用之间等待 2-3 秒**，避免速率限制导致失败
2. **如果某个操作失败，记录失败原因，继续下一个**，不要卡住
3. **不要创建 Phase 2 / Phase 3 的新工单**（批次 E 明确说暂不创建）
4. **不要修改任何代码文件**，这是纯 Linear 管理任务
5. **不要修改 Project S（Symphony）的工单**
6. **描述内容来源**：所有工单描述都来自 `docs/plans/2026-05-roadmap/issues/` 目录，不要自己编写
7. **如果 Linear 返回"工单不存在"**，先用 `list_issues` 搜索确认工单号是否正确
