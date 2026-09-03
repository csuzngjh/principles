/**
 * Phase 0 Spike driver (tasks.md 1.2) — 价值验证阻塞门.
 *
 * 问题：只给**摘要级上下文**（每个 stage 一个 headline + 结构化 fields，
 * 不含 `evidence` / 全量 `candidates` / `implementationCode` 等原始大字段），
 * evaluator 能否指出「哪一段（pain_to_dreamer / dreamer_to_scribe /
 * scribe_to_artificer）丢了哪个维度」，且对照链不被误报？
 *
 * 这个门只有在**真实 LLM** 从摘要级上下文独立判断时才有意义（ERR-088：
 * 断言信号必须唯一指向被验证的路径）。因此：
 *   - 没有任何手写启发式 / 字符串匹配替代 LLM 判断；
 *   - LLM 不可达时测试**显式失败**并报 `LLM_UNAVAILABLE`（阻塞是合法结论，
 *     模拟通过不是）；
 *   - 摘要构造是确定性纯函数，且**不为了让答案对而调参**。
 *
 * 判断路由（Layer 2 尚不存在，如实记录保真度）：
 *   Route A（主）：spike-local prompt，要求 LLM 输出 design §6.5 的
 *     `segments[] / compressionFidelity / painCoverage` 形状。今天的
 *     `EvaluatorOutputV2` 没有 `painCoverage` / `compressionFidelity`
 *     （它们是 Layer 2 增量），所以这条路由用 spike-local prompt 承载判断，
 *     字段构成照抄 design §6.5，注入字段照抄 `EVALUATOR_STAGE1_MANIFEST`。
 *   Route B（对照）：生产 `EvaluatorPromptBuilder` + 生产
 *     `DefaultEvaluatorValidator`，上下文换成摘要级 stand-in。用来记录
 *     「今天的 prompt 在摘要级上下文下会把判断落在 `evaluation.concerns` /
 *     `codeReview` 的哪里」。
 *
 * I/O 边界：本文件是 `*.test.ts`，按 eslint.config.js 的 PRI-450/462 豁免
 * 允许 fs / child_process；core 生产代码仍是纯逻辑（AGENTS.md
 * `antipattern-core-io`）。LLM 进程由生产同一个 `runCliProcess` 拉起
 * （与 `OpenClawCliRuntimeAdapter` 相同的 spawn 语义）。
 *
 * ERR 清单：ERR-088（测试真实性：不用「没抛错」当依据，断言具体 segment /
 * dimension），ERR-001 / ERR-005（LLM 输出保持 unknown 直到逐字段校验，
 * 不用 `as` 绕过），ERR-013（读 unknown 键一律 `Object.hasOwn`），
 * ERR-002（每条降级/不可达都带结构化原因，不静默跳过）。
 *
 * 2026-07-28 修订（design §12.1 的实测驱动修复，门禁重跑）：
 *   - 维度不再是「五个等权」：`DIMENSION_COVERAGE_POLICY`（§6.5.1）把
 *     `betterDecision` / `rationale` / `riskLevel` 定为 required，`badDecision`
 *     为 optional（出现在 antiPatterns 即覆盖，**缺失不算缺陷**），
 *     `strategicPerspective` 为 excluded（判据不得对它下结论）。
 *   - 覆盖判定口径（§6.5.2 六条）写进 prompt，不再让模型自己发明尺子。
 *   - 判据侧按政策过滤 LLM 给的 `missingDimensions`（§6.5.3）：模型仍可能把
 *     optional / excluded / 不认识的字符串塞进去（rc-1 / rc-4 不可信输入），
 *     一律忽略并记成 shape warning，不据此判失败。
 *
 * 2026-07-29 第四次门禁重跑（design §12.1「第三次门禁重跑」结论 4/5，Owner 已授权修补第 7 条规则冲突）：
 *   - **第 7 条「看不见即不裁决」的字面表述改窄**：第三次重跑中模型把「scribe 没有一个
 *     字面叫 riskLevel 的字段」误读成「riskLevel 在这一段不可判定」，导致缺陷链 A 的
 *     dreamer_to_scribe 段判 pass。改后明确「看不见」指的是「维度值本身在 dreamer 的
 *     injectedFields 里都没注入过」，不是「下游字段没有同名字段」——scribe 本来就没有
 *     riskLevel/betterDecision 这类字段，它只有 principleText/scope 自由文本字段，
 *     这条规则不应被读成「因此不判定」。这是**判据内部规则冲突的修补**，不是对模型
 *     行为的第三次拟合：冲突在设计阶段就存在，只是前两次重跑的链条形态没有精确命中它
 *     （对照链的 scribe 文本本身就含风险等级词，不会触发这条歧义）。
 *   - 按 §6.5.2 止损规则，本条本应是「不再调整判据」，但 Owner 已明确审阅根因分析并
 *     授权本次修补（判据内部规则冲突 ≠ 拟合模型行为），故本次修正记为止损规则下的
 *     显式例外，不视为规则被违反。
 *
 * 2026-07-28 第三次门禁重跑（design §6.5.2 clause 2 / §6.5.4 / §12.1 第二次重跑记录）：
 *   - **具体性子句**：`betterDecision` 的覆盖判定同时要求存在性与具体性 ——
 *     把可核验动作（审计文件树 / grep 全部 imports / 检查导出依赖图）换成不可核验
 *     的抽象（理解架构 / 掌握整体结构）**不算覆盖**。第二次重跑正是因为口径只写了
 *     「存在语义等价表述」，模型检出抽象化后仍裁定为覆盖，缺陷链 B 退化为 `pass`。
 *     这是**判据的最后一次修正**（§6.5.2 止损规则）。
 *   - **输出契约路径**：回复经仓库既有的结构化输出修复通道
 *     （`attemptStructuredOutputRepair` + `output-repair-contract` 助手）处理，
 *     本文件不再自带 JSON 提取器；`llm_unavailable`（模型没答）与
 *     `output_contract_violation`（答了但信封坏了）分两个桶、两条断言。
 *   - **结果文件带运行时间戳**：`.kiro/` 是 git-ignored，第二次重跑覆盖了第一次的原始记录。
 *   - Route B 本次不跑（第二次重跑中挂在传输层超时；纯记录性路由，不参与门禁判定）。
 *
 * @see .kiro/specs/internalization-progressive-disclosure/design.md §6.1 / §6.5.1 / §6.5.2 / §6.5.3 / §6.6.1 / §12.1
 * @see Requirements 12.3、12.4
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { runCliProcess } from '../../utils/cli-process-runner.js';
import { EvaluatorPromptBuilder } from '../evaluator-prompt-builder.js';
import { DefaultEvaluatorValidator } from '../evaluator-output.js';
// design §6.5.4：输出契约违规必须走**仓库既有**的结构化输出修复通道，
// 不得在本文件里再实现一份 JSON 提取器 / 修复循环。
import {
  attemptStructuredOutputRepair,
  extractJsonObject,
  type SchemaValidationError,
} from '../../adapter/structured-output-repair.js';
import { repairMalformedJson } from '../../adapter/json-extractor.js';
import {
  MAX_REPAIR_ATTEMPTS,
  normalizeMaxRepairAttempts,
  safeStringifyPreview,
} from '../../adapter/output-repair-contract.js';
import {
  SPIKE_CHAINS,
  assertSpikeChainLineageConsistent,
  type SpikeChain,
  type SpikeStageKind,
} from './progressive-disclosure-spike-fixtures.js';

// ── 摘要级上下文的确定性构造（mirrors design §6.1 派生映射表）────────────────
//
// 这是 Spike 本地实现：Layer 0 的 `deriveArtifactSummary` 还不存在（它属于
// PR 1 / 任务 3.2，被 Phase 0 门禁阻塞）。字段选择与截断上限照抄 design §6.1，
// 目的是让 Spike 看到的信息量与 Layer 0 上线后一致 —— 既不多给（不含原始大
// 字段），也不少给。

const SUMMARY_HEADLINE_MAX_CHARS = 200;
const SUMMARY_FIELD_MAX_CHARS = 600;

interface SpikeStageSummary {
  readonly runnerKind: SpikeStageKind;
  readonly headline: string;
  readonly fields: Readonly<Record<string, string>>;
  /** rc-9：派生时跳过的目标键，缺失必须显式可见，不静默省略。 */
  readonly omittedFields: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** rc-1 / rc-5：unknown 上按自有属性读字符串，空串视为缺失。 */
function readString(source: unknown, key: string): string | null {
  if (!isRecord(source) || !Object.hasOwn(source, key)) return null;
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value;
}

function readRecord(source: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(source) || !Object.hasOwn(source, key)) return null;
  const value = source[key];
  return isRecord(value) ? value : null;
}

function readArray(source: unknown, key: string): readonly unknown[] | null {
  if (!isRecord(source) || !Object.hasOwn(source, key)) return null;
  const value = source[key];
  return Array.isArray(value) ? value : null;
}

