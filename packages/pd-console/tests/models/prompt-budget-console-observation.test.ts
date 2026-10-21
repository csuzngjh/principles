/**
 * PRI-1017: Console ↔ runtime budget data-chain contract tests.
 *
 * The defect this file vaccinates against: the runtime injection ran a
 * model-aware budget (e.g. 256K window → 4000 chars) while the Console
 * forecast under its own parameterless fallback (fixed 2000) — the Owner saw
 * `1953/2000` while production injected under 4000 (SPEC
 * PD-PD-MODEL-AWARE-PROMPT-BUDGET-001 §6.1 forbids exactly this split).
 *
 * These tests join the two sides for real:
 *
 *   production dispatch (createProductionHostRuntime)
 *     → REAL EventLog writer (principles-disciple/event-log, the production
 *        openclaw-plugin writer) → `.state/logs/events_<date>.jsonl`
 *     → console budget observation read model
 *     → ApprovalsGroupedConsoleModel / ActivationsConsoleModel
 *     → UI wire contract (validatePromptInjectionBudgetStatus)
 *
 * If either side drifts (event field, directory convention, freshness rule,
 * host binding), these tests fail — regardless of which package owns the
 * change. Negative cases (stale / host mismatch / untrusted) use direct
 * JSONL fixtures: the reader semantics are unit-tested in host-runtime
 * (`prompt-injection-budget-observation.test.ts`); what is under test HERE is
 * the console wiring (which budget basis reaches which surface, and how
 * missing facts degrade).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { SqliteActivationStateStore, SqliteConnection, getDefaultPdConfig } from '@principles/core/runtime-v2';
import { createProductionHostRuntime, saveHostToolDeclaration, type PromptInjectionTargetHost } from '@principles/host-runtime';
import type { HostEvent } from '@principles/core/host';
// REAL v1 writer, resolved to openclaw-plugin source via vitest alias
// (see vitest.config.ts) — the component production uses to emit events.
import { EventLog } from 'principles-disciple/event-log';
import { ApprovalsGroupedConsoleModel } from '../../src/server/models/ApprovalsGroupedConsoleModel.js';
import { ActivationsConsoleModel } from '../../src/server/models/ActivationsConsoleModel.js';
import { validatePromptInjectionBudgetStatus } from '../../src/ui/utils/validators.js';

const tempDirs: string[] = [];

function makeWorkspace(opts?: { declare?: PromptInjectionTargetHost[] }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-console-budget-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pd', 'config.yaml'), yaml.dump(getDefaultPdConfig()), 'utf8');
  for (const hostKind of opts?.declare ?? []) {
    const saved = saveHostToolDeclaration(dir, {
      version: 1,
      hostKind,
      mappings: [{ rawToolName: 'bash', canonicalKind: 'execute' }],
      declaredAt: new Date(Date.UTC(2026, 9, 20, 8, 0, 0)).toISOString(),
    });
    if (!saved.ok) throw new Error(`declaration save failed: ${saved.reason}`);
  }
  return dir;
}

beforeEach(() => {
  // Ensure a clean slate per test (makeWorkspace registers the dir).
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

async function seedActivation(workspaceDir: string, principleId: string, text: string): Promise<void> {
  const artifactId = `art-${principleId}`;
  const seedConnection = new SqliteConnection({ workspaceDir });
  try {
    const at = new Date(Date.UTC(2026, 9, 20, 8, 0, 0)).toISOString();
    seedConnection.getDb().prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, 'principle', ?, ?, NULL, '[]', 'validated', ?, ?, ?)
    `).run(artifactId, `task-${principleId}`, null, JSON.stringify({ principleId, text }), at, at);
  } finally {
    seedConnection.close();
  }
  const connection = new SqliteConnection({ workspaceDir });
  try {
    await new SqliteActivationStateStore(connection).recordActivation({
      activationId: `act-${principleId}`,
      idempotencyKey: `${artifactId}::prompt`,
      artifactId,
      channel: 'prompt',
      action: 'prompt_activate',
      targetRef: `ledger://${principleId}`,
      activatedAt: new Date(Date.UTC(2026, 9, 20, 8, 0, 0)).toISOString(),
      deactivatedAt: null,
    });
  } finally {
    connection.close();
  }
}

/** Emit a REAL injection event through the production shared runtime + EventLog. */
async function dispatchProductionInjection(
  workspaceDir: string,
  modelContext: HostEvent['context']['modelContext'],
  hostKind: PromptInjectionTargetHost = 'codex',
): Promise<void> {
  const eventLog = new EventLog(path.join(workspaceDir, '.state'));
  try {
    const runtime = createProductionHostRuntime({
      hostKind,
      events: {
        recordRuntimeV2ActivationsInjected: (data) => eventLog.recordRuntimeV2ActivationsInjected(data),
        recordToolCall: () => { /* not under test */ },
      },
    });
    await runtime.dispatch({
      kind: 'before_prompt_build',
      context: { workspaceDir, sessionId: 'sess-cross-layer', ...(modelContext !== undefined ? { modelContext } : {}) },
      rawPayload: {},
      source: 'codex:user_prompt_submit',
    });
    eventLog.flush();
  } finally {
    eventLog.dispose();
  }
}

