/**
 * PRI-1147 Phase 5 — LLM 层故障注入实验（与真实语义运行严格分离）。
 *
 * ⚠️ 诚实标注：本脚本的全部故障都是受控注入（simulated_fault），绝不冒充真实
 * provider 行为。真实 provider 故障只有在真实调用中自然发生时才以
 * real_http_fault_observation 记录（例如真实 429/超时错误文本）。
 *
 * 故障注入点：LLM 分类器 seam。生产分类器 seam 的真实契约（实测
 * signal-classifier.ts:88-126 / signal-stage2-cycle.ts / 生产测试
 * signal-stage2-cycle.test.ts:205-266）：
 *   - createSignalLlmClassifier 返回的函数**从不 throw**：adapter 调用失败、
 *     HTTP 层故障（含 429/500/504）、超时、payload 不可用一律归一为 `null`
 *     （"无可用 verdict"）。因此生产忠实的 HTTP 故障注入形状是「返回 null」；
 *   - 若包装函数以 async 方式 reject，cycle 的 withTimeout 同样归一为 null
 *     （signal-stage2-cycle.ts:57-72 的 rejection 分支）；
 *   - 归一后的 null 会进入 recordPendingCorrectionReview(llmResult=null)
 *     → P-3 门判 pending_llm_error，**消耗一次 attempt**；settle 视为可重试
 *     verdict：清除 reviewResult、释放 claim，行回到 pending（绝不记成 NONE）；
 *   - 连续 STAGE2_MAX_ATTEMPTS(5) 次错误 → abandoned(llm_error)；
 *   - 真正「不消耗 attempt 的释放」只发生在：classifier 完全不可用（null）、
 *     预算耗尽、record 写入失败、同步 throw 被外层 catch 捕获
 *     （signal-stage2-cycle.ts:149-153/157-163/184-191/218-224）。
 *
 * 场景（全部经真实 hook 链创建 pending，恢复臂使用真实 ZAI classifier）：
 *   F-HTTP-429 / F-HTTP-500 / F-HTTP-504  simulated_http_fault（null 形状）+ async reject 形状
 *   F-TIMEOUT                             挂起超过 classificationTimeoutMs → withTimeout null
 *   F-INVALID-JSON / F-SCHEMA-INVALID /
 *   F-EMPTY-RESPONSE                      seam 只接收已验证结果或 null（adapter
 *                                         校验+修复后的形状），注入 null
 *   F-DUP-REQUEST                         同一 hook payload 重放 → 幂等收敛
 *   F-CONCURRENT-RETRY                    两个真实 cycle 并发抢 1 个 pending 行
 *   F-RESTART                             claim 后模拟进程重启：新鲜 claim 跳过 →
 *                                         陈旧 claim 接管（fencing）→ 真实恢复
 *
 * D-DEF1（ERR-191，已在生产代码修复）：signal-stage2-cycle.ts 曾以
 *   performance.now() 浮点差值计算分类超时，剩余预算 < classificationTimeoutMs
 *   时浮点值直达 AbortSignal.timeout → ERR_OUT_OF_RANGE → 分类器瞬时（<50ms，
 *   无网络往返）null → 消耗 attempt → 五轮后静默 abandoned(llm_error)。
 *   修复前签名由真实分类器确定性复现（证据：提交 f1797cb37 之前的一轮运行，
 *   见验收报告 §九/§十与 ERR-191 记录）。本脚本的 D-DEF1-postfix 场景现在是
 *   修复后回归：默认预算（不传 aggregateBudgetMs）下分类器必须收到正整数
 *   timeoutMs、真实请求必须进入网络（有真实延迟与判定）、行收敛到终态。
 *   其余场景同样使用生产默认预算；仅 F-TIMEOUT 保留 2s classificationTimeoutMs
 *   （该测试的目的就是超时形状本身）。
 *
 * Usage:
 *   node scripts/dev/pain-real-llm-bdd/run-fault-injection.mjs \
 *     --provider zai --model glm-5.3-flash --apiKeyEnv ZAI_API_KEY --reasoning low \
 *     [--run-id run-...] [--append]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import * as lib from './lib/chain-harness.mjs';
import { openRunContext, assertFreshOutputs, recordPhase, PHASES } from './lib/run-context.mjs';

const hostRuntime = await import('@principles/host-runtime');
const codexAdapter = await import('@principles/codex-adapter');
const coreRuntime = await import('@principles/core/runtime');

const {
  claimPendingCorrectionCandidates,
  recordPendingCorrectionReview,
  settlePendingCorrection,
  runStage2CorrectionCycle,
} = hostRuntime;
const { processHookInvocation } = codexAdapter;
const { STAGE2_MAX_ATTEMPTS } = coreRuntime;

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

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
  console.error(JSON.stringify({ ok: false, reason: 'missing_api_key_env', nextAction: `export ${apiKeyEnv} before running the fault-injection experiment.` }));
  process.exit(1);
}

const repoRoot = path.resolve(here, '..', '..', '..');
let runCtx;
try {
  runCtx = openRunContext({ runIdArg, resultsRoot, repoRoot, datasetPath: path.join(here, 'golden-dataset.json'), phaseInfo: { provider, model, apiKeyEnv } });
} catch (error) {
  console.error(JSON.stringify({ ok: false, reason: error.code ?? 'run_context_failed', details: String(error.message), nextAction: error.nextAction ?? 'inspect the run directory' }));
  process.exit(1);
}
const { runId, runDir, meta, metaPath } = runCtx;
const summaryFile = path.join(runDir, 'fault-injection.summary.json');
try {
  assertFreshOutputs({ runDir, outputs: [summaryFile], appendAuthorized });
} catch (error) {
  console.error(JSON.stringify({ ok: false, reason: error.code, details: String(error.message), nextAction: error.nextAction }));
  process.exit(1);
}

const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pri1147-fault-'));

const config = lib.buildWorkspaceConfig({
  provider, model, apiKeyEnv, timeoutMs, maxTokens,
  reasoning: reasoning === 'false' ? false : reasoning,
  ...(baseUrl ? { baseUrl } : {}),
});

const dataset = JSON.parse(fs.readFileSync(path.join(here, 'golden-dataset.json'), 'utf8'));
const a1 = dataset.samples.find((s) => s.sample_id === 'A1');

// ─── 记录结构 ────────────────────────────────────────────────────────────────

const checks = [];
function record(id, name, pass, evidence, extra = {}) {
  checks.push({ id, name, pass: pass === true, evidence: lib.safePreview(evidence, 900), ...extra });
  console.log(`[${pass === true ? 'PASS' : 'FAIL'}] ${id} ${name}`);
}
function blocked(id, name, reason, evidence) {
  checks.push({ id, name, pass: false, blocked: true, reason: lib.safePreview(reason, 400), evidence: lib.safePreview(evidence ?? null, 600) });
  console.log(`[BLOCKED] ${id} ${name}: ${reason}`);
}

/** 目录安全标签（Windows 禁止 `:` 等字符；不得影响场景 id 本身）。 */
function safeLabel(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'scenario';
}

