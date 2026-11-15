# PD Principle Context — Unified Context for Adaptive Activation SPEC v1.1

**状态：** Proposed — Owner Decisions Incorporated

**日期：** 2026-11-15

**适用项目：** Principles Disciple (PD)

**目标宿主：** OpenClaw / Codex / WorkBuddy

**版本关系：**

| 项 | 值 |
|---|---|
| 本版本 | v1.1（2026-11-15） |
| 取代 | **v1.0（2026-11-15）已由本版本整体取代（SUPERSEDED）**。v1.0 的区域抽取设计、三宿主同一物理 Workspace 要求、projectFocus 自动注入、`AdaptiveContextInput` 示意协议等设计不再支配实施；被废弃设计的完整清单见 §0.3 |
| 决策依据 | Owner 五项已批准决策 OD-A～OD-E（2026-11-15，见 §14）+ 技术审查报告 `docs/audit/PD_PRINCIPLE_CONTEXT_V1_TECHNICAL_REVIEW_20261115.md`（基线 `origin/main = 23c4c477a`） |
| 源码基线 | `origin/main = 23c4c477a1b0ba52fe329781113a468d1efdd608`。本 SPEC 引用源码一律使用文件路径与符号名，不引用易漂移的行号；调用链与行为的最新逐行证据以技术审查报告为准 |
| 批准边界 | 本版本已并入 Owner 架构决策，**不代表 Owner 已批准开发，也不代表 SPEC 已正式冻结**。进入实施仍需 Owner 对本 v1.1 的最终审阅确认 |

---

# 0. 变更记录与治理版本迁移

## 0.1 v1.0 → v1.1 变更摘要

| 变更 | 内容 | 决策来源 |
|---|---|---|
| D1 | CURRENT_FOCUS 语义转型：整个文件即 Principle Context，删除 `## Principle Context` 区域抽取设计 | OD-A 方案 C |
| D2 | 新增独立外传授权配置 `adaptiveActivation.sendPrincipleContext`（默认 false），未授权时在文件读取之前退出 | OD-B 方案二 |
| D3 | projectFocus 自动注入链整条退役，Principle Context 只供 Adaptive Selector 消费 | OD-C 选项③ |
| D4 | 三宿主统一初始化模板，经由各宿主既有显式初始化流程放置 | OD-D 选项② |
| D5 | 写入治理版本迁移说明：就本能力取代 v0.6 §9/§10 对应的 Deferred 分期，安全不变量全部保留 | OD-E 批准 |
| D6 | 接入位置精确化：`createAdaptivePriorityProvider` 内、`decideAdaptiveSkip` 与全部授权门之后 | 技术审查 §A.3/§I.2 R8 |
| D7 | 数据契约落点修正：扩展真实 Decisions 请求链（`BuildDecisionRequestInput` / `BoundedSelectionInput` / `buildDecisionRequest` / `DecisionRequestEnvelope.state`），删除平行的 `AdaptiveContextInput` 示意协议 | 技术审查 PC-D5 |
| D8 | 载荷预算规则确定化：20,000 字符总预算内超限先完全移除上下文，诊断 `principle_context_dropped:budget` | 技术审查 PC-D3 |
| D9 | 评分契约版本升级 v3-20261112 → v4，同步问题文案与证据代际 | 技术审查 PC-D4 |
| D10 | 旧 Current Focus 处置按技术审查 §H 的真实消费者矩阵修订（含 `/pd-focus compress` 退役） | 技术审查 PC-D7 + OD-C |

## 0.2 治理版本迁移（OD-E，已批准）

Owner 于 2026-11-15 明确要求：

1. Principle Context 进入 Adaptive Activation。
2. 三个宿主必须统一交付。
3. Current Focus 瘦身并转型为 Principle Context。
4. 不再建设独立工作记忆系统。

上述要求就 **Principle Context 这一能力**，取代 Adaptive Activation SPEC v0.6 §9/§10 中对应的 Deferred 分期安排（「多宿主全面适配」「复杂 Working Set、三层上下文维护」中与本能力重叠的部分）。

**这是有明确范围的 supersession，不是废弃 v0.6 全部治理约束。** v0.6 的以下安全不变量继续有效：

- 不覆盖 Owner 手动维护内容。
- 不新增上下文治理权威。
- 不允许跨 Session 状态污染。
- 不绕过现有原则授权与审批。
- 不改变 Runtime V2 治理边界。
- 保留 C01–C09 相关治理纪律。

## 0.3 被废弃设计清单（SUPERSEDED，仅存档，不进入实施）

以下 v1.0 设计已被本版本明确废弃：

| # | 被废弃设计 | 取代者 |
|---|---|---|
| S1 | 在 CURRENT_FOCUS 中维护 `## Principle Context` 专用区域并只提取该区域 | OD-A：整个文件即 Principle Context |
| S2 | 区域抽取 Parser 及其全部边界规则 | OD-A：整文件读取 + 确定性规范化 |
| S3 | 「三个宿主必须将各自的 Workspace 根路径映射为同一个逻辑概念」「不允许三个宿主使用不同路径」的字面语义 | OD-D：统一契约/模板/读取/治理语义，物理 Workspace 沿用各宿主既有解析 |
| S4 | projectFocus summary/full 作为正式注入功能 | OD-C：整条自动注入链退役 |
| S5 | `AdaptiveContextInput` / `PrincipleContext` 平行示意接口 | D7：扩展真实 Decisions state 请求链 |
| S6 | 「上下文外传遵循现有授权边界」的笼统表述 | OD-B：独立 `sendPrincipleContext` 配置授权 |
| S7 | `commands/focus.ts`「评估现有消费者，逐步废弃自动压缩入口」的模糊表述 | OD-C/D10：compress 子命令明确退役，status/history/rollback 保留 |

---

# 1. 背景与设计动机

## 1.1 现状

原 Current Focus 机制最初用于帮助 Agent 维持当前工作状态，后来逐步扩展为：

- Working Memory 提取与恢复
- currentTask 状态管理
- 自动压缩与历史备份
- Session Working Set
- Workspace / Session 隔离
- Compaction 生命周期维护
- 工作记忆 Prompt 注入

复审报告（`docs/audit/PD_ADAPTIVE_ACTIVATION_PHASE1_CURRENT_FOCUS_REAUDIT_20261115.md`）确认：

1. Phase 1 原有八项任务均未完成。
2. 现有 Current Focus 写入路径在生产中被 quiet surface 静音。
3. 读取路径存在自动创建、修复和压缩覆盖 Owner 内容的问题。
4. Codex 和 WorkBuddy 没有对应的 Focus 实现。
5. Current Focus 尚未进入 Adaptive Activation 的上下文输入。

技术审查报告（2026-11-15）进一步确认：

6. 三个宿主的 Workspace 解析是三条刻意不同且已被冻结的设计（OpenClaw agent 级、Codex 用户级/项目级双模、WorkBuddy 全局治理目录）。
7. Adaptive 选择器是三宿主共享的单一实现（`createAdaptivePriorityProvider`），在共享选择路径接入上下文即可让三宿主同时获得该能力，无需三套 Adapter 改造。
8. Decisions 出站路径上不存在按数据类别的授权机制，长期业务背景需要独立的显式授权。

