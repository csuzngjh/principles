/**
 * PRI-1146 P1-01 — trusted-context telemetry through the REAL production entries.
 *
 * The allowlist alone proves nothing: the previous defect was that the CLI
 * entries wired the Router Runner to a `StoreEventEmitter` with no workspace
 * sink, so `diag_router_trusted_context_unavailable` was emitted into the void.
 * These tests invoke the actual command handlers (`pd diagnose run`,
 * `pd pain record`, `pd pain retry`) against a real SQLite workspace with a
 * REAL `DiagRouterRunner` and a REAL `WorkspaceTelemetryEmitter`, then read the
 * `.pd/telemetry/critical-events.jsonl` file from disk.
 *
 * Only the model provider call is scripted (the same `@earendil-works/pi-ai`
 * seam every other adapter test uses). A corrupt ledger is the real
 * "unavailable" condition — no synthetic event is injected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('@earendil-works/pi-ai/compat', () => ({
  getModel: vi.fn(),
  getProviders: vi.fn(() => ['openrouter', 'anthropic', 'openai', 'google']),
  completeSimple: vi.fn(),
}));

import { getModel, completeSimple } from '@earendil-works/pi-ai/compat';
import { handleDiagnoseRun } from '../../src/commands/diagnose.js';
import { handlePainRecord } from '../../src/commands/pain-record.js';
import { handlePainRetry } from '../../src/commands/pain-retry.js';
import { RuntimeStateManager, storeEmitter, createDiagnosticianTaskId } from '@principles/core/runtime';
import type { DiagRootCauseOutputV1, DiagDistillerOutputV1, DiagnosticianOutputV2 } from '@principles/core/runtime';

// Real LM Studio outputs (see principles-core split-pipeline-fixtures.ts). Inlined
// because that module is not part of the runtime public barrel and tests must
// not widen it just to import fixtures.
const MOCK_ROOT_CAUSE_OUTPUTS: { R6: DiagRootCauseOutputV1 } = {
  R6: {
    valid: true,
    diagnosisId: 'diag-manual_1781081305247',
    taskId: 'diag-manual_1781081305247',
    summary: 'PRI-363 重构过程中 stage 枚举值变更未进行影响面评估与契约验证，导致下游测试断言失败及核心诊断触发逻辑（emitSync）断裂。',
    causalChain: [
      { why: 1, statement: 'pain.test.ts 测试断言失败，且 auto-entry-gate 集成测试 TC2 中 repeated failures 不再触发诊断，emitSync 未被调用。', evidenceRefs: ['owner_reported:cli'] },
      { why: 2, statement: 'PRI-363 重构将 stage 枚举值从 gate_admitted/triage_evidence_only 更改为 trigger_rejected，直接破坏了依赖旧枚举值的条件判断逻辑。', evidenceRefs: ['owner_reported:cli'] },
      { why: 3, statement: '重构流程中缺少对枚举变更影响范围的静态分析或契约测试验证环节，未能拦截破坏性修改。', evidenceRefs: ['owner_reported:cli'] },
      { why: 4, statement: '核心控制流（如诊断触发机制）直接耦合于硬编码的枚举字符串，缺乏版本兼容层或适配器模式以隔离变更影响。', evidenceRefs: ['owner_reported:cli'] },
      { why: 5, statement: '缺乏系统性的向后兼容性保障机制与重构影响面评估规范，导致行为等价承诺在代码重构时破裂。', evidenceRefs: ['owner_reported:cli'] },
    ],
    rootCause: 'Design: 缺乏系统性的向后兼容性保障机制与重构影响面评估规范，导致枚举变更直接破坏下游控制流契约。',
    rootCauseCategory: 'Design',
    evidence: [{ sourceRef: 'owner_reported:cli', note: 'PRI-363 重构后 pain.test.ts 出现行为回归：stage 枚举值从 gate_admitted/triage_evidence_only 改为 trigger_rejected，导致2条现有测试断言失败；auto-entry-gate 集成测试 TC2 中 repeated failures 不再触发诊断，emitSync 未被调用，行为等价承诺破裂' }],
    confidence: 0.85,
    ambiguityNotes: ['Fixture: R6 — PRI-363 refactor behavior regression (stage enum change broke tests)', '关联核心公理: T-01 (先理解结构再修改), T-07 (限制爆炸半径)'],
  },
};

const MOCK_DISTILLER_OUTPUTS: { R6: DiagDistillerOutputV1 } = {
  R6: {
    valid: true,
    taskId: 'diag-manual_1781081305247',
    sourceRootCauseArtifactId: 'artifact-rc-manual_1781081305247',
    abstractedPrinciple: '重构或修改核心契约前，必须全面评估影响范围并建立向后兼容机制，避免破坏性变更直接波及下游依赖。',
    rationale: '该原则要求在进行代码重构或契约变更时，优先进行影响面分析与兼容性设计。通过前置评估与适配层隔离，可有效防止底层枚举或接口修改直接破坏下游控制流，确保系统行为等价承诺不被无意打破。',
    groundedOnCorePrincipleIds: ['T-01', 'T-07'],
    scope: 'general',
    confidence: 0.85,
  },
};

const MOCK_ROUTER_OUTPUTS: { R6: DiagnosticianOutputV2 } = {
  R6: {
    schemaVersion: 'diagnostician-output-v2',
    valid: true,
    diagnosisId: 'diag-manual_1781081305247',
    summary: 'PRI-363 重构因缺乏影响面评估与向后兼容机制导致枚举变更破坏下游契约；需建立重构前全面评估与兼容性保障规范，避免破坏性变更波及依赖。',
    rootCause: 'Design: 缺乏系统性的向后兼容性保障机制与重构影响面评估规范，导致枚举变更直接破坏下游控制流契约。',
    violatedPrinciples: [
      { principleId: 'T-01', title: '先理解结构再修改', rationale: '重构未充分评估枚举变更对下游控制流的影响，违背了修改前需全面理解系统结构与依赖关系的原则。' },
      { principleId: 'T-07', title: '限制爆炸半径', rationale: '缺乏适配层或兼容性设计导致底层契约变更直接破坏核心诊断逻辑，违背了通过隔离机制限制变更影响范围的原则。' },
    ],
    evidence: [{ sourceRef: 'owner_reported:cli', note: 'PRI-363 重构后 pain.test.ts 出现行为回归：stage 枚举值从 gate_admitted/triage_evidence_only 改为 trigger_rejected，导致2条现有测试断言失败；auto-entry-gate 集成测试 TC2 中 repeated failures 不再触发诊断，emitSync 未被调用，行为等价承诺破裂' }],
    recommendations: [
      { kind: 'principle', description: '重构或修改核心契约前，必须全面评估影响范围并建立向后兼容机制，避免破坏性变更直接波及下游依赖。', recommendationRef: 'principle-1', abstractedPrinciple: '重构或修改核心契约前，必须全面评估影响范围并建立向后兼容机制，避免破坏性变更直接波及下游依赖。' },
      {
        kind: 'rule',
        description: '当代码涉及枚举值、接口签名或核心控制流条件判断变更时，强制触发影响面扫描与契约验证流程。',
        recommendationRef: 'rule-1',
        triggerPattern: 'enum.*change|interface.*modify|stage.*value.*update|contract.*break',
        action: '执行静态依赖分析并运行下游集成测试套件，确认行为等价性后方可合并。',
        principleAssociation: { status: 'linked', relation: 'implements', target: { type: 'recommendation_ref', recommendationRef: 'principle-1' }, rationale: '该规则把「重构前必须评估影响面并保障兼容」的原则落实为可拦截的具体触发条件与动作。', evidenceRefs: ['owner_reported:cli'] },
      },
      { kind: 'implementation', description: '在核心控制流与底层枚举之间引入版本兼容层或适配器模式，隔离重构变更对下游逻辑的直接冲击。', recommendationRef: 'implementation-1' },
    ],
    confidence: 0.85,
    ambiguityNotes: ['Fixture: R6 — PRI-363 refactor behavior regression (stage enum change broke tests)', '关联核心公理: T-01 (先理解结构再修改), T-07 (限制爆炸半径)'],
  },
};

const API_KEY_ENV = 'PD_P101_TELEMETRY_KEY';
const EVENT_TYPE = 'diag_router_trusted_context_unavailable';
/** Not in CRITICAL_EVENT_ALLOWLIST — must never be written to disk. */
const NON_ALLOWLISTED_EVENT = 'diag_router_task_leased';

