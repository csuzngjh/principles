# Principles Disciple (原则信徒)

> **可进化编程智能体框架 (Evolutionary Programming Agent Framework)**
> Inspired by Ray Dalio's *Principles*.

[![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-Plugin-5865F2)](https://code.claude.com)

Principles Disciple 是一个为 Claude Code 设计的插件，它将你的 AI 助手转化为一个具备**自我防御、自我反思、自我进化**能力的数字生命体。它通过门禁、画像、OKR 和 痛觉机制，防止 AI 盲目执行错误指令，并从每次失败中学习。

---

## 🚀 快速开始

### 1. 安装插件
在你的项目目录中运行：
```bash
/plugin install <git-repo-url>
```

### 2. 初始化“毛坯房”
插件安装后，你需要初始化系统的核心文件（如规则库、配置文件）。
运行以下命令：
```bash
/admin init
```
*这将安全地创建 `docs/` 目录和配置文件，不会覆盖你已有的 `CLAUDE.md`。*

### 3. 设定战略（可选但推荐）
告诉智能体你的项目愿景，让它更有方向感：
```bash
/init-strategy
```

---

## 💡 核心功能使用指南

### 🛡️ 门禁与防御 (The Gatekeeper)
你不需要做任何事。系统会自动拦截对 **高风险目录**（如 `src/db/`）的未授权修改。
* **遇到拦截怎么办？**
  - AI 会自动提示你需要先制定计划。
  - 你只需同意它运行 `/evolve-task` 即可。

### 🧠 痛定思痛 (Reflection Loop)
当任务长期停滞或报错过多时，系统会在上下文压缩前触发**红色警报**。
* **看到 `🛑 URGENT` 提示怎么办？**
  - 运行 `/reflection-log`。AI 会自动复盘并生成新的原则，防止下次再犯。

### 🧬 系统自进化 (Meta-Evolution)
系统具备“改写自身代码”的能力，但被严格关在笼子里。
* **`/evolve-system`**: 启动“数字架构师”。它会分析 Agent 胜率和报错日志，如果发现系统本身效率低下，会提案修改 Prompt 或 Hook 逻辑。
  - *注意*: 所有修改必须经过你明确批准。

### 🎯 战略管理 (OKR)
让 AI 不仅仅是修 Bug，而是朝着你的长期目标前进。
* **`/init-strategy`**: 深度访谈，确立愿景与战略。
* **`/manage-okr`**: 自动面试子智能体，协商并设定具体的 KR。

### 📊 汇报机制 (Executive Reporting)
拒绝认知过载，让“秘书”为你总结。
* **`/report`**: 随时获取一份基于你画像（小白/专家）定制的进度报告。
* **自动汇报**: 每次任务结束时，秘书会自动出场进行总结。

### 🎮 人类控制台 (Human Console)
当 AI 跑偏时，你是拥有最高权限的驾驶员。
* **`/bootstrap-tools`**: **[强力推荐]** 自动扫描技术栈并联网搜索最新的 CLI 神器（如 `ripgrep`, `ast-grep`），一键武装你的智能体团队。
* **`/pain "别试了"`**: 强制触发痛苦信号，让 AI 停下反思。
* **`/profile "Frontend: Expert"`**: 告诉 AI 你是专家，让它少废话，多听你的。
* **`/inject-rule "No Python"`**: 立刻注入一条临时规则。
* **`/admin repair`**: 系统文件坏了？一键修复。

### ⚡ 并行开发模式 (Parallel Mode)
利用 Claude Code 的 `Tasks` 功能，实现“一人分饰两角”。

1. **设置任务 ID**:
   ```bash
   export CLAUDE_CODE_TASK_LIST_ID=my-feature
   ```
2. **开启主窗口**: 运行 `claude`，负责写代码。
3.  **开启副窗口**: 同样设置 ID 并运行 `claude`，负责 Review 或写测试。
4.  **效果**: 两个窗口共享任务状态，实时同步！

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
  * A: 检查 `docs/USER_CONTEXT.md`。可能系统把你标记为了“新手”。运行 `/profile "Domain: Expert"` 来修正。

### 报告 Bug
如果发现插件本身报错（如 Hook 崩溃），请查看系统日志：
```bash
cat docs/SYSTEM.log
```
将日志内容提交给开发者。

---

> *"Pain + Reflection = Progress"*
