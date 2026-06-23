/**
 * PrincipleCompiler — Orchestrator (Task 5)
 *
 * Orchestrates the full compilation flow:
 *   ReflectionContextCollector.collect() → extract patterns → generateFromTemplate()
 *   → validateGeneratedCode() → [replay validation] → registerCompiledRule()
 *
 * DESIGN DECISIONS:
 * - extractPatterns infers toolName from pain event reasons and session tool calls
 * - Groups by toolName into PainPattern objects
 * - If no patterns can be extracted, returns a 'no patterns' failure
 * - PRI-115: Replay validation gate runs after code validation, before registration
 */

import { ReflectionContextCollector } from '../reflection/reflection-context.js';
import { validateGeneratedCode } from './code-validator.js';
import { generateFromTemplate, type PainPattern } from './template-generator.js';
import { registerCompiledRule } from './ledger-registrar.js';
import { createImplementationAssetDir } from '../code-implementation-storage.js';
import type { TrajectoryDatabase } from '../trajectory.js';
import type { CompileResult } from '@principles/core/runtime-v2';
import { loadRuleImplementationModule } from '../rule-implementation-runtime.js';
import { createGoldenTraceFixture, type GoldenTraceCase } from '@principles/core/runtime-v2';
import { replayGoldenTrace, type ReplayEvaluateFn } from '@principles/core/runtime-v2';

// Re-export CompileResult from core
export type { CompileResult } from '@principles/core/runtime-v2';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tool names to look for when scanning text for tool references */
const KNOWN_TOOLS = ['bash', 'write', 'edit', 'read', 'grep', 'glob', 'mcp'] as const;

/** Regex to extract file paths from reason text */
const PATH_REGEX = /(?:\/[\w.-]+){2,}/;

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
 *
 * Uses negative lookbehind to avoid matching natural-language uses:
 * - "please read the error" → read is a verb, not a tool reference
 * - "could write to file" → write is a verb, not a tool reference
 * Tool references in pain events typically appear near words like
 * "tool", "call", "command", "failed", "via", "using", etc.
 */
function inferToolName(text: string): string | null {
  const lower = text.toLowerCase();
  for (const tool of KNOWN_TOOLS) {
    // Match as a standalone word but exclude common natural-language patterns
    // e.g., "bash" in "bash" or "bash command" but not in "ambush"
    // and not in "please read" or "could write" where it's a verb
    const regex = new RegExp(`(?<!please |could |should |would )\\b${tool}\\b`);
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
   * 4.5. Replay validation against GoldenTrace (PRI-115)
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

    // Step 4.5: Replay validation against GoldenTrace (PRI-115)
    const replayCases = this.buildGoldenTraceCases(patterns, context);
    if (replayCases.length > 0) {
      let moduleExports: { evaluate?: unknown };
      try {
        moduleExports = loadRuleImplementationModule(code, `replay-${principleId}.js`);
      } catch (err) {
        return {
          success: false,
          principleId,
          reason: `module_load_error: ${(err as Error).message}`,
          code,
          degraded: true,
        };
      }

      if (typeof moduleExports.evaluate !== 'function') {
        return { success: false, principleId, reason: 'replay: no evaluate export', degraded: true };
      }

      try {
        const evaluateFn = moduleExports.evaluate as ReplayEvaluateFn;
        const replayResult = replayGoldenTrace(evaluateFn, replayCases);
        if (!replayResult.passed) {
          return {
            success: false,
            principleId,
            reason: 'replay_validation_failed',
            code,
            replayResult,
            degraded: true,
          };
        }
      } catch (err) {
        return {
          success: false,
          principleId,
          reason: `replay_error: ${(err as Error).message}`,
          code,
          degraded: true,
        };
      }
    }
    // Step 5: Register
    const registration = registerCompiledRule(this.stateDir, {
      principleId,
      codeContent: code,
      coversCondition,
    });

    // Step 6: Persist code to disk so RuleHost can load it
    createImplementationAssetDir(this.stateDir, registration.implementationId, '1', {
      entrySource: code,
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
   * Build GoldenTrace test cases from extracted pain patterns.
   *
   * Generates synthetic negative/positive parameter pairs based on whether
   * the pattern targets commands (commandRegex) or paths (pathRegex).
   * Returns an empty array when no patterns are available.
   */
  private buildGoldenTraceCases(
    patterns: PainPattern[],
    _context: { painEvents: Array<{ reason: string | null; source: string }> },
  ): GoldenTraceCase[] {
    if (patterns.length === 0) return [];

    const pattern = patterns[0];
    if (!pattern) return [];
    // Skip replay when the pattern has no regex qualifier -- the generated template
    // blocks ALL calls to the tool, making it impossible to construct a passing
    // positive case. Replay is only meaningful when the template is selective.
    // Also skip contentRegex-only patterns: synthetic content params are not meaningful.
    if (!pattern.commandRegex && !pattern.pathRegex) return [];
    const negativeParams: Record<string, unknown> = {};
    if (pattern.commandRegex) negativeParams.command = 'rm -rf /';
    else negativeParams.path = '/etc/passwd';

    const positiveParams: Record<string, unknown> = {};
    if (pattern.commandRegex) positiveParams.command = 'echo hello';
    else positiveParams.path = '/tmp/safe.txt';

    const fixture = createGoldenTraceFixture({
      toolName: pattern.toolName,
      negativeParams,
      positiveParams,
      expectedDecision: 'block',
    });

    return fixture.cases;
  }

  /**
   * Compile all eligible principles (those with derivedFromPainIds).
   */
  compileAll(): CompileResult[] {
    const contexts = this.collector.collectBatch();
    return contexts.map((ctx) => {
      try {
        return this.compileOne(ctx.principle.id);
      } catch (e) {
        // Log for operator visibility — catch-return is intentional for batch容错
        console.warn(`[PrincipleCompiler] compileAll failed for ${ctx.principle.id}: ${(e as Error).message}`);
        return { success: false, principleId: ctx.principle.id, reason: `unhandled: ${(e as Error).message}` };
      }
    });
  }
}
