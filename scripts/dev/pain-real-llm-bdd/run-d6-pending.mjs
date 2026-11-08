/**
 * PRI-1147 Phase 4 — D6 pending Stage-2 review lifecycle acceptance over the
 * REAL production chain with the REAL LLM classifier.
 *
 * 验收范围（SPEC-PD-PAIN-SEMANTICS v0.3.1 §4.4.8 / D6）：
 *   S1 创建   ambiguous 候选经真实 hook 链进入 pending_llm_review；
 *   S2 恢复   (a) claim → release（classifier 无 verdict 的生产语义：不消耗 attempts）
 *                → 真实 classifier cycle 恢复到终态；
 *             (b) 持久化 reviewResult 的崩溃恢复：record 后不传 claimToken 直接
 *                settlePendingCorrection（governance-signal-admission.ts 崩溃恢复路径）；
 *   S3 重试/预算  真实 classifier 最多 5 次 attempt（STAGE2_MAX_ATTEMPTS）；
 *                单 cycle 候选上限 = 2；
 *   S4 幂等   同一 payload 重放 + 同一 candidate 并发 admit 的收敛语义；
 *   S5 TTL    注入 now = createdAt + 72h + 1ms（PENDING_CANDIDATE_TTL_MS），
 *                claim 前置 TTL 作废 + 持久化 verdict 的 TTL 边界；绝不真实等待；
 *   S6 终态   终态 payload 恰好是 D6 最小字段集 {decision, reason, confidence,
 *                attempts, settledAt}，无 reviewResult/claimToken/trigger 残留；
 *   S7 隐私   mid-review pending payload 与 RAW hook stderr 的凭据泄漏扫描
 *                （运行时读取 env 值做子串匹配，绝不打印值本身）。
 *
 * 诚实性规则：
 *   - 不伪造任何 LLM 结果；所有 Stage-2 判定来自真实 provider 调用；
 *   - 时间控制一律通过生产函数原生 now 参数（构造 Date），零 sleep；
 *   - 检查失败如实记录（pass:false）；被 provider 阻塞的检查标 blocked。
 *
 * Usage:
 *   node scripts/dev/pain-real-llm-bdd/run-d6-pending.mjs \
 *     --provider zai --model glm-5.3-flash --apiKeyEnv ZAI_API_KEY --reasoning low
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { openRunContext, acquireRunLock, assertFreshOutputs, recordPhase, PHASES } from './lib/run-context.mjs';
import { fileURLToPath } from 'node:url';

import * as lib from './lib/chain-harness.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const hostRuntime = await import('@principles/host-runtime');
const codexAdapter = await import('@principles/codex-adapter');
const coreRuntime = await import('@principles/core/runtime');

const {
  admitGovernanceSignals,
  claimPendingCorrectionCandidates,
  recordPendingCorrectionReview,
  releasePendingCorrectionClaim,
  settlePendingCorrection,
  runStage2CorrectionCycle,
  ingestGovernanceObservations,
} = hostRuntime;
const { processHookInvocation } = codexAdapter;
const { PENDING_CANDIDATE_TTL_MS, STAGE2_MAX_ATTEMPTS } = coreRuntime;

const here = path.dirname(fileURLToPath(import.meta.url));
const dataset = JSON.parse(fs.readFileSync(path.join(here, 'golden-dataset.json'), 'utf8'));
const sampleById = new Map(dataset.samples.map((s) => [s.sample_id, s]));

// ─── CLI ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}
function argFlag(name) {
  return args.includes(name);
}

const provider = argValue('--provider', 'zai');
const model = argValue('--model', 'glm-5.3-flash');
const apiKeyEnv = argValue('--apiKeyEnv', 'ZAI_API_KEY');
const reasoning = argValue('--reasoning', 'low');
const baseUrl = argValue('--base-url', '');
const timeoutMs = Number(argValue('--timeout-ms', '60000'));
const maxTokens = Number(argValue('--max-tokens', '4096'));
const runIdArg = argValue('--run-id', null);
const appendAuthorized = argFlag('--append');
const resultsRoot = argValue('--results-root', path.join('.tmp', 'pri-1147'));

if (!process.env[apiKeyEnv]) {
  console.error(JSON.stringify({ ok: false, reason: 'missing_api_key_env', nextAction: `export ${apiKeyEnv} before running the real-LLM D6 acceptance.` }));
  process.exit(1);
}

const repoRoot = path.resolve(here, '..', '..', '..');
let runCtx;
try {
  runCtx = openRunContext({ runIdArg, resultsRoot, repoRoot, datasetPath: path.join(here, 'golden-dataset.json'), phaseInfo: { provider, model, apiKeyEnv } });
  acquireRunLock({ runDir: runCtx.runDir, runId: runCtx.runId, phase: PHASES.d6Pending });
} catch (error) {
  console.error(JSON.stringify({ ok: false, reason: error.code ?? 'run_context_failed', details: String(error.message), nextAction: error.nextAction ?? 'inspect the run directory' }));
  process.exit(1);
}
const { runId, runDir, meta, metaPath } = runCtx;
const summaryFile = path.join(runDir, 'd6-pending.summary.json');
try {
  assertFreshOutputs({ runDir, outputs: [summaryFile], appendAuthorized });
} catch (error) {
  console.error(JSON.stringify({ ok: false, reason: error.code, details: String(error.message), nextAction: error.nextAction }));
  process.exit(1);
}

const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pri1147-d6-'));

const config = lib.buildWorkspaceConfig({
  provider, model, apiKeyEnv, timeoutMs, maxTokens,
  reasoning: reasoning === 'false' ? false : reasoning,
  ...(baseUrl ? { baseUrl } : {}),
});

// ─── 记录结构 ────────────────────────────────────────────────────────────────

const checks = [];
function record(id, name, pass, evidence, extra = {}) {
  checks.push({ id, name, pass: pass === true, evidence: lib.safePreview(evidence, 900), ...extra });
  const mark = pass === true ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${id} ${name}`);
}

function blocked(id, name, reason, evidence) {
  checks.push({ id, name, pass: false, blocked: true, reason: lib.safePreview(reason, 400), evidence: lib.safePreview(evidence ?? null, 600) });
  console.log(`[BLOCKED] ${id} ${name}: ${reason}`);
}

/** 环境内的全部 admission marker（含原始 payload 文本，供 S6/S7 扫描）。 */
function readRawMarkers(workspaceDir) {
  const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT logical_observation_key, decision, reason, canonical_pain_id, task_payload_json, created_at, updated_at FROM governance_signal_admissions ORDER BY id').all();
  } finally {
    db.close();
  }
}