/** 与 d6 脚本相同的 RAW hook 驱动（收集原始 stderr 备隐私扫描）。 */
async function driveHookRaw({ payload, workspaceDir, codexHome }) {
  const env = { ...process.env, CODEX_HOME: codexHome };
  const result = await processHookInvocation(JSON.stringify(payload), env, workspaceDir);
  return { exitCode: result.exitCode, stdout: result.stdout ?? {}, rawStderr: (result.stderr ?? []).map((l) => String(l)) };
}

function readRawMarker(workspaceDir, key) {
  const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT logical_observation_key, decision, reason, task_payload_json FROM governance_signal_admissions WHERE logical_observation_key = ?').get(key) ?? null;
    if (!row) return null;
    try { row.payload = JSON.parse(row.task_payload_json); } catch { row.payload = { unparseable: true }; }
    return row;
  } finally {
    db.close();
  }
}

/**
 * 经真实 hook 链创建一个 pending 环境（A1 ambiguous 样本），返回环境 + 逻辑键。
 */
async function bootstrapPending(label, text = a1.text) {
  const env = lib.bootstrapSampleEnv({ runRoot, sampleId: `fault-${safeLabel(label)}`, config });
  const ids = lib.sampleIds(label, 1);
  const payload = lib.buildUserPromptSubmitPayload({
    workspaceDir: env.workspaceDir,
    transcriptPath: env.transcriptPath,
    sessionId: ids.sessionId,
    turnId: ids.turnId,
    text,
  });
  const hook = await driveHookRaw({ payload, workspaceDir: env.workspaceDir, codexHome: env.codexHome });
  const key = `codex|${env.rolloutIdentity}|${ids.turnId}|user`;
  return { env, ids, payload, hook, key };
}

