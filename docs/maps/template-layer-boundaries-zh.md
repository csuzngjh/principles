# Principles Disciple 模板分层地图

> Updated: 2026-03-18
> Purpose: 划清“给用户的通用模板”和“我们内部迭代团队”的边界，避免模板、实例、团队治理混在一起

## 一句话结论

当前仓库里其实有两套不同性质的东西：

1. **通用模板层**
   面向所有安装 Principles Disciple 的用户，负责下发默认 Agent 模板与工作区骨架。
2. **内置团队层**
   面向我们自己迭代 Principles Disciple，用来组织 `main / pm / resource-scout / repair / verification` 这支内部团队。

如果不把这两层分开，后面就会出现一个典型问题：
我们会不小心把“迭代 Principles 自己的偏好”塞进“所有用户默认模板”里。

## 第一层：通用模板层

这层的真实模板源在：

- `packages/openclaw-plugin/templates/langs/zh/core/`
- `packages/openclaw-plugin/templates/langs/en/core/`
- `packages/openclaw-plugin/templates/workspace/`

### 这一层负责什么

- 定义默认 Agent 的基础人格和工作方式
- 定义默认工作区的原则、状态、OKR、计划骨架
- 为“任意领域任务”提供可复用起点

### 这层里的文件应该是什么类型

**应该放这里的：**

- 通用 `AGENTS.md`、`SOUL.md`、`IDENTITY.md`、`TOOLS.md`、`USER.md`
- 通用 `HEARTBEAT.md`、`BOOTSTRAP.md`
- 通用 `.principles/PROFILE.json`
- 通用 `.principles/THINKING_OS.md`
- 通用 `PLAN.md`
- 通用 `okr/CURRENT_FOCUS.md`、`WEEK_TASKS.json`

**不应该放这里的：**

- 专门为了迭代 Principles Disciple 自己而写的 OKR
- 针对当前云端实例、当前仓库、当前分支的运行经验
- 内部团队角色如 `pm / resource-scout / repair / verification` 的项目专属职责
- 对 OpenClaw 上游、当前 bug、当前部署环境的特定假设

### 当前已确认的模板职责分工

`templates/langs/*/core/`

- 更像“Agent 启动人格层”
- 决定启动时先读什么、怎么记忆、怎么看待工作区、怎样进行 heartbeat、自主性边界是什么

`templates/workspace/`

- 更像“项目治理层”
- 决定安装后工作区里有哪些默认治理文件和隐藏系统文件
- 包括 `.principles/`、`.state/`、`okr/`、`PLAN.md`、`AUDIT.md`

## 第二层：内置团队层

这层的真实位置在：

- `myagents/main/`
- `myagents/pm/`
- `myagents/resource-scout/`
- `myagents/repair/`
- `myagents/verification/`
- `myagents/shared/governance/`
- `myagents/shared/skills/`

### 这一层负责什么

- 作为我们自己的“Principles Disciple 运维与迭代团队”
- 让内部角色分工清楚，而不是让一个 Agent 同时做管理、产品、修复、验证
- 在真实运行环境里承接 issue、proposal、repair、verification 流程

### 这层里的文件应该是什么类型

**应该放这里的：**

- `main` 作为 `Principle Manager` 的角色规则
- `pm` 作为产品智能体的目标、视角、交付方式
- `resource-scout` 的侦察/分诊职责
- `repair`、`verification` 的内部团队规则
- `TEAM_CHARTER.md`、`TEAM_OKR.md`、`WORK_QUEUE.md`
- 标准交付物模板：`Issue Draft / Proposal Draft / Repair Task / Verification Report`
- 团队级 skills 与工作流

**不应该直接上升到通用模板层的：**

- 当前内部团队的角色编制
- 当前仓库的 OKR、周报、周治理细节
- 只适用于“继续迭代 Principles Disciple 本身”的协作协议

## 第三类：内部工具包，不等于用户模板

这里有一个特别容易混淆的区域：

- `myagents/main/core/`

目前看它更像：

- 内部工具包
- 实验性辅助脚本
- 运行中的方法封装

例如当前已有：

- `myagents/main/core/safe-edit.js`
- `myagents/main/core/example-usage.js`
- `myagents/main/core/test-safe-edit.js`