function readRawMarker(workspaceDir, key) {
  return readRawMarkers(workspaceDir).find((r) => r.logical_observation_key === key) ?? null;
}

function parsePayload(raw) {
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return { unparseable: true }; }
}

/**
 * RAW hook 驱动（不预先 redact）：供 S7 对原始 stderr 做凭据扫描；
 * 存储/输出前仍必须经 redactSecrets（与 lib.driveHook 的收集纪律一致）。
 */
async function driveHookRaw({ payload, workspaceDir, codexHome }) {
  const env = { ...process.env, CODEX_HOME: codexHome };
  const result = await processHookInvocation(JSON.stringify(payload), env, workspaceDir);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout ?? {},
    rawStderr: (result.stderr ?? []).map((line) => String(line)),
  };
}

// ─── S7 隐私扫描器 ──────────────────────────────────────────────────────────

function credentialScanTargets() {
  const names = ['ZAI_API_KEY', 'AMD_RADEON_API_KEY', 'DEEPSEEK_API_KEY'];
  const targets = [];
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.length >= 8) {
      targets.push({ kind: 'env_value', name, value });
    }
  }
  return targets;
}

function scanForCredentials(text) {
  const hits = [];
  for (const target of credentialScanTargets()) {
    if (text.includes(target.value)) hits.push({ kind: 'env_value', name: target.name });
  }
  if (/Bearer\s+[A-Za-z0-9._\-]{8,}/.test(text)) hits.push({ kind: 'bearer_token' });
  if (/sk-[A-Za-z0-9]{16,}/.test(text)) hits.push({ kind: 'sk_literal' });
  return hits;
}

// ─── 公共步骤 ───────────────────────────────────────────────────────────────

/** 经真实 hook 链创建一个 pending 候选，返回 {env, key, ids}。 */
async function admitPendingViaHook({ sampleId, text, learnedKeywords = null, envLabel }) {
  const env = lib.bootstrapSampleEnv({
    runRoot,
    sampleId: `d6-${envLabel}`,
    config,
    learnedKeywords,
  });
  const ids = lib.sampleIds(sampleId, 1);
  const payload = lib.buildUserPromptSubmitPayload({
    workspaceDir: env.workspaceDir,
    transcriptPath: env.transcriptPath,
    sessionId: ids.sessionId,
    turnId: ids.turnId,
    text,
  });
  const hook = await driveHookRaw({ payload, workspaceDir: env.workspaceDir, codexHome: env.codexHome });
  const key = `codex|${env.rolloutIdentity}|${ids.turnId}|user`;
  return { env, ids, payload, hook, key, rawStderr: hook.rawStderr };
}

function buildCandidate({ key, text, env, ids, observedAt }) {
  return {
    kind: 'user_correction',
    hostKind: 'codex',
    logicalObservationKey: key,
    rolloutIdentity: env.rolloutIdentity,
    rootSessionId: ids.sessionId,
    hostTurnId: ids.turnId,
    text,
    observedAt,
  };
}

const startedAt = new Date().toISOString();
console.log(`D6 pending acceptance — provider=${provider} model=${model} apiKeyEnv=${apiKeyEnv}`);
console.log(`run_root=${runRoot}`);

// ═══ S1 创建 ════════════════════════════════════════════════════════════════
// A1 是 dataset 冻结的 ambiguous 样本（stage2_via_pending）：经真实 hook 链
// （processHookInvocation → ingestion → admission）必须产生 pending_llm_review。
let s1 = null;
try {
  const a1 = sampleById.get('A1');
  s1 = await admitPendingViaHook({ sampleId: 'A1', text: a1.text, envLabel: 's1' });
  const markers = readRawMarkers(s1.env.workspaceDir);
  const pendingRows = markers.filter((m) => m.decision === 'pending_llm_review');
  const pass = markers.length === 1 && pendingRows.length === 1;
  record('S1', '创建: ambiguous 样本经真实链进入 pending_llm_review', pass, {
    logicalKey: s1.key,
    markerCount: markers.length,
    decisions: markers.map((m) => m.decision),
    hookExitCode: s1.hook.exitCode,
    payloadPreview: lib.safePreview(parsePayload(pendingRows[0]?.task_payload_json), 500),
  });
} catch (error) {
  blocked('S1', '创建: ambiguous 样本经真实链进入 pending_llm_review', String(error).slice(0, 300));
}

