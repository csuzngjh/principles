# 03 - Linear 同步计划：Phase 1B Runtime V2-only reset

> **更新日期**: 2026-05-23
> **原因**: ADR-0012 取消 OpenClaw idle/night scheduling 与 legacy parallel execution 的长期保留策略。

## 1. 已完成事实

以下工作已经合并，不应再次开同义实现任务：

| 能力 | 已完成 issues |
|------|---------------|
| L2 trace/refiner/sandbox/RuleHost 基础 | PRI-146、171、172、173、174、185、189-192 |
| Baseline/repair/chaos/live runtime stability | PRI-200、201、206-210、216-220、224、225 |
| Plugin inventory/anti-growth/first extraction | PRI-211、212、213、215 |
| CLI/read-model/lifecycle boundary slices | PRI-131、PRI-149 实际交付、PRI-198 |

## 2. 必须纠正的现有 issues

| Issue | 当前问题 | 同步动作 |
|------|----------|----------|
| PRI-149 Done | 标题声称删除 Nocturnal，但合并内容为 Tier 2 CLI boundary migration | 保持 Done；追加澄清评论，不将其视为 legacy 删除完成 |
| PRI-118 Backlog | 未提及 SourceTrace/FullTrace 已交付 | 更新为 remaining plugin trajectory I/O/evidence facade |
| PRI-119 Backlog | 过于保守，仍允许长期 legacy 并行 | 更新为 EvolutionWorker/Nocturnal live cutover |
| PRI-150 Backlog | bulk schema move 范围过大 | 更新为 inventory-first，小片迁移 |
| PRI-154 Backlog | 针对 legacy evolution JSONL | 更新为 Runtime V2 event visibility |
| PRI-162 Backlog | 描述可能令 core 读取 filesystem/env | 更新为 pure config contract + adapter-owned loading |
| PRI-183 Backlog | 文档已存在或已部分落地需先核查 | 改为文档对齐/验证任务 |
| PRI-184 Backlog | 旧描述偏向大规模占位测试 | 改为缺失 guard audit，优先退役/边界相关 invariants |
| PRI-175-181 Backlog | 围绕 legacy host/subagent/nocturnal workflow 扩建 | 取消或标记 superseded，必要能力重新归入 Runtime V2/SDK issue |

## 3. 新退役 issue 序列

| 顺序 | 标题 | 优先级 | 阻塞关系 | 执行者 |
|------|------|--------|----------|--------|
| 0 | Phase 1B reset: roadmap/ADR/Linear alignment | High | 无 | 本次 `PRI-226` |
| 1 | PD-owned runtime configuration and explicit scheduling SDK boundary | High | PRI-226 | 强 AI |
| 2 | Cut over EvolutionWorker and Nocturnal live execution to Runtime V2 | Urgent | 1，关联 PRI-119 | 强 AI |
| 3 | Isolate read-only historical Nocturnal artifact import/export | Medium | 2 | 强 AI 或严格限制的 Symphony |
| 4 | Delete Nocturnal execution modules, commands and obsolete compatibility surface | High | 2, 3 | 强 AI |
| 5 | Contract legacy tests and measure CI/runtime verification cost | Medium | 4 | Symphony 或强 AI |
| 6 | Replace plugin workspace discovery with PD configuration/SDK contract | High | 1，可与 2 并行 | 强 AI |

## 4. 价值闭环 issue

退役工作不替代产品价值工作：

| Issue | 状态动作 | 原因 |
|------|----------|------|
| PRI-148 RejectionFeedback Service | 提升为 Todo/High，尽快执行 | 关闭人工 reject -> 新学习循环缺口 |
| New: production rejection-to-feedback UAT | PRI-148 后创建/执行 | 证明真实价值闭环而非只验证结构 |

## 5. 禁止 dispatch 的描述

以下类型 issue 不应进入执行队列：

