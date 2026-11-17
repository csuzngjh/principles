/**
 * PRI-1230 / SPEC-PD-INTENT-UNIFICATION-001 §9.2 — `pd pain record` passes the
 * neutral host IntentDocReader into the REAL production chain.
 *
 * This is a REAL integration test of the CLI entry: the actual
 * `handlePainRecord` handler runs against a real temp workspace (real
 * .pd/config.yaml, real state.db, real INTENT.md). Only the LLM network
 * boundary is scripted — `PiAiRuntimeAdapter.prototype` methods are spied to
 * return the cached R6 root-cause fixture, so the full
 * handler → PainToPrincipleService → createPainSignalBridge →
 * DiagRootCauseRunner chain executes for real and Stage A's snapshot capture
 * hits the real filesystem and the real diagnostic-json CAS.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { handlePainRecord } from '../../src/commands/pain-record.js';
import { PiAiRuntimeAdapter, RuntimeStateManager, computeIntentContentHash, invalidatePainSignalBridge } from '@principles/core/runtime';
import { resetHostIntentDocCacheForTest } from '@principles/host-runtime';
// Shared data authority (same copy TestDoubleRuntimeAdapter serves) — REAL
// cached LLM outputs, imported cross-package like cross-package-acceptance does.
import {
  MOCK_ROOT_CAUSE_OUTPUTS,
  MOCK_DISTILLER_OUTPUTS,
  MOCK_ROUTER_OUTPUTS,
} from '../../../principles-core/src/runtime/adapter/split-pipeline-fixtures.js';

const ENV_KEY = 'PRI1230_INTENT_TEST_KEY';
const SESSION_ID = 'pri1230-session-1';
/** Fixed correction-turn timestamp → the evidence sourceRef the output cites. */
const CORRECTION_AT = '2026-01-01T10:00:00Z';
const TRUSTED_REF = `owner_message:${CORRECTION_AT}`;

const AUTHORED_INTENT = [
  '# INTENT.md',
  '',
  '## 1. Why',
  '',
  'Owner 注意力是本阶段最稀缺的资源，必须保护。',
  '',
  '## 2. Desired Outcome',
  '',
  '重复的行为偏离在三次内被诊断并形成原则。',
  '',
  '## 3. Non-negotiables',
  '',
  '绝不牺牲用户信任换取自动化覆盖率。',
  '',
  '## 4. Stop / Escalation',
  '',
  '任何删除生产数据的动作必须停下询问 Owner。',
  '',
  '## 5. Current Strategic Focus',
  '',
  '验证痛点优先于架构完美。',
  '',
].join('\n');

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-record-intent-'));
}

/** Minimal runnable workspace config: pi-ai profile + diagnostician enabled. */
function writeConfig(workspaceDir: string, intentEnabled: boolean): void {
  const config = {
    version: 1,
    features: { intent_engineering: { category: 'quiet', enabled: intentEnabled } },
    runtimeProfiles: {
      'diag-profile': {
        type: 'pi-ai',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        apiKeyEnv: ENV_KEY,
      },
    },
    internalAgents: {
      defaultRuntime: 'diag-profile',
      agents: { diagnostician: { enabled: true, runtimeProfile: 'diag-profile' } },
    },
  };
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  // JSON is valid YAML — the established fixture trick.
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
}

