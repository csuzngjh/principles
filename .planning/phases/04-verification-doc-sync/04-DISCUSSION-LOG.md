# Phase 4: Verification + Doc Sync - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-21
**Phase:** 04-verification-doc-sync
**Areas discussed:** Conflict table location, Deprecation scope

---

## Conflict Table Location

| Option | Description | Selected |
|--------|-------------|----------|
| docs/pd-runtime-v2/conflict-table.md | 持久文档，M2-M9 可直接引用 | ✓ |
| .planning/phases/04-*/04-CONFLICT-TABLE.md | Phase 交付物，后续需复制 | |

**User's choice:** docs/pd-runtime-v2/conflict-table.md
**Notes:** 冲突表作为持久文档，后续 milestone 开发时可以直接引用

---

## Deprecation Scope

| Option | Description | Selected |
|--------|-------------|----------|
| 最小范围（仅 DOC-01 列出的） | 只标记 TrinityRuntimeFailureCode、QueueStatus | |
| DOC-01 deprecation + 全量冲突表 | deprecation 仅加 DOC-01 类型，冲突表记录全部重叠 | ✓ |

**User's choice:** DOC-01 deprecation + 全量冲突表
**Notes:** TaskKind(3处)、TaskResolution(4处) 等在冲突表中全量记录但不加 deprecation 标记，留给 M2 迁移

---

## Claude's Discretion

- 冲突表的具体列和排版细节
- deprecation 文字的具体措辞
- 验证的具体执行步骤顺序

## Deferred Ideas

None — discussion stayed within phase scope.
