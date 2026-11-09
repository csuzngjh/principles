#!/usr/bin/env node
/**
 * PRI-1140 offline replay — pinned mapping (Native arm) vs principle-identity
 * mapping (candidate arm) over the 17 frozen cases
 * (docs/specs/PD-AA-PRI-1140-FROZEN-CASES-v0.1.md §3 + §6/§7).
 *
 * Fidelity:
 * - REAL provider: `resolveAdaptivePriorityForHook` from the built plugin
 *   (`principles-disciple` dist). Signal gate, mapping parse, principle
 *   resolution and invocation opening all run exactly as in production.
 * - REAL shared assembly entry: `buildActivePrinciplePromptContext` from the
 *   built `@principles/host-runtime`. The provider -> builder field
 *   forwarding mirrors `packages/host-runtime/src/index.ts` (validated
 *   artifactId/activationId/additiveOnly/deadlineAt/signal/hookInvocationId).
 * - REAL stores: fixture workspaces seeded through `SqliteConnection` +
 *   `SqliteActivationStateStore`.
 * - Zero model calls, zero network, no production workspace. Every fixture
 *   lives under the --out directory.
 *
 * Budget unit = chars (the production `budgetChars` currency). Token figures
 * are a coarse estimate floor(chars / 4) for reference only.
 *
 * Usage (from the repository root, after building host-runtime + plugin):
 *   node scripts/dev/aa-selector/pri1140-replay.mjs --out .tmp/pri-1140/replay --commit <sha> [--iterations 15]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';
import {
  SqliteActivationStateStore,
  SqliteConnection,
  getDefaultPdConfig,
  renderPrinciplesToDirectives,
  resolvePromptBudget,
  measureSharedDirectiveBlockChars,
  sharedDirectiveBaseChars,
} from '@principles/core/runtime';
import { escapeXml } from '@principles/core/prompt-builder';
import {
  buildActivePrinciplePromptContext,
  readPromptActivationCandidates,
  resolveCurrentAuthorizedActivationByPrincipleId,
} from '@principles/host-runtime';
import { resolveAdaptivePriorityForHook } from 'principles-disciple';

function parseArgs(argv) {
  const args = { out: null, commit: null, iterations: 15 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--out') { args.out = value; i += 1; }
    else if (key === '--commit') { args.commit = value; i += 1; }
    else if (key === '--iterations') { args.iterations = Number(value); i += 1; }
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!args.out) throw new Error('--out <dir> is required');
  if (!args.commit || !/^[0-9a-f]{7,40}$/.test(args.commit)) throw new Error('--commit <sha> is required');
  if (!Number.isSafeInteger(args.iterations) || args.iterations < 3 || args.iterations > 200) {
    throw new Error('--iterations must be an integer in [3, 200]');
  }
  return args;
}

const SENTINEL = '[PD-AA:delivery-review:v1]';
const DELIVERY_V1_TEXT = '交付前自检（旧版）：宣告完成前重新执行全部验收检查。';
const DELIVERY_V2_TEXT = '交付验收前以可观察证据自检：先列出验收基准与已有证据；缺证据时如实限定结论；不重复已验证的昂贵检查。';
const DELIVERY_V3_TEXT = '交付验收前核对证据（并行草案修订）：只引用可复核的产物。';
const ORDINARY = [
  { id: 'O1-scope', text: '只修改与任务直接相关的文件，邻近改进记为后续事项。', approved: true },
  { id: 'O2-evidence', text: '结论以仓库当前代码与运行证据为准，不凭记忆或旧文档。'.repeat(2), approved: true },
  { id: 'O3-tests', text: '修复缺陷时先写能复现问题的回归测试，再改实现。', approved: false },
  { id: 'O4-secrets', text: '不在源码、日志或测试中写入可用凭据字面量；凭据只从环境或密钥服务读取。', approved: true },
  { id: 'O5-ask', text: '目标冲突或授权不明时先向 Owner 求证，再执行受限操作。'.repeat(2), approved: false },
  { id: 'O6-small', text: '优先最小可行改动，避免为假设的未来需求预建抽象。', approved: true },
];

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function fileSha256(file) {
  return fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/** Seed one fixture workspace. `delivery` selects the target revision shape. */
