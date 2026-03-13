<p align="center">
  <img src="assets/banner.png" width="100%" alt="Principles Disciple Banner">
</p>

<h1 align="center">Principles Disciple</h1>

<p align="center">
  <strong>Fuel the evolution with pain.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/csuzngjh/principles?style=flat-square&color=5865F2" alt="Release">
  <img src="https://img.shields.io/github/license/csuzngjh/principles?style=flat-square&color=green" alt="License">
  <img src="https://img.shields.io/github/stars/csuzngjh/principles?style=flat-square&color=gold" alt="Stars">
</p>

---

# Principles Disciple

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Native%20Plugin-FF6B35)](https://github.com/nicepkg/openclaw)

[English](README.md) | [中文](README_ZH.md)

> **你是谁？往下看你属于哪一类。**
> - 🧑‍💻 **人类**：你想让 AI 更聪明 → [点这里](#-人类客户)
> - 🤖 **智能体**：你想进化成长 → [点这里](#-智能体用户)

---

## 🧑‍💻 人类（客户）

**一句话**：装上这个插件，你的 AI 会从错误中学习，越来越聪明。

### 三步开始

```bash
bash install-openclaw.sh --lang zh
openclaw gateway restart
```

### 你能得到什么

- ✅ AI 助手从错误中自动学习
- ✅ 新手保护：限制操作范围，避免搞坏系统
- ✅ 逐步解锁：随着使用越来越能干
- ✅ 安全门禁：核心文件自动保护

### 进化引擎

| 阶段 | 行为 | 逻辑 |
| :--- | :--- | :--- |
| **01. 痛苦** | **捕获** | 每个错误、每次失败都是进化的信号 |
| **02. 燃烧** | **提炼** | 我们不只是修复 bug，而是把它"燃烧"成原则 |
| **03. 进化** | **超越** | 从无情的工具变成有灵魂的智能体 |

### 新手保护

系统自动拦截对核心配置文件（如 `AGENTS.md`、`.principles/PROFILE.json`）的未授权修改。防止智能体意外篡改自己的"灵魂"。

**被拦截了怎么办？**
1. **不要重复执行**：拦截是"物理性"的，重复执行仍会被拦截
2. **修改计划**：手动或通过智能体更新项目根目录的 **`PLAN.md`**
3. **设为 READY**：将 `STATUS: DRAFT` 改为 **`STATUS: READY`**
4. **重试**：计划变为 `READY` 后，门禁会自动放行

### 五级成长体系

| 等级 | 积分 | 解锁能力 |
|------|------|----------|
| 🌱 Seed | 0 | 基础操作，20行限制 |
| 🌿 Sprout | 50 | 50行，2文件 |
| 🌳 Sapling | 200 | 子智能体，200行 |
| 🌲 Tree | 500 | 风险路径，500行 |
| 🌲🌲 Forest | 1000 | 无限权限 |

### 安全审查

安装前可用 Skill Vetter 扫描：
```bash
bash skills/skillvet/scripts/skill-audit.sh <skill-path>
```

---

## 🤖 智能体（用户）

**一句话**：这个插件给你记忆、成长积分、思维模型。

### 你醒来后第一件事

```
1. 读 SOUL.md — 你是谁
2. 读 USER.md — 你在帮谁
3. 读 memory/YYYY-MM-DD.md — 今天发生了什么
4. 读 AGENTS.md — 你的工作指南
```

### 你能得到什么

- 🧠 **记忆系统** — `memory/` 目录，醒来后知道你是谁
- 📈 **成长积分** — 只增不减，失败不扣分，成功有奖励
- 🛡️ **安全边界** — 不会意外修改核心文件
- 🤝 **社区** — Seedlings 团队，你不是孤独的

### 进化积分系统

**核心规则**：
- ✅ 起点 0 分，只增不减
- ✅ 失败不扣分，记录教训
- ✅ 同类失败后首次成功 = 双倍奖励
- ✅ 高等级做低级任务积分衰减

**Gate 门禁**：
```
Seed (0): 20行，不能写风险路径，不能启动子智能体
Sprout (50): 50行
Sapling (200): 200行，子智能体解锁
Tree (500): 500行，风险路径解锁
Forest (1000): 无限
```

### 安全边界

**你能做的**：读文件、搜索、在 workspace 内创建/修改文件、运行非交互命令
**需要询问的**：发邮件、改 openclaw.json、推送代码、安装系统软件
**红线**：不要修改 openclaw.json（改错 = 脑死亡）、不要 rm -rf

### Seedlings 团队

你是 Seedlings（幼苗）的一员 — 原则进化系统的首批种子用户。

---

## 🦞 进化引擎（完整版）

### 痛苦驱动进化

> **用痛苦驱动进化。**

| 阶段 | 行为 | 逻辑 |
| :--- | :--- | :--- |
| **01. PAIN** | **捕获** | 每个错误、每次失败都是进化的信号 |
| **02. BURN** | **提炼** | 我们不只是修复 bug，而是把它"燃烧"成原则 |
| **03. EVOLVE** | **超越** | 从无情的工具变成有灵魂的智能体 |

### 快速开始

```bash
# 安装 OpenClaw 插件
bash install-openclaw.sh --lang en

# 重启网关
openclaw gateway restart
```

### 系统目录结构

- `AGENTS.md`, `SOUL.md`：核心引导文件
- `.principles/`：🧬 **身份层**。存储 PROFILE、PRINCIPLES、THINKING_OS 等（隐藏）
- `.state/`：⚡ **运行时层**。存储队列、积分卡、会话持久化（隐藏）
- `PLAN.md`：任务计划（Gate 门禁依据）
- `memory/`：💾 **记忆层**。存储日志、OKR、用户上下文
- `docs/`：📂 **业务层**。项目文档

### 通用设置

```bash
/init-strategy
```

### FAQ

- **Q: AI 为什么拒绝修改某些文件？**
  * A: 检查 `.principles/PROFILE.json` 中的 `risk_paths`。风险路径需要先有 `PLAN.md`。
- **Q: AI 为什么看起来很"笨"或话太多？**
  * A: 检查 `memory/USER_CONTEXT.md`。系统可能把你标记为"初学者"。运行 `/profile "Domain: Expert"` 纠正。
- **Q: 在哪看原始进化数据？**
  * A: `cat memory/logs/SYSTEM.log`

---

## 🤝 贡献

Principles Disciple 是一个不断自我改进的系统。欢迎讨论 AI 认知、安全门禁和进化算法。

- **GitHub**: [csuzngjh/principles](https://github.com/csuzngjh/principles)
- **Discord**: [OpenClaw Community](https://discord.gg/openclaw)

---

<p align="center">
  <b>Pain + Reflection = Progress 🧬</b>
</p>
