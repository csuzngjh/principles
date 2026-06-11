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

import type { InternalizationChannel, PeerRunnerKind, DiagnosticianStageKind } from './peer-runner-contracts.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Allowed edges in the job graph (v1).
 * Each tuple is [from, to] meaning from → to is a legal transition.
 *
 * v1 policy B: trainer is terminal successor of rollout_reviewer only.
 * Fan-out to trainer from arbitrary runners is future scope (v2+).
 *
 * @see ADR-0003 Section 3.7
 */
export const ALLOWED_EDGES: readonly (readonly [PeerRunnerKind, PeerRunnerKind])[] = [
  ['dreamer', 'philosopher'] as const,
  ['philosopher', 'scribe'] as const,
  ['scribe', 'artificer'] as const,
  ['artificer', 'evaluator'] as const,
  ['evaluator', 'rollout_reviewer'] as const,
  ['rollout_reviewer', 'trainer'] as const,
] as const;

/**
 * Allowed edges in the diagnostician chain.
 * diag_rootcause → diag_distiller → diag_router
 */
export const DIAGNOSTICIAN_EDGES: readonly (readonly [DiagnosticianStageKind, DiagnosticianStageKind])[] = [
  ['diag_rootcause', 'diag_distiller'] as const,
  ['diag_distiller', 'diag_router'] as const,
] as const;

/**
 * The channel required for the rollout_reviewer → trainer transition.
 * v1 policy B: trainer is terminal successor of rollout_reviewer only.
 */
export const MODEL_TRAINING_CHANNEL: InternalizationChannel = 'model_training';

/**
 * The trainer peer runner kind.
 */
export const TRAINER_KIND: PeerRunnerKind = 'trainer';

// ── Edge Validation ────────────────────────────────────────────────────────────

/**
 * Validates whether a transition from one runner to another is legal.
 *
 * For non-trainer targets: checks ALLOWED_EDGES
 * For trainer target: requires model_training channel AND source must be rollout_reviewer
 *   (v1 policy B: trainer is terminal successor of rollout_reviewer only)
 *
 * @param from - Source peer runner kind
 * @param to - Target peer runner kind
 * @param channel - Optional internalization channel (required for trainer target)
 */
export function validateEdge(
  from: PeerRunnerKind,
  to: PeerRunnerKind,
  channel?: InternalizationChannel,
): boolean {
  // Trainer requires model_training channel AND rollout_reviewer source (v1 policy B)
  if (to === TRAINER_KIND) {
    return from === 'rollout_reviewer' && channel === MODEL_TRAINING_CHANNEL;
  }

  // Non-trainer targets: check allowed edges
  return ALLOWED_EDGES.some(([f, t]) => f === from && t === to);
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
 * v1 policy B: returns only ALLOWED_EDGES successors.
 * trainer is terminal v1 successor of rollout_reviewer only (no fan-out shortcut).
 *
 * @param from - Source peer runner kind
 * @returns Array of allowed successor runner kinds
 */
export function getAllowedSuccessors(from: PeerRunnerKind): PeerRunnerKind[] {
  return ALLOWED_EDGES
    .filter(([f]) => f === from)
    .map(([, t]) => t);
}

/**
 * Returns all allowed predecessor runner kinds for a given runner.
 *
 * @param to - Target peer runner kind
 * @returns Array of allowed predecessor runner kinds
 */
export function getAllowedPredecessors(to: PeerRunnerKind): PeerRunnerKind[] {
  return ALLOWED_EDGES
    .filter(([, t]) => t === to)
    .map(([f]) => f);
}

// ── Re-export constants from peer-runner-contracts ─────────────────────────────

export { PEER_RUNNER_KINDS, INTERNALIZATION_CHANNELS } from './peer-runner-contracts.js';