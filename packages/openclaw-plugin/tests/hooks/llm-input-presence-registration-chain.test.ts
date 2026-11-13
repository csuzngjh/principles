import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SqliteActivationStateStore,
  SqliteConnection,
  SqlitePIArtifactStore,
  SqliteTaskStore,
} from '@principles/core/runtime';
import { TrajectoryRegistry } from '../../src/core/trajectory.js';
import { resolvePdPath } from '../../src/core/paths.js';

/**
 * PRI-1152 B2: the presence observation through the REAL plugin registration.
 *
 * The earlier presence tests drove makeLlmInputPresenceRegistration /
 * handleLlmInputPresence directly, so they stayed green while the production
 * entry was a guardHook no-op (hook:llm_input_presence was not classified in
 * PLUGIN_SURFACE_REGISTRY). This suite enters where the host enters:
 *
 *   plugin.register(api)
 *   → captured before_prompt_build (shared route, final assembly, presence freeze)
 *   → captured llm_input (guardHook → workspace resolution → snapshot binding
 *     → presence check)
 *   → REAL EventLog → events_<date>.jsonl in the workspace state dir
 *
 * Only boot services that would reach the machine are mocked (same policy as
 * prompt-production-chain.test.ts); the event log is NOT mocked.
 */

vi.mock('../../src/hooks/pain.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/hooks/pain.js')>();
  return { ...actual, emitPainDetectedEvent: vi.fn().mockResolvedValue(undefined) };
});

// The workspace-context seam supplies the REAL EventLog for the workspace's
// canonical state dir and the REAL trajectory database; nothing is captured.
vi.mock('../../src/core/workspace-context.js', async () => {
  const { TrajectoryRegistry: Registry } = await import('../../src/core/trajectory.js');
  const { EventLogService } = await import('../../src/core/event-log.js');
  const { resolvePdPath: pdPath } = await import('../../src/core/paths.js');
  const buildContext = () => ({
    workspaceDir: tempWorkspaceDir,
    stateDir: pdPath(tempWorkspaceDir, 'STATE_DIR'),
    resolve: (key: string) => path.join(tempWorkspaceDir, '.principles', key),
    config: { get: vi.fn(() => undefined) },
    eventLog: EventLogService.get(pdPath(tempWorkspaceDir, 'STATE_DIR')),
    evolutionReducer: { getActivePrinciples: vi.fn(() => []), getProbationPrinciples: vi.fn(() => []) },
    trajectory: new Proxy({}, {
      get: (_target, prop) => {
        const db = Registry.get(tempWorkspaceDir);
        const value = Reflect.get(db as object, prop);
        return typeof value === 'function' ? value.bind(db) : value;
      },
    }),
  });
  return {
    WorkspaceContext: {
      fromHookContext: vi.fn(() => buildContext()),
      fromHookContextExplicit: vi.fn(() => buildContext()),
    },
  };
});

vi.mock('../../src/core/diagnostician-task-store.js', () => ({
  getPendingDiagnosticianTasks: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/core/session-tracker.js', () => ({
  getSession: vi.fn().mockReturnValue({ currentGfi: 20 }),
  resetFriction: vi.fn(),
  trackFriction: vi.fn(),
  decayGfi: vi.fn(),
  getGfiDecayElapsed: vi.fn().mockReturnValue(0),
  setInjectedPrincipleIds: vi.fn(),
  trackSessionControlActivity: vi.fn(),
}));

vi.mock('../../src/core/path-resolver.js', () => ({
  PathResolver: {
    getExtensionRoot: vi.fn(() => tempExtensionRoot),
    setExtensionRoot: vi.fn(),
  },
}));

// The post-register health check would write mcp-binding.json; keep it inert.
vi.mock('../../src/core/mcp-binding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/mcp-binding.js')>();
  return {
    ...actual,
    ensureMcpBinding: vi.fn(() => ({ ok: true, written: false })),
    invalidateMcpBinding: vi.fn(() => ({ ok: true, removed: false })),
  };
});

vi.mock('../../src/core/focus-history.js', () => ({
  extractSummary: vi.fn().mockReturnValue(''),
  getHistoryVersions: vi.fn().mockResolvedValue([]),
  parseWorkingMemorySection: vi.fn().mockReturnValue(null),
  workingMemoryToInjection: vi.fn().mockReturnValue(''),
  autoCompressFocus: vi.fn().mockReturnValue({ compressed: false, reason: 'not_needed' }),
  safeReadCurrentFocus: vi.fn().mockReturnValue({ content: '', recovered: false, validationErrors: [] }),
}));

