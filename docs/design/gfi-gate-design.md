# GFI 精细化拦截系统设计文档

> **版本**: v1.0  
> **日期**: 2026-03-17  
> **状态**: ✅ **已实现** (gate.ts 中的 GFI TIER 检查)
> **作者**: Principles Disciple Team

---

## 1. 概述

### 1.1 背景

当前系统通过 GFI (Global Friction Index / 疲劳指数) 衡量 AI Agent 的"挫败感"。当 GFI 过高时，系统通过软性指令（prompt 注入）建议 AI 暂停高风险操作。然而，模型可能忽略这些指令，继续执行危险操作。

### 1.2 目标

实现 **硬性拦截机制**，在工具调用层面强制阻止高风险操作，确保 AI 在高 GFI 状态下无法执行可能造成损害的操作。

### 1.3 设计原则

| 原则 | 说明 |
|------|------|
| **精细化分层** | 不同工具、不同场景使用不同的拦截策略 |
| **可配置** | 所有阈值和规则均可通过配置文件自定义 |
| **智能判断** | Bash 命令根据内容分析风险等级 |
| **联动机制** | 与 Trust Engine 协同工作，信任度影响拦截严格程度 |

---

## 2. 工具分层模型

### 2.1 分层定义

```
┌─────────────────────────────────────────────────────────────────────┐
│ TIER 0: 只读工具 (READ_ONLY)                                         │
│ 拦截策略: 永不拦截                                                   │
├─────────────────────────────────────────────────────────────────────┤
│ 文件读取:                                                            │
│   - read, read_file, read_many_files, image_read                    │
│ 搜索列表:                                                            │
│   - search_file_content, grep, grep_search, list_directory, ls, glob│
│ LSP:                                                                 │
│   - lsp_hover, lsp_goto_definition, lsp_find_references             │
│ Web & 文档:                                                          │
│   - web_fetch, web_search, ref_search_documentation, ref_read_url   │
│   - resolve-library-id, get-library-docs                            │
│ 状态管理:                                                            │
│   - todo_read, save_memory                                           │
│ 自定义工具:                                                          │
│   - deep_reflect (自我诊断工具)                                       │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ TIER 1: 低风险修改 (LOW_RISK_WRITE)                                  │
│ 拦截策略: GFI ≥ low_risk_block (默认 70) 时拦截                      │
├─────────────────────────────────────────────────────────────────────┤
│ 写入: write, write_file                                              │
│ 编辑: edit, edit_file, replace, apply_patch, insert, patch          │
│ 子代理: pd_spawn_agent, sessions_spawn, task                         │
│                                                                      │
│ 注: pd_spawn_agent 和 task 派生的子 agent 仍受 gate 约束，           │
│     因此不视为高风险操作                                              │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ TIER 2: 高风险操作 (HIGH_RISK)                                       │
│ 拦截策略: GFI ≥ high_risk_block (默认 40) 时拦截                     │
├─────────────────────────────────────────────────────────────────────┤
│ 删除: delete_file                                                    │
│ 移动: move_file                                                      │
│                                                                      │
│ 注: 这些操作可能导致数据丢失，需要更严格的拦截                        │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ TIER 3: Bash 命令 (BASH_TOOLS)                                       │
│ 拦截策略: 根据命令内容智能判断                                        │
├─────────────────────────────────────────────────────────────────────┤
│ 安全命令 (永远放行):                                                  │
│   - 信息查询: ls, dir, pwd, which, where, echo, env                  │
│   - Git 只读: git status, git log, git diff, git branch, git show    │
│   - 构建命令: npm run, npm test, npm build, make, gradle, mvn        │
│   - 文件查看: cat, type, head, tail, less, more                      │
│                                                                      │
│ 危险命令 (优先拦截):                                                  │
│   - 强制删除: rm -rf, del /s, rmdir /s                               │
│   - Git 危险: git push --force, git reset --hard, git clean -fd      │
│   - 发布命令: npm publish, pip upload, docker push                    │
│   - 远程执行: curl | bash, wget | sh                                  │
│                                                                      │
│ 其他命令: 按 GFI 阈值判断                                             │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 工具代码映射

```typescript
// gate.ts 中的工具分层常量
const TOOL_TIERS = {
  READ_ONLY: [
    // 文件读取
    'read', 'read_file', 'read_many_files', 'image_read',
    // 搜索列表
    'search_file_content', 'grep', 'grep_search', 'list_directory', 'ls', 'glob',
    // LSP
    'lsp_hover', 'lsp_goto_definition', 'lsp_find_references',
    // Web & 文档
    'web_fetch', 'web_search', 'ref_search_documentation', 'ref_read_url',
    'resolve-library-id', 'get-library-docs',
    // 状态管理
    'todo_read', 'save_memory',
    // 自定义工具
    'deep_reflect'
  ],
  
  LOW_RISK_WRITE: [
    'write', 'write_file',
    'edit', 'edit_file', 'replace', 'apply_patch', 'insert', 'patch',
    'pd_spawn_agent', 'sessions_spawn', 'task'
  ],
  
  HIGH_RISK: [
    'delete_file', 'move_file'
  ],
  
  BASH: [
    'bash', 'run_shell_command', 'exec', 'execute', 'shell', 'cmd'
  ]
};
```

---

## 3. Bash 命令分析器

### 3.1 分析逻辑

```typescript
/**
 * Bash 命令风险等级
 */
