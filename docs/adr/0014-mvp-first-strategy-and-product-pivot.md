# ADR-0014: MVP-First Strategy and Product Pivot to Behavior Character Internalization

> **Status**: Accepted
> **Date**: 2026-05-24
> **Supersedes**: ADR-0013 (Attribution Pipeline) — deferred, not abandoned. See §6.
> **Reframes**: ADR-0006 (5-channel activation) priorities. See §4.
> **Defers**: ADR-0008 (BALM), ADR-0009 (LRAS), ADR-0010 (GAP), ADR-0011 (MissionScheduler) — see post-mvp-conditional-roadmap.md
> **Drives**: docs/plans/2026-05-roadmap/07-mvp-first-pivot.md (execution)

## 1. Context

PD 项目已经积累了大量子系统：5 个激活通道（其中 2 个 writer 待建）、7 个 Peer Runner、Pain pipeline、Internalization pipeline、Activation pipeline、5 个 ReadModel、3+ 个 Adapter、BALM/LRAS/GAP/MissionScheduler 4 个未实施 ADR、Attribution Pipeline 提案……

项目的复杂度已经超过单人理解能力的阈值。维护者（一人 + AI 助手）每日产出 3-4 个 PRI 的速度让这种膨胀加速。同时：

- **零真实外部用户**。所有 pain signal 来自合成 baseline 或维护者本人。
- **后端为主，缺乏 UI 验证路径**。维护者形容为"蒙眼开车"。
- **功能间耦合深**，难以孤立验证某个子系统的真实价值。
- **下线机制缺失**。每个新功能都被加进来，没有功能曾经被关闭过。

进一步审视，发现一个根本性的产品误读：之前推荐的"AI 不再犯同类错误"故事（PainSignal → Diagnostician → prompt 注入 → 拦截）实际上是**工具级错误的处理**——这个层次属于 OpenClaw / Claude Code 自身的职责，不是 PD 的差异化价值。

## 2. Decision

PD 进入 **MVP-First 阶段**。所有架构演进暂停，目标是在 **4-6 周内邀请第一个真实种子客户**。

### 2.1 产品定位重新校准

PD 的真正治理对象是 AI agent 的 **行为品格**——跨会话、跨任务、稳定的性格性偏差，而不是单次工具调用失败。

```
错误层次              处理者                            PD 是否关心
─────────────────────────────────────────────────────────────────
工具级（参数错、命令失败）   OpenClaw / Claude Code 自身       否
任务级（同类任务反复失败）   per-session memory                次要
行为模式级（跨会话品格偏差） PD ★                              主要
```

具体例子：
- "AI 在不可逆操作前缺乏确认习惯" — PD 关心
- "AI 在重构时偏激进而非保守" — PD 关心
- "git push 失败" — PD 不关心（OpenClaw 处理）
- "命令缺少 --confirm 参数" — PD 不关心

### 2.2 MVP 故事 A'：把零散教训沉淀成稳定品格

**演示路径**（4-6 周内必须可被外部用户走完）：

```
[多次相似情境的失败 / 人工纠正 / 风险接近]
                         ↓
              PainSignal 累积同类信号
                         ↓
              Diagnostician 识别"这不是单次失败，是模式"
                         ↓
       Dreamer + Scribe 把模式抽象为 Principle 候选
                         ↓
       人工在 pd-console 审核 → 决定走哪个通道
                         ↓
        ┌─────────────┬─────────────┐
        ▼             ▼             ▼
     Prompt       RuleHost      defer_archive
   (软提示)      (硬拦截)        (优雅退场)
        │             │             │
        └─────────────┴─────────────┘
                      ↓
          代理在下一轮真实任务中表现出新品格
```

**首次种子客户验证只依赖三个已经实现、可以观测和回滚的通道**：`prompt`、`code_tool_hook` / RuleHost、`defer_archive`。`skill` / `SkillFileWriter` 是受控 stretch goal，不是邀请客户的前置条件；只有客户需求或维护者明确决策才能把它移入当前路线。

### 2.3 三档分类法（取代之前的"留/砍"二元）

| 档位 | 含义 | 处理 |
|------|------|------|
| **MVP-Core** | 故事 A' 演示链路必需 | 保留并打磨；feature flag 默认开 |
| **MVP-Quiet** | 留代码但**关闭默认 + 不进入 UI / 文档** | feature flag 默认关；6 个月无激活则 MVP-Gone |
| **MVP-Gone** | 删除或归档 | 直接减少代码量 |

**关键原则**：MVP-Quiet 是**可逆的隔离**，不是删除。代码保留，flag 关闭。这让"减法"不那么痛苦——我们只是减少**用户和维护者大脑里的概念数量**，不破坏系统完整性。

### 2.4 MVP-Core 清单（保留并打磨）

| 子系统 | 备注 |
|-------|------|
| Pain capture (hook) + PainSignal | 已落地 |
| Diagnostician + DiagnosticianRunner | 已落地 |
| CandidateIntake + LedgerPrincipleEntry | 已落地 |
| **Dreamer + Scribe + Artificer** Runner | 已落地。Artificer 是 skill / RuleHost 的产出源 |
| **prompt 通道** + LedgerPromptWriter | 已落地 |
| **defer_archive 通道** + LedgerArchiveWriter | 已落地 |
| **code_tool_hook 通道** + RuleHostWriter | 已落地 (PRI-146) |
| Approval Queue + pd-console approvals 页 | 部分落地 |
| pd-console 三页（Pain / Principle / Approval）| 待精简 |
| pd-cli 核心命令 (`pd diagnose run` / `pd status` / `pd trace show` / `pd activation list`) | 已落地 |
| PainChainReadModel | 已落地 |
| **Trajectory Collector** (hooks + service) | 已落地。从 MVP-Quiet 升级为 MVP-Core（PRI-353）：PainChain 和诊断链路依赖 trajectory 数据构建 evidence，关闭时诊断代理只能 defer |