// ═══ S2 恢复 ════════════════════════════════════════════════════════════════
// 生产语义注记（governance-signal-admission.ts / signal-stage2-cycle.ts 实测）：
// - cycle 内 classifier **不可用**（classifier=null）或预算耗尽 → releaseClaim，
//   不消耗 attempts（signal-stage2-cycle.ts:157-163）；
// - cycle 内 classifier 返回 null / 超时 / async 拒绝 → withTimeout 归一为 null
//   → recordPendingCorrectionReview(llmResult=null) → P-3 门判 pending_llm_error，
//   **消耗一次 attempt**，settle 因可重试 verdict 清除 reviewResult 并释放 claim，
//   行回到 pending（生产测试 signal-stage2-cycle.test.ts:205/252 同语义）。
// S2(a) 验证的是前者：release 路径不消耗 attempts，随后真实 cycle 恢复。
if (s1) {
  try {
    const claimed = claimPendingCorrectionCandidates({ workspaceDir: s1.env.workspaceDir, limit: 1 });
    const candidate = claimed.ok ? claimed.candidates[0] : null;
    if (!claimed.ok || !candidate || candidate.claimToken === null) {
      blocked('S2a', '恢复(a): claim → release 不消耗 attempts，真实 cycle 恢复', `claim 失败: ${lib.safePreview(claimed, 200)}`);
    } else {
      const released = releasePendingCorrectionClaim({
        workspaceDir: s1.env.workspaceDir,
        logicalObservationKey: candidate.logicalObservationKey,
        claimToken: candidate.claimToken,
      });
      const afterRelease = parsePayload(readRawMarker(s1.env.workspaceDir, s1.key)?.task_payload_json);
      const releaseClean = released.ok === true
        && released.released === true
        && released.reason === 'released'
        && afterRelease?.review?.attempts === 0
        && afterRelease?.review?.claimToken === undefined
        && afterRelease?.review?.claimedAt === undefined
        && readRawMarker(s1.env.workspaceDir, s1.key)?.decision === 'pending_llm_review';
      record('S2a-release', '恢复(a): release 清除 claim 且不消耗 attempts', releaseClean, {
        released: released.ok ? { released: released.released, reason: released.reason } : released,
        attemptsAfterRelease: afterRelease?.review?.attempts ?? null,
        decisionAfterRelease: readRawMarker(s1.env.workspaceDir, s1.key)?.decision ?? null,
      });

      // cycle 级交叉验证：classifier 不可用的 cycle 同样只释放、不消耗 attempt。
      // P1-3：生产默认预算（不传 aggregateBudgetMs/classificationTimeoutMs）。
      const unavailableCycle = await runStage2CorrectionCycle({
        workspaceDir: s1.env.workspaceDir,
        classifier: null,
        classifierState: 'unavailable',
      });
      const afterUnavailable = parsePayload(readRawMarker(s1.env.workspaceDir, s1.key)?.task_payload_json);
      record('S2a-cycle-unavailable', '恢复(a): classifier 不可用的真实 cycle 释放且 attempts 不变',
        unavailableCycle.claimed === 1 && unavailableCycle.skipped === 1
        && unavailableCycle.stillPending === 0
        && afterUnavailable?.review?.attempts === 0
        && readRawMarker(s1.env.workspaceDir, s1.key)?.decision === 'pending_llm_review',
        { report: lib.safePreview(unavailableCycle, 400), attempts: afterUnavailable?.review?.attempts ?? null });

      // 真实 classifier cycle 恢复到终态（admitted 或 resolved_none，由模型如实决定）。
      const measured = lib.buildMeasuredClassifier(s1.env.workspaceDir);
      if (!measured.ok) {
        blocked('S2a-recover', '恢复(a): 真实 classifier cycle 恢复到终态', `classifier 不可用: ${measured.reason}`);
      } else {
        const cycles = await lib.runStage2UntilTerminal({ workspaceDir: s1.env.workspaceDir, classifierWrap: measured });
        const finalMarker = readRawMarker(s1.env.workspaceDir, s1.key);
        const state = lib.readAdmissionState(s1.env.workspaceDir, s1.key);
        const terminal = finalMarker?.decision === 'admitted' || finalMarker?.decision === 'resolved_none';
        record('S2a-recover', '恢复(a): 真实 classifier cycle 恢复到终态', terminal, {
          cycles, finalDecision: finalMarker?.decision ?? null,
          llmCalls: measured.calls.length, llmSummary: measured.summary(),
          painCreated: state.pain !== null,
        });
      }
    }
  } catch (error) {
    blocked('S2a', '恢复(a): claim → release 不消耗 attempts，真实 cycle 恢复', String(error).slice(0, 300));
  }
} else {
  blocked('S2a', '恢复(a): claim → release 不消耗 attempts，真实 cycle 恢复', 'S1 未产出 pending 环境');
}

