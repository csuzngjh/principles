# Error Experience Handbook

> **MUST READ before starting any task.** This document records real errors made by AI coding assistants during code reviews. Reading it prevents repeating the same mistakes.

---

## How to Record an Error

When a code review catches an AI assistant error, use the `record-error` skill. The skill handles the full workflow automatically:

1. **Add a comment** on the Linear Issue using the entry format below
2. **Tag the issue** with `lesson-learned` label (via Linear MCP tool)
3. **Edit this file** — add a row to the category table AND add a detailed entry in the "Detailed Entries" section
4. **Update statistics** at the bottom of this file
5. **Commit and create a PR** with message `docs: add ERR-XXX to error experience handbook`

The reviewer (human) only needs to point out the error. The AI assistant invokes `record-error` to handle all recording steps.

---

## Entry Format

```
**[ERR-XXX]** | <one-line summary>

- **What happened**: <what the AI assistant did wrong>
- **Why it's wrong**: <violated constraint, unread doc, or root cause>
- **Correct approach**: <what should have been done instead>
- **How to prevent**: <concrete check or rule>
- **Source**: <Linear issue ID, e.g., PRI-147>
- **Date**: <YYYY-MM-DD>
- **Recurrence**: <if same pattern recurred, note date and issue>
```

---

## Category 1: Architecture Boundary Violations

Errors where AI assistants violated the core/plugin boundary or other architectural constraints.

| ID | Summary | Source |
|----|---------|--------|
| *(No entries yet)* | | |

---

## Category 2: Missing Tests & Verification

Errors where AI assistants skipped required testing or verification steps.

| ID | Summary | Source |
|----|---------|--------|
| *(No entries yet)* | | |

---

## Category 3: Schema & Type Mistakes

Errors where AI assistants created incorrect schemas, missed type safety, or broke existing type contracts.

| ID | Summary | Source |
|----|---------|--------|
| ERR-001 | `as string` cast on untrusted JSON bypasses runtime validation | PRI-189 |

---

## Category 4: Documentation & Spec Drift

Errors where AI assistants wrote code contradicting architecture docs or ADRs.

| ID | Summary | Source |
|----|---------|--------|
| *(No entries yet)* | | |

---

## Category 5: Security & Safety

Errors where AI assistants introduced security risks or bypassed safety checks.

| ID | Summary | Source |
|----|---------|--------|
| *(No entries yet)* | | |

---

## Category 6: Process & Workflow

Errors in how AI assistants approached the task — not reading context, not following workflow.

| ID | Summary | Source |
|----|---------|--------|
| *(No entries yet)* | | |

---

## Detailed Entries

*(Add detailed entries below this line as they are recorded.)*

**[ERR-001]** | `as string | undefined` type cast on untrusted JSON bypasses runtime validation

- **What happened**: In `SqliteSourceTraceLocator.locate()`, the code used `(dj.sourcePainId ?? dj.painId) as string | undefined` to extract the pain ID from a parsed JSON object (`Record<string, unknown>`). The `as` cast silently passes non-string values (e.g., `sourcePainId: 42`), causing `taskPainId === query.sourcePainId` to always fail for non-string types because strict equality between a number and a string is always `false`.
- **Why it's wrong**: `as` is a compile-time assertion with zero runtime validation. When `diagnosticJson` contains `sourcePainId: 42` (a number), the cast silently tells TypeScript it's a string, but the actual runtime value is still `42` (number). The strict equality `42 === "42"` evaluates to `false`, producing a false `not_found` decision instead of a correct match or a type-mismatch diagnostic.
- **Correct approach**: Use `typeof rawPainId === 'string' ? rawPainId : undefined` to validate the type at runtime before using it in comparisons.
- **How to prevent**: Never use `as` type assertions on values from untrusted JSON sources (`Record<string, unknown>`). Always validate with `typeof` checks before using the value. When extracting fields from parsed JSON, treat every field as `unknown` and narrow with runtime type guards.
- **Source**: PRI-189
- **Date**: 2026-05-19
- **Recurrence**: None

---

## Statistics

| Metric | Value |
|--------|-------|
| Total lessons | 1 |
| Last updated | 2026-05-19 |
| Top category | Schema & Type |
| Recurring errors | 0 |


---

### [PRI-171] 静默降级必须暴露失败原因 (2026-05-19)

**Context**: `buildFullTraceSafe()` catch 块捕获所有异常后返回 `null`，无任何可观测性。

**Error**: 下游 diagnostician 收到 `fullTrace: null` 无法区分"无 painId"与"trace 构建崩溃"。

**Root Cause**: 降级设计正确但缺少可观测性 — degradation ≠ silence。

**Fix**: catch 块通过 `ambiguityNotes` 传播失败原因。

**Rule**: 任何 catch-and-degrade 模式必须至少通过 ambiguityNotes / telemetry / logging 之一暴露失败原因。

**Tags**: `catch-and-degrade`, `silent-failure`, `PRI-171`

---

### [PRI-171] PII 净化器禁止子串匹配 (2026-05-19)

**Context**: `SECRET_KEY_NAMES.includes()` 做子串匹配导致 `tokenizer`, `tokenCount` 被误脱敏。

**Error**: 诊断上下文数据丢失 — diagnostician 在不完整数据上操作而不知情。

**Root Cause**: `includes('token')` 匹配任何包含 "token" 的字符串。

**Fix**: 改用分段精确匹配 (`keyLower === p || keyLower.endsWith('_' + p)`)。

**Rule**: PII 净化器的 key 匹配必须精确匹配或分段匹配，禁止 `includes()` 子串匹配。每个规则必须有 negative test。

**Tags**: `pii-sanitizer`, `false-positive`, `PRI-171`
