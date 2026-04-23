# Phase m4-06: DualTrackE2E - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-23
**Phase:** m4-06-DualTrackE2E
**Areas discussed:** E2E 测试边界, Legacy 路径验证方式, OpenClaw-History 兼容性范围

---

## E2E 测试范围

| Option | Description | Selected |
|--------|-------------|----------|
| 单元级 E2E（推荐） | 使用 TestDoubleRuntimeAdapter，模拟完整 runtime 行为，无需真实 LLM 调用 | ✓ |
| 集成级 E2E | 用真实 runtime adapter 或部分 mock，需要 LLM API 或更复杂的 setup | |

**User's choice:** 单元级 E2E（推荐）
**Notes:** 用户选择了最小化依赖的方案，用 TestDoubleRuntimeAdapter 模拟

---

## E2E 测试结构

| Option | Description | Selected |
|--------|-------------|----------|
| 单文件多场景（推荐） | 一个测试文件 tests/dual-track-e2e.test.ts，包含 happy path + failure + validation failure 三个场景 | ✓ |
| 双文件分离 | 按 track 拆成两个文件：legacy-heartbeat.test.ts + runner-track.test.ts | |
| 三文件独立 | 三个独立文件各自专注一个场景 | |

**User's choice:** 单文件多场景（推荐）
**Notes:** 聚焦 runner 逻辑验证，不需要文件拆分

---

## Legacy 路径验证方式

| Option | Description | Selected |
|--------|-------------|----------|
| 不测试 legacy（推荐） | 不针对 legacy 路径写新测试 — M1/M2 的集成测试已覆盖 | ✓ |
| 写独立 legacy 测试 | 手动触发 heartbeat injection，验证 legacy 仍可执行 | |
| 实际并发验证 | 通过集成测试环境配置让 heartbeat 和 runner 同时运行 | |

**User's choice:** 不测试 legacy（推荐）
**Notes:** M4 没有修改 evolution-worker.ts，legacy 保持不动。m4-06 只验证新 runner 路径和兼容性。

---

## OpenClaw-History 兼容性范围

| Option | Description | Selected |
|--------|-------------|----------|
| 只验证无错误（推荐） | 创建一个有 imported openclaw-history entries 的 task，验证 runner 能正确处理 | ✓ |
| 验证 context 质量 | 验证 imported entries 对 context 质量有正面影响 | |
| 验证 mixed runtime_kind | 验证 imported + non-imported 混合 task 能正确处理 | |

**User's choice:** 只验证无错误（推荐）
**Notes:** m3-08/09 已修复 schema + entry mapping，m4-06 做兼容性验证即可

---

## Deferred Ideas

None — discussion stayed within phase scope