// S2(b): 持久化 reviewResult 的崩溃恢复 —— record（消耗 attempt、落盘 verdict）
// 之后模拟进程崩溃：不释放 claim、不落 claimToken 直接 settlePendingCorrection。
try {
  const a1 = sampleById.get('A1');
  const env2 = await admitPendingViaHook({ sampleId: 'A1', text: a1.text, envLabel: 's2b' });
  const claimed = claimPendingCorrectionCandidates({ workspaceDir: env2.env.workspaceDir, limit: 1 });
  const candidate = claimed.ok ? claimed.candidates[0] : null;
  if (!claimed.ok || !candidate || candidate.claimToken === null) {
    blocked('S2b', '恢复(b): 持久化 reviewResult 的无 token 崩溃恢复', `claim 失败: ${lib.safePreview(claimed, 200)}`);
  } else {
    const measured = lib.buildMeasuredClassifier(env2.env.workspaceDir);
    if (!measured.ok) {
      blocked('S2b', '恢复(b): 持久化 reviewResult 的无 token 崩溃恢复', `classifier 不可用: ${measured.reason}`);
    } else {
      // 真实 LLM 调用——verdict 不伪造。
      const llmResult = await measured.fn(candidate.text, { timeoutMs: 60_000 });
      const recorded = recordPendingCorrectionReview({
        workspaceDir: env2.env.workspaceDir,
        logicalObservationKey: candidate.logicalObservationKey,
        claimToken: candidate.claimToken,
        llmResult,
      });
      const midPayload = parsePayload(readRawMarker(env2.env.workspaceDir, env2.key)?.task_payload_json);
      const recordOk = recorded.ok === true
        && recorded.disposition === 'pending'
        && midPayload?.review?.attempts === 1
        && midPayload?.review?.reviewResult !== undefined;
      record('S2b-record', '恢复(b): record 持久化真实 verdict（attempt=1）', recordOk, {
        recorded: lib.safePreview(recorded, 300),
        durableReviewResult: lib.safePreview(midPayload?.review?.reviewResult ?? null, 300),
        llmCall: lib.safePreview(measured.calls[0] ?? null, 300),
      });

      // 崩溃模拟：不传 claimToken（governance-signal-admission.ts 的崩溃恢复语义：
      // 已持久化的 reviewResult 是唯一权威证据，任何后继都可以完成 settle）。
      const settled = await settlePendingCorrection({
        workspaceDir: env2.env.workspaceDir,
        logicalObservationKey: candidate.logicalObservationKey,
      });
      const finalMarker = readRawMarker(env2.env.workspaceDir, env2.key);
      const verdict = midPayload?.review?.reviewResult?.verdict ?? null;
      const expectedDecision = verdict === 'correction' ? 'admitted' : verdict === 'none' ? 'resolved_none' : null;
      const settleOk = settled.ok === true
        && expectedDecision !== null
        && finalMarker?.decision === expectedDecision
        && (expectedDecision === 'admitted' ? lib.readPainCount(env2.env.workspaceDir) === 1 : true);
      record('S2b-settle', '恢复(b): 无 token settle 从持久化 reviewResult 完成终态', settleOk, {
        settled: lib.safePreview(settled, 300),
        durableVerdict: verdict,
        finalDecision: finalMarker?.decision ?? null,
        painCount: lib.readPainCount(env2.env.workspaceDir),
      });
    }
  }
} catch (error) {
  blocked('S2b', '恢复(b): 持久化 reviewResult 的无 token 崩溃恢复', String(error).slice(0, 300));
}

// ═══ S3 重试/预算 ═══════════════════════════════════════════════════════════
// 真实 classifier 驱动到 STAGE2_MAX_ATTEMPTS：模型连续低置信/无 verdict 时
// attempts 逐次 +1、第 5 次尝试后 abandoned；模型首次即高置信 correction 时
// 直接 admitted —— 两种都是诚实结果，按实际发生记录。
try {
  const a1 = sampleById.get('A1');
  const env3 = await admitPendingViaHook({ sampleId: 'A1', text: a1.text, envLabel: 's3-budget' });
  const measured = lib.buildMeasuredClassifier(env3.env.workspaceDir);
  if (!measured.ok) {
    blocked('S3-budget', '重试/预算: 真实 classifier 的 attempt 上限语义', `classifier 不可用: ${measured.reason}`);
  } else {
    const cycles = await lib.runStage2UntilTerminal({
      workspaceDir: env3.env.workspaceDir,
      classifierWrap: measured,
      maxCycles: STAGE2_MAX_ATTEMPTS,
    });
    const finalMarker = readRawMarker(env3.env.workspaceDir, env3.key);
    const attemptsUsed = measured.calls.length;
    const terminal = finalMarker?.decision === 'admitted' || finalMarker?.decision === 'abandoned';
    const consistent = terminal
      && (finalMarker.decision === 'admitted'
        ? attemptsUsed <= STAGE2_MAX_ATTEMPTS
        : attemptsUsed === STAGE2_MAX_ATTEMPTS
          && (finalMarker.reason === 'low_confidence' || finalMarker.reason === 'llm_error'));
    record('S3-budget', '重试/预算: 真实 classifier 的 attempt 上限语义（≤5 次尝试后终态）', consistent, {
      cycles,
      finalDecision: finalMarker?.decision ?? null,
      finalReason: finalMarker?.reason ?? null,
      attemptsUsed,
      stage2MaxAttempts: STAGE2_MAX_ATTEMPTS,
      llmCalls: measured.calls,
      honestNote: 'admitted=模型首次即高置信；abandoned=模型连续低置信/无 verdict 达 5 次',
    });
  }
} catch (error) {
  blocked('S3-budget', '重试/预算: 真实 classifier 的 attempt 上限语义', String(error).slice(0, 300));
}

