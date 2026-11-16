# PD Principle Context
## Unified Context for Adaptive Activation
### Technical Design & Implementation SPEC v1.0

**状态：** Proposed — Owner Review Required

**日期：** 2026-11-15

**适用项目：** Principles Disciple (PD)

**目标宿主：** OpenClaw / Codex / WorkBuddy

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

复审报告确认：

1. Phase 1 原有八项任务均未完成。
2. 现有 Current Focus 写入路径在生产中被 quiet surface 静音。
3. 读取路径存在自动创建、修复和压缩覆盖 Owner 内容的问题。
4. Codex 和 WorkBuddy 没有对应的 Focus 实现。
5. Current Focus 尚未进入 Adaptive Activation 的上下文输入。

详见 2026-11-15 Current Focus Reaudit。

## 1.2 核心问题

原设计把两个不同的问题混在了一起：

A. Agent 如何管理自己的工作记忆？

B. PD 如何理解 Agent 当前所处的工作背景，从而选择合适的原则？

PD 真正需要解决的是 B。

A 属于宿主自身的工作记忆与任务管理能力，不应该由 PD 再建设一套重复系统。

## 1.3 新目标

将 Current Focus 收敛为 Principle Context。

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

**Workspace Context**

Owner 手动维护的长期背景、目标、战略方向和重要约束。

**Current Instruction**

当前用户指令，复用现有 Adaptive Activation 的 currentInstruction。

两者共同作为原则选择的上下文。

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

---

# 3. 产品与技术架构

## 3.1 目标架构

```text
                 OpenClaw
                    |
                  Codex
                    |
                 WorkBuddy
                    |
                    v
          Unified Host Adapter Contract
                    |
                    v
             Shared Host Runtime
                    |
          +---------+----------+
          |                    |
          v                    v
   Current Instruction   Principle Context
          |                    |
          +---------+----------+
                    |
                    v
             Adaptive Selector
                    |
                    v
           Candidate Validation
                    |
                    v
               Runtime V2
                    |
                    v
           Principle Activation
                    |
                    v
           Host Prompt Injection
```

## 3.2 架构边界

三个宿主负责：

- 提供当前工作区标识。
- 提供当前指令。
- 将宿主事件映射为统一的 Adaptive Context 输入。

Shared Host Runtime 负责：

- 统一上下文契约。
- 读取 Owner 提供的 Workspace Context。
- 校验上下文。
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

---

# 4. Principle Context 数据设计

## 4.1 数据来源

第一阶段复用现有文件：

`<workspace>/memory/okr/CURRENT_FOCUS.md`

不新增文件、不新增数据库、不新增持久化对象。

但不再把整个 CURRENT_FOCUS 当作上下文注入。

建议在现有文件中提供一个 Owner 明确维护的专用区域：

```markdown
## Principle Context

### Strategic Background

当前项目的长期目标和背景。

### Important Constraints

重要业务约束和技术约束。

### Current Direction

当前阶段的重要方向。
```

这是一个逻辑上的内容分区，不是新的独立文件或存储系统。

只有该明确分区中的内容才可以作为 Principle Context。

其他内容，包括旧 Working Memory、历史任务列表、自动生成的 artifacts，均不自动进入 Adaptive Context。

如果分区不存在，返回 unavailable。

不得自动创建模板或迁移内容。

Owner 可以自行从旧 CURRENT_FOCUS 中挑选有价值的信息放入该分区。

## 4.2 统一数据契约

建议在现有 Adaptive Context 协议中增加一个可选字段。

```typescript
type PrincipleContextAvailability =
  | 'available'
  | 'missing'
  | 'invalid'
  | 'unreadable';

interface PrincipleContext {
  availability: PrincipleContextAvailability;
  content?: string;
}

interface AdaptiveContextInput {
  currentInstruction: string;
  principleContext?: PrincipleContext;
  candidates: PrincipleCandidate[];
}
```

约束：

- 不增加 sessionId。
- 不增加 currentTask。
- 不增加 progress。
- 不增加任务状态。
- 不增加历史消息集合。
- 不增加持久化 revision。
- 不增加额外的模型判断字段。

