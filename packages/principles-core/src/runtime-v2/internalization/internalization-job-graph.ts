/**
 * Internalization Job Graph Topology (PRI-61)
 *
 * Defines the DAG topology for peer runner job execution.
 * Follows ADR-0003 Section 3.7 job graph rules:
 *   1. No cycles — graph must be acyclic
 *   2. Dependency gating — task with non-empty dependencyTaskIds
 *      must NOT be leased until ALL dependencies are in succeeded state
 *   3. Dependency failure propagation — if any dependency enters failed,
 *      the dependent task is NOT auto-failed (escalation policy in PRI-62)
 *
 * @see docs/adr/0003-peer-agent-state-machine-orchestration.md
 */

import type {
  InternalizationChannel,
  PeerRunnerKind,
  DiagnosticianStageKind,
  PipelineTopologyMode,
} from './peer-runner-contracts.js';
import { isInternalizationChannel } from './peer-runner-contracts.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Full-chain edges — the legacy v1 linear graph, retained as the topology of
 * `code_tool_hook`/`skill` chains and of any chain explicitly seeded with
 * `pipelineMode: 'full_chain'` (PRI-720 Owner override).
 *
 * v1: rollout_reviewer is the terminal peer runner. The trainer/model_training
 * surface was removed in PRI-449 (MVP-Gone).
 *
 * @see ADR-0003 Section 3.7
 */
export const ALLOWED_EDGES: readonly (readonly [PeerRunnerKind, PeerRunnerKind])[] = [
  ['dreamer', 'philosopher'] as const,
  ['philosopher', 'scribe'] as const,
  ['scribe', 'artificer'] as const,
  ['artificer', 'evaluator'] as const,
  ['evaluator', 'rollout_reviewer'] as const,
] as const;

/**
 * Principle-semantic edges for the prompt/defer_archive channels (PRI-720).
 *
 * The RuleCode sub-chain (artificer → evaluator) is never created on these
 * channels: they activate the validated Scribe `principle` artifact via
 * PromptWriter, so Artificer's mandatory RuleCode contract
 * (implementationCode + goldenTraceCases + affectedTools) is wrong-channel
 * work. RolloutReviewer runs in its principle semantic mode instead.
 */
const PRINCIPLE_SEMANTIC_EDGES: readonly (readonly [PeerRunnerKind, PeerRunnerKind])[] = [
  ['dreamer', 'philosopher'] as const,
  ['philosopher', 'scribe'] as const,
  ['scribe', 'rollout_reviewer'] as const,
] as const;

/**
 * Channel-aware topology (PRI-720) — the single source of truth for which
 * edges exist per channel. `code_tool_hook`/`skill` keep the full chain
 * byte-compatible; `prompt`/`defer_archive` take the principle-semantic path.
 */
export const CHANNEL_EDGES: Readonly<
  Record<InternalizationChannel, readonly (readonly [PeerRunnerKind, PeerRunnerKind])[]>
> = {
  prompt: PRINCIPLE_SEMANTIC_EDGES,
  defer_archive: PRINCIPLE_SEMANTIC_EDGES,
  code_tool_hook: ALLOWED_EDGES,
  skill: ALLOWED_EDGES,
};

/**
 * Resolves the effective edge set for a channel + topology mode (PRI-720).
 *
 * - `full_chain` mode always returns the full linear graph (explicit override).
 * - A known channel returns that channel's edge set.
 * - No channel (legacy callers) keeps the full graph for backward compatibility.
 */
export function resolveChannelEdges(
  channel?: InternalizationChannel,
  pipelineMode?: PipelineTopologyMode,
): readonly (readonly [PeerRunnerKind, PeerRunnerKind])[] {
  if (pipelineMode === 'full_chain') {
    return ALLOWED_EDGES;
  }
  if (channel !== undefined && isInternalizationChannel(channel)) {
    return CHANNEL_EDGES[channel];
  }
  return ALLOWED_EDGES;
}

/**
 * Allowed edges in the diagnostician chain.
 * diag_rootcause → diag_distiller → diag_router
 */
export const DIAGNOSTICIAN_EDGES: readonly (readonly [DiagnosticianStageKind, DiagnosticianStageKind])[] = [
  ['diag_rootcause', 'diag_distiller'] as const,
  ['diag_distiller', 'diag_router'] as const,
] as const;

// ── Edge Validation ────────────────────────────────────────────────────────────

/**
 * PRI-720: topology scope selecting the edge set for a graph query.
 * Absent scope = full graph (legacy callers, backward compatible).
 */
export interface EdgeScope {
  channel?: InternalizationChannel;
  pipelineMode?: PipelineTopologyMode;
}

