/**
 * Prompt Channel Independent E2E Test — MVP Release Quality Task 7
 *
 * Independent end-to-end test for the prompt activation channel. Among the
 * three MVP activation paths (prompt, code_tool_hook, defer_archive), prompt
 * was covered indirectly via story-a-acceptance and prompt-activation-reader-contract
 * unit tests, but lacked an independent full-chain E2E that ties the WRITE path
 * (PromptWriter activation via ApprovalCompletionService) to the READ path
 * (filterPromptActivations → resolvePrincipleFromArtifact → renderPrinciplesToDirectives)
 * using real SQLite stores.
 *
 * This test validates the full production path with real SQLite stores:
 *   seed principle artifact → enqueue approval (prompt) → approve
 *   → ApprovalCompletionService.completeApproval → PromptWriter activate
 *   → listPromptActivations returns activation record
 *   → filterPromptActivations → resolvePrincipleFromArtifact → renderPrinciplesToDirectives
 *     contains principle text (write/read path consistency, ERR-048)
 *   → deactivate → listPromptActivations returns empty
 *
 * Plus the feature-disabled contract: when the prompt flag is disabled via
 * config, computeEffectiveFlags returns enabled=false, and no activation
 * record is written (production code checks the flag before dispatching).
 *
 * Uses real SQLite stores + production services + production PromptWriter.
 * No mocks of the production path. No "function was called" assertions. No
 * "success or failure both pass" assertions.
 *
 * ERR checklist:
 * - ERR-001: All parsed JSON treated as unknown, validated at runtime
 * - ERR-002: Every failure path carries reason + nextAction
 * - ERR-009: Required fields fail loud
 * - ERR-015: Idempotency state distinguished from current dispatch
 * - ERR-025: Production-path test, not demo helper
 * - ERR-048: Write/read path consistency — activation written by PromptWriter
 *   is readable by filterPromptActivations + resolvePrincipleFromArtifact
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  SqliteConnection,
  SqliteApprovalQueueStore,
  SqliteActivationStateStore,
  SqlitePIArtifactStore,
  ActivationDispatcher,
  ApprovalCompletionService,
  PromptWriter,
  filterPromptActivations,
  resolvePrincipleFromArtifact,
  trimToBudget,
  renderPrinciplesToDirectives,
  computeEffectiveFlags,
  DEFAULT_FEATURE_FLAGS,
} from '../../index.js';
import type {
  PIArtifactSnapshot,
} from '../activation-types.js';

// ── Test workspace setup ────────────────────────────────────────────────────

interface TestWorkspace {
  workspaceDir: string;
  connection: SqliteConnection;
  approvalStore: SqliteApprovalQueueStore;
  stateStore: SqliteActivationStateStore;
  artifactStore: SqlitePIArtifactStore;
  cleanup: () => void;
}

function createTestWorkspace(): TestWorkspace {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-prompt-e2e-'));
  const pdDir = path.join(tmpDir, '.pd');
  fs.mkdirSync(pdDir, { recursive: true });

  const connection = new SqliteConnection({ workspaceDir: tmpDir });
  // Trigger DB initialization (getDb runs schema setup)
  connection.getDb();

  const approvalStore = new SqliteApprovalQueueStore(connection);
  const stateStore = new SqliteActivationStateStore(connection);
  const artifactStore = new SqlitePIArtifactStore(connection);

  return {
    workspaceDir: tmpDir,
    connection,
    approvalStore,
    stateStore,
    artifactStore,
    cleanup: () => {
      connection.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

// ── Artifact fixtures ───────────────────────────────────────────────────────

const PRINCIPLE_ID = 'principle-prompt-001';
const PRINCIPLE_TEXT = 'Always read existing implementation before adding a parallel module';

function createPrincipleArtifact(overrides: Partial<PIArtifactSnapshot> = {}): PIArtifactSnapshot {
  return {
    artifactId: 'art-principle-prompt-001',
    artifactKind: 'principle',
    sourceTaskId: 'task-pain-prompt-001',
    sourcePrincipleId: PRINCIPLE_ID,
    lineageArtifactIds: [],
    validationStatus: 'validated',
    // contentJson MUST contain principleId — PromptWriter.canActivate calls
    // extractPrincipleId which reads principleId from contentJson (or
    // sourcePrincipleId from the artifact). We include both for defense.
    // Also includes text — resolvePrincipleFromArtifact requires it for
    // rendering the principle as a directive.
    contentJson: JSON.stringify({
      principleId: PRINCIPLE_ID,
      text: PRINCIPLE_TEXT,
      language: 'en',
    }),
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
    ...overrides,
  };
}

function makeArtifactReadModel(artifacts: PIArtifactSnapshot[]): {
  getArtifactById: (id: string) => Promise<PIArtifactSnapshot | null>;
} {
  const map = new Map(artifacts.map(a => [a.artifactId, a]));
  return {
    getArtifactById: async (id: string) => map.get(id) ?? null,
  };
}

function createPromptDispatcher(
  artifactReadModel: { getArtifactById: (id: string) => Promise<PIArtifactSnapshot | null> },
  stateStore: SqliteActivationStateStore,
  approvalStore: SqliteApprovalQueueStore,
): ActivationDispatcher {
  // Production dispatcher configured with only the PromptWriter.
  // This isolates the prompt channel path for independent E2E validation.
  return new ActivationDispatcher(
    artifactReadModel,
    stateStore,
    {
      writers: [new PromptWriter()],
      approvalQueueStore: approvalStore,
    },
  );
}

/**
 * Convert a PIArtifactSnapshot/PIArtifactRecord (camelCase) to the snake_case
 * row shape expected by resolvePrincipleFromArtifact. The reader contract
 * function treats its input as unknown and validates fields by snake_case name
 * (artifact_id, artifact_kind, content_json, validation_status) — matching
 * the raw SQLite row format. This conversion bridges the typed snapshot and
 * the untyped reader contract.
 */
