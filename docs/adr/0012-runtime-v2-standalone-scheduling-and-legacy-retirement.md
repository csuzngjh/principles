# ADR-0012: Runtime V2 Standalone Scheduling and Legacy Execution Retirement

> **Status**: Accepted
> **Date**: 2026-05-23
> **Supersedes**: ADR-0005 sections that retain `IdleTrigger` / OpenClaw night-mode scheduling
> **Related**: ADR-0001, ADR-0003, ADR-0005, ADR-0011

## 1. Decision

PD will converge on **Runtime V2 as the only forward execution path**.

The following capabilities are retired rather than migrated forward:

- OpenClaw idle/night-mode scheduling and sleep-cycle heuristics.
- Nocturnal Trinity execution, validation, workflow orchestration and its duplicated runtime contracts.
- Plugin-owned workspace discovery/configuration logic that exists only to launch the duplicated Nocturnal flow.

The following limited compatibility surfaces may remain until explicitly removed:

- Read-only import/export of historical Nocturnal artifacts when data actually exists.
- Minimal host adapters that submit pain/events or expose a configured `PDRuntimeAdapter`.
- Command aliases only when they delegate to Runtime V2 or explain retirement; they must not execute the legacy pipeline.

## 2. Why the previous migration posture changed

During early Runtime V2 development, freezing the legacy files was a safe constraint: modifying an old production path while the replacement was unproven could lose the only working route.

That condition no longer holds. Runtime V2 now has:

- A validated pain-to-internalization baseline and live bridge checks.
- Peer runners, structured output repair, integrity/remediation and successor enqueue tooling.
- RuleHost activation safety, sandbox/replay boundaries and approval foundations.
- Adversarial tests for broken artifacts, output corruption, dedupe pressure and path-boundary enforcement.

At the same time, the duplicated OpenClaw path remains expensive:

- `nocturnal-trinity.ts`, `nocturnal-arbiter.ts` and `nocturnal-service.ts` alone are approximately 4,800 lines.
- `EvolutionWorkerService` still imports Trinity runtime and starts Nocturnal workflows.
- Plugin commands still expose Nocturnal review/training/rollout surfaces.
- Duplicate implementation and test paths make every review, CI run and incident diagnosis slower.

Maintaining two business pipelines no longer reduces risk; it now creates risk and cost.

## 3. Scheduling and SDK boundary

PD built-in agents must not depend on OpenClaw becoming idle before useful work can run.

The target boundary is:

```text
PD configuration / SDK / operator command / future MissionScheduler
        -> Runtime V2 queue and orchestrator
        -> PDRuntimeAdapter supplied by the active host
```

Rules:

- OpenClaw may provide an adapter and emit pain/events; it is not PD's scheduler.
- No new feature may depend on `sleep-cycle`, idle jitter, or nocturnal quota/cooldown state.
- Workspace/runtime configuration belongs to a PD-owned configuration contract. Host adapters supply resolved configuration or SDK capabilities; core consumes validated values.
- A future scheduler must be PD-owned and host-agnostic. It must not revive the IdleTrigger architecture under a different name.

## 4. Retirement sequence

Deletion is intentional, but it is performed after callers are cut over so failures remain diagnosable.

| Step | Outcome | Why it comes first |
|------|---------|--------------------|
| 1. Entrypoint census and retirement guard | Every live Nocturnal caller and required historical reader is known; no new imports allowed | Prevent deleting a still-running entrypoint |
| 2. Explicit Runtime V2 scheduling/config boundary | Operators/SDK can start or drain Runtime V2 without OpenClaw idle state | Replaces the removed trigger requirement |
| 3. EvolutionWorker / workflow cutover | Plugin no longer starts Nocturnal business execution | Removes the principal live dependency |
| 4. Historical read/export isolation | Any useful old artifacts are read through a narrow, read-only adapter | Avoids retaining execution code for storage compatibility |
| 5. Legacy execution deletion | Remove Trinity/Arbiter/Artificer/NocturnalService execution and obsolete commands | Delivers the code/test reduction |
| 6. Test and CI contraction | Remove tests that only protect retired execution; retain migration and Runtime V2 E2E/chaos coverage | Realizes iteration-speed benefits |

## 5. What is deliberately not retained

- A dual-run or feature-flagged Nocturnal execution path.
- Plugin idle scheduling as fallback.
- Configuration solely for Nocturnal cooldown/quota behavior.
- Tests that exist only to guarantee behavior of deleted execution code.

Because PD has no external compatibility commitment today, carrying these forward is more costly than removing them.

## 6. Guardrails

- Runtime V2 remains the canonical data model and state machine.
- Core remains free of host APIs and physical I/O except existing approved persistence boundaries undergoing separate cleanup.
- Retirement PRs must not quietly change ledger semantics, activation safety, lineage validation or structured-output contracts.
- Every cutover PR must contain production-path tests proving the old caller no longer controls execution.
- Legacy data readers are read-only and must report whether historical data was found; silent compatibility fallbacks are forbidden.

## 7. Consequences

Positive:

- Thousands of duplicated plugin lines and related tests can be removed.
- Runtime failures have one execution path to diagnose.
- PD can operate through its own SDK/configuration and scheduler evolution rather than OpenClaw lifecycle quirks.
- Future agent/runtime support is an adapter concern, not a plugin business-logic rewrite.

Cost:

- Several short, ordered cutover PRs are required before deletion.
- Any historical Nocturnal data worth retaining needs an explicit read/export decision.
- Documentation and stale Linear issues must be corrected immediately to prevent agents rebuilding the retired path.
