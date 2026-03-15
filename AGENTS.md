# Principles Disciple 项目上下文

> **Evolutionary Programming Agent Framework** - 通过痛感信号驱动 AI Agent 自我进化的 OpenClaw 原生插件。

## 项目概述

**Principles Disciple** 是一个 AI Agent 进化框架，核心理念是 **"Fuel the evolution with pain"**。系统通过捕获错误、失败和用户挫败感（Pain 信号），将其转化为"原则"，驱动 Agent 从无情的工具进化为有"灵魂"的智能体。

- **版本**: v1.5.3
- **类型**: OpenClaw 原生插件 (Monorepo 结构)
- **语言**: TypeScript
- **仓库**: https://github.com/csuzngjh/principles.git

## 核心架构

### 四阶段进化引擎

| Phase | Action | Logic |
| :--- | :--- | :--- |
| **01. PAIN** | **Capture** | 每个错误、每次挫败都是进化的信号 |
| **02. BURN** | **Distill** | 不只是修复 bug，而是将其"燃烧"成原则 |
| **03. EVOLVE** | **Transcend** | 从无情工具进化为有灵魂的智能体 |

### 核心组件

1. **Pain 信号系统** (`src/hooks/pain.ts`)
   - 捕获工具调用失败、高危操作失败、门控拦截等事件
   - 计算痛感分数，写入 `.state/.pain_flag`
   - 触发进化队列任务

2. **Trust Engine** (`src/core/trust-engine.ts`)
   - 四阶段信任模型: Observer(1) → Editor(2) → Developer(3) → Architect(4)
   - 区分探索性操作（安全）和构建性操作（有风险）
   - 动态调整 Agent 权限

3. **Evolution Worker Service** (`src/service/evolution-worker.ts`)
   - 后台轮询服务（默认 15 分钟间隔）
   - 处理进化队列、检测队列、规则晋升
   - 生成进化指令

4. **Security Gate** (`src/hooks/gate.ts`)
   - 渐进式门控：基于信任阶段限制修改范围
   - 保护高危路径（`.principles/`, `.state/` 等）
   - 支持 PLAN.md 白名单机制

5. **Context Injection** (`src/hooks/prompt.ts`)
   - 多层上下文注入：核心原则、思维模型、反思日志、进化指令
   - 动态信任感知：注入当前信任分数和阶段信息

## 关键数据流

```
工具失败/门控拦截
       ↓
Pain 信号检测 (hooks/pain.ts)
       ↓
进化队列 (.state/evolution_queue.json)
       ↓
Evolution Worker Service 处理 (15分钟轮询)
       ↓
进化指令 (.state/evolution_directive.json)
       ↓
prompt.ts 注入到 Agent 上下文
       ↓
Agent 执行诊断/修复任务
```

## 目录结构

### 插件源码 (`packages/openclaw-plugin/`)

```
src/
├── commands/        # 斜杠命令处理器
│   ├── evolver.ts   # /pd-evolve 进化任务
│   ├── strategy.ts  # /pd-init 初始化策略
│   ├── thinking-os.ts # /pd-thinking 深度反思
│   └── trust.ts     # /pd-trust 信任查询
├── core/            # 核心服务
│   ├── trust-engine.ts   # 信任引擎
│   ├── evolution-engine.ts # 进化引擎
│   ├── pain.ts           # Pain 分数计算
│   ├── detection-service.ts # 检测漏斗
│   ├── dictionary-service.ts # 规则字典
│   └── hygiene/          # 认知卫生追踪
├── hooks/           # OpenClaw 钩子
│   ├── prompt.ts    # before_prompt_build 上下文注入
│   ├── gate.ts      # before_tool_call 安全门控
│   ├── pain.ts      # after_tool_call Pain 信号
│   ├── lifecycle.ts # 会话生命周期管理
│   └── subagent.ts  # 子 Agent 管理
├── service/         # 后台服务
│   └── evolution-worker.ts # 进化任务处理器
├── tools/           # 自定义工具
│   ├── deep-reflect.ts  # 深度反思工具
│   └── agent-spawn.ts   # Agent 生成工具
└── index.ts         # 插件入口
```

### 工作区布局（用户项目）

```
workspace/
├── AGENTS.md           # Agent 上下文文件
├── PLAN.md             # 任务计划（人类审批）
├── .principles/        # 🧬 身份层（隐藏）
│   ├── PROFILE.json    # Agent 配置
│   ├── PRINCIPLES.md   # 核心原则
│   ├── THINKING_OS.md  # 思维模型
│   └── models/         # 深度反思模型
├── .state/             # ⚡ 状态层（隐藏）
│   ├── evolution_queue.json    # 进化队列
│   ├── evolution_directive.json # 进化指令
│   ├── AGENT_SCORECARD.json    # 信任分数卡
│   ├── pain_dictionary.json    # Pain 规则字典
│   └── sessions/               # 会话持久化
└── memory/             # 💾 记忆层
    ├── logs/SYSTEM.log # 系统日志
    ├── USER_CONTEXT.md # 用户上下文
    └── okr/            # OKR 和战略焦点
```

