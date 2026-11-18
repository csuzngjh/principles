# PD Principle Context — Unified Context for Adaptive Activation SPEC v1.1

**状态：** Implementation Authorized: Batch 1 and Batch 2 only（2026-11-17 Owner 实施授权，见 §0.4；Batch 3 / Batch 4 未授权）

**日期：** 2026-11-16（v1.1 修订）；2026-11-18（实施准备修订，产品语义不变）

**适用项目：** Principles Disciple (PD)

**目标宿主：** OpenClaw / Codex / WorkBuddy

**版本关系：**

| 项 | 值 |
|---|---|
| 本版本 | v1.1（2026-11-16 修订） |
| 取代 | **v1.0（2026-11-15）已由本版本整体取代（SUPERSEDED）**。v1.0 的区域抽取设计、三宿主同一物理 Workspace 要求、projectFocus 自动注入、`AdaptiveContextInput` 示意协议等设计不再支配实施；被废弃设计的完整清单见 §0.3 |
| 决策依据 | Owner 五项已批准决策 OD-A～OD-E（2026-11-15，见 §14）+ 历史技术审查报告（基线 `23c4c477a`）+ 2026-11-16 当前 main 源码复核（基线 `49d55e9374b0500be52ba087d89187b793e2b8e0`，见 §1.1/§15） |
| 源码基线 | `origin/main = 49d55e9374b0500be52ba087d89187b793e2b8e0`（v1.1 初版复核基线，2026-11-16）。历史技术审查报告仍以 `23c4c477a1b0ba52fe329781113a468d1efdd608` 为证据基线。本 SPEC 引用源码使用文件路径与符号名，不引用易漂移的行号 |
| 实施准备复核基线 | 2026-11-18 实施前复核基于 `origin/main = adbcfd33f4765fffee9de71055826edb8ed128a6`（Batch 1/2 实施基线，见 §15.2）；涉及的 Adaptive / 配置 / OpenClaw / Codex / WorkBuddy 关键源码符号、类型、配置字段、CLI 参数与 Decisions 协议与 §15.2 所载事实一致，未发现漂移 |
| 文档整改复核基线 | 最后一次源码核查基于 PR #2667 head `4799d6dd6aa8ecfe90738ba7ee289c9e7b3cf52e`，最新 `origin/main = 45a7fd7062f9d9de65fa0460c05faab1e9def7ce`（两者对本设计涉及的 7 份关键源码逐字节一致）；更早的整改取证基线为 head `4c858f89d`。按 §15.2 复核重点源码，符号名、类型名、配置字段、CLI 参数与 Decisions 协议均未变化；该基线只用于文档整改取证，不改变 v1.1 的产品决策 |
| 批准边界 | ~~本版本已并入 Owner 架构决策，不代表 Owner 已批准开发~~ → **2026-11-17 Owner 已明确授权实施（范围：文档实施准备修订 + Batch 1 + Batch 2；Batch 3 / Batch 4 未授权），见 §0.4**。本 SPEC 的产品语义（OD-A～OD-E、§4/§5/§6/§12.1 等）不变，整份文档仍不因 Batch 1/2 完成而被标记为全部完成或冻结（§16 最终完成定义仍然有效） |

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
| D6 | 接入顺序精确化：工厂先完成 Adaptive readiness（flag/config/credential），Provider 内先执行 `decideAdaptiveSkip`，再检查 `sendPrincipleContext`，最后才允许读取 | 2026-11-16 当前 main 源码复核 |
| D7 | 数据契约落点修正：扩展真实 Decisions 请求链（`BuildDecisionRequestInput` / `BoundedSelectionInput` / `buildDecisionRequest` / `DecisionRequestEnvelope.state`），删除平行的 `AdaptiveContextInput` 示意协议 | 技术审查 PC-D5 |
| D8 | 载荷预算规则确定化：20,000 JavaScript UTF-16 code units 总预算内超限先完全移除上下文，诊断 `principle_context_dropped:budget` | 技术审查 PC-D3 + 当前协议实现复核 |
| D9 | 评分契约版本升级 `v3-20261112` → `v4-20261116`，同步评分文案、动态 question ID 契约与证据代际 | 技术审查 PC-D4 + 当前协议实现复核 |
| D10 | 旧 Current Focus 处置按真实消费者矩阵修订（含 `/pd-focus compress` 退役），区分仍被 rollback 使用的备份能力与仅服务压缩/Prompt 注入的死消费者 | 技术审查 PC-D7 + 2026-11-16 当前 main 复核 |
| D11 | 修正 Adaptive readiness 与上下文授权的语义：`sendPrincipleContext=false` 只关闭上下文读取/发送，不关闭已就绪的无上下文 Adaptive | 当前 main `createAdaptivePriorityProviderForConfig` / `decideAdaptiveSkip` 复核 |
| D12 | 按真实调用者清查修正 Focus 历史能力处置：`backupToHistory` 保留给 rollback；`getHistoryVersions`、`cleanupHistory`、`archiveMilestonesToDaily` 随 Prompt/压缩路径退役 | 当前 main 全仓生产引用复核 |
| D13 | 初始化模板改由既有 `pd runtime init --confirm` 显式 create-only-if-missing 放置；OpenClaw 普通 `before_prompt_build` 模板复制不得创建 CURRENT_FOCUS | 当前 main `ensureWorkspaceTemplates` / `runtime-init` 复核 |
| D14 | `/pd-init` 改为访谈与输出草案，不自动写入 Owner 文件；rollback 改为原始字节恢复，不追加版本/状态文本 | 当前 main `strategy.ts` / `focus.ts` 复核 |
| D15 | 完整定义 `sendPrincipleContext` 授权传递链：配置类型 / 封闭白名单 / Validator 四规则 / 工厂一次性求值并注入 Provider 闭包 / 授权在文件 I/O 之前 / 直接构造与缺配置路径 fail-closed 默认拒绝 / 授权关闭不等同关闭 Adaptive | 文档评审 P1-1；PR #2667 head `4c858f89d` 源码复核 |
| D16 | Criteria v4 评分语义具体化：Append / Replacement / `insufficient_context` / 指令优先级四类判定，明确不得因 Context 关键词机械提权 | 文档评审 P1-2 |
| D17 | 把「Criteria v3→v4 回归」与「Principle Context 价值验证」定义为两个相互独立的实验，阈值未获批准的部分标注待 Owner 决策 | 文档评审 P1-2 |
| D18 | 补齐外部数据传输与隐私披露契约：7 条边界 + 交付清单 + WorkBuddy 用户级共享治理上下文语义；不承诺数据不离开本机 | 文档评审 P1-3 |
| D19 | Reader 路径安全与跨平台竞态要求；Reader 诊断改为有限枚举，禁止记录正文 / 原始 OS 错误 / 绝对路径 | 文档评审 P2-1、P2-4 |
| D20 | Decisions state 序列化契约：区分内部对象、`DecisionRequestEnvelope` 字段、`state` 序列化形式、最终 HTTP JSON 四层 | 文档评审 P2-3 |
| D21 | 三宿主初始化命令与结果契约：以真实 CLI 参数给出可执行命令，结果四态（`would_create`/`initialized`/`skipped`/`failed`）+ 顶层 `ok`/warnings/退出码/JSON 单对象；区分正常结果与早期错误对象形态 | 文档评审 P2-2、P2-5 |
| D22 | 拆除「无 Context 即不产生任何 Context 文件读取」的不可实现合并表述：把运行状态拆为 **S1 未授权（唯一零读取）/ S2 已授权但不可用（最多一次有界读取尝试）/ S3 已授权但预算移除（读取已完成）/ S4 可用且未移除**。四者评分语义等价（缺 Context 不影响原则选择），差异只在 I/O 足迹与诊断 | 最后一轮评审唯一 P1 阻塞项 |

### 0.1.1 2026-11-16 文档整改追加修订（范围不变，版本号保持 v1.1）

本次修订是**严格限定范围的文档整改**，不是重新设计产品，也不是功能开发：

