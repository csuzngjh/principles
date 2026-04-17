# Phase 01: SDK Core Implementation - Research

**Researched:** 2026-04-17
**Domain:** npm package creation, adapter implementations, conformance testing, performance benchmarking
**Confidence:** HIGH

## Summary

Phase 01 takes the interfaces defined in Phases 0a/0b and builds concrete, working implementations. The primary deliverable is a new `@principles/core` npm package inside `packages/principles-core/` that exports the Phase 0a/0b interfaces plus two reference adapter implementations (Coding + Creative Writing), a conformance test suite, and performance benchmarks. The existing `openclaw-plugin` package becomes a consumer of `@principles/core`, importing interfaces and types from the new package instead of defining them inline.

The architecture is straightforward: move 6 interface files from `openclaw-plugin/src/core/` into the new package, add two concrete adapter implementations under `packages/principles-core/src/adapters/`, create conformance test factories following the established `describeStorageConformance` pattern, and set up vitest bench for performance measurement. The key risk is package boundary design -- the new package must export clean interfaces without pulling in `openclaw-plugin` implementation details (HybridLedgerStore, better-sqlite3, file-lock utilities, etc.).

**Primary recommendation:** Create `packages/principles-core/` with its own tsconfig, vitest config, and package.json. The package exports interfaces, types, and adapter implementations only -- no storage backends, no SQLite, no file system operations in the core interfaces. Concrete adapters that need storage inject `StorageAdapter` as a dependency.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Creative Writing as second reference adapter domain. Pain points from text quality evaluation, style inconsistency, logical contradiction. Principles focused on style/structure/narrative rules. Contrasts with coding domain (no tool calls, pain from LLM output quality), suitable as extreme case baseline for Phase 1.5.
- **D-02:** Create new `packages/principles-core` package, move Phase 0a/0b interface files (pain-signal.ts, storage-adapter.ts, pain-signal-adapter.ts, evolution-hook.ts, principle-injector.ts, telemetry-event.ts) to this package. `openclaw-plugin` becomes consumer of `@principles/core`. Clean Semver boundary.
- **D-03:** Coding adapter and Writing adapter implementations under `packages/principles-core/src/adapters/`, each in its own subdirectory.
- **D-04:** Use vitest bench or benchmark.js for performance benchmarks in CI. Generate JSON report + markdown summary. Use synthetic data (known-size signal/principle sets). Repeatable, no external dependencies. p99 targets: < 50ms (pain capture), < 100ms (injection).
- **D-05:** Follow `storage-conformance.test.ts` `describeAdapterConformance` factory function pattern -- export `describePainAdapterConformance` and `describeInjectorConformance` functions, each adapter implementation calls it. Uniform format, extensible.

### Claude's Discretion
- New package's package.json configuration (exports, types, main fields)
- Coding adapter's specific OpenClaw event type mapping
- Writing adapter's pain point scoring algorithm details
- Benchmark's specific data scale and iteration counts
- Conformance suite's complete test case list

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SDK-CORE-03 | Implement universal PainSignal interface logic | Phase 0a PainSignal schema + validatePainSignal already implemented; move to new package and wire up in adapters |
| SDK-ADP-07 | Implement Coding domain adapter (reference implementation) | hooks/pain.ts extraction points identified; PainSignalAdapter<PluginHookAfterToolCallEvent> maps tool_failure events to PainSignal |
| SDK-ADP-08 | Implement a second domain adapter to validate universality | Creative Writing adapter (D-01); rawEvent is text analysis result, pain types: text_coherence_violation, style_inconsistency, narrative_arc_break, tone_mismatch |
| SDK-TEST-02 | Implement full Adapter conformance test suite (Pain/Injection) | Follow describeStorageConformance factory pattern (D-05); export describePainAdapterConformance + describeInjectorConformance |
| SDK-TEST-03 | Execute and publish performance benchmarks (p99 targets) | Vitest bench built on tinybench (VERIFIED: vitest docs); p99 < 50ms pain, < 100ms injection (D-04) |
| SDK-MGMT-01 | Package SDK as `@principles/core` npm package | New packages/principles-core/ in monorepo workspace (D-02); package.json with exports, types, main |
| SDK-MGMT-02 | Establish Semver versioning and migration guides | Start at 0.1.0; CHANGELOG.md; exports map supports tree-shaking (D-02 specifics) |

