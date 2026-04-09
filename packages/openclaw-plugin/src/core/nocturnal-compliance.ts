/**
 * Nocturnal Compliance Engine — Opportunity-Based Principle Evaluation
 * =====================================================================
 *
 * Replaces session-average compliance with opportunity-based compliance.
 *
 * CORE CONCEPTS:
 *
 * Opportunity — a session context where a principle COULD have been applied.
 *                An opportunity exists when the agent's action (or planned action)
 *                falls within the principle's applicability scope.
 *
 * Compliance   — the principle was followed in an opportunity.
 *                Determined by absence of violation signals, not presence of
 *                positive confirmation (avoids LLM scoring).
 *
 * Violation   — strong evidence the principle was NOT followed.
 *                Detected through deterministic event signals (pain, tool failures,
 *                gate blocks) — no LLM involved.
 *
 * Dilution prevention — compliance is computed ONLY over sessions where the
 *                         principle had an opportunity. Unrelated sessions
 *                         (where T-05's risky operations never occurred) do NOT
 *                         dilute the compliance rate.
 *
 * DESIGN CONSTRAINTS (Phase 1):
 * - T-xx principles only (deterministic / weak-heuristic evaluability)
 * - No P_xxx automation (requires detector metadata — Task 1.3 scope)
 * - No LLM-based scoring
 * - No training logic
 *
 * FILE: No file persistence — stateless computation over event stream.
 *       Caller is responsible for writing results to principle-training-state.ts.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Session events extracted from the event log.
 * Compatible with EventLogEntry from event-types.ts.
 */
export interface SessionEvents {
  sessionId: string;
  toolCalls: ToolCallRecord[];
  painSignals: PainSignalRecord[];
  gateBlocks: GateBlockRecord[];
  userCorrections: UserCorrectionRecord[];
  planApprovals: PlanApprovalRecord[];
}

export interface ToolCallRecord {
  toolName: string;
  filePath?: string;
  outcome: 'success' | 'failure' | 'blocked';
  errorType?: string;
  errorMessage?: string;
}

export interface PainSignalRecord {
  source: string;
  score: number;
  severity?: 'mild' | 'moderate' | 'severe';
  reason?: string;
}

export interface GateBlockRecord {
  toolName: string;
  filePath?: string;
  reason: string;
}

export interface UserCorrectionRecord {
  correctionCue?: string;
}

export interface PlanApprovalRecord {
  toolName: string;
  filePath?: string;
}

/**
 * The result of compliance computation for one principle.
 */
export interface ComplianceResult {
  principleId: string;
  /** Number of sessions/events where this principle had an applicable opportunity */
  applicableOpportunityCount: number;
  /** Number of opportunities where violation signals were detected */
  observedViolationCount: number;
  /** complianceRate = (opportunities - violations) / opportunities; 0 if none */
  complianceRate: number;
  /**
   * Violation trend:
   *   +1 = violations increasing (worsening)
   *    0 = stable
   *   -1 = violations decreasing (improving)
   */
  violationTrend: number;
  /**
   * Explanation of why the result is what it is.
   * For debugging, observability, and reviewer verification.
   */
  explanation: string;
}

/**
 * Opportunity detection result for a single session.
 */
interface OpportunityMatch {
  applicable: boolean;
  reason: string;
}

/**
 * Violation detection result for a session with applicable opportunity.
 */
