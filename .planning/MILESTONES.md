# Milestones

## Current: PD Runtime v2 — M3 History Retrieval + Context Build (Started: 2026-04-22)

**Goal:**

- Deliver PD-owned retrieval pipeline: trajectory locate, history query, context build
- Enforce workspace isolation, bounded history, degradation policy

**Exit criteria:**

1. `pd trajectory locate` — locate by trajectoryId, taskId, runId, date range, PD-managed hints
2. `pd history query` — bounded history with cursor pagination + time windows
3. `pd context build` — assemble DiagnosticianContextPayload from PD-owned retrieval
4. Workspace isolation: all retrieval is workspace-scoped, no cross-workspace leakage
5. Degradation policy: bounded fallback, warnings + telemetry, no silent failure, no crashes
6. Degraded mode: status=degraded + warnings, task still proceeds

**Non-goals (M4+ scope):**

- Diagnostician runner v2 (M4)
- Unified commit flow (M5)
- OpenClaw adapter demotion (M6)
- PD CLI control plane expansion (M7)

**Authoritative boundary (M3 执行约束):**

- All authoritative retrieval must use PD-owned stores/indexes/references as primary source
- OpenClaw raw workspace/session files are NOT an authoritative retrieval source
- External/host data may only be accessed through PD-managed references if already indexed by PD
- Context build must be code-generated or template-generated; no LLM call inside context assembly

**GSD files:**

- `.planning/milestones/pd-runtime-v2-m3/REQUIREMENTS.md`
- `.planning/milestones/pd-runtime-v2-m3/ROADMAP.md`
- `.planning/phases/m3-*/`

**Canonical docs:** `docs/pd-runtime-v2/`

---

## v2.1 M2 Task/Run State Core (Shipped: 2026-04-22)

**Goal:**

- Introduce explicit PD-owned task and run truth with lease semantics
- Replace marker-file and heartbeat-based completion inference with deterministic state layer
- Build store abstractions, lease lifecycle, retry metadata, and crash recovery

**Exit criteria:**

1. Diagnostician-like tasks can be leased and recovered without marker-file truth
2. Run records exist independently of legacy heartbeat flow
3. Concurrent lease acquisition is safe
4. Crash recovery correctly re-enqueues expired lease tasks
5. All new types align with M1 contracts
6. Telemetry events emitted for all state transitions
7. Test coverage >= 80%

**Non-goals (M3-M9 scope):**

- Context retrieval (M3)
- Diagnostician runner (M4)
- Commit flow (M5)
- OpenClaw adapter demotion (M6)

**GSD files:**

- `.planning/milestones/pd-runtime-v2-m2/REQUIREMENTS.md`
- `.planning/milestones/pd-runtime-v2-m2/ROADMAP.md`
- `.planning/phases/m2-task-run-state-core/CONTEXT.md`

**Canonical docs:** `docs/pd-runtime-v2/` (README, roadmap, governance, conflict-table)

---

## v1.21.2 YAML Funnel 完整 SSOT (Shipped: 2026-04-19)

**Phases completed:** 3 phases, 3 plans
**Key accomplishments:**
- YAML SSOT wiring complete — `workflows.yaml` genuinely drives `/pd-evolution-status` funnel display
- getSummary() consumes funnels Map — RuntimeSummaryService builds `workflowFunnels` from YAML stage definitions + dailyStats counts
- Display layer YAML-driven — stage labels and order from YAML, not hardcoded
- Graceful degraded mode — missing/invalid YAML → status=degraded + warnings, no crashes
- E2E integration tests (3) using real WorkflowFunnelLoader confirm full pipeline works

---

## v1.21 PD 工作流可观测化 (Shipped: 2026-04-19)

**Phases completed:** 2 phases, 6 plans
**Key accomplishments:**
- diagnostician_report category 三态扩展（success/missing_json/incomplete_fields）
- js-yaml + WorkflowFunnelLoader 类（YAML 配置加载 scaffold; 运行时 SSOT deferred to v1.21.2）
- event-types.ts: 6 new EventType + 3 EventCategory + 6 EventData interfaces
- event-log.ts: 6 recordXxx() methods + 7 new EvolutionStats fields
- Nocturnal: 3 stage events (dreamer_completed, artifact_persisted, code_candidate_created)
- RuleHost: 3 events (evaluated, blocked, requireApproval)

---

## v1.20 v1.20 (Shipped: 2026-04-17)

**Phases completed:** 4 phases, 11 plans, 9 tasks

**Key accomplishments:**