// S3 单 cycle 候选上限：3 个 pending 行，一个真实 cycle 最多 claim 2 个。
try {
  const capSamples = ['A1', 'F4', 'F5'];
  const envCap = lib.bootstrapSampleEnv({ runRoot, sampleId: 'd6-s3-cap', config });
  const keys = [];
  for (const sid of capSamples) {
    const sample = sampleById.get(sid);
    const ids = lib.sampleIds(sid, keys.length + 1);
    const payload = lib.buildUserPromptSubmitPayload({
      workspaceDir: envCap.workspaceDir,
      transcriptPath: envCap.transcriptPath,
      sessionId: ids.sessionId,
      turnId: ids.turnId,
      text: sample.text,
    });
    await driveHookRaw({ payload, workspaceDir: envCap.workspaceDir, codexHome: envCap.codexHome });
    keys.push(`codex|${envCap.rolloutIdentity}|${ids.turnId}|user`);
  }
  const before = readRawMarkers(envCap.workspaceDir).filter((m) => m.decision === 'pending_llm_review');
  const measured = lib.buildMeasuredClassifier(envCap.workspaceDir);
  if (!measured.ok || before.length !== 3) {
    blocked('S3-cap', '重试/预算: 单 cycle 候选上限 = 2', !measured.ok ? `classifier 不可用: ${measured.reason}` : `pending 行数=${before.length}`);
  } else {
    const report = await runStage2CorrectionCycle({
      workspaceDir: envCap.workspaceDir,
      classifier: measured.fn,
      classifierState: 'used',
      // P1-3：生产默认预算。D-DEF1 已在生产代码修复（整数钳制，ERR-191），
      // 默认预算下分类超时为整数毫秒，见 run-fault-injection.mjs D-DEF1-postfix。
    });
    const after = readRawMarkers(envCap.workspaceDir);
    const stillPending = after.filter((m) => m.decision === 'pending_llm_review');
    const classifiedOk = report.degradations.length === 0;
    const pass = report.claimed <= 2 && stillPending.length >= 1 && classifiedOk;
    record('S3-cap', '重试/预算: 单 cycle 候选上限 = 2，剩余候选保持 pending', pass, {
      claimed: report.claimed,
      pendingBefore: before.length,
      decisionsAfter: after.map((m) => m.decision),
      stillPendingKeys: stillPending.map((m) => m.logical_observation_key),
      remainingStillPending: stillPending.length,
      cycleDegradations: report.degradations,
      ...(classifiedOk ? {} : { honestNote: 'cycle 出现降级——若为 D-DEF1 签名见 run-fault-injection.mjs 的缺陷记录' }),
    });
  }
} catch (error) {
  blocked('S3-cap', '重试/预算: 单 cycle 候选上限 = 2', String(error).slice(0, 300));
}

