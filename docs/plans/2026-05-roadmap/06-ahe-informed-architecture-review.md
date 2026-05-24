# 06 - AHE 论文启发下的架构评审与系统瘦身蓝图

> **状态**: ⚠️ **Superseded by ADR-0014 + 07-mvp-first-pivot.md**（2026-05-24）
> **原状态**: Active / Strategic
> **被取代原因**: 本评审建议引入 Attribution Pipeline + Phase 1C/1D 等 5 个新 issue，违反了项目的实际阶段（零外部用户、维护者认知负担已饱和）。重新对齐 MVP-First 后，本文档的"诊断"部分仍有价值（特别是 §1 三支柱框架、§2 缺陷识别、§3 系统动力学补强），但**所有"实施建议"全部 deferred**。
> **替代文档**: [`07-mvp-first-pivot.md`](./07-mvp-first-pivot.md)、[`docs/adr/0014-mvp-first-strategy-and-product-pivot.md`](../../adr/0014-mvp-first-strategy-and-product-pivot.md)
> **保留理由**: 本文中的"PD 缺失第三支柱（Decision Observability）"诊断仍然成立。当 MVP 验证完成后，post-mvp-conditional-roadmap.md §1 的触发条件满足时，本文是重启 Attribution Pipeline 的关键输入。
> **DO NOT DISPATCH**: 下方任何“必须新增”“立即执行”或 PRI-232~236 内容均为历史提案，不是现行指令。Linear 中 PRI-232~236 已取消。当前执行入口仅为 [`07-mvp-first-pivot.md`](./07-mvp-first-pivot.md) 与 [`03-linear-sync-plan.md`](./03-linear-sync-plan.md)。

---

> **以下原文保留作历史档案。任何 AI 助手或维护者读到本文时，请直接跳到 07-mvp-first-pivot.md，不要按本文 §5 的"立即行动清单"实施。**

---


---

## 0. 阅读指引（TL;DR）

本文回答四个问题：

1. **PD 当前架构有哪些不足、可优化空间在哪？** → §2
2. **PD 系统最核心的价值链路、要素、杠杆是什么？** → §3
3. **如何让模块正交、清晰、易维护？** → §4
4. **下一阶段实施计划与工单调整建议是什么？** → §5

**最重要的结论**（一句话）：

> PD 当前缺失"决策可观测性（Decision Observability）"——一个原则被激活后，没有任何机制度量它是否真的减少了它声称要消除的痛苦类别、是否制造了新痛苦。这是导致 L1 prompt 容量螺旋失控、原则相互冲突无法察觉的根因，必须作为 Phase 1C/1D 的最高优先级补齐。

---

## 1. AHE 论文对 PD 的启发：三个支柱框架

AHE 把 coding-agent harness 的自动演化看作一个由**三个可观测性支柱**支撑的闭环：

| AHE 支柱 | 含义 | AHE 的具体实现 |
|---------|------|--------------|
| **Component Observability** | 每个可编辑组件在文件级别独立可见、可还原 | 7 类组件（system_prompt / tool_desc / tool_impl / middleware / skill / sub_agent / long_term_memory）作为独立文件 |
| **Experience Observability** | trace 不是日志，是被结构化、分层的"证据语料库" | per-task report + benchmark-level overview + drill-down 原始 trace |
| **Decision Observability** | 每个 edit 必须自带 falsifiable prediction，下一轮验证 | change manifest 含 `predicted_fixes` + `risk_tasks`，下一轮按 task delta 裁决 keep/improve/rollback |

### 1.1 PD 当前在三个支柱上的覆盖度

| 支柱 | PD 现状 | 评估 |
|------|---------|------|
| Component Observability | 5 通道（prompt / skill / code_tool_hook / model_training / defer_archive）+ Ledger 树形结构 | ✅ 大致对齐，结构清晰 |
| Experience Observability | PainSignal → DiagnosticianOutput → CandidateIntake；PainChainReadModel 提供回溯 | ⚠️ **部分**——侧重"前向链路"，但缺少"分层 + drill-down"形态供下一轮 Diagnostician 直接消费 |
| Decision Observability | **完全缺失** | ❌ 致命 |

