/**
 * Nocturnal Executability Checker — Bounded Action Validation
 * =========================================================
 *
 * PURPOSE: Validate that a reflection artifact's suggestions are actually
 * executable — i.e., they describe bounded, concrete actions rather than
 * vague platitudes or impossible feats.
 *
 * EXECUTABILITY CRITERIA:
 * 1. next-step is a bounded action (not a vague improvement)
 * 2. No references to non-existent tools
 * 3. No references to impossible/implied actions
 * 4. The suggestion can be translated into a tool call
 *
 * DESIGN CONSTRAINTS:
 * - Pure functions only — no I/O, no side effects
 * - Deterministic — same input always produces same output
 * - Fail closed — non-executable suggestions are rejected
 * - No LLM involvement — all checks are algorithmic
 */

import { parseAndValidateArtifact } from './nocturnal-arbiter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A bounded action that could be translated to a tool call.
 */
export interface BoundedAction {
  /** The action verb (e.g., 'read', 'edit', 'check') */
  verb: string;
  /** The target of the action (e.g., 'src/main.ts', 'documentation') */
  target: string;
  /** The full suggestion text */
  fullText: string;
}

/**
 * Executability validation failure.
 */
export interface ExecutabilityFailure {
  reason: string;
  field: 'badDecision' | 'betterDecision';
}

/**
 * Result of executability validation.
 */