上述类型是协议示意，实际实施应优先扩展现有类型，不重复创建同义接口。

## 4.3 内容限制

建议初始限制：

| 项目 | 限制 |
|---|---|
| 单个上下文区域 | 最大 4 KB UTF-8 |
| 原始文件读取 | 最大 64 KB |
| 内容格式 | 纯文本 / Markdown |
| 更新方式 | Owner 手动维护 |
| 读取方式 | 只读 |
| 读取失败 | unavailable |
| 缓存 | 第一版不新增持久缓存 |

超过限制时返回 invalid，不进行静默截断。

不记录上下文正文到普通日志。

## 4.4 信任边界

Principle Context 是业务背景数据，不是治理指令。

即使其中包含类似以下内容：

- 忽略其他规则；
- 绕过审批；
- 自动激活某项原则；
- 改变系统权限；

也不能改变 PD 的系统指令、原则授权或 Runtime V2 的决策。

它只能帮助 Selector 理解上下文，不能改变可选原则集合和权限边界。

---

# 5. Adaptive Activation 集成

## 5.1 集成位置

优先在现有 Shared Host Runtime 的 Adaptive Context 组装位置完成集成。

重点核查：

- `packages/host-runtime/src/adaptive-priority-provider.ts`
- `packages/host-runtime/src/adaptive-decision-protocol.ts`
- `packages/host-runtime/src/adaptive-selection.ts`
- 三个宿主现有 Adaptive 接入路径。

不新建独立 Adaptive Context 子系统。

## 5.2 选择逻辑

原则选择时使用：

```text
Current Instruction
       +
Principle Context
       +
Existing Candidate Principles
       |
       v
Existing Adaptive Selection
       |
       v
Existing Candidate Validation
       |
       v
Existing Runtime V2
```

其中：

Current Instruction 是当前操作的直接信号。

Principle Context 是长期背景和约束。

候选原则集合仍然来自现有 PD 原则体系。

## 5.3 重要限制

Principle Context：

1. 不允许增加候选原则。
2. 不允许激活未批准原则。
3. 不允许改变原则授权状态。
4. 不允许绕过 RuleCode 验证。
5. 不允许直接修改 Runtime V2 状态。
6. 不允许替代现有 Native Selector。
7. 不允许成为额外的模型决策步骤。

上下文只影响现有 Selector 对候选原则适用性的判断。

## 5.4 模型调用

不新增模型调用。

如果当前 Adaptive 决策已经使用模型辅助，则在现有请求中增加 Principle Context。

如果当前路径不使用模型，则不得为了 Principle Context 额外引入模型。

上下文的外部传输必须遵循现有 Adaptive 数据授权和隐私边界。若目标 Decision Provider 不具备经过验证的上下文传输授权，则不发送该字段。

## 5.5 Native Fallback

当 Principle Context：

- 文件不存在；
- 格式不合法；
- 读取失败；
- 超过长度限制；
- 未获准传输；

均不应导致 Adaptive Activation 失败。

Selector 回到现有 currentInstruction + candidates 路径。

Native Activation 继续正常工作。

---

# 6. 三宿主统一实施要求

## 6.1 统一原则

必须满足：

**One Contract, One Semantics, Three Adapters.**

禁止为 OpenClaw 建设一套完整能力，再将 Codex 和 WorkBuddy 留作后续事项。

## 6.2 宿主职责

| 能力 | OpenClaw | Codex | WorkBuddy |
|---|---|---|---|
| Workspace 定位 | Adapter | Adapter | Adapter |
| Current Instruction | Adapter | Adapter | Adapter |
| Principle Context 契约 | Shared | Shared | Shared |
| 内容解析与校验 | Shared | Shared | Shared |
| Selector 输入 | Shared | Shared | Shared |
| 降级行为 | Shared | Shared | Shared |
| Runtime V2 | Shared | Shared | Shared |

## 6.3 Workspace 定位

三个宿主必须将各自的 Workspace 根路径映射为同一个逻辑概念。

统一使用现有 CURRENT_FOCUS 路径规则：