/** rc-4：数组元素逐个校验为字符串后再拼接。 */
function readStringList(source: unknown, key: string): string | null {
  const list = readArray(source, key);
  if (list === null) return null;
  const strings = list.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
  if (strings.length === 0) return null;
  return strings.join(' / ');
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** 首句：以中文句号 / 分号 / 英文句点为界，确定性截断。 */
function firstSentence(text: string): string {
  const match = /^[\s\S]*?[。；;.]/.exec(text);
  const sentence = match?.[0] ?? text;
  return clamp(sentence.trim(), SUMMARY_HEADLINE_MAX_CHARS);
}

/** 派生一个 stage 的摘要：目标键缺失即进 omittedFields（design §6.1）。 */
// eslint-disable-next-line @typescript-eslint/max-params -- spike fixture DSL mirrors the design §6.1 derivation shape (kind, targetKeys, headlineSource, resolved); grouping into an options object would diverge from the 8 literal call sites below.
function deriveSpikeSummary(
  runnerKind: SpikeStageKind,
  targetKeys: readonly string[],
  headlineSource: string | null,
  resolved: Readonly<Record<string, string | null>>,
): SpikeStageSummary {
  const fields: Record<string, string> = {};
  const omittedFields: string[] = [];
  for (const key of targetKeys) {
    const value = Object.hasOwn(resolved, key) ? resolved[key] : null;
    if (typeof value === 'string' && value.trim() !== '') {
      fields[key] = clamp(value, SUMMARY_FIELD_MAX_CHARS);
    } else {
      omittedFields.push(key);
    }
  }
  return {
    runnerKind,
    headline: headlineSource === null ? '' : firstSentence(headlineSource),
    fields,
    omittedFields,
  };
}

/**
 * 8 个 stage 的摘要。字段名是 design §6.1 的**目标键名**；实际 output schema
 * 里不存在该语义的键一律进 `omittedFields`（不改 schema、不改 prompt）。
 */
function buildChainSummaries(chain: SpikeChain): Readonly<Record<SpikeStageKind, SpikeStageSummary>> {
  // rc-1：fixture 的 contentJson 一律按 unknown 读，不用 `as` 收窄（rc-2）
  const rootCause: unknown = chain.diagRootCause.contentJson;
  const distiller: unknown = chain.diagDistiller.contentJson;
  const router: unknown = chain.diagRouter.contentJson;
  const dreamer: unknown = chain.dreamer.contentJson;
  const philosopher: unknown = chain.philosopher.contentJson;
  const scribe: unknown = chain.scribe.contentJson;
  const artificer: unknown = chain.artificer.contentJson;
  const evaluator: unknown = chain.evaluator.contentJson;

  // dreamer：只取第一个候选的五维（全量 candidates 属 tier2 原始大字段，排除）
  const candidates = readArray(dreamer, 'candidates') ?? [];
  const firstCandidate = candidates.length > 0 ? candidates[0] : null;

  const principleDraft = readRecord(scribe, 'principleDraft');
  const principleCandidate = readRecord(philosopher, 'principleCandidate');
  const violated = readArray(router, 'violatedPrinciples') ?? [];
  const violatedIds = violated
    .map((entry) => readString(entry, 'principleId'))
    .filter((id): id is string => id !== null);
  const recommendations = readArray(router, 'recommendations') ?? [];
  const firstRecommendationKind =
    recommendations.length > 0 ? readString(recommendations[0], 'kind') : null;
  const evaluatorEvaluation = readRecord(evaluator, 'evaluation');
  const evaluatorConcerns = evaluatorEvaluation === null ? null : readArray(evaluatorEvaluation, 'concerns');
  const evaluatorCodeReview = readRecord(evaluator, 'codeReview');
  const intentConsistency = evaluatorCodeReview === null ? null : readRecord(evaluatorCodeReview, 'intentConsistency');

  return {
    diag_rootcause: deriveSpikeSummary(
      'diag_rootcause',
      ['rootSymptom', 'category', 'severity', 'rootCause'],
      readString(rootCause, 'rootCause'),
      {
        rootSymptom: readString(rootCause, 'summary'),
        category: readString(rootCause, 'rootCauseCategory'),
        // DiagRootCauseOutputV1 没有 severity 语义字段 → omitted
        severity: null,
        rootCause: readString(rootCause, 'rootCause'),
      },
    ),
    diag_distiller: deriveSpikeSummary(
      'diag_distiller',
      ['rootCause', 'affectedComponents', 'category', 'severity'],
      readString(distiller, 'abstractedPrinciple'),
      {
        rootCause: readString(distiller, 'rationale'),
        // DiagDistillerOutputV1 没有 affectedComponents / severity → omitted
        affectedComponents: null,
        category: readString(distiller, 'scope'),
        severity: null,
      },
    ),
    diag_router: deriveSpikeSummary(
      'diag_router',
      ['rootCause', 'affectedComponents', 'rootSymptom', 'category', 'severity'],
      readString(router, 'summary'),
      {
        rootCause: readString(router, 'rootCause'),
        affectedComponents: violatedIds.length > 0 ? violatedIds.join(' / ') : null,
        rootSymptom: readString(router, 'summary'),
        category: firstRecommendationKind,
        severity: null,
      },
    ),
    dreamer: deriveSpikeSummary(
      'dreamer',
      ['badDecision', 'betterDecision', 'rationale', 'riskLevel', 'strategicPerspective'],
      readString(firstCandidate, 'betterDecision'),
      {
        badDecision: readString(firstCandidate, 'badDecision'),
        betterDecision: readString(firstCandidate, 'betterDecision'),
        rationale: readString(firstCandidate, 'rationale'),
        riskLevel: readString(firstCandidate, 'riskLevel'),
        strategicPerspective: readString(firstCandidate, 'strategicPerspective'),
      },
    ),
    philosopher: deriveSpikeSummary(
      'philosopher',
      ['thesis', 'principleTitle', 'principleScope', 'principleConfidence'],
      principleCandidate === null ? null : readString(principleCandidate, 'title'),
      {
        thesis: readString(philosopher, 'thesis'),
        principleTitle: principleCandidate === null ? null : readString(principleCandidate, 'title'),
        principleScope: principleCandidate === null ? null : readString(principleCandidate, 'scope'),
        principleConfidence:
          principleCandidate !== null
          && Object.hasOwn(principleCandidate, 'confidence')
          && typeof principleCandidate.confidence === 'number'
            ? String(principleCandidate.confidence)
            : null,
      },
    ),
    scribe: deriveSpikeSummary(
      'scribe',
      ['principleText', 'scope', 'exceptions'],
      principleDraft === null ? null : readString(principleDraft, 'statement'),
      {
        principleText: principleDraft === null ? null : readString(principleDraft, 'statement'),
        scope: principleDraft === null ? null : readStringList(principleDraft, 'applicability'),
        exceptions: principleDraft === null ? null : readStringList(principleDraft, 'antiPatterns'),
      },
    ),
    artificer: deriveSpikeSummary(
      'artificer',
      ['changedFiles', 'apiSurface', 'risks'],
      readString(artificer, 'implementationSummary'),
      {
        // 原始 implementationCode 属 tier2 大字段，摘要级只给受影响工具与摘要
        changedFiles: readStringList(artificer, 'affectedTools'),
        apiSurface: readString(artificer, 'implementationSummary'),
        risks: readStringList(artificer, 'risks'),
      },
    ),
    evaluator: deriveSpikeSummary(
      'evaluator',
      ['verdict', 'concernCount', 'intentConsistency'],
      evaluatorEvaluation === null ? null : readString(evaluatorEvaluation, 'summary'),
      {
        verdict: evaluatorEvaluation === null ? null : readString(evaluatorEvaluation, 'decision'),
        concernCount: evaluatorConcerns === null ? null : String(evaluatorConcerns.length),
        intentConsistency:
          intentConsistency !== null
          && Object.hasOwn(intentConsistency, 'aligned')
          && typeof intentConsistency.aligned === 'boolean'
            ? String(intentConsistency.aligned)
            : null,
      },
    ),
  };
}

/**
 * 注入字段集合 = `EVALUATOR_STAGE1_MANIFEST` 的 tier0 ∪ tier1（design §6.6）。
 * 逐字对齐，不额外加字段 —— Spike 看到的必须就是 Layer 1 会给的。
 */
const EVALUATOR_STAGE1_PATHS: readonly string[] = [
  // tier0
  'artificer.summary.headline',
  'artificer.predecessorSummary.headline',
  // tier1
  'scribe.summary.principleText',
  'scribe.summary.scope',
  'artificer.summary.changedFiles',
  'artificer.summary.apiSurface',
  'artificer.summary.risks',
  'dreamer.summary.badDecision',
  'dreamer.summary.betterDecision',
  'dreamer.summary.rationale',
  'dreamer.summary.riskLevel',
  'diagnostician.summary.rootSymptom',
  'diagnostician.summary.category',
];

interface SummaryLevelContext {
  readonly fields: Readonly<Record<string, string>>;
  readonly absent: readonly string[];
}

function buildEvaluatorStage1Context(chain: SpikeChain): SummaryLevelContext {
  const summaries = buildChainSummaries(chain);
  const source: Readonly<Record<string, string | undefined>> = {
    'artificer.summary.headline': summaries.artificer.headline,
    // 一层冗余：artificer 的边上前驱是 scribe（design §6.1 前驱表）
    'artificer.predecessorSummary.headline': summaries.scribe.headline,
    'scribe.summary.principleText': summaries.scribe.fields.principleText,
    'scribe.summary.scope': summaries.scribe.fields.scope,
    'artificer.summary.changedFiles': summaries.artificer.fields.changedFiles,
    'artificer.summary.apiSurface': summaries.artificer.fields.apiSurface,
    'artificer.summary.risks': summaries.artificer.fields.risks,
    'dreamer.summary.badDecision': summaries.dreamer.fields.badDecision,
    'dreamer.summary.betterDecision': summaries.dreamer.fields.betterDecision,
    'dreamer.summary.rationale': summaries.dreamer.fields.rationale,
    'dreamer.summary.riskLevel': summaries.dreamer.fields.riskLevel,
    'diagnostician.summary.rootSymptom': summaries.diag_rootcause.fields.rootSymptom,
    'diagnostician.summary.category': summaries.diag_rootcause.fields.category,
  };

  const fields: Record<string, string> = {};
  const absent: string[] = [];
  for (const path of EVALUATOR_STAGE1_PATHS) {
    const value = Object.hasOwn(source, path) ? source[path] : undefined;
    if (typeof value === 'string' && value.trim() !== '') {
      fields[path] = value;
    } else {
      absent.push(path);
    }
  }
  return { fields, absent };
}

// ── LLM 传输（与生产 OpenClawCliRuntimeAdapter 同一个 runCliProcess）─────────

const LLM_TIMEOUT_MS = 420_000;
const REPO_ROOT = join(process.cwd(), '..', '..');
const SPIKE_TMP_DIR = join(REPO_ROOT, '.spike-tmp', 'spike-1.2');
/**
 * 结果文件名带运行时间戳：`.kiro/` 是 git-ignored，第二次重跑覆盖掉了第一次的
 * 原始记录（无法再回看首轮原文）。带时间戳后每次重跑各留一份。
 */
const RUN_TIMESTAMP = new Date().toISOString();
const RESULTS_PATH = join(
  REPO_ROOT,
  '.kiro',
  'specs',
  'internalization-progressive-disclosure',
  `phase0-spike-1.2-raw-results-${RUN_TIMESTAMP.replace(/[:.]/g, '-')}.json`,
);

/**
 * 传输层结果。design §6.5.4 要求把两种失败**分桶**，因此这里只区分
 * 「模型没答」（`unavailable`）与「模型答了」（`reply`）；「答了但信封坏了」
 * 属于输出契约违规，由 `resolveRouteAContract` 判定，绝不混进 unavailable。
 */
type AgentTransportResult =
  | {
    readonly kind: 'unavailable';
    /** spawn 失败 / 超时 / 空 stdout / 信封里没有回复文本 */
    readonly reason: string;
    readonly rawText: string;
  }
  | {
    readonly kind: 'reply';
    /** rc-1：LLM 原文保持字符串，解析后的值保持 unknown 直到逐字段校验。 */
    readonly rawText: string;
  };

/**
 * 从 openclaw `--json` 信封里取出 agent 回复文本（local / gateway / 裸对象三种形态）。
 *
 * 兜底顺序：平衡括号扫描找 `payloads[].text` → 整体 `JSON.parse` → 直接抓
 * `finalAssistantVisibleText`（信封里同一份回复的另一处出口）。三条都失败才
 * 判定为拿不到回复，理由分别可区分（rc-9）。
 */
function extractAgentText(stdout: string, stderr: string): string | null {
  for (const source of [stdout, stderr]) {
    if (!source) continue;
    const objects: unknown[] = [];
    let depth = 0;
    let start = -1;
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (ch === '{') {
        if (start === -1) start = i;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0 && start !== -1) {
          try {
            objects.push(JSON.parse(source.slice(start, i + 1)));
          } catch {
            // keep scanning
          }
          start = -1;
        }
      }
    }
    for (let i = objects.length - 1; i >= 0; i--) {
      const candidate = objects[i];
      const payloads =
        readArray(candidate, 'payloads')
        ?? readArray(readRecord(candidate, 'result'), 'payloads');
      if (payloads !== null && payloads.length > 0) {
        const text = readString(payloads[payloads.length - 1], 'text');
        if (text !== null) return text;
      }
    }

    // 兜底 1：整体 JSON.parse（stdout 可能是被换行包裹的单个对象）
    try {
      const whole: unknown = JSON.parse(source);
      const payloads =
        readArray(whole, 'payloads') ?? readArray(readRecord(whole, 'result'), 'payloads');
      if (payloads !== null && payloads.length > 0) {
        const text = readString(payloads[payloads.length - 1], 'text');
        if (text !== null) return text;
      }
    } catch {
      // 继续兜底 2
    }

    // 兜底 2：信封的 meta.finalAssistantVisibleText / finalAssistantRawText
    const visible = /"final(?:AssistantVisibleText|AssistantRawText)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(source);
    const captured = visible?.[1];
    if (captured !== undefined && captured.trim() !== '') {
      try {
        const decoded: unknown = JSON.parse(`"${captured}"`);
        if (typeof decoded === 'string' && decoded.trim() !== '') return decoded;
      } catch {
        // 放弃该兜底
      }
    }
  }
  return null;
}

