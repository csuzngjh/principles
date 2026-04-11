# Phase 24: Queue Store Extraction - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-11
**Phase:** 24-queue-store-extraction
**Areas discussed:** API Shape, Schema Validation, Lock Ownership

---

## API Shape

| Option | Description | Selected |
|--------|-------------|----------|
| Class | new EvolutionQueueStore(workspaceDir)，持有状态，与 EvolutionEngine 风格一致 | ✓ |
| Standalone functions | 每个函数接收 workspaceDir 参数，无实例状态，与 v1.13 契约函数风格一致 | |
| Static class | 静态方法 + 状态参数，折中方案 | |

**User's choice:** Class — 与代码库中已有的 EvolutionEngine、WorkspaceContext 风格一致，持有 workspace 状态

---

## Schema Validation Granularity

| Option | Description | Selected |
|--------|-------------|----------|
| Permissive | 只校验必需字段，忽略未知字段。前向兼容，升级队列格式时不会破坏旧代码 | ✓ |
| Strict | 未知字段拒绝。更严格，但可能导致版本升级时新旧格式不兼容 | |

**User's choice:** Permissive — 考虑到队列已有 V1/V2 两种格式，未来可能继续加字段

---

## Lock Ownership

| Option | Description | Selected |
|--------|-------------|----------|
| Store 内部自动加锁 | 所有 public 方法内部自动加锁/释放。调用者不需要关心锁 | ✓ |
| 调用者手动加锁 | 提供 withLock(fn) 方法，调用者手动控制锁范围 | |

**User's choice:** Store 内部自动加锁 — 消除无锁访问队列导致损坏的风险

---

## Claude's Discretion

- 内部方法名和私有 helper 组织方式
- 文件在 `service/` 目录下的具体位置
- 测试文件组织和命名
- 是否使用单独的 types 文件或内联 types

## Deferred Ideas

None.
