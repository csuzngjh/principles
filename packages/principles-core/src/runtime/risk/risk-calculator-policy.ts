/**
 * Risk Calculator Policy — pure logic migrated from openclaw-plugin.
 *
 * No I/O, no fs, no network. Only the pure line-change estimation function
 * that was previously mixed with I/O functions in plugin's risk-calculator.ts.
 * The I/O functions (assessRiskLevel, getTargetFileLineCount,
 * calculatePercentageThreshold) were dead code and removed during Stage 2/3.
 */

import type { ToolSemanticRegistry } from '../internalization/tool-semantic-registry.js';

export interface FileModification {
  toolName: string;
  params: Record<string, unknown>;
}

/** A deletion-sized change: real but of unknown size (legacy delete_file rule). */
const DELETION_LINE_ESTIMATE = 50;

/**
 * Read a string-typed param safely, returning '' for non-string values.
 * Replaces `as string` assertions that could throw at runtime if upstream
 * passed a non-string (e.g. number, object). See rc-2-no-as-bypass.
 */
function readStringParam(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function countLines(content: string): number {
  return content.split('\n').length;
}

function countPatchLines(patch: string): number {
  // Rough estimate for patch files.
  // Exclude unified-diff file headers (--- / +++) which are not actual changes.
  return patch
    .split('\n')
    .filter((l: string) => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'))
    .length;
}

/**
 * Estimate the number of lines changed by a tool call.
 *
 * The write family is decided by the ONE tool semantic authority
 * (`ToolSemanticRegistry`), not by a second raw-name list: any host tool the
 * declarations map to `write` is estimated automatically, including aliases
 * added later. Which payload shape the call carries is read from the params,
 * because the canonical kind deliberately does not encode payload variants.
 *
 * A write-family call with no recognizable payload (a deletion, or a malformed
 * write) is treated as a deletion-sized change — its size is unknown but
 * significant. Non-write families return 0.
 */
export function estimateLineChanges(
  modification: FileModification,
  registry: ToolSemanticRegistry,
): number {
  const { toolName, params } = modification;

  if (registry.resolve(toolName) !== 'write') return 0;

  if (Object.hasOwn(params, 'content')) {
    return countLines(readStringParam(params.content));
  }

  if (Object.hasOwn(params, 'new_string') || Object.hasOwn(params, 'newText')) {
    return countLines(readStringParam(params.new_string) || readStringParam(params.newText));
  }

  if (Object.hasOwn(params, 'patch')) {
    return countPatchLines(readStringParam(params.patch));
  }

  return DELETION_LINE_ESTIMATE;
}
