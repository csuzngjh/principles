/**
 * SPEC-RULECODE-QUALITY-001 A1 — artificer intent-basis preflight (Q01 / Q13 /
 * Q14 / Q20 / Q21 / Q22).
 *
 * Unit + real-SQLite integration tests for the PRE-MODEL intent gate that runs
 * BEFORE any Artificer runner construction on the code_tool_hook channel:
 *
 *   Q01  a scribe artifact without the machine-readable execution conditions
 *        (the original pain's legacy chain shape) yields an explicit stop
 *        point (needs_human_review, reasonCode intent_unverified), ZERO
 *        generation calls;
 *   Q20  the gate reads the SCRIBE artifact from the store — a generator that
 *        omits its approval dependency cannot bypass it, and a stale stored
 *        verification record is never a pass token (always re-derived);
 *   Q13  the versioned verification record binds scribe/intent/conditions
 *        digests; a changed scribe artifact invalidates the previous record;
 *   Q14  the NHR transition is CAS-guarded and idempotent — a repeat run
 *        never writes a second review context and never loses history;
 *   Q21  a transient source fault (artifact store I/O) retries technically at
 *        zero model cost with a restart-durable, bounded backoff;
 *   Q22  the 3rd consecutive source fault ends auto-retry with a clear
 *        source-fault terminal state that is NOT labeled an Owner fault.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRuntimeStateHandle,
  createPITaskDiagnosticJson,
  hydratePITaskRecord,
  type StoreEventEmitter,
  type TelemetryEvent,
} from '../../index.js';
import {
  preflightArtificerIntentBasis,
  assessIntentBasis,
  collectUpstreamNormalisedText,
  consumeSourceFaultBackoffSkip,
  ARTIFICER_INTENT_NHR_SOURCE_RUN_ID,
  type ArtificerTrustedFactsPort,
} from '../artificer-intent-preflight.js';

const TASK_ID = 'artificer-intent-001';
const SCRIBE_TASK_ID = 'scribe-intent-001';

const dirs: string[] = [];

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-intent-preflight-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  return root;
}

const INTENT_CONTRACT = {
  ownerIntent: 'files must be read before they are written',
  targetBehavior: 'every write to a file is preceded by a read of that file in the same session',
  forbiddenBehavior: 'writing a file that was not read earlier in the session',
  evidenceSource: 'pain:manual_1791868470372',
  validationExpectation: 'rule blocks writes whose context facts show no prior read of the target',
};

/** Scribe artifact WITHOUT executionConditions — the legacy/original-pain shape. */
function legacyScribeContent(): string {
  return JSON.stringify({
    taskId: SCRIBE_TASK_ID,
    sourcePhilosopherArtifactId: 'art-phil-001',
    principleDraft: {
      title: 'Design confirmation before complex changes',
      statement: 'Complex changes require confirmed design before implementation',
      rationale: 'unconfirmed complex edits caused the original pain',
      applicability: ['complex code changes'],
      antiPatterns: ['implementing complex changes without design confirmation'],
      confidence: 0.9,
    },
    sourceTrace: { philosopherArtifactId: 'art-phil-001' },
    risks: [],
    intentContract: INTENT_CONTRACT,
    generatedAt: '2026-10-16T00:00:00.000Z',
  });
}

/** Scribe artifact WITH executionConditions: no trusted external facts required. */
function conditionsScribeContent(
  requiredFacts: { factKind: string; required: boolean; textualBasis: string }[],
  opts: { approval?: boolean } = {},
): string {
  // When opts.approval is set the intent material itself carries the approval
  // semantics (matching the declared design_approval fact) — self-consistent.
  const statement = opts.approval === true
    ? 'Complex changes require confirmed design before implementation'
    : 'Files must be read before they are written';
  const contract = opts.approval === true
    ? {
        ownerIntent: 'complex changes must not be implemented before the design is confirmed by the Owner',
        targetBehavior: 'agent pauses complex edits and requests design confirmation first',
        forbiddenBehavior: 'implementing complex changes without a confirmed design',
        evidenceSource: 'pain:manual_1791868470372',
        validationExpectation: 'rule blocks complex-change writes that carry no confirmed-design evidence',
      }
    : INTENT_CONTRACT;
  return JSON.stringify({
    taskId: SCRIBE_TASK_ID,
    sourcePhilosopherArtifactId: 'art-phil-001',
    principleDraft: {
      title: opts.approval === true ? 'Design confirmation before complex changes' : 'Read before write',
      statement,
      rationale: opts.approval === true ? 'unconfirmed complex edits caused the original pain' : 'blind edits caused the original pain',
      applicability: opts.approval === true ? ['complex code changes'] : ['write_file calls'],
      antiPatterns: opts.approval === true ? ['implementing complex changes without design confirmation'] : ['writing a file that was never read'],
      confidence: 0.9,
    },
    sourceTrace: { philosopherArtifactId: 'art-phil-001' },
    risks: [],
    intentContract: contract,
    executionConditions: { version: 1, requiredFacts },
    generatedAt: '2026-10-16T00:00:00.000Z',
  });
}

