/**
 * Routing Guidance — Task Classification Pure Logic
 *
 * Phase: PRI-74 Routing Guidance Migration (follow-up to PRI-75 Prompt Injection SDK Migration)
 *
 * Pure functions for classifying task intent and building routing guidance.
 * No I/O dependencies — suitable for any host.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The input contract for a routing decision.
 * All fields are optional — the classifier handles missing data gracefully.
 */
export interface RoutingInput {
  taskIntent?: string;
  taskDescription?: string;
  /** @deprecated Not used by classifyTaskKind; reserved for future extensions. */
  requestedTools?: string[];
  requestedFiles?: string[];
  expectedOutputShape?: string;
  complexityHints?: string[];
  targetProfile?: 'local-reader' | 'local-editor';
}

/**
 * Classification categories from classifyTaskKind.
 * The full RoutingDecision includes I/O fields (deploymentCheck, etc.)
 * that belong to the plugin layer.
 */
export type RoutingClassification =
  | 'reader_eligible'
  | 'editor_eligible'
  | 'high_entropy_disallowed'
  | 'ambiguous_scope'
  | 'profile_mismatch'
  | 'deployment_unavailable';

// ---------------------------------------------------------------------------
// Keyword Sets
// ---------------------------------------------------------------------------

/**
 * Keywords that indicate a task is suitable for `local-reader`.
 */
export const READER_KEYWORDS = [
  'read', 'view', 'show', 'get', 'find', 'search', 'grep', 'look',
  'inspect', 'examine', 'list', 'cat', 'head', 'tail', 'diff',
  'summary', 'summarize', 'extract', 'parse', 'review',
  'check', 'verify', 'status', 'describe', 'explain_what',
  'browse', 'fetch', 'show_content', 'file_content', 'code_read',
] as const;

/**
 * Keywords that indicate a task is suitable for `local-editor`.
 */
export const EDITOR_KEYWORDS = [
  'edit', 'update', 'modify', 'change', 'fix', 'patch', 'replace',
  'add', 'remove', 'delete', 'insert', 'rewrite', 'refactor',
  'apply', 'execute', 'run', 'transform', 'convert', 'migrate',
  'write', 'create_file', 'append', 'touch', 'rename',
] as const;

/**
 * Keywords that indicate HIGH ENTROPY — tasks that must stay on main agent.
 */
export const HIGH_ENTROPY_KEYWORDS = [
  'design', 'architect', 'plan', 'strategy', 'roadmap', 'propose',
  'research', 'investigate', 'explore', 'evaluate', 'compare',
  'decide', 'choose', 'recommend', 'suggest', 'analyze_tradeoffs',
  'unclear', 'vague', 'ambiguous', 'open_ended', 'multiple_options',
  'architecture', 'system_design', 'high_level', 'blueprint',
  'thinking', 'reasoning', '思考', '分析', '设计',
] as const;

/**
 * Complexity hint values that trigger high_entropy_disallowed.
 * Extracted to a constant to keep classifyTaskKind readable.
 */
const COMPLEXITY_HINTS = ['multi_step', 'cross_file', 'ambiguous', 'requires_planning', 'open_ended', 'unclear'] as const;

/**
 * Maximum number of files for a bounded edit before it becomes high-entropy.
 */
const MAX_BOUNDED_EDIT_FILES = 4;

// ---------------------------------------------------------------------------
// Keyword Matching Helpers
// ---------------------------------------------------------------------------

/**
 * Simple case-insensitive keyword match.
 */
export function containsKeyword(text: string | undefined, keywords: readonly string[]): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

/**
 * Compute a combined text from all input fields for keyword scanning.
 */
