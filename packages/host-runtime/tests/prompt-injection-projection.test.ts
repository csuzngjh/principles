import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import {
  RUNTIME_PRINCIPLE_BUDGET,
  SqliteActivationStateStore,
  SqliteConnection,
  getDefaultPdConfig,
} from '@principles/core/runtime';
import {
  buildActivePrinciplePromptContext,
  buildLivePromptInjectionProjection,
  packSharedDirectives,
  resolvePromptInjectionRouteDecision,
} from '../src/index.js';

const tempDirs: string[] = [];

function tempWorkspace(): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-projection-'));
  tempDirs.push(workspaceDir);
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(getDefaultPdConfig()), 'utf8');
  return workspaceDir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

async function seedPromptActivations(
  workspaceDir: string,
  entries: { principleId: string; text: string }[],
): Promise<void> {
  const connection = new SqliteConnection(workspaceDir);
  try {
    const base = Date.UTC(2026, 8, 23, 12, 0, 0);
    const insertArtifact = connection.getDb().prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const store = new SqliteActivationStateStore(connection);
    for (let i = 0; i < entries.length; i += 1) {
      const { principleId, text } = entries[i]!;
      const artifactId = `art-${principleId}`;
      const at = new Date(base + i * 60_000).toISOString();
      insertArtifact.run(artifactId, 'principle', `task-${principleId}`, principleId, null, '[]', 'validated', JSON.stringify({ principleId, text }), at, at);
      await store.recordActivation({
        activationId: `act-${principleId}`, idempotencyKey: `${artifactId}::prompt`, artifactId,
        channel: 'prompt', action: 'prompt_activate', targetRef: `ledger://${principleId}`,
        activatedAt: at, deactivatedAt: null,
      });
    }
  } finally {
    connection.close();
  }
}

/**
 * PRI-1137: the retired OpenClaw plugin-local list-render expectation
 * (`trimToBudget` over `- [id] text` lines) is NOT replayed here — it no
 * longer exists in production, so asserting against it would prove parity
 * with a deleted path. Equivalence is asserted against the live shared
 * projection (`buildActivePrinciplePromptContext`) instead.
 */

// PRI-1137 characterization: under the shared directive render (fixed wrapper
// 755 chars + 394 per 400-char entry), a 4000-char budget admits 5 of 11
// entries (3444 chars). The old fixture assumed the deleted list route billed
// ~413/entry and admitted 9.
// PRI-1161: each entry is 86 chars cheaper and the wrapper is +53; the text is
// scaled by the same 86 so the per-entry cost (and therefore the tuned
// admitted count) is preserved exactly under the hoisted renderer.
const FIFO_11 = Array.from({ length: 11 }, (_, i) => ({
  principleId: `P_FIFO_${String(i + 1).padStart(2, '0')}`,
  text: 'X'.repeat(486),
}));
const FIFO_11_INJECTED = 5;