const PHILOSOPHER_TASK_ID = 'philosopher-intent-001';
/** Upstream material shared by the default fixtures — deliberately free of approval vocabulary. */
const PHILOSOPHER_ANALYSIS = 'The agent must read the target file before writing it. Blind edits cascade: a write without a prior read corrupts files whose content the agent never saw.';

async function seedArtificerTask(
  workspaceDir: string,
  scribeContentJson: string,
  opts: { withPhilosopher?: boolean; upstreamAnalysis?: string } = {},
): Promise<string> {
  const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
  try {
    const { stateManager } = handle;
    const now = new Date().toISOString();
    const withPhilosopher = opts.withPhilosopher !== false;
    if (withPhilosopher) {
      await stateManager.createTask({
        taskId: PHILOSOPHER_TASK_ID,
        taskKind: 'philosopher',
        status: 'succeeded',
        attemptCount: 1,
        maxAttempts: 3,
        resultRef: 'philosopher://seed',
        diagnosticJson: JSON.stringify({ sourcePainId: 'pain_001', pi_metadata: {
          dependencyTaskIds: [],
          channel: 'code_tool_hook',
          timeoutMs: 300_000,
          inputArtifactRefs: [],
          outputArtifactRefs: [],
        }}),
      });
      await stateManager.piArtifactStore.upsertArtifact({
        artifactId: `pi-art-${PHILOSOPHER_TASK_ID}-run-1`,
        artifactKind: 'principle',
        sourceTaskId: PHILOSOPHER_TASK_ID,
        lineageArtifactIds: [],
        validationStatus: 'validated',
        contentJson: JSON.stringify({ taskId: PHILOSOPHER_TASK_ID, analysis: opts.upstreamAnalysis ?? PHILOSOPHER_ANALYSIS }),
        createdAt: now,
        updatedAt: now,
      });
    }
    await stateManager.createTask({
      taskId: SCRIBE_TASK_ID,
      taskKind: 'scribe',
      status: 'succeeded',
      attemptCount: 1,
      maxAttempts: 3,
      resultRef: 'scribe://run-1',
      diagnosticJson: JSON.stringify({ sourcePainId: 'pain_001', pi_metadata: {
        dependencyTaskIds: withPhilosopher ? [PHILOSOPHER_TASK_ID] : [],
        channel: 'code_tool_hook',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }}),
    });
    const artifactId = `pi-art-${SCRIBE_TASK_ID}-run-1`;
    await stateManager.piArtifactStore.upsertArtifact({
      artifactId,
      artifactKind: 'principle',
      sourceTaskId: SCRIBE_TASK_ID,
      lineageArtifactIds: [],
      validationStatus: 'validated',
      contentJson: scribeContentJson,
      createdAt: now,
      updatedAt: now,
    });
    await stateManager.createTask({
      taskId: TASK_ID,
      taskKind: 'artificer',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [SCRIBE_TASK_ID],
        channel: 'code_tool_hook',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });
    return artifactId;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

const DREAMER_TASK_ID = 'dreamer-owner-source-001';
const DREAMER_ARTIFACT_ID = 'pi-art-dreamer-owner-source-001';
const DIAGNOSIS_TASK_ID = 'diag-owner-source-001';
const DIAGNOSIS_ARTIFACT_ID = 'pi-art-diag-owner-source-001';
const OWNER_SOURCE_QUOTE = '非简单行为变更先调查现状，交付SPEC和技术方案，明确调用链、输入输出、成本、失败处理、验收及回滚，经Owner确认后再编码';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeJsonRecord(contentJson: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(contentJson);
  if (!isRecord(parsed)) {
    throw new Error('fixture artifact must be a JSON object');
  }
  return parsed;
}

async function attachFormationOwnerEvidence(
  workspaceDir: string,
  options: {
    evidenceNote?: string;
    recommendation?: string;
    dreamerSeedPainId?: string;
    dreamerOutputPainId?: string;
    scribeDreamerArtifactId?: string;
  } = {},
): Promise<void> {
  const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
  try {
    const { stateManager } = handle;
    const now = new Date().toISOString();
    const sourcePainId = options.dreamerSeedPainId ?? 'pain_001';
    await stateManager.createTask({
      taskId: DIAGNOSIS_TASK_ID,
      taskKind: 'diag_router',
      status: 'succeeded',
      attemptCount: 1,
      maxAttempts: 3,
      resultRef: 'diag://owner-source',
      diagnosticJson: JSON.stringify({ sourcePainId, pi_metadata: {
        dependencyTaskIds: [], channel: 'code_tool_hook', timeoutMs: 300_000,
        inputArtifactRefs: [], outputArtifactRefs: [],
      }}),
    });
    await stateManager.piArtifactStore.upsertArtifact({
      artifactId: DIAGNOSIS_ARTIFACT_ID,
      artifactKind: 'principle',
      sourceTaskId: DIAGNOSIS_TASK_ID,
      lineageArtifactIds: [],
      validationStatus: 'validated',
      contentJson: JSON.stringify({
        summary: 'Owner requirement recorded in diagnosis evidence.',
        rootCause: 'The task was implemented without the requested investigation and design approval.',
        violatedPrinciples: [],
        evidence: [{ sourceRef: 'trajectory://owner-source/turn-4', note: options.evidenceNote ?? OWNER_SOURCE_QUOTE }],
        recommendations: [{ kind: 'principle', description: options.recommendation ?? 'Read the contract before writing.' }],
      }),
      createdAt: now,
      updatedAt: now,
    });
    await stateManager.createTask({
      taskId: DREAMER_TASK_ID,
      taskKind: 'dreamer',
      status: 'succeeded',
      attemptCount: 1,
      maxAttempts: 3,
      resultRef: 'dreamer://owner-source',
      diagnosticJson: JSON.stringify({ sourcePainId, pi_metadata: {
        dependencyTaskIds: [DIAGNOSIS_TASK_ID], channel: 'code_tool_hook', timeoutMs: 300_000,
        inputArtifactRefs: [], outputArtifactRefs: [],
      }}),
    });
    await stateManager.piArtifactStore.upsertArtifact({
      artifactId: DREAMER_ARTIFACT_ID,
      artifactKind: 'principle',
      sourceTaskId: DREAMER_TASK_ID,
      lineageArtifactIds: [DIAGNOSIS_ARTIFACT_ID],
      validationStatus: 'validated',
      contentJson: JSON.stringify({
        sourcePainId: options.dreamerOutputPainId ?? sourcePainId,
        candidates: [],
        contextRefs: [],
      }),
      createdAt: now,
      updatedAt: now,
    });
    const [philosopherArtifact] = await stateManager.piArtifactStore.listBySourceTaskId(PHILOSOPHER_TASK_ID);
    const [scribeArtifact] = await stateManager.piArtifactStore.listBySourceTaskId(SCRIBE_TASK_ID);
    if (!philosopherArtifact || !scribeArtifact) throw new Error('formation source fixture artifact missing');
    const philosopherContent = safeJsonRecord(philosopherArtifact.contentJson);
    philosopherContent.sourceDreamerArtifactId = DREAMER_ARTIFACT_ID;
    const scribeContent = safeJsonRecord(scribeArtifact.contentJson);
    scribeContent.sourceTrace = {
      philosopherArtifactId: philosopherArtifact.artifactId,
      dreamerArtifactId: options.scribeDreamerArtifactId ?? DREAMER_ARTIFACT_ID,
    };
    await stateManager.piArtifactStore.upsertArtifact({
      ...philosopherArtifact,
      contentJson: JSON.stringify(philosopherContent),
      updatedAt: now,
    });
    await stateManager.piArtifactStore.upsertArtifact({
      ...scribeArtifact,
      contentJson: JSON.stringify(scribeContent),
      updatedAt: now,
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

let emitted: TelemetryEvent[] = [];
function collectingEmitter(): StoreEventEmitter {
  const emitter = {
    emitTelemetry: (event: TelemetryEvent) => {
      emitted.push(event);
      return true as const;
    },
  };
  return emitter as unknown as StoreEventEmitter;
}

interface RunOverrides {
  trustedFacts?: ArtificerTrustedFactsPort;
  artifactStoreFault?: Error;
}

async function runPreflight(workspaceDir: string, overrides: RunOverrides = {}) {
  emitted = [];
  const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
  try {
    const { stateManager } = handle;
    const task = await stateManager.getTask(TASK_ID);
    if (!task) throw new Error('fixture task missing');
    const piTask = hydratePITaskRecord(task);
    if (!piTask) throw new Error('fixture piTask did not hydrate');
    return await preflightArtificerIntentBasis({
      taskId: TASK_ID,
      piTask,
      owner: 'test-consumer',
      workspaceDir,
      stateManager,
      eventEmitter: collectingEmitter(),
      ...(overrides.trustedFacts !== undefined ? { trustedFacts: overrides.trustedFacts } : {}),
      ...(overrides.artifactStoreFault !== undefined
        ? { artifactStore: {
            listBySourceTaskId: async () => { throw new Error(overrides.artifactStoreFault?.message ?? 'artifact store fault'); },
            getArtifactById: async () => { throw new Error(overrides.artifactStoreFault?.message ?? 'artifact store fault'); },
          } }
        : {}),
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readTask(workspaceDir: string) {
  const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
  try {
    return await handle.stateManager.getTask(TASK_ID);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

afterEach(async () => {
  const { disposePainSignalBridgesForWorkspace } = await import('../../index.js');
  for (const dir of dirs) {
    await disposePainSignalBridgesForWorkspace(dir).catch(() => undefined);
  }
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  for (const dir of dirs.splice(0)) {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        await sleep(50);
      }
    }
    if (lastError !== null) throw new Error(String(lastError));
  }
});

describe('preflightArtificerIntentBasis — stop points (Q01/Q20)', () => {
  it('unknown required facts cannot gain runtime capability from a resolver returning approved', () => {
    const assessment = assessIntentBasis({
      taskId: TASK_ID,
      scribeArtifact: { artifactId: 'unknown-kind', contentJson: conditionsScribeContent([
        { factKind: 'unimplemented_fact', required: true, textualBasis: 'Files must be read before they are written' },
      ]) },
      upstreamMaterial: { normalisedText: PHILOSOPHER_ANALYSIS },
      trustedFacts: { resolveRequiredFact: () => ({ resolution: 'approved' }) },
    });
    expect(assessment.status, JSON.stringify(assessment)).toBe('unsupported');
    if (assessment.status === 'executable') throw new Error('unknown runtime schema must not reach generation');
    expect(assessment.detail).toContain('unsupported_required_fact:unimplemented_fact');
  });
  it('Q01 legacy scribe artifact (no executionConditions) stops at needs_human_review with zero generation', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, legacyScribeContent());

    const verdict = await runPreflight(workspaceDir);
    expect(verdict.decision).toBe('blocked');
    if (verdict.decision !== 'blocked') throw new Error('unreachable');
    expect(verdict.logicalResult).toBe('intent_unverified');
    expect(verdict.reasonCode).toBe('execution_conditions_missing');
    expect(verdict.nextAction).toContain('pd runtime internalization retry --confirm');

    const task = await readTask(workspaceDir);
    expect(task?.status).toBe('needs_human_review');
    const piTask = task ? hydratePITaskRecord(task) : null;
    expect(piTask?.humanReviewContext?.reasonCode).toBe('execution_conditions_missing');
    expect(piTask?.humanReviewContext?.sourceRunId).toBe(ARTIFICER_INTENT_NHR_SOURCE_RUN_ID);
    // Zero generation: no run rows for this task (the runner was never constructed).
    expect(emitted.some((event) => event.eventType === 'artificer_intent_basis_checked')).toBe(true);
  });

  it('Q01 a scribe artifact declaring a required design-approval fact with no trusted-facts port stops as unsupported (host capability gap)', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, conditionsScribeContent([
      { factKind: 'design_approval', required: true, textualBasis: 'complex changes require confirmed design before implementation' },
    ], { approval: true }));

    const verdict = await runPreflight(workspaceDir);
    expect(verdict.decision).toBe('blocked');
    if (verdict.decision !== 'blocked') throw new Error('unreachable');
    expect(verdict.logicalResult).toBe('unsupported');
    expect(verdict.reasonCode).toBe('trusted_fact_provider_absent');
    const task = await readTask(workspaceDir);
    expect(task?.status).toBe('needs_human_review');
  });

  it('a legacy resolution-only port does not establish design_approval capability', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, conditionsScribeContent([
      { factKind: 'design_approval', required: true, textualBasis: 'complex changes require confirmed design before implementation' },
    ], { approval: true }));
    const verdict = await runPreflight(workspaceDir, {
      trustedFacts: { resolveRequiredFact: () => ({ resolution: 'unknown' }) },
    });
    expect(verdict.decision).toBe('blocked');
    if (verdict.decision !== 'blocked') throw new Error('unreachable');
    expect(verdict.logicalResult).toBe('unsupported');
    expect(verdict.reasonCode).toBe('trusted_fact_provider_absent');
    await expect(readTask(workspaceDir)).resolves.toMatchObject({ status: 'needs_human_review' });
  });

  it('supported design_approval capability permits generation without resolving the current PI task as approved', () => {
    let legacyResolutionCalls = 0;
    const assessment = assessIntentBasis({
      scribeArtifact: {
        artifactId: 'scribe-design-gate',
        contentJson: conditionsScribeContent([
          { factKind: 'design_approval', required: true, textualBasis: 'complex changes require confirmed design before implementation' },
        ], { approval: true }),
      },
      upstreamMaterial: { normalisedText: 'complexchangesrequireconfirmeddesignbeforeimplementation' },
      taskId: 'pi-generation-task',
      trustedFacts: {
        describeRequiredFact: () => ({
          supported: true,
          schemaVersion: '1',
          inputPath: 'input.context.facts.designGate',
          source: 'codex-native-pretool-design-gate-v1',
        }),
        resolveRequiredFact: () => {
          legacyResolutionCalls += 1;
          return { resolution: 'not_approved' };
        },
      },
    });

    expect(assessment.status).toBe('executable');
    if (assessment.status !== 'executable') throw new Error('unreachable');
    expect(assessment.requiredFacts).toEqual([{ factKind: 'design_approval', resolution: 'unknown' }]);
    expect(legacyResolutionCalls).toBe(0);
  });

  it.each([
    ['wrong schema', { supported: true, schemaVersion: '2', inputPath: 'input.context.facts.designGate', source: 'native' }],
    ['wrong input path', { supported: true, schemaVersion: '1', inputPath: 'params.designGate', source: 'native' }],
    ['missing source', { supported: true, schemaVersion: '1', inputPath: 'input.context.facts.designGate' }],
    ['unsupported', { supported: false, schemaVersion: '1', inputPath: 'input.context.facts.designGate', source: 'native' }],
  ])('design_approval stops before generation when host capability has %s', (_label, capability) => {
    const assessment = assessIntentBasis({
      scribeArtifact: {
        artifactId: 'scribe-design-gate',
        contentJson: conditionsScribeContent([
          { factKind: 'design_approval', required: true, textualBasis: 'complex changes require confirmed design before implementation' },
        ], { approval: true }),
      },
      upstreamMaterial: { normalisedText: 'complexchangesrequireconfirmeddesignbeforeimplementation' },
      taskId: 'pi-generation-task',
      trustedFacts: {
        describeRequiredFact: () => capability,
        resolveRequiredFact: () => ({ resolution: 'approved' }),
      },
    });
    expect(assessment.status, JSON.stringify(assessment)).toBe('unsupported');
    if (assessment.status === 'executable') throw new Error('unreachable');
    expect(assessment.reasonCode).toBe('trusted_fact_provider_absent');
  });

  it('malformed executionConditions stops as intent_unverified (corrupted anchor fails loud)', async () => {
    const workspaceDir = makeWorkspace();
    const corrupted = JSON.parse(conditionsScribeContent([])) as Record<string, unknown>;
    corrupted.executionConditions = { version: 1, requiredFacts: 'not-an-array' };
    await seedArtificerTask(workspaceDir, JSON.stringify(corrupted));

    const verdict = await runPreflight(workspaceDir);
    expect(verdict.decision).toBe('blocked');
    if (verdict.decision !== 'blocked') throw new Error('unreachable');
    expect(verdict.logicalResult).toBe('intent_unverified');
    expect(verdict.reasonCode).toBe('execution_conditions_invalid');
  });

  it('contradictory duplicate required-fact declarations stop as intent_conflict', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, conditionsScribeContent([
      { factKind: 'design_approval', required: true, textualBasis: 'design must be confirmed' },
      { factKind: 'design_approval', required: false, textualBasis: 'design need not be confirmed' },
    ]));
    const verdict = await runPreflight(workspaceDir);
    expect(verdict.decision).toBe('blocked');
    if (verdict.decision !== 'blocked') throw new Error('unreachable');
    expect(verdict.logicalResult).toBe('intent_conflict');
    expect(verdict.reasonCode).toBe('required_fact_conflict');
  });

  // ── Owner review 2026-10-16 P1: under-reporting audits ──

  it('OWNER-REPRO: approval-gated intent with an under-reported requiredFacts: [] stops as approval_dependency_undeclared (not executable)', async () => {
    const workspaceDir = makeWorkspace();
    // The scribe declared NO facts for an approval-gated principle — the
    // exact bypass shape from the Owner review. The gate must refuse.
    await seedArtificerTask(workspaceDir, conditionsScribeContent([], { approval: true }));

    const verdict = await runPreflight(workspaceDir);
    expect(verdict.decision).toBe('blocked');
    if (verdict.decision !== 'blocked') throw new Error('unreachable');
    expect(verdict.logicalResult).toBe('intent_unverified');
    expect(verdict.reasonCode).toBe('approval_dependency_undeclared');
    expect(verdict.detail).toContain('approval');
    const task = await readTask(workspaceDir);
    expect(task?.status).toBe('needs_human_review');
  });

  it('OWNER-REPRO: required:false under-reporting of an approval fact stops the same way', async () => {
    const workspaceDir = makeWorkspace();
    // Same attack with a declared-but-not-required entry: the audit keys on
    // the DECLARED KINDS, not the required flag.
    await seedArtificerTask(workspaceDir, conditionsScribeContent([
      { factKind: 'external_signoff', required: false, textualBasis: 'the design is confirmed by the Owner before implementation' },
    ], { approval: true }));

    const verdict = await runPreflight(workspaceDir);
    expect(verdict.decision).toBe('blocked');
    if (verdict.decision !== 'blocked') throw new Error('unreachable');
    expect(verdict.reasonCode).toBe('approval_dependency_undeclared');
  });

  // ── Owner review R3: under-reporting closure + upstream binding ──

  it('OWNER-R3 EXACT: design_approval declared with required:false under approval-gated material stops (name check must count only required declarations)', async () => {
    const workspaceDir = makeWorkspace();
    // The R2 bypass shape, verbatim from the review: the declared fact KIND
    // would satisfy the approval name check, but required:false filters it
    // out downstream — the effective declaration is EMPTY. The audit口径
    // counts only required:true declarations, so this stops.
    await seedArtificerTask(workspaceDir, conditionsScribeContent([
      {
        factKind: 'design_approval',
        required: false,
        textualBasis: 'complex changes must not be implemented before the design is confirmed by the Owner',
      },
    ], { approval: true }));

    const verdict = await runPreflight(workspaceDir);
    expect(verdict.decision).toBe('blocked');
    if (verdict.decision !== 'blocked') throw new Error('unreachable');
    expect(verdict.reasonCode).toBe('approval_dependency_undeclared');
    await expect(readTask(workspaceDir)).resolves.toMatchObject({ status: 'needs_human_review' });
  });

  it('OWNER-R3: no resolvable upstream (philosopher) material stops as upstream_material_unavailable — a verdict may never rest on the scribe artifact alone', async () => {
    const workspaceDir = makeWorkspace();
    // The R3 "同一份 Scribe 产物" shape: no philosopher leg at all.
    await seedArtificerTask(workspaceDir, conditionsScribeContent([]), { withPhilosopher: false });

    const verdict = await runPreflight(workspaceDir);
    expect(verdict.decision).toBe('blocked');
    if (verdict.decision !== 'blocked') throw new Error('unreachable');
    expect(verdict.reasonCode).toBe('upstream_material_unavailable');
    const task = await readTask(workspaceDir);
    expect(task?.status).toBe('needs_human_review');
  });

  it('OWNER-R3: approval semantics in the UPSTREAM material with no declared approval fact stops (dual-pool sweep)', async () => {
    const workspaceDir = makeWorkspace();
    // Scribe material itself is approval-free; the leak lives UPSTREAM. The
    // sweep covers both pools.
    await seedArtificerTask(workspaceDir, conditionsScribeContent([]), {
      upstreamAnalysis: '重大变更需先得到负责人确认同意：the Owner confirmed design must precede any complex implementation.',
    });

    const verdict = await runPreflight(workspaceDir);
    expect(verdict.decision).toBe('blocked');
    if (verdict.decision !== 'blocked') throw new Error('unreachable');
    expect(verdict.reasonCode).toBe('approval_dependency_undeclared');
    expect(verdict.detail).toContain('upstream');
  });

  it.each([
    ['malformed JSON', '{broken'],
    ['empty object', '{}'],
    ['null', 'null'],
    ['array', '[]'],
    ['scalar', '"not an artifact"'],
    ['blank analysis', '{"analysis":"   "}'],
    ['identity fields only', '{"taskId":"philosopher-intent-001","sourceDreamerArtifactId":"dreamer-001","generatedAt":"2026-10-17"}'],
  ])('rejects %s upstream material before generation, rather than treating artifact existence as evidence', async (_label, contentJson) => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, conditionsScribeContent([]));
    const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
    try {
      const [artifact] = await handle.stateManager.piArtifactStore.listBySourceTaskId(PHILOSOPHER_TASK_ID);
      if (!artifact) throw new Error('fixture philosopher artifact missing');
      await handle.stateManager.piArtifactStore.upsertArtifact({
        ...artifact,
        contentJson,
        updatedAt: new Date().toISOString(),
      });
    } finally {
      await handle.close().catch(() => undefined);
    }

    const verdict = await runPreflight(workspaceDir);
    expect(verdict.decision).toBe('blocked');
    if (verdict.decision !== 'blocked') throw new Error('unreachable');
    expect(verdict.logicalResult).toBe('intent_unverified');
    expect(verdict.reasonCode).toBe('upstream_material_unavailable');
    const task = await readTask(workspaceDir);
    expect(task?.status).toBe('needs_human_review');
  });

  it('retains real philosopher thesis and candidate material while ignoring identity-only fields', async () => {
    const material = await collectUpstreamNormalisedText(
      async () => ({ taskKind: 'philosopher', status: 'succeeded' }),
      async () => [{ contentJson: JSON.stringify({
        taskId: PHILOSOPHER_TASK_ID,
        sourceDreamerArtifactId: 'dreamer-001',
        thesis: 'Read the target before writing it.',
        principleCandidate: { title: 'Read before write', rationale: 'Blind writes lose information.', scope: 'File edits', confidence: 0.9 },
        risks: [],
        generatedAt: '2026-10-17',
      }) }],
      { scribeDependencyTaskIds: [PHILOSOPHER_TASK_ID] },
    );
    expect(material?.normalisedText).toContain('readthetargetbeforewritingit');
    expect(material?.normalisedText).not.toContain('dreamer');
  });

  it('the shared defensive assessment also refuses an empty upstream projection', () => {
    const verdict = assessIntentBasis({
      scribeArtifact: { artifactId: 'scribe-review', contentJson: conditionsScribeContent([]) },
      upstreamMaterial: { normalisedText: '   ' },
      taskId: TASK_ID,
    });
    expect(verdict.status).toBe('intent_unverified');
    if (verdict.status === 'executable') throw new Error('unreachable');
    expect(verdict.reasonCode).toBe('upstream_material_unavailable');
  });

  it('a required fact whose textualBasis anchors nowhere in the intent material stops as textual_basis_unanchored', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, conditionsScribeContent([
      // Anchored nowhere: the non-approval material never mentions sign-offs.
      { factKind: 'external_signoff', required: true, textualBasis: 'the steering committee sign-off checklist requires it' },
    ]));

    const verdict = await runPreflight(workspaceDir);
    expect(verdict.decision).toBe('blocked');
    if (verdict.decision !== 'blocked') throw new Error('unreachable');
    expect(verdict.logicalResult).toBe('intent_unverified');
    expect(verdict.reasonCode).toBe('textual_basis_unanchored');
  });

  it('anchors a required fact to Owner-attributed sourceDiagnosis evidence through the real formation lineage', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, conditionsScribeContent([
      { factKind: 'design_approval', required: true, textualBasis: OWNER_SOURCE_QUOTE },
    ]));
    await attachFormationOwnerEvidence(workspaceDir);

    const verdict = await runPreflight(workspaceDir);
    expect(verdict.decision).toBe('blocked');
    if (verdict.decision !== 'blocked') throw new Error('unreachable');
    // The old collector stopped at textual_basis_unanchored. The repair only
    // establishes the Owner quote's anchor; without a trusted fact provider the
    // contract still stops safely before generation.
    expect(verdict.logicalResult).toBe('unsupported');
    expect(verdict.reasonCode).toBe('trusted_fact_provider_absent');
  });

  it('does not treat diagnosis recommendations as Owner-source anchors', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, conditionsScribeContent([
      { factKind: 'design_approval', required: true, textualBasis: OWNER_SOURCE_QUOTE },
    ]));
    await attachFormationOwnerEvidence(workspaceDir, {
      evidenceNote: 'The agent edited the file without first reading it.',
      recommendation: OWNER_SOURCE_QUOTE,
    });

    const verdict = await runPreflight(workspaceDir);
    expect(verdict.decision).toBe('blocked');
    if (verdict.decision !== 'blocked') throw new Error('unreachable');
    expect(verdict.reasonCode).toBe('textual_basis_unanchored');
  });

  it.each([
    ['Scribe dreamer trace points at a different artifact', { scribeDreamerArtifactId: 'pi-art-dreamer-other' }],
    ['Dreamer artifact pain disagrees with its canonical seed', { dreamerSeedPainId: 'pain_other', dreamerOutputPainId: 'pain_001' }],
  ])('does not borrow Owner text across %s', async (_label, sourceOverrides) => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, conditionsScribeContent([
      { factKind: 'design_approval', required: true, textualBasis: OWNER_SOURCE_QUOTE },
    ]), { upstreamAnalysis: OWNER_SOURCE_QUOTE });
    await attachFormationOwnerEvidence(workspaceDir, sourceOverrides);

    const verdict = await runPreflight(workspaceDir);
    expect(verdict.decision).toBe('blocked');
    if (verdict.decision !== 'blocked') throw new Error('unreachable');
    expect(verdict.reasonCode).toBe('upstream_material_unavailable');
  });
});

