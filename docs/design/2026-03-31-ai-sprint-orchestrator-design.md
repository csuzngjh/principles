# AI Sprint Orchestrator 设计方案

**日期**: 2026-03-31  
**状态**: Proposed  
**适用范围**: `D:/Code/principles` 当前仓库与本地 AI 环境  
**目标读者**: PD 核心维护者、AI 编码助手、任务编排维护者

## 1. 背景

当前仓库已经同时使用多个本地 AI 编程助手，包括：

- `opencode`，当前优先模型为 `minimax-cn-coding-plan/MiniMax-M2.7`
- `iflow`，当前优先模型为 `glm-5`
- `claude`，当前优先模型为 `GLM-5.1`

这些 AI 已经能够完成调查、实现、测试和评审，但当前工作方式仍然存在几个结构性问题：

- 编排依赖人工临时下达命令，缺少稳定的阶段机制
- 不同 AI 的调查结论没有统一格式，交叉核验成本高
- 任务推进容易停留在“单次对话驱动”而不是“阶段驱动”
- 缺少显式的停机条件、卡点上报和干预入口
- Codex 容易被迫参与过多长流程细节，浪费高价值配额

用户的目标不是获得更多 AI，而是建立一种高杠杆工作流：

> 用最少的 Codex 交互消耗，驱动多个本地 AI 长时间稳定工作，并通过结构化文件和阶段治理，让它们彼此监督、逐步收敛，直到产出物达到可接受质量，或者明确卡住等待人工干预。

## 2. 问题定义

### 2.1 核心判断

`AI Sprint Orchestrator` **不是**一个新的 AI 助手，也不是替代 `acpx`。

它要解决的是：

> 在当前仓库和当前本地环境中，把多个 AI 助手从“临时工具调用”收敛成“可持续推进的阶段化冲刺系统”。

它的价值不在于模型本身，而在于：

- 统一任务阶段
- 统一角色分工
- 统一信息交接
- 统一进度可观测性
- 统一停机和人工干预机制

### 2.2 这次设计面向什么场景

第一版只服务两个高价值场景：

1. 修 bug / 做代码修复
2. 做架构设计 / 审计 / 评审

尤其优先服务当前仓库中已经频繁出现的任务类型：

- 生产问题调查
- root cause 交叉核验
- 方案设计与审计
- 有测试约束的定向修复
- PR 前的多模型交叉 review

### 2.3 这次设计不解决什么

第一版不追求：

- 跨仓库通用平台
- 云端调度系统
- 图形化控制台
- 完整的长期任务队列基础设施
- 把所有 AI 适配成统一抽象

第一版只做：

- 可靠的本地阶段化编排
- 文件驱动的角色协作
- 可恢复、可审计、可人工干预

## 3. 设计目标

### 3.1 主目标

构建一个本地可运行的冲刺编排器，使其可以：

1. 自动连续推进多个阶段，直到达标或卡住
2. 每个阶段固定角色：
   - `producer`
   - `reviewer_a`
   - `reviewer_b`
3. 主要通过文件交接，而不是依赖对话记忆
4. 定期输出进度摘要，便于人工观察
5. 在必要时允许人工干预、暂停、终止
6. 把 Codex 放在高杠杆位置，仅做：
   - 任务拆解
   - 阶段目标设定
   - 冲突裁决
   - 最终核验

### 3.2 成功标准

第一版成功的最低标准是：

- 能对单个任务自动跑完多个阶段
- 每阶段至少完成一次 producer + 双 reviewer 交互
- 能根据 exit criteria 自动推进或停机
- 能把进度和卡点写入文件
- 能在当前 empathy 任务上跑出一轮真实结果

## 4. 设计哲学

### 4.1 文件是真相源，会话只是执行器

AI 会话不应成为唯一真相源。

每轮冲刺的当前状态、角色产出、评审意见、阶段结论都必须写入文件。这样即使：

- AI 会话中断
- `acpx` 会话不稳定
- 模型切换
- 本地 CLI 崩溃

系统仍然可以恢复。

### 4.2 阶段推进优先于自由对话

不是让 AI 无限对话，而是让它们围绕明确阶段工作：

- 当前阶段目标是什么
- 达标条件是什么
- 哪些问题阻止进入下一阶段

### 4.3 评审者是阻尼器，不是装饰

两个 reviewer 不是为了“看起来很高级”，而是明确承担：

- 反驳 producer 的薄弱推断
- 指出测试和验证缺口
- 检查是否偏离阶段目标
- 识别不必要的范围膨胀

### 4.4 自动推进必须有失控保护

自动循环只有在具备以下机制时才可接受：

- 最大轮次限制
- 最大运行时长限制
- 明确的 `halt_reason`
- 明确的人工干预入口
- 强制阶段摘要输出

## 5. 方案选型

### 5.1 备选方案

#### 方案 A：纯会话驱动

每个角色保持连续 ACP 会话，通过对话推进。

优点：

- 连续性强
- 文件较少

缺点：

- 容易上下文污染
- 恢复困难
- 会话不稳定时容易丢状态
- 不适合节省 Codex 配额

#### 方案 B：纯文件驱动