const mockGetModel = getModel as ReturnType<typeof vi.fn>;
const mockComplete = completeSimple as ReturnType<typeof vi.fn>;

function makeAssistantMessage(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    role: 'assistant' as const,
    stopReason: 'stop' as const,
    api: 'openai-completions',
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
  };
}

/** Parent (`diagnosis_<painId>`) id recovered from the Stage A prompt. */
function parentTaskIdFromPrompt(content: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return ''; }
  if (parsed === null || typeof parsed !== 'object') return '';
  const taskId = Reflect.get(parsed, 'taskId');
  if (typeof taskId !== 'string') return '';
  return taskId.startsWith('diag_rootcause-') ? taskId.slice('diag_rootcause-'.length) : taskId;
}

let parentTaskId = '';
let currentSourceRef = 'owner_reported:cli';
const SCHEMA_REFS = ['diag-rootcause-output', 'diag-distiller-output', 'diag-router-output'] as const;
type LogicalStage = 'rootcause' | 'distiller' | 'router';

function resetProviderStages(): void {
  parentTaskId = '';
  currentSourceRef = 'owner_reported:cli';
}

/** The evidence ref the root-cause validator will accept for this payload. */
function sourceRefFromPrompt(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed !== null && typeof parsed === 'object') {
      const refs = Reflect.get(parsed, 'sourceRefs');
      if (Array.isArray(refs)) {
        const first = refs.find((ref): ref is string => typeof ref === 'string' && ref.trim().length > 0);
        if (first) return first;
      }
      const target = Reflect.get(parsed, 'diagnosisTarget');
      if (target !== null && typeof target === 'object') {
        const evidence = Reflect.get(target, 'evidence');
        if (Array.isArray(evidence)) {
          for (const entry of evidence) {
            if (entry !== null && typeof entry === 'object') {
              const ref = Reflect.get(entry, 'sourceRef');
              if (typeof ref === 'string' && ref.trim().length > 0) return ref;
            }
          }
        }
      }
    }
  } catch { /* fall through */ }
  return 'owner_reported:cli';
}

