/**
 * After-Tool-Call Decomposition Helpers — PRI-326
 *
 * Extracted functions from handleAfterToolCall that implement
 * individual pipeline stages. Each function has a focused responsibility.
 *
 * Pipeline order: classify → record → hygiene
 *
 * ERR checklist:
 * - ERR-001: No `as` casts on untrusted runtime values.
 * - ERR-002: Every skip/rejection includes structured reason + nextAction.
 * - EP-01: Runtime values validated before use.
 * - EP-03: No silent failures — every path is logged or structured.
 */

import { isRisky, normalizePath } from '../utils/io.js';
import { normalizeProfile } from '../core/profile.js';
import { trackSessionControlActivity, type SessionState } from '../core/session-tracker.js';
import { denoiseError, computeHash } from '../utils/hashing.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { createTraceId } from '../utils/trace-id.js';
import type { PluginHookAfterToolCallEvent } from '../openclaw-sdk.js';
import { sanitizeToolParamsForEvidence } from './message-sanitize.js';
import { buildToolFailureObservation } from './raw-observation-adapter.js';
import type { ToolCallOutcome, ToolCallObservation } from './after-tool-call-types.js';

const RESULT_PREVIEW_MAX_LENGTH = 500;

/**
 * PRI-750: narrow an untrusted host id field (rc-1) — only non-empty strings
 * pass. The OpenClaw after_tool_call event types these ids as `unknown` via
 * the SDK index signature; the host supplies `runId`/`toolCallId`.
 */
function hostIdString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * PRI-750: narrow the host tool-id field with the same precedence as the pain
 * pipeline (pain.ts): `toolUseId` is the preferred event identifier,
 * `toolCallId` the fallback (both host-supported shapes).
 */
function hostToolIdString(event: { [key: string]: unknown }): string | undefined {
  return hostIdString(Object.hasOwn(event, 'toolUseId') ? event.toolUseId : event.toolCallId);
}

/**
 * Extract a preview string from tool call result for diagnostic evidence.
 * Pure function — no I/O, no side effects. ERR-001 / ERR-014 compliant.
 */
export function extractToolResultPreview(result: unknown): string | null {
  if (result === null || result === undefined) return null;

  try {
    // String result: truncate directly
    if (typeof result === 'string') {
      return result.length > RESULT_PREVIEW_MAX_LENGTH
        ? `${result.slice(0, RESULT_PREVIEW_MAX_LENGTH - 3)}...`
        : result;
    }

    // Object with content array (e.g., Anthropic content blocks)
    if (typeof result === 'object' && !Array.isArray(result)) {
      const obj = result as Record<string, unknown>;
      if (Array.isArray(obj.content)) {
        const textParts: string[] = [];
        for (const block of obj.content) {
          if (block && typeof block === 'object' && !Array.isArray(block)) {
            const blockObj = block as Record<string, unknown>;
            if (blockObj.type === 'text' && typeof blockObj.text === 'string') {
              textParts.push(blockObj.text);
            }
          }
        }
        if (textParts.length > 0) {
          const joined = textParts.join('\n');
          return joined.length > RESULT_PREVIEW_MAX_LENGTH
            ? `${joined.slice(0, RESULT_PREVIEW_MAX_LENGTH - 3)}...`
            : joined;
        }
      }

      // Object without content array: JSON.stringify with depth limiter (ERR-014)
      const serialized = JSON.stringify(obj, (_key, value) => {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          const keys = Object.keys(value as Record<string, unknown>);
          if (keys.length > 10) {
            const truncated: Record<string, unknown> = {};
            for (const k of keys.slice(0, 10)) {
              truncated[k] = (value as Record<string, unknown>)[k];
            }
            truncated['__truncated__'] = true;
            return truncated;
          }
        }
        return value;
      }, 2);
      if (serialized && serialized !== '{}') {
        return serialized.length > RESULT_PREVIEW_MAX_LENGTH
          ? `${serialized.slice(0, RESULT_PREVIEW_MAX_LENGTH - 3)}...`
          : serialized;
      }
    }

    return null;
  } catch {
    return '[result_preview_extraction_failed]';
  }
}

// ── Stage 1: Classify ───────────────────────────────────────────────────────

