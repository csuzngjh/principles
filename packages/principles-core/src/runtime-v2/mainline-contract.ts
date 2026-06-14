/**
 * Mainline Contract (Runtime Mainline Convergence — load-bearing wall)
 *
 * Single executable source of truth for the Story A' product mainline:
 *
 *   pain -> diagnosis -> diagnostician artifact -> candidate
 *        -> dreamer task (lineage) -> dreamer context -> successor
 *        -> owner-reviewable principle
 *
 * Plus the two runtime-readiness gates that sit *above* the chain and silently
 * break it when they drift: config-source alignment and diagnostician readiness.
 *
 * Design rules (do NOT relax without ADR review):
 *   - PURE: no fs, no DB, no network, no Date.now side effects beyond `generatedAt`.
 *     The caller assembles a read-only `MainlineSnapshot` from canonical sources;
 *     this module only judges it. (Keeps it in principles-core per ADR-0001.)
 *   - TOTAL: never throws. Malformed/absent input becomes a `violation` or
 *     `skipped` verdict, never an exception.
 *   - FAIL LOUD (EP-03): every `violation` carries a concrete `reason` and a
 *     `nextAction` an operator can run. No silent degradation.
 *   - SAME-SOURCE LINEAGE (EP-07): lineage checks compare fields that must come
 *     from one source (candidate.sourceTaskId/sourceArtifactId/sourceRunId vs the
 *     diagnosis task / diagnostician artifact that produced them).
 *   - ONE TRUTH (EP-02): the integrity read-model, `pd mvp smoke`, the CI
 *     product-path test, and the Console chain view must all call THIS function.
 *     Do not fork a second copy of these rules.
 */

/** Stages of the mainline, in evaluation order. Readiness gates first. */
export type MainlineStage =
  | 'config_source_alignment'
  | 'diagnostician_readiness'
  | 'pain_record'
  | 'diagnosis_task'
  | 'diagnostician_artifact'
  | 'candidate_lineage'
  | 'dreamer_task_lineage'
  | 'dreamer_context'
  | 'successor'
  | 'owner_reviewable_principle'
  | 'auto_consumption';

export type StageStatus = 'ok' | 'violation' | 'skipped';

export interface StageVerdict {
  stage: MainlineStage;
  status: StageStatus;
  /** Always present. For `ok` it states what was satisfied; for `violation`/`skipped` why. */
  reason: string;
  /** Required for `violation`: a concrete operator action. Optional otherwise. */
  nextAction?: string;
}

export interface MainlineVerdict {
  overall: 'ok' | 'violation';
  painId: string | null;
  stages: StageVerdict[];
  generatedAt: string;
}

// ── Snapshot input shapes (assembled by a reader; all fields are plain data) ────

export interface ArtifactRefSnapshot {
  artifactType: string;
  ref: string;
}

/** Workspace-global readiness, independent of any single chain. */
export interface RuntimeReadinessSnapshot {
  /** Runtime profile reported by `pd config doctor` (reads .pd/config.yaml). */
  configDoctorProfile: string | null;
  /** Runtime profile actually resolved by run-once/probe at execution time. */
  runtimeProbeProfile: string | null;
  /** Canonical config source path, e.g. ".pd/config.yaml". */
  configSource: string;
  /** Config source the probe/run-once resolver actually read, e.g. ".state/workflows.yaml". */
  probeConfigSource: string;
  /** Whether the diagnostician agent passed its readiness/connectivity probe. */
  diagnosticianReady: boolean;
  diagnosticianReadinessReason?: string;
}

export interface DiagnosisTaskSnapshot {
  taskId: string;
  /** Task status string from the task store (e.g. 'succeeded'). */
  status: string;
  /** Whether at least one run for this task has execution_status === 'succeeded'. */
  hasSucceededRun: boolean;
}

export interface DiagnosticianArtifactSnapshot {
  artifactId: string;
  /** painId the artifact traces back to; must equal the chain painId. */
  sourcePainId: string | null;
}