function logicalStageFor(content: string, lastStage: LogicalStage): LogicalStage {
  // Output-path probing and schema repair re-send the SAME logical prompt, so
  // dispatch on the persisted prompt content — never on a raw call counter.
  if (content.includes(SCHEMA_REFS[0])) return 'rootcause';
  if (content.includes(SCHEMA_REFS[1])) return 'distiller';
  if (content.includes(SCHEMA_REFS[2])) return 'router';
  // The router prompt embeds both predecessors AND trustedContext, so it must
  // be matched before the distiller-only `rootCauseArtifactId` marker.
  if (content.includes('"trustedContext"')) return 'router';
  if (content.includes('"rootCauseArtifactId"')) return 'distiller';
  if (content.startsWith('This is a schema validation repair loop')) return lastStage;
  return 'rootcause';
}

function wireScriptedProvider(): void {
  let lastStage: LogicalStage = 'rootcause';
  mockComplete.mockImplementation(async (_model: unknown, context: { messages?: { content?: unknown }[] }) => {
    const content = typeof context.messages?.[0]?.content === 'string' ? context.messages[0].content as string : '';
    const stage = logicalStageFor(content, lastStage);
    lastStage = stage;

    if (stage === 'rootcause') {
      if (!parentTaskId) parentTaskId = parentTaskIdFromPrompt(content);
      currentSourceRef = sourceRefFromPrompt(content);
      const output = {
        ...MOCK_ROOT_CAUSE_OUTPUTS.R6,
        diagnosisId: 'diag-p101',
        taskId: `diag_rootcause-${parentTaskId}`,
        causalChain: MOCK_ROOT_CAUSE_OUTPUTS.R6.causalChain.map((step) => ({ ...step, evidenceRefs: [currentSourceRef] })),
        evidence: [{ ...MOCK_ROOT_CAUSE_OUTPUTS.R6.evidence[0], sourceRef: currentSourceRef }],
      };
      return makeAssistantMessage(JSON.stringify(output));
    }
    if (stage === 'distiller') {
      let rootCauseArtifactId = '';
      try { rootCauseArtifactId = String(Reflect.get(JSON.parse(content), 'rootCauseArtifactId') ?? ''); } catch { /* handled below */ }
      if (!rootCauseArtifactId) throw new Error('distiller prompt missing rootCauseArtifactId');
      return makeAssistantMessage(JSON.stringify({
        ...MOCK_DISTILLER_OUTPUTS.R6,
        taskId: `diag_distiller-${parentTaskId}`,
        sourceRootCauseArtifactId: rootCauseArtifactId,
      }));
    }
    // The Router already assembled its context (and emitted the unavailable
    // event) before this provider call. Restore the ledger now so the later,
    // unrelated candidate-intake stage is not broken by the fixture.
    repairLedger(tmpDir);
    return makeAssistantMessage(JSON.stringify({
      ...MOCK_ROUTER_OUTPUTS.R6,
      diagnosisId: 'diag-p101',
      evidence: [{ ...MOCK_ROUTER_OUTPUTS.R6.evidence[0], sourceRef: currentSourceRef }],
      // This fixture only exercises telemetry + intake success; the
      // `implementation` candidate kind is MVP-disabled downstream and would
      // make `pd pain record` exit non-zero for an unrelated reason.
      recommendations: MOCK_ROUTER_OUTPUTS.R6.recommendations
        .filter((rec) => rec.kind !== 'implementation')
        .map((rec) => ('principleAssociation' in rec && rec.principleAssociation
          ? { ...rec, principleAssociation: { ...rec.principleAssociation, evidenceRefs: [currentSourceRef] } }
          : rec)),
    }));
  });
}

