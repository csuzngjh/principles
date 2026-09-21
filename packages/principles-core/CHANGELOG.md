# Changelog

## 1.287.1

### Patch Changes

- 75b4ac4: PRI-866 sourcePainId reader convergence: pd-cli's two inline sourcePainId parsers now delegate to the core canonical reader (exported from @principles/core/runtime-v2), and the rulehost pipeline dreamer-task lookup normalizes both sides at the comparison boundary — historical rows or queries carrying surrounding whitespace no longer miss their dreamer seed and are no longer rejected with a misleading no_dreamer_task_seeded.

## 1.287.0

### Minor Changes

- 8424d60: Baseline-cutover accounting for the unpublished source delta between the registry baseline (1.286.0, published from 7e8bf2f0) and current main: internalization pipeline behavioral fixes and additions (dreamer prompt builder, evaluator pain-reason echo, pitask metadata, formation context), owner-decision view contract, pain-to-principle service and sqlite task store changes, and the telemetry event registry — carried by PR #1766 (PRI-846) and PR #1781 (PRI-874). These source changes were never released: the version number alignment to 1.286.0 is a starting point, not a claim this content shipped.

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-17

### Added

- `PainSignalSchema`, `validatePainSignal()`, `deriveSeverity()` -- Universal PainSignal schema and validation (SDK-CORE-03)
- `PainSignalAdapter<TRawEvent>` -- Framework-agnostic pain signal capture interface (SDK-ADP-02)
- `EvolutionHook` -- Callback interface for evolution lifecycle events (SDK-ADP-05)
- `TelemetryEvent` TypeBox schema -- In-process telemetry event schema (SDK-OBS-05)
- `StorageAdapter` -- Abstract storage adapter interface for principle persistence (SDK-CORE-02)
- `PrincipleInjector` -- Framework-agnostic principle injection interface (SDK-ADP-03)
- `DefaultPrincipleInjector` -- Minimal framework-agnostic implementation with budget-aware selection and P0 forced inclusion (SDK-ADP-03, SDK-ADP-04)
- `OpenClawPainAdapter` -- Reference coding domain adapter for OpenClaw tool failures (SDK-ADP-07)
- `WritingPainAdapter` -- Reference writing domain adapter for text quality issues (SDK-ADP-08)
- `CodeReviewPainAdapter` -- Reference code review domain adapter for diff complexity, comment sentiment, and process violations (SDK-ADP-09)
- `describePainAdapterConformance` -- Conformance test factory for PainSignalAdapter implementations (SDK-TEST-02)
- `describeInjectorConformance` -- Conformance test factory for PrincipleInjector implementations (SDK-TEST-02)
- Performance benchmarks with p99 targets (SDK-TEST-03)

### API Freeze Commitment

As of v0.1.0, the following interfaces are frozen (Semver protected):
- `PainSignal` schema (all 12 fields)
- `PainSignalAdapter<TRawEvent>.capture()` signature
- `PrincipleInjector.getRelevantPrinciples()` / `formatForInjection()` signatures
- `InjectionContext` interface
- `InjectablePrinciple` interface

Any additions will be made as non-breaking changes (new optional fields, new interfaces).

### Validation

- PainSignalSchema validated against 3 domains: coding, writing, code-review
- Gap analysis: ZERO unfillable fields across all domains
- E2E pipeline validated: ReviewEvent -> PainSignal -> DefaultPrincipleInjector

### Package

- Initial release as `@principles/core` v0.1.0
- Published from `packages/principles-core/`
- Supports tree-shaking via granular exports map