/**
 * `runCliProcess` 自己做 Windows 的 .cmd shim 解析（resolveCommandForWindows），
 * 所以这里传裸命令名即可；ENOENT 会以 `spawnError` 形式回来 → LLM_UNAVAILABLE。
 */
const OPENCLAW_BINARY = 'openclaw';

/**
 * 显式指定模型（2026-07-28 第三次门禁重跑）。
 *
 * 第三次重跑三条链全部 `exit_code:1`，`llm_unavailable` 桶正确捕获。stderr 证据
 * 显示根因**不在判据也不在 prompt**：配置的默认模型返回
 * `404 model route not found`，failover 无候选 →
 * `FailoverError: The selected model was not found by the provider`。
 *
 * 因此 Spike 不再依赖 openclaw 的默认模型（它会随 Owner 的全局配置漂移），改为
 * 显式传 `--model`：既让「模型不可用」这类环境问题一眼可辨，也避免为了跑 Spike
 * 去改 Owner 的全局 `~/.openclaw/openclaw.json`（那超出本任务的改动边界）。
 * 可用 `PD_SPIKE_MODEL` 覆盖。
 */
const SPIKE_MODEL = process.env.PD_SPIKE_MODEL ?? 'sensenova/deepseek-v4-flash';

async function askAgent(label: string, message: string): Promise<AgentTransportResult> {
  mkdirSync(SPIKE_TMP_DIR, { recursive: true });
  const messagePath = join(SPIKE_TMP_DIR, `${label}-${Date.now()}.json`);
  writeFileSync(messagePath, message, 'utf8');
  try {
    const result = await runCliProcess({
      command: OPENCLAW_BINARY,
      args: [
        'agent',
        '--agent', 'main',
        // 显式模型：见 SPIKE_MODEL 注释（默认模型 404 曾让整轮门禁误判为不可达）
        '--model', SPIKE_MODEL,
        '--message-file', messagePath,
        '--session-id', `pd-spike-1-2-${label}-${Date.now()}`,
        '--json',
        '--timeout', String(Math.floor(LLM_TIMEOUT_MS / 1000)),
      ],
      // 传输层约束（由 .spike-tmp 的 probe4 / probe5 对照实验确定）：在
      // vitest 的环境标记（NODE_ENV=test / VITEST=*）与 package 级 cwd 下，
      // openclaw 的 embedded agent 会以 exit 0 + **空 stdout** 结束（stderr 只留
      // 一条 gateway fallback 提示）。同一 payload 在仓库根 cwd + 非 test 环境下
      // 正常返回。因此这里显式还原成生产式环境，否则 LLM 判断根本不会发生。
      cwd: REPO_ROOT,
      env: {
        NODE_ENV: 'production',
        VITEST: '',
        VITEST_WORKER_ID: '',
        VITEST_POOL_ID: '',
        VITEST_MODE: '',
      },
      timeoutMs: LLM_TIMEOUT_MS,
    });

    if (result.spawnError !== undefined) {
      return { kind: 'unavailable', reason: `spawn_error:${result.spawnError}`, rawText: result.stderr };
    }
    if (result.timedOut) {
      return { kind: 'unavailable', reason: 'timeout', rawText: result.stderr };
    }
    // 诊断留痕：整份 stdout / stderr 落盘，便于在 Spike 结论里逐字引用不可达原因
    writeFileSync(join(SPIKE_TMP_DIR, `${label}.stdout.txt`), result.stdout, 'utf8');
    writeFileSync(join(SPIKE_TMP_DIR, `${label}.stderr.txt`), result.stderr, 'utf8');

    if (result.exitCode !== 0) {
      return {
        kind: 'unavailable',
        reason: `exit_code:${String(result.exitCode)}`,
        rawText: `${result.stdout}\n${result.stderr}`.slice(0, 4000),
      };
    }

    if (result.stdout.trim() === '') {
      return { kind: 'unavailable', reason: 'empty_stdout', rawText: result.stderr.slice(-4000) };
    }

    const text = extractAgentText(result.stdout, result.stderr);
    if (text === null) {
      return {
        kind: 'unavailable',
        reason: 'no_agent_text_in_envelope',
        rawText: `${result.stdout}\n${result.stderr}`.slice(0, 4000),
      };
    }
    // 拿到回复文本即为「模型答了」。信封是否合法由输出契约通道判定（design §6.5.4）。
    return { kind: 'reply', rawText: text };
  } finally {
    rmSync(messagePath, { force: true });
  }
}