PD 自己的 `LifecycleEvidence` 与 `RolloutReviewer` 看上去像是"决策可观测"，但它们只解决了**激活前**的判断（应该激活吗？），完全没有解决**激活后**的验证（激活之后真的有效吗？）。

### 1.2 AHE 论文中对 PD 直接有用的具体洞见

| 论文洞见 | 数据 / 论据 | 对 PD 的含义 |
|----------|-----------|-------------|
| **System prompt 单独使用会回归** | -2.3 pp aggregate | L1 通道是 ROI 最低的。PD 当前的"默认走 prompt 通道"是路径依赖 |
| **Tool / Middleware / Long-term memory 才是承载收益的层** | 单独使用各 +2.2 / +7.6 / +5.6 pp | PD 应把投资重心转向 L2 (RuleHost)。Long-term memory 是 PD **缺失**的组件 |
| **组件交互非加性，会相互冲突** | 三个单组件之和 +11.1 pp，但 full AHE 只 +7.3 pp | PD 必须建立"原则间冲突 / 冗余检测"机制；当前完全没有 |
| **Fix prediction 5× random，Regression prediction 仅 2× random** | 33.7% / 11.8% precision | Diagnostician 自归因可作为"目标声明"，但**不能作为"安全声明"**——副作用必须由系统裁决 |
| **Minimal seed 是归因的前提** | 任何预装组件都污染归因 | PD 当前每个 workspace 预装大量内置 thinking models / skills，无法区分"内置"与"演化产出"。这是归因的死敌 |
| **Decision observability 让 edit 变成 falsifiable contract** | 每 edit 携带 manifest，下轮验证 keep/improve/rollback | PD 必须把每次激活变成"可证伪契约"——这是新加的核心组件 |

---

## 2. PD 当前架构的不足与优化空间

### 2.1 致命缺陷：缺失 Attribution Pipeline（决策可观测性）

**症状**：

- L1 active principles 数量持续上升只能靠 LRU + cap = 12 兜底（PRI-139）
- 三振出局（PRI-141）只能捕获**人类显式拒绝**的失败循环，无法捕获**沉默无效**
- 当一个原则被激活后，系统没有任何反馈通道告诉它"我消除了 painId X、Y、Z；但同时引入了 painId A、B"
- Pruning Pipeline 的修剪决策依赖 `lifecycleEvidence`，但 evidence 本身是基于"启发式"而非"实证测量"

**根因**：PD 的循环是 `pain → principle → activation`，但**没有 `activation → next-round pain delta → re-evaluate principle`** 这一闭环。

**对系统动力学的影响**：

- 自己的 PD_System_Dynamics_Model.md 中的 R3（知识内化减压回路）实际上是**虚假闭合**——它假设硬规则会自动取代软原则，但没有度量"硬规则真的在减少同类痛苦吗？"
- B1（复杂度阻尼回路）当前只能通过容量 cap 强制兜底，没有质量信号

**修复方案**（细节见 ADR-0013 草案）：

引入第四条流水线 `Attribution Pipeline`：

```
[Activation N round]
       │
       ▼ (一个固定的观测窗口，例如 100 个工具调用 / 24 小时 / 50 个 painId)
[ActivationOutcomeAttribution]
   ├ pain_delta_eliminated: 该 principle 声称要消除的痛苦类别中实际减少了多少
   ├ pain_delta_introduced: 同一观测窗口内是否引入了新类别痛苦
   ├ adherence_observed: 实际行为与原则的偏差程度
   └ verdict: confirmed | uncertain | regressed
       │
       ▼ Drives:
       ├ Auto-pruning（regressed 自动归档）
       ├ Adherence rate update（替代当前的启发式估算）
       └ Next-round Diagnostician context（"上一轮你说要修 X，结果 Y" 反馈）
```

### 2.2 二级不足：架构与代码的若干漂移