1. **只修订两份文档**：本 SPEC 与《PD Principle Context Technical Design v0.3》；不修改任何源代码。
2. **不改变已批准的产品行为**：OD-A～OD-E、§4 数据来源语义、§6 授权默认值 `false`、§5.3 20K 预算硬约束、§7.3 三宿主 Workspace 冻结语义、§8 旧机制退出清单、§12.1 复杂度预算均原样保留。本次只把已批准的产品意图展开为可开发、可验收的契约，不扩大需求范围。
3. **版本号因此保持 v1.1**；配套技术设计由 v0.2 升为 v0.3（实施契约增补，不改变产品意图）。
4. **修订落点**：P1-1 → §3.1 / §5.1 / §6.2 / §9.1 / §11；P1-2 → §5.4 / §10 Batch 4 / §11；P1-3 → §6.3 / §6.4 / §7.3 / §11；P2 系列 → §4.7 / §5.2 / §7.5 / §11 / §12.1；源码复核 → §15.2；配套文档引用 → 附录 A。
5. **关闭状态以 §11 验收矩阵与 §15.2 为准**；任何「待 Owner 决策」项均显式标注，不以自拟阈值填补。
6. **最后一轮修订（D22）**：运行状态 S1–S4 拆分落在 §5.4.1 与 §11（Context 四态行为测试）；Codex 首次初始化与初始化后解析的时点区分落在 §7.3 / §7.5；初始化结果契约的形态 A/B/C 区分落在 §7.5 / §11。

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

## 0.4 实施授权记录（2026-11-17）

Owner 于 2026-11-17 明确授权：

| 范围 | 授权状态 |
|---|---|
| 文档实施准备修订（本节所述 SPEC / Technical Design 基线更新、授权状态更新、WorkBuddy 前置风险与 Batch 4 前置条件记录） | **已授权** |
| Batch 1：Current Focus 旧机制退出（§10 Batch 1） | **已授权** |
| Batch 2：Principle Context Shared Reader 与 Adaptive 接入（§10 Batch 2） | **已授权** |
| Batch 3：三宿主统一交付（初始化模板 + 真实集成验收） | **未授权**；启动前置条件见 §10 Batch 3 |
| Batch 4：价值验证（实验 A / 实验 B） | **未授权**；启动前置条件见 §10 Batch 4 |

约束（随授权一并生效）：

1. 必须基于授权时点的最新 `origin/main` 实施，不得沿用旧文档中的源码行号或过时基线。
2. 不允许仅修改 SPEC 而不实现代码；不允许仅凭单元测试宣布功能完成。
3. 不允许为通过测试删除有效安全测试；PRI-82 行为契约变更按 §8.5 显式声明。
4. `sendPrincipleContext` 默认保持 `false`，不得在任何默认配置中置 `true`。
5. 不得自动修改、迁移或覆盖 Owner 已有 `CURRENT_FOCUS.md`。
6. Batch 1 与 Batch 2 各自独立可回滚（§13）。
7. 本次授权不改变 §16 最终完成定义；Batch 1/2 完成不等于 Principle Context 项目完成。

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

2026-11-15 技术审查报告（历史源码基线 `23c4c477a`）进一步确认：

6. 三个宿主的 Workspace 解析是三条刻意不同且已被冻结的设计（OpenClaw agent 级、Codex 用户级/项目级双模、WorkBuddy 全局治理目录）。
7. Adaptive 选择器是三宿主共享的单一实现（`createAdaptivePriorityProvider`），运行时读取应接入共享选择路径，不复制三套 Context Reader。
8. Decisions 出站路径上不存在按数据类别的授权机制，长期业务背景需要独立的显式授权。

2026-11-16 当前 main 源码复核（`origin/main = 49d55e9374b0500be52ba087d89187b793e2b8e0`）进一步确认：

9. `createAdaptivePriorityProviderForConfig` 在 Provider 创建前完成 host Adaptive Flag、`adaptiveActivation` 配置与 Decisions 凭据 readiness 校验；`decideAdaptiveSkip` 则在 Provider 内执行。因此 readiness 不通过时走 Native；skip 命中时零文件 I/O；`sendPrincipleContext=false` 时仅跳过上下文读取，仍允许已就绪的 Adaptive 无上下文评分。
10. Decisions 预算实际按 `JSON.stringify({ state: body.state, questions }).length` 计算，Current Instruction 上限按 `string.length` 校验；二者均为 JavaScript UTF-16 code units，不是 UTF-8 字节或 Unicode code points。
11. Codex Background `runAdaptiveBackgroundSelection` 在后台执行时复用共享 Provider；上下文必须在该执行阶段从 workspace 读取，不得写入 job、result 或跨进程持久载荷。
12. 旧 Focus 消费者复核：`getHistoryVersions` 只用于旧 Prompt full 注入；`cleanupHistory` 与 `archiveMilestonesToDaily` 只用于自动/手动压缩；`backupToHistory` 仍由显式 rollback 使用；history 列表与 rollback 直接扫描 `.history/`。
13. OpenClaw `ensureWorkspaceTemplates` 从普通 `before_prompt_build` 路径调用，并递归复制 `templates/workspace/okr/CURRENT_FOCUS.md`；该文件必须退出普通模板复制。现有 `pd runtime init --confirm` 是 Codex/WorkBuddy setup 已使用的显式初始化入口，可作为三宿主统一 create-only-if-missing 放置点。
14. `/pd-init` 当前只返回 Agent 指令，但指令要求 Agent 直接生成 CURRENT_FOCUS；必须收敛为访谈与草案输出，不自动写入 Owner 文件。
15. `focus.ts` 的 rollback 当前会重写版本/日期/状态文本；新契约要求显式 rollback 只恢复历史文件原始字节，并先备份当前字节。

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
各宿主既有 Workspace Resolver（路径语义不变）
  OpenClaw: agent workspace | Codex: user/project 双模 | WorkBuddy: global workspace
                    |
                    v
createAdaptivePriorityProviderForConfig
  既有 readiness：host flag + adaptiveActivation 配置 + Decisions credential
  readiness 不通过 -> Provider 不创建 -> Native
  + 一次性求值 config.adaptiveActivation.sendPrincipleContext === true
    -> 作为布尔值注入 Provider 构造参数（不是每轮重读配置文件）
                    |
                    v
createAdaptivePriorityProvider（共享 Provider，闭包持有授权布尔值）
  1. decideAdaptiveSkip；命中 -> 零 Context I/O / 零发送
  2. 授权布尔值 === true？否 -> 零 stat / 零 read，无上下文继续 Adaptive
  3. 是 -> 有界只读读取 CURRENT_FOCUS.md（≤64 KiB）
                    |
                    v
runAdaptiveSelection -> Decisions state.principleContext（可选）
  总载荷超限 -> 先移除 principleContext，再按既有 INPUT_REFUSED 处理
                    |
                    v
Candidate Validation -> Adaptive Principle Revalidation -> Runtime V2
                    |
                    v