type BashRiskLevel = 'safe' | 'dangerous' | 'normal';

/**
 * 分析 Bash 命令风险等级
 */
function analyzeBashCommand(
  command: string, 
  config: GfiGateConfig
): BashRiskLevel {
  const normalizedCmd = command.trim().toLowerCase();
  
  // 1. 优先检查危险命令 (一旦匹配立即返回)
  for (const pattern of config.bash_dangerous_patterns) {
    if (new RegExp(pattern, 'i').test(normalizedCmd)) {
      return 'dangerous';
    }
  }
  
  // 2. 检查安全命令
  for (const pattern of config.bash_safe_patterns) {
    if (new RegExp(pattern, 'i').test(normalizedCmd)) {
      return 'safe';
    }
  }
  
  // 3. 默认为普通命令
  return 'normal';
}
```

### 3.2 安全命令正则模式

| 类别 | 正则模式 | 示例匹配 |
|------|----------|----------|
| 信息查询 | `^(ls\|dir\|pwd\|which\|where\|echo\|env)\b` | `ls -la`, `pwd` |
| Git 只读 | `^git\s+(status\|log\|diff\|branch\|show\|remote)\b` | `git status`, `git log --oneline` |
| 构建命令 | `^(npm\s+(run\|test\|build\|start)\|make\|gradle\|mvn)\b` | `npm test`, `make build` |
| 文件查看 | `^(cat\|type\|head\|tail\|less\|more)\b` | `cat file.txt`, `head -n 10` |

### 3.3 危险命令正则模式

| 类别 | 正则模式 | 示例匹配 |
|------|----------|----------|
| 强制删除 | `rm\s+-rf\|del\s+/s\|rmdir\s+/s` | `rm -rf node_modules` |
| Git 危险 | `git\s+(push\s+.*--force\|reset\s+--hard\|clean\s+-fd)` | `git push --force` |
| 发布命令 | `npm\s+publish\|pip\s+upload\|docker\s+push` | `npm publish` |
| 远程执行 | `(curl\|wget).*\|\s*(ba)?sh` | `curl example.com \| bash` |

---

## 4. 动态阈值计算

### 4.1 计算公式

```
动态阈值 = 基础阈值 × Trust Stage 乘数 × (1 - 规模衰减)
```

其中：
- **Trust Stage 乘数**: 根据信任阶段调整严格程度
- **规模衰减**: 大规模修改降低阈值（最多降低 50%）

### 4.2 Trust Stage 乘数

| Stage | 名称 | 乘数 | 说明 |
|-------|------|------|------|
| 1 | Observer | 0.5 | 阈值减半，更严格 |
| 2 | Editor | 0.75 | 阈值降低 25% |
| 3 | Developer | 1.0 | 标准阈值 |
| 4 | Architect | 1.5 | 阈值提高 50%，更宽松 |

**示例**：
- 基础阈值 70，Stage 1: `70 × 0.5 = 35` (GFI ≥ 35 就拦截)
- 基础阈值 70，Stage 4: `70 × 1.5 = 105` (实际上不会触发)

### 4.3 规模衰减

```typescript
// 修改行数越多，阈值越低
if (lineChanges > largeChangeLines) {
  const ratio = Math.min(lineChanges / 200, 0.5); // 最多降低 50%
  threshold = threshold * (1 - ratio);
}
```

| 修改行数 | 衰减比例 | 阈值示例 (基础 70) |
|----------|----------|-------------------|
| 50 行以下 | 0% | 70 |
| 100 行 | 25% | 52.5 |
| 150 行 | 37.5% | 43.75 |
| 200+ 行 | 50% | 35 |

### 4.4 代码实现

```typescript
/**
 * 计算动态 GFI 阈值
 */
