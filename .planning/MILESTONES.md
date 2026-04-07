# Milestones

## v1.6 代码质量清理 (In Progress: 2026-04-07)

**Goal:** 清理代码膨胀、修复危险命名冲突、解决遗留路径断裂问题

**Target features:**

- CLEAN-01: 修复 `normalizePath` 命名冲突
- CLEAN-02: 解决 PAIN_CANDIDATES 遗留路径
- CLEAN-03: 提取 WorkflowManager 基类
- CLEAN-04: 统一重复类型定义
- CLEAN-05: 调查 empathy-observer-workflow-manager 引用
- CLEAN-06: 添加 build artifacts 到 .gitignore

**Key analysis findings:**
- `normalizePath` naming collision — DIFFERENT signatures in utils/io.ts vs nocturnal-compliance.ts
- PAIN_CANDIDATES legacy path — two parallel disconnected pain processing systems
- Workflow Manager ~1200 lines duplicated across 3 files
- trajectory.ts (1673 lines) — core doesn't consume it
- Nocturnal Trinity (~6000 lines) — optional training data pipeline

---

## v1.5 Nocturnal Helper 重构 (Shipped: 2026-04-06)

**Phases completed:** 5 (Phase 6, 7, 8, 9, 10)

**Key accomplishments:**

- NocturnalWorkflowManager implementing WorkflowManager interface with single-reflector path and Trinity chain support
- WorkflowStore extended with stage_outputs table for Trinity stage persistence and idempotency (NOC-11/12/13)
- evolution-worker integrated with NocturnalWorkflowManager — stub-based fallback on Trinity failure
- StubFallbackRuntimeAdapter method signatures fixed to match TrinityRuntimeAdapter interface (NOC-15)
- Phase 8 architectural shift: direct stage-by-stage invocation for fine-grained persistence control

**Known gaps:**
- Phases 07, 08 missing VERIFICATION.md (implementations exist, low priority)
- NOC requirements not formally defined in REQUIREMENTS.md (tracked in milestone audit)
- Pre-existing TypeScript errors in evolution-reducer.ts and prompt.ts (unrelated to v1.5)

---

## v1.4 OpenClaw v2026.4.3 Compatibility (Shipped: 2026-04-05)

**Phases completed:** 3 (Phase 1, 2, 5)

**Key accomplishments:**

- SDK Type Cleanup: Removed false type declarations, aligned SDK shim with v2026.4.4 types
- Memory Search (FTS5): Replaced deprecated createMemorySearchTool with native FTS5 search on pain_events
- Integration Testing: TEST-01~03 pass; TEST-04/05 pending runtime verification via Feishu

**Known gaps:**
- TEST-04: deep_reflect tool runtime verification pending (Feishu session routing — fix applied but not re-tested)
- TEST-05: Hook triggering verification pending (same Feishu session routing)

---

## 1.0 v1.0-alpha MVP (Shipped: 2026-03-26)

**Phases completed:** 6 phases, shipped 2026-03-26

**Key accomplishments:**

- SDK Integration: Removed false type declarations from openclaw-sdk.d.ts to align with OpenClaw v2026.4.3
- Memory Search: Replaced createMemorySearchTool with FTS5 semantic search on pain_events table
- SDK Refinement: Factory pattern adoption for tool registration
- Input Quarantine: PD-specific input isolation layer
- Gate Split: Gate module refactored into separate concerns (72% code reduction)
- Defaults & Errors: Centralized configuration and error handling

**Known gaps:** Phases 3A/3B/3C completed but lack GSD SUMMARY.md documentation (pre-GSD phase tracking)

---
