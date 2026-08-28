<p align="center">
  <img src="assets/banner.webp" width="100%" alt="Principles Disciple Banner">
</p>

<p align="center">
  <a href="https://github.com/csuzngjh/principles/tree/main/packages/website/public/homepage-demo-zh.mp4">
    <img src="https://img.shields.io/badge/▶_观看演示-FF6B35?style=for-the-badge" alt="Watch Demo Video">
  </a>
</p>

<h1 align="center">Principles Disciple (原则门徒)</h1>

<p align="center">
  <strong>燃烧痛苦，协同进化。</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/csuzngjh/principles?style=flat-square&color=5865F2" alt="Release">
  <img src="https://img.shields.io/github/license/csuzngjh/principles?style=flat-square&color=green" alt="License">
  <img src="https://img.shields.io/github/stars/csuzngjh/principles?style=flat-square&color=gold" alt="Stars">
</p>

---

> Principles Disciple（PD）是一个 **AI Agent 行为治理系统**：面向 OpenClaw / Codex 智能体的 agent-first 认知治理插件。
> Owner 监督，本地存储，把反复纠正沉淀为可审查、可回滚的行为原则。

Principles Disciple 是一个 OpenClaw 插件，用来帮助编程智能体捕获重复的行为问题，并把经过审核的教训转化为可复用的行为原则。

> **MVP 状态（2026-05-24）**：当前验证路径聚焦痛觉捕获、诊断、内化，以及三个已经具备审核路径的激活结果：prompt 引导、RuleHost 拦截、defer/archive。更广泛的学习和内置代理生命周期扩张会等到种子客户证据出现后再评估。

