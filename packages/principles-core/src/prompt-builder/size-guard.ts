/**
 * Size guard — truncates prompt injection to stay within budget.
 *
 * Architecture: this function receives the three prompt components separately
 * (matching how the plugin calls it — in-place modification of prependSystemContext,
 * prependContext, appendSystemContext). It returns an object with the stripped
 * components so the caller can reassemble.
 *
 * Priority stripping order (diagnosticianMode):
 *   1. project_context (always stripped first when over limit)
 *   1.5. intent_block (PRI-467: always stripped, sits between project_context and thinking_os)
 *   2. thinking_os (only in diag mode)
 *   3. evolution_principles (only in diag mode)
 *   4. reflection_log (only in diag mode)
 *   5. reason: line truncation (only in diag mode, when reason: line > 129 chars)
 *   6. fallback: only replaces appendSystemContext — prependSystemContext and
 *      prependContext are ALWAYS preserved (matching plugin behavior)
 *
 * Phase: PRI-75 Prompt Injection SDK Migration Phase 1
 */

import type { SizeGuardOptions, TruncateResult } from './types.js';

const DEFAULT_BUDGET = 9000;

/**
 * Truncates the combined prompt injection to fit within budget.
 *
 * Receives the three prompt components separately (prependSystemContext,
 * prependContext, appendSystemContext) to allow exact-content replacement and
 * proper fallback behavior (preserving prependSystemContext + prependContext).
 *
 * @param prependSystemContext - Fixed system identity block
 * @param prependContext - Dynamic directives block
 * @param appendSystemContext - Principles + Thinking OS + reflection_log + project_context
 * @param options - Size guard options (diagnosticianMode, blocks with exact content for replacement)
 * @returns Stripped prompt components + truncation log
 */
