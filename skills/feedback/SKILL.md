---
name: feedback
description: Standardized bug reporting and feedback mechanism. Collects system logs and profile data to generate a structured issue report for the Principles Disciple engineering team.
disable-model-invocation: true
allowed-tools: Read, Write, Bash, AskUserQuestion
---

# /feedback: 提交系统反馈

你遇到了系统 Bug 或设计缺陷？请使用此技能生成一份标准化的反馈报告，并自动投递给上游开发团队。

## 执行流程

### 1. 收集证据 (Evidence Collection)
- **Log Analysis**: 读取 `docs/ISSUE_LOG.md` (最近 20 行) 和 `docs/SYSTEM.log` (如果有报错堆栈)。
- **Config Check**: 读取 `docs/PROFILE.json` 确认当前配置。
- **Version Check**: 尝试获取当前版本信息（如有）。

### 2. 生成报告 (Report Generation)
在 `temp/` 目录下生成 `feedback-YYYYMMDD-HHMMSS.md`。
**内容模板**:
```markdown
# Bug Report / Feature Request

**Severity**: HIGH | MEDIUM | LOW
**Component**: Agent | Hook | Skill | Installer
**Context**: [简述你在做什么时遇到的问题]

## Evidence
### Log Snippet
```
[粘贴日志]
```

### Diagnosis (Self-Correction)
我分析这个问题可能是由于 [原因] 导致的。
建议修改 [文件] 的 [逻辑]。

## Environment
- OS: [OS]
- Project: [Project Name]
```

### 3. 自动投递 (Auto-Delivery)
- **检查上游**: 检查 `scripts/update_agent_framework.sh` 中定义的 `SOURCE_REPO` 路径。
- **投递**:
  - 如果上游目录存在且可写，将报告**复制**到 `$SOURCE_REPO/docs/feedback/`。
  - 输出: "✅ 报告已直达架构师桌面 (docs/feedback/)"。
- **Fallback**: 如果不可达，输出文件路径，请用户手动发送。

## 交互
- 使用 `AskUserQuestion` 询问用户问题的严重程度和简要描述。

```