// ═══ S4 幂等 ════════════════════════════════════════════════════════════════
// 同一 hook payload 重放：同 session/turn/rollout → 同 logical key。
// pending 阶段重放 → duplicate 标记、无第二行；admitted 之后重放 →
// already_admitted 且 pain_events 仍为 1（canonical_pain_id 唯一索引兜底）。
try {
  const a1 = sampleById.get('A1');
  const env4 = await admitPendingViaHook({ sampleId: 'A1', text: a1.text, envLabel: 's4-idem' });
  const first = lib.readAdmissionState(env4.env.workspaceDir, env4.key);
  // 完全相同的 payload 原样重放。
  await driveHookRaw({ payload: env4.payload, workspaceDir: env4.env.workspaceDir, codexHome: env4.env.codexHome });
  const afterReplay = lib.readAdmissionState(env4.env.workspaceDir, env4.key);
  const markersAfterReplay = readRawMarkers(env4.env.workspaceDir);
  const replayOk = markersAfterReplay.length === 1
    && afterReplay.marker?.decision === 'pending_llm_review'
    && first.marker?.decision === 'pending_llm_review'
    && lib.readPainCount(env4.env.workspaceDir) === 0;
  record('S4-replay-pending', '幂等: pending 阶段重放同一 payload 收敛（无第二行、无 pain）', replayOk, {
    markerCount: markersAfterReplay.length,
    decision: afterReplay.marker?.decision ?? null,
    painCount: lib.readPainCount(env4.env.workspaceDir),
  });

  // 真实 Stage-2 → admitted（或诚实终态），再重放一次 → already_admitted / 终态收敛。
  const measured = lib.buildMeasuredClassifier(env4.env.workspaceDir);
  if (!measured.ok) {
    blocked('S4-replay-admitted', '幂等: admitted 后重放收敛为 already_admitted 且 pain 不翻倍', `classifier 不可用: ${measured.reason}`);
  } else {
    await lib.runStage2UntilTerminal({ workspaceDir: env4.env.workspaceDir, classifierWrap: measured });
    const afterStage2 = lib.readAdmissionState(env4.env.workspaceDir, env4.key);
    await driveHookRaw({ payload: env4.payload, workspaceDir: env4.env.workspaceDir, codexHome: env4.env.codexHome });
    const markersFinal = readRawMarkers(env4.env.workspaceDir);
    const replayAdmittedOk = markersFinal.length === 1
      && afterStage2.marker?.decision === 'admitted'
      && lib.readPainCount(env4.env.workspaceDir) === 1;
    record('S4-replay-admitted', '幂等: admitted 后重放收敛为 already_admitted 且 pain 不翻倍', replayAdmittedOk, {
      markerCount: markersFinal.length,
      decisionAfterStage2: afterStage2.marker?.decision ?? null,
      painCount: lib.readPainCount(env4.env.workspaceDir),
    });

    // 并发 admit（同一 candidate 两次 admitGovernanceSignals）：admission 是同步
    // 函数，同进程 Promise.all 实际串行执行 —— 本检查验证的是 marker/UNIQUE 兜底
    // 的收敛语义（跨进程真并发由 canonical_pain_id 唯一索引 + CAS 承担，已在
    // F-CONCURRENT-RETRY 用异步 cycle 验证），如实标注。
    // 准入前置事实：直连 admitGovernanceSignals 的 candidate 必须有已持久化的
    // governance_observations 行（rc-6 生产语义：无真实行为证据的自动信号按
    // ingress 判 abandoned，P1 review round 3）——经生产 ingestion API 先落观测。
    const env4b = lib.bootstrapSampleEnv({ runRoot, sampleId: 'd6-s4-concurrent', config });
    const a2 = sampleById.get('A2'); // STRONG 直达样本 → 直接 admitted
    const ids = lib.sampleIds('A2', 1);
    const keyB = `codex|${env4b.rolloutIdentity}|${ids.turnId}|user`;
    const candidate = buildCandidate({ key: keyB, text: a2.text, env: env4b, ids, observedAt: new Date().toISOString() });
    const ingested = ingestGovernanceObservations({
      workspaceDir: env4b.workspaceDir,
      rollout: { hostKind: 'codex', rolloutIdentity: env4b.rolloutIdentity, rootSessionId: ids.sessionId },
      observations: [{
        hostKind: 'codex',
        rolloutIdentity: env4b.rolloutIdentity,
        rootSessionId: ids.sessionId,
        hostTurnId: ids.turnId,
        kind: 'user_turn',
        logicalObservationKey: keyB,
        visibleText: a2.text,
        source: 'live_hook',
        completeness: 'complete',
        observedAt: candidate.observedAt,
      }],
    });
    if (!ingested.ok || ingested.inserted < 1) {
      blocked('S4-concurrent', '幂等: 同一 candidate 并发 admit 收敛（恰一 pain）', `observation ingest 失败: ${lib.safePreview(ingested, 250)}`);
    } else {
      const [r1, r2] = await Promise.all([
        Promise.resolve().then(() => admitGovernanceSignals({ workspaceDir: env4b.workspaceDir, candidates: [candidate] })),
        Promise.resolve().then(() => admitGovernanceSignals({ workspaceDir: env4b.workspaceDir, candidates: [candidate] })),
      ]);
      const dispositions = [];
      for (const r of [r1, r2]) {
        if (r.ok) dispositions.push(...r.outcomes.map((o) => o.disposition));
        else dispositions.push(`degraded:${r.reason}`);
      }
      const painCountB = lib.readPainCount(env4b.workspaceDir);
      const concurrentOk = r1.ok && r2.ok
        && dispositions.filter((d) => d === 'admitted').length === 1
        && dispositions.filter((d) => d === 'already_admitted' || d === 'pending_llm_review').length >= 1
        && painCountB === 1;
      record('S4-concurrent', '幂等: 同一 candidate 并发 admit 收敛（恰一 pain）', concurrentOk, {
        dispositions,
        painCount: painCountB,
        observationIngested: ingested.inserted,
        honestNote: '同进程串行收敛验证；真并发竞态由 canonical_pain_id 唯一索引 + marker CAS 承担',
      });
    }
  }
} catch (error) {
  blocked('S4', '幂等: 重放/并发收敛', String(error).slice(0, 300));
}

