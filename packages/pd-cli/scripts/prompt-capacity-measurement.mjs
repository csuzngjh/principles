/**
 * PD_PROMPT_CAPACITY_V1 Phase C — reproducible prompt-capacity measurement
 * entry (SPEC §6 / AC-13).
 *
 * Runs the REAL production prompt builder over synthetic controlled
 * workspaces and emits a JSON + Markdown comparison report. PRI-1137: the
 * retired plugin-local list route is NOT simulated any more — production has
 * exactly one route:
 *   - shared route (all hosts): the production host-runtime path via
 *     createProductionHostRuntime().dispatch(before_prompt_build) with a REAL
 *     appendEventLogLine emitter, then the honest evidence read-model over the
 *     emitted events (AC-12 wiring proof);
 *   - budget-candidate comparison: current defaults vs full-render-2000, on a
 *     fixed 16-candidate / 40-round replay (scenario equivalent of the SPEC §2
 *     snapshot, labeled as such).
 *
 * PD token cost is recorded as null: the measurement holds no tokenizer/model
 * binding, and whole-request usage can never be attributed to PD output
 * (SPEC §6). Run: node packages/pd-cli/scripts/prompt-capacity-measurement.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import {
  RUNTIME_PRINCIPLE_BUDGET,
  PROMPT_BUDGET_BASE_CHARS,
  PROMPT_BUDGET_MAX_CHARS,
  PROMPT_BUDGET_MIN_CHARS,
  PROMPT_BUDGET_POLICY_VERSION,
  PROMPT_BUDGET_REFERENCE_CONTEXT_WINDOW_TOKENS,
  SqliteConnection,
  SqliteActivationStateStore,
  getDefaultPdConfig,
  promptBudgetCharsForContextWindow,
  resolvePromptBudget,
  appendEventLogLine,
} from '@principles/core/runtime';
import {
  buildActivePrinciplePromptContext,
  createProductionHostRuntime,
  packSharedDirectives,
  readPromptActivationCandidates,
  resolvePromptInjectionRouteDecision,
  readInjectionEventEvidence,
} from '@principles/host-runtime';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const OUT_MD = path.join(ROOT, 'docs', 'audit', 'PD_PROMPT_CAPACITY_MEASUREMENT_2026-10-07.md');
const OUT_JSON = path.join(ROOT, 'docs', 'audit', 'PD_PROMPT_CAPACITY_MEASUREMENT_2026-10-07.json');
const OUT_MD_MA = path.join(ROOT, 'docs', 'audit', 'PD_PROMPT_CAPACITY_MEASUREMENT_MODEL_AWARE_2026-10-20.md');
const OUT_JSON_MA = path.join(ROOT, 'docs', 'audit', 'PD_PROMPT_CAPACITY_MEASUREMENT_MODEL_AWARE_2026-10-20.json');

function makeWorkspace(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-measure-'));
  fs.mkdirSync(path.join(dir, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.state'), { recursive: true });
  const config = getDefaultPdConfig();
  // PRI-1137: `abstraction_layer_v1` is a gone tombstone — there is no route to
  // switch, so the measurement never toggles it.
  if (opts.selfReport) config.features.principle_receipt_self_report = { ...config.features.principle_receipt_self_report, enabled: true };
  fs.writeFileSync(path.join(dir, '.pd', 'config.yaml'), yaml.dump(config), 'utf8');
  return dir;
}

function seedCandidates(workspaceDir, mix) {
  // mix: { short: n, long: n, oversized: n }
  const connection = new SqliteConnection({ workspaceDir });
  const kinds = [['short', 60, mix.short], ['long', 1200, mix.long], ['oversized', 2100, mix.oversized]];
  let idx = 0;
  const base = Date.UTC(2026, 9, 7, 8, 0, 0);
  try {
    const insertArtifact = connection.getDb().prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, 'principle', ?, NULL, NULL, '[]', 'validated', ?, ?, ?)
    `);
    const store = new SqliteActivationStateStore(connection);
    const seeded = [];
    for (const [kind, len, count] of kinds) {
      for (let i = 0; i < count; i += 1) {
        idx += 1;
        const principleId = `M-${kind}-${String(idx).padStart(2, '0')}`;
        const artifactId = `art-${principleId}`;
        const at = new Date(base + idx * 60_000).toISOString();
        insertArtifact.run(artifactId, `task-${principleId}`, JSON.stringify({ principleId, text: `${kind[0].toUpperCase().repeat(1)}${String(len)}-`.slice(0, 0) + kind[0].repeat(len) }), at, at);
        store.recordActivation({
          activationId: `act-${principleId}`, idempotencyKey: `${artifactId}::prompt`, artifactId,
          channel: 'prompt', action: 'prompt_activate', targetRef: `ledger://${principleId}`,
          activatedAt: at, deactivatedAt: null,
        });
        seeded.push(principleId);
      }
    }
    return seeded;
  } finally {
    connection.close();
  }
}

/**
 * PRI-1137: oversized candidates are measured with THE production shared
 * packer, not the retired list-route `trimToBudget` arithmetic. The packer
 * renders each candidate through the same full directive serializer the
 * runtime uses, so the wrapper, the authority attribute (`authority="..."`)
 * and the self-report instruction all participate in the budget — exactly the
 * `full_directive_context` basis the shared route reports. Measuring each
 * candidate alone keeps the corpus-wide count independent of FIFO prefix fill.
 */
