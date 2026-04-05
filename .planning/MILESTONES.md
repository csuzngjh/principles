# Milestones

## v1.5 Nocturnal Helper 重构 (Planned)

**Target:** Migrate Nocturnal's TrinityRuntimeAdapter to WorkflowManager interface

**Goals:**
- NocturnalWorkflowManager — wrap `OpenClawTrinityRuntimeAdapter` in WorkflowManager interface
- Unified subagent lifecycle for all helper workflows (Empathy, DeepReflect, Nocturnal)
- WorkflowStore event tracking for Trinity 3-stage chain (Dreamer → Philosopher → Scribe)
- Surface degrade checks and idempotency guarantees

**Not included:** Diagnostician migration (刚跑通，风险极高)

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