/**
 * Classify the outcome of a tool call event.
 *
 * Pure function — no I/O, no side effects.
 * Extracts exitCode logic, determines failure/success, classifies failure source.
 */
export function classifyToolCallOutcome(event: PluginHookAfterToolCallEvent): ToolCallOutcome {
  // EP-01: Validate event.result at runtime instead of `as` cast
  const resultObj = (event.result && typeof event.result === 'object' && !Array.isArray(event.result))
    ? event.result as Record<string, unknown>  // safe: guarded by typeof + Array.isArray checks above
    : null;
  const details = (resultObj && resultObj.details && typeof resultObj.details === 'object' && !Array.isArray(resultObj.details))
    ? resultObj.details as Record<string, unknown>  // safe: guarded by typeof + Array.isArray checks above
    : null;
  const topExitCode = resultObj?.exitCode;
  const detailExitCode = details?.exitCode;

  // Prefer the first *numeric* exit code
  const exitCode = typeof topExitCode === 'number' ? topExitCode
    : typeof detailExitCode === 'number' ? detailExitCode
    : 0;
  const isFailure = !!event.error || exitCode !== 0;

  // PRI-360 S1: Use centralized builder for tool failure classification
  // All dispatch/tool_failure rules live in raw-observation-adapter.ts
  const obs = buildToolFailureObservation({
    toolName: event.toolName,
    error: event.error,
    exitCode,
  });
  const failureSource = isFailure ? obs.failureSource : undefined;

  return {
    isFailure,
    exitCode,
    failureSource,
  };
}

// ── Stage 2: Build Observation ──────────────────────────────────────────────

/**
 * Interface for tool parameters — avoids `any`.
 */
interface ToolParams {
  file_path?: string;
  path?: string;
  file?: string;
  content?: string;
  new_string?: string;
  text?: string;
  query?: string;
  input?: string;
  arguments?: string;
}

/**
 * Build a normalized observation from the tool call event and workspace context.
 *
 * Combines file path normalization, risk classification, and error analysis.
 * The profile parameter is passed in (loaded once at function scope).
 */
export function buildToolCallObservation(
  event: PluginHookAfterToolCallEvent,
  outcome: ToolCallOutcome,
  workspaceDir: string,
  profile: ReturnType<typeof normalizeProfile>,
): ToolCallObservation {
  const rawParams = event.params;
  const params: ToolParams = (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams))
    ? rawParams as ToolParams
    : {};
  const filePath = params.file_path || params.path || params.file;
  const relPath = typeof filePath === 'string' ? normalizePath(filePath, workspaceDir) : 'unknown';
  const isRisk = isRisky(relPath, profile.risk_paths);
  let errorText: string;
  if (event.error) {
    errorText = String(event.error);
  } else if (typeof event.result === 'string') {
    errorText = event.result;
  } else {
    try {
      errorText = JSON.stringify(event.result);
    } catch {
      errorText = `[unserializable result: ${typeof event.result}]`;
    }
  }
  const denoised = denoiseError(errorText);
  const hash = computeHash(denoised);

  return {
    params: {
      filePath,
      content: params.content,
      text: params.text,
      newString: params.new_string,
      query: params.query,
      input: params.input,
      arguments: params.arguments,
    },
    relPath,
    isRisk,
    errorType: extractErrorType(event.error || errorText),
    errorHash: hash,
    errorText,
    traceId: createTraceId(),
  };
}

// ── Stage 3: Recording ─────────────────────────────────────────────────────

/**
 * Record a failed tool call and mark session activity.
 */
export function recordToolCallFailure(
  sessionId: string,
  event: PluginHookAfterToolCallEvent,
  outcome: ToolCallOutcome,
  observation: ToolCallObservation,
  workspaceDir: string,
  wctx: WorkspaceContext,
  options: { recordTrajectory?: boolean } = {},
): SessionState {
  const updatedState = trackSessionControlActivity(sessionId, workspaceDir);

  // Record tool call failure event
  wctx.eventLog.recordToolCall(sessionId, {
    toolName: event.toolName,
    filePath: observation.params.filePath,
    error: event.error ? String(event.error).substring(0, 200) : undefined,
    errorType: observation.errorType,
    exitCode: outcome.exitCode as number | undefined,
    // PRI-750: host run/tool ids from the after_tool_call event — DIRECT
    // turn binding to assistant_turns.run_id. Absent when the host supplies
    // none (event stays compatible).
    runId: hostIdString(event.runId),
    toolCallId: hostToolIdString(event),
  });

  if (options.recordTrajectory !== false) wctx.trajectory?.recordToolCall?.({
    sessionId,
    toolName: event.toolName,
    outcome: 'failure',
    durationMs: event.durationMs,
    exitCode: outcome.exitCode as number | undefined,
    errorType: observation.errorType,
    errorMessage: event.error ? String(event.error) : undefined,
    paramsJson: sanitizeToolParamsForEvidence(event.params, workspaceDir),
    resultPreview: extractToolResultPreview(event.result),
  });

  return updatedState;
}