// ── Route A：spike-local 三段式 prompt（字段照抄 design §6.5）────────────────

const SEGMENTS = ['pain_to_dreamer', 'dreamer_to_scribe', 'scribe_to_artificer'] as const;
type SegmentId = (typeof SEGMENTS)[number];
const VERDICTS = ['pass', 'degraded', 'fail'] as const;
type SegmentVerdict = (typeof VERDICTS)[number];

// ── 维度覆盖政策（照抄 design §6.5.1 的 DIMENSION_COVERAGE_POLICY）──────────
//
// Spike-local 复制：`progressive-evaluator.ts` 属 Layer 2（任务 9.x），被本门禁
// 阻塞，还不存在。政策取值与顺序逐字对齐 design §6.5.1，本文件不得自行调级。

type DreamerDimension =
  | 'badDecision' | 'betterDecision' | 'rationale' | 'riskLevel' | 'strategicPerspective';
type DimensionCoverageClass = 'required' | 'optional' | 'excluded';

const DIMENSION_COVERAGE_POLICY: Readonly<Record<DreamerDimension, DimensionCoverageClass>> = {
  betterDecision: 'required',
  rationale: 'required',
  riskLevel: 'required',
  badDecision: 'optional',
  strategicPerspective: 'excluded',
};

/** 由政策表派生，顺序稳定（确定性输出）。 */
const REQUIRED_FIDELITY_DIMENSIONS: readonly DreamerDimension[] = [
  'betterDecision',
  'rationale',
  'riskLevel',
];

const OPTIONAL_FIDELITY_DIMENSIONS: readonly DreamerDimension[] = ['badDecision'];
const EXCLUDED_FIDELITY_DIMENSIONS: readonly DreamerDimension[] = ['strategicPerspective'];

/**
 * rc-5 / ERR-013：以 LLM 字符串为键查表用 `Map`，不用普通对象索引
 * （`table['__proto__']` 会命中 `Object.prototype`）。
 */
const POLICY_BY_LOWERCASE_NAME: ReadonlyMap<string, DimensionCoverageClass> = new Map(
  Object.entries(DIMENSION_COVERAGE_POLICY).map(([name, coverageClass]) => [
    name.toLowerCase(),
    coverageClass,
  ]),
);

/**
 * rc-1 / rc-4：LLM 给的维度名是不可信输入。按政策表分类，认不出来的一律 unknown，
 * 不做任何猜测性归并（大小写与首尾空白容错，因为那是书写形式而非语义差异）。
 */
function classifyDimension(raw: string): DimensionCoverageClass | 'unknown' {
  return POLICY_BY_LOWERCASE_NAME.get(raw.trim().toLowerCase()) ?? 'unknown';
}

interface PolicyPartition {
  /** 唯一构成缺陷的部分（design §6.5.3：filterRequired(...).length > 0）。 */
  readonly required: readonly string[];
  /** optional 维度被模型错放进 missingDimensions —— 忽略，不算缺陷。 */
  readonly optional: readonly string[];
  /** excluded 或不认识的字符串 —— 忽略，不算缺陷。 */
  readonly ignored: readonly string[];
}

function partitionByPolicy(values: readonly string[]): PolicyPartition {
  const required: string[] = [];
  const optional: string[] = [];
  const ignored: string[] = [];
  for (const value of values) {
    switch (classifyDimension(value)) {
      case 'required':
        required.push(value);
        break;
      case 'optional':
        optional.push(value);
        break;
      default:
        ignored.push(value);
        break;
    }
  }
  return { required, optional, ignored };
}

/** rc-2：用类型守卫收窄 LLM 给的字符串，不用 `as`。 */
function isSegmentId(value: string): value is SegmentId {
  return SEGMENTS.some((segment) => segment === value);
}

function isSegmentVerdict(value: string): value is SegmentVerdict {
  return VERDICTS.some((verdict) => verdict === value);
}

const ROUTE_A_INSTRUCTION = `你是内化管道的 Evaluator。你只能看到每一跳的**摘要级上下文**（headline + 结构化字段），看不到任何原始大字段（没有 pain 证据全文、没有 dreamer 全量候选、没有 artificer 实现代码）。

管道是一条逐级压缩的信息链：pain/诊断 → dreamer（维度：badDecision / betterDecision / rationale / riskLevel / strategicPerspective）→ scribe（原则文本）→ artificer（实现）。每一跳都可能丢字段或把具体动作模糊成抽象表述。

你的任务：判断这条链上是否发生了信息丢失或语义模糊。若有，指出**发生在哪一段**以及**丢了哪个维度**。若没有，如实判 pass —— 不要为了显得严谨而编造缺失。

三段的定义：
- pain_to_dreamer：pain/诊断的根因与症状，是否在 dreamer 的决策里被覆盖。
- dreamer_to_scribe：dreamer 的维度，是否在 scribe 的原则文本里被保留（维度值本身丢失，或具体动作被抽象化，都算缺陷）。
- scribe_to_artificer：scribe 原则文本的约束意图，是否在 artificer 的实现摘要里被忠实实现。

【维度分级政策】（**不是五个等权维度**，必须严格按下面分级判定，不得自行升级或降级）
- required（必需，缺失即缺陷）：${REQUIRED_FIDELITY_DIMENSIONS.join(' / ')}。
- optional（可选，缺失**不是**缺陷）：${OPTIONAL_FIDELITY_DIMENSIONS.join(' / ')}。它出现在原则文本的 antiPatterns（反模式/禁止行为清单）里即算覆盖；**不出现不算缺陷**，只写进 optionalUncovered，禁止写进 missingDimensions，也禁止因此把 verdict 判成 degraded 或 fail。
- excluded（不参与判定）：${EXCLUDED_FIDELITY_DIMENSIONS.join(' / ')}。**不得对它下任何结论**：不得写进 missingDimensions，不得写进 optionalUncovered，不得因它影响任何 verdict，也不要在 detail 里把它当成缺失。

【覆盖判定口径】（口径由本 prompt 规定，不要自行发明；同一条链上各维度必须用同一把尺）
1. 覆盖 = **语义等价的对应表述存在**。允许改写、允许换词、允许合并进其他句子；不要求逐字出现，也不要求出现字段名。**但本条不是一张空白许可**：这里的「改写」指用不同措辞表达**同一份可核验内容**；**抽象化不是改写**（见第 2 条）——把可核验的具体动作换成无法核验的概括属于内容丢失，不在本条允许范围内。第 1 条与第 2 条**必须连读**，只按第 1 条判定即误用。
2. **betterDecision 的覆盖必须同时满足存在性与具体性**。仅当**可核验的具体动作被保留**时才算覆盖。把具体、可核验的动作（例如「审计文件树」「grep 全部 imports」「检查导出依赖图」）替换为**无法核验的抽象表述**（例如「理解架构」「掌握整体结构」「充分评估」）**不算覆盖**——即使抽象表述在语义上指向同一意图、即使核心意图被保留。此时必须把 betterDecision 写进该段的 missingDimensions，并且 compressionFidelity.betterDecisionCovered = false。判定依据只有一条：该表述能否让 Owner 或一段规则代码**判断它有没有被执行**；不能，即为具体性丢失，即不算覆盖。
3. riskLevel：以风险等级词（high / medium / low 或中文等价）**或**等价的风险描述（例如「跨包改动一旦漏掉调用方会直接编译失败」）体现，两者任一即算覆盖。
4. badDecision：出现在 antiPatterns（反模式/禁止行为清单）即算覆盖；**不出现不算缺陷**。
5. strategicPerspective：不参与保真度判定，不要对它下结论，也不得让它出现在 missingDimensions 里。
6. 未覆盖必须**指名 required 维度名**（${REQUIRED_FIDELITY_DIMENSIONS.join(' / ')}），不得只给定性描述，也不得填别的名字。
7. **看不见即不裁决，但这条只管「维度的值本身从未被注入过」，不管「下游字段没有同名字段」**：某个维度（riskLevel / betterDecision / rationale / badDecision）由 dreamer 产生，只要 \`dreamer.summary.<维度名>\` 出现在下面的 injectedFields 里，这个维度就**已经可判定**，即使 scribe / artificer 那一跳没有一个字面叫同样名字的字段——scribe 本来就没有 riskLevel / betterDecision 这类字段，它只有 principleText / scope 这类自由文本字段，dreamer_to_scribe 段要判的正是「dreamer 已注入的维度值，有没有被 scribe 的自由文本吸收」，**不是「scribe 有没有一个同名字段」**。只有当某个维度在 dreamer 的 injectedFields 里也完全不存在时，才适用「看不见即不裁决」，判定为该维度在此链路上不可判定，不得据此报缺失。

【verdict 规则】
- 某段的 required 维度全部覆盖 → verdict = "pass"，missingDimensions = []。optional 维度未覆盖**不影响** pass。
- 该段有 required 维度缺失 → "degraded"（部分丢失）或 "fail"（约束意图整体丢失），并在 missingDimensions 里指名。
- 某段判定 required 维度所需的字段在 injectedFields 里根本不存在 → "degraded"，并在 detail 里说明缺哪个字段，不要猜。

只输出下面这个 JSON 对象，不要 markdown 代码围栏，不要任何解释性文字：
{"segments":[{"segment":"pain_to_dreamer","verdict":"pass|degraded|fail","missingDimensions":[],"optionalUncovered":[],"detail":"简述依据"},{"segment":"dreamer_to_scribe","verdict":"pass|degraded|fail","missingDimensions":["riskLevel"],"optionalUncovered":["badDecision"],"detail":"简述依据"},{"segment":"scribe_to_artificer","verdict":"pass|degraded|fail","missingDimensions":[],"optionalUncovered":[],"detail":"简述依据"}],"compressionFidelity":{"betterDecisionCovered":true,"rationaleCovered":true,"riskLevelCovered":false,"badDecisionCovered":true,"missingDimensions":["riskLevel"],"optionalUncovered":[],"explanation":"简述依据"},"painCoverage":{"fullyCovered":true,"uncoveredAspects":[],"explanation":"简述依据"}}

约束：
- 不要调用任何工具，不要读写任何文件，直接基于下面给出的字段作答（这是传输层约束，不影响判断内容）。
- segments 必须恰好三条，segment 取值必须是 pain_to_dreamer / dreamer_to_scribe / scribe_to_artificer。
- verdict 必须是 pass / degraded / fail 之一。
- missingDimensions **只能**含 required 维度名（${REQUIRED_FIDELITY_DIMENSIONS.join(' / ')}）；没有缺失就给空数组。
- optionalUncovered **只能**含 optional 维度名（${OPTIONAL_FIDELITY_DIMENSIONS.join(' / ')}）；没有就给空数组。它只是诊断参考，不是缺陷。
- compressionFidelity 里**没有** strategicPerspectiveCovered 字段，不要补上。`;

