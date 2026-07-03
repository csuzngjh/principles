# ADR-0019: Diagnostician LLM Rate-Limit Graceful Degradation

> **Status**: Proposed
> **Date**: 2026-07-03
> **Decider**: Owner
> **Context**: MVP-First (ADR-0014), seed-customer readiness, PRI-442 internal acceptance test finding

## 1. Context

PRI-442 internal acceptance testing (2026-07-03) observed that when the diagnostician's LLM provider hits rate limits, the diagnostic task hard-fails with `max_attempts_exceeded`, blocking the six-step closed loop (pain → diagnosis → principle → review → activation → behavior change). The pain signal cannot flow downstream to principle extraction, effectively halting PD during rate-limit windows.

**Current behavior** (before this ADR):
- `completeWithRetry()` (`pi-ai-runtime-adapter.ts`) retries LLM calls up to 2 times with exponential backoff. Rate-limit errors are classified as generic `execution_failed` — there is no `rate_limit` error category.
- `retryOrFail()` (`base-peer-runner.ts`) retries the task up to `maxAttempts` (default 3). On exhaustion, `markTaskFailed('max_attempts_exceeded')` is called. No degraded output is produced.
- ADR-0014 §385 states "Graceful degradation is mandatory and tested" but only covers Artificer L2, not the diagnostician LLM path.

**Problem**: Rate limiting is the most common LLM failure mode seed customers will encounter (shared API keys, free-tier quotas, burst traffic). Hard-failing the diagnostic task on rate limits blocks the entire PD pipeline. The pain signal should not be blocked by a transient upstream LLM condition.

## 2. Decision

### 2.1 New `rate_limit` error category

Add `rate_limit` to `PDErrorCategory` (`error-categories.ts`), distinct from `execution_failed`. This allows downstream consumers (CLI trace, telemetry, retry logic) to distinguish rate-limit failures from other execution failures.

### 2.2 Rate-limit detection in `completeWithRetry()`

Detect rate-limit signatures in provider error messages using a regex (`rate.?limit|429|quota|too many requests`, case-insensitive). When detected:
- Classify as `rate_limit` (not `execution_failed`)
- Use longer backoff (2× the normal delay) since rate limits typically need more time to clear
- On retry exhaustion, throw `PDRuntimeError('rate_limit', ...)` with provider evidence

### 2.3 Degradation path in `retryOrFail()`

When `errorCategory === 'rate_limit'` AND the `diagnostician_llm_degradation` feature flag is enabled:
- Emit `diag_llm_rate_limit_degraded` telemetry event with `taskId`, `provider`, `attemptCount`, `failureReason`, and `nextAction`
- Call `markTaskFailed(taskId, 'rate_limit', ...)` — the task is marked failed with `rate_limit` errorCategory (not `max_attempts_exceeded`), so downstream can distinguish
- Return a `failed` result with `rate_limit` errorCategory

This is **observable degradation** (rc-9: no silent fallback): the task still fails, but:
1. The `rate_limit` errorCategory distinguishes it from hard failures
2. The `diag_llm_rate_limit_degraded` telemetry event carries a `nextAction` ("Retry diagnosis manually with `pd pain retry` when rate limit clears")
3. The owner can identify rate-limited tasks via `pd runtime trace` and retry them when the rate limit clears

When the flag is **off** (default): rate-limit errors flow through the existing `retryOrFail` path and produce `max_attempts_exceeded` — identical to current behavior. Zero behavior change.

### 2.4 Feature flag

Register `diagnostician_llm_degradation` in `DEFAULT_FEATURE_FLAGS`:
- `category: 'quiet'`
- `enabled: false` (default off, per ADR-0014)
- `since: '2026-07-03'`
- Flag-off = current hard-fail behavior (zero migration)

### 2.5 Out of scope (deferred to post-MVP)

- **Provider fallback chain**: automatically switching to a backup LLM provider on rate limit. Requires multi-provider config, health probing, and output schema compatibility checks — too large for MVP.
- **New `degraded` task status**: adding a `degraded` state to TaskRecord would touch state manager, task record schema, CLI trace, and UI. The `rate_limit` errorCategory + telemetry event achieves observability without schema changes.
- **Automatic retry scheduling**: queueing rate-limited tasks for automatic retry after a cooldown. Currently relies on manual `pd pain retry`.

