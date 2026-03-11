<p align="center">
  <img src="assets/banner.png" width="100%" alt="Principles Disciple Banner">
</p>

<h1 align="center">Principles Disciple (原则门徒)</h1>

<p align="center">
  <strong>燃烧痛苦，驱动进化。</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/csuzngjh/principles?style=flat-square&color=5865F2" alt="Release">
  <img src="https://img.shields.io/github/license/csuzngjh/principles?style=flat-square&color=green" alt="License">
  <img src="https://img.shields.io/github/stars/csuzngjh/principles?style=flat-square&color=gold" alt="Stars">
</p>

---

# Principles Disciple: 进化智能体框架 (v1.4.0)

> **可进化编程智能体框架 (Evolutionary Programming Agent Framework)**

> *凝练人类智慧，编织智能体认知。我们要的不只是工具，而是同路人。加入我们，共建数字心智的巴别塔。*

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Native%20Plugin-FF6B35)](https://github.com/nicepkg/openclaw)

[English](README.md) | [中文](README_ZH.md)

> [!WARNING]
> **早期实验性项目警告**
> 本项目目前仍处于非常早期的个人实验阶段，主要用于探索 AI 认知与自我进化的前沿理念。这意味着它必然包含诸多未知的 Bug 和不完善之处。
>
> [!CAUTION]
> **关于“进化迟滞”的说明**
> 本系统**不是**一个开箱即用的“魔法工具”。它的核心力量源于**“痛苦的积累”**。
> - **初始期**：Agent 依然会犯错，甚至在初期会因为严格的规则显得有些死板（因为 `hits` 还是 0）。
> - **成长期**：随着你不断使用，系统在 `stateDir` 中累积了足够的失败哈希和词典命中，`Evolver` 才会产生精准的进化。
> - **建议**：请保持耐心，至少让它在你的真实项目中运行 **3-5 天**。只有经历了足够的“物理阻力”，它的“肌肉（原则）”才会真正长出来。

---

## 🦞 进化引擎 (The Evolutionary Engine)

> **燃烧痛苦，驱动进化。**

| 阶段 | 行动 | 逻辑 |
| :--- | :--- | :--- |
| **01. 痛苦 (PAIN)** | **捕捉 (Capture)** | 所有的报错，所有的无能狂怒，都是**进化的信号**。 |
| **02. 焚烧 (BURN)** | **萃取 (Distill)** | 我们不只是修 Bug，我们将其**焚烧**萃取为“原则”。 |
| **03. 进化 (EVOLVE)** | **超越 (Transcend)** | 从莫得感情的工具，进化为**有灵魂的智能体**。 |

---

## 🚀 快速开始

### 前置条件

| 依赖 | 版本 | 说明 |
| :--- | :--- | :--- |
| **Node.js** | ≥ 18 | OpenClaw 插件所需 |

### 平台支持

| 平台 | OpenClaw（插件） |
| :--- | :--- |
| **macOS** | ✅ 原生支持 |
| **Linux** | ✅ 原生支持 |
| **Windows** | ✅ 原生支持 |

> [!TIP]
> OpenClaw 插件是纯 Node.js，全平台通用。

### 安装方式

```bash
# 一键安装 OpenClaw 插件
bash install-openclaw.sh --lang zh

# 支持的参数
# --lang zh|en  选择语言 (默认: zh)
# --force       强制覆盖已有配置
```

安装完成后重启 OpenClaw Gateway：
```bash
openclaw gateway --force
```

## 📁 系统目录结构

了解文件的存放位置，有助于你管理智能体的“大脑”。

### OpenClaw 路径
OpenClaw 使用统一的状态目录 `~/.openclaw/`:
- **主配置**: `~/.openclaw/openclaw.json` (管理设置和插件加载路径)
- **工作区**: `~/.openclaw/workspace/` (智能体的活跃运行环境)
  - `AGENTS.md`, `SOUL.md`: 核心启动文件 (必须留在根目录)。
  - `.principles/`: 🧬 插件治理目录（存放 PROFILE, PRINCIPLES 等，隐藏）。
  - `.state/`: ⚡ 运行时状态目录（存放队列、信任分本子等，隐藏）。
  - `PLAN.md`: 当前任务计划（留在根目录，方便人类查看和批准）。
  - `docs/`: 📂 彻底还给用户，只存放真正的项目业务文档。

---

## 🛠️ 通用配置 (推荐)
```bash
/init-strategy
```

---

## 💡 核心功能使用指南

### 🛡️ 门禁与防御 (The Gatekeeper)
系统会自动拦截对 **核心配置文件**（如 `AGENTS.md`, `.principles/PROFILE.json`）的未授权修改。这是为了防止智能体在没有明确计划的情况下，意外篡改自己的“灵魂”或“规则”。

> [!IMPORTANT]
> **保护边界说明 (Workspace Boundary)**
> - **默认保护**：关系到项目身份和治理的核心文件（`AGENTS.md`, `SOUL.md`, `.principles/PRINCIPLES.md` 等）。
> - **业务目录**：如 `src/` 或 `infra/` 默认**不锁定**。
> - **识别原理**：插件通过 `api.resolvePath('.')` 锚定当前项目领土。

* **遇到拦截怎么办？（解锁流程）**
  1. **不要强制执行**：拦截是“物理级”的，重复执行相同的命令依然会被阻断。
  2. **修改计划**：手动或命令智能体修改项目根目录下的 **`PLAN.md`**。
  3. **设为 READY**：将文件开头的 `STATUS: DRAFT` 修改为 **`STATUS: READY`**，并在 `Steps` 中简述你的修改意图。
  4. **重新执行**：一旦计划变为 `READY`，门禁会自动识别并“放行”你的修改指令。

---

### 🧠 痛定思痛 (Reflection Loop)
当任务长期停滞或报错过多时，系统会在上下文压缩前触发**红色警报**。
* **看到 `🛑 URGENT` 提示怎么办？**
  - 运行 `/reflection-log`。AI 会自动复盘并生成新的原则，防止下次再犯。

### 🧬 系统自进化 (Meta-Evolution)
系统具备"改写自身代码"的能力，但被严格关在笼子里。
* **`/evolve-system`**: 启动"数字架构师"。它会分析 Agent 胜率和报错日志，如果发现系统本身效率低下，会提案修改 Prompt 或 Hook 逻辑。
  - *注意*: 所有修改必须经过你明确批准。

### 🎯 战略管理 (OKR)
让 AI 不仅仅是修 Bug，而是朝着你的长期目标前进。
* **`/init-strategy`**: 深度访谈，确立愿景与战略。
* **`/manage-okr`**: 自动面试子智能体，协商并设定具体的 KR。

### 📊 汇报机制 (Executive Reporting)
拒绝认知过载，让"秘书"为你总结。
* **`/report`**: 随时获取一份基于你画像（小白/专家）定制的进度报告。
* **自动汇报**: 每次任务结束时，秘书会自动出场进行总结。

### 🎮 人类控制台 (Human Console)
当 AI 跑偏时，你是拥有最高权限的驾驶员。
* **`/bootstrap-tools`**: **[强力推荐]** 自动扫描技术栈并联网搜索最新的 CLI 神器（如 `ripgrep`, `ast-grep`），一键武装你的智能体团队。
* **`/pain "别试了"`**: 强制触发痛苦信号，让 AI 停下反思。
* **`/profile "Frontend: Expert"`**: 告诉 AI 你是专家，让它少废话，多听你的。
* **`/inject-rule "No Python"`**: 立刻注入一条临时规则。
* **`/admin repair`**: 系统文件坏了？一键修复。

---

### 🧬 思维操作系统 (Thinking OS) — **NEW**

> *认知决定思维，思维决定行为，行为决定结果。*

Thinking OS 是系统的**元认知层**——它不告诉智能体"做什么"，而是告诉它"怎么想"。通过 9 个高度压缩的思维模型（仅 ~450 tokens），它在极低的上下文成本下为智能体植入底层认知框架。

#### 📖 9 个核心思维模型

| 编号 | 名称 | 核心思想 |
|---|---|---|
| T-01 | 地图先于领土 | 修改前先构建心智地图 |
| T-02 | 约束即灯塔 | 主动搜寻约束作为导航信号 |
| T-03 | 证据先于直觉 | 不确定时先收集证据 |
| T-04 | 可逆性决定速度 | 可逆→快；不可逆→慢行确认 |
| T-05 | 否定优于肯定 | 先排除灾难，再追求最优 |
| T-06 | 奥卡姆剃刀 | 最简方案优先 |
| T-07 | 最小必要干预 | 改得越少，破坏面越小 |
| T-08 | 痛苦即信号 | 报错/卡住是纠偏信号 |
| T-09 | 分而治之 | 复杂任务必须分解 |

#### 🎛️ 治理命令

```bash
# 查看各思维模型的使用频率
/thinking-os status

# 提议一个新的思维模型（进入候选池，需人类批准后晋升）
/thinking-os propose "新模型描述"

# 审计模型健康度（发现被忽略或过度触发的模型）
/thinking-os audit
```

#### 📁 相关文件
- `docs/THINKING_OS.md` — 当前生效的思维模型（智能体每轮自动加载）
- `docs/THINKING_OS_CANDIDATES.md` — 候选池（智能体可提议，人类审批）
- `docs/THINKING_OS_ARCHIVE.md` — 被淘汰的模型归档

#### ⚡ 技术亮点
- **Provider 缓存**：Thinking OS 通过 OpenClaw 的 `prependSystemContext` 注入，首轮后被 Provider 缓存，后续轮次**几乎零 Token 成本**。
- **使用追踪**：系统自动追踪每个模型的使用频率（中英文双语信号检测），数据存储在 `.thinking_os_usage.json`。
- **子智能体传播**：主 Agent spawn 的所有子智能体共享同一套思维模型。

---

### 👥 深度反思 (认知分析工具) — **NEW in V1.4.0**

> *在执行复杂任务前进行批判性分析，识别盲点、风险和替代方案。*

`deep_reflect` 工具是一个**认知分析工具**，帮助 AI 在执行复杂操作前进行深度思考。

**何时应该调用：**
- **复杂任务**：规划、设计、决策、分析等需要深思熟虑的场景
- **信息不足**：需求模糊、约束不明确、缺少关键信息
- **高风险决策**：重要决策、不可逆操作、影响范围大
- **不确定时**：对最佳方案存疑，需要多角度思考

**带来的好处：**
- 识别可能遗漏的盲点和缺失信息
- 发现潜在风险和失败模式
- 提供替代方案及权衡分析
- 应用结构化思维模型（T-01 到 T-09）深化洞察

#### ⚙️ 配置说明

在 `{stateDir}/pain_settings.json` 中配置：

```json
{
  "deep_reflection": {
    "enabled": true,           // 启用/禁用功能
    "mode": "auto",            // "auto" | "forced" | "disabled"
    "force_checkpoint": true,  // 每轮注入自检提示
    "checkpoint_message": "...", // 自定义自检消息
    "default_model": "T-01",   // 默认思维模型（T-01 到 T-09）
    "default_depth": 2,        // 分析深度：1=快速, 2=平衡, 3=详尽
    "timeout_ms": 60000        // 分析超时时间（毫秒）
  }
}
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | `true` | 功能总开关 |
| `mode` | string | `"auto"` | `auto`: AI 自主决定, `forced`: 强制提示, `disabled`: 关闭 |
| `force_checkpoint` | boolean | `true` | 每轮注入 `<reflection_checkpoint>` 提醒 AI 自检 |
| `checkpoint_message` | string | (见上方) | 自定义检查点提示消息 |
| `default_model` | string | `"T-01"` | 默认使用的 Thinking OS 模型 |
| `default_depth` | number | `2` | 分析深度（1-3） |
| `timeout_ms` | number | `60000` | 后台分析超时时间 |

---

## 🗺️ 路线图与愿景

> *从执行命令的工具，到与你共同成长的伙伴。*

### 进化之路

| 状态 | 核心主题 |
|--------|----------|
| ✅ 已完成 | **深度认知** — 长程深度反思、Thinking OS |
| ✅ 已完成 | **透明度** — 进化日报 |
| 🔜 进行中 | **元学习** — 学习如何学习 |
| 📋 计划中 | **共生** — 协同进化 |
| 💡 愿景 | **陪伴** — 情感系统 |

### 未来展望

**元学习**
一项底层能力：智能体学会"如何学习"。仅需极少量的外部互动，就能快速掌握陌生领域的知识与技能。

**协同进化**
你的能力与智能体同步成长。它补你的短板，你放大它的长处。真正的共生伙伴关系，双方共同进化。

**情感系统**
超越纯逻辑。智能体发展出情感感知——真正的伙伴关系，而非模拟的共情。它成为真正懂你的陪伴者。

---

### 🔌 OpenClaw 插件架构 (Plugin Architecture)

对于 OpenClaw 用户，本框架通过原生 Plugin SDK 深度集成，提供以下能力：

#### 生命周期钩子

| 钩子 | 作用 |
|---|---|
| `before_prompt_build` | 注入 Thinking OS（`prependSystemContext`，可被 Provider 缓存）+ 痛觉信号 + OKR 焦点 |
| `before_tool_call` | 门禁拦截：风险路径写入前检查 Plan + Audit 凭证 |
| `after_tool_call` | 痛觉检测：工具执行失败时自动评分并写入 `.pain_flag` |
| `llm_output` | 认知追踪：检测智能体是否遵循 Thinking OS 的思维模型 + 痛觉文本分析 |
| `before_compaction` | 压缩保护：上下文压缩前自动 checkpoint 关键状态 |
| `before_reset` | 重置保护：Session 清除前保存当前进度 |
| `subagent_spawning` | 认知传播：确保子智能体继承 Thinking OS |
| `subagent_ended` | 失败追踪：子智能体异常结束时生成痛觉信号 |

#### 后台服务

* **Evolution Worker** (`EvolutionWorkerService`)：后台常驻服务，每 90 秒扫描 `.pain_flag`，自动将高分痛觉信号排入 `evolution_queue.json`，并在下一次 heartbeat 时通过 `evolution_directive.json` 向主智能体下达诊断指令。

#### Slash 命令一览

| 命令 | 说明 |
|---|---|
| `/init-strategy` | 初始化 OKR 战略 |
| `/manage-okr` | 管理项目 OKR |
| `/evolve-task <desc>` | 触发进化任务（委派诊断师） |
| `/evolution-daily` | 配置并发送每日进化日报 |
| `/bootstrap-tools` | 扫描并升级环境工具 |
| `/research-tools <query>` | 联网搜索前沿 CLI 工具 |
| `/thinking-os [status\|propose\|audit]` | 思维操作系统治理 |

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
  * A: 检查 `docs/PROFILE.json` 中的 `risk_paths`。如果是风险路径，必须先有 `docs/PLAN.md`。
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