- 新增或完善 OpenClaw idle/night scheduling。
- 给 Nocturnal Trinity 新增行为、修复能力或新观察面，而非退役所需的最小修改。
- 把 host-specific workspace discovery 或文件/env loading 放进 `@principles/core`。
- 因历史文件存在而继续保留双轨执行。

## 6. Linear 评论标准

每个被修订或新建的 issue 必须写明：

- `Decision source`: ADR-0012。
- `Why now`: Runtime V2 已经通过 baseline/live/chaos 验证，双轨已从风险缓冲变为成本和故障来源。
- `Retirement rule`: caller cutover before deletion; historical reading read-only only.
- `Not allowed`: no new idle/night/nocturnal features, no broad unrelated refactor.


---

## 7. Phase 1C / 1D 新增工单（v2.0 — 2026-05-24 修订）

> **背景**: ADR-0013 (Attribution Pipeline) + 06-ahe-informed-architecture-review.md 引入 Phase 1C/1D 主线。下列 issue 必须在 Linear 上新建。

### 7.1 新建 issue 模板

#### PRI-232: Attribution Pipeline MVP

**Title**: Attribution Pipeline MVP — close the activation feedback loop with PRRR-driven verdict

**Priority**: Urgent (P1)

**Description**:

```markdown
## Context

ADR-0013 introduces the Attribution Pipeline as PD's missing fourth pipeline. Without it, the Decoupling Loop (R3 in PD_System_Dynamics_Model.md) is falsely closed: PD cannot tell whether an activated principle actually reduces same-category pain or whether it introduces new pain categories.

This issue delivers the MVP of the Attribution Pipeline. It is the highest-leverage work in Phase 1C.

## Goal

Implement the smallest end-to-end attribution loop that:

1. Detects window completion for each `active` (or `probation_active`) principle (default: 100 tool calls per principle, configurable per channel).
2. Computes `PRRR (Pain Recurrence Reduction Rate)` per pain category derived from the principle.
3. Emits `ActivationOutcomeAttribution` records with verdict ∈ { confirmed, uncertain, regressed }.
4. Wires `verdict=regressed` to `ActivationDispatcher.deactivate(reason='attribution_regressed')` (auto-archive, no human review needed for MVP).

## Out of scope (future issues)

- WorkspaceLearningSummary injection into Diagnostician prompts → PRI-233.
- Probation Window state machine → PRI-235.
- Auto-promotion on `verdict=confirmed` → keep manual; MVP only auto-archives `regressed`.
- Conflict detection (R5) → separate issue after MVP stabilizes.

## Required design constraints

- Attribution must be append-only and idempotent on `(principleId, windowId)`.
- Attribution must read trajectory through PRI-118's evidence facade (not direct trajectory storage).
- Attribution must skip `provenance=bundled` principles (PRI-234 supplies the field; before that ships, treat all as evolved with documented backfill plan).
- Architecture guards: ATTRIBUTION-1, ATTRIBUTION-2, ATTRIBUTION-3 from ADR-0013 §6.

## Acceptance criteria

1. New core module `runtime-v2/attribution/` with `AttributionWindowScheduler`, `ActivationOutcomeAttribution` schema, `AttributionVerdictDispatcher`, attribution store.
2. SQLite schema `activation_outcome_attributions` table with idempotent insert.
3. Architecture regression tests for ATTRIBUTION-1/2/3.
4. Synthetic baseline test: inject a fake regressing principle, run 100 synthetic tool calls, verify it gets auto-archived with verdict=regressed and a written rationale.
5. Production canary on at least 1 real workspace with at least 1 attribution verdict (any verdict kind).
6. PR body reports: verdict count, archive count, false-positive count (manual sample of 5 verdicts).

## Suitable executor

Strong AI (manual dispatch). High-risk core change; requires careful contract testing.

## Dependency

- PRI-118 trajectory I/O facade (must merge first or be developed in parallel with explicit handoff)
- ADR-0013 (already proposed in this PR cycle)

## Related ERR entries

- Apply ERR-001/005/007/009 (as bypasses validation) to the verdict schema parsing.
- Apply ERR-015/018/019 (stale loop state) to the window-tracking logic.
```

