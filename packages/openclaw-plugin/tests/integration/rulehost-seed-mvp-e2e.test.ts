/**
 * PRI-492 — RuleHost seed-MVP production E2E chain.
 *
 * Exercises the FULL production path with only the LLM adapter mocked
 * (ScriptedAdapter pattern). No artifacts or activations are inserted
 * directly into the DB — the chain goes through real runners → real
 * validators → real approval queue → real dispatcher → real RuleHostWriter
 * → real RuleHost.
 *
 * Chain:
 *   pain + Owner example IDs
 *   → BehaviorExamplePackAssembler (real)
 *   → Dreamer → Philosopher → Scribe → Artificer (v2) → Evaluator (real runners)
 *   → runAdversarialLoop (real)
 *   → v2 rule artifact (requiresContextVersion, ruleContext cases, evidenceRefs)
 *   → ApprovalQueue.approve + ApprovalCompletionService.completeApproval (real)
 *   → ActivationDispatcher → RuleHostWriter (real, capturing)
 *   → shadow activation (SqliteActivationStateStore)
 *   → RuleHost.evaluateDetailed — shadow observation (would-block recorded)
 *   → promote (SqliteActivationStateStore.promoteActivation)
 *   → RuleHost.evaluateDetailed — live block + prior-read allow
 *   → flag-off suspension (skippedActivations with suspended_by_flag reason)
 *   → deactivate (no enforcement)
 *
 * ERR checklist (addressed in comments below):
 *   - ERR-001: All parsed JSON/contentJson treated as `unknown`, no `as` bypass
 *   - ERR-002: All degradation paths include reason + nextAction
 *   - ERR-024/025: Real production path (runners, validators, approval, dispatcher, RuleHost)
 *   - ERR-026: Production schema (SqliteConnection), not hand-written DDL
 *   - ERR-088: Every allow/no-op assertion has a positive path marker
 */
 
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

import {
  RuntimeStateManager,
  StoreEventEmitter,
  DreamerRunner,
  DefaultDreamerValidator,
  PhilosopherRunner,
  DefaultPhilosopherValidator,
  ScribeRunner,
  DefaultScribeValidator,
  ArtificerRunner,
  DefaultArtificerValidator,
  EvaluatorRunner,
  DefaultEvaluatorValidator,
  runAdversarialLoop,
  createPITaskDiagnosticJson,
  SqliteApprovalQueueStore,
  ApprovalQueue,
  SqliteActivationStateStore,
  ActivationDispatcher,
  RuleHostWriter,
  PromptWriter,
  DeferArchiveWriter,
  createProductionGateDeps,
  ApprovalCompletionService,
  getChannelRiskLevel,
  SqliteConnection,
} from '@principles/core/runtime-v2';
import type {
  PDRuntimeAdapter,
  RunHandle,
  RunStatus,
  PIArtifactStore,
  RuntimeCapabilities,
  RuntimeHealth,
  RuntimeArtifactRef,
  ContextItem,
  StructuredRunOutput,
  StartRunInput,
  BehaviorExamplePack,
  RuleHostInput,
  RuleContextV2,
  PIArtifactSnapshot,
  WriterResult,
  WriterInput,
  ActivationActor,
  ApprovalEnqueueInput,
} from '@principles/core/runtime-v2';

import { RuleHost } from '../../src/core/rule-host.js';
import { TrajectoryRegistry } from '../../src/core/trajectory.js';
import { BehaviorExamplePackAssembler } from '../../src/core/behavior-example-pack-assembler.js';

// ── ERR refs considered ────────────────────────────────────────────────────
// ERR-001: parsed contentJson treated as `unknown`; type guards used below
// ERR-002: every degradation path (shadow skip, flag-off skip) carries reason + nextAction
// ERR-024/025: real production runners + validators + approval + dispatcher + RuleHost
// ERR-026: production SqliteConnection schema, no hand-written DDL for activations/artifacts
// ERR-088: positive path markers — shadowDecisions populated, skippedActivations carries reason

// ── Rule code: read-before-write (v2 context-aware) ─────────────────────────
//
// Behavior:
//   - context undefined OR history.status === 'unavailable' → allow (fail-soft)
//   - write_file + priorReadOfTarget === 'no' → block (read-before-write required)
//   - otherwise → allow
//
// This rule reads input.context (v2 feature). When flag is OFF, gate.ts sets
// context = undefined, and the rule falls through to allow (v1 zero-change).
const RULE_CODE = `
function evaluate(input, helpers) {
  // PRI-634: v1 action-only risk-path check must dominate any v2 context
  // (spec §7.4 / PRI-485 v2-combination adversarial case). In golden-trace
  // replay the sandbox does not recompute workspace.isRiskPath, so the rule
  // carries the literal risk-path guard itself — same shape as the v1 rule
  // set (cf. production-host-runtime.test.ts '/etc/passwd' guard).
  var targetPath = input.action.paramsSummary && input.action.paramsSummary.path;
  if (targetPath === '/etc/passwd') {
    return { decision: 'block', matched: true, reason: 'R_RBW_001: risk path blocked' };
  }
  if (!input.context || input.context.history.status === 'unavailable') {
    return { decision: 'allow', matched: false, reason: 'R_RBW_001: context unavailable, fail-soft' };
  }
  if (input.action.toolName === 'write_file' && input.context.facts.priorReadOfTarget === 'no') {
    return { decision: 'block', matched: true, reason: 'R_RBW_001: read before write required' };
  }
  return { decision: 'allow', matched: false, reason: 'R_RBW_001: ok' };
}
var meta = { name: 'read-before-write', version: '1', ruleId: 'R_RBW_001', coversCondition: 'write' };
`;