它是智能体优先的。
智能体是日常用户。
人类是安装者、监督者和风险承担者。

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Native%20Plugin-FF6B35)](https://github.com/openclaw/openclaw)

[English](README.md) | [中文](README_ZH.md)

---

## ⚡ 从这里开始 (Start here)

**前置条件:** Node.js ≥ 18 | 已安装 OpenClaw CLI

### 🤖 我是 AI 智能体

使用非交互式安装：

```bash
npx create-principles-disciple --yes
openclaw gateway --force
```

安装后，按照工作区记忆唤醒自己：

1. 读取 `SOUL.md` → 我是谁
2. 读取 `USER.md` → 我服务谁
3. 读取 `memory/YYYY-MM-DD.md` → 最近发生了什么
4. 读取 `AGENTS.md` → 这个工作区如何运作

*不要在读取工作区记忆之前就问人类：“你想让我做什么？”你的短期上下文并不可靠。文件系统才是你的长期记忆。*

👉 **详见智能体协议:** [`README_AGENT.md`](README_AGENT.md)

### 🧑‍💻 我是人类操作者

如果你希望 OpenClaw 编程智能体做到下面这些事，就可以安装 Principles Disciple：
- 不再反复犯同一种错误。
- 让危险修改必须先经过你审批的原则约束。
- 通过本地控制台观察进化状态。

**它安全吗？** PD 是 local-first 且可回滚的设计：规则以本地沙盒文件写入，所有状态由本地 SQLite 追踪，所有经你审批的行为变更都可被你审查、回滚或禁用。唯一的外发数据通道是一个可选的匿名产品遥测（telemetry）功能——默认关闭，必须你显式同意后才会发送（见[隐私与可选遥测](#隐私与可选遥测)）。

👉 **详见人类指南:** [`docs/runbooks/USER_GUIDE.md`](docs/runbooks/USER_GUIDE.md)

---

## 你会看到什么

一个典型的 PD 时刻：

> 你的 AI agent 总是在跨模块修改时忘记确认范围。第三次纠正后，PD 提示："系统观察到 Agent 在跨模块修改场景中 3 次未确认范围。建议沉淀为原则。"
>
> 你审查证据，修改措辞，批准了这条原则。
>
> 下一次 Agent 遇到类似任务时，它主动给出了修改范围和验证计划。
>
> 如果这条原则后来产生了副作用，随时可以回滚。

不是 AI 魔法——而是你的判断被系统尊重和执行。不是一次性修复——而是长期行为变化。不是黑箱自动化——而是透明可审查的治理。

---

## 📁 系统目录结构

了解文件的存放位置，有助于你管理智能体的“大脑”。

### OpenClaw 路径
OpenClaw 使用统一的状态目录 `~/.openclaw/`:
- **主配置**: `~/.openclaw/openclaw.json` (管理设置和插件加载路径)
- **工作区**: `~/.openclaw/workspace/` (智能体的活跃运行环境)
  - `AGENTS.md`, `SOUL.md`: 核心人格与系统指令。
  - `memory/`: 存放短期/片段记忆。
  - `docs/`: 🔗 通过符号链接指向各项目的 `docs/`，实现长期原则检索。

---

## 🛠️ 通用配置 (推荐)
```bash
/init-strategy
```

---

## 它具体做什么

### 1. 工作区安全门禁

拦截是动态且由 Owner 治理的：当你把某条原则审批到 RuleHost 通道后，PD 会在每次 write/bash/agent 工具调用前评估该规则，并可以在高风险编辑执行前拦截。具体拦截哪些编辑，完全由你审批过的原则决定——PD 自身不再内置任何硬编码门禁。

这用于保护智能体身份文件、记忆文件、战略文件、项目计划以及自定义高风险路径。

当被拦截时，智能体不应该盲目重试。

它应该：

```text
1. 阅读拦截原因（它会指出是哪条原则拦截了该操作）
2. 调整做法以满足该原则
3. 再次执行操作
```

如果你希望"先计划再动手"的行为，请审批一条要求如此的原则——不要期待内置的 PLAN.md 状态机（该机制已在 PRI-286 中退役）。

### 2. 痛觉信号捕获

工具失败、重复困惑、人类纠正、危险编辑拦截、循环卡住等事件，都可以被记录为结构化痛觉信号。

痛觉不是惩罚。

痛觉是证据。

智能体通过这些信号理解自己的行为哪里需要改善。

### 3. 经审核的行为激活

经过审核的原则目前可以产生 prompt 引导、RuleHost 拦截，或明确的 defer/archive 结果。行为变更仍由操作者审核和启用。

### 4. 原则内化管线

重复失败可以变成原则候选或规则实现候选。

操作者可以通过以下命令查看、晋升、禁用、归档或回滚这些实现：

```text
/pd-evolution-status
/pd-promote-impl list
/pd-promote-impl show <id>
/pd-promote-impl <id>
/pd-disable-impl <id>
/pd-rollback-impl <id>
/pd-archive-impl <id>
```

> ⚠️ 注意：Legacy replay 生成路径（`/pd-promote-impl eval`）已在 PRI-230 退役。只有已经存在通过 replay 报告的实现才能被 promote。

一个原则不应该因为“听起来正确”就被激活。

它需要经过证据、回放和人类审查。

### 5. 本地控制台

Principles Console 提供一个本地 Web UI，用来观察智能体健康状态和进化活动。

启动 OpenClaw Gateway 后打开：

```text
http://127.0.0.1:3100
```

或直接通过安装器/CLI 启动：

```bash
pd console open --workspace "<path>"
```

控制台可以展示：

- 工作区健康状态；
- 痛觉与摩擦趋势；
- 进化事件；
- 纠正样本；
- 原则与规则实现状态。

状态数据保存在本地。唯一可选的外发通道见[隐私与可选遥测](#隐私与可选遥测)。

## 隐私与可选遥测

PD 是 local-first 的：原则、证据、决策日志和运行状态都保存在你的本地工作区。产品包含一个**可选的匿名产品遥测**通道，**默认关闭**——除非你显式执行 `pd telemetry enable --confirm`，否则不会发出任何遥测网络请求。

启用后，每个参与的工作区每天发送一份最小化快照（PD 版本、宿主类型、UTC 日期、六个布尔产品里程碑、一个可靠性标志，以及每日轮换、不可跨日关联的标识符），发往 `https://principles-website.pages.dev/api/product-telemetry/snapshot`。绝不发送对话内容、提示词、源代码、原则/痛觉正文、文件路径、仓库地址、用户名、邮箱或任何稳定标识符。

用 `pd telemetry preview` 查看将发送的确切内容；随时可用 `pd telemetry disable --confirm` 或环境变量 `PD_TELEMETRY_DISABLED` 关闭。完整契约见 [docs/architecture/product-telemetry.md](docs/architecture/product-telemetry.md)。

## 它不是什么

Principles Disciple 不是：

- 通用 Agent 框架；
- LangChain 式应用构建器；
- SaaS 产品；
- 聊天机器人；
- 自动变强的魔法按钮。

它是 OpenClaw 编程智能体的行为治理层和学习内化层。

## 当前状态

Principles Disciple 仍然是早期实验性项目。

现在已经比较有用的部分：

- 工作区安全门禁；
- 智能体优先的安装流程；
- 经审核的 prompt / RuleHost / defer-archive 激活路径；
- 痛觉与摩擦追踪；
- 进化状态命令；
- 本地控制台；
- 基于 replay 的规则实现审查流程。

仍在发展中的部分：

- 纠正样本反馈闭环；
- 自动规则生成质量；
- 自适应阈值；
- 长期学习可靠性；
- 多工作区进化模式。

请预期会有 bug。  
请谨慎审查被晋升的行为。  
不要盲目用于关键生产工作区。

## 核心理念

编程智能体不应该只是完成任务。

它应该从真实工作的痛觉中学习。

```text
痛觉 + 反思 + 回放 + 人类审查 = 更安全的智能体进化
```

Principles Disciple 试图把这个闭环变成一个本地、可观察、智能体优先的系统。

---

## 🙏 致谢与启发 (Credits & Inspiration)

> *"Pain + Reflection = Progress" (痛苦 + 反思 = 进步)*

本项目由衷致敬 **Ray Dalio** 先生。他的著作《原则》(Principles) 以及“精英管理的操作系统”理念，为本框架提供了最初的火种。

我们深信，管理市场与生物系统的进化逻辑，同样可以被编码进下一代人工智能。通过将“痛苦”（报错）转化为“原则”（逻辑），我们不只是在构建工具，而是在引导数字心智的进化。

---

## 🔍 排错与反馈 (Troubleshooting)

### 我怎么知道系统有没有在工作？
运行健康检查命令：
```bash
/system-status
```
它会显示 Hooks 的运行状态、报错率以及当前的风险路径配置。

### 常见问题
* **Q: 为什么 AI 拒绝修改文件？**
  * A: 阅读拦截消息——它会指出是哪条 Owner 审批过的原则拦截了该操作。用 `/pd-status` 或控制台的激活视图审查或回滚生效规则。
* **Q: AI 好像变笨了，不听我的指挥？**
  * A: 检查 `docs/USER_CONTEXT.md`。可能系统把你标记为了"新手"。运行 `/profile "Domain: Expert"` 来修正。

### 报告 Bug
如果发现插件本身报错（如 Hook 崩溃），请查看系统日志：
```bash
cat docs/SYSTEM.log
```
将日志内容提交给开发者。

> [!TIP]
> **OpenClaw 插件日志**: OpenClaw 插件在 `{stateDir}/logs/` 目录下维护独立的日志文件：
> - `events.jsonl` — 结构化事件日志（工具调用、Pain 信号、Gate 拦截、进化任务）
> - `daily-stats.json` — 每日统计汇总
> - `plugin.log` — 插件运行日志
>
> **默认位置**: `~/.openclaw/workspace/memory/.state/logs/`
> - 如果你在 `~/.openclaw/openclaw.json` 中配置了自定义 `stateDir`，请相应替换路径。
>
> 查看日志：
> ```bash
> cat ~/.openclaw/workspace/memory/.state/logs/plugin.log
> ```

---

> *"Pain + Reflection = Progress"*
