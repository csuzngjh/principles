# 瑞·达利欧信徒 - 可进化编程智能体
## 用户使用指南

**版本**：1.0
**日期**：2026-01-22
**核心理念**：原则化编程 · 极度求真 · 持续进化

---

## 目录

1. [系统概述](#系统概述)
2. [核心哲学](#核心哲学)
3. [快速开始](#快速开始)
4. [工作流程](#工作流程)
5. [使用场景](#使用场景)
6. [配置说明](#配置说明)
7. [最佳实践](#最佳实践)
8. [故障排查](#故障排查)
9. [常见问题](#常见问题)

---

## 系统概述

**"瑞·达利欧信徒"** 是一个基于原则的编程智能体系统，深受瑞·达利欧《原则》一书的启发，将"极度求真"、"极度透明"和"持续进化"的理念引入软件开发流程。

### 核心特性

| 特性 | 说明 | 达利欧原则对应 |
|------|------|----------------|
| **Pain Flag 机制** | 失败时标记痛苦，确保不被忽略 | 面对现实，不逃避问题 |
| **演绎审计** | 三审（公理/系统/否定）确保方案逻辑成立 | 极度求真，质疑一切假设 |
| **门禁系统** | PLAN + AUDIT 双重验证风险路径 | 深度思考，避免冲动决策 |
| **审计日志** | 完整记录所有操作和决策 | 极度透明，可追溯 |
| **断点恢复** | 检测未完成任务，支持恢复 | 从错误中学习，持续改进 |
| **记分牌** | 追踪 agent 表现，量化成果 | 建立反馈循环 |

### 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                   瑞·达利欧信徒智能体系统                      │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌─────────────┐      ┌─────────────┐      ┌─────────────┐ │
│  │  Planner    │ ───> │  Auditor    │ ───> │Implementer  │ │
│  │  (计划员)   │      │  (审计员)   │      │ (执行者)    │ │
│  └─────────────┘      └─────────────┘      └─────────────┘ │
│         │                     │                     │        │
│         ▼                     ▼                     ▼        │
│    docs/PLAN.md        docs/AUDIT.md          实施代码      │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Hooks 门禁系统                          │   │
│  │  • PreToolUse: 风险路径检查                          │   │
│  │  • PostToolUse: 测试验证                             │   │
│  │  • SessionInit: 断点恢复                             │   │
│  │  • Stop: Pain Flag 生成                             │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              记忆与审计系统                          │   │
│  │  • AUDIT_TRAIL.log: 操作日志                        │   │
│  │  • DECISIONS.md: 决策记录                            │   │
│  │  • ISSUE_LOG.md: 问题追踪                            │   │
│  │  • AGENT_SCORECARD.json: 性能记分                   │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

---

## 核心哲学

### 瑞·达利欧的五步流程

本系统将达利欧的五步流程融入编程实践：

1. **目标明确** → PLAN.md 定义清晰目标
2. **发现问题** → ISSUE_LOG.md 记录问题
3. **诊断问题** → Diagnostician + Auditor 深度分析
4. **设计方案** → Planner 制定执行计划
5. **执行方案** → Implementer 严格实施

### 关键原则的应用

| 达利欧原则 | 系统实现 |
|-----------|----------|
| **极度求真** | 演绎审计三审：公理测试、系统测试、通过负面思考 |
| **拥抱现实** | Pain Flag 机制，失败立即标记，不逃避问题 |
| **极度透明** | AUDIT_TRAIL.log 记录所有操作，完全可追溯 |
| **深度思考** | 门禁系统要求 PLAN + AUDIT 双重验证 |
| **从错误中学习** | ISSUE_LOG.md 记录根因分析，防止重复犯错 |
| **持续进化** | 系统可自我改进，记录所有决策和结果 |

### 核心不变量（Invariant Rules）

```bash
# 流程顺序（不得跳步）
Goal → Problem → Diagnosis → Deductive Audit → Plan → Execute → Review → Log
```

**任何任务都必须遵循这个顺序**，违反顺序会被 hooks 阻断。

---

## 快速开始

### 环境要求

| 组件 | 版本要求 | 必需/可选 |
|------|----------|----------|
| **Claude Code** | 1.0+ | 必需 |
| **jq** | 1.6+ | 必需 |
| **Bash** | 4.0+ | 必需 |
| **ShellCheck** | 0.9+ | 推荐 |

### 安装步骤

#### 1. 克隆仓库

```bash
git clone <repository-url>
cd principles
```

#### 2. 验证环境

```bash
# 检查 jq
jq --version

# 检查 hooks
bash tests/test_hooks.sh
```

#### 3. 初始化配置

配置文件位于 `docs/PROFILE.json`，定义风险路径和权限：

```json
{
  "audit_level": "medium",
  "risk_paths": ["src/server/", "infra/", "db/"],
  "gate": {
    "require_plan_for_risk_paths": true,
    "require_audit_before_write": true
  },
  "permissions": {
    "deny_skip_tests": true,
    "deny_unsafe_db_ops": true
  }
}
```

#### 4. 启动系统

```bash
# 启动 Claude Code
claude

# 系统会自动运行 session_init.sh
# 显示当前配置、Pain Flag 状态、最近 Issue
```

---

## 工作流程

### 标准开发流程

```
┌─────────────────────────────────────────────────────────────┐
│                   完整工作流程                               │
└─────────────────────────────────────────────────────────────┘

1. 识别问题
   ├─ 用户报告问题
   └─ 创建 ISSUE（记录到 ISSUE_LOG.md）

2. 根因分析
   ├─ 使用 Diagnostician agent
   ├─ 5 Whys 分析
   └─ 生成根因报告

3. 演绎审计
   ├─ 使用 Auditor agent
   ├─ Axiom test: 验证假设
   ├─ System test: 检查系统影响
   ├─ Via negativa: 最坏情况分析
   └─ 生成 AUDIT.md（RESULT: PASS/FAIL）

4. 制定计划
   ├─ 使用 Planner agent
   ├─ 生成 PLAN.md
   │   ├─ STATUS: READY
   │   ├─ Steps: 详细步骤
   │   ├─ Metrics: 验证标准
   │   ├─ Rollback: 回滚方案
   │   └─ Risk notes: 风险提示
   └─ 审计通过（AUDIT.md RESULT: PASS）

5. 执行计划
   ├─ 使用 Implementer agent
   ├─ 严格按照 PLAN.md 执行
   ├─ 运行测试
   └─ 生成变更摘要

6. 代码审查（可选）
   ├─ 使用 Reviewer agent
   └─ 审查代码质量和安全性

7. 清理 Pain Flag
   ├─ 确认问题解决
   └─ 删除 docs/.pain_flag

8. 记录决策
   ├─ 更新 DECISIONS.md
   └─ 更新 AGENT_SCORECARD.json
```

### Agent 使用示例

#### Planner（计划员）

**用途**：在修改代码前制定详细计划

```bash
# 使用示例
进入 Plan Mode，让 Planner 制定方案

# 输出示例
STATUS: READY
Steps:
1. 读取 docs/ISSUE_LOG.md 了解问题
2. 使用 Diagnostician 分析根因
3. 使用 Auditor 进行演绎审计
4. 设计解决方案
5. 列出实施步骤

Metrics:
- Issue 问题解决
- 测试全部通过
- 无回归问题

Rollback:
- git revert commit
- 恢复备份文件

Risk notes:
- 可能影响用户认证流程
- 需要在低峰时段部署
```

#### Auditor（审计员）

**用途**：验证方案的逻辑正确性和系统安全性

```bash
# 使用示例
让 Auditor 审计 PLAN.md

# 输出示例
## Axiom test
- ✅ 语言契约检查：API 版本兼容
- ✅ 依赖验证：所有依赖存在

## System test
- ✅ 技术债：不引入新的技术债
- ✅ 增强回路：改进日志系统（正向增强）
- ⚠️ 延迟风险：数据库查询可能增加 50ms

## Via negativa
- ✅ 空输入：正确处理
- ✅ 网络故障：优雅降级
- ⚠️ 权限绕过：需要添加额外验证

RESULT: PASS

Must-fix:
- 在实施前添加数据库查询优化
- 添加权限验证的单元测试
```

#### Implementer（执行者）

**用途**：严格按照 PLAN.md 执行代码修改

```bash
# 使用示例
使用 Implementer 执行 PLAN.md

# 输出示例
## Changes
- modified: src/auth/login.py (添加会话超时)
- modified: tests/test_auth.py (添加超时测试)

## Commands run
- pytest tests/test_auth.py → ✅ pass (12/12)
- pylint src/auth/login.py → ✅ pass (8.5/10)

## Notes
- 按计划步骤 1-4 执行完成
- 无偏离，无额外变更
- 所有测试通过
```

#### Diagnostician（诊断员）

**用途**：深度分析问题的根本原因

```bash
# 使用示例
使用 Diagnostician 分析 ISSUE

# 5 Whys 分析示例
Why 1: 为什么会话超时？
  答：未设置会话过期时间

Why 2: 为什么未设置？
  答：框架升级后配置缺失

Why 3: 为什么配置缺失？
  答：迁移脚本未覆盖新配置项

Why 4: 为什么迁移脚本遗漏？
  答：未进行配置差异对比

Why 5: 为什么没有对比？
  答：流程缺陷，缺少迁移检查清单

根因分类：
- People：流程设计缺陷
- Design：缺少迁移验证机制
- Assumption：假设配置完全兼容（错误）
```

---

## 使用场景

### 场景 1：修复 Bug

```bash
# 1. 报告问题
发现登录失败率上升

# 2. 生成 Issue
记录到 docs/ISSUE_LOG.md

# 3. 诊断
使用 Diagnostician 分析根因
→ 发现：会话并发限制配置错误

# 4. 审计方案
使用 Auditor 验证修复方案
→ RESULT: PASS

# 5. 制定计划
使用 Planner 生成 PLAN.md

# 6. 执行修复
使用 Implementer 执行 PLAN.md

# 7. 验证
运行测试，确认问题解决

# 8. 清理
删除 docs/.pain_flag
```

### 场景 2：添加新功能

```bash
# 1. 需求分析
明确功能目标和验收标准

# 2. 风险评估
检查是否涉及 risk_paths（如 infra/、db/）

# 3. 演绎审计
使用 Auditor 审计设计方案
→ 检查数据库迁移安全性
→ 检查 API 兼容性
→ 检查性能影响

# 4. 制定计划
使用 Planner 生成详细 PLAN.md
→ 包括数据库迁移步骤
→ 包括回滚方案

# 5. 执行实施
使用 Implementer 执行

# 6. 代码审查
使用 Reviewer 审查代码
```

### 场景 3：重构代码

```bash
# 1. 识别技术债
代码审查发现问题

# 2. 记录 Issue
记录到 docs/ISSUE_LOG.md

# 3. 审计重构范围
使用 Auditor 分析影响
→ 确保 Behavior Preservation（行为保持）

# 4. 制定重构计划
PLAN.md 包含：
- 重构步骤
- 测试验证
- 性能对比

# 5. 执行重构
使用 Implementer 执行
```

---

## 配置说明

### PROFILE.json 配置

```json
{
  "audit_level": "medium",
  "risk_paths": ["src/server/", "infra/", "db/"],

  "gate": {
    "require_plan_for_risk_paths": true,
    "require_audit_before_write": true
  },

  "tests": {
    "on_change": "smoke",
    "on_risk_change": "unit",
    "commands": {
      "smoke": "npm test --silent",
      "unit": "npm test",
      "full": "npm test && npm run lint"
    }
  },

  "permissions": {
    "deny_skip_tests": true,
    "deny_unsafe_db_ops": true
  }
}
```

#### 配置项说明

| 配置项 | 说明 | 可选值 |
|--------|------|--------|
| `audit_level` | 审计严格程度 | `low`, `medium`, `high` |
| `risk_paths` | 风险路径列表 | 数组，相对路径 |
| `require_plan_for_risk_paths` | 风险路径是否需要 PLAN | `true`, `false` |
| `require_audit_before_write` | 写入前是否需要 AUDIT | `true`, `false` |
| `on_change` | 普通修改运行测试级别 | `smoke`, `unit`, `full` |
| `on_risk_change` | 风险修改运行测试级别 | `smoke`, `unit`, `full` |
| `deny_skip_tests` | 是否禁止跳过测试 | `true`, `false` |
| `deny_unsafe_db_ops` | 是否禁止危险 DB 操作 | `true`, `false` |

### Hooks 配置

在 `.claude/settings.json` 中配置：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "CLAUDE_HOOK_TYPE=SessionStart \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/audit_log.sh"
          },
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/session_init.sh"
          }
        ]
      }
    ],
    "PreToolUse": [...],
    "PostToolUse": [...],
    "Stop": [...]
  }
}
```

### DEBUG 模式

控制是否显示调试信息：

```bash
# 默认：关闭 DEBUG
claude

# 开启 DEBUG（开发调试）
DEBUG_HOOKS=1 claude

# 或持久化到 ~/.bashrc
export DEBUG_HOOKS=1
```

详见：`docs/DEBUG_HOOKS_USAGE.md`

---

## 最佳实践

### 1. 遵循流程，不跳步

```bash
❌ 错误：直接修改代码
直接 Edit 文件 → 被阻断

✅ 正确：遵循完整流程
Problem → Diagnosis → Audit → Plan → Execute → Review
```

### 2. 充分利用 Agent

| 场景 | 使用 Agent |
|------|-----------|
| 需要制定计划 | Planner |
| 需要验证方案 | Auditor |
| 需要深度分析 | Diagnostician |
| 需要执行修改 | Implementer |
| 需要代码审查 | Reviewer |
| 需要探索代码 | Explorer |

### 3. 记录一切

- ✅ 所有 Issue 记录到 `docs/ISSUE_LOG.md`
- ✅ 所有决策记录到 `docs/DECISIONS.md`
- ✅ 所有操作记录到 `docs/AUDIT_TRAIL.log`
- ✅ Agent 表现记录到 `docs/AGENT_SCORECARD.json`

### 4. 及时清理 Pain Flag

```bash
# 问题解决后立即清理
rm docs/.pain_flag

# 或使用 hooks 自动提示
# Stop agent 会提示清理
```

### 5. 定期审查

- 每周审查 `docs/ISSUE_LOG.md`
- 每月审查 `docs/AGENT_SCORECARD.json`
- 每季度审查 `docs/DECISIONS.md`

### 6. 持续改进

根据 `docs/ISSUE_LOG.md` 中的模式问题：
- 识别系统性问题
- 更新 `docs/PROFILE.json`
- 改进流程

---

## 故障排查

### 问题 1：Hook 阻断了操作

**症状**：
```
Blocked: risk edit requires docs/PLAN.md
```

**原因**：尝试修改风险路径但没有 PLAN.md

**解决方案**：
```bash
# 1. 使用 Planner 生成 PLAN.md
进入 Plan Mode

# 2. 使用 Auditor 审计方案
确保 AUDIT.md RESULT: PASS

# 3. 使用 Implementer 执行
```

### 问题 2：测试失败

**症状**：
```
Post-write checks failed (rc=254)
Pain flag written to docs/.pain_flag
```

**原因**：测试未通过

**解决方案**：
```bash
# 1. 查看测试输出
pytest tests/...

# 2. 修复问题
Edit 代码

# 3. 重新测试
# 测试通过后删除 pain flag
rm docs/.pain_flag
```

### 问题 3：jq 不可用

**症状**：
```
❌ Error: jq is required but not installed
```

**解决方案**：
```bash
# Linux/WSL
sudo apt-get install jq

# macOS
brew install jq

# Windows
choco install jq
```

### 问题 4：Pain Flag 阻断

**症状**：
```
⚠️ 检测到未处理的 pain flag
建议：运行 /evolve-task --recover 完成诊断
```

**原因**：上次任务失败，Pain Flag 未清理

**解决方案**：
```bash
# 1. 查看 Pain Flag 内容
cat docs/.pain_flag

# 2. 完成诊断或修复
使用 Diagnostician 分析

# 3. 问题解决后清理
rm docs/.pain_flag
```

### 问题 5：Agent 调用失败

**症状**：Agent 不工作或输出异常

**解决方案**：
```bash
# 1. 检查 Agent 配置
ls .claude/agents/

# 2. 检查 YAML frontmatter
确保 name, description, tools 正确

# 3. 查看 Agent 记分牌
cat docs/AGENT_SCORECARD.json

# 4. 查看审计日志
grep "AGENT" docs/AUDIT_TRAIL.log | tail -20
```

---

## 常见问题

### Q1: 必须使用所有 Agent 吗？

**A**: 不必须。根据场景选择：

- **简单任务**：直接对话即可
- **复杂任务**：使用 Planner + Implementer
- **风险任务**：全流程（Planner → Auditor → Implementer）

### Q2: 可以跳过 AUDIT 直接 PLAN 吗？

**A**:
- **风险路径**（如 `infra/`, `db/`）：**不可以**，会被阻断
- **非风险路径**：可以跳过，但不推荐

### Q3: Pain Flag 会阻止所有操作吗？

**A**: 不会。Pain Flag 只是提醒，不会阻断操作。但强烈建议先处理 Pain Flag 再继续。

### Q4: 如何查看历史操作？

**A**:
```bash
# 查看审计日志
cat docs/AUDIT_TRAIL.log

# 查看决策记录
cat docs/DECISIONS.md

# 查看 Issue 历史
cat docs/ISSUE_LOG.md
```

### Q5: Agent 性能如何量化？

**A**: 查看 `docs/AGENT_SCORECARD.json`：

```json
{
  "implementer": {
    "total_tasks": 42,
    "success_rate": 0.95,
    "avg_duration": "3m 20s"
  }
}
```

### Q6: 可以自定义 Agent 吗？

**A**: 可以。在 `.claude/agents/` 创建新的 `.md` 文件，格式：

```markdown
---
name: custom-agent
description: 你的描述
tools: Read, Write, Edit, Bash
model: sonnet
permissionMode: acceptEdits
---

你的系统提示...
```

### Q7: 如何禁用某个 Hook？

**A**: 在 `.claude/settings.json` 中：

```json
{
  "disableAllHooks": false  // 禁用所有 hooks
}
```

或修改 `hooks` 配置，移除不需要的 hook。

### Q8: 系统支持多人协作吗？

**A**: 支持。建议：

1. **共享配置**：`.claude/settings.json` 提交到 git
2. **个人配置**：`.claude/settings.local.json` 不提交
3. **Pain Flag 提醒**：session_init.sh 会提示团队其他人的 Pain Flag
4. **审计透明**：所有操作记录到 AUDIT_TRAIL.log

---

## 进阶使用

### 创建自定义工作流

```bash
# .claude/workflows/feature-development.md

# 新功能开发标准流程

1. 需求分析
   - 明确功能目标
   - 识别风险路径
   - 评估影响范围

2. 方案设计
   - 使用 Auditor 审计设计方案
   - 使用 Planner 制定实施计划
   - 使用 Reviewer 审查代码质量

3. 实施验证
   - 使用 Implementer 执行计划
   - 运行完整测试套件
   - 进行回归测试

4. 上线部署
   - 更新 DECISIONS.md
   - 生成部署检查清单
   - 准备回滚方案
```

### 集成 CI/CD

```yaml
# .github/workflows/principles-check.yml

name: Principles Check

on: [pull_request]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Check PLAN
        run: |
          if [ -f "docs/PLAN.md" ]; then
            grep -q "STATUS: READY" docs/PLAN.md
          fi
      - name: Check AUDIT
        run: |
          if [ -f "docs/AUDIT.md" ]; then
            grep -q "RESULT: PASS" docs/AUDIT.md
          fi
      - name: No Pain Flag
        run: |
          if [ -f "docs/.pain_flag" ]; then
            echo "Pain flag exists!"
            exit 1
          fi
      - name: Run Hooks Test
        run: bash tests/test_hooks.sh
```

---

## 附录

### A. 文件结构

```
principles/
├── .claude/
│   ├── agents/              # Agent 定义
│   │   ├── auditor.md
│   │   ├── diagnostician.md
│   │   ├── implementer.md
│   │   ├── planner.md
│   │   └── reviewer.md
│   ├── hooks/               # Hooks 脚本
│   │   ├── audit_log.sh
│   │   ├── pre_write_gate.sh
│   │   ├── post_write_checks.sh
│   │   ├── session_init.sh
│   │   ├── stop_evolution_update.sh
│   │   └── subagent_complete.sh
│   ├── rules/               # 核心规则
│   │   └── 00-kernel.md
│   ├── skills/              # 自定义技能
│   │   └── evolve-task/
│   └── settings.json        # Claude Code 配置
├── docs/                    # 文档和记录
│   ├── PROFILE.json         # 系统配置
│   ├── PLAN.md              # 执行计划
│   ├── AUDIT.md             # 审计报告
│   ├── DECISIONS.md         # 决策记录
│   ├── ISSUE_LOG.md         # 问题日志
│   ├── CHECKPOINT.md        # 检查点
│   ├── AUDIT_TRAIL.log      # 操作审计
│   ├── .pain_flag           # 痛苦标记（未提交）
│   └── AGENT_SCORECARD.json # Agent 记分
├── tests/                   # 测试脚本
│   ├── test_hooks.sh
│   ├── shellcheck_all.sh
│   └── fix_jq_path.sh
└── README.md
```

### B. 术语表

| 术语 | 说明 |
|------|------|
| **Pain Flag** | 失败标记，记录到 `docs/.pain_flag` |
| **演绎审计** | Axiom + System + Via Negativa 三审 |
| **风险路径** | `PROFILE.json` 中定义的危险目录 |
| **门禁系统** | PLAN + AUDIT 双重验证机制 |
| **Agent** | 专门用途的子智能体 |
| **进化** | 系统通过记录和学习不断改进 |
| **原则** | 不可变的不变量规则 |
| **极度求真** | 质疑一切假设，验证所有前提 |
| **极度透明** | 所有操作和决策完全可追溯 |

### C. 参考资料

- **瑞·达利欧《原则》**：http://www.principles.com/
- **Claude Code 文档**：https://code.claude.com/docs
- **Shell 脚本最佳实践**：https://www.shellcheck.net/
- **Git 工作流**：https://www.atlassian.com/git/tutorials/comparing-workflows

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0 | 2026-01-22 | 初始版本 |

---

## 支持

- **Issues**：在项目仓库提交 Issue
- **文档**：查看 `docs/` 目录下的其他文档
- **审计日志**：`docs/AUDIT_TRAIL.log`

---

**"真相是真正改进的基石。"** - 瑞·达利欧

**"拥抱现实，从错误中学习，持续进化。"** - 瑞·达利欧信徒