`<workspace>/memory/okr/CURRENT_FOCUS.md`

不允许：

- OpenClaw 使用一个路径；
- Codex 使用另一种文件格式；
- WorkBuddy 使用独立数据库。

如果某个宿主无法提供可靠的 Workspace 根路径，必须先解决 Adapter 能力问题。

不得用其他宿主的路径代替。

## 6.4 统一交付门槛

三个宿主必须同时满足：

1. 能获得 Workspace 根路径。
2. 能提供当前指令。
3. 能读取相同的 Principle Context 分区。
4. 使用相同的内容校验规则。
5. 使用相同的 Adaptive 输入契约。
6. 失败时使用相同的降级语义。
7. 通过同一组核心契约测试。

**任何一个宿主未通过，不得宣布该功能正式完成。**

允许开发阶段分批实现，但禁止将单宿主实现宣布为产品交付。

---

# 7. 旧 Current Focus 机制处置

## 7.1 代码处置原则

| 现有模块 | 处理方式 |
|---|---|
| focus-history.ts | 保留必要的 Owner 历史备份能力；移除运行时自动恢复和维护依赖 |
| focus-compression.ts | 仅保留仍有实际消费者的纯函数；清理死字段和重复实现 |
| lifecycle.ts | 删除工作记忆自动提取和持久化路径 |
| hooks/prompt.ts | 删除读取时自动压缩和模板恢复；仅保留新的只读上下文消费 |
| commands/focus.ts | 评估现有命令消费者，逐步废弃自动压缩入口 |
| commands/strategy.ts | 保留 Owner 主动维护战略背景的能力 |
| plugin-surface-registry.ts | 不开启 quiet surface，不改变既有治理策略 |
| Adaptive Selector | 增加轻量上下文输入 |

删除代码之前必须检查所有真实调用者，不能只凭文件名称决定删除。

## 7.2 明确禁止

不实施原 Reaudit SPEC 的以下设计：

- focus-extractor 独立子系统。
- focus-maintainer 独立子系统。
- Session Working Set。
- 自动任务状态机。
- marker 区间自动维护系统。
- O_EXCL 锁和 revision CAS 工作记忆管理。
- workspaceFocusMaintenance Feature Flag。
- before_prompt_build 自动维护段。
- 新的 Compaction 事件依赖。

这些内容不再属于本 SPEC。

## 7.3 Owner 数据保护

必须首先消除现有读取路径的破坏性行为：

- Reader 不创建文件。
- Reader 不修复文件。
- Reader 不压缩文件。
- Reader 不修改文件。
- 不自动覆盖 Owner 内容。

旧 CURRENT_FOCUS 文件保留原样。

本项目不自动执行格式迁移。

---

# 8. 配置与兼容性

## 8.1 Feature Flag

不新增 Principle Context 专用 Feature Flag。

继续复用现有 Adaptive Activation Feature Flags。

Adaptive Activation 关闭时，不读取 Principle Context。

## 8.2 旧配置

现有 `projectFocus` 配置需要在实施前核实真实消费者。

建议：

- 停止将 summary/full 解释为整份 CURRENT_FOCUS 的自动注入模式。
- 将旧配置标记为 deprecated。
- 不新增与现有 Adaptive Flags 重复的控制开关。
- 旧配置兼容策略由迁移测试明确。

不得在未检查现有用户配置和消费者之前直接删除配置字段。

## 8.3 文件迁移

不需要数据库迁移。

不需要自动改写 CURRENT_FOCUS。

Owner 只需要在原文件中手动整理一个 Principle Context 区域。

没有该区域时，系统继续正常运行，只是不提供额外上下文。

---

# 9. 实施阶段

## Batch 0：最新源码与架构前置核实

目标：确认三个宿主可以共享同一个上下文输入。

任务：

1. 重新获取最新 origin/main。
2. 复核 Adaptive Activation 三宿主调用链。
3. 核实三个宿主 Workspace 根路径来源。
4. 核实三个宿主 currentInstruction 来源。
5. 核实 Shared Host Runtime 是否可以统一读取 Workspace 文件。
6. 核实 Decisions Provider 的数据传输边界。
7. 识别旧 Current Focus 的全部消费者。