// ═══ S5 TTL ═════════════════════════════════════════════════════════════════
// 注入 now = createdAt + 72h + 1ms（PENDING_CANDIDATE_TTL_MS）：
// (a) claim 前置 TTL：候选在任何 LLM 工作之前被 abandoned(ttl_expired)；
// (b) TTL 边界前的 claim 正常成功（对照）；
// (c) 持久化 reviewResult 后 TTL 过期才 settle → abandoned(ttl_expired)，
//     即使 verdict 是真实 correction（迟到的纠正不再是可信证据）。
try {
  const a1 = sampleById.get('A1');
  const env5a = await admitPendingViaHook({ sampleId: 'A1', text: a1.text, envLabel: 's5a-ttl' });
  const createdAtMs = Date.parse(readRawMarker(env5a.env.workspaceDir, env5a.key)?.created_at ?? '');
  if (!Number.isFinite(createdAtMs)) {
    blocked('S5', 'TTL: 注入时钟的 claim 前置作废与迟到 settle 边界', '无法读取 pending 行 created_at');
  } else {
    const justBeforeTtl = new Date(createdAtMs + PENDING_CANDIDATE_TTL_MS - 60_000);
    const claimBefore = claimPendingCorrectionCandidates({ workspaceDir: env5a.env.workspaceDir, limit: 1, now: justBeforeTtl });
    const claimedBefore = claimBefore.ok && claimBefore.candidates.length === 1 && claimBefore.expired === 0;
    // 释放对照 claim，避免污染后续断言。
    if (claimedBefore && claimBefore.candidates[0].claimToken !== null) {
      releasePendingCorrectionClaim({
        workspaceDir: env5a.env.workspaceDir,
        logicalObservationKey: claimBefore.candidates[0].logicalObservationKey,
        claimToken: claimBefore.candidates[0].claimToken,
      });
    }
    record('S5a-before-ttl', 'TTL: 边界前 1 分钟 claim 正常成功（对照）', claimedBefore, {
      claimedAt: justBeforeTtl.toISOString(),
      candidates: claimBefore.ok ? claimBefore.candidates.length : null,
      expired: claimBefore.ok ? claimBefore.expired : null,
    });

    const beyondTtl = new Date(createdAtMs + PENDING_CANDIDATE_TTL_MS + 1);
    const claimAfter = claimPendingCorrectionCandidates({ workspaceDir: env5a.env.workspaceDir, limit: 1, now: beyondTtl });
    const markerAfter = readRawMarker(env5a.env.workspaceDir, env5a.key);
    const expiredOk = claimAfter.ok
      && claimAfter.expired === 1
      && claimAfter.candidates.length === 0
      && markerAfter?.decision === 'abandoned'
      && markerAfter?.reason === 'ttl_expired';
    record('S5a-ttl-claim', 'TTL: now=TTL+1ms 时 claim 前置作废 abandoned(ttl_expired)', expiredOk, {
      now: beyondTtl.toISOString(),
      expired: claimAfter.ok ? claimAfter.expired : null,
      decision: markerAfter?.decision ?? null,
      reason: markerAfter?.reason ?? null,
      ttlMs: PENDING_CANDIDATE_TTL_MS,
    });

    // (c) 持久化 verdict 后 TTL 过期才 settle。
    const env5b = await admitPendingViaHook({ sampleId: 'A1', text: a1.text, envLabel: 's5b-ttl' });
    const claimed = claimPendingCorrectionCandidates({ workspaceDir: env5b.env.workspaceDir, limit: 1 });
    const candidate = claimed.ok ? claimed.candidates[0] : null;
    if (!claimed.ok || !candidate || candidate.claimToken === null) {
      blocked('S5b', 'TTL: 持久化 verdict 后迟到 settle 被 TTL 边界废弃', `claim 失败: ${lib.safePreview(claimed, 200)}`);
    } else {
      const measured = lib.buildMeasuredClassifier(env5b.env.workspaceDir);
      if (!measured.ok) {
        blocked('S5b', 'TTL: 持久化 verdict 后迟到 settle 被 TTL 边界废弃', `classifier 不可用: ${measured.reason}`);
      } else {
        const llmResult = await measured.fn(candidate.text, { timeoutMs: 60_000 });
        recordPendingCorrectionReview({
          workspaceDir: env5b.env.workspaceDir,
          logicalObservationKey: candidate.logicalObservationKey,
          claimToken: candidate.claimToken,
          llmResult,
        });
        const createdAt5b = Date.parse(readRawMarker(env5b.env.workspaceDir, env5b.key)?.created_at ?? '');
        const settled = await settlePendingCorrection({
          workspaceDir: env5b.env.workspaceDir,
          logicalObservationKey: candidate.logicalObservationKey,
          claimToken: candidate.claimToken,
          now: new Date(createdAt5b + PENDING_CANDIDATE_TTL_MS + 1),
        });
        const marker5b = readRawMarker(env5b.env.workspaceDir, env5b.key);
        const ttlSettleOk = settled.ok === true
          && settled.disposition === 'abandoned'
          && settled.reason === 'ttl_expired'
          && marker5b?.decision === 'abandoned'
          && marker5b?.reason === 'ttl_expired'
          && lib.readPainCount(env5b.env.workspaceDir) === 0;
        record('S5b-ttl-settle', 'TTL: 迟到的真实 verdict 仍被 TTL 边界废弃（不产生 pain）', ttlSettleOk, {
          settled: lib.safePreview(settled, 300),
          realVerdictBeforeTtlSettle: lib.safePreview(measured.calls[0]?.verdict ?? null, 200),
          decision: marker5b?.decision ?? null,
          painCount: lib.readPainCount(env5b.env.workspaceDir),
        });
      }
    }
  }
} catch (error) {
  blocked('S5', 'TTL: 注入时钟的 claim 前置作废与迟到 settle 边界', String(error).slice(0, 300));
}

