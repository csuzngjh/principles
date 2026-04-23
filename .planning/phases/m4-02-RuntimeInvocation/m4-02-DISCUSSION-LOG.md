# Phase m4-02: RuntimeInvocation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.

**Date:** 2026-04-23
**Phase:** m4-02-RuntimeInvocation
**Areas discussed:** TestDouble behavior, Configuration API, Phase scope

---

## TestDouble 行为模式

| Option | Description | Selected |
|--------|-------------|----------|
| Simple sync | pollRun returns terminal on first call. Simplest, m4-01 StubRuntimeAdapter already this pattern | ✓ |
| Async polling sim | pollRun returns running then succeeded. More realistic but more complex | |
| Configurable mode | Support both via constructor flag. Flexible but premature abstraction | |

**User's choice:** 简单同步（推荐）
**Notes:** m4-01 integration tests already verified polling loop with mocks. TestDouble's value is proving PDRuntimeAdapter interface can be fully implemented.

---

## Configuration API Design

| Option | Description | Selected |
|--------|-------------|----------|
| Constructor scenario presets | Pass named scenarios (always-succeed, always-fail). Simple but rigid | |
| Callback injection | onStartRun/onPollRun/onFetchOutput callbacks. Like m4-01 Stub pattern but reusable | ✓ |
| Progressive | Start with presets, add callbacks in m4-04 | |

**User's choice:** 回调注入（推荐）
**Notes:** m4-04 needs dynamic behavior (timeout then succeed). Callbacks let later phases extend without modifying adapter.

---

## Phase Scope Boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Adapter + wiring only | Just TestDoubleRuntimeAdapter + StartRunInput verification. m4-04/m4-06 do integration | ✓ |
| Include basic integration | runner+TestDouble integration tests (happy + failure). Retry/lease still in m4-04 | |

**User's choice:** 仅 adapter + 接线（推荐）
**Notes:** m4-01 integration tests already cover runner+mock happy/failure paths. No incremental value in repeating.

---

## Claude's Discretion

- TestDoubleBehaviorOverrides interface field design
- Default DiagnosticianOutputV1 content
- Helper function exports (createSucceedingTestDouble())

## Deferred Ideas

- Async polling simulation (m4-04 can implement via callback injection)
- Production OpenClaw adapter (M6 scope)
- runner+adapter integration tests (m4-04/m4-06 scope)
