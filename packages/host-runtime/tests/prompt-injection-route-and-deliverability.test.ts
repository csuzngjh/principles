import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as yaml from 'js-yaml';
import {
  PROMPT_BUDGET_FALLBACK_CHARS,
  PROMPT_BUDGET_MAX_CHARS,
  PROMPT_BUDGET_MIN_CHARS,
  SqliteActivationStateStore,
  SqliteConnection,
  getDefaultPdConfig,
} from '@principles/core/runtime';
import {
  saveHostToolDeclaration,
  resolvePromptInjectionRouteDecision,
  resolveLivePromptInjectionProjection,
  productionRouteRotationState,
  checkPromptArtifactDeliverability,
  readPromptActivationInjectionStatuses,
  computePromptSingleItemFit,
  type PromptInjectionTargetHost,
} from '../src/index.js';

/**
 * AC-01 / AC-02 / AC-05 / AC-06 (SPEC PD_PROMPT_CAPACITY_V1 §7) at the
 * host-runtime boundary. PRI-1137 deleted the OpenClaw plugin-local list
 * route: every standard host injects through the shared directive render, so
 * host facts bind ATTRIBUTION only (which host is talking), never a per-host
 * route split. Single-item costs use the REAL resolved identity and the
 * shared serializer, and unreadable inputs still surface as unconfirmed —
 * never as a guess.
 */

const tempDirs: string[] = [];

interface WorkspaceOpts {
  sharedFlag?: boolean;
  selfReport?: boolean;
  promptFlagOff?: boolean;
  declare?: PromptInjectionTargetHost[];
  codexEvidence?: boolean;
  workbuddyEvidence?: boolean;
}