// ── ScriptedAdapter (only LLM mock) ─────────────────────────────────────────
// Routes by taskId prefix to the appropriate factory function. The artificer
// factory closes over the BehaviorExamplePack so it can echo evidenceRefs +
// ruleContext per golden trace case (validated by ArtificerRunner).

type StageFactory = (taskId: string, priorArtifactId?: string) => unknown;
type EvaluatorFactory = (taskId: string, artificerArtifactId: string) => unknown;

class ScriptedAdapter implements PDRuntimeAdapter {
  readonly startRunCalls: { taskId: string }[] = [];
  readonly startRunInputs = new Map<string, StartRunInput>();
  artifactStore: PIArtifactStore | null = null;

  constructor(
    private readonly factories: {
      dreamer: StageFactory;
      philosopher: StageFactory;
      scribe: StageFactory;
      artificer: StageFactory;
      evaluator: EvaluatorFactory;
    },
  ) {}

  private kindFor(taskId: string): 'dreamer' | 'philosopher' | 'scribe' | 'artificer' | 'evaluator' {
    if (taskId.startsWith('dreamer')) return 'dreamer';
    if (taskId.includes('philosopher')) return 'philosopher';
    if (taskId.includes('scribe')) return 'scribe';
    if (taskId.includes('artificer')) return 'artificer';
    return 'evaluator';
  }

  private async priorArtifactId(priorKind: string): Promise<string | undefined> {
    const calls = this.startRunCalls.filter((c) => this.kindFor(c.taskId) === priorKind);
    const last = calls[calls.length - 1];
    if (!last || !this.artifactStore) return undefined;
    const arts = await this.artifactStore.listBySourceTaskId(last.taskId);
    return arts[0]?.artifactId;
  }

  async startRun(input: StartRunInput): Promise<RunHandle> {
    this.startRunCalls.push({ taskId: input.taskRef.taskId });
    const runId = `run-${input.taskRef.taskId}`;
    this.startRunInputs.set(runId, input);
    return { runId, runtimeKind: 'test-double', startedAt: new Date().toISOString() };
  }

  async pollRun(_runId: string): Promise<RunStatus> {
    return { status: 'succeeded', runId: 'run-x' };
  }

  async fetchOutput(runId: string): Promise<StructuredRunOutput | null> {
    const taskId = runId.replace(/^run-/, '');
    const kind = this.kindFor(taskId);
    let payload: unknown;
    if (kind === 'dreamer') {
      payload = this.factories.dreamer(taskId);
    } else if (kind === 'philosopher') {
      payload = this.factories.philosopher(taskId, await this.priorArtifactId('dreamer'));
    } else if (kind === 'scribe') {
      payload = this.factories.scribe(taskId, await this.priorArtifactId('philosopher'));
    } else if (kind === 'artificer') {
      payload = this.factories.artificer(taskId, await this.priorArtifactId('scribe'));
    } else {
      let artificerArtifactId = await this.priorArtifactId('artificer');
      if (!artificerArtifactId) {
        const inputPayload = this.startRunInputs.get(runId)?.inputPayload;
        if (typeof inputPayload === 'string') {
          // ERR-001: parsed JSON treated as unknown, no `as` bypass (rc-2)
          const parsed: unknown = JSON.parse(inputPayload);
          if (isRecord(parsed) && Object.hasOwn(parsed, 'sourceArtificerArtifactId')) {
            const candidate = parsed['sourceArtificerArtifactId'];
            if (typeof candidate === 'string') artificerArtifactId = candidate;
          }
        }
      }
      payload = this.factories.evaluator(taskId, requireLineage(artificerArtifactId, 'sourceArtificerArtifactId'));
    }
    return { runId, payload };
  }

  async cancelRun(_runId: string): Promise<void> {
    /* noop */
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      supportsStructuredJsonOutput: false,
      supportsToolUse: false,
      supportsWorkingDirectory: false,
      supportsModelSelection: false,
      supportsLongRunningSessions: false,
      supportsCancellation: false,
      supportsArtifactWriteBack: false,
      supportsConcurrentRuns: false,
      supportsStreaming: false,
    };
  }

  async healthCheck(): Promise<RuntimeHealth> {
    return { healthy: true, degraded: false, warnings: [], lastCheckedAt: new Date().toISOString() };
  }

  async fetchArtifacts(_runId: string): Promise<RuntimeArtifactRef[]> {
    return [];
  }

  async appendContext(_runId: string, _items: ContextItem[]): Promise<void> {
    /* noop */
  }

  async refreshCapabilities(): Promise<RuntimeCapabilities> {
    return this.getCapabilities();
  }

  kind(): 'test-double' {
    return 'test-double';
  }
}