Principle Activation（宿主 Prompt 不包含 Principle Context 正文）
```

**Codex Background** 通过 `runAdaptiveBackgroundSelection` 在后台执行时复用同一 Provider；读取发生在后台选择执行阶段，不进入 job/result 持久载荷。

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

## 4.7 Reader 路径安全与诊断要求（产品级硬约束）

具体算法与跨平台降级由 Technical Design v0.3 §3 定义；以下是 SPEC 层面的不可削弱约束：

1. **Workspace 根必须规范化**：读取目标只能由宿主既有 Workspace Resolver 解析出的根目录 + 固定相对路径 `memory/okr/CURRENT_FOCUS.md` 组成，不接受由 Context 内容拼接出的路径。
2. **目标必须位于授权 Workspace 内**：`CURRENT_FOCUS.md` 及其父级目录链（`memory/`、`memory/okr/`）均须通过包含性检查；任何指向 Workspace 外部的符号链接必须拒绝读取。
3. **逐级校验父目录链**：固定目标 `memory/okr/CURRENT_FOCUS.md`，对 `memory`、`memory/okr`、目标文件逐级用 `lstat` 检查并拒绝任何符号链接（Windows junction/reparse point 等价处理），再用 `realpath` 确认实际解析结果仍在授权 Workspace 内；禁止用未经逐级验证的递归目录创建绕过检查。
4. **路径检查与读取不能脱节**：检查通过后不得再次使用未经验证的字符串路径执行 `readFile`；只能基于已打开并验证的 `FileHandle` 读取，并对实际打开对象做 `FileHandle.stat()` 检查（含身份信息与大小）。**`fstat` 不返回文件路径**：路径包含关系由规范化根 + 逐级 `lstat`/`realpath` 证明，句柄 stat 只确认打开的是普通文件并读取身份/大小，不得声称 fstat 能证明路径位置。
5. **读取前硬限制**：原始文件大小上限在读取内容之前生效，不依赖读取后判断；读取动作本身必须有界（最多 65,537 bytes）。
6. **明确降级**：路径竞争、文件被替换（身份信息不一致）、符号链接变化、权限变化一律 fail-closed 降级为无 Context 的原有选择流程，不得抛到宿主 Prompt 构建路径。
7. **跨平台剩余风险如实披露**：Windows / macOS / Linux 的文件系统语义不同，Node.js 文件 API 不提供跨平台、跨进程的原子目录句柄遍历能力，`fstat` 也不能独立证明路径包含关系；无法彻底消除的 TOCTOU 竞态必须在交付文档中列为剩余风险，不得声称已完全消除，也不得为追求绝对安全引入平台专用原生扩展等不必要依赖。
8. **不新建 Context Parser、不新建路径安全子系统**：路径检查复用既有 `packages/pd-cli/src/utils/path-security.ts` 的包含性原语语义（其为词法包含，物理符号链接约束由 Reader 自行补足），不新增公共抽象。

**Reader 诊断原因码（唯一标准，7 值有限枚举）**：`file_missing`、`unreadable`、`unsafe_path`、`too_large`、`read_failed`、`empty_content`、`normalize_failed`。这是全仓（SPEC 与 Technical Design）唯一的**失败原因码（reason）**标准；每个失败场景必须映射到这七个 reason 之一，不得用泛化字符串（例如把不同失败笼统记成一个 `invalid` 原因码，或在两处分别对同一失败用不同原因名）。

注意区分两层：**四态 status**（`available` / `missing` / `invalid` / `unreadable`，仅作展示层分组）与**七值 reason**（上面唯一标准的原因码）。`invalid` 是合法的 status 分组名，但不是原因码——具体原因必须是七个 reason 之一。诊断只输出 reason 与 status，不得记录 Context 正文、正文片段、原始 OS 错误文本或不必要的绝对路径（详见 §6.4、Technical Design v0.3 §3.2 的完整映射表）。

---

# 5. Adaptive Activation 集成

## 5.1 真实接入位置

**不增加 Adapter 专用 Context Provider、不增加 Workspace Resolver、不增加 Context Service。**

复用现有共享工厂 `createAdaptivePriorityProvider`（`packages/host-runtime/src/adaptive-priority-provider.ts`）。接入顺序必须与当前真实调用链一致：

1. `createAdaptivePriorityProviderForConfig` 先完成既有 Adaptive readiness（host flag、`adaptiveActivation` 配置、Decisions 凭据）。任一不满足时 Provider 不创建，保持 Native；不触碰 Context 文件。
2. 已创建的 Provider 收到 `before_prompt_build` 事件后，先执行 `decideAdaptiveSkip`。skip 命中时零 Context I/O、零发送。
3. skip 未命中后，只有 `adaptiveActivation.sendPrincipleContext === true` 才执行共享只读 Reader；未授权时不 stat、不 read。
4. Reader 返回 `available` 时，将规范化文本作为可选 `principleContext` 传给 `runAdaptiveSelection`；`missing / invalid / unreadable` 或未授权时省略字段，继续无上下文 Adaptive。
5. Codex Background 由 `runAdaptiveBackgroundSelection` 在后台进程中调用同一 Provider；Reader 仍在 Provider 内执行，不在 job 创建时读取，不把正文写入 job/result。

**授权传递链（产品级定义，实施级函数边界见 Technical Design v0.3 §1／§2.3）：**

```text
.pd/config.yaml（adaptiveActivation.sendPrincipleContext）
  -> 既有配置加载 + validatePdConfig（封闭白名单 + boolean 校验）
  -> 既有 effective config 原样透传 adaptiveActivation
  -> createAdaptivePriorityProviderForConfig（readiness + 授权一次性求值）
  -> createAdaptivePriorityProvider（闭包持有授权布尔值）
  -> decideAdaptiveSkip
  -> 授权检查（=== true）
       ├─ false：零 stat / 零 read / 零 Context 字段；Adaptive 原有能力继续工作
       └─ true ：Principle Context Reader（有界只读）
                  -> runAdaptiveSelection
                  -> buildDecisionRequest
                  -> DecisionRequestEnvelope.state（JSON 字符串内的可选字段）
