# Phase m4-03: Validator - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-23
**Phase:** m4-03-Validator
**Areas discussed:** Validation Strategy, Evidence Back-check Depth, Error Detail Format

---

## Validation Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Fail-fast | 首个错误即返回，简单快速 | ✓ (分层的一部分) |
| Collect-all | 收集所有错误后一起返回，调试信息更丰富 | ✓ (分层的一部分) |

**User's choice:** 分层：快速失败 + verbose 模式
**Notes:** 标准模式 fail-fast，verbose 模式保留完整错误列表。与其他分层决策一致。

---

## Evidence Back-check Depth

| Option | Description | Selected |
|--------|-------------|----------|
| 严格检查 sourceRef 存在性 | 验证 evidence.sourceRef 指向 context 中的真实记录 | ✓ (分层的一部分) |
| Best-effort — 格式检查 | 只检查 sourceRef 格式（非空、合理的字符串） | ✓ (分层的一部分) |

**User's choice:** 分层：标准模式严格检查，verbose 模式 best-effort
**Notes:** 与验证策略的分层模式一致。

---

## Error Detail Format

| Option | Description | Selected |
|--------|-------------|----------|
| 逐字段详细描述 | 每个失败字段返回具体错误 | ✓ (共存的一部分) |
| 聚合错误摘要 | 错误分组到类别，不逐字段列出 | ✓ (共存的一部分) |

**User's choice:** 两者结合：摘要 + 详细共存
**Notes:** errors[0] 是聚合摘要，后续 entries 是逐字段详情。

---

## Deferred Ideas

- Evidence sourceRef 的 context 回查：如果 context 数据不足，应 fallback 到 best-effort 而非 hard fail
- Validator 的 semantic validation 扩展（M5 scope）

