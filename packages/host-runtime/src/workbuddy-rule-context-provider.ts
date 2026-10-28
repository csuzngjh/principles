import path from 'node:path';
import {
  computeBehaviorFacts,
  type RuleContextV2,
  type RuleHistoryWindow,
  type ToolSemanticRegistry,
} from '@principles/core/runtime-v2';
import type { ProductionRuleContextRequest, RuleContextProvider } from './production-rulehost-gate.js';
import { assembleBehaviorHistory } from './behavior-history.js';
import { readWorkspaceRuleContextRowsBefore } from './workspace-behavior-evidence.js';

const HISTORY_LIMIT = 100;
const MAX_REASON_LENGTH = 240;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unavailable(reason: string): RuleContextV2 {
  const history: RuleHistoryWindow = {
    status: 'unavailable',
    unavailableReason: reason.replace(/\s+/g, ' ').slice(0, MAX_REASON_LENGTH),
    truncated: false,
    calls: [],
  };
  return {
    version: 2,
    history,
    facts: computeBehaviorFacts(history, null, null),
  };
}

export interface WorkbuddyRuleContextProviderOptions {
  /** The WorkBuddy governance workspace whose trajectory database is authoritative. */
  workspaceDir: string;
  /** The host project cwd the hook observed (payload cwd); history rows must have this exact stored scope. Absent on channels that carry none. */
  projectDir?: string;
  /** The existing `rulecode_context_v2` gate. */
  enabled: boolean;
  /** Timestamp captured immediately after decoding this hook event. */
  cutoffAt: Date;
  /** Host-authoritative current WorkBuddy call_id, excluded even on timestamp ties. */
  currentToolCallId: string;
  toolSemantics: ToolSemanticRegistry;
}

/**
 * SPEC-RULECODE-HOST-PROMOTION-001 C: the WorkBuddy RuleContext provider.
 *
 * It reads the SAME canonical trajectory store the shared afterToolCall
 * production path writes for WorkBuddy (`tool_calls` rows carrying the
 * host's natural session/call ids and the observed project cwd) — genuinely
 * observable WorkBuddy data, never borrowed Codex history. WorkBuddy has no
 * design-gate declaration entry point (the Codex-native attestation source
 * is Codex-only), so this provider deliberately supplies NO designGate
 * fact: a rule whose required facts include design_approval stays suspended
 * on this host with the precise `rule_required_fact_unavailable` warning
 * instead of inheriting another host's attestation.
 *
 * Disabled, unscoped or unverifiable sources return explicit unavailable
 * contexts — v2 rules then suspend through the existing shared-gate
 * contract, which is the honest state until the missing input exists.
 */
export function createWorkbuddyRuleContextProvider(options: WorkbuddyRuleContextProviderOptions): RuleContextProvider {
  const workspaceDir = path.resolve(options.workspaceDir);
  const projectDir = options.projectDir !== undefined ? path.resolve(options.projectDir) : undefined;

  return (request: ProductionRuleContextRequest): unknown => {
    if (typeof request.sessionId !== 'string' || request.sessionId.trim().length === 0) {
      return unavailable('session_id_invalid');
    }
    if (!options.enabled) return unavailable('workbuddy_rule_context_disabled');
    if (path.resolve(request.workspaceDir) !== workspaceDir) return unavailable('workspace_scope_mismatch');
    if (projectDir === undefined || !path.isAbsolute(projectDir)) {
      return unavailable('workbuddy_project_scope_unavailable');
    }
    const raw = request.rawPayload;
    const toolInput = isRecord(raw) && isRecord(raw.toolInput) ? raw.toolInput : null;
    if (toolInput === null
      || toolInput.toolName !== request.toolName
      || !isRecord(toolInput.params)
      || options.currentToolCallId.trim().length === 0) {
      return unavailable('workbuddy_pre_tool_scope_mismatch');
    }
    const cutoff = options.cutoffAt;
    if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) return unavailable('history_cutoff_invalid');
    try {
      const historyRows = readWorkspaceRuleContextRowsBefore(
        workspaceDir,
        {
          sessionId: request.sessionId,
          projectDir,
          beforeCreatedAt: cutoff.toISOString(),
          excludeToolUseId: options.currentToolCallId,
          limit: HISTORY_LIMIT,
        },
      );
      if (historyRows.unscopedPriorRows) return unavailable('trajectory_project_scope_incomplete');
      if (historyRows.rows.length === 0) return unavailable('no_prior_session_history');
      const history = assembleBehaviorHistory(historyRows.rows, historyRows.truncated, {
        projectDir,
        toolSemantics: options.toolSemantics,
      });
      // WorkBuddy exposes its shell as the Bash tool, and MCP-style tools may
      // resolve to 'other' absent from this host's semantic registry. Either
      // may read or mutate files, so target-read absence and exact action
      // counts cannot be asserted from this partial semantic view (same
      // conservative rule as the Codex provider).
      const factsIncomplete = history.truncated || history.calls.some((call) =>
        call.canonicalKind === 'execute' || call.canonicalKind === 'other');
      const computedFacts = computeBehaviorFacts(history, factsIncomplete ? null : request.targetPath, null);
      const facts = factsIncomplete
        ? {
          priorReadOfTarget: 'unknown' as const,
          readCount: null,
          writeCount: null,
          uniqueWritePathCount: null,
          sameActionBlockCount: null,
        }
        : computedFacts;
      return {
        version: 2,
        history,
        facts,
      } satisfies RuleContextV2;
    } catch (error: unknown) {
      return unavailable(`trajectory_history_unavailable:${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
