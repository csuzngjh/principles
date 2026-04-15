/**
 * PrincipleCompiler — Orchestrator (Task 5)
 *
 * Orchestrates the full compilation flow:
 *   ReflectionContextCollector.collect() → extract patterns → generateFromTemplate()
 *   → validateGeneratedCode() → registerCompiledRule()
 *
 * DESIGN DECISIONS:
 * - extractPatterns infers toolName from pain event reasons and session tool calls
 * - Groups by toolName into PainPattern objects
 * - If no patterns can be extracted, returns a 'no patterns' failure
 */

import { ReflectionContextCollector } from '../reflection/reflection-context.js';
import { validateGeneratedCode } from './code-validator.js';
import { generateFromTemplate, type PainPattern } from './template-generator.js';
import { registerCompiledRule } from './ledger-registrar.js';
import type { TrajectoryDatabase } from '../trajectory.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompileResult {
  success: boolean;
  principleId: string;
  ruleId?: string;
  implementationId?: string;
  code?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tool names to look for when scanning text for tool references */
const KNOWN_TOOLS = ['bash', 'write', 'edit', 'read', 'grep', 'glob', 'mcp'] as const;

/** Regex to extract file paths from reason text */
const PATH_REGEX = /(?:\/[\w.-]+){2,}/g;

// ---------------------------------------------------------------------------
// Pattern Extraction
// ---------------------------------------------------------------------------

/**
 * Extract PainPatterns from a ReflectionContext.
 *
 * Strategy:
 * 1. Scan pain event reasons for known tool names
 * 2. Extract file paths from reason text as pathRegex candidates
 * 3. Cross-reference with sessionSnapshot toolCalls for failed tool calls
 * 4. Group by toolName into PainPattern objects
 */
function extractPatterns(context: {
  painEvents: Array<{ reason: string | null; source: string }>;
  sessionSnapshot: {
    toolCalls: Array<{
      toolName: string;
      outcome: string;
      filePath: string | null;
      errorType: string | null;
    }>;
  } | null;
}): PainPattern[] {
  const toolNameMap = new Map<string, PainPattern>();

  // 1. Extract from pain event reasons
  for (const pe of context.painEvents) {
    const text = pe.reason ?? pe.source ?? '';
    const toolName = inferToolName(text);
    if (!toolName) continue;

    const pathRegex = extractPathRegex(text);

    if (!toolNameMap.has(toolName)) {
      toolNameMap.set(toolName, { toolName });
    }

    const pattern = toolNameMap.get(toolName)!;
    if (pathRegex && !pattern.pathRegex) {
      pattern.pathRegex = pathRegex;
    }
  }

  // 2. Extract from session snapshot tool calls (failed ones)
  if (context.sessionSnapshot?.toolCalls) {
    for (const tc of context.sessionSnapshot.toolCalls) {
      // Focus on failed/blocked tool calls as they indicate pain
      if (tc.outcome !== 'failure' && tc.outcome !== 'blocked') continue;

      const toolName = tc.toolName;
      if (!toolNameMap.has(toolName)) {
        const pattern: PainPattern = { toolName };
        if (tc.errorType) {
          pattern.errorType = tc.errorType;
        }
        if (tc.filePath) {
          pattern.pathRegex = escapeRegex(tc.filePath);
        }
        toolNameMap.set(toolName, pattern);
      } else {
        const existing = toolNameMap.get(toolName)!;
        if (tc.errorType && !existing.errorType) {
          existing.errorType = tc.errorType;
        }
        if (tc.filePath && !existing.pathRegex) {
          existing.pathRegex = escapeRegex(tc.filePath);
        }
      }
    }
  }

  return Array.from(toolNameMap.values());
}

/**
 * Infer tool name from text by checking for known tool names.
 * Returns the first matching known tool name, or null if none found.
 */
function inferToolName(text: string): string | null {
  const lower = text.toLowerCase();
  for (const tool of KNOWN_TOOLS) {
    // Match as a standalone word to avoid false positives
    // e.g., "bash" in "bash" or "bash command" but not in "ambush"
    const regex = new RegExp(`\\b${tool}\\b`);
    if (regex.test(lower)) {
      return tool;
    }
  }
  return null;
}

/**
 * Extract a file path from text and return it as an escaped regex pattern.
 * Returns the first path found, or null.
 */
function extractPathRegex(text: string): string | null {
  PATH_REGEX.lastIndex = 0;
  const match = PATH_REGEX.exec(text);
  if (match) {
    return escapeRegex(match[0]);
  }
  return null;
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// PrincipleCompiler
// ---------------------------------------------------------------------------

export class PrincipleCompiler {
  private readonly stateDir: string;
  private readonly collector: ReflectionContextCollector;

  constructor(stateDir: string, trajectory: TrajectoryDatabase) {
    this.stateDir = stateDir;
    this.collector = new ReflectionContextCollector(stateDir, trajectory);
  }

  /**
   * Compile a single principle into an auto-generated rule.
   *
   * Flow:
   * 1. Collect reflection context
   * 2. Extract pain patterns
   * 3. Generate code from template
   * 4. Validate generated code
   * 5. Register in ledger
   */
  compileOne(principleId: string): CompileResult {
    // Step 1: Collect context
    const context = this.collector.collect(principleId);
    if (!context) {
      return { success: false, principleId, reason: 'no context' };
    }

    // Step 2: Extract patterns
    const patterns = extractPatterns({
      painEvents: context.painEvents,
      sessionSnapshot: context.sessionSnapshot,
    });

    // Step 3: Generate code
    const coversCondition = context.principle.triggerPattern || context.principle.text;
    const code = generateFromTemplate(principleId, coversCondition, patterns);
    if (!code) {
      return { success: false, principleId, reason: 'no patterns' };
    }

    // Step 4: Validate
    const validation = validateGeneratedCode(code);
    if (!validation.valid) {
      return {
        success: false,
        principleId,
        reason: `validation failed: ${validation.errors.join('; ')}`,
      };
    }

    // Step 5: Register
    const registration = registerCompiledRule(this.stateDir, {
      principleId,
      codeContent: code,
      coversCondition,
    });

    return {
      success: true,
      principleId,
      ruleId: registration.ruleId,
      implementationId: registration.implementationId,
      code,
    };
  }

  /**
   * Compile all eligible principles (those with derivedFromPainIds).
   */
  compileAll(): CompileResult[] {
    const contexts = this.collector.collectBatch();
    return contexts.map((ctx) => this.compileOne(ctx.principle.id));
  }
}
