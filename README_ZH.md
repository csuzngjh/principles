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

# Principles Disciple: 进化智能体框架 (v1.5.0)

> **可进化编程智能体框架 (Evolutionary Programming Agent Framework)**

> *凝练人类智慧，编织智能体认知。我们要的不只是工具，而是同路人。加入我们，共建数字心智的巴别塔。*

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Native%20Plugin-FF6B35)](https://github.com/nicepkg/openclaw)

[English](README.md) | [中文](README_ZH.md)

> [!WARNING]
> **早期实验性项目警告**
> 本项目目前仍处于非常早期的个人实验阶段，主要用于探索 AI 认知与自我进化的前沿理念。这意味着它必然包含诸多未知的 Bug 和不完善之处。

> [!CAUTION]
> **关于“进化迟滞”的说明**
> 本系统**不是**一个开箱即用的“魔法工具”。它的核心力量源于**“痛苦的积累”**。
> - **初始期**：Agent 依然会犯错，甚至在初期会因为严格的规则显得有些死板。
> - **成长期**：随着你不断使用，系统在 `.state/` 中累积了足够的失败哈希和词典命中，`Evolver` 才会产生精准的进化。
> - **建议**：请保持耐心，至少让它在你的真实项目中运行 **3-5 天**。只有经历了足够的“物理阻力”，它的“肌肉（原则）”才会真正长出来。

> [!TIP]
> **🚀 开箱即用与极客模式**
> 为了让所有人都能轻松上手，本插件在 OpenClaw 的 UI 设置中**去除了所有晦涩难懂的底层参数**。
> 您只需要选择语言和防爆级别，即可完美运行。初始信任分已调优至 **85 (Developer)**，确保顺畅的初始体验。
> 如果您是想要精细调优（比如修改惩罚分数、轮询时间）的极客，请阅读 [高阶参数调优指南 (Geek Mode)](./packages/openclaw-plugin/ADVANCED_CONFIG_ZH.md)。

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

---

## 📁 系统目录结构 (v1.5.0 Hidden Architecture)

了解文件的存放位置，有助于你管理智能体的“大脑”。

### 工作区分布
- `AGENTS.md`, `SOUL.md`: 核心启动文件 (必须留在根目录)。
- `.principles/`: 🧬 **治理层 (Identity)**。存放 PROFILE, PRINCIPLES, THINKING_OS 等，隐藏。
- `.state/`: ⚡ **状态层 (Volatile)**。存放队列、信任分本子、会话持久化等，隐藏。
- `PLAN.md`: 当前任务计划（留在根目录，方便人类查看和审批）。
- `memory/`: 💾 **存储层 (Persistence)**。存放长期日志、OKR 和用户偏好上下文。
- `docs/`: 📂 **业务层**。彻底还给用户，只存放真正的项目业务文档。

---

## 🛠️ 通用配置 (推荐)
```bash
/init-strategy
```

---

## 💡 核心功能使用指南

### 🛡️ 门禁与防御 (The Gatekeeper)
系统会自动拦截对 **核心配置文件**（如 `AGENTS.md`, `.principles/PROFILE.json`）的未授权修改。这是为了防止智能体在没有明确计划的情况下，意外篡改自己的“灵魂”或“规则”。

* **遇到拦截怎么办？（解锁流程）**
  1. **不要强制执行**：拦截是“物理级”的，重复执行相同的命令依然会被阻断。
  2. **修改计划**：手动或命令智能体修改项目根目录下的 **`PLAN.md`**。
  3. **设为 READY**：将文件开头的 `STATUS: DRAFT` 修改为 **`STATUS: READY`**。
  4. **重新执行**：一旦计划变为 `READY`，门禁会自动识别并“放行”你的修改指令。

---

### 🧬 思维操作系统 (Thinking OS)

Thinking OS 是系统的**元认知层**——它不告诉智能体"做什么"，而是告诉它"怎么想"。

#### 🎛️ 治理命令
```bash
# 查看各思维模型的使用频率
/thinking-os status

# 提议一个新的思维模型
/thinking-os propose "新模型描述"
```

#### 📁 相关文件
- `.principles/THINKING_OS.md` — 当前生效的思维模型
- `memory/THINKING_OS_CANDIDATES.md` — 候选池（智能体可提议，人类审批）
- `memory/THINKING_OS_ARCHIVE.md` — 被淘汰的模型归档

---

### 📊 系统监控 (Visual TUI)

Principles Disciple 提供了可视化的仪表盘，让你实时掌握系统的健康状况：

- **`/trust`**: 查看 AI 的信任积分、安全阶级和当前权限。
- **`/pd-status`**: 查看当前的 GFI 摩擦指数及状态诊断建议。

---

## ❓ 常见问题 (FAQ)

- **Q: 为什么 AI 拒绝修改某些文件？**
  * A: 检查 `.principles/PROFILE.json` 中的 `risk_paths`。如果是风险路径，必须先有 `PLAN.md`。
- **Q: 感觉 AI 变笨了/太啰嗦了？**
  * A: 检查 `memory/USER_CONTEXT.md`。可能系统把你标记为了"新手"。运行 `/profile "Domain: Expert"` 来修正。
- **Q: 哪里可以看到进化的原始数据？**
  * A: 运行以下命令查看详细的神经信号：
```bash
cat memory/logs/SYSTEM.log
```

---

## 🤝 贡献与加入 (Contribute)

Principles Disciple 是一个不断自我完善的系统。我们欢迎任何关于 AI 认知、安全门禁、进化算法的讨论。

- **GitHub**: [csuzngjh/principles](https://github.com/csuzngjh/principles)
- **Discord**: [加入我们的讨论](https://discord.gg/openclaw)

---

<p align="center">
  <b>Principles Disciple: 让智能体在痛苦中拥抱智慧。</b>
</p>