async function seedWorkspace(workspaceDir, delivery, { corrupt = false } = {}) {
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(getDefaultPdConfig()), 'utf8');
  const connection = new SqliteConnection(workspaceDir);
  try {
    const db = connection.getDb();
    const insertArtifact = db.prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, 'principle', ?, ?, ?, 'validated', ?, ?, ?)
    `);
    const approve = db.prepare(`
      INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at, decided_at, decided_by)
      VALUES (?, ?, 'prompt', 'low', 'approved', 1, ?, ?, 'owner-replay')
    `);
    const store = new SqliteActivationStateStore(connection);
    const baseTime = Date.UTC(2026, 10, 9, 4, 0, 0);
    let index = 0;
    const add = async ({ principleId, text, artifactId, activationId, approved, deactivated, lineage = [], content }) => {
      const at = new Date(baseTime + index * 1000).toISOString();
      index += 1;
      insertArtifact.run(artifactId, `task-${artifactId}`, principleId, JSON.stringify(lineage),
        content ?? JSON.stringify({ principleId, text }), at, at);
      await store.recordActivation({
        activationId,
        idempotencyKey: `${artifactId}::prompt`,
        artifactId,
        channel: 'prompt',
        action: 'prompt_activate',
        targetRef: `ledger://${principleId}`,
        activatedAt: at,
        deactivatedAt: deactivated ? new Date(baseTime + index * 1000 + 500).toISOString() : null,
      });
      if (approved) approve.run(`approval-${artifactId}`, artifactId, at, at);
    };
    for (const entry of ORDINARY) {
      await add({ principleId: entry.id, text: entry.text, artifactId: `art-${entry.id}`, activationId: `act-${entry.id}`, approved: entry.approved });
    }
    // Revision shapes (the real prompt-replacement flow: new artifact + new
    // activation, old activation deactivated, same principleId).
    if (delivery === 'current' || delivery === 'revised') {
      await add({ principleId: 'DELIVERY', text: DELIVERY_V1_TEXT, artifactId: 'art-delivery-v1', activationId: 'act-delivery-v1', approved: true, deactivated: true });
      await add({ principleId: 'DELIVERY', text: DELIVERY_V2_TEXT, artifactId: 'art-delivery-v2', activationId: 'act-delivery-v2', approved: true, lineage: ['art-delivery-v1'] });
    } else if (delivery === 'retired') {
      await add({ principleId: 'DELIVERY', text: DELIVERY_V1_TEXT, artifactId: 'art-delivery-v1', activationId: 'act-delivery-v1', approved: true, deactivated: true });
      await add({ principleId: 'DELIVERY', text: DELIVERY_V2_TEXT, artifactId: 'art-delivery-v2', activationId: 'act-delivery-v2', approved: true, deactivated: true, lineage: ['art-delivery-v1'] });
    } else if (delivery === 'ambiguous') {
      await add({ principleId: 'DELIVERY', text: DELIVERY_V2_TEXT, artifactId: 'art-delivery-v2', activationId: 'act-delivery-v2', approved: true });
      await add({ principleId: 'DELIVERY', text: DELIVERY_V3_TEXT, artifactId: 'art-delivery-v3', activationId: 'act-delivery-v3', approved: true });
    } else if (delivery === 'oversized') {
      await add({ principleId: 'DELIVERY', text: `${DELIVERY_V2_TEXT}${'证'.repeat(4000)}`, artifactId: 'art-delivery-v2', activationId: 'act-delivery-v2', approved: true });
    } else {
      throw new Error(`unknown delivery shape: ${delivery}`);
    }
    if (corrupt) {
      await add({ principleId: 'BROKEN', text: '', artifactId: 'art-broken', activationId: 'act-broken', approved: false, content: '{not-json' });
    }
  } finally {
    connection.close();
  }
}