### 2.5 MVP-Quiet 清单（关闭，留代码）

| 子系统 | 关闭理由 |
|-------|---------|
| Philosopher / Evaluator / RolloutReviewer Runner | Dreamer + Scribe 产出粗糙但人工审批可纠正；这 3 个 Runner 是"质量打磨链" |
| GFI (Global Friction Index) | 内部决策有用，但用户不可见，不在故事 A' 内 |
| Focus History 详细注入 | 让 prompt 更"聪明"但更不可解释。MVP 的 prompt 注入应该可读、单一原则 |
| Thinking OS injection | 同上 |
| Empathy keyword matcher | 同上 |
| Layer 3 信号源 `empathy_inferred` | 推断本身可能错；保留 explicit user_correction |
| Shadow Observation / Local Worker Routing | OpenClaw 内部优化，外部用户不可见 |
| Central Sync Service | 跨工作区，MVP 单 workspace |
| message-sanitize hook | COMPONENTS.md 自标"建议删除" |
| ~~Trajectory Collector（默认开关）~~ | ~~评估后决定；如果 PainChain 不依赖则关闭~~ → 已升级为 MVP-Core（PRI-353） |
| **skill 通道** + SkillFileWriter | 尚未实施且没有客户验证；仅在需求被观察后重新评估 |

### 2.6 MVP-Gone 清单（删除/归档）

| 子系统 | 处理 |
|-------|------|
| Nocturnal Trinity / Arbiter / Service / Artificer | ADR-0012 已决定退役（PRI-227~231）|
| OpenClaw IdleTrigger / sleep cycle / night mode | 同上 |
| Evolution Worker | 同上 |
| Trainer Runner / model_training 通道 / TrainingExporter (待建) | LoRA 不在 MVP 故事内 |

## 3. Implementation MVP Track（取代 Phase 1C/1D）

按 docs/plans/2026-05-roadmap/07-mvp-first-pivot.md §5 执行：15 个 issue / docs，4-6 周。

```
Week 1-2: 减法 + 三个已实现通道闭环验证
  PRI-252  control-plane convergence（修正文档与 Linear 路由）
  PRI-239  可加载 feature flags + MVP-Quiet 关闭
  PRI-240  proven-channel synthetic 冒烟
  PRI-242  Nocturnal / idle-trigger 退役协调

Week 3-4: 用户旅程 + proven-channel 演示
  PRI-243  stretch checkpoint：仅在真实需求存在时提出 SkillFileWriter
  PRI-244  pd-console proven-channel 审批 UI
  PRI-245  pd-console 三页化
  PRI-246  Demo workspace + 故事 A' proven-channel 场景

Week 5-6: 安装 + 邀请
  PRI-247 pd-cli 一键安装
  PRI-248 GETTING-STARTED 用户视角重写
  PRI-249 故事 A' 录屏 + 文字
  PRI-250 多环境冒烟
  PRI-251 邀请第一个种子客户
```

## 4. ADR-0006 (5-channel activation) 关系澄清

ADR-0006 的 5 通道设计**不变**。本 ADR 仅调整 MVP 优先级：

| 通道 | ADR-0006 状态 | MVP 状态 |
|------|--------------|---------|
| prompt | Active | MVP-Core |
| defer_archive | Active | MVP-Core |
| skill | 待建 | **MVP-Quiet / Stretch**（不阻塞首次客户邀请）|
| code_tool_hook (RuleHost) | Active (基础)| MVP-Core |
| model_training | 待建 | **MVP-Gone**（不在 MVP）|

ADR-0006 的不变量（所有人工审批、二次确认、shadow mode）全部保留。

## 5. AGENTS.md 强制约束（落地后）

每个新 issue 在 PR 启动前必须答 **MVP 三问**：

1. **不做会怎样？** 30 天后还有人提吗？如果答不出，issue 拒收。
2. **怎么观察？** 实施后用户怎么验证它在工作？UI 看？CLI 命令？日志？无可观察方式拒收。
3. **怎么关闭？** 实施后如果发现不好用，关闭路径？feature flag 还是 PR revert？只能 revert 的必须带 flag 一起来。

`PRI-239` 落地生产可读取、可测试的 feature flag registry 之前，不新增功能面；bugfix、验证、文档和 legacy retirement 不要求虚构 flag 文件。`PRI-239` 合并后，每个新功能在 commit 前必须在 `feature-flags.yaml` 注册，且 loader/test 必须证明 flag 实际生效。

## 6. ADR-0013 (Attribution Pipeline) 处置

ADR-0013 标记为 **Superseded by ADR-0014 — Deferred**：

- 状态从 Proposed → Deferred
- 概念保留作为未来回顾输入
- 实施重启条件：见 docs/plans/post-mvp-conditional-roadmap.md（满足 ≥3 个种子客户使用 ≥1 月 + 客户反馈"原则越来越多变慢"+ active count 稳定 ≥10）
- 在重启条件满足前，禁止任何 issue 引用 ADR-0013 要求即时实施

## 7. PD_System_Dynamics_Model v2.0 处置

v2.0 引入的 R4 Attribution Loop / R5 Conflict Detection / PRRR 北极星指标 / 8 杠杆排序，**全部标记为 deferred concepts**。v1.0 概念蓝图（R1/B1/R3）保留作为产品哲学叙事使用。重启条件同 ADR-0013。

## 8. Consequences

### Positive

- 复杂度立即停止增长
- MVP-Quiet 关闭后用户/维护者认知负担降低
- 4-6 周内具备真实外部反馈能力，不以新通道开发阻塞邀请
- "下线机制"从隐性变显性
- 故事 A'（行为品格内化）保留 PD 的差异化定位

### Negative / Cost

- 已落地的 Philosopher / Evaluator / RolloutReviewer 维护成本短期不消失（只是 flag 关闭）
- 暂不实现 SkillFileWriter 可能让首次演示少一个主动工作流出口；客户需求出现后再投资
- pd-console 三页化需要回退 / 隐藏现有页面，可能临时影响维护者本人体验
- 需要严格执行"MVP 三问"，否则会被新提案绕过