## 1.2 核心问题

原设计把两个不同的问题混在了一起：

A. Agent 如何管理自己的工作记忆？

B. PD 如何理解 Agent 当前所处的工作背景，从而选择合适的原则？

PD 真正需要解决的是 B。

A 属于宿主自身的工作记忆与任务管理能力，不应该由 PD 再建设一套重复系统。

## 1.3 新目标

将 Current Focus **转型**为 Principle Context：同一个物理文件路径，承载完全不同的产品语义。

Principle Context 是一个轻量、可选、只读的上下文输入，为 Adaptive Activation 提供必要的长期工作背景。

它帮助 PD 判断：

- 当前工作涉及什么目标？
- 当前工作有哪些重要约束？
- 哪些原则与当前场景更相关？

它不负责管理 Agent 的任务生命周期，也不产生新的治理权威。

---

# 2. 产品定义

## 2.1 核心定位

Principle Context = Owner 提供的长期工作背景 + 当前宿主已经提供的当前指令。

其中：

**Workspace Context（Principle Context）**

Owner 手动维护的长期背景、目标、战略方向和重要约束。物理载体是既有文件 `<workspace>/memory/okr/CURRENT_FOCUS.md`，产品语义已转型（见 §4）。

**Current Instruction**

当前用户指令，复用现有 Adaptive Activation 的 currentInstruction。

两者共同作为原则选择的上下文。**Current Instruction 是当前任务判断的主要依据；Principle Context 是辅助背景，不是新的指令权威。**

## 2.2 非目标

明确禁止重新建设以下能力：

1. currentTask 自动状态机。
2. 任务进度百分比。
3. 自动任务开始、完成和阻塞识别。
4. Session Working Set。
5. 独立工作记忆数据库。
6. 自动生成工作总结。
7. 自动压缩 CURRENT_FOCUS。
8. 自动恢复或覆盖 CURRENT_FOCUS。
9. 独立 Compaction 维护系统。
10. 新增模型调用用于维护工作记忆。
11. 独立的 Focus Console。
12. 独立的 Focus Feature Flag。
13. 独立的 `PRINCIPLE_CONTEXT.md` 文件。
14. `## Principle Context` 区域抽取 Parser。
15. 跨宿主文件同步机制。
16. 宿主 System Prompt 注入通道（Principle Context 不进入宿主 Prompt，只进入 Adaptive 评分请求）。

这些能力不属于本项目目标。

## 2.3 核心设计原则

- Principle First：所有功能必须服务于原则理解、选择、激活或评估。
- Reuse First：优先复用现有 Adaptive Activation、Host Runtime 和 Workspace 机制。
- No New Authority：不新增原则激活或治理权威。
- No New Memory System：不建设新的持久化工作记忆系统。
- Read Only：自动流程只读取 Owner 上下文。
- Three Hosts, One Capability：三个宿主必须统一实现。
- Fail Open：上下文不可用不得影响 Native Activation。
- No Model Dependency：不需要模型来维护上下文。
- Explicit Authorization：长期背景数据外传必须经 Owner 显式授权，默认关闭。

---

# 3. 产品与技术架构

## 3.1 目标架构

```text
                 OpenClaw（agent 级 workspace）
                    |
                  Codex（用户级/项目级双模 workspace）
                    |
                 WorkBuddy（全局治理 workspace，跨项目共享）
                    |
                    v
          既有宿主 Workspace Resolver（零改动）
                    |
                    v
             Shared Host Runtime
                    |
          +---------+----------+
          |                    |
          v                    v
   Current Instruction   Principle Context（授权门之后只读读取）
          |                    |
          +---------+----------+
                    |
                    v
             Adaptive Selector（共享 Decisions 评分协议）
                    |
                    v
           Candidate Validation（既有治理再验证，不变）
                    |
                    v
               Runtime V2
                    |
                    v
           Principle Activation
                    |
                    v
           Host Prompt Injection（不含 Principle Context 正文）
```

## 3.2 架构边界

三个宿主负责：

- 提供当前工作区标识（沿用既有 Workspace Resolver，零改动）。
- 提供当前指令（沿用既有指令绑定）。
- 将宿主事件映射为统一 Adaptive 输入（既有共享工厂已完成）。

Shared Host Runtime 负责：

- 统一上下文契约。
- 在全部授权门通过后只读读取 Owner 的 Principle Context。
- 确定性规范化与校验上下文。
- 将上下文传递给 Adaptive Selector。

Adaptive Activation 负责：

- 根据当前指令与上下文评估原则适用性。
- 选择已有候选原则。
- 遵循现有授权和验证机制。

Runtime V2 继续负责：

- 原则激活权限。
- 治理边界。
- 原则状态与授权验证。
- 最终激活结果。

Principle Context 无权改变上述治理规则。

## 3.3 明确不新建的对象

不新增 Adapter 专用 Context Provider、不新增 Workspace Resolver、不新增 Context Service、不新增缓存、不新增跨宿主同步机制、不新增公共协议体系。全部能力落在既有共享选择路径上的一个只读读取函数与一个可选请求字段。

---

# 4. Principle Context 数据设计

## 4.1 数据来源与语义（OD-A 方案 C，已批准）

**不新建 `PRINCIPLE_CONTEXT.md`，不新增区域抽取 Parser。**

继续使用现有物理路径：

`<workspace>/memory/okr/CURRENT_FOCUS.md`

但改变它的产品语义：

**CURRENT_FOCUS 不再是工作记忆或任务状态管理文件，而是 Owner 手动维护的 Principle Context。**

它承载：

- 长期目标与战略背景。
- 重要约束与价值取向。
- 当前长期方向。
- 帮助 PD 理解当前任务与原则之间关系的必要背景。

它不承载：

- 任务状态追踪。
- Session Working Set。
- 历史对话自动总结。
- 自动生成的工作记忆。
- 自动压缩的任务列表。
- 自动维护的 currentTask。

**整个文件就是 Principle Context**：文件的全部内容（规范化后）作为上下文进入 Adaptive 评分请求。不再要求 `## Principle Context` 专用区域，不存在"区域不存在则 unavailable"的判定分支。

产品文档统一使用 `Principle Context` 名称；`CURRENT_FOCUS.md` 仅作为兼容文件路径保留。

## 4.2 为什么不采用新文件

新建 `PRINCIPLE_CONTEXT.md` 会增加第二个文件来源和初始化维护对象，没有必要：现有 CURRENT_FOCUS 路径已经能够被三个宿主各自的 Workspace Resolver 定位（同一相对路径规则），保留路径、改变语义是改造成本最低的方案，同时避免 Owner 在两个"背景文件"之间产生维护分歧。

## 4.3 文件读取规则

读取为纯只读（stat + read），整文件读取后进行**确定性规范化**：

- 严格 UTF-8 校验（非法字节序列 → invalid）。
- 去除 UTF-8 BOM。
- CRLF 统一为 LF。
- 去除首尾无意义空白。
- 保留内部 Markdown 标题、段落、列表和换行。
- 不做语义改写。
- 不折叠内部 Markdown 结构。
- 不截断内容。

任何规范化步骤都只作用于**内存中的副本**，原始文件字节永不改变。