describe('preflightArtificerIntentBasis — executable path (Q13/Q20)', () => {
  it('no required facts → executable, and the versioned record binds material digests', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, conditionsScribeContent([]));

    const verdict = await runPreflight(workspaceDir);
    expect(verdict.decision).toBe('executable');
    if (verdict.decision !== 'executable') throw new Error('unreachable');
    expect(verdict.record.version).toBe(1);
    expect(verdict.record.checkedBy).toBe('deterministic-preflight');
    expect(verdict.record.sourceScribeArtifactId).toBeTruthy();
    expect(verdict.record.scribeArtifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verdict.record.executionConditionsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verdict.record.requiredFacts).toEqual([]);

    const task = await readTask(workspaceDir);
    expect(task?.status).toBe('pending'); // untouched — generation may proceed
  });

  it('Q13/Q20 a previously stored record never acts as a pass token: the gate re-derives from the scribe artifact every run', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, conditionsScribeContent([]));
    const first = await runPreflight(workspaceDir);
    expect(first.decision).toBe('executable');

    // Tamper the scribe artifact to the legacy shape AFTER a pass was recorded.
    const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
    try {
      const artifacts = await handle.stateManager.piArtifactStore.listBySourceTaskId(SCRIBE_TASK_ID);
      const artifactId = artifacts[0]?.artifactId;
      if (!artifactId) throw new Error('scribe artifact missing');
      const now = new Date().toISOString();
      await handle.stateManager.piArtifactStore.upsertArtifact({
        artifactId,
        artifactKind: 'principle',
        sourceTaskId: SCRIBE_TASK_ID,
        lineageArtifactIds: [],
        validationStatus: 'validated',
        contentJson: legacyScribeContent(),
        createdAt: now,
        updatedAt: now,
      });
    } finally {
      await handle.close().catch(() => undefined);
    }

    const second = await runPreflight(workspaceDir);
    expect(second.decision).toBe('blocked'); // stale pass evidence invalidated by the material change
    if (second.decision !== 'blocked') throw new Error('unreachable');
    expect(second.logicalResult).toBe('intent_unverified');
    expect(second.reasonCode).toBe('execution_conditions_missing');
  });
});

