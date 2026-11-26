/**
 * correlation-lineage.ts — PeerRunnerKind 父链 correlationId 权威血缘解析
 * (SPEC-PD-PIPELINE-SPINE-001 §3.6 / PRI-1293 Phase 3)。
 *
 * 唯一实现 (P4 One Source of Truth)。所有生产消费方 (commitNextTaskProposal、
 * revision-reopen、source-correction 定点续接、host-runtime / pd-cli 两个
 * Evaluator Repair Seeder) 都必须经本模块 (或
 * `InternalizationOrchestrator.resolveAuthoritativeCorrelationId` 静态只读
 * 包装) 取得同一判定，禁止第二套父链遍历。
 *
 * 算法 (TECH §3.6.2 v0.4/v0.5 加固语义):
 *   1. 只沿 `parentTaskId` 向上回溯 (绝不使用 dependencyTaskIds 代替);
 *   2. 最多 CORRELATION_LINEAGE_MAX_PARENT_EDGES 条父子边，visited 集合防环;
 *   3. 任一悬空父引用立即 fail-closed;
 *   4. 链上全部非空 correlationId trim 后必须互相一致;
 *   5. 根 Dreamer 双源身份交叉校验: `candidateIdFromDreamerTaskId(taskId)` 与
 *      `candidateIdFromDreamerSeed(diagnosticJson)` 是两个独立持久化事实 —
 *      A+A 通过、A+B 冲突拒绝、单边缺失采纳单边、双缺失不可恢复; 禁止
 *      `??` 链静默偏向 (wakeOnce admission 的既有回退不复制到此);
 *   6. 根锚点核对 + 根侧佐证 (v0.5): 链上唯一非空 correlationId 与非空
 *      rootSeedId 不一致时按 conflicting_parent_correlation_id 拒绝 (根自身
 *      携带的 correlationId 是链上声明的一部分, 不得循环自证); 一致或
 *      rootSeedId 缺失时, 链上声明必须被根侧佐证 (根 taskId/seed 解析出同一
 *      candidateId，或根自身携带同一 id); 根三个身份来源全部缺失时仅后代
 *      声明不得采纳; 根不是 dreamer 时无佐证来源，一律拒绝;
 *   7. 历史无 id 在途链可从根 dreamer 双源恢复，但不回填任何持久化真值 —
 *      恢复结果只写入新后继 / reopen 目标的 metadata (调用方职责)。
 *
 * 严格作用域: 仅 PeerRunnerKind 任务链。DiagnosticianStageKind 子任务
 * (diag_rootcause/distiller/router) 继续使用 parentTaskId + dependencyTaskIds
 * 语义，调用方不得对诊断任务调用本解析器。
 */

import type { TaskRecord } from '../task-status.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { createPITaskDiagnosticJson, hydratePITaskRecord, mergePITaskMetadata } from './pitask-metadata.js';
import { getAllowedPredecessors } from './internalization-job-graph.js';
import { isPeerRunnerKind, type PITaskRecord } from './peer-runner-contracts.js';

import {
  candidateIdFromDreamerSeed,
  candidateIdFromDreamerTaskId,
} from '../activation/ledger-identity.js';

/** 父链回溯边数上限: 10 条边 (11 个节点) 通过，第 11 条边拒绝。 */
export const CORRELATION_LINEAGE_MAX_PARENT_EDGES = 10;

export type CorrelationLineageFailureReason =
  | 'missing_correlation_id_lineage'
  | 'conflicting_parent_correlation_id'
  | 'conflicting_root_identity_sources'
  | 'dangling_parent_reference'
  | 'parent_chain_cycle_or_depth_exceeded'
  | 'legacy_parent_inference_refused'
  | 'legacy_parent_backfill_conflict';

/**
 * TECH §3.6.2 判别联合。失败一律结构化携带 reason + detail，
 * 禁止被调用方折叠成 null/false/普通 no_successor。
 */
