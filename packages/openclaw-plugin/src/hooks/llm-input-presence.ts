/**
 * PRI-1150 Path A: official llm_input hook handler — post-assembly presence
 * observation on unmodified published hosts (design v2, as amended).
 *
 * Boundary: post_assembly_system_prompt_via_llm_input. Fact-only. This never
 * asserts the actual request, network delivery, model adherence or
 * D/confirmed/timely, and it never blocks the caller.
 *
 * Binding rules (owner revision constraints):
 * - Candidates are narrowed by runId+sessionId (the only verifiable facts the
 *   official event carries) and resolved through the bounded registry.
 * - UNIQUE binding requires exactly one live snapshot AND complete candidate
 *   history. Multi-candidate or incomplete history → unknown:ambiguous_binding /
 *   history_incomplete. No latest-only, FIFO-first, time-proximity or
 *   body-equality selection; PD-internal ordinals are diagnostic only.
 * - Missing / expired / evicted / empty snapshots are distinguished and never
 *   reported as "no principle was injected".
 * - Body text stays in memory: containment facts only enter the event.
 */

import type { PluginHookAgentContext, PluginHookLlmInputEvent, PluginLogger } from '../openclaw-sdk.js';
import { EventLog } from '../core/event-log.js';
import { getPromptPresenceRegistry } from './prompt-presence-registry.js';
import { checkAssemblyPresence } from './prompt-presence-lite.js';