function calculateDynamicThreshold(
  baseThreshold: number,
  trustStage: number,
  lineChanges: number,
  config: GfiGateConfig
): number {
  // 1. Trust Stage 乘数
  const stageMultiplier = config.trust_stage_multipliers[trustStage.toString()] || 1.0;
  let threshold = baseThreshold * stageMultiplier;
  
  // 2. 大规模修改降低阈值
  if (lineChanges > config.large_change_lines) {
    const ratio = Math.min(lineChanges / 200, 0.5);
    threshold = threshold * (1 - ratio);
  }
  
  return Math.round(Math.max(threshold, 0)); // 确保非负
}
```

---

## 5. 配置结构

### 5.1 pain_settings.json 新增配置

```json
{
  "gfi_gate": {
    "enabled": true,
    "thresholds": {
      "low_risk_block": 70,
      "high_risk_block": 40,
      "large_change_block": 50
    },
    "large_change_lines": 50,
    "trust_stage_multipliers": {
      "1": 0.5,
      "2": 0.75,
      "3": 1.0,
      "4": 1.5
    },
    "bash_safe_patterns": [
      "^(ls|dir|pwd|which|where|echo|env|cat|type|head|tail|less|more)\\b",
      "^git\\s+(status|log|diff|branch|show|remote)\\b",
      "^npm\\s+(run|test|build|start)\\b",
      "^(make|gradle|mvn)\\b"
    ],
    "bash_dangerous_patterns": [
      "rm\\s+(-[a-z]*r[a-z]*f|-rf)",
      "del\\s+/s",
      "git\\s+(push\\s+.*--force|reset\\s+--hard|clean\\s+-fd)",
      "npm\\s+publish",
      "(curl|wget).*\\|\\s*(ba)?sh"
    ]
  }
}
```

### 5.2 配置字段说明

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | true | 是否启用 GFI 拦截 |
| `thresholds.low_risk_block` | number | 70 | 低风险工具拦截阈值 |
| `thresholds.high_risk_block` | number | 40 | 高风险工具拦截阈值 |
| `thresholds.large_change_block` | number | 50 | 大规模修改警告阈值 |
| `large_change_lines` | number | 50 | 触发规模衰减的行数 |
| `trust_stage_multipliers` | object | {...} | 各信任阶段的阈值乘数 |
| `bash_safe_patterns` | string[] | [...] | 安全命令正则模式 |
| `bash_dangerous_patterns` | string[] | [...] | 危险命令正则模式 |

---

## 6. 拦截决策流程

### 6.1 流程图

```
                    工具调用请求
                         │
                         ▼
              ┌─────────────────────┐
              │ 是否 TIER 0 (只读)? │
              └─────────────────────┘
                    │         │
                   是         否
                    │         │
                    ▼         ▼
                  放行  ┌─────────────────────┐
                        │ 是否 TIER 3 (bash)? │
                        └─────────────────────┘
                              │         │
                             是         否
                              │         │
                              ▼         │
                    ┌─────────────────┐ │
                    │ 分析命令内容    │ │
                    └─────────────────┘ │
                              │         │
            ┌─────────────────┼─────────────────┐
            │                 │                 │
          safe            dangerous          normal
            │                 │                 │
            ▼                 ▼                 │
          放行             直接拦截              │
                                  │             │
                                  └──────┬──────┘
                                         │
                                         ▼
                              ┌─────────────────────┐
                              │ 获取 GFI 和 Stage   │
                              └─────────────────────┘
                                         │
                                         ▼
                              ┌─────────────────────┐
                              │ 计算动态阈值        │
                              └─────────────────────┘
                                         │
                                         ▼
                              ┌─────────────────────┐
                              │ 判断是否拦截        │
                              │                     │
                              │ TIER 1: GFI ≥ 阈值? │
                              │ TIER 2: GFI ≥ 阈值? │
                              └─────────────────────┘
                                    │         │
                                   是         否
                                    │         │
                                    ▼         ▼
                                  拦截       放行