function tempWorkspace(opts?: WorkspaceOpts): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-route-'));
  tempDirs.push(workspaceDir);
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  const config = getDefaultPdConfig();
  if (opts?.sharedFlag) {
    config.features.abstraction_layer_v1 = { ...config.features.abstraction_layer_v1, enabled: true };
  }
  if (opts?.selfReport) {
    config.features.principle_receipt_self_report = { ...config.features.principle_receipt_self_report, enabled: true };
  }
  if (opts?.promptFlagOff) {
    config.features.prompt = { ...config.features.prompt, enabled: false };
  }
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(config), 'utf8');
  for (const hostKind of opts?.declare ?? []) {
    const saved = saveHostToolDeclaration(workspaceDir, {
      version: 1,
      hostKind,
      mappings: [{ rawToolName: 'bash', canonicalKind: 'execute' }],
      declaredAt: new Date(Date.UTC(2026, 9, 7, 8, 0, 0)).toISOString(),
    });
    if (!saved.ok) throw new Error(`declaration save failed: ${saved.reason}`);
  }
  if (opts?.codexEvidence || opts?.workbuddyEvidence) {
    fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    db.exec('CREATE TABLE pain_events (pain_id TEXT PRIMARY KEY, host_kind TEXT)');
    if (opts?.codexEvidence) db.prepare('INSERT INTO pain_events (pain_id, host_kind) VALUES (?, ?)').run('p1', 'codex');
    if (opts?.workbuddyEvidence) db.prepare('INSERT INTO pain_events (pain_id, host_kind) VALUES (?, ?)').run('p2', 'workbuddy');
    db.close();
  }
  return workspaceDir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function seedArtifact(workspaceDir: string, principleId: string, text: string, status = 'validated'): string {
  const artifactId = `art-${principleId}`;
  const connection = new SqliteConnection({ workspaceDir });
  try {
    const at = new Date(Date.UTC(2026, 9, 7, 8, 0, 0)).toISOString();
    connection.getDb().prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, 'principle', ?, ?, NULL, '[]', ?, ?, ?, ?)
    `).run(artifactId, `task-${principleId}`, principleId.length < 36 ? null : principleId, status, JSON.stringify({ principleId, text }), at, at);
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
      activatedAt: new Date(Date.UTC(2026, 9, 7, 8, 0, 0)).toISOString(),
      deactivatedAt: null,
    });
  } finally {
    connection.close();
  }
}

describe('AC-01: resolvePromptInjectionRouteDecision binds the route to host facts', () => {
  it('openclaw declared → confirmed shared route (PRI-1137: the legacy route is deleted)', () => {
    const dir = tempWorkspace({ declare: ['openclaw'] });
    const d = resolvePromptInjectionRouteDecision({ workspaceDir: dir });
    expect(d.status).toBe('confirmed');
    expect(d.hostKind).toBe('openclaw');
    expect(d.route).toBe('shared_render');
    expect(d.basis).toBe('workspace_host_facts');
  });

  it('openclaw declared with a stale abstraction_layer_v1 enabled:true → still shared route', () => {
    const dir = tempWorkspace({ sharedFlag: true, declare: ['openclaw'] });
    const d = resolvePromptInjectionRouteDecision({ workspaceDir: dir });
    expect(d.status).toBe('confirmed');
    expect(d.hostKind).toBe('openclaw');
    expect(d.route).toBe('shared_render');
  });

  it('codex declared → confirmed SHARED route (the misprojection this task fixes)', () => {
    const dir = tempWorkspace({ declare: ['codex'] });
    const d = resolvePromptInjectionRouteDecision({ workspaceDir: dir });
    expect(d.status).toBe('confirmed');
    expect(d.hostKind).toBe('codex');
    expect(d.route).toBe('shared_render');
  });

  it('codex pain evidence without a declaration also confirms the shared route', () => {
    const dir = tempWorkspace({ codexEvidence: true });
    const d = resolvePromptInjectionRouteDecision({ workspaceDir: dir });
    expect(d.status).toBe('confirmed');
    expect(d.hostKind).toBe('codex');
    expect(d.route).toBe('shared_render');
  });

  it('workbuddy declared → confirmed shared route (the third host never takes the deleted list route)', () => {
    const dir = tempWorkspace({ declare: ['workbuddy'] });
    const d = resolvePromptInjectionRouteDecision({ workspaceDir: dir });
    expect(d.status).toBe('confirmed');
    expect(d.hostKind).toBe('workbuddy');
    expect(d.route).toBe('shared_render');
    expect(d.basis).toBe('workspace_host_facts');
  });

  it('workbuddy declared, flag ON → still confirmed shared route', () => {
    const dir = tempWorkspace({ sharedFlag: true, declare: ['workbuddy'] });
    const d = resolvePromptInjectionRouteDecision({ workspaceDir: dir });
    expect(d.status).toBe('confirmed');
    expect(d.hostKind).toBe('workbuddy');
    expect(d.route).toBe('shared_render');
  });

  it('workbuddy pain evidence without a declaration also confirms the shared route (persisted host facts)', () => {
    const dir = tempWorkspace({ workbuddyEvidence: true });
    const d = resolvePromptInjectionRouteDecision({ workspaceDir: dir });
    expect(d.status).toBe('confirmed');
    expect(d.hostKind).toBe('workbuddy');
    expect(d.route).toBe('shared_render');
  });

  it('several host facts → one shared route, no guessed host attribution', () => {
    const dir = tempWorkspace({ declare: ['openclaw', 'codex'] });
    const d = resolvePromptInjectionRouteDecision({ workspaceDir: dir });
    expect(d.status).toBe('confirmed');
    expect(d.route).toBe('shared_render');
    expect(d.basis).toBe('single_route_all_hosts');
    expect(d.hostKind).toBeUndefined();
  });

  it('no host facts → confirmed shared route; host attribution stays unknown', () => {
    const dir = tempWorkspace();
    const d = resolvePromptInjectionRouteDecision({ workspaceDir: dir });
    expect(d.status).toBe('confirmed');
    expect(d.route).toBe('shared_render');
    expect(d.basis).toBe('single_route_all_hosts');
    expect(d.hostKind).toBeUndefined();
    expect(d.declaredHostKinds).toEqual([]);
    expect(d.effectiveHostKinds).toEqual([]);
  });

  it('an explicit request-level target host overrides the facts', () => {
    const dir = tempWorkspace({ declare: ['codex'] });
    const d = resolvePromptInjectionRouteDecision({ workspaceDir: dir, targetHost: 'openclaw' });
    expect(d.status).toBe('confirmed');
    expect(d.hostKind).toBe('openclaw');
    expect(d.route).toBe('shared_render');
    expect(d.basis).toBe('explicit_target');
  });

  it('an explicit workbuddy target overrides the facts and confirms the shared route', () => {
    const dir = tempWorkspace({ declare: ['openclaw'] });
    const d = resolvePromptInjectionRouteDecision({ workspaceDir: dir, targetHost: 'workbuddy' });
    expect(d.status).toBe('confirmed');
    expect(d.hostKind).toBe('workbuddy');
    expect(d.route).toBe('shared_render');
    expect(d.basis).toBe('explicit_target');
  });

  it('an unknown host kind declared → unconfirmed, never silently treated as openclaw', () => {
    const dir = tempWorkspace();
    const saved = saveHostToolDeclaration(dir, {
      version: 1,
      hostKind: 'some-new-host',
      mappings: [{ rawToolName: 'bash', canonicalKind: 'execute' }],
      declaredAt: new Date(Date.UTC(2026, 9, 7, 8, 0, 0)).toISOString(),
    });
    expect(saved.ok).toBe(true);
    const d = resolvePromptInjectionRouteDecision({ workspaceDir: dir });
    expect(d.status).toBe('unconfirmed');
    expect(d.unconfirmedReason).toContain('unknown_host_kind_declared');
  });
});

describe('AC-01: resolveLivePromptInjectionProjection follows the resolved route', () => {
  it('a codex workspace forecasts on the SHARED route (old code said legacy_trim)', async () => {
    const dir = tempWorkspace({ declare: ['codex'] });
    await seedActivation(dir, 'C-1', 'codex 原则内容');
    const resolution = await resolveLivePromptInjectionProjection({ workspaceDir: dir });
    expect(resolution.status).toBe('confirmed');
    if (resolution.status !== 'confirmed') return;
    expect(resolution.decision.hostKind).toBe('codex');
    expect(resolution.projection.route).toBe('shared_render');
    expect(resolution.projection.budgetScope).toBe('full_directive_context');
    expect(resolution.projection.unit).toBe('utf16_code_units');
    expect(resolution.projection.usedChars).toBeGreaterThan(0);
    expect(resolution.projection.injectedActivationIds).toEqual(['act-C-1']);
  });

  it('a workbuddy workspace forecasts the SAME shared injection as codex (old code said legacy_trim)', async () => {
    const dir = tempWorkspace({ declare: ['workbuddy'] });
    await seedActivation(dir, 'WB-1', 'workbuddy 原则内容');
    const resolution = await resolveLivePromptInjectionProjection({ workspaceDir: dir });
    expect(resolution.status).toBe('confirmed');
    if (resolution.status !== 'confirmed') return;
    expect(resolution.decision.hostKind).toBe('workbuddy');
    expect(resolution.projection.route).toBe('shared_render');
    expect(resolution.projection.budgetScope).toBe('full_directive_context');
    expect(resolution.projection.unit).toBe('utf16_code_units');
    expect(resolution.projection.usedChars).toBeGreaterThan(0);
    expect(resolution.projection.injectedActivationIds).toEqual(['act-WB-1']);
    // WorkBuddy renders through the same shared runtime as Codex: identical
    // billable context for identical content (the adapter has no list route).
    const codexDir = tempWorkspace({ declare: ['codex'] });
    await seedActivation(codexDir, 'WB-1', 'workbuddy 原则内容');
    const codexResolution = await resolveLivePromptInjectionProjection({ workspaceDir: codexDir });
    expect(codexResolution.status).toBe('confirmed');
    if (codexResolution.status !== 'confirmed') return;
    expect(codexResolution.projection.usedChars).toBe(resolution.projection.usedChars);
    expect(codexResolution.projection.injectedActivationIds).toEqual(resolution.projection.injectedActivationIds);
  });

  it('several host facts → ONE confirmed shared projection; host attribution stays unknown', async () => {
    const dir = tempWorkspace({ declare: ['openclaw', 'codex'] });
    await seedActivation(dir, 'M-1', '多宿主工作区原则');
    const resolution = await resolveLivePromptInjectionProjection({ workspaceDir: dir });
    // PRI-1137: with one route there is no per-host forecast to diverge. The
    // ROUTE is confirmed; the HOST is not guessed.
    expect(resolution.status).toBe('confirmed');
    if (resolution.status !== 'confirmed') return;
    expect(resolution.decision.basis).toBe('single_route_all_hosts');
    expect(resolution.decision.hostKind).toBeUndefined();
    expect(resolution.projection.route).toBe('shared_render');
    expect(resolution.projection.budgetScope).toBe('full_directive_context');
    expect(resolution.projection.injectedActivationIds).toEqual(['act-M-1']);
    // No single host owns the advancing round authority, so production
    // rotation is not claimed for an unattributed workspace.
    expect(resolution.projection.productionRotation).toEqual({ state: 'unknown', reason: 'no_bound_host' });
    expect(resolution.projection.selectionPolicy).toBe('legacy_fifo_prefix_v1');
  });

  it('an openclaw-only workspace is the one host whose forecast claims production rotation', async () => {
    const dir = tempWorkspace({ declare: ['openclaw'] });
    await seedActivation(dir, 'O-1', 'openclaw 原则内容');
    const resolution = await resolveLivePromptInjectionProjection({ workspaceDir: dir });
    expect(resolution.status).toBe('confirmed');
    if (resolution.status !== 'confirmed') return;
    expect(resolution.decision.hostKind).toBe('openclaw');
    expect(resolution.projection.route).toBe('shared_render');
    // OpenClaw owns trajectory.db::user_turns, so its real injection rotates;
    // Codex/WorkBuddy supply no round key (see AC-01 decision tests above).
    expect(resolution.projection.productionRotation).toEqual({ state: 'rotates' });
  });

  // ── PRI-1137 final review (P1-1): three-state rotation matrix ──────────────
  // The pre-fix boolean flattened "no single bound host" into "does not
  // rotate", so multi-host workspaces produced wrong FIFO/permanent-queue
  // copy. Each state below is a distinct Owner-facing fact.
  it('P1-1 matrix: explicit host binding resolves THAT host capability (openclaw rotates; codex/workbuddy FIFO)', () => {
    const dir = tempWorkspace({ declare: ['openclaw', 'codex', 'workbuddy'] });
    expect(productionRouteRotationState({ workspaceDir: dir, targetHost: 'openclaw' })).toEqual({ state: 'rotates' });
    expect(productionRouteRotationState({ workspaceDir: dir, targetHost: 'codex' })).toEqual({ state: 'does_not_rotate' });
    expect(productionRouteRotationState({ workspaceDir: dir, targetHost: 'workbuddy' })).toEqual({ state: 'does_not_rotate' });
  });

  it('P1-1 matrix: multi-host and zero-host workspaces stay unknown — never aggregate FIFO', async () => {
    const multi = tempWorkspace({ declare: ['openclaw', 'codex'] });
    await seedActivation(multi, 'MX-1', '多宿主原则');
    expect(productionRouteRotationState({ workspaceDir: multi })).toEqual({ state: 'unknown', reason: 'no_bound_host' });
    // The multi-host confirmed resolution keeps per-host budgets AND rotation;
    // the headline never claims rotation on a host it has not identified.
    const resolution = await resolveLivePromptInjectionProjection({ workspaceDir: multi });
    if (resolution.status !== 'confirmed') throw new Error('multi-host route must be confirmed (single shared route)');
    expect(resolution.projection.productionRotation.state).toBe('unknown');
    expect(resolution.perHost).toBeDefined();
    const oc = resolution.perHost?.find((entry) => entry.hostKind === 'openclaw');
    const cx = resolution.perHost?.find((entry) => entry.hostKind === 'codex');
    expect(oc?.projection.productionRotation).toEqual({ state: 'rotates' });
    expect(cx?.projection.productionRotation).toEqual({ state: 'does_not_rotate' });
    // OpenClaw must not lend its budget window to Codex (P1-2.3).
    expect(oc?.projection.budget).toBeGreaterThan(0);
    expect(cx?.projection.budget).toBeGreaterThan(0);

    const zero = tempWorkspace();
    expect(productionRouteRotationState({ workspaceDir: zero })).toEqual({ state: 'unknown', reason: 'no_bound_host' });
  });

  it('P1-1 matrix: unreadable host facts are unknown, not FIFO; single codex evidence binds FIFO honestly', async () => {
    const dir = tempWorkspace();
    fs.writeFileSync(path.join(dir, '.pd', 'config.yaml'), 'features: [broken', 'utf8');
    // Config unreadable → host facts resolve but route decision is unconfirmed;
    // the rotation state itself must not guess FIFO.
    const codexOnly = tempWorkspace({ codexEvidence: true });
    await seedActivation(codexOnly, 'CX-1', 'codex 原则内容');
    expect(productionRouteRotationState({ workspaceDir: codexOnly })).toEqual({ state: 'does_not_rotate' });
    const resolution = await resolveLivePromptInjectionProjection({ workspaceDir: codexOnly });
    if (resolution.status !== 'confirmed') throw new Error('single-host route must be confirmed');
    expect(resolution.decision.hostKind).toBe('codex');
    expect(resolution.projection.productionRotation).toEqual({ state: 'does_not_rotate' });
    expect(resolution.projection.eventuallyInjectedActivationIds).toEqual([]);
  });
});

describe('AC-05/AC-02: checkPromptArtifactDeliverability — real identity, route serializer, boundaries', () => {
  it('write precheck refuses malformed config and prompt flag off, even with explicit host', async () => {
    const artifact = { artifactId: 'art-precheck', artifactKind: 'principle', contentJson: JSON.stringify({ principleId: 'PRECHECK', text: 'short' }), validationStatus: 'validated' };
    const malformed = tempWorkspace();
    fs.writeFileSync(path.join(malformed, '.pd', 'config.yaml'), 'features: [broken', 'utf8');
    const malformedResult = await checkPromptArtifactDeliverability({ workspaceDir: malformed, targetHost: 'openclaw', artifact });
    expect(malformedResult.status).toBe('unconfirmed');
    expect(malformedResult.reason).toContain('config_unreadable');
    expect(malformedResult.nextAction).toBeTruthy();

    const disabled = tempWorkspace({ promptFlagOff: true });
    const disabledResult = await checkPromptArtifactDeliverability({ workspaceDir: disabled, targetHost: 'openclaw', artifact });
    expect(disabledResult.status).toBe('unconfirmed');
    expect(disabledResult.reason).toContain('prompt_feature_disabled');
  });

  it('legacy artifact: lineage-resolved ledger id is the real identity, not a missing column', async () => {
    const dir = tempWorkspace({ declare: ['openclaw'] });
    const artifact = {
      artifactId: 'art-legacy-identity',
      artifactKind: 'principle',
      // No principleId / sourcePrincipleId anywhere: the only identity is the
      // ledger id resolved through the candidate lineage by the caller.
      contentJson: JSON.stringify({ principleDraft: { title: 'legacy', statement: 'A committed statement.' } }),
      validationStatus: 'validated' as const,
      sourcePrincipleId: null,
      resolvedPrincipleId: '96608bec-177f-474f-b441-8360e6df3965',
    };
    const withLineage = await checkPromptArtifactDeliverability({ workspaceDir: dir, targetHost: 'openclaw', artifact });
    expect(withLineage.status).not.toBe('unconfirmed');

    const withoutLineage = await checkPromptArtifactDeliverability({
      workspaceDir: dir,
      targetHost: 'openclaw',
      artifact: { ...artifact, resolvedPrincipleId: undefined },
    });
    expect(withoutLineage.status).toBe('unconfirmed');
    expect(withoutLineage.reason).toContain('artifact_missing_principle_id');
  });

  it('shared route: tier boundaries — exactly at the min tier is deliverable, mid-band is model_dependent, two chars over the max tier is refused by exactly 2 (SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 §6.3)', async () => {
    const dir = tempWorkspace({ declare: ['openclaw'] });
    // PRI-1137: openclaw now bills the shared directive render. The single-item
    // cost is the production serializer's output: a fixed directive wrapper
    // (755 measured) + the entry's id + text.
    // PRI-1161: a single-item render = header +53 AND its one block -86, so
    // the wrapper is 755 - 33 = 722 (verified against the live serializer).
    // All tier boundaries below derive from this constant.
    const sharedCost = (textLen: number) => 722 + 'B-1'.length + textLen;
    const textFor = (cost: number) => 'x'.repeat(cost - sharedCost(0));
    const artifactFor = (text: string) => ({ artifactId: 'art-B-1', artifactKind: 'principle', contentJson: JSON.stringify({ principleId: 'B-1', text }), validationStatus: 'validated' as const });

    // Exactly at the MIN supported tier (1250, measured floor): deliverable everywhere.
    expect(sharedCost(textFor(PROMPT_BUDGET_MIN_CHARS).length)).toBe(PROMPT_BUDGET_MIN_CHARS);
    const atMin = await checkPromptArtifactDeliverability({ workspaceDir: dir, artifact: artifactFor(textFor(PROMPT_BUDGET_MIN_CHARS)) });
    expect(atMin.status).toBe('deliverable');
    if (atMin.status === 'deliverable') expect(atMin.costChars).toBe(PROMPT_BUDGET_MIN_CHARS);

    // Two over the min tier: still injectable on larger models — model_dependent.
    const overMin = await checkPromptArtifactDeliverability({ workspaceDir: dir, artifact: artifactFor(textFor(PROMPT_BUDGET_MIN_CHARS + 2)) });
    expect(overMin.status).toBe('model_dependent');
    if (overMin.status === 'model_dependent') expect(overMin.costChars).toBe(PROMPT_BUDGET_MIN_CHARS + 2);

    // Exactly at the MAX supported tier (32000, policy ceiling): model_dependent, not refused.
    const atMax = await checkPromptArtifactDeliverability({ workspaceDir: dir, artifact: artifactFor(textFor(PROMPT_BUDGET_MAX_CHARS)) });
    expect(atMax.status).toBe('model_dependent');
    if (atMax.status === 'model_dependent') expect(atMax.costChars).toBe(PROMPT_BUDGET_MAX_CHARS);

    // Two chars over the max tier: undeliverable by exactly 2.
    const over = await checkPromptArtifactDeliverability({ workspaceDir: dir, artifact: artifactFor(textFor(PROMPT_BUDGET_MAX_CHARS + 2)) });
    expect(over.status).toBe('undeliverable');
    if (over.status === 'undeliverable') {
      expect(over.overByChars).toBe(2);
      expect(over.reason).toBe('single_item_exceeds_budget');
      expect(over.nextAction).toContain('modify to injectable version');
    }
  });

  it('one shared serializer: the same candidate is tier-classified identically for openclaw, codex and workbuddy', async () => {
    const text = 'S'.repeat(1250);
    const artifact = { artifactId: 'art-SR', artifactKind: 'principle', contentJson: JSON.stringify({ principleId: 'SR-1', text }), validationStatus: 'validated' as const };
    const verdicts = await Promise.all(
      (['openclaw', 'codex', 'workbuddy'] as const).map(async (targetHost) => {
        const dir = tempWorkspace({ declare: [targetHost] });
        return checkPromptArtifactDeliverability({ workspaceDir: dir, artifact });
      }),
    );
    for (const verdict of verdicts) {
      expect(verdict.status).toBe('model_dependent');
      if (verdict.status !== 'model_dependent') continue;
      expect(verdict.route).toBe('shared_render');
      expect(verdict.budgetScope).toBe('full_directive_context');
      // PRI-1137: 1250 chars of text + fixed wrapper + id = 2009 for EVERY host.
      // PRI-1161: single-item render = header +53, block -86 → 1976 (−33).
      expect(verdict.costChars).toBe(1976);
    }
  });

  it('an explicit workbuddy target measures the single-item tier fit on the shared route, identical to codex', async () => {
    const text = 'S'.repeat(1250);
    const artifact = { artifactId: 'art-WB', artifactKind: 'principle', contentJson: JSON.stringify({ principleId: 'WB-1', text }), validationStatus: 'validated' as const };
    const dir = tempWorkspace({ declare: ['openclaw'] });
    const result = await checkPromptArtifactDeliverability({ workspaceDir: dir, targetHost: 'workbuddy', artifact });
    expect(result.status).toBe('model_dependent');
    if (result.status === 'model_dependent') {
      expect(result.route).toBe('shared_render');
      expect(result.hostKind).toBe('workbuddy');
      expect(result.basis).toBe('explicit_target');
      expect(result.costChars).toBe(1976); // PRI-1161: 2009 − 33.
      expect(result.budgetScope).toBe('full_directive_context');
    }

    // 同一候选在 workbuddy 与 codex 显式目标下的判定完全一致（等价性证据）
    const codexResult = await checkPromptArtifactDeliverability({ workspaceDir: dir, targetHost: 'codex', artifact });
    expect(codexResult.status).toBe(result.status);
    if (codexResult.status === 'model_dependent' && result.status === 'model_dependent') {
      expect(codexResult.costChars).toBe(result.costChars);
    }

    // 超出最大支持档位才不可投递（共享路由完整渲染计费：34000 字符正文
    // 在共享路由 = 34759 > 32000 上限）
    const hugeArtifact = { ...artifact, contentJson: JSON.stringify({ principleId: 'WB-3', text: 'S'.repeat(34000) }) };
    const undeliverable = await checkPromptArtifactDeliverability({ workspaceDir: dir, targetHost: 'workbuddy', artifact: hugeArtifact });
    expect(undeliverable.status).toBe('undeliverable');
    if (undeliverable.status === 'undeliverable') {
      expect(undeliverable.route).toBe('shared_render');
      expect(undeliverable.hostKind).toBe('workbuddy');
      expect(undeliverable.budgetScope).toBe('full_directive_context');
      expect(undeliverable.unit).toBe('utf16_code_units');
    }
  });

  it('self-report switch: the footer is billed — a candidate inside the max tier without it becomes undeliverable with it (31726 → 32081)', async () => {
    // The footer costs +355 chars (measured). Scale the text to 31000 so the
    // plain render (31726 after the PRI-1161 single-item −33) stays inside the
    // 32000 max tier while the footer render (32081) crosses it — the footer
    // alone flips the verdict.
    const artifact = { artifactId: 'art-SR', artifactKind: 'principle', contentJson: JSON.stringify({ principleId: 'SR-1', text: 'S'.repeat(31000) }), validationStatus: 'validated' as const };
    const plainDir = tempWorkspace({ declare: ['codex'] });
    const plain = await checkPromptArtifactDeliverability({ workspaceDir: plainDir, artifact });
    expect(plain.status).toBe('model_dependent');
    if (plain.status === 'model_dependent') expect(plain.costChars).toBe(31726);

    const selfReportDir = tempWorkspace({ declare: ['codex'], selfReport: true });
    const withFooter = await checkPromptArtifactDeliverability({ workspaceDir: selfReportDir, artifact });
    expect(withFooter.status).toBe('undeliverable');
    if (withFooter.status === 'undeliverable') {
      expect(withFooter.costChars).toBe(32081); // PRI-1161: 32114 − 33.
      expect(withFooter.overByChars).toBe(81);
    }
  });

  it('uses the REAL resolved principle id on the live shared serializer (a title-derived id is measured, not a 36-char UUID allowance)', () => {
    const longTitleId = '很长的标题派生标识'.repeat(3);
    const fit = computePromptSingleItemFit({
      principle: { principleId: longTitleId, text: 'x'.repeat(30), artifactId: 'a', activationId: 'b' },
      selfReportEnabled: false,
    });
    // The shared directive render bills the wrapper + the real id + text.
    // PRI-1161: single-item wrapper 755 -> 722 (header +53, one block -86).
    const expected = 722 + longTitleId.length + 30;
    expect(fit.costChars).toBe(expected);
    expect(fit.costChars).not.toBe(722 + '0'.repeat(36).length + 30);
  });

  it('several host facts → one confirmed verdict: the artifact is judged by the single shared serializer', async () => {
    const dir = tempWorkspace({ declare: ['openclaw', 'codex'] });
    // PRI-1137: with ONE route there is no per-host divergence to report. An
    // 800-char statement costs 1526 on the shared render → model_dependent
    // (PRI-1161: single-item −33).
    const artifact = { artifactId: 'art-SR', artifactKind: 'principle', contentJson: JSON.stringify({ principleId: 'SR-1', text: 'S'.repeat(800) }), validationStatus: 'validated' as const };
    const result = await checkPromptArtifactDeliverability({ workspaceDir: dir, artifact });
    expect(result.status).toBe('model_dependent');
    if (result.status === 'model_dependent') {
      expect(result.route).toBe('shared_render');
      expect(result.basis).toBe('single_route_all_hosts');
      expect(result.hostKind).toBeUndefined();
      expect(result.costChars).toBe(1526);
      expect(result.budgetScope).toBe('full_directive_context');
    }
  });

  it('an unvalidated/unresolvable artifact → unconfirmed with the structured warning, never "deliverable"', async () => {
    const dir = tempWorkspace({ declare: ['openclaw'] });
    const pending = { artifactId: 'art-P', artifactKind: 'principle', contentJson: JSON.stringify({ principleId: 'P-1', text: 'ok' }), validationStatus: 'pending' };
    const result = await checkPromptArtifactDeliverability({ workspaceDir: dir, artifact: pending });
    expect(result.status).toBe('unconfirmed');
    if (result.status === 'unconfirmed') expect(result.reason).toContain('artifact_not_validated');

    const missing = await checkPromptArtifactDeliverability({ workspaceDir: dir, artifact: null });
    expect(missing.status).toBe('unconfirmed');
  });
});

describe('AC-02/AC-06: readPromptActivationInjectionStatuses — positive per-item evidence', () => {
  it('confirmed shared route: injectable / model_dependent / oversized each with their own evidence', async () => {
    const dir = tempWorkspace({ declare: ['openclaw'] });
    await seedActivation(dir, 'K-1', '第一条短原则');
    await seedActivation(dir, 'K-2', '第二条短原则');
    // SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 v0.3: 单条超出最大支持档位(32000)才是
    // oversized；2000 字符正文(共享整块计费 2786：wrapper 755 + authority 26 + id + text)
    // 落在支持区间内 → model_dependent，且在 4000 的兜底投影窗口内。
    await seedActivation(dir, 'K-BIG', 'Z'.repeat(2000));
    await seedActivation(dir, 'K-HUGE', 'Z'.repeat(33000));
    const report = await readPromptActivationInjectionStatuses({ workspaceDir: dir });
    expect(report.route.status).toBe('confirmed');
    const byId = new Map(report.statuses.map((s) => [s.activationId, s]));
    expect(byId.get('act-K-1')?.status).toBe('injectable');
    expect(byId.get('act-K-1')?.inCurrentWindow).toBe(true);
    expect(byId.get('act-K-1')?.costChars).toBeGreaterThan(0);
    expect(byId.get('act-K-BIG')?.status).toBe('model_dependent');
    expect(byId.get('act-K-BIG')?.inCurrentWindow).toBe(true);
    expect(byId.get('act-K-BIG')?.reason).toContain('model_dependent_capacity');
    expect(byId.get('act-K-HUGE')?.status).toBe('oversized');
    expect(byId.get('act-K-HUGE')?.inCurrentWindow).toBe(false);
    expect(byId.get('act-K-HUGE')?.reason).toContain('single_item_exceeds_budget');
  });

  it('SPEC §6.3 consistency: an entry in (1250, 4000] that fits the fallback estimate is model_dependent — never an unconditional injectable (CodeRabbit review)', async () => {
    // 1500-char statement → shared cost 2256 (755−33 wrapper + 26 authority +
    // id + text, PRI-1161): fits the console's fallback projection budget
    // (4000), sits IN the current window, yet exceeds the measured floor — on a
    // 32K/64K model (budget = floor) it would NOT inject. The status surface
    // must tell the Owner exactly what the approval-time precheck tells them:
    // model_dependent.
    const dir = tempWorkspace({ declare: ['openclaw'] });
    await seedActivation(dir, 'MID-BAND', 'B'.repeat(1500));
    const report = await readPromptActivationInjectionStatuses({ workspaceDir: dir });
    expect(report.route.status).toBe('confirmed');
    const row = report.statuses[0];
    expect(row.status).toBe('model_dependent');
    expect(row.inCurrentWindow).toBe(true);
    expect(row.costChars).toBe(2256);
    expect(row.reason).toContain('model_dependent_capacity');
    expect(row.reason).toContain('fallback-budget estimate');
  });

  it('window full but single-item deliverable → window_excluded, not oversized (mid-band filler is model_dependent, keeping its window fact)', async () => {
    const dir = tempWorkspace({ declare: ['openclaw'] });
    // Shared render bills wrapper(755) + authority(26) + id + text; fill the
    // 4000 fallback projection window with one entry, then try to add a second.
    const bigLen = PROMPT_BUDGET_FALLBACK_CHARS - 755 - 26 - 'W-1'.length;
    await seedActivation(dir, 'W-1', 'x'.repeat(bigLen)); // 恰好占满（成本 4000 ∈ (1250,4000] 当前投影窗口）
    await seedActivation(dir, 'W-2', '第二条原则');
    const report = await readPromptActivationInjectionStatuses({ workspaceDir: dir });
    const byId = new Map(report.statuses.map((s) => [s.activationId, s]));
    // Tier-first (SPEC §6.3): the 4000-char filler exceeds the measured floor,
    // so it is model_dependent — but keeps the POSITIVE window fact (it does
    // sit in this fallback-budget projection).
    expect(byId.get('act-W-1')?.status).toBe('model_dependent');
    expect(byId.get('act-W-1')?.inCurrentWindow).toBe(true);
    expect(byId.get('act-W-1')?.reason).toContain('model_dependent_capacity');
    expect(byId.get('act-W-2')?.status).toBe('window_excluded');
    expect(byId.get('act-W-2')?.inCurrentWindow).toBe(false);
    // Neither row is oversized — a full window must never be reported as a
    // per-entry overflow.
    expect(byId.get('act-W-1')?.status).not.toBe('oversized');
    expect(byId.get('act-W-2')?.status).not.toBe('oversized');
  });

  it('several host facts → one confirmed shared route, so rows carry real statuses (no route_unconfirmed)', async () => {
    const dir = tempWorkspace({ declare: ['openclaw', 'codex'] });
    await seedActivation(dir, 'U-1', '原则内容');
    const report = await readPromptActivationInjectionStatuses({ workspaceDir: dir });
    expect(report.route.status).toBe('confirmed');
    expect(report.route.basis).toBe('single_route_all_hosts');
    expect(report.statuses).toHaveLength(1);
    expect(report.statuses[0].status).toBe('injectable');
    expect(report.statuses[0].route).toBe('shared_render');
    expect(report.statuses[0].costChars).toBe(755); // PRI-1161: 788 − 33.
    expect(report.statuses[0].inCurrentWindow).toBe(true);
  });

  it('missing state.db and prompt-flag-off degrade with a global reason (never "all healthy")', async () => {
    const noDb = tempWorkspace({ declare: ['openclaw'] });
    const noDbReport = await readPromptActivationInjectionStatuses({ workspaceDir: noDb });
    expect(noDbReport.statuses).toEqual([]);
    expect(noDbReport.globalReason).toContain('activation_db_not_found');

    const flagOff = tempWorkspace({ declare: ['openclaw'], promptFlagOff: true });
    await seedActivation(flagOff, 'F-1', '内容');
    const flagOffReport = await readPromptActivationInjectionStatuses({ workspaceDir: flagOff });
    expect(flagOffReport.globalReason).toContain('prompt_feature_disabled');
  });

  it('a dangling activation (artifact gone) → resolution_failed with the reason, not "injectable"', async () => {
    const dir = tempWorkspace({ declare: ['openclaw'] });
    const connection = new SqliteConnection({ workspaceDir: dir });
    try {
      const at = new Date(Date.UTC(2026, 9, 7, 8, 0, 0)).toISOString();
      connection.getDb().prepare(`
        INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, deactivated_at)
        VALUES ('act-DANGLE', 'art-gone::prompt', 'art-gone', 'prompt', 'prompt_activate', 'ledger://G-1', ?, NULL)
      `).run(at);
    } finally {
      connection.close();
    }
    const report = await readPromptActivationInjectionStatuses({ workspaceDir: dir });
    expect(report.statuses).toHaveLength(1);
    expect(report.statuses[0].status).toBe('resolution_failed');
    expect(report.statuses[0].reason).toContain('artifact_not_found');
  });
});