vi.mock('../../src/core/empathy-keyword-matcher.js', () => ({
  matchEmpathyKeywords: vi.fn().mockReturnValue({ score: 0, matched: null, severity: 'none', matchedTerms: [] }),
  loadKeywordStore: vi.fn().mockReturnValue({ terms: {}, stats: { totalHits: 0 } }),
  saveKeywordStore: vi.fn(),
  shouldTriggerOptimization: vi.fn().mockReturnValue(false),
  getKeywordStoreSummary: vi.fn().mockReturnValue({ totalTerms: 0, highFalsePositiveTerms: [] }),
}));

vi.mock('../../src/core/empathy-types.js', () => ({
  severityToPenalty: vi.fn().mockReturnValue(5),
  DEFAULT_EMPATHY_KEYWORD_CONFIG: {},
}));

vi.mock('../../src/core/correction-cue-learner.js', () => ({
  CorrectionCueLearner: { get: vi.fn().mockReturnValue({ recordTruePositive: vi.fn(), flush: vi.fn() }) },
}));

vi.mock('../../src/core/migration.js', () => ({ migrateDirectoryStructure: vi.fn() }));
vi.mock('../../src/core/init.js', () => ({ ensureWorkspaceTemplates: vi.fn() }));
vi.mock('../../src/core/system-logger.js', () => ({ SystemLogger: { log: vi.fn() } }));
vi.mock('../../src/service/correction-observer-service.js', () => ({
  CorrectionObserverService: { start: vi.fn() },
}));
vi.mock('../../src/service/internalization-auto-consumer-service.js', () => ({
  InternalizationAutoConsumerService: { start: vi.fn() },
  persistOpenClawToolDeclaration: vi.fn(),
}));
vi.mock('../../src/core/product-telemetry-trigger.js', () => ({
  scheduleTelemetryExportForWorkspace: vi.fn(),
}));

const { default: plugin } = await import('../../src/index.js');

const PRESENCE_EVENT_TYPE = 'runtime_v2_prompt_presence_observed';
const PRINCIPLE_ID = 'PRI1152-B2-CHAIN';
const ARTIFACT_ID = 'art-pri1152-b2-chain';
const ACTIVATION_ID = 'act-pri1152-b2-chain';
const PRINCIPLE_TEXT = 'PRI-1152 B2 注册链夹具：提交前核对 <presence> 标记与 & 符号。';

let tempRoot = '';
let tempWorkspaceDir = '';
let tempExtensionRoot = '';
let hooks: Map<string, (event: unknown, ctx: unknown) => unknown>;
let fakeLogger: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
const priorPdWorkspaceDir = process.env.PD_WORKSPACE_DIR;

async function seedPrinciple(workspaceDir: string): Promise<void> {
  const connection = new SqliteConnection({ workspaceDir });
  try {
    const now = new Date().toISOString();
    const sourceTaskId = `task-${ARTIFACT_ID}`;
    await new SqliteTaskStore(connection).createTask({
      taskId: sourceTaskId, taskKind: 'diagnosis', status: 'pending', attemptCount: 0, maxAttempts: 3,
    });
    await new SqlitePIArtifactStore(connection).createArtifact({
      artifactId: ARTIFACT_ID,
      artifactKind: 'principle',
      sourceTaskId,
      sourcePrincipleId: PRINCIPLE_ID,
      lineageArtifactIds: [],
      validationStatus: 'validated',
      contentJson: JSON.stringify({ principleId: PRINCIPLE_ID, text: PRINCIPLE_TEXT, language: 'zh' }),
      createdAt: now,
      updatedAt: now,
    });
    await new SqliteActivationStateStore(connection).recordActivation({
      activationId: ACTIVATION_ID,
      idempotencyKey: `pri1152-b2-${ACTIVATION_ID}`,
      artifactId: ARTIFACT_ID,
      channel: 'prompt',
      action: 'prompt_activate',
      targetRef: `ledger://${PRINCIPLE_ID}`,
      activatedAt: now,
      promotedAt: now,
      deactivatedAt: null,
    });
  } finally {
    connection.close();
  }
}

function presenceEventLines(workspaceDir: string): { line: string; entry: Record<string, unknown> }[] {
  const logsDir = path.join(resolvePdPath(workspaceDir, 'STATE_DIR'), 'logs');
  if (!fs.existsSync(logsDir)) return [];
  return fs.readdirSync(logsDir)
    .filter((name) => name.startsWith('events_') && name.endsWith('.jsonl'))
    .flatMap((name) => fs.readFileSync(path.join(logsDir, name), 'utf8').split('\n'))
    .filter((line) => line.trim().length > 0)
    .map((line) => ({ line, entry: JSON.parse(line) as Record<string, unknown> }))
    .filter((row) => row.entry['type'] === PRESENCE_EVENT_TYPE);
}

function presenceSkipLines(): string[] {
  return [...fakeLogger.info.mock.calls, ...fakeLogger.warn.mock.calls]
    .map((call) => String(call[0]))
    .filter((message) => message.includes('SKIP hook:llm_input_presence'));
}