/**
 * 构造带故障注入的测量分类器：前 faultCalls 次调用按 fault 形状失败，
 * 之后委托真实分类器。同时保留真实调用测量；真实调用若自然发生
 * 429/限流类错误，记录为 real_http_fault_observation。
 */
function buildFaultClassifier(workspaceDir, { faultCalls, faultShape }) {
  const real = lib.buildMeasuredClassifier(workspaceDir);
  if (!real.ok) return real;
  let callCount = 0;
  const fn = async (text, options) => {
    callCount += 1;
    if (callCount <= faultCalls) {
      if (faultShape === 'null') return null;
      if (faultShape === 'reject') throw new Error('simulated_http_fault: 429 Too Many Requests (injected, not a real provider response)');
      if (faultShape === 'hang') {
        await new Promise(() => {}); // 永不 resolve；由 cycle 的 withTimeout 归一为 null
      }
    }
    const result = await real.fn(text, options);
    if (real.calls.length > 0) {
      const last = real.calls[real.calls.length - 1];
      if (last.error && /429|rate.?limit|too many requests/i.test(last.error)) {
        real.realHttpFaultObserved = last.error;
      }
    }
    return result;
  };
  return { ...real, fn, injectedCalls: () => Math.min(callCount, faultCalls) };
}

/**
 * 标准双臂场景：故障臂（faultCalls 次注入）→ 验证 pending 行存活与 attempt
 * 语义 → 恢复臂（真实分类器）→ 验证终态。绝不伪造 verdict。
 */
async function runTwoArmScenario({ id, faultLabel, faultShape, faultCalls = 1, classificationTimeoutMs = 60_000, text = a1.text }) {
  try {
    const { env, key } = await bootstrapPending(faultLabel, text);
    const faulted = buildFaultClassifier(env.workspaceDir, { faultCalls, faultShape });
    if (!faulted.ok) {
      blocked(id, `${faultLabel}: 故障臂`, `classifier 不可用: ${faulted.reason}`);
      return;
    }
    const faultedReport = await runStage2CorrectionCycle({
      workspaceDir: env.workspaceDir,
      classifier: faulted.fn,
      classifierState: 'used',
      // classificationTimeoutMs 仅在 F-TIMEOUT 场景有意收窄（该测试的目的就是
      // 超时形状）；aggregateBudgetMs 始终使用生产默认（P1-3，D-DEF1 已修复）。
      ...(classificationTimeoutMs !== 60_000 ? { classificationTimeoutMs } : {}),
    });
    const markerAfterFault = readRawMarker(env.workspaceDir, key);
    const attemptsAfterFault = markerAfterFault?.payload?.review?.attempts ?? null;
    const pendingSurvived = markerAfterFault?.decision === 'pending_llm_review'
      && attemptsAfterFault === faultCalls
      && lib.readPainCount(env.workspaceDir) === 0;
    record(`${id}-fault-arm`, `${faultLabel}: 故障臂 → 行存活为 pending，无 pain`, pendingSurvived, {
      fault_shape: faultShape,
      simulated: true,
      report: lib.safePreview(faultedReport, 400),
      decision: markerAfterFault?.decision ?? null,
      attemptsAfterFault,
      lastReason: markerAfterFault?.payload?.review?.lastReason ?? null,
      painCount: lib.readPainCount(env.workspaceDir),
      realSemanticsNote: 'null/reject/hang 经 withTimeout 归一为 null → record(null) → pending_llm_error，消耗一次 attempt；settle 视为可重试：清除 verdict、释放 claim',
    });

    const recovery = lib.buildMeasuredClassifier(env.workspaceDir);
    if (!recovery.ok) {
      blocked(`${id}-recovery-arm`, `${faultLabel}: 恢复臂`, `classifier 不可用: ${recovery.reason}`);
      return;
    }
    const cycles = await lib.runStage2UntilTerminal({ workspaceDir: env.workspaceDir, classifierWrap: recovery });
    const markerAfterRecovery = readRawMarker(env.workspaceDir, key);
    const painCount = lib.readPainCount(env.workspaceDir);
    const terminal = markerAfterRecovery?.decision === 'admitted' || markerAfterRecovery?.decision === 'resolved_none';
    const recoveryOk = terminal
      && (markerAfterRecovery.decision === 'admitted' ? painCount === 1 : painCount === 0);
    record(`${id}-recovery-arm`, `${faultLabel}: 恢复臂（真实分类器）→ 终态`, recoveryOk, {
      cycles: lib.safePreview(cycles, 500),
      decision: markerAfterRecovery?.decision ?? null,
      llmCalls: recovery.calls.length,
      verdicts: recovery.calls.map((c) => c.verdict ?? null),
      painCount,
      ...(faulted.realHttpFaultObserved ? { real_http_fault_observation: faulted.realHttpFaultObserved } : {}),
    });
  } catch (error) {
    blocked(id, faultLabel, String(error).slice(0, 300));
  }
}