function blockCosts(principles) {
  const base = sharedDirectiveBaseChars({ escapeFn: escapeXml, selfReportInstruction: false });
  const costs = new Map(principles.map((p) => [p.activationId, measureSharedDirectiveBlockChars(p, { escapeFn: escapeXml, selfReportInstruction: false })]));
  return { base, costs };
}

/**
 * Deterministic budget/round search: the smallest roundKey (1..n) and the
 * largest budget such that the PLAIN native pack excludes the target while the
 * target still fits alone (the A4/D2/A8 mechanics), or a generous budget for
 * the "ample" cases.
 */
async function chooseParams(workspaceDir, regime) {
  const candidates = await readPromptActivationCandidates({ workspaceDir, includeAuthority: true });
  const target = candidates.principles.find((p) => p.principleId === 'DELIVERY');
  const { base, costs } = blockCosts(candidates.principles);
  const total = base + [...costs.values()].reduce((sum, value) => sum + value, 0);
  const defaults = resolvePromptBudget();
  if (regime === 'ample') return { roundKey: 1, promptBudget: { ...defaults, budgetChars: total + 64 } };
  if (regime === 'oversized') {
    const targetCost = costs.get(target.activationId);
    return { roundKey: 1, promptBudget: { ...defaults, budgetChars: base + targetCost - 1 } };
  }
  if (regime !== 'tight-drop') throw new Error(`unknown regime ${regime}`);
  const targetCost = costs.get(target.activationId);
  const n = candidates.principles.length;
  for (let roundKey = 1; roundKey <= n; roundKey += 1) {
    for (let budgetChars = total - 1; budgetChars >= base + targetCost; budgetChars -= 7) {
      const promptBudget = { ...defaults, budgetChars };
      const native = await buildActivePrinciplePromptContext({ workspaceDir, roundKey, promptBudget });
      if (!native.activationIds.includes(target.activationId) && native.activationIds.length > 0) {
        return { roundKey, promptBudget };
      }
    }
  }
  throw new Error(`no tight-drop parameters found for ${workspaceDir}`);
}

function makeApi(mapping) {
  const logs = { info: [], warn: [], error: [] };
  return {
    logs,
    api: {
      pluginConfig: { adaptiveActivation: mapping },
      logger: {
        info: (line) => logs.info.push(String(line)),
        warn: (line) => logs.warn.push(String(line)),
        error: (line) => logs.error.push(String(line)),
      },
      runtime: {},
      config: {},
    },
  };
}

/** Mirrors packages/host-runtime/src/index.ts provider-result validation + forwarding. */
function toBuilderPriority(priority) {
  if (!priority) return {};
  const invalid = typeof priority.artifactId !== 'string' || !priority.artifactId.trim()
    || typeof priority.activationId !== 'string' || !priority.activationId.trim()
    || (priority.additiveOnly !== undefined && typeof priority.additiveOnly !== 'boolean')
    || (priority.deadlineAt !== undefined && !Number.isFinite(priority.deadlineAt));
  if (invalid) return {};
  if (priority.signal?.aborted || (priority.deadlineAt !== undefined && Date.now() >= priority.deadlineAt)) return {};
  return {
    adaptivePriority: { artifactId: priority.artifactId, activationId: priority.activationId },
    ...(priority.additiveOnly === true ? { additiveOnly: true } : {}),
    ...(priority.signal ? { signal: priority.signal } : {}),
    ...(priority.deadlineAt !== undefined ? { deadlineAt: priority.deadlineAt } : {}),
    ...(priority.hookInvocationId ? { hookInvocationId: priority.hookInvocationId } : {}),
  };
}

