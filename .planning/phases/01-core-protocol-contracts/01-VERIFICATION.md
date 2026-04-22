---
phase: 01-core-protocol-contracts
status: passed
verified: "2026-04-21T21:30:00.000Z"
verifier: orchestrator-inline
---

# Phase 1 Verification: Core Protocol + Agent + Error Contracts

## Phase Goal

定义 runtime-v2 最核心的 protocol、agent 和 error 类型

## Success Criteria Verification

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | `AgentSpec` interface 可从 `@principles/core/runtime-v2` 导入 | PASS | AgentSpecSchema exported as TypeBox object, AgentSpec type derived via Static |
| 2 | `PDRuntimeAdapter` interface 包含文档 Section 8 定义的全部方法 | PASS | 9 methods + 1 optional: kind, getCapabilities, refreshCapabilities?, healthCheck, startRun, pollRun, cancelRun, fetchOutput, fetchArtifacts, appendContext? |
| 3 | `PDErrorCategory` 覆盖所有错误 | PASS | 16 literal values from Union of Protocol Spec §19 + Diagnostician §20 + History §14 |
| 4 | `PDTaskStatus` 的状态值与 Protocol Spec Section 12.2 一致 | PASS | 5 states: pending, leased, succeeded, retry_wait, failed |
| 5 | `RuntimeSelector` interface 已定义 | PASS | 4 methods: select, register, getHealthSnapshot, getCapabilitiesSnapshot |

## Requirements Traceability

| Req ID | Description | Plan | Status |
|--------|-------------|------|--------|
| ERR-01 | PDErrorCategory 16 values with TypeBox schema | 01-01 | PASS |
| ERR-02 | PDRuntimeError class with category field | 01-01 | PASS |
| ERR-03 | PdError unified with PDErrorCategory | 01-03 | PASS |
| AGENT-01 | AgentSpec interface with 10 fields | 01-01 | PASS |
| AGENT-02 | AGENT_IDS constant (8 well-known) | 01-01 | PASS |
| AGENT-03 | AgentCapabilityRequirements schema | 01-01 | PASS |
| SCH-01 | Schema versioning utilities | 01-01 | PASS |
| RT-01 | RuntimeKind 5 literals | 01-02 | PASS |
| RT-02 | RuntimeCapabilities 9 flags + dynamic | 01-02 | PASS |
| RT-03 | RuntimeHealth schema | 01-02 | PASS |
| RT-04 | PDRuntimeAdapter interface (9 methods) | 01-02 | PASS |
| RT-05 | Run lifecycle types (RunHandle, RunStatus) | 01-02 | PASS |
| RT-06 | StartRunInput schema | 01-02 | PASS |
| TASK-01 | PDTaskStatus 5 states | 01-02 | PASS |
| TASK-02 | TaskRecord schema | 01-02 | PASS |
| TASK-03 | DiagnosticianTaskRecord extends TaskRecord | 01-02 | PASS |
| SEL-01 | RuntimeSelector interface | 01-02 | PASS |

## Automated Checks

- [x] `npx tsc --noEmit -p packages/principles-core/tsconfig.json` — PASS (zero errors)
- [x] `npx tsc --noEmit -p packages/openclaw-plugin/tsconfig.json` — PASS (zero errors)
- [x] All TypeBox schemas import from `@sinclair/typebox`
- [x] All types derived via `Static<typeof XxxSchema>`
- [x] PDRuntimeAdapter and RuntimeSelector remain as TypeScript interfaces (not schemas)
- [x] No mutations to subclass constructors (backward compatible)

## Plan Summaries

1. **01-01**: Foundation TypeBox schemas (error-categories, agent-spec, schema-version) — 3/3 tasks
2. **01-02**: Runtime protocol TypeBox schemas (runtime-protocol, task-status, runtime-selector) — 3/3 tasks
3. **01-03**: PdError unification with PDErrorCategory — 1/1 task

## Issues Found

None.

## human_verification

None required — all criteria are mechanically verifiable.