const startedAt = new Date().toISOString();
console.log(`Fault injection experiment — provider=${provider} model=${model} apiKeyEnv=${apiKeyEnv}`);
console.log('DISCLAIMER: all faults below are simulated_fault (injected at the classifier seam); real provider faults are only recorded when they occur naturally.');

// ═══ F-HTTP-429 / 500 / 504（simulated_http_fault，null 形状 = 生产忠实形状）═══
await runTwoArmScenario({ id: 'F-HTTP-429', faultLabel: 'simulated_http_fault 429（null 形状）', faultShape: 'null' });
await runTwoArmScenario({ id: 'F-HTTP-429-REJECT', faultLabel: 'simulated_http_fault 429（async reject 形状）', faultShape: 'reject' });
await runTwoArmScenario({ id: 'F-HTTP-500', faultLabel: 'simulated_http_fault 500（null 形状）', faultShape: 'null' });
await runTwoArmScenario({ id: 'F-HTTP-504', faultLabel: 'simulated_http_fault 504（null 形状）', faultShape: 'null' });

// ═══ F-TIMEOUT ══════════════════════════════════════════════════════════════
// 挂起 30s >> classificationTimeoutMs=2000 → cycle 的 withTimeout 在 2s 归一
// null（不取消底层请求——生产语义，见 signal-stage2-cycle.ts:164-168 注释）。
await runTwoArmScenario({ id: 'F-TIMEOUT', faultLabel: 'simulated_timeout（挂起 30s / 周期超时 2s）', faultShape: 'hang', classificationTimeoutMs: 2_000 });

// ═══ F-INVALID-JSON / F-SCHEMA-INVALID / F-EMPTY-RESPONSE ═══════════════════
// adapter 在 seam 之前完成 schema 校验 + 一次修复（signal-classifier.ts:112-124），
// seam 收到的契约就是「已验证结果 | null」——三类载荷故障在该 seam 上同形。
// 诚实记录：三者在 cycle 层预期同语义（null → pending_llm_error → 可重试）。
await runTwoArmScenario({ id: 'F-INVALID-JSON', faultLabel: 'simulated_payload_fault: invalid JSON（seam=null 形状）', faultShape: 'null' });
await runTwoArmScenario({ id: 'F-SCHEMA-INVALID', faultLabel: 'simulated_payload_fault: schema invalid（seam=null 形状）', faultShape: 'null' });
await runTwoArmScenario({ id: 'F-EMPTY-RESPONSE', faultLabel: 'simulated_payload_fault: empty response（seam=null 形状）', faultShape: 'null' });

// ═══ F-DUP-REQUEST ══════════════════════════════════════════════════════════
// 同一 hook payload 原样重放：同 session/turn/rollout → 同逻辑键 → 幂等收敛。
try {
  const { env, key, payload } = await bootstrapPending('dup-request');
  await driveHookRaw({ payload, workspaceDir: env.workspaceDir, codexHome: env.codexHome });
  const db = new Database(path.join(env.workspaceDir, '.state', 'trajectory.db'), { readonly: true, fileMustExist: true });
  let markerRows;
  try {
    markerRows = db.prepare('SELECT logical_observation_key, decision FROM governance_signal_admissions').all();
  } finally {
    db.close();
  }
  const dupOk = markerRows.length === 1 && markerRows[0].decision === 'pending_llm_review' && markerRows[0].logical_observation_key === key;
  record('F-DUP-REQUEST', '重放同一 hook payload → 单 marker 幂等收敛', dupOk, {
    markerCount: markerRows.length,
    decisions: markerRows.map((m) => m.decision),
    logicalKey: key,
  });

  const measured = lib.buildMeasuredClassifier(env.workspaceDir);
  if (!measured.ok) {
    blocked('F-DUP-REQUEST-recovery', '重放后真实 cycle 恢复 → 恰一 pain', `classifier 不可用: ${measured.reason}`);
  } else {
    await lib.runStage2UntilTerminal({ workspaceDir: env.workspaceDir, classifierWrap: measured });
    const painCount = lib.readPainCount(env.workspaceDir);
    const final = readRawMarker(env.workspaceDir, key);
    record('F-DUP-REQUEST-recovery', '重放后真实 cycle 恢复 → 恰一 pain', final?.decision === 'admitted' && painCount === 1, {
      decision: final?.decision ?? null,
      painCount,
    });
  }
} catch (error) {
  blocked('F-DUP-REQUEST', '重放同一 hook payload 幂等收敛', String(error).slice(0, 300));
}

