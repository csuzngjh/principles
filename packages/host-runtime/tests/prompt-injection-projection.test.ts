import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import {
  RUNTIME_V2_PRINCIPLE_BUDGET,
  SqliteActivationStateStore,
  SqliteConnection,
  SqlitePIArtifactStore,
  filterPromptActivations,
  getDefaultPdConfig,
  resolvePrincipleFromArtifact,
  trimToBudget,
  type ActivatedPrinciple,
} from '@principles/core/runtime-v2';
import { escapeXml } from '@principles/core/prompt-builder';
import {
  buildActivePrinciplePromptContext,
  buildLivePromptInjectionProjection,
} from '../src/index.js';

const tempDirs: string[] = [];

function tempWorkspace(opts?: { sharedRoute?: boolean }): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-projection-'));
  tempDirs.push(workspaceDir);
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  const config = getDefaultPdConfig();
  if (opts?.sharedRoute) {
    // getDefaultPdConfig() shallow-spreads DEFAULT_FEATURE_FLAGS — the flag
    // objects are module-shared, so replace the entry instead of mutating it.
    config.features.abstraction_layer_v1 = { ...config.features.abstraction_layer_v1, enabled: true };
  }
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(config), 'utf8');
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
 * Independent replay of the LIVE OpenClaw legacy injection path
 * (openclaw-plugin/src/hooks/prompt.ts): PromptActivationReader-equivalent
 * primitives (same FIFO activation query → filterPromptActivations →
 * resolvePrincipleFromArtifact) then the real trimToBudget with escapeXml —
 * the exact chain the plugin executes when abstraction_layer_v1 is OFF.
 */
async function replayLiveInjectionExpectation(workspaceDir: string): Promise<{
  lines: string[]; injectedIds: Set<string>; truncated: boolean;
}> {
  const connection = new SqliteConnection(workspaceDir);
  try {
    const activations = filterPromptActivations(await new SqliteActivationStateStore(connection).listPromptActivations());
    const artifactStore = new SqlitePIArtifactStore(connection);
    const principles: ActivatedPrinciple[] = [];
    for (const activation of activations) {
      const artifact = await artifactStore.getArtifactById(activation.artifactId);
      if (artifact === null) continue;
      const resolved = resolvePrincipleFromArtifact({
        artifact_id: artifact.artifactId,
        artifact_kind: artifact.artifactKind,
        content_json: artifact.contentJson,
        validation_status: artifact.validationStatus,
      }, activation);
      if (resolved.ok) principles.push(resolved.principle);
    }
    return trimToBudget(principles, RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml);
  } finally {
    connection.close();
  }
}

const FIFO_11 = Array.from({ length: 11 }, (_, i) => ({
  principleId: `P_FIFO_${String(i + 1).padStart(2, '0')}`,
  text: 'X'.repeat(200),
}));

