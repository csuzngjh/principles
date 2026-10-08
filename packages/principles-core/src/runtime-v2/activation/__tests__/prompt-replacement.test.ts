import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteConnection } from '../../store/sqlite-connection.js';
import { SqliteActivationStateStore } from '../sqlite-activation-state-store.js';
import { SqlitePIArtifactStore } from '../../store/artifact/sqlite-pi-artifact-store.js';
import {
  buildOwnerRevisionArtifact,
  detectPromptReplacementTarget,
} from '../prompt-replacement.js';
import type { PIArtifactSnapshot } from '../activation-types.js';

/**
 * PD_PROMPT_CAPACITY_V1 R-B3 (AC-11, core level): the atomic prompt-version
 * replacement — success, idempotent replay, fault rollback (the OLD version
 * is never lost), revision detection, and Owner-revision artifact assembly
 * through the REAL content-validation contract.
 */

const tempDirs: string[] = [];

function tempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-replacement-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.pd'), { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function scribeContent(taskId: string, statement: string): string {
  return JSON.stringify({
    taskId,
    sourcePhilosopherArtifactId: 'pi-art-phil-x',
    principleDraft: {
      title: '过长原则',
      statement,
      rationale: 'why',
      applicability: ['coding'],
      antiPatterns: [],
      confidence: 0.8,
    },
    intentContract: {
      ownerIntent: 'avoid oversized statements',
      targetBehavior: 'shortest sufficient statement',
      forbiddenBehavior: 'padding statements with examples',
      evidenceSource: 'pain-1',
      validationExpectation: 'statement keeps trigger/action/exception',
    },
    sourceTrace: { philosopherArtifactId: 'pi-art-phil-x' },
    risks: [],
    generatedAt: '2026-10-07T08:00:00.000Z',
  });
}

function seedArtifact(
  connection: SqliteConnection,
  spec: {
    artifactId: string;
    taskId: string;
    statement: string;
    sourcePrincipleId?: string;
    lineage?: string[];
  },
): void {
  const { artifactId, taskId, statement } = spec;
  const store = new SqlitePIArtifactStore(connection);
  const now = '2026-10-07T08:00:00.000Z';
  store.upsertArtifact({
    artifactId,
    artifactKind: 'principle',
    sourceTaskId: taskId,
    ...(spec.sourcePrincipleId !== undefined ? { sourcePrincipleId: spec.sourcePrincipleId } : {}),
    sourceRuleId: undefined,
    lineageArtifactIds: spec.lineage ?? (artifactId == 'art-new' ? ['art-old'] : []),
    validationStatus: 'validated',
    contentJson: scribeContent(taskId, statement),
    createdAt: now,
    updatedAt: now,
  }).catch(() => { /* sync sqlite under the hood */ });
}

