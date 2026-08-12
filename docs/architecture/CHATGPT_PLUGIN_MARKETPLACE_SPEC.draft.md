# ChatGPT/Codex Plugin Marketplace SPEC (DRAFT v0.1)

> **Status**: DRAFT — for owner review before promotion to v1.0
> **Created**: 2026-08-12
> **Depends on**: ADR-0020 (Codex CLI Host Adapter), CODEX_CLI_ADAPTER_SPEC v4.1
> **Scope**: Post-MVP — not blocking MVP launch

## 1. Motivation

PD 当前仅通过 `create-principles-disciple` 安装器以 CLI 方式工作（编辑 `~/.codex/hooks.json`）。
ChatGPT/Codex 插件市场提供了一键安装、自动注册 hooks、跨平台分发的可能性。

**目标**: 将 PD 打包为 ChatGPT/Codex 插件市场插件，实现：
- 一键安装（无需 CLI 安装器）
- 自动注册 hooks（用户审查信任后）
- 跨平台（Codex CLI + ChatGPT 桌面应用 Codex 模式）
- 市场分发与版本更新

## 2. Platform Coverage

| 平台 | Skills | Hooks | MCP Server | PD 覆盖 |
|------|--------|-------|------------|---------|
| ChatGPT Web | ✅ | ❌ | ✅ | Skills only（thinking-OS 指导） |
| ChatGPT Desktop | ✅ | ✅ (Codex mode) | ✅ | Full（hooks + skills） |
| ChatGPT Mobile | ✅ | ❌ | ✅ | Skills only |
| Codex CLI | ✅ | ✅ | ✅ | Full |
| Codex Desktop | ✅ | ✅ | ✅ | Full |
| IDE Extension | ❌ | ❌ | ❌ | 不支持 |

**关键限制**: Hooks 仅在 Codex 环境中工作（CLI + 桌面应用 Codex 模式）。
ChatGPT Web/Mobile 仅支持 Skills 和 MCP Server。

## 3. Plugin Structure

```
principles-disciple-plugin/
├── .codex-plugin/
│   └── plugin.json                 # 必需：插件清单
├── hooks/
│   ├── hooks.json                  # 生命周期 hooks 注册
│   └── pd-hook.js                  # PD 单入口脚本（复用现有）
├── skills/
│   └── pd-thinking-os/
│       └── SKILL.md                # thinking-OS 指导（全平台可用）
├── .mcp.json                       # 可选：MCP server 配置
└── assets/
    ├── icon.png                    # 插件图标
    └── logo.png                    # 插件 logo
```

## 4. plugin.json Manifest

```json
{
  "name": "principles-disciple",
  "version": "0.1.0",
  "description": "Owner-governed behavior internalization for AI agents",
  "author": {
    "name": "Principles Disciple",
    "url": "https://github.com/csuzngjh/principles"
  },
  "license": "MIT",
  "keywords": ["principles", "behavior", "internalization", "agent-governance"],
  "skills": "./skills/",
  "hooks": "./hooks/hooks.json",
  "interface": {
    "displayName": "Principles Disciple",
    "shortDescription": "Governed agent behavior internalization",
    "longDescription": "Captures repeated owner-relevant behavior evidence, distills reviewed principles, and applies approved, reversible behavior changes.",
    "category": "Productivity",
    "capabilities": ["Read", "Write"],
    "defaultPrompt": [
      "Use Principles Disciple to review my agent's tool call patterns.",
      "Use Principles Disciple to inject thinking-OS principles."
    ]
  }
}
```

## 5. hooks/hooks.json

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|apply_patch|Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "node ${PLUGIN_ROOT}/hooks/pd-hook.js",
            "timeout": 5000
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash|apply_patch|Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "node ${PLUGIN_ROOT}/hooks/pd-hook.js",
            "timeout": 5000,
            "async": true
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${PLUGIN_ROOT}/hooks/pd-hook.js",
            "timeout": 5000
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${PLUGIN_ROOT}/hooks/pd-hook.js",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```

