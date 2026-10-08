import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import {
  RUNTIME_V2_PRINCIPLE_BUDGET,
  SqliteActivationStateStore,
  SqliteConnection,
  getDefaultPdConfig,
  renderPrinciplesToDirectives,
  trimToBudget,
  type ActivatedPrinciple,
} from '@principles/core/runtime-v2';
import { escapeXml } from '@principles/core/prompt-builder';
import {
  buildActivePrinciplePromptContext,
  createProductionHostRuntime,
  readPromptActivationCandidates,
} from '../src/index.js';
import type { HostEvent, HostEventEmitter } from '@principles/core/host';

const tempDirs: string[] = [];

function tempWorkspace(): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-fair-rotation-'));
  tempDirs.push(workspaceDir);
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  // Default config: prompt flag on, self-report off — the same baseline the
  // projection tests seed (getDefaultPdConfig keeps every flag at default).
  fs.writeFileSync(
    path.join(workspaceDir, '.pd', 'config.yaml'),
    yaml.dump(getDefaultPdConfig()),
    'utf8',
  );
  return workspaceDir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort (Windows SQLite handle drain) */ }
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

describe('buildActivePrinciplePromptContext — PRI-904 fair rotation (shared route)', () => {
  it('without a round key it keeps the legacy FIFO prefix policy (rollback baseline)', async () => {
    const workspaceDir = tempWorkspace();
    await seedPromptActivations(workspaceDir, [
      { principleId: 'SH_A', text: 'a'.repeat(300) },
      { principleId: 'SH_B', text: 'b'.repeat(300) },
      { principleId: 'SH_C', text: 'c'.repeat(300) },
    ]);
    const result = await buildActivePrinciplePromptContext({ workspaceDir });
    expect(result.selectionPolicy).toBe('legacy_fifo_prefix_v1');
    expect(result.additionalContext.length).toBeLessThanOrEqual(RUNTIME_V2_PRINCIPLE_BUDGET);
  });

  it('rotates the scan start and continues past non-fitting entries under a round key', async () => {
    const workspaceDir = tempWorkspace();
    // Directive blocks are ~350c each under the 2000c budget → roughly 5 fit.
    const entries = Array.from({ length: 8 }, (_, i) => ({
      principleId: `SH_R${i}`,
      text: 'r'.repeat(300),
    }));
    await seedPromptActivations(workspaceDir, entries);

    const round0 = await buildActivePrinciplePromptContext({ workspaceDir, roundKey: 0 });
    const round5 = await buildActivePrinciplePromptContext({ workspaceDir, roundKey: 5 });

    expect(round0.selectionPolicy).toBe('fair_rotation_v1');
    expect(round0.rotationStartIndex).toBe(0);
    expect(round5.rotationStartIndex).toBe(5);
    // Rotation actually moves the window: the two rounds differ in membership
    // while both stay within budget.
    expect(round0.additionalContext.length).toBeLessThanOrEqual(RUNTIME_V2_PRINCIPLE_BUDGET);
    expect(round5.additionalContext.length).toBeLessThanOrEqual(RUNTIME_V2_PRINCIPLE_BUDGET);
    expect(new Set(round0.principleIds)).not.toEqual(new Set(round5.principleIds));

    // Bounded diagnostics describe the truncation.
    expect(round0.eligibleCount).toBe(8);
    expect(round0.droppedActivationIds!.length).toBeGreaterThan(0);
    expect(round0.droppedActivationIds!.length).toBeLessThanOrEqual(16);
    expect(round0.truncated).toBe(true);

    // Determinism: same round key → identical output.
    const round5again = await buildActivePrinciplePromptContext({ workspaceDir, roundKey: 5 });
    expect(round5again.additionalContext).toBe(round5.additionalContext);
    expect(round5again.principleIds).toEqual(round5.principleIds);

    // Full coverage: every eligible principle appears across 8 consecutive keys.
    const union = new Set<string>();
    for (let k = 0; k < 8; k++) {
      const r = await buildActivePrinciplePromptContext({ workspaceDir, roundKey: k });
      for (const id of r.principleIds) union.add(id);
    }
    expect(union.size).toBe(8);
  });

  it('classifies never-fitting entries as oversized without setting truncated', async () => {
    const workspaceDir = tempWorkspace();
    await seedPromptActivations(workspaceDir, [
      { principleId: 'SH_OK1', text: 'ok one' },
      { principleId: 'SH_HUGE', text: 'h'.repeat(4000) },
      { principleId: 'SH_OK2', text: 'ok two' },
    ]);
    const result = await buildActivePrinciplePromptContext({ workspaceDir, roundKey: 0 });
    expect(result.principleIds).toContain('SH_OK1');
    expect(result.principleIds).toContain('SH_OK2'); // scan continued past the huge entry
    expect(result.principleIds).not.toContain('SH_HUGE');
    expect(result.oversizedActivationIds).toEqual(['act-SH_HUGE']);
    expect(result.droppedActivationIds ?? []).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('all candidates excluded + roundKey: degrades to legacy without a NaN rotation start (CodeRabbit finding)', async () => {
    const workspaceDir = tempWorkspace();
    await seedPromptActivations(workspaceDir, [{ principleId: 'SH_X', text: 'excluded everywhere' }]);
    const result = await buildActivePrinciplePromptContext({
      workspaceDir,
      roundKey: 12345,
      excludePrincipleIds: new Set(['SH_X']),
    });
    expect(result.selectionPolicy).toBe('legacy_fifo_prefix_v1');
    expect(result.rotationStartIndex).toBeUndefined(); // not NaN — schema violation if serialized
    expect(Number.isFinite(result.rotationStartIndex as unknown as number) || result.rotationStartIndex === undefined).toBe(true);
    expect(result.principleIds).toEqual([]);
    expect(result.eligibleCount).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('shared selector bounded-rotation contract: N consecutive round keys cover all N ring positions', async () => {
    const workspaceDir = tempWorkspace();
    const N = 8;
    await seedPromptActivations(
      workspaceDir,
      Array.from({ length: N }, (_, i) => ({ principleId: `COV_${i}`, text: 'c'.repeat(300) })),
    );
    // This proves the SELECTOR's capability when handed a legitimate
    // consecutive round key. It does NOT prove that the shared production
    // route holds such an authority — see the production-downgrade test below.
    const starts: number[] = [];
    const union = new Set<string>();
    for (let round = 1; round <= N; round++) {
      const result = await buildActivePrinciplePromptContext({ workspaceDir, roundKey: round });
      expect(result.rotationStartIndex).toBe(round % N);
      starts.push(result.rotationStartIndex!);
      for (const id of result.principleIds) union.add(id);
    }
    expect(new Set(starts).size).toBe(N);
    expect(union.size).toBe(N);
  });

  it('T6: shared PRODUCTION path reports legacy policy and no round provenance (Codex is a shared host)', async () => {
    const workspaceDir = tempWorkspace();
    await seedPromptActivations(workspaceDir, [{ principleId: 'PROD_1', text: 'shared production principle' }]);

    const emitted: Record<string, unknown>[] = [];
    const runtime = createProductionHostRuntime({
      hostKind: 'codex',
      events: {
        recordRuntimeV2ActivationsInjected: (data) => { emitted.push(data as unknown as Record<string, unknown>); },
      } as unknown as HostEventEmitter,
    });

    // Deliberately a Codex-shaped event (turnId present, sessionId present).
    const result = await runtime.dispatch({
      kind: 'before_prompt_build',
      source: 'codex:user_prompt_submit',
      rawPayload: {},
      context: {
        sessionId: 'codex-session-1',
        workspaceDir,
        turnId: 'codex-turn-1',
      },
    } as unknown as HostEvent);

    // Injection itself still works on the shared route.
    expect(JSON.stringify(result)).toContain('PROD_1');

    await runtime.dispatch({
      kind: 'before_prompt_build',
      source: 'codex:user_prompt_submit',
      rawPayload: {},
      context: { sessionId: 'codex-session-1', workspaceDir, turnId: 'codex-turn-1' },
    } as unknown as HostEvent);

    // But it must not claim a fair rotation it does not have.
    expect(emitted).toHaveLength(2);
    const data = emitted[0]!;
    expect(data.hostKind).toBe('codex');
    expect(data.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(emitted[1]!.eventId).not.toBe(data.eventId);
    expect(data.selectionPolicy).toBe('legacy_fifo_prefix_v1');
    expect(data.rotationStartIndex).toBeUndefined();
    expect(data.selectionRoundOrdinal).toBeUndefined();
    expect(data.selectionRoundSource).toBeUndefined();
  });
});

describe('PRI-904 route parity — plugin-local selector vs host-shared renderer (T10 / AT-09)', () => {
  it('same entries + budget + roundKey select the same principle IDs on both routes (equalized costs, both real serializers)', async () => {
    const workspaceDir = tempWorkspace();
    const seeds = Array.from({ length: 6 }, (_, i) => ({
      principleId: `PAR_${i}`,
      text: `par text ${i} `.repeat(8 + i), // uneven sizes
    }));
    await seedPromptActivations(workspaceDir, seeds);

    // The two routes serialize differently (list entries vs directive blocks),
    // so parity is tested under the SPEC INV-P01 precondition "same
    // serialization": equalize BOTH the per-entry costs and the fixed header
    // overhead by measuring the shared route's REAL directive arithmetic,
    // then constructing the plugin-route fixture + budget whose greedy scan
    // runs under the exact same effective cost profile.
    const candidates = await readPromptActivationCandidates({ workspaceDir });
    expect(candidates.principles).toHaveLength(6);
    const shared: ActivatedPrinciple[] = candidates.principles;

    const renderOpts = { escapeFn: escapeXml, selfReportInstruction: false };
    const lenWith = (list: ActivatedPrinciple[]): number =>
      renderPrinciplesToDirectives(list, new Set(list.map((p) => p.principleId)), renderOpts).length;
    const anchor = shared[0]!;
    const other = shared[1]!;
    const anchorAlone = lenWith([anchor]);
    // Directive blocks are additive and order-independent: block(p) = len([anchor,p]) - len([anchor]).
    const blockCost = new Map(shared.map((p) => [p.principleId, lenWith([anchor, p]) - anchorAlone]));
    blockCost.set(anchor.principleId, lenWith([anchor, other]) - lenWith([other]));
    // Fixed template overhead (title + explanation + footer) = single render minus its own block.
    const fixedDirectiveOverhead = anchorAlone - blockCost.get(anchor.principleId)!;
    // Plugin route: header is the 32-char list header, entry cost = serialized entry + 1 newline.
    const pluginBudget = RUNTIME_V2_PRINCIPLE_BUDGET - fixedDirectiveOverhead + 'Runtime V2 activated principles:'.length;

    const pluginFixture: ActivatedPrinciple[] = shared.map((p) => {
      const prefix = `- [${p.principleId}] `;
      return { ...p, text: 'z'.repeat(Math.max(1, blockCost.get(p.principleId)! - 1 - prefix.length)) };
    });

    for (let k = 0; k < 6; k++) {
      const sharedResult = await buildActivePrinciplePromptContext({ workspaceDir, roundKey: k });
      const pluginResult = trimToBudget(pluginFixture, pluginBudget, escapeXml, k);
      expect(sharedResult.rotationStartIndex).toBe(pluginResult.rotationStartIndex);
      expect(new Set(sharedResult.principleIds)).toEqual(new Set(pluginResult.injectedIds));
      expect(sharedResult.truncated).toBe(pluginResult.truncated);
      expect(sharedResult.additionalContext.length).toBeLessThanOrEqual(RUNTIME_V2_PRINCIPLE_BUDGET);
      expect(pluginResult.lines.join('\n').length).toBeLessThanOrEqual(pluginBudget);
    }
  });
});
