## Qwen Added Memories

### PR #162 Pain→Principle Pipeline
- 已完成所有修复并通过 CI (tsc-plugin ✅, Lint ✅, Tests ✅, CodeRabbit ✅)
- 核心改动：1) 统一入队逻辑消除双代码路径 2) 精确 HEARTBEAT task ID 匹配 3) 安全 pain flag 清理 4) PRINCIPLES.md 4路径 JSON 解析 5) 共情混合匹配(关键词100% + 子代理采样5-10%) 6) 移除诊断者子代理路径(856行死代码) 7) 结构化 API 替代 PRINCIPLES.md 文件读取 8) 全面可观测性日志
- isValid refactoring in subagent.ts adds validation for trigger_pattern (>=3 chars) and action (>=10 chars)

### PR #163 Pain Context Enrichment
- 已合并。核心变更：双通路上下文加载（P1 OpenClaw tools + P2 JSONL fallback）、pain flag 统一契约（PainFlagData 类型 + buildPainFlag 工厂）、skill 描述统一为 TRIGGER CONDITIONS 格式、路径穿越防护、可观测性日志

### PR #170 Dedup Guard
- 已合并：服务端 3 层去重检查（关键词重叠>70%、触发词包含、文本短语重叠≥3）+ SKILL.md 强化

### PR #178 Empathy Pipeline (MERGED)
- 合并到 main (commit d9aec3fa)。涵盖以下所有 Issues 修复：

### Issues #177-#190 (全部已修复并关闭)
| Issue | 修复内容 |
|-------|---------|
| #177 | sleep_reflection 100% 超时 — 内嵌 nocturnal prompts 消除文件系统依赖 |
| #179 | NocturnalWorkflowManager.startWorkflow() 缺少 isSubagentRuntimeAvailable 检查 |
| #180 | sweepExpiredWorkflows() 不调用 driver.cleanup()/deleteSession() |
| #181 | sleep_reflection snapshot 统计字段硬编码为 0 — 改用 trajectory.db |
| #182 | fire-and-forget 无 unhandled rejection 保护 + 4+ 处空 catch 块 |
| #183 | Heartbeat sweep loop 缺少 NocturnalWorkflowManager 清理 |
| #184 | getActivePrinciples() catch {} 吞掉业务错误 |
| #185 | P12 Deep Reflect subagent timeout leaves workflows orphaned |
| #186 | writeWorkerStatus() 空 catch 块静默吞掉状态文件写入失败 |
| #187 | HEARTBEAT.md 竞态条件 — 迁移到 .state/diagnostician_tasks.json |
| #188 | subagent session cleanup 每次心跳都失败 — 使用 agent.session fallback |
| #189 | Empathy Observer 递归 spawn — 添加 prompt 前缀检测 |
| #190 | diagnostician report 文件不清理 — 所有路径都清理 |

### 关键架构决策
- **agent.session API** 用于心跳周期 session 清理（绕过 gateway request scope 限制）
- **diagnostician_tasks.json** 替代 HEARTBEAT.md 解决竞态条件
- **sync-plugin.mjs --bump** 自动检测未提交源码变更并 bump 版本号
- **adaptive LLM sampling** 共情关键词采样上限 50 次/天

### 修复数据源问题的教训
- 必须全局 grep 所有使用点，不能只改发现问题的地方
- 修改 event.messages→event.prompt 后，路由分类代码（prompt.ts）也需要同步使用已清洗的变量
- 每次修复数据源问题后，必须追踪完整数据流，确认每个使用点
