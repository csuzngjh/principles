# Phase m7-01: Candidate Intake Contract - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-26
**Phase:** m7-01-Candidate-Intake-Contract
**Areas discussed:** Intake Input Schema, Ledger Entry Contract, Ledger Adapter Architecture, Status Transition Order

---

## Intake Input Schema

| Option | Description | Selected |
|--------|-------------|----------|
| 仅 candidateId + workspaceDir | Lean 设计，DB 是 SSOT，所有数据可由 stateManager 加载 | ✓ |
| 包含额外验证字段 | 在输入层包含可选的 taskId、artifactId 等做交叉验证 | |
| 由实现决定 | 推迟决策 | |

**User's choice:** 仅 candidateId + workspaceDir
**Notes:** 符合 M6 的 "SQLite 是唯一事实来源" 约束

---

## Ledger Entry Contract

### Question 1: Core fields

| Option | Description | Selected |
|--------|-------------|----------|
| 最小集 + sourceRef | id, title, text, triggerPattern?, action?, status='probation', evaluability='weak_heuristic', sourceRef, createdAt | ✓ |
| 与 LedgerPrinciple 对齐 | 包含更多字段但设默认值 | |
| 由实现决定 | 推迟决策 | |

**User's choice:** 最小集 + sourceRef

### Question 2: Storage target

| Option | Description | Selected |
|--------|-------------|----------|
| 写入现有 ledger | 复用 addPrincipleToLedger() 写入 principle_training_state.json | ✓ |
| 由实现决定 | 推迟决策 | |

**User's choice:** 写入现有 ledger

---

## Ledger Adapter Architecture

### Question 1: Interface location

| Option | Description | Selected |
|--------|-------------|----------|
| Interface 在 core, 实现在 plugin | 依赖反转，松耦合，可测试 | ✓ |
| 合并在 principles-core | 直接从 core 调用 addPrincipleToLedger() | |
| 由实现决定 | 推迟决策 | |

**User's choice:** Interface 在 core, 实现在 plugin

### Question 2: Injection approach

| Option | Description | Selected |
|--------|-------------|----------|
| 构造函数注入 | CandidateIntakeServiceOptions.ledgerAdapter: LedgerAdapter | ✓ |
| 由实现决定 | 推迟决策 | |

**User's choice:** 构造函数注入

---

## Status Transition Order

### Question 1: pending → consumed timing

| Option | Description | Selected |
|--------|-------------|----------|
| 先写 ledger 再更新 | 失败则保持 pending，可重试 | ✓ |
| 先更新再写 ledger | 需要补偿逻辑 | |
| 由实现决定 | 推迟决策 | |

**User's choice:** 先写 ledger 再更新

### Question 2: Idempotency

| Option | Description | Selected |
|--------|-------------|----------|
| 返回已有结果，不报错 | 幂等，调用者无需区分首次和重复 | ✓ |
| 报错，拒绝重复 | 需要调用者检查状态 | |
| 由实现决定 | 推迟决策 | |

**User's choice:** 返回已有结果，不报错

---

## Claude's Discretion

None — user made all decisions directly.

## Deferred Ideas

None — discussion stayed within m7-01 scope.
