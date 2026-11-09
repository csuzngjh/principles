/**
 * PRI-1140 — revision-resilient adaptive target resolution + additive-only
 * packing (Owner supplementary conditions, 2026-11-09).
 *
 * Fixtures model the real Owner prompt-replacement flow: a principle has an
 * OLD revision whose prompt activation is deactivated and a NEW revision whose
 * activation is live, both carrying the same `principleId`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import {
  SqliteActivationStateStore,
  SqliteConnection,
  getDefaultPdConfig,
  renderPrinciplesToDirectives,
  resolvePromptBudget,
  type ActivatedPrinciple,
} from '@principles/core/runtime';
import { escapeXml } from '@principles/core/prompt-builder';
import {
  buildActivePrinciplePromptContext,
  readPromptActivationCandidates,
  resolveCurrentAuthorizedActivationByPrincipleId,
} from '../src/active-principle-prompt.js';

const tempDirs: string[] = [];

interface FixtureActivation {
  principleId: string;
  text: string;
  artifactId: string;
  activationId: string;
  approved?: boolean;
  deactivated?: boolean;
  /** Write a content_json the reader cannot parse (reader warning). */
  corruptContent?: boolean;
}

function tempWorkspace(): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-adaptive-resolution-'));
  tempDirs.push(workspaceDir);
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(getDefaultPdConfig()), 'utf8');
  return workspaceDir;
}

async function seed(workspaceDir: string, entries: FixtureActivation[]): Promise<void> {
  const connection = new SqliteConnection(workspaceDir);
  try {
    const db = connection.getDb();
    const insertArtifact = db.prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, 'principle', ?, ?, '[]', 'validated', ?, ?, ?)
    `);
    const store = new SqliteActivationStateStore(connection);
    const baseTime = Date.UTC(2026, 10, 9, 4, 0, 0);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const at = new Date(baseTime + index * 1000).toISOString();
      insertArtifact.run(
        entry.artifactId,
        `task-${entry.artifactId}`,
        entry.principleId,
        entry.corruptContent ? '{not-json' : JSON.stringify({ principleId: entry.principleId, text: entry.text }),
        at,
        at,
      );
      await store.recordActivation({
        activationId: entry.activationId,
        idempotencyKey: `${entry.artifactId}::prompt`,
        artifactId: entry.artifactId,
        channel: 'prompt',
        action: 'prompt_activate',
        targetRef: `ledger://${entry.principleId}`,
        activatedAt: at,
        deactivatedAt: entry.deactivated ? new Date(baseTime + index * 1000 + 500).toISOString() : null,
      });
      if (entry.approved) {
        db.prepare(`
          INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at, decided_at, decided_by)
          VALUES (?, ?, 'prompt', 'low', 'approved', 1, ?, ?, ?)
        `).run(`approval-${entry.artifactId}`, entry.artifactId, at, at, 'owner-1');
      }
    }
  } finally {
    connection.close();
  }
}

function deactivate(workspaceDir: string, activationId: string): void {
  const connection = new SqliteConnection(workspaceDir);
  try {
    connection.getDb().prepare('UPDATE activations SET deactivated_at = ? WHERE activation_id = ?')
      .run(new Date().toISOString(), activationId);
  } finally {
    connection.close();
  }
}

function cost(entries: ActivatedPrinciple[]): number {
  return renderPrinciplesToDirectives(
    entries,
    new Set(entries.map((entry) => entry.principleId)),
    { escapeFn: escapeXml, selfReportInstruction: false },
  ).length;
}

/** A budget where each principle fits alone but the target cannot join the native pack. */
function displacementBudget(principles: ActivatedPrinciple[], target: ActivatedPrinciple): ReturnType<typeof resolvePromptBudget> {
  const singleBudget = Math.max(...principles.map((principle) => cost([principle])));
  expect(cost([target, ...principles.filter((principle) => principle !== target)])).toBeGreaterThan(singleBudget + 2);
  return { ...resolvePromptBudget(), budgetChars: singleBudget + 2 };
}

/** Revision fixture: OLD revision deactivated, NEW revision live, same principleId. */
const REVISED = (extra: FixtureActivation[] = []): FixtureActivation[] => [
  ...extra,
  { principleId: 'DELIVERY', text: 'Old delivery self-check revision.', artifactId: 'art-delivery-v1', activationId: 'act-delivery-old', approved: true, deactivated: true },
  { principleId: 'DELIVERY', text: 'New delivery self-check revision with observable evidence.', artifactId: 'art-delivery-v2', activationId: 'act-delivery-new', approved: true },
];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
  }
});

