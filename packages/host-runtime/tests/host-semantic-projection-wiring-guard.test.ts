/**
 * PRI-741 wiring guard — the host semantic projection must reach generation
 * and replay at the canonical construction sites.
 *
 * Mirrors the PRI-634 A1 guard style (source characterization): assembling
 * the full consumer cycle needs a complete service environment, so the
 * guarded invariant is the WIRING itself in source. If someone removes the
 * artificer/evaluator host-context threading, these assertions go red —
 * preventing the generation-blindness (phantom tool names, canonicalKind
 * blindness) from silently regressing.
 *
 * Guarded invariants:
 *  A. shared cycle builds the projection from ports.toolSemantics and threads
 *     it into BOTH the artificer (prompt) and the evaluator (replay variant);
 *  B. host-neutral CLI entries resolve the durable workspace declaration for
 *     the artificer with observable degradation (rc-9/EP-03);
 *  C. both host shells pass their hostKinds label (openclaw / codex);
 *  D. the pipeline threads the projection into the artificer and evaluator.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const CYCLE_SRC = fileURLToPath(new URL('../src/internalization-consumer-cycle.ts', import.meta.url));
// PRI-1301: 共享单步执行器独立成模块 — Runner 构造/透传断言读执行器模块,
// consumer dispatch 输入装配断言仍读 cycle (两文件各自只剩一处同名 case,
// occurrence 0 即唯一分支, 不再有同文件双分支歧义)。
const EXECUTOR_SRC = fileURLToPath(new URL('../src/internalization-task-executor.ts', import.meta.url));
const RUN_ONCE_SRC = fileURLToPath(new URL('../../pd-cli/src/commands/runtime-internalization-run-once.ts', import.meta.url));
const PIPELINE_RUNNER_SRC = fileURLToPath(new URL('../../pd-cli/src/services/rulehost-pipeline-runner.ts', import.meta.url));
const OPENCLAW_SERVICE_SRC = fileURLToPath(new URL('../../openclaw-plugin/src/service/internalization-auto-consumer-service.ts', import.meta.url));
const CODEX_WORKER_SRC = fileURLToPath(new URL('../../codex-adapter/src/worker/workspace-worker.ts', import.meta.url));

function readSrc(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

function caseSlice(source: string, caseName: string): string {
  return caseSliceAt(source, caseName, 0);
}

/**
 * Slice the Nth (0-based) occurrence of a case label. CodeRabbit review:
 * full-file assertions are vacuous when two branches in scope carry the
 * same line; each guard must pin the exact branch it owns. PRI-1301: the
 * executor branch and the dispatch branch now live in DIFFERENT files
 * (executor module vs consumer cycle), so each file has exactly one
 * occurrence — the slicing discipline is kept so a future re-merge or
 * duplication fails loudly instead of silently re-aliasing.
 */
function caseSliceAt(source: string, caseName: string, occurrence: number): string {
  let idx = -1;
  let from = 0;
  for (let i = 0; i <= occurrence; i++) {
    idx = source.indexOf(caseName, from);
    if (idx < 0) return '';
    from = idx + caseName.length;
  }
  const end = source.indexOf("case '", from);
  if (end < 0) return source.slice(idx);
  return source.slice(idx, end);
}

describe('PRI-741 host semantic projection wiring guard', () => {
  it('Guard A1: shared cycle builds the projection from ports.toolSemantics (one provenance)', () => {
    const src = readSrc(CYCLE_SRC);
    expect(src).toContain('buildArtificerHostSemanticContext(toolSemantics, ports.hostKinds ?? [])');
  });

  it('Guard A2: shared cycle threads hostSemanticContext into the artificer prompt', () => {
    // PRI-1301: Runner 构造在独立 executor 模块 — 执行器把
    // input.hostSemanticContext 透传进 ArtificerRunner options; consumer 的
    // artificer 装配输入 (cycle dispatch switch) 单独断言 — 跨文件断言
    // 不可互替, 两处分别捕获透传/装配回归。
    const executorSlice = caseSliceAt(readSrc(EXECUTOR_SRC), "case 'artificer':", 0);
    expect(executorSlice).toContain('new ArtificerRunner');
    expect(executorSlice).toContain('hostSemanticContext: input.hostSemanticContext');
    const dispatchSlice = caseSliceAt(readSrc(CYCLE_SRC), "case 'artificer':", 0);
    expect(dispatchSlice).toContain('executionInput = {');
    expect(dispatchSlice).toContain('hostSemanticContext: artificerHostSemanticContext');
  });

  it('Guard A3: shared cycle threads hostSemanticContext into the evaluator replay', () => {
    // CodeRabbit review: 执行器透传断言之外, consumer 的 evaluator 装配输入
    // (dispatch switch 的 `case 'evaluator':`) 也必须断言 — 否则 consumer
    // 停止传入时执行器透传代码仍让本守卫空转通过。两处分别捕获装配/透传回归。
    // PRI-1301: 透传断言读独立 executor 模块, 装配断言读 cycle。
    const executorSlice = caseSliceAt(readSrc(EXECUTOR_SRC), "case 'evaluator':", 0);
    expect(executorSlice).toContain('new EvaluatorRunner');
    expect(executorSlice).toContain('hostSemanticContext: input.hostSemanticContext');
    const dispatchSlice = caseSliceAt(readSrc(CYCLE_SRC), "case 'evaluator':", 0);
    expect(dispatchSlice).toContain('executionInput = {');
    expect(dispatchSlice).toContain('hostSemanticContext: artificerHostSemanticContext');
  });

  it('Guard B: run-once artificer branch resolves the durable declaration and degrades observably', () => {
    const src = readSrc(RUN_ONCE_SRC);
    expect(src).toContain('artificer prompt without host tool semantics');
    expect(src).toContain('resolveWorkspaceHostToolSemantics(workspaceDir)');
    expect(src).toContain('buildArtificerHostSemanticContext(hostSemantics.registry, hostSemantics.hostKinds)');
  });

  it('Guard C: both host shells pass their hostKinds label', () => {
    expect(readSrc(OPENCLAW_SERVICE_SRC)).toContain("hostKinds: ['openclaw']");
    expect(readSrc(CODEX_WORKER_SRC)).toContain("hostKinds: ['codex']");
  });

  it('Guard D: pipeline threads the projection into artificer and evaluator', () => {
    const src = readSrc(PIPELINE_RUNNER_SRC);
    expect(src).toContain('const hostSemanticContext = buildArtificerHostSemanticContext(evaluatorContext.registry, evaluatorContext.hostKinds ?? [])');
    expect(src).toContain('hostSemanticContext,');
  });
});
