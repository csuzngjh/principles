/**
 * PRI-1147 — OpenClaw host 子集：经真实 SignalCollectorHost seam（插件 I/O 外壳）
 * 驱动 10 个 golden 样本，LLM 判定来自真实 provider（ZAI）。
 *
 * 生产接线还原（prompt.ts getSignalCollectorHost 的隔离环境等价物）：
 *   - SignalCollectorHost ← packages/openclaw-plugin/dist/core/signal-collector-host.js
 *     （包根只导出 initTrajectorySchema；exports map 无深路径，按 dist 文件 URL 导入，
 *      路径全部由脚本位置相对推导，无硬编码绝对路径）；
 *   - llmClassifier ← createSignalLlmClassifierFromConfig(wctx)：从 ws/.pd/config.yaml
 *     的 signalCollector pi-ai profile 解析（与 Codex/WorkBuddy worker 同一共享实现），
 *     外层包一层 per-call 测量，保持插件 2 参签名 (text, promptTemplate)；
 *   - keywordStoreProvider ← createLiveSignalKeywordStore(wctx).resolve()（P0-B live 词库，
 *     learned cues 无需重启生效；G1 的学习词经 .state/correction_keywords.json 预置）；
 *   - wctx = { workspaceDir, stateDir, trajectory: 真实 TrajectoryDatabase,
 *     evolutionReducer: 真实 EvolutionReducerImpl } —— 检测/路由/持久化全部走真实 seam；
 *     STRONG 分流后的 emitPainDetectedEvent 漏斗（PainToPrincipleService）在隔离 workspace
 *     上真实执行，若 OpenClaw 运行时专属环节不可构造则按 rc-9 如实记录边界（不伪造）。
 *
 * 每样本记录：Stage-1（user_turns cue/correctionDetected）、LLM 调用（延迟/verdict）、
 * 路由结果（STRONG 直发 / Stage-2 确认后分流 / 判 none / 低置信或无 verdict 入队
 * signal_confirmations）、漏斗证据（成功 = state.db diagnostician 任务 +
 * memory/evolution.jsonl 事件；降级/拒绝 = memory/logs/SYSTEM_*.log 的
 * SIGNAL_* / PAIN_* 事件）。
 *
 * 诚实性：样本级 pass 判据只看 seam 的确定性路由行为（expected_stage 是否匹配观测路由）；
 * LLM 语义判定（correction/none）如实记录为观测值，不因语义不符而伪造 pass。
 *
 * Usage:
 *   node scripts/dev/pain-real-llm-bdd/run-openclaw-host.mjs \
 *     --provider zai --model glm-5.3-flash --apiKeyEnv ZAI_API_KEY --reasoning low
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL, fileURLToPath } from 'node:url';

import * as lib from './lib/chain-harness.mjs';
import { openRunContext, acquireRunLock, assertFreshOutputs, recordPhase, PHASES } from './lib/run-context.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const worktreeRoot = path.resolve(here, '..', '..', '..');

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
const pollSeconds = Number(argValue('--poll-seconds', '90'));

if (!process.env[apiKeyEnv]) {
  console.error(JSON.stringify({ ok: false, reason: 'missing_api_key_env', nextAction: `export ${apiKeyEnv} before running the OpenClaw host subset.` }));
  process.exit(1);
}

let runCtx;
try {
  runCtx = openRunContext({ runIdArg, resultsRoot, repoRoot: worktreeRoot, datasetPath: path.join(here, 'golden-dataset.json'), phaseInfo: { provider, model, apiKeyEnv } });
  acquireRunLock({ runDir: runCtx.runDir, runId: runCtx.runId, phase: PHASES.openclawHost });
} catch (error) {
  console.error(JSON.stringify({ ok: false, reason: error.code ?? 'run_context_failed', details: String(error.message), nextAction: error.nextAction ?? 'inspect the run directory' }));
  process.exit(1);
}
const { runId, runDir, meta, metaPath } = runCtx;

// ─── 插件 dist 深路径导入（包根 exports map 不提供深路径；按文件 URL 导入） ───

const distDir = path.join(worktreeRoot, 'packages', 'openclaw-plugin', 'dist', 'core');
async function importDist(fileName) {
  const file = path.join(distDir, fileName);
  if (!fs.existsSync(file)) {
    throw new Error(`openclaw-plugin dist missing: ${fileName}. nextAction: build the worktree (root npm run build) so packages/openclaw-plugin/dist is present.`);
  }
  return import(pathToFileURL(file).href);
}

const { TrajectoryDatabase } = await importDist('trajectory.js');
const { EvolutionReducerImpl } = await importDist('evolution-reducer.js');
const { SignalCollectorHost, DEFAULT_SIGNAL_CONFIG, createSignalLlmClassifierFromConfig } = await importDist('signal-collector-host.js');
const { createLiveSignalKeywordStore } = await importDist('signal-keyword-store.js');

const dataset = JSON.parse(fs.readFileSync(path.join(here, 'golden-dataset.json'), 'utf8'));

// PRI-1150 review P2-G: fingerprint the ACTUALLY EXECUTED dist artifacts —
// the git commit SHA alone cannot prove a fix is in the running code.
const crypto = await import('node:crypto');
const distFingerprint = Object.fromEntries(
  ['signal-collector-host.js', 'trajectory.js', 'evolution-reducer.js', 'signal-keyword-store.js'].map((fileName) => {
    const file = path.join(distDir, fileName);
    return [fileName, fs.existsSync(file)
      ? 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
      : 'missing'];
  }),
);
const sampleById = new Map(dataset.samples.map((s) => [s.sample_id, s]));

const SUBSET = ['A1', 'A2', 'A6', 'B1', 'B4', 'C1', 'C4', 'D2', 'G1', 'H4'];

// ─── 运行环境 ────────────────────────────────────────────────────────────────

const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pri1147-openclaw-'));
const resultsFile = path.join(runDir, 'openclaw-host.jsonl');
const summaryFile = path.join(runDir, 'openclaw-host.summary.json');
try {
  assertFreshOutputs({ runDir, outputs: [resultsFile, summaryFile], appendAuthorized });
} catch (error) {
  console.error(JSON.stringify({ ok: false, reason: error.code, details: String(error.message), nextAction: error.nextAction }));
  process.exit(1);
}

const config = lib.buildWorkspaceConfig({
  provider, model, apiKeyEnv, timeoutMs, maxTokens,
  reasoning: reasoning === 'false' ? false : reasoning,
  ...(baseUrl ? { baseUrl } : {}),
});

const startedAt = new Date().toISOString();
console.log(`OpenClaw host subset — provider=${provider} model=${model} apiKeyEnv=${apiKeyEnv}`);
console.log(`run_root=${runRoot}`);

// ─── 证据读取 ────────────────────────────────────────────────────────────────

const require = (await import('node:module')).createRequire(import.meta.url);
const Database = require('better-sqlite3');

function openTrajectoryReadonly(workspaceDir) {
  return new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true, fileMustExist: true });
}

function readUserTurns(workspaceDir, sessionId) {
  const db = openTrajectoryReadonly(workspaceDir);
  try {
    return db.prepare('SELECT id, session_id, turn_index, raw_excerpt, correction_detected, correction_cue, created_at FROM user_turns WHERE session_id = ? ORDER BY id').all(sessionId);
  } finally {
    db.close();
  }
}

function readSignalConfirmations(workspaceDir, sessionId) {
  const db = openTrajectoryReadonly(workspaceDir);
  try {
    return db.prepare('SELECT id, session_id, user_turn_rowid, occurrence_id, excerpt, terms_json, suggested_type, status, attempts, created_at, resolved_at, resolution FROM signal_confirmations WHERE session_id = ? ORDER BY id').all(sessionId);
  } finally {
    db.close();
  }
}

/**
 * 漏斗证据（实测：emitPainDetectedEvent 成功路径在 PAIN_* 日志层是静默的——
 * 它的真实持久化是 state.db 的 diagnostician 任务 + memory/evolution.jsonl 事件；
 * PAIN_* 日志只在 refuse/observation_only/degrade/failed 时出现）。
 */
