# Changelog

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