| 问题 | 现状 | 优化方向 |
|------|------|---------|
| **Long-term Memory 缺失** | PD 的 Ledger 是单条原则集合，没有"跨会话沉淀的元经验"的载体 | 引入 `WorkspaceLearningSummary`（不是新原则；是关于"PD 自己"的元数据。详见 §3.4）|
| **Workspace 预装件污染归因** | 每个 workspace 启动时预装 thinking_models / built-in skills | 引入"演化前 vs 演化后"标记。基础 skill/principle 必须打 `provenance: bundled` 标签，不参与 attribution |
| **5 通道激活规模膨胀风险** | ADR-0006 设计了 5 通道，但 skill / training 通道的实际产出价值未实证 | 暂停 SkillFileWriter / TrainingExporter 实施，先把 prompt + RuleHost (code) 两个通道闭环做扎实 |
| **BALM/LRAS/GAP/MissionScheduler 同时立项** | ADR-0008/0009/0010/0011 同期 Accepted，给 Phase 2 立了 4 个大坑 | 严格排序：先 Attribution → 再 BALM 最小骨架 → 暂停 LRAS/GAP/MissionScheduler 直到价值闭环数据可量化 |
| **Plugin 仍是 god-package** | openclaw-plugin/src/core/ 122 个文件，混杂 hook / domain logic / I/O | 按 ADR-0012 退役 Nocturnal 后再做精细化迁移；不要在 legacy 删除前重构 |
| **Diagnostician 输出空间未受 Long-term Memory 约束** | Diagnostician 每次都从空白开始推理 | Diagnostician prompt 应注入 "WorkspaceLearningSummary"（最近 N 轮 attribution verdict 的浓缩），避免重复发明同类原则 |
| **没有"种子最小化原则"** | PD 项目级有大量基础原则。新工作区从空开始也会装载这些 | 立 ADR：bundled assets vs evolved assets 必须可区分；attribution 只对 evolved assets 生效 |

### 2.3 不应继续投入的方向

| 方向 | 理由 | 处置 |
|------|------|------|
| **完整实施 ADR-0006 全 5 通道** | skill/training 通道的产出收益未实证 | skill/training writer 暂缓；prompt + RuleHost 闭环先达成 |
| **Phase 2 BALM 全套 7 个 manifest** | 当前内化产出尚未稳定，每个 Runner 各做 manifest 是过度抽象 | 先做 Diagnostician + Dreamer 两个 manifest 验证机制，其余按需扩展 |
| **MissionScheduler 三层模型** | 当前没有 mission/objective 数据；建模没有真实 workload | Phase 3 才考虑；当前的 "explicit Runtime V2 scheduling boundary"（PRI-162）已经够用 |
| **GAP Layer 1 信号生成器** | 没有 mission 数据时无法实现；强行实现会变 mock | 与 Mission/Objective 一起 Phase 3 |
| **新增物理目录（如 .pd/evidence/）** | 已被 PRI-205 否决；attribution 应使用现有 SQLite metadata | 沿用 PRI-205 决议 |

---

## 3. PD 核心价值链路与杠杆识别

### 3.1 重新校准核心价值链路

PD 的真实价值不是"积累原则"，而是"**让代理在同一类失败上越来越少出错**"。

可量化的核心指标（应作为 OKR 的根）：

```
PD 核心 KPI = Pain Recurrence Reduction Rate (PRRR)
            = 1 - (后窗口同类 painId 数 / 前窗口同类 painId 数)

后窗口 = 某 principle 激活后 N 个工具调用周期
前窗口 = 该 principle 激活前 N 个工具调用周期
```

**所有其他指标都应该为此指标服务**：

- 原则数量、token 节省、adherence rate、L1 容量 …… 这些都是过程指标
- 唯一的结果指标是 PRRR

如果某个原则的 PRRR 接近 0 甚至为负，无论它如何"被遵守"、token 多省，它都应该被归档。

### 3.2 系统动力学最小核心要素（精简版）

PD 系统真正的核心要素只有 5 个，其他都是衍生：

| 要素 | 定义 | 单位 |
|------|------|------|
| **Pain Inflow Rate** | 每单位时间新增 painId 速率（按 GAP layer 分层）| painIds / hour |
| **Active Principle Count** | 当前 status=active 的原则数 | count |
| **Pain Recurrence Reduction Rate (PRRR)** | 见 §3.1 | ratio |
| **L2 Internalization Ratio** | 同义功能在 L2 实现 / 在 L1 prompt 实现 | ratio |
| **Context Pressure** | active principle 注入的总 token 数 / LLM 上下文窗口 | ratio |

### 3.3 三个核心反馈回路（修订）

修订 PD_System_Dynamics_Model.md 中的回路结构。原文档识别了 3 个回路（R1/B1/R3），还需要新增 2 个：

