# Phase m4-03: Validator - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-23 (updated)
**Phase:** m4-03-Validator
**Areas discussed:** Validation Strategy, Evidence Back-check Depth, Error Detail Format, Verbose API Design

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

**User's choice:** 分层：标准模式 best-effort，verbose 模式严格检查
**Notes:** 修正了初始选择方向——标准模式快速路径只做格式检查，verbose 模式深入验证引用真实性。

---

## Error Detail Format

| Option | Description | Selected |
|--------|-------------|----------|
| 逐字段详细描述 | 每个失败字段返回具体错误 | ✓ (共存的一部分) |
| 聚合错误摘要 | 错误分组到类别，不逐字段列出 | ✓ (共存的一部分) |

**User's choice:** 两者结合：摘要 + 详细共存
**Notes:** errors[0] 是聚合摘要，后续 entries 是逐字段详情。

---

## Verbose API Design (第二轮更新)

| Option | Description | Selected |
|--------|-------------|----------|
| 扩展 validate() 参数 | 添加 `options?: { verbose?: boolean }` 第三参数 | ✓ |
| 独立 validateVerbose() 方法 | 新增方法，不修改现有签名 | |

**User's choice:** 扩展 validate() 参数
**Notes:** 向后兼容，options 可选，默认 undefined = 标准模式。D-01 已更新。

---

## Deferred Ideas

- Evidence sourceRef 的 context 回查：如果 context 数据不足，应 fallback 到 best-effort 而非 hard fail
- Validator 的 semantic validation 扩展（M5 scope）