async function snapshotOf(store: SqlitePIArtifactStore, artifactId: string): Promise<PIArtifactSnapshot | null> {
  const r = await store.getArtifactById(artifactId);
  if (!r) return null;
  return {
    artifactId: r.artifactId,
    artifactKind: r.artifactKind,
    sourceTaskId: r.sourceTaskId,
    ...(r.sourcePrincipleId !== null && r.sourcePrincipleId !== undefined ? { sourcePrincipleId: r.sourcePrincipleId } : {}),
    ...(r.sourceRuleId !== null && r.sourceRuleId !== undefined ? { sourceRuleId: r.sourceRuleId } : {}),
    lineageArtifactIds: r.lineageArtifactIds,
    validationStatus: r.validationStatus,
    contentJson: r.contentJson,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

async function seedLiveActivation(
  store: SqliteActivationStateStore,
  activationId: string,
  artifactId: string,
): Promise<void> {
  await store.recordActivation({
    activationId,
    idempotencyKey: `${artifactId}::prompt`,
    artifactId,
    channel: 'prompt',
    action: 'prompt_activate',
    targetRef: `ledger://${activationId}`,
    activatedAt: '2026-10-07T08:00:00.000Z',
    deactivatedAt: null,
  });
}

describe('R-B3: SqliteActivationStateStore.replacePromptActivation (AC-11)', () => {
  it('replaces atomically: new live, old deactivated, immutable supersede decision', async () => {
    const dir = tempWorkspace();
    const connection = new SqliteConnection({ workspaceDir: dir });
    try {
      seedArtifact(connection, {artifactId: 'art-old', taskId: 'task-old', statement: 'old statement'});
      seedArtifact(connection, {artifactId: 'art-new', taskId: 'task-new', statement: 'new statement'});
      const store = new SqliteActivationStateStore(connection);
      await seedLiveActivation(store, 'act-old-1', 'art-old');

      const outcome = await store.replacePromptActivation({
        newRecord: {
          activationId: 'act-new-1',
          idempotencyKey: 'art-new::prompt',
          artifactId: 'art-new',
          channel: 'prompt',
          action: 'prompt_activate',
          targetRef: 'ledger://x',
          activatedAt: '2026-10-07T09:00:00.000Z',
          deactivatedAt: null,
        },
        supersededActivationId: 'act-old-1',
        supersededArtifactId: 'art-old',
        decidedBy: 'owner-1',
        decidedAt: '2026-10-07T09:00:00.000Z',
        reasonCode: 'prompt_revision_replacement',
        note: 'test replace',
      });
      expect(outcome.status).toBe('replaced');

      const rows = connection.getDb()
        .prepare('SELECT activation_id, deactivated_at FROM activations')
        .all() as { activation_id: string; deactivated_at: string | null }[];
      const byId = new Map(rows.map((r) => [r.activation_id, r.deactivated_at]));
      expect(byId.get('act-new-1')).toBeNull();
      expect(byId.get('act-old-1')).not.toBeNull();

      const decisions = connection.getDb()
        .prepare("SELECT decision, activation_id, artifact_id FROM activation_decisions WHERE decision = 'supersede'")
        .all() as { decision: string; activation_id: string; artifact_id: string }[];
      expect(decisions).toHaveLength(1);
      const [supersedeDecision] = decisions;
      expect(supersedeDecision?.activation_id).toBe('act-old-1');
      expect(supersedeDecision?.artifact_id).toBe('art-old');
    } finally {
      connection.close();
    }
  });

  it('replay after success is idempotent (already_replaced), and the decision row stays single', async () => {
    const dir = tempWorkspace();
    const connection = new SqliteConnection({ workspaceDir: dir });
    try {
      seedArtifact(connection, {artifactId: 'art-old', taskId: 'task-old', statement: 'old'});
      seedArtifact(connection, {artifactId: 'art-new', taskId: 'task-new', statement: 'new'});
      const store = new SqliteActivationStateStore(connection);
      await seedLiveActivation(store, 'act-old-1', 'art-old');
      const commit = {
        newRecord: {
          activationId: 'act-new-1',
          idempotencyKey: 'art-new::prompt',
          artifactId: 'art-new',
          channel: 'prompt' as const,
          action: 'prompt_activate',
          targetRef: 'ledger://x',
          activatedAt: '2026-10-07T09:00:00.000Z',
          deactivatedAt: null,
        },
        supersededActivationId: 'act-old-1',
        supersededArtifactId: 'art-old',
        decidedBy: 'owner-1',
        decidedAt: '2026-10-07T09:00:00.000Z',
        reasonCode: 'prompt_revision_replacement',
        note: 'test replay',
      };
      await store.replacePromptActivation(commit);
      const replay = await store.replacePromptActivation(commit);
      expect(replay.status).toBe('already_replaced');
      const count = connection.getDb()
        .prepare("SELECT COUNT(*) AS n FROM activation_decisions WHERE decision = 'supersede'")
        .get() as { n: number };
      expect(count.n).toBe(1);
      const liveCount = connection.getDb()
        .prepare("SELECT COUNT(*) AS n FROM activations WHERE deactivated_at IS NULL")
        .get() as { n: number };
      expect(liveCount.n).toBe(1); // only the new version
    } finally {
      connection.close();
    }
  });

  it('fault injection: an invalid supersede target rolls back completely — the old version is never lost', async () => {
    const dir = tempWorkspace();
    const connection = new SqliteConnection({ workspaceDir: dir });
    try {
      seedArtifact(connection, {artifactId: 'art-old', taskId: 'task-old', statement: 'old statement'});
      seedArtifact(connection, {artifactId: 'art-new', taskId: 'task-new', statement: 'new statement'});
      const store = new SqliteActivationStateStore(connection);
      await seedLiveActivation(store, 'act-old-1', 'art-old');

      // 故障注入：superseded artifact 不匹配（指向错误工件）→ 事务抛错。
      await expect(store.replacePromptActivation({
        newRecord: {
          activationId: 'act-new-1',
          idempotencyKey: 'art-new::prompt',
          artifactId: 'art-new',
          channel: 'prompt',
          action: 'prompt_activate',
          targetRef: 'ledger://x',
          activatedAt: '2026-10-07T09:00:00.000Z',
          deactivatedAt: null,
        },
        supersededActivationId: 'act-old-1',
        supersededArtifactId: 'art-WRONG',
        decidedBy: 'owner-1',
        decidedAt: '2026-10-07T09:00:00.000Z',
        reasonCode: 'prompt_revision_replacement',
        note: 'fault injection',
      })).rejects.toThrow(/not a live prompt activation/);

      // 回滚干净：旧版本仍 live、无新行、无 supersede 决策行。
      const oldRow = connection.getDb()
        .prepare('SELECT deactivated_at FROM activations WHERE activation_id = ?')
        .get('act-old-1') as { deactivated_at: string | null };
      expect(oldRow.deactivated_at).toBeNull();
      const newCount = connection.getDb()
        .prepare('SELECT COUNT(*) AS n FROM activations WHERE activation_id = ?')
        .get('act-new-1') as { n: number };
      expect(newCount.n).toBe(0);
      const decisionCount = connection.getDb()
        .prepare("SELECT COUNT(*) AS n FROM activation_decisions WHERE decision = 'supersede'")
        .get() as { n: number };
      expect(decisionCount.n).toBe(0);
    } finally {
      connection.close();
    }
  });
});

describe('R-B3: detectPromptReplacementTarget', () => {
  it('finds the live prior version via lineage, ignores unrelated and deactivated ones, fails closed on ambiguity', async () => {
    const dir = tempWorkspace();
    const connection = new SqliteConnection({ workspaceDir: dir });
    try {
      const artifactStore = new SqlitePIArtifactStore(connection);
      const stateStore = new SqliteActivationStateStore(connection);
      const p = randomUUID();
      // live prior version (lineage-linked) + deactivated grandparent + unrelated live
      seedArtifact(connection, { artifactId: 'art-v1', taskId: 'task-v1', statement: 'v1', sourcePrincipleId: p });
      seedArtifact(connection, { artifactId: 'art-v2', taskId: 'task-v2', statement: 'v2', sourcePrincipleId: p, lineage: ['art-v1'] });
      seedArtifact(connection, { artifactId: 'art-v3', taskId: 'task-v3', statement: 'v3', sourcePrincipleId: p, lineage: ['art-v2'] });
      seedArtifact(connection, { artifactId: 'art-unrelated', taskId: 'task-unrelated', statement: 'other', sourcePrincipleId: randomUUID() });
      await seedLiveActivation(stateStore, 'act-v1', 'art-v1');
      await seedLiveActivation(stateStore, 'act-v2', 'art-v2');
      await seedLiveActivation(stateStore, 'act-unrelated', 'art-unrelated');
      // v1 停用(历史) — 不参与替换
      await stateStore.deactivateActivation('act-v1', '2026-10-07T10:00:00.000Z');

      const getArtifactById = async (id: string) => {
        const r = await artifactStore.getArtifactById(id);
        return r ? await snapshotOf(artifactStore, id) : null;
      };

      const single = await detectPromptReplacementTarget({
        approvalArtifactId: 'art-v3',
        getArtifactById,
        listPromptActivations: () => stateStore.listPromptActivations(),
      });
      expect(single.ok).toBe(true);
      if (single.ok) {
        expect(single.target?.supersededActivationId).toBe('act-v2');
        expect(single.target?.supersededArtifactId).toBe('art-v2');
      }

      // 歧义：同时 live 的 v2 与 v2b 都是 v3 的旧版本 → fail closed。
      seedArtifact(connection, {artifactId: 'art-v2b', taskId: 'task-v2b', statement: 'v2b', sourcePrincipleId: p, lineage: ['art-v2'] });
      await seedLiveActivation(stateStore, 'act-v2b', 'art-v2b');
      const ambiguous = await detectPromptReplacementTarget({
        approvalArtifactId: 'art-v3',
        getArtifactById,
        listPromptActivations: () => stateStore.listPromptActivations(),
      });
      expect(ambiguous.ok).toBe(false);
      if (!ambiguous.ok) expect(ambiguous.error).toContain('ambiguous_prompt_replacement');
    } finally {
      connection.close();
    }
  });
});

describe('R-B3: buildOwnerRevisionArtifact (real content contract)', () => {
  it('clones the scribe artifact with a new statement, new task identity, lineage to the old artifact — and the validator accepts it', async () => {
    const dir = tempWorkspace();
    const connection = new SqliteConnection({ workspaceDir: dir });
    try {
      const artifactStore = new SqlitePIArtifactStore(connection);
      seedArtifact(connection, { artifactId: 'art-old', taskId: 'task-old', statement: 'O'.repeat(1900), sourcePrincipleId: randomUUID() });
      const old = await snapshotOf(artifactStore, 'art-old');
      expect(old).not.toBeNull();
      if (old === null) return;

      const build = await buildOwnerRevisionArtifact({
        oldArtifact: old,
        newStatement: '精简后的最短充分正文',
        editedBy: 'owner-1',
        now: '2026-10-07T11:00:00.000Z',
      });
      expect(build.ok).toBe(true);
      if (!build.ok) return;
      expect(build.draft.artifactId).not.toBe('art-old');
      expect(build.draft.sourceTaskId.startsWith('task-old-ownerrev-')).toBe(true);
      expect(build.draft.lineageArtifactIds).toContain('art-old');
      expect(build.oldStatement).toBe('O'.repeat(1900));
      expect(build.title).toBe('过长原则');
      const parsed = JSON.parse(build.draft.contentJson) as { principleDraft: { statement: string }; taskId: string };
      expect(parsed.principleDraft.statement).toBe('精简后的最短充分正文');
      expect(parsed.taskId).toBe(build.draft.sourceTaskId);
      // 意图字段原样保留（Owner 语义判断面）。
      expect((parsed as { intentContract?: unknown }).intentContract).toBeDefined();
    } finally {
      connection.close();
    }
  });

  it('refuses empty and unchanged statements without producing anything', async () => {
    const dir = tempWorkspace();
    const connection = new SqliteConnection({ workspaceDir: dir });
    try {
      const artifactStore = new SqlitePIArtifactStore(connection);
      seedArtifact(connection, {artifactId: 'art-old', taskId: 'task-old', statement: 'same statement'});
      const old = await snapshotOf(artifactStore, 'art-old');
      if (old === null) throw new Error('seed failed');
      const empty = await buildOwnerRevisionArtifact({ oldArtifact: old, newStatement: '   ', editedBy: 'o', now: '2026-10-07T11:00:00.000Z' });
      expect(empty.ok).toBe(false);
      if (!empty.ok) expect(empty.error).toBe('statement_empty');
      const unchanged = await buildOwnerRevisionArtifact({ oldArtifact: old, newStatement: 'same statement', editedBy: 'o', now: '2026-10-07T11:00:00.000Z' });
      expect(unchanged.ok).toBe(false);
      if (!unchanged.ok) expect(unchanged.error).toBe('statement_unchanged');
    } finally {
      connection.close();
    }
  });
});

describe('replacement identity guards preserve working versions and history', () => {
  it('refuses a same-ID replacement before overwriting the working version', async () => {
    const connection = new SqliteConnection({ workspaceDir: tempWorkspace() });
    try {
      seedArtifact(connection, { artifactId: 'art-old', taskId: 'task-old', statement: 'old' });
      seedArtifact(connection, { artifactId: 'art-new', taskId: 'task-new', statement: 'new' });
      const store = new SqliteActivationStateStore(connection);
      await seedLiveActivation(store, 'same-id', 'art-old');
      await expect(store.replacePromptActivation({ newRecord: { activationId: 'same-id', artifactId: 'art-new', idempotencyKey: 'art-new::prompt', channel: 'prompt', action: 'prompt_activate', targetRef: 'ledger://p', activatedAt: '2026-10-08T02:00:00.000Z', deactivatedAt: null }, supersededActivationId: 'same-id', supersededArtifactId: 'art-old', decidedBy: 'owner', decidedAt: '2026-10-08T02:00:00.000Z', reasonCode: 'prompt_revision_replacement', note: 'must preserve old version' })).rejects.toThrow(/distinct/);
      expect((await store.getActivationStatus('art-old::prompt'))?.artifactId).toBe('art-old');
      expect(connection.getDb().prepare('SELECT * FROM activation_decisions').all()).toHaveLength(0);
    } finally { connection.close(); }
  });
  it('refuses replay with a target belonging to a different artifact without deactivating it', async () => {
    const connection = new SqliteConnection({ workspaceDir: tempWorkspace() });
    try {
      for (const name of ['old', 'new', 'other']) seedArtifact(connection, { artifactId: `art-${name}`, taskId: `task-${name}`, statement: name });
      const store = new SqliteActivationStateStore(connection);
      await seedLiveActivation(store, 'act-new', 'art-new');
      await seedLiveActivation(store, 'act-other', 'art-other');
      await expect(store.replacePromptActivation({ newRecord: { activationId: 'act-new', artifactId: 'art-new', idempotencyKey: 'art-new::prompt', channel: 'prompt', action: 'prompt_activate', targetRef: 'ledger://act-new', activatedAt: '2026-10-08T02:00:00.000Z', deactivatedAt: null }, supersededActivationId: 'act-other', supersededArtifactId: 'art-old', decidedBy: 'owner', decidedAt: '2026-10-08T02:00:00.000Z', reasonCode: 'prompt_revision_replacement', note: 'must refuse mismatched target' })).rejects.toThrow(/superseded/);
      expect((await store.getActivationStatus('art-other::prompt'))?.deactivatedAt).toBeNull();
      expect(connection.getDb().prepare('SELECT * FROM activation_decisions').all()).toHaveLength(0);
    } finally { connection.close(); }
  });
});

describe('source identity at the transaction boundary', () => {
  it('refuses known cross-principle lineage and preserves both records', async () => {
    const connection = new SqliteConnection({ workspaceDir: tempWorkspace() });
    try {
      seedArtifact(connection, { artifactId: 'art-old', taskId: 'task-old', statement: 'old', sourcePrincipleId: randomUUID() });
      seedArtifact(connection, { artifactId: 'art-new', taskId: 'task-new', statement: 'new', sourcePrincipleId: randomUUID(), lineage: ['art-old'] });
      const store = new SqliteActivationStateStore(connection);
      await seedLiveActivation(store, 'act-old', 'art-old');
      await expect(store.replacePromptActivation({ newRecord: { activationId: 'act-new', artifactId: 'art-new', idempotencyKey: 'art-new::prompt', channel: 'prompt', action: 'prompt_activate', targetRef: 'ledger://new', activatedAt: '2026-10-08T02:00:00Z', deactivatedAt: null }, supersededActivationId: 'act-old', supersededArtifactId: 'art-old', decidedBy: 'Alice', decidedAt: '2026-10-08T02:00:00Z', reasonCode: 'prompt_revision_replacement', note: 'must refuse cross principle' })).rejects.toThrow(/different principles/);
      expect((await store.getActivationStatus('art-old::prompt'))?.deactivatedAt).toBeNull();
      expect(await store.getActivationStatus('art-new::prompt')).toBeNull();
      expect(connection.getDb().prepare('SELECT * FROM activation_decisions').all()).toHaveLength(0);
    } finally { connection.close(); }
  });
});

describe('legacy activation aliases', () => {
  it('replaces the known live artifact when an inactive historical artifact shares its ID, then replays the same bound decision', async () => {
    const connection = new SqliteConnection({ workspaceDir: tempWorkspace() });
    try {
      for (const name of ['historical', 'old', 'new']) seedArtifact(connection, { artifactId: `art-${name}`, taskId: `task-${name}`, statement: name });
      const store = new SqliteActivationStateStore(connection);
      await seedLiveActivation(store, 'legacy-alias', 'art-historical');
      await store.deactivateActivation('legacy-alias', '2026-10-07T08:30:00Z');
      await seedLiveActivation(store, 'legacy-alias', 'art-old');
      const commit = { newRecord: { activationId: 'act-new', artifactId: 'art-new', idempotencyKey: 'art-new::prompt', channel: 'prompt' as const, action: 'prompt_activate', targetRef: 'ledger://new', activatedAt: '2026-10-08T02:00:00Z', deactivatedAt: null }, supersededActivationId: 'legacy-alias', supersededArtifactId: 'art-old', decidedBy: 'Alice', decidedAt: '2026-10-08T02:00:00Z', reasonCode: 'prompt_revision_replacement', note: 'known artifact target' };
      expect((await store.replacePromptActivation(commit)).status).toBe('replaced');
      expect((await store.replacePromptActivation(commit)).status).toBe('already_replaced');
      expect((await store.listPromptActivations(true)).find((record) => record.artifactId === 'art-historical')?.deactivatedAt).toBe('2026-10-07T08:30:00Z');
      expect((await store.getActivationStatus('art-new::prompt'))?.deactivatedAt).toBeNull();
      await expect(store.replacePromptActivation({ ...commit, newRecord: { ...commit.newRecord, targetRef: 'ledger://wrong' } })).rejects.toThrow(/identity conflicts/);
      expect(connection.getDb().prepare('SELECT * FROM activations').all()).toHaveLength(3);
      expect(connection.getDb().prepare('SELECT * FROM activation_decisions').all()).toHaveLength(1);
    } finally { connection.close(); }
  });
});

describe('legacy text alias and single executed statement', () => {
  it('removes an identical top-level text alias only in the new version and refuses contradictory aliases', async () => {
    const connection = new SqliteConnection({ workspaceDir: tempWorkspace() });
    try {
      seedArtifact(connection, { artifactId: 'art-old', taskId: 'task-old', statement: 'Before edits, check callers.' });
      const old = await snapshotOf(new SqlitePIArtifactStore(connection), 'art-old');
      if (!old) throw new Error('old fixture missing');
      const same = { ...old, contentJson: JSON.stringify({ ...JSON.parse(old.contentJson), text: 'Before edits, check callers.' }) };
      const built = await buildOwnerRevisionArtifact({ oldArtifact: same, newStatement: 'Before changes, inspect callers.', editedBy: 'Alice', now: '2026-10-08T04:00:00Z' });
      expect(built.ok).toBe(true);
      if (!built.ok) throw new Error('build failed');
      expect(JSON.parse(built.draft.contentJson).text).toBeUndefined();
      expect(JSON.parse(built.draft.contentJson).principleDraft.statement).toBe('Before changes, inspect callers.');
      expect(JSON.parse(same.contentJson).text).toBe('Before edits, check callers.');
      const ambiguous = await buildOwnerRevisionArtifact({ oldArtifact: { ...old, contentJson: JSON.stringify({ ...JSON.parse(old.contentJson), text: 'Skip checks.' }) }, newStatement: 'Before changes, inspect callers.', editedBy: 'Alice', now: '2026-10-08T04:00:00Z' });
      expect(ambiguous).toMatchObject({ ok: false, error: 'old_artifact_ambiguous_statement' });
    } finally { connection.close(); }
  });
});