function writeIntent(workspaceDir: string, content: string): void {
  fs.mkdirSync(path.join(workspaceDir, '.principles'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.principles', 'INTENT.zh-CN.md'), content, 'utf8');
}

/**
 * Minimal session-bound trajectory: one correction user turn. This gives the
 * shared ingress evaluator a real bound session and the root-cause evidence-ref
 * validator exactly one trusted ref (TRUSTED_REF) to cite — the same shape the
 * pain-record unit tests mock acquireTrajectoryEvidenceFromDb with.
 */
function writeTrajectory(workspaceDir: string): void {
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
  try {
    db.exec(`
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE user_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        raw_excerpt TEXT,
        correction_detected INTEGER,
        correction_cue TEXT,
        created_at TEXT
      );
    `);
    db.prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?)')
      .run(SESSION_ID, CORRECTION_AT, CORRECTION_AT);
    db.prepare('INSERT INTO user_turns (session_id, raw_excerpt, correction_detected, correction_cue, created_at) VALUES (?, ?, 1, ?, ?)')
      .run(SESSION_ID, '不要自作主张，先调查已有实现再修改。', 'imperative_negative', CORRECTION_AT);
  } finally {
    db.close();
  }
}

/**
 * Script the LLM boundary: every stage returns the real cached R6 root-cause
 * output with the actual taskId substituted (the same dispatch discipline as
 * TestDoubleRuntimeAdapter).
 */
function installAdapterSpy(): { runIdToTaskId: Map<string, string>; fetchOutput: ReturnType<typeof vi.fn> } {
  const runIdToTaskId = new Map<string, string>();
  let counter = 0;
  let rootCauseTaskId: string | null = null;
  let rootCauseRunId: string | null = null;

  vi.spyOn(PiAiRuntimeAdapter.prototype, 'getCapabilities').mockResolvedValue({
    supportsStructuredJsonOutput: true,
    supportsToolUse: false,
    supportsWorkingDirectory: false,
    supportsModelSelection: false,
    supportsLongRunningSessions: false,
    supportsCancellation: true,
    supportsArtifactWriteBack: false,
    supportsConcurrentRuns: false,
    supportsStreaming: false,
  });
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'healthCheck').mockResolvedValue({
    healthy: true,
    degraded: false,
    warnings: [],
    lastCheckedAt: new Date().toISOString(),
  });
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'startRun').mockImplementation(async (input) => {
    counter += 1;
    const runId = `pri1230-run-${counter}`;
    const taskId = input.taskRef?.taskId;
    if (typeof taskId === 'string') runIdToTaskId.set(runId, taskId);
    return {
      runId,
      runtimeKind: 'pi-ai',
      startedAt: new Date().toISOString(),
      // Adapter contract: report the digest of the prompt actually handed to
      // the provider (the router receipt binds this — see TestDoubleRuntimeAdapter).
      systemPromptDigest: createHash('sha256').update(input.systemPrompt ?? '', 'utf8').digest('hex'),
    };
  });
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'pollRun').mockImplementation(async (runId: string) => ({
    runId,
    status: 'succeeded' as const,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  }));
  const fetchOutput = vi.spyOn(PiAiRuntimeAdapter.prototype, 'fetchOutput').mockImplementation(async (runId: string) => {
    // Stage-aware dispatch — the same discipline as TestDoubleRuntimeAdapter
    // (the sync record drives rootcause → distiller → router in one run).
    const taskId = runIdToTaskId.get(runId);
    if (taskId !== undefined && taskId.includes('diag_distiller')) {
      // The distiller validator requires the REAL root-cause artifact id —
      // the store assigns the run row id `run_<rootcauseTaskId>_<attempt>`.
      const sourceRootCauseArtifactId = `pi-art-${rootCauseTaskId ?? ''}-run_${rootCauseTaskId ?? ''}_1`;
      return { runId, payload: { ...MOCK_DISTILLER_OUTPUTS.R6, taskId, sourceRootCauseArtifactId } };
    }
    if (taskId !== undefined && taskId.includes('diag_router')) {
      // Router evidence (and the rule association's evidenceRefs) must cite
      // the session's trusted ref too.
      return {
        runId,
        payload: {
          ...MOCK_ROUTER_OUTPUTS.R6,
          evidence: [{ sourceRef: TRUSTED_REF, note: 'Owner corrected repeated unauthorized changes.' }],
          recommendations: MOCK_ROUTER_OUTPUTS.R6.recommendations.map((rec) =>
            rec.kind === 'rule' && rec.principleAssociation
              ? { ...rec, principleAssociation: { ...rec.principleAssociation, evidenceRefs: [TRUSTED_REF] } }
              : rec,
          ),
        },
      };
    }
    // Root-cause: the R6 fixture's refs are rewritten to the ONE trusted ref
    // this session-bound record actually carries (the correction turn).
    rootCauseTaskId = taskId ?? null;
    rootCauseRunId = runId;
    const r6 = MOCK_ROOT_CAUSE_OUTPUTS.R6;
    return {
      runId,
      payload: {
        ...r6,
        taskId: taskId ?? 'pri1230-task',
        evidence: [{ sourceRef: TRUSTED_REF, note: 'Owner corrected repeated unauthorized changes.' }],
        causalChain: r6.causalChain.map((entry) => ({ ...entry, evidenceRefs: [TRUSTED_REF] })),
      },
    };
  });
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'fetchArtifacts').mockResolvedValue([]);
  return { runIdToTaskId, fetchOutput };
}

interface RecordOutcome {
  status: string;
  taskId?: string;
  painId?: string;
}

