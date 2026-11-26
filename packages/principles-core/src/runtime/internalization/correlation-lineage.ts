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
import { hydratePITaskRecord } from './pitask-metadata.js';
import type { PITaskRecord } from './peer-runner-contracts.js';
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
  | 'parent_chain_cycle_or_depth_exceeded';

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
export function correlationLineageGetTask(stateManager: RuntimeStateManager): CorrelationLineageGetTask {
  return (taskId: string) => stateManager.getTask(taskId);
}