</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| PainSignal schema + validation | SDK Core Package | -- | Domain types are framework-agnostic; owned by @principles/core |
| Adapter interface contracts | SDK Core Package | -- | Generic interfaces live in the core package; framework-specific implementations extend them |
| Coding adapter (OpenClaw) | SDK Core Package | -- | Reference implementation demonstrating adapter pattern for a real framework |
| Writing adapter | SDK Core Package | -- | Reference implementation demonstrating adapter pattern for non-coding domain |
| Conformance test suite | SDK Core Package (tests) | -- | Test factories validate adapter contracts; each implementation calls the factory |
| Performance benchmarks | SDK Core Package (benchmarks) | -- | Vitest bench measures adapter throughput; synthetic data, no external deps |
| Package publication | npm registry (CI) | -- | `@principles/core` published as workspace package; openclaw-plugin consumes it |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @sinclair/typebox | ^0.34.48 (latest: 0.34.49) | Runtime type validation, schema definitions | Project-wide standard for PainSignal, TelemetryEvent schemas [VERIFIED: npm registry] |
| vitest | ^4.1.0 (latest: 4.1.4) | Test framework + benchmarking | Project standard; built-in bench mode uses tinybench for p99 measurement [VERIFIED: npm registry, Context7] |
| typescript | ^6.0.2 (latest: 6.0.3) | Type system | Project standard [VERIFIED: npm registry] |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| tinybench | (bundled with vitest) | Underlying benchmark engine | Vitest bench uses tinybench internally; no separate install needed [CITED: vitest Context7 docs] |
| esbuild | ^0.28.0 | Build/bundle for new package | Follow openclaw-plugin's esbuild.config.js pattern for distribution build |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| vitest bench | benchmark.js (2.1.4) | benchmark.js is more mature but requires separate dependency; vitest bench is built-in, consistent with existing test infrastructure, produces p99 out of the box. Per D-04, vitest bench is locked. |
| Separate @principles/adapters package | All in @principles/core | Separate packages allow independent versioning but add workspace complexity. Per D-02, single package is locked. |

**Installation:**
```bash
# No new packages needed -- all dependencies already in monorepo
# The new packages/principles-core/ reuses existing workspace dependencies
```

**Version verification:**
```
@sinclair/typebox: 0.34.49 (latest, verified 2026-04-17)
vitest: 4.1.4 (latest, verified 2026-04-17)
typescript: 6.0.3 (latest, verified 2026-04-17)
```

## Architecture Patterns

### System Architecture Diagram

```
                         packages/principles-core/
                         ┌─────────────────────────────────────────────────┐
                         │                                                 │
  Phase 0a/0b            │  src/                                           │
  Interface Files  ────> │  ├── pain-signal.ts        (PainSignal schema)  │
  (MOVE from              │  ├── storage-adapter.ts    (StorageAdapter)     │
   openclaw-plugin)       │  ├── pain-signal-adapter.ts (PainSignalAdapter) │
                         │  ├── evolution-hook.ts     (EvolutionHook)      │
                         │  ├── principle-injector.ts  (PrincipleInjector)  │
                         │  ├── telemetry-event.ts     (TelemetryEvent)     │
                         │  │                                              │
                         │  └── adapters/                                 │
                         │      ├── coding/                               │
                         │      │   └── openclaw-pain-adapter.ts           │
                         │      │       implements PainSignalAdapter<      │
                         │      │         PluginHookAfterToolCallEvent>     │
                         │      │                                              │
                         │      └── writing/                              │
                         │          └── writing-pain-adapter.ts            │
                         │              implements PainSignalAdapter<       │
                         │                TextAnalysisResult>              │
                         │                                                 │
                         └─────────────────────────────────────────────────┘
                                    │               │
                          exports   │               │  imports
                          interfaces│               │  types + adapters
                                    v               v
                         ┌──────────────┐    ┌──────────────────┐
                         │  Consumers   │    │  openclaw-plugin │
                         │  (future)    │    │  (existing, now  │
                         │              │    │   depends on core)│
                         └──────────────┘    └──────────────────┘

--- Performance Benchmark Flow ---
  Synthetic Data (factory functions)
       │
       v
  CodingPainAdapter.capture(syntheticToolEvent)
       │ measure p99
       v
  WritingPainAdapter.capture(syntheticTextAnalysis)
       │ measure p99
       v
  DefaultPrincipleInjector.getRelevantPrinciples(N principles, budget)
       │ measure p99
       v
  JSON report + markdown summary

--- Conformance Test Flow ---
  describePainAdapterConformance('CodingPainAdapter', factory)
       │ validates: null on non-failure, valid PainSignal on failure,
       │           null on malformed, correct field mapping
       v
  describeInjectorConformance('DefaultPrincipleInjector', factory)
       │ validates: respects budget, includes P0, returns formatted strings
       v
  Each adapter implementation calls both factories
```

