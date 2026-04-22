# Phase 2: Context + Diagnostician Contracts - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-21
**Phase:** 02-context-diagnostician-contracts
**Areas discussed:** TypeBox Schema 深度, context 字段类型, DiagnosisTarget 共享 vs 分离

---

## TypeBox Schema 深度

| Option | Description | Selected |
|--------|-------------|----------|
| 全部独立 schema | 每个 interface/type 都有对应 TypeBox schema，与 Phase 1 完全一致 | ✓ |
| Top-level + 复用子类型 | 只给 top-level + 被多处引用的子类型加 schema | |
| 仅 Top-level | 只有 5 个 top-level contract 加 schema | |

**User's choice:** 全部独立 schema
**Notes:** 与 Phase 1 保持完全一致的模式，所有子类型可独立验证。

---

## context 字段类型选择

| Option | Description | Selected |
|--------|-------------|----------|
| 直接引用 DiagnosticianContextPayload | 同目录无循环依赖，调用方获得完整类型提示 | ✓ |
| 保持 unknown + JSDoc 注释 | 松耦合但丢失编译时检查 | |

**User's choice:** 直接引用 DiagnosticianContextPayload
**Notes:** 同目录文件无循环依赖问题，类型安全优先。

---

## DiagnosisTarget 共享 vs 分离

| Option | Description | Selected |
|--------|-------------|----------|
| 共享一个 interface（宽松并集） | 5 个字段都可选，必填约束留给 validation 层 | ✓ |
| 拆分两个 interface（精确类型） | DiagnosisTarget + DiagnosticianDiagnosisTarget，类型精确但多一个 interface | |
| 各自内联定义 | 每个 payload 按文档定义，有重复 | |

**User's choice:** 共享一个 interface（宽松并集）
**Notes:** History Spec §9.4 定义 3 个可选字段，Diagnostician v2 §9.4 定义 5 个字段（reasonSummary 必填）。宽松并集包含全部 5 个字段，必填约束在 TypeBox schema 层强制。

---

## Claude's Discretion

- TypeBox schema 的具体约束细节（minLength, maximum, pattern 等）
- 所有 contract 的具体字段名和结构（canonical 文档已严格定义）

## Deferred Ideas

None — discussion stayed within phase scope.
