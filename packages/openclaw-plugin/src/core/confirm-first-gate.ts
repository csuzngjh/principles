/**
 * Confirm-First Gate
 *
 * Hard enforcement for confirm-first Runtime V2 prompt activations.
 * When an owner-approved activation requires confirmation before coding,
 * this gate blocks mutating tools until the session has explicit owner approval.
 *
 * This is NOT a replacement for prompt injection — it's a hard fallback
 * for models that don't follow system prompt behavioral directives.
 *
 * Flow:
 * 1. Prompt hook (before_prompt_build) detects confirm-first directive and caches state
 * 2. Prompt hook detects user approval language and marks session approved
 * 3. Gate hook (before_tool_call) checks cached state synchronously
 */

import { BASH_TOOLS_SET, WRITE_TOOLS } from '../constants/tools.js';
import { SqliteConfirmFirstStateStore } from '@principles/core/runtime-v2';

/** Per-session confirm-first state */
interface ConfirmFirstSessionState {
  active: boolean;
  principleId?: string;
}

/** Size cap to prevent memory leaks from abandoned sessions */
const MAX_SESSION_ENTRIES = 500;

// TODO(PRI-268): stale directive cleanup
const sessionDirectiveState = new Map<string, ConfirmFirstSessionState>();
// TODO(PRI-267): per-task approval scope
const sessionApprovalState = new Map<string, boolean>();

let confirmFirstStore: SqliteConfirmFirstStateStore | null = null;

export function setConfirmFirstStore(store: SqliteConfirmFirstStateStore | null): void {
  confirmFirstStore = store;
}

function evictOldestIfFull(map: Map<string, unknown>): void {
  if (map.size >= MAX_SESSION_ENTRIES) {
    const firstKey = map.keys().next().value;
    if (firstKey !== undefined) map.delete(firstKey);
  }
}

export interface ConfirmFirstGateResult {
  action: 'allow' | 'block' | 'skip';
  reason?: string;
  nextAction?: string;
  principleId?: string;
}

/**
 * Check if a tool is mutating (write, edit, delete, or mutating exec).
 */
function isMutatingTool(toolName: string, params?: Record<string, unknown>): boolean {
  // Direct write/edit/delete tools are always mutating
  if (WRITE_TOOLS.has(toolName)) return true;

  // For exec/bash, only mutating if the command content is mutating
  if (BASH_TOOLS_SET.has(toolName)) {
    const command = String(params?.command || params?.args || '');
    if (!command) return false;
    return />\s*|>>\s*|\brm\b|\bmv\b|\bmkdir\b|\btouch\b|\bcp\s|\bsed\s+-i|\bchmod\b|\bchown\b|\bdel\s|\bRemove-Item\b|\bSet-Content\b|\bOut-File\b|\bNew-Item\b/.test(command);
  }

  return false;
}

/**
 * Detect if user message contains clear approval language.
 * Rejects negated forms (e.g., "don't proceed", "不同意", "确认一下").
 */
export function detectApprovalMarker(message: string): boolean {
  const trimmed = message.trim();

  // Negation prefixes — reject if present before approval keywords
  const zhNegation = /不|别|暂不|先不|无法|不能|没准备好|还没|尚未/;
  const enNegation = /don'?t|not\s+ready|can'?t|won'?t|stop|hold|cannot|isn'?t|aren'?t|haven'?t|shouldn'?t/i;

  // Single-word Chinese markers require exact match (the word alone, not embedded in a sentence)
  const zhExactMarkers = /^(?:确认|批准|同意|执行吧|开始执行)$/;
  // Multi-word Chinese markers
  const zhPhraseMarkers = /按计划执行|可以执行|就这么做|去执行|照.*做|没问题.*执行/;

  // English markers — unambiguous single-word approvals only
  const enMarkers = /\bapproved\b|\bgo\s*ahead\b|\blgtm\b/i;
  // English phrase markers — require explicit approval context
  const enPhraseMarkers = /\byes,?\s*(do\s+it|proceed|execute)\b|\bdo\s+it\b|\bproceed\s+with\s+the\s+plan\b|\bexecute\s+the\s+plan\b|\bplease\s+proceed\s+with\s+the\s+plan\b/i;

  // Check Chinese
  if (zhExactMarkers.test(trimmed) || zhPhraseMarkers.test(trimmed)) {
    // Reject if negation prefix present
    if (zhNegation.test(trimmed)) return false;
    return true;
  }

  // Check English
  if (enMarkers.test(trimmed) || enPhraseMarkers.test(trimmed)) {
    if (enNegation.test(trimmed)) return false;
    return true;
  }

  return false;
}