## 4.4 内容限制

| 项目 | 限制 |
|---|---:|
| 原始文件 | 最大 64 KiB |
| 规范化上下文 | 最大 4,000 个 JavaScript UTF-16 code units |
| 超限行为 | invalid，不截断、不发送 |
| 内容格式 | 纯文本 / Markdown |
| 更新方式 | Owner 手动维护 |
| 读取方式 | 只读 |
| 缓存 | 不新增持久缓存（每轮至多一次读取） |

**空文件或纯空白内容视为 missing。**

## 4.5 兼容性（对存量文件零动作）

保留现有物理路径，避免迁移。现有文件不得自动清理、改写、覆盖或迁移。对于包含历史任务、工作记忆的旧文件：

- 不自动删除历史内容。
- 不自动压缩。
- 不自动生成新文件。
- 不自动将历史内容转换成战略背景。
- 由 Owner 自行整理成新的 Principle Context。

在 Owner 尚未整理完成前，可以保持发送授权（`sendPrincipleContext`）关闭——此时系统行为与今天完全一致（零读取、零发送）。

初始化模板仅影响**新建** workspace（见 §7.5）；对已存在的文件绝不覆盖。

## 4.6 信任边界

Principle Context 是业务背景数据，不是治理指令。

即使其中包含类似以下内容：

- 忽略其他规则；
- 绕过审批；
- 自动激活某项原则；
- 改变系统权限；

也不能改变 PD 的系统指令、原则授权或 Runtime V2 的决策。

它只能帮助 Selector 理解上下文，不能改变可选原则集合和权限边界。上下文正文永不进入注入给宿主的 Prompt，只进入 Adaptive 评分请求的 state 字段（见 §5、§6）。

---

# 5. Adaptive Activation 集成

## 5.1 真实接入位置

**不增加 Adapter 专用 Context Provider、不增加 Workspace Resolver、不增加 Context Service。**

复用现有共享工厂 `createAdaptivePriorityProvider`（`packages/host-runtime/src/adaptive-priority-provider.ts`），在以下顺序中接入：

```text
decideAdaptiveSkip（既有确定性跳过门，零发送）
        |
        v
授权检查（sendPrincipleContext + 全部既有 flag/config/凭据门）
        |
        v
读取 Principle Context（唯一新增 I/O：stat + read，≤64 KiB）
        |
        v
runAdaptiveSelection（既有）
```

约束：

1. 读取放在确定性 skip 门和**全部授权门之后**——任何门不通过都在文件读取之前退出（§6.2）。
2. 三个宿主共享同一读取与规范化实现（落点在 host-runtime，与选择器同包）。
3. 运行时 Adapter 无需重复建设三套逻辑；三宿主 Adapter 层零改动，各自沿用既有 workspaceDir 语义。
4. 读取失败或上下文不可用只降级上下文本身，不阻塞选择，不影响 Native 路径。

## 5.2 Decisions 协议扩展

以真实实现为准，**不保留 v1.0 的 `AdaptiveContextInput` 平行示意协议**。扩展链路：

- `BuildDecisionRequestInput` 增加可选输入 `principleContext`（已规范化、已限长的字符串）。
- `BoundedSelectionInput.payload` 增加同名字段。
- `buildDecisionRequest` 将该字段并入 `DecisionRequestEnvelope.state` 的 JSON 快照。

约束：

- 不修改外部 Decisions API 形状（信封仍为 `{model, state, questions, provider?}`；变化仅在本地构造的 `state` JSON 内多一个可选字段）。
- 不增加额外模型调用。
- 不增加重试。
- 不改变现有候选集合。

## 5.3 载荷预算（硬约束）

必须明确以下现有硬约束：

| 项目 | 限制 |
|---|---:|
| Decisions 总 payload（`{state, questions}` 序列化后） | 20,000 字符 |
| currentInstruction | 6,000 字符 |
| Principle Context（规范化后） | 4,000 字符 |
| 原始文件 | 64 KiB |

预算处理规则（确定性顺序，不得留给实现自由发挥）：

1. 首先尝试构建带上下文的请求。
2. 如果总 payload 超过 20,000 字符，**优先完全移除 Principle Context**。
3. 不允许截断 Current Instruction。
4. 不允许为了保留上下文而削减候选原则。
5. 移除上下文后重新构建请求。
6. 如果原有内容（指令+候选）仍然超限，继续沿用原有 `INPUT_REFUSED` 机制（整轮选择不可用，走 Native）。

诊断：`principle_context_dropped:budget`。只能记录状态和原因，**不能记录上下文正文**（沿既有 rc-8 有界序列化纪律）。

## 5.4 评分契约版本（Criteria v4）

原有评分契约版本 `v3-20261112` 在增加 Principle Context 后必须升级至 **v4 新证据代际**。同步修改：

- Criteria 版本标识（`ADAPTIVE_DECISION_CRITERIA.version`）。
- 评分问题文案：候选适用性问题与 `insufficient_context` 问题的判断依据从"依据 currentInstruction"扩展为"依据 currentInstruction（结合可用的 principleContext 背景）"；文案必须保持"Current Instruction 是当前任务判断的主要依据，Principle Context 是辅助背景"的语义。
- 请求快照测试。
- Selector Lab 对照实验（PRI-1182 纪律：预算内对照新旧文案的分数稳定性）。
- 相关证据记录（新代际与 v3 代际的评分证据必须可区分）。

评分语义必须明确：

- Current Instruction 是当前任务判断的主要依据。
- Principle Context 是辅助背景，**不是新的指令权威**。
- 上下文不能要求模型绕过治理规则。

## 5.5 治理边界（原样保留，零削弱）

必须原样保留现有全部治理机制：

- 授权候选原则集合（候选唯一来源 = Runtime V2 当前有效激活读）。
- Candidate Reference 白名单（模型只能返回对固定问题 ID 的分数，未知 ref 拒绝）。
- Decision Response 校验（模型/provider 身份、问题集完整性、分数范围）。
- Adaptive Principle Revalidation（返回边界逐字段复核 principleId / artifactContentSha256 / text / authority / approvedBy）。
- Authority 校验（装配层 authority 漂移拒绝）。
- Runtime V2 审批和授权边界。

Principle Context 只能改变**已授权候选原则之间的相关性评分**。

不能：

- 创建候选原则。
- 激活未授权原则。
- 修改审批状态。
- 修改 RuleCode。
- 修改治理权威。
- 绕过 Budget Policy。
- 直接写入 Runtime V2。

## 5.6 Native Fallback

当 Principle Context：

- 文件不存在（missing）；
- 内容为空或纯空白（missing）；
- 编码非法或超限（invalid）；
- 读取失败（unreadable）；
- 未获授权（不读取）；
- 载荷预算溢出被移除；

均不应导致 Adaptive Activation 失败。

Selector 回到现有 currentInstruction + candidates 路径（请求形状与无上下文时一致，仅缺少该可选字段）。

Native Activation 继续正常工作。

## 5.7 选择逻辑与重要限制

原则选择时使用：Current Instruction（主要依据）+ Principle Context（辅助背景）+ 既有候选原则集合 → 既有 Adaptive Selection → 既有 Candidate Validation → 既有 Runtime V2。

