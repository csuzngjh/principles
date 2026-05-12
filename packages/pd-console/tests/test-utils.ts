import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import {
  RuntimeStateManager,
  PainChainReadModel,
  PruningReadModel,
  OperatorHealthReadModel,
  CandidateIntakeService,
  PrincipleTreeLedgerAdapter,
} from '@principles/core/runtime-v2';

export interface TestWorkspace {
  workspaceDir: string;
  stateDir: string;
  stateManager: RuntimeStateManager;
  painChainReadModel: PainChainReadModel;
  pruningReadModel: PruningReadModel;
  healthReadModel: OperatorHealthReadModel;
  candidateIntakeService: CandidateIntakeService;
}

export interface TaskSeed {
  taskId: string;
  taskKind: string;
  status: string;
  attemptCount?: number;
  maxAttempts?: number;
}

export interface CandidateSeed {
  candidateId: string;
  taskId: string;
  title: string;
  description: string;
  status: 'pending' | 'consumed' | 'expired';
  confidence?: number | null;
  sourceRecommendationJson?: string;
}

export interface PrincipleSeed {
  id: string;
  status: string;
  text: string;
  triggerPattern: string;
  action: string;
}

export interface WorkspaceSeedData {
  tasks: TaskSeed[];
  candidates: CandidateSeed[];
  principles: PrincipleSeed[];
  thinkingOs?: string;
  trainingState?: unknown;
}

export async function createTestWorkspace(seed?: Partial<WorkspaceSeedData>): Promise<TestWorkspace> {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-console-test-'));
  const stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });

  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();

  if (seed?.tasks) {
    for (const task of seed.tasks) {
      await stateManager.createTask({
        taskId: task.taskId,
        taskKind: task.taskKind,
        status: task.status as 'pending' | 'leased' | 'succeeded' | 'retry_wait' | 'failed',
        attemptCount: task.attemptCount ?? 0,
        maxAttempts: task.maxAttempts ?? 3,
      });
    }
  }

  if (seed?.candidates && seed.candidates.length > 0) {
    seedCandidateData(stateManager, seed.candidates);
  }

  const painChainReadModel = new PainChainReadModel({ workspaceDir, stateManager });
  const pruningReadModel = new PruningReadModel({ workspaceDir });
  const healthReadModel = new OperatorHealthReadModel({
    workspaceDir,
    painChainReadModel,
    pruningReadModel,
  });

  const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir });
  const candidateIntakeService = new CandidateIntakeService({
    stateManager,
    ledgerAdapter,
  });

  if (seed?.principles) {
    writePrincipleLedger(stateDir, seed.principles);
  }

  if (seed?.thinkingOs) {
    fs.writeFileSync(path.join(workspaceDir, 'THINKING_OS.md'), seed.thinkingOs, 'utf8');
  }

  if (seed?.trainingState) {
    fs.writeFileSync(
      path.join(stateDir, 'principle_training_state.json'),
      JSON.stringify(seed.trainingState, null, 2),
      'utf8',
    );
  }

  return {
    workspaceDir,
    stateDir,
    stateManager,
    painChainReadModel,
    pruningReadModel,
    healthReadModel,
    candidateIntakeService,
  };
}

function seedCandidateData(stateManager: RuntimeStateManager, candidates: CandidateSeed[]): void {
  const db = (stateManager as unknown as { _connection: { getDb: () => Database.Database } })._connection.getDb();

  const now = new Date().toISOString();

  for (const c of candidates) {
    const runId = `run-${c.candidateId}`;
    const artifactId = `artifact-${c.candidateId}`;
    const commitId = `commit-${c.candidateId}`;

    db.prepare(`
      INSERT OR IGNORE INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, ended_at, created_at, updated_at)
      VALUES (?, ?, 'diagnostician', 'succeeded', ?, ?, ?, ?)
    `).run(runId, c.taskId, now, now, now, now);

    db.prepare(`
      INSERT OR IGNORE INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at)
      VALUES (?, ?, ?, 'principle_candidate', '{}', ?)
    `).run(artifactId, runId, c.taskId, now);

    db.prepare(`
      INSERT OR IGNORE INTO commits (commit_id, task_id, run_id, artifact_id, idempotency_key, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'committed', ?)
    `).run(commitId, c.taskId, runId, artifactId, `idem-${c.candidateId}`, now);

    db.prepare(`
      INSERT OR IGNORE INTO principle_candidates
        (candidate_id, artifact_id, task_id, source_run_id, title, description, confidence, status, created_at, source_recommendation_json, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      c.candidateId,
      artifactId,
      c.taskId,
      runId,
      c.title,
      c.description,
      c.confidence ?? null,
      c.status,
      now,
      c.sourceRecommendationJson ?? '',
      `idem-cand-${c.candidateId}`,
    );
  }
}

export function cleanupTestWorkspace(ws: TestWorkspace): void {
  try { ws.healthReadModel.close(); } catch { /* ignore */ }
  try { ws.painChainReadModel.close(); } catch { /* ignore */ }
  try { ws.stateManager.close(); } catch { /* ignore */ }
  try { fs.rmSync(ws.workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writePrincipleLedger(stateDir: string, principles: PrincipleSeed[]): void {
  const entries = principles.map((p) => ({
    id: p.id,
    status: p.status,
    text: p.text,
    triggerPattern: p.triggerPattern,
    action: p.action,
    evaluability: 'high',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));

  const ledgerPath = path.join(stateDir, 'principle-tree-ledger.json');
  fs.writeFileSync(ledgerPath, JSON.stringify(entries, null, 2), 'utf8');
}

export function sampleThinkingOsMd(): string {
  return `# Thinking OS

<directive id="error-prevention" name="Error Prevention">
<trigger>When a tool call fails or returns an error</trigger>
<must>Analyze the error, identify root cause, apply corrective action</must>
<forbidden>Ignoring errors, retrying without analysis, suppressing error messages</forbidden>
</directive>

<directive id="user-alignment" name="User Alignment">
<trigger>When user intent is ambiguous or conflicts with prior instructions</trigger>
<must>Ask for clarification, present options, respect explicit user choice</must>
<forbidden>Assuming intent, overriding explicit user requests, silent modifications</forbidden>
</directive>
`;
}

export function sampleTrainingState() {
  return {
    tree: {
      principles: {
        'p-001': {
          id: 'p-001',
          status: 'active',
          text: 'Active principle',
          triggerPattern: 'on-error',
          action: 'fix it',
          evaluability: 'high',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-05-01T00:00:00Z',
        },
      },
    },
  };
}