export function computeCombinedText(input: RoutingInput): string {
  const parts: string[] = [];
  if (input.taskIntent) parts.push(input.taskIntent);
  if (input.taskDescription) parts.push(input.taskDescription);
  if (input.expectedOutputShape) parts.push(input.expectedOutputShape);
  if (input.complexityHints) parts.push(input.complexityHints.join(' '));
  return parts.join(' ').toLowerCase();
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify the task based on its input fields.
 * Returns a raw classification category (before deployment check).
 * This is a pure function — no I/O, no stateDir.
 */
export function classifyTaskKind(input: RoutingInput): RoutingClassification {
  const text = computeCombinedText(input);
  const { taskIntent, taskDescription, requestedFiles, complexityHints } = input;

  // --- Step 1: High-entropy keyword detection ---
  if (complexityHints?.some((h) =>
    ['multi_step', 'cross_file', 'ambiguous', 'requires_planning', 'open_ended', 'unclear'].includes(h)
  )) {
    return 'high_entropy_disallowed';
  }

  if (containsKeyword(text, HIGH_ENTROPY_KEYWORDS)) {
    return 'high_entropy_disallowed';
  }

  if (containsKeyword(taskIntent, HIGH_ENTROPY_KEYWORDS) ||
      containsKeyword(taskDescription, HIGH_ENTROPY_KEYWORDS)) {
    return 'high_entropy_disallowed';
  }

  // --- Step 2: Reader eligibility ---
  const intentIsReader = containsKeyword(taskIntent, READER_KEYWORDS);
  const descIsReader = containsKeyword(taskDescription, READER_KEYWORDS);

  if (intentIsReader && (descIsReader || !taskDescription)) {
    return 'reader_eligible';
  }

  // --- Step 3: Editor eligibility ---
  const uniqueFiles = requestedFiles
    ? [...new Set(requestedFiles.filter((f) => f.trim().length > 0))]
    : [];
  const intentIsEditor = containsKeyword(taskIntent, EDITOR_KEYWORDS);
  const descIsEditor = containsKeyword(taskDescription, EDITOR_KEYWORDS);

  if (intentIsEditor && (descIsEditor || !taskDescription)) {
    if (uniqueFiles.length >= MAX_BOUNDED_EDIT_FILES) {
      return 'high_entropy_disallowed';
    }
    return 'editor_eligible';
  }

  // --- Step 4: Ambiguous scope ---
  if (taskDescription && taskDescription.trim().length > 0) {
    const trimmed = taskDescription.trim();
    if (trimmed.length < 20 || ['todo', 'fix', 'improve', 'change', 'update', 'something'].includes(trimmed.toLowerCase())) {
      return 'ambiguous_scope';
    }
    if (/\b(why|how|should|could|would|what if|should we|whether to)\b/i.test(trimmed)) {
      return 'ambiguous_scope';
    }
  }

  if (!taskIntent && !taskDescription) {
    return 'ambiguous_scope';
  }

  return 'ambiguous_scope';
}

// ---------------------------------------------------------------------------
// Reason / Blockers Building
// ---------------------------------------------------------------------------

/**
 * Build the reason string for a given classification.
 */
export function buildReason(
  classification: RoutingClassification,
  input: RoutingInput
): string {
  const { taskIntent, taskDescription } = input;

  switch (classification) {
    case 'reader_eligible':
      return `Task "${taskIntent || taskDescription || '(unnamed)'}" is classified as reader_eligible. ` +
        `Keywords indicate focused reading, inspection, or information retrieval. ` +
        `No high-entropy or risk signals detected.`;

    case 'editor_eligible':
      return `Task "${taskIntent || taskDescription || '(unnamed)'}" is classified as editor_eligible. ` +
        `Keywords indicate bounded editing, modification, or repair. ` +
        `No high-entropy or risk signals detected.`;

    case 'high_entropy_disallowed': {
      const uniqueFiles = input.requestedFiles
        ? [...new Set(input.requestedFiles.filter((f) => f.trim().length > 0))]
        : [];
      const isLargeScaleEdit = uniqueFiles.length >= MAX_BOUNDED_EDIT_FILES;
      if (isLargeScaleEdit) {
        return `Task "${taskIntent || taskDescription || '(unnamed)'}" is blocked as high_entropy_disallowed. ` +
          `Editing ${uniqueFiles.length} files simultaneously exceeds the bounded-scope limit for local-editor. ` +
          `Large-scale multi-file edits require the main agent's coordination and risk judgment.`;
      }
      return `Task "${taskIntent || taskDescription || '(unnamed)'}" is blocked as high_entropy_disallowed. ` +
        `Keywords indicate open-ended planning, architecture design, or ambiguous multi-step work. ` +
        `These tasks require the main agent's full reasoning capability.`;
    }

    case 'ambiguous_scope':
      return `Task "${taskIntent || taskDescription || '(unnamed)'}" is blocked as ambiguous_scope. ` +
        `The task description is too vague, too short, or contains open-ended question words. ` +
        `Main agent must clarify scope before delegation.`;

    case 'profile_mismatch':
      return `Task profile does not match the requested target profile. ` +
        `The task's natural classification is incompatible with the specified worker profile. ` +
        `Main agent must re-route or choose a compatible profile.`;

    case 'deployment_unavailable':
      return `No enabled deployment available for routing. ` +
        `Either no checkpoint is bound to the profile, or routing has been disabled. ` +
        `Main agent must handle this task.`;
  }
}

/**
 * Build the blockers list for a given classification.
 */
export function buildBlockers(
  classification: RoutingClassification,
  input: RoutingInput
): string[] {
  switch (classification) {
    case 'reader_eligible':
      return [];
    case 'editor_eligible':
      return [];
    case 'high_entropy_disallowed': {
      const uniqueFiles = input.requestedFiles
        ? [...new Set(input.requestedFiles.filter((f) => f.trim().length > 0))]
        : [];
      const isLargeScaleEdit = uniqueFiles.length >= MAX_BOUNDED_EDIT_FILES;
      const triggeredByComplexityHint =
        input.complexityHints?.some((h) => (COMPLEXITY_HINTS as readonly string[]).includes(h)) ?? false;
      const blockers: string[] = [];
      if (isLargeScaleEdit) {
        blockers.push(`large-scale multi-file edit detected (${uniqueFiles.length} files): scope too broad for local-editor`);
      } else {
        blockers.push('task contains high-entropy keywords (design/plan/architect/investigate)');
      }
      if (triggeredByComplexityHint) {
        blockers.push('complexity hint indicates multi-step or open-ended work');
      }
      blockers.push('main agent required for full reasoning and judgment');
      return blockers;
    }
    case 'ambiguous_scope':
      return [
        'task description too vague or generic',
        'task intent not provided or unclear',
        'open-ended question words detected',
        'main agent must clarify scope before delegation',
      ];
    case 'profile_mismatch':
      return [
        'task natural profile incompatible with requested target profile',
        'main agent must re-route or select a compatible profile',
      ];

    case 'deployment_unavailable':
      return [
        'no enabled deployment found for target profile',
        'routing may be disabled in deployment registry',
        'main agent must handle task directly',
      ];
  }
}