Principle Context：

1. 不允许增加候选原则。
2. 不允许激活未批准原则。
3. 不允许改变原则授权状态。
4. 不允许绕过 RuleCode 验证。
5. 不允许直接修改 Runtime V2 状态。
6. 不允许替代现有 Native Selector。
7. 不允许成为额外的模型决策步骤。
8. 不允许进入宿主 System Prompt。

## 5.8 模型调用

不新增模型调用。

当前 Adaptive 决策路径为模型辅助的 Decisions 单次评分请求；Principle Context 作为该既有请求 state 内的可选字段传输。

不新增请求次数、不新增重试、不新增上下文总结调用、不新增模型配置。上下文的加入仅增加既有单次请求的出站字节数（§5.3 预算内）与少量推理 token（4,000 code units 量级），并在既有首字节截止与宿主预算窗内消化。

---

# 6. 数据授权与隐私

## 6.1 独立的外传授权（OD-B 方案二，已批准）

在现有 `adaptiveActivation` 配置中增加：

`sendPrincipleContext`

默认值：**false**。

这是**普通配置项，不是 Feature Flag**：

- 它不进入 feature-flag SSoT/契约清单，不占用「新 Feature Flag = 0」的复杂度预算。
- 它是 `adaptiveActivation` 配置节白名单的一个新键（该节为封闭白名单，未知键会导致配置错误——实现必须同步扩展白名单与校验规则：布尔型、默认 false、非法值产生可操作的配置错误信息）。
- 它的生命周期治理（命名、默认值、废弃）在配置契约文档中维护。

## 6.2 授权规则

只有**同时**满足以下条件，才允许读取和发送 Principle Context：

1. 当前宿主 Adaptive Activation Flag 已开启（`host.<host>.adaptive_activation`，quiet，默认关）。
2. Adaptive 配置有效（`adaptiveActivation` 节通过校验）。
3. Decisions Provider 已正确配置（endpoint/model/apiKeyEnv + 凭据可解析）。
4. `sendPrincipleContext: true`。

只要其中任一条件不满足：

- **不读取文件。**
- **不 stat 文件。**
- 不发送上下文。
- 不增加模型请求。
- 按原有无上下文 Adaptive 路径执行。

**特别强调：上下文未获授权时，必须在文件读取之前就退出，而不是先读取再决定不发送。** 授权检查在 `decideAdaptiveSkip` 之后、文件读取之前执行（§5.1 顺序）；其中条件 1–3 由既有的 provider 就绪解析承担（不满足时 provider 根本不创建），条件 4 是新增的显式前置门。

不能将当轮用户指令的既有授权自动解释为长期背景数据的授权——两者是不同敏感级别的数据类别，前者随轮次产生，后者是 Owner 持久维护的业务背景。

## 6.3 数据传输说明（必须随实现交付）

配置为 `true` 表示 Owner 明确允许将当前 Workspace 的 Principle Context 发送到已配置的 Decisions Provider。

配置文档、配置字段说明和隐私说明必须明确：

- **发送的数据是什么**：当前 workspace 的 Principle Context 文件规范化内容（≤4,000 code units）。
- **发送给谁**：`adaptiveActivation.endpoint` 指向的已配置 Decisions Provider（单端点、无回退）。
- **默认不发送**：`sendPrincipleContext` 默认 false；三个宿主 Adaptive flag 默认关。
- **如何关闭**：将 `sendPrincipleContext` 置回 false（或关闭对应宿主的 adaptive flag）；关闭后下一轮起零读取、零发送。

## 6.4 日志与遥测纪律

上下文正文不得进入：

- 普通应用日志。
- Telemetry。
- Trace。
- Decisions 请求日志。
- 错误报告。

诊断与 journal 只允许记录状态、原因与限长原因码（如 `principle_context_dropped:budget`、availability 四态），沿既有 rc-8 有界序列化纪律。既有 Adaptive 诊断面"ids only, never prompt text"的约束对上下文字段同等适用。

上下文不写入任何持久化存储；读取动作本身零写入（原始文件 SHA-256 前后不变是验收断言）。

---

# 7. 三宿主统一实施要求

## 7.1 统一原则

必须满足：

**One Contract, One Semantics, Three Adapters（统一的是契约、模板、读取逻辑和治理语义，不是物理 Workspace）。**

禁止为 OpenClaw 建设一套完整能力，再将 Codex 和 WorkBuddy 留作后续事项。

## 7.2 宿主职责

| 能力 | OpenClaw | Codex | WorkBuddy |
|---|---|---|---|
| Workspace 定位 | 既有 Resolver（零改动） | 既有 Resolver（零改动） | 既有 Resolver（零改动） |
| Current Instruction | 既有绑定（零改动） | 既有绑定（零改动） | 既有绑定（零改动） |
| Principle Context 契约 | Shared | Shared | Shared |
| 授权检查与读取规范化 | Shared | Shared | Shared |
| Decisions 协议与预算 | Shared | Shared | Shared |
| Criteria v4 问题文案 | Shared | Shared | Shared |
| 降级行为 | Shared | Shared | Shared |
| Runtime V2 | Shared | Shared | Shared |

三宿主 Adapter 层零改动：上下文读取落在共享选择路径，各宿主自动继承（技术审查 §A.3 实证）。

## 7.3 Workspace 语义（各宿主既有冻结规则，逐宿主明示）

统一的是文件契约（同名相对路径 + 同一读取/规范化/授权/降级语义），**不是物理 Workspace**。三个宿主的文件位置遵循既有 Workspace 解析规则，且必须在 SPEC 与交付文档中明确写出：

- **OpenClaw：Agent 级上下文。** workspaceDir 来自 OpenClaw 插件上下文的 agent workspace；上下文按 agent workspace 隔离。
- **Codex：沿用既有用户级/项目级双模语义。** 用户级 workspace（`$CODEX_HOME/pd-workspace`）已初始化时全局胜出，否则按 nearest-`.pd` 项目级解析；两种模式分别验证（§11）。
- **WorkBuddy：全局治理上下文，跨项目共享。** 沿用既有全局治理 Workspace（用户级治理目录）解析；其上下文语义是跨项目共享的——这是该宿主治理模型的既定冻结设计（P06/OD-07），本 SPEC 显式采纳该语义，并要求在交付文档中向 Owner 明示"WorkBuddy 的 Principle Context 对全部项目可见"。

不允许：

- OpenClaw 使用一种文件格式、Codex 使用另一种、WorkBuddy 使用独立数据库。
- 用某个宿主的路径代替另一宿主的解析结果。
- 新建跨宿主文件同步机制。

## 7.4 三宿主文件契约

所有宿主对同一相对路径 `<workspace>/memory/okr/CURRENT_FOCUS.md` 应用：

1. 相同的授权前置门（§6.2）。
2. 相同的只读读取方式（stat + read）。
3. 相同的确定性规范化规则（§4.3）。
4. 相同的四态判定（available / missing / invalid / unreadable）。
5. 相同的限制（64 KiB / 4,000 code units）。
6. 相同的降级语义（§5.6）。
7. 相同的传输授权语义（§6）。

## 7.5 统一初始化模板（OD-D 选项②，已批准）

