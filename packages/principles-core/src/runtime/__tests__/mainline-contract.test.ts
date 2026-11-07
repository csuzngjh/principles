import { describe, it, expect } from 'vitest';
import {
  assertMainlineContract,
  EMPTY_CONTEXT_SENTINEL,
  type MainlineSnapshot,
  type MainlineStage,
} from '../mainline-contract.js';

/**
 * Executable contract for the Story A' mainline.
 *
 * These tests judge the PURE validator over hand-built snapshots, so they are
 * deterministic and run on every CI (no LLM, no DB). They are the single place
 * that defines what "the mainline is healthy" means; the integrity read-model,
 * `pd mvp smoke`, and the Console chain view must produce snapshots this judges.
 */

const FIXED_NOW = () => new Date('2026-06-14T00:00:00.000Z');

/** A fully-healthy snapshot. Each test mutates one stage to assert isolation. */
function healthySnapshot(): MainlineSnapshot {
  return {
    readiness: {
      configDoctorProfile: 'pi-ai.lmstudio',
      runtimeProbeProfile: 'pi-ai.lmstudio',
      configSource: '.pd/config.yaml',
      probeConfigSource: '.pd/config.yaml',
      diagnosticianReady: true,
    },
    chain: {
      painId: 'pain-001',
      diagnosisTask: { taskId: 'diag_router-001', status: 'succeeded', hasSucceededRun: true },
      diagnosticianArtifact: { artifactId: 'art-001', sourcePainId: 'pain-001' },
      candidate: {
        candidateId: 'cand-001',
        status: 'consumed',
        sourceTaskId: 'diag_router-001',
        sourceArtifactId: 'art-001',
        sourceRunId: 'run_diag_router-001',
      },
      dreamerTask: {
        taskId: 'dreamer-cand-001-prompt',
        dependencyTaskIds: ['diag_router-001'],
        inputArtifactRefs: [{ artifactType: 'diagnostician_output', ref: 'artifact://art-001' }],
      },
      dreamerContext: { contextHash: 'abc123', contextRefs: ['artifact://art-001'] },
      successor: { taskId: 'philosopher-dreamer-cand-001-prompt', taskKind: 'philosopher', exists: true },
      principle: { exists: true, principleId: 'prin-001', reviewable: true },
    },
    consumedCandidatesMissingDreamer: [],
  };
}

function stage(verdicts: ReturnType<typeof assertMainlineContract>, name: MainlineStage) {
  const v = verdicts.stages.find((s) => s.stage === name);
  if (!v) throw new Error(`stage ${name} not found in verdict`);
  return v;
}