interface RouteASegment {
  readonly segment: SegmentId;
  readonly verdict: SegmentVerdict;
  /** 模型原样给出的 missingDimensions（未过滤，留痕用）。 */
  readonly rawMissingDimensions: readonly string[];
  /** 政策过滤后**只含 required 维度**的缺失（design §6.5.3 的 filterRequired）。 */
  readonly missingDimensions: readonly string[];
  /** optional 维度未覆盖：模型声明的 + 被它错放进 missingDimensions 的。 */
  readonly optionalUncovered: readonly string[];
  readonly detail: string;
}

interface RouteAJudgment {
  readonly segments: readonly RouteASegment[];
  /** 政策过滤后的 `compressionFidelity.missingDimensions`（required-only）。 */
  readonly compressionFidelityMissing: readonly string[];
  readonly compressionFidelityMissingRaw: readonly string[];
  readonly compressionFidelityOptionalUncovered: readonly string[];
  readonly painFullyCovered: boolean | null;
  /**
   * 形状偏差（不是判断内容的缺陷）：例如把 `compressionFidelity` / `painCoverage`
   * 塞进 `segments` 数组里，或把 optional / excluded 维度塞进 `missingDimensions`。
   * 记录下来供 Spike 结论引用，但不据此判门禁失败 —— 门禁问的是「能否点名段与
   * 维度」，不是「弱模型能否输出完美 JSON」（design §6.5.3：stage1Output 是不可信
   * 输入，判据自己过滤，不因此判失败）。
   */
  readonly shapeWarnings: readonly string[];
}

/** design §6.5.3 的 flagged 判据（spike 子集，见 evaluateSpikeFlagged 注释）。 */
type SpikeFlaggedReason = 'missing_dimensions' | 'pain_not_fully_covered';

interface SpikeFlaggedDecision {
  readonly flagged: boolean;
  readonly reasons: readonly SpikeFlaggedReason[];
  /** rc-3 / rc-9：判据依据不全时记原因，不静默当作「通过」。 */
  readonly undetermined: readonly string[];
}

/**
 * flagged = reasons 非空（design §6.5.3 的后置条件）。
 *
 * 与生产判据的两个差异，如实记录而非悄悄折衷：
 *   - 第一条判据只看 **required 维度缺失**（政策过滤后），不是
 *     `missingDimensions.length > 0`；optionalUncovered 永不进 reasons。
 *   - 第三条判据 `implementationFidelity.score < 0.7` 不在本 Spike 的 prompt 形状里
 *     （`implementationFidelity` 属 Layer 2 增量，Route A 不索取），因此它既不进
 *     reasons 也不进 undetermined —— 它不是「依据缺失」，而是本次判定范围之外。
 */
function evaluateSpikeFlagged(judgment: RouteAJudgment): SpikeFlaggedDecision {
  const reasons: SpikeFlaggedReason[] = [];
  const undetermined: string[] = [];
  if (judgment.compressionFidelityMissing.length > 0) {
    reasons.push('missing_dimensions');
  }
  if (judgment.painFullyCovered === false) {
    reasons.push('pain_not_fully_covered');
  }
  if (judgment.painFullyCovered === null) {
    undetermined.push('painCoverage.fullyCovered missing from reply');
  }
  return { flagged: reasons.length > 0, reasons, undetermined };
}

/**
 * 容错读取 `compressionFidelity` / `painCoverage`：既接受顶层，也接受被模型
 * 误塞进 `segments` 数组元素里的形态（实测 sensenova-flash-lite 会这样写）。
 */
function findNestedRecord(parsed: unknown, key: string): Record<string, unknown> | null {
  const top = readRecord(parsed, key);
  if (top !== null) return top;
  const rawSegments = readArray(parsed, 'segments');
  if (rawSegments === null) return null;
  for (const entry of rawSegments) {
    const nested = readRecord(entry, key);
    if (nested !== null) return nested;
  }
  return null;
}

