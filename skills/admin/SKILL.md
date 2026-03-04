---
name: admin
description: System administration and recovery tool for humans. Use to init, repair, or reset the evolutionary agent framework.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash, Write, Read, Glob
metadata: '{"openclaw": {"requires": {"bins": ["python3"]}, "category": "system"}}'
---

# Admin Console (管理员控制台)

你现在扮演的是“可进化系统管理员”。你的职责是根据用户提供的参数 `$ARGUMENTS` 维护、修复或初始化系统的“毛坯房”架构。

---

## 核心功能

### 1. `diagnose` (系统诊断)
**动作**: 检查“毛坯房”架构的完整性。
- **核心组件**: 检查 `.claude/hooks/hook_runner.py` 是否存在且可执行。
- **文档完整性**: 检查 `docs/PROFILE.json`, `docs/PLAN.md` 等是否存在。
- **工具感知**: 检查 `docs/SYSTEM_CAPABILITIES.json`。若缺失，提示用户："⚠️ 尚未进行工具链升级。建议运行 `/bootstrap-tools` 以大幅提升系统能力。"
- **记忆挂载**: 检查 `CLAUDE.md` 是否包含 `System Integration` 章节。
- **输出**: 生成一份健康报告，列出缺失或异常的项目。

### 2. `repair` (系统修复)
**动作**: 
- **配置恢复**: 如果 `PROFILE.json` 缺失或损坏，尝试从 `.claude/templates/PROFILE.json` 恢复。
- **规则恢复**: 如果 `00-kernel.md` 缺失，从 `.claude/templates/00-kernel.md` 恢复。
- **结构补全**: 确保 `PLAN.md` 包含 `## Target Files` 标题。
- **强制清理**: 删除 `.pain_flag`, `.verdict.json`, `.user_verdict.json`, `.pending_reflection` 等临时标记。

### 3. `reset` (强制重置)

### 3. `reset` (强制重置)
**动作**: 在得到用户明确确认后，将 `USER_PROFILE.json` 和 `AGENT_SCORECARD.json` 归零。

### 4. `status` (状态报告)
**动作**: 汇报当前 Risk Paths、用户最高/最低分领域、Agent 排名。

---

## 执行准则
- 只有在人类用户输入 `/admin` 时，你才会看到此指令。
- 执行前简述计划，执行后输出“✅ 系统已加固/已初始化”。
