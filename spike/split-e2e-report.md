# Split Diagnostician E2E Test Report

**Date**: 2026-06-12T00:35:50.704Z
**Model**: qwen3.6-27b-mtp
**Core Grounding**: ON
**Fixtures**: 1

## Per-Fixture Results

### ✅ R6 (real) — PRI-363 refactor behavior regression (stage enum change broke tests)
- Axioms: T-01, T-03
- Total time: 244.1s

| Stage | Schema Valid | Repair Needed | Time |
|-------|-------------|---------------|------|
| A-RootCause | ✓ | no | 90.8s |
| B-Distiller | ✓ | no | 61.7s |
| C-Router | ✓ | no | 91.7s |

**Monolith comparison**: Monolith: "PRI-363重构导致pain.test.ts行为回归：stage枚举值变更未同步更新测试断言与集成逻辑，破坏行为等价承诺。..." | Split: "PRI-363 重构因缺乏影响面评估与向后兼容机制导致枚举变更破坏下游契约；需建立重构前全面评估与兼容性保障规范，避免破坏性变更波及依赖。..."

## Aggregate Statistics

### A-RootCause
- Success rate: 1/1 (100%)
- Average time: 90.8s
- JSON repair needed: 0/1

### B-Distiller
- Success rate: 1/1 (100%)
- Average time: 61.7s
- JSON repair needed: 0/1

### C-Router
- Success rate: 1/1 (100%)
- Average time: 91.7s
- JSON repair needed: 0/1

## Monolith vs Split Comparison

- **R6**: Monolith: "PRI-363重构导致pain.test.ts行为回归：stage枚举值变更未同步更新测试断言与集成逻辑，破坏行为等价承诺。..." | Split: "PRI-363 重构因缺乏影响面评估与向后兼容机制导致枚举变更破坏下游契约；需建立重构前全面评估与兼容性保障规范，避免破坏性变更波及依赖。..."