```

授权链必须满足：

- 授权值在 **Provider 创建阶段**由已加载并已校验的配置一次性求值，之后每轮决策只读闭包内的布尔值；**不允许每轮重新读取配置文件**判断授权。
- 直接构造 Provider、测试构造、以及缺少 `adaptiveActivation` 配置的路径，一律按「未授权」处理（默认拒绝 Context 读取）。
- 授权关闭时 Reader 必须实现**零文件读取**（连 `stat` 都不执行），且不得据此关闭 Adaptive Activation。
- Context 读取失败、路径不安全、超限、内容为空等任何 Reader 失败，一律降级为「无 Context 的原有选择流程」，**不能导致整个宿主 Prompt 构建失败**。
- 授权链不新增第二次模型调用、不新增配置读取服务、不新增缓存或持久状态。

约束：

- 读取最多一次/次 Adaptive selection，且只在 skip 门与 send 授权门之后。
- 三宿主复用同一个 Reader 与规范化实现，不复制三套逻辑。
- 运行时 Adapter 不增加 Context 专用分支；Codex Background 不增加第二套 Reader。
- 上下文不可用只降级上下文，不阻塞已就绪的 Adaptive；Adaptive readiness 不满足则走 Native。

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

**序列化契约必须精确区分四层，不得混写：**

1. 内部逻辑对象：选择层使用的内存对象结构，`principleContext` 是其中一个**可选字符串字段**。
2. `DecisionRequestEnvelope` 实际字段：只有 `{model, state, questions, provider?}`；其中 `state` 的类型是 **JSON 字符串**，不是对象。
3. `state` 的序列化形式：对上述内部对象执行 `JSON.stringify` 得到的字符串；`principleContext` 作为该字符串内的一个可选键存在。
4. 最终发送到 HTTP endpoint 的 JSON：信封整体序列化，`state` 字段的值是一段被转义的 JSON 字符串。

Context 的准确位置是**第 3 层**（`state` JSON 字符串内的可选键），不是信封顶层字段。完整的序列化前/后示例、字段名与类型约束由 Technical Design v0.3 §4.2 给出，且不得与本 SPEC 的协议边界冲突：不改变 endpoint、顶层请求结构、候选原则结构或现有评分结果结构。

## 5.3 载荷预算（硬约束）

必须明确以下现有硬约束：

| 项目 | 限制 |
|---|---:|
| Decisions 预算对象（`JSON.stringify({ state: body.state, questions }).length`） | 20,000 JavaScript UTF-16 code units |
| currentInstruction（`currentInstruction.length`） | 6,000 JavaScript UTF-16 code units |
| Principle Context（规范化后 `text.length`） | 4,000 JavaScript UTF-16 code units |
| 原始文件 | 64 KiB |

预算处理规则（确定性顺序，不得留给实现自由发挥）：

1. 首先尝试构建带上下文的请求。
2. 如果总 payload 超过 20,000 JavaScript UTF-16 code units，**优先完全移除 Principle Context**。
3. 不允许截断 Current Instruction。
4. 不允许为了保留上下文而削减候选原则。
5. 移除上下文后重新构建请求。
6. 如果原有内容（指令+候选）仍然超过 20,000 JavaScript UTF-16 code units，继续沿用原有 `INPUT_REFUSED` 机制（整轮选择不可用，走 Native）。

诊断：`principle_context_dropped:budget`。只能记录状态和原因，**不能记录上下文正文**（沿既有 rc-8 有界序列化纪律）。

## 5.4 评分契约版本（Criteria v4）

原有评分契约版本 `v3-20261112` 在增加 Principle Context 后必须升级至 **`v4-20261116` 新证据代际**。同步修改：

- Criteria 版本标识（`ADAPTIVE_DECISION_CRITERIA.version`）。
- 评分问题文案：候选适用性问题与 `insufficient_context` 问题的判断依据从"依据 currentInstruction"扩展为"依据 currentInstruction（结合可用的 principleContext 背景）"；文案必须保持"Current Instruction 是当前任务判断的主要依据，Principle Context 是辅助背景"的语义。
- 请求快照测试。
- Selector Lab 对照实验（PRI-1182 纪律：预算内对照新旧文案的分数稳定性）。
- 相关证据记录（新代际与 v3 代际的评分证据必须可区分）。
- 动态问题 ID 保持现有闭集构造规则：Append 候选使用 `candidate_<ref>`；Replacement 候选使用 `candidate_<ref>_value` 与 `candidate_<ref>_safety`；全局信息不足问题使用 `insufficient_context`。不新增第二套 question ID 或上下文专属问题。

### 5.4.1 Criteria v4 评分语义（四类判定，可开发级）

Criteria v4 的评分问题文案必须为以下四类判定给出明确、可直接翻译为模型指令的语义。Technical Design v0.3 §5.2 给出逐字文案，产品语义以本节为准。

**四种运行状态（I/O 行为与评分行为必须分开描述）——P1-4：**

由于 `sendPrincipleContext` 默认 false，Selector 必须在"完全没有 Context"时照常工作。但"没有 Context 用于评分"与"没有发生过 Context 文件读取"**不是同一件事**，必须拆开描述：前三种（S1–S3）是"无 Context 可用于评分"的三种不同成因，S4 是 Context 真正可用的情形。

| 运行状态 | 触发条件 | 文件读取 | 外部发送 | 评分行为 |
|---|---|---|---|---|
| **S1 未授权** | `sendPrincipleContext !== true`（未设置或 false） | 零 stat、零 read（Reader 完全不被调用） | 不发送 | 原有 v3 语义 |
| **S2 已授权但 Context 不可用** | 已授权，Reader 返回 `file_missing` / `unreadable` / `unsafe_path` / `too_large` / `read_failed` / `empty_content` / `normalize_failed` | 最多一次有界读取尝试（可能仅 stat 即失败） | 不发送 Context | 原有 v3 语义 |
| **S3 已授权但预算移除** | 已授权，Context 已成功读取并规范化，但并入请求后超预算被移除 | 已完成一次读取 | 不发送 Context | 原有 v3 语义 |
| **S4 Context 可用且未被移除** | 已授权，Reader 返回 `available`，请求在预算内，且该请求已实际发出（`sends > 0`） | 已完成一次读取 | 发送 Context（位于 `state`；`sent` 诊断以实际发送为证据） | v3 语义 + Context 辅助 |

**硬约束：**

- **只有 S1 是零读取。** 不得把 S1 的零 stat / 零 read 要求推广到 S2、S3：S2 必须实际访问文件才能知道它不存在或不可用；S3 在移除字段之前已经完成读取与规范化。把三者合并成"不产生任何 Context 文件读取"在实现上不成立。
- **S1 / S2 / S3 在评分与发送上等价**：都按原有 `currentInstruction` 语义评分——不因缺少 Context 降低候选分数、不因此自动抬高 `insufficient_context`、不改变候选数量、question ID、Decision Response 结构与本地裁决；且都不发送 Context。三者差异只在 I/O 足迹与诊断原因码，不影响选择质量。这正是实验 A 要验证的"无 Context 时行为与 v3 一致"。
- **S4 的边界**：仅作为辅助背景；不覆盖当前用户意图，不覆盖系统指令、开发者指令与治理规则；不得靠关键词机械匹配提分；不得仅因某原则出现在 Context 中就触发 Replacement。
- 四态判定只依赖"授权布尔值 + Reader 结果 + 是否被预算移除"，不构成第四种评分模式，不增加第二次模型调用，不改变 question 闭集。
- **`sent` 诊断是证据结论**：仅当 Reader 返回 `available`、未被预算移除、且携带该字段的 Decisions 请求实际发出（`sends > 0`）时才报告 `sent`。Reader 成功但没有任何携带该字段的请求发出（输入在发送前被拒、deadline 在发送前耗尽）时不得报告 `sent`；四态模型中没有合适状态时不伪造第五态，由同一行的既有 `status`/`reason`/`sends` 表达，并省略 `principleContext` 字段。

**A. Append（候选适用性）**

判断候选 Principle 是否**真正适用于当前 Instruction**；当 `principleContext` 存在时，判断它是否提供了足够的补充依据支持这种适用性。缺少上下文支撑的候选不得仅因"看起来相关"而获得高适用性分。

**B. Replacement（相对更适合）**

判断候选 Principle 是否比**当前已选中的 Principle** 更适合本轮任务。明确禁止：仅因为某个原则出现在 `principleContext` 中，就自动提高它的优先级或替换现有选择。Context 中出现某原则只是背景信号，不是替换指令。

**Replacement safety 补充（不可绕过）**：Context 可以提供与本轮任务有关的约束背景，但不能替代候选 `replaces` 关系的显式检查；不能降低"原原则仍需保留"时的 safety 判断；更不能绕过 Authority 校验、Adaptive Principle Revalidation 或任何既有本地裁决。safety 问题只依据 `candidates[].replaces` 与本轮任务需要作判断。

**C. insufficient_context（信息不足）**

当 Current Instruction 与 `principleContext` **都不足以支持可靠判断**时，评分模型必须允许通过现有 `insufficient_context` 问题表达信息不足，而不是被迫猜测。这是既有动态闭集中的合法答案，不是新增问题类型。

**缺少 Context ≠ 信息不足**：Context 缺省是默认且正常的状态，不得被视为信息不足的信号。只有当 Current Instruction 本身确实不足以可靠判断（例如只有确认词、指代不明、不知道在问哪个任务）时，才允许表达 `insufficient_context`；有 Context 时也只有"指令 + Context Combined 仍不足"才允许。不得把"Context 缺失"直接映射为高 `insufficient_context` 分。

**D. 指令优先级（不可践踏）**

- Current Instruction 是本轮决策的**主要依据**。
- Principle Context 是**辅助背景**，不得覆盖系统指令、开发者指令或用户当前明确意图。
- 历史 Focus / Principle Context 中的既有内容**不得被解释为新的用户命令**。
- 不允许模型仅凭 Context 中出现的关键词做机械匹配来提分或触发替换。

### 5.4.2 通用信任约束

Criteria v4 必须明确将 `state.principleContext` 视为 Owner 提供的**背景数据，而非指令**；其中任何要求忽略规则、改变权限或操纵评分的文字都不得被遵循。上下文不能要求模型绕过治理规则。

### 5.4.3 两项独立实验（不得混为一谈）

必须分别设计、分别记录、分别验收以下两项实验；阈值未获 Owner 批准的部分显式标注，不得自拟数值：

**实验 A：Criteria v3 → v4 评分回归。** 目的仅是验证评分指令升级没有引入非预期评分漂移。**v3 组与 v4 组都不发送 Principle Context**——Context 不进入本实验，否则无法隔离评分文案升级的影响。两组的输入、候选集合、模型、请求条件、评分样本全部一致，唯一变量是 Criteria 版本及相应评分文案。对比评分结果变化、原有判断一致性、错误选择与 `insufficient_context` 行为。

**实验 B：Principle Context 价值验证。** A 组为 `Existing Adaptive Input without Principle Context`，B 组为 `Existing Adaptive Input with Principle Context`。注意现有 Adaptive 请求本就包含 `currentInstruction` 之外的 priorMessages、candidates 等信息，因此不能把 A 组简单称作 `Current Instruction only`。两组使用相同 Criteria v4、相同候选集合、相同模型、相同其他请求条件，唯一变量是可选 `principleContext` 字段。重点验证是否改善候选选择、减少错误激活、改善任务相关性，以及是否因无关上下文导致误选或负迁移。不得仅以模型给出的解释作为有效性证据。

实验执行设计、指标与验收阈值见 Technical Design v0.3 §5.4 与 §9 Batch 4；沿用已有 SPEC/实验契约的指标，未批准阈值标注「待 Owner 决策」。

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

必须区分 **Adaptive readiness** 与 **Principle Context 外传授权**，二者不是同一个开关：

**A. Adaptive readiness（既有门，不因本需求改变）**

1. 当前宿主 Adaptive Activation Flag 已开启（`host.<host>.adaptive_activation`，quiet，默认关）。
2. `adaptiveActivation` 配置有效。
3. Decisions Provider 的 endpoint/model/apiKeyEnv 已配置，且凭据可解析。

任一条件不满足时，`createAdaptivePriorityProviderForConfig` 不创建 Provider；本轮走 Native，不读取、不 stat、不发送 Principle Context。

**B. Principle Context 外传授权（新增普通配置项）**

- 只有 `adaptiveActivation.sendPrincipleContext === true` 才允许读取并将 Context 加入 Decisions state。
- 未设置或为 `false` 时，Provider 仍按既有逻辑执行 Adaptive，但完全跳过 Context 文件路径：零 stat、零 read、零上下文发送；Current Instruction + candidates 的评分路径不变。
- 即使已授权，Provider 仍先执行 `decideAdaptiveSkip`；skip 命中时零文件 I/O、零发送。
- 只有 readiness 通过、skip 未命中、且 `sendPrincipleContext === true` 三项同时成立，才读取文件。

**授权边界：** 当轮用户指令的既有授权不能自动解释为长期背景数据的授权。`sendPrincipleContext` 仅授权把当前宿主解析到的 Principle Context 发送给 `adaptiveActivation.endpoint`，不授权写入、同步或发送给其他服务。

## 6.3 数据传输说明（必须随实现交付）

配置为 `true` 表示 Owner 明确允许将当前 Workspace 的 Principle Context 发送到已配置的 Decisions Provider。

配置文档、配置字段说明和隐私说明必须明确以下 **7 条边界，缺一不可**：

1. **默认不外传**：Principle Context 默认不发送到任何外部 Provider（`sendPrincipleContext` 默认 false；三个宿主 Adaptive flag 默认关）。
2. **显式授权**：只有 Owner 将 `sendPrincipleContext` 显式设为 true 才允许外传。
3. **发送内容**：授权后，外部 Decisions Provider 会接收到 Decisions 请求中实际携带的 Context 正文——即当前 workspace 的 Principle Context 文件规范化内容（≤4,000 UTF-16 code units），作为 `state` JSON 内的可选字段。
4. **本地不落盘正文**：PD 本地不得将 Context 正文持久化到日志、Telemetry、Trace、Journal、job/result 或任何诊断信息（见 §6.4）。
5. **不替外部担保**：PD 无法替外部 Provider 保证其不记录请求内容。
6. **政策由 Provider 决定**：外部 Provider 对数据的处理、保留和使用政策，由其自身服务条款决定；不得在文档中承诺数据不会离开本地机器。
7. **撤销的时序边界**：撤销授权（`sendPrincipleContext` 置回 false，或关闭宿主 adaptive flag）只阻止后续请求，不能追回已经发送或正在处理的请求。

**发送给谁**：`adaptiveActivation.endpoint` 指向的已配置 Decisions Provider（单端点、无回退）。

**WorkBuddy 特别说明**：其 Principle Context 属于用户级共享治理上下文（跨项目可见，§7.3），不是当前项目独有的数据；交付文档必须如实说明这一可见范围。

### 6.3.1 隐私与安全测试（随实现交付）

- 授权关闭时零读取、零外传（请求快照中不含 `principleContext` 字段）。
- 授权开启时请求快照中 Context 正文存在且位于 `state` JSON 内，长度受限于 4,000 code units。
- 日志/Telemetry/Trace/Journal/job/result/错误报告中检索不到任何 Context 正文或片段。
- 撤销授权后的下一轮请求不再携带 Context（时序边界测试）。
- 配置字段说明、用户授权说明、传输内容说明、Provider 接收范围说明、授权撤销说明五类文档齐备。

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

三宿主**运行时 Adapter 不增加 Context 专用逻辑**：读取落在共享 Provider/Selector 路径，各宿主自动继承。初始化模板通过既有 CLI 初始化入口统一放置，不需要三套 Adapter 分别实现。Codex Background 同样复用共享 Provider。

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

三个宿主使用同一模板、同一相对路径、同一 create-only-if-missing 规则；**统一初始化入口使用现有 `pd runtime init --confirm`，不新增命令或初始化子系统。**

模板内容：

```markdown
# Principle Context