export interface CandidateSnapshot {
  candidateId: string;
  status: 'pending' | 'consumed' | 'expired';
  /** candidate.taskId — must equal the diagnosis task that produced it. */
  sourceTaskId: string;
  /** candidate.artifactId — must equal the diagnostician artifact. */
  sourceArtifactId: string;
  /** candidate.sourceRunId. */
  sourceRunId: string;
}

export interface DreamerTaskSnapshot {
  taskId: string;
  dependencyTaskIds: string[];
  inputArtifactRefs: ArtifactRefSnapshot[];
  /** True only when this dreamer task is an intentional manual empty-input task. */
  isManualEmptyInput?: boolean;
}

export interface DreamerContextSnapshot {
  contextHash: string;
  contextRefs: string[];
}

export interface SuccessorSnapshot {
  taskId: string;
  taskKind: string;
  exists: boolean;
}

export interface OwnerReviewablePrincipleSnapshot {
  exists: boolean;
  principleId?: string;
  reviewable: boolean;
}

/** One pain's chain. Any stage not yet reached is `null`. */
export interface MainlineChainSnapshot {
  painId: string | null;
  diagnosisTask: DiagnosisTaskSnapshot | null;
  diagnosticianArtifact: DiagnosticianArtifactSnapshot | null;
  candidate: CandidateSnapshot | null;
  dreamerTask: DreamerTaskSnapshot | null;
  dreamerContext: DreamerContextSnapshot | null;
  successor: SuccessorSnapshot | null;
  principle: OwnerReviewablePrincipleSnapshot | null;
}

export interface MainlineSnapshot {
  readiness: RuntimeReadinessSnapshot;
  chain: MainlineChainSnapshot;
  /**
   * Workspace-level: candidateIds that are `consumed` but have no dreamer task.
   * Surfaces the `missing_dreamer_task` auto-consumption hole. Optional.
   */
  consumedCandidatesMissingDreamer?: string[];
}

/** Sentinel contextHash produced by hashing an empty contextRefs list. */
export const EMPTY_CONTEXT_SENTINEL = 'empty';

// ── Validator ───────────────────────────────────────────────────────────────

function ok(stage: MainlineStage, reason: string): StageVerdict {
  return { stage, status: 'ok', reason };
}

function violation(stage: MainlineStage, reason: string, nextAction: string): StageVerdict {
  return { stage, status: 'violation', reason, nextAction };
}

function skipped(stage: MainlineStage, upstream: MainlineStage): StageVerdict {
  return {
    stage,
    status: 'skipped',
    reason: `Upstream stage "${upstream}" not satisfied — cannot evaluate.`,
  };
}

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Judge a single mainline snapshot. Pure and total.
 *
 * Readiness gates (config alignment, diagnostician readiness) and the
 * workspace-level auto-consumption check always evaluate. Chain stages cascade:
 * once a chain prerequisite is a `violation`, downstream chain stages become
 * `skipped` so the output names one actionable root cause instead of a misleading
 * cascade of violations.
 */
