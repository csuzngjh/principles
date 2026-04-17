/**
 * Adapter Performance Benchmarks
 *
 * Measures p99 latency for:
 * - OpenClawPainAdapter.capture() (failure event)
 * - OpenClawPainAdapter.capture() (null return for success)
 * - WritingPainAdapter.capture() (failure event)
 * - WritingPainAdapter.capture() (null return)
 * - DefaultPrincipleInjector.getRelevantPrinciples() with various budget sizes
 * - DefaultPrincipleInjector.formatForInjection()
 *
 * Targets:
 * - Pain capture p99 < 50ms
 * - Injection p99 < 100ms
 *
 * Per D-04: synthetic data, no external dependencies, deterministic.
 * Includes warmup iterations for steady-state measurements (avoids cold-start bias).
 */
import { bench, describe, expect, test } from 'vitest';
import { OpenClawPainAdapter } from '../../src/adapters/coding/openclaw-pain-adapter.js';
import { WritingPainAdapter } from '../../src/adapters/writing/writing-pain-adapter.js';
import { DefaultPrincipleInjector } from '../../src/principle-injector.js';
import type { PluginHookAfterToolCallEvent } from '../../src/adapters/coding/openclaw-event-types.js';
import type { TextAnalysisResult } from '../../src/adapters/writing/writing-types.js';
import type { InjectablePrinciple, InjectionContext } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------

const codingFailureEvent: PluginHookAfterToolCallEvent = {
  toolName: 'write',
  error: 'ENOENT: no such file or directory',
  params: { file_path: '/tmp/test.ts', content: 'const x = 1;' },
  sessionId: 'bench-sess-1',
  agentId: 'builder',
};

const codingSuccessEvent: PluginHookAfterToolCallEvent = {
  toolName: 'read',
  result: { content: 'file contents here' },
  sessionId: 'bench-sess-1',
  agentId: 'main',
};

const writingFailureEvent: TextAnalysisResult = {
  issueType: 'style_inconsistency',
  severityScore: 72,
  description: 'Passive voice overuse in paragraph 3',
  excerpt: 'The door was opened by her repeatedly throughout the scene.',
  sessionId: 'bench-sess-2',
  traceId: 'bench-trace-1',
};

// ---------------------------------------------------------------------------
// Principle injector test fixtures
// ---------------------------------------------------------------------------

function createTestPrinciples(count: number): InjectablePrinciple[] {
  const principles: InjectablePrinciple[] = [];
  for (let i = 0; i < count; i++) {
    const priority = i % 5 === 0 ? 'P0' : i % 3 === 0 ? 'P1' : 'P2';
    principles.push({
      id: `${priority}-${i}`,
      text: `Principle ${i}: This is a test principle text for injection benchmark purposes.`,
      priority: priority as 'P0' | 'P1' | 'P2',
      createdAt: new Date(2026, 0, 1, i, 0, 0).toISOString(),
    });
  }
  return principles;
}

const testPrinciples10 = createTestPrinciples(10);
const testPrinciples50 = createTestPrinciples(50);
const testPrinciples200 = createTestPrinciples(200);