### Recommended Project Structure
```
packages/principles-core/
├── package.json                    # @principles/core, exports map, types
├── tsconfig.json                   # ES2022, ESNext modules, strict
├── vitest.config.ts                # Unit + bench config
├── CHANGELOG.md                    # Semver history
├── src/
│   ├── index.ts                    # Public API barrel export
│   ├── pain-signal.ts              # (MOVE from openclaw-plugin) PainSignal schema
│   ├── storage-adapter.ts          # (MOVE) StorageAdapter interface
│   ├── pain-signal-adapter.ts      # (MOVE) PainSignalAdapter<TRawEvent>
│   ├── evolution-hook.ts           # (MOVE) EvolutionHook + event types
│   ├── principle-injector.ts       # (MOVE) PrincipleInjector + DefaultPrincipleInjector
│   ├── telemetry-event.ts          # (MOVE) TelemetryEvent schema
│   ├── types.ts                    # Shared types (InjectionContext, etc.)
│   └── adapters/
│       ├── coding/
│       │   ├── index.ts            # Barrel export
│       │   ├── openclaw-pain-adapter.ts    # PainSignalAdapter<PluginHookAfterToolCallEvent>
│       │   └── openclaw-event-types.ts     # Type shims for OpenClaw events (or re-export from .d.ts)
│       └── writing/
│           ├── index.ts            # Barrel export
│           ├── writing-pain-adapter.ts     # PainSignalAdapter<TextAnalysisResult>
│           └── writing-types.ts            # TextAnalysisResult, pain categories
├── tests/
│   ├── conformance/
│   │   ├── pain-adapter-conformance.ts     # describePainAdapterConformance factory
│   │   └── injector-conformance.ts         # describeInjectorConformance factory
│   ├── adapters/
│   │   ├── coding/
│   │   │   └── openclaw-pain-adapter.test.ts      # Calls conformance factories
│   │   └── writing/
│   │       └── writing-pain-adapter.test.ts        # Calls conformance factories
│   └── bench/
│       └── adapter-performance.bench.ts    # Vitest bench with p99 targets
└── dist/                           # Build output (gitignored)
```

### Pattern 1: Adapter Implementation with Generic Type Binding
**What:** Concrete class implementing `PainSignalAdapter<TRawEvent>` for a specific framework.
**When to use:** Every framework that needs to produce PainSignals.
**Example:**
```typescript
// Source: Pattern from Phase 0b PainSignalAdapter interface + hooks/pain.ts extraction
import type { PainSignalAdapter } from '../pain-signal-adapter.js';
import type { PainSignal } from '../pain-signal.js';
import { deriveSeverity } from '../pain-signal.js';

/** OpenClaw-specific event type for after_tool_call hook. */
export interface OpenClawToolCallEvent {
  toolName: string;
  error?: string;
  result?: unknown;
  params?: Record<string, unknown>;
  sessionId?: string;
  agentId?: string;
}

export class OpenClawPainAdapter implements PainSignalAdapter<OpenClawToolCallEvent> {
  capture(rawEvent: OpenClawToolCallEvent): PainSignal | null {
    // Per D-02: pure translation only. No GFI checks, no session logic.
    const isFailure = !!rawEvent.error;
    if (!isFailure) return null;

    const score = /* domain-specific scoring */;
    return {
      source: 'tool_failure',
      score,
      timestamp: new Date().toISOString(),
      reason: `Tool ${rawEvent.toolName} failed: ${rawEvent.error}`,
      sessionId: rawEvent.sessionId ?? 'unknown',
      agentId: rawEvent.agentId ?? '',
      traceId: '',  // caller provides traceId via context
      triggerTextPreview: '',
      domain: 'coding',
      severity: deriveSeverity(score),
      context: { toolName: rawEvent.toolName },
    };
  }
}
```

