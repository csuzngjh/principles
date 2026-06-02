# Principles Disciple — 核心稳定性与架构瘦身集成规划蓝图 (v6.0 Runtime V2-only Retirement)

**文档编号:** PLAN-05  
**归属目录:** `docs/plans/2026-05-roadmap/`  
**核心概念:** 仿真基线先行 (PRI-206) ✕ 契约边界守护 (Anti-growth Guard) ✕ 渐进分批盘点重构  
**作者:** Antigravity (Advanced Agentic Coding Agent)  
**联合评审人:** Wesley (`@RULE[user_global]`) & 交叉把关 AI 助手  
**发布时间:** 2026-05-21  
**修订日期:** 2026-06-02（MVP Track 进度同步）

---

> [!IMPORTANT]
> **ADR-0012 修订**:
> PRI-206 至 PRI-225 已使 Runtime V2 具备 baseline、live validation、repair、integrity 与安全防御证据。旧版蓝图中的 “Frozen Legacy 不得物理删除” 仅适用于替代链路尚未证明的过渡阶段，现已失效。后续 AI 助手必须严格遵循：
> 1.  **捍卫 Core 的无 I/O 边界**: 严格禁止 `file-lock`、`io`、`node-vm-polyfill` 等包含物理 fs、进程与系统绑定的 utils 迁入 core，迁移仅限纯函数（P0-P13 过滤）。
> 2.  **退役而非扩建 Legacy**: 禁止向 `nocturnal-trinity`、`nocturnal-arbiter`、`nocturnal-service`、OpenClaw idle/night scheduling 增加功能；按照 ADR-0012 的 caller cutover -> historical read isolation -> deletion -> test contraction 顺序删除重复执行链。
> 3.  **遵循现有数据架构**: 抛弃在物理磁盘新增 `.pd/evidence/` 目录的提案。将 LLM 损坏的 raw 输出和错误信息，以内联 metadata 形式直接记录到现有的 SQLite 数据库 `runs/runs.metadata` 体系中。
> 4.  **避免过度设计 (YAGNI)**：不新增 Dead Letter Queue schema 变更。优先依靠 UAT 仿真（PRI-209）评估现有的 `recovery sweep` 容错极限。
> 5.  **已完成稳定性基线**：PRI-206、207、208、209、210、216-220、224、225 已完成；新工作不得重复建设这些能力，应以其测试作为退役改造的保护网。

---

## 1. 核心战略：基线先行 ✕ 仿真反馈

Principles Disciple (PD) 目前最致命的泥潭在于**“数据链路太长而缺少真实的使用反馈，无法可观测地确认系统能否运转”**。

因此，我们的首要任务不是修剪代码美感，而是建立一个 **“PD 合成工作负载基线 (Synthetic Workload Baseline)”**。在零真实用户的情况下，以高频、可重复的自动化运行，主动制造从 Pain 到 Internalization 的完整良性运行样本，为整个系统建立起一条“生命线”，从而为后续所有的混沌测试与瘦身重构提供量化的 Canary 验证基础。

---

## 2. 架构红线与全局非目标 (Guardrails & Non-goals)

以下红线具有最高优先级，任何试图绕过或违反这些红线的代码变动都将被视为 Bug：

*   **红线 1：Core 纯净性（无 I/O）**
    `@principles/core` 包内必须保持纯逻辑、纯算法、无副作用。严禁引入任何带 fs、I/O 锁（如 `file-lock.ts`）、虚拟沙箱（如 `node-vm-polyfill.ts`）或网络调用的工具。这类工具必须保留在 `@openclaw-plugin` 或 I/O 边界。
*   **红线 2：Legacy 只能退役，不能生长（ADR-0012）**
    `nocturnal-trinity.ts`、`nocturnal-arbiter.ts`、`nocturnal-service.ts` 与 idle/night 调度属于待删除的重复执行面。严禁新增能力、修补新特性或建立新的 caller；允许在专门的退役 PR 中先切换 caller，再删除文件与 obsolete tests。
*   **红线 3：不随意新增物理存储目录**
    拒绝在磁盘上新增类似 `.pd/evidence/` 这种脱离现有体系的临时存储文件夹。格式修复回路中的 invalid payload 统一落入现有的 runs/artifact 元数据字典，确保数据架构单一规整。
*   **红线 4：不先建 DLQ Schema**
    不随意修改 SQLite 数据库 schema 引入 Dead Letter Queue。应当先最大化利用现有的 `failed`、`retry_wait` 状态与 `recovery sweep` 回收逻辑，仅当混沌仿真证明现有机制不足以承载时，才另开 ADR 讨论 DLQ。

---

## 3. 稳定性与混沌仿真主线 (Stability & Chaos Simulation Line)

在合成工作负载基线（PRI-206）稳固建立后，我们以分层、逐步递进的混沌机制注入异常：

