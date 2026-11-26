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
 * Slice the Nth (0-based) occurrence of a case label. The file has TWO
 * `case 'artificer':` switches — the shared executor's (first) and the
 * consumer dispatch input assembly (second). CodeRabbit review: full-file
 * assertions are vacuous for the consumer assembly point because the other
 * branch's identical line still satisfies them; each guard must pin the
 * exact branch it owns.
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
    // PRI-1293 Phase 2B: Runner 构造收编进文件内的共享执行器 (文件中第一个
    // `case 'artificer':`) — 执行器把 input.hostSemanticContext 透传进
    // ArtificerRunner options。CodeRabbit review: consumer 的 artificer
    // 装配输入 (文件中第二个 `case 'artificer':` — dispatch switch) 必须
    // 单独断言 — 全文件断言会被 evaluator 分支的相同行 vacuously 满足。
    const src = readSrc(CYCLE_SRC);
    const executorSlice = caseSliceAt(src, "case 'artificer':", 0);
    expect(executorSlice).toContain('new ArtificerRunner');
    expect(executorSlice).toContain('hostSemanticContext: input.hostSemanticContext');
    const dispatchSlice = caseSliceAt(src, "case 'artificer':", 1);
    expect(dispatchSlice).toContain('executionInput = {');
    expect(dispatchSlice).toContain('hostSemanticContext: artificerHostSemanticContext');
  });

  it('Guard A3: shared cycle threads hostSemanticContext into the evaluator replay', () => {
    // CodeRabbit review: 执行器透传断言之外, consumer 的 evaluator 装配输入
    // (dispatch switch 的 `case 'evaluator':`) 也必须断言 — 否则 consumer
    // 停止传入时执行器透传代码仍让本守卫空转通过。两处分别捕获装配/透传回归。
    const src = readSrc(CYCLE_SRC);
    const executorSlice = caseSliceAt(src, "case 'evaluator':", 0);
    expect(executorSlice).toContain('new EvaluatorRunner');
    expect(executorSlice).toContain('hostSemanticContext: input.hostSemanticContext');
    const dispatchSlice = caseSliceAt(src, "case 'evaluator':", 1);
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