### Pattern 2: Conformance Test Factory
**What:** Exported function that takes an adapter factory and runs a standard test suite.
**When to use:** Validating that every adapter implementation satisfies the interface contract.
**Example:**
```typescript
// Source: Established by describeStorageConformance in storage-conformance.test.ts
import { describe, it, expect } from 'vitest';
import type { PainSignalAdapter } from '../../src/pain-signal-adapter.js';

export type PainAdapterFactory<T> = () => PainSignalAdapter<T>;

export function describePainAdapterConformance<T>(
  name: string,
  factory: PainAdapterFactory<T>,
  fixtures: { validEvent: T; nonFailureEvent: T; malformedEvent: T },
): void {
  describe(`Pain Adapter Conformance: ${name}`, () => {
    it('returns valid PainSignal for failure event', () => { ... });
    it('returns null for non-failure event', () => { ... });
    it('returns null for malformed event', () => { ... });
    it('output passes validatePainSignal()', () => { ... });
    it('maps domain field correctly', () => { ... });
    // ...
  });
}
```

### Pattern 3: Vitest Benchmark with p99 Assertion
**What:** Use vitest `bench` to measure performance and assert p99 targets.
**When to use:** Validating that adapter implementations meet latency targets.
**Example:**
```typescript
// Source: Context7 vitest docs -- bench API + TaskResult with p99 field
import { bench, describe } from 'vitest';
import { OpenClawPainAdapter } from '../src/adapters/coding/openclaw-pain-adapter.js';

const adapter = new OpenClawPainAdapter();
const syntheticFailure = { toolName: 'write', error: 'ENOENT', /* ... */ };

describe('Pain Capture Performance', () => {
  bench('coding adapter: single signal capture', () => {
    adapter.capture(syntheticFailure);
  }, { time: 1000, iterations: 100 });

  bench('coding adapter: null return for success', () => {
    adapter.capture(syntheticSuccess);
  }, { time: 1000, iterations: 100 });
});

// p99 assertion done in a separate test that reads bench results:
// bench output includes p99 field in TaskResult
```

### Anti-Patterns to Avoid
- **Importing openclaw-plugin internals into principles-core:** The new package must NOT depend on openclaw-plugin. Type shims for OpenClaw events go in `adapters/coding/openclaw-event-types.ts` (copy minimal type shapes), NOT importing from `openclaw-sdk.d.ts`.
- **Moving HybridLedgerStore into principles-core:** The StorageAdapter interface references `HybridLedgerStore` from principle-tree-ledger.ts. This type should either be duplicated (minimal shape) in principles-core, or StorageAdapter should be made generic. The new package must not import from openclaw-plugin.
- **Coupling adapters to StorageAdapter:** Adapters translate events, they don't persist. Storage injection is a separate concern. PainSignalAdapter.capture() returns a PainSignal; persistence is the caller's responsibility.
- **Making benchmarks flaky:** Benchmarks must use synthetic data with deterministic sizes. No file I/O, no network, no SQLite in benchmark hot paths.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Performance measurement | Custom timing loops | vitest bench (built-in) | Produces p50/p75/p99/p995/p999, handles warmup, statistical analysis. Per D-04. [CITED: vitest Context7 docs] |
| PainSignal validation in adapter | Custom validation logic | validatePainSignal() from pain-signal.ts | Phase 0a provides full validation with default hydration. Adapter outputs feed into it. |
| Principle selection in injector | New selection algorithm | selectPrinciplesForInjection() | Budget-aware, priority-sorted, P0 force-include. Complex, already tested (208 lines). |
| Adapter type binding | any-typed capture() | PainSignalAdapter<TRawEvent> generic | Compile-time type safety per Phase 0b D-01. Each framework provides its own type parameter. |
| Benchmark JSON output | Custom JSON serialization | vitest bench `outputJson` config | Built-in: `benchmark.outputJson: "bench-results.json"` produces structured output. [CITED: vitest Context7 docs] |

**Key insight:** This phase is assembly + new implementations, not ground-up creation. The interfaces exist, the conformance pattern exists, the benchmark tooling exists. The work is: create the package shell, move files, implement two adapters, wire up tests.

## Common Pitfalls

### Pitfall 1: Circular Dependency Between Packages
**What goes wrong:** `principles-core` imports from `openclaw-plugin` (for types like HybridLedgerStore, InjectablePrinciple), while `openclaw-plugin` imports from `principles-core` (for interfaces).
**Why it happens:** Moving interface files requires resolving their existing imports. `StorageAdapter` references `HybridLedgerStore` from `principle-tree-ledger.ts`; `PrincipleInjector` references `InjectablePrinciple` from `principle-injection.ts`.
**How to avoid:** Duplicate minimal type shapes in `principles-core/src/types.ts`. The new package defines its own `InjectablePrinciple` (7 lines), its own `HybridLedgerStore` (3-line interface), and does NOT import from `openclaw-plugin`. The `openclaw-plugin` package will later update its imports to use `@principles/core` types.
**Warning signs:** `packages/principles-core/package.json` has `"openclaw-plugin"` in dependencies.