// eslint-disable-next-line @typescript-eslint/max-params
export function truncateInjectionToBudget(
  prependSystemContext: string,
  prependContext: string,
  appendSystemContext: string,
  options?: SizeGuardOptions,
): TruncateResult {
  const inDiagMode = options?.diagnosticianMode ?? false;
  const blocks = options?.blocks;
  const budget = DEFAULT_BUDGET;

  let ps = prependSystemContext;
  let pc = prependContext;
  let ac = appendSystemContext;
  const truncationLog: string[] = [];

  let totalSize = ps.length + pc.length + ac.length;

  if (totalSize <= budget) {
    return { prependSystemContext: ps, prependContext: pc, appendSystemContext: ac, truncated: false, truncationLog };
  }

  // Step 1 — strip project_context (largest, lowest priority)
  // Uses exact content replacement when block content is provided (matching plugin behavior)
  if (blocks?.projectContextContent && ac.includes('<project_context>')) {
    const marker = `<project_context>\n${blocks.projectContextContent}\n</project_context>`;
    if (ac.includes(marker)) {
      ac = ac.replace(marker, '<project_context>\n[stripped: project_context]\n</project_context>');
      truncationLog.push('project_context');
      totalSize = ps.length + pc.length + ac.length;
    }
  } else if (ac.includes('<project_context>')) {
    // Fallback: use regex when exact content not provided
    ac = ac.replace(/<project_context>[\s\S]*?<\/project_context>/, '<project_context>\n[stripped: project_context]\n</project_context>');
    truncationLog.push('project_context');
    totalSize = ps.length + pc.length + ac.length;
  }

  // Exit early if within budget
  if (totalSize <= budget) {
    return { prependSystemContext: ps, prependContext: pc, appendSystemContext: ac, truncated: true, truncationLog };
  }

  // Step 1.5 — strip intent_block (PRI-467: always stripped, not gated on diag mode)
  // INTENT block is injected in the regular prompt hook path, so it must be
  // strippable without diagnosticianMode. The block spans <intent_anchor>…
  // </intent_friction> (three sub-tags). Exact-match replacement when content is
  // provided; regex fallback from <intent_anchor> to </intent_friction>.
  if (blocks?.intentBlockContent && ac.includes('<intent_anchor>')) {
    if (ac.includes(blocks.intentBlockContent)) {
      ac = ac.replace(blocks.intentBlockContent, '[stripped: intent_block]');
      truncationLog.push('intent_block');
      totalSize = ps.length + pc.length + ac.length;
    }
  } else if (ac.includes('<intent_anchor>')) {
    ac = ac.replace(/<intent_anchor>[\s\S]*?<\/intent_friction>/, '[stripped: intent_block]');
    truncationLog.push('intent_block');
    totalSize = ps.length + pc.length + ac.length;
  }

  if (totalSize <= budget) {
    return { prependSystemContext: ps, prependContext: pc, appendSystemContext: ac, truncated: true, truncationLog };
  }

  // Steps 2-4: only in diagnostician priority mode
  if (inDiagMode) {
    // Step 2 — strip thinking_os
    if (blocks?.thinkingOsContent && ac.includes('<thinking_os>')) {
      const marker = `<thinking_os>\n${blocks.thinkingOsContent}\n</thinking_os>`;
      if (ac.includes(marker)) {
        ac = ac.replace(marker, '<thinking_os>\n[stripped: thinking_os]\n</thinking_os>');
        truncationLog.push('thinking_os');
        totalSize = ps.length + pc.length + ac.length;
      }
    } else if (ac.includes('<thinking_os>')) {
      ac = ac.replace(/<thinking_os>[\s\S]*?<\/thinking_os>/, '<thinking_os>\n[stripped: thinking_os]\n</thinking_os>');
      truncationLog.push('thinking_os');
      totalSize = ps.length + pc.length + ac.length;
    }

    if (totalSize <= budget) {
      return { prependSystemContext: ps, prependContext: pc, appendSystemContext: ac, truncated: true, truncationLog };
    }

    // Step 3 — strip evolution_principles
    if (blocks?.evolutionPrinciplesContent && ac.includes('<evolution_principles>')) {
      const marker = `<evolution_principles>\n${blocks.evolutionPrinciplesContent}\n</evolution_principles>`;
      if (ac.includes(marker)) {
        ac = ac.replace(marker, '<evolution_principles>\n[stripped: evolution_principles]\n</evolution_principles>');
        truncationLog.push('evolution_principles');
        totalSize = ps.length + pc.length + ac.length;
      }
    } else if (ac.includes('<evolution_principles>')) {
      ac = ac.replace(/<evolution_principles>[\s\S]*?<\/evolution_principles>/, '<evolution_principles>\n[stripped: evolution_principles]\n</evolution_principles>');
      truncationLog.push('evolution_principles');
      totalSize = ps.length + pc.length + ac.length;
    }

    if (totalSize <= budget) {
      return { prependSystemContext: ps, prependContext: pc, appendSystemContext: ac, truncated: true, truncationLog };
    }

    // Step 4 — strip reflection_log
    if (ac.includes('<reflection_log>')) {
      ac = ac.replace(/<reflection_log>[\s\S]*?<\/reflection_log>/, '<reflection_log>\n[stripped: reflection_log]\n</reflection_log>');
      truncationLog.push('reflection_log');
      totalSize = ps.length + pc.length + ac.length;
    }

    if (totalSize <= budget) {
      return { prependSystemContext: ps, prependContext: pc, appendSystemContext: ac, truncated: true, truncationLog };
    }

    // Step 5 — truncate reason: lines to 129 chars (only in diag mode)
    if (totalSize > budget) {
      const lines = pc.split('\n');
      const truncatedLines = lines.map((line) => {
        if (line.startsWith('reason: ') && line.length > 129) {
          return line.slice(0, 129) + '...[truncated]';
        }
        return line;
      });
      const newPc = truncatedLines.join('\n');
      if (newPc !== pc) {
        pc = newPc;
        truncationLog.push('diagnostician_reason');
        totalSize = ps.length + pc.length + ac.length;
      }
    }
  }

  // Step 6 — FAIL-CLOSED: if still over budget, replace only appendSystemContext.
  // prependSystemContext and prependContext are ALWAYS preserved (matching plugin behavior).
  if (totalSize > budget) {
    const fallbackContext = `
## 【CONTEXT SECTIONS】

[WARNING: Context sections stripped due to prompt size constraints.
This is a diagnostician-priority session — full context remains in the runtime state store.]
`.trim();
    ac = fallbackContext;
    truncationLog.push('fallback');
    // ps and pc are NOT modified — they are preserved
  }

  return { prependSystemContext: ps, prependContext: pc, appendSystemContext: ac, truncated: true, truncationLog };
}
