import { describe, it } from 'vitest';

/**
 * Mainline product-path test — THE LOAD-BEARING WALL of the convergence sprint.
 *
 * Goal: one default-run (NO real LLM) test that drives the REAL production path
 *
 *   pain row
 *     -> diagnosis task + diagnostician artifact (stub runtime output)
 *     -> candidate (via CandidateIntakeService)
 *     -> dreamer task (via the REAL intake-to-internalization bridge / `pd candidate internalize`)
 *     -> dreamer context (via the REAL DreamerRunner.buildContext)
 *   then assembles a MainlineSnapshot from the live SQLite state and asserts
 *   `assertMainlineContract(...).overall === 'ok'`.
 *
 * Why `it.todo` for now: the live assertions are RED until the convergence work
 * lands. Per EP-09 (Test Reality Gap) we do NOT fake a pass — these stay as
 * explicit todos so CI is green but the contract is documented and ungameable.
 * Each `it.todo` becomes a real `it(...)` as its dependency merges.
 *
 * Implementation order this test gates (see convergence plan):
 *   PRI-C  unify runtime config resolver  -> readiness.config_source_alignment ok
 *   PRI-A  this file + assertMainlineContract (DONE: validator + unit tests)
 *   PRI-B  candidate->dreamer lineage fix  -> dreamer_task_lineage + dreamer_context ok
 *   PRI-D  integrity-repair completeness   -> diagnosis_task / auto_consumption ok on real workspace
 *
 * Hard rules for the eventual implementation:
 *   - Use a real SqliteStateManager against a temp workspace (NOT createMockStateManager).
 *   - Seed the diagnostician artifact via a STUB runtime adapter, not a real LLM,
 *     so this runs on every CI. (Real-LLM coverage stays in *-real-llm.test.ts.)
 *   - Create the dreamer task through `seedIntakeTask` / `handleCandidateInternalize`,
 *     never by hand-writing dependencyTaskIds (that is what full-chain-real-llm.test.ts
 *     does and why it never caught the severed-lineage bug).
 *   - Assemble the snapshot with `assembleMainlineSnapshot` below (to be implemented
 *     as the shared reader that integrity/smoke/Console also use).
 */

describe('mainline product-path (load-bearing wall)', () => {
  it.todo('PRI-C: config doctor and probe resolve the same profile from .pd/config.yaml');

  it.todo('seeds a real pain row and runs the diagnostician via a stub runtime adapter');

  it.todo('intake produces a candidate carrying sourceTaskId/sourceArtifactId/sourceRunId lineage');

  it.todo(
    'PRI-B: pd candidate internalize seeds a dreamer task whose dependencyTaskIds ' +
      'includes the diagnosis task and whose inputArtifactRefs reference the diagnostician artifact',
  );

  it.todo('PRI-B: DreamerRunner.buildContext returns contextRefs.length > 0 and contextHash !== "empty"');

  it.todo(
    'assembleMainlineSnapshot(stateManager, painId) + assertMainlineContract → overall "ok" ' +
      'with zero violations across all stages',
  );

  it.todo('a consumed candidate left without a dreamer task makes the contract report auto_consumption violation');
});

/* ───────────────────────────────────────────────────────────────────────────
 * Reference implementation sketch for the shared snapshot assembler.
 * Lives here as a comment until PRI-A wiring is split into its own module so
 * integrity-read-model, `pd mvp smoke`, and the Console chain view all import it
 * (one source of truth — EP-02). Pseudocode, not executable yet:
 *
 *   export async function assembleMainlineSnapshot(
 *     sm: RuntimeStateManager,
 *     painId: string,
 *     readiness: RuntimeReadinessSnapshot,
 *   ): Promise<MainlineSnapshot> {
 *     const diagnosisTask = await findDiagnosisTaskForPain(sm, painId);
 *     const artifact      = diagnosisTask ? await findDiagnosticianArtifact(sm, diagnosisTask.taskId) : null;
 *     const candidate     = artifact ? await sm.getCandidatesByArtifactId(artifact.artifactId)[0] : null;
 *     const dreamerTask   = candidate ? await sm.getTask(`dreamer-${candidate.candidateId}-${channel}`) : null;
 *     const dreamerCtx    = dreamerTask ? await new DreamerRunner(...).buildContext(dreamerTask.taskId) : null;
 *     const successor     = dreamerTask ? await findSuccessor(sm, dreamerTask.taskId) : null;
 *     const principle     = successor ? await findReviewablePrinciple(sm, successor.taskId) : null;
 *     return {
 *       readiness,
 *       chain: {
 *         painId,
 *         diagnosisTask: diagnosisTask && { taskId, status, hasSucceededRun: await hasSucceededRun(sm, taskId) },
 *         diagnosticianArtifact: artifact && { artifactId, sourcePainId: traceArtifactToPain(artifact) },
 *         candidate: candidate && {
 *           candidateId, status,
 *           sourceTaskId: candidate.taskId,
 *           sourceArtifactId: candidate.artifactId,
 *           sourceRunId: candidate.sourceRunId,
 *         },
 *         dreamerTask: dreamerTask && hydratePITaskRecord(dreamerTask) && {
 *           taskId, dependencyTaskIds, inputArtifactRefs,
 *         },
 *         dreamerContext: dreamerCtx && { contextHash, contextRefs },
 *         successor, principle,
 *       },
 *       consumedCandidatesMissingDreamer: await findConsumedCandidatesWithoutDreamer(sm),
 *     };
 *   }
 * ─────────────────────────────────────────────────────────────────────────── */