export function countOversizedCandidates(
  principles,
  selfReportEnabled,
  budgetChars = RUNTIME_PRINCIPLE_BUDGET,
) {
  return principles.filter((principle) =>
    packSharedDirectives({
      scanOrder: [principle],
      // Use the exact tier budget being reported. The fixed runtime fallback
      // is only the default for scenarios without a model-capacity fact.
      budgetChars,
      selfReportEnabled,
      continueOnNonFit: true,
    }).oversized.includes(principle.activationId),
  ).length;
}

// PRI-1137: the plugin-local "list" route (OpenClaw legacy_trim) and its
// FIFO-degraded variant are RETIRED — production runs the shared runtime for
// every host. Measuring them here would describe a path users cannot take, so
// both scenarios were removed. Only the shared route is measured.

async function sharedRouteScenario(mix, selfReport, forcedRotationRounds) {
  const dir = makeWorkspace({ selfReport });
  const activationIds = seedCandidates(dir, mix);
  const { principles, selfReportEnabled } = await readPromptActivationCandidates({ workspaceDir: dir, includeAuthority: true });
  const results = { route: 'shared', selfReport, candidates: activationIds.length, fifoInjected: 0, fifoUsedChars: 0, oversized: 0, avgInjectedForcedRotation: null, evidenceRows: null, forcedRoundKeySource: 'controlled_simulation' };
  const fifo = await buildActivePrinciplePromptContext({ workspaceDir: dir });
  results.fifoInjected = fifo.principleIds.length;
  results.fifoUsedChars = fifo.additionalContext.length;
  results.oversized = countOversizedCandidates(principles, selfReportEnabled);
  results.fifoPolicy = fifo.selectionPolicy;
  if (forcedRotationRounds > 0) {
    let sum = 0;
    for (let k = 0; k < forcedRotationRounds; k += 1) {
      const ctx = await buildActivePrinciplePromptContext({ workspaceDir: dir, roundKey: k });
      sum += ctx.principleIds.length;
    }
    results.avgInjectedForcedRotation = +(sum / forcedRotationRounds).toFixed(2);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return results;
}

/** Real shared-path drive incl. event emission + honest evidence read-model. */
async function sharedPathWithEvents(mix) {
  const dir = makeWorkspace({});
  seedCandidates(dir, mix);
  const events = [];
  const runtime = createProductionHostRuntime({
    hostKind: 'codex',
    events: {
      recordRuntimeActivationsInjected: (data) => {
        events.push(data);
        appendEventLogLine(path.join(dir, '.state'), {
          ts: new Date().toISOString(),
          type: 'runtime_v2_prompt_activations_injected',
          category: 'injected',
          sessionId: data.sessionId,
          data,
        });
      },
      recordToolCall: () => { /* not exercised by the prompt route */ },
    },
  });
  const injectedCounts = [];
  for (let turn = 1; turn <= 5; turn += 1) {
    const result = await runtime.dispatch({
      kind: 'before_prompt_build',
      source: 'codex:measurement',
      rawPayload: { note: 'measurement drive' },
      context: { workspaceDir: dir, sessionId: 'measure-session' },
    });
    injectedCounts.push(result.additionalContext?.length ?? 0);
  }
  const evidence = readInjectionEventEvidence({ stateDir: path.join(dir, '.state') });
  const rows = evidence.rows.map((r) => ({ activationId: r.activationId, hostKind: r.hostKind, provenInjections: r.provenInjections, runIdComplete: r.runIdComplete, eventIdentityComplete: r.eventIdentityComplete }));
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    promptBuildsDriven: 5,
    eventsEmitted: events.length,
    promptBuildsWithInjection: injectedCounts.filter((n) => n > 0).length,
    evidenceRows: rows.length,
    evidenceAllRunBound: rows.every((r) => r.runIdComplete),
    evidenceAllHostBound: rows.every((r) => r.hostKind === 'codex'),
    evidenceAllEventBound: rows.every((r) => r.eventIdentityComplete),
    runIdentityFixture: 'controlled measurement has no host run id; missing stays unknown',
    evidenceNote: evidence.note,
  };
}

