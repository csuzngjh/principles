import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import {
  SqliteActivationStateStore,
  SqliteConnection,
  getDefaultPdConfig,
  measureSharedDirectiveBlockChars,
  renderPrinciplesToDirectives,
  resolvePromptBudget,
  sharedDirectiveBaseChars,
  type ActivatedPrinciple,
} from '@principles/core/runtime';
import { escapeXml } from '@principles/core/prompt-builder';
import {
  buildActivePrinciplePromptContext,
  readPromptActivationCandidates,
} from '../src/active-principle-prompt.js';

const tempDirs: string[] = [];

interface FixturePrinciple {
  principleId: string;
  text: string;
  approved?: boolean;
  artifactId?: string;
  activationId?: string;
}

function tempWorkspace(): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-adaptive-priority-'));
  tempDirs.push(workspaceDir);
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(getDefaultPdConfig()), 'utf8');
  return workspaceDir;
}

async function seedPrinciples(workspaceDir: string, entries: FixturePrinciple[]): Promise<void> {
  const connection = new SqliteConnection(workspaceDir);
  try {
    const db = connection.getDb();
    const insertArtifact = db.prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, 'principle', ?, ?, '[]', 'validated', ?, ?, ?)
    `);
    const store = new SqliteActivationStateStore(connection);
    const baseTime = Date.UTC(2026, 10, 5, 10, 0, 0);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const artifactId = entry.artifactId ?? `artifact-${entry.principleId}`;
      const activationId = entry.activationId ?? `activation-${entry.principleId}`;
      const at = new Date(baseTime + index * 1000).toISOString();
      insertArtifact.run(
        artifactId,
        `task-${artifactId}`,
        entry.principleId,
        JSON.stringify({ principleId: entry.principleId, text: entry.text }),
        at,
        at,
      );
      await store.recordActivation({
        activationId,
        idempotencyKey: `${artifactId}::prompt`,
        artifactId,
        channel: 'prompt',
        action: 'prompt_activate',
        targetRef: `ledger://${entry.principleId}`,
        activatedAt: at,
        deactivatedAt: null,
      });
      if (entry.approved) {
        db.prepare(`
          INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at, decided_at, decided_by)
          VALUES (?, ?, 'prompt', 'low', 'approved', 1, ?, ?, ?)
        `).run(`approval-${entry.principleId}`, artifactId, at, at, 'owner-1');
      }
    }
  } finally {
    connection.close();
  }
}

function constrainedBudget(principles: ActivatedPrinciple[], target: ActivatedPrinciple): ReturnType<typeof resolvePromptBudget> {
  const cost = (entries: ActivatedPrinciple[]) => renderPrinciplesToDirectives(
    entries,
    new Set(entries.map((entry) => entry.principleId)),
    { escapeFn: escapeXml, selfReportInstruction: false },
  ).length;
  const singleBudget = Math.max(...principles.map((principle) => cost([principle])));
  expect(cost([target, ...principles.filter((principle) => principle !== target)])).toBeGreaterThan(singleBudget + 2);
  return { ...resolvePromptBudget(), budgetChars: singleBudget + 2 };
}

function targetFor(principleId: string): { artifactId: string; activationId: string } {
  return { artifactId: `artifact-${principleId}`, activationId: `activation-${principleId}` };
}

/**
 * The packer decides by exact additive arithmetic (base + Σ block chars), so a
 * budget computed the same way pins the test to the real inclusion boundary
 * instead of a hand-tuned constant.
 */
function exactBudget(
  entries: ActivatedPrinciple[],
  selfReportEnabled: boolean,
): ReturnType<typeof resolvePromptBudget> {
  const renderOptions = { escapeFn: escapeXml, selfReportInstruction: selfReportEnabled };
  const total = entries.reduce(
    (sum, principle) => sum + measureSharedDirectiveBlockChars(principle, renderOptions),
    sharedDirectiveBaseChars(renderOptions),
  );
  return { ...resolvePromptBudget(), budgetChars: total };
}

