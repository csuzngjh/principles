# Phase 13: Replay Evaluation and Manual Promotion Loop - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-07
**Phase:** 13-replay-evaluation-and-manual-promotion-loop
**Areas discussed:** Sample selection, Evaluation report format, Promotion flow, State transitions, Rollback safety

---

## Sample Selection

| Option | Description | Selected |
|--------|-------------|----------|
| 混合模式（推荐） | 复用 nocturnal-dataset 并增加 pain-negative/success-positive/principle-anchor 分类标签 | ✓ |
| 复用 nocturnal-dataset | 复用 NocturnalDatasetRecord，按 reviewStatus 筛选 | |
| 新建独立样本库 | 为 code implementation 重放单独创建样本存储 | |

**User's choice:** 混合模式（推荐）
**Notes:** Add `classification` field to distinguish pain-negative/success-positive/principle-anchor categories.

## Evaluation Report Format

| Option | Description | Selected |
|--------|-------------|----------|
| 结构化 JSON（推荐） | JSON 报告，包含 pass/fail + 各项约束指标明细，可被后续自动化消费 | ✓ |
| 简单 pass/fail | 只有通过/不通过结果 | |
| JSON + 摘要 | JSON 报告 + 人类可读摘要双输出 | |

**User's choice:** 结构化 JSON（推荐）
**Notes:** Similar to PromotionGateResult shape: overallDecision, replayResults grouped by classification, blockers array.

## Promotion Flow

| Option | Description | Selected |
|--------|-------------|----------|
| CLI + 自然语言 | CLI 命令 + 自然语言双重入口 | ✓ |
| CLI 命令（推荐） | CLI 命令如 /pd-promote-impl, /pd-disable-impl, /pd-rollback-impl | |
| API + 手动调用 | 暴露 API 函数，通过代码手动调用 | |

**User's choice:** CLI + 自然语言
**Notes:** Follow existing /pd-rollback pattern with natural language support via prompt hook.

## State Transitions

| Option | Description | Selected |
|--------|-------------|----------|
| 标准四态（推荐） | candidate → active → disabled → archived，全部手动转换 | ✓ |
| 对齐 promotion-gate | rejected → candidate_only → shadow_ready → promotable | |
| 最小三态 | pending → active → archived | |

**User's choice:** 标准四态（推荐）
**Notes:** All state transitions manual. Rollback auto-disables current and restores previous active.

## Rollback Safety

| Option | Description | Selected |
|--------|-------------|----------|
| 回滚到前一版本 | 回滚后立即标记为 disabled，恢复前一个 active 实现 | ✓ |
| 停用当前，不自动恢复 | 回滚后停用当前，不自动启用其他实现 | |
| 仅标记，不改状态 | 回滚只打标签和记录，不修改实现状态 | |

**User's choice:** 回滚到前一版本
**Notes:** If no previous active exists, rule reverts to no active code impl (hard-boundary gates still work per Phase 12 D-08).

## Claude's Discretion

Areas left to Claude: exact CLI command naming/output format, replay execution engine timing, statistically meaningful replay sample count.

## Deferred Ideas

- Shadow rollout for code implementations — later milestone
- Automated promotion — once replay metrics are stable
- Statistical significance analysis for sample selection
- Multi-implementation A/B comparison via replay

---

*Captured via interactive discussion: 2026-04-07*
