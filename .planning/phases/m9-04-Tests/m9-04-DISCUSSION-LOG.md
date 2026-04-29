# Phase m9-04: Tests - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-29
**Phase:** m9-04-Tests
**Areas discussed:** E2E scope, Mock strategy

---

## E2E Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Full chain (m8-02 pattern) | pi-ai adapter → DiagnosticianOutputV1 → artifact → candidate → ledger probation entry | |
| Runner→adapter only | DiagnosticianRunner 调用 PiAiRuntimeAdapter，验证 DiagnosticianOutputV1 + artifact | |
| Both | adapter 集成测试 + full chain E2E，两个独立测试文件 | ✓ |

**User's choice:** Both
**Notes:** Adapter integration 测试验证 adapter 与 runner 的集成（不经过 candidate/ledger）；full chain E2E 验证 pain → artifact → candidate → ledger probation entry 完整链路。

---

## Mock Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Module-level mock | E2E 测试真实 PiAiRuntimeAdapter，通过 vi.mock('@mariozechner/pi-ai') 拦截 LLM 调用 | ✓ |
| Stub adapter | E2E 用 StubRuntimeAdapter 模拟 PiAiRuntimeAdapter 行为，不经过真实 adapter 代码 | |

**User's choice:** Module-level mock
**Notes:** 与单元测试策略一致，E2E 测真实 adapter 代码路径，mock 只拦截 LLM 调用。

---

## Claude's Discretion

- D-04~D-08 细节由 Claude 决定（复用 m8-02-e2e 的 InMemoryLedgerAdapter 模式、test structure 等）

## Deferred Ideas

None — discussion stayed within phase scope