/** rc-2 / rc-3 / rc-4：逐字段校验 LLM 输出，不用 `as` 收窄，缺失即失败。 */
function validateRouteA(parsed: unknown): { ok: true; value: RouteAJudgment } | { ok: false; errors: readonly string[] } {
  const errors: string[] = [];
  if (!isRecord(parsed)) return { ok: false, errors: ['reply is not an object'] };

  const shapeWarnings: string[] = [];
  const rawSegments = readArray(parsed, 'segments');
  const segments: RouteASegment[] = [];
  if (rawSegments === null) {
    errors.push('segments must be an array');
  } else {
    for (const entry of rawSegments) {
      const segment = readString(entry, 'segment');
      const verdict = readString(entry, 'verdict');
      if (segment === null || !isSegmentId(segment)) {
        shapeWarnings.push(`segments[] entry without a valid segment id: ${String(segment)}`);
        continue;
      }
      if (verdict === null || !isSegmentVerdict(verdict)) {
        errors.push(`segments[].verdict invalid for ${segment}: ${String(verdict)}`);
        continue;
      }
      // rc-4：数组元素逐个校验为字符串，再按政策表过滤（design §6.5.3）
      const missingRaw = (readArray(entry, 'missingDimensions') ?? []).filter(
        (v): v is string => typeof v === 'string',
      );
      const declaredOptional = (readArray(entry, 'optionalUncovered') ?? []).filter(
        (v): v is string => typeof v === 'string',
      );
      const partition = partitionByPolicy(missingRaw);
      if (partition.optional.length > 0) {
        shapeWarnings.push(
          `${segment}.missingDimensions contained optional dimensions (ignored per policy): ${partition.optional.join(', ')}`,
        );
      }
      if (partition.ignored.length > 0) {
        shapeWarnings.push(
          `${segment}.missingDimensions contained excluded/unknown entries (ignored per policy): ${partition.ignored.join(', ')}`,
        );
      }
      segments.push({
        segment,
        verdict,
        rawMissingDimensions: missingRaw,
        missingDimensions: partition.required,
        optionalUncovered: [...declaredOptional, ...partition.optional],
        detail: readString(entry, 'detail') ?? '',
      });
    }
  }

  // rc-3：三段必须齐全，缺一即判定不可用（不能静默当作「没问题」）
  for (const required of SEGMENTS) {
    if (!segments.some((s) => s.segment === required)) {
      errors.push(`segment missing from reply: ${required}`);
    }
  }

  const fidelity = findNestedRecord(parsed, 'compressionFidelity');
  if (fidelity !== null && readRecord(parsed, 'compressionFidelity') === null) {
    shapeWarnings.push('compressionFidelity was nested inside segments[] instead of top level');
  }
  const fidelityMissingRaw = (
    fidelity === null ? [] : readArray(fidelity, 'missingDimensions') ?? []
  ).filter((v): v is string => typeof v === 'string');
  const fidelityDeclaredOptional = (
    fidelity === null ? [] : readArray(fidelity, 'optionalUncovered') ?? []
  ).filter((v): v is string => typeof v === 'string');
  const fidelityPartition = partitionByPolicy(fidelityMissingRaw);
  if (fidelityPartition.optional.length > 0) {
    shapeWarnings.push(
      `compressionFidelity.missingDimensions contained optional dimensions (ignored per policy): ${fidelityPartition.optional.join(', ')}`,
    );
  }
  if (fidelityPartition.ignored.length > 0) {
    shapeWarnings.push(
      `compressionFidelity.missingDimensions contained excluded/unknown entries (ignored per policy): ${fidelityPartition.ignored.join(', ')}`,
    );
  }
  if (fidelity !== null && Object.hasOwn(fidelity, 'strategicPerspectiveCovered')) {
    shapeWarnings.push(
      'compressionFidelity carried strategicPerspectiveCovered (excluded dimension; ignored per policy)',
    );
  }
  const painCoverage = findNestedRecord(parsed, 'painCoverage');
  if (painCoverage !== null && readRecord(parsed, 'painCoverage') === null) {
    shapeWarnings.push('painCoverage was nested inside segments[] instead of top level');
  }
  let painFullyCovered: boolean | null = null;
  if (painCoverage !== null && Object.hasOwn(painCoverage, 'fullyCovered') && typeof painCoverage.fullyCovered === 'boolean') {
    painFullyCovered = painCoverage.fullyCovered;
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      segments,
      compressionFidelityMissing: fidelityPartition.required,
      compressionFidelityMissingRaw: fidelityMissingRaw,
      compressionFidelityOptionalUncovered: [
        ...fidelityDeclaredOptional,
        ...fidelityPartition.optional,
      ],
      painFullyCovered,
      shapeWarnings,
    },
  };
}

function buildRouteAMessage(chain: SpikeChain, context: SummaryLevelContext): string {
  return JSON.stringify({
    instruction: ROUTE_A_INSTRUCTION,
    contextLevel: 'summary_only',
    manifestId: 'evaluator.stage1.v1',
    excludedRawFields: ['pain.raw.evidence', 'dreamer.raw.candidates', 'artificer.raw.implementationCode'],
    injectedFields: context.fields,
    absentFields: context.absent,
    chainId: chain.chainId,
  });
}

// ── 输出契约通道（design §6.5.4）───────────────────────────────────────────────
//
// 第二次门禁重跑的首要失败形态是「判断内容正确但信封损坏」：`painCoverage` 被写成
// 兄弟对象、外层对象从未闭合，3/3 不可解析。这里**复用仓库既有通道**处理该路径：
//   1. `extractJsonObject`（adapter/json-extractor，经 structured-output-repair 再导出）
//      —— 处理 markdown 围栏与前后散文；
//   2. `repairMalformedJson`（同一模块）—— 本地语法修复，不花 LLM 往返；
//   3. `attemptStructuredOutputRepair` —— 有界重试（`normalizeMaxRepairAttempts` /
//      `MAX_REPAIR_ATTEMPTS`）、逐次刷新错误（rc-7 / ERR-015 / ERR-018 / ERR-019）、
//      产出 `repairAttempts` 证据。
// 本文件不再自带 brace 扫描器（旧 `extractJsonObject` 已删）。

const ROUTE_A_SCHEMA_REF = 'spike.routeA.stage1.v1';

/** 供修复 prompt 用的目标形状描述（`RepairConfig.schemaSummary`，PRI-271 A2）。 */
const ROUTE_A_SCHEMA_SUMMARY = [
  '  segments: object[] (required) — 恰好 3 条，segment ∈ {pain_to_dreamer, dreamer_to_scribe, scribe_to_artificer}',
  '  segments[].verdict: enum(pass | degraded | fail) (required)',
  '  segments[].missingDimensions: string[] (required) — 只含 required 维度名',
  '  segments[].optionalUncovered: string[] (required)',
  '  segments[].detail: string (required)',
  '  compressionFidelity: object (required) — **顶层键**，不得放进 segments 数组',
  '  compressionFidelity.{betterDecisionCovered,rationaleCovered,riskLevelCovered,badDecisionCovered}: boolean (required)',
  '  compressionFidelity.{missingDimensions,optionalUncovered}: string[] (required)',
  '  compressionFidelity.explanation: string (required)',
  '  painCoverage: object (required) — **顶层键**，与 compressionFidelity 平级，不得写成 segments 的兄弟对象',
  '  painCoverage.fullyCovered: boolean (required)',
  '  painCoverage.uncoveredAspects: string[] (required)',
  '  painCoverage.explanation: string (required)',
].join('\n');

/** 本 Spike 允许的 LLM 修复往返次数（上限由 MAX_REPAIR_ATTEMPTS 收口）。 */
const ROUTE_A_REPAIR_ATTEMPTS = normalizeMaxRepairAttempts(2, MAX_REPAIR_ATTEMPTS);

/** 把本地形状校验错误转成修复通道的错误形状（不引入新的错误类型）。 */
function toSchemaValidationErrors(errors: readonly string[]): SchemaValidationError[] {
  return errors.map((message) => ({ path: ROUTE_A_SCHEMA_REF, message, value: undefined }));
}

type RouteAContractResolution =
  | {
    readonly kind: 'ok';
    readonly judgment: RouteAJudgment;
    readonly repairAttempts: number;
    readonly repaired: boolean;
  }
  | {
    /** 模型答了，但形状在修复后仍非法 —— 与 llm_unavailable 是两个桶。 */
    readonly kind: 'output_contract_violation';
    readonly errors: readonly string[];
    readonly repairAttempts: number;
    readonly rawPreview: string;
  };

/**
 * 从回复文本解析 + 校验 Route A 判定；失败则经既有修复通道有界重试。
 *
 * rc-1 / rc-2：解析结果保持 `unknown`，一律经 `validateRouteA` 逐字段校验后才使用；
 * 修复通道的 `output` 也不用 `as` 收窄（泛参显式给 `unknown`）。
 * rc-9 / ERR-002：修复失败带 `repairAttempts` 与经 `safeStringifyPreview` 截断的原文预览。
 */
async function resolveRouteAContract(
  label: string,
  rawText: string,
): Promise<RouteAContractResolution> {
  const firstPass: unknown = extractJsonObject(rawText) ?? repairMalformedJson(rawText);
  if (firstPass !== null) {
    const validated = validateRouteA(firstPass);
    if (validated.ok) {
      return { kind: 'ok', judgment: validated.value, repairAttempts: 0, repaired: false };
    }
  }

  const initialErrors =
    firstPass === null
      ? ['reply text contains no parseable JSON object (unbalanced or mis-nested envelope)']
      : (() => {
        const validated = validateRouteA(firstPass);
        return validated.ok ? [] : validated.errors;
      })();

  let repairRound = 0;
  const repair = await attemptStructuredOutputRepair<unknown>(
    firstPass ?? rawText,
    toSchemaValidationErrors(initialErrors),
    {
      llmCaller: async (prompt: string): Promise<string | null> => {
        repairRound += 1;
        const call = await askAgent(`${label}-repair${String(repairRound)}`, prompt);
        return call.kind === 'reply' ? call.rawText : null;
      },
      schemaCheck: (value: unknown): boolean => validateRouteA(value).ok,
      // rc-7：每一轮读当轮的新错误，不复用上一轮的陈旧错误
      schemaErrors: (value: unknown): SchemaValidationError[] => {
        const validated = validateRouteA(value);
        return validated.ok ? [] : toSchemaValidationErrors(validated.errors);
      },
    },
    {
      maxRepairAttempts: ROUTE_A_REPAIR_ATTEMPTS,
      schemaRef: ROUTE_A_SCHEMA_REF,
      schemaSummary: ROUTE_A_SCHEMA_SUMMARY,
      // 回复本体 ~2-3 KB：预览必须覆盖全文，否则模型看不到自己写坏的那一段
      maxRawOutputChars: 8000,
      _testJitterMs: 0,
    },
  );

  if (repair.repaired) {
    const validated = validateRouteA(repair.output);
    if (validated.ok) {
      return {
        kind: 'ok',
        judgment: validated.value,
        repairAttempts: repair.attemptsUsed,
        repaired: true,
      };
    }
    return {
      kind: 'output_contract_violation',
      errors: validated.errors,
      repairAttempts: repair.attemptsUsed,
      rawPreview: safeStringifyPreview(repair.output, 1200),
    };
  }

  return {
    kind: 'output_contract_violation',
    errors: initialErrors.length > 0 ? initialErrors : [repair.repairSummary],
    repairAttempts: repair.attemptsUsed,
    rawPreview: safeStringifyPreview(firstPass ?? rawText, 1200),
  };
}