### Pitfall 2: Moving Too Much into the New Package
**What goes wrong:** Principles-core becomes a "kitchen sink" that includes storage backends, SQLite, file locks, and utility functions from openclaw-plugin.
**Why it happens:** It's tempting to move everything "core" into the core package.
**How to avoid:** The new package contains ONLY interfaces, type definitions, schemas, and adapter implementations. No `FileStorageAdapter`, no `better-sqlite3`, no `file-lock.ts`, no `SystemLogger`, no `WorkspaceContext`. These stay in openclaw-plugin.
**Warning signs:** `principles-core` has `better-sqlite3` or `fs` imports in src/ (except in tests).

### Pitfall 3: Writing Adapter Too Coupled to LLM Output
**What goes wrong:** Writing adapter requires a running LLM to evaluate text quality, making tests non-deterministic and benchmarks unreliable.
**Why it happens:** Creative writing pain points come from text quality assessment, which typically involves LLM evaluation.
**How to avoid:** The Writing adapter's `capture()` receives a pre-evaluated `TextAnalysisResult` (structured data with scores). The adapter translates this to PainSignal. LLM-based evaluation happens upstream, outside the adapter. This keeps the adapter pure and testable with synthetic data.
**Warning signs:** Writing adapter importing an LLM SDK or making HTTP calls.

### Pitfall 4: Benchmark Results Not Reproducible
**What goes wrong:** Benchmarks show different p99 on different runs due to GC pauses, OS scheduling, or varying data sizes.
**Why it happens:** Benchmarks without proper warmup or with variable input sizes produce inconsistent results.
**How to avoid:** Use vitest bench's built-in warmup (`warmupTime: 100ms`, `warmupIterations: 5`). Use fixed-size synthetic data. Document test conditions. Target generous p99 thresholds (50ms for pain, 100ms for injection are very achievable for pure computation). Run benchmarks in isolation (not alongside other tests).
**Warning signs:** Benchmarks importing real data files or using random data sizes.

### Pitfall 5: Conformance Tests Too Weak
**What goes wrong:** Conformance suite only checks "happy path" -- valid input produces valid output. Missing edge cases like null returns, empty strings, boundary scores.
**Why it happens:** Following a simplified version of the StorageAdapter conformance pattern without covering all the cases that suite tests.
**How to avoid:** Model after `describeStorageConformance` which tests: happy path, concurrent access, persistence, error handling (corrupted data, empty files, null content, read-only dirs, error propagation). For PainAdapter conformance: valid capture, null on non-failure, null on malformed, output validation, domain mapping, severity derivation, context preservation.
**Warning signs:** Conformance suite has fewer than 8 test cases per factory.

## Code Examples

### Package.json for @principles/core
```typescript
// Source: [ASSUMED] Based on existing monorepo patterns (package.json, create-principles-disciple)
{
  "name": "@principles/core",
  "version": "0.1.0",
  "description": "Universal Evolution SDK - framework-agnostic pain signal capture and principle injection",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./adapters/coding": {
      "types": "./dist/adapters/coding/index.d.ts",
      "import": "./dist/adapters/coding/index.js"
    },
    "./adapters/writing": {
      "types": "./dist/adapters/writing/index.d.ts",
      "import": "./dist/adapters/writing/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:bench": "vitest bench",
    "lint": "eslint src/"
  },
  "peerDependencies": {},
  "dependencies": {
    "@sinclair/typebox": "^0.34.48"
  },
  "devDependencies": {
    "@types/node": "^25.6.0",
    "typescript": "^6.0.2",
    "vitest": "^4.1.0"
  },
  "license": "MIT"
}
```

