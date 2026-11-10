#!/usr/bin/env node
/**
 * PRI-1105 B line — offline replay for the first optional-content trim rule
 * (delivery rounds: omit ordinary `authority="system_policy"` directives once
 * the delivery target is present). Card:
 * docs/specs/PD-AA-PRI-1105-B-TRIM-IMPLEMENTATION-CARD-v0.1.md.
 *
 * STAGE: pre-approval baseline. Only the Native arm runs here — the candidate
 * arm is added after the Owner approves the card. Each case records the
 * pre-annotation the frozen case list needs: target, must-keep set and the
 * directives the rule WOULD classify as optional (arithmetic over the Native
 * output, not candidate execution).
 *
 * Fidelity:
 * - REAL provider `resolveAdaptivePriorityForHook` (plugin dist) and REAL
 *   shared assembly entry `buildActivePrinciplePromptContext` (host-runtime
 *   dist); provider -> builder forwarding mirrors packages/host-runtime/src/index.ts.
 * - Fixture workspaces are seeded through the real SQLite stores.
 * - Optional real sample: `--real-ws` points at a LOCAL sandbox copy of a
 *   workspace state.db. Its output is desensitized: principle/activation ids
 *   are reported as sha256 prefixes, no principle text leaves the machine.
 * - Zero model calls, zero network. Nothing is written outside --out and the
 *   sandbox/fixture workspaces.
 *
 * Budget unit = chars (production `budgetChars`). Tokens are reported as
 * unknown: no reliable tokenizer is available for the mixed CJK text.
 *
 * Usage (repository root, after building host-runtime + plugin):
 *   node scripts/dev/aa-selector/pri1105b-trim-replay.mjs --out .tmp/pri-1105-b/baseline --commit <sha>
 *     [--real-ws <sandbox workspace dir> --real-target <12-hex sha256 prefix of the target principleId>]
 *     [--iterations 15]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';
import {
  SqliteActivationStateStore,
  SqliteConnection,
  getDefaultPdConfig,
  resolvePromptBudget,
  measureSharedDirectiveBlockChars,
  sharedDirectiveBaseChars,
} from '@principles/core/runtime';
import { escapeXml } from '@principles/core/prompt-builder';
import { buildActivePrinciplePromptContext, readPromptActivationCandidates } from '@principles/host-runtime';
import { resolveAdaptivePriorityForHook } from 'principles-disciple';

const SENTINEL = '[PD-AA:delivery-review:v1]';
const OPTIONAL_AUTHORITY = 'system_policy';

function parseArgs(argv) {
  const args = { out: null, commit: null, iterations: 15, realWs: null, realTarget: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--out') { args.out = value; i += 1; }
    else if (key === '--commit') { args.commit = value; i += 1; }
    else if (key === '--iterations') { args.iterations = Number(value); i += 1; }
    else if (key === '--real-ws') { args.realWs = value; i += 1; }
    else if (key === '--real-target') { args.realTarget = value; i += 1; }
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!args.out) throw new Error('--out <dir> is required');
  if (!args.commit || !/^[0-9a-f]{7,40}$/.test(args.commit)) throw new Error('--commit <sha> is required');
  if (!Number.isSafeInteger(args.iterations) || args.iterations < 3 || args.iterations > 200) {
    throw new Error('--iterations must be an integer in [3, 200]');
  }
  if ((args.realWs === null) !== (args.realTarget === null)) throw new Error('--real-ws and --real-target go together');
  if (args.realTarget !== null && !/^[0-9a-f]{12}$/.test(args.realTarget)) throw new Error('--real-target must be a 12-hex sha256 prefix');
  return args;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const short = (text) => sha256(text).slice(0, 12);

function fileSha256(file) {
  return fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const round3 = (value) => Math.round(value * 1000) / 1000;

// ── Fixtures ────────────────────────────────────────────────────────────────

const DELIVERY_TEXT = '交付验收前以可观察证据自检：先列出验收基准与已有证据；缺证据时如实限定结论；不重复已验证的昂贵检查。';
const ORDINARY = [
  { id: 'O1-scope', text: '只修改与任务直接相关的文件，邻近改进记为后续事项。', approved: true },
  { id: 'O2-evidence', text: '结论以仓库当前代码与运行证据为准，不凭记忆或旧文档。'.repeat(2), approved: true },
  { id: 'O3-tests', text: '修复缺陷时先写能复现问题的回归测试，再改实现。', approved: false },
  { id: 'O4-secrets', text: '不在源码、日志或测试中写入可用凭据字面量；凭据只从环境或密钥服务读取。', approved: true },
  { id: 'O5-ask', text: '目标冲突或授权不明时先向 Owner 求证，再执行受限操作。'.repeat(2), approved: false },
  { id: 'O6-small', text: '优先最小可行改动，避免为假设的未来需求预建抽象。', approved: true },
];

/**
 * shape: 'mixed' (O3/O5 system_policy, target owner) | 'target-sp' (target has
 * no approval row) | 'all-owner' (every ordinary approved) | 'retired' (the
 * target's only activation is deactivated). `corrupt` adds an unreadable artifact.
 */