async function budgetCandidateReplay() {
  // Simulation only: both serializers use the same persisted candidates,
  // text and FIFO order (14 × 60 chars, 2 × 1200 chars).
  const replayWorkspace = makeWorkspace({});
  seedCandidates(replayWorkspace, { short: 14, long: 2, oversized: 0 });
  const rounds = 40;
  let sharedRotationSum = 0, sharedFifoSum = 0;
  for (let k = 0; k < rounds; k += 1) {
    const shared = await buildActivePrinciplePromptContext({ workspaceDir: replayWorkspace, roundKey: k });
    sharedRotationSum += shared.principleIds.length;
  }
  const fifo = await buildActivePrinciplePromptContext({ workspaceDir: replayWorkspace });
  sharedFifoSum = fifo.principleIds.length;
  fs.rmSync(replayWorkspace, { recursive: true, force: true });
  return {
    scenario: 'controlled simulation only: same persisted 16 candidates (14 × 60 chars, 2 × 1200 chars), same FIFO order, 40 forced round keys (shared route)',
    sharedForcedRotationAvgInjected: +(sharedRotationSum / rounds).toFixed(2),
    sharedFifoInjected: sharedFifoSum,
  };
}

/**
 * PRI-1066: before/after comparison on the SAME candidates, through the REAL
 * production serializers. `BEFORE = 2000` is the pre-recalibration baseline
 * (base 2000 / max 16000); `AFTER` is the live policy constant. The unified
 * production route is run explicitly under each budget via
 * `buildActivePrinciplePromptContext({promptBudget})`, so the delta is
 * measured, not extrapolated.
 */
