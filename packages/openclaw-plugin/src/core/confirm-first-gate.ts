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


/** Per-session confirm-first state */
interface ConfirmFirstSessionState {
  active: boolean;
  principleId?: string;
}

const sessionDirectiveState = new Map<string, ConfirmFirstSessionState>();
const sessionApprovalState = new Map<string, boolean>();

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
  if (WRITE_EDIT_DELETE_TOOLS.has(toolName)) return true;

  // For exec/bash, only mutating if the command content is mutating
  if (EXEC_TOOLS.has(toolName)) {
    const command = String(params?.command || params?.args || '');
    return />\s*|>>\s*|\brm\b|\bmv\b|\bmkdir\b|\btouch\b|\bcp\b|\bsed\s+-i|\bchmod\b|\bchown\b|\bdel\b|\bRemove-Item\b|\bSet-Content\b|\bOut-File\b|\bNew-Item\b/.test(command);
  }

  return false;
}

const WRITE_EDIT_DELETE_TOOLS = new Set(['write', 'write_file', 'edit', 'edit_file', 'replace', 'apply_patch', 'insert', 'patch', 'delete_file', 'move_file']);
const EXEC_TOOLS = new Set(['bash', 'exec', 'execute', 'shell', 'cmd']);

/**
 * Detect if user message contains clear approval language.
 */
export function detectApprovalMarker(message: string): boolean {
  const zhMarkers = /确认|批准|按计划执行|可以执行|就这么做|去执行|开始执行|执行吧|同意|没问题.*执行|照.*做/;
  const enMarkers = /\bapproved\b|\bgo\s*ahead\b|\bproceed\b|\bconfirm\b|\byes\b.*\b(do|execute|proceed)\b|\bdo\s*it\b|\blgtm\b/i;
  return zhMarkers.test(message) || enMarkers.test(message);
}

/**
 * Set confirm-first directive state for a session (called from prompt hook).
 */
export function setConfirmFirstDirective(
  sessionId: string,
  active: boolean,
  principleId?: string,
): void {
  sessionDirectiveState.set(sessionId, { active, principleId });
}

/**
 * Mark a session as approved (called from prompt hook when approval detected).
 */
export function setConfirmFirstApproval(sessionId: string): void {
  sessionApprovalState.set(sessionId, true);
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
}