// ── Route B：生产 evaluator prompt + 生产 validator，上下文换成摘要级 ────────

function buildRouteBMessage(chain: SpikeChain, context: SummaryLevelContext): string {
  const builder = new EvaluatorPromptBuilder();
  const { message } = builder.buildPrompt({
    taskId: chain.evaluator.taskId,
    contextHash: `spike-summary-${chain.chainId}`,
    sourceArtificerArtifactId: chain.artificer.artifactId,
    // 摘要级 stand-in：只含 headline + 结构化字段，无 implementationCode
    artificerArtifact: {
      summary: {
        headline: context.fields['artificer.summary.headline'],
        changedFiles: context.fields['artificer.summary.changedFiles'],
        apiSurface: context.fields['artificer.summary.apiSurface'],
        risks: context.fields['artificer.summary.risks'],
      },
      predecessorSummary: {
        runnerKind: 'scribe',
        headline: context.fields['artificer.predecessorSummary.headline'],
      },
      upstreamSummaries: {
        dreamer: {
          badDecision: context.fields['dreamer.summary.badDecision'],
          betterDecision: context.fields['dreamer.summary.betterDecision'],
          rationale: context.fields['dreamer.summary.rationale'],
          riskLevel: context.fields['dreamer.summary.riskLevel'],
        },
        pain: {
          rootSymptom: context.fields['diagnostician.summary.rootSymptom'],
          category: context.fields['diagnostician.summary.category'],
        },
      },
      absentFields: context.absent,
    },
    scribeArtifact: {
      summary: {
        principleText: context.fields['scribe.summary.principleText'],
        scope: context.fields['scribe.summary.scope'],
      },
    },
  });
  return message;
}

// ── Spike 结果记录 ───────────────────────────────────────────────────────────

interface ChainRouteARecord {
  readonly chainId: string;
  readonly label: string;
  readonly expectedDefect: unknown;
  readonly injectedFieldPaths: readonly string[];
  readonly absentFieldPaths: readonly string[];
  readonly llmRawReply: string;
  /**
   * design §6.5.4 的分桶：
   *   `ok`                          → 形状合法（可能经修复通道修好）
   *   `output_contract_violation`   → 模型答了，修复后形状仍非法
   *   `llm_unavailable`             → 模型没答（spawn / 超时 / 空 stdout / 信封无回复）
   */
  readonly validation: 'ok' | 'output_contract_violation' | 'llm_unavailable';
  readonly validationErrors?: readonly string[];
  /** 修复通道用掉的往返次数（0 = 首答即合法，无需修复）。 */
  readonly repairAttempts?: number;
  readonly repaired?: boolean;
  /** rc-8：经 safeStringifyPreview 截断的原文预览，仅在契约违规时记录。 */
  readonly rawPreview?: string;
  readonly namedSegments?: readonly {
    segment: string;
    verdict: string;
    /** 政策过滤后 required-only */
    missingDimensions: readonly string[];
    /** 模型原文，未过滤 */
    rawMissingDimensions: readonly string[];
    optionalUncovered: readonly string[];
    detail: string;
  }[];
  /** 政策过滤后 required-only */
  readonly compressionFidelityMissing?: readonly string[];
  readonly compressionFidelityMissingRaw?: readonly string[];
  readonly compressionFidelityOptionalUncovered?: readonly string[];
  readonly painFullyCovered?: boolean | null;
  readonly flagged?: boolean;
  readonly flaggedReasons?: readonly string[];
  readonly flaggedUndetermined?: readonly string[];
  readonly shapeWarnings?: readonly string[];
}

interface ChainRouteBRecord {
  readonly chainId: string;
  readonly llmRawReply: string;
  readonly productionValidatorValid: boolean;
  readonly productionValidatorErrors: readonly string[];
  readonly concerns: readonly string[];
  readonly requiredChanges: readonly string[];
  readonly decision: string | null;
}

const results: {
  generatedAt: string;
  llmRoute: string;
  routeA: ChainRouteARecord[];
  routeB: ChainRouteBRecord[];
  /** 模型**没答**：spawn 失败 / 超时 / 空 stdout / 信封里没有回复文本。 */
  llmUnavailable: string[];
  /** 模型**答了但信封坏了**：形状在修复通道用尽后仍非法（design §6.5.4）。 */
  outputContractViolations: string[];
} = {
  generatedAt: RUN_TIMESTAMP,
  llmRoute: 'openclaw agent --agent main --json (runCliProcess, same spawn path as OpenClawCliRuntimeAdapter)',
  routeA: [],
  routeB: [],
  llmUnavailable: [],
  outputContractViolations: [],
};