#### PRI-233: WorkspaceLearningSummary contract & Diagnostician memory injection

**Title**: WorkspaceLearningSummary — cross-session meta-experience for Diagnostician memory

**Priority**: High (P2)

**Description**:

```markdown
## Context

ADR-0013 introduces WorkspaceLearningSummary as PD's missing meta-experience stock. Today, Diagnostician runs from scratch on every pain signal, with no memory of past attribution verdicts. This causes rediscovery of same-category principles and degrades efficiency.

## Goal

Define and implement a read-only `WorkspaceLearningSummaryReadModel` that consolidates the most recent N (default 20) attribution verdicts and exposes them as a token-budgeted prompt fragment for injection into Diagnostician prompts.

## Required design constraints

- Pure read model. No writes from outside attribution pipeline.
- Token budget enforced at injection time (default ≤ 500 tokens, hard).
- LRU-truncated to most recent verdicts when over budget.
- Each summary entry must include: principleId hash, pain category, verdict kind, recurrence delta, key rationale phrase.
- LEARN-1, LEARN-2 architecture guards (ADR-0013 §6).

## Acceptance criteria

1. New `WorkspaceLearningSummaryReadModel` in core.
2. New `LearningSummaryPromptInjector` util used by `DiagnosticianPromptBuilder`.
3. Architecture regression tests for LEARN-1, LEARN-2.
4. Diagnostician prompt with summary injection passes existing baseline tests (no regression on synthetic baseline).
5. Diagnostician explicitly references summary in at least 1 synthetic eval case where past verdict contradicts current evidence.

## Dependency

PRI-232 (must produce verdicts before this can be exercised).

## Suitable executor

Strong AI; medium risk.
```

#### PRI-234: Bundled vs Evolved principle provenance

**Title**: Bundled vs Evolved provenance — separate PD project assets from per-workspace evolution

**Priority**: Medium (P2)

**Description**:

```markdown
## Context

PD ships with bundled principles, skills, and thinking models that are common across all workspaces. Today these are indistinguishable from per-workspace evolved principles, which contaminates attribution and pruning decisions.

## Goal

Add a `provenance: 'bundled' | 'evolved'` field to LedgerPrincipleEntry (and PIArtifact where relevant), tag all current bundled assets at install time, and ensure attribution + pruning pipelines skip bundled entries.

## Required design constraints

- Default for new entries: `evolved`.
- Backfill CLI: `pd ledger backfill-provenance --workspace <path> --json` (read-only by default; --confirm to apply).
- `provenance=bundled` entries are immune from auto-archive but still counted in context pressure.
- Architecture guard: BUNDLED-1 (ADR-0013 §6).
- L1 cap counts bundled and evolved separately (configurable).

## Acceptance criteria

1. Schema added with TypeBox validation.
2. Backfill CLI tested on synthetic workspace.
3. Architecture regression test BUNDLED-1.
4. Documentation: a list of all current PD-bundled principle/skill ids.

## Suitable executor

Symphony or strong AI; low complexity, schema + tagging exercise.
```

#### PRI-235: Activation Probation Window

**Title**: Activation Probation Window — bridge approval and full activation with attribution gate

**Priority**: High (P2)

**Description**:

```markdown
## Context

Today, an approved PIArtifact moves directly from `pending` to `active`. ADR-0013 introduces a Probation Window: approve → `probation_active` → (attribution verdict=confirmed) → `active` or → (verdict=regressed) → `archived`.

## Goal

Implement the `probation_active` ledger status, the state machine guards (STATE-1..STATE-4 from ADR-0013), and configurable window size (default: 50 tool calls for code_tool_hook, 100 for prompt/skill).

## Required design constraints

- STATE-1..STATE-4 must be enforced at LedgerWriter, not advisory.
- pd-console UI must clearly show "Approved — In probation (N calls remaining)" status.
- Per-channel probation window configurable in `activation.yaml`.
- Manual override: `pd activation promote <principleId> --confirm` allowed for emergencies (audited).

## Acceptance criteria

1. Schema migration for new state.
2. Architecture regression tests STATE-1..STATE-4.
3. pd-console UI updated.
4. Synthetic baseline: probation principle is auto-archived on regressed verdict in window.

## Dependency

PRI-232 (attribution must exist to evaluate verdict).

## Suitable executor

Strong AI; touches state machine, ledger schema, and UI.
```