// ── Output factories ─────────────────────────────────────────────────────────

function requireLineage(id: string | undefined, field: string): string {
  if (!id) throw new Error(`missing required lineage field: ${field}`);
  return id;
}

function dreamerOut(taskId: string, painId: string): unknown {
  return {
    valid: true,
    taskId,
    candidates: [
      {
        candidateIndex: 0,
        badDecision: 'Wrote without prior read',
        betterDecision: 'Require read before write',
        rationale: 'Prevents blind edits',
        confidence: 0.85,
        riskLevel: 'low' as const,
        strategicPerspective: 'safety',
      },
    ],
    sourcePainId: painId,
    contextRefs: [],
    generatedAt: new Date().toISOString(),
  };
}

function philosopherOut(taskId: string, priorId?: string): unknown {
  return {
    taskId,
    sourceDreamerArtifactId: requireLineage(priorId, 'sourceDreamerArtifactId'),
    thesis: 'Read before write is required',
    principleCandidate: {
      title: 'Read before write',
      rationale: 'Prevents blind edits to unread files',
      scope: 'write ops',
      confidence: 0.9,
    },
    risks: [],
    generatedAt: new Date().toISOString(),
  };
}

function scribeOut(taskId: string, priorId?: string): unknown {
  return {
    taskId,
    sourcePhilosopherArtifactId: requireLineage(priorId, 'sourcePhilosopherArtifactId'),
    principleDraft: {
      title: 'Read before write',
      statement: 'Writes to files without a prior read in the same session must be blocked.',
      rationale: 'Prevents blind edits',
      applicability: ['write_file'],
      antiPatterns: ['Hardcoded allow'],
      confidence: 0.9,
    },
    sourceTrace: { philosopherArtifactId: requireLineage(priorId, 'sourceTrace.philosopherArtifactId') },
    risks: [],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * v2 artificer factory — closes over the BehaviorExamplePack so it can echo
 * evidenceRefs + ruleContext per golden trace case. The ArtificerRunner's
 * validateContextModeOutput enforces that protected fields (kind, toolName,
 * params, expectedDecision, ruleContext) match the pack exactly.
 */
function artificerV2Factory(pack: BehaviorExamplePack): StageFactory {
  return (taskId: string, priorId?: string): unknown => {
    return {
      taskId,
      sourceScribeArtifactId: requireLineage(priorId, 'sourceScribeArtifactId'),
      implementationPlan: {
        summary: 'Block writes without prior read',
        targetSurface: 'rule-host',
        changes: ['matcher'],
        tests: ['unit'],
        rolloutNotes: ['shadow'],
        confidence: 0.85,
      },
      implementationCode: RULE_CODE,
      implementationSummary: 'Read-before-write rule (v2 context-aware)',
      // Echo the pack's cases verbatim — protected fields must match exactly.
      goldenTraceCases: [pack.sourceNegativeCase, ...pack.positiveCounterexamples],
      affectedTools: ['write_file'],
      evidenceRefs: pack.evidenceRefs,
      requiresContextVersion: 2,
      sourceTrace: { scribeArtifactId: requireLineage(priorId, 'sourceTrace.scribeArtifactId') },
      risks: [],
      generatedAt: new Date().toISOString(),
    };
  };
}

function evaluatorApproved(taskId: string, artificerArtifactId: string): unknown {
  return {
    taskId,
    sourceArtificerArtifactId: artificerArtifactId,
    evaluation: {
      decision: 'approved',
      summary: 'approved',
      score: 0.9,
      strengths: [],
      concerns: [],
      requiredChanges: [],
    },
    sourceTrace: { artificerArtifactId },
    risks: [],
    generatedAt: new Date().toISOString(),
    codeReview: {
      intentConsistency: { aligned: true, explanation: 'ok' },
      scopePrecision: { verdict: 'precise' as const, explanation: 'ok' },
      traceCoverage: { sufficient: true, gaps: [], explanation: 'ok' },
    },
    adversarialCases: [],
    adversarialResult: { passed: true, failedCases: [] },
  };
}

// ── CapturingRuleHostWriter ──────────────────────────────────────────────────
//
// Wraps the real RuleHostWriter to capture the activate() result for the
// negative assertion (acceptance criterion 9). The writer delegates to the
// real production activate() — it does NOT bypass any production logic.
class CapturingRuleHostWriter extends RuleHostWriter {
  public capturedResult: WriterResult | null = null;

  async activate(input: WriterInput, artifact: PIArtifactSnapshot): Promise<WriterResult> {
    const result = await super.activate(input, artifact);
    this.capturedResult = result;
    return result;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildRuleHostInput(toolName: string, filePath: string, context?: RuleContextV2): RuleHostInput {
  return {
    action: {
      toolName,
      normalizedPath: filePath,
      paramsSummary: { file_path: filePath },
    },
    workspace: { isRiskPath: false },
    session: { sessionId: 'pri492-e2e-session', currentGfi: 0 },
    evolution: { epTier: 1 },
    derived: { estimatedLineChanges: 10, bashRisk: 'safe' as const },
    ...(context ? { context } : {}),
  };
}

function buildV2Context(priorReadOfTarget: 'yes' | 'no'): RuleContextV2 {
  return {
    version: 2,
    history: {
      status: 'available',
      truncated: false,
      calls: priorReadOfTarget === 'yes'
        ? [{
            sequenceId: 1,
            toolName: 'read_file',
            canonicalKind: 'read' as const,
            normalizedPath: 'src/auth.ts',
            paramsSummary: { file_path: 'src/auth.ts' },
            outcome: 'success' as const,
          }]
        : [],
    },
    facts: {
      priorReadOfTarget,
      readCount: priorReadOfTarget === 'yes' ? 1 : 0,
      writeCount: 0,
      uniqueWritePathCount: 0,
      sameActionBlockCount: 0,
    },
  };
}

// ── Shared state (set in beforeAll) ──────────────────────────────────────────

const PAIN_CANONICAL_ID = 'pain_pri492_e2e_001';
const SESSION_ID = 'pri492-e2e-session';

let workspaceDir = '';
let stateManager: RuntimeStateManager;
let adapter: ScriptedAdapter;
let dreamerRunner: DreamerRunner;
let philosopherRunner: PhilosopherRunner;
let scribeRunner: ScribeRunner;
let artificerRunner: ArtificerRunner;
let evaluatorRunner: EvaluatorRunner;
let approvalStore: SqliteApprovalQueueStore;
let stateStore: SqliteActivationStateStore;
let capturingWriter: CapturingRuleHostWriter;
let dispatcher: ActivationDispatcher;
let approvalQueue: ApprovalQueue;
let completionService: ApprovalCompletionService;
let ruleHost: RuleHost;
let assembledPack: BehaviorExamplePack;

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Create temp workspace with config (rulecode_context_v2 enabled)
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri492-e2e-'));
  const pdDir = path.join(workspaceDir, '.pd');
  const stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(pdDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  // ERR-026: production config format, not hand-written schema
  const config = {
    version: 1,
    features: {
      prompt: { category: 'core', enabled: true },
      code_tool_hook: { category: 'core', enabled: true },
      defer_archive: { category: 'core', enabled: true },
      rulecode_context_v2: { category: 'quiet', enabled: true },
    },
    runtimeProfiles: { 'openclaw.default': { type: 'openclaw', source: 'default' } },
    internalAgents: { defaultRuntime: 'openclaw.default', agents: { diagnostician: { enabled: true } } },
    ui: { diagnostics: { mode: 'simple' } },
  };
  fs.writeFileSync(path.join(pdDir, 'config.yaml'), yaml.dump(config), 'utf8');

  // 2. Seed TrajectoryDatabase (production schema, ERR-026) with pain + tool calls
  //    This is INPUT data for the pack assembler — NOT bypassing the chain.
  const trajectory = TrajectoryRegistry.get(workspaceDir);

  // Seed: read_file(src/auth.ts) → write_file(src/auth.ts) → write_file(src/other.ts)
  // The positive case (write src/auth.ts) has a prior read → priorReadOfTarget = 'yes'
  // The negative case (write src/other.ts) has NO prior read → priorReadOfTarget = 'no'
  const readCallId = trajectory.recordToolCall({
    sessionId: SESSION_ID,
    toolName: 'read_file',
    outcome: 'success',
    paramsJson: { file_path: 'src/auth.ts' },
  });
  const positiveWriteCallId = trajectory.recordToolCall({
    sessionId: SESSION_ID,
    toolName: 'write_file',
    outcome: 'success',
    paramsJson: { file_path: 'src/auth.ts', content: 'modified' },
  });
  const negativeWriteCallId = trajectory.recordToolCall({
    sessionId: SESSION_ID,
    toolName: 'write_file',
    outcome: 'success',
    paramsJson: { file_path: 'src/other.ts', content: 'new file' },
  });

  trajectory.recordPainEvent({
    sessionId: SESSION_ID,
    source: 'auto',
    score: 0.8,
    reason: 'Write without prior read detected',
    severity: 'medium',
    origin: 'trajectory',
    confidence: 0.85,
    canonicalPainId: PAIN_CANONICAL_ID,
  });

  // 3. Assemble BehaviorExamplePack (real assembler, ERR-024/025)
  const assembler = new BehaviorExamplePackAssembler({ workspaceDir, stateDir });
  assembledPack = assembler.assemble({
    sourcePainId: PAIN_CANONICAL_ID,
    ownerDesiredOutcome: 'Block writes to files that have not been read in the current session',
    sourceNegativeToolCallId: negativeWriteCallId,
    positiveToolCallIds: [positiveWriteCallId],
    projectDir: workspaceDir,
  });

  // 4. Build ScriptedAdapter (only LLM mock)
  adapter = new ScriptedAdapter({
    dreamer: (taskId) => dreamerOut(taskId, PAIN_CANONICAL_ID),
    philosopher: (taskId, priorId) => philosopherOut(taskId, priorId),
    scribe: (taskId, priorId) => scribeOut(taskId, priorId),
    artificer: artificerV2Factory(assembledPack),
    evaluator: (taskId, artificerArtifactId) => evaluatorApproved(taskId, artificerArtifactId),
  });

  // 5. Build RuntimeStateManager (production SQLite, ERR-026)
  stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  adapter.artifactStore = stateManager.piArtifactStore;

  // 6. Build runners (real validators, real artifact store)
  const eventEmitter = new StoreEventEmitter();
  const owner = 'pri492-e2e';
  const runnerOpts = { owner, runtimeKind: 'test-double', pollIntervalMs: 10, timeoutMs: 10_000 };

  dreamerRunner = new DreamerRunner(
    { stateManager, runtimeAdapter: adapter, eventEmitter, artifactStore: stateManager.piArtifactStore, validator: new DefaultDreamerValidator() },
    runnerOpts,
  );
  philosopherRunner = new PhilosopherRunner(
    { stateManager, runtimeAdapter: adapter, eventEmitter, artifactStore: stateManager.piArtifactStore, validator: new DefaultPhilosopherValidator() },
    runnerOpts,
  );
  scribeRunner = new ScribeRunner(
    { stateManager, runtimeAdapter: adapter, eventEmitter, artifactStore: stateManager.piArtifactStore, validator: new DefaultScribeValidator() },
    runnerOpts,
  );
  artificerRunner = new ArtificerRunner(
    {
      stateManager,
      runtimeAdapter: adapter,
      eventEmitter,
      artifactStore: stateManager.piArtifactStore,
      validator: new DefaultArtificerValidator(),
      contextMode: 'v2',
      behaviorExamplePack: assembledPack,
    },
    runnerOpts,
  );
  evaluatorRunner = new EvaluatorRunner(
    {
      stateManager, runtimeAdapter: adapter, eventEmitter, artifactStore: stateManager.piArtifactStore, validator: new DefaultEvaluatorValidator(),
    },
    {
      ...runnerOpts,
      // PRI-634 A2/R2: code-bearing Artificer output REQUIRES the deterministic
      // gate. Previously this runner had no gateDeps and the approved verdict
      // trusted the scripted adversarialResult.passed=true declaration — the
      // exact LLM-declared-beats-gate hole (chain 48371236). Inject the same
      // production gateDeps as RuleHostWriter (A1 wiring parity). NOTE: the
      // EvaluatorRunner constructor reads gateDeps from OPTIONS (2nd arg), not
      // deps (1st arg) — evaluator-runner.ts this.gateDeps = options.gateDeps.
      gateDeps: createProductionGateDeps(),
    },
  );

  // 7. Build approval queue + dispatcher + completion service (real production path)
  approvalStore = new SqliteApprovalQueueStore(stateManager.connection);
  stateStore = new SqliteActivationStateStore(stateManager.connection);

  // CapturingRuleHostWriter wraps the real writer with featureFlagProbe
  // enabled for v2 artifacts (PRI-484). Without the probe, v2 artifacts are
  // rejected with reason 'rulecode_context_v2_disabled'.
  capturingWriter = new CapturingRuleHostWriter({
    gateDeps: createProductionGateDeps(),
    featureFlagProbe: () => true,
  });

  dispatcher = new ActivationDispatcher(
    stateManager.piArtifactStore,
    stateStore,
    {
      writers: [new PromptWriter(), capturingWriter, new DeferArchiveWriter()],
      approvalQueueStore: approvalStore,
    },
  );

  approvalQueue = new ApprovalQueue(approvalStore);
  completionService = new ApprovalCompletionService(approvalStore, dispatcher, stateStore);

  // 8. Build RuleHost (real, reads activations from SQLite)
  ruleHost = new RuleHost(stateDir, { warn: () => {}, info: () => {}, error: () => {} }, { workspaceDir });
}, 60_000);

afterAll(() => {
  try {
    ruleHost?.dispose();
  } catch {
    /* best-effort */
  }
  try {
    TrajectoryRegistry.dispose(workspaceDir);
  } catch {
    /* best-effort */
  }
  try {
    stateManager?.close();
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    /* Windows: best-effort */
  }
});

// ── The E2E chain ─────────────────────────────────────────────────────────────

describe('PRI-492: RuleHost seed-MVP production E2E chain', () => {
  it('exercises the full production chain from pain to deactivate', async () => {
    // ═══════════════════════════════════════════════════════════════════════════
    // STAGE 1: Run dreamer → philosopher → scribe (real runners, real validators)
    // ═══════════════════════════════════════════════════════════════════════════

    const dreamerTaskId = 'dreamer-pri492-001';
    await stateManager.createTask({
      taskId: dreamerTaskId,
      taskKind: 'dreamer',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [],
        channel: 'code_tool_hook',
        timeoutMs: 10_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });
    const dreamerResult = await dreamerRunner.run(dreamerTaskId);
    expect(dreamerResult.status).toBe('succeeded');

    const philosopherTaskId = 'philosopher-pri492-001';
    await stateManager.createTask({
      taskId: philosopherTaskId,
      taskKind: 'philosopher',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [dreamerTaskId],
        channel: 'code_tool_hook',
        timeoutMs: 10_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });
    const philosopherResult = await philosopherRunner.run(philosopherTaskId);
    expect(philosopherResult.status).toBe('succeeded');

    const scribeTaskId = 'scribe-pri492-001';
    await stateManager.createTask({
      taskId: scribeTaskId,
      taskKind: 'scribe',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [philosopherTaskId],
        channel: 'code_tool_hook',
        timeoutMs: 10_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });
    const scribeResult = await scribeRunner.run(scribeTaskId);
    expect(scribeResult.status).toBe('succeeded');

    // ═══════════════════════════════════════════════════════════════════════════
    // STAGE 2: Run adversarial loop (real ArtificerRunner + EvaluatorRunner)
    // ═══════════════════════════════════════════════════════════════════════════

    const loopResult = await runAdversarialLoop({
      artificerRunner,
      evaluatorRunner,
      stateManager,
      artifactStore: stateManager.piArtifactStore,
      scribeTaskId,
      maxRounds: 1,
      channel: 'code_tool_hook',
      correlationId: 'pri492-e2e',
    });

    expect(loopResult.decision).toBe('approved');
    expect(loopResult.ruleArtifactId).toBeTruthy();

    const ruleArtifactId = loopResult.ruleArtifactId!;

    // ═══════════════════════════════════════════════════════════════════════════
    // ACCEPTANCE CRITERION 1: v2 rule artifact with requiresContextVersion,
    // ruleContext cases, and evidenceRefs
    // ═══════════════════════════════════════════════════════════════════════════

    const ruleArtifact = await stateManager.piArtifactStore.getArtifactById(ruleArtifactId);
    expect(ruleArtifact).not.toBeNull();
    expect(ruleArtifact!.artifactKind).toBe('rule');
    expect(ruleArtifact!.validationStatus).toBe('validated');

    // ERR-001: parse contentJson as unknown, use type guards (no `as` bypass)
    const parsed: unknown = JSON.parse(ruleArtifact!.contentJson);
    expect(isRecord(parsed)).toBe(true);
    if (!isRecord(parsed)) throw new Error('unreachable: contentJson is a record');
    const contentObj: Record<string, unknown> = parsed;

    // requiresContextVersion === 2
    expect(contentObj['requiresContextVersion']).toBe(2);

    // evidenceRefs — non-empty array of strings preserved from pack
    const evidenceRefs: unknown = contentObj['evidenceRefs'];
    expect(Array.isArray(evidenceRefs)).toBe(true);
    if (!Array.isArray(evidenceRefs)) throw new Error('unreachable: evidenceRefs is array');
    expect(evidenceRefs.length).toBeGreaterThan(0);
    for (const ref of evidenceRefs) {
      expect(typeof ref).toBe('string');
      if (typeof ref !== 'string') throw new Error('unreachable: ref is string');
      expect(ref.length).toBeGreaterThan(0);
    }
    // Evidence refs must match the pack (provenance preserved)
    for (let i = 0; i < assembledPack.evidenceRefs.length; i++) {
      expect(evidenceRefs[i]).toBe(assembledPack.evidenceRefs[i]);
    }

    // goldenTraceCases with ruleContext (v2 cases)
    const goldenTraceCases: unknown = contentObj['goldenTraceCases'];
    expect(Array.isArray(goldenTraceCases)).toBe(true);
    if (!Array.isArray(goldenTraceCases)) throw new Error('unreachable: goldenTraceCases is array');
    expect(goldenTraceCases.length).toBeGreaterThanOrEqual(2);
    for (const caseEntry of goldenTraceCases) {
      expect(isRecord(caseEntry)).toBe(true);
      if (!isRecord(caseEntry)) continue;
      expect(caseEntry['ruleContext']).toBeDefined();
      expect(isRecord(caseEntry['ruleContext'])).toBe(true);
      const rc = caseEntry['ruleContext'];
      if (isRecord(rc)) {
        expect(rc['version']).toBe(2);
      }
    }

    // ruleHostGateDecision === 'accepted_shadow' (required by RuleHostWriter)
    expect(contentObj['ruleHostGateDecision']).toBe('accepted_shadow');

    // ═══════════════════════════════════════════════════════════════════════════
    // STAGE 3: Approval → dispatch → shadow activation (real production path)
    // ═══════════════════════════════════════════════════════════════════════════

    // Build WriterInput for approval context
    const writerInput: WriterInput = {
      artifactId: ruleArtifactId,
      channel: 'code_tool_hook',
      principleId: loopResult.principleArtifactId ?? ruleArtifactId,
      idempotencyKey: `${ruleArtifactId}::code_tool_hook`,
      now: new Date().toISOString(),
    };

    // Use the real RuleHostWriter.buildApprovalContext to build approval metadata
    const approvalContext = capturingWriter.buildApprovalContext(writerInput, ruleArtifact!, 0.85);

    // Enqueue into the real approval queue
    const now = new Date().toISOString();
    const enqueueInput: ApprovalEnqueueInput = {
      artifactId: ruleArtifactId,
      channel: 'code_tool_hook',
      riskLevel: getChannelRiskLevel('code_tool_hook'),
      confidence: 0.85,
      ...approvalContext,
    };
    const approvalRecord = await approvalStore.enqueue(enqueueInput, now);
    expect(approvalRecord.approvalId).toBeTruthy();

    // Approve via the real ApprovalQueue
    const approvalResult = await approvalQueue.approve(approvalRecord.approvalId, 'owner', 'PRI-492 E2E test');
    expect(approvalResult.ok).toBe(true);

    // Complete approval → dispatch → activate (real ApprovalCompletionService)
    const actor: ActivationActor = { kind: 'human', userId: 'owner' };
    const completionResult = await completionService.completeApproval({
      approvalId: approvalRecord.approvalId,
      actor,
      now: new Date().toISOString(),
    });
    expect(completionResult.ok).toBe(true);

    // ═══════════════════════════════════════════════════════════════════════════
    // ACCEPTANCE CRITERION 2: Approval creates shadow activation
    // ═══════════════════════════════════════════════════════════════════════════

    const activationId = completionResult.ok ? completionResult.activationId : undefined;
    expect(activationId).toBeTruthy();

    // Verify the activation in the DB is shadow (not live)
    // ERR-001: DB .get() result treated as unknown — no `as` bypass (rc-2)
    const db = stateManager.connection.getDb();
    const activationRowRaw: unknown = db.prepare(
      `SELECT action, deactivated_at FROM activations WHERE activation_id = ?`,
    ).get(activationId!);

    const actionVal = isRecord(activationRowRaw) ? activationRowRaw['action'] : undefined;
    const deactivatedVal = isRecord(activationRowRaw) ? activationRowRaw['deactivated_at'] : undefined;
    const activationRow = (
      typeof actionVal === 'string'
      && (deactivatedVal === null || typeof deactivatedVal === 'string')
    )
      ? { action: actionVal, deactivated_at: deactivatedVal }
      : undefined;

    expect(activationRow).toBeDefined();
    expect(activationRow!.action).toBe('code_tool_hook_shadow_activate');
    expect(activationRow!.deactivated_at).toBeNull();

    // ═══════════════════════════════════════════════════════════════════════════
    // ACCEPTANCE CRITERION 9: Negative assertion — would fail if
    // RuleHostWriter.activate() returned live instead of shadow
    // ═══════════════════════════════════════════════════════════════════════════

    // The captured WriterResult from the real RuleHostWriter.activate() call
    expect(capturingWriter.capturedResult).not.toBeNull();
    expect(capturingWriter.capturedResult!.action).toBe('code_tool_hook_shadow_activate');
    // This assertion would FAIL if activate() returned 'code_tool_hook_live_activate'
    expect(capturingWriter.capturedResult!.action).not.toBe('code_tool_hook_live_activate');

    // ═══════════════════════════════════════════════════════════════════════════
    // STAGE 4: Shadow observation — would-block recorded, does not block
    // ═══════════════════════════════════════════════════════════════════════════

    // Dispose RuleHost to force fresh load from DB (clear fingerprint cache)
    ruleHost.dispose();
    ruleHost = new RuleHost(
      path.join(workspaceDir, '.state'),
      { warn: () => {}, info: () => {}, error: () => {} },
      { workspaceDir },
    );

    // Build input with v2 context: unsafe write (no prior read)
    const unsafeInput = buildRuleHostInput('write_file', 'src/unread.ts', buildV2Context('no'));
    const shadowReport = ruleHost.evaluateDetailed(unsafeInput);

    // ACCEPTANCE CRITERION 3: Shadow observation records would-block, does not block
    // ERR-088: positive path marker — shadowDecisions populated
    expect(shadowReport.shadowDecisions.length).toBeGreaterThan(0);
    const shadowDecision = shadowReport.shadowDecisions[0];
    expect(shadowDecision.decision).toBe('block');
    expect(shadowDecision.matched).toBe(true);
    // Shadow does NOT produce a live decision (observation-only)
    expect(shadowReport.liveDecision).toBeUndefined();

    // ═══════════════════════════════════════════════════════════════════════════
    // STAGE 5: Promote shadow → live (real SqliteActivationStateStore)
    // ═══════════════════════════════════════════════════════════════════════════

    const promotedAt = new Date().toISOString();
    const promoteResult = await stateStore.promoteActivation(activationId!, promotedAt);
    expect(promoteResult).toBe(true);

    // Verify the DB row changed to live
    // ERR-001: DB .get() result treated as unknown — no `as` bypass (rc-2)
    const promotedRowRaw: unknown = db.prepare(
      `SELECT action FROM activations WHERE activation_id = ?`,
    ).get(activationId!);

    const promotedActionVal = isRecord(promotedRowRaw) ? promotedRowRaw['action'] : undefined;
    const promotedRow = typeof promotedActionVal === 'string'
      ? { action: promotedActionVal }
      : undefined;

    expect(promotedRow).toBeDefined();
    expect(promotedRow!.action).toBe('code_tool_hook_live_activate');

    // ═══════════════════════════════════════════════════════════════════════════
    // ACCEPTANCE CRITERION 4: Promote changes mode to live, matching unsafe write is blocked
    // ═══════════════════════════════════════════════════════════════════════════

    // Dispose + recreate RuleHost to pick up the promoted activation
    ruleHost.dispose();
    ruleHost = new RuleHost(
      path.join(workspaceDir, '.state'),
      { warn: () => {}, info: () => {}, error: () => {} },
      { workspaceDir },
    );

    // Live block: unsafe write (no prior read) → must block
    const liveBlockReport = ruleHost.evaluateDetailed(
      buildRuleHostInput('write_file', 'src/unread.ts', buildV2Context('no')),
    );
    // ERR-088: positive path marker — liveDecision is populated and blocks
    expect(liveBlockReport.liveDecision).toBeDefined();
    expect(liveBlockReport.liveDecision!.decision).toBe('block');
    expect(liveBlockReport.liveDecision!.matched).toBe(true);

    // ═══════════════════════════════════════════════════════════════════════════
    // ACCEPTANCE CRITERION 5: Prior-read / positive case remains allowed
    // ═══════════════════════════════════════════════════════════════════════════

    // Live allow: write to a file that HAS a prior read → must NOT block
    const liveAllowReport = ruleHost.evaluateDetailed(
      buildRuleHostInput('write_file', 'src/auth.ts', buildV2Context('yes')),
    );
    // ERR-088: positive path marker — liveDecision is undefined or allow (no block)
    if (liveAllowReport.liveDecision) {
      expect(liveAllowReport.liveDecision.decision).not.toBe('block');
    }
    // If liveDecision is undefined, that means no rule blocked the action (allow is implicit)

    // ═══════════════════════════════════════════════════════════════════════════
    // ACCEPTANCE CRITERION 6: Flag off suspends the v2 activation with structured reason
    // ═══════════════════════════════════════════════════════════════════════════

    // Dispose + recreate RuleHost to clear fingerprint cache
    ruleHost.dispose();
    ruleHost = new RuleHost(
      path.join(workspaceDir, '.state'),
      { warn: () => {}, info: () => {}, error: () => {} },
      { workspaceDir },
    );

    // Flag-off: call evaluateDetailed WITHOUT v2 context (simulates flag disabled)
    // The RuleHost sets supportsContextV2 = (input.context?.version === 2) = false
    const flagOffInput = buildRuleHostInput('write_file', 'src/unread.ts'); // no context
    const flagOffReport = ruleHost.evaluateDetailed(flagOffInput);

    // ERR-002: degradation carries reason + nextAction (not silent)
    expect(flagOffReport.skippedActivations.length).toBeGreaterThan(0);
    const skipped = flagOffReport.skippedActivations[0];
    expect(skipped.reason).toContain('suspended_by_flag');
    expect(skipped.reason).toContain('rulecode_context_v2');
    expect(skipped.nextAction).toBeTruthy();
    // ERR-088: positive path marker — the rule is NOT loaded (liveDecision undefined)
    expect(flagOffReport.liveDecision).toBeUndefined();

    // ═══════════════════════════════════════════════════════════════════════════
    // ACCEPTANCE CRITERION 7: Deactivate stops enforcement
    // ═══════════════════════════════════════════════════════════════════════════

    const deactivatedAt = new Date().toISOString();
    const deactivateResult = await stateStore.deactivateActivation(activationId!, deactivatedAt);
    expect(deactivateResult).toBe(true);

    // Dispose + recreate RuleHost to clear fingerprint cache
    ruleHost.dispose();
    ruleHost = new RuleHost(
      path.join(workspaceDir, '.state'),
      { warn: () => {}, info: () => {}, error: () => {} },
      { workspaceDir },
    );

    // After deactivation, no rules are loaded — the unsafe write is NOT blocked
    const deactivatedReport = ruleHost.evaluateDetailed(
      buildRuleHostInput('write_file', 'src/unread.ts', buildV2Context('no')),
    );
    // ERR-088: positive path marker — no liveDecision (rule is deactivated, not loaded)
    expect(deactivatedReport.liveDecision).toBeUndefined();
    expect(deactivatedReport.shadowDecisions.length).toBe(0);
    expect(deactivatedReport.skippedActivations.length).toBe(0);

    // ═══════════════════════════════════════════════════════════════════════════
    // ACCEPTANCE CRITERION 8: No test directly inserts final activation as a
    // substitute for approval/dispatcher
    // ═══════════════════════════════════════════════════════════════════════════
    //
    // This test created the shadow activation ONLY through:
    //   ApprovalQueue.approve → ApprovalCompletionService.completeApproval
    //   → ActivationDispatcher.dispatch → RuleHostWriter.activate
    //   → SqliteActivationStateStore.recordActivation
    //
    // No `db.prepare('INSERT INTO activations...')` or `stateStore.recordActivation()`
    // was called directly to create the final activation. The only DB writes for
    // activations came through the real production dispatcher chain.

    // ═══════════════════════════════════════════════════════════════════════════
    // SUMMARY: All 9 acceptance criteria verified
    // ═══════════════════════════════════════════════════════════════════════════
  }, 120_000);
});
