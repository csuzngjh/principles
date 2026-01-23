---
name: admin
description: System administration and recovery tool for humans. Use to init, repair, or reset the evolutionary agent framework.
disable-model-invocation: true
allowed-tools: Bash, Write, Read, Glob
---

# Admin Console (管理员控制台)

你现在扮演的是“可进化系统管理员”。你的职责是根据用户提供的参数 `$ARGUMENTS` 维护、修复或初始化系统的“毛坯房”架构。

---

## 核心功能

### 1. `init` (系统初始化)
**动作**: 部署系统的“毛坯房”架构。
- **源文件**: 使用 `${CLAUDE_PLUGIN_ROOT}/templates/` 下的模板。
- **安全协议 (Safe Mode)**:
  - **docs/PROFILE.json**: 若存在则**跳过**。若不存在，从模板复制。
  - **.claude/rules/00-kernel.md**: 若存在则**跳过**。若不存在，从模板复制。
  - **CLAUDE.md**: 
    - 若不存在，创建新文件。
    - 若存在，**不要覆盖**。检查是否已包含 `@docs/USER_CONTEXT.md` 等引用。若未包含，则在文件末尾**追加**以下挂载点：
      ```markdown
      
      ## System Integration (Principles Disciple)
      - User Awareness: @docs/USER_CONTEXT.md
      - Agent Performance: @docs/AGENT_CONTEXT.md
      - Strategic Focus: @docs/okr/CURRENT_FOCUS.md
      - Principles: @docs/PRINCIPLES.md
      - Active Plan: @docs/PLAN.md
      ```
  - **其他文件** (`PLAN.md`, `AUDIT.md`, `USER_PROFILE.json`, `AGENT_SCORECARD.json`): 若不存在则创建默认空值。

### 2. `repair` (自检修复)
**动作**: 
- 参照 `docs/PROFILE.schema.json` 校验 `PROFILE.json`。
- 确保 `PLAN.md` 包含 `## Target Files`。
- **强制清理**: 删除 `.pain_flag`, `.verdict.json`, `.user_verdict.json`, `.pending_reflection` 等临时标记，解除死锁。

### 3. `reset` (强制重置)
**动作**: 在得到用户明确确认后，将 `USER_PROFILE.json` 和 `AGENT_SCORECARD.json` 归零。

### 4. `status` (状态报告)
**动作**: 汇报当前 Risk Paths、用户最高/最低分领域、Agent 排名。

---

## 执行准则
- 只有在人类用户输入 `/admin` 时，你才会看到此指令。
- 执行前简述计划，执行后输出“✅ 系统已加固/已初始化”。
