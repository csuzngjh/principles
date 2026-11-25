/**
 * CANARY_TURN_TEXT through the REAL OpenClaw plugin entry —
 * SPEC-PD-PIPELINE-SPINE-001 v0.9 §4.5 Layer C / review round 2 (PRI-1291).
 *
 * Entry under test: the plugin `/pd-pain` report command (`handlePainReportCommand`)
 * over a REAL WorkspaceContext whose `trajectory` is the plugin's own
 * TrajectoryDatabase (the ordinary OpenClaw session store: `assistant_turns`
 * + `user_turns`). The command builds the REAL synchronous
 * PainToPrincipleService with the D1 collaborator set — the in-process reader
 * over `WorkspaceContext.trajectory` and the consent-ledger authorization —
 * and the real pipeline runs. Only PiAiRuntimeAdapter's network methods are
 * scripted.
 *
 * Property: the Owner's turn of the ordinary OpenClaw session is read through
 * the plugin's reader and arrives verbatim in the Stage A request body
 * (pre-D1 this entry wired NO reader, so no session text could reach the
 * model). An OpenClaw ordinary session is not a consent-governed host —
 * the consent ledger gates codex / workbuddy governance material — so this
 * leg proves the READ path; the revocation boundary is covered by the
 * codex-bound legs (host-runtime prompt canary, pd-mcp-server canary).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'node:crypto';
import {
  PiAiRuntimeAdapter,
  RuntimeStateManager,
  SqliteConnection,
  getDefaultPdConfig,
  disposePainSignalBridgesForWorkspace,
} from '@principles/core/runtime';
import {
  MOCK_ROOT_CAUSE_OUTPUTS,
  MOCK_DISTILLER_OUTPUTS,
  MOCK_ROUTER_OUTPUTS,
} from '../../principles-core/src/runtime/adapter/split-pipeline-fixtures.js';
import { handlePainReportCommand } from '../src/commands/pain.js';
import { WorkspaceContext } from '../src/core/workspace-context.js';
import { TrajectoryRegistry } from '../src/core/trajectory.js';
import { SystemLogger, disposeAllSystemLoggers } from '../src/core/system-logger.js';

const CANARY_TURN_TEXT = 'CANARY_TURN_TEXT_8e5f the agent bypassed the review gate';
const CANARY_REASON = 'CANARY_REASON_9f3a owner review skipped before destructive change';
const SESSION = 'sess-openclaw-canary';
const ENV_KEY = 'PD_OPENCLAW_TURN_TEXT_CANARY_KEY';

const previousWorkspaceDir = process.env.PD_WORKSPACE_DIR;
const previousOpenclawConfigPath = process.env.OPENCLAW_CONFIG_PATH;
let workspaceDir = '';
let startRunInputs: string[] = [];

/** Script the LLM boundary; record every request body; the scripted model
 * output cites exactly the evidence the request itself carried (the
 * pipeline binds every cited ref to the trusted diagnosis context). */
function installRecordingAdapterSpy(): void {
  const runIdToTaskId = new Map<string, string>();
  let counter = 0;
  let rootCauseTaskId: string | null = null;
  const trustedEvidenceOf = (): { sourceRef: string; note: string }[] => {
    const last = startRunInputs.findLast((recorded) => (JSON.parse(recorded) as { outputSchemaRef?: string }).outputSchemaRef === 'diag-rootcause-output');
    if (last === undefined) return [];
    const prompt = JSON.parse(String((JSON.parse(last) as { inputPayload?: string }).inputPayload ?? '')) as { diagnosisTarget?: { evidence?: { sourceRef: string; note: string }[] } };
    return prompt.diagnosisTarget?.evidence ?? [];
  };
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'getCapabilities').mockResolvedValue({
    supportsStructuredJsonOutput: true, supportsToolUse: false, supportsWorkingDirectory: false,
    supportsModelSelection: false, supportsLongRunningSessions: false, supportsCancellation: true,
    supportsArtifactWriteBack: false, supportsConcurrentRuns: false, supportsStreaming: false,
  });
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'healthCheck').mockResolvedValue({
    healthy: true, degraded: false, warnings: [], lastCheckedAt: new Date().toISOString(),
  });
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'startRun').mockImplementation(async (input) => {
    counter += 1;
    const runId = `canary-run-${counter}`;
    const taskId = input.taskRef?.taskId;
    if (typeof taskId === 'string') runIdToTaskId.set(runId, taskId);
    startRunInputs.push(JSON.stringify(input));
    return {
      runId, runtimeKind: 'pi-ai', startedAt: new Date().toISOString(),
      systemPromptDigest: createHash('sha256').update(input.systemPrompt ?? '', 'utf8').digest('hex'),
    };
  });
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'pollRun').mockImplementation(async (runId: string) => ({
    runId, status: 'succeeded' as const, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
  }));
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'fetchOutput').mockImplementation(async (runId: string) => {
    const taskId = runIdToTaskId.get(runId);
    const trusted = trustedEvidenceOf();
    const cited = trusted.map((entry) => entry.sourceRef);
    if (taskId !== undefined && taskId.includes('diag_distiller')) {
      const sourceRootCauseArtifactId = `pi-art-${rootCauseTaskId ?? ''}-run_${rootCauseTaskId ?? ''}_1`;
      return { runId, payload: { ...MOCK_DISTILLER_OUTPUTS.R6, taskId, sourceRootCauseArtifactId } };
    }
    if (taskId !== undefined && taskId.includes('diag_router')) {
      return {
        runId,
        payload: {
          ...MOCK_ROUTER_OUTPUTS.R6,
          evidence: trusted,
          recommendations: MOCK_ROUTER_OUTPUTS.R6.recommendations.filter((rec) => rec.kind === 'principle'),
        },
      };
    }
    rootCauseTaskId = taskId ?? null;
    const r6 = MOCK_ROOT_CAUSE_OUTPUTS.R6;
    return {
      runId,
      payload: {
        ...r6,
        taskId: taskId ?? 'canary-task',
        evidence: trusted,
        causalChain: r6.causalChain.map((entry) => ({ ...entry, evidenceRefs: cited })),
      },
    };
  });
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'fetchArtifacts').mockResolvedValue([]);
}