export type CorrelationLineageResolution =
  | {
    ok: true;
    /** 权威 correlationId (验证一致或从根恢复)。 */
    correlationId: string;
    /** true = 叶子链全程无 id，身份从根 dreamer 双源恢复 (历史在途链)。 */
    recoveredFromLegacyRoot: boolean;
    /**
     * 叶子到根的父子边数 (叶自身深度)。读取侧不据此拒绝 — 10 边深度的
     * 在途任务保持可读; 该值供创建侧判定"再加一条边是否越限"
     * (successor depth = parentEdgeCount + 1, 不得超过 MAX)。
     */
    parentEdgeCount: number;
  }
  | { ok: false; reason: CorrelationLineageFailureReason; detail: string };

/** 解析器只读访问任务存储；与 RuntimeStateManager.getTask 同形。 */
export type CorrelationLineageGetTask = (taskId: string) => Promise<TaskRecord | null>;

interface ChainNode {
  readonly pi: PITaskRecord;
  readonly raw: TaskRecord;
}

/** rc-8: detail 携带 id 但有界输出。 */
function boundDetail(values: readonly string[]): string {
  return values.map((v) => (v.length > 80 ? `${v.slice(0, 77)}...` : v)).join(',');
}

function trimmedCorrelationId(pi: PITaskRecord): string | null {
  if (typeof pi.correlationId !== 'string') return null;
  const trimmed = pi.correlationId.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 解析 leaf 任务的权威 correlationId。只读 — 不写任何状态。
 * leaf 传入原始 TaskRecord (根 dreamer 的 diagnosticJson 双源解析需要它)。
 */
export async function resolveAuthoritativeCorrelationId(
  leafTaskRecord: TaskRecord,
  getTask: CorrelationLineageGetTask,
): Promise<CorrelationLineageResolution> {
  const leafPi = hydratePITaskRecord(leafTaskRecord);
  if (!leafPi) {
    return { ok: false, reason: 'missing_correlation_id_lineage', detail: 'invalid_leaf_task_metadata' };
  }

  // ── 1. 有界父链回溯 (仅 parentTaskId) ──
  const nodes: ChainNode[] = [{ pi: leafPi, raw: leafTaskRecord }];
  const visited = new Set<string>([leafPi.taskId]);
  let edges = 0;
  let current = nodes[0] as ChainNode;
  while (typeof current.pi.parentTaskId === 'string' && current.pi.parentTaskId.trim() !== '') {
    const parentTaskId = current.pi.parentTaskId.trim();
    edges += 1;
    if (edges > CORRELATION_LINEAGE_MAX_PARENT_EDGES) {
      return {
        ok: false,
        reason: 'parent_chain_cycle_or_depth_exceeded',
        detail: `depth_limit_exceeded:${CORRELATION_LINEAGE_MAX_PARENT_EDGES}_edges_from_${boundDetail([leafPi.taskId])}`,
      };
    }
    if (visited.has(parentTaskId)) {
      return {
        ok: false,
        reason: 'parent_chain_cycle_or_depth_exceeded',
        detail: `cycle_at:${parentTaskId}`,
      };
    }
    const parentRaw = await getTask(parentTaskId);
    if (!parentRaw) {
      return {
        ok: false,
        reason: 'dangling_parent_reference',
        detail: `parent_not_found:${parentTaskId}`,
      };
    }
    const parentPi = hydratePITaskRecord(parentRaw);
    if (!parentPi) {
      // 引用到的父任务存在但元数据不可读 — 无法参与血缘证明，等同悬空。
      return {
        ok: false,
        reason: 'dangling_parent_reference',
        detail: `parent_metadata_invalid:${parentTaskId}`,
      };
    }
    visited.add(parentTaskId);
    const node: ChainNode = { pi: parentPi, raw: parentRaw };
    nodes.push(node);
    current = node;
  }
  const root = current;

  // ── 2. 链内一致性: 全部非空 correlationId trim 后必须一致 ──
  const claimed = new Set<string>();
  for (const node of nodes) {
    const id = trimmedCorrelationId(node.pi);
    if (id !== null) claimed.add(id);
  }
  if (claimed.size > 1) {
    return {
      ok: false,
      reason: 'conflicting_parent_correlation_id',
      detail: `chain_values:[${boundDetail([...claimed])}]`,
    };
  }
  const chainId = claimed.size === 1 ? ([...claimed][0] as string) : null;

  // ── 3. 根 dreamer 双源身份事实 (两个独立持久化来源, 禁止 ?? 偏向) ──
  const fromTaskId = root.pi.taskKind === 'dreamer'
    ? candidateIdFromDreamerTaskId(root.raw.taskId)
    : null;
  const fromSeed = root.pi.taskKind === 'dreamer'
    ? candidateIdFromDreamerSeed(root.raw.diagnosticJson)
    : null;
  if (fromTaskId !== null && fromSeed !== null && fromTaskId !== fromSeed) {
    return {
      ok: false,
      reason: 'conflicting_root_identity_sources',
      detail: `root_task_id_vs_seed:[${boundDetail([fromTaskId, fromSeed])}]`,
    };
  }
  // 双源交叉校验通过后的唯一 rootSeedId (§3.6.2 裁决表): 双非空必相等,
  // 单边缺失采纳单边, 双缺失为 null。
  const rootSeedId = fromTaskId ?? fromSeed;

  if (chainId !== null) {
    // ── 4. 根侧佐证 (v0.5): 后代声明必须被根佐证，绝不孤立采信 ──
    if (root.pi.taskKind !== 'dreamer') {
      return {
        ok: false,
        reason: 'missing_correlation_id_lineage',
        detail: `root_not_dreamer:${root.pi.taskKind}:${root.raw.taskId}`,
      };
    }
    // ── 4a. 根锚点核对 (§3.6.2): 链上声明与非空 rootSeedId 不一致 = 冲突,
    // 一律拒绝 — 根自身 correlationId 是链上声明的一部分, 不得循环自证;
    // 该检查必须先于下方的第三佐证来源。
    if (rootSeedId !== null && chainId !== rootSeedId) {
      return {
        ok: false,
        reason: 'conflicting_parent_correlation_id',
        detail: `root_anchor_mismatch:chain=${chainId},root_seed=${rootSeedId}`,
      };
    }
    const corroborated = chainId === fromTaskId
      || chainId === fromSeed
      // 根自身携带同一 id (链内一致性已保证根若有 id 即 chainId) — §3.6.2 的
      // 第三佐证来源。
      || trimmedCorrelationId(root.pi) === chainId;
    if (!corroborated) {
      return {
        ok: false,
        reason: 'missing_correlation_id_lineage',
        detail: `root_corroboration_failed:claimed=${chainId},task_id_source=${fromTaskId ?? 'null'},seed_source=${fromSeed ?? 'null'},root_own=null`,
      };
    }
    return { ok: true, correlationId: chainId, recoveredFromLegacyRoot: false, parentEdgeCount: edges };
  }

  // ── 5. 纯历史恢复: 链上无任何 id，从根 dreamer 双源恢复 ──
  if (root.pi.taskKind !== 'dreamer') {
    return {
      ok: false,
      reason: 'missing_correlation_id_lineage',
      detail: `unrecoverable_chain_root_not_dreamer:${root.pi.taskKind}:${root.raw.taskId}`,
    };
  }
  if (fromTaskId !== null) {
    return { ok: true, correlationId: fromTaskId, recoveredFromLegacyRoot: true, parentEdgeCount: edges };
  }
  if (fromSeed !== null) {
    return { ok: true, correlationId: fromSeed, recoveredFromLegacyRoot: true, parentEdgeCount: edges };
  }
  return {
    ok: false,
    reason: 'missing_correlation_id_lineage',
    detail: `root_identity_sources_all_missing:${root.raw.taskId}`,
  };
}

/**
 * 便捷构造: 以 RuntimeStateManager 为存储的 getTask 绑定。
 * (生产调用方也可直接传 `stateManager.getTask.bind(stateManager)`。)
 */
type LegacyParentInference = { ok: true; parentTaskId: string } | { ok: false; reason: string };

function legacyCorrelationCompatible(child: PITaskRecord, parent: PITaskRecord): boolean {
  const childId = child.correlationId?.trim();
  const parentId = parent.correlationId?.trim();
  return !childId || !parentId || childId === parentId;
}

async function inferLegacyParentTaskId(
  raw: TaskRecord,
  pi: PITaskRecord,
  stateManager: RuntimeStateManager,
): Promise<LegacyParentInference> {
  const deps = pi.dependencyTaskIds;
  const loadTypedParent = async (parentTaskId: string, expectedKind: string): Promise<LegacyParentInference> => {
    const parentRaw = await stateManager.getTask(parentTaskId);
    if (!parentRaw) return { ok: false, reason: 'dependency_parent_missing:' + parentTaskId };
    const parentPi = hydratePITaskRecord(parentRaw);
    if (!parentPi) return { ok: false, reason: 'dependency_parent_metadata_invalid:' + parentTaskId };
    if (parentPi.taskKind !== expectedKind) return { ok: false, reason: 'dependency_parent_kind_mismatch:' + parentTaskId };
    if (parentPi.channel !== pi.channel || !legacyCorrelationCompatible(pi, parentPi)) {
      return { ok: false, reason: 'dependency_parent_chain_mismatch:' + parentTaskId };
    }
    return { ok: true, parentTaskId };
  };

  // Old repair seeder persisted an explicit sourceEvaluatorTaskId in repairPayload.
  if (pi.taskKind === 'artificer' && pi.repairPayload) {
    const {sourceEvaluatorTaskId} = pi.repairPayload;
    const expectedId = 'artificer-repair-' + sourceEvaluatorTaskId + '-r' + pi.repairPayload.repairIteration;
    if (raw.taskId !== expectedId) return { ok: false, reason: 'repair_task_id_does_not_match_repair_payload' };
    return loadTypedParent(sourceEvaluatorTaskId, 'evaluator');
  }

  // Old AdversarialLoop Artificer: round 1 is caused by Scribe; later rounds
  // are caused by the unique preceding Evaluator that durably said needs_revision.
  const artificerRound = pi.taskKind === 'artificer'
    ? /^(.+)-artificer-r([1-9]\d*)-([a-z0-9]+)$/.exec(raw.taskId)
    : null;
  if (artificerRound) {
    const correlation = artificerRound[1] ?? '';
    const round = Number(artificerRound[2] ?? '0');
    if (!correlation || deps.length !== 1) return { ok: false, reason: 'legacy_adversarial_artificer_requires_one_scribe_dependency' };
    const scribe = await stateManager.getTask(deps[0] ?? '');
    const scribePi = scribe ? hydratePITaskRecord(scribe) : null;
    if (!scribe || !scribePi || scribePi.taskKind !== 'scribe' || scribePi.channel !== pi.channel) {
      return { ok: false, reason: 'legacy_adversarial_artificer_scribe_input_not_provable' };
    }
    if (round === 1) return loadTypedParent(scribe.taskId, 'scribe');

    const prefix = correlation + '-evaluator-r' + String(round - 1) + '-';
    const evaluatorRows = await stateManager.listTasks({ taskKind: 'evaluator' });
    const candidates: TaskRecord[] = [];
    for (const candidate of evaluatorRows) {
      if (!candidate.taskId.startsWith(prefix) || candidate.status !== 'succeeded') continue;
      const candidatePi = hydratePITaskRecord(candidate);
      if (!candidatePi || candidatePi.runnerDecision !== 'needs_revision' || candidatePi.channel !== pi.channel
        || !legacyCorrelationCompatible(pi, candidatePi) || candidatePi.dependencyTaskIds.length !== 1) continue;
      const priorArtificer = await stateManager.getTask(candidatePi.dependencyTaskIds[0] ?? '');
      const priorArtificerPi = priorArtificer ? hydratePITaskRecord(priorArtificer) : null;
      if (!priorArtificer || !priorArtificerPi || priorArtificerPi.taskKind !== 'artificer'
        || !priorArtificer.taskId.startsWith(correlation + '-artificer-r' + String(round - 1) + '-')
        || priorArtificerPi.channel !== pi.channel || !legacyCorrelationCompatible(candidatePi, priorArtificerPi)) continue;
      candidates.push(candidate);
    }
    const chosen = candidates.at(0);
    if (candidates.length !== 1 || chosen === undefined) {
      return { ok: false, reason: 'previous_round_evaluator_not_unique_or_not_needs_revision:round=' + String(round - 1) + ':matches=' + String(candidates.length) };
    }
    return { ok: true, parentTaskId: chosen.taskId };
  }

  // Old AdversarialLoop Evaluator IDs encode the exact Artificer round.
  const evaluatorRound = pi.taskKind === 'evaluator'
    ? /^(.+)-evaluator-r([1-9]\d*)-([a-z0-9]+)$/.exec(raw.taskId)
    : null;
  if (evaluatorRound) {
    const correlation = evaluatorRound[1] ?? '';
    const round = evaluatorRound[2] ?? '';
    if (!correlation || deps.length !== 1) return { ok: false, reason: 'legacy_adversarial_evaluator_requires_one_artificer_dependency' };
    const parent = await loadTypedParent(deps[0] ?? '', 'artificer');
    if (!parent.ok) return parent;
    const parentRaw = await stateManager.getTask(parent.parentTaskId);
    if (!parentRaw?.taskId.startsWith(correlation + '-artificer-r' + round + '-')) {
      return { ok: false, reason: 'legacy_adversarial_evaluator_round_parent_mismatch' };
    }
    return parent;
  }

  // Old RuleHost philosopher/scribe IDs are timestamp-suffixed; the producer
  // passed exactly the causal predecessor as the sole dependency.
  // 形状一旦匹配, 后续所有证明失败都必须返回具体拒绝原因 — 不得落回
  // shape-not-recognized (否则已知生产者结构的多依赖任务会被错分为
  // missing_correlation_id_lineage, 与错误分类契约相悖)。
  const ruleHostStage = /^(.+)-(philosopher|scribe)-([a-z0-9]+)$/.exec(raw.taskId);
  if (ruleHostStage && (pi.taskKind === 'philosopher' || pi.taskKind === 'scribe')
    && ruleHostStage[2] === pi.taskKind) {
    if (deps.length !== 1) return { ok: false, reason: 'legacy_rulehost_requires_exactly_one_dependency:deps=' + String(deps.length) };
    const parentRaw = await stateManager.getTask(deps[0] ?? '');
    const parentPi = parentRaw ? hydratePITaskRecord(parentRaw) : null;
    if (!parentRaw || !parentPi) return { ok: false, reason: 'legacy_rulehost_parent_missing_or_invalid' };
    if (!isPeerRunnerKind(parentPi.taskKind)) return { ok: false, reason: 'legacy_rulehost_parent_not_peer_runner' };
    const allowed = getAllowedPredecessors(pi.taskKind, pi.channel, pi.pipelineMode);
    if (!allowed.includes(parentPi.taskKind) || parentPi.channel !== pi.channel || !legacyCorrelationCompatible(pi, parentPi)) {
      return { ok: false, reason: 'legacy_rulehost_parent_not_unique_typed_predecessor' };
    }
    return { ok: true, parentTaskId: parentRaw.taskId };
  }

  return { ok: false, reason: 'task_id_shape_not_from_a_supported_legacy_producer' };
}


/**
 * PRI-1293 R7 (P2-1): 只读历史血缘规划 — dry-run / confirm / seeder 的统一
 * 判定入口。与回填版走完全相同的推理路径 (同一 inferLegacyParentTaskId,
 * 同一深度/环/孤儿分类规则), 但**不写任何状态**: 推断出的边收集为
 * backfillEdges, 然后用 overlay getTask (把计划边虚拟补入 parentTaskId)
 * 跑 canonical resolver 终验 — 保证规划判定与"回填后 canonical 判定"
 * 严格一致, 消除 dry-run 拒绝而 confirm 成功的分叉。
 */
export type LegacyLineagePlan =
  | {
    readonly ok: true;
    readonly correlationId: string;
    readonly recoveredFromLegacyRoot: boolean;
    readonly parentEdgeCount: number;
    /** 需要 CAS 补齐的父子边 (缺失但已证明); 空数组 = 无需回填。 */
    readonly backfillEdges: readonly { readonly taskId: string; readonly parentTaskId: string }[];
  }
  | { readonly ok: false; readonly reason: CorrelationLineageFailureReason; readonly detail: string };

export async function planLegacyLineageResolution(
  leafTaskRecord: TaskRecord,
  stateManager: RuntimeStateManager,
): Promise<LegacyLineagePlan> {
  const edges: { taskId: string; parentTaskId: string }[] = [];
  let current = leafTaskRecord;
  const visited = new Set<string>();
  for (let depth = 0; depth <= CORRELATION_LINEAGE_MAX_PARENT_EDGES; depth += 1) {
    if (visited.has(current.taskId)) {
      return { ok: false, reason: 'parent_chain_cycle_or_depth_exceeded', detail: 'legacy_backfill_cycle_at:' + current.taskId };
    }
    visited.add(current.taskId);
    const pi = hydratePITaskRecord(current);
    if (!pi) return { ok: false, reason: 'missing_correlation_id_lineage', detail: 'invalid_legacy_backfill_metadata:' + current.taskId };
    if (pi.taskKind === 'dreamer') break;

    const existingParentId = pi.parentTaskId?.trim();
    if (existingParentId) {
      const parent = await stateManager.getTask(existingParentId);
      if (!parent) break; // canonical overlay 同样报 dangling_parent_reference
      current = parent;
      continue;
    }
    if (depth === CORRELATION_LINEAGE_MAX_PARENT_EDGES) {
      return { ok: false, reason: 'parent_chain_cycle_or_depth_exceeded', detail: 'legacy_backfill_depth_exceeded:' + current.taskId };
    }

    const inferred = await inferLegacyParentTaskId(current, pi, stateManager);
    if (!inferred.ok) {
      if (inferred.reason === 'task_id_shape_not_from_a_supported_legacy_producer') {
        break; // 非生产者节点: 链止于此, 分类权交 canonical overlay
      }
      return { ok: false, reason: 'legacy_parent_inference_refused', detail: 'task=' + current.taskId + ';taskKind=' + pi.taskKind + ';' + inferred.reason };
    }
    if (visited.has(inferred.parentTaskId)) {
      return { ok: false, reason: 'parent_chain_cycle_or_depth_exceeded', detail: 'legacy_inferred_cycle_at:' + inferred.parentTaskId };
    }
    const parent = await stateManager.getTask(inferred.parentTaskId);
    if (!parent) return { ok: false, reason: 'dangling_parent_reference', detail: 'legacy_inferred_parent_not_found:' + inferred.parentTaskId };
    edges.push({ taskId: current.taskId, parentTaskId: inferred.parentTaskId });
    current = parent;
  }

  // overlay: 把计划边虚拟补入, canonical resolver 终验 — 不写库。
  const edgeMap = new Map(edges.map((e) => [e.taskId, e.parentTaskId]));
  const overlayGetTask = async (taskId: string): Promise<TaskRecord | null> => {
    const row = await stateManager.getTask(taskId);
    const planned = edgeMap.get(taskId);
    if (!row || planned === undefined) return row;
    const pi = hydratePITaskRecord(row);
    if (!pi) return row;
    const merged = mergePITaskMetadata(pi, { parentTaskId: planned });
    return { ...row, diagnosticJson: createPITaskDiagnosticJson(merged) };
  };
  const overlayLeaf = await overlayGetTask(leafTaskRecord.taskId) ?? leafTaskRecord;
  const canonical = await resolveAuthoritativeCorrelationId(overlayLeaf, overlayGetTask);
  if (!canonical.ok) return canonical;
  return {
    ok: true,
    correlationId: canonical.correlationId,
    recoveredFromLegacyRoot: canonical.recoveredFromLegacyRoot,
    parentEdgeCount: canonical.parentEdgeCount,
    backfillEdges: edges,
  };
}

/**
 * Upgrade only known historical producer shapes. This helper is intentionally
 * separate from the read-only resolver: each inferred edge is proven from a
 * producer-specific task-id shape plus a unique typed predecessor, then
 * persisted with the existing task-row CAS. There is no generic dependency
 * fallback. Old AdversarialLoop Artificer rounds >1 depend on Scribe for input,
 * but are causally parented by the immediately preceding needs_revision Evaluator.
 */
export async function resolveAuthoritativeCorrelationIdWithLegacyBackfill(
  leafTaskRecord: TaskRecord,
  stateManager: RuntimeStateManager,
): Promise<CorrelationLineageResolution> {
  let current = leafTaskRecord;
  const visited = new Set<string>();
  for (let depth = 0; depth <= CORRELATION_LINEAGE_MAX_PARENT_EDGES; depth += 1) {
    if (visited.has(current.taskId)) {
      return { ok: false, reason: 'parent_chain_cycle_or_depth_exceeded', detail: 'legacy_backfill_cycle_at:' + current.taskId };
    }
    visited.add(current.taskId);
    const pi = hydratePITaskRecord(current);
    if (!pi) return { ok: false, reason: 'missing_correlation_id_lineage', detail: 'invalid_legacy_backfill_metadata:' + current.taskId };
    if (pi.taskKind === 'dreamer') break;

    const existingParentId = pi.parentTaskId?.trim();
    if (existingParentId) {
      const parent = await stateManager.getTask(existingParentId);
      if (!parent) break; // canonical resolver reports dangling_parent_reference
      current = parent;
      continue;
    }
    if (depth === CORRELATION_LINEAGE_MAX_PARENT_EDGES) {
      return { ok: false, reason: 'parent_chain_cycle_or_depth_exceeded', detail: 'legacy_backfill_depth_exceeded:' + current.taskId };
    }

    const inferred = await inferLegacyParentTaskId(current, pi, stateManager);
    if (!inferred.ok) {
      if (inferred.reason === 'task_id_shape_not_from_a_supported_legacy_producer') {
        // 不匹配任何已知历史生产者结构 = 该节点根本不是历史生产者任务,
        // 血缘链到此为止。分类权交还 canonical resolver — 无身份来源的孤儿
        // 必须保持 missing_correlation_id_lineage (root_not_dreamer /
        // unrecoverable root), 不得被粗暴归类为 legacy_parent_inference_refused
        // (该分类专为"已知生产者结构但候选父节点无法证明"保留)。
        break;
      }
      return { ok: false, reason: 'legacy_parent_inference_refused', detail: 'task=' + current.taskId + ';taskKind=' + pi.taskKind + ';' + inferred.reason };
    }
    if (visited.has(inferred.parentTaskId)) {
      return { ok: false, reason: 'parent_chain_cycle_or_depth_exceeded', detail: 'legacy_inferred_cycle_at:' + inferred.parentTaskId };
    }
    const parent = await stateManager.getTask(inferred.parentTaskId);
    if (!parent) return { ok: false, reason: 'dangling_parent_reference', detail: 'legacy_inferred_parent_not_found:' + inferred.parentTaskId };

    const merged = mergePITaskMetadata(pi, { parentTaskId: inferred.parentTaskId });
    const updated = await stateManager.updateTaskIfDiagnosticJsonUnchanged(
      current.taskId,
      current.diagnosticJson ?? null,
      { diagnosticJson: createPITaskDiagnosticJson(merged) },
      {
        expectedStatus: current.status,
        expectedAttemptCount: current.attemptCount,
        expectedMaxAttempts: current.maxAttempts,
        expectedLeaseOwner: current.leaseOwner ?? null,
        expectedLeaseExpiresAt: current.leaseExpiresAt ?? null,
        expectedLeaseGeneration: current.leaseGeneration ?? 0,
      },
    );
    if (!updated) {
      const reread = await stateManager.getTask(current.taskId);
      const rereadPi = reread ? hydratePITaskRecord(reread) : null;
      if (!reread || rereadPi?.parentTaskId !== inferred.parentTaskId) {
        return { ok: false, reason: 'legacy_parent_backfill_conflict', detail: 'CAS lost for task=' + current.taskId + ';expectedParent=' + inferred.parentTaskId };
      }
    }
    current = parent;
  }
  const refreshedLeaf = await stateManager.getTask(leafTaskRecord.taskId);
  return resolveAuthoritativeCorrelationId(refreshedLeaf ?? leafTaskRecord, (id: string) => stateManager.getTask(id));
}

export function correlationLineageGetTask(stateManager: RuntimeStateManager): CorrelationLineageGetTask {
  return (taskId: string) => stateManager.getTask(taskId);
}