所有角色输入输出都严格通过文件完成，AI 执行仅消费和写回文件。

优点：

- 最可恢复
- 最可审计
- 最省主编排者 token

缺点：

- 速度稍慢
- 角色连续性略弱

#### 方案 C：混合驱动

文件是真相源，会话只是执行器。每轮执行都读取当前阶段文件，再写回产出文件。

优点：

- 可恢复性强
- 能利用 AI 会话的连续性
- 适合当前仓库和本地工具能力

缺点：

- 比纯文件方案稍复杂

### 5.2 推荐方案

**采用方案 C：混合驱动。**

关键落点是：

- 文件驱动状态机
- `acpx` 驱动角色执行
- 编排器脚本统一推进阶段

## 6. 第一版范围

第一版仅支持以下能力：

1. 单任务、多阶段自动推进
2. 固定三角色协作
3. 通过 `acpx` 调用 `opencode` / `iflow` / `claude`
4. 文件驱动状态与摘要
5. 手动终止与人工干预
6. 用当前 empathy 任务做真实试运行

第一版不做：

- Web UI
- 多任务并行调度
- 通用插件系统
- 自动 PR 合并
- 跨仓库共享工作池

## 7. 阶段模型

第一版采用固定阶段流水线：

1. `investigate`
2. `fix-plan`
3. `implement`
4. `verify`

### 7.1 `investigate`

目标：

- 收集证据
- 识别候选根因
- 形成可信根因集合

退出条件：

- 至少 1 个 producer 结论
- 至少 2 个 reviewer 审查
- 形成阶段决议，且列出最高置信根因和待证伪点

### 7.2 `fix-plan`

目标：

- 形成最小可执行修复方案
- 明确范围、测试、回滚点、风险

退出条件：

- 形成明确实施步骤
- reviewers 同意范围受控
- 有验证清单

### 7.3 `implement`

目标：

- producer 实施改动
- reviewers 发现实现缺口和测试缺口

退出条件：

- 代码已修改
- 目标测试已运行
- reviewers 没有剩余阻断问题

### 7.4 `verify`

目标：

- 验证修复是否真实生效
- 验证没有引入明显回归

退出条件：

- 有验证证据
- reviewers 认可验证充分性

## 8. 角色模型

### 8.1 Producer

职责：

- 产出当前阶段主要工作结果
- 实施调查、设计、代码修改或验证

约束：

- 不得跳过阶段目标
- 必须输出结构化结果文件

### 8.2 Reviewer A

职责：

- 从正确性和风险角度反驳 producer

重点：

- 根因是否站得住
- 实现是否遗漏边界
- 验证是否存在假阳性

### 8.3 Reviewer B

职责：

- 从范围控制和质量角度审查 producer

重点：

- 是否过度改动
- 是否缺少测试
- 是否存在更小修复路径

### 8.4 Orchestrator

职责：

- 分发阶段任务
- 聚合角色结果
- 判断是否进入下一阶段
- 在冲突或停滞时生成 `halt_reason`

第一版里，Orchestrator 由仓库内脚本 + Codex 共同承担。

## 9. 文件结构

第一版建议目录：

```text
ops/ai-sprints/
  <task-id>/
    sprint.json
    timeline.md
    latest-summary.md
    stages/
      01-investigate/
        brief.md
        producer.md
        reviewer-a.md
        reviewer-b.md
        decision.md
      02-fix-plan/
        ...
      03-implement/
        ...
      04-verify/
        ...
```

### 9.1 `sprint.json`

作为主状态文件，至少包含：

- `taskId`
- `title`
- `status`
- `currentStage`
- `currentRound`
- `maxRoundsPerStage`
- `maxRuntimeMinutes`
- `haltReason`
- `createdAt`
- `updatedAt`

`haltReason` 在 v1 中应优先使用结构化对象，而不是自由文本，至少包含：

- `type`
- `stage`
- `round`
- `details`
- `blockers`

### 9.2 `timeline.md`

人类可读的阶段推进历史。

### 9.3 `latest-summary.md`

当前最重要的状态摘要，供你快速查看：

- 当前阶段
- 当前轮次
- 最新 producer 结论
- reviewer 主要阻断点
- 是否偏航
- 是否需要人工干预

## 10. 执行模型

每个阶段采用固定循环：

1. 编排器生成阶段 `brief.md`
2. 为每个角色创建 `worklog` 和 `state` 占位文件
3. 调用 producer 执行
4. producer 在工作过程中持续写入 `producer-worklog.md` 和 `producer-state.json`
5. producer 最终产出 `producer.md`
6. 调用 reviewer_a
7. reviewer_a 在工作过程中持续写入 `reviewer-a-worklog.md` 和 `reviewer-a-state.json`
8. reviewer_a 最终产出 `reviewer-a.md`
9. 调用 reviewer_b
10. reviewer_b 在工作过程中持续写入 `reviewer-b-worklog.md` 和 `reviewer-b-state.json`
11. reviewer_b 最终产出 `reviewer-b.md`
12. 编排器聚合并生成 `decision.md`
13. 若达标，进入下一阶段
14. 若未达标，提升轮次并继续当前阶段
15. 若超出阈值，写入 `haltReason` 并暂停

