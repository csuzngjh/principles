---
name: evolution-framework-update
description: 拉取原则信徒进化框架的最新更新（包含 Orchestrator 模式、异步队列及地图优先协议）。
---

# /evolution-framework-update: 进化框架自更新

**目标**: 同步上游框架的最新代码（Hooks, Skills, Agents, Daemon），保持系统进化能力。

## 1. 执行更新
运行以下脚本拉取最新代码：

```bash
bash scripts/update_agent_framework.sh
```

## 2. 冲突处理 (Smart Merge)
脚本运行后，请检查输出：
- **无冲突**: 如果显示 "✅ Update complete"，则无需操作。
- **有冲突**: 如果显示 "⚠️ Updates found with conflicts"：
  1. 查找所有 `.update` 文件：
     ```bash
     find .claude -name "*.update"
     ```
  2. 对于每一个冲突文件（例如 `rules/00-kernel.md` vs `rules/00-kernel.md.update`）：
     - **读取** 原文件和 `.update` 文件。
     - **分析** 差异：合入上游的新功能，保留本地的个性化配置。
     - **清理**：合并完成后删除 `.update` 文件。

## 3. 重启生效
更新完成后，建议重启 Session 以加载最新的神经中枢逻辑。