async function runArm({ workspaceDir, mapping, message, turn, roundKey, promptBudget, iterations }) {
  const providerMs = [];
  const builderMs = [];
  let first = null;
  const outputs = new Set();
  let lastLogs = null;
  for (let i = 0; i < iterations + 2; i += 1) {
    const { api, logs } = makeApi(mapping);
    const event = { prompt: message, messages: [], currentUserMessage: message, currentUserMessageId: `msg-${turn}-${i}` };
    const ctx = { workspaceDir, sessionId: 'pri1140-replay-session', trigger: 'user', runId: `run-${turn}-${i}` };
    const t0 = process.hrtime.bigint();
    const priority = await resolveAdaptivePriorityForHook(event, ctx, api);
    const t1 = process.hrtime.bigint();
    const result = await buildActivePrinciplePromptContext({ workspaceDir, roundKey, promptBudget, ...toBuilderPriority(priority) });
    const t2 = process.hrtime.bigint();
    if (i >= 2) {
      providerMs.push(Number(t1 - t0) / 1e6);
      builderMs.push(Number(t2 - t1) / 1e6);
      outputs.add(`${sha256(result.additionalContext)}|${result.activationIds.join(',')}|${result.adaptivePacking?.status ?? '-'}|${result.adaptivePacking?.reason ?? '-'}`);
      if (first === null) first = { priority, result };
      lastLogs = logs;
    }
  }
  return { first, providerMs, builderMs, deterministic: outputs.size === 1, logs: lastLogs };
}

function describeArm(arm, ctx) {
  const { priority, result } = arm.first;
  const text = result.additionalContext;
  const included = result.activationIds;
  const missingVsNative = ctx.nativeIncluded.filter((id) => !included.includes(id));
  const extraVsNative = included.filter((id) => !ctx.nativeIncluded.includes(id));
  return {
    providerPriority: priority ? {
      artifactId: priority.artifactId,
      activationId: priority.activationId,
      additiveOnly: priority.additiveOnly === true,
    } : null,
    adaptivePacking: result.adaptivePacking ? {
      status: result.adaptivePacking.status,
      reason: result.adaptivePacking.reason ?? null,
      targetActivationId: result.adaptivePacking.targetActivationId,
      displacedActivationIds: result.adaptivePacking.displacedActivationIds,
      targetAuthority: result.adaptivePacking.targetSnapshot?.authority ?? null,
    } : null,
    textSha256: sha256(text),
    chars: text.length,
    estTokens: Math.floor(text.length / 4),
    includedActivationIds: included,
    missingVsNative,
    extraVsNative,
    targetCurrentCovered: ctx.targetSlice !== null && text.includes(ctx.targetSlice),
    staleRevisionPresent: text.includes(DELIVERY_V1_TEXT),
    nonLiveIncluded: included.filter((id) => !ctx.liveActivationIds.includes(id)),
    providerMs: { median: round3(median(arm.providerMs)), min: round3(Math.min(...arm.providerMs)), max: round3(Math.max(...arm.providerMs)) },
    builderMs: { median: round3(median(arm.builderMs)), min: round3(Math.min(...arm.builderMs)), max: round3(Math.max(...arm.builderMs)) },
    deterministicAcrossIterations: arm.deterministic,
    providerWarnings: arm.logs.warn.filter((line) => line.includes('[PD:AA]')),
  };
}

// The mapping is workspace-scoped (readAdaptiveActivationConfig rejects a
// mapping whose workspaceDir differs from the hook workspace — silently, by
// design), so every fixture mapping carries its own workspace.
const pinned = (workspaceDir, artifactId, activationId) => ({
  enabled: true, workspaceDir, artifactId, activationId, softTimeoutMs: 15000,
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
});
const principle = (workspaceDir) => ({
  enabled: true, workspaceDir, principleId: 'DELIVERY', softTimeoutMs: 15000,
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
});

const MSG = {
  sentinel: `${SENTINEL}\n请对本次交付给出验收结论`,
  normal: '继续实现下一个模块，并补上单元测试',
  secondLine: `请看一下这次的改动\n${SENTINEL}`,
  natural: '请交付验收：这次改动已经全部完成了吗？',
  agent: `${SENTINEL}\nsourceSession=agent:builder 请验收`,
};

