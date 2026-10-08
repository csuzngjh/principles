/**
 * PD_PROMPT_CAPACITY_V1 Phase C — reproducible prompt-capacity measurement
 * entry (SPEC §6 / AC-13).
 *
 * Runs the REAL production prompt builders over synthetic controlled
 * workspaces and emits a JSON + Markdown comparison report:
 *   - list route (OpenClaw flag-off): readPromptActivationCandidates →
 *     trimToBudget → renderPrinciplesToDirectives, the exact chain
 *     openclaw-plugin/src/hooks/prompt.ts runs (rotation via session round
 *     keys; roundKey omitted = the plugin's lost-turn-source FIFO degrade);
 *   - shared route (Codex / flag-on): the production host-runtime path via
 *     createProductionHostRuntime().dispatch(before_prompt_build) with a REAL
 *     appendEventLogLine emitter, then the honest evidence read-model over the
 *     emitted events (AC-12 wiring proof);
 *   - budget-candidate comparison: current defaults vs full-render-2000 vs
 *     forced shared rotation, on a fixed 16-candidate / 40-round replay
 *     (scenario equivalent of the SPEC §2 snapshot, labeled as such).
 *
 * PD token cost is recorded as null: the measurement holds no tokenizer/model
 * binding, and whole-request usage can never be attributed to PD output
 * (SPEC §6). Run: node packages/pd-cli/scripts/prompt-capacity-measurement.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import {
  RUNTIME_V2_PRINCIPLE_BUDGET,
  SqliteConnection,
  SqliteActivationStateStore,
  getDefaultPdConfig,
  trimToBudget,
  renderPrinciplesToDirectives,
  appendEventLogLine,
} from '@principles/core/runtime-v2';
import { escapeXml } from '@principles/core/prompt-builder';
import {
  buildActivePrinciplePromptContext,
  createProductionHostRuntime,
  readPromptActivationCandidates,
  resolvePromptInjectionRouteDecision,
  readInjectionEventEvidence,
} from '@principles/host-runtime';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const OUT_MD = path.join(ROOT, 'docs', 'audit', 'PD_PROMPT_CAPACITY_MEASUREMENT_2026-10-07.md');
const OUT_JSON = path.join(ROOT, 'docs', 'audit', 'PD_PROMPT_CAPACITY_MEASUREMENT_2026-10-07.json');

function makeWorkspace(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-measure-'));
  fs.mkdirSync(path.join(dir, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.state'), { recursive: true });
  const config = getDefaultPdConfig();
  if (opts.sharedFlag) config.features.abstraction_layer_v1 = { ...config.features.abstraction_layer_v1, enabled: true };
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

function countOversizedCandidates(principles) {
  // Selector diagnostics are bounded and may stop scanning after a FIFO
  // prefix fills. Measure each candidate alone for a corpus-wide count.
  return principles.filter((principle) =>
    trimToBudget([principle], RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml).oversizedActivationIds.includes(principle.activationId),
  ).length;
}

async function listRouteScenario(mix, selfReport, rounds) {
  const dir = makeWorkspace({ selfReport });
  seedCandidates(dir, mix);
  const { principles, aborted } = await readPromptActivationCandidates({ workspaceDir: dir });
  const results = { route: 'list', selfReport, candidates: principles.length, aborted, avgInjected: 0, avgUsedChars: 0, avgFullRenderChars: 0, oversized: 0, policy: 'fair_rotation_v1', roundKeySource: 'controlled_simulation' };
  let injectedSum = 0, usedSum = 0, fullSum = 0;
  for (let k = 0; k < rounds; k += 1) {
    const trimmed = trimToBudget(principles, RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml, k % Math.max(principles.length, 1));
    const injected = principles.filter((p) => trimmed.injectedIds.has(p.principleId));
    const full = renderPrinciplesToDirectives(injected, trimmed.injectedIds, { escapeFn: escapeXml, selfReportInstruction: selfReport });
    injectedSum += injected.length;
    usedSum += trimmed.lines.join('\n').length;
    fullSum += full.length;
  }
  results.avgInjected = +(injectedSum / rounds).toFixed(2);
  results.avgUsedChars = Math.round(usedSum / rounds);
  results.avgFullRenderChars = Math.round(fullSum / rounds);
  results.oversized = countOversizedCandidates(principles);
  results.templateOverheadChars = results.avgFullRenderChars - results.avgUsedChars;
  fs.rmSync(dir, { recursive: true, force: true });
  return results;
}

async function listRouteFifoDegraded(mix) {
  const dir = makeWorkspace({});
  seedCandidates(dir, mix);
  const { principles } = await readPromptActivationCandidates({ workspaceDir: dir });
  const trimmed = trimToBudget(principles, RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    route: 'list-fifo',
    policy: 'legacy_fifo_prefix_v1 (lost turn source / restart degrade)',
    candidates: principles.length,
    injected: principles.filter((p) => trimmed.injectedIds.has(p.principleId)).length,
    usedChars: trimmed.lines.join('\n').length,
    oversized: countOversizedCandidates(principles),
  };
}

async function sharedRouteScenario(mix, selfReport, forcedRotationRounds) {
  const dir = makeWorkspace({ sharedFlag: true, selfReport });
  const activationIds = seedCandidates(dir, mix);
  const { principles } = await readPromptActivationCandidates({ workspaceDir: dir });
  const results = { route: 'shared', selfReport, candidates: activationIds.length, fifoInjected: 0, fifoUsedChars: 0, oversized: 0, avgInjectedForcedRotation: null, evidenceRows: null, forcedRoundKeySource: 'controlled_simulation' };
  const fifo = await buildActivePrinciplePromptContext({ workspaceDir: dir });
  results.fifoInjected = fifo.principleIds.length;
  results.fifoUsedChars = fifo.additionalContext.length;
  results.oversized = countOversizedCandidates(principles);
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
  const dir = makeWorkspace({ sharedFlag: true });
  seedCandidates(dir, mix);
  const events = [];
  const runtime = createProductionHostRuntime({
    hostKind: 'codex',
    events: {
      recordRuntimeV2ActivationsInjected: (data) => {
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
  const replayWorkspace = makeWorkspace({ sharedFlag: true });
  seedCandidates(replayWorkspace, { short: 14, long: 2, oversized: 0 });
  const { principles: candidates } = await readPromptActivationCandidates({ workspaceDir: replayWorkspace });
  const rounds = 40;
  let listSum = 0, sharedRotationSum = 0, sharedFifoSum = 0;
  for (let k = 0; k < rounds; k += 1) {
    const t = trimToBudget(candidates, RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml, k % candidates.length);
    listSum += [...t.injectedIds].length;
    const shared = await buildActivePrinciplePromptContext({ workspaceDir: replayWorkspace, roundKey: k });
    sharedRotationSum += shared.principleIds.length;
  }
  const fifo = await buildActivePrinciplePromptContext({ workspaceDir: replayWorkspace });
  sharedFifoSum = fifo.principleIds.length;
  fs.rmSync(replayWorkspace, { recursive: true, force: true });
  return {
    scenario: 'controlled simulation only: same persisted 16 candidates (14 × 60 chars, 2 × 1200 chars), same FIFO order, 40 forced round keys',
    listRouteAvgInjected: +(listSum / rounds).toFixed(2),
    sharedForcedRotationAvgInjected: +(sharedRotationSum / rounds).toFixed(2),
    sharedFifoInjected: sharedFifoSum,
  };
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
      scenarios.push({ name: `${m.name}/list/selfReport=${selfReport}`, ...(await listRouteScenario(m.mix, selfReport, 40)) });
      scenarios.push({ name: `${m.name}/shared/selfReport=${selfReport}`, ...(await sharedRouteScenario(m.mix, selfReport, 40)) });
    }
    scenarios.push({ name: `${m.name}/list-fifo-degraded`, ...(await listRouteFifoDegraded(m.mix)) });
  }
  const withEvents = await sharedPathWithEvents({ short: 6, long: 2, oversized: 1 });
  const replay = await budgetCandidateReplay();

  const sanityWs = makeWorkspace({});
  const routeSanity = resolvePromptInjectionRouteDecision({ workspaceDir: sanityWs, targetHost: undefined });
  fs.rmSync(sanityWs, { recursive: true, force: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    budget: RUNTIME_V2_PRINCIPLE_BUDGET,
    unit: 'utf16_code_units (String.prototype.length — NOT model tokens)',
    pdTokenCost: null,
    pdTokenCostReason: 'no tokenizer/model binding held by this measurement; whole-request usage cannot be attributed to PD output (SPEC §6) — recorded as null, never approximated by chars',
    routeDecisionSanity: { status: routeSanity.status, reason: routeSanity.unconfirmedReason ?? null },
    scenarios,
    sharedPathWithEvents: withEvents,
    budgetCandidateReplay: replay,
    decision: 'defaults unchanged: both routes keep their existing 2000 budget scope, serializers, and selectors; no migration initiated by this task (fixed decision per SPEC §1/§6)',
  };
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2), 'utf8');

  const lines = [];
  lines.push('# PD 提示词容量测量报告（PD_PROMPT_CAPACITY_V1 Phase C / AC-13）');
  lines.push('');
  lines.push(`生成时间：${payload.generatedAt}　测量入口：\`packages/pd-cli/scripts/prompt-capacity-measurement.mjs\`（可复现；合成样本 + 临时受控工作区 + 真实生产构建器）。`);
  lines.push('');
  lines.push('预算 = 2000 UTF-16 字符（`String.prototype.length`），**不是模型 token**。PD token 成本 = null（无 tokenizer/模型绑定；整请求 usage 不可归属为 PD 输出）。');
  lines.push('');
  lines.push('## 场景对照（40 轮）');
  lines.push('');
  lines.push('轮转行使用连续 round keys 做受控模拟；这些轮次不代表真实用户 turn。列表与共享路由的对照使用相同长度、顺序和文本的候选集。');
  lines.push('');
  lines.push('| 场景 | 路由 | 自报 | 候选 | 平均注入条数 | 列表口径字符 | 完整注入块字符 | 模板开销 | 超长 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const s of scenarios) {
    if (s.route === 'list-fifo') {
      lines.push(`| ${s.name} | 列表(FIFO降级,轮次丢失) | – | ${s.candidates} | ${s.injected}(固定前缀,无轮转) | ${s.usedChars} | n/a | n/a | ${s.oversized} |`);
    } else if (s.route === 'list') {
      lines.push(`| ${s.name} | 列表(轮转) | ${s.selfReport} | ${s.candidates} | ${s.avgInjected} | ${s.avgUsedChars} | ${s.avgFullRenderChars} | ${s.templateOverheadChars} | ${s.oversized} |`);
    } else {
      const avg = s.avgInjectedForcedRotation === null ? s.fifoInjected : `${s.fifoInjected}(FIFO) / ${s.avgInjectedForcedRotation}(强制轮转模拟均值)`;
      lines.push(`| ${s.name} | 共享 | ${s.selfReport} | ${s.candidates} | ${avg} | –(按完整块计费) | ${s.fifoUsedChars} | 0(口径即完整块) | ${s.oversized} |`);
    }
  }
  lines.push('');
  lines.push('要点：');
  lines.push('- 列表路由按选中行计费，共享路由按完整注入块计费——同一候选集合的“占用”两个数字差异即模板开销（包装+自报脚注），不能混称。');
  lines.push('- `list-fifo-degraded` = 轮次来源丢失（会话重启/无 user_turn）时插件的真实降级路径：FIFO 前缀打包，尾部候选结构性饥饿——这就是 AC-03 要求区分“轮转机会”与“FIFO 不承诺”的实证。');
  lines.push('- 超长候选（2100 字符正文）在两种路由下都不可单独装入，与轮转无关（AC-02/AC-05 实证）。');
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
  lines.push(`- 保持两条路由各自的 2000 计费口径、serializer 与选择器不变。`);
  lines.push(`- 受控模拟中完整渲染口径平均注入 ${replay.sharedForcedRotationAvgInjected} 条，列表口径平均 ${replay.listRouteAvgInjected} 条；两条路使用相同 16 个持久化候选，forced round keys 是模拟输入，不代表真实用户轮次。`);
  lines.push('- 模板收益：共享口径把包装/脚注计入预算，计量更诚实，但等价于隐性降预算；回退成本：路由口径迁移影响所有已激活原则的装入性判定，需要独立迁移任务与真实行为数据。');
  lines.push('- 未验证行为改善：本报告只有注入/字符事实；模型遵守率、历史真实注入率、最佳预算均未知（unknown），不得以“平均选中更多/更少”当作行为改善。');
  lines.push('');
  fs.writeFileSync(OUT_MD, lines.join('\n') + '\n', 'utf8');
  console.log(`[measure] wrote ${OUT_MD}`);
  console.log(`[measure] wrote ${OUT_JSON}`);
}

await main();
