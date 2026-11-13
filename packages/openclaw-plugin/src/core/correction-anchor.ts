/**
 * Correction → assistant-turn anchoring.
 *
 * A user correction must point at the turn the user is actually objecting to.
 * "The most recent assistant turn" is only correct when the correction lands
 * directly on the offending answer. The failure this module exists for is the
 * cross-turn case:
 *
 *   T1  assistant edits a config without evidence      ← the real error
 *   T2  user asks "why did you touch it?"
 *   T3  assistant explains / apologises               ← most recent turn
 *   T4  user: "不对，你刚才没有任何实测依据就修改了参数。"
 *
 * Anchoring T4 to the T3 explanation attaches the Pain to words the Owner was
 * not objecting to, and the Diagnostician reasons about the wrong turn. Round 3
 * observed exactly this: the correction referenced the explanation turn.
 *
 * Policy (round-3 brief: prefer an exact reference, never pretend the most
 * recent turn is the target, allow a structured `unresolved`):
 *  1. no back-reference → the latest assistant turn IS the target;
 *  2. back-reference → anchor to the most recent assistant turn that actually
 *     EXECUTED something (write-type tool call, from runtime evidence);
 *  3. back-reference with no such turn → unresolved (null), never fabricated.
 */

export interface AnchoredAssistantTurn {
  readonly id: number;
  readonly text?: string;
  readonly createdAt?: string;
}

export interface AnchoredToolCall {
  readonly toolName: string;
  readonly createdAt: string;
}

export type CorrectionAnchorReason =
  | 'latest_turn'
  | 'back_reference_tool_evidence'
  | 'unresolved_back_reference'
  | 'no_assistant_turn';

export interface CorrectionAnchorResult {
  readonly turnId: number | null;
  readonly reason: CorrectionAnchorReason;
}

/** The user is explicitly pointing at something that happened earlier. */
const BACK_REFERENCE = /(刚才|刚刚|上次|之前你|你上一条|上一条|前一轮|之前那次)/;

/**
 * Tools that change state. A correction that says "你刚才…" and follows an
 * explanation is almost always objecting to one of these executions.
 */
const WRITE_TOOL = /^(edit|write|apply_patch|patch|multi_edit|create|exec|shell|bash|terminal)$/i;

export function hasBackReference(userMessage: string): boolean {
  return BACK_REFERENCE.test(userMessage);
}

function isWriteTool(toolName: string): boolean {
  return WRITE_TOOL.test(toolName);
}

/**
 * Assign each tool call to the first assistant turn created at/after it. The
 * trajectory records tool calls during a turn and the assistant turn when the
 * turn's output is written, so this window is the turn that executed them.
 */
function turnsWithExecution(
  turns: readonly AnchoredAssistantTurn[],
  toolCalls: readonly AnchoredToolCall[],
): Set<number> {
  const executed = new Set<number>();
  for (const call of toolCalls) {
    if (!isWriteTool(call.toolName)) continue;
    const owner = turns.find((turn) => !turn.createdAt || turn.createdAt >= call.createdAt);
    if (owner) executed.add(owner.id);
  }
  return executed;
}

export function resolveCorrectionAnchor(
  userMessage: string,
  turns: readonly AnchoredAssistantTurn[],
  toolCalls: readonly AnchoredToolCall[] = [],
): CorrectionAnchorResult {
  const latest = turns[turns.length - 1];
  if (!latest) return { turnId: null, reason: 'no_assistant_turn' };
  if (!hasBackReference(userMessage)) return { turnId: latest.id, reason: 'latest_turn' };

  const executed = turnsWithExecution(turns, toolCalls);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const candidate = turns[index];
    if (candidate && executed.has(candidate.id)) {
      return { turnId: candidate.id, reason: 'back_reference_tool_evidence' };
    }
  }
  return { turnId: null, reason: 'unresolved_back_reference' };
}
