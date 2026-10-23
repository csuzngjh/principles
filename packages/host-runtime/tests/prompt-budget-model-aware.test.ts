import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import {
  PROMPT_BUDGET_FALLBACK_CHARS,
  PROMPT_BUDGET_MAX_CHARS,
  PROMPT_BUDGET_MIN_CHARS,
  RuntimeV2PromptActivationsInjectedEventDataSchema,
  SqliteActivationStateStore,
  SqliteConnection,
  classifySingleItemBudgetTier,
  getDefaultPdConfig,
  promptBudgetCharsForContextWindow,
  resolvePromptBudget,
  type PromptBudgetResolution,
  type RuntimeV2PromptActivationsInjectedEventData,
} from '@principles/core/runtime-v2';
import { Value } from '@sinclair/typebox/value';
import {
  buildActivePrinciplePromptContext,
  buildLivePromptInjectionProjection,
  checkPromptArtifactDeliverability,
  createProductionHostRuntime,
  readPromptActivationInjectionStatuses,
  computePromptSingleItemFit,
  saveHostToolDeclaration,
  type PromptInjectionTargetHost,
} from '../src/index.js';
import type { HostEvent, HostEventEmitter } from '@principles/core/host';

/**
 * SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 at the host-runtime boundary:
 * - one budget resolution per request flows through the real injection,
 *   projection, precheck and status surfaces (AC-07);
 * - tier-honest deliverability: fits_all_tiers / model_dependent /
 *   exceeds_max_tier, never a guessed single-budget verdict (AC-08);
 * - the shared production path resolves from HostEventContext.modelContext
 *   and records the executed budget + provenance in the injection event
 *   (AC-02/AC-06); no modelContext → legacy fixed fallback (AC-04).
 */

const tempDirs: string[] = [];

interface WorkspaceOpts {
  sharedFlag?: boolean;
  selfReport?: boolean;
  declare?: PromptInjectionTargetHost[];
  /** PRI-1020: Owner-declared capacity written into .pd/config.yaml. */
  promptBudget?: { declaredContextWindowTokens?: number; hosts?: Record<string, number> };
}