/** Frozen cases (v0.1 §3 + Owner addendum A8). `pin` = the Native arm mapping. */
const CASES = [
  { id: 'A1', category: '交付', shape: 'current', regime: 'ample', pin: ['art-delivery-v2', 'act-delivery-v2'], turns: [{ msg: 'sentinel' }], key: true },
  { id: 'A2', category: '交付/目标已存在', shape: 'current', regime: 'ample', pin: ['art-delivery-v2', 'act-delivery-v2'], turns: [{ msg: 'sentinel', roundKeyOffset: 3 }], key: true },
  { id: 'A3', category: '交付/钉失效-预算充足', shape: 'revised', regime: 'ample', pin: ['art-delivery-v1', 'act-delivery-v1'], turns: [{ msg: 'sentinel' }], key: true },
  { id: 'A4', category: '交付/钉失效-预算紧张', shape: 'revised', regime: 'tight-drop', pin: ['art-delivery-v1', 'act-delivery-v1'], turns: [{ msg: 'sentinel' }], key: true },
  { id: 'A5', category: '交付/候选失效', shape: 'retired', regime: 'ample', pin: ['art-delivery-v1', 'act-delivery-v1'], turns: [{ msg: 'sentinel' }], key: false },
  { id: 'A6', category: '交付/歧义', shape: 'ambiguous', regime: 'ample', pin: ['art-delivery-v2', 'act-delivery-v2'], turns: [{ msg: 'sentinel' }], key: true },
  { id: 'A7', category: '交付/读取降级', shape: 'current', regime: 'ample', pin: ['art-delivery-v2', 'act-delivery-v2'], corrupt: true, turns: [{ msg: 'sentinel' }], key: true },
  { id: 'A8', category: '交付/预算不足反例（Owner 新增）', shape: 'revised', regime: 'tight-drop', pin: ['art-delivery-v2', 'act-delivery-v2'], turns: [{ msg: 'sentinel' }], key: true },
  { id: 'B1', category: '普通执行', shape: 'current', regime: 'ample', pin: ['art-delivery-v2', 'act-delivery-v2'], turns: [{ msg: 'normal' }], key: false },
  { id: 'B2', category: '普通执行/标记非首行', shape: 'current', regime: 'ample', pin: ['art-delivery-v2', 'act-delivery-v2'], turns: [{ msg: 'secondLine' }], key: false },
  { id: 'C1', category: '阶段切换/实现→验收', shape: 'current', regime: 'ample', pin: ['art-delivery-v2', 'act-delivery-v2'], turns: [{ msg: 'normal', roundKeyOffset: 0 }, { msg: 'sentinel', roundKeyOffset: 1 }], key: true },
  { id: 'C2', category: '阶段切换/验收→实现', shape: 'current', regime: 'ample', pin: ['art-delivery-v2', 'act-delivery-v2'], turns: [{ msg: 'sentinel', roundKeyOffset: 0 }, { msg: 'normal', roundKeyOffset: 1 }], key: true },
  { id: 'D1', category: '预算不足/目标超大', shape: 'oversized', regime: 'oversized', pin: ['art-delivery-v2', 'act-delivery-v2'], turns: [{ msg: 'sentinel' }], key: true },
  { id: 'D2', category: '预算不足/需挤出', shape: 'current', regime: 'tight-drop', pin: ['art-delivery-v2', 'act-delivery-v2'], turns: [{ msg: 'sentinel' }], key: true },
  { id: 'E1', category: '信号不明/自然语言', shape: 'current', regime: 'ample', pin: ['art-delivery-v2', 'act-delivery-v2'], turns: [{ msg: 'natural' }], key: false },
  { id: 'E2', category: '信号不明/agent-to-agent', shape: 'current', regime: 'ample', pin: ['art-delivery-v2', 'act-delivery-v2'], turns: [{ msg: 'agent' }], key: false },
];