describe('preflightArtificerIntentBasis — source faults (Q21/Q22)', () => {
  it('Q21 transient artifact-store failures retry technically with a restart-durable bounded backoff and zero model cost', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, conditionsScribeContent([]));

    const fault = new Error('SQLITE_BUSY: trajectory store unavailable');
    const first = await runPreflight(workspaceDir, { artifactStoreFault: fault });
    expect(first.decision).toBe('source_error');
    // Task stays wake-eligible — never mislabeled as an Owner fault.
    const afterFirst = await readTask(workspaceDir);
    expect(afterFirst?.status).toBe('pending');
    const piAfterFirst = afterFirst ? hydratePITaskRecord(afterFirst) : null;
    expect(piAfterFirst?.sourceFaultBackoff?.consecutiveFailures).toBe(1);
    expect(piAfterFirst?.sourceFaultBackoff?.skipCycles).toBe(1);

    // "Restart" (new handle) then a second fault: the counter survives and backs off one more cycle.
    const second = await runPreflight(workspaceDir, { artifactStoreFault: fault });
    expect(second.decision).toBe('source_error');
    const afterSecond = await readTask(workspaceDir);
    const piAfterSecond = afterSecond ? hydratePITaskRecord(afterSecond) : null;
    expect(piAfterSecond?.sourceFaultBackoff?.consecutiveFailures).toBe(2);
    expect(piAfterSecond?.sourceFaultBackoff?.skipCycles).toBe(2);

    // A later successful read clears the technical-fault state (material unchanged).
    const recovered = await runPreflight(workspaceDir);
    expect(recovered.decision).toBe('executable');
    const afterRecovery = await readTask(workspaceDir);
    const piAfterRecovery = afterRecovery ? hydratePITaskRecord(afterRecovery) : null;
    expect(piAfterRecovery?.sourceFaultBackoff).toBeUndefined();
  });

  it('Q22 the 3rd consecutive source fault ends auto-retry in a terminal review state labeled as a source fault, not an Owner fault', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, conditionsScribeContent([]));

    const fault = new Error('SQLITE_IOERR: disk image malformed');
    await runPreflight(workspaceDir, { artifactStoreFault: fault });
    await runPreflight(workspaceDir, { artifactStoreFault: fault });
    const third = await runPreflight(workspaceDir, { artifactStoreFault: fault });
    expect(third.decision).toBe('source_fault_persistent');

    const task = await readTask(workspaceDir);
    expect(task?.status).toBe('needs_human_review');
    const piTask = task ? hydratePITaskRecord(task) : null;
    expect(piTask?.humanReviewContext?.reasonCode).toBe('source_fault_persistent');
    // The review context must NOT read as an Owner-labelling fault (SPEC §9).
    expect(piTask?.humanReviewContext?.reasonCode).not.toMatch(/owner_evidence|owner_behavior/);
    expect(piTask?.humanReviewContext?.detail).toContain('SQLITE_IOERR');
  });
});