function writeRawEvent(workspaceDir: string, ts: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.join(workspaceDir, '.state', 'logs'), { recursive: true });
  fs.appendFileSync(
    path.join(workspaceDir, '.state', 'logs', 'events_2026-10-21.jsonl'),
    JSON.stringify({ ts, date: '2026-10-21', type: 'runtime_v2_prompt_activations_injected', category: 'injected', sessionId: 's-1', data }) + '\n',
    'utf8',
  );
}

function budgetEventData(workspaceDir: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionId: 's-1',
    workspaceDir,
    activationIds: ['act-1'],
    artifactIds: ['a'],
    principleIds: ['p1'],
    injectedCount: 1,
    injectedCharCount: 480,
    budget: 2000,
    ...extra,
  };
}

const TRUSTED_256K = {
  hostKind: 'openclaw',
  budget: 4000,
  budgetCapacitySource: 'host_effective_window',
  budgetCapacityStatus: 'confirmed',
  budgetContextWindowTokens: 256_000,
  budgetPolicyVersion: 'model_aware_v1',
} as const;

describe('PRI-1017 A: production injection event → Console forecast (the data chain, end to end)', () => {
  it('a real 256K dispatch is read back by the grouped console as a 4000-char budget with provenance + observation time', async () => {
    const dir = makeWorkspace();
    await seedActivation(dir, 'cross-a1', '跨层验证原则：先确认事实，再行动。' + 'z'.repeat(80));

    await dispatchProductionInjection(dir, {
      contextTokenBudget: 256_000,
      contextWindowSource: 'model',
      modelId: 'claude-sonnet-4-5',
    });

    // The production writer really landed the event in the workspace log.
    const logsDir = path.join(dir, '.state', 'logs');
    expect(fs.existsSync(logsDir)).toBe(true);
    const eventLines = fs.readdirSync(logsDir)
      .filter((name) => name.startsWith('events_') && name.endsWith('.jsonl'))
      .flatMap((name) => fs.readFileSync(path.join(logsDir, name), 'utf8').split('\n').filter(Boolean));
    const injected = eventLines
      .map((line) => JSON.parse(line) as { type?: string; data?: Record<string, unknown> })
      .filter((entry) => entry.type === 'runtime_v2_prompt_activations_injected');
    expect(injected).toHaveLength(1);
    expect(injected[0]?.data?.budget).toBe(4000);
    expect(injected[0]?.data?.budgetCapacitySource).toBe('host_effective_window');

    // The console now forecasts under the SAME budget fact.
    const grouped = await new ApprovalsGroupedConsoleModel(dir).getApprovalsGrouped('codex');
    const promptInjection = grouped.promptInjection;
    expect(promptInjection).toBeDefined();
    expect(promptInjection?.budget).toBe(4000);
    expect(promptInjection?.usedChars).toBeGreaterThan(0);
    expect(promptInjection?.usedChars).toBeLessThanOrEqual(4000);
    expect(promptInjection?.capacityStatus).toBe('confirmed');
    expect(promptInjection?.hostKind).toBe('codex');
    expect(promptInjection?.budgetCapacitySource).toBe('host_effective_window');
    expect(promptInjection?.budgetCapacityStatus).toBe('confirmed');
    expect(promptInjection?.budgetContextWindowTokens).toBe(256_000);
    // The observation is labelled as a PAST fact, not a live confirmation.
    expect(promptInjection?.budgetObservedAt).toBeDefined();
    expect(Number.isFinite(Date.parse(promptInjection?.budgetObservedAt ?? ''))).toBe(true);
    // The no-runtime-facts fallback note condition is gone for this host.
    expect(promptInjection?.budgetFallbackReason).toBeUndefined();
    // The UI wire contract accepts the payload verbatim.
    expect(validatePromptInjectionBudgetStatus(promptInjection)).toEqual(promptInjection);
  });

  it('the activations surface reads the same observation (per-row budget = observed budget)', async () => {
    const dir = makeWorkspace();
    await seedActivation(dir, 'cross-a2', '激活页跨层验证原则：先确认事实，再行动。' + 'z'.repeat(80));
    await dispatchProductionInjection(dir, {
      contextTokenBudget: 256_000,
      contextWindowSource: 'model',
      modelId: 'claude-sonnet-4-5',
    });

    const activations = await new ActivationsConsoleModel(dir).getActivations('codex');
    const row = activations.activations.find((entry) => entry.promptInjection !== undefined);
    expect(row?.promptInjection?.budget).toBe(4000);
    expect(row?.promptInjection?.status).toBe('injectable');
    expect(activations.promptInjectionRoute?.budgetObservedAt).toBeDefined();
    expect(activations.promptInjectionRoute?.status).toBe('confirmed');
  });

  it('a single-host workspace resolves its host from WORKSPACE FACTS (no ?host) and uses that host’s observation', async () => {
    // The common console load passes no target host. The route is still
    // confirmed (one declared host), so the forecast must use that host's
    // observation instead of the parameterless 2000 fallback.
    const dir = makeWorkspace({ declare: ['openclaw'] });
    await seedActivation(dir, 'cross-a3', '单宿主工作区原则：先确认事实，再行动。' + 'z'.repeat(60));
    await dispatchProductionInjection(dir, {
      contextTokenBudget: 256_000,
      contextWindowSource: 'model',
      modelId: 'claude-sonnet-4-5',
    }, 'openclaw');

    const grouped = await new ApprovalsGroupedConsoleModel(dir).getApprovalsGrouped();
    expect(grouped.promptInjection?.capacityStatus).toBe('confirmed');
    expect(grouped.promptInjection?.hostKind).toBe('openclaw');
    expect(grouped.promptInjection?.budget).toBe(4000);
    expect(grouped.promptInjection?.budgetObservedAt).toBeDefined();
    expect(grouped.promptInjection?.budgetFallbackReason).toBeUndefined();

    const activations = await new ActivationsConsoleModel(dir).getActivations();
    expect(activations.promptInjectionRoute?.hostKind).toBe('openclaw');
    expect(activations.promptInjectionRoute?.budgetCapacityStatus).toBe('confirmed');
    expect(activations.promptInjectionRoute?.budgetContextWindowTokens).toBe(256_000);
    expect(activations.promptInjectionRoute?.budgetObservedAt).toBeDefined();
    expect(activations.activations.find((entry) => entry.principleId === 'cross-a3')?.promptInjection?.budget).toBe(4000);
  });

  it('C1: under the observed 4000 budget a mid-range entry is model_dependent (never a false injectable)', async () => {
    const dir = makeWorkspace();
    // ~852-char minimum entry (fits every tier) and a ~1664-char entry
    // (above the measured 1250 floor, inside the supported range → model
    // dependent on the runtime model).
    await seedActivation(dir, 'cross-small', 'x'.repeat(86));
    await seedActivation(dir, 'cross-mid', 'y'.repeat(900));
    await dispatchProductionInjection(dir, {
      contextTokenBudget: 256_000,
      contextWindowSource: 'model',
      modelId: 'claude-sonnet-4-5',
    });

    const activations = await new ActivationsConsoleModel(dir).getActivations('codex');
    const byPrinciple = new Map(activations.activations.map((entry) => [entry.principleId, entry.promptInjection]));
    const small = byPrinciple.get('cross-small');
    const mid = byPrinciple.get('cross-mid');
    expect(small?.budget).toBe(4000);
    expect(small?.status).toBe('injectable');
    expect(mid?.budget).toBe(4000);
    // The PR #2093 regression, locked at the console layer: an entry in
    // (1250, 16000] is NEVER reported as an unconditional injectable, even
    // when it fits the current (observed) window.
    expect(mid?.status).toBe('model_dependent');
    expect(mid?.inCurrentWindow).toBe(true);
  });

  it('C2: under the observed 4000 budget a >16K entry is still oversized (no model can inject it)', async () => {
    const dir = makeWorkspace();
    await seedActivation(dir, 'cross-huge', 'z'.repeat(20_000));
    await dispatchProductionInjection(dir, {
      contextTokenBudget: 256_000,
      contextWindowSource: 'model',
      modelId: 'claude-sonnet-4-5',
    });

    const activations = await new ActivationsConsoleModel(dir).getActivations('codex');
    const huge = activations.activations.find((entry) => entry.principleId === 'cross-huge')?.promptInjection;
    expect(huge?.budget).toBe(4000);
    expect(huge?.status).toBe('oversized');
  });

  it('C3: the formula clamp boundaries (32K → 1250 floor, 1M → 15625) flow through unchanged', async () => {
    const minDir = makeWorkspace();
    await seedActivation(minDir, 'cross-min', 'x'.repeat(86));
    await dispatchProductionInjection(minDir, {
      contextTokenBudget: 32_000,
      contextWindowSource: 'model',
      modelId: 'claude-haiku-4-5',
    });
    const minGrouped = await new ApprovalsGroupedConsoleModel(minDir).getApprovalsGrouped('codex');
    expect(minGrouped.promptInjection?.budget).toBe(1250);
    expect(minGrouped.promptInjection?.budgetContextWindowTokens).toBe(32_000);
    expect(minGrouped.promptInjection?.budgetCapacitySource).toBe('host_effective_window');
    expect(minGrouped.promptInjection?.budgetCapacityStatus).toBe('confirmed');
    const minRow = (await new ActivationsConsoleModel(minDir).getActivations('codex')).activations
      .find((entry) => entry.principleId === 'cross-min')?.promptInjection;
    expect(minRow?.budget).toBe(1250);
    expect(minRow?.status).toBe('injectable');
    expect(minRow?.inCurrentWindow).toBe(true);

    const maxDir = makeWorkspace();
    await seedActivation(maxDir, 'cross-max', 'y'.repeat(900));
    await dispatchProductionInjection(maxDir, {
      contextTokenBudget: 1_000_000,
      contextWindowSource: 'model',
      modelId: 'claude-sonnet-4-5',
    });
    const maxGrouped = await new ApprovalsGroupedConsoleModel(maxDir).getApprovalsGrouped('codex');
    // floor(2000 * 1_000_000 / 128_000) = 15625 — below the 16000 cap.
    expect(maxGrouped.promptInjection?.budget).toBe(15_625);
    expect(maxGrouped.promptInjection?.budgetContextWindowTokens).toBe(1_000_000);
    const maxRow = (await new ActivationsConsoleModel(maxDir).getActivations('codex')).activations
      .find((entry) => entry.principleId === 'cross-max')?.promptInjection;
    expect(maxRow?.budget).toBe(15_625);
    expect(maxRow?.status).toBe('model_dependent');
    expect(maxRow?.inCurrentWindow).toBe(true);
  });

  it('C4: at the 1250 floor a mid-range entry is model_dependent and NOT in the current window (fits larger models only)', async () => {
    const dir = makeWorkspace();
    await seedActivation(dir, 'cross-mid-min', 'y'.repeat(900));
    await dispatchProductionInjection(dir, {
      contextTokenBudget: 32_000,
      contextWindowSource: 'model',
      modelId: 'claude-haiku-4-5',
    });

    const activations = await new ActivationsConsoleModel(dir).getActivations('codex');
    const row = activations.activations.find((entry) => entry.principleId === 'cross-mid-min')?.promptInjection;
    expect(row?.budget).toBe(1250);
    expect(row?.status).toBe('model_dependent');
    expect(row?.inCurrentWindow).toBe(false);
    // The tier verdict is about the entry, not the current window: bigger
    // models (≤16000 budget) can still inject it, so it is never "oversized".
    expect(row?.status).not.toBe('oversized');
  });
});