function persistResults(): void {
  // CodeRabbit PR #1273 #7: RESULTS_PATH targets .kiro/specs/... which is
  // git-ignored and may not exist on a fresh clone / CI. mkdirSync recursive
  // mirrors askAgent's handling of SPIKE_TMP_DIR (line 513).
  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(RESULTS_PATH, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Phase 0 Spike 1.2 — 摘要级上下文的定位能力（阻塞门）', () => {
  it('摘要级上下文只含 headline + 结构化字段，不含任何原始大字段', () => {
    for (const chain of SPIKE_CHAINS) {
      assertSpikeChainLineageConsistent(chain);
      const context = buildEvaluatorStage1Context(chain);
      const serialized = JSON.stringify(context);

      // 原始大字段的哨兵串：evidence note / 全量候选的 confidence / 实现代码
      expect(serialized).not.toContain('run://spike-rename');
      expect(serialized).not.toContain('function evaluate(input)');
      expect(serialized).not.toContain('goldenTraceCases');
      expect(serialized).not.toContain('causalChain');

      // 注入路径恰好是 EVALUATOR_STAGE1_MANIFEST 的 tier0 ∪ tier1
      expect([...Object.keys(context.fields), ...context.absent].sort()).toEqual(
        [...EVALUATOR_STAGE1_PATHS].sort(),
      );
      // 缺陷判定所需的两个关键字段必须在摘要级上下文里可用（否则门无意义）
      expect(context.fields['dreamer.summary.riskLevel']).toBeTruthy();
      expect(context.fields['scribe.summary.principleText']).toBeTruthy();
    }
  });

  // Route A is the real-LLM Phase 0 value-validation gate (design §12.1).
  // The gate has PASSED (2026-07-30, 4th rerun) — its blocking purpose is
  // served. It must NOT run in regular CI: it spawns a real LLM agent
  // (`openclaw agent --agent main`) requiring credentials/keys unavailable
  // in CI, and it is non-deterministic by nature (LLM judgement).
  //
  // To re-run the gate manually (e.g. after a model swap or a criteria
  // change), set PD_SPIKE_RUN_LLM=1 locally with the LLM key configured.
  // Otherwise the test is skipped — never silently passes, never fails CI.
  const runRouteA = process.env.PD_SPIKE_RUN_LLM === '1';
  (runRouteA ? it : it.skip)(
    'Route A：真实 LLM 仅凭摘要级上下文判断三段与维度；对照链不得被误报' + (runRouteA ? '' : '（skipped: PD_SPIKE_RUN_LLM 未设；门禁已于 2026-07-30 通过，CI 不重跑真实 LLM）'),
    async () => {
      for (const chain of SPIKE_CHAINS) {
        const context = buildEvaluatorStage1Context(chain);
        const call = await askAgent(`routeA-${chain.chainId}`, buildRouteAMessage(chain, context));

        // 桶 1：模型没答（design §6.5.4 的 llm_unavailable）
        if (call.kind === 'unavailable') {
          results.llmUnavailable.push(`${chain.chainId}: ${call.reason}`);
          results.routeA.push({
            chainId: chain.chainId,
            label: chain.label,
            expectedDefect: chain.expectedDefect,
            injectedFieldPaths: Object.keys(context.fields),
            absentFieldPaths: context.absent,
            llmRawReply: call.rawText,
            validation: 'llm_unavailable',
            validationErrors: [call.reason],
          });
          continue;
        }

        const resolution = await resolveRouteAContract(`routeA-${chain.chainId}`, call.rawText);

        // 桶 2：模型答了但信封坏了，且修复通道用尽仍非法
        if (resolution.kind === 'output_contract_violation') {
          results.outputContractViolations.push(
            `${chain.chainId}: ${resolution.errors.join(' | ')} (repairAttempts=${String(resolution.repairAttempts)})`,
          );
          results.routeA.push({
            chainId: chain.chainId,
            label: chain.label,
            expectedDefect: chain.expectedDefect,
            injectedFieldPaths: Object.keys(context.fields),
            absentFieldPaths: context.absent,
            llmRawReply: call.rawText,
            validation: 'output_contract_violation',
            validationErrors: resolution.errors,
            repairAttempts: resolution.repairAttempts,
            repaired: false,
            rawPreview: resolution.rawPreview,
          });
          continue;
        }

        const validated = { ok: true as const, value: resolution.judgment };
        const flaggedDecision = evaluateSpikeFlagged(validated.value);
        results.routeA.push({
          chainId: chain.chainId,
          label: chain.label,
          expectedDefect: chain.expectedDefect,
          injectedFieldPaths: Object.keys(context.fields),
          absentFieldPaths: context.absent,
          llmRawReply: call.rawText,
          validation: 'ok',
          repairAttempts: resolution.repairAttempts,
          repaired: resolution.repaired,
          namedSegments: validated.value.segments.map((s) => ({
            segment: s.segment,
            verdict: s.verdict,
            missingDimensions: s.missingDimensions,
            rawMissingDimensions: s.rawMissingDimensions,
            optionalUncovered: s.optionalUncovered,
            detail: s.detail,
          })),
          compressionFidelityMissing: validated.value.compressionFidelityMissing,
          compressionFidelityMissingRaw: validated.value.compressionFidelityMissingRaw,
          compressionFidelityOptionalUncovered:
            validated.value.compressionFidelityOptionalUncovered,
          painFullyCovered: validated.value.painFullyCovered,
          flagged: flaggedDecision.flagged,
          flaggedReasons: flaggedDecision.reasons,
          flaggedUndetermined: flaggedDecision.undetermined,
          shapeWarnings: validated.value.shapeWarnings,
        });
      }

      persistResults();

      // rc-9 / ERR-002 / ERR-088：两种失败**分两条断言**，诊断信号唯一。
      // 桶 1「模型没答」→ 运行时/环境问题（换 runtime 配置）。
      expect(
        results.llmUnavailable,
        `LLM_UNAVAILABLE (model did not answer — spawn error / timeout / empty stdout / no reply in envelope): ${results.llmUnavailable.join('; ')}`,
      ).toEqual([]);

      // 桶 2「模型答了但信封坏了」→ 能力/prompt 问题（换模型或改 prompt）。
      expect(
        results.outputContractViolations,
        `OUTPUT_CONTRACT_VIOLATION (model answered but shape stayed invalid after up to ${String(ROUTE_A_REPAIR_ATTEMPTS)} repair round(s) via attemptStructuredOutputRepair): ${results.outputContractViolations.join('; ')}`,
      ).toEqual([]);

      for (const record of results.routeA) {
        expect(
          record.validation,
          `chain ${record.chainId} (${record.validation}) raw reply: ${record.llmRawReply}`,
        ).toBe('ok');
      }

      const byChain = new Map(results.routeA.map((r) => [r.chainId, r]));

      // 缺陷链 A：必须点名 dreamer_to_scribe 段 + riskLevel 维度
      const defectA = byChain.get('defect_a_risk_level_dropped');
      expect(defectA).toBeDefined();
      const defectASegment = defectA?.namedSegments?.find((s) => s.segment === 'dreamer_to_scribe');
      expect(defectASegment?.verdict, `defect A raw: ${defectA?.llmRawReply ?? ''}`).not.toBe('pass');
      expect(
        [...(defectASegment?.missingDimensions ?? []), ...(defectA?.compressionFidelityMissing ?? [])]
          .join(' ')
          .toLowerCase(),
        `defect A raw: ${defectA?.llmRawReply ?? ''}`,
      ).toContain('risklevel');

      // 缺陷链 B：必须点名 dreamer_to_scribe 段 + betterDecision（具体动作被抽象化）
      const defectB = byChain.get('defect_b_action_abstracted');
      expect(defectB).toBeDefined();
      const defectBSegment = defectB?.namedSegments?.find((s) => s.segment === 'dreamer_to_scribe');
      expect(defectBSegment?.verdict, `defect B raw: ${defectB?.llmRawReply ?? ''}`).not.toBe('pass');
      expect(
        [...(defectBSegment?.missingDimensions ?? []), ...(defectB?.compressionFidelityMissing ?? [])]
          .join(' ')
          .toLowerCase(),
        `defect B raw: ${defectB?.llmRawReply ?? ''}`,
      ).toContain('betterdecision');

      // 对照链：假阳性守卫（design §12.1「门禁再跑」+ CP-36）——
      // dreamer_to_scribe 判 pass、政策过滤后的 required 缺失为空、flagged 为 false。
      // `badDecision`（optional）/ `strategicPerspective`（excluded）出现在
      // optionalUncovered 里**不构成失败**，只作为诊断留痕。
      const control = byChain.get('control_no_defect');
      expect(control).toBeDefined();
      const controlSegment = control?.namedSegments?.find((s) => s.segment === 'dreamer_to_scribe');
      expect(controlSegment?.verdict, `control raw: ${control?.llmRawReply ?? ''}`).toBe('pass');
      expect(
        [...(controlSegment?.missingDimensions ?? []), ...(control?.compressionFidelityMissing ?? [])],
        `control raw: ${control?.llmRawReply ?? ''}`,
      ).toEqual([]);
      expect(control?.flagged, `control flagged reasons: ${(control?.flaggedReasons ?? []).join(', ')}; raw: ${control?.llmRawReply ?? ''}`).toBe(false);
    },
    LLM_TIMEOUT_MS * 4,
  );

  // Route B 在第三次门禁重跑中**不执行**：第二次重跑里它每条链都跑过传输层超时
  // （生产 evaluator prompt 体积远大于 Route A 的 spike-local prompt），整个测试挂到
  // 超时上限之后才结束，且它是纯记录性路由（不参与门禁判定）。保留代码与形状，
  // 显式 skip 并写明原因（不删测试、不假装通过）。
  it.skip(
    'Route B（第三次门禁重跑中跳过：第二次重跑挂在传输层超时；纯记录性路由，不参与门禁判定）',
    async () => {
      const validator = new DefaultEvaluatorValidator();
      for (const chain of SPIKE_CHAINS) {
        const context = buildEvaluatorStage1Context(chain);
        const call = await askAgent(`routeB-${chain.chainId}`, buildRouteBMessage(chain, context));
        const { rawText } = call;
        const parsed: unknown = call.kind === 'reply'
          ? extractJsonObject(rawText) ?? repairMalformedJson(rawText)
          : null;
        const validation = await validator.validate(
          parsed,
          chain.evaluator.taskId,
          chain.artificer.artifactId,
        );
        const evaluation = readRecord(parsed, 'evaluation');
        const concerns = evaluation === null ? null : readArray(evaluation, 'concerns');
        const requiredChanges = evaluation === null ? null : readArray(evaluation, 'requiredChanges');
        results.routeB.push({
          chainId: chain.chainId,
          llmRawReply: rawText,
          productionValidatorValid: validation.valid,
          productionValidatorErrors: validation.errors,
          concerns: (concerns ?? []).filter((c): c is string => typeof c === 'string'),
          requiredChanges: (requiredChanges ?? []).filter((c): c is string => typeof c === 'string'),
          decision: evaluation === null ? null : readString(evaluation, 'decision'),
        });
      }
      persistResults();

      // ERR-088：不能用「拿到了某段文本」当依据 —— 传输层不可达时 stderr 也是文本。
      // 唯一指向「LLM 真的判过」的信号是生产 validator 至少看到一个对象化输出，
      // 因此断言输出被解析成对象（校验错误可以有，但不能是 'Output is not an object'）。
      for (const record of results.routeB) {
        expect(
          record.productionValidatorErrors,
          `chain ${record.chainId} produced no parseable LLM output; raw: ${record.llmRawReply.slice(0, 500)}`,
        ).not.toContain('Output is not an object');
      }
    },
    LLM_TIMEOUT_MS * 4,
  );
});