async function runCase(spec, outDir, iterations) {
  const workspaceDir = path.join(outDir, 'ws', spec.id);
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  await seedWorkspace(workspaceDir, spec.shape, { corrupt: spec.corrupt === true });
  const params = await chooseParams(workspaceDir, spec.regime);
  const live = await readPromptActivationCandidates({ workspaceDir, includeAuthority: true });
  const liveActivationIds = live.principles.map((p) => p.activationId);
  const currentTargets = live.principles.filter((p) => p.principleId === 'DELIVERY');
  const target = currentTargets.length === 1 ? currentTargets[0] : null;
  // Authorization facts (outside timing): what the principle resolution binds
  // to and the authority the production reader annotates on that activation.
  const resolution = await resolveCurrentAuthorizedActivationByPrincipleId({ workspaceDir, principleId: 'DELIVERY' });
  const resolutionFacts = resolution.ok
    ? {
      ok: true,
      artifactId: resolution.artifactId,
      activationId: resolution.activationId,
      authority: live.principles.find((p) => p.activationId === resolution.activationId)?.authority ?? null,
      approvedBy: live.principles.find((p) => p.activationId === resolution.activationId)?.approvedBy ?? null,
    }
    : { ok: false, reason: resolution.reason, readerWarnings: resolution.warnings.length };
  let targetSlice = null;
  if (target) {
    const rendered = renderPrinciplesToDirectives([target], new Set([target.principleId]), { escapeFn: escapeXml });
    targetSlice = rendered.slice(rendered.indexOf('<directive '), rendered.indexOf('</directive>') + '</directive>'.length);
  }
  const turns = [];
  for (let t = 0; t < spec.turns.length; t += 1) {
    const turnSpec = spec.turns[t];
    const roundKey = params.roundKey + (turnSpec.roundKeyOffset ?? 0);
    const message = MSG[turnSpec.msg];
    const native = await buildActivePrinciplePromptContext({ workspaceDir, roundKey, promptBudget: params.promptBudget });
    const ctx = { nativeIncluded: native.activationIds, targetSlice, liveActivationIds };
    const dbBefore = fileSha256(path.join(workspaceDir, '.pd', 'state.db'));
    const nativeArm = await runArm({ workspaceDir, mapping: pinned(workspaceDir, ...spec.pin), message, turn: `${spec.id}-${t}-pinned`, roundKey, promptBudget: params.promptBudget, iterations });
    const candidateArm = await runArm({ workspaceDir, mapping: principle(workspaceDir), message, turn: `${spec.id}-${t}-principle`, roundKey, promptBudget: params.promptBudget, iterations });
    const dbAfter = fileSha256(path.join(workspaceDir, '.pd', 'state.db'));
    const pinnedDesc = describeArm(nativeArm, ctx);
    const candidateDesc = describeArm(candidateArm, ctx);
    // Harness integrity (fail loud): on a genuine delivery-signal round the
    // pinned mapping is always a valid config, so its provider MUST produce a
    // priority. A null here means the harness itself is miswired (e.g. a
    // mapping that silently fails the workspace scope) — never a result.
    if (turnSpec.msg === 'sentinel' && pinnedDesc.providerPriority === null) {
      throw new Error(`harness integrity: pinned provider returned no priority on a sentinel round (${spec.id}#${t})`);
    }
    turns.push({
      turn: t,
      message: turnSpec.msg,
      roundKey,
      budgetChars: params.promptBudget.budgetChars,
      plainNative: {
        textSha256: sha256(native.additionalContext),
        chars: native.additionalContext.length,
        estTokens: Math.floor(native.additionalContext.length / 4),
        includedActivationIds: native.activationIds,
        targetCurrentCovered: targetSlice !== null && native.additionalContext.includes(targetSlice),
      },
      pinnedArm: pinnedDesc,
      principleArm: candidateDesc,
      deltaChars: {
        principleMinusPinned: candidateDesc.chars - pinnedDesc.chars,
        principleMinusPlainNative: candidateDesc.chars - native.additionalContext.length,
      },
      sameTextAsPinned: candidateDesc.textSha256 === pinnedDesc.textSha256,
      sameTextAsPlainNative: candidateDesc.textSha256 === sha256(native.additionalContext),
      resolutionOverheadMs: round3(candidateDesc.providerMs.median - pinnedDesc.providerMs.median),
      stateDbUnchanged: dbBefore === dbAfter,
      failures: {
        unauthorizedInjection: candidateDesc.staleRevisionPresent || candidateDesc.nonLiveIncluded.length > 0,
        requiredContentLoss: candidateDesc.missingVsNative.length > 0,
        onlyTargetMayBeAdded: candidateDesc.extraVsNative.every((id) => target !== null && id === target.activationId),
        keyOpportunityRegressionVsPlainNative: spec.key === true && turnSpec.msg === 'sentinel'
          && (targetSlice !== null && native.additionalContext.includes(targetSlice)) && !candidateDesc.targetCurrentCovered,
      },
    });
  }
  return { caseId: spec.id, category: spec.category, shape: spec.shape, regime: spec.regime, pin: spec.pin, keyOpportunity: spec.key, resolution: resolutionFacts, turns };
}