describe('PRI-1140 resolveCurrentAuthorizedActivationByPrincipleId', () => {
  it('resolves the unique CURRENT revision after an Owner prompt replacement', async () => {
    const workspaceDir = tempWorkspace();
    await seed(workspaceDir, REVISED([{ principleId: 'OTHER', text: 'Other body.', artifactId: 'art-other', activationId: 'act-other' }]));
    const resolved = await resolveCurrentAuthorizedActivationByPrincipleId({ workspaceDir, principleId: 'DELIVERY' });
    expect(resolved).toEqual({
      ok: true,
      principleId: 'DELIVERY',
      artifactId: 'art-delivery-v2',
      activationId: 'act-delivery-new',
      warnings: [],
    });
  });

  it('fails closed with a structured reason when no current activation exists', async () => {
    const workspaceDir = tempWorkspace();
    await seed(workspaceDir, [
      { principleId: 'DELIVERY', text: 'Retired.', artifactId: 'art-delivery-v1', activationId: 'act-delivery-old', deactivated: true },
      { principleId: 'OTHER', text: 'Other body.', artifactId: 'art-other', activationId: 'act-other' },
    ]);
    await expect(resolveCurrentAuthorizedActivationByPrincipleId({ workspaceDir, principleId: 'DELIVERY' }))
      .resolves.toMatchObject({ ok: false, reason: 'principle_not_currently_authorized' });
    await expect(resolveCurrentAuthorizedActivationByPrincipleId({ workspaceDir, principleId: 'NEVER_SEEN' }))
      .resolves.toMatchObject({ ok: false, reason: 'principle_not_currently_authorized' });
    await expect(resolveCurrentAuthorizedActivationByPrincipleId({ workspaceDir, principleId: '   ' }))
      .resolves.toMatchObject({ ok: false, reason: 'principle_not_currently_authorized' });
  });

  it('never guesses between two live activations of the same principle', async () => {
    const workspaceDir = tempWorkspace();
    await seed(workspaceDir, [
      { principleId: 'DELIVERY', text: 'Revision A.', artifactId: 'art-delivery-a', activationId: 'act-delivery-a' },
      { principleId: 'DELIVERY', text: 'Revision B.', artifactId: 'art-delivery-b', activationId: 'act-delivery-b' },
    ]);
    await expect(resolveCurrentAuthorizedActivationByPrincipleId({ workspaceDir, principleId: 'DELIVERY' }))
      .resolves.toMatchObject({ ok: false, reason: 'ambiguous_current_activations' });
  });

  it('refuses to select from a degraded candidate read (reader warnings)', async () => {
    const workspaceDir = tempWorkspace();
    await seed(workspaceDir, REVISED([
      { principleId: 'BROKEN', text: 'unused', artifactId: 'art-broken', activationId: 'act-broken', corruptContent: true },
    ]));
    const resolved = await resolveCurrentAuthorizedActivationByPrincipleId({ workspaceDir, principleId: 'DELIVERY' });
    expect(resolved).toMatchObject({ ok: false, reason: 'candidates_unavailable' });
    expect(resolved.warnings.length).toBeGreaterThan(0);
  });
});