**不接受 OpenClaw 有模板而 Codex、WorkBuddy 长期没有模板的交付方式。三个宿主必须拥有相同的 Principle Context 初始化模板。**

模板内容统一为：

```markdown
# Principle Context

## Long-term Background

## Important Constraints

## Current Direction
```

模板只提供轻量结构，不包含自动任务管理、Session 状态或自动维护规则。

### 初始化规则

在各宿主**现有的显式 Workspace 初始化流程**中放置模板：

- OpenClaw：使用现有 Workspace 初始化机制（其 okr 模板集内的 CURRENT_FOCUS 模板更新为上述统一内容；仅影响新初始化）。
- Codex：沿用现有用户级或项目级 Workspace 解析和初始化机制，加入同一模板的同等放置。
- WorkBuddy：沿用现有全局治理 Workspace 初始化机制，加入同一模板的同等放置。

约束：

1. 仅在显式初始化时创建。
2. 文件不存在时才创建。
3. 文件存在时绝不覆盖。
4. 不在普通运行时自动创建。
5. 不创建跨宿主同步机制。
6. 不增加新的后台服务。
7. 不增加新的命令或独立初始化子系统。

### 语义备忘

三宿主的"统一"是：文件契约、模板、读取逻辑、授权规则、降级语义、治理语义。物理 Workspace 与上下文的可见范围按 §7.3 的宿主语义各自成立——这不违反统一交付：验收（§11）要求的是"同样结构的文件在各自 workspace 中产生一致的规范化结果"，不是"三个宿主读同一个物理目录"。

---

# 8. 旧 Current Focus 机制退出（按真实消费者矩阵修订）

> 依据：技术审查报告 §H 的全仓消费者清查（生产导入、测试 mock、CLI 注册、文档引用逐一核对）。**不能简单删除整个 focus-history 模块；不得将仍有生产消费者的历史备份能力误判为死代码。**

## 8.1 能力级处置表

| 原有能力 | v1.1 决策 |
|---|---|
| prompt 读取时自动恢复模板（`safeReadCurrentFocus` 的 recoverFromTemplate 分支） | **退役** |
| prompt 读取时自动压缩（`autoCompressFocus`） | **退役** |
| compaction 自动提取和写入工作记忆（`extractAndSaveWorkingMemory`） | **退役** |
| projectFocus summary/full 自动注入宿主 Prompt | **退役**（见 §9.2） |
| `/pd-focus status` | **保留**（只读状态能力） |
| `/pd-focus history` | **保留**（已有历史记录查看能力） |
| `/pd-focus rollback` | **保留**（显式 Owner 恢复能力） |
| `/pd-focus compress` | **退役**，不再压缩 Principle Context |
| `/pd-init` | **保留现有入口**，更新战略背景维护语义（见 §8.4） |

## 8.2 历史备份与恢复

- 保留已有 `.history/` 兼容读取能力（`getHistoryVersions` / `backupToHistory` / `cleanupHistory` 仍有真实生产消费者：rollback 与历史查看）。
- 不删除 Owner 历史备份。
- rollback 只能由 Owner 显式执行。
- 不新建自动快照系统。
- 不因保留历史恢复功能而恢复自动压缩。

## 8.3 文件级处置清单（以技术审查 §H.2 为依据）

| 模块 | 处置 | 关键点 |
|---|---|---|
| `openclaw-plugin/src/core/focus-history.ts` | **拆分保留** | 保留 `backupToHistory` / `cleanupHistory` / `getHistoryVersions` / `archiveMilestonesToDaily`（有真实消费者）；`safeReadCurrentFocus` / `autoCompressFocus` / `recoverFromTemplate` 退出 prompt 路径（随 §8.1 退役项）；清除无生产消费者的死导出（`compressFocus`、`needsAutoCompression`）；架构回归测试钉死的"纯函数必须留在 core"约束继续生效 |
| `principles-core/src/prompt-builder/focus-compression.ts` | **收缩保留** | 纯函数层不动文件；随退役项移除失去消费者的函数（含死字段 `currentTask`）；保留仍被注入/命令消费的函数；"零 infrastructure imports"架构守卫继续生效 |
| `openclaw-plugin/src/hooks/lifecycle.ts` | **退役写路径** | `extractAndSaveWorkingMemory` 整体退役；`handleBeforeCompaction` 收缩为纯 checkpoint 或维持 quiet 现状；同时消除 `sessionFile` 的 `as` 断言（未验证运行时数据） |
| `openclaw-plugin/src/hooks/prompt.ts` | **删除读路径副作用与注入段** | 删除 `safeReadCurrentFocus` / `autoCompressFocus` 两个调用点；删除 projectFocus 注入段（summary/full/working-memory，§9.2）；Focus 段残余只读消费一并移除；整段涉及代码从 prompt 路径消失 |
| `openclaw-plugin/src/commands/focus.ts` | **保留 + 收敛** | status/history/rollback 保留；compress 子命令退役（命令入口移除，帮助文案同步）；其本地第二套压缩实现随 compress 一并移除（不留死代码） |
| `openclaw-plugin/src/commands/strategy.ts` | **保留 + 语义更新** | 实际注册名 `/pd-init`（别名 `/pdi`）——见 §8.4 |
| `plugin-surface-registry.ts` | **维持现状** | 不开启 quiet surface，不改变既有治理策略；Focus 写行为退役后 registry 无需新条目 |
| Adaptive Selector | **增加轻量上下文输入** | 见 §5 |
| 官网与架构文档 | **同步修订** | 官网 slash-commands 文档中"PD 在后台自动压缩 CURRENT_FOCUS.md"的表述随退役删除；`docs/architecture/DATA_ARCHITECTURE.md` 中 CURRENT_FOCUS 路径描述勘误为 `memory/okr/CURRENT_FOCUS.md` 并更新语义 |

删除代码之前必须检查所有真实调用者，不能只凭文件名称决定删除。

## 8.4 `/pd-init` 语义更新

将原来围绕 CURRENT_FOCUS 工作记忆和任务状态的引导，改为帮助 Owner 整理 Principle Context：

- 引导内容聚焦：长期背景 / 重要约束 / 当前方向（对应统一模板的三节）。
- 不能让 Agent 在后台自动覆盖 Owner 文件——Agent 只能经 Owner 显式确认后编辑，且必须遵守现有文件保护约束（存在即不覆盖、写入前备份语义沿用既有命令规范）。
- 对存量旧文件，引导 Owner 自行整理（不自动迁移、不自动删除历史内容）。

## 8.5 测试契约同步

- 原有把"压缩后行数减少"钉为预期行为的测试（PRI-82 系列）必须按新契约重写——这是行为契约变更，须在 PR 中显式声明、Owner 可见；不删测试、只改断言目标。
- 原以 vi.mock 方式屏蔽 focus 模块的 prompt 测试，随注入段退役一并收敛。
- 新增装配级测试钉死"prompt 路径零 Focus 写副作用"（见 §11）。

## 8.6 明确禁止（不实施 Reaudit 整改方案中被取代的部分）

不实施原 Reaudit SPEC 的以下设计（与本 SPEC 无关或已被 OD 决策取代）：

