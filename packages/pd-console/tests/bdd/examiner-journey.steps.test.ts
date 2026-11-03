/**
 * SPEC-PD-EXAMINER-001 v0.10.1 BDD: the Owner evaluation journey — binds to
 * the REAL handleExaminerRoute against a real temp workspace (repo lab) and
 * the REAL async-run ledger module. Fixtures enter through the same public
 * route boundary the Console UI uses; nothing is hand-inserted except the
 * Stage R authorization records an Owner would place (run-authorization.json).
 *
 * Closes the examiner BDD gap: honest production-evidence degradation, the
 * suite catalog + Gate 1 boundary, frozen production snapshot with real pain
 * lineage, INTERVENTION_NOT_IDENTIFIABLE refusal for coupled targets, the
 * §12.3 async contract (202/409/recovery/no-auto-retry), the F2 authorization
 * gate (403 / accepted-but-not-executed with zero model calls), and the
 * permanent read-only boundary of historical research assets.
 */
import { beforeEach, afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createStepRegistry, defineFeature } from '../../../principles-core/tests/bdd/support/vitest-bdd.js';
import { resolveFeaturePath } from '../../../principles-core/tests/bdd/support/repo-root.js';
import { handleExaminerRoute } from '../../src/server/routes/examiner.js';
import {
  readConsoleRuns, recoverUnfinishedConsoleRuns, appendConsoleRunEvent, mintRunId,
  CONSOLE_RUN_SCHEMA, type ConsoleRunMode,
} from '../../src/server/routes/examiner-runs.js';
import { resolveStudyRoots } from '../../src/server/routes/examiner-executor.js';

const registry = createStepRegistry();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

let tempDir = '';
let workspaceDir = '';
let studiesRoot = '';
let res: { statusCode: number; _body: string } | undefined;
let body: any;
let lastStudyId = '';
/** When true the seeded target principle carries a live rulecode activation row. */
let coupledTarget = false;