/**
 * Set confirm-first directive state for a session (called from prompt hook).
 */
export function setConfirmFirstDirective(
  sessionId: string,
  active: boolean,
  principleId?: string,
): void {
  evictOldestIfFull(sessionDirectiveState);
  sessionDirectiveState.set(sessionId, { active, principleId });
  if (confirmFirstStore) {
    try {
      confirmFirstStore.upsertDirective(sessionId, active, principleId ?? null);
    } catch (storeErr) {
      console.warn(`[PD:ConfirmFirst] Store write failed for directive (session=${sessionId}), degraded to cache-only: ${String(storeErr)}`);
    }
  }
}

/**
 * Mark a session as approved (called from prompt hook when approval detected).
 */
export function setConfirmFirstApproval(sessionId: string): void {
  evictOldestIfFull(sessionApprovalState);
  sessionApprovalState.set(sessionId, true);
  if (confirmFirstStore) {
    try {
      confirmFirstStore.upsertApproval(sessionId);
    } catch (storeErr) {
      console.warn(`[PD:ConfirmFirst] Store write failed for approval (session=${sessionId}), degraded to cache-only: ${String(storeErr)}`);
    }
  }
}

/**
 * Synchronous gate evaluation — checks cached state only.
 * Called from before_tool_call hook (must be synchronous).
 */
export function evaluateConfirmFirstGateSync(
  sessionId: string | undefined,
  toolName: string,
  params: Record<string, unknown> | undefined,
): ConfirmFirstGateResult {
  if (!sessionId) return { action: 'skip' };

  // 1. Check if session is already approved
  if (sessionApprovalState.get(sessionId)) {
    return { action: 'allow' };
  }

  // 2. Check if confirm-first directive is active for this session
  const directive = sessionDirectiveState.get(sessionId);
  if (!directive?.active) {
    return { action: 'skip' };
  }

  // 3. Check if tool is mutating
  if (!isMutatingTool(toolName, params)) {
    return { action: 'allow' };
  }

  // 4. Block: mutating tool with active confirm-first and no approval
  return {
    action: 'block',
    reason: 'confirm_first_required',
    nextAction:
      'Summarize requirements, list ambiguities, propose a plan, and wait for explicit owner approval before mutating files.',
    principleId: directive.principleId,
  };
}

/**
 * Reset state for a session (e.g., on /reset).
 */
export function resetConfirmFirst(sessionId: string): void {
  sessionDirectiveState.delete(sessionId);
  sessionApprovalState.delete(sessionId);
  if (confirmFirstStore) {
    try {
      confirmFirstStore.deleteState(sessionId);
    } catch (storeErr) {
      console.warn(`[PD:ConfirmFirst] Store delete failed for session=${sessionId}: ${String(storeErr)}`);
    }
  }
}

/**
 * Check if a session has been approved (for testing).
 */
export function isSessionApproved(sessionId: string): boolean {
  return sessionApprovalState.get(sessionId) === true;
}

/**
 * Check if a session has an active directive (for testing).
 */
export function hasActiveDirective(sessionId: string): boolean {
  return sessionDirectiveState.get(sessionId)?.active === true;
}

/**
 * Clear all state (for testing).
 */
export function clearAllConfirmFirstState(): void {
  sessionDirectiveState.clear();
  sessionApprovalState.clear();
  if (confirmFirstStore) {
    try {
      confirmFirstStore.deleteAllState();
    } catch (storeErr) {
      console.warn(`[PD:ConfirmFirst] Store clearAll failed: ${String(storeErr)}`);
    }
  }
}

export function hydrateFromStore(sessionId: string): void {
  if (!confirmFirstStore) return;
  if (sessionDirectiveState.has(sessionId)) return;

  try {
    const record = confirmFirstStore.getState(sessionId);
    if (!record) return;

    evictOldestIfFull(sessionDirectiveState);
    sessionDirectiveState.set(sessionId, {
      active: record.directiveActive,
      principleId: record.directivePrincipleId ?? undefined,
    });

    if (record.approvalActive) {
      evictOldestIfFull(sessionApprovalState);
      sessionApprovalState.set(sessionId, true);
    }
  } catch (storeErr) {
    console.warn(`[PD:ConfirmFirst] Store hydration failed for session=${sessionId}: ${String(storeErr)}`);
  }
}

export function pruneStoreStaleRows(): number {
  if (!confirmFirstStore) return 0;
  try {
    return confirmFirstStore.pruneStaleRows();
  } catch (storeErr) {
    console.warn(`[PD:ConfirmFirst] Store pruning failed: ${String(storeErr)}`);
    return 0;
  }
}

