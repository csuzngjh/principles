/**
 * Evaluator Runtime Context — PRI-661: ONE builder for the deterministic
 * adversarial-replay context every HOST-NEUTRAL evaluator entry uses.
 *
 * WHY THIS EXISTS: PR #1495 wired the shared consumer cycle (in-host
 * auto-consumer / Codex worker) with production gateDeps + the host-threaded
 * tool registry, but the host-neutral CLI entries kept divergent wiring:
 *
 *   - `pd runtime internalization run-once --runner evaluator` assembled
 *     EvaluatorRunner with NO gateDeps at all — the deterministic adversarial
 *     replay was structurally unreachable (the code-bearing guard fails loud
 *     with an assembly defect instead of evaluating anything);
 *   - `pd runtime internalization run-rulehost` (rulehost-pipeline-runner)
 *     replayed through the bare sandbox gate — no workspace root, no host
 *     tool registry — so a rule could pass generation-time replay and fail
 *     the production activation gate on the SAME workspace (the exact
 *     drift class PRI-634-F closed everywhere else).
 *
 * WHAT THIS MODULE IS NOT: it is not a second tool registry and not a new
 * authority. Host-threaded callers (the consumer cycle) keep passing their
 * live in-memory registry — the running host IS the authority for its own
 * session. Host-neutral callers omit it and the DURABLE workspace provenance
 * (`.pd/host-tool-semantics/<hostKind>.json`, persisted by every host on
 * startup) is resolved through the ONE resolver
 * (`resolveWorkspaceHostToolSemantics`). Unresolvable provenance is a
 * structured refusal — never a silent fallback to the core baseline (an
 * existence check against baseline names is a forged proof; ERR-114).
 *
 * Parity contract (pinned by evaluator-runtime-context.test.ts and the
 * run-once evaluator parity test): the same artifact + workspace + declared
 * host produces the SAME deterministic replay verdict whether it travels the
 * consumer cycle (live registry) or a CLI entry (durable declaration), because
 * hosts persist the same mapping constants they pass in memory.
 */

import {
  createProductionGateDeps,
  type RefinerRuleHostGateDeps,
  type ToolSemanticRegistry,
} from '@principles/core/runtime-v2';
import { resolveWorkspaceHostToolSemantics } from './host-tool-semantic-resolver.js';

export interface EvaluatorRuntimeContextInput {
  /** Workspace root the replay normalizes paths against (projectDir). */
  readonly workspaceDir: string;
  /**
   * Host-threaded callers pass their live registry here (consumer-cycle
   * ports). Host-neutral CLI callers omit it — the durable workspace
   * declaration is resolved instead.
   */
  readonly toolSemantics?: ToolSemanticRegistry;
}

export type EvaluatorRuntimeContextResolution =
  | { readonly ok: true; readonly gateDeps: RefinerRuleHostGateDeps }
  | { readonly ok: false; readonly reason: string; readonly nextAction: string };

/**
 * Build the evaluator's deterministic replay context.
 *
 * Mirrors the consumer-cycle assembly (PRI-634 A1/A3):
 *   gateDeps: createProductionGateDeps({ toolSemantics, projectDir: workspaceDir })
 * — gateDeps belongs to evaluator PRODUCTION semantics, never to host-optional
 * capability, and always travels in the runner OPTIONS (second constructor
 * argument), never the deps argument.
 */
export function createEvaluatorRuntimeContext(input: EvaluatorRuntimeContextInput): EvaluatorRuntimeContextResolution {
  if (input.toolSemantics) {
    return {
      ok: true,
      gateDeps: createProductionGateDeps({ projectDir: input.workspaceDir, toolSemantics: input.toolSemantics }),
    };
  }
  const resolved = resolveWorkspaceHostToolSemantics(input.workspaceDir);
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason, nextAction: resolved.nextAction };
  }
  return {
    ok: true,
    gateDeps: createProductionGateDeps({ projectDir: input.workspaceDir, toolSemantics: resolved.registry }),
  };
}