/**
 * Record a successful tool call and mark session activity.
 */
export function recordToolCallSuccess(
  sessionId: string,
  event: PluginHookAfterToolCallEvent,
  outcome: ToolCallOutcome,
  observation: ToolCallObservation,
  workspaceDir: string,
  wctx: WorkspaceContext,
  options: { recordTrajectory?: boolean } = {},
): SessionState {
  const updatedState = trackSessionControlActivity(sessionId, workspaceDir);

  if (options.recordTrajectory !== false) wctx.trajectory?.recordToolCall?.({
    sessionId,
    toolName: event.toolName,
    outcome: 'success',
    durationMs: event.durationMs,
    exitCode: outcome.exitCode,
    paramsJson: sanitizeToolParamsForEvidence(event.params, workspaceDir),
    resultPreview: extractToolResultPreview(event.result),
  });

  wctx.eventLog.recordToolCall(sessionId, {
    toolName: event.toolName,
    filePath: observation.params.filePath,
    // PRI-750: host run/tool ids from the after_tool_call event — DIRECT
    // turn binding to assistant_turns.run_id.
    runId: hostIdString(event.runId),
    toolCallId: hostToolIdString(event),
  });

  return updatedState;
}

// ── Stage 4: Hygiene Tracking ───────────────────────────────────────────────

/**
 * Record hygiene tracking for memory/plan persistence actions on success.
 */
export function recordHygieneTracking(
  event: PluginHookAfterToolCallEvent,
  observation: ToolCallObservation,
  wctx: WorkspaceContext,
): void {
  const normalized = typeof observation.params.filePath === 'string' ? observation.params.filePath.replace(/\\/g, '/') : '';
  const isMemory = /(?:^|\/)memory\//.test(normalized) || normalized.endsWith('/MEMORY.md') || normalized === 'MEMORY.md';
  const isPlan = normalized === 'PLAN.md' || normalized.endsWith('/PLAN.md');

  if (isMemory || isPlan) {
    wctx.hygiene.recordPersistence({
      ts: new Date().toISOString(),
      tool: event.toolName,
      path: observation.params.filePath ?? 'unknown',
      type: isMemory ? 'memory' : 'plan',
      contentLength: observation.params.content?.length ?? observation.params.newString?.length ?? 0,
    });
  }

  // Special case for memory_store tool (Success only)
  if (event.toolName === 'memory_store') {
    wctx.hygiene.recordPersistence({
      ts: new Date().toISOString(),
      tool: event.toolName,
      path: 'DATABASE',
      type: 'memory',
      contentLength: observation.params.text?.length ?? 0,
    });
  }
}

// ── Source Classification ────────────────────────────────────────────────────

// classifyToolFailureSource logic is now in resolveSourceKind (PRI-360 S1)
// This function is removed to avoid duplication.

/**
 * Extract error type classification from error value.
 */
function extractErrorType(error: unknown): string {
  if (!error) return 'Unknown';
  const msg = String(error);
  if (msg.includes('EACCES') || msg.includes('permission denied')) return 'EACCES';
  if (msg.includes('ENOENT') || msg.includes('no such file')) return 'ENOENT';
  if (msg.includes('EISDIR')) return 'EISDIR';
  if (msg.includes('ENOSPC')) return 'ENOSPC';
  if (msg.includes('SyntaxError')) return 'SyntaxError';
  if (msg.includes('TypeError')) return 'TypeError';
  if (msg.includes('ReferenceError')) return 'ReferenceError';
  if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) return 'Timeout';
  if (msg.includes('network') || msg.includes('ECONNREFUSED')) return 'Network';
  return 'Other';
}