### Neutral

- ADR-0008/9/10/11/13 全部 deferred 而非取消，未来路径保留
- v2.0 系统动力学概念保留为思考资产

## 9. Anti-patterns Prevented

本 ADR 同时预防几种已观察到的反模式：

1. **"完整性焦虑"驱动的功能扩张** — MVP-Quiet 用 flag 而非删除化解
2. **"为未来铺路"的抽象超前** — MVP 三问中的"不做会怎样"压制
3. **AI 助手快速产出导致的复杂度膨胀** — 三档分类强制 PR scope
4. **后端无 UI 验证盲飞** — Demo workspace + pd-console 三页化解决
5. **下线机制缺失** — PRI-239 落地后由 feature-flags.yaml loader/test + AGENTS.md 三问约束

## 10. References

- docs/plans/2026-05-roadmap/07-mvp-first-pivot.md (本 ADR 的执行文档)
- docs/plans/post-mvp-conditional-roadmap.md (deferred 工作的重启条件表)
- ADR-0006 (5-channel activation, 优先级被本 ADR 调整)
- ADR-0013 (Attribution Pipeline, 被本 ADR superseded)
- ADR-0012 (Runtime V2-only, 仍生效；Nocturnal 退役继续)

---

## Amendment (2026-05-30): Promotion of Empathy Observer & Correction Observer to MVP-Core

### Context & Justification
During real-world execution testing of MVP Story A', it was observed that **deterministic programmatic pain signals (such as simple command failures or hard exceptions) are extremely hard to trigger in regular user-assistant conversational scenarios**. This sparse trigger rate makes behavior internalization slow to manifest, creating an observation gap for the initial MVP evaluation.

To resolve this bottleneck, we have promoted the **Empathy Observer** (previously classified as MVP-Quiet) and **Correction Observer** (previously part of the retired nocturnal pipeline, now re-designed as an active SDK-level periodic optimizer) to **MVP-Core**.

- **Empathy Observer**: Uses LLM semantic analysis in the background of conversational prompts to extract high-quality emotional friction and frustration keywords from user messages. This reactively captures frustration patterns that traditional programmatic error-catchers miss completely.
- **Correction Observer**: Periodically reviews SQLite trajectory history to automatically adjust keyword weights and decay false positives, ensuring trigger accuracy continuously remains self-correcting. Now runs as an **independent service** (not on evolution heartbeat) per PRI-293.

### Reclassified Items
1. **Empathy Observer**: Reclassified from **MVP-Quiet** to **MVP-Core** (wired asynchronously in the prompt build hook).
2. **Correction Observer**: Reclassified from **MVP-Gone** (as nocturnal workflow) to **MVP-Core**. Originally triggered on evolution heartbeat; extracted to an independent service with its own feature flag (`correction_observer`, quiet category with enabled=true default, to allow runtime disabling) per PRI-293, so it no longer depends on the default-off EvolutionWorker. Surface registry entries remain `core` for triage; feature flag is `quiet` to preserve the runtime kill switch.

---

## Amendment (2026-06-10): Owner Exception — Diagnostician Multi-Agent Split & Core-Principle Grounding

> **Status of amendment**: Accepted (maintainer-driven, owner exception)
> **Scope**: `DiagnosticianRunner` and its supporting context/output contracts only.
> **Does NOT reopen**: BALM / LRAS / GAP / MissionScheduler / Trainer / model_training / Attribution Pipeline. Those remain deferred under §6 and post-mvp-conditional-roadmap.md.

### A. Context — why this is an explicit exception

ADR-0014 §2.4 lists `Diagnostician + DiagnosticianRunner` as **MVP-Core** and the body of this ADR pauses architectural expansion. Under the default rule, splitting one agent into several would be "architectural expansion" and rejected.

The maintainer (owner) is making a **scoped exception** for the diagnostician because dogfooding surfaced four concrete defects that block Story A' quality, not future-proofing wishes:

| # | Defect (observed, not speculative) | Evidence |
|---|------------------------------------|----------|
| **Q1** | `pd pain record` blocks 256–480s synchronously. The 5-layer `await` chain (CLI → Service → Bridge → Runner → Adapter.completeSimple) gives the operator no submit/complete separation. Under dogfood, OpenClaw appears hung and the operator Ctrl-C's, aborting the diagnosis. | Manual pain signals `manual_1781081305247_*` took 256–480s; one CLI call never returned. |
| **Q2** | `DiagnosticianRunner` is the **only** runner that does not extend `BasePeerRunner`. It re-implements the entire lease→poll→fetch→validate→retry pipeline, duplicating ~300 lines and drifting from the 7 unified peer runners. | `diagnostician-runner.ts` vs `philosopher-runner.ts`/`scribe-runner.ts`. |
| **Q3** | The single agent emits "rule-like", insufficiently abstract principles because one LLM call must simultaneously do root-cause analysis, principle distillation, AND taxonomy routing across 5 kinds. A small/local model cannot carry that load. | `diagnostician-prompt-builder.ts` Phase 4 crams taxonomy + distillation into one instruction. |
| **Q6** | The agent generates principles "in a vacuum": `DiagnosticianContextPayload` has no field for the T-01..T-09 core axioms (think-os), so distilled principles do not grow from the existing principle hierarchy. | `context-payload.ts` `DiagnosticianContextPayloadSchema` has no `corePrinciples`. |

These are **product-boundary-internal**: PD owns owner-reviewed, reversible behavior internalization, and the diagnostician is the entry point of that pipeline. Improving its output quality and operability is core to Story A', not scope creep.

### B. Decision