function tempWorkspace(opts?: WorkspaceOpts): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-mab-'));
  tempDirs.push(workspaceDir);
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  const config = getDefaultPdConfig();
  if (opts?.promptBudget !== undefined) {
    config.promptBudget = opts.promptBudget;
  }
  if (opts?.sharedFlag) {
    config.features.abstraction_layer_v1 = { ...config.features.abstraction_layer_v1, enabled: true };
  }
  if (opts?.selfReport) {
    config.features.principle_receipt_self_report = { ...config.features.principle_receipt_self_report, enabled: true };
  }
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(config), 'utf8');
  for (const hostKind of opts?.declare ?? []) {
    const saved = saveHostToolDeclaration(workspaceDir, {
      version: 1,
      hostKind,
      mappings: [{ rawToolName: 'bash', canonicalKind: 'execute' }],
      declaredAt: new Date(Date.UTC(2026, 9, 20, 8, 0, 0)).toISOString(),
    });
    if (!saved.ok) throw new Error(`declaration save failed: ${saved.reason}`);
  }
  return workspaceDir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function seedArtifact(workspaceDir: string, principleId: string, text: string): string {
  const artifactId = `art-${principleId}`;
  const connection = new SqliteConnection({ workspaceDir });
  try {
    const at = new Date(Date.UTC(2026, 9, 20, 8, 0, 0)).toISOString();
    connection.getDb().prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, 'principle', ?, ?, NULL, '[]', 'validated', ?, ?, ?)
    `).run(artifactId, `task-${principleId}`, null, JSON.stringify({ principleId, text }), at, at);
    return artifactId;
  } finally {
    connection.close();
  }
}

async function seedActivation(workspaceDir: string, principleId: string, text: string): Promise<void> {
  const artifactId = seedArtifact(workspaceDir, principleId, text);
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

const FIXED_FALLBACK: PromptBudgetResolution = resolvePromptBudget();
const WINDOW_256K: PromptBudgetResolution = resolvePromptBudget({
  hostCapacity: { contextTokenBudget: 256_000, contextWindowSource: 'model' },
});
const WINDOW_32K: PromptBudgetResolution = resolvePromptBudget({
  hostCapacity: { contextTokenBudget: 32_000, contextWindowSource: 'model' },
});

describe('resolution sanity at this boundary', () => {
  it('the reference tiers resolve as the SPEC table states (v0.2: 32K/64K clamp up to the measured floor)', () => {
    expect(WINDOW_256K.budgetChars).toBe(4000);
    expect(WINDOW_32K.budgetChars).toBe(PROMPT_BUDGET_MIN_CHARS);
    expect(FIXED_FALLBACK.budgetChars).toBe(PROMPT_BUDGET_FALLBACK_CHARS);
    expect(FIXED_FALLBACK.capacitySource).toBe('legacy_fallback');
    // 64K raw = 1000 — below the measured floor, clamped up.
    expect(promptBudgetCharsForContextWindow(64_000)).toBe(PROMPT_BUDGET_MIN_CHARS);
    // 1M → 15625 (cap is an upper bound, not a target).
    expect(promptBudgetCharsForContextWindow(1_000_000)).toBe(15625);
  });
});

describe('THE 32K zero-injection regression (Owner fix round)', () => {
  // Real production serializers measured the shared route's full directive
  // render of a minimum viable principle at 849 chars (self-report OFF) and
  // 1204 chars (ON); the old 500 floor injected ZERO. The floor is now the
  // measured 1250 — this test pins the fix on the real builder path.
  const SHORT_TEXT = 'Before committing, re-read the changed lines and verify every caller still compiles.';

  for (const selfReport of [false, true]) {
    it(`a 32K-window model injects >=1 short principle on the shared route (selfReport=${selfReport})`, async () => {
      const dir = tempWorkspace({ sharedFlag: true, declare: ['codex'], selfReport });
      await seedActivation(dir, 'min-viable', SHORT_TEXT);
      const result = await buildActivePrinciplePromptContext({ workspaceDir: dir, promptBudget: WINDOW_32K });
      expect(result.budget).toBe(PROMPT_BUDGET_MIN_CHARS);
      expect(result.principleIds).toContain('min-viable');
      expect(result.additionalContext.length).toBeGreaterThan(0);
      expect(result.additionalContext.length).toBeLessThanOrEqual(result.budget);
    });
  }

  it('the budget stays an upper bound: the full render never exceeds it', async () => {
    const dir = tempWorkspace({ sharedFlag: true, declare: ['codex'] });
    for (let i = 0; i < 10; i += 1) {
      await seedActivation(dir, `s-${String(i).padStart(2, '0')}`, `principle ${i} ${'x'.repeat(60)}`);
    }
    const result = await buildActivePrinciplePromptContext({ workspaceDir: dir, promptBudget: WINDOW_32K });
    expect(result.additionalContext.length).toBeLessThanOrEqual(PROMPT_BUDGET_MIN_CHARS);
  });
});

describe('AC-07: one resolution flows through injection, projection, precheck, status', () => {
  it('shared route: a 4000-char budget (256K window) injects strictly more than the fixed 2000', async () => {
    const dir = tempWorkspace({ sharedFlag: true, declare: ['codex'] });
    for (let i = 0; i < 14; i += 1) {
      await seedActivation(dir, `p-${String(i).padStart(2, '0')}`, `principle text ${i} ${'x'.repeat(40)}`);
    }
    const fixed = await buildActivePrinciplePromptContext({ workspaceDir: dir });
    const wide = await buildActivePrinciplePromptContext({ workspaceDir: dir, promptBudget: WINDOW_256K });
    expect(fixed.budget).toBe(2000);
    expect(fixed.budgetCapacitySource).toBe('legacy_fallback');
    expect(fixed.budgetCapacityStatus).toBe('unknown');
    expect(wide.budget).toBe(4000);
    expect(wide.budgetCapacitySource).toBe('host_effective_window');
    expect(wide.budgetCapacityStatus).toBe('confirmed');
    expect(wide.budgetContextWindowTokens).toBe(256_000);
    expect(wide.principleIds.length).toBeGreaterThan(fixed.principleIds.length);
    expect(wide.additionalContext.length).toBeLessThanOrEqual(4000);
    expect(fixed.additionalContext.length).toBeLessThanOrEqual(2000);
  });

  it('projection runs the SAME resolution on both routes and reports its provenance', async () => {
    const dir = tempWorkspace({ declare: ['openclaw'] });
    for (let i = 0; i < 8; i += 1) {
      await seedActivation(dir, `q-${String(i).padStart(2, '0')}`, `principle text ${i} ${'y'.repeat(40)}`);
    }
    const legacyDefault = await buildLivePromptInjectionProjection({ workspaceDir: dir, targetHost: 'openclaw' });
    expect(legacyDefault.budget).toBe(2000);
    expect(legacyDefault.budgetCapacitySource).toBe('legacy_fallback');
    expect(legacyDefault.budgetCapacityStatus).toBe('unknown');

    const legacyWide = await buildLivePromptInjectionProjection({ workspaceDir: dir, targetHost: 'openclaw', promptBudget: WINDOW_256K });
    expect(legacyWide.budget).toBe(4000);
    expect(legacyWide.budgetCapacitySource).toBe('host_effective_window');
    expect(legacyWide.usedChars).toBeLessThanOrEqual(4000);
    if (legacyWide.truncated || legacyDefault.truncated) {
      expect(legacyWide.injectedPrincipleIds.length).toBeGreaterThanOrEqual(legacyDefault.injectedPrincipleIds.length);
    }

    const sharedWide = await buildLivePromptInjectionProjection({ workspaceDir: dir, targetHost: 'codex', promptBudget: WINDOW_256K });
    expect(sharedWide.route).toBe('shared_render');
    expect(sharedWide.budget).toBe(4000);
    expect(sharedWide.budgetCapacitySource).toBe('host_effective_window');
  });

  it('deliverability classifies against the SUPPORTED tier range, not one number (AC-08)', async () => {
    // List route (openclaw, flag off): header + entry serialization can sit
    // under the 500 floor, so fits_all_tiers is reachable here.
    const listDir = tempWorkspace({ declare: ['openclaw'] });
    const short = 'tiny rule';
    const shortArt = seedArtifact(listDir, 'tier-short', short);
    // Shared route (codex): the full directive template wrapper already
    // exceeds the floor, so realistic single items land in model_dependent.
    const dir = tempWorkspace({ declare: ['codex'] });
    const mid = 'm'.repeat(900);
    const huge = 'h'.repeat(17000);
    const midArt = seedArtifact(dir, 'tier-mid', mid);
    const hugeArt = seedArtifact(dir, 'tier-huge', huge);

    const check = async (workspaceDir: string, artifactId: string, targetHost: PromptInjectionTargetHost) =>
      checkPromptArtifactDeliverability({ workspaceDir, targetHost, artifact: loadArtifactIn(workspaceDir, artifactId) });

    const small = await check(listDir, shortArt, 'openclaw');
    expect(small.status).toBe('deliverable');
    if (small.status === 'deliverable') {
      expect(small.budget).toBe(PROMPT_BUDGET_MIN_CHARS);
      expect(small.costChars).toBeLessThanOrEqual(PROMPT_BUDGET_MIN_CHARS);
    }

    const medium = await check(dir, midArt, 'codex');
    expect(medium.status).toBe('model_dependent');
    if (medium.status === 'model_dependent') {
      expect(medium.costChars).toBeGreaterThan(PROMPT_BUDGET_MIN_CHARS);
      expect(medium.costChars).toBeLessThanOrEqual(PROMPT_BUDGET_MAX_CHARS);
      expect(medium.nextAction).toBeTruthy();
    }

    const oversized = await check(dir, hugeArt, 'codex');
    expect(oversized.status).toBe('undeliverable');
    if (oversized.status === 'undeliverable') {
      expect(oversized.budget).toBe(PROMPT_BUDGET_MAX_CHARS);
      expect(oversized.overByChars).toBe(oversized.costChars - PROMPT_BUDGET_MAX_CHARS);
    }

    // Route-unconfirmed: per-host facts are TIER verdicts now.
    const dir2 = tempWorkspace({});
    const art = seedArtifact(dir2, 'tier-mid-2', 'm'.repeat(900));
    const unconfirmed = await checkPromptArtifactDeliverability({ workspaceDir: dir2, artifact: loadArtifactIn(dir2, art) });
    expect(unconfirmed.status).toBe('unconfirmed');
    if (unconfirmed.status === 'unconfirmed') {
      expect(unconfirmed.perHost?.length).toBe(3);
      for (const entry of unconfirmed.perHost ?? []) {
        expect(['fits_all_tiers', 'model_dependent', 'exceeds_max_tier']).toContain(entry.tierFit);
      }
    }
  });

  it('single-item fit respects an explicit budget and defaults to the fixed fallback', () => {
    const principle = { principleId: 'p', text: 'x'.repeat(2800), artifactId: 'a', activationId: 'act' };
    const fallback = computePromptSingleItemFit({ principle, route: 'shared_render', selfReportEnabled: false });
    expect(fallback.costChars).toBeGreaterThan(2000);
    expect(fallback.fits).toBe(false);
    const wide = computePromptSingleItemFit({ principle, route: 'shared_render', selfReportEnabled: false, budget: 4000 });
    expect(wide.fits).toBe(true);
    expect(wide.costChars).toBe(fallback.costChars);
  });

  it('activation statuses: mid-band misses are model_dependent; only >4000 is oversized (AC-08)', async () => {
    const dir = tempWorkspace({ sharedFlag: true, declare: ['codex'] });
    await seedActivation(dir, 'fits', 'tiny rule');
    await seedActivation(dir, 'mid', 'm'.repeat(2800));
    await seedActivation(dir, 'huge', 'h'.repeat(17000));
    const report = await readPromptActivationInjectionStatuses({ workspaceDir: dir, targetHost: 'codex' });
    expect(report.route.status).toBe('confirmed');
    const byId = new Map(report.statuses.map((s) => [s.principleId, s]));
    const fits = byId.get('fits');
    const mid = byId.get('mid');
    const huge = byId.get('huge');
    expect(fits?.status).toBe('injectable');
    expect(fits?.budget).toBe(2000);
    // 'mid' does not fit the fixed 2000 projection budget but is within the
    // supported range — model-dependent, NOT oversized, NOT permanent refusal.
    expect(mid?.status).toBe('model_dependent');
    expect(mid?.reason).toContain('model_dependent_capacity');
    // 'huge' exceeds even the maximum supported budget — permanently oversized.
    expect(huge?.status).toBe('oversized');
    expect(huge?.reason).toContain('single_item_exceeds_budget');
    expect(classifySingleItemBudgetTier(huge?.costChars ?? 0)).toBe('exceeds_max_tier');
  });
});

describe('AC-02/AC-04/AC-06: the shared production path resolves from modelContext', () => {
  function captureEmitter(): { events: HostEventEmitter; injected: RuntimeV2PromptActivationsInjectedEventData[] } {
    const injected: RuntimeV2PromptActivationsInjectedEventData[] = [];
    return {
      injected,
      events: {
        recordRuntimeV2ActivationsInjected(data) { injected.push(data); },
        recordToolCall() { /* not under test */ },
      },
    };
  }

  function promptEvent(workspaceDir: string, modelContext?: HostEvent['context']['modelContext']): HostEvent {
    return {
      kind: 'before_prompt_build',
      context: { workspaceDir, sessionId: 'sess-1', ...(modelContext !== undefined ? { modelContext } : {}) },
      rawPayload: {},
      source: 'codex:user_prompt_submit',
    };
  }

  it('a trusted host effective window drives the dynamic budget and the recorded event carries provenance', async () => {
    const dir = tempWorkspace({ sharedFlag: true, declare: ['codex'] });
    for (let i = 0; i < 14; i += 1) {
      await seedActivation(dir, `e-${String(i).padStart(2, '0')}`, `principle text ${i} ${'z'.repeat(40)}`);
    }
    const { events, injected } = captureEmitter();
    const runtime = createProductionHostRuntime({ hostKind: 'codex', events });
    const result = await runtime.dispatch(promptEvent(dir, {
      contextTokenBudget: 256_000,
      contextWindowSource: 'model',
      modelId: 'claude-sonnet-4-5',
    }));
    expect(result.decision).toBe('modify');
    expect(injected.length).toBe(1);
    const event = injected[0];
    expect(event.budget).toBe(4000);
    expect(event.budgetCapacitySource).toBe('host_effective_window');
    expect(event.budgetCapacityStatus).toBe('confirmed');
    expect(event.budgetContextWindowTokens).toBe(256_000);
    expect(event.budgetPolicyVersion).toBe('model_aware_v1');
    expect(event.injectedCharCount).toBeLessThanOrEqual(4000);
    // The recorded event validates against the TypeBox wire schema.
    expect(Value.Check(RuntimeV2PromptActivationsInjectedEventDataSchema, event)).toBe(true);
  });

  it('PRI-1020 tier 0: an Owner declaration outranks trusted host facts and drives the event provenance', async () => {
    const dir = tempWorkspace({
      sharedFlag: true,
      declare: ['codex'],
      promptBudget: { declaredContextWindowTokens: 262_144, hosts: { codex: 400_000 } },
    });
    await seedActivation(dir, 'od-1', 'declared principle');
    const { events, injected } = captureEmitter();
    const runtime = createProductionHostRuntime({ hostKind: 'codex', events });
    // The host ALSO reports a trusted window, but the per-host declaration
    // wins: 400000 tokens → 6250 chars.
    await runtime.dispatch(promptEvent(dir, {
      contextTokenBudget: 256_000,
      contextWindowSource: 'model',
      modelId: 'claude-sonnet-4-5',
    }));
    const event = injected[0];
    expect(event.budget).toBe(6250);
    expect(event.budgetCapacitySource).toBe('operator_declared');
    expect(event.budgetCapacityStatus).toBe('confirmed');
    expect(event.budgetContextWindowTokens).toBe(400_000);
    expect(event.budgetPolicyVersion).toBe('model_aware_v1');
    expect(Value.Check(RuntimeV2PromptActivationsInjectedEventDataSchema, event)).toBe(true);
  });

  it('PRI-1020: the global declaration backs a host with no model facts at all', async () => {
    const dir = tempWorkspace({
      sharedFlag: true,
      declare: ['workbuddy'],
      promptBudget: { declaredContextWindowTokens: 262_144 },
    });
    await seedActivation(dir, 'od-2', 'globally declared principle');
    const { events, injected } = captureEmitter();
    const runtime = createProductionHostRuntime({ hostKind: 'workbuddy', events });
    await runtime.dispatch(promptEvent(dir));
    const event = injected[0];
    expect(event.budget).toBe(4096);
    expect(event.budgetCapacitySource).toBe('operator_declared');
    expect(event.budgetCapacityStatus).toBe('confirmed');
    expect(event.budgetContextWindowTokens).toBe(262_144);
  });

  it('an untrusted host source falls back honestly (fixed budget, unknown status, observable bounded reason)', async () => {
    const dir = tempWorkspace({ sharedFlag: true, declare: ['codex'] });
    await seedActivation(dir, 'fb-1', 'fallback principle');
    const { events, injected } = captureEmitter();
    const runtime = createProductionHostRuntime({ hostKind: 'codex', events });
    await runtime.dispatch(promptEvent(dir, {
      contextTokenBudget: 999_999,
      contextWindowSource: 'default',
      modelId: 'no-such-model-in-catalog',
    }));
    const event = injected[0];
    expect(event.budget).toBe(2000);
    expect(event.budgetCapacitySource).toBe('legacy_fallback');
    expect(event.budgetCapacityStatus).toBe('unknown');
    expect(event.budgetContextWindowTokens).toBeUndefined();
    // SPEC §7 v0.2: the SPECIFIC bounded reason rides the event — the
    // untrusted 'default' source is the primary failure (the unknown model
    // name could not rescue it, but that is secondary detail).
    expect(event.budgetFallbackReason).toBe('host_capacity_source_untrusted');
  });

  it('no modelContext at all (WorkBuddy contract today) resolves the legacy fixed budget (AC-04)', async () => {
    const dir = tempWorkspace({ sharedFlag: true, declare: ['workbuddy'] });
    await seedActivation(dir, 'wb-1', 'workbuddy principle');
    const { events, injected } = captureEmitter();
    const runtime = createProductionHostRuntime({ hostKind: 'workbuddy', events });
    await runtime.dispatch(promptEvent(dir));
    const event = injected[0];
    expect(event.hostKind).toBe('workbuddy');
    expect(event.budget).toBe(2000);
    expect(event.budgetCapacitySource).toBe('legacy_fallback');
    expect(event.budgetCapacityStatus).toBe('unknown');
    expect(event.budgetFallbackReason).toBe('host_capacity_absent');
  });

  it('model identity alone resolves via the installed catalog only on an exact match (AC-03/AC-05)', async () => {
    const dir = tempWorkspace({ sharedFlag: true, declare: ['codex'] });
    await seedActivation(dir, 'mi-1', 'model identity principle');
    const { events, injected } = captureEmitter();
    const runtime = createProductionHostRuntime({ hostKind: 'codex', events });
    // exact provider+model → catalog metadata (not maxTokens, not a guess)
    await runtime.dispatch(promptEvent(dir, { modelProviderId: 'anthropic', modelId: 'claude-sonnet-4-5' }));
    expect(injected[0]?.budget).toBe(3125); // 200000-token window
    expect(injected[0]?.budgetCapacitySource).toBe('pi_catalog_exact');
    // ambiguous bare model id → honest fallback with the bounded reason code
    await runtime.dispatch(promptEvent(dir, { modelId: 'gpt-5' }));
    expect(injected[1]?.budget).toBe(2000);
    expect(injected[1]?.budgetCapacitySource).toBe('legacy_fallback');
    expect(injected[1]?.budgetFallbackReason).toBe('catalog_ambiguous_model_id');
    // custom provider id never inherits another provider capacity (AC-05)
    await runtime.dispatch(promptEvent(dir, { modelProviderId: 'my-private-proxy', modelId: 'claude-sonnet-4-5' }));
    expect(injected[2]?.budget).toBe(2000);
    expect(injected[2]?.budgetCapacitySource).toBe('legacy_fallback');
    expect(injected[2]?.budgetFallbackReason).toBe('catalog_no_exact_match');
    // v0.2: a provider-less UNANIMOUS name is still not confirmed.
    await runtime.dispatch(promptEvent(dir, { modelId: 'glm-4.7' }));
    expect(injected[3]?.budget).toBe(2000);
    expect(injected[3]?.budgetFallbackReason).toBe('catalog_provider_absent');
  });
});

// Local helper (workspace-scoped artifact read for the unconfirmed-route case).
function loadArtifactIn(workspaceDir: string, artifactId: string) {
  const connection = new SqliteConnection({ workspaceDir, readonly: true });
  try {
    const row = connection.getDb().prepare('SELECT artifact_id, artifact_kind, content_json, validation_status FROM pi_artifacts WHERE artifact_id = ?').get(artifactId) as Record<string, string>;
    return { artifactId: row.artifact_id, artifactKind: row.artifact_kind, contentJson: row.content_json, validationStatus: row.validation_status };
  } finally {
    connection.close();
  }
}
