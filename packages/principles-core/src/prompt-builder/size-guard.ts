/**
 * Size guard — truncates prompt injection parts to stay within budget.
 *
 * Priority stripping order (when diagnosticianMode is true):
 *   1. project_context (always stripped in diag mode when over limit)
 *   2. thinking_os (only in diag mode)
 *   3. evolution_principles (only in diag mode)
 *   4. reflection_log (only in diag mode)
 *   5. fallback (if still over limit — keeps only prependContext + prependSystemContext)
 *
 * Phase: PRI-75 Prompt Injection SDK Migration Phase 1
 */

import type { PromptInjectionPart, SizeGuardOptions } from './types.js';

const DEFAULT_BUDGET = 9000;

/**
 * Truncates a combined string of injection parts to fit within budget.
 * When over budget:
 *   - In diagnostician mode: aggressively strips low-priority blocks
 *   - In normal mode: strips project_context only
 *   - If still over: falls back to minimal context
 *
 * @param parts - Array of injection parts with id and content
 * @param budget - Maximum allowed total size (default 9000)
 * @param options - Size guard options
 * @returns Combined string truncated to budget
 */
export function truncateInjectionToBudget(
  parts: PromptInjectionPart[],
  budget: number = DEFAULT_BUDGET,
  options?: SizeGuardOptions,
): string {
  const inDiagMode = options?.diagnosticianMode ?? false;

  // Join parts into single string (using same format as plugin: double separator)
  let combined = parts.map((p) => p.content).join('\n\n---\n\n');
  let totalSize = combined.length;

  if (totalSize <= budget) {
    return combined;
  }

  // Over budget — strip in priority order
  const truncationLog: string[] = [];

  // Step 1: strip project_context (lowest priority, largest)
  if (combined.includes('<project_context>')) {
    combined = combined.replace(/<project_context>[\s\S]*?<\/project_context>/, '<project_context>\n[stripped: project_context]\n</project_context>');
    truncationLog.push('project_context');
    totalSize = combined.length;
  }

  // Steps 2-4: only in diagnostician priority mode
  if (inDiagMode && totalSize > budget) {
    if (combined.includes('<thinking_os>')) {
      combined = combined.replace(/<thinking_os>[\s\S]*?<\/thinking_os>/, '<thinking_os>\n[stripped: thinking_os]\n</thinking_os>');
      truncationLog.push('thinking_os');
      totalSize = combined.length;
    }

    if (combined.includes('<evolution_principles>')) {
      combined = combined.replace(/<evolution_principles>[\s\S]*?<\/evolution_principles>/, '<evolution_principles>\n[stripped: evolution_principles]\n</evolution_principles>');
      truncationLog.push('evolution_principles');
      totalSize = combined.length;
    }

    if (combined.includes('<reflection_log>')) {
      combined = combined.replace(/<reflection_log>[\s\S]*?<\/reflection_log>/, '<reflection_log>\n[stripped: reflection_log]\n</reflection_log>');
      truncationLog.push('reflection_log');
      totalSize = combined.length;
    }
  }

  // Step 5: if still over budget, truncate each line starting with "reason: " to 129 chars
  if (totalSize > budget) {
    combined = combined
      .split('\n')
      .map((line) => {
        if (line.startsWith('reason: ') && line.length > 129) {
          return line.slice(0, 129) + '...[truncated]';
        }
        return line;
      })
      .join('\n');
    truncationLog.push('diagnostician_reason');
    totalSize = combined.length;
  }

  // Step 6: FAIL-CLOSED — if still over budget, return minimal fallback
  if (totalSize > budget) {
    const fallback = `
## 【CONTEXT SECTIONS】

[WARNING: Context sections stripped due to prompt size constraints.
This is a diagnostician-priority session — full context remains in the runtime state store.]
`.trim();
    combined = fallback;
  }

  return combined;
}