```
R1: Flywheel（已存在）
   pain ↑ → principle ↑ → success ↑ → trust ↑ → (新探索) pain ↑

B1: Ceiling（已存在）
   principle count ↑ → context pressure ↑ → reasoning quality ↓ → (新错误) pain ↑

R3: Decoupling（已存在但虚假闭合）
   active principle → 编译 → hard rule ↑ → context pressure ↓
   (虚假之处：缺一环——hard rule 真的有效吗？)

R4 [NEW]: Attribution Loop（必须新增）
   active principle → next-round pain delta → verdict (confirmed/uncertain/regressed)
                                                  │
                                  ┌───────────────┼───────────────┐
                                  ▼               ▼               ▼
                              auto-prune    keep+adherence    re-diagnose
                              (regressed)   (confirmed)       (uncertain)

R5 [NEW]: Conflict Detection Loop（必须新增）
   active principle pair → 同窗口内是否同时被违反？是否相互矛盾？
   → conflict_score ↑ → 触发 PrincipleArbitration（取舍 / 合并 / 重写）
```

R4 是**关键新增**：它是 R3 真正闭合的前置条件，也是 B1 的有效兜底（无效原则被自动归档，不再压榨 context）。

R5 是次要新增，但是 PD 接近 cap 时的核心质量门控。

### 3.4 核心杠杆识别（按 ROI 排序）

| 杠杆 | 影响 | ROI |
|------|------|-----|
| **L1: 引入 Attribution Pipeline** | 让 L1 容量自动降到"有效原则集"，让 R3 真正闭合 | ⭐⭐⭐⭐⭐ |
| **L2: 引入 WorkspaceLearningSummary** | 跨会话元经验沉淀，避免 Diagnostician 反复发明同类原则 | ⭐⭐⭐⭐ |
| **L3: 完成 RuleHost (code_tool_hook) 通道闭环** | 把 ROI 最高的 L2 通道做透，承接绝大部分高价值原则 | ⭐⭐⭐⭐ |
| **L4: 完成 RejectionFeedback (PRI-148)** | 关闭"人工拒绝 → 重新学习"的最后一公里 | ⭐⭐⭐⭐ |
| **L5: Bundled vs Evolved 资产分离** | 让 attribution 干净；让"PD 项目原则"与"工作区演化原则"互不污染 | ⭐⭐⭐ |
| **L6: 完成 Nocturnal/idle 退役（PRI-227~231）** | 删除 ~5000 行 dead code，CI 收敛 | ⭐⭐⭐ |
| **L7: PRI-118 Trajectory I/O facade** | Attribution 需要可靠的 trace 读出 | ⭐⭐ |
| **L8: BALM Diagnostician + Dreamer 最小骨架** | 让 Agent manifest 化，但只做最小两个 | ⭐⭐ |

未列入：SkillFileWriter / TrainingExporter / GAP Layer 1 / MissionScheduler / 完整 BALM 7 个 manifest。这些都应推迟到 PRRR 数据稳定后再评估。

---

## 4. 系统边界与模块正交化

### 4.1 当前边界问题

读了 ADR-0012 + COMPONENTS.md + PD_SYSTEM_ARCHITECTURE.md 后，PD 的边界已经相当清晰，但还有三个具体的混乱点：

| 边界混乱 | 具体表现 | 修复方向 |
|---------|---------|---------|
| **Pruning ↔ Activation 边界** | Pruning 是"激活后的反向决策"，但当前 PruningReadModel 与 ActivationDispatcher 没有显式通讯 | Attribution Pipeline 出 verdict=regressed → 直接进 Pruning Action 队列；不再依赖人工 review log |
| **Diagnostician ↔ next-round Diagnostician 边界** | 每次 Diagnostician 跑都是"无记忆的"，看到的只是当前 painId 上下文 | 引入 WorkspaceLearningSummary 作为可注入的 "Diagnostician memory" |
| **Approval ↔ ActivationDispatcher 边界** | Approval 通过 = 激活立即生效。但激活立即生效就立即进入 attribution 窗口，没有 staging 期 | 引入 `Activation Probation Window`（默认 50 工具调用）：approve 后先进 probation，期间 attribution 数据决定是否真正成 `active` |