// ═══ F-CONCURRENT-RETRY ═════════════════════════════════════════════════════
// 两个真实 cycle 并发抢 1 个 pending 行：claim CAS 保证每轮恰一 cycle 工作
// （另一 cycle claimed=0、零 LLM 调用）。真实 provider 的瞬时故障（如连续真实
// 调用后的限流，表现为 seam no_verdict）会诚实走 pending_llm_error 可重试路径，
// 因此终态验证用后续恢复轮次完成——每轮都重新验证 CAS 恰一性，终态恰一 pain。
// P1-3：生产默认预算（D-DEF1 已修复，整数钳制，ERR-191）。
try {
  const { env, key } = await bootstrapPending('concurrent-retry');
  const c1 = lib.buildMeasuredClassifier(env.workspaceDir);
  const c2 = lib.buildMeasuredClassifier(env.workspaceDir);
  if (!c1.ok || !c2.ok) {
    blocked('F-CONCURRENT-RETRY', '两个真实 cycle 并发抢同一 pending 行', `classifier 不可用: ${!c1.ok ? c1.reason : c2.reason}`);
  } else {
    const [report1, report2] = await Promise.all([
      runStage2CorrectionCycle({ workspaceDir: env.workspaceDir, classifier: c1.fn, classifierState: 'used' }),
      runStage2CorrectionCycle({ workspaceDir: env.workspaceDir, classifier: c2.fn, classifierState: 'used' }),
    ]);
    const roundLlmCalls = c1.calls.length + c2.calls.length;
    const raceOk = report1.claimed + report2.claimed === 1
      && roundLlmCalls <= 1
      && lib.readPainCount(env.workspaceDir) <= 1;
    record('F-CONCURRENT-RETRY-race', '并发轮: claim CAS 恰一 cycle 工作（另一 claimed=0、零多余 LLM 调用）', raceOk, {
      report1: lib.safePreview(report1, 300),
      report2: lib.safePreview(report2, 300),
      roundLlmCalls,
      painCount: lib.readPainCount(env.workspaceDir),
    });

    // 恢复轮：真实分类器逐轮推进到终态（provider 瞬时 no_verdict 会被生产
    // 重试语义消化；每轮仍是单 cycle，不引入新的并发面）。
    let finalDecision = null;
    const recoveryCycles = [];
    for (let round = 0; round < STAGE2_MAX_ATTEMPTS + 2; round += 1) {
      const report = await runStage2CorrectionCycle({ workspaceDir: env.workspaceDir, classifier: c1.fn, classifierState: 'used', classificationTimeoutMs: 60_000 });
      recoveryCycles.push({ round: round + 1, claimed: report.claimed, admitted: report.admitted, resolvedNone: report.resolvedNone, abandoned: report.abandoned, stillPending: report.stillPending });
      finalDecision = readRawMarker(env.workspaceDir, key)?.decision ?? null;
      if (finalDecision === 'admitted' || finalDecision === 'resolved_none' || finalDecision === 'abandoned') break;
      await new Promise((resolve) => setTimeout(resolve, 3000)); // provider 友好的间隔，不改变任何生产行为
    }
    const painCount = lib.readPainCount(env.workspaceDir);
    const callStatuses = c1.calls.map((c) => c.status);
    const noVerdictCount = callStatuses.filter((s) => s === 'no_verdict').length;
    const painConsistent = (finalDecision === 'admitted') ? painCount === 1 : painCount === 0;
    if (finalDecision === 'admitted' || finalDecision === 'resolved_none') {
      record('F-CONCURRENT-RETRY-recovery', '恢复轮: 真实分类器推进到终态，恰一 pain、无重复', painConsistent, {
        finalDecision,
        painCount,
        recoveryCycles,
        callStatuses,
        llmCallsTotal: c1.calls.length,
      });
    } else if (finalDecision === 'abandoned' && noVerdictCount === callStatuses.length && callStatuses.length > 0) {
      // 全部真实调用都是 no_verdict（provider 瞬时故障窗口，例如真实限流）：
      // 生产行为正确（5 次真实尝试 → abandoned(llm_error)，绝不记 NONE），
      // 但恢复语义未被真实验证——按约定标 blocked，不伪造 pass。
      blocked('F-CONCURRENT-RETRY-recovery', '恢复轮: 真实分类器推进到终态，恰一 pain、无重复',
        `provider_no_verdict_window: ${callStatuses.length}/${callStatuses.length} 次真实调用无 verdict（生产行为正确：abandoned(llm_error)，可重跑本场景）`, {
        finalDecision,
        painCount,
        recoveryCycles,
        callStatuses,
        llmCalls: c1.calls,
      });
    } else {
      record('F-CONCURRENT-RETRY-recovery', '恢复轮: 真实分类器推进到终态，恰一 pain、无重复', false, {
        finalDecision,
        painCount,
        recoveryCycles,
        callStatuses,
        honestNote: 'abandoned 且非全 no_verdict = 真实低置信/错误终态，如实记为未达预期恢复',
      });
    }
  }
} catch (error) {
  blocked('F-CONCURRENT-RETRY', '两个真实 cycle 并发抢同一 pending 行', String(error).slice(0, 300));
}