```
                              【 第一步：PRI-206 合成工作负载基线 】
                                                │
                                                ▼
        ┌───────────────────────────────────────┴───────────────────────────────────────┐
        │ 【 第二步：分层异常注入与混沌爆破 】                                            │
        ▼                                       ▼                                       ▼
┌───────────────┐                       ┌───────────────┐                       ┌───────────────┐
│场景 A: 混沌JSON│                       │场景 B: Pain洪水│                       │场景 C: 断链容错│
│(PRI-207)      │                       │(PRI-208)      │                       │(PRI-209)      │
└───────┬───────┘                       └───────┬───────┘                       └───────┬───────┘
        │                                       │                                       │
        └───────────────────────────────────────┼───────────────────────────────────────┘
                                                │
                                                ▼
                                        ┌───────────────┐
                                        │场景 D: 沙箱边界│
                                        │(PRI-210)      │
                                        └───────────────┘
```

### PRI-206：合成 PD 运行基线 (Synthetic Workload Baseline)
*   **任务定义**：在 `scripts/uat/` 下编写端到端运行基线测试。使用 Mock Event 发生器自动且连续生成良性的 Pain 信号，触发 Ingestion Ingress、Diagnostician 解析、Intake Probation、Internalization Orchestrator 直至 Rollout 的全通路运转。
*   **第一生命线**：这是解决“没有真实使用反馈”的核心，是后续所有稳定性任务的 Canary 指标。

### PRI-207：混沌 JSON 注入与两阶段修复 (Chaos JSON Repair)
*   **爆破注入**：在基线上对 `RuntimeAdapter` 注入截断 JSON（如丢失大括号）或带大括号的 Markdown debug 堆栈。
*   **安全防线**：验证 `PRI-200` (Structured output repair loop) 能够在 2 次重试内安全还原数据；若修复耗尽，将 raw payload 以外联 metadata 写入 SQLite 现有 runs.metadata 中，确保无物理磁盘脏文件。

### PRI-208：并发 Pain 洪水与去重预算 (Pain Flood Simulation)
*   **爆破注入**：3 秒内并行生成 100 次工具错误 Pain 信号。
*   **安全防线**：验证 `pain-signal-bridge` 利用 `taskId` 幂等进行去重；验证 `ContextAssembler` 建立的 Token Budget 机制，防止上下文过载或过度激活。

### PRI-209：内化链断裂与恢复评估 (Broken Artifact Recovery)
*   **爆破注入**：强制让 Peer Runner（如 dreamer）生成损坏的 Artifact 产物。
*   **安全防线**：优先验证现有的 `failed` 状态记录、`recovery sweep` 自动回收扫描机制和完整性检查能否在时限内安全把卡死的条目唤醒并妥善隔离，验证当前容错机制的真实上限，暂不作 DLQ 变更。

### PRI-210：沙箱越界修改写拦截 (Out-of-Bounds Write Defense)
*   **爆破注入**：向 Evaluator 的 Proposal 注入包含越界路径（如企图破坏 PD core 物理源码）的自愈操作。
*   **安全防线**：断言 runtime adapter 沙箱能瞬间拦截此越界操作，抛出 Security Boundary 异常，捍卫工作区白名单红线。

---

## 4. Plugin 核心瘦身主线 (Plugin Slimming Line)

瘦身工作必须遵循**“严防死守、渐进盘点”**的逻辑，绝对不对生产逻辑造成破坏。

### 4.1 PRI-211：Plugin 核心资产清点与分类 (Inventory Classification)
*   **执行策略**：**docs-only 任务。绝对不修改一行源码。**
*   **盘点任务**：对 `openclaw-plugin/src/core/` 目录下的 122 个文件进行静态清点，梳理出一份精确的白名单清单，划分出：
    1.  **纯领域逻辑**（无任何 fs, node-vm, OpenClaw API 绑定的纯算法/NLP函数） —— 具备迁移 core 资格。
    2.  **I/O 工具与框架绑定** —— 严禁迁移，扣留在 plugin。
    3.  **Nocturnal 遗留代码 (ADR-0012)** —— 作为 deletion inventory，用于确认 caller、历史读取和待删除测试，不作为长期资产保护。

### 4.2 PRI-212：反反生长架构防线测试 (Anti-growth Guard)
*   **执行策略**：在 PRI-211 盘点报告输出后执行，在 `@principles/core` 回归测试中引入层级 Invariants。
*   **防线用例**：
    1.  `LAYER-1`：断言 `openclaw-plugin/src/core/` 内符合迁移名单的纯领域文件不得导入 `openclaw-sdk` 或引用 `OpenClawPluginApi`。
    2.  `LAYER-2`：断言 `@principles/core` 绝对没有对 `openclaw-plugin` 的反向依赖。
*   **防胖效果**：通过 CI 建立高敏感度的警哨，任何试图向插件塞“肥胖代码”的 PR 将被 CI 直接拒绝。

### 4.3 PRI-213：Plugin 纯工具极低风险抽取 (Pure Utility Extraction)
*   **执行策略**：依据 PRI-211 的白名单，**只抽取 1-3 个最安全的纯工具文件**（例如只做哈希计算、NLP 段落解析的纯算法函数）到 Core 的 `utils/`，并在 plugin 侧保留 `re-export` 别名兼容。
*   **严禁迁移名单**：`file-lock.ts`、`io.ts`、`node-vm-polyfill.ts` 归为强 I/O 绑定，永久保留在 plugin 中，禁止污染 Core！

