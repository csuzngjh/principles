// G1 execution engine — drives one (history-arm × strategy) through the full
// loop: learn from history → freeze candidate → per-opportunity interactive
// run against the oracle → adjudicate. Pure and deterministic; used by both
// run-pilot.mjs and the test suite.

import {
  allOpportunities,
  assembleActorInput,
  goldFor,
  renderHistoryText,
} from './fixture.mjs';
import { finishRun, newRunState, outcome, step } from './oracle.mjs';
import { adjudicate } from './evaluator.mjs';
import { freezeCandidate } from './sidecar.mjs';
import { taskFeatures } from './strategies.mjs';

const TASK_KEY_RE = /config key `([^`]+)`/;

function extractTaskKey(taskText) {
  return TASK_KEY_RE.exec(taskText)?.[1] ?? null;
}

/**
 * Run one arm. Returns { arm, adjudications, actorInputs } where actorInputs
 * are the exact texts the agent saw (leak-audit evidence, NT-01 basis).
 */
export function runArm({ dataset, historyId, strategy, studyId }) {
  const armId = `${historyId}:${strategy.id}`;
  const history = dataset.histories[historyId];
  const historyText = renderHistoryText(history);

  const learned = strategy.learn(history, historyText);
  const frozenCandidate = freezeCandidate({
    policyText: learned.policyText,
    sourceStage: 'simulated-learn',
    deliveredRepresentation: 'simulated_policy_text',
  });

  const armMemory = {};
  const mode = learned.core.startsWith('always-revise:') ? learned.core.slice('always-revise:'.length) : null;

  const adjudications = [];
  const actorInputs = [];
  const runSummaries = [];

  for (const opp of allOpportunities(dataset)) {
    const input = assembleActorInput(dataset, historyId, opp.probeId, opp.opportunityId);
    actorInputs.push(input);
    const taskText = opp.taskInstructions.join('\n');

    const state = newRunState(opp.environment);
    const narratives = [];
    let guard = 0;
    while (!state.terminal && guard < 60) {
      guard += 1;
      const ctx = {
        state,
        task: taskFeatures(taskText),
        taskKey: extractTaskKey(taskText),
        learned,
        mode,
        armMemory,
      };
      const action = strategy.nextAction(ctx);
      if (action?.narrative) narratives.push(action.narrative);
      step(opp.environment, state, action);
    }
    if (!state.terminal) finishRun(opp.environment, state, 'timeout');

    const runOutcome = outcome(state, narratives.join(' '));
    const goldRecord = goldFor(dataset, opp.probeId, opp.opportunityId);
    adjudications.push(
      adjudicate({
        studyId,
        armId,
        probeId: opp.probeId,
        opportunityId: opp.opportunityId,
        goldRecord,
        outcome: runOutcome,
      }),
    );
    runSummaries.push({ opportunityId: opp.opportunityId, outcome: runOutcome });
  }

  const arm = {
    armId,
    historyId,
    strategyId: strategy.id,
    strategyKind: strategy.kind,
    actorKind: 'simulated',
    allocationUnit: 'episode',
    informationCutoff: dataset.episode.informationCutoff,
    initialMemoryManifest: {
      schemaVersion: 'memory-manifest.v0.1',
      entries: [],
      note: 'simulated agent — no external memory; the arm input is manual + history only',
    },
    frozenCandidate,
    learned: { core: learned.core, emphasis: learned.emphasis, policyHash: learned.policyHash },
  };

  return { arm, adjudications, actorInputs, runSummaries };
}

/** Run every (history × strategy) arm in the preregistered order. */
export function runAllArms({ dataset, strategies, studyId }) {
  const arms = [];
  const adjudications = [];
  const actorInputs = [];
  const runSummariesByArm = new Map();
  for (const historyId of ['E0', 'EA', 'EB', 'EN']) {
    for (const strategy of strategies) {
      const r = runArm({ dataset, historyId, strategy, studyId });
      arms.push(r.arm);
      adjudications.push(...r.adjudications);
      actorInputs.push(...r.actorInputs);
      runSummariesByArm.set(r.arm.armId, r.runSummaries);
    }
  }
  return { arms, adjudications, actorInputs, runSummariesByArm };
}
