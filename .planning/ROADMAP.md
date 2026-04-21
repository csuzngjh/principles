# Roadmap: v2.0 PD Runtime v2 — M1 Foundation Contracts

## Milestones

- [x] **v1.22** — PD CLI Redesign — SHIPPED 2026-04-20
- [ ] **v2.0** — M1 Foundation Contracts (Phase 1-4) — IN PROGRESS

## Phase Summary

- [x] **Phase 1: Core Protocol + Agent + Error Contracts** — AgentSpec, PDRuntimeAdapter, PDErrorCategory, RuntimeSelector, PDTaskStatus — COMPLETE 2026-04-21
- [ ] **Phase 2: Context + Diagnostician Contracts** — ContextPayload, HistoryQueryEntry, DiagnosticianOutputV1
- [ ] **Phase 3: Package Infrastructure** — Re-exports, package.json exports, index.ts wiring
- [ ] **Phase 4: Verification + Doc Sync** — Compile check, conflict table, deprecation markers

---

## Phase Details

### Phase 1: Core Protocol + Agent + Error Contracts
**Goal**: 定义 runtime-v2 最核心的 protocol、agent 和 error 类型
**Depends on**: Nothing
**Requirements**: AGENT-01, AGENT-02, AGENT-03, ERR-01, ERR-02, ERR-03, RT-01, RT-02, RT-03, RT-04, RT-05, RT-06, SEL-01, TASK-01, TASK-02, TASK-03, SCH-01
**Plans:** 3 plans
Plans:
- [x] 01-01-PLAN.md — Foundation TypeBox schemas (error-categories, agent-spec, schema-version)
- [x] 01-02-PLAN.md — Runtime protocol TypeBox schemas (runtime-protocol, task-status, runtime-selector)
- [x] 01-03-PLAN.md — PdError unification with PDErrorCategory
**Success Criteria**:
1. `AgentSpec` interface 可从 `@principles/core/runtime-v2` 导入
2. `PDRuntimeAdapter` interface 包含文档 Section 8 定义的全部方法
3. `PDErrorCategory` 覆盖 Protocol Spec Section 19 + Diagnostician Section 20 + History Spec Section 14 的所有错误
4. `PDTaskStatus` 的状态值与 Protocol Spec Section 12.2 一致
5. `RuntimeSelector` interface 已定义（不要求实现）

---

### Phase 2: Context + Diagnostician Contracts
**Goal**: 定义上下文 payload 和诊断输出的 canonical schema
**Depends on**: Phase 1
**Requirements**: CTX-01, CTX-02, CTX-03, CTX-04, CTX-05, DIAG-01, DIAG-02
**Plans:** 1 plan
Plans:
- [ ] 02-01-PLAN.md — Context payload + diagnostician output TypeBox schemas
**Success Criteria**:
1. `ContextPayload` 与 History Spec Section 9.4 一致
2. `DiagnosticianContextPayload` 与 Diagnostician v2 Design Section 9.4 一致
3. `DiagnosticianOutputV1` 与 Diagnostician v2 Design Section 11.2 一致
4. `TrajectoryLocateResult` 与 Protocol Spec Section 15.4 一致

---

### Phase 3: Package Infrastructure
**Goal**: 将所有 contracts 正确暴露为包入口
**Depends on**: Phase 1, Phase 2
**Requirements**: INFRA-01, INFRA-02, INFRA-03
**Success Criteria**:
1. `import { AgentSpec } from '@principles/core/runtime-v2'` 可用
2. `import { AgentSpec } from '@principles/core'` 也可用（向后兼容）
3. `package.json` exports 包含 `./runtime-v2` 入口

---

### Phase 4: Verification + Doc Sync
**Goal**: 验证编译通过，输出冲突表，标记旧定义为 deprecated
**Depends on**: Phase 3
**Requirements**: VER-01, VER-02, VER-03, DOC-01, DOC-02
**Success Criteria**:
1. `npx tsc --noEmit` 零新增错误（排除预存 io.ts）
2. 冲突表已输出，标明每个重复定义的 canonical vs legacy 位置
3. 旧 TrinityRuntimeFailureCode、QueueStatus (evolution-worker) 标记为 deprecated

---

## Progress

| Phase | Goal | Requirements | Status |
|-------|------|--------------|--------|
| 1. Core Protocol | AgentSpec, RuntimeAdapter, Errors, TaskStatus | 17 reqs | Complete (2026-04-21) |
| 2. Context + Diag | ContextPayload, DiagnosticianOutput | 7 reqs | In Progress |
| 3. Infrastructure | Re-exports, package.json | 3 reqs | Pending |
| 4. Verification | Compile, conflict table, deprecation | 5 reqs | Pending |

---
*Created: 2026-04-21 for v2.0 M1 Foundation Contracts milestone*