// ═══ F-RESTART ══════════════════════════════════════════════════════════════
// claim 后模拟进程崩溃重启（不释放 claim）：
//   1) 新 cycle（真实时钟语义：claim 新鲜 <10min）跳过该行（claimed=0，无丢失）；
//   2) now=+11min（> PENDING_REVIEW_CLAIM_TTL_MS=10min，模块内常量）→
//      陈旧 claim 被接管（新 fencing token）；旧 token 的写入被 CAS 拒绝
//      （concurrent_loss，fencing 证明）；真实分类器 → record → settle → admitted。
try {
  const { env, key } = await bootstrapPending('restart');
  const claimed = claimPendingCorrectionCandidates({ workspaceDir: env.workspaceDir, limit: 1 });
  const held = claimed.ok ? claimed.candidates[0] : null;
  if (!claimed.ok || !held || held.claimToken === null) {
    blocked('F-RESTART', 'claim 后进程重启：陈旧 claim 接管 + fencing', `claim 失败: ${lib.safePreview(claimed, 200)}`);
  } else {
    // 1) 新 cycle（不传 now = 真实时钟）：旧 claim 新鲜 → 跳过，无丢失。
    const freshCycle = lib.buildMeasuredClassifier(env.workspaceDir);
    if (!freshCycle.ok) {
      blocked('F-RESTART', 'claim 后进程重启：陈旧 claim 接管 + fencing', `classifier 不可用: ${freshCycle.reason}`);
    } else {
      const freshReport = await runStage2CorrectionCycle({
        workspaceDir: env.workspaceDir,
        classifier: freshCycle.fn,
        classifierState: 'used',
        classificationTimeoutMs: 60_000,
      });
      const freshSkipped = freshReport.claimed === 0
        && freshCycle.calls.length === 0
        && readRawMarker(env.workspaceDir, key)?.decision === 'pending_llm_review';
      record('F-RESTART-fresh-claim-skip', '重启模拟: 新鲜 claim 被新 cycle 跳过（无重复工作、无丢失）', freshSkipped, {
        report: lib.safePreview(freshReport, 300),
        llmCalls: freshCycle.calls.length,
      });

      // 2) now = 持 claim 时刻 + 11min → 陈旧 claim 接管。
      const claimedAtMs = Date.parse(held.claimedAt ?? '') || Date.now();
      const takeover = claimPendingCorrectionCandidates({
        workspaceDir: env.workspaceDir,
        limit: 1,
        now: new Date(claimedAtMs + 11 * 60 * 1000),
      });
      const taken = takeover.ok ? takeover.candidates[0] : null;
      const takeoverOk = takeover.ok && taken !== null && taken.claimToken !== null && taken.claimToken !== held.claimToken;
      record('F-RESTART-takeover', '重启模拟: now=+11min 陈旧 claim 被接管（新 fencing token）', takeoverOk, {
        oldClaimTokenPrefix: held.claimToken.slice(0, 8),
        newClaimTokenPrefix: taken?.claimToken ? taken.claimToken.slice(0, 8) : null,
        expired: takeover.ok ? takeover.expired : null,
      });

      if (takeoverOk) {
        // fencing 证明：旧 token 的写入被拒绝（concurrent_loss），旧结果不覆盖新状态。
        const staleWrite = recordPendingCorrectionReview({
          workspaceDir: env.workspaceDir,
          logicalObservationKey: held.logicalObservationKey,
          claimToken: held.claimToken,
          llmResult: null, // 旧进程的"迟到写入"；即使是错误形状也必须被 fencing 拒绝
        });
        const fencingOk = staleWrite.ok === true && staleWrite.disposition === 'concurrent_loss';
        record('F-RESTART-fencing', '重启模拟: 旧 claim token 的迟到写入被 CAS 拒绝（concurrent_loss）', fencingOk, {
          staleWrite: lib.safePreview(staleWrite, 300),
        });

        // 真实恢复：新 token + 真实分类器 → record → settle → admitted。
        const llmResult = await freshCycle.fn(taken.text, { timeoutMs: 60_000 });
        const recorded = recordPendingCorrectionReview({
          workspaceDir: env.workspaceDir,
          logicalObservationKey: taken.logicalObservationKey,
          claimToken: taken.claimToken,
          llmResult,
        });
        const settled = await settlePendingCorrection({
          workspaceDir: env.workspaceDir,
          logicalObservationKey: taken.logicalObservationKey,
          claimToken: taken.claimToken,
          now: new Date(claimedAtMs + 11 * 60 * 1000),
        });
        const final = readRawMarker(env.workspaceDir, key);
        const painCount = lib.readPainCount(env.workspaceDir);
        const recovered = settled.ok === true
          && settled.disposition === 'admitted'
          && final?.decision === 'admitted'
          && painCount === 1;
        record('F-RESTART-recovery', '重启模拟: 接管后真实分类器恢复 → admitted（无丢失、无重复 pain）', recovered, {
          recorded: lib.safePreview(recorded, 250),
          settled: lib.safePreview(settled, 250),
          realVerdict: lib.safePreview(freshCycle.calls[0]?.verdict ?? null, 200),
          decision: final?.decision ?? null,
          painCount,
        });
      }
    }
  }
} catch (error) {
  blocked('F-RESTART', 'claim 后进程重启：陈旧 claim 接管 + fencing', String(error).slice(0, 300));
}