#### PRI-236: Pruning Action MVP via Attribution

**Title**: Pruning Action MVP — auto-archive regressed evolved principles via Attribution

**Priority**: Medium (P3)

**Description**:

```markdown
## Context

Pruning Action has been deferred for months. ADR-0013 + PRI-232 + PRI-234 + PRI-235 together deliver the prerequisites: with attribution verdict and provenance separation in place, regressed evolved principles can be auto-archived without human review.

## Goal

Wire the Attribution verdict=regressed → ActivationDispatcher.deactivate path for `provenance=evolved` principles only. Bundled remains immune. Manual Pruning Review log (existing) stays available for evolved principles that have been uncertain ≥ 3 windows.

## Required design constraints

- SD-1 invariant: any `active → archived (auto)` must trace to a verdict=regressed.
- Bundled principles never auto-archive.
- Manual review log remains the path for verdict=uncertain ≥ 3 windows.

## Acceptance criteria

1. End-to-end: synthetic regressing principle → window completes → verdict=regressed → archived → ledger reflects archivedReason='attribution_regressed'.
2. Architecture regression tests SD-1.
3. pd canary surfaces attribution-driven archive count.

## Dependency

PRI-232 + PRI-234 + PRI-235.

## Suitable executor

Strong AI; small scope but touches activation state.
```

### 7.2 现有 issue 的描述追加（comment-only update）

追加给以下 issues 一段评论：

#### PRI-148 — 加注 comment

```text
[2026-05-24 v2.0 update]

Decision source: ADR-0013 (Attribution Pipeline) + 06-ahe-informed-architecture-review.md.

Scope clarification: this issue handles the **explicit human rejection** branch only. The **silent ineffectiveness** branch is owned by PRI-232 (Attribution Pipeline MVP). When this issue completes, it should:

- accept reject input
- create new Dreamer task with correctionHints
- write structured RejectionFeedback record

It must NOT try to implement value-loop verification on its own; that is PRI-232's role. Together they close the full feedback loop.

No change to current acceptance criteria or priority.
```

#### PRI-118 — 加注 comment

```text
[2026-05-24 v2.0 update]

Additional consumer: PRI-232 (Attribution Pipeline MVP) requires reliable trajectory read-out for verdict computation. The evidence read facade defined here MUST satisfy attribution's needs (window-bounded reads of pain signals + tool call sequence). Coordinate scope with PRI-232 before merging.
```

#### PRI-183 — 加注 comment

```text
[2026-05-24 v2.0 update]

Scope correction: PRUNING_PIPELINE.md must reflect the dual-track design (post ADR-0013):

1. Attribution-driven auto-archive (verdict=regressed, evolved-only) — primary path
2. Manual Pruning Review log — secondary path for verdict=uncertain ≥ 3 windows

Do not describe pruning as a "human-only" pipeline. The document should land before PRI-236 implementation.
```

### 7.3 立即可执行的 Linear API 调用清单

执行人员（用户或 AI 助手）按下列顺序运行：

```
1. Create PRI-232 (Attribution Pipeline MVP) — Urgent
2. Create PRI-233 (WorkspaceLearningSummary)
3. Create PRI-234 (Bundled vs Evolved provenance)
4. Create PRI-235 (Activation Probation Window)
5. Create PRI-236 (Pruning Action MVP via Attribution)
6. Comment on PRI-148, PRI-118, PRI-183 with the texts above
```

参见仓库 `.pd/tmp/linear-create-phase1cd-issues.ps1`（自动化脚本）。