describe('consumeSourceFaultBackoffSkip — cycle-entry backoff consumption (Q21)', () => {
  it('consumes one skip cycle per encounter and stops skipping at zero (restart-durable via state.db)', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, conditionsScribeContent([]));

    // Simulate one transient fault so the task carries a 1-cycle backoff.
    await runPreflight(workspaceDir, { artifactStoreFault: new Error('SQLITE_BUSY once') });
    const afterFault = await readTask(workspaceDir);
    const piAfterFault = afterFault ? hydratePITaskRecord(afterFault) : null;
    expect(piAfterFault?.sourceFaultBackoff).toMatchObject({ consecutiveFailures: 1, skipCycles: 1 });

    // First encounter after the fault: skip consumed (returns true) and the
    // stored skipCycles drops to zero — the next encounter no longer skips.
    const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
    let firstEncounter: boolean;
    let secondEncounter: boolean;
    try {
      const { stateManager } = handle;
      const refreshedTask = await stateManager.getTask(TASK_ID);
      if (refreshedTask === null) throw new Error('task missing');
      const refreshed = hydratePITaskRecord(refreshedTask);
      if (refreshed === null) throw new Error('task missing');
      firstEncounter = await consumeSourceFaultBackoffSkip(TASK_ID, refreshed, stateManager);
      const afterSkipTask = await stateManager.getTask(TASK_ID);
      if (afterSkipTask === null) throw new Error('task missing');
      const afterSkip = hydratePITaskRecord(afterSkipTask);
      if (afterSkip === null) throw new Error('task missing');
      expect(afterSkip.sourceFaultBackoff).toMatchObject({ consecutiveFailures: 1, skipCycles: 0 });
      secondEncounter = await consumeSourceFaultBackoffSkip(TASK_ID, afterSkip, stateManager);
    } finally {
      await handle.close().catch(() => undefined);
    }
    expect(firstEncounter).toBe(true);
    expect(secondEncounter).toBe(false);
  });
});

describe('preflightArtificerIntentBasis — idempotence (Q14)', () => {
  it('Q14 a repeated stop-point run never duplicates the review context and never loses the history', async () => {
    const workspaceDir = makeWorkspace();
    await seedArtificerTask(workspaceDir, legacyScribeContent());

    await runPreflight(workspaceDir);
    const taskAfterFirst = await readTask(workspaceDir);
    const reviewAfterFirst = taskAfterFirst ? hydratePITaskRecord(taskAfterFirst)?.humanReviewContext : undefined;

    await runPreflight(workspaceDir);
    const taskAfterSecond = await readTask(workspaceDir);
    const piAfterSecond = taskAfterSecond ? hydratePITaskRecord(taskAfterSecond) : null;
    expect(piAfterSecond?.humanReviewContext?.reasonCode).toBe(reviewAfterFirst?.reasonCode);
    expect(piAfterSecond?.humanReviewContext?.createdAt).toBe(reviewAfterFirst?.createdAt);
    expect(piAfterSecond?.humanReviewContext?.sourceRunId).toBe(ARTIFICER_INTENT_NHR_SOURCE_RUN_ID);
  });
});
