/**
 * PRI-1150 Path A measurement (design v2 §9, owner round: "新增性能与事件
 * 大小结论必须实测"). Deterministic fixtures; numbers are machine-dependent
 * — recorded in the PR for the machine that produced them.
 */
import { performance } from 'node:perf_hooks';
import { PromptPresenceRegistry } from '../../src/hooks/prompt-presence-registry.js';
import { checkAssemblyPresence } from '../../src/hooks/prompt-presence-lite.js';

const BODY =
  '产出闭环验证：交付前必须以可观察证据校验产物新鲜度与正确性（PRI-1150 实测占位正文，含 PAD 填充以贴近真实 ~2.2KiB 体积）。' +
  'p'.repeat(1800);

function bench(label: string, runs: number, fn: () => void): void {
  for (let i = 0; i < 3; i++) fn(); // warm-up excluded
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    fn();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)] ?? 0;
  const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))] ?? 0;
  console.log(`${label}: runs=${runs} median=${median.toFixed(3)}ms p95=${p95.toFixed(3)}ms`);
}

function sizeOf(label: string, value: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  console.log(`${label}: eventUtf8Bytes=${bytes}`);
}

console.log('PRI-1150 Path A measurement (this machine)');

// 1. Registry registration + binding (representative 18-entry snapshot).
{
  const registry = new PromptPresenceRegistry();
  const expectations = Array.from({ length: 18 }, (_, i) => ({
    activationId: `act_prompt_${i}`,
    bodyText: `${BODY} #${i}`,
    bodyChars: BODY.length + 4,
    bodyComplete: true,
  }));
  bench('registerAssemblySnapshot 18×~2.2KiB', 30, () => {
    registry.resetForTest();
    registry.registerAssemblySnapshot({ runId: 'bench', sessionId: 's', expectations });
  });
  bench('resolveBinding unique', 30, () => {
    registry.resolveBinding({ runId: 'bench', sessionId: 's' });
  });
}

// 2. Lite checker containment (18 bodies inside a ~58k system prompt).
{
  const expectations = Array.from({ length: 18 }, (_, i) => ({
    activationId: `act_prompt_${i}`,
    bodyText: `${BODY} #${i}`,
    bodyChars: BODY.length + 4,
    bodyComplete: true,
  }));
  const filler = 'g'.repeat(Math.max(0, 58_000 - 18 * (BODY.length + 4)));
  const observed = [filler, ...expectations.map((e) => e.bodyText)].join('\n');
  bench('checkAssemblyPresence 18 bodies × 58k observation', 30, () => {
    checkAssemblyPresence({ observedText: observed, expectations });
  });
  const check = checkAssemblyPresence({ observedText: observed, expectations });
  sizeOf('lite check 18 full_hit', check);
}

// 3. Boundary: 64 expectations × 64KiB bodies (under-limit worst case).
{
  const big = 'x'.repeat(64 * 1024 - 4);
  const expectations = Array.from({ length: 64 }, (_, i) => ({
    activationId: `act_b_${i}`,
    bodyText: big + String(i).padStart(3, '0'),
    bodyChars: big.length + 3,
    bodyComplete: true,
  }));
  const observed = expectations.map((e) => e.bodyText).join('\n');
  bench('checkAssemblyPresence 64×64KiB boundary', 10, () => {
    checkAssemblyPresence({ observedText: observed, expectations });
  });
  const check = checkAssemblyPresence({ observedText: observed, expectations });
  sizeOf('lite check 64 boundary', check);
}

// 4. Ambiguous-binding event (no checking, verdict only).
{
  const registry = new PromptPresenceRegistry();
  registry.registerAssemblySnapshot({ runId: 'r-a', sessionId: 's-a', expectations: [{ activationId: 'a', bodyText: BODY, bodyChars: BODY.length, bodyComplete: true }] });
  registry.registerAssemblySnapshot({ runId: 'r-a', sessionId: 's-a', expectations: [{ activationId: 'b', bodyText: BODY, bodyChars: BODY.length, bodyComplete: true }] });
  bench('resolveBinding ambiguous (2 candidates)', 30, () => {
    registry.resolveBinding({ runId: 'r-a', sessionId: 's-a' });
  });
  const verdict = registry.resolveBinding({ runId: 'r-a', sessionId: 's-a' });
  const ambiguousEvent = {
    runId: 'r-a', sessionId: 's-a', boundary: 'post_assembly_system_prompt_via_llm_input',
    binding: 'ambiguous', liveSnapshots: verdict.status === 'ambiguous' ? verdict.liveSnapshots : 0,
    assemblySeqCandidates: [], checked: false, reason: 'ambiguous_binding',
  };
  sizeOf('ambiguous-binding event', ambiguousEvent);
}