1. **Release the "no multi-agent split" constraint for the diagnostician only.** The diagnostician may be decomposed into a small, fixed chain of peer runners that each extend `BasePeerRunner`, reusing the existing `dependencyTaskIds` + `PIArtifact` chaining already used by Dreamer→Philosopher→Scribe.
2. **Grounding in core principles is in-scope.** T-01..T-09 (think-os axioms) may be promoted from markdown-only to a structured, read-only **Core Principle Registry** in `@principles/core`, injected into the distillation stage. This is a narrow reclassification of "Thinking OS injection" (previously §2.5 MVP-Quiet) **for diagnostician grounding only** — it is NOT a re-activation of general Thinking-OS prompt injection into every agent turn.
3. **CLI async (Q1) is the prerequisite and ships first**, behind a flag, using the CLI-layer fire-and-forget pattern (default async submit + `--wait` for legacy sync). No `core`-layer event-driven rearchitecture (ADR-0014 §9 anti-pattern stays in force).
4. **Old single-agent path is retained, flag-gated, until the new chain proves equal-or-better** on a 3-arm comparison (baseline single-agent vs grounded-single-agent vs multi-agent-split). This makes the refactor reversible.

### C. MVP Three Questions (mandatory, answered)

1. **What happens if we DON'T do this?** The diagnostician stays a sync-blocking, monolithic agent producing rule-like principles ungrounded in core axioms. Dogfood and the first seed customer will keep hitting hangs and low-quality principles — this WILL be raised again well within 30 days. Not rejected.
2. **How is it observed?** (a) CLI returns `< 5s` with `painId + taskId`; `pd task show <taskId>` reflects progress. (b) New per-stage telemetry events (`diag_rootcause_*`, `diag_distiller_*`, `diag_router_*`). (c) The 3-arm comparison report scores abstraction quality and core-principle linkage. (d) Each distilled principle records `groundedOnCorePrincipleIds`.
3. **How is it disabled?** Three independent feature flags (see §D). Every new behavior is flag-gated default-off (except CLI async which is operability-critical and ships with `--wait` escape hatch). Disable = flip flag, no PR revert needed. Satisfies the "anything requiring revert must ship with a flag" rule.

### D. Feature flags (registered per PRI-239 contract)

| Flag | Category | Default | Controls |
|------|----------|---------|----------|
| `diagnostician_async_cli` | quiet | `false` | CLI fire-and-forget submit. When off, legacy sync behavior. |
| `diagnostician_split_pipeline` | quiet | `false` | Route diagnosis through the multi-agent chain. When off, the existing single-agent `DiagnosticianRunner` runs unchanged. |
| `diagnostician_core_grounding` | quiet | `false` | Inject Core Principle Registry into the distillation stage. Independent of split so grounding can be A/B-tested on the single agent too. |

All three must be wired through the production loader and exercised by a test before counting as registered. Until then, the new code paths stay dormant.

### E. Scope guard (what this amendment does NOT authorize)

- No new activation channels, no SkillFileWriter/TrainingExporter changes.
- No change to the 5 recommendation kinds' downstream contract (`CandidateIntakeService`, committer) — only *which agent produces which kind* changes.
- No host-side scheduler, no event bus, no `core`-layer async runtime. Q1 is solved at the CLI process boundary only.
- No reopening of any deferred ADR. If the split design appears to need BALM/MissionScheduler, STOP and reassess.

### F. Reversibility & exit

If the 3-arm comparison shows the split is not better, flip `diagnostician_split_pipeline` off and the system reverts to the single-agent runner with zero data migration (both paths write the same `DiagnosticianOutputV1` + `PIArtifact` shape). The split runners then become MVP-Quiet code pending deletion.

---

## Amendment (2026-06-16): Owner Exception — Dreamer L2 Agent Loop

> **Status of amendment**: Accepted (maintainer-driven, owner exception)
> **Scope**: `DreamerRunner` runtime-invocation path only. Adds a new `L2AgentLoopAdapter` that runs dreamer through a multi-turn agent loop with read-only tools, selected by a feature flag. `BasePeerRunner`, the dreamer's `buildContext`/`validateOutput`/`succeedTask`, and the `DreamerOutputV1` + `PIArtifact` output contract are unchanged.
> **Does NOT authorize**: migration of any other runner (philosopher, scribe, artificer, evaluator, diag runners) to L2; any new activation channel; BALM / LRAS / GAP / MissionScheduler / Trainer / model_training / Attribution Pipeline. Each of those remains deferred under §6 and `post-mvp-conditional-roadmap.md`.

### A. Context — why this is an explicit exception

ADR-0014 §2.4 lists `Dreamer + Scribe + Artificer Runner` as MVP-Core, and the body of this ADR pauses architectural expansion. Under the default rule, introducing a multi-turn agent loop and a new runtime adapter would be "architectural expansion" and rejected.

The maintainer (owner) is making a **scoped exception** for the dreamer runner because dogfooding surfaced a concrete quality defect, not a future-proofing wish, and the owner has judged the current single-turn design unacceptable:

| # | Defect (observed) | Evidence |
|---|-------------------|----------|
| **L1** | Dreamer is single-turn in/out. It receives a compressed predecessor artifact and must emit the full `DreamerOutputV1` in one LLM call. It cannot actively query predecessor artifacts, the core-principle registry, or the pain→principle chain to verify its own output before committing. | `dreamer-runner.ts` `invokeRuntime` → single `runtimeAdapter.startRun`; `docs/plans/quality-dogfood-output/QUALITY-SUMMARY.md` — 6 of 7 dogfood principles detached from the original pain, root cause listed as "dreamer received null predecessor output" + missing grounding. |

The owner has decided this single-turn forwarding is not acceptable for the dreamer: an agent that produces principle candidates must be able to read its predecessor artifact and the existing principle library before emitting a candidate, rather than hallucinate from a compressed context blob.

This is **product-boundary-internal**: PD owns owner-reviewed, reversible behavior internalization, and the dreamer is the candidate-generation stage of that pipeline. Letting it actively read its own evidence chain (not modify anything) is core to Story A' quality, not scope creep.

### B. Decision