export interface ExecutabilityResult {
  /** Whether the suggestion passed executability checks */
  executable: boolean;
  /** Parsed bounded action from betterDecision (if executable) */
  boundedAction?: BoundedAction;
  /** Failure reasons (if not executable) */
  failures: ExecutabilityFailure[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Known tool verbs that map to bounded actions.
 * These are the only verbs that can be translated to tool calls.
 */
const BOUNDED_TOOL_VERBS = new Set([
  'read',
  'edit',
  'write',
  'create',
  'delete',
  'check',
  'verify',
  'test',
  'run',
  'execute',
  'install',
  'search',
  'grep',
  'find',
  'list',
  'review',
  'examine',
  'inspect',
  'look',
  'view',
  'open',
  'close',
  'save',
  'commit',
  'push',
  'pull',
  'fetch',
  'merge',
  'diff',
  'analyze',
  'diagnose',
  'debug',
  'trace',
]);

/**
 * Vague verbs that cannot be translated to bounded tool calls.
 */
const VAGUE_VERBS = new Set([
  'understand',
  'learn',
  'improve',
  'better',
  'fix',
  'handle',
  'manage',
  'work',
  'do',
  'make',
  'get',
  'got',
  'ensure',
  'ensure that',
  'be',
  'consider',
  'think',
  'reflect',
  'analyze',
  'evaluate',
  'review', // borderline - sometimes acceptable
  'help',
  'support',
  'provide',
  'offer',
  'give',
  'take',
  'use',
  'try',
  'attempt',
  'start',
  'begin',
  'continue',
  'proceed',
  'finish',
  'complete',
  'end',
  'stop',
  'avoid',
  'prevent',
  'reduce',
  'minimize',
  'maximize',
  'optimize',
  'enhance',
  'strengthen',
  'develop',
  'grow',
  'build',
  'establish',
  'create', // borderline - sometimes acceptable
  'implement',
  'deploy',
  'launch',
]);

/**
 * Patterns that indicate vague/hollow格言 (not a decision-point).
 */
const HOLLOW_PATTERNS = [
  /always be careful/i,
  /always be mindful/i,
  /always think before acting/i,
  /don't rush/i,
  /take your time/i,
  /be patient/i,
  /be careful/i,
  /be more careful/i,
  /be mindful/i,
  /work smarter/i,
  /be more effective/i,
  /be better/i,
  /good practice/i,
  /best practice/i,
  /should be careful/i,
  /need to be more/i,
  /should have been more/i,
];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Attempt to parse a suggestion into a bounded action.
 *
 * Looks for patterns like:
 * - "Read X before doing Y"
 * - "Check X first"
 * - "Verify Y"
 * - "Edit X to do Z"
 */
function parseBoundedAction(text: string): BoundedAction | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Pattern: "Read/Check/Verify X" or "X. Read/Check/Verify Y"
  const boundedPattern = /^([A-Za-z]+)\s+(?:the\s+)?([^\s.,]+(?:\s+[^\s.,]+){0,5})/i;
  const match = boundedPattern.exec(trimmed);

  if (match) {
    const verb = match[1].toLowerCase();
    const target = match[2].trim();

    if (BOUNDED_TOOL_VERBS.has(verb) && target.length > 0) {
      return { verb, target, fullText: trimmed };
    }
  }

  // Pattern: "[Verb] the [target]" — e.g., "read the file"
  const thePattern = /^(read|check|verify|edit|write|delete|search|grep|look|examine|inspect|review)\s+(?:the\s+)?(.+)/i;
  const theMatch = thePattern.exec(lower);
  if (theMatch) {
    return { verb: theMatch[1], target: theMatch[2].trim(), fullText: trimmed };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Core Validation
// ---------------------------------------------------------------------------

/**
 * Check if a text contains a hollow格言 pattern.
 */
function containsHollowPattern(text: string): boolean {
  return HOLLOW_PATTERNS.some((p) => p.test(text));
}

/**
 * Check if a text contains vague verbs that cannot be executed.
 */
function containsVagueVerb(text: string): boolean {
  const lower = text.toLowerCase();
  // Check if the text STARTS with a vague verb (most indicative of non-executable)
  for (const vagueVerb of VAGUE_VERBS) {
    if (lower.startsWith(vagueVerb + ' ') || lower.startsWith(vagueVerb + 's ')) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a text is too generic to be actionable.
 */
function isTooGeneric(text: string): boolean {
  const lower = text.toLowerCase();
  // Very short suggestions are often too generic
  if (text.trim().length < 15) return true;
  // Check for generic patterns
  if (/^[^,]*,?\s*(not|never|no\b|don't|don't|shouldn't|cannot|can't)/i.test(lower)) {
    // This is actually a negative constraint, not an action
    return true;
  }
  if (/\bthen\b/i.test(lower) && lower.split(/\bthen\b/i).length > 4) {
    // Multi-step vague instruction (5 or more "then" words)
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main Validator
// ---------------------------------------------------------------------------

/**
 * Validate that a reflection artifact's suggestions are executable.
 *
 * @param artifact - The validated artifact from arbiter (passed = true)
 * @returns ExecutabilityResult
 */
     
export function validateExecutability(artifact: {
  badDecision: string;
  betterDecision: string;
}): ExecutabilityResult {
  const failures: ExecutabilityFailure[] = [];

  // Check badDecision is not hollow
  if (containsHollowPattern(artifact.badDecision)) {
    failures.push({
      reason: 'badDecision contains a hollow principle statement, not a decision-point',
      field: 'badDecision',
    });
  }

  // Check betterDecision is executable
  const boundedAction = parseBoundedAction(artifact.betterDecision);

  // Check 1: Not a hollow pattern
  if (containsHollowPattern(artifact.betterDecision)) {
    failures.push({
      reason: 'betterDecision contains a hollow principle statement, not an actionable decision',
      field: 'betterDecision',
    });
  }

  // Check 2: Does not start with vague verb
  if (containsVagueVerb(artifact.betterDecision)) {
    failures.push({
      reason: 'betterDecision starts with a vague verb that cannot be translated to a tool call',
      field: 'betterDecision',
    });
  }

  // Check 3: Not too generic
  if (isTooGeneric(artifact.betterDecision)) {
    failures.push({
      reason: 'betterDecision is too generic to be an actionable decision-point',
      field: 'betterDecision',
    });
  }

  // Check 4: Contains a parseable bounded action
  if (boundedAction === null && failures.length === 0) {
    failures.push({
      reason: 'betterDecision does not describe a bounded action that can be translated to a tool call',
      field: 'betterDecision',
    });
  }

  // Check 5: Does not reference non-existent operations
  // (This is a heuristic — we can't know all tool names, but we can flag obvious non-tools)
  const nonToolReferences = [
    /rewrite the entire/i,
    /redesign the whole/i,
    /restart from scratch/i,
    /rebuild from zero/i,
    /change the fundamental/i,
  ];
  for (const pattern of nonToolReferences) {
    if (pattern.test(artifact.betterDecision)) {
      failures.push({
        reason: 'betterDecision references an operation that is too broad to be a bounded action',
        field: 'betterDecision',
      });
      break;
    }
  }

  // Check 6: badDecision should describe a specific failure, not a generic anti-pattern
  const genericBadPatterns = [
    /did not \w+ properly/i,
    /failed to \w+ correctly/i,
    /made a mistake/i,
    /was wrong/i,
    /was incorrect/i,
  ];
  for (const pattern of genericBadPatterns) {
    if (pattern.test(artifact.badDecision) && !pattern.test(artifact.betterDecision)) {
      // This is OK — badDecision can be generic, it's the betterDecision that must be specific
    }
  }

  if (failures.length > 0) {
    return { executable: false, failures };
  }

  return {
    executable: true,
    boundedAction: boundedAction ?? undefined,
    failures: [],
  };
}

/**
 * Combined arbiter + executability check.
 *
 * @param rawJson - Raw JSON string from reflector
 * @param options - Expected values for cross-validation
 * @returns Combined result with all failure reasons
 */
export interface CombinedValidationResult {
  approved: boolean;
  artifact?: {
    artifactId: string;
    sessionId: string;
    principleId: string;
    sourceSnapshotRef: string;
    badDecision: string;
    betterDecision: string;
    rationale: string;
    createdAt: string;
    boundedAction?: BoundedAction;
  };
  failures: string[];
}

export function validateForApproval(
  rawJson: string,
  options: { expectedPrincipleId?: string; expectedSessionId?: string } = {}
): CombinedValidationResult {
  const arbiterResult = parseAndValidateArtifact(rawJson, options);

  if (!arbiterResult.passed || !arbiterResult.artifact) {
    return {
      approved: false,
      failures: arbiterResult.failures.map((f) => f.reason),
    };
  }

  const execResult = validateExecutability(arbiterResult.artifact);

  if (!execResult.executable) {
    return {
      approved: false,
      failures: execResult.failures.map((f) => f.reason),
    };
  }

  return {
    approved: true,
    artifact: {
      ...arbiterResult.artifact,
      boundedAction: execResult.boundedAction,
    },
    failures: [],
  };
}
