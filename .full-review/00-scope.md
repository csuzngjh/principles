# Review Scope

## Target

PR #353: `packages/principles-core` v0.1.0 — Universal SDK foundation with PainSignal adapters for 3 domains (coding, writing, code-review)

## Files

### Source (`packages/principles-core/src/`)
- `src/types.ts` — Shared type definitions
- `src/pain-signal.ts` — PainSignalSchema (12-field universal schema), deriveSeverity(), validatePainSignal()
- `src/pain-signal-adapter.ts` — PainSignalAdapter<TRawEvent> generic interface
- `src/evolution-hook.ts` — EvolutionHook interface
- `src/storage-adapter.ts` — StorageAdapter interface
- `src/telemetry-event.ts` — TelemetryEvent schema
- `src/principle-injector.ts` — PrincipleInjector interface, DefaultPrincipleInjector (budget-aware P0 forced inclusion)
- `src/index.ts` — Public exports
- `src/adapters/coding/openclaw-pain-adapter.ts` — Coding domain adapter
- `src/adapters/writing/writing-pain-adapter.ts` — Writing domain adapter
- `src/adapters/code-review/code-review-pain-adapter.ts` — Code review domain adapter (3-signal weighted: 0.25*complexity + 0.35*sentiment + 0.40*process_violation)

### Tests (`packages/principles-core/tests/`)
- 14 test files covering unit, conformance, benchmarks, E2E

## Flags

- Security Focus: no
- Performance Critical: no
- Strict Mode: no
- Framework: TypeScript (Node.js/npm package)

## Review Phases

1. Code Quality & Architecture
2. Security & Performance
3. Testing & Documentation
4. Best Practices & Standards
5. Consolidated Report