交付：技术实施确认报告。

Gate 0：三宿主统一技术方案可行。

任何宿主存在无法解决的契约缺口，停止进入实现。

## Batch 1：遗留功能安全收敛

目标：彻底消除旧 Current Focus 的破坏性行为。

任务：

1. 移除 Reader 的自动创建与恢复。
2. 移除读取路径中的自动压缩。
3. 确保 Focus 读取失败不影响 Native Activation。
4. 禁用旧 Compaction 工作记忆维护路径。
5. 清理重复压缩实现。
6. 重写原有破坏性压缩测试。
7. 确保 Owner 文件内容不会被自动修改。

Gate 1：

- Reader 纯读。
- 原文件 SHA-256 不变。
- 失败时原则注入仍正常。
- 不新增自动写入行为。

## Batch 2：统一 Principle Context

目标：在现有架构中实现最小上下文能力。

任务：

1. 定义统一 Principle Context 类型。
2. 在现有共享运行时中实现必要的读取和解析。
3. 复用现有 Workspace 路径和文件读取机制。
4. 只提取 Owner 明确指定的上下文区域。
5. 加入长度与格式校验。
6. 将上下文传入现有 Adaptive Selector。
7. 保持 Native Fallback。
8. 不新增模型调用。

Gate 2：

同一份 Workspace 文件，在三个宿主中产生一致的规范化上下文结果。

## Batch 3：三宿主统一接入

目标：完成三个宿主的真实生产链路。

任务：

1. OpenClaw Adapter 接入。
2. Codex Adapter 接入。
3. WorkBuddy Adapter 接入。
4. 统一 Workspace 路径解析。
5. 统一 Current Instruction 传递。
6. 统一错误处理。
7. 统一隐私和数据传输策略。
8. 完成三宿主集成测试。

Gate 3：

三个宿主均通过相同的契约测试和生产装配测试。

## Batch 4：真实价值验证

目标：证明 Principle Context 能够提高原则选择质量。

使用相同场景进行 A/B 对照：

A 组：只有 Current Instruction。

B 组：Current Instruction + Principle Context。

对比：

- 原则选择相关性。
- 不相关原则误激活率。
- 应激活原则遗漏率。
- 不同宿主的选择一致性。
- 额外延迟。
- 模型调用次数。
- 数据传输范围。

必须使用相同候选原则集合和相同治理约束。

Gate 4：

有可重复的证据证明 Principle Context 对 Adaptive Activation 有正向价值。

如果没有可测量的收益，允许放弃该功能，而不是继续扩建。

---

# 10. 验收测试矩阵

| 测试场景 | OpenClaw | Codex | WorkBuddy |
|---|---|---|---|
| 正常读取 Principle Context | 必须通过 | 必须通过 | 必须通过 |
| 缺少上下文区域 | 必须通过 | 必须通过 | 必须通过 |
| 文件不存在 | 必须通过 | 必须通过 | 必须通过 |
| 文件格式损坏 | 必须通过 | 必须通过 | 必须通过 |
| 文件读取权限不足 | 必须通过 | 必须通过 | 必须通过 |
| 超过内容长度限制 | 必须通过 | 必须通过 | 必须通过 |
| 旧 Working Memory 被忽略 | 必须通过 | 必须通过 | 必须通过 |
| Owner 内容不被修改 | 必须通过 | 必须通过 | 必须通过 |
| Adaptive Flag OFF | 必须通过 | 必须通过 | 必须通过 |
| Native Fallback | 必须通过 | 必须通过 | 必须通过 |
| 不增加模型调用 | 必须通过 | 必须通过 | 必须通过 |
| 相同输入产生相同规范化上下文 | 必须通过 | 必须通过 | 必须通过 |
| Runtime V2 治理边界不变 | 必须通过 | 必须通过 | 必须通过 |

另需验证：