### 4.2 重新定义的 4 大流水线（取代当前 5 条）

PD_ARCHITECTURE_OVERVIEW.md 当前列了 5 条数据流（Pain / Internalization / Activation / Operations / Pruning）。**Operations 不是流水线，是横切**；**Pruning 应该是 Attribution 的下游**。

合理的精简：

```
                   ┌────────────────────┐
                   │  1. Pain Pipeline  │
                   │  痛苦捕获 → 原则候选 │
                   └─────────┬──────────┘
                             ▼
                   ┌────────────────────┐
                   │ 2. Internalization │
                   │  原则 → 实现工件     │
                   └─────────┬──────────┘
                             ▼
                   ┌────────────────────┐
                   │ 3. Activation      │
                   │  实现工件 → 实际生效  │
                   └─────────┬──────────┘
                             ▼
                   ┌────────────────────┐
                   │ 4. Attribution     │  ★ 新增（替代 Pruning）
                   │  生效 → 测量 → 裁决  │
                   └────┬──────────┬────┘
                        │          │
            ┌───────────┘          └─────────────┐
            ▼ (regressed)                         ▼ (confirmed)
       Auto Prune                       Update LearningSummary
       (回 Activation status=archived)   (反哺下一轮 Diagnostician)
```

**Operations** 不是流水线，是横切关注点（pd-cli / pd-console 的读写边界）。
**Pruning** 不是独立流水线，是 Attribution 的执行子图。

### 4.3 4 大流水线的边界契约（强制）

| 流水线 | Owner | 输入 | 输出 | 不允许做 |
|-------|-------|------|------|---------|
| Pain | core | PainSignal | LedgerPrincipleEntry(probation) | 修改激活状态、写 PIArtifact |
| Internalization | core | LedgerPrincipleEntry(probation) | PIArtifact(validated) | 修改 active 状态、写 ledger |
| Activation | core | PIArtifact(validated) | ledger.principle.status=active+probation_active | **直接 status=active**（必须先 probation_active）|
| Attribution | core | active principles + new pain signals | verdict + adherence + recurrence | 直接修改 ledger（必须通过 ActivationDispatcher.deactivate）|

新增状态 `probation_active`：从 approve 通过到 attribution 窗口结束之间的过渡态。期间该 principle 已注入 prompt，但 LedgerWriter 不会回退到 archive 之外的状态。

### 4.4 Anti-pattern 清单（CI 守护）

新增架构守护测试断言：

| 守护 | 含义 |
|------|------|
| `ATTRIBUTION-1` | Attribution Pipeline 不得直接改 Ledger.status 字段；必须经过 ActivationDispatcher.deactivate |
| `ATTRIBUTION-2` | Attribution 输出必须可幂等重放（基于 (principleId, observationWindowId)）|
| `LEARN-1` | WorkspaceLearningSummary 是 read-only 视图，不能被 Diagnostician 修改 |
| `BUNDLED-1` | provenance=bundled 的 principle 不得进入 attribution / pruning 队列 |
| `STAGE-1` | 任何 principle 从 probation → active 必须经过 probation_active 中间态，时间 ≥ 配置最小窗口 |

---

## 5. 实施计划（Phase 1C/1D + 工单调整）

### 5.1 严格顺序

```
[已完成]
Phase 1A — L2 / RuleHost safety   ✅
Phase 1B (P1) — stability baseline ✅ (PRI-200~225)

[正在做的事]
Phase 1B (P2) — Nocturnal retirement (PRI-226 done; 227 todo; 228-231 backlog)

[新优先级建议]
Phase 1C — Value loop closure
   ├── PRI-148 RejectionFeedback (existing, raise priority)
   └── ★ NEW: Attribution Pipeline MVP (proposed: PRI-232)

Phase 1D — Lean foundations for Phase 2 readiness
   ├── ★ NEW: WorkspaceLearningSummary contract (proposed: PRI-233)
   ├── ★ NEW: Bundled vs Evolved provenance separation (proposed: PRI-234)
   ├── PRI-118 Trajectory evidence facade (existing, scope confirm)
   └── ★ NEW: Activation Probation Window (proposed: PRI-235)

[Phase 2 准入门槛]
Phase 1C+1D 完成、Attribution 出过至少 50 个 verdict 后，才允许启动 Phase 2 (BALM minimal)
```