1. **Release the "no new runtime adapter / no multi-turn loop" constraint for the dreamer only.** A new `L2AgentLoopAdapter implements PDRuntimeAdapter` may run dreamer through a multi-turn agent loop (built on the low-level `agentLoop()` from `@earendil-works/pi-agent-core`) with a small set of **read-only** tools.
2. **Read-only tools only.** The tools (`read_principles`, `read_artifact`, and a self-built `submit_output`) query in-process PD read-models (`loadLedger`, `PIArtifactStore`, `CORE_PRINCIPLES`). No tool writes, no shell-out, no `search_codebase` (that would duplicate the OpenClaw host's coding tools and cross the PRODUCT_IDENTITY "does not duplicate host capability" boundary). Tool executors are injected store interfaces that expose only `get*`/`list*` methods — read-only by construction.
3. **Output extraction via a self-built `submit_output` tool**, NOT via `terminate` semantics. pi-agent-core has no built-in `submit_output`, and its `terminate` field uses an `.every()` over the whole tool batch that is unreliable when the model calls another tool in the same turn. Loop termination is controlled by the low-level `shouldStopAfterTurn` hook, which detects that `submit_output` captured the output. A fallback to the existing L1 three-path extraction (`json-extractor`) applies if the model never calls `submit_output`.
4. **Old one-shot path is retained, flag-gated.** The existing `PiAiRuntimeAdapter` path runs unchanged when the flag is off. The L2 path must prove equal-or-better on a quality comparison (L1 baseline vs L2) before the flag is flipped on for anyone other than internal testing. This makes the change reversible.
5. **Precondition gate: model tool-use spike.** Because a multi-turn loop multiplies LLM calls 3–5×, this is gated on a spike verifying the target model supports native function-calling. A model without native tool-use degrades the loop into prompt-induced JSON "tool calls" and is not a real agent loop. The spike runs before any L2 code ships.

### C. MVP Three Questions (mandatory, answered)

1. **What happens if we DON'T do this?** The dreamer stays a single-turn agent that cannot verify its output against the predecessor artifact or the principle library, producing candidates detached from the original pain. The owner has judged this unacceptable. It WILL be raised again within 30 days. Not rejected.
2. **How is it observed?** (a) New telemetry `dreamer_l2_turn` (per tool-execution turn) and `dreamer_l2_complete` (final, carrying `turnCount`, `toolsInvoked`, `usedFallback`). (b) A quality comparison report scoring L1 vs L2 on 贴合度 / Grounding / 可执行性, reusing the `quality-dogfood-output/QUALITY-SUMMARY.md` dimensions. (c) The L1 baseline (PRI-407 dogfood) must be measured first, as the comparison's control arm.
3. **How is it disabled?** One feature flag `l2_dreamer`, `quiet` category, default `false`. Flip the flag off and the dreamer reverts to `PiAiRuntimeAdapter` with zero data migration — both paths write the same `DreamerOutputV1` + `PIArtifact` shape. No PR revert required.

### D. Feature flag (registered per PRI-239 contract)

| Flag | Category | Default | Controls |
|------|----------|---------|----------|
| `l2_dreamer` | quiet | `false` | Route dreamer through `L2AgentLoopAdapter` (multi-turn loop + read-only tools). When off, the existing `PiAiRuntimeAdapter` one-shot path runs unchanged. |

Must be wired through the production loader and exercised by a test before counting as registered. Until then the L2 code path stays dormant.

### E. Scope guard (what this amendment does NOT authorize)

- **No other runner migration.** This amendment authorizes L2 for `DreamerRunner` only. Each additional runner (philosopher, scribe, artificer, evaluator, the diag split runners) requires its own amendment with its own evidence and MVP-three-questions.
- **No write tools, no shell-out, no codebase search.** Tools are read-only and in-process. `search_codebase` is explicitly excluded (duplicates the OpenClaw host's coding capability; violates PRODUCT_IDENTITY Q4).
- **No new activation channels, no SkillFileWriter/TrainingExporter changes.**
- **No reopening of any deferred ADR** (BALM/LRAS/GAP/MissionScheduler/Attribution). If the L2 design appears to need any of them, STOP and reassess.
- **No change to the dreamer output contract** (`DreamerOutputV1`), `PIArtifact` shape, or downstream consumers.

### F. Reversibility & exit

If the quality comparison shows L2 is not better (specifically not better on the Grounding dimension), flip `l2_dreamer` off and the system reverts to the one-shot `PiAiRuntimeAdapter` with zero data migration. The `L2AgentLoopAdapter` and its tools then become MVP-Quiet code pending deletion.

---

## Amendment (2026-06-17): Owner Exception — RuleHost MVP Activation (Artificer L2 + Evaluator V2)

> **Status of amendment**: Accepted (owner exception, maintainer-driven)
> **Owner approval**: PD (project owner), 2026-06-17 — explicit approval recorded in conversation ("选项 A，我批准当前项目的开工范围了"). This amendment is the written evidence of that approval; the PRD (`docs/plans/rulehost-mvp-activation.md`, status `Draft for owner review`) is the design source of truth.
> **Scope**: `ArtificerRunner` runtime-invocation path (new `ArtificerL2Adapter`), `EvaluatorRunner` output/assembly contract (`EvaluatorOutputV2`), and the `Evaluator` MVP bucket reclassification from Quiet → Core. Does NOT touch `BasePeerRunner`, `RuleHostWriter.canActivate`, `refiner-rulehost-gate.ts`, `refiner-sandbox-wrapper.ts`, or `golden-trace.ts` (all read-only).
> **Does NOT authorize**: migration of any other runner (philosopher, scribe, the diag split runners) to L2; any new activation channel; BALM / LRAS / GAP / MissionScheduler / Trainer / model_training / Attribution Pipeline. Each of those remains deferred under §6 and `post-mvp-conditional-roadmap.md`.

### A. Context — why this is an explicit exception

ADR-0014 §2.4 lists `code_tool_hook (RuleHost)` as **MVP-Core** and "Active (基础)", and §2.5 lists `Evaluator Runner` under **MVP-Quiet**. The body of this ADR pauses architectural expansion. Under the default rule, (a) upgrading a runner to L2, (b) reclassifying a Quiet subsystem to Core, and (c) adding code generation to a runner that currently emits only `principle` artifacts would each be "architectural expansion" and rejected.

The maintainer (owner) is making a **scoped exception** because dogfooding + existing demo code surfaced concrete defects that block the RuleHost activation channel from ever being exercised automatically in Story A':

| # | Defect (observed, not speculative) | Evidence |
|---|------------------------------------|----------|
| **R1** | **No runner produces `artifactKind: 'rule'`.** The RuleHost channel is MVP-Core and the entire `canActivate` gate (`rule-host-writer.ts:77-121`) + sandbox replay + approval queue is built, but the only code paths that produce a valid rule artifact are (a) `trainer-runner.ts:420`, which is gated to the MVP-Gone `model_training` channel, and (b) **hardcoded demo fixtures** in `story-a-demo.ts:132` and `proven-channel-baseline.ts:119`, which write `implementationCode: 'function evaluate(toolName, params) { return params.path?.startsWith("/etc") ? "block" : "allow"; }'` verbatim. In production Story A' runs, the RuleHost channel is therefore **dormant by construction** — there is no automated path from a real pain event to an enforceable `evaluate()`. | `rg "artifactKind: 'rule'"` over `packages/principles-core/src` shows only trainer + two demo/baseline fixtures. No peer runner writes rule artifacts. |
| **R2** | **Three of seven dogfood principles belong to `code_tool_hook` but none can be enforced programmatically.** `QUALITY-SUMMARY.md` records dogfood-01 / dogfood-04 / dogfood-07 as `code_tool_hook`-channel pains (deleting side-effecting code / mechanically copying error-handling / violating explicit security boundaries). Their scribed principles ("快速失败并生成诊断占位符", "处理前验证输入", "验证用户输入是否为空或未定义") are precisely the class of constraints that benefit most from programmatic interception rather than prompt-only self-policing — yet today they can only ever reach the agent via the prompt channel, because no runner emits `implementationCode`. | `docs/plans/quality-dogfood-output/QUALITY-SUMMARY.md` rows for dogfood-01/04/07 (channel column). |
| **R3** | **`EvaluatorRunner` is Quiet, so even if Artificer produced code, there is no Core-stage quality gate for it.** ADR-0014 §2.5 demoted Evaluator to Quiet on the rationale that "Dreamer + Scribe 产出粗糙但人工审批可纠正". That rationale holds for principle *text* (owner reads it before approving) but breaks for executable *code*: owner approval of an unaudited `evaluate()` function is the weakest possible gate for code that will intercept tool calls. The adversarial review + sandbox replay in this amendment is the missing programmatic gate. | ADR-0014 §2.5 Evaluator row; `evaluator-runner.ts:309-334` only validates the principle-bearing artifact, no code review today. |

These are **product-boundary-internal**: PD owns owner-reviewed, reversible behavior internalization, and the RuleHost channel is one of the three MVP-Core activation paths. Letting a real pain event produce an owner-gated, sandbox-validated, shadow-mode `evaluate()` is core to Story A', not scope creep.

### B. Decision

1. **Release the "no runner → L2" constraint for `ArtificerRunner` only.** A new `ArtificerL2Adapter implements PDRuntimeAdapter` may run artificer through a write-test-fix loop (generate `implementationCode` + `goldenTraceCases` → `evaluateRefinerRuleHostGate` sandbox replay → inject `RefinerSandboxFailedCase[]` feedback → retry, max 3 LLM calls) before returning a terminal output. This follows the Dreamer L2 precedent (`L2AgentLoopAdapter`, Amendment 2026-06-16) of encapsulating the loop in a `PDRuntimeAdapter` rather than inside `BasePeerRunner.run()` / `succeedTask()`. `BasePeerRunner` is unchanged; it still sees a single `startRun()`.
2. **Reclassify `EvaluatorRunner` from MVP-Quiet to MVP-Core**, and extend its output contract with `codeReview` (3-dimension passive review: intentConsistency / scopePrecision / traceCoverage) and `adversarialCases` + `adversarialResult`. The single-round passive-review + adversarial-sandbox-replay happens in `Evaluator.succeedTask()` (sandbox replay is a pure function, zero LLM cost). `Evaluator` remains L1 — adversarial cases are emitted in the single passive-review LLM call.
3. **Multi-round adversarial loop (max 2 rounds) lives in the orchestrator layer**, NOT in `succeedTask()`. `succeedTask()` returns `needs_revision` with `adversarialResult.failedCases`; the orchestrator decides whether to re-schedule Artificer. This respects the `BasePeerRunner` execution model: a runner cannot loop back to `invokeRuntime` from `succeedTask()`.
4. **`Evaluator.succeedTask()` writes a second artifact (`artifactKind: 'rule'`)** alongside the existing principle artifact, then calls `updateValidationStatus('validated')` on it so the existing `RuleHostWriter.canActivate` gate (line 82, `validationStatus !== 'validated'`) passes. `canActivate`, `assessRiskLevel`, and the sandbox wrapper are **not modified** (PRD Out of Scope §5).
5. **Old one-shot Artificer path is retained, flag-gated.** When `rulehost-code-generation` is off, `ArtificerRunner` runs the existing `PiAiRuntimeAdapter` one-shot path and emits `ArtificerOutputV1` (plan only, no code). When `rulehost-evaluator-code-review` is off, `EvaluatorRunner` runs the existing logic and writes only the principle artifact. Both V1 outputs continue to flow through the prompt/defer_archive channels unchanged. This makes the change fully reversible.
6. **Graceful degradation is mandatory and tested.** Artificer L2 exhaustion (3 failed sandbox replays) → V1 output (no code) → Evaluator skips code review → principle artifact still written → prompt channel still available. Adversarial loop exhaustion (2 failed rounds) → `rejected` → principle artifact still written → prompt channel still available. Code-path failure never blocks principle-text value.

### C. MVP Three Questions (mandatory, answered)

1. **What happens if we DON'T do this?** The RuleHost MVP-Core channel stays dormant-by-construction in real Story A' runs — every `code_tool_hook` principle (dogfood-01/04/07, and any future one) can only reach the agent via prompt self-policing, never via programmatic interception. The demo fixtures in `story-a-demo.ts`/`proven-channel-baseline.ts` remain the *only* producers of `implementationCode`, which is not a production path. This WILL be raised again within 30 days of the first seed customer, because the customer's pain events will produce principle text but no enforceable rule. Not rejected.
2. **How is it observed?** (a) New telemetry events `artificer_l2_attempt` (per LLM call, carrying `attempt`, `sandboxDecision`, `degraded`) and `evaluator_adversarial_replay` (carrying `passed`, `failedCaseIds`, `round`). (b) `pd activation list` and the approvals page will show real `code_tool_hook` activation requests with `implementationCode` + `goldenTrace` for owner review (User Story 12), replacing the current state where the only rule artifacts are hardcoded fixtures. (c) The PRD's 8 test modules (ArtificerOutputV2 / EvaluatorOutputV2 / L2 loop / adversarial loop / assembly / degradation) are the correctness evidence. (d) A quality comparison: re-run the 3 `code_tool_hook` dogfood pains through the new pipeline and score whether the produced `evaluate()` actually blocks the original bad tool call.
3. **How is it disabled?** Two independent feature flags (see §D), both default-off until PRI-239 merges; until then, this amendment itself is the authorization and the flags are registered as ADR-authorized stubs (same pattern ADR-0014 §5 allows for "bug fixes, evidence collection, documentation alignment" — here extended by owner exception to a Core reclassification). Flip either flag off and the system reverts to the V1 one-shot path with zero data migration (both paths write the same `ArtificerOutputV1`/`EvaluatorOutputV1` + principle artifact shape; the rule artifact is additive). Satisfies the "anything requiring revert must ship with a flag" rule.

### D. Feature flags (registered per PRI-239 contract; until PRI-239 merges, ADR-authorized stubs)

| Flag | Category | Default | Controls |
|------|----------|---------|----------|
| `rulehost-code-generation` | quiet → core after PRI-239 | `false` | Route Artificer through `ArtificerL2Adapter` (write-test-fix loop producing `implementationCode` + `goldenTraceCases`). When off, the existing `PiAiRuntimeAdapter` one-shot path runs unchanged and emits `ArtificerOutputV1`. |
| `rulehost-evaluator-code-review` | quiet → core after PRI-239 | `false` | Enable `EvaluatorRunner` V2 processing: passive review + single-round adversarial sandbox replay + rule artifact assembly. When off, Evaluator runs existing logic and writes only the principle artifact. |

Both must be wired through the production loader and exercised by a test before counting as registered. Until then the new code paths stay dormant (flag default-off). The two flags are independent so code generation can be A/B-tested against evaluator code review.

### E. Scope guard (what this amendment does NOT authorize)

- **No other runner migration to L2.** This authorizes `ArtificerL2Adapter` for `ArtificerRunner` only. Each additional runner (philosopher, scribe, evaluator, the diag split runners) requires its own amendment.
- **No modification to `RuleHostWriter.canActivate`, `assessRiskLevel`, `evaluateRefinerRuleHostGate`, `evaluateInRefinerSandbox`, or `validateGoldenTrace`.** These are read-only consumers (PRD Out of Scope §5). The amendment's job is to *produce* artifacts that pass the existing gate, not to weaken the gate.
- **No new activation channels, no SkillFileWriter/TrainingExporter changes, no Trainer restart.** Trainer stays MVP-Gone; the two rule-artifact producers (Evaluator from internalization, future Trainer from model_training) are distinguished by `sourceTaskId`/channel.
- **No owner-approval UI changes** (PRD Out of Scope §3). The shadow → enforce transition continues to use the existing `owner-approved` action.
- **No prompt-channel changes** (PRD Out of Scope §4). `prompt-activation-reader.ts` / `prompt.ts` untouched.
- **No code-review dimension 4 (security) or 5 (reversibility).** Sandbox is the security floor; artifact inactivation is the reversibility floor (PRD Out of Scope §6, §7).
- **No adaptive adversarial loop policy.** Hard cap: 2 rounds, then `rejected` (PRD Out of Scope §8).
- **No reopening of any deferred ADR.** If the design appears to need BALM/MissionScheduler/Attribution, STOP and reassess.

### F. Reversibility & exit

If dogfood re-scoring shows the new pipeline does not produce enforceable rules for the 3 `code_tool_hook` pains (or produces worse outcomes than prompt-only), flip both flags off and the system reverts to the V1 one-shot paths with zero data migration: Artificer emits `ArtificerOutputV1` (plan only), Evaluator runs existing logic and writes only the principle artifact, prompt/defer_archive channels are unaffected. The `ArtificerL2Adapter`, `EvaluatorOutputV2` schema fields, `adversarial-case.ts`, and `buildGoldenTraceFromArtificer()` then become MVP-Quiet code pending deletion (the pure functions remain reusable if a future design needs them). The rule artifact shape is additive — no existing artifact is rewritten.

---

## Amendment (2026-08-21): Owner Exception — RuleCode Live Decision and Host-Liveness Safety

> **Status of amendment**: Accepted (owner exception, maintainer-approved)
> **Maintainer approval evidence**: On 2026-08-21, repository administrator `csuzngjh` explicitly instructed the assistant to complete the formal MVP-Core gate and revise ADR-0014's old Owner-approval UI assumption. GitHub reported `viewerPermission=ADMIN` for `csuzngjh/principles` at the time of approval.
> **Design source of truth**: `docs/superpowers/specs/2026-08-21-rulecode-owner-live-decision-safety-design.md`
> **Supersedes**: Only the 2026-06-17 amendment's scope-guard statement **“No owner-approval UI changes”**. The remaining 2026-06-17 scope guards continue to apply unless this amendment explicitly narrows them.

### A. Context — observed product and safety failure

The RuleHost path can generate and shadow executable RuleCode, but the Owner lacks a complete product surface for reviewing shadow evidence, making the final Live decision, rejecting unsafe rules, and seeing the result after activation. The CLI has been the practical control path even though a seed customer should not need operator knowledge to govern learned behavior.

More seriously, a real activated rule mentioned the retired `session.recentThinking` context symbol only in a comment. The compatibility scanner treated that comment as an executable reference, and the production guard returned global deny before the generated `evaluate()` function ran. The result intercepted essentially every host tool call and made OpenClaw unusable until the activation was manually deactivated. This is an observed MVP-Core reliability and Owner-control defect, not a request for general task execution or speculative extensibility.

### B. Decision

1. **Require an Owner Live Decision for every shadow → live transition.** The decision is bound to an immutable activation, artifact digest, readiness evaluation, evidence snapshot, and actor identity. No generated rule, timer, or system process may make this value decision for the Owner.
2. **Authorize the bounded Owner Live Decision surface as MVP-Core.** This includes the shadow evidence/readiness reader, shared promotion application service, immutable decision/evidence writer, and Console queue/detail/live-monitoring pages described by the design source of truth.
3. **Authorize RuleCode safety controls as MVP-Core safety infrastructure.** This includes durable per-activation safety isolation, the Safety Circuit Breaker, Global Emergency Pause, recovery-to-shadow, and the host-adapter-owned Host Liveness Contract. A process restart must not erase containment state.
4. **Treat comment-only compatibility and RuleCode fail-open execution as corrections to the existing RuleHost contract.** Compatibility scanning evaluates executable syntax separately from comments and string literals when checking executable context references. Rule load, timeout, exception, invalid output, or incompatible context isolates the affected rule and allows the current host operation; it must never become global deny.
5. **Use one promotion gate for Console and CLI.** Both entry points call the same application service and safety predicates. If the Owner Live Decision subsystem is disabled or unavailable, promotion is refused everywhere; there is no fallback to the legacy unchecked CLI path.
6. **Limit unauthenticated break-glass authority to stopping harm.** A local unauthenticated operator may inspect, emergency-deactivate, or trigger Global Emergency Pause. It may not promote, reject after shadow, continue observation, supersede, release governance decisions, or impersonate the configured Owner.

### C. MVP Four Questions

1. **`mvp-q-1-what-if-skip` — What happens if we do not do this?** A broad or malformed RuleCode can again disable the host's tool surface, while an Owner still lacks a usable final review and recovery path. This has already happened and would be raised immediately by a seed customer.
2. **`mvp-q-2-how-observed` — How is it observed?** The Owner sees readiness, representative allow/deny samples, protected-capability probes, failed safety checks, and exact rule scope in Console before deciding. After activation, live monitoring shows interception rate, deny rate, circuit state, and emergency controls. CLI exposes the same structured facts for operators.
3. **`mvp-q-3-how-disabled` — How is it disabled?** `rulecode_owner_live_decision=false` stops every new promotion while retaining shadow observations and historical decisions. Safety controls remain available. If the safety-control subsystem itself is unavailable, disable the existing `code_tool_hook` capability and fail open all RuleCode enforcement; no PR revert or host-agent cooperation is required.
4. **`mvp-q-4-emotional-value` — What emotional value does it deliver?** It converts the Owner's loss of control and distrust after a host-wide outage into reassurance and control: the system explains why a rule is or is not ready, reserves the final value decision for the Owner, and provides an out-of-band stop path that remains usable when the host agent is impaired.

### D. Feature flags and rollout authorization

| Flag | Category | Initial state | Controls |
|------|----------|---------------|----------|
| `rulecode_owner_live_decision` | core | `true` | Shadow evidence reader, common promotion service, immutable decision/evidence writer, and Console review UI. The 2026-08-21 rollout gate passed through authenticated Owner browser E2E, CLI/service parity, immutable audit, host-liveness, and emergency rollback tests. An explicit false override still makes every promotion entry point return `feature_not_enabled`. |
| `rulecode_safety_controls` | core | `true` | Durable isolation, Safety Circuit Breaker, Global Emergency Pause, and recovery-to-shadow. It cannot be disabled while RuleCode enforcement remains active. |

Both flags must be registered in `.pd/config.yaml`, consumed by the production loader, and covered by tests before the corresponding behavior counts as available. This amendment authorizes implementation; it does not treat an unwired registry entry as a shipped feature.

### E. Scope guard

- **No automatic promotion, automatic Owner decision, automatic recovery to live, or bulk resume.** Recovery returns an isolated activation to a new linked shadow lifecycle and requires a fresh Owner Live Decision.
- **No multi-user account system or general RBAC.** MVP uses the bounded configured-Owner identity and existing Console token model.
- **No new activation channel.** This amendment governs the existing `code_tool_hook` / RuleHost channel only.
- **No general host tool repair, task execution, retry engine, memory subsystem, or autonomous value-decision system.**
- **No reopening of deferred BALM, LRAS, GAP, MissionScheduler, Trainer, model-training, or attribution work.**
- **No Console/CLI policy split.** Runtime promotion remains blocked until both surfaces enforce the same gate and record the same decision contract.

### F. Reversibility and exit

Turning off `rulecode_owner_live_decision` blocks new Live transitions but preserves shadow data, decision history, and emergency controls. Safety-isolated activations remain non-enforcing across restarts and cannot be restored by merely releasing a global pause. Every recovery creates a linked shadow activation with fresh evidence.

If `rulecode_safety_controls` cannot provide its durable state or out-of-band recovery contract, the only safe disable path is `code_tool_hook=false`, with RuleCode enforcement failing open. Historical artifacts, evidence, and decisions remain available for audit; disabling either subsystem never fabricates approval or deletes governance records.