// ═══ D-DEF1-postfix（修复后回归：默认预算下整数超时 + 真实网络调用）═════════
// 历史（保留的修复前证据，详见验收报告 §九/§十 + ERR-191）：修复前
// runStage2CorrectionCycle 默认预算(60s==60s)下 remaining 为浮点 →
// AbortSignal.timeout 抛 ERR_OUT_OF_RANGE → 分类器 <50ms 瞬时 null（无网络）
// → 消耗 attempt → 五轮后静默 abandoned(llm_error)。该签名曾在真实分类器下
// 确定性复现（提交 f1797cb37 之前的一轮 fault 运行记录）。
// 现在验证修复后的生产行为：不传 aggregateBudgetMs（生产默认），分类器必须
// 收到【正整数】timeoutMs，真实请求必须进入网络（有真实延迟与判定），
// pending 行在默认预算下收敛到终态。
try {
  const { env, key } = await bootstrapPending('def1-postfix-regression');
  const measured = lib.buildMeasuredClassifier(env.workspaceDir);
  if (!measured.ok) {
    blocked('D-DEF1-postfix-integer-timeout', '修复后回归: 默认预算下分类器收到正整数 timeoutMs', `classifier 不可用: ${measured.reason}`);
    blocked('D-DEF1-postfix-real-network', '修复后回归: 真实 provider 请求进入网络（非瞬时 no_verdict）', `classifier 不可用: ${measured.reason}`);
  } else {
    const report = await runStage2CorrectionCycle({
      workspaceDir: env.workspaceDir,
      classifier: measured.fn,
      classifierState: 'used',
      // 刻意不传 aggregateBudgetMs/classificationTimeoutMs：生产默认预算
    });
    const marker = readRawMarker(env.workspaceDir, key);
    const calls = measured.calls;
    const integerTimeouts = calls.length > 0
      && calls.every((c) => Number.isInteger(c.timeout_ms) && c.timeout_ms > 0);
    record('D-DEF1-postfix-integer-timeout', '修复后回归: 默认预算下分类器收到正整数 timeoutMs（ERR-191 修复）', integerTimeouts, {
      receivedTimeouts: calls.map((c) => c.timeout_ms),
      report: lib.safePreview(report, 300),
      honestLabel: 'post_fix_regression — D-DEF1 已修复（f1797cb37 / ERR-191）',
    });

    const firstCall = calls[0] ?? null;
    const realNetwork = firstCall !== null
      && firstCall.status === 'ok'
      && firstCall.latencyMs >= 200
      && firstCall.verdict !== undefined;
    record('D-DEF1-postfix-real-network', '修复后回归: 默认预算下真实 provider 请求进入网络（ok + 真实延迟 + 判定）', realNetwork, {
      firstCall,
      latencyThresholdMs: 200,
      instantFailureSignature: 'no_verdict 且 <50ms（修复前签名）不得出现',
    });

    const terminal = marker?.decision === 'admitted' || marker?.decision === 'resolved_none' || marker?.decision === 'abandoned';
    record('D-DEF1-postfix-terminal', '修复后回归: 默认预算下 pending 行收敛到终态（不再静默 abandoned(llm_error)）', terminal && marker?.decision !== 'abandoned', {
      decision: marker?.decision ?? null,
      attempts: marker?.payload?.review?.attempts ?? null,
      painCount: lib.readPainCount(env.workspaceDir),
    });
  }
} catch (error) {
  blocked('D-DEF1-postfix-integer-timeout', '修复后回归: 默认预算下分类器收到正整数 timeoutMs', String(error).slice(0, 300));
  blocked('D-DEF1-postfix-real-network', '修复后回归: 真实 provider 请求进入网络', String(error).slice(0, 300));
  blocked('D-DEF1-postfix-terminal', '修复后回归: 默认预算下收敛到终态', String(error).slice(0, 300));
}