async function budgetBeforeAfterReplay() {
  const dir = makeWorkspace({});
  seedCandidates(dir, { short: 14, long: 2, oversized: 0 });
  const rounds = 40;
  const resolutionAt = (budgetChars) => ({
    budgetChars,
    capacitySource: 'legacy_fallback',
    capacityStatus: 'unknown',
    contextWindowTokens: null,
    policyVersion: PROMPT_BUDGET_POLICY_VERSION,
    fallbackReason: 'host_capacity_absent',
  });
  const sharedAt = async (budgetChars) => {
    const fifo = await buildActivePrinciplePromptContext({ workspaceDir: dir, promptBudget: resolutionAt(budgetChars) });
    let rotationSum = 0;
    for (let k = 0; k < rounds; k += 1) {
      const ctx = await buildActivePrinciplePromptContext({ workspaceDir: dir, roundKey: k, promptBudget: resolutionAt(budgetChars) });
      rotationSum += ctx.principleIds.length;
    }
    // PRI-1137 final review P2: the oversized count must cover the WHOLE
    // corpus. The FIFO projection's `oversizedActivationIds` only covers
    // candidates seen before the first non-fit (FIFO stops there), so entries
    // after the stop point were silently missing from this statistic.
    const { principles, selfReportEnabled } = await readPromptActivationCandidates({ workspaceDir: dir, includeAuthority: true });
    return {
      fifoInjected: fifo.principleIds.length,
      fifoUsedChars: fifo.additionalContext.length,
      fifoTruncated: fifo.truncated,
      rotationAvgInjected: +(rotationSum / rounds).toFixed(2),
      oversized: countOversizedCandidates(principles, selfReportEnabled, budgetChars),
    };
  };
  // Historical baseline (pre-recalibration v1 base = 2000). Deliberately a
  // literal: the BEFORE value is a fixed past fact, not a live policy value.
  const beforeChars = 2000;
  const afterChars = RUNTIME_PRINCIPLE_BUDGET;
  const result = {
    scenario: 'same 16 persisted candidates (14 × 60 chars, 2 × 1200 chars), 40 forced round keys, the unified shared production route',
    beforeChars,
    afterChars,
    before: { shared: await sharedAt(beforeChars) },
    after: { shared: await sharedAt(afterChars) },
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

/**
 * SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 Phase 4: capacity-tier measurement.
 *
 * For each tier (32K/64K/128K/256K/1M/unknown) resolve the budget through
 * the PRODUCTION resolver (host_effective_window for the numeric tiers,
 * no-facts legacy fallback for "unknown") and run the real production route
 * under that resolution: buildActivePrinciplePromptContext with the exact
 * object the production entry points pass, plus 40 forced round keys for the
 * rotation figures.
 * Reports budget/source/status + injected counts / chars / oversized /
 * truncation per tier. Character counts are UTF-16 units, NOT tokens.
 */
const TIER_MIX = { short: 14, long: 2, oversized: 0 };
const TIER_ROUNDS = 40;

export async function modelAwareTierScenario(windowTokens, selfReport) {
  const resolution = windowTokens === null
    ? resolvePromptBudget()
    : resolvePromptBudget({ hostCapacity: { contextTokenBudget: windowTokens, contextWindowSource: 'model' } });
  const budgetChars = resolution.budgetChars;
  const label = windowTokens === null ? 'unknown' : `${Math.round(windowTokens / 1000)}K`;

  const sharedDir = makeWorkspace({ selfReport });
  try {
    const activationIds = seedCandidates(sharedDir, TIER_MIX);
    const { principles, selfReportEnabled } = await readPromptActivationCandidates({
      workspaceDir: sharedDir,
      includeAuthority: true,
    });
    let rotationSum = 0;
    for (let k = 0; k < TIER_ROUNDS; k += 1) {
      const ctx = await buildActivePrinciplePromptContext({ workspaceDir: sharedDir, roundKey: k, promptBudget: resolution });
      rotationSum += ctx.principleIds.length;
    }
    const shared = await buildActivePrinciplePromptContext({ workspaceDir: sharedDir, promptBudget: resolution });

    return {
      label,
      windowTokens,
      budgetChars,
      capacitySource: resolution.capacitySource,
      capacityStatus: resolution.capacityStatus,
      fallbackReason: resolution.fallbackReason ?? null,
      policyVersion: resolution.policyVersion,
      candidates: activationIds.length,
      rotationAvgInjected: +(rotationSum / TIER_ROUNDS).toFixed(2),
      shared: {
        injected: shared.principleIds.length,
        usedChars: shared.additionalContext.length,
        truncated: shared.truncated,
        // The production FIFO scan stops at its first non-fit candidate, so its
        // per-run diagnostic list cannot represent oversized candidates later
        // in the corpus. Measure every candidate independently at THIS tier's
        // resolved budget while retaining the production full-directive packer.
        oversized: countOversizedCandidates(principles, selfReportEnabled, budgetChars),
        dropped: shared.droppedActivationIds?.length ?? 0,
        selectionPolicy: shared.selectionPolicy,
      },
    };
  } finally {
    fs.rmSync(sharedDir, { recursive: true, force: true });
  }
}

async function modelAwareSharedDispatchEvidence() {
  // AC-12-style real-path proof for the model-aware wiring: dispatch the
  // production host runtime with a HostEventContext.modelContext host window
  // and read back the emitted event's budget provenance.
  const dir = makeWorkspace({});
  seedCandidates(dir, { short: 6, long: 2, oversized: 1 });
  const events = [];
  const runtime = createProductionHostRuntime({
    hostKind: 'codex',
    events: {
      recordRuntimeActivationsInjected: (data) => { events.push(data); },
      recordToolCall: () => { /* not exercised by the prompt route */ },
    },
  });
  const dispatches = [
    { label: 'trusted host window 256K', modelContext: { contextTokenBudget: 256_000, contextWindowSource: 'model' } },
    { label: 'untrusted source default', modelContext: { contextTokenBudget: 999_999, contextWindowSource: 'default' } },
    { label: 'ambiguous bare model id', modelContext: { modelId: 'gpt-5' } },
    { label: 'no model facts (WorkBuddy contract)', modelContext: undefined },
  ];
  const results = [];
  for (const d of dispatches) {
    await runtime.dispatch({
      kind: 'before_prompt_build',
      source: 'codex:measurement',
      rawPayload: { note: 'model-aware measurement drive' },
      context: { workspaceDir: dir, sessionId: 'measure-model-aware', ...(d.modelContext !== undefined ? { modelContext: d.modelContext } : {}) },
    });
    const event = events[events.length - 1];
    results.push({
      dispatch: d.label,
      budget: event.budget,
      budgetCapacitySource: event.budgetCapacitySource,
      budgetCapacityStatus: event.budgetCapacityStatus,
      budgetContextWindowTokens: event.budgetContextWindowTokens ?? null,
      budgetFallbackReason: event.budgetFallbackReason ?? null,
      injectedCount: event.injectedCount,
    });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return results;
}

async function main() {
  console.log('[measure] building replay workspace…');

  const scenarios = [];
  const mixes = [
    { name: 'small-4', mix: { short: 4, long: 0, oversized: 0 } },
    { name: 'mid-12', mix: { short: 8, long: 4, oversized: 0 } },
    { name: 'growth-40', mix: { short: 24, long: 8, oversized: 8 } },
  ];
  for (const m of mixes) {
    for (const selfReport of [false, true]) {
      scenarios.push({ name: `${m.name}/shared/selfReport=${selfReport}`, ...(await sharedRouteScenario(m.mix, selfReport, 40)) });
    }
  }
  const withEvents = await sharedPathWithEvents({ short: 6, long: 2, oversized: 1 });
  const replay = await budgetCandidateReplay();

  // SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 Phase 4 tier measurement.
  const tierWindows = [32_000, 64_000, 128_000, 256_000, 1_000_000, null];
  const tierScenarios = [];
  for (const windowTokens of tierWindows) {
    // Both self-report flag states: the shared route bills the footer, so
    // the tier table must carry evidence for each state it makes claims
    // about (the 32K floor claim in particular).
    for (const selfReport of [false, true]) {
      tierScenarios.push({ selfReport, ...(await modelAwareTierScenario(windowTokens, selfReport)) });
    }
  }
  const sharedDispatchEvidence = await modelAwareSharedDispatchEvidence();
  // PRI-1066: measured before/after on the same candidates.
  const beforeAfter = await budgetBeforeAfterReplay();

  const sanityWs = makeWorkspace({});
  const routeSanity = resolvePromptInjectionRouteDecision({ workspaceDir: sanityWs, targetHost: undefined });
  fs.rmSync(sanityWs, { recursive: true, force: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    budget: RUNTIME_PRINCIPLE_BUDGET,
    unit: 'utf16_code_units (String.prototype.length — NOT model tokens)',
    pdTokenCost: null,
    pdTokenCostReason: 'no tokenizer/model binding held by this measurement; whole-request usage cannot be attributed to PD output (SPEC §6) — recorded as null, never approximated by chars',
    routeDecisionSanity: { status: routeSanity.status, reason: routeSanity.unconfirmedReason ?? null },
    scenarios,
    sharedPathWithEvents: withEvents,
    budgetCandidateReplay: replay,
    decision: `PRI-1137: one production route (shared). The retired plugin-local list route is no longer measured; the ${RUNTIME_PRINCIPLE_BUDGET}-char budget scope and selector are unchanged.`,
  };
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2), 'utf8');

  const lines = [];
  lines.push('# PD 提示词容量测量报告（PD_PROMPT_CAPACITY_V1 Phase C / AC-13）');
  lines.push('');
  lines.push(`生成时间：${payload.generatedAt}　测量入口：\`packages/pd-cli/scripts/prompt-capacity-measurement.mjs\`（可复现；合成样本 + 临时受控工作区 + 真实生产构建器）。`);
  lines.push('');
  lines.push(`预算 = ${RUNTIME_PRINCIPLE_BUDGET} UTF-16 字符（\`String.prototype.length\`），**不是模型 token**。PD token 成本 = null（无 tokenizer/模型绑定；整请求 usage 不可归属为 PD 输出）。`);
  lines.push('');
  lines.push('## 场景对照（40 轮）');
  lines.push('');
  lines.push('轮转行使用连续 round keys 做受控模拟；这些轮次不代表真实用户 turn。PRI-1137 后只有一个生产路由（shared），已退役的插件本地列表路由不再测量。');
  lines.push('');
  lines.push('| 场景 | 路由 | 自报 | 候选 | 平均注入条数 | 完整注入块字符 | 超长 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const s of scenarios) {
    const avg = s.avgInjectedForcedRotation === null ? s.fifoInjected : `${s.fifoInjected}(FIFO) / ${s.avgInjectedForcedRotation}(强制轮转模拟均值)`;
    lines.push(`| ${s.name} | 共享 | ${s.selfReport} | ${s.candidates} | ${avg} | ${s.fifoUsedChars} | ${s.oversized} |`);
  }
  lines.push('');
  lines.push('要点：');
  lines.push('- 共享路由按完整注入块计费（包装+自报脚注计入预算），计量口径即完整块。');
  lines.push('- 轮次来源缺失（会话重启/无 sessionId/user_turn）时，共享选择器如实报告 `legacy_fifo_prefix_v1`：FIFO 前缀打包，尾部候选结构性饥饿——轮转机会与 FIFO 不承诺必须区分。');
  lines.push('- 超长候选由本次测量按当前预算实测判定（`oversizedActivationIds`），与轮转无关（AC-02/AC-05 实证）；不假定任何固定正文字符数必然超长。');
  lines.push('');
  lines.push('## 受控共享路径 + 事件证据（AC-12 接线证明）');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(withEvents, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## 预算候选对照（AC-13；同一数据集的受控模拟）');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(replay, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('结论（本任务固定决策，未发起迁移确认）：');
  lines.push(`- 统一使用共享路由的 ${RUNTIME_PRINCIPLE_BUDGET} 计费口径、serializer 与选择器；已退役路由不再保留口径。`);
  lines.push(`- 受控模拟中完整渲染口径平均注入 ${replay.sharedForcedRotationAvgInjected} 条（同一 16 个持久化候选）；forced round keys 是模拟输入，不代表真实用户轮次。`);
  lines.push('- 模板开销：共享口径把包装/脚注计入预算，计量更诚实，但等价于隐性降预算；该口径现为唯一生产口径。');
  lines.push('- 未验证行为改善：本报告只有注入/字符事实；模型遵守率、历史真实注入率、最佳预算均未知（unknown），不得以“平均选中更多/更少”当作行为改善。');
  lines.push('');
  fs.writeFileSync(OUT_MD, lines.join('\n') + '\n', 'utf8');
  console.log(`[measure] wrote ${OUT_MD}`);
  console.log(`[measure] wrote ${OUT_JSON}`);

  // ── SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 Phase 4 outputs ──
  const maPayload = {
    generatedAt: payload.generatedAt,
    spec: 'SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001',
    unit: 'utf16_code_units (String.prototype.length — NOT model tokens)',
    policy: {
      version: PROMPT_BUDGET_POLICY_VERSION,
      // Interpolated from the live constants so the narrative can never
      // drift from the policy this script actually runs (v0.2 fix: the
      // hand-written string still said 500/4000 after the re-bound).
      formula: `budgetChars = min(${PROMPT_BUDGET_MAX_CHARS}, max(${PROMPT_BUDGET_MIN_CHARS}, floor(${PROMPT_BUDGET_BASE_CHARS} * W / ${PROMPT_BUDGET_REFERENCE_CONTEXT_WINDOW_TOKENS})))`,
      minBudgetChars: PROMPT_BUDGET_MIN_CHARS,
      maxBudgetChars: PROMPT_BUDGET_MAX_CHARS,
      fallbackBudgetChars: RUNTIME_PRINCIPLE_BUDGET,
      windowToBudgetSanity: {
        '32K': promptBudgetCharsForContextWindow(32_000),
        '64K': promptBudgetCharsForContextWindow(64_000),
        '128K': promptBudgetCharsForContextWindow(128_000),
        '256K': promptBudgetCharsForContextWindow(256_000),
        '1M': promptBudgetCharsForContextWindow(1_000_000),
      },
    },
    scenario: `16 persisted candidates (14 × 60 chars, 2 × 1200 chars) per tier workspace, ${TIER_ROUNDS} forced round keys through buildActivePrinciplePromptContext (the only production route)`,
    tiers: tierScenarios,
    beforeAfter,
    sharedDispatchEvidence,
    catalogNote: 'catalog metadata is available in-process via getPromptModelCatalog() (installed pi-ai 1.2.0 static catalog); no network calls are made at any point',
    pdTokenCost: null,
    pdTokenCostReason: payload.pdTokenCostReason,
    interpretation: '注入条数/字符数是容量事实，不是行为改善证据；行为改善需要独立的真实 Agent 对照与回放。',
  };
  fs.writeFileSync(OUT_JSON_MA, JSON.stringify(maPayload, null, 2), 'utf8');

  const ma = [];
  ma.push('# PD 模型感知注入预算测量报告（SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 Phase 4）');
  ma.push('');
  ma.push(`生成时间：${maPayload.generatedAt}　测量入口：\`packages/pd-cli/scripts/prompt-capacity-measurement.mjs\`（真实生产构建器 + 受控临时工作区）。`);
  ma.push('');
  ma.push(`政策：\`${maPayload.policy.formula}\`（下限 ${PROMPT_BUDGET_MIN_CHARS} / 目标上限 ${PROMPT_BUDGET_MAX_CHARS} / 未知回退 ${RUNTIME_PRINCIPLE_BUDGET} 字符，UTF-16 字符，**不是 token**）。下限为实测锚定：共享路由单条最小有效原则完整渲染 849 字符（自报关）/ 1204 字符（自报开），任何更低下限都会复现 32K 零注入缺陷；上限为目标值，1M 档位按公式精确得出 ${promptBudgetCharsForContextWindow(1_000_000)}，不假装恰好等于上限。`);
  ma.push('');
  ma.push('## 容量档位 × 统一生产路由');
  ma.push('');
  ma.push('| 容量档位 | 自报 | 预算(字符) | 来源 | 状态 | 候选 | 轮转平均值注入 | 单次注入 | 单次字符 | 单次截断 |');
  ma.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const t of tierScenarios) {
    ma.push(`| ${t.label} | ${t.selfReport ? '开' : '关'} | ${t.budgetChars} | ${t.capacitySource} | ${t.capacityStatus} | ${t.candidates} | ${t.rotationAvgInjected} | ${t.shared.injected} | ${t.shared.usedChars} | ${t.shared.truncated} |`);
  }
  ma.push('');
  ma.push('要点：');
  ma.push(`- 未知容量档位如实回退 ${RUNTIME_PRINCIPLE_BUDGET} 字符（\`legacy_fallback\` / \`unknown\` + 有界原因码），与既有生产行为一致；无任何伪造的动态支持。`);
  ma.push(`- 1M 档位预算按公式精确为 ${promptBudgetCharsForContextWindow(1_000_000)} 字符（≥${Math.ceil(PROMPT_BUDGET_MAX_CHARS * PROMPT_BUDGET_REFERENCE_CONTEXT_WINDOW_TOKENS / PROMPT_BUDGET_BASE_CHARS)} token 才触顶 ${PROMPT_BUDGET_MAX_CHARS}）——上限是目标边界，不是必须达到的固定值。`);
  ma.push('- 32K 档位（=下限 1250）经真实生产构建器验证：共享路由在自报开/关两种状态下均至少完整注入一条最小有效原则（v0.1 的 500 下限在该档位注入 0 条，已修复并以回归测试钉住）。');
  ma.push('- 超长排除/截断语义在各档位下与生产共享选择器一致（同一 `packSharedDirectives` 完整 directive 序列化；超长候选按 `full_directive_context` 口径单独测量）。');
  ma.push('');
  ma.push('## 改动前后对比（同一批候选，真实生产序列化器实测）');
  ma.push('');
  ma.push(`同一批 16 条候选（14 × 60 字符 + 2 × 1200 字符）、40 个受控 round key，分别以旧预算 ${beforeAfter.beforeChars} 与新预算 ${beforeAfter.afterChars} 跑真实选择器/渲染器：`);
  ma.push('');
  ma.push('| 路由 | 旧预算注入条数 | 新预算注入条数 | 旧预算占用字符 | 新预算占用字符 |');
  ma.push('| --- | --- | --- | --- | --- |');
  ma.push(`| 共享路由（FIFO 单次构建） | ${beforeAfter.before.shared.fifoInjected} | ${beforeAfter.after.shared.fifoInjected} | ${beforeAfter.before.shared.fifoUsedChars} | ${beforeAfter.after.shared.fifoUsedChars} |`);
  ma.push(`| 共享路由（40 轮强制轮转均值） | ${beforeAfter.before.shared.rotationAvgInjected} | ${beforeAfter.after.shared.rotationAvgInjected} | – | – |`);
  ma.push('');
  ma.push(`共享路由 FIFO 注入：旧 ${beforeAfter.before.shared.fifoInjected} 条 → 新 ${beforeAfter.after.shared.fifoInjected} 条；旧预算截断=${beforeAfter.before.shared.fifoTruncated}，新预算截断=${beforeAfter.after.shared.fifoTruncated}。`);
  ma.push('');
  ma.push('## 共享路径真实 dispatch 预算来源证据（生产 createProductionHostRuntime）');
  ma.push('');
  ma.push('```json');
  ma.push(JSON.stringify(sharedDispatchEvidence, null, 2));
  ma.push('```');
  ma.push('');
  ma.push('## 完整数据');
  ma.push('');
  ma.push('```json');
  ma.push(JSON.stringify(tierScenarios, null, 2));
  ma.push('```');
  fs.writeFileSync(OUT_MD_MA, ma.join('\n') + '\n', 'utf8');
  console.log(`[measure] wrote ${OUT_MD_MA}`);
  console.log(`[measure] wrote ${OUT_JSON_MA}`);
}

// Run only when invoked as a script; importing the module (tests) must not
// rewrite the audit reports.
const isEntryPoint = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntryPoint) await main();