- focus-extractor 独立子系统。
- focus-maintainer 独立子系统。
- Session Working Set。
- 自动任务状态机。
- marker 区间自动维护系统。
- O_EXCL 锁和 revision CAS 工作记忆管理。
- workspaceFocusMaintenance Feature Flag。
- before_prompt_build 自动维护段。
- 新的 Compaction 事件依赖。

# 9. 配置与兼容性

## 9.1 新配置：`adaptiveActivation.sendPrincipleContext`

| 项 | 值 |
|---|---|
| 归属配置节 | `adaptiveActivation`（既有封闭白名单节） |
| 类型 | boolean |
| 默认值 | false |
| 性质 | 普通配置项（非 Feature Flag） |
| 校验 | 加入白名单 + 布尔校验；非法值产生可操作的配置错误 |
| 语义 | 见 §6 |

## 9.2 旧配置：`projectFocus` 退役（OD-C 选项③，已批准）

**projectFocus 的 summary/full 自动注入行为整条退役。** Principle Context 只供 Adaptive Selector 使用，不再通过 OpenClaw Prompt Hook 将 CURRENT_FOCUS 作为工作记忆注入宿主。

必须退役：

- projectFocus 的 summary/full 自动注入行为。
- prompt hook 中的 Focus 自动读取与注入段。
- 与旧工作记忆注入直接相关的运行时逻辑。

不得形成双消费：

```text
（禁止）
CURRENT_FOCUS ──┬── Adaptive Selector
                └── Host System Prompt

（唯一允许）
CURRENT_FOCUS → 只读 Principle Context → Adaptive Selector → 既有候选评分与治理验证
```

### 兼容处理

考虑已有 `.pd/config.yaml` 可能存在 `projectFocus`：

- 兼容期保留必要的旧配置解析能力（类型/枚举校验不删除，配置文件加载不得失败）。
- 旧值不再产生任何读取或注入行为。
- 在配置类型与文档中标记 deprecated。
- 可使用现有配置诊断/告警机制提示废弃信息（有则用，不新建诊断系统）。
- 不增加新的持久状态或迁移系统。
- 不允许旧配置导致配置文件加载失败。
- 后续彻底删除兼容字段可在独立版本中处理。

## 9.3 文件迁移

不需要数据库迁移。不需要自动改写 CURRENT_FOCUS。存量文件由 Owner 自行整理为 Principle Context（§4.5）；未整理期间保持 `sendPrincipleContext` 关闭即可，系统行为与今天完全一致。

---

# 10. 实施阶段

## Batch 1：Current Focus 旧机制退出

目标：消除破坏性读写和旧工作记忆自动维护。

包括：

- 退役自动恢复（prompt 读取路径的模板创建/覆盖）。
- 退役自动压缩（读路径 `autoCompressFocus`）。
- 退役 compaction 工作记忆写入（`extractAndSaveWorkingMemory`）。
- 退役 projectFocus 自动注入（prompt hook 读取与注入段）。
- 收敛旧 Focus 命令（compress 退役；status/history/rollback 保留）。
- 清理无生产消费者的代码（死导出与失活纯函数）。
- 同步官网文档（自动压缩表述删除）与架构文档（路径/语义勘误）。
- 修订 PRI-82 相关测试契约（行为契约变更，PR 显式声明）。

这一批**不依赖 Principle Context 新功能**，可独立实施与验收。

Gate 1：

- Reader 纯读：prompt 路径零 Focus 写副作用（装配级测试断言）。
- 原文件 SHA-256 不变。
- 读取失败时原则注入仍正常。
- 不新增自动写入行为。
- `/pd-focus status|history|rollback` 与 `.history/` 读取正常。
- 旧配置含 `projectFocus` 时配置加载不失败。

## Batch 2：Principle Context 接入

目标：共享只读读取、显式授权和 Adaptive 集成。

包括：

- 现有 CURRENT_FOCUS 整文件读取（共享实现，host-runtime）。
- 统一规范化（§4.3）。
- `sendPrincipleContext` 授权（白名单扩展 + 校验 + 读取前置门）。
- 共享 Provider 接线（`createAdaptivePriorityProvider` 内 skip 门后）。
- Decisions payload 扩展（state 可选字段 + 预算保护规则 §5.3）。
- Criteria v4（版本、问题文案、快照测试、Lab 对照）。

不得新增独立子系统。

Gate 2：

- 同一 fixture 文件经共享实现产生字节级一致的规范化结果。
- 授权关闭时零 stat、零 read（非"读了不发"）。
- 预算溢出先移除上下文，指令与候选请求不受影响。
- flag/config 未就绪时 provider 不创建、行为与今天一致。

## Batch 3：三宿主统一交付

目标：初始化模板和真实集成验收。

包括：

- 三宿主统一初始化模板（§7.5），经既有初始化流程放置。
- 既有初始化路径接入（OpenClaw workspace-init；Codex 用户级/项目级初始化；WorkBuddy 全局治理 workspace 初始化）。
- 三宿主真实 Adapter 集成测试（§11，非仅 Shared Runtime 单测）。
- 安全与隔离测试（各宿主 Workspace 隔离语义逐宿主验证；WorkBuddy 跨项目共享语义显式验证；Codex 双模分别验证）。

Gate 3：

- §11 矩阵三宿主全部通过；任一宿主失败不得以另外两个宿主的结果代替。

## Batch 4：价值验证

目标：证明 Principle Context 是否提高原则激活质量。

对照（固定候选原则集合、授权范围和治理约束）：

- A：Current Instruction only。
- B：Current Instruction + Principle Context。

评估：

- 原则选择相关性。
- 错误激活率。
- 遗漏率。
- 三宿主一致性。
- 响应延迟。
- Token 成本。
- 外部数据传输范围。

Gate 4：

有可重复的正向价值证据。**如果没有可重复的正向价值证据，允许放弃 Principle Context 的 Adaptive 接入，保留 Batch 1 的旧机制清理成果**（Batch 1 是独立成立的缺陷修复）。

---

# 11. 验收测试矩阵

> 测试使用相同 fixture 内容，放置在各宿主各自解析得到的 Workspace 中，**不要求三个宿主使用相同物理目录**。全部断言必须落在真实 Host Adapter 集成测试上，不允许仅凭 Shared Runtime 单测宣布完成。

