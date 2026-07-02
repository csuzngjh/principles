---
title: 开发指南
description: 参与 Principles Disciple 贡献 — 架构、编码规范与工作流。
---

# 开发指南

想要为 Principles Disciple 贡献代码?本指南涵盖你需要了解的架构、编码规范和开发工作流。

## 项目结构

```text
principles/
├── packages/
│   ├── principles-core/     # 纯领域逻辑、状态机
│   ├── openclaw-plugin/     # OpenClaw 钩子与事件格式化
│   ├── pd-cli/              # 命令行工具
│   ├── create-principles-disciple/  # 安装器
│   └── website/             # 文档站点(VitePress)
├── docs/
│   ├── architecture/        # 架构决策记录与模型
│   ├── adr/                 # 架构决策记录(ADR)
│   └── product/
│       └── PRODUCT_IDENTITY.md # 产品边界权威定义
└── CONTRIBUTING.md          # 贡献指南
```

## 架构概览

PD 遵循严格的三层分层架构:

### 核心层(`@principles/core`)

**位置**: `packages/principles-core/`

这是纯领域逻辑层,包含:
- Principle、Rule、Implementation 生命周期的状态机
- 内化流水线(MVP 4 个活跃 runner:Dreamer、Scribe、Artificer、Bridge)
- 激活流水线(MVP 3 个通道:prompt、code_tool_hook、defer_archive)
- Pain signal 处理与诊断
- 读模型与进化存储

**硬性规则**: 该层**不得**从 `openclaw-plugin`、`pd-cli` 或任何宿主层导入。它只依赖自身的契约和类型。

### 宿主层(`openclaw-plugin`)

**位置**: `packages/openclaw-plugin/`

这是集成层,包含:
- 拦截 agent 操作的 OpenClaw 钩子
- 事件载荷提取并委派给 core
- RuleHost 代码执行
- Slash 命令处理器

**硬性规则**: 该层**不得**包含复杂业务逻辑或诊断算法。它只提取事件载荷并委派给 `@principles/core`。

### CLI 层(`pd-cli`)

**位置**: `packages/pd-cli/`

面向操作员的命令行界面,提供:
- Pain signal 记录
- 运行时健康检查(canary)
- 内化队列检查
- 控制台服务器

## 核心领域模型

PD 的知识通过固定的三层结构演进:

```text
Principle  →  Rule  →  Implementation
(为什么/是什么)  (何时/何地/如何)  (具体可执行物)
```

### Principle(原则)

高度抽象、跨场景的指导方针。它解释 agent *为什么*应该改变行为。

- **类型层级**: Core Principle → Domain Principle → Scenario Principle
- **生命周期**: `candidate → probation → active → archived → deprecated`
- **关键规则**: 永远不要直接赋值 status。使用 `taskStateMachine.transition(task, 'succeed')`。

### Rule(规则)

从 Principle 派生的硬性、可测试契约。它指定 agent *何时*、*如何*响应。

- 必须回答: 属于哪个 Principle?什么场景?什么问题?如何测试?
- **执行类型**: `block | warn | log | requireApproval | propose_correction`

### Implementation(实现)

执行 Rule 的具体代码或提示词。

- **MVP 类型**: `code`(RuleHost 钩子)、`prompt`(上下文注入)
- **未来类型**: `skill`、`lora`、`test`(MVP 未激活)
- **生命周期**: `candidate → active → disabled → archived`
- 同一个 Rule 可以有多个 Implementation 候选,但同一时间只能有一个 `active`

## 激活通道(MVP)

MVP 当前激活三个通道:

| 通道 | 级别 | 载体 | 需要审批 |
|------|------|------|----------|
| `prompt` | L1(软) | 系统提示词注入 | 否 |
| `defer_archive` | 无 | 账本状态变更 | 否 |
| `code_tool_hook` | L2(硬) | RuleHost JS 代码 | 是 |

架构中还有一个通道但在 MVP 中**未激活**:
- `skill`(L1.5)— 拓展目标,尚未实现

## 开发工作流

### 分支命名

| 类型 | 格式 | 示例 |
|------|------|------|
| 功能 | `feature/<name>` | `feature/evolution-points` |
| 修复 | `fix/<issue-id>-<name>` | `fix/18-trust-engine` |
| 文档 | `docs/<name>` | `docs/readme-update` |

### 提交信息

遵循 [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<scope>): <description>
```

类型: `feat`、`fix`、`docs`、`refactor`、`test`、`chore`

### PR 要求

- 所有 PR 至少需要 1 名 reviewer
- CI 测试必须通过
- Lint 检查必须通过(`packages/openclaw-plugin/` 下 `npm run lint`)

### 决策矩阵

| 决策 | 决策者 |
|------|--------|
| 代码实现 | AI 贡献者 |
| 测试验证 | AI 贡献者 |
| PR 合并 | 人类维护者 |
| 战略方向 | 人类维护者 |

## 编码规范

### 禁止直接赋值状态

```typescript
// ❌ 错误
task.status = 'succeeded'

// ✅ 正确
taskStateMachine.transition(task, 'succeed')
```

### 契约集中化

所有核心实体 schema 都集中定义。导入它们,不要重新定义:

```typescript
// ❌ 错误 — 临时接口
interface TemporaryTask { ... }

// ✅ 正确 — 从契约导入
import { type PDTask, PDTaskSchema } from '../contracts/task-schema'
```

### 遵守层边界

```typescript
// ❌ 错误 — core 从 host 导入
import { something } from 'openclaw-plugin'

// ✅ 正确 — core 从自身契约导入
import { something } from '../contracts/...'
```

### Lint 规则

- `no-empty`: error
- `no-console`: warn
- `complexity`: max 10
- `@typescript-eslint/no-explicit-any`: warn
- `@typescript-eslint/no-unused-vars`: warn(下划线前缀参数豁免)

提交前运行:
```bash
cd packages/openclaw-plugin && npm run lint
```

## MVP 三问

每个新 issue 在实现前必须回答:

1. **不做会怎样?** — 30 天后还有人会在意吗?答不上来,issue 拒绝。
2. **如何观察?** — 用户如何验证它生效?UI?CLI?日志?没有可观察路径 = 拒绝。
3. **如何关闭?** — Feature flag?PR revert?如果只能 revert,flag 必须随 PR 一起提交。

## 关键架构文档

做架构变更前,请先阅读:

| 文档 | 用途 |
|------|------|
| `docs/architecture/DOMAIN_MODEL.md` | 核心本体 — Principle、Rule、Implementation |
| `docs/architecture/PD_SYSTEM_ARCHITECTURE.md` | 系统架构概览 |
| `docs/architecture/ACTIVATION_CHANNELS.md` | 5 通道激活设计 |
| `docs/architecture/INTERNALIZATION_PIPELINE.md` | 内化流水线设计 |
| `docs/architecture/SECURITY_ARCHITECTURE.md` | 安全模型 |
| `docs/product/PRODUCT_IDENTITY.md` | 产品边界与 MVP 契约(权威) |
| `docs/adr/0014-mvp-first-strategy-and-product-pivot.md` | MVP 策略与范围 |

## 报告 Issue

报告 bug 时,请包含:

- **问题**: 发生了什么
- **复现步骤**: 1、2、3...
- **预期行为**: 应该发生什么
- **实际行为**: 实际发生了什么
- **环境**: Node.js 版本、操作系统、OpenClaw 版本

Issue 跟踪: [github.com/csuzngjh/principles/issues](https://github.com/csuzngjh/principles/issues)