- One-liner:
- 1. [Rule 2 - Missing critical functionality] PainSeverity/TelemetryEventType duplicate identifier error
- 1. [Rule 1 - Bug] DefaultPrincipleInjector P0 forced inclusion incorrect
- 1. [Rule 1 - Bug] agentId and traceId empty strings fail PainSignalSchema validation
- 1. [Rule 1 - Bug] traceId empty string fails PainSignalSchema validation
- 1. [Rule 1 - Bug] WritingPainAdapter conformance fixture wrong
- CodeReviewPainAdapter implemented with 3-signal scoring for code-review domain, validating PainSignalSchema universality against an extreme non-coding domain
- Conformance and E2E validation for CodeReviewPainAdapter with full pain-to-injection pipeline
- API freeze declared and Semver locked at 0.1.0 after cross-domain validation confirms PainSignalSchema universal across coding, writing, and code-review domains

---

## v1.19 Tech Debt Remediation (Shipped: 2026-04-15)

**Phases completed:** 4 phases, 9 plans, 0 tasks

**Key accomplishments:**

- None
- Objective:
- Objective:
- Rule 3 Auto-fix: Export internal functions for testing
- Rule 3 Auto-fix: Export asyncLockQueues Map for test isolation

---

## v1.18 Nocturnal State Safety & Recovery (Shipped: 2026-04-14)

**Phases completed:** 22 phases, 33 plans, 34 tasks

**Key accomplishments:**

- Plan:
- One-liner:
- One-liner:
- deriveReasoningChain() extracting thinking content, uncertainty markers, and confidence signals from assistant turns with 3 exported interfaces
- Full implementations replacing stubs: deriveDecisionPoints correlates tool calls with surrounding assistant turns by timestamp, deriveContextualFactors computes 4 environmental boolean signals
- Extended Dreamer prompt with strategic perspective requirements, optional riskLevel/strategicPerspective fields on DreamerCandidate, and reasoning context injection via formatReasoningContext helper
- Extended Philosopher from 4D to 6D evaluation with Safety Impact and UX Impact dimensions, added risk assessment fields, and wired Dreamer risk profiles into the prompt builder
- Added deterministic 6D scoring and risk assessment to invokeStubPhilosopher, wired philosopher6D aggregation into both stub and real Trinity pipelines, and wrote 9 comprehensive tests covering all PHILO requirements
- RejectedAnalysis
- FPR-weighted confidence scoring with x0.8 decay on false positives and per-workspace 4/day optimization throttle for correction cue keywords
- LLM-driven keyword optimization workflow manager extending WorkflowManagerBase with prompt template, result parsing, and barrel exports for correction observer dispatch
- Dedicated 6-hour keyword_optimization interval and prompt.ts FPR feedback loop wiring, closing CORR-07
- Fixed CR-01 semantic bug (recordFalsePositive -> recordTruePositive) and extracted keyword_optimization trigger outside trigger_mode guard for default idle mode reachability

---

## Current: v1.13 Boundary Contract Hardening (Started: 2026-04-11)

**Goal:**

- remove the recurring "implicit assumption + silent fallback" failure mode from the production nocturnal path
- unify workspace resolution, critical file parsing, and runtime capability checks under explicit contracts
- add end-to-end contract tests so OpenClaw boundary drift breaks tests instead of silently corrupting state

**Planned phases:**

- Phase 19: Unified Workspace Resolution Contract
- Phase 20: Critical Data Schema Validation
- Phase 21: Runtime Contract and End-to-End Hardening

---

## v1.12 Nocturnal Production Stabilization (Shipped: 2026-04-10)

**Phases completed:** 3 phases, 4 plans

**Key accomplishments:**

- Snapshot ingress guardrails reject empty fallback workflows before they become noisy active jobs
- Minimal rule bootstrap created live Rule entities so the code-implementation branch can actually run
- Replay and operator validation path exists and was proven locally

---

## v1.9.3 Remaining Lint Stabilization (Shipped: 2026-04-09)

**Phases completed:** 1 phase, 1 plan

**Key accomplishments:**

- ESLint pipeline restored to green
- Mechanical fixes and explicit suppressions documented

---

## v1.9.0 Principle Internalization System (Shipped: 2026-04-08)

**Phases completed:** 5 phases, 10 plans

**Key accomplishments:**

- Principle -> Rule -> Implementation entities became first-class ledger records
- Runtime Rule Host, replay evaluation, lifecycle commands, and nocturnal implementation artifacts shipped
- Coverage, adherence, and routing surfaces were added
