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
  const start = source.indexOf(caseName);
  const end = source.indexOf("case '", start + caseName.length);
  if (start < 0 || end < 0) return '';
  return source.slice(start, end);
}

describe('PRI-741 host semantic projection wiring guard', () => {
  it('Guard A1: shared cycle builds the projection from ports.toolSemantics (one provenance)', () => {
    const src = readSrc(CYCLE_SRC);
    expect(src).toContain('toolSemantics.hostMappings()');
    expect(src).toContain('ports.hostKinds');
  });

  it('Guard A2: shared cycle threads hostSemanticContext into the artificer prompt', () => {
    const slice = caseSlice(readSrc(CYCLE_SRC), "case 'artificer':");
    expect(slice).toContain('new ArtificerRunner');
    expect(slice).toContain('hostSemanticContext: artificerHostSemanticContext');
  });

  it('Guard A3: shared cycle threads hostSemanticContext into the evaluator replay', () => {
    const slice = caseSlice(readSrc(CYCLE_SRC), "case 'evaluator':");
    expect(slice).toContain('new EvaluatorRunner');
    expect(slice).toContain('hostSemanticContext: artificerHostSemanticContext');
  });

  it('Guard B: run-once artificer branch resolves the durable declaration and degrades observably', () => {
    const src = readSrc(RUN_ONCE_SRC);
    expect(src).toContain('artificer prompt without host tool semantics');
    expect(src).toContain('resolveWorkspaceHostToolSemantics(workspaceDir)');
    expect(src).toContain('hostSemantics.registry.hostMappings()');
  });

  it('Guard C: both host shells pass their hostKinds label', () => {
    expect(readSrc(OPENCLAW_SERVICE_SRC)).toContain("hostKinds: ['openclaw']");
    expect(readSrc(CODEX_WORKER_SRC)).toContain("hostKinds: ['codex']");
  });

  it('Guard D: pipeline threads the projection into artificer and evaluator', () => {
    const src = readSrc(PIPELINE_RUNNER_SRC);
    expect(src).toContain('hostSemanticContext: { hostKinds: artificerHostSemantics.hostKinds, tools: artificerHostSemantics.registry.hostMappings() }');
    expect(src).toContain('artificer prompt without host tool semantics');
  });
});