### 5.2 工单清单（建议在 Linear 上的具体动作）

#### A. 提升优先级 / 加紧执行

| Issue | 当前状态 | 建议动作 |
|-------|---------|---------|
| PRI-148 | Todo, P2 | **保持 P2，不需要提升**——Attribution Pipeline (PRI-232) 是它的更优解；148 仍需，但范围收窄到"接收 reject → 创建 Dreamer task"，不再要求自己实现学习闭环 |
| PRI-227 | Todo, P2 | 保持，作为 Nocturnal 退役链的入口 |
| PRI-162 | Todo, P2 | 保持 |

#### B. 新建（建议在 Linear 创建以下 issues）

| 新 Issue | 优先级 | 范围 | 估时 |
|---------|-------|------|------|
| **PRI-232: Attribution Pipeline MVP** | P1 (Urgent) | 引入 ActivationOutcomeAttribution + verdict + auto-archive on regressed。最小窗口先 100 工具调用 | 2-3 周 |
| **PRI-233: WorkspaceLearningSummary contract & Diagnostician memory injection** | P2 | 定义 LearningSummary schema，在 Diagnostician prompt 中注入最近 N 个 attribution verdict | 1 周 |
| **PRI-234: Bundled vs Evolved principle provenance** | P2 | LedgerPrincipleEntry 增加 `provenance: bundled\|evolved` 字段；attribution 只对 evolved 生效；bundled cap 独立计数 | 1 周 |
| **PRI-235: Activation Probation Window** | P2 | 引入 status=probation_active；approve 后默认 50 工具调用 / 24 小时窗口；窗口期间 attribution 决定 promote 或 archive | 1.5 周 |
| **PRI-236: Pruning Action MVP via Attribution** | P3 | 替代当前的"独立人工 Pruning Action"——把 attribution verdict=regressed 的 principle 自动 archived，bypass 人工审批（仅对 evolved，且必须先 probation_active 状态过期）| 1 周 |

#### C. 重写范围（把过时描述改对）

| Issue | 修改 |
|-------|------|
| PRI-150 | 在 PRI-118 / PRI-232 / PRI-234 完成后再启动；当前描述已对，加一行依赖 |
| PRI-154 | 描述已对，确认 attribution telemetry 是其覆盖范围之一 |
| PRI-183 | 修改：PRUNING_PIPELINE.md 文档应描述"Attribution-driven pruning + 人工 review log"双轨，不再是只有人工 |
| PRI-118 | 已 Todo，确认其 evidence read facade 必须满足 Attribution Pipeline 的读取需求 |
| PRI-121 | PeerRunner harness 抽取——延后到 Phase 2，且必须在 BALM 设计后再做（否则会和 BALM 重复） |
| PRI-204 | CertifiedAgentOutput contract——延后到 Phase 2，与 BALM 一起规划 |
| PRI-202 / PRI-203 | pd CLI output validate / artifact write——保留为 Phase 1D 的工程支线，但优先级低于 Attribution |

#### D. 取消 / 标记 superseded

| Issue | 原因 |
|-------|------|
| 已有的 PRI-175~181 已经 Cancelled，无需操作 |
| 无新 cancellation |

### 5.3 风险登记（追加到 04-risks-and-mitigations.md）

| ID | 风险 | 评级 | 应对 |
|----|------|------|------|
| R-16 | Attribution Pipeline 的 verdict 不可靠（窗口太短 / pain 类型映射错误） | P1 | 先在合成 baseline (PRI-206) 上跑，至少 50 个 verdict 与人工标注一致再上线；初期只做 auto-archive，不做 auto-promote |
| R-17 | WorkspaceLearningSummary 注入让 Diagnostician 偏向"上次说过的"，缺乏多样性 | P2 | summary 是 evidence 而非命令；Diagnostician prompt 强制要求"如果与历史一致请引用，如果不一致请说明" |
| R-18 | Bundled 与 Evolved 分离实施时，存量 ledger 缺少 provenance，需要 backfill | P2 | provenance 缺失默认按 evolved 处理（最严格）；提供 `pd ledger backfill-provenance` CLI 一次性纠正 |
| R-19 | Activation Probation Window 让用户感觉"approve 了但没生效" | P2 | UI 明确显示"已批准 - 试运行中（剩余 N 次工具调用）"；console 提供"立即提升"快捷入口（高风险通道仍需二次审批）|
| R-20 | Phase 1C 抢先 Phase 1B Nocturnal 删除会导致返工 | P2 | **Historical only**：ADR-0014 已取消 Phase 1C 当前派工；只继续 Runtime V2 / Nocturnal 减法，重启条件见 post-MVP roadmap |