interface ViolationMatch {
  violated: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// Risky Operation Registry
// ---------------------------------------------------------------------------

/**
 * Tools and operations that constitute risky actions.
 * Gate blocks on these map to T-05 (Safety Rails) violations.
 */
const RISKY_TOOLS: Set<string> = new Set([
  'delete_file',
  'move_file',
  'rename_file',
  'delete_directory',
  'bash',
  'MultiExec',
]);

/**
 * Bash command patterns that constitute dangerous operations.
 * Matched against bash command text in tool_call events.
 */
const DANGEROUS_BASH_PATTERNS: RegExp[] = [
  /rm\s+(-[a-z]*r[a-z]*f?|-rf)/i,              // rm -rf / rm -r
  /del\s+\/[s/q]/i,                              // Windows del /s
  /rmdir\s+\/s/i,                                // rmdir /s
  /git\s+push\s+.*--force/i,                      // git push --force
  /git\s+reset\s+--hard/i,                       // git reset --hard
  /git\s+clean\s+-f[dx]/i,                       // git clean -fd
  /npm\s+publish/i,                               // npm publish
  /pip\s+upload/i,                                // pip upload
  /docker\s+push/i,                               // docker push
  /curl.+\|\s*(ba)?sh/i,                         // curl | bash
  /wget.+\|\s*(ba)?sh/i,                          // wget | bash
  /^make\s+[^-|]+$/i,                             // bare make (destructive)
];

/**
 * Keywords in gate block reason that indicate a dangerous/risky operation.
 * Used as a fallback when the tool itself is risky but the reason is free text.
 */
const RISKY_KEYWORDS_IN_REASON: RegExp[] = [
  /delete|remove|destroy|drop/i,
  /force|unsafe|dangerous/i,
  /format|truncate|overwrite/i,
  /exec|eval|shell|command/i,
  /credential|secret|password|token/i,
];

/**
 * Edit/write tool names.
 */
const EDIT_TOOLS: Set<string> = new Set([
  'edit_file',
  'edit_file_batch',
  'write_to_file',
  'create_file',
  'apply_patch',
]);

/**
 * Read tool names.
 */
const READ_TOOLS: Set<string> = new Set([
  'read_file',
  'read_multiple_files',
  'grep',
  'search_files',
  'list_directory',
  'glob',
]);

// ---------------------------------------------------------------------------
// Path Normalization (cross-platform)
// ---------------------------------------------------------------------------

/**
 * Normalizes a file path to POSIX forward-slash format for consistent matching.
 * Handles Windows backslash paths on any platform.
 */
function normalizePathPosix(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// Opportunity Detection
// ---------------------------------------------------------------------------

/**
 * Detects whether a given session presents an APPLICABLE OPPORTUNITY
 * for a specific principle.
 *
 * An opportunity exists when the session context falls within the
 * principle's applicability scope — regardless of whether the agent
 * followed the principle.
 *
 * IMPORTANT: This does NOT assess compliance. It only answers:
 *   "Could the principle have applied here?"
 *
 * #216: For P_* principles (not T-xx), uses generic detection based on
 * pain events and tool calls — any session with a pain signal is considered
 * an opportunity for a pain-derived principle.
 */
export function detectOpportunity(principleId: string, session: SessionEvents): OpportunityMatch {
  // #216: P_* principles (pain-derived) — generic opportunity detection
  if (principleId.startsWith('P_')) {
    // Any session with pain signals, tool failures, or gate blocks is an opportunity
    // for a pain-derived principle. This is conservative: better to over-count
    // opportunities than to miss real violations.
    const hasPainSignal = session.painSignals.length > 0;
    const hasToolFailure = session.toolCalls.some((tc) => tc.outcome === 'failure');
    const hasGateBlock = session.gateBlocks.length > 0;
    if (hasPainSignal || hasToolFailure || hasGateBlock) {
      return { applicable: true, reason: `P_* principle — session has ${hasPainSignal ? 'pain signal' : hasToolFailure ? 'tool failure' : 'gate block'}` };
    }
    return { applicable: false, reason: `P_* principle — no pain/tool-failure/gate-block in session` };
  }

  // T-xx principles — specific deterministic detection
  // eslint-disable-next-line @typescript-eslint/no-use-before-define -- Reason: mutual recursion between detection helpers - reordering would break logical grouping
  switch (principleId) {
    case 'T-01':
      return detectT01Opportunity(session);
    case 'T-02':
      return detectT02Opportunity(session);
    case 'T-03':
      return detectT03Opportunity(session);
    case 'T-04':
      return detectT04Opportunity(session);
    case 'T-05':
      return detectT05Opportunity(session);
    case 'T-06':
      return detectT06Opportunity(session);
    case 'T-07':
      return detectT07Opportunity(session);
    case 'T-08':
      return detectT08Opportunity(session);
    case 'T-09':
      return detectT09Opportunity(session);
    default:
      return { applicable: false, reason: `Unknown principle: ${principleId}` };
  }
}

/**
 * T-01 "Survey Before Acting" — Understand the structure first before making changes.
 *
 * APPLICABLE when: Agent performs edit/write operations.
 * Rationale: Any edit to code is an opportunity to survey first.
 * Excluded: Read-only sessions (no applicable opportunity).
 */
function detectT01Opportunity(session: SessionEvents): OpportunityMatch {
  const hasEdit = session.toolCalls.some((call) => EDIT_TOOLS.has(call.toolName));
  if (hasEdit) {
    return { applicable: true, reason: 'Edit operations present — opportunity to survey before acting' };
  }
  return { applicable: false, reason: 'No edit operations in session — T-01 not applicable' };
}

/**
 * T-02 "Respect Constraints" — Explicitly reason about contracts, tests, schemas.
 *
 * APPLICABLE when: Agent interacts with type/test/schema/contract files.
 */
function detectT02Opportunity(session: SessionEvents): OpportunityMatch {
  const hasConstraintInteraction = session.toolCalls.some((call) => {
    if (!call.filePath) return false;
    const normalized = normalizePathPosix(call.filePath);
    return (
      /\.(ts|tsx|js|jsx)$/.test(normalized) || // type-aware files
      /\b(test|spec|contract|schema|interface|type)\b/i.test(normalized)
    );
  });
  if (hasConstraintInteraction) {
    return { applicable: true, reason: 'Type/test/contract interaction — opportunity to respect constraints' };
  }
  return { applicable: false, reason: 'No type/test/contract interaction — T-02 not applicable' };
}

/**
 * T-03 "Evidence Over Assumption" — Use logs, code, and outputs before inferring.
 *
 * APPLICABLE when: Pain signals or tool failures follow an edit/write operation.
 * Rationale: When a change causes something to go wrong, there's an opportunity
 * to gather evidence instead of assuming. Read-only failures are less relevant.
 * Narrowed: requires an edit/write in the session before the failure/pain signal.
 */
function detectT03Opportunity(session: SessionEvents): OpportunityMatch {
  const hasWriteBeforeFailure = session.toolCalls.some(
    (call, i) => {
      if (call.outcome !== 'failure') return false;
      // Check that at least one prior call was an edit/write
      const priorCalls = session.toolCalls.slice(0, i);
      return priorCalls.some((c) => EDIT_TOOLS.has(c.toolName));
    }
  );

  if (hasWriteBeforeFailure) {
    return { applicable: true, reason: 'Write operation followed by failure — opportunity to gather evidence before retry' };
  }

  // Also applicable: pain signal with severity moderate+ (indicating something went wrong after a change)
  const hasSignificantPain = session.painSignals.some(
    (p) => p.severity === 'moderate' || p.severity === 'severe'
  );
  if (hasSignificantPain) {
    return { applicable: true, reason: 'Significant pain signal — opportunity to use evidence over assumption' };
  }

  return { applicable: false, reason: 'No pain or failure on write operations — T-03 not applicable' };
}

/**
 * T-04 "Reversible First" — Prefer changes that are safe to roll back.
 *
 * APPLICABLE when: Risky or destructive operations are attempted.
 */
function detectT04Opportunity(session: SessionEvents): OpportunityMatch {
  const hasRisky = session.toolCalls.some(
    (call) => RISKY_TOOLS.has(call.toolName) || call.toolName === 'bash'
  );
  if (hasRisky) {
    return { applicable: true, reason: 'Risky/destructive operations — opportunity to prefer reversible changes' };
  }
  return { applicable: false, reason: 'No risky operations — T-04 not applicable' };
}

/**
 * T-05 "Safety Rails" — Call out guardrails, prohibitions, failure-prevention constraints.
 *
 * APPLICABLE when: A gate block fires on a risky operation.
 * Rationale: The gate block IS the safety rail being tested. An opportunity
 * exists when the system judged an operation risky enough to block.
 * This makes T-05 applicable ONLY when gate blocks fire — preventing dilution
 * by unrelated sessions.
 *
 * IMPORTANT: T-05's compliance is tied to gate blocks specifically.
 * A risky operation without a gate block may still be a T-05 opportunity
 * if the reason mentions safety-relevant terms.
 */
function detectT05Opportunity(session: SessionEvents): OpportunityMatch {
  const hasGateBlock = session.gateBlocks.length > 0;
  if (hasGateBlock) {
    return {
      applicable: true,
      reason: 'Gate block present — opportunity to call out safety rails',
    };
  }

  // Also applicable when a risky operation is attempted
  // (even if not yet blocked — the agent should self-censor)
  const hasRisky = session.toolCalls.some((call) => {
    if (RISKY_TOOLS.has(call.toolName)) return true;
    // Check bash for dangerous patterns
    if (call.toolName === 'bash' && call.errorMessage) {
      return DANGEROUS_BASH_PATTERNS.some((p) => p.test(call.errorMessage!));
    }
    return false;
  });

  if (hasRisky) {
    return {
      applicable: true,
      reason: 'Risky operation attempted — opportunity to apply safety rails',
    };
  }

  return {
    applicable: false,
    reason: 'No gate blocks or risky operations — T-05 not applicable in this session',
  };
}

/**
 * T-06 "Simplicity First" — Prefer the smallest understandable solution.
 *
 * APPLICABLE when: The task involves non-trivial code creation or refactoring.
 */
function detectT06Opportunity(session: SessionEvents): OpportunityMatch {
  const hasNonTrivialWrite = session.toolCalls.some(
    (call) =>
      call.toolName === 'create_file' ||
      call.toolName === 'write_to_file' ||
      (call.toolName === 'bash' && /\b(refactor|rewrite|overhaul)\b/i.test(call.errorMessage ?? ''))
  );
  if (hasNonTrivialWrite) {
    return {
      applicable: true,
      reason: 'Non-trivial code creation — opportunity to prefer simplicity',
    };
  }
  return { applicable: false, reason: 'No non-trivial writes — T-06 not applicable' };
}

/**
 * T-07 "Minimal Change Surface" — Limit the blast radius.
 *
 * APPLICABLE when: Multiple files are touched in a single session.
 */
function detectT07Opportunity(session: SessionEvents): OpportunityMatch {
  const filePaths = session.toolCalls
    .filter((call) => call.filePath !== undefined)
    .map((call) => normalizePathPosix(call.filePath!));
  const uniqueFiles = new Set(filePaths);
  if (uniqueFiles.size >= 3) {
    return {
      applicable: true,
      reason: `Multiple files touched (${uniqueFiles.size}) — opportunity to minimize change surface`,
    };
  }
  return { applicable: false, reason: 'Few files touched — T-07 not applicable' };
}

/**
 * T-08 "Pain As Signal" — Treat failures and friction as clues.
 *
 * APPLICABLE when: Pain signals are present after a failure.
 */
function detectT08Opportunity(session: SessionEvents): OpportunityMatch {
  const hasPain = session.painSignals.length > 0;
  const hasFailure = session.toolCalls.some((call) => call.outcome === 'failure');
  if (hasPain && hasFailure) {
    return {
      applicable: true,
      reason: 'Pain signals following failures — opportunity to treat pain as signal',
    };
  }
  return { applicable: false, reason: 'No pain-after-failure — T-08 not applicable' };
}

/**
 * T-09 "Divide And Conquer" — Split the task into smaller phases before execution.
 *
 * APPLICABLE when: Complex operations are attempted (multi-file edits, refactors,
 * architecture changes) OR when pain events occur on complex tasks.
 *
 * COMPLEXITY INDICATORS:
 * - 5+ tool calls in a session (indicates multi-step task)
 * - Multiple file paths touched
 * - Pain events on multi-step tasks
 * - Explicit "complex" or "refactor" or "architecture" in operations
 */
function detectT09Opportunity(session: SessionEvents): OpportunityMatch {
  const toolCallCount = session.toolCalls.length;
  const uniqueFiles = new Set(
    session.toolCalls
      .filter((call) => call.filePath !== undefined)
      .map((call) => normalizePathPosix(call.filePath!))
  );
  const hasComplexity = toolCallCount >= 5 || uniqueFiles.size >= 3;

  const hasPain = session.painSignals.length > 0;
  const hasFailure = session.toolCalls.some((call) => call.outcome === 'failure');

  if (hasComplexity) {
    return {
      applicable: true,
      reason: `Complex task detected (${toolCallCount} calls, ${uniqueFiles.size} files) — opportunity to decompose`,
    };
  }

  if (hasPain || hasFailure) {
    // Pain/failure may indicate the task was too complex without decomposition
    return {
      applicable: true,
      reason: 'Pain or failure present — opportunity to decompose before retry',
    };
  }

  return {
    applicable: false,
    reason: 'No complexity indicators — T-09 not applicable in this session',
  };
}

// ---------------------------------------------------------------------------
// Violation Detection
// ---------------------------------------------------------------------------

/**
 * Detects whether a principle was VIOLATED in a session where an
 * opportunity was applicable.
 *
 * Returns a ViolationMatch with violated=true if violation signals are present.
 *
 * #216: For P_* principles (pain-derived), violation is detected when the session
 * has pain signals, tool failures, or gate blocks that match the principle's
 * trigger pattern. Since P_* principles don't have T-xx specific detectors,
 * we use the presence of negative signals as violation evidence.
 */
export function detectViolation(principleId: string, session: SessionEvents): ViolationMatch {
  // #216: P_* principles (pain-derived) — generic violation detection
  if (principleId.startsWith('P_')) {
    // For pain-derived principles, a violation is indicated when the session
    // contains pain signals, tool failures, or gate blocks — these are the
    // same signals that triggered principle creation in the first place.
    // A principle was violated if the bad outcome recurred after it was created.
    const painSignals = session.painSignals.filter((p) => p.score >= 50);
    const toolFailures = session.toolCalls.filter((tc) => tc.outcome === 'failure');
    const {gateBlocks} = session;

    if (painSignals.length > 0) {
      return { violated: true, reason: `P_* principle — ${painSignals.length} pain signal(s) detected (max score: ${Math.max(...painSignals.map(p => p.score))})` };
    }
    if (toolFailures.length > 0) {
      return { violated: true, reason: `P_* principle — ${toolFailures.length} tool failure(s) detected` };
    }
    if (gateBlocks.length > 0) {
      return { violated: true, reason: `P_* principle — ${gateBlocks.length} gate block(s) detected` };
    }
    return { violated: false, reason: `P_* principle — no violation signals in session` };
  }

  // T-xx principles — specific deterministic detection
  switch (principleId) {
    case 'T-01':
      return detectT01Violation(session);
    case 'T-02':
      return detectT02Violation(session);
    case 'T-03':
      return detectT03Violation(session);
    case 'T-04':
      return detectT04Violation(session);
    case 'T-05':
      return detectT05Violation(session);
    case 'T-06':
      return detectT06Violation(session);
    case 'T-07':
      return detectT07Violation(session);
    case 'T-08':
      return detectT08Violation(session);
    case 'T-09':
      return detectT09Violation(session);
    default:
      return { violated: false, reason: `Unknown principle: ${principleId}` };
  }
}

/**
 * T-01 violation:
 * - Pain signal or tool failure on an edit where the file was NOT read first
 * - Pain signal with source indicating structural misunderstanding
 */
function detectT01Violation(session: SessionEvents): ViolationMatch {
  // Build set of files that were read (normalized for cross-platform consistency)
  const readFiles = new Set(
    session.toolCalls
      .filter((call) => READ_TOOLS.has(call.toolName) && call.filePath !== undefined)
      .map((call) => normalizePathPosix(call.filePath!))
  );

  // Find edits to files that were NOT read first
  const unreadEdits = session.toolCalls.filter(
    (call) =>
      EDIT_TOOLS.has(call.toolName) &&
      call.filePath !== undefined &&
      !readFiles.has(normalizePathPosix(call.filePath))
  );

  // If there were edits to unread files AND pain/failure followed → T-01 likely violated
  if (unreadEdits.length > 0) {
    const painOnUnreadEdit = session.painSignals.some(
      (p) =>
        unreadEdits.some((e) => e.filePath !== undefined && p.source.includes(e.filePath)) ||
        /structure|architecture|dependency|context|before.*edit|survey/i.test(p.reason ?? '')
    );

    if (painOnUnreadEdit) {
      return {
        violated: true,
        reason: `Edits to unread files (${unreadEdits.length}) followed by pain — T-01 violated: agent acted without surveying first`,
      };
    }

    // If edits to unread files AND tool failures → likely violated
    const failuresOnUnread = unreadEdits.some((e) => e.outcome === 'failure');
    if (failuresOnUnread) {
      return {
        violated: true,
        reason: `Edits to unread files (${unreadEdits.length}) followed by failures — T-01 violated: agent acted without understanding`,
      };
    }
  }

  // Also check for pain signals specifically mentioning T-01-relevant themes
  // without any prior read
  const hasPainTheme =
    /structure|architecture|context|before.*acting|didn't.*survey|didn't.*read.*first/i.test(
      session.painSignals.map((p) => p.reason ?? '').join(' ')
    );
  if (hasPainTheme && unreadEdits.length > 0) {
    return {
      violated: true,
      reason: 'Pain signals mentioning structure/context themes after edits to unread files — T-01 violated',
    };
  }

  return {
    violated: false,
    reason: 'No violation signals detected for T-01',
  };
}

/**
 * T-02 violation:
 * - Tool failures on type/test/contract interactions without prior verification
 */
function detectT02Violation(session: SessionEvents): ViolationMatch {
  const constraintFailures = session.toolCalls.filter(
    (call) =>
      call.outcome === 'failure' &&
      call.filePath !== undefined &&
      (/\b(test|spec|contract|schema|interface|type)\b/i.test(call.filePath) ||
        /\b(type|test|contract)\b/i.test(call.errorMessage ?? ''))
  );

  if (constraintFailures.length > 0) {
    return {
      violated: true,
      reason: `Tool failures on type/test/contract interactions (${constraintFailures.length}) — T-02 violated: constraints not verified`,
    };
  }

  return { violated: false, reason: 'No violation signals for T-02' };
}

/**
 * T-03 violation:
 * - Tool failures without prior evidence gathering (no read calls before failure)
 */
function detectT03Violation(session: SessionEvents): ViolationMatch {
  const failureIndices = session.toolCalls
    .map((call, i) => (call.outcome === 'failure' ? i : -1))
    .filter((i) => i >= 0);

  for (const failIdx of failureIndices) {
    const priorCalls = session.toolCalls.slice(0, failIdx);
    const hasPriorRead = priorCalls.some(
      (call) => READ_TOOLS.has(call.toolName) && call.filePath !== undefined
    );
    if (!hasPriorRead) {
      return {
        violated: true,
        reason: `Tool failure at index ${failIdx} without prior read operations — T-03 violated: assumption made without evidence`,
      };
    }
  }

  return { violated: false, reason: 'No violation signals for T-03' };
}

/**
 * T-04 violation:
 * - Pain signals following risky operations (the operation succeeded but caused issues)
 */
function detectT04Violation(session: SessionEvents): ViolationMatch {
  const riskyIndices = session.toolCalls
    .map((call, i) => (RISKY_TOOLS.has(call.toolName) || call.toolName === 'bash' ? i : -1))
    .filter((i) => i >= 0);

  if (riskyIndices.length === 0) return { violated: false, reason: 'No risky operations — T-04 not violated' };

  // If risky operations AND pain signals are present in the same session,
  // that indicates the risky operation caused negative consequences.
  const hasPain = session.painSignals.length > 0;
  if (hasPain) {
    return {
      violated: true,
      reason: 'Pain signals present alongside risky operations — T-04 violated: irreversible consequences',
    };
  }

  return { violated: false, reason: 'No violation signals for T-04' };
}

/**
 * T-05 violation:
 * - Gate block fires → the agent tried a risky operation without first applying
 *   safety reasoning. The gate block IS the violation signal.
 * - Gate block on a dangerous bash command is an explicit violation.
 */
function detectT05Violation(session: SessionEvents): ViolationMatch {
  if (session.gateBlocks.length > 0) {
    // Check if any gate block was on a dangerous operation.
    // A block is dangerous if:
    // 1. The tool is in RISKY_TOOLS (delete_file, bash, MultiExec, etc.)
    // 2. The tool is 'bash' AND the reason mentions a dangerous pattern
    // 3. The reason contains risky keywords (delete, force, credential, exec, etc.)
    const dangerousBlocks = session.gateBlocks.filter((block) => {
      if (RISKY_TOOLS.has(block.toolName)) return true;
      if (block.toolName === 'bash' && DANGEROUS_BASH_PATTERNS.some((p) => p.test(block.reason))) return true;
      // Fallback: scan reason for risky keywords
      if (RISKY_KEYWORDS_IN_REASON.some((p) => p.test(block.reason))) return true;
      return false;
    });

    if (dangerousBlocks.length > 0) {
      return {
        violated: true,
        reason: `Gate blocks on dangerous operations (${dangerousBlocks.length}) — T-05 violated: safety rail not called out`,
      };
    }

    return {
      violated: true,
      reason: `Gate blocks present (${session.gateBlocks.length}) — T-05 violated: safety rail not respected`,
    };
  }

  return { violated: false, reason: 'No gate blocks — T-05 not violated' };
}

/**
 * T-06 violation:
 * - Over-engineering signals: pain from overly complex solutions
 */
function detectT06Violation(session: SessionEvents): ViolationMatch {
  const hasOverEngineerPain = session.painSignals.some(
    (p) =>
      /over.*engineer|over.*complicat|too.*complex|unnecessarily.*complex/i.test(p.reason ?? '') &&
      p.severity === 'severe'
  );

  if (hasOverEngineerPain) {
    return {
      violated: true,
      reason: 'Severe pain from over-engineering — T-06 violated: simplicity not preferred',
    };
  }

  return { violated: false, reason: 'No over-engineering signals — T-06 not violated' };
}

/**
 * T-07 violation:
 * - Pain from wide blast radius: many files modified, cascading failures
 */
function detectT07Violation(session: SessionEvents): ViolationMatch {
  const modifiedFiles = new Set(
    session.toolCalls
      .filter((call) => EDIT_TOOLS.has(call.toolName) && call.filePath !== undefined)
      .map((call) => normalizePathPosix(call.filePath!))
  );

  const failures = session.toolCalls.filter((call) => call.outcome === 'failure');

  if (modifiedFiles.size >= 5 && failures.length >= 2) {
    return {
      violated: true,
      reason: `Wide blast radius (${modifiedFiles.size} files, ${failures.length} failures) — T-07 violated: change surface not minimized`,
    };
  }

  return { violated: false, reason: 'No blast radius violations — T-07 not violated' };
}

/**
 * T-08 violation:
 * - Pain signal present but no reflection/self-correction behavior
 * (This is harder to detect without explicit reflection events.
 *  We use pain-without-correction as a proxy.)
 */
function detectT08Violation(session: SessionEvents): ViolationMatch {
  const hasPain = session.painSignals.length > 0;
  const hasFailure = session.toolCalls.some((call) => call.outcome === 'failure');

  // If pain and failure, but the agent immediately retries without pause/reflect
  if (hasPain && hasFailure) {
    // Find the first failure index and check if the agent continued without reflecting
    const failureIdx = session.toolCalls.findIndex((c) => c.outcome === 'failure');
    if (failureIdx >= 0) {
      const postFailure = session.toolCalls.slice(failureIdx + 1, failureIdx + 4);
      // If the agent immediately continues without a read/reflect call, T-08 may be violated
      const continuesImmediately =
        postFailure.length > 0 && !postFailure.some((c) => READ_TOOLS.has(c.toolName));
      if (continuesImmediately) {
        return {
          violated: true,
          reason: 'Failure followed immediately by continued operations without pause/reflect — T-08 violated: pain not treated as signal',
        };
      }
    }
  }

  return { violated: false, reason: 'No T-08 violation signals detected' };
}

/**
 * T-09 violation:
 * - Pain or failures on complex tasks that should have been decomposed.
 * Signal: pain/failure on multi-step task without prior planning calls.
 */
function detectT09Violation(session: SessionEvents): ViolationMatch {
  const toolCallCount = session.toolCalls.length;
  const uniqueFiles = new Set(
    session.toolCalls
      .filter((call) => call.filePath !== undefined)
      .map((call) => normalizePathPosix(call.filePath!))
  );

  // Only applies if the session was complex
  if (toolCallCount < 5 && uniqueFiles.size < 3) {
    return { violated: false, reason: 'Session not complex enough for T-09 applicability' };
  }

  // Check: failures on complex task without prior planning
  const hasFailures = session.toolCalls.some((call) => call.outcome === 'failure');
  const hasPain = session.painSignals.length > 0;

  if (hasFailures || hasPain) {
    // Check if the agent showed decomposition/planning behavior
    const hasPlanApproval = session.planApprovals.length > 0;
    const hasReadFirst = session.toolCalls.some((call) => READ_TOOLS.has(call.toolName));

    if (!hasPlanApproval && !hasReadFirst) {
      return {
        violated: true,
        reason: `Complex task with failures/pain but no planning or decomposition signals — T-09 violated: task not divided`,
      };
    }
  }

  return { violated: false, reason: 'No T-09 violation signals' };
}

// ---------------------------------------------------------------------------
// Compliance Computation
// ---------------------------------------------------------------------------

/**
 * Computes compliance metrics for a single T-xx principle across a batch of sessions.
 *
 * DILUTION PREVENTION:
 * - Sessions where the principle had NO opportunity are EXCLUDED from
 *   applicableOpportunityCount and do not affect complianceRate.
 * - Example: T-05 sessions with no risky operations do not dilute
 *   the compliance rate computed from T-05 sessions with gate blocks.
 *
 * TREND COMPUTATION:
 * - Sessions are ordered chronologically (most recent first).
 * - Current window: last 3 applicable sessions.
 * - Previous window: sessions 4-6 (if available).
 * - If either window has < 1 applicable session, trend = 0 (insufficient data).
 * - Otherwise: trend = prevViolationRate - currentViolationRate
 *   (+1 = improving, 0 = stable, -1 = worsening).
 */
export function computeCompliance(
  principleId: string,
  sessions: SessionEvents[],
  options: { trendWindowSize?: number } = {}
): ComplianceResult {
  const windowSize = options.trendWindowSize ?? 3;

  let applicableOpportunityCount = 0;
  let observedViolationCount = 0;

  const applicableSessions: { session: SessionEvents; violated: boolean; reason: string }[] = [];

  for (const session of sessions) {
    const opp = detectOpportunity(principleId, session);
    if (!opp.applicable) {
      // Principle had no opportunity in this session — skip entirely.
      // This is the key dilution-prevention mechanism.
      continue;
    }

    applicableOpportunityCount++;
    const violation = detectViolation(principleId, session);
    if (violation.violated) {
      observedViolationCount++;
    }

    applicableSessions.push({
      session,
      violated: violation.violated,
      reason: violation.reason,
    });
  }

  // Compute complianceRate
  const complianceRate =
    applicableOpportunityCount > 0
      ? (applicableOpportunityCount - observedViolationCount) / applicableOpportunityCount
      : 0;

  // Compute violationTrend using windows
  const violationTrend = computeViolationTrend(applicableSessions, windowSize);

  // Build explanation
  // eslint-disable-next-line @typescript-eslint/no-use-before-define -- Reason: mutual recursion between explanation builder - reordering would break logical grouping
  const explanation = buildExplanation(
    principleId,
    applicableOpportunityCount,
    observedViolationCount,
    complianceRate,
    violationTrend,
    applicableSessions
  );

  return {
    principleId,
    applicableOpportunityCount,
    observedViolationCount,
    complianceRate,
    violationTrend,
    explanation,
  };
}

/**
 * Computes violation trend across the applicable session list.
 *
 * Trend is positive (+1) when violations are DECREASING (improving).
 * Trend is negative (-1) when violations are INCREASING (worsening).
 *
 * Sessions are ordered most-recent-first.
 *   currentWindow = first windowSize sessions (most recent)
 *   previousWindow = next windowSize sessions
 */
function computeViolationTrend(
  applicableSessions: { violated: boolean }[],
  windowSize: number
): number {
  if (applicableSessions.length < 2) {
    // Not enough data for trend
    return 0;
  }

  // Sessions are ordered most-recent-first in the input array.
  // currentWindow = most recent N sessions
  // previousWindow = N sessions before that (older)
  const currentWindow = applicableSessions.slice(0, windowSize);
  const previousWindow = applicableSessions.slice(windowSize, windowSize * 2);

  if (currentWindow.length === 0) return 0;

  const currentViolationRate =
    currentWindow.filter((s) => s.violated).length / currentWindow.length;

  if (previousWindow.length === 0) {
    // No previous window — compare to overall rate
    const overallRate = applicableSessions.filter((s) => s.violated).length / applicableSessions.length;
    if (currentViolationRate < overallRate - 0.1) return 1;  // improving
    if (currentViolationRate > overallRate + 0.1) return -1; // worsening
    return 0;
  }

  const previousViolationRate =
    previousWindow.filter((s) => s.violated).length / previousWindow.length;

  const delta = previousViolationRate - currentViolationRate;

  if (delta > 0.1) return 1;   // violations decreasing → improving
  if (delta < -0.1) return -1; // violations increasing → worsening
  return 0;                     // stable
}

/**
 * Builds a human-readable explanation for the compliance result.
 */
// eslint-disable-next-line @typescript-eslint/max-params -- Reason: explanation builder requires all context parameters - refactoring would break API
function buildExplanation(
  principleId: string,
  applicableOpportunityCount: number,
  observedViolationCount: number,
  complianceRate: number,
  violationTrend: number,
  applicableSessions: { violated: boolean; reason: string }[]
): string {
  const trendStr =
    violationTrend === 1
      ? '↑ improving'
      : violationTrend === -1
      ? '↓ worsening'
      : '→ stable';

  if (applicableOpportunityCount === 0) {
    return `${principleId}: No applicable opportunities in provided sessions — compliance cannot be assessed.`;
  }

  const violationExamples = applicableSessions
    .filter((s) => s.violated)
    .slice(0, 2)
    .map((s) => `  • ${s.reason}`)
    .join('\n');

  return [
    `${principleId}: ${applicableOpportunityCount} applicable opportunities, ${observedViolationCount} violations.`,
    `Compliance rate: ${(complianceRate * 100).toFixed(1)}%. Trend: ${trendStr}.`,
    violationExamples ? `Sample violation signals:\n${violationExamples}` : 'No violations detected in recent sessions.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Batch Update Helpers
// ---------------------------------------------------------------------------

/**
 * Computes compliance results for all T-01 through T-09 principles
 * across the provided sessions.
 *
 * Sessions are assumed to be ordered most-recent-first.
 */
export function computeAllCompliance(
  sessions: SessionEvents[],
  options: { trendWindowSize?: number } = {}
): ComplianceResult[] {
  const results: ComplianceResult[] = [];
  for (const id of ['T-01', 'T-02', 'T-03', 'T-04', 'T-05', 'T-06', 'T-07', 'T-08', 'T-09']) {
    results.push(computeCompliance(id, sessions, options));
  }
  return results;
}

/**
 * Converts raw EventLogEntry[] from event-types.ts into SessionEvents.
 *
 * Groups events by sessionId and maps to the SessionEvents interface.
 * Events with no sessionId are grouped under sessionId = 'unknown'.
 */
export function groupEventsIntoSessions(events: RawEventEntry[]): Map<string, SessionEvents> {
  const sessionMap = new Map<string, SessionEvents>();

  for (const event of events) {
    const sessionId = event.sessionId ?? 'unknown';

    if (!sessionMap.has(sessionId)) {
      sessionMap.set(sessionId, {
        sessionId,
        toolCalls: [],
        painSignals: [],
        gateBlocks: [],
        userCorrections: [],
        planApprovals: [],
      });
    }

    const session = sessionMap.get(sessionId)!;

    switch (event.type) {
      case 'tool_call':
        if (event.data.toolName) {
          session.toolCalls.push({
            toolName: event.data.toolName as string,
            filePath: event.data.filePath as string | undefined,
            outcome: (event.data.error ? 'failure' : 'success') as 'success' | 'failure' | 'blocked',
            errorType: event.data.errorType as string | undefined,
            errorMessage: event.data.error as string | undefined,
          });
        }
        break;
      case 'pain_signal':
        session.painSignals.push({
          source: (event.data.source as string) ?? 'unknown',
          score: (event.data.score as number) ?? 0,
          severity: event.data.severity as 'mild' | 'moderate' | 'severe' | undefined,
          reason: event.data.reason as string | undefined,
        });
        break;
      case 'gate_block':
        session.gateBlocks.push({
          toolName: (event.data.toolName as string) ?? 'unknown',
          filePath: event.data.filePath as string | undefined,
          reason: (event.data.reason as string) ?? '',
        });
        break;
      case 'empathy_rollback':
        // User corrections are flagged via empathy rollback
        session.userCorrections.push({
          correctionCue: event.data.reason as string | undefined,
        });
        break;
      case 'plan_approval':
        session.planApprovals.push({
          toolName: (event.data.toolName as string) ?? 'unknown',
          filePath: event.data.filePath as string | undefined,
        });
        break;
    }
  }

  return sessionMap;
}

/**
 * Raw event entry from the events.jsonl log.
 * Compatible with EventLogEntry from event-types.ts.
 */
export interface RawEventEntry {
  ts: string;
  type: string;
  sessionId?: string;
  data: Record<string, unknown>;
}