function stageAConversationTexts(): string[] {
  return startRunInputs
    .map((recorded) => JSON.parse(recorded) as { outputSchemaRef?: string; inputPayload?: string })
    .filter((input) => input.outputSchemaRef === 'diag-rootcause-output')
    .map((input) => JSON.parse(String(input.inputPayload ?? '')) as { conversationWindow?: { text?: unknown }[] })
    .flatMap((prompt) => (Array.isArray(prompt.conversationWindow) ? prompt.conversationWindow : []))
    .map((entry) => entry?.text)
    .filter((text): text is string => typeof text === 'string');
}

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-openclaw-turn-text-canary-'));
  // pin the PD explicit workspace so command-side resolution cannot divert
  // to a real host workspace on a dev machine
  process.env.PD_WORKSPACE_DIR = workspaceDir;
  const openclawConfigPath = path.join(workspaceDir, 'openclaw-test-config.json');
  fs.writeFileSync(openclawConfigPath, JSON.stringify({ plugins: { entries: { 'principles-disciple': { hooks: { allowConversationAccess: true } } } } }));
  process.env.OPENCLAW_CONFIG_PATH = openclawConfigPath;
  const config = getDefaultPdConfig() as ReturnType<typeof getDefaultPdConfig> & {
    features: Record<string, { enabled?: boolean } & Record<string, unknown>>;
    runtimeProfiles: Record<string, unknown>;
    internalAgents: { defaultRuntime: string };
  };
  config.features = { ...config.features, intent_engineering: { ...config.features.intent_engineering, enabled: true } };
  config.runtimeProfiles = {
    ...config.runtimeProfiles,
    'pd.default': { type: 'pi-ai', provider: 'canary-prov', model: 'canary-model', apiKeyEnv: ENV_KEY, baseUrl: 'http://127.0.0.1:8080/v1' },
  };
  config.internalAgents.defaultRuntime = 'pd.default';
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
  process.env[ENV_KEY] = 'test-key';
  // prime state.db so the plugin's controllers find their tables
  const prime = new SqliteConnection({ workspaceDir });
  prime.getDb();
  prime.close();
  // an ORDINARY OpenClaw session: an assistant turn and the Owner's turn
  TrajectoryRegistry.use(workspaceDir, (db) => {
    const assistantTurnId = db.recordAssistantTurn({
      sessionId: SESSION, runId: 'run-canary', provider: 'canary-prov', model: 'canary-model',
      rawText: 'assistant output before the Owner spoke', sanitizedText: 'assistant output before the Owner spoke',
      usageJson: {}, empathySignalJson: {},
    });
    db.recordUserTurn({
      sessionId: SESSION, turnIndex: 1, rawText: CANARY_TURN_TEXT,
      correctionDetected: false, correctionCue: null, referencesAssistantTurnId: assistantTurnId,
    });
  });
  startRunInputs = [];
  disposeAllSystemLoggers();
  vi.spyOn(SystemLogger, 'log').mockImplementation(() => undefined);
  installRecordingAdapterSpy();
});

afterEach(async () => {
  vi.restoreAllMocks();
  WorkspaceContext.dispose(workspaceDir);
  disposeAllSystemLoggers();
  if (previousWorkspaceDir === undefined) delete process.env.PD_WORKSPACE_DIR;
  else process.env.PD_WORKSPACE_DIR = previousWorkspaceDir;
  delete process.env[ENV_KEY];
  if (previousOpenclawConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
  else process.env.OPENCLAW_CONFIG_PATH = previousOpenclawConfigPath;
  await disposePainSignalBridgesForWorkspace(workspaceDir).catch(() => undefined);
  try {
    fs.rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // Windows handle latency; the vitest temp keeper sweeps leftovers
  }
});

describe('CANARY_TURN_TEXT through the real OpenClaw plugin entry (ordinary session)', () => {
  it('the Owner turn of the ordinary OpenClaw session reaches the Stage A request body through the plugin reader', async () => {
    const result = await handlePainReportCommand({
      args: CANARY_REASON,
      config: { workspaceDir, language: 'en' },
      sessionId: SESSION,
    } as never);

    // the command reported a recorded, context-bound pain (the run succeeded)
    expect(result.text).toContain('Pain recorded (context-bound)');
    expect(result.text).toContain(`**Session**: ${SESSION}`);

    // the Owner turn of the ordinary session is IN the conversation window of
    // the Stage A request body — read through the plugin's own reader
    const texts = stageAConversationTexts();
    expect(texts).toContain(CANARY_TURN_TEXT);
    // … together with the assistant turn it answers (the same session)
    expect(texts).toContain('assistant output before the Owner spoke');

    // the persisted diagnosis records the source session
    const state = new RuntimeStateManager({ workspaceDir });
    await state.initialize();
    try {
      const tasks = await state.listTasks();
      const parent = tasks.find((task) => task.taskKind === 'diagnostician');
      const persisted = JSON.parse(parent?.diagnosticJson ?? '{}') as { sessionIdHint?: string; hostKind?: string };
      expect(persisted.sessionIdHint).toBe(SESSION);
      expect(persisted.hostKind).toBe('openclaw');
    } finally {
      await state.close();
    }
  }, 180_000);
});