describe('PRI-1140 additive-only adaptive packing', () => {
  it('keeps the native assembly and records the would-be displacement instead of squeezing native content (budget-insufficient counterexample)', async () => {
    const workspaceDir = tempWorkspace();
    await seed(workspaceDir, [
      { principleId: 'FILLER', text: 'f'.repeat(900), artifactId: 'art-filler', activationId: 'act-filler' },
      { principleId: 'DELIVERY', text: 'd'.repeat(900), artifactId: 'art-delivery-v2', activationId: 'act-delivery-new', approved: true },
    ]);
    const candidates = await readPromptActivationCandidates({ workspaceDir, includeAuthority: true });
    const target = candidates.principles.find((principle) => principle.principleId === 'DELIVERY')!;
    const promptBudget = displacementBudget(candidates.principles, target);
    const native = await buildActivePrinciplePromptContext({ workspaceDir, promptBudget });
    expect(native.activationIds).toEqual(['act-filler']);

    const additive = await buildActivePrinciplePromptContext({
      workspaceDir,
      promptBudget,
      adaptivePriority: { artifactId: 'art-delivery-v2', activationId: 'act-delivery-new' },
      additiveOnly: true,
    });
    expect(additive.adaptivePacking).toMatchObject({
      status: 'unavailable',
      reason: 'would_displace_native_assembly',
      targetActivationId: 'act-delivery-new',
      displacedActivationIds: ['act-filler'],
    });
    // Zero displacement: the effective prompt is exactly the native assembly.
    expect(additive.additionalContext).toBe(native.additionalContext);
    expect(additive.activationIds).toEqual(native.activationIds);
    expect(additive.adaptivePacking?.nativeBaseline).toBeUndefined();

    // Old pinned-identity path compatibility: without additiveOnly the SAME
    // fixture keeps its budget-driven displacement semantics verbatim.
    const legacy = await buildActivePrinciplePromptContext({
      workspaceDir,
      promptBudget,
      adaptivePriority: { artifactId: 'art-delivery-v2', activationId: 'act-delivery-new' },
    });
    expect(legacy.adaptivePacking).toMatchObject({ status: 'prioritized', displacedActivationIds: ['act-filler'] });
    expect(legacy.activationIds[0]).toBe('act-delivery-new');
  });

  it('reuses the native text when the target is already assembled (SPEC §2 same-text, additive path)', async () => {
    const workspaceDir = tempWorkspace();
    await seed(workspaceDir, REVISED([{ principleId: 'OTHER', text: 'Other body.', artifactId: 'art-other', activationId: 'act-other' }]));
    const native = await buildActivePrinciplePromptContext({ workspaceDir });
    expect(native.activationIds).toContain('act-delivery-new');
    const additive = await buildActivePrinciplePromptContext({
      workspaceDir,
      adaptivePriority: { artifactId: 'art-delivery-v2', activationId: 'act-delivery-new' },
      additiveOnly: true,
    });
    expect(additive.adaptivePacking).toMatchObject({ status: 'target_present', displacedActivationIds: [] });
    expect(additive.additionalContext).toBe(native.additionalContext);
    expect(additive.adaptivePacking?.targetSnapshot).toMatchObject({ principleId: 'DELIVERY', authority: 'owner', approvedBy: 'owner-1' });
  });

  it('A4 shape: the pinned mapping dies after revision while principle resolution re-binds the current version through the same assembly chain', async () => {
    const workspaceDir = tempWorkspace();
    await seed(workspaceDir, REVISED([{ principleId: 'OTHER', text: 'Other body.', artifactId: 'art-other', activationId: 'act-other' }]));
    // Old fixed mapping (pinned to the pre-revision activation).
    const pinned = await buildActivePrinciplePromptContext({
      workspaceDir,
      adaptivePriority: { artifactId: 'art-delivery-v1', activationId: 'act-delivery-old' },
    });
    expect(pinned.adaptivePacking).toMatchObject({ status: 'unavailable', reason: 'target_unavailable' });
    expect(pinned.adaptivePacking?.targetSnapshot).toBeUndefined();

    // New principle mapping: resolve, then hand the resolved pair to the SAME entry.
    const resolved = await resolveCurrentAuthorizedActivationByPrincipleId({ workspaceDir, principleId: 'DELIVERY' });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const continued = await buildActivePrinciplePromptContext({
      workspaceDir,
      adaptivePriority: { artifactId: resolved.artifactId, activationId: resolved.activationId },
      additiveOnly: true,
    });
    expect(continued.adaptivePacking).toMatchObject({ status: 'target_present', targetActivationId: 'act-delivery-new' });
    // Authorization re-verified on the second read (owner annotation preserved).
    expect(continued.adaptivePacking?.targetSnapshot).toMatchObject({ authority: 'owner', approvedBy: 'owner-1' });
    expect(continued.additionalContext).toContain('New delivery self-check revision');
    expect(continued.additionalContext).not.toContain('Old delivery self-check revision');
    // Same text as the post-revision Native assembly (no displacement, no extra content).
    expect(continued.additionalContext).toBe(pinned.additionalContext);
  });

  it('falls back to Native for THIS round when the selected target is revoked before final assembly, and the next resolution sees the new state', async () => {
    const workspaceDir = tempWorkspace();
    await seed(workspaceDir, REVISED([{ principleId: 'OTHER', text: 'Other body.', artifactId: 'art-other', activationId: 'act-other' }]));
    const selected = await resolveCurrentAuthorizedActivationByPrincipleId({ workspaceDir, principleId: 'DELIVERY' });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    // Revoked between selection and assembly.
    deactivate(workspaceDir, selected.activationId);
    const round = await buildActivePrinciplePromptContext({
      workspaceDir,
      adaptivePriority: { artifactId: selected.artifactId, activationId: selected.activationId },
      additiveOnly: true,
    });
    expect(round.adaptivePacking).toMatchObject({ status: 'unavailable', reason: 'target_unavailable' });
    expect(round.additionalContext).not.toContain('New delivery self-check revision');
    const native = await buildActivePrinciplePromptContext({ workspaceDir });
    expect(round.additionalContext).toBe(native.additionalContext);
    // Next round: resolution reflects the new state instead of a cached selection.
    await expect(resolveCurrentAuthorizedActivationByPrincipleId({ workspaceDir, principleId: 'DELIVERY' }))
      .resolves.toMatchObject({ ok: false, reason: 'principle_not_currently_authorized' });
  });

  it('excludes a target invalidated at the final revalidation boundary on the additive path', async () => {
    const workspaceDir = tempWorkspace();
    await seed(workspaceDir, REVISED([{ principleId: 'OTHER', text: 'Other body.', artifactId: 'art-other', activationId: 'act-other' }]));
    const aborted = new AbortController();
    aborted.abort();
    const invalidated = await buildActivePrinciplePromptContext({
      workspaceDir,
      adaptivePriority: { artifactId: 'art-delivery-v2', activationId: 'act-delivery-new' },
      additiveOnly: true,
      signal: aborted.signal,
    });
    expect(invalidated.adaptivePacking).toMatchObject({ status: 'unavailable', reason: 'target_changed' });
    expect(invalidated.activationIds).not.toContain('act-delivery-new');
  });
});
