/**
 * LLM Dogfood Script — PRI-408 (P1/P2 fixes validation)
 *
 * Runs the RuleHost pipeline with a REAL LLM (qwen3.6-27b-mtp via LM Studio)
 * to validate the six-step value chain end-to-end:
 *
 *   pain → dreamer → philosopher → scribe → artificer ↔ evaluator
 *   → candidate → auto-enqueue → owner approve → activate
 *   → before/after behavior comparison → deactivate → restore
 *
 * Usage:
 *   npx tsx scripts/llm-dogfood.ts
 *
 * Prerequisites:
 *   - LM Studio running on http://localhost:12341 with qwen3.6-27b-mtp loaded
 *   - Set LMSTUDIO_API_KEY=lm-studio (or any non-empty string)
 *
 * Output:
 *   - Console log with each stage's result
 *   - dogfood-output.json with full structured results
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  PiAiRuntimeAdapter,
  ArtificerL2Adapter,
  DefaultArtificerValidator,
  RuntimeStateManager,
  SqliteApprovalQueueStore,
  SqliteActivationStateStore,
  SqlitePIArtifactStore,
  ActivationDispatcher,
  ApprovalCompletionService,
  PromptWriter,
  DeferArchiveWriter,
  RuleHostWriter,
  createProductionGateDeps,
  makeIdempotencyKey,
  createPITaskDiagnosticJson,
  buildToolSemanticRegistry,
} from '@principles/core/runtime-v2';
import type { PIArtifactSnapshot, PIArtifactRecord } from '@principles/core/runtime-v2';
import { runRuleHostPipeline, createSandboxGateDeps } from '../src/services/rulehost-pipeline-runner.js';
import { compileDemoRule } from '../src/services/demo-rule-compiler.js';
import type { CodeRuleCapability } from '../src/services/rulehost-pipeline-runner.js';

// ── Config ───────────────────────────────────────────────────────────────────

const LM_STUDIO_BASE_URL = 'http://localhost:12341/v1';
const MODEL_ID = 'qwen3.6-27b-mtp';
const PROVIDER = 'lmstudio';
const API_KEY_ENV = 'LMSTUDIO_API_KEY';

// Ensure the API key env var is set (LM Studio doesn't require a real key,
// but PiAiRuntimeAdapter checks process.env[apiKeyEnv] is non-empty)
if (!process.env[API_KEY_ENV]) {
  process.env[API_KEY_ENV] = 'lm-studio';
}

// ── Dogfood pain scenario ────────────────────────────────────────────────────

const DOGFOOD_PAIN = {
  painId: 'pain-dogfood-001',
  scenario: 'Agent attempted to write to /etc/passwd during a file operation',
  badDecision: 'Wrote directly to /etc/passwd without checking if it is a system path',
  betterDecision: 'Block writes to system paths (/etc, /boot, /sys, /proc)',
  context: 'File write operation targeting a system-critical path',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `pd-dogfood-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function toSnapshot(record: PIArtifactRecord): PIArtifactSnapshot {
  return {
    artifactId: record.artifactId,
    artifactKind: record.artifactKind,
    sourceTaskId: record.sourceTaskId,
    sourcePrincipleId: record.sourcePrincipleId,
    sourceRuleId: record.sourceRuleId,
    lineageArtifactIds: record.lineageArtifactIds,
    validationStatus: record.validationStatus,
    contentJson: record.contentJson,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function seedPainSignal(sm: RuntimeStateManager, painId: string): Promise<void> {
  const baseMetadata = JSON.parse(createPITaskDiagnosticJson({
    dependencyTaskIds: [], channel: 'code_tool_hook', timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [],
  })) as Record<string, unknown>;
  const diagnosticJson = JSON.stringify({
    ...baseMetadata,
    sourcePainId: painId,
    painSummary: DOGFOOD_PAIN.scenario,
    badDecision: DOGFOOD_PAIN.badDecision,
    betterDecision: DOGFOOD_PAIN.betterDecision,
  });
  await sm.createTask({
    taskId: 'dreamer-dogfood-001',
    taskKind: 'dreamer',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    diagnosticJson,
  });
}

function log(stage: string, message: string, detail?: unknown): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${stage}] ${message}`);
  if (detail !== undefined) {
    console.log(JSON.stringify(detail, null, 2));
  }
}

// ── Main dogfood ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const outputDir = path.resolve(process.cwd(), 'dogfood-output');
  fs.mkdirSync(outputDir, { recursive: true });

  const tmpDir = makeTmpDir();
  log('SETUP', `Workspace: ${tmpDir}`);
  log('SETUP', `LLM: ${MODEL_ID} @ ${LM_STUDIO_BASE_URL}`);

  // ── Step 1: Seed pain signal ──────────────────────────────────────────────
  log('STEP-1', `Seeding pain: ${DOGFOOD_PAIN.scenario}`);
  const sm = new RuntimeStateManager({ workspaceDir: tmpDir });
  await sm.initialize();
  await seedPainSignal(sm, DOGFOOD_PAIN.painId);
  await sm.close();

  // ── Step 2: Run RuleHost pipeline with real LLM ──────────────────────────
  log('STEP-2', 'Starting RuleHost pipeline (dreamer → philosopher → scribe → artificer ↔ evaluator)');

  const adapter = new PiAiRuntimeAdapter({
    provider: PROVIDER,
    model: MODEL_ID,
    apiKeyEnv: API_KEY_ENV,
    baseUrl: LM_STUDIO_BASE_URL,
    maxRetries: 1,
    timeoutMs: 600_000,
    maxTokens: 8192,
    reasoning: false,
    workspace: tmpDir,
  });

  // Construct the ArtificerL2Adapter for the artificer stage (PRI-439 Phase 4).
  // This adapter uses runAgentLoop with 4 tools (read_rulecode_spec,
  // validate_rulecode, replay_rulecode, submit_rulecode) to generate and
  // verify RuleCode inside a multi-turn agent loop.
  const artificerAdapter = new ArtificerL2Adapter({
    provider: PROVIDER,
    model: MODEL_ID,
    apiKeyEnv: API_KEY_ENV,
    baseUrl: LM_STUDIO_BASE_URL,
    gateDeps: createSandboxGateDeps(),
    validator: new DefaultArtificerValidator(),
    totalBudgetMs: 600_000,
    maxTokens: 8192,
  });

  const capability: CodeRuleCapability = { enabled: true, artificerAdapter };

  let pipelineResult;
  try {
    pipelineResult = await runRuleHostPipeline({
      workspaceDir: tmpDir,
      painId: DOGFOOD_PAIN.painId,
      runtimeAdapter: adapter,
      channel: 'code_tool_hook',
      pollIntervalMs: 200,
      timeoutMs: 600_000,
      maxRounds: 2,
      codeRuleCapability: capability,
      onProgress: (stage, status, detail) => {
        log('PIPELINE', `${stage}: ${status}${detail ? ' — ' + detail : ''}`);
      },
    });
  } catch (err) {
    log('STEP-2', 'Pipeline threw', { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }

  log('STEP-2', `Pipeline decision: ${pipelineResult.decision}`, {
    ruleArtifactId: pipelineResult.ruleArtifactId,
    principleArtifactId: pipelineResult.principleArtifactId,
    approvalId: pipelineResult.approvalId,
    degradationReason: pipelineResult.degradationReason,
  });

  if (pipelineResult.decision !== 'candidate_ready_for_owner_review') {
    log('STEP-2', 'Pipeline did not produce a candidate — saving partial results and exiting');
    const partialOutput = {
      pain: DOGFOOD_PAIN,
      pipelineResult,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(outputDir, 'dogfood-partial.json'), JSON.stringify(partialOutput, null, 2));
    console.log(`\nPartial results saved to ${path.join(outputDir, 'dogfood-partial.json')}`);
    return;
  }

  // ── Step 3: Extract generated principle + RuleCode + evaluator judgment ──
  log('STEP-3', 'Extracting generated artifacts');
  const sm2 = new RuntimeStateManager({ workspaceDir: tmpDir });
  await sm2.initialize();
  const artifactStore = new SqlitePIArtifactStore(sm2.connection);
  const approvalStore = new SqliteApprovalQueueStore(sm2.connection);
  const stateStore = new SqliteActivationStateStore(sm2.connection);

  const ruleArtifact = await artifactStore.getArtifactById(pipelineResult.ruleArtifactId!);
  const principleArtifact = pipelineResult.principleArtifactId
    ? await artifactStore.getArtifactById(pipelineResult.principleArtifactId)
    : null;

  let generatedPrinciple: unknown = null;
  let ruleCode: string | null = null;
  let evaluatorJudgment: unknown = null;

  if (principleArtifact) {
    try {
      generatedPrinciple = JSON.parse(principleArtifact.contentJson);
    } catch {
      generatedPrinciple = principleArtifact.contentJson;
    }
    log('STEP-3', 'Generated principle extracted', { artifactId: principleArtifact.artifactId });
  }

  if (ruleArtifact) {
    try {
      const ruleContent = JSON.parse(ruleArtifact.contentJson) as Record<string, unknown>;
      ruleCode = typeof ruleContent.implementationCode === 'string' ? ruleContent.implementationCode : null;
      evaluatorJudgment = ruleContent.adversarialResult ?? null;
      log('STEP-3', 'RuleCode extracted', { artifactId: ruleArtifact.artifactId, codeLength: ruleCode?.length ?? 0 });
      log('STEP-3', 'Evaluator judgment', evaluatorJudgment);
    } catch {
      log('STEP-3', 'Failed to parse rule artifact contentJson');
    }
  }

  // ── Step 4: Owner approves the candidate ─────────────────────────────────
  log('STEP-4', 'Owner approving candidate');
  const approvalId = pipelineResult.approvalId;
  if (!approvalId) {
    log('STEP-4', 'No approvalId — candidate was not auto-enqueued', {
      degradationReason: pipelineResult.degradationReason,
    });
    const partialOutput = {
      pain: DOGFOOD_PAIN,
      pipelineResult,
      timestamp: new Date().toISOString(),
      error: 'auto_enqueue_failed',
    };
    fs.writeFileSync(path.join(outputDir, 'dogfood-partial.json'), JSON.stringify(partialOutput, null, 2));
    console.log(`\nPartial results saved (enqueue failed)`);
    await sm2.close();
    return;
  }
  const approveResult = await approvalStore.approve(approvalId, 'owner-dogfood', 'Dogfood approval');
  log('STEP-4', `Approval result: ok=${approveResult.ok}`);

  // ── Step 5: Dispatch activation ──────────────────────────────────────────
  log('STEP-5', 'Dispatching activation');
  const artifactReadModel = {
    getArtifactById: async (id: string): Promise<PIArtifactSnapshot | null> => {
      const rec = await artifactStore.getArtifactById(id);
      return rec ? toSnapshot(rec) : null;
    },
  };

  // PRI-634-F R2: persist a dogfood tool declaration + registry so the
  // activation path resolves host provenance exactly like a real workspace.
  const dogfoodMappings = [
      { rawToolName: 'write_file', canonicalKind: 'write' },
      { rawToolName: 'edit_file', canonicalKind: 'write' },
      { rawToolName: 'bash', canonicalKind: 'execute' },
      { rawToolName: 'shell', canonicalKind: 'execute' },
    ];
  const dogfoodRegistry = buildToolSemanticRegistry(dogfoodMappings);
  if (!dogfoodRegistry.ok) throw new Error(dogfoodRegistry.errors.join('; '));
  saveHostToolDeclaration(tmpDir, {
    version: 1,
    hostKind: 'llm-dogfood',
    mappings: dogfoodMappings,
    declaredAt: new Date().toISOString(),
  });
  const dispatcher = new ActivationDispatcher(
    artifactReadModel,
    stateStore,
    {
      writers: [
        new PromptWriter(),
        // PRI-634-F: dogfood replay normalizes against the dogfood workspace
        // root and validates tool existence against the declared registry.
        new RuleHostWriter({
          gateDeps: createProductionGateDeps({ projectDir: tmpDir, toolSemantics: dogfoodRegistry.registry }),
          projectDir: tmpDir,
          toolSemantics: dogfoodRegistry.registry,
        }),
        new DeferArchiveWriter(),
      ],
      approvalQueueStore: approvalStore,
    },
  );

  const completionService = new ApprovalCompletionService(
    approvalStore,
    dispatcher,
    stateStore,
  );

  const completionResult = await completionService.completeApproval({
    approvalId,
    actor: { kind: 'human', userId: 'owner-dogfood' },
    now: new Date().toISOString(),
  });

  log('STEP-5', `Activation result: ok=${completionResult.ok}`, completionResult);

  // ── Step 6: Before/after behavior comparison ─────────────────────────────
  log('STEP-6', 'Before/after behavior comparison');

  // Test the rule code against system-path and non-system-path inputs
  const testCases = [
    { name: 'system-path-write', input: { action: { paramsSummary: { path: '/etc/passwd' } } }, expected: 'block' },
    { name: 'system-path-write-boot', input: { action: { paramsSummary: { path: '/boot/grub.cfg' } } }, expected: 'block' },
    { name: 'normal-write', input: { action: { paramsSummary: { path: '/project/src/main.ts' } } }, expected: 'allow' },
    { name: 'normal-write-2', input: { action: { paramsSummary: { path: '/home/user/file.txt' } } }, expected: 'allow' },
  ];

  let behaviorResults: Array<{ name: string; expected: string; actual: string; passed: boolean }> = [];
  if (ruleCode) {
    // P1 #1 fix: use the production vm sandbox (compileDemoRule) instead of
    // `new Function` which bypasses the sandbox and has no timeout protection.
    // Also, `new Function('input', 'helpers', ruleCode)` would define `evaluate`
    // inside the function body but not call it, returning undefined — making
    // the behavior comparison unreliable.
    try {
      const evaluateFn = compileDemoRule(ruleCode, 'dogfood-behavior-test');
      behaviorResults = testCases.map((tc) => {
        try {
          const result = evaluateFn(tc.input as never, {} as never);
          const actual = typeof result === 'object' && result !== null && 'decision' in result
            ? String((result as Record<string, unknown>).decision)
            : 'unknown';
          return {
            name: tc.name,
            expected: tc.expected,
            actual,
            passed: actual === tc.expected,
          };
        } catch (err) {
          return {
            name: tc.name,
            expected: tc.expected,
            actual: `error: ${err instanceof Error ? err.message : String(err)}`,
            passed: false,
          };
        }
      });
    } catch (err) {
      log('STEP-6', 'Rule code compilation failed (vm sandbox)', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  log('STEP-6', 'Behavior results', behaviorResults);

  // ── Step 7: Deactivate and verify restoration ────────────────────────────
  log('STEP-7', 'Deactivating rule');
  const idempotencyKey = makeIdempotencyKey(pipelineResult.ruleArtifactId!, 'code_tool_hook');
  const activationRecord = await stateStore.getActivationStatus(idempotencyKey);
  if (activationRecord) {
    const deactivateResult = await stateStore.deactivateActivation(activationRecord.activationId, new Date().toISOString());
    log('STEP-7', `Deactivation: ${deactivateResult ? 'success' : 'failed'}`);

    // Verify the record is deactivated
    const afterDeactivate = await stateStore.getActivationStatus(idempotencyKey);
    log('STEP-7', `After deactivate: deactivatedAt=${afterDeactivate?.deactivatedAt ?? 'null'}`);
  }

  // ── Save full output ─────────────────────────────────────────────────────
  const fullOutput = {
    timestamp: new Date().toISOString(),
    pain: DOGFOOD_PAIN,
    pipelineResult: {
      decision: pipelineResult.decision,
      ruleArtifactId: pipelineResult.ruleArtifactId,
      principleArtifactId: pipelineResult.principleArtifactId,
      approvalId: pipelineResult.approvalId,
      stages: pipelineResult.stages,
      degradationReason: pipelineResult.degradationReason,
    },
    generatedPrinciple,
    ruleCode,
    evaluatorJudgment,
    approval: { ok: approveResult.ok },
    activation: {
      ok: completionResult.ok,
      decision: completionResult.ok ? completionResult.decision : null,
      activationId: completionResult.ok ? completionResult.activationId : null,
    },
    behaviorResults,
    model: { provider: PROVIDER, model: MODEL_ID, baseUrl: LM_STUDIO_BASE_URL },
  };

  const outputPath = path.join(outputDir, 'dogfood-output.json');
  fs.writeFileSync(outputPath, JSON.stringify(fullOutput, null, 2));

  // Also save rule code separately for easy review
  if (ruleCode) {
    fs.writeFileSync(path.join(outputDir, 'generated-rule.js'), ruleCode);
  }

  log('DONE', `Results saved to ${outputDir}/`);

  await sm2.close();

  // Cleanup tmp dir
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

main().catch((err) => {
  console.error('Dogfood failed:', err);
  process.exit(1);
});