## 3. Alternatives Considered

### A. New `degraded` task status (instead of `rate_limit` errorCategory)

**Rejected**: Requires changes to TaskRecord schema, RuntimeStateManager, CLI trace output, and potentially UI. Disproportionate for MVP. The `rate_limit` errorCategory on `markTaskFailed` achieves the same observability with zero schema changes.

### B. Provider fallback chain

**Rejected for MVP**: Requires multi-provider runtime profile config, provider health probing, output schema compatibility across providers. Deferred to post-MVP per ADR-0014 scope discipline.

### C. Only ADR, no implementation

**Rejected**: User explicitly chose "ADR + implement degradation" during PRI-442 planning. Without implementation, the ADR is aspirational and the hard-fail behavior persists.

### D. Extend ADR-0014 §385 degradation principle

**Rejected**: ADR-0014 §385 is specific to Artificer L2. Mixing diagnostician degradation into it would muddy the Artificer-specific amendment. A focused ADR-0019 is clearer.

## 4. MVP Three Questions

1. **What happens if we DON'T do this?** (`mvp-q-1-what-if-skip`)
   Rate-limit windows hard-fail diagnostic tasks, blocking the six-step closed loop. Seed customers on shared/free-tier API keys will see PD stall during rate-limit windows with no recovery path except manual intervention. This WILL be raised within 30 days of the first seed customer.

2. **How is it observed?** (`mvp-q-2-how-observed`)
   - `diag_llm_rate_limit_degraded` telemetry event (carrying taskId, provider, attemptCount, nextAction)
   - `pd runtime trace` shows tasks with `rate_limit` errorCategory (distinct from `max_attempts_exceeded`)
   - Unit tests verify: rate-limit regex matching, flag-off hard-fail, flag-on degradation + telemetry

3. **How is it disabled?** (`mvp-q-3-how-disabled`)
   Feature flag `diagnostician_llm_degradation` defaults to `false`. Flip to `false` (or leave unset) in `.pd/config.yaml` to restore current hard-fail behavior. Zero data migration — both paths use `markTaskFailed`, only the errorCategory and telemetry differ.

4. **Emotional value?** (`mvp-q-4-emotional-value`)
   Reduces **失控感** (loss of control): during rate-limit windows, the owner sees structured degradation (`rate_limit` + `nextAction`) instead of opaque hard failures. Creates **清醒感** (clarity): the owner knows exactly why diagnosis stalled and what to do next (`pd pain retry`).

## 5. Consequences

- **Positive**: Rate-limit failures become observable and distinguishable. Owners can identify and retry rate-limited tasks. PD pipeline no longer hard-blocks on transient upstream conditions (when flag is on).
- **Negative**: Tasks still fail on rate limit (no automatic retry scheduling). Owners must manually retry. This is acceptable for MVP — automatic retry scheduling is deferred.
- **Neutral**: New `rate_limit` error category must be mapped in `FAILURE_CATEGORY_MAP` and handled in any exhaustive switch over `PDErrorCategory`.

## 6. Compliance

- **rc-9 (no silent fallback)**: Degradation path emits `diag_llm_rate_limit_degraded` telemetry with `nextAction`. Not silent.
- **ERR-002 (catch-and-degrade)**: Degradation includes structured reason + next action, not silent swallow.
- **ADR-0014**: Feature flag registered as `quiet`, default off. No MVP-Core expansion.
- **EP-05 (loop state freshness)**: `completeWithRetry` reads fresh `rawMessage` each attempt; no stale state.

## 7. References

- [ADR-0014](0014-mvp-first-strategy-and-product-pivot.md) §385 — graceful degradation principle (Artificer L2)
- [PRI-442](https://linear.app/principles-disciple/issue/PRI-442) — internal acceptance test finding
- `packages/principles-core/src/runtime-v2/error-categories.ts` — PDErrorCategory
- `packages/principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts` — completeWithRetry
- `packages/principles-core/src/runtime-v2/runner/base-peer-runner.ts` — retryOrFail
- `packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts` — DEFAULT_FEATURE_FLAGS