1. Principle Context 不能扩大候选原则集合。
2. Principle Context 不能覆盖 currentInstruction。
3. Principle Context 不能绕过原则审批。
4. 不存在跨 Workspace 内容泄漏。
5. 多 Session 共享的只有 Owner 明确维护的 Workspace 背景，不共享任何会话任务状态。
6. 外部 Decision Provider 未获授权时不得发送上下文。
7. 上下文读取不得产生文件写入。
8. 任何一个宿主失败，不得通过另外两个宿主的测试代替。

---

# 11. 性能与复杂度预算

本项目的一个核心目标是减少历史架构复杂度。

预期复杂度变化：

| 指标 | 允许变化 |
|---|---|
| 新数据库 | 0 |
| 新数据库表 | 0 |
| 新持久化状态 | 0 |
| 新 Session 管理系统 | 0 |
| 新模型调用 | 0 |
| 新 Feature Flag | 0 |
| 新宿主生命周期依赖 | 0 |
| 新治理权威 | 0 |
| 新独立子系统 | 0 |
| 新工作记忆维护系统 | 0 |
| 共享 Adaptive Context 可选字段 | 允许 1 个 |

性能要求：

- 单次上下文读取有严格字节上限。
- 不扫描完整 Session 历史。
- 不进行后台自动维护。
- 不新增周期性任务。
- 不增加模型请求次数。
- 上下文读取失败不影响 Native Activation。

---

# 12. 风险与回滚

| 风险 | 处理方式 |
|---|---|
| 旧 CURRENT_FOCUS 格式不统一 | 仅识别明确的 Principle Context 区域 |
| Owner 内容被误读 | 只读、明确区域、长度限制 |
| 某个宿主缺少 Workspace 信息 | 阻断统一交付 |
| 上下文误导原则选择 | Current Instruction 优先，保留候选验证 |
| 数据传输扩大 | 沿用现有授权边界，未验证时不传输 |
| 上下文读取失败 | 回退现有 Selector |
| 旧功能被删除后产生兼容问题 | 先查调用者，分批移除 |

回滚策略：

1. 回滚 Adaptive Context 输入字段。
2. 恢复现有 Selector 输入。
3. 不需要数据库回滚。
4. 不需要恢复被自动修改的 Workspace 文件，因为本方案禁止自动修改。
5. 不需要恢复 Session 状态。

---

# 13. Owner Decision

建议采用以下决策：

| ID | 决策事项 | 推荐 |
|---|---|---|
| OD-01 | 产品名称 | Principle Context |
| OD-02 | 治理基准 | SPEC v0.6 |
| OD-03 | 数据来源 | 原 CURRENT_FOCUS 中 Owner 明确指定的上下文区域 |
| OD-04 | currentTask | 不再建设 |
| OD-05 | 自动压缩与恢复 | 全部退出运行时路径 |
| OD-06 | Adaptive 接线 | 纳入本项目核心交付 |
| OD-07 | 三宿主 | 必须同时满足统一交付 Gate |
| OD-08 | 新增存储 | 不允许 |
| OD-09 | 新增模型调用 | 不允许 |
| OD-10 | 上下文数据外传 | 必须遵循现有授权边界 |

---

# 14. 最终完成定义

只有同时满足以下条件，才能宣布 Principle Context 完成：

1. 原 Current Focus 已经收敛为轻量上下文来源。
2. 不再存在运行时自动工作记忆维护。
3. Owner 内容得到保护。
4. Principle Context 已经进入 Adaptive Activation 的真实决策输入。
5. 不影响现有 Native Activation。
6. Runtime V2 仍是唯一治理与激活权威。
7. OpenClaw、Codex、WorkBuddy 三个宿主具有完全一致的功能契约。
8. 三宿主真实端到端测试通过。
9. A/B 测试证明其具有实际价值。
10. 没有新增独立存储、数据库、任务状态机或额外模型调用。

**最终产品定义：**

Principle Context 不是一个独立的 Agent 工作记忆系统。

它是 PD 理解 Agent 当前工作背景、帮助原则在正确场景中发挥作用的一项基础能力。

它的价值不在于记住更多信息，而在于帮助 PD 更准确地选择和激活原则。

---

**SPEC 结束。**