describe('assertMainlineContract', () => {
  it('healthy snapshot → overall ok, every stage ok, no violations', () => {
    const verdict = assertMainlineContract(healthySnapshot(), FIXED_NOW);
    expect(verdict.overall).toBe('ok');
    expect(verdict.painId).toBe('pain-001');
    expect(verdict.stages.every((s) => s.status === 'ok')).toBe(true);
    expect(verdict.generatedAt).toBe('2026-06-14T00:00:00.000Z');
  });

  it('every violation carries a non-empty reason and nextAction (EP-03)', () => {
    const snap = healthySnapshot();
    snap.chain.dreamerTask = { taskId: 'dreamer-x', dependencyTaskIds: [], inputArtifactRefs: [] };
    snap.chain.dreamerContext = { contextHash: EMPTY_CONTEXT_SENTINEL, contextRefs: [] };
    const verdict = assertMainlineContract(snap, FIXED_NOW);
    for (const s of verdict.stages) {
      if (s.status === 'violation') {
        expect(s.reason.trim().length).toBeGreaterThan(0);
        expect(s.nextAction && s.nextAction.trim().length).toBeTruthy();
      }
    }
  });

  // ── The current production bug: severed dreamer lineage ──────────────────────
  it('dreamer task with empty dependencyTaskIds → dreamer_task_lineage violation', () => {
    const snap = healthySnapshot();
    snap.chain.dreamerTask = {
      taskId: 'dreamer-cand-001-prompt',
      dependencyTaskIds: [],
      inputArtifactRefs: [{ artifactType: 'candidate', ref: 'candidate://cand-001' }],
    };
    const verdict = assertMainlineContract(snap, FIXED_NOW);
    expect(verdict.overall).toBe('violation');
    expect(stage(verdict, 'dreamer_task_lineage').status).toBe('violation');
    // downstream cascades to skipped, not a pile of violations
    expect(stage(verdict, 'dreamer_context').status).toBe('skipped');
    expect(stage(verdict, 'successor').status).toBe('skipped');
  });

  it('empty dreamer context (sentinel) → dreamer_context violation', () => {
    const snap = healthySnapshot();
    snap.chain.dreamerContext = { contextHash: EMPTY_CONTEXT_SENTINEL, contextRefs: [] };
    const verdict = assertMainlineContract(snap, FIXED_NOW);
    expect(stage(verdict, 'dreamer_context').status).toBe('violation');
  });

  // ── P1: isManualEmptyInput must NOT bypass candidate-derived lineage ─────────
  // The contract judges the MVP mainline only — isManualEmptyInput gets no
  // special treatment. Candidate-derived chains must carry correct lineage
  // regardless.
  it('P1: isManualEmptyInput=true with no lineage → dreamer_task_lineage violation', () => {
    const snap = healthySnapshot();
    snap.chain.dreamerTask = {
      taskId: 'dreamer-manual',
      dependencyTaskIds: [],
      inputArtifactRefs: [],
      isManualEmptyInput: true,
    };
    snap.chain.dreamerContext = { contextHash: EMPTY_CONTEXT_SENTINEL, contextRefs: [] };
    const verdict = assertMainlineContract(snap, FIXED_NOW);
    expect(verdict.overall).toBe('violation');
    expect(stage(verdict, 'dreamer_task_lineage').status).toBe('violation');
    expect(stage(verdict, 'dreamer_context').status).toBe('skipped');
  });

  // ── P2: artifact ref matching must be exact, not substring ───────────────────
  it('P2: artifact ref with substring-only match (artifact://art-001-old) → violation', () => {
    const snap = healthySnapshot();
    snap.chain.dreamerTask = {
      taskId: 'dreamer-cand-001-prompt',
      dependencyTaskIds: ['diag_router-001'],
      inputArtifactRefs: [{ artifactType: 'diagnostician_output', ref: 'artifact://art-001-old' }],
    };
    const verdict = assertMainlineContract(snap, FIXED_NOW);
    expect(stage(verdict, 'dreamer_task_lineage').status).toBe('violation');
    expect(stage(verdict, 'dreamer_task_lineage').reason).toContain('inputArtifactRefs');
  });

  it('P2: artifact ref matches by type and exact ref → dreamer_task_lineage ok', () => {
    const snap = healthySnapshot();
    snap.chain.dreamerTask = {
      taskId: 'dreamer-cand-001-prompt',
      dependencyTaskIds: ['diag_router-001'],
      inputArtifactRefs: [{ artifactType: 'diagnostician_output', ref: 'artifact://art-001' }],
    };
    const verdict = assertMainlineContract(snap, FIXED_NOW);
    expect(stage(verdict, 'dreamer_task_lineage').status).toBe('ok');
  });

  // ── Readiness gates (independent of chain) ───────────────────────────────────
  it('config drift (doctor != probe) → config_source_alignment violation', () => {
    const snap = healthySnapshot();
    snap.readiness.runtimeProbeProfile = 'pi-ai.sensenova';
    snap.readiness.probeConfigSource = '.state/workflows.yaml';
    const verdict = assertMainlineContract(snap, FIXED_NOW);
    expect(stage(verdict, 'config_source_alignment').status).toBe('violation');
    expect(stage(verdict, 'config_source_alignment').reason).toContain('drift');
  });

  it('coincidental match but legacy probe source → config_source_alignment violation', () => {
    const snap = healthySnapshot();
    snap.readiness.probeConfigSource = '.state/workflows.yaml';
    const verdict = assertMainlineContract(snap, FIXED_NOW);
    expect(stage(verdict, 'config_source_alignment').status).toBe('violation');
  });

  it('diagnostician not ready → diagnostician_readiness violation', () => {
    const snap = healthySnapshot();
    snap.readiness.diagnosticianReady = false;
    snap.readiness.diagnosticianReadinessReason = 'needs_probe';
    const verdict = assertMainlineContract(snap, FIXED_NOW);
    expect(stage(verdict, 'diagnostician_readiness').status).toBe('violation');
  });

  // ── task_succeeded_no_succeeded_run ──────────────────────────────────────────
  it('diagnosis task succeeded but no succeeded run → diagnosis_task violation', () => {
    const snap = healthySnapshot();
    snap.chain.diagnosisTask = { taskId: 'diag_router-001', status: 'succeeded', hasSucceededRun: false };
    const verdict = assertMainlineContract(snap, FIXED_NOW);
    expect(stage(verdict, 'diagnosis_task').status).toBe('violation');
    expect(stage(verdict, 'candidate_lineage').status).toBe('skipped');
  });

  // ── Same-source lineage (EP-07) ──────────────────────────────────────────────
  it('candidate lineage mismatch (sourceTaskId != diagnosis task) → candidate_lineage violation', () => {
    const snap = healthySnapshot();
    snap.chain.candidate = {
      candidateId: 'cand-001',
      status: 'consumed',
      sourceTaskId: 'diag_router-OTHER',
      sourceArtifactId: 'art-001',
      sourceRunId: 'run_diag_router-001',
    };
    const verdict = assertMainlineContract(snap, FIXED_NOW);
    expect(stage(verdict, 'candidate_lineage').status).toBe('violation');
  });

  // ── Auto-consumption hole (missing_dreamer_task) ─────────────────────────────
  it('consumed candidates missing dreamer task → auto_consumption violation', () => {
    const snap = healthySnapshot();
    snap.consumedCandidatesMissingDreamer = ['e0f1da64', 'c1938d3b', 'd68f89c1'];
    const verdict = assertMainlineContract(snap, FIXED_NOW);
    expect(stage(verdict, 'auto_consumption').status).toBe('violation');
    expect(stage(verdict, 'auto_consumption').reason).toContain('3 consumed');
  });

  // ── Cascade root-cause clarity ───────────────────────────────────────────────
  it('missing painId blocks all chain stages as skipped but readiness still evaluates', () => {
    const snap = healthySnapshot();
    snap.chain.painId = null;
    const verdict = assertMainlineContract(snap, FIXED_NOW);
    expect(stage(verdict, 'pain_record').status).toBe('violation');
    expect(stage(verdict, 'diagnosis_task').status).toBe('skipped');
    expect(stage(verdict, 'config_source_alignment').status).toBe('ok');
    expect(stage(verdict, 'auto_consumption').status).toBe('ok');
  });
});