**关键变化 vs CLI hooks.json**:
- `${PD_HOOK_PATH}` → `${PLUGIN_ROOT}/hooks/pd-hook.js`
- `workspace_dir` → `PLUGIN_DATA` 环境变量（插件可写数据目录）

## 6. pd-hook.js 适配

### 6.1 环境变量优先级

```typescript
// 当前 CLI 方式：
//   PD_WORKSPACE_DIR env → stdin.workspace_dir → fallback
//
// 插件方式（新增）：
//   PLUGIN_DATA env → PD_WORKSPACE_DIR env → stdin.workspace_dir → fallback
```

PD 的 `pd-hook.js` 需要修改 `resolveWorkspaceDir()` 逻辑，优先使用 `PLUGIN_DATA`：

```typescript
function resolveWorkspaceDir(env: Record<string, string | undefined>, stdin?: unknown): string {
  // Plugin mode: PLUGIN_DATA is set by Codex plugin host
  if (env.PLUGIN_DATA) {
    return env.PLUGIN_DATA;
  }
  // CLI mode: PD_WORKSPACE_DIR is set by installer
  if (env.PD_WORKSPACE_DIR) {
    return env.PD_WORKSPACE_DIR;
  }
  // Fallback: stdin.workspace_dir (from hook payload)
  // ...
}
```

### 6.2 数据存储路径

```
$PLUGIN_DATA/
├── state.db              # SQLite 数据库（principles, pain signals, evidence）
├── config.yaml           # PD 配置
├── install-records/      # 安装记录
└── logs/                 # 日志
```

### 6.3 Feature Flag

`host.codex.enabled` 在插件模式下默认为 `true`（插件安装即启用）。
用户可通过 `.pd/config.yaml` 禁用：
```yaml
host:
  codex:
    enabled: false
```

## 7. Skills 层（全平台）

### 7.1 pd-thinking-os SKILL.md

```markdown
---
name: pd-thinking-os
description: Inject Principles Disciple thinking-OS guidance for agent behavior governance.
---

Use this skill when working in a workspace governed by Principles Disciple.

## Thinking OS Principles

1. **Owner-governed**: The owner reviews and approves all behavior changes.
2. **Reversible**: All changes can be rolled back.
3. **Evidence-based**: Principles are distilled from observed pain signals.
4. **Non-blocking**: PD does not own task execution; it governs behavior.

## When to apply

- Before executing mutating tool calls (Bash, file writes)
- When a tool call produces an error
- When the user submits a new prompt

## What PD does NOT do

- Does not execute tasks
- Does not manage general memory
- Does not repair tools
- Does not make autonomous value decisions
```

### 7.2 Skills 在无 Hooks 平台的作用

在 ChatGPT Web/Mobile（无 hooks）中，Skills 提供：
- thinking-OS 指导（模型遵循的原则）
- principle 参考（但无法自动注入，依赖模型主动调用 skill）
- 无 gate 防护（无法拦截 tool calls）

**限制**: 无 hooks 平台中，PD 仅提供"建议"而非"强制"。

## 8. MCP Server（可选，Post-MVP）

如果需要提供 principle evaluation 工具给 ChatGPT Web/Mobile：

### 8.1 .mcp.json

```json
{
  "principles-disciple": {
    "command": "node",
    "args": ["${PLUGIN_ROOT}/mcp-server.js"]
  }
}
```

### 8.2 暴露的工具

| 工具 | 描述 | 平台 |
|------|------|------|
| `get_principles` | 获取当前活跃原则列表 | 全平台 |
| `check_behavior` | 检查行为是否符合原则 | 全平台 |
| `report_pain` | 报告 pain signal | 全平台 |

**决策点**: MVP 阶段是否需要 MCP server？还是 hooks + skills 足够？

## 9. 与 CLI 方式的关系