function call(method: string, subPath: string, payload?: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    // Buffering request double: emit the body when the reader subscribes to
    // 'end', never on a timer. handleExaminerRoute awaits real I/O before
    // readBody (the one-time lab cold load on the first request), so a
    // `setTimeout(..., 0)` emitter loses 'data'/'end' before listeners exist
    // and readBody never settles (reproduced: `bdd call timeout: POST
    // /studies` under a filtered -t run).
    const raw = payload === undefined ? '' : JSON.stringify(payload);
    const listeners: { data: Array<(chunk: Buffer) => void>; end: Array<() => void> } = { data: [], end: [] };
    let emitted = false;
    const req = {
      method,
      url: subPath,
      on(event: 'data' | 'end', handler: (chunk?: unknown) => void) {
        if (event === 'end') {
          listeners.end.push(handler as () => void);
          if (!emitted) {
            emitted = true;
            if (raw !== '') for (const dataHandler of listeners.data) dataHandler(Buffer.from(raw));
            for (const endHandler of listeners.end) endHandler();
          }
        } else {
          listeners.data.push(handler as (chunk: Buffer) => void);
        }
        return req;
      },
    } as unknown as IncomingMessage;
    const response = {
      headersSent: false,
      statusCode: 200,
      _body: '',
      writeHead(code: number) {
        response.statusCode = code;
        return response;
      },
      end(data?: string) {
        if (data !== undefined) response._body = data;
        return response;
      },
    } as unknown as ServerResponse & { statusCode: number; _body: string };
    const timer = setTimeout(() => reject(new Error(`bdd call timeout: ${method} ${subPath}`)), 100_000);
    void handleExaminerRoute(req, response, workspaceDir, subPath).then(() => {
      clearTimeout(timer);
      res = response;
      body = response._body ? JSON.parse(response._body) : null;
      resolve();
    }, (error: unknown) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function writeLedger(): void {
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  const principle = (id: string, extra: Record<string, unknown> = {}) => ({
    id, text: `原则 ${id}`, triggerPattern: 't', action: 'a', status: id === 'pri-archived' ? 'archived' : 'active',
    priority: 'P1', scope: 'general', evaluability: 'manual_only', valueScore: 1, adherenceRate: 1,
    painPreventedCount: 0, derivedFromPainIds: id === 'pri-target' ? ['pain-e2e-1'] : [], ruleIds: [],
    createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', version: 1, ...extra,
  });
  fs.writeFileSync(
    path.join(workspaceDir, '.state', 'principle_training_state.json'),
    JSON.stringify({
      _tree: {
        principles: {
          'pri-target': principle('pri-target', coupledTarget ? { ruleIds: ['rule-coupled'] } : {}),
          'pri-archived': principle('pri-archived'),
        },
        rules: {}, implementations: {}, metrics: {}, lastUpdated: '2026-11-01T00:00:00Z',
      },
    }),
  );
}

function studyDirOf(studyId: string): string {
  const dir = path.resolve(studiesRoot, studyId);
  if (!dir.startsWith(path.resolve(studiesRoot) + path.sep)) throw new Error('bdd: study dir escaped root');
  return dir;
}

function eventsOf(studyId: string): Record<string, unknown>[] {
  return fs.readFileSync(path.join(studyDirOf(studyId), 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function createStudy(): Promise<void> {
  await call('POST', '/studies', { targetPrincipleId: 'pri-target', experimentMode: 'full_library_incremental', repetitionsPerCase: 1, suiteKey: 'calibration-core' });
  if (!body?.data?.studyId) {
    throw new Error(`bdd: study creation did not return an identity (status ${res?.statusCode}: ${res?._body.slice(0, 300) ?? 'no body'})`);
  }
  lastStudyId = body.data.studyId;
}

/** Wait until the console run settles (the async contract settles via events). */
async function waitForSettle(studyId: string, runId: string): Promise<void> {
  for (let i = 0; i < 150; i += 1) {
    const runs = readConsoleRuns(resolveStudyRootsFromLab(), studyDirOf(studyId));
    const found = runs.find((run) => run.runId === runId);
    if (found && found.status !== 'RUNNING') return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`console run ${runId} did not settle`);
}

registry.given(/一个已安装 PD 的工作区(（[^）]*）)?$/, () => {
  writeLedger();
});

registry.given(/一个已安装 PD 的工作区，原则 pri-target 为 active 且无 RuleCode 耦合，Pain 溯源为 pain-e2e-1$/, () => {
  coupledTarget = false;
  writeLedger();
});

registry.given(/一个已安装 PD 的工作区，原则 pri-target 绑定了运行时 live RuleCode 激活$/, () => {
  coupledTarget = true;
  writeLedger();
});

registry.given(/Examiner 研究引擎可用$/, () => {
  writeLedger();
});

registry.given(/一个 Owner 拥有的可写 Study 且预检通过$/, async () => {
  coupledTarget = false;
  writeLedger();
  await createStudy();
  await call('POST', `/studies/${lastStudyId}/preflight`);
  expect(body.data.ok).toBe(true);
});

registry.given(/一个 Study 存在未结算的 CONSOLE_RUN_ACCEPTED（受理进程仍存活）$/, async () => {
  writeLedger();
  await createStudy();
  appendConsoleRunEvent(resolveStudyRootsFromLab(), studyDirOf(lastStudyId), {
    type: 'CONSOLE_RUN_ACCEPTED', schema: CONSOLE_RUN_SCHEMA, runId: mintRunId(), studyId: lastStudyId,
    mode: 'host-dry-run' as ConsoleRunMode, acceptedAt: new Date().toISOString(), pid: process.pid, owner: 'pd-console',
  });
});

registry.given(/一个 Study 存在未结算的 CONSOLE_RUN_ACCEPTED 且受理进程已死亡$/, async () => {
  writeLedger();
  await createStudy();
  appendConsoleRunEvent(resolveStudyRootsFromLab(), studyDirOf(lastStudyId), {
    type: 'CONSOLE_RUN_ACCEPTED', schema: CONSOLE_RUN_SCHEMA, runId: 'RUN-C-DEAD', studyId: lastStudyId,
    mode: 'host-dry-run' as ConsoleRunMode, acceptedAt: new Date().toISOString(), pid: 999_999_999, owner: 'pd-console',
  });
});

registry.given(/一个可写 Study 不含 run-authorization\.json$/, async () => {
  writeLedger();
  await createStudy();
});

registry.given(/同一 Study 写入了状态非 APPROVED 的授权记录$/, async () => {
  writeLedger();
  await createStudy();
  const suite = JSON.parse(fs.readFileSync(path.join(studyDirOf(lastStudyId), 'suite-manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(studyDirOf(lastStudyId), 'run-authorization.json'), JSON.stringify({
    schema: 'challenge-stage-authorization.v1', stage: 'R', status: 'REQUESTED',
    studyId: lastStudyId, suiteHash: suite.suiteHash, executionMode: 'F2-real-host',
  }));
});

registry.given(/一个可写 Study 写入了绑定本 Study 冻结套件的 APPROVED F2 授权记录$/, async () => {
  writeLedger();
  await createStudy();
  // P1-5: the gate enforces the FULL Stage R contract — the fixture carries
  // every field the authoritative verifier checks (bindings, budget, window,
  // actor identity, F2 probe evidence). Synthetic only; nothing executes.
  fs.writeFileSync(path.join(studyDirOf(lastStudyId), 'run-authorization.json'), JSON.stringify(buildFullF2AuthorizationFixture(lastStudyId)));
});

registry.given(/历史研究资产 EXM-V09-ACC-ISO 存在于研究引擎$/, () => {
  writeLedger();
});

registry.when(/Owner 查询原则 (pri-\w+) 的生产证据聚合/, async (_: unknown, principleId: string) => {
  await call('GET', `/principles/${principleId}/evidence`);
});

registry.when(/Owner 查询 challenge 套件目录$/, async () => {
  await call('GET', '/suites');
});

registry.when(/Owner 以 calibration-core 套件创建 Study$/, async () => {
  await createStudy();
});

registry.when(/Owner 为其创建 Study$/, async () => {
  // Tolerant on purpose: the coupled target must REFUSE (asserted next).
  await call('POST', '/studies', { targetPrincipleId: 'pri-target', experimentMode: 'full_library_incremental', repetitionsPerCase: 1, suiteKey: 'calibration-core' });
});

registry.when(/Owner 以 host-dry-run 模式请求运行$/, async () => {
  await call('POST', `/studies/${lastStudyId}/run`, { mode: 'host-dry-run' });
});

registry.when(/Owner 再次以 host-dry-run 请求运行$/, async () => {
  await call('POST', `/studies/${lastStudyId}/run`, { mode: 'host-dry-run' });
});

registry.when(/执行启动恢复扫描$/, async () => {
  await recoverUnfinishedConsoleRuns(resolveStudyRootsFromLab());
});

registry.when(/Owner 请求 f2-real-host 运行$/, async () => {
  await call('POST', `/studies/${lastStudyId}/run`, { mode: 'f2-real-host' });
});

registry.when(/Owner 打开该 Study 的状态$/, async () => {
  await call('GET', '/studies/EXM-V09-ACC-ISO');
});

registry.then(/返回 ledger 原则事实与 asOf$/, () => {
  expect(body.data.principle.id).toBe('pri-target');
  expect(typeof body.data.asOf).toBe('string');
});

registry.then(/activation 通道为 degraded 且带结构化原因$/, () => {
  expect(body.data.activation.status).toBe('degraded');
  expect(typeof body.data.activation.reason).toBe('string');
});

registry.then(/injection 通道为 degraded 且带 globalReason$/, () => {
  expect(body.data.injection.status).toBe('degraded');
  expect(typeof body.data.injection.globalReason).toBe('string');
});

registry.then(/证据审计五类计数全为零但 status=degraded 且带原因$/, () => {
  expect(body.data.evidenceAudit.counts).toEqual({ deliveries: 0, applications: 0, episodes: 0, effects: 0, outcomes: 0 });
  expect(body.data.evidenceAudit.status).toBe('degraded');
  expect(typeof body.data.evidenceAudit.reason).toBe('string');
});

registry.then(/确认阶梯与应用证明全为零且未被升级$/, () => {
  expect(body.data.evidenceAudit.deliveryConfirmations).toEqual({ prepared: 0, submitted: 0, hostAccepted: 0, contextPresent: 0, runtimeLoaded: 0 });
  expect(body.data.evidenceAudit.applicationProof).toEqual({ agentClaimed: 0, runtimeVerified: 0 });
});

registry.then(/返回 404 principle_not_found$/, () => {
  expect(res?.statusCode).toBe(404);
  expect(body.error).toBe('principle_not_found');
});

registry.then(/返回 didactic-pair 与 calibration-core 两个固定套件$/, () => {
  expect(body.data.suites.map((suite: { key: string }) => suite.key)).toEqual(['didactic-pair', 'calibration-core']);
});

registry.then(/每个套件标注 SYNTHETIC_OFFLINE 与 Gate 1 阻塞说明$/, () => {
  for (const suite of body.data.suites) {
    expect(suite.goldProvenance).toBe('SYNTHETIC_OFFLINE');
    expect(suite.goldGate).toContain('Gate 1');
  }
});

registry.then(/返回服务端铸造的 EXM-C- 身份与 6 个计划配对$/, () => {
  expect(res?.statusCode).toBe(200);
  expect(body.data.studyId).toMatch(/^EXM-C-/);
  expect(body.data.plannedPairs).toBe(6);
  lastStudyId = body.data.studyId;
});

registry.then(/Study 目录冻结 production-snapshot\.json（schema v1）$/, () => {
  const snapshot = JSON.parse(fs.readFileSync(path.join(studyDirOf(lastStudyId), 'production-snapshot.json'), 'utf8'));
  expect(snapshot.schema).toBe('examiner-production-snapshot.v1');
  expect(snapshot.targetPrincipleId).toBe('pri-target');
});

registry.then(/冻结映射携带真实 painRefs=\[pain-e2e-1\]$/, () => {
  const mapping = JSON.parse(fs.readFileSync(path.join(studyDirOf(lastStudyId), 'pain-mechanism-mapping.json'), 'utf8'));
  expect(mapping.painRefs).toEqual(['pain-e2e-1']);
});

registry.then(/追加快照后冻结绑定校验仍通过$/, async () => {
  const preflight = await call('POST', `/studies/${lastStudyId}/preflight`);
  expect(body.data.ok).toBe(true);
  void preflight;
});

registry.then(/返回 422 study_creation_refused 且未写入任何文件$/, () => {
  expect(res?.statusCode).toBe(422);
  expect(body.error).toBe('study_creation_refused');
  expect(fs.readdirSync(studiesRoot)).toHaveLength(0);
});

registry.then(/返回 202 与 RUN-C- runId$/, () => {
  expect(res?.statusCode).toBe(202);
  expect(body.data.runId).toMatch(/^RUN-C-/);
});

registry.then(/运行在事件账本上结算为检查清单（含 stage_r_authorization、host_cli_probe、model_calls_zero）$/, async () => {
  await waitForSettle(lastStudyId, body.data.runId);
  const settled = eventsOf(lastStudyId).find((event) => event.runId === body.data.runId && event.type !== 'CONSOLE_RUN_ACCEPTED');
  const checkIds = ((settled?.checks as Record<string, unknown>[] | undefined) ?? []).map((check) => check.id);
  expect(checkIds).toContain('stage_r_authorization');
  expect(checkIds).toContain('host_cli_probe');
  expect(checkIds).toContain('model_calls_zero');
});

registry.then(/离线 Runner 未被启动（无 RUN_STARTED）$/, () => {
  expect(eventsOf(lastStudyId).some((event) => event.type === 'RUN_STARTED')).toBe(false);
});

registry.then(/返回 409 run_in_progress 且未追加新运行事件$/, () => {
  expect(res?.statusCode).toBe(409);
  expect(body.error).toBe('run_in_progress');
  expect(eventsOf(lastStudyId).filter((event) => event.type === 'CONSOLE_RUN_ACCEPTED')).toHaveLength(1);
});

registry.then(/追加 CONSOLE_RUN_ABANDONED 且 outcome=RESULT_UNKNOWN$/, () => {
  const runs = readConsoleRuns(resolveStudyRootsFromLab(), studyDirOf(lastStudyId));
  const abandoned = runs.find((run) => run.runId === 'RUN-C-DEAD');
  expect(abandoned?.status).toBe('ABANDONED');
  expect(abandoned?.outcome).toBe('RESULT_UNKNOWN');
});

registry.then(/重复扫描不再产生新的放弃事件$/, async () => {
  const before = eventsOf(lastStudyId).filter((event) => event.type === 'CONSOLE_RUN_ABANDONED').length;
  await recoverUnfinishedConsoleRuns(resolveStudyRootsFromLab());
  const after = eventsOf(lastStudyId).filter((event) => event.type === 'CONSOLE_RUN_ABANDONED').length;
  expect(after).toBe(before);
});

registry.then(/恢复后可受理新运行而废弃运行保持 ABANDONED$/, async () => {
  const accepted = await call('POST', `/studies/${lastStudyId}/run`, { mode: 'host-dry-run' });
  void accepted;
  expect(res?.statusCode).toBe(202);
  await waitForSettle(lastStudyId, body.data.runId);
  expect(readConsoleRuns(resolveStudyRootsFromLab(), studyDirOf(lastStudyId)).find((run) => run.runId === 'RUN-C-DEAD')?.status).toBe('ABANDONED');
});

registry.then(/返回 403 real_execution_not_authorized 且未追加运行事件$/, () => {
  expect(res?.statusCode).toBe(403);
  expect(body.error).toBe('real_execution_not_authorized');
  expect(eventsOf(lastStudyId).some((event) => event.type === 'CONSOLE_RUN_ACCEPTED')).toBe(false);
});

registry.then(/仍返回 403 且原因指明 APPROVED required$/, () => {
  expect(res?.statusCode).toBe(403);
  expect(body.message).toContain('is not APPROVED');
});

registry.then(/运行结算为 FAILED 且 outcome=F2_EXECUTION_NOT_ENABLED_THIS_ROUND$/, async () => {
  const runId = body.data.runId;
  await waitForSettle(lastStudyId, runId);
  const runs = readConsoleRuns(resolveStudyRootsFromLab(), studyDirOf(lastStudyId));
  expect(runs.find((run) => run.runId === runId)?.outcome).toBe('F2_EXECUTION_NOT_ENABLED_THIS_ROUND');
});

registry.then(/事件账本无 RUN_STARTED（零真实模型调用）$/, () => {
  expect(eventsOf(lastStudyId).some((event) => event.type === 'RUN_STARTED')).toBe(false);
});

registry.then(/返回 readOnly=true 与边界原因$/, () => {
  expect(body.data.readOnly).toBe(true);
  expect(typeof body.data.access).toBe('string');
});

/**
 * P1-5 fixture: a COMPLETE synthetic Stage R authorization carrying every
 * field the authoritative verifier enforces (bindings, budget, window,
 * actor identity, F2 probe evidence). Hashes replicate the lab's canonical
 * hashing (sorted keys, JSON.stringify, sha256). Synthetic only — nothing
 * executes, no host, no model.
 */
function buildFullF2AuthorizationFixture(studyId: string): Record<string, unknown> {
  const studyDir = studyDirOf(studyId);
  const manifest = JSON.parse(fs.readFileSync(path.join(studyDir, 'examiner-manifest.json'), 'utf8'));
  const suite = JSON.parse(fs.readFileSync(path.join(studyDir, 'suite-manifest.json'), 'utf8'));
  const mapping = JSON.parse(fs.readFileSync(path.join(studyDir, 'pain-mechanism-mapping.json'), 'utf8'));
  const scoring = JSON.parse(fs.readFileSync(path.join(studyDir, 'scoring-contract.json'), 'utf8'));
  const prereg = JSON.parse(fs.readFileSync(path.join(studyDir, 'preregistration.json'), 'utf8'));
  const canonicalHash = (value: unknown): string => {
    const canonical = (input: unknown): unknown => {
      if (Array.isArray(input)) return input.map(canonical);
      if (input !== null && typeof input === 'object') {
        const entries = Object.entries(input as Record<string, unknown>).filter(([, v]) => v !== undefined);
        return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, canonical(v)]));
      }
      return input;
    };
    return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
  };
  return {
    schema: 'challenge-stage-authorization.v1',
    stage: 'R',
    status: 'APPROVED',
    purpose: 'isolated BDD fixture — no real host, no model calls',
    studyId,
    suiteHash: suite.suiteHash,
    mappingHash: mapping.mappingHash,
    graderHash: canonicalHash(scoring),
    studyPlanHash: canonicalHash(prereg),
    requestedActorIdentity: 'synthetic-bdd-fixture-actor',
    executionMode: 'F2-real-host',
    arms: ['A', 'B'],
    cases: (suite.cases as { caseId: string }[]).map((entry) => entry.caseId),
    repetitions: [String(manifest.repetitionsPerCase ?? 1)],
    attemptCap: 4,
    requestCap: 32,
    requestTimeoutMs: 240_000,
    maxRequestsPerAttempt: 8,
    isolationAcceptance: {
      realHostProbe: { status: 'PASSED', ticketId: 'synthetic-probe-ticket', evidenceRef: 'synthetic-probe-evidence (no real probe executed)', suiteHash: suite.suiteHash },
    },
    issuedBy: 'bdd-fixture',
    validFrom: new Date(Date.now() - 60_000).toISOString(),
    validUntil: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    revoked: false,
    halted: false,
  };
}

function resolveStudyRootsFromLab() {
  const labRoot = process.env.PD_EXAMINER_LAB_ROOT
    ? path.resolve(process.env.PD_EXAMINER_LAB_ROOT)
    : path.join(repoRoot, 'scripts', 'dev', 'principle-learning-lab');
  return resolveStudyRoots(labRoot, path.join(workspaceDir, '.pd', 'examiner'));
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-exm-bdd-'));
  workspaceDir = path.join(tempDir, 'workspace');
  studiesRoot = path.join(tempDir, 'studies');
  fs.mkdirSync(studiesRoot, { recursive: true });
  process.env.PD_EXAMINER_STUDIES_ROOT = studiesRoot;
  coupledTarget = false;
  res = undefined;
  body = undefined;
  lastStudyId = '';
});

afterEach(() => {
  delete process.env.PD_EXAMINER_STUDIES_ROOT;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

defineFeature(
  fs.readFileSync(resolveFeaturePath('docs/specs/features/examiner/examiner-evaluation-journey.feature'), 'utf8'),
  registry,
  // The async-contract scenarios compile six-case suites and poll console-run
  // settlement; a COLD vitest fork additionally pays the lab's dynamic-import
  // warm-up on the first study creation — 120s keeps isolated -t runs green.
  { it: (name, fn) => it(name, fn, 120_000) },
);