function readDiagnosticianTaskCount(workspaceDir) {
  const dbPath = path.join(workspaceDir, '.pd', 'state.db');
  if (!fs.existsSync(dbPath)) return 0;
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind = 'diagnostician'").get()?.n ?? 0;
  } catch (error) {
    // PRI-1150 review P1-D: a READ FAILURE is "unknown" (null) — never a
    // silent 0 that reads a failed write as "no pain emitted". (A missing db
    // file above stays a legitimate 0 for a fresh workspace.)
    console.error(`[openclaw-host] diagnostician task count read failed: ${lib.redactSecrets(String(error).slice(0, 200))}`);
    return null;
  } finally {
    try { db?.close(); } catch { /* best effort */ }
  }
}

function readEvolutionPainEventCount(workspaceDir) {
  const file = path.join(workspaceDir, 'memory', 'evolution.jsonl');
  if (!fs.existsSync(file)) return 0;
  try {
    let count = 0;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.includes('"pain_detected"')) count += 1;
    }
    return count;
  } catch (error) {
    console.error(`[openclaw-host] evolution pain event count read failed: ${lib.redactSecrets(String(error).slice(0, 200))}`);
    return null;
  }
}

/** SYSTEM 日志（memory/logs/SYSTEM_YYYY-MM-DD.log）中与本实验相关的事件行。 */
function readSystemLogEvents(workspaceDir) {
  const logsDir = path.join(workspaceDir, 'memory', 'logs');
  if (!fs.existsSync(logsDir)) return [];
  const events = [];
  for (const file of fs.readdirSync(logsDir)) {
    if (!file.startsWith('SYSTEM_') || !file.endsWith('.log')) continue;
    const text = fs.readFileSync(path.join(logsDir, file), 'utf8');
    for (const line of text.split('\n')) {
      if (/^\[[^\]]+\] \[(SIGNAL_|PAIN_|EVOLUTION_|TRIGGER_)/.test(line.trim())) {
        events.push(lib.redactSecrets(line.trim().slice(0, 400)));
      }
    }
  }
  return events;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询异步路由完成：LLM 调用出现 → 再等落库宽限期；上限 pollSeconds。 */
async function waitForRouting(measured, expectLlm) {
  const deadline = Date.now() + pollSeconds * 1000;
  while (Date.now() < deadline) {
    if (!expectLlm || measured.calls.length > 0) break;
    await sleep(250);
  }
  // 落库/回写/漏斗是调用完成后的同步 SQLite 写 + fire-and-forget 异步漏斗，
  // 给一个固定的收敛宽限期再读证据（不改变任何生产行为）。
  await sleep(2500);
}

// ─── 单样本驱动 ──────────────────────────────────────────────────────────────

const learnedSampleIds = new Set(dataset.samples.filter((s) => s.category === 'G').map((s) => s.sample_id));
const records = [];
let index = 0;

for (const sampleId of SUBSET) {
  index += 1;
  const sample = sampleById.get(sampleId);
  if (!sample) {
    records.push({ sample_id: sampleId, error: 'sample_missing_in_dataset' });
    continue;
  }
  const record = {
    sample_id: sampleId,
    category: sample.category,
    text: sample.text,
    input_hash: lib.sha256(sample.text),
    provider,
    model,
    api_key_env: apiKeyEnv,
    expected: { label: sample.expected_label, stage: sample.expected_stage, final: sample.expected_final },
    started_at: new Date().toISOString(),
    seam: 'openclaw SignalCollectorHost (real) + real TrajectoryDatabase + real EvolutionReducerImpl + real provider LLM',
  };
  try {
    const env = lib.bootstrapSampleEnv({
      runRoot,
      sampleId: `openclaw-${sampleId}`,
      config,
      learnedKeywords: learnedSampleIds.has(sampleId) ? dataset.learnedKeywordsSeed : null,
    });
    const stateDir = path.join(env.workspaceDir, '.state');
    const trajectory = new TrajectoryDatabase({ workspaceDir: env.workspaceDir });
    const evolutionReducer = new EvolutionReducerImpl({ workspaceDir: env.workspaceDir, stateDir });
    const wctx = { workspaceDir: env.workspaceDir, stateDir, trajectory, evolutionReducer };

    // 生产 live 词库 provider（seed ∪ learned，mtime 重载）。
    const liveStore = createLiveSignalKeywordStore(wctx);

    // 真实分类器：从 ws/.pd/config.yaml 解析（createSignalLlmClassifierFromConfig），
    // 外层 per-call 测量，保持插件 2 参签名。
    const pluginClassifier = createSignalLlmClassifierFromConfig(wctx, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
    if (!pluginClassifier) {
      record.error = 'classifier_unresolved_from_config';
      record.completed_at = new Date().toISOString();
      records.push(record);
      fs.appendFileSync(resultsFile, JSON.stringify(record) + '\n');
      console.log(`[${String(index).padStart(2, '0')}/${SUBSET.length}] ${sampleId} → classifier_unresolved`);
      trajectory.dispose();
      continue;
    }
    const calls = [];
    const measuredClassifier = async (text, promptTemplate) => {
      const startedAtCall = Date.now();
      let result = null;
      let errorText = null;
      try {
        result = await pluginClassifier(text, promptTemplate);
      } catch (error) {
        errorText = String(error).slice(0, 200);
      }
      calls.push({
        latency_ms: Date.now() - startedAtCall,
        status: errorText !== null ? 'threw' : result === null ? 'no_verdict' : 'ok',
        ...(result ? { verdict: { is_feedback: result.is_feedback, type: result.type, confidence: result.confidence, reason: lib.redactSecrets(String(result.reason ?? '')).slice(0, 200) } } : {}),
        ...(errorText ? { error: lib.redactSecrets(errorText) } : {}),
      });
      return result;
    };

    const host = new SignalCollectorHost(wctx, {
      llmClassifier: measuredClassifier,
      keywordStoreProvider: () => liveStore.resolve(),
      config: DEFAULT_SIGNAL_CONFIG,
    });

    const sessionId = `sess-openclaw-${sampleId.toLowerCase()}`;
    host.detectSync(sample.text, sessionId, 'user', { turnIndex: 1 });
    await waitForRouting({ calls }, sample.expected_stage === 'stage2_via_pending' || sample.expected_stage === 'stage1_no_hit_reject');

    const turns = readUserTurns(env.workspaceDir, sessionId);
    const turn = turns[0] ?? null;
    const confirmations = readSignalConfirmations(env.workspaceDir, sessionId);
    const logEvents = readSystemLogEvents(env.workspaceDir);
    const diagnosticianTasks = readDiagnosticianTaskCount(env.workspaceDir);
    const evolutionPainEvents = readEvolutionPainEventCount(env.workspaceDir);

    const llmCalls = calls.length;
    const verdicts = calls.filter((c) => c.verdict).map((c) => c.verdict);
    // PRI-1150 review P1-D: "reached Stage 2" requires a REAL dispatched call —
    // thrown calls are transport failures, not Stage-2 evidence.
    const realDispatch = calls.some((c) => c.status === 'ok' || c.status === 'no_verdict');
    const strongDirect = turn?.correction_detected === 1 && llmCalls === 0;
    const reachedStage2 = realDispatch;
    // 漏斗完成的真实证据 = state.db 的 diagnostician 任务（成功路径静默，见上）。
    let emitted = diagnosticianTasks !== null && diagnosticianTasks >= 1;
    const queuedForBatch = confirmations.length > 0;

    let observedRouting;
    if (strongDirect) observedRouting = 'stage1_strong_direct_emit';
    else if (reachedStage2 && emitted) observedRouting = 'stage2_confirmed_emit';
    else if (reachedStage2 && queuedForBatch) observedRouting = 'stage2_queued_for_batch_confirmation';
    else if (reachedStage2) observedRouting = 'stage2_none_no_emit';
    else if ((turn?.correction_cue ?? null) === null) observedRouting = 'no_hit';
    else observedRouting = 'unrouted';

    // seam 确定性路由判据（LLM 语义判定另记为观测值）：
    //   stage1_strong_direct → STRONG 直发（correctionDetected=1 且零 LLM 调用）；
    //   stage2_via_pending   → 至少一次真实 Stage-2 调用；
    //   stage1_no_hit_reject → Stage-1 无 cue（OpenClaw 的 discovery 调用是设计行为）。
    let seamPass;
    if (sample.expected_stage === 'stage1_strong_direct') seamPass = strongDirect;
    else if (sample.expected_stage === 'stage2_via_pending') seamPass = reachedStage2 && !strongDirect;
    else seamPass = (turn?.correction_cue ?? null) === null;
    // PRI-1150 review P1-D: a MISSING trajectory turn row is an ingestion/read
    // anomaly — it must fail the sample (record.error → summary ok=false)
    // instead of silently satisfying the no-hit branch (null === null).
    if (turn === null) {
      record.error = 'trajectory turn row missing for this sample — ingestion or read anomaly; no-hit/pass conclusions are unavailable';
      seamPass = false;
    }
    // Count-read failures (null) are unknown facts: they must fail the sample
    // rather than read a failed write as "no pain emitted".
    if (diagnosticianTasks === null || evolutionPainEvents === null) {
      record.error = record.error
        ?? 'diagnostician/evolution funnel counts unreadable (state.db read failure) — pain-emission conclusions are unavailable';
      emitted = false;
    }

    record.observed = {
      routing: observedRouting,
      stage1: { correction_detected: turn?.correction_detected ?? null, correction_cue: turn?.correction_cue ?? null },
      llm_calls: llmCalls,
      llm: calls,
      signal_confirmations: confirmations,
      routing_events: logEvents,
      funnel: {
        diagnostician_tasks: diagnosticianTasks,
        evolution_pain_events: evolutionPainEvents,
        degradation_log_events: logEvents.filter((l) => l.includes('[PAIN_') || l.includes('SIGNAL_EMIT_FAIL')),
      },
      pain_funnel_observed: emitted,
    };
    record.seam_pass = seamPass === true;
    record.semantic_observation = {
      llm_verdicts: verdicts.map((v) => ({ type: v.type, confidence: v.confidence })),
      pain_emitted: emitted,
      note: 'LLM 语义判定为观测值；语义不符不判 seam 失败，进入 metrics 汇总',
    };
    record.completed_at = new Date().toISOString();
  } catch (error) {
    record.error = lib.redactSecrets(String(error).slice(0, 400));
    record.completed_at = new Date().toISOString();
  }
  records.push(record);
  fs.appendFileSync(resultsFile, JSON.stringify(record) + '\n');
  console.log(`[${String(index).padStart(2, '0')}/${SUBSET.length}] ${sampleId} (${sample.category}) → ${record.observed?.routing ?? record.error ?? '?'} / seam=${record.seam_pass === true ? 'ok' : record.seam_pass === false ? 'mismatch' : 'n/a'}`);
}

// ─── STRONG rate limit 门控（真实 seam 行为，无 LLM 调用） ────────────────────
// 单 session 每小时 strongRateLimitPerHour=5：第 6 次 STRONG 直发必须被抑制，
// SIGNAL_STRONG_RATE_LIMITED 进 SYSTEM 日志。
let rateLimitCheck;
try {
  const env = lib.bootstrapSampleEnv({ runRoot, sampleId: 'openclaw-rate-limit', config });
  const stateDir = path.join(env.workspaceDir, '.state');
  const trajectory = new TrajectoryDatabase({ workspaceDir: env.workspaceDir });
  const evolutionReducer = new EvolutionReducerImpl({ workspaceDir: env.workspaceDir, stateDir });
  const wctx = { workspaceDir: env.workspaceDir, stateDir, trajectory, evolutionReducer };
  const liveStore = createLiveSignalKeywordStore(wctx);
  const host = new SignalCollectorHost(wctx, {
    llmClassifier: null, // STRONG 直达路径不需要 LLM；null 分类器不影响 high 直发
    keywordStoreProvider: () => liveStore.resolve(),
    config: DEFAULT_SIGNAL_CONFIG,
  });
  const sessionId = 'sess-openclaw-rate-limit';
  const a2 = sampleById.get('A2');
  for (let i = 1; i <= 6; i += 1) {
    host.detectSync(`${a2.text}（第 ${i} 次独立纠正）`, sessionId, 'user', { turnIndex: i });
  }
  await sleep(2500);
  const logEvents = readSystemLogEvents(env.workspaceDir);
  const rateLimited = logEvents.filter((l) => l.includes('[SIGNAL_STRONG_RATE_LIMITED]')).length;
  const funnelTasks = readDiagnosticianTaskCount(env.workspaceDir);
  rateLimitCheck = {
    pass: rateLimited === 1 && funnelTasks === DEFAULT_SIGNAL_CONFIG.strongRateLimitPerHour,
    evidence: {
      strong_texts_sent: 6,
      rate_limited_events: rateLimited,
      diagnostician_tasks: funnelTasks,
      strong_rate_limit_per_hour: DEFAULT_SIGNAL_CONFIG.strongRateLimitPerHour,
      honestNote: '漏斗成功路径在 PAIN_* 日志层静默；证据 = state.db diagnostician 任务数（5 次放行）+ 1 次 SIGNAL_STRONG_RATE_LIMITED（第 6 次抑制）',
    },
  };
  trajectory.dispose();
} catch (error) {
  rateLimitCheck = { pass: false, evidence: { error: lib.redactSecrets(String(error).slice(0, 300)) } };
}
console.log(`[rate-limit] 6× STRONG 单 session → 抑制事件=${rateLimitCheck.evidence?.rate_limited_events ?? 'n/a'} / diagnostician 任务=${rateLimitCheck.evidence?.diagnostician_tasks ?? 'n/a'}`);

// ─── 汇总 ───────────────────────────────────────────────────────────────────

const seamPassed = records.filter((r) => r.seam_pass === true).length;
const seamMismatched = records.filter((r) => r.seam_pass === false).length;
const errored = records.filter((r) => r.error).length;
const semanticEmit = records.filter((r) => r.semantic_observation?.pain_emitted === true).length;
const llmCallsAll = records.flatMap((r) => r.observed?.llm ?? []);
const okCalls = llmCallsAll.filter((c) => c.status === 'ok');
const latencies = okCalls.map((c) => c.latency_ms).sort((a, b) => a - b);
const summary = {
  ok: seamMismatched === 0 && errored === 0 && rateLimitCheck.pass === true,
  run_id: runId,
  experiment: 'PRI-1147 — OpenClaw SignalCollectorHost real-seam subset (real provider LLM)',
  seam: {
    host: 'packages/openclaw-plugin/dist/core/signal-collector-host.js (real SignalCollectorHost)',
    classifier_factory: 'createSignalLlmClassifierFromConfig (production config resolution)',
    keyword_store: 'createLiveSignalKeywordStore (production live store provider)',
    trajectory: 'real plugin TrajectoryDatabase',
    funnel_boundary_note: 'emitPainDetectedEvent 漏斗在隔离 workspace 上真实执行（真实 EvolutionReducerImpl + PainToPrincipleService）；成功路径在 PAIN_* 日志层静默，证据 = state.db diagnostician 任务 + memory/evolution.jsonl 事件，降级/拒绝以 PAIN_* 日志如实记录',
  },
  provider,
  model,
  api_key_env: apiKeyEnv,
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  totals: {
    samples: SUBSET.length,
    seam_passed: seamPassed,
    seam_mismatched: seamMismatched,
    errored,
    semantic_pain_emitted: semanticEmit,
  },
  llm_summary: {
    totalCalls: llmCallsAll.length,
    okCalls: okCalls.length,
    noVerdictCalls: llmCallsAll.filter((c) => c.status === 'no_verdict').length,
    threwCalls: llmCallsAll.filter((c) => c.status === 'threw').length,
    avgLatencyMs: okCalls.length === 0 ? null : Math.round(okCalls.reduce((s, c) => s + c.latency_ms, 0) / okCalls.length),
    p95LatencyMs: latencies.length === 0 ? null : latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))],
  },
  rate_limit_check: rateLimitCheck,
  semantic_mismatches: records
    .filter((r) => r.expected && r.semantic_observation)
    .filter((r) => (r.expected.label === 'correction') !== (r.semantic_observation.pain_emitted === true))
    .map((r) => ({ sample_id: r.sample_id, expected_label: r.expected.label, pain_emitted: r.semantic_observation.pain_emitted, llm_verdicts: r.semantic_observation.llm_verdicts })),
  results_file: resultsFile,
  run_root: runRoot,
  dist_fingerprint: distFingerprint,
  records,
};
fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
recordPhase(metaPath, meta, PHASES.openclawHost, {
  finished_at: summary.finished_at ?? new Date().toISOString(),
  ok: summary.ok,
  totals: summary.totals,
  dist_fingerprint: summary.dist_fingerprint,
});
console.log(JSON.stringify({ ok: summary.ok, totals: summary.totals, llm_summary: summary.llm_summary, summary_file: summaryFile }, null, 2));
process.exit(summary.ok ? 0 : 1);