### Writing Adapter Implementation Pattern
```typescript
// Source: [ASSUMED] Based on PainSignalAdapter interface + D-01 Creative Writing domain
import type { PainSignalAdapter } from '../pain-signal-adapter.js';
import type { PainSignal } from '../pain-signal.js';
import { deriveSeverity } from '../pain-signal.js';

/** Structured text analysis result from upstream quality evaluator. */
export interface TextAnalysisResult {
  /** Type of quality issue detected */
  issueType: 'text_coherence_violation' | 'style_inconsistency' | 'narrative_arc_break' | 'tone_mismatch';
  /** Quality score 0-100 (higher = more severe issue) */
  severityScore: number;
  /** Description of the quality issue */
  description: string;
  /** Text snippet that triggered the issue */
  excerpt: string;
  /** Session ID from the conversation */
  sessionId: string;
  /** Optional trace ID for correlation */
  traceId?: string;
}

export class WritingPainAdapter implements PainSignalAdapter<TextAnalysisResult> {
  capture(rawEvent: TextAnalysisResult): PainSignal | null {
    // Per D-02: pure translation. No quality threshold checks.
    if (!rawEvent.issueType || rawEvent.severityScore === undefined) {
      return null; // Malformed -- resilient return
    }

    return {
      source: rawEvent.issueType,
      score: rawEvent.severityScore,
      timestamp: new Date().toISOString(),
      reason: rawEvent.description,
      sessionId: rawEvent.sessionId,
      agentId: 'writing-evaluator',
      traceId: rawEvent.traceId ?? '',
      triggerTextPreview: rawEvent.excerpt.slice(0, 200),
      domain: 'writing',
      severity: deriveSeverity(rawEvent.severityScore),
      context: { issueType: rawEvent.issueType },
    };
  }
}
```

### Vitest Benchmark Configuration
```typescript
// Source: [CITED: vitest Context7 docs] bench config options
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Benchmark configuration
    benchmark: {
      include: ['tests/bench/**/*.bench.ts'],
      outputJson: 'bench-results.json',
    },
  },
});
```

