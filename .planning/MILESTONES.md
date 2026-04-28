# Milestones

## v2.6 M7 — Principle Candidate Intake (Shipped: 2026-04-27)

**Phases completed:** 5 phases (m7-01 through m7-05), 9 plans
**Key accomplishments:**
- CandidateIntakeService: consumes pending candidates, idempotent ledger entry writing
- pd candidate intake CLI: --candidate-id, --workspace, --json, --dry-run
- PrincipleTreeLedgerAdapter: 11-field → 18+ field expansion, in-memory idempotency Map
- E2E traceability: candidate → artifact → task/run → ledger entry link
- 6 E2E tests + 45 unit tests + 11 CLI integration tests all passing

**Baseline (Frozen):**
- v2.0 M1: Foundation Contracts — SHIPPED 2026-04-21 (PR #392)
- v2.1 M2: Task/Run State Core — SHIPPED 2026-04-22 (PR #393)
- v2.2 M3: History Retrieval + Context Build — SHIPPED 2026-04-23 (PR #394)
- v2.3 M4: Diagnostician Runner v2 — SHIPPED 2026-04-23 (PR #395, #396)
- v2.4 M5: Unified Commit + Principle Candidate Intake — SHIPPED 2026-04-24 (PR #398)
- v2.5 M6: Production Runtime Adapter: OpenClaw CLI Diagnostician — SHIPPED 2026-04-25

**Next:** v2.7 M8 — Pain Signal → Principle Single Path Cutover

---

## v2.7 M8 — Pain Signal → Principle Single Path Cutover (In Progress)

**Goal:** 把痛苦信号到原则账本的端到端链路切到 Runtime v2，删除旧 diagnostician 执行链路。

**Pipeline (single path):**
pain → PD task/run store → DiagnosticianRunner → OpenClawCliRuntimeAdapter → DiagnosticianOutputV1 → SqliteDiagnosticianCommitter → principle_candidates → CandidateIntakeService → PrincipleTreeLedger probation entry

**Constraints:**
- Legacy deletion 只针对旧诊断执行路径，不删除无关的 evolution-worker 功能
- M8 成功标准：链路终点必须是 PrincipleTreeLedger probation entry
- Candidate intake 是 happy path 的一部分

**Non-goals:** 不保留旧诊断开关、不做 legacy fallback

**Depends on:** M7

**Plans:** TBD

---

## PD Runtime v2 — M5 Unified Commit + Principle Candidate Intake (Shipped: 2026-04-24)

**Goal:**

- diagnostician output -> diagnosis artifact -> principle candidate -> task resultRef，全链路在 SQLite .pd/state.db 内原子完成
- DiagnosticianCommitter 接口隔离，runner 只依赖 Committer
- commit 失败 = artifact_commit_failed，不能"任务成功但 candidate 缺失"
- E2E 硬门槛：task→run→output→artifact→candidate→resultRef 全链路可追溯

**Exit criteria:**

1. Every succeeded diagnostician task has a committed artifact in state.db
2. Principle candidates from recommendations are registered in state.db
3. Commit and candidate registration are atomic (single SQLite transaction)
4. Commit failure prevents task from reaching succeeded status
5. CLI can list candidates and show artifact details via fixed commands
6. Telemetry events cover all commit and candidate operations
7. E2E test verifies: idempotency, failure path, full traceability, candidate list visibility
8. Test coverage >= 80% for new code
9. No "task succeeded but candidate missing" state is possible
10. resultRef format is `commit://<commitId>`

**Non-goals (M6-M9 scope):**

- Principle promotion / gating (M6+)
- Active principle injection (M6+)
- OpenClaw adapter demotion (M6)
- Multi-runtime adapter suite (M8)

**GSD files:**

- `.planning/milestones/pd-runtime-v2-m5/REQUIREMENTS.md`
- `.planning/milestones/pd-runtime-v2-m5/ROADMAP.md`

**Baseline (Frozen):**

- M1 Foundation Contracts — SHIPPED 2026-04-21 (PR #392)
- M2 Task/Run State Core — SHIPPED 2026-04-22 (PR #393)
- M3 History Retrieval + Context Build — SHIPPED 2026-04-23 (PR #394)
- M4 Diagnostician Runner v2 — SHIPPED 2026-04-23 (PR #395, #396)

**Canonical docs:** `docs/pd-runtime-v2/`

---

## PD Runtime v2 — M4 Diagnostician Runner v2 (Shipped: 2026-04-23)

**Phases completed:** 6 phases (m4-01 through m4-06)
**Key accomplishments:**
- DiagnosticianRunner with explicit runner-driven execution lifecycle
- TestDoubleRuntimeAdapter as first PDRuntimeAdapter consumer
- DiagnosticianOutputV1 validation (schema + semantic checks)
- Lease/retry/recovery integration with M2 DefaultLeaseManager
- Telemetry events for all runner state transitions
- `pd diagnose run/status` CLI commands
- Dual-track verification: legacy heartbeat path still works alongside new runner

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