这类内容不应直接被视为“默认用户模板”的组成部分。
如果后面要产品化，应该先判断它属于哪一类：

1. 值得进入插件正式能力
2. 值得成为团队内部 skill / util
3. 只是一段当前环境里的实验资产

## 当前发现

### 1. 真实的产品模板源已经很明确

对外下发的默认模板源不是 `myagents/`，而是：

- `packages/openclaw-plugin/templates/langs/*/core/`
- `packages/openclaw-plugin/templates/workspace/`

这意味着以后如果我们要优化“安装后默认 Agent 长什么样”，优先改这里。

### 2. `myagents/` 更像“内部团队实例层”

`myagents/` 现在更接近：

- 内部团队工作区
- 种子智能体实例
- 真实运行环境中长出来的角色工作区

它对产品设计很重要，但它不是通用模板的唯一真相源。

### 3. 目前通用模板还偏“单智能体骨架”

当前 `templates/` 更多是在提供：

- 单智能体的人格与治理骨架
- 工作区原则层和状态层

但还没有清晰产品化成“多智能体通用模板包”。

这意味着后面如果我们想支持“用户开箱即用一组智能体”，更合理的做法是：

- 在通用模板层新增多智能体模板族
- 而不是直接把 `myagents/main / pm / resource-scout` 原样复制给所有用户

### 4. 中英模板之间存在不对齐

当前已看到一个明显信号：

- `packages/openclaw-plugin/templates/langs/en/core/PRINCIPLES.md` 存在
- `packages/openclaw-plugin/templates/langs/zh/core/` 当前没有对应的 `PRINCIPLES.md`

这说明模板层还存在语言版本不对齐问题。

### 5. 通用治理模板还偏薄

例如：

- `packages/openclaw-plugin/templates/workspace/PLAN.md`

现在仍然非常薄，只是一个占位骨架。对于复杂任务和团队协作来说，后面需要更强的结构化模板。

### 6. 中文模板存在编码异常风险

当前多处中文模板在终端里显示为乱码。即使部分只是显示问题，这件事也会直接影响：

- 维护体验
- 用户初次安装后的可信度
- 模板后续演化效率

这应被视为模板层质量问题，而不是小瑕疵。

## 建议的产品化分工

后面建议把模板设计拆成 3 套，而不是 1 套：

### A. 单智能体通用模板

面向只需要一个 Agent 的用户，例如：

- 研究助手
- 股票分析助手
- 内容助手

### B. 多智能体通用模板

面向需要“一组角色协作”的用户，但领域不固定，例如：

- Manager + Scout + Executor
- Manager + Analyst + Verifier

这层应该是领域无关的。

### C. Principles 内置运营团队模板

面向我们自己维护这个项目，允许带有明显的项目特化信息，例如：

- `Principle Manager`
- `Product Manager`
- `Scout + Triage`
- `Repair`
- `Verification`

这层应该保留在 `myagents/` 及团队文档体系里。

## 后续改造顺序

建议按这个顺序继续推进：

1. 先把 `packages/openclaw-plugin/templates/` 清洗成真正稳定的通用模板层
2. 再定义“单智能体通用模板”和“多智能体通用模板”的边界
3. 保持 `myagents/` 作为内置团队层，不把当前实例内容直接塞回产品默认模板
4. 只把 `myagents/` 中真正通用、非环境依赖的静态文件提纯后回流到模板层

## 文件归属速查

### 应视为通用模板层

- `packages/openclaw-plugin/templates/langs/zh/core/*`
- `packages/openclaw-plugin/templates/langs/en/core/*`
- `packages/openclaw-plugin/templates/workspace/*`

### 应视为内置团队层

- `myagents/main/*`
- `myagents/pm/*`
- `myagents/resource-scout/*`
- `myagents/repair/*`
- `myagents/verification/*`
- `myagents/shared/governance/*`
- `myagents/shared/skills/*`

### 应视为内部工具/实验层

- `myagents/main/core/*`

## 一句话收尾

以后判断一个文件该改哪里，只先问一句：

**“这是要发给所有用户的默认模板，还是我们自己这支内部团队的运行资产？”**

这个问题一旦先问清楚，后面的设计就不会乱。