// ═══ S6 终态最小 payload ════════════════════════════════════════════════════
// D6 最小化：终态 payload 恰好 {decision, reason, confidence, attempts,
// settledAt}，无 reviewResult / claimToken / trigger.text / pain_id 残留。
try {
  const terminalFields = ['attempts', 'confidence', 'decision', 'reason', 'settledAt'];
  const scanned = [];
  for (const dir of fs.readdirSync(runRoot)) {
    const ws = path.join(runRoot, dir, 'ws');
    if (!fs.existsSync(path.join(ws, '.state', 'trajectory.db'))) continue;
    for (const row of readRawMarkers(ws)) {
      if (row.decision !== 'resolved_none' && row.decision !== 'abandoned') continue;
      const payload = parsePayload(row.task_payload_json);
      const keys = payload && typeof payload === 'object' && !Array.isArray(payload) ? Object.keys(payload).sort() : null;
      scanned.push({
        workspace: dir,
        decision: row.decision,
        keySet: keys,
        exactMatch: keys !== null && keys.length === terminalFields.length && terminalFields.every((f) => keys.includes(f)),
        residue: payload ? Object.keys(payload).filter((k) => ['reviewResult', 'claimToken', 'claimedAt', 'trigger', 'review', 'pain_id', 'task_payload'].includes(k)) : [],
      });
    }
  }
  const withTerminal = scanned.filter((s) => s.decision === 'resolved_none' || s.decision === 'abandoned');
  const allExact = withTerminal.length > 0 && withTerminal.every((s) => s.exactMatch && s.residue.length === 0);
  record('S6', '终态: 终态 payload 恰为 D6 最小字段集（无分类细节残留）', allExact, {
    terminalRowCount: withTerminal.length,
    rows: scanned,
    expectedKeySet: terminalFields,
  });
} catch (error) {
  blocked('S6', '终态: 终态 payload 恰为 D6 最小字段集', String(error).slice(0, 300));
}

// ═══ S7 隐私 ════════════════════════════════════════════════════════════════
// (a) mid-review pending payload：无 env 凭据值、无 Bearer/sk 字面量、
//     trigger.text 经过 sanitize（有界、不超原文）；
// (b) RAW hook stderr（redact 之前）：无凭据值（config 只引用 env NAME，
//     泄漏只可能来自 adapter 错误消息——如实扫描并记录）。
try {
  const a1 = sampleById.get('A1');
  const env7 = await admitPendingViaHook({ sampleId: 'A1', text: a1.text, envLabel: 's7-privacy' });
  const rawMarker = readRawMarker(env7.env.workspaceDir, env7.key);
  const payloadHits = scanForCredentials(rawMarker?.task_payload_json ?? '');
  const payload = parsePayload(rawMarker?.task_payload_json);
  const triggerText = payload?.trigger?.text ?? null;
  const sanitizedOk = typeof triggerText === 'string'
    && triggerText.length <= Math.max(a1.text.length, 1000)
    && scanForCredentials(triggerText).length === 0;
  record('S7-payload', '隐私: pending payload 无凭据值且 trigger.text 有界净化', payloadHits.length === 0 && sanitizedOk, {
    credentialHits: payloadHits,
    triggerTextLength: typeof triggerText === 'string' ? triggerText.length : null,
    originalTextLength: a1.text.length,
    scannedScopes: ['task_payload_json'],
  });

  const rawStderrText = env7.rawStderr.join('\n');
  const stderrHits = scanForCredentials(rawStderrText);
  // stderr 存储前仍然 redact（与 lib.driveHook 纪律一致）。
  const stderrForRecord = env7.rawStderr.map((line) => lib.redactSecrets(line));
  record('S7-stderr', '隐私: RAW hook stderr 无凭据泄漏（redact 前扫描）', stderrHits.length === 0, {
    credentialHits: stderrHits,
    stderrLineCount: env7.rawStderr.length,
    stderrRedacted: stderrForRecord,
    honestNote: 'config 仅引用 env NAME；此扫描针对 adapter 运行期错误消息的意外泄漏',
  });
} catch (error) {
  blocked('S7', '隐私: payload 与 RAW stderr 凭据扫描', String(error).slice(0, 300));
}

// ─── 汇总 ───────────────────────────────────────────────────────────────────

const passed = checks.filter((c) => c.pass === true).length;
const blockedCount = checks.filter((c) => c.blocked === true).length;
const failed = checks.filter((c) => c.pass === false && c.blocked !== true).length;
const summary = {
  ok: failed === 0 && blockedCount === 0 && passed === checks.length && checks.length > 0,
  run_id: runId,
  experiment: 'PRI-1147 Phase 4 — D6 pending lifecycle acceptance (real-LLM)',
  provider,
  model,
  api_key_env: apiKeyEnv,
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  totals: { checks: checks.length, passed, failed, blocked: blockedCount },
  stage2_max_attempts: STAGE2_MAX_ATTEMPTS,
  pending_candidate_ttl_ms: PENDING_CANDIDATE_TTL_MS,
  budget_note: '全部直接 cycle 调用使用生产默认预算（不传 aggregateBudgetMs/classificationTimeoutMs）；D-DEF1 已在生产代码修复（ERR-191），修复后回归见 run-fault-injection.mjs 的 D-DEF1-postfix 场景',
  checks,
  run_root: runRoot,
};
fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
recordPhase(metaPath, meta, PHASES.d6Pending, { finished_at: summary.finished_at, ok: summary.ok, totals: summary.totals });
console.log(JSON.stringify({ ok: summary.ok, totals: summary.totals, summary_file: summaryFile }, null, 2));
process.exit(summary.ok ? 0 : 1);