export function handleLlmInputPresence(params: {
  event: PluginHookLlmInputEvent;
  ctx: PluginHookAgentContext;
  workspaceDir: string;
  logger?: PluginLogger;
  eventLog?: EventLog;
}): void {
  const registry = getPromptPresenceRegistry();
  const runId = typeof params.event.runId === 'string' ? params.event.runId : '';
  const sessionId = typeof params.event.sessionId === 'string' ? params.event.sessionId : '';
  const systemPrompt = params.event.systemPrompt;

  const base = {
    runId,
    sessionId,
    provider: typeof params.event.provider === 'string' ? params.event.provider : undefined,
    model: typeof params.event.model === 'string' ? params.event.model : undefined,
    boundary: 'post_assembly_system_prompt_via_llm_input' as const,
  };

  try {
    // Missing identity: without runId or sessionId no candidate narrowing is
    // possible — report as an unknown-flavoured fact, never as "not injected".
    if (!runId || !sessionId) {
      params.eventLog?.recordPromptPresenceObserved({
        ...base,
        binding: 'none',
        liveSnapshots: 0,
        assemblySeqCandidates: [],
        checked: false,
        reason: 'missing_identity',
        nextAction: 'identity fields (runId/sessionId) absent on the official event; presence observation skipped',
      });
      return;
    }

    const binding = registry.resolveBinding({ runId, sessionId });
    const stats = registry.stats();
    const registryFacts = {
      liveSnapshots: binding.status === 'unique' ? 1 : binding.status === 'ambiguous' ? binding.liveSnapshots : 0,
      evictedCount: stats.evictedCount,
      expiredCount: stats.expiredCount,
      registryKeys: stats.keys,
    };

    if (binding.status === 'no_key') {
      params.eventLog?.recordPromptPresenceObserved({
        ...base,
        binding: 'none',
        ...registryFacts,
        assemblySeqCandidates: [],
        checked: false,
        reason: 'missing_expectations',
        nextAction: 'no frozen assembly snapshot for this run; llm_input callbacks without a prior PD prompt build are not observable',
      });
      return;
    }
    if (binding.status === 'expired') {
      params.eventLog?.recordPromptPresenceObserved({
        ...base,
        binding: 'none',
        ...registryFacts,
        assemblySeqCandidates: [],
        checked: false,
        reason: 'expectations_expired',
        nextAction: 'all snapshots for this run passed their TTL before the callback arrived',
      });
      return;
    }
    if (binding.status === 'history_incomplete') {
      params.eventLog?.recordPromptPresenceObserved({
        ...base,
        binding: 'ambiguous',
        ...registryFacts,
        assemblySeqCandidates: [],
        checked: false,
        reason: 'history_incomplete',
        nextAction: 'candidate history was reduced (TTL/capacity); unique binding is unavailable by design',
      });
      return;
    }
    if (binding.status === 'ambiguous') {
      params.eventLog?.recordPromptPresenceObserved({
        ...base,
        binding: 'ambiguous',
        ...registryFacts,
        assemblySeqCandidates: [],
        checked: false,
        reason: 'ambiguous_binding',
        nextAction: 'multiple live assemblies for this run and the official event cannot identify one; no snapshot was selected',
      });
      return;
    }

    // Unique, complete-history binding: run the bounded containment check.
    // A degraded (empty) snapshot still binds uniquely — it reports
    // checked=false:empty_snapshot so "nothing injected this build" stays
    // distinct from "never injected" or "cannot observe".
    const snapshot = binding.snapshot;
    const registryFactsWithSeq = {
      ...registryFacts,
      assemblySeqCandidates: [snapshot.assemblySeq] as number[],
    };
    if (snapshot.expectations.length === 0) {
      params.eventLog?.recordPromptPresenceObserved({
        ...base,
        binding: 'unique',
        ...registryFactsWithSeq,
        liveSnapshots: 1,
        checked: false,
        reason: snapshot.overflowCount > 0 ? 'snapshot_over_limit' : 'empty_snapshot',
        ...(snapshot.overflowCount > 0 ? { expectationsOverflow: snapshot.overflowCount } : {}),
        nextAction: snapshot.overflowCount > 0
          ? 'the frozen snapshot exceeded the registration body cap and was degraded'
          : 'the frozen assembly carried no expectations (nothing injected by PD this build)',
      });
      return;
    }
    const check = checkAssemblyPresence({
      observedText: systemPrompt,
      expectations: snapshot.expectations,
    });
    params.eventLog?.recordPromptPresenceObserved({
      ...base,
      binding: 'unique',
      liveSnapshots: 1,
      assemblySeqCandidates: [snapshot.assemblySeq],
      checked: check.checked,
      ...(check.reason !== undefined ? { reason: check.reason } : {}),
      ...(check.checkFailedReason !== undefined
        ? { reason: 'check_failed' as const, nextAction: check.checkFailedReason }
        : {}),
      results: check.results.map((result) => ({
        activationId: result.activationId,
        outcome: result.outcome,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        ...(result.actualBodyChars !== undefined ? { actualBodyChars: result.actualBodyChars } : {}),
      })),
      expectationsOverflow: snapshot.overflowCount,
      evictedCount: stats.evictedCount,
      expiredCount: stats.expiredCount,
      registryKeys: stats.keys,
    });
  } catch (err) {
    // Fail-open: presence observation must never break the host callback.
    try {
      params.eventLog?.recordPromptPresenceObserved({
        ...base,
        binding: 'none',
        liveSnapshots: 0,
        assemblySeqCandidates: [],
        checked: false,
        reason: 'check_failed',
        nextAction: `handler exception: ${err instanceof Error ? err.name : typeof err}`,
      });
    } catch {
      params.logger?.warn?.(`[PD:presence] llm_input observation failed and could not be recorded: ${String(err)}`);
    }
  }
}

/**
 * Registration adapter mirroring the llm_output pattern in index.ts: the
 * workspace resolution happens in the registration closure (where `api` lives)
 * and the exported handler receives the already-resolved workspace. Exported
 * so tests drive the SAME production registration path.
 */
export function makeLlmInputPresenceRegistration(params: {
  logger?: PluginLogger;
  getEventLog: (workspaceDir: string) => EventLog | undefined;
}): {
  surfaceId: string;
  event: 'llm_input';
  onResolved: (event: PluginHookLlmInputEvent, ctx: PluginHookAgentContext, workspaceDir: string) => void;
} {
  return {
    surfaceId: 'hook:llm_input_presence',
    event: 'llm_input',
    onResolved: (event, ctx, workspaceDir) => {
      handleLlmInputPresence({
        event,
        ctx,
        workspaceDir,
        logger: params.logger,
        eventLog: params.getEventLog(workspaceDir),
      });
    },
  };
}