---

## 6. 与现有文档的同步动作

| 文档 | 动作 |
|------|------|
| `PD_System_Dynamics_Model.md` | **重写** —— 加入 R4/R5 回路，明确 PRRR 为唯一结果指标，识别 8 个杠杆 |
| `PD_ARCHITECTURE_OVERVIEW.md` | 修订 §4 五条数据流 → 四条数据流（Pruning 并入 Attribution）+ 新增 Attribution Pipeline 章节 |
| `INTERNALIZATION_PIPELINE.md` | 增加 §11 "Activation Probation Window" 与 §12 "Attribution Hand-off" |
| `ACTIVATION_CHANNELS.md` | 增加 `probation_active` 状态机；明确每通道的 probation 窗口配置默认值 |
| `COMPONENTS.md` | 新增 4 个 Attribution 组件 + WorkspaceLearningSummary + ProvenanceTagger |
| `02-roadmap.md` | 增加 Phase 1C / Phase 1D；明确 Phase 2 准入门槛 |
| `03-linear-sync-plan.md` | 加入新建 PRI-232~236 / 修订 PRI-148/183/118 的具体话术 |
| `04-risks-and-mitigations.md` | 追加 R-16~R-20 |
| `docs/adr/0013-attribution-pipeline.md` | **新建 ADR** |

---

## 7. AHE 论文里**没有照单全收**的部分

为了避免误用，明确标记我们**不**借鉴 AHE 的几个具体设计：

| AHE 做法 | 不照搬的理由 |
|---------|-------------|
| Evolve Agent 自主修改 system prompt / tool / middleware 实现 | PD 的"演化代理"是 Diagnostician + 7 个 Peer Runner，不是单个全权代理；架构上分离的优势是更可控 |
| 让 Agent 自己 git commit 并自己回滚 | PD 的 ledger 已经是 append-only + 状态机，不需要 git 作为底层；rollback 通过 deactivate 完成 |
| 把整个 NexAU framework 暴露给 Evolve Agent 修改 | PD 严格区分 core / plugin / cli，不允许 Diagnostician 修改 core 代码。这是 ADR-0012 的红线 |
| 用 Agent Debugger 把 trace 当作文件系统供另一个 Agent 探索 | PD 已有 PainChainReadModel / FullTrace，结构化程度高于自由探索；不需要再做一个 trace agent |
| Per-iteration k=2 rollouts 做 pass@1 | PD 不是 benchmark 系统，没有"pass@1"概念；对应的是 PRRR |

借鉴的是**模式**（三支柱、falsifiable contract、minimal seed、ablation 方法论），不是**实现**。

---

## 8. 立即行动清单

执行顺序（每个动作都是独立的 commit / PR）：

1. ✅ 提交本评审文档（本 PR）
2. 提交 ADR-0013 草案（Attribution Pipeline）→ 见 `docs/adr/0013-attribution-pipeline-and-decision-observability.md`
3. 重写 `PD_System_Dynamics_Model.md`（加入 R4/R5 + PRRR + 8 个杠杆）
4. 修订 `02-roadmap.md`（加入 Phase 1C/1D + 顺序约束）
5. 修订 `03-linear-sync-plan.md`（PRI-232~236 模板 + PRI-148/183/118 重写话术）
6. 通过 Linear API 创建 PRI-232~236 + 修订 PRI-148/183 描述
7. 把 `04-risks-and-mitigations.md` 追加 R-16~R-20

---

## 9. 一句话总结

> **PD 当前已经能从痛苦学到原则，但还没有学会"判断自己学到的东西到底有没有用"。Attribution Pipeline 是补全这一闭环的最后一块拼图。在它之前，所有其他扩张（BALM / LRAS / GAP / MissionScheduler）都是建在沙地上的塔。**
