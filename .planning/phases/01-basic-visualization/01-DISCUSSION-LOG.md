# Phase 01: SDK Core Implementation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-17
**Phase:** 01-basic-visualization
**Areas discussed:** Second domain adapter, SDK package structure, Performance benchmarking, Adapter conformance testing

---

## Second Domain Adapter

| Option | Description | Selected |
|--------|-------------|----------|
| Creative Writing | AI 写作助手域——文本质量、风格一致性、逻辑矛盾 | ✓ |
| Customer Service | 客服域——对话失败、情绪误判、解决方案不当 | |
| DevOps/SRE | 运维域——告警误报、故障排查错误 | |
| Data Analysis | 数据分析域——图表误用、统计错误 | |

**User's choice:** Creative Writing
**Notes:** 与 coding 域差异最大（无工具调用，痛点来自 LLM 自身输出），适合作为 Phase 1.5 极端案例基础

---

## SDK Package Structure

| Option | Description | Selected |
|--------|-------------|----------|
| 新包提取 | 创建 packages/principles-core，移动接口文件，openclaw-plugin 变为消费者 | ✓ |
| 子目录 + re-export | openclaw-plugin 内部 src/sdk/，通过 exports 暴露 | |
| 完全分离 | 所有代码在新包，openclaw-plugin 完全依赖新包 | |

**User's choice:** 新包提取
**Notes:** 清洁的 Semver 边界，需处理现有 import 路径迁移

---

## Performance Benchmarking

| Option | Description | Selected |
|--------|-------------|----------|
| CI 内置基准 | vitest bench 或 benchmark.js，合成数据，JSON 报告 | ✓ |
| 测试内断言 | performance.now() 计时 + 阈值断言 | |
| 端到端实测 | 真实 hook 调用链测量 | |

**User's choice:** CI 内置基准
**Notes:** 可重复、无外部依赖，p99 < 50ms (pain) / < 100ms (injection)

---

## Adapter Conformance Testing

| Option | Description | Selected |
|--------|-------------|----------|
| 工厂函数模式 | 参照 storage-conformance.test.ts，导出 describe 函数 | ✓ |
| 独立测试文件 | 每个适配器独立测试 | |

**User's choice:** 工厂函数模式
**Notes:** describePainAdapterConformance + describeInjectorConformance

---

## Claude's Discretion

- 新包的 package.json 配置
- Coding adapter 的 OpenClaw 事件类型映射
- Writing adapter 的痛点评分算法
- 基准测试数据规模和迭代次数
- conformance suite 完整测试用例列表

## Deferred Ideas

None
