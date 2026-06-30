/**
 * Story A acceptance test 共享辅助函数。
 * 从 src/runtime-v2/activation/__tests__/story-a-acceptance.test.ts 抽取,
 * 让 acceptance test 和 BDD steps 共用,避免重复实现。
 *
 * 这些函数使用真实 SQLite stores + production services,
 * 不 mock production path (ERR-025)。
 *
 * 注意:本文件必须放在 src/ 下 (rootDir 内),不能放回 tests/bdd/support/。
 * 原因:story-a-acceptance.test.ts 在 src/__tests__/ 内,属于 tsc build 程序,
 * 若它 import rootDir 之外的文件 (如 tests/bdd/support/helpers.ts) 会触发
 * TS6059 (File is not under rootDir),导致 npm run build 失败。
 * BDD steps (tests/bdd/story-a.steps.ts) 不在 build 程序内,可以跨边界 import 本文件。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  SqliteConnection,
  SqliteApprovalQueueStore,
  SqliteActivationStateStore,
  SqlitePIArtifactStore,
  ActivationDispatcher,
  PromptWriter,
  DeferArchiveWriter,
  RuleHostWriter,
  createProductionGateDeps,
} from '../../index.js';
import type {
  PIArtifactSnapshot,
} from '../activation-types.js';

// ── Test workspace setup ────────────────────────────────────────────────────

export interface TestWorkspace {
  workspaceDir: string;
  connection: SqliteConnection;
  approvalStore: SqliteApprovalQueueStore;
  stateStore: SqliteActivationStateStore;
  artifactStore: SqlitePIArtifactStore;
  cleanup: () => void;
}

export function createTestWorkspace(): TestWorkspace {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-story-a-accept-'));
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

export function createPrincipleArtifact(overrides: Partial<PIArtifactSnapshot> = {}): PIArtifactSnapshot {
  return {
    artifactId: 'art-principle-001',
    artifactKind: 'principle',
    sourceTaskId: 'task-pain-001',
    sourcePrincipleId: 'principle-001',
    lineageArtifactIds: [],
    validationStatus: 'validated',
    contentJson: JSON.stringify({
      text: 'Always read existing implementation before adding a parallel module',
      language: 'en',
    }),
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
    ...overrides,
  };
}

export function createRuleArtifact(overrides: Partial<PIArtifactSnapshot> = {}): PIArtifactSnapshot {
  return {
    artifactId: 'art-rule-001',
    artifactKind: 'rule',
    sourceTaskId: 'task-pain-001',
    sourcePrincipleId: 'principle-001',
    sourceRuleId: 'rule-001',
    lineageArtifactIds: ['art-principle-001'],
    validationStatus: 'validated',
    contentJson: JSON.stringify({
      implementationCode: `
function evaluate(input, helpers) {
  var p = input.action.paramsSummary;
  if (helpers.getToolName() === 'edit' && p && p.filePath === '/etc/passwd') {
    return { decision: 'block', matched: true, reason: 'system path blocked' };
  }
  return { decision: 'allow', matched: false, reason: 'safe path' };
}
`,
      goldenTrace: {
        traceId: 'trace-001',
        version: 1,
        createdAt: '2026-06-18T00:00:00.000Z',
        cases: [
          {
            caseId: 'negative-1',
            kind: 'negative',
            toolName: 'edit',
            params: { filePath: '/etc/passwd' },
            expectedDecision: 'block',
          },
          {
            caseId: 'positive-1',
            kind: 'positive',
            toolName: 'edit',
            params: { filePath: '/src/index.ts' },
            expectedDecision: 'allow',
          },
        ],
      },
      ruleHostGateDecision: 'accepted_shadow',
      affectedTools: ['edit'],
    }),
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
    ...overrides,
  };
}

export function createProductionDispatcher(
  artifactReadModel: { getArtifactById: (id: string) => Promise<PIArtifactSnapshot | null> },
  stateStore: SqliteActivationStateStore,
  approvalStore: SqliteApprovalQueueStore,
): ActivationDispatcher {
  return new ActivationDispatcher(
    artifactReadModel,
    stateStore,
    {
      writers: [
        new PromptWriter(),
        new RuleHostWriter({ gateDeps: createProductionGateDeps() }),
        new DeferArchiveWriter(),
      ],
      approvalQueueStore: approvalStore,
    },
  );
}

export function makeArtifactReadModel(artifacts: PIArtifactSnapshot[]): {
  getArtifactById: (id: string) => Promise<PIArtifactSnapshot | null>;
} {
  const map = new Map(artifacts.map(a => [a.artifactId, a]));
  return {
    getArtifactById: async (id: string) => map.get(id) ?? null,
  };
}

// P1-3: Seed artifact to DB for FK validation (approvals.artifact_id → pi_artifacts).
// Tests use in-memory artifactReadModel for the dispatcher, but the SQLite
// approvalStore.enqueue() now checks pi_artifacts table at FK level.
export function seedArtifactToDb(ws: TestWorkspace, artifact: PIArtifactSnapshot): void {
  const db = ws.connection.getDb();
  db.prepare(
    "INSERT OR IGNORE INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, 'diagnosis', 'pending', ?, ?)",
  ).run(artifact.sourceTaskId, artifact.createdAt, artifact.createdAt);
  db.prepare(
    `INSERT OR IGNORE INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    artifact.artifactId,
    artifact.artifactKind,
    artifact.sourceTaskId,
    artifact.sourcePrincipleId ?? null,
    artifact.sourceRuleId ?? null,
    JSON.stringify(artifact.lineageArtifactIds),
    artifact.validationStatus,
    artifact.contentJson,
    artifact.createdAt,
    artifact.updatedAt,
  );
}
