<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-005",
  "displayId": "ERR-005",
  "title": "Invalid salvaged arrays bypass type contract in validate failure path",
  "status": "active",
  "category": "Schema & Type Mistakes",
  "ep": "EP-01",
  "createdAt": "2026-05-19",
  "source": "PRI-191",
  "trailerLines": [
    "- PR #1551 round 2 (R4): evidence 元素校验只挂正向分支——负向 outcome 的 [null] 元素穿透解析层并在推导层崩溃。修法：所有 outcome 统一逐元素校验 + 推导层同契约防御（过滤+降级）。",
    "  - 2026-06-25 PRI-466 (PR#1056): `(err as Error).message` on caught `unknown` — replaced with `instanceof Error` guard",
    "  - 2026-06-23 PRI-446 (PR#1028): `input.consecutiveErrors as number` post-`Number.isFinite` — replaced with `typeof` narrowing",
    "  - Earlier recurrences (PR#689-#1027): same `as`-on-untrusted-value pattern across recommendation_kind, language, SQLite rows, YAML, depIds. See git history."
  ]
}
-->

**Recurrence**: Yes — `as Record`/`as T[]` on parsed JSON, YAML, SQLite rows, CLI args, or LLM output bypasses element/type narrowing.