function writeConfig(workspaceDir: string): void {
  const pdDir = path.join(workspaceDir, '.pd');
  fs.mkdirSync(pdDir, { recursive: true });
  fs.writeFileSync(path.join(pdDir, 'config.yaml'), [
    'version: 1',
    'features:',
    '  prompt:',
    '    category: core',
    '    enabled: true',
    '  code_tool_hook:',
    '    category: core',
    '    enabled: true',
    '  defer_archive:',
    '    category: core',
    '    enabled: true',
    '  correction_observer:',
    '    category: quiet',
    '    enabled: false',
    '  gfi:',
    '    category: quiet',
    '    enabled: false',
    '  nocturnal:',
    '    category: gone',
    '    enabled: false',
    '  idle_trigger:',
    '    category: gone',
    '    enabled: false',
    '  model_training:',
    '    category: gone',
    '    enabled: false',
    '  trainer:',
    '    category: gone',
    '    enabled: false',
    'runtimeProfiles:',
    '  pi-ai.test:',
    '    type: pi-ai',
    '    provider: openrouter',
    '    model: anthropic/claude-sonnet-4',
    `    apiKeyEnv: ${API_KEY_ENV}`,
    '    timeoutMs: 30000',
    'internalAgents:',
    '  defaultRuntime: pi-ai.test',
    '  agents:',
    '    diagnostician:',
    '      enabled: true',
    '      runtimeProfile: pi-ai.test',
    '',
  ].join('\n'), 'utf8');
}

/**
 * Real "unavailable" condition: the principle-tree ledger on disk is not
 * parseable, so the Router cannot expose trusted context.
 *
 * The same file is also the intake ledger authority. `repairLedger()` below is
 * called from the router provider call, which happens AFTER the Router has
 * assembled its context (and emitted the telemetry event) but BEFORE candidate
 * intake runs. That keeps the real failure mode without permanently breaking a
 * later, unrelated stage.
 */
function corruptLedger(workspaceDir: string): void {
  const stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'principle_training_state.json'), '{ this is not json', 'utf8');
}

/** Restore a readable (empty) ledger so post-router intake can succeed. */
function repairLedger(workspaceDir: string): void {
  const stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'principle_training_state.json'), '{}', 'utf8');
}