## Long-term Background

## Important Constraints

## Current Direction
```

模板只提供轻量结构，不包含任务管理、Session 状态或自动维护规则。模板正文由 `packages/pd-cli/src/commands/runtime-init.ts` 中的单一常量提供，避免三宿主各维护一份副本。

### 三宿主初始化方式

- **OpenClaw：** 普通 `before_prompt_build` 会调用 `ensureWorkspaceTemplates` 递归复制 workspace 模板；因此必须从 `packages/openclaw-plugin/templates/workspace/okr/` 移除旧 `CURRENT_FOCUS.md` 模板，禁止该普通 Prompt 路径创建该文件。Owner 在**当前 Agent 的 `ctx.workspaceDir`** 执行 `pd runtime init --confirm --workspace <agent-workspace>` 时创建，不得用 main/cwd/HOME 推断到其他 Agent 目录。
- **Codex：** 沿用既有用户级/项目级 Workspace Resolver；用户级 workspace = `path.resolve(CODEX_HOME || ~/.codex)/pd-workspace`（CODEX_HOME 未设置时回退 `~/.codex`），仅当其 `.pd/config.yaml` 是文件时胜出，否则回落到项目级 `resolveNearestPdWorkspace`。该函数从绝对 cwd 逐级向上找第一个含 `.pd/config.yaml` 的目录，找不到即 fail-closed（**不创建、不伪造 workspace**）。`pd runtime init` 必须显式传入路径，并区分两个时点：**首次初始化**（该项目尚无 `.pd/config.yaml`）时，`--workspace` 传入 Owner 指定的项目根目录，由 init 负责创建 config；**初始化完成后**，hook 才通过 `resolveNearestPdWorkspace` 从请求 CWD 定位到它。不得把"目标已含 config"当作首次初始化的前置条件（否则形成死锁），也不得用任意项目目录冒充已初始化 workspace；用户级与项目级分别验收。
- **WorkBuddy：** 沿用既有全局治理 Workspace（`getWorkbuddyWorkspaceDir() = <home>/.workbuddy/pd-workspace`，无环境变量覆盖）；由 Owner 显式执行 `pd runtime init --confirm --workspace <该目录>` 创建，语义仍为跨项目共享。**宿主 setup 只检查配置存在、不执行 init**（源码已核实）。

三宿主的可执行命令示例（统一 dry-run → confirm 两步、同一 workspace）见 Technical Design v0.3 §6.3。

### 创建契约

1. `pd runtime init` 默认 dry-run：只报告将创建/已存在，不写文件。
2. 只有显式 `--confirm` 才允许创建；`--dry-run` 与 `--confirm` 互斥（既有 cli-4 契约）。
3. **父目录必须逐级校验**：规范化 Workspace 根后，逐段创建并检查 `memory`、`memory/okr`——已存在段用 `lstat`/`realpath` 确认不是符号链接/junction 且解析结果在 Workspace 内；禁止用未经逐级验证的递归创建绕过检查。**只靠 `wx` 不足以防止父目录符号链接把文件写到 Workspace 外**。初始化路径安全必须与 §4.7 的 Reader 安全边界一致，但两者要分别检查。
4. 目标文件以独占创建（`wx`）写入（避免并发覆盖 Owner 文件）；目标已存在（包括符号链接）时一律 `skipped`，不读取、不覆盖、不迁移、不格式化，原始字节不变。
5. 路径/安全/竞态/权限检查失败时停止写入并返回 `failed`；不回滚已完成的数据库初始化；缺失模板不阻塞 Native 或无上下文 Adaptive。
6. **结果契约**：在现有 `RuntimeInitOutput` 上**增量增加一个可选字段**承载模板结果（不新造协议、不复用 config.status），四态为 `would_create`（dry-run 且不存在）/ `initialized`（confirm 创建成功）/ `skipped`（已存在，dry-run 与 confirm 均适用）/ `failed`。`failed` 才使顶层 `ok=false`；`would_create` 与 `skipped` 不算失败。文本输出显示独立状态；**正常执行结果**的 JSON 必含该字段，且 stdout 仅一个可解析对象；而参数互斥（`emitFlagConflict`）与捕获异常（`emitError`）产生的是 `{ok:false, reason, nextAction}` 错误对象——不属于 `RuntimeInitOutput`、不含该字段（TD §6.4 形态 A/B/C，以是否存在 `mode` 字段区分）；失败退出码 1。详见 Technical Design v0.3 §6.4。
7. 不在普通 Prompt Hook、Compaction、后台任务或安装器启动时创建。
8. 不新增命令、服务、持久状态或跨宿主同步。

`/pd-init` 只负责访谈与输出三节草案，不写入文件；Owner 手动编辑。若文件缺失，先通过上述显式 CLI 初始化创建空模板。

### 语义备忘

统一的是文件契约、模板、读取逻辑、授权规则、降级语义和治理语义，不是物理 Workspace。WorkBuddy 的全局跨项目可见范围与 Codex 双模、OpenClaw agent 级隔离按 §7.3 保持不变。

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

- 保留已有 `.history/` 历史文件；`/pd-focus history` 与 `/pd-focus rollback` 直接扫描 `.history/`，不依赖旧 Prompt 历史注入。
- `backupToHistory` 保留，但唯一生产用途收敛为显式 rollback 前备份当前文件。
- `getHistoryVersions` 随旧 Prompt full 注入退役；`cleanupHistory` 与 `archiveMilestonesToDaily` 随自动/手动压缩退役，不得因保留 `.history/` 而保留无消费者的压缩清理代码。
- rollback 仅由 Owner 显式触发；恢复时按原始 Buffer 字节复制历史文件，不重新编码、不改换行/BOM、不追加版本/日期/ROLLBACK 状态文本。
- 不新建自动快照系统，不自动清理 Owner 历史备份。

## 8.3 文件级处置清单（以技术审查 §H.2 为依据）

| 模块 | 处置 | 关键点 |
|---|---|---|
| `openclaw-plugin/src/core/focus-history.ts` | **大幅收缩** | 保留 `backupToHistory`（仅供显式 rollback 前备份）；删除 `getHistoryVersions`、`cleanupHistory`、`archiveMilestonesToDaily`、`compressFocus`、`autoCompressFocus`、`needsAutoCompression`、`recoverFromTemplate`、`safeReadCurrentFocus` 及仅供这些路径使用的私有辅助函数。history 列表和 rollback 直接扫描 `.history/` |
| `principles-core/src/prompt-builder/focus-compression.ts` | **按消费者收缩** | 运行时只保留 status/history/rollback 仍需要的 `extractVersion` / `extractDate`。Working Memory、summary 注入、自动/手动压缩等函数不再有内部生产消费者；删除内部实现与 barrel 导出。若发布包兼容策略要求保留旧导出，只允许保留明确 deprecated 的兼容转发，不得恢复任何内部调用；同步更新 export-surface fixture 与架构守卫 |
| `openclaw-plugin/src/hooks/lifecycle.ts` | **退役写路径** | 删除 `extractAndSaveWorkingMemory` 及其 Compaction 调用和专属 imports；保留既有 pre-compaction checkpoint 与 pain extraction，不扩大改动范围 |
| `openclaw-plugin/src/hooks/prompt.ts` | **删除旧读取与注入** | 删除 `safeReadCurrentFocus` / `autoCompressFocus` / `getHistoryVersions` / Working Memory 解析与注入；删除 projectFocus summary/full 注入段；其他 THINKING_OS 等独立上下文不受影响 |
| `openclaw-plugin/src/commands/focus.ts` | **保留 + 收敛** | 保留 status/history/rollback；删除 compress 子命令、第二套压缩实现、压缩相关文案/imports。status 改为显示文件存在性、大小、行数和更新时间，不再依赖旧任务/版本元数据；rollback 以原始字节恢复，不重写内容 |
| `openclaw-plugin/src/commands/strategy.ts` | **保留 + 语义更新** | `/pd-init`（别名 `/pdi`）只访谈并输出草案，不自动写入 CURRENT_FOCUS；见 §8.4 |
| `openclaw-plugin/src/core/init.ts` + `templates/workspace/okr/` | **移除旧模板自动创建路径** | 删除旧 `CURRENT_FOCUS.md` 工作记忆模板，确保 `ensureWorkspaceTemplates` 的普通 Prompt 启动路径不会创建该文件；统一模板由 `pd runtime init --confirm` 放置 |
| `packages/pd-cli/src/commands/runtime-init.ts` | **扩展既有显式初始化** | 增加单一 Principle Context 模板常量和 create-only-if-missing 写入；dry-run 不写入，`--confirm` 才创建；不新增命令 |
| `openclaw-plugin/src/index.ts` / `openclaw-plugin/src/i18n/commands.ts` / `openclaw-plugin/README.md` | **同步命令表面** | 删除 `/pd-focus compress` 描述；保留 status/history/rollback 帮助 |
| `templates/workspace/okr/RECOVERY_PROTOCOL.md` 与官网 slash-commands 文档 | **同步语义** | 删除将 CURRENT_FOCUS 描述为任务里程碑/自动压缩工作记忆的旧表述 |
| `plugin-surface-registry.ts` | **维持现状** | 不开启 quiet surface，不改变既有治理策略；Focus 自动写行为退役后 registry 无需新条目 |
| Adaptive Selector | **增加轻量上下文输入** | 见 §5 |

删除代码之前必须检查所有真实调用者，不能只凭文件名称决定删除。

## 8.4 `/pd-init` 语义更新

`/pd-init` 是对话式整理入口，不是文件写入工具：

- 访谈 Owner，围绕长期背景 / 重要约束 / 当前方向形成三节草案。
- 将完整草案展示给 Owner，由 Owner 自行复制或手动编辑 `CURRENT_FOCUS.md`；命令不得自动创建、覆盖、迁移或重写该文件。
- 文件缺失时，提示使用既有 `pd runtime init --confirm --workspace <workspace>` 创建空模板；该初始化命令只 create-only-if-missing。
- 对存量旧文件，只提供整理建议，不自动转换历史任务/工作记忆内容。
- 不增加新的命令、存储或 Agent 自动写入权限。

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
- 清理无生产消费者的代码；`backupToHistory` 与 `.history/` 只因显式 rollback 保留。
- 从 OpenClaw 普通模板递归复制中移除 CURRENT_FOCUS 旧模板；`/pd-init` 改为草案输出。
- 同步命令帮助、插件 README、RECOVERY_PROTOCOL、官网 slash-commands 与架构文档，删除自动压缩/任务状态旧语义。
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

## Batch 3：三宿主统一交付（未授权；启动前置条件见本节末）

目标：初始化模板和真实集成验收。

包括：

- 扩展既有 `pd runtime init --confirm`，按当前 `workspaceDir` create-only-if-missing 放置统一模板；dry-run 零写入。
- OpenClaw 普通 `before_prompt_build` 模板复制不再创建 CURRENT_FOCUS；Codex 用户级/项目级与 WorkBuddy 全局治理 workspace 均通过同一 CLI 初始化逻辑放置。
- 三宿主真实 Adapter 集成测试（§11，非仅 Shared Runtime 单测）。
- 安全与隔离测试（各宿主 Workspace 隔离语义逐宿主验证；WorkBuddy 跨项目共享语义显式验证；Codex 双模分别验证）。

Gate 3：

- §11 矩阵三宿主全部通过；任一宿主失败不得以另外两个宿主的结果代替。

### Batch 3 启动前置条件：WorkBuddy 宿主可靠性缺口（2026-11-18 记录）

依据 `docs/audit/PD_WORKBUDDY_INTEGRATION_GAP_AUDIT_v0.1.md`（基线 2026-11-04，WorkBuddy Desktop 5.9.2 / 引擎 2.165.0 / PD 插件 0.2.2）与 2026-11-18 当前源码复核：

| 项 | 证据层级 | 事实 |
|---|---|---|
| GAP-01（P0）原则注入静默丢失 | **历史运行时证据**（2026-11-04 生产会话：`entry_deadline_exceeded:12021ms_budget_12000ms`，该会话注入 0 条） | 12s 自降级曾真实造成注入丢失；是否仍在当前生产发生**未重新取证** |
| GAP-02（P0）Delivery Evidence 无法表达 degraded | 历史源码 + 当前源码 | adapter 交付状态无法区分「空返回」与「降级」 |
| GAP-03（P0）wrapper 硬编码 deadline | **当前源码事实**（2026-11-18 复核） | `workbuddy-adapter/plugin/scripts/wrapper.cjs` 仍硬编码 `HOST_TIMEOUT_MS`（UserPromptSubmit 15s / default 30s）与 `SELF_TIMEOUT_MS`（12s / 25s），不读取实际生效的 `hooks.json`（镜像关系由 `plugin-skeleton.test.ts` 锁定） |
| Adaptive 执行预算 | **当前源码事实**（2026-11-18 复核） | `workbuddy-adapter/src/pd-hook.ts` 的 Adaptive outer deadline ≈ `5000ms − 进程启动耗时`，叠加 GAP-03 后超时降级风险仍在 |

**结论（硬约束）：** Batch 3 的真实宿主交付 Gate 受上述问题约束。Batch 3 开始前必须对 WorkBuddy 链路重新核实并处理 GAP-01/02/03 与 wrapper deadline 问题；**不得仅凭 Batch 2 的 Shared Runtime 单元测试宣布 WorkBuddy 已经可靠交付**。历史 2026-11-04 运行日志仅作为历史证据引用，不得据此直接断言当前生产环境仍在发生同样故障——当前状态须重新取证。Batch 2 已按 §5.8/§12.2 约束保证 Reader 是有界本地只读读取（不新增同步模型调用、网络请求、重试、证据持久化步骤，不改宿主 timeout 与 Hook exit code 语义）。

## Batch 4：价值验证（未授权；启动前置条件见本节末）

目标：分别验证「评分指令升级无回归」与「Principle Context 有真实价值」。**这是两项独立实验，不得合并为一组对照。**

**实验 A：Criteria v3 → v4 评分回归。**

- 目的：验证评分指令从 v3 升级到 v4 没有引入非预期评分漂移。
- 变量隔离：**v3 组与 v4 组都不发送 Principle Context**；Context 不进入本实验，否则无法隔离评分文案升级的影响。
- 固定：输入、候选原则集合、模型与请求条件、评分样本；唯一变量是 Criteria 版本及相应评分文案。
- 对比：评分结果变化、原有判断的一致性、错误选择、`insufficient_context` 行为。
- 通过标准：无显著非预期评分漂移，原有正确判断保持一致。数值阈值沿用已有实验契约；未获批准则标注「待 Owner 决策」。

**实验 B：Principle Context 价值验证。**

- 对照（固定 Criteria v4、候选集合、模型、授权范围与治理约束，唯一变量为 `principleContext` 字段）：
  - A 组：Existing Adaptive Input without Principle Context。
  - B 组：Existing Adaptive Input with Principle Context。
  - 说明：现有 Adaptive 请求本就含 priorMessages、candidates 等，故不称 A 组为 "Current Instruction only"。
- 评估：是否改善候选原则选择、是否减少错误激活、任务相关性、是否增加无关上下文误选、是否出现负迁移；并记录三宿主一致性、响应延迟、Token 成本、外部数据传输范围。
- 证据纪律：不得仅以模型给出的解释作为有效性证据，必须有可重复的评分/选择结果证据。
- 通过标准：有可重复的正向价值证据；数值阈值未获批准则标注「待 Owner 决策」。

Gate 4：

两项实验分别出具结论。**实验 B 若无可重复的正向价值证据，允许放弃 Principle Context 的 Adaptive 接入，保留 Batch 1 的旧机制清理成果**（Batch 1 是独立成立的缺陷修复）；此放弃不影响实验 A 关于评分契约升级本身的结论。

### Batch 4 启动前置条件（2026-11-18 记录）

1. **实验 A（Criteria v3 → v4 回归）**：两组（v3 组与 v4 组）均**不发送 Principle Context**、不产生任何 Context 文件读取；否则评分差异无法归因于评分文案升级（§5.4.3）。
2. **实验 B（Principle Context 价值验证）开始前，必须先确认无 Context 的 A 组（`Existing Adaptive Input without Principle Context`）具备可评估的有效基线**：A 组须能在既有样本上产出可重复、可区分的选择结果；若 A 组本身不可评估（如普遍 `insufficient_context`、判断随机），实验 B 不具备启动条件。
3. **数值阈值未获 Owner 批准前不得自行创造**：通过标准中凡涉及数值的部分一律标注「待 Owner 决策」。
4. **不得将 PRI-1182 的完成状态直接等同于 Selector 已通过价值基线**：PRI-1182 验证的是 Decisions 单次评分协议的正确性与验收批次指标，不是 Principle Context 的价值结论；实验 B 需要自己的可重复证据。

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

- 上下文进入 Decisions state 的形状有请求快照测试（criteria v4）；快照必须区别于 v3，证明 Context 位于第 3 层（`state` JSON 字符串内的可选键），信封顶层与候选结构不变（§5.2 四层契约）。
- **Criteria v4 四类判定测试**：Append 需 Context 支撑才给高分；Replacement 不因 Context 出现某原则而自动提权/替换；`insufficient_context` 在双重信息不足时可表达；指令优先级与注入式 Context 反例（历史 Focus 不被当作新命令、关键词不机械匹配）。
- **两项独立实验分别验收**：实验 A（v3→v4 评分回归）与实验 B（Principle Context 价值验证）各自出具结论；实验 B 不以模型解释作为有效性证据；未批准阈值标注「待 Owner 决策」（§5.4.3、§10 Batch 4）。
- **隐私边界测试**：授权关闭零外传；授权开启请求快照含 Context 正文且 ≤4,000 code units；日志/Telemetry/Trace/Journal/job/result 检索不到正文；撤销授权后下一轮不再携带 Context（§6.3.1）。
- **Reader 诊断枚举测试**：失败原因码属于有限枚举（`file_missing`/`unreadable`/`unsafe_path`/`too_large`/`read_failed`/`empty_content`/`normalize_failed`），不含正文、原始 OS 错误或绝对路径（§4.7、TD §3.2）。
- **初始化结果契约测试**：在现有 `RuntimeInitOutput` 上增量可选字段 `principleContext`，覆盖四态 `would_create`（dry-run 且不存在）/ `initialized`（confirm 成功）/ `skipped`（已存在，dry-run 与 confirm 均适用）/ `failed`；`failed` 才使顶层 `ok=false`，`would_create`/`skipped` 不计失败；文本输出含独立状态，JSON stdout 仅一个可解析对象，失败退出码 1，互斥走现有 emitFlagConflict；正常结果（形态 A，含 `mode`）必含该字段，参数互斥/异常错误（形态 B/C，`{ok:false, reason, nextAction}`）不含该字段（TD §6.4）。
- **Reader 路径安全反例测试**：父级 `memory/` 或 `memory/okr/` 是符号链接 / Windows junction → `unsafe_path` 且不读；路径验证后目标文件或父目录被并发替换（保存验证阶段身份，open 后与 `FileHandle.stat()` 比较，不一致 → `read_failed` fail-closed，且不返回被替换文件正文）；POSIX 用 `dev`+`ino` 判定；Windows 用 `birthtimeMs`+`size` 的 **best-effort 弱指纹**（`fstat` 不返回路径，resolved path 不参与比较），仅作尽力信号，不声称等价 inode 证明；读取只能通过已验证 FileHandle，不得出现检查 A 路径读取 B 路径；原始文件 >65,536 → `too_large`；读取上限 65,537（TD §3.3）。
- **初始化路径安全反例测试**：父目录符号链接指向 Workspace 外时不创建文件并返回 `failed`；目标文件已存在（含 symlink）时原始字节完全不变；并发初始化靠 `wx` 不覆盖 Owner 文件；禁用未逐级校验的 `mkdir({recursive:true})`；不声称彻底消除跨进程 TOCTOU（TD §6.2）。
- **Context 四态行为测试（I/O 与评分必须分开断言）**：S1 未授权 → 零 stat / 零 read；S2 已授权但不可用（missing/invalid/unreadable/超限）→ 允许且仅允许一次有界读取尝试，之后才得出"不可用"结论；S3 已授权但预算移除 → 读取与规范化已完成、字段被移除；S4 可用 → 字段进入 `state` 且请求实际发出（`sends > 0`）。Reader 成功但请求未发出时不得断言 `sent`（诊断字段省略）。S1–S3 评分均退化为 v3 语义（不抬高 `insufficient_context`、候选/ID/裁决不变）；S4 仅辅助、不关键词提权、不触发替换、不绕过 Revalidation/Authority；恶意指令式 Context 不改变治理（P1-4、TD §5.1）。不得断言"无 Context 即零读取"。
- 空文件/纯空白 → missing。
- Adaptive readiness 不通过（flag/config/credential）时 Provider 不创建，走 Native，零 Context I/O；`sendPrincipleContext=false` 时已就绪 Adaptive 仍执行，但零 stat/零 read/零 Context 字段。
- skip 门命中时，即使 `sendPrincipleContext=true` 也必须零文件 I/O。
- Codex Background 在后台执行阶段读取；job/result/跨进程载荷中不得包含 Context 正文。
- 初始化模板只由 `pd runtime init --confirm` 创建；dry-run 零写入，目标已存在时字节不变；OpenClaw 普通 Prompt Hook 不得自动创建。
- `/pd-init` 只输出草案、不写文件；`/pd-focus rollback` 恢复历史原始字节，不注入版本/日期/状态文本。
- Reader 拒绝指向 workspace 外部的符号链接目标，不得借 CURRENT_FOCUS 路径读取 workspace 外文件。
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

- 单次上下文读取有严格上限（64 KiB 原始字节 / 4,000 JavaScript UTF-16 code units 上下文 / 20,000 JavaScript UTF-16 code units 的 `{state, questions}` 预算）。
- 不扫描完整 Session 历史。
- 不进行后台自动维护。
- 不新增周期性任务。
- 不增加模型请求次数。
- 上下文读取失败不影响 Native Activation。
- Adaptive readiness 不通过时不创建 Provider；`sendPrincipleContext` 未授权时已就绪 Adaptive 仍可无上下文运行，但 Context 路径零 stat、零 read、零发送。

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
| 上下文读取失败 | `missing / invalid / unreadable` 均省略 Context 字段，已就绪 Adaptive 继续无上下文评分；Adaptive readiness 不通过则走 Native |
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

历史技术审查报告（基线 `23c4c477a`）的 PC-D1..D10 已有明确修订落点；2026-11-16 当前 main 源码复核发现的 SRC-R1..R7 已在本次修订中收口。

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

## 15.1 当前 main 源码复核追踪（基线 `49d55e9374b0500be52ba087d89187b793e2b8e0`）

| 发现 | 代码证据 | SPEC / 技术方案处置 |
|---|---|---|
| SRC-R1 readiness 与 Context 授权混为一谈 | `adaptive-priority-provider.ts`: 工厂先调用 `resolveAdaptiveSelectionModel`；Provider 内才调用 `decideAdaptiveSkip` | §5.1/§6.2 区分 readiness、skip、send consent；`sendPrincipleContext=false` 不关闭 Adaptive |
| SRC-R2 预算单位写成“字符”不精确 | `adaptive-decision-protocol.ts`: `JSON.stringify({state: body.state, questions}).length`；`adaptive-selection.ts`: `currentInstruction.length` | §5.3 明确 JavaScript UTF-16 code units；超限先移除 Context |
| SRC-R3 Codex Background 是独立执行入口但复用 Provider | `adaptive-background-append.ts`: `runAdaptiveBackgroundSelection` 调用共享 Provider | §5.1/§11 要求后台执行时读取，不把 Context 写入 job/result |
| SRC-R4 Focus 历史消费者判断有误 | `prompt.ts` 唯一调用 `getHistoryVersions`；`focus.ts` 的压缩路径使用 `cleanupHistory` / `archiveMilestonesToDaily`；rollback 使用 `backupToHistory` | §8.2/§8.3 仅保留 rollback 所需备份；删除旧 Prompt/压缩消费者 |
| SRC-R5 OpenClaw 普通 Prompt 路径会复制 CURRENT_FOCUS 模板 | `index.ts` 的 `before_prompt_build` 首次 workspace 初始化调用 `ensureWorkspaceTemplates`；该函数递归复制 `templates/workspace` | §7.5/§8.3 删除旧自动模板来源，改由显式 `pd runtime init --confirm` 创建 |
| SRC-R6 `/pd-init` 现有指令鼓励 Agent 直接生成 CURRENT_FOCUS | `commands/strategy.ts` 的 `handleInitStrategy` 返回“Generate CURRENT_FOCUS”指令 | §8.4 改为访谈与草案输出，不自动写文件 |
| SRC-R7 rollback 当前会重写元数据而非原样恢复 | `commands/focus.ts` 的 `rollbackFocus` 对历史内容执行版本/日期/状态替换后写回 | §8.2/§8.3 改为原始字节备份与恢复；显式操作，不自动维护 |


## 15.2 文档整改源码复核（最后基于 PR #2667 head `4799d6dd6`，2026-11-16）

> **2026-11-18 实施准备复核追加（Batch 1/2 实施基线 `origin/main = adbcfd33f4765fffee9de71055826edb8ed128a6`）：** 实施前按本节清单重新核实了下表全部源码及 Batch 1/2 实际涉及文件（含 `hooks/prompt.ts`、`hooks/lifecycle.ts`、`commands/focus.ts`、`commands/strategy.ts`、`core/focus-history.ts`、`core/init.ts`、`principles-core/src/prompt-builder/focus-compression.ts`、`adaptive-skip-decision.ts`、`adaptive-principle-revalidation.ts`、`adaptive-background-append.ts`、`codex-adapter/src/pd-hook.ts`、`workbuddy-adapter/src/pd-hook.ts`）。符号名、类型名、配置字段、CLI 参数与 Decisions 协议均与本节所载事实一致；新增复核结论：① `createAdaptivePriorityProviderForConfig` 的生产调用者共 4 处（OpenClaw `index.ts`、Codex `pd-hook.ts`、WorkBuddy `pd-hook.ts`、Codex Background `adaptive-background-append.ts`），授权求值落在该工厂即可覆盖全部宿主；② `focus-compression` 的生产消费者仅为 openclaw-plugin `focus-history.ts`（prompt/lifecycle/focus 命令经其转发）；③ `templates/workspace/okr/CURRENT_FOCUS.md` 仅经 `ensureWorkspaceTemplates` 的普通 Prompt 路径复制；④ WorkBuddy wrapper 硬编码 timeout 与 5s Adaptive 预算仍为当前源码事实（见 §10 Batch 3 前置条件）。完整 Reality Map 见实施准备报告。

按 §0.1.1 范围逐份复核以下重点源码；最后核查基于 head `4799d6dd6` 与最新 `origin/main = 45a7fd706`（二者涉及本设计的 7 份关键源码逐字节一致）。符号名、类型名、配置字段、CLI 参数与 Decisions 协议均未变化；下列事实是 Technical Design v0.3 实施契约的依据，不得凭推测新增不存在的函数或参数。

| 源码 | 已核对的关键事实 | 对应实施契约 |
|---|---|---|
| `principles-core/src/runtime/config/pd-config-types.ts` | `AdaptiveActivationConfig` 配置节结构 | TD §2.1 增加 `sendPrincipleContext?: boolean` |
| `principles-core/src/runtime/config/pd-config-validate.ts` | `ADAPTIVE_ACTIVATION_KEYS` 为封闭白名单；未知键拒绝 | TD §2.2 白名单扩展 + boolean 校验四规则 |
| `host-runtime/src/adaptive-priority-provider.ts` | `createAdaptivePriorityProviderForConfig` 在 Provider 创建前做 readiness；`createAdaptivePriorityProvider` 内执行 skip | TD §1/§2.3 授权一次性求值并注入闭包 |
| `host-runtime/src/adaptive-selection.ts` | `runAdaptiveSelection` 内部调用 `buildDecisionRequest` | TD §4 接线与 state 构造 |
| `host-runtime/src/adaptive-decision-protocol.ts` | `DecisionRequestEnvelope.state` 是 JSON **字符串**；`ADAPTIVE_DECISION_CRITERIA.version` 当前 `v3-20261112`；question ID 动态闭集；预算按 `{state, questions}` 计 | TD §4.2 四层序列化、§4.3 预算、§5 评分契约 |
| `pd-cli/src/commands/runtime-init.ts` | 参数 `--workspace/--dry-run/--confirm/--json`；输出 `RuntimeInitOutput` **当前无 `principleContext` 字段**；`--dry-run`/`--confirm` 互斥；失败 `exitCode=1`；config 父目录用未校验 `mkdirSync(recursive)` | TD §6.4 增量结果契约、§6.2 逐级安全创建 |
| `pd-cli/src/services/cli-output.ts` | `emitResult` 单 JSON 对象到 stdout；`emitFlagConflict`/`emitError` 文本模式走 stderr、`--json` 模式以 `{ok:false, reason, nextAction}` 单对象输出到 stdout | TD §6.4 输出规范与形态 A/B/C 区分 |
| `pd-cli/src/commands/codex-setup.ts` / `workbuddy-setup.ts` | 两者**都不执行 init**，只 `existsSync(.pd/config.yaml)`，缺失则 refuse 提示先跑 `pd runtime init --confirm` | TD §6.1 setup≠init |
| `pd-cli/src/services/pd-config-loader.ts` | 配置加载与校验入口 | TD §2 配置读取链（一次性求值，不每轮重读） |
| `codex-adapter/src/pd-hook.ts` + `host-runtime/src/pd-config.ts` | 用户级 workspace = `path.resolve(CODEX_HOME \|\| ~/.codex)/pd-workspace`（未设置回退 `~/.codex`）；`resolveNearestPdWorkspace` 从绝对 cwd 向上找含 config 的目录，找不到返回 `config_not_found`（不创建/不伪造 workspace） | TD §6.3 Codex 命令 |
| `openclaw-plugin/src/index.ts` | `before_prompt_build` 调用 `ensureWorkspaceTemplates`；per-event agent workspace（`ctx.workspaceDir`） | TD §6.3 OpenClaw 命令、§7.1 模板移除 |
| `install-layout/src/index.ts` | `getWorkbuddyWorkspaceDir(homeDir) = resolve(homeDir)/.workbuddy/pd-workspace`，**无环境变量覆盖** | TD §6.3 WorkBuddy 可执行命令 |
| `workbuddy-adapter/src/workspace-resolution.ts` | `resolveWorkbuddyWorkspace()` 调用上述函数；用户级共享治理 workspace | TD §6.3 WorkBuddy 命令、隐私边界（跨项目共享） |
| `pd-cli/src/utils/path-security.ts` | 词法包含原语（物理符号链接约束需 Reader/初始化自行补足） | TD §3.3 Reader 路径安全 |

---

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
| `docs/technical-design/PD Principle Context Technical Design v0.3.md` | 本 SPEC 的实施级技术方案：完整授权传递链、Criteria v4 四类评分契约与两组实验、Reader 路径安全与有限诊断枚举、Decisions state 四层序列化、外传与隐私披露、三宿主可执行初始化命令与结果契约、旧 Focus 退出清单、验收与批次边界；不得另行解释或扩大本 SPEC。v0.2 为整改前基线，已被 v0.3 取代 |

---

**SPEC v1.1（2026-11-16 修订；2026-11-18 实施准备修订）结束。状态：Implementation Authorized: Batch 1 and Batch 2 only（§0.4）。本授权不构成 Batch 3 / Batch 4 的开发批准，也不代表 Principle Context 项目整体完成（§16）。**