### Benchmark Test with p99 Assertion
```typescript
// Source: [CITED: vitest Context7 docs] bench API + TaskResult
import { bench, describe, expect, test } from 'vitest';
import { OpenClawPainAdapter } from '../../src/adapters/coding/openclaw-pain-adapter.js';

const adapter = new OpenClawPainAdapter();
// Synthetic fixture -- deterministic, no I/O
const failureEvent = { toolName: 'write', error: 'ENOENT: no such file', params: { file_path: '/test.ts' } };

describe('Pain Capture p99 < 50ms', () => {
  bench('coding adapter: single capture', () => {
    adapter.capture(failureEvent);
  }, { time: 500, iterations: 50 });
});

// p99 validation via post-bench assertion (vitest outputs p99 in TaskResult)
test('coding adapter meets p99 < 50ms target', () => {
  // Run a measured loop to verify
  const samples: number[] = [];
  for (let i = 0; i < 1000; i++) {
    const start = performance.now();
    adapter.capture(failureEvent);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const p99 = samples[Math.floor(samples.length * 0.99)];
  expect(p99).toBeLessThan(50); // p99 < 50ms target
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Interfaces in openclaw-plugin/src/core/ | Dedicated @principles/core package | Phase 01 (this phase) | Clean Semver boundary; openclaw-plugin becomes a consumer |
| No reference adapter implementations | Coding + Writing reference adapters | Phase 01 (this phase) | Proves universality of the adapter pattern across domains |
| No performance measurement | Vitest bench with p99 targets | Phase 01 (this phase) | Quantitative evidence of SDK performance characteristics |
| Per-adapter ad-hoc tests | Conformance test factory pattern | Phase 01 (this phase) | Uniform validation for all adapter implementations |

**Deprecated/outdated:**
- Direct import of interfaces from `openclaw-plugin/src/core/`: After Phase 01, consumers import from `@principles/core`.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | HybridLedgerStore type can be duplicated in principles-core without creating maintenance burden | Architecture Patterns | If the type changes frequently, both copies need updating. Mitigate by keeping StorageAdapter generic or defining the canonical type in principles-core. |
| A2 | InjectablePrinciple type can be duplicated in principles-core | Architecture Patterns | Same risk as A1. Small interface (7 lines), low change frequency. |
| A3 | Vitest bench is stable enough for CI use despite "experimental" label | Standard Stack | vitest docs say "Benchmarking is experimental and does not follow SemVer" but it's been available since vitest 0.34 and is widely used. [CITED: vitest Context7 docs] |
| A4 | OpenClaw event type shapes can be duplicated as type shims in principles-core/adapters/coding/ | Architecture Patterns | If OpenClaw SDK changes event shapes, shims need manual update. This is acceptable for a reference adapter. |
| A5 | Creative Writing adapter receives pre-evaluated TextAnalysisResult, not raw LLM output | Architecture Patterns | If assumption is wrong, adapter needs LLM integration and becomes non-deterministic. CONTEXT.md D-01 confirms "痛点来自 LLM 自身输出质量" which means the adapter should receive structured quality assessments. |
| A6 | openclaw-plugin will be updated to import from @principles/core in a later task within this phase | Architecture Patterns | Interface files move to principles-core; openclaw-plugin must update imports. If deferred too long, both packages define the same types. |

## Open Questions

1. **StorageAdapter generic parameter**
   - What we know: StorageAdapter currently references `HybridLedgerStore` from principle-tree-ledger.ts. Moving to principles-core requires either duplicating this type or making StorageAdapter generic.
   - What's unclear: Whether to make StorageAdapter generic (`StorageAdapter<TStore>`) or duplicate the minimal type shape.
   - Recommendation: Duplicate the minimal `HybridLedgerStore` interface (3 fields: trainingStore, tree, lastUpdated) in `principles-core/src/types.ts`. This keeps the interface simple and avoids parameterizing the entire storage contract.

2. **When to update openclaw-plugin imports**
   - What we know: After moving interface files to principles-core, openclaw-plugin has broken imports that need updating.
   - What's unclear: Whether this happens in the same task as the file move, or as a separate task.
   - Recommendation: Same task as the file move. The move + import update is atomic -- doing them separately leaves the repo in a broken state between tasks.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Build + test | Yes | v20+ (inferred from esbuild target) | -- |
| npm workspaces | Monorepo resolution | Yes | 10.x (inferred) | -- |
| TypeScript | Compilation | Yes | 6.0.2 | -- |
| vitest | Tests + benchmarks | Yes | 4.1.0 | -- |
| esbuild | Bundle build | Yes | 0.28.0 | -- |
| @sinclair/typebox | Runtime validation | Yes | 0.34.48 | -- |

**Missing dependencies with no fallback:**
None -- all dependencies are available.

**Missing dependencies with fallback:**
None.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.0 |
| Config file | `packages/principles-core/vitest.config.ts` (Wave 0 -- new) |
| Quick run command | `npx vitest run packages/principles-core/tests/adapters/ -x` |
| Full suite command | `npx vitest run packages/principles-core/tests/ -x` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SDK-CORE-03 | PainSignal interface logic (validatePainSignal, deriveSeverity) works in new package | unit | `npx vitest run packages/principles-core/tests/pain-signal.test.ts -x` | Wave 0 (moved with file) |
| SDK-ADP-07 | Coding adapter captures tool failures, returns null on success | unit + conformance | `npx vitest run packages/principles-core/tests/adapters/coding/ -x` | Wave 0 |
| SDK-ADP-08 | Writing adapter captures text quality issues, returns null on clean text | unit + conformance | `npx vitest run packages/principles-core/tests/adapters/writing/ -x` | Wave 0 |
| SDK-TEST-02 | Conformance factories validate both adapters | conformance | `npx vitest run packages/principles-core/tests/conformance/ -x` | Wave 0 |
| SDK-TEST-03 | Benchmarks run and p99 < 50ms (pain), < 100ms (injection) | benchmark | `npx vitest bench packages/principles-core/tests/bench/` | Wave 0 |
| SDK-MGMT-01 | Package resolves as @principles/core with valid exports | smoke | `node -e "import('@principles/core').then(m => console.log(Object.keys(m)))"` | Wave 0 |
| SDK-MGMT-02 | Package version is valid Semver, CHANGELOG exists | manual | `cat packages/principles-core/package.json \| jq .version` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run packages/principles-core/tests/ -x`
- **Per wave merge:** `npx vitest run packages/principles-core/tests/ -x` + `npx vitest run packages/openclaw-plugin/tests/core/ -x`
- **Phase gate:** `npx vitest run -x` (full monorepo suite)

### Wave 0 Gaps
- [ ] `packages/principles-core/vitest.config.ts` -- test + bench configuration
- [ ] `packages/principles-core/tsconfig.json` -- TypeScript config
- [ ] `packages/principles-core/package.json` -- package definition with exports map
- [ ] `packages/principles-core/src/index.ts` -- barrel export
- [ ] `packages/principles-core/src/types.ts` -- duplicated type shapes (InjectablePrinciple, HybridLedgerStore)
- [ ] `packages/principles-core/tests/adapters/coding/openclaw-pain-adapter.test.ts` -- SDK-ADP-07
- [ ] `packages/principles-core/tests/adapters/writing/writing-pain-adapter.test.ts` -- SDK-ADP-08
- [ ] `packages/principles-core/tests/conformance/pain-adapter-conformance.ts` -- SDK-TEST-02
- [ ] `packages/principles-core/tests/conformance/injector-conformance.ts` -- SDK-TEST-02
- [ ] `packages/principles-core/tests/bench/adapter-performance.bench.ts` -- SDK-TEST-03

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | N/A -- package interfaces only, no auth flows |
| V3 Session Management | no | N/A -- no session creation or management |
| V4 Access Control | no | N/A -- no privileged operations |
| V5 Input Validation | yes | validatePainSignal() + validateTelemetryEvent() from Phase 0a/0b |
| V6 Cryptography | no | N/A -- no crypto operations |