## 11. 自动推进规则

### 11.1 达标推进

满足当前阶段 exit criteria 时，自动进入下一个阶段。

### 11.2 停滞保护

出现以下任一情况时暂停：

- 连续多轮没有实质性新信息
- reviewers 连续指出同一阻断点
- 超过阶段最大轮次
- 超过总运行时长
- 工具错误导致无法继续

### 11.3 人工干预入口

允许人工：

- `pause`
- `resume`
- `abort`
- `override-stage`
- `inject-guidance`

第一版通过修改 `sprint.json` 和再次运行编排命令实现。

推荐的 `haltReason.type` 取值包括：

- `max_rounds_exceeded`
- `max_runtime_exceeded`
- `reviewer_deadlock`
- `agent_error`
- `operator_pause`
- `operator_abort`

## 12. 可观测性

第一版至少输出：

- 当前阶段
- 当前轮次
- 最近一轮的主要结论
- reviewers 的阻断点
- 下一步动作
- 是否需要人工干预

这能避免“AI 在后台跑，但人完全不知道它现在偏没偏”。

此外，每个角色还应强制维护：

- `producer-worklog.md`
- `reviewer-a-worklog.md`
- `reviewer-b-worklog.md`
- `producer-state.json`
- `reviewer-a-state.json`
- `reviewer-b-state.json`

这样即使单次执行很长、上下文压缩、会话中断，后续角色也能从本地文件恢复。

## 13. 推荐模型分工

基于当前本地环境，第一版推荐分工为：

- `producer`: `opencode` + `minimax-cn-coding-plan/MiniMax-M2.7`
- `reviewer_a`: `iflow` + `glm-5`
- `reviewer_b`: `claude` + `GLM-5.1`

理由：

- `opencode(M2.7)` 适合长执行和实现
- `iflow(glm-5)` 适合大范围调查和审计
- `claude(GLM-5.1)` 额度较贵，优先用于高价值 review，而不是长跑执行

同时应允许：

- reviewer_b 缺席时，用 `iflow` 补第二个 reviewer
- 降级成双角色模式

考虑到当前 quota 约束，v1 的默认实现可以先采用：

- `producer`: `opencode` + `minimax-cn-coding-plan/MiniMax-M2.7`
- `reviewer_a`: `iflow` + `glm-5`
- `reviewer_b`: `iflow` + `glm-5`

`claude(GLM-5.1)` 作为升级版 reviewer 或争议仲裁角色按需启用。

## 14. 第一版脚本与接口

建议新增：

- `scripts/ai-sprint-orchestrator/`
  - `run.ts`
  - `stage-runner.ts`
  - `agent-runner.ts`
  - `state-store.ts`
  - `summary-writer.ts`

建议命令：

- `npm run ai-sprint -- --task empathy-runtime-fix`
- `npm run ai-sprint -- --resume <task-id>`
- `npm run ai-sprint -- --abort <task-id>`

## 15. 与当前 empathy 任务的关系

第一版直接拿当前任务做试运行：

- 阶段 1：调查 observer 异常
- 阶段 2：制定 PD-only 修复方案
- 阶段 3：实现修复
- 阶段 4：验证修复

这样可以同时验证：

- 编排器是否真的能工作
- 它是否能帮当前最痛的问题提效

## 16. 风险与缓解

### 风险 1：AI 会话不稳定

缓解：

- 文件是真相源
- 每轮都能恢复

### 风险 2：任务范围失控

缓解：

- 固定阶段
- 强制 exit criteria
- reviewer 负责卡范围

### 风险 3：自动循环卡死

缓解：

- 最大轮次
- 最大时长
- `haltReason`

### 风险 4：Codex 仍被迫参与太多细节

缓解：

- 让 orchestrator 脚本承担重复性编排
- 让本地 AI 角色通过文件交接
- Codex 只在冲突和阶段裁决时介入

## 17. 分阶段落地计划

### Phase A：设计与脚手架

- 写设计文档
- 建立目录结构
- 实现最小状态文件与阶段推进骨架

### Phase B：角色执行集成

- 接入 `acpx`
- 支持 `producer/reviewer_a/reviewer_b`
- 支持文件输入输出

### Phase C：自动推进与停机机制

- 加入阶段 exit criteria
- 加入最大轮次/时长控制
- 加入摘要与时间线输出

### Phase D：用 empathy 任务试运行

- 在真实修复任务上跑一轮
- 调整模型分工、提示模板、摘要格式

## 18. 结论

这套编排器的核心，不是“更多 AI”，而是：

> 让多个 AI 在当前仓库和当前环境中，围绕明确阶段、明确角色、明确达标条件，稳定地推进一个任务，直到达标或明确卡住。

它适合当前仓库，因为：

- 当前仓库已经严重依赖多 AI 协作
- 当前最痛的问题正是缺少统一阶段治理
- 当前本地工具链已经具备实现它的条件

第一版最重要的要求不是功能多，而是：

- 稳定
- 可恢复
- 可观测
- 可干预
- 能在真实任务上立刻产生价值
