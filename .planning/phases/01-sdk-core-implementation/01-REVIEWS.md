---
phase: "1"
reviewers: [gemini, codex]
reviewed_at: 2026-04-17T00:00:00Z
plans_reviewed: [01-01-PLAN.md, 01-02-PLAN.md, 01-03-PLAN.md, 01-04-PLAN.md, 01-05-PLAN.md, 01-06-PLAN.md, 01-07-PLAN.md]
---

# Cross-AI Plan Review — Phase 1

## Gemini Review

### Summary
The Phase 1 plans successfully transition the universal evolution engine from abstract interfaces to a functional, high-performance SDK package (`@principles/core`). By prioritizing clean architectural boundaries (no imports from `openclaw-plugin`) and validating universality through two distinct domain adapters (Coding and Creative Writing), the plans establish a robust foundation. The two-wave execution strategy is logical and manages risks effectively.

### Strengths
- **Architectural Purity:** Strict one-way dependency (SDK as provider, framework as consumer) via type duplication and interface-only exports.
- **Immediate Domain Validation:** WritingPainAdapter alongside OpenClawPainAdapter proves PainSignal schema is truly universal.
- **High-Signal Testing:** "Conformance Factory" pattern ensures all adapters maintain contract compliance with minimal boilerplate.
- **Performance-First Mindset:** Integrating p99 benchmarks into core test suite ensures SDK remains overhead-neutral.
- **Surgical Implementation:** Adapters are pure translation layers, avoiding scope creep into business logic.

### Concerns
- **LOW: Type Duplication Maintenance:** Duplicating `InjectablePrinciple` and `HybridLedgerStore` creates manual sync requirement.
- **MEDIUM: DefaultPrincipleInjector Gap:** SDK ships without a "ready-to-use" injector — developers for Writing domain need to implement their own selection/formatting.
- **LOW: Benchmark Environmental Sensitivity:** p99 assertions (< 50ms) are environment-dependent, might flag false positives in resource-constrained CI.

### Suggestions
- Strict dependency pinning: use conservative Semver range (`~0.1.0`) until SDK reaches v1.0.0.
- Export granularity: add specific export entry for `types` in `package.json`.
- Refactor Formatter Interfaces: define `PrincipleFormatter` interface in SDK to close the DefaultPrincipleInjector gap.

### Risk Assessment: **LOW**

---

## Codex Review

### Summary
The Phase 1 plans are directionally solid but not execution-ready. The biggest issue is contract drift: plans promise a complete `@principles/core` SDK with injector exports and p99 injection benchmarks, while detailed tasks leave `DefaultPrincipleInjector` behind in `openclaw-plugin` and defer injection benchmarking.

### Strengths
- Clean package boundary: `principles-core` must not import from `openclaw-plugin`.
- Good adapter split: pure translation layers with no I/O or LLM calls.
- Conformance factory direction matches existing storage conformance pattern.
- Plans explicitly call out duplicated type shapes instead of hiding SDK boundary cost.

### Concerns
- **HIGH: DefaultPrincipleInjector contract inconsistent.** Plan 01-01 says DefaultPrincipleInjector is exported/moved, then later says it cannot be moved. Plan 01-06 defers injection benchmarks. Fails Phase 1 success criterion requiring injection p99 documentation.
- **HIGH: Runtime export tests invalid for TypeScript interfaces.** `expect(mod.PrincipleInjector).toBeDefined()` will fail because interfaces don't exist at runtime. Need TypeScript compile assertions instead.
- **MEDIUM: Type duplication accepted but not controlled.** No compatibility test comparing SDK shapes against `openclaw-plugin` source contracts.
- **MEDIUM: p99 benchmarks too sensitive and incomplete.** Manual `performance.now()` assertions noisy under CI, GC, cold start. Warmup and injection p99 coverage claimed but not implemented.
- **MEDIUM: Dependency ordering too loose.** Plan 01-07 depends only on 01-01 but changelog/build validation should depend on all implementation plans.
- **LOW: Roadmap prerequisite ambiguity.** Phase 0b shows 0/3 plans complete but Phase 1 is being planned/executed.

### Suggestions
- Resolve injector boundary explicitly: move framework-agnostic default injector into `@principles/core`, or rename Phase 1 requirement to "injector interface only" and move injection p99 to later phase.
- Replace runtime interface smoke tests with TypeScript compile assertions (`.ts` fixtures checked by `tsc --noEmit`).
- Add drift guard tests for duplicated SDK shapes.
- Make 01-06 fail if injection p99 absent, or update roadmap success criteria to exclude injection benchmarks for Phase 1.
- Tighten dependencies: 01-07 should depend on 01-01 through 01-06.
- Stabilize benchmarks with warmup, minimum sample count, tolerance notes, CI mode that reports regressions without flakiness.

### Risk Assessment: **HIGH**

---

## Consensus Summary

### Agreed Strengths
1. Clean architectural boundary between `principles-core` and `openclaw-plugin`
2. Pure translation layer adapters (no I/O, no LLM calls in hot paths)
3. Conformance factory pattern following established `describeStorageConformance` precedent
4. p99 performance targets baked into the test strategy

### Agreed Concerns (2+ reviewers)
1. **DefaultPrincipleInjector gap** (HIGH) — interface-only SDK with no usable default injector; injection p99 success criterion unachievable in current plan
2. **Runtime export smoke tests** (HIGH) — TypeScript interfaces don't exist at runtime; `exports.test.ts` will fail
3. **Type duplication drift risk** (MEDIUM) — Manual sync required for `InjectablePrinciple`, `HybridLedgerStore`, OpenClaw event shims
4. **Benchmark sensitivity** (MEDIUM) — p99 assertions environment-sensitive; no warmup or CI tolerance configured
5. **Dependency ordering** (MEDIUM) — Plan 01-07 depends only on 01-01; should depend on all Wave 1 + Wave 2 plans

### Divergent Views
- **Gemini rated risk LOW**; **Codex rated risk HIGH** — Codex's HIGH rating driven by the two HIGH-severity issues (DefaultPrincipleInjector inconsistency + invalid runtime tests) that Gemini classified as MEDIUM/LOW.
- **Resolution:** Both HIGH issues are valid and should be fixed before execution. The DefaultPrincipleInjector issue requires clarifying the phase scope. The runtime test issue requires replacing smoke tests with `tsc --noEmit` assertions.

### Priority Fixes Before Execution
1. **Fix 01-01 / 01-06:** Clarify that `PrincipleInjector` ships as interface only. Update Phase 1 success criteria to acknowledge injection p99 is deferred, OR implement a minimal framework-agnostic `DefaultPrincipleInjector` in the SDK.
2. **Fix 01-02 exports test:** Replace `expect(mod.PrincipleInjector).toBeDefined()` with `tsc --noEmit` type-level assertions.
3. **Fix dependency ordering:** 01-07 depends on 01-01; tighten to 01-01 through 01-06.
4. **Add drift guard:** Compatibility test that verifies openclaw-plugin types satisfy @principles/core interfaces.