| # | 测试场景 | OpenClaw | Codex | WorkBuddy |
|---|---|---|---|---|
| 1 | 三宿主读取同样结构的 Principle Context | 必须通过 | 必须通过 | 必须通过 |
| 2 | 相同输入得到相同规范化结果（字节级一致） | 必须通过 | 必须通过 | 必须通过 |
| 3 | 三宿主分别遵循各自 Workspace 隔离语义 | 必须通过 | 必须通过 | 必须通过 |
| 4 | WorkBuddy 跨项目共享语义明确验证（跨项目同源上下文） | 不适用 | 不适用 | 必须通过 |
| 5 | Codex 用户级/项目级模式分别验证 | 不适用 | 必须通过（双模各一） | 不适用 |
| 6 | 文件不存在时为 missing（且零写入） | 必须通过 | 必须通过 | 必须通过 |
| 7 | 文件超限或编码错误时为 invalid（不截断、不发送） | 必须通过 | 必须通过 | 必须通过 |
| 8 | 读取失败时为 unreadable（选择与 Native 不受影响） | 必须通过 | 必须通过 | 必须通过 |
| 9 | 未授权时零 stat、零 read（读取之前退出） | 必须通过 | 必须通过 | 必须通过 |
| 10 | Adaptive Flag OFF 时零文件读取 | 必须通过 | 必须通过 | 必须通过 |
| 11 | 载荷超限时优先完全移除上下文（诊断 `principle_context_dropped:budget`，指令/候选请求不变） | 必须通过 | 必须通过 | 必须通过 |
| 12 | 不增加模型调用（每轮 sends ≤ 1） | 必须通过 | 必须通过 | 必须通过 |
| 13 | 不向普通日志和 Journal 写入上下文正文 | 必须通过 | 必须通过 | 必须通过 |
| 14 | 上下文不能扩大候选集合（含注入式上下文反例：候选集与授权判定不变） | 必须通过 | 必须通过 | 必须通过 |
| 15 | Owner 原始文件 SHA-256 前后不变 | 必须通过 | 必须通过 | 必须通过 |

补充断言：

- 上下文进入 Decisions state 的形状有请求快照测试（criteria v4）。
- 空文件/纯空白 → missing。
- 初始化模板仅新建时创建、已存在绝不覆盖（三宿主各自的初始化路径各验一条）。
- 旧配置含 `projectFocus` 的兼容行为（加载成功、零行为、可诊断）。
- Native Fallback：上下文缺失/非法/未授权/超限时，选择请求形状与无上下文时一致（仅缺可选字段），Native 激活不受影响。
- Runtime V2 治理边界不变（候选来源、ref 白名单、响应校验、返回边界再验证、装配层 authority 校验全部保持既有测试通过）。
- 任何一个宿主失败，不得通过另外两个宿主的测试代替。

---

# 12. 性能与复杂度预算

本项目的一个核心目标是减少历史架构复杂度。

## 12.1 复杂度预算（不可突破）

| 指标 | 目标 |
|---|---:|
| 新数据库 | 0 |
| 新数据库表 | 0 |
| 新持久化状态 | 0 |
| 新 Session 管理系统 | 0 |
| 新模型调用 | 0 |
| 新 Feature Flag | 0 |
| 新独立子系统 | 0 |
| 新 Workspace Resolver | 0 |
| 新 Context Service | 0 |
| 新缓存系统 | 0 |
| 新跨宿主同步机制 | 0 |
| 新治理权威 | 0 |
| 新公共协议体系 | 0 |
| 新宿主生命周期依赖 | 0 |
| 新工作记忆维护系统 | 0 |

允许（全部列入预算内的最小集）：

- 一个配置项 `adaptiveActivation.sendPrincipleContext`（普通配置项，非 flag）。
- 一个 Decisions state 可选字段 `principleContext`。
- 共享路径上的只读文件读取（每轮至多一次，≤64 KiB）。
- 必要的私有规范化辅助函数（host-runtime 内，与选择器同包，不成公共抽象）。
- 既有初始化流程增加模板放置（三宿主，create-only-if-missing）。

不得把这些改造扩展成工作记忆系统。

## 12.2 性能要求

- 单次上下文读取有严格字节上限（64 KiB 原始 / 4,000 code units 上下文 / 20,000 字符总载荷）。
- 不扫描完整 Session 历史。
- 不进行后台自动维护。
- 不新增周期性任务。
- 不增加模型请求次数。
- 上下文读取失败不影响 Native Activation。
- 未授权/flag 关闭时，上下文路径完全静止（零 stat、零 read、零发送）。

# 13. 风险与回滚

| 风险 | 处理方式 |
|---|---|
| Owner 尚未整理的旧文件混有历史任务内容 | 语义转型 + Owner 自行整理；整理前保持 `sendPrincipleContext` 关闭即零暴露 |
| 上下文误导原则选择 | Current Instruction 主要依据 + 评分语义明示（§5.4）+ 候选白名单与本地裁决不变 + Batch 4 允许放弃 |
| 数据外传扩大 | 独立授权 `sendPrincipleContext` 默认 false；未授权在读取之前退出；传输说明随配置交付 |
| 上下文注入式内容操纵评分 | 只能在已授权候选集内改变相关性评分；ref 白名单 + 返回边界再验证 + 装配层 authority 校验不变；负例测试（§11 #14） |
| WorkBuddy 跨项目共享被误解为泄漏 | §7.3 明示其全局治理语义为冻结设计；交付文档向 Owner 明示可见范围 |
| Codex 双模解析差异 | 双模分别验证（§11 #5）；模板放置跟随各自解析结果 |
| 旧功能退役产生兼容问题 | 按真实消费者清单分批退役（§8）；旧配置兼容期不阻断加载（§9.2）；先查调用者，不凭文件名删除 |
| 上下文读取失败 | availability 四态 + fail-open 回退现有 Selector |
| 载荷预算冲突 | 确定性规则：先移除上下文，再走既有 INPUT_REFUSED（§5.3） |
| 评分代际混乱 | criteria v4 版本标识 + 证据记录区分新旧代际（§5.4） |

回滚策略：

1. Adaptive 接入回滚：`sendPrincipleContext` 置 false（或关闭宿主 adaptive flag）——下一轮起零读取、零发送、请求形状回到无上下文形态。
2. 接入代码回滚：revert Batch 2 变更集；criteria 版本回退（v4 标识移除即回 v3 代际请求形状）。
3. Batch 1 回滚：单变更集 revert；无持久状态变更；`.history/` 与 Owner 文件全程未动。
4. 不需要数据库回滚（零新存储）。
5. 不需要恢复被自动修改的 Workspace 文件——本方案全生命周期禁止自动修改。
6. 不需要恢复 Session 状态（零 Session 维度）。

# 14. Owner Decision 记录

## 14.1 本次五项已批准决策（2026-11-15，不再开放讨论）

| ID | 决策事项 | 已批准方案 | 落点 |
|---|---|---|---|
| **OD-A** | Current Focus 转型为 Principle Context | **方案 C**：沿用 `CURRENT_FOCUS.md` 路径、整个文件即上下文、不新建文件、不建区域 Parser | §4 |
| **OD-B** | 独立的上下文外传授权 | **方案二**：`adaptiveActivation.sendPrincipleContext`，默认 false，读取之前退出 | §6、§9.1 |
| **OD-C** | projectFocus 自动注入链 | **选项③**：彻底退役，Principle Context 只供 Adaptive Selector；旧配置兼容期保留解析 | §9.2、§8.1 |
| **OD-D** | 三宿主初始化模板 | **选项②**：三宿主统一模板，经既有显式初始化流程放置，create-only-if-missing | §7.5 |
| **OD-E** | 治理基准 supersession | **批准**：就本能力取代 v0.6 §9/§10 对应 Deferred 分期；安全不变量全保留 | §0.2 |

## 14.2 v1.0 决策表的最终处置对照