// ─── 汇总 ───────────────────────────────────────────────────────────────────

const passed = checks.filter((c) => c.pass === true).length;
const blockedCount = checks.filter((c) => c.blocked === true).length;
const failed = checks.filter((c) => c.pass === false && c.blocked !== true).length;
const summary = {
  ok: failed === 0 && blockedCount === 0 && passed === checks.length && checks.length > 0,
  run_id: runId,
  experiment: 'PRI-1147 Phase 5 — fault injection at the LLM classifier seam',
  honesty: {
    fault_mode: 'simulated_fault',
    disclaimer: '全部故障为受控注入（simulated），不冒充真实 provider 行为；真实 provider 故障仅在自然发生时以 real_http_fault_observation 记录',
    separation: '本脚本与真实语义运行（run-codex-chain / run-d6-pending）严格分离',
  },
  provider,
  model,
  api_key_env: apiKeyEnv,
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  totals: { checks: checks.length, passed, failed, blocked: blockedCount },
  stage2_max_attempts: STAGE2_MAX_ATTEMPTS,
  discovered_defects: [{
    id: 'D-DEF1',
    status: 'FIXED_IN_THIS_BRANCH',
    severity: 'P1（已修复）',
    area: 'packages/host-runtime/src/signal-stage2-cycle.ts → packages/principles-core/src/runtime/adapter/pi-ai-runtime-adapter.ts:680',
    symptom: '修复前：cycle 以 performance.now() 浮点差值计算分类超时，剩余预算 < classificationTimeoutMs 时 AbortSignal.timeout(浮点) 抛 ERR_OUT_OF_RANGE → 分类器瞬时 null（无网络往返）→ pending_llm_error 消耗 attempt → 五轮后静默 abandoned(llm_error)',
    historical_evidence: '修复前真实分类器确定性复现（<50ms no_verdict、attempt 消耗、120s 预算交叉验证正常）——证据保留在验收报告 §九/§十与 ERR-191',
    fix: '整数钳制（Math.floor）于生产者处 + host-runtime 回归测试（分类器收到整数 timeoutMs）+ 本脚本 D-DEF1-postfix 三个修复后回归检查',
    reference: 'ERR-191 / 提交 f1797cb37',
  }],
  checks,
  run_root: runRoot,
};
fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
recordPhase(metaPath, meta, PHASES.faultInjection, { finished_at: summary.finished_at, ok: summary.ok, totals: summary.totals });
console.log(JSON.stringify({ ok: summary.ok, totals: summary.totals, summary_file: summaryFile }, null, 2));
process.exit(summary.ok ? 0 : 1);