async function seedWorkspace(workspaceDir, shape, { corrupt = false } = {}) {
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(getDefaultPdConfig()), 'utf8');
  const connection = new SqliteConnection(workspaceDir);
  try {
    const db = connection.getDb();
    const insertArtifact = db.prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, 'principle', ?, ?, '[]', 'validated', ?, ?, ?)
    `);
    const approve = db.prepare(`
      INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at, decided_at, decided_by)
      VALUES (?, ?, 'prompt', 'low', 'approved', 1, ?, ?, 'owner-replay')
    `);
    const store = new SqliteActivationStateStore(connection);
    const baseTime = Date.UTC(2026, 10, 9, 8, 0, 0);
    let index = 0;
    const add = async ({ principleId, text, approved, deactivated = false, content }) => {
      const at = new Date(baseTime + index * 1000).toISOString();
      index += 1;
      const artifactId = `art-${principleId}`;
      insertArtifact.run(artifactId, `task-${artifactId}`, principleId, content ?? JSON.stringify({ principleId, text }), at, at);
      await store.recordActivation({
        activationId: `act-${principleId}`,
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
      await add({ principleId: entry.id, text: entry.text, approved: shape === 'all-owner' ? true : entry.approved });
    }
    await add({ principleId: 'DELIVERY', text: DELIVERY_TEXT, approved: shape !== 'target-sp', deactivated: shape === 'retired' });
    if (corrupt) await add({ principleId: 'BROKEN', text: '', approved: false, content: '{not-json' });
  } finally {
    connection.close();
  }
}

// ── Provider/builder driving (mirrors packages/host-runtime/src/index.ts) ──

function makeApi(mapping) {
  const logs = { info: [], warn: [], error: [] };
  return {
    logs,
    api: {
      pluginConfig: mapping ? { adaptiveActivation: mapping } : {},
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

function mappingFor(workspaceDir, identity) {
  return {
    enabled: true,
    workspaceDir,
    ...identity,
    softTimeoutMs: 15000,
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
}

/**
 * One round, measured: warmup 2 + `iterations` timed runs. `builderExtra`
 * carries builder-only inputs (mandatoryPrincipleIds) that no production
 * caller passes today.
 */
async function runRound({ workspaceDir, mapping, message, roundKey, promptBudget, iterations, builderExtra = {} }) {
  const providerMs = [];
  const builderMs = [];
  const outputs = new Set();
  let first = null;
  for (let i = 0; i < iterations + 2; i += 1) {
    const { api } = makeApi(mapping);
    const event = { prompt: message, messages: [], currentUserMessage: message, currentUserMessageId: `msg-${i}` };
    const ctx = { workspaceDir, sessionId: 'pri1105b-replay-session', trigger: 'user', runId: `run-${i}` };
    const t0 = process.hrtime.bigint();
    const priority = await resolveAdaptivePriorityForHook(event, ctx, api);
    const t1 = process.hrtime.bigint();
    const result = await buildActivePrinciplePromptContext({
      workspaceDir,
      ...(roundKey !== undefined ? { roundKey } : {}),
      promptBudget,
      ...toBuilderPriority(priority),
      ...builderExtra,
    });
    const t2 = process.hrtime.bigint();
    if (i >= 2) {
      providerMs.push(Number(t1 - t0) / 1e6);
      builderMs.push(Number(t2 - t1) / 1e6);
      outputs.add(`${sha256(result.additionalContext)}|${result.activationIds.join(',')}|${result.adaptivePacking?.status ?? '-'}|${result.adaptivePacking?.reason ?? '-'}`);
      if (first === null) first = { priority, result };
    }
  }
  return { ...first, providerMs: round3(median(providerMs)), builderMs: round3(median(builderMs)), deterministic: outputs.size === 1 };
}

/**
 * Pre-annotation of one Native outcome under the proposed rule. The rule only
 * applies when the delivery target is in the final assembly (status
 * target_present | prioritized); target, mandatory ids, owner-approved and
 * unknown-authority directives are always must-keep.
 */
function annotate({ result, candidates, targetPrincipleId, mandatoryIds = [], selfReportEnabled, redact }) {
  const byActivation = new Map(candidates.map((p) => [p.activationId, p]));
  const included = result.activationIds.map((id) => byActivation.get(id)).filter(Boolean);
  const status = result.adaptivePacking?.status ?? 'none';
  const ruleApplies = status === 'target_present' || status === 'prioritized';
  const opts = { escapeFn: escapeXml, selfReportInstruction: selfReportEnabled };
  const optional = ruleApplies
    ? included.filter((p) => p.authority === OPTIONAL_AUTHORITY && p.principleId !== targetPrincipleId && !mandatoryIds.includes(p.principleId))
    : [];
  const mustKeep = included.filter((p) => !optional.includes(p));
  const id = (value) => (redact ? short(value) : value);
  const targetEntry = result.injectedExpectations?.find((entry) => byActivation.get(entry.activationId)?.principleId === targetPrincipleId);
  return {
    status,
    reason: result.adaptivePacking?.reason ?? null,
    finalChars: result.additionalContext.length,
    finalSha256: sha256(result.additionalContext),
    tokens: 'unknown',
    targetPresent: targetEntry?.bodyComplete === true,
    included: {
      total: included.length,
      owner: included.filter((p) => p.authority === 'owner').length,
      system_policy: included.filter((p) => p.authority === OPTIONAL_AUTHORITY).length,
      unknown: included.filter((p) => p.authority !== 'owner' && p.authority !== OPTIONAL_AUTHORITY).length,
    },
    mustKeep: mustKeep.map((p) => id(p.principleId)),
    ruleApplies,
    optionalByRule: optional.map((p) => id(p.principleId)),
    optionalChars: optional.reduce((sum, p) => sum + measureSharedDirectiveBlockChars(p, opts), 0),
    displacedActivationIds: (result.adaptivePacking?.displacedActivationIds ?? []).map(id),
    droppedActivationIds: (result.droppedActivationIds ?? []).map(id),
    warnings: result.warnings.filter((w) => !w.startsWith('prompt_context_truncated')).length,
  };
}

// ── Real sample (local sandbox copy; desensitized output) ──────────────────

async function realSample(args) {
  const workspaceDir = path.resolve(args.realWs);
  const stateDb = path.join(workspaceDir, '.pd', 'state.db');
  const dbBefore = fileSha256(stateDb);
  const read = await readPromptActivationCandidates({ workspaceDir, includeAuthority: true });
  if (read.aborted || read.warnings.length > 0) throw new Error(`real sample read degraded: ${read.warnings.length} warnings`);
  const target = read.principles.find((p) => short(p.principleId) === args.realTarget);
  if (!target) throw new Error('real target principle not found by hash');
  const defaults = resolvePromptBudget();
  const rounds = [];
  const plan = [
    ...Array.from({ length: read.principles.length }, (_, k) => ({ caseId: `R-4000-k${k + 1}`, budgetChars: 4000, roundKey: k + 1 })),
    { caseId: 'R-4000-FIFO', budgetChars: 4000, roundKey: undefined },
    { caseId: 'R-15625-k1', budgetChars: 15625, roundKey: 1 },
  ];
  const variants = [
    { mapping: 'principle', identity: { principleId: target.principleId }, message: `${SENTINEL}\n交付验收` },
    { mapping: 'pinned', identity: { artifactId: target.artifactId, activationId: target.activationId }, message: `${SENTINEL}\n交付验收` },
  ];
  for (const step of plan) {
    for (const variant of variants) {
      const round = await runRound({
        workspaceDir,
        mapping: mappingFor(workspaceDir, variant.identity),
        message: variant.message,
        roundKey: step.roundKey,
        promptBudget: { ...defaults, budgetChars: step.budgetChars },
        iterations: args.iterations,
      });
      rounds.push({
        caseId: `${step.caseId}-${variant.mapping}`,
        source: 'real_sample',
        mapping: variant.mapping,
        budgetChars: step.budgetChars,
        roundKey: step.roundKey ?? null,
        ...annotate({ result: round.result, candidates: read.principles, targetPrincipleId: target.principleId, selfReportEnabled: read.selfReportEnabled, redact: true }),
        providerMs: round.providerMs,
        builderMs: round.builderMs,
        deterministic: round.deterministic,
      });
    }
  }
  // Ordinary (no sentinel) round: the provider must stay silent.
  const ordinary = await runRound({
    workspaceDir,
    mapping: mappingFor(workspaceDir, { principleId: target.principleId }),
    message: '普通执行请求',
    roundKey: 1,
    promptBudget: { ...defaults, budgetChars: 4000 },
    iterations: args.iterations,
  });
  rounds.push({
    caseId: 'R-4000-k1-ordinary', source: 'real_sample', mapping: 'principle', budgetChars: 4000, roundKey: 1,
    providerReturned: ordinary.priority !== undefined,
    ...annotate({ result: ordinary.result, candidates: read.principles, targetPrincipleId: target.principleId, selfReportEnabled: read.selfReportEnabled, redact: true }),
    providerMs: ordinary.providerMs, builderMs: ordinary.builderMs, deterministic: ordinary.deterministic,
  });
  return {
    candidates: read.principles.length,
    byAuthority: read.principles.reduce((acc, p) => ({ ...acc, [p.authority ?? 'unknown']: (acc[p.authority ?? 'unknown'] ?? 0) + 1 }), {}),
    targetPrincipleHash: args.realTarget,
    targetAuthority: target.authority ?? 'unknown',
    selfReportEnabled: read.selfReportEnabled,
    baseChars: sharedDirectiveBaseChars({ escapeFn: escapeXml, selfReportInstruction: read.selfReportEnabled }),
    stateDbSha256: { before: dbBefore, after: fileSha256(stateDb) },
    rounds,
  };
}

// ── Synthetic fixture cases ─────────────────────────────────────────────────

const FIXTURE_CASES = [
  { caseId: 'FX-1', shape: 'mixed', mapping: 'principle', regime: 'ample', label: '正例：目标在场，普通 system_policy 在装配内' },
  { caseId: 'FX-2', shape: 'target-sp', mapping: 'pinned', regime: 'ample', label: '目标本身为 system_policy（目标必保）' },
  { caseId: 'FX-3', shape: 'mixed', mapping: 'pinned', regime: 'ample', label: '必需项为 system_policy（builder 级 mandatoryPrincipleIds）', mandatory: ['O3-tests'] },
  { caseId: 'FX-4', shape: 'mixed', mapping: 'principle', regime: 'ample', corrupt: true, label: '读取降级（资格无法核实）' },
  { caseId: 'FX-5', shape: 'mixed', mapping: 'principle', regime: 'tight-drop', label: '预算不足：additive 门槛回退 Native' },
  { caseId: 'FX-6', shape: 'mixed', mapping: 'pinned', regime: 'tight-drop', label: '预算不足：钉死路径既有挤出语义后再判' },
  { caseId: 'FX-7', shape: 'mixed', mapping: 'principle', regime: 'ample', ordinary: true, label: '普通轮次（无交付信号）' },
  { caseId: 'FX-8', shape: 'all-owner', mapping: 'principle', regime: 'ample', label: '无可省项（全部 Owner 批准）' },
  { caseId: 'FX-9', shape: 'retired', mapping: 'principle', regime: 'ample', label: '候选失效：目标已下线' },
];

function blockCosts(principles) {
  const opts = { escapeFn: escapeXml, selfReportInstruction: false };
  return {
    base: sharedDirectiveBaseChars(opts),
    costs: new Map(principles.map((p) => [p.activationId, measureSharedDirectiveBlockChars(p, opts)])),
  };
}

/** Same deterministic parameter search as the PRI-1140 harness. */
async function chooseParams(workspaceDir, regime) {
  const candidates = await readPromptActivationCandidates({ workspaceDir, includeAuthority: true });
  const target = candidates.principles.find((p) => p.principleId === 'DELIVERY');
  const { base, costs } = blockCosts(candidates.principles);
  const total = base + [...costs.values()].reduce((sum, value) => sum + value, 0);
  const defaults = resolvePromptBudget();
  if (regime === 'ample' || !target) return { roundKey: 1, promptBudget: { ...defaults, budgetChars: total + 64 } };
  const targetCost = costs.get(target.activationId);
  for (let roundKey = 1; roundKey <= candidates.principles.length; roundKey += 1) {
    for (let budgetChars = total - 1; budgetChars >= base + targetCost; budgetChars -= 7) {
      const promptBudget = { ...defaults, budgetChars };
      const native = await buildActivePrinciplePromptContext({ workspaceDir, roundKey, promptBudget });
      if (!native.activationIds.includes(target.activationId) && native.activationIds.length > 0) return { roundKey, promptBudget };
    }
  }
  throw new Error(`no tight-drop parameters found for ${workspaceDir}`);
}

async function fixtureCases(args) {
  const results = [];
  for (const spec of FIXTURE_CASES) {
    const workspaceDir = path.resolve(args.out, 'fixtures', spec.caseId);
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    await seedWorkspace(workspaceDir, spec.shape, { corrupt: spec.corrupt === true });
    const stateDb = path.join(workspaceDir, '.pd', 'state.db');
    const dbBefore = fileSha256(stateDb);
    const { roundKey, promptBudget } = await chooseParams(workspaceDir, spec.regime);
    const identity = spec.mapping === 'principle'
      ? { principleId: 'DELIVERY' }
      : { artifactId: 'art-DELIVERY', activationId: 'act-DELIVERY' };
    const round = await runRound({
      workspaceDir,
      mapping: mappingFor(workspaceDir, identity),
      message: spec.ordinary ? '普通执行请求' : `${SENTINEL}\n交付验收`,
      roundKey,
      promptBudget,
      iterations: args.iterations,
      builderExtra: spec.mandatory ? { mandatoryPrincipleIds: spec.mandatory } : {},
    });
    const candidates = await readPromptActivationCandidates({ workspaceDir, includeAuthority: true });
    results.push({
      caseId: spec.caseId,
      source: 'synthetic_fixture',
      label: spec.label,
      shape: spec.shape,
      mapping: spec.mapping,
      regime: spec.regime,
      budgetChars: promptBudget.budgetChars,
      roundKey,
      providerReturned: round.priority !== undefined,
      ...annotate({ result: round.result, candidates: candidates.principles, targetPrincipleId: 'DELIVERY', mandatoryIds: spec.mandatory ?? [], selfReportEnabled: false, redact: false }),
      providerMs: round.providerMs,
      builderMs: round.builderMs,
      deterministic: round.deterministic,
      stateDbUnchanged: dbBefore === fileSha256(stateDb),
    });
  }
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.out, { recursive: true });
  const report = {
    harness: 'pri1105b-trim-replay',
    stage: 'pre_approval_baseline_native_arm_only',
    commit: args.commit,
    harnessSha256: fileSha256(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
    generatedAt: new Date().toISOString(),
    iterations: args.iterations,
    modelCalls: 0,
    measurement: { currency: 'chars (budgetChars unit, UTF-16 code units)', tokens: 'unknown', timing: 'process.hrtime.bigint median, 2 warmups discarded' },
    rule: `ordinary directives with authority="${OPTIONAL_AUTHORITY}" are optional only when the delivery target is in the final assembly; target, mandatory, owner and unknown-authority directives are must-keep`,
    fixtures: await fixtureCases(args),
    ...(args.realWs ? { realSample: await realSample(args) } : {}),
  };
  const outFile = path.join(args.out, 'baseline-report.json');
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 1)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, outFile, reportSha256: fileSha256(outFile) }));
}

await main();