async function runRecord(workspaceDir: string): Promise<RecordOutcome> {
  const log: string[] = [];
  const errLines: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    log.push(args.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errLines.push(args.map(String).join(' '));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
  try {
    await handlePainRecord({
      reason: '测试重复出现的行为偏离——CLI 接线验证',
      score: 70,
      json: true,
      session: SESSION_ID,
      workspace: workspaceDir,
    } as never);
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  const jsonLine = log.find((line) => line.trim().startsWith('{'));
  expect(jsonLine, `handler stderr: ${errLines.join(' | ')}`).toBeDefined();
  const outcome = JSON.parse(jsonLine as string) as RecordOutcome;
  // 'degraded' is a durable successful record with a product-level disclosure
  // (e.g. an MVP-disabled candidate channel); only 'failed' means the record
  // itself broke.
  expect(['succeeded', 'degraded'], `record outcome: ${JSON.stringify(outcome)}\nstderr: ${errLines.join(' | ')}`).toContain(outcome.status);
  return outcome;
}

async function readTaskSnapshot(workspaceDir: string, taskId: string): Promise<unknown> {
  const stateManager = new RuntimeStateManager({ workspaceDir });
  try {
    await stateManager.initialize();
    // Stage A persists the snapshot on the STAGE task it runs
    // (`diag_rootcause-<taskId>`), not the parent diagnosis task.
    for (const candidateId of [taskId, `diag_rootcause-${taskId}`]) {
      const task = await stateManager.getTask(candidateId);
      if (task?.diagnosticJson === undefined || task.diagnosticJson === null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(task.diagnosticJson);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== 'object' || !Object.hasOwn(parsed, 'pi_metadata')) continue;
      const metadata = (parsed as Record<string, unknown>).pi_metadata;
      if (metadata !== null && typeof metadata === 'object' && Object.hasOwn(metadata as object, 'intentSnapshot')) {
        return (metadata as Record<string, unknown>).intentSnapshot;
      }
    }
    return undefined;
  } finally {
    await stateManager.close().catch(() => undefined);
  }
}

describe('PRI-1230: pd pain record passes the neutral host reader into the real Stage A', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = makeWorkspace();
    resetHostIntentDocCacheForTest();
    process.env[ENV_KEY] = 'sentinel-not-a-real-key';
  });

  afterEach(async () => {
    delete process.env[ENV_KEY];
    vi.restoreAllMocks();
    resetHostIntentDocCacheForTest();
    invalidatePainSignalBridge(workspaceDir);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }
  });

  it('flag ON + authored INTENT.md → the task persists an intent snapshot with the file contentHash', async () => {
    writeConfig(workspaceDir, true);
    writeIntent(workspaceDir, AUTHORED_INTENT);
    writeTrajectory(workspaceDir);
    installAdapterSpy();

    const outcome = await runRecord(workspaceDir);
    expect(['succeeded', 'degraded']).toContain(outcome.status);
    expect(outcome.taskId).toBeDefined();

    const snapshot = await readTaskSnapshot(workspaceDir, outcome.taskId as string);
    expect(snapshot).toMatchObject({
      contentHash: computeIntentContentHash(AUTHORED_INTENT),
      lang: 'zh-CN',
    });
    const sections = (snapshot as { sections?: Array<{ key: string; missing?: boolean; placeholder?: boolean }> }).sections;
    // Authored = present and neither missing nor template-placeholder.
    expect(sections?.filter((s) => s.missing !== true && s.placeholder !== true).length).toBe(5);
  }, 120_000);

  it('flag ON + template-only INTENT.md → no snapshot persisted, normal pain flow continues', async () => {
    writeConfig(workspaceDir, true);
    writeIntent(workspaceDir, [
      '# INTENT.md',
      '',
      '## 1. Why',
      '',
      '这个项目 / 阶段为什么重要？',
      '',
      '## 2. Desired Outcome',
      '',
      '完成后，世界应该发生什么可观察的变化？',
      '',
      '## 3. Non-negotiables',
      '',
      '为了达成目标，哪些东西不能被牺牲？',
      '',
      '## 4. Stop / Escalation',
      '',
      '什么情况下 Agent 必须停下、询问或升级给 Owner？',
      '',
      '## 5. Current Strategic Focus',
      '',
      '当前阶段最重要的战略取舍是什么？',
      '',
    ].join('\n'));
    writeTrajectory(workspaceDir);
    installAdapterSpy();

    const outcome = await runRecord(workspaceDir);
    expect(['succeeded', 'degraded']).toContain(outcome.status);
    const snapshot = await readTaskSnapshot(workspaceDir, outcome.taskId as string);
    expect(snapshot).toBeUndefined();
  }, 120_000);

  it('flag OFF → no snapshot, normal pain flow', async () => {
    writeConfig(workspaceDir, false);
    writeIntent(workspaceDir, AUTHORED_INTENT);
    writeTrajectory(workspaceDir);
    installAdapterSpy();

    const outcome = await runRecord(workspaceDir);
    expect(['succeeded', 'degraded']).toContain(outcome.status);
    const snapshot = await readTaskSnapshot(workspaceDir, outcome.taskId as string);
    expect(snapshot).toBeUndefined();
  }, 120_000);

  it('flag ON + oversized INTENT.md → reader degrades (no snapshot), pain flow still succeeds', async () => {
    writeConfig(workspaceDir, true);
    writeIntent(workspaceDir, `${AUTHORED_INTENT}\n${'x'.repeat(33 * 1024)}\n`);
    writeTrajectory(workspaceDir);
    installAdapterSpy();

    const outcome = await runRecord(workspaceDir);
    expect(['succeeded', 'degraded']).toContain(outcome.status);
    const snapshot = await readTaskSnapshot(workspaceDir, outcome.taskId as string);
    expect(snapshot).toBeUndefined();
  }, 120_000);
});