/**
 * Validates whether a transition from one runner to another is legal.
 *
 * Channel-aware since PRI-720: the edge set is resolved from the task's
 * channel + pipeline topology mode via resolveChannelEdges. Without a scope
 * the full graph is checked (backward-compatible with legacy callers); with
 * `pipelineMode: 'full_chain'` the full graph is always allowed regardless of
 * channel.
 *
 * @param from - Source peer runner kind
 * @param to - Target peer runner kind
 * @param scope - Channel + topology mode of the task chain
 */
export function validateEdge(
  from: PeerRunnerKind,
  to: PeerRunnerKind,
  scope?: EdgeScope,
): boolean {
  return resolveChannelEdges(scope?.channel, scope?.pipelineMode).some(([f, t]) => f === from && t === to);
}

/**
 * Validates whether a diagnostician chain transition is legal.
 */
export function validateDiagEdge(
  from: DiagnosticianStageKind,
  to: DiagnosticianStageKind,
): boolean {
  return DIAGNOSTICIAN_EDGES.some(([f, t]) => f === from && t === to);
}

/**
 * Returns allowed successor for a diagnostician stage kind.
 */
export function getDiagSuccessors(from: DiagnosticianStageKind): DiagnosticianStageKind[] {
  return DIAGNOSTICIAN_EDGES
    .filter(([f]) => f === from)
    .map(([, t]) => t);
}

// ── DAG Validation (Kahn's Algorithm) ────────────────────────────────────────

/**
 * Checks whether a set of edges forms a valid DAG (no cycles).
 *
 * Uses Kahn's algorithm for topological sorting:
 *   1. Compute in-degree for all nodes
 *   2. Start with nodes having in-degree 0
 *   3. BFS: remove nodes, update in-degrees of neighbors
 *   4. If all nodes visited (no cycles) → valid DAG
 *   5. If nodes remain unvisited (cycles detected) → invalid
 *
 * @param edges - Array of [from, to] edge pairs
 * @returns true if edges form a valid DAG, false if cycles exist
 */
export function isAcyclic(
  edges: readonly (readonly [string, string])[],
): boolean {
  if (edges.length === 0) {
    return true; // Empty graph is acyclic
  }

  // Collect all nodes
  const nodes = new Set<string>();
  for (const [from, to] of edges) {
    nodes.add(from);
    nodes.add(to);
  }

  // Initialize adjacency list and in-degree map
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node, 0);
    adj.set(node, []);
  }

  // Build graph
  for (const [from, to] of edges) {
    const fromAdj = adj.get(from);
    if (fromAdj) fromAdj.push(to);
    inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [node, degree] of inDegree) {
    if (degree === 0) {
      queue.push(node);
    }
  }

  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) break;
    visited++;

    const neighbors = adj.get(node);
    if (!neighbors) continue;
    for (const next of neighbors) {
      const newDegree = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, newDegree);
      if (newDegree === 0) {
        queue.push(next);
      }
    }
  }

  return visited === nodes.size;
}

// ── Successor Queries ─────────────────────────────────────────────────────────

/**
 * Returns all allowed successor runner kinds for a given runner.
 *
 * Channel-aware since PRI-720 (see resolveChannelEdges): prompt/defer_archive
 * chains route scribe → rollout_reviewer; full-chain mode and unchannelled
 * legacy reads keep the linear graph. rollout_reviewer is terminal.
 *
 * @param from - Source peer runner kind
 * @param channel - Internalization channel of the task chain
 * @param pipelineMode - Explicit topology mode override
 * @returns Array of allowed successor runner kinds
 */
export function getAllowedSuccessors(
  from: PeerRunnerKind,
  channel?: InternalizationChannel,
  pipelineMode?: PipelineTopologyMode,
): PeerRunnerKind[] {
  return resolveChannelEdges(channel, pipelineMode)
    .filter(([f]) => f === from)
    .map(([, t]) => t);
}

/**
 * Returns all allowed predecessor runner kinds for a given runner.
 *
 * Channel-aware since PRI-720 (see resolveChannelEdges).
 *
 * @param to - Target peer runner kind
 * @param channel - Internalization channel of the task chain
 * @param pipelineMode - Explicit topology mode override
 * @returns Array of allowed predecessor runner kinds
 */
export function getAllowedPredecessors(
  to: PeerRunnerKind,
  channel?: InternalizationChannel,
  pipelineMode?: PipelineTopologyMode,
): PeerRunnerKind[] {
  return resolveChannelEdges(channel, pipelineMode)
    .filter(([, t]) => t === to)
    .map(([f]) => f);
}

// ── Re-export constants from peer-runner-contracts ─────────────────────────────

export { PEER_RUNNER_KINDS, INTERNALIZATION_CHANNELS } from './peer-runner-contracts.js';
