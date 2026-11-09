/**
 * PRI-1152: the isolated-host execution pack's principle fixture, driven
 * offline through the REAL production chain the run will exercise:
 *
 *   formal-store fixture (the pack's own seeding module)
 *     -> host-runtime shared prompt route (real)
 *     -> plugin before_prompt_build final assembly + presence freeze (real)
 *     -> official-shaped llm_input event -> production handler (real)
 *     -> runtime_v2_prompt_presence_observed facts
 *
 * Only plugin internals unrelated to this chain are mocked (same pattern as
 * runtime-prompt-activation.test.ts). The body carries < > & " so the test
 * proves it is XML-escaped exactly once and never leaves memory as text.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildActivePrinciplePromptContext } from '@principles/host-runtime';
import { escapeXml } from '@principles/core/prompt-builder';
import type { EventLog } from '../../src/core/event-log.js';

interface PresenceFixtureModule {
  PRESENCE_FIXTURE: { principleId: string; artifactId: string; activationId: string; text: string };
  seedPresenceFixture: (workspaceDir: string) => Promise<{ stateDbSha256: string }>;
  inspectPresenceFixture: (workspaceDir: string) => Promise<Record<string, unknown> & { ok: boolean }>;
}
interface PresenceConfigModule {
  buildPresencePdConfigText: () => string;
}

const scriptsLib = (name: string): string =>
  new URL(`../../../../scripts/dev/aa-controlled-admission/lib/${name}`, import.meta.url).href;

let tempWorkspaceDir: string;

vi.mock('../../src/core/diagnostician-task-store.js', async () => ({
  getPendingDiagnosticianTasks: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/core/event-log.js', () => ({
  EventLogService: {
    get: vi.fn().mockReturnValue({
      recordHeartbeatDiagnosis: vi.fn(),
      recordRuntimeActivationsInjected: vi.fn(),
      recordAdaptiveDelivery: vi.fn(),
    }),
  },
}));

vi.mock('../../src/core/workspace-context.js', async () => {
  const { EventLogService } = await import('../../src/core/event-log.js');
  const mockEventLog = EventLogService.get('/mock');
  const context = () => ({
    workspaceDir: tempWorkspaceDir,
    stateDir: path.join(tempWorkspaceDir, '.principles'),
    resolve: (key: string) => path.join(tempWorkspaceDir, '.principles', key),
    trajectory: { recordSession: vi.fn(), recordUserTurn: vi.fn().mockReturnValue(1) },
    config: { get: vi.fn() },
    eventLog: mockEventLog,
    evolutionReducer: { getActivePrinciples: vi.fn(() => []), getProbationPrinciples: vi.fn(() => []) },
  });
  return {
    WorkspaceContext: {
      fromHookContext: vi.fn().mockImplementation(context),
      fromHookContextExplicit: vi.fn().mockImplementation(context),
    },
  };
});

vi.mock('../../src/core/session-tracker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/session-tracker.js')>();
  return {
    ...actual,
    getSession: vi.fn().mockReturnValue({ currentGfi: 0 }),
    resetFriction: vi.fn(),
    trackFriction: vi.fn(),
    decayGfi: vi.fn(),
    getGfiDecayElapsed: vi.fn().mockReturnValue(0),
  };
});

vi.mock('../../src/core/path-resolver.js', () => ({
  PathResolver: { getExtensionRoot: vi.fn().mockReturnValue('/fake/extension') },
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

vi.mock('../../src/core/focus-history.js', () => ({
  extractSummary: vi.fn().mockReturnValue(''),
  getHistoryVersions: vi.fn().mockResolvedValue([]),
  parseWorkingMemorySection: vi.fn().mockReturnValue(null),
  workingMemoryToInjection: vi.fn().mockReturnValue(''),
  autoCompressFocus: vi.fn().mockReturnValue({ compressed: false, reason: 'not_needed' }),
  safeReadCurrentFocus: vi.fn().mockReturnValue({ content: '', recovered: false, validationErrors: [] }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri1152-fixture-'));
});

afterEach(() => {
  try {
    fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
  } catch {
    // best-effort on Windows
  }
});

async function preparedWorkspace(): Promise<PresenceFixtureModule> {
  const fixture = (await import(scriptsLib('presence-fixture.mjs'))) as PresenceFixtureModule;
  const config = (await import(scriptsLib('presence-config.mjs'))) as PresenceConfigModule;
  fs.mkdirSync(path.join(tempWorkspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(tempWorkspaceDir, '.pd', 'config.yaml'), config.buildPresencePdConfigText());
  await fixture.seedPresenceFixture(tempWorkspaceDir);
  return fixture;
}

function ctxFor(runId: string, sessionId: string) {
  return {
    workspaceDir: tempWorkspaceDir,
    trigger: 'user',
    sessionId,
    runId,
    api: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, runtime: {}, config: {} },
  } as unknown as Parameters<typeof import('../../src/hooks/prompt.js').handleBeforePromptBuild>[1];
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('PRI-1152 isolated-host principle fixture — offline production chain', () => {
  it('pack inspection: formal stores, system_policy authority, no approvals row, single-escaped frozen directive', async () => {
    const fixture = await preparedWorkspace();
    const inspection = await fixture.inspectPresenceFixture(tempWorkspaceDir);
    expect(inspection.ok).toBe(true);
    expect(inspection).toMatchObject({ renderedAuthority: 'system_policy', approvalRows: 0, revisionEpoch: 0 });
  });

  it('fixture -> shared route -> final freeze -> llm_input handler -> unique full_hit with no body in the event', async () => {
    const fixture = await preparedWorkspace();
    const { PRESENCE_FIXTURE } = fixture;
    const escaped = escapeXml(PRESENCE_FIXTURE.text);

    const packed = await buildActivePrinciplePromptContext({ workspaceDir: tempWorkspaceDir });
    expect(packed.activationIds).toEqual([PRESENCE_FIXTURE.activationId]);

    const runId = 'pri1152-run-r1';
    const sessionId = 'pri1152-session-r1';
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const event = { prompt: 'x', messages: [], trigger: 'user', sessionId } as unknown as Parameters<typeof handleBeforePromptBuild>[0];
    const result = await handleBeforePromptBuild(event, ctxFor(runId, sessionId), packed);
    const assembled = result?.prependSystemContext ?? '';

    // Escaped exactly once in the final assembly; never raw, never double.
    expect(count(assembled, escaped)).toBe(1);
    expect(count(assembled, escapeXml(escaped))).toBe(0);
    expect(assembled).not.toContain(PRESENCE_FIXTURE.text);
    expect(assembled).not.toContain('<presence>');
    expect(assembled).toContain(`<directive id="${PRESENCE_FIXTURE.principleId}" source="runtime_v2_activation" authority="system_policy">`);

    const { handleLlmInputPresence } = await import('../../src/hooks/llm-input-presence.js');
    const recorded: Record<string, unknown>[] = [];
    handleLlmInputPresence({
      event: {
        runId,
        sessionId,
        provider: 'pdpresence-responses',
        model: 'isolated-presence-model',
        systemPrompt: assembled,
        prompt: '不是这个意思，我要的是另一种方案。',
        historyMessages: [],
        imagesCount: 0,
      },
      ctx: { runId, sessionId } as Parameters<typeof handleLlmInputPresence>[0]['ctx'],
      workspaceDir: tempWorkspaceDir,
      eventLog: { recordPromptPresenceObserved: (data: Record<string, unknown>) => recorded.push(data) } as unknown as EventLog,
    });

    expect(recorded).toHaveLength(1);
    const observed = recorded[0] as Record<string, unknown>;
    expect(observed).toMatchObject({
      runId,
      sessionId,
      provider: 'pdpresence-responses',
      model: 'isolated-presence-model',
      boundary: 'post_assembly_system_prompt_via_llm_input',
      binding: 'unique',
      checked: true,
    });
    expect(observed.reason).toBeUndefined();
    expect(observed.results).toEqual([expect.objectContaining({ activationId: PRESENCE_FIXTURE.activationId, outcome: 'full_hit' })]);
    // The event carries no API-path field; the run proves the API path from the endpoint record.
    expect(observed).not.toHaveProperty('egress');
    const serialized = JSON.stringify(observed);
    expect(serialized).not.toContain(PRESENCE_FIXTURE.text);
    expect(serialized).not.toContain(escaped);
  });

  it('a host-side truncation of the assembled prompt is reported, never counted as a full_hit', async () => {
    const fixture = await preparedWorkspace();
    const packed = await buildActivePrinciplePromptContext({ workspaceDir: tempWorkspaceDir });
    const runId = 'pri1152-run-truncated';
    const sessionId = 'pri1152-session-truncated';
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const event = { prompt: 'x', messages: [], trigger: 'user', sessionId } as unknown as Parameters<typeof handleBeforePromptBuild>[0];
    const result = await handleBeforePromptBuild(event, ctxFor(runId, sessionId), packed);
    const assembled = result?.prependSystemContext ?? '';
    const cut = assembled.slice(0, assembled.indexOf(escapeXml(fixture.PRESENCE_FIXTURE.text)) + 5);

    const { handleLlmInputPresence } = await import('../../src/hooks/llm-input-presence.js');
    const recorded: Record<string, unknown>[] = [];
    handleLlmInputPresence({
      event: { runId, sessionId, provider: 'pdpresence-completions', model: 'isolated-presence-model', systemPrompt: cut, prompt: '', historyMessages: [], imagesCount: 0 },
      ctx: { runId, sessionId } as Parameters<typeof handleLlmInputPresence>[0]['ctx'],
      workspaceDir: tempWorkspaceDir,
      eventLog: { recordPromptPresenceObserved: (data: Record<string, unknown>) => recorded.push(data) } as unknown as EventLog,
    });
    const results = (recorded[0]?.results ?? []) as Array<{ activationId: string; outcome: string }>;
    const row = results.find((entry) => entry.activationId === fixture.PRESENCE_FIXTURE.activationId);
    expect(recorded[0]).toMatchObject({ binding: 'unique', checked: true });
    expect(row).toBeDefined();
    expect(['checked_missing', 'unknown']).toContain(row?.outcome);
  });
});