describe('PRI-1017 B: missing / stale / mismatched / untrusted observations degrade honestly', () => {
  it('B1: no runtime events at all → fixed fallback with the absence reason (no fabricated window)', async () => {
    const dir = makeWorkspace();
    await seedActivation(dir, 'neg-b1', '无观测回退验证原则');
    const grouped = await new ApprovalsGroupedConsoleModel(dir).getApprovalsGrouped('codex');
    expect(grouped.promptInjection?.budget).toBe(2000);
    expect(grouped.promptInjection?.budgetCapacityStatus).toBe('unknown');
    expect(grouped.promptInjection?.budgetCapacitySource).toBe('legacy_fallback');
    expect(grouped.promptInjection?.budgetFallbackReason).toBe('host_capacity_absent');
    expect(grouped.promptInjection?.budgetObservedAt).toBeUndefined();
  });

  it('B2: a 48h-old observation is stale → fallback with the traceable stale reason', async () => {
    const dir = makeWorkspace();
    await seedActivation(dir, 'neg-b2', '过期观测回退验证原则');
    writeRawEvent(dir, '2026-10-19T04:00:00.000Z', budgetEventData(dir, TRUSTED_256K));
    const grouped = await new ApprovalsGroupedConsoleModel(dir).getApprovalsGrouped('openclaw');
    expect(grouped.promptInjection?.budget).toBe(2000);
    expect(grouped.promptInjection?.budgetCapacityStatus).toBe('unknown');
    expect(grouped.promptInjection?.budgetFallbackReason).toBe('runtime_budget_observation_stale');
    expect(grouped.promptInjection?.budgetObservedAt).toBeUndefined();
  });

  it('B3: an observation for another host is never borrowed (host mismatch → fallback)', async () => {
    const dir = makeWorkspace();
    await seedActivation(dir, 'neg-b3', '宿主不匹配回退验证原则');
    writeRawEvent(dir, new Date().toISOString(), budgetEventData(dir, TRUSTED_256K));
    const grouped = await new ApprovalsGroupedConsoleModel(dir).getApprovalsGrouped('codex');
    expect(grouped.promptInjection?.budget).toBe(2000);
    expect(grouped.promptInjection?.hostKind).toBe('codex');
    expect(grouped.promptInjection?.budgetFallbackReason).toBe('host_capacity_absent');
    expect(grouped.promptInjection?.budgetObservedAt).toBeUndefined();
  });

  it('B4: untrusted event fields are dropped by the reader → fallback (never a guessed window)', async () => {
    const dir = makeWorkspace();
    await seedActivation(dir, 'neg-b4', '不可信字段回退验证原则');
    writeRawEvent(dir, new Date().toISOString(), budgetEventData(dir, {
      hostKind: 'openclaw',
      budget: 4000,
      budgetCapacitySource: 'not_a_real_source',
      budgetCapacityStatus: 'confirmed',
      budgetContextWindowTokens: 256_000,
      budgetPolicyVersion: 'model_aware_v1',
    }));
    const grouped = await new ApprovalsGroupedConsoleModel(dir).getApprovalsGrouped('openclaw');
    expect(grouped.promptInjection?.budget).toBe(2000);
    expect(grouped.promptInjection?.budgetObservedAt).toBeUndefined();
  });

  it('B5: unconfirmed route → per-host forecasts each carry their OWN budget basis (no shared headline smuggle)', async () => {
    const dir = makeWorkspace();
    await seedActivation(dir, 'neg-b5', '未确认路由逐宿主验证原则');
    writeRawEvent(dir, new Date().toISOString(), budgetEventData(dir, TRUSTED_256K));
    const grouped = await new ApprovalsGroupedConsoleModel(dir).getApprovalsGrouped();
    const promptInjection = grouped.promptInjection;
    expect(promptInjection?.capacityStatus).toBe('unconfirmed');
    const perHost = promptInjection?.perHost ?? [];
    const openclaw = perHost.find((entry) => entry.hostKind === 'openclaw');
    const codex = perHost.find((entry) => entry.hostKind === 'codex');
    const workbuddy = perHost.find((entry) => entry.hostKind === 'workbuddy');
    // OpenClaw carries its own observed 4000-char basis with the observation time.
    expect(openclaw?.budget).toBe(4000);
    expect(openclaw?.budgetCapacitySource).toBe('host_effective_window');
    expect(openclaw?.budgetObservedAt).toBeDefined();
    // The other hosts keep their own honest fallback — no borrowed window.
    expect(codex?.budget).toBe(2000);
    expect(codex?.budgetObservedAt).toBeUndefined();
    expect(workbuddy?.budget).toBe(2000);
    expect(workbuddy?.budgetObservedAt).toBeUndefined();
    // Each host carries its OWN reason; the headline must not inherit the
    // first host's reason (that would attribute one host's gap to another).
    expect(openclaw?.budgetFallbackReason).toBeUndefined();
    expect(codex?.budgetFallbackReason).toBe('host_capacity_absent');
    expect(workbuddy?.budgetFallbackReason).toBe('host_capacity_absent');
    expect(promptInjection?.budgetFallbackReason).toBeUndefined();
    // The UI wire contract accepts the per-host payload.
    expect(validatePromptInjectionBudgetStatus(promptInjection)).toEqual(promptInjection);
  });

  it('B6: a stale observation for the workspace-resolved host is not used even without ?host', async () => {
    const dir = makeWorkspace({ declare: ['openclaw'] });
    await seedActivation(dir, 'neg-b6', '单宿主过期观测验证原则');
    writeRawEvent(dir, '2026-10-19T04:00:00.000Z', budgetEventData(dir, TRUSTED_256K));
    const grouped = await new ApprovalsGroupedConsoleModel(dir).getApprovalsGrouped();
    expect(grouped.promptInjection?.capacityStatus).toBe('confirmed');
    expect(grouped.promptInjection?.hostKind).toBe('openclaw');
    expect(grouped.promptInjection?.budget).toBe(2000);
    expect(grouped.promptInjection?.budgetFallbackReason).toBe('runtime_budget_observation_stale');
    expect(grouped.promptInjection?.budgetObservedAt).toBeUndefined();
  });

  it('B7: a future timestamp is never a current observation (clock-skew guard)', async () => {
    const dir = makeWorkspace({ declare: ['openclaw'] });
    await seedActivation(dir, 'neg-b7', '未来时间戳验证原则');
    writeRawEvent(dir, '2099-01-01T00:00:00.000Z', budgetEventData(dir, TRUSTED_256K));
    const grouped = await new ApprovalsGroupedConsoleModel(dir).getApprovalsGrouped();
    expect(grouped.promptInjection?.budget).toBe(2000);
    expect(grouped.promptInjection?.budgetObservedAt).toBeUndefined();
    expect(grouped.promptInjection?.budgetCapacityStatus).toBe('unknown');
  });

  it('B8: internally incoherent provenance (256K window with a 2000 budget) is rejected, never reinterpreted', async () => {
    const dir = makeWorkspace({ declare: ['openclaw'] });
    await seedActivation(dir, 'neg-b8', '矛盾预算字段验证原则');
    writeRawEvent(dir, new Date().toISOString(), budgetEventData(dir, {
      ...TRUSTED_256K,
      budget: 2000,
    }));
    const grouped = await new ApprovalsGroupedConsoleModel(dir).getApprovalsGrouped();
    expect(grouped.promptInjection?.budget).toBe(2000);
    expect(grouped.promptInjection?.budgetCapacitySource).toBe('legacy_fallback');
    expect(grouped.promptInjection?.budgetObservedAt).toBeUndefined();
  });

  it('B9: malformed log lines do not break the console read — valid observations still apply (bounded parse failures)', async () => {
    const dir = makeWorkspace({ declare: ['openclaw'] });
    await seedActivation(dir, 'neg-b9', '损坏日志行验证原则');
    fs.mkdirSync(path.join(dir, '.state', 'logs'), { recursive: true });
    const file = path.join(dir, '.state', 'logs', 'events_2026-10-21.jsonl');
    fs.appendFileSync(file, '{not json\n', 'utf8');
    fs.appendFileSync(file, JSON.stringify({
      ts: new Date().toISOString(),
      date: '2026-10-21',
      type: 'runtime_v2_prompt_activations_injected',
      category: 'injected',
      sessionId: 's-1',
      data: budgetEventData(dir, TRUSTED_256K),
    }) + '\n', 'utf8');

    const grouped = await new ApprovalsGroupedConsoleModel(dir).getApprovalsGrouped();
    expect(grouped.promptInjection?.capacityStatus).toBe('confirmed');
    expect(grouped.promptInjection?.budget).toBe(4000);
    expect(grouped.promptInjection?.budgetObservedAt).toBeDefined();
  });

  it('B10: a usable observation that is ITSELF the runtime fallback is surfaced with its reason + observation time (not "console unbound")', async () => {
    // This is the shape the real installed WorkBuddy host emits (verified on
    // 2026-10-21): the host supplied no capacity, so the runtime honestly
    // resolved 2000/catalog_no_match_for_model_id. The console DID observe the
    // runtime's budget basis — it must label it as such, not claim it has no
    // runtime binding.
    const dir = makeWorkspace({ declare: ['openclaw'] });
    await seedActivation(dir, 'neg-b10', '运行时自身回退观测验证原则');
    writeRawEvent(dir, new Date().toISOString(), budgetEventData(dir, {
      hostKind: 'openclaw',
      budgetCapacitySource: 'legacy_fallback',
      budgetCapacityStatus: 'unknown',
      budgetPolicyVersion: 'model_aware_v1',
      budgetFallbackReason: 'catalog_no_match_for_model_id',
    }));

    const grouped = await new ApprovalsGroupedConsoleModel(dir).getApprovalsGrouped();
    const promptInjection = grouped.promptInjection;
    expect(promptInjection?.capacityStatus).toBe('confirmed');
    expect(promptInjection?.hostKind).toBe('openclaw');
    expect(promptInjection?.budget).toBe(2000);
    expect(promptInjection?.budgetCapacitySource).toBe('legacy_fallback');
    expect(promptInjection?.budgetCapacityStatus).toBe('unknown');
    expect(promptInjection?.budgetFallbackReason).toBe('catalog_no_match_for_model_id');
    expect(promptInjection?.budgetObservedAt).toBeDefined();
    expect(validatePromptInjectionBudgetStatus(promptInjection)).toEqual(promptInjection);

    const activations = await new ActivationsConsoleModel(dir).getActivations();
    expect(activations.promptInjectionRoute?.budgetFallbackReason).toBe('catalog_no_match_for_model_id');
    expect(activations.promptInjectionRoute?.budgetObservedAt).toBeDefined();
  });
});