```

### 6.2 决策表

| 工具分层 | 命令类型 | GFI 范围 | Trust Stage | 结果 |
|----------|----------|----------|-------------|------|
| TIER 0 | - | 任意 | 任意 | 放行 |
| TIER 3 | safe | 任意 | 任意 | 放行 |
| TIER 3 | dangerous | 任意 | 任意 | 拦截 |
| TIER 3 | normal | < 动态阈值 | 任意 | 放行 |
| TIER 3 | normal | ≥ 动态阈值 | 任意 | 拦截 |
| TIER 1 | - | < 动态阈值 | 任意 | 放行 |
| TIER 1 | - | ≥ 动态阈值 | 任意 | 拦截 |
| TIER 2 | - | < 动态阈值 | 任意 | 放行 |
| TIER 2 | - | ≥ 动态阈值 | 任意 | 拦截 |

---

## 7. 拦截消息格式

### 7.1 高 GFI 拦截

```
[GFI Gate] 疲劳指数过高，操作被拦截。

工具: write_file
GFI: 75/100
动态阈值: 35 (Stage 1 严格模式)

原因: 当前疲劳指数超过阈值，系统进入保护模式。

解决方案:
1. 执行 /pd-status reset 清零疲劳值
2. 检查是否存在理解偏差或死循环
3. 等待问题自然解决后再尝试

注意: 这是系统级硬性拦截，AI 无法绕过。
```

### 7.2 危险命令拦截

```
[GFI Gate] 危险命令被拦截。

命令: rm -rf node_modules
匹配规则: rm\s+(-[a-z]*r[a-z]*f|-rf)

原因: 检测到强制删除命令，需要确认执行意图。

解决方案:
1. 如果确实需要执行，请降低 GFI 后重试
2. 使用更安全的方式（如手动删除）
3. 咨询用户确认是否继续

注意: 危险命令需要更严格的审批流程。
```

### 7.3 大规模修改拦截

```
[GFI Gate] 大规模修改被拦截。

文件: src/large-module.ts
修改规模: 150 行
动态阈值: 44 (因规模降低)

原因: 大规模修改在高 GFI 状态下风险较高。

解决方案:
1. 分批次进行小规模修改
2. 先执行 /pd-status reset
3. 增加测试覆盖确保安全性
```

---

## 8. 与现有系统的集成

### 8.1 与 Trust Engine 的关系

```
┌─────────────────────────────────────────────────────────┐
│                    gate.ts 决策链                        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  1. Thinking Checkpoint (可选)                          │
│     └─ 高风险工具需要深度思考                            │
│                                                         │
│  2. GFI Gate (新增)                                     │
│     └─ 根据疲劳指数拦截高风险操作                        │
│                                                         │
│  3. Progressive Gate (Trust Engine)                     │
│     └─ 根据信任阶段限制修改范围                          │
│                                                         │
│  4. Edit Verification (P-03)                            │
│     └─ 验证编辑内容匹配                                  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 8.2 协同效果

| 场景 | Trust Gate | GFI Gate | 结果 |
|------|------------|----------|------|
| Stage 1 + GFI 50 | 阻止风险路径 | 阻止 TIER 1+ | 双重保护 |
| Stage 3 + GFI 30 | 放行 | 放行 | 正常工作 |
| Stage 4 + GFI 80 | 放行 | 可能拦截 | GFI 优先 |
| Stage 1 + GFI 20 | 阻止风险路径 | 放行 | Trust 优先 |

---

## 9. 测试计划

### 9.1 单元测试用例