---

## 5. Issue 启动规则与依赖表 (Issue Activation Rules & Dependency Matrix)

> **交付状态更新 (2026-06-02)**: PRI-200、205-213、215-220、224-225 已完成。Nocturnal 退役（PRI-227~231、PRI-119、PRI-242）已完成。Plugin 瘦身（PRI-288~296）已完成。Feature flag registry（PRI-239）已完成。下表保留历史执行关系作为审计记录；新的 active backlog 以 `02-roadmap.md` 和 `03-linear-sync-plan.md` 的 MVP Track 为准。

| Issue 编号 | 任务标题与性质 | 启动条件 / 依赖项 | 执行方式推荐 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| **PRI-205** | 修订本集成规划蓝图 (Docs-only) | 可立即启动 | Symphony 或手工强 AI | 负责对齐本蓝图，不碰 runtime code |
| **PRI-211** | Plugin 核心资产 Inventory 盘点报告 | 可立即启动 | Symphony | docs-only 静态清点，输出分类报告 |
| **PRI-200** | 结构化 JSON 自愈修复回路 (Runtime) | 进行中，未合并 | 手工派发强 AI | 本期核心前置，合并前**严禁**启动 PRI-207 |
| **PRI-206** | 合成 PD 端到端运行基线测试 (Test) | 可在 PRI-200 稳定阶段启动 | 手工派发强 AI | 整个稳定性管线的第一生命线 ⚡ |
| **PRI-207** | Chaos JSON 混沌修复验证 (Test) | **Blocked by PRI-200** | 手工派发强 AI | 依赖修复回路的稳定契约 |
| **PRI-208** | Pain 洪水去重仿真 (Test) | **Blocked by PRI-206** | 手工派发强 AI | 验证并发幂等与 Token 预算 |
| **PRI-209** | 中断链恢复极限评估 (Test) | **Blocked by PRI-206** | 手工派发强 AI | 评估现有 recovery 极限，暂不加 DLQ |
| **PRI-210** | 越界写沙箱防御 (Test) | **Blocked by PRI-206** | 手工派发强 AI | 验证 Evaluator 提议的沙箱安全边界 |
| **PRI-212** | 反反生长架构守卫测试 (Test) | **Blocked by PRI-211** | 手工或 Symphony | 新增 Anti-growth 架构守卫回归用例 |
| **PRI-213** | 纯工具极低风险抽取 (Refactor) | **Blocked by PRI-211 & PRI-212** | 手工派发强 AI | 只做 1-3 个最安全的纯逻辑工具小步迁移 |

---

## 6. Symphony 与强 AI 助手分工与适用范围 (Agent Responsibility Bounds)

为最大化协作效能并严控运行时质量，我们对 AI 助手的任务边界作出强制性约束：

*   **Symphony 适用范围（中低风险）**
    *   **适合任务**：文档编写/对齐（如 `PRI-205`）、静态文件盘点报告（如 `PRI-211`）、测试用例补强与回归断言编写（如 `PRI-212` 的依赖关系正则扫描断言）。
    *   **限制**：绝对不涉及核心运行时数据流改造，不单独修改 Ingestion 或 Internalization 主干流程代码。
*   **手工派发强 AI 适用范围（高风险核心层）**
    *   **适合任务**：核心修复回路实现（如 `PRI-200`）、端到端合成基线开发（如 `PRI-206`）、沙箱拦截防御（如 `PRI-210`）、以及工具抽取物理重构（如 `PRI-213`）。
    *   **限制**：需要高算力与深度的上下文推演，所有代码修改必须经历严格的人工（wesley）审计，严禁自动 merge。

---

## 7. 成功标准 (Success Criteria)

本期集成规划在各阶段的量化与事实成功标准如下：

1.  **第一阶段 (文档与盘点)**：`PRI-205` 及 `PRI-211` 顺利产出且无一冲突。Plugin 核心的 122 个文件资产图谱梳理完毕，物理与逻辑分类精确到行，`ADR-0005` 完整受护。
2.  **第二阶段 (基线与修复)**：`PRI-206` 合成基线在 CI 中可以 100% 重复跑通并输出标准内化样本；`PRI-200` 结构化修复能在 2 次重试内安全挽回受损的 LLM 输出，失败时 evidence 完美归入 `runs.metadata` 数据库。
3.  **第三阶段 (混沌与防线)**：分层混沌测试用例（A-D）能精准触发异常并全部被安全机制（幂等、去重、沙箱、现有的恢复机制）拦截；CI 回归测试中引入 `LAYER-1`/`LAYER-2` 反肥胖架构哨兵，强力断言插件不会反向依赖 Core。
4.  **第四阶段 (精细瘦身，已完成大部分)**: PRI-213 已完成首批纯算法迁移；Nocturnal 退役（PRI-227~231、PRI-119、PRI-242）已完成；Plugin surface 清理（PRI-288~296）已完成。成功标准：重复 Nocturnal 执行链已删除，OpenClaw idle/night 依赖已取消，测试已收缩（PRI-231）。