function writeAdaptiveConfig(workspaceDir: string, replaceableActivationIds: string[]): void {
  const config = getDefaultPdConfig();
  config.adaptiveActivation = {
    endpoint: 'https://decisions.test/alpha/decisions',
    model: 'fixture-model',
    apiKeyEnv: 'FIXTURE_KEY',
    replaceableActivationIds,
  };
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(config), 'utf8');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
  }
});

describe('buildActivePrinciplePromptContext adaptive single-target packing', () => {
  it('never offers an explicitly listed mandatory activation as a replacement', async () => {
    const workspaceDir = tempWorkspace();
    const config = getDefaultPdConfig();
    config.adaptiveActivation = {
      endpoint: 'https://decisions.test/alpha/decisions', model: 'fixture-model', apiKeyEnv: 'FIXTURE_KEY',
      replaceableActivationIds: ['activation-REQUIRED'],
    };
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(config), 'utf8');
    await seedPrinciples(workspaceDir, [
      { principleId: 'REQUIRED', text: 'required', approved: true },
      { principleId: 'TARGET', text: 'target', approved: true },
    ]);
    const { principles } = await readPromptActivationCandidates({ workspaceDir, includeAuthority: true });
    const promptBudget = constrainedBudget(principles, principles[1]!);
    const native = await buildActivePrinciplePromptContext({ workspaceDir, promptBudget });
    const result = await buildActivePrinciplePromptContext({
      workspaceDir,
      promptBudget,
      mandatoryPrincipleIds: ['REQUIRED'],
      async selectNativeGap(candidates, { excludedByBudget, replacementByActivationId }) {
        expect(candidates).toEqual([]);
        expect(excludedByBudget).toBe(true);
        expect(replacementByActivationId.size).toBe(0);
        return targetFor('TARGET'); // A provider cannot override the plan.
      },
    });
    expect(native.principleIds).toEqual(['REQUIRED']);
    expect(result.additionalContext).toBe(native.additionalContext);
    expect(result.adaptivePacking?.reason).toBe('target_not_in_feasible_gap');
  });

  it('leaves the no-priority Native result byte-for-byte unchanged', async () => {
    const workspaceDir = tempWorkspace();
    await seedPrinciples(workspaceDir, [
      { principleId: 'NATIVE_A', text: 'Native first body.' },
      { principleId: 'NATIVE_B', text: 'Native second body.' },
    ]);
    const baseline = await buildActivePrinciplePromptContext({ workspaceDir });
    const explicitNoPriority = await buildActivePrinciplePromptContext({ workspaceDir, adaptivePriority: undefined });
    expect(explicitNoPriority).toEqual(baseline);
  });

  it('prioritizes a validated target with the existing renderer budget scan and reports assembly only', async () => {
    const workspaceDir = tempWorkspace();
    await seedPrinciples(workspaceDir, [
      { principleId: 'FILLER', text: 'f'.repeat(900) },
      { principleId: 'TARGET', text: 't'.repeat(900), approved: true },
    ]);
    const candidates = await readPromptActivationCandidates({ workspaceDir, includeAuthority: true });
    const target = candidates.principles.find((principle) => principle.principleId === 'TARGET')!;
    const promptBudget = constrainedBudget(candidates.principles, target);
    const native = await buildActivePrinciplePromptContext({ workspaceDir, promptBudget });
    expect(native.activationIds).toContain('activation-FILLER');
    expect(native.activationIds).not.toContain('activation-TARGET');

    const prioritized = await buildActivePrinciplePromptContext({
      workspaceDir,
      promptBudget,
      adaptivePriority: targetFor('TARGET'),
    });
    expect(prioritized.adaptivePacking).toMatchObject({
      status: 'prioritized',
      targetActivationId: 'activation-TARGET',
      displacedActivationIds: ['activation-FILLER'],
    });
    expect(prioritized.activationIds[0]).toBe('activation-TARGET');
    expect(prioritized.adaptivePacking?.nativeBaseline).toEqual(native);
    expect(prioritized.adaptivePacking?.targetSnapshot).toMatchObject({ principleId: 'TARGET', authority: 'owner', approvedBy: 'owner-1' });
    expect(prioritized.additionalContext).toContain(prioritized.adaptivePacking?.targetBody);
    expect(prioritized.additionalContext).toContain('t'.repeat(100));
    // PRI-1137: the shared production read annotates authority.
    expect(prioritized.additionalContext).toMatch(/<directive id="TARGET"[^>]*authority="owner"/);
  });

  it('keeps an already included target byte-identical to Native', async () => {
    const workspaceDir = tempWorkspace();
    await seedPrinciples(workspaceDir, [{ principleId: 'PRESENT', text: 'Already in native.', approved: true }]);
    const native = await buildActivePrinciplePromptContext({ workspaceDir });
    const adaptive = await buildActivePrinciplePromptContext({ workspaceDir, adaptivePriority: targetFor('PRESENT') });
    expect(adaptive.adaptivePacking).toMatchObject({
      status: 'target_present',
      targetActivationId: 'activation-PRESENT',
      displacedActivationIds: [],
    });
    expect(adaptive.additionalContext).toBe(native.additionalContext);
    expect(adaptive.adaptivePacking?.nativeBaseline).toEqual(native);
    expect(adaptive.activationIds).toEqual(native.activationIds);
    // PRI-1137: the shared production read annotates authority.
    expect(adaptive.additionalContext).toMatch(/<directive id="PRESENT"[^>]*authority="owner"/);
  });

  it('falls back to Native when the target cannot fit or its key is invalid/unavailable', async () => {
    const workspaceDir = tempWorkspace();
    await seedPrinciples(workspaceDir, [
      { principleId: 'SMALL', text: 'small' },
      { principleId: 'TOO_BIG', text: 'x'.repeat(2500), approved: true },
    ]);
    const candidates = await readPromptActivationCandidates({ workspaceDir, includeAuthority: true });
    const target = candidates.principles.find((principle) => principle.principleId === 'TOO_BIG')!;
    const targetCost = renderPrinciplesToDirectives([target], new Set([target.principleId]), { escapeFn: escapeXml }).length;
    const promptBudget = { ...resolvePromptBudget(), budgetChars: targetCost - 1 };
    const native = await buildActivePrinciplePromptContext({ workspaceDir, promptBudget });
    const tooBig = await buildActivePrinciplePromptContext({ workspaceDir, promptBudget, adaptivePriority: targetFor('TOO_BIG') });
    expect(tooBig.adaptivePacking).toMatchObject({ status: 'unavailable', reason: 'target_does_not_fit' });
    expect(tooBig.additionalContext).toBe(native.additionalContext);

    const invalid = await buildActivePrinciplePromptContext({ workspaceDir, adaptivePriority: { artifactId: '', activationId: '' } });
    expect(invalid.adaptivePacking).toMatchObject({ status: 'unavailable', reason: 'invalid_target' });
    const missing = await buildActivePrinciplePromptContext({ workspaceDir, adaptivePriority: targetFor('MISSING') });
    expect(missing.adaptivePacking).toMatchObject({ status: 'unavailable', reason: 'target_unavailable' });
  });

  it('keeps Native unchanged when the principle identity is ambiguous', async () => {
    const workspaceDir = tempWorkspace();
    await seedPrinciples(workspaceDir, [
      { principleId: 'DUPLICATE', text: 'First active revision.', artifactId: 'artifact-duplicate-a', activationId: 'activation-duplicate-a' },
      { principleId: 'DUPLICATE', text: 'Second active revision.', artifactId: 'artifact-duplicate-b', activationId: 'activation-duplicate-b' },
    ]);
    const native = await buildActivePrinciplePromptContext({ workspaceDir });
    const adaptive = await buildActivePrinciplePromptContext({
      workspaceDir,
      adaptivePriority: { artifactId: 'artifact-duplicate-a', activationId: 'activation-duplicate-a' },
    });
    expect(adaptive.adaptivePacking).toMatchObject({ status: 'unavailable', reason: 'target_ambiguous' });
    expect(adaptive.additionalContext).toBe(native.additionalContext);
    expect(adaptive.activationIds).toEqual(native.activationIds);
  });

  it('does not displace mandatory Native principles and excludes an invalidated cached target', async () => {
    const workspaceDir = tempWorkspace();
    await seedPrinciples(workspaceDir, [
      { principleId: 'MANDATORY', text: 'm'.repeat(900) },
      { principleId: 'PRIORITY', text: 'p'.repeat(900), approved: true },
    ]);
    const candidates = await readPromptActivationCandidates({ workspaceDir, includeAuthority: true });
    const target = candidates.principles.find((principle) => principle.principleId === 'PRIORITY')!;
    const promptBudget = constrainedBudget(candidates.principles, target);
    const native = await buildActivePrinciplePromptContext({ workspaceDir, promptBudget });
    const protectedResult = await buildActivePrinciplePromptContext({
      workspaceDir,
      promptBudget,
      adaptivePriority: targetFor('PRIORITY'),
      mandatoryPrincipleIds: ['MANDATORY'],
    });
    expect(protectedResult.adaptivePacking).toMatchObject({ status: 'unavailable', reason: 'mandatory_constraint_displaced' });
    expect(protectedResult.additionalContext).toBe(native.additionalContext);

    const aborted = new AbortController();
    aborted.abort();
    const invalidated = await buildActivePrinciplePromptContext({
      workspaceDir,
      adaptivePriority: targetFor('MANDATORY'),
      signal: aborted.signal,
    });
    expect(invalidated.adaptivePacking).toMatchObject({ status: 'unavailable', reason: 'target_changed' });
    expect(invalidated.activationIds).not.toContain('activation-MANDATORY');
  });

  it('appends into the remaining budget without offering any replacement', async () => {
    const workspaceDir = tempWorkspace();
    writeAdaptiveConfig(workspaceDir, ['activation-OUT']);
    await seedPrinciples(workspaceDir, [
      { principleId: 'OUT', text: 'o'.repeat(60), approved: true },
      // FIFO packing stops here, so TARGET is omitted although it would fit.
      { principleId: 'HUGE', text: 'h'.repeat(400) },
      { principleId: 'TARGET', text: 't'.repeat(40), approved: true },
    ]);
    const { principles, selfReportEnabled } = await readPromptActivationCandidates({ workspaceDir, includeAuthority: true });
    const byId = (principleId: string) => principles.find((principle) => principle.principleId === principleId)!;
    // TARGET fits the leftover budget exactly: the promise is "append", never
    // "replace", even though OUT is explicitly listed as replaceable.
    const promptBudget = exactBudget([byId('OUT'), byId('TARGET')], selfReportEnabled);
    const native = await buildActivePrinciplePromptContext({ workspaceDir, promptBudget });
    expect(native.principleIds).toEqual(['OUT']);

    const offered: { candidateIds: string[]; replacementIds: string[] }[] = [];
    const result = await buildActivePrinciplePromptContext({
      workspaceDir,
      promptBudget,
      async selectNativeGap(candidates, { replacementByActivationId }) {
        offered.push({
          candidateIds: candidates.map((candidate) => candidate.principleId),
          replacementIds: [...replacementByActivationId.keys()],
        });
        return targetFor('TARGET');
      },
    });

    expect(offered).toEqual([{ candidateIds: ['TARGET'], replacementIds: [] }]);
    expect(result.adaptivePacking).toMatchObject({
      status: 'prioritized',
      targetActivationId: 'activation-TARGET',
      displacedActivationIds: [],
    });
    expect(result.adaptivePacking?.displacedSnapshot).toBeUndefined();
    expect(result.activationIds).toEqual(['activation-OUT', 'activation-TARGET']);
    expect(result.additionalContext).toContain('o'.repeat(60));
    expect(result.additionalContext).toContain(result.adaptivePacking?.targetBody);
  });

  it('replaces exactly the configured outgoing directive only when the budget is short', async () => {
    const workspaceDir = tempWorkspace();
    writeAdaptiveConfig(workspaceDir, ['activation-OUT']);
    await seedPrinciples(workspaceDir, [
      { principleId: 'OUT', text: 'o'.repeat(200), approved: true },
      { principleId: 'KEEP', text: 'k'.repeat(80) },
      { principleId: 'TARGET', text: 't'.repeat(150), approved: true },
    ]);
    const { principles, selfReportEnabled } = await readPromptActivationCandidates({ workspaceDir, includeAuthority: true });
    const byId = (principleId: string) => principles.find((principle) => principle.principleId === principleId)!;
    // Zero remaining budget after OUT + KEEP: TARGET can only arrive by
    // yielding the configured outgoing directive.
    const promptBudget = exactBudget([byId('OUT'), byId('KEEP')], selfReportEnabled);
    const native = await buildActivePrinciplePromptContext({ workspaceDir, promptBudget });
    expect(native.principleIds).toEqual(['OUT', 'KEEP']);

    const plans: string[][] = [];
    const result = await buildActivePrinciplePromptContext({
      workspaceDir,
      promptBudget,
      async selectNativeGap(candidates, { replacementByActivationId }) {
        expect(candidates.map((candidate) => candidate.principleId)).toEqual(['TARGET']);
        plans.push([...replacementByActivationId.values()].map((outgoing) => outgoing.activationId));
        return targetFor('TARGET');
      },
    });

    expect(plans).toEqual([['activation-OUT']]);
    expect(result.adaptivePacking).toMatchObject({
      status: 'prioritized',
      displacedActivationIds: ['activation-OUT'],
      displacedSnapshot: expect.objectContaining({ activationId: 'activation-OUT', principleId: 'OUT' }),
    });
    expect(result.activationIds).toEqual(['activation-KEEP', 'activation-TARGET']);
    expect(result.additionalContext).not.toContain('o'.repeat(200));
    expect(result.additionalContext).toContain(result.adaptivePacking?.targetBody);
  });

  it('refuses a replacement it cannot prove removed exactly one Native activation', async () => {
    const workspaceDir = tempWorkspace();
    writeAdaptiveConfig(workspaceDir, ['activation-DUP']);
    // Two active rows share one activation id — the key the displacement
    // accounting reads. The plan cannot prove a single removal, so it must
    // fall back to Native instead of reporting a replacement it did not make.
    await seedPrinciples(workspaceDir, [
      { principleId: 'DUP_A', text: 'd'.repeat(200), approved: true, activationId: 'activation-DUP' },
      { principleId: 'DUP_B', text: 'd'.repeat(200), approved: true, activationId: 'activation-DUP' },
      { principleId: 'TARGET', text: 't'.repeat(100), approved: true },
    ]);
    const { principles, selfReportEnabled } = await readPromptActivationCandidates({ workspaceDir, includeAuthority: true });
    const byId = (principleId: string) => principles.find((principle) => principle.principleId === principleId)!;
    const promptBudget = exactBudget([byId('DUP_A'), byId('DUP_B')], selfReportEnabled);
    const native = await buildActivePrinciplePromptContext({ workspaceDir, promptBudget });
    expect(native.principleIds).toEqual(['DUP_A', 'DUP_B']);

    const result = await buildActivePrinciplePromptContext({
      workspaceDir,
      promptBudget,
      async selectNativeGap(candidates, { replacementByActivationId }) {
        expect(candidates.map((candidate) => candidate.principleId)).toEqual(['TARGET']);
        expect([...replacementByActivationId.values()]).toHaveLength(1);
        return targetFor('TARGET');
      },
    });

    expect(result.adaptivePacking).toMatchObject({
      status: 'unavailable',
      reason: 'unexpected_replacement',
      displacedActivationIds: [],
    });
    expect(result.additionalContext).toBe(native.additionalContext);
  });
});