### Known Threat Patterns for SDK Core Package

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Malformed event injection through adapter | Tampering | Adapter capture() returns null for malformed events; validatePainSignal() validates output |
| Supply chain confusion via @principles/core namespace | Spoofing | Package scoped under @principles/ org; npm publishing restricted |

## Project Constraints (from CLAUDE.md)

- **Max cyclomatic complexity: 10** -- Adapter implementations should be simple translation layers. If any adapter exceeds complexity 10, the event mapping is too complex and should be decomposed.
- **No `any` type usage** (warn) -- PainSignalAdapter<TRawEvent> uses generics. OpenClaw event type shims must be properly typed, not `any`.
- **Unused variables prefixed with `_`** -- Standard TypeScript convention.
- **Conventional Commits:** `feat(core): add OpenClaw pain adapter`, `feat(core): create @principles/core package` format.
- **TypeBox for runtime validation** -- PainSignal and TelemetryEvent schemas use TypeBox, not Zod or custom.
- **Test framework: Vitest** -- All tests and benchmarks use vitest.
- **Monorepo with npm workspaces** -- New package goes in `packages/principles-core/`, referenced in root `package.json` workspaces (already covered by `packages/*` glob).

## Sources

### Primary (HIGH confidence)
- Codebase: `packages/openclaw-plugin/src/core/pain-signal.ts` -- PainSignal schema (verified 136 lines)
- Codebase: `packages/openclaw-plugin/src/core/pain-signal-adapter.ts` -- PainSignalAdapter interface (verified 42 lines)
- Codebase: `packages/openclaw-plugin/src/core/evolution-hook.ts` -- EvolutionHook interface (verified 74 lines)
- Codebase: `packages/openclaw-plugin/src/core/principle-injector.ts` -- PrincipleInjector + DefaultPrincipleInjector (verified 84 lines)
- Codebase: `packages/openclaw-plugin/src/core/telemetry-event.ts` -- TelemetryEvent schema (verified 109 lines)
- Codebase: `packages/openclaw-plugin/src/core/storage-adapter.ts` -- StorageAdapter interface (verified 65 lines)
- Codebase: `packages/openclaw-plugin/src/core/file-storage-adapter.ts` -- Concrete adapter precedent (verified 203 lines)
- Codebase: `packages/openclaw-plugin/tests/core/storage-conformance.test.ts` -- Conformance factory pattern (verified 435 lines)
- Codebase: `packages/openclaw-plugin/src/hooks/pain.ts` -- OpenClaw pain capture extraction source (verified 416 lines)
- Codebase: `packages/openclaw-plugin/src/hooks/prompt.ts` -- Injection integration point (verified 1184 lines)
- Codebase: `packages/openclaw-plugin/src/core/principle-injection.ts` -- Selection algorithm (verified 208 lines)
- Codebase: `.planning/phases/00b-adapter-abstraction/00b-VERIFICATION.md` -- Phase 0b verification (passed 9/9)
- Context7: `/vitest-dev/vitest` -- benchmark API, bench config, TaskResult p99 field
- npm registry: @sinclair/typebox 0.34.49, vitest 4.1.4, typescript 6.0.3 (verified 2026-04-17)

### Secondary (MEDIUM confidence)
- CONTEXT.md decisions D-01 through D-05 -- user-locked design constraints
- Phase 0b RESEARCH.md -- adapter pattern design decisions and pitfalls
- Root package.json -- workspace configuration and scripts

### Tertiary (LOW confidence)
None -- all findings verified against codebase, npm registry, or Context7 docs.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new packages needed; vitest bench capabilities verified via Context7
- Architecture: HIGH - package structure follows existing monorepo patterns; adapter implementations follow established PainSignalAdapter pattern from Phase 0b
- Pitfalls: HIGH - circular dependency and type duplication risks identified from reading actual codebase dependencies

**Research date:** 2026-04-17
**Valid until:** 2026-05-17 (stable -- package creation and adapter implementations, no fast-moving external dependencies)