export function assertMainlineContract(
  snapshot: MainlineSnapshot,
  now: () => Date = () => new Date(),
): MainlineVerdict {
  const stages: StageVerdict[] = [];
  const { readiness, chain } = snapshot;

  // ── Readiness gate 1: config-source alignment (EP-07) ──────────────────────
  if (!nonEmpty(readiness.configDoctorProfile) || !nonEmpty(readiness.runtimeProbeProfile)) {
    stages.push(violation(
      'config_source_alignment',
      `Cannot confirm runtime profile: doctor=${readiness.configDoctorProfile ?? 'null'}, probe=${readiness.runtimeProbeProfile ?? 'null'}.`,
      `Run "pd config doctor" and "pd runtime probe" in the same workspace and ensure both resolve a profile from ${readiness.configSource}.`,
    ));
  } else if (readiness.configDoctorProfile !== readiness.runtimeProbeProfile) {
    stages.push(violation(
      'config_source_alignment',
      `Config drift: doctor reports "${readiness.configDoctorProfile}" from ${readiness.configSource} but probe/run-once resolved "${readiness.runtimeProbeProfile}" from ${readiness.probeConfigSource}.`,
      `Unify the runtime resolver onto ${readiness.configSource} (PRI-306 resolveRuntimeConfigFromPdConfig); demote ${readiness.probeConfigSource} to a legacy warning.`,
    ));
  } else if (readiness.probeConfigSource !== readiness.configSource) {
    stages.push(violation(
      'config_source_alignment',
      `Profiles match ("${readiness.configDoctorProfile}") but probe read from ${readiness.probeConfigSource}, not the canonical ${readiness.configSource} — match is coincidental and will drift.`,
      `Point run-once/probe at ${readiness.configSource} so the match is structural, not accidental.`,
    ));
  } else {
    stages.push(ok('config_source_alignment', `doctor and probe agree on "${readiness.configDoctorProfile}" from ${readiness.configSource}.`));
  }

  // ── Readiness gate 2: diagnostician readiness ──────────────────────────────
  if (readiness.diagnosticianReady) {
    stages.push(ok('diagnostician_readiness', 'Diagnostician passed readiness probe.'));
  } else {
    stages.push(violation(
      'diagnostician_readiness',
      `Diagnostician not ready: ${readiness.diagnosticianReadinessReason ?? 'unknown reason'}.`,
      'Run "pd runtime probe" to verify provider connectivity; the chain cannot produce candidates until the diagnostician is ready.',
    ));
  }

  // ── Chain stages (cascade) ─────────────────────────────────────────────────
  let blocked: MainlineStage | null = null;

  // 1. pain_record
  if (nonEmpty(chain.painId)) {
    stages.push(ok('pain_record', `Canonical painId "${chain.painId}" present.`));
  } else {
    stages.push(violation('pain_record', 'No canonical painId on the chain.', 'Record behavior evidence via the pain intake path before evaluating the chain.'));
    blocked = 'pain_record';
  }

  // 2. diagnosis_task
  if (blocked) {
    stages.push(skipped('diagnosis_task', blocked));
  } else if (!chain.diagnosisTask) {
    stages.push(violation('diagnosis_task', `No diagnosis task linked to pain "${chain.painId}".`, 'Run "pd diagnose" / pain-retry for this pain to create a diagnosis task.'));
    blocked = 'diagnosis_task';
  } else if (chain.diagnosisTask.status !== 'succeeded' || !chain.diagnosisTask.hasSucceededRun) {
    stages.push(violation(
      'diagnosis_task',
      `Diagnosis task ${chain.diagnosisTask.taskId} status="${chain.diagnosisTask.status}", hasSucceededRun=${chain.diagnosisTask.hasSucceededRun} (task_succeeded_no_succeeded_run if succeeded without a run).`,
      `Run "pd runtime internalization integrity-repair --confirm" to reconcile task/run state for ${chain.diagnosisTask.taskId}, or re-run the diagnosis.`,
    ));
    blocked = 'diagnosis_task';
  } else {
    stages.push(ok('diagnosis_task', `Diagnosis task ${chain.diagnosisTask.taskId} succeeded with a succeeded run.`));
  }

  // 3. diagnostician_artifact
  if (blocked) {
    stages.push(skipped('diagnostician_artifact', blocked));
  } else if (!chain.diagnosticianArtifact) {
    stages.push(violation('diagnostician_artifact', 'Diagnosis task succeeded but no diagnostician artifact found.', 'Inspect the diagnosis task output; re-run diagnosis if the artifact is missing.'));
    blocked = 'diagnostician_artifact';
  } else if (chain.diagnosticianArtifact.sourcePainId !== chain.painId) {
    stages.push(violation(
      'diagnostician_artifact',
      `Artifact ${chain.diagnosticianArtifact.artifactId} traces to painId "${chain.diagnosticianArtifact.sourcePainId ?? 'null'}", not the chain pain "${chain.painId}".`,
      'Fix artifact lineage so sourcePainId matches the originating pain (EP-07 same-source rule).',
    ));
    blocked = 'diagnostician_artifact';
  } else {
    stages.push(ok('diagnostician_artifact', `Artifact ${chain.diagnosticianArtifact.artifactId} traces to pain "${chain.painId}".`));
  }

  // 4. candidate_lineage
  if (blocked) {
    stages.push(skipped('candidate_lineage', blocked));
  } else if (!chain.candidate) {
    stages.push(violation('candidate_lineage', 'Diagnostician artifact present but produced no candidate.', 'Verify candidate intake (CandidateIntakeService) ran for this artifact.'));
    blocked = 'candidate_lineage';
  } else {
    const c = chain.candidate;
    const diagTaskId = chain.diagnosisTask?.taskId;
    const artId = chain.diagnosticianArtifact?.artifactId;
    if (!nonEmpty(c.sourceTaskId) || !nonEmpty(c.sourceArtifactId) || !nonEmpty(c.sourceRunId)) {
      stages.push(violation('candidate_lineage', `Candidate ${c.candidateId} missing lineage (taskId/artifactId/sourceRunId).`, 'Ensure the candidate store row carries sourceTaskId/sourceArtifactId/sourceRunId.'));
      blocked = 'candidate_lineage';
    } else if (c.sourceTaskId !== diagTaskId || c.sourceArtifactId !== artId) {
      stages.push(violation(
        'candidate_lineage',
        `Candidate ${c.candidateId} lineage mismatch: sourceTaskId=${c.sourceTaskId} (expected ${diagTaskId}), sourceArtifactId=${c.sourceArtifactId} (expected ${artId}).`,
        'Lineage fields must come from the diagnosis task/artifact that produced the candidate (EP-07).',
      ));
      blocked = 'candidate_lineage';
    } else {
      stages.push(ok('candidate_lineage', `Candidate ${c.candidateId} carries consistent lineage to ${diagTaskId}/${artId}.`));
    }
  }

  // 5. dreamer_task_lineage — the current production bug
  if (blocked) {
    stages.push(skipped('dreamer_task_lineage', blocked));
  } else if (!chain.dreamerTask) {
    const consumedHole = chain.candidate?.status === 'consumed';
    stages.push(violation(
      'dreamer_task_lineage',
      `Candidate ${chain.candidate?.candidateId} has no dreamer task${consumedHole ? ' (consumed but no successor — auto-consumption hole)' : ''}.`,
      `Run "pd candidate internalize --candidate-id ${chain.candidate?.candidateId}" or fix the auto-consumer so it seeds a dreamer task.`,
    ));
    blocked = 'dreamer_task_lineage';
  } else {
    const dt = chain.dreamerTask;
    const expectedDep = chain.candidate?.sourceTaskId;
    const expectedArtifact = chain.candidate?.sourceArtifactId;
    const hasDep = !!expectedDep && dt.dependencyTaskIds.includes(expectedDep);
    const hasArtifactRef = !!expectedArtifact && dt.inputArtifactRefs.some(
      (r) => r.artifactType === 'diagnostician_output' && r.ref === `artifact://${expectedArtifact}`,
    );
    if (!hasDep) {
      stages.push(violation(
        'dreamer_task_lineage',
        `Dreamer task ${dt.taskId} dependencyTaskIds=${JSON.stringify(dt.dependencyTaskIds)} does not include diagnosis task "${expectedDep}" — diagnosis context is severed.`,
        'Fix the intake bridge to set dependencyTaskIds=[candidate.sourceTaskId] (PRI-B). This is what makes dreamer contextRefs non-empty.',
      ));
      blocked = 'dreamer_task_lineage';
    } else if (!hasArtifactRef) {
      stages.push(violation(
        'dreamer_task_lineage',
        `Dreamer task ${dt.taskId} inputArtifactRefs do not reference the diagnostician artifact "${expectedArtifact}".`,
        'Fix the intake bridge to set a real artifact ref instead of "candidate://<id>" (PRI-B).',
      ));
      blocked = 'dreamer_task_lineage';
    } else {
      stages.push(ok('dreamer_task_lineage', `Dreamer task ${dt.taskId} depends on diagnosis task ${expectedDep} and references artifact ${expectedArtifact}.`));
    }
  }

  // 6. dreamer_context
  if (blocked) {
    stages.push(skipped('dreamer_context', blocked));
  } else if (!chain.dreamerContext) {
    stages.push(violation('dreamer_context', 'Dreamer task present but no context was built.', 'Run the dreamer once and capture its DreamerContext.'));
    blocked = 'dreamer_context';
  } else {
    const ctx = chain.dreamerContext;
    const isEmpty = ctx.contextRefs.length === 0 || ctx.contextHash === EMPTY_CONTEXT_SENTINEL;
    if (isEmpty) {
      stages.push(violation(
        'dreamer_context',
        `Dreamer context is empty (contextHash="${ctx.contextHash}", contextRefs=${ctx.contextRefs.length}) — not grounded in the diagnosis chain.`,
        'Root cause is upstream lineage (PRI-B): once dependencyTaskIds includes the diagnosis task, buildContext will populate contextRefs.',
      ));
      blocked = 'dreamer_context';
    } else {
      stages.push(ok('dreamer_context', `Dreamer context grounded: ${ctx.contextRefs.length} contextRefs, hash ${ctx.contextHash}.`));
    }
  }

  // 7. successor (philosopher)
  if (blocked) {
    stages.push(skipped('successor', blocked));
  } else if (!chain.successor || !chain.successor.exists) {
    stages.push(violation('successor', 'Dreamer context grounded but no successor task created.', 'Ensure the philosopher successor is seeded after the dreamer succeeds.'));
    blocked = 'successor';
  } else {
    stages.push(ok('successor', `Successor ${chain.successor.taskId} (${chain.successor.taskKind}) exists.`));
  }

  // 8. owner_reviewable_principle
  if (blocked) {
    stages.push(skipped('owner_reviewable_principle', blocked));
  } else if (!chain.principle || !chain.principle.exists) {
    stages.push(violation('owner_reviewable_principle', 'Chain reached successor but produced no principle.', 'Run the scribe/philosopher chain to emit a reviewable principle.'));
  } else if (!chain.principle.reviewable) {
    stages.push(violation('owner_reviewable_principle', `Principle ${chain.principle.principleId ?? '(unknown)'} exists but is not owner-reviewable.`, 'Surface the principle in the owner review queue / Console.'));
  } else {
    stages.push(ok('owner_reviewable_principle', `Principle ${chain.principle.principleId ?? '(unknown)'} is owner-reviewable.`));
  }

  // ── Workspace-level: auto-consumption hole (always evaluated) ───────────────
  const orphans = snapshot.consumedCandidatesMissingDreamer ?? [];
  if (orphans.length === 0) {
    stages.push(ok('auto_consumption', 'No consumed candidates are missing a dreamer task.'));
  } else {
    stages.push(violation(
      'auto_consumption',
      `${orphans.length} consumed candidate(s) have no dreamer task: ${orphans.slice(0, 5).join(', ')}${orphans.length > 5 ? ', …' : ''}.`,
      `Run "pd candidate internalize --candidate-id <id>" for each, and fix the auto-consumer so consumption always seeds a dreamer task.`,
    ));
  }

  const overall = stages.some((s) => s.status === 'violation') ? 'violation' : 'ok';
  return { overall, painId: chain.painId, stages, generatedAt: now().toISOString() };
}