async function seedDiagnosticianTask(workspaceDir: string, painId: string, status: 'pending' | 'failed'): Promise<string> {
  const taskId = createDiagnosticianTaskId(painId);
  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  try {
    await stateManager.createTask({
      taskId,
      taskKind: 'diagnostician',
      inputRef: painId,
      status,
      attemptCount: 1,
      maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        sourcePainId: painId,
        reasonSummary: 'production entry telemetry test',
        source: 'cli',
        severity: 'moderate',
        sessionIdHint: null,
        agentIdHint: null,
        provenance: 'owner_reported_no_host_trace',
        provenanceReason: 'No authenticated host session provenance available for CLI-submitted pain; fullTrace unavailable',
        evidence: [{ sourceRef: 'owner_reported:cli', note: 'test evidence' }],
        workspaceDir,
      }),
    });
  } finally {
    stateManager.close();
  }
  return taskId;
}

function readEvents(workspaceDir: string): Record<string, unknown>[] {
  const sink = path.join(workspaceDir, '.pd', 'telemetry', 'critical-events.jsonl');
  expect(fs.existsSync(sink), `critical-events.jsonl must exist at ${sink}\n${capturedLogs.join('\n')}`).toBe(true);
  // Persistence must not silently degrade — the emitter reports failures to stderr.
  expect(capturedLogs.join('\n'), 'critical telemetry persistence must not degrade').not.toContain('[PD:telemetry] WARNING');
  return fs.readFileSync(sink, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

let tmpDir = '';
const emittedToStore: { eventType?: unknown }[] = [];
const capturedLogs: string[] = [];
const exitCodes: number[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-p101-telemetry-'));
  writeConfig(tmpDir);
  corruptLedger(tmpDir);
  process.env[API_KEY_ENV] = 'test-key-123';
  mockGetModel.mockReturnValue({ id: 'anthropic/claude-sonnet-4' });
  resetProviderStages();
  wireScriptedProvider();
  emittedToStore.length = 0;
  capturedLogs.length = 0;
  exitCodes.length = 0;
  vi.spyOn(storeEmitter, 'emitTelemetry').mockImplementation(((event: { eventType?: unknown; payload?: unknown }) => {
    emittedToStore.push(event);
    return true;
  }) as never);
  for (const method of ['log', 'error', 'warn'] as const) {
    vi.spyOn(console, method).mockImplementation(((...args: unknown[]) => {
      capturedLogs.push(`[${method}] ${args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')}`);
    }) as never);
  }
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    capturedLogs.push(`[stderr] ${String(chunk)}`);
    return true;
  }) as never);
});

afterEach(() => {
  delete process.env[API_KEY_ENV];
  vi.restoreAllMocks();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows handle release */ }
});

/**
 * Runs a real handler and returns its exit code. A non-zero exit is allowed
 * here ONLY because the deliberately corrupt ledger is also the ledger intake
 * writes to; the telemetry assertions below prove the event was persisted
 * before that refusal.
 */
async function runHandler(run: () => Promise<void>): Promise<number> {
  try {
    await Promise.race([
      run(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('handler harness timeout')), 20_000)),
    ]);
  } catch (err) {
    if (err instanceof Error && err.message === 'handler harness timeout') {
      throw new Error(`handler did not finish\n${capturedLogs.join('\n')}`);
    }
    // Handlers may terminate via process.exit on failure. Rethrow anything that
    // is NOT an exit so a genuine crash is not silently swallowed.
    if (!(err instanceof Error) || !err.message.startsWith('process.exit(')) throw err;
    const failedExit = exitCodes.find((code) => code !== 0);
    if (failedExit !== undefined) {
      // The only tolerated failure is the deliberate corrupt-ledger refusal.
      const ledgerRefusal = capturedLogs.some((line) => line.includes('intake_failed') || line.includes('Expected property name'));
      if (!ledgerRefusal) throw new Error(`handler exited with code ${failedExit}\n${capturedLogs.join('\n')}`);
      return failedExit;
    }
  }
  return exitCodes.find((code) => code !== 0) ?? 0;
}