| 维度 | CLI 方式（当前） | 插件市场方式（新） |
|------|-----------------|-------------------|
| 安装 | `create-principles-disciple` | 插件市场一键安装 |
| hooks 注册 | 编辑 `~/.codex/hooks.json` | 插件 `hooks/hooks.json` 自动注册 |
| 数据存储 | `{workspace}/.principles/` | `$PLUGIN_DATA/` |
| 更新 | 重新运行安装器 | 市场自动更新 |
| 信任 | 用户手动信任 | 用户审查 hooks 后信任 |
| 回滚 | `--uninstall` | 插件市场卸载 |

**两者共存**: CLI 方式和插件市场方式不冲突。CLI 方式适合开发者/高级用户，插件市场适合普通用户。

## 10. Implementation Plan

### Phase 1: Plugin Scaffolding (Post-MVP)
- [ ] 创建 `packages/chatgpt-plugin/` 目录
- [ ] 编写 `plugin.json` manifest
- [ ] 适配 `pd-hook.js` 支持 `PLUGIN_DATA` 环境变量
- [ ] 创建 `hooks/hooks.json`
- [ ] 创建 `skills/pd-thinking-os/SKILL.md`

### Phase 2: Local Testing (Post-MVP)
- [ ] 创建本地 marketplace 条目
- [ ] 在 Codex CLI 中测试插件安装
- [ ] 在 ChatGPT 桌面应用中测试插件安装
- [ ] 验证 hooks 注册和信任流程
- [ ] 验证 `PLUGIN_DATA` 数据存储

### Phase 3: MCP Server (Conditional)
- [ ] 设计 MCP server 工具 schema
- [ ] 实现 `mcp-server.js`
- [ ] 测试 ChatGPT Web 中的 skill + MCP 工具组合

### Phase 4: Marketplace Submission (Post-MVP)
- [ ] 准备提交材料（隐私政策、服务条款、截图）
- [ ] 通过插件提交门户提交
- [ ] 响应审核反馈
- [ ] 发布到通用插件目录

## 11. Open Questions

1. **PLUGIN_DATA 持久性**: `PLUGIN_DATA` 目录在插件卸载后是否保留？如果不保留，用户的原则数据会丢失。
2. **多 workspace 支持**: CLI 方式支持 per-workspace 存储（`{workspace}/.principles/`）。插件方式只有单个 `PLUGIN_DATA`，如何支持多 workspace？
3. **Skills 在无 hooks 平台的触发**: ChatGPT Web 中，skill 何时被激活？需要用户手动 `@principles-disciple` 还是可以自动触发？
4. **MCP server 必要性**: hooks 已覆盖 Codex 环境。MCP server 是否值得为 ChatGPT Web/Mobile 单独开发？
5. **版本兼容性**: 插件 hooks 与 CLI hooks.json 是否完全相同？是否有插件特有的限制？
6. **信任模型**: 用户审查 hooks 的 UX 是怎样的？是否需要 PD 提供信任说明文档？

## 12. Risks

| 风险 | 影响 | 缓解 |
|------|------|------|
| PLUGIN_DATA 不持久 | 用户原则数据丢失 | 文档警告 + 提供 export/import 工具 |
| ChatGPT Web 不支持 hooks | 全平台体验不一致 | Skills 层提供降级体验 |
| 插件审核被拒 | 无法发布 | 遵循 OpenAI 提交指南，准备充分材料 |
| hooks 信任 UX 差 | 用户不信任 hooks | 提供清晰的信任说明 + 文档 |
| MCP server 复杂度 | 增加 Post-MVP 工作量 | Phase 3 设为 conditional，先验证 hooks + skills 足够 |

## 13. Relationship to Existing Work

- **ADR-0020**: 定义了 HostAdapter 抽象层，插件市场方式复用相同的 `CodexHooksHostAdapter`
- **CODEX_CLI_ADAPTER_SPEC v4.1**: 定义了 hooks 协议和输出编码，插件方式完全复用
- **feature-flag-contract.ts**: `host.codex` flag 在插件模式下默认 ON
- **principles-core**: 纯逻辑完全复用（pain detection, principle evaluation）
- **codex-adapter**: `pd-hook.js` 和 codec 层完全复用，仅需适配环境变量