| 测试场景 | 输入 | 期望结果 |
|----------|------|----------|
| TIER 0 工具调用 | `read_file`, GFI=90 | 放行 |
| TIER 1 低 GFI | `write`, GFI=50, Stage=3 | 放行 |
| TIER 1 高 GFI | `write`, GFI=75, Stage=3 | 拦截 |
| TIER 2 低 GFI | `delete_file`, GFI=30, Stage=3 | 放行 |
| TIER 2 高 GFI | `delete_file`, GFI=50, Stage=3 | 拦截 |
| Bash 安全命令 | `git status`, GFI=90 | 放行 |
| Bash 危险命令 | `rm -rf`, GFI=10 | 拦截 |
| Bash 普通命令低 GFI | `npm install`, GFI=30 | 放行 |
| Bash 普通命令高 GFI | `npm install`, GFI=80 | 拦截 |
| Stage 1 严格模式 | `write`, GFI=40, Stage=1 | 拦截 (阈值=35) |
| Stage 4 宽松模式 | `write`, GFI=80, Stage=4 | 放行 (阈值=105) |
| 大规模修改 | `write`, 150行, GFI=60 | 拦截 (阈值降低) |

### 9.2 集成测试

1. **端到端流程测试**: 模拟完整的工具调用链
2. **配置加载测试**: 验证配置正确加载和解析
3. **边界条件测试**: GFI=阈值时的行为
4. **性能测试**: 确保拦截逻辑不影响响应速度

---

## 10. 实施计划

### 10.1 开发任务

| # | 任务 | 文件 | 预估行数 |
|---|------|------|----------|
| 1 | 扩展 PainConfig 添加 gfi_gate 配置 | `config.ts` | +40 |
| 2 | 更新默认配置 | `pain_settings.json` | +35 |
| 3 | 添加工具分层常量 | `gate.ts` | +50 |
| 4 | 实现 Bash 命令分析器 | `gate.ts` | +40 |
| 5 | 实现 GFI 拦截逻辑 | `gate.ts` | +80 |
| 6 | 实现 Trust 联动 | `gate.ts` | +30 |
| 7 | 编写单元测试 | `gfi-gate.test.ts` | +150 |
| 8 | 运行全量测试 | - | - |

### 10.2 发布检查清单

- [ ] 所有单元测试通过
- [ ] 全量测试 (456+) 通过
- [ ] 文档更新 (USER_GUIDE, COMMAND_REFERENCE)
- [ ] 配置迁移指南
- [ ] 版本号更新

---

## 11. 风险评估

### 11.1 潜在问题

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 误拦截正常操作 | 用户体验下降 | 提供清晰的解锁指引 |
| 配置错误导致系统不可用 | 功能失效 | 使用合理的默认值 |
| 正则匹配性能 | 响应变慢 | 预编译正则，限制模式复杂度 |
| 与 Trust Engine 冲突 | 行为不一致 | 明确优先级规则 |

### 11.2 回滚方案

如果发现问题，可以通过以下方式禁用：

```json
// pain_settings.json
{
  "gfi_gate": {
    "enabled": false
  }
}
```

---

## 附录 A: 配置示例

### A.1 保守配置 (更严格)

```json
{
  "gfi_gate": {
    "enabled": true,
    "thresholds": {
      "low_risk_block": 50,
      "high_risk_block": 30,
      "large_change_block": 40
    },
    "trust_stage_multipliers": {
      "1": 0.4,
      "2": 0.6,
      "3": 0.8,
      "4": 1.0
    }
  }
}
```

### A.2 宽松配置 (更自由)

```json
{
  "gfi_gate": {
    "enabled": true,
    "thresholds": {
      "low_risk_block": 85,
      "high_risk_block": 60,
      "large_change_block": 70
    },
    "trust_stage_multipliers": {
      "1": 0.7,
      "2": 0.9,
      "3": 1.2,
      "4": 1.5
    }
  }
}
```

### A.3 禁用 Bash 拦截

```json
{
  "gfi_gate": {
    "enabled": true,
    "bash_safe_patterns": [".*"],
    "bash_dangerous_patterns": []
  }
}
```

---

## 附录 B: 相关文档

- [Trust Engine 设计文档](./trust-gate-architecture.md)
- [Empathy Engine 设计](./context-injection-optimization.md)
- [用户指南](../USER_GUIDE_ZH.md)
- [命令参考](../../packages/openclaw-plugin/docs/COMMAND_REFERENCE.md)