beforeEach(() => {
  vi.clearAllMocks();
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-b2-chain-'));
  tempWorkspaceDir = path.join(tempRoot, 'workspace');
  tempExtensionRoot = path.join(tempRoot, 'extension');
  fs.mkdirSync(path.join(tempWorkspaceDir, '.pd'), { recursive: true });
  fs.mkdirSync(tempExtensionRoot, { recursive: true });
  // Priority-1 explicit source: without it the resolver could pick the
  // machine's real PD workspace over the hook context.
  process.env.PD_WORKSPACE_DIR = tempWorkspaceDir;

  hooks = new Map();
  fakeLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const api = {
    id: 'principles-disciple',
    rootDir: tempExtensionRoot,
    pluginConfig: { language: 'zh' },
    // Authorized conversation access: the health check never rewrites a real config.
    config: { plugins: { entries: { 'principles-disciple': { hooks: { allowConversationAccess: true } } } } },
    logger: fakeLogger,
    registerCommand: vi.fn(), registerService: vi.fn(), registerTool: vi.fn(), registerHttpRoute: vi.fn(),
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { hooks.set(name, handler); },
  } as never;
  plugin.register(api);
});

afterEach(() => {
  if (priorPdWorkspaceDir === undefined) delete process.env.PD_WORKSPACE_DIR;
  else process.env.PD_WORKSPACE_DIR = priorPdWorkspaceDir;
  try { TrajectoryRegistry.dispose(tempWorkspaceDir); } catch { /* best-effort */ }
  try { fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); } catch { /* best-effort */ }
});

describe('PRI-1152 B2: llm_input presence through the real plugin registration', () => {
  it('the registered llm_input callback runs the observation and the real EventLog writes exactly one event', async () => {
    await seedPrinciple(tempWorkspaceDir);
    const beforePromptBuild = hooks.get('before_prompt_build');
    const llmInput = hooks.get('llm_input');
    expect(beforePromptBuild).toBeDefined();
    expect(llmInput).toBeDefined();

    const runId = 'b2-run-1';
    const sessionId = 'b2-session-1';
    const ctx = { workspaceDir: tempWorkspaceDir, trigger: 'user', sessionId, runId, agentId: 'agent-1' };
    const assembled = await beforePromptBuild?.({ prompt: 'hello', messages: [], trigger: 'user', sessionId, runId }, ctx) as
      { prependSystemContext?: string } | undefined;
    const prepend = assembled?.prependSystemContext ?? '';
    expect(prepend).toContain(`<directive id="${PRINCIPLE_ID}"`);

    // The host hands the plugin its final system prompt after assembly.
    llmInput?.({
      runId,
      sessionId,
      provider: 'pd-b2-provider',
      model: 'pd-b2-model',
      systemPrompt: `${prepend}\n\nYou are the host assistant.`,
      prompt: 'hello',
      historyMessages: [],
      imagesCount: 0,
    }, ctx);

    // The registered callback is the real handler, not the guardHook no-op.
    expect(presenceSkipLines()).toEqual([]);
    const events = presenceEventLines(tempWorkspaceDir);
    expect(events).toHaveLength(1);
    const data = events[0]?.entry['data'] as Record<string, unknown>;
    expect(data).toMatchObject({
      runId,
      sessionId,
      provider: 'pd-b2-provider',
      model: 'pd-b2-model',
      boundary: 'post_assembly_system_prompt_via_llm_input',
      binding: 'unique',
      checked: true,
    });
    expect(data['reason']).toBeUndefined();
    expect(data['results']).toEqual([expect.objectContaining({ activationId: ACTIVATION_ID, outcome: 'full_hit' })]);
    // Facts only: the event line carries no principle body.
    expect(events[0]?.line).not.toContain(PRINCIPLE_TEXT);
  });

  it('an llm_input callback for a run with no frozen assembly still records a degraded fact, never a hit', async () => {
    await seedPrinciple(tempWorkspaceDir);
    const llmInput = hooks.get('llm_input');
    const ctx = { workspaceDir: tempWorkspaceDir, trigger: 'user', sessionId: 'b2-session-orphan', runId: 'b2-run-orphan', agentId: 'agent-1' };
    llmInput?.({
      runId: 'b2-run-orphan', sessionId: 'b2-session-orphan', provider: 'pd-b2-provider', model: 'pd-b2-model',
      systemPrompt: 'no PD assembly here', prompt: 'hello', historyMessages: [], imagesCount: 0,
    }, ctx);
    expect(presenceSkipLines()).toEqual([]);
    const events = presenceEventLines(tempWorkspaceDir);
    expect(events).toHaveLength(1);
    const data = events[0]?.entry['data'] as Record<string, unknown>;
    expect(data).toMatchObject({ runId: 'b2-run-orphan', checked: false });
    expect(data['binding']).not.toBe('unique');
    expect(JSON.stringify(data['results'] ?? [])).not.toContain('full_hit');
  });
});