describe('buildLivePromptInjectionProjection (PR #1844 production path alignment)', () => {
  it('Case 1a — legacy route: ids/usedChars/truncated match the live PromptActivationReader→trimToBudget chain', async () => {
    const workspaceDir = tempWorkspace();
    await seedPromptActivations(workspaceDir, FIFO_11);

    const projection = await buildLivePromptInjectionProjection({ workspaceDir });
    const expected = await replayLiveInjectionExpectation(workspaceDir);

    expect(projection.route).toBe('legacy_trim');
    expect([...projection.injectedPrincipleIds].sort()).toEqual([...expected.injectedIds].sort());
    expect(projection.usedChars).toBe(expected.lines.join('\n').length);
    expect(projection.truncated).toBe(expected.truncated);
    expect(projection.budget).toBe(RUNTIME_V2_PRINCIPLE_BUDGET);
  });

  it('Case 1b — shared route: projection mirrors buildActivePrinciplePromptContext exactly', async () => {
    const workspaceDir = tempWorkspace({ sharedRoute: true });
    await seedPromptActivations(workspaceDir, FIFO_11);

    const projection = await buildLivePromptInjectionProjection({ workspaceDir });
    const context = await buildActivePrinciplePromptContext({ workspaceDir });

    expect(projection.route).toBe('shared_render');
    expect(projection.injectedPrincipleIds).toEqual(context.principleIds);
    expect(projection.injectedActivationIds).toEqual(context.activationIds);
    expect(projection.usedChars).toBe(context.additionalContext.length);
    expect(projection.truncated).toBe(context.truncated);
  });

  it('Case 2 — regression: 11 activations under the live flag forecast 9 injected / 2 excluded, not the shared renderer count', async () => {
    const workspaceDir = tempWorkspace();
    await seedPromptActivations(workspaceDir, FIFO_11);

    const projection = await buildLivePromptInjectionProjection({ workspaceDir });

    // trimToBudget arithmetic: header 32c + 11 × ("- [P_FIFO_NN] " + 200c + \n)
    // = each 215c → exactly 9 fit under the 2000c cap (2000 - 33 = 1967 ≥
    // 9 × 214 + 8 separators), the 10th does not.
    expect(projection.route).toBe('legacy_trim');
    expect(projection.truncated).toBe(true);
    expect(projection.injectedPrincipleIds).toHaveLength(9);
    expect(projection.injectedPrincipleIds).toEqual(FIFO_11.slice(0, 9).map((e) => e.principleId));
    expect(projection.injectedPrincipleIds).not.toContain('P_FIFO_10');
    expect(projection.injectedPrincipleIds).not.toContain('P_FIFO_11');
    expect(projection.injectedActivationIds).toHaveLength(9);
    expect(projection.usedChars).toBeLessThanOrEqual(RUNTIME_V2_PRINCIPLE_BUDGET);
    expect(projection.usedChars).toBeGreaterThan(1800);

    // The divergence this PR fixes: on the SAME activations the shared-route
    // renderer (previous forecast source) truncates far earlier.
    const sharedDir = tempWorkspace({ sharedRoute: true });
    await seedPromptActivations(sharedDir, FIFO_11);
    const shared = await buildLivePromptInjectionProjection({ workspaceDir: sharedDir });
    expect(shared.route).toBe('shared_render');
    expect(shared.injectedPrincipleIds.length).toBeLessThan(projection.injectedPrincipleIds.length);
  });

  it('Case 3 — exact budget boundary: an entry that exactly fills the cap injects; one char over discards it', async () => {
    // entry = "- [id] text"; fit rule: remaining >= entry.length + 1.
    // With a 10-char id, text 1952c → entry 1967c → joined content is
    // exactly RUNTIME_V2_PRINCIPLE_BUDGET chars.
    const exactId = 'P_BOUNDARY';
    const fits = await (async () => {
      const workspaceDir = tempWorkspace();
      await seedPromptActivations(workspaceDir, [{ principleId: exactId, text: 'Y'.repeat(RUNTIME_V2_PRINCIPLE_BUDGET - 48) }]);
      return buildLivePromptInjectionProjection({ workspaceDir });
    })();
    expect(fits.truncated).toBe(false);
    expect(fits.injectedPrincipleIds).toEqual([exactId]);
    expect(fits.usedChars).toBe(RUNTIME_V2_PRINCIPLE_BUDGET);

    const over = await (async () => {
      const workspaceDir = tempWorkspace();
      await seedPromptActivations(workspaceDir, [{ principleId: exactId, text: 'Y'.repeat(RUNTIME_V2_PRINCIPLE_BUDGET - 47) }]);
      return buildLivePromptInjectionProjection({ workspaceDir });
    })();
    expect(over.truncated).toBe(true);
    expect(over.injectedPrincipleIds).toEqual([]);
  });

  it('degrades observably when there are no candidates and when the state db is missing (rc-9)', async () => {
    const empty = tempWorkspace();
    const emptyProjection = await buildLivePromptInjectionProjection({ workspaceDir: empty });
    expect(emptyProjection).toMatchObject({
      route: 'legacy_trim', budget: RUNTIME_V2_PRINCIPLE_BUDGET, usedChars: 0, truncated: false,
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
