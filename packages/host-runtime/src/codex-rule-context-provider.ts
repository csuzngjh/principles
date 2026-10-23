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
import { readLatestCodexDesignGateDeclaration, resolveCodexDesignGateFact } from './design-gate-facts.js';

const HISTORY_LIMIT = 100;
const MAX_REASON_LENGTH = 240;
const MAX_PATCH_BYTES = 1024 * 1024;
const APPROVED_READONLY_COMMANDS = new Set([
  'git status',
  'git status --short',
  'git diff --stat',
  'git log -1 --oneline',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function patchTargets(params: Record<string, unknown> | null, projectDir: string): string[] | undefined {
  if (params === null) return undefined;
  const patch = typeof params.patch === 'string'
    ? params.patch
    : typeof params.input === 'string' ? params.input : null;
  if (patch === null || Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) return undefined;
  const targets: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move (?:from|to): (.+)$/.exec(line);
    if (!match) continue;
    const value = (match[1] ?? match[2] ?? '').trim();
    if (value.length === 0 || value.includes('\0')) return undefined;
    targets.push(path.resolve(projectDir, value));
  }
  return targets.length > 0 ? targets : undefined;
}

function safeReadonlyCommand(params: Record<string, unknown> | null): boolean {
  if (params === null) return false;
  const command = typeof params.command === 'string' ? params.command : null;
  return command !== null && APPROVED_READONLY_COMMANDS.has(command.trim());
}

function unavailable(reason: string, designGate?: RuleContextV2['facts']['designGate']): RuleContextV2 {
  const history: RuleHistoryWindow = {
    status: 'unavailable',
    unavailableReason: reason.replace(/\s+/g, ' ').slice(0, MAX_REASON_LENGTH),
    truncated: false,
    calls: [],
  };
  return {
    version: 2,
    history,
    facts: { ...computeBehaviorFacts(history, null, null), ...(designGate !== undefined ? { designGate } : {}) },
  };
}

export interface CodexRuleContextProviderOptions {
  /** The resolved PD workspace whose trajectory database is authoritative. */
  workspaceDir: string;
  /** Native Codex project cwd; history rows must have this exact stored scope. */
  projectDir: string;
  /** Existing `rulecode_context_v2` and `codex_conversation_ingestion` gates. */
  enabled: boolean;
  /** Timestamp captured immediately after decoding this PreToolUse event. */
  cutoffAt: Date;
  /** Host-authoritative current Codex tool_use_id, excluded even on timestamp ties. */
  currentToolUseId: string;
  toolSemantics: ToolSemanticRegistry;
}

/**
 * Read a bounded same-session trajectory window for Codex PreToolUse events.
 * It never reads the Codex transcript itself: only already-ingested tool rows
 * from the resolved workspace are eligible, and rows at/after the captured
 * hook epoch or belonging to the current tool_use_id are excluded. Disabled
 * or unverifiable sources return explicit unknowns.
 */
export function createCodexRuleContextProvider(options: CodexRuleContextProviderOptions): RuleContextProvider {
  const workspaceDir = path.resolve(options.workspaceDir);
  const projectDir = path.resolve(options.projectDir);

  return (request: ProductionRuleContextRequest): unknown => {
    const canonicalKind = options.toolSemantics.resolve(request.toolName);
    const targetKind = canonicalKind === 'agent' ? 'other' : canonicalKind;
    const raw = request.rawPayload;
    const rawParams = isRecord(raw) && isRecord(raw.toolInput) && isRecord(raw.toolInput.params)
      ? raw.toolInput.params
      : null;
    const readonlyExecute = targetKind === 'execute' && safeReadonlyCommand(rawParams);
    const designGate = resolveCodexDesignGateFact({
      governanceWorkspacePath: workspaceDir,
      projectWorkspacePath: projectDir,
      hostSessionId: request.sessionId,
      targetPath: targetKind === 'execute' ? projectDir : request.targetPath,
      ...(targetKind === 'write' && request.toolName === 'apply_patch'
        ? { targetPaths: patchTargets(rawParams, projectDir) ?? [] }
        : {}),
      ...(targetKind === 'execute' ? { projectScopedExecution: true } : {}),
      toolKind: readonlyExecute ? 'read' : targetKind,
    }, {
      getLatestDeclaration(projectWorkspacePath, hostSessionId) {
        return readLatestCodexDesignGateDeclaration(workspaceDir, projectWorkspacePath, hostSessionId);
      },
    });
    if (!options.enabled) return unavailable('codex_rule_context_disabled', designGate);
    if (path.resolve(request.workspaceDir) !== workspaceDir) return unavailable('workspace_scope_mismatch', designGate);
    if (typeof request.sessionId !== 'string' || request.sessionId.trim().length === 0) return unavailable('session_id_invalid', designGate);

    const toolInput = isRecord(raw) && isRecord(raw.toolInput) ? raw.toolInput : null;
    if (toolInput === null
      || toolInput.toolName !== request.toolName
      || !isRecord(toolInput.params)
      || !path.isAbsolute(projectDir)
      || options.currentToolUseId.trim().length === 0) {
      return unavailable('codex_pre_tool_scope_mismatch', designGate);
    }

    const cutoff = options.cutoffAt;
    if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) return unavailable('history_cutoff_invalid', designGate);
    try {
      const historyRows = readWorkspaceRuleContextRowsBefore(
        workspaceDir,
        {
          sessionId: request.sessionId,
          projectDir,
          beforeCreatedAt: cutoff.toISOString(),
          excludeToolUseId: options.currentToolUseId,
          limit: HISTORY_LIMIT,
        },
      );
      if (historyRows.unscopedPriorRows) return unavailable('trajectory_project_scope_incomplete', designGate);
      if (historyRows.rows.length === 0) return unavailable('no_prior_session_history', designGate);
      const history = assembleBehaviorHistory(historyRows.rows, historyRows.truncated, {
        projectDir,
        toolSemantics: options.toolSemantics,
      });
      // Codex exposes shell as execute, and other host tools may be MCP calls
      // absent from this host's semantic registry. Either may read or mutate
      // files, so neither target-read absence nor exact action counts can be
      // asserted from this partial semantic view.
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
        facts: { ...facts, designGate },
      } satisfies RuleContextV2;
    } catch (error: unknown) {
      return unavailable(`trajectory_history_unavailable:${error instanceof Error ? error.message : String(error)}`, designGate);
    }
  };
}