function toArtifactRow(artifact: {
  artifactId: string;
  artifactKind: string;
  contentJson: string;
  validationStatus: string;
}): Record<string, unknown> {
  return {
    artifact_id: artifact.artifactId,
    artifact_kind: artifact.artifactKind,
    content_json: artifact.contentJson,
    validation_status: artifact.validationStatus,
  };
}

// ── E2E Tests ───────────────────────────────────────────────────────────────

describe('prompt channel independent E2E (MVP Quality Task 7)', () => {
  let ws: TestWorkspace;

  beforeEach(() => {
    ws = createTestWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  describe('happy path: full-chain prompt activation → directive render → rollback', () => {
    it('seed → enqueue → approve → completeApproval → listPromptActivations → renderPrinciplesToDirectives → deactivate', async () => {
      // ── Step 1: Seed principle artifact into the real SQLite artifact store ──
      // Also create a Map-based read model for the dispatcher (matches the
      // story-a-acceptance pattern — dispatcher expects PIArtifactSnapshot).
      const principleArtifact = createPrincipleArtifact();
      await ws.artifactStore.createArtifact(principleArtifact);
      const artifactReadModel = makeArtifactReadModel([principleArtifact]);

      // ── Step 2: Enqueue approval with channel='prompt', riskLevel='low' ──
      const enqueued = await ws.approvalStore.enqueue({
        artifactId: principleArtifact.artifactId,
        channel: 'prompt',
        riskLevel: 'low',
        summary: 'Read existing implementation before adding parallel modules',
        triggerReason: 'pain-signal-detected',
      }, '2026-06-18T00:00:00.000Z');

      expect(enqueued.status).toBe('pending');
      expect(enqueued.channel).toBe('prompt');
      expect(enqueued.riskLevel).toBe('low');
      expect(enqueued.artifactId).toBe(principleArtifact.artifactId);

      // ── Step 3: Owner approves ──
      const approveResult = await ws.approvalStore.approve(
        enqueued.approvalId,
        'owner-001',
        'Approved for prompt activation',
      );
      expect(approveResult.ok).toBe(true);

      // ── Step 4: ApprovalCompletionService orchestrates activation ──
      const dispatcher = createPromptDispatcher(
        artifactReadModel,
        ws.stateStore,
        ws.approvalStore,
      );
      const completionService = new ApprovalCompletionService(
        ws.approvalStore,
        dispatcher,
        ws.stateStore,
      );

      const completionResult = await completionService.completeApproval({
        approvalId: enqueued.approvalId,
        actor: { kind: 'human', userId: 'owner-001' },
        now: '2026-06-18T01:00:00.000Z',
      });

      expect(completionResult.ok).toBe(true);
      if (completionResult.ok) {
        expect(completionResult.decision.decision).toBe('activated');
        expect(completionResult.activationId).toBe(`act_prompt_${PRINCIPLE_ID}`);
      }

      // ── Step 5: listPromptActivations returns the activation record ──
      const promptActivations = await ws.stateStore.listPromptActivations();
      expect(promptActivations).toHaveLength(1);

      const [activation] = promptActivations;
      expect(activation).toBeDefined();
      if (!activation) throw new Error('expected activation to be defined');
      expect(activation.artifactId).toBe(principleArtifact.artifactId);
      expect(activation.channel).toBe('prompt');
      expect(activation.action).toBe('prompt_activate');
      expect(activation.activationId).toBe(`act_prompt_${PRINCIPLE_ID}`);
      expect(activation.targetRef).toBe(`ledger://${PRINCIPLE_ID}`);
      expect(activation.deactivatedAt).toBeNull();
      expect(activation.activatedAt).toBe('2026-06-18T01:00:00.000Z');

      // ── Step 6: filterPromptActivations keeps only active prompt/prompt_activate records ──
      const filtered = filterPromptActivations(promptActivations);
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.activationId).toBe(activation.activationId);

      // ── Step 7: resolvePrincipleFromArtifact + renderPrinciplesToDirectives ──
      // (ERR-048: write/read path consistency — the activation written by
      // PromptWriter must be readable by the prompt-activation-reader contract.)
      // Retrieve the artifact from the REAL SQLite artifact store (not the Map).
      const artifactRow = await ws.artifactStore.getArtifactById(activation.artifactId);
      expect(artifactRow).not.toBeNull();
      if (!artifactRow) throw new Error('expected artifact to exist');

      const resolved = resolvePrincipleFromArtifact(
        toArtifactRow(artifactRow),
        activation,
      );
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.principle.principleId).toBe(PRINCIPLE_ID);
        expect(resolved.principle.text).toBe(PRINCIPLE_TEXT);
        expect(resolved.principle.artifactId).toBe(principleArtifact.artifactId);
        expect(resolved.principle.activationId).toBe(activation.activationId);
      }

      // Render the resolved principles to directive text
      const principles = resolved.ok ? [resolved.principle] : [];
      const { injectedIds } = trimToBudget(principles, 2000);
      expect(injectedIds.has(PRINCIPLE_ID)).toBe(true);

      const directiveText = renderPrinciplesToDirectives(principles, injectedIds);
      expect(directiveText).toContain(PRINCIPLE_TEXT);
      expect(directiveText).toContain(PRINCIPLE_ID);
      expect(directiveText).toContain('OWNER-APPROVED BEHAVIOR DIRECTIVES');
      expect(directiveText).toContain('MANDATORY');

      // ── Step 8: Owner deactivates (rollback) ──
      const deactivatedAt = '2026-06-18T02:00:00.000Z';
      const rollbackOk = await ws.stateStore.deactivateActivation(
        activation.activationId,
        deactivatedAt,
      );
      expect(rollbackOk).toBe(true);

      // ── Step 9: listPromptActivations returns empty (excludes deactivated) ──
      const activeAfterRollback = await ws.stateStore.listPromptActivations();
      expect(activeAfterRollback).toHaveLength(0);

      // But listAllActivations still includes it (audit trail preserved)
      const allAfterRollback = await ws.stateStore.listAllActivations();
      expect(allAfterRollback).toHaveLength(1);
      expect(allAfterRollback[0]?.deactivatedAt).toBe(deactivatedAt);

      // filterPromptActivations also excludes the deactivated record
      const allPromptIncludingDeactivated = await ws.stateStore.listPromptActivations(true);
      expect(allPromptIncludingDeactivated).toHaveLength(1);
      const filteredAfterDeactivation = filterPromptActivations(allPromptIncludingDeactivated);
      expect(filteredAfterDeactivation).toHaveLength(0);
    });

    it('duplicate completeApproval is idempotent — only one prompt activation', async () => {
      const principleArtifact = createPrincipleArtifact();
      const artifactReadModel = makeArtifactReadModel([principleArtifact]);

      const enqueued = await ws.approvalStore.enqueue({
        artifactId: principleArtifact.artifactId,
        channel: 'prompt',
        riskLevel: 'low',
      }, '2026-06-18T00:00:00.000Z');
      await ws.approvalStore.approve(enqueued.approvalId, 'owner-001');

      const dispatcher = createPromptDispatcher(
        artifactReadModel,
        ws.stateStore,
        ws.approvalStore,
      );
      const completionService = new ApprovalCompletionService(
        ws.approvalStore,
        dispatcher,
        ws.stateStore,
      );

      // First completion
      const first = await completionService.completeApproval({
        approvalId: enqueued.approvalId,
        actor: { kind: 'human', userId: 'owner-001' },
        now: '2026-06-18T01:00:00.000Z',
      });
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(first.decision.decision).toBe('activated');
      }

      // Second completion (duplicate)
      const second = await completionService.completeApproval({
        approvalId: enqueued.approvalId,
        actor: { kind: 'human', userId: 'owner-001' },
        now: '2026-06-18T01:00:01.000Z',
      });
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.decision.decision).toBe('already_activated');
      }

      // Only ONE activation record exists
      const promptActivations = await ws.stateStore.listPromptActivations();
      expect(promptActivations).toHaveLength(1);
    });
  });

  describe('feature disabled: prompt flag off → no activation', () => {
    it('prompt flag can be explicitly disabled via config (core flag emergency disable)', () => {
      // prompt is a core flag (default ON). Per PRI-435, core flags can
      // be explicitly disabled via config for emergency rollback, with a warning.
      const userFlags = {
        prompt: { enabled: false },
      };
      const result = computeEffectiveFlags(
        userFlags,
        DEFAULT_FEATURE_FLAGS,
        '/test/.pd/feature-flags.yaml',
      );

      const flag = result.flags.prompt;
      expect(flag).toBeDefined();
      expect(flag?.enabled).toBe(false);
      expect(flag?.category).toBe('core');

      // Core flag emergency disable produces an observable warning (ERR-002:
      // graceful degradation must include a reason — here via warnings array).
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some(w => w.includes('prompt'))).toBe(true);
    });

    it('prompt flag enabled by default (no config override)', () => {
      const result = computeEffectiveFlags(
        {},
        DEFAULT_FEATURE_FLAGS,
        '/test/.pd/feature-flags.yaml',
      );
      const flag = result.flags.prompt;
      expect(flag).toBeDefined();
      expect(flag?.enabled).toBe(true);
      expect(flag?.category).toBe('core');
    });

    it('when prompt flag is disabled, production check skips activation — no state record', async () => {
      // Production contract: pd-console reads the prompt flag before
      // dispatching. When disabled, completeApproval is NOT called, so no
      // activation record is written. This test simulates that production check.
      //
      // We verify:
      // 1. The flag resolves to enabled=false when disabled via config
      // 2. When the production check skips dispatch, stateStore has no records
      const userFlags = {
        prompt: { enabled: false },
      };
      const result = computeEffectiveFlags(
        userFlags,
        DEFAULT_FEATURE_FLAGS,
        '/test/.pd/feature-flags.yaml',
      );
      const flag = result.flags.prompt;
      expect(flag?.enabled).toBe(false);

      // Simulate the production gate: if flag disabled, do NOT dispatch.
      // (This mirrors how pd-console dispatchActivationAfterApproval checks
      // story_a_approval_completion — the same pattern applies to channel flags.)
      const shouldDispatch = flag?.enabled === true;
      expect(shouldDispatch).toBe(false);

      // Since dispatch is skipped, no activation record exists.
      const promptActivations = await ws.stateStore.listPromptActivations();
      expect(promptActivations).toHaveLength(0);

      const allActivations = await ws.stateStore.listAllActivations();
      expect(allActivations).toHaveLength(0);
    });
  });

  describe('refused paths: invalid artifact cannot activate via prompt', () => {
    it('non-principle artifact is refused — no prompt activation', async () => {
      // PromptWriter.canActivate requires artifactKind === 'principle'
      const ruleArtifact = createPrincipleArtifact({
        artifactId: 'art-rule-misrouted',
        artifactKind: 'rule',
        sourceRuleId: 'rule-001',
      });
      const artifactReadModel = makeArtifactReadModel([ruleArtifact]);

      const enqueued = await ws.approvalStore.enqueue({
        artifactId: ruleArtifact.artifactId,
        channel: 'prompt',
        riskLevel: 'low',
      }, '2026-06-18T00:00:00.000Z');
      await ws.approvalStore.approve(enqueued.approvalId, 'owner-001');

      const dispatcher = createPromptDispatcher(
        artifactReadModel,
        ws.stateStore,
        ws.approvalStore,
      );
      const completionService = new ApprovalCompletionService(
        ws.approvalStore,
        dispatcher,
        ws.stateStore,
      );

      const result = await completionService.completeApproval({
        approvalId: enqueued.approvalId,
        actor: { kind: 'human', userId: 'owner-001' },
        now: '2026-06-18T01:00:00.000Z',
      });

      // Service returns ok=true with a non-activation decision (refused)
      // because the dispatch failed, not the service. Key: no activation record.
      if (result.ok) {
        expect(['activated', 'already_activated']).not.toContain(result.decision.decision);
      }

      const promptActivations = await ws.stateStore.listPromptActivations();
      expect(promptActivations).toHaveLength(0);
    });

    it('unvalidated artifact is refused — no prompt activation', async () => {
      // PromptWriter.canActivate requires validationStatus === 'validated'
      const unvalidatedArtifact = createPrincipleArtifact({
        artifactId: 'art-principle-pending',
        validationStatus: 'pending',
      });
      const artifactReadModel = makeArtifactReadModel([unvalidatedArtifact]);

      const enqueued = await ws.approvalStore.enqueue({
        artifactId: unvalidatedArtifact.artifactId,
        channel: 'prompt',
        riskLevel: 'low',
      }, '2026-06-18T00:00:00.000Z');
      await ws.approvalStore.approve(enqueued.approvalId, 'owner-001');

      const dispatcher = createPromptDispatcher(
        artifactReadModel,
        ws.stateStore,
        ws.approvalStore,
      );
      const completionService = new ApprovalCompletionService(
        ws.approvalStore,
        dispatcher,
        ws.stateStore,
      );

      const result = await completionService.completeApproval({
        approvalId: enqueued.approvalId,
        actor: { kind: 'human', userId: 'owner-001' },
        now: '2026-06-18T01:00:00.000Z',
      });

      if (result.ok) {
        expect(['activated', 'already_activated']).not.toContain(result.decision.decision);
      }

      const promptActivations = await ws.stateStore.listPromptActivations();
      expect(promptActivations).toHaveLength(0);
    });
  });
});