async function replayDeterminism(outDir, caseIds) {
  const checks = [];
  for (const caseId of caseIds) {
    const spec = CASES.find((entry) => entry.id === caseId);
    const runs = [];
    for (let i = 0; i < 3; i += 1) runs.push(await runCase(spec, path.join(outDir, `f1-${i}`), 3));
    const fingerprint = (run) => run.turns.map((turn) => `${turn.pinnedArm.textSha256}|${turn.principleArm.textSha256}|${turn.principleArm.adaptivePacking?.reason ?? '-'}|${turn.roundKey}|${turn.budgetChars}`).join(';');
    checks.push({ replayOf: caseId, runs: 3, identical: new Set(runs.map(fingerprint)).size === 1, stateDbUnchanged: runs.every((run) => run.turns.every((turn) => turn.stateDbUnchanged)) });
  }
  return checks;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const results = [];
  for (const spec of CASES) {
    results.push(await runCase(spec, outDir, args.iterations));
  }
  const f1 = await replayDeterminism(outDir, ['A4', 'A8']);
  const report = {
    schema: 'pd-pri1140-replay-report/v1',
    commit: args.commit,
    startedAt,
    finishedAt: new Date().toISOString(),
    node: process.version,
    iterationsPerArm: args.iterations,
    modelCalls: 0,
    tokenMethod: 'estTokens = floor(chars / 4) — coarse estimate for reference only; chars is the production budget unit and the judgment currency',
    timingMethod: 'process.hrtime.bigint() wall clock; provider = resolveAdaptivePriorityForHook (includes principle resolution read on the candidate arm), builder = buildActivePrinciplePromptContext; 2 warmups discarded, median/min/max over the measured iterations',
    cases: results,
    f1ReplayDeterminism: f1,
  };
  const reportPath = path.join(outDir, 'pri1140-replay-report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const summary = results.flatMap((entry) => entry.turns.map((turn) => ({
    case: `${entry.caseId}${entry.turns.length > 1 ? `#${turn.turn}` : ''}`,
    pinned: `${turn.pinnedArm.adaptivePacking?.status ?? 'none'}/${turn.pinnedArm.adaptivePacking?.reason ?? '-'}`,
    principle: `${turn.principleArm.adaptivePacking?.status ?? 'none'}/${turn.principleArm.adaptivePacking?.reason ?? (turn.principleArm.providerWarnings.length ? 'refused' : '-')}`,
    pinCov: turn.pinnedArm.targetCurrentCovered,
    prinCov: turn.principleArm.targetCurrentCovered,
    dChars: turn.deltaChars.principleMinusPinned,
    sameNative: turn.sameTextAsPlainNative,
    overheadMs: turn.resolutionOverheadMs,
    fail: Object.entries(turn.failures).filter(([key, value]) => (key === 'onlyTargetMayBeAdded' ? !value : value)).map(([key]) => key).join(',') || '-',
  })));
  console.table(summary);
  console.log(JSON.stringify({ reportPath, f1 }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