describe('PRI-1146 P1-01 — diag_router_trusted_context_unavailable reaches disk from every production entry', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCodes.push(code ?? 0);
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  it('pd diagnose run persists the router event and forwards it to StoreEventEmitter', async () => {
    const painId = 'p101-diagnose';
    const taskId = await seedDiagnosticianTask(tmpDir, painId, 'pending');

    const exitCode = await runHandler(() => handleDiagnoseRun({ taskId, workspace: tmpDir, json: true, intake: false }));
    expect(exitCode).toBe(0);

    const events = readEvents(tmpDir);
    const routerEvent = events.find((event) => event.eventType === EVENT_TYPE);
    expect(routerEvent, `expected ${EVENT_TYPE} in ${JSON.stringify(events.map((e) => e.eventType))}`).toBeDefined();
    expect(routerEvent?.traceId).toBe(`diag_router-${taskId}`);
    expect(String((routerEvent?.payload as { reason?: unknown } | undefined)?.reason)).toMatch(/^ledger_(corrupt|unavailable)$/);
    const timestamp = Date.parse(String(routerEvent?.timestamp));
    expect(Number.isFinite(timestamp)).toBe(true);
    expect(Date.now() - timestamp).toBeLessThan(120_000);

    // Non-allowlisted runner telemetry must stay out of the durable file...
    expect(events.map((event) => event.eventType)).not.toContain(NON_ALLOWLISTED_EVENT);
    // ...but the original StoreEventEmitter path must still receive it.
    expect(emittedToStore.map((event) => event.eventType)).toContain(NON_ALLOWLISTED_EVENT);
    expect(emittedToStore.map((event) => event.eventType)).toContain(EVENT_TYPE);
    // The event never becomes a second persistence surface for non-critical data.
    expect(events.every((event) => event.eventType === EVENT_TYPE || event.eventType === 'replay_review_source_invalid')).toBe(true);
  }, 60_000);

  it('pd pain record persists the router event through the full bridge chain', async () => {
    const exitCode = await runHandler(() => handlePainRecord({ reason: 'production entry telemetry test', workspace: tmpDir, json: true, wait: true }));
    expect(exitCode).toBe(0);

    const events = readEvents(tmpDir);
    const routerEvent = events.find((event) => event.eventType === EVENT_TYPE);
    expect(routerEvent, `expected ${EVENT_TYPE} in ${JSON.stringify(events.map((e) => e.eventType))}`).toBeDefined();
    expect(String(routerEvent?.traceId)).toMatch(/^diag_router-diagnosis_/);
    expect(String((routerEvent?.payload as { reason?: unknown } | undefined)?.reason)).toMatch(/^ledger_(corrupt|unavailable)$/);
    const timestamp = Date.parse(String(routerEvent?.timestamp));
    expect(Date.now() - timestamp).toBeLessThan(120_000);

    expect(events.map((event) => event.eventType)).not.toContain(NON_ALLOWLISTED_EVENT);
    expect(emittedToStore.map((event) => event.eventType)).toContain(NON_ALLOWLISTED_EVENT);
    expect(emittedToStore.map((event) => event.eventType)).toContain(EVENT_TYPE);
  }, 60_000);

  it('pd pain retry persists the router event and keeps StoreEventEmitter intact', async () => {
    const painId = 'p101-retry';
    const taskId = await seedDiagnosticianTask(tmpDir, painId, 'failed');

    const exitCode = await runHandler(() => handlePainRetry({ painId, workspace: tmpDir, json: true }));
    expect([0, 1]).toContain(exitCode);

    const events = readEvents(tmpDir);
    const routerEvent = events.find((event) => event.eventType === EVENT_TYPE);
    expect(routerEvent, `expected ${EVENT_TYPE} in ${JSON.stringify(events.map((e) => e.eventType))}`).toBeDefined();
    expect(routerEvent?.traceId).toBe(`diag_router-${taskId}`);
    expect(String((routerEvent?.payload as { reason?: unknown } | undefined)?.reason)).toMatch(/^ledger_(corrupt|unavailable)$/);
    const timestamp = Date.parse(String(routerEvent?.timestamp));
    expect(Date.now() - timestamp).toBeLessThan(120_000);

    expect(events.map((event) => event.eventType)).not.toContain(NON_ALLOWLISTED_EVENT);
    expect(emittedToStore.map((event) => event.eventType)).toContain(NON_ALLOWLISTED_EVENT);
    expect(emittedToStore.map((event) => event.eventType)).toContain(EVENT_TYPE);
  }, 60_000);
});