| v1.0 ID | 决策事项 | v1.1 处置 |
|---|---|---|
| OD-01 | 产品名称 | 维持：Principle Context |
| OD-02 | 治理基准 | 维持 v0.6 为治理基准 + 按 OD-E 记录范围化 supersession（§0.2） |
| OD-03 | 数据来源 | **被 OD-A 取代**：由"区域"改为"整个文件即上下文"（v1.0 原案 SUPERSEDED，见 §0.3 S1/S2） |
| OD-04 | currentTask | 维持：不再建设 |
| OD-05 | 自动压缩与恢复 | 维持并扩展：全部退出运行时路径（含 projectFocus 注入与 compress 命令，OD-C） |
| OD-06 | Adaptive 接线 | 维持：纳入核心交付，落点精确化（§5.1） |
| OD-07 | 三宿主 | 维持：必须同时满足统一交付 Gate；"统一"语义按 OD-D/§7.3 精确化 |
| OD-08 | 新增存储 | 维持：不允许 |
| OD-09 | 新增模型调用 | 维持：不允许 |
| OD-10 | 上下文数据外传 | **被 OD-B 细化**：由"遵循现有授权边界"改为独立显式授权 `sendPrincipleContext`（现有边界不覆盖长期背景数据类别） |

---

# 15. 技术审查决策追踪表

技术审查报告（2026-11-15）的全部 P0/P1 发现在本版本中均有明确修订落点，无遗留未决设计问题：

| 技术审查发现 | v1.1 处理结果 |
|---|---|
| PC-D1 三宿主物理 Workspace 冲突（WorkBuddy 全局 / Codex 双模 / OpenClaw agent 级，三目录刻意互异，安装器不创建 memory/okr） | 沿用宿主既有 Workspace 语义，统一契约（§7.3、§7.4）；不再要求同一物理 Workspace |
| PC-D2 数据外传授权缺失（Decisions 出站无按数据类别的授权机制；上下文是更敏感的新类别且"不外传=功能无效"） | 增加 `sendPrincipleContext`，默认 false，读取之前退出（§6） |
| PC-D3 20K 预算冲突（上下文 4KB 与指令/候选争用总载荷上限） | 上下文优先降级：超限先完全移除上下文再重建请求，诊断 `principle_context_dropped:budget`（§5.3） |
| PC-D4 Criteria 冻结版本（问题文案逐字引用 currentInstruction，v3-20261112 为冻结代际） | 升级 v4：版本标识 + 问题文案 + 快照测试 + Lab 对照 + 证据代际区分（§5.4） |
| PC-D5 Adaptive Context 类型不存在（v1.0 的 `AdaptiveContextInput` 无实现对应物） | 修改真实 Decisions state 请求链：`BuildDecisionRequestInput` / `BoundedSelectionInput.payload` / `buildDecisionRequest` / `DecisionRequestEnvelope.state`（§5.2）；平行示意协议废弃（§0.3 S5） |
| PC-D6 区域抽取语法歧义（重复标题/嵌套/BOM/CRLF/空区域无确定性规则） | OD-A 方案 C 整文件读取，不需要区域 Parser；规范化规则确定性枚举（§4.3） |
| PC-D7 旧 Focus 消费者处置不完整（/pd-focus 四子命令、/pd-init 实名、双压缩实现、死导出、官网文档债） | 按 §8 完整收敛（能力级处置表 + 文件级清单 + 文档同步 + 测试契约修订） |
| PC-D8 projectFocus 双消费（整文件注入与新上下文并存） | 整条自动注入链退役，唯一数据路径 = 只读上下文 → Adaptive Selector（§9.2） |
| PC-D9 两宿主初始化缺少文件（安装器不创建，恒 missing 空转） | 统一初始化模板，经既有显式初始化流程放置（§7.5）；未初始化时 missing 为正确行为并如实写进交付定义（§11 #6） |
| PC-D10 v0.6 Deferred 冲突（OD-02 声明 v0.6 基准但三宿主统一交付与其分期冲突） | 写入明确 supersession（§0.2）：就本能力取代 v0.6 §9/§10 对应分期，安全不变量全保留 |

# 16. 最终完成定义

只有同时满足以下条件，才能宣布 Principle Context 完成：

1. 原 Current Focus 已经转型为只读 Principle Context 来源（整文件语义，§4）。
2. 不再存在运行时自动工作记忆维护、自动压缩、自动恢复与宿主 Prompt 注入（Batch 1 全部落地）。
3. Owner 内容得到保护（零自动改写；SHA-256 断言在位）。
4. Principle Context 已经进入 Adaptive Activation 的真实决策输入（Decisions state 可选字段，经显式授权）。
5. 不影响现有 Native Activation。
6. Runtime V2 仍是唯一治理与激活权威；§5.5 全部治理机制原样保留并通过既有测试。
7. OpenClaw、Codex、WorkBuddy 三个宿主具有完全一致的功能契约（文件契约/模板/读取/授权/降级/治理语义）。
8. 三宿主真实 Adapter 集成测试通过（§11 矩阵全绿，逐宿主取证，WorkBuddy 跨项目语义与 Codex 双模分别验证）。
9. Batch 4 A/B 对照证明其具有实际价值；无可重复正向证据时按 Gate 4 放弃接入、保留 Batch 1 清理成果。
10. 复杂度预算（§12.1）逐项达标：零新增数据库/持久状态/Session 管理/Resolver/Service/缓存/同步机制/flag/治理权威/公共协议体系。

**最终产品定义：**

Principle Context 不是一个独立的 Agent 工作记忆系统。

它是 PD 理解 Agent 当前工作背景、帮助原则在正确场景中发挥作用的一项基础能力。

它的价值不在于记住更多信息，而在于帮助 PD 更准确地选择和激活原则。

**产品名称使用 `Principle Context`；`CURRENT_FOCUS.md` 仅作为兼容文件路径保留。**

---

# 附录 A：与既有文档的关系

| 文档 | 关系 |
|---|---|
| 《PD Principle Context SPEC v1.0》 | 已被本版本整体取代（SUPERSEDED）；原文件保留于同目录作历史证据 |
| `docs/audit/PD_ADAPTIVE_ACTIVATION_PHASE1_CURRENT_FOCUS_REAUDIT_20261115.md` | 现状缺陷与旧机制调用链的证据来源；其整改方案（Batch 0 等）中与本 SPEC 重叠的部分由本 SPEC §8/§10 Batch 1 接管，其余设计按 §8.6 明确不实施 |
| 《PD Adaptive Activation SPEC v0.6》 | 治理基准；§0.2 记录范围化 supersession；安全不变量与 C01–C09 纪律继续有效 |
| `docs/audit/PD_PRINCIPLE_CONTEXT_V1_TECHNICAL_REVIEW_20261115.md`（2026-11-15 技术审查） | 本版本全部源码级证据（基线 `23c4c477a`）与 PC-D1..D10 发现的来源；PC-D1..D10 的处置已自包含于本 SPEC §15 |
| `docs/audit/PD_WORKBUDDY_INTEGRATION_GAP_AUDIT_v0.1.md` | WorkBuddy 宿主可靠性既有事实（GAP-01/02/03 P0 与 WorkBuddy 链路时序约束）；Batch 3 集成验收须在其约束下取证 |

---

**SPEC v1.1 结束。等待 Owner 最终审阅与冻结裁决；本版本不构成开发批准。**