describe('buildLivePromptInjectionProjection (PR #1844 production path alignment)', () => {
  it('fails route preflight closed when config is unreadable, even with an explicit host', () => {
    const workspaceDir = tempWorkspace();
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), 'features: [broken', 'utf8');
    const decision = resolvePromptInjectionRouteDecision({ workspaceDir, targetHost: 'openclaw' });
    expect(decision.status).toBe('unconfirmed');
    expect(decision.unconfirmedReason).toContain('config_unreadable');
    expect(decision.nextAction).toBeTruthy();
  });

  it('allows explicit host binding when unrelated host facts cannot be read', () => {
    const workspaceDir = tempWorkspace();
    fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.state', 'trajectory.db'), 'not sqlite', 'utf8');
    const decision = resolvePromptInjectionRouteDecision({ workspaceDir, targetHost: 'codex' });
    expect(decision.status).toBe('confirmed');
    expect(decision.hostKind).toBe('codex');
    expect(decision.basis).toBe('explicit_target');
    expect(decision.hostFactsStatus).toBe('unreadable');
  });

  it('rejects route confirmation when the prompt feature is disabled', () => {
    const workspaceDir = tempWorkspace();
    const config = getDefaultPdConfig();
    config.features.prompt = { ...config.features.prompt, enabled: false };
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(config), 'utf8');
    const decision = resolvePromptInjectionRouteDecision({ workspaceDir, targetHost: 'openclaw' });
    expect(decision.status).toBe('unconfirmed');
    expect(decision.unconfirmedReason).toContain('prompt_feature_disabled');
  });

  it('Case 1 — the projection mirrors buildActivePrinciplePromptContext exactly (the one shared route)', async () => {
    const workspaceDir = tempWorkspace();
    await seedPromptActivations(workspaceDir, FIFO_11);

    const projection = await buildLivePromptInjectionProjection({ workspaceDir });
    const context = await buildActivePrinciplePromptContext({ workspaceDir });

    expect(projection.route).toBe('shared_render');
    expect(projection.injectedPrincipleIds).toEqual(context.principleIds);
    expect(projection.injectedActivationIds).toEqual(context.activationIds);
    expect(projection.usedChars).toBe(context.additionalContext.length);
    expect(projection.truncated).toBe(context.truncated);
    expect(projection.selectionPolicy).toBe('legacy_fifo_prefix_v1');
    expect(projection.budgetScope).toBe('full_directive_context');
    expect(projection.budget).toBe(RUNTIME_PRINCIPLE_BUDGET);
  });

  it('Case 2 — characterization: 11 activations under the shared renderer inject 5 / exclude 6', async () => {
    const workspaceDir = tempWorkspace();
    await seedPromptActivations(workspaceDir, FIFO_11);

    const projection = await buildLivePromptInjectionProjection({ workspaceDir });

    // Shared render arithmetic: wrapper 755c + 11 × (394c entry) — 5 fit under
    // the active 4000-char budget (3444c), the 6th would cross it.
    expect(projection.route).toBe('shared_render');
    expect(projection.truncated).toBe(true);
    expect(projection.injectedPrincipleIds).toHaveLength(FIFO_11_INJECTED);
    expect(projection.injectedPrincipleIds).toEqual(FIFO_11.slice(0, FIFO_11_INJECTED).map((e) => e.principleId));
    expect(projection.injectedPrincipleIds).not.toContain(`P_FIFO_${String(FIFO_11_INJECTED + 1).padStart(2, '0')}`);
    expect(projection.injectedActivationIds).toHaveLength(FIFO_11_INJECTED);
    expect(projection.usedChars).toBeLessThanOrEqual(RUNTIME_PRINCIPLE_BUDGET);
    expect(projection.usedChars).toBeGreaterThan(3000);
  });

  // ── PR-1894: the console/production policy divergence ──────────────────────
  // Before this fix the projection omitted the round key, so it always ran
  // legacy_fifo_prefix_v1 and structurally excluded the NEWEST activation from
  // every truncated selection. The console then told the Owner their fresh
  // principle "will NOT enter agent behavior until older ones are deactivated"
  // while the live plugin route (fair rotation) injected it within N turns.

  it('PR-1894: a caller-supplied round key selects fair_rotation_v1 and reports it', async () => {
    const workspaceDir = tempWorkspace();
    await seedPromptActivations(workspaceDir, FIFO_11);

    // PRI-1137: only OpenClaw owns an advancing round authority; host
    // attribution must ride the projection so `productionRotation` is truthful.
    const withKey = await buildLivePromptInjectionProjection({ workspaceDir, targetHost: 'openclaw', roundKey: 3 });
    expect(withKey.selectionPolicy).toBe('fair_rotation_v1');
    expect(withKey.productionRotation).toEqual({ state: 'rotates' });
    expect(withKey.eligibleCount).toBe(11);

    const withoutKey = await buildLivePromptInjectionProjection({ workspaceDir, targetHost: 'openclaw' });
    expect(withoutKey.selectionPolicy).toBe('legacy_fifo_prefix_v1');
  });

  it('PR-1894: the newest activation is reachable by rotation even though FIFO drops it', async () => {
    const workspaceDir = tempWorkspace();
    await seedPromptActivations(workspaceDir, FIFO_11);

    // No round key — exactly the console's situation.
    const projection = await buildLivePromptInjectionProjection({ workspaceDir, targetHost: 'openclaw' });
    const newest = FIFO_11[FIFO_11.length - 1]!;
    expect(projection.injectedActivationIds).not.toContain(`act-${newest.principleId}`);
    // ...yet production reaches it within the ring, so the console must report
    // "queued", not "starved".
    expect(projection.eventuallyInjectedActivationIds).toContain(`act-${newest.principleId}`);
    expect(projection.eventuallyInjectedActivationIds).toHaveLength(11);
  });

  it('PR-1894: an entry larger than the whole budget is never reachable (true starvation)', async () => {
    const workspaceDir = tempWorkspace();
    await seedPromptActivations(workspaceDir, [
      { principleId: 'P_SMALL', text: 'ok' },
      { principleId: 'P_HUGE', text: 'H'.repeat(RUNTIME_PRINCIPLE_BUDGET * 2) },
    ]);

    const projection = await buildLivePromptInjectionProjection({ workspaceDir, targetHost: 'openclaw' });
    expect(projection.productionRotation).toEqual({ state: 'rotates' });
    // Oversized entries can never fit in any round — rotation does not save them.
    expect(projection.eventuallyInjectedActivationIds).not.toContain('act-P_HUGE');
  });

  it('a workspace without OpenClaw attribution claims no rotation and no reachability', async () => {
    const workspaceDir = tempWorkspace();
    await seedPromptActivations(workspaceDir, FIFO_11);

    const projection = await buildLivePromptInjectionProjection({ workspaceDir });
    expect(projection.route).toBe('shared_render');
    expect(projection.productionRotation).toEqual({ state: 'unknown', reason: 'no_bound_host' });
    expect(projection.eventuallyInjectedActivationIds).toEqual([]);
  });

  it('Case 3 — exact budget boundary: an entry that exactly fills the cap injects; one char over is oversized', async () => {
    // PRI-1137: derive the exact boundary from the real shared packer instead of
    // hard-coding wrapper arithmetic, so the test tracks the renderer.
    const exactId = 'P_BOUNDARY';
    const emptyCost = packSharedDirectives({
      scanOrder: [{
        principleId: exactId,
        text: '',
        artifactId: 'artifact-P_BOUNDARY',
        activationId: 'act-P_BOUNDARY',
        authority: 'system_policy',
      }],
      budgetChars: Number.MAX_SAFE_INTEGER,
      selfReportEnabled: false,
      continueOnNonFit: false,
    }).additionalContext.length;
    const exactTextLen = RUNTIME_PRINCIPLE_BUDGET - emptyCost;
    const fits = await (async () => {
      const workspaceDir = tempWorkspace();
      await seedPromptActivations(workspaceDir, [{ principleId: exactId, text: 'Y'.repeat(exactTextLen) }]);
      return buildLivePromptInjectionProjection({ workspaceDir });
    })();
    expect(fits.truncated).toBe(false);
    expect(fits.injectedPrincipleIds).toEqual([exactId]);
    expect(fits.usedChars).toBe(RUNTIME_PRINCIPLE_BUDGET);

    const over = await (async () => {
      const workspaceDir = tempWorkspace();
      await seedPromptActivations(workspaceDir, [{ principleId: exactId, text: 'Y'.repeat(exactTextLen + 1) }]);
      return buildLivePromptInjectionProjection({ workspaceDir });
    })();
    // A single entry that cannot fit even an empty payload is OVERSIZED, not
    // merely truncated: rotation/fairness cannot rescue it.
    expect(over.truncated).toBe(false);
    expect(over.injectedPrincipleIds).toEqual([]);
    expect(over.oversizedActivationIds).toEqual([`act-${exactId}`]);
  });

  it('degrades observably when there are no candidates and when the state db is missing (rc-9)', async () => {
    const empty = tempWorkspace();
    const emptyProjection = await buildLivePromptInjectionProjection({ workspaceDir: empty });
    expect(emptyProjection).toMatchObject({
      route: 'shared_render', budget: RUNTIME_PRINCIPLE_BUDGET, usedChars: 0, truncated: false,
    });
    expect(emptyProjection.injectedPrincipleIds).toEqual([]);

    const noDb = tempWorkspace();
    fs.rmSync(path.join(noDb, '.pd', 'state.db'), { force: true });
    const noDbProjection = await buildLivePromptInjectionProjection({ workspaceDir: noDb });
    expect(noDbProjection.usedChars).toBe(0);
    expect(noDbProjection.truncated).toBe(false);
    expect(noDbProjection.warnings.join(' ')).toContain('activation_db_not_found');
  });
});