const injectionContext: InjectionContext = {
  domain: 'coding',
  sessionId: 'bench-sess',
  budgetChars: 500,
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const codingAdapter = new OpenClawPainAdapter();
const writingAdapter = new WritingPainAdapter();
const injector = new DefaultPrincipleInjector();

// Warmup helper - runs function N times to reach steady state
function warmup(fn: () => void, iterations: number): void {
  for (let i = 0; i < iterations; i++) {
    fn();
  }
}

// ---------------------------------------------------------------------------
// Warmup Phase (runs before benchmarks to establish steady state)
// ---------------------------------------------------------------------------

describe('Warmup (establishes steady state for accurate p99)', () => {
  test('warmup: coding adapter', () => {
    warmup(() => codingAdapter.capture(codingFailureEvent), 10);
    expect(true).toBe(true); // Warmup doesn't assert, just runs
  });

  test('warmup: writing adapter', () => {
    warmup(() => writingAdapter.capture(writingFailureEvent), 10);
    expect(true).toBe(true);
  });

  test('warmup: injector', () => {
    warmup(() => injector.getRelevantPrinciples(testPrinciples50, injectionContext), 10);
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pain Capture Benchmarks
// ---------------------------------------------------------------------------

describe('Pain Capture Performance (p99 target < 50ms)', () => {

  bench('OpenClawPainAdapter: capture failure event', () => {
    codingAdapter.capture(codingFailureEvent);
  }, { time: 1000, iterations: 100, warmupIterations: 5 });

  bench('OpenClawPainAdapter: capture success event (null return)', () => {
    codingAdapter.capture(codingSuccessEvent);
  }, { time: 1000, iterations: 100, warmupIterations: 5 });

  bench('WritingPainAdapter: capture failure event', () => {
    writingAdapter.capture(writingFailureEvent);
  }, { time: 1000, iterations: 100, warmupIterations: 5 });
});

// ---------------------------------------------------------------------------
// Injection Benchmarks (using DefaultPrincipleInjector)
// ---------------------------------------------------------------------------

describe('Injection Performance (p99 target < 100ms)', () => {

  bench('DefaultPrincipleInjector: getRelevantPrinciples (10 principles, 500 chars)', () => {
    injector.getRelevantPrinciples(testPrinciples10, injectionContext);
  }, { time: 1000, iterations: 100, warmupIterations: 5 });

  bench('DefaultPrincipleInjector: getRelevantPrinciples (50 principles, 500 chars)', () => {
    injector.getRelevantPrinciples(testPrinciples50, injectionContext);
  }, { time: 1000, iterations: 100, warmupIterations: 5 });

  bench('DefaultPrincipleInjector: getRelevantPrinciples (200 principles, 500 chars)', () => {
    injector.getRelevantPrinciples(testPrinciples200, injectionContext);
  }, { time: 1000, iterations: 100, warmupIterations: 5 });

  bench('DefaultPrincipleInjector: formatForInjection (single principle)', () => {
    injector.formatForInjection(testPrinciples10[0]);
  }, { time: 1000, iterations: 100, warmupIterations: 5 });
});

// ---------------------------------------------------------------------------
// p99 Target Assertions (manual computation for explicit verification)
// ---------------------------------------------------------------------------

/**
 * Manually compute p99 from samples to assert against targets.
 * Vitest bench reports p99 in TaskResult but we also assert here explicitly.
 */
function computeP99(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.99);
  return sorted[idx];
}

test('OpenClawPainAdapter p99 < 50ms for failure capture', () => {
  // Warmup first
  warmup(() => codingAdapter.capture(codingFailureEvent), 10);

  const samples: number[] = [];
  for (let i = 0; i < 1000; i++) {
    const start = performance.now();
    codingAdapter.capture(codingFailureEvent);
    samples.push(performance.now() - start);
  }
  const p99 = computeP99(samples);
  expect(p99).toBeLessThan(50);
});

test('WritingPainAdapter p99 < 50ms for failure capture', () => {
  // Warmup first
  warmup(() => writingAdapter.capture(writingFailureEvent), 10);

  const samples: number[] = [];
  for (let i = 0; i < 1000; i++) {
    const start = performance.now();
    writingAdapter.capture(writingFailureEvent);
    samples.push(performance.now() - start);
  }
  const p99 = computeP99(samples);
  expect(p99).toBeLessThan(50);
});

test('DefaultPrincipleInjector getRelevantPrinciples p99 < 100ms (50 principles)', () => {
  // Warmup first
  warmup(() => injector.getRelevantPrinciples(testPrinciples50, injectionContext), 10);

  const samples: number[] = [];
  for (let i = 0; i < 1000; i++) {
    const start = performance.now();
    injector.getRelevantPrinciples(testPrinciples50, injectionContext);
    samples.push(performance.now() - start);
  }
  const p99 = computeP99(samples);
  expect(p99).toBeLessThan(100);
});

test('DefaultPrincipleInjector formatForInjection p99 < 1ms', () => {
  // Warmup first
  warmup(() => injector.formatForInjection(testPrinciples10[0]), 10);

  const samples: number[] = [];
  for (let i = 0; i < 1000; i++) {
    const start = performance.now();
    injector.formatForInjection(testPrinciples10[i % testPrinciples10.length]);
    samples.push(performance.now() - start);
  }
  const p99 = computeP99(samples);
  expect(p99).toBeLessThan(1);
});