## 开发命令

### 构建和测试

```bash
# 安装依赖
cd packages/openclaw-plugin && npm install

# TypeScript 编译
npm run build

# 生产构建（esbuild 打包）
npm run build:production

# 运行测试（Vitest）
npm run test

# 测试覆盖率
npm run test -- --coverage
```

### 安装插件

```bash
# 安装到 OpenClaw（中文）
bash install-openclaw.sh --lang zh

# 强制覆盖模式
bash install-openclaw.sh --lang en --force

# 智能合并模式（保留用户修改）
bash install-openclaw.sh --lang zh --smart
```

### 重启 OpenClaw

```bash
# 安装后重启 Gateway
openclaw gateway --force
```

## 关键斜杠命令

| 命令 | 用途 |
| :--- | :--- |
| `/pd-init` | 初始化工作区核心文件（PROFILE, PRINCIPLES 等） |
| `/pd-evolve [task]` | 手动触发进化任务 |
| `/pd-status` | 查看系统状态（信任分数、GFI、Pain 信号） |
| `/pd-trust` | 查看信任分数详情 |
| `/pd-thinking [mode]` | 触发深度反思 |
| `/pd-okr` | 管理 OKR 和战略焦点 |
| `/pd-bootstrap` | 引导安装开发工具 |
| `/pd-help` | 获取帮助 |

## 信任阶段权限

| Stage | 分数范围 | 权限 |
| :--- | :--- | :--- |
| **1 - Observer** | 0-30 | 只读模式，只能读取文件和使用诊断子 Agent |
| **2 - Editor** | 31-60 | 可编辑文件，但限制修改行数（默认 50 行） |
| **3 - Developer** | 61-80 | 正常编辑权限，高危路径需要 PLAN.md |
| **4 - Architect** | 81-100 | 完全绕过门控，完全信任 |

## 配置文件

### OpenClaw 插件配置 (`openclaw.plugin.json`)

- `language`: 交互语言 (zh/en)
- `auditLevel`: 安全级别 (low/medium/high)
- `riskPaths`: 自定义高危目录
- `deep_reflection.enabled`: 是否启用深度反思

### 工作区配置 (`.principles/PROFILE.json`)

- `risk_paths`: 高危文件/目录列表
- `gate.require_plan_for_risk_paths`: 高危路径是否需要计划
- `progressive_gate.enabled`: 是否启用渐进式门控

## 路径解析规范

**重要**: `api.resolvePath(path)` 是访问文件系统的唯一合规入口。

在钩子上下文中 `workspaceDir` 往往不存在，必须在插件入口使用：
```typescript
const workspaceDir = ctx.workspaceDir || api.resolvePath('.');
```

**严禁硬编码绝对路径**。

## 日志位置

- **SYSTEM.log**: `{workspaceDir}/memory/logs/SYSTEM.log`
- **事件日志**: `{stateDir}/logs/events.jsonl`
- **系统日志**: OpenClaw Gateway stdout

## 测试规范

- 测试框架: Vitest
- 测试文件位置: `packages/openclaw-plugin/tests/**/*.test.ts`
- 覆盖率报告: `coverage/` 目录

```bash
# 运行所有测试
npm run test

# 运行单个测试文件
npm run test -- tests/trust-engine.test.ts

# 监听模式
npm run test -- --watch
```

## 发布流程

使用 semantic-release 自动化版本管理：

```bash
# 发布新版本
npm run release

# 试运行（不实际发布）
npm run release:dry-run
```

## 路线图

- ✅ 深度认知 (Deep Reflection/Thinking OS)
- ✅ 透明度 (进化日报)
- 🔄 元学习 (Meta-Learning) - 下一步

## 任务完成协议

完成任何任务后，必须执行：

1. **更新 CURRENT_FOCUS.md**：
   - 将完成的任务移到"已完成"
   - 更新"下一步"
   - 如果文件超过 50 行，压缩历史内容到 MEMORY.md

2. **保持注入内容精简**：
   - CURRENT_FOCUS.md 目标 < 40 行
   - 只保留：当前阶段、进行中任务、下一步
   - 历史里程碑压缩到 MEMORY.md

## 参考资源

- [高级配置指南](./packages/openclaw-plugin/ADVANCED_CONFIG_ZH.md)
- [安装指南](./packages/openclaw-plugin/INSTALL.md)
- [技能开发指南](./packages/openclaw-plugin/SKILL.md)
- [用户指南](./docs/USER_GUIDE_ZH.md)
